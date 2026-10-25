import type { MediaAsset } from '@shared/types';

/**
 * Owns the decoded DOM media elements behind every asset URI.
 *
 * Video is driven by `HTMLVideoElement` rather than WebCodecs here because the
 * element keeps its own decode pipeline warm while scrubbing. The tradeoff is
 * that seeking is asynchronous, so the compositor draws whatever frame is
 * currently resident and the element catches up over the next few rafs.
 */

export type MediaElement = HTMLVideoElement | HTMLImageElement;

/** Playback drift beyond this many seconds is corrected by a hard seek. */
const MAX_DRIFT_SECONDS = 0.25;

/** Minimum gap between two drift corrections on the same element. */
const MIN_CORRECTION_INTERVAL_MS = 600;

/** How long to wait for one seek before giving up and drawing what we have. */
const SEEK_TIMEOUT_MS = 4000;

/** Resolve once the element has a decoded frame and is not seeking. */
export function waitForSeek(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && !video.seeking) return Promise.resolve();

  return new Promise((resolve) => {
    const done = (): void => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('loadeddata', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, SEEK_TIMEOUT_MS);
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('loadeddata', done, { once: true });
  });
}

export class MediaSourceRegistry {
  private readonly elements = new Map<string, MediaElement>();
  private readonly kinds = new Map<string, MediaAsset['kind']>();
  private readonly ready = new Set<string>();
  private readonly lastCorrection = new Map<string, number>();
  /** What each URL showed when its element was made: the file, or the file stabilized. */
  private readonly looks = new Map<string, string>();

  /**
   * How many times an element has had something new to show: a frame
   * presented (while playing, or a seek landed), a first frame, an image
   * loaded. The viewer draws when this moves rather than on every refresh of
   * the screen (useCompositor); nothing else reads it.
   */
  private changes = 0;

  get pictureChanges(): number {
    return this.changes;
  }

  private readonly changed = (): void => {
    this.changes += 1;
  };

  register(asset: MediaAsset): MediaElement | undefined {
    // The same URL pointed at another file (stabilized, or back): its element starts again.
    const look = asset.stabilize ?? '';
    if (this.looks.has(asset.uri) && this.looks.get(asset.uri) !== look) {
      const stale = this.elements.get(asset.uri);
      if (stale instanceof HTMLVideoElement) {
        stale.pause();
        stale.removeAttribute('src');
        stale.load();
      }
      this.elements.delete(asset.uri);
      this.ready.delete(asset.uri);
    }
    this.looks.set(asset.uri, look);
    /*
      A missing file has nothing to load, and an element made for it would
      stay broken after the file is relinked under the same URL. So none is
      made, one made before the file went missing is dropped, and the next
      registration after a relink starts clean.
    */
    if (asset.missing) {
      const stale = this.elements.get(asset.uri);
      if (stale) {
        if (stale instanceof HTMLVideoElement) stale.pause();
        stale.removeAttribute('src');
        this.elements.delete(asset.uri);
        this.ready.delete(asset.uri);
      }
      return undefined;
    }

    // The proxy is an element of its own, under its own URI, so the
    // original stays loaded for the export and for a toggle back.
    if (asset.proxyUri && asset.kind !== 'image' && !asset.stabilize) {
      this.proxies.set(asset.uri, asset.proxyUri);
      if (!this.elements.has(asset.proxyUri)) {
        this.registerVideo(asset.proxyUri);
      }
    }

    const existing = this.elements.get(asset.uri);
    if (existing) return existing;

    this.kinds.set(asset.uri, asset.kind);

    if (asset.kind === 'image') {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.addEventListener(
        'load',
        () => {
          this.ready.add(asset.uri);
          this.changed();
        },
        { once: true },
      );
      image.src = asset.uri;
      this.elements.set(asset.uri, image);
      return image;
    }

    return this.registerVideo(asset.uri);
  }

  /** A video element for one URI - the source itself, or its proxy. */
  private registerVideo(uri: string): HTMLVideoElement {
    const video = document.createElement('video');
    video.src = uri;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true; // Audio is played by AudioEngine, not by the element.
    video.playsInline = true;
    video.addEventListener('loadeddata', () => this.ready.add(uri), { once: true });
    video.addEventListener('loadeddata', this.changed);
    video.addEventListener('seeked', this.changed);
    // Every frame the element presents - each one while it plays, the one a
    // seek lands on - is something new to draw. The callback asks again for
    // the next, so it runs for as long as the element lives, at no cost while
    // nothing is presented.
    if (typeof video.requestVideoFrameCallback === 'function') {
      const presented = (): void => {
        this.changes += 1;
        video.requestVideoFrameCallback(presented);
      };
      video.requestVideoFrameCallback(presented);
    }
    video.load();

    this.kinds.set(uri, 'video');
    this.elements.set(uri, video);
    return video;
  }

  get(uri: string): MediaElement | undefined {
    return this.elements.get(uri);
  }

  /**
   * A second video element for a file that already has one, under a URI of
   * its own (the file's, with a fragment that changes nothing about what is
   * loaded). Two parts of one file on screen at once - either side of a
   * transition - each need a decoder, since one element can only be at one
   * time. Released with `release` when the transition has passed.
   */
  ensureLane(laneUri: string, uri: string): void {
    if (this.elements.has(laneUri) || !(this.elements.get(uri) instanceof HTMLVideoElement)) return;
    this.registerVideo(laneUri);
  }

  /**
   * Resolves once an element has decoded its first frame (or after the seek
   * timeout): an exact render must not seek an element still opening, whose
   * position is not yet the one it will show.
   */
  whenLoaded(uri: string): Promise<void> {
    const element = this.elements.get(uri);
    if (!(element instanceof HTMLVideoElement) || this.ready.has(uri)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, SEEK_TIMEOUT_MS);
      element.addEventListener('loadeddata', done, { once: true });
    });
  }

  /**
   * Small stand-ins for heavy footage, by the original URI.
   *
   * The preview asks for these through `previewUriFor`; nothing else does,
   * which is what keeps an export reading the original file.
   */
  private readonly proxies = new Map<string, string>();

  private proxiesOn = true;

  /** Turn proxy playback on or off for the preview. */
  useProxies(enabled: boolean): void {
    this.proxiesOn = enabled;
  }

  /** What the preview should draw for this source: its proxy, or itself. */
  previewUriFor(uri: string): string {
    if (!this.proxiesOn) return uri;
    const proxy = this.proxies.get(uri);
    return proxy && this.elements.has(proxy) ? proxy : uri;
  }

  isReady(uri: string): boolean {
    if (!this.ready.has(uri)) return false;
    const element = this.elements.get(uri);
    if (element instanceof HTMLVideoElement) return element.readyState >= 2;
    return true;
  }

  /**
   * Align a video element with the timeline.
   *
   * While playing, the element runs on its own clock and is nudged only when it
   * drifts; while paused, every scrub is an explicit seek.
   *
   * Corrections are rate limited on purpose. Every assignment to `currentTime`
   * starts a seek, during which the element drops below HAVE_CURRENT_DATA - so
   * a correction on each animation frame would keep the decoder permanently
   * mid-seek and make playback stutter rather than smooth it out.
   */
  syncToFrame(uri: string, sourceFrame: number, fps: number, playing: boolean): void {
    const element = this.elements.get(uri);
    if (!(element instanceof HTMLVideoElement)) return;

    const duration = Number.isFinite(element.duration) ? element.duration : Infinity;
    // Seeking past the end never completes, so the target is clamped inside it.
    const targetSeconds = Math.max(0, Math.min(sourceFrame / fps, duration - 1 / fps));

    if (!playing) {
      if (!element.paused) element.pause();
      // A paused scrub is an explicit request, but re-seeking to the frame that
      // is already displayed would restart the decoder for nothing.
      if (!element.seeking && Math.abs(element.currentTime - targetSeconds) > 0.5 / fps) {
        element.currentTime = targetSeconds;
      }
      return;
    }

    if (element.paused) {
      if (Math.abs(element.currentTime - targetSeconds) > MAX_DRIFT_SECONDS) {
        element.currentTime = targetSeconds;
      }
      void element.play().catch(() => undefined);
      this.lastCorrection.set(uri, performance.now());
      return;
    }

    if (element.seeking) return;

    const since = performance.now() - (this.lastCorrection.get(uri) ?? 0);
    if (since < MIN_CORRECTION_INTERVAL_MS) return;

    if (Math.abs(element.currentTime - targetSeconds) > MAX_DRIFT_SECONDS) {
      element.currentTime = targetSeconds;
      this.lastCorrection.set(uri, performance.now());
    }
  }

  /**
   * Put a video on exactly `sourceFrame`, and do not return until it is there.
   *
   * `syncToFrame` is best effort by design, and it skips the seek entirely if
   * the element is already mid-seek. For export that is wrong twice over: the
   * seek in flight may be someone else's, and "a seeked event fired" is not the
   * same as "the element shows the frame asked for". So this checks where the
   * element actually landed and seeks again if it is not there.
   */
  async seekExact(uri: string, sourceFrame: number, fps: number): Promise<void> {
    const element = this.elements.get(uri);
    if (!(element instanceof HTMLVideoElement)) return;

    if (!element.paused) element.pause();

    const duration = Number.isFinite(element.duration) ? element.duration : Infinity;
    // Aim at the MIDDLE of the frame, not its first instant. A seek to exactly
    // N / fps can resolve to frame N - 1 once the container's timestamps are
    // rounded (90 kHz ticks do not divide into 30 fps evenly), and on a screen
    // recording that is a one-frame stutter exactly where the picture changes.
    // Measured on such a recording: 1 frame in 300 landed one early; aimed at
    // the centre, none do.
    const targetSeconds = Math.max(0, Math.min((sourceFrame + 0.5) / fps, duration - 0.5 / fps));
    const tolerance = 0.5 / fps;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Let a seek already in flight land before judging where the element is.
      if (element.seeking) await waitForSeek(element);

      if (Math.abs(element.currentTime - targetSeconds) <= tolerance && element.readyState >= 2) {
        return;
      }

      element.currentTime = targetSeconds;
      await waitForSeek(element);
    }
  }

  /**
   * Seek a video to exactly `seconds` of its own clock and wait for it to
   * land. Unlike `seekExact` it aims where it is told, for a caller that knows
   * the file's frame times (see frameCheck), and it always seeks unless the
   * element is already at that very time.
   */
  async seekTo(uri: string, seconds: number): Promise<void> {
    const element = this.elements.get(uri);
    if (!(element instanceof HTMLVideoElement)) return;
    if (!element.paused) element.pause();
    // Seeking past the end never completes.
    const duration = Number.isFinite(element.duration) ? element.duration : Infinity;
    const target = Math.max(0, Math.min(seconds, duration - 1e-3));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (element.seeking) await waitForSeek(element);
      if (Math.abs(element.currentTime - target) < 1e-6 && element.readyState >= 2) return;
      element.currentTime = target;
      await waitForSeek(element);
    }
  }

  /**
   * The picture a video element is showing, as a frame of its own: its
   * timestamp says which frame of the file it is, and drawing it draws
   * exactly what was checked. Null when the element has nothing to give.
   * The caller closes it.
   */
  grabFrame(uri: string): VideoFrame | null {
    const element = this.elements.get(uri);
    if (!(element instanceof HTMLVideoElement) || typeof VideoFrame === 'undefined' || element.readyState < 2) return null;
    try {
      return new VideoFrame(element);
    } catch {
      return null;
    }
  }

  /** A video's length in seconds, as its element knows it; Infinity until it does. */
  durationOf(uri: string): number {
    const element = this.elements.get(uri);
    return element instanceof HTMLVideoElement && Number.isFinite(element.duration) ? element.duration : Infinity;
  }

  /** Whether any video is playing now - presenting frames of its own, which the viewer waits for. */
  get anyPlaying(): boolean {
    for (const element of this.elements.values()) {
      if (element instanceof HTMLVideoElement && !element.paused && !element.ended && element.readyState >= 2) return true;
    }
    return false;
  }

  /** Pause every video, e.g. when the transport stops. */
  pauseAll(): void {
    for (const element of this.elements.values()) {
      if (element instanceof HTMLVideoElement && !element.paused) element.pause();
    }
  }

  /**
   * Identifies the frame currently resident in an element, so the texture cache
   * can skip a redundant upload.
   */
  revision(uri: string, fps: number): string {
    const element = this.elements.get(uri);
    if (element instanceof HTMLVideoElement) {
      // floor, not round: export seeks to the middle of a frame, (N + 0.5) / fps,
      // and rounding that gives N + 1 - the key of a DIFFERENT frame, which
      // would let the cache hand back the wrong texture. The epsilon keeps
      // N / fps from flooring to N - 1 on floating-point error.
      return `${uri}:${Math.floor(element.currentTime * fps + 1e-3)}`;
    }
    return `${uri}:static`;
  }

  release(uri: string): void {
    const element = this.elements.get(uri);
    if (element instanceof HTMLVideoElement) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.elements.delete(uri);
    this.kinds.delete(uri);
    this.ready.delete(uri);
    this.lastCorrection.delete(uri);
  }

  dispose(): void {
    for (const uri of [...this.elements.keys()]) this.release(uri);
  }
}
