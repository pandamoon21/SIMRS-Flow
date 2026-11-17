/**
 * Billed-treatment verdicts for rawat jalan: consult detection, the operator's
 * required/skip treatment rules, and the per-bill include/exclude filter.
 *
 * Everything here is a pure function: no network, no clock, no module state.
 * Each one is the *decision* half of a legacy guard, with every remote read
 * hoisted into a parameter and the supplying endpoint named. `executors.ts`
 * is the I/O shell that fetches, calls, and turns the verdict into a
 * `StepResult`.
 */
import { normalizeDate } from '@simrs-flow/evomedis-client';
import type { RajalTreatmentGroup } from '../rules.js';
import type { RajalTindakanRow } from '../types.js';
import { isUnknownPenunjangTreatmentName } from './penunjang.js';

export function evaluateRajalConsultVisit(args: {
  visitDate: string;
  unit: string;
  history: readonly { tgl_masuk?: string; nama_unit?: string }[];
}): 'single_clinic' | 'consult' | 'unknown' {
  const validDate = (raw: string): string | null => {
    const date = normalizeDate(raw);
    if (!date) return null;
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
  };
  const visitDate = validDate(args.visitDate);
  const unit = args.unit.trim().toUpperCase();
  if (!visitDate || !/^POLI\s+\S/.test(unit)) return 'unknown';
  const units = new Set<string>([unit]);
  let found = false;
  for (const row of args.history) {
    const date = validDate(row.tgl_masuk ?? '');
    if (!date) return 'unknown';
    if (date !== visitDate) continue;
    const other = (row.nama_unit ?? '').trim().toUpperCase();
    if (!other) return 'unknown';
    if (!/^POLI\s+\S/.test(other)) continue;
    units.add(other);
    found = true;
  }
  return found ? units.size >= 2 ? 'consult' : 'single_clinic' : 'unknown';
}

export type RajalTreatmentVerdict =
  | { ok: true; matched: Readonly<Record<string, string>> }
  | { ok: false; kind: 'skip'; keyword: string; found: string }
  | { ok: false; kind: 'group'; group: string; expected: readonly string[] };

/**
 * Legacy `verifyTreatmentGroups` (source lines 762-782).
 *
 * Hoisted fetch: `kasir/kasir/get_listtindakan` → `names` (each row's
 * `nama_tindakan`, trimmed).
 *
 * Two rules, in order:
 *  1. Any skip treatment present anywhere on the bill rejects the record.
 *     Matched case-*insensitively* (source line 767).
 *  2. Every distinct group letter must be satisfied by at least one of its
 *     rows — so same letter is OR, different letters are AND. Matched
 *     case-*sensitively* (source line 776); that asymmetry is the legacy's,
 *     not a transcription slip.
 *
 * An empty group table passes, matching legacy's `if(!groups.length) return{}`.
 */
/**
 * The same decision as {@link verifyRajalTreatmentGroups}, spelled out per rule
 * for the operator: one line per forbidden treatment and per required group,
 * each marked met or not, instead of only the first failure.
 */
export function rajalTreatmentChecklist(
  names: readonly string[],
  groups: readonly RajalTreatmentGroup[],
  skipTreatments: readonly string[],
): Array<{ label: string; ok: boolean; detail: string }> {
  const trimmed = names.map((name) => name.trim());
  const items: Array<{ label: string; ok: boolean; detail: string }> = [];
  for (const skip of skipTreatments) {
    const keyword = skip.trim();
    if (!keyword) continue;
    const found = trimmed.find((name) => name.toUpperCase().includes(keyword.toUpperCase()));
    items.push({ label: `Tidak ada tindakan "${keyword}"`, ok: found === undefined, detail: found === undefined ? 'tidak ditemukan' : `ditemukan: ${found}` });
  }
  const byGroup = new Map<string, RajalTreatmentGroup[]>();
  for (const group of groups) byGroup.set(group.group, [...(byGroup.get(group.group) ?? []), group]);
  for (const [letter, items_] of byGroup) {
    const hit = items_.map((item) => trimmed.find((name) => name.includes(item.name))).find((found) => found !== undefined);
    items.push({
      label: `Grup ${letter}: ${items_.map((item) => item.name).join(' / ')}`,
      ok: hit !== undefined,
      detail: hit !== undefined ? `ada: ${hit}` : 'tidak ditagihkan',
    });
  }
  return items;
}

export function verifyRajalTreatmentGroups(
  names: readonly string[],
  groups: readonly RajalTreatmentGroup[],
  skipTreatments: readonly string[],
): RajalTreatmentVerdict {
  const trimmed = names.map((name) => name.trim());
  for (const skip of skipTreatments) {
    const keyword = skip.trim();
    if (!keyword) continue;
    const found = trimmed.find((name) => name.toUpperCase().includes(keyword.toUpperCase()));
    if (found !== undefined) return { ok: false, kind: 'skip', keyword, found };
  }
  if (groups.length === 0) return { ok: true, matched: {} };
  const byGroup = new Map<string, RajalTreatmentGroup[]>();
  for (const group of groups) {
    const bucket = byGroup.get(group.group);
    if (bucket) bucket.push(group);
    else byGroup.set(group.group, [group]);
  }
  const matched: Record<string, string> = {};
  for (const [letter, items] of byGroup) {
    const hit = items
      .map((item) => ({ item, found: trimmed.find((name) => name.includes(item.name)) }))
      .find((candidate) => candidate.found !== undefined);
    if (!hit) {
      return { ok: false, kind: 'group', group: letter, expected: items.map((item) => item.name) };
    }
    matched[hit.item.key] = hit.found!;
  }
  return { ok: true, matched };
}

/** Billed rows a penunjang guard cannot classify (radiology/lab/elektromedik-looking but none of them). */
export function unclassifiedPenunjangRows<T extends { readonly nama_tindakan?: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => isUnknownPenunjangTreatmentName(row.nama_tindakan ?? ''));
}

export interface RajalBillRules {
  /** Operator include keywords, upper-cased; empty = every row counts. */
  include: readonly string[];
  /** Operator exclude keywords, upper-cased. */
  exclude: readonly string[];
  groups: readonly RajalTreatmentGroup[];
  skipTreatments: readonly string[];
  minCount?: number | undefined;
}

export type RajalBillVerdict =
  | { ok: true; rows: readonly RajalTindakanRow[] }
  | { ok: false; severity: 'hard' | 'review'; reason: string };

/**
 * The operator's treatment rules applied to one classified bill, in legacy
 * order: skip list and required groups (`verifyTreatmentGroups`, source lines
 * 762-782 — both were absent from the first port, `RAJAL_TREATMENT_TEMPLATES`
 * was exported for the UI but never enforced), then the exclude keywords, then
 * the include filter and its minimum count. A rule failure is `hard` (the bill
 * must not be paid); a bill with nothing left to pay on is `review`.
 */
export function evaluateRajalBillRules(trx: string, allRows: readonly RajalTindakanRow[], rules: RajalBillRules): RajalBillVerdict {
  const name = (row: RajalTindakanRow) => (row.nama_tindakan ?? '').toUpperCase();
  const verdict = verifyRajalTreatmentGroups(allRows.map((row) => row.nama_tindakan ?? ''), rules.groups, rules.skipTreatments);
  if (!verdict.ok && verdict.kind === 'skip') {
    return { ok: false, severity: 'hard', reason: `Excluded treatment found on ${trx}: "${verdict.keyword}" (found: "${verdict.found}")` };
  }
  if (!verdict.ok) {
    return {
      ok: false,
      severity: 'hard',
      reason: `Required treatment group ${verdict.group} unsatisfied on ${trx}: none of ${verdict.expected
        .map((item) => `"${item}"`)
        .join(' OR ')} billed`,
    };
  }
  const excludedRows = allRows.filter((row) => rules.exclude.some((keyword) => name(row).includes(keyword)));
  if (excludedRows.length > 0) {
    return { ok: false, severity: 'hard', reason: `Excluded treatment found on ${trx}: ${excludedRows.map((row) => row.nama_tindakan ?? '(tanpa nama)').join(', ')}` };
  }
  const rows = allRows.filter((row) => rules.include.length === 0 || rules.include.some((keyword) => name(row).includes(keyword)));
  if (rules.minCount && rows.length < rules.minCount) {
    return { ok: false, severity: 'hard', reason: `Only ${rows.length}/${allRows.length} treatment row(s) matched on ${trx}; minimum ${rules.minCount}` };
  }
  if (rows.length === 0) {
    return { ok: false, severity: 'review', reason: allRows.length === 0 ? `Tidak ada tindakan pada ${trx}` : `Tidak ada tindakan yang cocok dengan aturan pada ${trx}` };
  }
  return { ok: true, rows };
}
