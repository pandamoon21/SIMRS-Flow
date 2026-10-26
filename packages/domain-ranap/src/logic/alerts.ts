/**
 * Per-run alert / sync-issue registry ported from `ranap_v3.py`.
 *
 * The Python keeps two module-level dicts keyed by `no_registrasikunjungan`
 * (`_SYNC_ISSUES_BY_REG`, `_REG_ALERTS_BY_REG`) and mutates them from anywhere
 * in the pipeline. That is process-global state, which a replayable workflow
 * run cannot own. This port packages the same behaviour as `RunAlerts`, an
 * instantiable registry: one per run, so two concurrent runs never see each
 * other's alerts and a replay starts from an empty registry.
 *
 * Storage is faithful to the Python: both buckets hold the *composed strings*
 * (`"phase: detail"` and `"LEVEL: message"`) because de-duplication in the
 * legacy code happens on the composed form. The typed accessors split those
 * strings back apart on read.
 */

/** Alert severity. The Python accepts free text and uppercases it. */
export type AlertLevel = 'INFO' | 'WARN' | 'ERROR';

/** A parsed `_REG_ALERTS_BY_REG` entry. */
export interface RegAlert {
  level: AlertLevel;
  message: string;
}

/** A parsed `_SYNC_ISSUES_BY_REG` entry. */
export interface SyncIssue {
  phase: string;
  detail: string;
}

/** The data `_emit_pre_verification_summary` prints, as data. */
export interface PreVerificationSummary {
  lines: string[];
  blocking: string[];
  hasBlocker: boolean;
}

/** Max length the Python truncates an entry to before storing it. */
const MAX_ENTRY_LENGTH = 240;

/** `_get_sync_issue_summary(..., limit=3)`. */
const SYNC_ISSUE_SUMMARY_LIMIT = 3;

/** `_get_reg_alert_summary(..., limit=5)`. */
const REG_ALERT_SUMMARY_LIMIT = 5;

/** `_emit_pre_verification_summary` previews at most 6 sync issues. */
const SUMMARY_SYNC_PREVIEW_LIMIT = 6;

/** ...and at most 10 alerts per level. */
const SUMMARY_ALERT_PREVIEW_LIMIT = 10;

/** Levels the summary emits first, in this order (`_emit_pre_verification_summary`). */
const SUMMARY_LEVEL_ORDER: readonly AlertLevel[] = ['WARN', 'ERROR', 'INFO'];

/** `_register_verification_blocker` prefixes every manual blocker with this. */
const MANUAL_BLOCKER_PREFIX = 'ERROR: Blocker verifikasi manual';

/**
 * `_clean_notice_text` — legacy write endpoints answer with a one-line notice
 * followed by a full HTML error page; keep only the notice.
 *
 * Exported because every operator-facing message in the port goes through it
 * (see `normalizePenunjangBlocker` in `./blockers.ts`).
 */
export function cleanNoticeText(text: unknown): string {
  let txt = text === undefined || text === null ? '' : String(text).trim();
  for (const marker of ['\n<!DOCTYPE', '<!DOCTYPE', '\n<div style=', '<div style=']) {
    const at = txt.indexOf(marker);
    if (at >= 0) txt = txt.slice(0, at).trim();
  }
  return txt;
}

/** Python's `str(value or "").strip()`. */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Python's `str.partition(": ")` — split on the FIRST occurrence only. */
function partition(value: string, sep: string): [string, string, string] {
  const at = value.indexOf(sep);
  if (at < 0) return [value, '', ''];
  return [value.slice(0, at), sep, value.slice(at + sep.length)];
}

/** `"{label:<9}: {value}"` from `_log_sync_detail_block`. */
function detailLine(label: string, value: unknown): string {
  const labelText = (text(label) || '-').padEnd(9, ' ');
  const valueText = value === undefined || value === null ? '-' : text(value) || '-';
  return `  ${labelText}: ${valueText}`;
}

/** `_log_sync_detail_block`, rendered to lines instead of stdout. */
function syncDetailBlock(
  title: string,
  details: ReadonlyArray<readonly [string, unknown]>,
  listGroups: ReadonlyArray<readonly [string, readonly string[]]> = [],
): string[] {
  const lines: string[] = [`- ${title}`];
  for (const [label, value] of details) lines.push(detailLine(label, value));
  for (const [label, values] of listGroups) {
    const labelText = (text(label) || '-').padEnd(9, ' ');
    const normalized = values.map((item) => text(item)).filter((item) => item.length > 0);
    if (normalized.length === 0) {
      lines.push(`  ${labelText}: -`);
      continue;
    }
    lines.push(`  ${labelText}:`);
    for (const item of normalized) lines.push(`    - ${item}`);
  }
  return lines;
}

/** `_get_blocking_reg_alerts` — the only three shapes that block verification. */
function isBlockingEntry(entry: string): boolean {
  return (
    entry.startsWith(MANUAL_BLOCKER_PREFIX) ||
    entry === 'ERROR: Grand total kasir dan rekapitulasi belum balance' ||
    entry.startsWith('ERROR: IBS mismatch')
  );
}

function normalizeLevel(value: unknown): AlertLevel {
  const upper = text(value).toUpperCase();
  if (upper === 'ERROR' || upper === 'INFO' || upper === 'WARN') return upper;
  return 'WARN';
}

/**
 * A run-scoped replacement for `_SYNC_ISSUES_BY_REG` / `_REG_ALERTS_BY_REG`.
 *
 * Every method matches its `_`-prefixed Python counterpart, including the
 * default limits and the overflow suffixes ("+N issue lain" / "+N alert lain")
 * that end up in operator-facing text.
 */
export class RunAlerts {
  private readonly syncIssues = new Map<string, string[]>();

  private readonly regAlerts = new Map<string, string[]>();

  /** `_register_sync_issue`. Empty reg is ignored; phase defaults to "sync". */
  registerSyncIssue(reg: string, phase: string, detail = ''): void {
    const key = text(reg);
    if (!key) return;
    const phaseText = text(phase) || 'sync';
    const detailText = detail ? cleanNoticeText(detail) : '';
    const entry = detailText ? `${phaseText}: ${detailText}` : phaseText;
    const bucket = this.syncIssues.get(key) ?? [];
    if (!this.syncIssues.has(key)) this.syncIssues.set(key, bucket);
    // The Python de-duplicates on the untruncated entry but stores the
    // truncated one; keep that so counts match the legacy logs byte for byte.
    if (!bucket.includes(entry)) bucket.push(entry.slice(0, MAX_ENTRY_LENGTH));
  }

  /** `_register_reg_alert`. Empty reg or empty (cleaned) message is ignored. */
  registerRegAlert(reg: string, level: AlertLevel, message: string): void {
    const key = text(reg);
    if (!key) return;
    const levelText = text(level).toUpperCase() || 'WARN';
    const messageText = cleanNoticeText(message);
    if (!messageText) return;
    const entry = `${levelText}: ${messageText.slice(0, MAX_ENTRY_LENGTH)}`;
    const bucket = this.regAlerts.get(key) ?? [];
    if (!this.regAlerts.has(key)) this.regAlerts.set(key, bucket);
    if (!bucket.includes(entry)) bucket.push(entry);
  }

  /** `_register_verification_blocker` — an ERROR alert with the blocking prefix. */
  registerVerificationBlocker(reg: string, detail: string): void {
    const key = text(reg);
    const detailText = cleanNoticeText(detail);
    if (!key || !detailText) return;
    this.registerRegAlert(key, 'ERROR', `Blocker verifikasi manual | ${detailText}`);
  }

  /** `_has_sync_issues`. */
  hasSyncIssues(reg: string): boolean {
    return (this.syncIssues.get(text(reg))?.length ?? 0) > 0;
  }

  /** `_SYNC_ISSUES_BY_REG.get(reg)`, split into phase/detail pairs. */
  getSyncIssues(reg: string): SyncIssue[] {
    return this.rawSyncIssues(reg).map((entry) => {
      const [phase, sep, detail] = partition(entry, ': ');
      return sep ? { phase: phase.trim(), detail: detail.trim() } : { phase: entry, detail: '' };
    });
  }

  /** `_get_sync_issue_summary` (default limit 3). */
  getSyncIssueSummary(reg: string, limit: number = SYNC_ISSUE_SUMMARY_LIMIT): string {
    const items = this.rawSyncIssues(reg);
    if (items.length === 0) return '';
    let summary = items.slice(0, limit).join('; ');
    if (items.length > limit) summary += `; +${items.length - limit} issue lain`;
    return summary;
  }

  /** `_get_reg_alerts`, split into level/message pairs. */
  getRegAlerts(reg: string): RegAlert[] {
    return this.rawRegAlerts(reg).map((entry) => {
      const [level, sep, message] = partition(entry, ': ');
      return {
        level: normalizeLevel(sep ? level : 'WARN'),
        message: (sep ? message : entry).trim(),
      };
    });
  }

  /** `_get_reg_alert_summary` (default limit 5) over the raw "LEVEL: msg" entries. */
  getRegAlertSummary(reg: string, limit: number = REG_ALERT_SUMMARY_LIMIT): string {
    const items = this.rawRegAlerts(reg);
    if (items.length === 0) return '';
    let summary = items.slice(0, limit).join('; ');
    if (items.length > limit) summary += `; +${items.length - limit} alert lain`;
    return summary;
  }

  /** `_get_blocking_reg_alerts` — raw entries, so callers can print them as-is. */
  getBlockingRegAlerts(reg: string): string[] {
    return this.rawRegAlerts(reg).filter((entry) => isBlockingEntry(entry));
  }

  /** `_reset_sync_issues`. No reg (or an empty one) clears every reg. */
  resetSyncIssues(reg = ''): void {
    const key = text(reg);
    if (!key) {
      this.syncIssues.clear();
      return;
    }
    this.syncIssues.delete(key);
  }

  /** `_reset_reg_alerts`. No reg (or an empty one) clears every reg. */
  resetRegAlerts(reg = ''): void {
    const key = text(reg);
    if (!key) {
      this.regAlerts.clear();
      return;
    }
    this.regAlerts.delete(key);
  }

  /**
   * `_emit_pre_verification_summary`, returned instead of printed.
   *
   * `lines` reproduces the `_log_sync_detail_block` output verbatim so the
   * console/ledger keeps the operator-facing wording; `blocking` and
   * `hasBlocker` are the decision the caller acts on.
   */
  buildPreVerificationSummary(reg: string): PreVerificationSummary {
    const key = text(reg);
    const regLabel = key || '-';
    const syncItems = this.rawSyncIssues(key);
    const alertItems = this.rawRegAlerts(key);
    const blocking = this.getBlockingRegAlerts(key);

    if (syncItems.length === 0 && alertItems.length === 0) {
      return {
        lines: syncDetailBlock('Summary sebelum verifikasi', [
          ['Reg', regLabel],
          ['Status', 'normal'],
          ['Issue', 0],
          ['Alert', 0],
        ]),
        blocking,
        hasBlocker: blocking.length > 0,
      };
    }

    const warnCount = alertItems.filter((item) => item.startsWith('WARN:')).length;
    const errorCount = alertItems.filter((item) => item.startsWith('ERROR:')).length;
    const lines = syncDetailBlock('Summary sebelum verifikasi', [
      ['Reg', regLabel],
      ['Sync issue', syncItems.length],
      ['Alert', alertItems.length],
      ['Warn', warnCount],
      ['Error', errorCount],
    ]);

    if (syncItems.length > 0) {
      lines.push(
        ...syncDetailBlock(
          'Sync issue',
          [
            ['Reg', regLabel],
            ['Count', syncItems.length],
          ],
          [['Detail', withOverflow(syncItems, SUMMARY_SYNC_PREVIEW_LIMIT, 'issue')]],
        ),
      );
    }

    const grouped = new Map<string, string[]>();
    for (const entry of alertItems) {
      const [level, sep, detail] = partition(entry, ': ');
      const levelText = text(sep ? level : 'WARN').toUpperCase() || 'WARN';
      const detailText = (sep ? detail : entry).trim() || '-';
      const bucket = grouped.get(levelText) ?? [];
      if (!grouped.has(levelText)) grouped.set(levelText, bucket);
      bucket.push(detailText);
    }

    // Known levels first in WARN/ERROR/INFO order, then anything unexpected.
    const emitted: string[] = [];
    for (const level of SUMMARY_LEVEL_ORDER) {
      const items = grouped.get(level);
      if (!items || items.length === 0) continue;
      emitted.push(level);
      lines.push(...alertLevelBlock(level, regLabel, items));
    }
    for (const [level, items] of grouped) {
      if (emitted.includes(level) || items.length === 0) continue;
      lines.push(...alertLevelBlock(level, regLabel, items));
    }

    return { lines, blocking, hasBlocker: blocking.length > 0 };
  }

  private rawSyncIssues(reg: string): string[] {
    return [...(this.syncIssues.get(text(reg)) ?? [])];
  }

  private rawRegAlerts(reg: string): string[] {
    return [...(this.regAlerts.get(text(reg)) ?? [])];
  }
}

/** `items[:limit] + ["+N <noun> lain"]` — the legacy preview shape. */
function withOverflow(items: readonly string[], limit: number, noun: string): string[] {
  const preview = items.slice(0, limit);
  if (items.length > limit) preview.push(`+${items.length - limit} ${noun} lain`);
  return preview;
}

/** One `Warn` / `Error` / `Info` block of `_emit_pre_verification_summary`. */
function alertLevelBlock(level: string, regLabel: string, items: readonly string[]): string[] {
  return syncDetailBlock(
    titleCase(level) || 'Warn',
    [
      ['Reg', regLabel],
      ['Count', items.length],
    ],
    [['Detail', withOverflow(items, SUMMARY_ALERT_PREVIEW_LIMIT, 'alert')]],
  );
}

/** Python's `str.title()` for the single-word level names. */
function titleCase(value: string): string {
  return value.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}
