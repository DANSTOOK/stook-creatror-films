import { useCallback, useEffect, useRef } from 'react';
import type { Clip, Marker, ProjectState, Track } from '@shared/types';
import { framesToShortLabel } from '@shared/utils/timecode';
import type { WaveformPeaks } from '@renderer/audio/WaveformExtractor';
import type { EditorUiState } from '@renderer/store/types';
import { clipEndFrame } from './timelineOps';
import { frameToPixel, type SnapTarget } from './snapping';

/**
 * Multi-track drawing surface.
 *
 * Every clip, waveform and grid line is painted into ONE canvas rather than
 * mounted as DOM nodes. That is what keeps a 100+ clip timeline at 60fps: React
 * only re-renders the canvas element itself, never a node per clip.
 */

export const TRACK_HEIGHT = 56;
export const TRACK_GAP = 2;
export const RULER_HEIGHT = 24;

const TRACK_COLORS: Record<Track['type'], string> = {
  video: '#2b4c7e',
  audio: '#2f6f5b',
  text: '#7a4c86',
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
  onPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void;
  onPointerUp(event: React.PointerEvent<HTMLCanvasElement>): void;
  onContextMenu(event: React.MouseEvent<HTMLCanvasElement>): void;
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
  context.fillStyle = '#1a1f2e';
  context.fillRect(0, 0, width, RULER_HEIGHT);

  context.strokeStyle = '#2e364d';
  context.beginPath();
  context.moveTo(0, RULER_HEIGHT - 0.5);
  context.lineTo(width, RULER_HEIGHT - 0.5);
  context.stroke();

  const step = rulerStep(ui.pixelsPerFrame, project.fps);
  const firstFrame = Math.floor(ui.scrollLeftPx / ui.pixelsPerFrame / step) * step;
  const lastFrame = firstFrame + Math.ceil(width / ui.pixelsPerFrame) + step;

  context.font = '10px ui-monospace, monospace';
  context.textBaseline = 'middle';

  for (let frame = firstFrame; frame <= lastFrame; frame += step) {
    const x = Math.round(frameToPixel(frame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;
    if (x < -40 || x > width + 40) continue;

    context.strokeStyle = '#3a4360';
    context.beginPath();
    context.moveTo(x, RULER_HEIGHT - 8);
    context.lineTo(x, RULER_HEIGHT);
    context.stroke();

    context.fillStyle = '#94a3b8';
    context.fillText(framesToShortLabel(frame, project.fps), x + 4, RULER_HEIGHT / 2 - 2);
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

  const sourceStart = clip.sourceOffsetFrames / fps;
  const sourceEnd = sourceStart + clip.durationFrames / fps;

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

  context.fillStyle = TRACK_COLORS[track.type];
  context.globalAlpha = track.visible ? 1 : 0.4;
  context.fill();

  context.globalAlpha = 1;
  context.lineWidth = selected ? 2 : 1;
  context.strokeStyle = selected ? '#60a5fa' : '#0d0f14';
  context.stroke();

  if (peaks) drawWaveform(context, clip, peaks, x, clipWidth, top, fps, canvasWidth);

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

    context.fillStyle = '#e2e8f0';
    context.font = '11px system-ui, sans-serif';
    context.textBaseline = 'top';
    context.fillText(clip.name, labelX, top + 7);

    const keyframeCount =
      clip.transform.position.length +
      clip.transform.scale.length +
      clip.transform.rotation.length +
      clip.transform.opacity.length;

    if (keyframeCount > 0) {
      context.fillStyle = '#cbd5f5';
      context.font = '9px system-ui, sans-serif';
      context.fillText(`${keyframeCount} keyframes`, labelX, top + 24);
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
 * Marker flags, drawn over the ruler.
 *
 * They go on top of the ruler rather than under it because the ruler paints its
 * own background - a flag drawn before it is simply erased.
 */
function drawMarkerFlags(
  context: CanvasRenderingContext2D,
  project: ProjectState,
  ui: EditorUiState,
  width: number,
): void {
  context.font = '9px system-ui, sans-serif';
  context.textBaseline = 'middle';

  for (const marker of project.markers) {
    const x = Math.round(frameToPixel(marker.frame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;
    if (x < -40 || x > width + 40) continue;

    const selected = marker.id === ui.selectedMarkerId;

    context.fillStyle = marker.color;
    context.beginPath();
    context.moveTo(x - 4, 2);
    context.lineTo(x + 4, 2);
    context.lineTo(x + 4, 9);
    context.lineTo(x, 13);
    context.lineTo(x - 4, 9);
    context.closePath();
    context.fill();

    if (selected) {
      context.strokeStyle = '#f8fafc';
      context.lineWidth = 1;
      context.stroke();
    }

    if (marker.label) {
      context.fillStyle = selected ? '#f8fafc' : '#cbd5f5';
      context.fillText(marker.label, x + 7, 7);
    }
  }
}

function drawPlayhead(
  context: CanvasRenderingContext2D,
  project: ProjectState,
  ui: EditorUiState,
  height: number,
): void {
  const x = Math.round(frameToPixel(project.currentFrame, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;

  context.strokeStyle = '#f87171';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();

  context.fillStyle = '#f87171';
  context.beginPath();
  context.moveTo(x - 5, 0);
  context.lineTo(x + 5, 0);
  context.lineTo(x, 8);
  context.closePath();
  context.fill();
}

export function TimelineCanvas(props: TimelineCanvasProps): JSX.Element {
  const { project, ui, tracks, activeSnap, waveforms, width, height } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const paint = useCallback(() => {
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

    context.fillStyle = '#0d0f14';
    context.fillRect(0, 0, width, height);

    const selected = new Set(ui.selectedClipIds);

    tracks.forEach((track, index) => {
      const top = trackRowTop(index);
      if (top > height) return;

      context.fillStyle = index % 2 === 0 ? '#131722' : '#161b27';
      context.fillRect(0, top, width, TRACK_HEIGHT);

      if (track.locked) {
        context.fillStyle = 'rgba(148, 163, 184, 0.06)';
        context.fillRect(0, top, width, TRACK_HEIGHT);
      }

      for (const clip of Object.values(project.clips)) {
        if (clip.trackId !== track.id) continue;

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
        );
      }
    });

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
  }, [project, ui, tracks, activeSnap, waveforms, width, height]);

  useEffect(() => {
    const handle = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(handle);
  }, [paint]);

  // The pointer should say what the active tool will do.
  const cursor =
    ui.tool === 'hand' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default';

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className={`block ${cursor}`}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onContextMenu={props.onContextMenu}
    />
  );
}

export default TimelineCanvas;
