/**
 * LoginGate — the EvoMedis login screen.
 *
 * A successful EvoMedis login is the app login: the orchestrator logs into
 * SIMRS with these credentials, captures the session, and issues a token the
 * client stores. Until that succeeds the rest of the app is gated.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client.js';
import { Alert, Button, Card, CardBody, Form, FormCheck, FormInput, FormLabel } from '../ui/primitives.js';
import { SkylineStrip } from '../ui/decor.js';
import { dailyHadits } from '../ui/hadits.js';
import { applyTheme, resolveInitialTheme, setThemeAnimated } from './DashboardShell.js';

const QA_AUTH_ENABLED =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_QA_AUTH === '1';

// Injected at build time (vite define) with a static fallback for dev.
const BUILD_STAMP =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BUILD_STAMP ?? 'v0.4.1-pilot';

export function LoginGate({ onLoggedIn }: { onLoggedIn: (operator: string) => void }) {
  const [username, setUsername] = useState(() => api.lastUsername());
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [qaBusy, setQaBusy] = useState(false);

  // Pick once per mount so the hadits is stable across re-renders.
  const [hadits] = useState(dailyHadits);

  // Theme toggle lives here too, so the login screen honours the paper/dark
  // choice before the shell mounts.
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const initial = resolveInitialTheme();
    applyTheme(initial);
    return initial;
  });
  const [hostOnline, setHostOnline] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.health().then(() => { if (alive) setHostOnline(true); }).catch(() => { if (alive) setHostOnline(false); });
    return () => { alive = false; };
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setThemeAnimated(next, () => setTheme(next));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const { operator } = await api.login(username.trim(), password, remember);
      onLoggedIn(operator);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  async function submitQaLogin(): Promise<void> {
    setQaBusy(true);
    setError(undefined);
    try {
      const { operator } = await api.qaLogin();
      onLoggedIn(operator);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'QA login failed');
    } finally {
      setQaBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-top">
        <span className="login-console">SIMRS-FLOW <span className="login-console-sep">/</span> CONSOLE</span>
        <div className="login-top-actions">
          <span className={`login-host-pill${hostOnline === false ? ' is-off' : ''}`}>
            <span className="login-host-dot" aria-hidden="true" />
            Host · {hostOnline === false ? 'Offline' : 'Online'}
          </span>
          <span className="login-mode-pill">Mode · Preview</span>
          <button
            type="button"
            className="login-theme-toggle"
            aria-pressed={theme === 'light'}
            aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
            onClick={toggleTheme}
          >
            {theme === 'light' ? (
              <svg key={theme} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinejoin="round" /></svg>
            ) : (
              <svg key={theme} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M5 19l1.7-1.7M17.3 6.7 19 5" strokeLinecap="round" /></svg>
            )}
            <span>{theme === 'light' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </div>
      <div className="login-main">
      <div className="login-body">
        <div className="login-editorial">
          <div className="login-brand">
            <span className="page-eyebrow">Clinical workflow console</span>
            <h1>SIMRS<span className="brand-flow">·FLOW</span></h1>
            <p>Masuk dengan akun EvoMedis Anda. Sesi Anda mengotorisasi setiap tindakan — preview aman secara default.</p>
          </div>
          <figure className="login-hadits" aria-label="Hadits hari ini">
            <div className="login-hadits-head">
              <span className="page-eyebrow">Hadits hari ini</span>
              <span className="login-hadits-date">{hadits.date}</span>
            </div>
            <blockquote lang="ar" dir="rtl" className="login-hadits-ar">{hadits.arabic}</blockquote>
            <figcaption className="login-hadits-id">“{hadits.translation}”</figcaption>
            <cite className="login-hadits-src">{hadits.source}</cite>
          </figure>
        </div>

        <Card className="login-card">
          <CardBody>
            <span className="page-eyebrow login-card-eyebrow">Operator access</span>
            <Form className="login-form" onSubmit={submit}>
              <div>
                <FormLabel htmlFor="login-username">Username</FormLabel>
                <FormInput
                  id="login-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoFocus={username === ''}
                  autoComplete="username"
                />
              </div>
              <div>
                <FormLabel htmlFor="login-password">Password</FormLabel>
                <FormInput
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoFocus={username !== ''}
                  autoComplete="current-password"
                />
              </div>
              <div className="login-remember">
                <FormCheck
                  id="login-remember"
                  label="Ingat saya di perangkat ini"
                  title="Simpan sesi login di browser ini agar tidak perlu masuk ulang"
                  checked={remember}
                  onChange={(c) => setRemember(c)}
                />
              </div>
              {error ? <Alert color="danger" className="mb-0" role="alert">{error}</Alert> : null}
              <Button className="login-submit" color="info" size="lg" type="submit" disabled={busy || !username || !password}>
                {busy ? 'Masuk…' : 'Masuk ke dashboard'}
              </Button>
              <p className="login-note">
                Kredensial hanya dipakai untuk login ke EvoMedis dan disimpan di memori orchestrator saja, tidak ke disk.
              </p>
              {QA_AUTH_ENABLED ? (
                <Button className="login-qa" color="secondary" variant="outline" size="lg" disabled={busy || qaBusy} type="button" onClick={submitQaLogin}>
                  {qaBusy ? 'Masuk QA…' : 'Masuk QA (mock)'}
                </Button>
              ) : null}
            </Form>
            <div className="login-build">
              <span>Build</span>
              <span className="login-build-stamp">{BUILD_STAMP}</span>
            </div>
          </CardBody>
        </Card>
      </div>
      </div>

      <SkylineStrip className="login-skyline" />
    </div>
  );
}
