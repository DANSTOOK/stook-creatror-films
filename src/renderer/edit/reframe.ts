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

/**
 * Where the HEAD is in one matte, 0..1 of the frame - not the middle of the
 * person.
 *
 * The middle of a person's mass is the chest: frame a talking head on it and
 * the face sits near the top edge. A people matte has no face in it, but it
 * does have the person's outline, and the top of that outline is the head. So:
 * the rows that hold the subject are found, and the centre of the top fifth of
 * that run is taken. On a standing figure it lands on the head, on a seated
 * one on the head and shoulders, and on a close-up where the head fills the
 * frame it lands where the middle would anyway.
 *
 * This is a head ESTIMATE from a person's silhouette, not a face detector.
 * A real one (MediaPipe's BlazeFace) is a model and a WebAssembly runtime to
 * download - a different decision, and a licence to read.
 */
export function subjectHead(matte: Uint8Array, width: number, height: number): { x: number; y: number } | null {
  /*
   * The mass in each row, at every other pixel: a quarter of the work.
   *
   * Only pixels the matte is SURE about count towards finding the person, even
   * though the centre below is taken over everything above 96. A band of
   * compression noise over a dark background comes back as a wide, faint row -
   * and a wide faint row outweighs a narrow solid person, so the fullest row
   * was the noise and the head went with it. Confidence is what separates
   * them: noise sits around a half, a person's core at full.
   */
  const rowMass = (floor: number): { rows: Float64Array; peak: number } => {
    const rows = new Float64Array(height);
    let peak = 0;
    for (let y = 0; y < height; y += 2) {
      const start = y * width;
      let mass = 0;
      for (let x = 0; x < width; x += 2) {
        const value = matte[start + x];
        if (value >= floor) mass += value;
      }
      rows[y] = mass;
      if (mass > peak) peak = mass;
    }
    return { rows, peak };
  };
  /*
   * Two thresholds, because they answer different questions.
   *
   * WHERE TO START looking is asked of the solid pixels: a person's core is at
   * full confidence and a band of noise never is, so the fullest solid row is
   * always on the person. HOW FAR the person reaches is asked of everything the
   * matte marked at all, because the top of a head is HAIR - the one place a
   * matte is least sure - and a run measured in solid pixels alone stops at the
   * shoulders. Measured on a 1080p fixture: solid-only put the head at 0.62 of
   * the frame, which is the chest, and the camera framed the person's middle
   * while their head went out of the top.
   *
   * A soft matte with nothing solid in it still gets an answer, from what it has.
   */
  const solid = rowMass(170);
  const loose = rowMass(96);
  const seed = solid.peak > 0 ? solid : loose;
  const rows = loose.rows;
  const peak = loose.peak;
  if (peak <= 0) return null;
  // A row counts as the person once it holds a sixth of the fullest row: less
  // than that is a wisp of hair or a speck the matte was unsure about.
  //
  // Walked out from the FULLEST row rather than in from the top of the frame,
  // and only along rows that touch it. Scanning from the top took the first row
  // that passed anywhere in the frame, so on a small subject in a big frame a
  // band of noise above them became the head and the estimate went to
  // wherever the noise was - measured on a 1080p fixture, the head never left
  // the left edge while the person crossed to the right.
  const floor = peak / 6;
  let peakRow = 0;
  for (let y = 0; y < height; y += 2) if (seed.rows[y] === seed.peak) { peakRow = y; break; }
  let top = peakRow;
  while (top - 2 >= 0 && rows[top - 2] >= floor) top -= 2;
  let bottom = peakRow;
  while (bottom + 2 < height && rows[bottom + 2] >= floor) bottom += 2;
  const extent = Math.max(2, bottom - top);
  const band = Math.max(2, Math.round(extent * 0.2));
  // Across the head band: where the head is, left to right.
  let weight = 0;
  let sumX = 0;
  for (let y = top; y <= Math.min(bottom, top + band); y += 2) {
    const start = y * width;
    for (let x = 0; x < width; x += 2) {
      const value = matte[start + x];
      if (value < 96) continue;
      weight += value;
      sumX += value * x;
    }
  }
  if (weight <= 0) return null;
  return { x: (sumX / weight + 0.5) / width, y: (top + band / 2 + 0.5) / height };
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
