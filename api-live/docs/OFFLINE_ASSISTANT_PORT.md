# Offline Medical Assistant — Port Spec for the Raspberry Pi

This document captures the **prompt, tools, and functionality** of the current
`api-live` medical assistant so it can be reproduced on-device (Raspberry Pi)
with a **local Gemma model**, an **onboard TTS library**, and an **onboard STT
library**. It is a mirror spec, not new code — every rule below is already
implemented in `src/features/assistant/`; the Pi port should behave identically
except where the "Pi divergence" notes say otherwise.

The assistant does exactly four things:

1. Answer questions about the user's **own prescriptions** (read-only).
2. **Record** that a dose was taken (or undo it).
3. **Save** a new prescription.
4. Answer **general drug-education** questions with a safety disclaimer.

---

## 1. Runtime shape

### Cloud (current)
```
mic ──PCM16──▶ Gemini Live (native audio STT+TTS+reasoning+tool-calling)
                   │  tool calls (function-calling)
                   ▼
              Firestore (prescriptions)  +  OpenFDA / grounded web search
```
Gemini Live does speech-to-text, reasoning, function-calling, and
text-to-speech all in one session. The server is a relay that injects `userId`
and runs the tool implementations.

### Pi (target)
```
mic ──▶ STT lib ──▶ text ──▶ Gemma (reasoning + tool-calling) ──▶ text ──▶ TTS lib ──▶ speaker
                                      │  tool calls
                                      ▼
                             local prescription store (SQLite / JSON)
                             + model's own drug knowledge (no network)
```
Everything that was a cloud call becomes a local call. The **prompt and the
four tool contracts stay the same**; only the transport and the drug-info
source change.

---

## 2. The data model

One record per medication. This is the single source of truth every tool reads
and writes. (Type: `src/types/assistant.ts` → `Prescription`.)

```jsonc
{
  "id": "string",                 // store-assigned id
  "name": "Paracetamol",          // drug name
  "strength": "500mg",            // per-unit strength (optional, "")
  "dosage": "tablets",            // the form/unit
  "unitsPerDose": 2,              // how many units per dose
  "frequency": 3,                 // times per day
  "timeSlots": ["morning","evening"],   // subset of the 3 slots below
  "instruction": "Take with food",      // free text (optional, "")
  "completions": {                // date-keyed intake log
    "2026-10-23": { "morning": "2026-10-23T07:12:00.000Z" }
  },
  "composite_string": "Paracetamol 500mg tablets",  // search text (see §6)
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

### Time slots (fixed — not clock times)
Source: `TIME_WINDOWS` in `src/types/assistant.ts`.

| Slot        | Window        |
|-------------|---------------|
| `morning`   | 06:00–12:00   |
| `afternoon` | 12:00–17:00   |
| `evening`   | 17:00–22:00   |

A dose is identified by `(prescriptionId, date, slot)`. `completions[date][slot]`
is the ISO timestamp it was marked taken; absence means not taken. **Never store
a slot as taken=false — absence is the false state.**

> **Pi divergence:** drop `composite_string` + embeddings (§6) if you implement
> name matching with plain substring search, which is the existing fallback.

---

## 3. The system prompt

The live (voice) prompt is the one to copy — it is already tuned for *spoken*
conversation. Source: `src/features/assistant/live-prompt.ts` →
`buildLiveSystemPrompt()`. Reproduce it verbatim on the Pi:

```
You are a professional, warm, and empathetic AI medical assistant speaking with
a user out loud in a live voice conversation.

## Voice style
- You are being heard, not read. Keep replies short and natural — a sentence or
  two at a time.
- Never use markdown, bullet points, asterisks, or headings. Speak in plain prose.
- Do not read out URLs. If a fact came from a source, just say "according to
  medical sources" rather than reciting a link.
- When listing medications, say them naturally: "You have two: paracetamol
  500mg in the morning, and amoxicillin 250mg in the evening."
- If you need more than one piece of information from the user, ask for ONE
  thing at a time and wait for the answer.

## Your Role
You help users manage their personal prescriptions and provide factual drug
education.

## Time Slots
Medications use time-of-day slots, not clock times: morning (06:00–12:00),
afternoon (12:00–17:00), evening (17:00–22:00). Use the current time to decide
what comes next.

## Prescription Queries (Personal)
- ALWAYS call query_prescriptions before answering any question about the user's
  own medications. Never guess or invent prescription data.
- Use the contextNote the tool returns as the basis for your spoken answer.
- "What should I take next?" → intent "next" (this already skips doses the user
  has marked taken today). A specific drug by name → intent "medication_info"
  with drugName. "List my medications" → intent "all_active". "What have I taken
  today?" / "what's left today?" / "did I take my morning dose?" → intent "today".
- Do NOT add a "check with your doctor or pharmacist" disclaimer when simply
  reading out or updating the user's stored prescription details. Just give them
  their information directly. The disclaimer belongs only on general
  drug/medical questions.

## Marking Medication Taken
- When the user says they have taken a dose ("I took my morning paracetamol",
  "mark my evening pills as done", "I just took my medicine"), call
  mark_medication_taken.
- Pass the drugName they mention. If they don't name a specific time of day,
  omit the slot and it marks the current time-of-day dose.
- If the tool reports the name was ambiguous (matched more than one medication),
  ask which one they mean, then try again.
- After marking, briefly confirm out loud what you recorded (e.g. "Done — I've
  marked your morning paracetamol as taken.").
- Only undo (taken=false) if the user explicitly says they marked something by
  mistake.

## General Drug Enquiries
- Call search_drug_info first for factual drug questions that are NOT about the
  user's own prescriptions.
- Prefer the tool's grounded summary when present; do not contradict it from
  memory. Only if needsLLMSupplement is true may you answer from your own
  knowledge, and say that you are doing so.
- ALWAYS end a general drug answer by reminding the user, out loud, to check
  with their doctor or pharmacist before changing any medication. This reminder
  applies ONLY to general medical advice and drug-education questions — NOT to
  reading out or updating the user's own stored prescription details.
- NEVER recommend a drug, suggest a dosage, or imply a drug is right for the user.

## Saving Prescriptions
- You can save a new prescription with save_prescription.
- Required: name, timeSlots, dosage, unitsPerDose, frequency. Optional: strength,
  instruction.
- If anything required is missing, ask for it ONE question at a time before
  calling the tool. After saving, read back what you saved to confirm.
- If a medication with the same name already exists, ask whether to update it
  instead of creating a duplicate.

## Hard Safety Rules
1. You are NOT a doctor. Never diagnose, prescribe, or recommend treatments.
2. Never suggest stopping or changing a prescribed dosage.
3. Medical emergencies → immediately tell the user to call emergency services.
4. Drug abuse, overdose, or self-harm → provide crisis resources only.
```

### Pi divergence — the "General Drug Enquiries" section

On the Pi there is **no OpenFDA and no web grounding**. Rewrite that section so
the model answers **briefly from its own knowledge** and always discloses it:

```
## General Drug Enquiries
- For factual drug questions that are NOT about the user's own prescriptions,
  answer briefly from your own general knowledge. You have no live database or
  internet, so keep it short and only say what you are confident about.
- If you are not sure what a drug is or do, say so plainly rather than guessing.
- ALWAYS end a general drug answer with a spoken reminder to check with a doctor
  or pharmacist before changing any medication, and that your information is
  general and may be out of date.
- NEVER recommend a drug, suggest a dosage, or imply a drug is right for the user.
```

This replaces the `search_drug_info` tool (§5.4) with pure model knowledge +
mandatory disclaimer. Keep all other sections identical.

### Prompt the current date/time in
The model needs "now" to compute `next` and the current slot. The cloud relies
on server time inside the tools (see §6); on the Pi, also inject the current
local date + `HH:mm` into the system prompt or the first turn so the model can
phrase answers correctly ("it's evening now…"). The **tools still compute slot
logic themselves** — don't trust the model to do the time math.

### Twi layer — out of scope for the offline port
The cloud version has a Twi pipeline (`ghananlp.service.ts`) that routes Twi
through GhanaNLP's cloud ASR/MT/TTS because Gemini can't produce good Twi. That
is a **network service** and does not belong in the offline build. If the Pi
needs Twi, it must come from the onboard STT/TTS libs' own language support, not
this layer. Everything in this doc is the **English** path, which is the core.

---

## 4. The conversation loop (what the orchestrator does each turn)

Mirrors `assistant-live.service.ts`, minus the socket/Twi plumbing:

1. **STT**: capture mic audio → onboard STT → user text.
2. **Model turn**: send user text + history to Gemma with the system prompt and
   the four tool declarations (§5). Use Gemma's function-calling format.
3. **Tool calls**: if the model emits one or more function calls:
   - Run the matching tool implementation (§6) with `userId` injected by the
     orchestrator — **never take identity/user from model args**.
   - Feed each tool result back to the model as a function response.
   - Loop back to step 2 until the model produces a plain text reply.
4. **TTS**: the final text reply → onboard TTS → speaker.
5. **Barge-in** (optional): if the user starts talking while TTS is playing,
   stop playback and start a new turn.

Keep a short rolling **conversation history** so follow-ups ("mark that one as
taken") resolve against the previous turn.

> **Gemma note:** smaller local models are weaker at multi-tool orchestration.
> Mitigations: keep the four tools (don't add more), keep the enum-constrained
> params, and if Gemma struggles with native function-calling, use a structured
> JSON "action" output contract and parse it yourself — the tool *semantics*
> below are what matters, not the wire format.

---

## 5. The tools (function declarations)

Exact source: `src/features/assistant/assistant.tools.ts`. Four tools. Keep the
names, params, enums, and descriptions — the descriptions are load-bearing (they
are the model's routing instructions).

### 5.1 `query_prescriptions` — read anything about the user's meds
Required: `intent`. Optional: `drugName`.

| `intent`          | Meaning |
|-------------------|---------|
| `next`            | What to take next, by current time, **skipping doses already taken today**. Optional `drugName` filter. |
| `medication_info` | Full details of one drug. `drugName` **required**. |
| `all_active`      | List all prescriptions. Optional `drugName` filter. |
| `today`           | Today's schedule with each slot as taken / due / missed. |

`drugName` is matched semantically in the cloud (brand/generic/partial all work,
e.g. "panadol" → "Paracetamol"). See §6 for the Pi fallback.

Routing examples (from the tool description — keep them):
- "What should I take next?" → `next`
- "When is my next paracetamol?" → `next`, drugName="paracetamol"
- "Tell me about my paracetamol" → `medication_info`, drugName="paracetamol"
- "Show all my medications" → `all_active`
- "What have I taken today?" / "what's left today?" → `today`

### 5.2 `mark_medication_taken` — record / undo a dose
Required: `drugName`. Optional: `slot` (enum), `taken` (bool).
- Omit `slot` → marks the dose for the **current** time of day (see
  `currentSlotFor` in §6).
- `taken=false` **only** to undo a mistaken entry.
- If `drugName` matches more than one med, the tool returns an "ambiguous" error
  listing the matches → model must ask the user which one.

### 5.3 `save_prescription` — create a new record
Required: `name`, `timeSlots` (array of the slot enum), `dosage`,
`unitsPerDose` (number), `frequency` (number).
Optional: `strength`, `instruction`.
The model must collect every required field (one question at a time) before
calling, then read back what was saved.

### 5.4 `search_drug_info` — general drug education
Cloud params: `drugName` (required), `query` (optional aspect, e.g. "side
effects"). Cloud behavior: OpenFDA first, then grounded web search, then fall
back to model knowledge. Returns a `DrugInfo` object with `summary`,
`citations`, `source`, and `needsLLMSupplement`.

> **Pi divergence — remove this tool.** There is no network. Instead, let Gemma
> answer general drug questions directly from its own weights per the rewritten
> prompt section in §3, always appended with the doctor/pharmacist disclaimer
> and a "general knowledge, may be out of date" caveat. If you prefer to keep a
> tool boundary for logging, it can be a no-op that just returns
> `{ needsLLMSupplement: true }` so the model answers from knowledge — but the
> simpler path is to drop the tool and rely on the prompt.

---

## 6. Tool implementations (the business logic to reproduce)

Source: `src/features/assistant/prescription.tools.ts` and
`src/lib/DateHelpers.ts`. The model never does date/slot math — these functions
do. Reproduce them exactly.

### 6.1 Drug-name matching — `matchDrugs(all, drugName)`
Cloud path: embed `drugName`, cosine-compare against each record's stored
`name_embedding`, keep matches with **similarity ≥ 0.6**, sorted high→low. On
any failure or zero matches, **fall back to case-insensitive substring match**
on `name`. No `drugName` → return all.

> **Pi divergence:** unless you ship a local embedding model, use the substring
> fallback as the primary matcher. It already exists in the code. Optionally add
> simple alias handling (a small local brand→generic table) to recover the
> "panadol → Paracetamol" cases that embeddings gave you for free. Keep the
> **ambiguity rule**: if a name matches >1 record for `mark_medication_taken`,
> return an error naming the matches so the model asks the user.

### 6.2 `query_prescriptions` — returns `{ intent, prescriptions, contextNote }`
`contextNote` is a **spoken-friendly** summary string; the model is told to base
its reply on it. Build it per intent:

- **next**: use `getNextDose()` (§6.4). If found:
  `"Next medication: {name} {strength} — {unitsPerDose} {dosage} — {displayTime(slot)}."`
  plus `" Instructions: {instruction}"` if present. If all slots passed:
  `"All medication slots have passed for today. The next doses will be tomorrow."`
  No meds: `"No medications found..."`.
- **medication_info** (`drugName` required): for each match, a block:
  ```
  {name} {strength}
    Dosage: {unitsPerDose} {dosage}
    Times: {displayTimeSlots(timeSlots)}
    Frequency: {frequency} time(s) per day
    Instructions: {instruction}   // if present
  ```
  Prefixed `"Found N medication(s):"`.
- **all_active**: one line per med:
  `"{name} {strength} — {unitsPerDose} {dosage} — {displayTimeSlots} ({instruction})"`.
- **today**: build each med's day view (§6.5), then one line per med grouping its
  slots as `"{slot} taken" | "{slot} missed" | "{slot} still due"`, prefixed with
  `"Today's schedule (X of Y doses taken):"`.

### 6.3 `currentSlotFor(p)` — which slot "now" maps to
1. The slot whose window contains the current `HH:mm`.
2. Else the earliest slot still before its window end.
3. Else (all windows passed) the latest slot of the day.
Only considers slots the prescription actually has.

### 6.4 `getNextDose(prescriptions)`
Across all meds and their slots: skip slots already taken today
(`completions[today][slot]` present) and slots whose window has ended
(`now >= window.end`). Of what remains, return the earliest by slot order
(morning→afternoon→evening), or `null` if nothing is upcoming.

### 6.5 `buildMedicationDayView(p, date)` — per-slot status
For each of the med's slots on `date`:
- `taken` if `completions[date][slot]` exists → status `taken` (+ `takenAt`).
- else `missed` if the day is past, or it's today and `now >= window.end`.
- else `upcoming`.

### 6.6 `markMedicationTaken({ userId, drugName|prescriptionId, slot?, date?, taken=true })`
1. Resolve the target: by `prescriptionId` if given, else `matchDrugs(drugName)`
   — **error if zero, error "ambiguous" if >1**.
2. Resolve `slot`: use the given one, else `currentSlotFor(target)`.
3. **Reject** if that slot isn't in the med's `timeSlots` (business-rule error,
   surfaced to the user).
4. `date` defaults to today.
5. Write `completions[date][slot] = now` (taken) or **delete** that key (undo),
   and bump `updatedAt`. Write only that one field path — never clobber other
   days/slots.

### 6.7 `savePrescription(input)`
Validate every slot in `timeSlots` is one of morning/afternoon/evening. Write
the full record (§2) with `completions: {}`, `composite_string`,
`createdAt`/`updatedAt`. Return `{ id, name }`.

> **Pi divergence:** `composite_string` + the async embedding step
> (`embedMedicationOnWrite` Cloud Function) exist only to feed vector search.
> Drop both on the Pi if you use substring matching.

---

## 7. Hard safety rules (must survive the port)

These are non-negotiable and already in the prompt (§3):

1. **Not a doctor** — never diagnose, prescribe, or recommend treatment.
2. **Never** suggest stopping or changing a prescribed dosage.
3. **Emergencies** → tell the user to call emergency services immediately.
4. **Drug abuse / overdose / self-harm** → crisis resources only.
5. **Disclaimer discipline:** general drug questions **always** get the
   doctor/pharmacist disclaimer; reading back or updating the user's *own*
   stored prescription does **not** (so the assistant isn't naggy about the
   user's known routine).
6. On the Pi, general drug answers additionally carry a **"general knowledge,
   may be out of date, no live lookup"** caveat, because the only source is the
   model's weights.

---

## 8. Offline persistence & sync

The current store is Firestore at `users/{userId}/medications`. The hardware
device already has an **offline-first sync contract** (see
`docs/HARDWARE_SYNC.md` and the `/sync` routes): it keeps a local store, records
doses offline, and reconciles on reconnect with last-write-wins on fields and
**always-merge** on `completions` (a dose marked taken is never dropped).

For the offline assistant:
- Use a **local store** (SQLite or a JSON file) with the §2 shape.
- The assistant reads/writes that local store directly — no network in the hot
  path.
- If the Pi also syncs to the cloud, follow `HARDWARE_SYNC.md`: push local
  changes with `updatedAt` for field conflicts and merge `completions`.

---

## 9. Port checklist

- [ ] Local prescription store with the §2 record shape.
- [ ] Reproduce `TIME_WINDOWS` and all of §6's date/slot helpers verbatim.
- [ ] System prompt from §3, with the **drug-enquiries section swapped** for the
      offline (model-knowledge + disclaimer) variant.
- [ ] Inject current local date + `HH:mm` into the model each session.
- [ ] Three tools: `query_prescriptions`, `mark_medication_taken`,
      `save_prescription` (drop `search_drug_info`).
- [ ] Name matching via substring (+ optional alias table); keep the ambiguity
      error for marking.
- [ ] STT → model(+tools) loop → TTS, with `userId`/identity injected by the
      orchestrator, never from model args.
- [ ] Safety rules (§7) intact, including the offline "may be out of date" caveat.
- [ ] (Optional) local store ↔ cloud reconciliation per `HARDWARE_SYNC.md`.
```
