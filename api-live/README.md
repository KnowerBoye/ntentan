# Ntentan API — Live API edition (`api-live`)

A **separate, standalone** version of the Ntentan API that rebuilds the two
Gemini-powered features on top of the **[Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)**.

The base server (`../api`) was built before the Live API was public, so it
*simulated* real-time behaviour: the assistant was a stateless REST endpoint with
a hand-rolled STT → translate → `generateContent` → translate → TTS pipeline, and
the scanner hand-rolled streaming with a frame buffer + inference mutex. The Live
API is now GA and provides a single stateful WebSocket session with native audio
in/out, server-side voice-activity detection, barge-in, streaming video input, and
function calling — which is exactly what the old code approximated. This edition
uses it directly.

**All non-Gemini logic is reused verbatim** from the base server: Firebase auth,
Firestore access, the three assistant tools, embeddings/vector search, and the
mNotify SMS alert.

---

## What's different from `../api`

| Feature | `../api` (base) | `api-live` (this) |
| :------ | :-------------- | :---------------- |
| **Assistant** | `POST /api/assistant/chat` (+ SSE stream). Stateless, per-turn `generateContent` tool loop. Twi via Ghana NLP; English audio inlined per request. | **Socket.IO `/assistant-live`.** One Gemini Live session per socket: native audio in/out, server VAD, barge-in, live transcripts, same 3 tools. |
| **Scanner** | Socket.IO `/med-scanner`. Frame buffer + `isInferring` mutex + one `generateContent` per flush with enforced `responseSchema`. | **Socket.IO `/scanner-live`.** Frames stream into a Live video session; a tick nudges one guidance turn. Same Zod-validated wire contract; success path reuses the exact extraction + vector match. |
| **Medical alert** | `POST /api/medical-alert/send` | **Identical** — copied verbatim, no Gemini involved. |

---

## Authentication

By default both namespaces and the REST route require **Firebase JWT auth**
(socket handshake `auth.token` or `?token=`; REST `Authorization: Bearer`),
identical to the base server.

### ⚠️ Dev UID mode (`ALLOW_UID_AUTH=true`)

For local testing of the Live features, set `ALLOW_UID_AUTH=true` to make the
server trust a **raw user UID** instead of verifying a token:

- **Socket:** send `auth: { uid }` (or `?uid=` / still accepts `auth.token` as the uid).
- **REST:** send an `X-User-Id: <uid>` header (or a `Bearer <uid>`).

This **disables authentication** — any client can act as any user — so it must
**never** be enabled in production. Firestore access still uses
`FIREBASE_CREDENTIALS`; only token *verification* is skipped. The bundled
playgrounds and the `../test-live` app use this mode so you can connect with just
a UID.

## Wire protocol

### `/assistant-live`

```
client → server
  "audio"      { data }    base64 PCM 16-bit mono 16 kHz   (mic chunk)
  "text"       { text }    typed message
  "audio_end"              mic turned off

server → client
  "ready"                           Live session established
  "audio"      { data, mimeType }   model voice (base64 PCM 24 kHz)
  "transcript" { role, text }       "user" | "model" captions
  "tool"       { name }             a tool is running (UI status)
  "sources"    { sources }          citation URLs for a drug answer
  "interrupted"                     barge-in — flush local playback
  "turn_complete"
  "error"      { code, message }
```

### `/scanner-live`

```
client → server
  "frame"   { buf }    JPEG bytes (ArrayBuffer)

server → client
  "response"    <JSON string>       SAME discriminated union as ../api
                                    (processing | positioning | no_object | success)
  "audio"       { data, mimeType }  spoken-guidance chunk (base64 PCM 24 kHz) —
                                    the model voices the same text as guidance_text
  "speech_end"                      marks the end of one spoken cue
  "error"       { code, message }
```

The scanner keeps the user informed by **voice** through every state: the model
speaks the same short sentence it reports in `guidance_text`, and the server
relays those native-audio chunks on `"audio"`, closing each spoken cue with
`"speech_end"`.

Playback is **latest-wins without interruption**: a cue that is already playing
is allowed to finish, and any cues that arrive while it plays collapse to a
single slot holding only the newest — so when the current cue ends the freshest
guidance plays next and stale cues in between are skipped. This keeps the spoken
guidance both uninterrupted and current. (Contrast `/assistant-live`, which
streams audio chunk-by-chunk and flushes on barge-in.)

---

## Running locally

```bash
cd api-live
npm install
cp example.env .env   # then fill in the values
npm run dev           # http://localhost:8080
```

Serve a playground over any static server and open it, e.g.:

```bash
npx serve playground      # then open assistant-live.html / scanner-live.html
```

Paste a valid Firebase ID token, **Connect**, and talk. For the scanner, **Start
scanning** and point the camera at a medication label.

### Smoke test (no browser, no Firebase)

Verifies the Live model + tool wiring with just `GEMINI_API_KEY`:

```bash
npm run smoke
# ✓ PASS — model requested query_prescriptions
```

---

## Environment variables

Same as `../api`, plus three Live-specific ones (see `example.env`):

| Variable | Default | Purpose |
| :------- | :------ | :------ |
| `LIVE_ASSISTANT_MODEL` | `gemini-2.5-flash-native-audio-preview-09-2025` | Live model for the assistant (native audio = most natural voice). Alternatives on-key: `gemini-3.8-live`, `gemini-3.1-flash-live-preview`. |
| `LIVE_SCANNER_MODEL` | `gemini-3.1-flash-live-preview` | Live model for the scanner (flash-live cascade; handles TEXT + video). |

> Model availability is per API key. List the Live-capable models your key has with
> `GET https://generativelanguage.googleapis.com/v1beta/models?key=...` and pick ones
> whose `supportedGenerationMethods` include `bidiGenerateContent`.
| `LIVE_VOICE_NAME` | `Aoede` | Prebuilt voice for spoken replies. |

Model IDs are env-driven on purpose: the Live API line-up changes, so a new
preview can be rolled in without a code change.

---

## Known trade-offs / follow-ups

- **Scanner uses function calling, not a TEXT modality.** The current Live models
  are audio-output only — they reject a `TEXT` response modality — so the scanner
  can't stream JSON text. Instead the model reports each frame's assessment by
  calling a `report_guidance` tool whose parameters (schema-typed, enum-constrained)
  are the guidance fields. The server coerces the call args to the wire contract
  and still validates every emission through the unchanged Zod guard
  (`emitMedScannerResponse`), so the structured contract is identical to the base
  server. The audio modality (required by these models) is no longer discarded —
  the model is prompted to speak the guidance aloud and the server forwards it on
  `"audio"`, so the user is guided by voice as well as by the structured cues.
  This is the more experimental half of the port.
- **Twi is not wired into the live path.** Gemini native audio does not support
  Akan/Twi, so this edition ships English-native real-time voice. The Ghana NLP
  helpers (`voice.service.ts`) are carried over but unused on the live path. A Twi
  mode would need an out-of-band Ghana NLP STT→translate→Live(text)→translate→TTS
  bridge, which sacrifices the real-time feel — tracked as a follow-up.
- **One Live session per socket**, opened on connect and closed on disconnect.
  Errors flow through the base server's `emitSocketError` + structured `logger`.
```
