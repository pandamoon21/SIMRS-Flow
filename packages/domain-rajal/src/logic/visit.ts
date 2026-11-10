/**
 * Visit-level verdicts for rawat jalan: which history rows are billable
 * candidates, discharge (exit date), and the retired oncology-plan check.
 *
 * Everything here is a pure function: no network, no clock, no module state.
 * Each one is the *decision* half of a legacy guard, with every remote read
 * hoisted into a parameter and the supplying endpoint named. `executors.ts`
 * is the I/O shell that fetches, calls, and turns the verdict into a
 * `StepResult`.
 */
import { normalizeDate } from '@simrs-flow/evomedis-client';
import { RAJAL_ONCOLOGY_PLAN_KEYWORD } from '../rules.js';
import type { RajalInput, RajalRecordRow } from '../types.js';

export interface RajalOncologyPlanVerdict {
  /** True when the plan text names chemotherapy — legacy skips the record. */
  blocking: boolean;
  /** The `isi_perencanaan` text as read, for the audit trail. */
  plan: string;
  /**
   * False when the response carried no `isi_perencanaan` at all, so the rule
   * could not be evaluated. Legacy treated that as "no chemo" and paid;
   * the port refuses to call an unreadable input clean.
   */
  readable: boolean;
}

/**
 * Legacy source lines 886-889.
 *
 * Hoisted fetch: `kasir.getRencanaOnko` — POST
 * `kasir/kasir/get_rencana_onko` ({no_registrasikunjungan}) → `response`.
 */
export function evaluateRajalOncologyPlan(response: unknown): RajalOncologyPlanVerdict {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { blocking: false, plan: '', readable: false };
  }
  const raw = (response as Record<string, unknown>)['isi_perencanaan'];
  if (typeof raw !== 'string') return { blocking: false, plan: '', readable: false };
  const plan = raw.trim();
  return {
    blocking: plan.toLowerCase().includes(RAJAL_ONCOLOGY_PLAN_KEYWORD),
    plan,
    readable: true,
  };
}

export interface RajalExitDateVerdict {
  /** True when a `tgl_keluar` field was present at all. */
  readable: boolean;
  /** True when that field carried a value — legacy blocks when it does not. */
  present: boolean;
  date: string;
}

/**
 * Field-level half of the exit-date guard: `''` (or whitespace) is a visit the
 * clinic has not closed; `undefined`/`null` means the caller had no field to
 * hand over at all, which is not a decision.
 *
 * Prefer {@link evaluateRajalExitDateResponse}, which applies legacy's own
 * reading to a whole `getdatacarakeluar_tab` reply.
 */
export function evaluateRajalExitDate(tglKeluar: string | undefined | null): RajalExitDateVerdict {
  if (tglKeluar === undefined || tglKeluar === null) {
    return { readable: false, present: false, date: '' };
  }
  const date = tglKeluar.trim();
  return { readable: true, present: date.length > 0, date };
}

/**
 * Legacy source lines 891-892: no exit date on the visit means the clinic has
 * not discharged the patient, and the legacy refuses to bill.
 *
 * Hoisted fetch: `poliklinik.getDataCaraKeluarTab` — POST
 * `poliklinik/poliklinik/getdatacarakeluar_tab` ({no_registrasikunjungan}) →
 * `response`. This is the endpoint legacy itself read; the port used to
 * substitute `tgl_keluar` off the `kasir/kasir/gethistorykunjungan` row, which
 * was never confirmed to carry it for outpatient rows.
 *
 * Legacy's test is `if(!ck?.tgl_keluar)`, so once the discharge tab has
 * answered, an absent field, a null and an empty string all mean the same
 * thing — not discharged — and all block. Only a reply that is not a record at
 * all (null, an array, a bare string) is unreadable, and an unreadable read is
 * never a pass.
 */
export function evaluateRajalExitDateResponse(response: unknown): RajalExitDateVerdict {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { readable: false, present: false, date: '' };
  }
  const raw = (response as Record<string, unknown>)['tgl_keluar'];
  return evaluateRajalExitDate(typeof raw === 'string' ? raw : '');
}

/**
 * Legacy `getEffectiveDateRange` (source line 335), plus legacy `autosaveCfg`
 * (source line 413): on a discovery run the fetch period *is* the run's range
 * (`c.dateFrom=fetchFrom||c.targetDate`). Matching visits against a different
 * window than the one the batch was discovered over would either drop rows the
 * report listed or admit rows it did not.
 */
export function rajalEffectiveRange(cfg: Pick<RajalInput, 'date' | 'dateFrom' | 'dateTo' | 'discovery'>): { from: string; to: string } {
  return {
    from: cfg.dateFrom || cfg.discovery?.from || cfg.date,
    to: cfg.dateTo || cfg.discovery?.to || cfg.date,
  };
}

/** The visit's own date, falling back to the requested batch date. */
export function recordVisitDate(record: Pick<RajalRecordRow, 'tgl_masuk'>, fallback: string): string {
  return (record.tgl_masuk ? normalizeDate(record.tgl_masuk) : null) ?? fallback;
}

/**
 * Legacy `findMatchingRecords` candidate test (source lines 728-745): unpaid,
 * an accepted penjamin, and admitted inside the run's range.
 *
 * Legacy compares `tgl_masuk.slice(0,10)` against the range as strings
 * (source line 738), so a row with no admission date never matches. The
 * previous port let an undated row through, which is fail-open.
 */
export function isRajalBillableCandidate(
  row: Pick<RajalRecordRow, 'status_bayar' | 'nama_penjamin' | 'tgl_masuk'>,
  range: { from: string; to: string },
  acceptedPenjamin: readonly string[],
): boolean {
  const unpaid = (row.status_bayar ?? '').toUpperCase().replace(/\s/g, '') === 'BELUM';
  const penjaminOk = acceptedPenjamin.some((k) => (row.nama_penjamin ?? '').toUpperCase().includes(k.toUpperCase()));
  const visitDate = row.tgl_masuk ? normalizeDate(row.tgl_masuk) : null;
  const dateOk = visitDate !== null && visitDate >= range.from && visitDate <= range.to;
  return unpaid && penjaminOk && dateOk;
}

/**
 * `kasir.getDataKunjunganTab.kd_instalasi` — '1' Rawat Jalan, '2' Rawat Inap,
 * '3' IGD, '14' Penunjang. Only '1' is the outpatient cashier's to bill;
 * Rawat Inap is called out on its own because it is the case legacy rejected
 * (source line 894), everything else (IGD / penunjang / unknown) is "not rajal".
 */
export function classifyRajalInstalasi(kdInstalasi: string | undefined): 'rajal' | 'inpatient' | 'other' {
  const instalasi = (kdInstalasi ?? '').trim();
  if (instalasi === '2') return 'inpatient';
  return instalasi === '1' ? 'rajal' : 'other';
}
