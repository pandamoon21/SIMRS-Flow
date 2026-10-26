/**
 * Review automation rules — pure, unit-testable. Decides which waiting gates a
 * configured operator lets the system auto-approve or auto-reject, and how a
 * gate's nominal maps to a low/medium/high risk band.
 *
 * Writes are still backend-gated: this module only decides *intent*. The Review
 * UI executes an auto-decision by calling the same approve/reject endpoints an
 * operator would, and always records it in the audit ledger.
 */

export type RiskBand = 'low' | 'medium' | 'high';
export type GateDecision = 'auto-approve' | 'auto-reject' | 'manual';

export interface ReviewSettings {
  /** Auto-approve gates classified low-risk whose preconditions pass. */
  autoApproveLow: boolean;
  /** Auto-reject gates whose preconditions failed the re-check. */
  autoRejectOnFail: boolean;
  /** Nominal (rupiah) at or below which a gate is low-risk. */
  riskLowMax: number;
  /** Nominal (rupiah) at or above which a gate is high-risk. */
  riskHighMin: number;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  autoApproveLow: false,
  autoRejectOnFail: true,
  riskLowMax: 1_000_000,
  riskHighMin: 5_000_000,
};

const SETTINGS_KEY = 'simrs-flow.review-rules';

export function loadReviewSettings(): ReviewSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_REVIEW_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_REVIEW_SETTINGS };
    return { ...DEFAULT_REVIEW_SETTINGS, ...(JSON.parse(raw) as Partial<ReviewSettings>) };
  } catch {
    return { ...DEFAULT_REVIEW_SETTINGS };
  }
}

export function saveReviewSettings(settings: ReviewSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage full / disabled — ignore */
  }
}

/** Classify a gate by nominal against the configured thresholds. */
export function classifyRisk(nominal: number, settings: ReviewSettings): RiskBand {
  if (nominal <= settings.riskLowMax) return 'low';
  if (nominal >= settings.riskHighMin) return 'high';
  return 'medium';
}

/** A gate reduced to just what the decision needs. */
export interface GateFacts {
  /** Nominal rupiah of the proposed mutation; undefined when not extractable. */
  nominal?: number;
  /** Declared risk when a nominal is not available. */
  declaredRisk?: RiskBand;
  /** true = all preconditions held, false = at least one failed, undefined = unchecked. */
  preconditionsOk?: boolean;
  /** Whether the mutation itself demands an operator (critical gates never auto). */
  requiresApproval: boolean;
}

export function riskOf(facts: GateFacts, settings: ReviewSettings): RiskBand {
  if (typeof facts.nominal === 'number') return classifyRisk(facts.nominal, settings);
  return facts.declaredRisk ?? 'high';
}

export function decideGate(facts: GateFacts, settings: ReviewSettings): GateDecision {
  if (settings.autoRejectOnFail && facts.preconditionsOk === false) return 'auto-reject';
  const risk = riskOf(facts, settings);
  if (settings.autoApproveLow && risk === 'low' && facts.preconditionsOk === true) return 'auto-approve';
  return 'manual';
}
