import { beforeEach, describe, expect, it } from 'vitest';
import { collectSnapTargets } from '@renderer/components/Timeline/snapping';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Markers.
 *
 * They were drawable and the magnet already snapped to them, but nothing could
 * create one - so in practice the feature did not exist. These go through the
 * real store, because the interesting claims are about the whole transaction:
 * markers are project data, they are undoable, and they survive a save.
 */

const state = () => useProjectStore.getState();
const frames = (): number[] => state().project.markers.map((marker) => marker.frame);

beforeEach(() => {
  useProjectStore.getState().newProject();
  useHistoryStore.getState().clear();
});

describe('creating markers', () => {
  it('drops a marker at the playhead by default', () => {
    state().setCurrentFrame(48);
    state().addMarker();

    expect(frames()).toEqual([48]);
  });

  it('drops a marker at an explicit frame', () => {
    state().addMarker(120, 'Chorus');

    expect(state().project.markers[0]).toMatchObject({ frame: 120, label: 'Chorus' });
  });

  it('keeps markers sorted by frame however they were added', () => {
    state().addMarker(90);
    state().addMarker(10);
    state().addMarker(50);

    expect(frames()).toEqual([10, 50, 90]);
  });

  it('refuses a second marker on a frame that already has one', () => {
    const first = state().addMarker(30);
    const second = state().addMarker(30);

    // A duplicate would be drawn exactly on top of the original, so it could
    // never be clicked - and therefore never deleted.
    expect(second).toBeNull();
    expect(frames()).toEqual([30]);
    expect(state().ui.selectedMarkerId).toBe(first);
  });

  it('rounds and clamps a fractional or negative frame', () => {
    state().addMarker(-5);
    state().addMarker(12.6);

    expect(frames()).toEqual([0, 13]);
  });
});

describe('editing markers', () => {
  it('renames without moving', () => {
    const id = state().addMarker(40, 'Old') as string;
    state().updateMarker(id, { label: 'New' });

    expect(state().project.markers[0]).toMatchObject({ frame: 40, label: 'New' });
  });

  it('re-sorts when a marker is moved past another', () => {
    const id = state().addMarker(10, 'First') as string;
    state().addMarker(50, 'Second');

    state().updateMarker(id, { frame: 80 });
    expect(state().project.markers.map((marker) => marker.label)).toEqual(['Second', 'First']);
  });

  it('removes one marker and leaves the rest', () => {
    const id = state().addMarker(10) as string;
    state().addMarker(20);

    state().removeMarker(id);
    expect(frames()).toEqual([20]);
    expect(state().ui.selectedMarkerId).toBeNull();
  });

  it('clears every marker at once', () => {
    state().addMarker(10);
    state().addMarker(20);
    state().clearMarkers();

    expect(frames()).toEqual([]);
  });

  it('is undoable, like every other edit', () => {
    state().addMarker(10);
    state().addMarker(20);

    state().undo();
    expect(frames()).toEqual([10]);

    state().redo();
    expect(frames()).toEqual([10, 20]);
  });
});

describe('navigating markers', () => {
  beforeEach(() => {
    state().addMarker(10);
    state().addMarker(50);
    state().addMarker(90);
  });

  it('jumps to the next marker after the playhead', () => {
    state().setCurrentFrame(20);
    state().goToMarker(1);
    expect(state().project.currentFrame).toBe(50);
  });

  it('jumps to the previous marker before the playhead', () => {
    state().setCurrentFrame(60);
    state().goToMarker(-1);
    expect(state().project.currentFrame).toBe(50);
  });

  it('stays put when there is nothing further in that direction', () => {
    state().setCurrentFrame(95);
    state().goToMarker(1);
    expect(state().project.currentFrame).toBe(95);
  });

  it('never lands on the marker already under the playhead', () => {
    state().setCurrentFrame(50);
    state().goToMarker(1);
    expect(state().project.currentFrame).toBe(90);
  });
});

describe('markers and snapping', () => {
  it('offers every project marker as a snap target', () => {
    state().addMarker(33);
    const targets = collectSnapTargets(state().project);

    expect(targets.some((target) => target.kind === 'marker' && target.frame === 33)).toBe(true);
  });

  it('survives the document round trip, unlike editor UI state', () => {
    state().addMarker(75, 'Hit');
    const document = JSON.parse(JSON.stringify(state().toDocument()));

    expect(document.project.markers).toEqual([
      expect.objectContaining({ frame: 75, label: 'Hit' }),
    ]);
  });
});
