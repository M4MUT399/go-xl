import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../hooks/useAuth';
import { useLocation } from '../hooks/useLocation';
import { useDriverRide } from '../hooks/useRide';
import { useDutyIdleTracker } from '../hooks/useDutyIdleTracker';
import { useDutyMovementTracker } from '../hooks/useDutyMovementTracker';
import { useDriverPeriodTracker } from '../hooks/useDriverPeriodTracker';
import { useTelematicsSession } from '../hooks/useTelematicsSession';
import type { DriverPeriod } from '../lib/driverPeriodMachine';
import { supabase } from '../lib/supabase';
import type { Coordinates } from '../types';
import type { IdleSegment } from '../lib/drivingLimits';
import { decideStatusRevert, type StatusRevertDecision } from '../lib/driverOnlineStatus';
import { updateCarActiveRide, updateCarRideOffer } from '../native/carRideBridge';

type UseDriverRideReturn = ReturnType<typeof useDriverRide>;

interface DriverRideContextValue extends UseDriverRideReturn {
  isOnline: boolean;
  /** true após carregar o valor persistido no AsyncStorage. */
  onlineLoaded: boolean;
  setIsOnline: (value: boolean) => void;
  location: Coordinates | null;
  /** Item 1: períodos parado do turno atual (alimenta o limite de direção). */
  dutyIdleSegments: IdleSegment[];
  /** Bloco 2: minutos de jornada pela máquina por movimento (0 se flag off). */
  dutyMovementMinutes: number;
  /** Bloco 2: true quando a contagem por movimento (v2) está habilitada. */
  dutyMovementEnabled: boolean;
  /** Bloco 1 (compliance TNC): período legal P0-P3 atual (ver driverPeriodMachine.ts). */
  driverPeriod: DriverPeriod;
  /** Bloco 1: true quando o tracking de período (`period_tracking_v1_enabled`) está habilitado. */
  driverPeriodEnabled: boolean;
  /**
   * true quando a última transição online↔offline foi RECUSADA pelo servidor e o
   * estado local foi revertido. Sem isso a chave voltava sozinha e o motorista
   * não tinha como saber por quê — ver o efeito de status mais abaixo.
   */
  statusSyncFailed: boolean;
  /**
   * Por que o status não sincronizou. 'refused' = o servidor recusou (tipicamente
   * cadastro de repasse do Stripe incompleto — trigger da migration 0038, que
   * coage `is_online := false` em silêncio, SEM erro); 'transport' = a escrita
   * não chegou. O banner escolhe o texto por aqui.
   */
  statusSyncReason: StatusRevertDecision['reason'];
}

const DriverRideContext = createContext<DriverRideContextValue | null>(null);

/**
 * Provider único, montado uma vez no topo da árvore do app do motorista
 * (ver AppNavigator.tsx) — sobrevive à navegação entre TODAS as telas
 * (Mapa, Agenda, Ganhos, Navegação, Perfil, etc.).
 *
 * Antes disso, `useDriverRide` (assinatura realtime + polling de novas
 * corridas) só era chamado dentro de `DriverHomeScreen`, e o overlay de
 * chamada (`IncomingRideCall`) só existia ali também. Como o
 * react-native-screens "congela"/desativa telas anteriores da pilha quando
 * uma nova é empilhada por cima, o `<Modal>` nativo da chamada não
 * conseguia aparecer se o motorista estivesse em qualquer outra tela — o
 * banner ficava "preso" atrás da tela ativa. Elevar o estado (e o overlay)
 * para fora de qualquer `Stack.Screen` resolve isso: a chamada de corrida
 * agora aparece não importa onde o motorista esteja no app.
 */
export function DriverRideProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [isOnline, setIsOnlineState] = useState(false);
  const [onlineLoaded, setOnlineLoaded] = useState(false);

  // Marca que a próxima gravação de status veio de um TOQUE na chave, e não do
  // heartbeat que roda ao abrir o app. Só o toque autoriza reverter a chave
  // numa falha de rede — reverter no heartbeat inventaria uma ação do usuário.
  const userToggleRef = useRef(false);
  // Valor que o app JÁ DECIDIU ter, mesmo que o render ainda não tenha
  // acontecido. Um espelho de render (`ref.current = isOnline` no corpo do
  // componente) não serve para o guarda abaixo: entre uma reversão chamar
  // `setIsOnlineState(false)` e o render seguinte, o espelho ainda diz `true` —
  // e um toque do motorista em ONLINE nessa janela era descartado em SILÊNCIO
  // (nem estado, nem AsyncStorage, nem `userToggleRef`). Toda escrita de
  // `isOnline`, venha de toque ou de reversão, atualiza este ref na hora.
  const intendedOnlineRef = useRef(isOnline);

  // A reversão muda `isOnline` e portanto re-dispara o efeito de transição. Sem
  // esta trava, uma queda de rede (que derruba tanto a escrita "online" quanto
  // a "offline") faria a chave oscilar em loop, gravando sem parar. A reversão
  // é só correção de EXIBIÇÃO — não vai ao servidor.
  //
  // Guarda o VALOR revertido, não um booleano "estou revertendo". Com o
  // booleano, um toque do motorista que colapsasse a mudança de estado da
  // reversão no mesmo lote deixava a marca presa em `true`: a rodada seguinte
  // era engolida inteira pelo early-return e NADA era escrito no servidor —
  // silêncio, que é o defeito que este bloco existe para acabar. Comparando com
  // `isOnline`, a marca se cura sozinha: se a rodada que chega não é a reversão
  // que agendamos, ela é limpa e a rodada segue normalmente.
  const revertingToRef = useRef<boolean | null>(null);

  /**
   * ÚNICO caminho para mudar `isOnline`. `setIsOnlineState` não deve ser chamado
   * de mais lugar nenhum.
   *
   * Não é preciosismo: o defeito que este helper fecha é o de um escritor que
   * ESQUECE de atualizar `intendedOnlineRef`. Quando isso acontece o ref passa a
   * discordar do estado, e o guarda de no-op em `setIsOnline` começa a descartar
   * toques legítimos em silêncio. Com um escritor só, esquecer deixa de ser
   * possível.
   */
  const definirOnline = useCallback((val: boolean) => {
    intendedOnlineRef.current = val;
    setIsOnlineState(val);
    AsyncStorage.setItem('driver_is_online', val ? 'true' : 'false');
  }, []);

  const setIsOnline = useCallback((val: boolean) => {
    // Só arma a marca quando o valor MUDA de verdade. Armá-la sempre vazava:
    // com `val === isOnline` o React sai pelo bail-out de `setState` com valor
    // igual, o efeito de status NÃO roda, e `userToggleRef` fica armado para a
    // rodada seguinte — que pode ser o heartbeat disparado por `profile?.id`/
    // `onlineLoaded`. Aí uma falha de rede nesse heartbeat inverteria a chave
    // como se o motorista a tivesse tocado, que é justamente o que
    // `decideStatusRevert` recusa fazer sem toque.
    if (val === intendedOnlineRef.current) return;
    // Um toque manda mais que uma reversão pendente. Sem isto, o toque que
    // acontece na janela da reversão COLAPSA a mudança de estado dela (os dois
    // `setIsOnlineState` caem no mesmo lote e o valor final é o do toque), o
    // efeito de transição não re-roda, e a marca fica presa: a PRÓXIMA vez que o
    // motorista ficasse offline seria engolida pelo early-return e nada iria ao
    // servidor. A marca se cura sozinha quando uma rodada chega — o furo é
    // exatamente o caso em que nenhuma chega.
    revertingToRef.current = null;
    userToggleRef.current = true;
    definirOnline(val);
  }, [definirOnline]);

  // Ordem das gravações de status. Os DOIS efeitos abaixo escrevem em
  // `driver_locations` e ambos mexem no banner; numa transição offline→online os
  // dois `upsert` correm em paralelo e o último a RESOLVER vencia — não o último
  // a ser ENVIADO. O caso concreto: o fix de GPS volta recusado (Connect revogado
  // no meio do turno), reverte a chave e levanta o banner; a resposta da
  // transição, mais VELHA, chega depois com `syncFailed: false` e apaga o
  // banner. O motorista fica offline sem explicação nenhuma na tela.
  //
  // Cada envio pega um número. LEVANTAR o banner nunca precisa deste número —
  // uma falha aconteceu de verdade com uma escrita que de fato mandamos, e
  // esconder isso porque chegou fora de ordem seria o defeito original de novo.
  // Quem precisa de prova de frescor é APAGAR: só a resposta mais recente pode
  // dizer "está tudo bem agora".
  const statusWriteSeqRef = useRef(0);
  // Fixes de GPS seguidos que não chegaram ao servidor — ver o efeito de posição.
  const posFailStreakRef = useRef(0);
  // O banner aceso agora foi levantado pelo efeito de POSIÇÃO? Só quem levantou
  // pode apagar: um `refused` do efeito de transição não é curado por um fix de
  // GPS que deu certo, e apagá-lo mandaria o motorista de volta a esperar
  // corrida que não vem.
  const bannerDoPosRef = useRef(false);
  // Turno de serviço. Zerar contagem e autoria no early-return só alcança as
  // respostas que JÁ voltaram; as escritas EM VOO resolvem depois dele e, sem
  // este token, re-armavam as duas do outro lado do fim de turno. O desfecho:
  // três fixes pendurados num bolsão sem sinal, o motorista toca para encerrar,
  // as três voltam com erro (autoria do posição, já offline), o toque volta com
  // erro e devolve a chave para verde com o aviso "seu toque não valeu" — e o
  // primeiro fix bom apaga esse aviso achando que é dele. O motorista guarda o
  // telefone achando que saiu e continua recebendo corrida.
  const turnoRef = useRef(0);

  /** Aplica uma REVERSÃO decidida pelo servidor. Existe como função para que os
   *  dois efeitos de status não possam esquecer nenhum dos passos. */
  const aplicarReversao = useCallback((revertTo: boolean) => {
    revertingToRef.current = revertTo;
    definirOnline(revertTo);
  }, [definirOnline]);

  // Carrega o status online salvo ao montar (persiste entre sessões). Passa por
  // `definirOnline` como todo mundo: enquanto este ponto chamava
  // `setIsOnlineState` direto, o motorista que abria o app JÁ ONLINE ficava com
  // `isOnline === true` e `intendedOnlineRef === false`, e o primeiro toque para
  // SAIR de serviço batia no `val === intendedOnlineRef.current` e sumia — sem
  // estado, sem AsyncStorage, sem escrita no servidor. Ele continuava visível ao
  // passageiro e recebendo ofertas depois de encerrar o turno.
  useEffect(() => {
    AsyncStorage.getItem('driver_is_online').then((val) => {
      if (val === 'true') definirOnline(true);
      setOnlineLoaded(true);
    });
  }, [definirOnline]);

  // GPS SEMPRE monitorado (watch: true), inclusive OFFLINE — o mapa do motorista
  // continua acompanhando o deslocamento mesmo com o status offline (o motorista
  // pediu esse comportamento). O que muda com online/offline não é a leitura do
  // GPS, e sim se a posição é PUBLICADA no servidor (ver os dois efeitos abaixo)
  // e se a jornada acumula (a máquina por movimento só conta online).
  const { location } = useLocation({ watch: true });
  // Espelho da última posição — usado pelo efeito de status (que não deve
  // re-disparar a cada fix de GPS, só quando o online/offline muda).
  const locationRef = useRef<Coordinates | null>(location);
  locationRef.current = location;

  // Item 1: acompanha a ociosidade (veículo parado) do turno atual a partir da
  // velocidade do GPS. Vive aqui — global — para captar também o movimento
  // durante a corrida (tela de Navegação), não só o da Home.
  const dutyIdleSegments = useDutyIdleTracker(isOnline, location?.speed);

  // Bloco 2: contagem de jornada pela máquina de estados por MOVIMENTO
  // (persistida por timestamps epoch, sobrevive a kill/reboot; emite transições
  // à trilha de auditoria). Roda em paralelo ao v1, mas é no-op enquanto a flag
  // `duty_movement_v2_enabled` estiver desligada (padrão) — não altera a regra
  // de descanso atual até o rollout por jurisdição.
  const { enabled: dutyMovementEnabled, workedMinutes: dutyMovementMinutes } = useDutyMovementTracker(
    profile?.id,
    isOnline,
    location?.speed,
  );

  // Bloco 1 (compliance TNC F.S. 627.748): máquina de períodos P0-P3, dirigida
  // por eventos de SERVIDOR (driver_locations/rides via realtime), não pelo
  // `isOnline`/`ride` locais — ver comentário em useDriverPeriodTracker.ts.
  // No-op enquanto `period_tracking_v1_enabled` estiver desligada (padrão).
  const { enabled: driverPeriodEnabled, period: driverPeriod } = useDriverPeriodTracker(
    profile?.id,
    profile?.jurisdiction,
    location,
  );

  // Publica a POSIÇÃO ao vivo no banco APENAS quando ONLINE — é o que o
  // passageiro vê em tempo real. Offline, o GPS continua rodando localmente
  // (mapa/jornada), mas a posição NÃO é rastreada no servidor (privacidade do
  // motorista fora de serviço). Vive aqui — e não em DriverHomeScreen — para
  // continuar publicando mesmo em outra tela (Navegação, Agenda, etc.), já que
  // este Provider nunca é desmontado.
  //
  // O `.select('is_online')` aqui não é simetria decorativa com o efeito de
  // transição abaixo. Este upsert grava `is_online: true` a CADA fix de GPS, e
  // o trigger da 0038 coage `is_online := false` sem levantar erro. Se a conta
  // Connect for revogada NO MEIO DO TURNO, a coerção se repete a cada fix e o
  // efeito de transição nunca a vê — ele só roda quando `isOnline` MUDA, e do
  // lado do app nada mudou. O motorista roda a tarde inteira com a chave verde
  // sem receber uma corrida. Ler de volta custa tamanho de resposta, não uma
  // ida a mais: o PostgREST devolve a linha no mesmo request.
  useEffect(() => {
    if (!location || !profile?.id || !onlineLoaded || !isOnline) {
      // Sair de serviço encerra a sequência de fixes. Sem zerar aqui, duas falhas
      // do turno da manhã somavam com a primeira falha do turno da tarde e o
      // banner subia no primeiro pacote perdido do dia seguinte.
      posFailStreakRef.current = 0;
      // A autoria morre junto. Sem isto, a reivindicação sobrevive ao turno: no
      // turno seguinte o primeiro fix bem-sucedido apagaria um banner que quem
      // levantou foi o efeito de TRANSIÇÃO ("seu toque não valeu") — exatamente
      // a troca de dono que esta ref existe para impedir.
      bannerDoPosRef.current = false;
      turnoRef.current += 1;
      return;
    }
    let cancelled = false;
    (async () => {
      const turno = turnoRef.current;
      const seq = (statusWriteSeqRef.current += 1);
      const { data, error } = await supabase.from('driver_locations').upsert({
        driver_id: profile.id,
        lat: location.lat,
        lng: location.lng,
        heading: location.heading ?? null,
        is_online: true,
        updated_at: new Date().toISOString(),
      }).select('is_online').maybeSingle();

      // A contagem vem ANTES do `cancelled`. Este efeito depende de `location`, e
      // numa queda de rede os fixes continuam chegando: cada novo fix limpa o
      // anterior, então TODA resposta que erra volta com `cancelled === true`. Com
      // o guarda na frente, o contador nunca passava de zero — a publicação de
      // posição parava por minutos e o banner não subia nunca. O que a limpeza
      // cancela é o EFEITO NA TELA de uma rodada velha, não o fato de que aquela
      // escrita não chegou ao servidor.
      //
      // O turno é a ÚNICA coisa que interrompe essa regra, e por um motivo
      // diferente do `cancelled`: uma resposta que chega depois do fim do turno
      // não fala mais sobre nenhum estado que exista na tela. Contar e levantar
      // aqui reacende contagem e autoria do outro lado do early-return, que
      // acabou de zerar as duas — ver `turnoRef`.
      if (turno !== turnoRef.current) return;

      if (error) posFailStreakRef.current += 1;
      else posFailStreakRef.current = 0;

      // O `error` era descartado e `failed` vinha `false` fixo — uma queda de
      // rede no MEIO do turno não levantava nada: o efeito de transição só roda
      // quando `isOnline` MUDA, e do lado do app nada mudou. O motorista parava
      // de aparecer para o passageiro com a chave verde na tela.
      //
      // Mas UM pacote perdido não é banner. Este efeito roda a cada fix de GPS e
      // nunca apaga o banner sozinho: levantá-lo no primeiro erro deixaria um
      // alarme falso preso na tela pelo resto do turno por causa de um pacote.
      // Três fixes seguidos sem chegar ao servidor já não é ruído — é a
      // publicação de posição parada. O contador zera no primeiro sucesso.
      //
      // LEVANTAR também fica antes do `cancelled`, pelo mesmo motivo da contagem
      // e pelo mesmo motivo que levantar não passa pelo teste de frescor no
      // efeito de transição: a falha aconteceu de verdade, com uma escrita que
      // de fato mandamos. Um fix mais novo não desmente as três que se perderam.
      if (error) {
        if (posFailStreakRef.current >= 3) {
          const falha = decideStatusRevert({
            requested: true, returned: null, failed: true, userInitiated: false,
          });
          bannerDoPosRef.current = true;
          setStatusSyncFailed(falha.syncFailed);
          setStatusSyncReason(falha.reason);
        }
        return;
      }
      if (cancelled) return;

      // A rede voltou. Apagar o banner é o passo que faltava: sem ele, um bolsão
      // sem sinal deixava o aviso "sem conexão" preso na tela pelo resto do turno,
      // e o motorista que confia no aviso encosta e deixa de rodar por nada.
      //
      // Duas travas antes de apagar. `bannerDoPosRef`: só apaga o banner que ESTE
      // efeito levantou — uma recusa do trigger (`refused`) não é curada por um
      // fix de GPS que deu certo, e apagá-la mandaria o motorista esperar corrida
      // que o dispatch não vai oferecer. `seq`: só a resposta mais recente pode
      // dizer que está tudo bem agora.
      if (bannerDoPosRef.current && seq === statusWriteSeqRef.current) {
        bannerDoPosRef.current = false;
        setStatusSyncFailed(false);
        setStatusSyncReason('ok');
      }

      // Sem erro de transporte, só a RECUSA explícita age — o servidor dizendo
      // "não" via a coerção do trigger da 0038.
      const decision = decideStatusRevert({
        requested: true,
        returned: typeof data?.is_online === 'boolean' ? data.is_online : null,
        failed: false,
        userInitiated: false,
      });
      if (decision.reason !== 'refused' || decision.revertTo === null) return;
      setStatusSyncFailed(true);
      setStatusSyncReason(decision.reason);
      aplicarReversao(decision.revertTo);
    })();
    return () => { cancelled = true; };
  }, [location, isOnline, profile?.id, onlineLoaded]);

  // Escreve a TRANSIÇÃO de status (online↔offline) no servidor sempre que ela
  // muda — inclusive ao ficar OFFLINE (para o passageiro deixar de ver o
  // motorista e o tracker de período registrar WENT_OFFLINE). Dispara só na
  // mudança de `isOnline` (usa `locationRef` para não re-rodar a cada fix).
  //
  // O upsert era disparado sem olhar o resultado. Como o servidor PODE recusar
  // a transição (o trigger em driver_locations barra ficar online sem a conta
  // Stripe Connect habilitada — ver DriverHomeScreen, e há RLS/rede no meio), o
  // motorista via a chave verde marcando "Online" enquanto o servidor o mantinha
  // offline: ele ficava horas esperando corridas que o dispatch nunca ia
  // oferecer. Agora, quando a escrita falha, revertemos o estado local para o
  // que o servidor de fato tem e sinalizamos a falha — a chave voltar sozinha é
  // feio, mas é a única coisa honesta a mostrar.
  const [statusSyncFailed, setStatusSyncFailed] = useState(false);
  // Por que falhou. O banner precisa disto: "recusado" e "sem rede" pedem textos
  // opostos, e mandar o motorista checar a conexão quando o problema é o
  // cadastro do Stripe é o próprio defeito que este módulo persegue.
  const [statusSyncReason, setStatusSyncReason] = useState<StatusRevertDecision['reason']>('ok');
  useEffect(() => {
    if (!profile?.id || !onlineLoaded) return;
    if (revertingToRef.current !== null) {
      const estaEhAReversao = revertingToRef.current === isOnline;
      revertingToRef.current = null;
      if (estaEhAReversao) return;
    }
    const loc = locationRef.current;
    // Consome a marca de "veio de um toque". A partir daqui esta rodada sabe se
    // é toque do usuário ou o heartbeat de abertura, e as duas exigem
    // tratamentos diferentes — ver `decideStatusRevert`.
    const userInitiated = userToggleRef.current;
    userToggleRef.current = false;
    let cancelled = false;
    (async () => {
      // `.select('is_online')` NÃO é opcional: o trigger da 0038 coage
      // `is_online := false` para motorista sem Connect aprovado e deixa o
      // upsert retornar SUCESSO. Sem ler de volta, a recusa é invisível.
      const seq = (statusWriteSeqRef.current += 1);
      const { data, error } = await supabase.from('driver_locations').upsert({
        driver_id: profile.id,
        is_online: isOnline,
        updated_at: new Date().toISOString(),
        ...(loc ? { lat: loc.lat, lng: loc.lng, heading: loc.heading ?? null } : {}),
      }).select('is_online').maybeSingle();
      if (cancelled) return;

      const decision = decideStatusRevert({
        requested: isOnline,
        returned: typeof data?.is_online === 'boolean' ? data.is_online : null,
        failed: !!error,
        userInitiated,
      });

      // Só apaga o banner se nenhuma outra gravação de status saiu depois desta
      // — ver `statusWriteSeqRef`. Levantar não passa pelo teste de frescor.
      if (decision.syncFailed || seq === statusWriteSeqRef.current) {
        setStatusSyncFailed(decision.syncFailed);
        setStatusSyncReason(decision.reason);
      }
      // A REVERSÃO não passa pelo teste de frescor de propósito: ela é a resposta
      // a ESTA escrita ("seu toque não valeu" / "o servidor recusou"), e um fix de
      // GPS posterior não desmente nenhuma das duas. Engoli-la por chegar fora de
      // ordem devolveria a chave verde mentindo, que é o defeito de origem.
      if (decision.revertTo !== null) aplicarReversao(decision.revertTo);
    })();
    return () => { cancelled = true; };
  }, [isOnline, profile?.id, onlineLoaded]);

  const ride = useDriverRide(profile?.id, profile?.jurisdiction);

  // Telemetria de direção (estilo Uber/CMT): grava uma sessão pontuada por
  // corrida, do ACEITE ao ENCERRAMENTO. Automático e só no histórico do próprio
  // motorista (ver useTelematicsSession.ts + migration 0063). Roda aqui — global
  // — para capturar a corrida inteira independentemente da tela ativa.
  useTelematicsSession(profile?.id, ride.activeRide?.id ?? null);

  // ── Ponte com Android Auto (ver src/native/carRideBridge.ts) ────────────────
  // Empurra a chamada pendente e a corrida ativa para a tela do carro sempre
  // que mudam. No-op em iOS/Web (o módulo nativo só existe no Android) — ver
  // comentário em carRideBridge.ts. A ação de aceitar/recusar disparada pelos
  // botões do carro é OUVIDA em GlobalDriverRideOverlay.tsx, não aqui: aquele
  // componente já concentra handleAccept/handleReject (alerta, navegação,
  // etc.) e não faz sentido duplicar essa lógica.
  useEffect(() => {
    updateCarRideOffer(ride.pendingRide);
  }, [ride.pendingRide]);

  useEffect(() => {
    updateCarActiveRide(ride.activeRide);
  }, [ride.activeRide]);

  const value: DriverRideContextValue = {
    ...ride,
    isOnline,
    onlineLoaded,
    setIsOnline,
    location,
    dutyIdleSegments,
    dutyMovementMinutes,
    dutyMovementEnabled,
    driverPeriod,
    driverPeriodEnabled,
    statusSyncFailed,
    statusSyncReason,
  };

  return <DriverRideContext.Provider value={value}>{children}</DriverRideContext.Provider>;
}

export function useDriverRideContext(): DriverRideContextValue {
  const ctx = useContext(DriverRideContext);
  if (!ctx) {
    throw new Error('useDriverRideContext deve ser usado dentro de <DriverRideProvider>.');
  }
  return ctx;
}
