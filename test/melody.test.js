import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreMelody, trackMelody } from '../public/melody.js';

function tones(notes, secondsPerNote) {
  const sampleRate = 24000;
  const framesPerNote = Math.round(secondsPerNote * sampleRate);
  const samples = new Float32Array(notes.length * framesPerNote);
  for (let frame = 0; frame < samples.length; frame++) {
    const note = notes[Math.floor(frame / framesPerNote)];
    const frequency = 440 * 2 ** ((note - 69) / 12);
    samples[frame] = 0.2 * Math.sin(2 * Math.PI * frequency * (frame % framesPerNote) / sampleRate);
  }
  return { sampleRate, getChannelData: () => samples };
}

test('melody scoring tolerates key and tempo changes and distinguishes another tune', () => {
  const notes = [60, 64, 67, 65, 62, 60];
  const reference = trackMelody(tones(notes, 0.28));
  const shifted = trackMelody(tones(notes.map((note) => note - 5), 0.36));
  const different = trackMelody(tones([72, 60, 60, 72, 72, 60], 0.28));
  assert.ok(scoreMelody(reference, shifted) >= 75);
  assert.ok(scoreMelody(reference, different) <= 50);
  const silence = { sampleRate: 8000, getChannelData: () => new Float32Array(16000) };
  assert.equal(scoreMelody(reference, trackMelody(silence)), null);
});
