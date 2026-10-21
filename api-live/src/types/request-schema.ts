import { ZodObject,  ZodType , ZodError , z } from "zod"

export type RequestSchema = ZodObject<{
    body? : ZodType<unknown> , 
    query? : ZodType<unknown> , 
    params? : ZodType<unknown>

}>

export type InferSchema<T extends RequestSchema> = z.infer<T>;

