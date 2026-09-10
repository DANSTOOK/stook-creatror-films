import { useCallback, useState } from 'react';
import { FileVideo, Image as ImageIcon, Import, Music, Plus, Trash2 } from 'lucide-react';
import type { MediaAsset, MediaKind } from '@shared/types';
import { createId } from '@shared/utils/id';
import { probeMediaElement } from '@renderer/engine/probeMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Asset import and the transparent-asset toggle.
 *
 * Imported files are read through the IPC bridge and handed to the renderer as
 * blob URLs, so no `file://` path is ever loaded directly by the page.
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

  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const importMedia = useCallback(async () => {
    setBusy(true);
    setImportError(null);

    try {
      const files = await window.filmora.openMedia();
      const imported: MediaAsset[] = [];

      for (const file of files) {
        const [buffer, probe] = await Promise.all([
          window.filmora.readFile(file.path),
          // ffprobe is optional (ffmpeg-static does not ship it), so a failure
          // here must not stop the import.
          window.filmora.probeMedia(file.path).catch(() => null),
        ]);

        const uri = URL.createObjectURL(new Blob([buffer]));

        // The browser decoder is the authoritative source for duration and
        // dimensions; ffprobe only fills in what it happens to know.
        const decoded = await probeMediaElement(uri, file.kind);

        const durationSeconds = decoded.durationSeconds || probe?.durationSeconds || 0;
        const durationFrames =
          file.kind === 'image'
            ? project.fps * 5 // Stills default to a five second clip.
            : Math.max(1, Math.round(durationSeconds * project.fps));

        imported.push({
          id: createId('asset'),
          name: file.name,
          uri,
          kind: file.kind,
          durationFrames,
          width: decoded.width || probe?.width || 0,
          height: decoded.height || probe?.height || 0,
          hasAlphaChannel: decoded.hasAlphaChannel || probe?.hasAlphaChannel === true,
        });
      }

      addAssets(imported);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [addAssets, project.fps]);

  const appendToTimeline = useCallback(
    (asset: MediaAsset) => {
      const wantedType = asset.kind === 'audio' ? 'audio' : 'video';
      const track =
        project.tracks.find((candidate) => candidate.type === wantedType && !candidate.locked) ??
        project.tracks[0];
      if (!track) return;

      // Append after the last clip already on that track.
      const end = Object.values(project.clips)
        .filter((clip) => clip.trackId === track.id)
        .reduce((longest, clip) => Math.max(longest, clip.startFrame + clip.durationFrames), 0);

      addAssetToTimeline(asset, track.id, end);
    },
    [addAssetToTimeline, project.clips, project.tracks],
  );

  return (
    <aside className="panel w-[260px] shrink-0">
      <header className="panel-header justify-between">
        <span>Media</span>
        <button
          type="button"
          className="tool-button normal-case tracking-normal"
          onClick={() => void importMedia()}
          disabled={busy}
        >
          <Import size={14} />
          {busy ? 'Importing...' : 'Import'}
        </button>
      </header>

      {importError && (
        <p className="border-b border-panel-700 bg-red-950/40 px-3 py-2 text-2xs text-red-300">
          {importError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {assets.length === 0 ? (
          <p className="p-3 text-xs leading-relaxed text-slate-500">
            No media yet. Import video, audio, or transparent PNG sprite sheets to
            get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {assets.map((asset) => {
              const Icon = KIND_ICONS[asset.kind];
              return (
                <li
                  key={asset.id}
                  className="group flex items-center gap-2 rounded border border-transparent px-2 py-2 hover:border-panel-600 hover:bg-panel-800"
                >
                  <Icon size={16} className="shrink-0 text-slate-500" />

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
                    </p>
                  </div>

                  <button
                    type="button"
                    title="Add to timeline"
                    className="tool-button h-7 px-1.5 opacity-0 group-hover:opacity-100"
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

      <footer className="border-t border-panel-700 px-3 py-2">
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            className="accent-blue-500"
            checked={project.hasAlphaBackground}
            onChange={(event) =>
              useProjectStore
                .getState()
                .setProjectSettings({ hasAlphaBackground: event.target.checked })
            }
          />
          Transparent background
        </label>
        <p className="mt-1 text-2xs leading-relaxed text-slate-600">
          Keeps the project canvas transparent so sprites and UI elements export
          straight to a game engine.
        </p>
      </footer>
    </aside>
  );
}

export default MediaLibrary;
