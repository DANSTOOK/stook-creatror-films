import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@renderer/store/types';
import { projectContentLength } from '@renderer/components/Timeline/timelineOps';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip, createEmptyProject } from '@renderer/store/types';

/**
 * The reported "it only lets me add 5 minutes".
 *
 * Nothing ever refused the footage: it was added, drawn and played in full.
 * Two things conspired to make the rest of it unreachable.
 *
 *  - The export range was seeded once and then kept, so a project that was
 *    5 minutes long when the dialog first opened went on exporting 5 minutes
 *    after 40 more were added - silently, and the dialog kept showing that
 *    number.
 *  - Opening a saved project installed its stored `durationFrames` verbatim,
 *    and that is a hard ceiling for the playhead and the timeline surface.
 *    Every other path that adds clips grows it; loading was the exception.
 */

const state = () => useProjectStore.getState();

/** A document whose clips run far past the duration recorded in it. */
function staleDocument(): ProjectDocument {
  const project = createEmptyProject();
  const track = project.tracks.find((candidate) => candidate.type === 'video')!;
  // 45 minutes of footage at 30 fps, saved with a 5-minute duration.
  const clip = createClip({
    trackId: track.id,
    name: 'long',
    sourceUri: 'media://long',
    startFrame: 0,
    durationFrames: 30 * 60 * 45,
  });

  return {
    version: 1,
    savedAt: new Date().toISOString(),
    project: { ...project, clips: { [clip.id]: clip }, durationFrames: 30 * 60 * 5 },
    assets: [],
  };
}

beforeEach(() => {
  state().newProject();
  useHistoryStore.getState().clear();
});

describe('opening a project whose stored length is too short', () => {
  it('grows the project to cover its own clips', () => {
    const document = staleDocument();
    state().loadDocument(document);

    const project = state().project;
    expect(project.durationFrames).toBeGreaterThanOrEqual(projectContentLength(project));
    expect(project.durationFrames).toBeGreaterThan(30 * 60 * 40);
  });

  it('lets the playhead reach the end of the footage', () => {
    state().loadDocument(staleDocument());
    const wanted = 30 * 60 * 44;
    state().setCurrentFrame(wanted);
    expect(state().project.currentFrame).toBe(wanted);
  });
});

describe('the export range', () => {
  it('is left unset when a project is opened, so it means the whole timeline', () => {
    state().loadDocument(staleDocument());
    expect(state().exportSettings.endFrame).toBe(0);
  });

  /**
   * The dialog resolves the range as `endFrame || project.durationFrames`.
   * What follows is that rule applied to the state the store is left in -
   * the bug was that the left-hand side was already filled in and stale.
   */
  const resolvedRange = (): number => {
    const { exportSettings, project } = state();
    return exportSettings.endFrame || project.durationFrames;
  };

  it('covers the whole timeline after opening a project', () => {
    state().loadDocument(staleDocument());
    expect(resolvedRange()).toBe(state().project.durationFrames);
    expect(resolvedRange()).toBeGreaterThan(30 * 60 * 40);
  });

  it('still covers it after more footage is added', () => {
    state().loadDocument(staleDocument());
    const before = resolvedRange();

    const track = state().project.tracks.find((candidate) => candidate.type === 'video')!;
    const more = createClip({
      trackId: track.id,
      name: 'more',
      sourceUri: 'media://more',
      startFrame: state().project.durationFrames,
      durationFrames: 30 * 60 * 10,
    });
    state().transact('append', (project) => ({
      ...project,
      clips: { ...project.clips, [more.id]: more },
    }));

    expect(resolvedRange()).toBeGreaterThan(before);
    expect(resolvedRange()).toBe(state().project.durationFrames);
  });

  /** A range the editor narrowed by hand is still honoured while it lasts. */
  it('can still be narrowed deliberately', () => {
    state().loadDocument(staleDocument());
    state().setExportSettings({ startFrame: 100, endFrame: 400 });
    expect(resolvedRange()).toBe(400);
  });
});
