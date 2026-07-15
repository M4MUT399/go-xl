-- Jurisdição do perfil (PR-c follow-up) — conecta o rollout gradual por
-- jurisdição, já suportado por system_config (0022) e getConfig/useFeatureFlag
-- (src/lib/systemConfig.ts), a um atributo REAL do motorista/passageiro.
--
-- Até aqui, dispatch_engine_v2/dispatch_multi_offer_fix eram lidos sempre com
-- jurisdiction='global' em TODO call site — a resolução "específica → global"
-- existia no código mas nunca era exercitada, porque nenhuma linha do banco
-- associava um perfil a uma região. Sem isso, um piloto "por jurisdição" não
-- tinha como funcionar: não havia como o app saber a jurisdição de quem estava
-- logado.
--
-- Uso pretendido: jurisdiction é uma REGIÃO (ex.: 'FL', 'US-FL-ORL'), não um
-- motorista individual. Para pilotar o motor v2 numa área, atribua a MESMA
-- jurisdição a passageiros E motoristas dessa área (senão um pedido criado por
-- um passageiro fora do piloto cai no leque legado, mas motoristas dentro do
-- piloto ignoram o leque — ver supressão em useDriverRide/useRide.ts — e nunca
-- veriam a oferta). 'global' é o valor padrão e nunca precisa ser atribuído
-- manualmente.
--
-- Quem pode alterar: só o backend (service_role/admin), nunca o próprio
-- usuário — estende o MESMO guard de 0018/0043 que já trava is_admin/type/
-- verification_status contra auto-edição pelo dono da linha.
alter table public.profiles
  add column if not exists jurisdiction text not null default 'global';

-- Estende o guard existente (create or replace preserva is_admin/type/
-- verification_* de 0018/0043 e acrescenta jurisdiction à lista protegida).
create or replace function public.guard_profile_privileged_fields()
returns trigger
language plpgsql
security definer
as $$
begin
  if auth.role() <> 'service_role' then
    -- Papel é imutável para o próprio usuário: reverte qualquer troca.
    -- Só o service_role (migração/admin) pode reatribuir, se algum dia preciso.
    if new.type is distinct from old.type then
      new.type := old.type;
    end if;

    if new.is_admin is distinct from old.is_admin then
      new.is_admin := old.is_admin;
    end if;

    if new.verification_status is distinct from old.verification_status then
      -- O próprio motorista só pode mover unsubmitted/rejected -> pending
      -- (reenvio de documentos). Qualquer outra transição é revertida.
      if new.verification_status = 'pending'
         and old.verification_status in ('unsubmitted', 'rejected') then
        null; -- permitido
      else
        new.verification_status := old.verification_status;
      end if;
    end if;

    if new.verification_reviewed_by is distinct from old.verification_reviewed_by then
      new.verification_reviewed_by := old.verification_reviewed_by;
    end if;
    if new.verification_reviewed_at is distinct from old.verification_reviewed_at then
      new.verification_reviewed_at := old.verification_reviewed_at;
    end if;
    if new.verification_notes is distinct from old.verification_notes then
      new.verification_notes := old.verification_notes;
    end if;

    -- Jurisdição gate rollouts de feature flag (ex.: dispatch_engine_v2) — o
    -- próprio usuário não pode se auto-atribuir a um piloto revertendo o valor.
    if new.jurisdiction is distinct from old.jurisdiction then
      new.jurisdiction := old.jurisdiction;
    end if;
  end if;
  return new;
end;
$$;

-- Trigger já existe (0018); recriamos por idempotência caso a ordem de
-- aplicação mude. before update garante que a reversão acima valha antes da
-- gravação.
drop trigger if exists trg_guard_profile_privileged_fields on public.profiles;
create trigger trg_guard_profile_privileged_fields
  before update on public.profiles
  for each row execute function public.guard_profile_privileged_fields();

-- Índice para consultas administrativas por jurisdição (ex.: contagem de
-- perfis num piloto antes de expandir).
create index if not exists idx_profiles_jurisdiction
  on public.profiles (jurisdiction)
  where jurisdiction <> 'global';
