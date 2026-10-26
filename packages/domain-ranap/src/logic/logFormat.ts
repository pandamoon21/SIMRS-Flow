/**
 * Operator log formatting.
 *
 * The legacy `ranap_v3.py` prints a very specific shape that the ward's
 * billing operators read top to bottom — section headings, `+ ` sub-blocks,
 * and label/value pairs whose colons line up so a column of values can be
 * scanned at a glance. `docs/legacy/ranap-log-format.md` records the target
 * output verbatim; this module reproduces it so the run console shows the
 * same thing the operators already know how to read.
 *
 * Two rules from the legacy spec are encoded here rather than left to each
 * executor:
 *  - identifiers that only matter when debugging (`no reg`, `no trx`, the SEP
 *    source) are marked `debugOnly` and disappear unless the run asked for
 *    debug output;
 *  - a blank value renders as `-`, never as an empty column.
 */

/** One label/value pair inside a data block. */
export interface LogItem {
  label: string;
  value: unknown;
  /** Hidden unless the run is in debug mode (legacy `DEBUG_MODE` gate). */
  debugOnly?: boolean;
}

export interface DataBlockOptions {
  /** Bullet line above the pairs, e.g. `+ Data:`. Omit for a bare block. */
  bullet?: string;
  /** Leading whitespace applied to every line. */
  indent?: string;
  /** When false, `debugOnly` items are dropped. */
  debug?: boolean;
  /** Force a label column width; defaults to the widest visible label. */
  labelWidth?: number;
}

const VALUE_PLACEHOLDER = '-';

/** Render a value the way the legacy log does: trimmed, `-` when empty. */
export function logValue(value: unknown): string {
  if (value === undefined || value === null) return VALUE_PLACEHOLDER;
  if (typeof value === 'boolean') return value ? 'Ya' : 'Tidak';
  if (Array.isArray(value)) {
    const parts = value.map((entry) => logValue(entry)).filter((entry) => entry !== VALUE_PLACEHOLDER);
    return parts.length > 0 ? parts.join(', ') : VALUE_PLACEHOLDER;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : VALUE_PLACEHOLDER;
}

/**
 * Build an aligned `label : value` block.
 *
 * ```
 * + Data:
 *     - No RM         : 012345
 *     - Nama pasien   : PASIEN SATU
 * ```
 */
export function dataBlock(items: readonly LogItem[], options: DataBlockOptions = {}): string[] {
  const { bullet, indent = '', debug = false, labelWidth } = options;
  const visible = items.filter((item) => debug || !item.debugOnly);
  if (visible.length === 0) return bullet ? [`${indent}${bullet}`] : [];

  const width = labelWidth ?? Math.max(...visible.map((item) => item.label.length));
  const lines: string[] = [];
  if (bullet) lines.push(`${indent}${bullet}`);
  const pairIndent = bullet ? `${indent}    ` : indent;
  for (const item of visible) {
    lines.push(`${pairIndent}- ${item.label.padEnd(width)} : ${logValue(item.value)}`);
  }
  return lines;
}

/** A top-level step heading, e.g. `Mencari kunjungan yang bisa diproses...`. */
export function sectionHeading(text: string): string {
  return text;
}

/**
 * A numbered entry heading with its own aligned sub-pairs, used for the
 * per-visit and per-room listings:
 *
 * ```
 *     1. Unit         : RUANG MULTAZAM
 *        Tgl masuk    : 2026-06-10
 * ```
 */
export function numberedBlock(
  index: number,
  items: readonly LogItem[],
  options: DataBlockOptions = {},
): string[] {
  const { indent = '    ', debug = false, labelWidth } = options;
  const visible = items.filter((item) => debug || !item.debugOnly);
  if (visible.length === 0) return [];

  const width = labelWidth ?? Math.max(...visible.map((item) => item.label.length));
  const prefix = `${index}. `;
  const continuation = ' '.repeat(prefix.length);
  return visible.map((item, position) => {
    const lead = position === 0 ? prefix : continuation;
    return `${indent}${lead}${item.label.padEnd(width)} : ${logValue(item.value)}`;
  });
}

/**
 * The legacy `_log_step_status` one-liner. `reg` and `trx` are debug-only
 * identifiers, so they appear only when the run asked for them.
 */
export function stepStatus(args: {
  step: string;
  status: string;
  reg?: string;
  trx?: string;
  detail?: string;
  debug?: boolean;
}): string {
  const parts = [`${args.step}: ${args.status}`];
  if (args.debug && args.reg) parts.push(`reg=${args.reg}`);
  if (args.debug && args.trx) parts.push(`trx=${args.trx}`);
  if (args.detail) parts.push(args.detail);
  return parts.join(' | ');
}

/** An indented `+ ` sub-bullet with no value column. */
export function bulletLine(text: string, indent = '   '): string {
  return `${indent}+ ${text}`;
}
