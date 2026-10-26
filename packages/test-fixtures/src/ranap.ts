/**
 * Sanitized ranap fixtures + a fixture map for FixtureTransport.
 *
 * All values are synthetic. No real patient data.
 *
 * This is the golden master for the happy path: one payable BPJS inpatient
 * visit, unverified and unpaid, with a valid RITL SEP, a two-day stay in a
 * class-3 room entered via Poliklinik, no penunjang outstanding, no blockers,
 * and a cashier total that balances against the rekapitulasi. A dry run over it
 * must reach the gate and produce mutation plans without a single write.
 *
 * Every endpoint the 33-step pipeline reads on that path has an entry here.
 * `FixtureTransport` answers an unregistered id with a 404, which the executors
 * treat as "read unavailable" — so a missing entry shows up as a step quietly
 * losing its input rather than as a failure. Add the entry when you add the read.
 *
 * **A passing fixture run does not prove the request was right.**
 * `FixtureTransport` keys purely on the endpoint id (the `x-endpoint-id` header)
 * and ignores the payload entirely, so a read that sends the wrong field name —
 * `txtmedrec` where the backend wants `nomedrec`, `no_order` where it wants
 * `no_trans` — or that puts a GET's parameters in a discarded body still gets the
 * canned answer here and still passes. The request shape is proved only by the
 * `request shapes` tests in `packages/domain-ranap/src/domain-ranap.test.ts`,
 * which assert against `FixtureTransport.calls`. Add a case there whenever you
 * add or change a read.
 *
 * Deliberate asymmetries in this file, each one load-bearing:
 *  - `no_kk` is a 16-digit Central Java NIK (prefix `33`) while `no_asuransi`
 *    carries the real BPJS card, so `find_sep`'s three-condition fallback has to
 *    fire before the SEP lookup can succeed.
 *  - `kd_kelasperawatan` / `kd_kamarperawatan` differ across the room row, the
 *    inpatient tab and tab2, so the three-way `||` precedence in `buildRooms` is
 *    observable rather than a coincidence.
 *  - the kasir visit history and the inpatient visit tab differ in `tgl_masuk`
 *    (registration time vs room-entry time, as they do in SIMRS), so the
 *    empty-history fallback in `loadVisits` is distinguishable from the primary
 *    path.
 */

import type { FixtureEntry } from '@simrs-flow/evomedis-client';

export const RANAP_HAPPY_INPUT = {
  noRm: '012345',
  tanggal: '2026-06-10',
  toleranceDays: 3,
};

/** Same input with the legacy `debug_mode` gate open. */
export const RANAP_DEBUG_INPUT = {
  ...RANAP_HAPPY_INPUT,
  debugMode: true,
};

const GRAND_TOTAL = 1_000_000;

/**
 * `kasir/kasir/gethistorykunjungan` rows — the registration's own view.
 * `tgl_masuk` here is the admission time and the class/room codes are the
 * registration's, which is why they differ from the inpatient tab below.
 */
const visitRows = [
  {
    no_registrasikunjungan: 'REG-0001',
    no_transaksi: '03-100001',
    kd_unit: 'U01',
    nama_unit: 'RUANG ARAFAH KELAS 3',
    nama_pasien: 'PASIEN SATU',
    nama_penjamin: 'BPJS PBI',
    tgl_masuk: '2026-06-10 08:00:00',
    tgl_keluar: '2026-06-12 10:00:00',
    status_bayar: 'Belum',
    no_sep: '0123456789012345',
    kd_kamarperawatan: 'KM-KSR',
    // `CARE_CLASS_BY_KD`: kd "4" is KELAS 3, matching the room name.
    kd_kelasperawatan: '4',
    urut_masuk_ruang: '1',
  },
];

/**
 * `poliklinik/penatajasa_inap/gethistorykunjungan_tab` rows — the ward's view of
 * the same stay. The patient was admitted at 08:00 and moved into the ward at
 * 09:30, so `tgl_masuk` is genuinely later here; that difference is what makes
 * `loadVisits`'s fallback path identifiable. The class/room codes are the third
 * source of the `buildRooms` precedence chain (`kd "3"` is KELAS 2).
 */
const inapVisitRows = visitRows.map((row) => ({
  ...row,
  tgl_masuk: '2026-06-10 09:30:00',
  nama_kamar: 'ARAFAH 1',
  kd_ruangperawatan: 'R01',
  kd_kamarperawatan: 'KM-INAP',
  kd_kelasperawatan: '3',
}));

/**
 * The kasir identity block, split across the three reads `readKasirIdentity`
 * falls back to when `kasir.getDataTransaksi` gives no usable identity - the
 * demographics come from pendaftaran, the jenis SEP from the inpatient tab, and
 * the unit label from the poliklinik transaction.
 *
 * `kasir.getDataTransaksi` is left unregistered here on purpose, so the default
 * fixture exercises that fallback: the composite carries no `no_sep` and is
 * marked `_sep_unreadable`, and `compare_sep` surfaces needs_review.
 */
const kasirDemographics = {
  no_medicalrecord: '0-01-23-45',
  nama_pasien: 'PASIEN SATU',
  alamat: 'JL CONTOH NO 1',
  jenis: 'Perempuan',
  tempat_lahir: 'GOMBONG',
  tanggal_lahir: '1990-01-01',
  no_transaksi: '03-100001',
  no_registrasikunjungan: 'REG-0001',
  // `find_sep` (ranap_v3.py:6038) reads the card from here first; `no_kk` is a
  // 16-digit Central Java NIK (prefix `33`), so it has to fall through to the
  // payer tab below before the SEP lookup can succeed.
  no_kk: '3305011234567890',
};

/** `penatajasa_inap/getdatakunjungan_tab` — the fields the composite needs. */
const kasirKunjunganTab = {
  jenis_sep: 'RITL',
  kd_instalasi: 'I01',
  kd_unit: 'U01',
};

/** `poliklinik/poliklinik/getdatatransaksi` — the unit label fallback. */
const kasirPoliTransaksi = {
  no_transaksi: '03-100001',
  no_registrasikunjungan: 'REG-0001',
  nama_unit: 'RUANG ARAFAH KELAS 3',
  kd_unit: 'U01',
  kd_detkelpenjamin: '15',
};

/**
 * A class-3 stay entered from the outpatient clinic, deliberately mis-dated.
 *
 * `sinkronkan_tindakan_harian_inap` decides **per charge row**, and every one of
 * its decisions is addressed by `(kd_tindakan, tgl_jam, urut_tindakan)` — the
 * identity triple `update_tgl_tindakan_inap` and `hapus_tindakan_inap` both take.
 * Rows without `urut_tindakan` are dropped by the legacy write before it posts,
 * so a fixture without one exercises the planner's "cannot address this row"
 * branch and nothing else.
 *
 * Three deliberate faults, one per repair phase:
 *  - `BIAYA POLIKLINIK` sits a day before the SEP date, so
 *    `_sinkronkan_tanggal_poliklinik` (ranap_v3.py:12122) has to pull it forward;
 *  - a second `BIAYA KAMAR` sits outside the assigned range, so
 *    `_rebalance_action_rows_inap` (9911) moves it onto the empty day rather
 *    than deleting and re-adding it;
 *  - `VISITE DOKTER SPESIALIS` carries no performing doctor (no component-29
 *    detail), so the visite repair has to fill it from the CPPT notes.
 * The remaining days have no jasa/room charge at all, which is what the per-day
 * add loop is for.
 */
const inapCharges = [
  { kd_tindakan: 'T01', urut_tindakan: '1', nama_tindakan: 'BIAYA KAMAR KELAS 3', harga: '250000', qty: '2', jumlah: '500000', status_bayar: 'Belum', tgl_transaksi: '2026-06-10 08:00:00', tgl_jam: '2026-06-10 08:00:00' },
  { kd_tindakan: 'T02', urut_tindakan: '2', nama_tindakan: 'BIAYA POLIKLINIK', harga: '250000', qty: '1', jumlah: '250000', status_bayar: 'Belum', tgl_transaksi: '2026-06-09 08:00:00', tgl_jam: '2026-06-09 08:00:00' },
  { kd_tindakan: 'T03', urut_tindakan: '3', nama_tindakan: 'JASA PELAYANAN KELAS 3', harga: '125000', qty: '2', jumlah: '250000', status_bayar: 'Belum', tgl_transaksi: '2026-06-11 08:00:00', tgl_jam: '2026-06-11 08:00:00' },
  { kd_tindakan: 'T01', urut_tindakan: '4', nama_tindakan: 'BIAYA KAMAR KELAS 3', harga: '250000', qty: '1', jumlah: '250000', status_bayar: 'Belum', tgl_transaksi: '2026-06-09 08:00:00', tgl_jam: '2026-06-09 08:00:00' },
  { kd_tindakan: 'T04', urut_tindakan: '5', nama_tindakan: 'VISITE DOKTER SPESIALIS', harga: '50000', qty: '1', jumlah: '50000', status_bayar: 'Belum', tgl_transaksi: '2026-06-11 09:00:00', tgl_jam: '2026-06-11 09:00:00' },
];

/** The charge the mis-dated `BIAYA POLIKLINIK` line is pulled onto. */
export const RANAP_POLI_SOURCE_TRX = '01-100001';

/**
 * The rekapitulasi page, reduced to the two rows `cek_balance_total_tagihan`
 * scrapes. Both totals equal the cashier grand total, so the bill balances.
 */
const rekapitulasiHtml = `<html><body><table>
<tr><td><b>TOTAL BIAYA</b></td><td align="right"><b>1.000.000</b></td></tr>
<tr><td><b>TOTAL TAGIHAN</b></td><td align="right"><b>1.000.000</b></td></tr>
</table></body></html>`;

const json = (value: unknown): FixtureEntry => ({ text: JSON.stringify(value) });
const empty = json({ total: 0, rows: [] });

export const ranapFixtures: Record<string, FixtureEntry> = {
  // ── Visit selection ───────────────────────────────────────────
  'kasir.getHistoryKunjungan': json({ total: visitRows.length, rows: visitRows }),
  'penatajasaInap.getHistoryKunjunganTab': json({ total: inapVisitRows.length, rows: inapVisitRows }),
  'kasir.cekStatusVerifikasi': { text: '0' },
  'kasir.getHistoryPembayaran': json([]),

  // ── SEP ───────────────────────────────────────────────────────
  // One read serves two callers: `find_sep` needs `no_kk` (the NIK it has to
  // reject), `readKasirIdentity` needs the demographics. Both are here.
  'pendaftaran.getDataKunjungan': json(kasirDemographics),
  'pendaftaran.getDataPenjaminTab': json({ no_asuransi: '0001234567890' }),
  'pendaftaran.getRiwayatSep': json([
    {
      no_sep: '0123456789012345',
      tgl_sep: '2026-06-10',
      jns_pelayanan: 'RITL',
      ppk_pelayanan: 'PKU MUHAMMADIYAH GOMBONG',
      diagnosa_awal: 'CONTOH DIAGNOSA',
      no_rujukan: 'RJK-0001',
      // The entitled class, so the titipan check has both sides to compare.
      kelas_rawat: 'KELAS 3',
    },
  ]),
  'pendaftaran.getDataSepBpjs': json({}),

  // ── Kasir identity & lines ────────────────────────────────────
  // `kasir.getDataTransaksi` (answers live, with no_sep) and `kasir.getListTindakan`
  // are left unregistered so the default run exercises the composite fallback.
  'kasir.getJumlahBayar': json({ grand_total: String(GRAND_TOTAL), tunai: '0', piutang: '0', total: String(GRAND_TOTAL) }),
  'kasir.cekOrderBelumTerlayani': json({ total: 0, nama_unit: '', data: '' }),
  'kasir.cekOrderBelumTransfer': json({ total: 0, nama_unit: '', data: '' }),

  // ── Room assignment ───────────────────────────────────────────
  'penatajasaInap.getDataKunjungan': json({
    kd_unit: 'U01',
    nama_pasien: 'PASIEN SATU',
    // `_get_patient_paramedis_group_info` (ranap_v3.py:10218) reads the
    // attending doctor from here first and only falls back to
    // `ambil_datatransaksi` when the row comes back empty.
    nama_paramedis: 'DR CONTOH SATU',
    kd_paramedis: 'P001',
    no_sep: '0123456789012345',
    tgl_masuk: '2026-06-10 08:00:00',
  }),
  // The master tindakan lists both add loops pick their `kd_tindakan`/`harga`
  // from. Empty here: the fixture stay already carries a jasa and a room charge
  // to copy, and an empty master is what makes the "metadata tindakan tidak
  // ditemukan" skip for DPJB observable.
  'penatajasaInap.getTindakan': empty,
  'verifikator.getTindakan': empty,
  'verifikator.getDataKunjungan': json({}),
  'verifikator.getDataKunjunganTab': json({}),
  // `getdetail_komponen_transaksi` — the component lines a charge's performing
  // paramedic lives on. Empty, so `_get_komponen_paramedis_name` reports "no
  // component at all", which is never "already correct": the pelaksana sweeps
  // therefore plan a write, and the specialist rows read as having no doctor.
  'penatajasaInap.getDetailKomponenTransaksi': empty,
  // The winner of the three-way precedence: `kd "4"` is KELAS 3, matching the
  // room name, and `KM01` is the room code the tindakan reads are keyed by.
  // Also the composite identity's `jenis_sep`/`kd_instalasi` source.
  'penatajasaInap.getDataKunjunganTab': json({
    ...kasirKunjunganTab,
    kd_detkelpenjamin: '15',
    kd_kelasperawatan: '4',
    kd_kamarperawatan: 'KM01',
    kd_ruangperawatan: 'R01',
    kd_spesialisasi: 'SP1',
  }),
  // Last in the chain, so its values must never surface while the tab answers
  // (`kd "2"` is KELAS 1).
  'poliklinik.getDataKunjunganTab2': json({
    kd_kelasperawatan: '2',
    kd_kamarperawatan: 'KM-TAB2',
    kd_ruangperawatan: 'R-TAB2',
    kd_spesialisasi: 'SP-TAB2',
  }),
  'penatajasaInap.getListTindakan': json({ total: inapCharges.length, rows: inapCharges }),
  // The pelaksana dropdown answers with a bare array (not a rows envelope), and
  // its entries carry the ward's own role-prefixed account.
  //
  // Two entries on purpose: `_resolve_room_pelaksana` (ranap_v3.py:1918) scores
  // every (option, room segment) pair and takes the best, so the ward account
  // whose name is `PERAWAT <room>` must beat the shorter `PERAWAT ARAFAH`, which
  // scores nothing at all against the compound room label.
  'penatajasaInap.getCmbParamedisPelaksana': json([
    { kd_paramedis: 'P900', nama_paramedis: 'PERAWAT ARAFAH' },
    { kd_paramedis: 'P901', nama_paramedis: 'PERAWAT RUANG ARAFAH KELAS 3', nama_jabatanparamedis: 'PERAWAT' },
  ]),

  // ── Origin ────────────────────────────────────────────────────
  // The clinic's own charge lines. `_sinkronkan_tanggal_poli_non_dokter`
  // (ranap_v3.py:7170) re-dates exactly the untransferred `BIAYA OBAT` rows onto
  // the inpatient/SEP date, so one mis-dated pharmacy line is what makes the
  // `poliklinik/poliklinik/update_tgl` write real.
  'poliklinik.getListTindakan': json({
    total: 1,
    rows: [
      {
        kd_tindakan: 'P01',
        urut_tindakan: '1',
        nama_tindakan: 'BIAYA OBAT',
        harga: '75000',
        qty: '1',
        jumlah: '75000',
        status_bayar: 'Belum',
        tgl_transaksi: '2026-06-09 07:30:00',
      },
    ],
  }),
  // `cek_jumlah_transfer_igd` (ranap_v3.py:6372) — the amount
  // `transfer_tagihan_igd` posts. An empty answer makes the legacy refuse the
  // transfer outright.
  'poliklinik.cekJumlahTransfer': { text: '900000' },
  'poliklinik.cekStatusOrder': { text: '' },
  // The clinic visit the stay was admitted from. `_find_related_poli_source`
  // (ranap_v3.py:13932) only considers `01-` rows dated on or before the
  // reference date and inside the tolerance, and requires the poli controller's
  // `getdatatransaksi` to point back at this stay (`linked_match`) or a
  // SEP/unit/doctor match — so all three reads below are load-bearing.
  'poliklinik.getHistoryKunjungan': json({
    total: 1,
    rows: [
      {
        no_transaksi: '01-100001',
        no_registrasikunjungan: 'REG-0009',
        nama_unit: 'POLI PENYAKIT DALAM',
        tgl_masuk: '2026-06-10 07:00:00',
        status_bayar: 'Belum',
      },
    ],
  }),
  // `kd_unit` is the destination unit `transfer_tagihan_igd` posts as
  // `kd_unit_poli`; without it the legacy calls the transfer data incomplete and
  // refuses (ranap_v3.py:9221). `readKasirIdentity` reads the same endpoint for
  // the composite identity's `nama_unit`.
  'poliklinik.getDataTransaksi': json(kasirPoliTransaksi),
  'poliklinik.getDataKunjungan': json({
    kd_unit: 'U05',
    nama_unit: 'POLI PENYAKIT DALAM',
    kd_paramedis: 'P001',
    tgl_masuk: '2026-06-10 07:00:00',
    no_sep: '0123456789012345',
  }),

  // ── Gizi ──────────────────────────────────────────────────────
  'penatajasaInap.getHistoryOrderGizi': empty,
  'penatajasaInap.cekOrderGizi': { text: '0' },
  'penatajasaInap.getDataOrderGizi': empty,

  // ── Penunjang ─────────────────────────────────────────────────
  'elektromedik.getHistoryKunjungan': empty,
  // `get_datakunjungan_elektromedik` (ranap_v3.py:6165) — the destination unit
  // `transferTagihan` needs; the legacy skips a charge whose unit is unreadable.
  'elektromedik.getDataKunjungan': json({ kd_unit: 'U11' }),
  'penatajasaInap.getHistoryILab': empty,
  'kemoterapi.getHistoryOrderPa': empty,
  'poliklinik.getHistoryIrad': empty,
  'penatajasaInap.getHistoryIok': empty,
  // The real `cektransaksi_penunjang` response shape. There is no `has_blocker`
  // field: `_normalize_penunjang_blocker` (ranap_v3.py:15023) derives the verdict
  // from `nama_unit`, `no_transaksi`, `data` and `total`, so a fixture carrying
  // `has_blocker` would be testing a field the backend never sends and the
  // normaliser never reads.
  'verifikator.cekTransaksiPenunjang': json({ total: 0, nama_unit: '', no_transaksi: '', data: '' }),
  // `_collect_direct_hasil_rows_for_group` (ranap_v3.py:7976) sweeps the two
  // result modules directly, not only the inpatient order history.
  'laboratorium.getHistoryKunjungan': empty,
  'laboratoriumHasil.getDataKunjungan': empty,
  'radiologi.getDataKunjungan': empty,
  // `cek_jadwal_gizi` (ranap_v3.py:15154) answers "" or "1" when the kitchen can
  // still take the order.
  'penatajasaInap.cekJadwalGizi': { text: '1' },

  // ── RME (newborn / BYNY health check) ─────────────────────────
  // `get_byny_rme_status` is a two-call sequence: `get_single_id` yields the
  // `single_id` the discharge summary is keyed by plus the birth date, then
  // `getdata_last` yields `rows[0].dt.data_post` — a JSON *string* holding
  // `keadaan` and `txt_diagnosis_text_rinplg`. The happy-path patient is not a
  // newborn, so neither read fires; the entries exist so the BYNY overrides
  // below only have to restate what they change.
  //
  // `single_id` is set because the *CPPT* reads need it too:
  // `get_evo_v1_cppt_rows` (ranap_v3.py:3130) resolves it from the same call
  // before it can page `ri_cppt/load_soap`, and the specialist repair uses those
  // notes as its doctor/date oracle.
  'rme.getSingleId': json({ single_id: 'SID-0001' }),
  'rme.getRingkasanPulangLast': empty,

  // ── CPPT v1 (the visite doctor/date oracle) ───────────────────
  // One doctor's note on the day the unattributed `VISITE DOKTER SPESIALIS`
  // sits, which is what lets `_pick_cppt_pelaksana_for_empty_spesialis`
  // (ranap_v3.py:10327) commit to a single name instead of deleting the row.
  'rme.loadCpptAwal': empty,
  'rme.loadCpptSoap': json({
    total: 1,
    rows: [
      {
        id_soapi: 'SOAP-0001',
        tgl_entry: '2026-06-11 09:15:00',
        nama_paramedis: 'DR CONTOH SATU',
        jabatan_paramedis: 'DOKTER SPESIALIS',
      },
    ],
  }),

  // ── Obat ──────────────────────────────────────────────────────
  // The join `validate_obat_pulang` performs needs three reads, not one:
  // `gethistoryobat_inap` lists the pharmacy orders, `getdetail_historyobat`
  // gives each order its item/qty lines, and `verifikator/getdetail_transaksi`
  // gives each `BIAYA OBAT` charge row the same. The signatures built from
  // those details are what `_match_history_obat_to_biaya_rows` compares — the
  // order names alone cannot tell two same-day orders apart. The happy-path
  // patient has no pharmacy order and no `BIAYA OBAT` inpatient line, so all
  // three answer empty; `RANAP_OBAT_DETAIL_OVERRIDES` is the scenario where
  // they matter.
  'penatajasaInap.getHistoryObat': empty,
  'penatajasaInap.getDetailHistoryObat': empty,
  'verifikator.getDetailTransaksi': empty,

  // ── CPPT v2 (only reachable when a v2 base URL is configured) ─
  // `get_evo_v2_cppt_rows` (ranap_v3.py:3241) is a two-step read: the patient
  // timeline yields the registration's `single_id`, then the CPPT history is
  // keyed by it. Both answer under `data`, not `rows` — the v2 API's own
  // envelope (`_rows_from_evo_v2_payload`, 3078). These entries exist so the
  // fallback is *exercisable*; `EvoMedisClient` would send them to the v1 host
  // on a deployment with no `baseUrlV2`, which is why the executor only issues
  // them when one is configured.
  'ringkasanPasien.loadTglMasuk': json({
    data: [{ no_kunjungan: 'REG-0001', single_id: 'SID-V2-0001', tgl_masuk: '2026-06-10' }],
  }),
  'cppt.riwayat': json({
    data: [
      {
        id_soapi: 'V2-SOAP-0001',
        tgl_entry: '2026-06-12 07:40:00',
        nama_paramedis: 'DR CONTOH SATU',
        jabatan_paramedis: 'DOKTER SPESIALIS',
      },
    ],
  }),

  // ── Balance ───────────────────────────────────────────────────
  'rekapitulasi.detailHakHtml': { text: rekapitulasiHtml },
  'rekapitulasi.detailHak': { text: rekapitulasiHtml },
};

/** The cashier grand total the happy-path fixture bills, for assertions. */
export const RANAP_FIXTURE_GRAND_TOTAL = GRAND_TOTAL;

/**
 * The same stay with the specialist visite priced above its class tariff.
 *
 * `_get_expected_spesialis_tarif` (ranap_v3.py:10615) puts a KELAS 3 visite at
 * 50 000; a 75 000 line is repaired by **delete then re-add**, and the re-added
 * row's `urut_tindakan` comes from the backend. That is what makes
 * `sinkronkan_visite_konsultasi_spesialis_group` return `{"status":
 * "incomplete"}` — execute, re-read, re-plan — and it is the only shape in which
 * a ranap plan legitimately carries no executable payload.
 */
export const RANAP_VISITE_WRONG_TARIF_OVERRIDES: Record<string, FixtureEntry> = {
  'penatajasaInap.getListTindakan': json({
    total: inapCharges.length,
    rows: inapCharges.map((row) =>
      row.nama_tindakan === 'VISITE DOKTER SPESIALIS' ? { ...row, harga: '75000', jumlah: '75000' } : row,
    ),
  }),
};

/** The `urut_tindakan` the backend hands the re-added specialist visite. */
export const RANAP_VISITE_REPLAN_NEW_URUT = '6';

/**
 * The same over-priced visite, but with the backend *answering differently
 * after the repair has been applied* — the shape a re-plan pass exists for.
 *
 * The first `ambil_listtindakan` (the one `load_charges` issues) still shows the
 * 75 000 row at `urut_tindakan=5`, so `sinkronkan_visite_konsultasi_spesialis_group`
 * plans delete → re-add and comes back `incomplete`: the `updateTgl` and
 * `setPelaksana` that finish the repair target a row that does not exist yet and
 * carry no payload, which is why the gate refuses them. Every later read — the
 * one a re-plan pass issues — shows the repair landed: the old row is gone, the
 * re-added one sits at {@link RANAP_VISITE_REPLAN_NEW_URUT} on the day the plan
 * asked for, and (as a real `tambah_tindakan_polis` leaves it) it still has no
 * component-29 performer. The second pass can finally name that row, so the
 * outstanding follow-up becomes an ordinary executable plan.
 *
 * `landedAt` is where the backend actually put the re-added row. The default is
 * the day the plan asked for, so the run converges on the second pass. Pass a
 * day the stay does not own to model the backend putting it somewhere else: the
 * second pass can now *name* the created row — its `hapus` carries a real
 * `urut_tindakan` where the first pass had none — but the repair needs another
 * add, so the loop runs into its cap and has to say so.
 *
 * Stateful, therefore a factory: one fixture map per run, or the second run in a
 * file would start where the first left off.
 */
export function ranapVisiteReplanOverrides(landedAt = '2026-06-11 09:00:00'): Record<string, FixtureEntry> {
  const beforeRows = inapCharges.map((row) =>
    row.nama_tindakan === 'VISITE DOKTER SPESIALIS' ? { ...row, harga: '75000', jumlah: '75000' } : row,
  );
  // What the backend returns once the delete + re-add have been applied.
  const afterRows = [
    ...beforeRows.filter((row) => row.nama_tindakan !== 'VISITE DOKTER SPESIALIS'),
    {
      kd_tindakan: 'T04',
      urut_tindakan: RANAP_VISITE_REPLAN_NEW_URUT,
      nama_tindakan: 'VISITE DOKTER SPESIALIS',
      harga: '50000',
      qty: '1',
      jumlah: '50000',
      status_bayar: 'Belum',
      tgl_transaksi: landedAt,
      tgl_jam: landedAt,
    },
  ];

  // `load_kasir` and `load_charges` share this endpoint now; only the
  // charge-line read (which also sends `no_registrasikunjungan`) flips the
  // state, so the identity read does not consume the "before" answer.
  let chargeReads = 0;
  return {
    'penatajasaInap.getListTindakan': (req) => {
      const body = Object.fromEntries(new URLSearchParams(req.body ?? ''));
      if (body['no_registrasikunjungan']) chargeReads += 1;
      const rows = chargeReads <= 1 ? beforeRows : afterRows;
      return { text: JSON.stringify({ total: rows.length, rows }) };
    },
  };
}

// ── A verified charge line, and the performer write that will not stick ──

/** `urut_tindakan` of the duplicate specialist visite the ward billed twice. */
export const RANAP_VERIFIED_DUPLICATE_URUT = '6';

/** The performer the CPPT names, and the one the intermediate retry parks on. */
export const RANAP_VISITE_DESIRED_PELAKSANA = 'DR CONTOH SATU';
export const RANAP_VISITE_INTERMEDIATE_PELAKSANA = 'DR CONTOH DUA';

/**
 * A stay whose specialist visite was billed twice on the same day, with the
 * duplicate **already verified**.
 *
 * This is the shape `_ensure_tindakan_belum_terverifikasi` (ranap_v3.py:12286)
 * exists for. The visite repair wants to delete the duplicate;
 * `_row_allows_delete_by_hint` refuses it because `status_verifikasi` is set;
 * the Python then calls `batal_verifikasi(no_registrasikunjungan)`, re-reads,
 * and deletes it anyway. The port turns the un-verification into an approvable
 * plan and the delete into the next pass's work — so the fixture has to answer
 * *differently after that plan lands*, which is why it is a stateful factory.
 *
 * Read 1 is `load_charges`; every later read is the one a re-plan pass issues,
 * and by then the bill has been reopened, so the duplicate reads as unverified
 * and becomes deletable.
 *
 * The paramedis dropdown is replaced with two doctors. Two consequences, both
 * wanted: the ward has no room-pelaksana account, so `sync_tindakan` plans no
 * performer write at all and the scenario stays about the specialist rows; and
 * `_pick_intermediate_paramedis_name` has exactly one account to park a row on
 * ({@link RANAP_VISITE_INTERMEDIATE_PELAKSANA}), so the retry ladder's choice is
 * not a coin toss.
 */
export function ranapVerifiedDuplicateVisiteOverrides(): Record<string, FixtureEntry> {
  const duplicate = {
    kd_tindakan: 'T04',
    urut_tindakan: RANAP_VERIFIED_DUPLICATE_URUT,
    nama_tindakan: 'VISITE DOKTER SPESIALIS',
    harga: '50000',
    qty: '1',
    jumlah: '50000',
    status_bayar: 'Belum',
    tgl_transaksi: '2026-06-11 10:00:00',
    tgl_jam: '2026-06-11 10:00:00',
  };
  const beforeRows = [...inapCharges, { ...duplicate, status_verifikasi: '1' }];
  const afterRows = [...inapCharges, { ...duplicate, status_verifikasi: '0' }];

  // Same shared-endpoint split as `ranapVisiteReplanOverrides`: only the
  // charge-line read (carrying `no_registrasikunjungan`) advances the state.
  let chargeReads = 0;
  const isChargeRead = (body: string | undefined) =>
    Boolean(Object.fromEntries(new URLSearchParams(body ?? ''))['no_registrasikunjungan']);
  return {
    'penatajasaInap.getListTindakan': (req) => {
      if (isChargeRead(req.body)) chargeReads += 1;
      const rows = chargeReads <= 1 ? beforeRows : afterRows;
      return { text: JSON.stringify({ total: rows.length, rows }) };
    },
    // `cekstatus_verifikasi_tindakan` — the confirming read the Python performs
    // before it reopens a bill (12292). It agrees with the row hint until the
    // `batal_verifikasi` plan has landed.
    'penatajasaInap.cekStatusVerifikasi': () => ({ text: chargeReads <= 1 ? '1' : '0' }),
    'penatajasaInap.getCmbParamedisPelaksana': json([
      { kd_paramedis: 'P002', nama_paramedis: RANAP_VISITE_INTERMEDIATE_PELAKSANA },
      { kd_paramedis: 'P001', nama_paramedis: RANAP_VISITE_DESIRED_PELAKSANA },
    ]),
  };
}

// ── Obat pulang: the detail-signature join ────────────────────────

/**
 * A discharge-medication scenario whose only correct answer needs the *detail*
 * reads on both sides.
 *
 * Two pharmacy orders carry the same two drug names and differ only in
 * quantity, and the charge row's `no_referensi` encodes the later order's date —
 * so the scorer (`ref_delta` first, ranap_v3.py:5960) prefers **OB-2**. Matching
 * on names alone therefore pairs the charge with the wrong order, or with none
 * at all once the coverage rule bites. The exact item/qty fingerprint
 * `_build_obat_detail_signature` builds from `getdetail_historyobat` and
 * `verifikator/getdetail_transaksi` is what makes the exact pass fire first and
 * pick OB-1.
 */
export const RANAP_OBAT_MATCH_BIAYA_REFERENSI = '18-120626-000777';

/** The order whose item/qty signature really matches the charge. */
export const RANAP_OBAT_MATCH_CORRECT_ORDER = 'OB-1';

/** The order a date-only ranking would have preferred. */
export const RANAP_OBAT_MATCH_DECOY_ORDER = 'OB-2';

const obatOrderDetails: Record<string, Array<Record<string, string>>> = {
  [RANAP_OBAT_MATCH_CORRECT_ORDER]: [
    { nama_obat: 'PARACETAMOL TAB 500MG', qty: '10', harga: '500', jumlah: '5000' },
    { nama_obat: 'AMOXICILLIN CAP 500MG', qty: '15', harga: '1000', jumlah: '15000' },
  ],
  [RANAP_OBAT_MATCH_DECOY_ORDER]: [
    { nama_obat: 'PARACETAMOL TAB 500MG', qty: '30', harga: '500', jumlah: '15000' },
    { nama_obat: 'AMOXICILLIN CAP 500MG', qty: '15', harga: '1000', jumlah: '15000' },
  ],
};

export const RANAP_OBAT_DETAIL_OVERRIDES: Record<string, FixtureEntry> = {
  // One `BIAYA OBAT` line on the inpatient bill, pointing at its own detail
  // transaction. `_build_biaya_obat_detail_entry` reads that with the row's
  // `kd_tindakan` (defaulting to "16").
  'penatajasaInap.getListTindakan': json({
    total: inapCharges.length + 1,
    rows: [
      ...inapCharges,
      {
        kd_tindakan: '16',
        urut_tindakan: '9',
        nama_tindakan: 'BIAYA OBAT',
        harga: '20000',
        qty: '1',
        jumlah: '20000',
        status_bayar: 'Belum',
        no_referensi: RANAP_OBAT_MATCH_BIAYA_REFERENSI,
        tgl_transaksi: '2026-06-12 09:00:00',
        tgl_jam: '2026-06-12 09:00:00',
      },
    ],
  }),
  'penatajasaInap.getHistoryObat': json({
    total: 2,
    rows: [
      { no_order: RANAP_OBAT_MATCH_CORRECT_ORDER, tgl_order: '2026-06-11 10:00:00', ruang: 'ARAFAH' },
      { no_order: RANAP_OBAT_MATCH_DECOY_ORDER, tgl_order: '2026-06-12 10:00:00', ruang: 'ARAFAH' },
    ],
  }),
  // Keyed by `no_order`, which travels in the query string of a GET.
  'penatajasaInap.getDetailHistoryObat': (req) => {
    const noOrder = new URL(req.url).searchParams.get('no_order') ?? '';
    const rows = obatOrderDetails[noOrder] ?? [];
    return { text: JSON.stringify({ total: rows.length, rows }) };
  },
  // The charge's own line items — the same two drugs at OB-1's quantities.
  'verifikator.getDetailTransaksi': (req) => {
    const params = new URL(req.url).searchParams;
    const rows =
      params.get('no_transaksi') === RANAP_OBAT_MATCH_BIAYA_REFERENSI
        ? obatOrderDetails[RANAP_OBAT_MATCH_CORRECT_ORDER]!
        : [];
    return { text: JSON.stringify(rows) };
  },
};

// ── Newborn (BYNY) scenarios ──────────────────────────────────────

/** The newborn's name — `_is_byny_patient` matches the compacted "BYNY". */
const BYNY_NAMA_PASIEN = 'BY NY PASIEN SATU';

/**
 * The newborn's own registration is created the day *after* the birth, which is
 * routine in SIMRS. The birth date therefore differs from `tgl_masuk`, and the
 * healthy-baby waiver must anchor the room days on the birth date
 * (ranap_v3.py:15831) — anchoring on `tgl_masuk` silently drops the day of
 * birth from the bill.
 */
export const RANAP_BYNY_BIRTH_DATE = '2026-06-10';
const BYNY_TGL_MASUK = '2026-06-11 09:30:00';

/** `rme/ri_ringkasan_pulang/getdata_last` — `data_post` really is a JSON string. */
function ringkasanPulang(dataPost: Record<string, string>): FixtureEntry {
  return json({ total: 1, rows: [{ dt: { data_post: JSON.stringify(dataPost) } }] });
}

/** The discharge form with the "keadaan baik" box ticked and a healthy diagnosis. */
const BYNY_DATA_POST_HEALTHY = {
  keadaan: 'chk_baik_rinplg',
  chk_baik_rinplg: 'on',
  txt_diagnosis_text_rinplg: 'BAYI SEHAT',
};

/** Same form, but the diagnosis means the newborn is billed on its own. */
const BYNY_DATA_POST_SICK = {
  keadaan: 'chk_baik_rinplg',
  chk_baik_rinplg: 'on',
  txt_diagnosis_text_rinplg: 'IKTERUS NEONATORUM',
};

/**
 * The parts every BYNY scenario shares: a newborn on BPJS whose card yields no
 * SEP history of its own, so the SEP recovery branches are the only way through
 * `validate_sep`.
 */
function bynyBase(noSep: string): Record<string, FixtureEntry> {
  const rows = visitRows.map((row) => ({
    ...row,
    nama_pasien: BYNY_NAMA_PASIEN,
    tgl_masuk: BYNY_TGL_MASUK,
    no_sep: noSep,
  }));
  return {
    'kasir.getHistoryKunjungan': json({ total: rows.length, rows }),
    'penatajasaInap.getHistoryKunjunganTab': json({
      total: rows.length,
      rows: rows.map((row) => ({
        ...row,
        nama_kamar: 'ARAFAH 1',
        kd_ruangperawatan: 'R01',
        kd_kamarperawatan: 'KM-INAP',
        kd_kelasperawatan: '3',
      })),
    }),
    // The composite identity, renamed for the newborn. The same dead-endpoint
    // split applies: no working read carries the kasir SEP, so BYNY `no_sep`
    // only lives on the visit-history rows above.
    'pendaftaran.getDataKunjungan': json({ ...kasirDemographics, nama_pasien: BYNY_NAMA_PASIEN }),
    'penatajasaInap.getDataKunjungan': json({
      kd_unit: 'U01',
      nama_pasien: BYNY_NAMA_PASIEN,
      no_sep: noSep,
      tgl_masuk: BYNY_TGL_MASUK,
    }),
    // The mother holds the SEP, so the baby's card search finds nothing.
    'pendaftaran.getRiwayatSep': json([]),
    'rme.getSingleId': json({ single_id: 'SID-0001', tanggal_lahir: RANAP_BYNY_BIRTH_DATE }),
  };
}

/**
 * A newborn carrying a real SEP of its own. `_build_sep_result_from_known_sep`
 * accepts it and neither the RME read nor the waiver is reached.
 */
export const RANAP_BYNY_OWN_SEP_OVERRIDES: Record<string, FixtureEntry> = {
  ...bynyBase('0123456789012345'),
  'rme.getRingkasanPulangLast': ringkasanPulang(BYNY_DATA_POST_HEALTHY),
};

/**
 * A healthy newborn with no SEP of its own (the field carries the mother's
 * all-zero placeholder). The requirement is waived and the room days anchor on
 * {@link RANAP_BYNY_BIRTH_DATE}.
 */
export const RANAP_BYNY_HEALTHY_OVERRIDES: Record<string, FixtureEntry> = {
  ...bynyBase('0000000000000000'),
  'rme.getRingkasanPulangLast': ringkasanPulang(BYNY_DATA_POST_HEALTHY),
};

/**
 * A sick newborn with no SEP of its own, on BPJS. The waiver must be refused —
 * this baby is billed separately and needs its own SEP.
 */
export const RANAP_BYNY_SICK_OVERRIDES: Record<string, FixtureEntry> = {
  ...bynyBase('0000000000000000'),
  'rme.getRingkasanPulangLast': ringkasanPulang(BYNY_DATA_POST_SICK),
};

/**
 * A healthy newborn whose stay carries a surgical charge but no `DEPO IBS` line
 * in the rekapitulasi — an IBS mismatch.
 *
 * The point is that the mismatch is *visible* for a newborn at all. The charge
 * lines used to be fetched as a side effect of origin detection, and a BYNY
 * patient takes `_build_skipped_origin_info` (ranap_v3.py:16259), so the map
 * stayed empty and `validate_ibs`, `validate_obat_pulang`, `preverify_summary`
 * and `tampung_bayar` all ran on nothing. `validate_ibs_consistency`
 * (ranap_v3.py:8830) fetches the lines itself, which is why it sees this.
 */
export const RANAP_BYNY_IBS_OVERRIDES: Record<string, FixtureEntry> = {
  ...RANAP_BYNY_HEALTHY_OVERRIDES,
  'penatajasaInap.getListTindakan': json({
    total: 2,
    rows: [
      ...inapCharges.slice(0, 1),
      {
        kd_tindakan: 'T90',
        nama_tindakan: 'BIAYA IBS BEDAH KECIL',
        harga: '400000',
        qty: '1',
        jumlah: '400000',
        status_bayar: 'Belum',
        tgl_transaksi: '2026-06-11 08:00:00',
      },
    ],
  }),
};

// ── Two rooms in one registration ─────────────────────────────────

/**
 * One registration, two consecutive rooms — the shape that exposed the balance
 * check's wrong total.
 *
 * `cek_balance_total_tagihan` (ranap_v3.py:8641) asks the cashier for the
 * **episode** total (`get_jumlah_bayar_kasir(no_registrasikunjungan=reg)` with
 * `no_transaksi`/`kd_unit` empty) because that is the figure the rekapitulasi
 * reports. Naming the first room's transaction compares one room against the
 * whole episode, which can never balance — and `check_balance` is critical.
 */
const twoRoomVisitRows = [
  {
    ...visitRows[0],
    tgl_keluar: '2026-06-11 10:00:00',
  },
  {
    ...visitRows[0],
    no_transaksi: '03-100002',
    kd_unit: 'U02',
    nama_unit: 'RUANG ARAFAH KELAS 3 KAMAR 2',
    tgl_masuk: '2026-06-11 10:00:00',
    tgl_keluar: '2026-06-12 10:00:00',
    urut_masuk_ruang: '2',
  },
];

export const RANAP_TWO_ROOM_OVERRIDES: Record<string, FixtureEntry> = {
  'kasir.getHistoryKunjungan': json({ total: twoRoomVisitRows.length, rows: twoRoomVisitRows }),
  'penatajasaInap.getHistoryKunjunganTab': json({
    total: twoRoomVisitRows.length,
    rows: twoRoomVisitRows.map((row) => ({
      ...row,
      nama_kamar: 'ARAFAH 1',
      kd_ruangperawatan: 'R01',
      kd_kamarperawatan: 'KM-INAP',
      kd_kelasperawatan: '3',
    })),
  }),
};

// ── Two registrations in one run ──────────────────────────────────

/**
 * Two separate inpatient registrations for the same patient, both inside the
 * tolerance window of the target date.
 *
 * `main()` verifies and summarises **per registration** (ranap_v3.py:16753,
 * 16828) and keys both the penunjang keterangan and the newborn RME status by
 * registration (16843). The date ranges deliberately do not overlap, so a
 * penunjang order can belong to exactly one of them —
 * `_filter_history_rows_for_date_range` (16204-16208) is what makes that
 * distinction.
 */
export const RANAP_TWO_REG_FIRST_REG = 'REG-0001';
export const RANAP_TWO_REG_SECOND_REG = 'REG-0002';

const twoRegVisitRows = [
  {
    ...visitRows[0],
    tgl_masuk: '2026-06-08 08:00:00',
    tgl_keluar: '2026-06-09 10:00:00',
  },
  {
    ...visitRows[0],
    no_registrasikunjungan: RANAP_TWO_REG_SECOND_REG,
    no_transaksi: '03-100002',
    tgl_masuk: '2026-06-12 08:00:00',
    tgl_keluar: '2026-06-13 10:00:00',
  },
];

export const RANAP_TWO_REG_OVERRIDES: Record<string, FixtureEntry> = {
  'kasir.getHistoryKunjungan': json({ total: twoRegVisitRows.length, rows: twoRegVisitRows }),
  'penatajasaInap.getHistoryKunjunganTab': json({
    total: twoRegVisitRows.length,
    rows: twoRegVisitRows.map((row) => ({
      ...row,
      nama_kamar: 'ARAFAH 1',
      kd_ruangperawatan: 'R01',
      kd_kamarperawatan: 'KM-INAP',
      kd_kelasperawatan: '3',
    })),
  }),
};

// ── IGD origin with a derived elektromedik charge ─────────────────

/**
 * A hemodialysis admission through IGD: the IGD visit keeps the inpatient
 * registration, and the HD charge sits in a separate "PENUNJANG LAIN"
 * (elektromedik) transaction whose `no_transaksipoli` points back at the IGD one.
 *
 * Three defects meet on this shape:
 *  - the origin is only IGD because of the hemodialysis signal
 *    (ranap_v3.py:16270-16296); the inpatient charge list says Poliklinik;
 *  - the IGD transaction has to be in `handled_transactions` (16531) or the
 *    hanging scan reports the very transaction being transferred;
 *  - only the elektromedik charges **not** folded into the IGD transfer may be
 *    transferred separately (16510-16516) — otherwise one charge gets two plans.
 */
export const RANAP_IGD_TRX = '02-100901';
export const RANAP_IGD_ELEKTROMEDIK_TRX = '11-110001';

const igdVisitRows = [
  visitRows[0],
  {
    no_registrasikunjungan: 'REG-0001',
    no_transaksi: RANAP_IGD_TRX,
    kd_unit: 'U02',
    nama_unit: 'IGD',
    nama_pasien: 'PASIEN SATU',
    nama_penjamin: 'BPJS PBI',
    tgl_masuk: '2026-06-10 06:00:00',
    status_bayar: 'Belum',
  },
  {
    no_registrasikunjungan: 'REG-0001',
    no_transaksi: RANAP_IGD_ELEKTROMEDIK_TRX,
    kd_unit: 'U11',
    nama_unit: 'PENUNJANG LAIN',
    nama_pasien: 'PASIEN SATU',
    nama_penjamin: 'BPJS PBI',
    tgl_masuk: '2026-06-10 09:00:00',
    status_bayar: 'Belum',
  },
];

export const RANAP_IGD_ELEKTROMEDIK_OVERRIDES: Record<string, FixtureEntry> = {
  'kasir.getHistoryKunjungan': json({ total: igdVisitRows.length, rows: igdVisitRows }),
  // The elektromedik charge is a derivative of the IGD visit: `no_transaksipoli`
  // is the link `used_elektromedik_trx` is populated from.
  'elektromedik.getHistoryKunjungan': json({
    total: 1,
    rows: [
      {
        no_transaksi: RANAP_IGD_ELEKTROMEDIK_TRX,
        no_transaksipoli: RANAP_IGD_TRX,
        no_registrasikunjungan: 'REG-0001',
        nama_unit: 'PENUNJANG LAIN',
        tgl_transaksi: '2026-06-10 09:00:00',
      },
    ],
  }),
  // `_get_igd_source_signal_info` (ranap_v3.py:13767) reads the IGD charge list;
  // a hemodialysis line is what forces IGD origin. Two still-untransferred rows,
  // because `transfer_tagihan_igd` posts their codes as one `','`-joined field
  // ("format sesuai HAR: 38','16','1929…", ranap_v3.py:9201).
  'poliklinik.getListTindakan': json({
    total: 2,
    rows: [
      { kd_tindakan: 'HD1', urut_tindakan: '1', nama_tindakan: 'BIAYA HEMODIALISA', jumlah: '900000', tgl_transaksi: '2026-06-10 06:30:00' },
      { kd_tindakan: 'HD2', urut_tindakan: '2', nama_tindakan: 'BIAYA BHP HEMODIALISA', jumlah: '150000', tgl_transaksi: '2026-06-10 06:40:00' },
    ],
  }),
  // `get_datatransaksi_poli_igd` — the IGD registration points back at the
  // inpatient transaction, which is the `linked_match` half of the candidate
  // gate and, at transfer time, the destination `no_transaksipoli`/`kd_unit_poli`.
  'poliklinik.getDataTransaksi': json({
    no_transaksi: '03-100001',
    no_registrasikunjungan: 'REG-0001',
    kd_unit: 'U01',
    kd_detkelpenjamin: '15',
  }),
  'poliklinik.getDataKunjungan': json({
    kd_unit: 'U02',
    nama_unit: 'IGD',
    tgl_masuk: '2026-06-10 06:00:00',
    no_sep: '0123456789012345',
    kd_paramedis: 'P001',
  }),
  // An IGD-origin admission with neither a DEPO IGD visit nor a BIAYA OBAT line
  // is itself a verification blocker (`_check_missing_igd_depo_or_obat_for_
  // verification`, ranap_v3.py:8001), so the pharmacy line is present here.
  'penatajasaInap.getListTindakan': json({
    total: inapCharges.length + 1,
    rows: [
      ...inapCharges,
      {
        kd_tindakan: 'T80',
        nama_tindakan: 'BIAYA OBAT',
        harga: '50000',
        qty: '1',
        jumlah: '50000',
        status_bayar: 'Belum',
        tgl_transaksi: '2026-06-10 10:00:00',
      },
    ],
  }),
};
