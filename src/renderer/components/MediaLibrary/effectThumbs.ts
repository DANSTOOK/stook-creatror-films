import { FULLSCREEN_MATRIX, GLProgram, RenderTarget } from '@renderer/engine/GLProgram';
import { createEffect, effectDef } from '@renderer/fx/effects/catalog';
import { samplePicture } from './samplePictures';
import { EFFECT_PASSES } from '@renderer/fx/effects/shaders';
import baseVertexSource from '@renderer/engine/shaders/BaseVertex.glsl?raw';

/**
 * The Effects panel's pictures: each effect's real passes, at its defaults,
 * run on one sample scene - so a tile shows what the effect does rather than
 * the same picture twenty times.
 *
 * As the transition thumbnails (shaderThumbs), on a small WebGL2 canvas of
 * its own, never the compositor's. Each picture is drawn once, kept as a
 * bitmap, and copied onto the tile's canvas.
 *
 * The passes are told the frame is 960x540 though the buffers are smaller:
 * sizes are in pixels of a 1080-line frame, and at a thumbnail's true scale
 * a 3 px halftone dot or a 10 px blur would vanish. So the tile shows a
 * 540-line frame's look, shrunk.
 */

const WIDTH = 320;
const HEIGHT = 180;
const VIRTUAL = { width: 960, height: 540 };

/** The scene effects are shown on: the lake at sunset, with its figure on the shore (samplePictures). */
export function drawEffectSample(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.drawImage(samplePicture('sunset', width, height), 0, 0, width, height);
}

interface State {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  source: WebGLTexture;
  ping: RenderTarget;
  pong: RenderTarget;
  kept: RenderTarget;
  buffer: WebGLBuffer;
  programs: Map<string, GLProgram>;
  vaos: Map<GLProgram, WebGLVertexArrayObject>;
  copy: GLProgram;
}

let state: State | null | undefined;

const COPY_SOURCE = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_inputTexture;
void main() { fragColor = texture(u_inputTexture, v_texCoord); }`;

function setUp(): State | null {
  if (state !== undefined) return state;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available for effect thumbnails');
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Failed to allocate the thumbnail quad');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const picture = document.createElement('canvas');
    picture.width = WIDTH;
    picture.height = HEIGHT;
    const context = picture.getContext('2d');
    if (context) drawEffectSample(context, WIDTH, HEIGHT);
    const source = gl.createTexture();
    if (!source) throw new Error('Failed to allocate the sample texture');
    gl.bindTexture(gl.TEXTURE_2D, source);
    // Texture space has v up, as the compositor's buffers do.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    state = {
      gl,
      canvas,
      source,
      ping: new RenderTarget(gl, WIDTH, HEIGHT, gl.RGBA8, 'thumb-ping'),
      pong: new RenderTarget(gl, WIDTH, HEIGHT, gl.RGBA8, 'thumb-pong'),
      kept: new RenderTarget(gl, WIDTH, HEIGHT, gl.RGBA8, 'thumb-kept'),
      buffer,
      programs: new Map(),
      vaos: new Map(),
      copy: new GLProgram(gl, baseVertexSource, COPY_SOURCE, 'thumb-copy'),
    };
  } catch (error) {
    console.warn(error);
    state = null;
  }
  return state;
}

function vaoFor(s: State, program: GLProgram): WebGLVertexArrayObject | null {
  const cached = s.vaos.get(program);
  if (cached) return cached;
  const { gl } = s;
  const vao = gl.createVertexArray();
  if (!vao) return null;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
  const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
  const position = program.attribute('a_position');
  const texCoord = program.attribute('a_texCoord');
  if (position >= 0) {
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
  }
  if (texCoord >= 0) {
    gl.enableVertexAttribArray(texCoord);
    gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  s.vaos.set(program, vao);
  return vao;
}

function programFor(s: State, source: string, label: string): GLProgram {
  let program = s.programs.get(source);
  if (!program) {
    program = new GLProgram(s.gl, baseVertexSource, source, `thumb:${label}`);
    s.programs.set(source, program);
  }
  return program;
}

/** Draw `program` reading `input` into `target` (null: the canvas). */
function pass(s: State, program: GLProgram, input: WebGLTexture, target: RenderTarget | null, configure: (program: GLProgram) => void): void {
  const { gl } = s;
  if (target) target.bind();
  else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, WIDTH, HEIGHT);
  }
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  program.use();
  program.set('u_transform', FULLSCREEN_MATRIX);
  program.set('u_flipY', false);
  program.set('u_resolution', new Float32Array([VIRTUAL.width, VIRTUAL.height]));
  program.setTexture('u_inputTexture', input, 0);
  configure(program);
  const vao = vaoFor(s, program);
  if (!vao) return;
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

const pictures = new Map<string, ImageBitmap | HTMLCanvasElement>();

/**
 * Where a still tile catches an effect that moves by itself: at a strike of
 * the flash or the punch - not between two, where it shows nothing.
 */
const STILL_SECONDS: Record<string, number> = { flash: 0.04, zoomPulse: 0.02 };

/** Effect `type` at its defaults, `seconds` in, drawn onto the GL canvas (which the next draw replaces). */
function renderEffect(type: string, seconds: number): HTMLCanvasElement | null {
  const s = setUp();
  if (!s) return null;
  try {
    const effect = createEffect(type);
    const passes = EFFECT_PASSES[type] ?? [];
    const context = { ...VIRTUAL, seconds };
    let input = s.source;
    let write = s.ping;
    let read = s.pong;
    passes.forEach((step, index) => {
      if (step.keep) pass(s, s.copy, input, s.kept, () => undefined);
      const last = index === passes.length - 1;
      const program = programFor(s, step.source, `${type}:${index}`);
      const uniforms = step.uniforms(effect.params, context);
      pass(s, program, input, last ? null : write, (configured) => {
        for (const [name, value] of Object.entries(uniforms)) configured.set(name, typeof value === 'number' ? value : new Float32Array(value));
        if (step.original) configured.setTexture('u_original', s.kept.texture, 4);
      });
      if (!last) {
        input = write.texture;
        [write, read] = [read, write];
      }
    });
    if (passes.length === 0) pass(s, s.copy, s.source, null, () => undefined);
    return s.canvas;
  } catch (error) {
    console.warn(error);
    return null;
  }
}

/** The picture of effect `type` at its defaults: drawn the first time it is asked for, then kept. */
function pictureOf(type: string): ImageBitmap | HTMLCanvasElement | null {
  const known = pictures.get(type);
  if (known) return known;
  const drawn = renderEffect(type, STILL_SECONDS[type] ?? 1.3);
  if (!drawn) return null;
  // Kept as a copy: the GL canvas is drawn over by the next effect.
  const copy = document.createElement('canvas');
  copy.width = WIDTH;
  copy.height = HEIGHT;
  copy.getContext('2d')?.drawImage(drawn, 0, 0);
  pictures.set(type, copy);
  return copy;
}

/** Whether effect `type` moves by itself, and so plays on hover rather than wiping between before and after. */
export const effectMoves = (type: string): boolean => effectDef(type)?.animated === true;

/** Effect `type` live, `seconds` in: a moving effect's hover preview. */
export function drawEffectFrame(context: CanvasRenderingContext2D, width: number, height: number, type: string, seconds: number): void {
  const drawn = renderEffect(type, seconds);
  context.clearRect(0, 0, width, height);
  if (drawn) context.drawImage(drawn, 0, 0, width, height);
  else drawEffectSample(context, width, height);
}

/**
 * Before and after, split at `split` (0 to 1 across): the scene as it is on
 * the left, with the effect on the right, and a bright line between - a still
 * effect's hover preview, the line sweeping across.
 */
export function drawEffectCompare(context: CanvasRenderingContext2D, width: number, height: number, type: string, split: number): void {
  drawEffectThumb(context, width, height, type);
  const x = Math.round(width * Math.min(1, Math.max(0, split)));
  context.save();
  context.beginPath();
  context.rect(0, 0, x, height);
  context.clip();
  drawEffectSample(context, width, height);
  context.restore();
  context.fillStyle = 'rgba(255, 255, 255, 0.95)';
  context.fillRect(x - 1, 0, 2, height);
}

/** Draw effect `type`'s picture onto a tile's canvas; the plain sample if it cannot be drawn. */
export function drawEffectThumb(context: CanvasRenderingContext2D, width: number, height: number, type: string): void {
  const picture = pictureOf(type);
  context.clearRect(0, 0, width, height);
  if (picture) context.drawImage(picture, 0, 0, width, height);
  else drawEffectSample(context, width, height);
}
