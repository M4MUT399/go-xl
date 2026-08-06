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

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { supabase } from '../supabase';
import { shouldPublishFix, DEFAULT_BACKGROUND_PUBLISH_GATE, type PublishMark } from './publishGate';

/** Nome único da task de localização em background. */
export const BACKGROUND_LOCATION_TASK = 'goxl-driver-background-location';

const CONTEXT_KEY = '@goxl/bg_location_context';
const LAST_MARK_KEY = '@goxl/bg_location_last_mark';

export interface BgLocationContext {
  rideId: string;
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
  if (!shouldPublishFix(last, next, now, DEFAULT_BACKGROUND_PUBLISH_GATE)) return;

  const mark: PublishMark = { lat: next.lat, lng: next.lng, atMs: now };
  await writeLastMark(mark);

  const heading =
    fix.coords.heading != null && fix.coords.heading >= 0 ? fix.coords.heading : null;

  try {
    await Promise.all([
      supabase.from('driver_locations').upsert({
        driver_id: ctx.driverId,
        lat: next.lat,
        lng: next.lng,
        heading,
        is_online: true,
        updated_at: new Date().toISOString(),
      }),
      supabase
        .from('rides')
        .update({
          driver_lat: next.lat,
          driver_lng: next.lng,
          driver_heading: heading,
        })
        .eq('id', ctx.rideId),
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
