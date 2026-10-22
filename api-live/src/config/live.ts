// ─────────────────────────────────────────────
//  config/live.ts
//  Central config for the Gemini Live API sessions.
//
//  Model IDs change as the Live API evolves — keep them in env so a new
//  preview can be rolled in without a code change. Defaults are models verified
//  to support bidiGenerateContent (the Live method): the assistant uses a
//  native-audio model for the most natural voice; the scanner uses a flash-live
//  (cascade) model, which handles the TEXT + video guidance loop. Other valid
//  options include gemini-3.8-live and gemini-3.1-flash-live-preview.
// ─────────────────────────────────────────────
import dotenv from "dotenv";

dotenv.config();

/** Live model driving the voice assistant (native audio in/out + tools). */
export const LIVE_ASSISTANT_MODEL =
  process.env.LIVE_ASSISTANT_MODEL ?? "gemini-2.5-flash-native-audio-preview-09-2025";

/** Live model driving the scanner (video in, text-out guidance). */
export const LIVE_SCANNER_MODEL =
  process.env.LIVE_SCANNER_MODEL ?? "gemini-3.1-flash-live-preview";

/** Prebuilt voice for the assistant's spoken replies. */
export const LIVE_VOICE_NAME = process.env.LIVE_VOICE_NAME ?? "Aoede";

// ── GhanaNLP (Twi language layer) ──
// The Twi voice path routes the assistant's spoken output through GhanaNLP's
// text-to-speech instead of Gemini's native audio, which handles Twi better.
// Translation / speech-to-text utilities from the same API can be layered in
// later. Auth is an Ocp-Apim-Subscription-Key (GHNLP_API_KEY).
export const GHNLP_API_BASE =
  process.env.GHNLP_API_BASE ?? "https://translation-api.ghananlp.org";
/** GhanaNLP TTS voice for Twi synthesis ("female" | "male"). */
export const GHNLP_TTS_VOICE = process.env.GHNLP_TTS_VOICE ?? "female";

// ── Audio formats are fixed by the Live API contract ──
/** Client mic → server: 16-bit PCM, mono, 16 kHz, little-endian. */
export const INPUT_AUDIO_MIME = "audio/pcm;rate=16000";
export const INPUT_SAMPLE_RATE = 16000;
/** Server → client model voice: 16-bit PCM, mono, 24 kHz. */
export const OUTPUT_SAMPLE_RATE = 24000;
