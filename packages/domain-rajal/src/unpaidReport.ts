/* ════════════════════════════════════════════════════════════════
 * Batch discovery — `laporan/laporan_belum_bayar/preview`
 *
 * Legacy `doFetch` (source lines 1451-1513) is the only place the userscript
 * decides *which* records a run is about: it GETs the unpaid-bill report,
 * scrapes its HTML table, filters by penjamin and unit, and auto-populates
 * both the patient list and the clinic chips. Everything below is that
 * decision with the fetch hoisted out — pure report parsing and selection.
 * ════════════════════════════════════════════════════════════════ */
import { RAJAL_AUTO_EXCLUDE_SECTIONS } from './rules.js';

/** Legacy `extractClinicFromSection` (source line 333). */
export function extractRajalClinicFromSection(section: string): string {
  const trimmed = section.trim();
  // `\s+` and the trailing trim: "POLI  DALAM" must give "DALAM", not " DALAM".
  return trimmed.replace(/^POLI\s+/, '').trim();
}

/** Legacy `shouldExcludeSection` (source line 334) — case-insensitive substring. */
export function shouldExcludeRajalSection(section: string): boolean {
  const upper = section.toUpperCase();
  return RAJAL_AUTO_EXCLUDE_SECTIONS.some((excluded) => upper.includes(excluded.toUpperCase()));
}

export interface RajalUnpaidReportQuery {
  /** `cmbinstalasi` — see {@link RAJAL_INSTALASI_OPTIONS}. Legacy defaults '1'. */
  instalasi?: string;
  /** `txtperiode1` — ISO start date. */
  from: string;
  /** `txtperiode2` — ISO end date. */
  to: string;
}

/**
 * Legacy source line 1464 verbatim: every parameter the report URL carries,
 * in the order legacy wrote them. Fourteen of the eighteen are always empty or
 * a fixed flag, but the controller reads them all, so they are sent.
 *
 * This is a **GET**, so the caller must pass the result as `options.query` —
 * the client only form-encodes a body for POSTs, and a GET's body is dropped.
 */
export function buildRajalUnpaidReportQuery(args: RajalUnpaidReportQuery): Record<string, string> {
  return {
    cmbinstalasi: args.instalasi ?? '1',
    cmbunit: '',
    cmbshift: '',
    txtperiode1: args.from,
    txtperiode2: args.to,
    namaunit: '',
    cmbpenjamin: '',
    ckstatus: 'false',
    ckstatustidakbatal: 'true',
    kd_ruangperawatan: '',
    nama_ruangperawatan: '',
    kd_kamarperawatan: '',
    nama_kamarperawatan: '',
    ckbaru: 'false',
    cklama: 'false',
    ckkasusbaru: 'false',
    ckkasuslama: 'false',
    kd_icdx: '',
  };
}

/** One scraped row of the unpaid-bill report. */
export interface RajalUnpaidReportRow {
  /** The report's own sequence number (cell 0). */
  no: number;
  noTransaksi: string;
  noRM: string;
  namaPasien: string;
  penjamin: string;
  /** The unit heading this row sits under. */
  section: string;
}

export interface RajalUnpaidReportStats {
  /** Every data row the table carried, before filtering. */
  total: number;
  /** Rows that survived the penjamin and unit filters. */
  filtered: number;
  bySection: Readonly<Record<string, number>>;
  byPenjamin: Readonly<Record<string, number>>;
}

export interface RajalUnpaidReport {
  /**
   * True when the reply actually contained the report table.
   *
   * Legacy could not tell "the period is empty" from "the request failed": a
   * 500, a login redirect and a genuinely empty period all reach
   * `parseLaporanHTML` as markup with no rows, and `doFetch` reports all three
   * as `⚠️ 0 matched`. The typed client does not surface the HTTP status to a
   * caller either, so the only evidence available is whether the report
   * rendered its `table[border="1"]` at all. No table means "not read", and a
   * batch discovery that could not read its report must never look like a
   * batch with nothing to do.
   */
  readable: boolean;
  /** Rows that passed both filters, in report order. */
  patients: readonly RajalUnpaidReportRow[];
  /** Every section heading seen, in report order, filtered or not. */
  sections: readonly string[];
  stats: RajalUnpaidReportStats;
}

export interface RajalUnpaidReportFilters {
  /** Legacy `cfg-fetch-penjamin`: substring, case-insensitive. */
  penjamin?: string;
  /** Legacy `cfg-fetch-unit`: comma-separated substrings, any may match. */
  unit?: string;
}

/** Legacy `filterUnit.split(/[,]+/)` normalised to upper-case, blanks dropped. */
function unitFilters(unit: string | undefined): string[] {
  return (unit ?? '')
    .split(/[,]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * `Node.textContent` for a fragment of markup, without a DOM. Comments are
 * dropped first — the report ships commented-out `<td>` cells (a real one sits
 * between the discharge time and the sex column), and counting them would
 * shift every column index.
 */
function htmlTextContent(fragment: string): string {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

/**
 * The `border="1"` table's subtree, matching legacy's
 * `doc.querySelectorAll('table[border="1"]')[0]`. Depth-matched so nested
 * tables are included (a descendant `tr` is still a `tr` to `querySelectorAll`)
 * but a following sibling table is not.
 */
function firstBorderedTable(html: string): string | null {
  const opener = /<table\b[^>]*\bborder\s*=\s*["']?1["']?[^>]*>/i.exec(html);
  if (!opener) return null;
  const start = opener.index + opener[0].length;
  const tags = /<(\/?)table\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return html.slice(start);
}

/**
 * Legacy `parseLaporanHTML` (source lines 514-538).
 *
 * Hoisted fetch: `laporanBelumBayar.preview` — GET
 * `laporan/laporan_belum_bayar/preview` (see
 * {@link buildRajalUnpaidReportQuery}) → `html`.
 *
 * The table is one flat row list: a `colspan="13"` row carrying a `<b>`/
 * `<strong>` is a unit heading and re-arms `currentSection`; a `colspan="12"`
 * row is a subtotal and is skipped; anything else with at least thirteen cells
 * whose first cell parses as an integer is a patient. Column positions (1 =
 * transaksi, 2 = medrec, 3 = name, 5 = penjamin) are legacy's.
 */
export function parseRajalUnpaidReport(
  html: string,
  filters: RajalUnpaidReportFilters = {},
): RajalUnpaidReport {
  const table = firstBorderedTable(html);
  const stats = {
    total: 0,
    filtered: 0,
    bySection: {} as Record<string, number>,
    byPenjamin: {} as Record<string, number>,
  };
  if (table === null) return { readable: false, patients: [], sections: [], stats };

  const patients: RajalUnpaidReportRow[] = [];
  const sections: string[] = [];
  const penjaminFilter = (filters.penjamin ?? '').trim();
  const unitFilterList = unitFilters(filters.unit);
  let currentSection = '';

  for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = (rowMatch[1] ?? '').replace(/<!--[\s\S]*?-->/g, '');

    // `td[colspan="13"] b, td[colspan="13"] strong` — a unit heading.
    const heading = /<td\b[^>]*\bcolspan\s*=\s*["']?13["']?[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
    if (heading) {
      const emphasis = /<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(heading[1] ?? '');
      if (emphasis) {
        currentSection = htmlTextContent(emphasis[2] ?? '').trim();
        if (!sections.includes(currentSection)) sections.push(currentSection);
        continue;
      }
    }
    // A `colspan="12"` subtotal row.
    if (/<td\b[^>]*\bcolspan\s*=\s*["']?12["']?/i.test(rowHtml)) continue;

    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      htmlTextContent(cell[1] ?? '').trim(),
    );
    if (cells.length < 13) continue;
    const first = cells[0] ?? '';
    const no = Number.parseInt(first, 10);
    if (!first || Number.isNaN(no)) continue;

    const row: RajalUnpaidReportRow = {
      no,
      noTransaksi: cells[1] ?? '',
      noRM: cells[2] ?? '',
      namaPasien: cells[3] ?? '',
      penjamin: cells[5] ?? '',
      section: currentSection,
    };
    stats.total += 1;
    stats.bySection[currentSection] = (stats.bySection[currentSection] ?? 0) + 1;
    stats.byPenjamin[row.penjamin] = (stats.byPenjamin[row.penjamin] ?? 0) + 1;

    let pass = true;
    if (penjaminFilter) pass = row.penjamin.toUpperCase().includes(penjaminFilter.toUpperCase());
    if (pass && unitFilterList.length > 0) {
      pass = unitFilterList.some((filter) => currentSection.toUpperCase().includes(filter));
    }
    if (pass) {
      patients.push(row);
      stats.filtered += 1;
    }
  }
  return { readable: true, patients, sections, stats };
}

export interface RajalUnpaidBatch {
  /** Carried through from {@link RajalUnpaidReport.readable}. */
  readable: boolean;
  /** `noRM` of every matched row, in report order, duplicates kept. */
  patientIds: readonly string[];
  /** The same list de-duplicated — what legacy counts as the batch size. */
  uniquePatientIds: readonly string[];
  /** Clinic chips derived from the matched, non-excluded section headings. */
  clinics: readonly string[];
  /** Legacy `autoClinicPatientMap`: medrec → the clinics it was seen under. */
  clinicsByPatientId: Readonly<Record<string, readonly string[]>>;
  /** Section headings that were skipped as penunjang/pharmacy groupings. */
  excludedSections: readonly string[];
  stats: RajalUnpaidReportStats;
}

/**
 * Legacy `doFetch` (source lines 1470-1495) — what the operator's batch
 * *becomes* once the report has been read.
 *
 * The patient list is every matched row's medrec, duplicates and all (legacy
 * writes `rmList` into the textarea and only counts `uniqueRM` separately).
 * The clinic chips come from the section headings, re-filtered by `unit`
 * because a heading is not a row, and `mergeAutoClinicPatients` (source line
 * 361) records which clinic each medrec came from so removing a chip can
 * remove exactly its patients again. Excluded sections contribute neither.
 */
export function selectRajalUnpaidBatch(
  report: RajalUnpaidReport,
  filters: RajalUnpaidReportFilters = {},
): RajalUnpaidBatch {
  const patientIds = report.patients.map((row) => row.noRM.trim()).filter(Boolean);
  const unitFilterList = unitFilters(filters.unit);
  const matchedSections = report.sections.filter(
    (section) =>
      unitFilterList.length === 0 ||
      unitFilterList.some((filter) => section.toUpperCase().includes(filter)),
  );
  const excludedSections = matchedSections.filter(shouldExcludeRajalSection);
  const clinics = [
    ...new Set(
      matchedSections
        .filter((section) => !shouldExcludeRajalSection(section))
        .map(extractRajalClinicFromSection)
        .filter(Boolean),
    ),
  ];

  const clinicsByPatientId: Record<string, string[]> = {};
  for (const row of report.patients) {
    if (!row.section || shouldExcludeRajalSection(row.section)) continue;
    const clinic = extractRajalClinicFromSection(row.section);
    const noRM = row.noRM.trim();
    if (!clinic || !noRM) continue;
    const bucket = clinicsByPatientId[noRM] ?? (clinicsByPatientId[noRM] = []);
    if (!bucket.includes(clinic)) bucket.push(clinic);
  }

  return {
    readable: report.readable,
    patientIds,
    uniquePatientIds: [...new Set(patientIds)],
    clinics,
    clinicsByPatientId,
    excludedSections,
    stats: report.stats,
  };
}
