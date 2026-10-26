import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, UnauthorizedError, type NoteColor, type PresenceOperator, type StickyNote } from '../../api/client.js';
import { Button, Card, CardBody, CardHeader, Spinner } from '../../ui/primitives.js';
import { Icon } from '../../ui/icons.js';

const POLL_MS = 20_000;
const COLORS: ReadonlyArray<{ id: NoteColor; label: string }> = [
  { id: 'amber', label: 'Kuning' },
  { id: 'sky', label: 'Biru' },
  { id: 'green', label: 'Hijau' },
  { id: 'pink', label: 'Merah muda' },
];

const relTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hr lalu`;
};

const initials = (name: string): string =>
  name.split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();

export interface TeamBoardProps {
  onUnauthorized: () => void;
}

export function TeamBoard({ onUnauthorized }: TeamBoardProps) {
  const [operators, setOperators] = useState<PresenceOperator[]>([]);
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [draft, setDraft] = useState('');
  const [color, setColor] = useState<NoteColor>('amber');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [presence, noteList] = await Promise.all([api.getPresence(), api.listNotes()]);
      if (!mounted.current) return;
      setOperators(presence.operators);
      setNotes(noteList.notes);
      setError(undefined);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, [onUnauthorized]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Poll only while the tab is visible — a backgrounded tab neither wastes
    // network/CPU nor holds a live timer, and refreshes the moment it returns.
    let t: ReturnType<typeof setInterval> | undefined;
    const start = () => { if (t === undefined) t = setInterval(() => void refresh(), POLL_MS); };
    const stop = () => { if (t !== undefined) { clearInterval(t); t = undefined; } };
    const onVis = () => { if (document.hidden) stop(); else { void refresh(); start(); } };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  const self = useMemo(() => operators.find((o) => o.self)?.name, [operators]);
  const onlineCount = operators.filter((o) => o.online).length;

  async function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.addNote(text, color);
      setDraft('');
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function remove(id: string) {
    // The note fades at once; a failed delete brings it back with the error.
    setDeleting((prev) => new Set(prev).add(id));
    try {
      await api.deleteNote(id);
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setDeleting((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  return (
    <Card className="surface-card team-board">
      <CardHeader className="card-header-actions">
        <span className="team-board-title"><Icon name="users" size={16} /> Operator aktif</span>
        <span className="team-online-count"><Icon name="point" size={12} className="team-online-dot" /> {onlineCount} online</span>
      </CardHeader>
      <CardBody>
        {error ? <div className="team-error">Presensi tidak tersedia: {error}</div> : null}

        <ul className="team-roster">
          {operators.map((op) => (
            <li key={op.name} className={`team-chip${op.online ? ' is-online' : ''}${op.self ? ' is-self' : ''}`}>
              <span className="team-avatar" aria-hidden="true">{initials(op.name)}</span>
              <span className="team-chip-name">{op.name}{op.self ? ' (Anda)' : ''}</span>
              <span className={`team-chip-status${op.online ? ' is-online' : ''}`}>{op.online ? 'online' : relTime(new Date(op.lastSeenMs || Date.now()).toISOString())}</span>
            </li>
          ))}
        </ul>

        <div className="team-notes-head">
          <span className="metric-label"><Icon name="note" size={15} /> Catatan tim</span>
          <span className="metric-note">{notes.length} catatan</span>
        </div>

        <div className="sticky-grid">
          {notes.map((n) => (
            <div key={n.id} className={`sticky-note note-${n.color}${deleting.has(n.id) ? ' is-deleting' : ''}`} aria-busy={deleting.has(n.id)}>
              <p className="sticky-text">{n.text}</p>
              <div className="sticky-foot">
                <span className="sticky-author">{n.author}{n.author === self ? ' (Anda)' : ''} · {relTime(n.createdAt)}</span>
                <button type="button" className="sticky-del" aria-label={`Hapus catatan dari ${n.author}`} title="Hapus catatan" disabled={deleting.has(n.id)} onClick={() => void remove(n.id)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          ))}
          {notes.length === 0 ? <div className="empty">Belum ada catatan.</div> : null}
        </div>

        <div className="sticky-compose">
          <textarea
            className="sticky-input"
            placeholder="Tinggalkan catatan untuk tim…"
            value={draft}
            maxLength={280}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
          />
          <div className="sticky-compose-row">
            <div className="sticky-colors" role="group" aria-label="Warna catatan">
              {COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`sticky-swatch note-${c.id}${color === c.id ? ' is-on' : ''}`}
                  aria-label={c.label}
                  aria-pressed={color === c.id}
                  onClick={() => setColor(c.id)}
                />
              ))}
            </div>
            <Button color="primary" size="sm" disabled={!draft.trim() || busy} onClick={() => void submit()}>
              {busy ? <><Spinner size="sm" /> Menempel…</> : <><Icon name="plus" size={15} /> Tempel</>}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
