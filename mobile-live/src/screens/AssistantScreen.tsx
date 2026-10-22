import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { io, type Socket } from "socket.io-client";
import { sizes, theme } from "../components/theme";
import { DEMO_UID, SERVER_URL } from "../config";
import { useLanguage } from "../context/language";
import { announce, resetAnnouncements } from "../lib/a11y";
import { EncodedPlayer, Player, PulseCue, Recorder } from "../lib/audio";

interface Msg {
  id: number;
  role: "user" | "model" | "sys" | "tool";
  text: string;
}

// idle  → nothing running; big button says "Start conversation"
// connecting → socket opening / Gemini session starting
// live  → connected + mic open; a continuous live conversation (server VAD +
//         barge-in handle turn-taking). Big button says "End conversation".
type Phase = "idle" | "connecting" | "live";

export function AssistantScreen() {
  // Language is chosen app-wide (Home) and fixed on the server when the socket
  // connects — so we read it here and use it for the next session the user
  // starts. See context/language.tsx.
  const { language } = useLanguage();
  const isTwi = language === "tw";

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState(
    "Tap the button to start talking with the assistant."
  );
  const [speaking, setSpeaking] = useState(false);
  // Twi has no live VAD: after "Finish speaking" the user waits for the server
  // to transcribe + reply. That gap is a loading state (not listening, not
  // speaking) we signal audibly — see the PulseCue effect below.
  const [waiting, setWaiting] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const playerRef = useRef<Player | null>(null);
  const ttsRef = useRef<EncodedPlayer | null>(null);
  // Audible "working…" cue for loading states a blind user can't see a spinner for.
  const cueRef = useRef<PulseCue | null>(null);
  const idRef = useRef(0);
  const curUser = useRef<number | null>(null);
  const curModel = useRef<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // True while the user is intentionally ending, so the socket's own
  // "disconnect" event doesn't announce "ended" a second time.
  const endingRef = useRef(false);

  useEffect(() => {
    resetAnnouncements();
    cueRef.current = new PulseCue();
    return () => {
      teardown();
      cueRef.current?.close();
      cueRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive the loading cue: the assistant is "working but silent" while the
  // socket/Gemini session is opening (connecting) or, in Twi, while a reply is
  // being prepared (waiting). Suppress it whenever real audio is playing so the
  // two never talk over each other.
  const loading = (phase === "connecting" || waiting) && !speaking;
  useEffect(() => {
    if (loading) cueRef.current?.start();
    else cueRef.current?.stop();
  }, [loading]);

  function push(role: Msg["role"], text: string): number {
    const id = idRef.current++;
    setMessages((m) => [...m, { id, role, text }]);
    return id;
  }
  function appendTo(id: number, text: string) {
    setMessages((m) =>
      m.map((x) => (x.id === id ? { ...x, text: x.text + text } : x))
    );
  }
  function setAndSay(s: string) {
    setStatus(s);
    announce(s);
  }

  function teardown() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    ttsRef.current?.close();
    ttsRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
  }

  // ── One tap: open the connection AND the mic, entering interactive mode ──
  async function startSession() {
    if (phase !== "idle") return;
    const ok = await Recorder.ensurePermission();
    if (!ok) {
      setAndSay("Microphone permission is needed to talk to the assistant.");
      return;
    }
    teardown();
    setMessages([]);
    curUser.current = null;
    curModel.current = null;
    setWaiting(false);
    endingRef.current = false;
    setPhase("connecting");
    setAndSay("Connecting…");

    const player = new Player();
    player.onPlayingChange = setSpeaking;
    playerRef.current = player;

    const tts = new EncodedPlayer();
    tts.onPlayingChange = setSpeaking;
    ttsRef.current = tts;

    const socket = io(SERVER_URL + "/assistant-live", {
      auth: { uid: DEMO_UID, language },
      transports: ["websocket"],
    });
    socketRef.current = socket;

    socket.on("connect", () => setAndSay("Connected. Starting assistant…"));
    socket.on("ready", () => void goLive());
    socket.on("audio", (p: { data: string }) => playerRef.current?.enqueue(p.data));
    socket.on("tts_audio", (p: { data: string }) =>
      ttsRef.current?.play(p.data).catch(() => {})
    );
    socket.on("transcript", (p: { role: "user" | "model"; text: string }) => {
      setWaiting(false); // the reply has started arriving
      if (p.role === "user") {
        if (curUser.current == null) curUser.current = push("user", p.text);
        else appendTo(curUser.current, p.text);
      } else {
        if (curModel.current == null) curModel.current = push("model", p.text);
        else appendTo(curModel.current, p.text);
      }
    });
    socket.on("tool", (p: { name: string }) => push("tool", `Working on ${p.name}…`));
    socket.on("interrupted", () => {
      // Barge-in (English server VAD): the user started talking over the reply.
      playerRef.current?.flush();
      ttsRef.current?.flush();
    });
    socket.on("turn_complete", () => {
      setWaiting(false);
      curUser.current = null;
      curModel.current = null;
    });
    socket.on("error", (e: { message?: string } | string) => {
      const msg = typeof e === "string" ? e : e?.message ?? "error";
      setWaiting(false);
      push("sys", msg);
      setAndSay("Error: " + msg);
    });
    socket.on("disconnect", (r) => {
      // Ignore the disconnect we caused ourselves (endSession handles the UI).
      if (endingRef.current) return;
      setPhase("idle");
      setSpeaking(false);
      setWaiting(false);
      setAndSay("Conversation ended. " + (typeof r === "string" ? r : ""));
    });
  }

  // Server session is ready → open the mic and keep it open for the whole
  // session. In English the Live API's server VAD + barge-in segment turns
  // automatically, so the conversation is fully hands-free. In Twi there is no
  // live VAD (the server buffers the mic and transcribes on audio_end), so a
  // "Finish turn" control sends that signal — see finishTurn().
  async function goLive() {
    const socket = socketRef.current;
    if (!socket) return;
    try {
      const rec = new Recorder();
      await rec.start((b64) => socket.emit("audio", { data: b64 }));
      recorderRef.current = rec;
      setPhase("live");
      setAndSay(
        isTwi
          ? "Ready. Speak, then tap ‘Finish speaking’ to send."
          : "Listening. Just speak — you can talk over the assistant to interrupt."
      );
    } catch (e) {
      setAndSay("Mic error: " + (e instanceof Error ? e.message : String(e)));
      endSession();
    }
  }

  // ── One tap: end the live session ──
  function endSession() {
    if (endingRef.current) return;
    endingRef.current = true;
    // Flush any buffered Twi utterance before closing, so nothing is left hanging.
    if (isTwi) socketRef.current?.emit("audio_end");
    teardown();
    setPhase("idle");
    setSpeaking(false);
    setWaiting(false);
    setAndSay("Conversation ended. Tap to start again.");
  }

  // Twi only: mark the end of the user's spoken turn (server runs ASR → reply).
  function finishTurn() {
    ttsRef.current?.flush(); // no live barge-in in Twi
    socketRef.current?.emit("audio_end");
    setWaiting(true); // reply is being prepared → audible loading cue
    setAndSay("Sent. Waiting for a reply…");
  }

  const live = phase === "live";
  const connecting = phase === "connecting";

  return (
    <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
      <ScrollView
        ref={scrollRef}
        style={styles.convo}
        contentContainerStyle={styles.convoContent}
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: true })
        }
      >

        {messages.map((m) => (
          <View key={m.id} style={[styles.bubble, bubbleStyle(m.role)]}>
            <Text style={styles.bubbleRole}>{roleLabel(m.role)}</Text>
            <Text style={styles.bubbleText}>{m.text}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.dock}>
        <Text
          style={styles.status}
          accessibilityLiveRegion="polite"
          accessibilityRole="text"
        >
          {live && speaking ? "🔊 Assistant is speaking…" : status}
        </Text>

        {/* Twi only: an explicit end-of-turn tap (no live VAD in Twi). */}
        {live && isTwi && (
          <Pressable
            onPress={finishTurn}
            style={({ pressed }) => [
              styles.finish,
              { opacity: pressed ? 0.8 : 1 },
            ]}
            accessible
            accessibilityRole="button"
            accessibilityLabel="Finish speaking"
            accessibilityHint="Sends what you just said and waits for the assistant's reply."
          >
            <Text style={styles.finishText}>✓ Finish speaking</Text>
          </Pressable>
        )}

        {/* The single primary control: start the session, or end it. */}
        <Pressable
          onPress={live ? endSession : startSession}
          disabled={connecting}
          style={({ pressed }) => [
            styles.main,
            {
              backgroundColor: live ? theme.alert : theme.assistant,
              opacity: connecting ? 0.5 : pressed ? 0.85 : 1,
            },
          ]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={
            live
              ? "End conversation"
              : connecting
              ? "Connecting"
              : "Start conversation"
          }
          accessibilityHint={
            live
              ? "Hangs up and closes the microphone."
              : "Connects to the assistant and opens the microphone so you can talk."
          }
          accessibilityState={{ disabled: connecting, busy: connecting }}
        >
          <Text style={styles.mainEmoji}>{live ? "⏹️" : connecting ? "⏳" : "🎙️"}</Text>
          <Text style={styles.mainText}>
            {live
              ? "End conversation"
              : connecting
              ? "Connecting…"
              : "Start conversation"}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function roleLabel(r: Msg["role"]) {
  return r === "user" ? "You" : r === "model" ? "Assistant" : r === "tool" ? "…" : "Note";
}
function bubbleStyle(r: Msg["role"]) {
  if (r === "user") return { backgroundColor: "#1E2A33", alignSelf: "flex-end" as const };
  if (r === "model") return { backgroundColor: "#19241C", alignSelf: "flex-start" as const };
  return { backgroundColor: theme.surface, alignSelf: "center" as const };
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  convo: { flex: 1 },
  convoContent: { padding: 16, gap: 12 },
  hint: { color: theme.textDim, fontSize: sizes.body, textAlign: "center", marginTop: 24 },
  bubble: { maxWidth: "90%", borderRadius: 18, padding: 14 },
  bubbleRole: { color: theme.textDim, fontSize: 14, marginBottom: 4, fontWeight: "700" },
  bubbleText: { color: theme.text, fontSize: sizes.body },
  dock: { padding: 16, gap: 14, borderTopWidth: 1, borderTopColor: theme.border },
  status: { color: theme.textDim, fontSize: sizes.body, textAlign: "center" },
  finish: {
    minHeight: 72,
    borderRadius: sizes.radius,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface,
    borderWidth: 2,
    borderColor: theme.assistant,
  },
  finishText: { fontSize: sizes.heading, fontWeight: "800", color: theme.text },
  main: {
    minHeight: 150,
    borderRadius: sizes.radius,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  mainEmoji: { fontSize: 56 },
  mainText: { fontSize: sizes.tileTitle, fontWeight: "800", color: theme.onAccent },
});
