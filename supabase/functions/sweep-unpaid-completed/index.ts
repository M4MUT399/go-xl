// Supabase Edge Function — VARREDURA de corridas CONCLUÍDAS E NÃO COBRADAS.
//
// A simétrica do `sweep-stale-requesting`: aquela DEVOLVE dinheiro cobrado que
// não virou viagem; esta COBRA viagem que aconteceu e não virou dinheiro.
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO (medido em produção, 05/09/2026)
// ─────────────────────────────────────────────────────────────────────────────
// Das 128 corridas concluídas desde 01/07: até 30/07, ~120 IMEDIATAS, todas
// cobradas pelo app; de 17/08 em diante, 5 AGENDADAS, NENHUMA cobrada pelo app.
// Quatro foram salvas à mão (`metadata.retroativo = "true"`, do
// `supabase/scripts/charge_unpaid_ride.ts`) e a quinta ficou um dia parada sem
// que nada percebesse. O diagnóstico completo, com as três portas de cobrança
// que vivem dentro de um celular, está em `_shared/unpaidRideSweep.ts`.
//
// O ponto desta função não é "mais um lugar que cobra". É tirar a última
// garantia de dentro do telefone: hoje a única rede é `void (async () => …)` no
// app do motorista, no instante em que ele fecha a tela da viagem, e uma falha
// ali não deixa rastro em lugar nenhum do servidor.
//
// ─────────────────────────────────────────────────────────────────────────────
// A DIREÇÃO SEGURA DO ERRO
// ─────────────────────────────────────────────────────────────────────────────
// Na dúvida, NÃO cobra. Uma cobrança indevida sai do cartão de alguém que não
// pediu nada naquele instante e custa estorno, explicação e confiança; uma
// cobrança que deixou de sair custa uma linha em `stripe_reconciliation` com
// `needs_attention`, que é exatamente o relatório que hoje não existe.
//
// Por isso: teto de idade (`MAX_AGE_MS`) além do qual a varredura PARA de cobrar
// e passa a só reportar; nada é cobrado quando já existe PaymentIntent gravado;
// e a releitura do intent (`verifyChargeCollected`) decide `paid = true`, nunca
// a resposta do POST.
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTENTICAÇÃO
// ─────────────────────────────────────────────────────────────────────────────
// Mesma do `sweep-stale-requesting`: compara o token apresentado com a própria
// `SUPABASE_SERVICE_ROLE_KEY` em tempo constante (`_shared/serviceAuth.ts`), o
// que responde certo com ou sem `--no-verify-jwt`. O chamador é o cron do
// Postgres mandando a chave lida do Vault (migração 0084), então o segredo já
// está nos dois lados — não há nada a distribuir.
//
// Deploy:  npx supabase functions deploy sweep-unpaid-completed
//          (SEM --no-verify-jwt: com o gateway validando a assinatura, um token
//           forjado nem chega aqui; a checagem interna é a segunda camada.)
// Segredos: STRIPE_SECRET_KEY + (SUPABASE_URL / SERVICE_ROLE_KEY automáticos)

import Stripe from 'npm:stripe@17';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  chargeIdempotencyKey,
  verifyChargeCollected,
  type SettledIntentShape,
} from '../_shared/chargeCycle.ts';
import { classifyUnpaidRide, type UnpaidRideCandidate } from '../_shared/unpaidRideSweep.ts';
import { isServiceRoleCaller } from '../_shared/serviceAuth.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Carência antes de a varredura assumir a corrida (20 min).
 *
 * Não é para "esperar o dinheiro cair" — é para não correr contra a rede de
 * segurança do app. Se o telefone do motorista ainda vai cobrar, que cobre ele:
 * as duas usam a MESMA chave de idempotência, então nem competem de verdade,
 * mas a carência mantém a ordem de responsabilidade legível.
 */
const MIN_AGE_MS = 20 * 60 * 1000;

/**
 * Teto de idade (7 dias). Acima disso a varredura só REPORTA.
 *
 * No dia em que esta função subir existem corridas antigas não cobradas no
 * banco. Sem teto, o primeiro ciclo sairia cobrando cartões semanas depois da
 * viagem — e uma cobrança que ninguém reconhece é indistinguível de fraude para
 * quem a recebe. Passado o prazo, quem decide é uma pessoa, com o
 * `charge_unpaid_ride.ts` na mão.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Teto de corridas por passada. Cada uma é uma ida ao Stripe. */
const MAX_PER_RUN = 10;

/**
 * Orçamento de relógio. A 0084 chama com `timeout_milliseconds := 60000`;
 * parar em 45s deixa margem para a linha-resumo ser gravada antes disso.
 */
const RUN_BUDGET_MS = 45 * 1000;

interface UnpaidRow extends UnpaidRideCandidate {
  passenger_id: string;
  driver_amount?: number | null;
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

  if (!isServiceRoleCaller(req.headers.get('Authorization'), SUPABASE_SERVICE_KEY)) {
    return json({ error: 'Não autorizado' }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const nowMs = Date.now();
    const cutoff = new Date(nowMs - MIN_AGE_MS).toISOString();

    // A consulta é OTIMIZAÇÃO (não trazer a tabela inteira), não a decisão —
    // quem decide é `classifyUnpaidRide`, de novo, sobre a linha RELIDA na hora
    // de cobrar. Ordem crescente por conclusão: a mais antiga dentro da janela
    // é a que corre risco de estourar o teto de idade primeiro.
    const { data, error } = await admin
      .from('rides')
      .select('id, status, paid, price, driver_id, passenger_id, completed_at, stripe_payment_intent_id, driver_amount')
      .eq('status', 'completed')
      .eq('paid', false)
      .lt('completed_at', cutoff)
      .order('completed_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (error) return json({ error: error.message }, 500);

    const rows = (data as unknown as UnpaidRow[] | null) ?? [];
    const results: Record<string, unknown>[] = [];
    let charged = 0;
    let attention = 0;
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
      if (outcome.charged) charged += 1;
      if (outcome.needsAttention) attention += 1;
    }

    const truncated = budgetExhausted || rows.length >= MAX_PER_RUN;

    // ── LINHA-RESUMO: a única coisa que sobrevive ao timeout do pg_net ────────
    // Quando os 60s da 0084 estouram, o pg_net ABANDONA a resposta e o Postgres
    // não fica sabendo de nada do que aconteceu aqui. Esta linha é gravada pelo
    // próprio Deno, no banco, então existe mesmo quando o corpo do HTTP não
    // chega a ninguém. Mesmo raciocínio (e mesma tabela) do sweep irmão.
    await recordSummary(admin, {
      nowMs,
      candidates: rows.length,
      processed,
      charged,
      attention,
      truncated,
    });

    return json({ ok: true, candidates: rows.length, processed, charged, attention, truncated, results });
  } catch (e: unknown) {
    const se = e as { raw?: { message?: string }; message?: string };
    return json({ error: se?.raw?.message ?? se?.message ?? String(e) }, 500);
  }
});

interface SweepOutcome {
  charged: boolean;
  needsAttention: boolean;
  reason: string;
  payment_intent_id?: string;
  detail?: string;
}

/**
 * Uma corrida. RELÊ a linha antes de mover dinheiro — entre a consulta do lote e
 * este ponto cabe uma ida e volta de rede, e nessa janela o app do motorista
 * pode ter cobrado.
 */
async function sweepOne(
  admin: SupabaseClient,
  row: UnpaidRow,
  nowMs: number,
): Promise<SweepOutcome> {
  const { data: fresh } = await admin
    .from('rides')
    .select('id, status, paid, price, driver_id, passenger_id, completed_at, stripe_payment_intent_id')
    .eq('id', row.id)
    .maybeSingle();

  const r = (fresh as unknown as UnpaidRow | null) ?? null;
  if (!r) return { charged: false, needsAttention: false, reason: 'sumiu' };

  const verdict = classifyUnpaidRide(r, { nowMs, minAgeMs: MIN_AGE_MS, maxAgeMs: MAX_AGE_MS });

  if (!verdict.charge) {
    if (verdict.needsAttention) {
      await recordAudit(admin, {
        rideId: r.id,
        eventId: `unpaid_skip_${r.id}_${verdict.reason}`,
        amountCents: Math.round((r.price ?? 0) * 100),
        driverId: r.driver_id ?? null,
        needsAttention: true,
        code: `unpaid_sweep_${verdict.reason}`,
        reason: motivoLegivel(verdict.reason, r),
        raw: { phase: 'classify', reason: verdict.reason, age_ms: verdict.ageMs },
      });
    }
    return { charged: false, needsAttention: verdict.needsAttention, reason: verdict.reason };
  }

  // ── Forma de pagamento do passageiro ──────────────────────────────────────
  const { data: passenger } = await admin
    .from('profiles')
    .select('stripe_customer_id, stripe_payment_method_id')
    .eq('id', r.passenger_id)
    .single();

  const p = passenger as { stripe_customer_id?: string; stripe_payment_method_id?: string } | null;

  if (!p?.stripe_customer_id || !p?.stripe_payment_method_id) {
    await recordAudit(admin, {
      rideId: r.id,
      eventId: `unpaid_nocard_${r.id}`,
      amountCents: verdict.amountCents,
      driverId: r.driver_id ?? null,
      needsAttention: true,
      code: 'unpaid_sweep_no_payment_method',
      reason:
        `A corrida ${r.id} foi concluída sem cobrança e o passageiro ${r.passenger_id} não tem ` +
        'forma de pagamento utilizável (stripe_customer_id/stripe_payment_method_id). A varredura ' +
        'NÃO cobrou. É preciso pedir ao passageiro que cadastre um método e cobrar com ' +
        'supabase/scripts/charge_unpaid_ride.ts.',
      raw: { phase: 'payment_method' },
    });
    return { charged: false, needsAttention: true, reason: 'no_payment_method' };
  }

  // ── Cobrança ──────────────────────────────────────────────────────────────
  // Mesma chave do app (`charge_<rideId>`, sem intent anterior porque
  // `has_intent` já barrou quem tem): se o telefone cobrou nos ~24 h da janela
  // de idempotência, o Stripe devolve AQUELE intent em vez de criar outro.
  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: verdict.amountCents,
      currency: 'usd',
      customer: p.stripe_customer_id,
      payment_method: p.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      // `type: 'fare'` mantém a mesma marcação do charge-ride; `sweep` distingue
      // quem criou, para o relatório e para o `charge_unpaid_ride.ts` retroativo.
      metadata: { rideId: r.id, type: 'fare', origem: 'sweep' },
      description: 'Go XL — Executive XL',
    }, {
      idempotencyKey: chargeIdempotencyKey(r.id, null),
    });
  } catch (e: unknown) {
    const se = e as { raw?: { message?: string; code?: string }; message?: string };
    const detail = se?.raw?.message ?? se?.message ?? String(e);
    await recordAudit(admin, {
      rideId: r.id,
      eventId: `unpaid_declined_${r.id}`,
      amountCents: verdict.amountCents,
      driverId: r.driver_id ?? null,
      needsAttention: true,
      code: 'unpaid_sweep_charge_failed',
      reason:
        `A cobrança automática da corrida ${r.id} (${(verdict.amountCents / 100).toFixed(2)} USD) ` +
        `foi RECUSADA: ${detail}. A corrida segue com paid = false e o motorista ` +
        `${r.driver_id ?? '?'} segue sem repasse.`,
      raw: { phase: 'charge', stripe_code: se?.raw?.code ?? null, detail },
    });
    return { charged: false, needsAttention: true, reason: 'charge_failed', detail };
  }

  // ── O dinheiro entrou MESMO? ──────────────────────────────────────────────
  // A resposta do POST não decide: a chave de idempotência é um cache do lado do
  // Stripe e não sabe de estornos feitos por fora. Quem decide `paid = true` é a
  // releitura (GET, que nunca é servida pelo cache) — mesma disciplina do
  // charge-ride.
  const fresco = await stripe.paymentIntents.retrieve(intent.id, { expand: ['latest_charge'] });
  const cobrado = verifyChargeCollected(fresco as unknown as SettledIntentShape);

  if (!cobrado.collected) {
    await recordAudit(admin, {
      rideId: r.id,
      eventId: `unpaid_unverified_${r.id}`,
      amountCents: fresco.amount ?? verdict.amountCents,
      driverId: r.driver_id ?? null,
      needsAttention: true,
      code: `unpaid_sweep_rejected_${cobrado.code}`,
      reason:
        `Cobrança criada para a corrida ${r.id} e REPROVADA na conferência (${cobrado.code}): ` +
        `${cobrado.detail}. A corrida NÃO foi marcada como paga. Confira no painel do Stripe se ` +
        `algum valor foi de fato capturado em ${intent.id} antes de cobrar de novo.`,
      raw: { phase: 'verify', payment_intent_id: intent.id, code: cobrado.code, detail: cobrado.detail },
    });
    return { charged: false, needsAttention: true, reason: `rejected_${cobrado.code}`, payment_intent_id: intent.id };
  }

  // ── Grava ─────────────────────────────────────────────────────────────────
  // O UPDATE é CONDICIONAL em `paid = false`: se o telefone do motorista ganhou
  // a corrida entre a releitura e aqui, não sobrescrevemos o que ele gravou. E o
  // erro NÃO é descartado — foi exatamente descartá-lo que criou a gorjeta órfã
  // de 17/08 (ver `_shared/tipCharge.ts`).
  const { data: gravou, error: erroUpdate } = await admin
    .from('rides')
    .update({ paid: true, stripe_payment_intent_id: intent.id })
    .eq('id', r.id)
    .eq('paid', false)
    .select('id');

  if (erroUpdate || (gravou?.length ?? 0) === 0) {
    await recordAudit(admin, {
      rideId: r.id,
      eventId: `unpaid_orphan_${r.id}`,
      amountCents: verdict.amountCents,
      driverId: r.driver_id ?? null,
      needsAttention: true,
      code: 'unpaid_sweep_charged_not_recorded',
      reason:
        `COBRADO NO STRIPE (${intent.id}, ${(verdict.amountCents / 100).toFixed(2)} USD) e NÃO ` +
        `gravado na corrida ${r.id}: ${erroUpdate?.message ?? 'nenhuma linha atualizada (paid já não era false)'}. ` +
        'NÃO cobre de novo — confira a linha e grave o payment_intent_id à mão.',
      raw: { phase: 'record', payment_intent_id: intent.id, db_error: erroUpdate?.message ?? null },
    });
    return { charged: true, needsAttention: true, reason: 'charged_not_recorded', payment_intent_id: intent.id };
  }

  return { charged: true, needsAttention: false, reason: 'charged', payment_intent_id: intent.id };
}

/** Texto do relatório para cada motivo que pede olho humano. */
function motivoLegivel(reason: string, r: UnpaidRow): string {
  const valor = `${((r.price ?? 0)).toFixed(2)} USD`;
  switch (reason) {
    case 'has_intent':
      return (
        `A corrida ${r.id} (${valor}) está concluída com paid = false MAS já tem ` +
        `stripe_payment_intent_id = ${r.stripe_payment_intent_id}. A varredura NÃO cria uma segunda ` +
        'cobrança: pode ser estorno (decisão a respeitar), webhook que não gravou a flag (já está ' +
        'pago) ou intent de outra conta Stripe. Confira no painel qual dos três é.'
      );
    case 'no_driver':
      return (
        `A corrida ${r.id} (${valor}) consta concluída SEM motorista. Cobrar aqui só reteria ` +
        'dinheiro sem ninguém para receber o repasse. Estado malformado — investigar como ela ' +
        'chegou a "completed".'
      );
    case 'invalid_amount':
      return `A corrida ${r.id} está concluída e não cobrada, mas o preço (${valor}) é inválido ou está abaixo do mínimo do Stripe.`;
    case 'too_old':
      return (
        `A corrida ${r.id} (${valor}) passou do teto de ${MAX_AGE_MS / 86400000} dias sem cobrança. ` +
        'A varredura NÃO cobra sozinha depois desse prazo — uma cobrança que o passageiro não ' +
        'reconhece vira disputa. Decida à mão, com supabase/scripts/charge_unpaid_ride.ts.'
      );
    case 'too_recent':
      return `A corrida ${r.id} está concluída e não cobrada, e não tem completed_at legível para medir a idade.`;
    default:
      return `Corrida ${r.id} não cobrada — motivo ${reason}.`;
  }
}

interface AuditRow {
  eventId: string;
  rideId: string;
  driverId: string | null;
  amountCents: number;
  needsAttention: boolean;
  code: string;
  reason: string;
  raw: Record<string, unknown>;
}

/**
 * Escreve em `stripe_reconciliation`. NUNCA lança: uma falha ao registrar não
 * pode derrubar a varredura das corridas seguintes.
 *
 * `event_id` é a chave de deduplicação — N passadas sobre a mesma corrida com o
 * mesmo motivo viram UMA linha, em vez de encher a tabela a cada 30 min.
 */
async function recordAudit(admin: SupabaseClient, row: AuditRow): Promise<void> {
  try {
    // A tabela (migração 0039) NÃO tem coluna `ride_id`: a corrida vai em
    // `object_id` e repetida dentro de `raw`, exatamente como o sweep irmão
    // grava. `payout_id` fica de fora — aqui não há repasse envolvido.
    await admin.from('stripe_reconciliation').upsert({
      event_id:        row.eventId,
      event_type:      `charge.unpaid.${row.code}`,
      object_id:       row.rideId,
      amount_cents:    row.amountCents,
      currency:        'usd',
      driver_id:       row.driverId,
      reason:          row.reason,
      needs_attention: row.needsAttention,
      raw:             { ride_id: row.rideId, source: 'unpaid_completed_sweep', ...row.raw },
    }, { onConflict: 'event_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('[sweep-unpaid-completed] falha ao registrar auditoria', row.eventId, e);
  }
}

async function recordSummary(
  admin: SupabaseClient,
  s: { nowMs: number; candidates: number; processed: number; charged: number; attention: number; truncated: boolean },
): Promise<void> {
  // Sem candidata nenhuma não há nada a contar — e uma linha a cada 30 min
  // dizendo "zero" só afogaria a tabela onde as linhas que importam moram.
  if (s.candidates === 0) return;
  await recordAudit(admin, {
    eventId: `unpaid_sweep_run_${new Date(s.nowMs).toISOString().slice(0, 16)}`,
    // `object_id` é texto livre nesta tabela; a linha-resumo não é de nenhuma
    // corrida, então diz isso em vez de fingir um uuid.
    rideId: 'sweep-unpaid-completed',
    driverId: null,
    amountCents: 0,
    needsAttention: s.attention > 0,
    code: 'unpaid_sweep_run',
    reason:
      `Varredura de concluídas não cobradas: ${s.candidates} candidata(s), ${s.processed} processada(s), ` +
      `${s.charged} cobrada(s), ${s.attention} pedindo atenção${s.truncated ? ', lote TRUNCADO' : ''}.`,
    raw: { ...s },
  });
}
