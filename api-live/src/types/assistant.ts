import type { VectorValue } from "@google-cloud/firestore";

export interface Prescription {
  id: string;
  completedSlots: Record<string, string>; // slot name → timestamp
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
  | "next"             // what medication should I take next (based on current time vs time slots)?
  | "medication_info"  // find a specific medication and return its details (instruction, timeSlots, etc.)
  | "all_active";      // list all my prescriptions

export interface QueryPrescriptionsInput {
  userId: string;
  intent: QueryIntent;
  /** Drug name to filter by (uses semantic vector search) */
  drugName?: string;
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