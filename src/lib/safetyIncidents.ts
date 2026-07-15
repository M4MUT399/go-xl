// safetyIncidents — classifica denúncias de segurança contra motoristas e
// decide quando uma denúncia exige SUSPENSÃO IMEDIATA (política de tolerância
// zero), no lugar do fluxo normal de revisão administrativa (Bloco 4,
// compliance TNC F.S. 627.748).
//
// AMBIGUIDADE DOCUMENTADA (mesma regra do Bloco 3: "documente e pergunte antes
// de mudar regra de negócio" — aqui não há regra anterior, mas o estatuto não
// lista as categorias): a F.S. 627.748 exige explicitamente uma "política de
// tolerância zero quanto ao uso de álcool/drogas" pelo motorista durante a
// prestação do serviço — esse é o núcleo estatutário certo
// (`driver_intoxication`). As categorias adicionais abaixo (agressão sexual,
// agressão física, porte de arma) são uma EXTENSÃO por analogia, no padrão
// usual do setor de TNC (Uber/Lyft tratam essas categorias como tolerância
// zero também) — não são uma citação direta do estatuto. Precisa de revisão
// jurídica/compliance antes de habilitar em produção
// (`safety_reports_v1_enabled`, default OFF). A lista pode ser ajustada sem
// redeploy? NÃO nesta versão — ao contrário dos limiares de desqualificação
// (Bloco 3), aqui a classificação é fixa no código porque é uma lista curta e
// binária (é ou não é tolerância zero), não um limiar numérico configurável.
// Se precisar variar por jurisdição no futuro, mover para system_config.
//
// PRINCÍPIO DE PRIVACIDADE (mesmo de disqualificationRules.ts): a descrição
// livre da denúncia (texto do passageiro/motorista) NUNCA entra nesta função —
// ela só recebe a `category` categorizada. O texto livre fica armazenado em
// `driver_safety_reports.description`, visível só para admin/compliance
// (RLS), nunca processado por regra automática.

/** Categorias de denúncia de segurança suportadas. */
export type SafetyIncidentCategory =
  // ── Tolerância zero — suspende o motorista IMEDIATAMENTE ao ser registrada. ──
  | 'driver_intoxication'
  | 'sexual_assault'
  | 'physical_assault'
  | 'weapon_possession'
  // ── Revisão normal — entra na fila de compliance, sem suspensão automática. ──
  | 'discrimination'
  | 'reckless_driving'
  | 'vehicle_mismatch'
  | 'unsafe_vehicle'
  | 'other';

export const SAFETY_INCIDENT_CATEGORIES: readonly SafetyIncidentCategory[] = [
  'driver_intoxication',
  'sexual_assault',
  'physical_assault',
  'weapon_possession',
  'discrimination',
  'reckless_driving',
  'vehicle_mismatch',
  'unsafe_vehicle',
  'other',
];

/** Ver "AMBIGUIDADE DOCUMENTADA" no topo do arquivo. */
export const ZERO_TOLERANCE_CATEGORIES: ReadonlySet<SafetyIncidentCategory> = new Set([
  'driver_intoxication',
  'sexual_assault',
  'physical_assault',
  'weapon_possession',
]);

/** A categoria exige suspensão imediata (antes de qualquer revisão humana)? */
export function isZeroToleranceCategory(category: SafetyIncidentCategory): boolean {
  return ZERO_TOLERANCE_CATEGORIES.has(category);
}

/**
 * buildSuspensionReason — código de motivo persistido em
 * `driver_suspensions.reason` quando a denúncia dispara suspensão automática.
 * Prefixo fixo `zero_tolerance_report:` facilita filtrar no admin/auditoria
 * sem precisar fazer join com a denúncia original.
 */
export function buildSuspensionReason(category: SafetyIncidentCategory): string {
  return `zero_tolerance_report:${category}`;
}

/** Uma linha da tabela `driver_suspensions` (campos mínimos para a regra pura). */
export type SuspensionRecord = {
  id: string;
  driverId: string;
  reason: string;
  suspendedAt: string;
  liftedAt?: string | null;
};

export type ActiveSuspensionResult = {
  suspended: boolean;
  /** Todas as suspensões ainda ativas (não levantadas) — audit/admin. */
  activeSuspensionIds: string[];
};

/**
 * hasActiveSuspension — o motorista tem QUALQUER suspensão ainda não
 * levantada (`liftedAt` nulo)? Pura: não há expiração automática por tempo —
 * uma suspensão de tolerância zero só sai por revisão administrativa
 * explícita (`admin_lift_driver_suspension`, migration do Bloco 4).
 */
export function hasActiveSuspension(suspensions: readonly SuspensionRecord[]): ActiveSuspensionResult {
  const active = suspensions.filter((s) => !s.liftedAt);
  return { suspended: active.length > 0, activeSuspensionIds: active.map((s) => s.id) };
}

export type LiftSuspensionCheck = { ok: boolean; error?: 'already_lifted' };

/**
 * canLiftSuspension — guarda de idempotência: um admin não deve conseguir
 * "levantar" uma suspensão que já foi levantada (evita sobrescrever
 * `liftedAt`/`liftedBy` de uma decisão anterior por engano/corrida).
 */
export function canLiftSuspension(suspension: SuspensionRecord): LiftSuspensionCheck {
  if (suspension.liftedAt) return { ok: false, error: 'already_lifted' };
  return { ok: true };
}
