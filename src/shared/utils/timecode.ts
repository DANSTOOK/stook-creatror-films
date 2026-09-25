/** Timecode conversion helpers. All projects use non-drop-frame timecode. */

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** `frames` -> `HH:MM:SS:FF`. Negative input clamps to zero. */
export function framesToTimecode(frames: number, fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError(`Invalid fps: ${fps}`);
  const total = Math.max(0, Math.round(frames));
  const rate = Math.round(fps);

  const ff = total % rate;
  const totalSeconds = Math.floor(total / rate);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

/** `HH:MM:SS:FF` -> frames. Throws on malformed input. */
export function timecodeToFrames(timecode: string, fps: number): number {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{1,3})$/.exec(timecode.trim());
  if (!match) throw new SyntaxError(`Malformed timecode: "${timecode}"`);

  const [, h, m, s, f] = match;
  const rate = Math.round(fps);
  const frames = Number(f);
  if (frames >= rate) throw new RangeError(`Frame field ${frames} exceeds ${rate} fps`);

  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * rate + frames;
}

export const framesToSeconds = (frames: number, fps: number): number => frames / fps;

export const secondsToFrames = (seconds: number, fps: number): number =>
  Math.round(seconds * fps);

/** Compact `M:SS` label used in the timeline ruler. */
export function framesToShortLabel(frames: number, fps: number): string {
  const totalSeconds = Math.floor(Math.max(0, frames) / fps);
  return `${Math.floor(totalSeconds / 60)}:${pad2(totalSeconds % 60)}`;
}

/**
 * A duration as someone types it into a timecode field, in frames.
 *
 * Fields are read from the right, as Premiere reads them: "2:15" is two
 * seconds and fifteen frames, "1:00:00" a minute, "0:00:04:10" four seconds
 * and ten frames. A bare number is a count of frames. Anything else - letters,
 * a frame field past the rate, a negative - is null, so the field can say it
 * is wrong instead of guessing.
 */
export function parseDuration(text: string, fps: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+([:;]\d+){0,3}$/.test(trimmed)) return null;
  const parts = trimmed.split(/[:;]/).map(Number);
  if (parts.length === 1) return parts[0];
  const rate = Math.round(fps);
  const [ff, ss = 0, mm = 0, hh = 0] = parts.reverse();
  if (ff >= rate || (parts.length > 2 && ss >= 60) || (parts.length > 3 && mm >= 60)) return null;
  return ((hh * 60 + mm) * 60 + ss) * rate + ff;
}
