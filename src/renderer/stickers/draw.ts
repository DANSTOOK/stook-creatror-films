/**
 * The stickers' hand: every sticker is drawn with these, so any two sit
 * together - a bold fill, a thick white outline and a soft shadow - and each
 * reads over any picture (stickers/catalog, stickers/sets).
 *
 * A shape made of several (a cloud of circles, a hand of a fist and a thumb)
 * is one Path2D: the outline is stroked first and the fill laid over it, so
 * the strokes where the parts overlap are covered and only the outer edge
 * shows.
 */

export const OUTLINE = '#ffffff';

/** Fill `path` with the house finish: a shadow under it, a thick white outline, then the colour. */
export function finish(context: CanvasRenderingContext2D, size: number, path: Path2D, fill: string | CanvasGradient, outline = true, weight = 0.07): void {
  context.save();
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.shadowColor = 'rgba(0, 0, 0, 0.35)';
  context.shadowBlur = size * 0.04;
  context.shadowOffsetY = size * 0.02;
  if (outline) {
    context.strokeStyle = OUTLINE;
    context.lineWidth = size * weight;
    context.stroke(path);
    context.shadowColor = 'transparent';
  }
  context.fillStyle = fill;
  context.fill(path);
  context.restore();
}

/** The same with a dark edge instead of the white one: a bubble or a cursor, white inside. */
export function inked(context: CanvasRenderingContext2D, size: number, path: Path2D, fill: string | CanvasGradient, ink = '#111827', weight = 0.06): void {
  context.save();
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.shadowColor = 'rgba(0, 0, 0, 0.35)';
  context.shadowBlur = size * 0.04;
  context.shadowOffsetY = size * 0.02;
  context.strokeStyle = ink;
  context.lineWidth = size * weight;
  context.stroke(path);
  context.shadowColor = 'transparent';
  context.fillStyle = fill;
  context.fill(path);
  context.restore();
}

/** The same, for a line drawn rather than a shape filled (an arrow's shaft, a ring). */
export function line(context: CanvasRenderingContext2D, size: number, path: Path2D, colour: string, width: number): void {
  context.save();
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.shadowColor = 'rgba(0, 0, 0, 0.35)';
  context.shadowBlur = size * 0.04;
  context.shadowOffsetY = size * 0.02;
  context.strokeStyle = OUTLINE;
  context.lineWidth = width + size * 0.07;
  context.stroke(path);
  context.shadowColor = 'transparent';
  context.strokeStyle = colour;
  context.lineWidth = width;
  context.stroke(path);
  context.restore();
}

/** Plain fill, no finish: the details drawn inside a sticker (eyes, a mouth, a ribbon). */
export function fillPath(context: CanvasRenderingContext2D, path: Path2D, colour: string | CanvasGradient): void {
  context.save();
  context.fillStyle = colour;
  context.fill(path);
  context.restore();
}

/** Plain stroke with round ends: a detail's line (a brow, a smile, a vein). */
export function strokePath(context: CanvasRenderingContext2D, path: Path2D, colour: string, width: number): void {
  context.save();
  context.strokeStyle = colour;
  context.lineWidth = width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.stroke(path);
  context.restore();
}

export const vertical = (context: CanvasRenderingContext2D, size: number, top: string, bottom: string): CanvasGradient => {
  const gradient = context.createLinearGradient(0, size * 0.1, 0, size * 0.9);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  return gradient;
};

export function starPath(cx: number, cy: number, outer: number, inner: number, points: number, turn = -Math.PI / 2): Path2D {
  const path = new Path2D();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = turn + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

export function heartPath(s: number): Path2D {
  const path = new Path2D();
  path.moveTo(s * 0.5, s * 0.84);
  path.bezierCurveTo(s * 0.12, s * 0.58, s * 0.08, s * 0.32, s * 0.27, s * 0.22);
  path.bezierCurveTo(s * 0.4, s * 0.15, s * 0.48, s * 0.24, s * 0.5, s * 0.32);
  path.bezierCurveTo(s * 0.52, s * 0.24, s * 0.6, s * 0.15, s * 0.73, s * 0.22);
  path.bezierCurveTo(s * 0.92, s * 0.32, s * 0.88, s * 0.58, s * 0.5, s * 0.84);
  path.closePath();
  return path;
}

/** A heart `width` wide, centred at (cx, cy): heartPath moved and scaled (its own spans 0.84 of its size). */
export function heartAt(cx: number, cy: number, width: number): Path2D {
  const size = width / 0.84;
  const path = new Path2D();
  path.addPath(heartPath(size), new DOMMatrix().translate(cx - size * 0.5, cy - size * 0.53));
  return path;
}

export function circle(cx: number, cy: number, r: number): Path2D {
  const path = new Path2D();
  path.arc(cx, cy, r, 0, Math.PI * 2);
  return path;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, rotation = 0): Path2D {
  const path = new Path2D();
  path.ellipse(cx, cy, rx, ry, rotation, 0, Math.PI * 2);
  return path;
}

export function roundRect(x: number, y: number, width: number, height: number, radius: number): Path2D {
  const path = new Path2D();
  path.roundRect(x, y, width, height, radius);
  return path;
}

/** A polygon through the points, closed. */
export function polygon(points: ReadonlyArray<readonly [number, number]>): Path2D {
  const path = new Path2D();
  points.forEach(([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  path.closePath();
  return path;
}

/** A drop of water, round at the bottom (cx, cy, r) and pointed `r * 1.7` above it. */
export function drop(cx: number, cy: number, r: number): Path2D {
  const path = new Path2D();
  path.moveTo(cx, cy - r * 1.7);
  path.quadraticCurveTo(cx + r * 1.05, cy - r * 0.6, cx + r, cy);
  path.arc(cx, cy, r, 0, Math.PI);
  path.quadraticCurveTo(cx - r * 1.05, cy - r * 0.6, cx, cy - r * 1.7);
  path.closePath();
  return path;
}

/** A speech bubble: a rounded box with its tail let into the bottom edge, between `from` and `to`, pointing at the tip. */
export function bubblePath(x: number, y: number, width: number, height: number, radius: number, tail: { from: number; to: number; tipX: number; tipY: number }): Path2D {
  const path = new Path2D();
  const right = x + width;
  const bottom = y + height;
  path.moveTo(x + radius, y);
  path.lineTo(right - radius, y);
  path.quadraticCurveTo(right, y, right, y + radius);
  path.lineTo(right, bottom - radius);
  path.quadraticCurveTo(right, bottom, right - radius, bottom);
  path.lineTo(tail.to, bottom);
  path.lineTo(tail.tipX, tail.tipY);
  path.lineTo(tail.from, bottom);
  path.lineTo(x + radius, bottom);
  path.quadraticCurveTo(x, bottom, x, bottom - radius);
  path.lineTo(x, y + radius);
  path.quadraticCurveTo(x, y, x + radius, y);
  path.closePath();
  return path;
}

/** A cloud `width` wide, its flat base at `baseY`: three puffs on a rounded base. */
export function cloudPath(cx: number, baseY: number, width: number): Path2D {
  const w = width;
  const path = new Path2D();
  path.addPath(circle(cx - w * 0.22, baseY - w * 0.14, w * 0.18));
  path.addPath(circle(cx + w * 0.02, baseY - w * 0.24, w * 0.25));
  path.addPath(circle(cx + w * 0.26, baseY - w * 0.13, w * 0.17));
  path.addPath(roundRect(cx - w * 0.44, baseY - w * 0.2, w * 0.88, w * 0.2, w * 0.1));
  return path;
}

/** Draw `paint` turned by `angle` (radians) about the middle of the sticker. */
export function turned(context: CanvasRenderingContext2D, size: number, angle: number, paint: () => void): void {
  context.save();
  context.translate(size / 2, size / 2);
  context.rotate(angle);
  context.translate(-size / 2, -size / 2);
  paint();
  context.restore();
}

/** Bold lettering, centred at (x, y), fitted to `width`, with the house outline. */
export function lettering(context: CanvasRenderingContext2D, size: number, text: string, x: number, y: number, width: number, fill: string, height: number): void {
  context.save();
  let px = height;
  context.font = `900 ${px}px Outfit, "Arial Black", sans-serif`;
  const measured = context.measureText(text).width;
  if (measured > width) {
    px = Math.floor((px * width) / measured);
    context.font = `900 ${px}px Outfit, "Arial Black", sans-serif`;
  }
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  context.lineWidth = px * 0.16;
  context.strokeText(text, x, y);
  context.fillStyle = fill;
  context.fillText(text, x, y);
  context.restore();
  void size;
}
