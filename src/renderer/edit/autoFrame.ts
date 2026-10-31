import type { Clip, Keyframe, MediaAsset, ProjectState, Vector2D } from '@shared/types';
import { createId } from '@shared/utils/id';
import { simplified } from '@renderer/fx/motion/animations';
import { coverScale } from './reframe';

/**
 * Auto framing: the camera follows the person's head inside the frame the
 * project already has.
 *
 * "Reframe for vertical" (edit/reframe.ts) turns the whole project into
 * another shape. This is the other half of the same idea and the one a podcast
 * needs: the shape stays, the clip is pushed in a little, and the picture pans
 * to keep the head where a camera operator would keep it - so one fixed wide
 * shot of two people talking becomes a shot that follows whoever is in it.
 *
 * How the others do it, and what is taken from it: the pipelines published
 * around this all run detect -> track -> rank -> SMOOTHED camera path, and the
 * smoothing is the part that decides whether it looks professional or
 * seasick. The published ones use a Kalman filter to predict where the subject
 * goes and to take the jitter out of the path. The same two things are done
 * here with what this app already has: a dead zone, so small movements do not
 * move the camera at all, and an exponential approach, so when it does move it
 * eases there over a given number of seconds. Nobody in the frame holds the
 * camera where it was rather than snapping to the middle, which is what the
 * patents mean by lowering the weight when confidence drops.
 *
 * Composition is the other half of looking deliberate: a head is NOT put in
 * the middle. The eyes belong on the upper third, so the aim is offset to land
 * the head `headroom` down the frame. Dead centre reads as a security camera.
 *
 * Pure: the inspector's card reads the mattes and writes the result through
 * edit/trackApply.ts, which is the same path "Follow an object" uses.
 */

export interface AutoFrameOptions {
  /** How far in the camera pushes: 1.35 shows about three quarters of the width. */
  tightness: number;
  /** How far the head may wander from where it is aimed before the camera moves, as a share of the shot. */
  deadZone: number;
  /** Seconds the camera takes to settle somewhere new: larger is calmer. */
  settleSeconds: number;
  /** Where down the frame the head sits, 0..1. A third is the usual place for the eyes. */
  headroom: number;
  /**
   * Whether the camera TILTS as well as pans. Off, and the reason is measured
   * rather than guessed.
   *
   * Panning needs the head's place across the frame, and a person's silhouette
   * gives that well: on a 1080p fixture the estimate read 0.20 then 0.74 where
   * the person really was at 0.187 and 0.773. Tilting needs how far DOWN the
   * head is, and the same silhouette does not give that on real footage: the
   * run of rows that holds the subject stopped at the chest, so the estimate
   * read 0.62 and 0.55 of the frame where the head was at 0.37 and 0.11 - and
   * a camera aimed there frames the chest and cuts the head off the top.
   *
   * So this app pans and does not tilt, which is what CapCut's and Premiere's
   * Auto Reframe do too. Tilting wants a real face detector (MediaPipe's
   * BlazeFace), which is a model and a WebAssembly runtime to download: a
   * separate decision, with a licence to read. The maths below is ready for it.
   */
  tilt: boolean;
}

export const DEFAULT_AUTO_FRAME: AutoFrameOptions = { tightness: 1.35, deadZone: 0.08, settleSeconds: 0.6, headroom: 0.36, tilt: false };

/** How tight the push is, as the card offers it. */
export const TIGHTNESS = { gentle: 1.15, standard: 1.35, close: 1.7 } as const;

export interface HeadSample {
  t: number;
  /** The head's place across and down the source, 0..1, or null for nobody found. */
  x: number | null;
  y: number | null;
}

/**
 * The camera's centre across the source at each sample, 0..1 each way.
 *
 * `shot` is how much of the source the frame shows each way (0..1), which is
 * what the dead zone is measured against and what keeps the picture covering
 * the frame: the centre never goes nearer an edge than half a shot.
 */
export function framePath(
  samples: readonly HeadSample[],
  shot: { width: number; height: number },
  options: AutoFrameOptions = DEFAULT_AUTO_FRAME,
): Array<{ t: number; x: number; y: number }> {
  if (samples.length === 0) return [];
  const halfWidth = Math.min(0.5, shot.width / 2);
  const halfHeight = Math.min(0.5, shot.height / 2);
  const clampX = (x: number): number => Math.min(1 - halfWidth, Math.max(halfWidth, x));
  const clampY = (y: number): number => Math.min(1 - halfHeight, Math.max(halfHeight, y));
  // The head goes `headroom` down the frame, so the camera's centre sits below
  // it by whatever is left of the half shot.
  const drop = (0.5 - options.headroom) * shot.height;

  const firstFound = samples.find((sample) => sample.x !== null && sample.y !== null);
  let knownX = firstFound?.x ?? 0.5;
  let knownY = firstFound?.y ?? 0.5 - drop;
  const targets = samples.map((sample) => {
    if (sample.x !== null && sample.y !== null) {
      knownX = sample.x;
      knownY = sample.y;
    }
    return { t: sample.t, x: knownX, y: knownY + drop };
  });

  const path: Array<{ t: number; x: number; y: number }> = [];
  let centreX = clampX(targets[0].x);
  let centreY = clampY(targets[0].y);
  let aimX = centreX;
  let aimY = centreY;
  for (let index = 0; index < targets.length; index += 1) {
    const { t, x, y } = targets[index];
    // The operator decides to move only once the head has really left the spot.
    if (Math.abs(x - centreX) > options.deadZone * shot.width) aimX = clampX(x);
    if (Math.abs(y - centreY) > options.deadZone * shot.height) aimY = clampY(y);
    const dt = index === 0 ? 0 : Math.max(0, t - targets[index - 1].t);
    // Exponential approach: about 95 % of the way there in `settleSeconds`.
    const k = options.settleSeconds > 0 ? 1 - Math.exp((-3 * dt) / options.settleSeconds) : 1;
    centreX = clampX(centreX + (aimX - centreX) * k);
    centreY = clampY(centreY + (aimY - centreY) * k);
    path.push({ t, x: centreX, y: centreY });
  }
  return path;
}

export interface AutoFramePlan {
  position: Keyframe<Vector2D>[];
  scale: Keyframe<Vector2D>[];
  /** How much of the source the frame ends up showing, for the card to report. */
  shot: { width: number; height: number };
}

/**
 * The keyframes that make one clip follow the head: its position along the
 * camera's path and the one size that pushes it in.
 *
 * Null when there is no room to pan - a clip already filling the frame with
 * nothing to spare cannot follow anything, and pretending otherwise would
 * show the edge of the picture.
 */
export function planAutoFrame(
  project: ProjectState,
  clip: Clip,
  asset: Pick<MediaAsset, 'width' | 'height'>,
  samples: readonly HeadSample[],
  options: AutoFrameOptions = DEFAULT_AUTO_FRAME,
): AutoFramePlan | null {
  if (!asset.width || !asset.height || samples.length === 0) return null;
  const cover = coverScale(asset.width / asset.height, project.width / project.height);
  const scale = { x: cover.x * options.tightness, y: cover.y * options.tightness };
  const drawnWidth = project.width * scale.x;
  const drawnHeight = project.height * scale.y;
  const shot = { width: project.width / drawnWidth, height: project.height / drawnHeight };
  // Nothing to pan within: both ways would be clamped to the middle all through.
  if (shot.width >= 0.999 && shot.height >= 0.999) return null;

  const path = framePath(samples, shot, options);
  const overhangX = Math.max(0, (drawnWidth - project.width) / 2);
  const overhangY = Math.max(0, (drawnHeight - project.height) / 2);
  const keys: Keyframe<Vector2D>[] = path.map((point) => ({
    id: createId('kf'),
    frame: Math.min(clip.startFrame + clip.durationFrames - 1, clip.startFrame + Math.round(point.t * project.fps)),
    value: {
      x: Math.min(overhangX, Math.max(-overhangX, (0.5 - point.x) * drawnWidth)),
      // Centred vertically unless the camera tilts: see AutoFrameOptions.tilt.
      y: options.tilt ? Math.min(overhangY, Math.max(-overhangY, (0.5 - point.y) * drawnHeight)) : 0,
    },
    easing: 'linear',
  }));
  // One keyframe a frame at most, and only the ones the path needs: 3 px is
  // nothing to the eye on a frame that is moving anyway.
  const unique = [...new Map(keys.map((key) => [key.frame, key])).values()];
  const position = simplified(unique, 3);
  const still = position.length === 1 || position.every((key) => key.value.x === position[0].value.x && key.value.y === position[0].value.y);
  return {
    position: still ? [{ ...position[0], frame: clip.startFrame }] : position,
    scale: [{ id: createId('kf'), frame: clip.startFrame, value: scale, easing: 'linear' }],
    shot,
  };
}
