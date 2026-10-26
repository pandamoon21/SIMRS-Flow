import { describe, expect, it } from 'vitest';
import {
  isNodeActivationKey,
  nodeAriaLabel,
  nodeIssueLines,
  nodeSummaryText,
  planProgressLabel,
  statusLabelOf,
  type WorkflowNodeData,
} from '../src/features/canvas/WorkflowNode.js';

/**
 * The Run card is the operator's primary reading surface: it must say what the
 * node did, whether a plan actually landed, and what still needs attention —
 * without the inspector, which now starts hidden.
 */
function nodeData(overrides: Partial<WorkflowNodeData> = {}): WorkflowNodeData {
  return {
    label: 'Execute Verifikasi',
    group: 'verifikasi',
    groupLabel: 'Verifikasi',
    kind: 'mutate',
    status: 'needs_review',
    ...overrides,
  };
}

describe('run node card projection', () => {
  it('keeps the keyboard activation contract', () => {
    expect(isNodeActivationKey('Enter')).toBe(true);
    expect(isNodeActivationKey(' ')).toBe(true);
    expect(isNodeActivationKey('Escape')).toBe(false);
    expect(isNodeActivationKey('Tab')).toBe(false);
  });

  it('humanises statuses instead of printing raw tokens', () => {
    expect(statusLabelOf(nodeData({ status: 'gate_waiting' }))).toBe('Menunggu persetujuan');
    expect(statusLabelOf(nodeData({ status: 'needs_review' }))).toBe('Perlu ditinjau');
    expect(statusLabelOf(nodeData({ status: 'blocked' }))).toBe('Terblokir');
    expect(statusLabelOf(nodeData({ status: 'success' }))).toBe('Selesai');
    expect(statusLabelOf(nodeData({ status: 'success', plansFailed: 1 }))).toBe('Selesai — ada plan gagal');
  });

  it('never shows "Selesai" without saying what happened', () => {
    expect(nodeSummaryText(nodeData({ status: 'pending' }))).toBe('Belum diproses');
    expect(nodeSummaryText(nodeData({ status: 'queued' }))).toBe('Belum diproses');
    expect(nodeSummaryText(nodeData({ status: 'skipped' }))).toBe('Tidak ada yang dikerjakan');
    expect(nodeSummaryText(nodeData({ status: 'running' }))).toBe('Berjalan');
    expect(nodeSummaryText(nodeData({ status: 'success', summary: 'Total tagihan balance untuk 1 grup' }))).toBe(
      'Total tagihan balance untuk 1 grup',
    );
  });

  it('prioritises errors over warnings and collapses the rest into a count', () => {
    const { lines, extra } = nodeIssueLines(
      nodeData({
        issues: [{ code: 'balance', message: 'belum balance', severity: 'error' }],
        warnings: [
          { code: 'replan', message: 'batas re-plan tercapai', severity: 'warn' },
          { code: 'titipan', message: 'titipan kurang', severity: 'warn' },
          { code: 'extra', message: 'catatan lain', severity: 'warn' },
        ],
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: '[balance] belum balance', severity: 'error' });
    expect(extra).toBe(3);
  });

  it('separates pending plans from landed writes', () => {
    expect(planProgressLabel(nodeData())).toBe('');
    expect(planProgressLabel(nodeData({ planCount: 2, plansPending: 2 }))).toBe('2 menunggu');
    expect(planProgressLabel(nodeData({ planCount: 2, plansVerified: 1, plansFailed: 1 }))).toBe(
      '1 terverifikasi · 1 gagal',
    );
    expect(planProgressLabel(nodeData({ planCount: 3, plansPending: 1, plansVerified: 1, plansFailed: 1 }))).toBe(
      '1 menunggu · 1 terverifikasi · 1 gagal',
    );
  });

  it('describes status, plan progress and issue count in the accessible name', () => {
    const label = nodeAriaLabel(
      nodeData({
        status: 'gate_waiting',
        planCount: 1,
        plansPending: 1,
        issues: [{ code: 'x', message: 'y', severity: 'error' }],
      }),
    );

    expect(label).toContain('Execute Verifikasi');
    expect(label).toContain('Menunggu persetujuan');
    expect(label).toContain('1 menunggu');
    expect(label).toContain('1 catatan');
  });
  it('announces only privacy-safe clinic and patient totals in the queue recap', () => {
    const base = nodeData({ label: 'Mulai' });
    expect(nodeAriaLabel({ ...base, clinicCountsState: 'waiting' })).toContain('rekap antrean sedang dihitung');
    expect(nodeAriaLabel({ ...base, clinicCountsState: 'unavailable' })).toContain('rekap antrean tidak tersedia');
    expect(nodeAriaLabel({
      ...base,
      clinicCountsState: 'ready',
      clinicCounts: { complete: true, totalClinics: 2, totalPatients: 3, clinics: [{ clinic: 'ANAK', patientCount: 2 }, { clinic: 'DALAM', patientCount: 2 }] },
    })).toContain('2 poli, 3 pasien');
  });
});
