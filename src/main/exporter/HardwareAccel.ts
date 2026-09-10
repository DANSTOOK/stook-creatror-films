import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import type { ExportFormat, ExportSettings, HardwareEncoder } from '@shared/types';

const execFileAsync = promisify(execFile);

/**
 * Hardware encoder discovery and codec argument construction.
 *
 * Alpha is the constraint that drives most of this: NVENC, QuickSync and
 * VideoToolbox all encode H.264/HEVC, and none of them carry an alpha channel.
 * So whenever `exportAlpha` is on, the pipeline falls back to a software codec
 * that can (ProRes 4444, VP9 with yuva420p, or a PNG sequence) rather than
 * silently flattening the transparency a sprite export depends on.
 */

/** ffmpeg-static ships a binary; fall back to whatever is on PATH. */
export function resolveFfmpegPath(): string {
  // Inside a packaged app the binary lives in the unpacked asar directory.
  if (ffmpegStatic) return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
  return 'ffmpeg';
}

const HARDWARE_ENCODER_PROBES: Record<Exclude<HardwareEncoder, 'none'>, string> = {
  nvenc: 'h264_nvenc',
  qsv: 'h264_qsv',
  videotoolbox: 'h264_videotoolbox',
  amf: 'h264_amf',
};

let cachedEncoders: HardwareEncoder[] | null = null;

/** Ask ffmpeg which encoders this build exposes. Result is cached per session. */
export async function detectHardwareEncoders(): Promise<HardwareEncoder[]> {
  if (cachedEncoders) return cachedEncoders;

  try {
    const { stdout } = await execFileAsync(resolveFfmpegPath(), ['-hide_banner', '-encoders'], {
      maxBuffer: 8 * 1024 * 1024,
    });

    const available: HardwareEncoder[] = ['none'];
    for (const [encoder, probe] of Object.entries(HARDWARE_ENCODER_PROBES)) {
      if (stdout.includes(probe)) available.push(encoder as HardwareEncoder);
    }
    cachedEncoders = available;
  } catch {
    // A missing or unreadable ffmpeg means software-only.
    cachedEncoders = ['none'];
  }

  return cachedEncoders;
}

/** Formats that actually carry an alpha channel to disk. */
export const FORMAT_SUPPORTS_ALPHA: Record<ExportFormat, boolean> = {
  'png-sequence': true,
  prores4444: true,
  'webm-vp9': true,
  'mp4-h264': false,
  'mp4-h265': false,
};

const hardwareCodec = (
  encoder: HardwareEncoder,
  family: 'h264' | 'hevc',
): string | null => {
  switch (encoder) {
    case 'nvenc':
      return `${family}_nvenc`;
    case 'qsv':
      return `${family}_qsv`;
    case 'videotoolbox':
      return `${family}_videotoolbox`;
    case 'amf':
      return family === 'h264' ? 'h264_amf' : 'hevc_amf';
    default:
      return null;
  }
};

/**
 * Output-side ffmpeg arguments for a format.
 *
 * Returns the codec, pixel format and rate-control flags - not the input or
 * output path, which `EncoderPipeline` owns.
 */
export function videoCodecArgs(settings: ExportSettings): string[] {
  const alpha = settings.exportAlpha && FORMAT_SUPPORTS_ALPHA[settings.format];
  const bitrate = `${Math.max(500, settings.bitrateKbps)}k`;

  switch (settings.format) {
    case 'png-sequence':
      // A PNG sequence is the most portable sprite-sheet source for Godot:
      // lossless, straight alpha, one file per frame.
      return ['-c:v', 'png', '-pix_fmt', alpha ? 'rgba' : 'rgb24'];

    case 'prores4444':
      return [
        '-c:v',
        'prores_ks',
        '-profile:v',
        alpha ? '4444' : '3',
        '-pix_fmt',
        alpha ? 'yuva444p10le' : 'yuv422p10le',
        ...(alpha ? ['-alpha_bits', '16'] : []),
        '-vendor',
        'apl0',
      ];

    case 'webm-vp9':
      return [
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        alpha ? 'yuva420p' : 'yuv420p',
        // alt-ref frames discard the alpha plane, so they must stay off for
        // transparent WebM.
        ...(alpha ? ['-auto-alt-ref', '0'] : []),
        '-b:v',
        bitrate,
        '-row-mt',
        '1',
      ];

    case 'mp4-h265': {
      const codec = hardwareCodec(settings.hardwareEncoder, 'hevc') ?? 'libx265';
      return ['-c:v', codec, '-pix_fmt', 'yuv420p', '-b:v', bitrate, '-tag:v', 'hvc1'];
    }

    case 'mp4-h264':
    default: {
      const codec = hardwareCodec(settings.hardwareEncoder, 'h264') ?? 'libx264';
      const softwareTuning = codec === 'libx264' ? ['-preset', 'medium', '-crf', '18'] : ['-b:v', bitrate];
      return ['-c:v', codec, '-pix_fmt', 'yuv420p', ...softwareTuning];
    }
  }
}

/**
 * Scaling filter. Nearest-neighbour is what keeps pixel-art sprites from being
 * blurred into mush when the project is upscaled on the way out.
 */
export function scaleFilterArgs(settings: ExportSettings): string[] {
  if (!settings.pixelArtScaling) return [];
  return ['-sws_flags', 'neighbor', '-vf', `scale=${settings.width}:${settings.height}:flags=neighbor`];
}

/**
 * Explain, in one line, any way the chosen settings will not do what the user
 * asked. Surfaced in the export dialog instead of failing silently.
 */
export function describeAlphaFallback(settings: ExportSettings): string | null {
  if (!settings.exportAlpha) return null;
  if (FORMAT_SUPPORTS_ALPHA[settings.format]) {
    if (settings.hardwareEncoder !== 'none' && settings.format !== 'png-sequence') {
      return 'Hardware encoders cannot carry alpha; this render will use a software encoder.';
    }
    return null;
  }
  return `${settings.format} has no alpha channel. Choose PNG sequence, ProRes 4444 or WebM/VP9 to keep transparency.`;
}
