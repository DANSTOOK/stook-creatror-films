import { describe, expect, it } from 'vitest';
import { FrameRace, STALL_MS, type FrameWindow } from '@renderer/timing/animationFrame';

/**
 * A window whose frames arrive when the test says so. `paints` false stands for
 * one that is minimised: it accepts requests and never answers them.
 */
class FakeWindow implements FrameWindow {
  closed = false;
  private next = 1;
  readonly queued = new Map<number, FrameRequestCallback>();
  readonly performance: { timeOrigin: number };

  constructor(timeOrigin = 0) {
    this.performance = { timeOrigin };
  }

  requestAnimationFrame(callback: FrameRequestCallback): number {
    const id = this.next;
    this.next += 1;
    this.queued.set(id, callback);
    return id;
  }

  cancelAnimationFrame(handle: number): void {
    this.queued.delete(handle);
  }

  /** One frame of this window: everything queued for it runs. */
  frame(now: number): void {
    const due = [...this.queued.values()];
    this.queued.clear();
    for (const callback of due) callback(now);
  }
}

describe('frames from whichever window paints', () => {
  it('runs on the editor alone when no panel is out, as requestAnimationFrame did', () => {
    const editor = new FakeWindow();
    const race = new FrameRace(editor);
    const times: number[] = [];
    const tick = (now: number): void => {
      times.push(now);
      race.request(tick);
    };
    race.request(tick);
    editor.frame(16);
    editor.frame(32);
    expect(times).toEqual([16, 32]);
  });

  it('keeps running from a panel window while the editor gives no frames', () => {
    const editor = new FakeWindow(0);
    const viewer = new FakeWindow(1000);
    const race = new FrameRace(editor);
    race.addWindow(viewer);
    const times: number[] = [];
    const tick = (now: number): void => {
      times.push(now);
      race.request(tick);
    };
    race.request(tick);
    // The editor is minimised: only the viewer's window paints.
    viewer.frame(10);
    viewer.frame(26);
    viewer.frame(42);
    // On the editor's clock: the viewer's window started a second later.
    expect(times).toEqual([1010, 1026, 1042]);
  });

  it('runs each callback once per refresh, however many windows answer it', () => {
    const editor = new FakeWindow();
    const viewer = new FakeWindow();
    const timeline = new FakeWindow();
    const race = new FrameRace(editor);
    race.addWindow(viewer);
    race.addWindow(timeline);
    let ticks = 0;
    const tick = (): void => {
      ticks += 1;
      race.request(tick);
    };
    race.request(tick);
    // All three on screen and painting the same refreshes: the editor leads.
    for (const now of [16, 32, 48, 64]) {
      editor.frame(now);
      viewer.frame(now);
      timeline.frame(now);
    }
    expect(ticks).toBe(4);
    // The others are still asked every refresh, ready to take over.
    expect(viewer.queued.size).toBe(1);
    expect(timeline.queued.size).toBe(1);
  });

  it('hands over to a panel window when the editor is minimised, and only once it stalls', () => {
    const editor = new FakeWindow();
    const viewer = new FakeWindow();
    const race = new FrameRace(editor);
    race.addWindow(viewer);
    const times: number[] = [];
    const tick = (now: number): void => {
      times.push(now);
      race.request(tick);
    };
    race.request(tick);
    editor.frame(16);
    // Minimised: the editor answers no more, the viewer goes on.
    for (let now = 32; now <= 160; now += 16) viewer.frame(now);
    // Nothing from the viewer until the editor had been silent for STALL_MS...
    expect(times[0]).toBe(16);
    expect(times[1]).toBeGreaterThanOrEqual(16 + STALL_MS);
    expect(times[1]).toBeLessThan(16 + STALL_MS + 16);
    // ...and from then on every one of its frames.
    const after = times.slice(1);
    for (let i = 1; i < after.length; i += 1) expect(after[i] - after[i - 1]).toBe(16);
    // The editor's occasional frame from its minimised window changes nothing.
    const count = times.length;
    editor.frame(170);
    expect(times.length).toBe(count);
  });

  it('asks the editor again when the only window answering closes', () => {
    const editor = new FakeWindow();
    const viewer = new FakeWindow();
    const race = new FrameRace(editor);
    const remove = race.addWindow(viewer);
    let ticks = 0;
    race.request(() => {
      ticks += 1;
    });
    viewer.closed = true;
    remove();
    // The request out to the editor is a fresh one, and it is answered.
    expect(editor.queued.size).toBe(1);
    editor.frame(16);
    expect(ticks).toBe(1);
  });

  it('a window added while a frame is out may answer it', () => {
    const editor = new FakeWindow();
    const viewer = new FakeWindow();
    const race = new FrameRace(editor);
    let ticks = 0;
    race.request(() => {
      ticks += 1;
    });
    race.addWindow(viewer);
    viewer.frame(16);
    expect(ticks).toBe(1);
  });

  it('cancelling the last waiting callback withdraws every request', () => {
    const editor = new FakeWindow();
    const viewer = new FakeWindow();
    const race = new FrameRace(editor);
    race.addWindow(viewer);
    let ran = false;
    const handle = race.request(() => {
      ran = true;
    });
    race.cancel(handle);
    expect(editor.queued.size).toBe(0);
    expect(viewer.queued.size).toBe(0);
    editor.frame(16);
    expect(ran).toBe(false);
  });
});
