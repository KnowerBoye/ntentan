// ─────────────────────────────────────────────
//  features/assistant/assistant-live.service.ts
//
//  Real-time voice medical assistant over the Gemini Live API.
//
//  The server owns one Gemini Live session per connected Socket.IO client and
//  acts as a relay: it forwards the client's mic audio / text into the session
//  and streams the model's spoken audio, transcripts, and tool-call activity
//  back out. Tool calls run the SAME implementations as the REST assistant
//  (query_prescriptions, search_drug_info, save_prescription), with userId
//  injected from the Firebase-verified socket — never from model args.
//
//  Wire protocol (Socket.IO namespace "/assistant-live"):
//    client → server:
//      "audio"      { data }   base64 PCM 16-bit mono 16kHz   → realtime audio
//      "text"       { text }   typed message                  → realtime text
//      "audio_end"             mic turned off                 → end audio stream
//    server → client:
//      "ready"                 Live session established
//      "audio"      { data, mimeType }   model voice chunk (base64 PCM 24kHz)
//      "transcript" { role, text }       input/output transcription
//      "tool"       { name }             a tool call is running (UI status)
//      "sources"    { sources }          citation URLs backing a drug answer
//      "interrupted"                     barge-in — client should flush playback
//      "turn_complete"
//      "error"      { code, message }
// ─────────────────────────────────────────────
import { GoogleGenAI, Modality, LiveServerMessage, Session } from "@google/genai";
import { Socket } from "socket.io";
import dotenv from "dotenv";

import { tools, dispatchTool } from "@features/assistant/assistant-live.tools";
import { buildLiveSystemPrompt } from "@features/assistant/live-prompt";
import {
  LIVE_ASSISTANT_MODEL,
  LIVE_VOICE_NAME,
  INPUT_AUDIO_MIME,
} from "@config/live";
import { logger } from "@/lib/logger";
import { emitSocketError } from "@/lib/socket-error-handler";
import { ExternalServiceError } from "@/lib/errors";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Socket.IO connection handler for the live voice assistant.
 * Opens a Gemini Live session and relays audio/text/tools for its lifetime.
 */
export async function handleAssistantLiveConnection(socket: Socket): Promise<void> {
  const uid = socket.user?.uid;
  if (!uid) {
    // socketAuthMiddleware guarantees this, but fail closed just in case.
    emitSocketError(
      socket,
      new ExternalServiceError("Authentication", "User not authenticated"),
      "error"
    );
    socket.disconnect(true);
    return;
  }

  logger.info("Assistant-live: client connected", { socketId: socket.id, uid });

  // Sources accumulate across a turn; flushed on turn_complete.
  let turnSources: string[] = [];

  let session: Session;
  try {
    session = await ai.live.connect({
      model: LIVE_ASSISTANT_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildLiveSystemPrompt(),
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE_NAME } },
        },
        // Transcribe both sides so the client can show captions and we can log.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools,
      },
      callbacks: {
        onopen: () => {
          logger.debug("Assistant-live: Gemini session open", { socketId: socket.id });
          if (socket.connected) socket.emit("ready");
        },
        onmessage: (message: LiveServerMessage) => {
          void handleServerMessage(message);
        },
        onerror: (e: ErrorEvent) => {
          logger.error("Assistant-live: Gemini session error", {
            socketId: socket.id,
            message: e.message,
          });
          emitSocketError(
            socket,
            new ExternalServiceError("Gemini Live", e.message || "Live session error"),
            "error"
          );
        },
        onclose: (e: CloseEvent) => {
          logger.info("Assistant-live: Gemini session closed", {
            socketId: socket.id,
            reason: e?.reason,
          });
        },
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("Assistant-live: failed to open Gemini session", {
      socketId: socket.id,
      message: error.message,
    });
    emitSocketError(
      socket,
      new ExternalServiceError("Gemini Live", error.message),
      "error"
    );
    socket.disconnect(true);
    return;
  }

  // ── Handle one message from the Gemini Live session ──
  async function handleServerMessage(message: LiveServerMessage): Promise<void> {
    try {
      // 1. Tool calls — dispatch and respond.
      if (message.toolCall?.functionCalls?.length) {
        const calls = message.toolCall.functionCalls;

        const functionResponses = await Promise.all(
          calls.map(async (call) => {
            if (socket.connected) socket.emit("tool", { name: call.name });

            const { result, isSearch } = await dispatchTool(call, uid!);

            if (isSearch) {
              const data = (result as { data?: { citations?: string[]; source?: string } })?.data;
              if (data?.citations?.length) {
                turnSources.push(...data.citations);
              } else if (data?.source === "openfda" || data?.source === "llm+openfda") {
                turnSources.push("OpenFDA Drug Label Database");
              }
            }

            return {
              id: call.id,
              name: call.name,
              response: { result },
            };
          })
        );

        session.sendToolResponse({ functionResponses });
        return;
      }

      const content = message.serverContent;
      if (!content) return;

      // 2. Model audio (and any text) parts.
      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (part.inlineData?.data && socket.connected) {
            socket.emit("audio", {
              data: part.inlineData.data,
              mimeType: part.inlineData.mimeType,
            });
          }
        }
      }

      // 3. Transcriptions (captions).
      if (content.inputTranscription?.text && socket.connected) {
        socket.emit("transcript", { role: "user", text: content.inputTranscription.text });
      }
      if (content.outputTranscription?.text && socket.connected) {
        socket.emit("transcript", { role: "model", text: content.outputTranscription.text });
      }

      // 4. Barge-in.
      if (content.interrupted && socket.connected) {
        socket.emit("interrupted");
      }

      // 5. End of turn — flush any collected sources, then signal completion.
      if (content.turnComplete && socket.connected) {
        if (turnSources.length) {
          socket.emit("sources", { sources: Array.from(new Set(turnSources)) });
          turnSources = [];
        }
        socket.emit("turn_complete");
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("Assistant-live: error handling server message", {
        socketId: socket.id,
        message: error.message,
        stack: error.stack,
      });
      emitSocketError(
        socket,
        new ExternalServiceError("Assistant Live", error.message),
        "error"
      );
    }
  }

  // ── Client → session relays ──
  socket.on("audio", (payload: { data?: string }) => {
    if (!payload?.data) return;
    session.sendRealtimeInput({
      audio: { data: payload.data, mimeType: INPUT_AUDIO_MIME },
    });
  });

  socket.on("text", (payload: { text?: string }) => {
    if (!payload?.text) return;
    session.sendRealtimeInput({ text: payload.text });
  });

  socket.on("audio_end", () => {
    session.sendRealtimeInput({ audioStreamEnd: true });
  });

  // ── Cleanup ──
  socket.on("disconnect", (reason) => {
    logger.info("Assistant-live: client disconnected", { socketId: socket.id, reason });
    try {
      session.close();
    } catch {
      /* already closed */
    }
  });
}
