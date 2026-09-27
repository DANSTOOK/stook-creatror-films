import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import type { ExportFormat, ExportSettings, GpuEncoder, HardwareEncoder } from '@shared/types';

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

const HARDWARE_ENCODER_PROBES: Record<GpuEncoder, string> = {
  nvenc: 'h264_nvenc',
  qsv: 'h264_qsv',
  videotoolbox: 'h264_videotoolbox',
  amf: 'h264_amf',
};

/** Encoders worth probing on each OS; VideoToolbox only exists on macOS. */
const PROBES_BY_PLATFORM: Record<string, GpuEncoder[]> = {
  win32: ['nvenc', 'qsv', 'amf'],
  linux: ['nvenc', 'qsv', 'amf'],
  darwin: ['videotoolbox'],
};

/**
 * Arguments that make ffmpeg encode a handful of frames with `codec` and throw
 * them away. It exits 0 only if the encoder opened a real device and produced
 * output - which is the whole point.
 */
export function encoderProbeArgs(codec: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=256x256:r=30,format=rgba',
    '-frames:v', '5',
    '-c:v', codec,
    '-pix_fmt', 'yuv420p',
    '-f', 'null',
    '-',
  ];
}

let cachedEncoders: Promise<GpuEncoder[]> | null = null;

/**
 * Find the hardware encoders that ACTUALLY work on this machine.
 *
 * Asking ffmpeg which encoders it was built with (`-encoders`) is not the same
 * question: the bundled build lists NVENC, QuickSync and AMF everywhere. On the
 * reference machine (RTX 4060 + Intel UHD) `h264_amf` is listed and fails with
 * "AMFQueryVersion failed", because there is no AMD GPU - so offering it meant
 * offering an export that could only fail. Each candidate is therefore made to
 * encode five frames, in parallel, and only the ones that succeed are offered.
 */
export function probeHardwareEncoders(): Promise<GpuEncoder[]> {
  if (cachedEncoders) return cachedEncoders;

  const candidates = PROBES_BY_PLATFORM[process.platform] ?? [];
  const ffmpeg = resolveFfmpegPath();

  cachedEncoders = Promise.all(
    candidates.map(async (encoder) => {
      try {
        await execFileAsync(ffmpeg, encoderProbeArgs(HARDWARE_ENCODER_PROBES[encoder]), {
          timeout: 15_000,
          windowsHide: true,
        });
        return encoder;
      } catch {
        return null;
      }
    }),
  ).then((results) => results.filter((encoder): encoder is GpuEncoder => encoder !== null));

  return cachedEncoders;
}

/** Kept for the IPC surface: `none` (the CPU) plus whatever really works. */
export async function detectHardwareEncoders(): Promise<HardwareEncoder[]> {
  return ['none', ...(await probeHardwareEncoders())];
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
 * The colour tags every YUV export carries: Rec.709 primaries, transfer and
 * matrix, TV (limited) range. What Resolve and Premiere write for HD SDR.
 */
export const REC709_TAGS: readonly string[] = [
  '-colorspace', 'bt709',
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-color_range', 'tv',
];

/**
 * Bitstream filter that writes the colour tags into a WebCodecs stream.
 *
 * The stream arrives already encoded, so nothing can be converted here -
 * only described. It is described as what the platform encoder actually did,
 * measured by the renderer (`streamColour`): Rec.709 primaries and transfer
 * always, and the matrix and range it really used. Tagging an encoder that
 * used BT.601 as BT.709 would be the same colour shift the raw pipe had.
 * Nothing is written when it could not be measured.
 */
export function streamColourFilter(settings: ExportSettings): string[] {
  const colour = settings.streamColour;
  if (!colour || settings.pipeMode === 'rawvideo') return [];
  const filter = settings.pipeMode === 'annexb-hevc' ? 'hevc_metadata' : 'h264_metadata';
  // H.273 code points: 1 is BT.709; 6 is SMPTE 170M, the BT.601 matrix.
  const matrix = colour.matrix === 'bt709' ? 1 : 6;
  return [
    `${filter}=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=${matrix}:video_full_range_flag=${colour.fullRange ? 1 : 0}`,
  ];
}

/**
 * The filter between the RGBA pipe and the encoder: nearest-neighbour
 * scaling for pixel art, and - for every YUV format - the RGB to YUV
 * conversion itself, spelled out.
 *
 * Left to itself, ffmpeg's scaler converts RGB with the BT.601 matrix and
 * writes no colour tags. Players read an untagged HD file as BT.709, so pure
 * red played back as 255,23,0 and pure green as 0,215,0 - measured on this
 * app's own exports. The matrix is named here, the range with it, and the
 * file is tagged to match (REC709_TAGS), so every player decodes it the way
 * it was encoded. A PNG sequence stays RGB: no matrix is involved.
 */
export function scaleFilterArgs(settings: ExportSettings): string[] {
  const yuv = settings.format !== 'png-sequence';
  const scale: string[] = [];
  if (settings.pixelArtScaling) scale.push(`${settings.width}:${settings.height}:flags=neighbor`);
  if (yuv) scale.push('out_color_matrix=bt709:out_range=tv');
  if (scale.length === 0) return [];
  return [
    ...(settings.pixelArtScaling ? ['-sws_flags', 'neighbor'] : []),
    '-vf',
    `scale=${scale.join(':')}`,
    ...(yuv ? REC709_TAGS : []),
  ];
}

/**
 * Explain, in one line, any way the chosen settings will not do what the user
 * asked. Surfaced in the export dialog instead of failing silently.
 */
export function describeAlphaFallback(settings: ExportSettings): string | null {
  if (!settings.exportAlpha) return null;
  if (FORMAT_SUPPORTS_ALPHA[settings.format]) {
    if (settings.hardwareEncoder !== 'none' && settings.hardwareEncoder !== 'auto' && settings.format !== 'png-sequence') {
      return 'Hardware encoders cannot carry alpha; this render will use a software encoder.';
    }
    return null;
  }
  return `${settings.format} has no alpha channel. Choose PNG sequence, ProRes 4444 or WebM/VP9 to keep transparency.`;
}
