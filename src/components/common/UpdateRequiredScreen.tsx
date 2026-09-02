import React, { useCallback } from 'react';
import { Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from '../../i18n';
import { useAppUpdateGate } from '../../hooks/useAppUpdateGate';
import { textoDaTrava, type IdiomaTrava, type TextoTrava } from '../../lib/minAppVersion';
import { versaoDoApp } from '../../lib/appVersion';

/**
 * A tela de "atualize o app" — bloqueio total, sem saída lateral.
 *
 * Não há botão de fechar e não há gesto de voltar por baixo: ela é o último
 * filho do App, então cobre o navegador inteiro. Isso é deliberado. Uma build
 * abaixo do mínimo precifica corrida com a tabela velha, e o servidor cobra o
 * que ela mandar (charge-ride:466) — deixar "continuar assim mesmo" seria
 * deixar a porta aberta para o problema que a trava existe para fechar.
 *
 * ── DE ONDE VEM O TEXTO ────────────────────────────────────────────────────
 *
 * Da CONFIG (`system_config.min_app_version`), não de src/i18n/translations.ts.
 * Duas razões: o arquivo de traduções está travado neste projeto, e — a razão
 * boa — a cópia de "atualize o app" precisa poder mudar SEM uma build nova, que
 * é exatamente o que não se pode exigir de quem está preso na build velha.
 *
 * O reserva embutido é inglês, o padrão oficial do app (i18n/index.tsx). Ele só
 * aparece se a config carregou mas veio sem texto — se a config NÃO carregar, a
 * tela nem chega a ser exibida (ver useAppUpdateGate).
 */

const NAVY = '#1A1A2E';
const OURO = '#C9A84C';

const RESERVA: TextoTrava = {
  titulo: 'Update required',
  corpo: 'This version of Go XL is no longer supported. Please update to continue.',
  botao: 'Update Go XL',
};

export function UpdateRequiredScreen() {
  const { bloquear, cfg } = useAppUpdateGate();
  const { lang } = useTranslation();

  const texto = textoDaTrava(cfg, lang as IdiomaTrava, RESERVA);
  const url = Platform.OS === 'ios' ? cfg.store.ios : cfg.store.android;

  const abrirLoja = useCallback(() => {
    // `Linking.openURL` rejeita se não houver quem abra o link. Engolir é o
    // certo: a tela continua de pé com o texto, e o usuário pode ir à loja pela
    // mão. Deixar a promise estourar viraria um erro vermelho por cima do aviso.
    Linking.openURL(url).catch(() => {});
  }, [url]);

  if (!bloquear) return null;

  const versao = versaoDoApp();

  return (
    <View style={styles.fundo} testID="updateRequiredScreen">
      <View style={styles.conteudo}>
        <Text style={styles.marca}>GOXL</Text>
        <Text style={styles.titulo}>{texto.titulo}</Text>
        <Text style={styles.corpo}>{texto.corpo}</Text>

        <TouchableOpacity
          style={styles.botao}
          onPress={abrirLoja}
          testID="updateRequiredButton"
          accessibilityRole="button"
          accessibilityLabel={texto.botao}
        >
          <Text style={styles.botaoTexto}>{texto.botao}</Text>
        </TouchableOpacity>

        {/*
          A versão instalada e o mínimo exigido, em letra pequena.
          Não é enfeite: sem isto, descobrir em que build um aparelho está exige
          ir em Ajustes → Apps. Foi o que travou o diagnóstico do Motorola em
          02/09/2026 por uma rodada inteira.
        */}
        <Text style={styles.rodape}>
          {(versao ?? '—')} → {cfg.min}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fundo: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: NAVY,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  conteudo: { alignItems: 'center', maxWidth: 420 },
  marca: {
    color: OURO,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 6,
    marginBottom: 28,
  },
  titulo: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 14,
  },
  corpo: {
    color: '#C8C8D4',
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
    marginBottom: 32,
  },
  botao: {
    backgroundColor: OURO,
    paddingVertical: 16,
    paddingHorizontal: 36,
    borderRadius: 12,
    minWidth: 240,
    alignItems: 'center',
  },
  botaoTexto: { color: NAVY, fontSize: 17, fontWeight: '700' },
  rodape: { color: '#6E6E86', fontSize: 12, marginTop: 26 },
});
