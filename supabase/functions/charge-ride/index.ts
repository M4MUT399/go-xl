// Supabase Edge Function — cobra o cartão salvo do passageiro no momento em que
// o motorista aceita a corrida (off-session, sem interação do passageiro).
//
// Deploy:  npx supabase functions deploy charge-ride
// Chamada: POST com { rideId: string } + JWT do motorista no header Authorization

import Stripe from 'npm:stripe@17';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  chargeIdempotencyKey,
  classifyMissingIntent,
  createMissingIntentBreaker,
  isMissingIntentError,
  verifyChargeCollected,
  type SettledIntentShape,
} from '../_shared/chargeCycle.ts';
import { isConfigFlagEnabled } from '../_shared/adminConfigFlag.ts';
import {
  decideChargeAuthorization,
  isAcceptingDriverCase,
  decideDriverGate,
} from '../_shared/chargeAuth.ts';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2025-01-27.acacia',
});

// Disjuntor do `resource_missing` — POR ISOLATE, não por requisição.
//
// Dentro de UMA requisição o `retrieve` acontece uma vez só: um contador
// estritamente por chamada nunca passaria de 1 e nunca dispararia — seria
// enfeite. O risco real é serial: uma chave rotacionada (ou uma troca
// live × test) faz o Stripe responder `resource_missing` para TODO intent
// anterior, e cada corrida que passa por aqui vira uma cobrança nova em cima
// de um pagamento que já existe. O padrão só é visível ENTRE corridas, então o
// contador vive no isolate, que é onde essa sequência acontece.
//
// Ao disparar, a função passa a devolver 503 `prior_intent_unreadable` no lugar
// de cobrar — o caminho que já existia para "não deu para conferir". 503 é
// retentável e não move dinheiro; o custo de um falso positivo é um aceite que
// precisa ser repetido, e o custo de um falso negativo é cobrar o passageiro
// duas vezes. O estado se desfaz sozinho quando o isolate recicla.
const missingIntentBreaker = createMissingIntentBreaker(1);

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

  // Declarada FORA do try: o `catch` lá embaixo precisa poder devolver a reserva
  // da corrida (ver "RESERVA ATÔMICA" mais abaixo) — é lá que cai o cartão
  // RECUSADO, que é de longe a falha mais comum deste endpoint. Sem isto, toda
  // recusa de cartão deixaria a corrida travada no motorista que não pagou.
  let releaseClaim: ((detail: string) => Promise<void>) | null = null;

  try {
    const { rideId } = await req.json();
    if (!rideId) return json({ error: 'rideId obrigatório' }, 400);

    // ── Autenticação: exige JWT válido ───────────────────────────────────────
    // Deployada com verificação própria: a autorização (quem pode cobrar ESTA
    // corrida) acontece mais abaixo, depois de a corrida ser lida.
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Busca dados da corrida ───────────────────────────────────────────────
    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select('passenger_id, driver_id, price, paid, status, stripe_payment_intent_id')
      .eq('id', rideId)
      .single();

    if (rideErr || !ride) return json({ error: 'Corrida não encontrada' }, 404);

    const r = ride as {
      passenger_id: string;
      driver_id?: string | null;
      price?: number;
      paid?: boolean;
      status: string;
      stripe_payment_intent_id?: string | null;
    };

    // ── Autorização ──────────────────────────────────────────────────────────
    // A versão anterior perguntava "o chamador é UM motorista?", não "o chamador
    // é o motorista DESTA corrida?". Como qualquer pessoa se cadastra como
    // motorista, isso equivalia a: qualquer conta autenticada dispara uma
    // cobrança off-session no cartão salvo de qualquer passageiro.
    //
    // Chamadores legítimos, e só eles:
    //
    //   1. o PASSAGEIRO desta corrida — ativação de agendada pelo app dele
    //      (useRide.ts:844-866, `activate`); o cartão cobrado é o próprio;
    //   2. o MOTORISTA desta corrida — a rede de segurança da conclusão
    //      (useRide.ts:1909-1923), que roda como o motorista já designado;
    //   3. um motorista ACEITANDO uma corrida que ainda não tem dono. Este é o
    //      caso que impede exigir `user.id === r.driver_id` puro e simples:
    //      `acceptRide` cobra ANTES de a corrida virar dele, de propósito — se o
    //      cartão recusa, a corrida NÃO é tomada. Aqui a autorização é a
    //      ELEGIBILIDADE do chamador, derivada NESTE INSTANTE pelo servidor
    //      (conta Connect habilitada + `driver_can_go_online`), e a
    //      exclusividade vem da RESERVA ATÔMICA logo abaixo;
    //   4. ADMIN (`profiles.is_admin`) — mesma política do refund-ride, que já
    //      trata o admin como operador de exceção sobre qualquer corrida.
    //
    // ─────────────────────────────────────────────────────────────────────────
    // POR QUE ESTE BLOCO FOI REESCRITO (DE NOVO)
    // ─────────────────────────────────────────────────────────────────────────
    // A 1ª tentativa exigia oferta viva em `ride_offers` atrás de
    // `dispatch_engine_v2` — flag com default `false` que nenhuma migration liga,
    // então o `&&` curto-circuitava e a exigência NUNCA rodava.
    //
    // A 2ª exigia prova em `ride_push_offers`, gravada pelo `send-ride-push`
    // sobre a lista de ids QUE O CLIENTE MANDAVA ("todo mundo com
    // driver_locations.is_online = true"). Isso autorizava uma multidão (cada
    // motorista online ganhava direito de cobrança off-session no cartão daquele
    // passageiro por 2 h) e, ao mesmo tempo, RECUSAVA legítimos — inclusive o
    // caso banal de "ninguém online no instante do pedido": a corrida nascia sem
    // prova nenhuma e todo aceite posterior levava 403 para sempre.
    //
    // Agora a pergunta é outra e não depende de instantâneo nenhum: "este
    // chamador pode assumir esta corrida AGORA?" — ver _shared/chargeAuth.ts.
    // `ride_push_offers` continua sendo gravada, como AUDITORIA de para quem o
    // telefone tocou; ela não decide mais cobrança.
    const isPassenger  = user.id === r.passenger_id;
    const isRideDriver = !!r.driver_id && user.id === r.driver_id;

    if (!isPassenger && !isRideDriver) {
      const { data: caller } = await admin
        .from('profiles')
        .select('type, is_admin, stripe_charges_enabled, stripe_payouts_enabled')
        .eq('id', user.id)
        .single();
      const c = caller as {
        type?: string;
        is_admin?: boolean;
        stripe_charges_enabled?: boolean;
        stripe_payouts_enabled?: boolean;
      } | null;

      const baseFacts = {
        isPassenger,
        isRideDriver,
        isDriver: c?.type === 'driver',
        rideStatus: r.status ?? null,
        hasDriver: !!r.driver_id,
      };

      // Só vale ir ao banco levantar elegibilidade quando o caso é mesmo o de um
      // motorista aceitando uma corrida do leque.
      const eligibility = isAcceptingDriverCase(baseFacts)
        ? await driverAcceptEligibility(admin, rideId, user.id, {
            chargesEnabled: c?.stripe_charges_enabled === true,
            payoutsEnabled: c?.stripe_payouts_enabled === true,
          })
        : null;

      const decision = decideChargeAuthorization({
        ...baseFacts,
        isAdmin: c?.is_admin === true,
        driverEligible: eligibility ? eligibility.eligible : null,
      });

      if (!decision.allowed) {
        if (decision.code === 'driver_not_eligible') {
          await recordChargeAudit(admin, {
            rideId,
            // Não há PaymentIntent nesta fase (a cobrança nem começou). O campo
            // é usado só para compor o `event_id`, e `<corrida>_<chamador>` é a
            // chave de deduplicação certa aqui: N tentativas do mesmo motorista
            // na mesma corrida viram UMA linha, mas dois atacantes (ou duas
            // corridas) continuam sendo duas.
            paymentIntentId: `deny_${rideId}_${user.id}`,
            amountCents: Math.round((r.price ?? 0) * 100),
            code: 'charge_denied_driver_not_eligible',
            reason:
              `O motorista ${user.id} tentou cobrar a corrida aberta ${rideId} sem estar habilitado a ` +
              `assumir corrida no momento do aceite (${eligibility?.reason ?? 'não verificado'}). A ` +
              'cobrança foi RECUSADA. Isto NÃO é o erro de implantação da rodada anterior: a decisão ' +
              'não depende mais de o push ter saído, só de a conta Connect deste motorista estar ' +
              'habilitada (stripe_charges_enabled + stripe_payouts_enabled, que ele não escreve — ' +
              '0065:1290-1294) e de driver_can_go_online() não o reprovar. Em volume, suspeite de ' +
              'motoristas cadastrados sem onboarding tentando cobrar cartão alheio.',
            raw: {
              caller: user.id,
              ride_status: r.status ?? null,
              phase: 'authorization',
              eligibility: eligibility?.reason ?? null,
            },
          });
        }
        return json({
          error: 'Não autorizado a cobrar esta corrida.',
          code: decision.code,
        }, 403);
      }

      // ══════════════════════════════════════════════════════════════════════
      // RESERVA ATÔMICA — ANTES DE QUALQUER IDA AO STRIPE
      // ══════════════════════════════════════════════════════════════════════
      // Mesma forma do par claim/undoClaim que a varredura já usa
      // (_shared/refundFlow.ts:229-243), e pelo mesmo motivo: entre "li que a
      // corrida está aberta" e "cobrei" cabe uma ida e volta de rede, e nessa
      // janela N motoristas elegíveis podem estar cobrando O MESMO cartão pela
      // MESMA corrida. A leitura não fecha essa janela; um UPDATE condicional
      // fecha, porque só UM `where driver_id is null` casa linha.
      //
      // Ordem: a reserva vem ANTES do Stripe e é DESFEITA se a cobrança não se
      // concretizar. É isto que preserva a regra de sempre — "se o cartão
      // recusa, a corrida não é tomada" — sem deixar a cobrança acontecer para
      // quem não vai ficar com a corrida.
      //
      // `status` continua 'requesting': quem fecha a corrida é o UPDATE do
      // aceite no app (status → 'accepted'), que casa porque o filtro dele já
      // aceita `driver_id.eq.<ele mesmo>`. Para o passageiro, nada muda até lá.
      if (decision.requiresClaim) {
        const claim = await claimOpenRide(admin, rideId, user.id);
        if (!claim.claimed) {
          // Perdeu a disputa (ou a corrida saiu do leque). NÃO é erro de
          // pagamento e não pode virar um: o app do motorista distingue este
          // código e trata como "outro pegou primeiro".
          return json({
            error: 'Esta corrida já foi assumida por outro motorista.',
            code: 'ride_taken',
            detail: claim.detail ?? null,
          }, 409);
        }
        releaseClaim = async (detail: string) => {
          await releaseOpenRideClaim(admin, rideId, user.id, detail);
        };
      }
    }

    // Idempotência: já foi cobrada
    if (r.paid) return json({ success: true, already_paid: true });

    // ── A corrida já tem um PaymentIntent, mas está `paid = false` ───────────
    // Antes de criar cobrança NOVA, pergunta ao Stripe o que aconteceu com a
    // antiga. Dois desfechos possíveis, e um deles é dinheiro:
    //
    //   • o intent anterior está COBRADO e íntegro → o dinheiro entrou e o que
    //     faltou foi a gravação no banco. Criar outro intent aqui cobraria o
    //     passageiro DUAS VEZES. Fecha o ciclo marcando `paid = true` sobre o
    //     intent que já existe;
    //   • o intent anterior foi estornado / recusado / não capturado → é um
    //     ciclo encerrado, e a cobrança nova é legítima. Segue adiante.
    //
    // Isto é o que sustenta, na prática, a promessa de "a retentativa é segura":
    // a chave de idempotência SOZINHA não sustenta, porque o Stripe a descarta
    // depois de ~24 h (ver _shared/chargeCycle.ts). Passado esse prazo, a mesma
    // chave é uma chave nova e cobraria de novo — é esta releitura, e não a
    // chave, que impede a cobrança em dobro na retentativa tardia.
    //
    // Limite conhecido: se a cobrança saiu e a gravação falhou no PRIMEIRO ciclo
    // (quando a corrida ainda não tinha `stripe_payment_intent_id`), não há id
    // para reler aqui — o `update` que grava `paid` e o id é o mesmo, então o id
    // não chegou ao banco. O que cobre esse caso é a linha de conciliação
    // gravada no fim desta função, que deixa o intent registrado para um humano.
    if (r.stripe_payment_intent_id) {
      try {
        const prior = await stripe.paymentIntents.retrieve(r.stripe_payment_intent_id, {
          expand: ['latest_charge'],
        });
        const priorVerdict = verifyChargeCollected(prior as unknown as SettledIntentShape);
        if (priorVerdict.collected) {
          const { error: fixErr } = await admin.from('rides').update({
            paid: true,
            stripe_payment_intent_id: prior.id,
          }).eq('id', rideId);
          if (fixErr) {
            await recordChargeAudit(admin, {
              rideId,
              paymentIntentId: prior.id,
              amountCents: prior.amount ?? 0,
              code: 'paid_flag_write_failed',
              reason:
                `A corrida estava paid = false com o PaymentIntent ${prior.id} JÁ COBRADO no Stripe. ` +
                `A tentativa de regravar paid = true falhou: ${fixErr.message}. Enquanto isso não for ` +
                'corrigido, o passageiro está cobrado, o motorista não recebe (o repasse exige ' +
                'paid = true) e uma nova chamada pode cobrar de novo. Corrija a mão.',
              raw: { db_error: fixErr.message, db_code: fixErr.code ?? null, phase: 'prior_intent_recovery' },
            });
            // Nada foi cobrado NESTA chamada (o dinheiro é do ciclo anterior) e o
            // id daquele intent está gravado na linha — então devolver a corrida
            // ao leque é seguro e é o desfecho útil: o próximo aceite relê o
            // mesmo intent, encontra-o cobrado e fecha o ciclo com `already_paid`.
            await releaseClaim?.(`falha ao regravar paid = true sobre ${prior.id}: ${fixErr.message}`);
            return json({
              error: `Cobrança anterior já existe no Stripe, mas não foi possível marcá-la no banco: ${fixErr.message}`,
              code: 'db_write_failed',
              payment_intent: prior.id,
            }, 500);
          }
          return json({ success: true, already_paid: true, recovered_payment_intent: prior.id });
        }
      } catch (e) {
        const se = e as { raw?: { message?: string }; message?: string };
        const msg = se?.raw?.message ?? se?.message ?? String(e);

        // ─────────────────────────────────────────────────────────────────────
        // 404 / resource_missing NÃO é "não deu para conferir": é a RESPOSTA.
        // ─────────────────────────────────────────────────────────────────────
        // A versão anterior devolvia 503 `prior_intent_unreadable` para
        // QUALQUER throw. Para um erro de rede isso é certo. Para um erro
        // PERMANENTE — id de outro ambiente (um `pi_` de teste numa base de
        // produção, ou o contrário), intent apagado, backfill errado — o 503 é
        // uma promessa falsa: toda retentativa falha idêntica, a corrida NUNCA
        // é cobrada e NUNCA é concluída. O passageiro fica preso numa viagem que
        // não fecha, e nada no servidor explica por quê.
        //
        // Quando o Stripe afirma que o id não existe, não há cobrança anterior
        // para proteger — logo não há risco de cobrança em dobro, que é a única
        // razão de o 503 existir aqui. Registra o achado (o id ruim não pode
        // sumir: alguém precisa saber que aquela coluna estava suja) e SEGUE
        // para uma cobrança nova, que é o desfecho correto.
        //
        // A cobrança nova nasce com chave de idempotência distinta da anterior:
        // `chargeIdempotencyKey(rideId, r.stripe_payment_intent_id)` carrega o id
        // antigo no sufixo, então mesmo um id inexistente separa os ciclos.
        // ─────────────────────────────────────────────────────────────────────
        // …MAS `resource_missing` não é prova de que o intent nunca existiu.
        // ─────────────────────────────────────────────────────────────────────
        // O Stripe devolve exatamente esse código para um objeto que existe e
        // é INVISÍVEL para a chave em uso: chave rotacionada para outra conta,
        // troca de live × test, chave restrita com escopo menor. Nesses casos a
        // cobrança anterior está lá, cobrada, e seguir para uma cobrança nova
        // cobra o passageiro duas vezes — em série, uma corrida após a outra.
        //
        // Só seguimos adiante quando dá para PROVAR, sem chamar o Stripe, que
        // aquele id não poderia ser desta conta: id fora do formato de
        // PaymentIntent, ou marcação de ambiente contrária à da chave. Fora
        // disso o sinal é ambíguo, e ambíguo não move dinheiro: cai no 503
        // `prior_intent_unreadable`, que já existia logo abaixo.
        const missingVerdict = isMissingIntentError(e)
          ? classifyMissingIntent(r.stripe_payment_intent_id, STRIPE_SECRET_KEY)
          : null;
        const breakerTripped = missingVerdict ? missingIntentBreaker.record() : false;
        const missingIsProvable =
          !!missingVerdict && missingVerdict.provablyForeign && !breakerTripped;

        if (missingVerdict && !missingIsProvable) {
          await recordChargeAudit(admin, {
            rideId,
            paymentIntentId: r.stripe_payment_intent_id,
            amountCents: Math.round((r.price ?? 0) * 100),
            code: 'prior_intent_missing_ambiguous',
            reason:
              `O Stripe respondeu que o PaymentIntent ${r.stripe_payment_intent_id} não existe ` +
              `(${msg}), mas isso NÃO prova que ele nunca foi desta conta — o mesmo código sai ` +
              'quando o objeto existe e a chave em uso não enxerga (rotação de chave, troca de ' +
              'live × test, chave restrita). Cobrar de novo aqui cobraria o passageiro duas vezes, ' +
              'então a cobrança foi RECUSADA com 503. ' +
              (breakerTripped
                ? `Disjuntor ABERTO: ${missingIntentBreaker.count()} intents anteriores sumiram ` +
                  'nesta mesma instância — o padrão é de chave errada, não de id sujo. ' +
                  'Confira STRIPE_SECRET_KEY antes de qualquer outra coisa.'
                : `Veredito: ${missingVerdict.reason}. O id tem forma de PaymentIntent desta conta, ` +
                  'então não dá para descartá-lo localmente.'),
            raw: {
              stripe_error: msg,
              phase: 'prior_intent_recovery',
              verdict: missingVerdict.reason,
              breaker_tripped: breakerTripped,
              breaker_count: missingIntentBreaker.count(),
              outcome: 'refused_503',
            },
          });
          // 503 é retentável e NENHUM centavo se moveu aqui: a corrida volta ao
          // leque para que a retentativa (deste motorista ou de outro) seja
          // possível. Segurar a reserva só faria a corrida morrer junto com o
          // isolate que abriu o disjuntor.
          await releaseClaim?.(`prior intent ${r.stripe_payment_intent_id} ilegível/ambíguo`);
          return json({
            error:
              'Não foi possível confirmar se esta corrida já foi cobrada. A cobrança não foi ' +
              'refeita para não correr o risco de cobrar duas vezes. Tente novamente.',
            code: 'prior_intent_unreadable',
            payment_intent: r.stripe_payment_intent_id,
          }, 503);
        }

        if (missingIsProvable) {
          await recordChargeAudit(admin, {
            rideId,
            paymentIntentId: r.stripe_payment_intent_id,
            amountCents: Math.round((r.price ?? 0) * 100),
            code: 'prior_intent_missing',
            reason:
              `A corrida apontava para o PaymentIntent ${r.stripe_payment_intent_id}, mas o Stripe ` +
              `respondeu que ele NÃO EXISTE nesta conta (${msg}) — E o id se desqualifica sozinho, ` +
              `sem consultar o Stripe: ${missingVerdict!.reason}. ` +
              (missingVerdict!.reason === 'livemode_mismatch'
                ? 'O id declara um ambiente e a STRIPE_SECRET_KEY em uso é do outro. '
                : 'O id não tem sequer a forma de um PaymentIntent. ') +
              'Não há cobrança anterior a proteger, então a corrida seguiu para uma cobrança NOVA. ' +
              'Confira de onde o id veio — se houver mais corridas com ids desse mesmo lote, elas ' +
              'vão cair aqui também.',
            raw: {
              stripe_error: msg,
              phase: 'prior_intent_recovery',
              verdict: missingVerdict!.reason,
              breaker_count: missingIntentBreaker.count(),
              outcome: 'proceeded_to_new_charge',
            },
          });
          // Sai do try/catch e cai na cobrança nova, logo abaixo.
        } else {
          // Releitura falhou por motivo TRANSITÓRIO (rede/Stripe fora). NÃO
          // seguimos para uma cobrança nova às cegas: se o intent anterior
          // estiver bom, cobraríamos duas vezes. O chamador tenta de novo.
          await releaseClaim?.(`releitura do intent anterior falhou (transitório): ${msg}`);
          return json({
            error: `Não foi possível conferir a cobrança anterior desta corrida: ${msg}`,
            code: 'prior_intent_unreadable',
            payment_intent: r.stripe_payment_intent_id,
          }, 503);
        }
      }
    }

    // ── Busca dados de pagamento do passageiro ───────────────────────────────
    const { data: passenger, error: passengerErr } = await admin
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id, full_name')
      .eq('id', r.passenger_id)
      .single();

    const p = passenger as {
      stripe_customer_id?: string;
      stripe_payment_method_id?: string;
      full_name?: string;
    } | null;

    if (passengerErr || !p?.stripe_customer_id || !p?.stripe_payment_method_id) {
      // Problema do PASSAGEIRO, não deste motorista: a corrida não pode ficar
      // reservada a ele (nem a ninguém — nenhum aceite vai conseguir cobrá-la
      // enquanto não houver cartão).
      await releaseClaim?.('passageiro sem cartão salvo');
      return json({ error: 'Passageiro sem cartão salvo. Solicite que ele adicione um cartão no app.' }, 400);
    }

    const amount = Math.round((r.price ?? 0) * 100);
    if (amount < 50) {
      await releaseClaim?.(`valor inválido (${amount} centavos)`);
      return json({ error: 'Valor da corrida inválido' }, 400);
    }

    // ── Cobra off-session ────────────────────────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: p.stripe_customer_id,
      payment_method: p.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      // `type` explícito: o webhook distingue tarifa de gorjeta por este campo.
      metadata: { rideId, type: 'fare' },
      description: 'Go XL — Executive XL',
    }, {
      // Idempotência no lado do Stripe: duas chamadas rápidas para a mesma
      // corrida não geram duas cobranças (protege contra corrida antes do
      // flag `paid` gravar no banco).
      //
      // A chave é POR CICLO, não por corrida — ver _shared/chargeCycle.ts. A
      // versão anterior (`charge_<rideId>`, eterna) fazia toda cobrança
      // POSTERIOR A UM ESTORNO devolver o PaymentIntent original, já estornado,
      // com status 'succeeded': a corrida voltava a `paid = true` e a ser
      // elegível a repasse sem que um centavo tivesse entrado.
      idempotencyKey: chargeIdempotencyKey(rideId, r.stripe_payment_intent_id),
    });

    // ── O dinheiro entrou MESMO? ─────────────────────────────────────────────
    // A chave de idempotência não é garantia suficiente: ela é um cache do lado
    // do Stripe (descartado depois de ~24 h) e não sabe de estornos feitos por
    // fora (painel, disputa, script). Antes de gravar `paid = true` relemos o
    // intent com um GET — que nunca é servido pelo cache de idempotência, só
    // POST com chave é — e exigimos cobrança capturada, não estornada e integral.
    //
    // Se a releitura falhar (rede/Stripe fora), NÃO gravamos `paid`: a cobrança
    // pode ter saído, então o certo é o chamador registrar a falha e tentar de
    // novo.
    //
    // ATENÇÃO ao que a retentativa garante e ao que NÃO garante. A versão
    // anterior deste comentário afirmava que "a mesma chave de idempotência
    // devolve exatamente este mesmo intent", o que contradiz o que
    // _shared/chargeCycle.ts:84-85 diz corretamente: o Stripe descarta a chave
    // depois de ~24 h. Dentro dessas 24 h a afirmação vale; passado o prazo, a
    // mesma chave é uma chave NOVA e criaria uma segunda cobrança. Quem cobre a
    // retentativa tardia não é a chave, é a releitura do PaymentIntent anterior
    // feita lá em cima (`r.stripe_payment_intent_id`), que devolve
    // `already_paid` em vez de cobrar de novo.
    const fresh = await stripe.paymentIntents.retrieve(paymentIntent.id, {
      expand: ['latest_charge'],
    });
    const verdict = verifyChargeCollected(fresh as unknown as SettledIntentShape);

    if (!verdict.collected) {
      // A cobrança foi CRIADA e não passou na conferência. Na maioria dos casos
      // nenhum dinheiro entrou (recusa, não capturada) — mas 'refunded' e
      // 'short_paid' descrevem uma cobrança que EXISTE no Stripe e que este
      // 400 não desfaz. Sem registro, a única pista seria o `reportError` do
      // lado do cliente, dentro de um `void (async …)` fire-and-forget
      // (useRide.ts:1916-1918). Fica escrito no mesmo livro do refund-ride.
      await recordChargeAudit(admin, {
        rideId,
        paymentIntentId: paymentIntent.id,
        amountCents: fresh.amount ?? amount,
        code: `charge_rejected_${verdict.code}`,
        reason:
          `Cobrança criada mas REPROVADA na conferência (${verdict.code}): ${verdict.detail}. ` +
          'A corrida NÃO foi marcada como paga. Confira no painel do Stripe se algum valor foi ' +
          'de fato capturado neste PaymentIntent antes de cobrar de novo.',
        raw: { verdict_code: verdict.code, verdict_detail: verdict.detail, phase: 'verify' },
      });

      // A corrida NÃO foi marcada como paga, então ela precisa voltar ao leque —
      // é a regra de sempre ("cartão não passou, corrida não é tomada"). Nos
      // casos 'refunded'/'short_paid' existe cobrança no Stripe que este 400 não
      // desfaz, e a linha de conciliação acima é o registro disso; ainda assim a
      // reserva é devolvida, porque manter a corrida presa a um motorista que
      // não pagou não conserta o dinheiro e mata a corrida.
      await releaseClaim?.(`cobrança reprovada na conferência (${verdict.code})`);
      return json({
        error: verdict.code === 'refunded'
          ? 'Esta corrida tem uma cobrança ESTORNADA no Stripe. Ela não pode ser marcada como paga sem uma cobrança nova.'
          : `Pagamento não confirmado: ${verdict.detail}`,
        code: verdict.code,
        payment_intent: paymentIntent.id,
      }, 400);
    }

    const { error: updErr } = await admin.from('rides').update({
      paid: true,
      stripe_payment_intent_id: paymentIntent.id,
    }).eq('id', rideId);

    // A gravação falhar aqui é o pior caso silencioso possível: o dinheiro JÁ
    // saiu do cartão e a corrida continua `paid = false`. O erro sobe para o
    // chamador — mas o chamador é um `void (async …)` fire-and-forget na
    // conclusão da corrida (useRide.ts:1916-1918), então "sobe para o chamador"
    // significava, na prática, um `reportError` no aparelho do motorista e mais
    // nada do lado do servidor. Um passageiro cobrado por uma corrida que o
    // sistema acha não-paga não pode existir sem uma linha escrita: registra em
    // `stripe_reconciliation`, a mesma disciplina do refund-ride.
    //
    // Um 23505 aqui é o índice único da 0066: este PaymentIntent já está
    // amarrado a OUTRA corrida.
    if (updErr) {
      await recordChargeAudit(admin, {
        rideId,
        paymentIntentId: paymentIntent.id,
        amountCents: amount,
        code: updErr.code === '23505' ? 'payment_intent_already_used' : 'paid_flag_write_failed',
        reason:
          `Cobrança ${paymentIntent.id} CONFIRMADA no Stripe (dinheiro entrou), mas gravar ` +
          `paid = true FALHOU: ${updErr.message}. O passageiro está cobrado e a corrida consta ` +
          'como não paga: o motorista não entra na fila de repasse (que exige paid = true) e uma ' +
          'nova tentativa de cobrança pode ser disparada. Corrija a mão. ' +
          'A RESERVA DA CORRIDA NÃO FOI DESFEITA de propósito: este é o único ramo em que se sabe ' +
          'que o dinheiro entrou E que o id do PaymentIntent não chegou ao banco — devolver a ' +
          'corrida ao leque deixaria um segundo motorista cobrar o passageiro OUTRA VEZ assim que a ' +
          'chave de idempotência do ciclo expirasse (~24 h). Enquanto a linha não for corrigida, a ' +
          'corrida fica reservada e o passageiro segue vendo "procurando motorista".',
        raw: {
          db_error: updErr.message,
          db_code: updErr.code ?? null,
          phase: 'mark_paid',
          claim_released: false,
        },
      });

      return json({
        error: `Cobrança feita, mas não foi possível marcá-la no banco: ${updErr.message}`,
        code: updErr.code === '23505' ? 'payment_intent_already_used' : 'db_write_failed',
        payment_intent: paymentIntent.id,
      }, 500);
    }

    return json({ success: true });
  } catch (e: unknown) {
    // Stripe lança StripeCardError para cartões recusados — mensagem legível
    const stripeErr = e as { raw?: { message?: string }; message?: string };
    const msg = stripeErr?.raw?.message ?? stripeErr?.message ?? String(e);

    // CARTÃO RECUSADO CAI AQUI. É o caminho mais percorrido deste `catch`, e é
    // exatamente o caso em que a regra do produto manda devolver a corrida ao
    // leque: "se o cartão recusa, a corrida não é tomada".
    //
    // O ramo ambíguo (a criação do intent lançou por rede DEPOIS de o Stripe ter
    // recebido a chamada) também devolve a reserva, e isso é seguro dentro da
    // janela que importa: a chave de idempotência do ciclo é determinística por
    // corrida (`chargeIdempotencyKey(rideId, prior)`), então um segundo aceite
    // nos minutos seguintes recebe o MESMO PaymentIntent do Stripe em vez de
    // criar outro. O que NÃO é coberto por isso é a retentativa depois de ~24 h
    // — e essa é a mesma limitação já declarada mais acima, não uma nova.
    await releaseClaim?.(`cobrança lançou: ${msg}`);

    return json({ error: msg }, 500);
  }
});

/**
 * Folga depois de `ride_offers.expires_at` em que a oferta ainda vale como
 * autorização de cobrança.
 *
 * O TTL de uma oferta é curto (`dispatch_offer_ttl_seconds`, 15 s por padrão —
 * dispatch-engine/index.ts:78) e quem a expira é o `tick`, que não roda no mesmo
 * instante do vencimento. Sem folga, um motorista que toca ACEITAR no último
 * segundo teria a cobrança recusada por relógio, não por direito — e o efeito
 * seria uma corrida devolvida ao leque com `payment_error`.
 *
 * 2 minutos é ordens de grandeza acima do desvio real e ainda assim NÃO
 * reabre o buraco: continua sendo preciso que o servidor tenha OFERECIDO aquela
 * corrida àquele motorista, e a oferta segue de pé só enquanto ela não foi
 * revogada/recusada (o filtro de status abaixo).
 */
const OFFER_GRACE_MS = 2 * 60 * 1000;

/**
 * ESTE motorista pode assumir UMA corrida aberta AGORA?
 *
 * É a autorização do caso 3 (motorista aceitando corrida sem dono), e ela é
 * derivada AQUI, no servidor, no instante do aceite — não lida de um
 * instantâneo gravado quando o pedido saiu. O porquê está no cabeçalho de
 * `_shared/chargeAuth.ts`; o resumo é que a versão anterior autorizava a
 * multidão de motoristas online no instante do pedido e recusava, para sempre,
 * quem entrasse depois.
 *
 * Três perguntas, e todas precisam passar:
 *
 *   1. a conta Stripe Connect está habilitada (charges E payouts). Esta é a
 *      barreira REAL: é a mesma que a 0038/0059 impõem no trigger de
 *      `driver_locations` para o motorista sequer ficar online, e o motorista
 *      NÃO consegue escrever essas colunas — a 0065:1290-1294 reverte qualquer
 *      escrita delas vinda de cliente. Passar por aqui exige onboarding/KYC de
 *      verdade no Stripe;
 *   2. `driver_can_go_online(driver)` (0059/0060) não o reprova: verificação de
 *      identidade, background check, disclosure e suspensão de tolerância zero.
 *      A função é permissiva enquanto as flags de rollout estiverem desligadas
 *      (devolve true), então hoje ela não recusa ninguém — é o lugar certo para
 *      esses gates quando forem ligados;
 *   3. com `dispatch_engine_v2` LIGADA, é preciso ainda ter oferta viva em
 *      `ride_offers`: nesse modo quem escolhe o motorista é o motor, e aceitar
 *      fora da oferta é furar a fila dele. Com a flag desligada — que é o estado
 *      de hoje — a pergunta nem é feita, porque a tabela é comprovadamente
 *      vazia (0054:5) e perguntar seria recusar todo mundo.
 *
 * `driver_locations.is_online` NÃO entra: é espelho mantido pelo cliente, o
 * próprio motorista escreve nele (RLS `auth.uid() = driver_id`) e ele some
 * quando o app é morto. Não barra atacante e recusa legítimo.
 *
 * ERRO DA RPC NÃO RECUSA — COM UMA EXCEÇÃO. Se `driver_can_go_online` falhar
 * (banco fora por um instante, função ausente numa base não migrada), a decisão
 * segue com o gate do Stripe e o erro vai para o log. Falhar fechado no geral
 * transformaria um soluço do banco em corrida morta — que é precisamente o
 * defeito que esta rodada está consertando.
 *
 * A exceção é SUSPENSÃO DE TOLERÂNCIA ZERO (intoxicação, agressão, arma —
 * is_zero_tolerance_category, 0060:179). Os outros gates dessa RPC são
 * reversíveis e de baixo dano se vazarem por uma corrida: um motorista sem
 * disclosure assinado dirigindo uma vez é um problema de papelada. Um motorista
 * suspenso por agressão pegando um passageiro não é. Então, quando a RPC erra,
 * ainda perguntamos ESSA pergunta direto na tabela — é o mesmo `exists` que a
 * RPC faz (0060:322-327), sob a mesma flag, e ele só depende do banco responder
 * um SELECT trivial. Se NEM ISSO responder, aí sim o banco está fora e a
 * decisão volta a ser a do Stripe: um `catch`-tudo aqui recriaria o fail-closed
 * que não queremos.
 */
async function driverAcceptEligibility(
  admin: SupabaseClient,
  rideId: string,
  driverId: string,
  connect: { chargesEnabled: boolean; payoutsEnabled: boolean },
): Promise<{ eligible: boolean; reason: string }> {
  if (!connect.chargesEnabled || !connect.payoutsEnabled) {
    return {
      eligible: false,
      reason: `conta Connect não habilitada (charges=${connect.chargesEnabled}, payouts=${connect.payoutsEnabled})`,
    };
  }

  const { data: canGoOnline, error: gateErr } = await admin.rpc('driver_can_go_online', {
    p_driver_id: driverId,
  });

  let suspensionGateEnabled: boolean | null = null;
  let hasLiveSuspension: boolean | null = null;

  if (gateErr) {
    // Caminho degradado: só a pergunta de tolerância zero, direto na tabela.
    // A jurisdição vem do perfil porque a flag é resolvida por jurisdição com
    // fallback em 'global' (resolve_config_bool, 0059).
    const { data: prof } = await admin
      .from('profiles').select('jurisdiction').eq('id', driverId).maybeSingle();
    const jurisdiction = (prof as { jurisdiction?: string } | null)?.jurisdiction ?? 'global';

    suspensionGateEnabled = await isConfigFlagEnabled(
      admin, 'safety_suspension_gate_v1_enabled', jurisdiction,
    ).catch(() => null);

    if (suspensionGateEnabled === true) {
      const { data: susp, error: suspErr } = await admin
        .from('driver_suspensions')
        .select('id')
        .eq('driver_id', driverId)
        .is('lifted_at', null)
        .limit(1);
      // `maybeSingle` devolveria `null` tanto para "sem suspensão" quanto para
      // erro de transporte (o mesmo tropeço já documentado em outros pontos do
      // repo), e aqui a diferença entre os dois é justamente o que decide.
      hasLiveSuspension = suspErr ? null : (susp ?? []).length > 0;
    }
  }

  const gate = decideDriverGate({
    rpcFailed: !!gateErr,
    canGoOnline: typeof canGoOnline === 'boolean' ? canGoOnline : null,
    suspensionGateEnabled,
    hasLiveSuspension,
  });

  if (gate.degraded) {
    console.error('driver_can_go_online falhou — elegibilidade em modo degradado', {
      driverId, rideId, error: gateErr?.message,
      suspensionGateEnabled, hasLiveSuspension, eligible: gate.eligible,
    });
  }

  if (!gate.eligible) {
    return {
      eligible: false,
      reason: gate.cause === 'suspension'
        ? 'suspensão de tolerância zero ativa (confirmada na tabela com a RPC fora)'
        : 'driver_can_go_online reprovou (verificação/background/disclosure/suspensão)',
    };
  }

  if (await isConfigFlagEnabled(admin, 'dispatch_engine_v2')) {
    const offered = await hasLiveOffer(admin, rideId, driverId);
    if (!offered) {
      return { eligible: false, reason: 'dispatch_engine_v2 ligado e sem oferta viva em ride_offers' };
    }
  }

  return { eligible: true, reason: 'conta Connect habilitada e sem impedimento' };
}

/**
 * RESERVA a corrida aberta para este motorista — o primeiro a escrever ganha.
 *
 * É um UPDATE CONDICIONAL, não uma leitura seguida de escrita: `driver_id is
 * null` e `status = 'requesting'` estão no MESMO statement que grava, então dois
 * motoristas simultâneos não podem os dois "ver aberto e cobrar". Quem perde
 * casa ZERO linhas e sai daqui sem ter tocado no Stripe.
 *
 * `status` NÃO muda: quem fecha a corrida é o UPDATE do aceite no app do
 * motorista, cujo filtro já aceita `driver_id.eq.<ele mesmo>` (useRide.ts). Para
 * o passageiro, a corrida continua 'requesting' até lá — nada de "motorista a
 * caminho" antes de o cartão passar.
 *
 * NÃO VERIFICADO AQUI: que o `update … where` do PostgREST é atômico. É garantia
 * do Postgres (um UPDATE toma lock de linha), não deste arquivo, e não há banco
 * neste repositório para exercitá-la. Mesma nota que a reserva da varredura já
 * carrega (_shared/refundFlow.ts).
 */
async function claimOpenRide(
  admin: SupabaseClient,
  rideId: string,
  driverId: string,
): Promise<{ claimed: boolean; detail?: string }> {
  const { data, error } = await admin
    .from('rides')
    .update({ driver_id: driverId })
    .eq('id', rideId)
    .eq('status', 'requesting')
    .is('driver_id', null)
    .select('id');

  if (error) return { claimed: false, detail: error.message };
  return { claimed: ((data as { id: string }[] | null) ?? []).length > 0 };
}

/**
 * Devolve a corrida ao leque. Só é chamada quando NENHUM dinheiro ficou preso a
 * esta reserva — a única exceção está documentada no ramo `mark_paid`.
 *
 * As guardas são a metade que importa: solta apenas se a corrida AINDA estiver
 * reservada a ESTE motorista e ainda não paga. Sem elas, uma compensação atrasada
 * apagaria o `driver_id` de uma corrida que, no meio-tempo, foi aceita de fato —
 * o espelho do defeito que a reserva existe para evitar.
 */
async function releaseOpenRideClaim(
  admin: SupabaseClient,
  rideId: string,
  driverId: string,
  detail: string,
): Promise<void> {
  try {
    const { error } = await admin
      .from('rides')
      .update({ driver_id: null })
      .eq('id', rideId)
      .eq('driver_id', driverId)
      .eq('status', 'requesting')
      // `paid` PODE SER NULL neste banco. A 0065 normaliza a coluna para NOT NULL
      // DEFAULT false, mas nenhuma migration de 0064 em diante rodou aqui — e
      // `.eq('paid', false)` NÃO casa com NULL em SQL. Seria uma devolução que
      // silenciosamente não devolve nada, deixando a corrida presa exatamente no
      // caso que esta função existe para desfazer. `not is true` cobre os dois.
      .not('paid', 'is', true);

    if (error) {
      // A corrida fica reservada a um motorista que não pagou: ninguém mais a
      // aceita e o passageiro segue esperando. Precisa de linha, não de log.
      await recordChargeAudit(admin, {
        rideId,
        paymentIntentId: `claim_${rideId}_${driverId}`,
        amountCents: 0,
        code: 'claim_release_failed',
        reason:
          `A cobrança da corrida ${rideId} não se concretizou (${detail}) e a devolução da reserva ao ` +
          `leque FALHOU: ${error.message}. A corrida continua com driver_id = ${driverId} e status ` +
          "'requesting' — nenhum outro motorista consegue aceitá-la e o passageiro fica em " +
          '"procurando motorista" até alguém limpar o driver_id à mão.',
        raw: { db_error: error.message, driver_id: driverId, phase: 'claim_release', detail },
      });
    }
  } catch (e) {
    console.error('Exceção ao devolver a reserva da corrida ao leque', { rideId, driverId, error: String(e) });
  }
}

/**
 * O motor ofereceu ESTA corrida a ESTE motorista, e a oferta ainda está viva?
 *
 * Duas leituras: `trip_requests` (a corrida virou pedido de despacho) e
 * `ride_offers` (o pedido foi oferecido a este motorista). Só
 * 'PENDING'/'ACCEPTED' passam: 'REVOKED', 'EXPIRED' e 'REJECTED' são justamente
 * os estados em que o motorista NÃO deve estar cobrando nada.
 *
 * `limit(1)` em vez de `maybeSingle()`: `maybeSingle` devolve ERRO quando vem
 * mais de uma linha, e um erro aqui vira negação de uma cobrança legítima. O
 * índice único de 0054 já garante uma linha por par, mas a autorização não
 * precisa depender disso.
 *
 * SEM pedido de despacho para a corrida, devolve `false` — com a flag ligada,
 * uma corrida do pool aberto SEMPRE tem `trip_request` (o cliente cria antes de
 * ofertar, useRide.ts:656-660), então a ausência dele significa que esta corrida
 * não está sendo despachada pelo motor e ninguém deveria estar cobrando-a como
 * "motorista aceitando". Limite conhecido, e deliberado: corridas `requesting`
 * criadas ANTES de a flag ser ligada não têm `trip_request` e passam a não poder
 * ser cobradas por um motorista que ainda não é o dono delas. Elas também não
 * recebem oferta nenhuma do motor (o leque legado é suprimido com a flag
 * ligada), então na prática já estavam mortas — mas isso precisa ser observado
 * no rollout.
 */
async function hasLiveOffer(
  admin: SupabaseClient,
  rideId: string,
  driverId: string,
): Promise<boolean> {
  const { data: reqs } = await admin
    .from('trip_requests')
    .select('id')
    .eq('ride_id', rideId)
    .limit(1);
  const tripRequestId = ((reqs as { id: string }[] | null) ?? [])[0]?.id;
  if (!tripRequestId) return false;

  const cutoff = new Date(Date.now() - OFFER_GRACE_MS).toISOString();
  const { data: offers } = await admin
    .from('ride_offers')
    .select('id')
    .eq('trip_request_id', tripRequestId)
    .eq('driver_id', driverId)
    .in('status', ['PENDING', 'ACCEPTED'])
    .gt('expires_at', cutoff)
    .limit(1);

  return ((offers as { id: string }[] | null) ?? []).length > 0;
}

/**
 * Linha de conciliação da COBRANÇA — mesma tabela, mesma idempotência por
 * `event_id` e mesma disciplina do `refund-ride`: quando o dinheiro se move e o
 * banco não acompanha, isso vira uma linha com `needs_attention = true` em vez
 * de sumir.
 *
 * Por que `charge-ride` precisava disto: o refund-ride sempre escreveu; aqui, o
 * único vestígio de uma cobrança feita e não registrada era um `reportError` do
 * lado do cliente, dentro de um `void (async …)` fire-and-forget no fim da
 * corrida (useRide.ts:1916-1918). Nada no servidor.
 *
 * `event_id` carrega o PaymentIntent e a fase: o mesmo acidente reentregue não
 * duplica a linha, mas duas fases diferentes do mesmo intent (reprovado na
 * conferência × falha ao gravar) continuam sendo dois registros distintos.
 *
 * Nunca lança: o dinheiro já se moveu, e falhar aqui só esconderia o resultado
 * do chamador.
 */
async function recordChargeAudit(
  admin: SupabaseClient,
  row: {
    rideId: string;
    paymentIntentId: string;
    amountCents: number;
    code: string;
    reason: string;
    raw: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await admin.from('stripe_reconciliation').upsert({
      event_id:        `charge_${row.paymentIntentId}_${row.code}`,
      event_type:      `charge.ride.${row.code}`,
      object_id:       row.rideId,
      amount_cents:    row.amountCents,
      currency:        'usd',
      reason:          row.reason,
      needs_attention: true,
      raw:             { ride_id: row.rideId, payment_intent: row.paymentIntentId, ...row.raw },
    }, { onConflict: 'event_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('Falha ao gravar stripe_reconciliation da cobrança', e);
  }
}
