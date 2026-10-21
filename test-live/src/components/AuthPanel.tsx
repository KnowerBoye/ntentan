import { useState } from "react";
import { useAuth } from "../context/AuthContext";

export function AuthPanel() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Authentication <span className="hint">(dev UID mode)</span></h2>
      <p className="hint" style={{ marginTop: "-0.4rem" }}>
        api-live runs with <code>ALLOW_UID_AUTH=true</code>, so you authenticate with a raw
        user UID — no token needed. Type a UID, or sign in with Firebase to use that account’s uid.
      </p>

      {auth.uid ? (
        <>
          <div className="row tight" style={{ alignItems: "center" }}>
            <span className="pill">source: {auth.source}</span>
            {auth.user && <span className="hint">{auth.user.email ?? auth.user.uid}</span>}
          </div>
          <p className="hint" style={{ wordBreak: "break-all", marginTop: ".4rem" }}>
            uid: <code>{auth.uid}</code>
          </p>
          <div className="row tight">
            {auth.source === "manual" ? (
              <button onClick={auth.clearManualUid}>Clear UID</button>
            ) : (
              <button className="danger" onClick={() => run(auth.signOut)} disabled={busy}>
                Sign out
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: ".75rem" }}>
            <label>User UID</label>
            <input
              placeholder="e.g. a Firestore users/{uid} document id"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && manual.trim() && auth.setManualUid(manual)}
            />
            <div className="row tight" style={{ marginTop: ".4rem" }}>
              <button className="primary" disabled={!manual.trim()} onClick={() => auth.setManualUid(manual)}>
                Use this UID
              </button>
            </div>
          </div>

          {auth.firebaseEnabled ? (
            <>
              <p className="hint">…or sign in with Firebase to use that account’s uid:</p>
              <div className="row">
                <div>
                  <label>Email</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
                </div>
                <div>
                  <label>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              </div>
              <div className="row tight">
                <button
                  disabled={busy || !email || !password}
                  onClick={() => run(() => auth.signInEmail(email, password))}
                >
                  Sign in
                </button>
                <button disabled={busy} onClick={() => run(auth.signInGoogle)}>
                  Sign in with Google
                </button>
              </div>
            </>
          ) : (
            <p className="hint">
              (Firebase sign-in is off — set <code>VITE_FIREBASE_*</code> in <code>.env</code> to enable it.)
            </p>
          )}
        </>
      )}

      {err && <p className="err-text">{err}</p>}
    </div>
  );
}
