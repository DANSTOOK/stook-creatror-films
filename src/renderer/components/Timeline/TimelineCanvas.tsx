import { useCallback, useEffect, useRef } from 'react';
import type { Clip, ProjectState, Track } from '@shared/types';
import { framesToShortLabel } from '@shared/utils/timecode';
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
  width: number;
  height: number;
  onPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void;
  onPointerUp(event: React.PointerEvent<HTMLCanvasElement>): void;
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
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
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

function drawClip(
  context: CanvasRenderingContext2D,
  clip: Clip,
  track: Track,
  top: number,
  ui: EditorUiState,
  selected: boolean,
): void {
  const x = frameToPixel(clip.startFrame, ui.pixelsPerFrame, ui.scrollLeftPx);
  const clipWidth = Math.max(2, clip.durationFrames * ui.pixelsPerFrame);

  context.save();

  const radius = Math.min(4, clipWidth / 2);
  context.beginPath();
  context.roundRect(x, top + 2, clipWidth, TRACK_HEIGHT - 4, radius);

  context.fillStyle = TRACK_COLORS[track.type];
  context.globalAlpha = track.visible ? 1 : 0.4;
  context.fill();

  context.globalAlpha = 1;
  context.lineWidth = selected ? 2 : 1;
  context.strokeStyle = selected ? '#60a5fa' : '#0d0f14';
  context.stroke();

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

  if (clipWidth > 42) {
    context.save();
    context.beginPath();
    context.rect(x + 4, top, clipWidth - 8, TRACK_HEIGHT);
    context.clip();

    context.fillStyle = '#e2e8f0';
    context.font = '11px system-ui, sans-serif';
    context.textBaseline = 'top';
    context.fillText(clip.name, x + 7, top + 7);

    const keyframeCount =
      clip.transform.position.length +
      clip.transform.scale.length +
      clip.transform.rotation.length +
      clip.transform.opacity.length;

    if (keyframeCount > 0) {
      context.fillStyle = '#cbd5f5';
      context.font = '9px system-ui, sans-serif';
      context.fillText(`${keyframeCount} keyframes`, x + 7, top + 24);
    }
    context.restore();
  }

  context.restore();
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
  const { project, ui, tracks, activeSnap, width, height } = props;
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

        drawClip(context, clip, track, top, ui, selected.has(clip.id));
      }
    });

    for (const marker of ui.markers) {
      const x = Math.round(frameToPixel(marker, ui.pixelsPerFrame, ui.scrollLeftPx)) + 0.5;
      context.strokeStyle = '#facc15';
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(x, RULER_HEIGHT);
      context.lineTo(x, height);
      context.stroke();
      context.setLineDash([]);
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
    drawPlayhead(context, project, ui, height);
  }, [project, ui, tracks, activeSnap, width, height]);

  useEffect(() => {
    const handle = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(handle);
  }, [paint]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className="block cursor-default"
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
    />
  );
}

export default TimelineCanvas;
