// ─────────────────────────────────────────────
//  App configuration
//
//  This build is a single-user demo for a visually-impaired patient: there is
//  NO sign-in screen. The patient's Firebase UID is baked in here and sent to
//  the api-live server in dev UID mode (ALLOW_UID_AUTH=true on the server).
//
//  ⚠️  EDIT `DEMO_UID` BELOW with the real Firebase UID of the patient whose
//      prescriptions live in Firestore, then rebuild. Everything else works
//      against the deployed Cloud Run instance out of the box.
// ─────────────────────────────────────────────

/** The hardcoded patient UID. Replace with the real Firestore user id. */
export const DEMO_UID = "GgCTd5OjRWO5jTJrq9jvkjkk5LM2";

/**
 * Base URL of the api-live server.
 *  - Socket.IO namespaces: `${SERVER_URL}/assistant-live`, `${SERVER_URL}/scanner-live`
 *  - REST: `${SERVER_URL}/api/medical-alert/send`
 *
 * Defaults to the deployed Cloud Run instance (ALLOW_UID_AUTH is on there).
 * Point at a LAN IP like `http://192.168.x.x:8080` to use a local dev server.
 */
export const SERVER_URL = "https://ntentan-api-live-209385824341.us-west1.run.app";

/** Assistant / scanner language: "en" (English) or "tw" (Twi / Akan). */
export const LANGUAGE: "en" | "tw" = "en";

// ── Live API fixed audio formats (do not change) ──
export const INPUT_RATE = 16000; // mic capture → Gemini
export const OUTPUT_RATE = 24000; // Gemini / scanner audio out
