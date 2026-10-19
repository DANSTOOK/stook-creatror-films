import { readFile, writeFile } from 'node:fs/promises';

/**
 * The little bit of WAV handling text-to-speech needs: reading the PCM out of
 * the mono 16-bit files Piper writes, and joining several of them (one per
 * chunk of text) into the single clip that lands on the timeline.
 *
 * Only the shape Piper produces is handled - PCM (format 1), one channel, 16
 * bits - because that is the only thing that is ever read here. The chunks all
 * come from the same voice, so they share a sample rate; it is taken from the
 * first file and the rest are trusted to match.
 */

export interface WavData {
  sampleRate: number;
  /** Signed 16-bit samples, one channel. */
  samples: Int16Array;
}

/** The PCM out of one Piper WAV. Throws if it is not the expected shape. */
export async function readWav(path: string): Promise<WavData> {
  const buffer = await readFile(path);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  // Walk the chunks to find fmt and data; Piper's header is canonical, but a
  // walk costs nothing and does not break if a LIST chunk ever appears.
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buffer.length - body);
    }
    offset = body + size + (size % 2);
  }
  if (dataStart < 0 || channels !== 1 || bits !== 16 || sampleRate <= 0) {
    throw new Error(`Unexpected WAV: ${channels}ch ${bits}bit ${sampleRate}Hz`);
  }
  const samples = new Int16Array(dataLength >> 1);
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(dataStart + i * 2);
  return { sampleRate, samples };
}

/** A silence of `seconds` at `sampleRate`, as samples. */
export const silence = (seconds: number, sampleRate: number): Int16Array => new Int16Array(Math.max(0, Math.round(seconds * sampleRate)));

/** Write one mono 16-bit WAV from joined chunks. Returns the duration in seconds. */
export async function writeWav(path: string, sampleRate: number, parts: readonly Int16Array[]): Promise<number> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + total * 2, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(total * 2, 40);
  const body = Buffer.alloc(total * 2);
  let at = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      body.writeInt16LE(part[i], at);
      at += 2;
    }
  }
  await writeFile(path, Buffer.concat([header, body]));
  return total / sampleRate;
}
