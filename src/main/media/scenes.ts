/**
 * Where a file's picture changes shot, for "Split at scene changes":
 * ffmpeg's scene score (`select='gt(scene,T)'`) over the stretch of the file
 * a clip uses, on a small copy of each frame - the score compares whole
 * frames, and a 320-wide one gives the same cuts at a fraction of the work.
 *
 * `showinfo` prints `pts_time:S` for each frame the select lets through,
 * counted from where the stretch starts (the `-ss`).
 */

export interface SceneRequest {
  /** 0..1: how different two frames have to be to count as a cut. Lower finds more. */
  threshold: number;
  /** The stretch of the file to look in, in seconds of the file. */
  fromSeconds: number;
  toSeconds: number;
}

/** ffmpeg arguments that print the shot changes of `path` between `from` and `to`. */
export function sceneArgs(path: string, request: SceneRequest): string[] {
  const from = Math.max(0, request.fromSeconds);
  const length = Math.max(0.05, request.toSeconds - from);
  const threshold = Math.min(0.9, Math.max(0.05, request.threshold));
  return [
    '-hide_banner',
    '-nostats',
    '-ss', from.toFixed(3),
    '-t', length.toFixed(3),
    '-i', path,
    '-an',
    '-vf', `scale=320:-2,select='gt(scene,${threshold.toFixed(3)})',showinfo`,
    '-f', 'null',
    '-',
  ];
}

/** The shot changes ffmpeg printed, in seconds of the file, in order, inside the stretch. */
export function parseScenes(stderr: string, request: SceneRequest): number[] {
  const from = Math.max(0, request.fromSeconds);
  const cuts: number[] = [];
  for (const match of stderr.matchAll(/pts_time:\s*(-?[\d.]+)/g)) {
    const at = from + Number(match[1]);
    if (Number.isFinite(at) && at > from && at < request.toSeconds) cuts.push(at);
  }
  return [...new Set(cuts.map((at) => Math.round(at * 1000) / 1000))].sort((a, b) => a - b);
}
