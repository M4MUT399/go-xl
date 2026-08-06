-- Tarefa 2 — Separação estrita de contas motorista × passageiro (camada de banco).
--
-- Regra inegociável: uma credencial tem EXATAMENTE um papel. Um usuário nunca
-- pode se converter de passageiro↔motorista alterando a própria linha. A policy
-- de UPDATE em profiles permite ao dono atualizar qualquer coluna da própria
-- linha (auth.uid() = id) — o mesmo vetor que o trigger de 0018 já fecha para
-- is_admin/verification. Aqui estendemos esse MESMO trigger para também travar
-- `type`, revertendo qualquer tentativa de troca de papel que não venha do
-- service_role (Edge Functions administrativas).

-- 1) Valores válidos de papel (defesa contra type nulo/inválido inserido no cadastro)
alter table public.profiles
  drop constraint if exists profiles_type_check;
alter table public.profiles
  add constraint profiles_type_check
  check (type in ('passenger', 'driver'));

-- 2) Estende o guard existente (create or replace preserva a lógica de 0018 e
--    acrescenta a imutabilidade de `type`). Mantém security definer + o mesmo
--    trigger trg_guard_profile_privileged_fields já anexado à tabela.
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
  end if;
  return new;
end;
$$;

-- Trigger já existe (0018); recriamos por idempotência caso a ordem de aplicação
-- mude. before update garante que a reversão acima valha antes da gravação.
drop trigger if exists trg_guard_profile_privileged_fields on public.profiles;
create trigger trg_guard_profile_privileged_fields
  before update on public.profiles
  for each row execute function public.guard_profile_privileged_fields();
