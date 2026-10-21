/**
 * Where a file's sound goes quiet, for "Remove silences": ffmpeg's own
 * silencedetect filter over the stretch of the file a clip uses.
 *
 * The filter prints `silence_start: S` and `silence_end: E | silence_duration: D`
 * to stderr as it finds them, counting from the start of what it was given -
 * so from the `-ss` it was started at. A silence still running when the
 * stretch ends has a start and no end: it lasts to the end of the stretch.
 */

export interface SilenceRequest {
  /** Quieter than this is silence, in dBFS (e.g. -38). */
  noiseDb: number;
  /** Shorter quiet stretches are pauses in speech, not silences. */
  minSeconds: number;
  /** The stretch of the file to look in, in seconds of the file. */
  fromSeconds: number;
  toSeconds: number;
}

export interface SilenceSpan {
  /** In seconds of the file. */
  start: number;
  end: number;
}

/** ffmpeg arguments that print the silences of `path` between `from` and `to`. */
export function silenceArgs(path: string, request: SilenceRequest): string[] {
  const from = Math.max(0, request.fromSeconds);
  const length = Math.max(0.05, request.toSeconds - from);
  const noise = Math.min(-5, Math.max(-90, request.noiseDb));
  const minimum = Math.min(30, Math.max(0.05, request.minSeconds));
  return [
    '-hide_banner',
    '-nostats',
    '-ss', from.toFixed(3),
    '-t', length.toFixed(3),
    '-i', path,
    '-map', '0:a:0',
    '-af', `silencedetect=noise=${noise}dB:d=${minimum}`,
    '-f', 'null',
    '-',
  ];
}

/** The silences ffmpeg printed, in seconds of the file, within the stretch asked about. */
export function parseSilences(stderr: string, request: SilenceRequest): SilenceSpan[] {
  const from = Math.max(0, request.fromSeconds);
  const to = request.toSeconds;
  const spans: SilenceSpan[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      open = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end && open !== null) {
      spans.push({ start: from + open, end: Math.min(to, from + Number(end[1])) });
      open = null;
    }
  }
  // Quiet to the very end of the stretch.
  if (open !== null && from + open < to) spans.push({ start: from + open, end: to });
  return spans.filter((span) => span.end > span.start);
}
