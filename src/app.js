import { ASSETS, CACHE_VERSION } from './cache-manifest.js';
import { CUE_LABELS, TRANSITION_NUMBERS, abort, checkpoint, createSession, futureCues, interrupt, isIdle, isLive, observe, offsetsFromPack, pause, reset, restore, resume, start, summary, view } from './machine.js';
import { createScheduler } from './scheduler.js';
import { exportBundle, importBundle, loadCheckpoint, loadSettings, loadStoredPack, saveCheckpoint, saveRun, saveSettings, saveStoredPack, validPack } from './storage.js';

const $ = (id) => document.getElementById(id);
const scheduler = createScheduler();
const FALLBACK_OFFSETS = {
  goOnsetMs: 0,
  buzzerTailMs: 660,
  numberOnsetMs: Object.fromEntries(TRANSITION_NUMBERS.map((name) => [name, 0])),
  restNoticeMs: 300,
};

let settings = loadSettings();
let session = null;
let season = null;
let armed = null;
let pendingPack = null;
let soundState = 'checking';
let wakeLock = null;
let wakePending = false;
let wakeFailed = false;
let wakeNote = '';
let loggedStatus = '';
let lastCheckpoint = 0;
let registration = null;
let booted = false;
let updateOffered = false;

const ui = {
  phase: $('phase'),
  paused: $('paused'),
  clock: $('clock'),
  secondaryLabel: $('secondary-label'),
  secondaryClock: $('secondary-clock'),
  banner: $('banner'),
  cue: $('cue'),
  meta: $('run-meta'),
  readiness: $('readiness'),
  result: $('result'),
  resultCopy: $('result-copy'),
  resumeRun: $('resume-run'),
  sound: $('sound-status'),
  offline: $('offline-status'),
  wake: $('wake-status'),
  start: $('start'),
  pause: $('pause'),
  resetBtn: $('reset'),
  abort: $('abort'),
  mode: $('mode'),
  ready: $('ready-start'),
  silentStart: $('silent-start'),
};

function text(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function currentFace(now = performance.now()) {
  if (!session) return null;
  return view(session, now, settings.mode, settings.customSeconds);
}

function soundLabel() {
  if (settings.muted && soundState === 'ready') return 'Muted';
  if (settings.silent || soundState === 'silent') return 'Silent mode';
  if (soundState === 'ready') return 'Sound ready';
  if (soundState === 'unavailable') return 'Sound unavailable';
  return 'Checking sound';
}

function paint() {
  const face = currentFace();
  if (!face) return;
  document.body.dataset.accent = face.accent;
  document.body.classList.toggle('is-paused', face.paused);
  text(ui.phase, face.phaseLabel);
  text(ui.clock, face.mainClock);
  text(ui.secondaryLabel, face.secondaryLabel || '');
  text(ui.secondaryClock, face.secondaryClock || '');
  text(ui.banner, face.banner || '');
  text(ui.cue, face.lastCue ? (CUE_LABELS[face.lastCue] || face.lastCue) : '');
  text(ui.meta, `Run ${face.runNumber} · Completed ${face.completedCount}`);
  ui.paused.hidden = !face.paused;
  const terminal = face.status === 'complete' || face.status === 'aborted' || face.status === 'interrupted';
  ui.readiness.hidden = face.status !== 'ready';
  ui.result.hidden = !terminal;
  ui.resumeRun.hidden = face.status !== 'interrupted' || session.run?.resumeStatus === 'rest';
  text(ui.resultCopy, face.status === 'interrupted' ? 'Practice interrupted—restart or resume.' : face.phaseLabel);
  ui.silentStart.hidden = soundState !== 'unavailable' || settings.silent;
  const live = isLive(session);
  const blocked = soundState === 'unavailable' && !settings.silent;
  ui.start.disabled = live || (face.status === 'ready' && blocked);
  ui.ready.disabled = live || blocked;
  ui.pause.disabled = !live && face.status !== 'interrupted';
  text(ui.pause, face.paused || face.status === 'interrupted' ? 'Resume' : 'Pause');
  ui.abort.disabled = !live;
  ui.mode.disabled = live;
  if (document.activeElement !== ui.mode) ui.mode.value = settings.mode;
  text(ui.sound, soundLabel());
  text(ui.wake, wakeNote);
  maybeLog(face);
  maybeSave(performance.now());
}

function maybeLog(face) {
  if (!session.run || !['complete', 'aborted', 'interrupted'].includes(face.status)) return;
  const key = `${session.run.id}:${face.status}`;
  if (loggedStatus === key) return;
  loggedStatus = key;
  saveRun(summary(session));
}

function maybeSave(now) {
  const cp = checkpoint(session, now);
  if (!cp) {
    if (lastCheckpoint !== -1) saveCheckpoint(null);
    lastCheckpoint = -1;
    return;
  }
  if (session.run.status === 'interrupted' || now - lastCheckpoint > 1000) {
    saveCheckpoint(cp);
    lastCheckpoint = now;
  }
}

function runOptions() {
  const pack = armed?.pack;
  return {
    mode: settings.mode,
    repeat: settings.repeat,
    restNotice: settings.restNotice,
    customSeconds: settings.customSeconds,
    warningSeconds: settings.warningEnabled ? Math.min(settings.warningSeconds, settings.customSeconds - 1) : 0,
    offsets: pack ? offsetsFromPack(pack) : FALLBACK_OFFSETS,
    packId: pack?.id || 'practice',
    packVersion: pack?.version || '0',
  };
}

async function ensureAudio() {
  if (settings.silent || !armed) return false;
  try {
    await scheduler.unlock();
    scheduler.setVolume(settings.volume);
    scheduler.setMuted(settings.muted);
    const stamp = `${armed.pack.id}@${armed.pack.version}`;
    if (scheduler.stamp !== stamp) await scheduler.load(armed.pack, armed.files);
    soundState = 'ready';
    return true;
  } catch {
    soundState = 'unavailable';
    paint();
    return false;
  }
}

function apply(step, now = performance.now()) {
  if (!step) return;
  if (step.cancel) scheduler.cancel();
  if (!settings.silent) {
    const queued = [];
    if (Array.isArray(step.schedule)) queued.push(...step.schedule);
    if (Array.isArray(step.due)) queued.push(...step.due);
    if (session?.run && (session.run.status === 'running' || session.run.status === 'rest')) queued.push(...futureCues(session, now));
    if (queued.length) scheduler.schedule(queued, step.elapsedMs);
  }
  paint();
  syncWake();
  maybeActivate();
}

async function begin() {
  if (!session || isLive(session)) return;
  wakeFailed = false;
  if (pendingPack && isIdle(session)) {
    armed = pendingPack;
    pendingPack = null;
    buildSoundboard();
  }
  const audible = await ensureAudio();
  if (!audible && !settings.silent) return;
  scheduler.cancel();
  apply(start(session, performance.now(), runOptions()));
}

async function onResume() {
  if (!session || (session.run?.status !== 'paused' && session.run?.status !== 'interrupted')) return;
  wakeFailed = false;
  await ensureAudio();
  apply(resume(session, performance.now()));
}

function onPause() {
  if (!session?.run) return;
  if (session.run.status === 'paused' || session.run.status === 'interrupted') {
    onResume();
    return;
  }
  apply(pause(session, performance.now()));
}

function onReset() {
  if (!session) return;
  if (isLive(session) || session.run?.status === 'interrupted') $('confirm').showModal();
  else apply(reset(session, performance.now()));
}

function onAbort() {
  if (!isLive(session)) return;
  apply(abort(session, performance.now()));
}

function stopForInterruption(now) {
  if (!session || !isLive(session)) return;
  const last = session.lastObserveMs;
  const discardGap = last != null && now - last > 500;
  apply(interrupt(session, now, discardGap));
  saveCheckpoint(checkpoint(session, now));
  lastCheckpoint = now;
}

function frame(now) {
  if (!booted || !session) {
    requestAnimationFrame(frame);
    return;
  }
  if (session.run && (session.run.status === 'running' || session.run.status === 'rest')) apply(observe(session, now), now);
  else paint();
  requestAnimationFrame(frame);
}

function typing(event) {
  const node = event.target;
  if (!node || typeof node.closest !== 'function') return false;
  return node.closest('input, textarea, select, dialog');
}

function onKey(event) {
  if (!session || event.repeat || typing(event)) return;
  if (event.key === ' ') {
    event.preventDefault();
    if (event.target.closest('button')) return;
    const status = session.run?.status;
    if (!status || status === 'complete' || status === 'aborted') begin();
    else if (status === 'running' || status === 'paused' || status === 'rest') onPause();
    return;
  }
  if (event.key === 'r' || event.key === 'R') onReset();
  else if (event.key === 'f' || event.key === 'F') toggleFullscreen().catch(() => {});
  else if (event.key === 'm' || event.key === 'M') toggleMute();
  else if (event.key === 'Escape' && document.fullscreenElement) document.exitFullscreen();
}

function toggleMute() {
  settings.muted = !settings.muted;
  $('mute').checked = settings.muted;
  saveSettings(settings);
  scheduler.setMuted(settings.muted);
  paint();
}

async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}

function holdWanted() {
  const status = session?.run?.status;
  return !status || status === 'running' || status === 'paused' || status === 'rest';
}

async function syncWake() {
  if (!holdWanted()) {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    return;
  }
  if (!navigator.wakeLock) {
    wakeNote = 'Wake lock unavailable';
    return;
  }
  if (wakeLock || wakePending || wakeFailed) return;
  wakePending = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeNote = '';
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      if (document.visibilityState === 'visible' && holdWanted()) wakeNote = 'Wake lock off';
      paint();
    });
  } catch {
    wakeFailed = true;
    wakeNote = 'Wake lock unavailable';
  } finally {
    wakePending = false;
  }
}

function persist() {
  settings = loadSettings();
  Object.assign(settings, {
    mode: ui.mode.value,
    repeat: $('repeat').checked,
    restNotice: $('rest-notice').checked,
    customSeconds: Number($('custom-seconds').value),
    warningEnabled: $('warning-enabled').checked,
    warningSeconds: Number($('warning-seconds').value),
    volume: Number($('volume').value),
    muted: $('mute').checked,
    silent: $('silent').checked,
  });
  saveSettings(settings);
  settings = loadSettings();
  scheduler.setVolume(settings.volume);
  scheduler.setMuted(settings.muted);
  if (settings.silent) soundState = armed ? 'silent' : soundState;
  else if (armed && soundState !== 'unavailable') soundState = 'ready';
}

function fillSettings() {
  $('repeat').checked = settings.repeat;
  $('rest-notice').checked = settings.restNotice;
  $('custom-seconds').value = String(settings.customSeconds);
  $('warning-enabled').checked = settings.warningEnabled;
  $('warning-seconds').value = String(settings.warningSeconds);
  $('volume').value = String(settings.volume);
  $('mute').checked = settings.muted;
  $('silent').checked = settings.silent;
  ui.mode.value = settings.mode;
}

function buildSoundboard() {
  const board = $('soundboard');
  board.replaceChildren();
  if (!armed) return;
  for (const cue of armed.pack.cues) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = cue.label || CUE_LABELS[cue.id] || cue.id;
    button.addEventListener('click', async () => {
      if (settings.silent) return;
      if (await ensureAudio()) scheduler.play(cue.id);
    });
    board.appendChild(button);
  }
}

async function filesFor(pack, base) {
  const pairs = await Promise.all(pack.cues.map(async (cue) => {
    const response = await fetch(new URL(cue.file, base));
    if (!response.ok) throw new Error(cue.file);
    return [cue.id, await response.arrayBuffer()];
  }));
  return new Map(pairs);
}

async function importPack(fileList) {
  const list = [...fileList];
  const json = list.find((file) => file.name.endsWith('.json'));
  if (!json) throw new Error('Choose the pack metadata file too');
  const pack = JSON.parse(await json.text());
  if (!validPack(pack)) throw new Error('That pack is missing required sound metadata');
  const byName = new Map(list.map((file) => [file.name, file]));
  const stored = {};
  for (const cue of pack.cues) {
    const file = byName.get(cue.file);
    if (!file) throw new Error('Missing ' + cue.file);
    stored[cue.id] = await file.arrayBuffer();
  }
  await saveStoredPack({ id: pack.id, version: pack.version, label: pack.label, cues: pack.cues, files: stored });
  const next = { pack, files: new Map(Object.entries(stored)) };
  settings.packId = pack.id;
  saveSettings(settings);
  if (isLive(session)) {
    pendingPack = next;
    $('pack-note').textContent = 'This pack will be used on the next run.';
  } else {
    armed = next;
    buildSoundboard();
    $('pack-note').textContent = 'Imported pack ready.';
  }
}

function exportLog() {
  const blob = new Blob([JSON.stringify(exportBundle(), null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'practice-timer.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function refreshOffline() {
  if (!('caches' in window)) {
    text(ui.offline, 'Offline unavailable');
    return;
  }
  try {
    const cache = await caches.open(CACHE_VERSION);
    const have = new Set((await cache.keys()).map((key) => key.url));
    const ready = ASSETS.every((path) => have.has(new URL(path, location.href).href));
    text(ui.offline, ready ? 'Offline ready' : 'Saving for offline');
  } catch {
    text(ui.offline, 'Saving for offline');
  }
}

function maybeActivate() {
  if (updateOffered || !registration?.waiting || !isIdle(session)) return;
  updateOffered = true;
  registration.waiting.postMessage({ type: 'idle' });
}

async function boot() {
  if (location.protocol === 'file:') throw new Error('Open this timer at http://127.0.0.1:8766/');
  document.body.dataset.booted = '1';
  settings = loadSettings();
  fillSettings();
  const response = await fetch('./season/biobuzz-2026.json');
  if (!response.ok) throw new Error('Season file missing');
  season = await response.json();
  const saved = loadCheckpoint();
  if (saved?.live && saved.v === 1) {
    try { session = restore(season, saved); } catch { session = createSession(season); }
  } else session = createSession(season);
  booted = true;
  paint();
  try {
    if (settings.packId !== 'practice') {
      const stored = await loadStoredPack(settings.packId);
      if (stored && validPack(stored)) armed = { pack: stored, files: new Map(Object.entries(stored.files || {})) };
    }
    if (!armed) {
      const packRes = await fetch('./assets/sounds/practice/pack.json');
      if (!packRes.ok) throw new Error('Practice pack missing');
      const pack = await packRes.json();
      armed = { pack, files: await filesFor(pack, packRes.url) };
    }
    soundState = settings.silent ? 'silent' : 'ready';
  } catch {
    soundState = settings.silent ? 'silent' : 'unavailable';
  }
  buildSoundboard();
  paint();
  syncWake();
  if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing || !isIdle(session)) return;
      refreshing = true;
      location.reload();
    });
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { type: 'module' });
      registration.addEventListener('updatefound', () => {
        updateOffered = false;
        registration.installing?.addEventListener('statechange', () => {
          refreshOffline();
          maybeActivate();
        });
      });
    } catch { /* local file URLs cannot register a worker */ }
  }
  refreshOffline();
}

ui.start.addEventListener('click', begin);
ui.ready.addEventListener('click', begin);
ui.silentStart.addEventListener('click', () => {
  settings.silent = true;
  soundState = 'silent';
  saveSettings(settings);
  $('silent').checked = true;
  begin();
});
$('test-sound').addEventListener('click', async () => {
  if (await ensureAudio()) scheduler.play('charge');
  paint();
});
ui.pause.addEventListener('click', onPause);
ui.resumeRun.addEventListener('click', onResume);
$('run-again').addEventListener('click', begin);
ui.resetBtn.addEventListener('click', onReset);
ui.abort.addEventListener('click', onAbort);
ui.mode.addEventListener('change', () => {
  settings.mode = ui.mode.value;
  saveSettings(settings);
  paint();
});
$('fullscreen').addEventListener('click', () => toggleFullscreen().catch(() => {}));
$('settings-open').addEventListener('click', () => $('settings').showModal());
$('settings').addEventListener('change', persist);
$('settings').addEventListener('close', persist);
$('confirm').addEventListener('close', () => {
  if ($('confirm').returnValue === 'reset') apply(reset(session, performance.now()));
});
$('export-log').addEventListener('click', exportLog);
$('import-log').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  settings = importBundle(JSON.parse(await file.text())).settings;
  fillSettings();
  persist();
});
$('import-pack').addEventListener('change', async (event) => {
  try { await importPack(event.target.files); } catch (error) { $('pack-note').textContent = error.message; }
});
document.addEventListener('keydown', onKey);
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
});
let chromeTimer = 0;
document.addEventListener('pointermove', () => {
  document.body.classList.add('show-chrome');
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => document.body.classList.remove('show-chrome'), 1800);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopForInterruption(performance.now());
  else {
    wakeFailed = false;
    syncWake();
  }
});
window.addEventListener('pagehide', () => stopForInterruption(performance.now()));
window.addEventListener('freeze', () => stopForInterruption(performance.now()));

boot().catch((error) => {
  ui.phase.textContent = 'READY';
  ui.banner.textContent = error.message;
  ui.sound.textContent = 'Not loaded';
});
requestAnimationFrame(frame);
