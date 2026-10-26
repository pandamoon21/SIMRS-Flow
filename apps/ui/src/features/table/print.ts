/**
 * Printable table view shared by the data pages (Iur naik kelas, Rekap).
 *
 * The page opens a standalone document — no app chrome, no dark theme. Paper
 * and orientation are left to the browser's print dialog: an `@page size`
 * locks the dialog's Layout/Paper choices, and picking one there then broke
 * the preview. The font follows the column count and the orientation the
 * dialog chose (`@media print and (orientation)`), text wraps inside cells
 * (money and dates never wrap), the header row repeats on every sheet, and
 * Chrome's page-margin boxes print "Hal x / y" in the footer.
 */

export interface PrintOptions {
  /** Column keys left out of the printout. */
  hidden: string[];
}

export const DEFAULT_PRINT: PrintOptions = { hidden: [] };

/** Printable width in mm on A4 (the office default) after margins. */
const A4_PORTRAIT_MM = 210 - 20;
const A4_LANDSCAPE_MM = 297 - 20;

export interface PrintColumn {
  key: string;
  label: string;
  /** Right-aligned, never wrapped (money, counts). */
  numeric?: boolean;
  /** Never wrapped (dates, No. RM). */
  nowrap?: boolean;
}

export interface PrintDoc {
  title: string;
  subtitle?: string;
  stats?: ReadonlyArray<{ label: string; value: string }>;
  columns: readonly PrintColumn[];
  rows: ReadonlyArray<Record<string, string>>;
}

const MARGIN_MM = 10;

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Body font in pt for a printable width: about 9pt for ~8 columns on A4
 * landscape, shrinking as columns are added or the sheet narrows, never
 * below 6pt or above 10pt.
 */
export function printFontPt(widthMm: number, columnCount: number): number {
  const pt = (widthMm / Math.max(1, columnCount)) / 3.6;
  return Math.round(Math.min(10, Math.max(6, pt)) * 2) / 2;
}

export function buildPrintHtml(doc: PrintDoc, opts: PrintOptions, printedAt: string): string {
  const cols = doc.columns.filter((c) => !opts.hidden.includes(c.key));
  const font = printFontPt(A4_LANDSCAPE_MM, cols.length + 1);
  const portraitFont = printFontPt(A4_PORTRAIT_MM, cols.length + 1);
  const cls = (c: PrintColumn) => (c.numeric ? ' class="n"' : c.nowrap ? ' class="nw"' : '');
  const head = cols.map((c) => `<th${cls(c)}>${esc(c.label)}</th>`).join('');
  const body = doc.rows
    .map((r, i) => `<tr><td class="n">${i + 1}</td>${cols.map((c) => `<td${cls(c)}>${esc(r[c.key] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  const stats = (doc.stats ?? []).map((s) => `<div><span>${esc(s.label)}</span><b>${esc(s.value)}</b></div>`).join('');
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
/* No size: paper and orientation belong to the print dialog. The margin
   stands alone — browsers without page-margin boxes (Chrome < 131, common on
   office PCs) drop an @page rule that nests them. */
@page { margin: ${MARGIN_MM}mm ${MARGIN_MM}mm 12mm; }
@page {
  @bottom-left { content: "${esc(doc.title).replace(/"/g, '')} · ${esc(printedAt)}"; font: 7pt Arial, sans-serif; color: #666; }
  @bottom-right { content: "Hal " counter(page) " / " counter(pages); font: 7pt Arial, sans-serif; color: #666; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* On screen the preview is an A4-landscape sheet; on paper the body takes the
   width of whatever sheet the dialog picked. Sizes below are relative to it. */
body { max-width: ${A4_LANDSCAPE_MM}mm; margin: 0 auto; font: ${font}pt/1.3 Arial, Helvetica, sans-serif; color: #111; }
@media print { body { max-width: none; } }
@media print and (orientation: portrait) { body { font-size: ${portraitFont}pt; } }
header { margin-bottom: 3mm; }
h1 { font-size: 1.45em; margin: 0 0 1mm; }
.sub { margin: 0; color: #444; }
.stats { display: flex; flex-wrap: wrap; gap: 2mm 8mm; margin: 2mm 0 3mm; }
.stats span { display: block; color: #555; font-size: .9em; text-transform: uppercase; letter-spacing: .03em; }
.stats b { font-size: 1.2em; }
table { width: 100%; border-collapse: collapse; table-layout: auto; }
thead { display: table-header-group; }
th, td { border: 0.3mm solid #9a9a9a; padding: 0.8mm 1.2mm; vertical-align: top; text-align: left; overflow-wrap: break-word; }
/* Every header label centred, numeric and text columns alike. */
th, th.n { background: #ececec; font-weight: 700; text-align: center; vertical-align: middle; }
tbody tr:nth-child(even) td { background: #f7f7f7; }
tr { break-inside: avoid; }
.n { text-align: right; font-variant-numeric: tabular-nums; }
/* Values never wrap; header labels may, so a long label cannot widen the table. */
td.n, td.nw { white-space: nowrap; }
.screen-note { margin: 4mm 0; padding: 2mm 3mm; background: #fff8d6; border: 0.3mm solid #e0c860; font-size: 9pt; }
@media print { .screen-note { display: none; } }
</style></head><body>
<p class="screen-note">Pratinjau cetak. Pilih printer atau “Simpan sebagai PDF”, lalu atur ukuran kertas dan orientasi (potret/lanskap) di dialog cetak. Banyak kolom: pakai lanskap.</p>
<header><h1>${esc(doc.title)}</h1>${doc.subtitle ? `<p class="sub">${esc(doc.subtitle)}</p>` : ''}${stats ? `<div class="stats">${stats}</div>` : ''}</header>
<table><thead><tr><th class="n">#</th>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`;
}

/** Open the print view in a new window and start printing; false when pop-ups are blocked. */
export function openPrint(html: string): boolean {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.write(html);
  win.document.close();
  win.focus();
  // Let the layout settle (fonts, table) before the dialog snapshots it.
  win.setTimeout(() => win.print(), 250);
  return true;
}

const PRINT_KEY = 'simrs-flow.print.v1';

export function loadPrintOptions(scope: string): PrintOptions {
  try {
    const all = JSON.parse(localStorage.getItem(PRINT_KEY) ?? '{}') as Record<string, Partial<PrintOptions>>;
    const saved = all[scope] ?? {};
    return {
      hidden: Array.isArray(saved.hidden) ? saved.hidden.filter((k): k is string => typeof k === 'string') : [],
    };
  } catch {
    return { ...DEFAULT_PRINT };
  }
}

export function savePrintOptions(scope: string, opts: PrintOptions): void {
  try {
    const all = JSON.parse(localStorage.getItem(PRINT_KEY) ?? '{}') as Record<string, PrintOptions>;
    all[scope] = opts;
    localStorage.setItem(PRINT_KEY, JSON.stringify(all));
  } catch {
    /* preference only */
  }
}
