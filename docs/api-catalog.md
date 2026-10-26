# EvoMedis / SIMRS API Catalog

Source of truth for the typed client lives in
`packages/evomedis-client/src/endpoints.ts`. This document is the
human-readable companion: every endpoint, its classification, and the
payload fields the legacy tools send.

> **Provenance.** Endpoints were reverse-engineered from the legacy
> `ranap_v3.py`, `puisi_v2.js`, and the GreasyFork rawat-jalan userscript.
> Field casing is preserved exactly — the backend is case-sensitive and
> inconsistent (`txtmedrec` vs `txtmedrec_pdft` vs `nomedrec`).

**Coverage.** 143 entries: 2 `auth`, 112 `read`, 29 `mutate`. This covers all
133 distinct paths `ranap_v3.py` calls, 26 of the 27 EvoMedis paths
`rajal_v23.js` calls, plus the same-origin LIS PDF HEAD/GET probe. Neither
legacy pipeline hits `UnknownEndpointError`. The twenty-seventh EvoMedis path,
`radiologi/hasil_pemeriksaan/get_datapasien`, is deliberately absent: that
controller exposes no such action, and its real result search
(`radiologi.getDataKunjungan`) takes the same field. See
`docs/legacy/rajal-parity.md`.

## Hosts

| Alias | Base URL (example) | Notes |
|---|---|---|
| v1 | `http://<host>/evoMedis_pkugombong/index.php` | CodeIgniter. All calls are `application/x-www-form-urlencoded` POSTs, even reads. |
| v2 | `http://<host>/evoMedis_v2` | JSON API. True GETs; `Authorization-Key` header. |

Base URLs are supplied at runtime via `EVOMEDIS_BASE_URL` — never hardcoded.

## Module map

Registry ids are `<module>.<action>`. Because several CodeIgniter controllers
share a first path segment, the module prefix names the *controller*, not the
directory:

| Module prefix | Controller path | Scope |
|---|---|---|
| `auth` | `login/index`, `api/login/auth` | Session establishment |
| `kasir` | `kasir/kasir/*` | Cashier / billing |
| `pendaftaran` | `pendaftaran/pendaftaran_pasien/*` | Registration, SEP lookup |
| `rekamMedis` | `rekam_medis/upload_berkas/*` | SEP document write |
| `rme` | `rme/ri_rme/*`, `rme/ri_ringkasan_pulang/*`, `rme/ri_cppt/*` | v1 electronic record, CPPT, discharge summary |
| `ringkasanPasien` | `api/ringkasan_pasien/*` (v2) | v2 patient timeline |
| `cppt` | `api_inap/cppt/*` (v2) | v2 inpatient CPPT |
| `poliklinik` | `poliklinik/poliklinik/*` | Outpatient / IGD charges and transfers |
| `penatajasaInap` | `poliklinik/penatajasa_inap/*` | Inpatient charges, gizi (diet), OK (theatre) orders |
| `rekapitulasi` | `poliklinik/rekapitulasi/*` | Billing recap HTML (behaviour oracle) |
| `verifikator` | `poliklinik/verifikator/*` | Bill verification |
| `laboratorium` | `laboratorium/registrasi_pemeriksaan/*` | Lab registration, transfer, BHP |
| `laboratoriumHasil` | `laboratorium/hasil_pemeriksaan/*` | Lab results |
| `radiologi` | `radiologi/hasil_pemeriksaan/*` | Radiology results |
| `elektromedik` | `elektromedik/registrasi_pemeriksaan/*` | Elektromedik registration and transfer |
| `elektromedikHasil` | `elektromedik/hasil_pemeriksaan/*` | Elektromedik results |
| `pa` | `pa/hasil_pemeriksaan/*` | Pathology results |
| `kemoterapi` | `kemoterapi/registrasi_pemeriksaan/*` | Pathology (PA) order history |
| `laporanBelumBayar` | `laporan/laporan_belum_bayar/*` | Unpaid-bill report (outpatient batch discovery) |
| `laporanKeluarRanap` | `rekam_medis/laporan_keluar_rwi_kasir/*` | Discharged-inpatient report (ranap run-setup fetch) |

## Classification legend

| Kind | Meaning |
|---|---|
| `read` | Idempotent. Safe to call in preview and write mode. |
| `mutate` | Changes server state. Blocked in preview; gated by approval in write. |
| `auth` | Session/login. Handled by the orchestrator, not workflow nodes. |

| Risk | Meaning |
|---|---|
| `low` | Read or trivial. |
| `medium` | Auth / session. |
| `high` | Billing-adjacent mutation (charge transfer, date edit, pelaksana edit, line add/delete, BHP open/close, SEP write). |
| `critical` | Financial finalization (payment staging, verification). Two-eyes recommended. |

| `response` | Meaning |
|---|---|
| `json` | Parsed as JSON (legacy `_post_json` / `_get_json` / `_v2_get_json`). |
| `text` | Bare status string or `<option>` fragment (legacy `_post_text` / `_get_text` / `_write_text`). |
| `html` | Recap page or printout. Decoded as text; never parsed as JSON. |
| `raw` | Headers plus bytes, used only for same-origin PDF probes. |

Classification rule of record: an endpoint is `mutate` if `ranap_v3.py` reaches
it through `_write_text` / `_write_json` — the wrappers the `DRY_RUN` flag
intercepts. Everything named `cek*` / `get*` / `view*` / `cetak*` is `read`.
Ambiguity resolves to `mutate` (fail closed).

## Read endpoints

109 entries.

| id | method | path | resp | purpose |
|---|---|---|---|---|
| `kasir.getHistoryKunjungan` | POST | `kasir/kasir/gethistorykunjungan` | json | Visit history by medrec |
| `kasir.getDataTransaksi` | POST | `kasir/kasir/getdatatransaksi` | json | Transaction detail for a visit |
| `kasir.getDataKunjunganTab` | POST | `kasir/kasir/getdatakunjungan_tab` | json | Kasir visit tab (room/class) data |
| `kasir.getListTindakan` | POST | `kasir/kasir/get_listtindakan` | json | Billable line items for a transaction |
| `kasir.getJumlahBayar` | POST | `kasir/kasir/getJumlahBayar` | json | Payable totals for a transaction |
| `kasir.getJenisBayar` | POST | `kasir/kasir/getjenis_bayar` | text | Payment-type `<option>` markup for a payer; feeds `cmbjenis_pembayaran` |
| `kasir.getShiftBayar` | POST | `kasir/kasir/getshift_bayar` | text | Cashier shift `<option>` markup (no payload); feeds `cmbshift_pembayaran` |
| `kasir.cekStatusVerifikasi` | POST | `kasir/kasir/cekstatus_verifikasi` | text | Verification status ("0"=open). Read-before-write guard |
| `kasir.getHistoryPembayaran` | GET | `kasir/kasir/gethistory_pembayaran` | json | Payment history (reject-paid guard). GET: legacy `gethistory_pembayaran_kasir` uses `_get_json`, so the two keys travel as query params, not a form body |
| `kasir.cekOrderBelumTerlayani` | POST | `kasir/kasir/cek_order_belum_terlayani` | json | Unserved-orders blocker |
| `kasir.cekOrderBelumTransfer` | POST | `kasir/kasir/cek_order_belum_transfer` | json | Untransferred-orders blocker |
| `kasir.getRencanaOnko` | POST | `kasir/kasir/get_rencana_onko` | json | Oncology plan for a visit (`{no_registrasikunjungan}`); an `isi_perencanaan` naming chemo abandons the record |
| `pendaftaran.getDataKunjungan` | POST | `pendaftaran/pendaftaran_pasien/getdatakunjungan` | json | Registration visit data |
| `pendaftaran.getDataPenjaminTab` | POST | `pendaftaran/pendaftaran_pasien/getdatapenjamin_tab` | json | Guarantor/insurance tab |
| `pendaftaran.getRiwayatSep` | POST | `pendaftaran/pendaftaran_pasien/get_datariwayatsep` | json | SEP history by card number |
| `pendaftaran.getDataSepBpjs` | POST | `pendaftaran/pendaftaran_pasien/getdata_sep_bpjs` | json | SEP detail from BPJS by SEP number; yields `jns_pelayanan` |
| `rme.getSingleId` | POST | `rme/ri_rme/get_single_id` | json | Single-id + birth/admit dates |
| `rme.getRingkasanPulangLast` | POST | `rme/ri_ringkasan_pulang/getdata_last` | json | Discharge summary (BYNY) |
| `rme.loadCpptAwal` | POST | `rme/ri_cppt/load_awal` | json | Initial CPPT header/assessment |
| `rme.loadCpptSoap` | POST | `rme/ri_cppt/load_soap` | json | CPPT SOAP note pages; doctor/date oracle |
| `ringkasanPasien.loadTglMasuk` | GET | `api/ringkasan_pasien/loadTglMasuk` | json | v2 patient timeline / admission rows |
| `cppt.riwayat` | GET | `api_inap/cppt/cppt_riwayat` | json | v2 inpatient CPPT history; doctor/date oracle |
| `poliklinik.cekJumlahTransfer` | POST | `poliklinik/poliklinik/cek_jumlah_transfer` | text | Count of already-transferred charges |
| `poliklinik.cekStatusBayar` | POST | `poliklinik/poliklinik/cekstatusbayar` | text | Payment status of one poli/IGD tindakan |
| `poliklinik.cekStatusOrder` | POST | `poliklinik/poliklinik/cekstatus_order` | text | Outstanding-order status |
| `poliklinik.cekStatusPosting` | POST | `poliklinik/poliklinik/cekstatus_posting` | text | Posting status of one tindakan |
| `poliklinik.cekStatusTransfer` | POST | `poliklinik/poliklinik/cekstatus_transfer` | text | Transfer status of one tindakan |
| `poliklinik.cekStatusVerifikasi` | POST | `poliklinik/poliklinik/cekstatus_verifikasi` | text | Verification status of a poli/IGD transaction |
| `poliklinik.cekTindakanTransfer` | POST | `poliklinik/poliklinik/cektindakan_transfer` | text | Whether a tindakan code is transferable |
| `poliklinik.getCmbUnitTransfer` | GET | `poliklinik/poliklinik/getcmbunit_transfer` | json | Transfer destination unit options |
| `poliklinik.getDataCaraKeluarTab` | POST | `poliklinik/poliklinik/getdatacarakeluar_tab` | json | Discharge ("cara keluar") tab (`{no_registrasikunjungan}`); yields `tgl_keluar`. No exit date = visit not closed |
| `poliklinik.getDataKunjungan` | POST | `poliklinik/poliklinik/getdatakunjungan` | json | Poli/IGD visit data |
| `poliklinik.getDataKunjunganTab2` | POST | `poliklinik/poliklinik/getdatakunjungan_tab2` | json | Room/class/spesialisasi tab; feeds rekap params |
| `poliklinik.getDataTransaksi` | POST | `poliklinik/poliklinik/getdatatransaksi` | json | Poli/IGD transaction detail |
| `poliklinik.getHistoryIrad` | POST | `poliklinik/poliklinik/gethistoryirad` | json | Radiology order history by medrec |
| `poliklinik.getHistoryKunjungan` | POST | `poliklinik/poliklinik/gethistorykunjungan` | json | Poli visit history |
| `poliklinik.getListTindakan` | POST | `poliklinik/poliklinik/get_listtindakan` | json | Tindakan lines on a poli/IGD transaction |
| `poliklinik.getTindakan` | GET | `poliklinik/poliklinik/gettindakan` | json | Master tindakan lookup (tariff) for poli/IGD |
| `penatajasaInap.cekJadwalGizi` | POST | `poliklinik/penatajasa_inap/cek_jadwal_gizi` | text | Diet-order schedule check |
| `penatajasaInap.cekOkKirim` | POST | `poliklinik/penatajasa_inap/cekok_kirim` | text | Whether an OK order has been sent |
| `penatajasaInap.cekOkTerlayani` | POST | `poliklinik/penatajasa_inap/cekok_terlayani` | text | Whether an OK order has been served |
| `penatajasaInap.cekOrderGizi` | POST | `poliklinik/penatajasa_inap/cek_order_gizi` | text | Whether a registration has any diet order |
| `penatajasaInap.cekStatusBayar` | POST | `poliklinik/penatajasa_inap/cekstatusbayar` | text | Payment status of one inpatient tindakan. Read-before-write guard |
| `penatajasaInap.cekStatusVerifikasi` | POST | `poliklinik/penatajasa_inap/cekstatus_verifikasi` | text | Verification status of one inpatient tindakan. Read-before-write guard |
| `penatajasaInap.getCmbParamedisPelaksana` | GET | `poliklinik/penatajasa_inap/getcmbparamedis_pelaksana` | json | Pelaksana (performer) options for a unit |
| `penatajasaInap.getDataKunjungan` | POST | `poliklinik/penatajasa_inap/getdatakunjungan` | json | Inpatient visit data |
| `penatajasaInap.getDataKunjunganTab` | POST | `poliklinik/penatajasa_inap/getdatakunjungan_tab` | json | Inpatient room tab data |
| `penatajasaInap.getDataOrderGizi` | POST | `poliklinik/penatajasa_inap/getdataordergizi` | json | Diet-order rows for a transaction |
| `penatajasaInap.getDetailHistoryILab` | GET | `poliklinik/penatajasa_inap/getdetail_historyilab` | json | Line detail of one inpatient lab order |
| `penatajasaInap.getDetailHistoryIok` | GET | `poliklinik/penatajasa_inap/getdetail_historyiok` | json | Line detail of one inpatient OK order |
| `penatajasaInap.getDetailHistoryIrad` | GET | `poliklinik/penatajasa_inap/getdetail_historyirad` | json | Line detail of one inpatient radiology order |
| `penatajasaInap.getDetailHistoryObat` | GET | `poliklinik/penatajasa_inap/getdetail_historyobat` | json | Line detail of one inpatient pharmacy order |
| `penatajasaInap.getDetailKomponenTransaksi` | POST | `poliklinik/penatajasa_inap/getdetail_komponen_transaksi` | json | Fee components of one charge line. Read before any `tampung_pelaksana` write |
| `penatajasaInap.getHistoryILab` | POST | `poliklinik/penatajasa_inap/gethistoryilab` | json | Inpatient lab order history by medrec |
| `penatajasaInap.getHistoryIok` | POST | `poliklinik/penatajasa_inap/gethistoryiok` | json | Inpatient OK order history by medrec |
| `penatajasaInap.getHistoryKunjunganTab` | POST | `poliklinik/penatajasa_inap/gethistorykunjungan_tab` | json | Inpatient visit history |
| `penatajasaInap.getHistoryObat` | POST | `poliklinik/penatajasa_inap/gethistoryobat` | json | Inpatient pharmacy order history; `nomedrec` goes in the query string |
| `penatajasaInap.getHistoryOrderGizi` | POST | `poliklinik/penatajasa_inap/gethistory_ordergizi` | json | Diet-order history for a transaction |
| `penatajasaInap.getListTindakan` | POST | `poliklinik/penatajasa_inap/get_listtindakan` | json | Inpatient tindakan lines |
| `penatajasaInap.getListTindakanOk` | POST | `poliklinik/penatajasa_inap/get_listtindakan_ok` | json | Tindakan lines attached to an OK order |
| `penatajasaInap.getTindakan` | GET | `poliklinik/penatajasa_inap/gettindakan` | json | Master tindakan lookup (tariff) for inpatient |
| `rekapitulasi.detailHak` | GET | `poliklinik/rekapitulasi/rekapitulasi_detail_hak` | html | Entitlement-detail billing recap |
| `rekapitulasi.detailHakHtml` | GET | `poliklinik/rekapitulasi/rekapitulasi_detail_hak_html` | html | Printable variant of the entitlement recap |
| `verifikator.getCekVerifikasi` | POST | `poliklinik/verifikator/get_cekverifikasi` | text | Pre-verification status (legacy `_post_text`; a bare status string, `""`/`"0"` = open) |
| `verifikator.cekStatusKeluar` | POST | `poliklinik/verifikator/cekstatus_keluar` | text | Discharge state ("SUDAH KELUAR") |
| `verifikator.cekTransaksiPenunjang` | POST | `poliklinik/verifikator/cektransaksi_penunjang` | json | Penunjang blocker check |
| `verifikator.cekBiayaAdministrasi` | POST | `poliklinik/verifikator/cekbiayaadministrasi` | text | Whether the administration fee is already posted |
| `verifikator.cekTindakanAdministrasi` | POST | `poliklinik/verifikator/cektindakan_administrasi` | text | Administration tindakan lines on a poli transaction |
| `verifikator.cekTindakanTransfer` | POST | `poliklinik/verifikator/cektindakan_transfer` | text | Whether a tindakan code is transferable |
| `verifikator.getDataKunjungan` | POST | `poliklinik/verifikator/getdatakunjungan` | json | Verifikator visit data |
| `verifikator.getDataKunjunganTab` | POST | `poliklinik/verifikator/getdatakunjungan_tab` | json | Verifikator room tab data |
| `verifikator.getDetailTransaksi` | GET | `poliklinik/verifikator/getdetail_transaksi` | json | Per-tindakan component (pelaksana/jasa) detail |
| `verifikator.getListRuang` | POST | `poliklinik/verifikator/get_listruang` | json | Rooms occupied during a registration |
| `verifikator.getListTindakan` | GET | `poliklinik/verifikator/get_listtindakan` | json | Tindakan lines visible to the verifikator |
| `verifikator.getTindakan` | GET | `poliklinik/verifikator/gettindakan` | json | Master tindakan lookup (tariff) for the verifikator |
| `laboratorium.cekStatusBayar` | POST | `laboratorium/registrasi_pemeriksaan/cekstatusbayar` | text | Payment status of a lab transaction |
| `laboratorium.cekStatusBayarTransfer` | POST | `laboratorium/registrasi_pemeriksaan/cekstatusbayar_transfer` | text | Payment status of an already-transferred lab charge |
| `laboratorium.cekStatusTransfer` | POST | `laboratorium/registrasi_pemeriksaan/cekstatustransfer` | text | Lab charge transfer status |
| `laboratorium.cekStatusTransferPoliTujuan` | POST | `laboratorium/registrasi_pemeriksaan/cekstatus_transferpolitujuan` | text | Transfer status seen from the destination poli |
| `laboratorium.cekStatusVerifikasi` | POST | `laboratorium/registrasi_pemeriksaan/cekstatus_verifikasi` | text | Verification status of the destination poli transaction |
| `laboratorium.cekTransaksiTerbuka` | POST | `laboratorium/registrasi_pemeriksaan/cektransaksiterbuka` | text | Whether the lab transaction is still open |
| `laboratorium.cekTutupTransaksi` | POST | `laboratorium/registrasi_pemeriksaan/cektutuptransaksi` | text | Whether the lab transaction has been closed |
| `laboratorium.getHistoryKunjungan` | POST | `laboratorium/registrasi_pemeriksaan/gethistorykunjungan` | json | Laboratory visit history by medrec |
| `laboratorium.getListTindakan` | POST | `laboratorium/registrasi_pemeriksaan/get_listtindakan` | json | Lab tindakan lines |
| `laboratorium.getTotal` | POST | `laboratorium/registrasi_pemeriksaan/getTotal` | text | Total transferable lab charge. Read-before-write for `transferLab` |
| `laboratorium.viewRaw` | POST | `laboratorium/registrasi_pemeriksaan/view_raw` | text | Raw analyser result text |
| `laboratoriumHasil.cetakLis` | POST | `laboratorium/hasil_pemeriksaan/cetak_lis` | html | LIS printout markup |
| `laboratoriumHasil.lisPdfHead` | HEAD | `lis_new/pdf.php` | raw | Same-origin LIS PDF headers for regular-lab result validation |
| `laboratoriumHasil.lisPdf` | GET | `lis_new/pdf.php` | raw | Same-origin LIS PDF body fallback for regular-lab result validation |
| `laboratoriumHasil.getDataKunjungan` | POST | `laboratorium/hasil_pemeriksaan/getdatakunjungan` | json | Lab-result visit search |
| `laboratoriumHasil.getDataTransaksi` | POST | `laboratorium/hasil_pemeriksaan/getdatatransaksi` | json | Lab-result transaction rows |
| `laboratoriumHasil.getDetailTransaksi` | GET | `laboratorium/hasil_pemeriksaan/getdetailtransaksi` | json | Lab-result transaction detail |
| `laboratoriumHasil.getHasilPemeriksaan` | POST | `laboratorium/hasil_pemeriksaan/gethasilpemeriksaan` | json | Structured laboratory results |
| `radiologi.cetakA4` | GET | `radiologi/hasil_pemeriksaan/cetak_a4` | html | A4 radiology result printout / PDF |
| `radiologi.getBerkas` | POST | `radiologi/hasil_pemeriksaan/getberkas` | json | Files attached to a radiology transaction |
| `radiologi.getDataKunjungan` | POST | `radiologi/hasil_pemeriksaan/getdatakunjungan` | json | Radiology-result visit search. `rajal_v23.js:917` names `get_datapasien`, an action this controller does not expose; this is its real result search and takes the same `txtmedreccari_hslrad`. Legacy sends no paging |
| `radiologi.getDataStudyIud` | POST | `radiologi/hasil_pemeriksaan/getdata_studyiud` | json | PACS study UID for a radiology transaction |
| `radiologi.getDataTransaksi` | POST | `radiologi/hasil_pemeriksaan/getdatatransaksi` | json | Radiology-result transaction rows |
| `radiologi.getHasilPemeriksaan` | POST | `radiologi/hasil_pemeriksaan/gethasilpemeriksaan` | json | Radiology report rows |
| `elektromedik.getHistoryKunjungan` | POST | `elektromedik/registrasi_pemeriksaan/gethistorykunjungan` | json | Elektromedik visit history (order side; used by `ranap`). For the outpatient *result* search use `elektromedikHasil.getDataPasien` |
| `elektromedik.getDataKunjungan` | POST | `elektromedik/registrasi_pemeriksaan/getdatakunjungan` | json | Elektromedik visit data |
| `elektromedik.getListTindakan` | POST | `elektromedik/registrasi_pemeriksaan/get_listtindakan` | json | Elektromedik tindakan lines |
| `elektromedik.cekStatusBayar` | POST | `elektromedik/registrasi_pemeriksaan/cek_statusbayar` | text | Payment status ("0"/"1") |
| `elektromedikHasil.getDataPasien` | POST | `elektromedik/hasil_pemeriksaan/get_datapasien` | json | Elektromedik *result* search by medrec (`{no_medicalrecord}`); rows carry `no_transaksi` + `tgl_transaksi`. Legacy sends no paging |
| `elektromedikHasil.cetakHasilPemeriksaan` | GET | `elektromedik/hasil_pemeriksaan/cetakHasilPemeriksaan` | html | Elektromedik result printout / PDF |
| `elektromedikHasil.getHasilPemeriksaan` | GET | `elektromedik/hasil_pemeriksaan/getHasilPemeriksaan` | text | Elektromedik result text for one item |
| `elektromedikHasil.getListHasilPemeriksaan` | POST | `elektromedik/hasil_pemeriksaan/getListHasilPemeriksaan` | json | Elektromedik result items on a transaction |
| `pa.hasilCetak` | GET | `pa/hasil_pemeriksaan/hasilcetak` | html | Pathology (PA) result printout / PDF |
| `kemoterapi.getHistoryOrderPa` | POST | `kemoterapi/registrasi_pemeriksaan/gethistory_orderpa` | json | Pathology (PA) order history by medrec |
| `kemoterapi.getDetailHistoryOrderPa` | GET | `kemoterapi/registrasi_pemeriksaan/getdetail_history_orderpa` | json | Line detail of one pathology (PA) order |
| `laporanBelumBayar.preview` | GET | `laporan/laporan_belum_bayar/preview` | html | Unpaid-bill report table, grouped by unit section. Outpatient batch discovery. GET: all eighteen parameters travel in the query string (see below) |
| `laporanKeluarRanap.preview` | GET | `rekam_medis/laporan_keluar_rwi_kasir/preview` | html | Discharged-inpatient report (PASIEN KELUAR RAWAT INAP): No. RM, ruang, jaminan, tgl masuk/keluar, verification. Ranap run-setup "Ambil data"; filters `verifikasi`/`bayar` = ''/1/0 |

## Mutating endpoints (allowlist)

29 entries: 3 `critical`, 26 `high`. Every one carries
`requiresApproval: true`, is blocked outright in preview, and must additionally
appear on the running workflow's `mutationAllowlist`.

All 29 are `POST`. 26 declare `response: 'text'` — the legacy `_write_text`
wrapper reads `resp.text`, so SIMRS answers a write with a bare status string
(often `""` or `"1"`) that `_write_result_is_success` inspects, never JSON. The
three exceptions, reached through `_write_json`, are `verifikator.simpanVerifikasi`,
`elektromedik.transferTagihan` and `elektromedik.batalTransfer`.

| id | risk | path | approval | verification rule |
|---|---|---|---|---|
| `kasir.tampungBayar` | critical | `kasir/kasir/tampung_bayar` | required | Re-read `getHistoryPembayaran` is non-empty after write |
| `kasir.updateTglMasuk` | high | `kasir/kasir/update_tgl_masuk` | required | Re-read transaction admit date matches |
| `kasir.updateTgl` | high | `kasir/kasir/update_tgl` | required | Re-read tindakan date matches |
| `rekamMedis.simpanSep` | high | `rekam_medis/upload_berkas/simpanSEP` | required | Re-read SEP equals written value |
| `poliklinik.batalKirimOk` | high | `poliklinik/poliklinik/batal_kirim_ok` | required | `penatajasaInap.cekOkKirim` reports the order unsent |
| `poliklinik.batalTransfer` | high | `poliklinik/poliklinik/batal_transfer` | required | `poliklinik.cekStatusTransfer` clears and `cekJumlahTransfer` decreases |
| `poliklinik.hapusTindakan` | high | `poliklinik/poliklinik/hapus_tindakan` | required | Line absent from `poliklinik.getListTindakan`; `cekStatusBayar` was "0" before |
| `poliklinik.tambahTindakanPolis` | high | `poliklinik/poliklinik/tambah_tindakan_polis` | required | New line present in `poliklinik.getListTindakan` at the expected tariff |
| `poliklinik.tampungPelaksana` | high | `poliklinik/poliklinik/tampung_pelaksana` | required | `verifikator.getDetailTransaksi` shows the intended pelaksana split |
| `poliklinik.transferIgd` | high | `poliklinik/poliklinik/transfer_igd` | required | Response contains "transfer sukses" and the charge appears on the inpatient bill |
| `poliklinik.updateTgl` | high | `poliklinik/poliklinik/update_tgl` | required | Re-read tindakan date matches |
| `penatajasaInap.batalKirimOrderGizi` | high | `poliklinik/penatajasa_inap/batalkirim_ordergizi` | required | `getHistoryOrderGizi` reports the order unsent |
| `penatajasaInap.hapusDetailOrderGizi` | high | `poliklinik/penatajasa_inap/hapus_detailordergizi` | required | Line absent from `getDataOrderGizi` |
| `penatajasaInap.hapusOrderOk` | high | `poliklinik/penatajasa_inap/hapus_order_ok` | required | Order absent from `getListTindakanOk`; `cekOkTerlayani` was unserved before |
| `penatajasaInap.hapusTindakan` | high | `poliklinik/penatajasa_inap/hapus_tindakan` | required | Line absent from `penatajasaInap.getListTindakan`; `cekStatusBayar` and `cekStatusVerifikasi` were "0" before |
| `penatajasaInap.kirimOrderGizi` | high | `poliklinik/penatajasa_inap/kirim_ordergizi` | required | `cekOrderGizi` / `getHistoryOrderGizi` reports the order sent |
| `penatajasaInap.tambahTindakanPolis` | high | `poliklinik/penatajasa_inap/tambah_tindakan_polis` | required | New line present in `penatajasaInap.getListTindakan` at the expected tariff |
| `penatajasaInap.updateTgl` | high | `poliklinik/penatajasa_inap/update_tgl` | required | Re-read tindakan date matches; `cekStatusVerifikasi` was "0" before |
| `verifikator.simpanVerifikasi` | critical | `poliklinik/verifikator/simpan_verifikasi` | required | `cekStatusVerifikasi` flips to verified; no penunjang blocker |
| `verifikator.batalVerifikasi` | critical | `poliklinik/verifikator/batal_verifikasi` | required | `cekStatusVerifikasi` reopens |
| `verifikator.bukaBhp` | high | `poliklinik/verifikator/buka_bhp` | required | `verifikator.getCekVerifikasi` shows BHP posting reopened |
| `verifikator.hapusTindakan` | high | `poliklinik/verifikator/hapus_tindakan` | required | Line absent from `verifikator.getListTindakan` |
| `verifikator.tambahTindakanPolis` | high | `poliklinik/verifikator/tambah_tindakan_polis` | required | New line present in `verifikator.getListTindakan` at the expected tariff |
| `laboratorium.batalTransfer` | high | `laboratorium/registrasi_pemeriksaan/batal_transfer` | required | `laboratorium.cekStatusTransfer` clears; charge gone from destination bill |
| `laboratorium.bukaBhp` | high | `laboratorium/registrasi_pemeriksaan/buka_bhp` | required | `cekTransaksiTerbuka` reports the transaction open |
| `laboratorium.transferLab` | high | `laboratorium/registrasi_pemeriksaan/transfer_lab` | required | `cekStatusTransfer` set and the `getTotal` amount lands on the destination bill |
| `laboratorium.tutupBhp` | high | `laboratorium/registrasi_pemeriksaan/tutup_bhp` | required | `cekTutupTransaksi` reports the transaction closed |
| `elektromedik.transferTagihan` | high | `elektromedik/registrasi_pemeriksaan/transferTagihan` | required | Charge appears on target bill |
| `elektromedik.batalTransfer` | high | `elektromedik/registrasi_pemeriksaan/batalTransfer` | required | Charge removed from target bill |

## `tampung_bayar` payload shape

The most sensitive write. Fields (from `ranap_v3.py` / rajal userscript):

```
no_reg          no_registrasikunjungan
no_transaksi    no_transaksi
kd_unit         kd_unit
ck_retur        "false"
kd_penjamin     payer code (e.g. "15")
dt_bayar        URL-encoded sub-form:
                  cmbshift_pembayaran, cmbjenis_pembayaran,
                  txtjumlah_pembayaran, txtjmltagihan_pembayaran,
                  txtjmldibayar_pembayaran, ...
tindakan        JSON.stringify([ line items ])
```

`dt_bayar` is **double-encoded** (a URL-encoded string nested in the outer
form body). The client treats the whole payload as opaque strings and never
logs it un-redacted.

The `cmbshift_pembayaran` / `cmbjenis_pembayaran` values come from
`kasir.getShiftBayar` and `kasir.getJenisBayar`, which return `<option>`
markup rather than JSON.

## `laporan_belum_bayar/preview` query shape

Outpatient batch discovery. A **GET** returning an HTML report table — the
client only form-encodes a body for POSTs, so every parameter must be passed
as `options.query` or it is dropped. `buildRajalUnpaidReportQuery` in
`@simrs-flow/domain-rajal` builds the whole set; only three of the eighteen
carry information (`rajal_v23.js:1464`):

```
cmbinstalasi        instalasi code — "1" rawat jalan, "14" penunjang,
                    "2" rawat inap, "3" IGD
txtperiode1         period start (ISO)
txtperiode2         period end (ISO)
ckstatus            "false"      ckstatustidakbatal  "true"
ckbaru / cklama / ckkasusbaru / ckkasuslama         "false"
cmbunit, cmbshift, namaunit, cmbpenjamin,
kd_ruangperawatan, nama_ruangperawatan,
kd_kamarperawatan, nama_kamarperawatan, kd_icdx     ""
```

The response is one flat `table[border="1"]`: a `colspan="13"` row carrying a
`<b>`/`<strong>` is a unit heading, a `colspan="12"` row is a subtotal, and any
other row with at least thirteen cells and an integer in cell 0 is a patient
(cells 1, 2, 3 and 5 are transaksi, medrec, name and penjamin). Some cells are
commented out, so comments must be stripped before the columns are counted.
`parseRajalUnpaidReport` does this without a DOM.

## Known field-name inconsistencies

The backend does not normalise its own parameter names. Recorded here so a port
does not "tidy" them:

| Concept | Names in use |
|---|---|
| Medical record no. | `txtmedrec`, `txtmedrec_pdft`, `txtmedrec_poli`, `txtmedrec_inap`, `txtmedrec_vrf`, `nomedrec`, `no_medicalrecord`, `No_MedicalRecord`, `txtmedreccari_hsllab`, `txtmedreccari_hslrad` |
| Registration no. | `no_registrasikunjungan`, `no_reg`, `No_Reg`, `filterNoReg` |
| Transaction no. | `no_transaksi`, `no_transaksipoli`, `No_Transaksi`, `No_Transaksi_Poli`, `no_trans`, `no_transaksi_ordergizi` |
| Payer class code | `kd_detkelpenjamin`, `Kd_DetKelPenjamin`, `Kd_DetKelPenjamin_Poli` |
| Date to write | `txtupdatetgl_kasir`, `txtupdatetgl_poli`, `txttglupdate_inap`, `tgl_jam` |

## Adding an endpoint

1. Add the entry to `ENDPOINTS` in `endpoints.ts` with `kind` and `riskLevel`.
2. If mutating, set `requiresApproval: true` and document its verification
   rule above and in `risk-register.md`.
3. Add the endpoint to the read or mutate table above.
4. The registry-wide contract tests in `evomedis-client.test.ts` cover id/key
   agreement, `path`+`method` uniqueness, approval on every mutation, and a
   preview-blocks-every-mutation sweep — no per-endpoint test is needed for
   those. Add a response-shape test (valid, empty, malformed, login,
   PHP-error) when the endpoint's parsing is non-obvious.
5. Promoting an endpoint to `riskLevel: 'critical'` changes the two-person-rule
   surface and will fail the pinned critical-set test until that list is
   updated deliberately.

Anything not in the registry is **blocked** by `UnknownEndpointError`.
