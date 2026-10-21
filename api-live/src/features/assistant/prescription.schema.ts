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
