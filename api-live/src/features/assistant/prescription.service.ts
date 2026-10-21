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
