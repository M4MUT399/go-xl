-- ═════════════════════════════════════════════════════════════════════════════
-- 0086 — quando a posição do motorista foi publicada
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── O CASO ─────────────────────────────────────────────────────────────────
--
-- 26/09/2026. O motorista Fabricio: "eu chego na localização e o GPS no
-- passageiro fala que eu tô 5 milhas de distância". No mesmo dia o passageiro
-- Jeff escreveu a ele: "it is saying you are going to be really late?? Like
-- 11:30. My plane boards at 12:30." O motorista chegaria 11:03.
--
-- A causa primária é de publicação e se resolve por flag: quem escreve
-- `driver_lat/lng/eta` é um efeito da `DriverNavigateScreen`, que só roda em
-- primeiro plano — e o motorista navega pelo Waze, deixando o app atrás.
--
-- Esta migração é do SEGUNDO defeito, que nenhuma flag conserta: quando a
-- publicação para, a tela do passageiro segue mostrando o último número COM
-- TOTAL CONFIANÇA. Ela só marca dado velho quando a CONSULTA FALHA — uma linha
-- congelada lida com sucesso passa por atual. A tela não tem como distinguir
-- "o motorista está parado no semáforo" de "o motorista parou de publicar há
-- seis minutos", e as duas coisas pedem reações opostas de quem espera na
-- calçada.
--
-- É o item P1 nº 4 da AUDITORIA.md, que estava aberto aguardando exatamente
-- esta coluna. Ele saiu de "ETA velha apresentada como fresca" para "voo quase
-- perdido" em sete semanas.
--
-- ── POR QUE UMA COLUNA, E NÃO `updated_at` ─────────────────────────────────
--
-- `rides` é tocada por muita coisa que não é telemetria: o repasse grava
-- `payout_id`, a cobrança grava `paid`, o recibo grava `receipt_sent_at`.
-- Qualquer uma dessas renovaria um `updated_at` e faria uma posição de seis
-- minutos atrás parecer recém-publicada — exatamente a mentira que esta coluna
-- existe para desfazer. O carimbo tem que ser DA PUBLICAÇÃO, e de mais nada.
--
-- ── COMPATIBILIDADE ────────────────────────────────────────────────────────
--
-- Aditiva e nula por padrão. Motorista com build anterior não grava a coluna, e
-- aí o app do passageiro cai numa inferência pela posição que não muda (ver
-- `src/lib/telemetryFreshness.ts`). Nada quebra ao aplicar, e nada quebra se a
-- build nova demorar a sair.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

alter table public.rides
  add column if not exists driver_telemetry_at timestamptz;

comment on column public.rides.driver_telemetry_at is
  'Instante em que o motorista publicou driver_lat/lng/eta. Nulo = build antiga do motorista. É o que permite ao app do passageiro saber que o ETA na tela envelheceu — ver src/lib/telemetryFreshness.ts.';
