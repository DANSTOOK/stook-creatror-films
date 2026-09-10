import type { MediaKind } from '@shared/types';

/**
 * Renderer-side media probing.
 *
 * `ffmpeg-static` ships ffmpeg but NOT ffprobe, and a machine without ffprobe on
 * PATH would otherwise import every video as a zero-length clip. The browser
 * already has to decode the file to display it, so its own metadata is both
 * authoritative and free - ffprobe, when present, only adds codec detail.
 */

export interface ElementProbe {
  durationSeconds: number;
  width: number;
  height: number;
  hasAlphaChannel: boolean;
  /** Data URL poster frame, absent for audio and on decode failure. */
  thumbnailUri?: string;
  /** Measured source frame rate, absent when it could not be determined. */
  fps?: number;
}

/** Frame rates worth snapping a noisy measurement onto. */
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

/**
 * Snap a measured rate to the nearest standard one, within 4%.
 *
 * Measuring from presentation timestamps is accurate but not exact, and a
 * project running at 29.9994 fps instead of 30 would drift against its audio.
 */
export function snapFrameRate(measured: number): number {
  if (!Number.isFinite(measured) || measured <= 0) return 0;

  let best = measured;
  let bestError = Infinity;
  for (const rate of STANDARD_RATES) {
    const error = Math.abs(rate - measured) / rate;
    if (error < bestError) {
      bestError = error;
      best = rate;
    }
  }
  return bestError <= 0.04 ? best : Math.round(measured * 1000) / 1000;
}

interface FrameMetadata {
  mediaTime: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(callback: (now: number, metadata: FrameMetadata) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
};

/**
 * Derive the frame rate from the presentation timestamps of real decoded
 * frames.
 *
 * `HTMLVideoElement` exposes no frame rate, and a dropped file has no path for
 * ffmpeg to inspect - but `requestVideoFrameCallback` reports the media time of
 * each frame the decoder actually presents, and the gap between them IS the
 * frame interval.
 */
async function measureFrameRate(video: FrameCallbackVideo): Promise<number | undefined> {
  if (typeof video.requestVideoFrameCallback !== 'function') return undefined;

  return new Promise<number | undefined>((resolve) => {
    const mediaTimes: number[] = [];
    let handle = 0;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.cancelVideoFrameCallback?.(handle);
      video.pause();

      const deltas: number[] = [];
      for (let i = 1; i < mediaTimes.length; i += 1) {
        const delta = mediaTimes[i] - mediaTimes[i - 1];
        if (delta > 0.0005) deltas.push(delta);
      }
      if (deltas.length < 3) {
        resolve(undefined);
        return;
      }

      // The median rejects the outliers a decoder start-up produces.
      deltas.sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      resolve(snapFrameRate(1 / median) || undefined);
    };

    const timer = setTimeout(finish, 2000);

    const onFrame = (_now: number, metadata: FrameMetadata): void => {
      mediaTimes.push(metadata.mediaTime);
      if (mediaTimes.length >= 15) {
        finish();
        return;
      }
      handle = video.requestVideoFrameCallback!(onFrame);
    };

    video.muted = true;
    handle = video.requestVideoFrameCallback!(onFrame);
    void video.play().catch(() => finish());
  });
}

/** How long to wait for metadata before giving up on a source. */
const METADATA_TIMEOUT_MS = 15_000;

/**
 * True when any pixel is not fully opaque.
 *
 * Pure so the scan itself is unit tested; the caller supplies pixels from a
 * canvas readback.
 */
export function hasTransparentPixels(pixels: ArrayLike<number>, tolerance = 250): boolean {
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < tolerance) return true;
  }
  return false;
}

function waitForMetadata(element: HTMLVideoElement | HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      element.removeEventListener('error', onError);
      resolve();
    };
    const onError = (): void => {
      clearTimeout(timer);
      reject(new Error('The browser could not decode this file'));
    };

    const timer = setTimeout(
      () => reject(new Error('Timed out reading media metadata')),
      METADATA_TIMEOUT_MS,
    );

    element.addEventListener('error', onError, { once: true });

    if (element instanceof HTMLVideoElement) {
      // `loadeddata` rather than `loadedmetadata`: a frame must be decodable
      // before the alpha scan below can read pixels out of it.
      if (element.readyState >= 2) settle();
      else element.addEventListener('loadeddata', settle, { once: true });
      return;
    }

    if (element.complete && element.naturalWidth > 0) settle();
    else element.addEventListener('load', settle, { once: true });
  });
}

/**
 * Sample one frame and report whether it carries real transparency.
 *
 * Downscaled to at most 128px on the long edge: a sprite with any transparency
 * at all has plenty of it, so a full-resolution readback would be wasted work.
 */
interface FrameSample {
  hasAlphaChannel: boolean;
  thumbnailUri?: string;
}

/**
 * Draw one frame once, and read both answers off it: whether the source carries
 * real transparency, and a poster thumbnail for the media panel.
 *
 * Downscaled to at most 128px on the long edge - a sprite with any transparency
 * at all has plenty of it, so a full-resolution readback would be wasted work,
 * and that size doubles as a perfectly good thumbnail.
 */
function sampleFrame(source: CanvasImageSource, width: number, height: number): FrameSample {
  if (width === 0 || height === 0) return { hasAlphaChannel: false };

  const scale = Math.min(1, 128 / Math.max(width, height));
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { hasAlphaChannel: false };

  // The canvas starts transparent, so anything the source does not paint over
  // stays transparent - which is exactly the signal we want.
  context.clearRect(0, 0, sampleWidth, sampleHeight);
  try {
    context.drawImage(source, 0, 0, sampleWidth, sampleHeight);
    const hasAlphaChannel = hasTransparentPixels(
      context.getImageData(0, 0, sampleWidth, sampleHeight).data,
    );
    return { hasAlphaChannel, thumbnailUri: canvas.toDataURL('image/png') };
  } catch {
    // A tainted canvas cannot be read; assume opaque rather than guessing.
    return { hasAlphaChannel: false };
  }
}

/** Read duration, dimensions and transparency straight from the decoder. */
export async function probeMediaElement(uri: string, kind: MediaKind): Promise<ElementProbe> {
  if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = uri;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out reading audio metadata')), METADATA_TIMEOUT_MS);
      audio.addEventListener(
        'loadedmetadata',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      audio.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('The browser could not decode this audio file'));
        },
        { once: true },
      );
    });

    return {
      durationSeconds: Number.isFinite(audio.duration) ? audio.duration : 0,
      width: 0,
      height: 0,
      hasAlphaChannel: false,
    };
  }

  if (kind === 'image') {
    const image = new Image();
    image.decoding = 'async';
    image.src = uri;
    await waitForMetadata(image);

    return {
      durationSeconds: 0,
      width: image.naturalWidth,
      height: image.naturalHeight,
      ...sampleFrame(image, image.naturalWidth, image.naturalHeight),
    };
  }

  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = uri;
  await waitForMetadata(video);

  // Measured before the poster seek, since it plays the video briefly.
  const fps = await measureFrameRate(video);

  // Frame zero of a real clip is often black or a fade-in, so the poster comes
  // from a little way in. A seek failure just leaves the first frame in place.
  if (Number.isFinite(video.duration) && video.duration > 0.5) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 3000);
      video.addEventListener('seeked', done, { once: true });
      video.currentTime = Math.min(video.duration * 0.1, 2);
    });
  }

  return {
    durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
    width: video.videoWidth,
    height: video.videoHeight,
    ...(fps ? { fps } : {}),
    ...sampleFrame(video, video.videoWidth, video.videoHeight),
  };
}
