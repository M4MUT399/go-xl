-- 0040_static_pages_bucket.sql
-- Bucket público para páginas HTML estáticas de retorno (Stripe Checkout/Account
-- Link). Motivo: o gateway do Supabase força Content-Type: text/plain em
-- respostas HTML servidas por Edge Functions no domínio *.supabase.co, então
-- o navegador não renderiza a página — só mostra o HTML "cru" como texto.
-- Supabase Storage serve o content-type real do arquivo, então hospedamos as
-- páginas de retorno (estáticas, sem dado dinâmico do usuário) aqui e o
-- success_url/cancel_url do Stripe aponta direto pra cá.

insert into storage.buckets (id, name, public)
values ('static-pages', 'static-pages', true)
on conflict (id) do nothing;

drop policy if exists "Public read static-pages" on storage.objects;
create policy "Public read static-pages"
  on storage.objects for select
  using (bucket_id = 'static-pages');

-- Sem política de escrita para authenticated/anon: os arquivos são publicados
-- apenas via service_role (deploy manual), nunca pelo app.
