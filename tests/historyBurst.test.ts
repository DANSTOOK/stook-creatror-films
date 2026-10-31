import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Holding Ctrl+Z renders once a frame, not once a press.
 *
 * The store is stood in for: what matters here is the order the steps are
 * applied in and which frame they land on, not what undoing does.
 */

const steps: string[] = [];
vi.mock('@renderer/store/useProjectStore', () => ({
  useProjectStore: {
    getState: () => ({
      undo: () => steps.push('undo'),
      redo: () => steps.push('redo'),
    }),
  },
}));

let frames: Array<() => void> = [];
vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
  frames[handle - 1] = () => {};
});

/** Run the frames asked for so far, as the browser would. */
const nextFrame = (): void => {
  const due = frames;
  frames = [];
  for (const callback of due) callback();
};

const { clearHistoryBurst, flushHistory, historyStep } = await import('@renderer/history/burst');

describe('the undo burst', () => {
  beforeEach(() => {
    clearHistoryBurst();
    frames = [];
    steps.length = 0;
    // A frame with nothing queued closes the window left open by the last test.
    nextFrame();
    steps.length = 0;
  });

  it('applies the first press at once: one undo never waits for a frame', () => {
    historyStep('undo');
    expect(steps).toEqual(['undo']);
  });

  it('holds back the rest of the burst and applies them on the next frame, in order', () => {
    historyStep('undo');
    historyStep('undo');
    historyStep('undo');
    expect(steps).toEqual(['undo']);
    nextFrame();
    expect(steps).toEqual(['undo', 'undo', 'undo']);
  });

  it('keeps undo and redo in the order they were pressed', () => {
    historyStep('undo');
    historyStep('undo');
    historyStep('redo');
    nextFrame();
    expect(steps).toEqual(['undo', 'undo', 'redo']);
  });

  it('opens again once a frame passes with nothing queued', () => {
    historyStep('undo');
    nextFrame();
    nextFrame();
    historyStep('redo');
    expect(steps).toEqual(['undo', 'redo']);
  });

  it('applies what is queued at once when an edit asks for it', () => {
    historyStep('undo');
    historyStep('undo');
    flushHistory();
    expect(steps).toEqual(['undo', 'undo']);
    // And the frame that was already asked for does not apply them twice.
    nextFrame();
    expect(steps).toEqual(['undo', 'undo']);
  });

  it('forgets a pending burst when the project is replaced', () => {
    historyStep('undo');
    historyStep('undo');
    clearHistoryBurst();
    nextFrame();
    expect(steps).toEqual(['undo']);
  });
});
