import type { MediaAsset, MediaBin } from '@shared/types';
import { createId } from '@shared/utils/id';

/**
 * Bins: folders in the media library, as DaVinci Resolve's Media Pool has them.
 *
 * They organise what is already in the project - nothing on disk moves. The
 * top level is "Master" and is not a bin of its own: an asset with no bin, or
 * with a bin that no longer exists, sits there. That makes every operation
 * here safe by construction: a clip can be misfiled, never lost.
 *
 * Deleting a bin moves its clips and sub-bins up into its parent instead of
 * removing them. Resolve removes the clips with the bin; here a clip removed
 * from the library can still be on the timeline, and losing the library entry
 * would mean losing the way to find it again.
 *
 * Pure, so it is tested directly.
 */

/** Name for a new bin: "Bin 1", "Bin 2"... the first one not taken among its siblings. */
export function nextBinName(bins: readonly MediaBin[], parentId: string | null): string {
  const taken = new Set(childBins(bins, parentId).map((bin) => bin.name.toLowerCase()));
  let index = 1;
  while (taken.has(`bin ${index}`)) index += 1;
  return `Bin ${index}`;
}

/** The bins directly inside `parentId` (null for the top level), sorted by name as a person sorts. */
export function childBins(bins: readonly MediaBin[], parentId: string | null): MediaBin[] {
  return bins
    .filter((bin) => bin.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** From the top level down to `binId`, inclusive. Empty for Master or an unknown bin. */
export function binPath(bins: readonly MediaBin[], binId: string | null): MediaBin[] {
  const byId = new Map(bins.map((bin) => [bin.id, bin]));
  const path: MediaBin[] = [];
  const seen = new Set<string>();
  let current = binId ? byId.get(binId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/** `binId` and every bin inside it, at any depth. */
export function binAndDescendants(bins: readonly MediaBin[], binId: string): Set<string> {
  const found = new Set<string>([binId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const bin of bins) {
      if (bin.parentId && found.has(bin.parentId) && !found.has(bin.id)) {
        found.add(bin.id);
        grew = true;
      }
    }
  }
  return found;
}

/** The bin an asset is actually shown in: its own, or Master if that bin is gone. */
export function effectiveBinId(asset: MediaAsset, bins: readonly MediaBin[]): string | null {
  return asset.binId && bins.some((bin) => bin.id === asset.binId) ? asset.binId : null;
}

export function assetsInBin(
  assets: readonly MediaAsset[],
  bins: readonly MediaBin[],
  binId: string | null,
): MediaAsset[] {
  return assets.filter((asset) => effectiveBinId(asset, bins) === binId);
}

/** Clips in a bin including everything in its sub-bins, for the counts in the bin list. */
export function countAssetsDeep(
  assets: readonly MediaAsset[],
  bins: readonly MediaBin[],
  binId: string | null,
): number {
  if (binId === null) return assets.length;
  const inside = binAndDescendants(bins, binId);
  return assets.filter((asset) => {
    const bin = effectiveBinId(asset, bins);
    return bin !== null && inside.has(bin);
  }).length;
}

export function createBin(
  bins: readonly MediaBin[],
  parentId: string | null,
  name?: string,
): { bins: MediaBin[]; bin: MediaBin } {
  const parent = parentId && bins.some((bin) => bin.id === parentId) ? parentId : null;
  const bin: MediaBin = {
    id: createId('bin'),
    name: name?.trim() || nextBinName(bins, parent),
    parentId: parent,
  };
  return { bins: [...bins, bin], bin };
}

/** A blank name is refused rather than saved: a bin nobody can read is a bin nobody can find. */
export function renameBin(bins: readonly MediaBin[], binId: string, name: string): MediaBin[] {
  const trimmed = name.trim();
  if (!trimmed) return [...bins];
  return bins.map((bin) => (bin.id === binId ? { ...bin, name: trimmed } : bin));
}

/** Remove a bin; its clips and sub-bins move up into its parent. */
export function deleteBin(
  bins: readonly MediaBin[],
  assets: readonly MediaAsset[],
  binId: string,
): { bins: MediaBin[]; assets: MediaAsset[] } {
  const target = bins.find((bin) => bin.id === binId);
  if (!target) return { bins: [...bins], assets: [...assets] };

  return {
    bins: bins
      .filter((bin) => bin.id !== binId)
      .map((bin) => (bin.parentId === binId ? { ...bin, parentId: target.parentId } : bin)),
    assets: assets.map((asset) => (asset.binId === binId ? withBin(asset, target.parentId) : asset)),
  };
}

/** Move bins under another; a bin cannot go inside itself or its own sub-bins. */
export function moveBin(bins: readonly MediaBin[], binId: string, parentId: string | null): MediaBin[] {
  if (parentId !== null && binAndDescendants(bins, binId).has(parentId)) return [...bins];
  return bins.map((bin) => (bin.id === binId ? { ...bin, parentId } : bin));
}

function withBin(asset: MediaAsset, binId: string | null): MediaAsset {
  if (binId) return { ...asset, binId };
  const { binId: _dropped, ...rest } = asset;
  void _dropped;
  return rest;
}

export function moveAssetsToBin(
  assets: readonly MediaAsset[],
  assetIds: readonly string[],
  binId: string | null,
): MediaAsset[] {
  const moving = new Set(assetIds);
  return assets.map((asset) => (moving.has(asset.id) ? withBin(asset, binId) : asset));
}

/**
 * The bin at `segments` under `parentId`, created where missing.
 *
 * What an imported folder's subfolders become - "Add Folder and SubFolders
 * into Media Pool (Create Bins)" in Resolve. An existing bin with the same
 * name (ignoring case) is reused, so importing a folder twice does not stack
 * up copies of its structure.
 */
export function ensureBinPath(
  bins: readonly MediaBin[],
  parentId: string | null,
  segments: readonly string[],
): { bins: MediaBin[]; binId: string | null } {
  let current = [...bins];
  let at = parentId;
  for (const raw of segments) {
    const name = raw.trim();
    if (!name) continue;
    const existing = current.find(
      (bin) => bin.parentId === at && bin.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      at = existing.id;
      continue;
    }
    const created = createBin(current, at, name);
    current = created.bins;
    at = created.bin.id;
  }
  return { bins: current, binId: at };
}

/**
 * Bins from a saved file, made safe to use.
 *
 * Anything that is not a well-formed bin is dropped, a parent that does not
 * exist becomes the top level, and a loop (a bin inside itself, directly or
 * not) is broken by moving the bin that closes it to the top level.
 */
export function sanitizeBins(raw: unknown): MediaBin[] {
  if (!Array.isArray(raw)) return [];

  const seenIds = new Set<string>();
  const bins: MediaBin[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, parentId } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id || seenIds.has(id)) continue;
    if (typeof name !== 'string' || !name.trim()) continue;
    seenIds.add(id);
    bins.push({ id, name: name.trim(), parentId: typeof parentId === 'string' ? parentId : null });
  }

  const ids = new Set(bins.map((bin) => bin.id));
  const byId = new Map<string, MediaBin>();
  for (const bin of bins) {
    byId.set(bin.id, bin.parentId && ids.has(bin.parentId) && bin.parentId !== bin.id ? bin : { ...bin, parentId: null });
  }

  for (const start of byId.values()) {
    const visited = new Set<string>();
    let current: MediaBin | undefined = start;
    while (current?.parentId) {
      if (visited.has(current.id)) {
        byId.set(current.id, { ...current, parentId: null });
        break;
      }
      visited.add(current.id);
      current = byId.get(current.parentId);
    }
  }

  return [...byId.values()];
}
