// Supabase Edge Function — recebe eventos do Stripe e atualiza o banco.
//
// Eventos tratados:
//   checkout.session.completed (mode=setup) → grava payment_method_id + card_last4 + card_brand
//   payment_intent.succeeded                → marca rides.paid = true (backup do charge-ride)
//                                              SÓ para a tarifa; gorjeta é ignorada.
//                                              RELÊ o intent no Stripe antes de gravar — o evento
//                                              é um retrato do passado e é reentregue por ~3 dias,
//                                              inclusive depois de um estorno.
//   payment_intent.payment_failed           → marca rides.paid = false (cobrança recusada)
//                                              SÓ para a tarifa; gorjeta é ignorada
//   charge.refunded                          → marca rides.paid = false para tirar da fila de
//                                              repasse um estorno feito FORA do refund-ride
//                                              (painel, script, disputa)
//   refund.failed / charge.refund.updated    → o estorno que RESOLVEU 'pending' e FALHOU depois:
//                                              motorista já revertido, passageiro sem o dinheiro.
//                                              Registra needs_attention + alerta; não toca em paid.
//                                              ⚠️ QUAL DOS DOIS eventos a sua versão de API emite,
//                                              e se ele está habilitado no endpoint, PRECISA ser
//                                              conferido numa conta Stripe real — não dá daqui.
//   account.updated                          → espelha flags Connect + atribui faixa de
//                                              comissão na 1ª habilitação + tira o motorista
//                                              do ar se a conta for desabilitada pelo Stripe
//   transfer.created / payout.paid           → log de reconciliação financeira
//   charge.dispute.created                   → alerta de disputa (chargeback)
//
// Deploy:  npx supabase functions deploy stripe-webhook
// Segredo: npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
//   (obtido no Stripe Dashboard → Developers → Webhooks → seu endpoint)
//   Se não estiver configurado, a assinatura não é verificada (só usar em dev).

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  verifyChargeCollected,
  type ChargeVerdict,
  type SettledIntentShape,
} from '../_shared/chargeCycle.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const webhookSecret       = Deno.env.get('STRIPE_WEBHOOK_SECRET')     ?? '';
// Em produção o STRIPE_WEBHOOK_SECRET é OBRIGATÓRIO. Para DEV local sem secret,
// setar ALLOW_UNSIGNED_WEBHOOK=true para aceitar eventos não assinados.
const ALLOW_UNSIGNED       = (Deno.env.get('ALLOW_UNSIGNED_WEBHOOK') ?? '') === 'true';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Opcional: URL de webhook do Slack/Discord/etc. para alertas em tempo real.
// Se não configurado, os alertas ainda vão como push aos admins + registro em DB.
const ALERT_WEBHOOK_URL    = Deno.env.get('ALERT_WEBHOOK_URL')         ?? '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

/**
 * Grava um registro de reconciliação financeira. Idempotente por event_id — o
 * Stripe reentrega webhooks, e o upsert com ignoreDuplicates evita linhas
 * repetidas. Nunca deixa uma falha de gravação derrubar o webhook (o Stripe
 * reentregaria em loop); apenas loga.
 */
async function recordReconciliation(admin: Admin, row: Record<string, unknown>): Promise<void> {
  try {
    await admin
      .from('stripe_reconciliation')
      .upsert(row, { onConflict: 'event_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('Falha ao gravar stripe_reconciliation', e);
  }
}

/** Envia push (Expo) para todos os admins com push_token. Best-effort. */
async function pushToAdmins(
  admin: Admin,
  title: string,
  bodyText: string,
  data: Record<string, unknown>,
): Promise<void> {
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
    const messages = tokens.map((to) => ({
      to, title, body: bodyText, data, sound: 'default', priority: 'high',
    }));
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (e) {
    console.error('Falha ao enviar push aos admins', e);
  }
}

/** Alerta a equipe: webhook externo (se configurado) + push aos admins. */
async function alertTeam(admin: Admin, message: string, meta: Record<string, unknown>): Promise<void> {
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
  await pushToAdmins(admin, '🚨 Go XL — alerta', message, meta);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await req.text();
  const sig  = req.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    if (webhookSecret) {
      // No runtime do Supabase (Deno) a verificação de assinatura PRECISA ser
      // assíncrona — a versão síncrona (constructEvent) lança
      // "SubtleCryptoProvider cannot be used in a synchronous context" e faz
      // TODAS as entregas retornarem 400. Use sempre constructEventAsync aqui.
      event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
    } else if (ALLOW_UNSIGNED) {
      // DEV local apenas (opt-in explícito).
      event = JSON.parse(body) as Stripe.Event;
    } else {
      // Fail-closed: sem o secret não há como confiar no corpo — qualquer um
      // poderia forjar um evento e marcar corridas como pagas / anexar cartões.
      return new Response('Webhook secret não configurado', { status: 400 });
    }
  } catch (e) {
    return new Response(`Webhook error: ${e}`, { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── checkout.session.completed (modo setup) ──────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    if (session.mode === 'setup' && session.setup_intent) {
      const passengerId = session.metadata?.passenger_id;
      if (!passengerId) {
        return new Response(JSON.stringify({ warning: 'passenger_id ausente no metadata' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Recupera o SetupIntent para obter o payment_method
      const setupIntent = await stripe.setupIntents.retrieve(
        session.setup_intent as string,
      );
      const pmId = setupIntent.payment_method as string | null;
      if (!pmId) {
        return new Response(JSON.stringify({ warning: 'payment_method ausente no setup_intent' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Detalhes do cartão (last4, brand)
      const pm   = await stripe.paymentMethods.retrieve(pmId);
      const card = pm.card;

      // O TIPO e um rótulo legível, para o método deixar de ser invisível.
      //
      // Antes, o upsert lá embaixo gravava só `card_last4`/`card_brand`. Num
      // método que não é cartão — Link, por exemplo — `pm.card` é `undefined`,
      // os dois viravam NULL, e o `stripe_payment_method_id` era salvo assim
      // mesmo. Resultado: o perfil tinha forma de pagamento, a `charge-ride`
      // conseguia cobrar por ela, e a TELA não mostrava nada. A passageira da
      // corrida f28f2887 não sabia que tinha método salvo.
      //
      // `card_brand`/`card_last4` continuam sendo gravados como antes, de
      // propósito: uma build antiga do app em campo lê essas colunas e não
      // conhece as novas. Elas ficam nulas para não-cartão, como sempre
      // ficaram — o que muda é que agora existe onde dizer a verdade.
      const pmTipo = pm.type;
      const pmRotulo = pm.card
        ? `${pm.card.brand} •••• ${pm.card.last4}`
        : pm.type === 'link'
          // O e-mail é o que identifica uma conta Link para quem olha a tela.
          ? `Link${pm.link?.email ? ` · ${pm.link.email}` : ''}`
          : pm.type;

      // Define como método padrão do Customer
      await stripe.customers.update(session.customer as string, {
        invoice_settings: { default_payment_method: pmId },
      });

      // Busca dados do customer para popular o perfil se ele não existir
      const customer = await stripe.customers.retrieve(session.customer as string) as Stripe.Customer;

      // Busca o perfil atual para PRESERVAR os campos já preenchidos —
      // o upsert sobrescreveria phone/rating/total_rides/full_name com defaults.
      const { data: existing } = await admin
        .from('profiles')
        .select('*')
        .eq('id', passengerId)
        .single();
      const ex = existing as Record<string, unknown> | null;

      // UPSERT: se o perfil não existir no banco (ex: signup incompleto),
      // cria um mínimo válido com os dados do Stripe para não perder o cartão.
      // Se já existir, mantém os valores atuais (?? preserva).
      await admin.from('profiles').upsert({
        id:                       passengerId,
        email:                    (ex?.email as string)      ?? customer.email ?? '',
        full_name:                (ex?.full_name as string)  ?? customer.name  ?? '',
        phone:                    (ex?.phone as string)      ?? '',
        type:                     (ex?.type as string)       ?? 'passenger',
        rating:                   (ex?.rating as number)     ?? 5.0,
        total_rides:              (ex?.total_rides as number) ?? 0,
        language:                 (ex?.language as string)   ?? 'en',
        stripe_customer_id:       session.customer as string,
        stripe_payment_method_id: pmId,
        card_last4:               card?.last4  ?? null,
        card_brand:               card?.brand  ?? null,
        payment_method_type:      pmTipo,
        payment_method_label:     pmRotulo,
      }, { onConflict: 'id' });
    }
  }

  // ── payment_intent.succeeded (backup) ───────────────────────────────────
  // ATENÇÃO ao filtro por `type`: a GORJETA também carrega `rideId` no metadata
  // (veja tip-ride, que usa `{ rideId, type: 'tip' }`). Sem esse filtro, uma
  // gorjeta aprovada marcava a corrida inteira como PAGA, mesmo que a tarifa
  // nunca tivesse sido cobrada — foi exatamente o que aconteceu na corrida
  // 6acaf884 (tarifa de US$ 49,77 nunca cobrada, gorjeta de US$ 10,00 quitando
  // a corrida no banco). Pior: isso anulava a rede de segurança do app, que só
  // cobra na conclusão quando `paid` é falso.
  //
  // O teste é "não é gorjeta" em vez de "é tarifa" de propósito: PaymentIntents
  // antigos da tarifa foram criados sem `type` no metadata, e continuam válidos.
  //
  // ─────────────────────────────────────────────────────────────────────────
  // E ATENÇÃO MAIOR AINDA: este handler NÃO pode confiar no corpo do evento.
  // ─────────────────────────────────────────────────────────────────────────
  // O `payment_intent.succeeded` é um retrato do PASSADO — do instante em que a
  // cobrança sucedeu. Ele continua dizendo "succeeded" para sempre, inclusive
  // depois de a cobrança ter sido ESTORNADA. E o Stripe reentrega eventos por
  // cerca de 3 dias, além do botão "Resend" do painel.
  //
  // O caminho de falha, sem má-fé nenhuma: charge-ride cobra `pi_1` → o Stripe
  // emite `payment_intent.succeeded` → a entrega falha → um admin estorna a
  // corrida e ela vira `paid = false` → o Stripe reentrega o evento → este
  // handler gravava `paid = true` de novo → a corrida voltava para a fila de
  // repasse (`paid = true and payout_id is null`,
  // run-weekly-payouts/index.ts:271-274) → sai um transfer sacado via
  // `source_transaction` de uma cobrança inteiramente estornada. Não há, em
  // supabase/functions/, nenhum handler de `charge.refunded`/`refund.*` que
  // desfizesse isso — este é o handler que anulava, sozinho, a proteção que o
  // charge-ride ganhou.
  //
  // Duas travas, e as duas são necessárias:
  //   • RELEITURA. `paymentIntents.retrieve` é um GET e NUNCA é servido pelo
  //     cache de idempotência do Stripe, então ele devolve o estado VIVO. O
  //     veredito sai do mesmo `verifyChargeCollected` que o charge-ride usa
  //     (capturada, não estornada, integral) — inclusive estorno PARCIAL, que
  //     descola a cobrança do `driver_amount` que o repasse vai sacar dela.
  //   • `.eq('paid', false)`. Uma corrida deliberadamente estornada não volta a
  //     `paid = true` por um evento antigo. No caminho normal o charge-ride já
  //     gravou `paid = true` e este update simplesmente não casa linha nenhuma
  //     — que é o correto: aqui é rede de segurança, não fonte da verdade.
  if (event.type === 'payment_intent.succeeded') {
    const pi     = event.data.object as Stripe.PaymentIntent;
    const rideId = pi.metadata?.rideId;
    if (rideId && pi.metadata?.type !== 'tip') {
      let verdict: ChargeVerdict;
      try {
        const fresh = await stripe.paymentIntents.retrieve(pi.id, { expand: ['latest_charge'] });
        verdict = verifyChargeCollected(fresh as unknown as SettledIntentShape);
      } catch (e) {
        // ─────────────────────────────────────────────────────────────────────
        // A RELEITURA FALHOU. Isto NÃO pode virar 200.
        // ─────────────────────────────────────────────────────────────────────
        // A versão anterior só logava e seguia até o `return 200` do fim da
        // função — e 200 é, para o Stripe, "entregue": o evento NUNCA é
        // reentregue. Uma única falha transitória de `retrieve` (rede, 5xx do
        // Stripe, rate limit) apagava o evento para sempre.
        //
        // O caminho de falha completo, sem má-fé nenhuma: `charge-ride` cobra
        // `pi_1` e MORRE (timeout/crash) antes do próprio UPDATE — então não há
        // nem linha de conciliação do charge-ride. Este webhook é a última
        // defesa. Com o 200, o desfecho era: passageiro cobrado, corrida
        // `paid = false` para sempre, motorista nunca recebe (o repasse exige
        // `paid = true`) e ZERO registro do lado do servidor. É o mesmo buraco
        // que a linha de conciliação do charge-ride foi aberta para fechar,
        // reproduzido um ramo adiante.
        //
        // Duas coisas, e as duas são necessárias:
        //   • a linha `needs_attention` — o Stripe desiste depois de ~3 dias, e
        //     se ele desistir tem que sobrar registro para um humano;
        //   • o HTTP 500 — enquanto o Stripe não desistir, ele reentrega com
        //     backoff, e a próxima tentativa provavelmente relê o intent sem
        //     problema e fecha a corrida sozinha.
        //
        // REENTREGA É SEGURA AQUI. Os handlers deste arquivo são todos
        // `if (event.type === ...)` sobre o MESMO `event.type`, que tem um valor
        // só: um evento `payment_intent.succeeded` não executa nenhum outro
        // ramo, então não existe efeito colateral anterior nesta invocação para
        // ser refeito. E o que este ramo faz é idempotente por construção: o
        // `retrieve` é um GET, `verifyChargeCollected` é puro, o UPDATE é
        // guardado por `.eq('paid', false)` e o `upsert` de conciliação é
        // `onConflict: event_id, ignoreDuplicates` — com `event_id` derivado do
        // id do evento, que não muda entre reentregas.
        console.error('payment_intent.succeeded: releitura do intent falhou, paid NÃO gravado', {
          rideId, id: pi.id, error: String(e),
        });

        await recordReconciliation(admin, {
          event_id:        `${event.id}_verify_failed`,
          event_type:      'payment_intent.succeeded.verify_failed',
          object_id:       rideId,
          amount_cents:    pi.amount ?? 0,
          currency:        pi.currency ?? 'usd',
          reason:
            `O Stripe avisou que o PaymentIntent ${pi.id} da corrida ${rideId} foi cobrado, mas a ` +
            `RELEITURA para conferir falhou (${String(e)}), então paid NÃO foi gravado. ` +
            'Devolvemos HTTP 500 para o Stripe reentregar o evento com backoff. Se ele desistir ' +
            '(a reentrega dura ~3 dias) esta linha é o único registro: confira no painel se o ' +
            'dinheiro entrou e, se entrou, marque a corrida como paga à mão — enquanto ela ' +
            'estiver paid = false o passageiro está cobrado e o motorista não entra na fila de repasse.',
          needs_attention: true,
          raw: {
            payment_intent: pi.id,
            ride_id: rideId,
            error: String(e),
            phase: 'webhook_verify_retrieve',
          },
        });

        return new Response(
          JSON.stringify({
            error: 'não foi possível reler o PaymentIntent para conferir a cobrança',
            code: 'verify_failed',
            payment_intent: pi.id,
            ride_id: rideId,
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (verdict.collected) {
        await admin
          .from('rides')
          .update({ paid: true, stripe_payment_intent_id: pi.id })
          .eq('id', rideId)
          .eq('paid', false);
      } else {
        console.warn('⚠️ payment_intent.succeeded IGNORADO — o dinheiro não está mais lá', {
          rideId, id: pi.id, code: verdict.code, detail: verdict.detail,
        });
      }
    }
  }

  // ── charge.refunded — o complemento que faltava ──────────────────────────
  // Sem isto, um estorno feito FORA do refund-ride (painel do Stripe, script,
  // disputa aceita) deixa a corrida `paid = true` e portanto elegível a repasse,
  // lastreada por uma cobrança que já voltou ao passageiro.
  //
  // A trava que impede este handler de brigar com uma RECOBRANÇA legítima é o
  // `.eq('stripe_payment_intent_id', piId)`: a corrida só é desmarcada se ela
  // AINDA aponta para o intent que foi estornado. Depois de um novo ciclo de
  // cobrança (chave de idempotência por ciclo, _shared/chargeCycle.ts), a
  // corrida aponta para `pi_2`; um `charge.refunded` atrasado de `pi_1` não casa
  // linha nenhuma e vira no-op. Idempotente também quando o estorno veio do
  // próprio refund-ride, que já gravou `paid = false`.
  //
  // OPERACIONAL: este evento precisa estar habilitado no endpoint do webhook
  // (Stripe Dashboard → Developers → Webhooks → seu endpoint → eventos). Não foi
  // possível conferir a configuração daqui.
  if (event.type === 'charge.refunded') {
    const ch   = event.data.object as Stripe.Charge;
    const piId = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id ?? null;

    // ─────────────────────────────────────────────────────────────────────────
    // "É GORJETA?" SAI DO BANCO, NÃO DO METADATA DA CHARGE.
    // ─────────────────────────────────────────────────────────────────────────
    // A versão anterior perguntava `ch.metadata?.type === 'tip'`. `tip-ride/
    // index.ts:119` escreve `metadata: { rideId, type: 'tip' }` no PAYMENT
    // INTENT, e nada neste repositório escreve metadata na CHARGE. A
    // documentação do Stripe é explícita em que o metadata do PaymentIntent NÃO
    // é copiado para a Charge (não foi possível conferir isso contra uma conta
    // real daqui — é leitura de documentação, não observação), então o teste era
    // quase certamente sempre falso.
    //
    // Nenhum dinheiro se perdia por causa disso: a gorjeta tem coluna própria
    // (`tip_payment_intent_id`, 0064) e o UPDATE abaixo casa por
    // `stripe_payment_intent_id`, que é a coluna da TARIFA — um estorno de
    // gorjeta não encontrava corrida nenhuma para desmarcar. O estrago era de
    // ruído: um estorno PARCIAL de gorjeta caía na regra de
    // `needs_attention` mais abaixo e abria uma pendência falsa.
    //
    // A fonte da verdade é a coluna. `limit(1)` em vez de `maybeSingle()` de
    // propósito: enquanto a 0066 não tiver sido aplicada, `tip_payment_intent_id`
    // ainda pode repetir e o `maybeSingle()` devolveria ERRO em vez de linha.
    const { data: tipRows } = piId
      ? await admin.from('rides').select('id').eq('tip_payment_intent_id', piId).limit(1)
      : { data: null };
    const isTip = ((tipRows as { id: string }[] | null) ?? []).length > 0
      // Mantido como rede: se algum dia a charge passar a carregar o metadata
      // (ou um estorno manual for anotado assim), o teste continua valendo.
      || ch.metadata?.type === 'tip';

    if (piId && !isTip) {
      const { data: touched } = await admin
        .from('rides')
        .update({ paid: false })
        .eq('stripe_payment_intent_id', piId)
        .eq('paid', true)
        .select('id');

      const rideIds = ((touched as { id: string }[]) ?? []).map((x) => x.id);
      await recordReconciliation(admin, {
        event_id:        event.id,
        event_type:      'charge.refunded',
        object_id:       rideIds[0] ?? ch.id,
        amount_cents:    ch.amount_refunded ?? 0,
        currency:        ch.currency,
        reason:
          rideIds.length > 0
            ? `Cobrança ${piId} estornada (${ch.amount_refunded} centavos). A(s) corrida(s) ${rideIds.join(', ')} foram marcadas paid = false para sair da fila de repasse.`
            : `Cobrança ${piId} estornada (${ch.amount_refunded} centavos), mas nenhuma corrida paid = true apontava para este PaymentIntent — nada a fazer (estorno já processado, ou a corrida já está num ciclo de cobrança novo).`,
        // Estorno parcial deixa a corrida sem lastro integral para o repasse e
        // não é resolvido por `paid = false` sozinho: chama um humano.
        needs_attention: (ch.amount_refunded ?? 0) > 0 && (ch.amount_refunded ?? 0) < (ch.amount ?? 0),
        raw: {
          charge: ch.id,
          payment_intent: piId,
          amount: ch.amount,
          amount_refunded: ch.amount_refunded,
          fully_refunded: ch.refunded,
          rides_unmarked: rideIds,
        },
      });
    }
  }

  // ── O ESTORNO QUE FALHA DEPOIS ──────────────────────────────────────────
  // `refunds.create` pode resolver com `status: 'pending'` — o dinheiro está a
  // caminho do emissor do cartão, mas ainda não chegou. E um refund `pending`
  // pode FALHAR depois, de forma assíncrona (conta de destino fechada, emissor
  // recusa). Quando isso acontece, o desfecho é o pior possível e chega DEPOIS
  // da resposta HTTP do refund-ride, onde nenhuma trava daquele fluxo alcança:
  //
  //   • a reversão do transfer do motorista JÁ FOI EXECUTADA (refund-ride
  //     reverte ANTES de estornar, de propósito — _shared/refundFlow.ts);
  //   • a corrida já está `paid = false`;
  //   • e o passageiro NÃO recebeu o dinheiro de volta.
  //
  // Ou seja: o motorista foi debitado, o passageiro não foi ressarcido e os
  // livros dizem que fechou. `reversalOrphaned()` não tem como pegar isso: ele
  // roda dentro da invocação do refund-ride, e a falha acontece horas depois.
  // Este handler é o único ponto do sistema em que essa notícia chega.
  //
  // NÃO MEXEMOS EM `paid` AQUI, de propósito. Voltar a corrida para
  // `paid = true` a tornaria elegível a repasse de novo (`paid = true and
  // payout_id is null`) e o motorista, que acabou de ser revertido, receberia
  // outra vez. O que fazer — reestornar por outro meio, refazer o transfer,
  // cobrar do passageiro — é decisão humana. Aqui registramos e gritamos.
  //
  // ⚠️ NÃO VERIFICADO, E PRECISA SER CONFERIDO CONTRA UMA CONTA STRIPE REAL:
  // o NOME do evento que carrega essa transição depende da versão de API fixada
  // no endpoint. Os dois candidatos são `refund.failed` e
  // `charge.refund.updated` — este arquivo trata OS DOIS e não afirma qual é o
  // correto. Não há como conferir isto daqui (nenhuma chamada ao Stripe foi
  // feita). É PRECISO confirmar no painel: Developers → Webhooks → o endpoint →
  // "Events to send", e habilitar o que a sua versão de API emite. Se nenhum dos
  // dois estiver habilitado, este handler nunca roda e o buraco continua aberto.
  // A comparação é feita sobre `event.type` já alargado para `string` justamente
  // porque um dos dois nomes pode não existir na união de tipos do
  // `npm:stripe@17` — tolerar o evento inexistente é intencional.
  {
    const eventType: string = event.type;
    if (eventType === 'refund.failed' || eventType === 'charge.refund.updated') {
      const refund = event.data.object as Stripe.Refund;
      const status = refund.status ?? null;

      // `charge.refund.updated` dispara em qualquer mudança do refund, inclusive
      // 'pending' → 'succeeded', que é o caminho FELIZ e não é notícia. Só os
      // desfechos ruins passam daqui — sem isto, o alerta viraria ruído e o
      // ruído esconde o caso que importa.
      if (status === 'failed' || status === 'canceled') {
        const piId = typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : refund.payment_intent?.id ?? null;

        // Contexto para quem for resolver: qual corrida, qual motorista, e se a
        // parte dele já tinha sido repassada (portanto revertida).
        let rideId: string | null = null;
        let driverId: string | null = null;
        let payoutId: string | null = null;
        if (piId) {
          const { data: rows } = await admin
            .from('rides')
            .select('id, driver_id, payout_id')
            .eq('stripe_payment_intent_id', piId)
            .limit(1);
          const hit = ((rows as { id: string; driver_id: string | null; payout_id: string | null }[] | null) ?? [])[0];
          rideId   = hit?.id ?? null;
          driverId = hit?.driver_id ?? null;
          payoutId = hit?.payout_id ?? null;
        }

        await recordReconciliation(admin, {
          event_id:        event.id,
          event_type:      `refund.${status}`,
          object_id:       rideId ?? refund.id,
          amount_cents:    refund.amount ?? 0,
          currency:        refund.currency ?? 'usd',
          driver_id:       driverId,
          payout_id:       payoutId,
          reason:
            `O estorno ${refund.id} (${refund.amount} centavos) terminou com status ${status}` +
            `${refund.failure_reason ? ` (motivo: ${refund.failure_reason})` : ''}. ` +
            'O PASSAGEIRO NÃO RECEBEU O DINHEIRO DE VOLTA. Se a corrida já tinha sido repassada, a ' +
            'reversão do transfer do motorista JÁ FOI EXECUTADA antes deste estorno (refund-ride ' +
            'reverte primeiro), então ele foi debitado por um ressarcimento que não aconteceu. ' +
            'A corrida NÃO foi tocada aqui: voltar paid = true a tornaria elegível a repasse de novo. ' +
            'Decida à mão: reestornar por outro meio, refazer o transfer ao motorista, ou manter a cobrança.',
          needs_attention: true,
          raw: {
            refund_id: refund.id,
            refund_status: status,
            failure_reason: refund.failure_reason ?? null,
            payment_intent: piId,
            charge: refund.charge ?? null,
            ride_id: rideId,
            payout_id: payoutId,
            source_event_type: eventType,
          },
        });

        await alertTeam(
          admin,
          `Estorno ${refund.id}${rideId ? ` da corrida ${rideId}` : ''} FALHOU (${status}` +
          `${refund.failure_reason ? `: ${refund.failure_reason}` : ''}). O passageiro NÃO recebeu o dinheiro de volta` +
          `${payoutId ? ' e a reversão do repasse ao motorista já tinha sido executada' : ''}. Resolva manualmente.`,
          { type: 'refund_failed_async', refundId: refund.id, rideId, status },
        );
      }
    }
  }

  // ── payment_intent.payment_failed ───────────────────────────────────────
  // Cobrança do passageiro recusada. Marca a corrida como não-paga (o
  // charge-ride já falha de forma síncrona no aceite; isto é a rede de
  // segurança assíncrona) e registra para acompanhamento.
  if (event.type === 'payment_intent.payment_failed') {
    const pi     = event.data.object as Stripe.PaymentIntent;
    const rideId = pi.metadata?.rideId;
    // Mesmo cuidado do succeeded: gorjeta recusada não torna a corrida não-paga.
    if (rideId && pi.metadata?.type !== 'tip') {
      await admin.from('rides').update({ paid: false }).eq('id', rideId);
    }
    console.warn('⚠️ payment_intent.payment_failed', {
      rideId, id: pi.id, reason: pi.last_payment_error?.message ?? null,
    });
  }

  // ── account.updated (Connect Express) ───────────────────────────────────
  // Fonte da verdade do estado da conta conectada do motorista. Espelha os
  // flags no perfil, atribui a faixa de comissão na 1ª habilitação de cobranças
  // e, se o Stripe desabilitar a conta (documentos pendentes, verificação
  // reprovada, etc.), tira o motorista do ar imediatamente.
  if (event.type === 'account.updated') {
    const account          = event.data.object as Stripe.Account;
    const chargesEnabled   = !!account.charges_enabled;
    const payoutsEnabled   = !!account.payouts_enabled;
    const onboardingDone    = !!account.details_submitted;
    const disabledReason   = account.requirements?.disabled_reason ?? null;

    const { data: prof } = await admin
      .from('profiles')
      .select('id, driver_share_percent')
      .eq('stripe_account_id', account.id)
      .single();
    const p = prof as { id: string; driver_share_percent?: number | null } | null;
    const driverId = p?.id;

    if (driverId) {
      // ═══════════════════════════════════════════════════════════════════════
      // A FAIXA DE REPASSE VEM ANTES DE HABILITAR O MOTORISTA
      // ═══════════════════════════════════════════════════════════════════════
      // A versão anterior gravava `stripe_charges_enabled: true` e SÓ DEPOIS
      // chamava `assign_driver_tier`, DESCARTANDO o erro:
      //
      //     await admin.rpc('assign_driver_tier', { p_driver: driverId });
      //
      // Uma falha da RPC (o `raise exception` do laço de reaplicação em
      // 0065:1610, disputa no advisory lock, banco fora por um instante) deixava
      // o motorista habilitado — e portanto apto a ficar online — com
      // `driver_share_percent` NULL. E NULL não vira erro em lugar nenhum: as
      // duas implementações do split coagem NULL para 0.80 (src/lib/split.ts:78-82
      // em `shareToMilli`, e 0065:716-717). Um motorista da faixa dos 100
      // primeiros, com direito a 85%, passava a receber 80% em TODA corrida, em
      // silêncio. Como o handler devolvia 200, o Stripe nunca reentregava o
      // evento: não havia segunda chance.
      //
      // A regra do produto é explícita — 85/15 para os 100 primeiros, 80/20
      // depois — então "faixa indefinida" não pode ser um estado em que se
      // trabalha. Duas mudanças: a RPC roda ANTES do update de perfil e o erro é
      // CONFERIDO; se falhar, nada é gravado, sobra uma linha `needs_attention` e
      // o handler devolve 500 para o Stripe REENTREGAR. A reentrega é segura
      // porque a RPC é idempotente por construção (0065:1497-1500: com faixa já
      // atribuída ela devolve o valor e não recalcula) e porque nada foi escrito
      // antes deste ponto neste ramo.
      //
      // Só exigimos a RPC quando ela AINDA TEM TRABALHO. Com a faixa já
      // atribuída, uma falha transitória da chamada não é motivo para travar um
      // `account.updated` — que também carrega DESABILITAÇÕES, e essas precisam
      // passar para tirar o motorista do ar.
      const needsTier = chargesEnabled && (p?.driver_share_percent ?? null) === null;

      if (needsTier) {
        const { error: tierErr } = await admin.rpc('assign_driver_tier', { p_driver: driverId });
        if (tierErr) {
          console.error('account.updated: assign_driver_tier FALHOU — motorista NÃO habilitado', {
            driverId, account: account.id, error: tierErr.message,
          });

          await recordReconciliation(admin, {
            event_id:        `${event.id}_tier_failed`,
            event_type:      'account.updated.assign_tier_failed',
            object_id:       driverId,
            amount_cents:    0,
            currency:        'usd',
            driver_id:       driverId,
            reason:
              `O Stripe habilitou cobranças na conta ${account.id} do motorista ${driverId}, mas ` +
              `assign_driver_tier FALHOU (${tierErr.message}) e a faixa de repasse ficou NULL. ` +
              'NÃO gravamos stripe_charges_enabled = true: um motorista sem faixa que fique online é ' +
              'pago a 80% em toda corrida (as duas implementações do split coagem NULL para 0.80 — ' +
              'src/lib/split.ts:78-82 e 0065:716-717), e quem tinha direito a 85% perde a diferença ' +
              'em silêncio. Devolvemos HTTP 500 para o Stripe reentregar (a RPC é idempotente). Se ele ' +
              'desistir (a reentrega dura ~3 dias), esta linha é o único registro: rode ' +
              'assign_driver_tier à mão e confira a faixa ANTES de liberar o motorista.',
            needs_attention: true,
            raw: {
              driver_id:      driverId,
              stripe_account: account.id,
              error:          tierErr.message,
              phase:          'assign_driver_tier',
            },
          });

          return new Response(
            JSON.stringify({
              error: 'não foi possível atribuir a faixa de repasse do motorista',
              code: 'assign_tier_failed',
              driver_id: driverId,
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }

      await admin.from('profiles').update({
        stripe_onboarding_complete: onboardingDone,
        stripe_payouts_enabled:     payoutsEnabled,
        stripe_charges_enabled:     chargesEnabled,
      }).eq('id', driverId);

      // Conta impedida de cobrar/repassar → tira do ar agora. O gating de
      // "ficar online" (que exige charges + payouts) impede novo retorno.
      if (disabledReason || !chargesEnabled || !payoutsEnabled) {
        await admin.from('driver_locations').update({ is_online: false }).eq('driver_id', driverId);
        console.warn('⚠️ Conta Connect desabilitada — motorista suspenso', {
          driverId, disabledReason, chargesEnabled, payoutsEnabled,
        });
        // Só alerta quando há motivo explícito de desabilitação do Stripe
        // (evita ruído durante o onboarding, quando os flags ainda são false).
        if (disabledReason) {
          await alertTeam(
            admin,
            `Conta Stripe do motorista ${driverId} foi desabilitada (motivo: ${disabledReason}). Motorista suspenso automaticamente.`,
            { type: 'connect_account_disabled', driverId, disabledReason },
          );
        }
      }
    }
  }

  // ── transfer.created / payout.paid — reconciliação financeira ────────────
  // O run-weekly-payouts já grava payouts.stripe_transfer_id ao criar o
  // transfer; estes eventos viram registro auditável em stripe_reconciliation.
  if (event.type === 'transfer.created') {
    const tr = event.data.object as Stripe.Transfer;
    await recordReconciliation(admin, {
      event_id:     event.id,
      event_type:   'transfer.created',
      object_id:    tr.id,
      amount_cents: tr.amount,
      currency:     tr.currency,
      driver_id:    (tr.metadata?.driver_id as string) ?? null,
      payout_id:    (tr.metadata?.payout_id as string) ?? null,
      raw: {
        destination: tr.destination,
        rides_count: tr.metadata?.rides_count ?? null,
        source:      tr.metadata?.source ?? null,
      },
    });
  }
  if (event.type === 'payout.paid') {
    const po = event.data.object as Stripe.Payout;
    await recordReconciliation(admin, {
      event_id:     event.id,
      event_type:   'payout.paid',
      object_id:    po.id,
      amount_cents: po.amount,
      currency:     po.currency,
      raw: { arrival_date: po.arrival_date, status: po.status, method: po.method },
    });
  }

  // ── charge.dispute.created (chargeback) — registra E alerta a equipe ─────
  if (event.type === 'charge.dispute.created') {
    const d = event.data.object as Stripe.Dispute;

    // Tenta associar a disputa a um motorista via a corrida cobrada (rides.
    // stripe_payment_intent_id → driver_id), para dar contexto no alerta.
    let driverId: string | null = null;
    const piId = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id ?? null;
    if (piId) {
      const { data: ride } = await admin
        .from('rides')
        .select('driver_id')
        .eq('stripe_payment_intent_id', piId)
        .maybeSingle();
      driverId = (ride as { driver_id?: string } | null)?.driver_id ?? null;
    }

    await recordReconciliation(admin, {
      event_id:        event.id,
      event_type:      'charge.dispute.created',
      object_id:       d.id,
      amount_cents:    d.amount,
      currency:        d.currency,
      driver_id:       driverId,
      reason:          d.reason,
      needs_attention: true,
      raw: { charge: d.charge, status: d.status, payment_intent: piId },
    });

    const valor = (d.amount / 100).toFixed(2);
    await alertTeam(
      admin,
      `Nova disputa (chargeback) de ${d.currency?.toUpperCase()} ${valor} — motivo: ${d.reason}. Responda no Stripe antes do prazo.`,
      { type: 'stripe_dispute', disputeId: d.id, amount: d.amount, reason: d.reason },
    );
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
