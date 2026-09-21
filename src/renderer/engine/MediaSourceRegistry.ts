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

  register(asset: MediaAsset): MediaElement {
    // The proxy is an element of its own, under its own URI, so the
    // original stays loaded for the export and for a toggle back.
    if (asset.proxyUri && asset.kind !== 'image') {
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
      image.addEventListener('load', () => this.ready.add(asset.uri), { once: true });
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
    video.load();

    this.kinds.set(uri, 'video');
    this.elements.set(uri, video);
    return video;
  }

  get(uri: string): MediaElement | undefined {
    return this.elements.get(uri);
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
