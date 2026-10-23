import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * A generated voice made ready for a video, by ffmpeg, after Piper:
 *
 *   - its pitch, when asked, moved by `pitch` semitones without changing its
 *     pace (the rate raised or lowered, then the tempo put back) - Piper has
 *     no pitch of its own;
 *   - "clear voice": rumble under 70 Hz cut, a little presence at 3.5 kHz, a
 *     gentle compressor so every word carries, and the level brought to
 *     -16 LUFS, the loudness online video aims for, its true peak held at
 *     -1.5 dB. Piper's own output peaked at full scale - clipped - which the
 *     levelling also cures;
 *   - written as 48 kHz WAV, the editor's mixing rate.
 *
 * Pure argument building and one run: the page asks for it through ttsIpc.
 */

const execFileAsync = promisify(execFile);

export const PITCH_RANGE = 6;

export function finishFilter(pitch: number, sampleRate: number, enhance: boolean): string {
  const steps = Math.max(-PITCH_RANGE, Math.min(PITCH_RANGE, Math.round(pitch * 2) / 2));
  const parts: string[] = [];
  if (steps !== 0) {
    const ratio = 2 ** (steps / 12);
    parts.push(`asetrate=${Math.round(sampleRate * ratio)}`, `aresample=${sampleRate}`, `atempo=${(1 / ratio).toFixed(5)}`);
  }
  if (enhance) {
    parts.push('highpass=f=70', 'equalizer=f=3500:t=q:w=1.2:g=2.5', 'acompressor=threshold=-20dB:ratio=2.5:attack=5:release=80:makeup=1', 'loudnorm=I=-16:TP=-1.5:LRA=11');
  } else {
    // Unprocessed, still kept off full scale.
    parts.push('alimiter=limit=0.89');
  }
  parts.push('aresample=48000');
  return parts.join(',');
}

export async function finishVoice(ffmpeg: string, source: string, target: string, options: { pitch: number; enhance: boolean; sampleRate: number }): Promise<void> {
  await execFileAsync(
    ffmpeg,
    ['-hide_banner', '-v', 'error', '-y', '-i', source, '-af', finishFilter(options.pitch, options.sampleRate, options.enhance), '-ar', '48000', '-c:a', 'pcm_s16le', target],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
}
