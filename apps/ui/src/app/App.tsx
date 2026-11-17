/**
 * App owns auth, navigation and the single event projection. The run on screen
 * and every command on it live in the run session (../session/runSession.ts);
 * App mirrors its snapshot and handles the URL, page changes and toasts. Pages
 * only present those contracts through the CoreUI dashboard shell.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ranapWorkflow } from '@simrs-flow/domain-ranap/contract';
import { rajalWorkflow } from '@simrs-flow/domain-rajal/contract';
import type { ExecutionMode, WorkflowDefinition } from '@simrs-flow/workflow-core';
import type { RunInputResult } from '../features/forms/RunInputForm.js';
import { useRunStore } from '../store/runStore.js';
import { api, UnauthorizedError, type RunSummary } from '../api/client.js';
import { createRunSession } from '../session/createRunSession.js';
import type { RunCommands, RunSessionHooks, StartedRun } from '../session/runSession.js';
import { LoginGate } from './LoginGate.js';
import { DashboardShell, type DashboardPage } from './DashboardShell.js';
import type { PatientFilter } from '../features/dashboard/RekapPage.js';
import { RunPage } from '../features/run/RunPage.js';
import { Card, CardBody, Spinner } from '../ui/primitives.js';
import { toast, ToastHost } from '../ui/toast.js';
import { reducedMotion } from '../ui/motion.js';

// Kept importable from here: tests and older callers read them off App.
export { gateActionError, runLostMessage } from '../session/runSession.js';

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  [ranapWorkflow.id]: ranapWorkflow,
  [rajalWorkflow.id]: rajalWorkflow,
};

const WORKFLOW_LABELS = Object.fromEntries(Object.values(WORKFLOWS).map((workflow) => [workflow.id, workflow.label]));

export type Source = 'offline' | 'live';

// Pages other than Run load on first visit: opening a run on a slow office PC
// should not first parse the dashboard, rekap, rules and settings code.
const DashboardHome = lazy(() => import('../features/dashboard/DashboardHome.js').then((m) => ({ default: m.DashboardHome })));
const RekapPage = lazy(() => import('../features/dashboard/RekapPage.js').then((m) => ({ default: m.RekapPage })));
const NaikKelasPage = lazy(() => import('../features/naikKelas/NaikKelasPage.js').then((m) => ({ default: m.NaikKelasPage })));
const RunHistory = lazy(() => import('../features/history/RunHistory.js').then((m) => ({ default: m.RunHistory })));
const ReviewQueue = lazy(() => import('../features/review/ReviewQueue.js').then((m) => ({ default: m.ReviewQueue })));
const RuleCatalogPage = lazy(() => import('../features/rules/RuleCatalogPage.js').then((m) => ({ default: m.RuleCatalogPage })));
const SettingsHealth = lazy(() => import('../features/settings/SettingsHealth.js').then((m) => ({ default: m.SettingsHealth })));

export function liveStartBlockerOf(source: Source, runInput: RunInputResult): string | undefined {
  if (source !== 'live') return undefined;
  if (runInput.error) return runInput.error;
  if (!runInput.input) return 'Input run belum lengkap.';
  return undefined;
}

/** Old two-page navigation collapsed onto the merged Run route. */
function normalizePage(page: DashboardPage | 'start'): DashboardPage {
  return page === 'start' ? 'run' : page;
}

export function shouldShowWelcome(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

/** A refresh reopens the run through the `?run=` deep link. */
function rememberRunInUrl(runId: string): void {
  history.replaceState(null, '', `?run=${encodeURIComponent(runId)}`);
}

function clearRunFromUrl(): void {
  if (location.search) history.replaceState(null, '', location.pathname);
}

export function App() {
  const [operator, setOperator] = useState<string>();
  // Only a fresh login triggers the welcome; restored sessions render immediately.
  const [entering, setEntering] = useState(false);
  const handleLoggedIn = useCallback((op: string) => {
    setOperator(op);
    // The welcome curtains are pure decoration: skipped unless motion is full.
    setEntering(shouldShowWelcome(reducedMotion() || document.documentElement.dataset.motion === 'lite'));
  }, []);
  useEffect(() => {
    if (!entering || !operator) return;
    // Curtains drop, the greeting fills, then they lift (theme.part2.css); unmount once the last one is up.
    const timer = window.setTimeout(() => setEntering(false), 2300);
    return () => window.clearTimeout(timer);
  }, [entering, operator]);
  const [authChecked, setAuthChecked] = useState(false);
  const [page, setPage] = useState<DashboardPage>('home');
  const [workflowId, setWorkflowId] = useState(ranapWorkflow.id);
  const [mode, setMode] = useState<ExecutionMode>('preview');
  const [source, setSource] = useState<Source>('offline');
  const [liveError, setLiveError] = useState<string>();
  const [runInput, setRunInput] = useState<RunInputResult>({ summary: 'Input belum lengkap' });
  // Write-mode convenience: skip the human gate/plan confirmation for the next
  // run. Never persisted — it must be re-armed deliberately per session.
  const [autoApprove, setAutoApprove] = useState(false);
  const [selectedHistoryRun, setSelectedHistoryRun] = useState<RunSummary>();
  // Bumped on every Start: a fixture replay reuses its run id, yet each start is a new run.
  const [runNonce, setRunNonce] = useState(0);
  const [patientFilter, setPatientFilter] = useState<PatientFilter>('all');

  const loadDefinition = useRunStore((store) => store.loadDefinition);
  const state = useRunStore((store) => store.state);
  const rulesDirtyRef = useRef(false);
  const onRulesDirty = useCallback((dirty: boolean) => { rulesDirtyRef.current = dirty; }, []);

  useEffect(() => {
    let cancelled = false;
    api.me()
      .then((response) => {
        if (!cancelled) setOperator(response.operator);
      })
      .catch((err) => {
        // A stale remembered token (orchestrator restarted → session gone)
        // should be dropped so we don't keep presenting it. A transient network
        // error must NOT wipe it — the session may still be valid.
        if (err instanceof UnauthorizedError) api.forgetSession();
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onUnauthorized = useCallback(() => {
    setEntering(false);
    setOperator(undefined);
    setLiveError('Sesi berakhir — silakan masuk lagi.');
  }, []);

  // One session for the app's lifetime; its hooks read the latest callbacks.
  const hooksRef = useRef<RunSessionHooks>({ onError: setLiveError, onUnauthorized });
  hooksRef.current = { onError: setLiveError, onUnauthorized };
  const [session] = useState(() => createRunSession({
    onError: (message) => hooksRef.current.onError(message),
    onUnauthorized: () => hooksRef.current.onUnauthorized(),
  }));
  const run = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => () => session.dispose(), [session]);

  const logout = useCallback(async () => {
    session.detach();
    await api.logout();
    setOperator(undefined);
    setEntering(false);
  }, [session]);

  useEffect(() => {
    loadDefinition(WORKFLOWS[workflowId]!, mode);
  }, [workflowId, mode, loadDefinition]);

  /** A run just started: show it, and make a refresh come back to it when the server holds it. */
  const showStarted = useCallback((started: StartedRun | undefined) => {
    if (!started) return;
    setSelectedHistoryRun(undefined);
    if (started.kind === 'live') rememberRunInUrl(started.runId);
    setPage('run');
  }, []);

  const start = useCallback(() => {
    if (run.starting) return;
    setRunNonce((n) => n + 1);
    if (source === 'offline') {
      void session.startSample(WORKFLOWS[workflowId]!, mode).then(showStarted);
      return;
    }
    setLiveError(undefined);
    const blocker = liveStartBlockerOf('live', runInput);
    if (blocker) {
      setLiveError(blocker);
      return;
    }
    void session.startLive({ workflowId, mode, input: runInput.input, enabled: runInput.enabled, autoApprove }).then((started) => {
      showStarted(started);
      if (started) toast('info', `Run dimulai · ${started.runId}`);
    });
  }, [autoApprove, mode, run.starting, runInput, session, showStarted, source, workflowId]);

  const openHistoryRun = useCallback(async (summary: RunSummary) => {
    setLiveError(undefined);
    const definition = await session.openRun(summary);
    if (!definition) return;
    setWorkflowId(summary.workflowId);
    setMode(summary.mode);
    rememberRunInUrl(summary.runId);
    setSelectedHistoryRun(summary);
    setPage('run');
  }, [session]);

  // Deep link: `?run=<id>` reopens a run the orchestrator still tracks (or its ledger replay).
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('run');
    if (!id) return;
    void api.listRuns().then(({ runs }) => {
      const found = runs.find((r) => r.runId === id);
      if (found) void openHistoryRun(found);
      else setLiveError(`Run ${id} tidak ditemukan`);
    }).catch((error) => { if (error instanceof UnauthorizedError) onUnauthorized(); });
    // Runs once on mount only.
  }, []);

  const changePage = useCallback((nextPage: DashboardPage | 'start') => {
    const normalized = normalizePage(nextPage);
    // Leaving the Rules page would drop an unsaved rule draft without a word.
    if (rulesDirtyRef.current && normalized !== 'rules' && !window.confirm('Perubahan rule belum disimpan. Tinggalkan halaman ini?')) return;
    rulesDirtyRef.current = false;
    if (normalized !== 'run') {
      session.detach();
      clearRunFromUrl();
    }
    setLiveError(undefined);
    setPage(normalized);
  }, [session]);

  /**
   * Changing workflow or mode in Setup reloads a pristine definition, so the
   * finished run is no longer on screen; drop its id too, or the command bar
   * keeps naming a run that is gone. Setup is locked while a run is live.
   */
  const forgetRun = useCallback(() => {
    session.forget();
    setSelectedHistoryRun(undefined);
    clearRunFromUrl();
  }, [session]);

  // Decisions resolve once the server answers, so the inspector can hold a
  // pending state until then; outcomes surface as toasts and errors as liveError.
  const commands = useMemo<RunCommands>(() => ({
    cancel: () => session.cancel(),
    pause: () => session.pause(),
    resume: () => session.resume(),
    seek: (cursor) => session.seek(cursor),
    playReplay: () => session.playReplay(),
    pauseReplay: () => session.pauseReplay(),
    approveGate: async (nodeId) => {
      setLiveError(undefined);
      const ok = await session.approveGate(nodeId);
      if (ok) toast('success', 'Gate disetujui');
      return ok;
    },
    rejectGate: async (nodeId) => {
      setLiveError(undefined);
      const ok = await session.rejectGate(nodeId);
      if (ok) toast('warning', 'Gate ditolak');
      return ok;
    },
    approveMutation: async (planId) => {
      setLiveError(undefined);
      const ok = await session.approveMutation(planId);
      if (ok) toast('success', 'Mutasi disetujui · menunggu verifikasi');
      return ok;
    },
  }), [session]);

  // Errors raised while another page is open (e.g. opening a run from History)
  // would otherwise sit unseen on the Run page.
  useEffect(() => {
    if (liveError && page !== 'run') toast('danger', liveError);
  }, [liveError, page]);

  if (!authChecked) {
    return <div className="login-shell"><Card className="login-card" role="status"><CardBody className="page-loading"><Spinner size="sm" /> Memuat sesi…</CardBody></Card></div>;
  }
  if (!operator) return <LoginGate onLoggedIn={handleLoggedIn} />;

  const startBlocker =
    liveStartBlockerOf(source, runInput) ??
    (mode === 'write' && source === 'offline'
      ? 'Confirmed write butuh sumber "Live SIMRS" — fixture replay tidak menjalankan script maupun menulis apa pun.'
      : undefined);

  const runId = run.runId;
  const hasRunContext = Boolean(runId && state);
  // Only ledger replays are history; an in-memory run opened from History is still live and stoppable.
  const historical = selectedHistoryRun?.source === 'ledger';
  const hasReviewContext = Boolean(
    hasRunContext &&
      (Object.values(state?.nodes ?? {}).some((node) => node.status === 'needs_review' || node.status === 'gate_waiting') ||
        Object.values(state?.gates ?? {}).some((gate) => gate.status === 'waiting')),
  );

  return (
    <>
      {entering ? (
        <div className="route-transition" aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <span key={i} className="route-col" style={{ '--i': i } as CSSProperties} />
          ))}
          <span className="route-transition-mark"><span className="route-transition-name">Selamat datang<span className="route-transition-dot">.</span></span></span>
        </div>
      ) : null}
    <DashboardShell
      page={page}
      operator={operator}
      hasRunContext={hasRunContext}
      hasReviewContext={hasReviewContext}
      onPageChange={changePage}
      onLogout={() => void logout()}
    >
      <Suspense fallback={<div className="page-loading" role="status"><Spinner size="sm" /> Memuat halaman…</div>}>
      {page === 'home' ? <DashboardHome onNavigate={changePage} onOpenRun={(r) => void openHistoryRun(r)} onOpenPatients={(f) => { setPatientFilter(f); changePage('rekap'); }} onUnauthorized={onUnauthorized} /> : null}
      {page === 'run' ? (
        <RunPage
          workflows={Object.values(WORKFLOWS)}
          workflowId={workflowId}
          mode={mode}
          source={source}
          runInput={runInput}
          startBlocker={startBlocker}
          onWorkflowChange={(id) => {
            forgetRun();
            setWorkflowId(id);
          }}
          onModeChange={(next) => {
            forgetRun();
            setMode(next);
          }}
          onSourceChange={setSource}
          onInputChange={setRunInput}
          onStart={start}
          autoApprove={autoApprove}
          onAutoApproveChange={setAutoApprove}
          run={run}
          runNonce={runNonce}
          commands={commands}
          hasRunContext={hasRunContext}
          historical={historical}
          liveError={liveError}
          onOpenHistory={() => changePage('history')}
          onDismissError={() => setLiveError(undefined)}
        />
      ) : null}
      {page === 'rekap' ? <RekapPage onUnauthorized={onUnauthorized} initialFilter={patientFilter} /> : null}
      {page === 'naik-kelas' ? <NaikKelasPage onUnauthorized={onUnauthorized} /> : null}
      {page === 'history' ? <RunHistory onOpenRun={(r) => void openHistoryRun(r)} onUnauthorized={onUnauthorized} workflowLabels={WORKFLOW_LABELS} /> : null}
      {page === 'review' ? (
        <ReviewQueue
          state={state}
          runId={runId}
          hasReviewContext={hasReviewContext}
          onApproveGate={(nodeId) => void commands.approveGate(nodeId)}
          onRejectGate={(nodeId) => void commands.rejectGate(nodeId)}
          onOpenRun={() => changePage('run')}
        />
      ) : null}
      {page === 'rules' ? <RuleCatalogPage onUnauthorized={onUnauthorized} onDirtyChange={onRulesDirty} /> : null}
      {page === 'settings' ? <SettingsHealth onUnauthorized={onUnauthorized} /> : null}
      </Suspense>
    </DashboardShell>
    <ToastHost />
    </>
  );
}
