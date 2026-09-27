import {
  LEVELS,
  SKIN_LINE_DEGREES,
  VECTOR_SIZE,
  VECTOR_TARGETS,
  chroma709,
  vectorPosition,
  type ScopeData,
  type ScopeKind,
} from './scopeMath';

/**
 * Drawing the scopes on a 2D canvas - in the scopes' worker, on the
 * OffscreenCanvas each scope's canvas hands it (scopeWorker.ts).
 *
 * The traces are density images - each cell as bright as the number of
 * pixels that fell in it - drawn first at their own resolution (a column per
 * sampled pixel, a row per level) and then scaled into the plot, which is
 * how a hardware scope's phosphor reads too: a dense line is solid, a stray
 * pixel is a faint dot.
 *
 * Colours are the app's own: the panel-950 surface, slate labels at 7:1,
 * the traces light enough to read at a glance and nothing saturated except
 * where the channel's colour is the information (parade, histogram).
 */

const BACKGROUND = '#0e0f11';
const GRID = 'rgba(255, 255, 255, 0.10)';
const GRID_STRONG = 'rgba(255, 255, 255, 0.22)';
const LABEL = '#94a3b8';
const TARGET = 'rgba(226, 232, 240, 0.75)';
const SKIN = '#fdba74';

type Rgb = readonly [number, number, number];
const TRACE_LUMA: Rgb = [219, 234, 254];
const TRACE_RED: Rgb = [248, 113, 113];
const TRACE_GREEN: Rgb = [74, 222, 128];
const TRACE_BLUE: Rgb = [96, 165, 250];

export interface ScopeLabels {
  skin: string;
}

type Context = OffscreenCanvasRenderingContext2D;

/** Scratch canvases for the density images, one per size. */
const scratch = new Map<string, OffscreenCanvas>();
function scratchCanvas(width: number, height: number): OffscreenCanvas {
  const key = `${width}x${height}`;
  let canvas = scratch.get(key);
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height);
    scratch.set(key, canvas);
  }
  return canvas;
}

/**
 * Brightness of a cell holding `count` pixels. The square root keeps a thin
 * trace visible next to a dense one, as a scope's intensity control does.
 */
const intensity = (count: number, reference: number): number => (count <= 0 ? 0 : Math.min(1, Math.sqrt(count / reference)));

/**
 * A waveform-like density image: `bins` is levels x columns, level 0 at the
 * bottom. Returned as a canvas the size of the bins.
 */
function levelImage(bins: Uint32Array, columns: number, reference: number, colour: Rgb): OffscreenCanvas {
  const canvas = scratchCanvas(columns, LEVELS);
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  const image = context.createImageData(columns, LEVELS);
  const data = image.data;
  for (let level = 0; level < LEVELS; level += 1) {
    const row = LEVELS - 1 - level;
    for (let x = 0; x < columns; x += 1) {
      const value = intensity(bins[level * columns + x], reference);
      if (value === 0) continue;
      const offset = (row * columns + x) * 4;
      data[offset] = colour[0];
      data[offset + 1] = colour[1];
      data[offset + 2] = colour[2];
      data[offset + 3] = Math.round(64 + 191 * value);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function font(context: Context, scale: number): void {
  context.font = `${Math.round(10 * scale)}px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`;
  context.fillStyle = LABEL;
}

/** Horizontal lines at 0, 25, 50, 75 and 100%, numbered at the left. */
function levelGrid(context: Context, plot: Box, scale: number, numbered: boolean): void {
  font(context, scale);
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (const percent of [0, 25, 50, 75, 100]) {
    const y = Math.round(plot.y + plot.height * (1 - percent / 100)) + 0.5;
    context.strokeStyle = percent === 0 || percent === 100 ? GRID_STRONG : GRID;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(plot.x, y);
    context.lineTo(plot.x + plot.width, y);
    context.stroke();
    if (numbered) context.fillText(String(percent), plot.x - 4 * scale, y);
  }
}

function drawLevels(context: Context, bins: Uint32Array, data: ScopeData, plot: Box, colour: Rgb): void {
  const reference = Math.max(1, data.height / 32);
  context.imageSmoothingEnabled = true;
  context.drawImage(levelImage(bins, data.width, reference, colour), plot.x, plot.y, plot.width, plot.height);
}

function drawWaveform(context: Context, data: ScopeData, plot: Box, scale: number): void {
  levelGrid(context, plot, scale, true);
  if (data.waveform) drawLevels(context, data.waveform, data, plot, TRACE_LUMA);
}

function drawParade(context: Context, data: ScopeData, plot: Box, scale: number): void {
  levelGrid(context, plot, scale, true);
  if (!data.parade) return;
  const gap = 4 * scale;
  const width = (plot.width - gap * 2) / 3;
  const colours = [TRACE_RED, TRACE_GREEN, TRACE_BLUE];
  data.parade.forEach((bins, index) => {
    const x = plot.x + index * (width + gap);
    drawLevels(context, bins, data, { x, y: plot.y, width, height: plot.height }, colours[index]);
    // Hairlines between the three channels, so each reads as its own scope.
    if (index > 0) {
      context.strokeStyle = GRID_STRONG;
      context.beginPath();
      context.moveTo(Math.round(x - gap / 2) + 0.5, plot.y);
      context.lineTo(Math.round(x - gap / 2) + 0.5, plot.y + plot.height);
      context.stroke();
    }
  });
}

function drawVectorscope(context: Context, data: ScopeData, area: Box, scale: number, labels: ScopeLabels): void {
  const size = Math.min(area.width, area.height);
  const square: Box = { x: area.x + (area.width - size) / 2, y: area.y + (area.height - size) / 2, width: size, height: size };
  const centreX = square.x + size / 2;
  const centreY = square.y + size / 2;
  const toScreen = (x: number, y: number): [number, number] => [square.x + x * size, square.y + y * size];

  // The graticule: the edge of the chroma plane, the axes, a 50% ring.
  context.lineWidth = 1;
  context.strokeStyle = GRID_STRONG;
  context.beginPath();
  context.arc(centreX, centreY, size / 2, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = GRID;
  context.beginPath();
  context.arc(centreX, centreY, size / 4, 0, Math.PI * 2);
  context.moveTo(square.x, centreY);
  context.lineTo(square.x + size, centreY);
  context.moveTo(centreX, square.y);
  context.lineTo(centreX, square.y + size);
  context.stroke();

  // The skin-tone line.
  const angle = (SKIN_LINE_DEGREES * Math.PI) / 180;
  const edgeX = centreX + Math.cos(angle) * (size / 2);
  const edgeY = centreY - Math.sin(angle) * (size / 2);
  context.strokeStyle = SKIN;
  context.globalAlpha = 0.7;
  context.setLineDash([4 * scale, 3 * scale]);
  context.beginPath();
  context.moveTo(centreX, centreY);
  context.lineTo(edgeX, edgeY);
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 1;
  font(context, scale);
  context.fillStyle = SKIN;
  context.textAlign = 'right';
  context.textBaseline = 'bottom';
  context.fillText(labels.skin, edgeX - 2 * scale, edgeY - 2 * scale);

  // The trace.
  if (data.vectorscope) {
    const canvas = scratchCanvas(VECTOR_SIZE, VECTOR_SIZE);
    const scratchContext = canvas.getContext('2d');
    if (scratchContext) {
      const image = scratchContext.createImageData(VECTOR_SIZE, VECTOR_SIZE);
      const reference = Math.max(1, (data.width * data.height) / 4096);
      for (let i = 0; i < data.vectorscope.length; i += 1) {
        const value = intensity(data.vectorscope[i], reference);
        if (value === 0) continue;
        const offset = i * 4;
        image.data[offset] = TRACE_LUMA[0];
        image.data[offset + 1] = TRACE_LUMA[1];
        image.data[offset + 2] = TRACE_LUMA[2];
        image.data[offset + 3] = Math.round(80 + 175 * value);
      }
      scratchContext.putImageData(image, 0, 0);
      context.imageSmoothingEnabled = true;
      context.drawImage(canvas, square.x, square.y, size, size);
    }
  }

  // The 75% targets, where the colour bars land.
  const box = 7 * scale;
  context.strokeStyle = TARGET;
  context.fillStyle = TARGET;
  context.textBaseline = 'middle';
  for (const target of VECTOR_TARGETS) {
    const { cb, cr } = chroma709(...target.rgb);
    const { x, y } = vectorPosition(cb, cr);
    const [sx, sy] = toScreen(x, y);
    context.strokeRect(Math.round(sx - box / 2) + 0.5, Math.round(sy - box / 2) + 0.5, box, box);
    // The label sits outside the box, away from the centre.
    const out = Math.atan2(sy - centreY, sx - centreX);
    context.textAlign = Math.cos(out) >= 0 ? 'left' : 'right';
    context.fillText(target.label, sx + Math.cos(out) * box * 1.3, sy + Math.sin(out) * box * 1.3);
  }
}

function drawHistogram(context: Context, data: ScopeData, plot: Box, scale: number): void {
  // Vertical lines at 0, 25, 50, 75 and 100%, numbered underneath.
  font(context, scale);
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (const percent of [0, 25, 50, 75, 100]) {
    const x = Math.round(plot.x + (plot.width * percent) / 100) + 0.5;
    context.strokeStyle = percent === 0 || percent === 100 ? GRID_STRONG : GRID;
    context.beginPath();
    context.moveTo(x, plot.y);
    context.lineTo(x, plot.y + plot.height);
    context.stroke();
    context.fillText(String(percent), x, plot.y + plot.height + 2 * scale);
  }
  const histogram = data.histogram;
  if (!histogram) return;

  // Scaled to the tallest bin away from the ends: a clipped picture piles up
  // at 0 or 255, and letting that spike set the scale flattens the rest.
  let peak = 1;
  for (const bins of [histogram.r, histogram.g, histogram.b, histogram.y]) {
    for (let level = 1; level < LEVELS - 1; level += 1) peak = Math.max(peak, bins[level]);
  }
  const x = (level: number): number => plot.x + (plot.width * (level + 0.5)) / LEVELS;
  const y = (count: number): number => plot.y + plot.height * (1 - Math.min(1, count / peak));
  const path = (bins: Uint32Array): Path2D => {
    const shape = new Path2D();
    shape.moveTo(plot.x, plot.y + plot.height);
    for (let level = 0; level < LEVELS; level += 1) shape.lineTo(x(level), y(bins[level]));
    shape.lineTo(plot.x + plot.width, plot.y + plot.height);
    shape.closePath();
    return shape;
  };

  context.save();
  context.globalCompositeOperation = 'lighter';
  for (const [bins, colour] of [[histogram.r, TRACE_RED], [histogram.g, TRACE_GREEN], [histogram.b, TRACE_BLUE]] as const) {
    context.fillStyle = `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, 0.45)`;
    context.fill(path(bins));
  }
  context.restore();

  context.strokeStyle = `rgb(${TRACE_LUMA.join(', ')})`;
  context.lineWidth = Math.max(1, scale);
  context.beginPath();
  for (let level = 0; level < LEVELS; level += 1) {
    if (level === 0) context.moveTo(x(level), y(histogram.y[level]));
    else context.lineTo(x(level), y(histogram.y[level]));
  }
  context.stroke();
}

/**
 * Draw one scope filling `canvas` (sized in device pixels already).
 * `scale` is the device pixel ratio, so text and margins stay the same size
 * on screen at any display scaling.
 */
export function drawScope(
  canvas: OffscreenCanvas,
  kind: ScopeKind,
  data: ScopeData | null,
  scale: number,
  labels: ScopeLabels,
): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const { width, height } = canvas;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);
  if (!data || width < 8 || height < 8) return;

  const margin = 6 * scale;
  const numbersLeft = kind === 'waveform' || kind === 'parade' ? 22 * scale : margin;
  const numbersBelow = kind === 'histogram' ? 14 * scale : margin;
  const plot: Box = {
    x: numbersLeft,
    y: margin,
    width: Math.max(1, width - numbersLeft - margin),
    height: Math.max(1, height - margin - numbersBelow),
  };

  if (kind === 'waveform') drawWaveform(context, data, plot, scale);
  else if (kind === 'parade') drawParade(context, data, plot, scale);
  else if (kind === 'vectorscope') drawVectorscope(context, data, { x: margin, y: margin, width: width - margin * 2, height: height - margin * 2 }, scale, labels);
  else drawHistogram(context, data, plot, scale);
}
