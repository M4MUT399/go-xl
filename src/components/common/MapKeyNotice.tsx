import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import Constants from 'expo-constants';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useTranslation } from '../../i18n';
import { reportWarning } from '../../lib/errorReporting';
import { diagnoseMapsKey } from '../../lib/mapsDiagnostics';

/**
 * Aviso sobre o mapa em branco no Android.
 *
 * Hoje o motorista vê um retângulo branco com a marca d'água "Google" e não tem
 * nenhuma pista do que aconteceu — nem ele, nem quem dá suporte. Este overlay
 * cobre o caso que o app consegue provar de dentro: a chave do Maps não entrou
 * no build (ver src/lib/mapsDiagnostics.ts para os outros caminhos, que exigem
 * logcat/console do Google e não podem ser detectados daqui).
 *
 * Também deixa o registro em `reportWarning` — quando um crash reporter for
 * plugado (errorReporting.ts:20-31), esta condição passa a chegar sozinha, sem
 * depender de o motorista relatar.
 *
 * ─── SOBRE O IDIOMA DA SEGUNDA LINHA ────────────────────────────────────────
 * A primeira linha é composta de chaves que já existem em en/es/pt
 * (`nav.map` + `payment.loadErrorTitle`) — `src/i18n/translations.ts` está
 * travado e não pode receber chave nova. A segunda é técnica e fica em inglês
 * de propósito: ela não é para o motorista resolver, é o que faz o dono achar a
 * causa em dez segundos em vez de abrir um chamado. Erro de configuração de
 * build não tem tradução útil.
 */
export function MapKeyNotice() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = criarEstilos(colors);

  const androidKey = (Constants.expoConfig as
    | { android?: { config?: { googleMaps?: { apiKey?: unknown } } } }
    | null
    | undefined)?.android?.config?.googleMaps?.apiKey;
  const diagnostico = diagnoseMapsKey(Platform.OS, androidKey);

  useEffect(() => {
    if (diagnostico !== 'missing') return;
    reportWarning('mapa do Android sem chave do Google Maps no build', {
      scope: 'mapsDiagnostics',
      // Sem valor de chave nenhum no contexto — nem quando ela existe.
      envEsperada: 'EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY',
    });
  }, [diagnostico]);

  if (diagnostico !== 'missing') return null;

  return (
    <View style={styles.caixa} pointerEvents="none" testID="mapKeyNotice">
      <Text style={styles.titulo}>{`${t('nav.map')}: ${t('payment.loadErrorTitle')}`}</Text>
      <Text style={styles.detalhe}>
        Google Maps Android key missing in this build (EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY).
      </Text>
    </View>
  );
}

const criarEstilos = (colors: AppTheme) =>
  StyleSheet.create({
    caixa: {
      position: 'absolute',
      top: '42%',
      left: 24,
      right: 24,
      padding: 14,
      borderRadius: 12,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
    },
    titulo: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.text,
      textAlign: 'center',
    },
    detalhe: {
      marginTop: 6,
      fontSize: 12,
      color: colors.textSecondary,
      textAlign: 'center',
    },
  });
