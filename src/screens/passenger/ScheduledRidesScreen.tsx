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
import { useScheduledRides } from '../../hooks/useRide';
import { formatCurrency, formatDistance } from '../../lib/format';
import { supabase } from '../../lib/supabase';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'ScheduledRides'> };

function isCancellationFree(scheduledFor?: string): boolean {
  if (!scheduledFor) return true;
  return new Date(scheduledFor).getTime() - Date.now() > 60 * 60 * 1000;
}

interface DriverInfo {
  name: string;
  vehicle?: string;
  plate?: string;
}

export function ScheduledRidesScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { rides, loading, refresh, activate, cancel } = useScheduledRides(profile?.id);
  const [driverInfoMap, setDriverInfoMap] = useState<Record<string, DriverInfo>>({});

  const styles = makeStyles(colors);

  useFocusEffect(
    React.useCallback(() => { refresh(); }, [refresh])
  );

  // Busca informações do motorista para corridas já confirmadas
  useEffect(() => {
    const withDriver = rides.filter((r) => r.driver_id);
    if (withDriver.length === 0) return;

    withDriver.forEach(async (ride) => {
      if (!ride.driver_id || driverInfoMap[ride.driver_id]) return;
      const [{ data: p }, { data: v }] = await Promise.all([
        supabase.from('profiles').select('full_name').eq('id', ride.driver_id).single(),
        supabase.from('vehicles').select('model,plate,color').eq('driver_id', ride.driver_id).single(),
      ]);
      const info: DriverInfo = {
        name: (p as { full_name: string } | null)?.full_name ?? 'Motorista',
        vehicle: v ? `${(v as { model: string; color: string }).model} · ${(v as { color: string }).color}` : undefined,
        plate: (v as { plate: string } | null)?.plate,
      };
      setDriverInfoMap((prev) => ({ ...prev, [ride.driver_id!]: info }));
    });
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
          '⏰ Agendamento não confirmado',
          'Nenhum motorista aceitou seu agendamento a tempo.\n\nVocê pode solicitar uma nova corrida ou agendar novamente.',
          [{ text: 'OK', style: 'default' }]
        );
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, refresh]);

  async function handleActivate(ride: RideRecord) {
    const activated = await activate(ride.id);
    if (!activated) {
      Alert.alert('Ops', 'Não foi possível iniciar a corrida. Tente novamente.');
      return;
    }
    if ((activated as Ride).driver_id) {
      // Motorista já confirmado → vai direto para corrida ativa
      navigation.navigate('ActiveRide', { ride: activated as Ride });
    } else {
      navigation.navigate('FindingDriver', { ride: activated as Ride });
    }
  }

  function handleCancel(ride: RideRecord) {
    if (!isCancellationFree(ride.scheduled_for)) {
      Alert.alert(
        '⚠️ Cancelamento com cobrança',
        'Esta corrida começa em menos de 1 hora e não pode ser cancelada gratuitamente. Se confirmar, a corrida será cobrada.',
        [
          { text: 'Não, manter', style: 'cancel' },
          { text: 'Cancelar mesmo assim', style: 'destructive', onPress: () => cancel(ride.id) },
        ]
      );
      return;
    }
    Alert.alert('Cancelar agendamento', 'Deseja remover esta corrida agendada?', [
      { text: 'Não', style: 'cancel' },
      { text: 'Sim, cancelar', style: 'destructive', onPress: () => cancel(ride.id) },
    ]);
  }

  function handleChat(ride: RideRecord, driverInfo?: DriverInfo) {
    navigation.navigate('Chat', {
      rideId: ride.id,
      title: driverInfo?.name ?? 'Motorista',
    });
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Corridas agendadas</Text>
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
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>🗓️</Text>
              <Text style={styles.emptyTitle}>Nenhuma corrida agendada</Text>
              <Text style={styles.emptyText}>Agende uma corrida ao escolher o destino na tela inicial.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const driverInfo = item.driver_id ? driverInfoMap[item.driver_id] : undefined;
            return (
              <ScheduledCard
                ride={item}
                driverInfo={driverInfo}
                onActivate={handleActivate}
                onCancel={handleCancel}
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
  ride, driverInfo, onActivate, onCancel, onChat, styles, colors,
}: {
  ride: RideRecord;
  driverInfo?: DriverInfo;
  onActivate: (r: RideRecord) => void;
  onCancel: (r: RideRecord) => void;
  onChat?: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: AppTheme;
}) {
  // Clock interno — garante que o aviso de cobrança aparece sem precisar
  // sair e voltar à tela quando a janela de 60 min for cruzada.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const when = ride.scheduled_for ? new Date(ride.scheduled_for) : null;
  const hasDriver = !!ride.driver_id;
  const minsLeft = when ? Math.floor((when.getTime() - now) / 60_000) : null;
  const canCancel = minsLeft === null || minsLeft > 60;

  return (
    <View style={[styles.card, hasDriver && styles.cardConfirmed, !canCancel && styles.cardWarning]}>

      {/* ── Cabeçalho ── */}
      <View style={styles.cardTop}>
        <Text style={styles.cardDate}>
          {when
            ? `${when.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })} • ${when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
            : 'Sem horário'}
        </Text>
        {hasDriver ? (
          <View style={styles.confirmedBadge}><Text style={styles.confirmedText}>✓ Confirmado</Text></View>
        ) : minsLeft !== null && minsLeft <= 0 ? (
          <View style={styles.dueBadge}><Text style={styles.dueText}>No horário</Text></View>
        ) : (
          <View style={styles.schBadge}><Text style={styles.schText}>⏳ Aguardando</Text></View>
        )}
      </View>

      {/* ── Aviso de cancelamento — SEMPRE VISÍVEL ── */}
      {canCancel ? (
        <View style={styles.policyFree}>
          <Text style={styles.policyFreeText}>
            🕐  Cancelamento gratuito até 60 min antes da corrida
          </Text>
        </View>
      ) : (
        <View style={styles.policyCharged}>
          <Text style={styles.policyChargedTitle}>⚠️  Atenção: cancelamento cobrado</Text>
          <Text style={styles.policyChargedBody}>
            Faltam menos de 60 minutos para esta corrida.{'\n'}
            Se cancelar agora, o valor integral de{' '}
            <Text style={styles.policyChargedValue}>{formatCurrency(ride.price)}</Text>
            {' '}será cobrado.
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
            <Text style={styles.driverName}>{driverInfo?.name ?? 'Carregando...'}</Text>
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
          <Text style={styles.chatBtnText}>💬  Falar com o motorista</Text>
        </TouchableOpacity>
      )}

      {/* ── Ações ── */}
      <View style={styles.cardActions}>
        <TouchableOpacity
          style={[styles.cancelBtn, !canCancel && styles.cancelBtnCharged]}
          onPress={() => onCancel(ride)}
        >
          <Text style={[styles.cancelBtnText, !canCancel && styles.cancelBtnTextCharged]}>
            {canCancel ? 'Cancelar' : 'Cancelar (cobrado)'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.activateBtn} onPress={() => onActivate(ride)}>
          <Text style={styles.activateBtnText}>
            {hasDriver ? 'Iniciar corrida' : 'Solicitar agora'}
          </Text>
        </TouchableOpacity>
      </View>

    </View>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
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
    driverName: { fontSize: 15, fontWeight: '700', color: colors.text },
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
    activateBtn: { flex: 2, height: 44, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    activateBtnText: { color: colors.primary, fontSize: 14, fontWeight: '800' },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
    emptyEmoji: { fontSize: 48, marginBottom: 16 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 6 },
    emptyText: { fontSize: 14, color: colors.gray[500], textAlign: 'center', paddingHorizontal: 32 },
  });
}
