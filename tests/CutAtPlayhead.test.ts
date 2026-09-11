import { describe, expect, it } from 'vitest';
import { razorClick } from '@renderer/components/Timeline/timelineOps';
import { hitsPlayheadScissors } from '@renderer/components/Timeline/TimelineCanvas';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { createClip, createEmptyProject } from '@renderer/store/types';

/**
 * Point 6: a cut lands on the playhead line, not on whatever pixel the pointer
 * clicked.
 */

const clip = createClip({ trackId: 't', name: 'c', sourceUri: 'media://c', startFrame: 100, durationFrames: 200 });

describe('razorClick', () => {
  it('cuts the clicked clip at the playhead, wherever on the clip the click was', () => {
    expect(razorClick(clip, 280, 150)).toEqual({ kind: 'cut', frame: 150, clipId: clip.id });
    expect(razorClick(clip, 101, 150)).toEqual({ kind: 'cut', frame: 150, clipId: clip.id });
  });

  it('only moves the playhead when the playhead is not over that clip', () => {
    expect(razorClick(clip, 220, 40)).toEqual({ kind: 'move-playhead', frame: 220 });
    // A playhead on the clip's own first frame would cut off nothing.
    expect(razorClick(clip, 220, 100)).toEqual({ kind: 'move-playhead', frame: 220 });
    expect(razorClick(clip, 220, 300)).toEqual({ kind: 'move-playhead', frame: 220 });
  });

  it('moves the playhead on a click on empty space', () => {
    expect(razorClick(null, 75, 150)).toEqual({ kind: 'move-playhead', frame: 75 });
  });
});

describe('the scissors on the playhead', () => {
  const project = { ...createEmptyProject(), currentFrame: 50 };
  const ui = { ...useProjectStore.getState().ui, pixelsPerFrame: 4, scrollLeftPx: 100 };

  it('are hit on the playhead line as drawn, scroll included', () => {
    // Frame 50 at 4 px/frame, scrolled 100 px: x = 100.
    expect(hitsPlayheadScissors(project, ui, 100, 16)).toBe(true);
    expect(hitsPlayheadScissors(project, ui, 106, 12)).toBe(true);
  });

  it('are not hit beside the line or below the ruler badge', () => {
    expect(hitsPlayheadScissors(project, ui, 120, 16)).toBe(false);
    expect(hitsPlayheadScissors(project, ui, 100, 40)).toBe(false);
  });
});

describe('cutting at the playhead through the store', () => {
  it('splits exactly at the playhead frame', () => {
    const store = useProjectStore.getState();
    store.newProject();
    const project = useProjectStore.getState().project;
    const video = project.tracks[0];
    const c = createClip({ trackId: video.id, name: 'c', sourceUri: 'media://c', startFrame: 0, durationFrames: 90 });
    useProjectStore.setState({ project: { ...project, clips: { [c.id]: c }, currentFrame: 37 } });

    const action = razorClick(c, 80, useProjectStore.getState().project.currentFrame);
    expect(action.kind).toBe('cut');
    if (action.kind === 'cut') useProjectStore.getState().razorAtFrame(action.frame, [action.clipId]);

    const halves = Object.values(useProjectStore.getState().project.clips).sort((a, b) => a.startFrame - b.startFrame);
    expect(halves.map((h) => [h.startFrame, h.durationFrames])).toEqual([[0, 37], [37, 53]]);
  });
});
