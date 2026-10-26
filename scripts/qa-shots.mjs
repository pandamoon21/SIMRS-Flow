// QA screenshot driver — no deps (Node >= 22 native WebSocket).
// Injects a QA token via sessionStorage, walks the dashboard pages, saves PNGs.
//  ponytail: throwaway QA tooling.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve('.omo/evidence/pleurat-blue-refresh');
mkdirSync(OUT, { recursive: true });

const SHELL = process.env.SHELL_BIN
  ?? `${process.env.LOCALAPPDATA}/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe`;
const PORT = 9336;
const APP = 'http://localhost:5174/';
const TOKEN = 'qa-dev-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(SHELL, [
  '--headless', '--disable-gpu', '--no-first-run', '--window-size=1440,900',
  `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

let targets;
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = await res.json();
    if (targets.length) break;
  } catch { /* not up yet */ }
  await sleep(200);
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((r, j) => {
    pending.set(mid, (msg) => (msg.error ? j(new Error(`${method}: ${msg.error.message}`)) : r(msg.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  console.log('shot:', name);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// 1. Load once (any page), 2. inject token+theme, 3. reload — client.ts reads
// sessionStorage at module init, so the app comes up logged in.
await send('Page.navigate', { url: APP });
await sleep(2000);
await evaluate(`sessionStorage.setItem('simrs-flow.token', ${JSON.stringify(TOKEN)}); 'ok'`);

async function reloadWithTheme(theme) {
  await evaluate(
    theme === 'dark'
      ? `localStorage.setItem('simrs-flow-theme','dark'); 'ok'`
      : `localStorage.removeItem('simrs-flow-theme'); 'ok'`,
  );
  await send('Page.navigate', { url: APP });
  await sleep(3000); // React mount + api/me + settle
  const loggedOut = await evaluate(`!document.querySelector('.dashboard-nav')`);
  if (loggedOut) throw new Error('still on login page — token injection failed');
}

await reloadWithTheme('light');
await shot('home-light.png');

async function clickNav(label) {
  await evaluate(`(() => {
    const links = [...document.querySelectorAll('.dashboard-nav .nav-link')];
    const el = links.find((a) => a.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!el) throw new Error('nav not found: ' + ${JSON.stringify(label)});
    el.click(); return 'ok'; })()`);
  await sleep(1200);
}

await clickNav('Run');
await shot('run-setup-light.png');

// Start an offline (fixture) run so the canvas/console have real content
const started = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Mulai|Start|Jalankan/i.test(x.textContent));
  if (b) { b.click(); return b.textContent.trim(); } return 'NO-START-BTN'; })()`);
console.log('start button:', started);
await sleep(4000); // mock stream plays at ~120ms/event
await shot('run-live-light.png');

await clickNav('Review');
await shot('review-light.png');
await clickNav('History');
await shot('history-light.png');
await clickNav('Settings');
await shot('settings-light.png');

// ── Dark pass ──
await reloadWithTheme('dark');
await shot('home-dark.png');
await clickNav('Run');
await shot('run-setup-dark.png');
await clickNav('Review');
await shot('review-dark.png');

// ── Narrow viewport (phone) ──
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await clickNav('Overview');
await sleep(400);
await shot('home-narrow.png');
await clickNav('Run');
await sleep(400);
await shot('run-narrow.png');

ws.close();
chrome.kill();
console.log('done');
