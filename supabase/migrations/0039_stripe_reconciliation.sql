-- Reconciliação financeira + alertas de disputa vindos dos webhooks do Stripe.
--
-- Por quê:
--   Os eventos transfer.created / payout.paid (repasse ao motorista chegando à
--   conta / caindo no banco dele) e charge.dispute.created (chargeback) precisam
--   virar REGISTRO auditável — não apenas log efêmero de função. Esta tabela é o
--   livro-razão que o go-xl-admin consulta para conciliar dinheiro e tratar
--   disputas.
--
-- Idempotência: event_id (id do evento Stripe) é UNIQUE. O Stripe reentrega
--   webhooks; o upsert por event_id evita linhas duplicadas.

create table if not exists public.stripe_reconciliation (
  id              uuid default gen_random_uuid() primary key,
  event_id        text unique not null,               -- evt_… (idempotência)
  event_type      text not null,                      -- transfer.created | payout.paid | charge.dispute.created
  object_id       text,                               -- tr_… | po_… | dp_…
  amount_cents    bigint,
  currency        text,
  driver_id       uuid references public.profiles(id) on delete set null,
  payout_id       uuid references public.payouts(id)  on delete set null,
  reason          text,                               -- motivo da disputa, quando aplicável
  needs_attention boolean not null default false,     -- disputas abertas aguardando a equipe
  resolved_at     timestamptz,
  raw             jsonb,                              -- subconjunto do objeto p/ auditoria
  created_at      timestamptz not null default now()
);

create index if not exists idx_reconciliation_event_type
  on public.stripe_reconciliation (event_type);
create index if not exists idx_reconciliation_needs_attention
  on public.stripe_reconciliation (needs_attention)
  where needs_attention = true;
create index if not exists idx_reconciliation_driver
  on public.stripe_reconciliation (driver_id)
  where driver_id is not null;

alter table public.stripe_reconciliation enable row level security;

-- Somente admins leem (o webhook grava com service_role, que ignora RLS).
create policy "Admin le reconciliation" on public.stripe_reconciliation
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );
