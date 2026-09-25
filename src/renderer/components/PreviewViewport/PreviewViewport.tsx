import { useRef } from 'react';
import {
  ChevronFirst,
  ChevronLast,
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
        <div className="flex items-center gap-1 font-normal">
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
          {/*
            The "Pixel art" and "Alpha" toggles used to sit here. Neither was
            about the edit: one changed how the preview scaled, the other
            painted a checkerboard that was on for every project - even ones
            that export solid black there. The checkerboard now follows the
            project's own "Transparent background" setting, so the viewer shows
            what the export will contain.
          */}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex items-center justify-center bg-panel-950 p-4">
        {error ? (
          <p className="max-w-md text-center text-xs text-red-400">
            The compositor could not start: {error}
          </p>
        ) : (
          <div
            // The frame has to show where it ends, or a shrunk picture cannot be
            // placed: black on a near-black panel is no edge at all. A
            // transparent project gets the checkerboard, which marks it; any
            // other gets the black it will export and a hairline round it -
            // the black frame on a grey surround that Premiere and Resolve show.
            className={`relative max-h-full max-w-full ${
              project.hasAlphaBackground ? 'alpha-checkerboard' : 'bg-black outline outline-1 outline-white/10'
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
          <span className="timecode text-xs text-slate-300">
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
