import * as Location from "expo-location";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { sizes, theme } from "../components/theme";
import { DEMO_UID, SERVER_URL } from "../config";
import { announce } from "../lib/a11y";

type Phase = "idle" | "sending" | "sent" | "error";

export function AlertScreen() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState(
    "Press the button to send your location to your emergency contacts."
  );

  function say(d: string) {
    setDetail(d);
    announce(d);
  }

  async function sendAlert() {
    if (phase === "sending") return;
    setPhase("sending");
    say("Getting your location…");

    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        setPhase("error");
        say("Location permission denied. Cannot send your position.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const body = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      };
      say("Sending alert…");

      const res = await fetch(SERVER_URL + "/api/medical-alert/send", {
        method: "POST",
        headers: { "X-User-Id": DEMO_UID, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Server returned ${res.status}. ${text}`.trim());
      }
      setPhase("sent");
      say("Alert sent. Your contacts have your location. Help is on the way.");
    } catch (e) {
      setPhase("error");
      say("Could not send the alert. " + (e instanceof Error ? e.message : String(e)));
    }
  }

  const busy = phase === "sending";

  return (
    <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
      <View style={styles.wrap}>
        <Pressable
          onPress={sendAlert}
          disabled={busy}
          style={({ pressed }) => [
            styles.sos,
            { opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
          ]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={busy ? "Sending alert" : "Send emergency alert"}
          accessibilityHint="Sends a text message with your current location to your emergency contacts."
          accessibilityState={{ disabled: busy, busy }}
        >
          <Text style={styles.sosEmoji}>🚨</Text>
          <Text style={styles.sosText}>
            {busy ? "Sending…" : phase === "sent" ? "Sent ✓" : "Send alert"}
          </Text>
        </Pressable>

        <Text
          style={[styles.detail, phase === "error" && styles.err, phase === "sent" && styles.ok]}
          accessibilityLiveRegion="assertive"
          accessibilityRole="text"
        >
          {detail}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  wrap: { flex: 1, padding: 24, gap: 28, alignItems: "center", justifyContent: "center" },
  sos: {
    width: "100%",
    aspectRatio: 1,
    maxHeight: 380,
    borderRadius: 1000,
    backgroundColor: theme.alert,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  sosEmoji: { fontSize: 96 },
  sosText: { fontSize: sizes.big, fontWeight: "900", color: theme.onAccent },
  detail: { color: theme.text, fontSize: sizes.heading, textAlign: "center", lineHeight: 36 },
  ok: { color: theme.ok },
  err: { color: theme.live },
});
