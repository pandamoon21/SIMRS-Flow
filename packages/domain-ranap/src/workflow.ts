/**
 * Rawat inap workflow definition — 33 steps.
 *
 * The graph mirrors the step sequence of `ranap_v3.py`'s `main()`, which is
 * the behavioural authority for inpatient billing. The original 24-node graph
 * came from `puisi_v2.js` and was missing seven steps that `main()` performs
 * between the daily-charge sync and the payment:
 *
 *   evaluate_titipan       — `_log_pasien_titipan_status` after room-day assignment
 *   scan_hanging_trx       — `log_transaksi_terkait_menggantung`
 *   check_manual_blockers  — `_collect_bank_darah_blockers` / `_collect_cathlab_blockers`
 *   preverify_summary      — `_emit_pre_verification_summary` + the sync-issue gate
 *   recover_gizi           — `_recover_gizi_blocker_until_clear`
 *   check_balance          — `cek_balance_total_tagihan`
 *   tampung_bayar          — `proses_tampung_bayar_group`
 *
 * Two more were added after an adversarial review found steps `main()` performs
 * that no node reproduced:
 *
 *   sync_tgl_masuk         — `_sync_tgl_masuk_awal_rawat_inap` (ranap_v3.py:16186),
 *                            a real `kasir.updateTglMasuk` write that aligns the
 *                            first stay's admission date to the SEP date
 *   load_charges           — `ambil_listtindakan` per stay. The Python's
 *                            consumers (`validate_ibs_consistency`:8830,
 *                            `validate_obat_pulang_for_group`:13203,
 *                            `_check_missing_igd_depo_or_obat_for_verification`)
 *                            each fetch the charge lines themselves; hanging
 *                            them off origin detection made four validations
 *                            silently pass on no data for a newborn.
 *
 * `compare_sep` is a `mutate` node rather than a `validate` node because the
 * legacy step writes: a SEP mismatch between kasir and pendaftaran triggers
 * `update_sep`. Declaring it `mutate` is what routes its write through the
 * plan/approval path and into the audit trail. `preflight_gizi` is `mutate` for
 * the same reason — `ensure_ordergizi_terkirim` (ranap_v3.py:15089) sends the
 * pending diet orders, so the step has to be able to propose those sends.
 *
 * The graph shape (sequential / guard / merge / parallel / branch edges) is
 * preserved so the React Flow canvas mirrors the original pipeline, while the
 * execution semantics live in the headless runner.
 */

import type { WorkflowDefinition } from '@simrs-flow/workflow-core';

const GROUPS = [
  { id: 'preflight', label: 'Persiapan' },
  { id: 'sep', label: 'SEP & Identitas Tagihan' },
  { id: 'penunjang', label: 'Penunjang' },
  { id: 'ruangan', label: 'Kamar' },
  { id: 'gizi', label: 'Gizi' },
  { id: 'asal_masuk', label: 'Asal Masuk (IGD / POLI)' },
  { id: 'blocker', label: 'Transaksi Menggantung & Blocker' },
  { id: 'tindakan', label: 'Tindakan & IBS' },
  { id: 'visite', label: 'Visite' },
  { id: 'obat', label: 'Obat' },
  { id: 'verifikasi', label: 'Verifikasi, Balance & Bayar' },
];

/** Canvas columns, left→right, following the legacy ranap_v4 flow diagram. */
const PHASES = [
  { id: 'persiapan', label: 'Persiapan', description: 'No. RM dan riwayat kunjungan dari menu kasir' },
  { id: 'kelayakan', label: 'Siap Dibayar?', description: 'Tolak registrasi yang sudah diverifikasi atau dibayar' },
  { id: 'sep', label: 'SEP', description: 'SEP pendaftaran dibandingkan dengan SEP kasir' },
  { id: 'kamar', label: 'Kamar & Tgl Masuk', description: 'Riwayat kamar, tanggal masuk, tindakan, titipan' },
  { id: 'cara_masuk', label: 'Gizi & Cara Masuk', description: 'Order gizi dan asal masuk IGD / POLI' },
  { id: 'blocker', label: 'Penunjang & Blocker', description: 'Elektromedik, transaksi menggantung, order penunjang' },
  { id: 'tindakan', label: 'Tindakan & Visite', description: 'Tindakan harian, visite, IBS, penunjang, obat pulang' },
  { id: 'pra_verifikasi', label: 'Pra-Verifikasi', description: 'Ringkasan blocker, gizi, dan balance' },
  { id: 'verifikasi', label: 'Verifikasi & Bayar', description: 'Persetujuan, verifikasi, tampung bayar, ringkasan' },
];

/** Off unless the run's `enabled` map turns them on. */
export const OPT_IN_NODES: ReadonlySet<string> = new Set(['check_berkas']);

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
  ['normalize_input', 'Periksa Input', 'preflight', 'input', false, 'persiapan', 'Menormalkan No. RM, tanggal, dan opsi run'],
  ['load_visits', 'Ambil Kunjungan', 'preflight', 'read', true, 'persiapan', 'Membaca riwayat kunjungan rawat inap dari menu kasir'],
  ['reject_verified', 'Cek Sudah Diverifikasi', 'preflight', 'validate', true, 'kelayakan', 'Melewati registrasi yang sudah diverifikasi'],
  ['reject_paid', 'Cek Sudah Dibayar', 'preflight', 'validate', true, 'kelayakan', 'Melewati registrasi yang sudah dibayar'],
  ['validate_sep', 'Cek SEP', 'sep', 'validate', true, 'sep', 'Mencari SEP RITL dari menu pendaftaran'],
  ['load_kasir', 'Ambil Data Kasir', 'sep', 'read', true, 'sep', 'Membaca SEP dan identitas tagihan di menu kasir'],
  ['compare_sep', 'Bandingkan & Koreksi SEP', 'sep', 'mutate', false, 'sep', 'Membandingkan SEP pendaftaran dengan kasir; rencana update SEP bila beda', 'high'],
  ['detect_byny', 'Cek Bayi Baru Lahir (BYNY)', 'sep', 'validate', false, 'sep', 'Mendeteksi kasus BYNY dan SEP yang dipakai'],
  ['collect_elektromedik', 'Kumpulkan Elektromedik', 'penunjang', 'read', false, 'kamar', 'Mengumpulkan tagihan elektromedik per registrasi'],
  ['build_rooms', 'Susun Kamar', 'ruangan', 'plan', true, 'kamar', 'Menyusun riwayat kamar dan hari rawat'],
  ['sync_tgl_masuk', 'Sinkronisasi Tanggal Masuk', 'ruangan', 'mutate', false, 'kamar', 'Menyamakan tanggal masuk awal dengan tanggal SEP', 'high'],
  ['load_charges', 'Ambil Tindakan Ranap', 'tindakan', 'read', false, 'kamar', 'Membaca daftar tindakan setiap kamar'],
  ['evaluate_titipan', 'Evaluasi Titipan', 'ruangan', 'validate', false, 'kamar', 'Memeriksa kelas titipan dan biaya kamar'],
  ['preflight_gizi', 'Cek Awal Order Gizi', 'gizi', 'mutate', false, 'cara_masuk', 'Mengirim order gizi yang masih tertunda', 'high'],
  ['detect_origin', 'Deteksi Cara Masuk', 'asal_masuk', 'validate', true, 'cara_masuk', 'Menentukan asal masuk IGD atau POLI per registrasi'],
  ['process_igd', 'Proses IGD', 'asal_masuk', 'plan', false, 'cara_masuk', 'Menyelaraskan dan mentransfer tagihan IGD asal'],
  ['process_poli', 'Proses Poliklinik', 'asal_masuk', 'plan', false, 'cara_masuk', 'Menyelaraskan dan mentransfer tagihan POLI asal'],
  ['transfer_elektromedik', 'Transfer Elektromedik', 'penunjang', 'mutate', false, 'blocker', 'Mentransfer tagihan elektromedik ke tagihan ranap', 'high'],
  ['scan_hanging_trx', 'Cek Transaksi Menggantung', 'blocker', 'validate', false, 'blocker', 'Mencari transaksi menggantung di sekitar masa rawat'],
  // Not critical: `main()` collects the blockers (ranap_v3.py:16544-16592), then
  // still runs steps 3-7 and only skips *that registration's* verification
  // (16799-16809). `preverify_summary` is the single gate, keyed on the alerts
  // these two register — see `_get_blocking_reg_alerts` (ranap_v3.py:1135).
  ['check_manual_blockers', 'Cek Blocker Manual', 'blocker', 'validate', false, 'blocker', 'Mencatat kondisi yang harus diselesaikan manual'],
  ['detect_blockers', 'Deteksi Blocker Penunjang', 'blocker', 'validate', false, 'blocker', 'Mencari order penunjang belum transfer/terlayani'],
  ['sync_tindakan', 'Sinkronisasi Tindakan', 'tindakan', 'mutate', false, 'tindakan', 'Merencanakan tindakan harian rawat inap', 'high'],
  ['sync_visite', 'Sinkronisasi Visite Dokter', 'visite', 'mutate', false, 'tindakan', 'Merencanakan visite dan konsultasi spesialis', 'high'],
  ['validate_ibs', 'Validasi IBS', 'tindakan', 'validate', false, 'tindakan', 'Memeriksa konsistensi tindakan IBS'],
  ['validate_penunjang', 'Validasi Penunjang', 'penunjang', 'validate', false, 'tindakan', 'Memeriksa hasil penunjang terhadap tagihan'],
  ['validate_obat_pulang', 'Validasi Obat Pulang', 'obat', 'validate', false, 'tindakan', 'Mencocokkan resep obat pulang dengan tagihan'],
  // Opt-in notice (Setup › "Cek kelengkapan berkas (OCR)"): a leaf with no
  // dependants, so it can never hold or skip the gate. It hangs off
  // evaluate_titipan (charges read, titipan known), not off the critical checks,
  // and is declared before them: the runner takes ready nodes in declaration
  // order and stops at the first critical block (e.g. check_balance "belum
  // balance", live 2026-10-20), and a stop must not swallow the notice.
  ['check_berkas', 'Kelengkapan Berkas', 'verifikasi', 'validate', false, 'pra_verifikasi', 'Mencari dokumen wajib klaim di berkas e-klaim (OCR untuk foto)'],
  ['preverify_summary', 'Ringkasan Pra-Verifikasi', 'verifikasi', 'validate', true, 'pra_verifikasi', 'Merangkum blocker sebelum verifikasi'],
  ['recover_gizi', 'Pulihkan Blocker Gizi', 'gizi', 'mutate', false, 'pra_verifikasi', 'Membersihkan order gizi yang menahan verifikasi', 'high'],
  ['check_balance', 'Cek Keseimbangan Tagihan', 'verifikasi', 'validate', true, 'pra_verifikasi', 'Memeriksa balance tagihan sebelum verifikasi'],
  ['final_gate', 'Gerbang Akhir', 'verifikasi', 'gate', true, 'verifikasi', 'Persetujuan operator sebelum verifikasi', 'critical'],
  ['execute_verifikasi', 'Jalankan Verifikasi', 'verifikasi', 'mutate', true, 'verifikasi', 'Merencanakan verifikasi per registrasi', 'critical'],
  ['tampung_bayar', 'Tampung Bayar', 'verifikasi', 'mutate', true, 'verifikasi', 'Merencanakan tampung bayar setelah verifikasi', 'critical'],
  ['emit_summary', 'Ringkasan', 'verifikasi', 'summary', false, 'verifikasi', 'Ringkasan hasil verifikasi (TSV)'],
];

type EdgeSpec = [from: string, to: string, type: WorkflowDefinition['edges'][number]['type'], condition?: string, label?: string];

const EDGE_SPECS: EdgeSpec[] = [
  ['normalize_input', 'load_visits', 'sequential'],
  ['load_visits', 'reject_verified', 'guard', undefined, 'belum verifikasi'],
  ['load_visits', 'reject_paid', 'guard', undefined, 'belum bayar'],
  ['reject_verified', 'validate_sep', 'merge'],
  ['reject_paid', 'validate_sep', 'merge'],
  ['validate_sep', 'load_kasir', 'parallel'],
  ['validate_sep', 'compare_sep', 'parallel'],
  ['load_kasir', 'detect_byny', 'merge'],
  ['compare_sep', 'detect_byny', 'merge'],
  ['detect_byny', 'collect_elektromedik', 'sequential'],
  ['collect_elektromedik', 'build_rooms', 'sequential'],
  ['build_rooms', 'sync_tgl_masuk', 'sequential'],
  ['sync_tgl_masuk', 'load_charges', 'sequential'],
  ['load_charges', 'evaluate_titipan', 'sequential'],
  ['evaluate_titipan', 'preflight_gizi', 'sequential'],
  ['preflight_gizi', 'detect_origin', 'sequential'],
  ['detect_origin', 'process_igd', 'branch', 'origin_igd', 'IGD'],
  ['detect_origin', 'process_poli', 'branch', 'origin_poli', 'POLI'],
  ['detect_origin', 'transfer_elektromedik', 'parallel'],
  ['process_igd', 'transfer_elektromedik', 'merge'],
  ['process_poli', 'transfer_elektromedik', 'merge'],
  ['transfer_elektromedik', 'scan_hanging_trx', 'sequential'],
  ['scan_hanging_trx', 'check_manual_blockers', 'sequential'],
  ['check_manual_blockers', 'detect_blockers', 'sequential'],
  ['detect_blockers', 'sync_tindakan', 'sequential'],
  ['sync_tindakan', 'sync_visite', 'sequential'],
  ['sync_visite', 'validate_ibs', 'sequential'],
  ['validate_ibs', 'validate_penunjang', 'sequential'],
  ['validate_penunjang', 'validate_obat_pulang', 'sequential'],
  ['validate_obat_pulang', 'preverify_summary', 'sequential'],
  ['preverify_summary', 'recover_gizi', 'sequential'],
  ['recover_gizi', 'check_balance', 'sequential'],
  ['check_balance', 'final_gate', 'sequential'],
  ['evaluate_titipan', 'check_berkas', 'sequential'],
  ['final_gate', 'execute_verifikasi', 'guard', undefined, 'disetujui'],
  ['execute_verifikasi', 'tampung_bayar', 'guard', undefined, 'terverifikasi'],
  // Optional joins: the summary row is wanted even when Setup switches
  // Verifikasi / Tampung Bayar off (a cleanup-only run), so neither edge is required.
  ['tampung_bayar', 'emit_summary', 'parallel'],
  ['check_balance', 'emit_summary', 'parallel'],
];

export const ranapWorkflow: WorkflowDefinition = {
  id: 'ranap-verifikasi-tampung-bayar',
  version: '0.4.0',
  label: 'Rawat Inap / RANAP',
  domain: 'ranap',
  nodes: NODE_SPECS.map(([id, label, group, kind, critical, phase, description, riskLevel]) => ({
    id,
    label,
    group,
    kind,
    executorRef: `ranap.${toCamel(id)}`,
    critical,
    // Only the OCR notice is opt-in (it downloads the whole claim bundle).
    defaultEnabled: !OPT_IN_NODES.has(id),
    ...(riskLevel ? { riskLevel } : {}),
    ui: { phase, description },
  })),
  edges: EDGE_SPECS.map(([source, target, type, condition, label]) => ({
    id: `${source}__${target}`,
    source,
    target,
    type,
    ...(condition ? { condition } : {}),
    ...(label ? { label } : {}),
  })),
  layout: { mode: 'manual', groups: GROUPS, phases: PHASES },
  policies: {
    defaultMode: 'preview',
    // Every endpoint any mutate node in this graph can propose. A plan whose
    // endpoint is absent here is refused by the client even after approval
    // (safety control #2, `enforceMutationGate`).
    mutationAllowlist: [
      'rekamMedis.simpanSep',
      'elektromedik.transferTagihan',
      'poliklinik.batalTransfer',
      'poliklinik.transferIgd',
      'poliklinik.updateTgl',
      'laboratorium.batalTransfer',
      'laboratorium.bukaBhp',
      'laboratorium.tutupBhp',
      'laboratorium.transferLab',
      'kasir.updateTgl',
      'kasir.updateTglMasuk',
      'penatajasaInap.updateTgl',
      'penatajasaInap.tambahTindakanPolis',
      'penatajasaInap.hapusTindakan',
      // `_tampung_pelaksana_checked` (ranap_v3.py:4440) posts to the *poliklinik*
      // controller even for an inpatient line; both the daily-tindakan sweep and
      // the visite repair propose it.
      'poliklinik.tampungPelaksana',
      'verifikator.tambahTindakanPolis',
      'verifikator.hapusTindakan',
      // `_ensure_tindakan_belum_terverifikasi` (ranap_v3.py:12286) and
      // `_ensure_tindakan_belum_terverifikasi_for_write` (4388) reopen a bill so
      // an already-verified charge line can be corrected. The port turns that
      // into an approvable plan rather than a silent side effect, so the
      // endpoint has to be on the allowlist for the gate to apply it.
      'verifikator.batalVerifikasi',
      'penatajasaInap.kirimOrderGizi',
      'penatajasaInap.batalKirimOrderGizi',
      'penatajasaInap.hapusDetailOrderGizi',
      'verifikator.simpanVerifikasi',
      'kasir.tampungBayar',
    ],
  },
};

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
