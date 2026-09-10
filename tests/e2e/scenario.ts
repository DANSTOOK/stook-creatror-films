import type { MediaAsset, ProjectState } from '@shared/types';
import { FrameRenderer } from '@renderer/engine/FrameRenderer';
import { createClip, createEmptyProject, DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';
import { splitClip, trimClipEnd, trimClipStart } from '@renderer/components/Timeline/timelineOps';
import { mimeForFile } from '@renderer/media/importMedia';
import { probeMediaElement } from '@renderer/engine/probeMedia';
import { createId } from '@shared/utils/id';

/**
 * End-to-end scenario: import, edit, export.
 *
 * Runs inside a real Electron renderer against the real compositor and the real
 * FFmpeg pipe - the point is to exercise the path that unit tests cannot reach,
 * so nothing here is stubbed.
 */

export interface E2EInput {
  videoPath: string;
  spritePath: string;
  mp4Output: string;
  pngOutput: string;
}

export interface E2EResult {
  ok: boolean;
  steps: string[];
  error?: string;
  probe?: { width: number; height: number; durationSeconds: number };
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

async function loadAsset(path: string, fps: number): Promise<MediaAsset> {
  const bytes = await window.filmora.readFile(path);
  const name = path.split(/[\\/]/).pop() ?? 'media';
  const uri = URL.createObjectURL(new Blob([bytes], { type: mimeForFile(name) }));
  const probe = await probeMediaElement(uri, name.endsWith('.png') ? 'image' : 'video');

  return {
    id: createId('asset'),
    name,
    uri,
    sourcePath: path,
    kind: name.endsWith('.png') ? 'image' : 'video',
    durationFrames: name.endsWith('.png')
      ? fps * 2
      : Math.max(1, Math.round(probe.durationSeconds * fps)),
    width: probe.width,
    height: probe.height,
    hasAlphaChannel: probe.hasAlphaChannel,
  };
}

/** Wait until every registered source has decoded at least one frame. */
async function waitForSources(renderer: FrameRenderer, uris: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (uris.every((uri) => renderer.media.isReady(uri))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for media to decode');
}

export async function runScenario(input: E2EInput): Promise<E2EResult> {
  try {
    const fps = 30 as const;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);

    /* --- Import --------------------------------------------------------- */

    const video = await loadAsset(input.videoPath, fps);
    const sprite = await loadAsset(input.spritePath, fps);
    step(`imported ${video.name} (${video.width}x${video.height}, ${video.durationFrames}f)`);
    step(`imported ${sprite.name} (alpha=${sprite.hasAlphaChannel})`);

    /* --- Build and edit the project ------------------------------------- */

    let project: ProjectState = { ...createEmptyProject(640, 360, fps), currentFrame: 0 };
    const videoTrack = project.tracks[0];
    const overlayTrack = project.tracks[1];

    let clip = createClip({
      trackId: videoTrack.id,
      name: video.name,
      sourceUri: video.uri,
      startFrame: 0,
      durationFrames: video.durationFrames,
    });

    // Trim both ends, the way an editor would top and tail a take.
    clip = trimClipStart(clip, 10);
    clip = trimClipEnd(clip, 70);
    step(`trimmed to frames ${clip.startFrame}-${clip.startFrame + clip.durationFrames}`);

    // Razor the remainder in half.
    const halves = splitClip(clip, 40);
    if (!halves) throw new Error('split returned null');
    const [left, right] = halves;
    step(`split at frame 40 into ${left.durationFrames}f + ${right.durationFrames}f`);

    // Grade the right half so the two halves are visibly different.
    right.colorGrading = {
      ...right.colorGrading,
      enabled: true,
      saturation: 0,
      contrast: 1.3,
    };

    // Animate the transparent sprite across the frame with keyframes.
    const overlay = createClip({
      trackId: overlayTrack.id,
      name: sprite.name,
      sourceUri: sprite.uri,
      startFrame: 10,
      durationFrames: 60,
      hasAlphaChannel: true,
    });
    overlay.transform.position = [
      { id: 'k1', frame: 10, value: { x: -200, y: 0 }, easing: 'easeOut' },
      { id: 'k2', frame: 70, value: { x: 200, y: 0 }, easing: 'linear' },
    ];
    overlay.transform.scale = [{ id: 'k3', frame: 10, value: { x: 0.4, y: 0.4 }, easing: 'linear' }];

    project = {
      ...project,
      clips: { [left.id]: left, [right.id]: right, [overlay.id]: overlay },
      durationFrames: 70,
    };
    step('added animated transparent overlay on track 2');

    /* --- Render --------------------------------------------------------- */

    const renderer = new FrameRenderer(canvas, 640, 360, { showTransparencyGrid: false });
    renderer.registerAssets([video, sprite]);
    await waitForSources(renderer, [video.uri, sprite.uri]);
    step('sources decoded');

    // Diagnostics: what the compositor actually has to work with per source.
    for (const [label, asset] of [['video', video], ['sprite', sprite]] as const) {
      const element = renderer.media.get(asset.uri);
      const size =
        element instanceof HTMLImageElement
          ? `${element.naturalWidth}x${element.naturalHeight} (attr ${element.width}x${element.height})`
          : element instanceof HTMLVideoElement
            ? `${element.videoWidth}x${element.videoHeight}`
            : 'none';
      step(`${label} element: ${element?.constructor.name ?? 'missing'} ${size}`);
    }

    const startFrame = 10;
    const endFrame = 70;

    /* --- Export MP4 ----------------------------------------------------- */

    const mp4Settings = {
      ...DEFAULT_EXPORT_SETTINGS,
      format: 'mp4-h264' as const,
      outputPath: input.mp4Output,
      width: 640,
      height: 360,
      fps,
      startFrame,
      endFrame,
      exportAlpha: false,
      pipeMode: 'rawvideo' as const,
    };

    const mp4Job = await window.filmora.exportStart(mp4Settings);
    let framesRendered = 0;
    let nonBlankFrames = 0;

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

    let previousHash: number | null = null;
    let duplicateFrames = 0;
    let renderMs = 0;
    let encodeMs = 0;
    const exportStarted = performance.now();

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const renderStart = performance.now();
      const rgba = await renderer.renderExact(project, frame, false);
      renderMs += performance.now() - renderStart;

      framesRendered += 1;
      // A frame that is entirely transparent means the composite produced
      // nothing, which would make the whole export meaningless.
      if (rgba.some((byte) => byte !== 0)) nonBlankFrames += 1;

      // A duplicate means the decoder had not reached the requested frame, so
      // the export silently repeats pictures and looks like a lower frame rate.
      const hash = hashFrame(rgba);
      if (previousHash !== null && hash === previousHash) duplicateFrames += 1;
      previousHash = hash;

      const error = gl.getError();
      if (error !== gl.NO_ERROR && !glErrors.includes(error)) glErrors.push(error);

      const encodeStart = performance.now();
      await window.filmora.exportFrame(mp4Job.jobId, rgba.buffer as ArrayBuffer);
      encodeMs += performance.now() - encodeStart;
    }

    const totalMs = performance.now() - exportStarted;
    step(
      `export timing: ${(totalMs / 1000).toFixed(1)}s total, ` +
        `${(framesRendered / (totalMs / 1000)).toFixed(1)} fps ` +
        `(render ${(renderMs / framesRendered).toFixed(1)}ms/frame, ` +
        `pipe ${(encodeMs / framesRendered).toFixed(1)}ms/frame)`,
    );
    step(`duplicate frames: ${duplicateFrames}/${framesRendered}`);
    if (glErrors.length > 0) {
      step(`GL errors during render: ${glErrors.map((e) => `0x${e.toString(16)}`).join(', ')}`);
    }
    await window.filmora.exportFinish(mp4Job.jobId);
    step(`exported MP4: ${framesRendered} frames`);

    /* --- Export PNG sequence with alpha ---------------------------------- */

    // Hide the video track so only the transparent sprite remains: this is the
    // Godot sprite-export path, and the result must keep real transparency.
    const spriteOnly: ProjectState = {
      ...project,
      hasAlphaBackground: true,
      tracks: project.tracks.map((track) =>
        track.id === videoTrack.id ? { ...track, visible: false } : track,
      ),
    };

    const pngSettings = {
      ...mp4Settings,
      format: 'png-sequence' as const,
      outputPath: input.pngOutput,
      exportAlpha: true,
      premultiplyAlpha: false,
      startFrame: 20,
      endFrame: 30,
      pipeMode: 'rawvideo' as const,
    };

    const pngJob = await window.filmora.exportStart(pngSettings);
    let spriteAlphaPixels = 0;
    let spriteOpaquePixels = 0;

    for (let frame = 20; frame < 30; frame += 1) {
      const rgba = await renderer.renderExact(spriteOnly, frame, false);
      for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] === 255) spriteOpaquePixels += 1;
        else if (rgba[i] > 0) spriteAlphaPixels += 1;
      }
      await window.filmora.exportFrame(pngJob.jobId, rgba.buffer as ArrayBuffer);
    }
    step(`sprite pixels: ${spriteOpaquePixels} opaque, ${spriteAlphaPixels} partial`);
    await window.filmora.exportFinish(pngJob.jobId);
    step('exported PNG sequence with alpha');

    renderer.dispose();

    return {
      ok: true,
      steps: log,
      probe: {
        width: video.width,
        height: video.height,
        durationSeconds: video.durationFrames / fps,
      },
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
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    };
  }
}
