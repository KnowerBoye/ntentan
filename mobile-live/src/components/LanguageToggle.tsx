import { Pressable, StyleSheet, Text, View } from "react-native";
import { announce } from "../lib/a11y";
import { LANGUAGE_LABEL, useLanguage, type Language } from "../context/language";
import { sizes, theme } from "./theme";

// App-wide language chooser (English ⇄ Twi). A two-option segmented control:
// both choices are always visible so a user knows the current value and the
// alternative, and each is a large, clearly-labelled target. Language takes
// effect on the NEXT feature you open (it's fixed when a feature connects).
const OPTIONS: Language[] = ["en", "tw"];

export function LanguageToggle() {
  const { language, setLanguage } = useLanguage();

  return (
    <View style={styles.wrap}>
      <Text style={styles.label} accessibilityRole="header">
        Language
      </Text>
      <View
        style={styles.row}
        accessibilityRole="radiogroup"
        accessibilityLabel="App language"
      >
        {OPTIONS.map((opt) => {
          const selected = language === opt;
          return (
            <Pressable
              key={opt}
              onPress={() => {
                if (selected) return;
                setLanguage(opt);
                announce(`Language set to ${LANGUAGE_LABEL[opt]}`);
              }}
              style={({ pressed }) => [
                styles.option,
                selected && styles.optionActive,
                { opacity: pressed ? 0.85 : 1 },
              ]}
              accessible
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={LANGUAGE_LABEL[opt]}
              accessibilityHint={
                selected
                  ? "Currently selected language"
                  : `Switches the assistant and scanner to ${LANGUAGE_LABEL[opt]} next time you open them`
              }
            >
              <Text style={[styles.optionText, selected && styles.optionTextActive]}>
                {LANGUAGE_LABEL[opt]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  label: { fontSize: sizes.body, fontWeight: "800", color: theme.textDim },
  row: {
    flexDirection: "row",
    gap: 12,
  },
  option: {
    flex: 1,
    minHeight: 72,
    borderRadius: sizes.radius,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface,
    borderWidth: 2,
    borderColor: theme.border,
  },
  optionActive: {
    backgroundColor: theme.assistant,
    borderColor: theme.assistant,
  },
  optionText: { fontSize: sizes.heading, fontWeight: "800", color: theme.text },
  optionTextActive: { color: theme.onAccent },
});
