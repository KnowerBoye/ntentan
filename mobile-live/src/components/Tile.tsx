import { Pressable, StyleSheet, Text, View } from "react-native";
import { sizes, theme } from "./theme";

export function Tile({
  title,
  subtitle,
  emoji,
  color,
  accessibilityHint,
  onPress,
}: {
  title: string;
  subtitle: string;
  emoji: string;
  color: string;
  accessibilityHint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.tile,
        { backgroundColor: color, opacity: pressed ? 0.75 : 1 },
      ]}
      onPress={onPress}
      // One big touch target. TalkBack reads: "<title>, <subtitle>. Button.
      // <hint>". Double-tap activates.
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityHint={accessibilityHint}
    >
      {/* Emoji is decorative; the label already describes the tile. */}
      <Text style={styles.emoji} accessibilityElementsHidden importantForAccessibility="no">
        {emoji}
      </Text>
      <View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minHeight: 160,
    borderRadius: sizes.radius,
    padding: 24,
    justifyContent: "center",
    gap: 10,
  },
  emoji: { fontSize: 56 },
  title: { fontSize: sizes.tileTitle, fontWeight: "800", color: theme.onAccent },
  subtitle: { fontSize: sizes.body, color: theme.onAccent, opacity: 0.85 },
});
