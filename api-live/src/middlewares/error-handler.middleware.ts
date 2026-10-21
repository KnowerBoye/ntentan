// ─────────────────────────────────────────────
//  middlewares/error-handler.middleware.ts
//  Global Express error-handling middleware
// ─────────────────────────────────────────────
import { Request, Response, NextFunction } from "express";
import { AppError, isOperationalError } from "@/lib/errors";
import { ZodError } from "zod";
import { logger } from "@/lib/logger";

/**
 * Standardised JSON error response body.
 */
interface ErrorResponse {
  status: "error";
  code: string;
  message: string;
  details?: unknown;
  stack?: string;
}

/**
 * Global Express error-handling middleware (4 params = error handler).
 *
 * MUST be registered AFTER all routes.
 */
export function globalErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // ── Log ──────────────────────────────────
  if (!isOperationalError(err)) {
    // Unexpected / programming error — log full stack
    logger.fatal("Unhandled error", {
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
  } else {
    logger.error(err.message, {
      name: err.name,
      code: err instanceof AppError ? err.code : undefined,
    });
  }

  // ── Build response ───────────────────────
  let statusCode = 500;
  let code = "INTERNAL_ERROR";
  let message = "Internal server error";
  let details: unknown = undefined;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = 422;
    code = "VALIDATION_ERROR";
    message = err.issues[0]?.message ?? "Validation failed";
    details = err.issues;
  } else if (err.name === "SyntaxError" && "body" in err) {
    // JSON parse error from express.json()
    statusCode = 400;
    code = "INVALID_JSON";
    message = "Invalid JSON in request body";
  }

  const body: ErrorResponse = {
    status: "error",
    code,
    message,
  };

  // Attach details if present (but never in production for 5xx)
  if (details !== undefined && statusCode < 500) {
    body.details = details;
  }

  // Attach stack trace in development
  if (process.env.NODE_ENV !== "production") {
    body.stack = err.stack;
  }

  res.status(statusCode).json(body);
}

/**
 * 404 handler — must be registered AFTER all routes.
 */
export function notFoundHandler(
  _req: Request,
  res: Response
): void {
  res.status(404).json({
    status: "error",
    code: "NOT_FOUND",
    message: `Route not found: ${_req.method} ${_req.originalUrl}`,
  });
}

/**
 * Wraps an async route handler so thrown errors are forwarded to Express.
 *
 * Usage:
 * ```
 * router.get("/users", asyncHandler(async (req, res) => {
 *   const user = await getUser(req.params.id);
 *   res.json(user);
 * }));
 * ```
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}