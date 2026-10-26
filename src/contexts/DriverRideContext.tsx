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
import { Platform } from 'react-native';
import * as ExpoLocation from 'expo-location';
import { useTranslation } from '../i18n';
import {
  startDriverOnlineBackgroundLocation,
  stopDriverOnlineBackgroundLocation,
} from '../lib/nav/backgroundLocationTask';

type UseDriverRideReturn = ReturnType<typeof useDriverRide>;

/**
 * Quanto tempo ONLINE sem NENHUMA posição publicada antes de acusar o problema.
 *
 * Não é um número de conforto: é a carência que separa "o GPS está morto" de "o
 * GPS ainda está acordando". O heartbeat de abertura roda assim que o
 * AsyncStorage responde, com `locationRef` ainda null por 1-2 s mesmo num
 * aparelho perfeito (useLocation pede permissão e só então recebe o primeiro
 * fix). Levantar o aviso ali seria ressuscitar o "banner que subia sozinho" com
 * outro texto. Do outro lado, o watch entrega fix a cada 5 s
 * (useLocation.ts:113-115), então 45 s sem um único fix não é lentidão — é
 * permissão negada, GPS desligado ou aparelho sem sinal nenhum.
 */
const CARENCIA_PRIMEIRA_POSICAO_MS = 45_000;

/**
 * Quanto tempo sem publicar posição, JÁ TENDO publicado, antes de acusar.
 *
 * O despacho e o mapa do passageiro só enxergam quem tem `updated_at` dos
 * últimos 10 min (dispatch-engine/index.ts:152-156 e 0069:646). Avisar em 8 min
 * dá ao motorista dois minutos para religar o GPS ou sair da garagem ANTES de
 * sumir do leque — avisar em 10 seria avisar depois de já ter perdido corrida.
 */
const LIMITE_FRESCOR_POSICAO_MS = 8 * 60_000;

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
   * true quando o que a tela mostra sobre o status NÃO é o que o servidor tem.
   *
   * Nem sempre vem com reversão da chave: começou como "a transição foi recusada
   * e o estado local voltou", mas hoje cobre também os casos em que a chave está
   * certa e mesmo assim o motorista não recebe corrida — a publicação de posição
   * parada e o motorista em serviço sem posição nenhuma no servidor. Sem isso a
   * chave voltava sozinha (ou ficava verde à toa) e ele não tinha como saber por
   * quê — ver os efeitos de status mais abaixo.
   */
  statusSyncFailed: boolean;
  /**
   * Por que o status não sincronizou. 'refused' = o servidor recusou (tipicamente
   * cadastro de repasse do Stripe incompleto — trigger da migration 0038, que
   * coage `is_online := false` em silêncio, SEM erro); 'transport' = a escrita
   * não chegou; 'no_position' = não há posição fresca no servidor (sem linha, ou
   * sem fix de GPS há tempo demais), e sem ela o despacho não enxerga o
   * motorista. O banner escolhe o texto por aqui.
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
  /**
   * QUEM levantou o banner que está na tela AGORA — `null` quando ela está limpa.
   *
   * A regra que esta ref serve continua a mesma: só quem levantou pode apagar.
   * Um `refused` do efeito de transição não é curado por um fix de GPS que deu
   * certo, e apagá-lo mandaria o motorista de volta a esperar corrida que não
   * vem; o vigia não pode trocar o aviso de rede caída pelo de GPS.
   *
   * O que mudou é a FORMA: era uma booleana por escritor, e duas booleanas
   * guardam a autoria do LEVANTAMENTO, não a do banner que está na tela. Bastava
   * um escritor esquecer de zerar a booleana do outro para dois donos
   * coexistirem — e o defeito que isso produziu foi o pior possível. Uma recusa
   * do trigger 0038 chegando pelo efeito de POSIÇÃO levantava `refused` e
   * derrubava a chave, mas deixava de pé a reivindicação do VIGIA; o vigia
   * re-rodava no mesmo commit (a publicação e o `isOnline` acabaram de mudar),
   * achava que o banner era dele e o apagava. A chave caía e o motorista ficava
   * offline SEM UMA PALAVRA — exatamente o silêncio que o cabeçalho de
   * driverOnlineStatus.ts existe para acabar.
   *
   * Com um dono só, esquecer deixa de ser possível: escrever a autoria É tirá-la
   * de quem tinha, na mesma atribuição.
   */
  type DonoDoBanner = 'posicao' | 'transicao' | 'vigia';
  const donoDoBannerRef = useRef<DonoDoBanner | null>(null);
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
  // QUANDO o último fix de GPS chegou ao app. É a identidade do objeto que marca
  // fix novo (o mesmo critério de useDutyMovementTracker), e é ref porque o vigia
  // precisa LER isto sem re-armar o prazo a cada fix — ver o comentário da lista
  // de dependências dele. Serve a uma pergunta só: quando o prazo vencer, o
  // aparelho estava produzindo posição e a publicação é que não passou?
  const ultimoFixMsRef = useRef<number | null>(null);
  useEffect(() => {
    if (location) ultimoFixMsRef.current = Date.now();
  }, [location]);

  // Item 1: acompanha a ociosidade (veículo parado) do turno atual a partir da
  // velocidade do GPS. Vive aqui — global — para captar também o movimento
  // durante a corrida (tela de Navegação), não só o da Home.
  const dutyIdleSegments = useDutyIdleTracker(isOnline, location?.speed);

  // Bloco 2: contagem de jornada pela máquina de estados por MOVIMENTO
  // (persistida por timestamps epoch, sobrevive a kill/reboot; emite transições
  // à trilha de auditoria). Roda em paralelo ao v1, mas é no-op enquanto a flag
  // `duty_movement_v2_enabled` estiver desligada (padrão) — não altera a regra
  // de descanso atual até o rollout por jurisdição.
  // Recebe o FIX inteiro, não `location?.speed`: o hook precisa saber QUANDO a
  // velocidade foi medida, e é a identidade do objeto que marca fix novo — ver o
  // cabeçalho de useDutyMovementTracker.ts.
  const { enabled: dutyMovementEnabled, workedMinutes: dutyMovementMinutes } = useDutyMovementTracker(
    profile?.id,
    isOnline,
    location,
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
      // O relógio de frescor morre com o turno. Sem isto, quem reabre o app já
      // online cairia direto no prazo de 8 min contado a partir da publicação de
      // ONTEM: prazo vencido, aviso na cara antes do primeiro fix ter chance de
      // chegar. Zerado, o turno novo começa pela carência de abertura.
      setUltimaPosOkMs(null);
      // A autoria morre junto. Sem isto, a reivindicação sobrevive ao turno: no
      // turno seguinte o primeiro fix bem-sucedido apagaria um banner que quem
      // levantou foi o efeito de TRANSIÇÃO ("seu toque não valeu") — exatamente
      // a troca de dono que esta ref existe para impedir. Só a autoria DESTE
      // efeito é liberada: um banner da transição ou do vigia continua com dono.
      if (donoDoBannerRef.current === 'posicao') donoDoBannerRef.current = null;
      turnoRef.current += 1;
      return;
    }
    let cancelled = false;
    (async () => {
      const turno = turnoRef.current;
      const seq = (statusWriteSeqRef.current += 1);
      // ─── ESTE UPSERT EXIGE A MIGRATION 0080 NO SERVIDOR ─────────────────────
      //
      // O `.upsert()` do supabase-js vira, no PostgREST, um `insert ... on
      // conflict (driver_id) do update set "lat" = excluded."lat", "lng" =
      // excluded."lng", ...` — uma cláusula que não está escrita aqui e que
      // nenhuma leitura deste arquivo revela. O Postgres exige SELECT sobre toda
      // coluna LIDA numa expressão do `do update`, e ler `excluded."lat"` é ler
      // `lat`. Entre a 0069 e a 0080 o papel `authenticated` não tinha esse
      // SELECT (0069:164 e :182 revogaram lat/lng/heading), e ESTA linha — o
      // único ponto do app que cria a linha do motorista e carimba `updated_at`
      // — morria em `42501 permission denied` para todo mundo, sempre, com GPS
      // perfeito. Sem `updated_at` fresco não há leque de despacho.
      //
      // Não é dedução: está medido contra um Postgres de verdade, com o schema e
      // todas as migrations aplicadas, em
      // `supabase/localdb/97_escrita_driver_locations.sql` — que revoga o grant
      // dentro da transação para o 42501 voltar, e restaura em seguida.
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
      else {
        posFailStreakRef.current = 0;
        // Este é o ÚNICO ponto do app em que uma posição nova chega de fato ao
        // servidor com `updated_at` carimbado — ou seja, o único ponto em que o
        // motorista volta a existir para o despacho. É daqui que o vigia conta o
        // prazo de frescor. Fica ANTES do `cancelled` pelo mesmo motivo da
        // contagem acima: a escrita chegou de verdade, e um fix mais novo não
        // desmente isso.
        setUltimaPosOkMs(Date.now());
      }

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
          donoDoBannerRef.current = 'posicao';
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
      // Duas travas antes de apagar. O DONO do banner: só apaga o que ESTE
      // efeito levantou — uma recusa do trigger (`refused`) não é curada por um
      // fix de GPS que deu certo, e apagá-la mandaria o motorista esperar corrida
      // que o dispatch não vai oferecer. `seq`: só a resposta mais recente pode
      // dizer que está tudo bem agora.
      if (donoDoBannerRef.current === 'posicao' && seq === statusWriteSeqRef.current) {
        donoDoBannerRef.current = null;
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
      // ASSUMIR A AUTORIA AQUI NÃO É SIMETRIA DECORATIVA. Este é o único ponto do
      // app que derruba a chave e escreve o banner na mesma tacada, e enquanto
      // ele não reivindicava a autoria o banner ficava com o dono ANTERIOR — na
      // prática, o vigia, que é quem fala quando não há posição. Sequência real:
      // motorista novo (o mesmo que esbarra no cadastro do Stripe) abre o app na
      // garagem, toca em Online, passa dos 45 s sem fix e o vigia levanta
      // `no_position`; o GPS acorda, o primeiro fix é publicado e volta RECUSADO
      // pelo trigger 0038. No mesmo commit este ramo derruba a chave e o vigia
      // re-roda — a publicação e o `isOnline` mudaram — vê a autoria dele ainda
      // de pé e apaga o banner. Chave em Offline, tela limpa, nenhuma explicação:
      // o defeito nomeado no cabeçalho de driverOnlineStatus.ts, de volta.
      donoDoBannerRef.current = 'posicao';
      setStatusSyncFailed(true);
      setStatusSyncReason(decision.reason);
      aplicarReversao(decision.revertTo);
    })();
    return () => { cancelled = true; };
  }, [location, isOnline, profile?.id, onlineLoaded]);

  // GPS em SEGUNDO PLANO enquanto ONLINE (26/10/2026). O efeito acima só roda
  // com o app aberto; com o celular no bolso o motorista ocioso parava de
  // carimbar `updated_at` e sumia do despacho. Aqui a task nativa assume esse
  // papel — só se a permissão já existir (iOS: "Sempre"; Android: o foreground
  // service basta). Quem PEDE a permissão é o toque na chave (DriverHomeScreen).
  const { t: tBg } = useTranslation();
  useEffect(() => {
    if (!onlineLoaded || !profile?.id) return;
    if (!isOnline) {
      stopDriverOnlineBackgroundLocation().catch(() => {});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const perm = Platform.OS === 'ios'
          ? await ExpoLocation.getBackgroundPermissionsAsync()
          : await ExpoLocation.getForegroundPermissionsAsync();
        if (cancelled || perm.status !== 'granted') return;
        await startDriverOnlineBackgroundLocation({
          driverId: profile.id,
          notifTitle: 'Go XL',
          notifBody: tBg('driverHome.bgOnlineNotifBody', 'Online — receiving nearby ride requests'),
        });
      } catch {
        // best-effort — o publicador de primeiro plano segue funcionando
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, onlineLoaded, profile?.id]);

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
  // Quando a última posição chegou ao servidor NESTE turno. `null` = nenhuma
  // ainda. É estado (e não ref) porque o vigia precisa RE-ARMAR o prazo a cada
  // publicação — num ref, o efeito não teria como saber que o relógio andou.
  const [ultimaPosOkMs, setUltimaPosOkMs] = useState<number | null>(null);
  // Espelho de `statusSyncFailed` para o temporizador do vigia, que dispara fora
  // do render e leria um valor congelado da closure.
  //
  // Sincronizado em EFEITO, não no corpo do componente. Escrever ref durante o
  // render funciona no renderer atual, mas sob render concorrente um render
  // ABORTADO deixaria no espelho um valor que nunca foi comitado — e o vigia
  // decide falar ou calar por ele: calaria por causa de um banner que não está
  // na tela, devolvendo o silêncio. Em efeito, o espelho só registra o que de
  // fato virou tela. O temporizador é sempre de outro tick, então não há janela
  // em que ele leia antes do commit.
  const statusSyncFailedRef = useRef(statusSyncFailed);
  useEffect(() => {
    statusSyncFailedRef.current = statusSyncFailed;
  }, [statusSyncFailed]);
  // Quando ESTE turno começou, para o vigia contar a carência da primeira
  // posição. Ref, e não estado: escrevê-lo não pode disparar render nenhum —
  // seria o próprio efeito se re-agendando e o prazo nunca venceria.
  const inicioServicoRef = useRef<number | null>(null);
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
      // ─── POR QUE UPSERT SÓ COM FIX NA MÃO ───────────────────────────────────
      //
      // `driver_locations.lat` e `.lng` são `double precision NOT NULL` sem
      // default (supabase/schema.sql:135-136), e o upsert do PostgREST é um
      // `insert ... on conflict do update`. O Postgres valida NOT NULL sobre a
      // tupla PROPOSTA do insert ANTES de resolver o conflito — então um upsert
      // sem coordenada falha com 23502 mesmo quando a linha do motorista já
      // existe e o caminho real seria o `do update`.
      //
      // ATENÇÃO — o 23502 explica o ramo SEM coordenada, e só ele. O ramo COM
      // coordenada, logo abaixo, tinha uma falha própria e maior: `42501
      // permission denied`, porque o `do update set lat = excluded.lat` do
      // PostgREST lê `lat` e a 0069 tinha tirado esse SELECT de `authenticated`.
      // Quem devolve é a migration 0080; o porquê inteiro está no comentário do
      // efeito de posição, mais acima neste arquivo. Sem a 0080 no servidor, os
      // dois ramos falham — um por NOT NULL, o outro por privilégio — e nenhuma
      // mudança neste arquivo conserta o segundo.
      //
      // Isso é o que acendia o banner sozinho: o heartbeat de abertura roda
      // assim que o AsyncStorage responde, e `useLocation` ainda não tem fix
      // nenhum (ele começa em `null` e só preenche depois da permissão + GPS —
      // useLocation.ts:26,124). A escrita voltava com erro, `decideStatusRevert`
      // lia `failed: true` e levantava `reason: 'transport'`. O motorista via
      // "não foi possível atualizar o status" na tela inicial, OFFLINE e sem
      // corrida nenhuma. Com a permissão de localização negada (ou o GPS
      // desligado pelo Android), `location` nunca chega e o banner é permanente.
      //
      // Sem fix, o que temos a dizer ao servidor é só o status — e isso é um
      // UPDATE, não um insert. Nunca inventamos coordenada para caber no schema:
      // lat/lng falsos vazam para o mapa do passageiro.
      //
      // ─── E POR QUE O UPDATE NÃO TOCA EM `updated_at` ────────────────────────
      //
      // `updated_at` NÃO é "quando mexemos na linha": é a trava de FRESCOR DA
      // POSIÇÃO. O despacho monta o leque com
      // `.eq('is_online', true).gt('updated_at', agora - 10min)` e lê `lat, lng`
      // dessas linhas (supabase/functions/dispatch-engine/index.ts:151-156), e o
      // mapa do passageiro filtra igual
      // (supabase/migrations/0069_driver_code_and_fleet_exposure.sql:646).
      //
      // Carimbar `updated_at` aqui ressuscitaria a coordenada da SESSÃO ANTERIOR
      // como se fosse de agora — e o gatilho é o caminho comum, não um canto:
      // `isOnline` é restaurado do AsyncStorage, então todo motorista que fechou
      // o app com a chave ligada reabriria carimbando a posição de ontem. No
      // cenário que esta própria correção persegue (GPS desligado, permissão
      // negada) nenhum fix chega para corrigir, e ele receberia oferta onde não
      // está. A coluna só é carimbada por quem tem coordenada nova para gravar —
      // aqui e no efeito de posição acima. É o mesmo que o servidor já faz ao
      // derrubar o motorista (supabase/functions/stripe-webhook/index.ts:681).
      const semFix = !loc;
      const resposta = loc
        ? await supabase.from('driver_locations').upsert({
            driver_id: profile.id,
            lat: loc.lat,
            lng: loc.lng,
            heading: loc.heading ?? null,
            is_online: isOnline,
            updated_at: new Date().toISOString(),
          }).select('is_online').maybeSingle()
        : await supabase.from('driver_locations')
            .update({ is_online: isOnline })
            .eq('driver_id', profile.id)
            .select('is_online').maybeSingle();
      const { data, error } = resposta;
      if (cancelled) return;

      const decision = decideStatusRevert({
        requested: isOnline,
        returned: typeof data?.is_online === 'boolean' ? data.is_online : null,
        failed: !!error,
        // UPDATE sem erro e sem linha = zero linhas casadas: este motorista não
        // tem linha em `driver_locations` (conta que nunca ficou online com GPS,
        // ou linha apagada por delete-account). Sem `lat`/`lng` não há como
        // criá-la AQUI — quem a cria é o efeito de posição, no primeiro fix.
        // Por isso a chave NÃO cai neste caso (ver o bloco correspondente em
        // driverOnlineStatus.ts): derrubá-la desligaria o único caminho que
        // ainda pode fazer a linha nascer.
        noRow: semFix && !error && data === null,
        // Sem coordenada, `updated_at` NÃO é carimbado (ver o bloco acima) — e é
        // ele, não `is_online`, que põe o motorista no leque do despacho. O
        // servidor devolver `true` aqui NÃO é sucesso do ponto de vista dele.
        noPosition: semFix,
        userInitiated,
      });

      // O aviso de "online sem posição" NÃO sobe por aqui, e isso é deliberado:
      // neste instante o heartbeat de abertura ainda não teve tempo de receber
      // fix nenhum, e levantar na hora seria o "banner que subia sozinho" com
      // outro texto. Quem leva esse caso é o VIGIA (efeito logo abaixo), que dá
      // a carência e reavalia. O que esta rodada não pode fazer é o oposto:
      // APAGAR o aviso do vigia devolvendo um 'ok' que ignora a falta de posição
      // — por isso `noPosition` entra na decisão, e por isso este caminho não
      // LEVANTA banner nenhum.
      const paraOVigia = decision.reason === 'no_position' && decision.revertTo === null;
      // Só apaga o banner se nenhuma outra gravação de status saiu depois desta
      // — ver `statusWriteSeqRef`. Levantar não passa pelo teste de frescor.
      if (!paraOVigia && (decision.syncFailed || seq === statusWriteSeqRef.current)) {
        donoDoBannerRef.current = decision.syncFailed ? 'transicao' : null;
        setStatusSyncFailed(decision.syncFailed);
        setStatusSyncReason(decision.reason);
      } else if (paraOVigia && seq === statusWriteSeqRef.current && donoDoBannerRef.current !== 'vigia') {
        // NÃO LEVANTAR NÃO É NÃO TOCAR. Calar o bloco inteiro deixava um aviso
        // velho preso na tela com o app funcionando: rede cai, o toque se perde,
        // sobe 'transport' e a chave volta; a rede volta, o motorista toca em
        // Online de novo e o UPDATE é ACEITO — mas o banner de conexão continua
        // lá, porque o vigia é mudo enquanto houver aviso na tela e o efeito de
        // posição só apaga o que ele mesmo levantou. O aviso sobrevivia ao turno
        // inteiro, e o comentário do efeito de posição já diz o preço disso: o
        // motorista que confia no aviso encosta e deixa de rodar por nada.
        //
        // Esta resposta DESMENTE o que 'transport' e 'refused' afirmam: a escrita
        // chegou ao servidor e voltou aceita, com o valor pedido. O que ela NÃO
        // desmente é a falta de posição — ela é a própria prova disso —, e por
        // isso o banner do VIGIA fica de pé. Como 'no_position' só é levantado
        // por ele, checar o dono é checar exatamente essa exceção.
        donoDoBannerRef.current = null;
        setStatusSyncFailed(false);
        setStatusSyncReason('ok');
      }
      // A REVERSÃO não passa pelo teste de frescor de propósito: ela é a resposta
      // a ESTA escrita ("seu toque não valeu" / "o servidor recusou"), e um fix de
      // GPS posterior não desmente nenhuma das duas. Engoli-la por chegar fora de
      // ordem devolveria a chave verde mentindo, que é o defeito de origem.
      if (decision.revertTo !== null) aplicarReversao(decision.revertTo);
    })();
    return () => { cancelled = true; };
  }, [isOnline, profile?.id, onlineLoaded]);

  // ─── VIGIA: ONLINE SEM POSIÇÃO NO SERVIDOR ────────────────────────────────
  //
  // O buraco que este efeito fecha: os dois efeitos acima só falam quando uma
  // ESCRITA responde. Quem não tem fix de GPS não gera escrita de posição
  // nenhuma — o efeito de posição começa com `if (!location ...) return` —, e a
  // escrita de status que sobra é um UPDATE que o servidor ACEITA. Resultado
  // antes disto: chave verde, nenhum erro, nenhum banner, `updated_at` velho e
  // nenhuma corrida chegando, pelo turno inteiro. Era o silêncio descrito no
  // cabeçalho de driverOnlineStatus.ts, entrando pela porta de trás.
  //
  // Por que um TEMPORIZADOR e não um `if` no efeito de transição: no instante em
  // que a transição responde ainda não dá para distinguir "GPS morto" de "GPS
  // acordando" — e chutar ali era o defeito de origem. O prazo é o que
  // transforma ausência instantânea em ausência PROVADA, e cada publicação
  // bem-sucedida o re-arma (é a reavaliação que faltava do lado sem fix).
  //
  // O aviso não derruba a chave de propósito, e isso vale para os DOIS casos
  // sem coordenada: quando a linha existe (o `is_online` pedido está gravado, só
  // falta `updated_at`) e quando ela não existe (nada foi gravado). Nos dois, a
  // única cura é o primeiro fix de GPS chegar e o efeito de posição publicá-lo —
  // carimbando a coluna ou criando a linha —, e esse efeito só roda com a chave
  // ligada. Desligá-la aqui apaga o sintoma e mata a cura junto.
  useEffect(() => {
    // Offline não há promessa a cobrar: a posição só é publicada em serviço, e
    // aviso de GPS com a chave cinza é ruído.
    const emServico = !!profile?.id && onlineLoaded && isOnline;
    if (donoDoBannerRef.current === 'vigia') {
      // Re-armar é declarar que a situação mudou (publicou, ou saiu de serviço).
      // Quem levantou apaga — e só o que levantou.
      donoDoBannerRef.current = null;
      setStatusSyncFailed(false);
      setStatusSyncReason('ok');
    }
    if (!emServico) {
      // Fora de serviço o relógio da carência não existe. Zerar aqui é o que
      // faz o turno SEGUINTE começar pela carência inteira em vez de herdar um
      // marco vencido do turno passado.
      inicioServicoRef.current = null;
      return;
    }
    const agora = Date.now();
    // Marco do INÍCIO DO TURNO, não do último fix de GPS. A diferença importa: o
    // que põe o motorista no leque é a POSIÇÃO CHEGAR AO SERVIDOR, não o GPS
    // produzir fix. Ancorando a carência num fix, um aparelho que entrega fix a
    // cada 5 s e cujas publicações ficam PENDURADAS (rede que não responde e
    // também não erra) empurraria o prazo para sempre, e o vigia nunca falaria —
    // que é exatamente o silêncio que ele existe para quebrar.
    if (inicioServicoRef.current === null) inicioServicoRef.current = agora;
    const prazo = ultimaPosOkMs === null
      ? Math.max(0, inicioServicoRef.current + CARENCIA_PRIMEIRA_POSICAO_MS - agora)
      : Math.max(0, ultimaPosOkMs + LIMITE_FRESCOR_POSICAO_MS - agora);
    const id = setTimeout(() => {
      // O VIGIA SÓ FALA NO SILÊNCIO. Um aviso já na tela veio de alguém que viu
      // uma escrita falhar de verdade — rede caída, recusa do trigger — e isso é
      // mais específico do que "faz tempo que não publico". Trocar aquele texto
      // por este apagaria a pista melhor: é o mesmo erro de mandar checar a
      // conexão quando o problema é o cadastro do Stripe.
      if (statusSyncFailedRef.current) return;
      // ─── DE QUE FALTA ESTAMOS FALANDO: GPS OU CONEXÃO ─────────────────────
      //
      // O prazo vence de um jeito só, mas as causas pedem remédios OPOSTOS, e
      // mandar o motorista checar a coisa errada é o defeito que este módulo
      // persegue. A evidência que separa as duas é uma só, e o app tem:
      //
      //   • CHEGOU fix depois do começo do turno (e depois da última publicação
      //     confirmada) e mesmo assim não há posição no servidor. Então o GPS
      //     está vivo — quem não passa é a PUBLICAÇÃO. É o vão de rede que
      //     engole a requisição sem responder, e mandar checar o GPS ali aponta
      //     para o único pedaço do aparelho que está funcionando. Texto de
      //     conexão.
      //   • NÃO chegou fix nenhum. Aí a falta é de posição mesmo: GPS desligado,
      //     permissão negada, aparelho sem sinal. Texto de GPS.
      //
      // O QUE ESTA DISTINÇÃO NÃO RESOLVE, e é preciso dizer em vez de fingir:
      // um motorista PARADO também para de emitir fix. O `distanceInterval: 15`
      // (useLocation.ts:117) não dispara em carro parado e o `timeInterval` é
      // ignorado no iOS (rubrica documentada em dispatch-engine/index.ts:145-148
      // — não observada por nós). Para o app, "parado na fila do MCO" e "GPS
      // morto" são o MESMO silêncio, e não há sinal no aparelho que os separe.
      // Os dois vão levar o texto do GPS, e isso é escolha: no servidor o
      // desfecho é idêntico (aos 10 min ele sai do leque dos dois jeitos), e
      // calar para poupar o motorista parado devolveria o silêncio ao motorista
      // com o GPS morto — que é o defeito de origem, não um alarme falso.
      const fixSemPublicacao =
        ultimoFixMsRef.current !== null
        && ultimoFixMsRef.current > Math.max(inicioServicoRef.current ?? 0, ultimaPosOkMs ?? 0);
      const falha = fixSemPublicacao
        // A escrita de posição EXISTIU e não chegou: é falha de transporte
        // mesmo. Sem `userInitiated` ela avisa sem mexer na chave, que é o que
        // esta função quer — derrubá-la mataria a única cura (o efeito de
        // posição só publica com a chave ligada).
        ? decideStatusRevert({ requested: true, returned: null, failed: true, userInitiated: false })
        : decideStatusRevert({
            requested: true,
            // Nenhuma divergência de VALOR a reportar: se o servidor tivesse
            // coagido `is_online := false`, quem levantaria o banner (com o
            // texto do Stripe, que é o certo) seria o efeito de transição, e o
            // guarda acima já teria feito este temporizador calar. O que sobra é
            // ausência de posição fresca — valha a linha sem `updated_at` novo
            // ou a linha que não existe: `no_position` cobre as duas.
            returned: true,
            failed: false,
            userInitiated: false,
            noPosition: true,
          });
      donoDoBannerRef.current = 'vigia';
      setStatusSyncFailed(falha.syncFailed);
      setStatusSyncReason(falha.reason);
    }, prazo);
    return () => clearTimeout(id);
    // `location` FICOU DE FORA da lista, e isso é a escolha do efeito.
    //
    // A versão anterior o listava, com o argumento de que "um fix novo é sinal
    // de que o GPS voltou a viver". Só que um fix de GPS não põe ninguém no
    // leque — quem põe é a PUBLICAÇÃO, e ela tem sua própria dependência aqui
    // (`ultimaPosOkMs`, escrito só quando o servidor confirma). Com `location`
    // na lista, cada fix desarmava e rearmava o temporizador do zero: um GPS
    // vivo publicando num vão de rede que engole as requisições sem responder
    // adiava o aviso indefinidamente.
    //
    // O caso que motivava listá-lo — GPS bom e rede caída, para não trocar o
    // texto de conexão pelo de GPS — continua coberto, e por dois guardas mais
    // diretos: o efeito de posição levanta o aviso de transporte em três fixes
    // seguidos (~15 s, bem dentro da carência de 45 s), e o `if
    // (statusSyncFailedRef.current) return` lá em cima impede o vigia de falar
    // por cima de qualquer aviso já na tela.
  }, [isOnline, onlineLoaded, profile?.id, ultimaPosOkMs]);

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
