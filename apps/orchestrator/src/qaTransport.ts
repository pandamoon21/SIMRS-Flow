/**
 * QA-only run harness: fixture scenarios, latency and fault injection, and a
 * synthetic rajal batch of any size — so the real executors, mutation gate,
 * ledger and SSE can be exercised end to end without touching SIMRS.
 *
 * Reachable only when the orchestrator runs with QA_AUTH_TOKEN (never on a
 * production host); the server drops `qa` from a run request otherwise.
 */
import { FixtureTransport, type FixtureEntry, type Transport, type TransportRequest, type TransportResponse } from '@simrs-flow/evomedis-client';
import {
  rajalFixtures,
  ranapFixtures,
  RANAP_BYNY_HEALTHY_OVERRIDES,
  RANAP_BYNY_IBS_OVERRIDES,
  RANAP_BYNY_OWN_SEP_OVERRIDES,
  RANAP_BYNY_SICK_OVERRIDES,
  RANAP_IGD_ELEKTROMEDIK_OVERRIDES,
  RANAP_OBAT_DETAIL_OVERRIDES,
  RANAP_TWO_REG_OVERRIDES,
  RANAP_TWO_ROOM_OVERRIDES,
  RANAP_VISITE_WRONG_TARIF_OVERRIDES,
} from '@simrs-flow/test-fixtures';

export type QaFaultKind = 'timeout' | 'http500' | 'network' | 'loginPage' | 'dropCookie';

export interface QaFault {
  kind: QaFaultKind;
  /** Only requests to this endpoint id (any endpoint when omitted). */
  endpointId?: string;
  /** Matching requests to let through before the fault starts (default 0). */
  afterCalls?: number;
  /** How many matching requests fail (default: all after `afterCalls`). */
  times?: number;
}

export interface QaRunOptions {
  /** A named fixture scenario (see QA_SCENARIOS); default = the happy fixture. */
  scenario?: string;
  /** Fixed delay per request, ms (an office SIMRS is slow, not instant). */
  latencyMs?: number;
  /** Extra random delay 0..jitterMs per request. */
  jitterMs?: number;
  faults?: QaFault[];
}

const RANAP_SCENARIOS: Record<string, Record<string, FixtureEntry>> = {
  'ranap-two-room': RANAP_TWO_ROOM_OVERRIDES,
  'ranap-two-reg': RANAP_TWO_REG_OVERRIDES,
  'ranap-igd-elektromedik': RANAP_IGD_ELEKTROMEDIK_OVERRIDES,
  'ranap-visite-wrong-tarif': RANAP_VISITE_WRONG_TARIF_OVERRIDES,
  'ranap-obat-detail': RANAP_OBAT_DETAIL_OVERRIDES,
  'ranap-byny-own-sep': RANAP_BYNY_OWN_SEP_OVERRIDES,
  'ranap-byny-healthy': RANAP_BYNY_HEALTHY_OVERRIDES,
  'ranap-byny-sick': RANAP_BYNY_SICK_OVERRIDES,
  'ranap-byny-ibs': RANAP_BYNY_IBS_OVERRIDES,
};

export const QA_SCENARIOS = ['happy', 'rajal-synthetic', ...Object.keys(RANAP_SCENARIOS)] as const;

/**
 * Rajal fixtures where every medrec gets its own unpaid visit, so a batch of N
 * typed No. RM runs N distinct patients/transactions through the pipeline.
 */
function syntheticRajal(): Record<string, FixtureEntry> {
  return {
    ...rajalFixtures,
    'kasir.getHistoryKunjungan': (req) => {
      const medrec = new URLSearchParams(req.body ?? '').get('nomedrec') ?? '';
      const n = medrec.replace(/\D/g, '').slice(-5) || '0';
      return {
        text: JSON.stringify({
          rows: [{
            no_registrasikunjungan: `REG-RJ-${n}`,
            no_transaksi: `01-20${n.padStart(5, '0')}`,
            kd_unit: 'P01',
            nama_unit: 'POLI PENYAKIT DALAM',
            status_bayar: 'Belum',
            nama_penjamin: 'BPJS PBI',
            tgl_masuk: '2026-06-10',
          }],
        }),
      };
    },
  };
}

/** The fixture map a QA run reads from; unknown scenario names are refused. */
export function qaFixtures(domain: 'ranap' | 'rajal', scenario = 'happy'): Record<string, FixtureEntry> {
  if (scenario === 'happy') return domain === 'ranap' ? ranapFixtures : rajalFixtures;
  if (scenario === 'rajal-synthetic' && domain === 'rajal') return syntheticRajal();
  const overrides = domain === 'ranap' ? RANAP_SCENARIOS[scenario] : undefined;
  if (!overrides) throw new Error(`unknown QA scenario "${scenario}" for ${domain}`);
  return { ...ranapFixtures, ...overrides };
}

const LOGIN_PAGE = '<html><body><form id="form-login" action="login/index"><input name="password"></form></body></html>';

function endpointOf(req: TransportRequest): string {
  const hit = Object.entries(req.headers).find(([key]) => key.toLowerCase() === 'x-endpoint-id');
  return hit?.[1] ?? '';
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (ms <= 0) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

/** Wraps any transport (fixture or live) with QA latency and faults. */
export class QaTransport implements Transport {
  private readonly seen = new Map<QaFault, number>();

  constructor(private readonly inner: Transport, private readonly options: QaRunOptions = {}) {}

  async send(req: TransportRequest): Promise<TransportResponse> {
    const delay = (this.options.latencyMs ?? 0) + Math.random() * (this.options.jitterMs ?? 0);
    await sleep(delay, req.signal);
    const fault = this.activeFault(endpointOf(req));
    switch (fault?.kind) {
      case 'timeout':
        // What FetchTransport does: wait out the timeout, then abort.
        await sleep(req.timeoutMs, req.signal);
        throw new DOMException('This operation was aborted', 'AbortError');
      case 'network':
        throw new TypeError('fetch failed');
      case 'http500':
        return { status: 500, text: '<h1>500 Internal Server Error</h1>', headers: {}, setCookies: [] };
      case 'loginPage':
        return { status: 200, text: LOGIN_PAGE, headers: {}, setCookies: [] };
      case 'dropCookie': {
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => key.toLowerCase() !== 'cookie'));
        return this.inner.send({ ...req, headers });
      }
      default:
        return this.inner.send(req);
    }
  }

  private activeFault(endpointId: string): QaFault | undefined {
    for (const fault of this.options.faults ?? []) {
      if (fault.endpointId && fault.endpointId !== endpointId) continue;
      const n = (this.seen.get(fault) ?? 0) + 1;
      this.seen.set(fault, n);
      const from = fault.afterCalls ?? 0;
      if (n > from && (fault.times === undefined || n <= from + fault.times)) return fault;
    }
    return undefined;
  }
}

/** Transport for a QA fixture run. */
export function qaFixtureTransport(domain: 'ranap' | 'rajal', options: QaRunOptions): Transport {
  return new QaTransport(new FixtureTransport(qaFixtures(domain, options.scenario)), options);
}
