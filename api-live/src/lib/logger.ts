// ─────────────────────────────────────────────
//  lib/logger.ts
//  Production logging utility
// ─────────────────────────────────────────────

export const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ?? "INFO";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(
  level: LogLevel,
  message: string,
  meta?: unknown
): string {
  const timestamp = new Date().toISOString();
  const metaStr = meta !== undefined
    ? ` ${typeof meta === "object" ? JSON.stringify(meta, null, 0) : String(meta)}`
    : "";
  return `[${timestamp}] [${level.padEnd(5)}] ${message}${metaStr}`;
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) return;

  const formatted = formatMessage(level, message, meta);

  switch (level) {
    case "ERROR":
    case "FATAL":
      console.error(formatted);
      break;
    case "WARN":
      console.warn(formatted);
      break;
    default:
      console.log(formatted);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => write("DEBUG", message, meta),
  info: (message: string, meta?: unknown) => write("INFO", message, meta),
  warn: (message: string, meta?: unknown) => write("WARN", message, meta),
  error: (message: string, meta?: unknown) => write("ERROR", message, meta),
  fatal: (message: string, meta?: unknown) => write("FATAL", message, meta),
};