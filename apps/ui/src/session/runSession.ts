/**
 * Run session: the one run the Run page is showing, and every command that acts
 * on it. Pure TypeScript (no React), so batching, replay and recovery are
 * testable in node; App only mirrors {@link RunSessionSnapshot} and handles
 * navigation, the URL and toasts.
 *
 * A run is driven by one of two adapters, chosen when it starts:
 *  - live: an orchestrator run (real SIMRS or its fixture transport), followed
 *    over SSE with events applied in batches; commands go to the API.
 *  - replay: a client-side fixture stream played on a timer; commands act on
 *    the timer and the store, never on a server (there is no server run).
 * Which one is active decides how cancel/pause/resume behave — not the run id.
 */

import type { CreateRunRequest, RunInput, RunSummary } from '@simrs-flow/api-contract';
import type { ExecutionMode, WorkflowDefinition, WorkflowEvent } from '@simrs-flow/workflow-core';
import { UnauthorizedError, type api } from '../api/client.js';

/** Streamed events are applied in batches this far apart (one render per batch). */
export const EVENT_BATCH_MS = 50;
/** A fixture replay advances one event per tick. */
export const REPLAY_STEP_MS = 120;

/** A stream error that means the run is gone for good → the operator-facing reason; else undefined. */
export function runLostMessage(error: string): string | undefined {
  if (/run_not_found/.test(error)) return 'Run tidak ditemukan lagi di orchestrator (kemungkinan orchestrator restart) — hasil run ini hilang, jalankan ulang.';
  // The ledger replay of a run that never finished: the orchestrator stopped or restarted mid-run.
  if (/no terminal event|ended with a partial line/.test(error)) return 'Run terputus — orchestrator berhenti atau dimulai ulang saat run berjalan. Langkah yang sudah tercatat tetap ada di History; jalankan ulang run untuk menyelesaikannya.';
  if (/gagal setelah beberapa percobaan/.test(error)) return 'Koneksi ke orchestrator putus — status run ini tidak bisa diikuti lagi. Cek orchestrator lalu buka run dari History.';
  return undefined;
}

/** A gate decision that silently fails looks identical to one that was accepted. */
export function gateActionError(action: 'approve' | 'reject', error: unknown): string {
  return `Gagal ${action === 'approve' ? 'menyetujui' : 'menolak'} gate: ${messageOf(error)}`;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The orchestrator calls a session makes; `api` in the app, a fake in tests. */
export type RunApi = Pick<typeof api, 'getWorkflow' | 'createRun' | 'streamEvents' | 'cancel' | 'pause' | 'resume' | 'approveGate' | 'rejectGate' | 'approveMutation'>;

/** The store operations a session drives (the run store's projection API). */
export interface RunProjection {
  loadDefinition(def: WorkflowDefinition, mode: ExecutionMode): void;
  loadReplay(def: WorkflowDefinition, events: WorkflowEvent[], mode: ExecutionMode): void;
  pushEvents(events: readonly WorkflowEvent[]): void;
  seek(cursor: number): void;
  cancelReplay(): void;
  markRunLost(message: string): void;
  cursor(): number;
  eventCount(): number;
}

/** Synthetic data for sample runs; loaded lazily so fixtures stay out of the main bundle. */
export interface FixtureSource {
  sampleInput(domain: string): Promise<RunInput>;
  replayStream(definition: WorkflowDefinition): Promise<WorkflowEvent[]>;
}

export interface RunSessionHooks {
  /** An operator-facing failure (stream, command or start). */
  onError(message: string): void;
  /** The orchestrator answered 401: the login is gone. */
  onUnauthorized(): void;
}

export type RunKind = 'live' | 'replay';

export interface RunSessionSnapshot {
  runId?: string;
  /** Which adapter drives the run on screen; undefined when none does. */
  kind?: RunKind;
  /** A replay timer is advancing the cursor. */
  replayPlaying: boolean;
  /** A live start is between Start and the run id coming back. */
  starting: boolean;
}

/** What the Run page can ask of the run on screen. */
export interface RunCommands {
  cancel(): void;
  pause(): void;
  resume(): void;
  /** Resolve true when the orchestrator accepted the decision. */
  approveGate(nodeId: string): Promise<boolean>;
  rejectGate(nodeId: string): Promise<boolean>;
  approveMutation(planId: string): Promise<boolean>;
  seek(cursor: number): void;
  playReplay(): void;
  pauseReplay(): void;
}

export interface StartedRun {
  runId: string;
  kind: RunKind;
}

export interface LiveStart {
  workflowId: string;
  mode: ExecutionMode;
  input?: RunInput;
  enabled?: Record<string, boolean>;
  /** Honoured on write runs only; preview never sends it. */
  autoApprove?: boolean;
}

export interface RunSessionDeps {
  api: RunApi;
  store: RunProjection;
  fixtures: FixtureSource;
  hooks: RunSessionHooks;
}

export class RunSession implements RunCommands {
  private snapshot: RunSessionSnapshot = { replayPlaying: false, starting: false };
  private readonly listeners = new Set<() => void>();
  private closeStream?: () => void;
  private replayTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RunSessionDeps) {}

  // ── Observation (useSyncExternalStore) ──
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RunSessionSnapshot => this.snapshot;

  private patch(next: Partial<RunSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private fail(error: unknown): void {
    if (error instanceof UnauthorizedError) this.deps.hooks.onUnauthorized();
    else this.deps.hooks.onError(messageOf(error));
  }

  // ── Starting and opening runs ──

  /**
   * "Data contoh" in preview: the real executors on synthetic SIMRS data (the
   * orchestrator's fixture transport, never SIMRS), so the sample shows what a
   * live run shows. Write mode, or an unreachable orchestrator, gets the
   * client-side replay instead. Undefined when the login is gone.
   */
  async startSample(definition: WorkflowDefinition, mode: ExecutionMode): Promise<StartedRun | undefined> {
    if (mode !== 'preview') return this.startReplay(definition, mode);
    try {
      const served = await this.deps.api.getWorkflow(definition.id);
      const input = await this.deps.fixtures.sampleInput(served.domain);
      const { runId } = await this.deps.api.createRun({ workflowId: definition.id, mode: 'preview', input, source: 'fixture' });
      this.deps.store.loadDefinition(served, 'preview');
      this.attachLive(runId);
      return { runId, kind: 'live' };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        this.deps.hooks.onUnauthorized();
        return undefined;
      }
      return this.startReplay(definition, mode);
    }
  }

  /** Play a fixture stream client-side from the first event. */
  async startReplay(definition: WorkflowDefinition, mode: ExecutionMode): Promise<StartedRun> {
    const stream = await this.deps.fixtures.replayStream(definition);
    const runId = stream[0]?.runId ?? `offline-${definition.id}`;
    this.stopAll();
    this.deps.store.loadReplay(definition, stream, mode);
    this.patch({ runId, kind: 'replay' });
    this.startReplayTimer(0, stream.length);
    return { runId, kind: 'replay' };
  }

  /** Start an orchestrator run and follow it. Undefined (error reported) when it could not start. */
  async startLive(request: LiveStart): Promise<StartedRun | undefined> {
    if (this.snapshot.starting) return undefined;
    this.patch({ starting: true });
    try {
      const definition = await this.deps.api.getWorkflow(request.workflowId);
      this.deps.store.loadDefinition(definition, request.mode);
      const body: CreateRunRequest = {
        workflowId: request.workflowId,
        mode: request.mode,
        input: request.input,
        enabled: request.enabled,
        source: 'live',
        // Only meaningful on a write run; preview refuses it server-side.
        ...(request.mode === 'write' && request.autoApprove ? { autoApprove: true } : {}),
      };
      const { runId } = await this.deps.api.createRun(body);
      this.attachLive(runId);
      return { runId, kind: 'live' };
    } catch (error) {
      this.fail(error);
      return undefined;
    } finally {
      this.patch({ starting: false });
    }
  }

  /** Reopen a run the orchestrator tracks (or its ledger replay). Resolves its definition, or undefined on error. */
  async openRun(run: Pick<RunSummary, 'runId' | 'workflowId' | 'mode'>): Promise<WorkflowDefinition | undefined> {
    try {
      const definition = await this.deps.api.getWorkflow(run.workflowId);
      this.deps.store.loadDefinition(definition, run.mode);
      this.attachLive(run.runId);
      return definition;
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  /**
   * Follow a live run over SSE. Opening a finished or reconnected run replays
   * its whole history in one burst; applying events in ~50 ms batches renders
   * once per batch instead of once per event (thousands of renders froze office
   * PCs for seconds).
   */
  private attachLive(runId: string): void {
    this.stopAll();
    const { store, hooks } = this.deps;
    let queue: WorkflowEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => { timer = undefined; const batch = queue; queue = []; store.pushEvents(batch); };
    const unsubscribe = this.deps.api.streamEvents(runId, (event) => {
      queue.push(event);
      timer ??= setTimeout(flush, EVENT_BATCH_MS);
    }, (error) => {
      // Keep order: whatever arrived before the error lands first.
      if (timer !== undefined) { clearTimeout(timer); flush(); }
      if (/unauthorized/i.test(error.message)) return hooks.onUnauthorized();
      const lost = runLostMessage(error.message);
      // Otherwise the projection sits in "Berjalan" forever with nothing behind it.
      if (lost) store.markRunLost(lost);
      hooks.onError(lost ?? error.message);
    });
    // Leaving this run drops its unapplied tail: the next run has already reset the store.
    this.closeStream = () => { unsubscribe(); if (timer !== undefined) clearTimeout(timer); queue = []; };
    this.patch({ runId, kind: 'live' });
  }

  // ── Leaving a run ──

  /** Stop following the live stream (page left, logout); the run stays on record and commandable. */
  detach(): void {
    this.closeStream?.();
    this.closeStream = undefined;
  }

  /** Drop the run entirely: no stream, no replay, no run id. */
  forget(): void {
    this.stopAll();
    this.patch({ runId: undefined, kind: undefined });
  }

  /** Release timers and the stream (unmount). */
  dispose(): void {
    this.stopAll();
  }

  private stopAll(): void {
    this.pauseReplay();
    this.detach();
  }

  // ── Commands ──

  cancel(): void {
    const { runId, kind } = this.snapshot;
    if (!runId) return;
    // A replay has no server run to cancel (/cancel would 404): stop the timer
    // and end the projection with a synthetic run.cancelled.
    if (kind === 'replay') {
      this.pauseReplay();
      this.deps.store.cancelReplay();
      return;
    }
    void this.deps.api.cancel(runId).catch((error: unknown) => this.deps.hooks.onError(messageOf(error)));
  }

  pause(): void {
    const { runId, kind } = this.snapshot;
    if (!runId) return;
    if (kind === 'replay') return this.pauseReplay();
    void this.deps.api.pause(runId).catch((error: unknown) => this.deps.hooks.onError(messageOf(error)));
  }

  resume(): void {
    const { runId, kind } = this.snapshot;
    if (!runId) return;
    if (kind === 'replay') return this.playReplay();
    void this.deps.api.resume(runId).catch((error: unknown) => this.deps.hooks.onError(messageOf(error)));
  }

  async approveGate(nodeId: string): Promise<boolean> {
    const runId = this.liveRunId();
    if (!runId) return false;
    try {
      await this.deps.api.approveGate(runId, nodeId, 'approved via UI');
      return true;
    } catch (error) {
      this.deps.hooks.onError(gateActionError('approve', error));
      return false;
    }
  }

  async rejectGate(nodeId: string): Promise<boolean> {
    const runId = this.liveRunId();
    if (!runId) return false;
    try {
      await this.deps.api.rejectGate(runId, nodeId, 'rejected via UI');
      return true;
    } catch (error) {
      this.deps.hooks.onError(gateActionError('reject', error));
      return false;
    }
  }

  /**
   * A mutation plan sits in `planned` state until every required operator
   * approves it. Without this bridge the UI showed the plan but had no way to
   * fire the write, so a "confirmed write" run would stall silently.
   */
  async approveMutation(planId: string): Promise<boolean> {
    const runId = this.liveRunId();
    if (!runId) return false;
    try {
      await this.deps.api.approveMutation(runId, planId, 'approved via UI');
      return true;
    } catch (error) {
      this.deps.hooks.onError(`Gagal menyetujui mutasi: ${messageOf(error)}`);
      return false;
    }
  }

  /** Gates and plans exist only on a server run; a replay has nothing to decide. */
  private liveRunId(): string | undefined {
    return this.snapshot.kind === 'live' ? this.snapshot.runId : undefined;
  }

  // ── Replay timer ──

  seek(cursor: number): void {
    this.deps.store.seek(cursor);
  }

  playReplay(): void {
    const total = this.deps.store.eventCount();
    if (total === 0) return;
    const cursor = this.deps.store.cursor();
    // At (or past) the end, replay from the start; otherwise continue from here.
    this.startReplayTimer(cursor >= total ? 0 : cursor, total);
  }

  pauseReplay(): void {
    if (this.replayTimer !== undefined) clearInterval(this.replayTimer);
    this.replayTimer = undefined;
    if (this.snapshot.replayPlaying) this.patch({ replayPlaying: false });
  }

  /** Auto-advance from `fromIndex` up to `total`; a restart, pause or cancel stops it cleanly. */
  private startReplayTimer(fromIndex: number, total: number): void {
    if (this.replayTimer !== undefined) clearInterval(this.replayTimer);
    let index = fromIndex;
    this.patch({ replayPlaying: true });
    this.replayTimer = setInterval(() => {
      index += 1;
      this.deps.store.seek(index);
      if (index >= total) {
        clearInterval(this.replayTimer);
        this.replayTimer = undefined;
        this.patch({ replayPlaying: false });
      }
    }, REPLAY_STEP_MS);
  }
}
