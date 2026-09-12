import type { ProjectState } from '@shared/types';
import { hasSoloedTrack, isTrackAudible } from './mixRouting';

/**
 * What to decode and sound next, while playing.
 *
 * Playback used to hand the whole of every source to the audio graph at
 * once, which is only possible because the whole of every source was in
 * memory. Streaming it means deciding, a few times a second, which short
 * spans to fetch and when each should sound.
 *
 * That decision is pure and lives here, so it can be tested without an audio
 * device: the engine only carries out the plan. Everything is in seconds -
 * timeline seconds for when a span sounds, source seconds for where to read
 * it - because the audio clock works in seconds and frames would round.
 */

export interface ScheduledSpan {
  clipId: string;
  sourceUri: string;
  /** Where to read in the source, in seconds from its start. */
  sourceFrom: number;
  seconds: number;
  /** When it sounds, in timeline seconds. */
  atTimeline: number;
}

export interface PlanOptions {
  /** Timeline position playback has reached, in seconds. */
  fromSeconds: number;
  /** How far ahead of that to schedule. */
  horizonSeconds: number;
  /** Longest span to ask for at once; longer stretches are split. */
  chunkSeconds: number;
  /** Timeline seconds already scheduled per clip, from earlier calls. */
  scheduledUntil: ReadonlyMap<string, number>;
  /** Whether a source can be streamed at all (AAC in MP4, and has sound). */
  canStream: (uri: string) => boolean;
}

/**
 * The spans to schedule now.
 *
 * Only what is not already scheduled, only clips that are actually audible
 * (mute and solo included, as playback has always honoured them), and only
 * as far as the horizon reaches - so a 45-minute clip costs the same as a
 * short one.
 */
export function planPlaybackSpans(project: ProjectState, options: PlanOptions): ScheduledSpan[] {
  const { fromSeconds, horizonSeconds, chunkSeconds, scheduledUntil, canStream } = options;
  const { fps } = project;
  const anySolo = hasSoloedTrack(project);
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const horizonEnd = fromSeconds + horizonSeconds;

  const spans: ScheduledSpan[] = [];

  for (const clip of Object.values(project.clips)) {
    const track = tracks.get(clip.trackId);
    if (!track || !isTrackAudible(track, anySolo)) continue;
    if (!canStream(clip.sourceUri)) continue;

    const clipStart = clip.startFrame / fps;
    const clipEnd = (clip.startFrame + clip.durationFrames) / fps;
    if (clipEnd <= fromSeconds || clipStart >= horizonEnd) continue;

    // Never re-schedule what an earlier call already handed to the graph.
    const alreadyTo = scheduledUntil.get(clip.id) ?? -Infinity;
    let at = Math.max(clipStart, fromSeconds, alreadyTo);
    const until = Math.min(clipEnd, horizonEnd);

    while (at < until - 1e-9) {
      const seconds = Math.min(chunkSeconds, until - at);
      spans.push({
        clipId: clip.id,
        sourceUri: clip.sourceUri,
        // Where this instant sits in the source, trimming included.
        sourceFrom: clip.sourceOffsetFrames / fps + (at - clipStart),
        seconds,
        atTimeline: at,
      });
      at += seconds;
    }
  }

  return spans.sort((a, b) => a.atTimeline - b.atTimeline);
}

/** The scheduled-until marks after these spans have been handed over. */
export function advanceScheduled(
  scheduledUntil: ReadonlyMap<string, number>,
  spans: readonly ScheduledSpan[],
): Map<string, number> {
  const next = new Map(scheduledUntil);
  for (const span of spans) {
    next.set(span.clipId, Math.max(next.get(span.clipId) ?? -Infinity, span.atTimeline + span.seconds));
  }
  return next;
}

/**
 * Marks for clips that are no longer worth remembering.
 *
 * A clip that finished before the playhead will not be scheduled again, and
 * one the playhead jumped away from has to start afresh - keeping its old
 * mark would leave a hole where the jump landed.
 */
export function forgetPassed(
  scheduledUntil: ReadonlyMap<string, number>,
  fromSeconds: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [clipId, until] of scheduledUntil) {
    if (until > fromSeconds) next.set(clipId, until);
  }
  return next;
}
