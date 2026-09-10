/**
 * Uploads decoded media into GL textures and caches them.
 *
 * The renderer sees three kinds of source: `HTMLVideoElement` (playback),
 * `VideoFrame` from WebCodecs (scrubbing and export, where frame-accuracy
 * matters) and `ImageBitmap` (stills and sprite sheets). All three satisfy
 * `TexImageSource`, so a single upload path covers them.
 */

export type UploadableSource = TexImageSource;

interface CacheEntry {
  texture: WebGLTexture;
  width: number;
  height: number;
  /** Monotonic counter used for LRU eviction. */
  lastUsed: number;
  /** Identifies the exact decoded frame currently resident in the texture. */
  revision: string;
  bytes: number;
}

const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024; // 512 MB of texture cache

export class TextureManager {
  private readonly cache = new Map<string, CacheEntry>();
  private tick = 0;
  private residentBytes = 0;

  /** A 1x1 transparent texture used whenever a source has not decoded yet. */
  private readonly placeholder: WebGLTexture;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly budgetBytes: number = DEFAULT_BUDGET_BYTES,
  ) {
    this.placeholder = this.createEmptyTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.placeholder);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  get transparentTexture(): WebGLTexture {
    return this.placeholder;
  }

  get cachedBytes(): number {
    return this.residentBytes;
  }

  private createEmptyTexture(): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to allocate texture');

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  private static sourceSize(source: UploadableSource): { width: number; height: number } {
    if (source instanceof HTMLVideoElement) {
      return { width: source.videoWidth, height: source.videoHeight };
    }
    if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
      return { width: source.displayWidth, height: source.displayHeight };
    }
    const sized = source as { width: number; height: number };
    return { width: sized.width, height: sized.height };
  }

  /**
   * Upload (or re-upload) a source frame.
   *
   * `revision` should change whenever the pixels change - typically the source
   * frame index. When it matches what is already resident the upload is skipped,
   * which is what keeps a paused playhead from re-uploading every raf tick.
   */
  upload(key: string, source: UploadableSource, revision: string): WebGLTexture {
    const { gl } = this;
    const { width, height } = TextureManager.sourceSize(source);
    if (width === 0 || height === 0) return this.placeholder;

    this.tick += 1;
    const existing = this.cache.get(key);

    if (existing && existing.revision === revision) {
      existing.lastUsed = this.tick;
      return existing.texture;
    }

    const texture = existing?.texture ?? this.createEmptyTexture();
    const bytes = width * height * 4;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Sources are kept as straight alpha; premultiplication happens in the
    // composite pass so that exported sprites can be written back out straight.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    if (existing && existing.width === width && existing.height === height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.residentBytes += bytes - (existing?.bytes ?? 0);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.cache.set(key, {
      texture,
      width,
      height,
      lastUsed: this.tick,
      revision,
      bytes,
    });

    this.evictIfOverBudget();
    return texture;
  }

  get(key: string): WebGLTexture | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.tick += 1;
    entry.lastUsed = this.tick;
    return entry.texture;
  }

  /** Nearest-neighbour sampling for pixel-art sources. */
  setFilter(key: string, filter: number): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private evictIfOverBudget(): void {
    if (this.residentBytes <= this.budgetBytes) return;

    const byAge = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of byAge) {
      if (this.residentBytes <= this.budgetBytes) break;
      this.gl.deleteTexture(entry.texture);
      this.residentBytes -= entry.bytes;
      this.cache.delete(key);
    }
  }

  release(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.gl.deleteTexture(entry.texture);
    this.residentBytes -= entry.bytes;
    this.cache.delete(key);
  }

  dispose(): void {
    for (const entry of this.cache.values()) this.gl.deleteTexture(entry.texture);
    this.cache.clear();
    this.residentBytes = 0;
    this.gl.deleteTexture(this.placeholder);
  }
}
