/**
 * The picture waiting for the sound at the start of play.
 *
 * Streamed sound has to be decoded before it can be heard, and the first
 * span of it can take anything from a few milliseconds to a quarter of a
 * second when the machine is busy (measured: a long file's waveform being
 * measured, a CPU hog, both). The audio engine used to start that span part
 * of the way in, at whatever moment it arrived, while the picture had already
 * set off - a step in the waveform, a click, at most starts of play. Premiere
 * and Resolve wait instead: nothing moves until the sound is ready, and then
 * both go together.
 *
 * So the engine holds the playhead while it waits (`holdPlayback`) and lets go
 * of it on the moment the sound begins (`releasePlayback`), and the playback
 * clock (hooks/useTransport `runPlaybackClock`) counts no time while held.
 * The engine bounds the wait itself, so a held playhead always moves again.
 */

/**
 * `performance.now()` time from which the playhead may move: Infinity while
 * the sound is still being made ready, null when nothing holds it.
 */
let releaseAt: number | null = null;

/** Hold the playhead until `releasePlayback`. */
export function holdPlayback(): void {
  releaseAt = Infinity;
}

/**
 * Let the playhead move from `at` (`performance.now()` time): the moment the
 * sound begins, which can be a few milliseconds ahead.
 */
export function releasePlayback(at: number = performance.now()): void {
  if (releaseAt !== null) releaseAt = at;
}

/** Forget any hold: playback stopped, or a new one is about to be set. */
export function clearPlaybackHold(): void {
  releaseAt = null;
}

/**
 * Where the playback clock should count time from, on a tick at `now`:
 * `null` while the playhead is held (count nothing), otherwise the later of
 * `lastTime` and the release - so the time spent waiting is never played
 * through in one jump.
 */
export function heldClockFrom(now: number, lastTime: number): number | null {
  if (releaseAt === null) return lastTime;
  if (now < releaseAt) return null;
  const from = Math.max(lastTime, releaseAt);
  releaseAt = null;
  return from;
}
