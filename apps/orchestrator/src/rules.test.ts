import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@simrs-flow/audit-ledger';
import { RANAP_HAPPY_INPUT } from '@simrs-flow/test-fixtures';
import { buildServer } from './server.js';
import { DEFAULT_RULE_VALUES, RuleStore, applyRules, validateRuleValues, type RuleValues } from './rules.js';

const values = (patch: (v: RuleValues) => void): RuleValues => {
  const v = structuredClone(DEFAULT_RULE_VALUES);
  patch(v);
  return v;
};

describe('rule values', () => {
  it('defaults equal the legacy constants the executors fall back to', () => {
    expect(DEFAULT_RULE_VALUES.ranap).toEqual({ bankDarahUnits: ['BANK DARAH'], cathlabUnits: ['CATHLAB'], ibsManualReviewRooms: ['AL AFIYAT'] });
    expect(DEFAULT_RULE_VALUES.rajal).toEqual({ treatmentGroups: [], skipTreatments: [], paymentConfig: { shift: '1', type: '14', payerCode: '15' } });
  });

  it('normalizes lists and rejects malformed groups and unknown payment codes', () => {
    const ok = validateRuleValues(values((v) => {
      v.ranap.cathlabUnits = [' CATHLAB ', '', 'CATHLAB', 'KATETER'];
      v.rajal.treatmentGroups = [{ group: 'a', key: 'konsul', name: 'KONSULTASI' }];
    }));
    expect(ok.ranap.cathlabUnits).toEqual(['CATHLAB', 'KATETER']);
    expect(ok.rajal.treatmentGroups).toEqual([{ group: 'A', key: 'konsul', name: 'KONSULTASI' }]);

    const bad = (patch: (v: RuleValues) => void) => () => validateRuleValues(values(patch));
    expect(bad((v) => { v.rajal.treatmentGroups = [{ group: 'AB', key: 'k', name: 'n' }]; })).toThrow(/satu huruf/);
    expect(bad((v) => { v.rajal.treatmentGroups = [{ group: 'A', key: 'k', name: 'n' }, { group: 'B', key: 'k', name: 'm' }]; })).toThrow(/dua kali/);
    expect(bad((v) => { v.rajal.paymentConfig.type = '99'; })).toThrow(/type/);
    expect(bad((v) => { v.rajal.paymentConfig.payerCode = '1; DROP'; })).toThrow(/payerCode/);
    expect(() => validateRuleValues({ ranap: {}, rajal: {} })).toThrow();
  });

  it('fills run input as defaults; an explicit request field wins', () => {
    const v = values((x) => { x.rajal.skipTreatments = ['USG']; });
    expect(applyRules('rajal', { date: 'd', skipTreatments: undefined }, v)).toMatchObject({ date: 'd', skipTreatments: ['USG'] });
    expect(applyRules('rajal', { date: 'd', skipTreatments: ['EKG'] }, v)).toMatchObject({ skipTreatments: ['EKG'] });
    expect(applyRules('ranap', { noRm: 'x' }, v)).toMatchObject({ manualBlockerUnits: { bankDarah: ['BANK DARAH'], cathlab: ['CATHLAB'] }, ibsManualReviewRooms: ['AL AFIYAT'] });
  });
});

describe('RuleStore', () => {
  it('versions saves, refuses a stale base version, and persists with history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'simrs-rules-'));
    try {
      const store = new RuleStore(dir);
      expect(store.get().version).toBe(0);
      const saved = await store.save(values((v) => { v.ranap.bankDarahUnits = ['BANK DARAH', 'UTD']; }), 0, 'op-a');
      expect(saved).toMatchObject({ version: 1, updatedBy: 'op-a' });
      await expect(store.save(DEFAULT_RULE_VALUES, 0, 'op-b')).rejects.toMatchObject({ statusCode: 409 });

      expect(new RuleStore(dir).get().values.ranap.bankDarahUnits).toEqual(['BANK DARAH', 'UTD']);
      expect(readFileSync(join(dir, 'rules-history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);

      await store.save(DEFAULT_RULE_VALUES, 1, 'op-b');
      // History survives a restart and lists newest first.
      expect(new RuleStore(dir).history().map((set) => [set.version, set.updatedBy])).toEqual([[2, 'op-b'], [1, 'op-a']]);
      expect(store.history(1).map((set) => set.version)).toEqual([2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rules API', () => {
  const AUTH = { authorization: 'Bearer qa-token' };

  it('reads with auth, saves only with a bearer operator, and stamps runs with the version', async () => {
    const ledger = new MemoryLedger();
    const app = buildServer({ ledger, qaAuth: { token: 'qa-token', operator: 'qa-op' } });
    expect((await app.inject({ method: 'GET', url: '/api/rules' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/rules', payload: { baseVersion: 0, values: DEFAULT_RULE_VALUES } })).statusCode).toBe(401);

    const bad = await app.inject({ method: 'POST', url: '/api/rules', headers: AUTH, payload: { baseVersion: 0, values: {} } });
    expect(bad.statusCode).toBe(400);

    const saved = await app.inject({ method: 'POST', url: '/api/rules', headers: AUTH, payload: { baseVersion: 0, values: DEFAULT_RULE_VALUES } });
    expect(saved.json()).toMatchObject({ version: 1, updatedBy: 'qa-op' });
    expect((await app.inject({ method: 'GET', url: '/api/rules', headers: AUTH })).json().version).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/rules/history' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/rules/history?limit=5', headers: AUTH })).json().versions.map((v: { version: number }) => v.version)).toEqual([1]);

    const run = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: { workflowId: 'ranap-verifikasi-tampung-bayar', input: RANAP_HAPPY_INPUT } });
    const { runId } = run.json() as { runId: string };
    expect((await ledger.readHistory(runId))?.meta?.rulesVersion).toBe(1);
  });
});
