/**
 * Target bitrate from picture size and frame rate.
 *
 * A fixed default cannot work: 12 Mbps is roughly right for 1080p and absurd
 * for a 474x850 phone clip, where it produced a six-second file heavier than
 * the 43-second source it came from.
 *
 * The anchor is YouTube's published SDR upload table, which works out at a
 * remarkably steady 0.13-0.20 bits per pixel per frame from 360p to 2160p:
 *
 *   360p   1 Mbps   -> 0.145 bpp      1080p   8 Mbps  -> 0.129 bpp
 *   480p   2.5 Mbps -> 0.203 bpp      1440p  16 Mbps  -> 0.145 bpp
 *   720p   5 Mbps   -> 0.181 bpp      2160p  40 Mbps  -> 0.161 bpp
 *
 * https://support.google.com/youtube/answer/1722171
 */

/** Bits per pixel per frame, the midpoint of the table above. */
const BITS_PER_PIXEL = 0.15;

/**
 * Frame-rate cost exponent.
 *
 * Doubling the frame rate does NOT double the bitrate needed: consecutive
 * frames are more similar, so inter-frame prediction gets cheaper. YouTube's
 * high-frame-rate column is exactly 1.5x its standard column, and
 * 2 ** 0.585 = 1.5.
 */
const FRAME_RATE_EXPONENT = 0.585;

/** Below this a stream is not worth muxing; above it, nothing sane needs more. */
const MIN_KBPS = 500;
const MAX_KBPS = 120_000;

/**
 * Recommended H.264 bitrate in kbit/s.
 *
 * Deliberately a delivery-grade figure rather than a mastering one: this is the
 * default for someone pressing Export, and it should produce a file they can
 * actually send somewhere.
 */
export function recommendedBitrateKbps(width: number, height: number, fps: number): number {
  const pixels = Math.max(1, Math.round(width) * Math.round(height));
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;

  const rateFactor = (rate / 30) ** FRAME_RATE_EXPONENT;
  const bitsPerSecond = pixels * 30 * BITS_PER_PIXEL * rateFactor;

  const kbps = Math.round(bitsPerSecond / 1000);
  return Math.min(MAX_KBPS, Math.max(MIN_KBPS, kbps));
}

/**
 * Audio bitrate in kbit/s for a channel count.
 *
 * Same source: YouTube asks for 128 kbps mono, 384 stereo, 512 for 5.1.
 * 384 for stereo is generous for AAC-LC but it is the published figure, and an
 * editor export is usually an intermediate rather than a final delivery.
 */
export function recommendedAudioBitrateKbps(channels: number): number {
  if (channels <= 1) return 128;
  if (channels <= 2) return 256;
  return 512;
}
