-- ─────────────────────────────────────────────────────────────────────────────
-- Detecção + limpeza de usuários órfãos em auth.users (SEM perfil em profiles)
--
-- Contexto: após corrigir o trigger quebrado handle_new_user (migration 0062),
-- verificamos se sobraram usuários "órfãos" — linha em auth.users sem a linha
-- correspondente em public.profiles. Um órfão trava o e-mail: uma nova tentativa
-- de cadastro com o mesmo e-mail dá "User already registered", mas o usuário não
-- tem perfil e não consegue usar o app.
--
-- IMPORTANTE: os blocos (1) e (2) são SOMENTE LEITURA. O bloco (3) é DESTRUTIVO
-- (apaga usuário) e está COMENTADO de propósito — leia os blocos 1/2 primeiro,
-- decida, e só então descomente/rode com consciência. Rodar como dono do projeto
-- (role postgres) no SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- (1) O e-mail do Aren ficou preso? (o caso que originou tudo)
--     Esperado após o rollback: ZERO linhas. Se aparecer algo, o e-mail travou.
select u.id, u.email, u.created_at, u.confirmed_at,
       (p.id is not null) as tem_perfil
from auth.users u
left join public.profiles p on p.id = u.id
where u.email = 'aren.pattoukian@gmail.com';

-- (2) TODOS os órfãos: existe em auth.users mas NÃO em profiles.
--     Revise esta lista antes de apagar qualquer coisa. `age` ajuda a ver se são
--     tentativas recentes (deste bug) ou lixo antigo.
select u.id,
       u.email,
       u.created_at,
       u.confirmed_at,
       age(now(), u.created_at) as idade
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
order by u.created_at desc;

-- (3) LIMPEZA — DESTRUTIVO, NÃO REVERSÍVEL. Apaga os órfãos para liberar os
--     e-mails. Só descomente depois de conferir a lista do bloco (2).
--     A FK profiles.id → auth.users(id) é ON DELETE CASCADE, então não sobra
--     lixo. RECOMENDAÇÃO: para poucos usuários, prefira apagar pela UI
--     (Dashboard → Authentication → Users → ... → Delete user) — é o caminho
--     oficial do GoTrue. Use o SQL abaixo só se forem muitos.
--
-- delete from auth.users u
-- where not exists (select 1 from public.profiles p where p.id = u.id);
--
--     …ou, para apagar SÓ o e-mail do Aren (mais cirúrgico):
--
-- delete from auth.users
-- where email = 'aren.pattoukian@gmail.com'
--   and not exists (select 1 from public.profiles p where p.id = auth.users.id);
