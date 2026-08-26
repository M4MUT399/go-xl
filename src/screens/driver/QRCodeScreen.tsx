import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  ActivityIndicator, Share, Alert, ScrollView,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../hooks/useTheme';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation } from '../../i18n';
import { MAX_CODE_ATTEMPTS, codeFromId } from '../../lib/driverCode';
import type { RootStackParamList } from '../../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'QRCode'>;
};

/** Violação de UNIQUE no Postgres — o índice criado na migration 0069. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Quantas vezes insistir quando a GRAVAÇÃO falha (rede, RLS) — distinto de
 * `MAX_CODE_ATTEMPTS`, que conta derivações de código em caso de colisão.
 */
const MAX_WRITE_ATTEMPTS = 3;
/** Espera entre as tentativas de gravação. Curta: o motorista está na tela. */
const WRITE_BACKOFF_MS = [800, 2000];

// `codeFromId` e `MAX_CODE_ATTEMPTS` vivem em `src/lib/driverCode.ts`.
//
// Estavam AQUI, com uma terceira cópia do alfabeto canônico embutida. Duas
// consequências, ambas ruins: o literal do ESCRITOR — a única função que grava
// `profiles.driver_code` — não era comparado com o do client nem com o do
// servidor (`guard.ts`), e nenhum teste conseguia alcançá-lo, porque importar
// esta tela no Jest arrasta `react-native-qrcode-svg` e o AsyncStorage. Mover
// para `lib/` resolve os dois de uma vez; ver `driverCode.test.ts`, que fixa
// os vetores legados de `attempt = 0`.

export function QRCodeScreen({ navigation }: Props) {
  const { profile, refreshProfile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [code, setCode] = useState<string | null>(profile?.driver_code ?? null);
  const [saving, setSaving] = useState(false);

  const styles = makeStyles(colors);

  // Gera e salva o código na primeira vez que o motorista abre esta tela.
  //
  // Com o índice único da 0069, gravar pode colidir com o código de OUTRO
  // motorista. A colisão não é tratada como erro: é o caso previsto, e a saída
  // é re-derivar com sal (ver `codeFromId`) e tentar de novo.
  useEffect(() => {
    if (code || !profile?.id) return;
    const driverId = profile.id;
    let alive = true;
    setSaving(true);

    (async () => {
      // Dois contadores, e não um: `salt` avança SÓ em colisão de código
      // (23505), porque só nesse caso o código é que está errado. Falha de
      // gravação (rede, RLS) repete o MESMO candidato — gastar sal por causa de
      // Wi-Fi ruim esvaziaria as 8 derivações sem que nenhuma tivesse sido de
      // fato recusada pelo banco.
      let salt = 0;
      let writeErrors = 0;

      while (salt < MAX_CODE_ATTEMPTS) {
        const candidate = codeFromId(driverId, salt);
        // `.select()` NÃO é enfeite: desde a 0069 C.3 um trigger pode REVERTER
        // esta gravação em silêncio — sem erro, status 200 — quando o perfil
        // não é `type = 'driver'` ou quando já existe um código (o valor virou
        // imutável para o cliente). Sem ler de volta, a tela exibiria um QR que
        // não está no banco, que é o pior desfecho possível: ele resolve para
        // "código inválido" na câmera de quem escaneia, e o motorista não tem
        // como saber. O que vale é o que o servidor devolve.
        const { data, error } = await supabase
          .from('profiles')
          .update({ driver_code: candidate })
          .eq('id', driverId)
          .select('driver_code')
          .maybeSingle();

        if (!alive) return;

        if (!error) {
          const landed = (data as { driver_code?: string | null } | null)?.driver_code ?? null;

          if (!landed) {
            // Gravação revertida pelo guard. Re-salgar não ajuda — não é
            // colisão, é o perfil não ter direito a código. Não exibe QR.
            console.warn('[QRCode] driver_code revertido pelo servidor (perfil não é de motorista?)');
            setSaving(false);
            return;
          }

          // `landed` pode DIFERIR de `candidate`: é o caso de já existir um
          // código no banco que o perfil em memória não tinha. O certo é o do
          // banco — é ele que resolve.
          setCode(landed);
          refreshProfile?.();
          setSaving(false);
          return;
        }

        if (error.code === PG_UNIQUE_VIOLATION) {
          // Outro motorista já tem este código. Sala e tenta de novo.
          console.warn(`[QRCode] driver_code ${candidate} já em uso; sal ${salt + 1}`);
          salt++;
          continue;
        }

        // Qualquer outro erro (rede, RLS, coluna). Aqui a tela EXIBIA o código
        // derivado assim mesmo — e essa era a contradição: quatro linhas abaixo
        // o caminho de tentativas esgotadas se recusa a exibir código não
        // gravado, com a justificativa certa ("um QR que leva a 'código
        // inválido' é pior do que a ausência de QR"). O mesmo argumento vale
        // aqui, e com mais força: rede caindo é MUITO mais provável do que oito
        // colisões seguidas. O motorista colava no vidro um adesivo que não
        // resolve para ninguém, sem nenhum sinal de que algo falhou.
        //
        // Rede é transitória, então antes de desistir o laço espera e repete —
        // o spinner já está na tela e diz a verdade enquanto isso. Só a espera
        // é nova; a decisão de não exibir é a mesma do bloco final.
        writeErrors++;
        console.warn(`[QRCode] erro ao salvar driver_code (falha ${writeErrors}):`, error.message);
        if (writeErrors >= MAX_WRITE_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, WRITE_BACKOFF_MS[writeErrors - 1] ?? 2000));
        if (!alive) return;
      }

      // Duas saídas caem aqui: as 8 derivações colidiram (base absurdamente
      // densa, ou bug em `codeFromId`), ou a gravação falhou nas três
      // tentativas. Nos dois casos NÃO existe código gravado, e a tela não
      // exibe QR: um adesivo que resolve para "código inválido" na câmera do
      // passageiro é pior do que a ausência de QR, e o motorista não teria como
      // descobrir sozinho.
      //
      // PENDÊNCIA DE PRODUTO: hoje o desfecho é a área do QR ficar vazia, sem
      // texto. O certo é uma mensagem com botão de repetir, e ela precisa de
      // chaves novas em `src/i18n/translations.ts` — arquivo em edição pelo
      // dono e por isso não tocado aqui.
      if (!alive) return;
      console.warn('[QRCode] nenhum driver_code gravado; QR não será exibido');
      setSaving(false);
    })();

    return () => { alive = false; };
  }, [profile?.id]);

  /** URL que o QR code vai codificar.
   *
   *  Agora é uma landing **https** (goxl.app/qr?driver=CODE) em vez do custom
   *  scheme direto. Motivo: a câmera nativa (iOS/Android) e qualquer leitor de
   *  QR abrem https sem atrito, mesmo em quem **não** tem o app. A landing:
   *   • se o app está instalado → faz o "bounce" para goxl://ride?driver=CODE
   *     (mesmo padrão da página /track), e o AppNavigator trava a corrida;
   *   • se NÃO está instalado → grava `goxl-ride:CODE` no clipboard (deferred
   *     deep link) e manda para a loja; no 1º open o app lê o clipboard e trava
   *     a corrida no motorista dono do QR.
   *  Ver src/lib/deferredDeepLink.ts e go-xl-site/qr/index.html.
   */
  const deepLink = code ? `https://goxl.app/qr?driver=${code}` : null;

  const handleShare = useCallback(async () => {
    if (!deepLink || !code) return;
    try {
      await Share.share({
        message: t('qr.shareMessage')
          .replace('{code}', code)
          .replace('{deepLink}', deepLink),
        title: t('qr.shareTitle'),
      });
    } catch {
      // usuário cancelou
    }
  }, [deepLink, code]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t('qr.title')}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          {/* Título do card */}
          <Text style={styles.cardTitle}>Go<Text style={{ color: colors.accent }}>XL</Text></Text>
          <Text style={styles.cardSub}>Executive XL</Text>

          {/* QR Code */}
          <View style={styles.qrWrapper}>
            {saving ? (
              <ActivityIndicator color={colors.accent} size="large" />
            ) : deepLink ? (
              <QRCode
                value={deepLink}
                size={200}
                color={colors.primary}
                backgroundColor={colors.white}
                logo={undefined}
              />
            ) : null}
          </View>

          {/* Código legível */}
          {code && (
            <View style={styles.codeBox}>
              <Text style={styles.codeLabel}>{t('qr.codeLabel')}</Text>
              <Text style={styles.codeValue}>{code}</Text>
            </View>
          )}

          {/* Motorista */}
          <Text style={styles.driverName}>{profile?.full_name}</Text>
          <Text style={styles.category}>Executive XL — Go XL</Text>
        </View>

        {/* Instruções */}
        <View style={styles.instructions}>
          <Text style={styles.instrTitle}>{t('qr.howItWorks')}</Text>

          <View style={styles.instrItem}>
            <Text style={styles.instrIcon}>📱</Text>
            <Text style={styles.instrText}>
              {t('qr.step1')}
            </Text>
          </View>

          <View style={styles.instrItem}>
            <Text style={styles.instrIcon}>⬇️</Text>
            <Text style={styles.instrText}>
              {t('qr.step2')}
            </Text>
          </View>

          <View style={styles.instrItem}>
            <Text style={styles.instrIcon}>🔒</Text>
            <Text style={styles.instrText}>
              {t('qr.step3')}
            </Text>
          </View>

          <View style={styles.instrItem}>
            <Text style={styles.instrIcon}>✅</Text>
            <Text style={styles.instrText}>
              {t('qr.step4')}
            </Text>
          </View>
        </View>

        {/* Botão compartilhar */}
        <TouchableOpacity style={styles.shareBtn} onPress={handleShare} disabled={!code}>
          <Text style={styles.shareBtnText}>📤  {t('qr.shareButton')}</Text>
        </TouchableOpacity>

        <Text style={styles.note}>
          {t('qr.note')}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.gray[100],
    },
    back: { marginRight: 16, padding: 4 },
    backText: { fontSize: 24, color: colors.primary },
    title: { fontSize: 20, fontWeight: '700', color: colors.text },
    scroll: { padding: 16, alignItems: 'center' },

    card: {
      backgroundColor: colors.card,
      borderRadius: 24,
      padding: 28,
      alignItems: 'center',
      width: '100%',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 16,
      elevation: 4,
      marginBottom: 24,
    },
    cardTitle: { fontSize: 28, fontWeight: '900', color: colors.text, letterSpacing: -1 },
    cardSub: { fontSize: 12, color: colors.accent, fontWeight: '600', marginBottom: 20, letterSpacing: 1 },

    qrWrapper: {
      padding: 16,
      backgroundColor: colors.white,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.gray[100],
      marginBottom: 20,
      minWidth: 232,
      minHeight: 232,
      alignItems: 'center',
      justifyContent: 'center',
    },

    codeBox: {
      backgroundColor: colors.primary,
      borderRadius: 12,
      paddingHorizontal: 24,
      paddingVertical: 10,
      alignItems: 'center',
      marginBottom: 16,
    },
    codeLabel: { fontSize: 10, color: colors.accent, fontWeight: '700', letterSpacing: 2, marginBottom: 2 },
    codeValue: { fontSize: 28, fontWeight: '900', color: colors.white, letterSpacing: 6 },

    driverName: { fontSize: 16, fontWeight: '700', color: colors.text },
    category: { fontSize: 12, color: colors.gray[500], marginTop: 4 },

    instructions: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      width: '100%',
      marginBottom: 20,
    },
    instrTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: 14 },
    instrItem: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-start' },
    instrIcon: { fontSize: 18, marginRight: 12, lineHeight: 24 },
    instrText: { flex: 1, fontSize: 13, color: colors.gray[600], lineHeight: 20 },

    shareBtn: {
      backgroundColor: colors.accent,
      borderRadius: 16,
      paddingVertical: 16,
      paddingHorizontal: 32,
      width: '100%',
      alignItems: 'center',
      marginBottom: 14,
    },
    shareBtnText: { fontSize: 15, fontWeight: '800', color: colors.primary },

    note: { fontSize: 12, color: colors.gray[400], textAlign: 'center', paddingHorizontal: 24 },
  });
}
