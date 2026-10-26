import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_SETTINGS,
  classifyRisk,
  decideGate,
  riskOf,
  type GateFacts,
  type ReviewSettings,
} from './reviewRules.js';

const base: ReviewSettings = { ...DEFAULT_REVIEW_SETTINGS };

describe('review rules', () => {
  it('bands nominal into low/medium/high against the configured thresholds', () => {
    expect(classifyRisk(0, base)).toBe('low');
    expect(classifyRisk(1_000_000, base)).toBe('low'); // boundary inclusive
    expect(classifyRisk(1_000_001, base)).toBe('medium');
    expect(classifyRisk(4_999_999, base)).toBe('medium');
    expect(classifyRisk(5_000_000, base)).toBe('high');
  });

  it('falls back to the declared risk when no nominal is extractable', () => {
    expect(riskOf({ nominal: undefined, declaredRisk: 'low', requiresApproval: true }, base)).toBe('low');
    expect(riskOf({ nominal: undefined, declaredRisk: undefined, requiresApproval: true }, base)).toBe('high'); // fail closed
    expect(riskOf({ nominal: 2_000_000, declaredRisk: 'low', requiresApproval: true }, base)).toBe('medium'); // nominal wins
  });

  it('never auto-decides unless a rule enables it', () => {
    const facts: GateFacts = { nominal: 500_000, preconditionsOk: true, requiresApproval: true };
    expect(decideGate(facts, base)).toBe('manual'); // autoApproveLow defaults off
  });

  it('auto-approves low-risk passing gates only when enabled', () => {
    const settings: ReviewSettings = { ...base, autoApproveLow: true };
    const facts: GateFacts = { nominal: 500_000, preconditionsOk: true, requiresApproval: true };
    expect(decideGate(facts, settings)).toBe('auto-approve');
    // a failing precheck is never auto-approved even when low-risk
    expect(decideGate({ ...facts, preconditionsOk: false }, settings)).toBe('auto-reject');
    // medium/high never auto-approve
    expect(decideGate({ ...facts, nominal: 2_000_000 }, settings)).toBe('manual');
  });

  it('auto-rejects on precondition fail and takes precedence over auto-approve', () => {
    const settings: ReviewSettings = { ...base, autoApproveLow: true };
    expect(decideGate({ nominal: 500_000, preconditionsOk: false, requiresApproval: true }, settings)).toBe('auto-reject');
    expect(decideGate({ nominal: 500_000, preconditionsOk: true, requiresApproval: true }, settings)).toBe('auto-approve');
    // unchecked preconditions are not a pass — fail closed, no auto-approve
    expect(decideGate({ nominal: 500_000, preconditionsOk: undefined, requiresApproval: true }, settings)).toBe('manual');
  });
});
