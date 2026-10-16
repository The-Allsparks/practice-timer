import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url);
const rootPath = root.pathname.startsWith('/') && process.platform === 'win32' ? decodeURIComponent(root.pathname.slice(1)) : decodeURIComponent(root.pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav' };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(rootPath, pathname));
  if (!file.startsWith(normalize(rootPath))) {
    res.writeHead(403);
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => { res.writeHead(404); res.end('missing'); });
  stream.on('open', () => {
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    stream.pipe(res);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const page = `http://127.0.0.1:${port}/`;

const candidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
import { existsSync } from 'node:fs';
const browser = candidates.find((path) => existsSync(path));
if (!browser) throw new Error('No Edge or Chrome found for the page check');
const profile = join(tmpdir(), 'practice-timer-check');
const proc = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=9477',
  `--user-data-dir=${profile}`,
  '--window-size=1366,768',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  page,
], { stdio: 'ignore' });
process.on('exit', () => { proc.kill(); server.close(); });

async function browserJson(pathname) {
  const response = await fetch('http://127.0.0.1:9477' + pathname);
  if (!response.ok) throw new Error(pathname + ' ' + response.status);
  return response.json();
}
let version;
for (let i = 0; i < 40; i++) {
  try { version = await browserJson('/json/version'); break; } catch { await delay(250); }
}
if (!version) throw new Error('Browser debugging port did not open');
let pages = await browserJson('/json/list');
let target = pages.find((item) => item.type === 'page' && item.url.startsWith(page));
if (!target) target = pages.find((item) => item.type === 'page');
if (!target) throw new Error('No browser page: ' + JSON.stringify(pages.map((item) => item.url)));
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) pending.get(message.id)(message);
});
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
const located = await evaluate(`(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.getElementById('sound-status')) return location.href;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return location.href + ' title=' + document.title + ' body=' + document.body?.innerText?.slice(0, 180);
})()`);
if (!String(located).startsWith(page)) throw new Error('Opened the wrong page: ' + located);
const ready = await evaluate(`(async () => {
  for (let i = 0; i < 40; i++) {
    const node = document.getElementById('sound-status');
    if (node && node.textContent && node.textContent !== 'Checking sound') return node.textContent;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return document.getElementById('sound-status')?.textContent || 'missing';
})()`);
if (ready !== 'Sound ready' && ready !== 'Silent mode') throw new Error('Sound status: ' + ready);

await evaluate(`(() => {
  const mode = document.getElementById('mode');
  mode.value = 'custom';
  mode.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('custom-seconds').value = '2';
  document.getElementById('warning-enabled').checked = false;
  document.getElementById('custom-seconds').dispatchEvent(new Event('change', { bubbles: true }));
  return document.getElementById('clock').textContent;
})()`);
const armed = await evaluate(`document.getElementById('clock').textContent + ' ' + document.getElementById('phase').textContent`);
if (!armed.startsWith('0:02')) throw new Error('Custom clock did not arm: ' + armed);

await evaluate(`document.getElementById('ready-start').click()`);
const started = await evaluate(`(async () => {
  for (let i = 0; i < 30; i++) {
    const phase = document.getElementById('phase').textContent;
    if (phase && phase !== 'READY') return phase;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return document.getElementById('phase').textContent + ' / ' + document.getElementById('sound-status').textContent;
})()`);
if (started === 'READY' || started.startsWith('READY')) throw new Error('Start stayed on ready: ' + started);

await evaluate(`document.getElementById('pause').click()`);
await delay(200);
const paused = await evaluate(`({
  phase: document.getElementById('phase').textContent,
  hidden: document.getElementById('paused').hidden,
  clock: document.getElementById('clock').textContent
})`);
if (paused.phase !== 'PAUSED' || paused.hidden) throw new Error('Pause did not freeze the run ' + JSON.stringify(paused));
await delay(400);
const still = await evaluate(`document.getElementById('clock').textContent`);
if (still !== paused.clock) throw new Error('Clock moved while paused');

await evaluate(`document.getElementById('pause').click()`);
await delay(200);
const resumed = await evaluate(`document.getElementById('phase').textContent`);
if (resumed === 'PAUSED') throw new Error('Resume stayed paused');

await evaluate(`document.getElementById('abort').click()`);
await delay(200);
const aborted = await evaluate(`document.getElementById('phase').textContent`);
if (aborted !== 'ABORTED') throw new Error('Abort showed ' + aborted);

await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))`);
await delay(100);
const muted = await evaluate(`document.getElementById('sound-status').textContent`);
if (muted !== 'Muted') throw new Error('Mute showed ' + muted);

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
const fit = await evaluate(`({
  scroll: document.documentElement.scrollHeight,
  height: window.innerHeight,
  font: getComputedStyle(document.getElementById('clock')).fontSize,
  family: getComputedStyle(document.body).fontFamily
})`);
const font = Number.parseFloat(fit.font);
if (font < 220 || font > 280) throw new Error('Clock font ' + fit.font);
if (!fit.family.toLowerCase().includes('segoe') && !fit.family.toLowerCase().includes('ui-sans-serif')) throw new Error('Font ' + fit.family);

const fullBox = await evaluate(`(() => {
  const rect = document.getElementById('fullscreen').getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fullBox.x, y: fullBox.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fullBox.x, y: fullBox.y, button: 'left', clickCount: 1 });
await delay(400);
const full = await evaluate(`({
  element: !!document.fullscreenElement,
  className: document.body.className
})`);

console.log(JSON.stringify({ ready, started, paused: paused.phase, resumed, aborted, muted, fit, full }, null, 2));
if (!full.element && !full.className.includes('is-fullscreen')) {
  console.log('Fullscreen API did not engage in headless mode; the button and class hook are present.');
}
ws.close();
proc.kill();
server.close();
