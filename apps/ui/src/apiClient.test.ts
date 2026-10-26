import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, UnauthorizedError } from '../src/api/client.js';

// jsdom-free: provide a minimal sessionStorage + fetch shim.
const store = new Map<string, string>();
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

type FetchArgs = { url: string; init?: RequestInit };
let calls: FetchArgs[] = [];
let responder: (a: FetchArgs) => { status: number; body: unknown };
let eventSources: FakeEventSource[] = [];

class FakeEventSource {
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    eventSources.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  calls = [];
  eventSources = [];
  store.clear();
  responder = () => ({ status: 200, body: {} });
  (globalThis as unknown as { EventSource: typeof EventSource }).EventSource = FakeEventSource as unknown as typeof EventSource;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = responder({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  void api.logout();
});

describe('UI api client — auth', () => {
  it('stores the token on login and attaches it to subsequent requests', async () => {
    responder = ({ url }) => {
      if (url.endsWith('/api/auth/login')) return { status: 200, body: { token: 'T1', operator: 'alice' } };
      return { status: 200, body: { workflows: [] } };
    };
    const { operator } = await api.login('alice', 'pw');
    expect(operator).toBe('alice');
    expect(api.isAuthenticated()).toBe(true);

    await api.listWorkflows();
    const wfCall = calls.find((c) => c.url.endsWith('/api/workflows'))!;
    const headers = wfCall.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer T1');
  });

  it('stores the QA token on QA login', async () => {
    responder = ({ url }) => {
      if (url.endsWith('/api/auth/qa-login')) return { status: 200, body: { token: 'QA1', operator: 'qa' } };
      return { status: 200, body: { workflows: [] } };
    };
    const { operator } = await api.qaLogin();
    expect(operator).toBe('qa');

    await api.listWorkflows();
    const wfCall = calls.find((c) => c.url.endsWith('/api/workflows'))!;
    const headers = wfCall.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer QA1');
  });
  it('throws the login error message on failure', async () => {
    responder = () => ({ status: 401, body: { message: 'invalid username or password' } });
    await expect(api.login('x', 'y')).rejects.toThrow(/invalid username or password/);
    expect(api.isAuthenticated()).toBe(false);
  });

  it('explains when login cannot reach the orchestrator', async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
      if (url.endsWith('/api/auth/logout')) return { ok: true, status: 200, json: async () => ({}) } as Response;
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(api.login('x', 'y')).rejects.toThrow(/Tidak dapat terhubung ke server/);
    expect(api.isAuthenticated()).toBe(false);
  });

  it('raises UnauthorizedError on a 401 from a protected GET', async () => {
    responder = ({ url }) => {
      if (url.endsWith('/api/auth/login')) return { status: 200, body: { token: 'T1', operator: 'a' } };
      return { status: 401, body: { error: 'not_authenticated' } };
    };
    await api.login('a', 'b');
    await expect(api.me()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('clears the token on logout', async () => {
    responder = ({ url }) =>
      url.endsWith('/api/auth/login') ? { status: 200, body: { token: 'T1', operator: 'a' } } : { status: 200, body: {} };
    await api.login('a', 'b');
    expect(api.isAuthenticated()).toBe(true);
    await api.logout();
    expect(api.isAuthenticated()).toBe(false);
  });

  it('loads public and authenticated health summaries', async () => {
    responder = ({ url }) => ({
      status: 200,
      body: url.endsWith('/api/health/details')
        ? { ok: true, ts: '2026-07-22T00:00:00.000Z', auditPersistent: true }
        : { ok: true, ts: '2026-07-22T00:00:00.000Z' },
    });

    expect(await api.health()).toMatchObject({ ok: true });
    expect(await api.healthDetail()).toMatchObject({ auditPersistent: true });
    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining([expect.stringMatching(/\/api\/health$/), expect.stringMatching(/\/api\/health\/details$/)]));
  });

  it('forwards source:live when creating a run', async () => {
    responder = ({ url }) =>
      url.endsWith('/api/auth/login')
        ? { status: 200, body: { token: 'T1', operator: 'a' } }
        : { status: 200, body: { runId: 'run_1' } };
    await api.login('a', 'b');
    await api.createRun({ workflowId: 'wf', mode: 'preview', input: {}, source: 'live' });
    const runCall = calls.find((c) => c.url.endsWith('/api/runs'))!;
    const sentBody = JSON.parse(runCall.init!.body as string);
    expect(sentBody.source).toBe('live');
  });

  it('forwards enabled node overrides when creating a run', async () => {
    responder = ({ url }) =>
      url.endsWith('/api/auth/login')
        ? { status: 200, body: { token: 'T1', operator: 'a' } }
        : { status: 200, body: { runId: 'run_1' } };
    await api.login('a', 'b');
    await api.createRun({
      workflowId: 'wf',
      mode: 'preview',
      input: {},
      enabled: { validate_radiology: false },
      source: 'live',
    });
    const runCall = calls.find((c) => c.url.endsWith('/api/runs'))!;
    const sentBody = JSON.parse(runCall.init!.body as string);
    expect(sentBody.enabled).toEqual({ validate_radiology: false });
  });

  it('includes browser credentials on reads and login', async () => {
    responder = ({ url }) =>
      url.endsWith('/api/auth/login')
        ? { status: 200, body: { token: 'T1', operator: 'a' } }
        : { status: 200, body: { runs: [] } };

    await api.login('a', 'b');
    await api.listRuns();

    expect(calls.find((call) => call.url.endsWith('/api/auth/login'))?.init?.credentials).toBe('include');
    expect(calls.find((call) => call.url.endsWith('/api/runs'))?.init?.credentials).toBe('include');
  });

  it('uses credentialed SSE, deduplicates replay, and closes on terminal events', () => {
    const received: string[] = [];
    const unsubscribe = api.streamEvents('run 1', (event) => received.push(event.type));
    const source = eventSources[0]!;
    const event = { eventId: 'e1', runId: 'run 1', seq: 1, type: 'run.completed' };

    expect(source.url).toContain('/api/runs/run%201/events');
    expect(source.options).toEqual({ withCredentials: true });
    source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    expect(received).toEqual(['run.completed']);
    expect(source.closed).toBe(true);

    unsubscribe();
    expect(source.closed).toBe(true);
  });

  it('reconnects with backoff on SSE errors instead of dying silently', () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      api.streamEvents('run-1', () => undefined, (error) => errors.push(error.message));
      const first = eventSources[0]!;

      // A transient error: report the outage once and schedule a reconnect —
      // the old behaviour closed the stream for good here.
      first.onerror?.(new Event('error'));
      expect(first.closed).toBe(true);
      expect(errors).toEqual(['Koneksi ke orchestrator terputus — menyambung ulang…']);
      expect(eventSources).toHaveLength(1);

      // The backoff timer fires and a fresh EventSource is opened. Its replayed
      // history is deduped by the surviving `seen` set.
      vi.advanceTimersByTime(1000);
      expect(eventSources).toHaveLength(2);
      const second = eventSources[1]!;
      expect(second.url).toContain('/api/runs/run-1/events');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after repeated SSE failures and reports the exhaustion', () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      api.streamEvents('run-1', () => undefined, (error) => errors.push(error.message));

      // Drive every reconnect attempt to failure.
      for (let i = 0; i < 9; i += 1) {
        const source = eventSources[eventSources.length - 1]!;
        source.onerror?.(new Event('error'));
        vi.advanceTimersByTime(20000);
      }
      expect(errors[errors.length - 1]).toBe('Koneksi ke orchestrator gagal setelah beberapa percobaan — cek orchestrator');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the stream while the tab is hidden and resumes, deduped, when shown', () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const doc = { visibilityState: 'visible', addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) };
    (globalThis as unknown as { document: unknown }).document = doc;
    const setVisibility = (state: string) => { doc.visibilityState = state; for (const f of listeners) f(); };
    try {
      const received: string[] = [];
      const unsubscribe = api.streamEvents('run-1', (event) => received.push(event.eventId!));
      const frame = (eventId: string, type = 'log.appended') => ({ data: JSON.stringify({ eventId, runId: 'run-1', seq: 1, type }) }) as MessageEvent<string>;
      eventSources[0]!.onmessage?.(frame('e1'));

      setVisibility('hidden');
      vi.advanceTimersByTime(9_000);
      expect(eventSources[0]!.closed).toBe(false); // a quick tab switch keeps the stream
      vi.advanceTimersByTime(2_000);
      expect(eventSources[0]!.closed).toBe(true); // the connection slot is free for other tabs

      setVisibility('visible');
      expect(eventSources).toHaveLength(2);
      eventSources[1]!.onmessage?.(frame('e1')); // replayed history
      eventSources[1]!.onmessage?.(frame('e2'));
      expect(received).toEqual(['e1', 'e2']);

      unsubscribe();
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
      delete (globalThis as unknown as { document?: unknown }).document;
    }
  });

  it('a stream opened in a background tab lets go without a visibility change', () => {
    vi.useFakeTimers();
    (globalThis as unknown as { document: unknown }).document = { visibilityState: 'hidden', addEventListener: () => undefined, removeEventListener: () => undefined };
    try {
      api.streamEvents('run-1', () => undefined);
      vi.advanceTimersByTime(11_000);
      expect(eventSources[0]!.closed).toBe(true);
    } finally {
      vi.useRealTimers();
      delete (globalThis as unknown as { document?: unknown }).document;
    }
  });
});
