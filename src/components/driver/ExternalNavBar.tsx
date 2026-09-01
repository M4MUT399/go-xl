import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useTranslation } from '../../i18n';
import {
  buildAllExternalNavLinks,
  type ExternalNavApp,
  type ExternalNavPoint,
} from '../../lib/nav/externalNav';
import {
  openExternalNav,
  type ExternalNavOutcome,
  type UrlOpener,
} from '../../lib/nav/openExternalNav';

// Ícone de link externo (quadro + seta saindo pelo canto), no mesmo desenho
// vetorial do resto do app. Diz ao motorista que o toque SAI do Go XL — a
// navegação interna continua rodando atrás.
function ExternalLinkIcon({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M15 3h6v6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M10 14 21 3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export interface ExternalNavBarProps {
  /** Ponto para onde o app externo deve navegar na fase ATUAL da corrida. */
  target: ExternalNavPoint;
  /** Injetável para teste; em produção é o `Linking` do React Native. */
  opener?: UrlOpener;
  /** Chamado com o desfecho de cada toque (telemetria/teste). */
  onOpen?: (app: ExternalNavApp, outcome: ExternalNavOutcome) => void;
}

/**
 * Barra "abrir no app de fora": Google Maps e Waze lado a lado.
 *
 * Some inteira quando a coordenada do alvo não presta (GPS sem fix, campo
 * nulo): botão que abriria o mapa em (0,0) é pior que botão nenhum.
 *
 * Os nomes NÃO passam pelo i18n de propósito — "Google Maps" e "Waze" são
 * nomes próprios e são a mesma coisa em qualquer idioma.
 */
export function ExternalNavBar({ target, opener, onOpen }: ExternalNavBarProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  // Abrir outro app leva um instante em que a tela ainda está viva e clicável;
  // sem isto o motorista nervoso dispara dois Intents/openURL seguidos.
  const [opening, setOpening] = useState<ExternalNavApp | null>(null);

  const links = buildAllExternalNavLinks(target);
  if (links.length === 0) return null;

  async function handlePress(app: ExternalNavApp, name: string) {
    if (opening) return;
    setOpening(app);
    const outcome = await openExternalNav(app, target, opener);
    setOpening(null);
    onOpen?.(app, outcome);
    // 'app' e 'web' já levaram o motorista para fora. 'invalid' não deveria
    // acontecer (a barra nem aparece), então só 'failed' vira aviso.
    if (outcome === 'failed') {
      Alert.alert(name, t('driverHome.startRouteFailed'));
    }
  }

  return (
    <View style={styles.bar}>
      {links.map((link) => (
        <TouchableOpacity
          key={link.app}
          testID={`externalNav-${link.app}`}
          style={[styles.btn, opening === link.app && styles.btnBusy]}
          onPress={() => handlePress(link.app, link.name)}
          disabled={opening != null}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={link.label ? `${link.name} — ${link.label}` : link.name}
        >
          <Text style={styles.btnText} numberOfLines={1}>
            {link.name}
          </Text>
          <ExternalLinkIcon color={colors.textSecondary} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 12,
    },
    btn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      // 48pt: alvo de toque confortável para quem está com o carro parado no
      // meio-fio, sem competir com o botão principal da tela (54pt).
      height: 48,
      borderRadius: 12,
      paddingHorizontal: 12,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    btnBusy: { opacity: 0.6 },
    btnText: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
      flexShrink: 1,
    },
  });
}
