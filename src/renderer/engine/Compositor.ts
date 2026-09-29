import type { Clip, ProjectState, Track, Transition } from '@shared/types';
import { activeTransitionsAt, extendedSourceFrame } from '@renderer/timing/transitions';
import { parseColor } from '@shared/utils/contrast';
import { sourceFrameFor } from '@renderer/timing/clipSpeed';
import { fadeGainAt } from '@renderer/timing/clipFades';
import { degToRad } from '@shared/utils/math';
import { evaluateTransform } from './KeyframeEvaluator';
import { titleTransformAt, type TitleGeometry } from '@renderer/text/geometry';
import { REVEAL_ALL, WIPE_SOFTNESS } from '@renderer/text/animation';
import { cdlOf, DEFAULT_PIVOT } from '@renderer/color/grade';
import { bakeCurves, CURVE_ROWS, CURVE_SIZE, type BakedCurves } from '@renderer/color/curves';
import type { GradeCurves } from '@shared/types';
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
// A title's Wipe: the layer shows left of u_reveal (across the texture, 0..1)
// and fades out over u_revealSoftness after it. Every other layer is drawn
// with u_reveal far past the right edge, where this multiplies by exactly 1.
uniform float u_reveal;
uniform float u_revealSoftness;

void main() {
    // Sampling outside the quad must not smear edge texels across the frame.
    if (any(lessThan(v_texCoord, vec2(0.0))) || any(greaterThan(v_texCoord, vec2(1.0)))) {
        fragColor = vec4(0.0);
        return;
    }
    vec4 texColor = texture(u_inputTexture, v_texCoord);
    float shown = clamp((u_reveal - v_texCoord.x) / u_revealSoftness, 0.0, 1.0);
    fragColor = vec4(texColor.rgb, texColor.a * shown);
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

/**
 * A transition: its two sides, each already drawn with its own transform
 * and effects into a buffer of its own (premultiplied), blended here and
 * drawn onto the scene as one layer. A cross dissolve is the straight mix;
 * a dip goes through an opaque colour at the half-way point. Premultiplied
 * mixing is what keeps a dissolve over a lower track honest: half of one
 * picture plus half of another covers the track below fully, not 75%.
 */
const TRANSITION_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform int u_kind;       // 0 cross dissolve, 1 dip through u_color, 2 wipe, 3 slide, 4 push
uniform vec3 u_color;
uniform vec2 u_direction; // which way a wipe, slide or push travels, in texture space (y up)
uniform float u_softness; // a wipe's edge width, in frames across

// A side sampled where it has been moved to; nothing outside the frame.
vec4 moved(sampler2D side, vec2 at) {
    if (any(lessThan(at, vec2(0.0))) || any(greaterThan(at, vec2(1.0)))) return vec4(0.0);
    return texture(side, at);
}

void main() {
    vec2 uv = v_texCoord;
    if (u_kind == 0) {
        fragColor = mix(texture(u_from, uv), texture(u_to, uv), u_progress);
        return;
    }
    if (u_kind == 1) {
        vec4 colour = vec4(u_color, 1.0);
        fragColor = u_progress < 0.5
            ? mix(texture(u_from, uv), colour, u_progress * 2.0)
            : mix(colour, texture(u_to, uv), u_progress * 2.0 - 1.0);
        return;
    }
    if (u_kind == 2) {
        // Where along its travel this pixel is, 0 where the edge starts, 1
        // where it ends; the incoming picture is behind the edge.
        float along = dot(uv - 0.5, u_direction) + 0.5;
        float edge = -u_softness * 0.5 + u_progress * (1.0 + u_softness);
        float incoming = u_softness > 0.0
            ? 1.0 - smoothstep(edge - u_softness * 0.5, edge + u_softness * 0.5, along)
            : step(along, edge);
        fragColor = mix(texture(u_from, uv), texture(u_to, uv), incoming);
        return;
    }
    // Slide and push: the incoming picture travels in from the far side and
    // lands in place; in a push the outgoing one travels out ahead of it.
    vec4 to = moved(u_to, uv + u_direction * (1.0 - u_progress));
    vec4 from = u_kind == 4 ? moved(u_from, uv - u_direction * u_progress) : texture(u_from, uv);
    fragColor = to + from * (1.0 - to.a);
}
`;

/** The shader's number for each kind. */
const TRANSITION_KIND: Record<Transition['kind'], number> = { crossDissolve: 0, dip: 1, wipe: 2, slide: 3, push: 4 };

/** Which way each direction travels, in texture space (y up). */
const DIRECTION: Record<Transition['direction'], [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] };

/** Premultiplied in, straight out. */
const RESOLVE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;
uniform bool u_checkerboard;
uniform vec2 u_resolution;
// The viewer's before/after: left of u_split the ungraded frame is shown.
// -1 shows none of it, 2 all of it. Only ever set when presenting.
uniform sampler2D u_beforeTexture;
uniform float u_split;

void main() {
    vec4 premultiplied = v_texCoord.x < u_split
        ? texture(u_beforeTexture, v_texCoord)
        : texture(u_inputTexture, v_texCoord);
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

/**
 * A small copy of the finished frame for the video scopes.
 *
 * Point-sampled with texelFetch, never filtered: a scope has to show the
 * values that are really in the picture, and averaging neighbours would
 * invent in-between ones - a hard black/white edge would read as grey.
 * Transparent areas are shown over black, as an opaque export has them.
 */
const SCOPE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;
uniform vec2 u_sourceSize;

void main() {
    ivec2 texel = ivec2(min(floor(v_texCoord * u_sourceSize), u_sourceSize - 1.0));
    vec4 straight = texelFetch(u_inputTexture, texel, 0);
    fragColor = vec4(straight.rgb * straight.a, 1.0);
}
`;

/** A frame read back for the scopes: RGBA, rows bottom-up. */
export interface ScopeCapture {
  rgba: Uint8Array;
  width: number;
  height: number;
}

const QUAD_VERTICES = new Float32Array([
  // x, y, u, v
  0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1,
]);

export interface ClipSource {
  texture: WebGLTexture;
  /** Video and canvas sources arrive top-down and need a flipped V axis. */
  flipY: boolean;
  /**
   * The part of the frame the texture covers, in project pixels (top-left
   * origin), when it is not the whole frame: a title's picture covers only
   * its text. The clip's transform then moves it exactly as it would move a
   * full-frame layer with the text drawn at that place.
   */
  rect?: { x: number; y: number; width: number; height: number };
  /**
   * A title's text box and pivot (text/geometry): the compositor scales and
   * turns it about the pivot and plays its animation on top of its keyframes.
   */
  title?: TitleGeometry;
}

/**
 * Narrow a layer's quad to a part of the frame: `matrix` maps the unit quad
 * onto the whole (transformed) frame; the result maps it onto `rect` of it.
 * Columns are the x basis, the y basis and the translation.
 */
export function subRectMatrix(
  matrix: Float32Array,
  rect: { x: number; y: number; width: number; height: number },
  frameWidth: number,
  frameHeight: number,
): Float32Array {
  const u0 = rect.x / frameWidth;
  const du = rect.width / frameWidth;
  // The unit quad's v runs up the frame; the rect is measured down from the top.
  const v0 = 1 - (rect.y + rect.height) / frameHeight;
  const dv = rect.height / frameHeight;
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = matrix;
  return new Float32Array([
    ax * du,
    ay * du,
    az * du,
    bx * dv,
    by * dv,
    bz * dv,
    cx + ax * u0 + bx * v0,
    cy + ay * u0 + by * v0,
    cz + az * u0 + bz * v0,
  ]);
}

/** Supplies the decoded texture for a clip at a given source frame. */
export type ClipSourceResolver = (clip: Clip, sourceFrame: number) => ClipSource | null;

/** A file's length in frames at the timeline's rate; undefined for stills and titles. */
export type SourceLength = (clip: Clip, fps: number) => number | undefined;

/**
 * One thing to draw at a frame, bottom first: a clip, or a transition with
 * the two clips it joins - each at the frame of footage it shows there,
 * past its end or before its start if need be.
 */
export type DrawEntry =
  | { kind: 'clip'; clip: Clip; sourceFrame: number }
  | {
      kind: 'transition';
      transition: Transition;
      from: Clip;
      to: Clip;
      fromFrame: number;
      toFrame: number;
      progress: number;
    };

/** A draw entry with its sources resolved: what drawLayers draws. */
type Resolved =
  | { kind: 'clip'; clip: Clip; source: ClipSource }
  | { kind: 'transition'; entry: Extract<DrawEntry, { kind: 'transition' }>; from: ClipSource | null; to: ClipSource | null };

export interface CompositorStats {
  clipsDrawn: number;
  passes: number;
  lastFrameMs: number;
}

/**
 * The viewer's before/after: the grade switched off (`bypass`), or a
 * curtain at `split` (0..1 across the frame) with the ungraded frame to
 * its left. Only the viewport passes one; an export never does, and the
 * output the scopes read is always the graded frame.
 */
export interface ViewerCompare {
  bypass: boolean;
  split: number | null;
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
  private readonly transitionProgram: GLProgram;
  /** A transition's two sides, while one is on screen; given back otherwise. */
  private transitionFrom: RenderTarget | null = null;
  private transitionTo: RenderTarget | null = null;
  /**
   * How long each clip's file is, so a transition past the end of one holds
   * its last frame instead of asking for footage that is not there. Set by
   * the renderer, which knows the media.
   */
  sourceLengthOf: SourceLength = () => undefined;

  /** Ping-pong pair used by the per-clip effect chain. */
  private ping: RenderTarget;
  private pong: RenderTarget;
  /** Premultiplied accumulator for the whole frame. */
  private scene: RenderTarget;
  /** The frame with no grades, for the viewer's before/after; only while comparing. */
  private before: RenderTarget | null = null;
  /** Where the last viewport frame's curtain was (see ViewerCompare); -1 for none. */
  private presentSplit = -1;
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
    this.transitionProgram = program(TRANSITION_FRAGMENT_SOURCE, 'transition');

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
    this.before?.resize(w, h);
    this.transitionFrom?.resize(w, h);
    this.transitionTo?.resize(w, h);
  }

  /** Swap the ping-pong pair after a pass has written into `pong`. */
  private swap(): void {
    const previous = this.ping;
    this.ping = this.pong;
    this.pong = previous;
  }

  /**
   * What to draw at `frame`, bottom first: the clips live there, except
   * that the two sides of a transition on screen are drawn together, at
   * their track's place, as one entry.
   */
  static drawList(project: ProjectState, frame: number, sourceLengthOf: SourceLength = () => undefined): DrawEntry[] {
    const order = new Map(project.tracks.map((track) => [track.id, track.order]));
    const active = activeTransitionsAt(project, frame);
    const inTransition = new Set<string>();
    for (const { from, to } of active) {
      inTransition.add(from.id);
      inTransition.add(to.id);
    }
    const entries: Array<DrawEntry & { order: number; start: number }> = [];
    for (const clip of Compositor.visibleClips(project, frame)) {
      if (inTransition.has(clip.id)) continue;
      entries.push({ kind: 'clip', clip, sourceFrame: sourceFrameFor(clip, frame), order: order.get(clip.trackId) ?? 0, start: clip.startFrame });
    }
    for (const { transition, from, to, progress } of active) {
      entries.push({
        kind: 'transition',
        transition,
        from,
        to,
        fromFrame: extendedSourceFrame(from, frame, sourceLengthOf(from, project.fps)),
        toFrame: extendedSourceFrame(to, frame, sourceLengthOf(to, project.fps)),
        progress,
        order: order.get(from.trackId) ?? 0,
        start: from.startFrame,
      });
    }
    return entries.sort((a, b) => a.order - b.order || a.start - b.start);
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
    let transform = evaluateTransform(clip.transform, frame);
    let reveal = REVEAL_ALL;
    // A title: its own animation on top of its keyframes, about its pivot.
    // The one being typed into in the viewer is shown at rest.
    const title = clip.title && source.title ? source.title : null;
    if (title) {
      const resting = clip.id === this.restingTitleId;
      const effective = titleTransformAt(clip, frame, this.fps, { width: this.width, height: this.height }, title, resting);
      transform = effective.transform;
      reveal = effective.reveal;
    }

    this.ping.bind();
    this.ping.clearTransparent();
    gl.disable(gl.BLEND);

    // Position is in project pixels relative to the frame centre, y pointing
    // down; scale 1.0 means "fills the project frame". A title turns about its
    // pivot instead of the frame's centre: the same sum with the anchor moved
    // there, which for a pivot at the centre is exactly the sum above.
    const anchor = title
      ? { x: title.pivot.x / this.width, y: 1 - title.pivot.y / this.height }
      : transform.anchorPoint;
    const centerX = (title ? anchor.x * 2 - 1 : 0) + (transform.position.x / this.width) * 2;
    const centerY = (title ? anchor.y * 2 - 1 : 0) - (transform.position.y / this.height) * 2;

    const frameMatrix = makeQuadMatrix(
      centerX,
      centerY,
      transform.scale.x,
      transform.scale.y,
      -degToRad(transform.rotation),
      anchor.x,
      anchor.y,
    );
    const matrix = source.rect ? subRectMatrix(frameMatrix, source.rect, this.width, this.height) : frameMatrix;

    this.transferProgram.use();
    this.transferProgram.set('u_transform', matrix);
    this.transferProgram.set('u_flipY', source.flipY);
    this.transferProgram.setTexture('u_inputTexture', source.texture, 0);
    this.transferProgram.set('u_reveal', reveal);
    this.transferProgram.set('u_revealSoftness', WIPE_SOFTNESS);
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

  /* Curves ------------------------------------------------------------------ */

  /** Baked curves by the curves object: the store replaces it when they change. */
  private readonly bakedCurves = new WeakMap<GradeCurves, BakedCurves>();
  /** Uploaded curve textures by content, the most recently used last. */
  private readonly curveTextures = new Map<string, WebGLTexture>();

  private bakedFor(curves: GradeCurves): BakedCurves {
    let baked = this.bakedCurves.get(curves);
    if (!baked) {
      baked = bakeCurves(curves);
      this.bakedCurves.set(curves, baked);
    }
    return baked;
  }

  /** The texture holding these curves, uploaded once and kept for reuse. */
  private curveTextureFor(baked: BakedCurves): WebGLTexture {
    const { gl } = this;
    const cached = this.curveTextures.get(baked.key);
    if (cached) {
      this.curveTextures.delete(baked.key);
      this.curveTextures.set(baked.key, cached);
      return cached;
    }
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to allocate a curve texture');
    // On the curves' own unit: this runs in the middle of setting up the
    // pass, and binding on the active unit would replace the pass's input.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, CURVE_SIZE, CURVE_ROWS.length, 0, gl.RED, gl.FLOAT, baked.data);
    // Read with texelFetch and interpolated in the shader: float textures
    // need not be filterable.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.curveTextures.set(baked.key, texture);
    // A handful of distinct gradings in one edit at most; keep the recent ones.
    while (this.curveTextures.size > 32) {
      const [oldest, doomed] = this.curveTextures.entries().next().value as [string, WebGLTexture];
      gl.deleteTexture(doomed);
      this.curveTextures.delete(oldest);
    }
    return texture;
  }

  /** Dither graded pixels on the way to 8 bits (see ColorGrading.glsl). On unless a test turns it off. */
  dither = true;

  /** Frames per second of the timeline being drawn, for titles' animations. */
  private fps = 30;
  /**
   * The title being typed into in the viewer: drawn at rest, so text that is
   * fading in can be read while it is edited. Never set for an export.
   */
  restingTitleId: string | null = null;

  private applyEffectChain(clip: Clip, skipGrade = false, frame = 0): void {
    if (clip.chromaKey.enabled) {
      this.runPass(this.chromaKeyProgram, (program) => {
        program.set('u_keyColor', new Float32Array(clip.chromaKey.keyColor));
        program.set('u_similarity', clip.chromaKey.similarity);
        program.set('u_smoothness', clip.chromaKey.smoothness);
        program.set('u_spill', clip.chromaKey.spill);
      });
    }

    if (clip.colorGrading.enabled && !skipGrade) {
      const grading = clip.colorGrading;
      const loaded = grading.lutUri ? this.lutLoader?.get(grading.lutUri) : undefined;

      this.runPass(this.colorGradingProgram, (program) => {
        program.set('u_exposure', grading.exposure);
        program.set('u_contrast', grading.contrast);
        program.set('u_saturation', grading.saturation);
        program.set('u_temperature', grading.temperature);
        program.set('u_tint', grading.tint);
        program.set('u_pivot', grading.pivot ?? DEFAULT_PIVOT);
        const cdl = cdlOf(grading);
        program.set('u_cdlActive', cdl.active);
        program.set('u_cdlSlope', new Float32Array(cdl.slope));
        program.set('u_cdlOffset', new Float32Array(cdl.offset));
        program.set('u_cdlPower', new Float32Array(cdl.power));

        const baked = grading.curves ? this.bakedFor(grading.curves) : null;
        program.set('u_levelCurvesActive', baked?.levelsActive === true);
        program.set('u_versusCurvesActive', baked?.versusActive === true);
        if (baked && (baked.levelsActive || baked.versusActive)) {
          program.setTexture('u_curveTexture', this.curveTextureFor(baked), 2);
        }

        const vignette = grading.vignette;
        program.set('u_vignetteActive', Boolean(vignette && vignette.amount !== 0));
        if (vignette) {
          program.set('u_vignetteAmount', vignette.amount);
          program.set('u_vignetteSize', vignette.size);
          program.set('u_vignetteRoundness', vignette.roundness);
          program.set('u_vignetteFeather', vignette.feather);
        }

        // Pixel art keeps its exact palette: no noise between its levels.
        program.set('u_dither', this.dither && !clip.pixelArt.enabled);
        program.setInt('u_frame', frame);
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

  /** Draw resolved layers, bottom first, onto `into`. `skipGrade` is the viewer's "before". */
  private drawLayers(layers: readonly Resolved[], frame: number, into: RenderTarget, skipGrade: boolean): void {
    for (const layer of layers) {
      if (layer.kind === 'clip') {
        const opacity = this.renderLayer(layer.clip, frame, layer.source);
        if (opacity <= 0) continue;
        this.applyEffectChain(layer.clip, skipGrade, frame);
        this.compositeLayer(opacity, into);
        if (!skipGrade) this.stats.clipsDrawn += 1;
        continue;
      }
      this.drawTransition(layer, frame, into, skipGrade);
    }
  }

  /**
   * A transition: A and B each through their own transform, fades and
   * effects into a buffer of their own, then mixed - premultiplied - and
   * drawn onto `into` as one layer.
   */
  private drawTransition(layer: Extract<Resolved, { kind: 'transition' }>, frame: number, into: RenderTarget, skipGrade: boolean): void {
    const { gl } = this;
    const format = this.scene.internalFormat;
    this.transitionFrom ??= new RenderTarget(gl, this.width, this.height, format, 'transition-from');
    this.transitionTo ??= new RenderTarget(gl, this.width, this.height, format, 'transition-to');

    const side = (clip: Clip, source: ClipSource | null, target: RenderTarget): void => {
      target.bind();
      target.clearTransparent();
      if (!source) return;
      const opacity = this.renderLayer(clip, frame, source);
      if (opacity <= 0) return;
      this.applyEffectChain(clip, skipGrade, frame);
      this.compositeLayer(opacity, target);
      if (!skipGrade) this.stats.clipsDrawn += 1;
    };
    side(layer.entry.from, layer.from, this.transitionFrom);
    side(layer.entry.to, layer.to, this.transitionTo);

    into.bind();
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const { transition } = layer.entry;
    const colour = parseColor(transition.color)?.rgb ?? [0, 0, 0];
    this.transitionProgram.use();
    this.transitionProgram.set('u_transform', FULLSCREEN_MATRIX);
    this.transitionProgram.set('u_flipY', false);
    this.transitionProgram.setTexture('u_from', this.transitionFrom.texture, 0);
    this.transitionProgram.setTexture('u_to', this.transitionTo.texture, 1);
    this.transitionProgram.set('u_progress', layer.entry.progress);
    this.transitionProgram.setInt('u_kind', TRANSITION_KIND[transition.kind]);
    this.transitionProgram.set('u_color', new Float32Array(colour.map((channel) => channel / 255)));
    this.transitionProgram.set('u_direction', new Float32Array(DIRECTION[transition.direction ?? 'left']));
    // Softness 1 is an edge a fifth of the frame wide.
    this.transitionProgram.set('u_softness', Math.min(1, Math.max(0, transition.softness ?? 0)) * 0.2);
    this.drawQuad(this.transitionProgram);
    gl.disable(gl.BLEND);
    this.stats.passes += 1;
  }

  private releaseTransitionTargets(): void {
    this.transitionFrom?.dispose();
    this.transitionTo?.dispose();
    this.transitionFrom = null;
    this.transitionTo = null;
  }

  /** Blend the finished layer in `ping` onto the premultiplied scene buffer. */
  private compositeLayer(opacity: number, into: RenderTarget = this.scene): void {
    const { gl } = this;

    into.bind();
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
    compare?: ViewerCompare,
  ): void {
    if (this.disposed) throw new Error('Compositor has been disposed');

    const started = performance.now();
    const { gl } = this;

    this.stats.clipsDrawn = 0;
    this.stats.passes = 0;
    this.fps = project.fps;

    this.scene.bind();
    // Transparent clear: the project frame keeps its alpha so pixel-art and
    // video layers can be exported straight to a sprite sheet.
    this.scene.clearTransparent();

    // Each source is asked for once, and drawn twice when comparing.
    const layers: Resolved[] = [];
    for (const entry of Compositor.drawList(project, frame, this.sourceLengthOf)) {
      if (entry.kind === 'clip') {
        const source = resolveSource(entry.clip, entry.sourceFrame);
        if (source) layers.push({ kind: 'clip', clip: entry.clip, source });
      } else {
        layers.push({
          kind: 'transition',
          entry,
          from: resolveSource(entry.from, entry.fromFrame),
          to: resolveSource(entry.to, entry.toFrame),
        });
      }
    }
    this.drawLayers(layers, frame, this.scene, false);

    /*
      The viewer's "before": the same layers again with every grade left
      out, into a scene of its own, drawn only while a comparison is on and
      only for the canvas. The graded scene - what the output target, the
      scopes and every export get - is untouched by it.
    */
    const split = !presentToCanvas || !compare ? -1 : compare.bypass ? 2 : compare.split ?? -1;
    this.presentSplit = split;
    if (split > 0) {
      if (!this.before) this.before = new RenderTarget(gl, this.width, this.height, this.scene.internalFormat, 'before');
      this.before.bind();
      this.before.clearTransparent();
      this.drawLayers(layers, frame, this.before, true);
    } else if (this.before) {
      // Not comparing: the second scene is given back.
      this.before.dispose();
      this.before = null;
    }
    // No transition on screen: its two buffers are given back too.
    if (!layers.some((layer) => layer.kind === 'transition')) this.releaseTransitionTargets();

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
    this.resolveProgram.set('u_split', -1);
    this.resolveProgram.setTexture('u_inputTexture', this.scene.texture, 0);
    this.resolveProgram.setTexture('u_beforeTexture', this.scene.texture, 1);
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
    const split = this.before ? this.presentSplit : -1;
    this.resolveProgram.set('u_split', split);
    this.resolveProgram.setTexture('u_inputTexture', this.scene.texture, 0);
    this.resolveProgram.setTexture('u_beforeTexture', this.before?.texture ?? this.scene.texture, 1);
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

  /* Video scopes ------------------------------------------------------------ */

  private scopeProgram: GLProgram | null = null;
  private scopeTarget: RenderTarget | null = null;
  private scopeBuffer: WebGLBuffer | null = null;
  private scopeBufferBytes = 0;
  private scopeFence: WebGLSync | null = null;

  /**
   * Start reading a small copy of the last composited frame back, for the
   * video scopes. Returns false when one is still in flight.
   *
   * Never waits on the GPU: the pixels go into a pixel-buffer object behind
   * a fence, and `takeScopeCapture` collects them a frame or two later, once
   * the fence has passed. A plain readPixels here would stall the pipeline
   * for the whole frame, during playback, which is exactly what the scopes
   * must not cost.
   */
  captureForScopes(maxWidth: number): boolean {
    if (this.disposed || this.scopeFence) return false;
    const { gl } = this;

    const width = Math.max(1, Math.min(Math.floor(maxWidth), this.width));
    const height = Math.max(1, Math.round((this.height * width) / this.width));

    this.scopeProgram ??= new GLProgram(gl, baseVertexSource, SCOPE_FRAGMENT_SOURCE, 'scope-capture');
    if (!this.scopeTarget) this.scopeTarget = new RenderTarget(gl, width, height, gl.RGBA8, 'scope');
    else this.scopeTarget.resize(width, height);

    const bytes = width * height * 4;
    if (!this.scopeBuffer) this.scopeBuffer = gl.createBuffer();
    if (!this.scopeBuffer) return false;

    this.scopeTarget.bind();
    gl.disable(gl.BLEND);
    this.scopeProgram.use();
    this.scopeProgram.set('u_transform', FULLSCREEN_MATRIX);
    this.scopeProgram.set('u_flipY', false);
    this.scopeProgram.set('u_sourceSize', new Float32Array([this.width, this.height]));
    this.scopeProgram.setTexture('u_inputTexture', this.output.texture, 0);
    gl.bindVertexArray(this.vaoFor(this.scopeProgram));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.scopeBuffer);
    if (bytes !== this.scopeBufferBytes) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      this.scopeBufferBytes = bytes;
    }
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    // Unbound at once: with a pack buffer bound, the export's own readPixels
    // would write into it instead of into its array.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.scopeFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return this.scopeFence !== null;
  }

  /** The frame `captureForScopes` asked for, once the GPU has it; null until then. */
  takeScopeCapture(): ScopeCapture | null {
    const fence = this.scopeFence;
    const target = this.scopeTarget;
    if (!fence || !target || !this.scopeBuffer || this.disposed) return null;
    const { gl } = this;

    const status = gl.clientWaitSync(fence, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) return null;
    gl.deleteSync(fence);
    this.scopeFence = null;
    if (status === gl.WAIT_FAILED) return null;

    const rgba = new Uint8Array(target.width * target.height * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.scopeBuffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, rgba);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { rgba, width: target.width, height: target.height };
  }

  /** Drop a readback in flight: the scopes were closed, or an export began. */
  cancelScopeCapture(): void {
    if (this.scopeFence) this.gl.deleteSync(this.scopeFence);
    this.scopeFence = null;
  }

  /** Free the scope surfaces once the scopes are closed. */
  releaseScopes(): void {
    this.cancelScopeCapture();
    const { gl } = this;
    if (this.scopeProgram) {
      const vao = this.vaos.get(this.scopeProgram);
      if (vao) gl.deleteVertexArray(vao);
      this.vaos.delete(this.scopeProgram);
      this.scopeProgram.dispose();
    }
    this.scopeTarget?.dispose();
    if (this.scopeBuffer) gl.deleteBuffer(this.scopeBuffer);
    this.scopeProgram = null;
    this.scopeTarget = null;
    this.scopeBuffer = null;
    this.scopeBufferBytes = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseScopes();
    this.disposed = true;

    const { gl } = this;
    for (const vao of this.vaos.values()) gl.deleteVertexArray(vao);
    this.vaos.clear();

    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteTexture(this.defaultLutTexture);
    this.releaseTransitionTargets();
    this.transitionProgram.dispose();
    for (const texture of this.curveTextures.values()) gl.deleteTexture(texture);
    this.curveTextures.clear();

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
    this.before?.dispose();
    this.before = null;
  }
}
