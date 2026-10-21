
import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { DrugInfo, ToolResult, SearchDrugInfoInput } from "@/types/assistant";
import { logger } from "@/lib/logger";

const OPENFDA_BASE = "https://api.fda.gov/drug";

// Lazy GenAI client for grounded (web-search) drug lookups.
let _genai: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!_genai) {
    _genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _genai;
}

interface OpenFDALabelResult {
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    pharm_class_epc?: string[];
  };
  description?: string[];
  indications_and_usage?: string[];
  warnings?: string[];
  drug_interactions?: string[];
  adverse_reactions?: string[];
}

interface OpenFDAResponse {
  results?: OpenFDALabelResult[];
}

async function queryOpenFDA(drugName: string): Promise<Partial<DrugInfo> | null> {
  try {
    const apiKey = process.env.OPENFDA_API_KEY;
    const keyParam = apiKey ? `&api_key=${apiKey}` : "";

    for (const field of ["openfda.brand_name", "openfda.generic_name"]) {
      const q = `${field}:"${drugName}"`;
      const url = `${OPENFDA_BASE}/label.json?search=${encodeURIComponent(q)}&limit=1${keyParam}`;
      const res = await axios.get<OpenFDAResponse>(url, { timeout: 8000 });

      if (!res.data.results?.length) continue;
      const r = res.data.results[0];

      return {
        name: drugName,
        genericName: r.openfda?.generic_name?.[0],
        brandNames: r.openfda?.brand_name,
        drugClass: r.openfda?.pharm_class_epc?.[0],
        description: r.description?.[0]?.substring(0, 600),
        commonUses: r.indications_and_usage?.map((s) => s.substring(0, 300)),
        warnings: r.warnings?.map((s) => s.substring(0, 300)),
        commonSideEffects: r.adverse_reactions?.map((s) => s.substring(0, 300)),
        interactions: r.drug_interactions?.map((s) => s.substring(0, 300)),
        source: "openfda",
      };
    }

    return null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    console.error("[OpenFDA] query failed:", err);
    return null;
  }
}

/**
 * Grounded drug lookup via Gemini + Google Search.
 *
 * OpenFDA is US-centric and returns nothing for most Ghanaian/generic brand
 * names — exactly our users' meds. A grounded web search identifies the drug
 * and returns a factual summary plus the source URLs backing it.
 */
async function queryGroundedDrugInfo(
  drugName: string,
  query?: string
): Promise<Partial<DrugInfo> | null> {
  const focus = query ? ` The user specifically wants to know about: ${query}.` : "";

  const prompt = `Provide concise, factual information about the medication "${drugName}".${focus}

Cover, where applicable:
- what it is (generic / active ingredient and pharmacologic class)
- common uses / conditions treated
- common side effects
- important warnings
- notable drug interactions

This may be a medication sold in Ghana or West Africa under a local brand or generic name — use web sources to identify it. Do NOT recommend a dosage or imply the drug is appropriate for any individual. If you cannot confidently identify the drug, say so plainly.`;

  try {
    const response = await getGenAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        temperature: 0.2,
        // Google Search grounding cannot be combined with a JSON responseSchema,
        // so we take the grounded free-text summary + citation URIs instead.
        tools: [{ googleSearch: {} }],
      },
    });

    const summary = response.text?.trim();
    if (!summary) return null;

    const chunks =
      response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const citations = Array.from(
      new Set(
        chunks
          .map((c) => c.web?.uri)
          .filter((u): u is string => !!u)
      )
    );

    return {
      name: drugName,
      summary,
      description: summary.substring(0, 600),
      citations: citations.length ? citations : undefined,
    };
  } catch (err) {
    logger.warn("Grounded drug lookup failed", {
      drugName,
      error: String(err),
    });
    return null;
  }
}

export async function searchDrugInfo(
  input: SearchDrugInfoInput
): Promise<ToolResult<DrugInfo>> {
  try {
    const fdaData = await queryOpenFDA(input.drugName);

    const fdaHasEnough =
      !!fdaData &&
      !!fdaData.description &&
      !!fdaData.commonUses?.length &&
      !!fdaData.commonSideEffects?.length;

    // Fast path: OpenFDA already has rich structured data.
    if (fdaData && fdaHasEnough) {
      return {
        success: true,
        data: {
          ...fdaData,
          name: input.drugName,
          source: "openfda",
          needsLLMSupplement: false,
        } as DrugInfo,
      };
    }

    // OpenFDA missing or thin → grounded web search (covers local/generic drugs).
    const grounded = await queryGroundedDrugInfo(input.drugName, input.query);

    if (grounded) {
      return {
        success: true,
        data: {
          name: input.drugName,
          ...fdaData,     // keep any partial structured fields FDA did return
          ...grounded,    // grounded summary + citations win
          source: fdaData ? "llm+openfda" : "llm",
          needsLLMSupplement: false,
        } as DrugInfo,
      };
    }

    // Last resort: let the main assistant model answer from its own knowledge.
    return {
      success: true,
      data: {
        name: input.drugName,
        ...(fdaData ?? {}),
        source: "llm",
        needsLLMSupplement: true,
      } as DrugInfo,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}