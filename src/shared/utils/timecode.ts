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
