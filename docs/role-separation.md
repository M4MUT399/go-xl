# Separação estrita de contas: motorista × passageiro

Uma credencial (e-mail/senha do Supabase Auth) tem **exatamente um papel**.
Motorista e passageiro são contas separadas, com e-mails separados. Não existe
troca de papel dentro da mesma conta.

## Garantias e onde vivem

| Requisito | Como é garantido | Arquivo |
|---|---|---|
| Um papel por credencial | 1 `auth.users` → 1 `profiles` → 1 `type`. E-mail duplicado é bloqueado pelo Supabase Auth. | estrutural |
| Login de motorista vai só para a plataforma de motorista | Toda a navegação é decidida por `profile.type` | `src/navigation/AppNavigator.tsx` |
| Bloqueio de escalonamento cross-role | `type` é **imutável** para o próprio usuário: o trigger `guard_profile_privileged_fields` reverte qualquer troca que não venha do `service_role` | `supabase/migrations/0043_role_immutable.sql` |
| Papel sempre válido | `check (type in ('passenger','driver'))` | `supabase/migrations/0043_role_immutable.sql` |
| Sem estado residual do outro papel no aparelho | No `signOut`, cancela lembretes locais agendados do motorista (`clearDriverReminders`) e limpa a flag `driver_is_online` | `src/contexts/AuthContext.tsx` |

> **Nota sobre o papel no JWT.** Optou-se pela camada **DB + cliente** (fonte do
> papel = `profiles.type`, imutável). O caminho alternativo — injetar `user_role`
> como claim no token via *Custom Access Token Auth Hook* + rejeição nas Edge
> Functions — não foi implementado porque exigiria ativação manual no Dashboard
> do Supabase. Se um dia for desejado, é uma adição incremental, não um
> retrabalho: as Edge Functions passariam a ler o claim em vez de consultar
> `profiles.type`.

## Migração de contas existentes (manual, sem perder histórico)

O arquivo **`supabase/reports/role_separation_audit.sql`** contém consultas
**somente leitura**. Ele **não** está em `migrations/`, então nunca roda sozinho.

### Passo a passo

1. Abra o **SQL Editor** do Supabase (roda como `service_role`, enxerga
   `auth.users`).
2. Rode cada consulta do `role_separation_audit.sql` **antes** de aplicar a
   migration `0043`.
3. Trate cada caso manualmente:
   - **(1) `type` nulo/inválido** — precisa ser corrigido **antes** do `0043`,
     senão a `check` constraint falha ao ser criada. Defina `passenger`/`driver`
     conforme o uso real da conta (veja se ela aparece como `passenger_id` ou
     `driver_id` em `rides`).
   - **(2) mesmo telefone em papéis diferentes** — permitido por design; só
     confirme que é a mesma pessoa e que cada conta guarda apenas o histórico do
     seu papel.
   - **(3) telefone duplicado no mesmo papel** — decida qual conta manter; migre
     histórico se necessário; **nunca apague cegamente**.
   - **(4) auth users órfãos (sem profile)** — crie o profile com o papel correto
     ou remova o auth user órfão.
   - **(5) profiles órfãos (sem auth user)** — histórico de contas removidas;
     mantenha ou arquive conforme a política de retenção.
   - **(6) e-mail repetido entre profiles** — não deveria ocorrer; investigue
     inconsistência do espelho `profiles.email`.
4. Só depois de zerar os casos **(1)**, aplique a migration `0043`.
