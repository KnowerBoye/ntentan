import { format } from "date-fns";
import { Prescription, TIME_WINDOWS } from "@/types/assistant";

/** Current time as HH:mm */
export function nowHHMM(): string {
  return format(new Date(), "HH:mm");
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
 * Returns the first prescription whose next non-completed slot
 * is upcoming (sorted by slot order), or null if nothing is upcoming.
 *
 * A slot is considered "completed" for today if the current time
 * has passed its window end.
 */
export function getNextDose(
  prescriptions: Prescription[]
): { prescription: Prescription; slot: string } | null {
  const currentTime = nowHHMM();

  const candidates: Array<{ prescription: Prescription; slot: string; order: number }> = [];

  for (const p of prescriptions) {
    for (const slot of p.timeSlots) {
      const window = TIME_WINDOWS[slot];
      if (!window) continue;

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