-- O linter de segurança do Supabase aponta a view public.rides_with_locations
-- como "Security Definer View": por padrão, views do Postgres rodam com os
-- privilégios/RLS de quem CRIOU a view (o owner, geralmente postgres/service
-- role), e não do usuário que está consultando. Isso significa que a RLS da
-- tabela rides poderia ser contornada por quem tiver acesso à view.
--
-- A correção é marcar a view como security_invoker, para que ela passe a
-- respeitar as permissões e políticas RLS de quem está fazendo a consulta
-- (o comportamento seguro/esperado). Requer Postgres 15+ (Supabase já usa).
alter view public.rides_with_locations set (security_invoker = on);
