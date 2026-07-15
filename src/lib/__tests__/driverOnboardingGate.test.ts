import {
  evaluateOnboardingGate,
  isBackgroundCheckRecheckDue,
  type OnboardingGateInput,
} from '../driverOnboardingGate';
import { EMPTY_DISQUALIFICATION_FINDINGS, type DisqualificationFindings } from '../disqualificationRules';
import type { BackgroundCheckRecord } from '../backgroundCheck';

// Mocka o Supabase para não carregar módulos nativos ao importar backgroundCheck
// (que importa systemConfig → supabase) — mesmo padrão de backgroundCheck.test.ts.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

const NOW = new Date('2026-07-15T12:00:00.000Z');
const iso = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
const yearsAgoIso = (years: number) => {
  const d = new Date(NOW);
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
};

const clearRecord: BackgroundCheckRecord = {
  provider: 'mock',
  providerRef: 'mock_d1',
  status: 'clear',
  checkedAt: iso(-30),
  expiresAt: iso(335),
};

const baseInput: OnboardingGateInput = {
  verificationStatus: 'approved',
  backgroundCheckRequired: false,
  backgroundCheckRecord: null,
  disqualificationFindings: null,
  backgroundCheckRecheckYears: 3,
  stripeChargesEnabled: true,
  stripePayoutsEnabled: true,
  disclosureRequired: false,
  disclosureAccepted: false,
  now: NOW,
};

describe('evaluateOnboardingGate — comportamento padrão (tudo desligado)', () => {
  it('todas as flags OFF + verificação aprovada + Stripe ok → permite ficar online', () => {
    const r = evaluateOnboardingGate(baseInput);
    expect(r).toEqual({ canGoOnline: true, reasons: [] });
  });
});

describe('evaluateOnboardingGate — verificação de identidade', () => {
  it('verification_status != approved → bloqueia com motivo específico', () => {
    const r = evaluateOnboardingGate({ ...baseInput, verificationStatus: 'pending' });
    expect(r.canGoOnline).toBe(false);
    expect(r.reasons).toContain('verification_pending');
  });

  it('verification_status null/undefined → bloqueia', () => {
    expect(evaluateOnboardingGate({ ...baseInput, verificationStatus: null }).canGoOnline).toBe(false);
    expect(evaluateOnboardingGate({ ...baseInput, verificationStatus: undefined }).canGoOnline).toBe(false);
  });
});

describe('evaluateOnboardingGate — Stripe Connect', () => {
  it('charges ou payouts desabilitados → bloqueia', () => {
    expect(evaluateOnboardingGate({ ...baseInput, stripeChargesEnabled: false }).reasons).toContain('payout_setup_incomplete');
    expect(evaluateOnboardingGate({ ...baseInput, stripePayoutsEnabled: false }).reasons).toContain('payout_setup_incomplete');
  });
});

describe('evaluateOnboardingGate — background check (quando required=true)', () => {
  it('required=false → gate de bg check nunca bloqueia, mesmo sem registro', () => {
    const r = evaluateOnboardingGate({ ...baseInput, backgroundCheckRequired: false, backgroundCheckRecord: null });
    expect(r.reasons).not.toContain('background_check_required');
  });

  it('required=true + sem registro → bloqueia', () => {
    const r = evaluateOnboardingGate({ ...baseInput, backgroundCheckRequired: true, backgroundCheckRecord: null });
    expect(r.reasons).toContain('background_check_required');
  });

  it('required=true + registro clear e válido → não bloqueia por esse motivo', () => {
    const r = evaluateOnboardingGate({ ...baseInput, backgroundCheckRequired: true, backgroundCheckRecord: clearRecord });
    expect(r.reasons).not.toContain('background_check_required');
    expect(r.canGoOnline).toBe(true);
  });

  it('required=true + registro expirado → bloqueia', () => {
    const expired: BackgroundCheckRecord = { ...clearRecord, expiresAt: iso(-1) };
    const r = evaluateOnboardingGate({ ...baseInput, backgroundCheckRequired: true, backgroundCheckRecord: expired });
    expect(r.reasons).toContain('background_check_required');
  });
});

describe('evaluateOnboardingGate — desqualificação', () => {
  it('achado desqualificante + required=true → bloqueia com motivo específico', () => {
    const findings: DisqualificationFindings = { ...EMPTY_DISQUALIFICATION_FINDINGS, violentCrimeConviction: true };
    const r = evaluateOnboardingGate({
      ...baseInput,
      backgroundCheckRequired: true,
      backgroundCheckRecord: clearRecord,
      disqualificationFindings: findings,
    });
    expect(r.reasons).toContain('background_check_disqualified');
  });

  it('required=false → desqualificação é ignorada mesmo se findings presentes', () => {
    const findings: DisqualificationFindings = { ...EMPTY_DISQUALIFICATION_FINDINGS, violentCrimeConviction: true };
    const r = evaluateOnboardingGate({
      ...baseInput,
      backgroundCheckRequired: false,
      disqualificationFindings: findings,
    });
    expect(r.reasons).not.toContain('background_check_disqualified');
  });

  it('findings null → não avalia desqualificação (sem apuração ainda)', () => {
    const r = evaluateOnboardingGate({
      ...baseInput,
      backgroundCheckRequired: true,
      backgroundCheckRecord: clearRecord,
      disqualificationFindings: null,
    });
    expect(r.reasons).not.toContain('background_check_disqualified');
  });
});

describe('evaluateOnboardingGate — veredito já persistido (backgroundCheckDisqualified)', () => {
  it('backgroundCheckDisqualified=true → bloqueia sem precisar de findings (app do motorista só lê o veredito)', () => {
    const r = evaluateOnboardingGate({
      ...baseInput,
      backgroundCheckRequired: true,
      backgroundCheckRecord: clearRecord,
      disqualificationFindings: null,
      backgroundCheckDisqualified: true,
    });
    expect(r.reasons).toContain('background_check_disqualified');
    expect(r.canGoOnline).toBe(false);
  });

  it('backgroundCheckDisqualified=false → não bloqueia, mesmo com findings desqualificantes presentes (veredito persistido tem prioridade)', () => {
    const findings: DisqualificationFindings = { ...EMPTY_DISQUALIFICATION_FINDINGS, violentCrimeConviction: true };
    const r = evaluateOnboardingGate({
      ...baseInput,
      backgroundCheckRequired: true,
      backgroundCheckRecord: clearRecord,
      disqualificationFindings: findings,
      backgroundCheckDisqualified: false,
    });
    expect(r.reasons).not.toContain('background_check_disqualified');
  });

  it('backgroundCheckDisqualified undefined → cai de volta para a avaliação por findings (comportamento pré-existente)', () => {
    const findings: DisqualificationFindings = { ...EMPTY_DISQUALIFICATION_FINDINGS, violentCrimeConviction: true };
    const r = evaluateOnboardingGate({
      ...baseInput,
      backgroundCheckRequired: true,
      backgroundCheckRecord: clearRecord,
      disqualificationFindings: findings,
    });
    expect(r.reasons).toContain('background_check_disqualified');
  });
});

describe('evaluateOnboardingGate — recheck trienal (independente da validade operacional)', () => {
  it('check checado há mais de recheckYears, mas ainda dentro da validade operacional (expiresAt futuro) → recheck devido', () => {
    const longValidity: BackgroundCheckRecord = {
      ...clearRecord,
      checkedAt: yearsAgoIso(4),
      expiresAt: iso(3650), // validade operacional bem longa, não vence tão cedo
    };
    const r = evaluateOnboardingGate({
      ...baseInput,
      backgroundCheckRequired: true,
      backgroundCheckRecord: longValidity,
      backgroundCheckRecheckYears: 3,
    });
    expect(r.reasons).toContain('background_check_recheck_due');
    expect(r.reasons).not.toContain('background_check_required'); // ainda válido operacionalmente
  });

  it('check dentro dos 3 anos → recheck não devido', () => {
    const recent: BackgroundCheckRecord = { ...clearRecord, checkedAt: yearsAgoIso(1) };
    const r = evaluateOnboardingGate({
      ...baseInput,
      backgroundCheckRequired: true,
      backgroundCheckRecord: recent,
      backgroundCheckRecheckYears: 3,
    });
    expect(r.reasons).not.toContain('background_check_recheck_due');
  });
});

describe('isBackgroundCheckRecheckDue', () => {
  it('sem checkedAt → não devido (é "nunca feito", não "atrasado")', () => {
    expect(isBackgroundCheckRecheckDue(null, 3, NOW)).toBe(false);
    expect(isBackgroundCheckRecheckDue({ ...clearRecord, checkedAt: null }, 3, NOW)).toBe(false);
  });

  it('checkedAt exatamente no limite (N anos atrás) → devido (< estrito no cutoff)', () => {
    expect(isBackgroundCheckRecheckDue({ ...clearRecord, checkedAt: yearsAgoIso(3) }, 3, NOW)).toBe(false);
    expect(isBackgroundCheckRecheckDue({ ...clearRecord, checkedAt: yearsAgoIso(3.01) }, 3, NOW)).toBe(true);
  });

  it('data inválida → não devido (não quebra)', () => {
    expect(isBackgroundCheckRecheckDue({ ...clearRecord, checkedAt: 'not-a-date' }, 3, NOW)).toBe(false);
  });
});

describe('evaluateOnboardingGate — disclosure legal', () => {
  it('disclosureRequired=true + não aceito → bloqueia', () => {
    const r = evaluateOnboardingGate({ ...baseInput, disclosureRequired: true, disclosureAccepted: false });
    expect(r.reasons).toContain('disclosure_not_accepted');
  });

  it('disclosureRequired=true + aceito → não bloqueia por esse motivo', () => {
    const r = evaluateOnboardingGate({ ...baseInput, disclosureRequired: true, disclosureAccepted: true });
    expect(r.reasons).not.toContain('disclosure_not_accepted');
  });
});

describe('evaluateOnboardingGate — acumula múltiplos motivos', () => {
  it('vários gates falhando ao mesmo tempo → todos os motivos aparecem', () => {
    const r = evaluateOnboardingGate({
      ...baseInput,
      verificationStatus: 'pending',
      stripeChargesEnabled: false,
      disclosureRequired: true,
      disclosureAccepted: false,
      backgroundCheckRequired: true,
      backgroundCheckRecord: null,
    });
    expect(r.canGoOnline).toBe(false);
    expect(r.reasons.sort()).toEqual(
      ['verification_pending', 'payout_setup_incomplete', 'disclosure_not_accepted', 'background_check_required'].sort()
    );
  });
});
