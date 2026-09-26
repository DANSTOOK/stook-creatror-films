import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useSessionStore } from '@renderer/store/useSessionStore';
import { useTransport } from '@renderer/hooks/useTransport';
import { projectContentLength } from '@renderer/components/Timeline/timelineOps';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { useCompositor } from './useCompositor';
import { ViewportControls } from './ViewportControls';

/**
 * The viewer: the picture, what is being shown, and the transport.
 *
 * Laid out like Final Cut's viewer and Resolve's: the header says whose
 * picture this is (the project), how big it is drawn, and its format; the
 * picture takes the rest; under it a large timecode, the transport, and the
 * sequence's real length. The thick slider that used to run under the picture
 * is gone - the timeline's ruler is where the playhead is dragged, and neither
 * Resolve nor Final Cut repeat it under the viewer. It survives only in the
 * full-screen viewer, where there is no timeline.
 *
 * The length is the end of the last clip. It used to be the project's canvas
 * length, which a new project sets to one minute and only ever grows, so a
 * 19-second edit read "00:01:00:00".
 */

/** How big the picture is drawn: fitted to the viewer, or at a fixed scale. */
type Zoom = 'fit' | 0.5 | 1 | 2;
const ZOOMS: Zoom[] = ['fit', 0.5, 1, 2];

/** Idle time before the full-screen controls get out of the way. */
const CONTROLS_IDLE_MS = 2500;

export function PreviewViewport(): JSX.Element {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { error } = useCompositor(canvasRef);
  const transport = useTransport();

  const project = useProjectStore((state) => state.project);
  const ui = useProjectStore((state) => state.ui);
  const setUi = useProjectStore((state) => state.setUi);
  const projectName = useSessionStore((state) => state.projectName);
  const [zoom, setZoom] = useState<Zoom>('fit');

  const length = useMemo(() => projectContentLength(project), [project]);
  const timecode = framesToTimecode(project.currentFrame, project.fps);
  const duration = framesToTimecode(length, project.fps);
  const fullscreen = ui.fullscreenViewer;

  // The full-screen viewer takes the screen, not just the window, as Final
  // Cut's Play Full Screen and Resolve's Cinema Viewer do.
  useEffect(() => {
    if (!hasNativeBridge()) return undefined;
    window.filmora.setWindowFullScreen(fullscreen);
    return undefined;
  }, [fullscreen]);

  // Full screen shows the picture and nothing else: the controls come up when
  // the pointer moves and go again after a moment of stillness, cursor and all.
  const [controlsShown, setControlsShown] = useState(true);
  useEffect(() => {
    if (!fullscreen) {
      setControlsShown(true);
      return undefined;
    }
    let timer = window.setTimeout(() => setControlsShown(false), CONTROLS_IDLE_MS);
    const wake = (): void => {
      setControlsShown(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setControlsShown(false), CONTROLS_IDLE_MS);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [fullscreen]);

  // A fixed zoom is in picture pixels per screen pixel, so 100% is the frame
  // as it will be delivered, whatever the display's scaling.
  const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const frameStyle: React.CSSProperties =
    zoom === 'fit' || fullscreen
      ? { aspectRatio: `${project.width} / ${project.height}` }
      : { width: (project.width * zoom) / pixelRatio, height: (project.height * zoom) / pixelRatio, flexShrink: 0 };

  const zoomLabel = (value: Zoom): string => (value === 'fit' ? t('viewer.fit') : `${value * 100}%`);

  const transportButtons = (
    <div className="flex items-center gap-1">
      <button type="button" className="tool-button w-7 px-0" onClick={() => transport.seek(0)} {...tip(t('viewer.toStart'), { shortcut: 'Home' })}>
        <ChevronFirst size={16} />
      </button>
      <button type="button" className="tool-button w-7 px-0" onClick={() => transport.step(-1)} {...tip(t('viewer.previousFrame'), { shortcut: '←' })}>
        <SkipBack size={16} />
      </button>
      <button
        type="button"
        className="tool-button tool-button-active w-9 px-0"
        onClick={transport.toggle}
        {...tip(ui.isPlaying ? t('viewer.pause') : t('viewer.play'), { shortcut: 'Space' })}
      >
        {ui.isPlaying ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button type="button" className="tool-button w-7 px-0" onClick={() => transport.step(1)} {...tip(t('viewer.nextFrame'), { shortcut: '→' })}>
        <SkipForward size={16} />
      </button>
      <button type="button" className="tool-button w-7 px-0" onClick={() => transport.seek(length)} {...tip(t('viewer.toEnd'), { shortcut: 'End' })}>
        <ChevronLast size={16} />
      </button>
      <button
        type="button"
        aria-pressed={ui.loopPlayback}
        className={`tool-button w-7 px-0 ${ui.loopPlayback ? 'tool-button-active' : ''}`}
        onClick={() => setUi({ loopPlayback: !ui.loopPlayback })}
        {...tip(t('viewer.loop'))}
      >
        <Repeat size={16} />
      </button>
    </div>
  );

  const timecodes = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span data-testid="viewer-timecode" className="timecode text-base font-semibold text-slate-100">
        {timecode}
      </span>
      <span className="timecode truncate text-xs text-slate-400" title={t('viewer.lengthHint')}>
        {duration}
      </span>
    </span>
  );

  return (
    <section
      data-testid="preview-panel"
      data-state={fullscreen ? 'fullscreen' : 'docked'}
      className={
        fullscreen
          ? `panel fixed inset-0 z-[60] rounded-none border-0 bg-black ${controlsShown ? '' : 'cursor-none'}`
          : 'panel min-w-0 flex-1'
      }
    >
      {!fullscreen && (
        <header className="panel-header">
          <span className="min-w-0 flex-1 truncate" title={projectName}>
            {projectName}
          </span>
          <div className="flex shrink-0 items-center gap-1 font-normal">
            <span className="timecode mr-1 hidden text-2xs text-slate-400 lg:inline" data-testid="viewer-format">
              {project.width}×{project.height} · {project.fps} fps{project.hasAlphaBackground ? ` · ${t('viewer.alpha')}` : ''}
            </span>
            <label className="sr-only" htmlFor="viewer-zoom">
              {t('viewer.zoom')}
            </label>
            <select
              id="viewer-zoom"
              data-testid="viewer-zoom"
              className="numeric-input h-control-dense w-[76px] text-2xs"
              value={String(zoom)}
              onChange={(event) => setZoom(event.target.value === 'fit' ? 'fit' : (Number(event.target.value) as Zoom))}
              {...tip(t('viewer.zoom'), { named: false })}
            >
              {ZOOMS.map((value) => (
                <option key={String(value)} value={String(value)}>
                  {zoomLabel(value)}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="transform-mode"
              aria-pressed={ui.transformMode}
              className={`tool-button tool-button-dense w-6 px-0 ${ui.transformMode ? 'tool-button-active' : ''}`}
              onClick={() => setUi({ transformMode: !ui.transformMode })}
              {...tip(t('viewer.transform'), { shortcut: 'Shift+T', hint: t('viewer.transformHint') })}
            >
              <Move size={14} />
            </button>
            <button
              type="button"
              data-testid="fullscreen-viewer"
              className="tool-button tool-button-dense w-6 px-0"
              onClick={() => setUi({ fullscreenViewer: true })}
              {...tip(t('viewer.fullscreen'), { shortcut: 'Shift+F' })}
            >
              <Maximize2 size={14} />
            </button>
          </div>
        </header>
      )}

      <div
        className={`flex min-h-0 flex-1 ${
          fullscreen ? 'items-center justify-center bg-black p-0' : zoom === 'fit' ? 'items-center justify-center bg-panel-950 p-4' : 'overflow-auto bg-panel-950 p-4'
        }`}
      >
        {error ? (
          <p className="max-w-md text-center text-xs text-red-400">{t('viewer.compositorFailed', { error })}</p>
        ) : (
          <div
            // The frame has to show where it ends, or a shrunk picture cannot be
            // placed: black on a near-black panel is no edge at all. A
            // transparent project gets the checkerboard, which marks it; any
            // other gets the black it will export and a hairline round it -
            // the black frame on a grey surround that Premiere and Resolve show.
            className={`relative ${zoom === 'fit' || fullscreen ? 'max-h-full max-w-full' : 'm-auto'} ${
              project.hasAlphaBackground ? 'alpha-checkerboard' : 'bg-black outline outline-1 outline-white/10'
            }`}
            style={frameStyle}
          >
            <canvas
              ref={canvasRef}
              width={project.width}
              height={project.height}
              className="block h-full w-full object-contain"
              style={{ imageRendering: ui.pixelArtViewport || (zoom !== 'fit' && zoom > 1) ? 'pixelated' : 'auto' }}
            />
            {/* Drag the picture itself: move, scale, rotate. */}
            <ViewportControls />
          </div>
        )}
      </div>

      {fullscreen ? (
        // Over the picture, and only while the pointer is moving.
        <footer
          data-testid="fullscreen-controls"
          data-state={controlsShown ? 'shown' : 'hidden'}
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-6 pb-5 pt-12 transition-opacity duration-300 ${
            controlsShown ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          {/* A thin scrubber: here there is no timeline to drag the playhead on. */}
          <input
            type="range"
            min={0}
            max={Math.max(1, length)}
            value={Math.min(project.currentFrame, Math.max(1, length))}
            onChange={(event) => transport.scrub(Number(event.target.value))}
            className="mb-3 w-full"
            style={{ '--fill': `${(Math.min(project.currentFrame, length) / Math.max(1, length)) * 100}%` } as React.CSSProperties}
            aria-label={t('viewer.playhead')}
          />
          <div className="flex items-center justify-between gap-4">
            {timecodes}
            {transportButtons}
            <button
              type="button"
              className="tool-button"
              onClick={() => setUi({ fullscreenViewer: false })}
              {...tip(t('viewer.leaveFullscreen'), { shortcut: 'Esc', named: false })}
            >
              <Minimize2 size={14} />
              {t('viewer.leaveFullscreen')}
            </button>
          </div>
        </footer>
      ) : (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-panel-700 bg-panel-800 px-3 py-2">
          <div className="min-w-0 flex-1">{timecodes}</div>
          {transportButtons}
          {/* Balances the timecode, so the transport sits in the middle. */}
          <div className="flex-1" />
        </footer>
      )}
    </section>
  );
}

export default PreviewViewport;
