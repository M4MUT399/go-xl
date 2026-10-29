import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { translations, type Lang, LANGUAGES } from './translations';

export { LANGUAGES };
export type { Lang };

const STORAGE_KEY = '@goxl:lang';
// Escolha FEITA PELO USUÁRIO num seletor que ainda não chegou ao perfil (ex.: na
// tela de Login, antes de haver sessão). O AppNavigator consome isto quando o
// perfil carrega e grava em profiles.language — é de lá que o e-mail de recibo
// tira o idioma. Sem isto o login sobrescrevia a escolha com o "en" do perfil.
const PENDING_SYNC_KEY = '@goxl:lang_pending_sync';

/** Lê e apaga a escolha explícita de idioma ainda não sincronizada com o perfil. */
export async function consumeExplicitLangChoice(): Promise<Lang | null> {
  try {
    const v = (await AsyncStorage.getItem(PENDING_SYNC_KEY)) as Lang | null;
    if (v) await AsyncStorage.removeItem(PENDING_SYNC_KEY);
    return v && translations[v] ? v : null;
  } catch {
    return null;
  }
}

type I18nContextValue = {
  lang: Lang;
  /** `explicit`: o usuário escolheu num seletor — vai para o perfil no próximo carregamento. */
  setLang: (l: Lang, opts?: { explicit?: boolean }) => void;
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

  const setLang = useCallback((l: Lang, opts?: { explicit?: boolean }) => {
    setLangState(l);
    AsyncStorage.setItem(STORAGE_KEY, l).catch(() => {});
    if (opts?.explicit) AsyncStorage.setItem(PENDING_SYNC_KEY, l).catch(() => {});
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
