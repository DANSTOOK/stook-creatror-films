import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FilePlus2,
  FolderOpen,
  Headphones,
  Home as HomeIcon,
  LayoutDashboard,
  Redo2,
  Save,
  Settings2,
  Share2,
  Undo2,
} from 'lucide-react';
import { ExportDialog } from './components/ExportDialog';
import { Home } from './components/Home/Home';
import { Inspector } from './components/Inspector';
import { Splitter } from './components/Layout/Splitter';
import { MediaLibrary } from './components/MediaLibrary';
import { Mixer } from './components/Mixer';
import { ProjectSettings } from './components/ProjectSettings';
import { PreviewViewport } from './components/PreviewViewport';
import { Timeline } from './components/Timeline';
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog/UnsavedChangesDialog';
import { useAudioPlayback } from './hooks/useAudioPlayback';
import { usePresence } from './hooks/usePresence';
import { useEditorShortcuts, usePlaybackClock } from './hooks/useTransport';
import {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  clampLayout,
  loadLayout,
  resizePanel,
  saveLayout,
  type LayoutKey,
  type PanelLayout,
} from './layout/layoutSizes';
import { hasNativeBridge } from './media/importMedia';
import { useProjectActions } from './project/useProjectActions';
import { useHistoryStore } from './store/useHistoryStore';
import { useProjectStore } from './store/useProjectStore';
import { useIsDirty, useSessionStore } from './store/useSessionStore';

/** The project logo, bundled by Vite with the rest of the page. */
const LOGO_URL = new URL('./assets/logo.png', import.meta.url).href;
const APP_TITLE = 'STOOK CREATOR FILMS';

/**
 * Main layout: the start screen, or a fixed toolbar over a three-column
 * editing row (media, viewport, inspector) with the timeline docked underneath.
 *
 * Every border between them drags, as in DaVinci Resolve - see layoutSizes.ts.
 * The preview takes whatever the other panels leave.
 *
 * The start screen covers the editor rather than replacing it: the preview's
 * GPU context, the decoders and the audio graph stay alive across a trip
 * home, so coming back or opening the next project does not rebuild them.
 */
export default function App(): JSX.Element {
  // The clock advances the playhead and must exist exactly once in the tree.
  usePlaybackClock();
  useEditorShortcuts();
  useAudioPlayback();

  // Swallow drops that land outside a drop zone. Chromium's default is to open
  // the dropped file in the window - the whole editor replaced by a video
  // player, with every unsaved edit gone. Zones that accept drops cancel the
  // event first; anything still uncancelled here gets the "not allowed" cursor
  // and no default action. The main process blocks navigation as a backstop.
  useEffect(() => {
    const refuse = (event: DragEvent): void => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);

  const [exportOpen, setExportOpen] = useState(false);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const exportPresence = usePresence(exportOpen);
  const mixerPresence = usePresence(mixerOpen);
  const settingsPresence = usePresence(settingsOpen);
  const [status, setStatus] = useState<string | null>(null);

  /* Session ----------------------------------------------------------------- */

  const view = useSessionStore((state) => state.view);
  const projectName = useSessionStore((state) => state.projectName);
  const projectPath = useSessionStore((state) => state.projectPath);
  const dirty = useIsDirty();
  const actions = useProjectActions(setStatus);

  // The window title names the project, as editors do; the start screen keeps
  // the plain app name.
  useEffect(() => {
    document.title = view === 'editor' && projectPath ? `${dirty ? '* ' : ''}${projectName} - ${APP_TITLE}` : APP_TITLE;
  }, [view, projectPath, projectName, dirty]);

  // The main process asks before closing a window with unsaved changes.
  useEffect(() => {
    if (!hasNativeBridge()) return;
    window.filmora.documentState({ dirty: view === 'editor' && dirty, name: projectName });
  }, [dirty, projectName, view]);

  useEffect(() => {
    if (!hasNativeBridge()) return undefined;
    return window.filmora.onSaveBeforeClose(() => {
      void actions.save(false).then((saved) => {
        if (saved) void window.filmora.closeAfterSave();
      });
    });
  }, [actions]);

  // Project shortcuts. Registered in the capture phase so Ctrl+S saves instead
  // of also reaching the editor's plain S (snapping).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      let run: (() => void) | null = null;
      if (key === 's' && view === 'editor') run = () => void actions.save(event.shiftKey);
      else if (key === 'o' && !event.shiftKey) run = () => void actions.openFromDialog();
      if (!run) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!useSessionStore.getState().unsavedPrompt) run();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [actions, view]);

  // Escape closes the mixer and project settings, like any dialog. Export is
  // left to its own buttons: Escape must not be a way to lose a render.
  useEffect(() => {
    if (!mixerOpen && !settingsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || useSessionStore.getState().unsavedPrompt) return;
      event.preventDefault();
      if (settingsOpen) setSettingsOpen(false);
      else setMixerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mixerOpen, settingsOpen]);

  // Behind the start screen the editor is inert: no focus, no clicks, no screen reader.
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    element.toggleAttribute('inert', view !== 'editor');
    if (view !== 'editor') useProjectStore.getState().setPlaying(false);
  }, [view]);

  /* Panel sizes ------------------------------------------------------------- */

  const workspaceRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ width: 0, height: 0 });
  const [layout, setLayout] = useState<PanelLayout>(loadLayout);
  // Sizes are fitted to the window on every render rather than stored fitted,
  // so shrinking the window and growing it back returns the panels to the
  // sizes that were chosen.
  const fitted = clampLayout(layout, space);
  const dragOrigin = useRef<PanelLayout>(fitted);
  const latest = useRef<PanelLayout>(layout);
  latest.current = layout;

  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSpace({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const commitLayout = useCallback((next: PanelLayout) => {
    setLayout(next);
    saveLayout(next);
  }, []);

  /**
   * A border for one panel. `grows` says which way the pointer has to move for
   * the panel to get bigger: right for the media panel, left for the
   * inspector, up for the timeline.
   */
  const border = (key: LayoutKey, label: string, orientation: 'vertical' | 'horizontal', grows: 1 | -1): JSX.Element => (
    <Splitter
      orientation={orientation}
      label={label}
      value={fitted[key]}
      min={LAYOUT_LIMITS[key].min}
      max={LAYOUT_LIMITS[key].max}
      onDragStart={() => {
        dragOrigin.current = fitted;
      }}
      onDrag={(offset) => setLayout(resizePanel(dragOrigin.current, key, grows * offset, space))}
      onDragEnd={() => saveLayout(latest.current)}
      onStep={(offset) => commitLayout(resizePanel(fitted, key, grows * offset, space))}
      onReset={() => commitLayout(clampLayout({ ...fitted, [key]: DEFAULT_LAYOUT[key] }, space))}
    />
  );

  // Saving, opening and exporting all go through the native bridge, so those
  // controls are disabled rather than throwing when running in a browser.
  const nativeAvailable = hasNativeBridge();

  const canUndo = useHistoryStore((state) => state.canUndo);
  const canRedo = useHistoryStore((state) => state.canRedo);
  const undo = useProjectStore((state) => state.undo);
  const redo = useProjectStore((state) => state.redo);

  const desktopOnly = (title: string): string => (nativeAvailable ? title : 'Only available in the desktop app');

  return (
    <div className="relative h-full">
      <div ref={editorRef} aria-hidden={view !== 'editor'} className="flex h-full flex-col gap-1.5 bg-panel-950 p-1.5">
        <header className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-panel-700 bg-panel-900 px-2 shadow-md shadow-black/30">
          <button
            type="button"
            className="group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-panel-800"
            onClick={() => void actions.goHome()}
            title="Back to the start screen"
            aria-label="Home"
          >
            {/* The project logo. It has its own light ground, so it sits in a
                rounded tile rather than being cut out against the dark header. */}
            <img
              src={LOGO_URL}
              alt="SCF"
              className="h-6 w-6 rounded-md transition-transform duration-200 group-hover:scale-110"
              draggable={false}
            />
            <HomeIcon size={13} className="text-slate-500 transition-colors duration-150 group-hover:text-slate-200" />
          </button>

          <div className="toolbar-group">
            <button type="button" className="tool-button" onClick={() => void actions.newBlank()} title="New blank project">
              <FilePlus2 size={14} />
              New
            </button>
            <button
              type="button"
              className="tool-button"
              disabled={!nativeAvailable}
              onClick={() => void actions.openFromDialog()}
              title={desktopOnly('Open project (Ctrl+O)')}
            >
              <FolderOpen size={14} />
              Open
            </button>
            <button
              type="button"
              className="tool-button"
              disabled={!nativeAvailable}
              onClick={() => void actions.save(false)}
              title={desktopOnly('Save project (Ctrl+S) - Save as: Ctrl+Shift+S')}
            >
              <Save size={14} />
              Save
            </button>
          </div>

          <div className="toolbar-group">
            <button type="button" className="tool-button" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
              <Undo2 size={14} />
              Undo
            </button>
            <button type="button" className="tool-button" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Shift+Z)">
              <Redo2 size={14} />
              Redo
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              className={`tool-button ${mixerOpen ? 'tool-button-active' : ''}`}
              onClick={() => setMixerOpen(true)}
              title="Mixer - levels, pan, EQ and auto ducking"
            >
              <Headphones size={14} />
              Mixer
            </button>
            <button
              type="button"
              className={`tool-button ${settingsOpen ? 'tool-button-active' : ''}`}
              onClick={() => setSettingsOpen(true)}
              title="Project settings - frame rate, resolution and duration"
            >
              <Settings2 size={14} />
              Settings
            </button>
            <button
              type="button"
              className="tool-button"
              onClick={() => commitLayout({ ...DEFAULT_LAYOUT })}
              title="Put every panel back to its default size (double-click one border to reset just that panel)"
            >
              <LayoutDashboard size={14} />
              Reset layout
            </button>
          </div>

          {/* The open project, and whether it has unsaved changes. */}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-3" title={projectPath ?? 'Not saved yet'}>
            <span data-testid="project-name" className="truncate text-xs font-medium text-slate-200">
              {projectName}
            </span>
            {dirty && (
              <span
                data-testid="unsaved-indicator"
                className="scf-dirty-dot h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                title="Unsaved changes"
              />
            )}
          </div>

          {status && (
            <span key={status} className="scf-view max-w-[34%] truncate px-2 text-2xs text-slate-500" title={status}>
              {status}
            </span>
          )}

          <button
            type="button"
            className="tool-button tool-button-active px-3.5"
            disabled={!nativeAvailable}
            onClick={() => setExportOpen(true)}
            title={nativeAvailable ? 'Export video or sprite frames' : 'Exporting needs the desktop app, which bundles FFmpeg'}
          >
            <Share2 size={14} />
            Export
          </button>
        </header>

        <div ref={workspaceRef} className="flex min-h-0 flex-1 flex-col">
          <main className="flex min-h-0 flex-1">
            <div className="flex min-h-0 shrink-0" style={{ width: fitted.mediaWidth }}>
              <MediaLibrary />
            </div>
            {border('mediaWidth', 'Resize the media panel', 'vertical', 1)}
            <PreviewViewport />
            {border('inspectorWidth', 'Resize the inspector', 'vertical', -1)}
            <div className="flex min-h-0 shrink-0" style={{ width: fitted.inspectorWidth }}>
              <Inspector />
            </div>
          </main>

          {border('timelineHeight', 'Resize the timeline', 'horizontal', -1)}

          <div className="shrink-0" style={{ height: fitted.timelineHeight }}>
            <Timeline />
          </div>
        </div>

        {exportPresence.mounted && <ExportDialog closing={exportPresence.closing} onClose={() => setExportOpen(false)} />}
        {mixerPresence.mounted && <Mixer closing={mixerPresence.closing} onClose={() => setMixerOpen(false)} />}
        {settingsPresence.mounted && (
          <ProjectSettings closing={settingsPresence.closing} onClose={() => setSettingsOpen(false)} />
        )}
      </div>

      {/* The swap itself is a view transition (motion/viewTransition.ts), so this
          is a plain switch: the browser cross-fades the two states for us. */}
      {view === 'home' && (
        <div className="absolute inset-0 z-40">
          <Home
            status={status}
            onBlank={() => void actions.newBlank()}
            onCreate={actions.createProject}
            onOpenDialog={() => void actions.openFromDialog()}
            onOpenRecent={(path) => void actions.openRecent(path)}
          />
        </div>
      )}

      <UnsavedChangesDialog />
    </div>
  );
}
