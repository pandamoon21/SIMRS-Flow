/**
 * Log "Per pasien": one card per patient of a batch run (rajal can hold hundreds),
 * built from the checklist items each step tagged with the patient's No. RM.
 * Filter by outcome, search, page, and export the list (typically: the dilewati
 * ones, to fix in SIMRS). A card opens on its step-by-step trail when there is
 * something to read (dilewati, a note, a planned write); a clean lolos stays one line.
 */
import { useMemo, useState } from 'react';
import { checkMark, PATIENT_STATUS_LABEL, type PatientStatus, type PatientTrail } from '../panels/terminalLog.js';
import { downloadXlsx, Pager } from '../table/TableKit.js';
import { pageWindow, type PerPage } from '../table/paging.js';
import { logMatches } from '../panels/logView.js';
import { Button } from '../../ui/primitives.js';

type Filter = 'all' | PatientStatus | 'notes';
const FILTERS: Array<[Filter, string]> = [['all', 'Semua'], ['dilewati', 'Dilewati'], ['lolos', 'Lolos'], ['proses', 'Diproses'], ['notes', 'Ada catatan']];

export function filterPatients(rows: readonly PatientTrail[], filter: Filter, query: string): PatientTrail[] {
  return rows.filter((row) => (filter === 'all' || (filter === 'notes' ? row.notes > 0 : row.status === filter))
    && (!query.trim() || logMatches(`${row.rm} ${row.reason} ${row.step} ${row.trail.map((t) => t.item.label).join(' ')}`, query)));
}

/** An item's label inside its patient's card: the card header already names the No. RM. */
export function withoutRm(label: string, rm: string): string {
  const parts = label.split(' · ').filter((part) => part.trim() !== rm);
  return parts.length ? parts.join(' · ') : label;
}

/** What Ringkas keeps of a trail: ✗, planned writes and open (•) items; the ✓ ones become one count. */
export function compactTrail(trail: PatientTrail['trail']): { shown: PatientTrail['trail']; passed: number } {
  const shown = trail.filter((t) => t.item.ok !== true || t.item.planId);
  return { shown, passed: trail.length - shown.length };
}

/** Above this many patients the list opens in Ringkas. */
const COMPACT_FROM = 10;

export function PatientLog({ patients, runId, onOpenNode }: { patients: readonly PatientTrail[]; runId?: string; onOpenNode: (nodeId: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<PerPage>(50);
  const [compactPick, setCompactPick] = useState<boolean>();
  const compact = compactPick ?? patients.length > COMPACT_FROM;
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([key]) => [key, filterPatients(patients, key, '').length])), [patients]);
  const rows = useMemo(() => filterPatients(patients, filter, query), [patients, filter, query]);
  const win = pageWindow(rows.length, perPage, page);
  const exportXlsx = () => downloadXlsx(
    `pasien-${runId ?? 'run'}-${filter}`,
    'Pasien',
    ['No', 'No. RM', 'Status', 'Tahap', 'Alasan / catatan', 'Catatan', 'Write'],
    rows.map((row, i) => [i + 1, row.rm, PATIENT_STATUS_LABEL[row.status], row.step, row.reason, row.notes, row.writes]),
    [6, 14, 10, 24, 60, 9, 7],
  );

  return (
    <div className="pl-view">
      <div className="pl-toolbar">
        <div className="pl-filters" role="group" aria-label="Saring status pasien">
          {FILTERS.map(([key, label]) => (
            <button type="button" key={key} className="pl-filter" data-filter={key} aria-pressed={filter === key} onClick={() => { setFilter(key); setPage(1); }}>
              {label} <b>{counts[key]}</b>
            </button>
          ))}
        </div>
        <input className="form-control pl-search" type="search" placeholder="Cari No. RM / no transaksi / alasan…" aria-label="Cari pasien" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
        <Button color={compact ? 'info' : 'secondary'} variant={compact ? undefined : 'outline'} size="sm" aria-pressed={compact} onClick={() => setCompactPick(!compact)} title="Ringkas: satu baris per pasien, hanya cek yang bermasalah / rencana write; cek yang lolos dihitung">Ringkas</Button>
        <Button color="secondary" variant="outline" size="sm" disabled={rows.length === 0} onClick={exportXlsx} title="Unduh daftar pasien sesuai saringan">XLSX</Button>
      </div>
      <Pager label="Navigasi halaman pasien" win={win} total={rows.length} perPage={perPage} onPage={setPage} onPerPage={(next) => { setPerPage(next); setPage(1); }} />
      <div className="pl-scroll">
        {rows.slice(win.start, win.end).map((row, i) => {
          const { shown, passed } = compact ? compactTrail(row.trail) : { shown: row.trail, passed: 0 };
          return (
            <details key={`${row.rm}:${compact}`} className="pl-card" data-status={row.status} data-compact={compact ? '' : undefined}
              open={compact ? row.status === 'dilewati' : row.status !== 'lolos' || row.notes > 0 || row.writes > 0}>
              <summary className="pl-card-head">
                <span className="pl-no mono">{win.start + i + 1}</span>
                <b className="mono">{row.rm}</b>
                <span className="pl-status" data-status={row.status}>{PATIENT_STATUS_LABEL[row.status]}</span>
                {row.step ? <span className="pl-step">{row.step}</span> : null}
                {compact && row.reason ? <span className="pl-reason-inline">{row.reason}</span> : null}
                {row.notes > 0 ? <span className="pl-tag">{row.notes} catatan</span> : null}
                {row.writes > 0 ? <span className="pl-tag is-write">{row.writes} rencana write</span> : null}
                <span className="pl-count tl-muted">{row.trail.length} tahap</span>
              </summary>
              {row.reason && !compact ? <div className="pl-reason">{row.reason}</div> : null}
              <ol className="pl-trail">
                {shown.map((t, j) => (
                  <li key={j} className="tl-check" data-ok={String(t.item.ok)} onDoubleClick={() => onOpenNode(t.nodeId)} title="Klik ganda: buka tahap di Inspector">
                    <span className="tl-mark" aria-hidden="true">{checkMark(t.item)}</span>
                    <span><span className="tl-step-no">{t.index}/{t.total}</span> <b>{t.label}</b> · {withoutRm(t.item.label, row.rm)}{t.item.detail ? <span className="tl-muted"> — {t.item.detail}</span> : null}</span>
                  </li>
                ))}
                {passed > 0 ? <li className="tl-check tl-muted" data-ok="true"><span className="tl-mark" aria-hidden="true">✓</span><span>{passed} cek lain lolos — matikan Ringkas untuk rinciannya</span></li> : null}
              </ol>
            </details>
          );
        })}
        {rows.length === 0 ? <div className="empty">Tidak ada pasien untuk saringan ini.</div> : null}
      </div>
    </div>
  );
}
