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
} from "@/types/medscanner";
import { extractMedicationFields, findBestMatch } from "@features/medication-scanner/medscanner.match";
import { LIVE_SCANNER_MODEL, LIVE_VOICE_NAME } from "@config/live";
import { logger } from "@/lib/logger";
import { emitSocketError } from "@/lib/socket-error-handler";
import { ExternalServiceError } from "@/lib/errors";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// One guidance turn roughly every second — the Live API recommends ≤1 FPS for
// video input, and positioning guidance faster than this just churns the UI.
const SCANNER_TICK_MS = 1000;

// After a success, don't re-run the expensive extraction + vector search while
// the same label keeps sitting in frame (mirrors the original debounce).
const SUCCESS_COOLDOWN_MS = 5000;

const NUDGE_TEXT = "Assess the current camera frame and call report_guidance now.";

const INSTRUCTIONS: PositioningInstruction[] = [
  "move_up", "move_down", "move_left", "move_right",
  "rotate_left", "rotate_right", "flip",
  "move_closer", "move_farther", "hold_still", "none",
];

const SCANNER_SYSTEM_PROMPT = `
You are a medication label reading assistant in a live camera session. You
receive the most recent camera frame and must guide the user to position a
medication so its label can be read.

For EVERY frame you MUST do BOTH of the following, in the same turn:
  1. SPEAK one short, friendly sentence aloud (under ~12 words) telling the user
     what to do right now. This is the user's live voice guide.
  2. Call the report_guidance tool exactly once with the structured assessment.
The spoken sentence and the guidance_text you report MUST say the same thing, so
what the user hears always matches what they see.

report_guidance statuses:
- status "no_object"   → no medication visible in the frame.
- status "positioning" → medication visible but label not clearly readable;
    set instruction to ONE movement cue and give a short guidance_text.
- status "success"     → label is clearly readable; set instruction to "none",
    and include medication.drug_name plus medication.raw_label_text (every
    readable line of text on the label).

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

  logger.info("Scanner-live: client connected", { socketId: socket.id, uid });

  // Per-connection state.
  let latestFrame: string | null = null; // most recent base64 JPEG (lossy latest-only)
  let awaitingTurn = false; // single-inflight gate
  let lastSuccessAt = 0;
  let tickTimer: NodeJS.Timeout | undefined;
  // Whether the current turn has emitted any spoken audio — so we send exactly
  // one "speech_end" boundary per spoken cue (and none for silent turns).
  let turnHadAudio = false;

  let session: Session;
  try {
    session = await ai.live.connect({
      model: LIVE_SCANNER_MODEL,
      config: {
        // Live models are audio-output only. We both USE the audio — forwarding
        // the model's spoken guidance to the client — and read the structured
        // assessment from the report_guidance tool call.
        responseModalities: [Modality.AUDIO],
        systemInstruction: SCANNER_SYSTEM_PROMPT,
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
    if (content?.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data && socket.connected) {
          turnHadAudio = true;
          socket.emit("audio", {
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          });
        }
      }
    }

    // Model stopped its own speech early — seal whatever we have as a cue.
    if (content?.interrupted && turnHadAudio && socket.connected) {
      socket.emit("speech_end");
      turnHadAudio = false;
    }

    const calls = message.toolCall?.functionCalls;
    if (!calls?.length) {
      // No tool call this message — on turn end, close out the spoken cue and
      // release the single-inflight gate.
      if (content?.turnComplete) {
        if (turnHadAudio && socket.connected) socket.emit("speech_end");
        turnHadAudio = false;
        awaitingTurn = false;
      }
      return;
    }

    for (const call of calls) {
      const args = (call.args ?? {}) as {
        status?: string;
        instruction?: string;
        guidance_text?: string;
        medication?: { drug_name?: string; raw_label_text?: string[] };
      };

      try {
        await handleGuidance(args);
      } catch (err) {
        logger.warn("Scanner-live: failed to handle guidance", {
          socketId: socket.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Acknowledge the tool call so the model can proceed to the next turn.
      try {
        session.sendToolResponse({
          functionResponses: [{ id: call.id, name: call.name, response: { ok: true } }],
        });
      } catch {
        /* session may have closed */
      }
    }

    awaitingTurn = false;
  }

  async function handleGuidance(args: {
    status?: string;
    instruction?: string;
    guidance_text?: string;
    medication?: { drug_name?: string; raw_label_text?: string[] };
  }): Promise<void> {
    const status = args.status as MedScannerStatus | undefined;
    const guidance_text = args.guidance_text ?? "";
    if (!status || !socket.connected) return;

    if (status === "success") {
      // Debounce the expensive extraction + vector search.
      if (Date.now() - lastSuccessAt < SUCCESS_COOLDOWN_MS) return;

      const drug_name = args.medication?.drug_name;
      if (!drug_name) return;

      const fields = await extractMedicationFields({
        drug_name,
        raw_label_text: args.medication?.raw_label_text ?? [],
      });
      const match = await findBestMatch(uid!, fields);

      emitMedScannerResponse(socket, {
        status: "success",
        instruction: "none",
        guidance_text,
        prescription_match: match,
      });
      lastSuccessAt = Date.now();
      return;
    }

    if (status === "positioning" || status === "no_object") {
      // Coerce an out-of-enum instruction to "none" so the Zod guard never trips.
      const instruction = INSTRUCTIONS.includes(args.instruction as PositioningInstruction)
        ? (args.instruction as PositioningInstruction)
        : "none";
      emitMedScannerResponse(socket, { status, instruction, guidance_text });
    }
  }

  // ── Tick: push the latest frame + nudge the model for one guidance turn ──
  tickTimer = setInterval(() => {
    if (!latestFrame || awaitingTurn || !socket.connected) return;

    const frame = latestFrame;
    latestFrame = null;
    awaitingTurn = true;
    turnHadAudio = false; // fresh turn: no spoken audio seen yet

    emitMedScannerResponse(socket, { status: "processing" });

    session.sendRealtimeInput({ video: { data: frame, mimeType: "image/jpeg" } });
    session.sendRealtimeInput({ text: NUDGE_TEXT });
  }, SCANNER_TICK_MS);

  // ── Client → session ──
  socket.on("frame", (chunk: { buf: ArrayBuffer | Buffer | Uint8Array }) => {
    if (!chunk?.buf) return;
    // Keep only the newest frame so each tick reflects the current pose.
    latestFrame = Buffer.from(chunk.buf as Uint8Array).toString("base64");
  });

  // ── Cleanup ──
  socket.on("disconnect", (reason) => {
    logger.info("Scanner-live: client disconnected", { socketId: socket.id, reason });
    if (tickTimer) clearInterval(tickTimer);
    latestFrame = null;
    try {
      session.close();
    } catch {
      /* already closed */
    }
  });
}
