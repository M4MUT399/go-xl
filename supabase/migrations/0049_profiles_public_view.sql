-- Tier 1 do fix de exposição de profiles (continuação da migration 0048).
--
-- Contexto: mesmo restrita a `authenticated` (0048), a policy "Perfis
-- públicos para leitura" ainda usa `using (true)` — ou seja, qualquer
-- passageiro ou motorista LOGADO continua lendo a linha INTEIRA de
-- QUALQUER outro usuário: email, telefone, stripe_customer_id,
-- stripe_payment_method_id, card_last4, verification_selfie_url,
-- verification_document_url, is_admin, contato de emergência, push_token.
--
-- Por que não removo essa policy agora: os fluxos de push notification
-- (src/hooks/useRide.ts, useDriverScheduledRides.ts) dependem dela para ler
-- `push_token` de outros usuários no broadcast de corrida (passageiro →
-- motoristas online) e nas notificações diretas (motorista ↔ passageiro).
-- Restringir a policy sem antes mover essa leitura para um mecanismo
-- server-side (RPC/Edge Function) quebraria silenciosamente as notificações
-- de corrida — reportado separadamente, não incluído neste migration.
--
-- O que este migration resolve: cria `profiles_public`, uma view com só as
-- colunas não sensíveis (identidade visual pública), para as ~9 telas do
-- app que hoje leem `profiles` inteira só para exibir nome/foto/nota/tipo,
-- ou para localizar um motorista pelo `driver_code` (deep link / QR).
-- View criada com `security_invoker = off` (padrão) DE PROPÓSITO: ela
-- enxerga a tabela com o privilégio do dono da view, então continua
-- funcionando mesmo quando a policy ampla de profiles for removida no
-- futuro (Tier 2) — só devolve as colunas listadas abaixo, nunca a linha
-- inteira.

-- Defensivo/idempotente: garante a coluna antes de criar a view (ela já
-- existe em produção, mas não há migration própria que a tenha criado —
-- só o índice em 0007_driver_id_index_qr.sql).
alter table public.profiles add column if not exists driver_code text;

create or replace view public.profiles_public as
select
  id,
  full_name,
  avatar_url,
  rating,
  type,
  driver_code
from public.profiles;

alter view public.profiles_public set (security_invoker = off);

grant select on public.profiles_public to authenticated;

comment on view public.profiles_public is
  'Colunas não sensíveis de profiles (nome, foto, nota, tipo, código do motorista). Usar esta view — nunca public.profiles — para ler dados de OUTRO usuário na tela. Ver migration 0049.';
