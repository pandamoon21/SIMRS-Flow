import { describe, it, expect, beforeEach } from 'vitest';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { mockEventStream } from '@simrs-flow/test-fixtures';
import { useRunStore } from '../src/store/runStore.js';

beforeEach(() => {
  useRunStore.getState().reset();
});

describe('runStore', () => {
  it('loads a definition into a pristine state', () => {
    useRunStore.getState().loadDefinition(ranapWorkflow, 'preview');
    const { state } = useRunStore.getState();
    expect(state?.status).toBe('created');
    expect(Object.keys(state!.nodes)).toHaveLength(ranapWorkflow.nodes.length);
    expect(state!.nodes.load_visits!.status).toBe('pending');
  });

  it('applies a mock event stream via replay seek to reach a terminal state', () => {
    const stream = mockEventStream(ranapWorkflow, { runId: 'ui-test' });
    const store = useRunStore.getState();
    store.loadReplay(ranapWorkflow, stream, 'preview');
    // Seek to the end.
    useRunStore.getState().seek(stream.length);
    const { state } = useRunStore.getState();
    expect(state?.status).toBe('completed');
    // Mutate nodes are rendered as needs_review by the mock player.
    expect(state!.nodes.execute_verifikasi!.status).toBe('needs_review');
  });

  it('ends a live run the orchestrator lost, once, and never a finished one', () => {
    const stream = mockEventStream(ranapWorkflow, { runId: 'ui-lost' });
    useRunStore.getState().loadDefinition(ranapWorkflow, 'preview');
    for (const event of stream.slice(0, 4)) useRunStore.getState().pushEvent(event);
    expect(useRunStore.getState().state!.status).toBe('running');
    useRunStore.getState().markRunLost('hilang');
    useRunStore.getState().markRunLost('hilang');
    const { state, events } = useRunStore.getState();
    expect(state!.status).toBe('failed');
    expect(state!.summary).toBe('hilang');
    expect(events.filter((e) => e.eventId?.endsWith('-lost'))).toHaveLength(1);
  });

  it('scrubbing backward re-projects fewer events deterministically', () => {
    const stream = mockEventStream(ranapWorkflow, { runId: 'ui-scrub' });
    useRunStore.getState().loadReplay(ranapWorkflow, stream, 'preview');
    useRunStore.getState().seek(stream.length);
    const full = useRunStore.getState().state!.status;
    useRunStore.getState().seek(3);
    const partial = useRunStore.getState().state!;
    expect(full).toBe('completed');
    expect(partial.status).not.toBe('completed');
  });

  it('pushEvent advances live state incrementally', () => {
    const stream = mockEventStream(ranapWorkflow, { runId: 'ui-live' });
    useRunStore.getState().loadDefinition(ranapWorkflow, 'preview');
    for (const e of stream) useRunStore.getState().pushEvent(e);
    expect(useRunStore.getState().state?.status).toBe('completed');
    expect(useRunStore.getState().events).toHaveLength(stream.length);
  });

  it('projects run logs from the mock event stream', () => {
    const stream = mockEventStream(ranapWorkflow, { runId: 'ui-logs' });
    useRunStore.getState().loadDefinition(ranapWorkflow, 'preview');
    for (const e of stream) useRunStore.getState().pushEvent(e);

    const { state } = useRunStore.getState();
    expect(state?.logs.length).toBeGreaterThan(0);
    expect(state?.logs.some((l) => l.message.includes('Mock run started'))).toBe(true);
    expect(state?.logs.some((l) => l.message.includes('Running'))).toBe(true);
  });

  it('clears only the console display baseline and preserves event history', () => {
    const stream = mockEventStream(ranapWorkflow, { runId: 'ui-clear-console' });
    useRunStore.getState().loadDefinition(ranapWorkflow, 'preview');
    for (const e of stream.slice(0, 6)) useRunStore.getState().pushEvent(e);

    const beforeClear = useRunStore.getState();
    const lastSeqBeforeClear = beforeClear.state!.lastSeq;
    expect(beforeClear.state!.logs.length).toBeGreaterThan(0);

    useRunStore.getState().clearConsole();
    expect(useRunStore.getState().consoleClearedThroughSeq).toBe(lastSeqBeforeClear);
    expect(useRunStore.getState().events).toHaveLength(6);
    expect(useRunStore.getState().state!.logs.length).toBe(beforeClear.state!.logs.length);

    const nextLogEvent = stream.slice(6).find((e) => e.message !== undefined)!;
    useRunStore.getState().pushEvent(nextLogEvent);
    const afterClear = useRunStore.getState();
    const visibleMessages = afterClear.state!.logs
      .filter((l) => l.seq > afterClear.consoleClearedThroughSeq)
      .map((l) => l.message);
    expect(visibleMessages).toEqual([nextLogEvent.message]);
  });
});
