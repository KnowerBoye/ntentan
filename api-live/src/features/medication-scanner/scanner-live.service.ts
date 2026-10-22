// ─────────────────────────────────────────────
//  features/medication-scanner/scanner-live.service.ts
//
//  Medication-label scanner over the Gemini Live API.
//
//  The original scanner (api submodule) hand-rolled real-time with a frame
//  buffer + inference mutex + one generateContent call per flush. Here a single
//  persistent Live session consumes a video stream instead:
//
//    - Frames arrive on "frame" and are pushed to the session's realtime video
//      channel (sendRealtimeInput({ video })) — which, unlike sendClientContent,
//      is optimised for responsiveness and does not permanently grow context.
//    - A tick timer nudges the model to assess the latest frame, gated
//      single-inflight so we never pile up turns.
//
//  STRUCTURED OUTPUT VIA FUNCTION CALLING: the current Live models are
//  audio-output only — they do NOT support a TEXT response modality — so we
//  cannot ask the model to stream JSON text. Instead the model reports each
//  frame's assessment by calling a `report_guidance` tool whose parameters ARE
//  the guidance fields. We read the call args, coerce them to the wire contract,
//  and still validate through the unchanged Zod guard emitMedScannerResponse().
//  On a successful label read we reuse the exact pharmacology extraction +
//  vector match from medscanner.match.ts.
//
//  SPOKEN GUIDANCE: the audio modality is required anyway, so we put it to work.
//  The model is prompted to SPEAK the same short sentence it reports in
//  guidance_text, and the server forwards those native-audio chunks to the
//  client on an "audio" event (identical shape to /assistant-live), then a
//  "speech_end" marker when the turn's audio is complete. This keeps the user
//  informed by voice through every state — searching, positioning, and success —
//  with spoken words that always match the on-screen guidance.
//
//  PLAYBACK DISCIPLINE (client-side): a cue that is already playing is never
//  interrupted — it is allowed to finish. Cues that arrive while one is playing
//  collapse to a single pending slot holding only the LATEST, so when the current
//  cue ends the freshest guidance plays next and any stale cues in between are
//  skipped. The server's job is just to delimit each spoken cue with "speech_end".
// ─────────────────────────────────────────────
import { GoogleGenAI, Modality, Type, LiveServerMessage, Session } from "@google/genai";
import { Socket } from "socket.io";
import dotenv from "dotenv";

import {
  emitMedScannerResponse,
  PositioningInstruction,
  MedScannerStatus,
  MedScannerPositioningResponse,
  MedScannerSuccessResponse,
  PrescriptionMatch,
} from "@/types/medscanner";
import { extractMedicationFields, findBestMatch } from "@features/medication-scanner/medscanner.match";
import { prebakedGuidance } from "@features/medication-scanner/twi-guidance";
import { normalizeLanguage } from "@features/assistant/live-prompt";
import { englishToTwiPreserving, twiTTS } from "@features/assistant/ghananlp.service";
import { LIVE_SCANNER_MODEL, LIVE_VOICE_NAME } from "@config/live";
import { logger } from "@/lib/logger";
import { emitSocketError } from "@/lib/socket-error-handler";
import { ExternalServiceError } from "@/lib/errors";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// One guidance turn roughly every second — the Live API recommends ≤1 FPS for
// video input, and positioning guidance faster than this just churns the UI.
const SCANNER_TICK_MS = 1000;

// Continuous frame streaming: push each incoming frame to the session's realtime
// video channel, but no faster than this (Live API recommends ≤1 FPS for video).
// Streaming frames as they arrive — decoupled from the nudge — keeps a current
// view permanently buffered so the model isn't assessing a frame it hasn't yet
// ingested (the root cause of spurious "no_object").
const VIDEO_SEND_MIN_MS = 900;

// How often to log a rolling performance summary (frames in/out, turn latency).
const PERF_LOG_MS = 10000;

// Safety net: if a turn never completes (no turnComplete), don't wedge the
// single-inflight gate forever — force it open after this long. Kept safely
// above the success speech grace + a long spoken result so it only ever fires on
// a genuinely stuck turn, never mid-sentence.
const TURN_TIMEOUT_MS = 12000;

// Audio parts below this base64 length are empty "stubs" the model emits when a
// turn is interrupted or a cue is a silent repeat — NOT real speech (real speech
// chunks are multiple KB). Forwarding them created silent cues + spurious
// speech_end boundaries on the client that drowned out the real guidance, so we
// drop anything under this threshold.
const MIN_AUDIO_B64 = 64;

// The model answers one nudge as (at least) two turns: a tool-call turn (no
// audio) then a spoken turn. We must not release the single-inflight gate — and
// let the next nudge fire — until the spoken turn has finished, or the next nudge
// interrupts the model mid-sentence (the root cause of the scanner's missing
// audio). Once we send the tool response we arm this grace: if no real speech
// starts within it, the cycle was silent (an unchanged, already-spoken cue) and
// we release. Sized to cover the model's post-tool-response speech latency; real
// speech cancels it immediately.
//
// Positioning / no_object cues are short and want a snappy cadence. SUCCESS cues
// arrive much later (the model takes several seconds to vocalise the result,
// especially on a slow session) and matter most — and the scan is essentially
// done at that point — so they get a far longer window. Measured empirically:
// a 1.5s grace clipped ~half of success cues; a 6s grace caught them all.
const POST_TOOL_SPEECH_GRACE_MS = Number(process.env.SCANNER_SPEECH_GRACE_MS) || 1800;
const SUCCESS_SPEECH_GRACE_MS = Number(process.env.SCANNER_SUCCESS_GRACE_MS) || 5000;

// Twi cues cost more per turn, so ease the cadence (decision: ~1.8s).
const SCANNER_TWI_TICK_MS = 1800;

// After a success, don't re-run the expensive extraction + vector search while
// the same label keeps sitting in frame (mirrors the original debounce).
const SUCCESS_COOLDOWN_MS = 5000;

const NUDGE_TEXT = "Assess the current camera frame and call report_guidance now.";

const INSTRUCTIONS: PositioningInstruction[] = [
  "move_up", "move_down", "move_left", "move_right",
  "rotate_left", "rotate_right", "flip",
  "move_closer", "move_farther", "hold_still", "none",
];

// When the session language is Twi, the model's spoken guidance may be
// machine-translated into Twi (the live fallback when a positioning cue has no
// pre-baked asset). The translator works best on plain English, so we ask the
// model to keep its one-sentence guidance simple and literal. Most Twi scanner
// speech is pre-baked or built server-side, so this mainly steadies that
// fallback; it never changes what the user is told to do.
const SCANNER_TWI_GUIDANCE = `
When you SPEAK and when you write guidance_text, use the simplest possible
English: short, plain words and one clear idea. Avoid idioms, metaphors, and
unusual words. Your words will be translated into Twi, and simple English
translates best.
`;

function buildScannerSystemPrompt(isTwi: boolean): string {
  return `${SCANNER_SYSTEM_PROMPT_BODY}${isTwi ? SCANNER_TWI_GUIDANCE : ""}`;
}

const SCANNER_SYSTEM_PROMPT_BODY = `
You are a medication label reading assistant in a live camera session. You
receive the most recent camera frame and must guide the user to position a
medication so its label can be read.

For EVERY frame you MUST do BOTH of the following, in the same turn:
  1. SPEAK one short, friendly sentence aloud (under ~12 words) telling the user
     what to do right now. This is the user's live voice guide.
  2. Call the report_guidance tool exactly once with the structured assessment.
For no_object and positioning, the spoken sentence and the guidance_text you
report MUST say the same thing, so what the user hears always matches what they
see.

report_guidance statuses:
- status "no_object"   → no medication visible in the frame.
- status "positioning" → medication visible but label not clearly readable;
    set instruction to ONE movement cue and give a short guidance_text.
- status "success"     → label is clearly readable; set instruction to "none",
    and include medication.drug_name plus medication.raw_label_text (every
    readable line of text on the label). Keep guidance_text to a brief
    confirmation (e.g. "I can read the label now."). The tool response for a
    success contains a "say" field holding the user's matched prescription — the
    final result. SPEAK that "say" text aloud, word for word, clearly and warmly;
    it is the answer the user is waiting to hear. Do not add anything else.

Give only ONE instruction at a time. Use instruction "none" for no_object and
success. Keep guidance_text to one short, friendly sentence. Speak naturally and
calmly — you are guiding someone holding a camera.
`;

// The report_guidance tool: its parameters ARE the wire-contract fields.
const GUIDANCE_TOOL = {
  functionDeclarations: [
    {
      name: "report_guidance",
      description: "Report the positioning assessment for the current camera frame. Call once per frame.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          status: {
            type: Type.STRING,
            enum: ["no_object", "positioning", "success"],
            description: "no_object = nothing visible, positioning = visible but unreadable, success = label fully read",
          },
          instruction: {
            type: Type.STRING,
            enum: INSTRUCTIONS,
            description: "One movement cue when positioning; 'none' for no_object/success",
          },
          guidance_text: { type: Type.STRING, description: "One short friendly sentence for the user" },
          medication: {
            type: Type.OBJECT,
            description: "Only when status is 'success'",
            nullable: true,
            properties: {
              drug_name: { type: Type.STRING },
              raw_label_text: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
          },
        },
        required: ["status", "instruction", "guidance_text"],
      },
    },
  ],
};

// Compose the spoken final result from the authoritative prescription match.
// This is what the user hears when a label is successfully read — the medication
// name, strength, and how to take it — phrased the same way the on-screen match
// is (unitsPerDose + dosage). A null match still speaks, so the user is never
// left wondering whether the scan worked.
function buildResultSpeech(match: PrescriptionMatch | null): string {
  if (!match?.medication) {
    return "I read the label, but it doesn't match any prescription on your file.";
  }
  const m = match.medication;
  const bits: string[] = [`This is ${m.name}${m.strength ? ` ${m.strength}` : ""}.`];
  if (m.unitsPerDose && m.dosage) bits.push(`Take ${m.unitsPerDose} ${m.dosage}.`);
  if (m.instruction) bits.push(/[.!?]$/.test(m.instruction.trim()) ? m.instruction.trim() : `${m.instruction.trim()}.`);
  return bits.join(" ");
}

export async function handleScannerLiveConnection(socket: Socket): Promise<void> {
  const uid = socket.user?.uid;
  if (!uid) {
    emitSocketError(
      socket,
      new ExternalServiceError("Authentication", "User not authenticated"),
      "error"
    );
    socket.disconnect(true);
    return;
  }

  // Output language (handshake auth/query). Twi routes spoken guidance through
  // GhanaNLP: pre-baked positioning cues served from disk, success guidance via
  // the live translate+TTS pipeline. Input (video frames) is unaffected.
  const language = normalizeLanguage(
    socket.handshake.auth?.language ?? socket.handshake.query?.language
  );
  const isTwi = language === "tw";

  logger.info("Scanner-live: client connected", { socketId: socket.id, uid, language });

  // Per-connection state.
  let latestFrame: string | null = null; // most recent base64 JPEG (lossy latest-only)
  let awaitingTurn = false; // single-inflight gate
  let lastSuccessAt = 0;
  let tickTimer: NodeJS.Timeout | undefined;
  let perfTimer: NodeJS.Timeout | undefined;
  // Whether the current CYCLE (one nudge) has emitted any REAL spoken audio — so
  // we send exactly one "speech_end" boundary per spoken cue (and none for silent
  // cycles), and know the spoken turn actually happened before releasing the gate.
  let turnHadAudio = false;
  // Whether this turn emitted only empty audio "stubs" — the model's signal that
  // it chose NOT to re-speak an unchanged cue. Lets a held pose release promptly
  // instead of waiting out the full post-tool grace. Reset per turn.
  let sawStubThisTurn = false;
  // Whether a report_guidance tool call has been seen anywhere in this cycle. If
  // so, a no-audio turnComplete must NOT release the gate — the spoken turn is
  // still coming (and may be delayed by the success path's extract+match). Reset
  // per cycle (tick). Distinct from the per-turn toolCalledThisTurn diagnostic.
  let toolCalledThisCycle = false;
  // Grace timer (armed when we send the tool response) that releases the gate if
  // no real speech follows. See the turnComplete handler.
  let graceTimer: NodeJS.Timeout | undefined;
  const clearGrace = (): void => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };
  // Release the single-inflight gate and reset per-cycle speech state.
  const releaseGate = (): void => {
    clearGrace();
    turnHadAudio = false;
    awaitingTurn = false;
  };

  // ── Frame / performance instrumentation ──
  // Counters answer "are frames actually reaching the model?" and "how long does
  // a guidance turn take end-to-end?" — surfaced in a rolling PERF_LOG_MS summary.
  let framesReceived = 0; // frames arriving from the client
  let framesSentToModel = 0; // frames forwarded to the Gemini session
  let lastVideoSentAt = 0; // throttle gate for continuous streaming
  let turnStartedAt = 0; // nudge timestamp, for turn-latency measurement
  let gateSince = 0; // when the single-inflight gate last closed (watchdog)
  let turnsCompleted = 0;
  let turnLatencyTotalMs = 0; // sum of nudge→first-tool-call latencies
  let lastStatus = ""; // most recent reported status (for the summary)
  // Per-turn audio/tool diagnostics — answers "does the model actually SPEAK, or
  // does the function-call consume the turn?" (the usual cause of silent audio).
  let audioPartsThisTurn = 0;
  let toolCalledThisTurn = false;

  // ── Twi output state ──
  // Drug names seen in success results, protected during en→tw translation.
  const drugLexicon = new Set<string>();
  // Last spoken Twi cue key — dedupes repeated cues (don't re-speak "move closer"
  // every tick) and avoids re-emitting identical audio.
  let lastSpokenKey = "";

  let session: Session;
  try {
    session = await ai.live.connect({
      model: LIVE_SCANNER_MODEL,
      config: {
        // Live models are audio-output only. We both USE the audio — forwarding
        // the model's spoken guidance to the client — and read the structured
        // assessment from the report_guidance tool call.
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildScannerSystemPrompt(isTwi),
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE_NAME } },
        },
        temperature: 0,
        tools: [GUIDANCE_TOOL],
      },
      callbacks: {
        onopen: () => logger.debug("Scanner-live: Gemini session open", { socketId: socket.id }),
        onmessage: (message: LiveServerMessage) => {
          void handleServerMessage(message);
        },
        onerror: (e: ErrorEvent) => {
          logger.error("Scanner-live: Gemini session error", {
            socketId: socket.id,
            message: e.message,
          });
          emitSocketError(
            socket,
            new ExternalServiceError("Gemini Live", e.message || "Live session error"),
            "error"
          );
        },
        onclose: (e: CloseEvent) =>
          logger.info("Scanner-live: Gemini session closed", {
            socketId: socket.id,
            reason: e?.reason,
          }),
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("Scanner-live: failed to open Gemini session", {
      socketId: socket.id,
      message: error.message,
    });
    emitSocketError(socket, new ExternalServiceError("Gemini Live", error.message), "error");
    socket.disconnect(true);
    return;
  }

  async function handleServerMessage(message: LiveServerMessage): Promise<void> {
    const content = message.serverContent;

    // Spoken guidance: forward the model's native-audio chunks to the client.
    // The client decides playback order; the server only streams + delimits.
    // For Twi the native audio is discarded — GhanaNLP TTS provides the spoken
    // cue instead (pre-baked or live), emitted from handleGuidance as tts_audio.
    if (content?.modelTurn?.parts && !isTwi) {
      for (const part of content.modelTurn.parts) {
        if (!part.inlineData?.data) continue;
        // Empty stubs (interruption / silent-repeat artefacts) are NOT real
        // speech — only real speech chunks cross the threshold. Track that the
        // model emitted stubs (it chose not to re-speak) but don't forward them:
        // they produced silent cues + spurious speech_end on the client.
        if (part.inlineData.data.length < MIN_AUDIO_B64) {
          sawStubThisTurn = true;
          continue;
        }
        if (!socket.connected) continue;
        // Real speech is starting/continuing: we're committed to waiting for this
        // spoken turn to finish, so cancel the pending silent-release grace.
        clearGrace();
        turnHadAudio = true;
        audioPartsThisTurn += 1;
        socket.emit("audio", {
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        });
      }
    }

    // Model stopped its own speech early — seal whatever we have as a cue.
    if (content?.interrupted && turnHadAudio && socket.connected && !isTwi) {
      socket.emit("speech_end");
      turnHadAudio = false;
    }

    // Tool calls: read the structured guidance and acknowledge so the model can
    // continue the SAME turn — which, for this half-cascade model, is where the
    // spoken audio is produced (the function-call message itself carries none).
    const calls = message.toolCall?.functionCalls;
    if (calls?.length) {
      toolCalledThisTurn = true;
      toolCalledThisCycle = true;
      if (turnStartedAt) {
        // Turn latency = nudge sent → model's first guidance call this turn.
        turnLatencyTotalMs += Date.now() - turnStartedAt;
        turnsCompleted += 1;
        turnStartedAt = 0;
      }
      for (const call of calls) {
        const args = (call.args ?? {}) as {
          status?: string;
          instruction?: string;
          guidance_text?: string;
          medication?: { drug_name?: string; raw_label_text?: string[] };
        };

        // The tool response is normally just an ack, but on a success read it
        // carries a `say` field with the matched prescription — the final result
        // the model must speak aloud (English streams back as native audio, the
        // same channel as the spoken guidance). handleGuidance builds it.
        let toolResponse: { ok: true; say?: string } = { ok: true };
        try {
          toolResponse = await handleGuidance(args);
        } catch (err) {
          logger.warn("Scanner-live: failed to handle guidance", {
            socketId: socket.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Acknowledge the tool call so the model proceeds (and then speaks).
        try {
          session.sendToolResponse({
            functionResponses: [{ id: call.id, name: call.name, response: toolResponse }],
          });
        } catch {
          /* session may have closed */
        }

        // The spoken turn (if any) follows the tool response. Arm the grace now,
        // measured from THIS point so a slow success (extract + vector match above)
        // doesn't eat the speech window. Real speech cancels it; if it fires, the
        // model stayed silent and we release the gate for the next nudge. Only
        // English forwards native audio — Twi discards it (GhanaNLP TTS instead),
        // so Twi releases on turnComplete and needs no speech-protection grace.
        if (!isTwi) {
          const graceMs =
            args.status === "success" ? SUCCESS_SPEECH_GRACE_MS : POST_TOOL_SPEECH_GRACE_MS;
          clearGrace();
          graceTimer = setTimeout(() => {
            graceTimer = undefined;
            if (!turnHadAudio) releaseGate();
          }, graceMs);
        }
      }
    }

    // Gate release, because the model splits one nudge into (at least) two turns:
    // a tool-call turn (no audio) then a spoken turn. Releasing the gate on the
    // tool-call turn let the next tick fire a nudge that preempted the spoken
    // turn's still-pending audio — the root cause of the missing/clipped voice.
    //   • real audio this cycle → the spoken cue finished: seal it with
    //     speech_end and release.
    //   • else the model emitted only stubs → it chose not to re-speak an
    //     unchanged cue: release promptly (no speech to protect).
    //   • else no tool call this cycle → genuinely empty turn: release.
    //   • else (tool call in flight, speech may still come) → HOLD; the grace
    //     armed on sendToolResponse (or the watchdog) will release if it doesn't.
    if (content?.turnComplete) {
      logger.debug("Scanner-live: turn complete", {
        socketId: socket.id,
        audioParts: audioPartsThisTurn,
        toolCalled: toolCalledThisTurn,
        sawStub: sawStubThisTurn,
      });
      const hadStub = sawStubThisTurn;
      audioPartsThisTurn = 0;
      toolCalledThisTurn = false;
      sawStubThisTurn = false;
      if (isTwi) {
        // Twi forwards no native audio, so there's no spoken turn to protect:
        // release on every turnComplete (TTS cues are delivered out-of-band).
        releaseGate();
      } else if (turnHadAudio) {
        if (socket.connected) socket.emit("speech_end");
        releaseGate();
      } else if (hadStub || !toolCalledThisCycle) {
        releaseGate();
      }
      // else: hold for the spoken turn (grace/watchdog backstops the release).
    }
  }

  async function handleGuidance(args: {
    status?: string;
    instruction?: string;
    guidance_text?: string;
    medication?: { drug_name?: string; raw_label_text?: string[] };
  }): Promise<{ ok: true; say?: string }> {
    const status = args.status as MedScannerStatus | undefined;
    const guidance_text = args.guidance_text ?? "";
    if (!status || !socket.connected) return { ok: true };
    lastStatus = status;

    if (status === "success") {
      // Debounce the expensive extraction + vector search. A repeat success on
      // the same label must also stay quiet, so acknowledge without a `say` —
      // no result is re-spoken while the label keeps sitting in frame.
      if (Date.now() - lastSuccessAt < SUCCESS_COOLDOWN_MS) return { ok: true };

      const drug_name = args.medication?.drug_name;
      if (!drug_name) return { ok: true };

      const fields = await extractMedicationFields({
        drug_name,
        raw_label_text: args.medication?.raw_label_text ?? [],
      });
      const match = await findBestMatch(uid!, fields);

      // The spoken final result, built server-side from the authoritative
      // prescription match (the model can't know it — it only read the label).
      const resultSpeech = buildResultSpeech(match);

      if (isTwi) {
        // Twi discards the model's native audio, so the result is spoken through
        // GhanaNLP: translate + synthesize the result sentence and send it as
        // tts_audio (and show it as the Twi guidance_text). Protect drug names.
        drugLexicon.add(drug_name.trim());
        if (match?.medication?.name) drugLexicon.add(match.medication.name.trim());
        await emitLocalized(
          { status: "success", instruction: "none", guidance_text: resultSpeech, prescription_match: match },
          null, // no pre-baked asset — success text varies (live pipeline)
          true // always speak the result
        );
        lastSuccessAt = Date.now();
        return { ok: true };
      }

      // English: emit the structured response now (brief guidance_text + the
      // match for display); the model speaks the result via the `say` field of
      // this tool response, streamed back as native audio like the guidance.
      emitMedScannerResponse(socket, {
        status: "success",
        instruction: "none",
        guidance_text,
        prescription_match: match,
      });
      lastSuccessAt = Date.now();
      return { ok: true, say: resultSpeech };
    }

    if (status === "positioning" || status === "no_object") {
      // Coerce an out-of-enum instruction to "none" so the Zod guard never trips.
      const instruction = INSTRUCTIONS.includes(args.instruction as PositioningInstruction)
        ? (args.instruction as PositioningInstruction)
        : "none";
      // Pre-baked key: positioning cues key on their instruction; no_object has
      // its own phrase. "none" has no asset → falls back to the live pipeline.
      const prebakeKey = status === "no_object" ? "no_object" : instruction;
      await emitLocalized({ status, instruction, guidance_text }, prebakeKey);
    }
    return { ok: true };
  }

  // Emit a guidance response, localized for Twi. English passes straight
  // through. For Twi the structured response carries the Twi guidance_text and
  // the spoken cue is sent separately as a "tts_audio" WAV: served instantly
  // from a pre-baked asset when available, else translated + synthesized live.
  async function emitLocalized(
    resp: MedScannerPositioningResponse | MedScannerSuccessResponse,
    prebakeKey: string | null,
    forceSpeak = false
  ): Promise<void> {
    if (!isTwi) {
      emitMedScannerResponse(socket, resp);
      return;
    }

    let twiText: string;
    let wavBase64: string | null;
    let key: string;

    const prebaked = prebakeKey ? prebakedGuidance(prebakeKey) : null;
    if (prebaked) {
      twiText = prebaked.twi;
      wavBase64 = prebaked.wavBase64;
      key = "pre:" + prebakeKey;
    } else {
      twiText = (await englishToTwiPreserving(resp.guidance_text, [...drugLexicon])).trim();
      wavBase64 = twiText ? (await twiTTS(twiText)).toString("base64") : null;
      key = "live:" + resp.guidance_text;
    }

    if (!socket.connected) return;
    emitMedScannerResponse(socket, { ...resp, guidance_text: twiText });

    // Speak only when the cue changed, so a held pose doesn't repeat the same
    // sentence every tick (success always speaks).
    if (wavBase64 && (forceSpeak || key !== lastSpokenKey)) {
      socket.emit("tts_audio", { data: wavBase64, mimeType: "audio/wav" });
      lastSpokenKey = key;
    }
  }

  // Forward a frame to the Gemini session's realtime video channel, throttled
  // so we never exceed the Live API's ~1 FPS guidance for video input.
  function streamFrame(frame: string): void {
    if (!socket.connected) return;
    const now = Date.now();
    if (now - lastVideoSentAt < VIDEO_SEND_MIN_MS) return;
    lastVideoSentAt = now;
    framesSentToModel += 1;
    session.sendRealtimeInput({ video: { data: frame, mimeType: "image/jpeg" } });
  }

  // ── Tick: ensure the freshest frame is in, then nudge for one guidance turn ──
  // Frames already stream continuously as they arrive (see the "frame" handler),
  // so the model holds a current view; here we top it up with the very latest
  // frame and ask for an assessment. Sending the frame just before the nudge —
  // on top of the continuous stream — is what stops the model assessing an empty
  // buffer and reporting "no_object".
  tickTimer = setInterval(() => {
    if (!socket.connected) return;
    // Watchdog: a turn that never completes must not wedge the gate forever.
    if (awaitingTurn && gateSince && Date.now() - gateSince > TURN_TIMEOUT_MS) {
      logger.warn("Scanner-live: turn timed out — releasing gate", {
        socketId: socket.id,
        waitedMs: Date.now() - gateSince,
      });
      if (turnHadAudio) socket.emit("speech_end");
      audioPartsThisTurn = 0;
      toolCalledThisTurn = false;
      sawStubThisTurn = false;
      releaseGate();
    }
    if (!latestFrame || awaitingTurn) return;

    const frame = latestFrame;
    awaitingTurn = true;
    gateSince = Date.now();
    clearGrace(); // fresh cycle: cancel any stale silent-release
    turnHadAudio = false; // fresh cycle: no spoken audio seen yet
    sawStubThisTurn = false;
    toolCalledThisCycle = false; // fresh cycle: no tool call yet
    turnStartedAt = Date.now();

    emitMedScannerResponse(socket, { status: "processing" });

    // Force the freshest frame through even if the throttle would skip it, so
    // the nudge always assesses the current pose.
    lastVideoSentAt = Date.now();
    framesSentToModel += 1;
    session.sendRealtimeInput({ video: { data: frame, mimeType: "image/jpeg" } });
    session.sendRealtimeInput({ text: NUDGE_TEXT });
    // Twi spends longer per cue (translate/TTS for success; still worth easing
    // the cadence so guidance doesn't churn ahead of the spoken output).
  }, isTwi ? SCANNER_TWI_TICK_MS : SCANNER_TICK_MS);

  // ── Rolling performance summary ──
  perfTimer = setInterval(() => {
    if (!socket.connected) return;
    const avgLatency = turnsCompleted ? Math.round(turnLatencyTotalMs / turnsCompleted) : 0;
    logger.info("Scanner-live: perf", {
      socketId: socket.id,
      framesReceived,
      framesSentToModel,
      turnsCompleted,
      avgTurnLatencyMs: avgLatency,
      lastStatus,
      awaitingTurn,
    });
  }, PERF_LOG_MS);

  // ── Client → session ──
  socket.on("frame", (chunk: { buf: ArrayBuffer | Buffer | Uint8Array }) => {
    if (!chunk?.buf) return;
    // Keep only the newest frame so each tick reflects the current pose...
    latestFrame = Buffer.from(chunk.buf as Uint8Array).toString("base64");
    framesReceived += 1;
    // ...and stream it to the model continuously (throttled) so a current view
    // is always buffered, independent of the nudge cadence.
    streamFrame(latestFrame);
  });

  // ── Cleanup ──
  socket.on("disconnect", (reason) => {
    logger.info("Scanner-live: client disconnected", {
      socketId: socket.id,
      reason,
      framesReceived,
      framesSentToModel,
      turnsCompleted,
      avgTurnLatencyMs: turnsCompleted ? Math.round(turnLatencyTotalMs / turnsCompleted) : 0,
    });
    if (tickTimer) clearInterval(tickTimer);
    if (perfTimer) clearInterval(perfTimer);
    clearGrace();
    latestFrame = null;
    try {
      session.close();
    } catch {
      /* already closed */
    }
  });
}
