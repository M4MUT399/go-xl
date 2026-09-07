import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, Platform, Alert, ActivityIndicator,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, RideRecord } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { AppTheme } from '../../constants/theme';
import { formatCurrency, formatDistance } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { generateAndShareWaybill } from '../../lib/waybillExport';
import { tipRide, cancelScheduledRide } from '../../hooks/useRide';
import {
  TIP_PRESETS, isTipAmountValid, parseTipInput, tipEligibility, toTipCents,
} from '../../lib/tip';
import { canCancelSchedule, cancellationPolicy } from '../../lib/cancellation';

type Props = NativeStackScreenProps<RootStackParamList, 'TripDetails'>;

// Reaproveita a mesma semântica de status do histórico para manter as cores
// e os rótulos consistentes entre o card da lista e a tela de detalhes.
function statusInfo(ride: RideRecord) {
  switch (ride.status) {
    case 'completed':
      return { labelKey: 'history.statusCompleted', style: 'completed' as const };
    case 'cancelled':
      return { labelKey: 'history.statusCancelled', style: 'cancelled' as const };
    case 'scheduled':
      return { labelKey: 'history.statusScheduled', style: 'scheduled' as const };
    default:
      return { labelKey: 'history.statusInProgress', style: 'scheduled' as const };
  }
}

function fmtDateTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `${date} • ${time}`;
}

function fmtDuration(min?: number | null): string | null {
  const n = Number(min);
  if (!n || n <= 0) return null;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}min` : `${m} min`;
}

export function TripDetailsScreen({ navigation, route }: Props) {
  const { ride } = route.params;
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);

  // Bloco 4 (compliance TNC F.S. 627.748): recibo eletrônico completo pro
  // passageiro -- reaproveita 100% a infra do waybill do motorista (mesma
  // generateAndShareWaybill/PDF, ver src/lib/waybillExport.ts). Só disponível
  // pra corrida já concluída (paga).
  const receiptEnabled = useFeatureFlag('receipt_passenger_v1_enabled', profile?.jurisdiction ?? 'global');
  const [generatingReceipt, setGeneratingReceipt] = useState(false);

  async function handleReceipt() {
    if (generatingReceipt) return;
    setGeneratingReceipt(true);
    const result = await generateAndShareWaybill(ride.id, { passengerName: profile?.full_name });
    setGeneratingReceipt(false);
    if (!result.ok && result.error !== 'disabled') {
      Alert.alert(t('tripDetails.receiptUnavailableTitle'), t('tripDetails.receiptUnavailableMessage'));
    }
  }

  // ── Gorjeta retroativa ────────────────────────────────────────────────────
  // Até aqui a gorjeta só existia na `RateRideScreen`, alcançável de UM jeito:
  // a `ActiveRideScreen` navegando para lá no instante em que o status vira
  // `completed`, e só com aquela tela em foco. Passageiro com o celular
  // bloqueado no fim da corrida nunca via a tela — e não havia volta. Esta tela
  // MOSTRAVA a gorjeta quando ela existia e não oferecia nenhuma.
  //
  // A `tip-ride` publicada já aceita isto sem alteração: autoriza por
  // `passenger_id`, é idempotente e não impõe janela. O prazo é regra de
  // produto e mora em `src/lib/tip.ts` — hoje só do lado do app, o que está
  // escrito lá.
  //
  // `tipPago` guarda o valor recém-dado para a tela mudar na hora: `ride` vem
  // dos params da navegação e não é refeito.
  const [tipPago, setTipPago] = useState<number | null>(null);
  const [tipEscolhido, setTipEscolhido] = useState<number>(0);
  const [tipDigitado, setTipDigitado] = useState('');
  const [tipEnviando, setTipEnviando] = useState(false);

  const tipValor = tipDigitado.trim() ? (parseTipInput(tipDigitado) ?? 0) : tipEscolhido;
  const elegivel = tipEligibility(
    { ...ride, tip_amount: tipPago ?? ride.tip_amount },
    Date.now(),
  );

  // ── CANCELAR O AGENDAMENTO ────────────────────────────────────────────────
  //
  // Esta tela é o outro caminho do passageiro até o MESMO agendamento (aba de
  // histórico → filtro "Agendadas" → toque no card). Até aqui ela só oferecia
  // "Falar com o suporte": quem chegasse por este caminho não tinha como
  // cancelar, e concluía que não dava. A regra é a mesma da lista de
  // agendamentos, e agora mora num lugar só (src/lib/cancellation.ts).
  const [cancelado, setCancelado] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  // `cancelado` entra aqui para a tela mudar NA HORA: `ride` vem por parâmetro
  // de navegação e não é reconsultado.
  const podeCancelar = canCancelSchedule(ride) && !cancelado;
  const politica = cancellationPolicy(ride, Date.now());

  async function confirmarCancelamento() {
    if (cancelando) return;
    setCancelando(true);
    const ok = await cancelScheduledRide(ride.id);
    setCancelando(false);
    if (ok) {
      setCancelado(true);
      return;
    }
    // PENDÊNCIA DE PRODUTO: falta uma chave `scheduled.cancelError`. Reusamos
    // `scheduled.activateError`, o texto genérico de falha do fluxo de
    // agendamento, para não inventar chave nova numa tela de detalhes.
    Alert.alert(t('scheduled.oops'), t('scheduled.activateError'));
  }

  function handleCancelar() {
    // Dentro da última hora a tarifa é cobrada integralmente — o aviso tem que
    // vir ANTES, com o valor, e a confirmação tem que ser destrutiva.
    if (!politica.free) {
      Alert.alert(
        t('scheduled.cancelChargedTitle'),
        t('scheduled.cancelChargedMessage'),
        [
          { text: t('scheduled.noKeep'), style: 'cancel' },
          { text: t('scheduled.cancelAnyway'), style: 'destructive', onPress: () => { confirmarCancelamento(); } },
        ],
      );
      return;
    }
    Alert.alert(t('scheduled.cancelScheduleTitle'), t('scheduled.cancelScheduleMessage'), [
      { text: t('scheduled.no'), style: 'cancel' },
      { text: t('scheduled.yesCancel'), style: 'destructive', onPress: () => { confirmarCancelamento(); } },
    ]);
  }

  async function handleTip() {
    if (tipEnviando || !isTipAmountValid(tipValor)) return;
    setTipEnviando(true);
    const r = await tipRide(ride.id, toTipCents(tipValor));
    setTipEnviando(false);
    if (r.ok) {
      // `already_tipped` também volta `ok`: alguém gorjetou desta ou de outra
      // sessão. Marcar como pago é o desfecho certo dos dois jeitos — o que não
      // pode acontecer é a tela continuar oferecendo e o passageiro tentar de
      // novo achando que falhou.
      setTipPago(tipValor);
      setTipDigitado('');
      setTipEscolhido(0);
      return;
    }
    Alert.alert(t('rate.tipErrorTitle'), r.error || t('rate.tipErrorMessage'));
  }

  const info = statusInfo(ride);
  const isCancelled = ride.status === 'cancelled';
  const scheduled = fmtDateTime(ride.scheduled_for);
  const requested = fmtDateTime(ride.created_at);
  const accepted = fmtDateTime(ride.accepted_at);
  const completed = fmtDateTime(ride.completed_at);
  const duration = fmtDuration(ride.duration_min);

  // A gorjeta é cobrada num PaymentIntent SEPARADO da tarifa (migração 0064 e
  // supabase/functions/tip-ride), então `rides.price` NÃO a contém. Enquanto
  // esta tela mostrava só `price` sob o rótulo "Total", um passageiro que
  // gorjetou via um total menor do que o que a fatura do cartão dele cobra —
  // um "erro de cobrança" que não existe, mas gera disputa. Somamos aqui.
  const fareAmount = Number(ride.price) || 0;
  // `tipPago` entra aqui para que a gorjeta dada AGORA apareça no resumo sem
  // depender de a tela ser recarregada — `ride` vem dos params e não é refeito.
  const tipRaw = tipPago ?? (Number(ride.tip_amount) || 0);
  const tipAmount = tipRaw > 0 ? tipRaw : 0;

  // `paid = false` significa que a TARIFA não está no cartão do passageiro: ou
  // nunca foi capturada, ou foi estornada (supabase/functions/refund-ride grava
  // `paid = false` ao estornar). A gorjeta vive num PaymentIntent separado e o
  // refund-ride NÃO a estorna, então ela continua cobrada. Somar `price` num
  // total depois de um estorno faria a tela afirmar uma cobrança que já foi
  // desfeita — o passageiro compara com a fatura, não bate, e abre disputa.
  // O total só soma o que o cartão realmente reteve.
  const fareCollected = ride.paid === true;
  const totalAmount = (fareCollected ? fareAmount : 0) + tipAmount;
  // Quando a tarifa não foi retida precisamos mostrar a linha dela mesmo sem
  // gorjeta, senão o valor da corrida sumiria da tela sem explicação.
  const showFareLine = tipAmount > 0 || !fareCollected;

  // Só renderiza linhas de metadados que existem — evita "—" espalhados.
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: t('tripDetails.distance'), value: formatDistance(ride.distance_km) });
  if (duration) rows.push({ label: t('tripDetails.duration'), value: duration });
  if (scheduled) rows.push({ label: t('tripDetails.scheduledFor'), value: scheduled });
  if (requested) rows.push({ label: t('tripDetails.requestedAt'), value: requested });
  if (accepted) rows.push({ label: t('tripDetails.acceptedAt'), value: accepted });
  if (completed) rows.push({ label: t('tripDetails.completedAt'), value: completed });

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t('tripDetails.title')}</Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          Platform.OS === 'android' && { paddingBottom: 24 + insets.bottom },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Status */}
        <View style={styles.statusRow}>
          <View style={[styles.badge, styles[`badge_${info.style}`]]}>
            <Text style={[styles.badgeText, styles[`badgeText_${info.style}`]]}>{t(info.labelKey)}</Text>
          </View>
        </View>

        {/* Trajeto */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{t('tripDetails.routeSection')}</Text>
          <View style={styles.route}>
            <View style={styles.routeIcons}>
              <View style={styles.dotOrigin} />
              <View style={styles.routeLine} />
              <View style={styles.dotDest} />
            </View>
            <View style={styles.routeText}>
              <Text style={styles.stopLabel}>{t('tripDetails.pickup')}</Text>
              <Text style={styles.addr}>{ride.origin_address}</Text>
              <Text style={[styles.stopLabel, { marginTop: 18 }]}>{t('tripDetails.dropoff')}</Text>
              <Text style={styles.addr}>{ride.destination_address}</Text>
            </View>
          </View>
        </View>

        {/* Metadados da viagem */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{t('tripDetails.tripSection')}</Text>
          {rows.map((r, i) => (
            <View key={r.label} style={[styles.metaRow, i > 0 && styles.metaRowDivider]}>
              <Text style={styles.metaLabel}>{r.label}</Text>
              <Text style={styles.metaValue}>{r.value}</Text>
            </View>
          ))}
        </View>

        {/* Pagamento */}
        {!isCancelled && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>{t('tripDetails.paymentSection')}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>{t('tripDetails.paymentStatus')}</Text>
              <Text style={[styles.payTag, ride.paid ? styles.payTagPaid : styles.payTagUnpaid]}>
                {ride.paid ? t('history.paid') : t('history.unpaid')}
              </Text>
            </View>
            {/* Tarifa e gorjeta aparecem separadas quando houve gorjeta ou
                quando a tarifa não foi retida — no caso simples (paga, sem
                gorjeta) a tela fica exatamente como antes: uma linha "Total". */}
            {showFareLine && (
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>{t('rate.summaryFare')}</Text>
                <Text style={styles.metaValue}>{formatCurrency(fareAmount)}</Text>
              </View>
            )}
            {tipAmount > 0 && (
              <View style={styles.metaRow}>
                <Text style={styles.metaLabel}>{t('rate.summaryTip')}</Text>
                <Text style={styles.metaValue}>{formatCurrency(tipAmount)}</Text>
              </View>
            )}
            <View style={styles.totalRow}>
              {/* "Total com gorjeta" só é verdade quando as DUAS parcelas foram
                  cobradas. Sem a tarifa, o total é só a gorjeta e o rótulo
                  volta a ser o neutro "Total". */}
              <Text style={styles.totalLabel}>
                {fareCollected && tipAmount > 0 ? t('rate.summaryTotalWithTip') : t('tripDetails.total')}
              </Text>
              <Text style={styles.totalValue}>{formatCurrency(totalAmount)}</Text>
            </View>

            {receiptEnabled && ride.status === 'completed' && (
              <TouchableOpacity
                style={styles.receiptBtn}
                onPress={handleReceipt}
                disabled={generatingReceipt}
                accessibilityRole="button"
                accessibilityLabel={t('tripDetails.receiptA11y')}
              >
                {generatingReceipt
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Text style={styles.receiptBtnText}>{t('tripDetails.downloadReceipt')}</Text>}
              </TouchableOpacity>
            )}

            {/* Gorjeta retroativa. Só aparece quando ainda cabe: corrida
                concluída, sem gorjeta e dentro do prazo (src/lib/tip.ts).
                Fora disso não há bloco nenhum — um botão desabilitado com
                explicação seria pior do que a ausência dele, porque convida a
                tentar e depois nega. */}
            {elegivel.canTip && (
              <View style={styles.tipBox}>
                <Text style={styles.tipTitle}>{t('rate.tipTitle')}</Text>
                <Text style={styles.tipSub}>{t('rate.tipSub')}</Text>

                <View style={styles.tipPresets}>
                  {TIP_PRESETS.map((v) => {
                    const ativo = !tipDigitado.trim() && tipEscolhido === v;
                    return (
                      <TouchableOpacity
                        key={v}
                        style={[styles.tipChip, ativo && styles.tipChipOn]}
                        onPress={() => { setTipDigitado(''); setTipEscolhido(ativo ? 0 : v); }}
                        accessibilityRole="button"
                        accessibilityState={{ selected: ativo }}
                        accessibilityLabel={formatCurrency(v)}
                      >
                        <Text style={[styles.tipChipText, ativo && styles.tipChipTextOn]}>
                          {formatCurrency(v)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                  <TextInput
                    style={styles.tipInput}
                    value={tipDigitado}
                    onChangeText={(v) => { setTipDigitado(v); setTipEscolhido(0); }}
                    placeholder={t('rate.customTip')}
                    placeholderTextColor={colors.gray[400]}
                    keyboardType="decimal-pad"
                    accessibilityLabel={t('rate.customTip')}
                  />
                </View>

                <TouchableOpacity
                  style={[styles.tipBtn, !isTipAmountValid(tipValor) && styles.tipBtnOff]}
                  onPress={handleTip}
                  disabled={tipEnviando || !isTipAmountValid(tipValor)}
                  accessibilityRole="button"
                >
                  {tipEnviando
                    ? <ActivityIndicator size="small" color={colors.card} />
                    : (
                      <Text style={styles.tipBtnText}>
                        {isTipAmountValid(tipValor)
                          ? t('rate.tipPreview').replace('{amount}', formatCurrency(tipValor))
                          : t('rate.tipTitle')}
                      </Text>
                    )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Referência p/ suporte */}
        <View style={styles.idRow}>
          <Text style={styles.idLabel}>{t('tripDetails.rideId')}</Text>
          <Text style={styles.idValue}>#{ride.id.slice(0, 8).toUpperCase()}</Text>
        </View>

        {/* ── Cancelar agendamento ──
            Só para corrida ainda agendada. A política aparece SEMPRE junto do
            botão, com o valor quando houver cobrança: descobrir o custo depois
            de tocar é o que faz alguém desistir de cancelar e simplesmente não
            aparecer, que é o pior desfecho para o motorista. */}
        {podeCancelar && (
          <View style={styles.cancelBox}>
            {politica.free ? (
              <Text style={styles.cancelPolicyFree}>{t('scheduled.policyFree')}</Text>
            ) : (
              <Text style={styles.cancelPolicyCharged}>
                {t('scheduled.policyChargedBody2')}{' '}
                <Text style={styles.cancelPolicyValue}>{formatCurrency(politica.chargeDollars)}</Text>
                {' '}{t('scheduled.policyChargedBody3')}
              </Text>
            )}
            <TouchableOpacity
              style={[styles.cancelBtn, !politica.free && styles.cancelBtnCharged, cancelando && styles.cancelBtnBusy]}
              onPress={handleCancelar}
              disabled={cancelando}
              accessibilityRole="button"
            >
              {cancelando
                ? <ActivityIndicator size="small" color={colors.error} />
                : (
                  <Text style={[styles.cancelBtnText, !politica.free && styles.cancelBtnTextCharged]}>
                    {politica.free ? t('scheduled.cancel') : t('scheduled.cancelCharged')}
                  </Text>
                )}
            </TouchableOpacity>
          </View>
        )}

        {cancelado && (
          <View style={styles.cancelBox}>
            <Text style={styles.cancelDone}>{t('history.statusCancelled')}</Text>
          </View>
        )}

        <TouchableOpacity style={styles.supportBtn} onPress={() => navigation.navigate('Support')}>
          <Text style={styles.supportBtnText}>{t('tripDetails.contactSupport')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },

    cancelBox: { marginTop: 4, marginBottom: 12 },
    cancelPolicyFree: { fontSize: 13, color: colors.gray[500], marginBottom: 10, lineHeight: 18 },
    cancelPolicyCharged: { fontSize: 13, color: colors.error, marginBottom: 10, lineHeight: 18 },
    cancelPolicyValue: { fontWeight: '800' },
    cancelBtn: {
      borderRadius: 14, paddingVertical: 15, alignItems: 'center',
      borderWidth: 1, borderColor: colors.error, backgroundColor: 'transparent',
    },
    cancelBtnCharged: { backgroundColor: 'rgba(239,68,68,0.08)' },
    cancelBtnBusy: { opacity: 0.6 },
    cancelBtnText: { color: colors.error, fontSize: 15, fontWeight: '700' },
    cancelBtnTextCharged: { fontWeight: '800' },
    cancelDone: { fontSize: 14, fontWeight: '700', color: colors.error, textAlign: 'center' },
    header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
    back: { alignSelf: 'flex-start', marginBottom: 10 },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    title: { fontSize: 26, fontWeight: '800', color: colors.text },
    scroll: { paddingHorizontal: 16, paddingBottom: 32, paddingTop: 8 },

    statusRow: { flexDirection: 'row', marginBottom: 14 },
    badge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
    badge_completed: { backgroundColor: 'rgba(34,197,94,0.12)' },
    badge_cancelled: { backgroundColor: 'rgba(239,68,68,0.12)' },
    badge_scheduled: { backgroundColor: 'rgba(201,168,76,0.15)' },
    badgeText: { fontSize: 12, fontWeight: '700' },
    badgeText_completed: { color: colors.success },
    badgeText_cancelled: { color: colors.error },
    badgeText_scheduled: { color: colors.accent },

    card: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 8,
      elevation: 2,
    },
    cardLabel: {
      fontSize: 12, fontWeight: '700', color: colors.gray[500],
      letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 14,
    },

    route: { flexDirection: 'row' },
    routeIcons: { width: 16, alignItems: 'center', paddingTop: 6 },
    dotOrigin: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
    routeLine: { flex: 1, width: 2, backgroundColor: colors.gray[200], marginVertical: 4, minHeight: 40 },
    dotDest: { width: 10, height: 10, borderRadius: 2, backgroundColor: colors.primary },
    routeText: { flex: 1, marginLeft: 14 },
    stopLabel: { fontSize: 11, fontWeight: '700', color: colors.gray[400], letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3 },
    addr: { fontSize: 15, color: colors.text, fontWeight: '500' },

    metaRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingVertical: 11,
    },
    metaRowDivider: { borderTopWidth: 1, borderTopColor: colors.gray[100] },
    metaLabel: { fontSize: 14, color: colors.gray[500] },
    metaValue: { fontSize: 14, color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 12 },

    payTag: { fontSize: 12, fontWeight: '700', overflow: 'hidden', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
    payTagPaid: { color: colors.success, backgroundColor: 'rgba(34,197,94,0.12)' },
    payTagUnpaid: { color: colors.gray[500], backgroundColor: colors.gray[100] },
    totalRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.gray[100],
    },
    totalLabel: { fontSize: 15, fontWeight: '700', color: colors.text },
    totalValue: { fontSize: 22, fontWeight: '800', color: colors.primary },

    // Recibo eletrônico do passageiro (Bloco 4)
    receiptBtn: {
      marginTop: 14, paddingVertical: 12, borderRadius: 10,
      borderWidth: 1.5, borderColor: colors.primary, alignItems: 'center',
    },
    receiptBtnText: { fontSize: 14, fontWeight: '700', color: colors.primary },

    // Gorjeta retroativa
    tipBox: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.gray[100] },
    tipTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
    tipSub: { fontSize: 13, color: colors.gray[500], marginTop: 2, marginBottom: 12 },
    tipPresets: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    tipChip: {
      flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center',
      borderWidth: 1.5, borderColor: colors.gray[200],
    },
    tipChipOn: { borderColor: colors.primary, backgroundColor: 'rgba(201,168,76,0.12)' },
    tipChipText: { fontSize: 14, fontWeight: '700', color: colors.gray[500] },
    tipChipTextOn: { color: colors.primary },
    tipInput: {
      flex: 1, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 10,
      borderWidth: 1.5, borderColor: colors.gray[200],
      fontSize: 14, fontWeight: '700', color: colors.text, textAlign: 'center',
    },
    tipBtn: {
      marginTop: 12, paddingVertical: 13, borderRadius: 10,
      alignItems: 'center', backgroundColor: colors.primary,
    },
    tipBtnOff: { opacity: 0.4 },
    tipBtnText: { fontSize: 15, fontWeight: '700', color: colors.card },

    idRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingHorizontal: 4, paddingVertical: 6, marginBottom: 16,
    },
    idLabel: { fontSize: 12, color: colors.gray[400], textTransform: 'uppercase', letterSpacing: 0.5 },
    idValue: { fontSize: 13, fontWeight: '700', color: colors.gray[500], letterSpacing: 1 },

    supportBtn: {
      borderWidth: 1.5, borderColor: colors.gray[200], borderRadius: 12,
      paddingVertical: 15, alignItems: 'center',
    },
    supportBtnText: { fontSize: 15, fontWeight: '700', color: colors.primary },
  });
}
