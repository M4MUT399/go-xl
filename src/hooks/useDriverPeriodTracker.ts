import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { useFeatureFlag } from './useFeatureFlag';
import { reportWarning } from '../lib/errorReporting';
import type { Coordinates } from '../types';
import {
  initialDriverPeriodState,
  stepDriverPeriod,
  serializeDriverPeriod,
  deserializeDriverPeriod,
  type DriverPeriod,
  type DriverPeriodEvent,
  type DriverPeriodState,
  type DriverPeriodTransition,
} from '../lib/driverPeriodMachine';
import {
  DEFAULT_MILEAGE_SAMPLE,
  emptyDriverPeriodMileage,
  addDriverPeriodMileage,
  haversineMiles,
  stepMileage,
  type DriverPeriodMileage,
  type GpsPoint,
} from '../lib/driverPeriodMileage';

/**
 * useDriverPeriodTracker — integração da máquina de estados PURA de períodos
 * P0-P3 (Bloco 1, compliance F.S. 627.748; ver src/lib/driverPeriodMachine.ts
 * e src/lib/driverPeriodMileage.ts) ao app do motorista.
 *
 * Diferente de useDutyMovementTracker (samples periódicos de velocidade),
 * esta camada é EVENT-DRIVEN a partir do SERVIDOR — nunca do relógio do
 * cliente nem de estado de UI (`activeRide` do useDriverRide colapsa
 * completed/cancelled no mesmo `null`, o que não basta para distinguir o
 * `reason` da transição). Por isso o hook assina realtime diretamente em:
 *
 *   - driver_locations (UPDATE/INSERT, filtro driver_id) → WENT_ONLINE/
 *     WENT_OFFLINE, carimbados com `is_online_changed_at` (server-side,
 *     migration 0056) — não a cada ping de GPS, só quando `is_online` muda.
 *   - rides (UPDATE, filtro driver_id) → TRIP_ACCEPTED/TRIP_BOARDED/
 *     TRIP_COMPLETED/TRIP_CANCELLED, carimbados com accepted_at/boarded_at/
 *     completed_at/cancelled_at (idem, server-side).
 *
 * Reconstrução pós kill/reboot: ao (re)habilitar, além de restaurar o estado
 * do AsyncStorage, faz uma leitura pontual do estado ATUAL no servidor
 * (driver_locations.is_online + rides ativa do motorista) e replica os
 * eventos correspondentes — a máquina é idempotente a replays (ver testes de
 * driverPeriodMachine.test.ts), então isso é seguro mesmo que o estado
 * persistido já estivesse correto.
 *
 * Milhagem: cada novo `location` é passado ao acumulador puro de
 * driverPeriodMileage.ts. O resultado é creditado ao bucket do período ATUAL
 * (P0 nunca acumula) via a RPC `increment_driver_period_mileage` (incremento
 * atômico no banco — evita corrida entre pings de GPS próximos). Saltos
 * implausíveis (`needs_interpolation`) ainda não pedem rota real a
 * src/lib/routing.ts (fast-follow do Bloco 1) — por ora usamos a distância em
 * linha reta como piso conservador, marcada `estimated=true`, para nunca
 * "perder" milhagem sob perda de sinal (ver critério de aceite do comando).
 *
 * Rollout: guardado por `period_tracking_v1_enabled` (DESLIGADO por padrão).
 * Com a flag off o hook é totalmente no-op — não assina realtime, não lê/
 * escreve nada.
 *
 * @param driverId     id do motorista (chaveia persistência/assinaturas).
 * @param jurisdiction jurisdição do motorista (resolve a flag por região).
 * @param location     posição GPS atual (mesmo stream do resto do app).
 */
export function useDriverPeriodTracker(
  driverId: string | undefined,
  jurisdiction: string | undefined,
  location: Coordinates | null,
): { enabled: boolean; period: DriverPeriod; currentTripId: string | null } {
  const enabled = useFeatureFlag('period_tracking_v1_enabled', jurisdiction ?? 'global');

  const [period, setPeriod] = useState<DriverPeriod>('P0_OFFLINE');
  const [currentTripId, setCurrentTripId] = useState<string | null>(null);

  const machineRef = useRef<DriverPeriodState | null>(null);
  const loadedRef = useRef(false);
  const lastGpsRef = useRef<GpsPoint | null>(null);
  // Espelho em memória só para o "odômetro" do log de transição — não é a
  // fonte de verdade da milhagem (isso é o rollup no banco, via RPC).
  const mileageRef = useRef<DriverPeriodMileage>(emptyDriverPeriodMileage());
  // Última posição GPS conhecida — anexada a CADA evento aplicado à máquina
  // (não só ao efeito de milhagem) para que `driver_period_transitions.lat/lng`
  // registre onde o motorista estava no instante da transição, como pede o
  // cabeçalho da migration 0056. É best-effort: pode estar null logo no início
  // da sessão, antes do primeiro fix de GPS.
  const locationRef = useRef<Coordinates | null>(location);
  locationRef.current = location;

  const storageKey = driverId ? `driver_period_v1:${driverId}` : null;

  // Aplica um evento à máquina: avança estado, persiste, emite a transição
  // (se houve) à trilha imutável, e devolve o novo período/trip para a UI.
  const applyEvent = useRef<(ev: DriverPeriodEvent) => void>(() => {});
  applyEvent.current = (ev: DriverPeriodEvent) => {
    if (!driverId || !storageKey || !loadedRef.current || !machineRef.current) return;
    const { state, transition } = stepDriverPeriod(machineRef.current, ev);
    machineRef.current = state;
    setPeriod(state.period);
    setCurrentTripId(state.currentTripId);
    AsyncStorage.setItem(storageKey, serializeDriverPeriod(state)).catch(() => {});
    if (transition) emitTransition(driverId, transition, mileageRef.current);
  };

  // (Re)carrega o estado persistido e reconcilia com a verdade do servidor.
  useEffect(() => {
    if (!enabled || !driverId || !storageKey) {
      machineRef.current = null;
      loadedRef.current = false;
      lastGpsRef.current = null;
      mileageRef.current = emptyDriverPeriodMileage();
      setPeriod('P0_OFFLINE');
      setCurrentTripId(null);
      return;
    }
    let alive = true;
    loadedRef.current = false;

    (async () => {
      let state: DriverPeriodState;
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        state = deserializeDriverPeriod(raw) ?? initialDriverPeriodState(Date.now());
      } catch {
        state = initialDriverPeriodState(Date.now());
      }
      if (!alive) return;
      machineRef.current = state;
      loadedRef.current = true;
      setPeriod(state.period);
      setCurrentTripId(state.currentTripId);

      // Reconciliação: reaplica o estado ATUAL do servidor por cima do que foi
      // restaurado — idempotente (no-op se já estava em dia), cobre o caso de
      // o app ter sido morto e reaberto perdendo eventos de realtime no meio.
      try {
        const [{ data: loc }, { data: activeRide }] = await Promise.all([
          supabase
            .from('driver_locations')
            .select('is_online, is_online_changed_at')
            .eq('driver_id', driverId)
            .maybeSingle(),
          supabase
            .from('rides')
            .select('id, status, accepted_at, boarded_at')
            .eq('driver_id', driverId)
            .in('status', ['accepted', 'driver_en_route', 'in_progress'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        if (!alive) return;

        if (loc) {
          const changedAtMs = loc.is_online_changed_at ? Date.parse(loc.is_online_changed_at) : Date.now();
          applyEvent.current({
            type: loc.is_online ? 'WENT_ONLINE' : 'WENT_OFFLINE',
            atMs: Number.isFinite(changedAtMs) ? changedAtMs : Date.now(),
            lat: locationRef.current?.lat ?? null,
            lng: locationRef.current?.lng ?? null,
          });
        }

        if (activeRide) {
          const acceptedAtMs = activeRide.accepted_at ? Date.parse(activeRide.accepted_at) : Date.now();
          applyEvent.current({
            type: 'TRIP_ACCEPTED',
            atMs: Number.isFinite(acceptedAtMs) ? acceptedAtMs : Date.now(),
            tripId: activeRide.id,
            lat: locationRef.current?.lat ?? null,
            lng: locationRef.current?.lng ?? null,
          });
          if (activeRide.status === 'in_progress') {
            // boarded_at pode faltar em corridas que já estavam em andamento
            // ANTES desta migração (coluna nova) — aproxima com accepted_at
            // nesse caso transitório, documentado aqui por transparência.
            const boardedAtMs = activeRide.boarded_at
              ? Date.parse(activeRide.boarded_at)
              : acceptedAtMs;
            applyEvent.current({
              type: 'TRIP_BOARDED',
              atMs: Number.isFinite(boardedAtMs) ? boardedAtMs : Date.now(),
              tripId: activeRide.id,
              lat: locationRef.current?.lat ?? null,
              lng: locationRef.current?.lng ?? null,
            });
          }
        }
      } catch (e) {
        reportWarning(e, { scope: 'driverPeriod.reconcile' });
      }
    })();

    return () => {
      alive = false;
    };
  }, [enabled, driverId, storageKey]);

  // ─── Assinatura realtime: eventos de SERVIDOR, nunca do relógio do cliente ──
  useEffect(() => {
    if (!enabled || !driverId) return;

    const channel = supabase
      .channel(`driver-period-tracker:${driverId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'driver_locations', filter: `driver_id=eq.${driverId}` },
        (payload: { new: { is_online?: boolean; is_online_changed_at?: string | null } }) => {
          const row = payload.new;
          if (!row || typeof row.is_online !== 'boolean') return;
          const changedAtMs = row.is_online_changed_at ? Date.parse(row.is_online_changed_at) : Date.now();
          applyEvent.current({
            type: row.is_online ? 'WENT_ONLINE' : 'WENT_OFFLINE',
            atMs: Number.isFinite(changedAtMs) ? changedAtMs : Date.now(),
            lat: locationRef.current?.lat ?? null,
            lng: locationRef.current?.lng ?? null,
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `driver_id=eq.${driverId}` },
        (payload: {
          new: {
            id: string;
            status: string;
            accepted_at?: string | null;
            boarded_at?: string | null;
            completed_at?: string | null;
            cancelled_at?: string | null;
          };
        }) => {
          const ride = payload.new;
          if (!ride?.id) return;
          const at = (iso: string | null | undefined) => {
            const ms = iso ? Date.parse(iso) : Date.now();
            return Number.isFinite(ms) ? ms : Date.now();
          };
          const gps = { lat: locationRef.current?.lat ?? null, lng: locationRef.current?.lng ?? null };
          switch (ride.status) {
            case 'accepted':
              applyEvent.current({ type: 'TRIP_ACCEPTED', atMs: at(ride.accepted_at), tripId: ride.id, ...gps });
              break;
            case 'in_progress':
              applyEvent.current({ type: 'TRIP_BOARDED', atMs: at(ride.boarded_at), tripId: ride.id, ...gps });
              break;
            case 'completed':
              applyEvent.current({ type: 'TRIP_COMPLETED', atMs: at(ride.completed_at), tripId: ride.id, ...gps });
              break;
            case 'cancelled':
              applyEvent.current({ type: 'TRIP_CANCELLED', atMs: at(ride.cancelled_at), tripId: ride.id, ...gps });
              break;
            default:
              break; // 'scheduled' | 'requesting' | 'driver_en_route' (não escrito em produção)
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, driverId]);

  // ─── Milhagem: cada novo ponto de GPS alimenta o acumulador puro ───────────
  useEffect(() => {
    if (!enabled || !driverId || !location || !loadedRef.current || !machineRef.current) return;
    const point: GpsPoint = { lat: location.lat, lng: location.lng, atMs: Date.now() };
    const credit = classifyGpsStep(lastGpsRef.current, point);
    lastGpsRef.current = point;
    if (!credit) return;

    const currentPeriod = machineRef.current.period;
    mileageRef.current = addDriverPeriodMileage(mileageRef.current, currentPeriod, credit.miles, credit.estimated);

    const day = utcDateString(point.atMs);
    const p1 = currentPeriod === 'P1_AVAILABLE' ? credit.miles : 0;
    const p2 = currentPeriod === 'P2_ENROUTE' ? credit.miles : 0;
    const p3 = currentPeriod === 'P3_ONTRIP' ? credit.miles : 0;
    const estimated = credit.estimated ? credit.miles : 0;
    if (p1 === 0 && p2 === 0 && p3 === 0) return; // P0 (ou milha zero) — nada a persistir

    supabase
      .rpc('increment_driver_period_mileage', {
        p_driver_id: driverId,
        p_day: day,
        p_p1_delta: p1,
        p_p2_delta: p2,
        p_p3_delta: p3,
        p_estimated_delta: estimated,
      })
      .then(({ error }: { error: unknown }) => {
        if (error) reportWarning(error, { scope: 'driverPeriod.mileage' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, driverId, location?.lat, location?.lng]);

  return { enabled, period, currentTripId };
}

/**
 * Classifica um novo ponto de GPS contra o anterior. `needs_interpolation`
 * ainda não pede rota real (src/lib/routing.ts não está fiado aqui — Bloco 1
 * fast-follow); usamos a distância em linha reta como piso conservador
 * marcado `estimated=true`, para nunca zerar milhagem sob perda de sinal.
 */
function classifyGpsStep(
  prev: GpsPoint | null,
  curr: GpsPoint,
): { miles: number; estimated: boolean } | null {
  const outcome = stepMileage(prev, curr, DEFAULT_MILEAGE_SAMPLE);
  if (outcome.kind === 'credited') return { miles: outcome.miles, estimated: false };
  if (outcome.kind === 'needs_interpolation') {
    return { miles: haversineMiles(outcome.from, outcome.to), estimated: true };
  }
  return null; // jitter
}

function utcDateString(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Emite (append-only) uma transição de período à trilha imutável; falha em silêncio. */
function emitTransition(
  driverId: string,
  t: DriverPeriodTransition,
  mileage: DriverPeriodMileage,
): void {
  const cumulativeMiles = mileage.p1Miles + mileage.p2Miles + mileage.p3Miles;
  supabase
    .from('driver_period_transitions')
    .insert({
      driver_id: driverId,
      trip_id: t.tripId,
      from_period: t.from,
      to_period: t.to,
      reason: t.reason,
      at_ms: t.atMs,
      lat: t.lat,
      lng: t.lng,
      cumulative_miles_at_transition: Number.isFinite(cumulativeMiles) ? cumulativeMiles : null,
      mileage_estimated: mileage.estimatedMiles > 0,
    })
    .then(({ error }: { error: unknown }) => {
      if (error) reportWarning(error, { scope: 'driverPeriod.audit', reason: t.reason });
    });
}
