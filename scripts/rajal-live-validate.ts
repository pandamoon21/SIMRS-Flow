/**
 * Live read-only rawat jalan validation across poli.
 *
 * Authorized by the operator to use their local EvoMedis account to pull REAL
 * data and exercise the rajal pipeline end to end — strictly READ ONLY. The
 * client runs in `preview` mode, so every mutating endpoint
 * (verifikator.simpanVerifikasi, kasir.tampungBayar, rekamMedis.simpanSep) is
 * blocked at the client by safety control #1 (`MutationBlockedInPreviewError`)
 * before a single byte hits the network. Nothing is ever written, approved, or
 * staged: the run surfaces mutations as plans and stops there.
 *
 * Credentials are passed on the command line and held in memory only — never
 * written to disk, never echoed back in full (output redacts the cookie and
 * any medrec-shaped id).
 *
 *   node --import tsx scripts/rajal-live-validate.ts <user> <pass> [from] [to] [maxPerPoli] [clinicFilter]
 *
 * `clinicFilter` (case-insensitive substring, e.g. SYARAF) narrows stages C and D
 * to one poli so a pilot run does not walk every clinic.
 *
 * Default period is today; default per-poli patient cap is 1 (pilot scope).
 */
import { EvoMedisClient, FetchTransport } from '@simrs-flow/evomedis-client';
import { WorkflowRunner } from '@simrs-flow/workflow-core';
import type { RunState } from '@simrs-flow/workflow-core';
import {
  createRajalExecutors,
  rajalWorkflow,
  type RajalInput,
} from '@simrs-flow/domain-rajal';
import {
  RAJAL_CLINIC_MAPPING,
  extractRajalClinicFromSection,
  normalizeClinicLabel,
  shouldExcludeRajalSection,
  buildRajalUnpaidReportQuery,
  parseRajalUnpaidReport,
  resolveRajalClinicMatch,
} from '@simrs-flow/domain-rajal';

const BASE = process.env.EVOMEDIS_BASE_URL ?? (() => { throw new Error('Set EVOMEDIS_BASE_URL (see .env.example)'); })();

function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/** Redact medrec-shaped ids and the session cookie from anything we print. */
function redact(value: unknown): string {
  return String(value)
    .replace(/ci_session=[^;\s]+/gi, 'ci_session=[redacted]')
    .replace(/\b\d-\d{2}-\d{2}-\d{2}\b/g, '[medrec]')
    .replace(/\b\d{6,}\b/g, '[id]');
}

function makeClient(): EvoMedisClient {
  return new EvoMedisClient(
    { baseUrlV1: BASE },
    { mode: 'preview', transport: new FetchTransport() },
  );
}

async function main(): Promise<void> {
  const [, , user, pass, fromArg, toArg, capArg, clinicArg] = process.argv;
  if (!user || !pass) {
    console.error('usage: node --import tsx scripts/rajal-live-validate.ts <user> <pass> [from] [to] [maxPerPoli] [clinicFilter]');
    process.exitCode = 2;
    return;
  }
  const from = fromArg ?? todayIso();
  const to = toArg ?? from;
  const maxPerPoli = Math.max(1, Number.parseInt(capArg ?? '1', 10) || 1);
  const clinicFilter = clinicArg?.trim().toUpperCase() ?? '';
  const wanted = (clinic: string) => !clinicFilter || clinic.toUpperCase().includes(clinicFilter);

  // ── Login (read-only client) ──────────────────────────────────────────
  const client = makeClient();
  console.log(`INFO: logging in to ${BASE} as ${user} …`);
  try {
    await client.login(user, pass);
  } catch (err) {
    console.error(`FAIL: login — ${redact(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS: EvoMedis login succeeded (cookie hidden)');

  // ── 1. Discover the live unpaid-bill report → real poli sections ──────
  console.log(`\n=== A. Live unpaid-bill report ${from} → ${to} (instalasi Rawat Jalan) ===`);
  const query = buildRajalUnpaidReportQuery({ instalasi: '1', from, to });
  const html = await client.postText('laporanBelumBayar.preview', {}, { query });
  const report = parseRajalUnpaidReport(html, {});
  if (!report.readable) {
    console.error('FAIL: report unreadable — no report table in the reply');
    process.exitCode = 1;
    return;
  }
  console.log(`report: ${report.stats.total} unpaid row(s) across ${report.sections.length} section(s)`);

  // Live poli sections (exclude penunjang/pharmacy groupings) → clinic chips.
  const liveSections = report.sections.filter((s) => !shouldExcludeRajalSection(s));
  const liveClinics = [...new Set(liveSections.map(extractRajalClinicFromSection).filter(Boolean))];
  console.log(`live poli section(s): ${liveSections.length ? liveSections.join(' | ') : '(none)'}`);

  // ── 2. Dropdown sync check — live sections vs the deduped dropdown ────
  // Mirror RunInputForm's LEGACY_CLINICS: one chip per distinct (normalized)
  // clinic, so the two "POLI DALAM, GINJAL…"/"DALAM, GINJAL…" aliases collapse.
  console.log('\n=== B. Poli dropdown sync (live sections vs deduped dropdown) ===');
  const mappingKeys = new Set(
    [...new Map(
      Object.keys(RAJAL_CLINIC_MAPPING).map((k) => [normalizeClinicLabel(k), k] as const),
    ).values()],
  );
  const unmatched: string[] = [];
  for (const clinic of liveClinics) {
    // Does this live clinic resolve against the dropdown's own option list?
    const match = resolveRajalClinicMatch(clinic, [...mappingKeys]);
    const status = match.ambiguous ? 'AMBIGUOUS' : match.matchedClinic ? `ok→${match.matchedClinic}` : 'NO-MATCH';
    if (!match.matchedClinic) unmatched.push(clinic);
    console.log(`  ${status.padEnd(22)} ${clinic}`);
  }
  // Dropdown entries that never appear live (stale options) for this period.
  const stale = [...mappingKeys].filter(
    (key) => !liveClinics.some((clinic) => resolveRajalClinicMatch(clinic, [key]).matchedClinic),
  );
  console.log(`unmatched live clinic(s): ${unmatched.length ? unmatched.join(' | ') : 'none'}`);
  console.log(`dropdown option(s) not seen live this period: ${stale.length ? stale.join(' | ') : 'none'}`);

  // ── 3. Per-poli read-only pipeline validation ─────────────────────────
  console.log('\n=== C. Read-only rajal pipeline per poli (preview; mutations blocked) ===');
  // Group matched report rows by their clinic so we can build a typed list per poli.
  const byClinic = new Map<string, { patientIds: Set<string>; date: string }>();
  for (const row of report.patients) {
    if (!row.section || shouldExcludeRajalSection(row.section)) continue;
    const clinic = extractRajalClinicFromSection(row.section);
    const rm = row.noRM.trim();
    if (!clinic || !rm || !wanted(clinic)) continue;
    const bucket = byClinic.get(clinic) ?? { patientIds: new Set<string>(), date: from };
    if (bucket.patientIds.size < maxPerPoli) bucket.patientIds.add(rm);
    byClinic.set(clinic, bucket);
  }
  if (byClinic.size === 0) {
    console.log('no billable poli rows in this period — widen the date range to validate more poli');
  }

  let validated = 0;
  for (const [clinic, bucket] of byClinic) {
    const patientIds = [...bucket.patientIds];
    const input: RajalInput = {
      patientIds,
      clinics: [clinic],
      date: bucket.date,
      dateFrom: from,
      dateTo: to,
    };
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    let state: RunState;
    try {
      const result = await runner.run({
        mode: 'preview',
        input,
        runId: `live-validate-${clinic.replace(/\W+/g, '_')}`,
      });
      state = result.state;
    } catch (err) {
      console.log(`  ✗ ${clinic}: runner threw — ${redact(err instanceof Error ? err.message : String(err))}`);
      continue;
    }
    validated += 1;
    // Summarise each node's terminal status; a write would have thrown #1.
    const nodes = Object.values(state.nodes)
      .map((n) => `${n.id}:${n.status}${n.status === 'needs_review' || n.status === 'blocked' || n.status === 'failed' ? `(${redact(n.summary).slice(0, 90)})` : ''}`)
      .join(' ');
    const planned = Object.values(state.nodes).reduce((acc, n) => acc + n.proposedMutations.length, 0);
    console.log(`  ✓ ${clinic} [${patientIds.length} pasien] run=${state.status} plans=${planned}`);
    console.log(`      ${nodes}`);
  }

  console.log(`\nRESULT: validated ${validated}/${byClinic.size} poli read-only; no mutation was sent (preview blocks writes).`);
  console.log('NOTE: poli with no unpaid rows in this period cannot be validated from the report — widen the range or supply explicit medrecs.');

  // ── 4. Discovery-mode read-only validation ────────────────────────────
  // The typed-list runs above never exercise `resolve_clinics` narrowing: the
  // operator's chip is a mapping alias (`DALAM`, `ANAK`) while the report
  // section is its long form, and the narrowing is what decides whether the
  // batch survives. One discovery run with the pilot cap closes that gap, and a
  // populated non-billable result is the signal that narrowing dropped a poli.
  console.log('\n=== D. Read-only rajal discovery (auto-fetch, max 1 pasien) ===');
  const discoveryClinic = liveClinics.find(wanted);
  if (!discoveryClinic) {
    console.log(`skipped: no live poli section${clinicFilter ? ` matching ${clinicFilter}` : ''} in this period`);
  } else {
    const chip = discoveryClinic;
    const discoveryRunner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const discoveryInput: RajalInput = {
      clinics: [chip],
      date: from,
      discovery: { instalasi: '1', from, to, maxPatients: 1 },
    };
    try {
      const result = await discoveryRunner.run({
        mode: 'preview',
        input: discoveryInput,
        runId: 'live-validate-discovery',
      });
      const nodes = Object.values(result.state.nodes)
        .filter((n) => ['normalize_ids', 'resolve_clinics', 'start_batch', 'filter_records', 'submit_payment'].includes(n.id))
        .map((n) => `${n.id}:${n.status}(${redact(n.summary).slice(0, 90)})`)
        .join(' ');
      const plans = result.state.nodes.submit_payment?.proposedMutations.length ?? 0;
      console.log(`  chip="${chip}" run=${result.state.status} plans=${plans}`);
      console.log(`      ${nodes}`);
      console.log('  NOTE: plans>0 here means discovery narrowed to a billable record; plans=0 with start_batch:success means the chip matched no discovered patient.');
    } catch (err) {
      console.log(`  ✗ discovery: runner threw — ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }
}

void main().catch((err: unknown) => {
  console.error(`FAIL: ${redact(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
});
