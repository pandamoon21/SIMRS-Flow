/**
 * Run status helpers shared by the merged Run screen. Extracted from the old
 * RunDetailPage so the run route carries no dependency on the retired page.
 */

import type { NodeStatus, RunState, RunStatus } from '@simrs-flow/workflow-core';
import { stepProgress } from '../panels/logView.js';

/**
 * Operator-facing wording for the raw node status token. `gate_waiting` and
 * `needs_review` in particular must never read as "running" or as a landed
 * write.
 */
export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  pending: 'Menunggu',
  queued: 'Dalam antrean',
  running: 'Berjalan',
  success: 'Selesai',
  skipped: 'Dilewati',
  failed: 'Gagal',
  blocked: 'Terblokir',
  needs_review: 'Perlu ditinjau',
  gate_waiting: 'Menunggu persetujuan',
  retrying: 'Mencoba ulang',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  created: 'Disiapkan',
  running: 'Berjalan',
  paused: 'Dijeda',
  cancelled: 'Dibatalkan',
  completed: 'Selesai',
  failed: 'Gagal',
};

/** Cancelling a live run is not undoable, so the button arms before it fires. */
export function cancelButtonLabel(armed: boolean): string {
  return armed ? 'Klik lagi untuk menghentikan' : 'Hentikan';
}

const CURRENT_NODE_STATUSES = ['running', 'retrying', 'queued', 'gate_waiting', 'needs_review', 'failed', 'blocked'] as const;

export function currentNodeOf(state?: RunState): { id: string; status: (typeof CURRENT_NODE_STATUSES)[number] } | undefined {
  if (!state) return undefined;
  for (const status of CURRENT_NODE_STATUSES) {
    const node = Object.values(state.nodes).find((candidate) => candidate.status === status);
    if (node) return { id: node.id, status };
  }
  return undefined;
}

const MOVING_STATUSES: ReadonlyArray<NodeStatus> = ['running', 'retrying', 'queued'];

/**
 * A preview that ran clean up to a gate. Preview never approves a gate, so the
 * engine holds it and fails the run on the critical gate (runbook: "expected,
 * preview never writes"). Nothing went wrong, so the UI must not say "Gagal".
 * Returns the gate's node id when that is the only stop.
 */
export function previewGateStopOf(state?: Pick<RunState, 'mode' | 'status' | 'nodes' | 'gates'>): string | undefined {
  if (!state || state.mode !== 'preview' || state.status !== 'failed') return undefined;
  const stops = Object.entries(state.nodes).filter(([, node]) => node.status === 'failed' || node.status === 'blocked');
  if (stops.length !== 1) return undefined;
  const [id, node] = stops[0]!;
  return node.status === 'blocked' && state.gates[id] ? id : undefined;
}

export const PREVIEW_GATE_LABEL = 'Preview selesai';

export interface BerkasProgressView {
  phase: string;
  label: string;
  /** 0–100 when the phase has a measurable total (OCR of photo pages), else undefined. */
  percent?: number;
}

/**
 * Live progress of the Kelengkapan Berkas step while it runs: the latest
 * `berkasProgress` the step logged (unduh → teks → OCR n/m). Undefined when the
 * step is not running.
 */
export function berkasProgressOf(state?: Pick<RunState, 'nodes' | 'logs'> & { status?: RunState['status'] }): BerkasProgressView | undefined {
  // A run that ended (or was lost) mid-step leaves the node "running"; the chip must not.
  if (state?.nodes.check_berkas?.status !== 'running' || (state.status && state.status !== 'running')) return undefined;
  for (let i = state.logs.length - 1; i >= 0; i--) {
    const log = state.logs[i]!;
    if (log.nodeId !== 'check_berkas') continue;
    const p = (log.data as { berkasProgress?: { phase: string; done: number; total: number; label: string } } | undefined)?.berkasProgress;
    if (!p) continue;
    const percent = p.phase === 'ocr' && p.total > 0 ? Math.round((p.done / p.total) * 100) : p.phase === 'selesai' ? 100 : undefined;
    return { phase: p.phase, label: p.label, ...(percent !== undefined ? { percent } : {}) };
  }
  return { phase: 'mulai', label: 'mencari berkas e-klaim…' };
}

export interface PatientOutcome {
  patientId: string;
  status: 'lolos' | 'dilewati';
  clinics: string[];
  transactions?: string[];
  step?: string;
  reason: string;
}

/**
 * The specific reason a skipped patient left the batch: the shortest clause of
 * the dropping step's summary that names one of the patient's transactions
 * (steps word their summary per transaction). Falls back to the generic reason.
 */
export function outcomeDetail(state: Pick<RunState, 'nodes'> | undefined, row: PatientOutcome): string {
  const summary = row.step ? state?.nodes[row.step]?.summary ?? '' : '';
  const clauses = summary.split(/;\s+|\s+—\s+/).map((part) => part.trim()).filter(Boolean);
  const hit = clauses.filter((part) => (row.transactions ?? []).some((trx) => trx && part.includes(trx))).sort((a, b) => a.length - b.length)[0];
  return hit ?? row.reason;
}

/** Per-patient result of a batch run (rajal `emit_batch_summary` evidence); empty when the run has none. */
export function patientOutcomesOf(state?: Pick<RunState, 'nodes'>): PatientOutcome[] {
  for (const node of Object.values(state?.nodes ?? {})) {
    const found = node.evidence?.find((item) => item.label === 'rajal.patient-outcomes');
    const rows = (found?.data as { rows?: unknown } | undefined)?.rows;
    if (Array.isArray(rows)) return rows as PatientOutcome[];
  }
  return [];
}

/**
 * The badge beside the run status. A failed run already reads "Gagal" there,
 * so this names *why*: the first failed/blocked node, else nothing.
 */
export function attentionOf(state?: RunState, labelOf: (id: string) => string = (id) => id): string | undefined {
  if (!state) return undefined;
  const held = previewGateStopOf(state);
  if (held) return `Ditahan di gerbang (preview): ${labelOf(held)}`;
  if (state.status === 'failed') {
    const stop = Object.values(state.nodes).find((node) => node.status === 'failed' || node.status === 'blocked');
    return stop ? `${NODE_STATUS_LABEL[stop.status]}: ${labelOf(stop.id)}` : undefined;
  }
  const node = currentNodeOf(state);
  return node && !MOVING_STATUSES.includes(node.status) ? `Perlu perhatian: ${NODE_STATUS_LABEL[node.status]}` : undefined;
}

export interface RunOutcome {
  done: number;
  total: number;
  /** Wall-clock run time when both stamps exist, else the summed step time. */
  durationMs: number;
  problems: number;
  mutations: { verified: number; failed: number; open: number };
  /** First failed/blocked node, so the summary can jump straight to it. */
  stopNodeId?: string;
}

const OPEN_MUTATIONS = new Set(['planned', 'approved', 'applied']);

/** One read of a run's result, shared by the console header and the post-run summary. */
export function runOutcomeOf(state?: RunState): RunOutcome {
  const nodes = Object.values(state?.nodes ?? {});
  const { done, total } = stepProgress(state?.nodes);
  const started = state?.startedAt ? Date.parse(state.startedAt) : NaN;
  const finished = state?.finishedAt ? Date.parse(state.finishedAt) : NaN;
  const wall = finished - started;
  const durationMs = Number.isFinite(wall) && wall >= 0 ? wall : nodes.reduce((sum, node) => sum + (node.durationMs ?? 0), 0);
  const mutations = Object.values(state?.mutations ?? {});
  const stop = nodes.find((node) => node.status === 'failed' || node.status === 'blocked');
  return {
    done,
    total,
    durationMs,
    problems: (state?.logs ?? []).filter((log) => log.severity === 'warn' || log.severity === 'error').length,
    mutations: {
      verified: mutations.filter((m) => m.status === 'verified').length,
      failed: mutations.filter((m) => m.status === 'failed' || m.status === 'invalidated').length,
      open: mutations.filter((m) => OPEN_MUTATIONS.has(m.status)).length,
    },
    ...(stop ? { stopNodeId: stop.id } : {}),
  };
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const TERMINAL_RUN_STATUSES: ReadonlyArray<RunStatus> = ['completed', 'failed', 'cancelled'];

/**
 * What the operator does next when a run stops at a node. The node's own summary
 * says *what* is wrong; this says *what to do*. Steps not listed fall back to the
 * generic advice.
 */
const NEXT_ACTION: Record<string, string> = {
  normalize_input: 'Perbaiki No RM / tanggal di Setup, lalu mulai run lagi.',
  normalize_ids: 'Perbaiki daftar No RM di Setup, lalu mulai run lagi.',
  load_visits: 'Pastikan pasien punya kunjungan rawat inap pada tanggal itu di SIMRS.',
  reject_verified: 'Transaksi sudah diverifikasi — tidak perlu diproses lagi. Jika SIMRS sedang lambat, jalankan ulang.',
  reject_paid: 'Kunjungan sudah punya riwayat pembayaran — cek di menu Kasir. Jika SIMRS sedang lambat, jalankan ulang.',
  validate_sep: 'Cek SEP pasien di menu Pendaftaran SIMRS (tanggal masuk dan PPK), perbaiki, lalu jalankan ulang.',
  preverify_summary: 'Buka langkah bertanda kuning/merah sebelum ini, selesaikan di SIMRS, lalu jalankan ulang.',
  check_balance: 'Bandingkan grand total kasir dengan rekapitulasi di SIMRS, rapikan selisihnya, lalu jalankan ulang.',
  final_gate: 'Tinjau rencana di Inspector, lalu setujui atau tolak.',
  resolve_clinics: 'Pilih poli yang dikenal di Setup, lalu mulai run lagi.',
  load_history: 'Pastikan No RM benar dan pasien punya kunjungan rawat jalan pada tanggal itu.',
  validate_exit_date: 'Isi tanggal keluar kunjungan di menu Poliklinik SIMRS, lalu jalankan ulang.',
  check_verification: 'Selesaikan order yang belum terlayani / belum ditransfer di SIMRS, lalu jalankan ulang.',
};

export function nextActionOf(nodeId: string): string {
  return NEXT_ACTION[nodeId] ?? 'Buka langkah ini di Inspector untuk detailnya; selesaikan di SIMRS lalu jalankan ulang.';
}
