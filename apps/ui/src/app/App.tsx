/**
 * App owns auth, run orchestration, and the single event projection. Pages only
 * present those contracts through the CoreUI dashboard shell.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { rajalWorkflow } from '@simrs-flow/domain-rajal';
import { mockEventStream } from '@simrs-flow/test-fixtures';
import { type ExecutionMode, type WorkflowDefinition, type WorkflowEvent } from '@simrs-flow/workflow-core';
import type { RunInputResult } from '../features/forms/RunInputForm.js';
import { useRunStore } from '../store/runStore.js';
import { api, UnauthorizedError, type RunSummary } from '../api/client.js';
import { LoginGate } from './LoginGate.js';
import { DashboardShell, type DashboardPage } from './DashboardShell.js';
import { RuleCatalogPage } from '../features/rules/RuleCatalogPage.js';
import { DashboardHome } from '../features/dashboard/DashboardHome.js';
import { RekapPage, type PatientFilter } from '../features/dashboard/RekapPage.js';
import { NaikKelasPage } from '../features/naikKelas/NaikKelasPage.js';
import { RunPage } from '../features/run/RunPage.js';
import { RunHistory } from '../features/history/RunHistory.js';
import { ReviewQueue } from '../features/review/ReviewQueue.js';
import { SettingsHealth } from '../features/settings/SettingsHealth.js';
import { Card, CardBody, Spinner } from '../ui/primitives.js';
import { toast, ToastHost } from '../ui/toast.js';

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  [ranapWorkflow.id]: ranapWorkflow,
  [rajalWorkflow.id]: rajalWorkflow,
};

const WORKFLOW_LABELS = Object.fromEntries(Object.values(WORKFLOWS).map((workflow) => [workflow.id, workflow.label]));

export type Source = 'offline' | 'live';

/** Streamed events are applied in batches this far apart (one render per batch). */
const EVENT_BATCH_MS = 50;

export function liveStartBlockerOf(source: Source, runInput: RunInputResult): string | undefined {
  if (source !== 'live') return undefined;
  if (runInput.error) return runInput.error;
  if (!runInput.input) return 'Input run belum lengkap.';
  return undefined;
}

/** A gate decision that silently fails looks identical to one that was accepted. */
export function gateActionError(action: 'approve' | 'reject', error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Gagal ${action === 'approve' ? 'menyetujui' : 'menolak'} gate: ${detail}`;
}

/** Old two-page navigation collapsed onto the merged Run route. */
function normalizePage(page: DashboardPage | 'start'): DashboardPage {
  return page === 'start' ? 'run' : page;
}

/** A stream error that means the run is gone for good → the operator-facing reason; else undefined. */
export function runLostMessage(error: string): string | undefined {
  if (/run_not_found/.test(error)) return 'Run tidak ditemukan lagi di orchestrator (kemungkinan orchestrator restart) — hasil run ini hilang, jalankan ulang.';
  // The ledger replay of a run that never finished: the orchestrator stopped or restarted mid-run.
  if (/no terminal event|ended with a partial line/.test(error)) return 'Run terputus — orchestrator berhenti atau dimulai ulang saat run berjalan. Langkah yang sudah tercatat tetap ada di History; jalankan ulang run untuk menyelesaikannya.';
  if (/gagal setelah beberapa percobaan/.test(error)) return 'Koneksi ke orchestrator putus — status run ini tidak bisa diikuti lagi. Cek orchestrator lalu buka run dari History.';
  return undefined;
}

export function shouldShowWelcome(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

export function App() {
  const [operator, setOperator] = useState<string>();
  // Only a fresh login triggers the welcome; restored sessions render immediately.
  const [entering, setEntering] = useState(false);
  const handleLoggedIn = useCallback((op: string) => {
    setOperator(op);
    setEntering(shouldShowWelcome(
      typeof window === 'undefined' || typeof window.matchMedia !== 'function'
        ? true
        : window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    ));
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
  const [runId, setRunId] = useState<string>();
  // Write-mode convenience: skip the human gate/plan confirmation for the next
  // run. Never persisted — it must be re-armed deliberately per session.
  const [autoApprove, setAutoApprove] = useState(false);
  const [selectedHistoryRun, setSelectedHistoryRun] = useState<RunSummary>();
  // True between pressing Start and the run id coming back; blocks a double start.
  const [starting, setStarting] = useState(false);
  // Bumped on every Start: a fixture replay reuses its run id, yet each start is a new run.
  const [runNonce, setRunNonce] = useState(0);
  const [patientFilter, setPatientFilter] = useState<PatientFilter>('all');

  const loadReplay = useRunStore((store) => store.loadReplay);
  const loadDefinition = useRunStore((store) => store.loadDefinition);
  const pushEvents = useRunStore((store) => store.pushEvents);
  const markRunLost = useRunStore((store) => store.markRunLost);
  const seek = useRunStore((store) => store.seek);
  const cancelReplay = useRunStore((store) => store.cancelReplay);
  const cursor = useRunStore((store) => store.cursor);
  const events = useRunStore((store) => store.events);
  const playback = useRunStore((store) => store.playback);
  const state = useRunStore((store) => store.state);
  const unsubRef = useRef<(() => void)>();
  const rulesDirtyRef = useRef(false);
  const onRulesDirty = useCallback((dirty: boolean) => { rulesDirtyRef.current = dirty; }, []);
  // Client-side fixture replay timer (no server run backs it).
  const offlineTimerRef = useRef<number>();
  const [replayPlaying, setReplayPlaying] = useState(false);

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

  const logout = useCallback(async () => {
    unsubRef.current?.();
    await api.logout();
    setOperator(undefined);
    setEntering(false);
  }, []);

  useEffect(() => {
    loadDefinition(WORKFLOWS[workflowId]!, mode);
  }, [workflowId, mode, loadDefinition]);

  const streamRun = useCallback((id: string) => {
    unsubRef.current?.();
    // Opening a finished or reconnected run replays its whole history in one
    // burst; applying events in ~50 ms batches renders once per batch instead
    // of once per event (thousands of renders froze office PCs for seconds).
    let queue: WorkflowEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => { timer = undefined; const batch = queue; queue = []; pushEvents(batch); };
    const unsubscribe = api.streamEvents(id, (event) => {
      queue.push(event);
      timer ??= setTimeout(flush, EVENT_BATCH_MS);
    }, (error) => {
      // Keep order: whatever arrived before the error lands first.
      if (timer !== undefined) { clearTimeout(timer); flush(); }
      if (/unauthorized/i.test(error.message)) return onUnauthorized();
      const lost = runLostMessage(error.message);
      // Otherwise the projection sits in "Berjalan" forever with nothing behind it.
      if (lost) markRunLost(lost);
      setLiveError(lost ?? error.message);
    });
    // Leaving this run drops its unapplied tail: the next run has already reset the store.
    unsubRef.current = () => { unsubscribe(); if (timer !== undefined) clearTimeout(timer); queue = []; };
  }, [onUnauthorized, pushEvents, markRunLost]);

  // Auto-advance the replay from `fromIndex` up to `total`, storing the timer so
  // a restart, pause, or cancel can stop it cleanly.
  const startOfflineTimer = useCallback((fromIndex: number, total: number) => {
    if (offlineTimerRef.current !== undefined) window.clearInterval(offlineTimerRef.current);
    let index = fromIndex;
    setReplayPlaying(true);
    offlineTimerRef.current = window.setInterval(() => {
      index += 1;
      seek(index);
      if (index >= total) {
        window.clearInterval(offlineTimerRef.current);
        offlineTimerRef.current = undefined;
        setReplayPlaying(false);
      }
    }, 120);
  }, [seek]);

  const pauseReplay = useCallback(() => {
    if (offlineTimerRef.current !== undefined) window.clearInterval(offlineTimerRef.current);
    offlineTimerRef.current = undefined;
    setReplayPlaying(false);
  }, []);

  const playReplay = useCallback(() => {
    const total = events.length;
    if (total === 0) return;
    // At (or past) the end, replay from the start; otherwise continue from here.
    startOfflineTimer(cursor >= total ? 0 : cursor, total);
  }, [cursor, events.length, startOfflineTimer]);

  const runOffline = useCallback(() => {
    const definition = WORKFLOWS[workflowId]!;
    // The fixture takes the IGD branch so the flexible view shows a path taken and one not taken.
    const poli = definition.edges.find((edge) => edge.source === 'detect_origin' && edge.target === 'process_poli');
    const stream = mockEventStream(definition, {
      runId: `offline-${workflowId}`,
      exampleReasoning: true,
      ...(poli ? { branches: { [poli.id]: 'skip' as const }, skip: [poli.target] } : {}),
    });
    setRunId(`offline-${workflowId}`);
    setSelectedHistoryRun(undefined);
    loadReplay(definition, stream, mode);
    setPage('run');
    startOfflineTimer(0, stream.length);
  }, [loadReplay, mode, startOfflineTimer, workflowId]);

  const runLive = useCallback(async () => {
    setLiveError(undefined);
    const blocker = liveStartBlockerOf('live', runInput);
    if (blocker) {
      setLiveError(blocker);
      return;
    }
    setStarting(true);
    try {
      const definition = await api.getWorkflow(workflowId);
      loadDefinition(definition, mode);
      const { runId: id } = await api.createRun({
        workflowId,
        mode,
        input: runInput.input,
        enabled: runInput.enabled,
        source: 'live',
        // Only meaningful on a write run; preview refuses it server-side.
        ...(mode === 'write' && autoApprove ? { autoApprove: true } : {}),
      });
      setRunId(id);
      setSelectedHistoryRun(undefined);
      // A refresh reopens the run through the `?run=` deep link below.
      history.replaceState(null, '', `?run=${encodeURIComponent(id)}`);
      setPage('run');
      streamRun(id);
      toast('info', `Run dimulai · ${id}`);
    } catch (error) {
      if (error instanceof UnauthorizedError) return onUnauthorized();
      setLiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [autoApprove, loadDefinition, mode, onUnauthorized, runInput, streamRun, workflowId]);

  const start = useCallback(() => {
    if (starting) return;
    setRunNonce((n) => n + 1);
    if (source === 'offline') runOffline();
    else void runLive();
  }, [runLive, runOffline, source, starting]);


  const openHistoryRun = useCallback(async (run: RunSummary) => {
    setLiveError(undefined);
    try {
      const definition = await api.getWorkflow(run.workflowId);
      setWorkflowId(run.workflowId);
      setMode(run.mode);
      setRunId(run.runId);
      history.replaceState(null, '', `?run=${encodeURIComponent(run.runId)}`);
      setSelectedHistoryRun(run);
      loadDefinition(definition, run.mode);
      setPage('run');
      streamRun(run.runId);
    } catch (error) {
      if (error instanceof UnauthorizedError) return onUnauthorized();
      setLiveError(error instanceof Error ? error.message : String(error));
    }
  }, [loadDefinition, onUnauthorized, streamRun]);

  // Deep link: `?run=<id>` reopens a run the orchestrator still tracks (or its ledger replay).
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('run');
    if (!id) return;
    void api.listRuns().then(({ runs }) => {
      const run = runs.find((r) => r.runId === id);
      if (run) void openHistoryRun(run);
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
      unsubRef.current?.();
      unsubRef.current = undefined;
      if (location.search) history.replaceState(null, '', location.pathname);
    }
    setLiveError(undefined);
    setPage(normalized);
  }, []);

  /**
   * Changing workflow or mode in Setup reloads a pristine definition, so the
   * finished run is no longer on screen; drop its id too, or the command bar
   * keeps naming a run that is gone. Setup is locked while a run is live.
   */
  const forgetRun = useCallback(() => {
    pauseReplay();
    unsubRef.current?.();
    unsubRef.current = undefined;
    setRunId(undefined);
    setSelectedHistoryRun(undefined);
    if (location.search) history.replaceState(null, '', location.pathname);
  }, [pauseReplay]);

  const cancel = useCallback(() => {
    if (!runId) return;
    // Fixture replays run entirely client-side — there is no server run to cancel,
    // so hitting /cancel would 404. Just stop the local replay timer instead.
    if (runId.startsWith('offline-')) {
      pauseReplay();
      cancelReplay();
      return;
    }
    void api.cancel(runId).catch((error: unknown) => setLiveError(error instanceof Error ? error.message : String(error)));
  }, [runId]);

  const pauseRun = useCallback(() => {
    if (!runId) return;
    if (runId.startsWith('offline-')) return pauseReplay();
    void api.pause(runId).catch((error: unknown) => setLiveError(error instanceof Error ? error.message : String(error)));
  }, [pauseReplay, runId]);
  const resumeRun = useCallback(() => {
    if (!runId) return;
    if (runId.startsWith('offline-')) return playReplay();
    void api.resume(runId).catch((error: unknown) => setLiveError(error instanceof Error ? error.message : String(error)));
  }, [playReplay, runId]);

  // Decision handlers resolve once the server answers, so the inspector can hold a
  // pending state until then; outcomes surface as toasts and errors as liveError.
  const approveGate = useCallback(async (nodeId: string) => {
    if (!runId) return;
    setLiveError(undefined);
    try {
      await api.approveGate(runId, nodeId, 'approved via UI');
      toast('success', 'Gate disetujui');
    } catch (error) {
      setLiveError(gateActionError('approve', error));
    }
  }, [runId]);
  const rejectGate = useCallback(async (nodeId: string) => {
    if (!runId) return;
    setLiveError(undefined);
    try {
      await api.rejectGate(runId, nodeId, 'rejected via UI');
      toast('warning', 'Gate ditolak');
    } catch (error) {
      setLiveError(gateActionError('reject', error));
    }
  }, [runId]);
  /**
   * A mutation plan sits in `planned` state until every required operator
   * approves it. Without this bridge the UI showed the plan but had no way to
   * fire the write, so a "confirmed write" run would stall silently — the
   * exact symptom for RM 0-90-00-08.
   */
  const approveMutation = useCallback(async (planId: string) => {
    if (!runId) return;
    setLiveError(undefined);
    try {
      await api.approveMutation(runId, planId, 'approved via UI');
      toast('success', 'Mutasi disetujui · menunggu verifikasi');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setLiveError(`Gagal menyetujui mutasi: ${detail}`);
    }
  }, [runId]);

  // Errors raised while another page is open (e.g. opening a run from History)
  // would otherwise sit unseen on the Run page.
  useEffect(() => {
    if (liveError && page !== 'run') toast('danger', liveError);
  }, [liveError, page]);

  useEffect(() => () => {
    unsubRef.current?.();
    if (offlineTimerRef.current !== undefined) window.clearInterval(offlineTimerRef.current);
  }, []);

  if (!authChecked) {
    return <div className="login-shell"><Card className="login-card" role="status"><CardBody className="page-loading"><Spinner size="sm" /> Memuat sesi…</CardBody></Card></div>;
  }
  if (!operator) return <LoginGate onLoggedIn={handleLoggedIn} />;

  const startBlocker =
    liveStartBlockerOf(source, runInput) ??
    (mode === 'write' && source === 'offline'
      ? 'Confirmed write butuh sumber "Live SIMRS" — fixture replay tidak menjalankan script maupun menulis apa pun.'
      : undefined);

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
      {page === 'home' ? <DashboardHome onNavigate={changePage} onOpenRun={(run) => void openHistoryRun(run)} onOpenPatients={(f) => { setPatientFilter(f); changePage('rekap'); }} onUnauthorized={onUnauthorized} /> : null}
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
          hasRunContext={hasRunContext}
          runId={runId}
          runNonce={runNonce}
          state={state}
          liveError={liveError}
          historical={historical}
          starting={starting}
          onOpenHistory={() => changePage('history')}
          onDismissError={() => setLiveError(undefined)}
          autoApprove={autoApprove}
          onAutoApproveChange={setAutoApprove}
          playback={playback}
          cursor={cursor}
          eventCount={events.length}
          onCancel={cancel}
          onPause={pauseRun}
          onResume={resumeRun}
          onApproveGate={approveGate}
          onRejectGate={rejectGate}
          onApproveMutation={approveMutation}
          onSeek={seek}
          replayPlaying={replayPlaying}
          onPlayReplay={playReplay}
          onPauseReplay={pauseReplay}
        />
      ) : null}
      {page === 'rekap' ? <RekapPage onUnauthorized={onUnauthorized} initialFilter={patientFilter} /> : null}
      {page === 'naik-kelas' ? <NaikKelasPage onUnauthorized={onUnauthorized} /> : null}
      {page === 'history' ? <RunHistory onOpenRun={(run) => void openHistoryRun(run)} onUnauthorized={onUnauthorized} workflowLabels={WORKFLOW_LABELS} /> : null}
      {page === 'review' ? (
        <ReviewQueue
          state={state}
          runId={runId}
          hasReviewContext={hasReviewContext}
          onApproveGate={approveGate}
          onRejectGate={rejectGate}
          onOpenRun={() => changePage('run')}
        />
      ) : null}
      {page === 'rules' ? <RuleCatalogPage onUnauthorized={onUnauthorized} onDirtyChange={onRulesDirty} /> : null}
      {page === 'settings' ? <SettingsHealth onUnauthorized={onUnauthorized} /> : null}
    </DashboardShell>
    <ToastHost />
    </>
  );
}
