// ─────────────────────────────────────────────
//  Language context — app-wide "en" | "tw", persisted.
//
//  Language is HANDSHAKE-BOUND on the server (read once from the socket auth at
//  connect time; there is no mid-session switch event — see the Pi client
//  contract §2.4). So the rule is: the toggle lives on Home, you set it before
//  entering a feature, and each feature reads this value when it connects. The
//  Scanner (which auto-connects) also keys its connect effect on this value, so
//  a change reconnects it with the new language.
//
//  Persisted with expo-file-system (already a dependency — no native module /
//  rebuild needed). Seeded from config.LANGUAGE on first run.
// ─────────────────────────────────────────────
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as FileSystem from "expo-file-system";
import { LANGUAGE as DEFAULT_LANGUAGE } from "../config";

export type Language = "en" | "tw";

export const LANGUAGE_LABEL: Record<Language, string> = {
  en: "English",
  tw: "Twi",
};

const FILE = FileSystem.documentDirectory + "language.txt";

interface LanguageContextValue {
  language: Language;
  setLanguage: (l: Language) => void;
  toggleLanguage: () => void;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  toggleLanguage: () => {},
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLang] = useState<Language>(DEFAULT_LANGUAGE);

  // Load the persisted choice on startup (falls back to the config default).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await FileSystem.getInfoAsync(FILE);
        if (!info.exists) return;
        const v = (await FileSystem.readAsStringAsync(FILE)).trim();
        if (!cancelled && (v === "en" || v === "tw")) setLang(v);
      } catch {
        /* no persisted value yet — keep the default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<LanguageContextValue>(() => {
    const setLanguage = (l: Language) => {
      setLang(l);
      FileSystem.writeAsStringAsync(FILE, l).catch(() => {});
    };
    return {
      language,
      setLanguage,
      toggleLanguage: () => setLanguage(language === "en" ? "tw" : "en"),
    };
  }, [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
