/**
 * Shared controls for the data tables: pager (top and bottom, jump to page),
 * print menu (columns; paper and orientation are the print dialog's) and the XLSX download.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/primitives.js';
import { toast } from '../../ui/toast.js';
import { parsePageInput, type PageWindow, type PerPage } from './paging.js';
import {
  buildPrintHtml,
  loadPrintOptions,
  openPrint,
  savePrintOptions,
  type PrintDoc,
  type PrintOptions,
} from './print.js';
import { buildXlsx, type XlsxCell } from './xlsx.js';

export const PER_PAGE_OPTIONS = [25, 50, 100, 250] as const;

export function Pager({ win, total, perPage, onPage, onPerPage, label }: {
  win: PageWindow;
  total: number;
  perPage: PerPage;
  onPage: (page: number) => void;
  onPerPage?: (perPage: PerPage) => void;
  /** Accessible name, e.g. "Navigasi halaman atas". */
  label: string;
}) {
  const [draft, setDraft] = useState(String(win.page));
  useEffect(() => setDraft(String(win.page)), [win.page]);
  const go = () => {
    const next = parsePageInput(draft, win.pageCount);
    if (next === undefined) setDraft(String(win.page));
    else onPage(next);
  };
  const first = total === 0 ? 0 : win.start + 1;
  return (
    <nav className="table-pager" aria-label={label}>
      <span className="table-pager-info">{first}–{win.end} dari {total}</span>
      {win.pageCount > 1 ? (
        <div className="table-pager-controls">
          <button type="button" className="rekap-page-btn" disabled={win.page <= 1} onClick={() => onPage(1)} aria-label="Halaman pertama">«</button>
          <button type="button" className="rekap-page-btn" disabled={win.page <= 1} onClick={() => onPage(win.page - 1)} aria-label="Halaman sebelumnya">‹</button>
          <label className="table-pager-jump">
            <span>Hal</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={win.pageCount}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={go}
              onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
              aria-label={`Ke halaman (1–${win.pageCount})`}
            />
            <span>/ {win.pageCount}</span>
          </label>
          <button type="button" className="rekap-page-btn" disabled={win.page >= win.pageCount} onClick={() => onPage(win.page + 1)} aria-label="Halaman berikutnya">›</button>
          <button type="button" className="rekap-page-btn" disabled={win.page >= win.pageCount} onClick={() => onPage(win.pageCount)} aria-label="Halaman terakhir">»</button>
        </div>
      ) : null}
      {onPerPage ? (
        <label className="table-pager-size">
          <span className="visually-hidden">Baris per halaman</span>
          <select value={String(perPage)} onChange={(e) => onPerPage(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            {PER_PAGE_OPTIONS.map((n) => <option key={n} value={String(n)}>{n}/hal</option>)}
            <option value="all">Semua</option>
          </select>
        </label>
      ) : null}
    </nav>
  );
}

/** "Cetak / PDF" with column choices, remembered per page (`scope`); paper and orientation are the print dialog's. */
export function PrintMenu({ scope, doc, disabled }: { scope: string; doc: () => PrintDoc; disabled?: boolean }) {
  const [opts, setOpts] = useState<PrintOptions>(() => loadPrintOptions(scope));
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // Close on a click outside the menu or on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const columns = open ? doc().columns : [];
  const update = (next: PrintOptions) => { setOpts(next); savePrintOptions(scope, next); };
  const print = () => {
    const html = buildPrintHtml(doc(), opts, new Date().toLocaleString('id-ID'));
    if (!openPrint(html)) toast('danger', 'Jendela cetak diblokir browser — izinkan pop-up untuk halaman ini.');
    setOpen(false);
  };
  return (
    <div className="print-menu" ref={boxRef}>
      <Button color="secondary" variant="outline" size="sm" disabled={disabled} aria-expanded={open} onClick={() => setOpen((v) => !v)}>Cetak / PDF ▾</Button>
      {open ? (
        <div className="print-menu-pop" role="dialog" aria-label="Pengaturan cetak">
          <fieldset className="print-menu-cols">
            <legend>Kolom dicetak</legend>
            {columns.map((c) => (
              <label key={c.key}>
                <input
                  type="checkbox"
                  checked={!opts.hidden.includes(c.key)}
                  onChange={(e) => update({ ...opts, hidden: e.target.checked ? opts.hidden.filter((k) => k !== c.key) : [...opts.hidden, c.key] })}
                /> {c.label}
              </label>
            ))}
          </fieldset>
          <small>Kertas dan orientasi dipilih di dialog cetak browser. Banyak kolom di potret membuat huruf mengecil; pakai lanskap atau kurangi kolom.</small>
          <div className="print-menu-actions">
            <Button color="secondary" variant="ghost" size="sm" onClick={() => setOpen(false)}>Batal</Button>
            <Button color="primary" size="sm" onClick={print}>Cetak</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function downloadXlsx(fileStem: string, sheet: string, header: readonly string[], body: readonly (readonly XlsxCell[])[], widths?: readonly number[]): void {
  const bytes = buildXlsx(sheet, header, body, widths);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileStem}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  toast('success', `XLSX diunduh · ${body.length} baris`);
}
