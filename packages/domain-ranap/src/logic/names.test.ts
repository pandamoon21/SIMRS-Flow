/**
 * Contract tests for the `ranap_v3.py` name classifiers.
 *
 * Two jobs:
 *  1. Every predicate gets at least one real charge/unit/person name that must
 *     be accepted and at least one *near miss* that must be rejected — the
 *     near misses are the interesting half, because they pin the difference
 *     between `in`, `startswith` and `==` that the Python encodes.
 *  2. Every exported keyword list is pinned verbatim, so an edit that drops or
 *     re-spells a keyword fails here instead of mis-billing a patient.
 *
 * Names are taken from the Python's own keyword lists and surrounding
 * comments; none of them are invented spellings.
 */

import { describe, expect, it } from 'vitest';

import {
  BYNY_HEALTHY_DIAGNOSIS_TOKENS,
  BYNY_SICK_DIAGNOSIS_TOKENS,
  CARE_CLASS_BY_KD,
  CARE_CLASS_RANK,
  CRITICAL_CARE_ROOM_CLASSES,
  DEFAULT_ACCEPTED_PENJAMIN_KEYWORDS,
  EXCLUDED_TAMPUNG_BAYAR_TOKENS,
  IGD_DOCTOR_PREFIXES,
  IGD_HEMODIALYSIS_TOKENS,
  IGD_JASA_CONTEXT_TOKENS,
  IGD_ORIGIN_CHARGE_PREFIXES,
  JASA_CATEGORY_CLASS_BY_NAME,
  MANUAL_FOLLOWUP_TRANSAKSI_PREFIXES,
  MANUAL_FOLLOWUP_UNIT_TOKENS,
  PARTUS_DOCTOR_ACTION_PREFIXES,
  PREMIUM_ROOM_PAYMENT_GUARD_CLASSES,
  PROTECTED_NON_DELETABLE_CHARGE_NAMES,
  ROOM_CHARGE_BLOCKED_TOKENS,
  ROOM_ROLE_PREFIXES,
  TAKE_HOME_MED_BLOCKED_TOKENS,
  TAKE_HOME_MED_INCLUDE_TOKENS,
  UNPAID_KUNJUNGAN_STATUS_KEYS,
  doctorNameMatchesRelaxed,
  extractIgdLevel,
  extractJasaCategoryClass,
  extractRoomSegments,
  getOverlapRoomPriorityRank,
  isAcceptedPenjamin,
  isAnesthesiologistName,
  isBiayaAdministrasiName,
  isBiayaDiitGiziName,
  isBiayaIbsName,
  isBpjsPenjamin,
  isBynyPatient,
  isDanglingOkHistoryRow,
  isDepoIbsName,
  isDpjbName,
  isExcludedTampungBayarUnit,
  isIcuRoomName,
  isIgdDoctorName,
  isIgdHemodialysisName,
  isIgdJasaPelayananName,
  isIgdOriginChargeName,
  isJasaName,
  isKonsultasiTeleponName,
  isMultazamPlatinumRoomName,
  isOksigenBhpName,
  isPartusDoctorActionName,
  isPremiumRoomForPaymentGuard,
  isPriorityOverlapRoomName,
  isProtectedNonDeletableCharge,
  isRoomChargeName,
  isSelfcheckinGeneratedRow,
  isTransferredRow,
  isUnpaidKunjunganStatus,
  isVisiteDrAnakScnName,
  isVisiteSpesialisName,
  looksLikeBynyParentSep,
  looksLikeBynySickDiagnosis,
  looksLikeManualFollowupTransaction,
  isIgdSourceCandidate,
  looksLikePediatricianName,
  looksLikeTakeHomeMedName,
  normalizeParamedisDisplay,
  normalizePenjaminFilters,
  normalizePenjaminSummaryLabel,
  normalizeRoomPelaksana,
  resolveExistingJasaCategoryClass,
  roomLabelMatchesSegment,
  stripRoomRolePrefix,
} from './names.js';
import type { LegacyRow } from './types.js';

/** `[input, expected]` — one row per accepted name or near miss. */
type PredicateCase = readonly [input: unknown, expected: boolean];

function describePredicate(
  name: string,
  predicate: (value: unknown) => boolean,
  cases: readonly PredicateCase[],
): void {
  describe(name, () => {
    for (const [input, expected] of cases) {
      it(`${expected ? 'accepts' : 'rejects'} ${JSON.stringify(input)}`, () => {
        expect(predicate(input)).toBe(expected);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Charge names
// ---------------------------------------------------------------------------

describePredicate('isRoomChargeName', isRoomChargeName, [
  ['BIAYA KAMAR MULTAZAM PLATINUM', true],
  ['SEWA KAMAR KELAS 2', true],
  ['AKOMODASI RUANG ARAFAH', true],
  ['BIAYA PERAWATAN MULTAZAM', true],
  // The explicit room hit wins before the blocked-token sweep can veto "IGD".
  ['BIAYA KAMAR IGD', true],
  ['BIAYA LABORATORIUM', false],
  ['BIAYA DIIT GIZI', false],
  ['BIAYA BEDAH SENTRAL', false],
  ['AKOMODASI AMBULANCE', false],
  ['JASA PELAYANAN KAT 1', false],
  ['', false],
]);

describePredicate('isJasaName', isJasaName, [
  ['JASA PELAYANAN KAT 3', true],
  ['jasa pelayanan perawat igd', true],
  // Raw uppercase compare, not a normalised key: the doubled space misses.
  ['JASA  PELAYANAN KAT 3', false],
  ['JASA MEDIS DOKTER', false],
  [null, false],
]);

describe('extractJasaCategoryClass', () => {
  const cases: readonly (readonly [unknown, string])[] = [
    ['JASA PELAYANAN KAT 1', 'KELAS 1'],
    ['JASA PELAYANAN KAT 2', 'KELAS 2'],
    ['  jasa   pelayanan   kat 3 ', 'KELAS 3'],
    ['JASA PELAYANAN KAT 4', ''],
    ['JASA PELAYANAN PERAWAT IGD', ''],
    [null, ''],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      expect(extractJasaCategoryClass(input)).toBe(expected);
    });
  }
});

describePredicate('isIgdOriginChargeName', isIgdOriginChargeName, [
  ['BIAYA UGD P 2', true],
  ['Biaya IGD Kebidanan', true],
  // Only "BIAYA UGD" and "BIAYA IGD KEBIDANAN" are prefixes — plain IGD is not.
  ['BIAYA IGD', false],
  ['TINDAKAN BIAYA UGD', false],
  ['BIAYA POLIKLINIK', false],
]);

describePredicate('isIgdHemodialysisName', isIgdHemodialysisName, [
  ['BIAYA HEMODIALISA', true],
  ['BIAYA HAEMODIALISIS', true],
  ['HEMODIALISA CITO', true],
  ['BIAYA DIALISIS', false],
  ['BIAYA HEMODIALISA'.replace('BIAYA ', ''), false],
]);

describePredicate('isIgdDoctorName', isIgdDoctorName, [
  ['DOKTER IGD P 2', true],
  ['dokter ugd', true],
  ['DOKTER SPESIALIS IGD', false],
  ['PERAWAT IGD', false],
]);

describePredicate('isIgdJasaPelayananName', isIgdJasaPelayananName, [
  ['JASA PELAYANAN PERAWAT IGD', true],
  // The legacy misspelling "PELAWATAN" is a first-class spelling here.
  ['JASA PELAWATAN BIDAN UGD', true],
  // No IGD context, but a triage level is enough.
  ['JASA PELAYANAN P 2', true],
  ['JASA PELAYANAN KAT 3', false],
  ['PERAWAT IGD', false],
  ['', false],
]);

describe('extractIgdLevel', () => {
  const cases: readonly (readonly [unknown, string])[] = [
    ['DOKTER IGD P1', '1'],
    ['BIAYA UGD P 3', '3'],
    ['JASA PELAYANAN PERAWAT IGD P 2', '2'],
    ['BIAYA UGD P4', ''],
    ['BIAYA UGD PAKET 2', ''],
    ['JASA PELAYANAN KAT 3', ''],
  ];
  for (const [input, expected] of cases) {
    it(`reads level ${JSON.stringify(expected)} from ${JSON.stringify(input)}`, () => {
      expect(extractIgdLevel(input)).toBe(expected);
    });
  }
});

describePredicate('isProtectedNonDeletableCharge', isProtectedNonDeletableCharge, [
  ['OKSIGEN CENTRAL / JAM', true],
  ['BIAYA UGD P 2', true],
  ['BIAYA LABORATORIUM PA', true],
  ['BIAYA PENUNJANG ELEKTROMEDIK', true],
  ['BIAYA HAEMODIALISA', true],
  ['BIAYA KAMAR MULTAZAM', false],
  ['BIAYA DIIT GIZI', false],
  ['ADMINISTRASI', false],
]);

describePredicate('isBiayaDiitGiziName', isBiayaDiitGiziName, [
  ['BIAYA DIIT GIZI KELAS 2', true],
  ['biaya diit gizi', true],
  ['BIAYA GIZI', false],
  ['BIAYA DIIT', false],
]);

describePredicate('isDpjbName', isDpjbName, [
  ['VISITE DOKTER DPJP', true],
  ['DOKTER DPJB', true],
  // Needs both halves: "DOKTER" and one of DPJB/DPJP.
  ['DPJP', false],
  ['DOKTER SPESIALIS', false],
]);

describePredicate('isOksigenBhpName', isOksigenBhpName, [
  ['OKSIGEN CENTRAL / JAM', true],
  ['biaya oksigen', true],
  ['O2 CENTRAL', false],
  ['OKSIMETRI', false],
]);

describePredicate('isBiayaAdministrasiName', isBiayaAdministrasiName, [
  ['ADMINISTRASI', true],
  ['  administrasi  ', true],
  // Exact equality on the normalised key, not a substring test.
  ['BIAYA ADMINISTRASI', false],
  ['ADMINISTRASI RAWAT INAP', false],
]);

describePredicate('isVisiteSpesialisName', isVisiteSpesialisName, [
  ['VISITE DOKTER SPESIALIS', true],
  ['visite dokter spesialis anak', true],
  ['VISITE DOKTER UMUM', false],
  ['VISITE DR ANAK SCN', false],
]);

describePredicate('isVisiteDrAnakScnName', isVisiteDrAnakScnName, [
  ['VISITE DR ANAK SCN', true],
  ['visite dr anak scn 2', true],
  // Raw uppercase compare: the dot in "DR." breaks the literal.
  ['VISITE DR. ANAK SCN', false],
  ['VISITE DOKTER SPESIALIS ANAK', false],
]);

describePredicate('isKonsultasiTeleponName', isKonsultasiTeleponName, [
  ['KONSULTASI DOKTER SPESIALIS LEWAT TELEPON', true],
  ['konsultasi dokter spesialis lewat telepon (on call)', true],
  ['KONSULTASI DOKTER SPESIALIS', false],
  ['KONSULTASI LEWAT TELEPON', false],
]);

describePredicate('isPartusDoctorActionName', isPartusDoctorActionName, [
  ['PARTUS NORMAL', true],
  ['TINDAKAN PARTUS DENGAN PENYULIT', true],
  ['  partus   spontan ', true],
  ['JASA PARTUS NORMAL', false],
  ['PARTUS'.replace('PARTUS', 'PERINEOTOMI'), false],
]);

describePredicate('isBiayaIbsName', isBiayaIbsName, [
  ['BIAYA BEDAH SENTRAL', true],
  ['BIAYA IBS', true],
  ['BIAYA CATHLAB', true],
  // Has "IBS" but no "BIAYA" — this is the depot line, not the suite charge.
  ['DEPO IBS', false],
  ['BIAYA KAMAR MULTAZAM', false],
]);

describePredicate('isDepoIbsName', isDepoIbsName, [
  ['DEPO IBS', true],
  ['depo ibs obat', true],
  ['DEPO FARMASI', false],
  ['BIAYA IBS', false],
]);

describePredicate('looksLikeTakeHomeMedName', looksLikeTakeHomeMedName, [
  ['PARACETAMOL 500MG TAB', true],
  ['AMOXICILLIN SYRUP', true],
  ['DOMPERIDON SUSP', true],
  ['GENTAMYCIN SALEP MATA', true],
  // Blocked tokens win over the dosage form.
  ['PARACETAMOL 1000MG/100ML INFUS', false],
  ['ASAM TRANEKSAMAT 500MG INJ', false],
  ['GENTAMYCIN INJ', false],
  ['VOLULYTE 500ML', false],
  ['SPUIT 3CC', false],
  ['', false],
]);

// ---------------------------------------------------------------------------
// Unit / room names
// ---------------------------------------------------------------------------

describePredicate('isIcuRoomName', isIcuRoomName, [
  ['RUANG ICU', true],
  ['icu dewasa', true],
  ['RUANG HCU', false],
  ['MULTAZAM PLATINUM', false],
]);

describe('getOverlapRoomPriorityRank', () => {
  const cases: readonly (readonly [unknown, number])[] = [
    ['RUANG ICU', 3],
    ['NICU', 3],
    ['SCN', 3],
    ['ICCU', 3],
    ['ISOLASI COVID', 2],
    ['ISO 1', 2],
    ['MULTAZAM PLATINUM', 0],
    ['ARAFAH KELAS 3', 0],
    ['', 0],
  ];
  for (const [input, expected] of cases) {
    it(`ranks ${JSON.stringify(input)} as ${expected}`, () => {
      expect(getOverlapRoomPriorityRank(input)).toBe(expected);
    });
  }
});

describePredicate('isPriorityOverlapRoomName', isPriorityOverlapRoomName, [
  ['NICU', true],
  ['ISOLASI COVID', true],
  ['ARAFAH KELAS 3', false],
  ['MULTAZAM PLATINUM', false],
]);

describePredicate('isMultazamPlatinumRoomName', isMultazamPlatinumRoomName, [
  ['MULTAZAM PLATINUM 1', true],
  ['multazam-platinum', true],
  ['MULTAZAM GOLD', false],
  ['PLATINUM', false],
]);

describe('isPremiumRoomForPaymentGuard', () => {
  const cases: readonly (readonly [string, unknown, LegacyRow | undefined, boolean])[] = [
    ['multazam platinum by name', 'MULTAZAM PLATINUM 2', undefined, true],
    ['VIP room by name', 'VIP ARAFAH', undefined, true],
    ['VVIP via kd_kelasperawatan', '', { kd_kelasperawatan: '9' }, true],
    ['kelas 3 ward', 'ARAFAH KELAS 3', undefined, false],
    ['empty row falls back to the unit name', 'ARAFAH KELAS 3', {}, false],
    ['ICU is critical care, not premium', 'RUANG ICU', undefined, false],
  ];
  for (const [label, unit, row, expected] of cases) {
    it(`${expected ? 'guards' : 'allows'} ${label}`, () => {
      expect(isPremiumRoomForPaymentGuard(unit, row)).toBe(expected);
    });
  }
});

describePredicate('isExcludedTampungBayarUnit', isExcludedTampungBayarUnit, [
  ['AMBULANCE', true],
  ['INSTALASI KAMAR JENAZAH', true],
  ['INSTALASI JENAZAH', true],
  ['INSTALASI FARMASI', false],
  ['KAMAR OPERASI', false],
  ['', false],
]);

describe('extractRoomSegments', () => {
  const cases: readonly (readonly [unknown, readonly string[]])[] = [
    ['MULTAZAM/ISO-1', ['MULTAZAM', 'ISO', 'ISOLASI', '1']],
    // "KELAS …" segments are dropped outright.
    ['KELAS 3 / ARAFAH', ['ARAFAH']],
    ['ARAFAH,ARAFAH', ['ARAFAH']],
    ['', []],
  ];
  for (const [input, expected] of cases) {
    it(`splits ${JSON.stringify(input)}`, () => {
      expect(extractRoomSegments(input)).toEqual(expected);
    });
  }
});

describe('normalizeRoomPelaksana', () => {
  const cases: readonly (readonly [unknown, string])[] = [
    ['MULTAZAM/ISO-1', 'MULTAZAM'],
    ['KELAS 3 / ARAFAH', 'ARAFAH'],
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    it(`resolves ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      expect(normalizeRoomPelaksana(input)).toBe(expected);
    });
  }
});

describe('stripRoomRolePrefix', () => {
  const cases: readonly (readonly [unknown, string])[] = [
    ['Perawat Multazam', 'MULTAZAM'],
    ['Bidan Bersalin', 'BERSALIN'],
    ['Ruang Arafah', 'ARAFAH'],
    ['MULTAZAM', 'MULTAZAM'],
    // "PERAWATAN" is not the "PERAWAT " prefix.
    ['Perawatan Multazam', 'PERAWATAN MULTAZAM'],
  ];
  for (const [input, expected] of cases) {
    it(`strips ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      expect(stripRoomRolePrefix(input)).toBe(expected);
    });
  }
});

describe('roomLabelMatchesSegment', () => {
  const cases: readonly (readonly [unknown, string, boolean])[] = [
    ['Perawat Multazam', 'MULTAZAM', true],
    ['Ruang Arafah', 'ARAFAH', true],
    // Off-by-one prefix drift in master data still matches.
    ['Bidan Bersalin', 'BERSALINA', true],
    ['Perawat Arafah', 'MULTAZAM', false],
    ['Perawat Iso', 'ISOLASI', false],
    ['', 'MULTAZAM', false],
  ];
  for (const [label, segment, expected] of cases) {
    it(`${expected ? 'matches' : 'rejects'} ${JSON.stringify(label)} vs ${segment}`, () => {
      expect(roomLabelMatchesSegment(label, segment)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Person names
// ---------------------------------------------------------------------------

describe('normalizeParamedisDisplay', () => {
  const cases: readonly (readonly [unknown, string])[] = [
    ['dr. Budi Santoso, Sp.PD', 'DR BUDI SANTOSO SP PD'],
    ['  Perawat  Multazam ', 'PERAWAT MULTAZAM'],
    [null, ''],
  ];
  for (const [input, expected] of cases) {
    it(`normalises ${JSON.stringify(input)}`, () => {
      expect(normalizeParamedisDisplay(input)).toBe(expected);
    });
  }
});

describePredicate('isAnesthesiologistName', isAnesthesiologistName, [
  ['dr. Andi, Sp.An', true],
  ['dr. Andi, Sp. An, M.Kes', true],
  ['dr. Andi, SpAN', true],
  // Paediatrician, not anaesthetist.
  ['dr. Rina, Sp.A', false],
  ['dr. Yudi, Sp.OG', false],
  ['dr. Anwar', false],
]);

describePredicate('looksLikePediatricianName', looksLikePediatricianName, [
  ['dr. Rina, Sp.A', true],
  ['dr. Rina, Sp. A', true],
  ['dr. Andi, Sp.An', false],
  ['dr. Yudi, Sp.OG', false],
  ['', false],
]);

describe('doctorNameMatchesRelaxed', () => {
  const cases: readonly (readonly [unknown, unknown, boolean])[] = [
    ['dr. Budi Santoso, Sp.PD', 'dr. Budi Santoso Sp PD', true],
    // >= 10 compact characters contained in the other spelling.
    ['dr. Budi Santoso, Sp.PD', 'BUDI SANTOSO', true],
    // Two shared >= 3-character tokens.
    ['Budi Santoso Wijaya', 'Santoso Wijaya Putra', true],
    ['dr. Budi', 'dr. Andi', false],
    ['dr. Budi Santoso', 'dr. Andi Wijaya', false],
    ['', 'dr. Budi Santoso', false],
  ];
  for (const [left, right, expected] of cases) {
    it(`${expected ? 'matches' : 'rejects'} ${JSON.stringify(left)} vs ${JSON.stringify(right)}`, () => {
      expect(doctorNameMatchesRelaxed(left, right)).toBe(expected);
    });
  }
});

describe('isSelfcheckinGeneratedRow', () => {
  const cases: readonly (readonly [LegacyRow, boolean])[] = [
    [{ nama_user: 'SELFCHECKIN' }, true],
    [{ nama_user: 'self-checkin' }, true],
    [{ user: 'SELF CHECKIN 01' }, true],
    [{ nama_user: 'naufal a' }, false],
    [{}, false],
  ];
  for (const [row, expected] of cases) {
    it(`${expected ? 'flags' : 'passes'} ${JSON.stringify(row)}`, () => {
      expect(isSelfcheckinGeneratedRow(row)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Newborn (BYNY), penjamin and visit status
// ---------------------------------------------------------------------------

describePredicate('isBynyPatient', isBynyPatient, [
  ['By. Ny. PASIEN DUA', true],
  ['BYNY SITI', true],
  ['BAYI NY SITI', false],
  ['PASIEN DUA', false],
]);

describePredicate('isBpjsPenjamin', isBpjsPenjamin, [
  ['BPJS NON PBI', true],
  ['bpjs pbi', true],
  ['UMUM', false],
  ['JAMKESDA', false],
]);

describePredicate('looksLikeBynyParentSep', looksLikeBynyParentSep, [
  ['', true],
  ['   ', true],
  ['0000000000000', true],
  ['BAYI SEHAT', true],
  ['0001R0110325V000123', false],
  ['0002R0010325V009876', false],
]);

describePredicate('looksLikeBynySickDiagnosis', looksLikeBynySickDiagnosis, [
  ['ASFIKSIA NEONATORUM', true],
  ['HIPERBILIRUBINEMIA', true],
  ['FEEDING PROBLEM', true],
  ['BBLR', true],
  // Exact healthy-newborn diagnoses.
  ['BAYI SEHAT', false],
  ['NEONATUS ATERM', false],
  ['RAWAT GABUNG', false],
  ['BAYI BARU LAHIR SEHAT SPONTAN', false],
  ['', false],
]);

describePredicate('isUnpaidKunjunganStatus', isUnpaidKunjunganStatus, [
  ['', true],
  ['BELUM', true],
  ['Belum Bayar', true],
  ['OPEN', true],
  ['LUNAS', false],
  ['SUDAH BAYAR', false],
]);

describe('normalizePenjaminFilters', () => {
  it('falls back to the default keywords when none are given', () => {
    expect(normalizePenjaminFilters()).toEqual(['BPJS PBI', 'BPJS NON PBI']);
  });

  it('falls back to the default keywords for null', () => {
    expect(normalizePenjaminFilters(null)).toEqual(['BPJS PBI', 'BPJS NON PBI']);
  });

  it('normalises and drops blanks', () => {
    expect(normalizePenjaminFilters([' bpjs-pbi ', '', '   '])).toEqual(['BPJS PBI']);
  });

  it('keeps an explicitly empty list empty', () => {
    expect(normalizePenjaminFilters([])).toEqual([]);
  });
});

describe('isAcceptedPenjamin', () => {
  const cases: readonly (readonly [unknown, readonly string[] | null | undefined, boolean])[] = [
    ['BPJS NON PBI', undefined, true],
    ['BPJS PBI', undefined, true],
    ['UMUM', undefined, false],
    ['JAMKESDA', undefined, false],
    // An empty filter list accepts everything.
    ['UMUM', [], true],
    ['JAMKESDA KEBUMEN', ['jamkesda'], true],
  ];
  for (const [penjamin, keywords, expected] of cases) {
    it(`${expected ? 'accepts' : 'rejects'} ${JSON.stringify(penjamin)} with ${JSON.stringify(keywords)}`, () => {
      expect(isAcceptedPenjamin(penjamin, keywords)).toBe(expected);
    });
  }
});

describe('normalizePenjaminSummaryLabel', () => {
  const cases: readonly (readonly [unknown, string])[] = [
    ['BPJS NON PBI', 'NON PBI'],
    ['BPJS PBI', 'PBI'],
    ['UMUM', 'UMUM'],
    ['', '-'],
    [null, '-'],
  ];
  for (const [input, expected] of cases) {
    it(`labels ${JSON.stringify(input)} as ${JSON.stringify(expected)}`, () => {
      expect(normalizePenjaminSummaryLabel(input)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Row-shaped classifiers
// ---------------------------------------------------------------------------

describe('isTransferredRow', () => {
  const cases: readonly (readonly [LegacyRow, boolean])[] = [
    [{ flag: 'Transfer' }, true],
    [{ status_kirim: '1' }, true],
    [{ status_kirim: 1 }, true],
    [{ flag: 'posting', status_kirim: '0' }, false],
    [{}, false],
  ];
  for (const [row, expected] of cases) {
    it(`${expected ? 'flags' : 'passes'} ${JSON.stringify(row)}`, () => {
      expect(isTransferredRow(row)).toBe(expected);
    });
  }
});

describe('isDanglingOkHistoryRow', () => {
  const cases: readonly (readonly [LegacyRow, boolean])[] = [
    [{ no_order: 'OK-0001' }, true],
    [{ no_order: 'OK-0001', no_transaksi: '' }, true],
    [{ no_order: 'OK-0001', no_transaksi: '51-000123' }, false],
    [{ no_transaksi: '51-000123' }, false],
    [{}, false],
  ];
  for (const [row, expected] of cases) {
    it(`${expected ? 'flags' : 'passes'} ${JSON.stringify(row)}`, () => {
      expect(isDanglingOkHistoryRow(row)).toBe(expected);
    });
  }
});

describe('isIgdSourceCandidate', () => {
  it('takes the IGD bill and never the DEPO IGD drug order on the same registration', () => {
    expect(isIgdSourceCandidate({ nama_unit: 'Rawat Darurat (IGD)', no_transaksi: '02-201026-3722' })).toBe(true);
    expect(isIgdSourceCandidate({ nama_unit: 'DEPO IGD', no_transaksi: '21-211026-1322' })).toBe(false);
    expect(isIgdSourceCandidate({ nama_unit: 'FARMASI IGD', no_transaksi: '21-1' })).toBe(false);
    expect(isIgdSourceCandidate({ nama_unit: 'IGD PONEK', no_transaksi: '09-1' })).toBe(true);
    expect(isIgdSourceCandidate({ nama_unit: 'IGD' })).toBe(false);
  });
});

describe('looksLikeManualFollowupTransaction', () => {
  const cases: readonly (readonly [LegacyRow, boolean])[] = [
    [{ nama_unit: 'DEPO FARMASI IBS' }, true],
    [{ nama_unit: 'INSTALASI KAMAR JENAZAH' }, true],
    [{ nama_unit: 'LABORATORIUM PATOLOGI KLINIK' }, true],
    [{ nama_unit: 'MULTAZAM', no_transaksi: '51-000123' }, true],
    [{ nama_unit: 'MULTAZAM', no_transaksi: '04-000123' }, true],
    [{ nama_unit: 'MULTAZAM', no_transaksi: '01-000123' }, false],
    [{ nama_unit: 'ARAFAH', no_transaksi: '02-000123' }, false],
    [{}, false],
  ];
  for (const [row, expected] of cases) {
    it(`${expected ? 'flags' : 'passes'} ${JSON.stringify(row)}`, () => {
      expect(looksLikeManualFollowupTransaction(row)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// resolveExistingJasaCategoryClass
// ---------------------------------------------------------------------------

describe('resolveExistingJasaCategoryClass', () => {
  const kat3a: LegacyRow = {
    nama_tindakan: 'JASA PELAYANAN KAT 3',
    tgl_jam: '2026-03-10 08:00:00',
    urut_tindakan: '1',
  };
  const kat3b: LegacyRow = {
    nama_tindakan: 'JASA PELAYANAN KAT 3',
    tgl_jam: '2026-03-10 09:00:00',
    urut_tindakan: '2',
  };
  const kat1: LegacyRow = {
    nama_tindakan: 'JASA PELAYANAN KAT 1',
    tgl_jam: '2026-03-11 07:00:00',
    urut_tindakan: '3',
  };

  it('returns "" when no jasa rows are categorised', () => {
    expect(
      resolveExistingJasaCategoryClass([
        { nama_tindakan: 'BIAYA KAMAR MULTAZAM', tgl_jam: '2026-03-10 08:00:00' },
        { nama_tindakan: 'JASA PELAYANAN PERAWAT IGD', tgl_jam: '2026-03-10 08:00:00' },
      ]),
    ).toBe('');
  });

  it('returns "" for an empty row list', () => {
    expect(resolveExistingJasaCategoryClass([])).toBe('');
  });

  it('picks the most frequent class when no target dates are given', () => {
    expect(resolveExistingJasaCategoryClass([kat3a, kat3b, kat1])).toBe('KELAS 3');
  });

  it('restricts to the target dates first', () => {
    expect(resolveExistingJasaCategoryClass([kat3a, kat3b, kat1], ['2026-03-11'])).toBe('KELAS 1');
  });

  it('falls back to every row when the target dates match nothing', () => {
    expect(resolveExistingJasaCategoryClass([kat3a, kat3b, kat1], ['2026-03-20'])).toBe('KELAS 3');
  });

  it('breaks a count tie with the latest row', () => {
    expect(resolveExistingJasaCategoryClass([kat3a, kat1])).toBe('KELAS 1');
  });

  it('breaks a count-and-date tie with the care-class rank', () => {
    const sameDay: readonly LegacyRow[] = [
      { nama_tindakan: 'JASA PELAYANAN KAT 3', tgl_jam: '2026-03-10 08:00:00', urut_tindakan: '1' },
      { nama_tindakan: 'JASA PELAYANAN KAT 1', tgl_jam: '2026-03-10 08:00:00', urut_tindakan: '2' },
    ];
    expect(resolveExistingJasaCategoryClass(sameDay)).toBe('KELAS 1');
  });

  it('normalises row dates before comparing them to the target dates', () => {
    const dmyRow: LegacyRow = {
      nama_tindakan: 'JASA PELAYANAN KAT 2',
      tgl_jam: '11-03-2026 07:00:00',
      urut_tindakan: '1',
    };
    expect(resolveExistingJasaCategoryClass([dmyRow], ['2026-03-11'])).toBe('KELAS 2');
  });
});

// ---------------------------------------------------------------------------
// Keyword-list pins — a dropped keyword is a billing bug, so fail loudly.
// ---------------------------------------------------------------------------

describe('keyword list contents', () => {
  it('pins ROOM_CHARGE_BLOCKED_TOKENS', () => {
    expect(ROOM_CHARGE_BLOCKED_TOKENS).toEqual([
      'POLIKLINIK',
      'UGD',
      'IGD',
      'LABORATORIUM',
      'RADIOLOGI',
      'HEMODIALISA',
      'HEMODIALISIS',
      'HAEMODIALISA',
      'HAEMODIALISIS',
      'DIALISIS',
      'ELEKTROMEDIK',
      'OBAT',
      'ADMINISTRASI',
      'BANK DARAH',
      'CATHLAB',
      'DOKTER',
      'JASA',
      'TINDAKAN',
      'GIZI',
      'DIIT',
      'IBS',
      'BEDAH SENTRAL',
      'PENUNJANG',
      'OPERASI',
    ]);
  });

  it('pins JASA_CATEGORY_CLASS_BY_NAME', () => {
    expect(JASA_CATEGORY_CLASS_BY_NAME).toEqual({
      'JASA PELAYANAN KAT 1': 'KELAS 1',
      'JASA PELAYANAN KAT 2': 'KELAS 2',
      'JASA PELAYANAN KAT 3': 'KELAS 3',
    });
  });

  it('pins IGD_ORIGIN_CHARGE_PREFIXES', () => {
    expect(IGD_ORIGIN_CHARGE_PREFIXES).toEqual(['BIAYA UGD', 'BIAYA IGD KEBIDANAN']);
  });

  it('pins IGD_HEMODIALYSIS_TOKENS', () => {
    expect(IGD_HEMODIALYSIS_TOKENS).toEqual([
      'BIAYA HEMODIALISA',
      'BIAYA HEMODIALISIS',
      'BIAYA HAEMODIALISA',
      'BIAYA HAEMODIALISIS',
      'HAEMODIALISA CITO',
      'HEMODIALISA CITO',
    ]);
  });

  it('pins IGD_DOCTOR_PREFIXES', () => {
    expect(IGD_DOCTOR_PREFIXES).toEqual(['DOKTER IGD', 'DOKTER UGD']);
  });

  it('pins IGD_JASA_CONTEXT_TOKENS', () => {
    expect(IGD_JASA_CONTEXT_TOKENS).toEqual([
      'PERAWAT IGD',
      'PERAWAT UGD',
      'BIDAN IGD',
      'BIDAN UGD',
      ' IGD',
      ' UGD',
    ]);
  });

  it('pins PROTECTED_NON_DELETABLE_CHARGE_NAMES', () => {
    expect(PROTECTED_NON_DELETABLE_CHARGE_NAMES).toEqual([
      'BIAYA CATHLAB',
      'BIAYA BEDAH SENTRAL',
      'BIAYA POLIKLINIK',
      'BIAYA RADIOLOGI',
      'BIAYA PENUNJANG ELEKTROMEDIK',
      'BIAYA LABORATORIUM',
      'BIAYA LABORATORIUM PA',
      'BIAYA HEMODIALISA',
      'BIAYA HEMODIALISIS',
      'BIAYA HAEMODIALISA',
      'BIAYA HAEMODIALISIS',
      'BIAYA OBAT',
    ]);
  });

  it('pins PARTUS_DOCTOR_ACTION_PREFIXES', () => {
    expect(PARTUS_DOCTOR_ACTION_PREFIXES).toEqual(['PARTUS', 'TINDAKAN PARTUS']);
  });

  it('pins CRITICAL_CARE_ROOM_CLASSES', () => {
    expect(CRITICAL_CARE_ROOM_CLASSES).toEqual(['ICU', 'ICCU', 'HCU', 'NICU', 'PICU', 'SCN']);
  });

  it('pins PREMIUM_ROOM_PAYMENT_GUARD_CLASSES', () => {
    expect(PREMIUM_ROOM_PAYMENT_GUARD_CLASSES).toEqual(['VIP', 'VVIP']);
  });

  it('pins EXCLUDED_TAMPUNG_BAYAR_TOKENS', () => {
    expect(EXCLUDED_TAMPUNG_BAYAR_TOKENS).toEqual([
      'AMBULANCE',
      'INSTALASI KAMAR JENAZAH',
      'INSTALASI JENAZAH',
    ]);
  });

  it('pins ROOM_ROLE_PREFIXES', () => {
    expect(ROOM_ROLE_PREFIXES).toEqual(['PERAWAT ', 'BIDAN ', 'RUANG ']);
  });

  it('pins TAKE_HOME_MED_BLOCKED_TOKENS', () => {
    expect(TAKE_HOME_MED_BLOCKED_TOKENS).toEqual([
      'INFUS',
      'INJ',
      'INJEKSI',
      'CATHETER',
      'KATETER',
      'DRESSING',
      'SWAB',
      'PLESTER',
      'SARUNG TANGAN',
      'SET ',
      ' BLOOD ',
      'TRITON',
      'IODINE',
      'AQUABIDES',
      'OXYTOCIN',
      'METHYLERGOMETRIN',
      'ONDANSETRON',
      'CEFAZOLIN',
      'GENTAMYCIN INJ',
      'PARACETAMOL 1000MG/100ML INFUS',
      'METRONIDAZOL 500MG/100ML INFUS',
      'ASAM TRANEKSAMAT 500MG INJ',
      'BUPIVACAIN',
      'SPINAL INJ',
      'LIQUID',
      'PLAIN',
      'CHROMIC',
      'VIO ',
      'VOLULYTE',
    ]);
  });

  it('pins TAKE_HOME_MED_INCLUDE_TOKENS', () => {
    expect(TAKE_HOME_MED_INCLUDE_TOKENS).toEqual([
      ' TAB',
      ' TABLET',
      ' CAPS',
      ' CAP ',
      ' KAPLET',
      ' SYRUP',
      ' SIRUP',
      ' SUSP',
      ' DROP',
      ' DROPS',
      ' PUYER',
      ' CREAM',
      ' SALEP',
      ' OINTMENT',
      ' SUPPOS',
      ' SUPP',
    ]);
  });

  it('pins MANUAL_FOLLOWUP_UNIT_TOKENS', () => {
    expect(MANUAL_FOLLOWUP_UNIT_TOKENS).toEqual([
      'DEPO',
      'FARMASI',
      'BANK DARAH',
      'CATHLAB',
      'RADIOLOGI',
      'LAB',
      'AMBULANCE',
      'JENAZAH',
      'HEMODIALISA',
      'HEMODIALISIS',
      'HAEMODIALISA',
      'HAEMODIALISIS',
      'DIALISIS',
      'PATOLOGI',
      'PA',
      'GIZI',
      'ELEKTROMEDIK',
      'PENUNJANG',
      'IBS',
      'OK',
    ]);
  });

  it('pins MANUAL_FOLLOWUP_TRANSAKSI_PREFIXES', () => {
    expect(MANUAL_FOLLOWUP_TRANSAKSI_PREFIXES).toEqual([
      '04-',
      '13-',
      '18-',
      '19-',
      '51-',
      '52-',
      '53-',
      '54-',
      '55-',
    ]);
  });

  it('pins BYNY_HEALTHY_DIAGNOSIS_TOKENS', () => {
    expect(BYNY_HEALTHY_DIAGNOSIS_TOKENS).toEqual([
      'SEHAT',
      'BAYI SEHAT',
      'NEONATUS SEHAT',
      'BAYI BARU LAHIR NORMAL',
      'BAYI BARU LAHIR SEHAT',
      'NEONATUS ATERM',
      'RAWAT GABUNG',
    ]);
  });

  it('pins BYNY_SICK_DIAGNOSIS_TOKENS', () => {
    expect(BYNY_SICK_DIAGNOSIS_TOKENS).toEqual([
      'ASFIKSIA',
      'SEPSIS',
      'IKTERUS',
      'HIPERBILIRUBIN',
      'PREMATUR',
      'PREMATURITAS',
      'BBLR',
      'RDS',
      'PNEUMONIA',
      'FEBRIS',
      'FEEDING PROBLEM',
      'FEEDING',
      'VOMITUS',
      'VOMITING',
      'MUNTAH',
      'REGURGITASI',
      'ASPIRASI',
      'INTOLERANSI',
      'INTOLERANCE',
      'GANGGUAN MINUM',
      'SULIT MINUM',
      'HIPOKSIA',
      'RESPIRATORY',
      'KONVULSI',
      'KEJANG',
      'INFEKSI',
      'SAKIT',
      'KELAINAN',
      'DISTRESS',
      'SYNDROME',
      'GANGGUAN',
      'ANOMALI',
      'HERNIA',
      'ATRESIA',
      'NEKROSIS',
      'OMFALOKEL',
      'MENINGITIS',
    ]);
  });

  it('pins UNPAID_KUNJUNGAN_STATUS_KEYS', () => {
    expect(UNPAID_KUNJUNGAN_STATUS_KEYS).toEqual(['', 'BELUM', 'BELUMBAYAR', 'OPEN']);
  });

  it('pins DEFAULT_ACCEPTED_PENJAMIN_KEYWORDS', () => {
    expect(DEFAULT_ACCEPTED_PENJAMIN_KEYWORDS).toEqual(['BPJS PBI', 'BPJS NON PBI']);
  });

  it('pins CARE_CLASS_BY_KD', () => {
    expect(CARE_CLASS_BY_KD).toEqual({
      '1': 'VIP',
      '2': 'KELAS 1',
      '3': 'KELAS 2',
      '4': 'KELAS 3',
      '6': 'NICU',
      '8': 'ICU',
      '9': 'VVIP',
      '10': 'HCU',
      '11': 'ISOLASI',
      '12': 'DELUXE',
      '13': 'NON KELAS',
      '14': 'PICU',
      '15': 'BERSALIN',
      '16': 'ICCU',
    });
  });

  it('pins CARE_CLASS_RANK', () => {
    expect(CARE_CLASS_RANK).toEqual({
      'KELAS 3': 1,
      'KELAS 2': 2,
      'KELAS 1': 3,
      VIP: 4,
      VVIP: 5,
    });
  });
});
