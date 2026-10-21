import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { getFirebaseAuth, firebaseEnabled } from "../lib/firebase";

// The api-live server runs in dev UID mode (ALLOW_UID_AUTH=true), so this app
// authenticates with a raw user UID rather than a Firebase ID token. You can
// either type a UID directly, or sign in with Firebase and use that account's
// uid — both end up as the same `uid` credential sent to the server.
interface AuthCtx {
  firebaseEnabled: boolean;
  user: User | null;
  /** The effective UID sent to api-live: manual override if set, else Firebase account uid. */
  uid: string | null;
  /** Where the current uid came from, for display. */
  source: "firebase" | "manual" | null;
  signInEmail: (email: string, password: string) => Promise<void>;
  signInGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  setManualUid: (u: string) => void;
  clearManualUid: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [manualUid, setManual] = useState<string | null>(
    () => localStorage.getItem("manualUid")
  );

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!auth) return;
    return onAuthStateChanged(auth, setUser);
  }, []);

  const value = useMemo<AuthCtx>(() => {
    const uid = manualUid ?? user?.uid ?? null;
    const source: AuthCtx["source"] = manualUid ? "manual" : user ? "firebase" : null;

    return {
      firebaseEnabled,
      user,
      uid,
      source,
      async signInEmail(email, password) {
        const auth = getFirebaseAuth();
        if (!auth) throw new Error("Firebase is not configured");
        await signInWithEmailAndPassword(auth, email, password);
      },
      async signInGoogle() {
        const auth = getFirebaseAuth();
        if (!auth) throw new Error("Firebase is not configured");
        await signInWithPopup(auth, new GoogleAuthProvider());
      },
      async signOut() {
        const auth = getFirebaseAuth();
        if (auth) await fbSignOut(auth);
      },
      setManualUid(u: string) {
        const v = u.trim();
        setManual(v || null);
        if (v) localStorage.setItem("manualUid", v);
        else localStorage.removeItem("manualUid");
      },
      clearManualUid() {
        setManual(null);
        localStorage.removeItem("manualUid");
      },
    };
  }, [user, manualUid]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within AuthProvider");
  return c;
}
