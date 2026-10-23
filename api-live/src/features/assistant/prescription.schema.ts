import { z } from "zod";

const slot = z.enum(["morning", "afternoon", "evening"]);

// Shared body for create (all required) / the base of update (all optional).
const prescriptionFields = {
  name: z.string().min(1, "name is required"),
  timeSlots: z.array(slot).min(1, "at least one time slot is required"),
  dosage: z.string().min(1, "dosage is required"),
  unitsPerDose: z.number().positive("unitsPerDose must be greater than 0"),
  frequency: z.number().int().positive("frequency must be a positive integer"),
  strength: z.string().optional(),
  instruction: z.string().optional(),
};

export const CreatePrescriptionSchema = z.object({
  body: z.object(prescriptionFields),
});

export const UpdatePrescriptionSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      name: prescriptionFields.name.optional(),
      timeSlots: prescriptionFields.timeSlots.optional(),
      dosage: prescriptionFields.dosage.optional(),
      unitsPerDose: prescriptionFields.unitsPerDose.optional(),
      frequency: prescriptionFields.frequency.optional(),
      strength: prescriptionFields.strength,
      instruction: prescriptionFields.instruction,
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: "Provide at least one field to update",
    }),
});

export const DeletePrescriptionSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

export const MarkTakenSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    slot,
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
      .optional(),
    taken: z.boolean().optional(),
  }),
});

const dateQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
});

export const TodayScheduleSchema = z.object({
  query: dateQuery,
});

// ── Hardware sync (bulk push) ─────────────────
// Date-keyed intake log the device recorded offline:
//   { "2026-10-23": { "morning": "2026-10-23T07:12:00.000Z" } }
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "completion day must be YYYY-MM-DD");
const isoTimestamp = z.string().datetime({ message: "completion time must be an ISO timestamp" });
// Inner map is a PARTIAL record: a day may carry only the slots actually taken.
// (z.record with an enum key is exhaustive in Zod v4 — it would demand all three.)
const completions = z.record(dateKey, z.partialRecord(slot, isoTimestamp));

// One prescription as it exists on the device. `id` is the server id when the
// device has synced this item before; omit it for a prescription created
// offline (the server mints one and echoes it back against `clientId`).
const syncPrescription = z
  .object({
    id: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    name: prescriptionFields.name.optional(),
    timeSlots: prescriptionFields.timeSlots.optional(),
    dosage: prescriptionFields.dosage.optional(),
    unitsPerDose: prescriptionFields.unitsPerDose.optional(),
    frequency: prescriptionFields.frequency.optional(),
    strength: prescriptionFields.strength,
    instruction: prescriptionFields.instruction,
    completions: completions.optional(),
    deleted: z.boolean().optional(),
    // Device's last-modified time; used for last-write-wins on the editable
    // fields. Completions are always merged (a dose taken is never lost).
    updatedAt: isoTimestamp.optional(),
  })
  // A brand-new prescription (no id) must carry the fields needed to create it.
  .refine((p) => p.id || p.deleted || (p.name && p.timeSlots && p.dosage && p.unitsPerDose && p.frequency), {
    message:
      "A new prescription (without id) must include name, timeSlots, dosage, unitsPerDose and frequency",
  });

export const SyncPushSchema = z.object({
  body: z.object({
    prescriptions: z
      .array(syncPrescription)
      .min(1, "prescriptions must contain at least one item")
      .max(500, "a sync batch may contain at most 500 prescriptions"),
  }),
});
