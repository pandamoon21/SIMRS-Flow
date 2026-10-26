/**
 * Minimal in-house primitives replacing @coreui/react — the pleurat rewrite's
 * own component layer. Same DOM/className contract as the old C* wrappers so
 * theme.css selectors keep working; no runtime dependency left.
 */
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export type Tone = 'info' | 'warning' | 'danger' | 'success' | 'secondary' | 'primary' | 'light' | 'dark' | 'write';

export function Button({
  color = 'secondary',
  variant,
  size,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { color?: Tone; variant?: 'outline' | 'ghost'; size?: 'sm' | 'lg' }) {
  const cls = ['btn', `btn-${color}`];
  if (variant === 'outline') cls.push(`btn-outline-${color}`);
  if (variant === 'ghost') cls.push('btn-ghost');
  if (size) cls.push(`btn-${size}`);
  return (
    <button type="button" className={[...cls, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </button>
  );
}

export function ButtonGroup({ size, role = 'group', 'aria-label': ariaLabel, children }: { size?: 'sm' | 'lg'; role?: string; 'aria-label'?: string; children: ReactNode }) {
  return (
    <div className={['btn-group', size ? `btn-group-${size}` : ''].filter(Boolean).join(' ')} role={role} aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export function Card({ className = '', role, onClick, children }: { className?: string; role?: string; onClick?: () => void; children: ReactNode }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      role={role ?? (clickable ? 'button' : undefined)}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      className={['card', clickable ? 'card-clickable' : '', className].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
}

export function CardBody({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={['card-body', className].filter(Boolean).join(' ')}>{children}</div>;
}

export function CardHeader({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={['card-header', className].filter(Boolean).join(' ')}>{children}</div>;
}

export function Alert({ color = 'info', className = '', role = 'alert', children }: { color?: Tone; className?: string; role?: string; children: ReactNode }) {
  return <div className={['alert', `alert-${color}`, className].filter(Boolean).join(' ')} role={role}>{children}</div>;
}

export function Badge({ color, className = '', children }: { color?: Tone; className?: string; children: ReactNode }) {
  return <span className={['badge', color ? `bg-${color}` : '', className].filter(Boolean).join(' ')}>{children}</span>;
}

export function FormLabel({ htmlFor, className = '', children }: { htmlFor?: string; className?: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className={['form-label', className].filter(Boolean).join(' ')}>{children}</label>;
}

export function FormInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={['form-control', className].filter(Boolean).join(' ')} {...rest} />;
}

export function FormTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea className={['form-control', className].filter(Boolean).join(' ')} {...rest} />;
}

export function FormSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return <select className={['form-select', className].filter(Boolean).join(' ')} {...rest} />;
}

export function FormCheck({
  id,
  label,
  title,
  name,
  checked,
  onChange,
  type = 'checkbox',
  disabled,
}: {
  id: string;
  label: string;
  title?: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  type?: 'checkbox' | 'radio';
}) {
  return (
    <div className="form-check">
      <input
        id={id}
        type={type}
        name={name}
        title={title}
        className="form-check-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <label className="form-check-label" htmlFor={id}>{label}</label>
    </div>
  );
}

export function Row({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={['row', className].filter(Boolean).join(' ')}>{children}</div>;
}

export function Col({ xs, xl, md, sm, lg, className = '', children }: { xs?: number; xl?: number; md?: number; sm?: number; lg?: number; className?: string; children: ReactNode }) {
  const cls = ['col'];
  if (xs) cls.push(`col-${xs}`);
  if (xl) cls.push(`col-xl-${xl}`);
  if (lg) cls.push(`col-lg-${lg}`);
  if (md) cls.push(`col-md-${md}`);
  if (sm) cls.push(`col-sm-${sm}`);
  return <div className={[...cls, className].filter(Boolean).join(' ')}>{children}</div>;
}

export function Container({ fluid = true, className = '', children }: { fluid?: boolean; className?: string; children: ReactNode }) {
  return <div className={['container', fluid ? 'container-fluid' : '', className].filter(Boolean).join(' ')}>{children}</div>;
}

export function Spinner({ size, className = '' }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return <span className={['spinner', size ? `spinner-${size}` : '', className].filter(Boolean).join(' ')} role="status" aria-label="Loading" />;
}

export type RefreshPhase = 'idle' | 'busy' | 'done' | 'failed';
/** A local reload answers in ~20 ms; below this the spinner is an unreadable flicker. */
export const REFRESH_MIN_BUSY_MS = 450;
const REFRESH_RESULT_MS = 1600;
const REFRESH_ICON: Record<RefreshPhase, string> = {
  idle: 'M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4 M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4',
  busy: 'M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4 M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4',
  done: 'M5 12l5 5l10 -10',
  failed: 'M18 6l-12 12 M6 6l12 12',
};

/**
 * Reload button with visible feedback: the icon spins for at least
 * REFRESH_MIN_BUSY_MS, then a ✓ "Diperbarui" (or ✕ "Gagal" when `onRefresh`
 * rejects or resolves `false`) holds briefly before it settles back. Labels
 * share one grid cell, so the button never changes width under the cursor.
 */
export function RefreshButton({
  onRefresh,
  label = 'Refresh',
  busyLabel = 'Memuat…',
  doneLabel = 'Diperbarui',
  failedLabel = 'Gagal',
  size = 'sm',
  disabled,
  title,
  className = '',
}: {
  onRefresh: () => Promise<boolean | void> | boolean | void;
  label?: string;
  busyLabel?: string;
  doneLabel?: string;
  failedLabel?: string;
  size?: 'sm' | 'lg';
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [phase, setPhase] = useState<RefreshPhase>('idle');
  const timer = useRef<number>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; window.clearTimeout(timer.current); };
  }, []);
  const run = async () => {
    if (phase === 'busy') return;
    window.clearTimeout(timer.current);
    setPhase('busy');
    const started = performance.now();
    let ok = true;
    try { ok = (await onRefresh()) !== false; } catch { ok = false; }
    await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, REFRESH_MIN_BUSY_MS - (performance.now() - started))));
    if (!alive.current) return;
    setPhase(ok ? 'done' : 'failed');
    timer.current = window.setTimeout(() => { if (alive.current) setPhase('idle'); }, REFRESH_RESULT_MS);
  };
  const labels: Record<RefreshPhase, string> = { idle: label, busy: busyLabel, done: doneLabel, failed: failedLabel };
  return (
    <Button color="secondary" variant="outline" size={size} type="button" className={`refresh-btn is-${phase} ${className}`.trim()}
      aria-busy={phase === 'busy'} disabled={disabled || phase === 'busy'} title={title} onClick={() => void run()}>
      <svg className="refresh-icon" key={phase === 'busy' ? 'idle' : phase} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={REFRESH_ICON[phase]} />
      </svg>
      <span className="refresh-label" aria-live="polite">
        {(Object.keys(labels) as RefreshPhase[]).map((key) => (
          <span key={key} className={key === phase ? 'is-current' : undefined} aria-hidden={key !== phase}>{labels[key]}</span>
        ))}
      </span>
    </Button>
  );
}

export function Table({ hover, align, className = '', children }: { hover?: boolean; align?: string; className?: string; children: ReactNode }) {
  const cls = ['table'];
  if (hover) cls.push('table-hover');
  if (align) cls.push(`align-${align}`);
  return <table className={[...cls, className].filter(Boolean).join(' ')}>{children}</table>;
}
export function TableHead({ children }: { children: ReactNode }) { return <thead>{children}</thead>; }
export function TableBody({ children }: { children: ReactNode }) { return <tbody>{children}</tbody>; }
export function TableRow({ className = '', children }: { className?: string; children: ReactNode }) {
  return <tr className={['table-row', className].filter(Boolean).join(' ')}>{children}</tr>;
}
export function TableHeaderCell({ className = '', scope, children }: { className?: string; scope?: string; children: ReactNode }) {
  return <th scope={scope} className={['table-th', className].filter(Boolean).join(' ')}>{children}</th>;
}
export function TableDataCell({ className = '', children }: { className?: string; children: ReactNode }) {
  return <td className={['table-td', className].filter(Boolean).join(' ')}>{children}</td>;
}

export function Form({ onSubmit, children, className = '' }: { onSubmit?: (e: React.FormEvent) => void; children: ReactNode; className?: string }) {
  return <form className={className} onSubmit={(e) => { e.preventDefault(); onSubmit?.(e); }}>{children}</form>;
}

/* --- Shell primitives (sidebar/header) ------------------------------------ */

export function Sidebar({
  id,
  className = '',
  colorScheme: _colorScheme,
  visible,
  onVisibleChange: _onVisibleChange,
  children,
}: {
  id?: string;
  className?: string;
  colorScheme?: string;
  visible: boolean;
  onVisibleChange?: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <aside id={id} className={className} data-visible={visible} data-color-scheme={_colorScheme} aria-hidden={!visible}>
      {children}
    </aside>
  );
}

export function SidebarBrand({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={className}>{children}</div>;
}

export function SidebarNav({ children }: { children: ReactNode }) {
  return <nav className="sidebar-nav">{children}</nav>;
}

export function Nav({ className = '', 'aria-label': ariaLabel, children }: { className?: string; 'aria-label'?: string; children: ReactNode }) {
  return <ul className={['nav', className].filter(Boolean).join(' ')} aria-label={ariaLabel}>{children}</ul>;
}

export function NavItem({ children }: { children: ReactNode }) {
  return <li className="nav-item">{children}</li>;
}

export function NavLink({
  href,
  active,
  disabled,
  className = '',
  children,
  onClick,
  ...rest
}: {
  href?: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'children'>) {
  const cls = ['nav-link', active ? 'active' : '', disabled ? 'disabled' : '', className].filter(Boolean).join(' ');
  return (
    <a
      href={href}
      className={cls}
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      {...rest}
    >
      {children}
    </a>
  );
}

export function Header({ className = '', children }: { className?: string; children: ReactNode }) {
  return <header className={['header', className].filter(Boolean).join(' ')}>{children}</header>;
}

export function HeaderBrand({ children }: { children: ReactNode }) {
  return <span className="header-brand">{children}</span>;
}

export function HeaderToggler({ className = '', onClick, ...rest }: { className?: string; onClick?: () => void } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button type="button" className={['sidebar-toggler', className].filter(Boolean).join(' ')} onClick={onClick} {...rest}>
      <span className="sidebar-toggler-bar" />
      <span className="sidebar-toggler-bar" />
      <span className="sidebar-toggler-bar" />
    </button>
  );
}
