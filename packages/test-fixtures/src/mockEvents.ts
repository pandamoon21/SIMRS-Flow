/**
 * Mock event player — generates a deterministic WorkflowEvent stream for a
 * definition WITHOUT running real executors. Used by the UI to demo replay
 * and by tests to exercise the reducer against a full graph.
 *
 * It walks the definition in topological order and emits a believable
 * lifecycle (queued → started → succeeded, with edges and a few skips/plans),
 * so the React Flow canvas can animate a complete run offline.
 */

import {
  EventBus,
  executionOrder,
  fixedClock,
  counterIdFactory,
  reasoningEvidence,
  type ReasoningItem,
  type WorkflowDefinition,
  type WorkflowEvent,
} from '@simrs-flow/workflow-core';

/**
 * Labelled example checklists so the offline replay can show what the
 * decision-tree view looks like. Every title says "contoh": these are not
 * results, and a real run's checklists come from its executors.
 */
const EXAMPLE_REASONING: Record<string, Record<string, { title: string; items: ReasoningItem[] }>> = {
  ranap: {
    reject_verified: { title: 'Contoh · 2 kunjungan dicek status verifikasinya', items: [
      { label: 'MULTAZAM 2 · masuk 2026-06-08', ok: true, detail: 'belum terverifikasi' },
      { label: 'IGD · masuk 2026-06-08', ok: true, detail: 'belum terverifikasi' },
    ] },
    validate_sep: { title: 'Contoh · Cari SEP rawat inap (toleransi ±3 hari)', items: [
      { label: 'No kartu BPJS', ok: true, detail: '0001234567890' },
      { label: 'SEP RITL ditemukan', ok: true, detail: '1105R0010626V000123' },
      { label: 'Tanggal SEP sesuai', ok: true, detail: 'tgl 2026-06-09 · dalam toleransi ±1 hari' },
    ] },
    sync_visite: { title: 'Contoh · Rawat 3 hari (2026-06-08 – 2026-06-10)', items: [
      { label: 'Visite dr. Andi · tgl 2026-06-08', ok: true },
      { label: 'Visite dr. Andi · tgl 2026-06-09', ok: true },
      { label: 'Konsultasi dr. Budi · tgl 2026-06-09', ok: false, detail: 'dihapus: tidak ada dokter CPPT pada tanggal itu' },
      { label: 'Visite DPJP dr. Andi', ok: true, detail: 'sudah ada dalam rentang rawat' },
    ] },
    check_balance: { title: 'Contoh · Grand total kasir dibandingkan total rekapitulasi', items: [
      { label: 'Total kasir = total rekapitulasi', ok: true, detail: 'Rp 4.812.000 = Rp 4.812.000' },
    ] },
  },
  rajal: {
    validate_treatment: { title: 'Contoh · 1 kunjungan diperiksa', items: [
      { label: 'Tidak ada tindakan "ODC"', ok: true, detail: 'tidak ditemukan' },
      { label: 'Grup A: PENDAFTARAN PASIEN', ok: true, detail: 'ada: PENDAFTARAN PASIEN' },
      { label: 'Grup B: BIAYA OBAT / HAEMODIALISA', ok: true, detail: 'ada: BIAYA OBAT' },
    ] },
    validate_sep: { title: 'Contoh · SEP RJTL dicocokkan per transaksi (1)', items: [
      { label: 'SEP RJTL hari kunjungan', ok: true, detail: '1105R0010626V000456 sudah terpasang' },
    ] },
    check_payment: { title: 'Contoh · Status bayar dari baris tagihan poliklinik', items: [
      { label: 'Belum ada pembayaran', ok: true, detail: 'tagihan Rp 185.000, belum dibayar' },
    ] },
  },
};

export interface MockRunOptions {
  runId?: string;
  /** Node ids to render as skipped. */
  skip?: string[];
  /** Node ids to render as needs_review (e.g. mutate nodes with plans). */
  review?: string[];
  /** Optional edge verdicts for offline branch replay; omitted keeps legacy streams unchanged. */
  branches?: Record<string, 'take' | 'skip' | 'block'>;
  /**
   * Optional `rajal.clinic-counts` evidence attached to the Rajal
   * `filter_records` success event, purely so the replay demo can show the
   * MULAI recap. Off by default — existing streams stay byte-identical.
   */
  /** Attach labelled example checklists (UI fixture demo only). Off keeps streams byte-identical. */
  exampleReasoning?: boolean;
  clinicCounts?: {
    totalClinics: number;
    totalPatients: number;
    complete: boolean;
    clinics: ReadonlyArray<{ clinic: string; patientCount: number }>;
  };
}

/** Produce a full, deterministic event stream for a definition. */
export function mockEventStream(
  definition: WorkflowDefinition,
  options: MockRunOptions = {},
): WorkflowEvent[] {
  const clock = fixedClock('2026-06-10T00:00:00.000Z', 500);
  const bus = new EventBus({ clock, idFactory: counterIdFactory('evt') });
  const events: WorkflowEvent[] = [];
  bus.subscribe((e) => events.push(e));

  const runId = options.runId ?? 'mock-run';
  const base = {
    runId,
    workflowId: definition.id,
    workflowVersion: definition.version,
    source: 'runner' as const,
  };
  const skip = new Set(options.skip ?? []);
  const review = new Set(options.review ?? autoReviewNodes(definition));

  bus.emit({ ...base, type: 'run.created', message: `Mock run ${runId}` });
  bus.emit({ ...base, type: 'run.started', message: 'Mock run started (preview)' });

  const order = executionOrder(definition);
  const done = new Set<string>();

  for (const node of order) {
    if (skip.has(node.id)) {
      bus.emit({ ...base, type: 'node.skipped', nodeId: node.id, message: `${node.label} skipped`, data: { summary: 'Skipped' } });
      continue;
    }
    bus.emit({ ...base, type: 'node.queued', nodeId: node.id });
    bus.emit({ ...base, type: 'node.started', nodeId: node.id, message: node.label });
    bus.emit({ ...base, type: 'log.appended', nodeId: node.id, severity: 'info', message: `Running ${node.label}…` });

    if (review.has(node.id)) {
      const example = options.exampleReasoning ? EXAMPLE_REASONING[definition.domain]?.[node.id] : undefined;
      bus.emit({
        ...base,
        type: 'node.needs_review',
        nodeId: node.id,
        severity: 'warn',
        message: `${node.label} menyusun rencana mutasi`,
        data: {
          summary: 'Mutasi direncanakan (preview)',
          ...(example ? { evidence: [reasoningEvidence({
            title: example.title,
            // The example's ✗ is the one this mock plan fixes.
            items: example.items.map((item) => (item.ok === false ? { ...item, planId: `${runId}:${node.id}` } : item)),
          })] } : {}),
          proposedMutations: [
            {
              id: `${runId}:${node.id}`,
              endpointId: 'mock.endpoint',
              riskLevel: node.riskLevel ?? 'high',
              reason: `Rencana perbaikan dari ${node.label}`,
              preconditions: [],
              payloadSummary: {},
              requiresApproval: true,
              idempotencyKey: `${runId}:${node.id}`,
            },
          ],
        },
      });
    } else {
      const evidence =
        options.clinicCounts && definition.domain === 'rajal' && node.id === 'filter_records'
          ? [
              {
                label: 'rajal.clinic-counts',
                source: 'filter_records',
                data: { basis: 'matched-visits', ...options.clinicCounts },
              },
            ]
          : options.exampleReasoning && EXAMPLE_REASONING[definition.domain]?.[node.id]
            ? [reasoningEvidence(EXAMPLE_REASONING[definition.domain]![node.id]!)]
            : undefined;
      bus.emit({
        ...base,
        type: 'node.succeeded',
        nodeId: node.id,
        message: `${node.label} ok`,
        data: { summary: `${node.label} ok`, ...(evidence ? { evidence } : {}) },
      });
    }
    done.add(node.id);

    for (const edge of definition.edges.filter((e) => e.source === node.id)) {
      if (options.branches?.[edge.id] === 'skip' || options.branches?.[edge.id] === 'block') {
        bus.emit({ ...base, type: 'edge.skipped', edgeId: edge.id });
      } else {
        bus.emit({ ...base, type: 'edge.activated', edgeId: edge.id });
        bus.emit({ ...base, type: 'edge.completed', edgeId: edge.id });
      }
    }
  }

  bus.emit({ ...base, type: 'run.completed', message: `Mock run completed (${done.size}/${order.length})` });
  return events;
}

/** Mutate/gate nodes get rendered as needs_review by default. */
function autoReviewNodes(definition: WorkflowDefinition): string[] {
  return definition.nodes.filter((n) => n.kind === 'mutate').map((n) => n.id);
}
