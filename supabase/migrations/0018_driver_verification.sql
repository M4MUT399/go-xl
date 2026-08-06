-- Verificação de identidade do motorista (selfie + documento) com aprovação
-- pela equipe via go-xl-admin. Duplo grau de conferência: o motorista envia
-- as duas evidências juntas; a equipe revisa e aprova/rejeita.
alter table public.profiles
  add column if not exists verification_selfie_url     text,
  add column if not exists verification_document_url    text,
  add column if not exists verification_status          text not null default 'unsubmitted',
  add column if not exists verification_notes           text,
  add column if not exists verification_submitted_at    timestamptz,
  add column if not exists verification_reviewed_at     timestamptz,
  add column if not exists verification_reviewed_by     uuid,
  add column if not exists is_admin                     boolean not null default false;

alter table public.profiles
  drop constraint if exists profiles_verification_status_check;
alter table public.profiles
  add constraint profiles_verification_status_check
  check (verification_status in ('unsubmitted', 'pending', 'approved', 'rejected', 'revoked'));

-- Defesa em profundidade: a policy de UPDATE existente permite que o próprio
-- usuário atualize qualquer coluna da própria linha (auth.uid() = id), o que
-- deixaria o motorista se auto-aprovar ou se tornar admin com um update direto.
-- Este trigger reverte qualquer tentativa de alterar campos privilegiados a
-- menos que a chamada venha do service_role (usado pelas Edge Functions de
-- administração, que SÃO as únicas autorizadas a aprovar/rejeitar/revogar).
create or replace function public.guard_profile_privileged_fields()
returns trigger
language plpgsql
security definer
as $$
begin
  if auth.role() <> 'service_role' then
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

drop trigger if exists trg_guard_profile_privileged_fields on public.profiles;
create trigger trg_guard_profile_privileged_fields
  before update on public.profiles
  for each row execute function public.guard_profile_privileged_fields();
