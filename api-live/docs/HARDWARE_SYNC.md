# Ntentan Live — Prescription Sync Contract (Hardware Client)

**Audience:** the engineer building the Raspberry Pi / hardware client.
**Server:** `api-live/` (Gemini Live API edition).
**Transport:** plain HTTPS REST (not Socket.IO — the live voice/scanner channels
are separate; see `raspberry-pi-client-contract.md`).
**Source of truth:** derived verbatim from `prescription.routes.ts`,
`prescription.service.ts`, `prescription.schema.ts`, and `auth.middleware.ts`.

This document describes the two endpoints the device uses to keep its **local
prescription store** in sync with the server. The design is **offline-first**:
the device works entirely from its local copy, and reconciles with the server
whenever the network is available.

---

## 1. The sync model

The device holds a full local copy of the patient's prescriptions and their
intake log. It never needs the network to function. Two directions of sync:

```
   ┌──────────────── Hardware client ────────────────┐
   │  local prescription store (authoritative while   │
   │  offline: new meds, doses marked taken, edits)   │
   └──────────────────────────────────────────────────┘
        │  ▲
  PUSH  │  │  PULL
 (POST  │  │  (GET /sync)
 /sync) │  │
        ▼  │
   ┌──────────────────── api-live ───────────────────┐
   │  Firestore: users/{uid}/medications              │
   └──────────────────────────────────────────────────┘
```

- **PULL — `GET /api/prescriptions/sync`** — fetch the complete server
  snapshot. Use on startup and after reconnecting, to hydrate / refresh the
  local store.
- **PUSH — `POST /api/prescriptions/sync`** — upload everything that changed
  locally while offline (new prescriptions, doses marked taken, field edits,
  deletions) in one batch.

A typical reconnect cycle: **push local changes first**, then **pull** to adopt
the server's reconciled state (including the ids the server minted for
offline-created prescriptions).

---

## 2. Auth

Every request requires authentication, identical to the rest of the REST API.

**Production** — Firebase ID token:

```
Authorization: Bearer <firebase-id-token>
```

**Dev / bench mode** — when the server runs with `ALLOW_UID_AUTH=true`, send the
patient's uid directly (no Firebase token):

```
X-User-Id: <patient-uid>
```

All data is scoped to the authenticated user; the device never passes a uid in
the body or path.

---

## 3. Base URL & shape

- Base: `https://<host>/api/prescriptions`
- `Content-Type: application/json` on every push.
- Every response is wrapped:

```json
{ "status": "success", "data": { ... } }
```

On error the server returns the matching HTTP status with:

```json
{ "status": "error", "message": "…", "code": "VALIDATION_ERROR" }
```

(`code` is one of `BAD_REQUEST`, `UNAUTHORIZED`, `VALIDATION_ERROR`,
`INTERNAL_ERROR`, … — see `lib/errors.ts`.)

---

## 4. PULL — `GET /api/prescriptions/sync`

Returns the full set of prescriptions with complete state, plus the server
clock to store as the device's "last synced" marker.

**Request**

```
GET /api/prescriptions/sync
Authorization: Bearer <token>
```

**Response `200`**

```json
{
  "status": "success",
  "data": {
    "serverTime": "2026-10-23T09:30:00.000Z",
    "prescriptions": [
      {
        "id": "k3Jd9sT2…",
        "name": "Paracetamol",
        "strength": "500mg",
        "dosage": "2 tablets",
        "unitsPerDose": 2,
        "frequency": 3,
        "timeSlots": ["morning", "afternoon", "evening"],
        "instruction": "After food",
        "completions": {
          "2026-10-23": { "morning": "2026-10-23T07:12:00.000Z" }
        },
        "composite_string": "Paracetamol 500mg 2 tablets",
        "createdAt": "2026-10-01T10:00:00.000Z",
        "updatedAt": "2026-10-23T07:12:00.000Z"
      }
    ]
  }
}
```

Field notes:

| Field          | Meaning                                                                 |
|----------------|-------------------------------------------------------------------------|
| `id`           | Server id. Store it locally — it's how you later update this item.      |
| `timeSlots`    | Subset of `"morning" \| "afternoon" \| "evening"`.                      |
| `completions`  | `{ "YYYY-MM-DD": { slot: ISO-timestamp-taken } }`. The intake log.      |
| `updatedAt`    | Server's last write. Keep it — you echo it back on push for conflict resolution. |
| `composite_string` | Server-maintained search text. Read-only; never send it.           |

The semantic-search embedding vector is intentionally **not** included.

---

## 5. PUSH — `POST /api/prescriptions/sync`

Upload a batch of local changes. The whole batch commits atomically (all or
nothing). Send **only what changed** since the last successful sync — the device
decides the delta; the server does not diff for you.

**Request**

```
POST /api/prescriptions/sync
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "prescriptions": [
    {
      "clientId": "local-7f3a",
      "name": "Amoxicillin",
      "strength": "250mg",
      "dosage": "1 capsule",
      "unitsPerDose": 1,
      "frequency": 2,
      "timeSlots": ["morning", "evening"],
      "instruction": "Finish the full course"
    },
    {
      "id": "k3Jd9sT2…",
      "updatedAt": "2026-10-23T07:12:00.000Z",
      "completions": {
        "2026-10-23": { "afternoon": "2026-10-23T13:40:00.000Z" }
      }
    },
    {
      "id": "p9Lm1Qr4…",
      "deleted": true
    }
  ]
}
```

### 5.1 The three kinds of item

| Intent                      | Send                                                   | Server action |
|-----------------------------|--------------------------------------------------------|---------------|
| **Create** (born offline)   | all fields, **no `id`**, a `clientId`                  | mints an id, echoes it against `clientId` |
| **Update / mark dose taken**| `id` + the changed fields and/or `completions`         | merges        |
| **Delete**                  | `id` + `"deleted": true`                               | removes it    |

### 5.2 Field rules

- A **create** (no `id`) **must** include `name`, `timeSlots`, `dosage`,
  `unitsPerDose`, `frequency`. `strength` and `instruction` are optional.
- `clientId` is your device-local id. Optional, but **send it on creates** so you
  can map the server id back from the response.
- `updatedAt` — your local last-modified time (ISO). Optional but recommended;
  it drives last-write-wins (see §5.3).
- `completions` — doses marked taken locally. Keys are `YYYY-MM-DD`, inner keys
  are slots, values are ISO timestamps. Send only the days/slots you recorded;
  you don't need to resend the whole history.
- Batch limit: **500 items**.

### 5.3 Conflict & merge policy (important)

- **`completions` are always merged, never replaced.** A dose recorded as taken
  is a fact and is never dropped by a sync, even on a "losing" item. The stored
  log becomes the union across the device and any other client (e.g. the
  caregiver portal). To *undo* a dose, use `POST /:id/taken` with
  `"taken": false` — the batch sync never un-marks.
- **Editable fields** (`name`, `strength`, `dosage`, `unitsPerDose`,
  `frequency`, `timeSlots`, `instruction`) use **last-write-wins** on
  `updatedAt`: the device's edits apply only when its `updatedAt` is at or after
  the server's. If you omit `updatedAt`, the device is treated as the winner.
- **Unknown `id`** (the server deleted it since you last pulled) → the item is
  **skipped** (`reason: "not_found"`), not resurrected. Drop it from your local
  store on the next pull.

### 5.4 Response `200`

```json
{
  "status": "success",
  "data": {
    "serverTime": "2026-10-23T13:41:02.000Z",
    "applied": 2,
    "results": [
      { "clientId": "local-7f3a", "id": "Zx8Nq…", "action": "created" },
      { "id": "k3Jd9sT2…", "action": "updated" },
      { "id": "p9Lm1Qr4…", "action": "skipped", "reason": "not_found" }
    ]
  }
}
```

- `results` is **positional-independent** — match by `clientId` (creates) or
  `id` (everything else).
- `action` ∈ `created | updated | deleted | skipped`.
- `reason` accompanies a `skipped`: `not_found` (unknown id) or `stale` (the
  device lost the field race and carried no new completions).
- `applied` is the count of items that changed the database.

**On a `created` result, overwrite your local `clientId` with the returned `id`**
so the next sync updates in place instead of creating a duplicate.

---

## 6. Recommended device flow

```
startup:
    GET /sync           → replace local store with snapshot, save serverTime

while running (offline-tolerant):
    add / edit / mark-taken / delete  → mutate local store, stamp local updatedAt,
                                         flag the row "dirty"

on reconnect (or on a timer when online):
    POST /sync { prescriptions: [all dirty rows] }
        → for each created result, adopt returned id, clear dirty flag
        → for each updated/deleted result, clear dirty flag
        → for each skipped/not_found, drop the row locally
    GET /sync           → adopt reconciled server state, save new serverTime
```

Idempotency: pushing the same unchanged row twice is harmless — fields re-merge
to the same values and completions re-merge to the same set. Pushing a create
twice **does** create two rows, so always adopt the returned `id` before the
next push.

---

## 7. Errors to handle

| Status | When                                                      | Device action |
|--------|-----------------------------------------------------------|---------------|
| `401`  | missing/expired token                                     | refresh token, retry |
| `422`  | schema validation failed (bad slot, missing create field) | fix payload; do not retry blindly — inspect `message` |
| `400`  | business rule (e.g. invalid time slot value)              | inspect `message` |
| `5xx`  | server/Firestore error — **nothing was committed**        | keep rows dirty, retry with backoff |

Because a push is atomic, a non-2xx means **no** item in the batch was applied —
it is always safe to retry the whole batch.
