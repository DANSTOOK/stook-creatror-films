import { useCallback, useEffect, useState } from 'react';
import {
  FilePlus2,
  FolderOpen,
  Headphones,
  Redo2,
  Save,
  Settings2,
  Share2,
  Undo2,
} from 'lucide-react';
import { ExportDialog } from './components/ExportDialog';
import { Inspector } from './components/Inspector';
import { MediaLibrary } from './components/MediaLibrary';
import { Mixer } from './components/Mixer';
import { ProjectSettings } from './components/ProjectSettings';
import { PreviewViewport } from './components/PreviewViewport';
import { Timeline } from './components/Timeline';
import { useAudioPlayback } from './hooks/useAudioPlayback';
import { useEditorShortcuts, usePlaybackClock } from './hooks/useTransport';
import { hasNativeBridge, rehydrateDocument } from './media/importMedia';
import { useHistoryStore } from './store/useHistoryStore';
import { useProjectStore } from './store/useProjectStore';
import type { ProjectDocument } from './store/types';

/**
 * Main layout: a fixed toolbar over a three-column editing row (media,
 * viewport, inspector) with the timeline docked underneath.
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
        <span className="px-2 text-sm font-semibold tracking-tight text-slate-200">
          Filmora Engine
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

      <main className="flex min-h-0 flex-1 gap-1.5">
        <MediaLibrary />
        <PreviewViewport />
        <Inspector />
      </main>

      <div className="h-[300px] shrink-0">
        <Timeline />
      </div>

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {mixerOpen && <Mixer onClose={() => setMixerOpen(false)} />}
      {settingsOpen && <ProjectSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
