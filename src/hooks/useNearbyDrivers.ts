import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../lib/errorReporting';

/**
 * Uma linha do mapa ambiente.
 *
 * SEM `heading`, e a coordenada vem ARREDONDADA para 3 casas (~110 m) pela
 * própria RPC. Ver a migration 0069 seção B.2: posição exata mais rumo,
 * amostradas ao longo do tempo, são a trilha de deslocamento de uma pessoa
 * identificável — e este mapa não precisa de nenhuma das duas coisas para
 * dizer "há carros por perto".
 */
export interface NearbyDriver {
  driver_id: string;
  lat: number;
  lng: number;
}

/** Centro da busca. Sem centro não há busca — ver o comentário do hook. */
export interface NearbyCenter {
  lat: number;
  lng: number;
}

/**
 * Raio pedido, em km. O SERVIDOR grampeia em [2; 15] e devolve no máximo 60
 * linhas (migration 0069, `nearby_online_drivers`); este valor é só o pedido.
 */
const DEFAULT_RADIUS_KM = 8;

/** Fallback quando o app ainda não sabe onde o passageiro está. */
const ORLANDO_CENTER: NearbyCenter = { lat: 28.5383, lng: -81.3792 };

/**
 * Carros online para o mapa do passageiro.
 *
 * ── Por que isto NÃO lê mais `driver_locations` direto ────────────────────
 * A consulta anterior era `select driver_id, lat, lng, heading from
 * driver_locations where is_online = true` — sem raio, sem teto: a posição e o
 * rumo exatos da frota INTEIRA, numa requisição, para qualquer conta logada. E
 * contas são grátis e não verificadas (o Cadastro Expresso cria uma em duas
 * requisições, src/screens/passenger/ExpressRegisterScreen.tsx:76-82). Cruzada
 * com o diretório de usuários, isso era superfície de perseguição: dava para
 * seguir um motorista específico ao vivo, e ele não tinha como perceber nem
 * como sair.
 *
 * A migration 0069 tira `lat/lng/heading` do alcance do SELECT de
 * `authenticated` e passa a coordenada a sair só pela RPC
 * `nearby_online_drivers`, que impõe raio e teto no servidor. Este hook é o
 * client dessa RPC.
 *
 * ── O que a RPC devolve, e por que é MENOS do que antes ───────────────────
 * Trocar `select *` por uma função com raio não era suficiente: a primeira
 * versão da RPC ainda devolvia coordenada EXATA mais `heading`, e o centro era
 * escolhido livremente pelo chamador. Desde a revisão da 0069 B.2 a coordenada
 * vem arredondada para 3 casas decimais (~110 m) e `heading` não vem mais.
 *
 * Consequência VISÍVEL no mapa, e ela é aceita de propósito: os carros andam
 * numa grade de ~110 m em vez de deslizarem, e o marcador não aponta para a
 * direção do movimento. Este mapa é ambiente — ele responde "tem carro por
 * aqui?". A posição do motorista DA SUA corrida não passa por aqui: ela vem de
 * `rides.driver_lat/lng`, com precisão total (ActiveRideScreen.tsx:195-203).
 *
 * ── Rate limit ────────────────────────────────────────────────────────────
 * A RPC agora limita chamadas por `auth.uid()`. O poll de 8 s e a coalescência
 * de 3 s abaixo foram dimensionados PARA CABER nesse teto (~28 chamadas/min no
 * pior caso, contra 90/min permitidos). Se alguém apertar esses intervalos,
 * tem de mexer em `c_rl_short_max` na 0069 junto — senão o mapa começa a
 * falhar em silêncio para usuários legítimos.
 *
 * ── O realtime virou GATILHO, não fonte ───────────────────────────────────
 * Antes, o payload de `postgres_changes` era usado como fonte de coordenada
 * (montava a linha do mapa direto do evento). Não dá mais: o payload não
 * carrega colunas que o assinante não pode ler. Agora qualquer evento na
 * tabela só agenda um refetch da RPC — que é a única fonte. Isso mantém o mapa
 * vivo mesmo se o Realtime entregar payload vazio, ou nada, ou for bloqueado
 * (o que já acontecia no Expo Go, ver ActiveRideScreen.tsx:196-198).
 *
 * O `center` é opcional para não quebrar quem chama `useNearbyDrivers(true)`:
 * sem centro, usa o centro de Orlando, que é a área de operação. Passar a
 * posição real do passageiro é o caminho preferido — o raio passa a valer a
 * partir dele.
 */
export function useNearbyDrivers(enabled = true, center?: NearbyCenter | null) {
  const [drivers, setDrivers] = useState<NearbyDriver[]>([]);

  // Ref para o centro: o refetch é chamado de dentro do handler de realtime e
  // de um interval, e nenhum dos dois deve ser recriado a cada fix de GPS.
  const centerRef = useRef<NearbyCenter>(center ?? ORLANDO_CENTER);
  centerRef.current = center ?? ORLANDO_CENTER;

  const fetchDrivers = useCallback(async () => {
    const { lat, lng } = centerRef.current;
    const { data, error } = await supabase.rpc('nearby_online_drivers', {
      p_lat: lat,
      p_lng: lng,
      p_radius_km: DEFAULT_RADIUS_KM,
    });

    if (error) {
      // Degrada para "nenhum carro" em vez de manter marcadores velhos no mapa.
      // Mostrar posição obsoleta é pior do que não mostrar: o passageiro decide
      // esperar com base nela.
      // `console.warn` some no build de produção: o rate limit da própria RPC
      // ficava invisível na telemetria, exatamente o sinal que explica um mapa
      // vazio em horário de pico.
      reportError(error, { op: 'nearbyDrivers.rpc' });
      setDrivers([]);
      return;
    }
    setDrivers((data as NearbyDriver[]) ?? []);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setDrivers([]);
      return;
    }

    fetchDrivers();

    // Polling a cada 8s — garante atualização mesmo sem realtime (REPLICA
    // IDENTITY pode não estar ativo, e no Expo Go o canal costuma nem subir).
    const poll = setInterval(fetchDrivers, 8000);

    // Coalescência: uma frota inteira publicando posição gera muitos eventos
    // por segundo. Sem isto, cada um viraria uma chamada da RPC.
    //
    // 3 s, e não 1 s: com 1 s o pior caso legítimo era ~68 chamadas/min, perto
    // demais do teto de 90/min que a RPC passou a impor (0069 B.2). A janela
    // maior derruba isso para ~28/min e o mapa continua atualizando bem mais
    // rápido do que o poll de 8 s.
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      if (refetchTimer) return;
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        fetchDrivers();
      }, 3000);
    };

    // ⚠️ DESDE A 0069 B.3 ESTE CANAL NÃO ENTREGA MAIS NADA a um passageiro, e
    // isso é esperado. O Realtime respeita RLS, e a policy ampla
    // `is_online = true` de `driver_locations` foi removida: ela tinha deixado
    // de ter consumidor (o mapa usa a RPC; o leque de push é derivado no
    // servidor) e só entregava a agenda de trabalho da frota a qualquer conta
    // logada. O mapa passa a andar pelo poll de 8 s acima, que sempre foi o
    // caminho garantido — o realtime nunca foi mais que um acelerador (o
    // comentário do poll já dizia isso).
    //
    // A assinatura FICA em vez de ser removida por dois motivos concretos: um
    // motorista usando esta tela continua recebendo os eventos da própria linha
    // (a policy dele sobrevive), e se a política mudar de novo o acelerador
    // volta sozinho. Custo de manter: um canal ocioso.
    const channel = supabase
      .channel('nearby-drivers')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'driver_locations' },
        // O payload é ignorado de propósito — ver o JSDoc do hook.
        scheduleRefetch
      )
      .subscribe();

    return () => {
      clearInterval(poll);
      if (refetchTimer) clearTimeout(refetchTimer);
      supabase.removeChannel(channel);
    };
  }, [enabled, fetchDrivers]);

  return { drivers, refresh: fetchDrivers };
}
