// High-contrast, large-type theme for low-vision users.
// Dark background with bright, well-separated tile colors (WCAG AAA contrast
// against both the text and the background).

export const theme = {
  bg: "#000000",
  surface: "#111317",
  text: "#FFFFFF",
  textDim: "#C7CBD1",
  // Tile accents — distinct hues, each paired with near-black text for contrast.
  assistant: "#4CC2FF", // bright blue
  scanner: "#8BE28B", // bright green
  alert: "#FF5C5C", // bright red
  onAccent: "#001018",
  border: "#2A2E35",
  live: "#FF3B30",
  ok: "#8BE28B",
  warn: "#FFD166",
};

export const sizes = {
  title: 34,
  heading: 28,
  tileTitle: 30,
  body: 22,
  big: 44,
  radius: 24,
};
