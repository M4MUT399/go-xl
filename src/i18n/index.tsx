import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { translations, type Lang, LANGUAGES } from './translations';

export { LANGUAGES };
export type { Lang };

const STORAGE_KEY = '@goxl:lang';

type I18nContextValue = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, fallback?: string) => string;
};

const I18nContext = createContext<I18nContextValue>({
  lang: 'en',
  setLang: () => {},
  t: (k) => k,
});

/** Detecta o idioma do dispositivo, caindo para inglês (padrão oficial). */
function detectDeviceLang(): Lang {
  try {
    const code = getLocales()?.[0]?.languageCode?.toLowerCase();
    if (code === 'pt') return 'pt';
    if (code === 'es') return 'es';
  } catch {
    // ignore
  }
  return 'en';
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  // Carrega idioma salvo (ou detecta pelo dispositivo) no início
  useEffect(() => {
    (async () => {
      const saved = (await AsyncStorage.getItem(STORAGE_KEY)) as Lang | null;
      if (saved && translations[saved]) setLangState(saved);
      else setLangState(detectDeviceLang());
    })();
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    AsyncStorage.setItem(STORAGE_KEY, l).catch(() => {});
  }, []);

  const t = useCallback(
    (key: string, fallback?: string) =>
      translations[lang]?.[key] ?? translations.en[key] ?? fallback ?? key,
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  return useContext(I18nContext);
}
