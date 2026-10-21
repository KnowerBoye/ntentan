import { Tool, Type } from "@google/genai";

export const tools: Tool[] = [
  {
    functionDeclarations: [
      // ── Unified medication query ──────────
      {
        name: "query_prescriptions",
        description: `Query the user's medication records. Use this for ANY question about the user's personal medications.

Drug name matching uses semantic (vector) search — you can use brand names, generic names, or partial descriptions. For example "artemether" will match "Lufart DS", "panadol" will match "Paracetamol".

Intent mapping:
- "next"            → what medication should I take next? Determines the next time slot (morning/afternoon/evening) based on the current time. Optionally filter by drugName.
- "medication_info" → find a specific medication and return its full details (dosage, time slots, instructions). drugName is REQUIRED.
- "all_active"      → list all active prescriptions. Optionally filter by drugName.

Examples:
  "What should I take next?"                                  → intent="next"
  "When is my next paracetamol?"                              → intent="next", drugName="paracetamol"
  "Tell me about my paracetamol prescription"                 → intent="medication_info", drugName="paracetamol"
  "What are the instructions for amoxicillin?"                → intent="medication_info", drugName="amoxicillin"
  "Show all my medications"                                   → intent="all_active"
  "What medications do I have?"                               → intent="all_active"
  "What heart medications do I have?"                         → intent="all_active", drugName="heart"`,

        parameters: {
          type: Type.OBJECT,
          properties: {
            intent: {
              type: Type.STRING,
              enum: ["next", "medication_info", "all_active"],
              description: "The query intent (see description above)",
            },
            drugName: {
              type: Type.STRING,
              description:
                "Drug name to filter by (uses semantic vector search). Optional for 'next' and 'all_active', but REQUIRED for 'medication_info'.",
            },
          },
          required: ["intent"],
        },
      },


      {
        name: "search_drug_info",
        description: `Search for general information about any drug from the OpenFDA medical database.

Use this ONLY for general drug knowledge questions NOT about the user's personal prescriptions.
Examples: "What is paracetamol used for?", "What are the side effects of amoxicillin?", "What drug class is metformin?"

NEVER use this tool to make dosage recommendations or suggest drugs to the user.`,

        parameters: {
          type: Type.OBJECT,
          properties: {
            drugName: {
              type: Type.STRING,
              description: "The drug name to look up (brand or generic)",
            },
            query: {
              type: Type.STRING,
              description:
                "Optional: specific aspect the user is asking about (e.g. 'side effects', 'uses', 'interactions')",
            },
          },
          required: ["drugName"],
        },
      },

      // ── Save prescription ────────────────
      {
        name: "save_prescription",
        description: `Save a new prescription to the user's medication records.

Collect ALL required fields from the user BEFORE calling this tool. If any required field is missing, ask the user ONE question at a time until you have everything you need.

Required fields:
- name: the drug name (e.g. "Amoxicillin", "Paracetamol")
- timeSlots: one or more of ["morning", "afternoon", "evening"]
- dosage: the form/unit (e.g. "tablets", "capsules", "ml")
- unitsPerDose: how many units per dose (e.g. 2)
- frequency: how many times per day (e.g. 3)

Optional fields:
- strength: the strength per unit (e.g. "500mg", "250mg/5ml")
- instruction: special instructions (e.g. "Take with food", "After meals")

Examples:
  User: "Save my paracetamol prescription"
  Assistant: "Sure! What is the dosage form? (e.g. tablets, capsules)"
  User: "Tablets"
  Assistant: "How many tablets per dose?"
  ... (continue asking until all required fields are gathered, then call save_prescription)

Once saved, confirm the details to the user.`,

        parameters: {
          type: Type.OBJECT,
          properties: {
            name: {
              type: Type.STRING,
              description: "Drug/medication name (e.g. 'Amoxicillin', 'Paracetamol')",
            },
            timeSlots: {
              type: Type.ARRAY,
              items: { type: Type.STRING, enum: ["morning", "afternoon", "evening"] },
              description: "Time-of-day slots when this medication should be taken",
            },
            dosage: {
              type: Type.STRING,
              description: "Dosage form/unit (e.g. 'tablets', 'capsules', 'ml')",
            },
            unitsPerDose: {
              type: Type.NUMBER,
              description: "Number of units to take per dose (e.g. 2 for '2 tablets')",
            },
            frequency: {
              type: Type.NUMBER,
              description: "Times per day this medication should be taken (e.g. 3)",
            },
            strength: {
              type: Type.STRING,
              description: "Optional: strength per unit (e.g. '500mg', '250mg/5ml')",
            },
            instruction: {
              type: Type.STRING,
              description: "Optional: special instructions (e.g. 'Take with food')",
            },
          },
          required: ["name", "timeSlots", "dosage", "unitsPerDose", "frequency"],
        },
      },
    ],
  },
];
