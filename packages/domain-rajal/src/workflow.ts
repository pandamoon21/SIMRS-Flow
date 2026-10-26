/**
 * Rawat jalan workflow definition.
 *
 * Migrated from the GreasyFork "PKU-Gombong Patient Processor" userscript,
 * whose procedural startRun → processPatient → processRecord pipeline is
 * reshaped here into an explicit graph. The batch/patient/record fan-out is
 * represented as a linear template workflow; the UI expands dynamic
 * patient/record subgraphs at runtime.
 */

import type { WorkflowDefinition } from '@simrs-flow/workflow-core';

const GROUPS = [
  { id: 'setup', label: 'Persiapan' },
  { id: 'batch', label: 'Antrean' },
  { id: 'record', label: 'Kunjungan' },
  { id: 'penunjang', label: 'Cek Penunjang' },
  { id: 'sep', label: 'SEP' },
  { id: 'payment', label: 'Pembayaran' },
  { id: 'summary', label: 'Ringkasan' },
];

type NodeSpec = [
  id: string,
  label: string,
  group: string,
  kind: WorkflowDefinition['nodes'][number]['kind'],
  critical: boolean,
  phase: string,
  description: string,
  riskLevel?: 'low' | 'medium' | 'high' | 'critical',
];

const NODE_SPECS: NodeSpec[] = [
  ['load_config', 'Muat Konfigurasi', 'setup', 'input', false, 'preparation', 'Memuat pengaturan dan rentang tanggal'],
  ['normalize_ids', 'Normalisasi No RM', 'setup', 'input', true, 'preparation', 'Menormalkan dan menghapus duplikasi No. RM'],
  ['resolve_clinics', 'Tentukan Poli', 'setup', 'validate', true, 'stage-1', 'Menentukan poli yang diproses'],
  ['start_batch', 'Mulai Antrean', 'batch', 'plan', false, 'stage-1', 'Memulai antrean dan merangkum pasien per poli'],
  ['load_history', 'Ambil Riwayat Kunjungan', 'record', 'read', true, 'stage-2', 'Membaca riwayat kunjungan pasien'],
  ['filter_records', 'Filter Kunjungan', 'record', 'validate', true, 'stage-2', 'Memilih kunjungan sesuai tanggal, poli, penjamin, dan status belum bayar'],
  // Legacy source lines 886-892: an oncology plan naming chemotherapy makes the
  // legacy skip the record, and a visit with no exit date is a hard block. Both
  // read the endpoint legacy read (`kasir.getRencanaOnko`,
  // `poliklinik.getDataCaraKeluarTab`).
  //
  // `critical` on both of these is load-bearing, not decoration. They sit
  // upstream of the `parallel` fan-out into the penunjang checks, and a
  // `parallel` edge is an optional join: a non-critical `blocked` here would be
  // swallowed there — the penunjang nodes would run, return a benign `skipped`,
  // and `check_payment` would go on to plan a payment off `scratch.matching`.
  // The penunjang validators themselves stay non-critical because they are
  // direct `merge` predecessors of `validate_sep`, so their block does carry.
  ['check_rencana_onko', 'Cek Rencana Onkologi', 'record', 'validate', true, 'stage-3', 'Memeriksa pengecualian rencana kemoterapi'],
  ['validate_exit_date', 'Cek Tanggal Keluar', 'record', 'validate', true, 'stage-3', 'Memastikan kunjungan sudah memiliki tanggal keluar'],
  ['validate_transaction', 'Cek Jenis Transaksi', 'record', 'validate', true, 'stage-3', 'Memastikan transaksi rawat jalan'],
  ['validate_treatment', 'Validasi Tindakan', 'record', 'validate', true, 'stage-3', 'Memeriksa grup tindakan AND/OR dan daftar pengecualian'],
  ['validate_radiology', 'Validasi Radiologi', 'penunjang', 'validate', false, 'stage-4', 'Memeriksa order dan hasil radiologi'],
  ['validate_elektromedik', 'Validasi Elektromedik', 'penunjang', 'validate', false, 'stage-4', 'Memeriksa kecocokan tindakan dan hasil'],
  ['validate_lab_pa', 'Validasi Lab PA', 'penunjang', 'validate', false, 'stage-4', 'Memeriksa order, detail, dan hasil patologi anatomi'],
  ['validate_lab', 'Validasi Lab Reguler', 'penunjang', 'validate', false, 'stage-4', 'Memeriksa order dan ketersediaan hasil LIS'],
  // Opt-in notice, a leaf off validate_treatment (billed lines known). Declared
  // before validate_sep: the runner takes ready nodes in declaration order and
  // stops at the first critical block, which must not swallow the notice.
  ['check_berkas', 'Kelengkapan Berkas', 'penunjang', 'validate', false, 'stage-4', 'Mencari dokumen wajib klaim di berkas e-klaim (OCR untuk foto)'],
  ['validate_sep', 'Cek SEP', 'sep', 'validate', true, 'stage-5', 'Mencocokkan SEP dan merencanakan koreksi bila diperlukan'],
  ['check_payment', 'Cek Status Pembayaran', 'payment', 'read', true, 'stage-6', 'Memeriksa tagihan yang masih belum dibayar'],
  ['check_verification', 'Cek Order & Verifikasi', 'payment', 'validate', false, 'stage-6', 'Memeriksa order belum terlayani/transfer, penunjang, dan verifikasi'],
  ['submit_payment', 'Tampung Bayar', 'payment', 'mutate', true, 'stage-7', 'Merencanakan pembayaran setelah seluruh syarat terpenuhi', 'critical'],
  ['confirm_result', 'Konfirmasi Hasil', 'payment', 'verify', false, 'stage-7', 'Memeriksa hasil akhir proses pembayaran'],
  ['emit_patient_summary', 'Ringkasan Pasien', 'summary', 'summary', false, 'stage-8', 'Merangkum hasil proses pasien'],
  ['emit_batch_summary', 'Ringkasan Antrean', 'summary', 'summary', false, 'stage-8', 'Merangkum hasil seluruh antrean'],
];

type EdgeSpec = [from: string, to: string, type: WorkflowDefinition['edges'][number]['type']];

const EDGE_SPECS: EdgeSpec[] = [
  ['load_config', 'normalize_ids', 'sequential'],
  ['normalize_ids', 'resolve_clinics', 'sequential'],
  ['resolve_clinics', 'start_batch', 'sequential'],
  ['start_batch', 'load_history', 'sequential'],
  ['load_history', 'filter_records', 'sequential'],
  ['filter_records', 'check_rencana_onko', 'sequential'],
  ['check_rencana_onko', 'validate_exit_date', 'sequential'],
  ['validate_exit_date', 'validate_transaction', 'sequential'],
  ['validate_transaction', 'validate_treatment', 'sequential'],
  ['validate_treatment', 'validate_radiology', 'parallel'],
  ['validate_treatment', 'validate_elektromedik', 'parallel'],
  ['validate_treatment', 'validate_lab_pa', 'parallel'],
  ['validate_treatment', 'validate_lab', 'parallel'],
  ['validate_treatment', 'check_berkas', 'parallel'],
  ['validate_radiology', 'validate_sep', 'merge'],
  ['validate_elektromedik', 'validate_sep', 'merge'],
  ['validate_lab_pa', 'validate_sep', 'merge'],
  ['validate_lab', 'validate_sep', 'merge'],
  ['validate_sep', 'check_payment', 'sequential'],
  ['check_payment', 'check_verification', 'sequential'],
  ['check_verification', 'submit_payment', 'guard'],
  ['submit_payment', 'confirm_result', 'sequential'],
  ['confirm_result', 'emit_patient_summary', 'sequential'],
  ['emit_patient_summary', 'emit_batch_summary', 'sequential'],
];

/** Off unless the run's `enabled` map turns them on (Setup per-run switch). */
export const OPT_IN_NODES: ReadonlySet<string> = new Set(['check_berkas']);

/** Canvas columns, left→right, following the legacy rajal flow. */
const PHASES = [
  { id: 'preparation', label: 'Persiapan', description: 'Konfigurasi run dan daftar No. RM' },
  { id: 'stage-1', label: 'Poli & Antrean', description: 'Poli yang diproses dan antrean pasien' },
  { id: 'stage-2', label: 'Kunjungan', description: 'Riwayat kunjungan yang bisa dipayment' },
  { id: 'stage-3', label: 'Kelayakan & Tindakan', description: 'Onko, tanggal keluar, jenis transaksi, tindakan' },
  { id: 'stage-4', label: 'Hasil Penunjang', description: 'Radiologi, elektromedik, lab PA, lab reguler' },
  { id: 'stage-5', label: 'SEP', description: 'SEP pendaftaran dibandingkan dengan SEP kasir' },
  { id: 'stage-6', label: 'Sebelum Pembayaran', description: 'Status bayar, order belum transfer/terlayani, verifikasi' },
  { id: 'stage-7', label: 'Tampung Bayar', description: 'Rencana pembayaran dan konfirmasi hasil' },
  { id: 'stage-8', label: 'Ringkasan', description: 'Ringkasan pasien dan run' },
];

export const rajalWorkflow: WorkflowDefinition = {
  id: 'rajal-patient-processor',
  version: '0.2.0',
  label: 'Rawat Jalan / RAJAL',
  domain: 'rajal',
  nodes: NODE_SPECS.map(([id, label, group, kind, critical, phase, description, riskLevel]) => ({
    id,
    label,
    group,
    kind,
    executorRef: `rajal.${toCamel(id)}`,
    critical,
    defaultEnabled: !OPT_IN_NODES.has(id),
    ...(riskLevel ? { riskLevel } : {}),
    ui: { phase, description },
  })),
  edges: EDGE_SPECS.map(([source, target, type]) => ({
    id: `${source}__${target}`,
    source,
    target,
    type,
  })),
  layout: { mode: 'manual', groups: GROUPS, phases: PHASES },
  policies: {
    defaultMode: 'preview',
    mutationAllowlist: ['kasir.tampungBayar', 'rekamMedis.simpanSep', 'verifikator.simpanVerifikasi'],
  },
};

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
