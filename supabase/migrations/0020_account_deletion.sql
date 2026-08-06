-- Remove o "on delete cascade" entre profiles.id e auth.users.id.
--
-- Por quê: a exclusão de conta (Apple Guideline 5.1.1(v)) precisa apagar o
-- login (auth.users) sem apagar a linha de profiles, pois rides.passenger_id,
-- rides.driver_id, messages.sender_id, ratings.from_user/to_user e
-- payouts.driver_id são NOT NULL com regra de exclusão NO ACTION — ou seja,
-- se o cascade tentasse remover profiles, a operação falharia (ou, se não
-- falhasse, destruiria o histórico de corrida da CONTRAPARTE também).
--
-- A função delete-account anonimiza profiles (apaga PII) e só então remove
-- o usuário de auth.users. Sem essa migration, esse segundo passo falha (ou
-- arrasta o profile junto) sempre que o usuário tiver pelo menos uma corrida.
-- Sem recriar a constraint: profiles.id precisa poder sobreviver como um
-- registro "órfão" (sem auth.users correspondente) depois que a conta de
-- login é excluída. Qualquer FK aqui — mesmo com "no action" — voltaria a
-- bloquear o DELETE em auth.users enquanto a linha de profiles existir.
alter table public.profiles
  drop constraint if exists profiles_id_fkey;
