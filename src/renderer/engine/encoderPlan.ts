import type {
  EncoderOption,
  ExportPipeMode,
  ExportSettings,
  GpuDevice,
  GpuEncoder,
  HardwareEncoder,
} from '@shared/types';
import type { CodecSupport } from './WebCodecsEncoder';

/**
 * Decide, for one render, which silicon encodes it.
 *
 * Before this existed the dialog offered a hardware encoder and then ignored
 * it: whenever WebCodecs could take an MP4, the render went through WebCodecs
 * whatever had been picked. Choosing "NVIDIA NVENC" changed nothing. Now:
 *
 * - an explicit encoder is honoured exactly, through ffmpeg;
 * - "CPU" is honoured exactly;
 * - "Automatic" prefers WebCodecs (the frame never leaves the GPU), then the
 *   hardware encoder on the GPU the compositor is running on, then the CPU.
 *
 * Formats with alpha, and the non-MP4 formats, always encode on the CPU: no
 * hardware encoder carries an alpha plane, and ProRes/VP9/PNG are software
 * codecs in ffmpeg.
 */

export interface EncoderPlan {
  pipeMode: ExportPipeMode;
  /** Resolved - never `auto`. */
  hardwareEncoder: Exclude<HardwareEncoder, 'auto'>;
  /** One line for the dialog and the "export finished" message. */
  label: string;
  /** Set when the request could not be honoured as asked, and why. */
  note: string | null;
}

export const ENCODER_LABELS: Record<GpuEncoder, string> = {
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel Quick Sync',
  amf: 'AMD AMF',
  videotoolbox: 'Apple VideoToolbox',
};

/** "NVIDIA NVENC - NVIDIA GeForce RTX 4060 Laptop GPU" */
export function describeEncoder(option: EncoderOption): string {
  return option.gpu
    ? `${ENCODER_LABELS[option.encoder]} - ${option.gpu.name}`
    : ENCODER_LABELS[option.encoder];
}

const isMp4 = (settings: ExportSettings): boolean =>
  settings.format === 'mp4-h264' || settings.format === 'mp4-h265';

const cpu = (label: string, note: string | null = null): EncoderPlan => ({
  pipeMode: 'rawvideo',
  hardwareEncoder: 'none',
  label,
  note,
});

export interface EncoderPlanInput {
  settings: ExportSettings;
  /** What WebCodecs offered for these settings, or null. */
  webCodecs: CodecSupport | null;
  /** Encoders that were probed and actually work. */
  encoders: readonly EncoderOption[];
  /** The GPU the compositor is running on. */
  activeGpu: GpuDevice | null;
}

export function resolveEncoderPlan({
  settings,
  webCodecs,
  encoders,
  activeGpu,
}: EncoderPlanInput): EncoderPlan {
  if (!isMp4(settings)) return cpu('CPU (this format has no hardware encoder)');
  if (settings.exportAlpha) return cpu('CPU (hardware encoders cannot carry alpha)');

  const requested = settings.hardwareEncoder;

  if (requested === 'none') return cpu('CPU (software x264 / x265)');

  if (requested !== 'auto') {
    const option = encoders.find((candidate) => candidate.encoder === requested);
    if (option) {
      return {
        pipeMode: 'rawvideo',
        hardwareEncoder: option.encoder,
        label: describeEncoder(option),
        note: null,
      };
    }
    // A saved choice from another machine, or a GPU that has gone away. Say so
    // rather than failing the render or quietly doing something else.
    const fallback = resolveEncoderPlan({
      settings: { ...settings, hardwareEncoder: 'auto' },
      webCodecs,
      encoders,
      activeGpu,
    });
    return {
      ...fallback,
      note: `${ENCODER_LABELS[requested]} is not available on this machine; using ${fallback.label} instead.`,
    };
  }

  if (webCodecs) {
    return {
      pipeMode: webCodecs.pipeMode,
      hardwareEncoder: 'none',
      label: activeGpu ? `GPU via WebCodecs - ${activeGpu.name}` : 'GPU via WebCodecs',
      note: null,
    };
  }

  const onActiveGpu =
    activeGpu &&
    encoders.find(
      (candidate) =>
        candidate.gpu?.vendorId === activeGpu.vendorId &&
        candidate.gpu?.deviceId === activeGpu.deviceId,
    );
  const chosen = onActiveGpu || encoders[0];

  if (chosen) {
    return {
      pipeMode: 'rawvideo',
      hardwareEncoder: chosen.encoder,
      label: describeEncoder(chosen),
      note: null,
    };
  }

  return cpu('CPU (no hardware encoder works on this machine)');
}
