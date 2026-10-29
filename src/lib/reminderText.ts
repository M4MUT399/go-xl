// reminderText — texto dos lembretes LOCAIS de corrida agendada no idioma do app.
//
// passengerReminders.ts e driverReminders.ts rodam fora do React (são chamados
// por hooks com `useEffect`, sem acesso ao `t()` do I18nProvider). Em vez de
// mudar a assinatura de quem chama, lemos o MESMO idioma que o I18nProvider usa:
// a escolha salva em '@goxl:lang' e, sem ela, o idioma do aparelho — mesma regra
// de `src/i18n/index.tsx`, com fallback em inglês.
//
// Os lembretes já agendados mantêm o texto do momento em que foram criados; como
// toda sincronização cancela e recria tudo, uma troca de idioma vale a partir do
// próximo `sync*Reminders`.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { translations, type Lang } from '../i18n/translations';

/** Mesma chave de `src/i18n/index.tsx` (STORAGE_KEY). */
const LANG_STORAGE_KEY = '@goxl:lang';

function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'es' || v === 'pt';
}

function deviceLang(): Lang {
  try {
    const code = getLocales()?.[0]?.languageCode?.toLowerCase();
    if (code === 'pt' || code === 'es') return code;
  } catch {
    /* ignora */
  }
  return 'en';
}

/** Idioma atual do app: o escolhido (AsyncStorage) → o do aparelho → 'en'. */
export async function currentAppLang(): Promise<Lang> {
  try {
    const saved = await AsyncStorage.getItem(LANG_STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* cai no idioma do aparelho */
  }
  return deviceLang();
}

function tr(lang: Lang, key: string): string {
  return translations[lang]?.[key] ?? translations.en[key] ?? key;
}

export type ReminderRole = 'pax' | 'drv';
export type ReminderOffsetKey = 'h2' | 'h1' | 'm30' | 'm15';

/** Título + corpo de um lembrete. `place` vazio usa a variante sem endereço. */
export function reminderText(
  lang: Lang,
  role: ReminderRole,
  key: ReminderOffsetKey,
  place: string,
): { title: string; body: string } {
  const base = `reminderNotif.${role}.${key}`;
  return {
    title: tr(lang, `${base}.title`),
    body: place ? tr(lang, `${base}.bodyAt`).replace('{place}', place) : tr(lang, `${base}.body`),
  };
}

/** Nome do canal Android dos lembretes (aparece nas configurações do sistema). */
export function reminderChannelName(lang: Lang): string {
  return tr(lang, 'reminderNotif.channelName');
}
