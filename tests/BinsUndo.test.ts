import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset } from '@shared/types';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Bin edits are undoable.
 *
 * Bins live beside the project, not in it, so the snapshot history of the
 * timeline never saw them: Ctrl+Z after deleting a bin undid whatever timeline
 * edit came before it instead. These go through the real store, because the
 * claim is about the one shared history - Ctrl+Z takes back whichever edit came
 * last, bin or timeline.
 */

const state = () => useProjectStore.getState();

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.png`,
  uri: `media://file/${id}`,
  kind: 'image',
  durationFrames: 150,
  width: 64,
  height: 64,
  hasAlphaChannel: false,
});

const binNames = (): string[] => state().bins.map((bin) => bin.name).sort();
const binOf = (assetId: string): string | null => {
  const binId = state().assets.find((entry) => entry.id === assetId)?.binId;
  return state().bins.find((bin) => bin.id === binId)?.name ?? null;
};

beforeEach(() => {
  state().newProject();
  useHistoryStore.getState().clear();
  // Two assets in Master; importing is not an undoable step.
  state().addAssets([asset('a'), asset('b')], null);
});

describe('undoing bin edits', () => {
  it('takes back a new bin, a rename, a move and a delete, one step each', () => {
    const shots = state().createBin(null, 'Shots');
    state().renameBin(shots, 'B-Roll');
    state().moveAssetsToBin(['a'], shots);
    state().deleteBin(shots);

    expect(binNames()).toEqual([]);
    expect(binOf('a')).toBeNull();

    state().undo(); // the delete
    expect(binNames()).toEqual(['B-Roll']);
    expect(binOf('a')).toBe('B-Roll');

    state().undo(); // the move
    expect(binOf('a')).toBeNull();

    state().undo(); // the rename
    expect(binNames()).toEqual(['Shots']);

    state().undo(); // the new bin
    expect(binNames()).toEqual([]);
    expect(useHistoryStore.getState().canUndo).toBe(false);
  });

  it('redoes them in order', () => {
    const shots = state().createBin(null, 'Shots');
    state().moveAssetsToBin(['a', 'b'], shots);
    state().undo();
    state().undo();

    state().redo();
    expect(binNames()).toEqual(['Shots']);
    expect(binOf('a')).toBeNull();

    state().redo();
    expect([binOf('a'), binOf('b')]).toEqual(['Shots', 'Shots']);
  });

  it('shares one history with the timeline: Ctrl+Z takes back whichever came last', () => {
    state().addMarker(30);
    const shots = state().createBin(null, 'Shots');
    state().addMarker(60);

    state().undo(); // the second marker, not the bin
    expect(state().project.markers.map((marker) => marker.frame)).toEqual([30]);
    expect(state().bins.map((bin) => bin.id)).toEqual([shots]);

    state().undo(); // now the bin
    expect(state().bins).toEqual([]);
    expect(state().project.markers.map((marker) => marker.frame)).toEqual([30]);
  });

  it('does not record an edit that changed nothing', () => {
    const shots = state().createBin(null, 'Shots');
    const steps = useHistoryStore.getState().undoStack.length;
    state().renameBin(shots, '   ');
    state().renameBin(shots, 'Shots');
    state().moveAssetsToBin(['a'], null);
    expect(useHistoryStore.getState().undoStack.length).toBe(steps);
  });

  it('leaves the bin on show when it still exists, and steps out when it does not', () => {
    const shots = state().createBin(null, 'Shots');
    state().setCurrentBin(shots);
    state().renameBin(shots, 'B-Roll');
    state().undo();
    expect(state().currentBinId).toBe(shots);

    state().undo(); // removes the bin being shown
    expect(state().currentBinId).toBeNull();
  });

  it('keeps assets imported after the edit where they are', () => {
    const shots = state().createBin(null, 'Shots');
    state().addAssets([asset('late')], shots);
    state().undo(); // the new bin

    expect(state().assets.map((entry) => entry.id)).toContain('late');
    // Its bin is gone, so it shows in Master like any orphan.
    expect(binOf('late')).toBeNull();
  });
});
