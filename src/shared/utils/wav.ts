/**
 * Minimal WAV writer for the export audio hand-off.
 *
 * The Web Audio API hands back PLANAR float32 - one `Float32Array` per channel,
 * nominally -1..1 - while WAV stores samples INTERLEAVED, so the channels have
 * to be woven together here.
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/AudioBuffer/getChannelData
 *
 * Float32 is written rather than 16-bit PCM: this file is an intermediate that
 * ffmpeg immediately re-encodes, so there is no reason to quantise on the way.
 */

/** WAVE format tag for IEEE 754 float samples. */
const WAVE_FORMAT_IEEE_FLOAT = 3;
const HEADER_BYTES = 44;

const writeAscii = (view: DataView, offset: number, text: string): void => {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
};

/**
 * Encode planar float channels as a 32-bit float WAV.
 *
 * Channels shorter than the longest are padded with silence rather than
 * rejected, so a mono tail on a stereo timeline cannot truncate the mix.
 */
export function encodeWavFloat32(
  channels: readonly Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  if (channels.length === 0) throw new RangeError('encodeWavFloat32 needs at least one channel');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Invalid sample rate: ${sampleRate}`);
  }

  const channelCount = channels.length;
  const frameCount = channels.reduce((longest, channel) => Math.max(longest, channel.length), 0);

  const bytesPerSample = 4;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frameCount * blockAlign;

  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM-style fmt chunk size
  view.setUint16(20, WAVE_FORMAT_IEEE_FLOAT, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const samples = channels[channel];
      view.setFloat32(offset, frame < samples.length ? samples[frame] : 0, true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

/** Parsed header, for verifying a file this module produced. */
export interface WavHeader {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  formatTag: number;
  frameCount: number;
}

export function readWavHeader(buffer: ArrayBuffer): WavHeader {
  const view = new DataView(buffer);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new SyntaxError('Not a RIFF file');

  const channels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const blockAlign = channels * (bitsPerSample / 8);

  return {
    channels,
    sampleRate: view.getUint32(24, true),
    bitsPerSample,
    formatTag: view.getUint16(20, true),
    frameCount: blockAlign > 0 ? dataBytes / blockAlign : 0,
  };
}
