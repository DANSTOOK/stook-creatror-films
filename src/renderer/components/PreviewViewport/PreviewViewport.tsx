import { useRef } from 'react';
import {
  ChevronFirst,
  ChevronLast,
  Grid2x2,
  Grip,
  Maximize2,
  Minimize2,
  Move,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { framesToTimecode } from '@shared/utils/timecode';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useTransport } from '@renderer/hooks/useTransport';
import { useCompositor } from './useCompositor';
import { ViewportControls } from './ViewportControls';

/** WebGL canvas player with scrubber and transport controls. */
export function PreviewViewport(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { error } = useCompositor(canvasRef);
  const transport = useTransport();

  const project = useProjectStore((state) => state.project);
  const ui = useProjectStore((state) => state.ui);
  const setUi = useProjectStore((state) => state.setUi);

  const timecode = framesToTimecode(project.currentFrame, project.fps);
  const duration = framesToTimecode(project.durationFrames, project.fps);

  return (
    <section
      data-testid="preview-panel"
      className={
        ui.fullscreenViewer
          ? 'panel fixed inset-0 z-40 rounded-none border-0'
          : 'panel min-w-0 flex-1'
      }
    >
      <header className="panel-header justify-between">
        <span>Preview</span>
        <div className="flex items-center gap-1 normal-case tracking-normal">
          <button
            type="button"
            data-testid="transform-mode"
            title="Transform (Shift+T) - handles on the selected clip, for moving, scaling and turning it"
            aria-pressed={ui.transformMode}
            className={`tool-button ${ui.transformMode ? 'tool-button-active' : ''}`}
            onClick={() => setUi({ transformMode: !ui.transformMode })}
          >
            <Move size={14} />
            Transform
          </button>
          <button
            type="button"
            data-testid="fullscreen-viewer"
            title={ui.fullscreenViewer ? 'Leave full screen (Esc)' : 'Full screen (Shift+F) - Esc to come back'}
            aria-label={ui.fullscreenViewer ? 'Leave full screen' : 'Full screen'}
            className={`tool-button ${ui.fullscreenViewer ? 'tool-button-active' : ''}`}
            onClick={() => setUi({ fullscreenViewer: !ui.fullscreenViewer })}
          >
            {ui.fullscreenViewer ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            title="Nearest-neighbour scaling (pixel art)"
            aria-pressed={ui.pixelArtViewport}
            className={`tool-button ${ui.pixelArtViewport ? 'tool-button-active' : ''}`}
            onClick={() => setUi({ pixelArtViewport: !ui.pixelArtViewport })}
          >
            <Grip size={14} />
            Pixel art
          </button>
          <button
            type="button"
            title="Show transparency checkerboard"
            aria-pressed={ui.showTransparencyGrid}
            className={`tool-button ${ui.showTransparencyGrid ? 'tool-button-active' : ''}`}
            onClick={() => setUi({ showTransparencyGrid: !ui.showTransparencyGrid })}
          >
            <Grid2x2 size={14} />
            Alpha
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex items-center justify-center bg-panel-950 p-4">
        {error ? (
          <p className="max-w-md text-center text-xs text-red-400">
            The compositor could not start: {error}
          </p>
        ) : (
          <div
            className={`relative max-h-full max-w-full ${
              ui.showTransparencyGrid ? 'alpha-checkerboard' : ''
            }`}
            style={{ aspectRatio: `${project.width} / ${project.height}` }}
          >
            <canvas
              ref={canvasRef}
              width={project.width}
              height={project.height}
              className="block h-full w-full object-contain"
              style={{ imageRendering: ui.pixelArtViewport ? 'pixelated' : 'auto' }}
            />
            {/* Drag the picture itself: move, scale, rotate. */}
            <ViewportControls />
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-panel-700 bg-panel-800 px-3 py-2">
        <input
          type="range"
          min={0}
          max={Math.max(1, project.durationFrames)}
          value={project.currentFrame}
          onChange={(event) => transport.scrub(Number(event.target.value))}
          className="w-full accent-blue-500"
          aria-label="Playhead"
        />

        <div className="mt-2 flex items-center justify-between">
          <span className="font-mono text-xs text-slate-400">
            {timecode} <span className="text-slate-400">/ {duration}</span>
          </span>

          <div className="flex items-center gap-1">
            <button type="button" className="tool-button" title="Go to start" onClick={() => transport.seek(0)}>
              <ChevronFirst size={16} />
            </button>
            <button type="button" className="tool-button" title="Previous frame" onClick={() => transport.step(-1)}>
              <SkipBack size={16} />
            </button>
            <button
              type="button"
              className="tool-button tool-button-active"
              title={ui.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              onClick={transport.toggle}
            >
              {ui.isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button type="button" className="tool-button" title="Next frame" onClick={() => transport.step(1)}>
              <SkipForward size={16} />
            </button>
            <button
              type="button"
              className="tool-button"
              title="Go to end"
              onClick={() => transport.seek(project.durationFrames)}
            >
              <ChevronLast size={16} />
            </button>
            <button
              type="button"
              aria-pressed={ui.loopPlayback}
              className={`tool-button ${ui.loopPlayback ? 'tool-button-active' : ''}`}
              title="Loop playback"
              onClick={() => setUi({ loopPlayback: !ui.loopPlayback })}
            >
              <Repeat size={16} />
            </button>
          </div>

          <span className="text-2xs text-slate-400">
            {project.width}x{project.height} @ {project.fps}fps
            {project.hasAlphaBackground ? ' - alpha' : ''}
          </span>
        </div>
      </footer>
    </section>
  );
}

export default PreviewViewport;
