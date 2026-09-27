import type { ExportPipeMode, HardwareEncoder, MediaAsset, ProjectState } from '@shared/types';
import { FrameRenderer } from '@renderer/engine/FrameRenderer';
import { createClip, createEmptyProject, DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';
import { mimeForFile } from '@renderer/media/importMedia';
import { probeMediaElement } from '@renderer/engine/probeMedia';
import { WebCodecsEncoder, detectCodecSupport, measureStreamColour } from '@renderer/engine/WebCodecsEncoder';
import { createId } from '@shared/utils/id';

/**
 * Colour through the export: a still of known patches, exported by every
 * path the export dialog can take, so the runner can decode each file the
 * way a BT.709 player does and compare the patches with what went in.
 *
 * The runner (colour.mjs) makes the still and does the measuring; this only
 * renders and exports, through the real compositor and the real ffmpeg pipe.
 */

export interface ColourInput {
  patchesPath: string;
  /** One output file per path; the runner names them. */
  outputs: { rawvideo: string; webcodecs: string; hardware: string };
  /** An ffmpeg hardware encoder to try on the raw pipe too (nvenc, qsv), or ''. */
  hardwareEncoder: string;
}

export interface ColourResult {
  ok: boolean;
  error?: string;
  /** What actually produced each file, or why it was skipped. */
  paths: Record<string, string>;
}

const FPS = 30;
const FRAMES = 10;

async function loadStill(path: string): Promise<MediaAsset> {
  const bytes = await window.filmora.readFile(path);
  const name = path.split(/[\\/]/).pop() ?? 'patches.png';
  const uri = URL.createObjectURL(new Blob([bytes], { type: mimeForFile(name) }));
  const probe = await probeMediaElement(uri, 'image');
  return {
    id: createId('asset'),
    name,
    uri,
    sourcePath: path,
    kind: 'image',
    durationFrames: FRAMES,
    width: probe.width,
    height: probe.height,
    hasAlphaChannel: false,
  };
}

export async function runColourExport(input: ColourInput): Promise<ColourResult> {
  const paths: Record<string, string> = {};
  try {
    const still = await loadStill(input.patchesPath);
    const { width, height } = still;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    document.body.appendChild(canvas);

    const base = createEmptyProject(width, height, FPS);
    const clip = createClip({
      trackId: base.tracks[0].id,
      name: still.name,
      sourceUri: still.uri,
      startFrame: 0,
      durationFrames: FRAMES,
    });
    const project: ProjectState = { ...base, clips: { [clip.id]: clip }, durationFrames: FRAMES, currentFrame: 0 };

    const renderer = new FrameRenderer(canvas, width, height, { showTransparencyGrid: false });
    renderer.registerAssets([still]);
    const deadline = Date.now() + 20_000;
    while (!renderer.media.isReady(still.uri)) {
      if (Date.now() > deadline) throw new Error('the patches never decoded');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const settingsFor = (outputPath: string, hardwareEncoder: HardwareEncoder, pipeMode: ExportPipeMode) => ({
      ...DEFAULT_EXPORT_SETTINGS,
      format: 'mp4-h264' as const,
      outputPath,
      width,
      height,
      fps: FPS,
      // Generous: the patches are flat, and the point is colour, not compression.
      bitrateKbps: 20_000,
      startFrame: 0,
      endFrame: FRAMES,
      exportAlpha: false,
      hardwareEncoder,
      pipeMode,
    });

    /** The raw RGBA pipe: ffmpeg does the RGB to YUV conversion. */
    const exportRaw = async (outputPath: string, encoder: HardwareEncoder): Promise<void> => {
      const job = await window.filmora.exportStart(settingsFor(outputPath, encoder, 'rawvideo'));
      for (let frame = 0; frame < FRAMES; frame += 1) {
        const rgba = await renderer.renderExact(project, frame, false);
        await window.filmora.exportFrame(job.jobId, rgba.buffer as ArrayBuffer);
      }
      await window.filmora.exportFinish(job.jobId);
    };

    await exportRaw(input.outputs.rawvideo, 'none');
    paths.rawvideo = 'raw RGBA pipe, libx264';

    if (input.hardwareEncoder) {
      try {
        await exportRaw(input.outputs.hardware, input.hardwareEncoder as HardwareEncoder);
        paths.hardware = `raw RGBA pipe, ${input.hardwareEncoder}`;
      } catch (error) {
        paths.hardware = `skipped: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      paths.hardware = 'skipped: no hardware encoder asked for';
    }

    // WebCodecs, exactly as the export dialog picks it.
    const webSettings = settingsFor(input.outputs.webcodecs, 'auto', 'rawvideo');
    const support = await detectCodecSupport(webSettings);
    if (support) {
      const streamColour = await measureStreamColour(webSettings, support);
      const settings = { ...webSettings, pipeMode: support.pipeMode, ...(streamColour ? { streamColour } : {}) };
      const job = await window.filmora.exportStart(settings);
      const encoder = new WebCodecsEncoder(settings, support, {
        onChunk: (bytes) => window.filmora.exportFrame(job.jobId, bytes.buffer as ArrayBuffer),
        onError: () => undefined,
      });
      for (let frame = 0; frame < FRAMES; frame += 1) {
        await renderer.renderExactToCanvas(project, frame);
        await encoder.encodeCanvas(renderer.canvas);
      }
      await encoder.finish();
      await window.filmora.exportFinish(job.jobId);
      paths.webcodecs = `WebCodecs (${support.codec}), encoder measured as ${streamColour ? `${streamColour.matrix} ${streamColour.fullRange ? 'full' : 'tv'}` : 'unknown'}`;
    } else {
      paths.webcodecs = 'skipped: WebCodecs offers no H.264 encoder here';
    }

    renderer.dispose();
    return { ok: true, paths };
  } catch (error) {
    return { ok: false, paths, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) };
  }
}
