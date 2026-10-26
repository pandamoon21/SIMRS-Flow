/**
 * Scalar/text helpers ported from `ranap_v3.py`.
 *
 * These are the coercions the legacy script sprinkles over every response:
 * numbers that arrive as `"1.250.000"`, JSON that arrives as a string, unit and
 * tindakan names that must be compared after being flattened to a key, and the
 * two operator inputs (no RM, tanggal) that are validated up front and refused
 * loudly. Everything here is deterministic and side-effect free; the input
 * normalizers throw with the exact Indonesian message the Python raised, since
 * that text reaches the operator.
 */

import type { LegacyRow } from './types.js';
import { str } from './types.js';
import { parseDateFlexible, parseDateTimeFlexible, datePart } from './dates.js';

/** HTML entities `html.unescape` resolves that actually show up in SIMRS markup. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
};

// ── numbers ──────────────────────────────────────────────────────

/**
 * `_safe_int` — `int(str(value).strip())` with a fallback instead of a raise.
 *
 * Deliberately strict: only a whole number (with optional sign) parses, so
 * `"3.5"`, `"1e3"`, `"0x10"`, `null` and `undefined` all give `fallback`.
 */
export function safeInt(value: unknown, fallback = 0): number {
  // Python stringifies unconditionally here (`str(value)`, not `str(value or "")`).
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  return Number(text);
}

/**
 * `_parse_currency_int` — strip everything that is not a digit or `-`, then read
 * an integer. That means Indonesian thousands separators simply vanish
 * ("Rp 1.250.000" → 1250000), and so does a decimal comma ("1.250,50" →
 * 125050) — the legacy behaviour, kept because the callers compare the result
 * against equally-mangled values from the same endpoints.
 */
export function parseCurrencyInt(value: unknown, fallback = 0): number {
  const cleaned = (value ? String(value) : '').replace(/[^\d-]+/g, '');
  if (!cleaned || cleaned === '-') return fallback;
  if (!/^-?\d+$/.test(cleaned)) return fallback; // e.g. "1-2", "--5" → int() would raise
  return Number(cleaned);
}

// ── text keys ────────────────────────────────────────────────────

/**
 * `_normalize_text_key` — uppercase, and every run of non-alphanumerics becomes
 * a single space. The comparison form for names that differ only in
 * punctuation ("R. INAP/VIP-1" → "R INAP VIP 1").
 */
export function normalizeTextKey(value: unknown): string {
  return (value ? String(value) : '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * `_compact_text_key` — as above but with the separators removed entirely
 * ("BY. NY. SITI" → "BYNYSITI"). Used where spacing is unreliable.
 */
export function compactTextKey(value: unknown): string {
  return (value ? String(value) : '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .trim();
}

/**
 * `_parse_json_text` — accept a value that is either already decoded or still a
 * JSON string. Objects and arrays pass straight through; anything unparseable
 * (or empty) gives `fallback`, which is `undefined` unless supplied.
 */
export function parseJsonText<T = unknown>(value: unknown, fallback?: T): T | undefined {
  if (Array.isArray(value)) return value as unknown as T;
  if (typeof value === 'object' && value !== null) return value as T;
  const text = value ? String(value).trim() : '';
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ── rows ─────────────────────────────────────────────────────────

/**
 * `_sorted_rows` — chronological by `tgl_jam`/`tgl_transaksi`, then by
 * `urut_tindakan`, then stable in input order. Rows with no readable date sort
 * last (the Python uses `datetime.max` as the sentinel); this ordering is what
 * makes the billing-line diffs reproducible, so keep the tie-breaks.
 */
export function sortedRows(rows: readonly LegacyRow[]): LegacyRow[] {
  const decorated = rows.map((row, index) => ({
    row,
    index,
    time: rowSortTime(row),
    urut: safeInt(row['urut_tindakan'], 0),
  }));
  decorated.sort(
    (left, right) =>
      compareNumbers(left.time, right.time) ||
      compareNumbers(left.urut, right.urut) ||
      left.index - right.index,
  );
  return decorated.map((entry) => entry.row);
}

/** `_row_log_label` — the one-line audit form of a billing row. */
export function rowLogLabel(row: LegacyRow): string {
  const nama = str(row, 'nama_tindakan') || '-';
  const kd = str(row, 'kd_tindakan') || '-';
  const urut = str(row, 'urut_tindakan') || '-';
  const tanggal = str(row, 'tgl_jam', 'tgl_transaksi') || '-';
  const qty = str(row, 'qty') || '-';
  const harga = str(row, 'harga') || '-';
  return `nama=${nama}, kd=${kd}, urut=${urut}, tgl=${tanggal}, qty=${qty}, harga=${harga}`;
}

/** `_rows_log_label` — several `rowLogLabel`s on one line. */
export function rowsLogLabel(rows: readonly LegacyRow[]): string {
  return rows.map((row) => rowLogLabel(row)).join(' || ');
}

// ── operator input ───────────────────────────────────────────────

/**
 * `_normalize_no_rm_input` — canonicalise a medrec to `0-12-34-56`.
 *
 * Accepts 6 digits (a leading zero is added) or 7 starting with zero, with
 * space/dash/dot/slash separators anywhere. Throws the operator-facing
 * Indonesian message on anything else — letters are called out separately
 * because pasting a name into the field is the common mistake.
 */
export function normalizeNoRmInput(raw: unknown): string {
  const text = raw ? String(raw).trim() : '';
  if (!text) {
    throw new Error('No RM kosong.');
  }
  if (/[A-Za-z]/.test(text)) {
    throw new Error(
      'No RM tidak boleh mengandung huruf. Gunakan format seperti 123456, 0123456, atau 0-12-34-56.',
    );
  }
  if (/[^0-9\s\-./]/.test(text)) {
    throw new Error(
      'Format No RM tidak dikenali. Gunakan angka dengan separator umum seperti spasi, strip, slash, atau titik.',
    );
  }
  let digits = text.replace(/\D/g, '');
  if (digits.length === 6) digits = `0${digits}`;
  if (digits.length !== 7 || !digits.startsWith('0')) {
    throw new Error(
      'No RM harus berisi 6 digit tanpa nol depan atau 7 digit dengan nol depan. Contoh valid: 123456, 0123456, 0-12-34-56.',
    );
  }
  return `${digits.slice(0, 1)}-${digits.slice(1, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`;
}

/**
 * `_normalize_tanggal_input` — canonicalise an operator date to `YYYY-MM-DD`.
 *
 * Eight bare digits are read as `YYYYMMDD` first and `DDMMYYYY` second (so
 * "10032026" is the 10th of March, not the 3rd of October); anything else goes
 * through the flexible date parser. Throws when nothing matches.
 */
export function normalizeTanggalInput(raw: unknown): string {
  const text = raw ? String(raw).trim() : '';
  if (!text) {
    throw new Error('Tanggal kosong.');
  }
  const digits = text.replace(/\D/g, '');
  if (digits.length === 8) {
    // 4-2-2 then 2-2-4 — the only two splits `%Y%m%d`/`%d%m%Y` can consume.
    const candidates = [
      `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`,
      `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 8)}`,
    ];
    for (const candidate of candidates) {
      if (parseDateFlexible(candidate)) return datePart(candidate);
    }
  }
  if (parseDateFlexible(text)) return datePart(text);
  throw new Error(
    'Format tanggal tidak dikenali. Gunakan format seperti 2026-03-10, 20260310, atau 10-03-2026.',
  );
}

// ── HTML ─────────────────────────────────────────────────────────

/**
 * `_strip_html_text` — markup to a single line of text.
 *
 * `<script>`/`<style>` bodies go first, then all tags, then entities are
 * resolved (in that order, so `&lt;b&gt;` cannot become a tag), then whitespace
 * collapses. Entity coverage is the common set plus numeric references, not
 * Python's full HTML5 table.
 */
export function stripHtmlText(html: unknown): string {
  let cleaned = html ? String(html) : '';
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = unescapeHtml(cleaned);
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * `_extract_textarea_text` — the text of the first `<textarea>` (optionally the
 * one with a given `id`), stripped. `''` when there is no such element: callers
 * treat an empty CPPT/anamnesa the same as a missing one.
 */
export function extractTextareaText(html: string, textareaId?: string): string {
  const text = html ? String(html) : '';
  if (!text) return '';
  const pattern = textareaId
    ? new RegExp(
        `<textarea\\b[^>]*id=["']${escapeRegExp(textareaId)}["'][^>]*>([\\s\\S]*?)</textarea>`,
        'i',
      )
    : /<textarea\b[^>]*>([\s\S]*?)<\/textarea>/i;
  const match = pattern.exec(text);
  if (!match) return '';
  return stripHtmlText(match[1] ?? '');
}

// ── internals ────────────────────────────────────────────────────

/** Sort key for `sortedRows`: epoch ms, or `+Infinity` for `datetime.max`. */
function rowSortTime(row: LegacyRow): number {
  const parsed = parseDateTimeFlexible(str(row, 'tgl_jam', 'tgl_transaksi'));
  return parsed ? parsed.getTime() : Number.POSITIVE_INFINITY;
}

/** Subtraction-free compare, so two `+Infinity` keys tie instead of yielding NaN. */
function compareNumbers(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** The common named entities plus `&#NN;`/`&#xNN;`; unknown entities are left alone. */
function unescapeHtml(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
