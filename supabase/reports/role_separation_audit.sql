-- ─────────────────────────────────────────────────────────────────────────────
-- Tarefa 2 — Auditoria de separação de papéis (SOMENTE LEITURA)
--
-- NÃO é uma migration. Não fica em supabase/migrations/ de propósito: nada aqui
-- é aplicado automaticamente. Rode manualmente no SQL Editor do Supabase (que
-- roda como service_role e enxerga auth.users) ANTES de aplicar a migration
-- 0043_role_immutable.sql, e trate cada caso à mão — sem perder histórico.
--
-- Por que ANTES do 0043: a migration adiciona
--   check (type in ('passenger','driver'))
-- e FALHA se existir alguma linha com type nulo/inválido. A consulta (1) abaixo
-- encontra exatamente essas linhas para você corrigir primeiro.
--
-- Nenhuma consulta altera dados. Todas são SELECT.
-- ─────────────────────────────────────────────────────────────────────────────

-- (1) Perfis com papel nulo ou inválido — BLOQUEIAM a constraint do 0043.
--     Ação manual: definir 'passenger' ou 'driver' conforme o uso real da conta
--     (checar rides como passenger_id vs. driver_id) e SÓ ENTÃO aplicar 0043.
select
  p.id,
  p.email,
  p.full_name,
  p.type            as papel_atual,
  p.created_at
from public.profiles p
where p.type is null
   or p.type not in ('passenger', 'driver')
order by p.created_at;

-- (2) Mesmo TELEFONE em contas de papéis diferentes (um humano com conta de
--     passageiro E de motorista). É PERMITIDO por design (e-mails/credenciais
--     separados), mas listamos para conferência: garantir que são de fato a
--     mesma pessoa e que cada conta guarda só o histórico do seu papel.
select
  p.phone,
  count(*)                                        as contas,
  array_agg(distinct p.type)                      as papeis,
  array_agg(p.id order by p.created_at)           as profile_ids,
  array_agg(p.email order by p.created_at)        as emails
from public.profiles p
where coalesce(trim(p.phone), '') <> ''
group by p.phone
having count(distinct p.type) > 1
order by contas desc;

-- (3) Mesmo TELEFONE duplicado DENTRO do mesmo papel (possível conta duplicada
--     do mesmo usuário no mesmo papel). Ação manual: decidir qual manter;
--     migrar histórico se necessário; nunca apagar cegamente.
select
  p.phone,
  p.type,
  count(*)                                        as contas,
  array_agg(p.id order by p.created_at)           as profile_ids,
  array_agg(p.email order by p.created_at)        as emails
from public.profiles p
where coalesce(trim(p.phone), '') <> ''
group by p.phone, p.type
having count(*) > 1
order by contas desc;

-- (4) Usuários de auth SEM perfil (órfãos) — logam mas caem sem papel definido.
--     Ação manual: criar o profile com o papel correto ou remover o auth user
--     órfão conforme o caso.
select
  u.id,
  u.email,
  u.created_at
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
order by u.created_at;

-- (5) Perfis SEM usuário de auth correspondente (histórico órfão pós-remoção de
--     conta). Ação manual: manter para histórico ou arquivar conforme a política
--     de retenção — não é vetor de login, então baixo risco.
select
  p.id,
  p.email,
  p.type,
  p.created_at
from public.profiles p
left join auth.users u on u.id = p.id
where u.id is null
order by p.created_at;

-- (6) E-mail repetido entre perfis (não deveria ocorrer — auth.users.email é
--     único — mas confere consistência do espelho em profiles.email).
select
  lower(p.email)                                  as email,
  count(*)                                        as contas,
  array_agg(p.id)                                 as profile_ids,
  array_agg(p.type)                               as papeis
from public.profiles p
where coalesce(trim(p.email), '') <> ''
group by lower(p.email)
having count(*) > 1
order by contas desc;
