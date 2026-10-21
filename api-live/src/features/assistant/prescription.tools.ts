// ─────────────────────────────────────────────
import { getFirestore } from "@/lib/firebase";
import { FieldValue } from "firebase-admin/firestore";
import {
  displayTime,
  displayTimeSlots,
  getNextDose,
  buildMedicationDayView,
  todayKey,
  nowHHMM,
} from "@/lib/DateHelpers";
import {
  Prescription,
  QueryPrescriptionsInput,
  SavePrescriptionInput,
  SavePrescriptionResult,
  PrescriptionQueryResult,
  MarkMedicationTakenInput,
  MarkMedicationTakenResult,
  TimeSlot,
  VALID_SLOTS,
  TIME_WINDOWS,
  ToolResult,
} from "@/types/assistant";
import { embedText } from "@/lib/embeddings";
import { logger } from "@/lib/logger";

/**
 * Fetch all medications for a user from the subcollection:
 *   users/{userId}/medications
 */
export async function fetchAll(userId: string): Promise<Prescription[]> {
  const db = getFirestore();
  const snap = await db
    .collection("users")
    .doc(userId)
    .collection("medications")
    .get();

  return snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<Prescription, "id">),
  }));
}

// ── Cosine similarity ──────────────────────────

function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, ai, i) => sum + ai * b[i], 0);
}

function magnitude(v: number[]): number {
  return Math.sqrt(v.reduce((sum, vi) => sum + vi * vi, 0));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = dotProduct(a, b);
  const mag = magnitude(a) * magnitude(b);
  return mag === 0 ? 0 : dot / mag;
}

/**
 * Coerce a stored `name_embedding` into a plain number[].
 *
 * Firestore returns vector fields written via `FieldValue.vector(...)` as
 * `VectorValue` instances (which expose `.toArray()`), but older/other write
 * paths may have stored a plain array or Float32Array. Normalise all of them
 * so cosine comparison works regardless of how the doc was embedded.
 */
function toVector(embedding: unknown): number[] | null {
  if (!embedding) return null;

  // Firestore VectorValue
  if (typeof (embedding as { toArray?: unknown }).toArray === "function") {
    return (embedding as { toArray: () => number[] }).toArray();
  }

  // Plain array or Float32Array
  if (Array.isArray(embedding) || embedding instanceof Float32Array) {
    return Array.from(embedding as ArrayLike<number>);
  }

  return null;
}

// ── Matchers ──────────────────────────────────

/**
 * Match medications by drug name using semantic vector search.
 * Falls back to substring matching if vectors are unavailable.
 * If no drugName is provided, returns all medications.
 */
export async function matchDrugs(
  all: Prescription[],
  drugName?: string
): Promise<Prescription[]> {
  if (!drugName) return all;

  const queryLower = drugName.toLowerCase();

  // ── Try vector search first ──
  try {
    const queryVector = await embedText(drugName);
    const SIMILARITY_THRESHOLD = 0.6;

    const scored = all
      .map((p) => ({ prescription: p, vector: toVector(p.name_embedding) }))
      .filter((p): p is { prescription: Prescription; vector: number[] } =>
        p.vector !== null && p.vector.length === queryVector.length
      )
      .map(({ prescription, vector }) => ({
        prescription,
        similarity: cosineSimilarity(queryVector, vector),
      }))
      .filter(({ similarity }) => similarity >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity);

    if (scored.length > 0) {
      return scored.map(({ prescription }) => prescription);
    }

    logger.debug("Vector search returned no results, falling back to substring match", {
      drugName,
    });
  } catch (err) {
    logger.warn("Vector embedding failed, falling back to substring match", {
      drugName,
      error: String(err),
    });
  }

  // ── Fallback: substring match ──
  return all.filter((p) =>
    p.name.toLowerCase().includes(queryLower)
  );
}

// ── Save Prescription ────────────────────────

export async function savePrescription(
  input: SavePrescriptionInput
): Promise<ToolResult<SavePrescriptionResult>> {
  try {
    const { userId, name, timeSlots, dosage, unitsPerDose, frequency, strength, instruction } = input;

    // ── Validate timeSlots are valid ──
    for (const slot of timeSlots) {
      if (!VALID_SLOTS.includes(slot as TimeSlot)) {
        return {
          success: false,
          error: `Invalid time slot "${slot}". Valid slots are: ${VALID_SLOTS.join(", ")}`,
        };
      }
    }

    const db = getFirestore();
    const now = new Date().toISOString();

    // ── Build the document ──
    const docData = {
      name,
      timeSlots,
      dosage,
      unitsPerDose,
      frequency,
      strength: strength ?? "",
      instruction: instruction ?? "",
      // Date-keyed intake log (see Completions type). Empty until a dose is
      // marked taken.
      completions: {},
      composite_string: `${name} ${strength ?? ""} ${dosage}`.trim(),
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await db
      .collection("users")
      .doc(userId)
      .collection("medications")
      .add(docData);

    logger.info("Prescription saved", { userId, prescriptionId: docRef.id, name });

    // Embedding is generated by the `embedMedicationOnWrite` Cloud Function,
    // which fires on this write, enriches name+dosage into a composite string,
    // and stores a proper Firestore `VectorValue` (required for the scanner's
    // `findNearest`). We intentionally do NOT embed here: a second writer would
    // race the function and could persist an incompatible plain-array format.

    return {
      success: true,
      data: {
        id: docRef.id,
        name,
      },
    };
  } catch (err) {
    logger.error("Failed to save prescription", { error: String(err) });
    return { success: false, error: String(err) };
  }
}

export async function queryPrescriptions(
  input: QueryPrescriptionsInput
): Promise<ToolResult<PrescriptionQueryResult>> {
  try {
    const { userId, intent, drugName } = input;
    const all = await fetchAll(userId);

    let prescriptions: Prescription[] = [];
    let contextNote = "";

    switch (intent) {
      case "next": {
        const matched = drugName ? await matchDrugs(all, drugName) : all;

        if (matched.length === 0) {
          contextNote = drugName
            ? `No medications found matching "${drugName}".`
            : "No medications found on record.";
          break;
        }

        const next = getNextDose(matched);

        if (!next) {
          contextNote = "All medication slots have passed for today. The next doses will be tomorrow.";
          break;
        }

        const { prescription: p, slot } = next;
        contextNote = `Next medication: ${p.name} ${p.strength} — ${p.unitsPerDose} ${p.dosage} — ${displayTime(slot)}.` +
          (p.instruction ? ` Instructions: ${p.instruction}` : "");
        prescriptions = [p];
        break;
      }

      case "medication_info": {
        if (!drugName) {
          return { success: false, error: "drugName is required for medication_info intent." };
        }

        const matched = await matchDrugs(all, drugName);

        if (matched.length === 0) {
          contextNote = `No medication found matching "${drugName}".`;
          break;
        }

        prescriptions = matched;
        const details = matched
          .map(
            (p) =>
              `${p.name} ${p.strength}\n` +
              `  Dosage: ${p.unitsPerDose} ${p.dosage}\n` +
              `  Times: ${displayTimeSlots(p.timeSlots)}\n` +
              `  Frequency: ${p.frequency} time(s) per day\n` +
              (p.instruction ? `  Instructions: ${p.instruction}\n` : "")
          )
          .join("\n");
        contextNote = `Found ${matched.length} medication(s):\n${details}`;
        break;
      }

      case "all_active": {
        const matched = drugName ? await matchDrugs(all, drugName) : all;
        prescriptions = matched;

        if (matched.length === 0) {
          contextNote = drugName
            ? `No medications found matching "${drugName}".`
            : "No prescriptions found on record.";
        } else {
          const details = matched
            .map(
              (p) =>
                `${p.name} ${p.strength} — ${p.unitsPerDose} ${p.dosage} — ${displayTimeSlots(p.timeSlots)}` +
                (p.instruction ? ` (${p.instruction})` : "")
            )
            .join("\n");
          contextNote = `Found ${matched.length} prescription(s):\n${details}`;
        }
        break;
      }

      case "today": {
        const matched = drugName ? await matchDrugs(all, drugName) : all;
        prescriptions = matched;

        if (matched.length === 0) {
          contextNote = drugName
            ? `No medications found matching "${drugName}".`
            : "No medications on record for today.";
          break;
        }

        const today = todayKey();
        const views = matched.map((p) => buildMedicationDayView(p, today));

        // Spoken-friendly summary: group each med's slots by status.
        const lines = views.map((v) => {
          const parts = v.doses.map((d) => {
            if (d.status === "taken") return `${d.slot} taken`;
            if (d.status === "missed") return `${d.slot} missed`;
            return `${d.slot} still due`;
          });
          return `${v.name} ${v.strength} — ${parts.join(", ")}`;
        });

        const totalDoses = views.reduce((n, v) => n + v.doses.length, 0);
        const takenDoses = views.reduce(
          (n, v) => n + v.doses.filter((d) => d.taken).length,
          0
        );

        contextNote =
          `Today's schedule (${takenDoses} of ${totalDoses} doses taken):\n` +
          lines.join("\n");
        break;
      }

      default:
        return { success: false, error: `Unknown intent: ${intent}` };
    }

    return {
      success: true,
      data: {
        intent,
        prescriptions,
        contextNote,
      },
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Mark medication taken ────────────────────

/** Resolve the slot that best matches "now" among a prescription's slots. */
function currentSlotFor(p: Prescription): TimeSlot | null {
  const now = nowHHMM();
  const candidates = (p.timeSlots as TimeSlot[]).filter((s) => TIME_WINDOWS[s]);

  // Prefer a slot whose window contains the current time.
  const inWindow = candidates.find((s) => {
    const w = TIME_WINDOWS[s];
    return now >= w.start && now < w.end;
  });
  if (inWindow) return inWindow;

  // Otherwise the earliest slot still not past its window end.
  const upcoming = candidates
    .filter((s) => now < TIME_WINDOWS[s].end)
    .sort((a, b) => TIME_WINDOWS[a].start.localeCompare(TIME_WINDOWS[b].start));
  if (upcoming.length) return upcoming[0];

  // All windows passed → the latest slot of the day.
  const sorted = candidates.sort((a, b) =>
    TIME_WINDOWS[b].start.localeCompare(TIME_WINDOWS[a].start)
  );
  return sorted[0] ?? null;
}

/**
 * Mark (or un-mark) a single dose of a medication as taken for a given day.
 * Writes into the date-keyed `completions` map using a dotted field path so
 * other slots/days are untouched.
 */
export async function markMedicationTaken(
  input: MarkMedicationTakenInput
): Promise<ToolResult<MarkMedicationTakenResult>> {
  try {
    const { userId, prescriptionId, drugName, date, taken = true } = input;

    // ── Resolve the target prescription ──
    let target: Prescription | undefined;

    if (prescriptionId) {
      const all = await fetchAll(userId);
      target = all.find((p) => p.id === prescriptionId);
      if (!target) {
        return { success: false, error: `No medication found with id "${prescriptionId}".` };
      }
    } else if (drugName) {
      const all = await fetchAll(userId);
      const matched = await matchDrugs(all, drugName);
      if (matched.length === 0) {
        return { success: false, error: `No medication found matching "${drugName}".` };
      }
      if (matched.length > 1) {
        const names = matched.map((p) => p.name).join(", ");
        return {
          success: false,
          error: `"${drugName}" is ambiguous — it matched ${matched.length} medications (${names}). Ask the user which one they mean.`,
        };
      }
      target = matched[0];
    } else {
      return { success: false, error: "Provide either prescriptionId or drugName." };
    }

    // ── Resolve the slot ──
    const slot = input.slot ?? currentSlotFor(target);
    if (!slot) {
      return { success: false, error: `Could not determine a time slot for "${target.name}".` };
    }
    if (!(target.timeSlots as string[]).includes(slot)) {
      return {
        success: false,
        error: `"${target.name}" is not scheduled for the ${slot} slot. Its slots are: ${displayTimeSlots(target.timeSlots)}.`,
      };
    }

    const day = date ?? todayKey();
    const db = getFirestore();
    const docRef = db
      .collection("users")
      .doc(userId)
      .collection("medications")
      .doc(target.id);

    const fieldPath = `completions.${day}.${slot}`;
    if (taken) {
      await docRef.update({
        [fieldPath]: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else {
      await docRef.update({
        [fieldPath]: FieldValue.delete(),
        updatedAt: new Date().toISOString(),
      });
    }

    logger.info("Medication intake updated", {
      userId,
      prescriptionId: target.id,
      slot,
      day,
      taken,
    });

    return {
      success: true,
      data: { id: target.id, name: target.name, slot, date: day, taken },
    };
  } catch (err) {
    logger.error("Failed to mark medication taken", { error: String(err) });
    return { success: false, error: String(err) };
  }
}