-- Ativa REPLICA IDENTITY FULL na tabela messages para que filtros
-- de coluna no postgres_changes (ride_id=eq.X) funcionem corretamente.
alter table public.messages replica identity full;
