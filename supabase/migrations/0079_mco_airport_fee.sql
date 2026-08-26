-- ═════════════════════════════════════════════════════════════════════════════
-- 0079 — a taxa de $7 do MCO passa a aparecer no preço, ANTES do pedido
-- ═════════════════════════════════════════════════════════════════════════════
--
-- O mecanismo já existia inteiro desde a P6 (0029 + 0030 + src/lib/airportFees.ts).
-- O que faltava era o DADO: a 0030 semeou `airport_port_fees` como lista VAZIA,
-- de propósito, e nenhuma zona jamais foi cadastrada. Resultado: o código rodava,
-- devolvia 0, e a taxa que o aeroporto cobra saía inteira do bolso da GoXL.
--
-- Esta migração cadastra a zona do MCO. Não há mudança de schema e não há
-- mudança de código.
--
-- ── POR QUE ISSO VALE PARA O APP QUE JÁ ESTÁ NA LOJA ───────────────────────
--
-- A leitura da config e a soma no preço estão no HEAD e na build 1.0.5 que está
-- em campo:
--
--   src/screens/passenger/RequestRideScreen.tsx  displayTotal = preço + toll + venueFee
--   src/hooks/useRide.ts (requestRide)           price = fare + toll + venueFee
--   src/hooks/useRide.ts (applyDriverSplit)      fare = price - toll - venueFee
--
-- Ou seja: basta esta linha de config para a taxa aparecer na tela de pedido e
-- entrar na corrida. NÃO depende do lote 0064–0077, nem de deploy de função,
-- nem de build nova. O cache de `systemConfig` é de 60 s, então o efeito começa
-- no minuto seguinte.
--
-- ── PICKUP $7, DROPOFF $0 — E POR QUE NÃO É SIMETRIA POR DESCUIDO ──────────
--
-- A GOAA cobra a TNC por EMBARQUE no aeroporto: US$ 5,80 → 6,35 (ago/2023) →
-- 7,00 (out/2023). Não há cobrança no desembarque: a lei da Flórida veda cobrar
-- as duas pontas da mesma viagem, e o desembarque no MCO usa o meio-fio comum
-- do nível de partidas, sem taxa.
--
-- Portanto `dropoffFee` fica em 0 porque NÃO HÁ taxa a repassar, não porque
-- ficou faltando. Se a GOAA passar a cobrar o desembarque, é trocar esse único
-- número — o cálculo, a UI e o split já tratam as duas pontas (a
-- `computeAirportFees` avalia pickup e dropoff de forma independente).
--
-- ── A GEOMETRIA, E O QUE ELA TEM DE INCERTO ────────────────────────────────
--
-- Uma zona só, circular, centrada entre os dois complexos de terminal:
--
--   Terminal A/B (ponto de referência do aeroporto)  0,85 km do centro
--   Terminal C (estimado)                            0,85 km do centro
--   Hyatt Regency (dentro do terminal)               0,88 km  → dentro, correto
--   Marriott Lakeside (7499 Augusta National, FORA)  2,80 km  → fora, correto
--
-- O raio de 2,2 km foi escolhido DENTRO de uma janela, não por gosto:
--
--   · piso  ~1,7 km — a posição mais ao sul que o Terminal C poderia ocupar
--                     segundo as fontes que consultei;
--   · teto  ~2,8 km — o endereço fora do aeroporto mais próximo que consegui
--                     localizar.
--
-- 2,2 km fica com folga nas duas pontas. NÃO consegui coordenada oficial do
-- meio-fio de embarque do Terminal C — as fontes públicas descrevem "nível 4"
-- ou "nível 6" sem georreferência. Este é o número a calibrar quando houver
-- corrida real: se aparecer embarque no MCO sem a taxa, o raio é curto demais;
-- se aparecer taxa em endereço que não é o aeroporto, é largo demais.
--
-- UMA zona só, e não uma por terminal, por um motivo de dinheiro:
-- `computeAirportFees` SOMA todas as zonas aplicáveis. Dois círculos que se
-- sobreponham cobrariam $14 de quem estivesse na interseção.
--
-- ── LIMITES QUE JÁ ESTÃO NO CAMINHO (nada a fazer, só registro) ────────────
--
-- A 0065 (ainda não aplicada) limita `airport_port_fee` a
-- least(floor(price*60)/100, 120). A corrida MCO mais barata possível tem
-- price = 13,09 (piso GoXL) + 7,00 = 20,09, e floor(20,09*60)/100 = 12,05 —
-- os $7 passam com folga. Não há conflito entre esta migração e aquele guard.
--
-- No split, a taxa é regulatória: fica INTEIRA com a plataforma, que a repassa
-- à GOAA. A comissão do motorista incide só sobre `price - toll - venueFee`,
-- então o repasse dele não muda por causa desta migração.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_zona   jsonb;
  v_linhas int;
  v_total  numeric;
begin
  if not exists (
    select 1 from public.system_config
     where key = 'airport_port_fees' and jurisdiction = 'global'
  ) then
    raise exception '0079: a linha airport_port_fees/global não existe — aplique a 0030 antes';
  end if;

  v_zona := jsonb_build_object(
    'id',         'mco',
    'name',       'Orlando Intl (MCO)',
    'lat',        28.4230,
    'lng',        -81.3041,
    'radiusKm',   2.2,
    'pickupFee',  7.00,
    'dropoffFee', 0
  );

  -- Idempotente e não-destrutivo: tira um 'mco' anterior (se houver) e recoloca
  -- o atual, PRESERVANDO qualquer outra zona já cadastrada. Um `set value =
  -- '[...]'` cru apagaria zonas que o admin tivesse criado à mão.
  update public.system_config
     set value = coalesce(
           (select jsonb_agg(z)
              from jsonb_array_elements(public.system_config.value) z
             where z->>'id' is distinct from 'mco'),
           '[]'::jsonb
         ) || jsonb_build_array(v_zona),
         updated_at = now()
   where key = 'airport_port_fees'
     and jurisdiction = 'global';
end $$;

-- A zona mora em 'global', e não em 'US-FL', de propósito: quem chama
-- `estimateAirportFees` (RequestRideScreen e useRide) NÃO passa jurisdição, e o
-- default é 'global' — uma zona em 'US-FL' seria cadastrada e nunca lida. Não há
-- perda de precisão nisso: o geofence JÁ É o filtro geográfico. Um círculo de
-- 2,2 km sobre o MCO não dispara em lugar nenhum fora de Orlando.

do $$
declare
  v_mco jsonb;
begin
  select z into v_mco
    from public.system_config c,
         lateral jsonb_array_elements(c.value) z
   where c.key = 'airport_port_fees'
     and c.jurisdiction = 'global'
     and z->>'id' = 'mco';

  if v_mco is null then
    raise exception '0079 incompleta: a zona mco não ficou gravada';
  end if;
  if (v_mco->>'pickupFee')::numeric <> 7.00 then
    raise exception '0079 incompleta: pickupFee gravado como %, esperado 7.00', v_mco->>'pickupFee';
  end if;
  if (v_mco->>'radiusKm')::numeric <> 2.2 then
    raise exception '0079 incompleta: radiusKm gravado como %, esperado 2.2', v_mco->>'radiusKm';
  end if;

  -- Duas zonas com o mesmo id somariam a taxa duas vezes na interseção.
  if (select count(*)
        from public.system_config c, lateral jsonb_array_elements(c.value) z
       where c.key = 'airport_port_fees' and c.jurisdiction = 'global'
         and z->>'id' = 'mco') <> 1 then
    raise exception '0079 incompleta: mais de uma zona com id=mco';
  end if;
end $$;
