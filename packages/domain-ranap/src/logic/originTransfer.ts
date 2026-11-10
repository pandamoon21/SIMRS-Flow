/**
 * Origin-bill transfer planning — moving the IGD or POLI entry visit's pending
 * charges onto the inpatient bill with `poliklinik.transferIgd`.
 *
 * Legacy sources: `proses_transfer_igd` (ranap_v3.py:9215-9263) for IGD and the
 * tail of `proses_tagihan_poli_asal` (ranap_v3.py:7574-7630) for POLI. Both end
 * in the same `transfer_tagihan_igd` call (ranap_v3.py:6392) — despite its name
 * it transfers POLI source bills too — so the decision is one module here: which
 * rows are still pending, which fields the payload needs, whether anything is
 * missing, and what the plan and its read-back checks look like.
 *
 * The two origins do not behave identically today, and this module does not
 * unify them. Every difference is a field on {@link OriginTransferPolicy}, with
 * the reason (or the lack of one) next to it. The executors stay a thin I/O
 * shell: fetch, call {@link decideOriginTransfer}, emit.
 */

import type { VerificationRule } from '@simrs-flow/workflow-core';

import type { LegacyRow } from './types.js';
import { str } from './types.js';
import { isTransferredRow } from './names.js';
import { sortedRows } from './scalars.js';

/** Per-origin behaviour of the shared transfer decision. */
export interface OriginTransferPolicy {
  /** Operator-facing origin name, used in reasons and read-back descriptions. */
  readonly label: 'IGD' | 'POLI';
  /** `payloadSummary` key prefix: `igd_trx`/`igd_reg` vs `poli_trx`/`poli_reg`. */
  readonly summaryPrefix: 'igd' | 'poli';
  /**
   * Check "nothing pending" before the destination transaction is read.
   *
   * POLI: `true` — `proses_tagihan_poli_asal` returns on `not rows_pending`
   * (ranap_v3.py:7606) and the port skips the destination/amount reads when
   * there is nothing to move.
   * IGD: `false` — `proses_transfer_igd` reads the destination first
   * (ranap_v3.py:9215-9227), and the port reads destination, pending rows and
   * amount up front; an incomplete destination wins over "nothing pending".
   */
  readonly checkPendingBeforeDestination: boolean;
  /**
   * Verdict when the source has no pending row left.
   *
   * IGD `'settled'`: a found IGD source whose charges are all transferred is
   * the finished state, not a missing source (live 2026-10-15: three of three
   * inpatients read "IGD asal tidak ditemukan" for exactly this). The Python
   * reports "Kd tindakan IGD kosong" as a failure here; the port deliberately
   * counts it as done.
   * POLI `'skip'`: "Tidak ada tindakan POLI yang bisa ditransfer | hasil=skip"
   * (ranap_v3.py:7606-7608) — a quiet debug skip, no reasoning line.
   */
  readonly nothingPending: 'settled' | 'skip';
  /**
   * Fall back to the source row's `kd_detkelpenjamin` before the `'15'`
   * default when the destination has none.
   *
   * IGD `false`: `data_transaksi.get("kd_detkelpenjamin", "15")`
   * (ranap_v3.py:9220).
   * POLI `true`: a port addition (introduced with the live-write pilot
   * safeguards); the Python reads only `linked.kd_detkelpenjamin or "15"`
   * (ranap_v3.py:7578). Kept because changing the payload of a live write is
   * out of scope for a refactor — see the drift note in the refactor commit.
   */
  readonly kdDetkelpenjaminFromSource: boolean;
  /** Add the human-readable `perubahan` line to the payload summary (POLI only today). */
  readonly describeChange: boolean;
}

export const IGD_TRANSFER_POLICY: OriginTransferPolicy = {
  label: 'IGD',
  summaryPrefix: 'igd',
  checkPendingBeforeDestination: false,
  nothingPending: 'settled',
  kdDetkelpenjaminFromSource: false,
  describeChange: false,
};

export const POLI_TRANSFER_POLICY: OriginTransferPolicy = {
  label: 'POLI',
  summaryPrefix: 'poli',
  checkPendingBeforeDestination: true,
  nothingPending: 'skip',
  kdDetkelpenjaminFromSource: true,
  describeChange: true,
};

/** `transfer_tagihan_igd` (ranap_v3.py:6392), despite the name, also transfers POLI source bills. */
export function transferIgdPayload(op: {
  noTransaksi: string;
  noTransaksiPoli: string;
  kdUnitPoli: string;
  kdDetkelpenjamin: string;
  biaya: string;
  kdUnit: string;
  kdTindakan: string;
}): Record<string, string> {
  return {
    no_transaksi: op.noTransaksi,
    no_transaksipoli: op.noTransaksiPoli,
    kd_unit_poli: op.kdUnitPoli,
    Kd_DetKelPenjamin: op.kdDetkelpenjamin,
    biaya: op.biaya,
    kd_unit: op.kdUnit,
    kd_tindakan: op.kdTindakan,
  };
}

/** The source rows not yet transferred, and their charge codes in legacy order. */
export interface PendingTransfer {
  pending: LegacyRow[];
  kdTindakanList: string[];
}

/** `[row for row in _sorted_rows(rows) if not _is_transferred_row(row)]` (ranap_v3.py:7599). */
export function pendingTransferRows(sourceRows: readonly LegacyRow[]): PendingTransfer {
  const pending = sourceRows.filter((row) => !isTransferredRow(row));
  const kdTindakanList = sortedRows(pending)
    .map((row) => str(row, 'kd_tindakan'))
    .filter(Boolean);
  return { pending, kdTindakanList };
}

/**
 * Whether the shell needs to read the destination transaction and the transfer
 * amount at all. `false` only when the policy decides "nothing pending" first
 * and nothing is pending — {@link decideOriginTransfer} then never looks at them.
 */
export function needsTransferDestination(policy: OriginTransferPolicy, pending: PendingTransfer): boolean {
  return !(policy.checkPendingBeforeDestination && pending.kdTindakanList.length === 0);
}

/** Everything the transfer decision reads. */
export interface OriginTransferFacts {
  /** The inpatient registration this source belongs to. */
  reg: string;
  /** The source (IGD/POLI) visit row; its `no_transaksi` is the source transaction. */
  source: LegacyRow;
  pending: PendingTransfer;
  /** `poliklinik.getDataTransaksi` for the source registration; `undefined` when not read. */
  destination: LegacyRow | undefined;
  /** `poliklinik.cekJumlahTransfer` for the source transaction; `''` when not read. */
  biaya: string;
}

export type OriginTransferDecision =
  /** Nothing pending, counted as done (IGD). */
  | { verdict: 'settled' }
  /** Nothing pending, quietly skipped (POLI). */
  | { verdict: 'skip' }
  /** The Python refuses the transfer; `reason` is the operator-facing why. */
  | { verdict: 'missing'; reason: string }
  | {
      verdict: 'transfer';
      kdTindakanList: string[];
      noTransaksiPoli: string;
      payload: Record<string, string>;
      payloadSummary: Record<string, unknown>;
      readAfterWriteChecks: VerificationRule[];
    };

/**
 * Decide the transfer of one source bill.
 *
 * The Python refuses outright when the destination transaction or unit is
 * blank, or the transfer amount is empty (ranap_v3.py:9221, 9232, 9238 for IGD;
 * 7598-7608 for POLI); a plan built on a blank destination or a blank amount
 * would post nonsense.
 */
export function decideOriginTransfer(
  policy: OriginTransferPolicy,
  facts: OriginTransferFacts,
): OriginTransferDecision {
  const { label } = policy;
  const sourceTrx = str(facts.source, 'no_transaksi');
  const sourceReg = str(facts.source, 'no_registrasikunjungan');
  const { pending, kdTindakanList } = facts.pending;
  const noTransaksiPoli = str(facts.destination, 'no_transaksi');
  const kdUnitPoli = str(facts.destination, 'kd_unit');
  const nothingPending: OriginTransferDecision = { verdict: policy.nothingPending };

  if (policy.checkPendingBeforeDestination && kdTindakanList.length === 0) return nothingPending;
  if (!noTransaksiPoli || !kdUnitPoli) {
    return { verdict: 'missing', reason: `data transaksi tujuan ${label} tidak lengkap` };
  }
  if (kdTindakanList.length === 0) return nothingPending;
  if (!facts.biaya.trim()) return { verdict: 'missing', reason: `biaya transfer ${label} kosong` };

  const kdDetkelpenjamin =
    str(facts.destination, 'kd_detkelpenjamin') ||
    (policy.kdDetkelpenjaminFromSource ? str(facts.source, 'kd_detkelpenjamin') : '') ||
    '15';
  const { biaya } = facts;
  const prefix = policy.summaryPrefix;
  const payloadSummary: Record<string, unknown> = {
    no_registrasikunjungan: facts.reg,
    [`${prefix}_trx`]: sourceTrx,
    [`${prefix}_reg`]: sourceReg || '-',
    no_transaksipoli: noTransaksiPoli,
    biaya,
    tindakan: kdTindakanList.length,
  };
  if (policy.describeChange) {
    payloadSummary['perubahan'] =
      `${kdTindakanList.length} tindakan ${label} ${sourceTrx} (Rp ${Number(biaya).toLocaleString('id-ID')}) → tagihan rawat inap ${noTransaksiPoli}`;
  }

  return {
    verdict: 'transfer',
    kdTindakanList,
    noTransaksiPoli,
    payload: transferIgdPayload({
      noTransaksi: sourceTrx,
      noTransaksiPoli,
      kdUnitPoli,
      kdDetkelpenjamin,
      biaya,
      // The source unit itself, not the destination's (ranap_v3.py:9257).
      kdUnit: str(facts.source, 'kd_unit'),
      // "format sesuai HAR: 38','16','1929…" — the legacy comment at
      // ranap_v3.py:9201. One code stays a bare code, no separator.
      kdTindakan: kdTindakanList.join("','"),
    }),
    payloadSummary,
    readAfterWriteChecks: sortedRows(pending)
      .filter((row) => str(row, 'kd_tindakan') && str(row, 'urut_tindakan'))
      .map((row) => ({
        description: `Tindakan ${label} ${str(row, 'kd_tindakan')}#${str(row, 'urut_tindakan')} terbaca sudah transfer`,
        endpointId: 'poliklinik.cekStatusTransfer',
        field: '',
        expected: '1',
        match: 'nonEmpty' as const,
        payload: {
          no_transaksi: sourceTrx,
          kd_tindakan: str(row, 'kd_tindakan'),
          urut_tindakan: str(row, 'urut_tindakan'),
        },
      })),
  };
}
