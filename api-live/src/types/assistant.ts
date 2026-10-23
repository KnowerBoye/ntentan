import type { VectorValue } from "@google-cloud/firestore";

/**
 * Date-keyed intake log. Outer key is a local calendar day "YYYY-MM-DD";
 * inner key is a time slot ("morning" | "afternoon" | "evening") mapped to the
 * ISO timestamp at which that dose was marked taken.
 *
 *   completions: { "2026-10-21": { morning: "2026-10-21T07:12:00.000Z" } }
 */
export type Completions = Record<string, Record<string, string>>;

export interface Prescription {
  id: string;
  /** Date-keyed record of which slots were taken on which day. */
  completions?: Completions;
  /**
   * @deprecated Legacy flat slot→timestamp map (no date dimension). Retained so
   * old documents still parse; superseded by `completions`.
   */
  completedSlots?: Record<string, string>;
  composite_string: string;          // enriched text for semantic search
  createdAt: string;
  dosage: string;                    // e.g. "2 tablets"
  frequency: number;                 // times per day
  instruction: string;               // special instructions / notes
  name: string;                      // drug name e.g. "Paracetamol"
  strength: string;                  // e.g. "500mg"
  timeSlots: string[];               // e.g. ["morning", "afternoon", "evening"]
  unitsPerDose: number;             // e.g. 2 (tablets per dose)
  updatedAt: string;
  name_embedding?: VectorValue;      // Firestore vector for semantic search
}

// ── Time-of-day windows ──────────────────────
export const TIME_WINDOWS: Record<string, { label: string; start: string; end: string }> = {
  morning:   { label: "Morning",   start: "06:00", end: "12:00" },
  afternoon: { label: "Afternoon", start: "12:00", end: "17:00" },
  evening:   { label: "Evening",   start: "17:00", end: "22:00" },
} as const;

// ── Query intent Gemini resolves ─────────────
export type QueryIntent =
  | "next"             // what medication should I take next (based on current time, skipping doses already taken today)?
  | "medication_info"  // find a specific medication and return its details (instruction, timeSlots, dosage, etc.)
  | "all_active"       // list all my prescriptions
  | "today";           // today's schedule with taken / not-taken status for each slot

export interface QueryPrescriptionsInput {
  userId: string;
  intent: QueryIntent;
  /** Drug name to filter by (uses semantic vector search) */
  drugName?: string;
}

// ── Time slots ───────────────────────────────
export type TimeSlot = "morning" | "afternoon" | "evening";
export const VALID_SLOTS: TimeSlot[] = ["morning", "afternoon", "evening"];

// ── Mark medication taken ────────────────────
export interface MarkMedicationTakenInput {
  userId: string;
  /** Which medication. Resolved by drugName (semantic match) when no id given. */
  prescriptionId?: string;
  drugName?: string;
  /** Slot being marked. Omit to mark the current time-of-day slot. */
  slot?: TimeSlot;
  /** Local calendar day "YYYY-MM-DD". Defaults to today. */
  date?: string;
  /** false → un-mark (undo) the slot instead of marking it taken. Default true. */
  taken?: boolean;
}

export interface MarkMedicationTakenResult {
  id: string;
  name: string;
  slot: TimeSlot;
  date: string;
  taken: boolean;
}

// ── Today's schedule ─────────────────────────
export interface DoseStatus {
  slot: TimeSlot;
  label: string;          // e.g. "Morning (06:00–12:00)"
  taken: boolean;
  takenAt?: string;       // ISO timestamp when marked
  status: "taken" | "upcoming" | "missed"; // missed = window passed, not taken
}

export interface MedicationDayView {
  id: string;
  name: string;
  strength: string;
  dosage: string;
  unitsPerDose: number;
  instruction: string;
  doses: DoseStatus[];
}

export interface TodayScheduleResult {
  date: string;
  medications: MedicationDayView[];
}

// ── Save Prescription ────────────────────────
export interface SavePrescriptionInput {
  userId: string;
  name: string;
  timeSlots: string[];
  dosage: string;
  unitsPerDose: number;
  frequency: number;
  strength?: string;
  instruction?: string;
}

export interface SavePrescriptionResult {
  id: string;
  name: string;
}

// ── Portal CRUD (caregiver web portal) ───────
/** Fields a caregiver can set/update on a prescription. */
export interface PrescriptionFields {
  name: string;
  timeSlots: string[];
  dosage: string;
  unitsPerDose: number;
  frequency: number;
  strength?: string;
  instruction?: string;
}

export interface UpdatePrescriptionInput {
  userId: string;
  prescriptionId: string;
  /** Partial set of fields to change. */
  fields: Partial<PrescriptionFields>;
}

export interface DeletePrescriptionInput {
  userId: string;
  prescriptionId: string;
}

// ── Hardware sync ────────────────────────────
/** One prescription pushed up by the device during a sync. */
export interface SyncPrescriptionInput {
  /** Server id when previously synced; omitted for an offline-created item. */
  id?: string;
  /** Device-local id, echoed back so the device can map it to the server id. */
  clientId?: string;
  name?: string;
  timeSlots?: string[];
  dosage?: string;
  unitsPerDose?: number;
  frequency?: number;
  strength?: string;
  instruction?: string;
  /** Doses the device marked taken while offline. Always merged, never cleared. */
  completions?: Completions;
  /** Tombstone — the device deleted this prescription offline. */
  deleted?: boolean;
  /** Device last-modified time, used for last-write-wins on editable fields. */
  updatedAt?: string;
}

/** Per-item outcome of a sync push. */
export interface SyncItemResult {
  /** Echo of the device-local id, when supplied. */
  clientId?: string;
  /** Server id of the affected prescription (null when skipped and unresolved). */
  id: string | null;
  action: "created" | "updated" | "deleted" | "skipped";
  /** Why the item was skipped (e.g. "not_found"). */
  reason?: string;
}

export interface SyncPushResult {
  serverTime: string;
  applied: number;
  results: SyncItemResult[];
}

export interface SyncSnapshot {
  serverTime: string;
  prescriptions: Prescription[];
}

// ── Shared tool result ───────────────────────
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PrescriptionQueryResult {
  intent: QueryIntent;
  prescriptions: Prescription[];
  contextNote: string;
}


export interface DrugInfo {
  name: string;
  genericName?: string;
  brandNames?: string[];
  drugClass?: string;
  description?: string;
  commonUses?: string[];
  commonSideEffects?: string[];
  warnings?: string[];
  interactions?: string[];
  /** Free-text grounded summary (when web-search grounding was used) */
  summary?: string;
  /** Source URLs backing a grounded answer */
  citations?: string[];
  source: "llm" | "openfda" | "llm+openfda";
  needsLLMSupplement: boolean;
}

export interface SearchDrugInfoInput {
  drugName: string;
  query?: string;
}





export type ContentType = "text" | "audio"

export type SupportedLanguage = "english" | "twi";

export interface UserMessage { 
  content : string ;
  type : ContentType , 
  language : SupportedLanguage
}

export interface AssistantResponse {
  message: string;
  toolsUsed: string[];
  sources?: string[];
}

/** Events yielded by the streaming agent loop (MedicalAssistant.chatStream). */
export type AssistantStreamEvent =
  | { type: "tool"; name: string }
  | { type: "delta"; text: string }
  | { type: "final"; message: string; toolsUsed: string[]; sources?: string[] };


export interface ChatMessage {
  content : string  , 
  type : ContentType , 
  role : "user" | "assistant" , 
  language : SupportedLanguage
}


export interface VoiceRequest {
  userId: string;
  language: SupportedLanguage;
  /** Raw .wav file as a Buffer */
  audio: Buffer;
  /** Optional: session ID for conversation continuity */
  sessionId?: string;
}

export interface VoiceResponse {
  /** .wav audio Buffer to send back to the client */
  audio: Buffer;
  /** The English text the assistant produced (useful for logging/debugging) */
  englishText: string;
  /** The final text that was spoken (English or Twi depending on language) */
  spokenText: string;
  language: SupportedLanguage;
  toolsUsed: string[];
}



/** STT: transcribe English .wav → English text */
export type EnglishSTTFn = (audio: Buffer) => Promise<string>;

/** STT: transcribe Twi .wav → Twi text */
export type TwiSTTFn = (audio: Buffer) => Promise<string>;

/** Translate Twi text → English text */
export type TwiToEnglishFn = (twi: string) => Promise<string>;

/** Translate English text → Twi text */
export type EnglishToTwiFn = (english: string) => Promise<string>;

/** TTS: English text → .wav Buffer */
export type EnglishTTSFn = (text: string) => Promise<Buffer>;

/** TTS: Twi text → .wav Buffer */
export type TwiTTSFn = (text: string) => Promise<Buffer>;