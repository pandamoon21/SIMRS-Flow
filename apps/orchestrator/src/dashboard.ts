/**
 * Dashboard numbers derived from the audit ledger — the record of work this
 * app actually did. No extra SIMRS reads: every figure traces back to a run.
 *
 *  - patients: one row per patient a run processed (ranap: the run's medrec;
 *    rajal: the batch's `rajal.patient-outcomes` rows).
 *  - nominal: tampung bayar plans whose read-after-write check passed
 *    (`mutation.verified`); a preview run therefore contributes 0.
 *  - gate: decisions in write runs (preview runs auto-hold every gate).
 *
 * Times are WIB (UTC+7, no DST) — the hospital's clock, whatever the host's.
 */
import type { LedgerHistory } from '@simrs-flow/audit-ledger';
import type { WorkflowEvent } from '@simrs-flow/workflow-core';

export type PatientCategory = 'titipan' | 'naik_kelas' | 'normal';

export interface ProcessedPatient {
  noRm: string;
  name: string;
  workflow: 'ranap' | 'rajal';
  date: string;
  category: PatientCategory;
  nominal: number;
  status: 'done' | 'needs_review';
  operator: string;
  time: string;
  shift: 1 | 2 | 3;
  runId: string;
}

export interface RunDashboardPart {
  patients: ProcessedPatient[];
  gate: { approved: number; rejected: number; pending: number };
}

export interface BillingSummary {
  days: { date: string; amount: number }[];
  titipanToday: number;
  naikKelasToday: number;
  gate: { approved: number; rejected: number; pending: number };
}

const WIB_MS = 7 * 3_600_000;

/** `YYYY-MM-DD` and `HH:MM` in WIB for an ISO instant. */
export function wibParts(iso: string): { date: string; time: string; minutes: number } {
  const shifted = new Date(Date.parse(iso) + WIB_MS).toISOString();
  const hh = Number(shifted.slice(11, 13));
  const mm = Number(shifted.slice(14, 16));
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16), minutes: hh * 60 + mm };
}

/** 1 = 07–14, 2 = 14–20, 3 = 20–07 (WIB). */
export function shiftOf(minutes: number): 1 | 2 | 3 {
  if (minutes >= 7 * 60 && minutes < 14 * 60) return 1;
  if (minutes >= 14 * 60 && minutes < 20 * 60) return 2;
  return 3;
}

/** Rupiah from "Rp 1.234.567", "1234567" or "1.234.567,00"; 0 when unreadable. */
export function rupiah(value: unknown): number {
  const text = String(value ?? '').replace(/,\d{1,2}$/, '').replace(/\D/g, '');
  return text ? Number(text) : 0;
}

const evidenceOf = (event: WorkflowEvent, label: string): unknown =>
  ((event.data as { evidence?: { label?: string; data?: unknown }[] } | undefined)?.evidence ?? [])
    .find((item) => item.label === label)?.data;

interface PlanLike { id?: string; endpointId?: string; payloadSummary?: Record<string, unknown> }

/** Amount a verified tampung bayar plan staged, and the transaction it belongs to. */
function tampungAmount(plan: PlanLike): { amount: number; trx: string } {
  const summary = plan.payloadSummary ?? {};
  // ranap: { grand_total: "Rp …" }; rajal: the payload itself, total inside the dt_bayar form.
  if ('grand_total' in summary) return { amount: rupiah(summary.grand_total), trx: '' };
  const form = new URLSearchParams(String(summary.dt_bayar ?? ''));
  return { amount: rupiah(form.get('txtjumlah_pembayaran')), trx: String(summary.no_transaksi ?? '') };
}

/** `active`: the run is still live in this process, so a waiting gate can still be decided. */
export function summarizeRun(history: LedgerHistory, naikKelasRm: ReadonlySet<string>, active = false): RunDashboardPart {
  const meta = history.meta;
  const gate = { approved: 0, rejected: 0, pending: 0 };
  if (!meta) return { patients: [], gate };
  const workflow: 'ranap' | 'rajal' | undefined = meta.workflowId.startsWith('ranap') ? 'ranap' : meta.workflowId.startsWith('rajal') ? 'rajal' : undefined;
  if (!workflow) return { patients: [], gate };

  const plans = new Map<string, PlanLike>();
  const verified: PlanLike[] = [];
  const waiting = new Set<string>();
  let noRm = '';
  let name = '';
  let titipan = false;
  let outcomes: { patientId?: string; status?: string; transactions?: string[] }[] = [];

  for (const event of history.events) {
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === 'mutation.planned' && data?.id) plans.set(String(data.id), data as PlanLike);
    if (event.type === 'mutation.verified' && data?.planId) {
      const plan = plans.get(String(data.planId));
      if (plan?.endpointId === 'kasir.tampungBayar') verified.push(plan);
    }
    if (meta.mode === 'write' && event.nodeId) {
      if (event.type === 'gate.waiting') waiting.add(event.nodeId);
      if (event.type === 'gate.approved') { gate.approved += 1; waiting.delete(event.nodeId); }
      if (event.type === 'gate.rejected' || event.type === 'gate.expired') { if (event.type === 'gate.rejected') gate.rejected += 1; waiting.delete(event.nodeId); }
    }
    if (event.nodeId === 'normalize_input' && event.type === 'node.succeeded' && !noRm) {
      const items = ((evidenceOf(event, 'reasoning') as { items?: { label?: string; detail?: string }[] } | undefined)?.items ?? []);
      noRm = items.find((item) => item.label === 'Format No RM valid')?.detail ?? '';
    }
    if (event.type === 'log.appended') {
      const message = event.message ?? '';
      const named = /Nama pasien\s*:\s*(.+)$/.exec(message);
      if (!name && named?.[1] && named[1].trim() !== '-') name = named[1].trim();
      // Runs before the normalize_input reasoning item only name the medrec in this log line.
      const medrec = /untuk no rm (\d-\d{2}-\d{2}-\d{2}) dimulai/i.exec(message);
      if (!noRm && medrec?.[1]) noRm = medrec[1];
    }
    if (event.nodeId === 'evaluate_titipan' && /^node\.(succeeded|needs_review)$/.test(event.type)) {
      const rows = evidenceOf(event, 'titipan');
      titipan = Array.isArray(rows) && rows.some((row) => (row as { isTitipan?: boolean }).isTitipan);
    }
    if (/^node\.(succeeded|needs_review)$/.test(event.type)) {
      const rows = (evidenceOf(event, 'rajal.patient-outcomes') as { rows?: unknown } | undefined)?.rows;
      if (Array.isArray(rows)) outcomes = rows as typeof outcomes;
    }
  }
  if (active) gate.pending += waiting.size;

  const { date, time, minutes } = wibParts(meta.startedAt);
  const base = { workflow, date, time, shift: shiftOf(minutes), operator: meta.operator ?? '', runId: meta.runId };
  const amounts = verified.map(tampungAmount);
  const runDone = history.status === 'completed';

  if (workflow === 'ranap') {
    if (!noRm) return { patients: [], gate };
    return {
      patients: [{
        ...base,
        noRm,
        name,
        category: titipan ? 'titipan' : naikKelasRm.has(noRm) ? 'naik_kelas' : 'normal',
        nominal: amounts.reduce((sum, a) => sum + a.amount, 0),
        status: runDone ? 'done' : 'needs_review',
      }],
      gate,
    };
  }
  return {
    patients: outcomes.filter((row) => row.patientId).map((row) => {
      const trx = new Set(row.transactions ?? []);
      return {
        ...base,
        noRm: String(row.patientId),
        name: '',
        category: 'normal' as const,
        nominal: amounts.filter((a) => trx.has(a.trx)).reduce((sum, a) => sum + a.amount, 0),
        status: runDone && row.status === 'lolos' ? 'done' as const : 'needs_review' as const,
      };
    }),
    gate,
  };
}

/** Trailing `days`-day window ending today (WIB), plus today's category counts. */
export function billingSummary(parts: readonly RunDashboardPart[], now: Date, days = 14): BillingSummary {
  const today = wibParts(now.toISOString()).date;
  const window = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1 - i) * 86_400_000);
    return { date: d.toISOString().slice(0, 10), amount: 0 };
  });
  const byDate = new Map(window.map((day) => [day.date, day]));
  const gate = { approved: 0, rejected: 0, pending: 0 };
  let titipanToday = 0;
  let naikKelasToday = 0;
  for (const part of parts) {
    gate.approved += part.gate.approved;
    gate.rejected += part.gate.rejected;
    gate.pending += part.gate.pending;
    for (const patient of part.patients) {
      const day = byDate.get(patient.date);
      if (day) day.amount += patient.nominal;
      if (patient.date === today && patient.category === 'titipan') titipanToday += 1;
      if (patient.date === today && patient.category === 'naik_kelas') naikKelasToday += 1;
    }
  }
  return { days: window, titipanToday, naikKelasToday, gate };
}
