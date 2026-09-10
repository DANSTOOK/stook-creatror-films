import type { Clip, MediaAsset, ProjectState } from '@shared/types';
import { Compositor, type ClipSource, type CompositorOptions } from './Compositor';
import { LUTLoader } from './LUTLoader';
import { MediaSourceRegistry } from './MediaSourceRegistry';
import { TextureManager } from './TextureManager';

/**
 * Bundles the compositor with the caches it needs, and offers the two ways a
 * frame gets drawn:
 *
 *   - `drawViewport` - best effort, once per animation frame, never blocks.
 *   - `renderExact`  - deterministic, awaits every decoder, used by export.
 *
 * Export must not reuse the viewport path: if a video element has not finished
 * seeking, the viewport happily draws the previous picture, which in a render
 * would silently duplicate frames.
 */

/** How long to wait for one seek before giving up and drawing what we have. */
const SEEK_TIMEOUT_MS = 4000;

function waitForSeek(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && !video.seeking) return Promise.resolve();

  return new Promise((resolve) => {
    const done = (): void => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('loadeddata', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, SEEK_TIMEOUT_MS);
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('loadeddata', done, { once: true });
  });
}

export class FrameRenderer {
  readonly compositor: Compositor;
  readonly textures: TextureManager;
  readonly media = new MediaSourceRegistry();
  readonly lutLoader: LUTLoader;

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    width: number,
    height: number,
    options: CompositorOptions = {},
  ) {
    this.compositor = Compositor.fromCanvas(canvas, width, height, undefined, options);
    this.lutLoader = new LUTLoader(this.compositor.context);
    this.compositor.lutLoader = this.lutLoader;
    this.textures = new TextureManager(this.compositor.context);
  }

  get options(): CompositorOptions {
    return this.compositor.options;
  }

  set options(options: CompositorOptions) {
    this.compositor.options = options;
  }

  resize(width: number, height: number): void {
    this.compositor.resize(width, height);
  }

  registerAssets(assets: readonly MediaAsset[]): void {
    for (const asset of assets) this.media.register(asset);
  }

  /** Load any LUT referenced by a clip that is not resident yet. */
  async ensureLUTs(project: ProjectState): Promise<void> {
    const uris = new Set<string>();
    for (const clip of Object.values(project.clips)) {
      if (clip.colorGrading.enabled && clip.colorGrading.lutUri) {
        uris.add(clip.colorGrading.lutUri);
      }
    }

    await Promise.all(
      [...uris]
        .filter((uri) => this.lutLoader.get(uri) === undefined)
        .map((uri) => this.lutLoader.load(uri).catch(() => undefined)),
    );
  }

  private uploadFor(clip: Clip, fps: number, pixelArtViewport: boolean): ClipSource | null {
    const element = this.media.get(clip.sourceUri);
    if (!element) return null;

    const gl = this.compositor.context;
    const applyFilter = (): void => {
      this.textures.setFilter(
        clip.sourceUri,
        clip.pixelArt.enabled || pixelArtViewport ? gl.NEAREST : gl.LINEAR,
      );
    };

    // A video element drops below HAVE_CURRENT_DATA while it seeks or rebuffers.
    // Dropping the layer for those frames is what makes playback flicker, so the
    // last decoded frame is held instead. Only a source that has never produced
    // a frame contributes nothing.
    if (!this.media.isReady(clip.sourceUri)) {
      const cached = this.textures.get(clip.sourceUri);
      if (!cached) return null;
      applyFilter();
      return { texture: cached, flipY: true };
    }

    const texture = this.textures.upload(
      clip.sourceUri,
      element,
      this.media.revision(clip.sourceUri, fps),
    );
    applyFilter();

    return { texture, flipY: true };
  }

  /** Non-blocking viewport draw. */
  drawViewport(project: ProjectState, playing: boolean, pixelArtViewport: boolean): void {
    this.compositor.renderFrame(
      project,
      project.currentFrame,
      (clip, sourceFrame) => {
        this.media.syncToFrame(clip.sourceUri, sourceFrame, project.fps, playing);
        return this.uploadFor(clip, project.fps, pixelArtViewport);
      },
      true,
    );
  }

  /** The surface the compositor presents to; WebCodecs captures from it. */
  get canvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.compositor.context.canvas;
  }

  /** Seek every source contributing to `frame` and wait for all of them. */
  private async seekSources(project: ProjectState, frame: number): Promise<void> {
    await Promise.all(
      Compositor.visibleClips(project, frame).map(async (clip) => {
        const sourceFrame = clip.sourceOffsetFrames + (frame - clip.startFrame);
        this.media.syncToFrame(clip.sourceUri, sourceFrame, project.fps, false);

        const element = this.media.get(clip.sourceUri);
        if (element instanceof HTMLVideoElement) await waitForSeek(element);
      }),
    );
  }

  /**
   * Deterministic render of one timeline frame.
   *
   * Returns straight-alpha RGBA, rows top-down - exactly the layout the encoder
   * pipe expects.
   */
  async renderExact(project: ProjectState, frame: number, premultiply = false): Promise<Uint8Array> {
    await this.seekSources(project, frame);

    this.compositor.renderFrame(
      project,
      frame,
      (clip) => this.uploadFor(clip, project.fps, false),
      false,
    );

    return this.compositor.readPixels(premultiply);
  }

  /**
   * Deterministic render presented to the canvas, for the WebCodecs path.
   *
   * The transparency checkerboard is a viewport affordance and must never reach
   * a render, so it is forced off for the duration of the draw.
   */
  async renderExactToCanvas(project: ProjectState, frame: number): Promise<void> {
    await this.seekSources(project, frame);

    const previousOptions = this.compositor.options;
    this.compositor.options = { ...previousOptions, showTransparencyGrid: false };

    try {
      this.compositor.renderFrame(
        project,
        frame,
        (clip) => this.uploadFor(clip, project.fps, false),
        true,
      );
    } finally {
      this.compositor.options = previousOptions;
    }
  }

  dispose(): void {
    this.textures.dispose();
    this.lutLoader.dispose();
    this.media.dispose();
    this.compositor.dispose();
  }
}

/**
 * The renderer currently bound to the viewport canvas.
 *
 * The export dialog needs the same GL context and the same warmed caches, so it
 * borrows this instance rather than standing up a second compositor.
 */
let activeRenderer: FrameRenderer | null = null;

export const setActiveFrameRenderer = (renderer: FrameRenderer | null): void => {
  activeRenderer = renderer;
};

export const getActiveFrameRenderer = (): FrameRenderer | null => activeRenderer;
