# Ntentan Mobile (Live) — accessible companion app

A **React Native (Expo)** phone app for a **visually-impaired patient** that drives
the [`api-live`](../api-live) server (the Gemini Live API edition of Ntentan).

Unlike the Flutter [`mobile`](../mobile) app, there is **no sign-in**: the patient's
Firebase UID is **hardcoded** and sent to the server in dev UID mode. The home
screen is a **large, high-contrast one-column grid** of three actions, and every
control is labelled and announced for **TalkBack (Android)** and **VoiceOver (iOS)**.

```
Home grid
 ├── 🎙️  Talk to assistant   → /assistant-live   (voice in/out, tap to start a live call, tap to end)
 ├── 📷  Scan medication      → /scanner-live     (camera frames → spoken positioning + match)
 └── 🚨  Emergency alert       → POST /api/medical-alert/send (GPS SMS to contacts)
```

## Before you run — set the patient UID

Edit **`src/config.ts`**:

```ts
export const DEMO_UID = "REPLACE_WITH_PATIENT_FIREBASE_UID"; // ← the real Firestore user id
export const SERVER_URL = "https://ntentan-api-live-rkf23yh2sq-uw.a.run.app"; // deployed Cloud Run
export const LANGUAGE = "en"; // or "tw" for Twi (Akan)
```

The server must be running with **`ALLOW_UID_AUTH=true`** (already the case on the
deployed Cloud Run instance). For a local server, set `SERVER_URL` to your Mac's LAN
IP, e.g. `http://192.168.1.20:8080` (not `localhost` — that's the phone itself).

## Run it

This app uses native modules (microphone PCM streaming, camera, Web-Audio playback),
so it needs a **dev build** — Expo Go will not work.

```bash
cd mobile-live
npm install
npx expo prebuild            # generates ios/ and android/
npm run android              # or: npm run ios   (needs Xcode / Android Studio + a device)
```

Then open the dev client on your device. If you change only JS afterwards,
`npm start` and reload is enough; re-run `prebuild`/`run` only after native changes.

> Versions in `package.json` target **Expo SDK 52 / RN 0.76**. If `npm install`
> warns about mismatches, run `npx expo install --fix` to reconcile the Expo-managed
> packages. New Architecture is **disabled** (`app.json → newArchEnabled: false`) for
> maximum compatibility with `react-native-audio-record`.

## Native dependencies & why

| Package | Role |
| :------ | :--- |
| `react-native-audio-record` | Mic → base64 **PCM16 @16 kHz** chunks (what the Live API wants), streamed to `/assistant-live`. |
| `react-native-audio-api` | Web-Audio-compatible `AudioContext` — plays streaming **PCM16 @24 kHz** and decodes GhanaNLP **WAV** (Twi). The player classes in `src/lib/audio.ts` are a near-direct port of the `test-live` web app. |
| `react-native-vision-camera` | Camera preview + ~1.5 fps JPEG snapshots streamed as frames to `/scanner-live`. |
| `expo-file-system` | Reads each camera snapshot file as base64 before sending its bytes. |
| `expo-location` | Current GPS fix for the emergency alert. |
| `socket.io-client` | Both Live namespaces (`websocket` transport; Cloud Run has session affinity). |
| `@react-navigation/*` | Screen stack; the native header announces each screen and gives a system Back button. |

## Wire protocol (matches `api-live`)

**`/assistant-live`** — handshake `auth: { uid, language }`.
Client → `audio {data}` (base64 PCM16 16k), `audio_end`, `text {text}`.
Server → `ready`, `audio {data}` (PCM16 24k), `tts_audio {data}` (WAV, Twi),
`transcript {role,text}`, `tool {name}`, `interrupted`, `turn_complete`, `error`.

**`/scanner-live`** — handshake `auth: { uid, language }`.
Client → `frame {buf}` (JPEG bytes, ArrayBuffer).
Server → `response` (JSON string: `status`/`instruction`/`guidance_text`/`prescription_match`),
`audio {data}` (PCM16 24k cue), `speech_end`, `tts_audio {data}` (WAV, Twi), `error`.

**`POST /api/medical-alert/send`** — header `X-User-Id: <uid>`, body `{latitude, longitude}`.

## Accessibility design

- **One-column grid** of 160 dp+ tiles; each is a single `accessibilityRole="button"`
  with a spoken label and hint. Emoji are marked decorative (`importantForAccessibility="no"`).
- **One tap to start, one tap to end** on the assistant — a tap opens the socket *and*
  the microphone for a continuous live call. In English the Live API's server VAD and
  barge-in handle turn-taking hands-free (talk over the reply to interrupt); no
  `audio_end` is sent mid-call. In Twi (no live VAD) a "Finish speaking" button appears
  to send `audio_end` per turn. A second tap ends the session.
- **Live regions**: the assistant status is `polite`; scanner guidance and alert status
  are `assertive` so new guidance / results interrupt and are read immediately.
- **`announce()`** (`src/lib/a11y.ts`) speaks state changes ("Listening", scan results,
  errors) via `AccessibilityInfo.announceForAccessibility`, de-duplicating repeats.
- **High-contrast dark theme**, large type (`src/components/theme.ts`), WCAG-AAA tile colors.

## Patches

Both are re-applied automatically by the `postinstall` hook (`patch-package`), so a
fresh `npm install` stays fixed.

- **`patches/react-native-audio-api+0.5.7.patch`** — adds `#include <cstddef>` and
  qualifies `std::size_t` in `core/Constants.h`; without it the iOS pod fails to
  compile (`unknown type name 'size_t'`).
- **`patches/react-native+0.76.9.patch`** — adds a `prepare_command` to
  `third-party-podspecs/fmt.podspec` that forces `FMT_USE_CONSTEVAL 0` in the fmt
  11.0.2 source. Xcode 16.3+/26's Clang rejects fmt's `consteval` format-string
  checks (`call to consteval function … is not a constant expression` in
  `format.cc`). A `-DFMT_USE_CONSTEVAL=0` build flag does **not** work — the header
  redefines the macro unconditionally — so the podspec rewrites the source instead.
  If you bump React Native, rename this patch to match the new version
  (`react-native+<version>.patch`) or regenerate it with
  `npx patch-package react-native --include 'third-party-podspecs/fmt.podspec'`.
  After editing it you may need `pod cache clean fmt --all` so CocoaPods re-runs the
  `prepare_command` instead of reusing a cached build.

## Known limitations / to verify on device

- Audio class APIs target **`react-native-audio-api` v0.x**; if the installed version
  renames a method (`copyToChannel` / `decodeAudioData`), adjust `src/lib/audio.ts`.
- `react-native-audio-record`'s `on()` may not return a removable subscription on every
  version — listener cleanup is best-effort (`?.remove?.()`).
- Scanner streams JPEG snapshots via `takeSnapshot`; frame rate is approximate and the
  server throttles to its own tick.
- Firebase token auth is **not** implemented here by design (single hardcoded UID demo).
