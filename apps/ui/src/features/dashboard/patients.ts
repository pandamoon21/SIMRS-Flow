/**
 * Processed-patient list for the Pasien page. Reads the orchestrator's
 * `/api/patients` when available and falls back to a deterministic placeholder
 * (same posture as billing.ts) so the page renders before that endpoint ships.
 * All fallback rows are synthetic demo data, not real patients.
 */

const BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ORCHESTRATOR_URL ?? '';

export type PatientCategory = 'titipan' | 'naik_kelas' | 'normal';
export type PatientStatus = 'done' | 'needs_review';
export type PatientWorkflow = 'ranap' | 'rajal';
export type PatientShift = 1 | 2 | 3;

export interface ProcessedPatient {
  noRm: string;
  name: string;
  workflow: PatientWorkflow;
  /** ISO date (YYYY-MM-DD) the run processed this patient. */
  date: string;
  category: PatientCategory;
  /** Koreksi bayar tervalidasi for this patient, in rupiah. */
  nominal: number;
  status: PatientStatus;
  /** Name of the operator who processed this patient's run. */
  operator: string;
  /** Local processing time (HH:MM, WIB) used for the shift filter. */
  time: string;
  /** Work shift derived from `time`: 1 = 07-14, 2 = 14-20, 3 = 20-07 (WIB). */
  shift: PatientShift;
  runId: string;
}

export interface PatientsResult {
  patients: ProcessedPatient[];
  /** Synthetic rows (server stub or client fallback), not real patients. */
  demo?: boolean;
}

export const CATEGORY_LABEL: Record<PatientCategory, string> = {
  titipan: 'Titipan',
  naik_kelas: 'Naik kelas',
  normal: 'Normal',
};

export const WORKFLOW_LABEL: Record<PatientWorkflow, string> = {
  ranap: 'Rawat Inap',
  rajal: 'Rawat Jalan',
};

export const SHIFT_LABEL: Record<PatientShift, string> = {
  1: 'Shift 1 · 07–14',
  2: 'Shift 2 · 14–20',
  3: 'Shift 3 · 20–07',
};

/** WIB work shift for an hour:minute of day. */
export function shiftOfTime(hh: number, mm: number): PatientShift {
  const t = hh * 60 + mm;
  if (t >= 7 * 60 && t < 14 * 60) return 1;
  if (t >= 14 * 60 && t < 20 * 60) return 2;
  return 3;
}

/** Operators who run the workflows; used for the Rekapitulasi table. */
export const OPERATORS = [
  'Siti Nurhaliza',
  'Budi Prasetyo',
  'Rina Kartika',
  'Agus Salim',
  'Dewi Anjani',
] as const;

/** Deterministic synthetic list used until the backend endpoint exists. */
export function fallbackPatients(now: Date = new Date()): PatientsResult {
  const NAMES = [
    'A. Wijaya', 'S. Rahmawati', 'B. Santoso', 'D. Kusuma', 'E. Hartono', 'F. Lestari',
    'G. Pratama', 'H. Anggraini', 'I. Nugroho', 'J. Maharani', 'K. Setiawan', 'L. Puspita',
    'M. Firmansyah', 'N. Handayani', 'O. Saputra', 'P. Wulandari', 'Q. Ramadhan', 'R. Safitri',
    'S. Kurniawan', 'T. Melati', 'U. Hidayat', 'V. Anggita', 'W. Permana', 'X. Cahyani',
  ];
  // 7 titipan + 12 naik_kelas + 5 normal = 24, matching the billing summary counts.
  const categories: PatientCategory[] = [
    ...Array<PatientCategory>(7).fill('titipan'),
    ...Array<PatientCategory>(12).fill('naik_kelas'),
    ...Array<PatientCategory>(5).fill('normal'),
  ];
  // ~400 days × 3 patients (same shape as the server stub) so the Rekap
  // week/month/year views have data.
  const patients: ProcessedPatient[] = Array.from({ length: 1200 }, (_, i) => {
    const name = NAMES[(i * 5) % NAMES.length] ?? NAMES[0]!;
    const category = categories[(i * 7) % categories.length] ?? 'normal';
    const workflow: PatientWorkflow = i % 3 === 0 ? 'rajal' : 'ranap';
    const d = new Date(now);
    d.setDate(now.getDate() - Math.floor(i / 3));
    const wobble = (i * 37) % 23;
    const nominal =
      category === 'titipan' ? (180 + wobble * 17) * 1000 :
      category === 'naik_kelas' ? (320 + wobble * 23) * 1000 :
      (90 + wobble * 7) * 1000;
    // A few recent titipan rows still need a human decision.
    const status: PatientStatus = category === 'titipan' && i % 3 === 1 && i < 30 ? 'needs_review' : 'done';
    const rm = `0-${String(30 + (i % 30)).padStart(2, '0')}-${String(10 + ((i * 7) % 90)).padStart(2, '0')}-${String(10 + ((i * 13) % 90)).padStart(2, '0')}`;
    const operator = OPERATORS[i % OPERATORS.length] ?? OPERATORS[0];
    const minuteOfDay = (i * 97 + 431) % (24 * 60);
    const hh = Math.floor(minuteOfDay / 60);
    const mm = minuteOfDay % 60;
    const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    const shift = shiftOfTime(hh, mm);
    return {
      noRm: rm,
      name: `Pasien ${name}`,
      workflow,
      date: d.toISOString().slice(0, 10),
      category,
      nominal,
      status,
      operator,
      time,
      shift,
      runId: `rn_${d.toISOString().slice(0, 10).replace(/-/g, '')}_${workflow}_${String(i + 1).padStart(3, '0')}`,
    };
  });
  return { demo: true, patients };
}

export async function fetchPatients(signal?: AbortSignal): Promise<PatientsResult> {
  try {
    const res = await fetch(`${BASE}/api/patients`, { credentials: 'include', signal });
    if (!res.ok) return fallbackPatients();
    const json = (await res.json()) as Partial<PatientsResult>;
    if (!json.patients || json.patients.length === 0) return fallbackPatients();
    return { patients: json.patients, ...(json.demo ? { demo: true } : {}) };
  } catch {
    return fallbackPatients();
  }
}
