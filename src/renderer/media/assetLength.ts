/**
 * How long a piece of media is, in frames of the project as it is now.
 *
 * A file's length is a number of seconds. The library used to keep it only as
 * a number of frames, counted at whatever rate the project had on the day it
 * was imported - and changing the frame rate in Project Settings rescaled the
 * clips on the timeline but not the library. Everything placed afterwards came
 * in at the old rate's length: at 30 to 24 fps, a quarter longer than the file
 * itself, running past its real end into black and silence. The 55-minute
 * stress run at 24 fps is what found it.
 *
 * Kept in seconds now, and turned into frames at the moment it is used, so it
 * is right at any rate - and stays right when the rate change is undone, which
 * rescaling the library in place never could be.
 */

export interface MeasuredMedia {
  /** Frames at the rate the asset was imported at. The fallback for older projects. */
  durationFrames: number;
  /** The file's own length, when it was measured. */
  durationSeconds?: number;
}

export function assetLengthFrames(asset: MeasuredMedia, fps: number): number {
  if (asset.durationSeconds !== undefined && Number.isFinite(asset.durationSeconds) && fps > 0) {
    return Math.max(1, Math.round(asset.durationSeconds * fps));
  }
  return Math.max(1, Math.round(asset.durationFrames));
}

/** The same length in seconds, for showing it. */
export function assetLengthSeconds(asset: MeasuredMedia, fps: number): number {
  if (asset.durationSeconds !== undefined && Number.isFinite(asset.durationSeconds)) return asset.durationSeconds;
  return fps > 0 ? asset.durationFrames / fps : 0;
}
