import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList, RideRecord, Ride } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useAuth } from '../../hooks/useAuth';
import { useScheduledRides, cancelScheduledRideWithPolicy } from '../../hooks/useRide';
import { formatCurrency, formatDistance } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { useTranslation } from '../../i18n';
// A regra de cancelamento saiu daqui para src/lib/cancellation.ts: ela vale
// igual nesta tela e na de detalhes da viagem, e enquanto morou inline aqui a
// outra tela ficou sem cancelamento nenhum.
import { cancellationPolicy } from '../../lib/cancellation';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'ScheduledRides'> };

interface DriverInfo {
  name: string;
  vehicle?: string;
  plate?: string;
  rating?: number | null;
}

export function ScheduledRidesScreen({ navigation }: Props) {
  const { t } = useTranslation();
  const { profile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // `activate` NÃO é desestruturado de propósito: o passageiro não começa a
  // viagem (ver a nota abaixo e a migration 0082). Deixá-lo no escopo sem uso
  // seria convite para religarem o botão sem ler o motivo.
  // `cancel` NÃO é desestruturado: ele é o cancelamento CRU, sem política. Quem
  // cancela aqui é `cancelScheduledRideWithPolicy`, a mesma chamada da tela de
  // detalhes — duas portas do passageiro para o mesmo agendamento não podem
  // cobrar diferente.
  const { rides, loading, loadFailed, refresh } = useScheduledRides(profile?.id, profile?.jurisdiction);
  const [driverInfoMap, setDriverInfoMap] = useState<Record<string, DriverInfo>>({});
  // Id do agendamento com uma ação em voo. `activate` COBRA O CARTÃO e `cancel`
  // pode cobrar a multa da janela de 60 min — as duas passam bem dos 400 ms e
  // antes não davam nenhum retorno visual: o card ficava exatamente igual, com
  // os botões ativos, convidando o passageiro a tocar de novo (e a cobrar duas
  // vezes). Guardamos o id, e não um booleano, para travar só o card em questão.
  const [busyRideId, setBusyRideId] = useState<string | null>(null);

  const styles = makeStyles(colors);

  useFocusEffect(
    React.useCallback(() => { refresh(); }, [refresh])
  );

  // Busca nome (+nota) e veículo dos motoristas já confirmados. Espelha o padrão
  // COMPROVADO do lado do motorista (useDriverScheduledRides): uma busca EM LOTE
  // via `.in(...)` na view profiles_public — nunca `.single()` por card, que
  // falhava silenciosamente e deixava o card exibindo o fallback "Driver".
  //
  // Regra anti-cache-de-falha: só gravamos no mapa o motorista cujo NOME
  // resolveu. Se uma busca falhar (race de sessão, rede), o id fica de fora e é
  // tentado de novo no próximo refresh — em vez de grudar "Driver" pra sempre.
  useEffect(() => {
    const driverIds = Array.from(
      new Set(rides.map((r) => r.driver_id).filter((id): id is string => !!id))
    );
    if (driverIds.length === 0) return;

    let cancelled = false;
    (async () => {
      const [{ data: profs }, { data: vehs }] = await Promise.all([
        supabase.from('profiles_public').select('id, full_name, rating').in('id', driverIds),
        supabase.from('vehicles').select('driver_id, model, plate, color').in('driver_id', driverIds),
      ]);
      if (cancelled) return;

      const profById = new Map(
        ((profs as { id: string; full_name: string | null; rating: number | null }[]) ?? [])
          .map((p) => [p.id, p])
      );
      const vehByDriver = new Map(
        ((vehs as { driver_id: string; model: string | null; plate: string | null; color: string | null }[]) ?? [])
          .map((v) => [v.driver_id, v])
      );

      const next: Record<string, DriverInfo> = {};
      for (const id of driverIds) {
        const p = profById.get(id);
        if (!p || !p.full_name) continue; // sem nome → não cacheia; tenta de novo depois
        const v = vehByDriver.get(id);
        next[id] = {
          name: p.full_name,
          rating: p.rating,
          vehicle: v?.model ? `${v.model}${v.color ? ` · ${v.color}` : ''}` : undefined,
          plate: v?.plate ?? undefined,
        };
      }
      if (Object.keys(next).length > 0) {
        setDriverInfoMap((prev) => ({ ...prev, ...next }));
      }
    })();

    return () => { cancelled = true; };
  }, [rides]);

  // Realtime: detecta quando um motorista confirma uma corrida agendada.
  // Apenas atualiza a lista (para exibir o motorista confirmado) — o POPUP de
  // confirmação é responsabilidade exclusiva do useNotifications (banner in-app
  // em foreground + push em background). Disparar a notificação aqui também
  // gerava avisos duplicados para o passageiro.
  useEffect(() => {
    if (!profile?.id) return;
    const channel = supabase
      .channel(`pax-sched-${profile.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `passenger_id=eq.${profile.id}` },
        (payload) => {
          const updated = payload.new as RideRecord;
          if (
            (updated.status === 'scheduled' && updated.driver_id) ||
            (updated.status === 'accepted' && updated.driver_id)
          ) {
            refresh();
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, refresh]);

  // Broadcast: notifica o passageiro quando um agendamento expira sem motorista
  useEffect(() => {
    if (!profile?.id) return;
    const channel = supabase
      .channel(`pax-notify-${profile.id}`)
      .on('broadcast', { event: 'schedule_expired' }, () => {
        refresh();
        Alert.alert(
          t('scheduled.expiredTitle'),
          t('scheduled.expiredMessage'),
          [{ text: t('scheduled.ok'), style: 'default' }]
        );
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, refresh, t]);

  /*
   * ── O PASSAGEIRO NÃO COMEÇA A VIAGEM ──────────────────────────────────
   *
   * Aqui existia `handleActivate`, ligado a um botão neste card. Ele chamava
   * `activate(ride.id)`, que COBRAVA O CARTÃO e virava o status de
   * 'scheduled' para 'accepted' — no primeiro toque, sem confirmação alguma,
   * enquanto o botão de cancelar ao lado pedia confirmação em duas variantes.
   *
   * Em 04/09/2026 um passageiro encostou nele sem querer. A corrida agendada
   * para a noite seguinte foi cobrada e sumiu da lista dele. Ele escreveu ao
   * motorista: "I accidentally hit start trip lol and it looks like it
   * canceled the trip for tonight. It looks like it already will probably
   * bill it. I'm not sure what to do."
   *
   * Quem começa a corrida é o MOTORISTA — `confirmScheduledRide` /
   * `confirmQrScheduledRide` e o banner `scheduledBanner.startRoute`, em
   * DriverHomeScreen. Agendamento sem motorista continua no leque pelas
   * políticas do servidor (0041, 0074). Nada ficou sem caminho: o que sumiu
   * foi um atalho que só existia no lado errado do balcão.
   *
   * ⚠️ TIRAR O BOTÃO DAQUI NÃO BASTA, e é por isso que existe a migration
   * 0082: todo app já instalado continua com ele. A proibição de verdade mora
   * no servidor.
   *
   * `activate` continua exportado por useRide.ts (arquivo travado) — esta tela
   * simplesmente parou de chamá-lo.
   */

  /**
   * Antes: `onPress: () => cancel(ride.id)` — dispara e esquece. O `cancel` não
   * olhava o erro do UPDATE e não devolvia nada, então, quando o servidor
   * recusava, o card continuava na lista sem uma palavra de explicação. Num
   * cancelamento que pode custar a tarifa cheia (janela de 60 min), "não sei se
   * cancelou" é o pior estado possível. Agora esperamos a confirmação, travamos
   * o card enquanto ela não chega e dizemos quando falha.
   */
  async function runCancel(ride: RideRecord) {
    if (busyRideId) return;
    setBusyRideId(ride.id);
    // Aplica a POLÍTICA (grátis até 1h antes; tarifa integral depois) em vez do
    // cancelamento cru — a mesma chamada que a tela de detalhes usa, para as
    // duas portas do passageiro cobrarem igual.
    const r = await cancelScheduledRideWithPolicy(ride);
    await refresh();
    setBusyRideId(null);
    if (r.ok && r.charged) {
      Alert.alert(
        t('scheduled.cancelChargedTitle'),
        `${t('scheduled.policyChargedBody2')} ${formatCurrency(r.amountDollars)} ${t('scheduled.policyChargedBody3')}`,
      );
      return;
    }
    if (r.ok && 'chargeError' in r) {
      Alert.alert(t('scheduled.oops'), r.chargeError);
      return;
    }
    const ok = r.ok;
    if (!ok) {
      // PENDÊNCIA DE PRODUTO: falta uma chave `scheduled.cancelError` = "Não foi
      // possível cancelar seu agendamento. Ele continua ativo — verifique sua
      // conexão e tente de novo." Reusamos `scheduled.activateError`, o texto
      // genérico de falha desta mesma tela, porque src/i18n/translations.ts está
      // sob edição do dono e não pode receber chaves novas.
      Alert.alert(t('scheduled.oops'), t('scheduled.activateError'));
    }
  }

  function handleCancel(ride: RideRecord) {
    if (!cancellationPolicy(ride, Date.now()).free) {
      Alert.alert(
        t('scheduled.cancelChargedTitle'),
        t('scheduled.cancelChargedMessage'),
        [
          { text: t('scheduled.noKeep'), style: 'cancel' },
          { text: t('scheduled.cancelAnyway'), style: 'destructive', onPress: () => { runCancel(ride); } },
        ]
      );
      return;
    }
    Alert.alert(t('scheduled.cancelScheduleTitle'), t('scheduled.cancelScheduleMessage'), [
      { text: t('scheduled.no'), style: 'cancel' },
      { text: t('scheduled.yesCancel'), style: 'destructive', onPress: () => { runCancel(ride); } },
    ]);
  }

  function handleChat(ride: RideRecord, driverInfo?: DriverInfo) {
    navigation.navigate('Chat', {
      rideId: ride.id,
      title: driverInfo?.name ?? t('scheduled.driverFallback'),
    });
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t('scheduled.headerTitle')}</Text>
      </View>

      {loading && rides.length === 0 ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={rides}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, Platform.OS === 'android' && { paddingBottom: 24 + insets.bottom }]}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.accent} />}
          ListEmptyComponent={
            // Com a leitura falhando, "Você não tem agendamentos" é mentira: pode
            // haver viagens marcadas que o app não conseguiu ler. Trocamos o
            // texto para dizer que foi falha de carregamento — o RefreshControl
            // acima já é o caminho de tentar de novo.
            // PENDÊNCIA DE PRODUTO: o ideal seria `scheduled.loadError` = "Não
            // foi possível carregar seus agendamentos. Puxe para atualizar."
            // Reusamos `scheduled.activateError` (texto genérico de falha desta
            // tela) porque translations.ts está sob edição do dono.
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>{loadFailed ? '⚠️' : '🗓️'}</Text>
              <Text style={styles.emptyTitle}>
                {loadFailed ? t('scheduled.oops') : t('scheduled.emptyTitle')}
              </Text>
              <Text style={styles.emptyText}>
                {loadFailed ? t('scheduled.activateError') : t('scheduled.emptyText')}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const driverInfo = item.driver_id ? driverInfoMap[item.driver_id] : undefined;
            return (
              <ScheduledCard
                ride={item}
                driverInfo={driverInfo}
                onCancel={handleCancel}
                busy={busyRideId === item.id}
                onChat={item.driver_id ? () => handleChat(item, driverInfo) : undefined}
                styles={styles}
                colors={colors}
              />
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

function ScheduledCard({
  ride, driverInfo, onCancel, onChat, busy, styles, colors,
}: {
  ride: RideRecord;
  driverInfo?: DriverInfo;
  onCancel: (r: RideRecord) => void;
  onChat?: () => void;
  /** true enquanto ativar/cancelar deste card está em voo — ver `busyRideId`. */
  busy: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: AppTheme;
}) {
  const { t } = useTranslation();
  // Clock interno — garante que o aviso de cobrança aparece sem precisar
  // sair e voltar à tela quando a janela de 60 min for cruzada.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const when = ride.scheduled_for ? new Date(ride.scheduled_for) : null;
  const hasDriver = !!ride.driver_id;
  const minsLeft = when ? Math.floor((when.getTime() - now) / 60_000) : null;
  // Mesma regra do handleCancel e da tela de detalhes — `now` do relógio interno
  // do card para o aviso virar sozinho ao cruzar a janela, sem sair e voltar.
  const canCancel = cancellationPolicy(ride, now).free;

  return (
    <View style={[styles.card, hasDriver && styles.cardConfirmed, !canCancel && styles.cardWarning]}>

      {/* ── Cabeçalho ── */}
      <View style={styles.cardTop}>
        <Text style={styles.cardDate}>
          {when
            ? `${when.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })} • ${when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
            : t('scheduled.noTime')}
        </Text>
        {hasDriver ? (
          <View style={styles.confirmedBadge}><Text style={styles.confirmedText}>{t('scheduled.badgeConfirmed')}</Text></View>
        ) : minsLeft !== null && minsLeft <= 0 ? (
          <View style={styles.dueBadge}><Text style={styles.dueText}>{t('scheduled.badgeDue')}</Text></View>
        ) : (
          <View style={styles.schBadge}><Text style={styles.schText}>{t('scheduled.badgeWaiting')}</Text></View>
        )}
      </View>

      {/* ── Aviso de cancelamento — SEMPRE VISÍVEL ── */}
      {canCancel ? (
        <View style={styles.policyFree}>
          <Text style={styles.policyFreeText}>
            {t('scheduled.policyFree')}
          </Text>
        </View>
      ) : (
        <View style={styles.policyCharged}>
          <Text style={styles.policyChargedTitle}>{t('scheduled.policyChargedTitle')}</Text>
          <Text style={styles.policyChargedBody}>
            {t('scheduled.policyChargedBody1')}{'\n'}
            {t('scheduled.policyChargedBody2')}{' '}
            <Text style={styles.policyChargedValue}>{formatCurrency(ride.price)}</Text>
            {' '}{t('scheduled.policyChargedBody3')}
          </Text>
        </View>
      )}

      {/* ── Rota ── */}
      <View style={styles.route}>
        <View style={styles.routeIcons}>
          <View style={styles.dotOrigin} />
          <View style={styles.routeLine} />
          <View style={styles.dotDest} />
        </View>
        <View style={styles.routeText}>
          <Text style={styles.addr} numberOfLines={1}>{ride.origin_address}</Text>
          <Text style={[styles.addr, { marginTop: 14 }]} numberOfLines={1}>{ride.destination_address}</Text>
        </View>
      </View>

      {/* ── Motorista confirmado ── */}
      {hasDriver && (
        <View style={styles.driverCard}>
          <View style={styles.driverAvatar}>
            <Text style={styles.driverAvatarText}>{(driverInfo?.name ?? 'M')[0]}</Text>
          </View>
          <View style={styles.driverInfo}>
            <View style={styles.driverNameRow}>
              <Text style={styles.driverName} numberOfLines={1}>{driverInfo?.name ?? t('scheduled.loading')}</Text>
              {driverInfo?.rating != null && (
                <Text style={styles.driverRating}>★ {driverInfo.rating.toFixed(1)}</Text>
              )}
            </View>
            {driverInfo?.vehicle && (
              <Text style={styles.driverVehicle}>{driverInfo.vehicle}</Text>
            )}
          </View>
          {driverInfo?.plate && (
            <View style={styles.plateBox}>
              <Text style={styles.plateText}>{driverInfo.plate}</Text>
            </View>
          )}
        </View>
      )}

      {/* ── Distância / Valor ── */}
      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>{formatDistance(ride.distance_km)}</Text>
        <Text style={styles.metaPrice}>{formatCurrency(ride.price)}</Text>
      </View>

      {/* ── Chat ── */}
      {onChat && (
        <TouchableOpacity style={styles.chatBtn} onPress={onChat}>
          <Text style={styles.chatBtnText}>{t('scheduled.chatDriver')}</Text>
        </TouchableOpacity>
      )}

      {/* ── Ações ── */}
      {/*
        Só CANCELAR. O botão de ativar/começar saiu — ver a nota no topo do
        arquivo. Ele ficava aqui, à direita, colado neste; era o vizinho errado
        para uma ação que cobra o cartão sem perguntar.
      */}
      <View style={styles.cardActions}>
        <TouchableOpacity
          style={[styles.cancelBtn, styles.cancelBtnUnico, !canCancel && styles.cancelBtnCharged, busy && styles.btnBusy]}
          onPress={() => onCancel(ride)}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.cancelBtnText, !canCancel && styles.cancelBtnTextCharged]}>
              {canCancel ? t('scheduled.cancel') : t('scheduled.cancelCharged')}
            </Text>
          )}
        </TouchableOpacity>
      </View>

    </View>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    // Cancelar era metade da linha porque dividia espaço com o botão de
    // ativar. Sozinho, ocupa a linha inteira.
    cancelBtnUnico: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
    back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { fontSize: 24, color: colors.text },
    title: { fontSize: 22, fontWeight: '800', color: colors.text, marginLeft: 4 },
    list: { paddingHorizontal: 16, paddingBottom: 24, flexGrow: 1 },
    card: { backgroundColor: colors.card, borderRadius: 16, padding: 16, marginBottom: 12 },
    cardConfirmed: { borderLeftWidth: 4, borderLeftColor: colors.success },
    cardWarning: { borderLeftWidth: 4, borderLeftColor: '#ef4444' },
    cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
    cardDate: { fontSize: 15, fontWeight: '700', color: colors.text },
    schBadge: { backgroundColor: colors.gray[100], borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
    schText: { color: colors.gray[600], fontSize: 11, fontWeight: '700' },
    confirmedBadge: { backgroundColor: 'rgba(34,197,94,0.12)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
    confirmedText: { color: colors.success, fontSize: 11, fontWeight: '700' },
    dueBadge: { backgroundColor: 'rgba(201,168,76,0.15)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
    dueText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
    route: { flexDirection: 'row', marginBottom: 12 },
    routeIcons: { width: 16, alignItems: 'center', paddingTop: 4 },
    dotOrigin: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent },
    routeLine: { flex: 1, width: 2, backgroundColor: colors.gray[200], marginVertical: 3 },
    dotDest: { width: 9, height: 9, borderRadius: 2, backgroundColor: colors.primary },
    routeText: { flex: 1, marginLeft: 12 },
    addr: { fontSize: 14, color: colors.gray[800], fontWeight: '500' },
    driverCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.gray[100],
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: 'rgba(34,197,94,0.2)',
    },
    driverAvatar: {
      width: 44, height: 44, borderRadius: 22,
      backgroundColor: colors.primary,
      alignItems: 'center', justifyContent: 'center',
      marginRight: 12,
    },
    driverAvatarText: { color: colors.accent, fontSize: 18, fontWeight: '800' },
    driverInfo: { flex: 1 },
    driverNameRow: { flexDirection: 'row', alignItems: 'center' },
    driverName: { fontSize: 15, fontWeight: '700', color: colors.text, flexShrink: 1 },
    driverRating: { fontSize: 12, fontWeight: '700', color: colors.accent, marginLeft: 8 },
    driverVehicle: { fontSize: 12, color: colors.gray[500], marginTop: 2 },
    plateBox: {
      backgroundColor: colors.primary, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 5,
    },
    plateText: { color: colors.white, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
    cardMeta: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.gray[100],
      marginBottom: 14,
    },
    metaText: { fontSize: 13, color: colors.gray[500] },
    metaPrice: { fontSize: 16, fontWeight: '800', color: colors.text },
    policyFree: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 12,
      backgroundColor: 'rgba(100,116,139,0.08)',
      borderWidth: 1,
      borderColor: 'rgba(100,116,139,0.15)',
      marginBottom: 10,
    },
    policyFreeText: { color: colors.gray[600], fontSize: 12, fontWeight: '600', lineHeight: 17, flex: 1 },
    policyCharged: {
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      backgroundColor: '#fef2f2',
      borderWidth: 1.5,
      borderColor: '#ef4444',
      marginBottom: 12,
    },
    policyChargedTitle: { color: '#b91c1c', fontSize: 14, fontWeight: '800', marginBottom: 4 },
    policyChargedBody: { color: '#7f1d1d', fontSize: 13, fontWeight: '500', lineHeight: 19 },
    policyChargedValue: { color: '#b91c1c', fontWeight: '800' },
    chatBtn: {
      backgroundColor: 'rgba(201,168,76,0.12)',
      borderRadius: 12,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 10,
      borderWidth: 1,
      borderColor: 'rgba(201,168,76,0.3)',
    },
    chatBtnText: { color: colors.accent, fontSize: 14, fontWeight: '700' },
    noCancel: {
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 12,
      backgroundColor: 'rgba(239,68,68,0.06)',
      alignItems: 'center',
      marginBottom: 10,
    },
    noCancelText: { color: '#ef4444', fontSize: 12, fontWeight: '600' },
    cardActions: { flexDirection: 'row', gap: 10 },
    cancelBtn: { flex: 1, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: colors.gray[200], alignItems: 'center', justifyContent: 'center' },
    cancelBtnText: { color: colors.gray[600], fontSize: 14, fontWeight: '700' },
    cancelBtnCharged: { borderColor: 'rgba(239,68,68,0.4)', backgroundColor: 'rgba(239,68,68,0.06)' },
    cancelBtnTextCharged: { color: '#ef4444', fontSize: 13 },
    // Opacidade é o sinal de "está desabilitado" — sem ela o botão travado
    // ficava idêntico ao ativo e o toque simplesmente não fazia nada.
    btnBusy: { opacity: 0.5 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
    emptyEmoji: { fontSize: 48, marginBottom: 16 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 6 },
    emptyText: { fontSize: 14, color: colors.gray[500], textAlign: 'center', paddingHorizontal: 32 },
  });
}
