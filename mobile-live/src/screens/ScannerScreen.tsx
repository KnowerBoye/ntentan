import * as FileSystem from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from "react-native-vision-camera";
import { io, type Socket } from "socket.io-client";
import { sizes, theme } from "../components/theme";
import { DEMO_UID, LANGUAGE, SERVER_URL } from "../config";
import { announce, resetAnnouncements } from "../lib/a11y";
import { base64ToBytes } from "../lib/base64";
import { EncodedGuidancePlayer, GuidancePlayer } from "../lib/audio";

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

export function ScannerScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice("back");

  const [status, setStatus] = useState("Starting camera…");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const cameraRef = useRef<Camera>(null);
  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const pcmRef = useRef<GuidancePlayer | null>(null);
  const ttsRef = useRef<EncodedGuidancePlayer | null>(null);

  useEffect(() => {
    resetAnnouncements();
    (async () => {
      if (!hasPermission) {
        const ok = await requestPermission();
        if (!ok) {
          setStatus("Camera permission denied.");
          announce("Camera permission denied.");
          return;
        }
      }
      start();
    })();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPermission]);

  function start() {
    stop();
    setResult(null);

    const pcm = new GuidancePlayer();
    pcm.onPlayingChange = setSpeaking;
    pcmRef.current = pcm;
    const tts = new EncodedGuidancePlayer();
    tts.onPlayingChange = setSpeaking;
    ttsRef.current = tts;

    const socket = io(SERVER_URL + "/scanner-live", {
      auth: { uid: DEMO_UID, language: LANGUAGE },
      transports: ["websocket"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("Point the camera at a medicine label.");
      announce("Scanner ready. Point the camera at a medicine label.");
    });
    socket.on("response", (json: string) => {
      const r = JSON.parse(json) as ScanResult;
      setResult(r);
      // Speak each new guidance phrase; the audio cue plays too, but this also
      // covers the Twi path and keeps TalkBack in sync.
      if (r.status === "success") {
        const m = r.prescription_match?.medication;
        announce(m ? `Found ${m.name}. ${m.unitsPerDose} ${m.dosage}.` : "Label read, but no matching prescription on file.");
      } else if (r.guidance_text) {
        announce(r.guidance_text);
      }
    });
    socket.on("audio", (p: { data?: string }) => p?.data && pcmRef.current?.pushChunk(p.data));
    socket.on("speech_end", () => pcmRef.current?.endUtterance());
    socket.on("tts_audio", (p: { data?: string }) => p?.data && ttsRef.current?.play(p.data));
    socket.on("error", (e: { message?: string } | string) => {
      const msg = typeof e === "string" ? e : e?.message ?? "error";
      setStatus("Error: " + msg);
      announce("Error: " + msg);
    });
    socket.on("disconnect", (r) => setStatus("Disconnected: " + r));

    // Snapshot the preview ~1.5 fps and stream JPEG bytes; the server throttles
    // to its own tick, so an approximate rate is fine.
    timerRef.current = setInterval(() => void sendFrame(), 700);
  }

  async function sendFrame() {
    const socket = socketRef.current;
    const cam = cameraRef.current;
    if (!socket?.connected || !cam || busyRef.current) return;
    busyRef.current = true;
    try {
      const snap = await cam.takeSnapshot({ quality: 60 });
      const b64 = await FileSystem.readAsStringAsync("file://" + snap.path, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bytes = base64ToBytes(b64);
      socket.emit("frame", { buf: bytes.buffer });
      // Best-effort cleanup of the snapshot file.
      FileSystem.deleteAsync("file://" + snap.path, { idempotent: true }).catch(() => {});
    } catch {
      /* dropped frame — next tick will retry */
    } finally {
      busyRef.current = false;
    }
  }

  function stop() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    pcmRef.current?.close();
    pcmRef.current = null;
    ttsRef.current?.close();
    ttsRef.current = null;
    setSpeaking(false);
  }

  const match = result?.prescription_match;
  const success = result?.status === "success";
  const guidance =
    result?.status === "processing"
      ? "Processing…"
      : result?.guidance_text ?? "Point the camera at a medicine label.";

  return (
    <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
      <View style={styles.cameraWrap}>
        {device && hasPermission ? (
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={device}
            isActive
            photo
          />
        ) : (
          <Text style={styles.hint}>{status}</Text>
        )}
        {/* Large directional arrow overlay. */}
        {!!result?.instruction && result.instruction !== "none" && (
          <Text
            style={styles.arrow}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            {ARROWS[result.instruction] ?? ""}
          </Text>
        )}
      </View>

      <View style={styles.dock}>
        <Text
          style={[styles.guide, success && styles.guideOk]}
          accessibilityLiveRegion="assertive"
          accessibilityRole="text"
        >
          {speaking ? "🔊 " : ""}
          {guidance}
        </Text>
        {success && (
          <Text style={styles.match} accessibilityRole="text">
            {match
              ? `✅ ${match.medication.name} ${match.medication.strength ?? ""} — ${match.medication.unitsPerDose} ${match.medication.dosage}`
              : "Label read, but no matching prescription on file."}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  cameraWrap: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  hint: { color: theme.textDim, fontSize: sizes.body, padding: 24, textAlign: "center" },
  arrow: { fontSize: 140, textShadowColor: "#000", textShadowRadius: 12 },
  dock: {
    padding: 20,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    minHeight: 140,
    justifyContent: "center",
  },
  guide: { color: theme.text, fontSize: sizes.heading, fontWeight: "700", textAlign: "center" },
  guideOk: { color: theme.ok },
  match: { color: theme.textDim, fontSize: sizes.body, textAlign: "center" },
});
