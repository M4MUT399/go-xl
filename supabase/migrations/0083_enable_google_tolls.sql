-- ═════════════════════════════════════════════════════════════════════════════
-- 0083 — o pedágio passa a ser cobrado de verdade (provider Google)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── O QUE ESTAVA ACONTECENDO ───────────────────────────────────────────────
--
-- Desde a P5 (migration 0022) existiam as flags `tolls_enabled` e
-- `toll_provider`, e desde a 4481401 existia o mecanismo. Mas `tolls_enabled`
-- nasceu `false` e nunca foi ligada, e `toll_provider` ficou em `'mock'` com
-- `mock_toll_flat = 0` e `mock_toll_per_km = 0`.
--
-- Resultado: a GoXL nunca cobrou pedágio. E quem pagava a conta era o
-- MOTORISTA — pedágio é repasse integral a ele (src/lib/split.ts), e repasse de
-- zero é zero. Em Orlando isso não é detalhe: a Beachline (SR-528) até o MCO é
-- pedagiada, e um extrato semanal real de motorista mostrou US$ 103,02 em
-- pedágios saindo do bolso dele.
--
-- ── O QUE FOI MEDIDO ANTES DE LIGAR ────────────────────────────────────────
--
-- 04/09/2026, caminho completo (usuário autenticado → Edge Function
-- `toll-quote` → Routes API), rota MCO → College Park, a mesma corrida real de
-- um passageiro:
--
--     ✅ US$ 2,76  em 27,0 km
--
-- Antes disso, no mesmo dia: Routes API habilitada no projeto
-- `leafy-grammar-498713-v3`, chave `GoXL - Routes (server)` criada e restrita
-- SÓ à Routes API, segredo `GOOGLE_ROUTES_API_KEY` gravado, função implantada.
-- O script que fez a medição é supabase/scripts/testa_pedagio_mco.ts.
--
-- ── POR QUE ISTO NÃO QUEBRA QUEM ESTÁ COM APP VELHO ────────────────────────
--
-- O `GoogleTollProvider` só foi implementado em 0e756c6 (27/08). Apps
-- anteriores têm um stub que LANÇA. Isso foi verificado no código publicado, e
-- não quebra: `estimateTollAmount` embrulha tudo num try/catch que devolve
-- ZERO (ver o corpo da função na 1.0.5). Então:
--
--   • Android produção (1.0.7, de fdde08e, posterior)  → pedágio real
--   • iOS App Store (1.0.5, de 17/08, anterior)        → pedágio 0, calado,
--                                                        exatamente como hoje
--   • builds futuras                                    → pedágio real
--
-- Nenhum app quebra; os antigos apenas continuam sem cobrar, como já era.
--
-- ── CUSTO ──────────────────────────────────────────────────────────────────
--
-- Pedir `tollInfo` no FieldMask cobra na faixa Routes Preferred: US$ 15 por mil
-- chamadas. A tela de pedido reestima a cada mudança de destino, e por isso o
-- cliente faz cache (src/lib/tolls.ts). Ligar isto começa a gerar essa conta.
--
-- ── COMO DESLIGAR ──────────────────────────────────────────────────────────
--
--   update public.system_config
--      set value = 'false'::jsonb
--    where key = 'tolls_enabled' and jurisdiction = 'global';
--
-- Basta isso: com a flag desligada, `estimateTollAmount` devolve zero antes de
-- olhar o provider. Não precisa reverter esta migração nem reimplantar nada.

-- `on conflict` porque a 0022 já semeou as duas chaves; aqui só se troca o valor.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values
  ('tolls_enabled', 'global', 'true'::jsonb,
   'Liga a cobrança de pedágio no preço. Ligada em 04/09/2026 após medição real de US$ 2,76 na rota MCO → College Park. Ver migration 0083.', true),
  ('toll_provider', 'global', '"google"'::jsonb,
   'Provider de pedágio. ''google'' usa a Edge Function toll-quote (Routes API). Apps anteriores a 27/08/2026 têm stub que lança e caem para 0 sem quebrar. Ver migration 0083.', true)
on conflict (key, jurisdiction) do update
  set value = excluded.value,
      description = excluded.description,
      is_public = excluded.is_public;

-- ─── Asserções ───────────────────────────────────────────────────────────────
do $$
declare
  v_ligado   jsonb;
  v_provider jsonb;
  v_flat     jsonb;
  v_perkm    jsonb;
begin
  select value into v_ligado
    from public.system_config where key = 'tolls_enabled' and jurisdiction = 'global';
  select value into v_provider
    from public.system_config where key = 'toll_provider' and jurisdiction = 'global';

  if v_ligado is null or v_provider is null then
    raise exception '0083 incompleta: alguma das duas chaves não ficou gravada';
  end if;

  -- Booleano jsonb de verdade, não a string "true": o cliente lê com
  -- `if (!enabled) return ZERO`, e a string "true" também seria truthy — mas o
  -- valor errado no banco viraria confusão na primeira vez que alguém
  -- consultasse a tabela à mão.
  if jsonb_typeof(v_ligado) <> 'boolean' or (v_ligado)::text <> 'true' then
    raise exception '0083 incompleta: tolls_enabled ficou como % (tipo %)',
      v_ligado::text, jsonb_typeof(v_ligado);
  end if;

  if v_provider #>> '{}' <> 'google' then
    raise exception '0083 incompleta: toll_provider ficou como %', v_provider::text;
  end if;

  -- O app precisa LER isto sem sessão de admin; sem is_public a flag não chega
  -- ao cliente e o pedágio continuaria zero, silenciosamente.
  if not exists (
    select 1 from public.system_config
     where key in ('tolls_enabled','toll_provider')
       and jurisdiction = 'global' and is_public
  ) then
    raise exception '0083 incompleta: as flags não são is_public — o app não as leria';
  end if;

  -- Rede de segurança: se por qualquer motivo o provider cair para o mock, o
  -- valor precisa ser ZERO, não um pedágio inventado em toda corrida.
  select value into v_flat  from public.system_config where key = 'mock_toll_flat'   and jurisdiction = 'global';
  select value into v_perkm from public.system_config where key = 'mock_toll_per_km' and jurisdiction = 'global';
  if coalesce((v_flat #>> '{}')::numeric, 0) <> 0
     or coalesce((v_perkm #>> '{}')::numeric, 0) <> 0 then
    raise exception '0083: os parâmetros do mock não estão zerados (flat=%, perKm=%) — cair no mock cobraria pedágio inventado',
      v_flat::text, v_perkm::text;
  end if;

  raise notice '0083: pedágio LIGADO com provider google. Medido US$ 2,76 em MCO → College Park.';
end $$;
