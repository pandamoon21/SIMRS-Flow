import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { mockEventStream } from '@simrs-flow/test-fixtures';
import type { CreateRunRequest } from '@simrs-flow/api-contract';
import type { WorkflowEvent } from '@simrs-flow/workflow-core';
import { UnauthorizedError } from '../api/client.js';
import { useRunStore } from '../store/runStore.js';
import { runStoreProjection } from './createRunSession.js';
import { EVENT_BATCH_MS, REPLAY_STEP_MS, RunSession, type RunApi, type RunProjection, type RunSessionHooks } from './runSession.js';

const STREAM = mockEventStream(ranapWorkflow, { runId: 'run-1' });

function fakeApi(overrides: Partial<RunApi> = {}) {
  const stream: { onEvent?: (e: WorkflowEvent) => void; onError?: (e: Error) => void; closed: number } = { closed: 0 };
  const api = {
    getWorkflow: vi.fn(async () => ranapWorkflow),
    createRun: vi.fn(async () => ({ runId: 'run-1' })),
    streamEvents: vi.fn((_id: string, onEvent: (e: WorkflowEvent) => void, onError?: (e: Error) => void) => {
      stream.onEvent = onEvent;
      stream.onError = onError;
      return () => { stream.closed += 1; };
    }),
    cancel: vi.fn(async () => ({ cancelled: true })),
    pause: vi.fn(async () => ({ paused: true })),
    resume: vi.fn(async () => ({ resumed: true })),
    approveGate: vi.fn(async () => ({ approved: true, resolved: true, remainingApprovals: 0 })),
    rejectGate: vi.fn(async () => ({ rejected: true })),
    approveMutation: vi.fn(async () => ({ approved: true, resolved: true, approvals: [], remainingApprovals: 0 })),
    ...overrides,
  } satisfies RunApi;
  return { api, stream };
}

function hooks() {
  return { onError: vi.fn<[string], void>(), onUnauthorized: vi.fn<[], void>() } satisfies RunSessionHooks;
}

const fixtures = {
  sampleInput: vi.fn(async () => ({ noRm: '0-12-34-56', tanggal: '2026-06-10' })),
  replayStream: vi.fn(async () => mockEventStream(ranapWorkflow, { runId: 'offline-ranap' })),
};

beforeEach(() => {
  vi.useFakeTimers();
  useRunStore.getState().reset();
});
afterEach(() => { vi.useRealTimers(); });

describe('run session: live stream', () => {
  it('applies streamed events in batches, one store update per batch window', async () => {
    const { api, stream } = fakeApi();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: hooks() });
    await session.openRun({ runId: 'run-1', workflowId: ranapWorkflow.id, mode: 'preview' });
    let updates = 0;
    const unsubscribe = useRunStore.subscribe(() => { updates += 1; });
    for (const event of STREAM.slice(0, 5)) stream.onEvent!(event);
    expect(useRunStore.getState().events).toHaveLength(0);
    vi.advanceTimersByTime(EVENT_BATCH_MS);
    expect(useRunStore.getState().events.map((e) => e.seq)).toEqual(STREAM.slice(0, 5).map((e) => e.seq));
    expect(updates).toBe(1);
    unsubscribe();
  });

  it('on a stream error lands the pending batch first, then ends a lost run', async () => {
    const { api, stream } = fakeApi();
    const calls: string[] = [];
    const real = runStoreProjection();
    const store: RunProjection = {
      ...real,
      pushEvents: (events) => { calls.push(`push:${events.length}`); real.pushEvents(events); },
      markRunLost: (message) => { calls.push('lost'); real.markRunLost(message); },
    };
    const h = hooks();
    h.onError.mockImplementation(() => { calls.push('error'); });
    const session = new RunSession({ api, store, fixtures, hooks: h });
    await session.openRun({ runId: 'run-1', workflowId: ranapWorkflow.id, mode: 'preview' });
    for (const event of STREAM.slice(0, 3)) stream.onEvent!(event);
    stream.onError!(new Error('run_not_found'));
    expect(calls).toEqual(['push:3', 'lost', 'error']);
    expect(useRunStore.getState().state?.status).toBe('failed');
    expect(h.onError.mock.calls[0]![0]).toMatch(/tidak ditemukan lagi/);
    // The flushed batch's timer is gone: nothing is applied twice.
    vi.advanceTimersByTime(EVENT_BATCH_MS * 2);
    expect(useRunStore.getState().events).toHaveLength(4);
  });

  it('routes a 401 on the stream to onUnauthorized without ending the run', async () => {
    const { api, stream } = fakeApi();
    const h = hooks();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: h });
    await session.openRun({ runId: 'run-1', workflowId: ranapWorkflow.id, mode: 'preview' });
    stream.onEvent!(STREAM[0]!);
    stream.onError!(new Error('unauthorized'));
    expect(h.onUnauthorized).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
    expect(useRunStore.getState().events).toHaveLength(1);
    expect(useRunStore.getState().state?.status).not.toBe('failed');
  });

  it('drops the unapplied tail when the run is left', async () => {
    const { api, stream } = fakeApi();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: hooks() });
    await session.openRun({ runId: 'run-1', workflowId: ranapWorkflow.id, mode: 'preview' });
    stream.onEvent!(STREAM[0]!);
    session.detach();
    vi.advanceTimersByTime(EVENT_BATCH_MS);
    expect(stream.closed).toBe(1);
    expect(useRunStore.getState().events).toHaveLength(0);
    // Still the run on screen: commands keep reaching the server.
    session.cancel();
    expect(api.cancel).toHaveBeenCalledWith('run-1');
  });
});

describe('run session: starting runs', () => {
  it('sends autoApprove only on a write run that asked for it', async () => {
    const { api } = fakeApi();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: hooks() });
    const input = { noRm: '0-12-34-56', tanggal: '2026-06-10' };
    await session.startLive({ workflowId: ranapWorkflow.id, mode: 'preview', input, autoApprove: true });
    await session.startLive({ workflowId: ranapWorkflow.id, mode: 'write', input, autoApprove: false });
    await session.startLive({ workflowId: ranapWorkflow.id, mode: 'write', input, autoApprove: true });
    const bodies = vi.mocked(api.createRun).mock.calls.map((call) => call[0] as CreateRunRequest);
    expect(bodies.map((body) => body.autoApprove)).toEqual([undefined, undefined, true]);
    expect(bodies.every((body) => body.source === 'live')).toBe(true);
  });

  it('reports a failed start and clears `starting`', async () => {
    const { api } = fakeApi({ createRun: vi.fn(async () => { throw new Error('POST /api/runs → 409: locked'); }) });
    const h = hooks();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: h });
    expect(await session.startLive({ workflowId: ranapWorkflow.id, mode: 'preview' })).toBeUndefined();
    expect(h.onError).toHaveBeenCalledWith('POST /api/runs → 409: locked');
    expect(session.getSnapshot().starting).toBe(false);
  });

  it('runs a preview sample on the server, falling back to the client replay', async () => {
    const live = fakeApi();
    const session = new RunSession({ api: live.api, store: runStoreProjection(), fixtures, hooks: hooks() });
    expect(await session.startSample(ranapWorkflow, 'preview')).toEqual({ runId: 'run-1', kind: 'live' });
    expect(live.api.createRun).toHaveBeenCalledWith(expect.objectContaining({ source: 'fixture', mode: 'preview' }));

    const down = fakeApi({ getWorkflow: vi.fn(async () => { throw new Error('GET /api/workflows → 502'); }) });
    const offline = new RunSession({ api: down.api, store: runStoreProjection(), fixtures, hooks: hooks() });
    expect(await offline.startSample(ranapWorkflow, 'preview')).toEqual({ runId: 'offline-ranap', kind: 'replay' });
    offline.dispose();
  });

  it('does not fall back to a replay when the login is gone', async () => {
    const { api } = fakeApi({ getWorkflow: vi.fn(async () => { throw new UnauthorizedError(); }) });
    const h = hooks();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: h });
    expect(await session.startSample(ranapWorkflow, 'preview')).toBeUndefined();
    expect(h.onUnauthorized).toHaveBeenCalledOnce();
    expect(session.getSnapshot().kind).toBeUndefined();
  });
});

describe('run session: fixture replay', () => {
  it('pauses and resumes from the cursor, and restarts from 0 at the end', async () => {
    const { api } = fakeApi();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: hooks() });
    await session.startReplay(ranapWorkflow, 'preview');
    const total = useRunStore.getState().events.length;
    expect(session.getSnapshot()).toMatchObject({ kind: 'replay', replayPlaying: true });

    vi.advanceTimersByTime(REPLAY_STEP_MS * 3);
    expect(useRunStore.getState().cursor).toBe(3);
    session.pause();
    vi.advanceTimersByTime(REPLAY_STEP_MS * 5);
    expect(useRunStore.getState().cursor).toBe(3);
    expect(session.getSnapshot().replayPlaying).toBe(false);

    session.resume();
    vi.advanceTimersByTime(REPLAY_STEP_MS * 2);
    expect(useRunStore.getState().cursor).toBe(5);

    vi.advanceTimersByTime(REPLAY_STEP_MS * total);
    expect(useRunStore.getState().cursor).toBe(total);
    expect(session.getSnapshot().replayPlaying).toBe(false);

    session.playReplay();
    vi.advanceTimersByTime(REPLAY_STEP_MS);
    expect(useRunStore.getState().cursor).toBe(1);
    session.dispose();
  });

  it('cancels locally (synthetic run.cancelled) and never calls the server', async () => {
    const { api } = fakeApi();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: hooks() });
    await session.startReplay(ranapWorkflow, 'preview');
    vi.advanceTimersByTime(REPLAY_STEP_MS * 4);
    session.cancel();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(useRunStore.getState().state?.status).toBe('cancelled');
    expect(useRunStore.getState().events.at(-1)?.type).toBe('run.cancelled');
    expect(await session.approveGate('final_gate')).toBe(false);
    expect(api.approveGate).not.toHaveBeenCalled();
  });

  it('decides live vs replay by adapter, not by the run id prefix', async () => {
    const { api } = fakeApi({ createRun: vi.fn(async () => ({ runId: 'offline-lookalike' })) });
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: hooks() });
    await session.startLive({ workflowId: ranapWorkflow.id, mode: 'preview' });
    session.pause();
    session.cancel();
    expect(api.pause).toHaveBeenCalledWith('offline-lookalike');
    expect(api.cancel).toHaveBeenCalledWith('offline-lookalike');
  });

  it('stops a playing replay when a live run starts', async () => {
    const { api } = fakeApi();
    const session = new RunSession({ api, store: runStoreProjection(), fixtures, hooks: hooks() });
    await session.startReplay(ranapWorkflow, 'preview');
    await session.startLive({ workflowId: ranapWorkflow.id, mode: 'preview' });
    expect(session.getSnapshot()).toMatchObject({ kind: 'live', replayPlaying: false });
    vi.advanceTimersByTime(REPLAY_STEP_MS * 5);
    expect(useRunStore.getState().cursor).toBe(0);
  });
});
