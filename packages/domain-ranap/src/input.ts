/**
 * Ranap run input: the Setup form's draft → a validated {@link RanapInput} plus
 * the per-run node switches. Pure and light (no executor code), served through
 * the `@simrs-flow/domain-ranap/contract` subpath so the UI renders the form
 * while the domain owns what a valid inpatient run is.
 *
 * The draft carries the four `ranap_v3.py` `main()` switches an operator
 * legitimately needs per run: `debug_mode`, `skip_verifikasi_sep`,
 * `enable_tampung_bayar` and `user_proses` for the summary row.
 */

import { isIsoDate, splitList, type RunInputResult } from '@simrs-flow/workflow-core';
import type { RanapInput } from './executors.js';
import { RANAP_NODE } from './nodes.js';

export interface RanapDraft {
  noRm: string;
  tanggal: string;
  toleranceDays: string;
  acceptedPenjaminKeywords: string;
  /** Optional run switches; absent means the legacy default (all off). */
  debugMode?: boolean;
  skipVerifikasiSep?: boolean;
  /** Absent/true = verify (legacy default). False runs the checks only: no gate, verification, payment. */
  enableVerifikasi?: boolean;
  enableTampungBayar?: boolean;
  /** Opt-in Kelengkapan Berkas notice (downloads and reads the e-klaim bundle). */
  cekBerkas?: boolean;
  userProses?: string;
}

/** Nodes the runner skips when verification is off; their dependants skip with them. */
export const RANAP_VERIFY_OFF: Record<string, boolean> = {
  [RANAP_NODE.finalGate]: false,
  [RANAP_NODE.executeVerifikasi]: false,
  [RANAP_NODE.tampungBayar]: false,
};

/** Date tolerance in days around `tanggal`: default 3, clamped to 0–14. */
export function clampToleranceDays(value: string): number {
  if (!value.trim()) return 3;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 0), 14);
}

export function buildRanapInput(draft: RanapDraft): RunInputResult<RanapInput> {
  const patientIds = splitList(draft.noRm);
  const noRm = patientIds[0] ?? '';
  if (patientIds.length === 0) return { error: 'No. RM wajib diisi untuk rawat inap.', summary: 'Ranap belum lengkap' };
  // The ranap workflow bills ONE patient per run (ranap_v3 main() takes one medrec);
  // the engine reads only the first id, so a second one would be silently ignored.
  if (patientIds.length > 1) {
    return { error: `Rawat inap diproses satu pasien per run — sisakan satu No. RM (${patientIds.length} diisi).`, summary: `Ranap ${patientIds.length} pasien` };
  }
  if (!isIsoDate(draft.tanggal)) {
    return { error: 'Tanggal rawat inap wajib diisi dengan format valid.', summary: `Ranap ${noRm}` };
  }

  const acceptedPenjaminKeywords = splitList(draft.acceptedPenjaminKeywords);
  const toleranceDays = clampToleranceDays(draft.toleranceDays);
  const userProses = (draft.userProses ?? '').trim();
  const verify = draft.enableVerifikasi !== false;
  const input: RanapInput = {
    noRm,
    patientIds,
    tanggal: draft.tanggal,
    toleranceDays,
    acceptedPenjaminKeywords: acceptedPenjaminKeywords.length ? acceptedPenjaminKeywords : undefined,
    debugMode: draft.debugMode === true,
    skipVerifikasiSep: draft.skipVerifikasiSep === true,
    // Payment is staged only for registrations whose verification was planned, so it follows verification.
    enableTampungBayar: verify && draft.enableTampungBayar === true,
    ...(userProses ? { userProses } : {}),
  };
  const flags = [
    draft.debugMode ? 'debug' : '',
    draft.skipVerifikasiSep ? 'skip SEP' : '',
    verify ? '' : 'tanpa verifikasi',
    input.enableTampungBayar ? 'tampung bayar' : '',
    draft.cekBerkas ? 'cek berkas' : '',
  ].filter(Boolean);
  const suffix = flags.length ? ` · ${flags.join(', ')}` : '';
  return {
    input,
    // Checks-only run: the runner skips the gate and everything after it.
    // The berkas notice is an opt-in node (defaultEnabled false) switched on here.
    ...(verify && !draft.cekBerkas ? {} : { enabled: { ...(verify ? {} : RANAP_VERIFY_OFF), ...(draft.cekBerkas ? { [RANAP_NODE.checkBerkas]: true } : {}) } }),
    summary: `Ranap ${patientIds.length} pasien @ ${draft.tanggal} (±${toleranceDays} hari)${suffix}`,
  };
}
