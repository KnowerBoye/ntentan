// Firebase Web SDK init. Config comes from VITE_FIREBASE_* env vars. If they
// are absent, Firebase auth is simply disabled and the app falls back to manual
// UID entry — so the tester is usable without any Firebase setup.
import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

export const firebaseEnabled = Boolean(config.apiKey && config.authDomain && config.projectId);

let app: FirebaseApp | undefined;
let auth: Auth | undefined;

if (firebaseEnabled) {
  app = initializeApp(config as Record<string, string>);
  auth = getAuth(app);
}

/** The Auth instance, or undefined if Firebase is not configured. */
export function getFirebaseAuth(): Auth | undefined {
  return auth;
}

export const DEFAULT_SERVER_URL =
  (import.meta.env.VITE_DEFAULT_SERVER_URL as string | undefined) ?? "http://localhost:8080";
