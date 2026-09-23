import type { Clip, ProjectState, Track } from '@shared/types';
import { sourceFrameFor } from '@renderer/timing/clipSpeed';
import { fadeGainAt } from '@renderer/timing/clipFades';
import { degToRad } from '@shared/utils/math';
import { evaluateTransform } from './KeyframeEvaluator';
import { FULLSCREEN_MATRIX, GLProgram, RenderTarget, makeQuadMatrix } from './GLProgram';
import type { LUTLoader } from './LUTLoader';

import baseVertexSource from './shaders/BaseVertex.glsl?raw';
import maskingFragmentSource from './shaders/MaskingSDF.glsl?raw';
import colorGradingFragmentSource from './shaders/ColorGrading.glsl?raw';
import chromaKeyFragmentSource from './shaders/ChromaKey.glsl?raw';
import pixelArtFragmentSource from './shaders/PixelArtFilter.glsl?raw';

/**
 * Ping-pong FBO render loop.
 *
 * Each visible clip is rasterized into a project-sized buffer, pushed through
 * its enabled effect passes (chroma key -> grade -> mask -> pixel art) by
 * swapping between two framebuffers, then blended into the scene accumulator.
 *
 * Alpha handling is the load-bearing detail for game-asset export:
 *   - source textures and effect buffers hold STRAIGHT alpha,
 *   - the scene accumulator holds PREMULTIPLIED alpha (the only form in which
 *     "over" compositing is correct),
 *   - the final resolve pass un-premultiplies again, so both the on-screen
 *     canvas and `readPixels` hand back straight RGBA with no dark fringing
 *     around transparent sprite edges.
 */

/** Draws a source texture as-is; the layer rasterization pass. */
const TRANSFER_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;

void main() {
    // Sampling outside the quad must not smear edge texels across the frame.
    if (any(lessThan(v_texCoord, vec2(0.0))) || any(greaterThan(v_texCoord, vec2(1.0)))) {
        fragColor = vec4(0.0);
        return;
    }
    fragColor = texture(u_inputTexture, v_texCoord);
}
`;

/** Straight alpha in, premultiplied out, ready for `blendFunc(ONE, 1-SRC_A)`. */
const COMPOSITE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;
uniform float u_opacity;

void main() {
    vec4 texColor = texture(u_inputTexture, v_texCoord);
    float alpha = texColor.a * u_opacity;
    fragColor = vec4(texColor.rgb * alpha, alpha);
}
`;

/** Premultiplied in, straight out. */
const RESOLVE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;
uniform bool u_checkerboard;
uniform vec2 u_resolution;

void main() {
    vec4 premultiplied = texture(u_inputTexture, v_texCoord);
    vec3 straight = premultiplied.a > 0.0 ? premultiplied.rgb / premultiplied.a : vec3(0.0);

    if (u_checkerboard) {
        // Transparency checkerboard, drawn behind the frame in the viewport only.
        vec2 cell = floor(v_texCoord * u_resolution / 16.0);
        float parity = mod(cell.x + cell.y, 2.0);
        vec3 board = mix(vec3(0.18), vec3(0.26), parity);
        fragColor = vec4(mix(board, straight, premultiplied.a), 1.0);
        return;
    }

    fragColor = vec4(straight, premultiplied.a);
}
`;

const QUAD_VERTICES = new Float32Array([
  // x, y, u, v
  0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1,
]);

export interface ClipSource {
  texture: WebGLTexture;
  /** Video and canvas sources arrive top-down and need a flipped V axis. */
  flipY: boolean;
}

/** Supplies the decoded texture for a clip at a given source frame. */
export type ClipSourceResolver = (clip: Clip, sourceFrame: number) => ClipSource | null;

export interface CompositorStats {
  clipsDrawn: number;
  passes: number;
  lastFrameMs: number;
}

export interface CompositorOptions {
  /** Draws a checkerboard behind the frame in the viewport. Off for export. */
  showTransparencyGrid?: boolean;
  /** Nearest-neighbour upscaling of the final image, for pixel-art projects. */
  pixelArtViewport?: boolean;
}

export class Compositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly vaos = new Map<GLProgram, WebGLVertexArrayObject>();

  private readonly transferProgram: GLProgram;
  private readonly chromaKeyProgram: GLProgram;
  private readonly colorGradingProgram: GLProgram;
  private readonly maskingProgram: GLProgram;
  private readonly pixelArtProgram: GLProgram;
  private readonly compositeProgram: GLProgram;
  private readonly resolveProgram: GLProgram;

  /** Ping-pong pair used by the per-clip effect chain. */
  private ping: RenderTarget;
  private pong: RenderTarget;
  /** Premultiplied accumulator for the whole frame. */
  private scene: RenderTarget;
  /** Straight-alpha result, the surface `readPixels` reads back. */
  private output: RenderTarget;

  /**
   * 1x1x1 identity stand-in for the LUT sampler.
   *
   * WebGL2 rejects a draw (INVALID_OPERATION) when two samplers of different
   * types resolve to the same texture unit, and an unset sampler defaults to
   * unit 0 - where the 2D input texture lives. So the colour-grading program
   * must always have SOMETHING bound to its sampler3D, LUT or no LUT.
   */
  private readonly defaultLutTexture: WebGLTexture;

  private width: number;
  private height: number;
  private disposed = false;

  readonly stats: CompositorStats = { clipsDrawn: 0, passes: 0, lastFrameMs: 0 };

  options: CompositorOptions;

  /**
   * Assigned after construction by the renderer, since the loader needs the
   * context this compositor creates.
   */
  lutLoader: LUTLoader | undefined;

  constructor(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    lutLoader?: LUTLoader,
    options: CompositorOptions = {},
  ) {
    this.gl = gl;
    this.lutLoader = lutLoader;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.options = options;

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Failed to allocate quad vertex buffer');
    this.vertexBuffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const program = (fragment: string, label: string): GLProgram =>
      new GLProgram(gl, baseVertexSource, fragment, label);

    this.transferProgram = program(TRANSFER_FRAGMENT_SOURCE, 'transfer');
    this.chromaKeyProgram = program(chromaKeyFragmentSource, 'chroma-key');
    this.colorGradingProgram = program(colorGradingFragmentSource, 'color-grading');
    this.maskingProgram = program(maskingFragmentSource, 'masking-sdf');
    this.pixelArtProgram = program(pixelArtFragmentSource, 'pixel-art');
    this.compositeProgram = program(COMPOSITE_FRAGMENT_SOURCE, 'composite');
    this.resolveProgram = program(RESOLVE_FRAGMENT_SOURCE, 'resolve');

    // Half-float intermediates keep grading headroom; 8-bit is the fallback for
    // drivers without float render targets.
    const hasFloatTargets = gl.getExtension('EXT_color_buffer_float') !== null;
    const format = hasFloatTargets ? gl.RGBA16F : gl.RGBA8;

    this.defaultLutTexture = Compositor.createIdentityLutTexture(gl);

    this.ping = new RenderTarget(gl, this.width, this.height, format, 'ping');
    this.pong = new RenderTarget(gl, this.width, this.height, format, 'pong');
    this.scene = new RenderTarget(gl, this.width, this.height, format, 'scene');
    this.output = new RenderTarget(gl, this.width, this.height, gl.RGBA8, 'output');
  }

  /**
   * Create a compositor against a canvas, with a context configured to keep
   * alpha rather than compositing it away.
   */
  static fromCanvas(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    width: number,
    height: number,
    lutLoader?: LUTLoader,
    options?: CompositorOptions,
  ): Compositor {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;

    if (!gl) throw new Error('WebGL2 is not available in this context');
    return new Compositor(gl, width, height, lutLoader, options);
  }

  /** A single white texel, so sampling it never alters the graded colour. */
  private static createIdentityLutTexture(gl: WebGL2RenderingContext): WebGLTexture {
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to allocate the placeholder LUT texture');

    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGB16F,
      1,
      1,
      1,
      0,
      gl.RGB,
      gl.FLOAT,
      new Float32Array([1, 1, 1]),
    );
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D, null);

    return texture;
  }

  get context(): WebGL2RenderingContext {
    return this.gl;
  }

  get resolution(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  private vaoFor(program: GLProgram): WebGLVertexArrayObject {
    const cached = this.vaos.get(program);
    if (cached) return cached;

    const { gl } = this;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to allocate vertex array object');

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

    const positionLocation = program.attribute('a_position');
    const texCoordLocation = program.attribute('a_texCoord');
    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;

    if (positionLocation >= 0) {
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0);
    }
    if (texCoordLocation >= 0) {
      gl.enableVertexAttribArray(texCoordLocation);
      gl.vertexAttribPointer(
        texCoordLocation,
        2,
        gl.FLOAT,
        false,
        stride,
        2 * Float32Array.BYTES_PER_ELEMENT,
      );
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.vaos.set(program, vao);
    return vao;
  }

  private drawQuad(program: GLProgram): void {
    const { gl } = this;
    gl.bindVertexArray(this.vaoFor(program));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    this.stats.passes += 1;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;
    for (const target of [this.ping, this.pong, this.scene, this.output]) {
      target.resize(w, h);
    }
  }

  /** Swap the ping-pong pair after a pass has written into `pong`. */
  private swap(): void {
    const previous = this.ping;
    this.ping = this.pong;
    this.pong = previous;
  }

  /** Clips that are live at `frame`, ordered bottom track first. */
  static visibleClips(project: ProjectState, frame: number): Clip[] {
    const trackOrder = new Map<string, Track>();
    for (const track of project.tracks) trackOrder.set(track.id, track);

    return Object.values(project.clips)
      .filter((clip) => {
        const track = trackOrder.get(clip.trackId);
        if (!track || !track.visible || track.type === 'audio') return false;
        return frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames;
      })
      .sort((a, b) => {
        const orderA = trackOrder.get(a.trackId)?.order ?? 0;
        const orderB = trackOrder.get(b.trackId)?.order ?? 0;
        return orderA - orderB || a.startFrame - b.startFrame;
      });
  }

  /** Rasterize one clip into `ping` with its resolved transform applied. */
  private renderLayer(clip: Clip, frame: number, source: ClipSource): number {
    const { gl } = this;
    const transform = evaluateTransform(clip.transform, frame);

    this.ping.bind();
    this.ping.clearTransparent();
    gl.disable(gl.BLEND);

    // Position is in project pixels relative to the frame centre, y pointing
    // down; scale 1.0 means "fills the project frame".
    const centerX = (transform.position.x / this.width) * 2;
    const centerY = -(transform.position.y / this.height) * 2;

    const matrix = makeQuadMatrix(
      centerX,
      centerY,
      transform.scale.x,
      transform.scale.y,
      -degToRad(transform.rotation),
      transform.anchorPoint.x,
      transform.anchorPoint.y,
    );

    this.transferProgram.use();
    this.transferProgram.set('u_transform', matrix);
    this.transferProgram.set('u_flipY', source.flipY);
    this.transferProgram.setTexture('u_inputTexture', source.texture, 0);
    this.drawQuad(this.transferProgram);

    // A fade at either end of the clip rides on top of whatever opacity the
    // keyframes asked for, so the two multiply rather than fight.
    return transform.opacity * fadeGainAt(clip, frame - clip.startFrame);
  }

  /** Run one full-screen effect pass from `ping` into `pong`, then swap. */
  private runPass(program: GLProgram, configure: (program: GLProgram) => void): void {
    const { gl } = this;

    this.pong.bind();
    this.pong.clearTransparent();
    gl.disable(gl.BLEND);

    program.use();
    program.set('u_transform', FULLSCREEN_MATRIX);
    program.set('u_flipY', false);
    program.set('u_resolution', new Float32Array([this.width, this.height]));
    program.setTexture('u_inputTexture', this.ping.texture, 0);
    configure(program);
    this.drawQuad(program);

    this.swap();
  }

  private applyEffectChain(clip: Clip): void {
    if (clip.chromaKey.enabled) {
      this.runPass(this.chromaKeyProgram, (program) => {
        program.set('u_keyColor', new Float32Array(clip.chromaKey.keyColor));
        program.set('u_similarity', clip.chromaKey.similarity);
        program.set('u_smoothness', clip.chromaKey.smoothness);
        program.set('u_spill', clip.chromaKey.spill);
      });
    }

    if (clip.colorGrading.enabled) {
      const grading = clip.colorGrading;
      const loaded = grading.lutUri ? this.lutLoader?.get(grading.lutUri) : undefined;

      this.runPass(this.colorGradingProgram, (program) => {
        program.set('u_exposure', grading.exposure);
        program.set('u_contrast', grading.contrast);
        program.set('u_saturation', grading.saturation);
        program.set('u_temperature', grading.temperature);
        program.set('u_tint', grading.tint);
        program.set('u_lutEnabled', loaded !== undefined);
        program.set('u_lutIntensity', grading.lutIntensity);

        program.set('u_lutSize', loaded ? loaded.lut.size : 1);
        program.set('u_lutDomainMin', new Float32Array(loaded ? loaded.lut.domainMin : [0, 0, 0]));
        program.set('u_lutDomainMax', new Float32Array(loaded ? loaded.lut.domainMax : [1, 1, 1]));

        // Always bind unit 1, even with no LUT: leaving the sampler3D unset
        // would leave it pointing at unit 0 alongside the sampler2D, which is
        // an INVALID_OPERATION that silently drops the entire draw.
        program.setTexture(
          'u_lutTexture',
          loaded ? loaded.texture : this.defaultLutTexture,
          1,
          this.gl.TEXTURE_3D,
        );
      });
    }

    if (clip.mask.enabled && clip.mask.type !== 0) {
      this.runPass(this.maskingProgram, (program) => {
        program.setInt('u_maskType', clip.mask.type);
        program.set('u_maskCenter', new Float32Array([clip.mask.center.x, clip.mask.center.y]));
        program.set('u_maskSize', new Float32Array([clip.mask.size.x, clip.mask.size.y]));
        program.set('u_maskRotation', clip.mask.rotation);
        program.set('u_cornerRadius', clip.mask.cornerRadius);
        program.set('u_feather', clip.mask.feather);
        program.set('u_invertMask', clip.mask.invert);
      });
    }

    if (clip.pixelArt.enabled) {
      this.runPass(this.pixelArtProgram, (program) => {
        program.set('u_pixelSize', clip.pixelArt.pixelSize);
        program.set('u_paletteSteps', clip.pixelArt.paletteSteps);
        program.set('u_alphaThreshold', clip.pixelArt.alphaThreshold);
      });
    }
  }

  /** Blend the finished layer in `ping` onto the premultiplied scene buffer. */
  private compositeLayer(opacity: number): void {
    const { gl } = this;

    this.scene.bind();
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.compositeProgram.use();
    this.compositeProgram.set('u_transform', FULLSCREEN_MATRIX);
    this.compositeProgram.set('u_flipY', false);
    this.compositeProgram.set('u_opacity', opacity);
    this.compositeProgram.setTexture('u_inputTexture', this.ping.texture, 0);
    this.drawQuad(this.compositeProgram);

    gl.disable(gl.BLEND);
  }

  /**
   * Composite one timeline frame.
   *
   * `presentToCanvas` is on for the viewport and off for export, where the
   * result is read back from the output target instead.
   */
  renderFrame(
    project: ProjectState,
    frame: number,
    resolveSource: ClipSourceResolver,
    presentToCanvas = true,
  ): void {
    if (this.disposed) throw new Error('Compositor has been disposed');

    const started = performance.now();
    const { gl } = this;

    this.stats.clipsDrawn = 0;
    this.stats.passes = 0;

    this.scene.bind();
    // Transparent clear: the project frame keeps its alpha so pixel-art and
    // video layers can be exported straight to a sprite sheet.
    this.scene.clearTransparent();

    for (const clip of Compositor.visibleClips(project, frame)) {
      const sourceFrame = sourceFrameFor(clip, frame);
      const source = resolveSource(clip, sourceFrame);
      if (!source) continue;

      const opacity = this.renderLayer(clip, frame, source);
      if (opacity <= 0) continue;

      this.applyEffectChain(clip);
      this.compositeLayer(opacity);
      this.stats.clipsDrawn += 1;
    }

    // Resolve premultiplied scene -> straight alpha output.
    this.output.setFilter(this.options.pixelArtViewport ? gl.NEAREST : gl.LINEAR);
    this.output.bind();
    this.output.clearTransparent();
    gl.disable(gl.BLEND);

    this.resolveProgram.use();
    this.resolveProgram.set('u_transform', FULLSCREEN_MATRIX);
    this.resolveProgram.set('u_flipY', false);
    this.resolveProgram.set('u_checkerboard', false);
    this.resolveProgram.set('u_resolution', new Float32Array([this.width, this.height]));
    this.resolveProgram.setTexture('u_inputTexture', this.scene.texture, 0);
    this.drawQuad(this.resolveProgram);

    if (presentToCanvas) this.present();

    this.stats.lastFrameMs = performance.now() - started;
  }

  /** Blit the output target to the default framebuffer (the visible canvas). */
  private present(): void {
    const { gl } = this;
    const canvas = gl.canvas;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    this.resolveProgram.use();
    this.resolveProgram.set('u_transform', FULLSCREEN_MATRIX);
    this.resolveProgram.set('u_flipY', false);
    this.resolveProgram.set('u_checkerboard', this.options.showTransparencyGrid === true);
    this.resolveProgram.set('u_resolution', new Float32Array([canvas.width, canvas.height]));
    this.resolveProgram.setTexture('u_inputTexture', this.scene.texture, 0);
    this.drawQuad(this.resolveProgram);
  }

  /**
   * Read the composited frame back as straight (non-premultiplied) RGBA, rows
   * top-down. This is the buffer piped to the encoder during export.
   */
  readPixels(premultiplyAlpha = false): Uint8Array {
    const { gl } = this;
    const rowBytes = this.width * 4;
    const raw = new Uint8Array(rowBytes * this.height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.output.framebuffer);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // GL returns rows bottom-up; every encoder expects top-down.
    const flipped = new Uint8Array(raw.length);
    for (let y = 0; y < this.height; y += 1) {
      const sourceOffset = (this.height - 1 - y) * rowBytes;
      flipped.set(raw.subarray(sourceOffset, sourceOffset + rowBytes), y * rowBytes);
    }

    if (premultiplyAlpha) {
      for (let i = 0; i < flipped.length; i += 4) {
        const alpha = flipped[i + 3] / 255;
        flipped[i] = Math.round(flipped[i] * alpha);
        flipped[i + 1] = Math.round(flipped[i + 1] * alpha);
        flipped[i + 2] = Math.round(flipped[i + 2] * alpha);
      }
    }

    return flipped;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const { gl } = this;
    for (const vao of this.vaos.values()) gl.deleteVertexArray(vao);
    this.vaos.clear();

    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteTexture(this.defaultLutTexture);

    for (const program of [
      this.transferProgram,
      this.chromaKeyProgram,
      this.colorGradingProgram,
      this.maskingProgram,
      this.pixelArtProgram,
      this.compositeProgram,
      this.resolveProgram,
    ]) {
      program.dispose();
    }

    for (const target of [this.ping, this.pong, this.scene, this.output]) target.dispose();
  }
}
