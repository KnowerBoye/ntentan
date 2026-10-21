// ─────────────────────────────────────────────
//  lib/socket-error-handler.ts
//  Global Socket.IO error-handling utilities
// ─────────────────────────────────────────────
import { Socket } from "socket.io";
import { AppError, isOperationalError, SocketError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Standardised error payload emitted to the client.
 */
interface SocketErrorPayload {
  status: "error";
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Safely emits an error to the client only if the socket is still connected.
 */
export function emitSocketError(
  socket: Socket,
  err: Error,
  eventName: string = "error"
): void {
  if (!socket.connected) return;

  const payload: SocketErrorPayload = {
    status: "error",
    code: err instanceof AppError ? err.code : "INTERNAL_ERROR",
    message: err instanceof AppError ? err.message : "An unexpected error occurred",
  };

  // Only send details for operational (expected) errors in non-production
  if (err instanceof AppError && err.details && process.env.NODE_ENV !== "production") {
    payload.details = err.details;
  }

  socket.emit(eventName, payload);
}

/**
 * Wraps a Socket.IO event handler with global error handling.
 *
 * Usage:
 * ```
 * socket.on("message", wrapSocketHandler(socket, async (msg) => {
 *   // your logic
 * }));
 * ```
 */
export function wrapSocketHandler(
  socket: Socket,
  handler: (...args: unknown[]) => Promise<void>,
  options?: {
    disconnectOnError?: boolean;
    errorEvent?: string;
  }
) {
  const {
    disconnectOnError = false,
    errorEvent = "error",
  } = options ?? {};

  return async (...args: unknown[]): Promise<void> => {
    try {
      await handler(...args);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Log
      if (!isOperationalError(error)) {
        logger.fatal("Unhandled Socket.IO error", {
          socketId: socket.id,
          message: error.message,
          stack: error.stack,
        });
      } else {
        logger.error(error.message, {
          socketId: socket.id,
          code: error instanceof AppError ? error.code : undefined,
        });
      }

      // Notify client
      emitSocketError(socket, error, errorEvent);

      // Optionally disconnect on fatal errors
      if (disconnectOnError || !isOperationalError(error)) {
        if (socket.connected) {
          socket.disconnect(true);
        }
      }
    }
  };
}

/**
 * Handles the Socket.IO `connect_error` event on the server side
 * (e.g. when the auth middleware rejects the connection).
 */
export function handleConnectError(socket: Socket, err: Error): void {
  logger.error("Socket connection rejected", {
    socketId: socket.id,
    message: err.message,
  });

  emitSocketError(socket, err);
}

/**
 * Creates a socket-error handler that can be passed to `io.use(...)`.
 * This is used as a fallback middleware to capture any errors thrown
 * in the auth or other middleware chain.
 */
export function socketErrorMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): void {
  // If there's an error already passed from a previous middleware, log it.
  // Normally errors pass through `next(new Error(...))` which Socket.IO
  // handles as `connect_error` on the client.
  // This is a no-op pass-through that ensures we catch unhandled cases.
  try {
    next();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("Socket middleware error", {
      socketId: socket.id,
      message: error.message,
    });
    next(error);
  }
}