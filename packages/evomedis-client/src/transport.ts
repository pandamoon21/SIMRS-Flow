/**
 * Transport abstraction.
 *
 * The client never calls fetch directly — it goes through a Transport. This
 * lets tests inject a fixture transport (no network) and lets the orchestrator
 * inject a real fetch-based transport with session cookies. It is the seam
 * that makes contract tests possible without a live SIMRS.
 */

export interface TransportRequest {
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  headers: Record<string, string>;
  /** URL-encoded form body for POSTs. */
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Response body as text; the client decodes per endpoint shape. */
  text: string;
  /** Raw bytes for PDF-size probes and other non-text reads. */
  bodyBytes?: Uint8Array;
  headers: Record<string, string>;
  /**
   * Raw `Set-Cookie` header values, one per cookie. Node's global fetch
   * collapses multi-value headers, so these are surfaced separately via
   * `Headers.getSetCookie()`. Used by the login flow to capture `ci_session`.
   */
  setCookies?: string[];
}

export interface Transport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

/**
 * Fetch-based transport for Node 20+ (global fetch). Sends cookies via the
 * Cookie header. Honors an AbortSignal and a timeout.
 */
export class FetchTransport implements Transport {
  async send(req: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    // Chain the caller's signal into our controller.
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'POST' ? req.body : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const bodyBytes = req.method === 'HEAD' ? undefined : new Uint8Array(await res.arrayBuffer());
      const text = bodyBytes ? new TextDecoder().decode(bodyBytes) : '';
      // Node's fetch (undici) exposes multi-value Set-Cookie only via
      // getSetCookie(); res.headers.get('set-cookie') would collapse them.
      const getSetCookie = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
      const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : [];
      return { status: res.status, text, ...(bodyBytes ? { bodyBytes } : {}), headers, setCookies };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Fixture transport — returns canned responses keyed by endpoint id.
 * Used by contract tests. Each entry can be a static response or a function
 * of the request, so tests can assert payloads.
 */
export type FixtureEntry =
  | { status?: number; text: string; bodyBytes?: Uint8Array; headers?: Record<string, string>; setCookies?: string[] }
  | ((
    req: TransportRequest,
  ) => { status?: number; text: string; bodyBytes?: Uint8Array; headers?: Record<string, string>; setCookies?: string[] });

export class FixtureTransport implements Transport {
  /** Records every request for assertions. */
  public readonly calls: TransportRequest[] = [];

  constructor(private readonly fixtures: Record<string, FixtureEntry>) {}

  async send(req: TransportRequest): Promise<TransportResponse> {
    this.calls.push(req);
    // The client tags requests with the endpoint id via a header so the
    // fixture map stays readable.
    const id = req.headers['x-endpoint-id'] ?? req.url;
    const entry = this.fixtures[id];
    if (!entry) {
      return { status: 404, text: `no fixture for ${id}`, headers: {}, setCookies: [] };
    }
    const resolved = typeof entry === 'function' ? entry(req) : entry;
    const bodyBytes = resolved.bodyBytes ?? new TextEncoder().encode(resolved.text);
    return {
      status: resolved.status ?? 200,
      text: resolved.text,
      bodyBytes,
      headers: resolved.headers ?? {},
      setCookies: resolved.setCookies ?? [],
    };
  }
}
