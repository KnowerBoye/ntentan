import {z} from "zod"

export const QueryAgentSchema = z.object({
  body: z.object({
    query: z.object({
      content: z.string(),
      type: z.enum(["text", "audio"]),
    }),
    history: z.array(
      z.object({
        content: z.string(),
        type: z.enum(["text", "audio"]),
        role: z.enum(["user", "assistant"]),
        language: z.enum(["english", "twi"]),
      })
    ).default([]),
    language: z.enum(["english", "twi"]),
  }),
})
