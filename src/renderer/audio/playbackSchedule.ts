import type { ProjectState } from '@shared/types';
import { clipSounds, hasSoloedTrack, isTrackAudible } from './mixRouting';
import { speedOf } from '@renderer/timing/clipSpeed';

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
  /**
   * How fast to play it: the clip's speed. One span of timeline needs
   * `seconds * rate` of footage, played at `rate`.
   */
  rate: number;
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
  /**
   * Timeline second nothing is planned at or past: the end of the loop, while
   * playback loops. A clip running over it is cut there, and the pass that
   * follows starts again from the loop's start.
   */
  endSeconds?: number;
  /**
   * Sources held whole in memory. There is nothing to decode for them, so a
   * clip of one is planned in a single span to its end (or `endSeconds`)
   * instead of a horizon at a time: one source node, no joins inside it.
   */
  whole?: (uri: string) => boolean;
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
  const endSeconds = options.endSeconds ?? Infinity;
  const horizonEnd = Math.min(fromSeconds + horizonSeconds, endSeconds);

  const spans: ScheduledSpan[] = [];

  for (const clip of Object.values(project.clips)) {
    const track = tracks.get(clip.trackId);
    if (!track || !isTrackAudible(track, anySolo)) continue;
    if (!canStream(clip.sourceUri)) continue;
    // A clip played backwards has no sound yet: reading a stream
    // back-to-front is not something a playback rate can express. Nor does
    // a picture whose sound was separated: its sound clip plays it.
    if (!clipSounds(clip)) continue;

    const rate = speedOf(clip);

    const clipStart = clip.startFrame / fps;
    const clipEnd = (clip.startFrame + clip.durationFrames) / fps;
    if (clipEnd <= fromSeconds || clipStart >= horizonEnd) continue;

    // Never re-schedule what an earlier call already handed to the graph.
    const alreadyTo = scheduledUntil.get(clip.id) ?? -Infinity;
    let at = Math.max(clipStart, fromSeconds, alreadyTo);
    const whole = options.whole?.(clip.sourceUri) === true;
    const until = whole ? Math.min(clipEnd, endSeconds) : Math.min(clipEnd, horizonEnd);

    while (at < until - 1e-9) {
      const seconds = whole ? until - at : Math.min(chunkSeconds, until - at);
      spans.push({
        clipId: clip.id,
        sourceUri: clip.sourceUri,
        // Where this instant sits in the source, trimming included.
        sourceFrom: clip.sourceOffsetFrames / fps + (at - clipStart) * rate,
        seconds,
        rate,
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

/** Where a span goes on the audio clock, decided as it is handed to the graph. */
export interface SpanPlacement {
  /** Audio clock time the source starts. */
  startAt: number;
  /** Timeline seconds of the span not played, because their moment has gone. */
  skip: number;
  /** Fade in from silence at `startAt`, instead of starting on whatever sample is there. */
  fadeIn: boolean;
}

export interface PlacementInputs {
  /** Audio clock time the span is meant to sound from. */
  when: number;
  /** Its length, in timeline seconds. */
  seconds: number;
  /**
   * The soonest a source can be started and be sure to start then: the audio
   * clock's time plus a margin. `currentTime` is only brought up to date once
   * per audio callback (about 10 ms on Windows), and the page's thread can be
   * held up between reading it and starting a source; a source started at a
   * time already gone starts late from the offset it was given, so it ends
   * late too, over the start of the next span - the same stretch twice, which
   * is a step at either end.
   */
  earliest: number;
  /** The span carries straight on from the one before it on the same strip, with no hole between. */
  followsOn: boolean;
  /** The clip is already sounding at the span's start: it is not the clip's own first sample. */
  startsMidSound: boolean;
  /** How long a fade in or out takes. */
  fadeSeconds: number;
}

/**
 * When and how a decoded span starts.
 *
 * On time, it starts on its moment. It fades in only when it starts mid-sound
 * after silence - the start of play part-way into a clip, or a span after a
 * hole - since a clip's own first sample is the edit's, and a span carrying on
 * from the one before must not dip. Late, it starts at the soonest safe moment,
 * that far into itself, and always fades in: what was before it is a hole.
 * What is left of a late span that cannot fade in and out is dropped (null):
 * a short silence is better than a blip.
 */
export function placeSpan(inputs: PlacementInputs): SpanPlacement | null {
  const { when, seconds, earliest, followsOn, startsMidSound, fadeSeconds } = inputs;
  if (when >= earliest) return { startAt: when, skip: 0, fadeIn: startsMidSound && !followsOn };
  const skip = earliest - when;
  if (seconds - skip < 2 * fadeSeconds) return null;
  return { startAt: earliest, skip, fadeIn: true };
}
