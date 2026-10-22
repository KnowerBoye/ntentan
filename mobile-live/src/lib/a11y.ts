import { AccessibilityInfo } from "react-native";

// Spoken announcements for TalkBack (Android) / VoiceOver (iOS).
// Use `announce` for state changes the user must hear even when focus has not
// moved — "Listening", "Connected", a scan result, an error.

let lastAnnouncement = "";

/**
 * Speak a message through the active screen reader. De-duplicates consecutive
 * identical messages so a repeated status (e.g. the same guidance cue) is not
 * read over and over.
 */
export function announce(message: string): void {
  if (!message || message === lastAnnouncement) return;
  lastAnnouncement = message;
  AccessibilityInfo.announceForAccessibility(message);
}

/** Reset the de-dupe memory, e.g. when leaving/entering a screen. */
export function resetAnnouncements(): void {
  lastAnnouncement = "";
}
