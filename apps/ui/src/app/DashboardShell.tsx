import { useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '../ui/primitives.js';
import { reducedMotion } from '../ui/motion.js';

// Theme: 'light' (pleurat paper, default) or 'dark'. First visit follows the OS
// preference (prefers-color-scheme); an explicit toggle is persisted per browser.
export const THEME_KEY = 'simrs-flow-theme';
const SIDEBAR_KEY = 'simrs-flow-sidebar';

export function applyTheme(theme: 'dark' | 'light'): void {
  if (theme === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
}

/**
 * Switch theme with a cross-fade (View Transitions): one snapshot + one
 * compositor opacity animation. Unsupported browsers and reduced motion get the
 * instant swap.
 */
export function setThemeAnimated(next: 'dark' | 'light', commit: () => void): void {
  const apply = () => {
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* preference only */ }
    commit();
  };
  if (typeof document.startViewTransition !== 'function' || reducedMotion()) {
    apply();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = 'theme';
  const transition = document.startViewTransition(() => flushSync(apply));
  void transition.finished.finally(() => { delete root.dataset.vt; });
}

/** Resolve the initial theme: saved override wins, else the OS preference, else light. */
export function resolveInitialTheme(): 'dark' | 'light' {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null;
  if (saved === 'dark' || saved === 'light') return saved;
  // Default to the paper (light) theme; an explicit toggle is what opts into dark.
  return 'light';
}

export type DashboardPage = 'home' | 'start' | 'run' | 'history' | 'review' | 'rules' | 'settings' | 'rekap' | 'naik-kelas';

type IconName = 'overview' | 'patients' | 'billing' | 'upgrade' | 'run' | 'history' | 'review' | 'rules' | 'settings';

const NAV_ITEMS: ReadonlyArray<{ page: DashboardPage; label: string; icon: IconName; hint: string }> = [
  { page: 'home', label: 'Overview', icon: 'overview', hint: 'Ringkasan operasional & tim' },
  { page: 'rekap', label: 'Rekapitulasi', icon: 'billing', hint: 'Nominal billing & daftar pasien' },
  { page: 'naik-kelas', label: 'Iur Naik Kelas', icon: 'upgrade', hint: 'Daftar iur pasien naik kelas dari form dokter' },
  { page: 'run', label: 'Run', icon: 'run', hint: 'Jalankan & pantau workflow' },
  { page: 'history', label: 'History', icon: 'history', hint: 'Riwayat run sebelumnya' },
  { page: 'review', label: 'Review', icon: 'review', hint: 'Tinjau gate & keputusan' },
  { page: 'rules', label: 'Rules', icon: 'rules', hint: 'Katalog rule, alasan & tindakan' },
  { page: 'settings', label: 'Pengaturan', icon: 'settings', hint: 'Status koneksi, alamat untuk PC lain, animasi, penyimpanan data' },
];

/** Icon-rail glyphs, matching the Claude Design Run/Dashboard artboards. */
function RailIcon({ name }: { name: IconName }) {
  switch (name) {
    case 'overview':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
        </svg>
      );
    case 'patients':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 6.2a3.2 3.2 0 0 1 0 6" /><path d="M15.5 14.4A5.5 5.5 0 0 1 20.5 20" />
        </svg>
      );
    case 'billing':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <path d="M3 21h18" /><rect x="5" y="11" width="3.4" height="7" /><rect x="10.3" y="6" width="3.4" height="12" /><rect x="15.6" y="8.5" width="3.4" height="9.5" />
        </svg>
      );
    case 'upgrade':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <path d="M3 19h18" /><path d="M12 15V4" /><path d="m7 9 5-5 5 5" />
        </svg>
      );
    case 'run':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <polygon points="6 4 20 12 6 20 6 4" />
        </svg>
      );
    case 'history':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
      );
    case 'review':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case 'rules':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={2.6} strokeLinecap="round" />
        </svg>
      );
    case 'settings':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
        </svg>
      );
  }
}

const CLOCK_TIME = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
const CLOCK_DATE = new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });

/** "07:14 · Sen, 20 Okt" — the clock wakes once per minute boundary, never per second. */
export function clockLabel(date: Date): { time: string; date: string } {
  return { time: CLOCK_TIME.format(date).replace('.', ':'), date: CLOCK_DATE.format(date) };
}

function HeaderClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(schedule, 60_000 - (current.getSeconds() * 1000 + current.getMilliseconds()) + 50);
    };
    // A background tab's timers are throttled; catch up the moment it is visible again.
    const onVisible = () => { if (!document.hidden) schedule(); };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  const label = clockLabel(now);
  return (
    <time className="dashboard-clock" dateTime={now.toISOString()} title={now.toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' })}>
      <span className="dashboard-clock-time">{label.time}</span>
      <span className="dashboard-clock-date">{label.date}</span>
    </time>
  );
}

function operatorInitials(operator: string): string {
  const base = operator.split('@')[0] || operator;
  const parts = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const first = parts[0] ?? '';
  const second = parts[1] ?? '';
  const letters = second ? first.slice(0, 1) + second.slice(0, 1) : first.slice(0, 2);
  return letters.toUpperCase() || 'OP';
}

export const dashboardShellClassName = (sidebarVisible: boolean) =>
  `dashboard-shell${sidebarVisible ? '' : ' dashboard-sidebar-hidden'}`;

export function dashboardPageHasContext(page: DashboardPage, hasRunContext: boolean, hasReviewContext: boolean): boolean {
  if (page === 'run') return hasRunContext;
  if (page === 'review') return hasReviewContext;
  return true;
}

export interface DashboardShellProps {
  page: DashboardPage;
  operator: string;
  hasRunContext?: boolean;
  hasReviewContext?: boolean;
  onPageChange: (page: DashboardPage) => void;
  onLogout: () => void;
  children: ReactNode;
}

/**
 * App shell — a slim 58px icon rail (Claude Design parity) plus a minimal
 * page header. The rail carries brand, primary navigation, the theme toggle,
 * and the operator avatar; each page renders its own working chrome below.
 */
export function DashboardShell({
  page,
  operator,
  hasReviewContext = false,
  onPageChange,
  onLogout,
  children,
}: DashboardShellProps) {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const initial = resolveInitialTheme();
    applyTheme(initial);
    return initial;
  });

  const switchTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setThemeAnimated(next, () => setTheme(next));
  };

  // The brand diamond doubles as the rail toggle; the choice sticks per browser.
  const [sidebarVisible, setSidebarVisible] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) !== 'hidden'; } catch { return true; }
  });
  const toggleSidebar = () => setSidebarVisible((visible) => {
    try { localStorage.setItem(SIDEBAR_KEY, visible ? 'hidden' : 'shown'); } catch { /* storage blocked */ }
    return !visible;
  });

  const activeLabel = NAV_ITEMS.find((item) => item.page === page)?.label ?? 'SIMRS-FLOW';
  // Logout asks once more before ending the session, so a stray click never
  // signs the operator out; the prompt disarms itself after a few seconds.
  const [logoutArmed, setLogoutArmed] = useState(false);
  useEffect(() => {
    if (!logoutArmed) return;
    const t = window.setTimeout(() => setLogoutArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [logoutArmed]);

  return (
    <div className={dashboardShellClassName(sidebarVisible)}>
      <nav className="icon-rail" aria-label="Primary navigation">
        <button
          type="button"
          className="rail-logo"
          aria-expanded={sidebarVisible}
          aria-label={sidebarVisible ? 'Sembunyikan sidebar' : 'Tampilkan sidebar'}
          title={sidebarVisible ? 'Sembunyikan sidebar' : 'Tampilkan sidebar'}
          onClick={toggleSidebar}
        />
        {NAV_ITEMS.map((item) => {
          const isActive = page === item.page;
          // Every destination is reachable (matching the design); pages render
          // their own empty/ready state when no run or review context exists yet.
          const attention = item.page === 'review' && hasReviewContext;
          return (
            <button
              key={item.page}
              type="button"
              className={`rail-link${isActive ? ' active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onPageChange(item.page)}
            >
              <RailIcon name={item.icon} />
              {attention ? <span className="rail-badge" aria-hidden="true" /> : null}
              <span className="visually-hidden">{item.label}</span>
              <span className="rail-tip" role="tooltip">
                <b>{item.label}</b>
                <em>{item.hint}</em>
              </span>
            </button>
          );
        })}
        <div className="rail-spacer" />
        <button
          type="button"
          className="rail-link rail-theme"
          aria-pressed={theme === 'light'}
          title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
          aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          onClick={switchTheme}
        >
          {theme === 'light' ? (
            <svg key={theme} width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg key={theme} width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M5 19l1.7-1.7M17.3 6.7 19 5" strokeLinecap="round" />
            </svg>
          )}
        </button>
        <div className="rail-avatar" title={`Operator: ${operator}`}>{operatorInitials(operator)}</div>
      </nav>

      <div className="dashboard-main">
        <header className="dashboard-header">
          <span className="dashboard-eyebrow">{activeLabel}</span>
          <div className="dashboard-operator">
            <HeaderClock />
            <span className="dashboard-operator-name">Operator &middot; {operator}</span>
            {logoutArmed ? (
              <div className="logout-confirm" role="group" aria-label="Konfirmasi keluar">
                <span className="logout-confirm-text">Keluar dari sesi?</span>
                <Button color="danger" size="sm" type="button" onClick={onLogout}>Ya, keluar</Button>
                <Button color="secondary" variant="outline" size="sm" type="button" onClick={() => setLogoutArmed(false)}>Batal</Button>
              </div>
            ) : (
              <Button className="logout-btn" color="secondary" variant="outline" size="sm" type="button" onClick={() => setLogoutArmed(true)}>
                Logout
              </Button>
            )}
          </div>
        </header>
        <main className="dashboard-content">{children}</main>
      </div>
    </div>
  );
}
