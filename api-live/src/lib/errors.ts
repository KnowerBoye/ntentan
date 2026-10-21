// ─────────────────────────────────────────────
//  lib/errors.ts
//  Custom application error classes for
//  structured, production-level error handling.
// ─────────────────────────────────────────────

/**
 * Base application error with HTTP status code support.
 * All custom errors should extend this class.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number = 500,
    options?: {
      code?: string;
      isOperational?: boolean;
      details?: unknown;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = options?.code ?? "INTERNAL_ERROR";
    this.isOperational = options?.isOperational ?? true;
    this.details = options?.details;

    // Capture stack trace, excluding constructor
    Error.captureStackTrace(this, this.constructor);
  }
}

// ─── 4xx Client Errors ───────────────────────

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super(message, 400, { code: "BAD_REQUEST", details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", details?: unknown) {
    super(message, 401, { code: "UNAUTHORIZED", details });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", details?: unknown) {
    super(message, 403, { code: "FORBIDDEN", details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details?: unknown) {
    super(message, 404, { code: "NOT_FOUND", details });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists", details?: unknown) {
    super(message, 409, { code: "CONFLICT", details });
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(message, 422, { code: "VALIDATION_ERROR", details });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests", details?: unknown) {
    super(message, 429, { code: "RATE_LIMITED", details });
  }
}

// ─── 5xx Server Errors ───────────────────────

export class InternalServerError extends AppError {
  constructor(message = "Internal server error", details?: unknown) {
    super(message, 500, {
      code: "INTERNAL_ERROR",
      isOperational: false,
      details,
    });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable", details?: unknown) {
    super(message, 503, { code: "SERVICE_UNAVAILABLE", details });
  }
}

// ─── External Service Errors ─────────────────

export class ExternalServiceError extends AppError {
  public readonly serviceName: string;

  constructor(
    serviceName: string,
    message = `${serviceName} returned an error`,
    details?: unknown
  ) {
    super(message, 502, { code: "EXTERNAL_SERVICE_ERROR", details });
    this.serviceName = serviceName;
  }
}

// ─── Socket.IO Specific ──────────────────────

export class SocketError extends AppError {
  constructor(message = "WebSocket error", code = "SOCKET_ERROR") {
    super(message, 0, { code, isOperational: true });
  }
}

// ─── Type Guard ──────────────────────────────

/**
 * Returns `true` if the given error is an operational (expected) error
 * that should be handled gracefully rather than crashing the process.
 */
export function isOperationalError(err: Error): boolean {
  if (err instanceof AppError) {
    return err.isOperational;
  }
  return false;
}