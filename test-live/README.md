# Ntentan · Live API Tester (`test-live`)

A Vite + React + TypeScript web app for exercising the **`api-live`** server
(the Gemini Live API edition of the Ntentan API). It drives every feature of
that server from a browser, with real Firebase sign-in and a raw event inspector.

## Features

- **🔑 Auth** — the `api-live` server runs in dev **UID mode**
  (`ALLOW_UID_AUTH=true`), so you authenticate with a raw **user UID** instead of
  a Firebase token. Type a UID directly, or sign in with Firebase (email/password
  + Google) to use that account's uid.
- **🎙 Assistant** (`/assistant-live`) — hold the mic to stream PCM audio, hear
  the model's spoken reply, watch the live transcript, tool-call status, sources,
  and barge-in (talk over the model to interrupt it).
- **📷 Scanner** (`/scanner-live`) — stream camera frames, see positioning
  guidance arrows and the matched prescription.
- **🚨 Alert** (`POST /api/medical-alert/send`) — send an emergency alert with
  coordinates (or your current location).
- **Raw event log** — a live timeline of every socket/HTTP message in and out,
  with direction, channel, event name, and payload size. Great for debugging the
  Live protocol.

## Setup

```bash
cd test-live
npm install
cp .env.example .env     # optional — only needed for Firebase sign-in
npm run dev              # http://localhost:5173
```

Make sure the `api-live` server is running (default `http://localhost:8080`) with
`ALLOW_UID_AUTH=true` in its env; set its URL in the header field if different.
Then open the **Auth** tab and enter a user UID (a `users/{uid}` document id in
the project's Firestore) to start testing.

### Firebase config (optional)

In UID mode you don't need Firebase at all — just type a UID. Firebase sign-in is
offered only as a convenient way to look up a real account's uid: fill
`VITE_FIREBASE_*` in `.env` with your project's **Web app** config (Firebase
console → Project settings → Your apps → Web) to enable the email/Google sign-in
buttons. Without it, the Auth tab shows just the UID field.

## Notes

- `localhost` is treated as a secure origin, so mic/camera and the Firebase SDK
  work over plain HTTP in dev. If you serve this from a LAN IP, use HTTPS or the
  browser will block `getUserMedia`.
- The server URL and the last manual token are persisted in `localStorage`.
- Audio formats are fixed by the Live API and handled in `src/lib/audio.ts`:
  mic is downsampled to 16 kHz PCM16; playback is 24 kHz PCM16.
