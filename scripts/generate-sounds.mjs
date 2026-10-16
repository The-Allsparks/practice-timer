import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeWav, encodeWav, trim } from './wavlib.js';

const RATE = 44100;
const OUT = new URL('../assets/sounds/practice/', import.meta.url);
const SOURCE = 'Generated for The Allsparks practice pack. Not an FTC Live recording.';
const LICENSE = 'Original Allsparks practice audio. Free to copy for team practice.';

function silence(seconds) {
  return new Float32Array(Math.round(seconds * RATE));
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function fade(samples) {
  const n = Math.min(samples.length >> 1, Math.round(RATE * 0.008));
  for (let i = 0; i < n; i++) {
    const gain = i / n;
    samples[i] *= gain;
    samples[samples.length - 1 - i] *= gain;
  }
  return samples;
}

function tone(seconds, amp, sample) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const freq = sample(t, seconds);
    phase += freq / RATE;
    out[i] = Math.sin(2 * Math.PI * phase) * amp(t, seconds);
  }
  return fade(out);
}

function squareBurst(freq, seconds, amp = 0.8) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const edge = Math.min(1, t / 0.004, (seconds - t) / 0.004);
    const low = Math.sin(2 * Math.PI * freq * t) >= 0 ? 1 : -1;
    const high = Math.sin(2 * Math.PI * freq * 1.5 * t) >= 0 ? 1 : -1;
    out[i] = amp * edge * (0.75 * low + 0.25 * high);
  }
  return out;
}

function note(freq, seconds, amp = 0.72) {
  return tone(seconds, (t) => amp * Math.exp(-t * 2.4), () => freq);
}

function charge() {
  // Original bugle-shaped call. FIRST does not publish the Live cavalry charge for reuse.
  const gap = silence(0.025);
  return concat([note(392, 0.11), gap, note(523, 0.11), gap, note(659, 0.11), gap, note(784, 0.2)]);
}

function buzzers() {
  const pulse = squareBurst(640, 0.14, 0.88);
  const gap = silence(0.07);
  return concat([pulse, gap, pulse, gap, pulse]);
}

function bells() {
  const bell = tone(0.32, (t) => 0.72 * Math.exp(-t * 9), () => 880);
  const gap = silence(0.06);
  return concat([bell, gap, bell, gap, bell]);
}

function chime() {
  return tone(0.9, (t) => 0.45 * Math.exp(-t * 3), (t) => (t < 0.08 ? 784 : 1046));
}

function whistle() {
  const n = Math.round(0.85 * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const amp = 0.8 * Math.exp(-Math.max(0, t - 0.55) * 6);
    out[i] = amp * (0.6 * Math.sin(2 * Math.PI * 920 * t) + 0.4 * Math.sin(2 * Math.PI * 1100 * t));
  }
  return fade(out);
}

function endBuzzer() {
  // Three-second match-end buzzer. High and chopped so a laptop speaker
  // cannot miss it. A low tone at the end of a long match disappears.
  const n = Math.round(3 * RATE);
  const out = new Float32Array(n);
  let noise = 0;
  let seed = 1;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const random = seed / 4294967296;
    noise = noise * 0.55 + (random * 2 - 1) * 0.45;
    const chop = Math.sin(2 * Math.PI * 28 * t) >= 0 ? 1 : 0.45;
    const high = Math.sin(2 * Math.PI * 1800 * t) >= 0 ? 1 : -1;
    const higher = Math.sin(2 * Math.PI * 2400 * t) >= 0 ? 1 : -1;
    out[i] = 0.97 * chop * (0.62 * high + 0.28 * higher + 0.1 * noise);
  }
  return fade(out);
}

function foghorn() {
  const n = Math.round(1.6 * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const gate = 0.45 + 0.55 * Math.sin(2 * Math.PI * 1.5 * t) ** 2;
    const body = 0.45 * Math.sin(2 * Math.PI * 110 * t) + 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.28 * Math.sin(2 * Math.PI * 330 * t);
    out[i] = 0.9 * gate * body;
  }
  return fade(out);
}

function restNotice() {
  const high = tone(0.12, () => 0.45, () => 880);
  const low = tone(0.12, () => 0.45, () => 660);
  return concat([high, silence(0.06), low]);
}

function speak(phrases) {
  const dir = mkdtempSync(join(tmpdir(), 'practice-speech-'));
  const lines = [
    'Add-Type -AssemblyName System.Speech',
    'function Speak([string]$text, [string]$path, [int]$rate) {',
    '  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '  $synth.Rate = $rate',
    '  $synth.SetOutputToWaveFile($path)',
    '  $synth.Speak($text)',
    '  $synth.Dispose()',
    '}',
  ];
  const jobs = phrases.map((phrase) => {
    const file = join(dir, phrase.id + '.wav');
    lines.push(`Speak '${phrase.text.replaceAll("'", "''")}' '${file.replaceAll("'", "''")}' ${phrase.rate}`);
    return { ...phrase, file };
  });
  const script = join(dir, 'speak.ps1');
  writeFileSync(script, lines.join('\r\n'), 'utf8');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(result.stderr || result.stdout || 'Speech synthesis failed');
  }
  return { dir, jobs };
}

function cueRecord(id, label, file, measured, point) {
  return {
    id,
    label,
    file,
    durationMs: measured.durationMs,
    onsetMs: measured.onsetMs,
    tailMs: measured.tailMs,
    source: SOURCE,
    license: LICENSE,
    trim: { headMs: measured.headMs, tailMs: measured.tailMsTrimmed },
    alignment: { point, offsetMs: point === 'tail' ? measured.tailMs : point === 'onset' ? measured.onsetMs : 0 },
  };
}

function writeCue(id, samples, rate) {
  const measured = trim(samples, rate);
  const name = `${id}.wav`;
  writeFileSync(new URL(name, OUT), encodeWav(measured.samples, rate));
  return measured;
}

const tones = [
  ['charge', 'Charge', charge(), 'start'],
  ['buzzers', 'Buzzers', buzzers(), 'start'],
  ['bells', 'Bells', bells(), 'start'],
  ['chime', 'Chime', chime(), 'start'],
  ['whistle', 'Whistle', whistle(), 'start'],
  ['end', 'End buzzer', endBuzzer(), 'start'],
  ['foghorn', 'Foghorn', foghorn(), 'start'],
  ['rest-notice', 'Rest notice', restNotice(), 'start'],
];

mkdirSync(OUT, { recursive: true });
const cues = [];
for (const [id, label, samples, point] of tones) {
  const measured = writeCue(id, samples, RATE);
  cues.push(cueRecord(id, label, `${id}.wav`, measured, point));
  console.log(id, measured.durationMs + 'ms');
}

const spoken = speak([
  { id: 'eight', text: 'eight', rate: 0, label: 'Eight' },
  { id: 'seven', text: 'seven', rate: 0, label: 'Seven' },
  { id: 'six', text: 'six', rate: 0, label: 'Six' },
  { id: 'five', text: 'five', rate: 0, label: 'Five' },
  { id: 'four', text: 'four', rate: 0, label: 'Four' },
  { id: 'three', text: 'three', rate: 0, label: 'Three' },
  { id: 'two', text: 'two', rate: 0, label: 'Two' },
  { id: 'one', text: 'one', rate: 0, label: 'One' },
  { id: 'go', text: 'go', rate: 0, label: 'GO' },
  { id: 'pickup', text: 'Drivers, pick up your controllers.', rate: 1, label: 'Pick up controllers', gain: 0.55 },
]);

const onsetIds = new Set(['go', 'eight', 'seven', 'six', 'five', 'four', 'three', 'two', 'one']);
try {
  for (const job of spoken.jobs) {
    const decoded = decodeWav(readFileSync(job.file));
    const samples = job.gain ? decoded.samples.map((sample) => sample * job.gain) : decoded.samples;
    const point = onsetIds.has(job.id) ? 'onset' : job.id === 'pickup' ? 'after-buzzer' : 'start';
    const measured = writeCue(job.id, samples, decoded.rate);
    cues.push(cueRecord(job.id, job.label, `${job.id}.wav`, measured, point));
    console.log(job.id, measured.durationMs + 'ms', 'tail', measured.tailMs);
  }
} finally {
  rmSync(spoken.dir, { recursive: true, force: true });
}

rmSync(new URL('countdown.wav', OUT), { force: true });
const order = ['charge', 'eight', 'seven', 'six', 'five', 'four', 'three', 'two', 'one', 'go', 'buzzers', 'pickup', 'bells', 'chime', 'whistle', 'end', 'foghorn', 'rest-notice'];
cues.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const pack = { id: 'practice', version: '3', label: 'Practice sounds', cues };
writeFileSync(new URL('pack.json', OUT), JSON.stringify(pack, null, 2) + '\n');
console.log('Practice pack written');
