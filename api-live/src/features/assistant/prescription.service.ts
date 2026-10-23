// ─────────────────────────────────────────────
//  features/assistant/prescription.service.ts
//
//  Prescription management used by the caregiver web portal (REST). CRUD over
//  the user's medications plus the structured "today" schedule with per-slot
//  taken/upcoming/missed status. The assistant's conversational tools live in
//  prescription.tools.ts; this module shares their data-access helpers
//  (fetchAll, matchDrugs) and the same Firestore shape, so a dose marked here
//  is the same dose the assistant sees and vice-versa.
// ─────────────────────────────────────────────
import { getFirestore } from "@/lib/firebase";
import { buildMedicationDayView, todayKey } from "@/lib/DateHelpers";
import { fetchAll } from "@features/assistant/prescription.tools";
import { NotFoundError, BadRequestError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  Prescription,
  PrescriptionFields,
  UpdatePrescriptionInput,
  DeletePrescriptionInput,
  TodayScheduleResult,
  TimeSlot,
  VALID_SLOTS,
  SyncPrescriptionInput,
  SyncItemResult,
  SyncPushResult,
  SyncSnapshot,
} from "@/types/assistant";

const medicationsCol = (userId: string) =>
  getFirestore().collection("users").doc(userId).collection("medications");

function assertValidSlots(slots: string[]): void {
  for (const slot of slots) {
    if (!VALID_SLOTS.includes(slot as TimeSlot)) {
      throw new BadRequestError(
        `Invalid time slot "${slot}". Valid slots are: ${VALID_SLOTS.join(", ")}`
      );
    }
  }
}

/** All of a user's prescriptions, embedding vector stripped for JSON output. */
export async function listPrescriptions(userId: string): Promise<Prescription[]> {
  const all = await fetchAll(userId);
  return all.map(({ name_embedding, ...rest }) => rest as Prescription);
}

/** Create a prescription. Mirrors savePrescription's document shape. */
export async function createPrescription(
  userId: string,
  fields: PrescriptionFields
): Promise<Prescription> {
  assertValidSlots(fields.timeSlots);

  const now = new Date().toISOString();
  const docData = {
    name: fields.name,
    timeSlots: fields.timeSlots,
    dosage: fields.dosage,
    unitsPerDose: fields.unitsPerDose,
    frequency: fields.frequency,
    strength: fields.strength ?? "",
    instruction: fields.instruction ?? "",
    completions: {},
    composite_string: `${fields.name} ${fields.strength ?? ""} ${fields.dosage}`.trim(),
    createdAt: now,
    updatedAt: now,
  };

  const ref = await medicationsCol(userId).add(docData);
  logger.info("Portal: prescription created", { userId, id: ref.id, name: fields.name });

  // Embedding is produced asynchronously by the embedMedicationOnWrite Cloud
  // Function that fires on this write — we intentionally do not embed here.
  return { id: ref.id, ...docData } as Prescription;
}

/** Update selected fields of a prescription. */
export async function updatePrescription(
  input: UpdatePrescriptionInput
): Promise<Prescription> {
  const { userId, prescriptionId, fields } = input;

  if (fields.timeSlots) assertValidSlots(fields.timeSlots);

  const ref = medicationsCol(userId).doc(prescriptionId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new NotFoundError(`No medication found with id "${prescriptionId}".`);
  }

  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const key of [
    "name",
    "timeSlots",
    "dosage",
    "unitsPerDose",
    "frequency",
    "strength",
    "instruction",
  ] as const) {
    if (fields[key] !== undefined) update[key] = fields[key];
  }

  // Keep the semantic-search composite in sync when name/strength/dosage change.
  // Changing name/dosage also re-triggers the embedding Cloud Function.
  const existing = snap.data() as Omit<Prescription, "id">;
  const name = (update.name as string) ?? existing.name;
  const strength = (update.strength as string) ?? existing.strength ?? "";
  const dosage = (update.dosage as string) ?? existing.dosage;
  update.composite_string = `${name} ${strength} ${dosage}`.trim();

  await ref.update(update);
  logger.info("Portal: prescription updated", { userId, id: prescriptionId });

  const after = await ref.get();
  const { name_embedding, ...rest } = after.data() as Omit<Prescription, "id">;
  return { id: prescriptionId, ...rest } as Prescription;
}

/** Delete a prescription. */
export async function deletePrescription(input: DeletePrescriptionInput): Promise<void> {
  const { userId, prescriptionId } = input;
  const ref = medicationsCol(userId).doc(prescriptionId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new NotFoundError(`No medication found with id "${prescriptionId}".`);
  }
  await ref.delete();
  logger.info("Portal: prescription deleted", { userId, id: prescriptionId });
}

/**
 * Today's (or any day's) schedule for a user: every medication with each of
 * its slots resolved to taken / upcoming / missed.
 */
export async function getDaySchedule(
  userId: string,
  date: string = todayKey()
): Promise<TodayScheduleResult> {
  const all = await fetchAll(userId);
  const medications = all
    .map((p) => buildMedicationDayView(p, date))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { date, medications };
}

// ── Hardware sync ────────────────────────────

/**
 * Full snapshot the device pulls on reconnect: every prescription with its
 * complete state (intake `completions`, `createdAt`/`updatedAt`) plus a
 * `serverTime` the device can keep as its last-synced marker. The embedding
 * vector is stripped — the device never needs it.
 */
export async function getSyncSnapshot(userId: string): Promise<SyncSnapshot> {
  const all = await fetchAll(userId);
  const prescriptions = all.map(
    ({ name_embedding, ...rest }) => rest as Prescription
  );
  return { serverTime: new Date().toISOString(), prescriptions };
}

/**
 * Apply a batch of offline changes the device accumulated while disconnected.
 * Everything is committed in a single Firestore batch, so the push is all or
 * nothing. Per item:
 *
 *   • no `id`            → create a new prescription (server mints the id and
 *                          echoes it back against the device's `clientId`).
 *   • `id` + fields      → update an existing prescription.
 *   • `id` + `deleted`   → delete it.
 *
 * Conflict policy: editable fields use last-write-wins on `updatedAt` (the
 * device only wins when its clock is at/after the server's last write), while
 * `completions` are always merged — a dose recorded as taken is never dropped
 * by a sync. An `id` the server no longer knows is skipped (`not_found`) rather
 * than resurrected, so a server-side deletion is not undone.
 */
export async function syncPrescriptions(
  userId: string,
  incoming: SyncPrescriptionInput[]
): Promise<SyncPushResult> {
  const db = getFirestore();
  const col = medicationsCol(userId);

  // One read of current server state for existence + last-write-wins checks.
  const existing = await fetchAll(userId);
  const byId = new Map(existing.map((p) => [p.id, p]));

  const batch = db.batch();
  const results: SyncItemResult[] = [];
  const now = new Date().toISOString();
  let applied = 0;

  for (const item of incoming) {
    // ── Tombstone: deleted offline ──
    if (item.deleted) {
      if (item.id && byId.has(item.id)) {
        batch.delete(col.doc(item.id));
        results.push({ clientId: item.clientId, id: item.id, action: "deleted" });
        applied++;
      } else {
        results.push({
          clientId: item.clientId,
          id: item.id ?? null,
          action: "skipped",
          reason: "not_found",
        });
      }
      continue;
    }

    if (item.timeSlots) assertValidSlots(item.timeSlots);

    // ── Update an existing prescription ──
    if (item.id) {
      const current = byId.get(item.id);
      if (!current) {
        // Deleted server-side since the device last synced — don't resurrect.
        results.push({
          clientId: item.clientId,
          id: item.id,
          action: "skipped",
          reason: "not_found",
        });
        continue;
      }

      const deviceWins =
        !item.updatedAt || !current.updatedAt || item.updatedAt >= current.updatedAt;

      // Device lost the race on fields and has no new doses to record — no-op.
      if (!deviceWins && !item.completions) {
        results.push({
          clientId: item.clientId,
          id: item.id,
          action: "skipped",
          reason: "stale",
        });
        continue;
      }

      const merge: Record<string, unknown> = { updatedAt: now };

      if (deviceWins) {
        for (const key of [
          "name",
          "timeSlots",
          "dosage",
          "unitsPerDose",
          "frequency",
          "strength",
          "instruction",
        ] as const) {
          if (item[key] !== undefined) merge[key] = item[key];
        }
        const name = (merge.name as string) ?? current.name;
        const strength = (merge.strength as string) ?? current.strength ?? "";
        const dosage = (merge.dosage as string) ?? current.dosage;
        merge.composite_string = `${name} ${strength} ${dosage}`.trim();
      }

      // Deep-merged by Firestore: existing days/slots are preserved, incoming
      // ones added — the union of taken doses across all clients.
      if (item.completions) merge.completions = item.completions;

      batch.set(col.doc(item.id), merge, { merge: true });
      results.push({ clientId: item.clientId, id: item.id, action: "updated" });
      applied++;
      continue;
    }

    // ── Create a new (offline-born) prescription ──
    const ref = col.doc();
    batch.set(ref, {
      name: item.name,
      timeSlots: item.timeSlots,
      dosage: item.dosage,
      unitsPerDose: item.unitsPerDose,
      frequency: item.frequency,
      strength: item.strength ?? "",
      instruction: item.instruction ?? "",
      completions: item.completions ?? {},
      composite_string: `${item.name} ${item.strength ?? ""} ${item.dosage}`.trim(),
      createdAt: now,
      updatedAt: now,
    });
    results.push({ clientId: item.clientId, id: ref.id, action: "created" });
    applied++;
  }

  await batch.commit();
  logger.info("Hardware sync committed", {
    userId,
    received: incoming.length,
    applied,
  });

  // Embeddings for any created/renamed docs are produced by the
  // embedMedicationOnWrite Cloud Function that fires on these writes.
  return { serverTime: now, applied, results };
}
