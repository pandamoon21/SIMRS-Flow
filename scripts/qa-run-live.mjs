// Run-page E2E driver — no deps (Node >= 22 native WebSocket + CDP).
// Logs in, configures a Run, starts it, waits for a terminal status, fits the
// canvas, then saves a screenshot and the per-node {label,status} list.
//
//   Offline (fixture replay, QA login):
//     node scripts/qa-run-live.mjs --offline --domain ranap [--theme light]
//   Live preview (real SIMRS, read-only):
//     PILOT_USERNAME=<user>  (password: copy it to the Windows clipboard first)
//     node scripts/qa-run-live.mjs --domain ranap --rm <no-rm> --date YYYY-MM-DD
//     node scripts/qa-run-live.mjs --domain rajal --rm <no-rm> --clinic SYARAF --date YYYY-MM-DD
//
// ponytail: throwaway QA tooling; Playwright if this ever becomes a CI suite.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (!arg.startsWith('--')) return acc;
  const next = all[i + 1];
  acc.push([arg.slice(2), next && !next.startsWith('--') ? next : 'true']);
  return acc;
}, []));
const domain = args.domain === 'rajal' ? 'rajal' : 'ranap';
const offline = args.offline === 'true';
if (!offline && !args.rm) { console.error('--rm is required for a live run'); process.exit(2); }
if (!offline && domain === 'rajal' && !args.clinic) { console.error('--clinic is required for rajal'); process.exit(2); }

const OUT = resolve('.data/live');
mkdirSync(OUT, { recursive: true });
const APP = process.env.APP ?? 'http://localhost:5173/';
const SHELL = process.env.SHELL_BIN
  ?? `${process.env.LOCALAPPDATA}/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe`;
const PORT = 9337;
const TIMEOUT_S = Number(args.timeout ?? 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (text) => String(text).replace(/\d-\d{2}-\d{2}-\d{2}/g, '#-##-##-##');
const tag = `${offline ? 'offline' : 'ui'}-${domain}-${args.theme ?? 'dark'}${args.rm ? `-${args.rm.replace(/\D/g, '').slice(-2)}` : ''}`;

function clipboardPassword() {
  // LIVE_PASS (from the gitignored .env) wins; otherwise read the clipboard once, then clear it.
  if (process.env.LIVE_PASS) return process.env.LIVE_PASS;
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Windows.Forms; $p = Get-Clipboard -Raw; [System.Windows.Forms.Clipboard]::Clear(); [Console]::Out.Write($p)',
  ], { windowsHide: true }).toString().replace(/\r?\n$/, '');
}

const chrome = spawn(SHELL, ['--headless', '--disable-gpu', '--no-first-run', '--window-size=1600,900', `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
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
  console.log('shot:', join('.data/live', name));
}
/** Click the first button whose trimmed text matches; throws when absent. */
async function clickButton(pattern) {
  const label = await evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, 'i');
    const b = [...document.querySelectorAll('button')].find((x) => re.test(x.textContent.trim()) && !x.disabled);
    if (!b) return null; b.click(); return b.textContent.trim(); })()`);
  if (!label) throw new Error(`button not found or disabled: ${pattern}`);
  await sleep(400);
  return label;
}
/** React-safe value setter: native setter + input event. */
async function fill(selector, value) {
  const ok = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true; })()`);
  if (!ok) throw new Error(`field not found: ${selector}`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(1500);
await evaluate(`(${args.theme === 'light'} ? localStorage.removeItem('simrs-flow-theme') : localStorage.setItem('simrs-flow-theme','dark')), sessionStorage.clear(), localStorage.removeItem('simrs-flow.token'), localStorage.removeItem('simrs-flow.run.panels.v1'), 'ok'`);
await send('Page.navigate', { url: APP });
await sleep(2500);

// ── Login ──
if (offline) {
  await clickButton('^Masuk QA');
} else {
  const user = (process.env.PILOT_USERNAME ?? process.env.LIVE_USER)?.trim();
  if (!user) { console.error('PILOT_USERNAME is required for a live run'); process.exit(2); }
  await fill('#login-username', user);
  await fill('#login-password', clipboardPassword());
  await evaluate(`document.querySelector('.login-form').requestSubmit(), 'ok'`);
}
await sleep(3500);
if (!(await evaluate(`Boolean(document.querySelector('.icon-rail'))`))) {
  await shot(`${tag}-login-fail.png`);
  const why = await evaluate(`[...document.querySelectorAll('.alert, .login-error, [role=alert]')].map((x) => x.textContent.trim()).join(' | ')`);
  console.error(`FAIL: login did not reach the dashboard ${why ? `(${mask(why)})` : ''}`);
  process.exit(1);
}

// ── Configure ──
await evaluate(`(() => { const a = [...document.querySelectorAll('.icon-rail .rail-link')].find((x) => x.querySelector('.visually-hidden')?.textContent.trim() === 'Run'); if (!a) throw new Error('Run nav not found'); a.click(); return 'ok'; })()`);
await sleep(1200);
await clickButton(domain === 'rajal' ? '^Rawat Jalan' : '^Rawat Inap');
await clickButton(offline ? '^Fixture replay$' : '^Live SIMRS$');
await clickButton('^Preview$');
if (!offline) {
  if (domain === 'ranap') {
    await fill('#ranap-rm', args.rm);
    if (args.date) await fill('#ranap-date', args.date);
  } else {
    await evaluate(`document.querySelector('#rajal-mode-list')?.click(), 'ok'`);
    await fill('#rajal-rm', args.rm);
    await fill('#rajal-clinic', args.clinic);
    if (args.date) await fill('#rajal-date', args.date);
  }
  await sleep(500);
}
const blocker = await evaluate(`[...document.querySelectorAll('.form-hint')].map((x) => x.textContent).find((t) => t.startsWith('Start blocked')) ?? ''`);
if (blocker) { console.error(`FAIL: ${mask(blocker)}`); process.exit(1); }
await clickButton('^Start preview$');

// ── Wait for terminal status ──
let status = '';
for (let s = 0; s < TIMEOUT_S; s++) {
  status = await evaluate(`document.querySelector('.run-status-badge')?.textContent.trim() ?? ''`);
  if (['Selesai', 'Gagal', 'Dibatalkan'].includes(status)) break;
  await sleep(1000);
}
if (!['Selesai', 'Gagal', 'Dibatalkan'].includes(status)) { console.error(`FAIL: run did not finish in ${TIMEOUT_S}s (status=${status})`); process.exit(1); }
console.log(`run status: ${status}`);

// ── Fit, capture ──
await evaluate(`(() => { for (const id of ['setup']) { const b = [...document.querySelectorAll('.run-toggle')].find((x) => x.textContent.trim().toLowerCase() === id && x.getAttribute('aria-pressed') === 'true'); b?.click(); } return 'ok'; })()`);
await sleep(300);
await clickButton('^Fit$');
await sleep(900);
await shot(`${tag}.png`);
const stopDisabled = await evaluate(`document.querySelector('.run-cancel-btn')?.disabled ?? null`);
await clickButton('^Center$');
await sleep(700);
await shot(`${tag}-zoom.png`);
const nodes = await evaluate(`[...document.querySelectorAll('[data-testid=wf-node]')].map((el) => ({
  label: (el.getAttribute('aria-label') ?? '').split(' — ')[0],
  status: ([...el.classList].find((c) => c.startsWith('status-')) ?? '').slice(7),
}))`);
const overlaps = await evaluate(`(() => {
  const r = [...document.querySelectorAll('.react-flow__node-workflow')].map((el) => el.getBoundingClientRect());
  let n = 0; for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    const a = r[i], b = r[j]; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) n++; }
  return n; })()`);
const headers = await evaluate(`[...document.querySelectorAll('.phase-header-name')].map((x) => x.textContent.trim())`);
const edgeLabels = await evaluate(`[...document.querySelectorAll('.react-flow__edge-text')].map((x) => x.textContent.trim())`);
writeFileSync(join(OUT, `${tag}.json`), mask(JSON.stringify({ status, stopDisabled, nodes, overlaps, headers, edgeLabels }, null, 2)));
console.log(`stopDisabled=${stopDisabled} nodes=${nodes.length} overlaps=${overlaps} phases=${headers.length} edgeLabels=${edgeLabels.join(',') || '-'}`);
console.log(`saved: .data/live/${tag}.json`);
ws.close();
chrome.kill();
