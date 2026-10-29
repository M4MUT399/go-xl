-- ═════════════════════════════════════════════════════════════════════════════
-- 0077 — avaliar quem nunca te levou, e ler a placa de todo mundo
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Dois achados do mesmo ataque, os dois em policies que dizem menos do que o
-- nome delas promete.
--
-- ── A. `ratings` — a policy confere o REMETENTE e mais nada ─────────────────
--
--     create policy "Usuário cria avaliação" on ratings
--       for insert with check (auth.uid() = from_user);
--
-- Ela garante que ninguém assina em nome de outro. Não garante que houve
-- corrida, que o avaliado estava nela, nem que o avaliador estava. Rodado:
--
--     Bob insere rating de Dave com nota 1, usando uma corrida
--     em que Dave nunca esteve                          -> 1 linha
--     Bob insere rating DE SI MESMO com nota 5          -> 1 linha
--
-- O índice único é `(ride_id, from_user)`, então é uma avaliação por corrida
-- por avaliador. Mas quem cria a corrida é o próprio passageiro — a policy
-- "Passageiro cria corrida" existe para isso —, então o teto por corrida não é
-- teto nenhum: N corridas suas, N avaliações contra qualquer motorista.
--
-- Isto é o P0-13 de novo por um caminho LEGÍTIMO. A 0073 fechou a escrita
-- direta em `profiles_public.rating`; esta porta chega ao mesmo lugar sem
-- violar privilégio nenhum, só usando a tabela como ela foi declarada.
--
-- Uma ressalva importante para não superestimar o dano de HOJE: `profiles.rating`
-- não é escrito por nada. Nasce `5.0` no cadastro (`AuthContext.tsx:181`) e não
-- há trigger, migration ou Edge Function que o atualize — busca no repositório
-- inteiro. A estrela que o passageiro vê é uma constante. Quem lê `ratings` de
-- verdade é `useUserStats.ts:30`, e ele agrega o que o PRÓPRIO usuário recebeu
-- — ou seja, o motorista vê as notas forjadas na tela dele. E no dia em que
-- alguém escrever a agregação (é o que falta para a estrela significar algo),
-- ela nasce envenenada na origem. Consertar a policy agora custa uma função.
--
-- ── B. `vehicles` — o registro inteiro da frota, para qualquer conta ────────
--
--     create policy "Passageiro vê veículos" on vehicles
--       for select to authenticated using (true);
--
-- `using (true)`. Rodado: um passageiro comum lê `driver_id, model, plate,
-- color, year` de TODOS os veículos cadastrados. Placa é identificador de
-- veículo no mundo real, e o `driver_id` costura direto com `profiles_public`
-- (nome, foto, nota). Uma conta grátis do Cadastro Expresso baixa o cadastro da
-- frota inteira, com placa, e o cruza com nome e rosto.
--
-- É a mesma família do P1 nº 3 (`profiles_public` listável), um degrau acima:
-- lá é nome e foto, aqui é a placa do carro.
--
-- O escopo verdadeiro é estreito e é o que o app usa: o passageiro precisa ver
-- o carro do motorista DELE. Os dois únicos leitores no repositório são
-- `ScheduledRidesScreen.tsx:70`, que já filtra por `.in('driver_id', driverIds)`
-- vindos das corridas do próprio passageiro, e `useVehicle.ts`, que é o
-- motorista no próprio veículo. A página pública de rastreio
-- (`track-trip/index.ts:82`) usa `service_role` e não passa por aqui.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Travessias em `security definer`, pelo motivo da 0076 ───────────────────
-- Subconsulta a outra tabela com RLS dentro de uma policy é como o ciclo da
-- 0076 nasceu. Nenhuma das duas abaixo fecha ciclo hoje, mas a regra da casa
-- passou a ser esta, e ela custa uma função.

create or replace function public.was_party_to_ride(p_ride_id uuid, p_counterpart uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  select exists (
    select 1
      from public.rides r
     where r.id = p_ride_id
       and (
         (r.passenger_id = (select auth.uid()) and r.driver_id    = p_counterpart)
         or (r.driver_id  = (select auth.uid()) and r.passenger_id = p_counterpart)
       )
  );
$$;

create or replace function public.shares_ride_with_driver(p_driver_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  select exists (
    select 1
      from public.rides r
     where r.driver_id = p_driver_id
       and r.passenger_id = (select auth.uid())
  );
$$;

revoke execute on function public.was_party_to_ride(uuid, uuid)     from public, anon;
revoke execute on function public.shares_ride_with_driver(uuid)     from public, anon;
grant  execute on function public.was_party_to_ride(uuid, uuid)     to authenticated, service_role;
grant  execute on function public.shares_ride_with_driver(uuid)     to authenticated, service_role;

-- ── A. Avaliação exige ter estado na corrida, dos dois lados ────────────────
--
-- `to authenticated` de propósito: a policy antiga era `{public}`, herdada do
-- schema base, e a tese da 0067 é que o papel se declara.

drop policy if exists "Usuário cria avaliação" on public.ratings;
create policy "Usuário cria avaliação" on public.ratings
  for insert to authenticated
  with check (
    (select auth.uid()) = from_user
    and from_user <> to_user                        -- ninguém se avalia
    and public.was_party_to_ride(ride_id, to_user)  -- e os dois estavam na corrida
  );

drop policy if exists "Usuário vê suas avaliações" on public.ratings;
create policy "Usuário vê suas avaliações" on public.ratings
  for select to authenticated
  using ((select auth.uid()) = from_user or (select auth.uid()) = to_user);

-- ── B. O veículo do MEU motorista, não o da frota ───────────────────────────

drop policy if exists "Passageiro vê veículos" on public.vehicles;
create policy "Passageiro vê veículos" on public.vehicles
  for select to authenticated
  using (
    (select auth.uid()) = driver_id                  -- o próprio motorista
    or public.shares_ride_with_driver(driver_id)     -- o passageiro dele
    or exists (select 1 from public.profiles p
                where p.id = (select auth.uid()) and p.is_admin = true)
  );

-- A policy `ALL` do motorista sobre o próprio veículo era `{public}` e continua
-- valendo para o resto (insert/update/delete); só o papel é declarado.
drop policy if exists "Motorista gerencia seu veículo" on public.vehicles;
create policy "Motorista gerencia seu veículo" on public.vehicles
  for all to authenticated
  using ((select auth.uid()) = driver_id)
  with check ((select auth.uid()) = driver_id);

-- ── C. Asserções ────────────────────────────────────────────────────────────

do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'vehicles'
       and policyname = 'Passageiro vê veículos'
       and qual = 'true'
  ) then
    raise exception '0077 incompleta: `vehicles` voltou a using(true) — a frota inteira ficaria legível';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'ratings'
       and policyname = 'Usuário cria avaliação'
       and with_check like '%was_party_to_ride%'
  ) then
    raise exception '0077 incompleta: avaliação não exige mais ter estado na corrida';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('ratings', 'vehicles')
       and 'public' = any(roles)
  ) then
    raise exception '0077 incompleta: sobrou policy em {public} em ratings/vehicles';
  end if;
end $$;

comment on policy "Passageiro vê veículos" on public.vehicles is
  'O passageiro lê o veículo do motorista COM QUEM TEM (ou teve) corrida. Até a 0077 esta policy era `using (true)`: qualquer conta autenticada lia driver_id, modelo, PLACA, cor e ano de toda a frota, e cruzava com nome e foto por profiles_public.';
