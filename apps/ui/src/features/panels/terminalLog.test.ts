import { describe, expect, it } from 'vitest';
import { applyEvent, initialRunState, type RunState, type WorkflowDefinition } from '@simrs-flow/workflow-core';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { rajalWorkflow } from '@simrs-flow/domain-rajal';
import { mockEventStream } from '@simrs-flow/test-fixtures';
import { CHECK_LIST_LIMIT, footerText, openDecisions, patientTrails, rowText, stepBlocks, stepOrder, terminalRows, type TermRow } from './terminalLog.js';

function replay(definition: WorkflowDefinition, upTo?: number): RunState {
  const events = mockEventStream(definition, { runId: 'r1', exampleReasoning: true });
  return events.slice(0, upTo ?? events.length).reduce((state, event) => applyEvent(state, event), initialRunState(definition, 'r1', 'preview'));
}

const kinds = (rows: TermRow[]) => rows.map((row) => row.kind);

describe('terminal log', () => {
  for (const definition of [ranapWorkflow, rajalWorkflow]) {
    it(`${definition.domain}: one block per started step, numbered [x/y], closed by a footer`, () => {
      const rows = terminalRows(definition, replay(definition));
      const total = definition.nodes.length;
      const ends = rows.filter((row) => row.kind === 'end' || row.kind === 'skip');
      expect(ends).toHaveLength(total);
      expect(new Set(ends.map((row) => (row as { index: number }).index)).size).toBe(total);
      expect(ends.every((row) => (row as { total: number }).total === total)).toBe(true);
      expect(rows.at(-1)!.kind).toBe('footer');
      expect(footerText(rows.at(-1) as Extract<TermRow, { kind: 'footer' }>)).toMatch(/^════ SELESAI · \d+\/\d+ tahap · \d+ masalah · .+ ════$/);
    });
  }

  it('keeps every log message exactly as the executor wrote it, nothing prepended', () => {
    const state = replay(ranapWorkflow);
    const lines = terminalRows(ranapWorkflow, state).filter((row): row is Extract<TermRow, { kind: 'line' }> => row.kind === 'line');
    expect(lines.map((row) => row.entry.seq).sort((a, b) => a - b)).toEqual(state.logs.map((log) => log.seq).sort((a, b) => a - b));
    for (const row of lines) expect(rowText(row)).toBe(row.entry.message);
  });

  it('numbers steps by topological order', () => {
    const order = stepOrder(ranapWorkflow);
    for (const edge of ranapWorkflow.edges) expect(order.get(edge.target)!).toBeGreaterThan(order.get(edge.source)!);
    expect(order.get('normalize_input')).toBe(1);
  });

  it('shows only started steps mid-run, the running one marked ●', () => {
    const state = replay(ranapWorkflow, 12);
    const rows = terminalRows(ranapWorkflow, state);
    expect(rows.some((row) => row.kind === 'footer')).toBe(false);
    const running = Object.values(state.nodes).filter((node) => node.status === 'running');
    for (const node of running) expect(rows.find((row) => row.kind === 'end' && row.nodeId === node.id)).toMatchObject({ mark: '●', note: 'berjalan' });
    expect(rows.filter((row) => row.kind === 'end').length).toBeLessThan(ranapWorkflow.nodes.length);
  });

  it('a skipped step without logs is a single row', () => {
    const state = replay(ranapWorkflow, 12);
    const node = Object.values(state.nodes).find((n) => n.status === 'pending')!;
    const skipped: RunState = { ...state, nodes: { ...state.nodes, [node.id]: { ...node, status: 'skipped' } } };
    const rows = terminalRows(ranapWorkflow, skipped).filter((row) => 'nodeId' in row && row.nodeId === node.id);
    expect(kinds(rows)).toEqual(['skip']);
    expect(rowText(rows[0]!)).toMatch(/^↷ \[\d+\/\d+\] .+ · dilewati$/);
  });

  it('turns gates and planned writes into decisions: open ones ask, settled ones say who', () => {
    const base = replay(ranapWorkflow);
    const write: RunState = {
      ...base,
      mode: 'write',
      // A gate waiting for a decision means the run is still in flight.
      status: 'running',
      gates: {
        final_gate: { nodeId: 'final_gate', status: 'waiting', requestedAt: 't' },
        execute_verifikasi: { nodeId: 'execute_verifikasi', status: 'approved', requestedAt: 't', reason: 'Auto-approved by dr.x (autoApprove)' },
      },
    };
    const planned = Object.values(write.nodes).flatMap((node) => node.proposedMutations)[0]!;
    const verified = Object.values(write.nodes).flatMap((node) => node.proposedMutations)[1]!;
    write.mutations = {
      ...write.mutations,
      [planned.id]: { planId: planned.id, endpointId: planned.endpointId, status: 'planned' },
      [verified.id]: { planId: verified.id, endpointId: verified.endpointId, status: 'verified', approvedBy: ['dr.x', 'auto-approve'] },
    };
    const rows = terminalRows(ranapWorkflow, write);
    const open = openDecisions(rows);
    expect(open.some((row) => row.decision.type === 'gate' && row.decision.nodeId === 'final_gate')).toBe(true);
    expect(open.some((row) => row.decision.type === 'mutation' && 'planId' in row.decision && row.decision.planId === planned.id)).toBe(true);
    const settled = rows.filter((row): row is Extract<TermRow, { kind: 'decision' }> => row.kind === 'decision' && !row.decision.open);
    expect(settled.find((row) => row.decision.nodeId === 'execute_verifikasi' && row.decision.type === 'gate')?.decision).toMatchObject({ auto: true, text: 'Disetujui otomatis (auto-approve)' });
    expect(settled.some((row) => row.decision.type === 'mutation' && rowText(row).startsWith('Disetujui otomatis (auto-approve) ·') && rowText(row).endsWith('terverifikasi'))).toBe(true);
  });

  it('marks every approval of an auto-approving run as automatic, even a non-critical one signed by the operator alone', () => {
    const base = replay(ranapWorkflow);
    const [plan] = Object.values(base.nodes).flatMap((node) => node.proposedMutations);
    const run: RunState = {
      ...base,
      mode: 'write',
      gates: { final_gate: { nodeId: 'final_gate', status: 'approved', requestedAt: 't', reason: 'Auto-approved by dr.x (autoApprove)' } },
      mutations: { [plan!.id]: { planId: plan!.id, endpointId: plan!.endpointId, status: 'failed', approvedBy: ['dr.x'], reason: 'write answered 500' } },
    };
    const row = terminalRows(ranapWorkflow, run).find((r) => r.kind === 'decision' && 'decision' in r && r.decision.type === 'mutation' && !r.decision.open);
    expect(rowText(row!)).toMatch(/^Disetujui otomatis \(auto-approve\) · .+ · gagal — write answered 500$/);
    // Without that evidence the operator is named.
    const manual = terminalRows(ranapWorkflow, { ...run, gates: {} }).find((r) => r.kind === 'decision' && 'decision' in r && r.decision.type === 'mutation' && !r.decision.open);
    expect(rowText(manual!)).toMatch(/^Disetujui oleh dr\.x · /);
  });

  it('a write plan left open when the run ended is a fixed line, never a button that would 409', () => {
    const base = replay(ranapWorkflow);
    const ended: RunState = { ...base, mode: 'write', status: 'completed', gates: {} };
    const rows = terminalRows(ranapWorkflow, ended);
    expect(openDecisions(rows).filter((row) => row.decision.type === 'mutation')).toHaveLength(0);
    expect(rows.some((row) => row.kind === 'decision' && rowText(row).endsWith('tidak diterapkan — run sudah berakhir'))).toBe(true);
  });

  it('in preview a planned write is a fixed line, never a button', () => {
    const rows = terminalRows(ranapWorkflow, replay(ranapWorkflow));
    expect(openDecisions(rows)).toHaveLength(0);
    expect(rows.some((row) => row.kind === 'decision' && rowText(row).endsWith('preview, tidak ditulis'))).toBe(true);
  });

  it('folds each step into one block: header, own lines minus repeats, end row on the block', () => {
    const state = replay(rajalWorkflow);
    const blocks = stepBlocks(terminalRows(rajalWorkflow, state));
    const steps = blocks.filter((block) => block.head);
    expect(steps.length).toBeGreaterThan(0);
    for (const block of steps) {
      expect(block.end?.nodeId).toBe(block.head!.nodeId);
      const texts = block.rows.flatMap((row) => (row.kind === 'line' ? [row.entry.message.trim()] : []));
      expect(texts).not.toContain(block.head!.label);
      texts.forEach((text, i) => expect(text).not.toBe(texts[i - 1]));
      expect(block.rows.every((row) => row.kind !== 'divider' && row.kind !== 'end')).toBe(true);
    }
    expect(blocks.at(-1)!.rows[0]!.kind).toBe('footer');
  });

  it('checks: per-item rows after a step, and the patients they name with their worst verdict', () => {
    const base = replay(rajalWorkflow);
    const node = base.nodes.filter_records!;
    const items = [
      { label: '0-01-23-45 · 01-200001 · POLI DALAM', ok: true, subject: '0-01-23-45' },
      { label: '0-67-89-01 · 01-200002 · POLI DALAM', ok: false, detail: 'sudah bayar', subject: '0-67-89-01' },
      { label: '2 kunjungan lain', ok: null },
    ];
    const state: RunState = { ...base, nodes: { ...base.nodes, filter_records: { ...node, evidence: [{ label: 'reasoning', data: { title: 'Kunjungan cocok', items } }] } } };
    expect(terminalRows(rajalWorkflow, state).some((row) => row.kind === 'check')).toBe(false);
    const rows = terminalRows(rajalWorkflow, state, { checks: true });
    const checks = rows.filter((row): row is Extract<TermRow, { kind: 'check' }> => row.kind === 'check' && row.nodeId === 'filter_records');
    expect(checks.map((row) => rowText(row))).toEqual(['✓ 0-01-23-45 · 01-200001 · POLI DALAM', '✗ 0-67-89-01 · 01-200002 · POLI DALAM — sudah bayar', '• 2 kunjungan lain']);
    expect(checks[0]!.title).toBe('Kunjungan cocok');
    const block = stepBlocks(rows).find((b) => b.head?.nodeId === 'filter_records')!;
    expect(block.rows.filter((row) => row.kind === 'check')).toHaveLength(3);
    // Ringkas: even a short checklist is a tally plus its ✗ items.
    const quiet = terminalRows(rajalWorkflow, state, { checks: true, summary: true }).filter((row): row is Extract<TermRow, { kind: 'check' }> => row.kind === 'check' && row.nodeId === 'filter_records');
    expect(quiet.map((row) => rowText(row))).toEqual([
      '✗ 1 bermasalah · 1 lolos · 1 info — 3 item — rincian lengkap di tampilan Per pasien',
      '✗ 0-67-89-01 · 01-200002 · POLI DALAM — sudah bayar',
    ]);
  });

  it('a 500-patient checklist is one tally row plus the ✗ items (capped), never 500 lines', () => {
    const base = replay(rajalWorkflow);
    const items = Array.from({ length: 500 }, (_, i) => ({ label: `0-00-${String(i).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1-$2')}`, ok: i % 50 !== 0, ...(i % 50 ? {} : { detail: 'sudah bayar' }) }));
    const state: RunState = { ...base, nodes: { ...base.nodes, filter_records: { ...base.nodes.filter_records!, evidence: [{ label: 'reasoning', data: { title: 'Kunjungan cocok', items } }] } } };
    const checks = terminalRows(rajalWorkflow, state, { checks: true }).filter((row): row is Extract<TermRow, { kind: 'check' }> => row.kind === 'check' && row.nodeId === 'filter_records');
    expect(items.length).toBeGreaterThan(CHECK_LIST_LIMIT);
    expect(checks).toHaveLength(1 + 10);
    expect(rowText(checks[0]!)).toMatch(/^✗ 10 bermasalah · 490 lolos — 500 item/);
    expect(checks.slice(1).every((row) => row.item.ok === false)).toBe(true);
  });

  it('trails each patient across steps; the last item decides dilewati, an earlier ✗ is a note', () => {
    const base = replay(rajalWorkflow);
    const reason = (items: unknown[]) => [{ label: 'reasoning', data: { items } }];
    const at = (id: string, items: unknown[]) => ({ [id]: { ...base.nodes[id]!, evidence: reason(items) } });
    const state: RunState = { ...base, nodes: { ...base.nodes,
      ...at('filter_records', [{ label: 'A · 1', ok: true, subject: 'A' }, { label: 'B · 2', ok: false, detail: 'sudah bayar', subject: 'B' }, { label: 'C · 3', ok: true, subject: 'C' }]),
      ...at('check_berkas', [{ label: 'A · resume', ok: false, detail: 'belum ada', subject: 'A' }]),
      ...at('check_verification', [{ label: 'A · 1', ok: false, planId: 'p1', subject: 'A' }, { label: 'C · 3', ok: true, subject: 'C' }]),
    } };
    const trails = patientTrails(rajalWorkflow, state);
    const by = Object.fromEntries(trails.map((t) => [t.rm, t]));
    expect(trails.map((t) => t.rm)).toEqual(['A', 'B', 'C']);
    expect(by.B).toMatchObject({ status: 'dilewati', step: 'Filter Kunjungan', reason: 'sudah bayar', notes: 0 });
    expect(by.A).toMatchObject({ status: 'lolos', notes: 1, writes: 1, step: 'Kelengkapan Berkas', reason: 'belum ada' });
    expect(by.C).toMatchObject({ status: 'lolos', step: '', reason: '' });
    expect(patientTrails(rajalWorkflow, { ...state, status: 'running' }).find((t) => t.rm === 'C')).toMatchObject({ status: 'proses', step: 'Cek Order & Verifikasi' });
    // Dropped early, repeated as ✗ by the batch summary: the drop step is what counts.
    const summarised: RunState = { ...state, nodes: { ...state.nodes, ...at('emit_batch_summary', [{ label: 'B', ok: false, detail: 'dilewati di Filter Kunjungan', subject: 'B' }]) } };
    expect(patientTrails(rajalWorkflow, summarised).find((t) => t.rm === 'B')).toMatchObject({ status: 'dilewati', step: 'Filter Kunjungan', reason: 'sudah bayar' });
    const noVisit: RunState = { ...state, nodes: { ...state.nodes, ...at('load_history', [{ label: 'D', ok: null, detail: 'tidak ada kunjungan', subject: 'D' }]) } };
    expect(patientTrails(rajalWorkflow, noVisit).find((t) => t.rm === 'D')).toMatchObject({ status: 'dilewati', step: 'Ambil Riwayat Kunjungan', reason: 'tidak ada kunjungan' });
    const noMatch: RunState = { ...noVisit, nodes: { ...noVisit.nodes, ...at('emit_batch_summary', [{ label: 'D', ok: false, detail: 'tidak ada kunjungan yang cocok', subject: 'D' }]) } };
    expect(patientTrails(rajalWorkflow, noMatch).find((t) => t.rm === 'D')).toMatchObject({ status: 'dilewati', step: 'Ambil Riwayat Kunjungan', reason: 'tidak ada kunjungan' });
  });
});
