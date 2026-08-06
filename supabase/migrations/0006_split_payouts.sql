-- Divisão de receita por corrida
alter table public.rides
  add column if not exists driver_amount numeric(8,2),
  add column if not exists platform_fee  numeric(8,2),
  add column if not exists payout_id     uuid;

-- Tabela de repasses ao motorista
create table if not exists public.payouts (
  id           uuid default gen_random_uuid() primary key,
  driver_id    uuid references public.profiles(id) not null,
  amount       numeric(8,2) not null,
  rides_count  integer not null default 0,
  status       text not null default 'pending'
               check (status in ('pending','processing','completed','failed')),
  requested_at timestamptz default now(),
  processed_at timestamptz
);

alter table public.payouts enable row level security;

create policy "Motorista ve proprios payouts" on public.payouts
  for select using (auth.uid() = driver_id);

create policy "Motorista insere proprio payout" on public.payouts
  for insert with check (auth.uid() = driver_id);

-- FK de rides.payout_id → payouts.id (após criar a tabela)
alter table public.rides
  add constraint rides_payout_id_fkey
  foreign key (payout_id) references public.payouts(id)
  on delete set null
  not valid;
