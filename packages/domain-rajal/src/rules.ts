/**
 * Rawat jalan rules data — the tables a run is configured by.
 *
 * Everything here is data, not decisions: clinic → BPJS poli mapping, the
 * treatment-group templates and skip list the operator edits on the Rules
 * page (`apps/orchestrator/src/rules.ts`), the cashier's payment options, the
 * report's instalasi codes and excluded sections, and the legacy userscript's
 * fixed keywords and thresholds. The verdict modules under `./logic/` and
 * `./unpaidReport.ts` read these; editing a table here changes what they
 * conclude without touching their code.
 */

export const RAJAL_CLINIC_MAPPING = {
  ANAK: 'ANAK',
  BEDAH: 'BEDAH',
  'BEDAH ANAK': 'BEDAH ANAK',
  'BEDAH DIGESTIVE': 'BEDAH DIGESTIF',
  'BEDAH ONKOLOGI': 'BEDAH ONKOLOGI',
  'BEDAH ORTOPEDI': 'ORTHOPEDI',
  'BEDAH SYARAF': 'BEDAH SARAF',
  DALAM: 'PENYAKIT DALAM',
  'DALAM, GINJAL DAN HIPERTENSI': 'GINJAL-HIPERTENSI',
  // Unit "POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI" (kd_unit_bpjs 005); SEP
  // poli_tujuan seen live as "GASTROENTEROLOGI-HEPATOLOGI ". Keyed without
  // "PENYAKIT DALAM" so a same-day PENYAKIT DALAM SEP can't substring-match it.
  GASTROENTEROHEPATOLOGI: 'GASTROENTEROLOGI-HEPATOLOGI',
  'POLI DALAM, GINJAL DAN HIPERTENSI': 'GINJAL-HIPERTENSI',
  GIGI: 'GIGI ENDODONSI',
  'GIGI ANAK PEDODONTIS': 'GIGI PEDODONTIS',
  'GIGI ENDODONSI': 'GIGI ENDODONSI',
  'GIGI ORTODONTIST': 'GIGI ORTODONTIST',
  'GIGI SPESIALIS BEDAH MULUT': 'GIGI BEDAH MULUT',
  HAEMODIALISA: 'HEMODIALISA',
  HEMODIALISA: 'HEMODIALISA',
  HAEMODIALISIS: 'HEMODIALISA',
  HEMODIALISIS: 'HEMODIALISA',
  'HEMATO-ONKOLOGI': 'HEMATOLOGI - ONKOLOGI MEDIK',
  'HEMATOLOGI ONKOLOGI ANAK': 'ANAK HEMATOLOGI ONKOLOGI',
  JANTUNG: 'JANTUNG DAN PEMBULUH DARAH',
  'JANTUNG ANAK': 'ANAK KARDIOLOGI',
  'JANTUNG INTERVENSI': 'Pelayanan vaskular',
  JIWA: 'JIWA',
  'KEBIDANAN DAN KANDUNGAN': 'OBGYN',
  KEMOTERAPI: 'SARANA KEMOTERAPI',
  'KULIT DAN KELAMIN': 'KULIT KELAMIN',
  MATA: 'MATA',
  'MEDICAL CHECK UP': 'MEDICAL CHECK UP',
  'ONKOLOGI GINEKOLOGI': 'ONKOLOGI GINEKOLOGI',
  PARU: 'PARU',
  PSIKOLOGI: 'JIWA',
  RADIOTERAPI: 'SARANA RADIOTERAPI',
  // Unit "TB RO" shares kd_unit_bpjs PAR with POLI PARU.
  'TB RO': 'PARU',
  'REHAB MEDIK': 'REHABILITASI MEDIK',
  SYARAF: 'SARAF',
  THT: 'THT-KL',
  'THT ONKOLOGI': 'ONKOLOGI KEPALA LEHER',
  UROLOGI: 'UROLOGI',
} as const;

/**
 * Clinics that must never borrow another poli's mapping. Each is a real EvoMedis
 * unit whose BPJS `poli_tujuan` is still unknown — POLI JANTUNG ARITMIA
 * (kd_unit 251), POLI HEMOFILIA (245), POLI BEDAH VASKULAR (261) — yet whose
 * name contains a mapped key (`JANTUNG`, `BEDAH`). The substring fallback in
 * {@link rajalClinicMappingKey} would map ARITMIA to `JANTUNG DAN PEMBULUH
 * DARAH` and BEDAH VASKULAR to `BEDAH`; a wrong poli also *matches* the wrong
 * same-day SEP (see {@link sepPoliMatches}), so `validate_sep` would plan a
 * high-risk `rekamMedis.simpanSep` correction. These units therefore fail
 * closed: raw-name candidates only, which normally yields `needs_review`.
 * Normalized with {@link normalizeClinicLabel}, so a trailing kd_unit
 * ("POLI JANTUNG ARITMIA (251)") becomes "JANTUNG ARITMIA 251" and is matched
 * by prefix.
 */
export const RAJAL_UNMAPPED_CLINIC_UNITS = ['JANTUNG ARITMIA', 'HEMOFILIA', 'BEDAH VASKULAR'] as const;

export const RAJAL_TREATMENT_TEMPLATES = [
  { id: 'obat', label: 'Pendaftaran + Obat', rows: ['A|registration|PENDAFTARAN PASIEN', 'B|obat|BIAYA OBAT'] },
  { id: 'hd', label: 'Pendaftaran + HD', rows: ['A|registration|PENDAFTARAN PASIEN', 'B|hd|HAEMODIALISA'] },
  { id: 'radio', label: 'Pendaftaran + Eksterna/Radio', rows: ['A|registration|PENDAFTARAN PASIEN', 'B|eksterna|EKSTERNA'] },
  {
    id: 'obat_or_hd',
    label: 'Pendaftaran + Obat OR HD',
    rows: ['A|registration|PENDAFTARAN PASIEN', 'B|obat|BIAYA OBAT', 'B|hd|HAEMODIALISA'],
  },
] as const;

export const RAJAL_DEFAULT_SKIP_TREATMENTS = ['ODC'] as const;

export const RAJAL_LEGACY_CHECKS = [
  { id: 'rencanaOnko', label: 'Rencana onko/kemo' },
  { id: 'sepCheckRequired', label: 'Cek SEP' },
  { id: 'verificationRequired', label: 'Verifikasi sebelum bayar' },
  { id: 'checkLab', label: 'Lab reguler' },
  { id: 'checkLabPA', label: 'Lab PA' },
  { id: 'checkRadiologi', label: 'Radiologi' },
  { id: 'checkElektromedik', label: 'Elektromedik' },
] as const;

/**
 * Penunjang (diagnostic-support) treatment classifiers.
 *
 * Legacy source lines 336-340. Each of the four penunjang guards only runs
 * when the billed tindakan rows actually contain a matching modality, so these
 * keyword lists decide whether a check applies to a record at all.
 */
export const RAJAL_RADIOLOGY_TREATMENT_EXACT: readonly string[] = ['usg'];
export const RAJAL_RADIOLOGY_TREATMENT_KEYWORDS: readonly string[] = ['ct scan', 'rontgen', 'mri'];
/**
 * The radiology administration charge the billing desk posts per study
 * (`BIAYA RADIOLOGI`, `BIAYA RADIOLOGI THORAX`). The legacy modality keywords
 * only recognise the study name, so this line fell through to
 * `isUnknownPenunjangTreatmentName` and the visit was dropped as unclassified —
 * the exact outcome the fallback exists to prevent for a charge we do know.
 * Anchored (`startsWith`) so a name that merely mentions radiology, such as a
 * non-radiology penunjang row, is not swept in.
 */
export const RAJAL_RADIOLOGY_BILLING_PREFIX = 'biaya radiologi';
export const RAJAL_ELEKTROMEDIK_TREATMENT_KEYWORDS: readonly string[] = ['penunjang elektromedik'];
export const RAJAL_LAB_PA_TREATMENT_KEYWORDS: readonly string[] = ['laboratorium pa'];
export const RAJAL_LAB_TREATMENT_KEYWORD = 'laboratorium';

/**
 * Legacy `validateLabResult` (source lines 552-696) markers. An LIS printout
 * containing one of these, or shorter than the minimum markup length, means the
 * lab order has not been resulted yet.
 */
export const RAJAL_LAB_EMPTY_RESULT_MARKERS: readonly string[] = [
  'data tidak ada',
  'tidak ada data',
  'no result',
  'not found',
  'no data',
  'belum ada hasil',
];
export const RAJAL_LAB_MIN_LIS_MARKUP_LENGTH = 50;
/** Legacy `checkLabPAResult`: a PA printout longer than this carries a result. */
export const RAJAL_LAB_PA_MIN_RESULT_LENGTH = 100;
/** Legacy "old LIS" link — its presence alone means a result exists. */
export const RAJAL_LEGACY_LIS_PDF_PATTERN = /cetak_hasil_pdf\.php\?no_lab=[^"'\s&<>]+/i;
/** Legacy `CONFIG.labEmptyPdfSize`: the known empty regular-lab PDF byte size. */
export const RAJAL_LAB_EMPTY_PDF_SIZE = 7407;

/** Legacy `isMatchingRecordPenunjang`: an untransferred penunjang visit unit. */
export const RAJAL_PENUNJANG_UNIT_KEYWORD = 'PENUNJANG';

/** Legacy `checkSep`: only same-day RJTL (outpatient referral) SEPs count. */
export const RAJAL_SEP_SERVICE_TYPE = 'RJTL';
/** Legacy `checkSep` retries the flaky BPJS bridge up to four times. */
export const RAJAL_SEP_HISTORY_ATTEMPTS = 4;

/**
 * Legacy `CONFIG.rencanaOnko` keyword (source line 888). An oncology plan whose
 * `isi_perencanaan` mentions chemotherapy means the visit is part of a chemo
 * course that must not be billed as an ordinary outpatient visit.
 */
export const RAJAL_ONCOLOGY_PLAN_KEYWORD = 'kemo';

/** One row of the operator's required-treatment table (source line 102). */
export interface RajalTreatmentGroup {
  /** Group letter. Same letter means OR; different letters mean AND. */
  group: string;
  /** Stable key the matched row is reported under. */
  key: string;
  /** Substring the tindakan name must contain — matched case-sensitively. */
  name: string;
}

/** Legacy `paymentConfig` (source line 107) — shift, tender type, payer. */
export interface RajalPaymentConfig {
  shift: string;
  type: string;
  payerCode: string;
}

export const RAJAL_DEFAULT_PAYMENT_CONFIG: RajalPaymentConfig = {
  shift: '1',
  type: '14',
  payerCode: '15',
};

/** Legacy `PAYMENT_TYPE_MAPPING` (source line 61) — labels shown, codes stored. */
export const RAJAL_PAYMENT_TYPE_OPTIONS = [
  { label: 'TUNAI', code: '1' },
  { label: 'PIUTANG', code: '2' },
  { label: 'SETOR BSI', code: '3' },
  { label: 'EDC BRI', code: '4' },
  { label: 'EDC BNI', code: '5' },
  { label: 'EDC MANDIRI', code: '6' },
  { label: 'TRANSFER BSI', code: '7' },
  { label: 'TRANSFER BRI', code: '9' },
  { label: 'TRANSFER BNI', code: '10' },
  { label: 'QRIS', code: '11' },
  { label: 'TRANSFER MANDIRI', code: '12' },
  { label: 'Keuangan', code: '13' },
  { label: 'PIUTANG BPJS', code: '14' },
  { label: 'PIUTANG UMUM', code: '15' },
  { label: 'EDC BSI', code: '17' },
] as const;

/** Legacy `SHIFT_MAPPING` (source line 71) — labels shown, codes stored. */
export const RAJAL_SHIFT_OPTIONS = [
  { label: 'Shift 1', code: '1' },
  { label: 'Shift 2', code: '2' },
  { label: 'Shift 3', code: '3' },
] as const;

/** Legacy `INSTALASI_OPTIONS` (source lines 85-88) — the `cmbinstalasi` codes. */
export const RAJAL_INSTALASI_OPTIONS = [
  { code: '1', label: 'Rawat Jalan' },
  { code: '14', label: 'Penunjang' },
  { code: '2', label: 'Rawat Inap' },
  { code: '3', label: 'IGD' },
] as const;

/**
 * Legacy `AUTO_EXCLUDE_SECTIONS` (source lines 91-94). A report section whose
 * name contains one of these is a penunjang/pharmacy grouping, not a clinic —
 * it must never become a clinic chip, and its patients must not be auto-mapped
 * to one.
 */
export const RAJAL_AUTO_EXCLUDE_SECTIONS: readonly string[] = [
  'LABORATORIUM KLINIK',
  'RADIOLOGI',
  'PENUNJANG LAIN',
  'DEPO FARMASI',
  'DEPO KEMOTERAPI',
];

/** Guarantors a rajal run accepts when the operator names none (substring, case-insensitive). */
export const RAJAL_DEFAULT_ACCEPTED_PENJAMIN: readonly string[] = ['BPJS PBI', 'BPJS NON PBI'];
