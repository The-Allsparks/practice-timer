const SETTINGS_KEY = 'practice-timer.settings';
const RUNS_KEY = 'practice-timer.runs';
const CHECKPOINT_KEY = 'practice-timer.checkpoint';

export const DEFAULT_SETTINGS = {
  mode: 'full',
  repeat: false,
  restNotice: false,
  customSeconds: 20,
  warningSeconds: 5,
  warningEnabled: false,
  volume: 0.8,
  muted: false,
  silent: false,
  packId: 'practice',
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const RUN_KEYS = ['id', 'mode', 'status', 'time', 'activeDurationMs', 'pauseCount', 'packVersion'];

export function sanitizeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return next;
  for (const key of SETTING_KEYS) {
    if (raw[key] !== undefined) next[key] = raw[key];
  }
  next.repeat = !!next.repeat;
  next.restNotice = !!next.restNotice;
  next.warningEnabled = !!next.warningEnabled;
  next.muted = !!next.muted;
  next.silent = !!next.silent;
  next.volume = Math.min(1, Math.max(0, Number(next.volume) || 0));
  next.customSeconds = clamp(next.customSeconds, 1, 600, 20);
  next.warningSeconds = clamp(next.warningSeconds, 1, 599, 5);
  if (!['full', 'auto', 'transition', 'teleop', 'final20', 'custom'].includes(next.mode)) next.mode = 'full';
  if (typeof next.packId !== 'string' || !next.packId) next.packId = 'practice';
  return next;
}

export function sanitizeRun(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const next = {};
  for (const key of RUN_KEYS) next[key] = raw[key];
  next.activeDurationMs = Number(next.activeDurationMs) || 0;
  next.pauseCount = Number(next.pauseCount) || 0;
  next.packVersion = String(next.packVersion || '');
  return next;
}

export function validPack(pack) {
  if (!pack || typeof pack.id !== 'string' || typeof pack.version !== 'string' || !Array.isArray(pack.cues)) return false;
  return pack.cues.every((cue) => cue && typeof cue.id === 'string' && typeof cue.file === 'string' && Number.isFinite(cue.durationMs) && typeof cue.source === 'string' && typeof cue.license === 'string' && cue.trim && cue.alignment && Number.isFinite(cue.alignment.offsetMs));
}

function clamp(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadSettings() {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
  } catch {
    return sanitizeSettings(null);
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
}

export function loadRuns() {
  try {
    const raw = JSON.parse(localStorage.getItem(RUNS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeRun).filter(Boolean).slice(0, 50);
  } catch {
    return [];
  }
}

export function saveRun(entry) {
  const clean = sanitizeRun(entry);
  if (!clean) return;
  const runs = loadRuns().filter((run) => run.id !== clean.id);
  runs.unshift(clean);
  localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(0, 50)));
}

export function loadCheckpoint() {
  try {
    return JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveCheckpoint(data) {
  if (!data) localStorage.removeItem(CHECKPOINT_KEY);
  else localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(data));
}

export function exportBundle() {
  return { settings: loadSettings(), runs: loadRuns() };
}

export function importBundle(data) {
  if (!data || typeof data !== 'object') throw new Error('Import a practice timer file');
  if (data.settings) saveSettings(data.settings);
  if (Array.isArray(data.runs)) {
    const runs = data.runs.map(sanitizeRun).filter(Boolean).slice(0, 50);
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
  }
  return { settings: loadSettings(), runs: loadRuns() };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('practice-timer', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('packs', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveStoredPack(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('packs', 'readwrite');
    tx.objectStore('packs').put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadStoredPack(id) {
  const db = await openDb();
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction('packs', 'readonly');
    const request = tx.objectStore('packs').get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return record;
}
