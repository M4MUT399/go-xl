-- ═════════════════════════════════════════════════════════════════════════════
-- 0085 — recibo por e-mail quando o motorista conclui a corrida
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Até 21/09/2026 nenhum passageiro do Go XL recebeu comprovante de nada. O
-- recibo EXISTE desde sempre (`src/lib/waybill.ts` monta trajeto, motorista,
-- distância e a quebra da tarifa), mas só como arquivo que o passageiro baixa à
-- mão na tela de detalhes. Não havia canal de e-mail no projeto: nenhum
-- provedor no código, nenhuma chave nos segredos, e o `charge-ride` sequer
-- passava `receipt_email` à Stripe.
--
-- ── POR QUE O GATILHO É DO BANCO, E NÃO DO APLICATIVO ──────────────────────
--
-- O caminho óbvio seria o app do motorista chamar a função depois de
-- `updateRideStatus('completed')`. É exatamente o desenho que custou caro em
-- 06/09: a cobrança da corrida agendada vivia num `void (async () => …)` no
-- telefone do motorista, disparado no instante em que ele fecha a tela da
-- viagem. Resultado medido: 5 de 5 agendadas concluídas ficaram sem cobrar, e
-- nada no servidor percebeu.
--
-- Recibo tem a mesma natureza — se falhar, falha calado. Então quem dispara é o
-- banco, no mesmo UPDATE que marca a corrida como concluída. O app não
-- participa e não precisa de build nova para isto funcionar.
--
-- ── IDEMPOTÊNCIA É UMA COLUNA, NÃO UMA ESPERANÇA ───────────────────────────
--
-- `rides.receipt_sent_at` é gravada pela função DEPOIS que o provedor aceita o
-- envio. Com ela: o gatilho não dispara duas vezes para a mesma corrida, o
-- script de reenvio sabe o que ficou para trás, e um provedor fora do ar deixa
-- a corrida ELEGÍVEL em vez de marcada — perder o recibo em silêncio seria
-- repetir o defeito que este arquivo existe para não repetir.
--
-- ── PRÉ-REQUISITOS ─────────────────────────────────────────────────────────
--
--   1. `npx supabase functions deploy send-ride-receipt` ANTES desta migração,
--      senão o primeiro gatilho bate num 404;
--   2. os segredos do provedor:
--        npx supabase secrets set RESEND_API_KEY=... RECEIPT_FROM='Go XL <receipts@goxl.app>'
--      Sem eles a função responde 503 e NÃO marca nada — nenhum recibo se perde,
--      só fica pendente até a chave existir;
--   3. o segredo `service_role_key` no Vault, o mesmo que os demais jobs usam.
--
-- ⚠️ O domínio precisa estar VERIFICADO no provedor, com SPF e DKIM no DNS de
-- goxl.app. Sem isso o recibo sai e cai em spam — e recibo em spam é pior que
-- recibo nenhum, porque o passageiro não recebe E a plataforma acha que entregou.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

create extension if not exists pg_net;

alter table public.rides
  add column if not exists receipt_sent_at timestamptz;

comment on column public.rides.receipt_sent_at is
  'Quando o recibo foi ACEITO pelo provedor de e-mail (send-ride-receipt). Nulo = ainda não enviado; é o que o gatilho e o script de reenvio consultam.';

-- Índice parcial das concluídas SEM recibo: no estado saudável tem zero linha,
-- então é minúsculo e não pesa em escrita nenhuma fora desse estado. Sem
-- `concurrently` pela mesma razão da 0068/0084 — é ilegal dentro de transação.
create index if not exists rides_receipt_pending_idx
  on public.rides (completed_at)
  where status = 'completed' and receipt_sent_at is null;

-- ── O gatilho ──────────────────────────────────────────────────────────────
--
-- Dispara na TRANSIÇÃO para 'completed', não em todo UPDATE de corrida
-- concluída: `old.status is distinct from new.status` é o que impede um toque
-- qualquer na linha (o repasse gravando `payout_id`, por exemplo) de mandar
-- outro e-mail.
--
-- `net.http_post` é ASSÍNCRONO — enfileira e devolve na hora. O UPDATE do
-- motorista não espera pelo e-mail, e uma falha do provedor não desfaz a
-- conclusão da viagem. Em compensação, o resultado NÃO chega aqui: quem conta o
-- que aconteceu é `net._http_response` e a coluna `receipt_sent_at`.
create or replace function public.enviar_recibo_da_corrida()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_chave text;
begin
  if new.status <> 'completed' then return new; end if;
  if old.status is not distinct from new.status then return new; end if;
  if new.receipt_sent_at is not null then return new; end if;

  select decrypted_secret into v_chave
    from vault.decrypted_secrets where name = 'service_role_key';

  -- Sem o segredo não há como autenticar na função. Não levantamos exceção: o
  -- motorista não pode ficar impedido de concluir a viagem porque o recibo não
  -- pôde sair. A corrida fica com `receipt_sent_at` nulo e o script de reenvio
  -- a alcança depois.
  if v_chave is null then
    raise warning 'recibo da corrida %: segredo service_role_key ausente no Vault', new.id;
    return new;
  end if;

  perform net.http_post(
    url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/send-ride-receipt',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_chave),
    body    := jsonb_build_object('rideId', new.id),
    timeout_milliseconds := 20000
  );
  return new;
end;
$$;

drop trigger if exists trg_enviar_recibo_da_corrida on public.rides;

create trigger trg_enviar_recibo_da_corrida
  after update of status on public.rides
  for each row
  execute function public.enviar_recibo_da_corrida();
