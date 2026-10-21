import { z } from "zod";
import type { Socket } from "socket.io";

// ── Medication Label Fields (internal) ────────────────────────────────

export interface MedicationLabelFields { 
    brand_name?: string;
    generic_name?: string;
    manufacturer?: string;
    product_category?: string;
    dosage_form?: string;
    concentration?: string;
    confidence: number; 
    unmatched_tokens: string[];
}

// ── Medication Document (Firestore) ───────────────────────────────────

export interface Medication {
  completedSlots: Record<string, string>;
  composite_string: string;
  createdAt: string;
  dosage: string;
  frequency: number;
  id: string;
  instruction: string;
  name: string;
  strength: string;
  timeSlots: string[];
  unitsPerDose: number;
  updatedAt: string;
}

// ── WebSocket Response Schema ─────────────────────────────────────────

/**
 * Discriminated union of every possible WebSocket response emitted
 * over the `/med-scanner` namespace.
 *
 * The `status` field acts as the discriminator — every response
 * has exactly one shape determined by its status value.
 */

export type MedScannerStatus = "processing" | "positioning" | "no_object" | "success";

export type PositioningInstruction =
  | "move_up" | "move_down" | "move_left" | "move_right"
  | "rotate_left" | "rotate_right" | "flip"
  | "move_closer" | "move_farther" | "hold_still" | "none";

export interface PrescriptionMatch {
  medication: Medication;
  distance: number;
  withinThreshold: boolean;
}

// ── Individual response shapes ────────────────────────────────────────

export interface MedScannerProcessingResponse {
  status: "processing";
  /** No other fields — client should show a loading/spinner state. */
}

export interface MedScannerPositioningResponse {
  status: "positioning" | "no_object";
  instruction: PositioningInstruction;
  guidance_text: string;
}

export interface MedScannerSuccessResponse {
  status: "success";
  instruction: "none";
  guidance_text: string;
  prescription_match: PrescriptionMatch | null;
}

// ── Discriminated union ───────────────────────────────────────────────

export type MedScannerResponse =
  | MedScannerProcessingResponse
  | MedScannerPositioningResponse
  | MedScannerSuccessResponse;

// ── Zod schemas (runtime validation) ──────────────────────────────────

const positioningInstructionSchema = z.enum([
  "move_up", "move_down", "move_left", "move_right",
  "rotate_left", "rotate_right", "flip",
  "move_closer", "move_farther", "hold_still", "none",
]);

const prescriptionMatchSchema = z.object({
  medication: z.object({
    completedSlots: z.record(z.string(), z.string()),
    composite_string: z.string(),
    createdAt: z.string(),
    dosage: z.string(),
    frequency: z.number(),
    id: z.string(),
    instruction: z.string(),
    name: z.string(),
    strength: z.string(),
    timeSlots: z.array(z.string()),
    unitsPerDose: z.number(),
    updatedAt: z.string(),
  }),
  distance: z.number(),
  withinThreshold: z.boolean(),
});

export const medScannerProcessingSchema = z.object({
  status: z.literal("processing"),
}).strict();

export const medScannerPositioningSchema = z.object({
  status: z.enum(["positioning", "no_object"]),
  instruction: positioningInstructionSchema,
  guidance_text: z.string(),
}).strict();

export const medScannerSuccessSchema = z.object({
  status: z.literal("success"),
  instruction: z.literal("none"),
  guidance_text: z.string(),
  prescription_match: prescriptionMatchSchema.nullable(),
}).strict();

/**
 * Runtime discriminator: validates a raw object against every known
 * response variant. Throws a descriptive ZodError on mismatch.
 */
export const medScannerResponseSchema = z.discriminatedUnion("status", [
  medScannerProcessingSchema,
  medScannerPositioningSchema,
  medScannerSuccessSchema,
]);

// ── Enforcer utility ──────────────────────────────────────────────────

/**
 * Emit a validated `MedScannerResponse` on the given socket.
 *
 * - Validates the payload against the runtime schema **before** emitting.
 * - Uses a consistent serialisation strategy (JSON.stringify).
 * - Throws if the payload is malformed — prevents silent contract drift.
 *
 * @returns `true` if the emit succeeded (socket still connected)
 * @throws {ZodError} if the payload fails schema validation
 */
export function emitMedScannerResponse(
  socket: Socket,
  response: MedScannerResponse,
): boolean {
  // Validate at runtime — catch contract violations immediately
  console.log(response)
  const parsed = medScannerResponseSchema.parse(response);

  // Serialise consistently (the current code has mixed raw/stringified emits)
  const payload = JSON.stringify(parsed);

  console.log(payload)

  return socket.emit("response", payload);
}