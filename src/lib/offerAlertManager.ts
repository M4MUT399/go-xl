// offerAlertManager — DONO ÚNICO do alerta de chamada de corrida (padrão Uber).
//
// Motivação (bug crítico): antes, o som de chamada (`ride_call.wav`, em loop) era
// um `AudioPlayer` acoplado ao ciclo de vida de um componente React
// (`IncomingRideCall` via `useRideCallAlert`). Cada montagem criava um player
// novo, e a referência (`playerRef`) guardava só o último — em remounts rápidos,
// exceções engolidas em `pause()`, ou parada dependente de eventos frágeis
// (broadcast realtime), um player nativo com `loop=true` ficava ÓRFÃO tocando
// para sempre, sem ninguém para pará-lo. Resultado: o som continuava em vários
// aparelhos (inclusive no que RECUSOU) mesmo depois de o card sumir.
//
// Solução: um SINGLETON, fora do React, que é o ÚNICO autorizado a iniciar/parar
// som, vibração e a dispensar a notificação/card. Um único `AudioPlayer`
// REUTILIZADO (nunca recriado por montagem → zero órfãos). Máquina de estados
// por `ride_id`:
//
//     IDLE ──startAlert──▶ RINGING ──stopAll(qualquer causa)──▶ TERMINAL
//
// Regras (não-negociáveis):
//   • startAlert(rideId) só sai de IDLE→RINGING; chamada repetida para o MESMO
//     rideId é NO-OP (não reinicia o som) — re-ofertas/pushes duplicados da mesma
//     corrida não fazem o som recomeçar.
//   • QUALQUER transição para TERMINAL chama stopAll(rideId), que executa TUDO:
//     pausa o player (single, reutilizado), cancela a vibração, cancela o
//     watchdog, dispensa a notificação da bandeja/lockscreen e fecha o card.
//   • TOMBSTONE: todo rideId que passou por stopAll fica "lapidado" por 10 min —
//     qualquer push/mensagem/poll para um rideId lapidado é silenciosamente
//     descartado (não volta a tocar).
//   • WATCHDOG: ao iniciar, agenda um timer de 20s que chama stopAll
//     INCONDICIONALMENTE. Nenhum som pode durar mais que 20s. Ponto final.
//
// Cobertura por plataforma: expo-audio não expõe AVAudioSession diretamente;
// reutilizar UM player e dar `pause()` equivale, na prática, a liberar o foco de
// áudio no iOS e o MediaPlayer no Android — e elimina a classe inteira de bugs
// de player órfão. Não há foreground-service de áudio para parar (ver auditoria
// FASE 1, check (a)).

import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { dismissRideNotifications } from './notifications';

/** Causa da transição para TERMINAL — vai para o log estruturado. */
export type AlertCause =
  | 'accepted' // este motorista aceitou
  | 'declined' // este motorista recusou
  | 'revoked' // oferta revogada (push/broadcast offer_revoked)
  | 'expired' // tempo da chamada esgotou
  | 'taken' // outro motorista aceitou
  | 'watchdog' // teto de segurança de 20s
  | 'card_unmounted' // o card saiu da tela (unmount)
  | 'inactive' // alerta desativado (ex.: aceite em andamento)
  | 'pending_cleared' // pendingRide foi zerado por outra via
  | 'offline'; // motorista ficou offline

/** Duração de um ciclo do ride_call.wav (ms) — mantém a vibração em sincronia. */
const CALL_LOOP_MS = 1550;
/** Teto absoluto: nenhum alerta pode durar mais que isto (ms). Não-negociável. */
const WATCHDOG_MS = 20_000;
/** Janela do tombstone: um rideId terminado é ignorado por este tempo (ms). */
const TOMBSTONE_MS = 10 * 60_000;

function log(event: string, rideId: string, extra?: Record<string, unknown>) {
  if (__DEV__) {
    console.log(
      `[${Platform.OS}][offerAlert] ${event} ride=${rideId}` +
        (extra ? ` ${JSON.stringify(extra)}` : '') +
        ` @${new Date().toISOString()}`
    );
  }
}

// Exportada para testes de integração (simular vários "aparelhos" = várias
// instâncias). Em produção use SEMPRE o singleton `offerAlertManager` abaixo.
export class OfferAlertManager {
  /** Player ÚNICO, reutilizado por toda a vida do app (nunca recriado). */
  private player: AudioPlayer | null = null;
  /** Corrida atualmente em RINGING (única por vez), ou null = IDLE. */
  private ringingRideId: string | null = null;
  private hapticTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** rideId → timestamp (ms) de expiração do tombstone. */
  private tombstones = new Map<string, number>();
  /** Callbacks para FECHAR o card/tela (registrados pelo useDriverRide). */
  private forceCloseCbs = new Set<(rideId: string) => void>();

  /**
   * Registra um callback chamado sempre que uma corrida vai a TERMINAL (para o
   * React zerar o `pendingRide`/fechar a tela). Retorna a função de remoção.
   */
  registerForceClose(cb: (rideId: string) => void): () => void {
    this.forceCloseCbs.add(cb);
    return () => {
      this.forceCloseCbs.delete(cb);
    };
  }

  /** Um rideId lapidado (terminado nos últimos 10 min) deve ser ignorado. */
  isTombstoned(rideId: string): boolean {
    this.purgeTombstones();
    return this.tombstones.has(rideId);
  }

  private purgeTombstones() {
    const now = Date.now();
    for (const [id, exp] of this.tombstones) {
      if (exp <= now) this.tombstones.delete(id);
    }
  }

  private ensurePlayer(): AudioPlayer | null {
    if (this.player) return this.player;
    try {
      const p = createAudioPlayer(require('../../assets/ride_call.wav'));
      p.loop = true;
      this.player = p;
    } catch {
      this.player = null;
    }
    return this.player;
  }

  /**
   * IDLE → RINGING. Idempotente: chamar de novo para o MESMO rideId não reinicia
   * o som. Descartado se o rideId estiver lapidado (tombstone). Uma nova oferta
   * (rideId diferente) substitui a anterior (que vai a TERMINAL 'revoked').
   */
  startAlert(rideId: string) {
    if (!rideId) return;
    if (this.isTombstoned(rideId)) {
      log('startAlert IGNORADO (tombstone)', rideId);
      return;
    }
    if (this.ringingRideId === rideId) return; // já tocando — NÃO reinicia
    if (this.ringingRideId && this.ringingRideId !== rideId) {
      // Uma nova oferta chegou antes de a anterior terminar → encerra a anterior.
      this.stopAll(this.ringingRideId, 'revoked');
    }
    this.ringingRideId = rideId;
    this.startSound();
    this.startHaptics();
    this.armWatchdog(rideId);
    log('startAlert → RINGING', rideId);
  }

  private startSound() {
    const p = this.ensurePlayer();
    try {
      p?.seekTo(0);
      p?.play();
    } catch {
      // o alerta ainda funciona (vibração + card) sem o som
    }
  }

  private startHaptics() {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    this.clearHaptics();
    this.hapticTimer = setInterval(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      // Watchdog leve do loop nativo: se o player parou por qualquer motivo mas
      // ainda estamos em RINGING, reinicia. (O teto duro de 20s é o armWatchdog.)
      try {
        if (this.ringingRideId && this.player && !this.player.playing) this.startSound();
      } catch {
        // ignora
      }
    }, CALL_LOOP_MS);
  }

  private clearHaptics() {
    if (this.hapticTimer) {
      clearInterval(this.hapticTimer);
      this.hapticTimer = null;
    }
  }

  private armWatchdog(rideId: string) {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      log('WATCHDOG 20s — parada INCONDICIONAL', rideId);
      this.stopAll(rideId, 'watchdog');
    }, WATCHDOG_MS);
  }

  private clearWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Transição para TERMINAL: executa TUDO (som, vibração, watchdog, notificação,
   * card) e LAPIDA o rideId por 10 min. Idempotente e seguro de chamar de
   * qualquer caminho (aceite, recusa, revogação, expiração, watchdog, unmount).
   */
  stopAll(rideId: string, cause: AlertCause) {
    if (!rideId) return;

    // 1) Tombstone SEMPRE — nenhuma re-oferta desta corrida volta a tocar.
    this.tombstones.set(rideId, Date.now() + TOMBSTONE_MS);

    // 2) Só desliga som/vibração/watchdog se este rideId é o que está tocando
    //    (ou se nada está tocando). Uma revogação de OUTRA corrida não deve
    //    silenciar a chamada atualmente válida.
    const wasRinging = this.ringingRideId === rideId;
    if (wasRinging || this.ringingRideId === null) {
      try {
        this.player?.pause();
      } catch {
        // ignora
      }
      this.clearHaptics();
      this.clearWatchdog();
      if (wasRinging) this.ringingRideId = null;
    }

    // 3) Dispensa a notificação de oferta da bandeja/lockscreen desta corrida.
    dismissRideNotifications(rideId).catch(() => {});

    // 4) Fecha o card/tela (React zera o pendingRide).
    for (const cb of this.forceCloseCbs) {
      try {
        cb(rideId);
      } catch {
        // ignora — nunca deve derrubar o stopAll
      }
    }

    log('stopAll → TERMINAL', rideId, { cause });
  }

  // ─── Apenas para testes: reset total do estado do singleton. ────────────────
  __resetForTests() {
    try {
      this.player?.pause();
    } catch {
      // ignora
    }
    this.clearHaptics();
    this.clearWatchdog();
    this.ringingRideId = null;
    this.tombstones.clear();
    this.forceCloseCbs.clear();
  }

  /** Apenas para testes/introspecção. */
  get __ringingRideId() {
    return this.ringingRideId;
  }
}

/** Instância única — importe SEMPRE esta, nunca crie outra. */
export const offerAlertManager = new OfferAlertManager();
