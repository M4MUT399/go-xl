// Supabase Edge Function — envia o RECIBO da corrida ao e-mail do passageiro.
//
// Chamada pelo BANCO (migração 0092): pela varredura `ride-receipt-sweep`, 20
// min depois de a corrida terminar, ou pelo gatilho da gorjeta; e pelo script
// `supabase/scripts/send_ride_receipts.ts` para corridas antigas.
//
// RECIBO ÚNICO (Edson, 29/10/2026): se o passageiro der gorjeta até 20 min
// depois do fim da corrida, sai UM recibo com viagem + gorjeta. Gorjeta dada
// depois disso ganha recibo próprio. Por isso o recibo da corrida não sai mais
// no instante da conclusão: ele espera a janela da gorjeta fechar (ou a
// gorjeta chegar, o que vier primeiro).
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE O DISPARO NÃO MORA NO APLICATIVO
// ─────────────────────────────────────────────────────────────────────────────
// O caminho óbvio seria o app do motorista chamar isto depois de
// `updateRideStatus('completed')`. É exatamente o desenho que custou caro em
// 06/09: a cobrança da corrida agendada vivia num `void (async () => …)` no
// telefone do motorista, disparado no instante em que ele fecha a tela da
// viagem, e 5 de 5 corridas concluídas ficaram sem cobrar sem que nada
// percebesse. Recibo tem a mesma natureza: se falhar, falha calado.
//
// Por isso quem dispara é o BANCO (gatilho + pg_net, migração 0085), e a
// idempotência é uma coluna — `rides.receipt_sent_at`. O app não participa.
//
// ─────────────────────────────────────────────────────────────────────────────
// PROVEDOR DE E-MAIL
// ─────────────────────────────────────────────────────────────────────────────
// Até 21/09/2026 este projeto NÃO TINHA canal de e-mail nenhum: nenhum provedor
// no código, nenhuma chave nos segredos. Esta função espera `RESEND_API_KEY` e
// `RECEIPT_FROM` (ex.: "Go XL <receipts@goxl.app>").
//
// Sem os dois ela responde 503 e NÃO marca a corrida como enviada — de
// propósito: assim, no dia em que a chave existir, o script de reenvio alcança
// tudo que ficou para trás. Marcar antes de conseguir enviar seria perder o
// recibo em silêncio.
//
// ⚠️ O domínio precisa estar VERIFICADO no provedor, com SPF e DKIM no DNS de
// goxl.app. Sem isso o recibo sai, mas cai em spam — e recibo em spam é pior
// que recibo nenhum, porque o passageiro não recebe E a plataforma acha que
// entregou.
//
// Deploy:  npx supabase functions deploy send-ride-receipt
// Segredos: RESEND_API_KEY, RECEIPT_FROM (+ SUPABASE_URL/SERVICE_ROLE_KEY automáticos)
// Opcionais: RECEIPT_SUPPORT_EMAIL (reply-to e rodapé), RECEIPT_BCC (cópia à operação)

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  receiptHtml, receiptLang, receiptSubject, tipReceiptHtml, tipReceiptSubject, type ReceiptRide,
} from '../_shared/rideReceipt.ts';
import { isServiceRoleCaller } from '../_shared/serviceAuth.ts';
import { GOXL_LOGO_CID, GOXL_LOGO_PNG_BASE64 } from '../_shared/receiptLogo.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY')            ?? '';
const RECEIPT_FROM         = Deno.env.get('RECEIPT_FROM')              ?? '';
const COMPANY_NAME         = Deno.env.get('RECEIPT_COMPANY_NAME')      ?? 'Go XL';
const COMPANY_LICENSE      = Deno.env.get('RECEIPT_COMPANY_LICENSE')   ?? '';
const SUPPORT_EMAIL        = Deno.env.get('RECEIPT_SUPPORT_EMAIL')     ?? '';
// Cópia oculta de cada recibo para a operação (ex.: o e-mail do Edson). Serve de
// arquivo e de prova de entrega quando o passageiro diz que "não chegou".
const RECEIPT_BCC          = Deno.env.get('RECEIPT_BCC')               ?? '';
// Para o recibo da gorjeta: valor, hora e cartão saem da cobrança na Stripe.
const STRIPE_SECRET_KEY    = Deno.env.get('STRIPE_SECRET_KEY')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  if (!isServiceRoleCaller(req.headers.get('Authorization'), SUPABASE_SERVICE_KEY)) {
    return json({ error: 'Não autorizado' }, 401);
  }

  const corpo = await req.json().catch(() => ({}));
  const rideId: string | null = corpo?.rideId ?? null;
  const force = corpo?.force === true;
  // `ride` (padrão) = recibo da corrida; `tip` = recibo da cobrança da gorjeta.
  const kind: 'ride' | 'tip' = corpo?.kind === 'tip' ? 'tip' : 'ride';
  // ENSAIO: gera o recibo de uma corrida real mas entrega em `testTo` (e-mail da
  // operação), sem cópia oculta e SEM marcar a corrida — o passageiro continua
  // recebendo o dele normalmente depois. Só quem tem a service key chega aqui.
  const testTo: string | null = typeof corpo?.testTo === 'string' && corpo.testTo.includes('@') ? corpo.testTo.trim() : null;
  if (!rideId) return json({ error: 'rideId obrigatório' }, 400);

  // Sem provedor NÃO marcamos nada. Ver o cabeçalho: marcar antes de conseguir
  // enviar transforma um recibo pendente num recibo perdido.
  if (!RESEND_API_KEY || !RECEIPT_FROM) {
    return json({
      error: 'Canal de e-mail não configurado (RESEND_API_KEY / RECEIPT_FROM). Nada foi enviado nem marcado.',
    }, 503);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: ride, error: erroCorrida } = await admin
    .from('rides')
    .select('id, status, price, toll_amount, airport_port_fee, tip_amount, distance_km, duration_min, ' +
            'origin_address, destination_address, completed_at, boarded_at, created_at, receipt_sent_at, ' +
            'tip_payment_intent_id, tip_receipt_sent_at, passenger_id, driver_id, wait_fee_amount')
    .eq('id', rideId)
    .single();

  if (erroCorrida || !ride) return json({ error: 'Corrida não encontrada' }, 404);
  const r = ride as unknown as ReceiptRide & {
    status: string; receipt_sent_at: string | null; passenger_id: string; driver_id: string | null;
    tip_payment_intent_id: string | null; tip_receipt_sent_at: string | null;
  };

  // Recibo é de viagem FEITA. Corrida cancelada não gera recibo — e mandar um
  // para quem cancelou é o tipo de e-mail que vira reclamação.
  if (r.status !== 'completed') return json({ skipped: 'not_completed', status: r.status });

  const { data: pax } = await admin
    .from('profiles').select('full_name, email, language').eq('id', r.passenger_id).single();
  const p = pax as { full_name: string | null; email: string | null; language: string | null } | null;
  const email = testTo ?? p?.email?.trim();
  if (!email) return json({ skipped: 'no_email' });

  let driverName: string | null = null;
  let vehicle: string | null = null;
  if (r.driver_id) {
    const { data: drv } = await admin.from('profiles').select('full_name').eq('id', r.driver_id).single();
    driverName = (drv as { full_name: string | null } | null)?.full_name ?? null;
    const { data: veh } = await admin
      .from('vehicles').select('model, color').eq('driver_id', r.driver_id).maybeSingle();
    const v = veh as { model: string | null; color: string | null } | null;
    vehicle = v?.model ? `${v.model}${v.color ? ` · ${v.color}` : ''}` : null;
  }

  const empresa = {
    legalName: COMPANY_NAME, licenseNumber: COMPANY_LICENSE || null, supportEmail: SUPPORT_EMAIL || null,
    logoSrc: `cid:${GOXL_LOGO_CID}`,
  };
  // O idioma é o que o passageiro escolheu no app (cadastro/Perfil); sem escolha, inglês.
  const idioma = receiptLang(p?.language);
  // Nome completo e e-mail do passageiro vão no bloco "Cobrado de" (29/10/2026).
  const partes = { passengerName: p?.full_name, passengerEmail: p?.email?.trim() ?? null, driverName, vehicle };

  // Janela do recibo único: até 20 min depois do fim da corrida.
  const JANELA_MS = 20 * 60_000;
  const fimDaJanela = () =>
    r.completed_at ? new Date(Date.parse(r.completed_at) + JANELA_MS).toISOString() : null;
  const dentroDaJanela = (iso: string) => {
    if (!r.completed_at) return false;
    return Date.parse(iso) <= Date.parse(r.completed_at) + JANELA_MS;
  };

  /** Entrega um recibo e, só se o provedor aceitar, grava a coluna de controle. */
  async function enviar(assunto: string, html: string, coluna: 'receipt_sent_at' | 'tip_receipt_sent_at') {
    const resposta = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RECEIPT_FROM,
        to: [email],
        ...(RECEIPT_BCC && !testTo ? { bcc: RECEIPT_BCC.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        // Resposta ao recibo vai para o suporte, não para um remetente que ninguém lê.
        ...(SUPPORT_EMAIL ? { reply_to: SUPPORT_EMAIL } : {}),
        subject: assunto,
        html,
        // A logo vai EMBUTIDA (content_id ↔ `cid:` no HTML), não como URL remota.
        attachments: [{ filename: 'goxl.png', content: GOXL_LOGO_PNG_BASE64, content_id: GOXL_LOGO_CID }],
      }),
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      console.error('[send-ride-receipt] provedor recusou', rideId, coluna, resposta.status, detalhe);
      // NÃO marca. A corrida continua elegível para a próxima tentativa.
      return { ok: false as const, status: resposta.status, detail: detalhe.slice(0, 300) };
    }
    const enviado = await resposta.json().catch(() => ({}));
    if (testTo) return { ok: true as const, id: (enviado?.id as string) ?? null, marcado: true, ensaio: true };

    // Marca DEPOIS de o provedor aceitar. O erro do UPDATE é conferido: descartá-lo
    // faria o recibo ser reenviado a cada passada, e e-mail repetido para cliente
    // é o defeito que a coluna existe para evitar.
    const { error: erroMarca } = await admin
      .from('rides').update({ [coluna]: new Date().toISOString() }).eq('id', rideId);
    if (erroMarca) console.error('[send-ride-receipt] enviado mas NÃO marcado', rideId, coluna, erroMarca);
    return { ok: true as const, id: (enviado?.id as string) ?? null, marcado: !erroMarca };
  }

  /**
   * O recibo da gorjeta. Valor, hora e cartão vêm da STRIPE, não do banco: é a
   * cobrança que o passageiro vai ver na fatura, e a gorjeta pode ter sido dada
   * horas ou um dia depois da corrida.
   */
  async function lerGorjeta() {
    if (!r.tip_payment_intent_id) return { skipped: 'no_tip' as const };
    if (!STRIPE_SECRET_KEY) return { error: 'STRIPE_SECRET_KEY ausente — sem como ler a cobrança da gorjeta.' };
    const pr = await fetch(
      `https://api.stripe.com/v1/payment_intents/${r.tip_payment_intent_id}?expand[]=latest_charge`,
      { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } },
    );
    const pi = await pr.json().catch(() => null);
    if (!pr.ok || !pi) return { error: 'Falha ao ler a gorjeta na Stripe.', status: pr.status };
    if (pi.status !== 'succeeded') return { skipped: 'tip_not_succeeded', status: pi.status };

    const cobranca = pi.latest_charge ?? {};
    const cartao = cobranca?.payment_method_details?.card;
    const marca = cartao?.brand ? String(cartao.brand).charAt(0).toUpperCase() + String(cartao.brand).slice(1) : null;
    return {
      gorjeta: {
        rideId: r.id,
        amount: (pi.amount_received ?? pi.amount ?? 0) / 100,
        chargedAt: new Date(((cobranca?.created ?? pi.created) as number) * 1000).toISOString(),
        rideCompletedAt: r.completed_at ?? null,
        card: cartao?.last4 ? `${marca ?? 'Card'} •••• ${cartao.last4}` : null,
      },
    };
  }

  async function recibodaGorjeta() {
    if (!r.tip_payment_intent_id) return { skipped: 'no_tip' };
    if (r.tip_receipt_sent_at && !force && !testTo) return { skipped: 'already_sent', at: r.tip_receipt_sent_at };
    const lida = await lerGorjeta();
    if (!('gorjeta' in lida) || !lida.gorjeta) return lida;
    const gorjeta = lida.gorjeta;
    const res = await enviar(
      tipReceiptSubject(gorjeta, empresa, idioma), tipReceiptHtml(gorjeta, partes, empresa, idioma), 'tip_receipt_sent_at',
    );
    return res.ok ? { sent: true, id: res.id } : { error: 'Provedor recusou o envio.', status: res.status, detail: res.detail };
  }

  if (kind === 'tip') {
    // Gorjeta dentro da janela e recibo da corrida ainda não enviado: ele vai
    // levar a gorjeta junto — não manda um segundo e-mail.
    if (!r.receipt_sent_at && !force && !testTo && dentroDaJanela(new Date().toISOString())) {
      return json({ kind: 'tip', skipped: 'goes_with_ride_receipt' });
    }
    const out = await recibodaGorjeta();
    return json({ kind: 'tip', to: email, ...out }, 'error' in out ? 502 : 200);
  }

  if (r.receipt_sent_at && !force && !testTo) return json({ skipped: 'already_sent', at: r.receipt_sent_at });

  // ── Recibo único (viagem + gorjeta) ou só da viagem ─────────────────────
  // A gorjeta entra neste recibo se foi cobrada até 20 min depois do fim da
  // corrida e ainda não teve recibo próprio. Fora disso, ela tem o dela.
  let comGorjeta: { amount: number } | null = null;
  if (r.tip_payment_intent_id && !r.tip_receipt_sent_at) {
    const lida = await lerGorjeta();
    if ('gorjeta' in lida && lida.gorjeta && dentroDaJanela(lida.gorjeta.chargedAt)) comGorjeta = { amount: lida.gorjeta.amount };
  }

  // Sem gorjeta e com a janela ainda aberta: espera — a varredura volta aqui
  // quando os 20 min passarem (ou o gatilho da gorjeta, se ela vier antes).
  if (!comGorjeta && !force && !testTo && dentroDaJanela(new Date().toISOString())) {
    return json({ skipped: 'tip_window_open', until: fimDaJanela() });
  }

  const recibo = { ...r, tip_amount: comGorjeta ? comGorjeta.amount : null };
  const res = await enviar(
    receiptSubject(recibo, empresa, idioma), receiptHtml(recibo, partes, empresa, idioma), 'receipt_sent_at',
  );
  if (!res.ok) return json({ error: 'Provedor recusou o envio.', status: res.status, detail: res.detail }, 502);
  if (comGorjeta && !testTo) {
    const { error: erroTip } = await admin
      .from('rides').update({ tip_receipt_sent_at: new Date().toISOString() }).eq('id', rideId);
    if (erroTip) console.error('[send-ride-receipt] recibo único enviado mas gorjeta NÃO marcada', rideId, erroTip);
  }

  // Gorjeta fora da janela ainda sem recibo: sai o dela, separado.
  const tip = !comGorjeta && r.tip_payment_intent_id && !r.tip_receipt_sent_at ? await recibodaGorjeta() : null;

  return json({ sent: true, to: email, id: res.id, ...(res.marcado ? {} : { warning: 'enviado, porém não marcado — risco de reenvio' }), ...(tip ? { tip } : {}) });
});
