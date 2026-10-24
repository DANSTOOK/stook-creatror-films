import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TtsEffect } from '@shared/types/ipc';

/**
 * A generated voice made ready for a video, by ffmpeg, after the engine:
 *
 *   - the silence the engine leaves before the first word and after the last
 *     cut away, so the clip holds what was asked for and nothing else, and
 *     starts on its first word where it is dropped;
 *   - its pitch, when asked, moved by `pitch` semitones without changing its
 *     pace (the rate raised or lowered, then the tempo put back) - neither
 *     engine has a pitch of its own;
 *   - a character, when asked (`effect`): the warmth of a documentary
 *     narrator, a radio host's compression, a phone line, a robot, a
 *     whisper, a cave, a stadium announcer's hall - the "voice changer"
 *     CapCut and Filmora put beside their voices;
 *   - "clear voice": rumble under 70 Hz cut, a little presence at 3.5 kHz, a
 *     gentle compressor so every word carries, and the level brought to
 *     -16 LUFS, the loudness online video aims for, its true peak held at
 *     -1.5 dB. The engines' own output peaked at full scale - clipped - which
 *     the levelling also cures;
 *   - written as 48 kHz WAV, the editor's mixing rate.
 *
 * Pure argument building and one run: the page asks for it through ttsIpc.
 */

const execFileAsync = promisify(execFile);

export const PITCH_RANGE = 6;

/** Each character as ffmpeg filters, applied after the pitch and before the levelling. */
export const EFFECT_FILTERS: Record<TtsEffect, string[]> = {
  none: [],
  // A documentary narrator: fuller low end, softer top, a small room.
  warm: ['bass=g=3:f=140', 'treble=g=-1.5', 'aecho=0.8:0.5:28:0.12'],
  // A radio host: pressed close to the microphone, every syllable at the same level.
  radio: ['highpass=f=90', 'acompressor=threshold=-24dB:ratio=6:attack=3:release=60:makeup=3', 'equalizer=f=180:t=q:w=1:g=2', 'equalizer=f=4000:t=q:w=1:g=3'],
  // A phone line: about the 300 Hz - 3.4 kHz band a call carries (each edge repeated, for a steep one).
  phone: ['highpass=f=300', 'highpass=f=300', 'lowpass=f=3200', 'lowpass=f=3200', 'lowpass=f=3200', 'acompressor=threshold=-20dB:ratio=4:attack=5:release=50'],
  // A megaphone: narrower still, and driven.
  megaphone: ['highpass=f=600', 'lowpass=f=3200', 'volume=6dB', 'alimiter=limit=0.7', 'aecho=0.6:0.4:40:0.2'],
  // A robot: every phase flattened, the voice kept as a buzz on one pitch.
  robot: ["afftfilt=real='hypot(re\\,im)*sin(0)':imag='hypot(re\\,im)*cos(0)':win_size=512:overlap=0.75"],
  // A whisper: the phases scattered, the breath kept, the tone gone.
  whisper: ["afftfilt=real='hypot(re\\,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re\\,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8", 'highpass=f=200'],
  // A cave: long, repeating echoes.
  cave: ['aecho=0.8:0.85:120|240|360:0.35|0.22|0.12'],
  // A stadium announcer: a big hall's early echoes.
  stadium: ['highpass=f=80', 'aecho=0.8:0.8:60|130|210:0.3|0.22|0.15'],
};

export const TTS_EFFECTS = Object.keys(EFFECT_FILTERS) as TtsEffect[];

/** The silence before the first word and after the last, cut away: quieter than -50 dB counts as silence. */
const TRIM = [
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04',
  'areverse',
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08',
  'areverse',
];

export function finishFilter(pitch: number, sampleRate: number, enhance: boolean, effect: TtsEffect = 'none'): string {
  const steps = Math.max(-PITCH_RANGE, Math.min(PITCH_RANGE, Math.round(pitch * 2) / 2));
  const parts: string[] = [...TRIM];
  if (steps !== 0) {
    const ratio = 2 ** (steps / 12);
    parts.push(`asetrate=${Math.round(sampleRate * ratio)}`, `aresample=${sampleRate}`, `atempo=${(1 / ratio).toFixed(5)}`);
  }
  parts.push(...(EFFECT_FILTERS[effect] ?? []));
  if (enhance) {
    parts.push('highpass=f=70', 'equalizer=f=3500:t=q:w=1.2:g=2.5', 'acompressor=threshold=-20dB:ratio=2.5:attack=5:release=80:makeup=1', 'loudnorm=I=-16:TP=-1.5:LRA=11');
  } else {
    // Unprocessed, still kept off full scale.
    parts.push('alimiter=limit=0.89');
  }
  parts.push('aresample=48000');
  return parts.join(',');
}

export async function finishVoice(
  ffmpeg: string,
  source: string,
  target: string,
  options: { pitch: number; enhance: boolean; sampleRate: number; effect?: TtsEffect },
): Promise<void> {
  await execFileAsync(
    ffmpeg,
    ['-hide_banner', '-v', 'error', '-y', '-i', source, '-af', finishFilter(options.pitch, options.sampleRate, options.enhance, options.effect ?? 'none'), '-ar', '48000', '-c:a', 'pcm_s16le', target],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
}
