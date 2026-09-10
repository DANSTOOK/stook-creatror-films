import { useCallback, useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, FileVideo, Image as ImageIcon, Import, Music, Plus, Trash2, Upload } from 'lucide-react';
import type { MediaAsset, MediaKind } from '@shared/types';
import { ContextMenu, useContextMenu } from '@renderer/components/ContextMenu';
import {
  ACCEPT_ATTRIBUTE,
  appendPosition,
  hasNativeBridge,
  importFromDialog,
  importFromFiles,
  type ImportOutcome,
} from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Asset import and the transparent-asset toggle.
 *
 * Three ways in - the native dialog, a drag onto the panel, and the file picker
 * - because the dialog only exists under Electron and the editor has to remain
 * usable in a plain browser.
 */

const KIND_ICONS: Record<MediaKind, typeof FileVideo> = {
  video: FileVideo,
  audio: Music,
  image: ImageIcon,
};

export function MediaLibrary(): JSX.Element {
  const assets = useProjectStore((state) => state.assets);
  const project = useProjectStore((state) => state.project);
  const addAssets = useProjectStore((state) => state.addAssets);
  const removeAsset = useProjectStore((state) => state.removeAsset);
  const addAssetToTimeline = useProjectStore((state) => state.addAssetToTimeline);
  const adoptedFrom = useProjectStore((state) => state.adoptedSettingsFrom);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dragDepth = useRef(0);

  const applyOutcome = useCallback(
    (outcome: ImportOutcome) => {
      addAssets(outcome.assets);

      if (outcome.rejected.length > 0) {
        const detail = outcome.rejected
          .map((entry) => `${entry.name} (${entry.reason})`)
          .join(', ');
        setNotice(`Could not import ${detail}`);
      } else if (outcome.assets.length > 0) {
        setNotice(null);
      }
    },
    [addAssets],
  );

  const runImport = useCallback(
    async (task: () => Promise<ImportOutcome>) => {
      setBusy(true);
      try {
        applyOutcome(await task());
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [applyOutcome],
  );

  /** Native dialog under Electron, file picker everywhere else. */
  const handleImportClick = useCallback(() => {
    if (hasNativeBridge()) {
      void runImport(() => importFromDialog(project.fps));
      return;
    }
    fileInputRef.current?.click();
  }, [project.fps, runImport]);

  const handleFileInput = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      void runImport(() => importFromFiles(Array.from(files), project.fps));
    },
    [project.fps, runImport],
  );

  // Drag tracking uses a depth counter: dragenter/dragleave fire for every
  // child element, so a naive boolean flickers as the pointer moves inside.
  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    if (event.dataTransfer.types.includes('Files')) setDragActive(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      void runImport(() => importFromFiles(files, project.fps));
    },
    [project.fps, runImport],
  );

  const appendToTimeline = useCallback(
    (asset: MediaAsset) => {
      const wantedType = asset.kind === 'audio' ? 'audio' : 'video';
      const track =
        project.tracks.find((candidate) => candidate.type === wantedType && !candidate.locked) ??
        project.tracks[0];
      if (!track) return;

      addAssetToTimeline(asset, track.id, appendPosition(project, track.id));
    },
    [addAssetToTimeline, project],
  );

  return (
    <aside
      className={`panel w-[260px] shrink-0 relative ${dragActive ? 'ring-2 ring-accent' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="panel-header justify-between">
        <span>Media</span>
        <button
          type="button"
          className="tool-button normal-case tracking-normal"
          onClick={handleImportClick}
          disabled={busy}
        >
          <Import size={14} />
          {busy ? 'Importing...' : 'Import'}
        </button>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => {
          handleFileInput(event.target.files);
          // Reset so picking the same file twice still fires a change event.
          event.target.value = '';
        }}
      />

      {notice && (
        <p className="flex items-start gap-1.5 border-b border-panel-700 bg-amber-950/40 px-3 py-2 text-2xs text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {notice}
        </p>
      )}

      {adoptedFrom && (
        <p className="border-b border-panel-700 bg-panel-800 px-3 py-2 text-2xs text-slate-400">
          Project set to {project.width}x{project.height} @ {project.fps} fps from{' '}
          <span className="text-slate-300">{adoptedFrom}</span>.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {assets.length === 0 ? (
          <button
            type="button"
            onClick={handleImportClick}
            className="flex w-full flex-col items-center gap-2 rounded border border-dashed border-panel-600 p-6 text-center hover:border-accent hover:bg-panel-800"
          >
            <Upload size={20} className="text-slate-500" />
            <span className="text-xs text-slate-300">Drop files here</span>
            <span className="text-2xs leading-relaxed text-slate-500">
              or click to browse. Video, audio, and transparent PNG sprite sheets.
            </span>
          </button>
        ) : (
          <ul className="flex flex-col gap-1">
            {assets.map((asset) => {
              const Icon = KIND_ICONS[asset.kind];
              return (
                <li
                  key={asset.id}
                  className="group flex items-center gap-2 rounded border border-transparent px-2 py-2 hover:border-panel-600 hover:bg-panel-800"
                  onContextMenu={(event) =>
                    openMenu(event, [
                      {
                        label: 'Add to timeline',
                        icon: Plus,
                        disabled: asset.missing,
                        onSelect: () => appendToTimeline(asset),
                      },
                      { separator: true },
                      {
                        label: 'Remove from library',
                        icon: Trash2,
                        danger: true,
                        onSelect: () => removeAsset(asset.id),
                      },
                    ])
                  }
                >
                  {asset.thumbnailUri ? (
                    <img
                      src={asset.thumbnailUri}
                      alt=""
                      className="h-8 w-12 shrink-0 rounded object-cover alpha-checkerboard"
                    />
                  ) : (
                    <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-panel-950">
                      <Icon size={16} className="text-slate-500" />
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-slate-200">{asset.name}</p>
                    <p className="text-2xs text-slate-500">
                      {asset.width > 0 ? `${asset.width}x${asset.height} - ` : ''}
                      {Math.round(asset.durationFrames / project.fps)}s
                      {asset.hasAlphaChannel && (
                        <span className="ml-1 rounded bg-emerald-900/60 px-1 text-emerald-300">
                          alpha
                        </span>
                      )}
                      {asset.missing && (
                        <span className="ml-1 rounded bg-red-900/60 px-1 text-red-300">
                          missing
                        </span>
                      )}
                    </p>
                  </div>

                  <button
                    type="button"
                    title="Add to timeline"
                    className="tool-button h-7 px-1.5 opacity-0 group-hover:opacity-100"
                    disabled={asset.missing}
                    onClick={() => appendToTimeline(asset)}
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    type="button"
                    title="Remove from library"
                    className="tool-button h-7 px-1.5 opacity-0 hover:text-red-400 group-hover:opacity-100"
                    onClick={() => removeAsset(asset.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-panel-950/80">
          <span className="rounded border border-accent px-3 py-2 text-xs text-accent-hover">
            Drop to import
          </span>
        </div>
      )}

      <footer className="border-t border-panel-700 px-3 py-2">
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            className="accent-blue-500"
            checked={project.hasAlphaBackground}
            onChange={(event) => {
              const enabled = event.target.checked;
              // Also reveal it in the viewport. The canvas is always cleared
              // transparent, so without this the switch had no visible effect
              // at all and only quietly changed an export default.
              useProjectStore.getState().setProjectSettings({ hasAlphaBackground: enabled });
              useProjectStore.getState().setUi({ showTransparencyGrid: enabled });
            }}
          />
          Transparent background
        </label>
        <p className="mt-1 text-2xs leading-relaxed text-slate-600">
          Shows the transparency checkerboard in the viewport and turns on
          &ldquo;Export alpha channel&rdquo; by default, for sprites and UI
          elements headed to a game engine.
        </p>
      </footer>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </aside>
  );
}

export default MediaLibrary;
