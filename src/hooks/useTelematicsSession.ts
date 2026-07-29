import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoLocation from 'expo-location';
import { supabase } from '../lib/supabase';
import { reportWarning } from '../lib/errorReporting';
import { TripTelematics } from '../lib/telematics/session';

/**
 * useTelematicsSession — GRAVAÇÃO da telemetria de direção de UMA corrida (do
 * ACEITE ao ENCERRAMENTO), no modelo da Uber (Cambridge Mobile Telematics).
 *
 * Vive no DriverRideContext (Provider global, nunca desmontado): assim a sessão
 * começa no instante em que `activeRide` aparece (aceite) e é fechada quando ele
 * some (conclusão OU cancelamento), independentemente da tela em que o motorista
 * esteja. O compartilhamento é automático e o dado fica só no histórico do
 * próprio motorista (RLS dono-apenas — ver migration 0063).
 *
 * Fonte de dados: um watcher de GPS PRÓPRIO em 1 Hz (`BestForNavigation`),
 * ligado APENAS enquanto há corrida ativa — precisão que a cadência de 5 s do
 * `useLocation` do resto do app não daria para detectar freada/curva bruscas.
 *
 * Robustez: o acumulador é serializado no AsyncStorage a cada ~15 s; se o app
 * for morto no meio da corrida, ao reabrir a sessão é RETOMADA (mesmo ride) ou,
 * se a corrida já tiver acabado, é FECHADA e gravada (flush do "pendente").
 */

const PERSIST_EVERY_MS = 15_000;
/** Menos que isto de amostras = corrida sem dado útil; não grava. */
const MIN_SAMPLES_TO_RECORD = 2;

function keyFor(driverId: string): string {
  return `telematics_session:${driverId}`;
}

/**
 * Fecha a sessão e grava no Supabase (best-effort). Insere a linha da sessão e,
 * quando é a PRIMEIRA gravação dela, também os eventos. Regravações (fluxo raro
 * de restart) só atualizam os agregados — sem duplicar eventos (o cliente não
 * tem policy de DELETE).
 */
async function finalizeAndWrite(session: TripTelematics): Promise<void> {
  const snap = session.snapshot();
  if (!snap.rideId || snap.sampleCount < MIN_SAMPLES_TO_RECORD) return;

  const row = {
    driver_id: snap.driverId,
    ride_id: snap.rideId,
    started_at: new Date(snap.startedAtMs).toISOString(),
    ended_at: new Date(snap.lastAtMs).toISOString(),
    distance_km: snap.distanceKm,
    duration_min: snap.durationMin,
    score: snap.score,
    speeding_count: snap.counts.speeding,
    hard_brake_count: snap.counts.hard_brake,
    hard_accel_count: snap.counts.hard_accel,
    hard_corner_count: snap.counts.hard_corner,
    sample_count: snap.sampleCount,
  };

  try {
    // Já existe sessão para esta corrida? (idempotência de fecho após restart.)
    const { data: existing } = await supabase
      .from('driver_trip_sessions')
      .select('id')
      .eq('ride_id', snap.rideId)
      .maybeSingle();

    let sessionId = (existing as { id: string } | null)?.id ?? null;

    if (sessionId) {
      await supabase.from('driver_trip_sessions').update(row).eq('id', sessionId);
      return; // regravação: não reinsere eventos
    }

    const { data: ins, error } = await supabase
      .from('driver_trip_sessions')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      reportWarning(error, { scope: 'telematics.insertSession', rideId: snap.rideId });
      return;
    }
    sessionId = (ins as { id: string } | null)?.id ?? null;

    if (sessionId && snap.events.length > 0) {
      const events = snap.events.map((e) => ({
        session_id: sessionId,
        driver_id: snap.driverId,
        type: e.type,
        severity: e.severity,
        at_ms: e.atMs,
        lat: e.lat,
        lng: e.lng,
        speed_kmh: Math.round(e.speedKmh * 10) / 10,
      }));
      const { error: evErr } = await supabase.from('driver_telematics_events').insert(events);
      if (evErr) reportWarning(evErr, { scope: 'telematics.insertEvents', rideId: snap.rideId });
    }
  } catch (e) {
    reportWarning(e, { scope: 'telematics.finalize', rideId: snap.rideId });
  }
}

export function useTelematicsSession(driverId: string | undefined, activeRideId: string | null | undefined): void {
  const sessionRef = useRef<TripTelematics | null>(null);

  useEffect(() => {
    if (!driverId) return;
    const key = keyFor(driverId);

    // ── Sem corrida ativa: fecha a sessão em memória e qualquer "pendente" ─────
    if (!activeRideId) {
      let cancelled = false;
      (async () => {
        if (sessionRef.current) {
          await finalizeAndWrite(sessionRef.current);
          sessionRef.current = null;
        }
        // Flush de sessão órfã (app morto no meio da corrida, que já terminou).
        const raw = await AsyncStorage.getItem(key);
        if (cancelled) return;
        if (raw) {
          const dangling = TripTelematics.deserialize(raw);
          if (dangling) await finalizeAndWrite(dangling);
          await AsyncStorage.removeItem(key);
        }
      })().catch((e) => reportWarning(e, { scope: 'telematics.flushIdle' }));
      return () => {
        cancelled = true;
      };
    }

    // ── Corrida ativa: garante a sessão desta corrida e liga o watcher 1 Hz ────
    let active = true;
    let sub: ExpoLocation.LocationSubscription | null = null;
    let lastPersist = 0;

    (async () => {
      if (!sessionRef.current || sessionRef.current.id !== activeRideId) {
        // Sobrou uma sessão de OUTRA corrida em memória → fecha antes.
        if (sessionRef.current) {
          await finalizeAndWrite(sessionRef.current);
          sessionRef.current = null;
        }
        const raw = await AsyncStorage.getItem(key);
        const persisted = raw ? TripTelematics.deserialize(raw) : null;
        sessionRef.current =
          persisted && persisted.id === activeRideId
            ? persisted
            : new TripTelematics(driverId, activeRideId, Date.now());
        await AsyncStorage.setItem(key, sessionRef.current.serialize());
      }
      if (!active) return;

      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted' || !active) return;

      sub = await ExpoLocation.watchPositionAsync(
        {
          accuracy: ExpoLocation.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 0,
          mayShowUserSettingsDialog: false,
        },
        (pos) => {
          const s = sessionRef.current;
          if (!s || s.id !== activeRideId) return;
          const c = pos.coords;
          s.ingest({
            atMs: pos.timestamp,
            lat: c.latitude,
            lng: c.longitude,
            speedMps: c.speed != null && c.speed >= 0 ? c.speed : 0,
            headingDeg: c.heading != null && c.heading >= 0 ? c.heading : 0,
            accuracyM: c.accuracy != null && c.accuracy >= 0 ? c.accuracy : undefined,
          });
          const now = Date.now();
          if (now - lastPersist > PERSIST_EVERY_MS) {
            lastPersist = now;
            AsyncStorage.setItem(key, s.serialize()).catch(() => {});
          }
        },
      );
      if (!active) {
        sub.remove();
        sub = null;
      }
    })().catch((e) => reportWarning(e, { scope: 'telematics.start', rideId: activeRideId }));

    return () => {
      active = false;
      sub?.remove();
      sub = null;
      // Salva o progresso ao trocar de corrida/desmontar (retomado depois).
      const s = sessionRef.current;
      if (s) AsyncStorage.setItem(key, s.serialize()).catch(() => {});
    };
  }, [driverId, activeRideId]);
}
