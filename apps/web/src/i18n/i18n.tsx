// Marathi and Hindi for the screens site staff use (docs/wave8-plan.md step 8g.5): the daily report, muster, stores,
// quality and safety. No library: the English text is the key, each language a dictionary of the strings it has, and
// anything missing stays English. The choice is kept on the device (a site phone is one person's), defaulting to
// English. Numbers, dates, codes and names are never translated.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { DICTIONARIES } from './dict';

export type Lang = 'en' | 'mr' | 'hi';
export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'mr', label: 'मराठी' },
  { code: 'hi', label: 'हिन्दी' },
];
const KEY = 'aerolith.lang';

function stored(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'mr' || v === 'hi' ? v : 'en';
  } catch {
    return 'en';
  }
}

/** Fills {name} placeholders. */
const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;

export type T = (english: string, vars?: Record<string, string | number>) => string;

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: T }>({
  lang: 'en',
  setLang: () => {},
  t: fill,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(stored);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      // Private mode: the choice lasts this visit.
    }
  }, []);
  const value = useMemo(() => {
    const dict = lang === 'en' ? null : DICTIONARIES[lang];
    const t: T = (english, vars) => fill(dict?.[english] ?? english, vars);
    return { lang, setLang, t };
  }, [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The translator for the chosen language: `t('Save')`, `t('{n} workers', { n: 4 })`. */
export function useT(): T {
  return useContext(Ctx).t;
}

export function useLanguage() {
  const { lang, setLang } = useContext(Ctx);
  return { lang, setLang };
}
