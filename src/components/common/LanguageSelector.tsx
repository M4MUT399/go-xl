import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation, LANGUAGES, type Lang } from '../../i18n';

type Props = {
  /** Idioma selecionado. Se omitido, usa o idioma global atual. */
  value?: Lang;
  /** Disparado ao escolher um idioma. Se omitido, altera o idioma global. */
  onChange?: (lang: Lang) => void;
  label?: string;
};

/** Linha de botões para escolher o idioma (EN / ES / PT). */
export function LanguageSelector({ value, onChange, label }: Props) {
  const { colors } = useTheme();
  const { lang, setLang, t } = useTranslation();
  const selected = value ?? lang;
  const styles = makeStyles(colors);

  function choose(code: Lang) {
    setLang(code); // aplica imediatamente o idioma global
    onChange?.(code); // callback extra (ex.: persistir no perfil)
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label ?? t('register.language')}</Text>
      <View style={styles.row}>
        {LANGUAGES.map((l) => {
          const active = selected === l.code;
          return (
            <TouchableOpacity
              key={l.code}
              style={[styles.option, active && styles.optionActive]}
              onPress={() => choose(l.code)}
              activeOpacity={0.8}
            >
              <Text style={styles.flag}>{l.flag}</Text>
              <Text style={[styles.optionText, active && styles.optionTextActive]}>
                {l.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    wrap: { marginBottom: 16 },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.gray[600],
      marginBottom: 8,
    },
    row: { flexDirection: 'row', gap: 8 },
    option: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.gray[200],
      backgroundColor: colors.white,
    },
    optionActive: {
      borderColor: colors.accent,
      backgroundColor: 'rgba(201,168,76,0.12)',
    },
    flag: { fontSize: 16 },
    optionText: { fontSize: 13, fontWeight: '600', color: colors.gray[600] },
    optionTextActive: { color: colors.primary, fontWeight: '800' },
  });
}
