import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FilePlus2,
  FolderOpen,
  Headphones,
  LayoutDashboard,
  Redo2,
  Save,
  Settings2,
  Share2,
  Undo2,
} from 'lucide-react';
import { ExportDialog } from './components/ExportDialog';
import { Inspector } from './components/Inspector';
import { Splitter } from './components/Layout/Splitter';
import { MediaLibrary } from './components/MediaLibrary';
import { Mixer } from './components/Mixer';
import { ProjectSettings } from './components/ProjectSettings';
import { PreviewViewport } from './components/PreviewViewport';
import { Timeline } from './components/Timeline';
import { useAudioPlayback } from './hooks/useAudioPlayback';
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
import { hasNativeBridge, rehydrateDocument } from './media/importMedia';
import { useHistoryStore } from './store/useHistoryStore';
import { useProjectStore } from './store/useProjectStore';
import type { ProjectDocument } from './store/types';

/** The project logo, bundled by Vite with the rest of the page. */
const LOGO_URL = new URL('./assets/logo.png', import.meta.url).href;

/**
 * Main layout: a fixed toolbar over a three-column editing row (media,
 * viewport, inspector) with the timeline docked underneath.
 *
 * Every border between them drags, as in DaVinci Resolve - see layoutSizes.ts.
 * The preview takes whatever the other panels leave.
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
  const [status, setStatus] = useState<string | null>(null);

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
  const newProject = useProjectStore((state) => state.newProject);

  const saveProject = useCallback(async () => {
    const document = useProjectStore.getState().toDocument();
    const path = await window.filmora.saveProjectAs(JSON.stringify(document, null, 2));
    setStatus(path ? `Saved to ${path}` : null);
  }, []);

  const openProject = useCallback(async () => {
    const opened = await window.filmora.openProject();
    if (!opened) return;

    try {
      const document = JSON.parse(opened.contents) as ProjectDocument;

      // Media and LUTs are re-read from disk and every clip is remapped onto
      // the fresh URLs: the ones the project was authored with died with that
      // session.
      const { assets, project } = await rehydrateDocument(
        document.assets ?? [],
        document.project,
      );
      useProjectStore.getState().loadDocument({ ...document, assets, project });

      const missing = assets.filter((asset) => asset.missing);
      setStatus(
        missing.length > 0
          ? `Opened ${opened.path} - ${missing.length} media file(s) could not be found`
          : `Opened ${opened.path}`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return (
    <div className="flex h-full flex-col gap-1.5 bg-panel-950 p-1.5">
      <header className="flex h-10 shrink-0 items-center gap-1 rounded-md border border-panel-700 bg-panel-900 px-2">
        <span className="flex items-center gap-2 px-2">
          {/* The project logo. It has its own light ground, so it sits in a
              rounded tile rather than being cut out against the dark header. */}
          <img src={LOGO_URL} alt="SCF" className="h-6 w-6 rounded-md" draggable={false} />
          <span className="text-sm font-semibold tracking-wide text-slate-100">STOOK CREATOR FILMS</span>
        </span>

        <span className="mx-1 h-5 w-px bg-panel-600" />

        <button type="button" className="tool-button" onClick={() => newProject()} title="New project">
          <FilePlus2 size={14} />
          New
        </button>
        <button
          type="button"
          className="tool-button"
          disabled={!nativeAvailable}
          onClick={() => void openProject()}
          title={nativeAvailable ? 'Open project' : 'Only available in the desktop app'}
        >
          <FolderOpen size={14} />
          Open
        </button>
        <button
          type="button"
          className="tool-button"
          disabled={!nativeAvailable}
          onClick={() => void saveProject()}
          title={nativeAvailable ? 'Save project' : 'Only available in the desktop app'}
        >
          <Save size={14} />
          Save
        </button>

        <span className="mx-1 h-5 w-px bg-panel-600" />

        <button
          type="button"
          className="tool-button"
          disabled={!canUndo}
          onClick={undo}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={14} />
          Undo
        </button>
        <button
          type="button"
          className="tool-button"
          disabled={!canRedo}
          onClick={redo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={14} />
          Redo
        </button>

        <span className="mx-1 h-5 w-px bg-panel-600" />

        <button
          type="button"
          className="tool-button"
          onClick={() => setMixerOpen(true)}
          title="Mixer - levels, pan, EQ and auto ducking"
        >
          <Headphones size={14} />
          Mixer
        </button>
        <button
          type="button"
          className="tool-button"
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

        <div className="flex-1" />

        {status && <span className="truncate px-2 text-2xs text-slate-500">{status}</span>}

        <button
          type="button"
          className="tool-button tool-button-active"
          disabled={!nativeAvailable}
          onClick={() => setExportOpen(true)}
          title={
            nativeAvailable
              ? 'Export video or sprite frames'
              : 'Exporting needs the desktop app, which bundles FFmpeg'
          }
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

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {mixerOpen && <Mixer onClose={() => setMixerOpen(false)} />}
      {settingsOpen && <ProjectSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
