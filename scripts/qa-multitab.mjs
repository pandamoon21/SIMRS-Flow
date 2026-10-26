// Multi-tab check: N tabs watching a running run each hold an SSE stream. Chrome
// allows 6 HTTP/1.1 connections per host, so from tab 7 on every request can
// stall. Measures how long a plain API call takes from the last tab, with the
// earlier tabs visible (foreground) or in the background.
//
//   node scripts/qa-multitab.mjs --tabs 8
// ponytail: throwaway QA tooling.
import { spawn } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? 'true']] : acc), []));
const TABS = Number(args.tabs ?? 8);
const APP = process.env.APP ?? 'http://127.0.0.1:4500/';
const SHELL = process.env.SHELL_BIN ?? `${process.env.LOCALAPPDATA}/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe`;
const PORT = 9340;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(SHELL, ['--headless', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
let browserWs;
for (let i = 0; i < 50 && !browserWs; i++) {
  try { browserWs = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); }
}
const ws = new WebSocket(browserWs);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((r, j) => {
  const mid = ++id;
  pending.set(mid, (m) => (m.error ? j(new Error(`${method}: ${m.error.message}`)) : r(m.result)));
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (sessionId, expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
async function openTab(url, background = false) {
  const { targetId } = await send('Target.createTarget', { url, background });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

// Sign in once (cookie is shared by every tab), then start a long QA run.
const first = await openTab(APP);
await sleep(2500);
await evaluate(first.sessionId, `fetch('/api/auth/qa-login', { method: 'POST', credentials: 'include' }).then((r) => r.json()).then((b) => { localStorage.setItem('simrs-flow.token', b.token); return 'ok'; })`);
const runId = await evaluate(first.sessionId, `fetch('/api/runs', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('simrs-flow.token') },
  body: JSON.stringify({ workflowId: 'rajal-patient-processor', mode: 'preview', source: 'fixture', input: { patientIds: Array.from({ length: 400 }, (_, i) => '0-80-0' + Math.floor(i / 100) + '-' + String(i % 100).padStart(2, '0')), clinics: ['PENYAKIT DALAM'], date: '2026-06-10' }, qa: { scenario: 'rajal-synthetic', latencyMs: 40 } }) }).then((r) => r.json()).then((b) => b.runId)`);
console.log('run', runId);

const tabs = [first];
await send('Page.navigate', { url: `${APP}?run=${runId}` }, first.sessionId).catch(() => send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(`${APP}?run=${runId}`)}` }, first.sessionId));
// Like middle-clicking runs open: earlier tabs in the background, the last one in front.
for (let i = 1; i < TABS; i++) tabs.push(await openTab(`${APP}?run=${runId}`, i < TABS - 1));
await sleep(3000);
console.log('visibility:', (await Promise.all(tabs.map((t) => evaluate(t.sessionId, 'document.visibilityState')))).join(','));

async function probe(label) {
  const last = tabs.at(-1);
  const ms = await evaluate(last.sessionId, `(async () => { const t = performance.now(); const c = new AbortController(); const k = setTimeout(() => c.abort(), 15000);
    try { await fetch('/api/health', { signal: c.signal, cache: 'no-store' }); return Math.round(performance.now() - t); } catch { return -1; } finally { clearTimeout(k); } })()`);
  console.log(`${label}: /api/health from tab ${TABS} = ${ms < 0 ? 'STALLED >15 s' : `${ms} ms`}`);
}
await probe('right after opening');
// Headless reports every tab visible; send what Chrome sends when a tab goes to the background.
for (const t of tabs.slice(0, -1)) await evaluate(t.sessionId, `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); 'ok'`);
await sleep(12000);
await probe('after the hidden-tab release (12 s)');
// Background every tab but the last (what an operator does when switching tabs).
for (const t of tabs.slice(0, -1)) await send('Target.activateTarget', { targetId: tabs.at(-1).targetId });
for (const t of tabs.slice(0, -1)) await send('Emulation.setFocusEmulationEnabled', { enabled: false }, t.sessionId).catch(() => {});
for (const t of tabs.slice(0, -1)) await send('Page.setWebLifecycleState', { state: 'frozen' }, t.sessionId).catch(() => {});
await sleep(3000);
await probe('earlier tabs frozen (background)');
ws.close();
chrome.kill();
process.exit(0);
