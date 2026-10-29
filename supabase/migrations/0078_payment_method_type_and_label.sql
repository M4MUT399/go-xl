-- ═════════════════════════════════════════════════════════════════════════════
-- 0078 — o perfil passa a saber QUE forma de pagamento tem, não só o cartão
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `profiles` guardava `card_brand` e `card_last4` e mais nada. Quando o método
-- salvo não é cartão, `pm.card` não existe no Stripe, as duas colunas viram
-- NULL — e `stripe_payment_method_id` é gravado assim mesmo. O perfil fica com
-- forma de pagamento válida, cobrável, e completamente invisível na tela.
--
-- Foi o que aconteceu com a corrida `f28f2887-b24c-4123-bf70-e031e07310c9`
-- (Jennifer Newton, $30.17): método `pm_1U6YoaCgSu88OSlV4eBBmGGI`, `type:
-- 'link'`, anexado ao cliente certo, definido como padrão. A tela dizia que ela
-- não tinha forma de pagamento; a corrida rodou e concluiu sem cobrar.
--
-- Que o problema era de EXIBIÇÃO, e não de cobrança, foi provado depois:
-- `off_session: true` naquele mesmo método pagou a corrida sem reclamar
-- (PaymentIntent `pi_3U6wAOCgSu88OSlV1YssXOqx`). Link é cobrável neste projeto.
-- Restringir o cadastro a cartão teria escondido isto; estas duas colunas
-- consertam.
--
-- ── POR QUE DUAS COLUNAS, E NÃO REUSAR `card_brand` ─────────────────────────
--
-- Gravar `card_brand = 'link'` resolveria a tela e criaria uma coluna que mente
-- pelo nome. Quem ler `card_brand` daqui a um ano vai supor cartão, como todo
-- mundo supôs até agora — foi exatamente essa suposição que produziu o defeito.
--
--   · `payment_method_type`  — o `type` cru do Stripe: 'card', 'link', …
--   · `payment_method_label` — o que a tela mostra: "visa •••• 4242" ou
--                              "Link · alguem@exemplo.com"
--
-- ── COMPATIBILIDADE ────────────────────────────────────────────────────────
--
-- Aditiva e sem `not null`. `card_brand`/`card_last4` continuam sendo gravados
-- pelo webhook exatamente como antes, porque a build do app que está em campo
-- lê essas colunas e não conhece estas. Nada quebra ao aplicar, e nada quebra
-- se o app novo demorar a sair.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists payment_method_type  text,
  add column if not exists payment_method_label text;

comment on column public.profiles.payment_method_type is
  'Tipo do método salvo, como o Stripe o chama: ''card'', ''link'', … Nulo em perfil antigo, gravado desde a 0078. Existe porque `card_brand` fica NULL para tudo que não é cartão, e o perfil ficava com método válido e invisível — ver corrida f28f2887.';

comment on column public.profiles.payment_method_label is
  'Texto pronto para a tela: "visa •••• 4242" ou "Link · email". Gravado pelo stripe-webhook e pelo remove-card. Nulo em perfil antigo — a tela cai de volta em card_brand/card_last4.';

-- Preenche o que dá para preencher sem consultar o Stripe: todo perfil que já
-- tem marca de cartão gravada é, por definição, cartão. Os demais ficam nulos
-- de propósito — inventar 'link' para eles seria adivinhar, e há 24 perfis cujo
-- método sequer existe nesta conta Stripe (ids de outro ambiente). O tipo real
-- deles só se descobre consultando o Stripe, um a um, e isso é trabalho de
-- script, não de migration.
--
-- ── O QUE ESTE `update` ACERTOU MENOS DO QUE PARECE ─────────────────────────
--
-- Rodado em produção em 2026-08-21, ele marcou **22** perfis como 'card'. O
-- levantamento contra o Stripe, feito no mesmo dia, encontrou **5** cartões de
-- verdade: os outros 17 têm `card_brand` preenchido para um método que é `link`
-- ou que nem existe nesta conta (`resource_missing`).
--
-- Ou seja: a premissa "tem marca de cartão, logo é cartão" é FALSA neste banco,
-- porque `card_brand` é cache velho e ninguém o invalidou quando o método
-- mudou. O `update` não piorou nada — o app já lia essa mesma coluna e já
-- mostrava "Visa •••• 4242" para essas pessoas —, mas congelou o dado velho
-- numa coluna cujo propósito era parar de adivinhar.
--
-- O acerto de verdade exige consultar o Stripe perfil a perfil e é write em
-- produção, então mora num script com ensaio e backup, não aqui. Enquanto ele
-- não rodar, `payment_method_type = 'card'` significa "o banco acha que é
-- cartão", não "é cartão".
update public.profiles
   set payment_method_type  = 'card',
       payment_method_label = card_brand || ' •••• ' || card_last4
 where payment_method_type is null
   and card_brand  is not null
   and card_last4  is not null;

do $$
declare
  v_faltando text;
begin
  select string_agg(c, ', ') into v_faltando
    from unnest(array['payment_method_type', 'payment_method_label']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = c
   );

  if v_faltando is not null then
    raise exception '0078 incompleta: coluna ausente: %', v_faltando;
  end if;
end $$;
