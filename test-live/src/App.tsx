import { useState } from "react";
import { useAuth } from "./context/AuthContext";
import { DEFAULT_SERVER_URL } from "./lib/firebase";
import { AuthPanel } from "./components/AuthPanel";
import { EventLog } from "./components/EventLog";
import { AssistantPanel } from "./features/assistant/AssistantPanel";
import { ScannerPanel } from "./features/scanner/ScannerPanel";
import { AlertPanel } from "./features/alert/AlertPanel";

type Tab = "assistant" | "scanner" | "alert" | "auth";

const TABS: { id: Tab; label: string }[] = [
  { id: "assistant", label: "🎙 Assistant" },
  { id: "scanner", label: "📷 Scanner" },
  { id: "alert", label: "🚨 Alert" },
  { id: "auth", label: "🔑 Auth" },
];

export function App() {
  const auth = useAuth();
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("serverUrl") || DEFAULT_SERVER_URL
  );
  const [tab, setTab] = useState<Tab>(auth.uid ? "assistant" : "auth");

  const updateUrl = (v: string) => {
    setServerUrl(v);
    localStorage.setItem("serverUrl", v);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>
          Ntentan <span className="badge">Live API Tester</span>
        </h1>
        <div className="grow" />
        <div style={{ minWidth: 240 }}>
          <label>api-live server URL</label>
          <input value={serverUrl} onChange={(e) => updateUrl(e.target.value)} />
        </div>
        <div style={{ textAlign: "right" }}>
          <label>uid</label>
          <div>
            <span className={"dot " + (auth.uid ? "on" : "off")} />{" "}
            <span className="hint">{auth.uid ? `${auth.source}: ${auth.uid.slice(0, 10)}…` : "none"}</span>
          </div>
        </div>
      </header>

      <div className="body">
        <main className="main">
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {!auth.uid && tab !== "auth" && (
            <div className="panel">
              <p className="hint">
                No UID yet. Go to the <b>Auth</b> tab to enter a user UID (or sign in with Firebase).
              </p>
            </div>
          )}

          {tab === "auth" && <AuthPanel />}
          {tab === "assistant" && <AssistantPanel serverUrl={serverUrl} />}
          {tab === "scanner" && <ScannerPanel serverUrl={serverUrl} />}
          {tab === "alert" && <AlertPanel serverUrl={serverUrl} />}
        </main>

        <aside className="side">
          <EventLog />
        </aside>
      </div>
    </div>
  );
}
