-- ═════════════════════════════════════════════════════════════════════════════
-- 0087 — recibo da GORJETA por e-mail quando a gorjeta é cobrada
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A gorjeta é uma cobrança à parte no cartão: outro PaymentIntent, feito pelo
-- `tip-ride` depois da corrida — às vezes no dia seguinte (Steve Horn deu a da
-- corrida de 08/10 no dia 09). Até aqui o passageiro não recebia comprovante
-- dela, e o recibo da corrida, quando a gorjeta já existia, somava as duas
-- cobranças num total que não batia com nenhuma linha da fatura.
--
-- Agora são dois recibos, um por cobrança. O da corrida sai na conclusão
-- (0085); o da gorjeta sai AQUI, no instante em que `tip_payment_intent_id`
-- deixa de ser nulo — é o UPDATE que o `tip-ride` faz depois que a Stripe
-- confirma o pagamento.
--
-- Mesmo desenho da 0085, pelos mesmos motivos: quem dispara é o banco (o app
-- não participa e não precisa de build nova), `net.http_post` é assíncrono e
-- não segura o UPDATE do pagamento, e a idempotência é uma coluna gravada pela
-- função só DEPOIS que o provedor aceita o e-mail.
--
-- Gorjeta cobrada ANTES da conclusão (raro): este gatilho não dispara porque a
-- corrida ainda não está concluída, e o recibo da gorjeta sai junto com o da
-- corrida — a `send-ride-receipt` cuida disso.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

alter table public.rides
  add column if not exists tip_receipt_sent_at timestamptz;

comment on column public.rides.tip_receipt_sent_at is
  'Quando o recibo da GORJETA foi aceito pelo provedor de e-mail (send-ride-receipt, kind=tip). Nulo = ainda não enviado.';

create or replace function public.enviar_recibo_da_gorjeta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_chave text;
begin
  if new.tip_payment_intent_id is null then return new; end if;
  if old.tip_payment_intent_id is not distinct from new.tip_payment_intent_id then return new; end if;
  if new.status <> 'completed' then return new; end if;
  if new.tip_receipt_sent_at is not null then return new; end if;

  select decrypted_secret into v_chave
    from vault.decrypted_secrets where name = 'service_role_key';

  -- Sem o segredo, não levanta exceção: a gorjeta JÁ foi cobrada e o UPDATE que
  -- a registra não pode falhar por causa de um e-mail.
  if v_chave is null then
    raise warning 'recibo da gorjeta %: segredo service_role_key ausente no Vault', new.id;
    return new;
  end if;

  perform net.http_post(
    url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/send-ride-receipt',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_chave),
    body    := jsonb_build_object('rideId', new.id, 'kind', 'tip'),
    timeout_milliseconds := 20000
  );
  return new;
end;
$$;

drop trigger if exists trg_enviar_recibo_da_gorjeta on public.rides;

create trigger trg_enviar_recibo_da_gorjeta
  after update of tip_payment_intent_id on public.rides
  for each row
  execute function public.enviar_recibo_da_gorjeta();
