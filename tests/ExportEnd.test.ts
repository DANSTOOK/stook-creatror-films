import { beforeEach, describe, expect, it } from 'vitest';
import { exportEndFrame } from '@renderer/components/ExportDialog/exportRange';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip } from '@renderer/store/types';

/**
 * Every export ended in a second of black: the 19:27.7 KRATOS vs THOR footage
 * exported as 19:28.7. The timeline keeps a second of room after its content,
 * and the export range was seeded with the whole timeline, room included.
 */

const state = () => useProjectStore.getState();

function addClip(start: number, frames: number, name = 'clip'): void {
  const track = state().project.tracks.find((candidate) => candidate.type === 'video')!;
  const clip = createClip({ trackId: track.id, name, sourceUri: `media://${name}`, startFrame: start, durationFrames: frames });
  state().transact('add', (project) => ({ ...project, clips: { ...project.clips, [clip.id]: clip } }));
}

beforeEach(() => {
  state().newProject();
  useHistoryStore.getState().clear();
});

describe('where an export ends', () => {
  it('ends with the last clip, not with the room the timeline keeps after it', () => {
    // The user's footage: 35,032 frames at 30 fps.
    addClip(0, 35032, 'kratos');
    const project = state().project;

    expect(project.durationFrames).toBeGreaterThan(35032); // the editing room is still there
    expect(exportEndFrame(project)).toBe(35032);
  });

  it('follows the clip that ends last, on any track', () => {
    addClip(0, 300, 'first');
    addClip(900, 150, 'last');
    expect(exportEndFrame(state().project)).toBe(1050);
  });

  it('still covers footage added after a long timeline was seeded', () => {
    addClip(0, 30 * 60 * 5, 'five-minutes');
    const before = exportEndFrame(state().project);
    addClip(30 * 60 * 5, 30 * 60 * 40, 'forty-more');
    expect(exportEndFrame(state().project)).toBe(30 * 60 * 45);
    expect(exportEndFrame(state().project)).toBeGreaterThan(before);
  });

  it('falls back to the timeline length when there are no clips', () => {
    const project = state().project;
    expect(exportEndFrame(project)).toBe(project.durationFrames);
  });
});
