import { describe, expect, it } from 'vitest';
import type { MediaAsset, MediaBin } from '../src/shared/types';
import {
  assetsInBin,
  binPath,
  childBins,
  countAssetsDeep,
  createBin,
  deleteBin,
  ensureBinPath,
  moveAssetsToBin,
  moveBin,
  nextBinName,
  renameBin,
  sanitizeBins,
} from '../src/renderer/media/bins';

const asset = (id: string, binId?: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  uri: `media://file/${id}`,
  kind: 'video',
  durationFrames: 30,
  width: 1920,
  height: 1080,
  hasAlphaChannel: false,
  ...(binId ? { binId } : {}),
});

const bin = (id: string, name: string, parentId: string | null = null): MediaBin => ({ id, name, parentId });

describe('media bins', () => {
  it('names new bins Bin 1, Bin 2... per parent, and sorts siblings as a person would', () => {
    const bins = [bin('a', 'Bin 1'), bin('b', 'Bin 10'), bin('c', 'bin 2'), bin('d', 'Bin 1', 'a')];
    expect(nextBinName(bins, null)).toBe('Bin 3');
    expect(nextBinName(bins, 'a')).toBe('Bin 2');
    expect(childBins(bins, null).map((b) => b.name)).toEqual(['Bin 1', 'bin 2', 'Bin 10']);
  });

  it('creates a bin under its parent, or at the top level when the parent is gone', () => {
    const { bins, bin: created } = createBin([bin('a', 'Footage')], 'a', '  Drone ');
    expect(created).toMatchObject({ name: 'Drone', parentId: 'a' });
    expect(bins).toHaveLength(2);
    expect(createBin([], 'missing').bin.parentId).toBeNull();
  });

  it('shows an asset in its bin, and in Master when it has none or its bin is gone', () => {
    const bins = [bin('a', 'Footage')];
    const assets = [asset('root'), asset('filed', 'a'), asset('orphan', 'deleted')];
    expect(assetsInBin(assets, bins, null).map((a) => a.id)).toEqual(['root', 'orphan']);
    expect(assetsInBin(assets, bins, 'a').map((a) => a.id)).toEqual(['filed']);
  });

  it('counts clips in a bin including its sub-bins', () => {
    const bins = [bin('a', 'Footage'), bin('b', 'Drone', 'a'), bin('c', 'Music')];
    const assets = [asset('1', 'a'), asset('2', 'b'), asset('3', 'c'), asset('4')];
    expect(countAssetsDeep(assets, bins, 'a')).toBe(2);
    expect(countAssetsDeep(assets, bins, 'b')).toBe(1);
    expect(countAssetsDeep(assets, bins, null)).toBe(4);
  });

  it('gives the path from the top level down to a bin', () => {
    const bins = [bin('a', 'Footage'), bin('b', 'Drone', 'a')];
    expect(binPath(bins, 'b').map((b) => b.name)).toEqual(['Footage', 'Drone']);
    expect(binPath(bins, null)).toEqual([]);
  });

  it('refuses a blank rename', () => {
    const bins = [bin('a', 'Footage')];
    expect(renameBin(bins, 'a', '   ')[0].name).toBe('Footage');
    expect(renameBin(bins, 'a', ' B-Roll ')[0].name).toBe('B-Roll');
  });

  it('deleting a bin moves its clips and sub-bins up, losing nothing', () => {
    const bins = [bin('a', 'Footage'), bin('b', 'Day 1', 'a'), bin('c', 'Drone', 'b')];
    const assets = [asset('1', 'b'), asset('2', 'c'), asset('3')];
    const after = deleteBin(bins, assets, 'b');
    expect(after.bins.map((b) => [b.id, b.parentId])).toEqual([
      ['a', null],
      ['c', 'a'],
    ]);
    expect(after.assets.map((a) => [a.id, a.binId])).toEqual([
      ['1', 'a'],
      ['2', 'c'],
      ['3', undefined],
    ]);
    // A top-level bin's clips go back to Master.
    expect(deleteBin([bin('x', 'Music')], [asset('m', 'x')], 'x').assets[0]).not.toHaveProperty('binId');
  });

  it('moves clips between bins and back to Master', () => {
    const moved = moveAssetsToBin([asset('1'), asset('2', 'a'), asset('3')], ['1', '2'], 'b');
    expect(moved.map((a) => a.binId)).toEqual(['b', 'b', undefined]);
    expect(moveAssetsToBin(moved, ['1'], null)[0]).not.toHaveProperty('binId');
  });

  it('will not move a bin inside itself or its own sub-bins', () => {
    const bins = [bin('a', 'Footage'), bin('b', 'Drone', 'a')];
    expect(moveBin(bins, 'a', 'b')).toEqual(bins);
    expect(moveBin(bins, 'b', null).find((b) => b.id === 'b')?.parentId).toBeNull();
  });

  it('mirrors a folder path as bins, reusing the ones already there', () => {
    const first = ensureBinPath([], null, ['Shoot', 'Day 1', 'Drone']);
    expect(binPath(first.bins, first.binId).map((b) => b.name)).toEqual(['Shoot', 'Day 1', 'Drone']);

    const again = ensureBinPath(first.bins, null, ['shoot', 'Day 1', 'Ground']);
    expect(again.bins).toHaveLength(4);
    expect(binPath(again.bins, again.binId).map((b) => b.name)).toEqual(['Shoot', 'Day 1', 'Ground']);

    expect(ensureBinPath(first.bins, null, []).binId).toBeNull();
  });

  it('makes bins from a saved file safe: junk dropped, lost parents lifted, loops broken', () => {
    const cleaned = sanitizeBins([
      bin('a', 'Footage'),
      { id: 'b', name: 'Lost parent', parentId: 'nowhere' },
      { id: 'c', name: 'Loop 1', parentId: 'd' },
      { id: 'd', name: 'Loop 2', parentId: 'c' },
      { id: 'a', name: 'Duplicate id', parentId: null },
      { id: 'e', name: '   ', parentId: null },
      'not a bin',
      null,
    ]);
    expect(cleaned.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(cleaned.find((b) => b.id === 'b')?.parentId).toBeNull();
    // Every bin now reaches the top level.
    for (const entry of cleaned) expect(binPath(cleaned, entry.id)[0].parentId).toBeNull();
    expect(sanitizeBins(undefined)).toEqual([]);
  });
});
