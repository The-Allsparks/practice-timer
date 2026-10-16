/**
 * Schedules practice cues on the audio clock.
 * A cue's onset or tail is already baked into `atMs` by the match machine.
 * Short cues more than 50ms late are dropped. The match-end buzzer is armed
 * only as the clock reaches zero, and it still plays if that moment is late.
 */

export function cueAudioTime(audioNow, elapsedMs, atMs, lateSec = 0.05) {
  const at = audioNow + (atMs - elapsedMs) / 1000;
  if (at < audioNow - lateSec) return null;
  return Math.max(at, audioNow);
}

/**
 * A cue is armed only when it is close. The match-end buzzer waits until the
 * clock is nearly at zero, then still plays if that frame is a little late.
 * Scheduling it at the start of a 2:30 match lets the browser drop it.
 */
export function shouldArm(elapsedMs, atMs, { horizonMs = 3000, lateMs = 50, armed = false } = {}) {
  if (armed) return false;
  if (atMs - elapsedMs > horizonMs) return false;
  if (elapsedMs - atMs > lateMs) return false;
  return true;
}

export function armLimits(cue) {
  if (cue?.key === 'end' || cue?.sound === 'end') return { horizonMs: 400, lateMs: 2500 };
  return { horizonMs: 3000, lateMs: 50 };
}

export function createScheduler() {
  let ctx = null;
  let gain = null;
  let buffers = new Map();
  let stamp = '';
  let volume = 0.8;
  let muted = false;
  let nodes = [];
  let armed = new Set();

  function applyGain() {
    if (gain) gain.gain.value = muted ? 0 : volume;
  }

  async function context() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio is unavailable');
      ctx = new Ctor();
      gain = ctx.createGain();
      gain.connect(ctx.destination);
      applyGain();
    }
    if (ctx.state !== 'running') await ctx.resume();
    return ctx;
  }

  return {
    get stamp() {
      return stamp;
    },
    async unlock() {
      await context();
    },
    async load(pack, files) {
      const audio = await context();
      const next = new Map();
      for (const cue of pack.cues) {
        const bytes = files.get(cue.id);
        if (!bytes) throw new Error('Missing sound ' + cue.id);
        next.set(cue.id, await audio.decodeAudioData(bytes.slice(0)));
      }
      buffers = next;
      stamp = pack.id + '@' + pack.version;
    },
    schedule(cues, elapsedMs) {
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      for (const cue of cues) {
        const limits = armLimits(cue);
        if (!shouldArm(elapsedMs, cue.atMs, { ...limits, armed: armed.has(cue.id) })) continue;
        const when = cueAudioTime(ctx.currentTime, elapsedMs, cue.atMs, limits.lateMs / 1000);
        const buffer = buffers.get(cue.sound);
        if (when == null || !buffer) continue;
        armed.add(cue.id);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.onended = () => {
          nodes = nodes.filter((node) => node !== source);
        };
        source.start(when);
        nodes.push(source);
      }
    },
    cancel() {
      for (const source of nodes) {
        try { source.stop(); } catch { /* already finished */ }
      }
      nodes = [];
      armed = new Set();
    },
    play(id) {
      if (!ctx || !buffers.get(id)) return false;
      const source = ctx.createBufferSource();
      source.buffer = buffers.get(id);
      source.connect(gain);
      source.start();
      return true;
    },
    setVolume(value) {
      volume = value;
      applyGain();
    },
    setMuted(value) {
      muted = value;
      applyGain();
    },
  };
}
