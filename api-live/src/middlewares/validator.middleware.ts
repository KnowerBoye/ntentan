import { NextFunction, Request, Response } from "express"
import { ZodError } from "zod"
import { InferSchema, RequestSchema } from "@/types/request-schema"
import { ValidationError } from "@/lib/errors"
import { logger } from "@/lib/logger"

export default function <T extends RequestSchema>(schema: T) {
  return function (req: Request, _res: Response, next: NextFunction) {
    try {
      const validated = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      req.validated = validated as InferSchema<T>;

      next();
    } catch (e: unknown) {
      if (e instanceof ZodError) {
        const firstIssue = e.issues[0];
        logger.warn("Validation failed", {
          path: firstIssue?.path?.join("."),
          message: firstIssue?.message,
          issues: e.issues,
        });
        next(
          new ValidationError(firstIssue?.message ?? "Invalid request data", {
            issues: e.issues,
          })
        );
      } else {
        logger.error("Unexpected validation error", { error: e });
        next(e instanceof Error ? e : new Error(String(e)));
      }
    }
  };
}
