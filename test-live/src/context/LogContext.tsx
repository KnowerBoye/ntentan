// A shared, app-wide event inspector. Every feature funnels its socket/HTTP
// traffic through `log(...)` so the Raw Event Log panel can show a single
// timeline of everything in and out of the api-live server.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export type Direction = "in" | "out" | "http";

export interface LogEntry {
  id: number;
  ts: number;
  dir: Direction;
  channel: string; // e.g. "assistant-live", "scanner-live", "REST"
  name: string; // event name or HTTP verb+path
  meta?: string; // short summary (e.g. "1.2 KB", status code)
  error?: boolean;
}

interface LogCtx {
  entries: LogEntry[];
  log: (e: Omit<LogEntry, "id" | "ts">) => void;
  clear: () => void;
}

const Ctx = createContext<LogCtx | null>(null);
const MAX = 500;

export function LogProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const idRef = useRef(0);

  const log = useCallback((e: Omit<LogEntry, "id" | "ts">) => {
    setEntries((prev) => {
      const next = [...prev, { ...e, id: idRef.current++, ts: Date.now() }];
      return next.length > MAX ? next.slice(next.length - MAX) : next;
    });
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  return <Ctx.Provider value={{ entries, log, clear }}>{children}</Ctx.Provider>;
}

export function useLog(): LogCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useLog must be used within LogProvider");
  return c;
}

/** Human-readable byte size for the `meta` field. */
export function sizeOf(data: unknown): string {
  try {
    if (data == null) return "";
    if (typeof data === "string") return fmtBytes(data.length);
    const json = JSON.stringify(data);
    return fmtBytes(json.length);
  } catch {
    return "";
  }
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
