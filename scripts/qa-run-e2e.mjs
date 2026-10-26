// Run-page E2E measurement driver — no deps (Node >= 22 WebSocket + CDP).
// Creates a QA run through the orchestrator (real executors, gate, ledger, SSE),
// opens it in the UI under an office-PC profile and measures what an operator
// feels: time to first progress, long tasks, frame rate, progress lag behind
// the server, click latency, heap/DOM size and console errors.
//
//   node scripts/qa-run-e2e.mjs --domain rajal --patients 500 --profile C
//   node scripts/qa-run-e2e.mjs --domain ranap --scenario ranap-two-room --latency 300 --profile B
//   node scripts/qa-run-e2e.mjs --domain ranap --fault network:kasir.getHistoryKunjungan:0:1
//
// Needs `npm run dev:orchestrator` (QA_AUTH_TOKEN set) and `npm run dev:ui` (VITE_QA_AUTH=1).
// Output: .data/qa/<tag>.json (+ .png). ponytail: throwaway QA tooling, not a CI suite.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (!arg.startsWith('--')) return acc;
  const next = all[i + 1];
  acc.push([arg.slice(2), next && !next.startsWith('--') ? next : 'true']);
  return acc;
}, []));

// Office-PC profiles agreed for this test (CPU slowdown × viewport).
const PROFILES = {
  A: { cpu: 1, width: 1536, height: 864 },
  B: { cpu: 4, width: 1366, height: 768 },
  C: { cpu: 6, width: 1093, height: 614 },
  D: { cpu: 4, width: 1600, height: 900 },
  E: { cpu: 4, width: 1920, height: 1080 },
};
const profileName = args.profile ?? 'B';
const profile = PROFILES[profileName] ?? PROFILES.B;
const domain = args.domain === 'rajal' ? 'rajal' : 'ranap';
const patients = Number(args.patients ?? 1);
const mode = args.mode === 'write' ? 'write' : 'preview';
const view = args.view === 'flexible' ? 'Flexible' : 'Fixed';
const theme = args.theme === 'light' ? 'light' : 'dark';
const faults = (args.fault ? String(args.fault).split(',') : []).map((spec) => {
  const [kind, endpointId, afterCalls, times] = spec.split(':');
  return { kind, ...(endpointId ? { endpointId } : {}), ...(afterCalls ? { afterCalls: Number(afterCalls) } : {}), ...(times ? { times: Number(times) } : {}) };
});
const qa = {
  scenario: args.scenario ?? (domain === 'rajal' && patients > 1 ? 'rajal-synthetic' : 'happy'),
  latencyMs: Number(args.latency ?? 0),
  jitterMs: Number(args.jitter ?? 0),
  ...(faults.length ? { faults } : {}),
};
const tag = args.tag ?? `${domain}-${qa.scenario}-${patients}p-${profileName}-${view.toLowerCase()}-${theme}${faults.length ? `-${faults.map((f) => f.kind).join('+')}` : ''}${qa.latencyMs ? `-lat${qa.latencyMs}` : ''}`;
const OUT = resolve('.data/qa');
mkdirSync(OUT, { recursive: true });
const APP = process.env.APP ?? 'http://localhost:5173/';
const SHELL = process.env.SHELL_BIN
  ?? `${process.env.LOCALAPPDATA}/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe`;
const PORT = Number(args.port ?? 9338);
const TIMEOUT_S = Number(args.timeout ?? 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runInput() {
  if (domain === 'ranap') return { noRm: '012345', tanggal: '2026-06-10' };
  const ids = patients > 1
    ? Array.from({ length: patients }, (_, i) => `0-8${Math.floor(i / 10000)}-${String(Math.floor(i / 100) % 100).padStart(2, '0')}-${String(i % 100).padStart(2, '0')}`)
    : ['012345'];
  return { patientIds: ids, clinics: ['PENYAKIT DALAM'], date: '2026-06-10' };
}

const chrome = spawn(SHELL, ['--headless', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
let targets = [];
for (let i = 0; i < 50 && !targets.length; i++) {
  try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page'); } catch { /* not up yet */ }
  if (!targets.length) await sleep(200);
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails?.exception?.description?.slice(0, 200) ?? 'exception');
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
};
const send = (method, params = {}) => new Promise((r, j) => {
  const mid = ++id;
  pending.set(mid, (msg) => (msg.error ? j(new Error(`${method}: ${msg.error.message}`)) : r(msg.result)));
  ws.send(JSON.stringify({ id: mid, method, params }));
});
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
}
async function heap() {
  const { metrics } = await send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heapMB: Math.round(m.JSHeapUsedSize / 1e6), domNodes: m.Nodes, listeners: m.JSEventListeners };
}
/** Click a button by its trimmed label and time it to the next painted frame. */
async function timedClick(pattern) {
  return evaluate(`(async () => {
    const re = new RegExp(${JSON.stringify(pattern)}, 'i');
    const b = [...document.querySelectorAll('button')].find((x) => re.test(x.textContent.trim()) && !x.disabled && x.offsetParent);
    if (!b) return null;
    const t = performance.now();
    b.click();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    return Math.round(performance.now() - t);
  })()`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Performance.enable');
await send('Emulation.setDeviceMetricsOverride', { width: profile.width, height: profile.height, deviceScaleFactor: 1, mobile: profile.width < 900 });
// Instrument every document: long tasks and a frame counter, before app code runs.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__qa = { longTasks: [], frames: 0, jank: 0, worstGap: 0, since: performance.now() };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__qa.longTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch {}
  let last = performance.now();
  const tick = (t) => { const gap = t - last; last = t; const q = window.__qa; q.frames++; if (gap > 50) q.jank++; if (gap > q.worstGap) q.worstGap = Math.round(gap); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
` });

// ── Login (QA) ──
await send('Page.navigate', { url: APP });
await sleep(2000);
await evaluate(`(${theme === 'light'} ? localStorage.removeItem('simrs-flow-theme') : localStorage.setItem('simrs-flow-theme','dark')), localStorage.removeItem('simrs-flow.run.panels.v1'), ${JSON.stringify(args.motion ?? '')} ? localStorage.setItem('simrs-flow.motion', ${JSON.stringify(args.motion ?? '')}) : localStorage.removeItem('simrs-flow.motion'), 'ok'`);
const qaButton = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Masuk QA/i.test(x.textContent.trim())); b?.click(); return Boolean(b); })()`);
if (!qaButton) {
  // Production bundle (no QA button): sign in through the QA endpoint, which exists only on a QA host.
  await evaluate(`fetch('/api/auth/qa-login', { method: 'POST', credentials: 'include' }).then((r) => r.json()).then((b) => { localStorage.setItem('simrs-flow.token', b.token); return 'ok'; })`);
  await send('Page.navigate', { url: APP });
}
await sleep(3500);
if (!(await evaluate(`Boolean(document.querySelector('.icon-rail'))`))) { console.error('FAIL: QA login did not reach the dashboard'); process.exit(1); }

// ── Create the run through the orchestrator ──
const created = await evaluate(`(async () => {
  const token = localStorage.getItem('simrs-flow.token') ?? sessionStorage.getItem('simrs-flow.token');
  const res = await fetch('/api/runs', { method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(${JSON.stringify({ workflowId: domain === 'ranap' ? 'ranap-verifikasi-tampung-bayar' : 'rajal-patient-processor', mode, source: 'fixture', input: runInput(), qa, ...(domain === 'ranap' && args.verifikasi === 'false' ? { enabled: { final_gate: false, execute_verifikasi: false, tampung_bayar: false } } : {}), ...(mode === 'write' ? { autoApprove: true } : {}) })}) });
  return { status: res.status, body: await res.json() };
})()`);
if (created.status !== 201) { console.error('FAIL: create run', JSON.stringify(created)); process.exit(1); }
const runId = created.body.runId;
console.log(`run ${runId} (${tag})`);

// CPU slowdown only for the page under test, after login (the profile is the operator's PC).
await send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
if (args.cpuprofile) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start'); }
const tOpen = Date.now();
await send('Page.navigate', { url: `${APP}?run=${encodeURIComponent(runId)}` });
await sleep(1500);
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(view)}); b?.click(); return 'ok'; })()`);

// ── Watch the run ──
const samples = [];
const clicks = [];
let firstProgressMs;
let status = '';
for (let s = 0; s < TIMEOUT_S; s++) {
  const ui = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-testid=wf-node]')];
    const done = nodes.filter((el) => /status-(success|failed|skipped|blocked|needs_review)/.test(el.className)).length;
    const moving = nodes.some((el) => /status-(running|success|failed|skipped|blocked|needs_review)/.test(el.className));
    return { badge: document.querySelector('.run-status-badge')?.textContent.trim() ?? '', done, moving, total: nodes.length };
  })()`).catch(() => ({ badge: '', done: 0, moving: false, total: 0 }));
  if (ui.moving && firstProgressMs === undefined) firstProgressMs = Date.now() - tOpen;
  const server = await evaluate(`fetch('/api/runs/${runId}', { credentials: 'include', headers: { authorization: 'Bearer ' + (localStorage.getItem('simrs-flow.token') ?? sessionStorage.getItem('simrs-flow.token') ?? '') } }).then((r) => r.json()).then((st) => ({ status: st.status, done: Object.values(st.nodes ?? {}).filter((n) => ['success','failed','skipped','blocked','needs_review'].includes(n.status)).length })).catch(() => ({}))`);
  const mem = await heap();
  // Lag counts only once the canvas shows progress; before that the page is still loading.
  samples.push({ t: s, ui: ui.done, server: server.done, lag: ui.moving ? (server.done ?? 0) - ui.done : 0, ...mem });
  status = ui.badge;
  // Operator presses F5 mid-run: the page must pick the run back up.
  if (args['reload-at'] && s === Number(args['reload-at'])) { await send('Page.reload'); await sleep(1500); }
  // Interact like an operator every ~6 s while it runs.
  if (s % 6 === 3) {
    for (const p of ['^Log$', '^Kanvas$', '^Inspector$', '^Inspector$']) { const ms = await timedClick(p); if (ms !== null) clicks.push({ p, ms }); }
  }
  if (['completed', 'failed', 'cancelled'].includes(server.status) && ui.done >= server.done) break;
  await sleep(1000);
}
if (args.cpuprofile) {
  // Top self-time functions while the page opened and rendered the run.
  const { profile: prof } = await send('Profiler.stop');
  writeFileSync(join(OUT, `${tag}.cpuprofile`), JSON.stringify(prof));
  const dt = new Map(prof.samples.map((idx, i) => [i, prof.timeDeltas[i] ?? 0]));
  const self = new Map();
  prof.samples.forEach((nodeId, i) => self.set(nodeId, (self.get(nodeId) ?? 0) + (dt.get(i) ?? 0)));
  const byFn = new Map();
  for (const node of prof.nodes) {
    const f = node.callFrame; const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) ?? 0) + (self.get(node.id) ?? 0));
  }
  console.log('TOP SELF (ms):', JSON.stringify([...byFn].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Math.round(v / 1000)])));
}
await sleep(1500);
const q = await evaluate(`({ ...window.__qa, elapsed: performance.now() - window.__qa.since })`);
const end = await heap();
// After the run: scroll the log and the patient cards, the busiest views.
const afterClicks = [];
for (const p of ['^Log$', '^Kanvas$']) { const ms = await timedClick(p); if (ms !== null) afterClicks.push({ p, ms }); }
await shot(`${tag}.png`);
const finalUi = await evaluate(`({
  badge: document.querySelector('.run-status-badge')?.textContent.trim() ?? '',
  attention: document.querySelector('.run-command-lead')?.textContent.trim().slice(0, 200) ?? '',
  error: [...document.querySelectorAll('[role=alert], .run-error-alert')].map((x) => x.textContent.trim()).join(' | ').slice(0, 300),
  overflowX: document.scrollingElement.scrollWidth - innerWidth,
  nodes: [...document.querySelectorAll('[data-testid=wf-node]')].map((el) => {
    const status = ([...el.classList].find((c) => c.startsWith('status-')) ?? '').slice(7);
    const label = (el.getAttribute('aria-label') ?? '').split(' — ')[0];
    const summary = (el.getAttribute('aria-label') ?? '').split(' — ').slice(1).join(' — ').slice(0, 200);
    return { label, status, summary };
  }),
  summaryPanel: document.querySelector('.run-summary')?.innerText.replace(/\\s+/g, ' ').slice(0, 400) ?? '',
})`);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const report = {
  tag, runId, profile: { name: profileName, ...profile }, domain, patients, mode, view, theme, qa,
  status, finalUi,
  firstProgressMs,
  durationS: samples.length,
  maxLagNodes: Math.max(0, ...samples.map((x) => x.lag)),
  longTasks: { count: q.longTasks.length, over500: q.longTasks.filter((d) => d > 500).length, max: Math.max(0, ...q.longTasks) },
  fps: Math.round((q.frames / q.elapsed) * 1000), jankFrames: q.jank, worstFrameGapMs: q.worstGap,
  clickP95Ms: pct(clicks.map((c) => c.ms), 0.95), clickMaxMs: Math.max(0, ...clicks.map((c) => c.ms)), afterClicks,
  heapMaxMB: Math.max(end.heapMB, ...samples.map((x) => x.heapMB)), domNodesEnd: end.domNodes,
  consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
};
writeFileSync(join(OUT, `${tag}.json`), JSON.stringify({ ...report, samples }, null, 2));
console.log(JSON.stringify(report));
ws.close();
chrome.kill();
process.exit(0);
