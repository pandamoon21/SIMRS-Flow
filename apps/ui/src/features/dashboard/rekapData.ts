/**
 * Rekapitulasi — pure period, aggregation, filter and sort helpers. Every
 * number on the page is derived from the processed-patient list, so the
 * period totals, the chart and the table always agree.
 */

import type { PatientCategory, PatientShift, PatientStatus, PatientWorkflow, ProcessedPatient } from './patients.js';

export type PeriodId = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';

export const PERIODS: ReadonlyArray<{ id: Exclude<PeriodId, 'custom'>; label: string }> = [
  { id: 'today', label: 'Hari ini' },
  { id: 'week', label: 'Minggu ini' },
  { id: 'month', label: 'Bulan ini' },
  { id: 'year', label: 'Tahun ini' },
  { id: 'all', label: 'Semua' },
];

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Inclusive [from, to] ISO dates of a period; '' = open. Weeks start on Monday. */
export function periodRange(id: Exclude<PeriodId, 'custom'>, now: Date): [string, string] {
  const today = isoDay(now);
  switch (id) {
    case 'today':
      return [today, today];
    case 'week': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return [isoDay(d), today];
    }
    case 'month':
      return [isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), today];
    case 'year':
      return [`${now.getFullYear()}-01-01`, today];
    case 'all':
      return ['', ''];
  }
}

/** The same-length window just before [from, to] — "vs periode sebelumnya". */
export function previousRange(from: string, to: string): [string, string] | undefined {
  if (!from || !to) return undefined;
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(a);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (days - 1));
  return [isoDay(prevFrom), isoDay(prevTo)];
}

export const inRange = (date: string, from: string, to: string) => (!from || date >= from) && (!to || date <= to);

export interface PeriodTotals {
  count: number;
  nominal: number;
  titipan: number;
  naikKelas: number;
  attention: number;
}

export function totalsOf(rows: readonly ProcessedPatient[]): PeriodTotals {
  return {
    count: rows.length,
    nominal: rows.reduce((n, p) => n + p.nominal, 0),
    titipan: rows.filter((p) => p.category === 'titipan').length,
    naikKelas: rows.filter((p) => p.category === 'naik_kelas').length,
    attention: rows.filter((p) => p.status === 'needs_review').length,
  };
}

/** Percent change vs the previous value; undefined when there is no base to compare with. */
export function deltaPct(current: number, previous: number): number | undefined {
  if (previous <= 0) return undefined;
  return Math.round(((current - previous) / previous) * 100);
}

export interface SeriesPoint {
  /** Filter value a click applies: an ISO day, a `YYYY-MM` month, or a shift number. */
  key: string;
  label: string;
  value: number;
  title: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/**
 * Chart series for a range: one bar per shift for a single day, per day up to
 * ~2 months, per month beyond. Empty days/months are kept so gaps show.
 */
export function seriesOf(rows: readonly ProcessedPatient[], from: string, to: string, fmt: (n: number) => string): { unit: 'shift' | 'day' | 'month'; points: SeriesPoint[] } {
  const dates = rows.map((r) => r.date).sort();
  const start = from || dates[0] || '';
  const end = to || dates.at(-1) || '';
  if (!start || !end) return { unit: 'day', points: [] };
  if (start === end) {
    const points = ([1, 2, 3] as PatientShift[]).map((s) => {
      const value = rows.filter((r) => r.date === start && r.shift === s).reduce((n, r) => n + r.nominal, 0);
      return { key: String(s), label: `Shift ${s}`, value, title: `Shift ${s} · ${fmt(value)}` };
    });
    return { unit: 'shift', points };
  }
  const sum = new Map<string, number>();
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  const spanDays = Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
  const byMonth = spanDays > 62;
  for (const r of rows) {
    if (!inRange(r.date, start, end)) continue;
    const k = byMonth ? r.date.slice(0, 7) : r.date;
    sum.set(k, (sum.get(k) ?? 0) + r.nominal);
  }
  const points: SeriesPoint[] = [];
  if (byMonth) {
    for (let d = new Date(a.getFullYear(), a.getMonth(), 1); d <= b; d.setMonth(d.getMonth() + 1)) {
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const value = sum.get(k) ?? 0;
      const label = `${MONTHS[d.getMonth()]}${d.getMonth() === 0 || points.length === 0 ? ` ${String(d.getFullYear()).slice(2)}` : ''}`;
      points.push({ key: k, label, value, title: `${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${fmt(value)}` });
    }
  } else {
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
      const k = isoDay(d);
      const value = sum.get(k) ?? 0;
      points.push({ key: k, label: String(d.getDate()), value, title: `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${fmt(value)}` });
    }
  }
  return { unit: byMonth ? 'month' : 'day', points };
}

export interface RekapFilter {
  query: string;
  from: string;
  to: string;
  category: 'all' | PatientCategory | 'attention';
  workflow: '' | PatientWorkflow;
  shift: '' | `${PatientShift}`;
  status: '' | PatientStatus;
  operator: string;
}

export const EMPTY_REKAP_FILTER: RekapFilter = { query: '', from: '', to: '', category: 'all', workflow: '', shift: '', status: '', operator: '' };

/** No. RM by digits (123456 finds 0-12-34-56), or name / operator / run id text. */
export function patientMatchesQuery(p: ProcessedPatient, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  if (digits && digits.length === q.replace(/[\s-]/g, '').length && p.noRm.replace(/\D/g, '').includes(digits)) return true;
  return [p.noRm, p.name, p.operator, p.runId].some((f) => f.toLowerCase().includes(q));
}

/** Everything except the category tab, so tab counts stay honest within the other filters. */
export function filterExceptCategory(rows: readonly ProcessedPatient[], f: RekapFilter): ProcessedPatient[] {
  return rows.filter((p) =>
    patientMatchesQuery(p, f.query)
    && inRange(p.date, f.from, f.to)
    && (!f.workflow || p.workflow === f.workflow)
    && (!f.shift || String(p.shift) === f.shift)
    && (!f.status || p.status === f.status)
    && (!f.operator || p.operator === f.operator));
}

export function matchesCategory(p: ProcessedPatient, category: RekapFilter['category']): boolean {
  if (category === 'all') return true;
  if (category === 'attention') return p.status === 'needs_review';
  return p.category === category;
}

/** Category-tab counts within every other active filter, so a tab never promises rows the table won't show. */
export function categoryCounts(rows: readonly ProcessedPatient[]): Record<RekapFilter['category'], number> {
  return {
    all: rows.length,
    titipan: rows.filter((p) => matchesCategory(p, 'titipan')).length,
    naik_kelas: rows.filter((p) => matchesCategory(p, 'naik_kelas')).length,
    normal: rows.filter((p) => matchesCategory(p, 'normal')).length,
    attention: rows.filter((p) => matchesCategory(p, 'attention')).length,
  };
}

export type RekapSortKey = keyof Pick<ProcessedPatient, 'noRm' | 'name' | 'workflow' | 'date' | 'shift' | 'category' | 'operator' | 'nominal' | 'status'>;

export function sortPatients(rows: readonly ProcessedPatient[], key: RekapSortKey, dir: 'asc' | 'desc'): ProcessedPatient[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key === 'date' ? `${a.date} ${a.time}` : a[key];
    const y = key === 'date' ? `${b.date} ${b.time}` : b[key];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), 'id', { numeric: true }) * sign;
  });
}
