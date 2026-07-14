-- Tier 2 do fix de exposição de profiles — conclui o que a 0049 deixou
-- pendente: agora que push_token não é mais lido no client para outros
-- usuários (leitura movida para a Edge Function `send-ride-push`,
-- service_role — ver hooks/useRide.ts e hooks/useDriverScheduledRides.ts),
-- a policy ampla "Perfis públicos para leitura" (using (true), criada em
-- 0048/reafirmada em 0049) não tem mais nenhum consumidor legítimo.
--
-- Auditoria feita antes deste migration (grep em src/ e supabase/functions/
-- por `.from('profiles')`) confirmou que toda leitura remanescente de
-- `profiles` no client é:
--   • do próprio usuário (auth.uid() = id) — AuthContext, useRide.ts
--     (driver_share_percent do motorista lendo a própria faixa);
--   • de OUTRO usuário, mas só via `profiles_public` (view non-security-
--     invoker criada em 0049) — nome/foto/nota/tipo/driver_code;
--   • dentro de Edge Functions com service_role (admin client, não sujeito
--     a RLS) — track-trip, send-ride-push, charge-ride, etc.
--
-- Ou seja: a policy "own row" já existente ("Usuário vê o próprio perfil")
-- cobre tudo que resta. Removendo a policy ampla, um usuário autenticado
-- deixa de conseguir ler a linha INTEIRA de outro usuário via REST direto
-- (email, telefone, stripe_customer_id, stripe_payment_method_id,
-- card_last4, verification_selfie_url, verification_document_url,
-- is_admin, contato de emergência, push_token).

drop policy if exists "Perfis públicos para leitura" on public.profiles;

-- Nenhuma policy nova é necessária aqui: "Usuário vê o próprio perfil"
-- (for select using (auth.uid() = id), já existente desde o schema.sql
-- original) permanece cobrindo o caso de leitura do próprio perfil.
