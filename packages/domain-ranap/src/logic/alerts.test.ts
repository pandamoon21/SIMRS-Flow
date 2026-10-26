import { describe, it, expect } from 'vitest';

import { RunAlerts } from './alerts.js';

describe('RunAlerts registration', () => {
  it('ignores an empty reg and an empty message', () => {
    const alerts = new RunAlerts();
    alerts.registerRegAlert('', 'ERROR', 'hilang');
    alerts.registerRegAlert('R1', 'WARN', '   ');
    alerts.registerSyncIssue('', 'sync tindakan');
    expect(alerts.getRegAlerts('R1')).toEqual([]);
    expect(alerts.hasSyncIssues('')).toBe(false);
  });

  it('de-duplicates identical entries and keeps insertion order', () => {
    const alerts = new RunAlerts();
    alerts.registerRegAlert('R1', 'WARN', 'obat belum sinkron');
    alerts.registerRegAlert('R1', 'WARN', 'obat belum sinkron');
    alerts.registerRegAlert('R1', 'ERROR', 'IBS mismatch | depo');
    expect(alerts.getRegAlerts('R1')).toEqual([
      { level: 'WARN', message: 'obat belum sinkron' },
      { level: 'ERROR', message: 'IBS mismatch | depo' },
    ]);
  });

  it('strips an HTML error page out of the detail text', () => {
    const alerts = new RunAlerts();
    alerts.registerSyncIssue('R1', 'sync tindakan', 'gagal simpan\n<!DOCTYPE html><html>boom</html>');
    expect(alerts.getSyncIssues('R1')).toEqual([{ phase: 'sync tindakan', detail: 'gagal simpan' }]);
  });

  it('defaults the sync phase to "sync" and omits an empty detail', () => {
    const alerts = new RunAlerts();
    alerts.registerSyncIssue('R1', '   ');
    expect(alerts.getSyncIssues('R1')).toEqual([{ phase: 'sync', detail: '' }]);
    expect(alerts.hasSyncIssues('R1')).toBe(true);
  });
});

describe('RunAlerts blocking rules', () => {
  it('treats only the three legacy shapes as blocking', () => {
    const alerts = new RunAlerts();
    alerts.registerVerificationBlocker('R1', 'depo IGD belum ada');
    alerts.registerRegAlert('R1', 'ERROR', 'Grand total kasir dan rekapitulasi belum balance');
    alerts.registerRegAlert('R1', 'ERROR', 'IBS mismatch | biaya IBS tanpa depo');
    // Non-blocking: a WARN, and an ERROR that is not one of the three shapes.
    alerts.registerRegAlert('R1', 'WARN', 'Ada 2 transaksi terkait lain yang perlu cek manual');
    alerts.registerRegAlert('R1', 'ERROR', 'Lab PK 05-250114-1 belum ada hasil');

    expect(alerts.getBlockingRegAlerts('R1')).toEqual([
      'ERROR: Blocker verifikasi manual | depo IGD belum ada',
      'ERROR: Grand total kasir dan rekapitulasi belum balance',
      'ERROR: IBS mismatch | biaya IBS tanpa depo',
    ]);
    expect(alerts.getRegAlerts('R1')).toHaveLength(5);
  });

  it('keeps registries separate per reg and per instance', () => {
    const a = new RunAlerts();
    const b = new RunAlerts();
    a.registerVerificationBlocker('R1', 'blocker');
    expect(a.getBlockingRegAlerts('R2')).toEqual([]);
    expect(b.getBlockingRegAlerts('R1')).toEqual([]);
  });
});

describe('RunAlerts summaries', () => {
  it('respects the default alert limit of 5 and appends the overflow suffix', () => {
    const alerts = new RunAlerts();
    for (let i = 1; i <= 7; i += 1) alerts.registerRegAlert('R1', 'WARN', `alert ${i}`);
    const summary = alerts.getRegAlertSummary('R1');
    expect(summary.split('; ')).toHaveLength(6);
    expect(summary.startsWith('WARN: alert 1; ')).toBe(true);
    expect(summary.endsWith('WARN: alert 5; +2 alert lain')).toBe(true);
    expect(alerts.getRegAlertSummary('R1', 7)).not.toContain('alert lain');
  });

  it('respects the default sync-issue limit of 3', () => {
    const alerts = new RunAlerts();
    for (let i = 1; i <= 5; i += 1) alerts.registerSyncIssue('R1', `phase ${i}`, `detail ${i}`);
    expect(alerts.getSyncIssueSummary('R1')).toBe(
      'phase 1: detail 1; phase 2: detail 2; phase 3: detail 3; +2 issue lain',
    );
    expect(alerts.getSyncIssueSummary('R1', 1)).toBe('phase 1: detail 1; +4 issue lain');
  });

  it('returns an empty summary when nothing is registered', () => {
    const alerts = new RunAlerts();
    expect(alerts.getRegAlertSummary('R1')).toBe('');
    expect(alerts.getSyncIssueSummary('R1')).toBe('');
  });
});

describe('RunAlerts pre-verification summary', () => {
  it('reports a normal reg with zero counters', () => {
    const alerts = new RunAlerts();
    const summary = alerts.buildPreVerificationSummary('R1');
    expect(summary.hasBlocker).toBe(false);
    expect(summary.blocking).toEqual([]);
    expect(summary.lines).toEqual([
      '- Summary sebelum verifikasi',
      '  Reg      : R1',
      '  Status   : normal',
      '  Issue    : 0',
      '  Alert    : 0',
    ]);
  });

  it('counts warns and errors and groups the detail blocks WARN then ERROR', () => {
    const alerts = new RunAlerts();
    alerts.registerSyncIssue('R1', 'sync obat', 'timeout');
    alerts.registerRegAlert('R1', 'WARN', 'transaksi terkait menggantung');
    alerts.registerVerificationBlocker('R1', 'bank darah manual');

    const summary = alerts.buildPreVerificationSummary('R1');
    expect(summary.hasBlocker).toBe(true);
    expect(summary.blocking).toEqual(['ERROR: Blocker verifikasi manual | bank darah manual']);
    expect(summary.lines).toEqual([
      '- Summary sebelum verifikasi',
      '  Reg      : R1',
      '  Sync issue: 1',
      '  Alert    : 2',
      '  Warn     : 1',
      '  Error    : 1',
      '- Sync issue',
      '  Reg      : R1',
      '  Count    : 1',
      '  Detail   :',
      '    - sync obat: timeout',
      '- Warn',
      '  Reg      : R1',
      '  Count    : 1',
      '  Detail   :',
      '    - transaksi terkait menggantung',
      '- Error',
      '  Reg      : R1',
      '  Count    : 1',
      '  Detail   :',
      '    - Blocker verifikasi manual | bank darah manual',
    ]);
  });

  it('caps the sync preview at 6 and the per-level alert preview at 10', () => {
    const alerts = new RunAlerts();
    for (let i = 1; i <= 8; i += 1) alerts.registerSyncIssue('R1', `phase ${i}`);
    for (let i = 1; i <= 12; i += 1) alerts.registerRegAlert('R1', 'WARN', `alert ${i}`);
    const lines = alerts.buildPreVerificationSummary('R1').lines;
    expect(lines).toContain('    - +2 issue lain');
    expect(lines).toContain('    - +2 alert lain');
    expect(lines.filter((line) => line.startsWith('    - phase '))).toHaveLength(6);
    expect(lines.filter((line) => line.startsWith('    - alert '))).toHaveLength(10);
  });
});

describe('RunAlerts reset', () => {
  it('clears one reg, or every reg when called without one', () => {
    const alerts = new RunAlerts();
    alerts.registerSyncIssue('R1', 'sync', 'a');
    alerts.registerSyncIssue('R2', 'sync', 'b');
    alerts.registerRegAlert('R1', 'WARN', 'w');
    alerts.registerRegAlert('R2', 'WARN', 'w');

    alerts.resetSyncIssues('R1');
    expect(alerts.hasSyncIssues('R1')).toBe(false);
    expect(alerts.hasSyncIssues('R2')).toBe(true);

    alerts.resetRegAlerts();
    expect(alerts.getRegAlerts('R1')).toEqual([]);
    expect(alerts.getRegAlerts('R2')).toEqual([]);
    expect(alerts.hasSyncIssues('R2')).toBe(true);
  });
});
