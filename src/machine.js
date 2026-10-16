/**
 * BIOBUZZ practice clock.
 *
 * Match time is measured from AUTO start. The main clock is not a counter
 * that ticks down: remaining time is calculated from that match time.
 * AUTO shows 150 - t, transition holds 120, and TELEOP shows 120 - (t - 38).
 * Ceiling seconds keep each whole second on screen for its full interval.
 * 0:00 is shown only when the remaining time is exactly zero.
 */

export function ceilingSeconds(remainingSeconds) {
  const ms = Math.round(Number(remainingSeconds) * 1000);
  if (ms <= 0) return 0;
  if (ms % 1000 === 0) return ms / 1000;
  return Math.ceil(ms / 1000);
}

export function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.trunc(totalSeconds));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}:${String(rem).padStart(2, '0')}`;
}

function clockFromRemainingMs(remainingMs) {
  if (remainingMs <= 0) return formatClock(0);
  const sec = remainingMs % 1000 === 0 ? remainingMs / 1000 : Math.ceil(remainingMs / 1000);
  return formatClock(sec);
}

function ms(seconds) {
  return Math.round(seconds * 1000);
}

/**
 * What the match clock shows at `matchSeconds` after AUTO start.
 * Transition is [30, 38). Its secondary countdown runs 0:08 through 0:01.
 */
export function present(season, matchSeconds) {
  const t = Math.round(Number(matchSeconds) * 1000);
  const b = season.boundaries;
  const autoEnd = ms(b.autoEnd);
  const teleopStart = ms(b.teleopStart);
  const flower = ms(b.flower);
  const final20 = ms(b.final20);
  const matchEnd = ms(b.matchEnd);
  const autoStartRemaining = ms(season.clocks.autoRemainingAtStart);
  const frozen = ms(season.clocks.transitionFrozen);

  if (t >= matchEnd) {
    return face('complete', 'COMPLETE', 'stopped', formatClock(0), null, null, 'FINAL 20 SECONDS');
  }
  if (t >= final20) {
    return face('final20', 'FINAL 20', 'final20', clockFromRemainingMs(matchEnd - t), null, null, 'FINAL 20 SECONDS');
  }
  if (t >= teleopStart) {
    const banner = t >= flower ? 'FLOWER OWNERSHIP UNLOCKED' : 'FLOWER OWNERSHIP LOCKED';
    return face('teleop', 'TELEOP', 'teleop', clockFromRemainingMs(matchEnd - t), null, null, banner);
  }
  if (t >= autoEnd) {
    return face(
      'transition',
      'TRANSITION',
      'transition',
      formatClock(frozen / 1000),
      clockFromRemainingMs(teleopStart - t),
      'TRANSITION',
      null
    );
  }
  return face('auto', 'AUTO', 'auto', clockFromRemainingMs(autoStartRemaining - t), null, 'AUTO', null);
}

function face(phase, phaseLabel, accent, mainClock, secondaryClock, secondaryLabel, banner) {
  return { phase, phaseLabel, accent, mainClock, secondaryClock, secondaryLabel, banner };
}

export function startClock(season, mode, customSeconds) {
  if (mode === 'final20') return formatClock(20);
  if (mode === 'custom') return formatClock(ceilingSeconds(customSeconds));
  if (mode === 'transition' || mode === 'teleop') return formatClock(season.clocks.transitionFrozen);
  return formatClock(season.clocks.autoRemainingAtStart);
}

export const GAP_MS = 500;

export const MODES = ['full', 'auto', 'transition', 'teleop', 'final20', 'custom'];

export const TRANSITION_NUMBERS = ['eight', 'seven', 'six', 'five', 'four', 'three', 'two', 'one'];

export const CUE_LABELS = {
  eight: '8',
  seven: '7',
  six: '6',
  five: '5',
  four: '4',
  three: '3',
  two: '2',
  one: '1',
  n8: '8',
  n7: '7',
  n6: '6',
  n5: '5',
  n4: '4',
  n3: '3',
  n2: '2',
  n1: '1',
  go: 'GO',
  buzzers: 'Buzzers',
  pickup: 'Pick up controllers',
  bells: 'Bells',
  chime: 'Flower chime',
  whistle: 'Whistle',
  warning: 'Warning',
  end: 'End buzzer',
  'rest-notice': 'Rest done',
  foghorn: 'Foghorn',
  charge: 'Charge',
};

const LIVE = new Set(['running', 'paused', 'rest']);
const CLOCKING = new Set(['running', 'rest']);

export function offsetsFromPack(pack) {
  const cue = (id) => pack.cues.find((item) => item.id === id);
  return {
    goOnsetMs: cue('go').alignment.offsetMs,
    buzzerTailMs: cue('buzzers').tailMs,
    numberOnsetMs: Object.fromEntries(TRANSITION_NUMBERS.map((name) => {
      const item = cue(name);
      return [name, item ? item.onsetMs || 0 : 0];
    })),
    restNoticeMs: cue('rest-notice').durationMs,
  };
}

export function createSession(season) {
  return {
    season,
    run: null,
    runNumber: 0,
    completedCount: 0,
    generation: 0,
    lastObserveMs: null,
  };
}

export function isLive(session) {
  return LIVE.has(session.run?.status);
}

export function isIdle(session) {
  const status = session.run?.status;
  return !status || status === 'complete' || status === 'aborted';
}

function emptyStep(session, nowMs) {
  return { due: [], schedule: null, cancel: false, elapsedMs: 0, view: view(session, nowMs) };
}

function step(session, nowMs, extra) {
  return {
    due: extra.due || [],
    schedule: extra.schedule === undefined ? null : extra.schedule,
    cancel: !!extra.cancel,
    elapsedMs: elapsedNow(session, nowMs),
    view: view(session, nowMs),
  };
}

function modeWindow(mode, customSeconds) {
  if (mode === 'full') return { originSec: 0, endSec: 158, kind: 'match' };
  if (mode === 'auto') return { originSec: 0, endSec: 30, kind: 'match' };
  if (mode === 'transition') return { originSec: 30, endSec: 158, kind: 'match' };
  if (mode === 'teleop') return { originSec: 38, endSec: 158, kind: 'match' };
  if (mode === 'final20') return { originSec: 0, endSec: 20, kind: 'final20' };
  if (mode === 'custom') return { originSec: 0, endSec: customSeconds, kind: 'custom' };
  throw new Error('Unknown mode ' + mode);
}

function cue(run, key, sound, atMs) {
  run.cues.push({ id: `${run.id}:${key}`, key, sound, atMs });
}

function buildCues(run) {
  const countIn = run.countInMs;
  const offsets = run.offsets;
  cue(run, 'three', 'three', 0);
  cue(run, 'two', 'two', 1000);
  cue(run, 'one', 'one', 2000);
  cue(run, 'go', 'go', countIn - offsets.goOnsetMs);
  if (run.kind === 'final20') {
    cue(run, 'whistle', 'whistle', countIn);
    cue(run, 'end', 'end', countIn + ms(run.endSec));
    return;
  }
  if (run.kind === 'custom') {
    if (run.warningSeconds > 0 && run.warningSeconds < run.endSec) {
      cue(run, 'warning', 'whistle', countIn + ms(run.endSec - run.warningSeconds));
    }
    cue(run, 'end', 'end', countIn + ms(run.endSec));
    return;
  }
  const atMatch = (sec) => countIn + ms(sec - run.originSec);
  const { originSec, endSec } = run;
  if (originSec === 0) cue(run, 'charge', 'charge', atMatch(0));
  if (originSec <= 30 && endSec >= 30) cue(run, 'buzzers', 'buzzers', atMatch(30));
  if (originSec <= 30 && endSec > 30) {
    const buzzerAt = atMatch(30);
    const afterBuzzer = buzzerAt + offsets.buzzerTailMs;
    cue(run, 'pickup', 'pickup', afterBuzzer);
    // One spoken number for each transition second, 0:08 through 0:01.
    // "Eight" starts when the buzzer finishes so the buzzers do not cover it.
    TRANSITION_NUMBERS.forEach((name, index) => {
      const onset = offsets.numberOnsetMs?.[name] || 0;
      const boundary = atMatch(30 + index);
      let at = boundary - onset;
      if (index === 0 && afterBuzzer < boundary + 1000) at = Math.max(at, afterBuzzer - onset);
      cue(run, `n${8 - index}`, name, at);
    });
  }
  if (originSec <= 38 && endSec > 38) cue(run, 'bells', 'bells', atMatch(38));
  if (originSec <= 98 && endSec > 98) cue(run, 'chime', 'chime', atMatch(98));
  if (originSec <= 138 && endSec > 138) cue(run, 'whistle', 'whistle', atMatch(138));
  if (endSec >= 158 && originSec < 158) cue(run, 'end', 'end', atMatch(158));
}

function createRun(session, options) {
  const customSeconds = Number(options.customSeconds ?? 20);
  const warningSeconds = Number(options.warningSeconds ?? 0);
  const window = modeWindow(options.mode, customSeconds);
  const run = {
    id: `run-${session.runNumber}`,
    mode: options.mode,
    kind: window.kind,
    originSec: window.originSec,
    endSec: window.endSec,
    customSeconds,
    warningSeconds,
    repeat: !!options.repeat,
    repeatCancelled: false,
    restNotice: !!options.restNotice,
    offsets: options.offsets,
    packId: options.packId || 'practice',
    packVersion: options.packVersion || '1',
    countInMs: ms(session.season.countInSeconds),
    cues: [],
    fired: [],
    status: 'running',
    resumeStatus: 'running',
    elapsedMs: 0,
    restElapsedMs: 0,
    segmentStartMs: null,
    pauseCount: 0,
    accounted: false,
    noticeFired: false,
    options: {
      mode: options.mode,
      repeat: !!options.repeat,
      restNotice: !!options.restNotice,
      customSeconds,
      warningSeconds,
      offsets: options.offsets,
      packId: options.packId || 'practice',
      packVersion: options.packVersion || '1',
    },
  };
  buildCues(run);
  return run;
}

function elapsedNow(session, nowMs) {
  const run = session.run;
  if (!run) return 0;
  if (run.status === 'running' && run.segmentStartMs != null) return run.elapsedMs + (nowMs - run.segmentStartMs);
  return run.elapsedMs;
}

function restNow(session, nowMs) {
  const run = session.run;
  if (!run) return 0;
  if (run.status === 'rest' && run.segmentStartMs != null) return run.restElapsedMs + (nowMs - run.segmentStartMs);
  return run.restElapsedMs;
}

function takeDue(run, nextMs) {
  const due = [];
  for (const item of run.cues) {
    if (run.fired.includes(item.id) || item.atMs > nextMs) continue;
    run.fired.push(item.id);
    due.push(item);
  }
  return due;
}

function finishMatch(session, nowMs, next, due) {
  const run = session.run;
  const endAt = run.countInMs + ms(run.endSec);
  const overshoot = Math.max(0, next - endAt);
  run.elapsedMs = endAt;
  if (!run.accounted) {
    run.accounted = true;
    session.completedCount += 1;
  }
  if (run.repeat && !run.repeatCancelled) {
    run.status = 'rest';
    run.resumeStatus = 'rest';
    run.restElapsedMs = overshoot;
    run.segmentStartMs = nowMs;
    const rest = advanceRest(session, nowMs);
    return { due: due.concat(rest.due), schedule: rest.schedule };
  }
  run.status = 'complete';
  run.segmentStartMs = null;
  return { due, schedule: null };
}

function advanceRunning(session, nowMs) {
  const run = session.run;
  const next = run.elapsedMs + (nowMs - run.segmentStartMs);
  const due = takeDue(run, next);
  const endAt = run.countInMs + ms(run.endSec);
  if (next >= endAt) return finishMatch(session, nowMs, next, due);
  run.elapsedMs = next;
  run.segmentStartMs = nowMs;
  return { due, schedule: null };
}

function beginNextRun(session, nowMs, overshoot) {
  const options = session.run.options;
  session.runNumber += 1;
  session.generation += 1;
  const run = createRun(session, options);
  run.elapsedMs = overshoot;
  run.segmentStartMs = nowMs;
  session.run = run;
  if (overshoot > 0) takeDue(run, overshoot);
}

function advanceRest(session, nowMs) {
  const run = session.run;
  const silentMs = ms(session.season.restSeconds);
  const noticeMs = run.restNotice ? run.offsets.restNoticeMs : 0;
  const next = run.restElapsedMs + (nowMs - run.segmentStartMs);
  const due = [];
  if (run.repeatCancelled) {
    run.status = 'complete';
    run.segmentStartMs = null;
    return { due, schedule: null };
  }
  if (run.restNotice && !run.noticeFired && next >= silentMs && next < silentMs + noticeMs) {
    run.noticeFired = true;
    const notice = { id: `${run.id}:rest-notice`, key: 'rest-notice', sound: 'rest-notice', atMs: run.elapsedMs };
    due.push(notice);
    run.restElapsedMs = next;
    run.segmentStartMs = nowMs;
    return { due, schedule: [notice] };
  }
  if (next >= silentMs + noticeMs) {
    const overshoot = next - (silentMs + noticeMs);
    beginNextRun(session, nowMs, overshoot);
    return { due, schedule: futureCues(session, nowMs) };
  }
  run.restElapsedMs = next;
  run.segmentStartMs = nowMs;
  return { due, schedule: null };
}

export function futureCues(session, nowMs) {
  const run = session.run;
  if (!run || !CLOCKING.has(run.status)) return [];
  const elapsed = elapsedNow(session, nowMs);
  return run.cues.filter((item) => !run.fired.includes(item.id) && item.atMs >= elapsed);
}

export function start(session, nowMs, options) {
  if (isLive(session)) return emptyStep(session, nowMs);
  if (!options?.offsets) throw new Error('Sound offsets are required');
  if (!MODES.includes(options.mode)) throw new Error('Unknown mode ' + options.mode);
  session.runNumber += 1;
  session.generation += 1;
  const run = createRun(session, options);
  run.segmentStartMs = nowMs;
  session.run = run;
  session.lastObserveMs = nowMs;
  return step(session, nowMs, { schedule: futureCues(session, nowMs) });
}

export function advance(session, nowMs) {
  const run = session.run;
  if (!run || !CLOCKING.has(run.status)) return emptyStep(session, nowMs);
  if (run.status === 'rest') return step(session, nowMs, advanceRest(session, nowMs));
  return step(session, nowMs, advanceRunning(session, nowMs));
}

export function observe(session, nowMs) {
  const last = session.lastObserveMs;
  if (last != null && nowMs - last > GAP_MS && CLOCKING.has(session.run?.status)) {
    session.lastObserveMs = nowMs;
    return interrupt(session, nowMs, true);
  }
  session.lastObserveMs = nowMs;
  return advance(session, nowMs);
}

export function pause(session, nowMs) {
  const run = session.run;
  if (!run || (run.status !== 'running' && run.status !== 'rest')) return emptyStep(session, nowMs);
  run.repeatCancelled = true;
  if (run.status === 'rest') {
    run.restElapsedMs += nowMs - run.segmentStartMs;
    run.status = 'complete';
    run.segmentStartMs = null;
    return step(session, nowMs, { cancel: true });
  }
  run.elapsedMs += nowMs - run.segmentStartMs;
  run.pauseCount += 1;
  run.resumeStatus = 'running';
  run.status = 'paused';
  run.segmentStartMs = null;
  return step(session, nowMs, { cancel: true });
}

export function resume(session, nowMs) {
  const run = session.run;
  if (!run || (run.status !== 'paused' && run.status !== 'interrupted')) return emptyStep(session, nowMs);
  session.lastObserveMs = nowMs;
  if (run.resumeStatus === 'rest') {
    run.status = 'complete';
    run.segmentStartMs = null;
    return step(session, nowMs, { cancel: true });
  }
  run.status = 'running';
  run.segmentStartMs = nowMs;
  return step(session, nowMs, { cancel: true, schedule: futureCues(session, nowMs) });
}

export function reset(session, nowMs) {
  session.run = null;
  session.generation += 1;
  session.lastObserveMs = nowMs;
  return step(session, nowMs, { cancel: true, schedule: [] });
}

export function abort(session, nowMs) {
  const run = session.run;
  if (!run || !LIVE.has(run.status)) return emptyStep(session, nowMs);
  if (run.status === 'running') run.elapsedMs += nowMs - run.segmentStartMs;
  if (run.status === 'rest') run.restElapsedMs += nowMs - run.segmentStartMs;
  run.repeatCancelled = true;
  run.status = 'aborted';
  run.segmentStartMs = null;
  const foghorn = { id: `${run.id}:foghorn`, key: 'foghorn', sound: 'foghorn', atMs: run.elapsedMs };
  return step(session, nowMs, { cancel: true, schedule: [foghorn], due: [foghorn] });
}

export function interrupt(session, nowMs, discardGap = false) {
  const run = session.run;
  if (!run || !LIVE.has(run.status)) return emptyStep(session, nowMs);
  if (!discardGap && run.segmentStartMs != null) {
    if (run.status === 'running') run.elapsedMs += nowMs - run.segmentStartMs;
    if (run.status === 'rest') run.restElapsedMs += nowMs - run.segmentStartMs;
  }
  if (run.status === 'rest') run.resumeStatus = 'rest';
  else if (run.status === 'running') run.resumeStatus = 'running';
  run.repeatCancelled = true;
  run.status = 'interrupted';
  run.segmentStartMs = null;
  session.lastObserveMs = nowMs;
  return step(session, nowMs, { cancel: true, schedule: [] });
}

function finishedClock(session, run) {
  if (run.kind === 'custom' || run.kind === 'final20') return formatClock(0);
  if (run.mode === 'auto') return formatClock(session.season.clocks.transitionFrozen);
  return formatClock(0);
}

function countInFace(session, run, elapsed) {
  const remaining = run.countInMs - elapsed;
  return {
    phase: 'countIn',
    phaseLabel: 'COUNT IN',
    accent: 'countIn',
    mainClock: startClock(session.season, run.mode, run.customSeconds),
    secondaryClock: clockFromRemainingMs(remaining),
    secondaryLabel: 'COUNT IN',
    banner: null,
  };
}

export function view(session, nowMs, readyMode = 'full', customSeconds = 20) {
  const base = {
    runNumber: session.runNumber,
    completedCount: session.completedCount,
    generation: session.generation,
    lastCue: null,
    mode: session.run?.mode || null,
    packVersion: session.run?.packVersion || null,
    activeMs: session.run ? session.run.elapsedMs : 0,
    pauseCount: session.run?.pauseCount || 0,
    status: session.run?.status || 'ready',
    paused: session.run?.status === 'paused',
  };
  const run = session.run;
  if (!run) {
    return {
      ...base,
      phase: 'ready',
      phaseLabel: 'READY',
      accent: 'ready',
      mainClock: startClock(session.season, readyMode, customSeconds),
      secondaryClock: null,
      secondaryLabel: null,
      banner: null,
    };
  }
  const elapsed = elapsedNow(session, nowMs);
  base.activeMs = run.status === 'rest' ? run.elapsedMs : elapsed;
  const last = run.fired[run.fired.length - 1];
  base.lastCue = last ? last.split(':').slice(1).join(':') : null;
  if (run.status === 'aborted' || run.status === 'interrupted' || run.status === 'paused') {
    const frozen = faceFor(session, run, run.elapsedMs);
    const label = run.status === 'paused' ? 'PAUSED' : run.status === 'aborted' ? 'ABORTED' : 'INTERRUPTED';
    const accent = run.status === 'paused' ? frozen.accent : 'stopped';
    return { ...base, ...frozen, phase: run.status, phaseLabel: label, accent };
  }
  if (run.status === 'complete') {
    return {
      ...base,
      phase: 'complete',
      phaseLabel: 'COMPLETE',
      accent: 'stopped',
      mainClock: finishedClock(session, run),
      secondaryClock: null,
      secondaryLabel: null,
      banner: run.kind === 'match' && run.endSec >= 158 ? 'FINAL 20 SECONDS' : null,
    };
  }
  if (run.status === 'rest') {
    const left = ms(session.season.restSeconds) - restNow(session, nowMs);
    return {
      ...base,
      phase: 'rest',
      phaseLabel: 'REST',
      accent: 'rest',
      mainClock: finishedClock(session, run),
      secondaryClock: clockFromRemainingMs(Math.max(0, left)),
      secondaryLabel: 'REST',
      banner: null,
    };
  }
  return { ...base, ...faceFor(session, run, elapsed) };
}

function faceFor(session, run, elapsed) {
  if (elapsed < run.countInMs) return countInFace(session, run, elapsed);
  const localMs = elapsed - run.countInMs;
  if (run.kind === 'custom') {
    const remain = ms(run.endSec) - localMs;
    const warning = run.warningSeconds > 0 && remain <= ms(run.warningSeconds) && remain > 0;
    return {
      phase: 'custom',
      phaseLabel: 'CUSTOM',
      accent: 'custom',
      mainClock: clockFromRemainingMs(Math.max(0, remain)),
      secondaryClock: null,
      secondaryLabel: null,
      banner: warning ? 'WARNING' : null,
    };
  }
  if (run.kind === 'final20') {
    return {
      phase: 'final20',
      phaseLabel: 'FINAL 20',
      accent: 'final20',
      mainClock: clockFromRemainingMs(Math.max(0, ms(20) - localMs)),
      secondaryClock: null,
      secondaryLabel: null,
      banner: 'FINAL 20 SECONDS',
    };
  }
  const matchSec = run.originSec + localMs / 1000;
  const shown = present(session.season, Math.min(matchSec, run.endSec));
  if (run.mode === 'auto') {
    return { ...shown, phase: 'auto', phaseLabel: 'AUTO', accent: 'auto', banner: null, secondaryClock: null, secondaryLabel: 'AUTO' };
  }
  return shown;
}

export function summary(session) {
  const run = session.run;
  if (!run) return null;
  const face = view(session, run.segmentStartMs ?? 0);
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    time: face.mainClock,
    activeDurationMs: run.elapsedMs,
    pauseCount: run.pauseCount,
    packVersion: run.packVersion,
  };
}

export function checkpoint(session, nowMs) {
  const run = session.run;
  if (!run || !['running', 'paused', 'rest', 'interrupted'].includes(run.status)) return null;
  let resumeStatus = 'running';
  if (run.status === 'rest' || (run.status === 'interrupted' && run.resumeStatus === 'rest')) resumeStatus = 'rest';
  if (run.status === 'interrupted') resumeStatus = run.resumeStatus;
  return {
    v: 1,
    live: true,
    runNumber: session.runNumber,
    completedCount: session.completedCount,
    generation: session.generation,
    elapsedMs: elapsedNow(session, nowMs),
    restElapsedMs: restNow(session, nowMs),
    fired: run.fired.slice(),
    pauseCount: run.pauseCount,
    accounted: run.accounted,
    noticeFired: run.noticeFired,
    resumeStatus,
    options: run.options,
    runId: run.id,
  };
}

export function restore(season, data) {
  const session = createSession(season);
  session.runNumber = data.runNumber;
  session.completedCount = data.completedCount;
  session.generation = data.generation;
  const run = createRun(session, data.options);
  run.id = data.runId;
  run.cues = [];
  buildCues(run);
  run.fired = data.fired.slice();
  run.elapsedMs = data.elapsedMs;
  run.restElapsedMs = data.restElapsedMs;
  run.pauseCount = data.pauseCount;
  run.accounted = data.accounted;
  run.noticeFired = data.noticeFired;
  run.resumeStatus = data.resumeStatus;
  run.repeatCancelled = true;
  run.status = 'interrupted';
  run.segmentStartMs = null;
  session.run = run;
  return session;
}
