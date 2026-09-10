import type { CubeLUT } from '@shared/types';

/**
 * Adobe `.cube` 3D LUT parser and WebGL2 uploader.
 *
 * Parsing is deliberately separated from uploading: the parser is pure and unit
 * tested, the uploader is the only part that needs a GL context.
 */

const MIN_LUT_SIZE = 2;
const MAX_LUT_SIZE = 256;

/** Strip `#` comments and surrounding whitespace from a single line. */
function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

function parseTriplet(tokens: string[], keyword: string): [number, number, number] {
  if (tokens.length < 3) {
    throw new SyntaxError(`${keyword} requires three components, got ${tokens.length}`);
  }
  const values = tokens.slice(0, 3).map(Number);
  if (values.some((v) => !Number.isFinite(v))) {
    throw new SyntaxError(`${keyword} contains a non-numeric component: ${tokens.join(' ')}`);
  }
  return values as [number, number, number];
}

/**
 * Parse a `.cube` document into a flat RGB `Float32Array`.
 *
 * The `.cube` spec stores entries with the red channel varying fastest, which
 * is exactly the memory order `texImage3D` expects for a width=R, height=G,
 * depth=B volume, so no reshuffling is needed.
 */
export function parseCubeLUT(source: string): CubeLUT {
  let title = 'Untitled LUT';
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];

  let data: Float32Array | null = null;
  let writeIndex = 0;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line.length === 0) continue;

    const tokens = line.split(/\s+/);
    const keyword = tokens[0].toUpperCase();

    switch (keyword) {
      case 'TITLE': {
        const match = /"([^"]*)"/.exec(line);
        title = match ? match[1] : tokens.slice(1).join(' ');
        continue;
      }
      case 'LUT_3D_SIZE': {
        size = Number(tokens[1]);
        if (!Number.isInteger(size) || size < MIN_LUT_SIZE || size > MAX_LUT_SIZE) {
          throw new RangeError(
            `LUT_3D_SIZE must be an integer in [${MIN_LUT_SIZE}, ${MAX_LUT_SIZE}], got "${tokens[1]}"`,
          );
        }
        data = new Float32Array(size * size * size * 3);
        continue;
      }
      case 'LUT_1D_SIZE': {
        throw new SyntaxError('1D .cube LUTs are not supported; a 3D LUT is required');
      }
      case 'DOMAIN_MIN': {
        domainMin = parseTriplet(tokens.slice(1), 'DOMAIN_MIN');
        continue;
      }
      case 'DOMAIN_MAX': {
        domainMax = parseTriplet(tokens.slice(1), 'DOMAIN_MAX');
        continue;
      }
      default:
        break;
    }

    // Anything that is not a keyword must be an RGB data row.
    const r = Number(tokens[0]);
    if (!Number.isFinite(r)) {
      throw new SyntaxError(`Unrecognized line in .cube file: "${line}"`);
    }
    if (data === null) {
      throw new SyntaxError('Encountered LUT data before LUT_3D_SIZE was declared');
    }
    if (tokens.length < 3) {
      throw new SyntaxError(`LUT entry needs three components: "${line}"`);
    }
    if (writeIndex + 3 > data.length) {
      throw new RangeError(`.cube file declares size ${size} but contains extra entries`);
    }

    const g = Number(tokens[1]);
    const b = Number(tokens[2]);
    if (!Number.isFinite(g) || !Number.isFinite(b)) {
      throw new SyntaxError(`LUT entry contains a non-numeric component: "${line}"`);
    }

    data[writeIndex] = r;
    data[writeIndex + 1] = g;
    data[writeIndex + 2] = b;
    writeIndex += 3;
  }

  if (data === null || size === 0) {
    throw new SyntaxError('.cube file is missing a LUT_3D_SIZE declaration');
  }
  if (writeIndex !== data.length) {
    throw new RangeError(
      `.cube file declares size ${size} (${data.length / 3} entries) but contains ${writeIndex / 3}`,
    );
  }
  for (let i = 0; i < 3; i += 1) {
    if (domainMax[i] <= domainMin[i]) {
      throw new RangeError(
        `DOMAIN_MAX must exceed DOMAIN_MIN on every axis (axis ${i}: ${domainMin[i]} to ${domainMax[i]})`,
      );
    }
  }

  return { title, size, domainMin, domainMax, data };
}

/** Nearest-neighbour CPU sampling of a parsed LUT. Used by tests and tooling. */
export function sampleLUTNearest(
  lut: CubeLUT,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const last = lut.size - 1;
  const axis = (value: number, index: number): number => {
    const min = lut.domainMin[index];
    const max = lut.domainMax[index];
    const normalized = (value - min) / (max - min);
    return Math.min(last, Math.max(0, Math.round(normalized * last)));
  };

  const offset = (axis(r, 0) + axis(g, 1) * lut.size + axis(b, 2) * lut.size * lut.size) * 3;
  return [lut.data[offset], lut.data[offset + 1], lut.data[offset + 2]];
}

/**
 * Upload a parsed LUT as a `TEXTURE_3D`.
 *
 * `RGB16F` with `LINEAR` filtering lets the sampler hardware perform trilinear
 * interpolation, so color grading costs a single `texture()` fetch per pixel.
 */
export function createLUTTexture(gl: WebGL2RenderingContext, lut: CubeLUT): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to allocate LUT texture');

  const previous = gl.getParameter(gl.TEXTURE_BINDING_3D) as WebGLTexture | null;

  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGB16F,
    lut.size,
    lut.size,
    lut.size,
    0,
    gl.RGB,
    gl.FLOAT,
    lut.data,
  );

  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  gl.bindTexture(gl.TEXTURE_3D, previous);
  return texture;
}

export interface LoadedLUT {
  lut: CubeLUT;
  texture: WebGLTexture;
}

/**
 * Cache of uploaded LUTs keyed by source URI, so switching between clips that
 * share a look does not re-upload the volume texture.
 */
export class LUTLoader {
  private readonly cache = new Map<string, LoadedLUT>();
  private readonly pending = new Map<string, Promise<LoadedLUT>>();

  constructor(private readonly gl: WebGL2RenderingContext) {}

  get(uri: string): LoadedLUT | undefined {
    return this.cache.get(uri);
  }

  async load(uri: string): Promise<LoadedLUT> {
    const cached = this.cache.get(uri);
    if (cached) return cached;

    const inFlight = this.pending.get(uri);
    if (inFlight) return inFlight;

    const request = (async (): Promise<LoadedLUT> => {
      const response = await fetch(uri);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch LUT "${uri}": ${response.status} ${response.statusText}`,
        );
      }
      const lut = parseCubeLUT(await response.text());
      const entry: LoadedLUT = { lut, texture: createLUTTexture(this.gl, lut) };
      this.cache.set(uri, entry);
      return entry;
    })().finally(() => {
      this.pending.delete(uri);
    });

    this.pending.set(uri, request);
    return request;
  }

  /** Release the VRAM held by one LUT. */
  release(uri: string): void {
    const entry = this.cache.get(uri);
    if (!entry) return;
    this.gl.deleteTexture(entry.texture);
    this.cache.delete(uri);
  }

  dispose(): void {
    for (const entry of this.cache.values()) this.gl.deleteTexture(entry.texture);
    this.cache.clear();
    this.pending.clear();
  }
}
