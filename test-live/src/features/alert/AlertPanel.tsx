import { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useLog } from "../../context/LogContext";

interface Contact {
  name: string;
  phoneNumber: string;
  success: boolean;
}

export function AlertPanel({ serverUrl }: { serverUrl: string }) {
  const { uid } = useAuth();
  const { log } = useLog();

  const [lat, setLat] = useState("5.6037");
  const [lng, setLng] = useState("-0.1870");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Contact[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function useMyLocation() {
    if (!navigator.geolocation) {
      setErr("Geolocation not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(5));
        setLng(pos.coords.longitude.toFixed(5));
      },
      (e) => setErr("Geolocation error: " + e.message)
    );
  }

  async function send() {
    if (!uid) {
      setErr("Set a user UID first (Auth tab).");
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    const path = "/api/medical-alert/send";
    const body = { latitude: Number(lat), longitude: Number(lng) };
    log({ dir: "out", channel: "REST", name: `POST ${path}`, meta: JSON.stringify(body) });
    try {
      const res = await fetch(serverUrl + path, {
        method: "POST",
        headers: { "X-User-Id": uid, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      log({
        dir: "http",
        channel: "REST",
        name: `${res.status} ${path}`,
        meta: json?.status ?? "",
        error: !res.ok,
      });
      if (!res.ok) {
        setErr(json?.message ? `${res.status}: ${json.message}` : `HTTP ${res.status}`);
        return;
      }
      setResult(json?.data?.notified_contacts ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      log({ dir: "http", channel: "REST", name: `POST ${path}`, meta: msg, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>
        Medical alert <span className="hint">POST /api/medical-alert/send</span>
      </h2>
      <div className="row">
        <div>
          <label>Latitude</label>
          <input value={lat} onChange={(e) => setLat(e.target.value)} />
        </div>
        <div>
          <label>Longitude</label>
          <input value={lng} onChange={(e) => setLng(e.target.value)} />
        </div>
      </div>
      <div className="row tight">
        <button onClick={useMyLocation}>Use my location</button>
        <button className="danger" onClick={send} disabled={busy || !uid}>
          {busy ? "Sending…" : "🚨 Send alert"}
        </button>
      </div>
      <p className="hint">
        Fans out an SMS with a Google Maps link to every emergency contact on the authenticated user’s
        profile. Requires contacts configured in Firestore and <code>MNOTIFY_API_KEY</code> on the server.
      </p>

      {err && <p className="err-text">{err}</p>}
      {result && (
        <div className="match" style={{ marginTop: ".5rem" }}>
          {result.length === 0 ? (
            <span className="hint">No contacts returned.</span>
          ) : (
            result.map((c, i) => (
              <div key={i}>
                {c.success ? "✅" : "❌"} {c.name} — {c.phoneNumber}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
