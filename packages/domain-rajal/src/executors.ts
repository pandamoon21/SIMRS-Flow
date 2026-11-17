/**
 * Rawat jalan dry-run executors.
 *
 * Mirrors the GreasyFork processRecord pipeline: each guard reads real data
 * (or fixtures) and either passes, skips, or blocks. The terminal
 * `submit_payment` step never writes in preview — it emits a MutationPlan.
 */

import type {
  ExecutorContext,
  ExecutorRegistry,
  MutationPlan,
  NodeExecutor,
  StepResult,
  ReasoningItem,
} from '@simrs-flow/workflow-core';
import {
  REASONING_LABEL,
  attempt,
  blocked,
  fail,
  ok,
  reasoningEvidence,
  reasoningOf,
  review,
  rowsField,
  skipped,
  softJson,
  softRead,
} from '@simrs-flow/workflow-core';
import type { EvoMedisClient } from '@simrs-flow/evomedis-client';
import { BERKAS_PROGRESS_KEY, berkasFactsOf, berkasIndexPayload, evaluateBerkas, pageList, type BerkasProgressPort, type BerkasReaderPort } from '@simrs-flow/berkas/evaluate';
import { rajalWorkflow } from './workflow.js';
import { noKkRejectionReason, normalizeCardNumber, normalizeDate } from '@simrs-flow/evomedis-client';
import {
  RAJAL_DEFAULT_ACCEPTED_PENJAMIN,
  RAJAL_DEFAULT_PAYMENT_CONFIG,
  RAJAL_INSTALASI_OPTIONS,
  RAJAL_LAB_EMPTY_RESULT_MARKERS,
  RAJAL_LAB_MIN_LIS_MARKUP_LENGTH,
  RAJAL_LAB_PA_MIN_RESULT_LENGTH,
  RAJAL_PENUNJANG_UNIT_KEYWORD,
  RAJAL_SEP_HISTORY_ATTEMPTS,
  RAJAL_SEP_SERVICE_TYPE,
} from './rules.js';
import {
  buildRajalUnpaidReportQuery,
  parseRajalUnpaidReport,
  selectRajalUnpaidBatch,
  type RajalUnpaidBatch,
  type RajalUnpaidReportFilters,
  type RajalUnpaidReportQuery,
} from './unpaidReport.js';
import {
  evaluateRajalLabPdfGet,
  evaluateRajalLabPdfHead,
  formatRajalLegacyDate,
  isElektromedikTreatmentName,
  isLabPaTreatmentName,
  isRadiologyTreatmentName,
  isRegularLabTreatmentName,
  resolveRajalLisPdfTarget,
  resultCount,
} from './logic/penunjang.js';
import {
  keepSelectedClinicPatients,
  matchedClinic,
  rajalClinicCandidates,
  resolveRajalClinicMatch,
  resolveRajalSep,
} from './logic/sepClinic.js';
import {
  evaluateRajalBillRules,
  evaluateRajalConsultVisit,
  rajalTreatmentChecklist,
  unclassifiedPenunjangRows,
} from './logic/treatment.js';
import {
  classifyRajalInstalasi,
  evaluateRajalExitDateResponse,
  isRajalBillableCandidate,
  rajalEffectiveRange,
  recordVisitDate,
} from './logic/visit.js';
import {
  buildRajalTampungBayarPayload,
  evaluateRajalOrderBlocker,
  evaluateRajalPenunjangBlocker,
  tallyRajalBillLines,
} from './logic/payment.js';
import { rajalState } from './state.js';
import { RAJAL_NODE, RAJAL_PATIENT_OUTCOMES_EVIDENCE } from './nodes.js';
import type {
  RajalDiscoveryInput,
  RajalHasilResponse,
  RajalInput,
  RajalIradOrderRow,
  RajalPaOrderRow,
  RajalConsultKind,
  RajalPaymentState,
  RajalPenunjangResultRow,
  RajalRecordRow,
  RajalSepRow,
  RajalTindakanRow,
  RajalTransactionState,
  RajalTreatmentState,
} from './types.js';

export type { RajalDiscoveryInput, RajalInput, RajalRecordRow } from './types.js';

export interface RajalDeps {
  client: EvoMedisClient;
  /** Opt-in "Kelengkapan Berkas" reader (Node host only); absent → the step skips. */
  berkas?: BerkasReaderPort;
}

/** Reformat a 6-digit medrec to the 0-XX-XX-XX form used by the backend. */
export function formatPatientId(raw: string): string {
  const s = raw.trim();
  if (/^\d{6}$/.test(s)) {
    return `0-${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
  }
  return s;
}

function normalizeKeywords(keywords?: string[]): string[] {
  return (keywords ?? []).map((k) => k.trim().toUpperCase()).filter(Boolean);
}

/** Legacy `getTreatmentNameLower` — the penunjang classifiers are lower-case. */
function tindakanNameLower(row: RajalTindakanRow): string {
  return (row.nama_tindakan ?? '').trim().toLowerCase();
}

function pruneRajalRecords(ctx: ExecutorContext, dropped: ReadonlySet<string>): void {
  if (dropped.size === 0) return;
  const state = rajalState(ctx);
  const droppedAt = (state.droppedAt ??= {});
  const step = state.currentStep ?? '';
  for (const trx of dropped) droppedAt[trx] ??= step;
  const keep = (record: RajalRecordRow) => !dropped.has(record.no_transaksi);
  if (state.matching) state.matching = state.matching.filter(keep);
  if (state.transactions) state.transactions = state.transactions.filter(({ record }) => keep(record));
  if (state.treatments) state.treatments = state.treatments.filter(({ record }) => keep(record));
  if (state.payable) state.payable = state.payable.filter(({ record }) => keep(record));
}

/** `rajal.validateExitDate` → `validate_exit_date` (workflow.ts builds the ref the other way). */
function nodeIdOfRef(ref: string): string {
  return ref.replace(/^rajal\./, '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const STEP_LABELS = new Map(rajalWorkflow.nodes.map((node) => [node.id, node.label]));
const stepLabel = (nodeId: string) => STEP_LABELS.get(nodeId) ?? nodeId;

/** Why a patient never reached the batch (unreadable history, untransferred penunjang, ambiguous poli). */
function patientNote(ctx: ExecutorContext, patientId: string, note: string): void {
  const notes = (rajalState(ctx).patientNotes ??= {});
  notes[patientId] ??= note;
}

export interface RajalPatientOutcome {
  patientId: string;
  status: 'lolos' | 'dilewati';
  clinics: string[];
  transactions: string[];
  /** Node id of the step that dropped the patient's last visit. */
  step?: string;
  reason: string;
}

/**
 * Per patient in the queue: did any visit survive every check, and if not,
 * where and why it left. Built from what the steps already recorded
 * (batchRecords, droppedAt, patientNotes); it decides nothing itself.
 */
function patientOutcomes(ctx: ExecutorContext): RajalPatientOutcome[] {
  const state = rajalState(ctx);
  const ids = state.ids ?? [];
  const started = state.batchRecords ?? [];
  const remaining = new Set((state.matching ?? []).map((r) => r.no_transaksi));
  const droppedAt = state.droppedAt ?? {};
  const notes = state.patientNotes ?? {};
  return ids.map((patientId) => {
    const records = started.filter((r) => r.patientId === patientId);
    const kept = records.filter((r) => remaining.has(r.trx));
    const clinics = [...new Set((kept.length ? kept : records).map((r) => r.clinic).filter(Boolean))];
    const transactions = (kept.length ? kept : records).map((r) => r.trx);
    if (kept.length > 0) return { patientId, status: 'lolos' as const, clinics, transactions, reason: '' };
    const step = records.map((r) => droppedAt[r.trx]).find(Boolean);
    const reason = records.length === 0
      ? notes[patientId] ?? 'tidak ada kunjungan yang cocok (tanggal, penjamin, poli, atau sudah dibayar)'
      : step ? `${records.length} kunjungan tidak lolos — rincian di langkah ${stepLabel(step)}` : 'kunjungan tidak lolos';
    return { patientId, status: 'dilewati' as const, clinics, transactions, ...(step ? { step } : {}), reason };
  });
}

interface PenunjangCheckArgs {
  readonly ctx: ExecutorContext;
  readonly record: RajalRecordRow;
  /** Normalized medrec of the patient this record belongs to. */
  readonly medrec: string;
  /** Visit date in ISO form. */
  readonly date: string;
  /** The billed rows of this modality — never empty. */
  readonly orders: readonly RajalTindakanRow[];
}

/**
 * Shared skeleton for the four penunjang guards, mirroring legacy
 * `processRecord` lines 908-988: the check only engages when the bill contains
 * a treatment of that modality, and the first outstanding record short-circuits
 * the whole step. `check` returns `null` when the record is clean.
 */
function penunjangValidator(
  label: string,
  applies: (nameLower: string) => boolean,
  check: (args: PenunjangCheckArgs) => Promise<StepResult | null>,
): NodeExecutor {
  return async (ctx) => {
    const cfg = rajalState(ctx).config;
    const states = rajalState(ctx).treatments ?? [];
    if (!cfg || states.length === 0) return skipped('Tidak ada kunjungan');
    let billed = 0;
    const kept: RajalTreatmentState[] = [];
    const hard: string[] = [];
    const review: string[] = [];
    const dropped = new Set<string>();
    for (const state of states) {
      const { record, allRows } = state;
      const orders = allRows.filter((row) => applies(tindakanNameLower(row)));
      if (orders.length === 0) {
        kept.push(state);
        continue;
      }
      const medrec = (record.patientId ?? '').trim();
      if (!medrec) {
        hard.push(`Cek ${label.toLowerCase()} tidak bisa dijalankan pada ${record.no_transaksi}: No. RM tidak diketahui`);
        dropped.add(record.no_transaksi);
        continue;
      }
      const verdict = await check({
        ctx,
        record,
        medrec,
        date: recordVisitDate(record, cfg.date),
        orders,
      });
      if (verdict) {
        if (verdict.status === 'success' || verdict.status === 'skipped') kept.push(state);
        else {
          (verdict.status === 'blocked' || verdict.status === 'failed' ? hard : review).push(verdict.summary);
          dropped.add(record.no_transaksi);
        }
        continue;
      }
      billed += orders.length;
      kept.push(state);
    }
    if (dropped.size > 0) {
      rajalState(ctx).treatments = kept;
      pruneRajalRecords(ctx, dropped);
      const issues = [...hard, ...review];
      if (hard.length > 0 && kept.length === 0) {
        return blocked(hard.length === 1 ? hard[0]! : `Blocker ${label}: ${hard.join('; ')}`);
      }
      return {
        status: 'needs_review',
        summary: `${kept.length} kunjungan tersisa setelah cek ${label.toLowerCase()}; ${issues.length} dilewati — ${issues.join('; ')}`,
      };
    }
    const lower = label.toLowerCase().replace(/\bpa\b/g, 'PA');
    return ok(billed === 0 ? `Tidak ada tindakan ${lower} yang ditagih` : `${billed} tindakan ${lower} sudah ada hasilnya`);
  };
}

export function createRajalExecutors(deps: RajalDeps): ExecutorRegistry {
  const { client } = deps;

  return withRajalChecklists({
    /**
     * Two ways to start a run, and the guard differs.
     *
     * Handed an explicit `patientIds` list, an empty one is operator error and
     * fails closed exactly as it always did. Handed a `discovery` request, the
     * patient list is what the run is about to *find*, so demanding one up
     * front would make the feature unreachable; the period is validated
     * instead, and `normalize_ids` owns the rest.
     */
    'rajal.loadConfig': (ctx) => {
      const input = ctx.input as RajalInput;
      const discovery = input?.discovery;
      if (discovery) {
        if (!discovery.from?.trim() || !discovery.to?.trim()) {
          return fail('Cari otomatis butuh periode (dari dan sampai)');
        }
        if (discovery.from > discovery.to) {
          return fail(`Periode cari otomatis terbalik: ${discovery.from} → ${discovery.to}`);
        }
      } else {
        if (!input?.patientIds?.length) return fail('Belum ada No. RM');
        if (!input.clinics?.length) return fail('Belum ada poli dipilih');
      }
      rajalState(ctx).config = { ...input, acceptedPenjaminKeywords: input.acceptedPenjaminKeywords ?? [...RAJAL_DEFAULT_ACCEPTED_PENJAMIN] };
      if (discovery) {
        const instalasi = discovery.instalasi ?? '1';
        const label = RAJAL_INSTALASI_OPTIONS.find((option) => option.code === instalasi)?.label ?? instalasi;
        const cap = discovery.maxPatients;
        return ok(
          `Cari otomatis ${discovery.from} → ${discovery.to} (instalasi ${label})${cap ? `, maks ${cap} pasien` : ''}`,
        );
      }
      return ok(`${input.patientIds!.length} pasien, ${input.clinics!.length} poli`);
    },

    /**
     * Legacy `doFetch` (source line 1451) reaches the pipeline here.
     *
     * `normalize_ids` is `critical`, and that is load-bearing for discovery: a
     * report that could not be read must stop the run, not hand the rest of the
     * graph an empty batch that every downstream node would benignly `skip`
     * its way through and report as a clean, finished run with nothing to pay.
     * So an unreadable report and an over-cap batch both `block` (the run
     * fails, loudly, naming why), while a report that *did* render and simply
     * listed nothing is a legitimate empty batch and `skip`s.
     */
    'rajal.normalizeIds': async (ctx) => {
      const state = rajalState(ctx);
      const cfg = state.config!;
      const discovery = cfg.discovery;
      if (!discovery) {
        const ids = [...new Set((cfg.patientIds ?? []).map(formatPatientId).filter(Boolean))];
        state.ids = ids;
        ctx.log(`${ids.length} No RM unik dinormalisasi`);
        return ok(`${ids.length} No. RM unik`);
      }

      const period = `${discovery.from} → ${discovery.to}`;
      ctx.log(`Discovering unpaid batch over ${period} from laporan_belum_bayar`);
      const read = await attempt(() => fetchRajalUnpaidBatch(client, discovery, { signal: ctx.signal }));
      if (!read.ok) {
        return blocked(
          `Gagal membaca laporan cari otomatis untuk ${period}: ${read.message} — tidak ada antrean ditemukan; laporan yang gagal dibaca bukan laporan kosong`,
        );
      }
      const batch = read.value;
      if (!batch.readable) {
        return blocked(
          `Gagal membaca laporan cari otomatis untuk ${period}: laporan_belum_bayar dijawab tanpa tabel laporan — laporan yang gagal dibaca bukan laporan kosong`,
        );
      }

      state.discovery = batch;
      // Legacy `mergeAutoClinicPatients` (source line 361), keyed on the same
      // normalised medrec the rest of the pipeline uses so `resolve_clinics`
      // can match a discovered patient against the selected clinics.
      const clinicsByPatientId: Record<string, string[]> = {};
      for (const [noRM, clinics] of Object.entries(batch.clinicsByPatientId)) {
        const id = formatPatientId(noRM);
        if (!id) continue;
        const bucket = clinicsByPatientId[id] ?? (clinicsByPatientId[id] = []);
        for (const clinic of clinics) {
          const label = clinic.trim().toUpperCase();
          if (label && !bucket.includes(label)) bucket.push(label);
        }
      }
      state.clinicsByPatientId = clinicsByPatientId;

      // Legacy keeps duplicates in the textarea and counts `uniqueRM`
      // separately (source line 1476); the port only ever runs the unique set.
      const ids = [...new Set(batch.patientIds.map(formatPatientId).filter(Boolean))];
      state.ids = ids;
      // The cap bounds what this run will process, i.e. the ids left after the
      // poli chips narrow them (`resolve_clinics` performs that prune). Live
      // 2026-10-15: a SYARAF run blocked on "607 patient(s)", which was the whole
      // report, so no single-poli run could ever pass a 1-patient cap.
      const requested = (cfg.clinics ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean);
      const inScope = keepSelectedClinicPatients(ids, clinicsByPatientId, requested).length;
      ctx.log(
        `Laporan berisi ${batch.stats.total} baris belum bayar; ${batch.stats.filtered} cocok dengan saringan`,
      );
      if (batch.excludedSections.length > 0) {
        ctx.log(`Penunjang/pharmacy section(s) excluded: ${batch.excludedSections.join(', ')}`, 'warn');
      }
      if (ids.length === 0) {
        return skipped(
          `Tidak ada yang ditagih: ${period} berisi ${batch.stats.total} baris belum bayar, tidak ada yang cocok dengan ${describeFilters(discovery)}`,
        );
      }

      const cap = discovery.maxPatients;
      if (cap !== undefined && inScope > cap) {
        const scope = inScope === ids.length ? '' : ` di poli terpilih (${ids.length} di laporan)`;
        return blocked(
          `Ditemukan ${inScope} pasien${scope} pada ${period}, melebihi batas ${cap} pasien untuk run ini — persempit periode, filter penjamin atau unit, atau naikkan batas dengan sengaja`,
        );
      }
      ctx.log(`Ditemukan ${ids.length} No RM unik di ${batch.clinics.length} poli`);
      return ok(`${ids.length} No. RM unik dari ${batch.stats.filtered} baris belum bayar`, {
        evidence: [
          { label: 'discovered patients', data: ids },
          { label: 'discovered clinics', data: batch.clinics },
          { label: 'report stats', data: batch.stats },
        ],
      });
    },

    'rajal.resolveClinics': (ctx) => {
      const state = rajalState(ctx);
      const cfg = state.config!;
      const batch = state.discovery;
      const requested = (cfg.clinics ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean);
      // Legacy's auto-clinic checkbox (source line 1491) replaces the chips
      // with the report's own section headings. Requested clinics win because
      // they narrow — see the prune below.
      const clinics =
        requested.length > 0 ? requested : (batch?.clinics ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean);
      state.clinics = clinics;
      if (clinics.length === 0) {
        if (!batch) return fail('Tidak ada poli yang bisa ditentukan');
        if ((state.ids ?? []).length === 0) {
          return skipped('Antrean hasil cari otomatis kosong — tidak ada poli untuk ditentukan');
        }
        return blocked(
          'Laporan tidak memuat seksi poli yang bisa ditagih — semua judulnya kelompok penunjang/farmasi',
        );
      }

      // Legacy `removePatientIdsForClinic` (source line 373): de-selecting a
      // clinic drops exactly the patients that were auto-added under it. A
      // discovered patient the map never claimed (its only section was an
      // excluded one) is left alone, as legacy's `beforeManaged` guard does.
      //
      // The comparison goes through `resolveRajalClinicMatch`, not a raw string
      // set: the operator's chip is a mapping alias (`DALAM`) while the report
      // section is its long form (`POLI PENYAKIT DALAM`), so an exact match
      // dropped every discovered patient and the batch finished with no payment
      // plan at all. An ambiguous match is not a match — refusing to guess is
      // what legacy's resolver does.
      const droppedNote = 'Pasien dari laporan yang tidak ada di poli terpilih dibuang';
      if (batch && requested.length > 0) {
        const ids = state.ids ?? [];
        const kept = keepSelectedClinicPatients(ids, state.clinicsByPatientId ?? {}, clinics);
        const dropped = ids.length - kept.length;
        if (dropped > 0) {
          ctx.log(`${droppedNote}: ${dropped}`, 'warn');
          state.ids = kept;
        }
      }
      return { ...ok(`Poli diproses: ${clinics.join(', ')}`), evidence: [{ label: 'rajal.selected-clinics', source: RAJAL_NODE.resolveClinics, data: clinics }] };
    },

    'rajal.startBatch': (ctx) => {
      const ids = rajalState(ctx).ids ?? [];
      rajalState(ctx).batchTotal = ids.length;
      return ok(`Antrean ${ids.length} pasien dimulai`, {
        evidence: [
          { label: 'patients', data: ids },
          { label: 'rajal.batch-count', source: RAJAL_NODE.startBatch, data: { totalPatients: ids.length } },
        ],
      });
    },

    'rajal.loadHistory': async (ctx) => {
      const state = rajalState(ctx);
      const ids = state.ids ?? [];
      state.historyUnreadableCount = 0;
      if (ids.length === 0) return skipped('Tidak ada pasien dalam antrean');
      const rows: RajalRecordRow[] = [];
      const unreadable: string[] = [];
      for (const patientId of ids) {
        const read = await attempt(() => client.postJson<{ rows?: RajalRecordRow[] }>(
          'kasir.getHistoryKunjungan',
          { nomedrec: patientId, page: '1', rows: '10' },
          { signal: ctx.signal },
        ));
        if (!read.ok) {
          // Parity item 13: an unreadable read is "not read", never a crash.
          ctx.log(`Riwayat kunjungan ${patientId} tidak terbaca: ${read.message}`, 'warn');
          unreadable.push(patientId);
          continue;
        }
        const res = read.value;
        // Legacy source line 1044 warns and abandons the patient when the reply
        // carries no `rows` array. A patient whose history we could not read is
        // not a patient with no visits — report it instead of billing on it.
        if (!Array.isArray(res?.rows)) {
          unreadable.push(patientId);
          continue;
        }
        // Stamp the medrec we queried with — the penunjang and SEP guards look
        // orders up per patient and the response does not echo it.
        rows.push(...res.rows.map((row) => ({ ...row, patientId })));
      }
      state.history = rows;
      state.historyUnreadableCount = unreadable.length;
      for (const id of unreadable) patientNote(ctx, id, 'riwayat kunjungan tidak terbaca');
      if (unreadable.length > 0) {
        return review(`Riwayat kunjungan gagal dibaca untuk ${unreadable.length}/${ids.length} pasien: ${unreadable.join(', ')}`);
      }
      return ok(`${rows.length} baris kunjungan dibaca untuk ${ids.length} pasien`);
    },

    'rajal.filterRecords': (ctx) => {
      const state = rajalState(ctx);
      const cfg = state.config!;
      const clinics = state.clinics ?? [];
      const rows = state.history ?? [];
      const range = rajalEffectiveRange(cfg);
      const accepted = cfg.acceptedPenjaminKeywords ?? RAJAL_DEFAULT_ACCEPTED_PENJAMIN;
      const candidate = (r: RajalRecordRow) => isRajalBillableCandidate(r, range, accepted);
      // Legacy `isMatchingRecordPenunjang` (source line 1045): an unpaid
      // penunjang visit in range means its charges were never transferred onto
      // the clinic bill, so the patient must not be paid yet. Legacy matched
      // "Penunjang" case-sensitively; matching case-insensitively here blocks a
      // superset, which is the fail-closed direction.
      const untransferred = rows.filter(
        (r) => candidate(r) && (r.nama_unit ?? '').toUpperCase().includes(RAJAL_PENUNJANG_UNIT_KEYWORD),
      );
      const blockedPatients = new Set(untransferred.flatMap((r) => (r.patientId ? [r.patientId] : [])));
      // Legacy `findMatchingRecords` (source lines 728-745) resolves the unit
      // against the selected clinics with the scored matcher and *drops* the
      // record when two clinics tie — billing it would attribute the visit to a
      // guessed poli, and the SEP lookup downstream would use that guess.
      const ambiguous: string[] = [];
      const matching: RajalRecordRow[] = [];
      for (const r of rows) {
        if (!candidate(r) || (r.patientId !== undefined && blockedPatients.has(r.patientId))) continue;
        const match = resolveRajalClinicMatch(r.nama_unit ?? '', clinics);
        if (match.ambiguous) {
          ambiguous.push(`${r.no_transaksi} (${r.nama_unit ?? '?'} → ${match.matches.join(' | ')})`);
          ctx.log(
            `Poli kunjungan ambigu, kunjungan dilewati: ${r.nama_unit ?? '?'} → ${match.matches.join(' | ')}`,
            'warn',
          );
          continue;
        }
        if (!match.matchedClinic) continue;
        matching.push({ ...r, matchedClinic: match.matchedClinic });
      }
      state.matching = matching;
      state.batchRecords = matching.map((r) => ({ patientId: r.patientId ?? '', trx: r.no_transaksi, clinic: r.matchedClinic ?? '' }));
      for (const id of blockedPatients) patientNote(ctx, id, 'kunjungan penunjang belum ditransfer & belum dibayar');
      for (const r of rows) {
        if (r.patientId && candidate(r) && !blockedPatients.has(r.patientId) && resolveRajalClinicMatch(r.nama_unit ?? '', clinics).ambiguous) {
          patientNote(ctx, r.patientId, `poli ambigu (${r.nama_unit ?? '?'})`);
        }
      }
      const clinicPatientIds = new Map<string, Set<string>>();
      for (const clinic of clinics) {
        const key = clinic.trim().toUpperCase();
        if (key && !clinicPatientIds.has(key)) clinicPatientIds.set(key, new Set());
      }
      const allPatientIds = new Set<string>();
      let hasUnidentifiedMatch = false;
      for (const record of matching) {
        const patientId = record.patientId?.trim();
        const clinic = record.matchedClinic?.trim().toUpperCase();
        if (!patientId || !clinic) {
          hasUnidentifiedMatch = true;
          continue;
        }
        const patients = clinicPatientIds.get(clinic);
        if (!patients) {
          hasUnidentifiedMatch = true;
          continue;
        }
        patients.add(patientId);
        allPatientIds.add(patientId);
      }
      const clinicCountEvidence = {
        label: 'rajal.clinic-counts',
        source: RAJAL_NODE.filterRecords,
        data: {
          basis: 'matched-visits',
          complete: (state.historyUnreadableCount ?? 0) === 0 && !hasUnidentifiedMatch,
          totalClinics: clinicPatientIds.size,
          totalPatients: allPatientIds.size,
          clinics: [...clinicPatientIds].map(([clinic, patients]) => ({ clinic, patientCount: patients.size })),
        },
      };
      const penunjang = untransferred.map((r) => `${r.no_transaksi} (${r.nama_unit ?? 'penunjang'})`);
      let result: StepResult;
      if (matching.length === 0) {
        if (penunjang.length > 0) result = blocked(`Kunjungan penunjang belum ditransfer dan belum dibayar: ${penunjang.join(', ')}`);
        else if (ambiguous.length > 0) {
          result = review(`Tidak ada kunjungan yang jelas: ${ambiguous.length} kunjungan cocok dengan dua poli terpilih — ${ambiguous.join('; ')}`);
        } else result = skipped('Tidak ada kunjungan yang cocok');
      } else {
        const passedOver = [
          ...(penunjang.length ? [`${penunjang.length} skipped for untransferred penunjang visit(s): ${penunjang.join(', ')}`] : []),
          ...(ambiguous.length ? [`${ambiguous.length} dilewati karena ambigu: ${ambiguous.join('; ')}`] : []),
        ];
        result = passedOver.length > 0
          ? review(`${matching.length} kunjungan cocok; ${passedOver.join('; ')}`)
          : ok(`${matching.length} kunjungan cocok`);
      }
      return { ...result, evidence: [...(result.evidence ?? []), clinicCountEvidence] };
    },

    /**
     * Legacy source lines 886-889 read `kasir.getRencanaOnko` to drop chemo-course
     * visits. SIMRS no longer has that page (404 on every registration, checked
     * live 2026-10-27, re-checked 2026-11-09 with no replacement in the kasir,
     * poliklinik or kemoterapi pages), and legacy read any failure as "no chemo" — so the check
     * had been silently passing everything. The node now says so instead of
     * spending one dead request per patient.
     * ponytail: re-wire `evaluateRajalOncologyPlan` if SIMRS restores the endpoint.
     */
    'rajal.checkRencanaOnko': async (ctx) => {
      const matching = rajalState(ctx).matching ?? [];
      if (matching.length === 0) return skipped('Tidak ada kunjungan');
      return skipped('Tidak dicek — SIMRS tidak lagi menyediakan rencana onkologi; pastikan pasien kemoterapi secara manual');
    },

    /**
     * Legacy source lines 891-892: a visit with no `tgl_keluar` has not been
     * discharged by the clinic and must not be billed — a hard block.
     *
     * Reads `poliklinik.getDataCaraKeluarTab`, the endpoint legacy itself read.
     * The port used to substitute `tgl_keluar` off the `gethistorykunjungan`
     * row, which was never confirmed to carry the field for outpatient rows.
     * Legacy's `!ck?.tgl_keluar` treats absent, null and empty alike once the
     * discharge tab has answered, so all three block; only a reply that is not
     * a record at all is unreadable, and that never passes.
     */
    'rajal.validateExitDate': async (ctx) => {
      const matching = rajalState(ctx).matching ?? [];
      if (matching.length === 0) return skipped('Tidak ada kunjungan');
      const kept: RajalRecordRow[] = [];
      const missing: string[] = [];
      const unreadable: string[] = [];
      const dropped = new Set<string>();
      for (const rec of matching) {
        // Fail closed on a read error: a patient whose discharge state is
        // unknown must not be billed (parity item 1), so this read is NOT
        // wrapped — an UnexpectedResponseError fails the guard, by design.
        const verdict = evaluateRajalExitDateResponse(
          await client.postJson<unknown>(
            'poliklinik.getDataCaraKeluarTab',
            { no_registrasikunjungan: rec.no_registrasikunjungan },
            { signal: ctx.signal },
          ),
        );
        if (!verdict.readable) {
          unreadable.push(rec.no_transaksi);
          dropped.add(rec.no_transaksi);
        } else if (!verdict.present) {
          missing.push(rec.no_transaksi);
          dropped.add(rec.no_transaksi);
        } else kept.push(rec);
      }
      if (dropped.size > 0) {
        rajalState(ctx).matching = kept;
        pruneRajalRecords(ctx, dropped);
        if (missing.length > 0 && kept.length === 0) {
          return blocked(
            `Belum ada tanggal keluar pada ${missing.length} kunjungan: ${missing.join(', ')} — kunjungan belum ditutup`,
          );
        }
        const issues = [
          ...(missing.length ? [`Tanggal keluar kosong pada ${missing.length} kunjungan: ${missing.join(', ')}`] : []),
          ...(unreadable.length
            ? [`Tanggal keluar tidak terbaca pada ${unreadable.length}/${matching.length} kunjungan: ${unreadable.join(', ')}`]
            : []),
        ];
        return review(kept.length === 0
          ? `${issues.join('; ')} — getdatacarakeluar_tab did not answer with a discharge record`
          : `${kept.length} record(s) remain after exit-date check; ${issues.join('; ')}`);
      }
      return ok(`${matching.length} kunjungan sudah punya tanggal keluar`);
    },

    'rajal.validateTransaction': async (ctx) => {
      const matching = rajalState(ctx).matching ?? [];
      if (matching.length === 0) return skipped('Tidak ada kunjungan');
      const transactions: RajalTransactionState[] = [];
      const inpatient: string[] = [];
      const notRajal: string[] = [];
      const unreadable: string[] = [];
      const dropped = new Set<string>();
      for (const rec of matching) {
        // Legacy rejected rawat inap via `kasir.getDataTransaksi.jenis_sep`
        // (source line 894). On this backend that endpoint returns an empty body
        // for every outpatient transaction (verified live), so the port could
        // never pass a record through here. `kasir.getDataKunjunganTab` answers
        // the same visit reliably and carries `kd_instalasi` — '1' Rawat Jalan,
        // '2' Rawat Inap, '3' IGD, '14' Penunjang — which is the robust
        // discriminator for exactly the same rejection.
        const tab = await attempt(() => client.postJson<{ kd_instalasi?: string }>(
          'kasir.getDataKunjunganTab',
          {
            no_registrasikunjungan: rec.no_registrasikunjungan,
            kd_unit: rec.kd_unit,
            no_transaksi: rec.no_transaksi,
          },
          { signal: ctx.signal },
        ));
        if (!tab.ok) {
          // Parity item 13: an unreadable read is "not read", never a crash.
          ctx.log(`Data kunjungan tidak terbaca pada ${rec.no_transaksi}: ${tab.message}`, 'warn');
          unreadable.push(rec.no_transaksi);
          dropped.add(rec.no_transaksi);
          continue;
        }
        const instalasi = (tab.value.kd_instalasi ?? '').trim();
        const kind = classifyRajalInstalasi(instalasi);
        if (kind === 'inpatient') {
          inpatient.push(rec.no_transaksi);
          dropped.add(rec.no_transaksi);
          continue;
        }
        if (kind !== 'rajal') {
          // Not a rawat jalan transaction (IGD / penunjang / unknown) — the kasir
          // outpatient cashier does not own it, so it must not be billed here.
          notRajal.push(`${rec.no_transaksi} (instalasi ${instalasi || '?'})`);
          dropped.add(rec.no_transaksi);
          continue;
        }
        // Best-effort `no_sep` source: the same endpoint that cannot discriminate
        // type sometimes carries the current SEP. Empty is fine — `validate_sep`
        // resolves the authoritative SEP from BPJS history and only plans a
        // correction when this differs.
        const tx = await attempt(() => client.postJson<{ no_sep?: string }>(
          'kasir.getDataTransaksi',
          {
            txtmedrec: (rec.patientId ?? '').trim(),
            no_transaksi: rec.no_transaksi,
            kd_unit: rec.kd_unit,
            no_registrasikunjungan: rec.no_registrasikunjungan,
          },
          { signal: ctx.signal },
        ));
        // Empty/unreadable — treated as "no SEP on file", never fatal.
        const noSep = tx.ok ? (tx.value.no_sep ?? '').trim() : '';
        transactions.push({ record: rec, tx: { no_sep: noSep } });
      }
      rajalState(ctx).transactions = transactions;
      const issues = [
        ...(inpatient.length ? [`${inpatient.length} Rawat Inap: ${inpatient.join(', ')}`] : []),
        ...(notRajal.length ? [`${notRajal.length} bukan Rawat Jalan: ${notRajal.join(', ')}`] : []),
        ...(unreadable.length ? [`${unreadable.length} unreadable: ${unreadable.join(', ')}`] : []),
      ];
      if (dropped.size > 0) {
        pruneRajalRecords(ctx, dropped);
        ctx.log(
          `Cek jenis transaksi: ${transactions.length} Rawat Jalan, ${dropped.size} dibuang (${issues.join('; ')})`,
          transactions.length === 0 ? 'warn' : 'info',
        );
        if (transactions.length === 0) {
          if (inpatient.length > 0 && notRajal.length === 0 && unreadable.length === 0) {
            return blocked(`Transaksi ${inpatient.join(', ')} adalah Rawat Inap, bukan Rawat Jalan`);
          }
          return review(`Tidak ada transaksi Rawat Jalan yang bisa ditagih — ${issues.join('; ')}`);
        }
        return review(`${transactions.length} transaksi Rawat Jalan; ${issues.join('; ')}`);
      }
      ctx.log(`Cek jenis transaksi: ${transactions.length} transaksi Rawat Jalan`, 'info');
      return ok(`${transactions.length} transaksi Rawat Jalan`);
    },

    'rajal.validateTreatment': async (ctx) => {
      const state = rajalState(ctx);
      const cfg = state.config!;
      const matching = state.matching ?? [];
      if (matching.length === 0) return skipped('Tidak ada kunjungan');
      const include = normalizeKeywords(cfg.tindakanIncludeKeywords);
      const exclude = normalizeKeywords(cfg.tindakanExcludeKeywords);
      const history = state.history ?? [];
      const consultByTrx: Record<string, RajalConsultKind> = {};
      const treatmentStates: RajalTreatmentState[] = [];
      const hard: string[] = [];
      const review: string[] = [];
      const dropped = new Set<string>();
      let matchedCount = 0;
      let totalCount = 0;
      // Operator-facing checklist: what each rule found on each bill.
      const checklist: ReasoningItem[] = [];
      const withReasoning = <T extends StepResult>(result: T): T => (checklist.length
        ? { ...result, evidence: [...(result.evidence ?? []), reasoningEvidence({ title: `${matching.length} kunjungan diperiksa`, items: checklist })] }
        : result);
      for (const rec of matching) {
        const patientHistory = history.filter((visit) => visit.patientId === rec.patientId);
        const consult = rec.patientId && patientHistory.length > 0
          ? evaluateRajalConsultVisit({ visitDate: rec.tgl_masuk ?? '', unit: rec.nama_unit ?? '', history: patientHistory })
          : 'unknown';
        consultByTrx[rec.no_transaksi] = consult;
        if (consult === 'unknown') {
          review.push(`Kunjungan poli belum dapat dipastikan pada ${rec.no_transaksi}: tanggal/unit atau riwayat pasien tidak terbaca`);
          dropped.add(rec.no_transaksi);
          continue;
        }
        const otherUnit = patientHistory.find((visit) => normalizeDate(visit.tgl_masuk ?? '') === normalizeDate(rec.tgl_masuk ?? '')
          && visit.nama_unit?.trim().toUpperCase() !== rec.nama_unit?.trim().toUpperCase()
          && /^POLI\s+\S/i.test(visit.nama_unit ?? ''))?.nama_unit;
        ctx.log(consult === 'consult'
          ? `Konsul terdeteksi: ${rec.no_transaksi} (${rec.nama_unit} → ${otherUnit})`
          : `Kunjungan satu poli: ${rec.no_transaksi}`);
        // `kasir.getListTindakan` returns an empty body for every outpatient
        // transaction on this backend (the kasir cashier only answers inside a
        // loaded kasir page). The poli-side controller carries the same billed
        // lines — `nama_tindakan`, `jumlah`, `flag`, `urut_tindakan` — and
        // answers reliably. Read it once here; `check_payment` reuses the rows
        // for the payable amount and the already-paid signal instead of the
        // equally dead `kasir.getJumlahBayar`.
        const read = await attempt(() => client.postJson<{ rows?: RajalTindakanRow[] }>(
          'poliklinik.getListTindakan',
          {
            no_transaksi: rec.no_transaksi,
            page: '1',
            rows: '100',
          },
          { signal: ctx.signal },
        ));
        if (!read.ok) {
          // Parity item 13: an unreadable read is "not read", never a crash.
          review.push(`Daftar tindakan tidak terbaca pada ${rec.no_transaksi}: ${read.message}`);
          dropped.add(rec.no_transaksi);
          continue;
        }
        const td = read.value;
        // Legacy source line 898: a reply with no `rows` array is not an empty
        // bill, it is an unread bill.
        if (!Array.isArray(td?.rows)) {
          review.push(`Daftar tindakan ${rec.no_transaksi} tidak terbaca: jawaban tanpa baris`);
          dropped.add(rec.no_transaksi);
          continue;
        }
        const allRows = td.rows;
        const unknown = unclassifiedPenunjangRows(allRows);
        if (unknown.length > 0) {
          review.push(`Penunjang belum digolongkan pada ${rec.no_transaksi}: ${unknown.map((row) => row.nama_tindakan).join(', ')}`);
          dropped.add(rec.no_transaksi);
          continue;
        }
        totalCount += allRows.length;

        // Legacy `verifyTreatmentGroups` (source lines 762-782) plus the
        // operator include/exclude filter — see `evaluateRajalBillRules`.
        const billedNames = allRows.map((row) => row.nama_tindakan ?? '');
        for (const item of rajalTreatmentChecklist(billedNames, cfg.treatmentGroups ?? [], cfg.skipTreatments ?? [])) {
          checklist.push(matching.length > 1 ? { ...item, label: `${rec.no_transaksi} · ${item.label}` } : item);
        }
        const bill = evaluateRajalBillRules(rec.no_transaksi, allRows, {
          include,
          exclude,
          groups: cfg.treatmentGroups ?? [],
          skipTreatments: cfg.skipTreatments ?? [],
          minCount: cfg.tindakanMinCount,
        });
        if (!bill.ok) {
          (bill.severity === 'hard' ? hard : review).push(bill.reason);
          dropped.add(rec.no_transaksi);
          continue;
        }
        const rows = bill.rows;
        matchedCount += rows.length;
        treatmentStates.push({ record: rec, rows, allRows });
      }
      state.rajalConsultByTrx = consultByTrx;
      state.treatments = treatmentStates;
      if (dropped.size > 0) {
        pruneRajalRecords(ctx, dropped);
        if (hard.length > 0 && treatmentStates.length === 0) {
          return withReasoning(blocked(hard.length === 1 ? hard[0]! : `Blocker tindakan: ${hard.join('; ')}`));
        }
        const issues = [...hard, ...review];
        return withReasoning({
          status: 'needs_review',
          summary: treatmentStates.length === 0
            ? issues.join('; ')
            : `${treatmentStates.length} record(s) remain after treatment check; ${issues.length} skipped — ${issues.join('; ')}`,
        });
      }
      return withReasoning(ok(
        include.length || exclude.length
          ? `${matchedCount}/${totalCount} baris tindakan cocok dengan aturan pada ${matching.length} kunjungan`
          : `${matchedCount} baris tindakan pada ${matching.length} kunjungan`,
      ));
    },

    /**
     * Legacy lines 909-922. A billed radiology treatment needs an order dated
     * on the visit, approved (or already served), and one result transaction
     * per billed treatment, each carrying a report.
     */
    'rajal.validateRadiology': penunjangValidator(
      'Radiologi',
      isRadiologyTreatmentName,
      async ({ ctx, record, medrec, date, orders }) => {
        const history = await client.postJson<{ rows?: RajalIradOrderRow[] }>(
          'poliklinik.getHistoryIrad',
          { nomedrec: medrec, page: '1', rows: '10' },
          { signal: ctx.signal },
        );
        const sameDay = rowsField(history).filter((row) => (row.tgl_order ?? '').startsWith(date));
        if (sameDay.length === 0) {
          return blocked(
            `Order radiologi belum ada pada ${record.no_transaksi}: ${orders.length} tindakan radiologi ditagih tetapi tidak ada order tanggal ${date}`,
          );
        }
        const unapproved = sameDay.filter(
          (row) => row.status_approve !== '1' && !(row.tgl_terlayani ?? '').trim(),
        );
        if (unapproved.length > 0) {
          return blocked(
            `Order radiologi belum disetujui pada ${record.no_transaksi}: ${unapproved.length}/${sameDay.length} order belum disetujui maupun dilayani`,
          );
        }
        // Legacy line 917 calls `radiologi/hasil_pemeriksaan/get_datapasien`,
        // which that controller does not expose — its result-search action is
        // `getdatakunjungan`, and it takes the same `txtmedreccari_hslrad`.
        // Legacy sends no paging, so neither do we: `page=1&rows=10` would cap
        // a heavy day's studies at ten and shrink the count comparison below.
        const search = await client.postJson<{ rows?: RajalPenunjangResultRow[] }>(
          'radiologi.getDataKunjungan',
          { txtmedreccari_hslrad: medrec },
          { signal: ctx.signal },
        );
        const results = rowsField(search).filter((row) => (row.tgl_transaksi ?? '').startsWith(date));
        if (results.length !== orders.length) {
          return blocked(
            `Hasil radiologi kurang pada ${record.no_transaksi}: ${orders.length} tindakan radiologi ditagih vs ${results.length} transaksi hasil tanggal ${date}`,
          );
        }
        for (const row of results) {
          const hasil = await client.postJson<RajalHasilResponse>(
            'radiologi.getHasilPemeriksaan',
            { no_transaksi: row.no_transaksi ?? '' },
            { signal: ctx.signal },
          );
          if (resultCount(hasil) === 0) {
            return blocked(
              `Hasil radiologi belum ada pada ${record.no_transaksi}: belum ada ekspertise pada transaksi radiologi ${row.no_transaksi ?? '(tanpa nomor)'}`,
            );
          }
        }
        return null;
      },
    ),

    /**
     * Legacy lines 929-938. One elektromedik result transaction per billed
     * treatment, and every result must carry a description.
     */
    'rajal.validateElektromedik': penunjangValidator(
      'Elektromedik',
      isElektromedikTreatmentName,
      async ({ ctx, record, medrec, date, orders }) => {
        // Legacy line 933 reads the *hasil* controller's own patient search.
        // The port previously substituted the registrasi controller's visit
        // history, which lists orders whether or not they have a result — the
        // wrong side of the count comparison below. No paging, as legacy sent
        // none.
        const history = await client.postJson<{ rows?: RajalPenunjangResultRow[] }>(
          'elektromedikHasil.getDataPasien',
          { no_medicalrecord: medrec },
          { signal: ctx.signal },
        );
        const results = rowsField(history).filter((row) => (row.tgl_transaksi ?? '').startsWith(date));
        if (results.length !== orders.length) {
          return blocked(
            `Hasil elektromedik kurang pada ${record.no_transaksi}: ${orders.length} tindakan elektromedik ditagih vs ${results.length} transaksi hasil tanggal ${date}`,
          );
        }
        for (const row of results) {
          const hasil = await client.postJson<RajalHasilResponse>(
            'elektromedikHasil.getListHasilPemeriksaan',
            { no_transaksi: row.no_transaksi ?? '' },
            { signal: ctx.signal },
          );
          if (resultCount(hasil) === 0 || !(hasil.rows?.[0]?.deskripsi ?? '').trim()) {
            return blocked(
              `Hasil elektromedik belum ada pada ${record.no_transaksi}: belum ada uraian pada transaksi elektromedik ${row.no_transaksi ?? '(tanpa nomor)'}`,
            );
          }
        }
        return null;
      },
    ),

    /**
     * Legacy lines 945-957 plus `checkLabPAResult` (line 711). A billed
     * "LABORATORIUM PA" row needs a PA order dated on the visit, with detail
     * lines and a printable result.
     */
    'rajal.validateLabPa': penunjangValidator(
      'Lab PA',
      isLabPaTreatmentName,
      async ({ ctx, record, medrec, date, orders }) => {
        const history = await client.postJson<{ rows?: RajalPaOrderRow[] }>(
          'kemoterapi.getHistoryOrderPa',
          { nomedrec: medrec, page: '1', rows: '10' },
          { signal: ctx.signal },
        );
        const rows = rowsField(history);
        if (rows.length === 0) {
          return blocked(
            `Order Lab PA belum ada pada ${record.no_transaksi}: ${orders.length} tindakan PA ditagih tetapi tidak ada order PA`,
          );
        }
        const legacyDate = formatRajalLegacyDate(date);
        const order = rows.find((row) => row.tgl_transaksi === legacyDate);
        const paTx = (order?.no_transaksi ?? '').trim();
        if (!paTx) {
          return blocked(
            `Order Lab PA belum ada pada ${record.no_transaksi}: tidak ada order PA tanggal ${legacyDate}`,
          );
        }
        // GET with the order number in the query string, exactly as legacy did.
        const detail = await client.postJson<{ rows?: readonly unknown[] }>(
          'kemoterapi.getDetailHistoryOrderPa',
          {},
          { query: { no_trans: paTx }, signal: ctx.signal },
        );
        if (rowsField(detail).length === 0) {
          return blocked(
            `Order Lab PA belum lengkap pada ${record.no_transaksi}: order PA ${paTx} tidak punya baris pemeriksaan`,
          );
        }
        const printout = (
          await client.postText(
            'pa.hasilCetak',
            {},
            {
              query: {
                no_medicalrecord: medrec,
                no_transaksi: paTx,
                kd_jenis_pemeriksaan: order?.kd_jenis_pemeriksaan ?? '1',
              },
              signal: ctx.signal,
            },
          )
        ).trim();
        if (
          !printout ||
          printout.toLowerCase() === 'data tidak ada' ||
          printout.length <= RAJAL_LAB_PA_MIN_RESULT_LENGTH
        ) {
          return blocked(
            `Hasil Lab PA belum ada pada ${record.no_transaksi}: order PA ${paTx} belum punya hasil cetak`,
          );
        }
        return null;
      },
    ),

    /**
     * Legacy lines 965-988 plus `validateLabResult` (line 552). A billed
     * "LABORATORIUM" row needs a lab order dated on the visit and a result.
     * The result probe follows legacy's order: old-LIS link, LIS empty markers,
     * same-host `/lis_new/pdf.php` HEAD, then GET fallback.
     */
    'rajal.validateLab': penunjangValidator(
      'Laboratorium',
      isRegularLabTreatmentName,
      async ({ ctx, record, medrec, date, orders }) => {
        const history = await client.postJson<{ rows?: RajalPenunjangResultRow[] }>(
          'penatajasaInap.getHistoryILab',
          { nomedrec: medrec, page: '1', rows: '10' },
          { signal: ctx.signal },
        );
        const legacyDate = formatRajalLegacyDate(date);
        const order = rowsField(history).find((row) => row.tgl_transaksi === legacyDate);
        const labTx = (order?.no_transaksi ?? '').trim();
        if (!labTx) {
          return blocked(
            `Order laboratorium belum ada pada ${record.no_transaksi}: ${orders.length} tindakan lab ditagih tetapi tidak ada order lab tanggal ${legacyDate}`,
          );
        }
        const markup = await client.postText(
          'laboratoriumHasil.cetakLis',
          { no_transaksi: labTx },
          { signal: ctx.signal },
        );
        const lower = markup.toLowerCase();
        const emptyMarker = RAJAL_LAB_EMPTY_RESULT_MARKERS.find((marker) => lower.includes(marker));
        if (emptyMarker) {
          return blocked(
            `Hasil laboratorium belum ada pada ${record.no_transaksi}: order lab ${labTx} melaporkan "${emptyMarker}"`,
          );
        }
        if (markup.trim().length < RAJAL_LAB_MIN_LIS_MARKUP_LENGTH) {
          return blocked(
            `Hasil laboratorium belum ada pada ${record.no_transaksi}: order lab ${labTx} menghasilkan cetakan LIS kosong`,
          );
        }
        const target = resolveRajalLisPdfTarget(markup, labTx);
        if (target.kind === 'old-lis') return null;
        const query = { no_transaksi: target.noTransaksi };
        // Legacy falls back to GET when the HEAD probe cannot be read.
        const head = await attempt(() => client.raw('laboratoriumHasil.lisPdfHead', { query, signal: ctx.signal }));
        let verdict = head.ok && head.value.status >= 200 && head.value.status < 300 ? evaluateRajalLabPdfHead(head.value.headers) : null;
        if (!verdict) {
          const pdf = await attempt(() => client.raw('laboratoriumHasil.lisPdf', { query, signal: ctx.signal }));
          if (!pdf.ok) {
            return blocked(
              `Hasil laboratorium belum ada pada ${record.no_transaksi}: order lab ${labTx} galat GET: ${pdf.message}`,
            );
          }
          verdict = evaluateRajalLabPdfGet(pdf.value.status, pdf.value.bodyBytes);
        }
        if (!verdict.hasResult) {
          return blocked(
            `Hasil laboratorium belum ada pada ${record.no_transaksi}: order lab ${labTx} ${verdict.reason}`,
          );
        }
        return null;
      },
    ),

    /**
     * Legacy `checkSep` (lines 797-864). A non-empty `no_sep` on the
     * transaction is not enough: the SEP must exist in the patient's BPJS
     * history, be dated on the visit, be an RJTL (outpatient) service, and its
     * `poli_tujuan` must map to the clinic being billed. When the patient has
     * several visits that day, one unique sibling-clinic SEP is accepted as the
     * "poli asal" SEP, mirroring legacy. A SEP that resolves to a different
     * number than the transaction carries is a planned `simpanSep` correction —
     * never written in preview.
     * Update SEP means a reviewable plan requiring approval, never an immediate write.
     */
    'rajal.validateSep': async (ctx) => {
      const state = rajalState(ctx);
      const cfg = state.config!;
      const clinics = state.clinics ?? [];
      // Legacy source line 1057 builds the sibling set from `matching` — the
      // records that passed the clinic/date/penjamin filter — not from the raw
      // history. Using the history would let a dropped penunjang visit donate
      // its SEP to a clinic bill.
      const matching = state.matching ?? [];
      const transactions = state.transactions ?? [];
      if (transactions.length === 0) return skipped('Tidak ada transaksi');
      // Legacy `sepCheckRequired = false`: no SEP lookup and no correction plan.
      // `skipped` is benign in the runner, so payment checks still run.
      if (cfg.sepCheckRequired === false) {
        ctx.log('Validasi SEP dinonaktifkan untuk run ini (sepCheckRequired = false)');
        return skipped('Validasi SEP dinonaktifkan untuk run ini');
      }
      const plans: MutationPlan[] = [];
      const kept: RajalTransactionState[] = [];
      // One checklist line per transaction: the SEP the bill should carry, and whether it does.
      const sepChecks: ReasoningItem[] = [];
      const sepLabel = (trx: string) => (transactions.length > 1 ? `${trx} · SEP RJTL hari kunjungan` : 'SEP RJTL hari kunjungan');
      const withSepReasoning = (result: StepResult): StepResult => (sepChecks.length
        ? { ...result, evidence: [...(result.evidence ?? []), reasoningEvidence({ title: `SEP RJTL dicocokkan per transaksi (${transactions.length})`, items: sepChecks })] }
        : result);
      const hard: string[] = [];
      const failed: string[] = [];
      const dropped = new Set<string>();
      for (const state of transactions) {
        const { record, tx } = state;
        const date = recordVisitDate(record, cfg.date);
        const clinic = matchedClinic(record, clinics);
        const candidates = rajalClinicCandidates(clinic);

        // Legacy `getCardNumber`: prefer no_kk, fall back to the guarantor tab
        // when it is absent, a "33…" family-card number, or too short.
        const visit = await client.postJson<{ no_kk?: string }>(
          'pendaftaran.getDataKunjungan',
          { txtmedrec_pdft: (record.patientId ?? '').trim() },
          { signal: ctx.signal },
        );
        // Bound separately: TS will not narrow a non-empty check on a call result.
        let rawCard = (visit.no_kk ?? '').trim();
        // Same rule as the inpatient path: one shared helper, not a copy.
        if (noKkRejectionReason(rawCard) !== '') {
          const penjamin = await client.postJson<{ no_asuransi?: string }>(
            'pendaftaran.getDataPenjaminTab',
            { no_registrasikunjungan: record.no_registrasikunjungan },
            { signal: ctx.signal },
          );
          rawCard = (penjamin.no_asuransi ?? '').trim();
        }
        const card = normalizeCardNumber(rawCard);
        if (!card) {
          sepChecks.push({ label: sepLabel(record.no_transaksi), ok: false, detail: 'no kartu BPJS kosong / tidak ditemukan' });
          hard.push(`No kartu BPJS kosong untuk transaksi ${record.no_transaksi}`);
          dropped.add(record.no_transaksi);
          continue;
        }

        const history = await attempt(() => fetchSepHistory(client, card, ctx));
        if (!history.ok) {
          sepChecks.push({ label: sepLabel(record.no_transaksi), ok: false, detail: 'riwayat SEP BPJS tidak terbaca' });
          failed.push(`Riwayat SEP tidak terbaca pada ${record.no_transaksi}: ${history.message}`);
          dropped.add(record.no_transaksi);
          continue;
        }
        const sep = resolveRajalSep({
          rows: history.value,
          date,
          candidates,
          clinic,
          sameDayVisits: matching.filter(
            (row) => row.patientId === record.patientId && recordVisitDate(row, cfg.date) === date,
          ),
          clinics,
        });
        if (sep.kind === 'ambiguous') {
          sepChecks.push({ label: sepLabel(record.no_transaksi), ok: false, detail: `lebih dari satu kandidat SEP: ${sep.candidates.join(', ')}` });
          hard.push(`Multiple same-day SEP candidates for transaction ${record.no_transaksi} (${sep.candidates.join(', ')})`);
          dropped.add(record.no_transaksi);
          continue;
        }
        if (sep.kind === 'sibling') ctx.log(`Memakai SEP poli serumpun ${sep.noSep} untuk ${clinic}`, 'info');
        const resolved = sep.kind === 'none' ? '' : sep.noSep;

        if (!resolved) {
          sepChecks.push({ label: sepLabel(record.no_transaksi), ok: false, detail: `tidak ada SEP ${RAJAL_SEP_SERVICE_TYPE} tgl ${date} untuk poli ${candidates[0] ?? clinic}` });
          hard.push(
            `Tidak ada SEP ${RAJAL_SEP_SERVICE_TYPE} tanggal ${date} untuk poli ${candidates[0] ?? clinic} pada transaksi ${record.no_transaksi}`,
          );
          dropped.add(record.no_transaksi);
          continue;
        }
        kept.push(state);
        const current = (tx.no_sep ?? '').trim();
        if (current === resolved) {
          sepChecks.push({ label: sepLabel(record.no_transaksi), ok: true, detail: `${resolved} sudah terpasang` });
        } else {
          sepChecks.push({ label: sepLabel(record.no_transaksi), ok: false, detail: `tagihan ${current || '(kosong)'} → ${resolved}`, planId: `${ctx.runId}:rekamMedis.simpanSep:${record.no_transaksi}` });
        }
        if (current !== resolved) {
          plans.push({
            id: `${ctx.runId}:rekamMedis.simpanSep:${record.no_transaksi}`,
            endpointId: 'rekamMedis.simpanSep',
            riskLevel: 'high',
            reason: `Koreksi SEP pada transaksi ${record.no_transaksi}: ${current || '(kosong)'} → ${resolved}`,
            preconditions: [
              {
                description: `SEP ${RAJAL_SEP_SERVICE_TYPE} ada untuk tanggal kunjungan dan poli tujuan`,
                check: 'pendaftaran.getRiwayatSep',
                // The replay read is keyed on the BPJS card, not on the plan's
                // payload — without this it would be handed the SEP write's own
                // fields and address nothing.
                payload: { no_kartu: card },
                expected: { tgl_sep: date, jns_pelayanan: RAJAL_SEP_SERVICE_TYPE, no_sep: resolved },
              },
            ],
            payload: { no_registrasikunjungan: record.no_registrasikunjungan, no_sep: resolved },
            payloadSummary: {
              no_registrasikunjungan: record.no_registrasikunjungan,
              no_sep: resolved,
            },
            requiresApproval: true,
            idempotencyKey: `${ctx.runId}:${record.no_transaksi}:sep`,
            readAfterWriteCheck: {
              description: 'Riwayat SEP memuat SEP hasil koreksi',
              // `kasir.getDataTransaksi` answers with an empty body on this
              // backend, so a successful write was reported as `failed`. The
              // guard's own read (`pendaftaran.getRiwayatSep`, keyed on the
              // card) is the one that demonstrably answers, and it is what the
              // SEP precondition is already replayed against. `subset` matches
              // the expected SEP number anywhere in the returned rows.
              endpointId: 'pendaftaran.getRiwayatSep',
              payload: { no_kartu: card },
              field: '',
              match: 'subset',
              expected: { no_sep: resolved },
            },
          });
        }
      }
      if (dropped.size > 0) {
        state.transactions = kept;
        pruneRajalRecords(ctx, dropped);
        if (kept.length === 0) {
          if (hard.length > 0) return withSepReasoning(blocked(hard.length === 1 ? hard[0]! : `Blocker SEP: ${hard.join('; ')}`));
          return withSepReasoning(fail(failed.join('; ')));
        }
        return withSepReasoning(review(`${kept.length} SEP transaksi tersisa; ${[...hard, ...failed].length} dilewati — ${[
          ...hard,
          ...failed,
        ].join('; ')}`, { proposedMutations: plans }));
      }
      if (plans.length > 0) {
        return withSepReasoning(review(
          `SEP tidak cocok pada ${plans.length}/${transactions.length} transaksi; koreksi direncanakan (dry-run)`,
          { proposedMutations: plans },
        ));
      }
      return withSepReasoning(ok(`${transactions.length} SEP transaksi cocok dengan tanggal kunjungan dan poli tujuan`));
    },

    /**
     * Opt-in notice (Setup › "Cek kelengkapan berkas (OCR)"), same contract as
     * ranap `check_berkas`: reads each visit's e-klaim bundle (kd_instalasi=1)
     * and lists the claim documents found or missing. Never drops a visit and
     * never blocks — the operator still checks the bundle by hand.
     */
    'rajal.checkBerkas': async (ctx) => {
      const reader = deps.berkas;
      if (!reader) return skipped('Cek berkas (OCR) tidak tersedia di host ini');
      const cfg = rajalState(ctx).config!;
      const treatments = rajalState(ctx).treatments ?? [];
      // One bundle per registration; same-day clinics have their own.
      const visits = new Map<string, RajalTreatmentState[]>();
      for (const state of treatments) visits.set(state.record.no_registrasikunjungan, [...(visits.get(state.record.no_registrasikunjungan) ?? []), state]);
      if (visits.size === 0) return skipped('Tidak ada kunjungan');
      const items: ReasoningItem[] = [];
      const missing: string[] = [];
      for (const [reg, states] of visits) {
        const record = states[0]!.record;
        const patientId = (record.patientId ?? '').trim();
        const date = recordVisitDate(record, cfg.date);
        const who = `${patientId} · ${record.nama_unit ?? record.kd_unit}`;
        const progress = (p: BerkasProgressPort) =>
          ctx.log(`Berkas ${who}: ${p.label}`, 'debug', { [BERKAS_PROGRESS_KEY]: { phase: p.phase, done: p.done, total: p.total, label: visits.size > 1 ? `${patientId}: ${p.label}` : p.label } });
        const index = await softJson<{ rows?: Record<string, unknown>[] }>(ctx, client, 'uploadBerkas.getDataPiutang', berkasIndexPayload({ noRm: patientId, from: date, to: date, kdInstalasi: '1' }));
        const row = rowsField(index).find((r) => String(r['no_registrasikunjungan'] ?? '') === reg);
        const noSep = String(row?.['no_sep'] ?? '').trim();
        if (!noSep) {
          missing.push(`${who}: berkas e-klaim ${row ? 'tanpa SEP' : 'belum ditemukan'}`);
          items.push({ label: `Berkas ${who}`, ok: false, detail: row ? 'tanpa no SEP' : 'tidak ada di daftar berkas' });
          continue;
        }
        progress({ phase: 'unduh', done: 0, total: 1, label: 'mengunduh PDF berkas…' });
        const res = await softRead(ctx, 'eklaim.cetakSimplifikasi', () => client.raw('eklaim.cetakSimplifikasi', { query: { no_transaksi: 'undefined', no_sep: noSep, no_register: reg, kd_instalasi: '1' }, signal: ctx.signal }), undefined);
        const pdf = res && res.status === 200 && res.bodyBytes && String.fromCharCode(...res.bodyBytes.subarray(0, 4)) === '%PDF' ? res.bodyBytes : undefined;
        if (!pdf) {
          missing.push(`${who}: PDF berkas tidak terbaca`);
          items.push({ label: `Berkas ${who}`, ok: false, detail: 'PDF tidak terbaca' });
          continue;
        }
        // Cache per No. RM + visit date; the unit keeps same-day clinics apart.
        const cacheKey = `${patientId}_${date}_${date}_${record.kd_unit}`;
        const report = await reader.read(pdf, { cacheKey, onProgress: progress, signal: ctx.signal });
        const result = evaluateBerkas(report, berkasFactsOf(states.flatMap((s) => s.allRows.map((r) => r.nama_tindakan ?? '')), false, 'rajal'));
        const lines = [
          `Kelengkapan Berkas${visits.size > 1 ? ` (${who})` : ''}:`,
          ...result.checks.map((check, i) => `   ${i + 1}. ${check.label} ${check.found
            ? `${check.probable ? '✓ kemungkinan (foto bergrid EKG)' : '✓'} ${pageList(check.pages)}`
            : `✗ belum ada — ${check.why}`}`),
          ...(result.others.length ? [`   Dokumen lain: ${result.others.map((o) => `${o.label} (${pageList(o.pages)})`).join('; ')}`] : []),
          `   ${report.pageCount} halaman · ${report.photoPages} foto${report.fromCache ? ' · dari cache' : report.ocrRun ? ` · ${report.ocrRun} di-OCR` : ''}`,
        ];
        for (const line of lines) ctx.log(line, result.missing.length ? 'warn' : 'info');
        for (const check of result.checks) {
          const label = visits.size > 1 ? `${who} · ${check.label}` : check.label;
          items.push({ label, ok: check.found ? (check.probable ? null : true) : false, detail: check.found ? pageList(check.pages) : `belum ada — ${check.why}` });
        }
        for (const check of result.missing) missing.push(visits.size > 1 ? `${who}: ${check.label}` : check.label);
      }
      const result: StepResult = missing.length
        ? review(`Berkas belum lengkap: ${missing.join(', ')} — periksa manual`)
        : ok(`Berkas lengkap untuk ${visits.size} kunjungan`);
      return { ...result, evidence: [reasoningEvidence({ title: 'Dokumen wajib klaim dicari di berkas e-klaim (judul halaman, OCR untuk foto)', items })] };
    },

    'rajal.checkPayment': async (ctx) => {
      // Payment state comes from the billed lines `validate_treatment` already
      // read via `poliklinik.getListTindakan` (the kasir `getJumlahBayar` is dead
      // on this backend). A line's `flag` is `"Belum"`/`"Sudah"`; the payable
      // total is the sum of `jumlah`, and `sudah` is the sum already paid.
      const treatments = rajalState(ctx).treatments ?? [];
      if (treatments.length === 0) return skipped('Tidak ada kunjungan', { branches: { check_payment__check_verification: 'skip' } });
      const payable: RajalPaymentState[] = [];
      let paid = 0;
      const unreadable: string[] = [];
      const dropped = new Set<string>();
      const payChecks: ReasoningItem[] = [];
      const rupiah = rupiahText;
      const payLabel = (trx: string) => (treatments.length > 1 ? `${trx} · Belum ada pembayaran` : 'Belum ada pembayaran');
      const withPayReasoning = <T extends StepResult>(result: T): T => (payChecks.length
        ? { ...result, evidence: [...(result.evidence ?? []), reasoningEvidence({ title: 'Status bayar dari baris tagihan poliklinik', items: payChecks })] }
        : result);
      for (const state of treatments) {
        const { record, allRows } = state;
        const { total, sudah, sawFlag } = tallyRajalBillLines(allRows);
        // Billing lines but no paid flag anywhere = the payment state could not
        // be read. Surface it for review rather than silently dropping the
        // record (parity: "unreadable read is not read", never a silent skip).
        if (allRows.length === 0 || !sawFlag) {
          payChecks.push({ label: payLabel(record.no_transaksi), ok: false, detail: 'status bayar tidak terbaca' });
          unreadable.push(record.no_transaksi);
          dropped.add(record.no_transaksi);
          continue;
        }
        // Unpaid means nothing marked paid yet (legacy `tunai==="0" && piutang==="0"`).
        payChecks.push(sudah === 0
          ? { label: payLabel(record.no_transaksi), ok: true, detail: `tagihan ${rupiah(total)}, belum dibayar` }
          : { label: payLabel(record.no_transaksi), ok: false, detail: `sudah dibayar ${rupiah(sudah)} dari ${rupiah(total)} — dilewati` });
        if (sudah === 0) payable.push({ record, pay: { total: String(total), sudah: String(sudah) } });
        else {
          paid += 1;
          dropped.add(record.no_transaksi);
        }
      }
      rajalState(ctx).payable = payable;
      if (dropped.size > 0) pruneRajalRecords(ctx, dropped);
      ctx.log(
        `Cek pembayaran: ${payable.length} bisa dibayar, ${paid} sudah dibayar${unreadable.length ? `, ${unreadable.length} unreadable` : ''}`,
        unreadable.length > 0 ? 'warn' : 'info',
      );
      if (unreadable.length > 0) {
        return withPayReasoning(review(
          payable.length === 0
            ? `Status bayar tidak terbaca pada ${unreadable.length}/${treatments.length} kunjungan: ${unreadable.join(', ')}`
            : `${payable.length}/${treatments.length} payable record(s); payment state unreadable on ${unreadable.length}: ${unreadable.join(', ')}`,
          { branches: { check_payment__check_verification: payable.length > 0 ? 'take' : 'block' } },
        ));
      }
      if (payable.length === 0) return withPayReasoning(skipped(`Sudah dibayar (${paid} kunjungan)`, { branches: { check_payment__check_verification: 'skip' } }));
      return withPayReasoning({ ...ok(`${payable.length}/${treatments.length} kunjungan bisa dibayar`), branches: { check_payment__check_verification: 'take' } });
    },

    /**
     * Legacy source lines 1004-1018. Before a bill may be paid, three separate
     * blockers must be clear — unserved orders, untransferred orders, and an
     * unverified penunjang transaction — and only then is the verification
     * status consulted. All three were missing from the port: it read only
     * `cekstatus_verifikasi`, and swallowed a failed read as `'0'`.
     *
     * An *already verified* record still gets paid (legacy's `else` branch at
     * line 1017 falls through to `tampung_bayar`), so this step no longer
     * removes it from `payable`; it only decides whether a `simpan_verifikasi`
     * write has to be planned first.
     */
    'rajal.checkVerification': async (ctx) => {
      const state = rajalState(ctx);
      const payable = state.payable ?? [];
      if (payable.length === 0) return skipped('Tidak ada kunjungan', { branches: { check_verification__submit_payment: 'skip' } });
      const plans: MutationPlan[] = [];
      const kept: RajalPaymentState[] = [];
      const hard: string[] = [];
      const review: string[] = [];
      const dropped = new Set<string>();
      let alreadyVerified = 0;

      // Second pass on a write run: `ctx.mutations` now carries the outcome of
      // every verification plan this node proposed. Legacy verifies *and then*
      // pays; without this barrier the payment plan was built from
      // `cekstatus_verifikasi === '0'` (not yet verified) and could be approved
      // against a bill whose verification never landed.
      const previouslyPlanned = state.verificationPlanByTrx ?? {};
      const observedTrx = Object.keys(previouslyPlanned);
      if (observedTrx.length > 0) {
        const confirmed: RajalPaymentState[] = [];
        const stillOpen: RajalPaymentState[] = [];
        const notLanded: string[] = [];
        for (const entry of payable) {
          const planId = previouslyPlanned[entry.record.no_transaksi];
          if (!planId) {
            stillOpen.push(entry);
            continue;
          }
          const outcome = ctx.mutations[planId];
          if (outcome?.status === 'verified') {
            alreadyVerified += 1;
            confirmed.push(entry);
          } else if (outcome?.status === 'applied') {
            notLanded.push(`${entry.record.no_transaksi}: terpasang tapi belum terverifikasi read-after-write`);
          } else if (outcome) {
            notLanded.push(`${entry.record.no_transaksi}: verifikasi ${outcome.status}${outcome.reason ? ` — ${outcome.reason}` : ''}`);
          }
        }
        // A record whose verification was planned but never settled keeps
        // waiting; the runner parks this node until every plan settles.
        if (notLanded.length === 0 && stillOpen.length === 0) {
          state.payable = confirmed;
          return { ...ok(`${confirmed.length} kunjungan terverifikasi; siap dirancang pembayarannya`), branches: { check_verification__submit_payment: confirmed.length > 0 ? 'take' : 'skip' } };
        }
        if (notLanded.length > 0) {
          // Drop the records whose verification did not land: they must not be
          // paid, whatever the rest of the batch does.
          const droppedTrx = new Set(notLanded.map((entry) => entry.split(':')[0]!));
          state.payable = payable.filter((entry) => !droppedTrx.has(entry.record.no_transaksi));
          pruneRajalRecords(ctx, droppedTrx);
          return {
            status: 'needs_review',
            summary: `Verifikasi belum berhasil untuk ${notLanded.length} kunjungan: ${notLanded.join('; ')}`,
            branches: { check_verification__submit_payment: state.payable && state.payable.length > 0 ? 'take' : 'block' },
          };
        }
        // Still-open records fall through to the normal first-pass handling.
        state.payable = [...confirmed, ...stillOpen];
      }
      for (const entry of payable) {
        const { record } = entry;
        const orderArgs = {
          no_registrasikunjungan: record.no_registrasikunjungan,
          no_transaksi: record.no_transaksi,
          kd_unit: record.kd_unit,
        };
        const unserved = evaluateRajalOrderBlocker(
          await client.postJson<unknown>('kasir.cekOrderBelumTerlayani', orderArgs, { signal: ctx.signal }),
        );
        if (unserved.blocking) {
          hard.push(
            `Unserved order(s) on ${record.no_transaksi}: ${unserved.total} outstanding${unserved.namaUnit ? ` at ${unserved.namaUnit}` : ''}`,
          );
          dropped.add(record.no_transaksi);
          continue;
        }
        const untransferred = evaluateRajalOrderBlocker(
          await client.postJson<unknown>('kasir.cekOrderBelumTransfer', orderArgs, { signal: ctx.signal }),
        );
        if (untransferred.blocking) {
          hard.push(
            `Untransferred order(s) on ${record.no_transaksi}: ${untransferred.total} outstanding${untransferred.namaUnit ? ` at ${untransferred.namaUnit}` : ''}`,
          );
          dropped.add(record.no_transaksi);
          continue;
        }
        // The live backend answers a clean registration with HTTP 200 and an
        // *empty* body; the client decodes that as `{}`, which
        // `evaluateRajalPenunjangBlocker` reads as "no blocker" — the same
        // meaning legacy's `null` had in `if(pc && Object.keys(pc).length)`.
        const penunjang = evaluateRajalPenunjangBlocker(
          await client.postJson<unknown>(
            'verifikator.cekTransaksiPenunjang',
            { no_registrasikunjungan: record.no_registrasikunjungan },
            { signal: ctx.signal },
          ),
        );
        if (penunjang.blocking) {
          hard.push(
            `Unverified penunjang transaction on ${record.no_transaksi}: ${penunjang.namaUnit || penunjang.data || 'blocker reported'}`,
          );
          dropped.add(record.no_transaksi);
          continue;
        }

        const status = (
          await client.postText(
            'kasir.cekStatusVerifikasi',
            { no_transaksi: record.no_transaksi },
            { signal: ctx.signal },
          )
        ).trim();
        // The endpoint answers with a bare number. Anything else is a failed
        // read, and legacy's `else` branch would have called it "verified" and
        // paid — so refuse to interpret it.
        if (!/^\d+$/.test(status)) {
          review.push(`Status verifikasi tidak terbaca pada ${record.no_transaksi}: "${status.slice(0, 40)}"`);
          dropped.add(record.no_transaksi);
          continue;
        }
        if (status === '0' && state.config?.enableVerifikasi === false) {
          review.push(`${record.no_transaksi} belum diverifikasi — Verifikasi dimatikan di Setup`);
          dropped.add(record.no_transaksi);
          continue;
        }
        kept.push(entry);
        if (status !== '0') {
          alreadyVerified += 1;
          continue;
        }
        plans.push({
          id: `${ctx.runId}:verifikator.simpanVerifikasi:${record.no_transaksi}`,
          endpointId: 'verifikator.simpanVerifikasi',
          riskLevel: 'critical',
          reason: `Tutup verifikasi registrasi ${record.no_registrasikunjungan} sebelum pembayaran`,
          // Each check names the body it must be replayed with: the plan's own
          // payload is `{no_registrasikunjungan}`, which would not address the
          // transaction-scoped reads.
          preconditions: [
            {
              description: 'Verifikasi masih terbuka',
              check: 'kasir.cekStatusVerifikasi',
              payload: { no_transaksi: record.no_transaksi },
              expected: '0',
            },
            {
              description: 'Tidak ada order belum terlayani',
              check: 'kasir.cekOrderBelumTerlayani',
              payload: orderArgs,
              // A clean registration answers `{}` or `{total: 0}` — both are
              // "empty". Asserting `{total: 0}` as a subset would refuse the
              // `{}` reply outright.
              match: 'empty',
              expected: 0,
            },
            {
              description: 'Tidak ada order belum ditransfer',
              check: 'kasir.cekOrderBelumTransfer',
              payload: orderArgs,
              match: 'empty',
              expected: 0,
            },
            {
              description: 'Tidak ada transaksi penunjang belum diverifikasi',
              check: 'verifikator.cekTransaksiPenunjang',
              payload: { no_registrasikunjungan: record.no_registrasikunjungan },
              match: 'empty',
              expected: 0,
            },
          ],
          payload: { no_registrasikunjungan: record.no_registrasikunjungan },
          payloadSummary: { no_registrasikunjungan: record.no_registrasikunjungan },
          requiresApproval: true,
          idempotencyKey: `${ctx.runId}:${record.no_transaksi}:verifikasi`,
          readAfterWriteChecks: [
            {
              description: 'Status verifikasi tertutup',
              endpointId: 'kasir.cekStatusVerifikasi',
              payload: { no_transaksi: record.no_transaksi },
              // The endpoint answers with a bare "0"/"1", not an object — an empty
              // field path compares the whole response.
              field: '',
              match: 'equals',
              expected: '1',
            },
            {
              description: 'Tidak ada order belum terlayani setelah verifikasi',
              endpointId: 'kasir.cekOrderBelumTerlayani',
              payload: orderArgs,
              field: '',
              match: 'empty',
              expected: 0,
            },
            {
              description: 'Tidak ada order belum ditransfer setelah verifikasi',
              endpointId: 'kasir.cekOrderBelumTransfer',
              payload: orderArgs,
              field: '',
              match: 'empty',
              expected: 0,
            },
            {
              description: 'Tidak ada transaksi penunjang belum diverifikasi setelah verifikasi',
              endpointId: 'verifikator.cekTransaksiPenunjang',
              payload: { no_registrasikunjungan: record.no_registrasikunjungan },
              field: '',
              match: 'empty',
              expected: 0,
            },
          ],
        });
      }
      // Remember which plan belongs to which transaction so the second pass can
      // tell a landed verification from a planned one. Without this the payment
      // plan would be built from a verification nobody approved.
      const planByTrx: Record<string, string> = {};
      for (const plan of plans) {
        const trx = plan.idempotencyKey?.split(':')[1];
        if (trx) planByTrx[trx] = plan.id;
      }
      state.verificationPlanByTrx = planByTrx;

      if (dropped.size > 0) {
        state.payable = kept;
        pruneRajalRecords(ctx, dropped);
        if (kept.length === 0 && hard.length > 0) return { ...blocked(hard.length === 1 ? hard[0]! : `Blocker verifikasi: ${hard.join('; ')}`), branches: { check_verification__submit_payment: 'block' } };
        return {
          status: 'needs_review',
          summary: kept.length === 0
            ? review.join('; ')
            : `${kept.length}/${payable.length} payable record(s) remain after verification checks; ${[
              ...hard,
              ...review,
            ].join('; ')}`,
          proposedMutations: plans,
          branches: { check_verification__submit_payment: kept.length > 0 ? 'take' : 'block' },
          // Write runs only; the runner ignores it in preview.
          ...(plans.length > 0 ? { needsReplan: true } : {}),
        };
      }
      if (plans.length > 0) {
        return {
          status: 'needs_review',
          summary: `${plans.length}/${payable.length} kunjungan perlu verifikasi sebelum pembayaran; write direncanakan (dry-run)`,
          proposedMutations: plans,
          branches: { check_verification__submit_payment: 'take' },
          // Write runs only; the runner ignores it in preview.
          needsReplan: true,
        };
      }
      return { ...ok(`${alreadyVerified} kunjungan bisa dibayar sudah terverifikasi; tidak ada blocker`), branches: { check_verification__submit_payment: 'take' } };
    },

    'rajal.submitPayment': async (ctx) => {
      const state = rajalState(ctx);
      const cfg = state.config!;
      const payable = state.payable ?? [];
      const treatments = state.treatments ?? [];
      if (payable.length === 0) return skipped('Tidak ada kunjungan untuk dibayar');
      if (cfg.enableTampungBayar === false) return skipped(`Tampung bayar dimatikan di Setup — ${payable.length} kunjungan siap dibayar tidak dirancang`);
      // Second pass on a write run: the node parked until every payment settled; report, never re-plan.
      if (ctx.pass > 1) {
        const planIds = state.paymentPlanIds ?? [];
        const statuses = planIds.map((id) => ctx.mutations[id]?.status ?? 'planned');
        const paid = statuses.filter((status) => status === 'verified' || status === 'applied').length;
        const summary = `${paid}/${planIds.length} tampung bayar tertulis${paid < planIds.length ? `; ${planIds.length - paid} tidak tertulis — lihat rincian rencana` : ''}`;
        return { status: paid === planIds.length ? 'success' : 'needs_review', summary };
      }
      // `tindakan` must be the cashier grid's rows (kasir.getListTindakan: the
      // 20 kasir fields incl. no_transaksi, kd_detjenispembayaran). The poli
      // rows lack no_transaksi and the live endpoint answered "Undefined
      // property: stdClass::$no_transaksi" (kasir.php:7743, run 2026-10-20).
      // A bill whose kasir rows are missing or disagree with the poli rows
      // gets no plan: never stage a payment over lines we could not match.
      const kasirRows = new Map<string, readonly unknown[]>();
      const held: string[] = [];
      for (const { record } of payable) {
        const billed = treatments.find((entry) => entry.record.no_transaksi === record.no_transaksi);
        const read = await attempt(() => client.postJson<{ rows?: unknown[] } | unknown[]>('kasir.getListTindakan', {
          no_transaksi: record.no_transaksi,
          no_registrasikunjungan: record.no_registrasikunjungan,
          kd_unit: record.kd_unit,
          page: '1',
          rows: '200',
        }, { signal: ctx.signal }));
        if (!read.ok) {
          held.push(`${record.no_transaksi}: baris kasir tidak terbaca (${read.error instanceof Error ? read.message.slice(0, 80) : read.message})`);
          continue;
        }
        const res = read.value;
        const rows: readonly unknown[] = Array.isArray(res) ? res : rowsField(res);
        const expected = billed?.allRows.length ?? 0;
        if (rows.length === 0 || rows.length !== expected) {
          held.push(`${record.no_transaksi}: ${rows.length} baris kasir vs ${expected} baris tindakan poli — tidak dirancang`);
          continue;
        }
        kasirRows.set(record.no_transaksi, rows);
      }
      const plans: MutationPlan[] = payable.filter(({ record }) => kasirRows.has(record.no_transaksi)).map(({ record, pay }): MutationPlan => {
        const payload = buildRajalTampungBayarPayload({
          noReg: record.no_registrasikunjungan,
          noTransaksi: record.no_transaksi,
          kdUnit: record.kd_unit,
          total: pay.total ?? '0',
          sudah: pay.sudah ?? '0',
          tindakanRows: kasirRows.get(record.no_transaksi)!,
          payment: cfg.paymentConfig ?? RAJAL_DEFAULT_PAYMENT_CONFIG,
        });
        const orderArgs = {
          no_registrasikunjungan: record.no_registrasikunjungan,
          no_transaksi: record.no_transaksi,
          kd_unit: record.kd_unit,
        };
        return {
          id: `${ctx.runId}:kasir.tampungBayar:${record.no_transaksi}`,
          endpointId: 'kasir.tampungBayar',
          riskLevel: 'critical',
          reason: `Tampung bayar transaksi ${record.no_transaksi}`,
          // These are the checks that actually guard `tampung_bayar`, in the
          // order legacy runs them (source lines 999-1018) plus the Python's
          // payment-history guard (ranap_v3.py:3799). The previous port asserted
          // `cekStatusVerifikasi === '0'`, which encoded a misreading: legacy
          // *verifies first and then pays*, so a correct write reaches this
          // endpoint with verification already closed. Once preconditions are
          // replayed at write time that assertion would have refused every
          // legitimate payment.
          //
          // Each check carries the body it must be replayed with. The default
          // would be this plan's own payload, whose reg lives under `no_reg`
          // (the cashier write's spelling) where every read below wants
          // `no_registrasikunjungan` — so without these the replay would query
          // an unscoped registration.
          preconditions: [
            {
              // Legacy verifies *then* pays: a correct write reaches this
              // endpoint only after `cekstatus_verifikasi` reads "1". Approving a
              // payment against a still-open verification stages money on a
              // bill nobody closed.
              description: 'Verifikasi sudah tertutup',
              check: 'kasir.cekStatusVerifikasi',
              payload: { no_transaksi: record.no_transaksi },
              field: '',
              match: 'equals',
              expected: '1',
            },
            {
              // `kasir.getJumlahBayar` is dead on this backend; the billed lines
              // carry the paid flag. Re-read them at write time and require every
              // line still unpaid — an empty bill fails closed (allEquals).
              description: 'Belum dibayar (tidak ada baris bertanda lunas)',
              check: 'poliklinik.getListTindakan',
              payload: {
                no_transaksi: record.no_transaksi,
                page: '1',
                rows: '100',
              },
              field: 'rows.flag',
              match: 'allEquals',
              expected: 'Belum',
            },
            {
              description: 'Belum ada riwayat pembayaran',
              check: 'kasir.getHistoryPembayaran',
              // A GET: its parameters travel in the query string or vanish.
              query: {
                no_registrasikunjungan: record.no_registrasikunjungan,
                no_transaksi: record.no_transaksi,
              },
              expected: [],
            },
            {
              description: 'Tidak ada order belum terlayani',
              check: 'kasir.cekOrderBelumTerlayani',
              payload: orderArgs,
              match: 'empty',
              expected: 0,
            },
            {
              description: 'Tidak ada order belum ditransfer',
              check: 'kasir.cekOrderBelumTransfer',
              payload: orderArgs,
              match: 'empty',
              expected: 0,
            },
            {
              description: 'Tidak ada transaksi penunjang belum diverifikasi',
              check: 'verifikator.cekTransaksiPenunjang',
              payload: { no_registrasikunjungan: record.no_registrasikunjungan },
              match: 'empty',
              expected: 0,
            },
          ],
          payload,
          // What the payment changes, for the operator: the bill and the amount staged.
          payloadSummary: { ...payload, perubahan: `belum dibayar → tampung ${rupiahText(Number(pay.total ?? 0) - Number(pay.sudah ?? 0))} (tagihan ${rupiahText(Number(pay.total ?? 0))}, ${kasirRows.get(record.no_transaksi)!.length} baris)` },
          requiresApproval: true,
          idempotencyKey: `${ctx.runId}:${record.no_transaksi}`,
          readAfterWriteCheck: {
            description: 'Riwayat pembayaran terisi',
            endpointId: 'kasir.getHistoryPembayaran',
            query: {
              no_registrasikunjungan: record.no_registrasikunjungan,
              no_transaksi: record.no_transaksi,
            },
            field: 'length',
            expected: 1,
          },
        };
      });
      for (const reason of held) ctx.log(reason, 'warn');
      state.paymentPlanIds = plans.map((plan) => plan.id);
      const summary = `${plans.length} pembayaran direncanakan${ctx.mode === 'write' ? '' : ' (dry-run)'}${held.length ? `; ${held.length} ditahan — ${held.join('; ')}` : ''}`;
      // Park until the payments settle: the run must stay live while they are
      // approved and applied (manual or auto), or an approval after the run
      // ends is refused. Write runs only; the runner ignores it in preview.
      return { status: 'needs_review', summary, proposedMutations: plans, ...(plans.length ? { needsReplan: true } : {}) };
    },

    'rajal.confirmResult': (ctx) => {
      if (ctx.mode !== 'write') return ok('Preview — tidak ada pembayaran untuk dikonfirmasi');
      const { verified, bad, open } = paymentTally(ctx);
      const summary = [`${verified} pembayaran terverifikasi`, bad ? `${bad} gagal — cek manual di SIMRS` : '', open ? `${open} belum selesai` : ''].filter(Boolean).join('; ');
      return bad || open ? review(summary) : ok(summary);
    },

    'rajal.emitPatientSummary': (ctx) => {
      const matching = rajalState(ctx).matching ?? [];
      if (ctx.mode !== 'write') return ok(`Pasien diproses: ${matching.length} kunjungan ditinjau (preview)`);
      return ok(`Pasien diproses: ${matching.length} kunjungan; ${paymentTally(ctx).verified} dibayar`);
    },

    'rajal.emitBatchSummary': (ctx) => {
      const total = rajalState(ctx).batchTotal ?? 0;
      const outcomes = patientOutcomes(ctx);
      const passed = outcomes.filter((row) => row.status === 'lolos').length;
      const skippedCount = outcomes.length - passed;
      // One line per patient, so the Log view (searchable by No. RM) answers "what happened to X".
      for (const row of outcomes) {
        ctx.log(
          row.status === 'lolos'
            ? `• ${row.patientId} — lolos semua cek${row.clinics.length ? ` · ${row.clinics.join(', ')}` : ''}`
            : `• ${row.patientId} — dilewati${row.step ? ` di ${stepLabel(row.step)}` : ''}: ${row.reason}`,
          row.status === 'lolos' ? 'info' : 'warn',
        );
      }
      const mode = ctx.mode === 'write' ? `write: ${paymentTally(ctx).verified} pembayaran terverifikasi` : 'hanya preview — tidak ada write yang diterapkan';
      const summary = `Antrean selesai: ${passed} lolos, ${skippedCount} dilewati dari ${total} pasien; ${mode}`;
      ctx.log(summary, 'info');
      const result = ok(summary, { evidence: [{ label: RAJAL_PATIENT_OUTCOMES_EVIDENCE, source: RAJAL_NODE.emitBatchSummary, data: { rows: outcomes } }] });
      return skippedCount > 0 && passed === 0 ? { ...result, status: 'needs_review' } : result;
    },
  });
}

/**
 * BPJS SEP history for one card number. The bridge is flaky, so legacy retried
 * it up to four times; the last failure still propagates (fail closed) rather
 * than being reported as "no SEP".
 */
async function fetchSepHistory(
  client: EvoMedisClient,
  card: string,
  ctx: ExecutorContext,
): Promise<readonly RajalSepRow[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RAJAL_SEP_HISTORY_ATTEMPTS; attempt++) {
    try {
      const res = await client.postJson<RajalSepRow[]>(
        'pendaftaran.getRiwayatSep',
        { no_kartu: card },
        { signal: ctx.signal },
      );
      if (Array.isArray(res)) return res;
      lastError = new Error('Jawaban riwayat SEP bukan daftar');
    } catch (err) {
      lastError = err;
      ctx.log(`Percobaan riwayat SEP ${attempt}/${RAJAL_SEP_HISTORY_ATTEMPTS} gagal`, 'warn');
    }
    if (ctx.signal.aborted) break;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface RajalUnpaidBatchArgs extends RajalUnpaidReportQuery, RajalUnpaidReportFilters {}

/**
 * Legacy `doFetch` (source line 1451) — batch discovery.
 *
 * The I/O shell for {@link parseRajalUnpaidReport} +
 * {@link selectRajalUnpaidBatch}: GET the unpaid-bill report for a date range
 * and turn it into the patient list and clinic chips a run is given.
 *
 * It has no node of its own — it decides *which records exist* rather than
 * judging one, so `rajal.normalizeIds` calls it when `RajalInput.discovery` is
 * set and populates the batch the rest of the graph already consumes. It stays
 * exported because it is also useful on its own, to preview a period.
 *
 * `laporanBelumBayar.preview` is a GET, so every parameter travels in
 * `options.query`; a body would be dropped by the client.
 */
export async function fetchRajalUnpaidBatch(
  client: EvoMedisClient,
  args: RajalUnpaidBatchArgs,
  options: { signal?: AbortSignal } = {},
): Promise<RajalUnpaidBatch> {
  const html = await client.postText(
    'laporanBelumBayar.preview',
    {},
    {
      query: buildRajalUnpaidReportQuery(args),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const filters: RajalUnpaidReportFilters = {
    ...(args.penjamin !== undefined ? { penjamin: args.penjamin } : {}),
    ...(args.unit !== undefined ? { unit: args.unit } : {}),
  };
  return selectRajalUnpaidBatch(parseRajalUnpaidReport(html, filters), filters);
}

/** The discovery filters, spelled for an operator reading a skip reason. */
function describeFilters(discovery: RajalDiscoveryInput): string {
  const instalasi = discovery.instalasi ?? '1';
  const parts = [
    `instalasi ${RAJAL_INSTALASI_OPTIONS.find((option) => option.code === instalasi)?.label ?? instalasi}`,
    ...(discovery.penjamin?.trim() ? [`penjamin "${discovery.penjamin.trim()}"`] : []),
    ...(discovery.unit?.trim() ? [`unit "${discovery.unit.trim()}"`] : []),
  ];
  return parts.join(', ');
}

/**
 * Operator checklists for the rajal steps that do not build their own.
 *
 * Most rajal guards have several early returns, so rather than threading a
 * checklist through each one, every executor is wrapped once: when its result
 * carries no reasoning, one is built from what the step actually decided —
 * the records it kept (✓) or dropped (✗, with the reason it gave), the plans it
 * proposed (✗ linked by `planId`, flipping to ✓ once verified). Never a guessed ✓.
 */
type RecordKey = 'matching' | 'treatments' | 'payable';

const recordOf = (entry: RajalRecordRow | { record: RajalRecordRow }): RajalRecordRow =>
  'record' in entry ? entry.record : entry;

function recordsIn(ctx: ExecutorContext, key: RecordKey): RajalRecordRow[] {
  const entries: readonly (RajalRecordRow | { record: RajalRecordRow })[] = rajalState(ctx)[key] ?? [];
  return entries.map(recordOf);
}

/** Leads with the No. RM so a multi-patient batch reads per patient (the Log view groups on it). */
const recordLabel = (record: RajalRecordRow) => `${record.patientId ? `${record.patientId} · ` : ''}${record.no_transaksi} · ${record.nama_unit ?? record.kd_unit}`;

/** The clause of a summary that names this transaction — the reason it was dropped. */
function reasonFor(summary: string, trx: string): string {
  return summary.split(/;\s+|\s+—\s+/).find((part) => part.includes(trx))?.trim() ?? summary;
}

/** Records the step had before vs after: kept ✓, dropped ✗ with its reason. */
function keptDropped(before: readonly RajalRecordRow[], after: readonly RajalRecordRow[], result: StepResult, passed: string): ReasoningItem[] {
  const kept = new Set(after.map((record) => record.no_transaksi));
  return before.map((record): ReasoningItem => kept.has(record.no_transaksi)
    ? { label: recordLabel(record), ok: true, detail: passed }
    : { label: recordLabel(record), ok: false, detail: reasonFor(result.summary, record.no_transaksi) });
}

interface ChecklistArgs {
  readonly ctx: ExecutorContext;
  readonly result: StepResult;
  readonly before: Record<RecordKey, RajalRecordRow[]>;
}

type ChecklistBuilder = (args: ChecklistArgs) => { title: string; items: ReasoningItem[] };

const PENUNJANG_CHECKS: Record<string, [string, (nameLower: string) => boolean]> = {
  validateRadiology: ['radiologi', isRadiologyTreatmentName],
  validateElektromedik: ['elektromedik', isElektromedikTreatmentName],
  validateLabPa: ['lab PA', isLabPaTreatmentName],
  validateLab: ['laboratorium', isRegularLabTreatmentName],
};

function penunjangChecklist(kind: string, applies: (nameLower: string) => boolean): ChecklistBuilder {
  return ({ ctx, result, before }) => {
    const states = rajalState(ctx).treatments ?? [];
    const items = keptDropped(before.treatments, recordsIn(ctx, 'treatments'), result, '').map((item, index): ReasoningItem => {
      if (!item.ok) return item;
      const trx = before.treatments[index]!.no_transaksi;
      const orders = states.find((state) => state.record.no_transaksi === trx)?.allRows.filter((row) => applies(tindakanNameLower(row))) ?? [];
      return orders.length === 0
        ? { ...item, ok: null, detail: `tidak ada tindakan ${kind}` }
        : { ...item, detail: `${orders.length} tindakan ${kind} — order & hasil lengkap` };
    });
    return { title: `Order & hasil ${kind} untuk tindakan yang ditagih`, items };
  };
}

const RAJAL_CHECKLISTS: Record<string, ChecklistBuilder> = {
  loadConfig: ({ ctx, result }) => {
    const input = (ctx.input ?? {}) as RajalInput;
    const failed = result.status !== 'success';
    if (input.discovery) {
      return { title: 'Input run diperiksa', items: [
        { label: 'Periode cari otomatis', ok: !failed, detail: failed ? result.summary : `${input.discovery.from} → ${input.discovery.to}` },
        { label: 'Batas pasien per run', ok: null, detail: input.discovery.maxPatients ? String(input.discovery.maxPatients) : 'tanpa batas' },
      ] };
    }
    return { title: 'Input run diperiksa', items: [
      { label: 'No RM diisi', ok: Boolean(input.patientIds?.length), detail: `${input.patientIds?.length ?? 0} pasien` },
      { label: 'Poli dipilih', ok: Boolean(input.clinics?.length), detail: input.clinics?.join(', ') || 'kosong' },
      { label: 'Penjamin diterima', ok: null, detail: (input.acceptedPenjaminKeywords ?? RAJAL_DEFAULT_ACCEPTED_PENJAMIN).join(', ') },
      { label: 'Cek SEP', ok: null, detail: input.sepCheckRequired === false ? 'dinonaktifkan' : 'aktif' },
    ] };
  },
  normalizeIds: ({ ctx, result }) => {
    const state = rajalState(ctx);
    const ids = state.ids ?? [];
    const batch = state.discovery;
    const items: ReasoningItem[] = [];
    if (state.config?.discovery) {
      items.push(batch
        ? { label: 'Laporan belum bayar terbaca', ok: true, detail: `${batch.stats.total} baris, ${batch.stats.filtered} cocok filter` }
        : { label: 'Laporan belum bayar terbaca', ok: false, detail: result.summary });
      if (batch && result.status === 'blocked') items.push({ label: 'Jumlah pasien dalam batas', ok: false, detail: result.summary });
    }
    items.push(...ids.map((id): ReasoningItem => ({ label: id, ok: true, detail: 'No RM valid' })));
    return { title: `${ids.length} No RM unik`, items };
  },
  resolveClinics: ({ ctx, result }) => {
    const clinics = rajalState(ctx).clinics ?? [];
    return { title: 'Poli yang diproses', items: clinics.length
      ? clinics.map((clinic): ReasoningItem => ({ label: clinic, ok: true, detail: 'dipilih di Setup' }))
      : [{ label: 'Poli terpilih', ok: false, detail: result.summary }] };
  },
  startBatch: ({ ctx }) => ({ title: 'Batch dimulai', items: [
    { label: 'Pasien dalam batch', ok: null, detail: String(rajalState(ctx).batchTotal ?? 0) },
  ] }),
  loadHistory: ({ ctx, result }) => {
    const history = rajalState(ctx).history ?? [];
    const items = (rajalState(ctx).ids ?? []).map((id): ReasoningItem => {
      const rows = history.filter((row) => row.patientId === id).length;
      if (rows > 0) return { label: id, ok: true, detail: `${rows} kunjungan terbaca` };
      return result.summary.includes(id) ? { label: id, ok: false, detail: 'riwayat kunjungan tidak terbaca' } : { label: id, ok: null, detail: 'tidak ada kunjungan' };
    });
    return { title: 'Riwayat kunjungan per pasien', items };
  },
  filterRecords: ({ ctx, result }) => {
    const cfg = rajalState(ctx).config;
    const history = rajalState(ctx).history ?? [];
    const matching = recordsIn(ctx, 'matching');
    const flagged = history.filter((row) => !matching.some((m) => m.no_transaksi === row.no_transaksi) && result.summary.includes(row.no_transaksi));
    const rest = history.filter((row) => !matching.some((m) => m.no_transaksi === row.no_transaksi) && !flagged.includes(row));
    const { from, to } = cfg ? rajalEffectiveRange(cfg) : { from: '-', to: '-' };
    // Per visit, not "n kunjungan lain": in a batch each one is how a patient left the run.
    return { title: `Kunjungan belum bayar ${from} → ${to}, penjamin & poli cocok`, items: [
      ...matching.map((record): ReasoningItem => ({ label: recordLabel(record), ok: true, detail: `${record.nama_penjamin ?? '-'} → ${record.matchedClinic ?? '-'}` })),
      ...flagged.map((record): ReasoningItem => ({ label: recordLabel(record), ok: false, detail: reasonFor(result.summary, record.no_transaksi) })),
      ...rest.map((record): ReasoningItem => ({
        label: recordLabel(record),
        ok: null,
        detail: record.status_bayar && !/^belum/i.test(record.status_bayar) ? `tidak dipilih — status bayar ${record.status_bayar}` : 'tidak dipilih — beda tanggal, penjamin atau poli',
      })),
    ] };
  },
  checkRencanaOnko: ({ ctx, result, before }) => ({
    title: 'Rencana onkologi bukan kemoterapi',
    items: keptDropped(before.matching, recordsIn(ctx, 'matching'), result, 'tanpa rencana kemoterapi'),
  }),
  validateExitDate: ({ ctx, result, before }) => ({
    title: 'Tanggal keluar poli terisi',
    items: keptDropped(before.matching, recordsIn(ctx, 'matching'), result, 'tanggal keluar ada'),
  }),
  validateTransaction: ({ ctx, result, before }) => ({
    title: 'Transaksi milik Rawat Jalan',
    items: keptDropped(before.matching, recordsIn(ctx, 'matching'), result, 'instalasi Rawat Jalan'),
  }),
  validateTreatment: ({ ctx, result, before }) => {
    const states = rajalState(ctx).treatments ?? [];
    return { title: 'Daftar tindakan per transaksi', items: keptDropped(before.matching, recordsIn(ctx, 'treatments'), result, '').map((item, index) =>
      item.ok ? { ...item, detail: `${states.find((s) => s.record.no_transaksi === before.matching[index]!.no_transaksi)?.allRows.length ?? 0} tindakan terbaca` } : item) };
  },
  ...Object.fromEntries(Object.entries(PENUNJANG_CHECKS).map(([ref, [kind, applies]]) => [ref, penunjangChecklist(kind, applies)])),
  checkVerification: ({ ctx, result, before }) => {
    const planByTrx = rajalState(ctx).verificationPlanByTrx ?? {};
    const planned = new Set((result.proposedMutations ?? []).map((plan) => plan.id));
    return { title: 'Order, transfer & verifikasi sebelum bayar', items: keptDropped(before.payable, recordsIn(ctx, 'payable'), result, 'sudah terverifikasi, tanpa order tertunda').map((item, index): ReasoningItem => {
      const planId = planByTrx[before.payable[index]!.no_transaksi];
      return item.ok && planId && planned.has(planId) ? { ...item, ok: false, detail: 'belum diverifikasi → simpan verifikasi', planId } : item;
    }) };
  },
  submitPayment: ({ result }) => ({
    title: 'Tampung bayar per transaksi',
    items: (result.proposedMutations ?? []).map((plan): ReasoningItem => ({
      label: `Tampung bayar ${String(plan.idempotencyKey ?? plan.id).split(':').pop()}`,
      ok: false,
      detail: typeof (plan.payloadSummary as Record<string, unknown> | undefined)?.perubahan === 'string' ? String((plan.payloadSummary as Record<string, unknown>).perubahan) : 'belum dibayar → tampung bayar',
      planId: plan.id,
    })),
  }),
  confirmResult: ({ ctx }) => ({
    title: 'Konfirmasi hasil',
    items: ctx.mode !== 'write'
      ? [{ label: 'Konfirmasi hasil bayar', ok: null, detail: 'preview — tidak ada pembayaran' }]
      : Object.entries(paymentStatusByTrx(ctx)).map(([trx, status]): ReasoningItem => ({
        label: `Tampung bayar ${trx}`,
        ok: status === 'verified' ? true : status === 'failed' || status === 'invalidated' ? false : null,
        detail: PAYMENT_STATUS_TEXT[status] ?? status,
      })),
  }),
  emitPatientSummary: ({ ctx }) => {
    const payable = new Set(recordsIn(ctx, 'payable').map((record) => record.no_transaksi));
    const paid = ctx.mode === 'write' ? paymentStatusByTrx(ctx) : {};
    return { title: 'Ringkasan pasien', items: recordsIn(ctx, 'matching').map((record): ReasoningItem => {
      const status = paid[record.no_transaksi];
      return {
        label: recordLabel(record),
        ok: status === 'verified' ? true : status === 'failed' || status === 'invalidated' ? false : null,
        detail: status ? (PAYMENT_STATUS_TEXT[status] ?? status) : payable.has(record.no_transaksi) ? (ctx.mode === 'write' ? 'tidak ditampung bayar' : 'siap tampung bayar') : 'tidak perlu dibayar',
      };
    }) };
  },
  emitBatchSummary: ({ ctx }) => ({ title: `Ringkasan batch · ${rajalState(ctx).batchTotal ?? 0} pasien · ${ctx.mode === 'write' ? 'write' : 'preview — tidak ada write'}`, items: patientOutcomes(ctx).map((row): ReasoningItem => ({
    label: row.patientId,
    ok: row.status === 'lolos',
    detail: row.status === 'lolos' ? `lolos semua cek${row.clinics.length ? ` · ${row.clinics.join(', ')}` : ''}` : `dilewati${row.step ? ` di ${stepLabel(row.step)}` : ''}: ${row.reason}`,
  })) }),
};

/** Outcome of each staged payment of this run, by transaction (write runs). */
function paymentStatusByTrx(ctx: ExecutorContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of rajalState(ctx).paymentPlanIds ?? []) {
    out[id.split(':').pop() ?? id] = ctx.mutations[id]?.status ?? 'planned';
  }
  return out;
}

function paymentTally(ctx: ExecutorContext): { verified: number; bad: number; open: number } {
  const statuses = Object.values(paymentStatusByTrx(ctx));
  const verified = statuses.filter((s) => s === 'verified').length;
  const bad = statuses.filter((s) => s === 'failed' || s === 'invalidated').length;
  return { verified, bad, open: statuses.length - verified - bad };
}

const PAYMENT_STATUS_TEXT: Record<string, string> = {
  verified: 'sudah ditampung bayar (terverifikasi)',
  applied: 'ditulis, belum terverifikasi — cek di SIMRS',
  failed: 'tampung bayar gagal — cek manual di SIMRS',
  invalidated: 'tidak dibayar — syarat berubah (mis. sudah dibayar dari tempat lain)',
  approved: 'disetujui, belum ditulis',
  planned: 'direncanakan',
};

function withRajalChecklists(registry: ExecutorRegistry): ExecutorRegistry {
  return Object.fromEntries(Object.entries(registry).map(([ref, executor]) => [ref, async (ctx: ExecutorContext) => {
    // The batch summary names the step that dropped each patient (patientOutcomes).
    rajalState(ctx).currentStep = nodeIdOfRef(ref);
    const before = { matching: recordsIn(ctx, 'matching'), treatments: recordsIn(ctx, 'treatments'), payable: recordsIn(ctx, 'payable') };
    const result = await executor(ctx);
    const own = reasoningOf(result.evidence);
    if (own?.items.length) {
      return { ...result, evidence: (result.evidence ?? []).map((item) => (item.label === REASONING_LABEL ? reasoningEvidence({ ...own, items: withSubjects(ctx, own.items) }) : item)) };
    }
    const build = RAJAL_CHECKLISTS[ref.replace(/^rajal\./, '')];
    if (!build || result.status === 'skipped') return result;
    const { title, items } = build({ ctx, result, before });
    return items.length ? { ...result, evidence: [...(result.evidence ?? []), reasoningEvidence({ title, items: withSubjects(ctx, items) })] } : result;
  }]));
}

const tokenIn = (text: string, token: string) => {
  const at = text.indexOf(token);
  return at >= 0 && !/[\w-]/.test(text[at - 1] ?? '') && !/[\w-]/.test(text[at + token.length] ?? '');
};

/**
 * Names the patient each checklist item is about (`subject` = No. RM), once,
 * for every builder: the item names a transaction of a known visit, names a
 * No. RM, or the batch has a single visited patient. Items about the run as a
 * whole (config, poli) stay without one.
 */
function withSubjects(ctx: ExecutorContext, items: readonly ReasoningItem[]): ReasoningItem[] {
  const records = (rajalState(ctx).history ?? []).filter((record) => record.patientId);
  const ids = rajalState(ctx).ids ?? [];
  const patients = new Set(records.map((record) => record.patientId!));
  const sole = patients.size === 1 ? [...patients][0] : undefined;
  return items.map((item) => {
    if (item.subject) return item;
    const subject = records.find((record) => tokenIn(item.label, record.no_transaksi))?.patientId
      ?? ids.find((id) => tokenIn(item.label, id))
      ?? sole;
    return subject ? { ...item, subject } : item;
  });
}

const rupiahText = (n: number): string => `Rp ${Math.round(Number.isFinite(n) ? n : 0).toLocaleString('id-ID')}`;
