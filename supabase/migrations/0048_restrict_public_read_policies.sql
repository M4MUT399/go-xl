-- Correção de segurança: 3 policies RLS herdadas do schema.sql original
-- ficaram abertas demais e nenhuma das migrations 0001-0047 as revisou.
-- Idempotente (drop if exists antes de recriar).

-- ============================================================
-- 1) profiles — "Perfis públicos para leitura" (schema.sql:30-31)
-- Estava `using (true)` sem `to authenticated`, ou seja, valia também
-- para a role `anon` (a anon key é pública/embutida no app). Qualquer
-- requisição REST sem login conseguia ler a tabela inteira: email,
-- telefone, stripe_customer_id, stripe_payment_method_id, card_last4,
-- verification_selfie_url, verification_document_url, is_admin,
-- contato de emergência, push_token.
--
-- Fix imediato: restringir a `to authenticated` — mata o scraping
-- anônimo. NÃO resolve sozinho a exposição para outros usuários
-- logados (qualquer passageiro/motorista autenticado ainda lê o
-- perfil completo de qualquer outro usuário). Isso exige um passo 2
-- de produto/código: substituir por uma view com só as colunas
-- públicas (full_name, avatar_url, rating) ou restringir por
-- participação em corrida ativa — não incluído aqui para não
-- quebrar telas do app sem coordenar as queries correspondentes.
drop policy if exists "Perfis públicos para leitura" on public.profiles;
create policy "Perfis públicos para leitura" on public.profiles
  for select to authenticated using (true);

-- ============================================================
-- 2) vehicles — "Passageiro vê veículos" (schema.sql:50-51)
-- Mesmo problema: `using (true)` sem `to authenticated`, placas e
-- dados de veículo legíveis por qualquer um sem login.
drop policy if exists "Passageiro vê veículos" on public.vehicles;
create policy "Passageiro vê veículos" on public.vehicles
  for select to authenticated using (true);

-- ============================================================
-- 3) payouts — "Motorista insere proprio payout" (0006_split_payouts.sql:24-25)
-- Permitia que o motorista inserisse diretamente uma linha em
-- `payouts` com status/amount arbitrários via REST. As Edge Functions
-- (request-payout, run-weekly-payouts) usam service_role e não
-- dependem dessa policy — toda escrita em payouts deve vir só delas.
drop policy if exists "Motorista insere proprio payout" on public.payouts;
