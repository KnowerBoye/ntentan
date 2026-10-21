/**
 * Cloud Functions for the Ntentan **Live** API.
 *
 * Ported from api/functions/index.js and kept in sync with the Live edition's
 * medication schema (see api-live/src/types/assistant.ts). The one trigger here
 * enriches a medication's name + dosage into a composite string and stores a
 * Firestore vector embedding used for semantic drug-name matching by both the
 * assistant (prescription.tools.ts) and the scanner.
 *
 * Schema note (Live edition): intake is tracked in a date-keyed `completions`
 * map ({ "YYYY-MM-DD": { morning: <iso>, ... } }), NOT the legacy flat
 * `completedSlots`. Marking a dose taken only writes `completions` + `updatedAt`
 * — it changes neither `name` nor `dosage` and the embedding already exists, so
 * the guard below short-circuits and no re-embedding (or write loop) occurs.
 */

const { setGlobalOptions } = require("firebase-functions");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { GoogleGenAI, Type } = require("@google/genai");
const admin = require("firebase-admin");
const dotenv = require("dotenv");

dotenv.config();

setGlobalOptions({ maxInstances: 10 });

admin.initializeApp();
const firestore = admin.firestore();

// Build Firestore sentinels (FieldValue.vector / serverTimestamp) from the SAME
// @google-cloud/firestore module instance that backs `admin.firestore()`.
// Requiring @google-cloud/firestore directly pulls a *second*, different copy
// (admin bundles its own), and a VectorValue made by one copy can't be
// serialized by the other — Firestore rejects it as an object "created via the
// new operator". Using admin's namespace keeps a single module instance.
const { FieldValue } = admin.firestore;

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
const LOCATION = "us-central1";
// Must match the model used for query embeddings in the API
// (src/lib/embeddings.ts) or cosine distances between stored docs and queries
// are meaningless.
const EMBEDDING_MODEL = "text-embedding-005";
const EMBEDDING_FIELD = "name_embedding";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Single modern Google GenAI SDK client (Gemini API key auth) for enrichment.
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Vertex AI client for embeddings.
const embeddingAi = new GoogleGenAI({
  vertexai: true,
  project: PROJECT_ID,
  location: LOCATION,
  googleAuthOptions: {
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  },
});

// ---------------------------------------------------------------------------
// Enrich name + dosage into a full composite string via LLM
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {string} dosage
 * @returns {Promise<string>}
 */
async function buildCompositeString(name, dosage) {
  const response = await ai.models.generateContent({
    model: "models/gemini-2.5-flash",
    contents: [
      `Medication name: ${name}
        Dosage: ${dosage}

        Generate a concise, information-rich composite text optimized for semantic search embeddings.

        Requirements:
        - Include the medication name and dosage exactly as provided.
        - Normalize and expand dosage expressions and common medical abbreviations when possible.
        - Include the generic medication name, active ingredient(s), formulation, when known or inferable.
        - Include the pharmacologic class and therapeutic category.
        - Include common indications, conditions treated, and typical clinical use cases.
        - Include relevant synonyms, alternate spellings, and recognized medical terminology.
        - Preserve clinically important distinctions between strengths, formulations, and routes.
        - Do not include brand names, marketing terms, unsupported assumptions, or explanatory commentary.
        - Output a single natural-language paragraph optimized for vector embeddings and semantic retrieval.
        `,
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          composite: {
            type: Type.STRING,
            description:
              "Space-separated enriched string containing brand name, likely generic/INN name, " +
              "dosage, dosage form, and therapeutic category. E.g. " +
              "'LUFART DS Artemether Lumefantrine 80mg 480mg antimalarial tablets'. " +
              "If you cannot determine a field, omit it rather than guessing.",
          },
        },
        required: ["composite"],
      },
    },
  });

  if (!response.text) {
    throw new Error("No response text returned from enrichment LLM");
  }

  const result = JSON.parse(response.text);
  return result.composite;
}

/**
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedText(text) {
  const response = await embeddingAi.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
  });

  if (response.embeddings?.[0]?.values) {
    return response.embeddings[0].values;
  }

  throw new Error("Failed to extract valid embedding values array from response.");
}

const embedMedicationOnWrite = onDocumentWritten(
  "users/{userId}/medications/{medicationId}",
  async (event) => {
    const { userId, medicationId } = event.params;

    if (!event.data.after.exists) return;

    const after = event.data.after.data();
    const before = event.data.before.exists ? event.data.before.data() : null;

    const nameChanged = after.name !== before?.name;
    const dosageChanged = after.dosage !== before?.dosage;
    const embeddingMissing = !after[EMBEDDING_FIELD];

    // Marking a dose taken only mutates `completions`/`updatedAt`: name and
    // dosage are unchanged and the embedding exists, so we return early and
    // never enter a write loop.
    if (!nameChanged && !dosageChanged && !embeddingMissing) return;

    const { name, dosage } = after;
    if (!name) return;

    console.log(`[embed] Enriching and embedding: "${name}" / "${dosage}"`);

    try {
      const composite = await buildCompositeString(name, dosage ?? "");
      console.log(`[embed] Composite string: "${composite}"`);

      const vector = await embedText(composite);

      await firestore
        .collection("users")
        .doc(userId)
        .collection("medications")
        .doc(medicationId)
        .update({
          [EMBEDDING_FIELD]: FieldValue.vector(vector),
          composite_string: composite, // stored for debugging/inspection
          embedded_at: FieldValue.serverTimestamp(),
        });

      console.log(`[embed] Successfully embedded ${medicationId}`);
    } catch (err) {
      // Log and swallow — don't crash the write transaction pipeline.
      console.error(`[embed] Failed to embed ${medicationId}:`, err);
    }
  }
);

exports.embedMedicationOnWrite = embedMedicationOnWrite;
