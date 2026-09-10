/**
 * Thin WebGL2 wrappers: program compilation with a uniform-location cache, and
 * a render target that owns exactly one texture + framebuffer pair.
 *
 * Every object here has an explicit `dispose()`. VRAM is not garbage collected,
 * so the compositor is responsible for calling them.
 */

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Failed to allocate ${label} shader`);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Failed to compile ${label} shader:\n${log ?? '(no log)'}`);
  }
  return shader;
}

export type UniformValue =
  | number
  | boolean
  | readonly number[]
  | Float32Array
  | Int32Array;

export class GLProgram {
  readonly program: WebGLProgram;
  private readonly uniformLocations = new Map<string, WebGLUniformLocation | null>();
  private readonly attributeLocations = new Map<string, number>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    readonly label: string,
  ) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label} vertex`);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment`);

    const program = gl.createProgram();
    if (!program) throw new Error(`Failed to allocate program "${label}"`);

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    // The shader objects are reference-counted by the program once attached.
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Failed to link program "${label}":\n${log ?? '(no log)'}`);
    }

    this.program = program;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  attribute(name: string): number {
    let location = this.attributeLocations.get(name);
    if (location === undefined) {
      location = this.gl.getAttribLocation(this.program, name);
      this.attributeLocations.set(name, location);
    }
    return location;
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniformLocations.has(name)) {
      this.uniformLocations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniformLocations.get(name) ?? null;
  }

  /**
   * Set a uniform by name. Unused uniforms are optimized out by the driver and
   * resolve to `null`, which is silently ignored rather than treated as an error.
   */
  set(name: string, value: UniformValue): void {
    const location = this.uniform(name);
    if (location === null) return;
    const { gl } = this;

    if (typeof value === 'boolean') {
      gl.uniform1i(location, value ? 1 : 0);
      return;
    }
    if (typeof value === 'number') {
      // Integer-typed uniforms (samplers, enums) are set through setInt.
      gl.uniform1f(location, value);
      return;
    }

    switch (value.length) {
      case 2:
        gl.uniform2fv(location, value as Float32Array);
        return;
      case 3:
        gl.uniform3fv(location, value as Float32Array);
        return;
      case 4:
        gl.uniform4fv(location, value as Float32Array);
        return;
      case 9:
        gl.uniformMatrix3fv(location, false, value as Float32Array);
        return;
      case 16:
        gl.uniformMatrix4fv(location, false, value as Float32Array);
        return;
      default:
        gl.uniform1fv(location, value as Float32Array);
    }
  }

  setInt(name: string, value: number): void {
    const location = this.uniform(name);
    if (location !== null) this.gl.uniform1i(location, value);
  }

  /** Bind `texture` to `unit` and point the named sampler uniform at it. */
  setTexture(name: string, texture: WebGLTexture | null, unit: number, target?: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target ?? gl.TEXTURE_2D, texture);
    this.setInt(name, unit);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.uniformLocations.clear();
    this.attributeLocations.clear();
  }
}

/** A single-attachment offscreen surface used by the ping-pong effect chain. */
export class RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    public width: number,
    public height: number,
    private readonly internalFormat: number = gl.RGBA8,
    readonly label = 'render-target',
  ) {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      throw new Error(`Failed to allocate render target "${label}"`);
    }

    this.texture = texture;
    this.framebuffer = framebuffer;

    this.allocate(width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this.dispose();
      throw new Error(`Framebuffer "${label}" is incomplete (status 0x${status.toString(16)})`);
    }
  }

  private allocate(width: number, height: number): void {
    const { gl } = this;
    const type = this.internalFormat === gl.RGBA16F ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.internalFormat,
      width,
      height,
      0,
      gl.RGBA,
      type,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.width = width;
    this.height = height;
  }

  /** Nearest filtering, used when the pixel-art viewport toggle is on. */
  setFilter(filter: number): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.allocate(width, height);
  }

  bind(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }

  /** Clear to fully transparent black, preserving the alpha channel semantics. */
  clearTransparent(): void {
    const { gl } = this;
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.framebuffer);
  }
}

/**
 * Column-major 3x3 matrix mapping the unit quad (0..1) to a clip-space rect.
 * `gl.uniformMatrix3fv` expects column-major data with `transpose = false`.
 */
export function makeQuadMatrix(
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
  rotationRadians: number,
  anchorX = 0.5,
  anchorY = 0.5,
): Float32Array {
  const cos = Math.cos(rotationRadians);
  const sin = Math.sin(rotationRadians);

  // Unit quad -> anchored, scaled, rotated, translated clip-space quad.
  const sx = halfWidth * 2;
  const sy = halfHeight * 2;

  const ax = -anchorX * sx;
  const ay = -anchorY * sy;

  // Columns: [x basis, y basis, translation]
  return new Float32Array([
    cos * sx,
    sin * sx,
    0,
    -sin * sy,
    cos * sy,
    0,
    centerX + cos * ax - sin * ay,
    centerY + sin * ax + cos * ay,
    1,
  ]);
}

/** Identity mapping of the unit quad onto the full viewport. */
export const FULLSCREEN_MATRIX = makeQuadMatrix(0, 0, 1, 1, 0);
