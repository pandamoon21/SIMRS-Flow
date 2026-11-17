/**
 * SEP and clinic verdicts for rawat jalan: unit → selected clinic, clinic →
 * BPJS `poli_tujuan`, and which SEP a transaction should carry.
 *
 * Everything here is a pure function: no network, no clock, no module state.
 * Each one is the *decision* half of a legacy guard, with every remote read
 * hoisted into a parameter and the supplying endpoint named. `executors.ts`
 * is the I/O shell that fetches, calls, and turns the verdict into a
 * `StepResult`.
 */
import { normalizeDate } from '@simrs-flow/evomedis-client';
import { RAJAL_CLINIC_MAPPING, RAJAL_SEP_SERVICE_TYPE, RAJAL_UNMAPPED_CLINIC_UNITS } from '../rules.js';
import type { RajalRecordRow, RajalSepRow } from '../types.js';

export function normalizeSepPoliName(value: string): string {
  return value
    .toUpperCase()
    .replace(/&/g, ' DAN ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Legacy `poliMatches` (source lines 817-824): the SEP's `poli_tujuan` matches
 * a clinic when either side contains the other after normalization.
 */
export function sepPoliMatches(poliTujuan: string, candidates: readonly string[]): boolean {
  const normalized = normalizeSepPoliName(poliTujuan);
  if (!normalized) return false;
  return candidates.some(
    (candidate) =>
      normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized),
  );
}

/**
 * The {@link RAJAL_CLINIC_MAPPING} key for a clinic or report unit name.
 * Exact (after {@link normalizeClinicLabel}) first, then the LONGEST key that
 * substring-matches — legacy took the first hit in insertion order, so a
 * report heading like "POLI JANTUNG ANAK" became ANAK and
 * "POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI" became DALAM.
 *
 * A unit listed in {@link RAJAL_UNMAPPED_CLINIC_UNITS} is deliberately unmapped
 * (exact or prefix match after normalization) even when its name contains a
 * mapping key: borrowing JANTUNG for ARITMIA would resolve the wrong SEP.
 */
function rajalClinicMappingKey(clinic: string): keyof typeof RAJAL_CLINIC_MAPPING | undefined {
  const label = normalizeClinicLabel(clinic);
  // Guard the substring fallback: `includes('')` is always true, so an unset
  // clinic would silently become a real poli.
  if (!label) return undefined;
  // Prefix catches the raw unit list form "JANTUNG ARITMIA 251".
  if (RAJAL_UNMAPPED_CLINIC_UNITS.some((unit) => { const norm = normalizeClinicLabel(unit); return label === norm || label.startsWith(`${norm} `); })) return undefined;
  const keys = Object.keys(RAJAL_CLINIC_MAPPING) as (keyof typeof RAJAL_CLINIC_MAPPING)[];
  const exact = keys.find((key) => normalizeClinicLabel(key) === label);
  if (exact) return exact;
  return keys
    .map((key) => ({ key, norm: normalizeClinicLabel(key) }))
    .filter(({ norm }) => label.includes(norm) || norm.includes(label))
    .sort((a, b) => b.norm.length - a.norm.length)[0]?.key;
}

export function mapRajalClinicToSepPoli(clinic: string): string {
  const key = rajalClinicMappingKey(clinic);
  return key ? RAJAL_CLINIC_MAPPING[key].toLowerCase() : clinic.toLowerCase().trim();
}

export function rajalClinicCandidates(clinic: string): readonly string[] {
  const source = clinic.trim();
  const mapped = mapRajalClinicToSepPoli(source);
  // A mapped clinic matches on its SEP poli only: the raw unit name can contain
  // another poli ("PENYAKIT DALAM GASTROENTEROHEPATOLOGI" ⊃ "PENYAKIT DALAM")
  // and would accept that clinic's same-day SEP.
  const candidates = rajalClinicMappingKey(source)
    ? [mapped, mapped.replace(/-/g, ' ')]
    : [mapped, source, mapped.replace(/-/g, ' '), source.replace(/^POLI\s+/i, '')];
  return [...new Set(candidates.filter(Boolean).map(normalizeSepPoliName).filter(Boolean))];
}

/**
 * Legacy `normalizeClinicLabel` (source line 283). Note this one strips a
 * leading `POLI ` where {@link normalizeSepPoliName} does not — the clinic
 * matcher compares unit names, the SEP matcher compares poli tujuan.
 */
export function normalizeClinicLabel(value: string): string {
  return value
    .toUpperCase()
    .replace(/^POLI\s+/, '')
    .replace(/&/g, ' DAN ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RajalClinicMatch {
  /** The single selected clinic this unit belongs to, or `''`. */
  matchedClinic: string;
  /** Every clinic that scored, best first; the tied winners when ambiguous. */
  matches: readonly string[];
  /** Two clinics tied for best — legacy skips the record rather than guess. */
  ambiguous: boolean;
  /** The normalized unit label, kept for the operator log. */
  unitNorm: string;
}

/**
 * Legacy `resolveClinicMatch` (source lines 293-331).
 *
 * Scores every selected clinic against a visit's `nama_unit` and demands a
 * unique winner. The score tiers are load-bearing: an exact match beats a
 * prefix, which beats a suffix, which beats an interior word, which beats a
 * bare substring, which beats the reverse containment. Ties are broken by
 * longer clinic name then alphabetically — and when the top two are still
 * indistinguishable the match is *ambiguous*, which makes
 * `findMatchingRecords` (source line 734) drop the record entirely rather
 * than bill it against a guessed clinic.
 */
export function resolveRajalClinicMatch(
  unitName: string,
  clinics: readonly string[],
): RajalClinicMatch {
  const unitNorm = normalizeClinicLabel(unitName.trim());
  // Entries that normalize alike ("DALAM", " DALAM", "POLI DALAM") are one poli,
  // not two candidates: counting them twice flagged every such visit ambiguous.
  const seen = new Set<string>();
  const clinicList = clinics.map((item) => item.trim()).filter((item) => {
    const key = normalizeClinicLabel(item);
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unitNorm || clinicList.length === 0) {
    return { matchedClinic: '', matches: [], ambiguous: false, unitNorm };
  }
  const scored = clinicList
    .map((clinic) => {
      const clinicNorm = normalizeClinicLabel(clinic);
      let score = 0;
      if (unitNorm === clinicNorm) score = 3000;
      else if (unitNorm.startsWith(`${clinicNorm} `)) score = 2000 + clinicNorm.length;
      else if (unitNorm.endsWith(` ${clinicNorm}`)) score = 1900 + clinicNorm.length;
      else if (unitNorm.includes(` ${clinicNorm} `)) score = 1800 + clinicNorm.length;
      else if (unitNorm.includes(clinicNorm)) score = 1000 + clinicNorm.length;
      else if (clinicNorm.includes(unitNorm)) score = 500 + unitNorm.length;
      return { clinic, clinicNorm, score };
    })
    .filter((item) => item.score > 0);
  if (scored.length === 0) {
    return { matchedClinic: '', matches: [], ambiguous: false, unitNorm };
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || b.clinicNorm.length - a.clinicNorm.length || a.clinic.localeCompare(b.clinic),
  );
  const best = scored[0]!;
  const topMatches = scored.filter(
    (item) => item.score === best.score && item.clinicNorm.length === best.clinicNorm.length,
  );
  if (topMatches.length > 1) {
    return {
      matchedClinic: '',
      matches: topMatches.map((item) => item.clinic),
      ambiguous: true,
      unitNorm,
    };
  }
  return {
    matchedClinic: best.clinic,
    matches: scored.map((item) => item.clinic),
    ambiguous: false,
    unitNorm,
  };
}

/**
 * Legacy `getMatchedClinic` (source line 747). `filterRecords` already resolved
 * and stamped the clinic with the scored matcher, so this only re-resolves for
 * rows that never went through the filter (the SEP sibling scan looks at every
 * same-day visit, including ones the filter dropped). An ambiguous or unmatched
 * unit yields `''`, exactly as legacy did.
 */
export function matchedClinic(record: Pick<RajalRecordRow, 'matchedClinic' | 'nama_unit'>, clinics: readonly string[]): string {
  if (record.matchedClinic) return record.matchedClinic;
  const match = resolveRajalClinicMatch(record.nama_unit ?? '', clinics);
  return match.ambiguous ? '' : match.matchedClinic;
}

/**
 * Legacy `removePatientIdsForClinic` (source line 373): keep discovered ids
 * seen under a selected poli. Matching goes through `resolveRajalClinicMatch`
 * because chips are aliases (`DALAM`) and sections long forms; an id the map
 * never claimed is kept, as legacy's `beforeManaged` guard does.
 */
export function keepSelectedClinicPatients(
  ids: readonly string[],
  clinicsByPatientId: Record<string, string[]>,
  requested: readonly string[],
): string[] {
  const selected = requested.filter((clinic) => rajalClinicCandidates(clinic).length > 0);
  if (requested.length === 0) return [...ids];
  return ids.filter((id) => {
    const seen = clinicsByPatientId[id];
    if (!seen || seen.length === 0) return true;
    return seen.some((section) => selected.some((clinic) => resolveRajalClinicMatch(section, [clinic]).matchedClinic !== ''));
  });
}

export type RajalSepResolution =
  | { kind: 'direct'; noSep: string }
  | { kind: 'sibling'; noSep: string }
  | { kind: 'ambiguous'; candidates: readonly string[] }
  | { kind: 'none' };

/**
 * Legacy `checkSep` (lines 797-864), the decision half: which SEP a visit's
 * transaction should carry.
 *
 * Hoisted fetch: `pendaftaran.getRiwayatSep` ({no_kartu}) → `rows`.
 *
 * Only same-day RJTL rows count. A row whose `poli_tujuan` maps to the billed
 * clinic wins outright. Failing that, when the patient has several visits
 * that day (`sameDayVisits`, drawn from the filtered `matching` set — legacy
 * source line 1057 — so a dropped penunjang visit cannot donate its SEP), one
 * unique sibling-clinic SEP is accepted as the "poli asal" SEP; two or more
 * is ambiguous.
 */
export function resolveRajalSep(args: {
  rows: readonly RajalSepRow[];
  /** Visit date, ISO. */
  date: string;
  /** SEP poli spellings of the billed clinic ({@link rajalClinicCandidates}). */
  candidates: readonly string[];
  /** The billed clinic as resolved for this visit. */
  clinic: string;
  /** This patient's visits on `date` that are still in play. */
  sameDayVisits: readonly RajalRecordRow[];
  /** The run's selected clinics. */
  clinics: readonly string[];
}): RajalSepResolution {
  const sameDay = args.rows.filter(
    (row) =>
      // Normalize before comparing: BPJS rows carry timestamps
      // ("2026-10-21 00:00:00") and DD/MM/YYYY, so a raw compare dropped
      // a same-day SEP into the "no SEP" branch.
      normalizeDate(row.tgl_sep ?? '') === args.date &&
      (row.jns_pelayanan ?? '').toUpperCase().trim() === RAJAL_SEP_SERVICE_TYPE,
  );
  const direct = (sameDay.find((row) => sepPoliMatches(row.poli_tujuan ?? '', args.candidates))?.no_sep ?? '').trim();
  if (direct) return { kind: 'direct', noSep: direct };
  if (args.sameDayVisits.length <= 1) return { kind: 'none' };
  // Legacy source line 832 falls back to the raw unit name when the scored
  // matcher finds nothing, so a sibling visit still donates a candidate poli.
  const siblingCandidates = [
    ...new Set(
      args.sameDayVisits
        .map((row) => matchedClinic(row, args.clinics) || (row.nama_unit ?? '').trim())
        .filter((name) => Boolean(name) && name !== args.clinic),
    ),
  ].flatMap((name) => rajalClinicCandidates(name));
  const siblingSeps = [
    ...new Set(
      sameDay
        .filter((row) => sepPoliMatches(row.poli_tujuan ?? '', siblingCandidates))
        .map((row) => (row.no_sep ?? '').trim())
        .filter(Boolean),
    ),
  ];
  if (siblingSeps.length > 1) return { kind: 'ambiguous', candidates: siblingSeps };
  const sibling = siblingSeps[0];
  return sibling ? { kind: 'sibling', noSep: sibling } : { kind: 'none' };
}
