/**
 * Iur naik kelas — pure helpers behind the page: fetch, filter, sort, totals
 * and the export table. Rows come from `GET /api/naik-kelas` (the doctors'
 * Google Form responses sheet).
 */

import { getJson, postJson } from '../../api/client.js';
import type { XlsxCell } from '../table/xlsx.js';

export interface NaikKelasRow {
  timestamp: string;
  noRm: string;
  nama: string;
  hakKelas: string;
  kelasRanap: string;
  totalBilling: number | null;
  tindakan: string;
  kasus: string;
  dokter: string;
  kodeGrouping: string;
  klaimBpjs: string;
  klaimKelas1: number | null;
  klaimKelas2: number | null;
  iur: number | null;
  tglPulang: string;
}

export interface NaikKelasSnapshot {
  source: string;
  fetchedAt: string;
  fetchedBy: string;
  rows: NaikKelasRow[];
  missingColumns: string[];
}

/** `GET /api/naik-kelas`: the stored snapshot plus refresh bookkeeping. */
export interface NaikKelasStatus {
  snapshot?: NaikKelasSnapshot;
  source: string;
  defaultSource: string;
  refreshHours: number;
  nextAutoRefreshAt?: string;
  refreshing: boolean;
  lastError?: { at: string; message: string };
}

export const fetchNaikKelas = () => getJson<NaikKelasStatus>('/api/naik-kelas');
export const refreshNaikKelas = () => postJson<NaikKelasStatus>('/api/naik-kelas/refresh');
export const setNaikKelasSource = (source: string) => postJson<NaikKelasStatus>('/api/naik-kelas/source', { source });

export type DateField = 'tglPulang' | 'timestamp';

export interface NaikKelasFilter {
  query: string;
  dateField: DateField;
  from: string;
  to: string;
  hakKelas: string;
  kelasRanap: string;
  dokter: string;
  /** Column "contains" filters (case-insensitive). */
  kasus: string;
  tindakan: string;
  kodeGrouping: string;
  klaimBpjs: string;
  /** Rupiah ranges; '' = open end. */
  iurMin: string;
  iurMax: string;
  billingMin: string;
  billingMax: string;
}

export const EMPTY_FILTER: NaikKelasFilter = {
  query: '', dateField: 'tglPulang', from: '', to: '', hakKelas: '', kelasRanap: '', dokter: '',
  kasus: '', tindakan: '', kodeGrouping: '', klaimBpjs: '', iurMin: '', iurMax: '', billingMin: '', billingMax: '',
};

/** "1.500.000", "1500000", "1,5 jt" or "500rb" → rupiah; '' or unreadable → undefined (open end). */
export function parseRupiahInput(value: string): number | undefined {
  const v = value.trim().toLowerCase().replace(/^rp\s*/, '');
  if (!v) return undefined;
  const short = /^(\d+(?:[.,]\d+)?)\s*(jt|juta|rb|ribu|m|miliar)$/.exec(v);
  if (short) {
    const n = Number(short[1]!.replace(',', '.'));
    const unit = short[2]!;
    return n * (unit.startsWith('j') ? 1e6 : unit.startsWith('r') ? 1e3 : 1e9);
  }
  const plain = Number(v.replace(/[.\s]/g, '').replace(',', '.'));
  return Number.isFinite(plain) ? plain : undefined;
}

const contains = (value: string, needle: string) => !needle.trim() || value.toLowerCase().includes(needle.trim().toLowerCase());
const inRange = (value: number | null, min: string, max: string) => {
  const lo = parseRupiahInput(min);
  const hi = parseRupiahInput(max);
  if (lo === undefined && hi === undefined) return true;
  if (value === null) return false;
  return (lo === undefined || value >= lo) && (hi === undefined || value <= hi);
};

/**
 * The sheet mixes "1" and "I" for kelas; compare on one spelling. Room
 * classes too: DELUXE = VIP, PRESIDENT SUITE = VVIP (the server already maps
 * them; this keeps filters right on a snapshot stored before that).
 */
export function normalizeKelas(value: string): string {
  const v = value.trim().toUpperCase().replace(/\s+/g, ' ');
  if (v === 'DELUXE') return 'VIP';
  if (v === 'PRESIDENT SUITE' || v === 'PRESIDENTIAL SUITE') return 'VVIP';
  return ({ '1': 'I', '2': 'II', '3': 'III' } as Record<string, string>)[v] ?? v;
}

/**
 * Free-text search over the identifying and clinical columns. A query with
 * digits also matches the No. RM ignoring dashes, so 123456 finds 0-12-34-56.
 */
export function rowMatchesQuery(row: NaikKelasRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  if (digits && digits.length === q.replace(/[\s-]/g, '').length && row.noRm.replace(/\D/g, '').includes(digits)) return true;
  return [row.noRm, row.nama, row.dokter, row.tindakan, row.kasus, row.kodeGrouping]
    .some((field) => field.toLowerCase().includes(q));
}

export function filterRows(rows: readonly NaikKelasRow[], f: NaikKelasFilter): NaikKelasRow[] {
  return rows.filter((row) => {
    const date = row[f.dateField].slice(0, 10);
    return rowMatchesQuery(row, f.query)
      && (!f.from || date >= f.from)
      && (!f.to || date <= f.to)
      && (!f.hakKelas || normalizeKelas(row.hakKelas) === f.hakKelas)
      && (!f.kelasRanap || normalizeKelas(row.kelasRanap) === f.kelasRanap)
      && (!f.dokter || row.dokter === f.dokter)
      && contains(row.kasus, f.kasus)
      && contains(row.tindakan, f.tindakan)
      && contains(row.kodeGrouping, f.kodeGrouping)
      && contains(row.klaimBpjs, f.klaimBpjs)
      && inRange(row.iur, f.iurMin, f.iurMax)
      && inRange(row.totalBilling, f.billingMin, f.billingMax);
  });
}

export type SortKey = keyof NaikKelasRow;
export interface SortState { key: SortKey; dir: 'asc' | 'desc' }

export function sortRows(rows: readonly NaikKelasRow[], sort: SortState): NaikKelasRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    // Blank values sort last in both directions.
    if (x === null || x === '') return y === null || y === '' ? 0 : 1;
    if (y === null || y === '') return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), 'id', { numeric: true }) * sign;
  });
}

export function summarize(rows: readonly NaikKelasRow[]) {
  const sum = (key: 'iur' | 'totalBilling' | 'klaimKelas1' | 'klaimKelas2') => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
  const iur = sum('iur');
  return {
    count: rows.length,
    iur,
    billing: sum('totalBilling'),
    klaimKelas1: sum('klaimKelas1'),
    klaimKelas2: sum('klaimKelas2'),
    avgIur: rows.length ? iur / rows.length : 0,
  };
}

/** Distinct, sorted values of a column for a filter dropdown. */
export function options(rows: readonly NaikKelasRow[], pick: (row: NaikKelasRow) => string): string[] {
  return [...new Set(rows.map(pick).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id', { numeric: true }));
}

/** Columns in display/export order. `width` is the xlsx column width in characters. */
export const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; money?: boolean; width: number }> = [
  { key: 'tglPulang', label: 'Tgl pulang', width: 12 },
  { key: 'noRm', label: 'No. RM', width: 13 },
  { key: 'nama', label: 'Nama pasien', width: 30 },
  { key: 'hakKelas', label: 'Hak kelas', width: 9 },
  { key: 'kelasRanap', label: 'Kelas ranap', width: 11 },
  { key: 'dokter', label: 'Dokter', width: 28 },
  { key: 'kasus', label: 'Kasus', width: 18 },
  { key: 'tindakan', label: 'Tindakan', width: 26 },
  { key: 'kodeGrouping', label: 'Kode grouping', width: 14 },
  { key: 'totalBilling', label: 'Total billing', money: true, width: 15 },
  { key: 'klaimKelas1', label: 'Klaim BPJS kelas I', money: true, width: 17 },
  { key: 'klaimKelas2', label: 'Klaim BPJS kelas II', money: true, width: 17 },
  { key: 'iur', label: 'IUR', money: true, width: 15 },
  { key: 'timestamp', label: 'Diinput', width: 19 },
];

export function exportTable(rows: readonly NaikKelasRow[]): { header: string[]; body: XlsxCell[][]; widths: number[] } {
  return {
    header: COLUMNS.map((c) => c.label),
    body: rows.map((row) => COLUMNS.map((c) => (c.key === 'timestamp' ? row.timestamp.replace('T', ' ') : row[c.key]))),
    widths: COLUMNS.map((c) => c.width),
  };
}
