import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Tile } from "../components/Tile";
import { LanguageToggle } from "../components/LanguageToggle";
import { sizes, theme } from "../components/theme";
import type { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

export function HomeScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1} accessibilityRole="header">
          Ntentan
        </Text>
        <Text style={styles.sub}>Choose what you want to do.</Text>

        {/* One-column grid of large tiles: easy to reach, easy to hear. */}
        <View style={styles.grid}>
          <Tile
            title="Talk to assistant"
            subtitle="Ask about your medication"
            emoji="🎙️"
            color={theme.assistant}
            accessibilityHint="Opens the voice assistant. You can ask what to take next or about a medicine."
            onPress={() => navigation.navigate("Assistant")}
          />
          <Tile
            title="Scan medication"
            subtitle="Point the camera at a label"
            emoji="📷"
            color={theme.scanner}
            accessibilityHint="Opens the camera and speaks how to position the medicine, then names it."
            onPress={() => navigation.navigate("Scanner")}
          />
          <Tile
            title="Emergency alert"
            subtitle="Send your location for help"
            emoji="🚨"
            color={theme.alert}
            accessibilityHint="Sends an emergency text message with your location to your contacts."
            onPress={() => navigation.navigate("Alert")}
          />
        </View>

        {/* App-wide language choice. Takes effect when you next open a feature. */}
        <LanguageToggle />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 20, gap: 8, flexGrow: 1 },
  h1: { fontSize: sizes.big, fontWeight: "900", color: theme.text },
  sub: { fontSize: sizes.body, color: theme.textDim, marginBottom: 12 },
  grid: { flex: 1, gap: 16 },
});
