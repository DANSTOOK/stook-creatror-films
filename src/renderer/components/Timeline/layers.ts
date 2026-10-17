import type { Clip, ProjectState, Track } from '@shared/types';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { fadeGainAt } from '@renderer/timing/clipFades';
import { activeTransitionsAt } from '@renderer/timing/transitions';
import { quadCorners } from '@renderer/components/PreviewViewport/viewportTransform';
import { isPictureTrack } from './trackRows';

/**
 * Which layer a clip is on, and whether anything above hides it.
 *
 * Every editor stacks pictures the same way - a clip on a higher track covers
 * the ones below, Video 1 is the bottom - and so does this one. What was
 * missing is being told: a title put on Video 1 under a video on Video 2 is
 * drawn exactly as it should be, which is not at all, and nothing said why.
 * The inspector says which layer a clip is on, and, when something above
 * hides it, what and where, with a way to put it on top.
 *
 * "Hides" is meant strictly. The inspector only says it when the picture
 * really does not reach the screen at that frame, whatever is in the
 * footage: a warning that is sometimes wrong teaches people to ignore it.
 * So anything that might let the clip through - transparency, a key, a
 * mask, a fade, a transition, a blend mode, a picture smaller than the
 * frame - counts as not hiding it.
 */

export interface ClipLayer {
  track: Track;
  /** 1 for the bottom picture track. */
  layer: number;
  /** How many picture tracks there are. */
  layers: number;
  /** The picture track directly above, and directly below; null at either end. */
  above: Track | null;
  below: Track | null;
}

/** Picture tracks, bottom first: the order the compositor draws them in. */
const pictureTracks = (project: ProjectState): Track[] =>
  project.tracks.filter(isPictureTrack).sort((a, b) => a.order - b.order);

const liveAt = (clip: Clip, frame: number): boolean => frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames;

/** The layer a clip is on; null for a clip that is not on a picture track (sound, captions). */
export function clipLayer(project: ProjectState, clipId: string): ClipLayer | null {
  const clip = project.clips[clipId];
  if (!clip) return null;
  const tracks = pictureTracks(project);
  const index = tracks.findIndex((track) => track.id === clip.trackId);
  if (index === -1) return null;
  return {
    track: tracks[index],
    layer: index + 1,
    layers: tracks.length,
    above: tracks[index + 1] ?? null,
    below: tracks[index - 1] ?? null,
  };
}

/**
 * Whether a clip, drawn at this frame, replaces everything under it.
 *
 * It has to be solid and over the whole frame, and it has to be in the
 * normal blend mode. With an opaque layer, the W3C blend the compositor uses
 * gives B(Cb, Cs) - the backdrop Cb mixed with the layer's own colour Cs -
 * and only for normal is that Cs alone. Every other mode lets the backdrop
 * through somewhere: multiply and darken where the layer is white, screen,
 * lighten, colour dodge, difference and exclusion where it is black, colour
 * burn where it is white, overlay, hard and soft light where it is mid-grey
 * - there B(Cb, Cs) is exactly Cb. Which colours a frame holds is not known
 * here, so a clip in any of those modes never counts as hiding what is under
 * it (tests/Layers.test.ts checks those neutral colours against
 * engine/blending).
 */
export function coversFrame(clip: Clip, frame: number, size: { width: number; height: number }): boolean {
  if ((clip.blendMode ?? 'normal') !== 'normal') return false;
  // Text, captions and anything with transparency let what is below show.
  if (clip.title || clip.caption || clip.hasAlphaChannel) return false;
  // The same conditions the compositor applies them on (Compositor
  // applyEffectChain); a matte from Remove background is transparent where
  // it takes the background away, and frames not yet analysed are drawn whole.
  if ((clip.mask.enabled && clip.mask.type !== 0) || clip.chromaKey.enabled || clip.backgroundRemoval.enabled) return false;
  if (!liveAt(clip, frame)) return false;
  if (fadeGainAt(clip, frame - clip.startFrame) < 0.999) return false;
  const transform = evaluateTransform(clip.transform, frame);
  if (transform.opacity < 0.999) return false;
  // Straight, or a half or quarter turn: anything else leaves corners open.
  const turn = ((transform.rotation % 90) + 90) % 90;
  if (turn > 0.01 && turn < 89.99) return false;
  const corners = quadCorners(transform, size);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const slack = 0.5;
  return Math.min(...xs) <= slack && Math.max(...xs) >= size.width - slack && Math.min(...ys) <= slack && Math.max(...ys) >= size.height - slack;
}

/**
 * The topmost clip that hides `clipId` completely at `frame`: on a visible
 * picture track above it, and covering the frame (coversFrame). Null when the
 * clip shows, or is not on screen at that frame.
 *
 * Once one layer has replaced the picture, nothing above can bring the clip
 * back - every later layer is mixed with what is already there - so any one
 * such clip above is enough, whatever modes the clips between use.
 */
export function coveringClip(project: ProjectState, clipId: string, frame: number): { clip: Clip; track: Track } | null {
  const clip = project.clips[clipId];
  const own = clip ? project.tracks.find((track) => track.id === clip.trackId) : undefined;
  if (!clip || !own || !isPictureTrack(own) || clip.caption) return null;
  if (!liveAt(clip, frame)) return null;
  // Either side of a transition on screen is drawn mixed with the other, and
  // a wipe or a transition into nothing leaves part of the frame open.
  const inTransition = new Set<string>();
  for (const { from, to } of activeTransitionsAt(project, frame)) {
    inTransition.add(from.id);
    inTransition.add(to.id);
  }
  const size = { width: project.width, height: project.height };
  const above = pictureTracks(project)
    .filter((track) => track.order > own.order && track.visible)
    .reverse();
  for (const track of above) {
    const cover = Object.values(project.clips).find(
      (candidate) => candidate.trackId === track.id && !inTransition.has(candidate.id) && coversFrame(candidate, frame, size),
    );
    if (cover) return { clip: cover, track };
  }
  return null;
}

/**
 * The frame the inspector asks about for a clip: the playhead while it is
 * over the clip, otherwise the clip's first frame - so a clip picked away
 * from the playhead is still judged where it would be seen.
 */
export const frameToJudge = (clip: Clip, playhead: number): number => (liveAt(clip, playhead) ? playhead : clip.startFrame);

/**
 * Where "move above" puts a clip: the first picture track above everything
 * that overlaps it in time, unlocked, switched on and free for its whole
 * length - or null for a new track on top.
 *
 * The rule a new title follows (text/titleClip planTitlePlacement), with one
 * more condition: a track whose picture is switched off is passed over,
 * since the whole point of the move is to be seen.
 */
export function trackAboveFor(project: ProjectState, clipId: string): string | null {
  const clip = project.clips[clipId];
  if (!clip) return null;
  const start = clip.startFrame;
  const end = clip.startFrame + clip.durationFrames;
  const others = Object.values(project.clips).filter((candidate) => candidate.id !== clipId);
  const overlapsOn = (track: Track): boolean =>
    others.some((other) => other.trackId === track.id && other.startFrame < end && other.startFrame + other.durationFrames > start);
  const tracks = pictureTracks(project);
  let covered = -Infinity;
  for (const track of tracks) if (overlapsOn(track)) covered = Math.max(covered, track.order);
  const free = tracks.find((track) => track.order > covered && !track.locked && track.visible && !overlapsOn(track));
  return free?.id ?? null;
}
