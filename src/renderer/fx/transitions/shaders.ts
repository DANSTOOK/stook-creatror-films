import type { TransitionParamValue } from '@shared/types';
import { GLProgram } from '@renderer/engine/GLProgram';
import { resolvedShaderParams, shaderTransition, type ShaderParam, type ShaderTransitionDef } from './catalog';

/**
 * The GLSL of the shader transitions, and how to run one.
 *
 * The files in ./glsl are GL Transitions as their authors wrote them - each
 * keeps its header with the author and the licence - written for the
 * collection's interface: a function `transition(uv)` that reads the two
 * pictures through `getFromColor` and `getToColor`, with `progress` (0 to 1)
 * and `ratio` (width over height) given. Here they are wrapped into a WebGL2
 * fragment shader of the compositor's kind (GLSL ES 3.00), so the same file
 * draws the timeline, the export and the thumbnail in the library.
 *
 * The two pictures arrive premultiplied, as every buffer of the compositor
 * holds them, and what the transition returns goes onto the scene as a
 * premultiplied layer. For the opaque footage these are written for, that is
 * the same arithmetic; it also keeps a transition between titles (which are
 * mostly transparent) from drawing dark fringes. The result is clamped to a
 * valid premultiplied colour: a few of them add light (a flash, a burn) and
 * would otherwise write an alpha above one.
 */

const SOURCES = import.meta.glob('./glsl/*.glsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** The file's text, by its name in the collection. */
export function transitionSource(file: string): string | undefined {
  return SOURCES[`./glsl/${file}.glsl`];
}

/** The names the wrapper itself declares, which no transition may also declare. */
const WRAPPER_PREFIX = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_texCoord;
out vec4 scf_fragColor;

uniform sampler2D scf_from;
uniform sampler2D scf_to;
uniform float progress;
uniform float ratio;

vec4 getFromColor(vec2 uv) { return texture(scf_from, uv); }
vec4 getToColor(vec2 uv) { return texture(scf_to, uv); }
`;

const WRAPPER_SUFFIX = `
void main() {
    vec4 colour = transition(v_texCoord);
    float alpha = clamp(colour.a, 0.0, 1.0);
    scf_fragColor = vec4(clamp(colour.rgb, vec3(0.0), vec3(alpha)), alpha);
}
`;

/**
 * A transition's file as a complete fragment shader. GLSL ES 1.00 spellings
 * the collection's older files use are mapped to their 3.00 names.
 */
export function wrapTransition(source: string): string {
  // `#line 1` keeps the compiler's line numbers those of the file itself.
  return `${WRAPPER_PREFIX}#define texture2D texture\n#line 1\n${source}\n${WRAPPER_SUFFIX}`;
}

export function fragmentSourceFor(entry: ShaderTransitionDef): string {
  const source = transitionSource(entry.file);
  if (source === undefined) throw new Error(`Missing source for transition "${entry.id}" (${entry.file}.glsl)`);
  return wrapTransition(source);
}

/* Uniforms ---------------------------------------------------------------- */

/** Set one of a transition's own uniforms, by its declared type. */
export function setShaderParam(gl: WebGL2RenderingContext, program: GLProgram, param: ShaderParam, value: TransitionParamValue): void {
  switch (param.type) {
    case 'bool':
      program.set(param.name, value === true);
      return;
    case 'int':
      program.setInt(param.name, Math.round(value as number));
      return;
    case 'float':
      program.set(param.name, value as number);
      return;
    case 'ivec2': {
      // GLProgram sets float vectors; an integer one is set here, by location.
      const location = gl.getUniformLocation(program.program, param.name);
      const [x, y] = value as number[];
      if (location) gl.uniform2i(location, Math.round(x), Math.round(y));
      return;
    }
    case 'vec2':
      program.set(param.name, new Float32Array((value as number[]).slice(0, 2)));
      return;
    case 'color3':
      program.set(param.name, new Float32Array((value as number[]).slice(0, 3)));
      return;
    case 'color4':
      program.set(param.name, new Float32Array((value as number[]).slice(0, 4)));
      return;
  }
}

/**
 * The compiled program of each shader transition, made the first time one
 * is needed and kept for the life of the context. The compositor has one
 * set, the library's thumbnails another, each on its own context.
 */
export class ShaderTransitionPrograms {
  private readonly programs = new Map<string, GLProgram>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly vertexSource: string,
  ) {}

  /** Whether `id` has been compiled already: a first use is a compile. */
  has(id: string): boolean {
    return this.programs.has(id);
  }

  /**
   * The program for `id`, compiled now if need be; null when there is no
   * such transition or its shader did not compile here (reported once, and
   * drawn by the caller as a cross dissolve rather than not at all).
   */
  program(id: string): GLProgram | null {
    const ready = this.programs.get(id);
    if (ready) return ready;
    if (this.failed.has(id)) return null;
    const entry = shaderTransition(id);
    if (!entry) return null;
    try {
      const program = new GLProgram(this.gl, this.vertexSource, fragmentSourceFor(entry), `transition:${id}`);
      this.programs.set(id, program);
      return program;
    } catch (error) {
      this.failed.add(id);
      console.error(error);
      return null;
    }
  }

  /**
   * Use `id`'s program with its own uniforms set - progress, ratio and its
   * settings - and its two samplers pointed at `fromUnit` and `toUnit`. The
   * caller binds the textures and sets the vertex stage's uniforms.
   */
  use(
    id: string,
    progress: number,
    ratio: number,
    params: Record<string, TransitionParamValue> | undefined,
    fromUnit: number,
    toUnit: number,
  ): GLProgram | null {
    const program = this.program(id);
    const entry = shaderTransition(id);
    if (!program || !entry) return null;
    program.use();
    program.setInt('scf_from', fromUnit);
    program.setInt('scf_to', toUnit);
    program.set('progress', progress);
    program.set('ratio', ratio);
    for (const [param, value] of resolvedShaderParams(entry, params)) setShaderParam(this.gl, program, param, value);
    return program;
  }

  /** The programs made so far, for a caller that keeps vertex arrays by program. */
  all(): GLProgram[] {
    return [...this.programs.values()];
  }

  dispose(): void {
    for (const program of this.programs.values()) program.dispose();
    this.programs.clear();
    this.failed.clear();
  }
}
