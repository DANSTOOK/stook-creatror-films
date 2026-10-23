/**
 * Files made from an export rather than encoded by it: a GIF from the
 * rendered video, and the sound alone - MP3 or WAV - from the rendered mix.
 *
 * A GIF is made in one ffmpeg pass that first finds the 256 colours the clip
 * needs (palettegen) and then draws every frame with them (paletteuse), as
 * the GIF tools of every editor do; anything else banding and dithering
 * badly. The mix arrives as the raw 32-bit float samples the video export
 * already renders (ExportDialog), so the sound alone costs no picture at all.
 */

export type DeliverableKind = 'gif' | 'mp3' | 'wav';

export interface GifOptions {
  /** Frames a second: a GIF's size grows with every one. */
  fps: number;
  /** Width in pixels; the height follows the picture's shape. */
  width: number;
}

export const GIF_FPS_CHOICES = [10, 15, 24] as const;
export const GIF_WIDTH_CHOICES = [320, 480, 640, 960] as const;

export function gifArgs(source: string, target: string, options: GifOptions): string[] {
  const fps = Math.max(1, Math.min(50, Math.round(options.fps)));
  const width = Math.max(16, Math.min(3840, Math.round(options.width / 2) * 2));
  return [
    '-hide_banner', '-v', 'error', '-y',
    '-i', source,
    '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
    '-loop', '0',
    target,
  ];
}

export function audioArgs(source: string, format: { sampleRate: number; channels: number }, target: string, kind: 'mp3' | 'wav'): string[] {
  return [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'f32le', '-ar', String(format.sampleRate), '-ac', String(format.channels), '-i', source,
    ...(kind === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'pcm_s16le']),
    target,
  ];
}
