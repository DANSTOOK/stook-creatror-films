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
function detectAlpha(source: CanvasImageSource, width: number, height: number): boolean {
  if (width === 0 || height === 0) return false;

  const scale = Math.min(1, 128 / Math.max(width, height));
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return false;

  // The canvas starts transparent, so anything the source does not paint over
  // stays transparent - which is exactly the signal we want.
  context.clearRect(0, 0, sampleWidth, sampleHeight);
  try {
    context.drawImage(source, 0, 0, sampleWidth, sampleHeight);
    return hasTransparentPixels(context.getImageData(0, 0, sampleWidth, sampleHeight).data);
  } catch {
    // A tainted canvas cannot be read; assume opaque rather than guessing.
    return false;
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
      hasAlphaChannel: detectAlpha(image, image.naturalWidth, image.naturalHeight),
    };
  }

  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = uri;
  await waitForMetadata(video);

  return {
    durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
    width: video.videoWidth,
    height: video.videoHeight,
    hasAlphaChannel: detectAlpha(video, video.videoWidth, video.videoHeight),
  };
}
