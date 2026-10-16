import { readFileSync, readdirSync } from 'node:fs';
import { ASSETS } from '../src/cache-manifest.js';
import { checkpoint, restore } from '../src/machine.js';
import { armLimits, cueAudioTime, shouldArm } from '../src/scheduler.js';
import { sanitizeRun, sanitizeSettings, validPack } from '../src/storage.js';
import { decodeWav, measure } from '../scripts/wavlib.js';
import { TRANSITION_NUMBERS, abort, advance, ceilingSeconds, createSession, formatClock, interrupt, observe, offsetsFromPack, pause, present, reset, resume, start, view } from '../src/machine.js';

const season = JSON.parse(readFileSync(new URL('../season/biobuzz-2026.json', import.meta.url), 'utf8'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(season.locked === true, 'season profile stays locked');
assert(season.countInSeconds === 3, 'count-in is outside the match');
assert(season.restSeconds === 60, 'rest is 60 seconds');
for (const [name, sec] of [['autoStart', 0], ['autoEnd', 30], ['teleopStart', 38], ['flower', 98], ['final20', 138], ['matchEnd', 158]]) {
  assert(season.boundaries[name] === sec, name);
}

assert(ceilingSeconds(150) === 150, 'exact ceiling');
assert(ceilingSeconds(149.001) === 150, 'fraction stays on the higher second');
assert(ceilingSeconds(149) === 149, 'exact second steps down');
assert(ceilingSeconds(0.001) === 1, 'last partial second shows 0:01');
assert(ceilingSeconds(0) === 0, 'exact zero');
assert(formatClock(150) === '2:30', '2:30');
assert(formatClock(0) === '0:00', '0:00');
assert(formatClock(8) === '0:08', '0:08');

const at0 = present(season, 0);
assert(at0.phase === 'auto' && at0.mainClock === '2:30', 'AUTO opens at 2:30');
assert(present(season, 0.999).mainClock === '2:30', '2:30 stays up for its whole second');
assert(present(season, 1).mainClock === '2:29', 'clock steps at the next exact second');
assert(present(season, 29).mainClock === '2:01', 'last AUTO second');
assert(present(season, 29.999).phase === 'auto' && present(season, 29.999).mainClock === '2:01', 'still AUTO just before 30');

const transition = present(season, 30);
assert(transition.phase === 'transition' && transition.mainClock === '2:00', 'main clock freezes at 2:00');
assert(transition.secondaryClock === '0:08', 'transition opens at 0:08');
assert(present(season, 30.5).secondaryClock === '0:08', '0:08 holds through its second');
assert(present(season, 37).secondaryClock === '0:01', '0:01');
assert(present(season, 37.999).secondaryClock === '0:01', '0:01 holds until TELEOP');
for (let ms = 30000; ms < 38000; ms += 10) {
  const view = present(season, ms / 1000);
  assert(view.phase === 'transition', 'transition span ' + ms);
  assert(view.mainClock === '2:00', 'frozen clock ' + ms);
  assert(view.secondaryClock !== '0:00', 'transition never sits on 0:00 at ' + ms);
}

const teleop = present(season, 38);
assert(teleop.phase === 'teleop' && teleop.mainClock === '2:00', 'TELEOP resumes at 2:00');
assert(teleop.secondaryClock == null, 'TELEOP replaces the transition countdown');
assert(teleop.banner === 'FLOWER OWNERSHIP LOCKED', 'flower starts locked');
assert(present(season, 97.999).banner === 'FLOWER OWNERSHIP LOCKED', 'still locked just before 98');
assert(present(season, 98).banner === 'FLOWER OWNERSHIP UNLOCKED', 'unlocks at 98');
assert(present(season, 98).mainClock === '1:00', 'one minute left at the flower');
assert(present(season, 137.999).phase === 'teleop', 'final 20 has not started');
assert(present(season, 138).phase === 'final20' && present(season, 138).banner === 'FINAL 20 SECONDS', 'final 20');
assert(present(season, 138).mainClock === '0:20', '0:20 at the whistle');
assert(present(season, 157.999).mainClock === '0:01' && present(season, 157.999).phase === 'final20', '0:01 until the endpoint');
assert(present(season, 158).phase === 'complete' && present(season, 158).mainClock === '0:00', '0:00 only at the exact endpoint');

console.log('Ceiling clock passed');

const OFFSETS = {
  goOnsetMs: 40,
  buzzerTailMs: 900,
  numberOnsetMs: Object.fromEntries(TRANSITION_NUMBERS.map((name) => [name, 0])),
  restNoticeMs: 400,
};
const TRANSITION_KEYS = ['n8', 'n7', 'n6', 'n5', 'n4', 'n3', 'n2', 'n1'];

function boot(now = 0) {
  const session = createSession(season);
  const started = start(session, now, { mode: 'full', offsets: OFFSETS, repeat: false, packVersion: 'test' });
  return { session, started };
}

function keysOf(cues) {
  return cues.map((cue) => cue.key);
}

const opened = boot();
const scheduled = keysOf(opened.started.schedule);
for (const key of ['three', 'two', 'one', 'go', 'charge', 'buzzers', 'pickup', ...TRANSITION_KEYS, 'bells', 'chime', 'whistle', 'end']) {
  assert(scheduled.filter((item) => item === key).length === 1, 'scheduled once ' + key);
}
assert(new Set(opened.started.schedule.map((cue) => cue.id)).size === scheduled.length, 'cue ids are unique');
assert(opened.started.schedule.every((cue) => cue.id.startsWith(opened.session.run.id + ':')), 'cue ids belong to the run');

const go = opened.session.run.cues.find((cue) => cue.key === 'go');
const charge = opened.session.run.cues.find((cue) => cue.key === 'charge');
const buzzers = opened.session.run.cues.find((cue) => cue.key === 'buzzers');
const pickup = opened.session.run.cues.find((cue) => cue.key === 'pickup');
const bells = opened.session.run.cues.find((cue) => cue.key === 'bells');
const countInMs = season.countInSeconds * 1000;
assert(go.atMs + OFFSETS.goOnsetMs === countInMs, 'GO onset lands on AUTO start');
assert(charge.atMs === countInMs, 'charge starts with AUTO');
assert(pickup.atMs === buzzers.atMs + OFFSETS.buzzerTailMs, 'pickup starts after the buzzer tail');
TRANSITION_NUMBERS.forEach((name, index) => {
  const item = opened.session.run.cues.find((cue) => cue.key === `n${8 - index}`);
  const boundary = countInMs + (30 + index) * 1000;
  const onset = item.atMs + OFFSETS.numberOnsetMs[name];
  if (index === 0) {
    assert(onset === buzzers.atMs + OFFSETS.buzzerTailMs, 'eight starts when the buzzer finishes');
    assert(onset < boundary + 1000, 'eight is still the 0:08 second');
  } else {
    assert(onset === boundary, name + ' starts on its transition second');
  }
});
assert(opened.session.run.cues.find((cue) => cue.key === 'n1').atMs + 1000 === bells.atMs, 'one is the second before TELEOP');

function cross(matchMs) {
  const session = boot().session;
  const early = season.countInSeconds * 1000 + matchMs - 50;
  advance(session, early);
  return { session, earlyView: view(session, early) };
}

const autoEdge = cross(30000);
assert(autoEdge.earlyView.phase === 'auto', 'still AUTO 50ms before the end');
advance(autoEdge.session, 33000);
assert(view(autoEdge.session, 33000).phase === 'transition', 'transition at +30s');
assert(!boot().session.run.fired.some((id) => id.endsWith(':buzzers')), 'start does not fire the buzzer early');

const buzz = boot();
advance(buzz.session, buzzers.atMs - 50);
assert(!buzz.session.run.fired.some((id) => id.endsWith(':buzzers')), 'buzzer does not cross 50ms early');
const buzzStep = advance(buzz.session, buzzers.atMs);
assert(keysOf(buzzStep.due).includes('buzzers'), 'buzzer crosses on its boundary');

const marks = {};
const sweep = boot().session;
const seen = [];
let bannerBeforeFlower = null;
for (let match = 0; match <= 158000; match += 10) {
  const now = 3000 + match;
  const step = advance(sweep, now);
  const face = view(sweep, now);
  if (marks[face.phase] === undefined) marks[face.phase] = match;
  if (match === 97990) bannerBeforeFlower = face.banner;
  for (const cue of step.due) seen.push(cue.key);
  if (match < 158000) assert(face.mainClock === present(season, match / 1000).mainClock, 'machine clock matches ceiling at ' + match);
}
assert(marks.auto === 0, 'AUTO at the start');
assert(marks.transition === 30000, 'transition within 50ms');
assert(marks.teleop === 38000, 'teleop within 50ms');
assert(marks.final20 === 138000, 'final 20 within 50ms');
assert(marks.complete === 158000, 'complete within 50ms');
assert(bannerBeforeFlower === 'FLOWER OWNERSHIP LOCKED', 'locked 10ms early');
const flower = boot();
advance(flower.session, 3000 + 98000 - 50);
assert(!flower.session.run.fired.some((id) => id.endsWith(':chime')), 'chime is not 50ms early');
advance(flower.session, 3000 + 98000);
assert(flower.session.run.fired.some((id) => id.endsWith(':chime')), 'chime at +98s');
for (const key of ['buzzers', 'bells', 'chime', 'whistle', 'end']) {
  assert(seen.filter((item) => item === key).length === 1, 'one-shot ' + key);
}
assert(view(sweep, 3000 + 158000).mainClock === '0:00', 'endpoint display');

console.log('Full-match machine passed');

function begin(mode, extra = {}) {
  const session = createSession(season);
  const started = start(session, 0, { mode, offsets: OFFSETS, repeat: false, packVersion: 'test', ...extra });
  return { session, started };
}

function collect(mode, until, extra) {
  const { session } = begin(mode, extra);
  const seen = [];
  for (let now = 0; now <= until; now += 20) {
    for (const cue of advance(session, now).due) seen.push(cue.key);
  }
  return { session, seen };
}

const auto = collect('auto', 33000);
assert(auto.seen.includes('buzzers'), 'AUTO ends with buzzers');
assert(auto.seen.includes('charge'), 'AUTO starts with the charge');
assert(!auto.seen.includes('end'), 'AUTO does not play the match-end buzzer');
assert(!auto.seen.includes('bells') && !auto.seen.includes('pickup') && !auto.seen.includes('n8'), 'AUTO stops before transition');
assert(view(auto.session, 33000).phase === 'complete' && view(auto.session, 33000).mainClock === '2:00', 'AUTO completes at 2:00');
const autoEarly = begin('auto');
advance(autoEarly.session, 32950);
assert(view(autoEarly.session, 32950).phase === 'auto', 'AUTO is still running 50ms early');

const transitionDrill = begin('transition');
advance(transitionDrill.session, 3000);
const transitionFace = view(transitionDrill.session, 3000);
assert(transitionFace.phase === 'transition' && transitionFace.secondaryClock === '0:08', 'transition drill opens on the countdown');
const transitionRun = collect('transition', 3000 + 128000);
for (const key of ['buzzers', 'pickup', ...TRANSITION_KEYS, 'bells', 'chime', 'whistle', 'end']) {
  assert(transitionRun.seen.filter((item) => item === key).length === 1, 'transition cue ' + key);
}
assert(!transitionRun.seen.includes('charge'), 'transition drill does not replay the match start');
assert(view(transitionRun.session, 3000 + 128000).phase === 'complete', 'transition drill runs through the match end');

const teleopDrill = begin('teleop');
advance(teleopDrill.session, 3000);
assert(view(teleopDrill.session, 3000).phase === 'teleop' && view(teleopDrill.session, 3000).banner === 'FLOWER OWNERSHIP LOCKED', 'TELEOP drill opens at 2:00 locked');
assert(teleopDrill.session.run.fired.some((id) => id.endsWith(':bells')), 'bells mark TELEOP start');
const teleopRun = collect('teleop', 3000 + 120000);
assert(!teleopRun.seen.includes('buzzers'), 'TELEOP drill has no auto buzzer');
assert(teleopRun.seen.filter((item) => item === 'end').length === 1, 'TELEOP drill ends the match');

const final20 = begin('final20');
advance(final20.session, 3000);
assert(view(final20.session, 3000).phaseLabel === 'FINAL 20' && view(final20.session, 3000).banner === 'FINAL 20 SECONDS', 'final 20 label');
assert(final20.session.run.fired.some((id) => id.endsWith(':whistle')), 'whistle at the start of final 20');
advance(final20.session, 23000 - 1);
assert(view(final20.session, 22999).mainClock === '0:01', 'final 20 holds 0:01');
const finalEnd = advance(final20.session, 23000);
assert(keysOf(finalEnd.due).includes('end') && view(final20.session, 23000).mainClock === '0:00', 'end buzzer at zero');
assert(!final20.session.run.fired.some((id) => id.endsWith(':chime')), 'final 20 is not the full match');

const custom = begin('custom', { customSeconds: 10, warningSeconds: 3 });
advance(custom.session, 4000);
assert(view(custom.session, 4000).phaseLabel === 'CUSTOM', 'custom label');
advance(custom.session, 9999);
assert(view(custom.session, 9999).banner == null, 'warning has not started');
const warned = advance(custom.session, 10000);
assert(keysOf(warned.due).includes('warning') && view(custom.session, 10000).banner === 'WARNING', 'optional warning');
advance(custom.session, 13000);
assert(view(custom.session, 13000).phase === 'complete' && view(custom.session, 13000).mainClock === '0:00', 'custom ends at zero');
const silentCustom = collect('custom', 8000, { customSeconds: 5, warningSeconds: 0 });
assert(!silentCustom.seen.includes('warning'), 'warning is optional');

const held = begin('full', { repeat: true });
advance(held.session, 10000);
const frozen = view(held.session, 10000).mainClock;
pause(held.session, 10000);
advance(held.session, 15000);
assert(held.session.run.status === 'paused' && view(held.session, 15000).mainClock === frozen, 'pause freezes the clock');
const continued = resume(held.session, 15000);
const continuedKeys = keysOf(continued.schedule);
assert(!continuedKeys.includes('go') && !continuedKeys.includes('three') && continuedKeys.includes('buzzers'), 'resume returns only future cues');
const replay = advance(held.session, 38000);
assert(keysOf(replay.due).includes('buzzers'), 'the buzzer still arrives on match time');
advance(held.session, 39000);
assert(!advance(held.session, 40000).due.some((cue) => cue.key === 'buzzers'), 'pause and resume do not replay a cue');
advance(held.session, 15000 + (161000 - 10000));
assert(view(held.session, 15000 + 151000).phase === 'complete', 'pause cancels automatic repeat');

const resting = begin('custom', { customSeconds: 1, repeat: true });
advance(resting.session, 4000);
assert(resting.session.run.status === 'rest' && resting.session.completedCount === 1, 'repeat rests after complete');
advance(resting.session, 4000 + 59950);
assert(resting.session.run.status === 'rest', 'rest lasts the full minute');
advance(resting.session, 4000 + 60000);
assert(view(resting.session, 64000).phase === 'countIn' && resting.session.runNumber === 2, 'rest returns to count-in');

const noticed = begin('custom', { customSeconds: 1, repeat: true, restNotice: true });
advance(noticed.session, 4000);
const notice = advance(noticed.session, 64000);
assert(keysOf(notice.schedule || []).includes('rest-notice') && noticed.session.run.status === 'rest', 'rest notice plays at the end of rest');
advance(noticed.session, 64400);
assert(view(noticed.session, 64400).phase === 'countIn', 'count-in follows the rest notice');

const stoppedRest = begin('custom', { customSeconds: 1, repeat: true });
advance(stoppedRest.session, 4000);
pause(stoppedRest.session, 4000);
advance(stoppedRest.session, 80000);
assert(stoppedRest.session.run.status === 'complete' && stoppedRest.session.runNumber === 1, 'pause during rest cancels the restart');

const wiped = begin('custom', { customSeconds: 1, repeat: true });
advance(wiped.session, 4000);
reset(wiped.session, 4000);
advance(wiped.session, 80000);
assert(wiped.session.run == null && view(wiped.session, 80000).phase === 'ready', 'reset cancels a pending repeat');
assert(!(reset(begin('full').session, 10).schedule || []).some((cue) => cue.key === 'foghorn'), 'reset does not play the foghorn');

const halted = begin('full', { repeat: true });
advance(halted.session, 5000);
const haltedStep = abort(halted.session, 5000);
assert(keysOf(haltedStep.due).join() === 'foghorn', 'foghorn plays only for abort');
advance(halted.session, 200000);
assert(halted.session.run.status === 'aborted' && !halted.session.run.fired.some((id) => id.endsWith(':end')), 'abort cancels the rest of the run');

const broken = begin('custom', { customSeconds: 5, repeat: true });
advance(broken.session, 1000);
interrupt(broken.session, 1000);
assert(broken.session.run.status === 'interrupted', 'interrupt stops the run');
resume(broken.session, 1000);
advance(broken.session, 8000);
assert(view(broken.session, 8000).phase === 'complete', 'interruption cancels automatic repeat');

const gapped = begin('full');
observe(gapped.session, 100);
const gap = observe(gapped.session, 700);
assert(gap.view.status === 'interrupted', 'a 600ms gap interrupts');
assert(!gapped.session.run.fired.some((id) => id.endsWith(':two')), 'a gap does not play missed cues');
assert(gapped.session.run.elapsedMs === 100, 'a gap does not move the match clock');
const steady = begin('full');
observe(steady.session, 100);
assert(observe(steady.session, 500).view.status === 'running', '400ms does not interrupt');

console.log('Drills, pause, and repeat passed');

const pack = JSON.parse(readFileSync(new URL('../assets/sounds/practice/pack.json', import.meta.url), 'utf8'));
const requiredCues = ['charge', 'eight', 'seven', 'six', 'five', 'four', 'three', 'two', 'one', 'go', 'buzzers', 'pickup', 'bells', 'chime', 'whistle', 'end', 'foghorn', 'rest-notice'];
for (const id of requiredCues) assert(pack.cues.some((cue) => cue.id === id), 'pack missing ' + id);
for (const cue of pack.cues) {
  const wav = decodeWav(readFileSync(new URL('../assets/sounds/practice/' + cue.file, import.meta.url)));
  const measured = measure(wav.samples, wav.rate);
  assert(Math.abs(measured.onsetMs - cue.onsetMs) <= 1, cue.id + ' onset');
  assert(Math.abs(measured.tailMs - cue.tailMs) <= 1, cue.id + ' tail');
  assert(Math.abs(measured.durationMs - cue.durationMs) <= 1, cue.id + ' duration');
  assert(cue.source.includes('Not an FTC Live recording'), cue.id + ' source');
  assert(cue.license && cue.trim && Number.isFinite(cue.alignment.offsetMs), cue.id + ' metadata');
}
assert(pack.cues.find((cue) => cue.id === 'go').alignment.point === 'onset', 'GO aligns on its onset');
for (const name of TRANSITION_NUMBERS) {
  assert(pack.cues.find((cue) => cue.id === name).alignment.point === 'onset', name + ' aligns on its onset');
  assert(pack.cues.find((cue) => cue.id === name).durationMs < 1000, name + ' fits in its second');
}
assert(pack.cues.find((cue) => cue.id === 'end').durationMs === 3000, 'end buzzer is three seconds');
const endWav = decodeWav(readFileSync(new URL('../assets/sounds/practice/end.wav', import.meta.url)));
let endPeak = 0;
let endCrossings = 0;
for (let i = 0; i < endWav.samples.length; i++) {
  endPeak = Math.max(endPeak, Math.abs(endWav.samples[i]));
  if (i > 0 && ((endWav.samples[i - 1] < 0 && endWav.samples[i] >= 0) || (endWav.samples[i - 1] >= 0 && endWav.samples[i] < 0))) endCrossings += 1;
}
assert(endPeak >= 0.75, 'end buzzer is loud');
assert(endCrossings / 2 / (endWav.samples.length / endWav.rate) > 300, 'end buzzer is high enough for a small speaker');

const measuredOffsets = offsetsFromPack(pack);
const aligned = createSession(season);
start(aligned, 0, { mode: 'full', offsets: measuredOffsets, repeat: false });
const alignedCue = (key) => aligned.run.cues.find((cue) => cue.key === key);
assert(alignedCue('go').atMs + measuredOffsets.goOnsetMs === season.countInSeconds * 1000, 'measured GO onset is AUTO start');
assert(alignedCue('pickup').atMs === alignedCue('buzzers').atMs + measuredOffsets.buzzerTailMs, 'measured pickup follows the buzzer tail');
const alignedCountIn = season.countInSeconds * 1000;
TRANSITION_NUMBERS.forEach((name, index) => {
  const item = alignedCue(`n${8 - index}`);
  const boundary = alignedCountIn + (30 + index) * 1000;
  const onset = item.atMs + measuredOffsets.numberOnsetMs[name];
  if (index === 0) assert(onset === alignedCue('buzzers').atMs + measuredOffsets.buzzerTailMs, 'measured eight follows the buzzer');
  else assert(onset === boundary, 'measured ' + name + ' is on its second');
});
assert(alignedCue('n1').atMs + measuredOffsets.numberOnsetMs.one + 1000 === alignedCue('bells').atMs, 'measured one is the second before TELEOP');

for (const file of readdirSync(new URL('../src/', import.meta.url))) {
  if (!file.endsWith('.js')) continue;
  const text = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
  assert(!text.includes('speechSynthesis'), file + ' must not speak at runtime');
}

console.log('Practice pack alignment passed');

assert(cueAudioTime(10, 0, 3000) === 13, 'cue time is on the audio clock');
assert(cueAudioTime(10, 1000, 1000) === 10, 'a due cue starts now');
assert(cueAudioTime(10, 1030, 1000) === 10, 'a few late milliseconds still start');
assert(cueAudioTime(10, 5000, 1000) === null, 'a missed cue is not played');
assert(shouldArm(0, 161000) === false, 'the end buzzer is not armed at the opening whistle');
assert(shouldArm(160700, 161000, armLimits({ key: 'end' })) === true, 'the end buzzer arms as the clock reaches zero');
assert(shouldArm(162000, 161000, armLimits({ key: 'end' })) === true, 'a late end buzzer still plays');
assert(shouldArm(1080, 1000) === false, 'a late spoken cue is not replayed');

const savedRun = begin('full');
advance(savedRun.session, 10000);
const saved = checkpoint(savedRun.session, 10000);
const restored = restore(season, saved);
assert(restored.run.status === 'interrupted' && restored.run.repeatCancelled === true, 'reload opens as interrupted');
const restoredResume = resume(restored, 0);
assert(!keysOf(restoredResume.schedule).includes('go') && keysOf(restoredResume.schedule).includes('buzzers'), 'resume after reload skips cues already passed');

const cleanSettings = sanitizeSettings({ mode: 'nope', volume: 4, customSeconds: 0, muted: 1, names: 'student', score: 20 });
assert(cleanSettings.mode === 'full' && cleanSettings.volume === 1 && cleanSettings.customSeconds === 1, 'settings stay in range');
assert(cleanSettings.names === undefined && cleanSettings.score === undefined, 'settings do not keep names or scores');
const cleanRun = sanitizeRun({ id: 'run-1', mode: 'auto', status: 'complete', time: '2:00', activeDurationMs: 30000, pauseCount: 1, packVersion: '1', name: 'A' });
assert(cleanRun.name === undefined && cleanRun.time === '2:00', 'run logs stay small');
assert(validPack(pack), 'bundled pack matches the import schema');

const pageFiles = ['../index.html', '../style.css', '../src/app.js', '../sw.js'];
for (const path of pageFiles) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  assert(!text.includes('speechSynthesis'), path + ' must not speak at runtime');
  assert(!text.includes('fonts.googleapis') && !text.includes('googletagmanager'), path + ' stays offline');
}
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
assert(html.includes('The Allsparks') && html.includes('BIOBUZZ 2026–27'), 'header names the season');
assert(html.includes('Ready—start practice') && html.includes('Test sound') && html.includes('>Abort<'), 'main controls are present');
assert(css.includes('#212121') && css.includes('#FDD835') && css.includes('Segoe UI') && css.includes('tabular-nums'), 'Chromebook theme');
assert(css.includes('clamp(220px, 32vh, 280px)'), 'clock size');
for (const cue of pack.cues) assert(ASSETS.some((path) => path.endsWith(cue.file)), 'cache list includes ' + cue.file);
assert(ASSETS.includes('./index.html') && ASSETS.includes('./season/biobuzz-2026.json'), 'cache list includes the page');
const worker = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
assert(worker.name === 'practice-timer' && worker.assets.directory === '.', 'static worker config');

console.log('Scheduler, storage, and page contract passed');
