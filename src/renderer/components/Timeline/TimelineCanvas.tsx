import { useCallback, useEffect, useRef } from 'react';
import type { Clip, Marker, ProjectState, Track } from '@shared/types';
import { framesToShortLabel } from '@shared/utils/timecode';
import type { WaveformPeaks } from '@renderer/audio/WaveformExtractor';
import type { EditorUiState } from '@renderer/store/types';
import { clipEndFrame, clipsInPaintOrder } from './timelineOps';
import { frameToPixel, type SnapTarget } from './snapping';
import { sourceFramesUsed, speedLabel } from '@renderer/timing/clipSpeed';
import { fadeLengths } from '@renderer/timing/clipFades';

/**
 * Multi-track drawing surface.
 *
 * Every clip, waveform and grid line is painted into ONE canvas rather than
 * mounted as DOM nodes. That is what keeps a 100+ clip timeline at 60fps: React
 * only re-renders the canvas element itself, never a node per clip.
 */

export const TRACK_HEIGHT = 56;

/**
 * The outline of a selected clip: yellow, as Final Cut draws it. The pale blue
 * it replaced was a lighter shade of the video clips' own blue, so a selected
 * video clip read as the same thing, only brighter. No clip is drawn in
 * yellow; measured against the four clip colours it is 3.3:1 to 3.8:1 (3:1 is
 * the bar for a boundary) and 11:1 against an empty track.
 */
export const SELECTED_OUTLINE = '#facc15';
export const TRACK_GAP = 2;
export const RULER_HEIGHT = 24;
/**
 * The top of the ruler is the markers' lane; the time numbers sit below it.
 * Both inside the same 24px, so the rows below do not move.
 */
export const MARKER_LANE_HEIGHT = 11;

/**
 * The interface face, for everything the canvas writes. The ruler used to be
 * in a monospace face and the clip names in whatever system-ui resolved to -
 * two more faces beside the one the panels use. 11px is the scale's label size.
 */
const UI_FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const LABEL_FONT = `11px ${UI_FONT}`;

export const TRACK_TYPE_COLORS: Record<Track['type'], string> = {
  video: '#456698',
  audio: '#33785f',
  text: '#82548e',
  adjustment: '#8a6a2f',
};

export interface TimelineCanvasProps {
  project: ProjectState;
  ui: EditorUiState;
  tracks: Track[];
  /** Live snap indicator drawn during a drag. */
  activeSnap: SnapTarget | null;
  /** Decoded peaks per source URI, for audio-bearing clips. */
  waveforms: Record<string, WaveformPeaks>;
  width: number;
  height: number;
  /** Rubber band being dragged, in canvas coordinates. */
  marquee?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Clip (and edge) under the pointer, which gets the trim handles. */
  hover?: ClipHover | null;
  /** Edge being dragged right now, drawn as held. */
  activeTrim?: ClipHover | null;
  /** CSS cursor for what a press would do here. */
  cursor?: string;
  onPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void;
  onPointerUp(event: React.PointerEvent<HTMLCanvasElement>): void;
  onPointerLeave?(): void;
  onContextMenu(event: React.MouseEvent<HTMLCanvasElement>): void;
}

export interface ClipHover {
  clipId: string;
  edge: 'start' | 'end' | null;
}

/** How long the trim handles take to grow in, in milliseconds. */
const HANDLE_ANIMATION_MS = 140;

/**
 * Trim handles on a clip's edges.
 *
 * Dragging an edge has always trimmed a clip, but nothing on screen said so:
 * the edge looked like the rest of the clip and the cursor never changed. The
 * handles grow in when the pointer reaches a clip (`progress` 0 -> 1), and the
 * edge that a press would grab - or is grabbing - lights up.
 */
function drawTrimHandles(
  context: CanvasRenderingContext2D,
  x: number,
  clipWidth: number,
  top: number,
  progress: number,
  hotEdge: 'start' | 'end' | null,
  held: boolean,
): void {
  if (clipWidth < 18 || progress <= 0) return;

  const eased = 1 - (1 - progress) ** 3; // ease-out cubic
  const handleWidth = 6 * eased;
  const bodyTop = top + 2;
  const bodyHeight = TRACK_HEIGHT - 4;

  const drawEdge = (edge: 'start' | 'end'): void => {
    const hot = hotEdge === edge;
    const left = edge === 'start' ? x : x + clipWidth - handleWidth;

    context.fillStyle = hot ? (held ? '#93c5fd' : '#60a5fa') : 'rgba(226, 232, 240, 0.35)';
    context.beginPath();
    context.roundRect(
      left,
      bodyTop,
      handleWidth,
      bodyHeight,
      edge === 'start' ? [4, 0, 0, 4] : [0, 4, 4, 0],
    );
    context.fill();

    // Two grip lines, the conventional "you can pull this" mark.
    if (handleWidth > 3) {
      context.strokeStyle = hot ? '#0e0f11' : 'rgba(13, 15, 20, 0.6)';
      context.lineWidth = 1;
      const mid = left + handleWidth / 2;
      const gripTop = bodyTop + bodyHeight / 2 - 6;
      context.beginPath();
      context.moveTo(Math.round(mid - 1) + 0.5, gripTop);
      context.lineTo(Math.round(mid - 1) + 0.5, gripTop + 12);
      context.moveTo(Math.round(mid + 1) + 0.5, gripTop);
      context.lineTo(Math.round(mid + 1) + 0.5, gripTop + 12);
      context.stroke();
    }
  };

  drawEdge('start');
  drawEdge('end');
}

/** Vertical offset of a track row inside the canvas. */
export const trackRowTop = (index: number): number =>
  RULER_HEIGHT + index * (TRACK_HEIGHT + TRACK_GAP);

/** Which track row a y coordinate lands on, or -1 for the ruler. */
export function trackIndexAtY(y: number): number {
  if (y < RULER_HEIGHT) return -1;
  return Math.floor((y - RULER_HEIGHT) / (TRACK_HEIGHT + TRACK_GAP));
}

/** Frame step between ruler ticks, chosen so labels never collide. */
export function rulerStep(pixelsPerFrame: number, fps: number): number {
  // Up to two hours between ticks, so a feature-length timeline zoomed all
  // the way out still gets readable labels instead of a smear.
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200];
  const minimumPixels = 64;
  for (const seconds of candidates) {
    if (seconds * fps * pixelsPerFrame >= minimumPixels) return seconds * fps;
  }
  return candidates[candidates.length - 1] * fps;
}

function drawRuler(
  context: CanvasRenderingContext2D,
  project: ProjectState,
  ui: EditorUiState,
  width: number,
): void {
  context.fillStyle = '#1d2025';
  context.fillRect(0, 0, width, RULER_HEIGHT);
  // The marker lane, a shade darker so it reads as its own strip.
  context.fillStyle = '#191b20';
  context.fillRect(0, 0, width, MARKER_LANE_HEIGHT);

  context.strokeStyle = '#343840';
  context.beginPath();
  context.moveTo(0, RULER_HEIGHT - 0.5);
  context.lineTo(width, RULER_HEIGHT - 0.5);
  context.stroke();

  // The marked stretch (I and O): shaded, with a bracket at each end, so
  // what an export or a three-point edit will use is visible at a glance.
  if (ui.inFrame !== null || ui.outFrame !== null) {
    const from = frameToPixel(ui.inFrame ?? 0, ui.pixelsPerFrame, ui.scrollLeftPx);
    const to = frameToPixel(ui.outFrame ?? Number.MAX_SAFE_INTEGER / 2, ui.pixelsPerFrame, ui.scrollLeftPx);
    const left = Math.max(-2, Math.min(from, to));
    const right = Math.min(width + 2, Math.max(from, to));
    if (right > left) {
      context.fillStyle = 'rgba(96, 165, 250, 0.16)';
      context.fillRect(left, 0, right - left, RULER_HEIGHT - 1);
      context.strokeStyle = '#60a5fa';
      context.lineWidth = 2;
      for (const [x, facing] of [[from, 1], [to, -1]]) {
        if ( x < -8 || x > width + 8) continue;
        const edge = Math.round(x) + 0.5;
        context.beginPath();
        context.moveTo(edge, 1);
        context.lineTo(edge, RULER_HEIGHT - 2);
        context.moveTo(edge, 1);
        context.lineTo(edge + 6 * facing, 1);
        context.moveTo(edge, RULER_HEIGHT - 2);
        context.lineTo(edge + 6 * facing, RULER_HEIGHT - 2);
        context.stroke();
      }
      context.lineWidth = 1;
    }
  }

  const step = rulerStep(ui.pixelsPerFrame, project.fps);
  const firstFrame = Math.floor(ui.scrollLeftPx / ui.pixelsPerFrame / step) * step;
  const lastFrame = firstFrame + Math.ceil(width / ui.pixelsPerFrame) + step;

  context.font = LABEL_FONT;
  context.textBaseline = 'middle';

  for (let frame = firstFrame; frame <= lastFrame; frame += step) {
    const x = Math.round(frameToPixel(frame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;
    if (x < -40 || x > width + 40) continue;

    context.strokeStyle = '#41454e';
    context.beginPath();
    context.moveTo(x, RULER_HEIGHT - 7);
    context.lineTo(x, RULER_HEIGHT);
    context.stroke();

    context.fillStyle = '#94a3b8';
    context.fillText(framesToShortLabel(frame, project.fps), x + 4, MARKER_LANE_HEIGHT + (RULER_HEIGHT - MARKER_LANE_HEIGHT) / 2);
  }
}

/**
 * Draw the waveform inside a clip body.
 *
 * Peaks span the whole source file, so the visible slice is the window the clip
 * actually uses - which is what makes a trimmed clip show the right audio and a
 * split show two different halves.
 */
function drawWaveform(
  context: CanvasRenderingContext2D,
  clip: Clip,
  peaks: WaveformPeaks,
  x: number,
  clipWidth: number,
  top: number,
  fps: number,
  canvasWidth: number,
): void {
  if (peaks.durationSeconds <= 0 || clipWidth < 4) return;

  // A retimed clip covers more or less footage than the time it fills: at
  // 200% the wave is squeezed into half the width, which is what it sounds
  // like. Drawn from the footage the clip consumes, not from its length.
  const sourceStart = clip.sourceOffsetFrames / fps;
  const sourceEnd = sourceStart + sourceFramesUsed(clip) / fps;

  const firstBucket = Math.floor((sourceStart / peaks.durationSeconds) * peaks.bucketCount);
  const lastBucket = Math.ceil((sourceEnd / peaks.durationSeconds) * peaks.bucketCount);
  const span = lastBucket - firstBucket;
  if (span <= 0) return;

  const midY = top + TRACK_HEIGHT / 2;
  const amplitude = (TRACK_HEIGHT - 18) / 2;

  // Only the on-screen slice of the clip is walked. A 45-minute clip zoomed in
  // is millions of pixels wide, and iterating all of them every frame to draw
  // the ~1500 that are visible is exactly the work that makes a long timeline
  // stutter.
  const firstPixel = Math.max(0, Math.floor(-x));
  const lastPixel = Math.min(clipWidth, Math.ceil(canvasWidth - x));
  if (lastPixel <= firstPixel) return;

  context.save();
  context.beginPath();
  context.rect(x + firstPixel, top + 2, lastPixel - firstPixel, TRACK_HEIGHT - 4);
  context.clip();

  context.strokeStyle = 'rgba(226, 232, 240, 0.55)';
  context.lineWidth = 1;
  context.beginPath();

  // One vertical stroke per output pixel - or per bucket when there are fewer
  // buckets than pixels, so a zoomed-in waveform is not drawn as a solid block.
  const step = Math.max(1, clipWidth / span);
  for (let pixel = firstPixel; pixel <= lastPixel; pixel += step) {
    const ratio = pixel / clipWidth;
    const bucket = Math.min(peaks.bucketCount - 1, Math.floor(firstBucket + ratio * span));
    const min = peaks.peaks[bucket * 2];
    const max = peaks.peaks[bucket * 2 + 1];

    const columnX = Math.round(x + pixel) + 0.5;
    context.moveTo(columnX, midY - max * amplitude);
    context.lineTo(columnX, midY - min * amplitude);
  }

  context.stroke();
  context.restore();
}

/** Two links of a chain: the mark a linked clip carries. */
function drawLinkMark(context: CanvasRenderingContext2D, x: number, y: number): void {
  context.save();
  context.strokeStyle = '#cbd5f5';
  context.lineWidth = 1.2;
  context.beginPath();
  context.roundRect(x, y, 7, 5, 2.5);
  context.roundRect(x + 4, y + 2, 7, 5, 2.5);
  context.stroke();
  context.restore();
}

/** How big a fade grip is on the clip, in pixels. */
const FADE_GRIP_PX = 7;

/**
 * The fades on a clip: a wedge for each one, and a grip to drag it by.
 *
 * Resolve puts a small handle in each top corner and shows the fade as a
 * shaded triangle over the clip. The grips only appear when the pointer is on
 * the clip - they are an offer, not decoration - but a fade that exists is
 * always drawn, because it is part of the edit.
 */
function drawFades(
  context: CanvasRenderingContext2D,
  clip: Clip,
  x: number,
  clipWidth: number,
  top: number,
  pixelsPerFrame: number,
  hovered: boolean,
): void {
  const { fadeIn, fadeOut } = fadeLengths(clip);
  const bodyTop = top + 2;
  const bodyBottom = top + TRACK_HEIGHT - 2;

  const wedge = (fromX: number, toX: number, risingRight: boolean): void => {
    context.save();
    context.fillStyle = 'rgba(13, 15, 20, 0.55)';
    context.beginPath();
    if (risingRight) {
      context.moveTo(fromX, bodyTop);
      context.lineTo(toX, bodyTop);
      context.lineTo(fromX, bodyBottom);
    } else {
      context.moveTo(toX, bodyTop);
      context.lineTo(fromX, bodyTop);
      context.lineTo(fromX, bodyBottom);
    }
    context.closePath();
    context.fill();

    // The slope itself, so the length of the fade is readable at a glance.
    context.strokeStyle = 'rgba(248, 250, 252, 0.8)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(risingRight ? fromX : toX, bodyBottom);
    context.lineTo(risingRight ? toX : fromX, bodyTop);
    context.stroke();
    context.restore();
  };

  if (fadeIn > 0) wedge(x, x + fadeIn * pixelsPerFrame, true);
  if (fadeOut > 0) wedge(x + clipWidth, x + clipWidth - fadeOut * pixelsPerFrame, false);

  if (!hovered || clipWidth < 24) return;

  // The grips: where the fade currently ends, or the corner when there is none.
  const grip = (atX: number): void => {
    context.save();
    context.fillStyle = '#f8fafc';
    context.strokeStyle = 'rgba(13, 15, 20, 0.7)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(atX, bodyTop + 1, FADE_GRIP_PX / 2, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  };

  grip(x + fadeIn * pixelsPerFrame);
  grip(x + clipWidth - fadeOut * pixelsPerFrame);
}
function drawClip(
  context: CanvasRenderingContext2D,
  clip: Clip,
  track: Track,
  top: number,
  ui: EditorUiState,
  selected: boolean,
  peaks: WaveformPeaks | undefined,
  fps: number,
  canvasWidth: number,
  /** The pointer is on this clip: the fade grips are offered. */
  hovered: boolean,
): void {
  const x = frameToPixel(clip.startFrame, ui.pixelsPerFrame, ui.scrollLeftPx);
  const clipWidth = Math.max(2, clip.durationFrames * ui.pixelsPerFrame);

  // The body is drawn clamped to the canvas (plus a margin that keeps an
  // off-screen edge's rounded corners and stroke off screen). Coordinates in
  // the millions are what a long clip at high zoom produces, and the 2D API
  // has no reason to be handed them.
  const bodyLeft = Math.max(x, -8);
  const bodyRight = Math.min(x + clipWidth, canvasWidth + 8);
  const bodyWidth = Math.max(2, bodyRight - bodyLeft);

  context.save();

  const radius = Math.min(4, bodyWidth / 2);
  context.beginPath();
  context.roundRect(bodyLeft, top + 2, bodyWidth, TRACK_HEIGHT - 4, radius);

  context.fillStyle = TRACK_TYPE_COLORS[track.type];
  context.globalAlpha = track.visible ? 1 : 0.4;
  context.fill();

  context.globalAlpha = 1;
  context.lineWidth = selected ? 2 : 1;
  context.strokeStyle = selected ? SELECTED_OUTLINE : '#0e0f11';
  context.stroke();

  if (peaks) drawWaveform(context, clip, peaks, x, clipWidth, top, fps, canvasWidth);

  drawFades(context, clip, x, clipWidth, top, ui.pixelsPerFrame, hovered);

  // Alpha-bearing sources get a marker, since that is what decides whether a
  // clip can be exported as a transparent sprite.
  if (clip.hasAlphaChannel) {
    context.fillStyle = '#f8fafc';
    context.globalAlpha = 0.8;
    context.beginPath();
    context.arc(x + clipWidth - 8, top + 10, 3, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
  }

  if (bodyWidth > 42) {
    context.save();
    context.beginPath();
    context.rect(bodyLeft + 4, top, bodyWidth - 8, TRACK_HEIGHT);
    context.clip();

    // The label rides along the visible part of the clip, so a long clip that
    // starts off screen still says what it is.
    const labelX = Math.max(x, 0) + 7;

    // A linked clip wears a chain, so a group is visible without having to
    // click one to find out what else moves with it.
    const nameX = clip.linkGroup ? labelX + 16 : labelX;
    if (clip.linkGroup) drawLinkMark(context, labelX, top + 8);

    context.fillStyle = '#e2e8f0';
    context.font = LABEL_FONT;
    context.textBaseline = 'top';
    context.fillText(clip.name, nameX, top + 7);

    const keyframeCount =
      clip.transform.position.length +
      clip.transform.scale.length +
      clip.transform.rotation.length +
      clip.transform.opacity.length;

    // A retimed clip says so, the way every editor marks one.
    const speed = speedLabel(clip);
    if (speed) {
      context.fillStyle = '#fcd34d';
      context.font = LABEL_FONT;
      context.fillText(speed, labelX, top + 24);
    }

    if (keyframeCount > 0) {
      context.fillStyle = '#cbd5f5';
      context.font = LABEL_FONT;
      context.fillText(`${keyframeCount} keyframes`, speed ? labelX + 42 : labelX, top + 24);
    }
    context.restore();
  }

  context.restore();
}

/** Half-width of a marker's clickable zone on the ruler, in pixels. */
export const MARKER_HIT_PX = 6;

/**
 * The marker under an x coordinate on the ruler, if any.
 *
 * Later markers win a tie, so the one drawn on top is the one that is hit -
 * which is the only resolution that does not feel broken when two markers sit
 * a frame apart at low zoom.
 */
export function markerAtPixel(
  project: ProjectState,
  ui: EditorUiState,
  x: number,
): Marker | undefined {
  let found: Marker | undefined;
  for (const marker of project.markers) {
    const markerX = frameToPixel(marker.frame, ui.pixelsPerFrame, ui.scrollLeftPx);
    if (Math.abs(x - markerX) <= MARKER_HIT_PX) found = marker;
  }
  return found;
}

/**
 * Marker flags, in their lane at the top of the ruler.
 *
 * They are drawn after the ruler because the ruler paints its own background -
 * a flag drawn before it is simply erased. They used to sit on the numbers,
 * and a label such as "Chapter 1" covered the time under it.
 */
function drawMarkerFlags(
  context: CanvasRenderingContext2D,
  project: ProjectState,
  ui: EditorUiState,
  width: number,
): void {
  context.font = LABEL_FONT;
  context.textBaseline = 'alphabetic';

  for (const marker of project.markers) {
    const x = Math.round(frameToPixel(marker.frame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;
    if (x < -40 || x > width + 40) continue;

    const selected = marker.id === ui.selectedMarkerId;

    context.fillStyle = marker.color;
    context.beginPath();
    context.moveTo(x - 4, 1);
    context.lineTo(x + 4, 1);
    context.lineTo(x + 4, 6);
    context.lineTo(x, 10);
    context.lineTo(x - 4, 6);
    context.closePath();
    context.fill();

    if (selected) {
      context.strokeStyle = '#f8fafc';
      context.lineWidth = 1;
      context.stroke();
    }

    if (marker.label) {
      context.fillStyle = selected ? '#f8fafc' : '#cbd5f5';
      context.fillText(marker.label, x + 7, MARKER_LANE_HEIGHT - 2);
    }
  }
}

/** The scissors badge on the playhead, in the ruler: centre and half size. */
const SCISSORS_Y = 16;
const SCISSORS_HALF = 7;

/** Whether a ruler press lands on the playhead's scissors. */
export function hitsPlayheadScissors(project: ProjectState, ui: EditorUiState, x: number, y: number): boolean {
  const playheadX = frameToPixel(project.currentFrame, ui.pixelsPerFrame, ui.scrollLeftPx);
  return Math.abs(x - playheadX) <= SCISSORS_HALF + 1 && Math.abs(y - SCISSORS_Y) <= SCISSORS_HALF + 1;
}

/**
 * The scissors on the playhead's head, drawn rather than typed.
 *
 * It used to be the character U+2702 in a `fillText`. Two things were wrong
 * with that: the glyph depends on whichever font the machine has, and the
 * character itself did not survive a file being rewritten in the wrong
 * encoding - it shipped as "â", three letters crammed into a
 * 14px badge. Paths cannot be mojibaked.
 */
function drawScissors(context: CanvasRenderingContext2D, x: number, y: number, colour: string): void {
  context.save();
  context.strokeStyle = colour;
  context.lineWidth = 1;
  context.lineCap = 'round';

  // Two blades crossing just above the middle.
  context.beginPath();
  context.moveTo(x - 2.2, y + 2.4);
  context.lineTo(x + 1.9, y - 3);
  context.moveTo(x + 2.2, y + 2.4);
  context.lineTo(x - 1.9, y - 3);
  context.stroke();

  // The two rings the fingers go through, kept clear of the tab's point.
  context.beginPath();
  context.arc(x - 2.5, y + 3.3, 1.25, 0, Math.PI * 2);
  context.arc(x + 2.5, y + 3.3, 1.25, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function drawPlayhead(
  context: CanvasRenderingContext2D,
  project: ProjectState,
  ui: EditorUiState,
  height: number,
): void {
  const x = Math.round(frameToPixel(project.currentFrame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;

  /*
    One head, not two. There used to be a triangle at the very top and a
    separate red square below it, which read as two marks arguing about where
    the playhead was. This is a single tab, rounded at the top and pointed at
    the bottom, sitting on the line it belongs to - the shape Resolve and
    Premiere both use - with the scissors inside it, because a click there
    cuts, as it does in Filmora.
  */
  const halfWidth = SCISSORS_HALF;
  const top = 2;
  const bottom = SCISSORS_Y + SCISSORS_HALF;

  context.save();
  context.beginPath();
  context.moveTo(x - halfWidth, top + 3);
  context.quadraticCurveTo(x - halfWidth, top, x - halfWidth + 3, top);
  context.lineTo(x + halfWidth - 3, top);
  context.quadraticCurveTo(x + halfWidth, top, x + halfWidth, top + 3);
  context.lineTo(x + halfWidth, bottom - 4);
  context.lineTo(x, bottom);
  context.lineTo(x - halfWidth, bottom - 4);
  context.closePath();

  context.fillStyle = '#f87171';
  context.fill();
  // A hairline of shadow under the head, so it lifts off the ruler instead of
  // sitting in it.
  context.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  context.lineWidth = 1;
  context.stroke();
  context.restore();

  drawScissors(context, x, SCISSORS_Y - 2, '#1a1b1e');

  context.strokeStyle = '#f87171';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, bottom);
  context.lineTo(x, height);
  context.stroke();
}

export function TimelineCanvas(props: TimelineCanvasProps): JSX.Element {
  const { project, ui, tracks, activeSnap, waveforms, width, height } = props;
  const marquee = props.marquee ?? null;
  const hover = props.hover ?? null;
  const activeTrim = props.activeTrim ?? null;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // When the hovered clip changes, the handles start growing from zero.
  const hoverKey = hover?.clipId ?? null;
  const hoverStartedAt = useRef(0);
  const lastHoverKey = useRef<string | null>(null);
  if (hoverKey !== lastHoverKey.current) {
    lastHoverKey.current = hoverKey;
    hoverStartedAt.current = performance.now();
  }
  const animationFrame = useRef<number | null>(null);

  const paint = useCallback(() => {
    const handleProgress = hoverKey
      ? Math.min(1, (performance.now() - hoverStartedAt.current) / HANDLE_ANIMATION_MS)
      : 0;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    context.fillStyle = '#0e0f11';
    context.fillRect(0, 0, width, height);

    const selected = new Set(ui.selectedClipIds);

    tracks.forEach((track, index) => {
      const top = trackRowTop(index);
      if (top > height) return;

      context.fillStyle = index % 2 === 0 ? '#16181c' : '#191b20';
      context.fillRect(0, top, width, TRACK_HEIGHT);

      if (track.locked) {
        context.fillStyle = 'rgba(148, 163, 184, 0.06)';
        context.fillRect(0, top, width, TRACK_HEIGHT);
      }

      // Same order the pointer hit-tests in, reversed: what is drawn on top is
      // what a click selects.
      for (const clip of clipsInPaintOrder(project, track.id, selected)) {
        // Cull clips that are entirely off-screen before touching the 2D API.
        const startX = frameToPixel(clip.startFrame, ui.pixelsPerFrame, ui.scrollLeftPx);
        const endX = frameToPixel(clipEndFrame(clip), ui.pixelsPerFrame, ui.scrollLeftPx);
        if (endX < 0 || startX > width) continue;

        drawClip(
          context,
          clip,
          track,
          top,
          ui,
          selected.has(clip.id),
          waveforms[clip.sourceUri],
          project.fps,
          width,
          hover?.clipId === clip.id || activeTrim?.clipId === clip.id,
        );

        const held = activeTrim?.clipId === clip.id;
        if (held || hover?.clipId === clip.id) {
          drawTrimHandles(
            context,
            startX,
            endX - startX,
            top,
            held ? 1 : handleProgress,
            held ? activeTrim.edge : (hover?.edge ?? null),
            held,
          );
        }
      }
    });

    if (marquee) {
      const left = Math.min(marquee.x0, marquee.x1);
      const topY = Math.max(RULER_HEIGHT, Math.min(marquee.y0, marquee.y1));
      const boxWidth = Math.abs(marquee.x1 - marquee.x0);
      const boxHeight = Math.max(marquee.y0, marquee.y1) - topY;
      context.fillStyle = 'rgba(59, 130, 246, 0.15)';
      context.fillRect(left, topY, boxWidth, boxHeight);
      context.strokeStyle = '#60a5fa';
      context.lineWidth = 1;
      context.strokeRect(Math.round(left) + 0.5, Math.round(topY) + 0.5, Math.round(boxWidth), Math.round(boxHeight));
    }

    for (const marker of project.markers) {
      const x = Math.round(frameToPixel(marker.frame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;
      if (x < -MARKER_HIT_PX || x > width + 200) continue;

      context.strokeStyle = marker.color;
      context.globalAlpha = marker.id === ui.selectedMarkerId ? 0.9 : 0.5;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(x, RULER_HEIGHT);
      context.lineTo(x, height);
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
    }

    if (activeSnap) {
      const x = Math.round(frameToPixel(activeSnap.frame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;
      context.strokeStyle = '#22d3ee';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, RULER_HEIGHT);
      context.lineTo(x, height);
      context.stroke();
    }

    drawRuler(context, project, ui, width);
    drawMarkerFlags(context, project, ui, width);
    drawPlayhead(context, project, ui, height);

    // Keep painting only while the handles are still growing in; a still
    // timeline costs nothing.
    if (handleProgress > 0 && handleProgress < 1) {
      animationFrame.current = requestAnimationFrame(paint);
    }
  }, [project, ui, tracks, activeSnap, waveforms, width, height, marquee, hover, activeTrim, hoverKey]);

  useEffect(() => {
    animationFrame.current = requestAnimationFrame(paint);
    return () => {
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    };
  }, [paint]);

  // The pointer says what a press would do: the parent works that out from
  // what is under it (a trim edge, a clip, empty space) and the active tool.
  const cursor = props.cursor ?? (ui.tool === 'hand' ? 'grab' : 'default');

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, cursor }}
      className="block"
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerLeave={props.onPointerLeave}
      onContextMenu={props.onContextMenu}
    />
  );
}

export default TimelineCanvas;
