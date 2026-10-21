import { format } from "date-fns";
import {
  Prescription,
  TIME_WINDOWS,
  DoseStatus,
  MedicationDayView,
  TimeSlot,
} from "@/types/assistant";

/** Current time as HH:mm */
export function nowHHMM(): string {
  return format(new Date(), "HH:mm");
}

/** Local calendar day as "yyyy-MM-dd" — the key used in `completions`. */
export function todayKey(): string {
  return format(new Date(), "yyyy-MM-dd");
}

/**
 * Whether a given slot has already been marked taken on `date` for a
 * prescription. Reads the new date-keyed `completions` map.
 */
export function isSlotTaken(
  p: Prescription,
  slot: string,
  date: string = todayKey()
): boolean {
  return Boolean(p.completions?.[date]?.[slot]);
}

/** ISO timestamp a slot was taken, or undefined. */
export function slotTakenAt(
  p: Prescription,
  slot: string,
  date: string = todayKey()
): string | undefined {
  return p.completions?.[date]?.[slot];
}

/** Format a time-of-day slot ID for display (e.g. "morning" → "Morning (06:00–12:00)") */
export function displayTime(slot: string): string {
  const w = TIME_WINDOWS[slot];
  if (!w) return slot; // fallback for unknown slot names
  return `${w.label} (${w.start}–${w.end})`;
}

/** Format all time slots for display */
export function displayTimeSlots(slots: string[]): string {
  return slots.map(displayTime).join(", ");
}

/**
 * Determine the slot order for sorting.
 */
const SLOT_ORDER: Record<string, number> = { morning: 0, afternoon: 1, evening: 2 };

/**
 * Find the next upcoming time slot across all given prescriptions,
 * based on the current time.
 *
 * Returns the first prescription whose next slot is still upcoming today and
 * has NOT already been marked taken (sorted by slot order), or null if
 * nothing is upcoming.
 *
 * A slot is skipped when the current time has passed its window end, OR when
 * it was already taken today (recorded in `completions`).
 */
export function getNextDose(
  prescriptions: Prescription[]
): { prescription: Prescription; slot: string } | null {
  const currentTime = nowHHMM();
  const today = todayKey();

  const candidates: Array<{ prescription: Prescription; slot: string; order: number }> = [];

  for (const p of prescriptions) {
    for (const slot of p.timeSlots) {
      const window = TIME_WINDOWS[slot];
      if (!window) continue;

      // Already taken today → not "next".
      if (isSlotTaken(p, slot, today)) continue;

      // If the current time is before the slot window ends, it's upcoming
      if (currentTime < window.end) {
        candidates.push({
          prescription: p,
          slot,
          order: SLOT_ORDER[slot] ?? 99,
        });
      }
    }
  }

  if (!candidates.length) return null;

  // Sort by slot order (morning → afternoon → evening)
  candidates.sort((a, b) => a.order - b.order);

  return { prescription: candidates[0].prescription, slot: candidates[0].slot };
}

/**
 * Build the per-slot view of one prescription for a given day: for each of its
 * time slots, whether the dose was taken, when, and — if not taken — whether
 * the slot's window has already passed ("missed") or is still "upcoming".
 *
 * When `date` is a past day, every un-taken slot counts as "missed"; for a
 * future day, every un-taken slot is "upcoming".
 */
export function buildMedicationDayView(
  p: Prescription,
  date: string = todayKey()
): MedicationDayView {
  const currentTime = nowHHMM();
  const isToday = date === todayKey();
  const isPast = date < todayKey();

  const doses: DoseStatus[] = p.timeSlots
    .filter((slot): slot is TimeSlot => Boolean(TIME_WINDOWS[slot]))
    .sort((a, b) => (SLOT_ORDER[a] ?? 99) - (SLOT_ORDER[b] ?? 99))
    .map((slot) => {
      const window = TIME_WINDOWS[slot];
      const takenAt = slotTakenAt(p, slot, date);
      const taken = Boolean(takenAt);

      let status: DoseStatus["status"];
      if (taken) {
        status = "taken";
      } else if (isPast || (isToday && currentTime >= window.end)) {
        status = "missed";
      } else {
        status = "upcoming";
      }

      return { slot, label: displayTime(slot), taken, takenAt, status };
    });

  return {
    id: p.id,
    name: p.name,
    strength: p.strength ?? "",
    dosage: p.dosage,
    unitsPerDose: p.unitsPerDose,
    instruction: p.instruction ?? "",
    doses,
  };
}