import type { ClipTransform, Keyframe, ProjectState, Vector2D } from '@shared/types';
import { createId } from '@shared/utils/id';

/**
 * A new frame shape - the viewer's 16:9, 9:16, 1:1, 4:5 - without stretching
 * anything.
 *
 * A clip at scale 1 fills the frame whatever its shape (Compositor), so a
 * 16:9 video in a frame turned 9:16 would be squeezed to the new shape. Every
 * picture is given the scale that keeps it as it looked instead: its own
 * shape, as big against the new frame as it was against the old one - a video
 * that filled the width of a landscape frame fills the width of a vertical
 * one, with bars above and below, as CapCut's ratio switch leaves it - and as
 * far from the middle, in proportion, as it sat. Titles, captions and
 * adjustment layers are laid out on the frame itself and need nothing.
 *
 * Pure: the viewer's shape menu applies the result through the store.
 */

type Frame = { width: number; height: number };

/** How wide a picture of shape `aspect` is drawn when fitted whole inside `frame`. */
const fittedWidth = (aspect: number, frame: Frame): number => (aspect >= frame.width / frame.height ? frame.width : frame.height * aspect);

/** The scale that shows the same picture in the new frame: its shape kept, as big against the frame as before. */
export function refitScale(scale: Vector2D, from: Frame, to: Frame): Vector2D {
  const drawnWidth = Math.abs(scale.x) * from.width;
  const drawnHeight = Math.abs(scale.y) * from.height;
  if (!(drawnWidth > 0 && drawnHeight > 0) || !(to.width > 0 && to.height > 0)) return scale;
  const aspect = drawnWidth / drawnHeight;
  const width = (drawnWidth / fittedWidth(aspect, from)) * fittedWidth(aspect, to);
  // A mirrored picture (a negative scale) stays mirrored.
  return { x: (Math.sign(scale.x) * width) / to.width, y: (Math.sign(scale.y) * (width / aspect)) / to.height };
}

/** Each picture clip's new position and scale tracks for a frame of `size`. */
export function refitForFrame(project: Pick<ProjectState, 'clips' | 'tracks' | 'width' | 'height'>, size: Frame): Record<string, Pick<ClipTransform, 'position' | 'scale'>> {
  const from = { width: project.width, height: project.height };
  const sound = new Set(project.tracks.filter((track) => track.type === 'audio').map((track) => track.id));
  const moves: Record<string, Pick<ClipTransform, 'position' | 'scale'>> = {};
  for (const clip of Object.values(project.clips)) {
    if (clip.title || clip.caption || clip.adjustment || clip.audioOnly || sound.has(clip.trackId)) continue;
    // The clip's own tracks: a screen move (fx) is made again on them by the store.
    const base = clip.fx?.base ?? clip.transform;
    const scaleTrack: Keyframe<Vector2D>[] = base.scale.length > 0
      ? base.scale
      : [{ id: createId('kf'), frame: Math.max(0, Math.round(clip.startFrame)), value: { x: 1, y: 1 }, easing: 'linear' }];
    moves[clip.id] = {
      scale: scaleTrack.map((key) => ({ ...key, value: refitScale(key.value, from, size) })),
      position: base.position.map((key) => ({ ...key, value: { x: (key.value.x * size.width) / from.width, y: (key.value.y * size.height) / from.height } })),
    };
  }
  return moves;
}
