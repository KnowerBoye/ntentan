// ─────────────────────────────────────────────
//  lib/wav.ts
//  Minimal WAV (RIFF/PCM) packaging. The Live clients stream raw PCM16 mic
//  audio in chunks; GhanaNLP ASR needs a self-contained audio file, so we wrap
//  the buffered PCM into a standard 16-bit PCM WAV before sending it.
// ─────────────────────────────────────────────

/**
 * Wrap raw little-endian 16-bit PCM samples in a WAV (RIFF) container.
 * @param pcm  Raw PCM16 sample bytes (mono/interleaved as given).
 * @param sampleRate  Samples per second (client mic = 16000).
 * @param channels    Channel count (client mic = 1).
 */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4); // file size - 8
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
