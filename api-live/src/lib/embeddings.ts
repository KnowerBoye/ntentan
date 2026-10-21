// ─────────────────────────────────────────────
//  lib/embeddings.ts
//  Shared wrapper for Vertex AI text embeddings
// ─────────────────────────────────────────────
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
const LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const EMBEDDING_MODEL = "text-embedding-005";

let _embeddingClient: GoogleGenAI | null = null;

function getEmbeddingClient(): GoogleGenAI {
  if (_embeddingClient) return _embeddingClient;

  _embeddingClient = new GoogleGenAI({
    vertexai: true,
    project: PROJECT_ID,
    location: LOCATION,
    googleAuthOptions: {
      keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
    },
  });

  return _embeddingClient;
}

/**
 * Embed a single text string into a vector using Vertex AI text-embedding-005.
 */
export async function embedText(text: string): Promise<number[]> {
  const client = getEmbeddingClient();

  const response = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [{ text }],
  });

  if (response.embeddings?.[0]?.values) {
    return response.embeddings[0].values;
  }

  throw new Error("Failed to extract valid embedding values from response.");
}