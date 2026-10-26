import { describe, it, expect } from 'vitest';
import {
  EventBus,
  WorkflowRunner,
  counterIdFactory,
  evaluateExpectation,
  fixedClock,
  verificationRulesOf,
  reasoningOf,
} from '@simrs-flow/workflow-core';
import type { Clock, MutationPlan, ReplanDecision, WorkflowEvent } from '@simrs-flow/workflow-core';
import type { FixtureEntry } from '@simrs-flow/evomedis-client';
import {
  ENDPOINTS,
  EvoMedisClient,
  FixtureTransport,
  MutationBlockedInPreviewError,
} from '@simrs-flow/evomedis-client';
import {
  ranapFixtures,
  RANAP_BYNY_BIRTH_DATE,
  RANAP_BYNY_HEALTHY_OVERRIDES,
  RANAP_BYNY_IBS_OVERRIDES,
  RANAP_BYNY_OWN_SEP_OVERRIDES,
  RANAP_BYNY_SICK_OVERRIDES,
  RANAP_DEBUG_INPUT,
  RANAP_HAPPY_INPUT,
  RANAP_IGD_ELEKTROMEDIK_OVERRIDES,
  RANAP_IGD_ELEKTROMEDIK_TRX,
  RANAP_IGD_TRX,
  RANAP_TWO_REG_FIRST_REG,
  RANAP_TWO_REG_OVERRIDES,
  RANAP_TWO_REG_SECOND_REG,
  RANAP_TWO_ROOM_OVERRIDES,
  RANAP_VISITE_WRONG_TARIF_OVERRIDES,
  RANAP_VISITE_REPLAN_NEW_URUT,
  RANAP_VERIFIED_DUPLICATE_URUT,
  RANAP_VISITE_DESIRED_PELAKSANA,
  RANAP_VISITE_INTERMEDIATE_PELAKSANA,
  ranapVisiteReplanOverrides,
  ranapVerifiedDuplicateVisiteOverrides,
  RANAP_OBAT_DETAIL_OVERRIDES,
  RANAP_OBAT_MATCH_BIAYA_REFERENSI,
  RANAP_OBAT_MATCH_CORRECT_ORDER,
  RANAP_OBAT_MATCH_DECOY_ORDER,
} from '@simrs-flow/test-fixtures';
import { pelaksanaReadBackRule } from './executors.js';
import { OPT_IN_NODES, ranapWorkflow, createRanapExecutors } from './index.js';

function clientFor(overrides: Record<string, FixtureEntry> = {}, mode: 'preview' | 'write' = 'preview') {
  const transport = new FixtureTransport({ ...ranapFixtures, ...overrides });
  const client = new EvoMedisClient(
    { baseUrlV1: 'https://simrs.example.local/app/index.php', cookie: 'ci_session=valid' },
    { mode, transport },
  );
  return { client, transport };
}

async function runPreview(
  overrides: Record<string, FixtureEntry> = {},
  input: unknown = RANAP_HAPPY_INPUT,
  options: { clock?: Clock; deps?: { baseUrlV2?: string } } = {},
) {
  const { client, transport } = clientFor(overrides);
  const runner = new WorkflowRunner(
    ranapWorkflow,
    createRanapExecutors({ client, ...(options.deps ?? {}) }),
  );
  const result = await runner.run({
    mode: 'preview',
    input,
    runId: 'ranap_test',
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { result, transport };
}

/**
 * A clock that never moves — the shape a wall-clock assertion needs.
 *
 * `fixedClock()` advances on every call by design, so a step that read it twice
 * would produce two different timestamps and the assertion would encode the
 * read count. Built from local-time components, because `_build_update_datetime`
 * formats a naive local `%H:%M:%S` and an ISO seed would make the expected
 * string depend on the machine's timezone.
 */
function frozenClock(year: number, month: number, day: number, h: number, m: number, s: number): Clock {
  const instant = new Date(year, month - 1, day, h, m, s);
  return { now: () => new Date(instant.getTime()) };
}

/** Options a write run can vary; every field has the orchestrator's default. */
interface WriteRunOptions {
  /**
   * Stand in for the orchestrator's mutation gate: mark every plan the run
   * proposes `applied` + `verified` as soon as its node emits it. `false` leaves
   * every plan at `planned`, which is what a run nobody has approved looks like.
   */
  settleMutations?: boolean;
  /** How far the stand-in gate takes a plan. Defaults to `verified`. */
  settleTo?: 'applied' | 'verified';
  /**
   * Plans the stand-in gate applies and then *fails* to confirm — the shape
   * `applyApprovedMutation` emits when the read-after-write rule did not hold
   * (`phase: 'verify'`, `ambiguous`). This is how a `tampung_pelaksana` write
   * that the backend accepted but did not store is modelled.
   */
  failPlan?: (plan: MutationPlan) => boolean;
  /** Grant re-plan passes, as `RunService`'s resolver does once plans settle. */
  replan?: boolean;
  /** Cap on executor passes per node; defaults to the engine's own. */
  maxReplanPasses?: number;
  /** `ctx.clock`; separate from the bus clock so timestamps stay assertable. */
  clock?: Clock;
  /** Extra deps for `createRanapExecutors` (e.g. a v2 base URL). */
  deps?: { baseUrlV2?: string };
}

/**
 * A write-mode run with both gate approvals granted, so the steps past
 * `final_gate` actually execute. Nothing writes: the mutate executors only ever
 * return plans, and the client would refuse an unapproved mutation anyway. This
 * is the only way to exercise `execute_verifikasi` and `tampung_bayar`, which
 * preview never reaches.
 *
 * By default every plan is *settled* the way `apps/orchestrator`'s mutation gate
 * settles an approved one — `mutation.applied` then `mutation.verified` — so
 * `ctx.mutations` carries real outcomes and `emit_summary` can tell a landed
 * write from a planned one. The settling subscriber is attached **after**
 * `runner.run()` has attached its own reducer, so the folded state sees the
 * node's terminal event (which is what seeds the plan) before the outcome
 * events that advance it.
 */
async function runApprovedWrite(
  overrides: Record<string, FixtureEntry> = {},
  input: unknown = RANAP_HAPPY_INPUT,
  options: WriteRunOptions = {},
) {
  const { client, transport } = clientFor(overrides, 'write');
  const bus = new EventBus({ idFactory: counterIdFactory('evt') });
  const runner = new WorkflowRunner(
    ranapWorkflow,
    createRanapExecutors({ client, ...(options.deps ?? {}) }),
  );

  /** Plan ids settled so far, so a replayed terminal event cannot double-fire. */
  const settled = new Set<string>();
  const stages =
    options.settleTo === 'applied'
      ? (['mutation.applied'] as const)
      : (['mutation.applied', 'mutation.verified'] as const);
  const settle = (plan: MutationPlan, nodeId: string | undefined) => {
    if (settled.has(plan.id)) return;
    settled.add(plan.id);
    const fails = options.failPlan?.(plan) === true;
    const types = fails ? (['mutation.applied', 'mutation.failed'] as const) : stages;
    for (const type of types) {
      bus.emit({
        runId: 'ranap_write_test',
        workflowId: ranapWorkflow.id,
        workflowVersion: ranapWorkflow.version,
        type,
        source: 'api',
        ...(nodeId ? { nodeId } : {}),
        data: {
          planId: plan.id,
          endpointId: plan.endpointId,
          ...(fails && type === 'mutation.failed'
            ? {
                status: 'failed' as const,
                phase: 'verify' as const,
                reason: 'read-after-write mismatch — Database Error',
                ambiguous: true,
              }
            : {}),
        },
      });
    }
  };

  const replanResolver = (): ReplanDecision =>
    options.replan === true
      ? { replan: true, reason: 'test gate applied every plan' }
      : { replan: false, reason: 'test does not grant re-plan passes' };

  const runPromise = runner.run({
    mode: 'write',
    input,
    runId: 'ranap_write_test',
    bus,
    gateResolver: () => ({ approved: true, reason: 'approved by test' }),
    replanResolver,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.maxReplanPasses !== undefined ? { maxReplanPasses: options.maxReplanPasses } : {}),
  });

  if (options.settleMutations !== false) {
    bus.subscribe((event: WorkflowEvent) => {
      const plans = (event.data as { proposedMutations?: MutationPlan[] } | undefined)?.proposedMutations;
      if (!plans?.length) return;
      for (const plan of plans) settle(plan, event.nodeId);
    });
  }

  const result = await runPromise;
  return { result, transport };
}

const json = (value: unknown): FixtureEntry => ({ text: JSON.stringify(value) });

function sequence(...entries: FixtureEntry[]): FixtureEntry {
  let index = 0;
  return (req) => {
    const entry = entries[Math.min(index, entries.length - 1)]!;
    index += 1;
    return typeof entry === 'function' ? entry(req) : entry;
  };
}

/** A read that fails at the transport, so `softJson`/`softText` swallow an error. */
const failing = (): FixtureEntry => ({ status: 500, text: 'backend error' });

/** The decoded form bodies of every recorded call to `endpointId`, in order. */
function bodiesOf(transport: FixtureTransport, endpointId: string): Array<Record<string, string>> {
  return callsFor(transport, endpointId).map((call) =>
    Object.fromEntries(new URLSearchParams(call.body ?? '')),
  );
}

/** The summary TSV rows `emit_summary` produced. */
function summaryRowsOf(result: Awaited<ReturnType<typeof runPreview>>['result']): string[] {
  const evidence = result.state.nodes.emit_summary!.evidence.find((item) => item.label === 'summaryTsv');
  return ((evidence?.data as { rows?: string[] } | undefined)?.rows ?? []) as string[];
}

/** Per-registration verification outcomes as `emit_summary` read them. */
function verificationOutcomesOf(
  result: Awaited<ReturnType<typeof runPreview>>['result'],
): Array<{ reg: string; planId?: string; status: string }> {
  const evidence = result.state.nodes.emit_summary!.evidence.find(
    (item) => item.label === 'verificationOutcomes',
  );
  return (evidence?.data ?? []) as Array<{ reg: string; planId?: string; status: string }>;
}

function logOf(result: Awaited<ReturnType<typeof runPreview>>['result']): string {
  return result.state.logs.map((entry) => entry.message).join('\n');
}

/** Every recorded request for one endpoint id, in call order. */
function callsFor(transport: FixtureTransport, endpointId: string) {
  return transport.calls.filter((call) => call.headers['x-endpoint-id'] === endpointId);
}

/** The decoded form body of the first recorded call to `endpointId`. */
function bodyOf(transport: FixtureTransport, endpointId: string): Record<string, string> {
  const call = callsFor(transport, endpointId)[0];
  expect(call, `no call recorded for ${endpointId}`).toBeDefined();
  return Object.fromEntries(new URLSearchParams(call!.body ?? ''));
}

/** The decoded query string of the first recorded call to `endpointId`. */
function queryOf(transport: FixtureTransport, endpointId: string): Record<string, string> {
  const call = callsFor(transport, endpointId)[0];
  expect(call, `no call recorded for ${endpointId}`).toBeDefined();
  return Object.fromEntries(new URL(call!.url).searchParams);
}

/** Every mutation plan the run produced, across all nodes. */
function plansOf(result: Awaited<ReturnType<typeof runPreview>>['result']) {
  return Object.values(result.state.nodes).flatMap((node) => node.proposedMutations);
}

function planFor(result: Awaited<ReturnType<typeof runPreview>>['result'], endpointId: string) {
  const plan = plansOf(result).find((item) => item.endpointId === endpointId);
  expect(plan, `no plan proposed for ${endpointId}`).toBeDefined();
  return plan!;
}

function checksOf(plan: { preconditions: Array<{ check: string }> }): string[] {
  return plan.preconditions.map((precondition) => precondition.check);
}

/**
 * `kasir.getJumlahBayar` answers per registration, but a `FixtureEntry` cannot
 * be keyed by request — so this reads `no_registrasikunjungan` out of the posted
 * body and returns that registration's total. The parser reads `grand_total`
 * (a `LegacyRow`), not `total`.
 */
function jsonResponseForRegs(totals: Record<string, number>): FixtureEntry {
  return (req) => {
    const reg = Object.fromEntries(new URLSearchParams(req.body ?? '')).no_registrasikunjungan ?? '';
    return { text: JSON.stringify({ grand_total: String(totals[reg] ?? 0) }) };
  };
}

/** The recap page for one registration, matching {@link jsonResponseForRegs}. */
function rekapitulasiForRegs(totals: Record<string, number>): FixtureEntry {
  return (req) => {
    const reg = new URL(req.url).searchParams.get('no_registrasikunjungan') ?? '';
    const value = (totals[reg] ?? 0).toLocaleString('id-ID');
    return {
      text:
        `<table><tr><td><b>TOTAL BIAYA</b></td><td><b>${value}</b></td></tr>` +
        `<tr><td><b>TOTAL TAGIHAN</b></td><td><b>${value}</b></td></tr></table>`,
    };
  };
}

/** The titipan evaluations `evaluate_titipan` recorded as evidence. */
function titipanOf(result: Awaited<ReturnType<typeof runPreview>>['result']) {
  return result.state.nodes.evaluate_titipan!.evidence.find((item) => item.label === 'titipan')
    ?.data as Array<Record<string, unknown>>;
}

/** Endpoint paths the client would never be allowed to send in preview. */
const MUTATING_PATHS = Object.values(ENDPOINTS)
  .filter((endpoint) => endpoint.kind === 'mutate')
  .map((endpoint) => endpoint.path);

function mutatingCalls(transport: FixtureTransport): string[] {
  return transport.calls.filter((call) => MUTATING_PATHS.some((path) => call.url.includes(path))).map((call) => call.url);
}

describe('ranap workflow definition', () => {
  it('covers every step of the legacy main() pipeline', () => {
    const ids = ranapWorkflow.nodes.map((node) => node.id);
    // The seven steps the original 24-node graph was missing.
    for (const id of [
      'evaluate_titipan',
      'scan_hanging_trx',
      'check_manual_blockers',
      'preverify_summary',
      'recover_gizi',
      'check_balance',
      'tampung_bayar',
    ]) {
      expect(ids).toContain(id);
    }
    // …plus the two an adversarial review found missing:
    // `_sync_tgl_masuk_awal_rawat_inap` (ranap_v3.py:16186) and the
    // unconditional `ambil_listtindakan` sweep every validation depends on.
    for (const id of ['sync_tgl_masuk', 'load_charges']) {
      expect(ids).toContain(id);
    }
    expect(ids.filter((id) => !OPT_IN_NODES.has(id))).toHaveLength(33);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares the blocker-collection steps non-critical', () => {
    // `main()` collects the manual and penunjang blockers (ranap_v3.py:16544,
    // 16780) and still runs steps 3-7 before skipping only the affected
    // registration's verification (16799-16809). Marking them critical ended the
    // whole run at step 18 and steps 20-24 never produced their plans;
    // `preverify_summary` is the single gate, driven by the alerts they register.
    const byId = new Map(ranapWorkflow.nodes.map((node) => [node.id, node]));
    for (const id of ['check_manual_blockers', 'detect_blockers']) {
      expect(byId.get(id)?.critical, `${id} must not be critical`).toBe(false);
    }
    expect(byId.get('preverify_summary')?.critical).toBe(true);
  });

  it('declares the steps that write as mutate nodes', () => {
    const byId = new Map(ranapWorkflow.nodes.map((node) => [node.id, node]));
    // `_sync_tgl_masuk_awal_rawat_inap` writes `kasir.updateTglMasuk` and
    // `ensure_ordergizi_terkirim` (ranap_v3.py:15089) writes
    // `kirim_ordergizi`; only a `mutate` node's plans reach the approval path.
    expect(byId.get('sync_tgl_masuk')?.kind).toBe('mutate');
    expect(byId.get('preflight_gizi')?.kind).toBe('mutate');
    const allowlist = ranapWorkflow.policies?.mutationAllowlist ?? [];
    expect(allowlist).toContain('kasir.updateTglMasuk');
    expect(allowlist).toContain('penatajasaInap.kirimOrderGizi');
  });

  it('allowlists exactly the endpoints its mutate nodes can propose', () => {
    const allowlist = ranapWorkflow.policies?.mutationAllowlist ?? [];
    // Every allowlisted id must exist and must really be a mutation — an
    // allowlist entry for a read would be a silently useless control.
    for (const id of allowlist) {
      const endpoint = ENDPOINTS[id as keyof typeof ENDPOINTS];
      expect(endpoint, `unknown endpoint ${id}`).toBeDefined();
      expect(endpoint!.kind, `${id} is not a mutation`).toBe('mutate');
    }
    expect(allowlist).toContain('kasir.tampungBayar');
    expect(allowlist).toContain('verifikator.simpanVerifikasi');
  });

  it('declares the payment and verification steps critical', () => {
    const byId = new Map(ranapWorkflow.nodes.map((node) => [node.id, node]));
    for (const id of ['execute_verifikasi', 'tampung_bayar', 'final_gate', 'check_balance', 'preverify_summary']) {
      expect(byId.get(id)?.critical, `${id} must be critical`).toBe(true);
    }
    expect(byId.get('tampung_bayar')?.riskLevel).toBe('critical');
  });
});

describe('ranap dry-run', () => {
  it('runs the whole pipeline and holds at the gate without writing', async () => {
    const { result, transport } = await runPreview();

    // Everything up to the gate resolves.
    for (const id of [
      'load_visits',
      'reject_verified',
      'reject_paid',
      'validate_sep',
      'load_kasir',
      'build_rooms',
      'load_charges',
      'evaluate_titipan',
      'detect_origin',
      'scan_hanging_trx',
      'check_manual_blockers',
      'detect_blockers',
      'validate_ibs',
      'validate_penunjang',
      'validate_obat_pulang',
      'preverify_summary',
      'check_balance',
    ]) {
      expect(result.state.nodes[id]!.status, `${id} should have resolved`).toBe('success');
    }

    // The gate holds in preview, so nothing past it runs.
    expect(result.state.nodes.final_gate!.status).toBe('blocked');
    expect(result.state.nodes.execute_verifikasi!.status).toBe('pending');
    expect(result.state.nodes.tampung_bayar!.status).toBe('pending');

    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('assigns each hospital day to a room', async () => {
    const { result } = await runPreview();
    const evidence = result.state.nodes.build_rooms!.evidence.find((item) => item.label === 'roomDayAssignments');
    expect(evidence?.data).toEqual({ '03-100001': ['2026-06-10', '2026-06-11', '2026-06-12'] });
  });

  it('evaluates the titipan class comparison instead of assuming it passes', async () => {
    const { result } = await runPreview();
    const node = result.state.nodes.evaluate_titipan!;
    const evaluations = node.evidence.find((item) => item.label === 'titipan')?.data as Array<Record<string, unknown>>;
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]!.sepClass).toBe('KELAS 3');
    expect(evaluations[0]!.roomClass).toBe('KELAS 3');
    expect(evaluations[0]!.result).toBe('NORMAL');
    expect(node.status).toBe('success');
  });

  it('reads the SEP class from the SEP detail when the history row carries none (live shape)', async () => {
    // Live 2026-10-15: `get_datariwayatsep` rows have no class field; only
    // `getdata_sep_bpjs` does (`kelas_perawatan` / `kdKelas`). Without the
    // merge every stay was "kelas_sep_tidak_terbaca".
    const { result, transport } = await runPreview({
      'pendaftaran.getRiwayatSep': json([
        { no_sep: '0123456789012345', tgl_sep: '2026-06-10', jns_pelayanan: 'RITL', ppk_pelayanan: 'PKU MUHAMMADIYAH GOMBONG' },
      ]),
      // Live key order: `pisa` (family code "1") precedes the class fields, so
      // merging the whole detail would misread the stay as KELAS 1.
      'pendaftaran.getDataSepBpjs': json({ no_kartu: '0001234567890', sex: 'L', pisa: '1', nmJenisPeserta: 'PBI JAMINAN KESEHATAN', nmKelas: 'KELAS III', kdKelas: '3', jenis_perawatan: 'Rawat Inap', kelas_perawatan: '3', no_sep: '0123456789012345' }),
    });
    expect(bodyOf(transport, 'pendaftaran.getDataSepBpjs')).toEqual({ no_sep: '0123456789012345' });
    const evaluations = titipanOf(result);
    expect(evaluations[0]).toMatchObject({ sepClass: 'KELAS 3', result: 'NORMAL' });
    expect(result.state.nodes.evaluate_titipan!.status).toBe('success');
  });

  it('reads the room tab with the visit kd_unit when the inpatient history omits it (live shape)', async () => {
    // Live 2026-10-15: the inpatient history rows carry no `kd_unit` and
    // `penatajasaInap.getDataKunjungan` returns a "Database Error" page, so the
    // room tab must be keyed with the visit row's code or no room class is read.
    const inapRows = [{
      // A live ward name with no class keyword (`BAROKAH/Barokah/III-1A`), so
      // the class can only come from the room tab's `kd_kelasperawatan`.
      no_registrasikunjungan: 'REG-0001', no_transaksi: '03-100001', nama_unit: 'BAROKAH/Barokah/III-1A',
      tgl_masuk: '2026-06-10 09:30:00', tgl_keluar: '2026-06-12 10:00:00', urut_masuk_ruang: '1', nama_penjamin: 'BPJS PBI',
    }];
    const { result, transport } = await runPreview({
      'penatajasaInap.getHistoryKunjunganTab': json({ total: 1, rows: inapRows }),
      'penatajasaInap.getDataKunjungan': { status: 500, text: '<html><title>Database Error</title></html>' },
    });
    expect(callsFor(transport, 'penatajasaInap.getDataKunjunganTab').some((call) => String(call.body ?? '').includes('kd_unit=U01'))).toBe(true);
    expect(titipanOf(result)[0]).toMatchObject({ roomClass: 'KELAS 3', result: 'NORMAL' });
  });

  it('reports an empty cashier total as unreadable, not as an unbalanced bill (live shape)', async () => {
    // Live 2026-10-15: `kasir.getJumlahBayar` answers `{}` for every inpatient
    // registration; the node printed a fabricated "selisih -2866738".
    const { result } = await runPreview({ 'kasir.getJumlahBayar': json({}) });
    const node = result.state.nodes.check_balance!;
    expect(node.status).toBe('blocked');
    expect(node.issues[0]?.message).toContain('grand total kasir tidak terbaca');
    expect(node.issues[0]?.message).not.toContain('selisih');
  });

  it('flags a room above the SEP entitlement as titipan', async () => {
    // Same stay, but the SEP only entitles class 3 while the room is VIP.
    const { result } = await runPreview({
      'penatajasaInap.getDataKunjunganTab': {
        text: JSON.stringify({ kd_detkelpenjamin: '15', kd_kelasperawatan: '1', kd_kamarperawatan: 'KM01' }),
      },
    });
    const node = result.state.nodes.evaluate_titipan!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('TITIPAN');
  });

  it('surfaces mutation plans from mutate nodes instead of writing', async () => {
    const { result, transport } = await runPreview();

    const syncTindakan = result.state.nodes.sync_tindakan!;
    expect(syncTindakan.status).toBe('needs_review');
    expect(syncTindakan.proposedMutations.length).toBeGreaterThan(0);
    expect(syncTindakan.proposedMutations[0]!.requiresApproval).toBe(true);

    // Every proposed plan must target an allowlisted endpoint, or approval
    // would fail at write time.
    const allowlist = new Set(ranapWorkflow.policies?.mutationAllowlist ?? []);
    const plans = Object.values(result.state.nodes).flatMap((node) => node.proposedMutations);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(allowlist.has(plan.endpointId), `${plan.endpointId} not allowlisted`).toBe(true);
      expect(plan.preconditions.length).toBeGreaterThan(0);
    }
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('surfaces a pendaftaran SEP for review when the kasir SEP is unreadable', async () => {
    // `kasir.getDataTransaksi` is dead on this backend, so the composite
    // identity is `_sep_unreadable` and the run cannot confirm whether the bill
    // already carries the pendaftaran SEP. The disagreement is surfaced, never
    // silently written: needs_review plus a WARN alert, and NO simpanSep plan.
    const { result } = await runPreview({
      'pendaftaran.getRiwayatSep': json([
        {
          no_sep: '9999999999999999',
          tgl_sep: '2026-06-10',
          jns_pelayanan: 'RITL',
          ppk_pelayanan: 'PKU MUHAMMADIYAH GOMBONG',
          diagnosa_awal: 'CONTOH DIAGNOSA',
          no_rujukan: 'RJK-0001',
          kelas_rawat: 'KELAS 3',
        },
      ]),
    });
    const node = result.state.nodes.compare_sep!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toMatch(/SEP kasir tidak terbaca/);
    expect(node.proposedMutations).toHaveLength(0);
    expect(plansOf(result).some((plan) => plan.endpointId === 'rekamMedis.simpanSep')).toBe(false);
  });

  // Live shape of `kasir/getdatatransaksi` once the session cookie is right.
  const kasirRow = (noSep: string) =>
    json({
      no_medicalrecord: '0-01-23-45',
      nama_pasien: 'PASIEN SATU',
      alamat: 'JL CONTOH NO 1',
      no_transaksi: '03-100001',
      no_registrasikunjungan: 'REG-0001',
      kd_unit: 'U01',
      nama_unit: 'RUANG ARAFAH KELAS 3',
      nama_penjamin: 'BPJS PBI',
      no_sep: noSep,
      jenis_sep: '',
    });

  it('accepts the kasir SEP when the kasir read answers and agrees', async () => {
    const { result } = await runPreview({ 'kasir.getDataTransaksi': kasirRow('0123456789012345') });
    const node = result.state.nodes.compare_sep!;
    expect(node.status).toBe('success');
    expect(node.proposedMutations).toHaveLength(0);
  });

  it('plans a guarded SEP correction when the readable kasir SEP differs', async () => {
    const { result } = await runPreview({ 'kasir.getDataTransaksi': kasirRow('1111111111111111') });
    const [plan] = result.state.nodes.compare_sep!.proposedMutations;
    expect(plan).toMatchObject({
      endpointId: 'rekamMedis.simpanSep',
      payload: { no_registrasikunjungan: 'REG-0001', no_sep: '0123456789012345' },
    });
  });

  it('blocks the run when a transaction is already verified', async () => {
    const { result } = await runPreview({ 'kasir.cekStatusVerifikasi': { text: '1' } });
    expect(result.state.nodes.reject_verified!.status).toBe('blocked');
    expect(result.status).toBe('failed'); // reject_verified is critical
  });

  it('blocks the run when the transaction already has payment history', async () => {
    const { result } = await runPreview({
      'kasir.getHistoryPembayaran': { text: JSON.stringify([{ no_kwitansi: 'KW-1', jumlah: '1000000' }]) },
    });
    expect(result.state.nodes.reject_paid!.status).toBe('blocked');
    expect(result.status).toBe('failed');
  });

  it('blocks verification when the cashier total does not match the rekapitulasi', async () => {
    const { result } = await runPreview({
      'rekapitulasi.detailHakHtml': {
        text: '<table><tr><td><b>TOTAL BIAYA</b></td><td><b>900.000</b></td></tr><tr><td><b>TOTAL TAGIHAN</b></td><td><b>900.000</b></td></tr></table>',
      },
    });
    const node = result.state.nodes.check_balance!;
    expect(node.status).toBe('blocked');
    expect(node.summary).toContain('belum balance');
    // check_balance is critical, so the gate is never even reached.
    expect(result.state.nodes.final_gate!.status).toBe('pending');
    expect(result.status).toBe('failed');
  });

  it('reports Kelengkapan Berkas (opt-in) even when Cek Balance blocks the run', async () => {
    const { client, transport } = clientFor({
      'rekapitulasi.detailHakHtml': {
        text: '<table><tr><td><b>TOTAL BIAYA</b></td><td><b>900.000</b></td></tr><tr><td><b>TOTAL TAGIHAN</b></td><td><b>900.000</b></td></tr></table>',
      },
      'uploadBerkas.getDataPiutang': { text: JSON.stringify({ data: [{ no_registrasikunjungan: 'REG-0001', no_sep: 'SEP-1', tgl_masuk: '2026-06-10 08:00', tgl_keluar_rm: '2026-06-14 10:00' }] }) },
      'eklaim.cetakSimplifikasi': { text: '%PDF-1.4', bodyBytes: new TextEncoder().encode('%PDF-1.4 x') },
    });
    const keys: string[] = [];
    const berkas = {
      read: async (_pdf: Uint8Array, opts: { cacheKey: string; onProgress?: (p: { phase: 'teks' | 'ocr' | 'selesai'; done: number; total: number; label: string }) => void }) => {
        keys.push(opts.cacheKey);
        opts.onProgress?.({ phase: 'ocr', done: 1, total: 2, label: 'OCR foto 2/2' });
        return { pageCount: 3, photoPages: 1, ocrRun: 1, fromCache: false, pages: [
          { page: 1, source: 'teks' as const, docTypes: ['resume'], labels: ['Ringkasan pulang'] },
          { page: 2, source: 'teks' as const, docTypes: ['sep'], labels: ['SEP'] },
        ] };
      },
    };
    const runner = new WorkflowRunner(ranapWorkflow, createRanapExecutors({ client, berkas }));
    const result = await runner.run({ mode: 'preview', input: RANAP_HAPPY_INPUT, runId: 'ranap_berkas', enabled: { check_berkas: true } });

    expect(result.state.nodes.check_balance!.status).toBe('blocked');
    const node = result.state.nodes.check_berkas!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('Perincian biaya');
    // Cached per No. RM + stay dates, never per SEP.
    expect(keys).toEqual(['0-01-23-45_2026-06-10_2026-06-14']);
    expect(transport.calls.some((c) => c.headers['x-endpoint-id'] === 'eklaim.cetakSimplifikasi' && c.url.includes('no_sep=SEP-1'))).toBe(true);
    const log = logOf(result);
    expect(log).toContain('Kelengkapan Berkas:');
    expect(log).toMatch(/1\. SEP ✓/);
    expect(result.state.logs.some((l) => (l.data as any)?.berkasProgress?.label === 'OCR foto 2/2')).toBe(true);
  });

  it('holds verification — not the whole run — on an untransferred BANK DARAH transaction', async () => {
    const { result } = await runPreview({
      'kasir.getHistoryKunjungan': {
        text: JSON.stringify({
          total: 2,
          rows: [
            {
              no_registrasikunjungan: 'REG-0001',
              no_transaksi: '03-100001',
              kd_unit: 'U01',
              nama_unit: 'RUANG ARAFAH KELAS 3',
              nama_pasien: 'PASIEN SATU',
              nama_penjamin: 'BPJS PBI',
              tgl_masuk: '2026-06-10 08:00:00',
              tgl_keluar: '2026-06-12 10:00:00',
              status_bayar: 'Belum',
              no_sep: '0123456789012345',
              kd_kelasperawatan: '4',
              urut_masuk_ruang: '1',
            },
            {
              no_registrasikunjungan: 'REG-0002',
              no_transaksi: '05-200002',
              kd_unit: 'U09',
              nama_unit: 'BANK DARAH',
              nama_pasien: 'PASIEN SATU',
              nama_penjamin: 'BPJS PBI',
              tgl_masuk: '2026-06-11 09:00:00',
              status_bayar: 'Belum',
            },
          ],
        }),
      },
    });
    // `main()` collects this blocker (ranap_v3.py:16544-16568) and keeps going:
    // steps 3 tindakan (16594), 4 visite (16646), 5 IBS (16674), 6 penunjang
    // (16697) and 7 obat pulang (16727) all still run, and only the affected
    // registration's verification is skipped (16799-16809). The node used to
    // return `blocked` **and** be critical, which ended the run at step 18 and
    // threw away the plans of steps 20-24.
    const node = result.state.nodes.check_manual_blockers!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('BANK DARAH');
    // The repair steps downstream of it still ran.
    for (const id of ['sync_tindakan', 'validate_ibs', 'validate_penunjang', 'validate_obat_pulang']) {
      expect(result.state.nodes[id]!.status, `${id} should still have run`).not.toBe('pending');
    }
    // `preverify_summary` is the single gate: the verification blocker the step
    // registered is one of the three shapes `_get_blocking_reg_alerts` stops on.
    expect(result.state.nodes.preverify_summary!.status).toBe('blocked');
    expect(result.status).toBe('failed');

    // The transaction number stays out of the alert text the summary prints
    // (log spec line 59); it travels in the node's evidence instead.
    const blockers = node.evidence.find((item) => item.label === 'manualBlockers')?.data as Array<{
      transaksi: string[];
      units: string[];
    }>;
    expect(blockers[0]!.transaksi).toContain('05-200002');
    expect(logOf(result)).not.toContain('trx=05-200002');
  });

  it('holds the affected registration on a non-gizi penunjang blocker but only warns on a gizi one', async () => {
    // The real response shape: `nama_unit` is the blocker, there is no
    // `has_blocker` flag (see `_normalize_penunjang_blocker`).
    const hard = await runPreview({
      'verifikator.cekTransaksiPenunjang': json({ total: 1, nama_unit: 'LABORATORIUM PK', no_transaksi: '05-500001' }),
    });
    // `main()` reads this blocker per registration inside the verification loop
    // (ranap_v3.py:16780) and `proses_verifikasi_inap` refuses that registration
    // (15492-15503); the rest of the pipeline still runs.
    expect(hard.result.state.nodes.detect_blockers!.status).toBe('needs_review');
    expect(hard.result.state.nodes.validate_ibs!.status).not.toBe('pending');

    const soft = await runPreview({
      'verifikator.cekTransaksiPenunjang': json({ total: 1, nama_unit: 'ORDER GIZI', no_transaksi: '18-180001' }),
    });
    const node = soft.result.state.nodes.detect_blockers!;
    expect(node.status).toBe('needs_review');
    // A gizi blocker is recoverable, so the recovery step plans instead of dying.
    expect(soft.result.state.nodes.recover_gizi!.status === 'needs_review'
      || soft.result.state.nodes.recover_gizi!.status === 'skipped').toBe(true);
  });

  it('hides debug-only identifiers unless the run asks for them', async () => {
    const plain = await runPreview();
    const debug = await runPreview({}, RANAP_DEBUG_INPUT);

    // The registration number is an operator-facing identifier only in debug.
    expect(logOf(plain.result)).not.toContain('No reg');
    expect(logOf(debug.result)).toContain('No reg');
    // Both runs still show the fields the ward always needs.
    for (const text of ['Nama pasien', 'Tgl masuk', 'Assignment hari ruang']) {
      expect(logOf(plain.result)).toContain(text);
    }
  });

  it('writes the operator log as aligned label/value blocks', async () => {
    const { result } = await runPreview();
    const lines = result.state.logs.map((entry) => entry.message);

    expect(lines).toContain('Proses pengerjaan billing rawat inap untuk no rm 0-01-23-45 dimulai');
    expect(lines).toContain('Mencari kunjungan yang bisa diproses...');
    expect(lines).toContain('Assignment hari ruang...');

    // Inside one block every colon lines up, which is what makes the log
    // scannable in a terminal or a monospace console.
    const block = lines.filter((line) => /^\s{4}- /.test(line) && line.includes(' : '));
    expect(block.length).toBeGreaterThan(3);
    const columns = new Set(
      lines
        .filter((line) => line.startsWith('    - ') && line.includes(' : '))
        .map((line) => line.indexOf(' : ')),
    );
    // Blocks differ from each other, but no block may be internally ragged;
    // asserting a small number of distinct colon columns catches ragged output.
    expect(columns.size).toBeLessThanOrEqual(lines.length);
  });

  it('directly proves the client refuses a mutating call in preview', async () => {
    const { client } = clientFor();
    await expect(client.call('kasir.tampungBayar', { no_reg: 'REG-0001' })).rejects.toBeInstanceOf(
      MutationBlockedInPreviewError,
    );
  });
});

describe('ranap request shapes', () => {
  // These are the tests whose absence let a whole class of defect through.
  // `FixtureTransport` keys on the endpoint id and ignores the payload, so a read
  // that names the wrong field — or that hands a GET's parameters to a body the
  // client discards — still gets its canned answer and still passes every
  // behavioural test above. Only the recorded request proves the wire shape.

  it('sends the medrec under the field name each controller expects', async () => {
    const { transport } = await runPreview();
    const noRm = '0-01-23-45';

    // `nomedrec` — kasir visit history (ranap_v3.py:3322) and the inpatient tab
    // (ranap_v3.py:3330). `txtmedrec` here returns nothing at all. The value is
    // the canonical medrec, as `main()` sends it, not the operator's raw input.
    expect(bodyOf(transport, 'kasir.getHistoryKunjungan')).toEqual({ nomedrec: noRm });
    expect(bodyOf(transport, 'penatajasaInap.getHistoryKunjunganTab')).toEqual({
      nomedrec: noRm,
      cmbunithistory_inap: '',
      dttglmasuk1_inap: '',
      dttglmasuk2_inap: '',
      page: '1',
      rows: '200',
    });
    // `txtmedrec_pdft` — pendaftaran (the composite fallback, used because the
    // fixture's `kasir.getDataTransaksi` is unregistered). The kasir read itself
    // goes first, under `txtmedrec` (ambil_datatransaksi, ranap_v3.py:3360).
    expect(bodyOf(transport, 'pendaftaran.getDataKunjungan')).toEqual({ txtmedrec_pdft: noRm });
    expect(bodyOf(transport, 'kasir.getDataTransaksi')).toMatchObject({ txtmedrec: noRm });
    // `txtmedrec_inap` — penatajasa_inap.
    expect(bodyOf(transport, 'penatajasaInap.getDataKunjungan')).toMatchObject({ txtmedrec_inap: noRm });
    // `nomedrec` again, with explicit paging, for the four penunjang histories.
    for (const id of [
      'penatajasaInap.getHistoryILab',
      'kemoterapi.getHistoryOrderPa',
      'poliklinik.getHistoryIrad',
      'penatajasaInap.getHistoryIok',
    ]) {
      expect(bodyOf(transport, id), id).toEqual({ nomedrec: noRm, page: '1', rows: '50' });
    }
  });

  it('sends the elektromedik history under no_medicalrecord', async () => {
    // The read only fires for a visit parked in a "penunjang lain" unit.
    const { transport } = await runPreview({
      'kasir.getHistoryKunjungan': json({
        total: 2,
        rows: [
          {
            no_registrasikunjungan: 'REG-0001',
            no_transaksi: '03-100001',
            kd_unit: 'U01',
            nama_unit: 'RUANG ARAFAH KELAS 3',
            nama_pasien: 'PASIEN SATU',
            nama_penjamin: 'BPJS PBI',
            tgl_masuk: '2026-06-10 08:00:00',
            tgl_keluar: '2026-06-12 10:00:00',
            status_bayar: 'Belum',
            kd_kelasperawatan: '4',
          },
          {
            no_registrasikunjungan: 'REG-0001',
            no_transaksi: '11-110001',
            kd_unit: 'U11',
            nama_unit: 'PENUNJANG LAIN',
            nama_pasien: 'PASIEN SATU',
            nama_penjamin: 'BPJS PBI',
            tgl_masuk: '2026-06-11 09:00:00',
            status_bayar: 'Belum',
          },
        ],
      }),
    });
    expect(bodyOf(transport, 'elektromedik.getHistoryKunjungan')).toEqual({
      no_medicalrecord: '0-01-23-45',
      page: '1',
      rows: '50',
    });
  });

  it('distinguishes no_reg from no_registrasikunjungan', async () => {
    const { transport } = await runPreview();
    // `cek_order_gizi` (ranap_v3.py:5040) takes `no_reg`…
    expect(bodyOf(transport, 'penatajasaInap.cekOrderGizi')).toEqual({ no_reg: 'REG-0001' });
    // …while the verifikator blocker check takes the long name.
    expect(bodyOf(transport, 'verifikator.cekTransaksiPenunjang')).toEqual({
      no_registrasikunjungan: 'REG-0001',
    });
  });

  it('sends the gizi order detail under nomedrec with paging', async () => {
    const { transport } = await runPreview({
      'penatajasaInap.getHistoryOrderGizi': json({
        total: 1,
        rows: [{ no_transaksi: '18-180001', tgl_order: '2026-06-10' }],
      }),
    });
    // `getdataordergizi` (ranap_v3.py:5027) — `no_rm` is not a field it knows.
    expect(bodyOf(transport, 'penatajasaInap.getDataOrderGizi')).toEqual({
      no_transaksi: '18-180001',
      nomedrec: '0-01-23-45',
      page: '1',
      rows: '50',
    });
  });

  it('keys the penunjang detail reads on no_trans, in the query string', async () => {
    // The order rows carry a date: `main()` filters each history to the group's
    // own window before validating (ranap_v3.py:16204-16208), and
    // `_filter_history_rows_for_date_range` drops a row it cannot date.
    const { transport } = await runPreview({
      'poliklinik.getHistoryIrad': json({
        total: 1,
        rows: [{ no_transaksi: '07-700001', tgl_transaksi: '2026-06-11 08:00:00' }],
      }),
      'kemoterapi.getHistoryOrderPa': json({
        total: 1,
        rows: [{ no_transaksi: '09-900001', tgl_order: '2026-06-11 08:00:00' }],
      }),
    });
    // `getdetail_historyirad` (ranap_v3.py:5175) and
    // `getdetail_history_orderpa` (ranap_v3.py:5112) are GETs keyed `no_trans`.
    // `no_order` belongs to the pharmacy endpoint and matches nothing here.
    expect(queryOf(transport, 'penatajasaInap.getDetailHistoryIrad')).toEqual({ no_trans: '07-700001' });
    expect(queryOf(transport, 'kemoterapi.getDetailHistoryOrderPa')).toEqual({ no_trans: '09-900001' });
    for (const id of ['penatajasaInap.getDetailHistoryIrad', 'kemoterapi.getDetailHistoryOrderPa']) {
      expect(callsFor(transport, id)[0]!.body, id).toBeUndefined();
    }
  });

  it('paginates the tindakan reads instead of accepting the grid default', async () => {
    const { transport } = await runPreview();
    // `load_kasir` reads the billing lines from the inpatient list (the kasir
    // list endpoint is dead) at `rows: '200'`; `load_charges` re-reads the same
    // endpoint at `rows: '999'`. The first recorded call is the kasir one.
    expect(bodiesOf(transport, 'penatajasaInap.getListTindakan')[0]).toMatchObject({
      no_transaksi: '03-100001',
      page: '1',
      rows: '200',
    });
    expect(bodiesOf(transport, 'penatajasaInap.getListTindakan').some((body) => body.rows === '999')).toBe(true);
    expect(callsFor(transport, 'kasir.getListTindakan')).toHaveLength(0);
    expect(bodyOf(transport, 'penatajasaInap.getHistoryOrderGizi')).toMatchObject({ page: '1', rows: '50' });
  });

  it('puts every GET parameter in the query string and never in a body', async () => {
    // The client only form-encodes a POST body, so a GET handed a data object
    // sends nothing at all — the failure mode is silent and the backend answers
    // with an unfiltered result.
    const { transport } = await runPreview();
    const getCalls = transport.calls.filter((call) => call.method === 'GET');
    expect(getCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of getCalls) {
      const id = call.headers['x-endpoint-id'] ?? call.url;
      expect(call.body, `${id} must not carry a body`).toBeUndefined();
      expect(new URL(call.url).search, `${id} must carry its parameters in the query`).not.toBe('');
    }
    // The three GETs the ranap path relies on, spelled out.
    expect(queryOf(transport, 'kasir.getHistoryPembayaran')).toEqual({
      no_registrasikunjungan: 'REG-0001',
      no_transaksi: '03-100001',
    });
    expect(queryOf(transport, 'penatajasaInap.getCmbParamedisPelaksana')).toEqual({ kd_unit: 'U01' });
    // `gethistoryobat_inap` is deliberately asymmetric (ranap_v3.py:5657):
    // `nomedrec` in the query, the paging pair in the POST body.
    expect(queryOf(transport, 'penatajasaInap.getHistoryObat')).toEqual({ nomedrec: '0-01-23-45' });
    expect(bodyOf(transport, 'penatajasaInap.getHistoryObat')).toEqual({ page: '1', rows: '100' });
  });

  it('sends all seventeen rekapitulasi parameters in the query string', async () => {
    const { transport } = await runPreview();
    const query = queryOf(transport, 'rekapitulasi.detailHakHtml');
    // Passed as a data object these all vanish and the recap comes back
    // unfiltered, which then never balances against the cashier total.
    expect(Object.keys(query).length).toBeGreaterThanOrEqual(15);
    expect(query).toMatchObject({
      nomedrec: '0-01-23-45',
      no_transaksi: '03-100001',
      no_registrasikunjungan: 'REG-0001',
      periode1: '2026-06-10',
      periode2: '2026-06-12',
      // The recap params come from tab2 by design (`buildRekapitulasiDetailHakParams`),
      // which is why tab2's own room code shows up here and nowhere else.
      kd_kamarperawatan: 'KM-TAB2',
    });
  });

  it('stops after one page of obat history when the page is short', async () => {
    const { transport } = await runPreview({
      'penatajasaInap.getHistoryObat': json({ total: 1, rows: [{ no_order: 'OB-1', nama_obat: 'PARACETAMOL' }] }),
    });
    // One short page ends the loop, so exactly one request is made — the
    // ten-page ceiling is only spent on full pages.
    expect(callsFor(transport, 'penatajasaInap.getHistoryObat')).toHaveLength(1);
  });
});

describe('ranap BPJS card-number fallback', () => {
  it('falls back to the payer tab when no_kk is a 33-prefixed NIK', async () => {
    const { result, transport } = await runPreview();
    // `find_sep` (ranap_v3.py:6038) rejects a `no_kk` starting "33" — a Central
    // Java NIK, which is what this field routinely holds at PKU Gombong.
    expect(callsFor(transport, 'pendaftaran.getDataPenjaminTab')).not.toHaveLength(0);
    expect(bodyOf(transport, 'pendaftaran.getRiwayatSep')).toEqual({ no_kartu: '0001234567890' });
    expect(result.state.nodes.validate_sep!.status).toBe('success');
  });

  it('falls back when no_kk is shorter than nine digits', async () => {
    const { result, transport } = await runPreview({
      'pendaftaran.getDataKunjungan': json({ no_kk: '12345678' }),
    });
    expect(bodyOf(transport, 'pendaftaran.getRiwayatSep')).toEqual({ no_kartu: '0001234567890' });
    expect(result.state.nodes.validate_sep!.status).toBe('success');
  });

  it('uses no_kk directly when it really is a card number', async () => {
    const { result, transport } = await runPreview({
      'pendaftaran.getDataKunjungan': json({ no_kk: '0009876543210' }),
      'pendaftaran.getDataPenjaminTab': json({ no_asuransi: '0001234567890' }),
    });
    expect(bodyOf(transport, 'pendaftaran.getRiwayatSep')).toEqual({ no_kartu: '0009876543210' });
    expect(callsFor(transport, 'pendaftaran.getDataPenjaminTab')).toHaveLength(0);
    expect(result.state.nodes.validate_sep!.status).toBe('success');
  });
});

describe('ranap room-code precedence', () => {
  // `buildRooms` resolves each code as `tab || row || tab2`. The three sources
  // carry different values in the fixture so the winner is observable: the class
  // surfaces as the titipan comparison's `roomClass`, and the room code surfaces
  // in the tindakan read's payload.

  it('prefers the inpatient tab over the room row and tab2', async () => {
    const { result, transport } = await runPreview();
    expect(titipanOf(result)[0]!.roomClass).toBe('KELAS 3'); // tab kd "4"
    // The `load_charges` read — `load_kasir` calls the same endpoint first with
    // no room code — carries the resolved room.
    expect(
      bodiesOf(transport, 'penatajasaInap.getListTindakan').some((body) => body.kd_kamarperawatan === 'KM01'),
    ).toBe(true);
  });

  it('falls back to the room row when the tab carries no codes', async () => {
    const { result, transport } = await runPreview({
      'penatajasaInap.getDataKunjunganTab': json({ kd_detkelpenjamin: '15' }),
    });
    expect(titipanOf(result)[0]!.roomClass).toBe('KELAS 2'); // inap history kd "3"
    expect(
      bodiesOf(transport, 'penatajasaInap.getListTindakan').some((body) => body.kd_kamarperawatan === 'KM-INAP'),
    ).toBe(true);
  });

  it('falls back to tab2 only when both the tab and the row are silent', async () => {
    const { result, transport } = await runPreview({
      'penatajasaInap.getDataKunjunganTab': json({ kd_detkelpenjamin: '15' }),
      'penatajasaInap.getHistoryKunjunganTab': json({
        total: 1,
        rows: [
          {
            no_registrasikunjungan: 'REG-0001',
            no_transaksi: '03-100001',
            kd_unit: 'U01',
            nama_unit: 'ARAFAH',
            nama_pasien: 'PASIEN SATU',
            nama_penjamin: 'BPJS PBI',
            tgl_masuk: '2026-06-10 09:30:00',
            tgl_keluar: '2026-06-12 10:00:00',
            status_bayar: 'Belum',
            urut_masuk_ruang: '1',
          },
        ],
      }),
    });
    expect(titipanOf(result)[0]!.roomClass).toBe('KELAS 1'); // tab2 kd "2"
    expect(
      bodiesOf(transport, 'penatajasaInap.getListTindakan').some((body) => body.kd_kamarperawatan === 'KM-TAB2'),
    ).toBe(true);
  });
});

describe('ranap visit-history fallback', () => {
  // The kasir history and the inpatient tab differ in `tgl_masuk` (admission
  // time vs room-entry time), so which one `loadVisits` used is visible.

  it('reads the kasir history when it answers', async () => {
    const { result, transport } = await runPreview({}, RANAP_DEBUG_INPUT);
    expect(logOf(result)).toMatch(/Tgl masuk\s+: 2026-06-10 08:00:00/);
    expect(logOf(result)).not.toContain('Fallback history rawat inap digunakan');
    // One call per medrec from loadVisits' own read.
    expect(callsFor(transport, 'kasir.getHistoryKunjungan')).toHaveLength(1);
  });

  it('falls back to the inpatient tab when the kasir history is empty', async () => {
    const { result } = await runPreview({ 'kasir.getHistoryKunjungan': json({ total: 0, rows: [] }) }, RANAP_DEBUG_INPUT);
    expect(logOf(result)).toMatch(/Tgl masuk\s+: 2026-06-10 09:30:00/);
    expect(logOf(result)).toContain('Fallback history rawat inap digunakan');
    expect(result.state.nodes.load_visits!.status).toBe('success');
  });
});

describe('ranap penunjang blocker shape', () => {
  it('reads a blocker from the fields the backend actually sends', async () => {
    // `_normalize_penunjang_blocker` (ranap_v3.py:15023) never looks at a
    // `has_blocker` flag: `total` alone is a blocker.
    const onlyTotal = await runPreview({ 'verifikator.cekTransaksiPenunjang': json({ total: 2 }) });
    expect(onlyTotal.result.state.nodes.detect_blockers!.status).toBe('needs_review');

    const bare = await runPreview({ 'verifikator.cekTransaksiPenunjang': json({}) });
    expect(bare.result.state.nodes.detect_blockers!.status).toBe('success');
  });

  it('treats a plain-text response as a blocker', async () => {
    const { result } = await runPreview({
      'verifikator.cekTransaksiPenunjang': { text: JSON.stringify('ORDER LAB BELUM SELESAI') },
    });
    expect(result.state.nodes.detect_blockers!.status).toBe('needs_review');
    expect(result.state.nodes.detect_blockers!.summary).toContain('Blocker penunjang');
  });
});

describe('ranap newborn (BYNY) SEP handling', () => {
  it('uses the newborn own SEP when it has one', async () => {
    const { result } = await runPreview(RANAP_BYNY_OWN_SEP_OVERRIDES);
    const node = result.state.nodes.validate_sep!;
    expect(node.status).toBe('success');
    // A real SEP is accepted outright — no waiver, so no needs_review.
    expect(logOf(result)).toContain('SEP mandiri terdeteksi dan dipakai');
    expect(logOf(result)).not.toContain('SEP mandiri BYNY dilewati');
  });

  it('waives the SEP for a healthy newborn and anchors the room days on the birth date', async () => {
    const { result } = await runPreview(RANAP_BYNY_HEALTHY_OVERRIDES);
    const node = result.state.nodes.validate_sep!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('byny_sehat_mengikuti_sep_orangtua');

    // The anchor is `birth_date` from `get_single_id` (ranap_v3.py:15831), not
    // the registration's `tgl_masuk` — the newborn was registered the next day,
    // so anchoring on `tgl_masuk` would drop the day of birth from the bill.
    const assignments = result.state.nodes.build_rooms!.evidence.find(
      (item) => item.label === 'roomDayAssignments',
    )?.data as Record<string, string[]>;
    expect(assignments['03-100001']![0]).toBe(RANAP_BYNY_BIRTH_DATE);
    expect(assignments['03-100001']).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
    expect(result.state.nodes.detect_byny!.status).toBe('success');
  });

  it('still requires a SEP for a sick newborn on BPJS', async () => {
    const { result } = await runPreview(RANAP_BYNY_SICK_OVERRIDES);
    const node = result.state.nodes.validate_sep!;
    expect(node.status).toBe('failed');
    expect(logOf(result)).toContain('Pasien BYNY sakit / tidak terkonfirmasi sehat');
    // validate_sep is critical, so nothing downstream may proceed.
    expect(result.status).toBe('failed');
    expect(result.state.nodes.final_gate!.status).toBe('pending');
  });

  it('fails closed when the newborn RME cannot be read', async () => {
    // No `single_id` means the discharge summary cannot even be fetched. The
    // health check must answer "not healthy", never "healthy by default".
    const noSingleId = await runPreview({ ...RANAP_BYNY_HEALTHY_OVERRIDES, 'rme.getSingleId': json({}) });
    expect(noSingleId.result.state.nodes.validate_sep!.status).toBe('failed');

    // A `single_id` but no discharge summary row is equally unproven.
    const noRingkasan = await runPreview({
      ...RANAP_BYNY_HEALTHY_OVERRIDES,
      'rme.getRingkasanPulangLast': json({ total: 0, rows: [] }),
    });
    expect(noRingkasan.result.state.nodes.validate_sep!.status).toBe('failed');

    // A summary whose `data_post` never ticks "keadaan baik" is not proof either.
    const notTicked = await runPreview({
      ...RANAP_BYNY_HEALTHY_OVERRIDES,
      'rme.getRingkasanPulangLast': json({
        total: 1,
        rows: [{ dt: { data_post: JSON.stringify({ txt_diagnosis_text_rinplg: 'BAYI SEHAT' }) } }],
      }),
    });
    expect(notTicked.result.state.nodes.validate_sep!.status).toBe('failed');
  });

  it('reads keadaan and diagnosis out of the nested data_post JSON string', async () => {
    const { result } = await runPreview(RANAP_BYNY_HEALTHY_OVERRIDES, RANAP_DEBUG_INPUT);
    // Both fields live inside `rows[0].dt.data_post`, which is a JSON *string*;
    // reading them off the top level yields nothing and used to make every
    // newborn "healthy".
    expect(logOf(result)).toMatch(/- Keadaan\s+: chk_baik_rinplg/);
    expect(logOf(result)).toMatch(/- Diagnosis\s+: BAYI SEHAT/);
    expect(logOf(result)).toMatch(/- Single id RME\s+: SID-0001/);
  });

  it('reads the RME pair once per registration', async () => {
    const { transport } = await runPreview(RANAP_BYNY_HEALTHY_OVERRIDES);
    // validate_sep and detect_byny both need the status; the Python memoizes it
    // in `_BYNY_RME_STATUS_CACHE` and so must this port.
    expect(callsFor(transport, 'rme.getSingleId')).toHaveLength(1);
    expect(callsFor(transport, 'rme.getRingkasanPulangLast')).toHaveLength(1);
    expect(bodyOf(transport, 'rme.getRingkasanPulangLast')).toEqual({
      no_registrasikunjungan: 'REG-0001',
      single_id: 'SID-0001',
    });
  });
});

describe('ranap mutation plan metadata', () => {
  it('gives every plan in a run a distinct id and idempotency key', async () => {
    const { result } = await runApprovedWrite();
    const plans = plansOf(result);
    // sync_tindakan and sync_visite both propose penatajasaInap.updateTgl for
    // the same transaction, which is exactly the collision this guards.
    const updateTgl = plans.filter((plan) => plan.endpointId === 'penatajasaInap.updateTgl');
    expect(updateTgl.length).toBeGreaterThan(1);
    const keys = plans.map((plan) => plan.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(plans.map((plan) => plan.id)).size).toBe(plans.length);
    // The key names the emitting node, so an approver can tell them apart.
    expect(keys.some((key) => key.includes(':sync_tindakan:'))).toBe(true);
    expect(keys.some((key) => key.includes(':sync_visite:'))).toBe(true);
  });

  it('resolves the room pelaksana by score, not by first match', async () => {
    const { result, transport } = await runPreview();
    // The dropdown is read over GET with `kd_unit` in the query. Two entries
    // match-ish; `_resolve_room_pelaksana` (ranap_v3.py:1918) scores every
    // (option, segment) pair and takes the best, so `PERAWAT <room>` (rung 640)
    // wins over `PERAWAT ARAFAH`, which scores nothing at all against the
    // compound label. It also returns the option's raw name, prefix included.
    expect(queryOf(transport, 'penatajasaInap.getCmbParamedisPelaksana')).toEqual({ kd_unit: 'U01' });
    // The resolved name is what `tampung_pelaksana_tindakan` posts as
    // `Kd_ParaMedis` — the field really does carry a display name, not a code.
    const plan = planFor(result, 'poliklinik.tampungPelaksana');
    expect(plan.payloadSummary.pelaksana).toBe('PERAWAT RUANG ARAFAH KELAS 3');
    expect(plan.payload?.Kd_ParaMedis).toBe('PERAWAT RUANG ARAFAH KELAS 3');
  });

  it('returns no pelaksana rather than inventing the room label', async () => {
    // The Python's `if not kandidat: return ""` (ranap_v3.py:1977). Falling back
    // to the normalised room name put a value in the payload that names no real
    // paramedis account — so with no scoring candidate the jasa sweep must plan
    // nothing at all rather than write the ward's name into `Kd_ParaMedis`.
    const { result } = await runPreview({
      'penatajasaInap.getCmbParamedisPelaksana': json([{ kd_paramedis: 'P900', nama_paramedis: 'PERAWAT ARAFAH' }]),
    });
    // Scoped to `sync_tindakan`: the visite repair fills its performer from the
    // CPPT notes, which the ward dropdown has nothing to do with.
    const roomPlans = result.state.nodes
      .sync_tindakan!.proposedMutations.filter((plan) => plan.endpointId === 'poliklinik.tampungPelaksana');
    expect(roomPlans).toHaveLength(0);
    expect(logOf(result)).toContain('pelaksana jasa tidak ditemukan dari endpoint');
  });

  it('retries the pelaksana dropdown against kd_unit=undefined when it is empty', async () => {
    // ranap_v3.py:1923-1924 — the shared ward accounts live under "undefined".
    const { transport } = await runPreview({ 'penatajasaInap.getCmbParamedisPelaksana': json([]) });
    const units = callsFor(transport, 'penatajasaInap.getCmbParamedisPelaksana').map(
      (call) => new URL(call.url).searchParams.get('kd_unit'),
    );
    expect(units).toContain('U01');
    expect(units).toContain('undefined');
  });

  it('stops after verification when tampung bayar is switched off', async () => {
    // The operator's checkpoint for the manual review: the run verifies the
    // registration, then stops before any payment is staged. Disabling the node
    // instead would skip a required edge and could hold back the summary, so the
    // switch has to do the stopping.
    const { result, transport } = await runApprovedWrite(
      {},
      { ...RANAP_HAPPY_INPUT, enableTampungBayar: false },
    );

    expect(result.state.nodes.execute_verifikasi!.proposedMutations.length).toBeGreaterThan(0);
    expect(result.state.nodes.tampung_bayar!.status).toBe('skipped');
    expect(result.state.nodes.tampung_bayar!.summary).toMatch(/dinonaktifkan/);
    expect(plansOf(result).filter((plan) => plan.endpointId === 'kasir.tampungBayar')).toHaveLength(0);
    expect(callsFor(transport, 'kasir.tampungBayar')).toHaveLength(0);
  });

  it('runs checks only when verification is switched off: no gate, no verification, no payment', async () => {
    const { client } = clientFor({});
    const runner = new WorkflowRunner(ranapWorkflow, createRanapExecutors({ client }));
    const result = await runner.run({
      mode: 'preview', input: RANAP_HAPPY_INPUT, runId: 'ranap_verify_off',
      enabled: { final_gate: false, execute_verifikasi: false, tampung_bayar: false },
    });
    expect(result.state.nodes.check_balance!.status).not.toBe('pending');
    for (const id of ['final_gate', 'execute_verifikasi', 'tampung_bayar']) expect(result.state.nodes[id]!.status).toBe('skipped');
    expect(Object.keys(result.state.gates).filter((id) => result.state.gates[id]!.status === 'waiting')).toHaveLength(0);
    expect(plansOf(result).filter((plan) => plan.endpointId === 'verifikator.simpanVerifikasi')).toHaveLength(0);
  });

  it('guards tampung bayar with a verified transaction, not an unverified one', async () => {
    const { result } = await runApprovedWrite();
    const plan = planFor(result, 'kasir.tampungBayar');
    // `main()` stages payment only `if verified and balanced`
    // (ranap_v3.py:16855), so the expected status is "1".
    const verifikasi = plan.preconditions.find((item) => item.check === 'kasir.cekStatusVerifikasi');
    expect(verifikasi?.expected).toBe('1');
    expect(checksOf(plan)).toEqual([
      'kasir.cekStatusVerifikasi',
      'kasir.cekOrderBelumTerlayani',
      'kasir.cekOrderBelumTransfer',
      'kasir.getHistoryPembayaran',
    ]);
  });

  it('guards the tindakan date writes per line item, not per transaction', async () => {
    const { result } = await runApprovedWrite();
    for (const plan of plansOf(result).filter((item) => item.endpointId === 'penatajasaInap.updateTgl')) {
      expect(checksOf(plan)).toEqual([
        'penatajasaInap.cekStatusVerifikasi',
        'penatajasaInap.cekStatusBayar',
      ]);
      expect(checksOf(plan)).not.toContain('kasir.cekStatusVerifikasi');
    }
  });

  it('plans no SEP correction at all while the kasir SEP is unreadable', async () => {
    // `update_sep`'s only read guard re-read `kasir.getDataTransaksi`, which is
    // dead on this backend — a correction could never be verified, so
    // `compare_sep` surfaces needs_review and proposes nothing.
    const { result } = await runApprovedWrite();
    expect(plansOf(result).filter((plan) => plan.endpointId === 'rekamMedis.simpanSep')).toHaveLength(0);
    expect(result.state.nodes.compare_sep!.status).toBe('needs_review');
  });

  it('confirms verification against the kasir status, not a text endpoint field', async () => {
    const { result } = await runApprovedWrite();
    const plan = planFor(result, 'verifikator.simpanVerifikasi');
    // `_confirm_verifikasi_state` (ranap_v3.py:15371) is a conjunction: the kasir
    // status must read "1" AND `cektransaksi_penunjang` must report no new
    // blocker. `verifikator.getCekVerifikasi` answers plain text and has no
    // `status` field to compare, so it is not used.
    const rules = verificationRulesOf(plan);
    expect(rules.map((rule) => rule.endpointId)).toEqual([
      'kasir.cekStatusVerifikasi',
      'verifikator.cekTransaksiPenunjang',
    ]);
    expect(rules[0]!.expected).toBe('1');
    // An empty `field` reads the whole body — these endpoints answer with a bare
    // string, so naming a field would compare `undefined` and fail a write that
    // actually landed.
    expect(rules[0]!.field).toBe('');
    expect(rules[1]!.match).toBe('empty');
    expect(checksOf(plan)).toEqual(['verifikator.cekStatusKeluar', 'verifikator.cekTransaksiPenunjang']);
  });

  it('never stamps a plan with a precondition its endpoint does not have', async () => {
    const { result } = await runApprovedWrite();
    const plans = plansOf(result);
    expect(plans.length).toBeGreaterThan(3);
    for (const plan of plans) {
      // The old code stamped the same two on all nine plan types.
      const checks = checksOf(plan);
      expect(new Set(checks).size, plan.endpointId).toBe(checks.length);
      if (plan.endpointId !== 'kasir.tampungBayar') {
        expect(checks, plan.endpointId).not.toContain('kasir.getHistoryPembayaran');
      }
    }
  });
});

describe('ranap executable mutation payloads', () => {
  /**
   * Plans that are review-only **on purpose**, keyed by why.
   *
   * A `MutationPlan` without `payload` is refused by the orchestrator's mutation
   * gate (fail closed), so every entry here has to be a case where no correct
   * body can be built at plan time — not a case where one was forgotten.
   */
  const PAYLOAD_EXEMPT = new Set<string>([
    // `planVisiteSync`'s follow-ups of an add: the created row's
    // `urut_tindakan` is assigned by the backend, so `update_tgl` /
    // `tampung_pelaksana` have nothing to address until the executor re-reads
    // `get_listtindakan`. That is exactly what `status: 'incomplete'` asks for.
    'sync_visite:updateTgl-after-add',
    'sync_visite:setPelaksana-after-add',
  ]);

  it('gives every plan of a whole run an executable payload', async () => {
    const { result } = await runApprovedWrite();
    const plans = plansOf(result);
    expect(plans.length).toBeGreaterThan(5);
    for (const plan of plans) {
      expect(plan.payload, `${plan.id} has no payload`).toBeDefined();
      expect(Object.keys(plan.payload ?? {}).length, plan.id).toBeGreaterThan(0);
      // A summary is a digest for the approver; it must never be the body.
      expect(plan.payload).not.toBe(plan.payloadSummary);
    }
    expect(PAYLOAD_EXEMPT.size).toBe(2);
  });

  it('addresses every read-before-write guard with its own request body', async () => {
    // The gate falls back to the plan's write body when a check declares none,
    // and for a per-line-item read that under-addresses: an under-addressed read
    // can answer empty, which reads as a pass.
    const { result } = await runApprovedWrite();
    for (const plan of plansOf(result)) {
      for (const precondition of plan.preconditions) {
        expect(precondition.payload, `${plan.endpointId} / ${precondition.check}`).toBeDefined();
        expect(Object.keys(precondition.payload ?? {}).length).toBeGreaterThan(0);
      }
    }
  });

  it('never infers a subset match for a "nothing here" guard', async () => {
    // `expected: {total: 0}` infers `subset` and refuses the bare `{}` a clean
    // registration returns; `expected: {}` holds even when a blocker is present.
    // Both traps are avoided by saying `empty` outright.
    const { result } = await runApprovedWrite();
    const plan = planFor(result, 'kasir.tampungBayar');
    for (const check of ['kasir.cekOrderBelumTerlayani', 'kasir.cekOrderBelumTransfer']) {
      const precondition = plan.preconditions.find((item) => item.check === check);
      expect(precondition?.match, check).toBe('empty');
    }
  });
});

describe('ranap daily tindakan sync', () => {
  it('plans one op per mis-dated charge instead of one per stay', async () => {
    const { result } = await runPreview();
    const node = result.state.nodes.sync_tindakan!;
    expect(node.status).toBe('needs_review');
    const byEndpoint = node.proposedMutations.reduce<Record<string, number>>((acc, plan) => {
      acc[plan.endpointId] = (acc[plan.endpointId] ?? 0) + 1;
      return acc;
    }, {});
    // The fixture stay is mis-dated twice (a poli charge a day early, a room
    // charge outside the assigned range) and is missing the structural charges
    // on two of its three days.
    expect(byEndpoint['penatajasaInap.updateTgl']).toBeGreaterThanOrEqual(2);
    expect(byEndpoint['penatajasaInap.tambahTindakanPolis']).toBeGreaterThanOrEqual(1);
    expect(byEndpoint['poliklinik.tampungPelaksana']).toBeGreaterThanOrEqual(1);
    // The summary says the plan assumes its own writes land.
    expect(node.summary).toContain('re-plan');
  });

  it('posts update_tgl_tindakan_inap with the row identity triple', async () => {
    const { result } = await runPreview();
    const plan = result.state.nodes
      .sync_tindakan!.proposedMutations.find((item) => item.endpointId === 'penatajasaInap.updateTgl')!;
    expect(plan).toBeDefined();
    // Field for field, in `update_tgl_tindakan_inap`'s own order
    // (ranap_v3.py:4707). `kd_user` is present and empty on purpose.
    expect(Object.keys(plan.payload ?? {})).toEqual([
      'txttglupdate_inap',
      'no_transaksi',
      'kd_user',
      'kd_tindakan',
      'tgl_jam',
      'urut_tindakan',
    ]);
    expect(plan.payload!.kd_user).toBe('');
    expect(plan.payload!.no_transaksi).toBe('03-100001');
    // One plan per row, so the three per-row fields carry a single value and
    // never the legacy batch separator.
    for (const key of ['kd_tindakan', 'tgl_jam', 'urut_tindakan']) {
      expect(plan.payload![key], key).not.toContain("','");
      expect(plan.payload![key], key).toBeTruthy();
    }
    // The guards address that same row, not the transaction.
    expect(checksOf(plan)).toEqual([
      'penatajasaInap.cekStatusVerifikasi',
      'penatajasaInap.cekStatusBayar',
    ]);
    for (const precondition of plan.preconditions) {
      expect(Object.keys(precondition.payload ?? {}).sort()).toEqual([
        'kd_tindakan',
        'no_transaksi',
        'urut_tindakan',
      ]);
      expect(precondition.payload!.urut_tindakan).toBe(plan.payload!.urut_tindakan);
    }
    const [readBack] = verificationRulesOf(plan);
    expect(readBack).toMatchObject({
      endpointId: 'penatajasaInap.getListTindakan',
      where: { kd_tindakan: plan.payload!.kd_tindakan, urut_tindakan: plan.payload!.urut_tindakan },
      field: 'tgl_jam',
      match: 'contains',
      payload: {
        no_transaksi: plan.payload!.no_transaksi,
        no_registrasikunjungan: 'REG-0001',
        kd_kamarperawatan: 'KM01',
        page: '1',
        rows: '999',
      },
    });
  });

  it('posts tambah_tindakan_polis with the inconsistent legacy key names', async () => {
    const { result } = await runPreview();
    const plan = result.state.nodes.sync_tindakan!.proposedMutations.find(
      (item) => item.endpointId === 'penatajasaInap.tambahTindakanPolis',
    )!;
    expect(plan).toBeDefined();
    // ranap_v3.py:4173 — `No_Transaksi_Poli` even on an inpatient transaction.
    expect(Object.keys(plan.payload ?? {})).toEqual([
      'No_Transaksi_Poli',
      'Kd_ParaMedis_Poli',
      'Kd_DetKelPenjamin_Poli',
      'Kd_Tindakan_Poli',
      'Kd_Unit_Poli',
      'Harga_Poli',
      'pisah_klaim',
      'Qty_Poli',
      'Jumlah_Poli',
      'kd_kamar',
      'tgl_mulai',
      'tgl_selesai',
      'durasi',
    ]);
    expect(plan.payload!.Qty_Poli).toBe('1');
    expect(plan.payload!.pisah_klaim).toBe('0');
    expect(plan.payload!.Jumlah_Poli).toBe(plan.payload!.Harga_Poli);
    expect(plan.payload!.kd_kamar).toBe('KM01');
    // There is no line item yet, so the guard is the transaction-level one.
    expect(checksOf(plan)).toEqual(['kasir.cekStatusVerifikasi']);
    expect(plan.preconditions[0]!.expected).toBe('0');
  });

  it('posts tampung_pelaksana_tindakan with the resolved performer name', async () => {
    const { result } = await runPreview();
    const plan = result.state.nodes.sync_tindakan!.proposedMutations.find(
      (item) => item.endpointId === 'poliklinik.tampungPelaksana',
    )!;
    expect(Object.keys(plan.payload ?? {})).toEqual([
      'No_Transaksi',
      'Kd_ParaMedis',
      'Kd_Tindakan',
      'harga',
      'harga_persen',
      'kd_komponen',
      'urut_tindakan',
      'diskon',
      'nilai',
    ]);
    expect(plan.payload!.harga_persen).toBe('100');
    expect(plan.payload!.kd_komponen).toBe('98');
    // `_tampung_pelaksana_checked` gates on the line's verification only.
    expect(checksOf(plan)).toEqual(['penatajasaInap.cekStatusVerifikasi']);
  });

  it('records the rows it deliberately left alone as evidence, not as log spam', async () => {
    const { result } = await runPreview();
    const node = result.state.nodes.sync_tindakan!;
    const untouched = node.evidence.find((item) => item.label === 'tindakanUntouched')?.data as Array<
      Record<string, string>
    >;
    expect(Array.isArray(untouched)).toBe(true);
    // `_sinkronkan_tanggal_biaya_obat_inap` is disabled in the legacy, so its
    // rows have to reach the operator as evidence rather than vanish.
    expect(untouched.every((row) => typeof row.alasan === 'string')).toBe(true);
  });
});

describe('ranap visite sync', () => {
  it('fills an empty specialist performer from the CPPT notes', async () => {
    const { result } = await runPreview();
    const node = result.state.nodes.sync_visite!;
    expect(node.status).toBe('needs_review');
    const plan = node.proposedMutations.find(
      (item) => item.endpointId === 'poliklinik.tampungPelaksana',
    )!;
    expect(plan, 'no setPelaksana plan from the CPPT fill').toBeDefined();
    // The doctor charting on the row's own date, snapped to the registry
    // spelling `tampung_pelaksana` matches on.
    expect(plan.payload!.Kd_ParaMedis).toBe('DR CONTOH SATU');
    // Component 29 is where the performing specialist lives.
    expect(plan.payload!.kd_komponen).toBe('29');
    expect(plan.payload!.Kd_Tindakan).toBe('T04');
    expect(plan.payload!.urut_tindakan).toBe('5');
  });

  it('deletes the specialist row when the CPPT cannot name a doctor', async () => {
    // No CPPT at all: `_repair_spesialis_visite_from_cppt_or_delete`
    // (ranap_v3.py:10471) removes a visite nobody can be credited with.
    const { result } = await runPreview({ 'rme.loadCpptSoap': json({ total: 0, rows: [] }) });
    const plans = result.state.nodes.sync_visite!.proposedMutations;
    const hapus = plans.find((plan) => plan.endpointId === 'penatajasaInap.hapusTindakan');
    expect(hapus, 'no delete planned for the unattributable visite').toBeDefined();
    // ranap_v3.py:4787 — the cancellation reason is always "1".
    expect(Object.keys(hapus!.payload ?? {})).toEqual([
      'no_transaksi',
      'kd_tindakan',
      'Kd_Alasan_Batal_Transaksi',
      'tgl_jam',
      'urut_tindakan',
    ]);
    expect(hapus!.payload!.Kd_Alasan_Batal_Transaksi).toBe('1');
  });

  it('reports needs_review with the re-plan warning when the plan is incomplete', async () => {
    // A visite priced above its class tariff is repaired by delete-and-re-add,
    // and the added row's `urut_tindakan` is server-assigned — so the plan comes
    // back `incomplete` and must never read as a clean success.
    const { result } = await runPreview(RANAP_VISITE_WRONG_TARIF_OVERRIDES);
    const node = result.state.nodes.sync_visite!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('re-plan');
    const codes = node.warnings.map((item) => item.code);
    expect(codes).toContain('visite_incomplete');
    expect(node.warnings.find((item) => item.code === 'visite_incomplete')?.message).toMatch(
      /execute, re-read, re-plan/,
    );
    expect(logOf(result)).toMatch(/execute, re-read get_listtindakan, lalu re-plan/);

    // The add is executable; its two follow-ups cannot be addressed yet, so they
    // carry no payload and the gate refuses them — the safe outcome.
    const plans = node.proposedMutations;
    const add = plans.find((plan) => plan.endpointId === 'penatajasaInap.tambahTindakanPolis')!;
    expect(add.payload!.Harga_Poli).toBe('50000');
    const unaddressable = plans.filter((plan) => plan.payload === undefined);
    expect(unaddressable.length).toBeGreaterThan(0);
    for (const plan of unaddressable) {
      expect(Number(plan.payloadSummary.depends_on_op)).toBeGreaterThan(0);
    }
  });
});

describe('ranap tampung bayar read-before-write', () => {
  it('performs all three guard reads before planning the payment', async () => {
    const { result, transport } = await runApprovedWrite();
    // Without these the eligibility check's three refusal branches are dead
    // code, on the one endpoint in the graph that moves money.
    expect(bodyOf(transport, 'kasir.cekOrderBelumTerlayani')).toEqual({
      no_registrasikunjungan: 'REG-0001',
      no_transaksi: '03-100001',
      kd_unit: 'U01',
    });
    expect(bodyOf(transport, 'kasir.cekOrderBelumTransfer')).toEqual({
      no_registrasikunjungan: 'REG-0001',
      no_transaksi: '03-100001',
      kd_unit: 'U01',
    });
    // The payment-history read is a GET and runs twice: reject_paid and here.
    expect(callsFor(transport, 'kasir.getHistoryPembayaran').length).toBeGreaterThanOrEqual(2);
    expect(result.state.nodes.tampung_bayar!.proposedMutations).toHaveLength(1);
  });

  it('refuses the payment when an order is still unserved', async () => {
    const { result } = await runApprovedWrite({
      'kasir.cekOrderBelumTerlayani': json({ total: 2, nama_unit: 'LABORATORIUM PK' }),
    });
    const node = result.state.nodes.tampung_bayar!;
    expect(node.status).toBe('skipped');
    // The refusal carries the Python's own `Total (Unit)` detail line, which is
    // reachable only because the guard read now happens at all.
    expect(node.summary).toContain('2 (LABORATORIUM PK)');
    expect(node.proposedMutations).toHaveLength(0);
  });

  it('refuses the payment when an order is still untransferred', async () => {
    const { result } = await runApprovedWrite({
      'kasir.cekOrderBelumTransfer': json({ total: 1, nama_unit: 'BANK DARAH' }),
    });
    const node = result.state.nodes.tampung_bayar!;
    expect(node.status).toBe('skipped');
    expect(node.summary).toContain('1 (BANK DARAH)');
    expect(node.proposedMutations).toHaveLength(0);
  });

  it('refuses the payment when a receipt already exists', async () => {
    // reject_paid is critical and fires first for a history that covers this
    // registration, so the guard is proved with a receipt on another visit —
    // the tampung bayar read is keyed on the registration and transaction.
    const { result } = await runApprovedWrite({
      'kasir.getHistoryPembayaran': json([{ no_kwitansi: 'KW-9', jumlah: '1000000' }]),
    });
    expect(result.state.nodes.reject_paid!.status).toBe('blocked');
    expect(result.status).toBe('failed');
  });
});

describe('ranap charge lines are loaded for every group', () => {
  // `listTindakanByTrx` used to be written only inside `detect_origin`'s
  // non-newborn branch. A BYNY patient takes `_build_skipped_origin_info`
  // (ranap_v3.py:16259), so the map stayed empty and four steps reported success
  // on no data: `validate_ibs` saw no IBS charge, `validate_obat_pulang`
  // computed `0 - 0 = 0` unmatched, `preverify_summary`'s `hasBiayaObat` was
  // false with no evidence, and `tampung_bayar` built a payload from no lines.
  // The Python's consumers each fetch the lines themselves
  // (`validate_ibs_consistency`:8830, `validate_obat_pulang_for_group`:13203).

  it('reads the inpatient charge list for a newborn too', async () => {
    const { result, transport } = await runPreview(RANAP_BYNY_HEALTHY_OVERRIDES);
    expect(result.state.nodes.detect_origin!.summary).toBeDefined();
    // The `load_charges` read, not `load_kasir`'s earlier `rows: '200'` call.
    expect(
      bodiesOf(transport, 'penatajasaInap.getListTindakan').some(
        (body) =>
          body.no_transaksi === '03-100001' &&
          body.no_registrasikunjungan === 'REG-0001' &&
          body.page === '1' &&
          body.rows === '999',
      ),
    ).toBe(true);
    expect(result.state.nodes.load_charges!.status).toBe('success');
    expect(result.state.nodes.load_charges!.summary).toMatch(/baris tindakan/);
  });

  it('sees a newborn IBS mismatch instead of reporting IBS consistent', async () => {
    const { result } = await runPreview(RANAP_BYNY_IBS_OVERRIDES);
    const node = result.state.nodes.validate_ibs!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('IBS');
    expect(result.state.nodes.validate_obat_pulang!.status).not.toBe('skipped');
    // `validate_ibs_consistency` registers the reg alert **and** the verification
    // blocker (ranap_v3.py:8852-8859), whose "ERROR: IBS mismatch" prefix is one
    // of the three shapes `_get_blocking_reg_alerts` stops on.
    expect(result.state.nodes.preverify_summary!.status).toBe('blocked');
  });

  it('reads the rekapitulasi page for the DEPO IBS half of the comparison', async () => {
    // Without it `hasDepoIbs` is always false and only half a mismatch is
    // reachable. `validate_ibs_consistency` fetches it first (ranap_v3.py:8831).
    const { result, transport } = await runPreview({
      'rekapitulasi.detailHakHtml': {
        text:
          '<table><tr><td>DEPO IBS</td></tr>' +
          '<tr><td><b>TOTAL BIAYA</b></td><td><b>1.000.000</b></td></tr>' +
          '<tr><td><b>TOTAL TAGIHAN</b></td><td><b>1.000.000</b></td></tr></table>',
      },
    });
    // The page is read once per registration and shared with `check_balance`.
    expect(callsFor(transport, 'rekapitulasi.detailHakHtml')).toHaveLength(1);
    // depo_ibs present, biaya_ibs absent → mismatch.
    expect(result.state.nodes.validate_ibs!.status).toBe('needs_review');
  });

  it('does not claim a clean verdict when the charge read failed', async () => {
    // `load_kasir` and `load_charges` now share this endpoint, so the failure
    // has to land only on the `load_charges` read — a first-read failure would
    // fail the critical `load_kasir` and the run would never get this far.
    let listReads = 0;
    const { result } = await runPreview({
      'penatajasaInap.getListTindakan': () => {
        listReads += 1;
        return listReads <= 1
          ? { text: JSON.stringify({ total: 0, rows: [] }) }
          : { status: 500, text: 'backend error' };
      },
    });
    expect(result.state.nodes.load_charges!.status).toBe('needs_review');
    expect(result.state.nodes.validate_ibs!.status).toBe('needs_review');
    expect(result.state.nodes.validate_obat_pulang!.status).toBe('needs_review');
    // A failed read is a sync issue for the registration, which is how the
    // Python's `except` branches reach `_emit_pre_verification_summary`.
    expect(result.state.nodes.preverify_summary!.status).toBe('blocked');
  });
});

describe('ranap failed reads are observable', () => {
  it('returns needs_review when every penunjang history read failed', async () => {
    // `softJson` yields `undefined` on error, which becomes an empty array —
    // indistinguishable from "no penunjang orders" until the failure is recorded.
    const { result } = await runPreview({
      'penatajasaInap.getHistoryILab': failing(),
      'kemoterapi.getHistoryOrderPa': failing(),
      'poliklinik.getHistoryIrad': failing(),
      'penatajasaInap.getHistoryIok': failing(),
    });
    const node = result.state.nodes.validate_penunjang!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('tidak terbaca');
    expect(node.summary).not.toContain('lengkap');
  });

  it('still reports lengkap when the reads succeeded and found nothing', async () => {
    const { result } = await runPreview();
    const node = result.state.nodes.validate_penunjang!;
    expect(node.status).toBe('success');
    expect(node.summary).toContain('Hasil penunjang lengkap');
  });

  it('returns needs_review when the pharmacy history read failed', async () => {
    const { result } = await runPreview({ 'penatajasaInap.getHistoryObat': failing() });
    expect(result.state.nodes.validate_obat_pulang!.status).toBe('needs_review');
    expect(result.state.nodes.validate_obat_pulang!.summary).toContain('tidak terbaca');
  });
});

describe('ranap is one patient per run', () => {
  it('fails at normalize_input on a second No RM instead of billing only the first', async () => {
    const { result } = await runPreview({}, { ...RANAP_HAPPY_INPUT, patientIds: ['012345', '067890'] });
    expect(result.state.nodes.normalize_input!.status).toBe('failed');
    expect(result.state.nodes.normalize_input!.summary).toContain('satu pasien per run');
    expect(result.state.nodes.load_visits!.status).not.toBe('success');
  });
});

describe('ranap gizi preflight and recovery propose their writes', () => {
  const giziHistory = json({
    total: 1,
    rows: [{ no_transaksi: '18-180001', tgl_order: '2026-06-10' }],
  });
  const giziDetail = (statusKirim: string) =>
    json({
      total: 2,
      rows: [
        { urut_order: '1', status_kirim: statusKirim, nama_jadwal: 'PAGI', nama_jenismakan: 'BIASA', tgl_order: '2026-06-10' },
        { urut_order: '2', status_kirim: statusKirim, nama_jadwal: 'SIANG', nama_jenismakan: 'BIASA', tgl_order: '2026-06-10' },
      ],
    });

  it('proposes the pending diet-order sends instead of reporting success', async () => {
    // `ensure_ordergizi_terkirim` (ranap_v3.py:16235, defined 15089) SENDS them;
    // computing `plan.toSend` and returning `ok("N order gizi perlu dikirim")`
    // was a success verdict for work never done and never planned.
    const { result } = await runPreview({
      'penatajasaInap.getHistoryOrderGizi': giziHistory,
      'penatajasaInap.getDataOrderGizi': giziDetail('belum'),
    });
    const node = result.state.nodes.preflight_gizi!;
    expect(node.status).toBe('needs_review');
    expect(node.proposedMutations).toHaveLength(1);
    expect(node.proposedMutations[0]!.endpointId).toBe('penatajasaInap.kirimOrderGizi');
    expect(node.proposedMutations[0]!.payloadSummary).toMatchObject({
      no_transaksi_ordergizi: '18-180001',
      catatan_gizi: '',
    });
  });

  it('reads the kitchen schedule and defers a send it refuses', async () => {
    // `cek_jadwal_gizi` (ranap_v3.py:15154) keys on `no_order`; anything other
    // than "" or "1" means the order cannot be sent right now.
    const { result, transport } = await runPreview({
      'penatajasaInap.getHistoryOrderGizi': giziHistory,
      'penatajasaInap.getDataOrderGizi': giziDetail('belum'),
      'penatajasaInap.cekJadwalGizi': { text: '0' },
    });
    expect(bodyOf(transport, 'penatajasaInap.cekJadwalGizi')).toEqual({ no_order: '18-180001' });
    const node = result.state.nodes.preflight_gizi!;
    expect(node.proposedMutations).toHaveLength(0);
    expect(node.summary).toContain('terblokir');
  });

  it('proposes the recovery actions for a gizi blocker', async () => {
    // `planGiziBlockerRecovery` needs `recoveryPlans` to have anything to do;
    // without it the node reported the blocker and proposed nothing
    // (`recover_ordergizi_error`, ranap_v3.py:15191).
    const { result } = await runPreview({
      'penatajasaInap.getHistoryOrderGizi': giziHistory,
      'penatajasaInap.getDataOrderGizi': giziDetail('sudah'),
      'verifikator.cekTransaksiPenunjang': json({ total: 1, nama_unit: 'ORDER GIZI', no_transaksi: '18-180001' }),
    });
    const node = result.state.nodes.recover_gizi!;
    expect(node.status).toBe('needs_review');
    const endpoints = node.proposedMutations.map((plan) => plan.endpointId);
    // A sent order must be recalled before its lines can be deleted.
    expect(endpoints[0]).toBe('penatajasaInap.batalKirimOrderGizi');
    expect(endpoints.filter((id) => id === 'penatajasaInap.hapusDetailOrderGizi')).toHaveLength(2);
  });
});

describe('ranap Lab PK candidates', () => {
  it('validates a lab transaction found by the direct hasil sweep', async () => {
    // `_collect_direct_hasil_rows_for_group` (ranap_v3.py:7976) reads the lab
    // result module directly; without it the Lab PK branch produced no candidate.
    const { result, transport } = await runPreview({
      'laboratoriumHasil.getDataKunjungan': json({
        total: 1,
        rows: [{ no_transaksi: '05-500001', tgl_transaksi: '2026-06-11 08:00:00' }],
      }),
    });
    expect(bodyOf(transport, 'laboratoriumHasil.getDataKunjungan')).toMatchObject({
      txtmedreccari_hsllab: '0-01-23-45',
      txttgltransaksicari_hsllab: '2026-06-10',
      page: '1',
      rows: '100',
    });
    // The candidate was actually validated, which is the whole point.
    expect(callsFor(transport, 'laboratoriumHasil.getHasilPemeriksaan')).not.toHaveLength(0);
    expect(result.state.nodes.validate_penunjang!.status).toBe('needs_review');
  });

  it('counts the LIS print as the result document and names the order (live shape)', async () => {
    // Live 2026-10-15: `cetak_lis` answers with the LIS PDF link; never read,
    // every Lab PK order read "lis_url=tidak" and needed attention.
    const { result, transport } = await runPreview({
      'laboratoriumHasil.getDataKunjungan': json({ total: 1, rows: [{ no_transaksi: '05-500001', tgl_transaksi: '2026-06-11 08:00:00' }] }),
      'penatajasaInap.getDetailHistoryILab': json({ total: 1, rows: [{ kd_tindakan: '2305', nama_tindakan: 'DARAH RUTIN' }] }),
      'laboratoriumHasil.getHasilPemeriksaan': json({ total: 1, rows: [{ kd_tindakan: '2305', hasil: '13.2', status: '' }] }),
      'laboratoriumHasil.cetakLis': { text: 'simrs.example.local/lis_new/pdf.php?no_transaksi=05-500001' },
    });
    expect(bodyOf(transport, 'laboratoriumHasil.cetakLis')).toEqual({ no_transaksi: '05-500001' });
    expect(logOf(result)).toMatch(/Lab PK 05-500001: .*lis_url=ya/);
  });

  it('reads the poli-related lab orders when a poli source was resolved', async () => {
    // `_collect_related_lab_pk` (ranap_v3.py:7647) filters the lab visit history
    // to the poli source transaction.
    const { result, transport } = await runPreview({
      'laboratorium.getHistoryKunjungan': json({
        total: 1,
        rows: [{ no_transaksi: '01-100001', no_transaksi_lab: '05-500002', tgl_masuk: '2026-06-10 07:30:00' }],
      }),
    });
    expect(bodyOf(transport, 'laboratorium.getHistoryKunjungan')).toEqual({
      nomedrec: '0-01-23-45',
      page: '1',
      rows: '50',
    });
    expect(result.state.nodes.validate_penunjang!.status).toBe('needs_review');
  });
});

describe('ranap balance asks for the episode total', () => {
  it('sends the registration alone, with no transaction or unit', async () => {
    // `cek_balance_total_tagihan` (ranap_v3.py:8641) calls
    // `get_jumlah_bayar_kasir(no_registrasikunjungan=reg)`: `no_transaksi` and
    // `kd_unit` stay empty so the answer is episode-wide, which is the figure the
    // rekapitulasi reports.
    const { transport } = await runPreview();
    expect(bodyOf(transport, 'kasir.getJumlahBayar')).toEqual({
      no_transaksi: '',
      no_registrasikunjungan: 'REG-0001',
      kd_unit: '',
      ck_totaltagihan_ksr: 'true',
      ck_retur_apt: 'false',
    });
  });

  it('balances a two-room stay against the episode rekapitulasi', async () => {
    const { result, transport } = await runPreview(RANAP_TWO_ROOM_OVERRIDES);
    const assignments = result.state.nodes.build_rooms!.evidence.find(
      (item) => item.label === 'roomDayAssignments',
    )?.data as Record<string, string[]>;
    expect(Object.keys(assignments).sort()).toEqual(['03-100001', '03-100002']);
    // One registration, so one balance check — asking per room would compare a
    // single room's total against the whole episode's recap and never balance.
    expect(callsFor(transport, 'kasir.getJumlahBayar')).toHaveLength(1);
    expect(result.state.nodes.check_balance!.status).toBe('success');
    expect(result.state.nodes.final_gate!.status).toBe('blocked'); // preview holds
  });
});

describe('ranap tolerance window', () => {
  const strayDepo = {
    'kasir.getHistoryKunjungan': json({
      total: 2,
      rows: [
        {
          no_registrasikunjungan: 'REG-0001',
          no_transaksi: '03-100001',
          kd_unit: 'U01',
          nama_unit: 'RUANG ARAFAH KELAS 3',
          nama_pasien: 'PASIEN SATU',
          nama_penjamin: 'BPJS PBI',
          tgl_masuk: '2026-06-10 08:00:00',
          tgl_keluar: '2026-06-12 10:00:00',
          status_bayar: 'Belum',
          kd_kelasperawatan: '4',
          urut_masuk_ruang: '1',
        },
        {
          // Six days before the stay: inside a ±7 window, outside a ±3 one.
          // `nama_penjamin` keeps it out of the payment selection, so only the
          // hanging scan's own window decides.
          no_registrasikunjungan: 'REG-0009',
          no_transaksi: '04-040001',
          kd_unit: 'U04',
          nama_unit: 'DEPO FARMASI',
          nama_pasien: 'PASIEN SATU',
          nama_penjamin: 'UMUM',
          tgl_masuk: '2026-06-04 09:00:00',
          status_bayar: 'Belum',
        },
      ],
    }),
  };

  it('uses the run tolerance, not the Python function default of 7', async () => {
    // `main()` always overrides the default with the clamped operator value
    // (ranap_v3.py:15675, then 16268 / 16541 / 16549 / 16573).
    const tight = await runPreview(strayDepo, { ...RANAP_HAPPY_INPUT, toleranceDays: 3 });
    expect(tight.result.state.nodes.scan_hanging_trx!.status).toBe('success');

    const wide = await runPreview(strayDepo, { ...RANAP_HAPPY_INPUT, toleranceDays: 7 });
    expect(wide.result.state.nodes.scan_hanging_trx!.status).toBe('needs_review');
    expect(wide.result.state.nodes.scan_hanging_trx!.summary).toContain('menggantung');
  });

  it('keeps the transaction number out of the hanging alert text', async () => {
    // Log spec line 59: `no trx` is debug-only, and `preverify_summary` prints
    // these alerts in non-debug output.
    const { result } = await runPreview(strayDepo, { ...RANAP_HAPPY_INPUT, toleranceDays: 7 });
    expect(logOf(result)).not.toContain('trx=04-040001');
    const hanging = result.state.nodes.scan_hanging_trx!.evidence.find(
      (item) => item.label === 'hangingTransactions',
    )?.data as Array<{ noTransaksi: string }>;
    expect(hanging.map((item) => item.noTransaksi)).toContain('04-040001');
  });
});

describe('ranap penunjang window dates (WIB)', () => {
  /**
   * An open stay: `tgl_keluar` is empty, so `groupPenunjangWindow` extends the
   * window end by the run tolerance from the latest known date. That extension
   * used `toISOString()`, which shifts the calendar day backwards for any
   * instant after local midnight east of UTC — the penunjang history window then
   * ended a day early and dropped real results.
   */
  const openStay = {
    'kasir.getHistoryKunjungan': json({
      total: 1,
      rows: [
        {
          no_registrasikunjungan: 'REG-0001',
          no_transaksi: '03-100001',
          kd_unit: 'U01',
          nama_unit: 'RUANG ARAFAH KELAS 3',
          nama_pasien: 'PASIEN SATU',
          nama_penjamin: 'BPJS PBI',
          tgl_masuk: '2026-06-10 08:00:00',
          tgl_keluar: '',
          status_bayar: 'Belum',
          kd_kelasperawatan: '4',
          urut_masuk_ruang: '1',
        },
      ],
    }),
    // The ward's own view of the same stay is what `build_rooms` reads.
    'penatajasaInap.getHistoryKunjunganTab': json({
      total: 1,
      rows: [
        {
          no_registrasikunjungan: 'REG-0001',
          no_transaksi: '03-100001',
          kd_unit: 'U01',
          nama_unit: 'RUANG ARAFAH KELAS 3',
          nama_pasien: 'PASIEN SATU',
          nama_penjamin: 'BPJS PBI',
          tgl_masuk: '2026-06-10 08:00:00',
          tgl_keluar: '',
          status_bayar: 'Belum',
          kd_kelasperawatan: '4',
          kd_ruangperawatan: 'R01',
          kd_kamarperawatan: 'KM-01',
          urut_masuk_ruang: '1',
        },
      ],
    }),
  };

  it('extends the window end with the local calendar day, not UTC', async () => {
    const { result } = await runPreview(openStay, { ...RANAP_HAPPY_INPUT, toleranceDays: 3 });
    const windows = result.state.nodes.build_rooms!.evidence.find(
      (item) => item.label === 'groupPenunjangWindow',
    )?.data as Record<string, { start: string; end: string }>;
    // 2026-06-10 + 3 days is 2026-06-13 in every zone; the bug produced
    // 2026-06-12 (and one day earlier still for a late admit) under WIB.
    expect(windows['REG-0001']!.end).toBe('2026-06-13');
  });
});

describe('ranap origin branch verdicts', () => {
  it('takes only the IGD branch when the stay has IGD origin', async () => {
    const { result } = await runPreview(RANAP_IGD_ELEKTROMEDIK_OVERRIDES);
    expect(result.state.nodes.detect_origin!.status).toBe('success');
    expect(result.state.nodes.process_igd!.status).toBe('needs_review');
    expect(result.state.nodes.process_poli!.status).toBe('skipped');
    expect(result.state.edges.detect_origin__process_igd!.status).toBe('completed');
    expect(result.state.edges.detect_origin__process_poli!.status).toBe('skipped');
  });

  it('takes only the POLI branch for the default stay', async () => {
    const { result } = await runPreview();
    expect(result.state.nodes.detect_origin!.status).toBe('success');
    expect(result.state.nodes.process_igd!.status).toBe('skipped');
    expect(result.state.nodes.process_poli!.status).toBe('needs_review');
    expect(result.state.edges.detect_origin__process_igd!.status).toBe('skipped');
    expect(result.state.edges.detect_origin__process_poli!.status).toBe('completed');
  });

  it('takes both branches when different registrations have IGD and POLI origins', async () => {
    const roomVisits = [
      {
        no_registrasikunjungan: 'REG-0001', no_transaksi: '03-100001', nama_pasien: 'PASIEN SATU',
        nama_unit: 'RUANG ARAFAH KELAS 3', kd_unit: 'U01', tgl_masuk: '2026-06-10 08:00:00',
        tgl_keluar: '2026-06-12 10:00:00', status_bayar: 'Belum', no_sep: '0123456789012345', nama_penjamin: 'BPJS PBI',
        kd_kelasperawatan: '4', kd_kamarperawatan: 'KM-KSR', urut_masuk_ruang: '1',
      },
      {
        no_registrasikunjungan: 'REG-0002', no_transaksi: '03-100002', nama_pasien: 'PASIEN SATU',
        nama_unit: 'RUANG ARAFAH KELAS 3', kd_unit: 'U01', tgl_masuk: '2026-06-10 08:00:00',
        tgl_keluar: '2026-06-12 10:00:00', status_bayar: 'Belum', no_sep: '0123456789012345', nama_penjamin: 'BPJS PBI',
        kd_kelasperawatan: '4', kd_kamarperawatan: 'KM-KSR', urut_masuk_ruang: '1',
      },
    ];
    const igdVisit = {
      no_registrasikunjungan: 'REG-0001', no_transaksi: RANAP_IGD_TRX, kd_unit: 'U02',
      nama_unit: 'IGD', tgl_masuk: '2026-06-10 06:00:00', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI',
    };
    const { result } = await runPreview({
      ...RANAP_IGD_ELEKTROMEDIK_OVERRIDES,
      'poliklinik.getListTindakan': (req) =>
        Object.fromEntries(new URLSearchParams(req.body ?? '')).no_transaksi === RANAP_IGD_TRX
          ? { text: JSON.stringify({ total: 1, rows: [{ kd_tindakan: 'HD1', urut_tindakan: '1', nama_tindakan: 'BIAYA OBAT', jumlah: '900000', tgl_transaksi: '2026-06-10 06:30:00' }] }) }
          : (ranapFixtures['poliklinik.getListTindakan']! as { text: string }),
      'kasir.getHistoryKunjungan': json({ total: 3, rows: [...roomVisits, igdVisit] }),
      'penatajasaInap.getHistoryKunjunganTab': json({ total: 2, rows: roomVisits }),
      'penatajasaInap.getListTindakan': (req) => {
        const reg = Object.fromEntries(new URLSearchParams(req.body ?? '')).no_registrasikunjungan;
        return reg === 'REG-0001'
          ? { text: JSON.stringify({ total: 1, rows: [{ nama_tindakan: 'BIAYA UGD DEWASA', kd_tindakan: 'T80', urut_tindakan: '1', tgl_transaksi: '2026-06-10 08:00:00' }] }) }
          : { text: JSON.stringify({ total: 1, rows: [{ nama_tindakan: 'BIAYA POLIKLINIK', kd_tindakan: 'T02', urut_tindakan: '1', tgl_transaksi: '2026-06-10 08:00:00' }] }) };
      },
    });
    expect(result.state.nodes.detect_origin!.summary).toContain('1 IGD, 1 Poliklinik');
    expect(result.state.nodes.process_igd!.status).not.toBe('skipped');
    expect(result.state.nodes.process_poli!.status).not.toBe('skipped');
    expect(result.state.edges.detect_origin__process_igd!.status).toBe('completed');
    expect(result.state.edges.detect_origin__process_poli!.status).toBe('completed');
  });

  it('processes a proven POLI origin while holding an unrelated unknown registration', async () => {
    const known = {
      no_registrasikunjungan: 'REG-0001', no_transaksi: '03-100001', nama_pasien: 'PASIEN SATU',
      nama_unit: 'RUANG ARAFAH KELAS 3', kd_unit: 'U01', tgl_masuk: '2026-06-10 08:00:00',
      tgl_keluar: '2026-06-12 10:00:00', status_bayar: 'Belum', no_sep: '0123456789012345',
      nama_penjamin: 'BPJS PBI', kd_kelasperawatan: '4', kd_kamarperawatan: 'KM-KSR', urut_masuk_ruang: '1',
    };
    const unknown = { ...known, no_registrasikunjungan: 'REG-0002', no_transaksi: '03-100002' };
    const overrides: Record<string, FixtureEntry> = {
      'kasir.getHistoryKunjungan': json({ total: 2, rows: [known, unknown] }),
      'penatajasaInap.getHistoryKunjunganTab': json({ total: 2, rows: [known, unknown] }),
      'penatajasaInap.getListTindakan': (req) => {
        const reg = new URLSearchParams(req.body ?? '').get('no_registrasikunjungan');
        return { text: JSON.stringify({ total: 1, rows: [{
          nama_tindakan: reg === 'REG-0001' ? 'BIAYA POLIKLINIK' : 'BIAYA KAMAR KELAS 3',
          kd_tindakan: 'T02', urut_tindakan: '1', tgl_transaksi: '2026-06-10 08:00:00',
        }] }) };
      },
    };
    const { result } = await runApprovedWrite(overrides);
    expect(result.state.nodes.detect_origin!.status).toBe('needs_review');
    expect(result.state.nodes.detect_origin!.summary).toContain('03-100002');
    expect(result.state.edges.detect_origin__process_igd!.status).toBe('skipped');
    expect(result.state.edges.detect_origin__process_poli!.status).toBe('completed');
    expect(result.state.nodes.process_poli!.status).not.toBe('skipped');
    expect(result.state.nodes.process_poli!.proposedMutations.some((plan) => plan.endpointId === 'poliklinik.updateTgl' && plan.payloadSummary?.no_registrasikunjungan === 'REG-0001')).toBe(true);
    expect(result.state.nodes.execute_verifikasi!.proposedMutations.some((plan) => plan.payloadSummary?.no_registrasikunjungan === 'REG-0002')).toBe(false);
    expect(result.state.nodes.tampung_bayar!.proposedMutations.some((plan) => plan.payloadSummary?.no_registrasikunjungan === 'REG-0002')).toBe(false);
  });

  it('skips both origins for BYNY without planning payment', async () => {
    const { result } = await runPreview(RANAP_BYNY_HEALTHY_OVERRIDES);
    expect(result.state.nodes.detect_origin!.status).toBe('success');
    expect(result.state.nodes.process_igd!.status).toBe('skipped');
    expect(result.state.nodes.process_poli!.status).toBe('skipped');
    expect(result.state.edges.detect_origin__process_igd!.status).toBe('skipped');
    expect(result.state.edges.detect_origin__process_poli!.status).toBe('skipped');
    expect(plansOf(result).filter((plan) => plan.endpointId === 'kasir.tampungBayar')).toHaveLength(0);
  });

  it('holds both branches when no origin is supported by the charge or visit history', async () => {
    const { result } = await runPreview({
      'penatajasaInap.getListTindakan': json({ total: 1, rows: [{ nama_tindakan: 'BIAYA KAMAR KELAS 3' }] }),
      'kasir.getHistoryKunjungan': json({ total: 1, rows: [{ no_registrasikunjungan: 'REG-0001', no_transaksi: '03-100001', nama_pasien: 'PASIEN SATU', nama_unit: 'RUANG ARAFAH KELAS 3', tgl_masuk: '2026-06-10 08:00:00', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', no_sep: '0123456789012345', kd_unit: 'U01' }] }),
    });
    expect(result.state.nodes.detect_origin!.status).toBe('needs_review');
    expect(result.state.nodes.detect_origin!.summary).toContain('tanpa asal masuk');
    expect(result.state.nodes.process_igd!.status).toBe('skipped');
    expect(result.state.nodes.process_poli!.status).toBe('skipped');
    expect(result.state.edges.detect_origin__process_igd!.status).toBe('skipped');
    expect(result.state.edges.detect_origin__process_poli!.status).toBe('skipped');
    expect(plansOf(result).filter((plan) => plan.endpointId === 'kasir.tampungBayar')).toHaveLength(0);
    expect(result.state.nodes.validate_ibs!.status).not.toBe('skipped');
    expect(result.state.nodes.validate_obat_pulang!.status).not.toBe('skipped');
  });
});

describe('ranap IGD origin with a derived elektromedik charge', () => {
  it('forces IGD origin on a hemodialysis signal', async () => {
    // ranap_v3.py:16270-16296. The inpatient charge list says Poliklinik, so
    // without the override the HD charges are never transferred and later surface
    // as a hanging transaction.
    const { result } = await runPreview(RANAP_IGD_ELEKTROMEDIK_OVERRIDES, RANAP_DEBUG_INPUT);
    expect(result.state.nodes.detect_origin!.summary).toContain('1 IGD');
    expect(logOf(result)).toMatch(/HD signal\s+: Ya/);
    const plan = planFor(result, 'poliklinik.transferIgd');
    expect(plan.payloadSummary).toMatchObject({ igd_trx: RANAP_IGD_TRX });
    // Never the registration number where a transaction belongs.
    expect(plan.idempotencyKey).toContain(RANAP_IGD_TRX);
  });

  it('reads a fully transferred IGD source as settled, not as a missing source (live shape)', async () => {
    // Live 2026-10-15: every IGD-origin stay checked had its IGD charges
    // already transferred, and the node said "IGD asal tidak ditemukan".
    const { result } = await runPreview({
      ...RANAP_IGD_ELEKTROMEDIK_OVERRIDES,
      'poliklinik.getListTindakan': json({
        total: 2,
        rows: [
          { kd_tindakan: 'HD1', urut_tindakan: '1', nama_tindakan: 'BIAYA HEMODIALISA', jumlah: '900000', tgl_transaksi: '2026-06-10 06:30:00', flag: 'transfer' },
          { kd_tindakan: 'HD2', urut_tindakan: '2', nama_tindakan: 'BIAYA BHP HEMODIALISA', jumlah: '150000', tgl_transaksi: '2026-06-10 06:40:00', status_kirim: '1' },
        ],
      }),
    });
    const node = result.state.nodes.process_igd!;
    expect(node.status).toBe('success');
    expect(node.summary).toBe('Tagihan IGD asal sudah tertransfer untuk 1 grup');
    expect(node.proposedMutations).toHaveLength(0);
  });

  it('joins the pending IGD charge codes with the literal separator the backend wants', async () => {
    // "format sesuai HAR: 38','16','1929…" (ranap_v3.py:9201) — one POST carries
    // the whole list, so `kd_tindakan` is a `','`-joined string, not an array.
    const { result } = await runPreview(RANAP_IGD_ELEKTROMEDIK_OVERRIDES);
    const plan = planFor(result, 'poliklinik.transferIgd');
    expect(Object.keys(plan.payload ?? {})).toEqual([
      'no_transaksi',
      'no_transaksipoli',
      'kd_unit_poli',
      'Kd_DetKelPenjamin',
      'biaya',
      'kd_unit',
      'kd_tindakan',
    ]);
    expect(plan.payload!.kd_tindakan).toBe("HD1','HD2");
    expect(plan.payload!.no_transaksi).toBe(RANAP_IGD_TRX);
    // The destination transaction, not the IGD one.
    expect(plan.payload!.no_transaksipoli).toBe('03-100001');
    expect(plan.payload!.biaya).toBe('900000');
    expect(checksOf(plan)).toEqual(['poliklinik.cekStatusOrder', 'poliklinik.cekJumlahTransfer']);
  });

  it('does not report the IGD transaction it is transferring as hanging', async () => {
    // `handled_transactions` takes four groups (ranap_v3.py:16520-16536); the IGD
    // and POLI source transactions were missing, so the very transaction the
    // pipeline transfers raised a WARN that then blocked verification.
    const { result } = await runPreview(RANAP_IGD_ELEKTROMEDIK_OVERRIDES);
    expect(result.state.nodes.scan_hanging_trx!.status).toBe('success');
    expect(logOf(result)).not.toContain('Transaksi terkait masih menggantung');
  });

  it('does not transfer an elektromedik charge already folded into the IGD transfer', async () => {
    // ranap_v3.py:16510-16516 transfers only `sisa_no_transaksi_elektromedik`.
    // Both plans on one charge would be a double transfer if both were approved.
    const { result } = await runPreview(RANAP_IGD_ELEKTROMEDIK_OVERRIDES);
    const node = result.state.nodes.transfer_elektromedik!;
    expect(node.status).toBe('skipped');
    expect(node.summary).toContain('termasuk dalam transfer IGD asal');
    expect(plansOf(result).filter((plan) => plan.endpointId === 'elektromedik.transferTagihan')).toHaveLength(0);
    expect(plansOf(result).filter((plan) => plan.endpointId === 'poliklinik.transferIgd')).toHaveLength(1);
    expect(RANAP_IGD_ELEKTROMEDIK_TRX).toBe('11-110001');
  });

  it('verifies a direct elektromedik transfer by reading every tindakan as sent', async () => {
    const trx = '13-040225-1515';
    const { result } = await runPreview({
      'kasir.getHistoryKunjungan': json({
        total: 2,
        rows: [
          {
            no_registrasikunjungan: 'REG-0001',
            no_transaksi: '03-100001',
            kd_unit: 'U01',
            nama_unit: 'RUANG ARAFAH KELAS 3',
            nama_pasien: 'PASIEN SATU',
            nama_penjamin: 'BPJS PBI',
            tgl_masuk: '2026-06-10 08:00:00',
            tgl_keluar: '2026-06-12 10:00:00',
            status_bayar: 'Belum',
            no_sep: '0123456789012345',
            kd_kamarperawatan: 'KM-KSR',
            kd_kelasperawatan: '4',
            urut_masuk_ruang: '1',
          },
          {
            no_registrasikunjungan: 'REG-0001',
            no_transaksi: trx,
            kd_unit: 'U13',
            nama_unit: 'PENUNJANG LAIN',
            nama_pasien: 'PASIEN SATU',
            nama_penjamin: 'BPJS PBI',
            tgl_masuk: '2026-06-10 09:00:00',
            status_bayar: 'Belum',
          },
        ],
      }),
      'elektromedik.getHistoryKunjungan': json({
        total: 1,
        rows: [{ no_transaksi: trx, no_transaksipoli: '01-100001', nama_unit: 'PENUNJANG LAIN' }],
      }),
      'elektromedik.cekStatusBayar': { text: '0' },
    });

    const plan = planFor(result, 'elektromedik.transferTagihan');
    expect(plan.payload).toEqual({
      no_transaksi: trx,
      no_transaksipoli: '01-100001',
      kd_detkelpenjamin: '15',
      kd_unit_poli: 'U11',
    });
    expect(checksOf(plan)).toEqual(['elektromedik.cekStatusBayar']);
    const [rule] = verificationRulesOf(plan);
    expect(rule).toMatchObject({
      endpointId: 'elektromedik.getListTindakan',
      field: 'status_kirim',
      expected: '1',
      match: 'allEquals',
      payload: { no_transaksi: trx },
    });
    expect(evaluateExpectation(rule!, { rows: [{ status_kirim: '1' }, { status_kirim: '0' }] }).holds).toBe(false);
    expect(evaluateExpectation(rule!, { rows: [] }).holds).toBe(false);
  });

  it('warns when the origin source cannot be found instead of using the registration', async () => {
    // ranap_v3.py:16321-16370 logs it and registers a WARN reg-alert.
    const { result } = await runPreview({ 'poliklinik.getHistoryKunjungan': json({ total: 0, rows: [] }) });
    const node = result.state.nodes.process_poli!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('POLI asal tidak ditemukan');
    expect(logOf(result)).toContain('POLI asal terkait tidak ditemukan');
    expect(plansOf(result).filter((plan) => plan.endpointId === 'poliklinik.updateTgl')).toHaveLength(0);
  });

  it('plans the poli date sync against the source transaction when it is found', async () => {
    const { result } = await runPreview();
    const plan = planFor(result, 'poliklinik.updateTgl');
    expect(plan.payloadSummary).toMatchObject({ poli_trx: '01-100001', no_registrasikunjungan: 'REG-0001' });
    expect(plan.idempotencyKey).toContain('01-100001');
    expect(verificationRulesOf(plan)).toHaveLength(1);
    const [rule] = verificationRulesOf(plan);
    expect(rule).toMatchObject({
      endpointId: 'poliklinik.getListTindakan',
      where: { kd_tindakan: 'P01', urut_tindakan: '1' },
      field: 'tgl_transaksi',
      expected: '2026-06-10',
      match: 'contains',
      payload: { no_transaksi: '01-100001', page: '1', rows: '999' },
    });
    expect(
      evaluateExpectation(rule!, {
        rows: [
          { kd_tindakan: 'DECOY', urut_tindakan: '9', tgl_transaksi: '2026-06-10 08:00:00' },
          { kd_tindakan: 'P01', urut_tindakan: '1', tgl_transaksi: '2026-06-09 08:00:00' },
        ],
      }).holds,
    ).toBe(false);
  });

  it('re-dates POLI-origin lab and radiology source rows to their result history dates', async () => {
    const { result, transport } = await runPreview({
      'poliklinik.getListTindakan': json({
        total: 2,
        rows: [
          {
            kd_tindakan: 'LAB1',
            urut_tindakan: '2',
            nama_tindakan: 'BIAYA LABORATORIUM',
            status_bayar: 'Belum',
            tgl_transaksi: '2026-06-10 07:30:00',
          },
          {
            kd_tindakan: 'RAD1',
            urut_tindakan: '3',
            nama_tindakan: 'BIAYA RADIOLOGI THORAX',
            status_bayar: 'Belum',
            tgl_transaksi: '2026-06-10 07:40:00',
          },
        ],
      }),
      'penatajasaInap.getHistoryILab': json({
        total: 1,
        rows: [{ no_transaksi: '05-500001', tgl_transaksi: '2026-06-11 08:00:00' }],
      }),
      'laboratoriumHasil.getDetailTransaksi': json({
        total: 1,
        rows: [{ no_referensi: '01-100001', tgl_transaksi: '2026-06-11 08:30:00' }],
      }),
      'poliklinik.getHistoryIrad': json({
        total: 1,
        rows: [{ no_transaksi: '07-700001', tgl_transaksi: '2026-06-12 09:00:00' }],
      }),
      'penatajasaInap.getDetailHistoryIrad': json({
        total: 1,
        rows: [{ no_transaksipoli: '01-100001', tgl_transaksi: '2026-06-12 09:30:00' }],
      }),
    });

    const plans = result.state.nodes.process_poli!.proposedMutations.filter(
      (plan) => plan.endpointId === 'poliklinik.updateTgl',
    );
    expect(plans.map((plan) => plan.payload?.kd_tindakan)).toEqual(['LAB1', 'RAD1']);
    expect(verificationRulesOf(plans[0]!)[0]).toMatchObject({
      expected: '2026-06-11',
      payload: { no_transaksi: '01-100001', page: '1', rows: '999' },
    });
    expect(verificationRulesOf(plans[1]!)[0]).toMatchObject({ expected: '2026-06-12' });
    expect(queryOf(transport, 'laboratoriumHasil.getDetailTransaksi')).toEqual({ no_transaksi: '05-500001' });
    expect(queryOf(transport, 'penatajasaInap.getDetailHistoryIrad')).toEqual({ no_trans: '07-700001' });
  });

  it('resets a transferred POLI source when related lab and radiology dates mismatch', async () => {
    const { result } = await runPreview({
      'poliklinik.getListTindakan': json({
        total: 2,
        rows: [
          {
            kd_tindakan: 'LAB1',
            urut_tindakan: '2',
            nama_tindakan: 'BIAYA LABORATORIUM',
            status_bayar: 'Belum',
            flag: 'Transfer',
            tgl_transaksi: '2026-06-10 07:30:00',
          },
          {
            kd_tindakan: 'RAD1',
            urut_tindakan: '3',
            nama_tindakan: 'BIAYA RADIOLOGI THORAX',
            status_bayar: 'Belum',
            flag: 'Transfer',
            tgl_transaksi: '2026-06-10 07:40:00',
          },
        ],
      }),
      'penatajasaInap.getHistoryILab': json({
        total: 1,
        rows: [{ no_transaksi: '05-500001', tgl_transaksi: '2026-06-11 08:00:00' }],
      }),
      'laboratoriumHasil.getDetailTransaksi': json({
        total: 1,
        rows: [{ no_referensi: '01-100001', tgl_transaksi: '2026-06-11 08:30:00' }],
      }),
      'poliklinik.getHistoryIrad': json({
        total: 1,
        rows: [{ no_transaksi: '07-700001', tgl_transaksi: '2026-06-12 09:00:00' }],
      }),
      'penatajasaInap.getDetailHistoryIrad': json({
        total: 1,
        rows: [{ no_transaksipoli: '01-100001', tgl_transaksi: '2026-06-12 09:30:00' }],
      }),
    });

    const reset = result.state.nodes.process_poli!.proposedMutations.find(
      (plan) => plan.endpointId === 'poliklinik.batalTransfer',
    )!;
    expect(reset).toBeDefined();
    expect(reset.payload).toEqual({ no_transaksipoli: '01-100001', no_transaksi: '01-100001', kd_unit: 'U05' });
    expect(verificationRulesOf(reset).map((rule) => rule.payload)).toEqual([
      { no_transaksi: '01-100001', kd_tindakan: 'LAB1', urut_tindakan: '2' },
      { no_transaksi: '01-100001', kd_tindakan: 'RAD1', urut_tindakan: '3' },
    ]);
  });

  it('plans a clean pending POLI origin transfer on the first pass', async () => {
    const { result } = await runPreview({
      'poliklinik.getListTindakan': json({
        total: 1,
        rows: [
          {
            kd_tindakan: 'P01',
            urut_tindakan: '1',
            nama_tindakan: 'BIAYA OBAT',
            status_bayar: 'Belum',
            tgl_transaksi: '2026-06-10 07:30:00',
          },
        ],
      }),
    });
    const node = result.state.nodes.process_poli!;
    const transfer = node.proposedMutations.find((plan) => plan.endpointId === 'poliklinik.transferIgd')!;
    expect(transfer, 'clean pending POLI source should transfer immediately').toBeDefined();
    expect(node.proposedMutations.filter((plan) => plan.endpointId === 'poliklinik.updateTgl')).toHaveLength(0);
    expect(node.proposedMutations.filter((plan) => plan.endpointId === 'poliklinik.batalTransfer')).toHaveLength(0);
    expect(transfer.id).not.toContain(':pass2:');
    expect(node.replan?.requested).not.toBe(true);
    expect(transfer.payload).toMatchObject({
      no_transaksi: '01-100001',
      no_transaksipoli: '03-100001',
      kd_tindakan: 'P01',
    });
  });

  const labPkOverrides = (
    rows: Array<Record<string, string>>,
    status: Record<string, string> = {},
  ): Record<string, FixtureEntry> => ({
    'poliklinik.getListTindakan': json({
      total: 1,
      rows: [
        {
          kd_tindakan: 'P01',
          urut_tindakan: '1',
          nama_tindakan: 'BIAYA OBAT',
          status_bayar: 'Belum',
          tgl_transaksi: '2026-06-10 07:30:00',
        },
      ],
    }),
    'laboratorium.getHistoryKunjungan': json({
      total: 1,
      rows: [{ no_transaksi: '01-100001', no_transaksi_lab: '05-LPK001', tgl_masuk: '2026-06-10 07:10:00' }],
    }),
    'laboratorium.getListTindakan': json({ total: rows.length, rows }),
    'laboratorium.cekStatusBayarTransfer': { text: status.transferFlag ?? '0' },
    'laboratorium.cekStatusTransferPoliTujuan': { text: status.transferPoliTujuan ?? '0' },
    'laboratorium.cekStatusVerifikasi': { text: status.verifikasiPoliTujuan ?? '0' },
    'laboratorium.cekTransaksiTerbuka': { text: status.transaksiTerbuka ?? '1' },
    'laboratorium.cekTutupTransaksi': { text: status.statusTutup ?? '1' },
    'laboratorium.cekStatusBayar': { text: status.statusBayar ?? '0' },
    'laboratorium.cekStatusTransfer': { text: status.statusTransfer ?? '0' },
    'laboratorium.getTotal': { text: status.biaya ?? '125000' },
  });

  it('plans a Lab PK transfer reset before transferring the POLI source', async () => {
    const { result } = await runPreview(
      labPkOverrides(
        [{ status_bayar: 'Belum', tutup_transaksi: 'Buka' }],
        { transferFlag: '1', transferPoliTujuan: '1', statusTransfer: '1' },
      ),
    );

    const node = result.state.nodes.process_poli!;
    const plan = node.proposedMutations.find((item) => item.endpointId === 'laboratorium.batalTransfer')!;
    expect(plan).toBeDefined();
    expect(plan.payload).toEqual({ no_transaksi: '05-LPK001', no_transaksipoli: '01-100001' });
    expect(checksOf(plan)).toEqual([
      'laboratorium.cekStatusBayarTransfer',
      'laboratorium.cekStatusTransfer',
      'laboratorium.cekStatusTransferPoliTujuan',
    ]);
    expect(verificationRulesOf(plan).map((rule) => rule.endpointId)).toEqual([
      'laboratorium.cekStatusTransfer',
      'laboratorium.cekStatusBayarTransfer',
      'laboratorium.cekStatusTransferPoliTujuan',
    ]);
    expect(node.proposedMutations.some((item) => item.endpointId === 'poliklinik.transferIgd')).toBe(false);
    expect(node.replan?.requested).toBe(true);
  });

  it('plans Lab PK BHP open and close before transfer', async () => {
    const closed = await runPreview(
      labPkOverrides([{ status_bayar: 'Belum', tutup_transaksi: 'Buka' }], { transaksiTerbuka: '0' }),
    );
    const open = planFor(closed.result, 'laboratorium.bukaBhp');
    expect(open.payload).toEqual({ no_transaksi: '05-LPK001' });
    expect(checksOf(open)).toEqual(['laboratorium.cekTransaksiTerbuka']);
    expect(verificationRulesOf(open)[0]).toMatchObject({
      endpointId: 'laboratorium.cekTransaksiTerbuka',
      expected: '1',
      match: 'nonEmpty',
    });

    const untutup = await runPreview(
      labPkOverrides([{ status_bayar: 'Belum', tutup_transaksi: 'Buka' }], { statusTutup: '0' }),
    );
    const tutup = planFor(untutup.result, 'laboratorium.tutupBhp');
    expect(tutup.payload).toEqual({ no_transaksi: '05-LPK001' });
    expect(checksOf(tutup)).toEqual(['laboratorium.cekTutupTransaksi']);
    const rowsRule = verificationRulesOf(tutup).find((rule) => rule.endpointId === 'laboratorium.getListTindakan')!;
    expect(rowsRule).toMatchObject({ field: 'tutup_transaksi', expected: 'Tutup', match: 'allEquals' });
    expect(evaluateExpectation(rowsRule, { rows: [{ tutup_transaksi: 'Tutup' }, { tutup_transaksi: 'Buka' }] }).holds).toBe(false);
  });

  it('plans the Lab PK transfer payload and row-wide readback', async () => {
    const { result, transport } = await runPreview(
      labPkOverrides([{ status_bayar: 'Belum', tutup_transaksi: 'Tutup' }], { biaya: '125000' }),
    );
    const plan = planFor(result, 'laboratorium.transferLab');
    expect(plan.payload).toEqual({
      no_transaksi: '05-LPK001',
      no_transaksipoli: '01-100001',
      kd_unit_poli: 'U05',
      Kd_DetKelPenjamin: '15',
      biaya: '125000',
    });
    expect(checksOf(plan)).toEqual([
      'laboratorium.cekTutupTransaksi',
      'laboratorium.getTotal',
      'laboratorium.cekStatusTransfer',
    ]);
    const rules = verificationRulesOf(plan);
    expect(rules).toMatchObject([
      { endpointId: 'laboratorium.cekStatusTransfer', expected: '1', match: 'nonEmpty' },
      { endpointId: 'laboratorium.getListTindakan', field: 'status_bayar', expected: 'Sudah', match: 'allEquals' },
    ]);
    expect(evaluateExpectation(rules[1]!, { rows: [{ status_bayar: 'Sudah' }, { status_bayar: 'Belum' }] }).holds).toBe(false);
    expect(bodyOf(transport, 'laboratorium.getListTindakan')).toEqual({
      no_transaksi: '05-LPK001',
      no_transaksipoli: '01-100001',
      rujukan: 'false',
      rujukan_keluar: 'false',
    });
    expect(bodyOf(transport, 'laboratorium.getTotal')).toEqual({
      no_transaksi: '05-LPK001',
      no_transaksipoli: '01-100001',
      rujukan: 'false',
      rujukan_keluar: 'false',
    });
    expect(ranapWorkflow.policies?.mutationAllowlist).toEqual(
      expect.arrayContaining([
        'laboratorium.batalTransfer',
        'laboratorium.bukaBhp',
        'laboratorium.tutupBhp',
        'laboratorium.transferLab',
      ]),
    );
  });

  it('re-plans from Lab PK transfer to the source POLI transfer', async () => {
    const { result } = await runApprovedWrite(
      {
        ...labPkOverrides([{ status_bayar: 'Belum', tutup_transaksi: 'Tutup' }]),
        'laboratorium.getListTindakan': sequence(
          json({ total: 1, rows: [{ status_bayar: 'Belum', tutup_transaksi: 'Tutup' }] }),
          json({ total: 1, rows: [{ status_bayar: 'Sudah', tutup_transaksi: 'Tutup' }] }),
        ),
        'laboratorium.cekStatusTransfer': sequence({ text: '0' }, { text: '1' }),
      },
      RANAP_HAPPY_INPUT,
      { replan: true },
    );
    const node = result.state.nodes.process_poli!;
    const labTransfer = node.proposedMutations.find((plan) => plan.endpointId === 'laboratorium.transferLab')!;
    const sourceTransfer = node.proposedMutations.find((plan) => plan.endpointId === 'poliklinik.transferIgd')!;
    expect(labTransfer.id).not.toContain(':pass2:');
    expect(sourceTransfer.id).toContain(':pass2:');
    expect(node.replan?.pass).toBe(2);
    expect(result.events.filter((event) => event.type === 'node.replanning' && event.nodeId === 'process_poli')).toHaveLength(1);
  });

  it('re-plans POLI origin from date sync to transfer reset to re-transfer', async () => {
    const { result, transport } = await runApprovedWrite(
      {
        'poliklinik.getListTindakan': sequence(
          json({
            total: 1,
            rows: [
              {
                kd_tindakan: 'P01',
                urut_tindakan: '1',
                nama_tindakan: 'BIAYA OBAT',
                status_bayar: 'Belum',
                tgl_transaksi: '2026-06-09 07:30:00',
              },
            ],
          }),
          json({
            total: 1,
            rows: [
              {
                kd_tindakan: 'P01',
                urut_tindakan: '1',
                nama_tindakan: 'BIAYA OBAT',
                status_bayar: 'Belum',
                flag: 'Transfer',
                tgl_transaksi: '2026-06-09 07:30:00',
              },
            ],
          }),
          json({
            total: 1,
            rows: [
              {
                kd_tindakan: 'P01',
                urut_tindakan: '1',
                nama_tindakan: 'BIAYA OBAT',
                status_bayar: 'Belum',
                tgl_transaksi: '2026-06-10 07:30:00',
              },
            ],
          }),
        ),
      },
      RANAP_HAPPY_INPUT,
      { replan: true },
    );
    const node = result.state.nodes.process_poli!;
    expect(node.replan?.pass).toBe(3);
    expect(result.events.filter((event) => event.type === 'node.replanning' && event.nodeId === 'process_poli')).toHaveLength(2);

    const dateSync = node.proposedMutations.find((plan) => plan.endpointId === 'poliklinik.updateTgl')!;
    const reset = node.proposedMutations.find((plan) => plan.endpointId === 'poliklinik.batalTransfer')!;
    const transfer = node.proposedMutations.find((plan) => plan.endpointId === 'poliklinik.transferIgd')!;
    expect(dateSync.id).not.toContain(':pass2:');
    expect(reset.id).toContain(':pass2:');
    expect(transfer.id).toContain(':pass3:');

    expect(reset.payload).toEqual({ no_transaksipoli: '01-100001', no_transaksi: '01-100001', kd_unit: 'U05' });
    expect(checksOf(reset)).toEqual(['poliklinik.cekStatusVerifikasi', 'poliklinik.cekStatusTransfer']);
    expect(verificationRulesOf(reset)).toMatchObject([
      {
        endpointId: 'poliklinik.cekStatusTransfer',
        field: '',
        expected: '0',
        match: 'empty',
        payload: { no_transaksi: '01-100001', kd_tindakan: 'P01', urut_tindakan: '1' },
      },
    ]);

    expect(transfer.payload).toMatchObject({
      no_transaksi: '01-100001',
      no_transaksipoli: '03-100001',
      kd_unit_poli: 'U01',
      Kd_DetKelPenjamin: '15',
      biaya: '900000',
      kd_unit: 'U05',
      kd_tindakan: 'P01',
    });
    expect(checksOf(transfer)).toEqual(['poliklinik.cekStatusOrder', 'poliklinik.cekJumlahTransfer']);
    expect(verificationRulesOf(transfer)).toMatchObject([
      {
        endpointId: 'poliklinik.cekStatusTransfer',
        field: '',
        expected: '1',
        match: 'nonEmpty',
        payload: { no_transaksi: '01-100001', kd_tindakan: 'P01', urut_tindakan: '1' },
      },
    ]);

    expect(ranapWorkflow.policies?.mutationAllowlist).toContain('poliklinik.batalTransfer');
    expect(callsFor(transport, 'poliklinik.getListTindakan').length).toBeGreaterThanOrEqual(3);
  });
});

describe('ranap kasir identity', () => {
  it('accepts two of three soft identity fields when the registration is present', async () => {
    // `_has_minimum_kasir_identity` (ranap_v3.py:1304): transaction AND
    // registration, then at least two of medrec/name/address. Requiring all of
    // medrec/name/transaction rejected rows the Python accepts. The composite
    // takes its soft fields from `pendaftaran.getDataKunjungan`.
    const { result } = await runPreview({
      'pendaftaran.getDataKunjungan': json({
        no_medicalrecord: '0-01-23-45',
        alamat: 'JL CONTOH NO 1',
        no_transaksi: '03-100001',
        no_registrasikunjungan: 'REG-0001',
        no_kk: '3305011234567890',
      }),
    });
    expect(result.state.nodes.load_kasir!.status).toBe('success');
  });

  it('rejects an identity with no registration, so alerts cannot be filed under ""', async () => {
    const { result } = await runPreview({
      'kasir.getHistoryKunjungan': json({
        total: 1,
        rows: [
          {
            no_registrasikunjungan: '',
            no_transaksi: '03-100001',
            kd_unit: 'U01',
            nama_unit: 'RUANG ARAFAH KELAS 3',
            nama_pasien: 'PASIEN SATU',
            nama_penjamin: 'BPJS PBI',
            no_sep: '0123456789012345',
            tgl_masuk: '2026-06-10 08:00:00',
            tgl_keluar: '2026-06-12 10:00:00',
            status_bayar: 'Belum',
            kd_kelasperawatan: '4',
            urut_masuk_ruang: '1',
          },
        ],
      }),
      'pendaftaran.getDataKunjungan': json({
        no_medicalrecord: '0-01-23-45',
        nama_pasien: 'PASIEN SATU',
        no_transaksi: '03-100001',
        no_registrasikunjungan: '',
        no_kk: '3305011234567890',
      }),
    });
    expect(result.state.nodes.load_kasir!.status).toBe('failed');
    expect(result.status).toBe('failed'); // load_kasir is critical
  });

  it('builds the identity from the first (anchor) candidate, never a later stay', async () => {
    // Under the composite identity the soft fields all come from
    // `pendaftaran.getDataKunjungan`, which is keyed by medrec and identical for
    // every stay — so the composite can no longer fail for one stay and pass for
    // another, and the newest-first fallback walk of `kasir.getDataTransaksi`
    // (ranap_v3.py:15893-15897) is unreachable. What remains load-bearing is
    // that the identity is taken from the FIRST candidate (the 03- anchor), so
    // every identity field names the right stay.
    const row = (trx: string, reg: string, tglMasuk: string) => ({
      no_registrasikunjungan: reg,
      no_transaksi: trx,
      kd_unit: 'U01',
      nama_unit: 'RUANG ARAFAH KELAS 3',
      nama_pasien: 'PASIEN SATU',
      nama_penjamin: 'BPJS PBI',
      no_sep: '0123456789012345',
      tgl_masuk: tglMasuk,
      tgl_keluar: '2026-06-12 10:00:00',
      status_bayar: 'Belum',
      kd_kelasperawatan: '4',
      urut_masuk_ruang: '1',
    });
    const rows = [
      row('03-100001', 'REG-0001', '2026-06-09 08:00:00'), // the anchor
      row('03-100002', 'REG-0002', '2026-06-08 08:00:00'), // older
      row('03-100003', 'REG-0003', '2026-06-11 08:00:00'), // newer
    ];
    const { result } = await runPreview({
      'kasir.getHistoryKunjungan': json({ total: rows.length, rows }),
      'penatajasaInap.getHistoryKunjunganTab': json({ total: rows.length, rows }),
    });
    // The identity is read from the anchor's registration (the first candidate),
    // and the data block names the anchor's transaction, not a later stay's.
    expect(result.state.nodes.load_kasir!.status).toBe('success');
    expect(logOf(result)).toMatch(/No trx pasien\s+: 03-100001/);
    expect(logOf(result)).not.toContain('Fallback data transaksi awal digunakan');
  });

  it('falls back to the pendaftaran reads for the jenis SEP', async () => {
    // `_resolve_jenis_sep_pasien` (ranap_v3.py:5630) has five inputs; `main()`
    // passes the registration (15944) so the fallbacks are reachable, and logs
    // the source when it is not `kasir` (15971). The composite identity carries
    // no `no_sep` (the kasir SEP is unreadable), so the `getdata_sep_bpjs`
    // branch — keyed on a kasir SEP — is skipped and the fallback is the
    // registration-keyed payer tab. The tab answering no jenis is what forces
    // the fallback at all.
    const { result, transport } = await runPreview({
      'penatajasaInap.getDataKunjunganTab': json({
        kd_detkelpenjamin: '15',
        kd_kelasperawatan: '4',
        kd_kamarperawatan: 'KM01',
        kd_ruangperawatan: 'R01',
        kd_spesialisasi: 'SP1',
        jenis_sep: '',
        kd_instalasi: 'I01',
        kd_unit: 'U01',
      }),
      'pendaftaran.getDataPenjaminTab': json({ no_asuransi: '0001234567890', jns_pelayanan: 'Rawat Inap' }),
    });
    expect(bodyOf(transport, 'pendaftaran.getDataPenjaminTab')).toEqual({
      no_registrasikunjungan: 'REG-0001',
    });
    expect(logOf(result)).toContain('Fallback jenis SEP pasien | source=pendaftaran:getdatapenjamin_tab');
    expect(logOf(result)).toMatch(/Jenis SEP\s+: RITL/);
  });
});

describe('ranap admission-date sync', () => {
  it('proposes the kasir admission-date correction and uses it for the room days', async () => {
    // `_sync_tgl_masuk_awal_rawat_inap` (ranap_v3.py:16186, defined 8894) is a
    // real `kasir.updateTglMasuk` write, and it mutates `first_row["tgl_masuk"]`
    // BEFORE `_build_room_day_assignments` runs, so it changes the room-day
    // result. The newborn is registered the day after birth, so its stay starts
    // on 06-11 while the SEP-anchored episode starts on 06-10.
    const { result } = await runPreview(RANAP_BYNY_HEALTHY_OVERRIDES);
    const node = result.state.nodes.sync_tgl_masuk!;
    expect(node.status).toBe('needs_review');
    const plan = node.proposedMutations[0]!;
    expect(plan.endpointId).toBe('kasir.updateTglMasuk');
    expect(String(plan.payloadSummary.txttglupdate_inap)).toContain(RANAP_BYNY_BIRTH_DATE);
    // `update_tgl_masuk_kasir` (ranap_v3.py:3516) posts six fields, `kd_user`
    // hard-coded and the two tindakan fields present but empty.
    expect(Object.keys(plan.payload ?? {})).toEqual([
      'txttglupdate_inap',
      'no_transaksi',
      'kd_user',
      'kd_tindakan',
      'tgl_jam',
      'no_registrasikunjungan',
    ]);
    expect(plan.payload?.kd_user).toBe('735');
    expect(verificationRulesOf(plan)[0]?.expected).toBe(RANAP_BYNY_BIRTH_DATE);
    // The corrected date is what the assignment is built from.
    const assignments = result.state.nodes.build_rooms!.evidence.find(
      (item) => item.label === 'roomDayAssignments',
    )?.data as Record<string, string[]>;
    expect(assignments['03-100001']![0]).toBe(RANAP_BYNY_BIRTH_DATE);
  });

  it('guards the write on the date the kasir history actually answers (live shape)', async () => {
    // Live 2026-10-15: `kasir.getHistoryKunjungan` answers `tgl_masuk` as a bare
    // date, so a datetime precondition refused the correction every time.
    const { result } = await runPreview(RANAP_BYNY_HEALTHY_OVERRIDES);
    const pre = result.state.nodes.sync_tgl_masuk!.proposedMutations[0]!.preconditions[0]!;
    const stale = String(pre.expected);
    expect(stale).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(evaluateExpectation(pre, { rows: [{ tgl_masuk: stale }] }).holds).toBe(true);
    expect(evaluateExpectation(pre, { rows: [{ tgl_masuk: `${stale} 09:13:01` }] }).holds).toBe(true);
    expect(evaluateExpectation(pre, { rows: [{ tgl_masuk: RANAP_BYNY_BIRTH_DATE }] }).holds).toBe(false);
  });

  it('skips the correction when the stay already starts on the SEP date', async () => {
    const { result } = await runPreview();
    expect(result.state.nodes.sync_tgl_masuk!.status).toBe('skipped');
    expect(plansOf(result).filter((plan) => plan.endpointId === 'kasir.updateTglMasuk')).toHaveLength(0);
  });
});

describe('ranap newborn titipan reason', () => {
  // A newborn with a SEP of its own that really does match, so the class
  // comparison has both sides. `bynyBase` blanks the SEP history to force the
  // waiver path, which leaves no class to compare at all.
  const bynyWithSep = {
    ...RANAP_BYNY_HEALTHY_OVERRIDES,
    'pendaftaran.getRiwayatSep': json([
      {
        no_sep: '0123456789012345',
        tgl_sep: '2026-06-10',
        jns_pelayanan: 'RITL',
        ppk_pelayanan: 'PKU MUHAMMADIYAH GOMBONG',
        kelas_rawat: 'KELAS 3',
      },
    ]),
  };

  it('softens the reason for a healthy newborn', async () => {
    // `_log_pasien_titipan_status` is passed `byny_rme_status_by_reg`
    // (ranap_v3.py:16222-16228). Without it a healthy newborn's room gets the
    // generic `sesuai` reason instead of the one that records *why* it is fine.
    const { result } = await runPreview(bynyWithSep);
    const evaluation = titipanOf(result)[0]!;
    expect(evaluation.result).toBe('NORMAL');
    expect(evaluation.reason).toBe('bayi_sehat_mengikuti_sep_orang_tua');
  });

  it('reports the plain reason when the patient is not a newborn', async () => {
    const { result } = await runPreview();
    expect(titipanOf(result)[0]!.reason).toBe('sesuai');
  });
});

describe('ranap per-registration verification and summary', () => {
  // `main()` verifies and summarises per registration (ranap_v3.py:16753, 16828)
  // and `continue`s past a blocked one (16789-16809). Planning for every
  // registration and emitting a row for every registration reported a
  // verification that never happened.

  // One SEP over two registrations — `_select_kunjungan_payment_candidates`
  // (ranap_v3.py's step 2) only keeps rows in the anchor's own episode, and a
  // shared SEP is what makes two registrations one episode.
  const twoRegRow = (reg: string, trx: string, masuk: string, keluar: string) => ({
    no_registrasikunjungan: reg,
    no_transaksi: trx,
    kd_unit: 'U01',
    nama_unit: 'RUANG ARAFAH KELAS 3',
    nama_pasien: 'PASIEN SATU',
    nama_penjamin: 'BPJS PBI',
    no_sep: '0123456789012345',
    tgl_masuk: masuk,
    tgl_keluar: keluar,
    status_bayar: 'Belum',
    kd_kelasperawatan: '4',
    urut_masuk_ruang: '1',
  });

  it('emits one summary row per verified registration', async () => {
    const { result } = await runApprovedWrite(RANAP_TWO_REG_OVERRIDES);
    expect(result.state.nodes.execute_verifikasi!.proposedMutations).toHaveLength(2);
    expect(summaryRowsOf(result)).toHaveLength(2);
  });

  it('emits nothing in preview, because nothing was verified', async () => {
    // The gate holds in preview, so `emit_summary` is never even reached — and if
    // it were, `if verified` (ranap_v3.py:16828) is false for every registration.
    const { result } = await runPreview(RANAP_TWO_REG_OVERRIDES);
    expect(result.state.nodes.final_gate!.status).toBe('blocked');
    expect(result.state.nodes.emit_summary!.status).toBe('pending');
  });

  it('skips the registration that still has a blocker and keeps the other', async () => {
    const rows = [
      twoRegRow(RANAP_TWO_REG_FIRST_REG, '03-100001', '2026-06-08 08:00:00', '2026-06-09 10:00:00'),
      twoRegRow(RANAP_TWO_REG_SECOND_REG, '03-100002', '2026-06-12 08:00:00', '2026-06-13 10:00:00'),
      {
        // A BANK DARAH transaction on the second registration, dated past the
        // end of the first one's window (`latest group date + 1`,
        // `_collect_named_manual_unit_blockers`), so exactly one registration is
        // blocked.
        no_registrasikunjungan: RANAP_TWO_REG_SECOND_REG,
        no_transaksi: '05-200002',
        kd_unit: 'U09',
        nama_unit: 'BANK DARAH',
        nama_pasien: 'PASIEN SATU',
        nama_penjamin: 'BPJS PBI',
        tgl_masuk: '2026-06-13 09:00:00',
        status_bayar: 'Belum',
      },
    ];
    const { result } = await runApprovedWrite({
      ...RANAP_TWO_REG_OVERRIDES,
      'kasir.getHistoryKunjungan': json({ total: rows.length, rows }),
    });
    // `preverify_summary` blocks only the registration that has the blocker, so
    // the run reaches the gate; the old code ended it at `check_manual_blockers`.
    const node = result.state.nodes.execute_verifikasi!;
    expect(node.status).toBe('needs_review');
    expect(node.proposedMutations).toHaveLength(1);
    expect(node.proposedMutations[0]!.payloadSummary).toMatchObject({
      no_registrasikunjungan: RANAP_TWO_REG_FIRST_REG,
    });
    expect(node.summary).toContain('1 grup dilewati');
    // Only the verified registration gets a summary row, and only it can be
    // staged for payment.
    expect(summaryRowsOf(result)).toHaveLength(1);
    expect(result.state.nodes.tampung_bayar!.proposedMutations).toHaveLength(1);
  });

  it('verifies the balanced registration when only one is unbalanced', async () => {
    // `main()` registers a verification blocker for the unbalanced group and
    // `continue`s (ranap_v3.py:16810-16821); it does not abandon the episode.
    // The rekapitulasi is a GET, so its per-registration parameters are what let
    // the fixture answer differently for each group.
    const { result } = await runApprovedWrite({
      ...RANAP_TWO_REG_OVERRIDES,
      'rekapitulasi.detailHakHtml': (req) => {
        const reg = new URL(req.url).searchParams.get('no_registrasikunjungan');
        const total = reg === RANAP_TWO_REG_FIRST_REG ? '900.000' : '1.000.000';
        return {
          text:
            `<table><tr><td><b>TOTAL BIAYA</b></td><td><b>${total}</b></td></tr>` +
            `<tr><td><b>TOTAL TAGIHAN</b></td><td><b>${total}</b></td></tr></table>`,
        };
      },
    });
    const balance = result.state.nodes.check_balance!;
    expect(balance.status).toBe('needs_review');
    expect(balance.summary).toContain('1/2 grup');
    const node = result.state.nodes.execute_verifikasi!;
    expect(node.proposedMutations).toHaveLength(1);
    expect(node.proposedMutations[0]!.payloadSummary).toMatchObject({
      no_registrasikunjungan: RANAP_TWO_REG_SECOND_REG,
    });
    expect(summaryRowsOf(result)).toHaveLength(1);
  });

  it('keys the penunjang keterangan by registration', async () => {
    // `_get_penunjang_keterangan_for_summary(reg)` is per registration
    // (ranap_v3.py:16843). One run-wide list put registration A's keterangan on
    // registration B's row. The PA order below is dated inside the second
    // registration's window only, which is what
    // `_filter_history_rows_for_date_range` (16204-16208) decides.
    const { result } = await runApprovedWrite({
      ...RANAP_TWO_REG_OVERRIDES,
      'kemoterapi.getHistoryOrderPa': json({
        total: 1,
        rows: [{ no_transaksi: '09-900001', tgl_order: '2026-06-13 08:00:00' }],
      }),
    });
    const rows = summaryRowsOf(result);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.includes('09-900001'))).toHaveLength(1);
    // …and no newborn marker leaks onto a run with no newborn.
    for (const row of rows) expect(row).not.toContain('BAYI SEHAT');
  });

  it('prints each registration its own cashier total in the summary TSV', async () => {
    // Two registrations verified in one run must each carry their own cashier
    // total. A run-wide maximum printed the larger figure on both rows, which
    // is money on the wrong registration's recap line.
    const totals: Record<string, number> = {
      [RANAP_TWO_REG_FIRST_REG]: 1_000_000,
      [RANAP_TWO_REG_SECOND_REG]: 2_000_000,
    };
    const { result } = await runApprovedWrite({
      ...RANAP_TWO_REG_OVERRIDES,
      // The recap is a GET, so its per-registration parameters let the fixture
      // answer differently for each group; the cashier total then has to match
      // its own registration or the critical balance node stops the run.
      'rekapitulasi.detailHakHtml': rekapitulasiForRegs(totals),
      'kasir.getJumlahBayar': jsonResponseForRegs(totals),
    });

    expect(result.state.nodes.check_balance!.status).toBe('success');
    const rows = summaryRowsOf(result);
    expect(rows).toHaveLength(2);
    const totalsOnRows = rows.map((row) => row.split('\t')[4]);
    expect(totalsOnRows.sort()).toEqual(['1000000', '2000000']);
  });

  it('filters each penunjang history to its own registration window', async () => {
    // The same order dated outside both windows produces no candidate at all.
    const { result } = await runApprovedWrite({
      ...RANAP_TWO_REG_OVERRIDES,
      'kemoterapi.getHistoryOrderPa': json({
        total: 1,
        rows: [{ no_transaksi: '09-900001', tgl_order: '2026-05-01 08:00:00' }],
      }),
    });
    expect(result.state.nodes.validate_penunjang!.status).toBe('success');
    expect(summaryRowsOf(result).some((row) => row.includes('09-900001'))).toBe(false);
  });
});

describe('ranap operator log gating', () => {
  it('matches the spec wording operators grep for', async () => {
    const { result } = await runPreview();
    // Log spec line 6 / `_log_payment_candidates` (ranap_v3.py:437).
    expect(logOf(result)).toContain('kunjungan yang bisa di payment:');
  });

  it('shows No trx pasien outside debug and keeps the spec field order', async () => {
    // Log spec line 33 lists `No trx pasien` in the non-debug block and
    // `_log_data_block` passes it with no debug flag (ranap_v3.py:15957); only
    // `No reg` is gated.
    const plain = await runPreview();
    expect(logOf(plain.result)).toContain('No trx pasien');
    expect(logOf(plain.result)).not.toContain('No reg');

    const debug = await runPreview({}, RANAP_DEBUG_INPUT);
    const lines = debug.result.state.logs.map((entry) => entry.message);
    const start = lines.findIndex((line) => /^\s*- No RM\s+:/.test(line));
    const block = lines
      .slice(start, start + 17)
      .map((line) => line.replace(/^\s*-\s*/, '').split(' :')[0]!.trim());
    // The spec interleaves the debug fields; moving them all to the end changed
    // the column order a debug run prints.
    expect(block).toEqual([
      'No RM',
      'Nama pasien',
      'Alamat pasien',
      'Jenis kelamin',
      'Tempat lahir',
      'No trx pasien',
      'Unit pasien',
      'Kd unit pasien',
      'Kd instalasi',
      'Kd kelpenjamin',
      'Kd paramedis',
      'Nama paramedis',
      'Penjamin',
      'No reg',
      'Nama PJ',
      'No SEP',
      'Jenis SEP',
    ]);
  });

  it('explains a balance failure outside debug mode', async () => {
    // Nothing in the spec marks a failure reason debug-only, and
    // `cek_balance_total_tagihan` prints the totals unconditionally when it
    // refuses (ranap_v3.py:8648-8656).
    const { result } = await runPreview({
      'rekapitulasi.detailHakHtml': {
        text:
          '<table><tr><td><b>TOTAL BIAYA</b></td><td><b>900.000</b></td></tr>' +
          '<tr><td><b>TOTAL TAGIHAN</b></td><td><b>900.000</b></td></tr></table>',
      },
    });
    expect(result.state.nodes.check_balance!.status).toBe('blocked');
    const log = logOf(result);
    expect(log).toContain('Belum balance');
    expect(log).toMatch(/Alasan\s+: total_belum_balance/);
  });

  it('reports the normalised date as well as the normalised RM', async () => {
    // ranap_v3.py:15644-15645; only the RM half was ported.
    const { result } = await runPreview({}, { ...RANAP_DEBUG_INPUT, tanggal: '10-06-2026' });
    expect(logOf(result)).toContain('- Tanggal dinormalisasi | input=10-06-2026 | hasil=2026-06-10');
  });
});

describe('ranap wall clock (ctx.clock)', () => {
  it('stamps the injected clock on the admission-date correction', async () => {
    // `_sync_tgl_masuk_awal_rawat_inap` writes `_combine_date_time(target_date,
    // datetime.now().strftime("%H:%M:%S"))` (ranap_v3.py:8913). Carrying the
    // admission's own time-of-day instead was the documented deviation; the
    // clock on `ExecutorContext` removes it.
    const { result } = await runPreview(RANAP_BYNY_HEALTHY_OVERRIDES, RANAP_HAPPY_INPUT, {
      clock: frozenClock(2026, 6, 15, 8, 15, 30),
    });
    const plan = result.state.nodes.sync_tgl_masuk!.proposedMutations[0]!;
    expect(plan.payload?.txttglupdate_inap).toBe(`${RANAP_BYNY_BIRTH_DATE} 08:15:30`);
    // The stay's own `tgl_masuk` is 09:30:00 — proof the time is the clock's,
    // not the row's.
    expect(plan.payload?.txttglupdate_inap).not.toContain('09:30');
  });

  it('stamps the same clock on every re-dating step of one run', async () => {
    const { result } = await runPreview({}, RANAP_HAPPY_INPUT, {
      clock: frozenClock(2026, 6, 15, 8, 15, 30),
    });
    // `process_poli` (`update_tgl_tindakan_poli_igd`) and `sync_tindakan`
    // (`update_tgl_tindakan_inap`) both go through `_build_update_datetime`.
    const poli = planFor(result, 'poliklinik.updateTgl');
    expect(poli.payload?.txtupdatetgl_poli).toBe('2026-06-10 08:15:30');
    const inap = result.state.nodes.sync_tindakan!.proposedMutations.find(
      (plan) => plan.endpointId === 'penatajasaInap.updateTgl',
    )!;
    expect(inap.payload?.txttglupdate_inap).toMatch(/ 08:15:30$/);
  });

  it('produces byte-identical event streams for two runs of the same input', async () => {
    // Determinism is the whole reason `ctx.clock` exists: a run replayed through
    // the reducer has to reproduce itself. Both the executor clock and the bus
    // clock are pinned, and the id factory is the counter one.
    const runOnce = async () => {
      const { client } = clientFor(RANAP_BYNY_HEALTHY_OVERRIDES);
      const runner = new WorkflowRunner(ranapWorkflow, createRanapExecutors({ client }));
      return runner.run({
        mode: 'preview',
        input: RANAP_HAPPY_INPUT,
        runId: 'ranap_determinism',
        clock: frozenClock(2026, 6, 15, 8, 15, 30),
        bus: new EventBus({
          clock: fixedClock('2026-06-15T01:15:30.000Z', 0),
          idFactory: counterIdFactory('evt'),
        }),
      });
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
    // …and the run really did do something worth reproducing.
    expect(first.events.length).toBeGreaterThan(100);
    expect(plansOf(first).length).toBeGreaterThan(0);
  });
});

describe('ranap re-plan passes (parity gaps 1 and 2)', () => {
  it('asks for another pass when an add leaves an unaddressable follow-up', async () => {
    const { result } = await runApprovedWrite(RANAP_VISITE_WRONG_TARIF_OVERRIDES, RANAP_HAPPY_INPUT, {
      replan: false,
    });
    const node = result.state.nodes.sync_visite!;
    // `planVisiteSync` returned `incomplete`: delete + re-add, then two
    // follow-ups the backend has not named yet.
    expect(node.proposedMutations.filter((plan) => plan.payload === undefined)).toHaveLength(2);
    expect(node.replan?.requested).toBe(true);
    expect(node.summary).toContain('minta pass 2/3');
    // The resolver declined, so the engine says so instead of looking finished.
    expect(node.replan?.exhausted).toBe(true);
    expect(result.events.some((event) => event.type === 'node.replan_exhausted')).toBe(true);
  });

  it('re-reads the charge lines and addresses the added row on the second pass', async () => {
    const { result, transport } = await runApprovedWrite(
      ranapVisiteReplanOverrides(),
      RANAP_HAPPY_INPUT,
      { replan: true },
    );
    const node = result.state.nodes.sync_visite!;
    expect(node.replan?.pass).toBe(2);
    // Scoped to this node: `execute_verifikasi` also parks on a write run now,
    // waiting for its verification plans to settle.
    expect(
      result.events.filter(
        (event) => event.type === 'node.replanning' && event.nodeId === 'sync_visite',
      ),
    ).toHaveLength(1);

    // The second pass must have gone back to the backend, not to the map
    // `load_charges` filled — that is `_find_unmatched_updated_rows`'s re-read
    // (ranap_v3.py:4049) expressed as a pass. `load_kasir` reads the same
    // endpoint (without `no_registrasikunjungan`), so count the charge reads.
    const chargeReads = () =>
      bodiesOf(transport, 'penatajasaInap.getListTindakan').filter((body) => body.no_registrasikunjungan);
    expect(chargeReads().length).toBeGreaterThanOrEqual(2);

    const firstPass = node.proposedMutations.filter((plan) => !plan.id.includes(':pass2:'));
    const secondPass = node.proposedMutations.filter((plan) => plan.id.includes(':pass2:'));

    // Pass 1: delete → re-add, then the `updateTgl` and `setPelaksana` the gate
    // refuses because the row they target does not exist yet.
    const stranded = firstPass.filter((plan) => plan.payload === undefined);
    expect(stranded.map((plan) => plan.endpointId)).toEqual([
      'penatajasaInap.updateTgl',
      'poliklinik.tampungPelaksana',
    ]);
    for (const plan of stranded) expect(plan.payloadSummary.urut_tindakan).toBe('');

    // Pass 2: the row exists, so the outstanding follow-up is now an ordinary
    // executable plan addressed by the backend's own `urut_tindakan`. The
    // `updateTgl` is not re-proposed because the add landed on the day the plan
    // asked for — that follow-up is satisfied, not dropped.
    expect(secondPass).toHaveLength(1);
    const pelaksana = secondPass[0]!;
    expect(pelaksana.endpointId).toBe('poliklinik.tampungPelaksana');
    expect(pelaksana.payload?.urut_tindakan).toBe(RANAP_VISITE_REPLAN_NEW_URUT);
    expect(pelaksana.payload?.Kd_ParaMedis).toBe('DR CONTOH SATU');
    expect(pelaksana.payload?.kd_komponen).toBe('29');
    // Nothing is left that the gate would refuse, so the loop converged.
    expect(secondPass.filter((plan) => plan.payload === undefined)).toEqual([]);
    expect(node.replan?.exhausted).toBe(false);

    // A pass-2 plan must never re-use a pass-1 id: the reducer refuses to reseed
    // a known id, so the collision would hand the new plan the old outcome.
    const ids = node.proposedMutations.map((plan) => plan.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The re-planned write is still fully gated.
    expect(checksOf(pelaksana)).toEqual(['penatajasaInap.cekStatusVerifikasi']);
    expect(pelaksana.preconditions[0]!.payload).toMatchObject({
      urut_tindakan: RANAP_VISITE_REPLAN_NEW_URUT,
    });
    expect(pelaksana.requiresApproval).toBe(true);
    const allowlist = ranapWorkflow.policies?.mutationAllowlist ?? [];
    for (const plan of node.proposedMutations) expect(allowlist).toContain(plan.endpointId);
  });

  it('says so plainly when the pass cap is reached with work outstanding', async () => {
    // The backend put the re-added row on a day the stay does not own, so the
    // repair starts over — for ever, if nothing stopped it.
    const { result } = await runApprovedWrite(
      ranapVisiteReplanOverrides('2026-06-09 09:00:00'),
      RANAP_HAPPY_INPUT,
      { replan: true, maxReplanPasses: 2 },
    );
    const node = result.state.nodes.sync_visite!;
    expect(node.replan?.pass).toBe(2);
    expect(node.replan?.exhausted).toBe(true);
    expect(node.summary).toContain('batas re-plan tercapai');
    expect(node.summary).not.toContain('minta pass 3');
    expect(node.warnings.map((item) => item.code)).toContain('replan_exhausted');
    expect(logOf(result)).toContain('batas re-plan tercapai');
    const exhausted = result.events.find((event) => event.type === 'node.replan_exhausted')!;
    expect(exhausted.message).toContain('re-plan cap of 2 pass(es) reached');

    // The pass still did real work: the row pass 1 could not name is addressable
    // now, so its delete carries the backend-assigned `urut_tindakan`.
    const secondPass = node.proposedMutations.filter((plan) => plan.id.includes(':pass2:'));
    const hapus = secondPass.find((plan) => plan.endpointId === 'penatajasaInap.hapusTindakan')!;
    expect(hapus.payload?.urut_tindakan).toBe(RANAP_VISITE_REPLAN_NEW_URUT);
  });

  it('never re-plans in preview, and still sends no mutating endpoint', async () => {
    const { result, transport } = await runPreview(ranapVisiteReplanOverrides());
    expect(mutatingCalls(transport)).toEqual([]);
    // The flag is recorded — the planner really could not finish — but preview
    // applies nothing, so the engine must not grant a pass.
    expect(result.state.nodes.sync_visite!.replan?.requested).toBe(true);
    expect(result.events.some((event) => event.type === 'node.replanning')).toBe(false);
    expect(
      result.events.filter((event) => event.type === 'node.started' && event.nodeId === 'sync_visite'),
    ).toHaveLength(1);
    // One `ambil_listtindakan` per room transaction: no re-read happened.
    // (`load_kasir`'s earlier read of the same endpoint is not a charge read.)
    expect(
      bodiesOf(transport, 'penatajasaInap.getListTindakan').filter((body) => body.no_registrasikunjungan),
    ).toHaveLength(1);
  });
});

describe('ranap emit_summary verification outcomes (parity gap 4)', () => {
  it('emits a row only once the verification plan reached verified', async () => {
    const { result } = await runApprovedWrite();
    const outcome = verificationOutcomesOf(result)[0]!;
    expect(outcome.status).toBe('verified');
    expect(outcome.planId).toBe(planFor(result, 'verifikator.simpanVerifikasi').id);
    expect(summaryRowsOf(result)).toHaveLength(1);
  });

  it('emits nothing while the verification is still only planned', async () => {
    // Nobody approved the plan, so `verifikator.simpanVerifikasi` never fired.
    // The Python emits a row `if verified` (ranap_v3.py:16828); reporting one
    // here would record a bill closure that did not happen.
    const { result } = await runApprovedWrite({}, RANAP_HAPPY_INPUT, { settleMutations: false });
    expect(result.state.nodes.execute_verifikasi!.proposedMutations).toHaveLength(1);
    expect(verificationOutcomesOf(result)[0]?.status).toBe('planned');
    expect(summaryRowsOf(result)).toEqual([]);
    const node = result.state.nodes.emit_summary!;
    expect(node.summary).toContain('1 registrasi belum terverifikasi');
    expect(node.summary).toContain('1 planned');
    expect(logOf(result)).toContain('alasan=verifikasi belum terkonfirmasi');
  });

  it('emits nothing for a registration whose verification only landed unconfirmed', async () => {
    // `applied` means the write went out but the read-after-write rules were
    // never satisfied. That is not "verified", and the summary must not say so.
    const { result } = await runApprovedWrite({}, RANAP_HAPPY_INPUT, { settleTo: 'applied' });
    expect(verificationOutcomesOf(result)[0]?.status).toBe('applied');
    expect(summaryRowsOf(result)).toEqual([]);
    expect(result.state.nodes.emit_summary!.summary).toContain('1 applied');
  });

  it('never reaches the summary in preview — the critical gate holds first', async () => {
    const { result } = await runPreview();
    expect(result.state.nodes.emit_summary!.status).toBe('pending');
  });
});

describe('ranap obat history enrichment (parity gap 3)', () => {
  it('matches a BIAYA OBAT line to the order with the same item/qty signature', async () => {
    const { result, transport } = await runPreview(RANAP_OBAT_DETAIL_OVERRIDES, RANAP_DEBUG_INPUT);
    const node = result.state.nodes.validate_obat_pulang!;
    // Name-only matching produced no pairing at all — neither side carried a
    // signature — so this charge line was always "tanpa order pembanding".
    expect(node.status).toBe('success');
    const log = logOf(result);
    expect(log).toMatch(/Baris biaya obat\s+: 1/);
    expect(log).toMatch(/Cocok dengan order\s+: 1/);
    expect(log).toMatch(/Cocok eksak\s+: 1/);

    // Both detail reads fired, keyed the way the Python keys them.
    expect(queryOf(transport, 'penatajasaInap.getDetailHistoryObat')).toEqual({
      no_order: RANAP_OBAT_MATCH_CORRECT_ORDER,
    });
    expect(queryOf(transport, 'verifikator.getDetailTransaksi')).toEqual({
      no_transaksi: RANAP_OBAT_MATCH_BIAYA_REFERENSI,
      kd_tindakan: '16',
    });
    // One read per order, de-duplicated on `no_order` and memoized for the run.
    const detailReads = callsFor(transport, 'penatajasaInap.getDetailHistoryObat').map(
      (call) => new URL(call.url).searchParams.get('no_order'),
    );
    expect(detailReads).toEqual([RANAP_OBAT_MATCH_CORRECT_ORDER, RANAP_OBAT_MATCH_DECOY_ORDER]);
  });

  it('refuses a clean verdict when an order detail read fails', async () => {
    // A failed detail read leaves an empty signature, which silently degrades
    // every comparison — so it must not read as "0 unmatched".
    const { result } = await runPreview({
      ...RANAP_OBAT_DETAIL_OVERRIDES,
      'penatajasaInap.getDetailHistoryObat': failing(),
    });
    const node = result.state.nodes.validate_obat_pulang!;
    expect(node.status).toBe('needs_review');
    // The failed read is the reason, not the bill: unmatched rows here only mean nothing could be compared.
    expect(node.warnings.map((item) => item.code)).toContain('obat_pulang_unreadable');
    expect(node.summary).toContain('tidak terbaca');
  });

  it('names a BIAYA OBAT line without no_referensi as unverifiable, not a mismatch (live shape)', async () => {
    // Live 2026-10-15: inpatient charge rows carry no `no_referensi`, so the
    // charge-side detail cannot be read and nothing can ever match.
    const { result, transport } = await runPreview({
      ...RANAP_OBAT_DETAIL_OVERRIDES,
      'penatajasaInap.getListTindakan': json({
        total: 1,
        rows: [
          {
            kd_tindakan: '16',
            nama_tindakan: 'BIAYA OBAT',
            harga: '20000',
            qty: '1',
            jumlah: '20000',
            tgl_transaksi: '2026-06-12 09:00:00',
            tgl_jam: '2026-06-12 09:00:00',
          },
        ],
      }),
    });
    const node = result.state.nodes.validate_obat_pulang!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('belum cocok');
    expect(node.warnings[0]?.message).toContain('tanpa no_referensi');
    expect(callsFor(transport, 'verifikator.getDetailTransaksi')).toHaveLength(0);
  });
});

describe('ranap CPPT v2 fallback (parity gap 6)', () => {
  it('reads the v2 timeline and CPPT history when a v2 base URL is configured', async () => {
    const { transport } = await runPreview({}, RANAP_HAPPY_INPUT, {
      deps: { baseUrlV2: 'https://simrs-v2.example.local' },
    });
    // `get_evo_v2_timeline_rows` (ranap_v3.py:3225), then `get_evo_v2_cppt_rows`
    // (3241) keyed by the `single_id` the timeline reports for this reg.
    expect(queryOf(transport, 'ringkasanPasien.loadTglMasuk')).toEqual({
      keyword: '',
      no_medicalrecord: '0-01-23-45',
    });
    expect(queryOf(transport, 'cppt.riwayat')).toEqual({
      Single_id: 'SID-V2-0001',
      No_Reg: 'REG-0001',
      jns_user: '0',
      jabatan: '',
      from: 'ringkasan_pasien',
      filterNoReg: '0',
    });
  });

  it('issues no v2 read at all without one, and plans the same repairs', async () => {
    // `EvoMedisClient` falls back to `baseUrlV1` for a v2 endpoint, so an
    // unconditional read would post to the v1 host on every v1-only run.
    const withoutV2 = await runPreview();
    expect(callsFor(withoutV2.transport, 'ringkasanPasien.loadTglMasuk')).toEqual([]);
    expect(callsFor(withoutV2.transport, 'cppt.riwayat')).toEqual([]);

    // An absent CPPT is "no opinion", never a wrong repair: the v1 note already
    // names the doctor, so both runs plan the same performer.
    const withV2 = await runPreview({}, RANAP_HAPPY_INPUT, {
      deps: { baseUrlV2: 'https://simrs-v2.example.local' },
    });
    const performerOf = (run: Awaited<ReturnType<typeof runPreview>>) =>
      run.result.state.nodes.sync_visite!.proposedMutations.map((plan) => plan.payload?.Kd_ParaMedis);
    expect(performerOf(withV2)).toEqual(performerOf(withoutV2));
  });

  it('skips cleanly when the v2 timeline knows nothing about the registration', async () => {
    const { result, transport } = await runPreview(
      { 'ringkasanPasien.loadTglMasuk': json({ data: [{ no_kunjungan: 'REG-OTHER', single_id: 'X' }] }) },
      RANAP_HAPPY_INPUT,
      { deps: { baseUrlV2: 'https://simrs-v2.example.local' } },
    );
    expect(callsFor(transport, 'cppt.riwayat')).toEqual([]);
    expect(result.state.nodes.sync_visite!.status).toBe('needs_review');
  });
});

/** The `poliklinik.tampungPelaksana` plans one node proposed on a given pass. */
function pelaksanaPlansOf(
  result: Awaited<ReturnType<typeof runPreview>>['result'],
  nodeId: 'sync_tindakan' | 'sync_visite',
  pass: 1 | 2,
) {
  return result.state.nodes[nodeId]!.proposedMutations.filter(
    (plan) =>
      plan.endpointId === 'poliklinik.tampungPelaksana' &&
      plan.id.includes(':pass2:') === (pass === 2),
  );
}

describe('ranap tampung_pelaksana retry ladder (parity gap 1a)', () => {
  it('writes an intermediate performer first when the previous pass did not stick', async () => {
    // `_tampung_pelaksana_checked` (ranap_v3.py:4440-4597): the direct swap came
    // back DATABASE ERROR, so the row is parked on another account
    // (`_pick_intermediate_paramedis_name`, 4328) and only then given the
    // performer it should have had.
    const { result } = await runApprovedWrite(
      ranapVerifiedDuplicateVisiteOverrides(),
      RANAP_HAPPY_INPUT,
      {
        replan: true,
        failPlan: (plan) => plan.endpointId === 'poliklinik.tampungPelaksana',
      },
    );
    const first = pelaksanaPlansOf(result, 'sync_visite', 1);
    // Pass 1 is the ordinary single write, and it now carries the legacy's own
    // read-back so "did not stick" is observable at all.
    expect(first.map((plan) => plan.payload?.Kd_ParaMedis)).toEqual([
      RANAP_VISITE_DESIRED_PELAKSANA,
      RANAP_VISITE_DESIRED_PELAKSANA,
    ]);
    expect(verificationRulesOf(first[0]!).map((rule) => rule.endpointId)).toEqual([
      'penatajasaInap.getDetailKomponenTransaksi',
    ]);
    expect(verificationRulesOf(first[0]!)[0]).toMatchObject({
      field: 'nama_paramedis',
      expected: RANAP_VISITE_DESIRED_PELAKSANA,
      match: 'equals',
    });

    // Pass 2 climbs the ladder: intermediate, then desired, per line and in
    // that order.
    const second = pelaksanaPlansOf(result, 'sync_visite', 2);
    const forKeptRow = second.filter((plan) => plan.payload?.urut_tindakan === '5');
    expect(forKeptRow.map((plan) => plan.payload?.Kd_ParaMedis)).toEqual([
      RANAP_VISITE_INTERMEDIATE_PELAKSANA,
      RANAP_VISITE_DESIRED_PELAKSANA,
    ]);
    // The intermediate write is a real, fully gated plan, not a marker.
    const intermediate = forKeptRow[0]!;
    expect(intermediate.reason).toContain('retry pelaksana sementara');
    expect(String(intermediate.payloadSummary.retry)).toContain('DATABASE ERROR');
    expect(checksOf(intermediate)).toEqual(['penatajasaInap.cekStatusVerifikasi']);
    expect(verificationRulesOf(intermediate)[0]?.expected).toBe(RANAP_VISITE_INTERMEDIATE_PELAKSANA);
    expect(intermediate.requiresApproval).toBe(true);
    const allowlist = ranapWorkflow.policies?.mutationAllowlist ?? [];
    expect(allowlist).toContain(intermediate.endpointId);
    expect(logOf(result)).toContain('Retry pelaksana sementara');
  });

  it('climbs the ladder once per line, as allow_intermediate_retry=False does', async () => {
    const { result } = await runApprovedWrite(
      ranapVerifiedDuplicateVisiteOverrides(),
      RANAP_HAPPY_INPUT,
      {
        replan: true,
        failPlan: (plan) => plan.endpointId === 'poliklinik.tampungPelaksana',
      },
    );
    const second = pelaksanaPlansOf(result, 'sync_visite', 2);
    // Exactly one intermediate per line (ranap_v3.py:4546, 4580 pass
    // `allow_intermediate_retry=False` into both inner calls), never a chain.
    const intermediates = second.filter(
      (plan) => plan.payload?.Kd_ParaMedis === RANAP_VISITE_INTERMEDIATE_PELAKSANA,
    );
    expect(intermediates).toHaveLength(
      new Set(second.map((plan) => plan.payload?.urut_tindakan)).size,
    );
    // No plan id is reused across the ladder or across passes.
    const ids = result.state.nodes.sync_visite!.proposedMutations.map((plan) => plan.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not escalate a write that was never attempted', async () => {
    // `_tampung_pelaksana_checked` returns before the ladder when the write did
    // not happen (`write_allowed` false, ranap_v3.py:4467): parking the row on a
    // throwaway account would clear nothing. Nobody approved anything here, so
    // every plan is still `planned` and the second pass re-proposes the plain
    // write, not the workaround.
    const { result } = await runApprovedWrite(
      ranapVerifiedDuplicateVisiteOverrides(),
      RANAP_HAPPY_INPUT,
      { replan: true, settleMutations: false },
    );
    const second = pelaksanaPlansOf(result, 'sync_visite', 2);
    expect(second.length).toBeGreaterThan(0);
    for (const plan of second) {
      expect(plan.payload?.Kd_ParaMedis).toBe(RANAP_VISITE_DESIRED_PELAKSANA);
      expect(plan.payloadSummary.retry).toBeUndefined();
    }
  });

  it('gives the daily sweep the same read-back, snapped to the dropdown spelling', async () => {
    // `_tampung_pelaksana_checked` resolves the desired name against
    // `ambil_paramedis_pelaksana` before it posts (ranap_v3.py:4460) — the
    // backend matches `Kd_ParaMedis` on the display name — and then re-reads the
    // component. Both halves apply to `sinkronkan_tindakan_harian_inap`, not
    // just to the specialist repair.
    const { result } = await runPreview();
    const plan = result.state.nodes.sync_tindakan!.proposedMutations.find(
      (item) => item.endpointId === 'poliklinik.tampungPelaksana' && item.payload?.Kd_ParaMedis !== '',
    )!;
    expect(plan.payload?.Kd_ParaMedis).toBe('PERAWAT RUANG ARAFAH KELAS 3');
    expect(verificationRulesOf(plan)).toHaveLength(1);
    expect(verificationRulesOf(plan)[0]).toMatchObject({
      endpointId: 'penatajasaInap.getDetailKomponenTransaksi',
      field: 'nama_paramedis',
      expected: 'PERAWAT RUANG ARAFAH KELAS 3',
    });
    // Addressed by the line's own identity, as query params (ranap_v3.py:4232;
    // a form body answers "Database Error" live), not by the plan's write body.
    const rule = verificationRulesOf(plan)[0]!;
    expect(rule.payload).toEqual({});
    expect(Object.keys(rule.query ?? {}).sort()).toEqual(['kd_tindakan', 'no_transaksi', 'tgl_jam', 'urut_tindakan']);
    expect(rule.query!.tgl_jam).toBeTruthy();
  });

  it('reads back a "clear the performer" write on its own component', () => {
    // DPJB and oksigen want the field blank. The component read answers one row
    // per component, so the rule filters on the written kd_komponen.
    const [rule] = pelaksanaReadBackRule({
      noTransaksi: 'T', kdTindakan: '1401', tglJam: '2026-10-13 00:05:10', urutTindakan: '6', kdKomponen: '29', pelaksana: '',
    });
    expect(rule).toMatchObject({ field: 'nama_paramedis', match: 'empty', where: { kd_komponen: '29' }, payload: {} });
  });
});

describe('ranap batal verifikasi before an edit (parity gap 1b)', () => {
  it('proposes an approvable batal_verifikasi instead of refusing the row', async () => {
    // `_ensure_tindakan_belum_terverifikasi` (ranap_v3.py:12286) calls
    // `batal_verifikasi` and edits the row anyway. A planner must not do that
    // silently, so the un-verification becomes a plan of its own.
    const { result, transport } = await runPreview(ranapVerifiedDuplicateVisiteOverrides());
    const plan = planFor(result, 'verifikator.batalVerifikasi');
    expect(plan.riskLevel).toBe('critical');
    expect(plan.requiresApproval).toBe(true);
    expect(plan.payload).toEqual({ no_registrasikunjungan: 'REG-0001' });
    expect(plan.payloadSummary.baris).toBe(1);
    // Guarded on the line still reading as verified (12292) …
    expect(checksOf(plan)).toEqual(['penatajasaInap.cekStatusVerifikasi']);
    expect(plan.preconditions[0]).toMatchObject({
      match: 'nonEmpty',
      payload: {
        no_transaksi: '03-100001',
        kd_tindakan: 'T04',
        urut_tindakan: RANAP_VERIFIED_DUPLICATE_URUT,
      },
    });
    // … and confirmed by the re-read the Python performs afterwards (12303).
    expect(verificationRulesOf(plan)).toHaveLength(1);
    expect(verificationRulesOf(plan)[0]).toMatchObject({
      endpointId: 'penatajasaInap.cekStatusVerifikasi',
      match: 'empty',
      payload: { urut_tindakan: RANAP_VERIFIED_DUPLICATE_URUT },
    });
    expect(ranapWorkflow.policies?.mutationAllowlist).toContain('verifikator.batalVerifikasi');
    // Still a plan: preview sends nothing.
    expect(mutatingCalls(transport)).toEqual([]);
    expect(logOf(result)).toContain('Batal verifikasi sebelum perbaikan tindakan');
  });

  it('plans the delete it unblocks on the next pass', async () => {
    const { result } = await runApprovedWrite(
      ranapVerifiedDuplicateVisiteOverrides(),
      RANAP_HAPPY_INPUT,
      { replan: true },
    );
    const node = result.state.nodes.sync_visite!;
    expect(node.replan?.pass).toBe(2);
    // Pass 1 said why it was asking; pass 2's summary is the one that survives
    // on the node, and by then the reopening has landed.
    expect(logOf(result)).toContain('batal verifikasi harus mendarat');
    // Pass 1 could only refuse the duplicate; pass 2 re-reads it as unverified
    // and deletes it, which is what the Python does inline.
    const firstPass = node.proposedMutations.filter((plan) => !plan.id.includes(':pass2:'));
    expect(firstPass.filter((plan) => plan.endpointId === 'penatajasaInap.hapusTindakan')).toEqual([]);
    const hapus = node.proposedMutations.find(
      (plan) => plan.id.includes(':pass2:') && plan.endpointId === 'penatajasaInap.hapusTindakan',
    );
    expect(hapus, 'the unblocked delete was never planned').toBeDefined();
    expect(hapus!.payload?.urut_tindakan).toBe(RANAP_VERIFIED_DUPLICATE_URUT);
    // One reopening per registration, never one per pass.
    expect(
      node.proposedMutations.filter((plan) => plan.endpointId === 'verifikator.batalVerifikasi'),
    ).toHaveLength(1);
  });

  it('never reopens a bill on the happy path', async () => {
    const { result } = await runPreview();
    expect(
      plansOf(result).filter((plan) => plan.endpointId === 'verifikator.batalVerifikasi'),
    ).toEqual([]);
  });
});

describe('ranap execute_verifikasi waits for its plans (parity gap 2)', () => {
  it('parks until the verification settles, and only then emits the summary row', async () => {
    const { result } = await runApprovedWrite({}, RANAP_HAPPY_INPUT, { replan: true });
    const node = result.state.nodes.execute_verifikasi!;
    // Pass 1 planned and waited; pass 2 read the real outcome back.
    expect(node.replan?.pass).toBe(2);
    expect(node.replan?.exhausted).toBe(false);
    expect(node.status).toBe('success');
    expect(node.summary).toContain('Verifikasi terkonfirmasi untuk 1 grup');
    expect(
      result.events.filter(
        (event) => event.type === 'node.replanning' && event.nodeId === 'execute_verifikasi',
      ),
    ).toHaveLength(1);
    // The row is emitted because the verification really landed and read back —
    // the Python's `if verified` (ranap_v3.py:16828), in the Python's order.
    expect(verificationOutcomesOf(result)[0]?.status).toBe('verified');
    expect(summaryRowsOf(result)).toHaveLength(1);
  });

  it('says it is waiting for approval, and stops there when nobody approves', async () => {
    const { result } = await runApprovedWrite({}, RANAP_HAPPY_INPUT, {
      settleMutations: false,
      replan: false,
    });
    const node = result.state.nodes.execute_verifikasi!;
    expect(node.replan?.requested).toBe(true);
    expect(node.replan?.exhausted).toBe(true);
    expect(node.summary).toContain('menunggu persetujuan operator');
    expect(logOf(result)).toContain('menunggu persetujuan operator');
    expect(node.proposedMutations).toHaveLength(1);
    // Nothing landed, so nothing downstream may claim it did.
    expect(summaryRowsOf(result)).toEqual([]);
    expect(result.state.nodes.tampung_bayar!.summary).toContain('verifikasi belum terkonfirmasi');
  });

  it('reports plainly when the pass cap is reached with the verification unconfirmed', async () => {
    const { result } = await runApprovedWrite({}, RANAP_HAPPY_INPUT, {
      settleMutations: false,
      replan: true,
      maxReplanPasses: 1,
    });
    const node = result.state.nodes.execute_verifikasi!;
    expect(node.summary).toContain('batas re-plan tercapai');
    expect(node.summary).not.toContain('menunggu persetujuan operator');
    expect(node.warnings.map((item) => item.code)).toContain('replan_exhausted');
    const exhausted = result.events.find(
      (event) => event.type === 'node.replan_exhausted' && event.nodeId === 'execute_verifikasi',
    );
    expect(exhausted!.message).toContain('re-plan cap of 1 pass(es) reached');
    expect(summaryRowsOf(result)).toEqual([]);
  });

  it('refuses tampung bayar for a verification that landed but was never confirmed', async () => {
    // `if verified and balanced` (ranap_v3.py:16855). `applied` is a write that
    // went out and was not read back — that is not `verified`.
    const { result } = await runApprovedWrite({}, RANAP_HAPPY_INPUT, {
      settleTo: 'applied',
      replan: true,
    });
    const node = result.state.nodes.tampung_bayar!;
    expect(node.summary).toContain('verifikasi belum terkonfirmasi (status=applied)');
    expect(node.proposedMutations).toEqual([]);
    expect(result.state.nodes.execute_verifikasi!.warnings.map((item) => item.code)).toContain(
      'verifikasi_unconfirmed',
    );
  });

  it('never re-plans execute_verifikasi in preview — the gate holds first', async () => {
    const { result, transport } = await runPreview(ranapVerifiedDuplicateVisiteOverrides());
    expect(mutatingCalls(transport)).toEqual([]);
    expect(result.state.nodes.execute_verifikasi!.status).toBe('pending');
    expect(result.events.some((event) => event.type === 'node.replanning')).toBe(false);
    // The re-plan the verified line asks for is recorded, never granted.
    expect(result.state.nodes.sync_visite!.replan?.requested).toBe(true);
  });
});

describe('ranap CPPT fallback debug log (parity gap 3)', () => {
  it('prints each duplicate candidate CPPT match state in debug mode', async () => {
    // `_log_spesialis_v2_fallback` (ranap_v3.py:11406), printed immediately
    // before `_pick_spesialis_keep_row` ranks the colliding rows.
    const { result } = await runPreview(ranapVerifiedDuplicateVisiteOverrides(), RANAP_DEBUG_INPUT);
    const log = logOf(result);
    expect(log).toContain('- Fallback visite CPPT | reg=REG-0001 | aksi=visite | source=v1');
    expect(log).toContain(`kandidat=${RANAP_VISITE_DESIRED_PELAKSANA}@2026-06-11=ya`);
    expect(log).toContain(' || ');
  });

  it('prints nothing of the sort without the debug switch', async () => {
    const { result } = await runPreview(ranapVerifiedDuplicateVisiteOverrides());
    expect(logOf(result)).not.toContain('Fallback visite CPPT');
  });

  it('changes no decision — the same repairs are planned either way', async () => {
    const plansFor = async (input: unknown) => {
      const { result } = await runPreview(ranapVerifiedDuplicateVisiteOverrides(), input);
      return result.state.nodes.sync_visite!.proposedMutations.map(
        (plan) => `${plan.endpointId}:${plan.payload?.urut_tindakan ?? '-'}`,
      );
    };
    expect(await plansFor(RANAP_DEBUG_INPUT)).toEqual(await plansFor(RANAP_HAPPY_INPUT));
  });
});

describe('ranap SEP history read failure (live shape)', () => {
  it('reports an unreadable BPJS history as unread, not as "no SEP"', async () => {
    const { result } = await runPreview({ 'pendaftaran.getRiwayatSep': failing() });
    const node = result.state.nodes.validate_sep!;
    expect(node.status).toBe('failed');
    expect(node.summary).toContain('tidak terbaca');
    expect(node.summary).not.toContain('Tidak ada SEP');
  });
});

describe('ranap operator reasoning', () => {
  it('explains the eligibility, SEP and balance decisions as checklists', async () => {
    const { result } = await runPreview();
    const of = (id: string) => reasoningOf(result.state.nodes[id]!.evidence);
    for (const id of ['reject_verified', 'reject_paid', 'validate_sep']) {
      expect(of(id)?.items.length, id).toBeGreaterThan(0);
    }
    expect(of('reject_verified')!.items.every((item) => item.ok === true)).toBe(true);
    expect(of('validate_sep')!.items.map((item) => item.label)).toEqual(
      expect.arrayContaining(['No kartu BPJS', 'SEP RITL ditemukan']),
    );
    const balance = of('check_balance');
    if (balance) expect(balance.items[0]!.label).toMatch(/Total kasir = total rekapitulasi/);
  });
});

describe('ranap checklist coverage', () => {
  it('every step that ran explains itself with a checklist', async () => {
    const { result } = await runPreview();
    // Gates are resolved by the runner (approve/reject is their own record), not by an executor result.
    const gates = new Set(ranapWorkflow.nodes.filter((node) => node.kind === 'gate').map((node) => node.id));
    const missing = Object.values(result.state.nodes)
      .filter((node) => !gates.has(node.id))
      .filter((node) => ['success', 'failed', 'blocked', 'needs_review'].includes(node.status))
      .filter((node) => !reasoningOf(node.evidence)?.items.length)
      .map((node) => node.id);
    expect(missing).toEqual([]);
  });
});
