export function encodeWav(audio, maxSeconds = 12) {
  const frames = Math.min(audio.length, Math.floor(audio.sampleRate * maxSeconds));
  const samples = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
  const bytes = new Uint8Array(44 + frames * 2);
  const header = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0); // RIFF
  header.setUint32(4, bytes.length - 8, true);
  bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8); // WAVEfmt
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, audio.sampleRate, true);
  header.setUint32(28, audio.sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  bytes.set([100, 97, 116, 97], 36); // data
  header.setUint32(40, frames * 2, true);

  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (const channel of samples) sum += channel[frame];
    const amplitude = Math.max(-1, Math.min(1, sum / samples.length));
    header.setInt16(44 + frame * 2, amplitude * (amplitude < 0 ? 32768 : 32767), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
