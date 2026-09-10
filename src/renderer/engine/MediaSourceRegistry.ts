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

export class MediaSourceRegistry {
  private readonly elements = new Map<string, MediaElement>();
  private readonly kinds = new Map<string, MediaAsset['kind']>();
  private readonly ready = new Set<string>();
  private readonly lastCorrection = new Map<string, number>();

  register(asset: MediaAsset): MediaElement {
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

    const video = document.createElement('video');
    video.src = asset.uri;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true; // Audio is played by AudioEngine, not by the element.
    video.playsInline = true;
    video.addEventListener('loadeddata', () => this.ready.add(asset.uri), { once: true });
    video.load();

    this.elements.set(asset.uri, video);
    return video;
  }

  get(uri: string): MediaElement | undefined {
    return this.elements.get(uri);
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
      return `${uri}:${Math.round(element.currentTime * fps)}`;
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
