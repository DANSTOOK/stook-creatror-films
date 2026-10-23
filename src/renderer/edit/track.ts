import type { Clip, Keyframe, MediaAsset, ProjectState, ResolvedTransform, Vector2D } from '@shared/types';
import { createId } from '@shared/utils/id';
import { evaluateTransform } from '@renderer/engine/KeyframeEvaluator';
import { simplified } from '@renderer/fx/motion/animations';
import { speedOf, isReversed } from '@renderer/timing/clipSpeed';

/**
 * Motion tracking: a sticker, a title or a picture made to follow a thing in
 * the video under it. The thing is marked with a box in the viewer; the file
 * under it is followed from there (main/media/trackJob.ts); and the follower
 * is given position keyframes that move it as the thing moved on screen -
 * through the video clip's own position and scale, so a zoomed or moved clip
 * is followed where it is drawn.
 *
 * Pure: the inspector's Effects tab runs it, and edit/trackApply.ts writes it.
 */

/** A box on the frame: centre and size, 0..1 of the frame. */
export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackSampleLike {
  t: number;
  x: number;
  y: number;
  score: number;
  /** The thing's size against its size where it was marked (1 from a build that did not measure it). */
  scale?: number;
  /** How far it has turned since it was marked, degrees clockwise (0 from a build that did not measure it). */
  angle?: number;
}

/** A match under this holds the follower where it was (main/media/tracker.ts MIN_MATCH). */
export const TRACK_MIN_SCORE = 0.45;

type Frame = Pick<ProjectState, 'width' | 'height'>;

/** Where a clip's picture is drawn on the frame at one moment, in project pixels: its rectangle. */
function drawnRect(transform: ResolvedTransform, project: Frame): { left: number; top: number; width: number; height: number } {
  const width = project.width * transform.scale.x;
  const height = project.height * transform.scale.y;
  const cx = project.width / 2 + transform.position.x;
  const cy = project.height / 2 + transform.position.y;
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}

/** A box drawn on the frame as a box on the clip's picture (0..1 of its file's picture), at `frame`. */
export function frameBoxToSource(box: FrameBox, clip: Clip, frame: number, project: Frame): FrameBox {
  const rect = drawnRect(evaluateTransform(clip.transform, frame), project);
  return {
    x: (box.x * project.width - rect.left) / rect.width,
    y: (box.y * project.height - rect.top) / rect.height,
    width: (box.width * project.width) / rect.width,
    height: (box.height * project.height) / rect.height,
  };
}

/** A point on the clip's picture (0..1) where it is on the frame at `frame`, in project pixels. */
export function sourceToFrame(point: Vector2D, clip: Clip, frame: number, project: Frame): Vector2D {
  const rect = drawnRect(evaluateTransform(clip.transform, frame), project);
  return { x: rect.left + point.x * rect.width, y: rect.top + point.y * rect.height };
}

/** Whether a clip's picture can be followed: footage from a file, played forwards. */
export const canTrackIn = (clip: Clip, asset: MediaAsset | undefined): boolean =>
  Boolean(asset && asset.kind === 'video' && asset.sourcePath && !isReversed(clip) && !clip.title && !clip.caption);

/** The last frame both clips are on the timeline: as far as a follower can follow. */
export const trackEndFrame = (target: Clip, follower: Clip): number =>
  Math.min(follower.startFrame + follower.durationFrames - 1, target.startFrame + target.durationFrames - 1);

/** What to ask the main process for: the stretch of the file under `target` from `startFrame` to `endFrame`. */
export function trackRequest(target: Clip, asset: MediaAsset, box: FrameBox, startFrame: number, endFrame: number, project: Pick<ProjectState, 'width' | 'height' | 'fps'>) {
  const speed = speedOf(target);
  const from = (target.sourceOffsetFrames + (startFrame - target.startFrame) * speed) / project.fps;
  const to = (target.sourceOffsetFrames + (endFrame + 1 - target.startFrame) * speed) / project.fps;
  const source = frameBoxToSource(box, target, startFrame, project);
  return {
    fromSeconds: from,
    toSeconds: to,
    // A sample a timeline frame: the file runs `speed` times as fast under it.
    sampleFps: Math.max(1, Math.min(60, project.fps * speed)),
    box: source,
    sourceWidth: asset.width || project.width,
    sourceHeight: asset.height || project.height,
  };
}

/**
 * The follower's position keyframes: from `startFrame`, where the thing was
 * marked, it moves as the thing moves on screen, from `origin` (where it is
 * there). A sample that did not match well holds the last good place.
 * Keyframes only where the path needs them (to within 1.5 px).
 */
export function followerKeyframes(
  samples: readonly TrackSampleLike[],
  target: Clip,
  origin: Vector2D,
  startFrame: number,
  endFrame: number,
  project: Pick<ProjectState, 'width' | 'height' | 'fps'>,
): Keyframe<Vector2D>[] {
  if (samples.length === 0) return [];
  const speed = speedOf(target);
  const first = sourceToFrame(samples[0], target, startFrame, project);
  let last = first;
  const byFrame = new Map<number, Keyframe<Vector2D>>();
  for (const sample of samples) {
    const frame = startFrame + Math.round((sample.t * project.fps) / speed);
    if (frame > endFrame) break;
    const here = sample.score >= TRACK_MIN_SCORE ? sourceToFrame(sample, target, frame, project) : last;
    last = here;
    byFrame.set(frame, { id: createId('kf'), frame, value: { x: origin.x + (here.x - first.x), y: origin.y + (here.y - first.y) }, easing: 'linear' });
  }
  return simplified([...byFrame.values()], 1.5);
}

/**
 * The follower's size keyframes, for a follow that takes size too: from
 * `startFrame` it grows and shrinks as the thing did on screen - its own size
 * in the file, and the video clip's own zoom - from `own`, its size there.
 * A lost sample holds the last good size. Keyframes only where the change
 * shows (half a percent).
 */
export function followerScaleKeyframes(
  samples: readonly TrackSampleLike[],
  target: Clip,
  own: Vector2D,
  startFrame: number,
  endFrame: number,
  fps: number,
): Keyframe<Vector2D>[] {
  if (samples.length === 0) return [];
  const speed = speedOf(target);
  const zoomAt = (frame: number): Vector2D => evaluateTransform(target.transform, frame).scale;
  const zoom0 = zoomAt(startFrame);
  const first = samples[0].scale ?? 1;
  let last = first;
  const byFrame = new Map<number, Keyframe<Vector2D>>();
  for (const sample of samples) {
    const frame = startFrame + Math.round((sample.t * fps) / speed);
    if (frame > endFrame) break;
    const size = sample.score >= TRACK_MIN_SCORE && sample.scale ? sample.scale : last;
    last = size;
    const zoom = zoomAt(frame);
    const grown = size / first;
    byFrame.set(frame, {
      id: createId('kf'),
      frame,
      value: { x: own.x * grown * (zoom.x / (zoom0.x || 1)), y: own.y * grown * (zoom.y / (zoom0.y || 1)) },
      easing: 'linear',
    });
  }
  // Half a percent of its own size: a change smaller than that does not show.
  return simplified([...byFrame.values()], Math.max(0.0005, 0.005 * Math.max(own.x, own.y)));
}

/**
 * The follower's turn keyframes, for a follow that takes the turn too: from
 * `startFrame` it turns as the thing turned on screen - in the file, and the
 * video clip's own rotation - from `own`, its rotation there. A lost sample
 * holds the last good turn. Keyframes only where it shows (a quarter degree).
 */
export function followerRotationKeyframes(
  samples: readonly TrackSampleLike[],
  target: Clip,
  own: number,
  startFrame: number,
  endFrame: number,
  fps: number,
): Keyframe<number>[] {
  if (samples.length === 0) return [];
  const speed = speedOf(target);
  const turnAt = (frame: number): number => evaluateTransform(target.transform, frame).rotation;
  const turn0 = turnAt(startFrame);
  const first = samples[0].angle ?? 0;
  let last = first;
  const byFrame = new Map<number, Keyframe<number>>();
  for (const sample of samples) {
    const frame = startFrame + Math.round((sample.t * fps) / speed);
    if (frame > endFrame) break;
    const angle = sample.score >= TRACK_MIN_SCORE && sample.angle !== undefined ? sample.angle : last;
    last = angle;
    byFrame.set(frame, { id: createId('kf'), frame, value: own + (angle - first) + (turnAt(frame) - turn0), easing: 'linear' });
  }
  return simplified([...byFrame.values()], 0.25);
}

/** The video clip a follower sits over at `frame`: the topmost one on a track below its own that can be followed. */
export function trackTargetFor(project: ProjectState, assets: readonly MediaAsset[], follower: Clip, frame: number): Clip | null {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const followerOrder = tracks.get(follower.trackId)?.order ?? 0;
  const candidates = Object.values(project.clips).filter((clip) => {
    const track = tracks.get(clip.trackId);
    return (
      clip.id !== follower.id &&
      track?.type === 'video' &&
      track.order < followerOrder &&
      frame >= clip.startFrame &&
      frame < clip.startFrame + clip.durationFrames &&
      canTrackIn(clip, assets.find((asset) => asset.uri === clip.sourceUri))
    );
  });
  return candidates.sort((a, b) => (tracks.get(b.trackId)?.order ?? 0) - (tracks.get(a.trackId)?.order ?? 0))[0] ?? null;
}
