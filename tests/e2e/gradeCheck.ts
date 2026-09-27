import type { ColorGradingConfig, CubeLUT } from '@shared/types';
import { FULLSCREEN_MATRIX, GLProgram, RenderTarget } from '@renderer/engine/GLProgram';
import { createLUTTexture } from '@renderer/engine/LUTLoader';
import { cdlOf, gradePixel, normalizeGrading, withMaster, withPuck, neutralWheel, type Rgb } from '@renderer/color/grade';
import baseVertexSource from '@renderer/engine/shaders/BaseVertex.glsl?raw';
import gradingSource from '@renderer/engine/shaders/ColorGrading.glsl?raw';
import legacySource from './fixtures/ColorGrading.v1.glsl?raw';

/**
 * The grading shader on the GPU, against what it replaced and against the
 * reference arithmetic (colour phase 2, driven by grade.mjs).
 *
 *   1. Every one of the 16,777,216 8-bit colours through the phase-1 shader
 *      and through this one, with the wheels neutral: the results have to be
 *      the same half-float values, not merely close. Four settings: all
 *      neutral; the old sliders moved; a LUT at 60%; both.
 *   2. Known colours through moved wheels, against color/grade.ts: within
 *      1/255.
 *   3. What a grading pass costs at 4K, before and after.
 */

export interface GradeCheckResult {
  ok: boolean;
  error?: string;
  identity: Array<{ name: string; colours: number; differentValues: number; differentBytes: number; worst: number }>;
  reference: Array<{ name: string; colours: number; worst: number }>;
  timing: Array<{ name: string; msPerPass: number }>;
}

const SIDE = 4096; // 4096 x 4096 = every 8-bit colour once
const TILE = 1024;

const QUAD = new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]);

/** A gentle look, so a LUT that did nothing could not pass. */
function lookLut(size = 17): CubeLUT {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        data[i++] = (r / (size - 1)) ** 0.9;
        data[i++] = g / (size - 1);
        data[i++] = (b / (size - 1)) ** 1.1;
      }
    }
  }
  return { title: 'look', size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

export async function runGradeCheck(): Promise<GradeCheckResult> {
  const identity: GradeCheckResult['identity'] = [];
  const reference: GradeCheckResult['reference'] = [];
  const timing: GradeCheckResult['timing'] = [];
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('no WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float render targets');

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    const programs = {
      legacy: new GLProgram(gl, baseVertexSource, legacySource, 'legacy'),
      current: new GLProgram(gl, baseVertexSource, gradingSource, 'current'),
    };
    const vaos = new Map<GLProgram, WebGLVertexArrayObject>();
    const vaoFor = (program: GLProgram): WebGLVertexArrayObject => {
      const existing = vaos.get(program);
      if (existing) return existing;
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const position = program.attribute('a_position');
      const uv = program.attribute('a_texCoord');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
      if (uv >= 0) {
        gl.enableVertexAttribArray(uv);
        gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
      }
      gl.bindVertexArray(null);
      vaos.set(program, vao);
      return vao;
    };

    const lut = lookLut();
    const lutTexture = createLUTTexture(gl, lut);
    const noLut = createLUTTexture(gl, { title: 'none', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data: new Float32Array(24).fill(1) });

    /** Upload RGBA8 pixels as a texture read with NEAREST, as a clip's pixels are at 1:1. */
    const textureOf = (width: number, height: number, pixels: Uint8Array): WebGLTexture => {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    };

    /** One grading pass of `program` over `input` into `target`, as the compositor sets it up. */
    const pass = (program: GLProgram, input: WebGLTexture, target: RenderTarget, grading: ColorGradingConfig, withLut: boolean): void => {
      target.bind();
      gl.disable(gl.BLEND);
      program.use();
      program.set('u_transform', FULLSCREEN_MATRIX);
      program.set('u_flipY', false);
      program.setTexture('u_inputTexture', input, 0);
      program.set('u_exposure', grading.exposure);
      program.set('u_contrast', grading.contrast);
      program.set('u_saturation', grading.saturation);
      program.set('u_temperature', grading.temperature);
      program.set('u_tint', grading.tint);
      program.set('u_pivot', grading.pivot);
      const cdl = cdlOf(grading);
      program.set('u_cdlActive', cdl.active);
      program.set('u_cdlSlope', new Float32Array(cdl.slope));
      program.set('u_cdlOffset', new Float32Array(cdl.offset));
      program.set('u_cdlPower', new Float32Array(cdl.power));
      program.set('u_lutEnabled', withLut);
      program.set('u_lutIntensity', grading.lutIntensity);
      program.set('u_lutSize', withLut ? lut.size : 1);
      program.set('u_lutDomainMin', new Float32Array([0, 0, 0]));
      program.set('u_lutDomainMax', new Float32Array([1, 1, 1]));
      program.setTexture('u_lutTexture', withLut ? lutTexture : noLut, 1, gl.TEXTURE_3D);
      gl.bindVertexArray(vaoFor(program));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    };

    const readFloat = (target: RenderTarget): Float32Array => {
      const out = new Float32Array(target.width * target.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    };

    /* 1. Every colour, old shader against new, wheels neutral. ----------- */
    const neutral = normalizeGrading({ enabled: true });
    const settings: Array<{ name: string; grading: ColorGradingConfig; withLut: boolean }> = [
      { name: 'all neutral', grading: neutral, withLut: false },
      { name: 'old sliders moved', grading: { ...neutral, exposure: 0.4, contrast: 1.25, saturation: 0.7, temperature: 0.3, tint: -0.2 }, withLut: false },
      { name: 'neutral + LUT at 60%', grading: { ...neutral, lutIntensity: 0.6 }, withLut: true },
      { name: 'old sliders + LUT at 100%', grading: { ...neutral, exposure: -0.3, contrast: 0.8, saturation: 1.3, temperature: -0.2, tint: 0.1, lutIntensity: 1 }, withLut: true },
    ];
    const legacyTarget = new RenderTarget(gl, TILE, TILE, gl.RGBA16F, 'legacy');
    const currentTarget = new RenderTarget(gl, TILE, TILE, gl.RGBA16F, 'current');
    const tile = new Uint8Array(TILE * TILE * 4);
    const tiles: WebGLTexture[] = [];
    for (let tileIndex = 0; tileIndex < (SIDE / TILE) ** 2; tileIndex += 1) {
      for (let i = 0; i < TILE * TILE; i += 1) {
        const colour = tileIndex * TILE * TILE + i;
        tile[i * 4] = colour & 255;
        tile[i * 4 + 1] = (colour >> 8) & 255;
        tile[i * 4 + 2] = (colour >> 16) & 255;
        tile[i * 4 + 3] = 255;
      }
      tiles.push(textureOf(TILE, TILE, tile));
    }
    for (const setting of settings) {
      let differentValues = 0;
      let differentBytes = 0;
      let worst = 0;
      for (const input of tiles) {
        pass(programs.legacy, input, legacyTarget, setting.grading, setting.withLut);
        pass(programs.current, input, currentTarget, setting.grading, setting.withLut);
        const before = readFloat(legacyTarget);
        const after = readFloat(currentTarget);
        for (let i = 0; i < before.length; i += 4) {
          for (let c = 0; c < 3; c += 1) {
            const a = before[i + c];
            const b = after[i + c];
            if (a === b) continue;
            differentValues += 1;
            // What the export would see: the value as an 8-bit level. The old
            // shader could leave a value past 1 when a LUT did; the new one
            // clamps it, which 8 bits would have done anyway.
            const byteA = Math.round(Math.min(1, Math.max(0, a)) * 255);
            const byteB = Math.round(Math.min(1, Math.max(0, b)) * 255);
            if (byteA !== byteB) differentBytes += 1;
            worst = Math.max(worst, Math.abs(Math.min(1, Math.max(0, a)) - Math.min(1, Math.max(0, b))));
          }
        }
      }
      identity.push({ name: setting.name, colours: SIDE * SIDE, differentValues, differentBytes, worst });
    }
    for (const texture of tiles) gl.deleteTexture(texture);

    /* 2. Known colours through moved wheels, against the reference. ------ */
    const colours: Rgb[] = [];
    for (const r of [0, 32, 64, 128, 191, 224, 255]) for (const g of [0, 64, 128, 255]) for (const b of [0, 96, 200, 255]) colours.push([r, g, b]);
    const input = new Uint8Array(colours.length * 4);
    colours.forEach((colour, i) => input.set([colour[0], colour[1], colour[2], 255], i * 4));
    const knownTexture = textureOf(colours.length, 1, input);
    const knownTarget = new RenderTarget(gl, colours.length, 1, gl.RGBA16F, 'known');
    const wheelsMoved: Array<{ name: string; grading: ColorGradingConfig }> = [
      { name: 'lift +0.3 toward blue', grading: { ...neutral, lift: withPuck(withMaster(neutralWheel(), 0.3), 0.5, 0) as Rgb } },
      { name: 'gamma -0.5, warm', grading: { ...neutral, gamma: withPuck(withMaster(neutralWheel(), -0.5), -0.2, 0.3) as Rgb } },
      { name: 'gain +0.4, cool', grading: { ...neutral, gain: withPuck(withMaster(neutralWheel(), 0.4), 0.3, -0.2) as Rgb } },
      { name: 'offset -0.1', grading: { ...neutral, offset: [-0.1, -0.1, -0.1] } },
      {
        name: 'everything at once',
        grading: {
          ...neutral,
          exposure: 0.3, temperature: 0.2, tint: -0.1, contrast: 1.3, pivot: 0.4, saturation: 1.2,
          lift: [0.1, -0.05, 0.2], gamma: [0.2, 0.1, -0.1], gain: [-0.2, 0.1, 0.3], offset: [0.02, -0.03, 0.01],
        },
      },
    ];
    for (const { name, grading } of wheelsMoved) {
      pass(programs.current, knownTexture, knownTarget, grading, false);
      const out = readFloat(knownTarget);
      let worst = 0;
      colours.forEach((colour, i) => {
        const expected = gradePixel([colour[0] / 255, colour[1] / 255, colour[2] / 255], grading);
        for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(out[i * 4 + c] - expected[c]));
      });
      reference.push({ name, colours: colours.length, worst });
    }

    /* 3. A grading pass at 4K. ------------------------------------------ */
    const uhd = new Uint8Array(3840 * 2160 * 4);
    for (let i = 0; i < uhd.length; i += 1) uhd[i] = (i * 2654435761) >>> 24;
    const uhdTexture = textureOf(3840, 2160, uhd);
    const uhdTarget = new RenderTarget(gl, 3840, 2160, gl.RGBA16F, 'uhd');
    const busy = wheelsMoved[wheelsMoved.length - 1].grading;
    const time = (name: string, program: GLProgram, grading: ColorGradingConfig): void => {
      for (let i = 0; i < 5; i += 1) pass(program, uhdTexture, uhdTarget, grading, true);
      gl.finish();
      const started = performance.now();
      const passes = 60;
      for (let i = 0; i < passes; i += 1) pass(program, uhdTexture, uhdTarget, grading, true);
      // A one-pixel read waits for every pass to have really run.
      gl.bindFramebuffer(gl.FRAMEBUFFER, uhdTarget.framebuffer);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      timing.push({ name, msPerPass: (performance.now() - started) / passes });
    };
    time('phase 1 shader, sliders + LUT', programs.legacy, busy);
    time('phase 2 shader, wheels neutral + LUT', programs.current, { ...busy, lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0], offset: [0, 0, 0] });
    time('phase 2 shader, all four wheels + LUT', programs.current, busy);

    return { ok: true, identity, reference, timing };
  } catch (error) {
    return { ok: false, identity, reference, timing, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) };
  }
}
