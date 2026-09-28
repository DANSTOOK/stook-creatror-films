import type { ColorGradingConfig, CubeLUT, GradeCurves } from '@shared/types';
import { FULLSCREEN_MATRIX, GLProgram, RenderTarget } from '@renderer/engine/GLProgram';
import { Compositor } from '@renderer/engine/Compositor';
import { createLUTTexture } from '@renderer/engine/LUTLoader';
import { cdlOf, gradePixel, normalizeGrading, type Rgb } from '@renderer/color/grade';
import { bakeCurves, CURVE_ROWS, CURVE_SIZE, neutralCurves } from '@renderer/color/curves';
import { createClip, createEmptyProject } from '@renderer/store/types';
import baseVertexSource from '@renderer/engine/shaders/BaseVertex.glsl?raw';
import gradingSource from '@renderer/engine/shaders/ColorGrading.glsl?raw';
import previousSource from './fixtures/ColorGrading.v2.glsl?raw';

/**
 * The grading shader on the GPU, against what it replaced and against the
 * reference arithmetic (driven by grade.mjs).
 *
 *   1. Every one of the 16,777,216 8-bit colours through the phase-2 shader
 *      and through this one, with the curves neutral and no vignette: the
 *      results have to be the same half-float values, not merely close.
 *   2. Known colours through curves, wheels and a vignette, against
 *      color/grade.ts and color/curves.ts: within 1/255.
 *   3. What a grading pass costs at 4K, before and after.
 *   4. Dither: a smooth 4K gradient through the real compositor, read back
 *      as the export reads it, with and without.
 */

export interface GradeCheckResult {
  ok: boolean;
  error?: string;
  identity: Array<{ name: string; colours: number; differentValues: number; differentBytes: number; worst: number }>;
  reference: Array<{ name: string; colours: number; worst: number }>;
  redToGreen?: number[];
  timing: Array<{ name: string; msPerPass: number }>;
  dither?: {
    withoutDither: { longestRun: number; steps: number; bandError: number };
    withDither: { longestRun: number; steps: number; bandError: number };
    reproducible: boolean;
    changesPerFrame: boolean;
    untouchedPixelsChanged: number;
  };
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

const curvesWith = (patch: Partial<GradeCurves>): GradeCurves => ({ ...neutralCurves(), ...patch });

export async function runGradeCheck(): Promise<GradeCheckResult> {
  const identity: GradeCheckResult['identity'] = [];
  const reference: GradeCheckResult['reference'] = [];
  const timing: GradeCheckResult['timing'] = [];
  const result: GradeCheckResult = { ok: true, identity, reference, timing };
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
      previous: new GLProgram(gl, baseVertexSource, previousSource, 'previous'),
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

    /** The curve texture the compositor would upload for these curves. */
    const curveTextures = new Map<string, WebGLTexture>();
    const curveTexture = (curves: GradeCurves): WebGLTexture => {
      const baked = bakeCurves(curves);
      const cached = curveTextures.get(baked.key);
      if (cached) return cached;
      const texture = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, CURVE_SIZE, CURVE_ROWS.length, 0, gl.RED, gl.FLOAT, baked.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      curveTextures.set(baked.key, texture);
      return texture;
    };

    /** One grading pass, set up as the compositor sets it up. */
    const pass = (
      program: GLProgram,
      input: WebGLTexture,
      target: RenderTarget,
      grading: ColorGradingConfig,
      options: { lut?: boolean; dither?: boolean; frame?: number } = {},
    ): void => {
      target.bind();
      gl.disable(gl.BLEND);
      program.use();
      program.set('u_transform', FULLSCREEN_MATRIX);
      program.set('u_flipY', false);
      program.set('u_resolution', new Float32Array([target.width, target.height]));
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
      const baked = bakeCurves(grading.curves);
      program.set('u_levelCurvesActive', baked.levelsActive);
      program.set('u_versusCurvesActive', baked.versusActive);
      if (baked.levelsActive || baked.versusActive) program.setTexture('u_curveTexture', curveTexture(grading.curves), 2);
      program.set('u_vignetteActive', grading.vignette.amount !== 0);
      program.set('u_vignetteAmount', grading.vignette.amount);
      program.set('u_vignetteSize', grading.vignette.size);
      program.set('u_vignetteRoundness', grading.vignette.roundness);
      program.set('u_vignetteFeather', grading.vignette.feather);
      program.set('u_dither', options.dither === true);
      program.setInt('u_frame', options.frame ?? 0);
      const withLut = options.lut === true;
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

    /* 1. Every colour, previous shader against this one. ----------------- */
    const neutral = normalizeGrading({ enabled: true });
    const wheels = {
      lift: [0.1, -0.05, 0.2] as Rgb, gamma: [0.2, 0.1, -0.1] as Rgb, gain: [-0.2, 0.1, 0.3] as Rgb, offset: [0.02, -0.03, 0.01] as Rgb,
    };
    const settings: Array<{ name: string; grading: ColorGradingConfig; lut: boolean; dither: boolean }> = [
      // Dither on: a neutral grade leaves every value on its level, so it adds nothing.
      { name: 'all neutral, dither on', grading: neutral, lut: false, dither: true },
      { name: 'sliders moved', grading: { ...neutral, exposure: 0.4, contrast: 1.25, saturation: 0.7, temperature: 0.3, tint: -0.2 }, lut: false, dither: false },
      { name: 'wheels moved + LUT at 60%', grading: { ...neutral, ...wheels, lutIntensity: 0.6 }, lut: true, dither: false },
      { name: 'everything but curves + LUT at 100%', grading: { ...neutral, ...wheels, exposure: -0.3, contrast: 0.8, pivot: 0.4, saturation: 1.3, lutIntensity: 1 }, lut: true, dither: false },
    ];
    const previousTarget = new RenderTarget(gl, TILE, TILE, gl.RGBA16F, 'previous');
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
        pass(programs.previous, input, previousTarget, setting.grading, { lut: setting.lut });
        pass(programs.current, input, currentTarget, setting.grading, { lut: setting.lut, dither: setting.dither });
        const before = readFloat(previousTarget);
        const after = readFloat(currentTarget);
        for (let i = 0; i < before.length; i += 4) {
          for (let c = 0; c < 3; c += 1) {
            const a = before[i + c];
            const b = after[i + c];
            if (a === b) continue;
            differentValues += 1;
            if (Math.round(a * 255) !== Math.round(b * 255)) differentBytes += 1;
            worst = Math.max(worst, Math.abs(a - b));
          }
        }
      }
      identity.push({ name: setting.name, colours: SIDE * SIDE, differentValues, differentBytes, worst });
    }
    for (const texture of tiles) gl.deleteTexture(texture);

    /* 2. Known colours through the curves, against the reference. -------- */
    const colours: Rgb[] = [];
    for (const r of [0, 32, 64, 128, 191, 224, 255]) for (const g of [0, 64, 128, 255]) for (const b of [0, 96, 200, 255]) colours.push([r, g, b]);
    const input = new Uint8Array(colours.length * 4);
    colours.forEach((colour, i) => input.set([colour[0], colour[1], colour[2], 255], i * 4));
    const knownTexture = textureOf(colours.length, 1, input);
    const knownTarget = new RenderTarget(gl, colours.length, 1, gl.RGBA16F, 'known');
    const sCurve = [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.85 }, { x: 1, y: 1 }];
    const curveSettings: Array<{ name: string; grading: ColorGradingConfig }> = [
      { name: 'wheels alone', grading: { ...neutral, ...wheels } },
      { name: 'inverted master', grading: { ...neutral, curves: curvesWith({ master: [{ x: 0, y: 1 }, { x: 1, y: 0 }] }) } },
      { name: 'S-curve on master', grading: { ...neutral, curves: curvesWith({ master: sCurve }) } },
      { name: 'red lifted, blue crushed', grading: { ...neutral, curves: curvesWith({ red: [{ x: 0, y: 0.1 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }], blue: [{ x: 0, y: 0 }, { x: 0.4, y: 0.2 }, { x: 1, y: 0.9 }] }) } },
      { name: 'Hue vs Hue: red a third of a turn', grading: { ...neutral, curves: curvesWith({ hueVsHue: [{ x: 0, y: 1 / 3 }, { x: 0.3, y: 0 }, { x: 0.7, y: 0 }] }) } },
      { name: 'Hue vs Sat: blues out', grading: { ...neutral, curves: curvesWith({ hueVsSat: [{ x: 0.2, y: 0 }, { x: 2 / 3, y: -0.8 }, { x: 0.9, y: 0 }] }) } },
      { name: 'Hue vs Luma: greens down', grading: { ...neutral, curves: curvesWith({ hueVsLuma: [{ x: 0.1, y: 0 }, { x: 1 / 3, y: -0.2 }, { x: 0.55, y: 0 }] }) } },
      { name: 'Luma vs Sat: shadows grey', grading: { ...neutral, curves: curvesWith({ lumaVsSat: [{ x: 0, y: -1 }, { x: 0.4, y: 0 }, { x: 1, y: 0.3 }] }) } },
      {
        name: 'curves + wheels + sliders together',
        grading: {
          ...neutral, ...wheels, exposure: 0.2, contrast: 1.2, saturation: 1.1,
          curves: curvesWith({ master: sCurve, green: [{ x: 0, y: 0 }, { x: 0.5, y: 0.45 }, { x: 1, y: 1 }], hueVsSat: [{ x: 0, y: 0.3 }, { x: 0.5, y: -0.3 }] }),
        },
      },
    ];
    for (const { name, grading } of curveSettings) {
      pass(programs.current, knownTexture, knownTarget, grading);
      const out = readFloat(knownTarget);
      let worst = 0;
      colours.forEach((colour, i) => {
        const expected = gradePixel([colour[0] / 255, colour[1] / 255, colour[2] / 255], grading);
        for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(out[i * 4 + c] - expected[c]));
      });
      reference.push({ name, colours: colours.length, worst });
      if (name.startsWith('Hue vs Hue')) {
        const red = colours.findIndex((colour) => colour[0] === 255 && colour[1] === 0 && colour[2] === 0);
        result.redToGreen = [...out.subarray(red * 4, red * 4 + 3)].map((value) => Math.round(value * 255));
      }
    }

    // The vignette, over a flat grey, at every pixel of a small frame.
    const vw = 160;
    const vh = 90;
    const flat = new Uint8Array(vw * vh * 4).fill(160);
    const flatTexture = textureOf(vw, vh, flat);
    const vignetteTarget = new RenderTarget(gl, vw, vh, gl.RGBA16F, 'vignette');
    for (const vignette of [
      { amount: -0.8, size: 0.4, roundness: 0, feather: 0.6 },
      { amount: 0.5, size: 0.3, roundness: 1, feather: 0.3 },
      { amount: -1, size: 0.2, roundness: -1, feather: 0.8 },
    ]) {
      const grading = { ...neutral, vignette };
      pass(programs.current, flatTexture, vignetteTarget, grading);
      const out = readFloat(vignetteTarget);
      let worst = 0;
      for (let y = 0; y < vh; y += 1) {
        for (let x = 0; x < vw; x += 1) {
          const expected = gradePixel([160 / 255, 160 / 255, 160 / 255], grading, { u: (x + 0.5) / vw, v: (y + 0.5) / vh, aspect: vw / vh });
          worst = Math.max(worst, Math.abs(out[(y * vw + x) * 4] - expected[0]));
        }
      }
      reference.push({ name: `vignette ${vignette.amount}, size ${vignette.size}, roundness ${vignette.roundness}`, colours: vw * vh, worst });
    }

    /* 3. A grading pass at 4K. ------------------------------------------ */
    const uhd = new Uint8Array(3840 * 2160 * 4);
    for (let i = 0; i < uhd.length; i += 1) uhd[i] = (i * 2654435761) >>> 24;
    const uhdTexture = textureOf(3840, 2160, uhd);
    const uhdTarget = new RenderTarget(gl, 3840, 2160, gl.RGBA16F, 'uhd');
    const busy = { ...neutral, ...wheels, exposure: 0.3, contrast: 1.3, saturation: 1.2, lutIntensity: 1 };
    const everything: ColorGradingConfig = {
      ...busy,
      curves: curveSettings[curveSettings.length - 1].grading.curves,
      vignette: { amount: -0.5, size: 0.4, roundness: 0, feather: 0.5 },
    };
    const everythingWithHue: ColorGradingConfig = {
      ...everything,
      curves: { ...everything.curves, hueVsHue: [{ x: 0, y: 0.1 }, { x: 0.5, y: -0.1 }], hueVsLuma: [{ x: 0.3, y: 0.1 }, { x: 0.8, y: 0 }], lumaVsSat: [{ x: 0, y: -0.5 }, { x: 1, y: 0 }] },
    };
    const time = (name: string, program: GLProgram, grading: ColorGradingConfig, dither: boolean): void => {
      for (let i = 0; i < 5; i += 1) pass(program, uhdTexture, uhdTarget, grading, { lut: true, dither });
      const one = new Float32Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, uhdTarget.framebuffer);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, one);
      const started = performance.now();
      const passes = 60;
      for (let i = 0; i < passes; i += 1) pass(program, uhdTexture, uhdTarget, grading, { lut: true, dither, frame: i });
      // A one-pixel read waits for every pass to have really run.
      gl.bindFramebuffer(gl.FRAMEBUFFER, uhdTarget.framebuffer);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, one);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      timing.push({ name, msPerPass: (performance.now() - started) / passes });
    };
    time('phase 2 shader: sliders, wheels, LUT', programs.previous, busy, false);
    time('phase 3 shader: same, curves neutral, no dither', programs.current, busy, false);
    time('phase 3 shader: + level curves, vignette, dither', programs.current, everything, true);
    time('phase 3 shader: + all four versus curves too', programs.current, everythingWithHue, true);

    /* 4. Dither, through the real compositor, as the export reads it. ---- */
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = 3840;
    exportCanvas.height = 2160;
    const compositor = Compositor.fromCanvas(exportCanvas, 3840, 2160);
    const greyTexture = compositor.context.createTexture()!;
    {
      const cgl = compositor.context;
      cgl.bindTexture(cgl.TEXTURE_2D, greyTexture);
      cgl.texImage2D(cgl.TEXTURE_2D, 0, cgl.RGBA8, 3840, 2160, 0, cgl.RGBA, cgl.UNSIGNED_BYTE, new Uint8Array(3840 * 2160 * 4).fill(128));
      cgl.texParameteri(cgl.TEXTURE_2D, cgl.TEXTURE_MIN_FILTER, cgl.NEAREST);
      cgl.texParameteri(cgl.TEXTURE_2D, cgl.TEXTURE_MAG_FILTER, cgl.NEAREST);
    }
    // A flat grey with a wide, soft vignette: a smooth 4K gradient from the
    // centre out, which 8 bits can only show as rings.
    const base = createEmptyProject(3840, 2160, 30);
    const clip = createClip({ trackId: base.tracks[0].id, name: 'grey', sourceUri: 'grey', startFrame: 0, durationFrames: 10 });
    clip.colorGrading = normalizeGrading({ enabled: true, vignette: { amount: -0.6, size: 0.1, roundness: 0, feather: 1 } });
    const project = { ...base, clips: { [clip.id]: clip }, durationFrames: 10 };
    const render = (dither: boolean, frame: number): Uint8Array => {
      compositor.dither = dither;
      compositor.renderFrame(project, frame, () => ({ texture: greyTexture, flipY: false }), false);
      return compositor.readPixels(false);
    };
    const measure = (pixels: Uint8Array): { longestRun: number; steps: number; bandError: number } => {
      // The middle row from the left edge inward, where it darkens smoothly -
      // short of the flat centre, where one level for 500 pixels is right.
      const row = 1080;
      let longestRun = 1;
      let run = 1;
      let steps = 0;
      for (let x = 1; x < 1600; x += 1) {
        const a = pixels[(row * 3840 + x - 1) * 4];
        const b = pixels[(row * 3840 + x) * 4];
        if (a === b) {
          run += 1;
          longestRun = Math.max(longestRun, run);
        } else {
          run = 1;
          steps += 1;
        }
      }
      // Banding as the eye sees it: the average of 64 rows around the middle,
      // against the true (unquantized) value there. Bands are a staircase
      // around the true ramp; dither averages back onto it.
      let error = 0;
      for (let x = 0; x < 1920; x += 1) {
        let sum = 0;
        for (let y = row - 32; y < row + 32; y += 1) sum += pixels[(y * 3840 + x) * 4];
        const truth = gradePixel([128 / 255, 128 / 255, 128 / 255], clip.colorGrading, { u: (x + 0.5) / 3840, v: (row + 0.5) / 2160, aspect: 3840 / 2160 })[0] * 255;
        error += Math.abs(sum / 64 - truth);
      }
      return { longestRun, steps, bandError: error / 1920 };
    };
    const plain = render(false, 0);
    const dithered = render(true, 0);
    const again = render(true, 0);
    const nextFrame = render(true, 1);
    // An ungraded frame must not change at all with dither on.
    const ungradedClip = { ...clip, colorGrading: normalizeGrading({ enabled: false }) };
    const ungradedProject = { ...project, clips: { [clip.id]: ungradedClip } };
    compositor.dither = true;
    compositor.renderFrame(ungradedProject, 0, () => ({ texture: greyTexture, flipY: false }), false);
    const ungraded = compositor.readPixels(false);
    let untouchedPixelsChanged = 0;
    for (let i = 0; i < ungraded.length; i += 4) if (ungraded[i] !== 128) untouchedPixelsChanged += 1;
    result.dither = {
      withoutDither: measure(plain),
      withDither: measure(dithered),
      reproducible: dithered.every((value, i) => value === again[i]),
      changesPerFrame: dithered.some((value, i) => value !== nextFrame[i]),
      untouchedPixelsChanged,
    };
    compositor.dispose();

    return result;
  } catch (error) {
    return { ...result, ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) };
  }
}
