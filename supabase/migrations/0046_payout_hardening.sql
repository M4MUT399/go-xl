-- 0046_payout_hardening.sql
-- Endurecimento do fluxo de repasse (payout). NÃO cria tabela de ledger nova:
-- decisão do usuário foi "endurecer o modelo atual" (saldo = SUM das corridas
-- elegíveis). Aqui adicionamos apenas as GARANTIAS de banco que faltavam:
--
--   1) índice único parcial: no máximo UM payout ativo (pending/processing) por
--      motorista → guarda de concorrência contra repasse em dobro (dois toques
--      simultâneos, ou botão manual + cron semanal ao mesmo tempo);
--   2) índice de elegibilidade para a consulta quente de saldo do motorista.
--
-- Ordem no runbook: rode o reset_test_balances ANTES desta migração. Mesmo assim,
-- por segurança, o passo (0) colapsa qualquer duplicata ativa pré-existente para
-- que o índice único consiga ser criado sem erro.

-- ── 0) Defensivo: se o fluxo bugado deixou >1 payout ativo por motorista, mantém
--        o mais recente e marca os demais como 'failed', devolvendo as corridas
--        deles ao saldo (payout_id = NULL). Idempotente. ────────────────────────
UPDATE public.payouts p
SET status = 'failed',
    failure_reason = COALESCE(p.failure_reason, 'superseded_by_hardening_migration')
FROM (
  SELECT id,
         row_number() OVER (PARTITION BY driver_id ORDER BY requested_at DESC, id DESC) AS rn
  FROM public.payouts
  WHERE status IN ('pending', 'processing')
) ranked
WHERE p.id = ranked.id
  AND ranked.rn > 1;

UPDATE public.rides r
SET payout_id = NULL
FROM public.payouts p
WHERE r.payout_id = p.id
  AND p.status = 'failed'
  AND p.failure_reason = 'superseded_by_hardening_migration';

-- ── 1) UM payout ativo por motorista (a guarda de concorrência real) ──────────
CREATE UNIQUE INDEX IF NOT EXISTS payouts_one_active_per_driver_idx
  ON public.payouts (driver_id)
  WHERE status IN ('pending', 'processing');

-- ── 2) Consulta quente: corridas elegíveis (pagas, ainda não repassadas) ──────
CREATE INDEX IF NOT EXISTS rides_payout_eligible_idx
  ON public.rides (driver_id)
  WHERE paid = true AND payout_id IS NULL;
