import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useAuth } from "../../context/AuthContext";
import { useLog, sizeOf } from "../../context/LogContext";
import { GuidancePlayer } from "../../lib/audio";

const ARROWS: Record<string, string> = {
  move_up: "⬆️",
  move_down: "⬇️",
  move_left: "⬅️",
  move_right: "➡️",
  rotate_left: "↺",
  rotate_right: "↻",
  flip: "🔄",
  move_closer: "➕",
  move_farther: "➖",
  hold_still: "✋",
  none: "",
};

interface ScanResult {
  status: "processing" | "positioning" | "no_object" | "success";
  instruction?: string;
  guidance_text?: string;
  prescription_match?: {
    medication: { name: string; strength?: string; dosage: string; unitsPerDose: number };
    distance: number;
    withinThreshold: boolean;
  } | null;
}

export function ScannerPanel({ serverUrl }: { serverUrl: string }) {
  const { uid } = useAuth();
  const { log } = useLog();

  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("Idle.");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  // Plays the scanner's spoken guidance: lets the current cue finish, then jumps
  // to the latest queued cue (24 kHz PCM16, same format as the assistant).
  const playerRef = useRef<GuidancePlayer | null>(null);

  useEffect(() => () => stop(), []);

  async function start() {
    if (!uid) {
      setStatus("Set a user UID first (Auth tab).");
      return;
    }
    stop();
    setResult(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (e) {
      setStatus("Camera error: " + (e instanceof Error ? e.message : String(e)));
      return;
    }

    const player = new GuidancePlayer();
    player.onPlayingChange = (p) => setSpeaking(p);
    playerRef.current = player;

    const socket = io(serverUrl + "/scanner-live", { auth: { uid }, transports: ["websocket"] });
    socketRef.current = socket;
    setStatus("Connecting…");

    socket.on("connect", () => {
      setScanning(true);
      setStatus("Streaming frames…");
      log({ dir: "out", channel: "scanner-live", name: "connect" });
    });
    socket.on("response", (json: string) => {
      const r = JSON.parse(json) as ScanResult;
      setResult(r);
      log({ dir: "in", channel: "scanner-live", name: `response:${r.status}`, meta: sizeOf(json) });
    });
    socket.on("audio", (p: { data?: string }) => {
      if (!p?.data) return;
      playerRef.current?.pushChunk(p.data);
      log({ dir: "in", channel: "scanner-live", name: "audio", meta: sizeOf(p.data) });
    });
    socket.on("speech_end", () => {
      playerRef.current?.endUtterance();
      log({ dir: "in", channel: "scanner-live", name: "speech_end" });
    });
    socket.on("error", (e: { message?: string } | string) => {
      const msg = typeof e === "string" ? e : e?.message ?? "error";
      setStatus("Error: " + msg);
      log({ dir: "in", channel: "scanner-live", name: "error", meta: msg, error: true });
    });
    socket.on("disconnect", (r) => {
      setStatus("Disconnected: " + r);
      log({ dir: "in", channel: "scanner-live", name: "disconnect", meta: String(r) });
    });

    // Stream ~1.5 fps; the server throttles to its own tick.
    timerRef.current = window.setInterval(() => {
      const v = videoRef.current;
      if (!socket.connected || !v || !v.videoWidth) return;
      const c = canvasRef.current;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")!.drawImage(v, 0, 0);
      c.toBlob(
        (blob) => {
          if (!blob) return;
          blob.arrayBuffer().then((buf) => {
            socket.emit("frame", { buf });
            log({ dir: "out", channel: "scanner-live", name: "frame", meta: sizeOf(new Uint8Array(buf)) });
          });
        },
        "image/jpeg",
        0.8
      );
    }, 650);
  }

  function stop() {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    setSpeaking(false);
    setScanning(false);
  }

  const match = result?.prescription_match;

  return (
    <div className="stack">
      <div className="panel">
        <h2>
          Live scanner <span className="hint">/scanner-live</span>
        </h2>
        <div className="row tight">
          {!scanning ? (
            <button className="primary" onClick={start} disabled={!uid}>
              Start scanning
            </button>
          ) : (
            <button className="danger" onClick={stop}>
              Stop
            </button>
          )}
          <span className="pill">{status}</span>
          {speaking && <span className="pill">🔊 speaking…</span>}
        </div>
      </div>

      <div className="panel">
        <video ref={videoRef} playsInline muted />
        <div className="instr">{result ? ARROWS[result.instruction ?? "none"] : ""}</div>
        <div className={"guide" + (result?.status === "success" ? " ok" : "")}>
          {result?.status === "processing"
            ? "Processing frame…"
            : result?.guidance_text ?? "Point the camera at a medication label."}
        </div>
        {result?.status === "success" && (
          <div className="match">
            {match ? (
              <>
                ✅ <b>{match.medication.name}</b> {match.medication.strength ?? ""} —{" "}
                {match.medication.unitsPerDose} {match.medication.dosage}
                <br />
                <span className="hint">
                  distance {match.distance.toFixed(3)} ·{" "}
                  {match.withinThreshold ? "confident match" : "below threshold"}
                </span>
              </>
            ) : (
              <span style={{ color: "var(--warn)" }}>Label read, but no matching prescription on file.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
