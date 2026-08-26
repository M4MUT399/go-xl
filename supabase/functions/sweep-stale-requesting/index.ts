// Supabase Edge Function — VARREDURA de corridas COBRADAS E ABANDONADAS.
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO
// ─────────────────────────────────────────────────────────────────────────────
// `acceptRide` cobra o cartão do passageiro ANTES de travar a corrida
// (src/hooks/useRide.ts:1624) — de propósito: se o cartão recusa, a corrida não
// é tomada. Se o UPDATE seguinte falhar (useRide.ts:1668-1690), o cliente chama
// `reofferRide` e devolve a corrida ao leque SEM ESTORNAR. O único estorno desse
// caminho é uma rede de segurança do lado do CLIENTE (useRide.ts:759-770): se o
// app do motorista fechar, mudar de tela ou perder a rede naquele instante,
// ninguém estorna nunca.
//
// O desfecho é uma corrida parada em `status = 'requesting'` com `paid = true`:
// o passageiro está cobrado, nenhum motorista foi designado, a viagem não vai
// acontecer e NADA no servidor varria esse estado. O dinheiro ficava com a
// plataforma por omissão — e nem o repasse resgatava isso, porque a
// elegibilidade exige `driver_id` e `driver_amount` não nulos
// (run-weekly-payouts/index.ts:268-273) e uma corrida `requesting` não tem
// nenhum dos dois. Ou seja: dinheiro de passageiro que não vira viagem nem vira
// repasse, e não aparece em relatório nenhum.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE UMA FUNÇÃO AGENDADA NOVA, E NÃO DENTRO DE UM JOB EXISTENTE
// ─────────────────────────────────────────────────────────────────────────────
// O que já roda agendado no repositório (todos os `cron.schedule` das
// migrations):
//   • 0035 `weekly-driver-payouts`      → segunda 17:00 UTC (SEMANAL)
//   • 0052 `audit-log-retention`        → retenção de log
//   • 0057 `period-audit-retention`     → retenção de log
//   • 0058 `telematics-export-cron`     → exportação de telemetria
//   • 0063 `driver-telematics-*`        → telemetria
// `dispatch-engine` NÃO tem cron: o `tick` é disparado pelo cliente.
//
// Nenhum serve:
//   • pendurar no repasse semanal significaria devolver em até 7 DIAS um
//     dinheiro que o passageiro perdeu em 30 minutos — e o repasse roda por
//     MOTORISTA, enquanto estas corridas por definição não têm motorista;
//   • os jobs de retenção/telemetria não tocam em dinheiro, não têm chave do
//     Stripe e emendar estorno neles acopla duas falhas que não têm relação
//     (uma exportação de telemetria quebrada passaria a segurar estorno);
//   • o `tick` do dispatch depende de um cliente aberto — exatamente o que não
//     existe no cenário que causa o defeito.
// Daí uma função própria, agendada a cada 10 min pela migration 0068.
//
// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTÊNCIA E CONVIVÊNCIA COM O refund-ride
// ─────────────────────────────────────────────────────────────────────────────
// Três camadas, nesta ordem:
//   1) a consulta só traz `paid = true`; o estorno grava `paid = false`, então a
//      passada seguinte não vê a mesma corrida;
//   2) o estorno reusa `runRefundFlow`, cuja chave de idempotência é
//      `refund_<paymentIntentId>` (refundFlow.ts:refundIdempotencyKey) — a MESMA
//      que o `refund-ride` usa. Se os dois correrem juntos, o segundo
//      `refunds.create` recebe do Stripe a RESPOSTA em cache do primeiro em vez
//      de criar um segundo estorno;
//   3) a linha de conciliação é `upsert` com `event_id = refund_<refund.id>` e
//      `ignoreDuplicates` — como os dois caminhos chegam ao MESMO refund id
//      (camada 2), a segunda gravação é descartada em vez de duplicar a fila.
//
// ─────────────────────────────────────────────────────────────────────────────
// RESERVAR ANTES DE GASTAR, E TERMINAR A CORRIDA
// ─────────────────────────────────────────────────────────────────────────────
// A versão anterior deixava `status` intacto e chamava isso de estado
// "CONSISTENTE". Não era, por dois motivos que se somam:
//
//   • CORRIDA EM ANDAMENTO ESTORNADA. `charge-ride:154` devolve `already_paid`
//     SEM criar PaymentIntent novo quando `r.paid` é true, e o aceite do
//     motorista (useRide.ts:1666-1680) filtra só por `.eq('status','requesting')`.
//     Logo, uma corrida presa em `requesting` + `paid = true` há 40 min AINDA
//     pode ser aceita, e esse aceite não gera cobrança nenhuma. Caindo entre a
//     releitura daqui e o `refunds.create` — uma ida e volta de rede —, o estorno
//     saía numa viagem já em curso: passageiro andando de graça e motorista sem
//     receber, porque run-weekly-payouts:269 exige `paid = true`.
//     A defesa NÃO é reler melhor; é RESERVAR. O `claim` abaixo é um UPDATE
//     condicional que devolve a linha afetada, e nada é gasto sem ele.
//
//   • TELA DO PASSAGEIRO MENTINDO. Uma corrida varrida que continuasse
//     `requesting` sem motorista ficaria no leque para sempre, com o app do
//     passageiro procurando motorista para uma viagem estornada 30 min antes —
//     nada re-notifica motoristas (`notifyOnlineDrivers` só dispara na
//     solicitação/ativação). Por isso a MESMA reserva move a corrida para
//     `cancelled` com `cancellation_reason = 'stale_requesting_sweep'` (0070), e
//     o passageiro recebe um push contando do estorno.
//
// Se o estorno não se concretizar, a reserva é DESFEITA (`compensateClaim`) e a
// corrida volta a `requesting` + `paid = true`; se nem a compensação conseguir
// gravar, sobra uma linha `needs_attention`.
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTENTICAÇÃO — E POR QUE ELA NÃO DEPENDE MAIS DA FLAG DE DEPLOY
// ─────────────────────────────────────────────────────────────────────────────
// A versão anterior deste arquivo fazia duas coisas incompatíveis: mandava
// publicar com `--no-verify-jwt` (que desliga a validação de ASSINATURA no
// gateway do Supabase) e autorizava com `isServiceRole`, que apenas fazia
// `atob` do payload do JWT e lia `role`. `atob` é base64, não criptografia:
// juntas, as duas coisas aceitavam `Bearer x.<base64 de {"role":"service_role"}>.x`
// de qualquer pessoa — até 100 estornos não autenticados por POST, repetíveis.
//
// Agora a função compara o token apresentado com a própria
// `SUPABASE_SERVICE_ROLE_KEY`, em tempo constante (_shared/serviceAuth.ts). Essa
// pergunta é respondida CORRETAMENTE com ou sem `--no-verify-jwt`, que é o
// ponto: a autorização deixa de depender de uma flag invisível no código.
//
// O chamador é o cron do Postgres mandando a chave lida do Vault (0068), então
// o segredo já está nos dois lados — não há nada a distribuir.
//
// ATENÇÃO, contradição a resolver FORA deste arquivo: run-weekly-payouts/index.ts
// afirma em comentário (:55-61) que é publicada COM verify_jwt, enquanto o
// cabeçalho do MESMO arquivo (:25) manda publicar com `--no-verify-jwt`. As duas
// coisas não podem ser verdade, e qual delas está em produção não é dedutível
// deste repositório — confira em `supabase functions list`. A defesa daqui vale
// nos dois casos; a de lá, não.
//
// Deploy:  npx supabase functions deploy sweep-stale-requesting
//          (SEM --no-verify-jwt: com o gateway validando a assinatura, um token
//           forjado nem chega à função; a checagem daqui é a segunda camada.)
// Segredos: STRIPE_SECRET_KEY + (SUPABASE_URL / SERVICE_ROLE_KEY automáticos)

import Stripe from 'npm:stripe@17';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { planDriverReversal, type TipDisposition } from '../_shared/refundReversal.ts';
import { runRefundFlow, type RefundAuditRow, type RefundPorts } from '../_shared/refundFlow.ts';
import { classifyStaleRide, type StaleRideCandidate } from '../_shared/staleRideSweep.ts';
import { isServiceRoleCaller } from '../_shared/serviceAuth.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ALERT_WEBHOOK_URL    = Deno.env.get('ALERT_WEBHOOK_URL')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Idade mínima para considerar a corrida abandonada.
 *
 * 30 min é MUITA folga sobre o fenômeno real: o intervalo entre a cobrança e o
 * UPDATE em `acceptRide` é de segundos, e a oferta do dispatch v2 expira em 15 s.
 * A folga é de propósito — o erro barato aqui é demorar a estornar; o erro caro
 * é estornar a viagem de alguém que está embarcando.
 */
const MIN_AGE_MS = 30 * 60 * 1000;

/**
 * Teto de corridas por invocação.
 *
 * Era 100, contra um `timeout_milliseconds := 60000` no `net.http_post` da 0068
 * — e o laço é SEQUENCIAL, com um `paymentIntents.retrieve`, um `refunds.create`,
 * duas gravações de conciliação e um push por corrida. 100 × isso não cabe em
 * 60 s por nenhuma estimativa razoável, e o modo de falha era o pior possível:
 * `pg_net` ABANDONA a resposta no timeout enquanto a invocação do Deno continua
 * estornando, então o desfecho ficava invisível do lado do Postgres — o job
 * aparecia como falho tendo movido dinheiro, ou como sucesso tendo parado no
 * meio, sem como distinguir.
 *
 * NÃO tenho como medir a latência real do Stripe neste ambiente. Então a defesa
 * não é um número melhor, são três coisas que não dependem de adivinhar:
 *   • o teto cai para 15 (com cron de 10 min, 90 corridas/h — ordens de grandeza
 *     acima do volume esperado, que no caso normal é ZERO);
 *   • um ORÇAMENTO DE RELÓGIO (`RUN_BUDGET_MS`) interrompe o laço antes do
 *     timeout do pg_net, independentemente de quanto cada corrida demorou;
 *   • uma LINHA-RESUMO por invocação é gravada no fim (e no orçamento estourado),
 *     então um lote truncado é detectável em `stripe_reconciliation` mesmo quando
 *     o `pg_net` já desistiu da resposta.
 */
const MAX_PER_RUN = 15;

/**
 * Orçamento de relógio da invocação, com folga sobre os 60 s do
 * `timeout_milliseconds` da 0068.
 *
 * A checagem é feita ANTES de começar cada corrida, nunca no meio de uma: uma
 * corrida já iniciada vai até o fim (ou se compensa), porque parar entre o
 * `claim` e o `refunds.create` é exatamente o que a reserva existe para evitar.
 * Os 15 s de folga são para a corrida em curso terminar dentro dos 60 s.
 */
const RUN_BUDGET_MS = 45 * 1000;

/** Motivo de cancelamento gravado pela varredura (coluna criada na 0070). */
const SWEEP_CANCELLATION_REASON = 'stale_requesting_sweep';

/**
 * Motivo para a corrida que NUNCA foi aceita — e por isso nunca foi cobrada.
 *
 * A varredura de cima só enxerga `paid = true`, porque só aí existe dinheiro a
 * estornar. Mas a cobrança acontece NO ACEITE: uma corrida que ninguém aceitou
 * jamais fica `paid`, então ela nunca foi candidata a nada — ficava `requesting`
 * para sempre, e o passageiro via "procurando motorista" indefinidamente.
 * Nenhum dos seis `cron.schedule` do repositório a alcançava.
 *
 * Aqui não há Stripe: não houve PaymentIntent, não há o que estornar. É só
 * fechar a corrida e dizer ao passageiro.
 */
const UNPAID_CANCELLATION_REASON = 'stale_unpaid_sweep';

/**
 * Idade a partir da qual uma RESERVA sem pagamento é considerada órfã.
 *
 * O `charge-ride` reserva a corrida (`driver_id`) ANTES de ir ao Stripe e
 * desfaz a reserva se a cobrança não se concretiza. Se a invocação morre no
 * meio — limite de relógio, cold start morto, deploy em andamento — ou se o
 * próprio UPDATE de devolução falha (ele grava `claim_release_failed` e segue),
 * a corrida fica `requesting` + `driver_id` preenchido + não paga. Nesse estado
 * NINGUÉM mais a aceita: a RLS a esconde dos outros motoristas e o reoferecimento
 * do app filtra `driver_id is null`.
 *
 * 5 min é curto de propósito, ao contrário dos 30 de `MIN_AGE_MS`: aqui o
 * desfecho não é destrutivo. Devolver ao leque uma corrida que continua
 * `requesting` e não paga apenas permite que outro motorista a aceite — e o
 * `charge-ride` reserva de novo, atomicamente, antes de cobrar.
 */
const ORPHAN_CLAIM_AGE_MS = 5 * 60 * 1000;

interface StaleRow extends StaleRideCandidate {
  passenger_id?: string | null;
  driver_id?: string | null;
  price?: number | null;
  tip_amount?: number | null;
  tip_payout_id?: string | null;
  payout_id?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  // Não decodifica JWT: COMPARA com a chave de serviço, em tempo constante.
  // Ver o bloco AUTENTICAÇÃO no cabeçalho e _shared/serviceAuth.ts.
  if (!isServiceRoleCaller(req.headers.get('Authorization'), SUPABASE_SERVICE_KEY)) {
    return json({ error: 'Não autorizado' }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const nowMs = Date.now();
    const cutoff = new Date(nowMs - MIN_AGE_MS).toISOString();

    // A consulta é OTIMIZAÇÃO (não trazer a tabela inteira), não a decisão. O
    // filtro por `created_at` sozinho traria corridas AGENDADAS antigas que
    // acabaram de ser ativadas — quem as descarta é `classifyStaleRide`, pela
    // âncora `max(created_at, scheduled_for, PaymentIntent.created)`.
    const { data, error } = await admin
      .from('rides')
      .select(
        'id, status, paid, stripe_payment_intent_id, created_at, scheduled_for, ' +
        'passenger_id, driver_id, price, tip_amount, tip_payout_id, payout_id',
      )
      .eq('status', 'requesting')
      .eq('paid', true)
      .not('stripe_payment_intent_id', 'is', null)
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (error) return json({ error: error.message }, 500);

    // `as unknown as` e não `as` direto: com a lista de colunas montada por
    // concatenação de strings, o parser de tipos do PostgREST não consegue
    // inferir a forma da linha e cai em `GenericStringError[]`, que não se
    // sobrepõe a StaleRow. O `select` acima é a fonte de verdade da forma.
    const rows = (data as unknown as StaleRow[] | null) ?? [];
    const results: Record<string, unknown>[] = [];
    let swept = 0;
    let processed = 0;
    let budgetExhausted = false;

    for (const row of rows) {
      // Orçamento conferido ANTES de começar a corrida — nunca no meio dela.
      if (Date.now() - nowMs > RUN_BUDGET_MS) {
        budgetExhausted = true;
        break;
      }
      const outcome = await sweepOne(admin, row, nowMs);
      processed += 1;
      results.push({ ride_id: row.id, ...outcome });
      if (outcome.swept) swept += 1;
    }

    // ── PASSADAS 2 e 3: as corridas que NUNCA foram cobradas ─────────────────
    // Não movem dinheiro (não há PaymentIntent), então rodam fora do orçamento
    // de relógio do laço acima — são dois UPDATEs, não N idas ao Stripe.
    const released = await releaseOrphanClaims(admin, nowMs);
    const cancelledUnpaid = await cancelStaleUnpaid(admin, cutoff);

    // O lote foi truncado se o orçamento estourou OU se a consulta encheu o teto
    // (nesse caso pode haver mais candidatas esperando a passada seguinte).
    const truncated = budgetExhausted || rows.length >= MAX_PER_RUN;

    // ── LINHA-RESUMO: a única coisa que sobrevive ao timeout do pg_net ────────
    // A 0068 chama esta função com `timeout_milliseconds := 60000`. Quando esse
    // prazo estoura, o pg_net ABANDONA a resposta e o Postgres não fica sabendo
    // de NADA do que aconteceu aqui — nem quantas corridas foram estornadas.
    // Esta linha é gravada pelo próprio Deno, no banco, então ela existe mesmo
    // quando o corpo da resposta HTTP nunca chega a ninguém.
    await recordSweepAudit(admin, {
      eventId: `sweep_run_${Math.floor(nowMs / 1000)}`,
      rideId: 'run_summary',
      code: 'run_summary',
      needsAttention: truncated,
      reason:
        `Varredura: ${rows.length} candidata(s) lidas, ${processed} processada(s), ${swept} estornada(s) ` +
        `em ${Date.now() - nowMs} ms. ` +
        (budgetExhausted
          ? `O ORÇAMENTO de ${RUN_BUDGET_MS} ms estourou e o lote foi INTERROMPIDO — as restantes saem na ` +
            'próxima passada (10 min). Se esta linha se repetir, o volume passou do que uma invocação ' +
            'aguenta dentro do timeout do pg_net.'
          : rows.length >= MAX_PER_RUN
            ? `A consulta encheu o teto de ${MAX_PER_RUN} — pode haver mais candidatas na fila.`
            : 'Lote completo.'),
      raw: {
        scanned: rows.length,
        processed,
        swept,
        truncated,
        budget_exhausted: budgetExhausted,
        max_per_run: MAX_PER_RUN,
        elapsed_ms: Date.now() - nowMs,
        orphan_claims_released: released,
        unpaid_cancelled: cancelledUnpaid,
      },
      amountCents: 0,
      driverId: null,
      payoutId: null,
    });

    // Truncamento precisa CHEGAR em alguém. A linha-resumo sobrevive ao timeout
    // do pg_net, mas ninguém a lê de rotina — sem este aviso, um lote cortado
    // pela metade é indistinguível de um lote vazio.
    if (truncated) {
      await alertAdmins(
        admin,
        `Varredura truncada: ${processed}/${rows.length} processadas, ${swept} estornadas.`,
        {
          budget_exhausted: budgetExhausted,
          max_per_run: MAX_PER_RUN,
          elapsed_ms: Date.now() - nowMs,
        },
      );
    }

    return json({
      success: true,
      scanned: rows.length,
      processed,
      swept,
      truncated,
      orphanClaimsReleased: released,
      unpaidCancelled: cancelledUnpaid,
      results,
    });
  } catch (e: unknown) {
    const se = e as { raw?: { message?: string }; message?: string };
    return json({ error: se?.raw?.message ?? se?.message ?? String(e) }, 500);
  }
});

/**
 * PASSADA 2 — devolve ao leque as corridas presas numa reserva órfã.
 *
 * Ver `ORPHAN_CLAIM_AGE_MS`. As guardas do `where` são a parte que importa e são
 * as mesmas do `releaseOpenRideClaim` do charge-ride: só solta o que AINDA está
 * `requesting` e NÃO está pago. Se a cobrança se concretizou entre a leitura e
 * este UPDATE, a linha não casa e nada acontece — é o mesmo padrão de reserva
 * condicional do S4, e a razão é idêntica: apagar o `driver_id` de uma corrida
 * que passou a valer seria o espelho do defeito que se está corrigindo.
 *
 * `not paid is true` e não `eq('paid', false)`: `paid` PODE SER NULL neste banco
 * (a 0065 normaliza a coluna, mas nenhuma migration de 0064 em diante rodou), e
 * `= false` não casa com NULL em SQL — seria uma devolução que não devolve nada,
 * justamente no caso que ela existe para desfazer.
 *
 * Nunca lança: esta passada não pode derrubar a varredura de estornos.
 */
async function releaseOrphanClaims(admin: SupabaseClient, nowMs: number): Promise<number> {
  try {
    const staleSince = new Date(nowMs - ORPHAN_CLAIM_AGE_MS).toISOString();

    const { data, error } = await admin
      .from('rides')
      .update({ driver_id: null })
      .eq('status', 'requesting')
      .not('driver_id', 'is', null)
      .not('paid', 'is', true)
      .lt('updated_at', staleSince)
      .select('id');

    if (error) {
      console.error('Falha ao devolver reservas órfãs ao leque', { error: error.message });
      return 0;
    }

    const freed = ((data as { id: string }[] | null) ?? []).length;
    if (freed > 0) {
      // Corrida presa é passageiro esperando por nada. Se isto aparece com
      // frequência, o `charge-ride` está morrendo entre a reserva e o Stripe.
      await alertAdmins(
        admin,
        `${freed} corrida(s) estavam presas numa reserva órfã e voltaram ao leque.`,
        { orphan_claim_age_ms: ORPHAN_CLAIM_AGE_MS },
      );
    }
    return freed;
  } catch (e) {
    console.error('Exceção ao devolver reservas órfãs', e);
    return 0;
  }
}

/**
 * PASSADA 3 — encerra as corridas que ninguém aceitou e que, por isso, nunca
 * foram cobradas.
 *
 * Ver `UNPAID_CANCELLATION_REASON`. Sem Stripe: não houve PaymentIntent, não há
 * estorno. O `where` repete as guardas pelo mesmo motivo da passada 2 — entre
 * ler e escrever cabe um aceite, e cancelar uma corrida que acabou de começar
 * seria trocar um defeito silencioso por um barulhento.
 *
 * O aviso ao passageiro é best-effort e vem DEPOIS do UPDATE: o push falhar não
 * pode deixar a corrida presa em `requesting`, que é o defeito original.
 */
async function cancelStaleUnpaid(admin: SupabaseClient, cutoff: string): Promise<number> {
  try {
    const { data, error } = await admin
      .from('rides')
      .update({
        status: 'cancelled',
        cancellation_reason: UNPAID_CANCELLATION_REASON,
      })
      .eq('status', 'requesting')
      .not('paid', 'is', true)
      .lt('created_at', cutoff)
      .select('id, passenger_id');

    if (error) {
      console.error('Falha ao cancelar corridas nunca aceitas', { error: error.message });
      return 0;
    }

    const rows = (data as { id: string; passenger_id: string | null }[] | null) ?? [];
    for (const r of rows) {
      await recordSweepAudit(admin, {
        eventId: `unpaid_${r.id}`,
        rideId: r.id,
        code: UNPAID_CANCELLATION_REASON,
        needsAttention: false,
        reason:
          `A corrida ${r.id} ficou em 'requesting' sem NENHUM motorista aceitar e, por isso, sem ` +
          'cobrança nenhuma. Foi encerrada pela varredura. Não há dinheiro envolvido — nenhum ' +
          'PaymentIntent chegou a existir. Em volume, isto é falta de oferta (motorista) na região ' +
          'ou no horário, não defeito de pagamento.',
        raw: { phase: 'unpaid_never_accepted' },
        amountCents: 0,
        driverId: null,
        payoutId: null,
      });
      await notifyPassengerRideExpired(admin, r.passenger_id, r.id);
    }
    return rows.length;
  } catch (e) {
    console.error('Exceção ao cancelar corridas nunca aceitas', e);
    return 0;
  }
}

/**
 * Avisa o passageiro de que a corrida foi encerrada sem motorista.
 *
 * Deliberadamente NÃO fala em estorno: não houve cobrança, e prometer devolução
 * de dinheiro que nunca saiu gera exatamente a dúvida que o texto deveria
 * eliminar.
 */
async function notifyPassengerRideExpired(
  admin: SupabaseClient,
  passengerId: string | null,
  rideId: string,
): Promise<void> {
  if (!passengerId) return;
  try {
    const { data } = await admin
      .from('profiles').select('push_token').eq('id', passengerId).maybeSingle();
    const token = (data as { push_token: string | null } | null)?.push_token ?? null;
    if (!token || !token.startsWith('ExponentPushToken')) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        to: token,
        title: 'Não encontramos um motorista',
        body: 'Sua solicitação foi encerrada e nada foi cobrado. Você pode pedir novamente quando quiser.',
        data: { type: 'ride_expired', rideId },
        sound: 'default',
        channelId: 'rides',
      }]),
    });
  } catch (e) {
    console.error('Falha ao avisar o passageiro do encerramento sem motorista', e);
  }
}

/**
 * Decide e, se for o caso, estorna UMA corrida.
 *
 * Nunca lança: uma corrida que dá errado não pode interromper a varredura das
 * outras (mesma resiliência do run-weekly-payouts).
 */
async function sweepOne(
  admin: SupabaseClient,
  row: StaleRow,
  nowMs: number,
): Promise<Record<string, unknown>> {
  try {
    // ── RELEITURA antes de mover dinheiro ────────────────────────────────────
    // Entre a consulta e este ponto um motorista pode ter aceitado a corrida. A
    // releitura é barata e é a diferença entre estornar um abandono e estornar
    // uma viagem em andamento.
    const { data: fresh } = await admin
      .from('rides')
      .select(
        'id, status, paid, stripe_payment_intent_id, created_at, scheduled_for, ' +
        'passenger_id, driver_id, price, tip_amount, tip_payout_id, payout_id',
      )
      .eq('id', row.id)
      .maybeSingle();

    const r = (fresh as StaleRow | null) ?? null;
    if (!r) return { swept: false, reason: 'ride_disappeared' };

    const piId = r.stripe_payment_intent_id ?? '';
    if (!piId) return { swept: false, reason: 'no_payment_intent' };

    // ── PaymentIntent: a resposta AUTORITATIVA ───────────────────────────────
    // Duas perguntas de uma vez: há quanto tempo este passageiro foi cobrado
    // (`created`) e o dinheiro realmente entrou (`status`). Se a leitura falhar,
    // NÃO estornamos no escuro — vira pendência registrada e a corrida volta na
    // passada seguinte.
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.retrieve(piId);
    } catch (e) {
      await recordSweepAudit(admin, {
        eventId: `sweep_pi_unreadable_${piId}_${Math.floor(nowMs / 3_600_000)}`,
        rideId: r.id,
        code: 'pi_unreadable',
        needsAttention: false,
        reason:
          `Varredura de corrida abandonada: não foi possível reler o PaymentIntent ${piId} ` +
          `(${errMessage(e)}). NADA foi estornado — a corrida volta na próxima passada. ` +
          'Se esta linha se repetir, o PaymentIntent gravado na corrida pode não existir mais.',
        raw: { payment_intent: piId, error: errMessage(e) },
        amountCents: Math.round((r.price ?? 0) * 100),
        driverId: r.driver_id ?? null,
        payoutId: r.payout_id ?? null,
      });
      return { swept: false, reason: 'pi_unreadable' };
    }

    // `paid = true` com PaymentIntent que não teve sucesso é INCONSISTÊNCIA de
    // dados, não abandono — e `refunds.create` sobre ele lançaria. Registra para
    // um humano olhar em vez de tentar mover dinheiro.
    if (pi.status !== 'succeeded') {
      await recordSweepAudit(admin, {
        eventId: `sweep_pi_bad_status_${piId}`,
        rideId: r.id,
        code: 'pi_not_succeeded',
        needsAttention: true,
        reason:
          `Corrida ${r.id} está paid = true há mais de 30 min em status 'requesting', mas o ` +
          `PaymentIntent ${piId} está '${pi.status}' — a cobrança não se concretizou. A varredura ` +
          'NÃO estornou (não há o que estornar). O `paid = true` do banco está mentindo: confira à mão.',
        raw: { payment_intent: piId, pi_status: pi.status },
        amountCents: pi.amount ?? 0,
        driverId: r.driver_id ?? null,
        payoutId: r.payout_id ?? null,
      });
      return { swept: false, reason: 'pi_not_succeeded' };
    }

    // ── Decisão pura ─────────────────────────────────────────────────────────
    const verdict = classifyStaleRide(r, {
      nowMs,
      minAgeMs: MIN_AGE_MS,
      chargeCreatedMs: typeof pi.created === 'number' ? pi.created * 1000 : null,
    });
    if (!verdict.sweep) return { swept: false, reason: verdict.reason, age_ms: verdict.ageMs };

    // ── Estorno ──────────────────────────────────────────────────────────────
    // Uma corrida `requesting` é ESTRUTURALMENTE não-repassável: a elegibilidade
    // exige `driver_id` e `driver_amount` não nulos, e ela não tem nenhum dos
    // dois. Então `payout_id` é nulo e `planDriverReversal` devolve
    // 'nothing_transferred' — não há transfer para reverter, e por isso a
    // varredura nem precisa varrer os transfers do Stripe. Passar o
    // `payout_id` real (em vez de `null` fixo) mantém isso HONESTO: se algum dia
    // uma corrida chegar aqui com repasse, o plano muda sozinho em vez de
    // ignorar dinheiro que saiu.
    const plan = planDriverReversal({
      payoutId: r.payout_id ?? null,
      accountId: null,
      transfer: null,
    });

    // Gorjeta em corrida `requesting` não existe (a gorjeta vem depois da
    // conclusão), mas a derivação segue a mesma regra do refund-ride em vez de
    // assumir zero.
    const tip: TipDisposition = Math.round((r.tip_amount ?? 0) * 100) <= 0
      ? 'none'
      : (r.tip_payout_id ? 'charged_payout_pending' : 'charged_not_transferred');

    const ports: RefundPorts = {
      // ── RESERVA: um UPDATE condicional, ANTES de qualquer chamada ao Stripe ──
      // Os três filtros são a trava inteira: `status = 'requesting'` e
      // `paid = true` reproduzem exatamente o estado do defeito, então um aceite
      // que tenha chegado primeiro (que grava `status`/`driver_id`) faz este
      // UPDATE não casar linha nenhuma — e sem linha não se gasta nada.
      //
      // `.select('id')` não é enfeite: é o que transforma "atualizei" em "TOMEI
      // a linha". Sem ele o PostgREST devolve sucesso mesmo tendo casado zero
      // linhas, que é justamente o desfecho que precisamos distinguir.
      //
      // O mesmo UPDATE termina a corrida (S6): `cancelled` +
      // `cancellation_reason`, para o app do passageiro parar de procurar
      // motorista para uma viagem que foi estornada.
      claim: async (rideId) => {
        const { data, error } = await admin
          .from('rides')
          .update({
            paid: false,
            status: 'cancelled',
            cancellation_reason: SWEEP_CANCELLATION_REASON,
          })
          .eq('id', rideId)
          .eq('status', 'requesting')
          .eq('paid', true)
          .select('id');
        if (error) return { claimed: false, detail: `falha ao reservar: ${error.message}` };
        const took = ((data as { id: string }[] | null) ?? []).length > 0;
        return {
          claimed: took,
          detail: took
            ? null
            : 'a corrida deixou de estar requesting+paid entre a releitura e a reserva ' +
              '(aceite de motorista ou estorno por outro caminho) — nada foi movido',
        };
      },

      // ── COMPENSAÇÃO: o estorno não saiu, então a reserva não pode ficar ─────
      // Devolve a corrida ao estado anterior. Os filtros garantem que só
      // desfazemos a NOSSA reserva: `cancellation_reason` marca a autoria.
      compensateClaim: async (rideId, detail) => {
        const { data, error } = await admin
          .from('rides')
          .update({ paid: true, status: 'requesting', cancellation_reason: null })
          .eq('id', rideId)
          .eq('status', 'cancelled')
          .eq('cancellation_reason', SWEEP_CANCELLATION_REASON)
          .eq('paid', false)
          .select('id');
        const undone = !error && ((data as { id: string }[] | null) ?? []).length > 0;
        if (undone) return;
        // Compensar falhou: a corrida ficou cancelada e `paid = false` com o
        // dinheiro ainda no Stripe. Isso NÃO pode sumir.
        await recordSweepAudit(admin, {
          eventId: `sweep_compensate_failed_${r.id}_${piId}`,
          rideId: r.id,
          code: 'claim_compensation_failed',
          needsAttention: true,
          reason:
            `A varredura RESERVOU a corrida ${r.id} (cancelled + paid = false) e o estorno NÃO se ` +
            `concretizou (${detail}). A tentativa de desfazer a reserva também não pegou a linha ` +
            `(${error?.message ?? 'nenhuma linha casou'}). O passageiro segue COBRADO no Stripe e a ` +
            'corrida está cancelada e marcada como não paga: nem a varredura volta nela (o filtro é ' +
            '`requesting`) nem o repasse a alcança. Resolva à mão.',
          raw: {
            payment_intent: piId,
            refund_detail: detail,
            db_error: error?.message ?? null,
          },
          amountCents: pi.amount ?? 0,
          driverId: r.driver_id ?? null,
          payoutId: r.payout_id ?? null,
        });
        await alertAdmins(
          admin,
          `Varredura: a corrida ${r.id} ficou reservada (cancelled + paid = false) sem estorno e a compensação falhou. Passageiro cobrado sem viagem — resolva à mão.`,
          { type: 'sweep_claim_compensation_failed', rideId: r.id },
        );
      },

      createReversal: async ({ transferId, amountCents, rideId }) => {
        const rev = await stripe.transfers.createReversal(transferId, {
          amount: amountCents,
          metadata: { ride_id: rideId, reason: 'stale_requesting_sweep' },
        }, { idempotencyKey: `reverse_${transferId}_${amountCents}` });
        return { id: rev.id };
      },
      createRefund: async ({ paymentIntentId, rideId, reversalId, idempotencyKey }) => {
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          metadata: { ride_id: rideId, reversal_id: reversalId ?? '', reason: 'stale_requesting_sweep' },
        }, { idempotencyKey });
        return { id: refund.id, status: refund.status, amount: refund.amount };
      },
      // NUNCA chamada nesta função: com `claim` presente, `runRefundFlow` pula
      // esta porta porque a reserva já gravou `paid = false`. Fica implementada
      // porque a interface a exige e porque uma porta que mente ("gravei") seria
      // pior do que uma que faz a coisa certa se um dia for chamada.
      markUnpaid: async (rideId) => {
        const { error } = await admin
          .from('rides').update({ paid: false }).eq('id', rideId).eq('paid', true);
        return { error: error ? { message: error.message, code: error.code ?? null } : null };
      },
      recordAudit: (auditRow) => recordRefundAudit(admin, auditRow),
      alertAdmins: (message, meta) => alertAdmins(admin, message, meta),
    };

    const result = await runRefundFlow(ports, {
      rideId: r.id,
      paymentIntentId: piId,
      plan,
      driverId: r.driver_id ?? null,
      payoutId: r.payout_id ?? null,
      driverAmount: null,
      tipAmount: r.tip_amount ?? null,
      tipPayoutId: r.tip_payout_id ?? null,
      rideStatus: r.status ?? null,
      tip,
    });

    if (!result.ok) {
      // `claim_lost` é o desfecho BOM da corrida contra o aceite: alguém pegou a
      // corrida primeiro, nada foi movido, e não há pendência nenhuma a abrir.
      const code = (result.body as { code?: string }).code ?? null;
      if (code === 'claim_lost') {
        return { swept: false, reason: 'claim_lost', detail: (result.body as { detail?: string }).detail ?? null };
      }
      return { swept: false, reason: 'refund_failed', detail: result.body };
    }

    // Linha PRÓPRIA da varredura, separada da do `runRefundFlow`: aquela conta o
    // estorno, esta conta POR QUE ele aconteceu sem ninguém pedir. Sem
    // `needs_attention` — o dinheiro já voltou ao passageiro, não há nada para um
    // humano fazer; a linha é para medir a frequência do defeito de origem.
    await recordSweepAudit(admin, {
      eventId: `sweep_stale_${r.id}_${piId}`,
      rideId: r.id,
      code: 'stale_requesting_refunded',
      needsAttention: false,
      reason:
        `Corrida ficou ${Math.round(verdict.ageMs / 60000)} min em status 'requesting' com paid = true ` +
        '(passageiro cobrado, nenhum motorista designado) e foi estornada automaticamente pela varredura. ' +
        'Causa típica: a cobrança em acceptRide saiu e o UPDATE seguinte falhou, e o app não chegou a ' +
        `rodar a rede de segurança do cliente. A corrida foi encerrada como 'cancelled' com ` +
        `cancellation_reason = '${SWEEP_CANCELLATION_REASON}' na MESMA reserva que liberou o estorno, e ` +
        'o passageiro foi notificado.',
      raw: {
        payment_intent: piId,
        age_ms: verdict.ageMs,
        refund_id: (result.body as { refund_id?: string }).refund_id ?? null,
        pi_created: pi.created ?? null,
        cancellation_reason: SWEEP_CANCELLATION_REASON,
      },
      amountCents: pi.amount ?? 0,
      driverId: null,
      payoutId: null,
    });

    // O passageiro precisa saber. Sem isto ele fica olhando uma tela de "
    // procurando motorista" por uma corrida que acabou de ser encerrada e
    // estornada — e a tela deixar de mentir é metade do conserto.
    await notifyPassengerRefunded(admin, r.passenger_id ?? null, r.id, pi.amount ?? 0);

    return { swept: true, age_ms: verdict.ageMs, refund: result.body };
  } catch (e) {
    console.error('[sweep-stale-requesting] falha na corrida', row.id, e);
    return { swept: false, reason: 'exception', detail: errMessage(e) };
  }
}

function errMessage(e: unknown): string {
  const se = e as { raw?: { message?: string }; message?: string };
  return se?.raw?.message ?? se?.message ?? String(e);
}

/**
 * Avisa o PASSAGEIRO de que a corrida foi encerrada e o dinheiro devolvido.
 *
 * Por que o push sai daqui e não do `send-ride-push`: aquela função autoriza a
 * partir do JWT de um USUÁRIO (`auth.getUser`), e a varredura não é usuário
 * nenhum — é o cron. Reusar o mesmo Expo Push que o `alertAdmins` já usa é mais
 * honesto do que inventar uma identidade para atravessar a autorização de lá.
 *
 * Best-effort, como todo push do repositório: o dinheiro já voltou e a corrida já
 * está encerrada; falhar aqui não pode desfazer nada disso. O estado terminal da
 * linha (a parte que realmente conserta a tela) NÃO depende deste push — o app
 * relê a corrida ativa e ela deixou de ser `requesting`.
 */
async function notifyPassengerRefunded(
  admin: SupabaseClient,
  passengerId: string | null,
  rideId: string,
  amountCents: number,
): Promise<void> {
  if (!passengerId) return;
  try {
    const { data } = await admin
      .from('profiles').select('push_token').eq('id', passengerId).maybeSingle();
    const token = (data as { push_token: string | null } | null)?.push_token ?? null;
    if (!token || !token.startsWith('ExponentPushToken')) return;
    const dollars = (amountCents / 100).toFixed(2);
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        to: token,
        title: '💸 Corrida cancelada — valor estornado',
        body: `Nenhum motorista assumiu sua corrida. Estornamos $${dollars} no seu cartão (o banco pode levar alguns dias para mostrar).`,
        data: { type: 'ride_refunded', rideId },
        sound: 'default',
        channelId: 'rides',
      }]),
    });
  } catch (e) {
    console.error('Falha ao avisar o passageiro do estorno da varredura', e);
  }
}

/** Linha de conciliação da própria varredura. Best-effort, nunca derruba nada. */
async function recordSweepAudit(
  admin: SupabaseClient,
  row: {
    eventId: string;
    rideId: string;
    code: string;
    needsAttention: boolean;
    reason: string;
    raw: Record<string, unknown>;
    amountCents: number;
    driverId: string | null;
    payoutId: string | null;
  },
): Promise<void> {
  try {
    await admin.from('stripe_reconciliation').upsert({
      event_id:        row.eventId,
      event_type:      `sweep.stale_requesting.${row.code}`,
      object_id:       row.rideId,
      amount_cents:    row.amountCents,
      currency:        'usd',
      driver_id:       row.driverId,
      payout_id:       row.payoutId,
      reason:          row.reason,
      needs_attention: row.needsAttention,
      raw:             { ride_id: row.rideId, ...row.raw },
    }, { onConflict: 'event_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('Falha ao gravar stripe_reconciliation da varredura', e);
  }
}

/** Igual ao refund-ride: mesma tabela, mesma idempotência por `event_id`. */
async function recordRefundAudit(admin: SupabaseClient, row: RefundAuditRow): Promise<void> {
  try {
    await admin.from('stripe_reconciliation').upsert({
      event_id:        row.eventId,
      event_type:      `refund.ride.${row.code}`,
      object_id:       row.rideId,
      amount_cents:    row.amountCents,
      currency:        'usd',
      driver_id:       row.driverId,
      payout_id:       row.payoutId,
      reason:          row.reason,
      needs_attention: row.needsAttention,
      raw:             { ride_id: row.rideId, source: 'stale_requesting_sweep', ...row.raw },
    }, { onConflict: 'event_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('Falha ao gravar stripe_reconciliation do estorno', e);
  }
}

/** Webhook externo + push aos admins. Best-effort. */
async function alertAdmins(
  admin: SupabaseClient,
  message: string,
  meta: Record<string, unknown>,
): Promise<void> {
  if (ALERT_WEBHOOK_URL) {
    try {
      await fetch(ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
    } catch (e) {
      console.error('Falha ao chamar ALERT_WEBHOOK_URL', e);
    }
  }
  try {
    const { data: admins } = await admin
      .from('profiles')
      .select('push_token')
      .eq('is_admin', true)
      .not('push_token', 'is', null);
    const tokens = ((admins ?? []) as { push_token: string | null }[])
      .map((a) => a.push_token)
      .filter((t): t is string => !!t);
    if (tokens.length === 0) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map((to) => ({
        to, title: '🚨 Go XL — varredura', body: message, data: meta, sound: 'default', priority: 'high',
      }))),
    });
  } catch (e) {
    console.error('Falha ao alertar admins sobre a varredura', e);
  }
}
