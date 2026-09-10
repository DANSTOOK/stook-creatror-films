import { useCallback, useState } from 'react';
import { FilePlus2, FolderOpen, Redo2, Save, Share2, Undo2 } from 'lucide-react';
import { ExportDialog } from './components/ExportDialog';
import { Inspector } from './components/Inspector';
import { MediaLibrary } from './components/MediaLibrary';
import { PreviewViewport } from './components/PreviewViewport';
import { Timeline } from './components/Timeline';
import { useEditorShortcuts } from './hooks/useTransport';
import { useHistoryStore } from './store/useHistoryStore';
import { useProjectStore } from './store/useProjectStore';
import type { ProjectDocument } from './store/types';

/**
 * Main layout: a fixed toolbar over a three-column editing row (media,
 * viewport, inspector) with the timeline docked underneath.
 */
export default function App(): JSX.Element {
  useEditorShortcuts();

  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

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
      useProjectStore.getState().loadDocument(document);
      setStatus(`Opened ${opened.path}`);
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
        <button type="button" className="tool-button" onClick={() => void openProject()} title="Open project">
          <FolderOpen size={14} />
          Open
        </button>
        <button type="button" className="tool-button" onClick={() => void saveProject()} title="Save project">
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

        <div className="flex-1" />

        {status && <span className="truncate px-2 text-2xs text-slate-500">{status}</span>}

        <button
          type="button"
          className="tool-button tool-button-active"
          onClick={() => setExportOpen(true)}
          title="Export video or sprite frames"
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
    </div>
  );
}
