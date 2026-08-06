// backgroundNotifications — Camada 2 (Android-first, iOS best-effort).
//
// Registra uma TASK de background que roda quando um push DATA-ONLY chega com o
// app minimizado/tela bloqueada. Único objetivo: ao receber `offer_revoked`,
// DISPENSAR da bandeja/lockscreen o card da oferta que já não vale (outro
// motorista aceitou / passageiro cancelou / oferta expirou) — parando o aviso
// fantasma sem depender do JavaScript de foreground (que fica suspenso).
//
// Cobertura honesta por plataforma:
//   • Android: mensagens data-only de alta prioridade acordam esta task de forma
//     confiável → o card some em background. É o caminho principal.
//   • iOS: depende de silent push (content-available), ESTRANGULADO pela Apple —
//     entrega não garantida. Best-effort declarado: se o SO acordar a task, o
//     card some; senão, o backstop de 1,5s + collapseId limpam ao reabrir.
//
// IMPORTANTE: o push de OFERTA continua sendo notificação normal (com título/
// som) em ambas as plataformas — NÃO viramos ele data-only, pois no iOS isso
// faria o motorista PERDER corridas quando em background. Só a REVOGAÇÃO é
// data-only/silenciosa. Ver notifications.ts::sendSilentPushAsync.

import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { extractRevokedRideId } from './backgroundRevocation';
import { dismissRideNotifications } from './notifications';

/** Nome único da task de notificação em background. */
export const BACKGROUND_NOTIFICATION_TASK = 'goxl-background-revocation';

// A definição da task PRECISA acontecer no escopo do módulo (topo), antes de o
// SO poder invocá-la ao lançar o app em background. Por isso este módulo é
// importado cedo em index.ts (efeito colateral de import).
TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) return;
  const rideId = extractRevokedRideId(data);
  if (!rideId) return; // não é uma revogação (ou veio sem id) — ignora
  try {
    await dismissRideNotifications(rideId);
  } catch {
    // best-effort — nunca deve derrubar a task
  }
});

/**
 * Registra a task de notificação em background. Idempotente e best-effort:
 * chamável em todo start do app. Sem efeito no Expo Go/web (a task só roda em
 * build nativo de desenvolvimento/produção).
 */
export async function registerBackgroundRevocationTask(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch {
    // Expo Go ou plataforma sem suporte — silencioso por design.
  }
}
