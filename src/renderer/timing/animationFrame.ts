/**
 * `requestAnimationFrame` for whichever of the editor's windows is painting.
 *
 * Every loop that keeps playback going - the clock that moves the playhead,
 * the viewer's composite, the audio's resync watch, the meters - used to ask
 * the editor's own window for its frames. With a panel in a window of its own
 * (components/Layout/PanelWindow) that is the wrong window to ask: minimise the
 * editor to watch the viewer on the other screen and Chromium gives the
 * editor's window about one frame a second. Measured in this Electron build
 * (.bench-tmp/playback-min.mjs), the viewer then drew 0.9 pictures a second
 * while the sound played on, up to a second away from the picture. The page
 * cannot ask which window is being painted, either: the minimised editor still
 * reports itself `visible`.
 *
 * So the frame is asked of every open window at once. One of them leads - the
 * editor, to begin with - and its frames run everything that was waiting. The
 * others' answers are not used while the leader keeps up: two windows on the
 * same screen both answer every refresh, and taking both would draw the
 * viewer twice a refresh. A leader that has given nothing for STALL_MS - the
 * window minimised, covered, or closed - hands over to whichever window
 * answers next, so playback goes on at the rate of a window still on a screen.
 *
 * The time passed to the callbacks is on the editor's own clock
 * (`performance.now()` of this window), whichever window supplied the frame:
 * each window counts from its own origin, and the playback clock subtracts
 * one tick's time from the next.
 */

/** The part of a window this needs; a test passes stand-ins. */
export interface FrameWindow {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  readonly performance: { readonly timeOrigin: number };
  readonly closed: boolean;
}

/**
 * How long the leading window may go without a frame before another takes
 * over: about three refreshes at 60 Hz, well under the second a minimised
 * editor's window takes, and long enough that a window keeping up is never
 * passed over for one on a faster screen.
 */
export const STALL_MS = 50;

interface FrameRequest {
  view: FrameWindow;
  id: number;
}

export class FrameRace {
  private readonly extra = new Set<FrameWindow>();
  private readonly waiting = new Map<number, FrameRequestCallback>();
  private nextHandle = 1;
  /** The requests out for the next frame, one per window, while anything waits. */
  private armed: FrameRequest[] | null = null;
  /** The window whose frames are being used. */
  private leader: FrameWindow;
  /** When the waiting callbacks last ran, on the editor's clock. */
  private lastTime = -Infinity;

  constructor(private readonly home: FrameWindow) {
    this.leader = home;
  }

  /** Another window that may supply frames, until the returned function is called. */
  addWindow(view: FrameWindow): () => void {
    if (!this.extra.has(view)) {
      this.extra.add(view);
      // Already waiting: this window may answer the frame that is out.
      if (this.armed && !view.closed) this.armed.push(this.ask(view));
    }
    return () => {
      this.extra.delete(view);
      if (this.leader === view) this.leader = this.home;
      // A window going away may have been the only one answering - the editor
      // minimised - so the frame is asked again of those that are left.
      if (this.armed?.some((request) => request.view === view)) {
        this.disarm();
        if (this.waiting.size > 0) this.arm();
      }
    };
  }

  request(callback: FrameRequestCallback): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.waiting.set(handle, callback);
    this.arm();
    return handle;
  }

  cancel(handle: number): void {
    this.waiting.delete(handle);
    // Nothing left to run: no window is kept painting for it.
    if (this.waiting.size === 0) this.disarm();
  }

  private ask(view: FrameWindow): FrameRequest {
    const request = { view, id: 0 };
    request.id = view.requestAnimationFrame((now) => this.fire(request, now));
    return request;
  }

  private arm(): void {
    if (this.armed) return;
    this.armed = [this.home, ...this.extra].filter((view) => !view.closed).map((view) => this.ask(view));
  }

  private disarm(): void {
    const armed = this.armed;
    this.armed = null;
    for (const { view, id } of armed ?? []) {
      if (!view.closed) view.cancelAnimationFrame(id);
    }
  }

  private fire(request: FrameRequest, now: number): void {
    // An answer to a frame that has already been handled, or withdrawn.
    const at = this.armed?.indexOf(request) ?? -1;
    if (!this.armed || at < 0) return;
    const time = now + (request.view.performance.timeOrigin - this.home.performance.timeOrigin);
    if (request.view !== this.leader && time - this.lastTime < STALL_MS) {
      // The leader is keeping up; this window is asked again, to be ready.
      this.armed[at] = this.ask(request.view);
      return;
    }
    this.leader = request.view;
    this.lastTime = time;
    this.disarm();
    // Whatever these callbacks ask for is the next frame's, as with the real thing.
    const due = [...this.waiting.values()];
    this.waiting.clear();
    for (const callback of due) {
      try {
        callback(time);
      } catch (error) {
        // One loop failing must not stop the others; it is still reported.
        reportError(error);
      }
    }
  }
}

let race: FrameRace | null = null;
const shared = (): FrameRace => {
  race ??= new FrameRace(window);
  return race;
};

/** `requestAnimationFrame`, answered by an editor window that is painting. */
export const requestFrame = (callback: FrameRequestCallback): number => shared().request(callback);

export const cancelFrame = (handle: number): void => shared().cancel(handle);

/** A panel's window, as a source of frames while it is open. */
export const addFrameWindow = (view: Window): (() => void) => shared().addWindow(view);
