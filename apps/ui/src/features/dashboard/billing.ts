/**
 * Billing throughput summary for the Overview. Reads the orchestrator's
 * `/api/billing/summary` when available and falls back to a deterministic
 * placeholder so the dashboard renders before that endpoint ships.
 */

const BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ORCHESTRATOR_URL ?? '';

export interface BillingDay {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Nominal koreksi bayar tervalidasi that day, in rupiah. */
  amount: number;
}

export interface BillingSummary {
  /** Trailing window, oldest → newest. */
  days: BillingDay[];
  /** Jumlah pasien titipan hari ini (beda kelas, tanpa bayar selisih). */
  titipanToday: number;
  /** Jumlah pasien naik kelas hari ini (bayar selisih). */
  naikKelasToday: number;
  gate: { approved: number; rejected: number; pending: number };
  /** Placeholder numbers (server stub or client fallback), not a real billing query. */
  demo?: boolean;
}

export const formatRupiah = (n: number): string => `Rp ${Math.round(n).toLocaleString('id-ID')}`;

export const formatRupiahShort = (n: number): string => {
  if (n >= 1e9) return `Rp ${(n / 1e9).toFixed(1).replace('.', ',')} M`;
  if (n >= 1e6) return `Rp ${(n / 1e6).toFixed(1).replace('.', ',')} jt`;
  if (n >= 1e3) return `Rp ${(n / 1e3).toFixed(0)} rb`;
  return formatRupiah(n);
};

/** Deterministic 14-day placeholder used until the backend endpoint exists. */
export function fallbackBillingSummary(now: Date = new Date()): BillingSummary {
  const seed = [214, 339, 182, 416, 128, 473, 381, 557, 429, 612, 498, 684, 576, 482];
  const days: BillingDay[] = seed.map((v, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() - (seed.length - 1 - i));
    return { date: d.toISOString().slice(0, 10), amount: v * 100_000 };
  });
  return { demo: true, days, titipanToday: 7, naikKelasToday: 12, gate: { approved: 71, rejected: 8, pending: 3 } };
}

export async function fetchBillingSummary(signal?: AbortSignal): Promise<BillingSummary> {
  try {
    const res = await fetch(`${BASE}/api/billing/summary`, { credentials: 'include', signal });
    if (!res.ok) return fallbackBillingSummary();
    const json = (await res.json()) as Partial<BillingSummary>;
    if (!json.days || json.days.length === 0) return fallbackBillingSummary();
    return {
      days: json.days,
      titipanToday: json.titipanToday ?? 0,
      naikKelasToday: json.naikKelasToday ?? 0,
      gate: json.gate ?? { approved: 0, rejected: 0, pending: 0 },
      ...(json.demo ? { demo: true } : {}),
    };
  } catch {
    return fallbackBillingSummary();
  }
}
