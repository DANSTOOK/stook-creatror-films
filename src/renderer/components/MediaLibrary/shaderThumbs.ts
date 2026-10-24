import { ShaderTransitionPrograms } from '@renderer/fx/transitions/shaders';
import { shaderTransition } from '@renderer/fx/transitions/catalog';
import { FULLSCREEN_MATRIX, type GLProgram } from '@renderer/engine/GLProgram';
import { cancelFrame, requestFrame } from '@renderer/timing/animationFrame';
import { drawTransitionThumb } from './libraryThumbs';
import baseVertexSource from '@renderer/engine/shaders/BaseVertex.glsl?raw';

/**
 * The Transitions panel's pictures of the shader transitions: the real
 * shader, run on the same two pictures the built-in ones use (an amber A and
 * a blue B), so what the panel shows is what the timeline will draw.
 *
 * One small WebGL2 canvas of its own, never the compositor's: a thumbnail
 * must not cost the viewer a frame, and a lost thumbnail context cannot
 * take the viewer with it. Each picture is drawn there and copied onto the
 * tile's own 2D canvas at once.
 *
 * Fifty-odd programs compiled the moment the panel opens would stall it, so
 * the driver compiles them in the background, a few in flight at a time, in
 * the order the tiles ask (ShaderTransitionPrograms.prepare): nothing waits
 * on a compile, and a tile shows its still once its program is ready.
 */

const WIDTH = 256;
const HEIGHT = 144;

interface Thumbs {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  programs: ShaderTransitionPrograms;
  from: WebGLTexture;
  to: WebGLTexture;
  buffer: WebGLBuffer;
  vaos: Map<GLProgram, WebGLVertexArrayObject>;
}

let thumbs: Thumbs | null | undefined;

/** A side's picture, as the built-in thumbnails draw it: A at progress 0 of a dissolve, B at 1. */
function sideTexture(gl: WebGL2RenderingContext, progress: 0 | 1): WebGLTexture {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');
  if (context) drawTransitionThumb(context, WIDTH, HEIGHT, 'crossDissolve', progress);
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to allocate a thumbnail texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Texture space has v up, as the compositor's buffers do.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function setUp(): Thumbs | null {
  if (thumbs !== undefined) return thumbs;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available for thumbnails');
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Failed to allocate the thumbnail quad');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    thumbs = {
      gl,
      canvas,
      programs: new ShaderTransitionPrograms(gl, baseVertexSource),
      from: sideTexture(gl, 0),
      to: sideTexture(gl, 1),
      buffer,
      vaos: new Map(),
    };
  } catch (error) {
    console.warn(error);
    thumbs = null;
  }
  return thumbs;
}

function vaoFor(state: Thumbs, program: GLProgram): WebGLVertexArrayObject | null {
  const cached = state.vaos.get(program);
  if (cached) return cached;
  const { gl } = state;
  const vao = gl.createVertexArray();
  if (!vao) return null;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
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
  state.vaos.set(program, vao);
  return vao;
}

/* Compiling, one a frame ------------------------------------------------------- */

const waiting: Array<{ id: string; done(): void }> = [];
let pump = 0;

/** How many programs the driver is asked to compile at once. */
const IN_FLIGHT = 6;

function compileNext(): void {
  pump = 0;
  const programs = setUp()?.programs;
  // The first few in the queue are started (or asked again); those done leave it.
  for (let index = 0; index < Math.min(IN_FLIGHT, waiting.length); ) {
    const entry = waiting[index];
    if (!programs || programs.prepare(entry.id)) {
      waiting.splice(index, 1);
      entry.done();
    } else index += 1;
  }
  if (waiting.length > 0) pump = requestFrame(compileNext);
}

/** Resolves once `id`'s program is compiled (or could not be), in the order asked. */
export function shaderThumbReady(id: string): Promise<void> {
  const state = setUp();
  if (!state || state.programs.has(id) || !shaderTransition(id)) return Promise.resolve();
  return new Promise((done) => {
    waiting.push({ id, done });
    if (!pump) pump = requestFrame(compileNext);
  });
}

/** Stop compiling for tiles that went away (the panel closed). */
export function cancelShaderThumbs(): void {
  if (pump) cancelFrame(pump);
  pump = 0;
  for (const entry of waiting.splice(0)) entry.done();
}

/* Drawing ------------------------------------------------------------------------- */

/**
 * Draw shader transition `id` at `progress` onto `context` (its own canvas,
 * `width` by `height`). Before its program is ready, the outgoing picture.
 */
export function drawShaderThumb(context: CanvasRenderingContext2D, width: number, height: number, id: string, progress: number): void {
  const state = setUp();
  const ready = state?.programs.has(id) ? state : null;
  if (!ready) {
    drawTransitionThumb(context, width, height, 'crossDissolve', 0);
    return;
  }
  const { gl } = ready;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const program = ready.programs.use(id, Math.min(1, Math.max(0, progress)), WIDTH / HEIGHT, undefined, 0, 1);
  const vao = program ? vaoFor(ready, program) : null;
  if (program && vao) {
    program.set('u_transform', FULLSCREEN_MATRIX);
    program.set('u_flipY', false);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ready.from);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ready.to);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
  context.clearRect(0, 0, width, height);
  context.drawImage(ready.canvas, 0, 0, width, height);
}

/** Where a still thumbnail of `id` stops. */
export const shaderStillProgress = (id: string): number => shaderTransition(id)?.still ?? 0.5;
