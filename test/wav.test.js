import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeWav } from '../public/wav.js';

test('listener clips are bounded, mono 16-bit PCM WAV files', async () => {
  const channels = [new Float32Array([-1, 1, 0.75]), new Float32Array([-1, 0, 0.75])];
  const blob = encodeWav({
    length: 3,
    sampleRate: 24000,
    numberOfChannels: channels.length,
    getChannelData: (index) => channels[index],
  }, 2 / 24000);
  const wav = Buffer.from(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/wav');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 4);
  assert.equal(wav.readInt16LE(44), -32768);
  assert.equal(wav.readInt16LE(46), 16383);
});
