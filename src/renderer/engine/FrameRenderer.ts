import type { Clip, MediaAsset, ProjectState } from '@shared/types';
import { Compositor, type ClipSource, type CompositorOptions } from './Compositor';
import { LUTLoader } from './LUTLoader';
import { MediaSourceRegistry } from './MediaSourceRegistry';
import { ScrubDecoder } from './ScrubDecoder';
import { keepScrubbers } from './scrubHandover';
import { SequentialVideoReader } from './SequentialVideoReader';
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

export class FrameRenderer {
  readonly compositor: Compositor;
  readonly textures: TextureManager;
  readonly media = new MediaSourceRegistry();
  readonly lutLoader: LUTLoader;

  /**
   * Nesting count of exports holding the renderer.
   *
   * The export borrows THIS renderer - the viewport's - for its GL context and
   * warm caches. While it runs, the viewport's own draw loop must stand still:
   * it seeks the same video elements to the playhead and draws into the same
   * canvas, so left running it put the playhead's picture into roughly every
   * other exported frame. Those were the flashes in the render.
   */
  private exclusiveHolds = 0;

  /** Freeze the viewport for the duration of an export. Pair with `endExclusive`. */
  beginExclusive(): void {
    this.exclusiveHolds += 1;
    // The export's own decoders need the hardware more than a paused preview.
    this.closeScrubbers();
  }

  endExclusive(): void {
    this.exclusiveHolds = Math.max(0, this.exclusiveHolds - 1);
  }

  get isExclusive(): boolean {
    return this.exclusiveHolds > 0;
  }

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

  /** Draw the preview from proxies where they exist. Exports are unaffected. */
  useProxies(enabled: boolean): void {
    this.media.useProxies(enabled);
  }

  /**
   * What the preview would draw for this source right now.
   *
   * The proxy when there is one and they are on, the file itself otherwise.
   * An export never asks: it reads the file, which is the difference the
   * interface tests check.
   */
  previewSourceFor(uri: string): string {
    return this.media.previewUriFor(uri);
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

  /**
   * `uri` is what to draw from: the clip's own file, or - in the preview
   * only - its proxy. Every export path leaves it out and gets the file.
   */
  private uploadFor(clip: Clip, fps: number, pixelArtViewport: boolean, uri = clip.sourceUri): ClipSource | null {
    const element = this.media.get(uri);
    if (!element) return null;

    const gl = this.compositor.context;
    const applyFilter = (): void => {
      this.textures.setFilter(
        uri,
        clip.pixelArt.enabled || pixelArtViewport ? gl.NEAREST : gl.LINEAR,
      );
    };

    // A video element drops below HAVE_CURRENT_DATA while it seeks or rebuffers.
    // Dropping the layer for those frames is what makes playback flicker, so the
    // last decoded frame is held instead. Only a source that has never produced
    // a frame contributes nothing.
    if (!this.media.isReady(uri)) {
      const cached = this.textures.get(uri);
      if (!cached) return null;
      applyFilter();
      return { texture: cached, flipY: true };
    }

    const texture = this.textures.upload(
      uri,
      element,
      this.media.revision(uri, fps),
    );
    applyFilter();

    return { texture, flipY: true };
  }

  /** Forward decoders for a paused playhead, by clip and file. See ScrubDecoder. */
  private readonly scrubbers = new Map<string, ScrubDecoder>();

  private static scrubKey(clip: Clip, uri = clip.sourceUri): string {
    return `${clip.id}|${uri}`;
  }

  /**
   * Close the decoders `keep` no longer needs. One whose clip was replaced by
   * a clip of the same file - a cut, a paste, an undo - is handed over rather
   * than closed, so what it decoded is not decoded again. See scrubHandover.
   */
  private closeScrubbers(keep: readonly Clip[] = []): void {
    // Keyed by what the preview actually decodes, so switching proxies on
    // or off retires the decoders of the file that is no longer drawn.
    keepScrubbers(
      this.scrubbers,
      new Map(keep.map((clip) => {
        const uri = this.media.previewUriFor(clip.sourceUri);
        return [FrameRenderer.scrubKey(clip, uri), uri];
      })),
    );
  }

  /**
   * A paused clip's picture: from the forward decoder when it has the frame or
   * can walk to it cheaply, otherwise from a seek - whichever lands, the
   * texture keeps the last good picture until then.
   */
  private scrubUploadFor(
    clip: Clip,
    sourceFrame: number,
    fps: number,
    pixelArtViewport: boolean,
    uri = clip.sourceUri,
  ): ClipSource | null {
    // Keyed by the file too: a relinked clip must not keep the old file's decoder.
    const key = FrameRenderer.scrubKey(clip, uri);
    let scrubber = this.scrubbers.get(key);
    if (!scrubber) {
      scrubber = new ScrubDecoder(uri, fps, () => undefined);
      this.scrubbers.set(key, scrubber);
    }

    const gl = this.compositor.context;
    const filter = clip.pixelArt.enabled || pixelArtViewport ? gl.NEAREST : gl.LINEAR;
    const revision = `${uri}:${sourceFrame}`;

    const decoded = scrubber.frameFor(sourceFrame);
    if (decoded) {
      const texture = this.textures.upload(uri, decoded, revision);
      this.textures.setFilter(uri, filter);
      return { texture, flipY: true };
    }

    // Decoded on the way here - by a forward drag, or filled in behind a
    // backwards one: a smaller copy of exactly this frame, right now. A
    // different revision, so the full-size frame replaces it once the
    // playhead rests.
    const preview = scrubber.previewFor(sourceFrame);
    if (preview) {
      const texture = this.textures.upload(uri, preview, `${revision}:preview`);
      this.textures.setFilter(uri, filter);
      scrubber.requestWhenSettled(sourceFrame, performance.now());
      if (sourceFrame < scrubber.position) scrubber.fillBehind(sourceFrame);
      return { texture, flipY: true };
    }

    // Heading back past what is kept: fill in behind, ahead of the hand.
    if (scrubber.position >= 0 && sourceFrame < scrubber.position) scrubber.fillBehind(sourceFrame);

    if (!scrubber.canReachCheaply(sourceFrame)) {
      // Too far for a walk: the element seeks, as it always did, and the
      // decoder follows once the playhead rests.
      scrubber.requestWhenSettled(sourceFrame, performance.now());
      this.media.syncToFrame(uri, sourceFrame, fps, false);
      return this.uploadFor(clip, fps, pixelArtViewport, uri);
    }
    scrubber.request(sourceFrame);

    // A few milliseconds away: hold the current picture rather than start a
    // seek that would land later than the decoder does.
    const held = this.textures.get(uri);
    if (!held) return this.uploadFor(clip, fps, pixelArtViewport, uri);
    this.textures.setFilter(uri, filter);
    return { texture: held, flipY: true };
  }

  /** Non-blocking viewport draw. */
  drawViewport(project: ProjectState, playing: boolean, pixelArtViewport: boolean): void {
    // An export owns the video elements and the canvas right now.
    if (this.isExclusive) return;

    // Playback runs on the elements; the forward decoders are only for a
    // paused playhead, and hold a hardware decoder each, so they go.
    const scrubbing = !playing && !(window as { __scfNoScrubDecoder?: boolean }).__scfNoScrubDecoder;
    if (!scrubbing) this.closeScrubbers();
    else this.closeScrubbers(Compositor.visibleClips(project, project.currentFrame));

    this.compositor.renderFrame(
      project,
      project.currentFrame,
      (clip, sourceFrame) => {
        // The preview - and only the preview - draws the proxy when there
        // is one and proxies are on.
        const uri = this.media.previewUriFor(clip.sourceUri);
        const isVideo = this.media.get(uri) instanceof HTMLVideoElement;
        let source: ClipSource | null;
        if (scrubbing && isVideo) {
          source = this.scrubUploadFor(clip, sourceFrame, project.fps, pixelArtViewport, uri);
        } else {
          this.media.syncToFrame(uri, sourceFrame, project.fps, playing);
          source = this.uploadFor(clip, project.fps, pixelArtViewport, uri);
        }

        // Test instrumentation: how often a paused preview shows exactly the
        // frame under the playhead. Off unless a test asks for it.
        const stats = (window as { __scfViewportStats?: { draws: number; exact: number } }).__scfViewportStats;
        if (stats && isVideo && !playing) {
          stats.draws += 1;
          // A kept small copy of the right frame is the right frame.
          const shown = this.textures.revisionOf(uri);
          const wanted = `${uri}:${sourceFrame}`;
          if (shown === wanted || shown === `${wanted}:preview`) stats.exact += 1;
        }
        return source;
      },
      true,
    );
  }

  /** The surface the compositor presents to; WebCodecs captures from it. */
  get canvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.compositor.context.canvas;
  }

  /**
   * In-order decoders, one per clip, while an export runs; null for a clip
   * whose file has to use the seek path. See SequentialVideoReader.
   */
  private sequential: Map<string, Promise<SequentialVideoReader | null>> | null = null;

  /** Sources an export could not decode forwards, and seeks frame by frame instead. */
  private readonly seekingSources = new Set<string>();

  /** Names of the sources on the slow, seek-per-frame export path. */
  slowSources(): string[] {
    return [...this.seekingSources];
  }

  /** Frames decoded for the render in progress, by clip id. */
  private readonly decodedFrames = new Map<string, VideoFrame>();

  /** Decode forwards instead of seeking, until `stopSequentialDecode`. */
  startSequentialDecode(): void {
    this.stopSequentialDecode();
    this.sequential = new Map();
    this.seekingSources.clear();
  }

  stopSequentialDecode(): void {
    const readers = this.sequential;
    this.sequential = null;
    this.decodedFrames.clear();
    if (!readers) return;
    for (const [clipId, reader] of readers) {
      void reader.then((open) => open?.close());
      this.textures.release(`clip:${clipId}`);
    }
  }

  /** Close the decoders of clips the render has moved past. */
  private retireReaders(visible: ReadonlySet<string>): void {
    if (!this.sequential) return;
    for (const [clipId, reader] of this.sequential) {
      if (visible.has(clipId)) continue;
      this.sequential.delete(clipId);
      void reader.then((open) => open?.close());
      this.textures.release(`clip:${clipId}`);
    }
  }

  /** Seek every source contributing to `frame` and wait for all of them. */
  private async seekSources(project: ProjectState, frame: number): Promise<void> {
    this.decodedFrames.clear();
    const clips = Compositor.visibleClips(project, frame);
    this.retireReaders(new Set(clips.map((clip) => clip.id)));

    await Promise.all(
      clips.map(async (clip) => {
        const sourceFrame = clip.sourceOffsetFrames + (frame - clip.startFrame);
        if (this.sequential && this.media.get(clip.sourceUri) instanceof HTMLVideoElement) {
          let reader = this.sequential.get(clip.id);
          if (!reader) {
            reader = SequentialVideoReader.open(clip.sourceUri).catch(() => null);
            this.sequential.set(clip.id, reader);
          }
          const open = await reader;
          // Remembered so the export can say it is on the slow path, rather
          // than leaving the user to wonder why a render crawls at 15 fps.
          if (!open) this.seekingSources.add(clip.name);
          if (open) {
            try {
              this.decodedFrames.set(clip.id, await open.frameAt(sourceFrame, project.fps));
              return;
            } catch (error) {
              // A decoder that fails mid-render hands the clip to the seek path.
              console.info(`[export] ${clip.name}: decoding forwards failed at frame ${sourceFrame}, seeking instead (${String(error)})`);
              open.close();
              this.sequential.set(clip.id, Promise.resolve(null));
              this.seekingSources.add(clip.name);
            }
          }
        }
        await this.media.seekExact(clip.sourceUri, sourceFrame, project.fps);
      }),
    );
  }

  /** The texture for a clip in an exact render: its decoded frame, or the element. */
  private exactUploadFor(clip: Clip, fps: number): ClipSource | null {
    const frame = this.decodedFrames.get(clip.id);
    if (!frame) return this.uploadFor(clip, fps, false);

    const key = `clip:${clip.id}`;
    const texture = this.textures.upload(key, frame, `${frame.timestamp}`);
    const gl = this.compositor.context;
    this.textures.setFilter(key, clip.pixelArt.enabled ? gl.NEAREST : gl.LINEAR);
    return { texture, flipY: true };
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
      (clip) => this.exactUploadFor(clip, project.fps),
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
        (clip) => this.exactUploadFor(clip, project.fps),
        true,
      );
    } finally {
      this.compositor.options = previousOptions;
    }
  }

  dispose(): void {
    this.closeScrubbers();
    this.stopSequentialDecode();
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
