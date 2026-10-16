import {
  MATTE_HEADER_BYTES,
  decodeMatteFrame,
  matteFrameFor,
  readMatteHeader,
  readMatteIndex,
  type MatteHeader,
} from '@shared/matte/format';
import type { ByteReader } from './mp4';
import { rangeReader } from './rangeFetch';

/**
 * Remove background, on the GPU side: a clip's matte for the frame being
 * drawn, as a one-channel texture for the compositor's first pass.
 *
 * The mattes are read from their cache file (shared/matte/format.ts) over
 * `media://`, a block of frames per request, and decoded in JavaScript - a
 * millisecond a frame - so a long clip is never in memory whole. Rows go up
 * top first, as a video frame's do, so the matte is read at exactly the
 * texture coordinates the picture is (Compositor, TRANSFER_FRAGMENT_SOURCE).
 *
 * Two ways in, like the rest of the renderer (FrameRenderer):
 * - `textureFor`, for the viewer: never waits. A frame not read yet is asked
 *   for, and meanwhile the clip's last matte is held, as the last decoded
 *   picture is held while a video seeks; the next draw has it.
 * - `prepare`, for the export: waits until this frame's matte is here, so
 *   every exported frame has its own.
 */

/** Frames fetched per request: about half a second of footage, 100-500 KB. */
const BLOCK = 16;
/** Decoded mattes kept, across every clip: about a second of 1024 x 576 at 30 fps. */
const KEEP_FRAMES = 48;
/** Matte textures kept on the GPU: enough for every clip a frame can show at once. */
const KEEP_TEXTURES = 8;

interface OpenMatte {
  header: MatteHeader;
  offsets: number[];
  read: ByteReader;
}

export class MatteTextures {
  private readonly files = new Map<string, Promise<OpenMatte | null>>();
  private readonly opened = new Map<string, OpenMatte | null>();
  /** Decoded frames by `url#index`, the most recently used last. */
  private readonly frames = new Map<string, Uint8Array>();
  private readonly loading = new Map<string, Promise<void>>();
  /** Matte textures by url#frame, the most recently used last. */
  private readonly textures = new Map<string, WebGLTexture>();
  /** The texture each file last showed, held while the next frame loads. */
  private readonly lastShown = new Map<string, string>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly reader: (url: string) => ByteReader = rangeReader,
  ) {}

  private open(url: string): Promise<OpenMatte | null> {
    let file = this.files.get(url);
    if (!file) {
      file = (async () => {
        const read = this.reader(url);
        const header = readMatteHeader(await read(0, MATTE_HEADER_BYTES));
        if (!header) return null;
        const offsets = readMatteIndex(await read(header.indexOffset, (header.frames + 1) * 8), header.frames);
        return offsets ? { header, offsets, read } : null;
      })().catch(() => null);
      void file.then((open) => this.opened.set(url, open));
      this.files.set(url, file);
    }
    return file;
  }

  private remember(key: string, pixels: Uint8Array): void {
    this.frames.delete(key);
    this.frames.set(key, pixels);
    while (this.frames.size > KEEP_FRAMES) this.frames.delete(this.frames.keys().next().value as string);
  }

  /** Read and decode the block of frames that holds `index`. */
  private load(url: string, open: OpenMatte, index: number): Promise<void> {
    const first = Math.floor(index / BLOCK) * BLOCK;
    const key = `${url}#block${first}`;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = (async () => {
        const last = Math.min(open.header.frames, first + BLOCK);
        const start = open.offsets[first];
        const bytes = await open.read(start, open.offsets[last] - start);
        for (let frame = first; frame < last; frame += 1) {
          const coded = bytes.subarray(open.offsets[frame] - start, open.offsets[frame + 1] - start);
          const pixels = new Uint8Array(open.header.width * open.header.height);
          // A frame that does not decode is left out: drawn whole, never with a wrong matte.
          if (decodeMatteFrame(coded, pixels)) this.remember(`${url}#${frame}`, pixels);
        }
      })().finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  /**
   * The texture holding this frame's matte, uploaded if it is not yet. One
   * per frame, not per file: two clips of one file drawn together - the two
   * sides of a dissolve within a shot - each need their own.
   */
  private upload(url: string, open: OpenMatte, frame: number, pixels: Uint8Array): WebGLTexture {
    const { gl } = this;
    const key = `${url}#${frame}`;
    this.lastShown.set(url, key);
    const kept = this.textures.get(key);
    if (kept) {
      this.textures.delete(key);
      this.textures.set(key, kept);
      return kept;
    }
    // The least recently used texture is reused once there are enough.
    let texture: WebGLTexture | null = null;
    if (this.textures.size >= KEEP_TEXTURES) {
      const [oldest, recycled] = this.textures.entries().next().value as [string, WebGLTexture];
      this.textures.delete(oldest);
      texture = recycled;
    }
    // On a unit of its own, as the curve textures are: binding on the active
    // unit could replace a pass's input mid-setup.
    gl.activeTexture(gl.TEXTURE3);
    if (!texture) {
      texture = gl.createTexture();
      if (!texture) throw new Error('Failed to allocate a matte texture');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, open.header.width, open.header.height, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    this.textures.set(key, texture);
    return texture;
  }

  /** The viewer's matte for this frame: now, or the last one this file showed while it loads. */
  textureFor(url: string, sourceFrame: number, fps: number): WebGLTexture | null {
    const open = this.opened.get(url);
    if (open === undefined) {
      void this.open(url);
      return null;
    }
    if (open === null) return null;
    const frame = matteFrameFor(sourceFrame, fps, open.header.fps, open.header.frames);
    const pixels = this.frames.get(`${url}#${frame}`);
    if (pixels) {
      this.remember(`${url}#${frame}`, pixels);
      return this.upload(url, open, frame, pixels);
    }
    void this.load(url, open, frame).catch(() => undefined);
    const held = this.lastShown.get(url);
    return held ? this.textures.get(held) ?? null : null;
  }

  /** The export's: resolves once this frame's matte is ready, false when the file cannot be read. */
  async prepare(url: string, sourceFrame: number, fps: number): Promise<boolean> {
    const open = await this.open(url);
    if (!open) return false;
    const frame = matteFrameFor(sourceFrame, fps, open.header.fps, open.header.frames);
    if (!this.frames.has(`${url}#${frame}`)) await this.load(url, open, frame);
    return this.frames.has(`${url}#${frame}`);
  }

  /** The texture for a frame `prepare` has made ready; null if it was not. */
  exactTextureFor(url: string, sourceFrame: number, fps: number): WebGLTexture | null {
    const open = this.opened.get(url);
    if (!open) return null;
    const frame = matteFrameFor(sourceFrame, fps, open.header.fps, open.header.frames);
    const pixels = this.frames.get(`${url}#${frame}`);
    return pixels ? this.upload(url, open, frame, pixels) : null;
  }

  /** Forget every file but these: a matte deleted or rebuilt is read afresh. */
  retain(urls: ReadonlySet<string>): void {
    for (const url of [...this.files.keys()]) {
      if (urls.has(url)) continue;
      this.files.delete(url);
      this.opened.delete(url);
      this.lastShown.delete(url);
      for (const [key, texture] of [...this.textures]) {
        if (!key.startsWith(`${url}#`)) continue;
        this.gl.deleteTexture(texture);
        this.textures.delete(key);
      }
      for (const key of [...this.frames.keys()]) if (key.startsWith(`${url}#`)) this.frames.delete(key);
    }
  }

  dispose(): void {
    this.retain(new Set());
  }
}
