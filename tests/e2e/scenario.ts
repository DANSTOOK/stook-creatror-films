import type { ExportPipeMode, HardwareEncoder, MediaAsset, ProjectState } from '@shared/types';
import { FrameRenderer } from '@renderer/engine/FrameRenderer';
import { createClip, createEmptyProject, DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';
import { splitClip, trimClipEnd, trimClipStart } from '@renderer/components/Timeline/timelineOps';
import { mimeForFile, settingsFromAsset } from '@renderer/media/importMedia';
import { probeMediaElement } from '@renderer/engine/probeMedia';
import { WebCodecsEncoder, detectCodecSupport } from '@renderer/engine/WebCodecsEncoder';
import { createId } from '@shared/utils/id';
import { recommendedAudioBitrateKbps, recommendedBitrateKbps } from '@shared/utils/bitrate';
import { renderTimelineAudio } from '@renderer/audio/renderMix';

/**
 * End-to-end scenario: import, edit, export.
 *
 * Runs inside a real Electron renderer against the real compositor and the real
 * FFmpeg pipe - the point is to exercise the path that unit tests cannot reach,
 * so nothing here is stubbed.
 */

export interface E2EInput {
  videoPath: string;
  /** Empty to skip the transparent overlay. */
  spritePath: string;
  mp4Output: string;
  /** Empty to skip the PNG sequence export. */
  pngOutput: string;
  /**
   * Export through the same path the export dialog uses, WebCodecs included,
   * rather than forcing the raw RGBA pipe.
   */
  useRealExportPath?: boolean;
  /** Force one ffmpeg encoder instead of the default; empty keeps the default. */
  encoder?: string;
  /** Frame range to export; defaults to the scripted 10-70. */
  startFrame?: number;
  endFrame?: number;
  /**
   * Directory for the colour-fidelity frame: one clip, no effects, no
   * transform, rendered 1:1 so it can be diffed against ffmpeg's own decode.
   */
  colourFramePath?: string;
  colourFrame?: number;
}

export interface E2EResult {
  ok: boolean;
  steps: string[];
  error?: string;
  /** Anything the renderer logged as a warning or error during the run. */
  consoleIssues?: string[];
  exportPath?: string;
  probe?: { width: number; height: number; durationSeconds: number; fps?: number };
  project?: { fps: number; width: number; height: number };
  edit?: {
    clipsAfterSplit: number;
    leftDuration: number;
    rightDuration: number;
    totalFrames: number;
  };
  render?: {
    framesRendered: number;
    nonBlankFrames: number;
    spriteAlphaPixels: number;
    duplicateFrames: number;
    exportFps: number;
  };
}

const log: string[] = [];
const step = (message: string): void => {
  log.push(message);
};

/**
 * Capture anything the app complains about.
 *
 * A silent console is part of what "it works" means; a warning that only ever
 * appears in a devtools panel nobody has open is not a passing result.
 */
const consoleIssues: string[] = [];
function captureConsole(): void {
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      consoleIssues.push(`[${level}] ${args.map((a) => String(a)).join(' ')}`);
      original(...args);
    };
  }

  window.addEventListener('error', (event) => {
    consoleIssues.push(`[uncaught] ${event.message}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    consoleIssues.push(`[unhandled promise] ${String(event.reason)}`);
  });
}

async function loadAsset(path: string, fps: number): Promise<MediaAsset> {
  const bytes = await window.filmora.readFile(path);
  const name = path.split(/[\\/]/).pop() ?? 'media';
  const isImage = /\.(png|webp|gif)$/i.test(name);
  const uri = URL.createObjectURL(new Blob([bytes], { type: mimeForFile(name) }));

  // The main process knows the exact rate; the element measurement is the
  // fallback, exactly as the real import does it.
  const nativeProbe = await window.filmora.probeMedia(path).catch(() => null);
  const probe = await probeMediaElement(uri, isImage ? 'image' : 'video');

  return {
    id: createId('asset'),
    name,
    uri,
    sourcePath: path,
    kind: isImage ? 'image' : 'video',
    durationFrames: isImage ? fps * 2 : Math.max(1, Math.round(probe.durationSeconds * fps)),
    width: probe.width,
    height: probe.height,
    hasAlphaChannel: probe.hasAlphaChannel,
    ...(nativeProbe?.fps || probe.fps ? { sourceFps: nativeProbe?.fps ?? probe.fps } : {}),
  };
}

/** Wait until every registered source has decoded at least one frame. */
async function waitForSources(renderer: FrameRenderer, uris: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (uris.every((uri) => renderer.media.isReady(uri))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for media to decode');
}

export async function runScenario(input: E2EInput): Promise<E2EResult> {
  captureConsole();

  try {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);

    /* --- Import --------------------------------------------------------- */

    // Probe at a provisional rate, then adopt the source's own settings the way
    // an empty project does on first import.
    const provisional = await loadAsset(input.videoPath, 30);
    const adopted = settingsFromAsset(provisional);
    const fps = adopted?.fps ?? 30;
    const width = adopted?.width ?? 1920;
    const height = adopted?.height ?? 1080;

    step(`source: ${provisional.width}x${provisional.height} @ ${provisional.sourceFps ?? '?'} fps`);
    step(`project adopted: ${width}x${height} @ ${fps} fps`);

    // Re-derive the duration against the adopted rate.
    const video: MediaAsset = {
      ...provisional,
      durationFrames: Math.max(
        1,
        Math.round((provisional.durationFrames / 30) * fps),
      ),
    };
    step(`clip length: ${video.durationFrames} frames (${(video.durationFrames / fps).toFixed(1)}s)`);

    canvas.width = width;
    canvas.height = height;

    const sprite = input.spritePath ? await loadAsset(input.spritePath, fps) : null;
    if (sprite) step(`overlay: ${sprite.name} (alpha=${sprite.hasAlphaChannel})`);

    /* --- Build and edit the project ------------------------------------- */

    let project: ProjectState = {
      ...createEmptyProject(width, height, fps),
      currentFrame: 0,
    };
    const videoTrack = project.tracks[0];
    const overlayTrack = project.tracks[1];

    const startFrame = input.startFrame ?? 10;
    const endFrame = Math.min(input.endFrame ?? 70, video.durationFrames);

    let clip = createClip({
      trackId: videoTrack.id,
      name: video.name,
      sourceUri: video.uri,
      startFrame: 0,
      durationFrames: video.durationFrames,
    });

    // Trim both ends, the way an editor would top and tail a take.
    clip = trimClipStart(clip, startFrame);
    clip = trimClipEnd(clip, endFrame);
    step(`trimmed to frames ${clip.startFrame}-${clip.startFrame + clip.durationFrames}`);

    // Razor the remainder in half.
    const cutFrame = clip.startFrame + Math.floor(clip.durationFrames / 2);
    const halves = splitClip(clip, cutFrame);
    if (!halves) throw new Error(`split at ${cutFrame} returned null`);
    const [left, right] = halves;
    step(`split at frame ${cutFrame} into ${left.durationFrames}f + ${right.durationFrames}f`);

    // Grade the right half so the two halves are visibly different.
    right.colorGrading = {
      ...right.colorGrading,
      enabled: true,
      saturation: 0,
      contrast: 1.3,
    };

    // Animate a scale ramp on the first half, so keyframes are exercised too.
    left.transform.scale = [
      { id: 'k1', frame: left.startFrame, value: { x: 1, y: 1 }, easing: 'easeOut' },
      {
        id: 'k2',
        frame: left.startFrame + left.durationFrames,
        value: { x: 1.25, y: 1.25 },
        easing: 'linear',
      },
    ];
    step('added an eased scale ramp to the first half');

    const clips: Record<string, (typeof left)> = { [left.id]: left, [right.id]: right };

    if (sprite) {
      const overlay = createClip({
        trackId: overlayTrack.id,
        name: sprite.name,
        sourceUri: sprite.uri,
        startFrame,
        durationFrames: endFrame - startFrame,
        hasAlphaChannel: true,
      });
      overlay.transform.position = [
        { id: 'p1', frame: startFrame, value: { x: -width / 3, y: 0 }, easing: 'easeOut' },
        { id: 'p2', frame: endFrame, value: { x: width / 3, y: 0 }, easing: 'linear' },
      ];
      overlay.transform.scale = [
        { id: 'p3', frame: startFrame, value: { x: 0.4, y: 0.4 }, easing: 'linear' },
      ];
      clips[overlay.id] = overlay;
      step('added animated transparent overlay on track 2');
    }

    project = { ...project, clips, durationFrames: endFrame };

    /* --- Render --------------------------------------------------------- */

    const renderer = new FrameRenderer(canvas, width, height, { showTransparencyGrid: false });
    const sources = [video, ...(sprite ? [sprite] : [])];
    renderer.registerAssets(sources);
    await waitForSources(renderer, sources.map((asset) => asset.uri));
    step('sources decoded');

    /* --- Export --------------------------------------------------------- */

    const baseSettings = {
      ...DEFAULT_EXPORT_SETTINGS,
      format: 'mp4-h264' as const,
      outputPath: input.mp4Output,
      width,
      height,
      fps,
      // Mirror what the export dialog does on open. Taking the default here
      // would exercise a 1080p bitrate on whatever the project actually is.
      bitrateKbps: recommendedBitrateKbps(width, height, fps),
      startFrame,
      endFrame,
      exportAlpha: false,
      pipeMode: 'rawvideo' as ExportPipeMode,
      ...(input.encoder ? { hardwareEncoder: input.encoder as HardwareEncoder } : {}),
    };
    step(`encoder: ${input.encoder || 'default'}`);
    step(`bitrate: ${(baseSettings.bitrateKbps / 1000).toFixed(1)} Mbps for ${width}x${height}@${fps}`);

    // The dialog picks WebCodecs when the platform supports it; mirroring that
    // here is the difference between testing the export and testing a fallback.
    const support = input.useRealExportPath ? await detectCodecSupport(baseSettings) : null;
    const settings: typeof baseSettings & { audioPath?: string; audioBitrateKbps?: number } = {
      ...baseSettings,
      pipeMode: support ? support.pipeMode : ('rawvideo' as const),
    };
    const exportPath = support ? `WebCodecs (${support.codec})` : 'raw RGBA pipe';
    step(`export path: ${exportPath}`);

    const gl = renderer.compositor.context;
    const glErrors: number[] = [];

    /** Cheap content hash, enough to spot a frame that never advanced. */
    const hashFrame = (bytes: Uint8Array): number => {
      let hash = 2166136261;
      for (let i = 0; i < bytes.length; i += 997) {
        hash = Math.imul(hash ^ bytes[i], 16777619);
      }
      return hash >>> 0;
    };

    // Render the audio mix first, exactly as the dialog does.
    const mix = await renderTimelineAudio(project, [video], startFrame, endFrame);
    if (mix) {
      step(
        `audio mix: ${mix.clipsMixed} clip(s), ${mix.channels}ch @ ${mix.sampleRate}Hz, ` +
          `${mix.durationSeconds.toFixed(2)}s, peak ${mix.peak.toFixed(3)}`,
      );
      settings.audioPath = await window.filmora.writeExportAudio(mix.wav);
      settings.audioBitrateKbps = recommendedAudioBitrateKbps(mix.channels);
      step(`audio written to: ${settings.audioPath ?? '(nothing returned)'}`);
    } else {
      step('audio mix: nothing audible in range');
    }

    const job = await window.filmora.exportStart(settings);
    const encoder = support
      ? new WebCodecsEncoder(settings, support, {
          onChunk: (bytes) => window.filmora.exportFrame(job.jobId, bytes.buffer as ArrayBuffer),
          onError: (error) => consoleIssues.push(`[encoder] ${error.message}`),
        })
      : null;

    let framesRendered = 0;
    let nonBlankFrames = 0;
    let duplicateFrames = 0;
    let previousHash: number | null = null;
    const exportStarted = performance.now();

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      if (encoder) {
        await renderer.renderExactToCanvas(project, frame);
        await encoder.encodeCanvas(renderer.canvas);
        framesRendered += 1;
        // Duplicates are detected from the finished file for this path.
        nonBlankFrames += 1;
      } else {
        const rgba = await renderer.renderExact(project, frame, false);
        framesRendered += 1;
        if (rgba.some((byte) => byte !== 0)) nonBlankFrames += 1;

        const hash = hashFrame(rgba);
        if (previousHash !== null && hash === previousHash) duplicateFrames += 1;
        previousHash = hash;

        await window.filmora.exportFrame(job.jobId, rgba.buffer as ArrayBuffer);
      }

      const error = gl.getError();
      if (error !== gl.NO_ERROR && !glErrors.includes(error)) glErrors.push(error);
    }

    await encoder?.finish();
    await window.filmora.exportFinish(job.jobId);

    const totalMs = performance.now() - exportStarted;
    if (glErrors.length > 0) {
      step(`GL errors during render: ${glErrors.map((e) => `0x${e.toString(16)}`).join(', ')}`);
    }
    step(
      `export timing: ${(totalMs / 1000).toFixed(1)}s total, ` +
        `${(framesRendered / (totalMs / 1000)).toFixed(1)} fps`,
    );
    step(`exported ${framesRendered} frames to MP4`);

    /* --- PNG sequence with alpha ---------------------------------------- */

    let spriteAlphaPixels = 0;
    if (input.pngOutput && sprite) {
      const spriteOnly: ProjectState = {
        ...project,
        hasAlphaBackground: true,
        tracks: project.tracks.map((track) =>
          track.id === videoTrack.id ? { ...track, visible: false } : track,
        ),
      };

      const pngStart = startFrame;
      const pngEnd = Math.min(startFrame + 10, endFrame);
      const pngJob = await window.filmora.exportStart({
        ...baseSettings,
        format: 'png-sequence' as const,
        outputPath: input.pngOutput,
        exportAlpha: true,
        premultiplyAlpha: false,
        startFrame: pngStart,
        endFrame: pngEnd,
      });

      for (let frame = pngStart; frame < pngEnd; frame += 1) {
        const rgba = await renderer.renderExact(spriteOnly, frame, false);
        for (let i = 3; i < rgba.length; i += 4) {
          if (rgba[i] > 0 && rgba[i] < 255) spriteAlphaPixels += 1;
        }
        await window.filmora.exportFrame(pngJob.jobId, rgba.buffer as ArrayBuffer);
      }
      await window.filmora.exportFinish(pngJob.jobId);
      step(`exported PNG sequence (${spriteAlphaPixels} partial-alpha pixels)`);
    }

    /* --- Colour fidelity ------------------------------------------------- */

    // One clip, nothing applied to it, rendered at native size. Any difference
    // against ffmpeg's decode of the same frame is the compositor's doing -
    // colour primaries, TV/full range handling, or sampling.
    if (input.colourFramePath) {
      const colourFrame = input.colourFrame ?? 0;

      // The clip must reference a track that exists in THIS project: a fresh
      // project has fresh track ids, and a clip pointing at the old ones is
      // filtered out as invisible, rendering a black frame.
      const cleanBase = createEmptyProject(width, height, fps);
      const cleanClip = createClip({
        trackId: cleanBase.tracks[0].id,
        name: video.name,
        sourceUri: video.uri,
        startFrame: 0,
        durationFrames: video.durationFrames,
      });

      const cleanProject: ProjectState = {
        ...cleanBase,
        clips: { [cleanClip.id]: cleanClip },
        durationFrames: video.durationFrames,
      };

      const colourJob = await window.filmora.exportStart({
        ...baseSettings,
        format: 'png-sequence' as const,
        outputPath: input.colourFramePath,
        exportAlpha: false,
        startFrame: colourFrame,
        endFrame: colourFrame + 1,
        pipeMode: 'rawvideo' as ExportPipeMode,
      });

      const rgba = await renderer.renderExact(cleanProject, colourFrame, false);
      await window.filmora.exportFrame(colourJob.jobId, rgba.buffer as ArrayBuffer);
      await window.filmora.exportFinish(colourJob.jobId);
      step(`colour reference frame ${colourFrame} rendered untouched at ${width}x${height}`);
    }

    renderer.dispose();

    return {
      ok: true,
      steps: log,
      consoleIssues,
      exportPath,
      probe: {
        width: video.width,
        height: video.height,
        durationSeconds: video.durationFrames / fps,
        ...(video.sourceFps ? { fps: video.sourceFps } : {}),
      },
      project: { fps, width, height },
      edit: {
        clipsAfterSplit: Object.keys(project.clips).length,
        leftDuration: left.durationFrames,
        rightDuration: right.durationFrames,
        totalFrames: endFrame - startFrame,
      },
      render: {
        framesRendered,
        nonBlankFrames,
        spriteAlphaPixels,
        duplicateFrames,
        exportFps: Number((framesRendered / (totalMs / 1000)).toFixed(2)),
      },
    };
  } catch (error) {
    return {
      ok: false,
      steps: log,
      consoleIssues,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    };
  }
}
