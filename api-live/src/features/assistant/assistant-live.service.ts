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
//      "tts_audio"  { data, mimeType }   full Twi utterance (base64 WAV) — see below
//      "transcript" { role, text }       input/output transcription
//      "tool"       { name }             a tool call is running (UI status)
//      "sources"    { sources }          citation URLs backing a drug answer
//      "interrupted"                     barge-in — client should flush playback
//      "turn_complete"
//      "error"      { code, message }
//
//  TWI LANGUAGE LAYER (language: "tw"):
//    Gemini does not construct good Twi, so for Twi sessions it never sees or
//    produces Twi — GhanaNLP owns both ends and the model works in English:
//
//      INPUT  mic Twi audio is buffered (NOT streamed to Gemini); on audio_end
//             we WAV-wrap it → twiASR → twiToEnglish → send English text to the
//             session. Typed text is likewise translated tw→en first.
//      OUTPUT Gemini's native audio is discarded; we accumulate its English
//             output transcription, and on turn end englishToTwi → twiTTS, sent
//             as one "tts_audio" (WAV) event. The user sees Twi captions
//             (their ASR text + the translated reply), never the English.
//
//    Tools, sources, and the English path are unchanged. Higher latency is
//    inherent to the serial pipeline (see note in the handler).
// ─────────────────────────────────────────────
import { GoogleGenAI, Modality, LiveServerMessage, Session } from "@google/genai";
import { Socket } from "socket.io";
import dotenv from "dotenv";

import { tools, dispatchTool } from "@features/assistant/assistant-live.tools";
import { buildLiveSystemPrompt, normalizeLanguage } from "@features/assistant/live-prompt";
import {
  twiASR,
  twiToEnglish,
  englishToTwiPreserving,
  twiTTS,
} from "@features/assistant/ghananlp.service";
import { pcm16ToWav } from "@/lib/wav";
import {
  LIVE_ASSISTANT_MODEL,
  LIVE_VOICE_NAME,
  INPUT_AUDIO_MIME,
  INPUT_SAMPLE_RATE,
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

  // Conversation language, chosen by the client via the handshake (auth or
  // query). English talks to Gemini directly; Twi routes through GhanaNLP.
  const language = normalizeLanguage(
    socket.handshake.auth?.language ?? socket.handshake.query?.language
  );

  const isTwi = language === "tw";

  logger.info("Assistant-live: client connected", {
    socketId: socket.id,
    uid,
    language,
  });

  // Sources accumulate across a turn; flushed on turn_complete.
  let turnSources: string[] = [];

  // ── Twi pipeline state (only used when isTwi) ──
  // Buffered mic PCM16 for the current utterance (fed to GhanaNLP ASR on
  // audio_end rather than streamed to Gemini).
  let twiInputChunks: Buffer[] = [];
  // Output half is SENTENCE-CHUNKED to cut latency: as the model's English
  // transcription streams, each complete sentence is translated + synthesized
  // immediately (so the first Twi audio plays before the reply is finished),
  // while a promise chain keeps the client emits strictly in order.
  let englishPending = ""; // trailing, not-yet-complete sentence
  let ttsChain: Promise<void> = Promise.resolve(); // ordered emit chain
  let twiCancelled = false; // set on barge-in to drop the rest of a turn
  // Drug names seen via tool calls this session. Translation mangles drug names
  // (amoxicillin→"anom asɛm"), so these are protected during en→tw (see
  // englishToTwiPreserving). Only meaningful for Twi.
  const drugLexicon = new Set<string>();

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

            if (isTwi) harvestDrugNames(call, result);

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

      // 2. Model audio parts. English: stream each native-audio chunk straight
      //    to the client as it arrives (Gemini Live handles the realtime audio).
      //    Twi: the native audio is discarded — GhanaNLP TTS provides the spoken
      //    reply instead (synthesized on turn end).
      if (content.modelTurn?.parts && !isTwi) {
        for (const part of content.modelTurn.parts) {
          if (part.inlineData?.data && socket.connected) {
            socket.emit("audio", {
              data: part.inlineData.data,
              mimeType: part.inlineData.mimeType,
            });
          }
        }
      }

      // 3. Transcriptions (captions). English streams both sides straight
      //    through. For Twi, Gemini works in English: the user caption is the
      //    ASR text we emit ourselves (on audio_end), and the model's English
      //    transcription is only accumulated — the Twi caption is emitted once,
      //    translated, at turn end. So the user never sees the English.
      if (content.inputTranscription?.text && socket.connected && !isTwi) {
        socket.emit("transcript", { role: "user", text: content.inputTranscription.text });
      }
      if (content.outputTranscription?.text) {
        if (isTwi) {
          // Buffer English, peel off any complete sentences for immediate
          // translate + TTS. The incomplete tail waits for more text.
          englishPending += content.outputTranscription.text;
          peelTwiSentences();
        } else if (socket.connected) {
          socket.emit("transcript", { role: "model", text: content.outputTranscription.text });
        }
      }

      // 4. Barge-in. Drop the rest of a half-formed Twi turn so it isn't spoken late.
      if (content.interrupted) {
        if (isTwi) {
          twiCancelled = true;
          englishPending = "";
        }
        if (socket.connected) socket.emit("interrupted");
      }

      // 5. End of turn — flush collected sources, flush the final Twi sentence,
      //    wait for all queued speech to be sent, then signal completion.
      if (content.turnComplete) {
        if (turnSources.length && socket.connected) {
          socket.emit("sources", { sources: Array.from(new Set(turnSources)) });
          turnSources = [];
        }
        if (isTwi) {
          const rest = englishPending.trim();
          englishPending = "";
          if (rest) enqueueTwiSentence(rest);
          await ttsChain; // keep turn_complete after the last tts_audio
        }
        if (socket.connected) socket.emit("turn_complete");
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

  // Collect drug names from a tool call + its result into the session lexicon
  // (tool args' drugName/name, and query_prescriptions' returned prescriptions).
  function harvestDrugNames(call: { args?: Record<string, unknown> }, result: unknown): void {
    const args = call.args ?? {};
    for (const key of ["drugName", "name"]) {
      const v = args[key];
      if (typeof v === "string" && v.trim()) drugLexicon.add(v.trim());
    }
    const prescriptions = (result as { data?: { prescriptions?: Array<{ name?: unknown }> } })
      ?.data?.prescriptions;
    if (Array.isArray(prescriptions)) {
      for (const p of prescriptions) {
        if (p && typeof p.name === "string" && p.name.trim()) drugLexicon.add(p.name.trim());
      }
    }
  }

  // ── Twi OUTPUT: sentence-chunked English reply → Twi caption + speech ──
  // Peel every complete sentence from englishPending (a sentence being text up
  // to [.!?] followed by whitespace) and enqueue each one. The trailing partial
  // sentence stays buffered until more text (or turn end) completes it.
  function peelTwiSentences(): void {
    for (;;) {
      const m = englishPending.match(/^([^.!?]*[.!?]+)(\s+)([\s\S]*)$/);
      if (!m) break;
      const sentence = m[1].trim();
      englishPending = m[3];
      if (sentence) enqueueTwiSentence(sentence);
    }
  }

  // Translate + synthesize one English sentence immediately (so sentences
  // pipeline in parallel), but emit caption+audio in order via ttsChain.
  function enqueueTwiSentence(english: string): void {
    const turnCancelledAtEnqueue = twiCancelled;
    const work = (async () => {
      const twi = (await englishToTwiPreserving(english, [...drugLexicon])).trim();
      const wav = twi ? await twiTTS(twi) : null;
      return { twi, wav };
    })();

    ttsChain = ttsChain.then(async () => {
      try {
        const { twi, wav } = await work;
        if (twiCancelled || turnCancelledAtEnqueue || !socket.connected) return;
        // Caption the reply in Twi (the user never sees the English).
        if (twi) socket.emit("transcript", { role: "model", text: twi + " " });
        if (wav) {
          socket.emit("tts_audio", { data: wav.toString("base64"), mimeType: "audio/wav" });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error("Assistant-live: Twi output pipeline failed", {
          socketId: socket.id,
          message: error.message,
        });
        emitSocketError(socket, new ExternalServiceError("GhanaNLP", error.message), "error");
      }
    });
  }

  // ── Twi INPUT: buffered mic Twi audio → ASR → English → feed Gemini ──
  async function handleTwiAudioTurn(): Promise<void> {
    if (!twiInputChunks.length) return;
    const pcm = Buffer.concat(twiInputChunks);
    twiInputChunks = [];
    if (!socket.connected) return;

    // Fresh user turn — allow the upcoming reply's sentences to be spoken.
    twiCancelled = false;
    englishPending = "";

    try {
      const wav = pcm16ToWav(pcm, INPUT_SAMPLE_RATE, 1);
      const twiText = (await twiASR(wav)).trim();
      if (!twiText) return; // nothing intelligible

      // Echo what the user said, in Twi.
      if (socket.connected) socket.emit("transcript", { role: "user", text: twiText });

      const englishText = (await twiToEnglish(twiText)).trim();
      if (!englishText || !socket.connected) return;

      session.sendRealtimeInput({ text: englishText });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("Assistant-live: Twi input pipeline failed", {
        socketId: socket.id,
        message: error.message,
      });
      emitSocketError(
        socket,
        new ExternalServiceError("GhanaNLP", error.message),
        "error"
      );
    }
  }

  // ── Client → session relays ──
  socket.on("audio", (payload: { data?: string }) => {
    if (!payload?.data) return;
    // Twi: buffer locally for ASR; don't let Gemini hear Twi audio.
    if (isTwi) {
      twiInputChunks.push(Buffer.from(payload.data, "base64"));
      return;
    }
    session.sendRealtimeInput({
      audio: { data: payload.data, mimeType: INPUT_AUDIO_MIME },
    });
  });

  socket.on("text", (payload: { text?: string }) => {
    if (!payload?.text) return;
    // Twi: typed text is assumed Twi and translated before Gemini.
    if (isTwi) {
      twiCancelled = false;
      englishPending = "";
      void (async () => {
        try {
          const englishText = (await twiToEnglish(payload.text!.trim())).trim();
          if (englishText && socket.connected) {
            session.sendRealtimeInput({ text: englishText });
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error("Assistant-live: Twi text translate failed", {
            socketId: socket.id,
            message: error.message,
          });
          emitSocketError(socket, new ExternalServiceError("GhanaNLP", error.message), "error");
        }
      })();
      return;
    }
    session.sendRealtimeInput({ text: payload.text });
  });

  socket.on("audio_end", () => {
    // Twi: the utterance is complete — run the ASR→translate→Gemini pipeline.
    if (isTwi) {
      void handleTwiAudioTurn();
      return;
    }
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
