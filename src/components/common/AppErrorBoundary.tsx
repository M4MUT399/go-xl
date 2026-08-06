import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { getLocales } from 'expo-localization';
import { reportError } from '../../lib/errorReporting';
import { translations, type Lang } from '../../i18n/translations';

/**
 * Rede de segurança contra crashes de renderização.
 *
 * Sem isto, qualquer exceção lançada durante o render de QUALQUER tela derruba
 * a árvore React inteira — em produção o usuário fica com uma tela branca/preta
 * travada, sem como se recuperar. Este boundary captura o erro, mostra uma tela
 * amigável e oferece "Tentar novamente", que remonta a árvore do zero.
 *
 * Propositalmente AUTOSSUFICIENTE: usa cores fixas e não consome nenhum Context
 * (tema, i18n, auth). Se o próprio provedor de tema/i18n for a causa do erro, o
 * fallback ainda precisa renderizar — por isso nada aqui pode depender deles.
 */

// Cores fixas espelhando o tema (constants/theme.ts) — NÃO importar o tema aqui.
const NAVY = '#1A1A2E';
const GOLD = '#C9A84C';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  /** Trocar a key remonta os filhos, descartando o estado quebrado. */
  resetKey: number;
}

function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  // Autossuficiente: este fallback vive ACIMA do I18nProvider (ver App.tsx),
  // então NÃO pode usar useTranslation() — o contexto cairia no default e a
  // tela de erro mostraria as chaves cruas. Resolve o idioma direto do locale
  // do aparelho (síncrono, sem Context), caindo para inglês em qualquer falha.
  let lang: Lang = 'en';
  try {
    const code = getLocales()?.[0]?.languageCode?.toLowerCase();
    if (code === 'pt') lang = 'pt';
    else if (code === 'es') lang = 'es';
  } catch {
    // ignore — mantém inglês
  }
  const t = (key: string) => translations[lang]?.[key] ?? translations.en[key] ?? key;
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: NAVY,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <Text
        style={{
          color: '#FFFFFF',
          fontSize: 22,
          fontWeight: '700',
          textAlign: 'center',
          marginBottom: 12,
        }}
      >
        {t('errorBoundary.title')}
      </Text>
      <Text
        style={{
          color: 'rgba(255,255,255,0.7)',
          fontSize: 15,
          lineHeight: 22,
          textAlign: 'center',
          marginBottom: 28,
        }}
      >
        {t('errorBoundary.message')}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={({ pressed }) => ({
          backgroundColor: GOLD,
          paddingVertical: 14,
          paddingHorizontal: 40,
          borderRadius: 12,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ color: NAVY, fontSize: 16, fontWeight: '700' }}>
          {t('errorBoundary.retry')}
        </Text>
      </Pressable>
    </View>
  );
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, resetKey: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    // Costura única de telemetria: vai para os logs nativos hoje e para o crash
    // reporter (ex.: Sentry) assim que for plugado via setErrorReporter — sem
    // mudar este call-site. O contexto passa por scrubPII antes de sair.
    const componentStack = (info as { componentStack?: string })?.componentStack;
    reportError(error, { boundary: 'AppErrorBoundary', componentStack });
  }

  private handleRetry = () => {
    this.setState((s) => ({ hasError: false, resetKey: s.resetKey + 1 }));
  };

  render() {
    if (this.state.hasError) {
      return <ErrorFallback onRetry={this.handleRetry} />;
    }

    return (
      <React.Fragment key={this.state.resetKey}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
