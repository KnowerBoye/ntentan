// ─────────────────────────────────────────────
//  scripts/live-smoke.ts
//
//  Credential-free smoke test for the Live assistant wiring. Opens a real
//  Gemini Live session with the same model + system prompt + tool declarations
//  the server uses, sends a text turn that should force a personal-prescription
//  lookup, and asserts the model emits a `query_prescriptions` tool call.
//
//  This needs only GEMINI_API_KEY (no Firebase / no mic). It deliberately
//  imports just the tool *declarations* and prompt — not the dispatcher — so it
//  does not pull in the Firebase admin init.
//
//  Run:  GEMINI_API_KEY=... npx ts-node --files -r tsconfig-paths/register scripts/live-smoke.ts
//        (or: npm run smoke)
// ─────────────────────────────────────────────
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import dotenv from "dotenv";

import { tools } from "../src/features/assistant/assistant.tools";
import { buildLiveSystemPrompt } from "../src/features/assistant/live-prompt";
import { LIVE_ASSISTANT_MODEL } from "../src/config/live";

dotenv.config();

const TIMEOUT_MS = 25000;

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("✗ GEMINI_API_KEY is not set.");
    process.exit(2);
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  console.log(`→ connecting to ${LIVE_ASSISTANT_MODEL} …`);

  let settled = false;
  const done = (ok: boolean, msg: string) => {
    if (settled) return;
    settled = true;
    console.log(ok ? `✓ PASS — ${msg}` : `✗ FAIL — ${msg}`);
    process.exit(ok ? 0 : 1);
  };

  const session = await ai.live.connect({
    model: LIVE_ASSISTANT_MODEL,
    config: {
      responseModalities: [Modality.TEXT], // text is enough to observe the tool call
      systemInstruction: buildLiveSystemPrompt(),
      tools,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: {
      onopen: () => {
        console.log("→ session open; sending prompt…");
        // Defer: onopen can fire synchronously *during* ai.live.connect(),
        // before the `session` const below has been assigned.
        setTimeout(() => {
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text: "What medication should I take next?" }] }],
            turnComplete: true,
          });
        }, 0);
      },
      onmessage: (m: LiveServerMessage) => {
        const names = m.toolCall?.functionCalls?.map((f) => f.name) ?? [];
        if (names.length) console.log("  ← toolCall:", names.join(", "));
        if (names.includes("query_prescriptions")) {
          session.close();
          done(true, "model requested query_prescriptions");
        }
      },
      onerror: (e: ErrorEvent) => done(false, "session error: " + e.message),
      onclose: () => {},
    },
  });

  setTimeout(() => { try { session.close(); } catch {} done(false, "no query_prescriptions tool call within timeout"); }, TIMEOUT_MS);
}

main().catch((e) => { console.error("✗ FAIL —", e?.message || e); process.exit(1); });
