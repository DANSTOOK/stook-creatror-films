/**
 * Auto reframe: a landscape edit turned into a vertical (or square) one, the
 * picture following the person in it - the way CapCut's and Premiere's Auto
 * Reframe hand a 16:9 interview to TikTok.
 *
 * Where the person is comes from the people matte "Remove background"
 * already makes (MODNet; matting/): the middle of what it marks as subject,
 * a few times a second. A virtual camera then follows that point as an
 * operator would - it holds still while the person only shifts a little,
 * moves smoothly when they really go somewhere, never jerks, and stays where
 * it was when nobody is in the frame - and the clip is filled into the new
 * frame (covered, never stretched) with its position keyframed along that
 * path, never so far that an edge of black shows.
 *
 * Pure: the dialog (components/Reframe) reads the mattes and applies the
 * result through the store.
 */

/** Where the subject is in one matte: the middle of its mass, 0..1 of the frame, and how much of the frame it covers. */
export function subjectCentre(matte: Uint8Array, width: number, height: number): { x: number; y: number; coverage: number } | null {
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  // Every other pixel each way: a quarter of the work, the same middle.
  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      const value = matte[row + x];
      if (value < 96) continue;
      weight += value;
      sumX += value * x;
      sumY += value * y;
    }
  }
  const coverage = weight / (255 * Math.ceil(width / 2) * Math.ceil(height / 2));
  // Under half a percent of the frame is a stray speck, not a person.
  if (coverage < 0.005) return null;
  return { x: (sumX / weight + 0.5) / width, y: (sumY / weight + 0.5) / height, coverage };
}

export interface CameraOptions {
  /** How far the subject may wander from the middle of the shot before the camera moves, as a share of the shot's width. */
  deadZone: number;
  /** Seconds the camera takes to settle on a new place: larger is calmer. */
  settleSeconds: number;
}

export const DEFAULT_CAMERA: CameraOptions = { deadZone: 0.15, settleSeconds: 0.9 };

/**
 * The path of the virtual camera's centre across the source (0..1), one
 * value a sample, from where the subject was at each sample (null: nobody).
 *
 * `shotWidth` is how much of the source's width the new frame shows (0..1):
 * the dead zone is a share of that, and the centre never goes where the shot
 * would run off the picture.
 */
export function cameraPath(
  samples: ReadonlyArray<{ t: number; x: number | null }>,
  shotWidth: number,
  options: CameraOptions = DEFAULT_CAMERA,
): Array<{ t: number; x: number }> {
  if (samples.length === 0) return [];
  const half = Math.min(0.5, shotWidth / 2);
  const clampCentre = (x: number): number => Math.min(1 - half, Math.max(half, x));
  // Nobody in a sample: where they were last; nobody yet: where they first appear, else the middle.
  const first = samples.find((sample) => sample.x !== null)?.x ?? 0.5;
  let known = first;
  const targets = samples.map((sample) => {
    if (sample.x !== null) known = sample.x;
    return { t: sample.t, x: known };
  });

  const path: Array<{ t: number; x: number }> = [];
  let centre = clampCentre(targets[0].x);
  let aim = centre;
  for (let i = 0; i < targets.length; i += 1) {
    const { t, x } = targets[i];
    // The operator decides where to point only when the subject leaves the dead zone.
    if (Math.abs(x - centre) > options.deadZone * shotWidth) aim = clampCentre(x);
    const dt = i === 0 ? 0 : Math.max(0, t - targets[i - 1].t);
    // Exponential approach: about 95 % of the way in `settleSeconds`.
    const k = options.settleSeconds > 0 ? 1 - Math.exp((-3 * dt) / options.settleSeconds) : 1;
    centre = clampCentre(centre + (aim - centre) * k);
    path.push({ t, x: centre });
  }
  return path;
}

/**
 * The scale that makes a picture of `sourceAspect` cover a frame of
 * `frameAspect` without being stretched - in the compositor's terms, where 1
 * on both axes fills the frame (engine/Compositor).
 */
export function coverScale(sourceAspect: number, frameAspect: number): { x: number; y: number } {
  const ratio = sourceAspect / frameAspect;
  return ratio >= 1 ? { x: ratio, y: 1 } : { x: 1, y: 1 / ratio };
}

/**
 * The clip's position, in project pixels from the frame's centre, that puts
 * source point `centre` (0..1 across its width) in the middle of a frame
 * `frameWidth` wide, with the picture drawn `drawnWidth` wide - clamped so
 * the picture always covers the frame.
 */
export function positionFor(centre: number, drawnWidth: number, frameWidth: number): number {
  const overhang = Math.max(0, (drawnWidth - frameWidth) / 2);
  return Math.min(overhang, Math.max(-overhang, (0.5 - centre) * drawnWidth));
}

/** The frame a reframe makes for a project: the target shape, with the project's short side kept. */
export function reframedSize(projectWidth: number, projectHeight: number, aspect: { w: number; h: number }): { width: number; height: number } {
  const short = Math.min(projectWidth, projectHeight);
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  return aspect.w <= aspect.h ? { width: even(short), height: even((short * aspect.h) / aspect.w) } : { width: even((short * aspect.w) / aspect.h), height: even(short) };
}
