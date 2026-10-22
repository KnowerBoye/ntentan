// ─────────────────────────────────────────────
//  features/medication-scanner/twi-guidance.ts
//
//  Pre-baked Twi assets for the scanner's spoken guidance. Positioning cues are
//  a small finite set (one per PositioningInstruction, plus a "no_object"
//  prompt), so instead of calling GhanaNLP translate + TTS on every ~1s tick we
//  translate and synthesize them ONCE (offline, via scripts/build-twi-guidance)
//  and persist the result. At runtime the scanner serves these instantly from
//  disk — no API latency on the hot path. Only `success` guidance (which can
//  carry a drug name) falls back to the live pipeline.
//
//  Assets live at <cwd>/assets/twi-guidance/ (manifest.json + one WAV per key),
//  resolved from the working directory like portal/ and the Firebase creds.
//  To regenerate (or after editing canonical phrases):  npm run build:twi-guidance
//  You can also hand-author a `twi` override below and the builder will keep it
//  (only re-synthesizing the audio), so a bad machine translation can be fixed.
// ─────────────────────────────────────────────
import fs from "fs";
import path from "path";

import { logger } from "@/lib/logger";

/**
 * Canonical English phrase for each pre-baked guidance key. Keys are the
 * PositioningInstruction values the model reports, plus "no_object". If `twi`
 * is set it is treated as authoritative (hand-authored) and translation is
 * skipped by the builder; otherwise the builder fills it from GhanaNLP.
 */
// NOTE: the `twi` values below are hand-authored DRAFTS (standardized on "aduro"
// for medicine) replacing the machine translations, which had errors: move_down
// previously meant "remove it from there", flip dropped "over", no_object was a
// long clause that dropped "label", and the term for medicine varied across
// cues. They are UNVERIFIED — a Twi speaker should confirm each before running
// `npm run build:twi-guidance` (which keeps these overrides and only re-synthesizes audio).
export const CANONICAL_GUIDANCE: Record<string, { english: string; twi?: string }> = {
  move_up: { english: "Move the medication up.", twi: "Ma aduro no so kɔ soro." },
  move_down: { english: "Move the medication down.", twi: "Fa aduro no kɔ fam." },
  move_left: { english: "Move the medication to the left.", twi: "Fa aduro no kɔ benkum so." },
  move_right: { english: "Move the medication to the right.", twi: "Fa aduro no kɔ nifa so." },
  rotate_left: { english: "Turn the label to the left.", twi: "Dane nkyerɛwde no kɔ benkum so." },
  rotate_right: { english: "Turn the label to the right.", twi: "Dane nkyerɛwde no kɔ nifa so." },
  flip: { english: "Turn the medication over.", twi: "Dane aduro no ani." },
  move_closer: { english: "Bring the medication closer.", twi: "Fa aduro no bra anim." },
  move_farther: { english: "Move the medication farther away.", twi: "Fa aduro no kɔ akyiri kakra." },
  hold_still: { english: "Hold it still.", twi: "Kura mu wɔ hɔ." },
  no_object: { english: "Point the camera at a medication label.", twi: "Fa aduro no kyerɛ afiri no so." },
};

export const TWI_GUIDANCE_DIR = path.resolve(process.cwd(), "assets", "twi-guidance");
export const TWI_GUIDANCE_MANIFEST = path.join(TWI_GUIDANCE_DIR, "manifest.json");

interface ManifestEntry {
  english: string;
  twi: string;
  audio: string; // WAV filename, relative to TWI_GUIDANCE_DIR
}
interface Manifest {
  phrases: Record<string, ManifestEntry>;
}

export interface PrebakedGuidance {
  twi: string;
  wavBase64: string;
}

// Loaded once, lazily. null entry = key present but audio unreadable.
let cache: Map<string, PrebakedGuidance> | null = null;

function load(): Map<string, PrebakedGuidance> {
  if (cache) return cache;
  cache = new Map();
  try {
    const manifest = JSON.parse(fs.readFileSync(TWI_GUIDANCE_MANIFEST, "utf8")) as Manifest;
    for (const [key, entry] of Object.entries(manifest.phrases ?? {})) {
      try {
        const wav = fs.readFileSync(path.join(TWI_GUIDANCE_DIR, entry.audio));
        cache.set(key, { twi: entry.twi, wavBase64: wav.toString("base64") });
      } catch {
        logger.warn("Twi guidance: audio missing for key", { key, audio: entry.audio });
      }
    }
    logger.info("Twi guidance: pre-baked assets loaded", { count: cache.size });
  } catch {
    // No assets yet — scanner Twi will fall back to the live pipeline for all
    // cues. Run `npm run build:twi-guidance` to generate them.
    logger.warn("Twi guidance: no pre-baked assets found; using live pipeline", {
      manifest: TWI_GUIDANCE_MANIFEST,
    });
  }
  return cache;
}

/** Pre-baked Twi text + audio for a guidance key, or null if not available. */
export function prebakedGuidance(key: string): PrebakedGuidance | null {
  return load().get(key) ?? null;
}
