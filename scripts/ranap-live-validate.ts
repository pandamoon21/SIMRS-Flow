/**
 * Live read-only rawat inap validation: does the ranap pipeline get past the
 * kasir identity step now that the dead kasir.getDataTransaksi read is replaced
 * by a composite? Runs in preview — the client blocks every mutating endpoint,
 * so nothing is ever written, verified, or staged.
 *
 *   node --import tsx scripts/ranap-live-validate.ts <user> <pass> [noRm] [tanggal]
 *
 * Without a medrec, the first unverified, unpaid BPJS patient discharged on
 * `tanggal` (default today) is picked.
 */
import { EvoMedisClient, FetchTransport } from '@simrs-flow/evomedis-client';
import { WorkflowRunner } from '@simrs-flow/workflow-core';
import { buildRanapDischargeQuery, createRanapExecutors, parseRanapDischargeReport, ranapWorkflow, type RanapInput } from '@simrs-flow/domain-ranap';

const BASE = process.env.EVOMEDIS_BASE_URL ?? (() => { throw new Error('Set EVOMEDIS_BASE_URL (see .env.example)'); })();
const [, , user, pass, mrArg, tanggalArg] = process.argv;

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

const client = new EvoMedisClient({ baseUrlV1: BASE }, { mode: 'preview', transport: new FetchTransport() });
await client.login(user!, pass!);
console.log('logged in');

/** Medrec-shaped ids must never reach a terminal or a tee'd file. */
function mask(text: string): string {
  return text.replace(/\d-\d{2}-\d{2}-\d{2}/g, '#-##-##-##');
}

/** History rows are external data: only the two fields read here are trusted. */
interface HistoryRow { no_transaksi?: unknown; tgl_masuk?: unknown }

async function historyRows(medrec: string): Promise<HistoryRow[]> {
  const res = await client
    .postJson<{ rows?: HistoryRow[] }>('penatajasaInap.getHistoryKunjunganTab', {
      nomedrec: medrec,
      cmbunithistory_inap: '',
      dttglmasuk1_inap: '',
      dttglmasuk2_inap: '',
      page: '1',
      rows: '200',
    })
    .catch(() => ({ rows: [] as HistoryRow[] }));
  return Array.isArray(res.rows) ? res.rows : [];
}

async function latestInpatientDate(medrec: string): Promise<string | undefined> {
  const dates = (await historyRows(medrec))
    .filter((row) => Boolean(row.no_transaksi))
    .map((row) => String(row.tgl_masuk ?? '').slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  return dates.at(-1);
}

// Discover an inpatient medrec if not supplied.
let noRm = mrArg;
let tanggal = tanggalArg ?? '';
// A supplied medrec without a date cannot default to today: the pilot stays are
// historical, so the anchor date has to come from the stay itself.
if (noRm && !tanggalArg) {
  const derived = await latestInpatientDate(noRm);
  if (!derived) { console.log(`no inpatient visit for medrec ${mask(noRm)}`); process.exit(1); }
  tanggal = derived;
  console.log(`tanggal auto: ${derived} (latest stay for this medrec)`);
}
tanggal ||= today();
if (!noRm) {
  // Test only finished stays: a patient still on the ward has open charges
  // (drugs, depot orders) by definition, so its blockers say nothing about the
  // pipeline. The workflow itself does not require discharge — only this
  // harness's pick does. `tanggal` is the discharge day here; the run anchors on
  // the stay's tgl masuk, which is the SEP RITL date.
  const html = await client.postText('laporanKeluarRanap.preview', {}, {
    query: buildRanapDischargeQuery({ keluarFrom: tanggal, keluarTo: tanggal, verifikasi: '0', bayar: '0', kelPenjamin: '2' }),
  });
  const pick = parseRanapDischargeReport(html).rows.find((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.tglMasuk));
  if (pick) { noRm = pick.noRm; tanggal = pick.tglMasuk; console.log(`discharged ${pick.tglKeluar}, masuk ${pick.tglMasuk}`); }
}
if (!noRm) { console.log('no inpatient medrec found'); process.exit(1); }
console.log(`medrec=${mask(noRm)} tanggal=${tanggal}`);

const input: RanapInput = { noRm, patientIds: [noRm], tanggal, toleranceDays: 3, debugMode: false, skipVerifikasiSep: false, enableTampungBayar: false };
const runner = new WorkflowRunner(ranapWorkflow, createRanapExecutors({ client }));
const result = await runner.run({ mode: 'preview', input, runId: `ranap-live-${Date.now()}` });

console.log(`\nrun status: ${result.state.status}\n`);
for (const node of Object.values(result.state.nodes)) {
  if (node.status === 'pending') continue;
  const summary = node.summary ? ` — ${String(node.summary).slice(0, 110)}` : '';
  console.log(`${node.id.padEnd(26)} ${node.status}${mask(summary)}`);
  if (!['blocked', 'failed', 'needs_review'].includes(node.status)) continue;
  for (const issue of [...node.issues, ...node.warnings].slice(0, 3)) {
    console.log(`   [${issue.code}] ${mask(String(issue.message)).slice(0, 160)}`);
  }
}
const plans = Object.values(result.state.nodes).reduce((a, n) => a + n.proposedMutations.length, 0);
console.log(`\nplanned mutations: ${plans} (dry-run; none applied)`);
