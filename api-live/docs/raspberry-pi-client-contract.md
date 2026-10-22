# Ntentan Live — Raspberry Pi Client Contract & Build Plan

**Audience:** the engineer building the Raspberry Pi client.
**Server:** `api-live/` (Gemini Live API edition).
**Transport:** Socket.IO (not raw WebSocket).
**Status:** contract is derived verbatim from the running services —
`assistant-live.service.ts`, `scanner-live.service.ts`, `socket-auth.middleware.ts`,
`types/medscanner.ts`, `config/live.ts`, and the two reference clients
(`playground/*.html`, `test-live/src/lib/audio.ts`).
**2026-10-22:** scanner spoken-audio fix — if voice guidance is silent/choppy on
the Pi, read **§4.5** (root cause + the player change the Pi must make) and
**Appendix B** (Python pseudo-code).

The Pi is a **thin relay + I/O device**. It owns the microphone, the speaker, and
the camera. All intelligence (Gemini, VAD, tools, translation, TTS) lives on the
server. The Pi's job is: capture → encode → emit; and: receive → decode → play.

---

## 1. Architecture at a glance

```
            ┌─────────────────────────── Raspberry Pi ───────────────────────────┐
            │                                                                     │
  [Mic] ───▶│ capture 16kHz PCM16 ──▶ base64 ──▶ emit "audio"                     │
            │                                                                     │
 [Camera]──▶│ capture JPEG ~1.5fps ──────────────▶ emit "frame" {buf}            │
            │                                                                     │
[Speaker]◀──│ decode PCM 24kHz / WAV ◀── on "audio" / "tts_audio"                 │
            │                                                                     │
[Btn: FEAT]─│ toggle assistant ⇄ scanner  (reconnect to the other namespace)     │
[Btn: LANG]─│ toggle en ⇄ tw              (reconnect — language is handshake-bound)│
            │                                                                     │
            └──────────────────── Socket.IO over WS ─────────────────────────────┘
                                         │
                                         ▼
                        ┌──────────────────────────────┐
                        │   api-live server (:8080)     │
                        │  /assistant-live  /scanner-live│
                        │  Gemini Live  +  GhanaNLP(Twi) │
                        └──────────────────────────────┘
```

Two independent Socket.IO **namespaces**, one Gemini Live session per connected
socket:

| Feature   | Namespace         | Input from Pi            | Output to Pi                              |
|-----------|-------------------|--------------------------|-------------------------------------------|
| Assistant | `/assistant-live` | mic audio + typed text   | spoken reply, captions, tool/status, sources |
| Scanner   | `/scanner-live`   | camera JPEG frames       | positioning guidance + spoken cues        |

> There is also a plain REST surface (`/api/medical-alert`, `/api/prescriptions`,
> `/health`) — not needed for the mic/camera/speaker client, documented in §9 for
> completeness.

---

## 2. Connection mechanism

### 2.1 Use a Socket.IO client

Connect with a **Socket.IO** client library, not a bare WebSocket — the server is
a Socket.IO `Server` and expects the Socket.IO framing/handshake. On the Pi
(assuming a Python client) use `python-socketio`; for a Node client use
`socket.io-client`. Force the WebSocket transport (matches both reference
clients):

```python
# python-socketio example
import socketio
sio = socketio.Client()
sio.connect(
    "http://SERVER_HOST:8080",
    namespaces=["/assistant-live"],      # one namespace per session (see §5)
    transports=["websocket"],
    auth={"uid": DEVICE_UID,             # direct UID — demo, no tokens (see §2.3)
          "language": "en"},             # "en" | "tw"  — see §2.4
)
```

```js
// socket.io-client example
const socket = io("http://SERVER_HOST:8080/assistant-live", {
  transports: ["websocket"],
  auth: { uid: DEVICE_UID, language: "en" },
});
```

- **Base URL / port:** `http://<host>:<PORT>` where `PORT` defaults to `8080`
  (server reads `process.env.PORT`). CORS is `*`.
- **Namespace** is the path suffix: `/assistant-live` or `/scanner-live`.
- Connect to **one namespace at a time** (see the toggle design in §5).

### 2.2 Handshake lifecycle

1. Pi opens the socket with `auth` (token/uid + language).
2. `socketAuthMiddleware` verifies the credential. On failure the connection is
   rejected (`connect_error` on the client) with an `UnauthorizedError`.
3. On success, `socket.user.uid` is attached server-side and the handler opens a
   Gemini Live session.
4. **Assistant only:** the server emits **`ready`** once the Gemini session is
   open — wait for `ready` before sending audio/text.
   **Scanner** has no `ready` event; start streaming frames on `connect`.

### 2.3 Authentication — **direct UID, no tokens (locked decision)**

This is a **demo**: the device authenticates with a **raw user UID only** — there
are **no Firebase ID tokens, ever**. The server runs with `ALLOW_UID_AUTH=true`,
which makes the auth middleware trust the UID the Pi sends instead of verifying a
token.

- The Pi sends `auth.uid = <DEVICE_UID>` in the handshake (a fixed UID baked into
  the Pi's config, matching the user whose prescriptions the demo should show).
- The server reads it (first non-empty of `auth.uid`, `auth.token`, `?uid=`,
  `?token=`) and attaches `socket.user.uid` with no verification.
- There is **nothing to refresh and nothing to expire** — the connection is valid
  as long as the socket is open, so reconnection just re-sends the same UID.

> ⚠️ `ALLOW_UID_AUTH=true` disables authentication entirely — anyone can act as
> any user. That is acceptable for this demo only. If this ever ships for real,
> the UID path must be turned off and real Firebase ID tokens used instead; but
> that is explicitly **out of scope** here.

### 2.4 Language selection — **handshake-bound**

Language is read **once**, at connection time, from `auth.language` (or
`?language=`), normalized to `"en"` or `"tw"` (anything else → `"en"`).

> ⚠️ **There is no mid-session language-change event.** The language toggle button
> must **disconnect and reconnect** the socket with the new `auth.language`. See §5.

Language changes behavior on **both** namespaces:
- **English (`en`):** audio flows straight to/from Gemini native audio.
- **Twi (`tw`):** Gemini works in English internally; GhanaNLP does ASR/MT/TTS.
  This changes the wire shape (WAV `tts_audio` instead of streamed PCM `audio`)
  and the turn mechanics — see §3.4 and §4.4.

---

## 3. Assistant contract (`/assistant-live`)

Real-time voice medical assistant. The Pi streams mic audio (or typed text); the
server streams back the spoken reply, live captions, tool-running status, and
citation sources.

### 3.1 Client → server events

| Event        | Payload                     | Meaning |
|--------------|-----------------------------|---------|
| `audio`      | `{ data: <base64 PCM16> }`  | One chunk of mic audio. PCM 16-bit **mono 16 kHz** little-endian, base64-encoded. Send continuously while the mic is live. |
| `text`       | `{ text: <string> }`        | A typed message (alternative to voice). In Twi mode, treated as Twi and translated. |
| `audio_end`  | *(no payload)*              | Microphone turned off / end of utterance. **See §3.3 — semantics differ by language.** |

### 3.2 Server → client events

| Event          | Payload                                   | Pi action |
|----------------|-------------------------------------------|-----------|
| `ready`        | *(none)*                                  | Gemini session open — enable mic/text. |
| `audio`        | `{ data: <base64 PCM24>, mimeType }`      | **English** spoken reply chunk. PCM 16-bit **mono 24 kHz** LE. Decode & play back-to-back. |
| `tts_audio`    | `{ data: <base64 WAV>, mimeType:"audio/wav" }` | **Twi** spoken reply — a complete WAV clip (one per sentence). Decode & play in arrival order. |
| `transcript`   | `{ role: "user"\|"model", text }`         | Live caption. `user` = what you said, `model` = the reply. (Twi: captions are Twi; English is never shown.) |
| `tool`         | `{ name: <string> }`                      | A tool is running (e.g. `query_prescriptions`) — show a "thinking" status. |
| `sources`      | `{ sources: string[] }`                   | Citation URLs/labels backing a drug answer — show/log at turn end. |
| `interrupted`  | *(none)*                                  | **Barge-in** — user started talking over the reply. **Immediately flush/stop playback.** |
| `turn_complete`| *(none)*                                  | Reply finished. Reset per-turn caption state. |
| `error`        | `{ status:"error", code, message, details? }` | Show/log; see §7. |

### 3.3 Turn & microphone semantics (English)

The server enables **server-side VAD** and barge-in. The natural flow:

1. Wait for `ready`.
2. When the mic button engages, stream `audio` chunks continuously.
3. The server's VAD detects when the user stops → the model replies (`audio` +
   `transcript` + possibly `tool`/`sources`) → `turn_complete`.
4. If the user talks while the model is speaking, the server emits `interrupted`
   — the Pi must **flush playback** at once.
5. `audio_end` tells the server the mic was turned off (it forwards
   `audioStreamEnd`). Send it when the mic button disengages.

So in English, `audio_end` is a "mic off" signal, not a required per-turn
delimiter — VAD handles turn boundaries.

### 3.4 Turn & microphone semantics (Twi) — **different**

In Twi there is **no live VAD and no live barge-in** (Gemini never hears the
audio). The pipeline is turn-batched:

1. While the mic button is held, stream `audio` chunks as usual — the server
   **buffers** them, it does **not** stream them to Gemini.
2. When the mic button releases, the Pi **must emit `audio_end`.** This is what
   triggers the server pipeline: WAV-wrap → GhanaNLP ASR → translate → Gemini.
   **Without `audio_end`, nothing happens in Twi.**
3. The user caption (`transcript role:"user"`) is the Twi ASR text.
4. The reply arrives as **`tts_audio`** WAV clips (one per sentence, in order) plus
   `transcript role:"model"` Twi captions, then `turn_complete`.
5. Because there is no server barge-in, the Pi should **flush its own playback
   when the mic button is pressed** to start a new utterance.

> **Design implication:** Twi effectively requires **push-to-talk** (press =
> start streaming; release = `audio_end`). English can be push-to-talk or
> open-mic; push-to-talk is recommended on the Pi for a single predictable button
> behavior across both languages (just always send `audio_end` on release).

### 3.5 Playback discipline (assistant)

- **English `audio`:** a stream of PCM24 chunks. Schedule them gaplessly on a
  running time cursor (see `Player` in `test-live/src/lib/audio.ts`). On
  `interrupted`, stop all scheduled buffers immediately.
- **Twi `tts_audio`:** discrete WAV clips that must play **in order, back-to-back**
  (see `EncodedPlayer`). Serialize decode+schedule; flush the queue when a new
  user utterance starts.

---

## 4. Scanner contract (`/scanner-live`)

Live medication-label scanner. The Pi streams JPEG camera frames; the server
guides the user to position the label and, on a successful read, returns the
matched prescription. Voice cues accompany every state.

### 4.1 Client → server events

| Event   | Payload                        | Meaning |
|---------|--------------------------------|---------|
| `frame` | `{ buf: <ArrayBuffer/bytes> }` | One JPEG frame as **raw binary** (not base64). `mimeType image/jpeg`. Reference client encodes at quality ~0.8 and sends every **650 ms (~1.5 fps)**. The server throttles internally to ~1 fps, so there is no benefit to sending faster. |

There is **no** `audio` input and **no** `audio_end` on the scanner. Input is
video only. Just start emitting `frame` after `connect`.

### 4.2 Server → client events

| Event        | Payload                                       | Pi action |
|--------------|-----------------------------------------------|-----------|
| `response`   | **a JSON string** (see §4.3)                  | `JSON.parse` it, then render by `status`. **Note: this is a stringified JSON payload, not an object** — the server does `emit("response", JSON.stringify(...))`. |
| `audio`      | `{ data: <base64 PCM24>, mimeType }`          | **English** spoken cue chunk (same format as assistant). |
| `speech_end` | *(none)*                                       | Boundary marking the end of one spoken cue. Seal the current cue for playback. |
| `tts_audio`  | `{ data: <base64 WAV>, mimeType:"audio/wav" }`| **Twi** spoken cue — one complete WAV clip. |
| `error`      | `{ status:"error", code, message }`           | Show/log. |

### 4.3 The `response` payload (discriminated by `status`)

Parse the JSON string, switch on `status`:

```jsonc
// processing — a frame is being assessed; show a spinner
{ "status": "processing" }

// no_object — nothing to scan yet
{ "status": "no_object", "instruction": "none", "guidance_text": "Point the camera at a medication." }

// positioning — label visible but not readable; follow the instruction
{ "status": "positioning", "instruction": "move_closer", "guidance_text": "Move a little closer." }

// success — label read and matched
{
  "status": "success",
  "instruction": "none",
  "guidance_text": "Got it — Amoxicillin.",
  "prescription_match": {            // may be null if no DB match
    "medication": { "id": "...", "name": "Amoxicillin", "dosage": "...", "strength": "...",
                    "frequency": 2, "timeSlots": ["morning","evening"], "instruction": "...",
                    "unitsPerDose": 1, "composite_string": "...", "completedSlots": {},
                    "createdAt": "...", "updatedAt": "..." },
    "distance": 0.12,
    "withinThreshold": true
  }
}
```

`instruction` is one of:
`move_up`, `move_down`, `move_left`, `move_right`, `rotate_left`, `rotate_right`,
`flip`, `move_closer`, `move_farther`, `hold_still`, `none`.

The Pi should turn `instruction` into a visual/haptic/voice cue (arrow, LED,
etc.) and display `guidance_text`. In Twi, `guidance_text` is already Twi; the
spoken cue arrives separately as `tts_audio`.

### 4.4 Playback discipline (scanner) — **latest-wins, never interrupt**

Positioning cues arrive continuously (~1/s). The rule (mirrors `GuidancePlayer` /
`EncodedGuidancePlayer`):

- A cue that is **already playing is never cut off** — let it finish.
- Cues that arrive while one is playing collapse to a **single pending slot**
  holding only the **newest** — so when the current cue ends, the freshest
  guidance plays and stale ones are skipped.
- **English:** accumulate `audio` chunks; `speech_end` seals a cue. Play the
  sealed cue if idle, else store as the (newest) pending cue.
- **Twi:** each `tts_audio` is a self-contained WAV cue; apply the same
  latest-wins/no-interrupt rule.

This keeps the spoken guidance calm and in sync with on-screen state instead of
stuttering every tick.

### 4.5 Scanner spoken-audio — full approach (root cause → server fix → **the player the Pi must implement**)

> **Read this if scanner voice guidance is silent, choppy, or plays bursts of
> clicks.** This section documents the 2026-10-22 audio fix end-to-end: why it
> broke, what changed on the server (already deployed — the Pi gets it for free),
> and **the client-side change the Pi's Python player must make.**

#### 4.5.1 Why one nudge is **two turns** (the mental model)

The scanner is not a request/response API. The server holds a persistent Gemini
Live session and, ~once per second, "nudges" the model to assess the latest
camera frame. The model answers each nudge as **two (or more) turns**:

```
  nudge ──▶  Turn A: the report_guidance TOOL CALL   → server emits  "response" (JSON string)   [NO audio]
             Turn B: the SPOKEN cue                   → server emits  "audio" × N  then  "speech_end"
```

So **the structured guidance (`response`) and the spoken guidance (`audio` +
`speech_end`) arrive in separate turns.** Turn B's audio can lag Turn A by a
second or more — and for a `success` result (where the server runs label
extraction + a vector DB match before the model speaks) the spoken turn can lag
by **several seconds**.

#### 4.5.2 What was broken (symptoms on the Pi)

The model emits two things the Pi must never play:

1. **Empty "stub" audio parts** — when the model has nothing new to say (an
   unchanged cue) or a turn is cut short, it emits a flood of ~3-byte audio parts
   (base64 length `4`). These are silence/clicks, not speech.
2. An **interrupted** spoken turn when the *next* nudge fired while the model was
   still talking — the old server released its turn-gate too early, so the next
   nudge preempted the speech, truncating it and spraying more stubs.

Net effect on the client: `audio`/`speech_end` events arrived constantly, but
most carried empty stubs, and real cues were clipped. Any naive player either
sat silent or stuttered clicks.

#### 4.5.3 What the server now guarantees (the fix you inherit)

`scanner-live.service.ts` was changed so the Pi now receives a **clean** stream:

- **Stubs are dropped server-side** (`MIN_AUDIO_B64 = 64`): only real speech
  chunks are forwarded on `audio`, and `speech_end` is sent **only** after a real
  spoken cue — never for a silent/stub turn.
- **The turn-gate holds until the spoken turn finishes**, so the next nudge can no
  longer interrupt speech. A status-aware grace waits for the (late) spoken turn
  before allowing the next nudge: ~1.8 s for positioning/no_object, **5 s for
  success** (its speech arrives late).

**Contract the Pi can now rely on:** between two `speech_end` events you receive
the complete set of `audio` chunks for exactly one real spoken cue, in order, and
you will not receive `speech_end` for silence.

#### 4.5.4 The client-side fix — **what the Pi player must do**

The browser reference client (`test-live/src/lib/audio.ts`) needed one more fix
that the Pi must mirror in its own way:

> **Browser fix:** `GuidancePlayer` created its `AudioContext` lazily on the first
> chunk but **never called `ctx.resume()`**, so a context that started *suspended*
> (browser autoplay policy) stayed silent — audio was scheduled but never heard.
> The fix was to `resume()` the context in `ensure()`.
>
> **Pi equivalent:** there is no autoplay policy, but the same class of bug
> exists — **open and `.start()` the speaker output stream once at startup, before
> the first cue arrives.** Do **not** lazily open the output device on the first
> `audio` chunk; the open latency can swallow the start of the first cue. Keep one
> persistent 24 kHz / mono / int16 output stream for the whole session.

On top of that, the Pi must implement the **latest-wins, never-interrupt**
discipline from §4.4 and a **defensive stub drop** (belt-and-suspenders in case it
ever talks to an older server). Pseudo-code is in **Appendix B**.

#### 4.5.5 Summary of the rules the player encodes

| Rule | Why |
|------|-----|
| Accumulate `audio` chunks; **seal on `speech_end`** into one cue | audio and its boundary are separate events |
| A playing cue is **never interrupted** — let it finish | guidance should sound calm, not stutter |
| Cues sealed while one plays collapse to **one pending slot (newest wins)** | a live scanner only cares about the *freshest* instruction |
| **Drop** any `audio` chunk with base64 length `< 64` | defensive: never play silence/clicks (stubs) |
| **Pre-open** the 24 kHz int16 mono output stream at startup | don't lose the first cue to device-open latency (the Pi's `resume()` equivalent) |
| On `stop`/`disconnect`/mode-switch, **flush** pending + incoming | don't play stale guidance after the user moves on |

---

## 5. Button behavior & client state machine

Two physical buttons. Both map to **connection lifecycle**, because both feature
and language are fixed at handshake time.

### 5.1 FEATURE button (assistant ⇄ scanner)

Assistant and scanner are **separate namespaces with separate Gemini sessions**.
Run **one at a time**:

```
on FEATURE press:
  1. stop local I/O for the current mode (mic/camera), flush playback
  2. disconnect the current namespace socket
  3. connect the other namespace with the SAME auth.language
  4. assistant: wait for "ready" before enabling mic
     scanner:  start the frame loop on "connect"
```

(If a future requirement needs both live simultaneously, two sockets can coexist —
but the demo device should keep one active to conserve Pi CPU and Gemini
sessions.)

### 5.2 LANGUAGE button (en ⇄ tw)

Because `auth.language` is read only at the handshake:

```
on LANGUAGE press:
  1. flush playback, stop mic/camera
  2. disconnect the current socket
  3. reconnect the SAME namespace with the toggled auth.language
  4. resume (assistant: wait for "ready"; scanner: resume frame loop)
```

Persist the chosen language locally so a reconnect/restart keeps it.

### 5.3 MIC button (assistant mode) — recommended push-to-talk

```
on MIC down:  flush playback; start mic capture → stream "audio" chunks
on MIC up:    stop capture; emit "audio_end"
```

Sending `audio_end` on every release works for **both** languages (required for
Twi, harmless for English). This gives one consistent button behavior.

> In scanner mode the MIC button is unused (scanner has no audio input). The
> camera streams automatically while the scanner namespace is connected; you may
> optionally gate the frame loop behind the FEATURE being "on".

### 5.4 Suggested state model

```
States: DISCONNECTED → CONNECTING → READY(assistant) | STREAMING(scanner)
Vars:   feature ∈ {assistant, scanner},  language ∈ {en, tw}
Any (feature|language) change ⇒ tear down socket ⇒ CONNECTING with new auth.
```

---

## 6. Audio & media formats (authoritative)

Fixed by the Live API contract (`config/live.ts`) and the reference audio lib.

| Direction | Where | Format |
|-----------|-------|--------|
| **Mic → server** | `audio` `{data}` | PCM **16-bit, mono, 16 kHz**, little-endian, base64. `mimeType` the server applies: `audio/pcm;rate=16000`. |
| **Server → Pi (English voice)** | `audio` `{data}` | PCM **16-bit, mono, 24 kHz**, little-endian, base64. Streamed in chunks. |
| **Server → Pi (Twi voice)** | `tts_audio` `{data}` | **WAV** file, base64 (`audio/wav`). One clip per sentence/cue. Decode with any WAV decoder. |
| **Camera → server** | `frame` `{buf}` | **JPEG** bytes, **raw binary** (ArrayBuffer/bytes), ~quality 0.8, ~1.5 fps. |

Pi encoding notes:
- **Mic capture:** capture at the device's native rate, **downsample to 16 kHz
  mono**, convert float → PCM16, base64-encode each chunk. A ~4096-sample frame
  (≈256 ms at 16 kHz) is a reasonable chunk size (reference uses a 4096 script
  processor). On Linux use ALSA/`sounddevice`/`pyaudio` at 16 kHz mono directly to
  skip resampling.
- **Speaker playback:** English = reassemble PCM24 chunks into a continuous mono
  24 kHz stream. Twi = decode each WAV clip. Use a small scheduler/queue so clips
  play gaplessly and the latest-wins rules in §3.5 / §4.4 hold.
- **Camera:** grab frames with Picamera2/OpenCV, JPEG-encode, send the raw bytes
  as `buf`. Do **not** base64 the frame — Socket.IO carries binary natively; the
  server base64s it internally.

---

## 7. Errors, disconnects & reconnection

- **`error` event** payload: `{ status:"error", code, message, details? }`.
  `code` is an app error code (e.g. `INTERNAL_ERROR`, external-service failures
  from Gemini/GhanaNLP). `details` only present in non-production. Surface briefly
  to the user and keep the session unless it's fatal.
- **Auth rejection** surfaces as a Socket.IO `connect_error` (not an `error`
  event) — the middleware rejected the handshake. With UID auth the only cause is
  a missing `auth.uid`, or the server not running with `ALLOW_UID_AUTH=true`.
- **Disconnects:** handle the Socket.IO `disconnect` event — stop mic/camera,
  flush playback, show status. Implement **auto-reconnect with backoff**; on
  reconnect, re-send the same `auth` (fixed UID — nothing to refresh) and for the
  assistant wait for `ready` again.
- **Gemini/GhanaNLP hiccups:** the server emits `error` and keeps the socket;
  the Pi can simply continue (next utterance / next frame). The scanner has a
  server-side turn watchdog, so transient stalls self-recover.

---

## 8. Environment / config the Pi needs

The Pi client itself needs only:

| Config | Value |
|--------|-------|
| `SERVER_URL` | `http://<host>:8080` (or your deployed URL) |
| `NAMESPACE` | `/assistant-live` or `/scanner-live` (toggled) |
| `AUTH` | `{ uid: DEVICE_UID }` — fixed, no tokens |
| `LANGUAGE` | `en` or `tw` (toggled, persisted) |

Relevant **server** env (for whoever runs api-live for the demo):
`PORT` (8080), **`ALLOW_UID_AUTH=true` (required — the Pi uses UID auth)**, `GEMINI_API_KEY`,
`GHNLP_API_KEY` + `GHNLP_TTS_VOICE` (Twi), Firebase credentials,
`LIVE_ASSISTANT_MODEL` / `LIVE_SCANNER_MODEL` / `LIVE_VOICE_NAME`.
Twi scanner also needs the pre-baked assets (`assets/twi-guidance/`, built via
`npm run build:twi-guidance`).

---

## 9. REST surface (not required for the mic/camera/speaker client)

For completeness — these are plain HTTP, Firebase-auth (`Authorization: Bearer
<token>`, or dev UID mode), and may be useful for a companion screen on the Pi:

- `GET  /health` → `{ status:"ok", mode:"live" }` (no auth) — good for a
  connectivity check on boot.
- `GET/POST/PATCH/DELETE /api/prescriptions`, `GET /api/prescriptions/today`,
  `POST /api/prescriptions/:id/taken` — medication management (caregiver portal).
- `/api/medical-alert` — SMS medical-alert feature.

If a Postman collection is wanted for these REST endpoints (mocking/testing),
that can be generated separately — the real-time Socket.IO surface above is not a
good fit for Postman's HTTP tooling, which is why this plan is a written contract.

---

## 10. Build checklist for the Pi

1. **Connectivity:** Socket.IO client connects to `/assistant-live` with dev
   `auth.uid`, receives `ready`. Hit `GET /health` on boot.
2. **Speaker:** play a test PCM24 stream and a test WAV clip; verify gapless
   scheduling + flush.
3. **Mic:** capture → 16 kHz mono PCM16 → base64 → `audio`; push-to-talk with
   `audio_end` on release. Verify English reply plays and `interrupted` flushes.
4. **Twi assistant:** reconnect with `language:"tw"`; verify `audio_end` triggers
   a reply and `tts_audio` WAV clips play in order; captions are Twi.
5. **Scanner:** reconnect to `/scanner-live`; stream JPEG `frame` ~1.5 fps; parse
   the `response` **string**; render positioning/ success; play `audio`+`speech_end`
   cues (latest-wins). Verify Twi `tts_audio` cues.
6. **Buttons:** FEATURE reconnects to the other namespace; LANGUAGE reconnects
   with toggled language; both flush I/O cleanly.
7. **Resilience:** auto-reconnect with backoff (re-send the same fixed UID);
   graceful handling of `error` and `disconnect`.

---

### Appendix A — event cheat-sheet

```
/assistant-live
  → audio {data b64 PCM16/16k}   → text {text}   → audio_end
  ← ready   ← audio {data b64 PCM24}   ← tts_audio {data b64 WAV}   (Twi)
  ← transcript {role,text}   ← tool {name}   ← sources {sources[]}
  ← interrupted   ← turn_complete   ← error {status,code,message}

/scanner-live
  → frame {buf: JPEG bytes}
  ← response "<JSON string>"   ← audio {data b64 PCM24}   ← speech_end
  ← tts_audio {data b64 WAV}   (Twi)   ← error {status,code,message}
```

---

### Appendix B — scanner spoken-audio player (Python pseudo-code)

Implements §4.4 + §4.5 for the Pi: one **pre-opened** 24 kHz/int16/mono output
stream (the `resume()` equivalent), **defensive stub drop**, and **latest-wins,
never-interrupt** cue playback. Pseudo-code — adapt to your audio stack
(`sounddevice`, `pyaudio`, or ALSA). The key *behaviours* are what matter, not the
exact library calls.

```python
import base64, json, threading
import numpy as np
import sounddevice as sd            # or pyaudio / alsaaudio

OUTPUT_RATE   = 24000               # server → Pi English voice: PCM16 mono 24kHz LE
MIN_AUDIO_B64 = 64                  # drop empty "stub" parts (server already filters)

class ScannerGuidancePlayer:
    """Latest-wins, never-interrupt playback of the scanner's English PCM cues.

    - push_chunk(b64): append one base64 PCM16@24k chunk to the cue being received.
    - end_utterance(): called on `speech_end` — seal the cue; play now if idle,
      else keep ONLY as the newest pending cue (older pending is discarded).
    - a cue that is already playing is never cut off; when it ends, the freshest
      pending cue (if any) plays next and anything stale in between is skipped.
    """
    def __init__(self):
        self._incoming = []          # chunks (np.int16) of the cue currently arriving
        self._pending  = None        # newest sealed cue waiting to play (overwritten)
        self._playing  = False
        self._lock     = threading.Lock()
        # ── The Pi's AudioContext.resume() equivalent ──
        # Open and START the output device ONCE, up front — NOT lazily on the first
        # chunk, or the device-open latency swallows the start of the first cue.
        self._stream = sd.RawOutputStream(
            samplerate=OUTPUT_RATE, channels=1, dtype="int16")
        self._stream.start()

    def push_chunk(self, b64: str) -> None:
        if not b64 or len(b64) < MIN_AUDIO_B64:     # defensive: never play a stub
            return
        pcm = np.frombuffer(base64.b64decode(b64), dtype="<i2")
        with self._lock:
            self._incoming.append(pcm)

    def end_utterance(self) -> None:                # ← on "speech_end"
        with self._lock:
            if not self._incoming:
                return
            cue = np.concatenate(self._incoming)
            self._incoming = []
            if self._playing:
                self._pending = cue                 # don't interrupt; keep newest only
            else:
                self._start_locked(cue)

    def _start_locked(self, cue) -> None:
        self._playing = True
        threading.Thread(target=self._play, args=(cue,), daemon=True).start()

    def _play(self, cue) -> None:
        self._stream.write(cue.tobytes())           # blocks until this cue finishes
        with self._lock:
            nxt, self._pending = self._pending, None
            if nxt is not None:
                self._start_locked(nxt)             # jump straight to the freshest cue
            else:
                self._playing = False

    def flush(self) -> None:                        # on stop / disconnect / mode-switch
        with self._lock:
            self._incoming = []
            self._pending  = None
        # (optional) self._stream.abort() to cut the current cue immediately

    def close(self) -> None:
        self.flush()
        self._stream.stop(); self._stream.close()
```

Wiring into the Socket.IO handlers (note `response` is a **JSON string**, and the
Twi voice uses a *separate* WAV player with the **same** latest-wins rule):

```python
player     = ScannerGuidancePlayer()     # English PCM cues
twi_player = EncodedGuidancePlayer()     # Twi: one WAV per cue, same latest-wins rule

@sio.on("audio", namespace="/scanner-live")
def _on_audio(p):      player.push_chunk(p.get("data"))     # English cue chunk

@sio.on("speech_end", namespace="/scanner-live")
def _on_speech_end():  player.end_utterance()               # seal + play the cue

@sio.on("tts_audio", namespace="/scanner-live")
def _on_tts(p):        twi_player.play(p.get("data"))       # Twi WAV cue (en path ignores)

@sio.on("response", namespace="/scanner-live")
def _on_response(raw):                                      # raw is a STRING
    r = json.loads(raw)
    render(r)            # switch on r["status"]: processing | no_object | positioning | success

@sio.on("disconnect", namespace="/scanner-live")
def _on_disconnect():  player.flush(); twi_player.flush()
```

`EncodedGuidancePlayer` (Twi) is the same state machine with one difference: each
`tts_audio` is a **complete WAV clip**, so there is no `push_chunk`/`speech_end`
pair — `play(b64)` *is* the "seal" step. Decode the WAV (any decoder), then apply
the identical "play now if idle, else keep newest pending, never interrupt" logic.
