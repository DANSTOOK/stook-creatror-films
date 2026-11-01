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
   * The mass and the WIDTH of each row, at every other pixel.
   *
   * Mass finds the person: only pixels the matte is sure about count, because a
   * band of compression noise over a dark background comes back as a wide faint
   * row, and a wide faint row outweighs a narrow solid person - so the fullest
   * row was the noise and the "head" went with it. Width finds the neck, and
   * counts everything the matte marked at all, because the edge of a head is
   * hair and hair is where a matte is least sure.
   */
  const rows = new Float64Array(height);
  const solidRows = new Float64Array(height);
  const span = new Float64Array(height);
  let peak = 0;
  let solidPeak = 0;
  for (let y = 0; y < height; y += 2) {
    const start = y * width;
    let mass = 0;
    let solid = 0;
    let count = 0;
    for (let x = 0; x < width; x += 2) {
      const value = matte[start + x];
      if (value < 96) continue;
      mass += value;
      count += 1;
      if (value >= 170) solid += value;
    }
    rows[y] = mass;
    solidRows[y] = solid;
    span[y] = count;
    if (mass > peak) peak = mass;
    if (solid > solidPeak) solidPeak = solid;
  }
  if (peak <= 0) return null;

  /*
   * The subject is the run of rows that TOUCHES its fullest solid row. Walked
   * out from there rather than in from the top of the frame: scanning from the
   * top took the first row that passed anywhere, so noise above a small subject
   * became the head. A soft matte with nothing solid in it falls back to mass.
   */
  const seed = solidPeak > 0 ? solidRows : rows;
  const seedPeak = solidPeak > 0 ? solidPeak : peak;
  /*
   * A row carries on the run while it holds a sliver of the fullest row; the
   * run ends where the matte does, at a row holding nothing.
   *
   * It used to take a SIXTH, and a sixth cuts the person in half at the neck:
   * shoulders are four to eight times a neck wide, so the neck rows fall under
   * the bar, the walk out from the shoulders stops there, and the head is left
   * out of the subject entirely - the "head" then came back in the shoulders
   * (measured on a 320x180 bust: 0.46 of the frame down, where the head's
   * middle was 0.22). The sliver is small enough that a real neck, and the
   * crown of a head where the matte reads only hair, both stay in.
   *
   * It is a share rather than nothing at all so that a hairline of stray
   * pixels cannot join the subject to a band of noise it happens to touch: at
   * a sixty-fourth, a row needs more than a pixel or two to carry the run.
   */
  const floor = peak / 64;
  let peakRow = 0;
  for (let y = 0; y < height; y += 2) if (seed[y] === seedPeak) { peakRow = y; break; }
  let top = peakRow;
  while (top - 2 >= 0 && rows[top - 2] >= floor) top -= 2;
  let bottom = peakRow;
  while (bottom + 2 < height && rows[bottom + 2] >= floor) bottom += 2;
  const extent = Math.max(2, bottom - top);

  /*
   * Where the head ends: the NECK, the sharpest narrowing under the skull. A
   * standing or seated person narrows there by a factor of three or four, and
   * it is the one landmark a silhouette really has.
   *
   * NOT the narrowest row above the shoulders, which is what this first took:
   * the narrowest row of a person is the CROWN, where the head tapers away to
   * nothing, and it beats the neck every time. Measured on a real 1024x576
   * matte, where the head ran from 0.31 to 0.41 of the frame down and the neck
   * was 16 pixels wide at 0.41: the crown was 13 wide at 0.32, so the band
   * stopped two rows below the top of the hair and the "head" came back at
   * 0.318 - the scalp, not the face.
   *
   * So each row is judged against the WIDEST row ABOVE it - the skull - and the
   * neck is where that ratio is largest. A crown scores 1, because nothing
   * above it is wider; the real neck scored 24/16. On the same matte this puts
   * the head at 0.363, inside the head and 0.003 from its middle.
   *
   * The lowest row, where several tie: a flat-sided silhouette is one width all
   * the way down and every row of it scores 1, and there the lowest is the
   * bottom of the head, which is where the band should stop.
   *
   * The top fifth of the extent stays as the fallback, for a close-up whose
   * head fills the frame and has no neck in it, or any silhouette that never
   * narrows.
   */
  let widest = top;
  for (let y = top; y <= bottom; y += 2) if (span[y] > span[widest]) widest = y;
  let neck = -1;
  let sharpest = 0;
  let skull = span[top];
  for (let y = top + 2; y < widest; y += 2) {
    if (span[y] > 0 && skull / span[y] >= sharpest) {
      sharpest = skull / span[y];
      neck = y;
    }
    // Widest ABOVE the next row, so the row being judged is not its own skull.
    if (span[y] > skull) skull = span[y];
  }
  // A neck worth the name: above the middle of the subject, and narrower than
  // half the widest row. Anything else is a silhouette without one.
  const narrows = neck > top && neck < top + extent / 2 && span[neck] * 2 < span[widest];
  const headBottom = narrows ? neck : Math.min(bottom, top + Math.max(2, Math.round(extent * 0.2)));

  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = top; y <= headBottom; y += 2) {
    const start = y * width;
    for (let x = 0; x < width; x += 2) {
      const value = matte[start + x];
      if (value < 96) continue;
      weight += value;
      sumX += value * x;
      sumY += value * y;
    }
  }
  if (weight <= 0) return null;
  return { x: (sumX / weight + 0.5) / width, y: (sumY / weight + 0.5) / height };
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
