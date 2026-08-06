-- Chat entre passageiro e motorista durante a corrida.
-- Rode no SQL Editor do Supabase.
create table if not exists public.messages (
  id uuid default gen_random_uuid() primary key,
  ride_id uuid references public.rides(id) on delete cascade not null,
  sender_id uuid references public.profiles(id) not null,
  text text not null,
  created_at timestamptz default now()
);

alter table public.messages enable row level security;

create policy "Participantes leem mensagens" on public.messages
  for select using (
    exists (
      select 1 from public.rides r
      where r.id = ride_id and (r.passenger_id = auth.uid() or r.driver_id = auth.uid())
    )
  );

create policy "Participantes enviam mensagens" on public.messages
  for insert with check (
    sender_id = auth.uid() and exists (
      select 1 from public.rides r
      where r.id = ride_id and (r.passenger_id = auth.uid() or r.driver_id = auth.uid())
    )
  );

alter publication supabase_realtime add table public.messages;
