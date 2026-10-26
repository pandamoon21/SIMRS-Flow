/**
 * Controlled one-patient live write pilot.
 *
 * Safety: prompts for EvoMedis credentials locally, keeps them in memory only,
 * runs live preview first, then applies eligible non-final, non-critical
 * mutations through RunService.approveMutation(). Never approves final_gate,
 * verifikasi, or tampung bayar.
 *
 * Run: node --import tsx scripts/pilot-live-write.ts [--domain ranap|rajal] [--clinic <poli>]
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { promisify } from 'node:util';

import { FileLedger } from '@simrs-flow/audit-ledger';
import { createRanapExecutors, ranapWorkflow, type RanapInput } from '@simrs-flow/domain-ranap';
import { createRajalExecutors, rajalWorkflow, type RajalInput } from '@simrs-flow/domain-rajal';
import {
  EvoMedisClient,
  FetchTransport,
  getEndpoint,
  isMutating,
  type CallRecord,
} from '@simrs-flow/evomedis-client';
import {
  isTerminalStatus,
  verificationRulesOf,
  type MutationPlan,
  type RunState,
  type ExecutorRegistry,
  type WorkflowDefinition,
  type WorkflowEvent,
} from '@simrs-flow/workflow-core';
import { RunService } from '../apps/orchestrator/src/RunService.js';
import { UserSessionStore } from '../apps/orchestrator/src/sessions.js';
import type { ExecutorFactoryArgs, WorkflowEntry } from '../apps/orchestrator/src/registry.js';

const execFileAsync = promisify(execFile);
const DEFAULT_BASE = 'https://simrs.invalid/offline/index.php';

const FORBIDDEN_MUTATIONS = new Set([
  'verifikator.simpanVerifikasi',
  'verifikator.batalVerifikasi',
  'kasir.tampungBayar',
]);

type PilotDomain = 'ranap' | 'rajal';

/**
 * One entry per domain. `enabled` switches off every final step — verification
 * and payment never run in the pilot — and `safeMutations` is what the
 * operator's PILOT_MUTATION_ALLOWLIST may name: mutate, non-critical, and not
 * one of FORBIDDEN_MUTATIONS.
 */
interface PilotDomainEntry {
  workflow: WorkflowDefinition;
  createExecutors: (args: { client: EvoMedisClient; baseUrlV2?: string }) => ExecutorRegistry;
  enabled: Record<string, boolean>;
  input: (patient: string, date: string, clinic: string | undefined) => RanapInput | RajalInput;
}

function safeMutationsOf(workflow: WorkflowDefinition): Set<string> {
  return new Set(
    (workflow.policies?.mutationAllowlist ?? []).filter((endpointId) => {
      const endpoint = getEndpoint(endpointId);
      return endpoint?.kind === 'mutate' && endpoint.riskLevel !== 'critical' && !FORBIDDEN_MUTATIONS.has(endpointId);
    }),
  );
}

const DOMAINS: Record<PilotDomain, PilotDomainEntry> = {
  ranap: {
    workflow: ranapWorkflow,
    createExecutors: (args) => createRanapExecutors(args),
    enabled: { final_gate: false, execute_verifikasi: false, tampung_bayar: false },
    input: (patient, date) => ranapInput(patient, date),
  },
  rajal: {
    workflow: rajalWorkflow,
    createExecutors: (args) => createRajalExecutors(args),
    enabled: { submit_payment: false },
    input: (patient, date, clinic) => ({ patientIds: [patient], clinics: [clinic ?? ''], date, dateFrom: date, dateTo: date }),
  },
};

let pilotDomain: PilotDomain = 'ranap';
let pilotClinic: string | undefined;
let pilotMutationAllowlist: string[] = [];
const pilotEntry = () => DOMAINS[pilotDomain];

function pilotWorkflow(): WorkflowDefinition {
  return { ...pilotEntry().workflow, policies: { ...(pilotEntry().workflow.policies ?? {}), mutationAllowlist: pilotMutationAllowlist } };
}

const WRITE_TIMEOUT_MS = 5 * 60_000;
const PREVIEW_TIMEOUT_MS = 3 * 60_000;

interface Args {
  help: boolean;
  selfCheck: boolean;
  domain: PilotDomain;
  clinic?: string;
  patients: string[];
  dates: string[];
  authorizedPatients: string[];
}

interface PilotCall {
  phase: string;
  endpointId: string;
  status: number;
  ok: boolean;
}

interface Candidate {
  patient: string;
  label: string;
  date: string;
  previewRunId: string;
  plans: MutationPlan[];
}

interface Proof {
  runId: string;
  planId: string;
  endpointId: string;
  status: 'verified';
  auditFile: string;
}

function loadSafeDotEnv(): void {
  const path = resolve('.env');
  if (!existsSync(path)) return;
  const allowed = new Set([
    'EVOMEDIS_BASE_URL',
    'EVOMEDIS_BASE_URL_V2',
    'EVOMEDIS_SESSION_COOKIE_NAME',
    'AUDIT_LEDGER_DIR',
    'PILOT_DATE',
    'PILOT_PATIENT',
    'PILOT_PATIENT_ALLOWLIST',
    'PILOT_MUTATION_ALLOWLIST',
    'PILOT_USERNAME',
    'PILOT_LEDGER_DIR',
  ]);
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!allowed.has(key) || process.env[key]) continue;
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

function parseArgs(argv: string[]): Args {
  const patients: string[] = [];
  const dates: string[] = [];
  let help = false;
  let selfCheck = false;
  let domain: PilotDomain = 'ranap';
  let clinic: string | undefined;

  const passwordFlags = new Set(['--password', '--pass', '--pwd']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (passwordFlags.has(arg)) throw new Error(`${arg} is not supported; use masked prompt or local clipboard instead`);
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--self-check') selfCheck = true;
    else if (arg === '--patient') patients.push(requireValue(argv, ++i, '--patient'));
    else if (arg === '--date') dates.push(...splitList(requireValue(argv, ++i, '--date')));
    else if (arg === '--domain') {
      const value = requireValue(argv, ++i, '--domain');
      if (value !== 'ranap' && value !== 'rajal') throw new Error('--domain must be ranap or rajal');
      domain = value;
    } else if (arg === '--clinic') clinic = requireValue(argv, ++i, '--clinic').trim();
    else throw new Error('Unknown argument; run --help for usage');
  }

  if (help || selfCheck) return { help, selfCheck, domain, ...(clinic ? { clinic } : {}), patients: [], dates: [], authorizedPatients: [] };
  if (domain === 'rajal' && !clinic) throw new Error('--clinic is required for rajal');

  if (process.env.PILOT_PATIENT) patients.push(process.env.PILOT_PATIENT);
  if (process.env.PILOT_DATE) dates.push(...splitList(process.env.PILOT_DATE));

  const authorizedPatients = loadAuthorizedPatients();
  if (authorizedPatients.length === 0) {
    throw new Error('PILOT_PATIENT_ALLOWLIST is required for live pilot scope validation');
  }
  const authorized = new Set(authorizedPatients);

  const selectedPatients = patients.length > 0 ? [...new Set(patients)] : authorizedPatients;
  if (selectedPatients.length !== 1) {
    throw new Error('Live pilot requires exactly one selected patient; set --patient or PILOT_PATIENT to one authorized entry');
  }
  for (const patient of selectedPatients) {
    if (!authorized.has(patient)) throw new Error(`Patient is outside the authorized pilot list: ${redactText(patient)}`);
  }

  const selectedDates = dates.length > 0 ? [...new Set(dates)] : recentDates(5);
  for (const date of selectedDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Date must be YYYY-MM-DD: ${date}`);
  }

  return { help, selfCheck, domain, ...(clinic ? { clinic } : {}), patients: selectedPatients, dates: selectedDates, authorizedPatients };
}

function loadAuthorizedPatients(): string[] {
  const raw = process.env.PILOT_PATIENT_ALLOWLIST?.trim();
  if (!raw) return [];
  const patients = [...new Set(splitList(raw))];
  for (const patient of patients) {
    if (!/^\d-\d{2}-\d{2}-\d{2}$/.test(patient)) {
      throw new Error(`Authorized patient entry has unexpected format: ${redactText(patient)}`);
    }
  }
  return patients;
}

function splitList(value: string): string[] {
  return value.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
}

function loadPilotMutationAllowlist(): string[] {
  const raw = process.env.PILOT_MUTATION_ALLOWLIST?.trim();
  if (!raw) throw new Error('PILOT_MUTATION_ALLOWLIST is required for the live pilot gate allowlist');
  return validatePilotMutationAllowlist(splitList(raw));
}

function validatePilotMutationAllowlist(values: readonly string[]): string[] {
  const allowlist = [...new Set(values)];
  if (allowlist.length === 0) throw new Error('PILOT_MUTATION_ALLOWLIST must name at least one endpoint');
  for (const endpointId of allowlist) {
    const endpoint = getEndpoint(endpointId);
    if (!endpoint || endpoint.kind !== 'mutate') throw new Error(`pilot mutation allowlist contains unknown/non-mutate endpoint ${endpointId}`);
    if (!safeMutationsOf(pilotEntry().workflow).has(endpointId)) throw new Error(`pilot mutation allowlist contains forbidden, critical, or out-of-domain endpoint ${endpointId}`);
  }
  return allowlist;
}

function configurePilotMutationAllowlist(allowlist: readonly string[]): void {
  pilotMutationAllowlist = [...allowlist];
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function recentDates(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    out.push(formatLocalDate(d));
  }
  return out;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function usage(): string {
  return [
    'Usage: node --import tsx scripts/pilot-live-write.ts [--domain ranap|rajal] [--clinic <poli>] [--patient <authorized-medrec>] [--date YYYY-MM-DD[,YYYY-MM-DD]]',
    '',
    'Set PILOT_PATIENT_ALLOWLIST and PILOT_MUTATION_ALLOWLIST in the local shell/.env first (comma-separated).',
    'Use only non-final/non-critical mutation endpoints in PILOT_MUTATION_ALLOWLIST, for example kasir.updateTglMasuk.',
    'Credentials are prompted locally and kept in memory only.',
    'No TTY fallback: set PILOT_USERNAME, copy the password locally to the Windows clipboard, then run the script.',
    'The script applies one eligible verified non-final, non-critical mutation, stops before final verification/payment, then cancels the run.',
    'Rajal needs --clinic (e.g. SYARAF); its only non-final endpoint is rekamMedis.simpanSep.',
    'Self-check only: node --import tsx scripts/pilot-live-write.ts --self-check',
  ].join('\n');
}

async function promptLine(label: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

async function promptPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Masked password prompt requires a TTY. Run it from the Claude prompt with: ! node --import tsx scripts/pilot-live-write.ts');
  }

  return new Promise((resolvePassword, reject) => {
    let value = '';
    const finish = (err?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      else resolvePassword(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (code === 3) {
          finish(new Error('Credential prompt cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          finish();
          return;
        }
        if (code === 127 || code === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function readCredentials(): Promise<{ username: string; password: string }> {
  assertNoPasswordEnv();
  const hasTty = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
  let username = (process.env.PILOT_USERNAME ?? '').trim();
  if (!username && !hasTty) throw new Error('PILOT_USERNAME is required when masked prompt TTY is unavailable');
  username ||= await promptLine('EvoMedis username: ');
  const password = hasTty
    ? await promptPassword('EvoMedis password: ')
    : await readPasswordFromClipboard(readAndClearWindowsClipboard);
  return { username, password };
}

const FORBIDDEN_PASSWORD_ENV = [
  'EVO_PASS',
  'PILOT_PASSWORD',
  'PILOT_PASS',
  'EVOMEDIS_PASSWORD',
  'EVOMEDIS_PASS',
];

function assertNoPasswordEnv(): void {
  for (const name of FORBIDDEN_PASSWORD_ENV) {
    if (process.env[name]) throw new Error(`${name} must not be set; use masked prompt or local clipboard instead`);
  }
}

async function readPasswordFromClipboard(readAndClear: () => Promise<string>): Promise<string> {
  const password = validateClipboardPassword(await readAndClear());
  console.log('INFO: EvoMedis password read from clipboard and clipboard cleared');
  return password;
}

function validateClipboardPassword(value: string): string {
  const password = value.replace(/\r?\n$/, '');
  if (!password) throw new Error('Clipboard password mode found an empty clipboard');
  if (/\r|\n/.test(password)) throw new Error('Clipboard password mode requires a single-line password');
  if (password.length > 256) throw new Error('Clipboard password mode found an unexpectedly long password');
  return password;
}

async function readAndClearWindowsClipboard(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Clipboard password mode is Windows-only');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Sta',
    '-Command',
    '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Windows.Forms; $p = Get-Clipboard -Raw; [System.Windows.Forms.Clipboard]::Clear(); [Console]::Out.Write($p)',
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout;
}

function redactText(value: unknown): string {
  return String(value)
    .replace(/ci_session=[^;\s]+/gi, 'ci_session=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b\d-\d{2}-\d{2}-\d{2}\b/g, '[medrec]')
    .replace(/\b\d{6,}\b/g, '[id]');
}

function patientLabel(patient: string, authorizedPatients: readonly string[]): string {
  const index = authorizedPatients.indexOf(patient);
  return `[medrec#${index >= 0 ? index + 1 : 'authorized'}]`;
}

function ranapInput(patient: string, date: string): RanapInput {
  return {
    noRm: patient,
    patientIds: [patient],
    tanggal: date,
    debugMode: false,
    enableTampungBayar: false,
  };
}

function pilotAllowlist(input?: readonly string[]): string[] {
  const allowed = new Set(input ?? pilotMutationAllowlist);
  return pilotMutationAllowlist.filter((endpointId) => allowed.has(endpointId));
}

function assertPilotPolicy(): void {
  assert.deepEqual(DOMAINS.ranap.enabled, { final_gate: false, execute_verifikasi: false, tampung_bayar: false });
  assert.deepEqual(DOMAINS.rajal.enabled, { submit_payment: false });
  const allowlist = pilotWorkflow().policies?.mutationAllowlist ?? [];
  assert.deepEqual(allowlist, pilotMutationAllowlist);
  assert.deepEqual(validatePilotMutationAllowlist(allowlist), allowlist);
}

function makePilotEntry(onCall: (record: CallRecord) => void): WorkflowEntry {
  const makeClient = (args: ExecutorFactoryArgs) => new EvoMedisClient(
    {
      baseUrlV1: args.baseUrlV1 ?? DEFAULT_BASE,
      ...(args.baseUrlV2 ? { baseUrlV2: args.baseUrlV2 } : {}),
      cookie: args.cookie ?? 'ci_session=pilot-missing-cookie',
      cookieName: process.env.EVOMEDIS_SESSION_COOKIE_NAME ?? 'ci_session',
    },
    {
      mode: args.mode,
      transport: args.transport ?? new FetchTransport(),
      onCall,
      mutationAllowlist: pilotAllowlist(args.mutationAllowlist),
    },
  );

  return {
    definition: pilotWorkflow(),
    buildExecutors: (args) => pilotEntry().createExecutors({
      client: makeClient(args),
      ...(args.baseUrlV2 ? { baseUrlV2: args.baseUrlV2 } : {}),
    }),
    createClient: makeClient,
  };
}

function allPlans(state: RunState | undefined): MutationPlan[] {
  if (!state) return [];
  const seen = new Set<string>();
  const plans: MutationPlan[] = [];
  for (const node of Object.values(state.nodes)) {
    for (const plan of node.proposedMutations) {
      if (seen.has(plan.id)) continue;
      seen.add(plan.id);
      plans.push(plan);
    }
  }
  return plans;
}

function plansFromEvent(event: WorkflowEvent): MutationPlan[] {
  const data = event.data;
  if (!data || typeof data !== 'object') return [];
  const proposed = (data as { proposedMutations?: unknown }).proposedMutations;
  return Array.isArray(proposed) ? proposed.filter(isMutationPlan) : [];
}

function isMutationPlan(value: unknown): value is MutationPlan {
  return Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string');
}

/**
 * The preview↔write identity of a plan. The legacy rule stamps the current
 * wall-clock time onto every corrected date (`_build_update_datetime`), so two
 * runs a minute apart differ only in `HH:MM:SS`. That part is masked; the date,
 * transaction, endpoint, preconditions and verification rules must still match.
 */
function planFingerprint(plan: MutationPlan): string {
  return stableStringify({
    endpointId: plan.endpointId,
    riskLevel: plan.riskLevel,
    payload: plan.payload ?? {},
    query: plan.query ?? {},
    preconditions: plan.preconditions,
    verificationRules: verificationRulesOf(plan),
  }).replace(/(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}/g, '$1 --:--:--');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stableValue(v)]),
  );
}

function inScope(plan: MutationPlan): { ok: true } | { ok: false; reason: string } {
  const endpoint = getEndpoint(plan.endpointId);
  if (!endpoint) return { ok: false, reason: 'unknown endpoint' };
  if (endpoint.kind !== 'mutate') return { ok: false, reason: 'not a mutating endpoint' };
  if (!pilotMutationAllowlist.includes(plan.endpointId)) return { ok: false, reason: 'endpoint outside pilot allowlist' };
  if (FORBIDDEN_MUTATIONS.has(plan.endpointId)) return { ok: false, reason: 'final/critical endpoint forbidden in pilot' };
  if (plan.riskLevel === 'critical' || endpoint.riskLevel === 'critical') return { ok: false, reason: 'critical mutation forbidden in pilot' };
  if (!plan.payload || Object.keys(plan.payload).length === 0) return { ok: false, reason: 'no executable payload' };
  if (verificationRulesOf(plan).length === 0) return { ok: false, reason: 'no read-after-write verification rule' };
  return { ok: true };
}

function hasForbiddenCall(calls: PilotCall[]): boolean {
  return calls.some((call) => FORBIDDEN_MUTATIONS.has(call.endpointId));
}

function assertSingleWriteCall(calls: PilotCall[], proof: Proof): void {
  const writes = calls.filter((call) => isMutating(call.endpointId));
  if (writes.length !== 1 || writes[0]?.endpointId !== proof.endpointId || !writes[0].ok) {
    throw new Error(`write run made ${writes.length} mutating call(s); expected exactly one verified non-final call to ${proof.endpointId}`);
  }
}

function assertFinalStateProof(finalState: RunState | undefined, proof: Proof): void {
  const outcome = finalState?.mutations[proof.planId];
  if (!outcome || outcome.endpointId !== proof.endpointId || outcome.status !== 'verified' || outcome.appliedAt === undefined) {
    throw new Error('verified proof disappeared from final state; audit is not trustworthy');
  }
  if (!outcome.verificationResults?.length || outcome.verificationResults.some((result) => !result.holds)) {
    throw new Error('verified proof has no holding read-after-write result in final state');
  }
}

async function assertNoAuditError(service: RunService, runId: string): Promise<void> {
  const summary = (await service.listRuns()).find((run) => run.runId === runId);
  if (summary?.auditError) throw new Error(`audit ledger append failed for ${runId}: ${summary.auditError}`);
}

function assertAuditProof(jsonl: string, proof: Proof): void {
  const events = parseAuditEvents(jsonl, proof.runId);
  if (!events.some((event) => event.type === 'run.cancelled' || event.type === 'run.completed' || event.type === 'run.failed')) {
    throw new Error(`audit JSONL has no terminal run event for ${proof.runId}`);
  }

  for (const event of events) {
    if (event.type.startsWith('mutation.') && FORBIDDEN_MUTATIONS.has(eventEndpointId(event) ?? '')) {
      throw new Error(`audit JSONL contains forbidden mutation event ${event.type}`);
    }
  }

  const mutationEvents = events.filter((event) => event.type.startsWith('mutation.'));
  const proofPath = mutationEvents.filter((event) =>
    event.type === 'mutation.approved' || event.type === 'mutation.applied' || event.type === 'mutation.verified'
  );
  if (proofPath.length !== 3) {
    throw new Error(`audit JSONL has ${proofPath.length} proof mutation event(s); expected exactly approved + applied + verified`);
  }

  const proofEvents = mutationEvents.filter((event) => {
    const data = mutationEventData(event);
    return data?.planId === proof.planId && data.endpointId === proof.endpointId;
  });
  const approved = proofEvents.findIndex((event) => event.type === 'mutation.approved');
  const applied = proofEvents.findIndex((event) => event.type === 'mutation.applied');
  const verified = proofEvents.findIndex((event) => event.type === 'mutation.verified');
  if (approved < 0 || applied <= approved || verified <= applied) {
    throw new Error(`audit JSONL does not prove approved -> applied -> verified for ${proof.endpointId}`);
  }
  if (proofEvents.some((event) => event.type === 'mutation.failed' || event.type === 'mutation.invalidated')) {
    throw new Error(`audit JSONL contains a failed/invalidated event for proof plan ${proof.endpointId}`);
  }
  for (const event of proofPath) {
    const data = mutationEventData(event);
    if (data?.planId !== proof.planId || data.endpointId !== proof.endpointId) {
      throw new Error(`audit JSONL contains an extra proof mutation event ${event.type}`);
    }
  }

  const results = (proofEvents[verified]?.data as { verificationResults?: unknown } | undefined)?.verificationResults;
  if (!Array.isArray(results) || results.length === 0 || results.some((result) => !result || typeof result !== 'object' || (result as { holds?: unknown }).holds !== true)) {
    throw new Error(`audit JSONL verified event has no holding read-after-write result for ${proof.endpointId}`);
  }
}

function parseAuditEvents(jsonl: string, runId: string): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) throw new Error(`audit JSONL empty for ${runId}`);
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`audit JSONL line ${index + 1} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error(`audit JSONL line ${index + 1} is not an object`);
    if ((parsed as { kind?: unknown }).kind === 'run.meta') continue;
    if ((parsed as { runId?: unknown }).runId !== runId) throw new Error(`audit JSONL line ${index + 1} has wrong run id`);
    if (typeof (parsed as { type?: unknown }).type !== 'string') throw new Error(`audit JSONL line ${index + 1} has no event type`);
    events.push(parsed as WorkflowEvent);
  }
  return events;
}

function mutationEventData(event: WorkflowEvent): { planId: string; endpointId: string } | undefined {
  const data = event.data;
  if (!data || typeof data !== 'object') return undefined;
  const planId = (data as { planId?: unknown }).planId;
  const endpointId = (data as { endpointId?: unknown }).endpointId;
  return typeof planId === 'string' && typeof endpointId === 'string' ? { planId, endpointId } : undefined;
}

function eventEndpointId(event: WorkflowEvent): string | undefined {
  const data = event.data;
  if (!data || typeof data !== 'object') return undefined;
  const endpointId = (data as { endpointId?: unknown }).endpointId;
  return typeof endpointId === 'string' ? endpointId : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForTerminal(service: RunService, runId: string, timeoutMs: number): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await service.getState(runId);
    if (state && isTerminalStatus(state.status)) return state;
    await sleep(100);
  }
  service.cancel(runId);
  await service.waitFor(runId);
  throw new Error(`run ${runId} timed out`);
}

async function previewCandidate(
  service: RunService,
  operator: string,
  sessionToken: string,
  patient: string,
  date: string,
  authorizedPatients: readonly string[],
  setPhase: (phase: string) => number,
  callsSince: (from: number) => PilotCall[],
): Promise<Candidate | undefined> {
  const label = patientLabel(patient, authorizedPatients);
  const from = setPhase(`preview:${label}:${date}`);
  const { runId } = await service.createRun({
    workflowId: pilotEntry().workflow.id,
    mode: 'preview',
    source: 'live',
    operator,
    sessionToken,
    input: pilotEntry().input(patient, date, pilotClinic),
    enabled: pilotEntry().enabled,
  });
  const state = await waitForTerminal(service, runId, PREVIEW_TIMEOUT_MS);
  const calls = callsSince(from);
  if (calls.some((call) => isMutating(call.endpointId))) {
    throw new Error(`preview attempted a mutating endpoint in ${runId}`);
  }
  if (hasForbiddenCall(calls)) throw new Error(`preview called a forbidden endpoint in ${runId}`);

  const plans = allPlans(state).filter((plan) => inScope(plan).ok);
  console.log(`INFO: preview ${runId} ${label} date=${date} status=${state.status} in_scope_plans=${plans.length}`);
  return plans.length > 0 ? { patient, label, date, previewRunId: runId, plans } : undefined;
}

async function chooseCandidate(
  service: RunService,
  operator: string,
  sessionToken: string,
  args: Args,
  setPhase: (phase: string) => number,
  callsSince: (from: number) => PilotCall[],
): Promise<Candidate> {
  for (const patient of args.patients) {
    for (const date of args.dates) {
      const candidate = await previewCandidate(service, operator, sessionToken, patient, date, args.authorizedPatients, setPhase, callsSince);
      if (candidate) return candidate;
    }
  }
  throw new Error('No preview produced an in-scope verified mutation plan; live write proof is still not complete');
}

async function runWriteProof(
  service: RunService,
  operator: string,
  sessionToken: string,
  candidate: Candidate,
  ledgerDir: string,
  setPhase: (phase: string) => number,
  callsSince: (from: number) => PilotCall[],
): Promise<Proof> {
  const previewFingerprints = new Set(candidate.plans.map(planFingerprint));
  const from = setPhase(`write:${candidate.label}:${candidate.date}`);
  const { runId } = await service.createRun({
    workflowId: pilotEntry().workflow.id,
    mode: 'write',
    source: 'live',
    operator,
    sessionToken,
    input: pilotEntry().input(candidate.patient, candidate.date, pilotClinic),
    enabled: pilotEntry().enabled,
  });

  console.log(`INFO: write ${runId} ${candidate.label} date=${candidate.date}`);

  const attempted = new Set<string>();
  let approval: Promise<void> | undefined;
  let proof: Proof | undefined;
  let stopError: Error | undefined;

  const tryStart = (plan: MutationPlan) => {
    if (stopError || proof || approval || attempted.has(plan.id)) return;
    const verdict = inScope(plan);
    if (!verdict.ok) return;
    attempted.add(plan.id);
    if (!previewFingerprints.has(planFingerprint(plan))) {
      stopError = new Error(`write run proposed an in-scope plan that was not present in preview: ${plan.endpointId}`);
      service.cancel(runId);
      return;
    }
    console.log(`INFO: approving previewed non-final plan endpoint=${plan.endpointId}`);
    approval = (async () => {
      const result = await service.approveMutation(
        runId,
        plan.id,
        operator,
        'Controlled one-patient live write pilot: previewed non-final/non-critical mutation only',
      );
      if (!result.ok) {
        throw new Error(`approval refused: ${result.error} (${result.message})`);
      }
      if (!result.resolved) throw new Error('pilot selected a plan that unexpectedly needs a second approver');

      const outcome = result.outcome;
      if (FORBIDDEN_MUTATIONS.has(outcome.endpointId)) {
        throw new Error(`forbidden endpoint applied path reached: ${outcome.endpointId}`);
      }
      if (outcome.status === 'verified') {
        proof ??= { runId, planId: outcome.planId, endpointId: outcome.endpointId, status: 'verified', auditFile: join(ledgerDir, `${runId}.jsonl`) };
        return;
      }
      if (outcome.status === 'invalidated') {
        throw new Error(`mutation ${outcome.endpointId} invalidated before write; live write proof is still not complete`);
      }
      if (outcome.status === 'applied') {
        throw new Error(`mutation ${outcome.endpointId} applied but was not read-after-write verified; reconcile manually`);
      }
      throw new Error(`mutation ${outcome.endpointId} failed in phase=${outcome.phase ?? 'unknown'} ambiguous=${Boolean(outcome.ambiguous)}`);
    })()
      .catch((err: unknown) => {
        stopError = err instanceof Error ? err : new Error(String(err));
        service.cancel(runId);
      })
      .finally(() => {
        approval = undefined;
      });
  };

  const sub = await service.subscribe(runId, (event) => {
    for (const plan of plansFromEvent(event)) tryStart(plan);
  });

  try {
    const deadline = Date.now() + WRITE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const calls = callsSince(from);
      if (hasForbiddenCall(calls)) throw new Error(`forbidden final endpoint was called in write run ${runId}`);

      const state = await service.getState(runId);
      for (const plan of allPlans(state)) tryStart(plan);

      if (stopError) break;
      if (proof && !approval) break;
      if (!approval && state?.nodes.final_gate?.status === 'gate_waiting') break;
      if (state && isTerminalStatus(state.status) && !approval) break;
      await sleep(100);
    }

    if (approval) await approval;
    if (stopError) throw stopError;

    const calls = callsSince(from);
    if (hasForbiddenCall(calls)) throw new Error(`forbidden final endpoint was called in write run ${runId}`);
    if (!proof) throw new Error('write run produced no verified in-scope non-final mutation; live write proof is still not complete');

    service.cancel(runId);
    const finalState = await service.waitFor(runId);
    const finalCalls = callsSince(from);
    if (hasForbiddenCall(finalCalls)) throw new Error(`forbidden final endpoint was called in write run ${runId}`);
    assertSingleWriteCall(finalCalls, proof);
    assertFinalStateProof(finalState, proof);
    await assertNoAuditError(service, runId);
    const jsonl = await service.exportJsonl(runId);
    if (!jsonl) throw new Error(`audit JSONL missing or unreadable for ${runId}`);
    assertAuditProof(jsonl, proof);
    return proof;
  } finally {
    sub?.unsubscribe();
    const state = await service.getState(runId);
    if (state && !isTerminalStatus(state.status)) {
      service.cancel(runId);
      await service.waitFor(runId);
    }
  }
}

async function selfCheck(): Promise<void> {
  // Base assertions are ranap-scoped; the rajal block below switches domain itself.
  pilotDomain = 'ranap';
  assert.throws(() => validatePilotMutationAllowlist([]), /must name at least one endpoint/);
  assert.throws(() => validatePilotMutationAllowlist(['kasir.tampungBayar']), /forbidden, critical/);
  assert.throws(() => validatePilotMutationAllowlist(['verifikator.batalVerifikasi']), /forbidden, critical/);
  assert.throws(() => parseArgs(['--password', 'secret']), /not supported/);
  assert.throws(() => parseArgs(['--definitely-secret']), /Unknown argument; run --help/);
  assert.deepEqual(validatePilotMutationAllowlist(['kasir.updateTglMasuk']), ['kasir.updateTglMasuk']);
  configurePilotMutationAllowlist(['kasir.updateTglMasuk']);
  assertPilotPolicy();
  const demoPatient = ['9', '99', '99', '99'].join('-');
  const otherDemoPatient = ['8', '88', '88', '88'].join('-');
  assert.equal(redactText(`${demoPatient} ci_session=abc 123456`), '[medrec] ci_session=[redacted] [id]');
  assert.throws(() => validateClipboardPassword(''), /empty clipboard/);
  assert.throws(() => validateClipboardPassword('a\nb'), /single-line/);
  assert.throws(() => validateClipboardPassword('x'.repeat(257)), /unexpectedly long/);
  assert.equal(validateClipboardPassword('single-line\n'), 'single-line');
  const previousPasswordEnvs = Object.fromEntries(FORBIDDEN_PASSWORD_ENV.map((name) => [name, process.env[name]]));
  try {
    for (const name of FORBIDDEN_PASSWORD_ENV) delete process.env[name];
    let reads = 0;
    assert.equal(validateClipboardPassword('single-line\n'), 'single-line');
    process.env.EVO_PASS = 'forbidden';
    assert.throws(() => assertNoPasswordEnv(), /EVO_PASS must not be set/);
    const password = await readPasswordFromClipboard(async () => {
      reads += 1;
      return 'single-line';
    });
    assert.equal(password, 'single-line');
    assert.equal(reads, 1);
  } finally {
    for (const [name, value] of Object.entries(previousPasswordEnvs)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const previousAllowlist = process.env.PILOT_PATIENT_ALLOWLIST;
  process.env.PILOT_PATIENT_ALLOWLIST = `${demoPatient},${otherDemoPatient}`;
  try {
    assert.throws(() => parseArgs(['--date', '2026-01-01']), /exactly one selected patient/);
    const args = parseArgs(['--patient', demoPatient, '--date', '2026-01-01']);
    assert.deepEqual(args.patients, [demoPatient]);
    assert.equal(patientLabel(demoPatient, args.authorizedPatients), '[medrec#1]');
  } finally {
    if (previousAllowlist === undefined) delete process.env.PILOT_PATIENT_ALLOWLIST;
    else process.env.PILOT_PATIENT_ALLOWLIST = previousAllowlist;
  }

  const safe: MutationPlan = {
    id: 'p1',
    endpointId: 'kasir.updateTglMasuk',
    riskLevel: 'high',
    reason: 'self-check',
    preconditions: [],
    payloadSummary: { no_transaksi: 'T-1' },
    payload: { no_transaksi: 'T-1' },
    requiresApproval: true,
    idempotencyKey: 'p1',
    readAfterWriteChecks: [
      { description: 'verified', endpointId: 'kasir.getHistoryKunjungan', field: 'tgl_masuk', expected: '2026-01-01' },
    ],
  };
  assert.equal(inScope(safe).ok, true);
  assert.equal(inScope({ ...safe, id: 'p2', endpointId: 'kasir.tampungBayar', riskLevel: 'critical' }).ok, false);
  assert.equal(inScope({ ...safe, id: 'p3', payload: undefined }).ok, false);
  assert.equal(planFingerprint(safe), planFingerprint({ ...safe, id: 'other', idempotencyKey: 'other' }));
  // Wall-clock time-of-day is stamped per run; only the date must match.
  assert.equal(
    planFingerprint({ ...safe, payload: { ...safe.payload, txttglupdate_inap: '2026-01-01 08:00:00' } }),
    planFingerprint({ ...safe, payload: { ...safe.payload, txttglupdate_inap: '2026-01-01 09:00:00' } }),
  );
  assert.notEqual(
    planFingerprint({ ...safe, payload: { ...safe.payload, txttglupdate_inap: '2026-01-01 08:00:00' } }),
    planFingerprint({ ...safe, payload: { ...safe.payload, txttglupdate_inap: '2026-01-02 08:00:00' } }),
  );
  assert.notEqual(planFingerprint(safe), planFingerprint({ ...safe, payload: { no_transaksi: 'T-2' } }));

  const auditRunId = 'run_self_check';
  const auditProof: Proof = {
    runId: auditRunId,
    planId: 'p1',
    endpointId: safe.endpointId,
    status: 'verified',
    auditFile: 'self-check.jsonl',
  };
  const auditJsonl = [
    { kind: 'run.meta', runId: auditRunId },
    { schema: 'simrs.workflow.event.v1', eventId: 'e1', seq: 1, ts: '2026-01-01T00:00:00.000Z', runId: auditRunId, workflowId: 'ranap.v1', workflowVersion: '1', type: 'mutation.approved', source: 'api', data: { planId: 'p1', endpointId: safe.endpointId } },
    { schema: 'simrs.workflow.event.v1', eventId: 'e2', seq: 2, ts: '2026-01-01T00:00:01.000Z', runId: auditRunId, workflowId: 'ranap.v1', workflowVersion: '1', type: 'mutation.applied', source: 'api', data: { planId: 'p1', endpointId: safe.endpointId } },
    { schema: 'simrs.workflow.event.v1', eventId: 'e3', seq: 3, ts: '2026-01-01T00:00:02.000Z', runId: auditRunId, workflowId: 'ranap.v1', workflowVersion: '1', type: 'mutation.verified', source: 'api', data: { planId: 'p1', endpointId: safe.endpointId, verificationResults: [{ holds: true }] } },
    { schema: 'simrs.workflow.event.v1', eventId: 'e4', seq: 4, ts: '2026-01-01T00:00:03.000Z', runId: auditRunId, workflowId: 'ranap.v1', workflowVersion: '1', type: 'run.cancelled', source: 'api' },
  ].map((line) => JSON.stringify(line)).join('\n');
  assert.doesNotThrow(() => assertAuditProof(`${auditJsonl}\n`, auditProof));
  const extraLanded = `${auditJsonl}\n${JSON.stringify({ schema: 'simrs.workflow.event.v1', eventId: 'e5', seq: 5, ts: '2026-01-01T00:00:04.000Z', runId: auditRunId, workflowId: 'ranap.v1', workflowVersion: '1', type: 'mutation.applied', source: 'api', data: { planId: 'p2', endpointId: safe.endpointId } })}\n`;
  assert.throws(() => assertAuditProof(extraLanded, auditProof), /expected exactly approved \+ applied \+ verified/);
  // Rajal: the only endpoint a pilot may write is the SEP correction; payment
  // and verification stay off, and a ranap endpoint is refused in rajal scope.
  assert.deepEqual([...safeMutationsOf(rajalWorkflow)], ['rekamMedis.simpanSep']);
  assert.equal(DOMAINS.rajal.enabled.submit_payment, false);
  const previousDomain = pilotDomain;
  try {
    pilotDomain = 'rajal';
    assert.deepEqual(validatePilotMutationAllowlist(['rekamMedis.simpanSep']), ['rekamMedis.simpanSep']);
    assert.throws(() => validatePilotMutationAllowlist(['kasir.updateTglMasuk']), /out-of-domain/);
    assert.throws(() => validatePilotMutationAllowlist(['kasir.tampungBayar']), /forbidden, critical/);
    assert.throws(() => parseArgs(['--domain', 'rajal', '--patient', 'x']), /--clinic is required for rajal/);
    assert.deepEqual(DOMAINS.rajal.input('p', '2026-10-06', 'SYARAF'), { patientIds: ['p'], clinics: ['SYARAF'], date: '2026-10-06', dateFrom: '2026-10-06', dateTo: '2026-10-06' });
  } finally {
    pilotDomain = previousDomain;
  }
  console.log('PASS: pilot-live-write self-check');
}

async function main(): Promise<void> {
  loadSafeDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  pilotDomain = args.domain;
  pilotClinic = args.clinic;
  if (args.selfCheck) {
    await selfCheck();
    return;
  }
  console.log(`INFO: pilot domain=${pilotDomain}${pilotClinic ? ` clinic=${pilotClinic}` : ''}`);
  configurePilotMutationAllowlist(loadPilotMutationAllowlist());
  assertPilotPolicy();

  const baseUrlV1 = process.env.EVOMEDIS_BASE_URL || process.env.EVO_BASE;
  if (!baseUrlV1) throw new Error('Set EVOMEDIS_BASE_URL (see .env.example)');
  const baseUrlV2 = process.env.EVOMEDIS_BASE_URL_V2?.trim();
  const cookieName = process.env.EVOMEDIS_SESSION_COOKIE_NAME || 'ci_session';
  const ledgerDir = resolve(process.env.PILOT_LEDGER_DIR || process.env.AUDIT_LEDGER_DIR || './.data/pilot-live-write');

  const calls: PilotCall[] = [];
  let phase = 'idle';
  const setPhase = (next: string) => {
    phase = next;
    return calls.length;
  };
  const callsSince = (from: number) => calls.slice(from);
  const onCall = (record: CallRecord) => {
    calls.push({ phase, endpointId: record.endpointId, status: record.status, ok: record.ok });
  };

  const ledger = new FileLedger(ledgerDir);
  const sessions = new UserSessionStore({
    baseUrlV1,
    ...(baseUrlV2 ? { baseUrlV2 } : {}),
    cookieName,
  });
  const service = new RunService(ledger, {
    sessions,
    workflows: (workflowId) => (workflowId === pilotEntry().workflow.id ? makePilotEntry(onCall) : undefined),
  });

  let token: string | undefined;
  try {
    console.log(`INFO: authorized medrec list loaded (${args.authorizedPatients.length} redacted entries)`);
    const credentials = await readCredentials();
    const login = await sessions.login(credentials.username, credentials.password);
    token = login.token;
    console.log('PASS: EvoMedis login succeeded (cookie/token hidden)');

    const candidate = await chooseCandidate(service, login.operator, token, args, setPhase, callsSince);
    console.log(`PASS: selected preview candidate ${candidate.previewRunId} ${candidate.label} date=${candidate.date} in_scope_plans=${candidate.plans.length}`);

    const proof = await runWriteProof(service, login.operator, token, candidate, ledgerDir, setPhase, callsSince);
    console.log(`PASS: verified one non-final live mutation endpoint=${proof.endpointId} run=${proof.runId}`);
    console.log('PASS: no final verification/tampung-bayar endpoint was called');
    console.log(`INFO: audit JSONL ${proof.auditFile}`);
    console.log('RESULT: live write pilot proof achieved for one in-scope non-final mutation; manual SIMRS comparison is still required before operational sign-off.');
  } finally {
    sessions.logout(token);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`FAIL: ${redactText(message)}`);
  console.error('RESULT: live write pilot proof is NOT complete.');
  process.exitCode = 1;
});
