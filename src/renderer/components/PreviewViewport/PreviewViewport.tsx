import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ChevronFirst,
  ChevronLast,
  CircleSlash2,
  Film,
  Frame,
  Maximize2,
  Minimize2,
  Move,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  SquareSplitHorizontal,
  Upload,
} from 'lucide-react';
import { framesToTimecode } from '@shared/utils/timecode';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useSessionStore } from '@renderer/store/useSessionStore';
import { useTransport } from '@renderer/hooks/useTransport';
import { projectContentLength } from '@renderer/components/Timeline/timelineOps';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { motionQuiet, motionReduced } from '@renderer/motion/environment';
import { EASE_EXIT, EXIT_MS, SPRINGS } from '@renderer/motion/tokens.generated';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { PanelSlot } from '@renderer/components/Layout/PanelSlot';
import { useCompositor } from './useCompositor';
import { ViewportControls } from './ViewportControls';
import { ScopesPanel } from './ScopesPanel';
import { CompareCurtain } from './CompareCurtain';
import { ZoomZoneOverlay } from './ZoomZoneOverlay';
import { TrackBoxOverlay } from './TrackBoxOverlay';
import { MulticamBar } from './MulticamBar';
import { usePreviewQuality } from './previewQuality';
import { PREVIEW_QUALITIES, type PreviewQuality } from '@renderer/engine/previewSize';
import { DetachButton } from '@renderer/components/Layout/DetachButton';
import { useWorkspaceStore } from '@renderer/store/useWorkspaceStore';
import { MENU_IMPORT_EVENT } from '@renderer/components/MediaLibrary/MediaLibrary';

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

/** Whether the video scopes were left open, kept across sessions. */
const SCOPES_OPEN_KEY = 'scf.scopesOpen';

export function PreviewViewport(): JSX.Element {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { error } = useCompositor(canvasRef);
  const transport = useTransport();

  const project = useProjectStore((state) => state.project);
  const ui = useProjectStore((state) => state.ui);
  const setUi = useProjectStore((state) => state.setUi);
  const previewQuality = usePreviewQuality((state) => state.quality);
  const setPreviewQuality = usePreviewQuality((state) => state.setQuality);
  const projectName = useSessionStore((state) => state.projectName);
  const [zoom, setZoom] = useState<Zoom>('fit');

  /*
    The video scopes, beside the picture (Final Cut's layout): the viewer
    splits, scopes on the left, picture on the right, next to the inspector
    where the colour is changed. Not in the full-screen viewer, which is for
    watching.
  */
  const [scopesOpen, setScopesOpenState] = useState(() => {
    try {
      return window.localStorage.getItem(SCOPES_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setScopesOpen = (open: boolean): void => {
    setScopesOpenState(open);
    try {
      window.localStorage.setItem(SCOPES_OPEN_KEY, open ? '1' : '0');
    } catch {
      // Kept for this session only.
    }
  };

  const length = useMemo(() => projectContentLength(project), [project]);
  // The viewer and the timeline in different windows: this one needs a way along the edit of its own.
  const apart = useWorkspaceStore((state) => state.detached.timeline || state.detached.viewer);
  const timecode = framesToTimecode(project.currentFrame, project.fps);
  const duration = framesToTimecode(length, project.fps);
  const fullscreen = ui.fullscreenViewer;
  const sectionRef = useRef<HTMLElement>(null);

  // The full-screen viewer takes the screen, not just the window, as Final
  // Cut's Play Full Screen and Resolve's Cinema Viewer do. The screen it is
  // on: a viewer moved to its own window on a second monitor fills that
  // monitor, and the editor stays where it is.
  useEffect(() => {
    const view = sectionRef.current?.ownerDocument.defaultView ?? window;
    if (view !== window) {
      const page = view.document;
      if (fullscreen && !page.fullscreenElement) void page.documentElement.requestFullscreen().catch(() => undefined);
      if (!fullscreen && page.fullscreenElement) void page.exitFullscreen().catch(() => undefined);
      // Left with Escape, which the window handles itself: the viewer follows.
      const left = (): void => {
        if (!page.fullscreenElement && useProjectStore.getState().ui.fullscreenViewer) setUi({ fullscreenViewer: false });
      };
      page.addEventListener('fullscreenchange', left);
      return () => page.removeEventListener('fullscreenchange', left);
    }
    if (!hasNativeBridge()) return undefined;
    window.filmora.setWindowFullScreen(fullscreen);
    return undefined;
  }, [fullscreen, setUi]);

  /*
    Going full screen, paused, the viewer grows out of where it sat in the
    editor, and shrinks back into it on the way out (FLIP: the layout changes
    at once, a transform runs from the old box to the new one). Going in is
    the standard spring; coming back is an exit, 120 ms, so the editor is
    back at once. Playing, it is instant: the picture is what is being
    watched.
  */
  const dockedBox = useRef<DOMRect | null>(null);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || fullscreen) return undefined;
    const observer = new ResizeObserver(() => {
      dockedBox.current = section.getBoundingClientRect();
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, [fullscreen]);
  const firstLayout = useRef(true);
  useLayoutEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    const section = sectionRef.current;
    const docked = dockedBox.current;
    if (!section || !docked || useProjectStore.getState().ui.isPlaying || motionQuiet() || motionReduced()) return;
    const view = section.ownerDocument.defaultView ?? window;
    const whole = new DOMRect(0, 0, view.innerWidth, view.innerHeight);
    const from = fullscreen ? docked : whole;
    const to = section.getBoundingClientRect();
    if (to.width === 0 || to.height === 0) return;
    const start = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
    section.style.transformOrigin = 'top left';
    const duration = fullscreen ? SPRINGS.standard.settleMs : EXIT_MS;
    section.animate([{ transform: start }, { transform: 'none' }], {
      duration,
      easing: fullscreen ? SPRINGS.standard.easing : EASE_EXIT,
    });
    // Shrinking back, it passes over the panels around it.
    if (!fullscreen) {
      section.style.zIndex = '60';
      section.style.position = 'relative';
      window.setTimeout(() => {
        section.style.zIndex = '';
        section.style.position = '';
      }, duration);
    }
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
    // The window the viewer is in, which may be its own on another screen.
    const view = sectionRef.current?.ownerDocument.defaultView ?? window;
    view.addEventListener('pointermove', wake);
    view.addEventListener('pointerdown', wake);
    view.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      view.removeEventListener('pointermove', wake);
      view.removeEventListener('pointerdown', wake);
      view.removeEventListener('keydown', wake);
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
        data-testid="viewer-loop"
        aria-pressed={ui.loopPlayback}
        className={`tool-button w-7 px-0 ${ui.loopPlayback ? 'tool-button-active' : ''}`}
        onClick={() => setUi({ loopPlayback: !ui.loopPlayback })}
        {...tip(t('viewer.loop'), { shortcut: 'Ctrl+/', hint: t('viewer.loopHint') })}
      >
        <Repeat size={16} />
      </button>
      <button
        type="button"
        data-testid="toggle-safe-areas"
        aria-pressed={ui.showSafeAreas}
        className={`tool-button w-7 px-0 ${ui.showSafeAreas ? 'tool-button-active' : ''}`}
        onClick={() => setUi({ showSafeAreas: !ui.showSafeAreas })}
        {...tip(t('viewer.safeAreas'))}
      >
        <Frame size={16} />
      </button>
    </div>
  );

  const timecodes = (
    // Where the playhead is, over how long the edit runs - read as "1:10 of 6:00",
    // the way every player shows it, rather than two times side by side.
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span data-testid="viewer-timecode" className="timecode text-base font-semibold text-slate-100" title={t('viewer.positionHint')}>
        {timecode}
      </span>
      <span aria-hidden className="text-xs text-slate-400">
        /
      </span>
      <span data-testid="viewer-length" className="timecode truncate text-xs text-slate-400" title={t('viewer.lengthHint')}>
        {duration}
      </span>
    </span>
  );

  return (
    <section
      ref={sectionRef}
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
          {/* In a viewer window made very narrow, the name would be cut to a
              letter beside Windows' caption buttons; the window's own title
              still names it there. */}
          <span className="min-w-0 flex-1 truncate max-[479px]:invisible" title={projectName}>
            {projectName}
          </span>
          <div className="flex shrink-0 items-center gap-1 font-normal">
            <DetachButton panel="viewer" />
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
            {/* Playback resolution, as Resolve and Premiere have it: lighter while playing, never in an export. */}
            <label className="sr-only" htmlFor="viewer-quality">
              {t('viewer.quality')}
            </label>
            <select
              id="viewer-quality"
              data-testid="viewer-quality"
              className="numeric-input h-control-dense w-[66px] text-2xs"
              value={previewQuality}
              onChange={(event) => setPreviewQuality(event.target.value as PreviewQuality)}
              {...tip(t('viewer.quality'), { hint: t('viewer.qualityHint'), named: false })}
            >
              {PREVIEW_QUALITIES.map((value) => (
                <option key={value} value={value}>
                  {t(`viewer.quality.${value}` as 'viewer.quality.auto')}
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
            {/* Before/after: the grade off, or a curtain across the picture. */}
            <button
              type="button"
              data-testid="viewer-bypass"
              aria-pressed={ui.gradeBypass}
              className={`tool-button tool-button-dense w-6 px-0 ${ui.gradeBypass ? 'tool-button-active' : ''}`}
              onClick={() => setUi({ gradeBypass: !ui.gradeBypass })}
              {...tip(t('viewer.bypass'), { shortcut: 'Shift+D', hint: t('viewer.bypassHint') })}
            >
              <CircleSlash2 size={14} />
            </button>
            <button
              type="button"
              data-testid="viewer-compare"
              aria-pressed={ui.compareSplit !== null}
              className={`tool-button tool-button-dense w-6 px-0 ${ui.compareSplit !== null ? 'tool-button-active' : ''}`}
              onClick={() => setUi({ compareSplit: ui.compareSplit === null ? 0.5 : null })}
              {...tip(t('viewer.compare'), { shortcut: 'Shift+W', hint: t('viewer.compareHint') })}
            >
              <SquareSplitHorizontal size={14} />
            </button>
            <button
              type="button"
              data-testid="viewer-scopes"
              aria-pressed={scopesOpen}
              className={`tool-button tool-button-dense w-6 px-0 ${scopesOpen ? 'tool-button-active' : ''}`}
              onClick={() => setScopesOpen(!scopesOpen)}
              {...tip(t('viewer.scopes'), { hint: t('viewer.scopesHint') })}
            >
              <Activity size={14} />
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

      <div className="flex min-h-0 flex-1">
      <div
        className={`flex min-h-0 min-w-0 flex-1 ${
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
            <CompareCurtain />
            {/* Aiming a zoom, from the inspector's Effects tab. */}
            {!fullscreen && <ZoomZoneOverlay />}
            {/* Marking what a clip is to follow, from the same tab. */}
            {!fullscreen && <TrackBoxOverlay />}
            {/* An empty edit: a black frame says nothing, so say how to start. */}
            {!fullscreen && Object.keys(project.clips).length === 0 && (
              <div data-testid="viewer-empty" className="scf-rise pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
                <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/5 text-slate-300 ring-1 ring-white/10">
                  <Film size={20} />
                </span>
                <p className="text-sm font-semibold text-slate-200">{t('viewer.emptyTitle')}</p>
                <p className="max-w-xs text-xs leading-relaxed text-slate-400">{t('viewer.emptyHint')}</p>
                <button
                  type="button"
                  data-testid="viewer-empty-import"
                  className="tool-button pointer-events-auto mt-1 bg-accent/15 text-accent-hover ring-1 ring-accent/40 hover:bg-accent/25"
                  onClick={() => {
                    if (hasNativeBridge()) window.filmora.appMenuInvoke('import');
                    else window.dispatchEvent(new Event(MENU_IMPORT_EVENT));
                  }}
                >
                  <Upload size={14} />
                  {t('viewer.emptyImport')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {/* After the picture in the page, so the picture's canvas stays the
          first one; drawn to its left. */}
      {scopesOpen && !fullscreen && (
        <PanelSlot edge="left" className="order-first flex min-h-0 w-[36%] min-w-[220px] max-w-[420px] shrink-0 border-r border-panel-700 bg-panel-900">
          <ScopesPanel />
        </PanelSlot>
      )}
      </div>

      {fullscreen ? (
        // Over the picture, and only while the pointer is moving.
        <footer
          data-testid="fullscreen-controls"
          data-state={controlsShown ? 'shown' : 'hidden'}
          className={`scf-autohide absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-6 pb-5 pt-12 ${
            controlsShown ? '' : 'pointer-events-none'
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
        <>
        <MulticamBar />
        {apart && (
          // A scrubber along the edit, as CapCut's and Filmora's players have: the timeline is in another window.
          <div className="shrink-0 border-t border-panel-700 bg-panel-800 px-3 pt-2">
            <input
              type="range"
              data-testid="viewer-scrubber"
              min={0}
              max={Math.max(1, length)}
              value={Math.min(project.currentFrame, Math.max(1, length))}
              onChange={(event) => transport.scrub(Number(event.target.value))}
              className="block w-full"
              style={{ '--fill': `${(Math.min(project.currentFrame, length) / Math.max(1, length)) * 100}%` } as React.CSSProperties}
              aria-label={t('viewer.playhead')}
            />
          </div>
        )}
        <footer className={`flex shrink-0 items-center justify-between gap-3 bg-panel-800 px-3 py-2 ${apart ? '' : 'border-t border-panel-700'}`}>
          <div className="min-w-0 flex-1">{timecodes}</div>
          {transportButtons}
          {/* Balances the timecode, so the transport sits in the middle. */}
          <div className="flex-1" />
        </footer>
        </>
      )}
    </section>
  );
}

export default PreviewViewport;
