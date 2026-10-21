// ─────────────────────────────────────────────
//  features/medication-scanner/medscanner.match.ts
//
//  Success-path helpers for the scanner, lifted verbatim (behaviour-wise)
//  from the original `medscanner.service.ts`. None of this uses the Live
//  API — pharmacology extraction is a plain `generateContent` call and the
//  prescription match is a Firestore `findNearest` vector search. The Live
//  frame→guidance loop (scanner-live.service.ts) calls into these once a
//  label has been read.
// ─────────────────────────────────────────────
import { GoogleGenAI, Type } from "@google/genai";
import { FieldValue } from "@google-cloud/firestore";
import dotenv from "dotenv";

import { Medication, MedicationLabelFields } from "@/types/medscanner";
import { getFirestore } from "@/lib/firebase";
import { embedText } from "@/lib/embeddings";
import { ExternalServiceError } from "@/lib/errors";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EXTRACTION_MODEL = "gemini-2.5-flash";

const EMBEDDING_FIELD = "name_embedding";
const TOP_N = 5;

// Firestore COSINE distance is bounded [0, 2]; matches within a user's own
// catalog empirically land < 0.3, unrelated drugs sit higher.
const DISTANCE_THRESHOLD = 0.3;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const firestore = getFirestore();

/**
 * Second-stage extraction: restructure the raw OCR tokens returned by the
 * positioning model into a pharmacology-oriented record. Schema-enforced so
 * downstream code can trust the shape; nullable fields are explicit so the
 * model doesn't hallucinate a generic name when only a brand is visible.
 */
export async function extractMedicationFields(ocrResult: {
  drug_name: string;
  raw_label_text: string[];
}): Promise<MedicationLabelFields> {
  const { drug_name, raw_label_text } = ocrResult;

  const labelContext = [
    `Parsed drug name: ${drug_name}`,
    `Raw label tokens: ${raw_label_text.join(", ")}`,
  ].join("\n");

  const response = await ai.models.generateContent({
    model: EXTRACTION_MODEL,
    contents: [
      `You are a pharmacology assistant helping to structure medication label data for a prescription lookup system.

Extract structured fields from the following OCR scan of a medication label.

${labelContext}

Notes:
- The label may be for a non-prescription product (e.g. a topical repellent) — extract what you can.
- Return null for fields you cannot determine with reasonable confidence.
- The confidence score should reflect how reliably this label maps to a medication record.`,
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          brand_name: {
            type: Type.STRING,
            nullable: true,
            description: "The commercial or brand name of the product (e.g. 'Medisoft', 'Panadol')",
          },
          generic_name: {
            type: Type.STRING,
            nullable: true,
            description: "The active ingredient or INN generic name (e.g. 'Paracetamol', 'DEET'). For combination products, list the primary active ingredient.",
          },
          manufacturer: {
            type: Type.STRING,
            nullable: true,
            description: "The name of the manufacturing company or brand owner",
          },
          dosage_form: {
            type: Type.STRING,
            nullable: true,
            description: "Physical form of the product: tablet, capsule, cream, spray, liquid, etc.",
          },
          concentration: {
            type: Type.STRING,
            nullable: true,
            description: "Strength, concentration, or net quantity (e.g. '500mg', '5%', '100ml')",
          },
          product_category: {
            type: Type.STRING,
            nullable: true,
            description: "High-level therapeutic or product category (e.g. 'analgesic', 'topical repellent', 'antibiotic')",
          },
          confidence: {
            type: Type.NUMBER,
            description: "Confidence score for the overall extraction (0 = very uncertain, 1 = highly confident)",
          },
          unmatched_tokens: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Label tokens that could not be mapped to any known field",
          },
        },
        required: [
          "brand_name",
          "generic_name",
          "manufacturer",
          "dosage_form",
          "concentration",
          "product_category",
          "confidence",
          "unmatched_tokens",
        ],
      },
    },
  });

  if (!response.text) {
    throw new ExternalServiceError("Gemini API", "Model failed to yield a response body.");
  }

  return JSON.parse(response.text);
}

/** Collapse the extracted fields into a single query string for embedding. */
function buildQueryString(fields: MedicationLabelFields): string {
  return [
    fields.brand_name,
    fields.generic_name,
    fields.concentration,
    fields.product_category,
    fields.dosage_form,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * Vector-search the user's medication subcollection for the extracted label.
 * Returns the top-N hits sorted by ascending distance (closest first).
 */
export async function searchUserMedications(
  userId: string,
  extractedFields: MedicationLabelFields
): Promise<
  {
    medication: Medication;
    distance: number;
    withinThreshold: boolean;
  }[]
> {
  const queryString = buildQueryString(extractedFields);
  const queryVector = await embedText(queryString);

  const medicationsRef = firestore
    .collection("users")
    .doc(userId)
    .collection("medications");

  const vectorQuery = medicationsRef.findNearest({
    vectorField: EMBEDDING_FIELD,
    // @ts-ignore — FieldValue.vector typing mismatch with the admin SDK version
    queryVector: FieldValue.vector(queryVector),
    limit: TOP_N,
    distanceMeasure: "COSINE",
    distanceResultField: "vector_distance",
  });

  const snapshot = await vectorQuery.get();
  if (snapshot.empty) return [];

  const results = snapshot.docs.map((doc) => {
    const data = doc.data();
    const distance = data.vector_distance ?? null;

    return {
      medication: { id: doc.id, ...doc.data() } as Medication,
      distance,
      withinThreshold: distance !== null ? distance <= DISTANCE_THRESHOLD : false,
    };
  });

  results.sort((a, b) => a.distance - b.distance);
  return results;
}

/** Single best confident match, or null. */
export async function findBestMatch(
  userId: string,
  extractedFields: MedicationLabelFields
) {
  const results = await searchUserMedications(userId, extractedFields);
  const best = results[0] ?? null;

  if (!best || !best.withinThreshold) return null;
  return best;
}
