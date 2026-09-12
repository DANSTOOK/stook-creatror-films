/**
 * What the export progress bar says.
 *
 * "4125 / 70135 frames" answers nobody's question. Someone rendering a
 * 20-minute film wants to know how much of the film is done, how long the
 * render has run and how long it still needs - in minutes. Worked out here
 * from the encoder's own counters, and pure, so it is tested directly.
 */

export interface ExportProgressView {
  /** 0-100, one decimal. */
  percent: number;
  /** Video time rendered so far, e.g. "4:35". */
  videoDone: string;
  /** Video time the whole render covers, e.g. "19:27". */
  videoTotal: string;
  /** How long the render has been running. */
  elapsed: string;
  /** How long it still needs; null until the rate means something. */
  remaining: string | null;
  /** Render speed against playback: 2 means a minute of video every 30 s. */
  speed: number | null;
}

/** "m:ss", or "h:mm:ss" from an hour up. */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export function describeExportProgress(input: {
  frame: number;
  totalFrames: number;
  /** Frames rendered per second, averaged since the render started. */
  renderFps: number;
  /** The project's frame rate - what turns frames into video time. */
  projectFps: number;
}): ExportProgressView {
  const total = Math.max(0, Math.round(input.totalFrames));
  const frame = Math.min(total, Math.max(0, Math.round(input.frame)));
  const fps = input.projectFps > 0 ? input.projectFps : 30;
  const rate = Number.isFinite(input.renderFps) && input.renderFps > 0 ? input.renderFps : 0;

  // The first frames pay for opening decoders and the encoder; a promise made
  // from them would be wildly wrong. Wait for a second of video.
  const settled = rate > 0 && frame >= Math.min(total, Math.ceil(fps));

  return {
    percent: total > 0 ? Math.floor((frame / total) * 1000) / 10 : 0,
    videoDone: formatClock(frame / fps),
    videoTotal: formatClock(total / fps),
    elapsed: formatClock(rate > 0 ? frame / rate : 0),
    remaining: settled ? formatClock((total - frame) / rate) : null,
    speed: rate > 0 ? rate / fps : null,
  };
}
