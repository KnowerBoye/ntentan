// ─────────────────────────────────────────────
//  features/assistant/ghananlp.service.ts
//
//  The GhanaNLP "Twi layer" for the live assistant. GhanaNLP's models handle
//  Twi (Akan) better than the Live API's native audio, so for Twi sessions we
//  route specific steps through GhanaNLP instead.
//
//  Ported from the REST assistant (api/ submodule's voice.service.ts). The live
//  Twi path runs the full pipeline through here — because Gemini does not
//  construct good Twi, the model only ever sees/produces English:
//
//    Twi speech ──twiASR──▶ Twi text ──twiToEnglish──▶ English
//        ──▶ Gemini (reasons + tools in English) ──▶ English reply
//        ──englishToTwi──▶ Twi text ──twiTTS──▶ Twi speech
//
//  Auth is an Azure API-Management subscription key sent as
//  `Ocp-Apim-Subscription-Key` (env GHNLP_API_KEY).
// ─────────────────────────────────────────────
import { GHNLP_API_BASE, GHNLP_TTS_VOICE } from "@config/live";
import { ExternalServiceError } from "@/lib/errors";

function apiKey(): string {
  const key = process.env.GHNLP_API_KEY;
  if (!key) {
    throw new ExternalServiceError("GhanaNLP", "GHNLP_API_KEY is not configured");
  }
  return key;
}

function jsonHeaders(): Headers {
  const headers = new Headers();
  headers.set("Ocp-Apim-Subscription-Key", apiKey());
  headers.set("Content-Type", "application/json");
  return headers;
}

/**
 * Synthesize Twi speech from Twi text. Returns a WAV file as a Buffer.
 * This is what gives the live assistant its Twi *audio output*.
 */
export async function twiTTS(text: string): Promise<Buffer> {
  const res = await fetch(`${GHNLP_API_BASE}/tts/v1/synthesize`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ text, language: "tw", voice: GHNLP_TTS_VOICE }),
  });

  if (!res.ok) {
    throw new ExternalServiceError("GhanaNLP", `TTS failed (${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Transcribe Twi speech → Twi text. Expects a self-contained audio file
 * (WAV/PCM16 mono 16kHz is what the live clients produce; see lib/wav.ts).
 */
export async function twiASR(audio: Buffer): Promise<string> {
  const headers = new Headers();
  headers.set("Ocp-Apim-Subscription-Key", apiKey());
  headers.set("Content-Type", "audio/wav");

  const res = await fetch(`${GHNLP_API_BASE}/asr/v1/transcribe?language=tw`, {
    method: "POST",
    headers,
    body: new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
  });

  if (!res.ok) {
    throw new ExternalServiceError("GhanaNLP", `ASR failed (${res.status})`);
  }

  // The ASR endpoint returns the transcript as a JSON string.
  return (await res.json()) as string;
}

/** Translate Twi text → English. */
export async function twiToEnglish(text: string): Promise<string> {
  return translate(text, "tw-en");
}

/** Translate English text → Twi. */
export async function englishToTwi(text: string): Promise<string> {
  return translate(text, "en-tw");
}

/**
 * Translate English → Twi while preserving drug names verbatim.
 *
 * GhanaNLP's MT mangles drug names unpredictably — "paracetamol" → "paracetable",
 * and worse, "amoxicillin" → "anom asɛm" — which is dangerous for a medical
 * assistant reading medication names aloud. We wrap each known drug name in
 * `[[ ]]` before translating. Empirically the *brackets* reliably survive the
 * MT (even when the inner word is still mangled), so we then replace each
 * surviving bracket span, in order, with the canonical drug name — overwriting
 * any mangling. Because the output is sentence-chunked, a sentence almost always
 * has 0–1 drugs, making the span↔name mapping unambiguous. If bracket counts
 * don't line up (a bracket was dropped/merged), we fall back to stripping them.
 * Twi medical replies don't otherwise contain square brackets, so this is safe.
 */
export async function englishToTwiPreserving(
  text: string,
  protectedTerms: string[] = []
): Promise<string> {
  const { wrapped, order } = wrapTerms(text, protectedTerms);
  const translated = await englishToTwi(wrapped);
  return order.length ? restoreTerms(translated, order) : translated;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches a bracket span: one-or-more "[" … one-or-more "]" (the MT often
// mangles "[[name]]" into "[name]]" etc., so the counts are loose).
const BRACKET_SPAN = /\[+\s*[^[\]]*?\s*\]+/g;

/**
 * Wrap each whole-word occurrence of a protected term in [[ ]] (one pass),
 * returning the wrapped text and the canonical names in order of appearance.
 */
function wrapTerms(text: string, terms: string[]): { wrapped: string; order: string[] } {
  const uniq = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length // longest first so overlaps wrap the bigger name
  );
  if (!uniq.length) return { wrapped: text, order: [] };

  const re = new RegExp(`\\b(${uniq.map(escapeRegExp).join("|")})\\b`, "gi");
  const order: string[] = [];
  const wrapped = text.replace(re, (_m, g1: string) => {
    const canon = uniq.find((u) => u.toLowerCase() === g1.toLowerCase()) ?? g1;
    order.push(canon);
    return `[[${canon}]]`;
  });
  return { wrapped, order };
}

/** Replace surviving bracket spans with the canonical names (by position). */
function restoreTerms(translated: string, order: string[]): string {
  const spans = translated.match(BRACKET_SPAN) ?? [];
  if (spans.length === order.length) {
    let i = 0;
    return translated.replace(BRACKET_SPAN, () => order[i++]).replace(/\s{2,}/g, " ").trim();
  }
  // Counts don't line up — strip brackets and keep whatever the MT produced.
  return stripBrackets(translated);
}

/** Remove square-bracket artifacts, tidy spacing. */
function stripBrackets(s: string): string {
  return s.replace(/[[\]]/g, "").replace(/\s{2,}/g, " ").trim();
}

async function translate(text: string, lang: "tw-en" | "en-tw"): Promise<string> {
  const res = await fetch(`${GHNLP_API_BASE}/v1/translate`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ in: text, lang }),
  });

  if (!res.ok) {
    throw new ExternalServiceError("GhanaNLP", `Translation failed (${lang}, ${res.status})`);
  }

  // The translate endpoint returns the translated string as a JSON value.
  return (await res.json()) as string;
}
