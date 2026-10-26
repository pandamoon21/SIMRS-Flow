# Parity status against `rajal_v23.js`

`EvoMedis-Helper/rajal_v23.js` (userscript "PKU-Gombong Patient Processor
v27.2", 1643 lines) is the behavioural authority for outpatient billing. This
document records how much of it the port reproduces, and — more usefully —
exactly what it does not.

Read it before assuming a behaviour is covered. Where the outpatient script is
ambiguous, `ranap_v3.py` is consulted as a second oracle for the endpoints the
two share, and every such case is flagged below.

## Where it stands

| | Legacy | Port |
|---|---|---|
| Pipeline | `startRun` → `processPatient` → `processRecord` | 21 graph nodes |
| Distinct endpoints called | 27 EvoMedis paths (+ the same-host LIS PDF probe) | 26 EvoMedis paths registered, plus the LIS HEAD/GET probe. The 27th EvoMedis path does not exist server-side — see below |
| Business rules | inline in `processRecord` + 11 helpers | 17 pure functions in `legacyConfig.ts` |
| Tests | none (the script *is* the test) | 128 in `domain-rajal.test.ts` (was 126, was 122, was 110, was 87, was 35) |

The port is a controlled executor, not an inline userscript actor: `submit_payment`,
the SEP correction and the verification close all emit executable `MutationPlan`s
and never call the endpoint directly. Preview reproduces the decisions and none
of the effects; write mode may apply an approved plan only through the mutation
gate's read-before-write and read-after-write checks.

## The legacy pipeline, step by step

`processRecord` (source lines 875-1034) is the unit of work. Each row is one of
its guards, in execution order.

| # | Legacy step (line) | Endpoint | Port node | Status |
|---|---|---|---|---|
| 1 | `formatPatientId` (703) | — | `normalize_ids` | parity |
| 2 | patient name + history (1038, 1043) | `pendaftaran/…/getdatakunjungan`, `kasir/kasir/gethistorykunjungan` | `load_history` | parity; unreadable history now `needs_review` |
| 3 | untransferred penunjang visit (1045) | — | `filter_records` | parity (stricter: see note 1) |
| 4 | `findMatchingRecords` + `resolveClinicMatch` (728, 293) | — | `filter_records` | **gap closed** |
| 5 | `getMatchedClinic` ambiguity skip (747) | — | `filter_records` | **gap closed** |
| 6 | `rencanaOnko` chemo blocker (886) | `kasir/kasir/get_rencana_onko` | `check_rencana_onko` | **gap closed** |
| 7 | exit-date hard block (891) | `poliklinik/poliklinik/getdatacarakeluar_tab` | `validate_exit_date` | **gap closed** (real endpoint, substitute dropped) |
| 8 | rawat-inap rejection (894) | `kasir/kasir/getdatatransaksi` | `validate_transaction` | parity; **payload field fixed** |
| 9 | `verifyTreatmentGroups` skip list + AND/OR (762) | `kasir/kasir/get_listtindakan` | `validate_treatment` | **gap closed** |
| 10 | radiology validation (909) | `gethistoryirad`, `get_datapasien`, `gethasilpemeriksaan` | `validate_radiology` | parity; **substitution settled, paging dropped** |
| 11 | elektromedik validation (929) | `get_datapasien`, `getListHasilPemeriksaan` | `validate_elektromedik` | parity; **real endpoint now used, paging dropped** |
| 12 | lab PA validation (945) | `gethistory_orderpa`, `getdetail_history_orderpa`, `pa/…/hasilcetak` | `validate_lab_pa` | parity |
| 13 | regular lab validation (965) | `gethistoryilab`, `cetak_lis`, LIS PDF | `validate_lab` | parity; same-origin PDF HEAD/GET probe registered |
| 14 | `checkSep` (797) incl. card fallback + sibling SEP | `getdatakunjungan`, `getdatapenjamin_tab`, `get_datariwayatsep` | `validate_sep` | parity; **sibling set corrected** |
| 15 | `updateSep` (866) | `rekam_medis/upload_berkas/simpanSEP` | `validate_sep` plan | executable plan; gate-applied only |
| 16 | already-paid rejection (999) | `kasir/kasir/getJumlahBayar` | `check_payment` | parity; unreadable now `needs_review` |
| 17 | unserved orders (1006) | `kasir/kasir/cek_order_belum_terlayani` | `check_verification` | **gap closed** |
| 18 | untransferred orders (1007) | `kasir/kasir/cek_order_belum_transfer` | `check_verification` | **gap closed** |
| 19 | unverified penunjang (1010) | `poliklinik/verifikator/cektransaksi_penunjang` | `check_verification` | **gap closed** |
| 20 | verification status (1012) | `kasir/kasir/cekstatus_verifikasi` | `check_verification` | parity; **failed read no longer reads as clean** |
| 21 | `simpan_verifikasi` (1014) | `poliklinik/verifikator/simpan_verifikasi` | `check_verification` plan | **gap closed** (was missing entirely) |
| 22 | `tampung_bayar` (1021) | `kasir/kasir/tampung_bayar` | `submit_payment` plan | **payload + preconditions corrected** |
| 23 | auto-fetch batch discovery (1451) | `laporan/laporan_belum_bayar/preview` | `normalize_ids` (via `fetchRajalUnpaidBatch`) | **gap closed** |

## What is at parity

**Decisions.** Patient-id normalisation; the untransferred-penunjang batch
block; the scored clinic matcher including its five score tiers, both
tie-breaks and the ambiguity skip; the chemotherapy-plan blocker; the
exit-date hard block; the treatment skip list and the grouped
AND/OR requirements with legacy's case asymmetry; all four penunjang result
validators, including the regular-lab old-LIS shortcut and same-origin
`/lis_new/pdf.php` HEAD/GET byte-size probe; SEP resolution end to end (BPJS
card `no_kk` → guarantor-tab
fallback with the `33…`/length-9 rule, 13-digit padding, four bridge retries,
same-day RJTL filtering, poli-tujuan candidate matching, and the unique
sibling-clinic "poli asal" fallback); the already-paid rejection; the three
pre-verification blockers; the verification decision; the `tampung_bayar`
payload including the nested form-encoded `dt_bayar`; batch-discovery report
scraping with its section exclusions and clinic→patient auto-map; and
per-record pruning, where a failed/unreadable/blocked record is dropped from
scratch while clean survivors continue to payment planning.

**Structure.** Every guard `processRecord` performs now has a node. The graph
grew from 20 to 21 nodes: `check_rencana_onko` was absent entirely. Batch
discovery has no node of its own — it decides what a run is *given*, not what a
record is, so `normalize_ids` runs it when the input asks for it (see "Third
pass" below).

**Wire format.** Endpoint ids, HTTP methods and payload field names are checked
against the legacy call site. `FixtureTransport` keys on the endpoint id and
ignores parameters, so a fixture-passing run does **not** prove the payload was
right — the `rajal request shapes` block in `domain-rajal.test.ts` is what
proves it, and it cites the legacy line for each assertion.

## Defects this audit found and fixed

Each was a live billing risk, not a style difference.

1. **`validate_exit_date` passed on failure.** It called
   `pendaftaran.getDataKunjungan` — the wrong endpoint — with a *registration
   number* in `txtmedrec_pdft`, wrapped the call in `.catch(() => undefined)`,
   and then returned `success` when the field was missing. A legacy hard block
   (line 892) could therefore never fire. It now reads `tgl_keluar` off the
   visit row: empty → `blocked`, field absent → `needs_review`.
2. **`kasir.getDataTransaksi` sent the wrong value.** `txtmedrec` carried
   `no_registrasikunjungan`; legacy line 894 sends the medrec. The controller
   does not recognise a reg number there, so the rawat-inap rejection was
   reading a response for the wrong patient.
3. **The pre-verification trio was missing.** All three endpoints are
   registered; the port read none of them. Legacy refuses to pay on any
   (lines 1009-1011).
4. **`check_verification` swallowed a failed read as "unverified".**
   `.catch(() => '0')` turned an unreachable endpoint into eligibility for
   payment. A non-numeric reply is now `needs_review`.
5. **An already-verified record was never paid.** The step overwrote
   `scratch.payable` with only the *unverified* records, so a verified-but-unpaid
   bill silently dropped out of the batch. Legacy's `else` branch (line 1017)
   falls straight through to `tampung_bayar`.
6. **The `simpan_verifikasi` write had no plan.** It was on the
   `mutationAllowlist` but no executor ever proposed it, so the port could
   never close a verification even in write mode.
7. **`tampung_bayar`'s preconditions asserted the opposite of the truth.**
   The plan required `cekStatusVerifikasi === '0'` at write time, but legacy
   *verifies first and then pays* — so once `RunService` replays preconditions,
   that check would have refused every legitimate payment. Replaced with the
   five checks that actually guard the endpoint.
8. **`tampung_bayar`'s payload was a two-field stub.** `{no_transaksi, total}`
   instead of the seven fields legacy sends. Now built by
   `buildRajalTampungBayarPayload`, including the nested `dt_bayar` string and
   the full `tindakan` array.
9. **The clinic matcher was a naive substring test.** `unit.includes(c) ||
   c.includes(unit)`, with a fallback to the raw unit name when nothing matched
   — so an unmatched record still got a clinic, and an ambiguous one was billed
   against whichever clinic came first in the array.
10. **`validate_sep` built its sibling set from the raw history.** Legacy uses
    `matching` (line 1057), so a dropped penunjang visit could donate its SEP
    to a clinic bill. One test asserted the buggy behaviour and was changed with
    a comment saying so.
11. **The treatment groups were never enforced.** `RAJAL_TREATMENT_TEMPLATES`
    was exported for the UI, but no executor read it; the skip list was likewise
    unenforced. Only an ad-hoc include/exclude/min-count filter ran.
12. **The date filter was fail-open.** `!r.tgl_masuk || …` admitted a record
    with no admission date; legacy's string range comparison rejects it. The
    range itself (`dateFrom`/`dateTo`) was also collapsed to a single day.
13. **Unreadable reads reported as empty.** A visit-history or treatment-list
    reply with no `rows` array read as "no visits" / "no treatments" rather than
    "not read".
14. **Preconditions were unreplayable, and two of the new ones were wrong.**
    Precondition enforcement landed in `RunService` while this audit was in
    flight, which turned every plan's checks from documentation into a live
    refusal path. Two problems fell out. First, none of the checks carried a
    replay body, so they would have inherited the plan's own payload — and the
    cashier write spells the registration `no_reg` where every guard read wants
    `no_registrasikunjungan`, so the replay would have queried an unscoped
    registration. Second, the natural spelling of "no blocker" is wrong in both
    directions, verified against the real comparator:

    | `expected` | observed | verdict |
    |---|---|---|
    | `{total: 0}` (infers `subset`) | `{}` — a clean reply | **refuses** |
    | `{}` (infers `subset`) | `{nama_unit: 'LAB'}` — a blocker | **holds** |
    | `match: 'empty'` | `{}` / `{total: 0}` | holds |
    | `match: 'empty'` | `{nama_unit: 'LAB'}` | refuses |

    So a subset check would have blocked every clean payment, and an empty-object
    check would have been a precondition that can never fail. All blocker checks
    now set `match: 'empty'` explicitly, `kasir.getHistoryPembayaran` uses
    `query` because it is a GET, and the `cekStatusVerifikasi` read-after-write
    uses `field: ''` with `match: 'nonEmpty'` because that endpoint answers with
    a bare `"0"`/`"1"` and `"0"` is one of the comparator's empty spellings.
    Two tests cover it: one asserts every precondition has a replay body that
    does not inherit `no_reg`, the other replays every check through
    `evaluateExpectation` against the clean fixtures and asserts it still holds.
15. **Two `critical` flags were wrong in a way that defeated the graph.**
    `validate_exit_date` and `check_rencana_onko` sit upstream of the `parallel`
    fan-out into the penunjang checks, and the runner treats a `parallel` edge
    as an optional join. A non-critical `blocked` there was swallowed: the
    penunjang nodes ran, returned a benign `skipped`, and `check_payment` went
    on to plan a payment off `scratch.matching`. Both are now `critical`, and a
    regression test asserts no payment plan survives that block.
16. **Per-record blockers leaked across the batch.** Legacy returns from one
    `processRecord` and continues with the next; the port used one scratch set for
    the whole node, so the first blocked or unreadable record either failed every
    survivor or left stale state reachable by `submit_payment`. The rajal
    validators now prune rejected records from `matching`, `transactions`,
    `treatments`, and `payable`; a partial batch returns `needs_review` with the
    skipped records named, while clean survivors still plan payment. Focused
    two-record tests cover untransferred penunjang, unreadable treatment rows and
    pre-verification blockers.

Defect 14 also invalidates gap 6 as it was originally written for ranap: for
rajal the preconditions **are** now replayed at write time, so a wrong one is a
wrong refusal rather than a stale note. See the amended entry below.

## Second pass: the endpoint gaps

Everything above was decided with the endpoint registry as it stood. Three
legacy calls were missing from it, and two more were standing in for calls the
audit could not verify. All five are settled here.

**Registered.** Four new read entries, each confirmed against the legacy call
site *and* against the crawled route dumps in `EvoMedis-Helper`
(`endpoints_routes.txt`, `endpoints_index.txt`, `endpoints_routes_deep.txt`):

| id | method | path | evidence |
|---|---|---|---|
| `kasir.getRencanaOnko` | POST | `kasir/kasir/get_rencana_onko` | `rajal_v23.js:887` (and `rajal_v19.js:504`) sends `{no_registrasikunjungan}` through `postFetch`, which is a form-encoded POST expecting JSON. Route present in all three dumps |
| `poliklinik.getDataCaraKeluarTab` | POST | `poliklinik/poliklinik/getdatacarakeluar_tab` | `rajal_v23.js:891` (`rajal_v19.js:508`), same shape. Route present in all three dumps |
| `elektromedikHasil.getDataPasien` | POST | `elektromedik/hasil_pemeriksaan/get_datapasien` | `rajal_v23.js:933` sends `{no_medicalrecord}`, no paging. Route present |
| `laporanBelumBayar.preview` | GET | `laporan/laporan_belum_bayar/preview` | `rajal_v23.js:1464` builds a URL and calls `getFetchHTML` — a bare GET, no body, eighteen query parameters, HTML response. Route present |

**Wired.**

1. **`check_rencana_onko` now reads its input.** Per matching record it POSTs
   `kasir.getRencanaOnko` and runs `evaluateRajalOncologyPlan`. A plan naming
   chemo `blocked`s the run naming the transaction and quoting the plan text. A
   missing/non-JSON route is treated the same way legacy's optional chaining did:
   no chemo signal, logged at debug level, and the record continues. The node id
   is unchanged.
2. **`validate_exit_date` reads the real endpoint, and its block is a real
   block.** The substitute — `tgl_keluar` off the `gethistorykunjungan` row —
   is gone, and so is `RajalRecordRow.tgl_keluar`; there is no fallback,
   because the real read is registered. Legacy's test is `!ck?.tgl_keluar`, so
   once the discharge tab has answered, an absent field, a `null` and an empty
   string all mean "not discharged" and all block. Only a reply that is not a
   record at all — `null`, an array, a bare string — is unreadable, and that is
   `needs_review`, never `success`. `evaluateRajalExitDateResponse` is the pure
   decision; `evaluateRajalExitDate` remains as its field-level half.
3. **Batch discovery is ported.**
   `parseRajalUnpaidReport` reproduces `parseLaporanHTML` without a DOM (the
   package is isomorphic and takes no dependencies): first `table[border="1"]`
   only, `colspan="13"` + `<b>`/`<strong>` is a section heading, `colspan="12"`
   is a subtotal, ≥13 cells with an integer in cell 0 is a patient, and HTML
   comments are stripped *before* the columns are counted because the live
   report ships a commented-out `<td>` that would otherwise shift every index.
   `selectRajalUnpaidBatch` is legacy `doFetch`'s selection: the medrec list
   (duplicates kept) plus the unique count, the clinic chips from the
   non-excluded section headings re-filtered by unit, and
   `mergeAutoClinicPatients`'s medrec→clinics map. `AUTO_EXCLUDE_SECTIONS`,
   `extractClinicFromSection`, `shouldExcludeSection` and `INSTALASI_OPTIONS`
   are ported with them. `fetchRajalUnpaidBatch(client, args)` is the I/O
   shell, and `rajal.normalizeIds` calls it — see "Third pass" below.

**Substitutions settled.** Both were flagged "plausible but not verified". The
route dumps decide them, and they decide differently:

- **`radiologi.getDataKunjungan` standing in for
  `radiologi/hasil_pemeriksaan/get_datapasien` — the substitution is correct,
  and the legacy call is the wrong one.** That controller exposes no
  `get_datapasien` action at all; the only `radiologi/*/get_datapasien` routes
  in the dump are on `registrasi_pemeriksaan`. `getdatakunjungan` *is* the
  hasil controller's result search and it takes the very field legacy sent
  (`txtmedreccari_hslrad`), which is why legacy's field name transplants
  unchanged. Read literally, legacy's line 917 would 404, `postFetch` would
  return `null`, and `(dr?.rows||[])` would be empty — so the count comparison
  on line 918 would refuse every radiology record. The port keeps the working
  endpoint. Do not "restore" the legacy path.
- **`elektromedik.getHistoryKunjungan` standing in for
  `elektromedik/hasil_pemeriksaan/get_datapasien` — the substitution was
  wrong.** That action exists; the dump lists it. The substitute was a
  *registrasi* controller, and the audit's own worry was right: a registration
  history lists orders whether or not they have a result, which is the wrong
  side of the `elektroTx.length !== results.length` comparison — an ordered but
  unresulted study would have counted as resulted and the record would have
  been paid. `elektromedikHasil.getDataPasien` is registered and used;
  `elektromedik.getHistoryKunjungan` stays in the registry because `ranap`
  reads it for its own purpose.

**Paging mismatch fixed both ways.** Legacy sends no `page`/`rows` to either
search; the port sent `page=1&rows=10` to both. On a patient with more than ten
same-modality transactions that truncated the result list and the count
comparison failed closed for the wrong reason. Both calls now send the medrec
alone, and the request-shape assertions pin it.

## Third pass: auto-fetch as a run

The second pass ported the discovery *decision* and left it unreachable — the
functions existed, exported and tested, and nothing called them. Closing that
was never one more node; it changed what a run is **given**. Three things had
to move together, and all three are now in.

**The input.** `RajalInput.patientIds` and `.clinics` are optional, and a new
`RajalInput.discovery` carries `{instalasi, from, to, penjamin, unit,
maxPatients}`. A run has exactly one of the two shapes:

| | typed list | discovery |
|---|---|---|
| batch | `patientIds`, required and non-empty | the report's matched rows |
| clinics | `clinics`, required and non-empty | the report's section headings, unless `clinics` narrows them |
| effective range | `dateFrom`/`dateTo`, else `date` | `dateFrom`/`dateTo`, else the discovery period |

The four filters select on three different things, which the form spells out
because getting them confused silently changes the batch. `instalasi` and the
period are **server-side** (`cmbinstalasi`, `txtperiode1`, `txtperiode2`): they
decide what the report renders. `penjamin` and `unit` are **client-side**
scrapes of that markup — `penjamin` a case-insensitive substring of the row's
guarantor column, `unit` a comma-separated list of substrings matched against
the row's *section heading*. Nothing sends them to the controller; `cmbpenjamin`
goes out empty, and a request-shape test pins that.

The section headings do double duty: `extractClinicFromSection` strips the
`POLI ` prefix off each one to build the run's clinic list, minus the
penunjang/pharmacy groupings `shouldExcludeSection` rejects, which are billed
through their originating poli and must never become a clinic of their own.

Legacy's `autosaveCfg` (source line 413) copies the fetch period onto
`dateFrom`/`dateTo`, so the range `filter_records` matches visits against is the
same period the batch was discovered over. `effectiveRange` reproduces that.
Matching against a different window would either drop rows the report listed or
admit rows it never showed the operator.

**The flow through the graph.** No new node.

- `load_config` validates the period instead of the patient list. Handed an
  explicit list it still fails closed on an empty one; handed a discovery
  request it cannot demand a batch the run has not fetched yet.
- `normalize_ids` performs the fetch. That node is `critical`, and that is the
  whole reason the fetch lives there: an unreadable report has to **stop** the
  run. Anywhere non-critical, a block would leave the graph handing every
  downstream node an empty batch, each of which would benignly `skip`, and the
  run would finish "completed" with nothing paid — indistinguishable from a
  quiet day. So: read threw, or the reply carried no report table → `blocked`
  (the run fails, naming the period and the reason). Report rendered and listed
  nothing → `skipped`, a legitimate empty batch, with the filters quoted back.
  Over the cap → `blocked` before a single patient record is read.
- `resolve_clinics` takes the discovered chips unless `clinics` was supplied,
  in which case the supplied list wins *and* narrows: a discovered patient the
  clinic map claimed for no selected poli is dropped, which is legacy
  `removePatientIdsForClinic` (source line 373), including its `beforeManaged`
  guard that leaves a never-auto-mapped patient alone. A discovery that found
  patients but no billable poli section `blocked`s; an empty batch `skipped`s.
- Everything downstream is unchanged. The medrec→clinics map
  (`mergeAutoClinicPatients`, source line 361) is normalised onto the same
  medrec form the pipeline uses and consumed by the narrowing above; per-record
  clinic matching still runs against the union list, exactly as legacy's
  `findMatchingRecords(history, CONFIG.clinicNames, range)` does, which is what
  makes a patient discovered under two poli get processed for both.

**The guardrail (optional since 2026-10-20).** Production runs whole clinic-days, so there is no default cap and no per-run patient limit; `discovery.maxPatients` is an optional field (empty = no limit). The history below describes the original one-patient pilot cap.

The run form has always warned that pilot scope is one patient per run, and a
discovery can return a whole clinic-day. The batch size is not knowable before
the run — only the orchestrator can read the report, and the form has no route
to it — so a pre-flight count was not on offer. A cap was, and it is the one
guardrail that cannot be walked past by not reading a number: a batch above the
cap `blocked`s, and the refusal carries the real count, so the first over-cap
run *is* the count the operator wanted. The default is the same one patient the
warning states, so the stated scope and the enforced scope are one constant.
Raising it is a deliberate per-run act: the field is in the form, the summary
badge names it, and a cap above 1 raises the pilot-scope warning. Neither the
mode nor the cap is restored from `localStorage`, for the same reason execution
mode is never restored — scope is not inherited.

## Code parity status

No known rajal code/fixture-parity gaps remain in the ported outpatient rules.
Batch discovery is wired and locked, verification plans carry all read-after-write
checks, per-record pruning keeps clean survivors moving without leaking stale
scratch into payment planning, the legacy payment/shift vocabularies are exposed
as labels while the run still stores the backend codes, and the regular-lab LIS
PDF probe is registered and ported. This is not a production live-write or 1:1
operational completion claim; that still needs the controlled pilot proof below.

## Diagram branch audit

This table maps readable labels in the [Rajal v1 diagram](../references/evomedis-helper-rajal-v1.png) to current decisions in `packages/domain-rajal/src/executors.ts` and `packages/domain-rajal/src/legacyConfig.ts`; it does not change the code/fixture-parity claim above. `rajal_v23.js` remains the legacy-behaviour authority. The same-day two-poli and unknown-penunjang decisions below follow the operator's explicit rules where the diagram alone cannot supply a predicate.

| Diagram label | Status | Node or reason | Test |
|---|---|---|---|
| Ada yang bisa dipayment / Tidak ada yang bisa di payment → SKIP | Executable | `check_payment` reads billed-row payment flags. Payable records take `check_payment__check_verification`; already-paid records skip it; unreadable payment state yields `needs_review` and is pruned. In a mixed batch, readable payable records continue while unreadable records do not get payment plans. | `skips an already-paid record`, `reports an unreadable payment state instead of assuming paid`, `preserves payment for a readable bill when another payment state is unreadable` (`packages/domain-rajal/src/domain-rajal.test.ts`). |
| Periksa 1 poli saja / Konsul ke poli lain | Executable | `validate_treatment` calls `evaluateRajalConsultVisit` using this patient's history: ≥2 distinct poli units on the same date is `consult`; one is `single_clinic`. Missing/unreadable date or unit goes to `needs_review` and its transaction is pruned. Classification is logged; it does not independently change a clean payment plan. | `classifies same-day poli visits and rejects unreadable evidence`, `detects consult only from the current patient history and still plans payment`, `does not infer a consult from another patient on the same date` (`packages/domain-rajal/src/domain-rajal.test.ts`). |
| Cek hasil penunjang: Radiologi / Lab PK / Lab PA / Penunjang Elektromedik / Lainnya | Executable for the four recognised categories; ditahan for unclassified penunjang | `validate_radiology`, `validate_lab`, `validate_lab_pa`, and `validate_elektromedik` handle the recognised categories. In `validate_treatment`, `isUnknownPenunjangTreatmentName` marks a penunjang-labelled row outside those classifiers `needs_review` and prunes its transaction; routine `PENDAFTARAN PASIEN` and `BIAYA OBAT` are not classified as unknown penunjang. No guessed “Lainnya” validator or payment plan is created. | `classifies penunjang treatments the way the legacy script did`, `holds unknown penunjang while leaving routine billed treatments alone`, `reviews an unknown penunjang treatment without staging payment` (`packages/domain-rajal/src/domain-rajal.test.ts`). |
| Match / Mismatch → Update SEP | Executable, approval-gated | `validate_sep` accepts a matching resolved SEP; mismatch returns `needs_review` with a `rekamMedis.simpanSep` `MutationPlan`. “Update SEP” is an approval-gated plan through the mutation gate, **not** an immediate write or a claim that preview corrected SIMRS. | `plans a SEP correction (never writes) when the transaction carries the wrong SEP` (`packages/domain-rajal/src/domain-rajal.test.ts`). |
| Cek Order Sebelum verifikasi → Ada / Tidak ada → Verifikasi → Tampung bayar | Executable | `check_verification` holds unserved/untransferred orders or unverified penunjang, and plans `verifikator.simpanVerifikasi` only when an open clean record needs it. An **unpaid but already-verified** record stays payable: the edge to `submit_payment` is taken and a `kasir.tampungBayar` plan remains. A hard blocker with no clean survivor blocks the edge; clean survivors in mixed batches continue. | `plans the verification write when the transaction is still open`, `still plans payment for a record that was already verified`, `keeps the clean payment plan when another payable record has an order blocker`, `reports an unreadable verification status instead of assuming verified` (`packages/domain-rajal/src/domain-rajal.test.ts`). |

## Operational live boundary

Live preview/read evidence exists, but live write parity is not yet proven. The
endpoints above are confirmed from the legacy call site and the crawled route
dumps, and every request shape is pinned by a test. If a live response shape
differs, the port fails safe: `getdatacarakeluar_tab` returning a non-record
makes `evaluateRajalExitDateResponse` report `needs_review`, and an unreadable
discovery report `blocked`s instead of pretending the period is empty. Approved
rajal writes are executable plans behind the mutation gate's preconditions and
read-after-write checks, but the full end-to-end claim still requires an
explicitly authorized one-patient live write pilot plus manual SIMRS
verification.

## Gap: poli without an SEP mapping

`RAJAL_CLINIC_MAPPING` (`packages/domain-rajal/src/legacyConfig.ts`) turns a
poli into the BPJS `poli_tujuan` its SEP carries. Units below appear in the
EvoMedis unit list (`getcmbunit?kd_instalasi=1`) but have no mapping because
no live SEP has shown their `poli_tujuan` yet. Until mapped, `validate_sep`
compares the raw unit name to the SEP poli, which normally fails →
`needs_review`, never a wrong correction. To close one: capture a HAR of
"SEP pendaftaran" for a patient of that poli, read `poli_tujuan` from
`get_datariwayatsep` / `getdata_sep_bpjs`, add the key, add a test.

| SIMRS unit (kd_unit) | kd_unit_bpjs | Status |
| --- | --- | --- |
| POLI JANTUNG ARITMIA (251) | 192 | **unmapped on purpose** — listed in `RAJAL_UNMAPPED_CLINIC_UNITS`, fails closed to `needs_review`, never inherits JANTUNG |
| POLI HEMOFILIA (245) | (blank) | **unmapped on purpose** — no BPJS code in SIMRS, fails closed to `needs_review` and never inherits a mapping |
| POLI BEDAH VASKULAR (261) | — | **unmapped on purpose** — no BPJS code in SIMRS, fails closed to `needs_review`, never inherits BEDAH |
| POLI GIGI PROSTODONSIA (258) | — | not a BPJS poli; seen in the unpaid report (Oct 2026) |
| POLI VIP (253) | — | not a BPJS poli; seen in the unpaid report |
| POLI UMUM, IMUNISASI, HOMECARE, PDP, INTERVENSI NYERI, RADIOLOGI INTERVENSI, BE SMILE CLINIC, KLINIK*, GOMBONG WELLNESS CENTER, ANESTESI | — | no BPJS code; out of SEP scope |

Mapped 2026-10-19 from live data: `GASTROENTEROHEPATOLOGI` →
`GASTROENTEROLOGI-HEPATOLOGI` (kd 005, seen on SEP `poli_tujuan`), and
`TB RO` → `PARU` (same kd_unit_bpjs `PAR` as POLI PARU).

The mapping lookup no longer takes the first substring hit in insertion order
(legacy behaviour): the longest matching key wins, so the report heading
"POLI JANTUNG ANAK" maps to ANAK KARDIOLOGI rather than ANAK. ARITMIA and
INTERVENSI both still contain JANTUNG, but only INTERVENSI is mapped: the three
units above are pinned in `RAJAL_UNMAPPED_CLINIC_UNITS` and skipped by the
substring fallback, so they keep raw-name candidates and cannot inherit a
neighbouring poli. The reason is not cosmetic — `sepPoliMatches` accepts
containment in both directions, so mapping ARITMIA to
`JANTUNG DAN PEMBULUH DARAH` would also make a plain JANTUNG SEP match the
ARITMIA visit, and `validate_sep` would plan a wrong high-risk
`rekamMedis.simpanSep` correction. To close one: capture a HAR of
"SEP pendaftaran" for a patient of that poli, read `poli_tujuan`, then add the
key, remove the unit from `RAJAL_UNMAPPED_CLINIC_UNITS`, and add a test.

## Deliberate deviations from the legacy

These are places where reproducing the userscript literally would be a defect.
Each is asserted by a test that says why.

- **`cek_order_belum_*` totals.** Legacy tests `if(o1?.total||o2?.total)`. The
  backend returns `total` as a string, and `"0"` is truthy in JavaScript, so
  legacy blocks every clean transaction whose total serialises as a string.
  `ranap_v3.py:3773` reads the same two endpoints as `int(total or 0) > 0`;
  the port follows the Python.
- **`cektransaksi_penunjang`.** The port keeps legacy's
  `Object.keys(response).length > 0` rule, which is both faithful and
  fail-closed. `ranap_v3.py:15023` is narrower — it blocks only on
  `nama_unit || no_transaksi || data || total` — so a reply carrying nothing but
  `{"total": 0}` blocks here and would not there. The outpatient script is the
  authority for the outpatient port.
- **The untransferred-penunjang unit keyword.** Legacy matches `"Penunjang"`
  case-*sensitively* (line 759), so an all-caps unit name slips through. The
  port matches case-insensitively, blocking a superset.
- **Unreadable inputs.** Legacy's optional chaining usually treats "could not
  read" as "nothing to worry about". The port fails closed for exit date,
  verification status, `getJumlahBayar`, visit history and treatment list: a
  validator that reports success because it could not read its input is worse
  than no validator. The oncology-plan check is the exception because the live
  route can be a non-JSON/404 page and legacy's `postFetch` would surface that
  as `null`; the port logs that at debug level and continues unless a readable
  plan text names chemo. Note the exit-date case is split: a discharge tab that
  *answered* but shows no `tgl_keluar` is a block (that is legacy's decision,
  and it is right), while a reply that is not a discharge record at all is
  `needs_review`.
- **The radiology result search.** Legacy line 917 posts to
  `radiologi/hasil_pemeriksaan/get_datapasien`, an action that controller does
  not expose. The port calls its real result search, `getdatakunjungan`, with
  the same `txtmedreccari_hslrad` legacy sent. Reproducing the legacy path
  literally would 404 and refuse every radiology record.
- **An unrendered report is unread, not empty.** Legacy's `getFetchHTML`
  returns `''` only when `fetch` itself throws; a 500 or a login redirect comes
  back as markup, `parseLaporanHTML` finds no rows, and `doFetch` reports
  `⚠️ 0 matched` — the same status line a genuinely quiet period gets. That is
  survivable for a status line and not for a run, which would proceed to
  "completed, nothing to pay". The port therefore treats a reply carrying no
  `table[border="1"]` as unreadable and `blocked`s. `RajalUnpaidReport.readable`
  is that signal; the empty-period fixture proves a rendered table with no data
  row still reads as empty.
- **A discovered batch is capped, and legacy's is not.** No legacy counterpart:
  `doFetch` wrote every matched medrec into the textarea. See "The guardrail"
  above for why the port refuses instead.
- **The run processes the unique medrec set.** Legacy keeps duplicates in the
  textarea and `startRun` iterates them, so a patient listed under two poli is
  put through `processPatient` twice and both times matched against the whole
  clinic list — the same records, judged twice. `normalize_ids` de-duplicates
  (it always has, for typed lists too) and one pass matches both clinics, so
  the patient is still processed for both poli, once.
- **Group-name case sensitivity is preserved.** Legacy's skip list matches
  case-insensitively while the group requirements match case-sensitively
  (lines 767 vs 776). That asymmetry is reproduced, with a test naming it, so
  nobody "fixes" it later.

## How to close a gap

1. Read the legacy block in full. Note every threshold, keyword list,
   tie-break and early `return` — a dropped keyword is a billing bug, not a
   style difference. Cross-check `ranap_v3.py` for any endpoint the two share.
2. Port the decision as a pure exported function in `legacyConfig.ts`, under
   the "Deterministic decisions" banner. Hoist every fetch into an explicit
   parameter and name the endpoint that supplies it. No network, no module
   state, no implicit clock.
3. Unit-test it against the legacy's behaviour, including the cases where the
   legacy is surprising.
4. Wire it in `executors.ts`: fetch, call, log, return a `StepResult`. A step
   that can write emits a plan; it does not call the endpoint.
5. If the endpoint is not registered, confirm the path *exists* before adding
   it — the crawled route dumps in `EvoMedis-Helper` (`endpoints_routes.txt`,
   `endpoints_index.txt`, `endpoints_routes_deep.txt`) list every reachable
   controller action, and the legacy script names at least one action that does
   not. Record the evidence here.
6. Add a request-shape assertion for any new read, citing the legacy line.
   `FixtureTransport` keys on the endpoint id and ignores parameters, so a
   passing fixture run proves nothing about the payload. Check `method` too: a
   GET's parameters must go in `options.query` or the client drops them.
7. Check the node's `critical` flag against the graph, not against intuition —
   see defect 14.
8. Delete the entry above.
