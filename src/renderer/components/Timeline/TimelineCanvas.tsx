import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { Clip, Marker, ProjectState, Track } from '@shared/types';
import { framesToShortLabel } from '@shared/utils/timecode';
import type { WaveformPeaks } from '@renderer/audio/WaveformExtractor';
import type { EditorUiState } from '@renderer/store/types';
import { clipEndFrame, clipsInPaintOrder } from './timelineOps';
import { frameToPixel, type SnapTarget } from './snapping';
import { isReversed, sourceFramesUsed, speedLabel } from '@renderer/timing/clipSpeed';
import type { ClipAppearance, Filmstrip } from '@renderer/media/clipContent';
import { fadeLengths } from '@renderer/timing/clipFades';
import { motionQuiet, motionReduced } from '@renderer/motion/environment';
import { stepZoomView, type DisplayedView } from './zoomMotion';

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
  /** Filmstrips per source URI, for clips with pictures. */
  filmstrips?: Record<string, Filmstrip>;
  /** Source URIs whose files are missing: drawn as offline. */
  offlineUris?: ReadonlySet<string>;
  /** What clips show inside: see ClipAppearance. */
  appearance?: ClipAppearance;
  /** Changes when a filmstrip frame has been decoded, to paint it. */
  contentVersion?: number;
  labels?: CanvasLabels;
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
  /**
   * Clips pushed aside by an edit slide to their new places. Off while an
   * edge is being trimmed: what follows a trim has to track the pointer.
   */
  animateDisplacement?: boolean;
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
/** A clip pushed aside by the magnet (or an undo) glides this long to its place. */
const SLIDE_MS = 180;
/** The snap line flashes this long when it catches something new. */
const SNAP_FLASH_MS = 120;
/** More clips than this moving at once is a new project or a big edit: no slide. */
const SLIDE_LIMIT = 60;

interface Slide {
  /** Frames between where it is drawn at the start and where it really is. */
  fromOffset: number;
  startedAt: number;
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

function slideOffset(slide: Slide | undefined, now: number): number {
  if (!slide) return 0;
  const t = (now - slide.startedAt) / SLIDE_MS;
  return t >= 1 ? 0 : slide.fromOffset * (1 - easeOutCubic(Math.max(0, t)));
}

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
 * The waveform inside a clip, in the band `[bandTop, bandBottom]`.
 *
 * Rectified - the louder of each min/max pair, drawn up from the band's floor
 * as one filled shape - the way Final Cut and current Premiere draw clip
 * audio: the same height shows twice the detail of a wave mirrored about a
 * centre line, and a loud passage reads as tall rather than as thick. Linear
 * in level, so half the height is half the amplitude (-6 dB).
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
  bandTop: number,
  bandBottom: number,
  fps: number,
  canvasWidth: number,
  fill: string,
): void {
  if (peaks.durationSeconds <= 0 || clipWidth < 4 || bandBottom - bandTop < 4) return;

  // A retimed clip covers more or less footage than the time it fills: at
  // 200% the wave is squeezed into half the width, which is what it sounds
  // like. Drawn from the footage the clip consumes, not from its length.
  const sourceStart = clip.sourceOffsetFrames / fps;
  const sourceEnd = sourceStart + sourceFramesUsed(clip) / fps;
  const reversed = isReversed(clip);

  const firstBucket = Math.floor((sourceStart / peaks.durationSeconds) * peaks.bucketCount);
  const lastBucket = Math.ceil((sourceEnd / peaks.durationSeconds) * peaks.bucketCount);
  const span = lastBucket - firstBucket;
  if (span <= 0) return;

  const height = bandBottom - bandTop;

  // Only the on-screen slice of the clip is walked. A 45-minute clip zoomed in
  // is millions of pixels wide, and iterating all of them every frame to draw
  // the ~1500 that are visible is exactly the work that makes a long timeline
  // stutter.
  const firstPixel = Math.max(0, Math.floor(-x));
  const lastPixel = Math.min(clipWidth, Math.ceil(canvasWidth - x));
  if (lastPixel <= firstPixel) return;

  // One column per output pixel - or per bucket when there are fewer buckets
  // than pixels - and each column is the loudest bucket under it, so a
  // zoomed-out wave keeps its peaks instead of sampling past them. The walk
  // is bounded: a column never looks at more than 64 buckets.
  const step = Math.max(1, clipWidth / span);
  const bucketsPerPixel = Math.min(64, Math.max(1, Math.floor(span / clipWidth)));

  context.save();
  context.fillStyle = fill;
  context.beginPath();
  context.moveTo(x + firstPixel, bandBottom);
  for (let pixel = firstPixel; pixel <= lastPixel; pixel += step) {
    const ratio = reversed ? 1 - pixel / clipWidth : pixel / clipWidth;
    const from = Math.max(0, Math.min(peaks.bucketCount - 1, Math.floor(firstBucket + ratio * span)));
    const to = Math.min(peaks.bucketCount - 1, from + bucketsPerPixel - 1);
    let level = 0;
    for (let bucket = from; bucket <= to; bucket += 1) {
      const loud = Math.max(Math.abs(peaks.peaks[bucket * 2]), Math.abs(peaks.peaks[bucket * 2 + 1]));
      if (loud > level) level = loud;
    }
    const columnTop = bandBottom - Math.min(1, level) * height;
    context.lineTo(x + pixel, columnTop);
    context.lineTo(Math.min(x + lastPixel, x + pixel + step), columnTop);
  }
  context.lineTo(x + lastPixel, bandBottom);
  context.closePath();
  context.fill();
  context.restore();
}

/**
 * A filmstrip along the clip, in the band `[bandTop, bandTop + bandHeight]`.
 *
 * Tiles are laid from the clip's start, each as wide as a frame of its shape
 * is at the band's height, and each shows the picture where it begins - the
 * way Final Cut and Resolve draw one. Only the tiles on screen are drawn, so
 * the cost follows the width of the view, whatever the zoom.
 */
function drawFilmstrip(
  context: CanvasRenderingContext2D,
  clip: Clip,
  strip: Filmstrip,
  x: number,
  clipWidth: number,
  bandTop: number,
  bandHeight: number,
  fps: number,
  canvasWidth: number,
): void {
  const tileWidth = Math.max(8, bandHeight * strip.aspect);
  const first = Math.max(0, Math.floor(-x / tileWidth));
  const last = Math.min(Math.ceil(clipWidth / tileWidth), Math.ceil((canvasWidth - x) / tileWidth));
  const sourceStart = clip.sourceOffsetFrames / fps;
  const sourceSeconds = sourceFramesUsed(clip) / fps;
  const reversed = isReversed(clip);

  for (let tile = first; tile < last; tile += 1) {
    const left = x + tile * tileWidth;
    const along = Math.min(1, (tile * tileWidth) / clipWidth);
    const seconds = sourceStart + (reversed ? 1 - along : along) * sourceSeconds;
    const frame = strip.frameAt(seconds);
    const bitmap = strip.bitmap(frame) ?? strip.nearestDecoded(frame);
    if (bitmap) {
      context.drawImage(bitmap, left, bandTop, tileWidth, bandHeight);
    } else {
      // Still on its way: a shade of the clip, not a hole.
      context.fillStyle = 'rgba(13, 15, 20, 0.3)';
      context.fillRect(left, bandTop, tileWidth - 1, bandHeight);
    }
  }
}

/**
 * The file behind this clip is not where the project says: red stripes and
 * the words, as Resolve and Premiere mark offline media, instead of a clip
 * that looks fine and plays nothing.
 */
function drawOffline(
  context: CanvasRenderingContext2D,
  bodyLeft: number,
  bodyWidth: number,
  top: number,
  label: string,
): void {
  const bodyTop = top + 2;
  const height = TRACK_HEIGHT - 4;
  context.fillStyle = '#3b1717';
  context.fillRect(bodyLeft, bodyTop, bodyWidth, height);
  context.strokeStyle = 'rgba(248, 113, 113, 0.28)';
  context.lineWidth = 6;
  context.beginPath();
  const start = Math.floor((bodyLeft - height) / 16) * 16;
  for (let stripe = start; stripe < bodyLeft + bodyWidth + height; stripe += 16) {
    context.moveTo(stripe, bodyTop + height);
    context.lineTo(stripe + height, bodyTop);
  }
  context.stroke();
  if (bodyWidth > 90) {
    context.font = LABEL_FONT;
    const textWidth = context.measureText(label).width;
    const labelX = Math.max(bodyLeft, 0) + 7;
    context.fillStyle = '#3b1717';
    context.fillRect(labelX - 4, bodyTop + height - 19, textWidth + 8, 16);
    context.fillStyle = '#fecaca';
    context.textBaseline = 'middle';
    context.fillText(label, labelX, bodyTop + height - 11);
  }
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
/** Words the canvas writes, in the interface language. */
export interface CanvasLabels {
  offline: string;
  keyframes(count: number): string;
}

const DEFAULT_LABELS: CanvasLabels = {
  offline: 'Media offline',
  keyframes: (count) => `${count} keyframes`,
};

/** What a clip carries: its pictures, its sound, and whether its file is there at all. */
export interface ClipContent {
  peaks?: WaveformPeaks;
  filmstrip?: Filmstrip;
  offline?: boolean;
}

/**
 * The waveform's colour on each kind of clip. Measured with contrast.ts
 * against what it is drawn on: 4.1:1 on an audio clip, 6.8:1 on the dark
 * sound strip of a video clip (3:1 is the bar for graphics).
 */
export const WAVE_FILL: Record<Track['type'], string> = {
  video: '#bfdbfe',
  audio: '#a7f3d0',
  text: '#e9d5ff',
  adjustment: '#fde68a',
};

/** The darker strip a video clip's sound is drawn on, under its pictures. */
export const SOUND_STRIP = 'rgba(8, 10, 14, 0.35)';

/** Behind a clip name drawn over pictures: dark enough for 4.5:1 over a white frame. */
export const NAME_BAND = 'rgba(10, 11, 14, 0.66)';
/** The height of that band, from the top of the clip body. */
const NAME_BAND_HEIGHT = 16;
/** The pictures' share of a clip that shows both: the sound gets the rest (22 px). */
const FILMSTRIP_SHARE = 30;

function drawClip(
  context: CanvasRenderingContext2D,
  clip: Clip,
  track: Track,
  top: number,
  ui: EditorUiState,
  selected: boolean,
  content: ClipContent,
  appearance: ClipAppearance,
  fps: number,
  canvasWidth: number,
  /** The pointer is on this clip: the fade grips are offered. */
  hovered: boolean,
  labels: CanvasLabels,
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
  const bodyTop = top + 2;
  const bodyHeight = TRACK_HEIGHT - 4;
  const bodyBottom = bodyTop + bodyHeight;

  context.save();

  const radius = Math.min(4, bodyWidth / 2);
  context.beginPath();
  context.roundRect(bodyLeft, bodyTop, bodyWidth, bodyHeight, radius);

  context.fillStyle = TRACK_TYPE_COLORS[track.type];
  context.globalAlpha = track.visible ? 1 : 0.4;
  context.fill();

  /*
    What the clip shows inside, after Final Cut's clip appearance: pictures
    on top and sound under them, either one alone, or only the name. A clip
    with only one of the two shows that one across its whole height; a sound
    clip shows its wave in every mode but "names only".
  */
  let pictureBottom = bodyTop;
  if (content.offline) {
    context.save();
    context.clip();
    drawOffline(context, bodyLeft, bodyWidth, top, labels.offline);
    context.restore();
  } else if (appearance !== 'name') {
    const picture = track.type !== 'audio' && appearance !== 'waveform' ? content.filmstrip : undefined;
    const peaks = track.type === 'audio' || appearance !== 'filmstrip' || !picture ? content.peaks : undefined;

    context.save();
    context.clip();
    if (picture) {
      // A clip without sound gives its pictures the whole body.
      const pictureHeight = peaks ? FILMSTRIP_SHARE : bodyHeight;
      drawFilmstrip(context, clip, picture, x, clipWidth, bodyTop, pictureHeight, fps, canvasWidth);
      pictureBottom = bodyTop + pictureHeight;
    }
    if (peaks) {
      let bandTop = bodyTop + NAME_BAND_HEIGHT;
      if (picture) {
        // The sound's own strip under the pictures, darker, so the wave reads on it.
        context.fillStyle = SOUND_STRIP;
        context.fillRect(bodyLeft, pictureBottom, bodyWidth, bodyBottom - pictureBottom);
        bandTop = pictureBottom + 2;
      }
      drawWaveform(context, clip, peaks, x, clipWidth, bandTop, bodyBottom - 1, fps, canvasWidth, WAVE_FILL[track.type]);
    }
    context.restore();
  }

  // The outline goes over the pictures, so a selected clip stays marked.
  context.globalAlpha = 1;
  context.beginPath();
  context.roundRect(bodyLeft, bodyTop, bodyWidth, bodyHeight, radius);
  context.lineWidth = selected ? 2 : 1;
  context.strokeStyle = selected ? SELECTED_OUTLINE : '#0e0f11';
  context.stroke();

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
    context.font = LABEL_FONT;
    context.textBaseline = 'top';

    // A linked clip wears a chain, so a group is visible without having to
    // click one to find out what else moves with it.
    const nameX = clip.linkGroup ? labelX + 16 : labelX;

    // Over pictures the name sits on a dark chip: light text straight on a
    // light frame would disappear. A chip, not a band across the clip, so
    // the rest of the filmstrip stays in view.
    const overPicture = pictureBottom > bodyTop;
    if (overPicture) {
      context.fillStyle = NAME_BAND;
      context.beginPath();
      context.roundRect(labelX - 4, bodyTop + 1, nameX - labelX + context.measureText(clip.name).width + 8, NAME_BAND_HEIGHT - 1, 3);
      context.fill();
    }
    if (clip.linkGroup) drawLinkMark(context, labelX, top + 6);

    context.fillStyle = '#e2e8f0';
    context.fillText(clip.name, nameX, top + 4);

    const keyframeCount =
      clip.transform.position.length +
      clip.transform.scale.length +
      clip.transform.rotation.length +
      clip.transform.opacity.length;

    // A retimed clip says so, the way every editor marks one; over pictures
    // each note gets a dark chip of its own.
    const note = (text: string, noteX: number, colour: string): number => {
      const width = context.measureText(text).width;
      if (overPicture) {
        context.fillStyle = NAME_BAND;
        context.fillRect(noteX - 3, top + 20, width + 6, 15);
      }
      context.fillStyle = colour;
      context.fillText(text, noteX, top + 21);
      return noteX + width + 10;
    };
    let noteX = labelX;
    const speed = speedLabel(clip);
    if (speed) noteX = note(speed, noteX, '#fcd34d');
    if (keyframeCount > 0) note(labels.keyframes(keyframeCount), noteX, '#cbd5f5');
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
  const { project, ui: storeUi, tracks, activeSnap, waveforms, width, height } = props;
  const filmstrips = props.filmstrips;
  const offlineUris = props.offlineUris;
  const appearance = props.appearance ?? 'both';
  const contentVersion = props.contentVersion ?? 0;
  const labels = props.labels ?? DEFAULT_LABELS;
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

  /*
    What is drawn can run a few milliseconds behind what the store says, and
    only here: a zoom eases to the store's value (zoomMotion.ts), a clip the
    magnet pushed aside glides to its new start, the snap line flashes. The
    store - and so every click, every hit test - already has the final value.
    Nothing here renders React; it is the same paint, called again while
    something is still moving, and a still timeline costs nothing.
  */
  const displayed = useRef<DisplayedView | null>(null);
  const lastPaintAt = useRef(0);
  const slides = useRef(new Map<string, Slide>());
  const previousClips = useRef<ProjectState['clips'] | null>(null);
  const snapFlash = useRef<{ key: string; at: number } | null>(null);
  const animateDisplacement = props.animateDisplacement ?? true;

  // Before the paint effect: which clips moved, and from where they were drawn.
  useLayoutEffect(() => {
    const before = previousClips.current;
    previousClips.current = project.clips;
    if (!before || before === project.clips) return;
    const now = performance.now();
    if (!animateDisplacement || motionQuiet() || motionReduced()) {
      slides.current.clear();
      return;
    }
    const selected = new Set(storeUi.selectedClipIds);
    const moved: Array<[string, number]> = [];
    for (const [id, clip] of Object.entries(project.clips)) {
      const old = before[id];
      if (!old || old.trackId !== clip.trackId || old.startFrame === clip.startFrame || selected.has(id)) continue;
      // From where it is on screen right now, so a second push carries on from there.
      const drawnAt = old.startFrame + slideOffset(slides.current.get(id), now);
      moved.push([id, drawnAt - clip.startFrame]);
    }
    if (moved.length === 0) return;
    if (moved.length > SLIDE_LIMIT) {
      slides.current.clear();
      return;
    }
    for (const [id, fromOffset] of moved) {
      // A jump across the whole view is not a slide anyone could follow.
      if (Math.abs(fromOffset * storeUi.pixelsPerFrame) > width * 1.5) slides.current.delete(id);
      else slides.current.set(id, { fromOffset, startedAt: now });
    }
    // The selection and scale are read at the moment of the edit only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.clips]);

  const paint = useCallback(() => {
    const now = performance.now();
    const handleProgress = hoverKey
      ? Math.min(1, (now - hoverStartedAt.current) / HANDLE_ANIMATION_MS)
      : 0;
    const dt = lastPaintAt.current ? Math.min(50, now - lastPaintAt.current) : 16;
    lastPaintAt.current = now;
    const zoom = stepZoomView(
      displayed.current,
      { pixelsPerFrame: storeUi.pixelsPerFrame, scrollLeftPx: storeUi.scrollLeftPx },
      dt,
      width,
      motionReduced(),
    );
    displayed.current = zoom.view;
    // The view as drawn: the store's, or a step on the way to it.
    const ui: EditorUiState = zoom.moving
      ? { ...storeUi, pixelsPerFrame: zoom.view.pixelsPerFrame, scrollLeftPx: zoom.view.scrollLeftPx }
      : storeUi;
    let sliding = false;
    const drawnClip = (clip: Clip): Clip => {
      const slide = slides.current.get(clip.id);
      if (!slide) return clip;
      const offset = slideOffset(slide, now);
      if (offset === 0) {
        slides.current.delete(clip.id);
        return clip;
      }
      sliding = true;
      return { ...clip, startFrame: clip.startFrame + offset };
    };
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
      for (const storedClip of clipsInPaintOrder(project, track.id, selected)) {
        const clip = drawnClip(storedClip);
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
          {
            peaks: waveforms[clip.sourceUri],
            filmstrip: filmstrips?.[clip.sourceUri],
            offline: offlineUris?.has(clip.sourceUri) ?? false,
          },
          appearance,
          project.fps,
          width,
          hover?.clipId === clip.id || activeTrim?.clipId === clip.id,
          labels,
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

    let flashing = false;
    if (activeSnap) {
      const x = Math.round(frameToPixel(activeSnap.frame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;
      // Catching something new flashes the line for a moment, so a snap is
      // felt as well as seen: a glow that fades out in 120 ms.
      const key = `${activeSnap.kind}:${activeSnap.frame}`;
      if (snapFlash.current?.key !== key) snapFlash.current = { key, at: now };
      const flash = motionReduced() ? 1 : (now - snapFlash.current.at) / SNAP_FLASH_MS;
      if (flash < 1) {
        flashing = true;
        context.save();
        context.globalAlpha = 0.45 * (1 - flash);
        context.strokeStyle = '#22d3ee';
        context.lineWidth = 5;
        context.beginPath();
        context.moveTo(x, RULER_HEIGHT);
        context.lineTo(x, height);
        context.stroke();
        context.restore();
      }
      context.strokeStyle = '#22d3ee';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, RULER_HEIGHT);
      context.lineTo(x, height);
      context.stroke();
    } else {
      snapFlash.current = null;
    }

    drawRuler(context, project, ui, width);
    drawMarkerFlags(context, project, ui, width);
    drawPlayhead(context, project, ui, height);

    // Keep painting only while something is still on its way; a still
    // timeline costs nothing.
    if ((handleProgress > 0 && handleProgress < 1) || zoom.moving || sliding || flashing) {
      animationFrame.current = requestAnimationFrame(paint);
    } else {
      lastPaintAt.current = 0;
    }
    // contentVersion is not read in the paint: it changes when a filmstrip
    // frame has been decoded, and that is exactly when to paint again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, storeUi, tracks, activeSnap, waveforms, filmstrips, offlineUris, appearance, contentVersion, labels, width, height, marquee, hover, activeTrim, hoverKey]);

  useEffect(() => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = requestAnimationFrame(paint);
    return () => {
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    };
  }, [paint]);

  // The pointer says what a press would do: the parent works that out from
  // what is under it (a trim edge, a clip, empty space) and the active tool.
  const cursor = props.cursor ?? (storeUi.tool === 'hand' ? 'grab' : 'default');

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
