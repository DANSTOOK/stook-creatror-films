import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle,
  ArrowRightToLine,
  ChevronDown,
  ChevronRight,
  FileVideo,
  Folder,
  FolderInput,
  FolderPlus,
  FolderSymlink,
  Image as ImageIcon,
  Import,
  Library,
  Music,
  Pencil,
  Plus,
  Rows3,
  Trash2,
  Upload,
} from 'lucide-react';
import type { MediaAsset, MediaBin, MediaKind } from '@shared/types';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import {
  ACCEPT_ATTRIBUTE,
  hasNativeBridge,
  importFolderFromDialog,
  importFromDialog,
  importDroppedFiles,
  importDroppedFolders,
  importFromFiles,
  type ImportOutcome,
} from '@renderer/media/importMedia';
import { assetsInBin, binPath, childBins, countAssetsDeep } from '@renderer/media/bins';
import { useFlip } from '@renderer/motion/useFlip';
import { assetLengthSeconds } from '@renderer/media/assetLength';
import { ProxyBar } from './ProxyBar';
import { ASSET_DRAG_TYPE } from '@renderer/components/Timeline/dropPlacement';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * The media library: asset import, bins, and the transparent-asset toggle.
 *
 * Four ways in - the native dialog, a drag onto the panel or onto the timeline,
 * and the file picker - because the dialog only exists under Electron and the
 * editor has to remain usable in a plain browser.
 *
 * Bins work like DaVinci Resolve's Media Pool: a bin list with "Master" at the
 * top, imports landing in the bin being looked at, clips dragged onto a bin to
 * file them, and a folder added with its subfolders turning into bins of the
 * same names. See media/bins.ts for the rules.
 */

const KIND_ICONS: Record<MediaKind, typeof FileVideo> = {
  video: FileVideo,
  audio: Music,
  image: ImageIcon,
};

/** Indent per level in the bin list. */
const BIN_INDENT_PX = 12;

const hasAssetDrag = (event: DragEvent): boolean => event.dataTransfer.types.includes(ASSET_DRAG_TYPE);

/** File > Import media: the application menu asks the panel to run its Import. */
export const MENU_IMPORT_EVENT = 'scf:menu-import';

export function MediaLibrary(): JSX.Element {
  const assets = useProjectStore((state) => state.assets);
  const bins = useProjectStore((state) => state.bins);
  const currentBinId = useProjectStore((state) => state.currentBinId);
  // The clip a three-point edit (comma, full stop) takes its source from.
  const selectedAssetId = useProjectStore((state) => state.ui.selectedAssetId);
  const setUi = useProjectStore((state) => state.setUi);
  const project = useProjectStore((state) => state.project);
  const addAssets = useProjectStore((state) => state.addAssets);
  const removeAsset = useProjectStore((state) => state.removeAsset);
  const adoptedFrom = useProjectStore((state) => state.adoptedSettingsFrom);
  const setCurrentBin = useProjectStore((state) => state.setCurrentBin);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [renamingBinId, setRenamingBinId] = useState<string | null>(null);
  /** Bin a clip is being dragged over: `undefined` for none, `null` for Master. */
  const [dropBin, setDropBin] = useState<string | null | undefined>(undefined);
  const dragDepth = useRef(0);

  const visibleAssets = useMemo(() => assetsInBin(assets, bins, currentBinId), [assets, bins, currentBinId]);

  // Filing a clip into a bin, or switching bins, moves everything below it.
  // FLIP slides them there instead of teleporting them.
  const assetListRef = useRef<HTMLUListElement>(null);
  useFlip(assetListRef, visibleAssets.map((asset) => asset.id).join('|'));
  const subBins = useMemo(() => childBins(bins, currentBinId), [bins, currentBinId]);
  const path = useMemo(() => binPath(bins, currentBinId), [bins, currentBinId]);
  const libraryEmpty = assets.length === 0 && bins.length === 0;

  const applyOutcome = useCallback(
    (outcome: ImportOutcome) => {
      // The library keeps one entry per file, so importing the same file
      // again adds nothing. That used to happen in silence and read as the
      // app refusing the file - hence saying so.
      const known = new Set(useProjectStore.getState().assets.map((asset) => asset.uri));
      const duplicates = outcome.assets.filter((asset) => known.has(asset.uri));

      // A folder import mirrors its subfolders as bins inside the bin being
      // looked at, then shows the top one so the result is in view.
      const folders = outcome.folders;
      if (folders && Object.keys(folders).length > 0) {
        const state = useProjectStore.getState();
        const parent = state.currentBinId;
        let top: string | null = null;
        const filed = outcome.assets.map((asset) => {
          const segments = (folders[asset.id] ?? '').split('/').filter(Boolean);
          const binId = useProjectStore.getState().ensureBinPath(parent, segments);
          // Loose files dropped beside a folder have no folder of their own.
          if (segments.length > 0) top ??= useProjectStore.getState().ensureBinPath(parent, segments.slice(0, 1));
          return binId ? { ...asset, binId } : asset;
        });
        addAssets(filed, parent);
        if (top) setCurrentBin(top);
      } else {
        addAssets(outcome.assets);
      }

      if (outcome.rejected.length > 0) {
        const detail = outcome.rejected
          .map((entry) => `${entry.name} (${entry.reason})`)
          .join(', ');
        setNotice(`Could not import ${detail}`);
      } else if (duplicates.length > 0 && duplicates.length === outcome.assets.length) {
        const names = duplicates.map((asset) => asset.name).join(', ');
        setNotice(
          duplicates.length === 1
            ? `${names} is already in the library - drag it onto the timeline to use it again`
            : `Already in the library: ${names}`,
        );
      } else if (outcome.assets.length > 0) {
        setNotice(null);
      } else if (folders !== undefined || outcome.assets.length === 0) {
        setNotice(null);
      }
    },
    [addAssets, setCurrentBin],
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

  useEffect(() => {
    window.addEventListener(MENU_IMPORT_EVENT, handleImportClick);
    return () => window.removeEventListener(MENU_IMPORT_EVENT, handleImportClick);
  }, [handleImportClick]);

  const handleFolderClick = useCallback(() => {
    void runImport(() => importFolderFromDialog(project.fps));
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

      // Read it all now: the DataTransfer is emptied once the event returns.
      // A folder from Explorer arrives as an item whose entry is a directory,
      // and becomes bins the same way "Add folder and subfolders" does.
      const files: File[] = [];
      const folders: File[] = [];
      for (const item of Array.from(event.dataTransfer.items ?? [])) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file) continue;
        if (item.webkitGetAsEntry?.()?.isDirectory) folders.push(file);
        else files.push(file);
      }
      if (files.length === 0 && folders.length === 0) files.push(...Array.from(event.dataTransfer.files));
      if (files.length === 0 && folders.length === 0) return;

      // Same path as the Import dialog under Electron: a dropped file keeps
      // its location on disk, so the project reopens with it.
      void runImport(async () => {
        const [fromFiles, fromFolders] = await Promise.all([
          files.length > 0 ? importDroppedFiles(files, project.fps) : Promise.resolve<ImportOutcome>({ assets: [], rejected: [] }),
          importDroppedFolders(folders, project.fps),
        ]);
        return {
          assets: [...fromFiles.assets, ...fromFolders.assets],
          rejected: [...fromFiles.rejected, ...fromFolders.rejected],
          ...(fromFolders.folders ? { folders: fromFolders.folders } : {}),
        };
      });
    },
    [project.fps, runImport],
  );

  // "+" puts the clip at the playhead, the way Filmora does, instead of after
  // the last clip on the track - which was usually far off screen.
  const addAtPlayhead = useCallback(
    (asset: MediaAsset) => useProjectStore.getState().addAssetAtPlayhead(asset),
    [],
  );

  /* Bins -------------------------------------------------------------------- */

  const newBin = useCallback(
    (parentId: string | null) => {
      const id = useProjectStore.getState().createBin(parentId);
      // Open the parent so the new bin is visible, and name it straight away.
      if (parentId) {
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(parentId);
          return next;
        });
      }
      setRenamingBinId(id);
    },
    [],
  );

  const toggleBin = (binId: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(binId)) next.delete(binId);
      else next.add(binId);
      return next;
    });

  /** Drop target props for a bin row (null is Master). */
  const binDropProps = (binId: string | null) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!hasAssetDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setDropBin(binId);
    },
    onDragLeave: () => setDropBin(undefined),
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!hasAssetDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropBin(undefined);
      const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE);
      if (assetId) useProjectStore.getState().moveAssetsToBin([assetId], binId);
    },
  });

  const binMenu = (bin: MediaBin | null): ContextMenuItem[] =>
    bin
      ? [
          { label: 'New bin inside', icon: FolderPlus, onSelect: () => newBin(bin.id) },
          { label: 'Rename bin', icon: Pencil, onSelect: () => setRenamingBinId(bin.id) },
          { separator: true },
          {
            label: 'Delete bin (its clips move up)',
            icon: Trash2,
            danger: true,
            onSelect: () => useProjectStore.getState().deleteBin(bin.id),
          },
        ]
      : [{ label: 'New bin', icon: FolderPlus, onSelect: () => newBin(null) }];

  const renameField = (bin: MediaBin): JSX.Element => (
    <input
      autoFocus
      defaultValue={bin.name}
      aria-label="Bin name"
      className="numeric-input h-6 min-w-0 flex-1"
      onClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => {
        useProjectStore.getState().renameBin(bin.id, event.target.value);
        setRenamingBinId(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setRenamingBinId(null);
      }}
    />
  );

  const binRow = (bin: MediaBin | null, depth: number): JSX.Element => {
    const id = bin?.id ?? null;
    const selected = currentBinId === id;
    const children = childBins(bins, id);
    const open = bin ? !collapsed.has(bin.id) : true;
    const count = countAssetsDeep(assets, bins, id);
    const Icon = bin ? Folder : Library;

    return (
      <div
        key={id ?? 'master'}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={bin && children.length > 0 ? open : undefined}
        title={bin ? 'Double-click to rename, right-click for more, drop clips here to file them' : 'Everything not in a bin'}
        className={`flex h-7 cursor-pointer items-center gap-1 rounded pr-1.5 text-xs ${
          selected ? 'bg-accent/20 text-accent-hover' : 'text-slate-300 hover:bg-panel-800'
        } ${dropBin === id ? 'ring-1 ring-accent' : ''}`}
        style={{ paddingLeft: 4 + depth * BIN_INDENT_PX }}
        onClick={() => setCurrentBin(id)}
        onDoubleClick={() => bin && setRenamingBinId(bin.id)}
        onContextMenu={(event) => openMenu(event, binMenu(bin))}
        {...binDropProps(id)}
      >
        {bin && children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? `Collapse ${bin.name}` : `Expand ${bin.name}`}
            className="flex h-5 w-4 shrink-0 items-center justify-center text-slate-400 hover:text-slate-200"
            onClick={(event) => {
              event.stopPropagation();
              toggleBin(bin.id);
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <Icon size={13} className={`shrink-0 ${selected ? 'text-accent-hover' : 'text-slate-400'}`} />
        {bin && renamingBinId === bin.id ? (
          renameField(bin)
        ) : (
          <span className="min-w-0 flex-1 truncate">{bin ? bin.name : 'Master'}</span>
        )}
        <span className="shrink-0 text-2xs tabular-nums text-slate-400">{count}</span>
      </div>
    );
  };

  const binTree = (parentId: string | null, depth: number): JSX.Element[] =>
    childBins(bins, parentId).flatMap((bin) => [
      binRow(bin, depth),
      ...(collapsed.has(bin.id) ? [] : binTree(bin.id, depth + 1)),
    ]);

  /** "Move to" entries for a clip: every bin but the one it is in. */
  const moveTargets = (asset: MediaAsset): ContextMenuItem[] => {
    const all: { id: string | null; label: string }[] = [
      { id: null, label: 'Master' },
      ...bins
        .map((bin) => ({ id: bin.id, label: binPath(bins, bin.id).map((entry) => entry.name).join(' / ') }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    ];
    return all
      .filter((target) => target.id !== currentBinId)
      .map((target) => ({
        label: `Move to ${target.label}`,
        icon: FolderSymlink,
        onSelect: () => useProjectStore.getState().moveAssetsToBin([asset.id], target.id),
      }));
  };

  return (
    <aside
      data-testid="media-panel"
      className={`panel relative w-full ${dragActive ? 'ring-2 ring-accent' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="panel-header justify-between">
        <span>Media</span>
        <div className="flex items-center gap-0.5 normal-case tracking-normal">
          <button
            type="button"
            className="tool-button h-7 px-1.5"
            aria-label="New bin"
            title="New bin inside the one shown"
            onClick={() => newBin(currentBinId)}
          >
            <FolderPlus size={14} />
          </button>
          {hasNativeBridge() && (
            <button
              type="button"
              className="tool-button h-7 px-1.5"
              aria-label="Add folder and subfolders"
              title="Add a folder with its subfolders - each folder becomes a bin"
              onClick={handleFolderClick}
              disabled={busy}
            >
              <FolderInput size={14} />
            </button>
          )}
          <button
            type="button"
            className="tool-button h-7"
            onClick={handleImportClick}
            disabled={busy}
          >
            <Import size={14} />
            {busy ? 'Importing...' : 'Import'}
          </button>
        </div>
      </header>

      <ProxyBar />

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

      {!libraryEmpty && (
        <nav
          role="tree"
          aria-label="Bins"
          className="max-h-[38%] shrink-0 overflow-y-auto border-b border-panel-700 p-1.5"
        >
          {binRow(null, 0)}
          {binTree(null, 1)}
        </nav>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {libraryEmpty ? (
          <button
            type="button"
            onClick={handleImportClick}
            className="flex w-full flex-col items-center gap-2 rounded border border-dashed border-panel-600 p-6 text-center hover:border-accent hover:bg-panel-800"
          >
            <Upload size={20} className="text-slate-400" />
            <span className="text-xs text-slate-300">Drop files here</span>
            <span className="text-2xs leading-relaxed text-slate-400">
              or click to browse. Video, audio, and transparent PNG sprite sheets.
            </span>
          </button>
        ) : (
          <>
            {/* Where the list is, and where an import will land. */}
            <div className="mb-1.5 flex min-w-0 items-center gap-1 px-1 text-2xs text-slate-400">
              <button type="button" className="shrink-0 hover:text-slate-200" onClick={() => setCurrentBin(null)}>
                Master
              </button>
              {path.map((bin) => (
                <span key={bin.id} className="flex min-w-0 items-center gap-1">
                  <ChevronRight size={10} className="shrink-0" />
                  <button
                    type="button"
                    className="truncate hover:text-slate-200"
                    onClick={() => setCurrentBin(bin.id)}
                  >
                    {bin.name}
                  </button>
                </span>
              ))}
            </div>

            {subBins.map((bin) => (
              <div
                key={bin.id}
                className={`mb-1 flex cursor-pointer items-center gap-2 rounded border border-transparent px-2 py-1.5 text-xs text-slate-300 hover:border-panel-600 hover:bg-panel-800 ${
                  dropBin === bin.id ? 'ring-1 ring-accent' : ''
                }`}
                title="Open this bin - or drop clips on it to file them"
                onClick={() => setCurrentBin(bin.id)}
                onContextMenu={(event) => openMenu(event, binMenu(bin))}
                {...binDropProps(bin.id)}
              >
                <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-panel-950">
                  <Folder size={16} className="text-slate-400" />
                </span>
                <span className="min-w-0 flex-1 truncate">{bin.name}</span>
                <span className="text-2xs tabular-nums text-slate-400">{countAssetsDeep(assets, bins, bin.id)}</span>
              </div>
            ))}

            {visibleAssets.length === 0 && subBins.length === 0 && (
              <p className="px-2 py-6 text-center text-2xs leading-relaxed text-slate-400">
                This bin is empty. Import here, or drag clips onto a bin in the list above.
              </p>
            )}

            <ul ref={assetListRef} className="flex flex-col gap-1">
              {visibleAssets.map((asset) => {
                const Icon = KIND_ICONS[asset.kind];
                return (
                  <li
                    key={asset.id}
                    data-flip-key={asset.id}
                    draggable={!asset.missing}
                    title={asset.missing ? undefined : 'Drag onto the timeline or a bin, or use + to add it'}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
                      // Copy onto the timeline, move onto a bin.
                      event.dataTransfer.effectAllowed = 'copyMove';
                    }}
                    onDragEnd={() => setDropBin(undefined)}
                    onClick={() => setUi({ selectedAssetId: asset.id })}
                    aria-selected={selectedAssetId === asset.id}
                    className={`list-item group cursor-grab active:cursor-grabbing ${
                      selectedAssetId === asset.id ? 'border-accent/70 bg-panel-800' : ''
                    }`}
                    onContextMenu={(event) =>
                      openMenu(event, [
                        {
                          label: 'Add at playhead',
                          icon: Plus,
                          disabled: asset.missing,
                          onSelect: () => addAtPlayhead(asset),
                        },
                        {
                          label: 'Add to end of track',
                          icon: ArrowRightToLine,
                          disabled: asset.missing,
                          onSelect: () => useProjectStore.getState().appendAsset(asset),
                        },
                        {
                          label: 'Add on a new track',
                          icon: Rows3,
                          disabled: asset.missing,
                          onSelect: () => useProjectStore.getState().addAssetOnNewTrack(asset),
                        },
                        { separator: true },
                        ...moveTargets(asset),
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
                        <Icon size={16} className="text-slate-400" />
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-slate-200">{asset.name}</p>
                      <p className="text-2xs text-slate-400">
                        {asset.width > 0 ? `${asset.width}x${asset.height} - ` : ''}
                        {Math.round(assetLengthSeconds(asset, project.fps))}s
                        {asset.proxyUri && (
                          <span
                            className="ml-1 rounded bg-sky-900/60 px-1 text-sky-300"
                            title="Edited from a small stand-in; the export reads this file"
                          >
                            proxy
                          </span>
                        )}
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
                      title="Add at the playhead (right-click for more)"
                      className="tool-button h-7 px-1.5 opacity-0 group-hover:opacity-100"
                      disabled={asset.missing}
                      onClick={() => addAtPlayhead(asset)}
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
          </>
        )}
      </div>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-panel-950/80">
          <span className="rounded border border-accent px-3 py-2 text-xs text-accent-hover">
            Drop to import{path.length > 0 ? ` into ${path[path.length - 1].name}` : ''}
          </span>
        </div>
      )}

      {/*
        The transparent-background switch used to sit here. It is a property
        of the sequence - it decides what gets rendered - so it belongs with
        the frame rate and the resolution in Project settings, which is where
        Premiere keeps its equivalent. The media panel is for files.
      */}

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </aside>
  );
}

export default MediaLibrary;
