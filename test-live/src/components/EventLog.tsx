import { useEffect, useRef } from "react";
import { useLog, type LogEntry } from "../context/LogContext";

function ts(t: number): string {
  const d = new Date(t);
  return (
    d.toLocaleTimeString([], { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}
const arrow = (d: LogEntry["dir"]) => (d === "in" ? "←" : d === "out" ? "→" : "⇄");

export function EventLog() {
  const { entries, clear } = useLog();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <>
      <div className="log-head">
        <h3>Raw event log</h3>
        <span className="pill">{entries.length}</span>
        <button onClick={clear}>Clear</button>
      </div>
      <div
        className="log"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {entries.length === 0 && <div className="hint">No events yet.</div>}
        {entries.map((e) => (
          <div key={e.id} className={"ev" + (e.error ? " err" : "")}>
            <span className="t">{ts(e.ts)}</span>
            <span className={"arrow " + e.dir}>{arrow(e.dir)}</span>
            <span className="ch">{e.channel}</span>
            <span className="name">{e.name}</span>
            {e.meta && <span className="meta">{e.meta}</span>}
          </div>
        ))}
      </div>
    </>
  );
}
