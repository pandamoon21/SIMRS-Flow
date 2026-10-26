/**
 * Text filter with an in-app suggestion menu — replaces the browser's
 * <datalist>, whose popup cannot be styled and behaves differently per
 * browser. Typing filters the suggestions (contains, case-insensitive);
 * ↑/↓ move, Enter picks, Esc closes; × clears.
 */

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

const MAX_ITEMS = 8;

/** Suggestions containing the query, best (prefix) matches first. */
export function matchSuggestions(all: readonly string[], query: string, limit = MAX_ITEMS): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const hits = all.filter((s) => s.toLowerCase().includes(q) && s.toLowerCase() !== q);
  hits.sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)));
  return hits.slice(0, limit);
}

function Highlight({ text, query }: { text: string; query: string }) {
  const i = query.trim() ? text.toLowerCase().indexOf(query.trim().toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  const n = query.trim().length;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + n)}</mark>{text.slice(i + n)}</>;
}

export function SuggestInput({ value, onChange, suggestions, placeholder, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly string[];
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const items = useMemo(() => matchSuggestions(suggestions, value), [suggestions, value]);
  const show = open && items.length > 0;

  const pick = (v: string) => { onChange(v); setOpen(false); setActive(-1); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(-1, i - 1)); }
    else if (e.key === 'Enter' && show && active >= 0) { e.preventDefault(); pick(items[active]!); }
    else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
  };

  return (
    <div className="suggest">
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      {value ? (
        <button type="button" className="suggest-clear" aria-label="Kosongkan" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(''); inputRef.current?.focus(); }}>×</button>
      ) : null}
      {show ? (
        <ul className="suggest-menu" role="listbox" id={listId}>
          {items.map((item, i) => (
            <li
              key={item}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              // mousedown, not click: picking must win over the input's blur.
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
              onMouseEnter={() => setActive(i)}
            >
              <Highlight text={item} query={value} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
