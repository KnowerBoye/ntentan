// ─────────────────────────────────────────────
//  scripts/build-twi-guidance.ts
//
//  Offline generator for the scanner's pre-baked Twi guidance assets. For each
//  phrase in CANONICAL_GUIDANCE it produces Twi text (GhanaNLP translate, unless
//  a hand-authored `twi` override is given) and a Twi WAV (GhanaNLP TTS), then
//  writes them to assets/twi-guidance/ as one WAV per key + a manifest.json the
//  server loads at runtime. Needs GHNLP_API_KEY only.
//
//  Run:  npm run build:twi-guidance
// ─────────────────────────────────────────────
import fs from "fs";
import dotenv from "dotenv";

import { englishToTwi, twiTTS } from "../src/features/assistant/ghananlp.service";
import {
  CANONICAL_GUIDANCE,
  TWI_GUIDANCE_DIR,
  TWI_GUIDANCE_MANIFEST,
} from "../src/features/medication-scanner/twi-guidance";

dotenv.config();

async function main(): Promise<void> {
  fs.mkdirSync(TWI_GUIDANCE_DIR, { recursive: true });

  const phrases: Record<string, { english: string; twi: string; audio: string }> = {};

  for (const [key, { english, twi: override }] of Object.entries(CANONICAL_GUIDANCE)) {
    const twi = (override ?? (await englishToTwi(english))).trim();
    const wav = await twiTTS(twi);
    const audio = `${key}.wav`;
    fs.writeFileSync(`${TWI_GUIDANCE_DIR}/${audio}`, wav);
    phrases[key] = { english, twi, audio };
    console.log(`  ✓ ${key.padEnd(12)} "${english}" → "${twi}" (${wav.length} bytes)`);
  }

  fs.writeFileSync(
    TWI_GUIDANCE_MANIFEST,
    JSON.stringify({ generatedAt: new Date().toISOString(), phrases }, null, 2)
  );
  console.log(`\nWrote ${Object.keys(phrases).length} phrases → ${TWI_GUIDANCE_MANIFEST}`);
}

main().catch((err) => {
  console.error("build-twi-guidance failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
