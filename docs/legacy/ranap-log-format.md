# Rawat inap operator log format

The ward's billing operators read the inpatient run log top to bottom while it
executes. `ranap_v3.py` prints a specific shape and they know it by eye, so the
port reproduces it rather than inventing something tidier.

This document is the spec. It is transcribed from
`EvoMedis-Helper/Proses pengerjaan billing rawat inap unt.md` and from the
`_log_*` helpers in `ranap_v3.py`. The implementation lives in
`packages/domain-ranap/src/logic/logFormat.ts` (line builders) and the
executors that call it; the run console renders it in
`apps/ui/src/features/panels/RunConsole.tsx`.

## The four line shapes

| Shape | Form | Example |
|---|---|---|
| heading | column 0, usually ends `...` | `Mencari kunjungan yang bisa diproses...` |
| bullet | `+ ` prefix, optionally indented | `+ Ditemukan 2 kunjungan yang bisa di payment:` |
| numbered | `N. ` then aligned pairs | `    1. Unit         : RUANG ARAFAH KELAS 3` |
| pair | `- label : value`, colons aligned | `    - No RM         : 0-01-23-45` |

Two rules apply to every block:

- **Colons align within a block.** The label column is padded to the widest
  *visible* label, so hiding a debug field re-tightens the column rather than
  leaving a ragged gap.
- **A blank value renders as `-`,** never as an empty column. Booleans render
  as `Ya` / `Tidak`.

Because the alignment is carried in the message text itself, nothing may be
prepended to a log line when it is displayed. The run console therefore puts
the timestamp and the step name in a per-step header, not on each line.

## Debug-only fields

> *"untuk data seperti no reg, no trx, source sep munculkan ketika mode debug
> aktif saja"* — spec line 59
>
> *"Hide preflight order gizi - aktifkan di mode debug saja"* — spec line 60

`debug_mode` (`RanapInput.debugMode`, the **Mode debug** switch in the run form)
gates:

- `No reg` (`no_registrasikunjungan`) wherever it appears
- transaction numbers used as identifiers — but see the exception below
- the SEP source (`sep_class_source`, the jenis-SEP fallback source)
- `Kd unit`, `Kd instalasi`, `Kd kelpenjamin`, `Kd paramedis`
- the whole gizi preflight block
- the inferred-origin detail rows (SEP match / doctor match / exact date / HD signal)
- the **whole** `- Fallback visite CPPT | reg=… | aksi=… | source=… | kandidat=…`
  line, not just its fields. It is `_log_spesialis_v2_fallback`
  (`ranap_v3.py:11406`), printed once per group of colliding specialist rows
  immediately before `_pick_spesialis_keep_row` ranks them, and it exists only to
  show the CPPT evidence behind the tie-break. `DEBUG_MODE` gates the whole
  `print`, so the port builds the line only when `debugMode` is on.

**Exception:** `No trx pasien` in the kasir identity block is *not* debug-only.
The spec lists it in the plain `+ Data:` block (line 33) and `ranap_v3.py:15957`
passes it with no debug flag while explicitly marking `No reg` debug-only.

A failure *reason* is never debug-only. An operator who cannot see why a step
refused cannot act on it, so balance differences, blocker reasons and titipan
reasons all print in both modes.

Transaction numbers must also stay out of alert *message text*, because alerts
are re-printed by the pre-verification summary and can reach the verification
summary's `keterangan` column, neither of which knows about the debug flag.
Alerts carry unit names; the transaction numbers travel in structured evidence
that the renderer can gate.

## The expected sequence

Section headings, in order, with the step that emits each:

```
Proses pengerjaan billing rawat inap untuk no rm <rm> dimulai   normalize_input
Filter penjamin aktif / nonaktif                                normalize_input
    Accepted: <keywords | ALL>

Mencari kunjungan yang bisa diproses...                         load_visits
+ Ditemukan N kunjungan yang bisa di payment:
    1. Unit         : …
       Tgl masuk    : …
       No reg       : …                                         (debug)
       No trx       : …                                         (debug)
       Kd unit      : …                                         (debug)
       Penjamin     : …

Mengambil SEP untuk transaksi: <trx> / unit <unit>              validate_sep
+ Data:
    - No kartu BPJS : …
    - SEP           : …
    - Jenis SEP     : …
    - Diagnosa awal : …
    - No rujukan    : …
    - PPK Pelayanan : …
    - Tgl SEP       : …
    - Tgl pulang    : …

Mengambil data transaksi dari menu kasir untuk data awal...     load_kasir
+ Data:                                                         (spec field order)

Validasi SEP antara pendaftaran dengan data transaksi kasir...  compare_sep
+ Hasil:
    - SEP kasir       : …
    - SEP pendaftaran : …
    - PPK pelayanan   : …
    - Hasil           : SEP correct! | SEP mismatch

Assignment hari ruang...                                        build_rooms
    1. Ruang   : …
       Tanggal : <hari yang ditagihkan ke ruang ini>

    1. Ruang : …                                                evaluate_titipan
      + Tanggal: …
      + Evaluasi titipan
           - Kelas SEP   : …
           - Kelas ruang : …
           - Hasil       : NORMAL | TITIPAN | PERLU CEK MANUAL
           - Alasan      : …

Mencari cara masuk pasien untuk N grup rawat inap...            detect_origin
+ Origin rawat inap
    - Poliklinik        : Ya | Tidak
    - IGD               : Ya | Tidak
    - Cara masuk pasien : Poliklinik | IGD | Tidak dicek (BYNY)

Memulai proses perapihan billing rawat inap...
1. Perapihan asal masuk pasien: <cara masuk>                    process_igd / process_poli
   + Sinkronisasi tindakan
2. Mengecek apakah ada transaksi lain yang masih menggantung…   scan_hanging_trx
3. Sinkronisasi tindakan rawat inap untuk N transaksi...         sync_tindakan
   1. Nama ruang     : …
      Pelaksana jasa : …
      Tanggal        : …
      + Sinkronisasi tindakan
   + Batal verifikasi sebelum perbaikan tindakan:                sync_tindakan /
        - Baris    : …                                           sync_visite
        - Tindakan : …
        - Alasan   : …
4. Sinkronisasi visite/konsultasi spesialis untuk N grup...      sync_visite
5. Validasi IBS untuk N grup rawat inap...                       validate_ibs
6. Validasi hasil penunjang untuk N grup rawat inap...           validate_penunjang
7. Cek obat pulang untuk N grup rawat inap...                    validate_obat_pulang

- Summary sebelum verifikasi                                     preverify_summary
+ Cek balance total tagihan:                                     check_balance
+ Hasil verifikasi rawat inap:                                   execute_verifikasi
                                                                 (second pass only)
+ Tampung bayar:                                                 tampung_bayar

Ringkasan verifikasi rawat inap                                  emit_summary
nama pasien	no rekam medis	PBI/NON PBI	user_proses	grand total	tanggal masuk	tanggal keluar	keterangan
```

The final block is tab-separated on purpose: operators paste it straight into
the recap sheet. The inspector renders it as a table with a **Copy TSV** button.

## When you change the log

The format is load-bearing, so a change to it is a change to an interface:

1. Update this document first.
2. `classifyLogLine` in `apps/ui/src/features/panels/logView.ts` recognises
   lines by their leading characters. A new shape needs a case there and a test
   in `apps/ui/src/logView.test.ts`.
3. `packages/domain-ranap/src/domain-ranap.test.ts` asserts the headings and
   the debug gating. Both must still pass — those tests are what stop a
   debug-only identifier from leaking into a non-debug run.
