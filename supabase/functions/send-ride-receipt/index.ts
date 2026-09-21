// Supabase Edge Function — envia o RECIBO da corrida ao e-mail do passageiro.
//
// Chamada pelo gatilho da migração 0085, quando o motorista conclui a corrida,
// e pelo script `supabase/scripts/send_ride_receipts.ts` para corridas antigas.
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

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { receiptHtml, receiptSubject, type ReceiptRide } from '../_shared/rideReceipt.ts';
import { isServiceRoleCaller } from '../_shared/serviceAuth.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY')            ?? '';
const RECEIPT_FROM         = Deno.env.get('RECEIPT_FROM')              ?? '';
const COMPANY_NAME         = Deno.env.get('RECEIPT_COMPANY_NAME')      ?? 'Go XL';
const COMPANY_LICENSE      = Deno.env.get('RECEIPT_COMPANY_LICENSE')   ?? '';
const SUPPORT_EMAIL        = Deno.env.get('RECEIPT_SUPPORT_EMAIL')     ?? '';

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

  const { rideId, force } = await req.json().catch(() => ({ rideId: null, force: false }));
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
            'origin_address, destination_address, completed_at, created_at, receipt_sent_at, passenger_id, driver_id')
    .eq('id', rideId)
    .single();

  if (erroCorrida || !ride) return json({ error: 'Corrida não encontrada' }, 404);
  const r = ride as unknown as ReceiptRide & {
    status: string; receipt_sent_at: string | null; passenger_id: string; driver_id: string | null;
  };

  // Recibo é de viagem FEITA. Corrida cancelada não gera recibo — e mandar um
  // para quem cancelou é o tipo de e-mail que vira reclamação.
  if (r.status !== 'completed') return json({ skipped: 'not_completed', status: r.status });
  if (r.receipt_sent_at && !force) return json({ skipped: 'already_sent', at: r.receipt_sent_at });

  const { data: pax } = await admin
    .from('profiles').select('full_name, email').eq('id', r.passenger_id).single();
  const p = pax as { full_name: string | null; email: string | null } | null;
  const email = p?.email?.trim();
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

  const empresa = { legalName: COMPANY_NAME, licenseNumber: COMPANY_LICENSE || null, supportEmail: SUPPORT_EMAIL || null };
  const html = receiptHtml(r, { passengerName: p?.full_name, driverName, vehicle }, empresa);

  const resposta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RECEIPT_FROM, to: [email], subject: receiptSubject(r, empresa), html }),
  });

  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '');
    console.error('[send-ride-receipt] provedor recusou', rideId, resposta.status, detalhe);
    // NÃO marca. A corrida continua elegível para a próxima tentativa.
    return json({ error: 'Provedor recusou o envio.', status: resposta.status, detail: detalhe.slice(0, 300) }, 502);
  }

  const enviado = await resposta.json().catch(() => ({}));

  // Marca DEPOIS de o provedor aceitar. O erro do UPDATE é conferido: descartá-lo
  // faria o recibo ser reenviado a cada passada, e e-mail repetido para cliente
  // é o defeito que a coluna existe para evitar.
  const { error: erroMarca } = await admin
    .from('rides').update({ receipt_sent_at: new Date().toISOString() }).eq('id', rideId);

  if (erroMarca) {
    console.error('[send-ride-receipt] enviado mas NÃO marcado', rideId, erroMarca);
    return json({ sent: true, warning: 'enviado, porém não marcado — risco de reenvio', id: enviado?.id }, 200);
  }

  return json({ sent: true, to: email, id: enviado?.id ?? null });
});
