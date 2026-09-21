// send_ride_receipts.ts — envia o RECIBO DO GO XL das corridas que ficaram sem.
//
// O gatilho da migração 0085 cuida das corridas NOVAS: quando o motorista
// conclui, o banco chama a `send-ride-receipt`. Este script existe para o
// passado — e para o caso em que o provedor de e-mail esteve fora do ar, já que
// nesse caso a função responde erro e NÃO marca `receipt_sent_at`, deixando a
// corrida elegível de propósito.
//
// Foi escrito para um caso concreto: em 21/09/2026 havia 5 corridas concluídas
// desde 08/09, todas cobradas corretamente, e nenhum passageiro tinha recebido
// comprovante — porque até então o projeto não tinha canal de e-mail nenhum.
//
// ── DIFERENÇA PARA O send_stripe_receipts.ts ───────────────────────────────
//
// Aquele dispara o recibo DA STRIPE: valor, cartão, data, comerciante. É
// comprovante de pagamento e serve de ponte.
// Este manda o recibo DO GO XL: trajeto, motorista, veículo, distância, duração
// e a quebra da tarifa — o documento da viagem.
//
// ── USO (VOCÊ roda, dentro de /Users/mamute99/go-xl) ───────────────────────
//
//   ensaio:   deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/send_ride_receipts.ts
//   enviar:   deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/send_ride_receipts.ts --aplicar
//
// Aceita `--desde AAAA-MM-DD` (padrão: 2026-09-01) e `--corrida <uuid>` para uma só.
// Quem decide o que enviar é a função (status, e-mail, `receipt_sent_at`); este
// script só escolhe as candidatas e conta o resultado.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try { await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true }); } catch { /* usa o ambiente */ }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltam SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em supabase/scripts/.env');
  Deno.exit(1);
}

const APLICAR = Deno.args.includes('--aplicar');
const iDesde = Deno.args.indexOf('--desde');
const DESDE = iDesde >= 0 ? Deno.args[iDesde + 1] : '2026-09-01';
const iUma = Deno.args.indexOf('--corrida');
const SO_ESTA = iUma >= 0 ? Deno.args[iUma + 1] : null;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const line = (s = '') => console.log(s);

let consulta = sb
  .from('rides')
  .select('id, completed_at, price, tip_amount, passenger_id, receipt_sent_at')
  .eq('status', 'completed')
  .is('receipt_sent_at', null);
if (SO_ESTA) consulta = consulta.eq('id', SO_ESTA);
else consulta = consulta.gte('completed_at', DESDE);

const { data, error } = await consulta.order('completed_at');
if (error) { console.error('Falha ao ler as corridas:', error.message); Deno.exit(1); }
const corridas = (data ?? []) as { id: string; completed_at: string | null; price: number | null; passenger_id: string }[];

const { data: profs } = await sb.from('profiles').select('id, full_name, email')
  .in('id', [...new Set(corridas.map((r) => r.passenger_id))]);
const pax = new Map(((profs ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p]));

line(`Corridas concluídas sem recibo${SO_ESTA ? '' : ` desde ${DESDE}`}: ${corridas.length}`);
line(APLICAR ? 'Modo: ENVIAR' : 'Modo: ENSAIO (nada é enviado)');
line();

let enviados = 0, pulados = 0, falhas = 0;

for (const r of corridas) {
  const p = pax.get(r.passenger_id);
  const rotulo = `${String(r.completed_at ?? '').slice(0, 10)}  ${p?.full_name?.trim() || '(sem nome)'}  US$ ${Number(r.price ?? 0).toFixed(2)}`;

  if (!p?.email?.trim()) { line(`⏭  ${rotulo} — passageiro sem e-mail.`); pulados++; continue; }
  line(`✉️  ${rotulo} → ${p.email}`);
  if (!APLICAR) continue;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-ride-receipt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rideId: r.id }),
  });
  const corpo = await res.json().catch(() => ({}));

  if (res.ok && corpo?.sent) { line('    ✔ enviado.'); enviados++; }
  else if (res.ok && corpo?.skipped) { line(`    ⏭  ${corpo.skipped}`); pulados++; }
  else {
    // 503 = canal de e-mail não configurado. É o estado esperado enquanto não
    // houver provedor, e a corrida SEGUE elegível — nada se perde.
    line(`    ✗ ${res.status}: ${corpo?.error ?? JSON.stringify(corpo).slice(0, 160)}`);
    falhas++;
  }
}

line();
line(`Resumo: ${enviados} enviado(s), ${pulados} pulado(s), ${falhas} falha(s).`);
if (!APLICAR) line('ENSAIO — nada foi enviado. Rode de novo com --aplicar para valer.');
