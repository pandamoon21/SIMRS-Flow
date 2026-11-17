/**
 * Rawat jalan run shapes: the operator's input, the visit rows the steps pass
 * along, and the reply shapes of the reads the guards make. Types only.
 */
import type { RajalPaymentConfig, RajalTreatmentGroup } from './rules.js';
import type { RajalUnpaidReportFilters, RajalUnpaidReportQuery } from './unpaidReport.js';

/**
 * Legacy `doFetch`'s form (source lines 1452-1457) — the auto-fetch request.
 *
 * Present on a {@link RajalInput} instead of `patientIds`: the run discovers
 * its own batch from the unpaid-bill report rather than being handed one.
 * The four filters are legacy's, and they select on three different things:
 *
 *  - `instalasi` is a **server-side** filter (`cmbinstalasi`); it picks which
 *    installation's unpaid bills the report renders at all. See
 *    {@link RAJAL_INSTALASI_OPTIONS}; legacy defaults to `'1'` (Rawat Jalan).
 *  - `from`/`to` are the report period (`txtperiode1`/`txtperiode2`), also
 *    server-side. Legacy's `autosaveCfg` (source line 413) then copies them
 *    onto `dateFrom`/`dateTo`, so the period the batch was discovered over is
 *    also the range `filter_records` matches visits against.
 *  - `penjamin` and `unit` are **client-side** scrapes of the rendered report:
 *    `penjamin` is a case-insensitive substring of the row's guarantor column,
 *    `unit` a comma-separated list of substrings matched against the row's
 *    *section heading* — the `POLI …` bar the report groups rows under.
 *
 * The section headings do double duty: they are also where the run's clinic
 * list comes from ({@link extractRajalClinicFromSection} strips the `POLI `
 * prefix), minus the penunjang/pharmacy groupings
 * {@link shouldExcludeRajalSection} rejects, which are billed through their
 * originating poli and must never become a clinic of their own.
 */
export interface RajalDiscoveryInput extends RajalUnpaidReportQuery, RajalUnpaidReportFilters {
  /**
   * Optional: refuse the run if the report yields more distinct patients than
   * this. Absent = no limit (production runs whole clinic-days).
   */
  maxPatients?: number;
}

export interface RajalInput {
  /**
   * The operator's typed batch. Optional **only** when {@link discovery} is
   * set, in which case the report supplies it.
   */
  patientIds?: string[];
  /**
   * Selected poli. Optional in discovery mode: left empty the report's own
   * section headings become the clinic list, exactly as legacy's auto-clinic
   * checkbox did. Supplied, it *narrows* the discovered batch — a discovered
   * patient seen under no selected clinic is dropped, which is legacy
   * `removePatientIdsForClinic` (source line 373).
   */
  clinics?: string[];
  date: string;
  /**
   * Legacy `getEffectiveDateRange` (source line 335): the batch matches a
   * *range*, not a single day. Both default to `date`, or — on a discovery
   * run — to the discovery period (legacy `autosaveCfg`, source line 413).
   */
  dateFrom?: string;
  dateTo?: string;
  acceptedPenjaminKeywords?: string[];
  tindakanIncludeKeywords?: string[];
  tindakanExcludeKeywords?: string[];
  tindakanMinCount?: number;
  /** Legacy `treatmentGroups` — same letter is OR, different letters are AND. */
  treatmentGroups?: RajalTreatmentGroup[];
  /** Legacy `skipTreatments` — presence anywhere on the bill rejects it. */
  skipTreatments?: string[];
  /** Legacy `sepCheckRequired`; `false` skips SEP validation (and its correction plan) for this run. */
  sepCheckRequired?: boolean;
  /** Legacy `paymentConfig` — shift, tender type and payer for tampung bayar. */
  paymentConfig?: Partial<RajalPaymentConfig>;
  /** `false`: never plan `simpan verifikasi`; an unverified visit is dropped instead of paid. */
  enableVerifikasi?: boolean;
  /** `false`: plan no tampung bayar; every check still runs and is reported. */
  enableTampungBayar?: boolean;
  /**
   * Legacy `doFetch` (source line 1451). Set to discover the batch from the
   * unpaid-bill report instead of supplying {@link patientIds}.
   */
  discovery?: RajalDiscoveryInput;
}

export interface RajalRecordRow {
  no_transaksi: string;
  no_registrasikunjungan: string;
  kd_unit: string;
  nama_unit?: string;
  status_bayar?: string;
  nama_penjamin?: string;
  tgl_masuk?: string;
  /**
   * Attached locally by `rajal.loadHistory` — the visit history endpoint is
   * queried per medrec and does not echo it, but the penunjang and SEP guards
   * need the patient id to look up orders and BPJS card numbers.
   */
  patientId?: string;
  /**
   * Attached locally by `rajal.filterRecords`: the single selected clinic this
   * unit resolved to. Legacy recomputed it per step via `getMatchedClinic`;
   * resolving it once means the SEP guard cannot disagree with the filter.
   */
  matchedClinic?: string;
}

export interface RajalTransactionState {
  readonly record: RajalRecordRow;
  readonly tx: { readonly jenis_sep?: string; readonly no_sep?: string };
}

export interface RajalTindakanRow {
  readonly nama_tindakan?: string;
  /** Line total (`jumlah`) — summed for the payable amount. */
  readonly jumlah?: string;
  /** `"Belum"`/`"Sudah"` per line — the payment-state signal. */
  readonly flag?: string;
  /** Line order on the bill (backend-assigned). */
  readonly urut_tindakan?: string;
  readonly status_kirim?: string | null;
}

export interface RajalTreatmentState {
  readonly record: RajalRecordRow;
  /** Rows that survived the operator's include filters. */
  readonly rows: readonly RajalTindakanRow[];
  /** Every billed row — the penunjang guards classify the unfiltered bill. */
  readonly allRows: readonly RajalTindakanRow[];
}

export interface RajalPaymentState {
  readonly record: RajalRecordRow;
  readonly pay: { readonly total?: string; readonly sudah?: string };
}

/** Radiology order row from `poliklinik.getHistoryIrad`. */
export interface RajalIradOrderRow {
  readonly tgl_order?: string;
  readonly status_approve?: string;
  readonly tgl_terlayani?: string;
}

/** Result-transaction row from a penunjang `hasil pemeriksaan` search. */
export interface RajalPenunjangResultRow {
  readonly no_transaksi?: string;
  readonly tgl_transaksi?: string;
}

/** PA order row from `kemoterapi.getHistoryOrderPa`. */
export interface RajalPaOrderRow extends RajalPenunjangResultRow {
  readonly kd_jenis_pemeriksaan?: string;
}

/** Shape shared by every `gethasilpemeriksaan`-style response. */
export interface RajalHasilResponse {
  readonly total?: unknown;
  readonly rows?: readonly { readonly deskripsi?: string }[];
}

/** SEP history row from `pendaftaran.getRiwayatSep`. */
export interface RajalSepRow {
  readonly tgl_sep?: string;
  readonly jns_pelayanan?: string;
  readonly poli_tujuan?: string;
  readonly no_sep?: string;
}

/** A visit `filter_records` admitted, kept so the batch summary can say where each patient left. */
export interface RajalBatchRecord {
  readonly patientId: string;
  readonly trx: string;
  readonly clinic: string;
}

export type RajalConsultKind = 'consult' | 'single_clinic' | 'unknown';
