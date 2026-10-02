import type { Clip, MediaAsset, ProjectState } from '@shared/types';
import { Compositor, type ClipSource, type CompositorOptions, type ViewerCompare } from './Compositor';
import { LUTLoader } from './LUTLoader';
import { MediaSourceRegistry } from './MediaSourceRegistry';
import { ScrubDecoder } from './ScrubDecoder';
import { keepScrubbers } from './scrubHandover';
import { SequentialVideoReader } from './SequentialVideoReader';
import { TextureManager } from './TextureManager';
import { TitleLayers } from './TitleLayers';
import { activeTransitionsAt } from '@renderer/timing/transitions';
import { assetLengthFrames } from '@renderer/media/assetLength';
import { withCaptionTitles } from '@renderer/captions/captionRender';

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
    // A transition past the end of a file holds its last frame: the
    // compositor needs to know where each file ends.
    this.compositor.sourceLengthOf = (clip, fps) => {
      if (clip.title) return undefined;
      const asset = this.assets.get(clip.sourceUri);
      return asset && asset.kind !== 'image' ? assetLengthFrames(asset, fps) : undefined;
    };
    this.lutLoader = new LUTLoader(this.compositor.context);
    this.compositor.lutLoader = this.lutLoader;
    this.textures = new TextureManager(this.compositor.context);
    this.titles = new TitleLayers(this.textures);
  }

  /** Title clips, drawn as text into textures of their own. */
  readonly titles: TitleLayers;
  /** The clips the titles were last tidied against, to drop a deleted title's texture once. */
  private titlesTidiedFor: ProjectState['clips'] | null = null;

  private tidyTitles(project: ProjectState): void {
    if (this.titlesTidiedFor === project.clips) return;
    this.titlesTidiedFor = project.clips;
    this.titles.retain(new Set(Object.keys(project.clips)));
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

  /** The media by URI, for the lengths of files. */
  private readonly assets = new Map<string, MediaAsset>();

  registerAssets(assets: readonly MediaAsset[]): void {
    for (const asset of assets) {
      this.media.register(asset);
      this.assets.set(asset.uri, asset);
    }
  }

  /**
   * The preview's second decoders: the incoming side of a transition whose
   * two sides are cut from one file gets an element (and a texture) of its
   * own, from a second before the transition to just after it, so both
   * pictures move. The export needs none: it decodes per clip already.
   */
  private readonly lanes = new Map<string, string>();

  private laneFor(clipId: string): string | undefined {
    return this.lanes.get(clipId);
  }

  private updateLanes(project: ProjectState): void {
    const wanted = new Map<string, string>();
    const reach = Math.max(1, Math.round(project.fps));
    for (const transition of Object.values(project.transitions ?? {})) {
      const from = project.clips[transition.fromClipId];
      const to = project.clips[transition.toClipId];
      if (!from || !to || from.title || to.title) continue;
      const uri = this.media.previewUriFor(to.sourceUri);
      if (this.media.previewUriFor(from.sourceUri) !== uri) continue;
      const cut = from.startFrame + from.durationFrames;
      const near = activeTransitionsAt({ ...project, transitions: { [transition.id]: transition } }, project.currentFrame).length > 0
        || Math.abs(project.currentFrame - cut) <= reach + transition.durationFrames;
      if (!near) continue;
      wanted.set(to.id, `${uri}#scf-lane=${to.id}`);
    }
    for (const [clipId, lane] of this.lanes) {
      if (wanted.get(clipId) === lane) continue;
      this.media.release(lane);
      this.textures.release(lane);
      this.lanes.delete(clipId);
    }
    for (const [clipId, lane] of wanted) {
      if (this.lanes.has(clipId)) continue;
      const to = project.clips[clipId];
      this.media.ensureLane(lane, this.media.previewUriFor(to.sourceUri));
      this.lanes.set(clipId, lane);
    }
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
        const uri = this.laneFor(clip.id) ?? this.media.previewUriFor(clip.sourceUri);
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
  drawViewport(
    project: ProjectState,
    playing: boolean,
    pixelArtViewport: boolean,
    compare?: ViewerCompare,
    /** The title being typed into in the viewer, drawn at rest. */
    restingTitleId: string | null = null,
  ): void {
    // Captions are drawn as titles: see captions/captionRender.
    project = withCaptionTitles(project);
    // An export owns the video elements and the canvas right now.
    if (this.isExclusive) return;
    this.compositor.restingTitleId = restingTitleId;

    // Playback runs on the elements; the forward decoders are only for a
    // paused playhead, and hold a hardware decoder each, so they go.
    const scrubbing = !playing && !(window as { __scfNoScrubDecoder?: boolean }).__scfNoScrubDecoder;
    this.updateLanes(project);
    if (!scrubbing) this.closeScrubbers();
    else {
      // Every clip drawn now - the two sides of a transition included.
      const drawn = Compositor.drawList(project, project.currentFrame).flatMap((entry) => (entry.kind === 'clip' ? [entry.clip] : [entry.from, entry.to]));
      this.closeScrubbers(drawn.filter((clip) => !clip.title));
    }
    this.tidyTitles(project);

    this.compositor.renderFrame(
      project,
      project.currentFrame,
      (clip, sourceFrame) => {
        // A title has no file: its picture is drawn from its text.
        if (clip.title) return this.titles.sourceFor(clip, project.width, project.height);
        // The preview - and only the preview - draws the proxy when there
        // is one and proxies are on.
        // A transition's incoming side, cut from the same file as its
        // outgoing side, reads from a decoder of its own.
        const uri = this.laneFor(clip.id) ?? this.media.previewUriFor(clip.sourceUri);
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
      // The before/after is the viewer's alone: no export path passes it.
      compare,
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
    // Every clip drawn at this frame, at the frame of footage it shows - a
    // transition's sides past their ends included.
    const drawn = Compositor.drawList(project, frame, this.compositor.sourceLengthOf).flatMap((entry) =>
      entry.kind === 'clip'
        ? [{ clip: entry.clip, sourceFrame: entry.sourceFrame }]
        : [
            { clip: entry.from, sourceFrame: entry.fromFrame },
            { clip: entry.to, sourceFrame: entry.toFrame },
          ],
    );
    this.retireReaders(new Set(drawn.map(({ clip }) => clip.id)));

    // Seeking, rather than decoding forwards: the incoming side of a
    // transition cut from the same file as the outgoing one needs an element
    // of its own, or both sides would show whichever seek landed last.
    const lanes = new Map<string, string>();
    for (const entry of Compositor.drawList(project, frame)) {
      if (entry.kind !== 'transition' || entry.from.sourceUri !== entry.to.sourceUri || entry.to.title) continue;
      const lane = `${entry.to.sourceUri}#scf-exact-lane=${entry.to.id}`;
      this.media.ensureLane(lane, entry.to.sourceUri);
      lanes.set(entry.to.id, lane);
    }
    for (const [clipId, lane] of this.exactLanes) {
      if (lanes.get(clipId) === lane) continue;
      this.media.release(lane);
      this.textures.release(lane);
    }
    this.exactLanes = lanes;

    await Promise.all(
      drawn.map(async ({ clip, sourceFrame }) => {
        // A title waits for its fonts instead of a decoder: a frame drawn
        // before they load would go out in a fallback face.
        if (clip.title) {
          await this.titles.prepare(clip);
          return;
        }
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
        const lane = this.exactLanes.get(clip.id);
        if (lane) await this.media.whenLoaded(lane);
        await this.media.seekExact(lane ?? clip.sourceUri, sourceFrame, project.fps);
      }),
    );
  }

  /** Second elements for the seek path of an exact render: see seekSources. */
  private exactLanes = new Map<string, string>();

  /** The texture for a clip in an exact render: its decoded frame, or the element. */
  private exactUploadFor(clip: Clip, fps: number, project: ProjectState): ClipSource | null {
    if (clip.title) return this.titles.sourceFor(clip, project.width, project.height);
    const frame = this.decodedFrames.get(clip.id);
    if (!frame) return this.uploadFor(clip, fps, false, this.exactLanes.get(clip.id) ?? clip.sourceUri);

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
    project = withCaptionTitles(project);
    await this.seekSources(project, frame);
    // An exact render is the export's: every title animates, none is at rest.
    this.compositor.restingTitleId = null;

    this.compositor.renderFrame(
      project,
      frame,
      (clip) => this.exactUploadFor(clip, project.fps, project),
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
    project = withCaptionTitles(project);
    await this.seekSources(project, frame);
    this.compositor.restingTitleId = null;

    const previousOptions = this.compositor.options;
    this.compositor.options = { ...previousOptions, showTransparencyGrid: false };

    try {
      this.compositor.renderFrame(
        project,
        frame,
        (clip) => this.exactUploadFor(clip, project.fps, project),
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
