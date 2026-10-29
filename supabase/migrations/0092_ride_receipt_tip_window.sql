-- ═════════════════════════════════════════════════════════════════════════════
-- 0092 — recibo único (viagem + gorjeta) na janela de 20 minutos
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Pedido do Edson (29/10/2026): o recibo é ÚNICO com a viagem e a gorjeta se o
-- passageiro der a gorjeta até 20 min depois de a corrida terminar; gorjeta
-- dada depois disso gera dois recibos separados.
--
-- Até aqui (0085) o recibo saía no instante da conclusão — antes de o
-- passageiro sequer ver a tela de gorjeta. Agora:
--   • a conclusão NÃO dispara mais o recibo (gatilho de 0085 removido);
--   • a gorjeta, se cobrada dentro da janela com o recibo ainda pendente,
--     dispara o recibo DA CORRIDA, que sai com a gorjeta dentro;
--   • a varredura `ride-receipt-sweep` (a cada 2 min) envia o recibo de toda
--     corrida concluída há 20 min ou mais que ainda não teve recibo;
--   • gorjeta fora da janela segue o caminho de 0087 (recibo próprio).
--
-- A decisão "junto ou separado" é tomada de novo pela função send-ride-receipt
-- com a hora da cobrança lida da Stripe — o banco só escolhe QUANDO chamar.
-- A função também se recusa a mandar o recibo da corrida com a janela aberta
-- e sem gorjeta (responde tip_window_open), então nenhuma ordem de chegada
-- produz recibo duplicado.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

drop trigger if exists trg_enviar_recibo_da_corrida on public.rides;

create or replace function public.enviar_recibo_da_gorjeta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_chave text;
  v_kind  text;
begin
  if new.tip_payment_intent_id is null then return new; end if;
  if old.tip_payment_intent_id is not distinct from new.tip_payment_intent_id then return new; end if;
  if new.status <> 'completed' then return new; end if;
  if new.tip_receipt_sent_at is not null then return new; end if;

  -- Dentro da janela e sem recibo ainda: manda o recibo da CORRIDA, que leva a
  -- gorjeta junto. Fora dela: recibo próprio da gorjeta.
  v_kind := case
    when new.receipt_sent_at is null
     and new.completed_at is not null
     and now() <= new.completed_at + interval '20 minutes'
    then 'ride' else 'tip' end;

  select decrypted_secret into v_chave
    from vault.decrypted_secrets where name = 'service_role_key';
  if v_chave is null then
    raise warning 'recibo da gorjeta %: segredo service_role_key ausente no Vault', new.id;
    return new;
  end if;

  perform net.http_post(
    url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/send-ride-receipt',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_chave),
    body    := jsonb_build_object('rideId', new.id, 'kind', v_kind),
    timeout_milliseconds := 20000
  );
  return new;
end;
$$;

-- ── Varredura: recibos cuja janela de gorjeta fechou ─────────────────────────
-- Só olha os últimos 2 dias: corrida antiga sem recibo é caso para o script de
-- reenvio, não para martelar a função a cada 2 min. No máximo 25 por passada.
create or replace function public.enviar_recibos_pendentes()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_chave text;
  v_ride  record;
  v_n     integer := 0;
begin
  select decrypted_secret into v_chave
    from vault.decrypted_secrets where name = 'service_role_key';
  if v_chave is null then
    raise warning 'enviar_recibos_pendentes: segredo service_role_key ausente no Vault';
    return 0;
  end if;

  for v_ride in
    select id from public.rides
     where status = 'completed'
       and receipt_sent_at is null
       and completed_at <= now() - interval '20 minutes'
       and completed_at >  now() - interval '2 days'
     order by completed_at
     limit 25
  loop
    perform net.http_post(
      url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/send-ride-receipt',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_chave),
      body    := jsonb_build_object('rideId', v_ride.id),
      timeout_milliseconds := 20000
    );
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.enviar_recibos_pendentes() from public, anon, authenticated;

select cron.unschedule('ride-receipt-sweep')
 where exists (select 1 from cron.job where jobname = 'ride-receipt-sweep');

select cron.schedule(
  'ride-receipt-sweep',
  '*/2 * * * *',
  $$ select public.enviar_recibos_pendentes(); $$
);
