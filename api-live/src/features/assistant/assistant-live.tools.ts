// ─────────────────────────────────────────────
//  features/assistant/assistant-live.tools.ts
//
//  Tool declarations + dispatcher shared by the Live assistant. The
//  declarations are the exact same function schemas the REST assistant uses
//  (assistant.tools.ts); the dispatcher is lifted from the REST
//  MedicalAssistant.chat()'s module-private dispatchTool() so the two servers
//  run identical tool logic. userId is injected server-side from the verified
//  socket — never from model-supplied args.
// ─────────────────────────────────────────────
import { FunctionCall } from "@google/genai";

import { tools } from "@features/assistant/assistant.tools";
import { queryPrescriptions, savePrescription } from "@features/assistant/prescription.tools";
import { searchDrugInfo } from "@features/assistant/drugInfo.tools";
import {
  QueryPrescriptionsInput,
  SavePrescriptionInput,
  SearchDrugInfoInput,
} from "@/types/assistant";

export { tools };

/**
 * Run one tool call and return its result plus whether it was a drug search
 * (so the caller can collect citation/source metadata, mirroring the REST
 * assistant).
 */
export async function dispatchTool(
  call: FunctionCall,
  userId: string
): Promise<{ result: unknown; isSearch: boolean }> {
  const args = (call.args ?? {}) as Record<string, unknown>;

  if (call.name === "query_prescriptions") {
    const input: QueryPrescriptionsInput = {
      userId,
      intent: args.intent as QueryPrescriptionsInput["intent"],
      drugName: args.drugName as string | undefined,
    };
    return { result: await queryPrescriptions(input), isSearch: false };
  }

  if (call.name === "search_drug_info") {
    return {
      // @ts-ignore — args shape validated by the model against the declaration
      result: await searchDrugInfo(args as SearchDrugInfoInput),
      isSearch: true,
    };
  }

  if (call.name === "save_prescription") {
    const input: SavePrescriptionInput = {
      userId,
      name: args.name as string,
      timeSlots: args.timeSlots as string[],
      dosage: args.dosage as string,
      unitsPerDose: args.unitsPerDose as number,
      frequency: args.frequency as number,
      strength: args.strength as string | undefined,
      instruction: args.instruction as string | undefined,
    };
    return { result: await savePrescription(input), isSearch: false };
  }

  return {
    result: { success: false, error: `Unknown tool: ${call.name}` },
    isSearch: false,
  };
}
