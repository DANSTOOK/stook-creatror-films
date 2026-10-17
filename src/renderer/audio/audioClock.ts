/**
 * What the playback hook does about the audio clock on each frame.
 *
 * The playhead runs on its own clock (hooks/useTransport) and the sound is
 * scheduled on the AudioContext's; while playing, a playhead that has moved
 * away from the sound means the user moved it, and the sound is scheduled
 * again from there ('resync').
 *
 * An AudioContext can stand still, though - suspended with no output device,
 * after the computer sleeps, while a device is swapped, or when Windows holds
 * the audio back - and a clock that stands still is always "behind". The
 * check used to read that as a scrub and rebuild the whole graph, decoding
 * a few seconds of every streamed source, three times a second, for no sound
 * at all: measured on v1.41, 6 rebuilds in 2 s. Now a suspended clock is
 * asked to run again, at most once a second ('wake'), and left alone in
 * between ('wait'). Once it runs, it is behind the playhead, and the next
 * frame's check puts the sound back under the picture.
 */

export type AudioClockAction = 'resync' | 'wake' | 'wait' | 'none';

/** How often a suspended context is asked to resume: one that cannot may refuse for as long as it likes. */
export const WAKE_INTERVAL_MS = 1000;

export function audioClockAction(
  contextState: string,
  driftSeconds: number,
  msSinceWake: number,
  thresholdSeconds: number,
): AudioClockAction {
  if (contextState === 'suspended') return msSinceWake >= WAKE_INTERVAL_MS ? 'wake' : 'wait';
  // Closed, or a state a later Chromium adds ('interrupted'): nothing to schedule against.
  if (contextState !== 'running') return 'wait';
  return Math.abs(driftSeconds) > thresholdSeconds ? 'resync' : 'none';
}

/**
 * How far the playhead is from the sound, round a loop.
 *
 * Round a loop the two wrap a moment apart: the picture a frame at a time,
 * the sound on its sample. Just either side of the join they read a whole
 * loop apart while being a frame apart, and taken at face value that would
 * be a resync - a rebuilt graph - every time round. So the shorter way round
 * is the drift. Without a loop (`loopSeconds` null) it is the drift as is.
 */
export function driftRoundLoop(driftSeconds: number, loopSeconds: number | null): number {
  if (loopSeconds === null || !(loopSeconds > 0)) return driftSeconds;
  // The other way round: the same two points, the loop's length the other side.
  const across = driftSeconds - Math.sign(driftSeconds) * loopSeconds;
  return Math.abs(across) < Math.abs(driftSeconds) ? across : driftSeconds;
}
