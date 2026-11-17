/**
 * Node facts the UI and the orchestrator read about the ranap workflow: node
 * ids, what the operator does when a run stops at a node, and typed readers for
 * the evidence the executors emit. Pure and light (no executor code), served
 * through the `@simrs-flow/domain-ranap/contract` subpath.
 *
 * `nodes.test.ts` pins {@link RANAP_NODE} to `ranapWorkflow`, so renaming a
 * node fails there and at every compile-time use of the constant.
 */

import { BERKAS_PROGRESS_KEY, readBerkasProgress } from '@simrs-flow/berkas/evaluate';

export const RANAP_NODE = {
  normalizeInput: 'normalize_input',
  loadVisits: 'load_visits',
  rejectVerified: 'reject_verified',
  rejectPaid: 'reject_paid',
  validateSep: 'validate_sep',
  loadKasir: 'load_kasir',
  compareSep: 'compare_sep',
  detectByny: 'detect_byny',
  collectElektromedik: 'collect_elektromedik',
  buildRooms: 'build_rooms',
  syncTglMasuk: 'sync_tgl_masuk',
  loadCharges: 'load_charges',
  evaluateTitipan: 'evaluate_titipan',
  preflightGizi: 'preflight_gizi',
  detectOrigin: 'detect_origin',
  processIgd: 'process_igd',
  processPoli: 'process_poli',
  transferElektromedik: 'transfer_elektromedik',
  scanHangingTrx: 'scan_hanging_trx',
  checkManualBlockers: 'check_manual_blockers',
  detectBlockers: 'detect_blockers',
  syncTindakan: 'sync_tindakan',
  syncVisite: 'sync_visite',
  validateIbs: 'validate_ibs',
  validatePenunjang: 'validate_penunjang',
  validateObatPulang: 'validate_obat_pulang',
  checkBerkas: 'check_berkas',
  preverifySummary: 'preverify_summary',
  recoverGizi: 'recover_gizi',
  checkBalance: 'check_balance',
  finalGate: 'final_gate',
  executeVerifikasi: 'execute_verifikasi',
  tampungBayar: 'tampung_bayar',
  emitSummary: 'emit_summary',
} as const;

export type RanapNodeId = (typeof RANAP_NODE)[keyof typeof RANAP_NODE];

/** What the operator does next when a run stops at the node. Unlisted nodes get the UI's generic advice. */
export const RANAP_NEXT_ACTION: Readonly<Partial<Record<RanapNodeId, string>>> = {
  [RANAP_NODE.normalizeInput]: 'Perbaiki No RM / tanggal di Setup, lalu mulai run lagi.',
  [RANAP_NODE.loadVisits]: 'Pastikan pasien punya kunjungan rawat inap pada tanggal itu di SIMRS.',
  [RANAP_NODE.rejectVerified]: 'Transaksi sudah diverifikasi — tidak perlu diproses lagi. Jika SIMRS sedang lambat, jalankan ulang.',
  [RANAP_NODE.rejectPaid]: 'Kunjungan sudah punya riwayat pembayaran — cek di menu Kasir. Jika SIMRS sedang lambat, jalankan ulang.',
  [RANAP_NODE.validateSep]: 'Cek SEP pasien di menu Pendaftaran SIMRS (tanggal masuk dan PPK), perbaiki, lalu jalankan ulang.',
  [RANAP_NODE.preverifySummary]: 'Buka langkah bertanda kuning/merah sebelum ini, selesaikan di SIMRS, lalu jalankan ulang.',
  [RANAP_NODE.checkBalance]: 'Bandingkan grand total kasir dengan rekapitulasi di SIMRS, rapikan selisihnya, lalu jalankan ulang.',
  [RANAP_NODE.finalGate]: 'Tinjau rencana di Inspector, lalu setujui atau tolak.',
};

/** Reasoning label on `normalize_input` whose detail is the normalised No RM. */
export const RANAP_VALID_RM_REASON = 'Format No RM valid';

/** Evidence label on `evaluate_titipan`: one row per stay, `isTitipan` set on a titipan stay. */
export const RANAP_TITIPAN_EVIDENCE = 'titipan';

/** True when the `evaluate_titipan` evidence data marks any stay as titipan. */
export function readTitipan(data: unknown): boolean {
  return Array.isArray(data) && data.some((row) => Boolean((row as { isTitipan?: boolean } | null)?.isTitipan));
}

export { BERKAS_PROGRESS_KEY, readBerkasProgress };
