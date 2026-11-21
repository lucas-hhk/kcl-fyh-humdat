const sampleRate = 8000;
const hop = 800;
const windowSize = 320;
const maxLag = 115;
const maxFrames = 120;

function pitchAt(samples, offset) {
  let energy = 0;
  for (let index = 0; index < windowSize; index++) energy += samples[offset + index] ** 2;
  if (energy / windowSize < 0.000025) return null;

  const differences = new Float32Array(maxLag + 1);
  let sum = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let difference = 0;
    for (let index = 0; index < windowSize; index++) {
      const sample = samples[offset + index];
      difference += (sample - samples[offset + index + lag]) ** 2;
    }
    sum += difference;
    differences[lag] = sum ? difference * lag / sum : 1;
  }
  for (let lag = 10; lag < maxLag; lag++) {
    if (differences[lag] >= 0.18) continue;
    while (lag < maxLag && differences[lag + 1] < differences[lag]) lag++;
    return Math.round(690 + 120 * Math.log2(sampleRate / lag / 440));
  }
  return null;
}

export function trackMelody(audio) {
  const samples = audio.getChannelData(0);
  const stride = audio.sampleRate / sampleRate;
  const length = Math.min(Math.floor(samples.length / stride), hop * maxFrames);
  const reduced = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const start = Math.floor(index * stride);
    const end = Math.floor((index + 1) * stride);
    for (let sample = start; sample < end; sample++) reduced[index] += samples[sample] / (end - start);
  }
  const pitches = [];
  for (let offset = 0; offset + windowSize + maxLag <= length; offset += hop) {
    pitches.push(pitchAt(reduced, offset));
  }
  return cleanMelody(pitches);
}

export function cleanMelody(pitches) {
  if (!Array.isArray(pitches) || pitches.length > maxFrames || pitches.some((pitch) =>
    pitch !== null && (!Number.isInteger(pitch) || pitch < 320 || pitch > 820))) return null;
  const first = pitches.findIndex((pitch) => pitch !== null);
  const last = pitches.findLastIndex((pitch) => pitch !== null);
  const notes = pitches.slice(Math.max(0, first), last + 1);
  const voiced = notes.filter((pitch) => pitch !== null);
  if (voiced.length < 8 || voiced.length < notes.length * 0.55) return null;
  return notes;
}

function center(notes) {
  const voiced = notes.filter((pitch) => pitch !== null).sort((a, b) => a - b);
  const median = voiced[Math.floor(voiced.length / 2)];
  return notes.map((pitch) => pitch === null ? null : pitch - median);
}

export function scoreMelody(reference, performance) {
  if (!reference || !performance) return null;
  const expected = center(reference);
  const actual = center(performance);
  const lengths = Math.min(expected.length, actual.length) / Math.max(expected.length, actual.length);
  let previous = new Float32Array(actual.length + 1).fill(Infinity);
  previous[0] = 0;
  for (let i = 1; i <= expected.length; i++) {
    const row = new Float32Array(actual.length + 1).fill(Infinity);
    for (let j = 1; j <= actual.length; j++) {
      if (Math.abs(i / expected.length - j / actual.length) > 0.2) continue;
      const note = expected[i - 1];
      const pitch = actual[j - 1];
      const cost = note === pitch ? 0 : note === null || pitch === null ? 1
        : Math.min(1, Math.max(0, Math.abs(note - pitch) - 3) / 30);
      row[j] = Math.min(previous[j - 1] + cost, previous[j] + cost + 0.12, row[j - 1] + cost + 0.12);
    }
    previous = row;
  }
  const error = previous[actual.length] / Math.max(expected.length, actual.length);
  return Math.round(100 * Math.max(0, 1 - error) * Math.min(1, lengths / 0.7));
}
