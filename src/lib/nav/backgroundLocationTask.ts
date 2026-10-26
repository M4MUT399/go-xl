// backgroundLocationTask — Fase 5b (Nav): publica a posição do motorista em
// BACKGROUND (app minimizado/tela bloqueada) durante uma corrida ativa, para o
// passageiro não perder o motorista de vista. Espelha o padrão já usado em
// backgroundNotifications.ts (Camada 2 de revogação): `TaskManager.defineTask`
// no escopo do MÓDULO, registrado como efeito colateral de import bem cedo
// (index.ts), ANTES de o SO poder invocar a task.
//
// Por que TaskManager e não o hook useNavigationLocation: hooks React só rodam
// com a tela montada e o app em FOREGROUND. Em background o SO relança/mantém
// vivo o processo pela razão declarada no plugin expo-location — a task abaixo
// é o único código que roda nessa janela.
//
// Contexto da corrida ativa (rideId/driverId) fica em AsyncStorage, não em
// variável de módulo: a TaskManager invoca a task fora do ciclo de vida do
// React (sem acesso a state/props) e, no iOS, o processo pode ser suspenso e
// relançado entre fixes — só o disco sobrevive a isso.
//
// Cadência: reaproveita `shouldPublishFix` + `DEFAULT_BACKGROUND_PUBLISH_GATE`
// (publishGate.ts) — mesma regra pura já testada em foreground, só que com
// piso/heartbeat/distância mais folgados (ver comentário lá). O último fix
// publicado também vai para o AsyncStorage (não memória) pelo mesmo motivo do
// contexto: sobreviver a um relançamento do processo sem floodar de novo.
//
// Best-effort by design: qualquer falha (permissão negada, Expo Go, escrita ao
// Supabase sem rede) é engolida silenciosamente — a publicação de FOREGROUND
// (DriverNavigateScreen) continua funcionando normalmente e é a fonte principal
// enquanto a tela está aberta; o background é só o complemento para quando o
// app sai de tela.
//
// MODO ONLINE (26/10/2026). A task também roda com o motorista ONLINE e SEM
// corrida (`rideId: null`), publicando só `driver_locations`. Sem isso, quem
// ficava online e guardava o celular parava de carimbar `updated_at` e sumia
// do leque de despacho — em outubro, 10 de 12 pedidos imediatos foram
// oferecidos a zero motoristas. O DriverRideContext liga/desliga este modo
// junto com a chave online; a corrida (DriverNavigateScreen) se sobrepõe a ele
// e, ao terminar, devolve a task ao modo online em vez de parar o GPS.

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { supabase } from '../supabase';
import {
  shouldPublishFix,
  DEFAULT_BACKGROUND_PUBLISH_GATE,
  IDLE_BACKGROUND_PUBLISH_GATE,
  type PublishMark,
} from './publishGate';

/** Nome único da task de localização em background. */
export const BACKGROUND_LOCATION_TASK = 'goxl-driver-background-location';

const CONTEXT_KEY = '@goxl/bg_location_context';
const LAST_MARK_KEY = '@goxl/bg_location_last_mark';
/** Presente enquanto o motorista está ONLINE — guarda o contexto ocioso para voltar a ele quando a corrida acabar. */
const ONLINE_KEY = '@goxl/bg_location_online';

export interface BgLocationContext {
  /** `null` = motorista online sem corrida: publica só driver_locations. */
  rideId: string | null;
  driverId: string;
  /** Título/corpo da notificação persistente do Android (foreground service), já traduzidos pelo chamador. */
  notifTitle: string;
  notifBody: string;
}

async function readContext(): Promise<BgLocationContext | null> {
  try {
    const raw = await AsyncStorage.getItem(CONTEXT_KEY);
    return raw ? (JSON.parse(raw) as BgLocationContext) : null;
  } catch {
    return null;
  }
}

async function readLastMark(): Promise<PublishMark | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_MARK_KEY);
    return raw ? (JSON.parse(raw) as PublishMark) : null;
  } catch {
    return null;
  }
}

async function writeLastMark(mark: PublishMark): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_MARK_KEY, JSON.stringify(mark));
  } catch {
    // best-effort — nunca deve derrubar a task
  }
}

// A definição da task PRECISA acontecer no escopo do módulo (topo), antes de o
// SO poder invocá-la ao lançar o app em background. Por isso este módulo é
// importado cedo em index.ts (efeito colateral de import) — mesmo padrão de
// backgroundNotifications.ts.
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  const fix = locations?.[locations.length - 1];
  if (!fix) return;

  const ctx = await readContext();
  if (!ctx) return; // nenhuma corrida ativa registrada — nada a publicar (task órfã)

  const next = { lat: fix.coords.latitude, lng: fix.coords.longitude };
  const now = fix.timestamp ?? Date.now();
  const last = await readLastMark();
  const gate = ctx.rideId ? DEFAULT_BACKGROUND_PUBLISH_GATE : IDLE_BACKGROUND_PUBLISH_GATE;
  if (!shouldPublishFix(last, next, now, gate)) return;

  const mark: PublishMark = { lat: next.lat, lng: next.lng, atMs: now };
  await writeLastMark(mark);

  const heading =
    fix.coords.heading != null && fix.coords.heading >= 0 ? fix.coords.heading : null;

  const rideId = ctx.rideId;
  try {
    const locationWrite = supabase.from('driver_locations').upsert({
      driver_id: ctx.driverId,
      lat: next.lat,
      lng: next.lng,
      heading,
      is_online: true,
      updated_at: new Date().toISOString(),
    });
    if (!rideId) {
      await locationWrite;
      return;
    }
    await Promise.all([
      locationWrite,
      supabase
        .from('rides')
        .update({
          driver_lat: next.lat,
          driver_lng: next.lng,
          driver_heading: heading,
          // Mesmo carimbo do publicador de primeiro plano — ver migração 0086.
          driver_telemetry_at: new Date().toISOString(),
        })
        .eq('id', rideId),
    ]);
  } catch {
    // best-effort — nunca deve derrubar a task
  }
});

/**
 * Inicia o rastreamento em background para a corrida ativa. Idempotente:
 * chamar de novo apenas atualiza o contexto (rideId/driverId) sem reiniciar o
 * hardware de GPS caso já esteja rodando. No-op silencioso no Expo Go/web ou
 * sem permissão "always" — a publicação de foreground segue funcionando.
 */
export async function startDriverBackgroundLocation(ctx: BgLocationContext): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await AsyncStorage.setItem(CONTEXT_KEY, JSON.stringify(ctx));
    await AsyncStorage.removeItem(LAST_MARK_KEY); // nova corrida → reseta o heartbeat
    await ensureLocationUpdates(ctx);
  } catch {
    // Expo Go, permissão negada, ou plataforma sem suporte — silencioso.
  }
}

async function ensureLocationUpdates(ctx: BgLocationContext): Promise<void> {
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
      () => false,
    );
    if (already) return;

    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: DEFAULT_BACKGROUND_PUBLISH_GATE.minIntervalMs,
      distanceInterval: DEFAULT_BACKGROUND_PUBLISH_GATE.minDistanceM,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: ctx.notifTitle,
        notificationBody: ctx.notifBody,
      },
    });
  } catch {
    // Expo Go, permissão negada, ou plataforma sem suporte — silencioso por
    // design (best-effort: a publicação de foreground continua normalmente).
  }
}

/**
 * Liga o modo ONLINE: publica a posição do motorista ocioso em segundo plano.
 * Só roda se a permissão já existir (no iOS, "Sempre") — quem pede é o
 * chamador, num gesto do motorista. Não sobrescreve uma corrida em andamento.
 */
export async function startDriverOnlineBackgroundLocation(
  ctx: Omit<BgLocationContext, 'rideId'>,
): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const idle: BgLocationContext = { ...ctx, rideId: null };
    await AsyncStorage.setItem(ONLINE_KEY, JSON.stringify(idle));
    const current = await readContext();
    if (current?.rideId) return; // a corrida manda; ao terminar ela volta para cá
    await AsyncStorage.setItem(CONTEXT_KEY, JSON.stringify(idle));
    await ensureLocationUpdates(idle);
  } catch {
    // best-effort
  }
}

/** Desliga o modo ONLINE. Se houver corrida em andamento, o GPS dela segue. */
export async function stopDriverOnlineBackgroundLocation(): Promise<void> {
  if (Platform.OS === 'web') return;
  await AsyncStorage.removeItem(ONLINE_KEY).catch(() => {});
  const current = await readContext();
  if (current?.rideId) return;
  await stopDriverBackgroundLocation();
}

/**
 * Fim da corrida (ou saída da tela de navegação): se o motorista continua
 * online, a task volta ao modo ocioso em vez de parar; senão, para.
 */
export async function releaseRideBackgroundLocation(): Promise<void> {
  if (Platform.OS === 'web') return;
  let idle: BgLocationContext | null = null;
  try {
    const raw = await AsyncStorage.getItem(ONLINE_KEY);
    idle = raw ? (JSON.parse(raw) as BgLocationContext) : null;
  } catch {
    idle = null;
  }
  if (!idle) {
    await stopDriverBackgroundLocation();
    return;
  }
  try {
    await AsyncStorage.setItem(CONTEXT_KEY, JSON.stringify({ ...idle, rideId: null }));
    await AsyncStorage.removeItem(LAST_MARK_KEY);
  } catch {
    // best-effort
  }
}

/** Encerra o rastreamento em background e limpa o contexto persistido. */
export async function stopDriverBackgroundLocation(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
      () => false,
    );
    if (already) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
  } catch {
    // best-effort
  } finally {
    await AsyncStorage.removeItem(CONTEXT_KEY).catch(() => {});
    await AsyncStorage.removeItem(LAST_MARK_KEY).catch(() => {});
  }
}

/** Diz se o rastreamento em background está ativo agora (best-effort). */
export async function isDriverBackgroundLocationActive(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  } catch {
    return false;
  }
}
