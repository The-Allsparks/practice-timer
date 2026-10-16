export function encodeWav(samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    buf.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let offset = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(start + 2);
      rate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
    }
    offset = start + size + (size & 1);
  }
  if (!data || !rate) throw new Error('WAV is missing sound data');
  const bytesPer = channels * (bits / 8);
  const frames = Math.floor(data.length / bytesPer);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let total = 0;
    for (let c = 0; c < channels; c++) {
      const at = i * bytesPer + c * (bits / 8);
      total += bits === 16 ? data.readInt16LE(at) / 32768 : data.readUInt8(at) / 128 - 1;
    }
    samples[i] = total / channels;
  }
  return { samples, rate };
}

export function measure(samples, rate, threshold = 0.02) {
  let onset = -1;
  let tail = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) {
      onset = i;
      break;
    }
  }
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) >= threshold) {
      tail = i;
      break;
    }
  }
  if (onset < 0 || tail < onset) throw new Error('Cue is silent');
  return {
    onset,
    tail,
    onsetMs: Math.round((onset / rate) * 1000),
    tailMs: Math.round(((tail + 1) / rate) * 1000),
    durationMs: Math.round((samples.length / rate) * 1000),
  };
}

export function trim(samples, rate, padMs = 8) {
  const raw = measure(samples, rate);
  const pad = Math.round((rate * padMs) / 1000);
  const start = Math.max(0, raw.onset - pad);
  const end = Math.min(samples.length, raw.tail + 1 + pad);
  const cut = samples.slice(start, end);
  return {
    samples: cut,
    headMs: Math.round((start / rate) * 1000),
    tailMsTrimmed: Math.round(((samples.length - end) / rate) * 1000),
    ...measure(cut, rate),
  };
}
