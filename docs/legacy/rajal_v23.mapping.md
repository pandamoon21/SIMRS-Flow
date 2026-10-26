# Rawat Jalan Legacy v27.2 Mapping

Source file: `EvoMedis-Helper/rajal_v23.js`
Userscript: `PKU-Gombong Patient Processor (v27.2 Production)` — 1643 lines.

This file maps legacy symbols to their port. For *what is and is not
reproduced*, read [`rajal-parity.md`](rajal-parity.md) — that is the honest
ledger; this one is the index.

## Constants

| Legacy symbol (line) | Port |
|---|---|
| `CLINIC_MAPPING` (36) | `RAJAL_CLINIC_MAPPING` in `legacyConfig.ts` |
| `PAYMENT_TYPE_MAPPING` (61) | `RAJAL_PAYMENT_TYPE_OPTIONS` + `rajalPaymentTypeCode` |
| `SHIFT_MAPPING` (71) | `RAJAL_SHIFT_OPTIONS` + `rajalShiftCode` |
| `INSTALASI_OPTIONS` (86) | `RAJAL_INSTALASI_OPTIONS` |
| `AUTO_EXCLUDE_SECTIONS` (91) | `RAJAL_AUTO_EXCLUDE_SECTIONS` |
| default `treatmentGroups` (102) | `RAJAL_TREATMENT_TEMPLATES` |
| `skipTreatments` (106) | `RAJAL_DEFAULT_SKIP_TREATMENTS` |
| `paymentConfig` (107) | `RAJAL_DEFAULT_PAYMENT_CONFIG` |
| check toggles (108-113) | `RAJAL_LEGACY_CHECKS`; the UI maps them to node-enable flags |
| `labEmptyPdfSize` (116) | not ported — the LIS PDF probe is not expressible (see parity §4) |

## Pure functions

| Legacy function (line) | Port (`legacyConfig.ts`) |
|---|---|
| `formatDateToDDMonYYYY` (244) | `formatRajalLegacyDate` |
| `normalizeSepPoliName` (250) | `normalizeSepPoliName` |
| `getMappedPoliTujuan` (259) | `mapRajalClinicToSepPoli` |
| `getMappedPoliCandidates` (266) | `rajalClinicCandidates` |
| `normalizeClinicLabel` (283) | `normalizeClinicLabel` |
| `resolveClinicMatch` (293) | `resolveRajalClinicMatch` |
| `isRadiologyTreatmentName` (337) | `isRadiologyTreatmentName` |
| `isElektromedikTreatmentName` (338) | `isElektromedikTreatmentName` |
| `isLabPATreatmentName` (339) | `isLabPaTreatmentName` |
| `isRegularLabTreatmentName` (340) | `isRegularLabTreatmentName` |
| `verifyTreatmentGroups` (762) | `verifyRajalTreatmentGroups` |
| `poliMatches` (817) | `sepPoliMatches` |
| onko keyword test (888) | `evaluateRajalOncologyPlan` |
| exit-date test (892) | `evaluateRajalExitDate` |
| order-blocker test (1009) | `evaluateRajalOrderBlocker` |
| penunjang-blocker test (1011) | `evaluateRajalPenunjangBlocker` |
| `tampung_bayar` body (1021) | `buildRajalTampungBayarPayload` |
| `formatPatientId` (703) | `formatPatientId` in `executors.ts` |

Every function above is unit-tested in `domain-rajal.test.ts` under
`rajal legacy decisions`, with the legacy line cited in the test name.

## Pipeline

| Legacy (line) | Port node |
|---|---|
| `startRun` (1585) | run creation — batch input, not a node |
| `processPatient` (1036) | `start_batch` → `load_history` → `filter_records` |
| `isMatchingRecordPenunjang` (757) | inside `filter_records` |
| `findMatchingRecords` (728) | `filter_records` |
| `processRecord` (875) | `check_rencana_onko` … `submit_payment` |
| `getCardNumber` (784) + `checkSep` (797) | `validate_sep` |
| `updateSep` (866) | `validate_sep` → `rekamMedis.simpanSep` plan |
| verification block (1004) | `check_verification` (+ `verifikator.simpanVerifikasi` plan) |
| `tampung_bayar` (1021) | `submit_payment` → `kasir.tampungBayar` plan |
| `parseLaporanHTML` (514) | `parseRajalUnpaidReport` |
| `doFetch` (1451) | `fetchRajalUnpaidBatch` + `selectRajalUnpaidBatch`, run from `normalize_ids` when `RajalInput.discovery` is set |
| `extractClinicFromSection` (333) / `shouldExcludeSection` (334) | `extractRajalClinicFromSection` / `shouldExcludeRajalSection` |
| `mergeAutoClinicPatients` (361) | `RajalUnpaidBatch.clinicsByPatientId` |
| `removePatientIdsForClinic` (373) | the narrowing prune in `resolve_clinics` |
| `validateLabResult` (552) | partially — `validate_lab` (see parity §4) |
| `checkLabPAResult` (711) | `validate_lab_pa` |

## Behavioural notes

- Required treatments are grouped: same group letter means OR, different group
  letters mean AND. The skip list matches case-insensitively, the group names
  case-sensitively — that asymmetry is the legacy's and is preserved.
- `resolveClinicMatch` scores in five tiers and demands a unique winner; two
  clinics tied on both score and normalized length make the record *ambiguous*,
  and legacy skips it rather than guess.
- SEP mapping uses normalized candidates from the selected clinic's aliases,
  with a same-day sibling-clinic fallback that only fires when exactly one
  sibling SEP exists. The sibling set comes from the *matching* records, not the
  raw visit history.
- The React app intentionally does not persist patient IDs even though the
  userscript used `pku_ids_v23`, and it has no equivalent of the clinic→patient
  auto-map (`pku_auto_clinic_patient_map_v23`).
- `radiologi/hasil_pemeriksaan/get_datapasien` is absent from the client
  registry because the controller exposes `radiologi.getDataKunjungan` for the
  same search. The external LIS PDF host is outside the registry. See
  [`rajal-parity.md`](rajal-parity.md).
