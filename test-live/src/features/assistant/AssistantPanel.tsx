import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useAuth } from "../../context/AuthContext";
import { useLog, sizeOf } from "../../context/LogContext";
import { Recorder, Player } from "../../lib/audio";

interface Msg {
  id: number;
  role: "user" | "model" | "sys" | "tool" | "srcs";
  text: string;
}

export function AssistantPanel({ serverUrl }: { serverUrl: string }) {
  const { uid } = useAuth();
  const { log } = useLog();

  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState("Not connected.");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [textIn, setTextIn] = useState("");

  const socketRef = useRef<Socket | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const playerRef = useRef<Player | null>(null);
  const idRef = useRef(0);
  const curUser = useRef<number | null>(null);
  const curModel = useRef<number | null>(null);
  const convoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = convoRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => teardown(), []); // cleanup on unmount

  function push(role: Msg["role"], text: string): number {
    const id = idRef.current++;
    setMessages((m) => [...m, { id, role, text }]);
    return id;
  }
  function appendTo(id: number, text: string) {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, text: x.text + text } : x)));
  }

  function teardown() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    setMicOn(false);
    setSpeaking(false);
    setReady(false);
    setConnected(false);
  }

  function connect() {
    if (!uid) {
      setStatus("Set a user UID first (Auth tab).");
      return;
    }
    teardown();
    setMessages([]);
    curUser.current = null;
    curModel.current = null;

    const player = new Player();
    player.onPlayingChange = setSpeaking;
    playerRef.current = player;

    const socket = io(serverUrl + "/assistant-live", {
      auth: { uid },
      transports: ["websocket"],
    });
    socketRef.current = socket;
    setStatus("Connecting…");

    socket.on("connect", () => {
      setConnected(true);
      setStatus("Socket connected — opening Gemini session…");
      log({ dir: "out", channel: "assistant-live", name: "connect" });
    });
    socket.on("ready", () => {
      setReady(true);
      setStatus("Ready. Start the mic or type a message.");
      log({ dir: "in", channel: "assistant-live", name: "ready" });
    });
    socket.on("audio", (p: { data: string; mimeType?: string }) => {
      playerRef.current?.enqueue(p.data);
      log({ dir: "in", channel: "assistant-live", name: "audio", meta: sizeOf(p.data) });
    });
    socket.on("transcript", (p: { role: "user" | "model"; text: string }) => {
      if (p.role === "user") {
        if (curUser.current == null) curUser.current = push("user", p.text);
        else appendTo(curUser.current, p.text);
      } else {
        if (curModel.current == null) curModel.current = push("model", p.text);
        else appendTo(curModel.current, p.text);
      }
      log({ dir: "in", channel: "assistant-live", name: `transcript:${p.role}`, meta: sizeOf(p.text) });
    });
    socket.on("tool", (p: { name: string }) => {
      push("tool", `🛠 running ${p.name}…`);
      log({ dir: "in", channel: "assistant-live", name: `tool:${p.name}` });
    });
    socket.on("sources", (p: { sources: string[] }) => {
      push("srcs", "Sources: " + p.sources.join(", "));
      log({ dir: "in", channel: "assistant-live", name: "sources", meta: `${p.sources.length}` });
    });
    socket.on("interrupted", () => {
      playerRef.current?.flush();
      push("sys", "⎚ interrupted (barge-in)");
      log({ dir: "in", channel: "assistant-live", name: "interrupted" });
    });
    socket.on("turn_complete", () => {
      curUser.current = null;
      curModel.current = null;
      log({ dir: "in", channel: "assistant-live", name: "turn_complete" });
    });
    socket.on("error", (e: { message?: string } | string) => {
      const msg = typeof e === "string" ? e : e?.message ?? "error";
      push("sys", "⚠ " + msg);
      setStatus("Error: " + msg);
      log({ dir: "in", channel: "assistant-live", name: "error", meta: msg, error: true });
    });
    socket.on("disconnect", (r) => {
      setStatus("Disconnected: " + r);
      log({ dir: "in", channel: "assistant-live", name: "disconnect", meta: String(r) });
      teardown();
    });
  }

  async function toggleMic() {
    const socket = socketRef.current;
    if (!socket || !ready) return;
    if (micOn) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      socket.emit("audio_end");
      log({ dir: "out", channel: "assistant-live", name: "audio_end" });
      setMicOn(false);
      setStatus("Mic off.");
      return;
    }
    try {
      const rec = new Recorder();
      await rec.start((b64) => {
        socket.emit("audio", { data: b64 });
        log({ dir: "out", channel: "assistant-live", name: "audio", meta: sizeOf(b64) });
      });
      recorderRef.current = rec;
      setMicOn(true);
      setStatus("Listening…");
    } catch (e) {
      setStatus("Mic error: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function sendText() {
    const t = textIn.trim();
    const socket = socketRef.current;
    if (!t || !socket || !ready) return;
    socket.emit("text", { text: t });
    log({ dir: "out", channel: "assistant-live", name: "text", meta: sizeOf(t) });
    push("user", t);
    setTextIn("");
  }

  return (
    <div className="stack">
      <div className="panel">
        <h2>
          Live voice assistant <span className="hint">/assistant-live</span>
        </h2>
        <div className="row tight">
          {!connected ? (
            <button className="primary" onClick={connect} disabled={!uid}>
              Connect
            </button>
          ) : (
            <button className="danger" onClick={teardown}>
              Disconnect
            </button>
          )}
          <button className={micOn ? "live" : ""} onClick={toggleMic} disabled={!ready}>
            {micOn ? "🔴 Listening — tap to stop" : "🎤 Talk"}
          </button>
          <span className="pill">{speaking ? "🔊 speaking" : ready ? "idle" : "—"}</span>
        </div>
        <div className="row">
          <input
            placeholder="…or type a message"
            value={textIn}
            disabled={!ready}
            onChange={(e) => setTextIn(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendText()}
          />
          <button onClick={sendText} disabled={!ready || !textIn.trim()} style={{ flex: "0 0 auto" }}>
            Send
          </button>
        </div>
        <div className="statusline">{status}</div>
      </div>

      <div className="panel">
        <div className="convo" ref={convoRef}>
          {messages.length === 0 && <div className="hint">Conversation transcript will appear here.</div>}
          {messages.map((m) => (
            <div key={m.id} className={"msg " + m.role}>
              {m.text}
            </div>
          ))}
        </div>
        <p className="hint" style={{ marginTop: ".5rem" }}>
          Try: “What should I take next?”, “What is paracetamol used for?”, or “Save a prescription”. Talk
          over the model to test barge-in.
        </p>
      </div>
    </div>
  );
}
