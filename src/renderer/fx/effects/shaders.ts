/**
 * The passes that draw each effect (see ./catalog.ts for what they are).
 *
 * Every pass is a full-frame fragment shader of the compositor's kind: it
 * reads the clip as drawn so far from `u_inputTexture` (straight alpha, the
 * clip already placed in the frame) and writes straight alpha back, through
 * the compositor's ping-pong pair. `u_resolution` is the frame being drawn,
 * in pixels.
 *
 * Most are ports of glfx.js by Evan Wallace (MIT,
 * https://github.com/evanw/glfx.js), from GLSL ES 1.00 to 3.00, with three
 * changes throughout: sizes come in as pixels of a 1080-line frame and are
 * scaled to this one (so the viewer and every export resolution agree);
 * positions are fractions of the frame rather than pixels; and the alpha of
 * a clip that does not fill the frame is kept. Film grain, the light leak,
 * the glitch and the chromatic aberration are this app's own.
 *
 * Nothing here reads the clock: the effects that move by themselves take
 * the frame's time as a uniform, so a frame looks the same in the viewer, in
 * a scrub and in an export.
 */

const HEADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;
uniform vec2 u_resolution;
`;

/** glfx.js's per-pixel jitter, which hides a fixed number of taps; seeded by position only. */
const RANDOM = `
float scf_random(vec3 scale, float seed) {
    return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed);
}
`;

const shader = (body: string, helpers = ''): string => `${HEADER}${helpers}\n${body}`;

/* glfx.js: adjust -------------------------------------------------------------- */

const BRIGHTNESS_CONTRAST = shader(`
uniform float brightness;
uniform float contrast;
void main() {
    vec4 color = texture(u_inputTexture, v_texCoord);
    color.rgb += brightness;
    if (contrast > 0.0) {
        color.rgb = (color.rgb - 0.5) / (1.0 - contrast) + 0.5;
    } else {
        color.rgb = (color.rgb - 0.5) * (1.0 + contrast) + 0.5;
    }
    fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`);

const HUE_SATURATION = shader(`
uniform float hue;
uniform float saturation;
void main() {
    vec4 color = texture(u_inputTexture, v_texCoord);
    /* hue adjustment, wolfram alpha: RotationTransform[angle, {1, 1, 1}][{x, y, z}] */
    float angle = hue * 3.14159265;
    float s = sin(angle), c = cos(angle);
    vec3 weights = (vec3(2.0 * c, -sqrt(3.0) * s - c, sqrt(3.0) * s - c) + 1.0) / 3.0;
    color.rgb = vec3(
        dot(color.rgb, weights.xyz),
        dot(color.rgb, weights.zxy),
        dot(color.rgb, weights.yzx)
    );
    /* saturation adjustment */
    float average = (color.r + color.g + color.b) / 3.0;
    if (saturation > 0.0) {
        color.rgb += (average - color.rgb) * (1.0 - 1.0 / (1.001 - saturation));
    } else {
        color.rgb += (average - color.rgb) * (-saturation);
    }
    fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`);

const VIBRANCE = shader(`
uniform float amount;
void main() {
    vec4 color = texture(u_inputTexture, v_texCoord);
    float average = (color.r + color.g + color.b) / 3.0;
    float mx = max(color.r, max(color.g, color.b));
    float amt = (mx - average) * (-amount * 3.0);
    color.rgb = mix(color.rgb, vec3(mx), amt);
    fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`);

const SEPIA = shader(`
uniform float amount;
void main() {
    vec4 color = texture(u_inputTexture, v_texCoord);
    float r = color.r;
    float g = color.g;
    float b = color.b;
    color.r = min(1.0, (r * (1.0 - (0.607 * amount))) + (g * (0.769 * amount)) + (b * (0.189 * amount)));
    color.g = min(1.0, (r * 0.349 * amount) + (g * (1.0 - (0.314 * amount))) + (b * 0.168 * amount));
    color.b = min(1.0, (r * 0.272 * amount) + (g * 0.534 * amount) + (b * (1.0 - (0.869 * amount))));
    fragColor = color;
}`);

/**
 * glfx.js's triangle blur along `delta` (a texture-space vector). glfx always
 * takes 61 taps; here the count follows the radius - one each way per pixel,
 * up to glfx's 30 - so a small blur costs a small number of reads.
 */
const TRIANGLE_BLUR = shader(
  `
uniform vec2 delta;
uniform float taps;
void main() {
    vec4 color = vec4(0.0);
    float total = 0.0;
    /* randomize the lookup values to hide the fixed number of samples */
    float offset = scf_random(vec3(12.9898, 78.233, 151.7182), 0.0);
    for (float t = -taps; t <= taps; t++) {
        float percent = (t + offset - 0.5) / taps;
        float weight = 1.0 - abs(percent);
        vec4 sampled = texture(u_inputTexture, v_texCoord + delta * percent);
        /* switch to pre-multiplied alpha to correctly blur transparent images */
        sampled.rgb *= sampled.a;
        color += sampled * weight;
        total += weight;
    }
    fragColor = color / total;
    /* switch back from pre-multiplied alpha */
    fragColor.rgb /= fragColor.a + 0.00001;
}`,
  RANDOM,
);

const UNSHARP_COMBINE = shader(`
uniform sampler2D u_original;
uniform float strength;
void main() {
    vec4 blurred = texture(u_inputTexture, v_texCoord);
    vec4 original = texture(u_original, v_texCoord);
    vec4 sharpened = mix(blurred, original, 1.0 + strength);
    fragColor = vec4(clamp(sharpened.rgb, 0.0, 1.0), original.a);
}`);

/*
 * glfx.js's denoise weighs a 9x9 square by likeness to the centre: 81 reads a
 * pixel, twice. Here the square is walked one axis a pass (9 reads, four
 * passes: 36 instead of 162) - the usual separable approximation of such a
 * filter, the same smoothing to the eye, four times quicker to export.
 */
const DENOISE = shader(`
uniform float exponent;
uniform vec2 axis;
void main() {
    vec4 center = texture(u_inputTexture, v_texCoord);
    vec4 color = vec4(0.0);
    float total = 0.0;
    for (float t = -4.0; t <= 4.0; t += 1.0) {
        vec4 sampled = texture(u_inputTexture, v_texCoord + axis * t / u_resolution);
        float weight = 1.0 - abs(dot(sampled.rgb - center.rgb, vec3(0.25)));
        weight = pow(max(weight, 0.0), exponent);
        color += sampled * weight;
        total += weight;
    }
    fragColor = color / total;
}`);

/* glfx.js: blur ------------------------------------------------------------------ */

const ZOOM_BLUR = shader(
  `
uniform vec2 center;
uniform float strength;
uniform float taps;
void main() {
    vec4 color = vec4(0.0);
    float total = 0.0;
    vec2 toCenter = center - v_texCoord * u_resolution;
    /* randomize the lookup values to hide the fixed number of samples */
    float offset = scf_random(vec3(12.9898, 78.233, 151.7182), 0.0);
    for (float t = 0.0; t <= taps; t++) {
        float percent = (t + offset) / taps;
        float weight = 4.0 * (percent - percent * percent);
        vec4 sampled = texture(u_inputTexture, v_texCoord + toCenter * percent * strength / u_resolution);
        /* switch to pre-multiplied alpha to correctly blur transparent images */
        sampled.rgb *= sampled.a;
        color += sampled * weight;
        total += weight;
    }
    fragColor = color / total;
    /* switch back from pre-multiplied alpha */
    fragColor.rgb /= fragColor.a + 0.00001;
}`,
  RANDOM,
);

const TILT_SHIFT = shader(
  `
uniform float blurRadius;
uniform float gradientRadius;
uniform vec2 start;
uniform vec2 end;
uniform vec2 delta;
void main() {
    vec4 color = vec4(0.0);
    float total = 0.0;
    /* randomize the lookup values to hide the fixed number of samples */
    float offset = scf_random(vec3(12.9898, 78.233, 151.7182), 0.0);
    vec2 normal = normalize(vec2(start.y - end.y, end.x - start.x));
    float radius = smoothstep(0.0, 1.0, abs(dot(v_texCoord * u_resolution - start, normal)) / gradientRadius) * blurRadius;
    for (float t = -15.0; t <= 15.0; t++) {
        float percent = (t + offset - 0.5) / 15.0;
        float weight = 1.0 - abs(percent);
        vec4 sampled = texture(u_inputTexture, v_texCoord + delta / u_resolution * percent * radius);
        /* switch to pre-multiplied alpha to correctly blur transparent images */
        sampled.rgb *= sampled.a;
        color += sampled * weight;
        total += weight;
    }
    fragColor = color / total;
    /* switch back from pre-multiplied alpha */
    fragColor.rgb /= fragColor.a + 0.00001;
}`,
  RANDOM,
);

/* glfx.js: warp -------------------------------------------------------------------- */

/** glfx.js's warpShader: `warp` moves `coord` (pixels); outside the picture fades out. */
const warpShader = (uniforms: string, warp: string): string =>
  shader(`
${uniforms}
void main() {
    vec2 coord = v_texCoord * u_resolution;
    ${warp}
    fragColor = texture(u_inputTexture, coord / u_resolution);
    vec2 clampedCoord = clamp(coord, vec2(0.0), u_resolution);
    if (coord != clampedCoord) {
        /* fade to transparent if we are outside the image */
        fragColor.a *= max(0.0, 1.0 - length(coord - clampedCoord));
    }
}`);

const SWIRL = warpShader(
  `uniform float radius;
uniform float angle;
uniform vec2 center;`,
  `coord -= center;
    float distance = length(coord);
    if (distance < radius) {
        float percent = (radius - distance) / radius;
        float theta = percent * percent * angle;
        float s = sin(theta);
        float c = cos(theta);
        coord = vec2(
            coord.x * c - coord.y * s,
            coord.x * s + coord.y * c
        );
    }
    coord += center;`,
);

const BULGE_PINCH = warpShader(
  `uniform float radius;
uniform float strength;
uniform vec2 center;`,
  `coord -= center;
    float distance = length(coord);
    if (distance < radius) {
        float percent = distance / radius;
        if (strength > 0.0) {
            coord *= mix(1.0, smoothstep(0.0, radius / distance, percent), strength * 0.75);
        } else {
            coord *= mix(1.0, pow(percent, 1.0 + strength * 0.75) * radius / distance, 1.0 - percent);
        }
    }
    coord += center;`,
);

/* glfx.js: fun ----------------------------------------------------------------------- */

const INK = shader(`
uniform float strength;
void main() {
    vec2 dx = vec2(1.0 / u_resolution.x, 0.0);
    vec2 dy = vec2(0.0, 1.0 / u_resolution.y);
    vec4 color = texture(u_inputTexture, v_texCoord);
    float bigTotal = 0.0;
    float smallTotal = 0.0;
    vec3 bigAverage = vec3(0.0);
    vec3 smallAverage = vec3(0.0);
    for (float x = -2.0; x <= 2.0; x += 1.0) {
        for (float y = -2.0; y <= 2.0; y += 1.0) {
            vec3 sampled = texture(u_inputTexture, v_texCoord + dx * x + dy * y).rgb;
            bigAverage += sampled;
            bigTotal += 1.0;
            if (abs(x) + abs(y) < 2.0) {
                smallAverage += sampled;
                smallTotal += 1.0;
            }
        }
    }
    vec3 edge = max(vec3(0.0), bigAverage / bigTotal - smallAverage / smallTotal);
    fragColor = vec4(clamp(color.rgb - dot(edge, edge) * strength * 100000.0, 0.0, 1.0), color.a);
}`);

const EDGE_WORK_1 = shader(
  `
uniform vec2 delta;
void main() {
    vec2 color = vec2(0.0);
    vec2 total = vec2(0.0);
    /* randomize the lookup values to hide the fixed number of samples */
    float offset = scf_random(vec3(12.9898, 78.233, 151.7182), 0.0);
    for (float t = -15.0; t <= 15.0; t++) {
        float percent = (t + offset - 0.5) / 15.0;
        float weight = 1.0 - abs(percent);
        vec3 sampled = texture(u_inputTexture, v_texCoord + delta * percent).rgb;
        float average = (sampled.r + sampled.g + sampled.b) / 3.0;
        color.x += average * weight;
        total.x += weight;
        if (abs(t) < 7.5) {
            weight = weight * 2.0 - 1.0;
            color.y += average * weight;
            total.y += weight;
        }
    }
    fragColor = vec4(color / total, 0.0, 1.0);
}`,
  RANDOM,
);

/** The second half, which also takes the clip's own alpha back from before the first. */
const EDGE_WORK_2 = shader(
  `
uniform vec2 delta;
uniform sampler2D u_original;
void main() {
    vec2 color = vec2(0.0);
    vec2 total = vec2(0.0);
    /* randomize the lookup values to hide the fixed number of samples */
    float offset = scf_random(vec3(12.9898, 78.233, 151.7182), 0.0);
    for (float t = -15.0; t <= 15.0; t++) {
        float percent = (t + offset - 0.5) / 15.0;
        float weight = 1.0 - abs(percent);
        vec2 sampled = texture(u_inputTexture, v_texCoord + delta * percent).xy;
        color.x += sampled.x * weight;
        total.x += weight;
        if (abs(t) < 7.5) {
            weight = weight * 2.0 - 1.0;
            color.y += sampled.y * weight;
            total.y += weight;
        }
    }
    float c = clamp(10000.0 * (color.y / total.y - color.x / total.x) + 0.5, 0.0, 1.0);
    fragColor = vec4(c, c, c, texture(u_original, v_texCoord).a);
}`,
  RANDOM,
);

const HEXAGONAL_PIXELATE = shader(`
uniform vec2 center;
uniform float scale;
void main() {
    vec2 tex = (v_texCoord * u_resolution - center) / scale;
    tex.y /= 0.866025404;
    tex.x -= tex.y * 0.5;
    vec2 a;
    if (tex.x + tex.y - floor(tex.x) - floor(tex.y) < 1.0) a = vec2(floor(tex.x), floor(tex.y));
    else a = vec2(ceil(tex.x), ceil(tex.y));
    vec2 b = vec2(ceil(tex.x), floor(tex.y));
    vec2 c = vec2(floor(tex.x), ceil(tex.y));
    vec3 TEX = vec3(tex.x, tex.y, 1.0 - tex.x - tex.y);
    vec3 A = vec3(a.x, a.y, 1.0 - a.x - a.y);
    vec3 B = vec3(b.x, b.y, 1.0 - b.x - b.y);
    vec3 C = vec3(c.x, c.y, 1.0 - c.x - c.y);
    float alen = length(TEX - A);
    float blen = length(TEX - B);
    float clen = length(TEX - C);
    vec2 choice;
    if (alen < blen) {
        if (alen < clen) choice = a;
        else choice = c;
    } else {
        if (blen < clen) choice = b;
        else choice = c;
    }
    choice.x += choice.y * 0.5;
    choice.y *= 0.866025404;
    choice *= scale / u_resolution;
    fragColor = texture(u_inputTexture, choice + center / u_resolution);
}`);

const DOT_SCREEN = shader(`
uniform vec2 center;
uniform float angle;
uniform float scale;
float pattern() {
    float s = sin(angle), c = cos(angle);
    vec2 tex = v_texCoord * u_resolution - center;
    vec2 point = vec2(
        c * tex.x - s * tex.y,
        s * tex.x + c * tex.y
    ) * scale;
    return (sin(point.x) * sin(point.y)) * 4.0;
}
void main() {
    vec4 color = texture(u_inputTexture, v_texCoord);
    float average = (color.r + color.g + color.b) / 3.0;
    fragColor = vec4(clamp(vec3(average * 10.0 - 5.0 + pattern()), 0.0, 1.0), color.a);
}`);

const COLOR_HALFTONE = shader(`
uniform vec2 center;
uniform float angle;
uniform float scale;
float pattern(float angle) {
    float s = sin(angle), c = cos(angle);
    vec2 tex = v_texCoord * u_resolution - center;
    vec2 point = vec2(
        c * tex.x - s * tex.y,
        s * tex.x + c * tex.y
    ) * scale;
    return (sin(point.x) * sin(point.y)) * 4.0;
}
void main() {
    vec4 color = texture(u_inputTexture, v_texCoord);
    vec3 cmy = 1.0 - color.rgb;
    float k = min(cmy.x, min(cmy.y, cmy.z));
    cmy = (cmy - k) / max(1.0 - k, 0.00001);
    cmy = clamp(cmy * 10.0 - 3.0 + vec3(pattern(angle + 0.26179), pattern(angle + 1.30899), pattern(angle)), 0.0, 1.0);
    k = clamp(k * 10.0 - 5.0 + pattern(angle + 0.78539), 0.0, 1.0);
    fragColor = vec4(clamp(1.0 - cmy - k, 0.0, 1.0), color.a);
}`);

/* This app's own ----------------------------------------------------------------------- */

/**
 * Chromatic aberration: red and blue read from either side of green. Radial,
 * the split grows from nothing at the centre to `amount` pixels at the edge,
 * as a lens's does; otherwise it is the same everywhere, along `direction`
 * (an RGB split).
 */
const CHROMATIC_ABERRATION = shader(`
uniform float amount;
uniform float radial;
uniform vec2 direction;
void main() {
    vec2 uv = v_texCoord;
    vec2 offset = radial > 0.5
        ? (uv - 0.5) * 2.0 * amount / u_resolution
        : direction * amount / u_resolution;
    vec4 red = texture(u_inputTexture, uv + offset);
    vec4 green = texture(u_inputTexture, uv);
    vec4 blue = texture(u_inputTexture, uv - offset);
    fragColor = vec4(red.r, green.g, blue.b, max(green.a, max(red.a, blue.a)));
}`);

/**
 * Glitch: bands of the picture torn sideways, a few blocks out of place and
 * the colours split, all of it re-rolled `speed` times a second from the
 * frame's time - so a frame is the same glitch every time it is drawn.
 */
const GLITCH = shader(`
uniform float amount;
uniform float blockSize;
uniform float shift;
uniform float seed;
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
void main() {
    vec2 pixel = v_texCoord * u_resolution;
    float band = floor(pixel.y / blockSize);
    float roll = hash(vec2(band, seed));
    // About half the bands at full amount, none at zero.
    float torn = step(1.0 - amount * 0.5, roll);
    float tear = (hash(vec2(band, seed + 1.7)) - 0.5) * 8.0 * shift * torn;
    vec2 block = floor(pixel / vec2(blockSize * 2.0, blockSize));
    float moved = step(1.0 - amount * 0.25, hash(block + seed * 3.1));
    vec2 jump = (vec2(hash(block + seed), hash(block - seed)) - 0.5) * blockSize * 2.0 * moved;
    vec2 at = (pixel + vec2(tear, 0.0) + jump) / u_resolution;
    float split = shift * amount * (0.5 + roll) / u_resolution.x;
    vec4 base = texture(u_inputTexture, at);
    float red = texture(u_inputTexture, at + vec2(split, 0.0)).r;
    float blue = texture(u_inputTexture, at - vec2(split, 0.0)).b;
    fragColor = vec4(red, base.g, blue, base.a);
}`);

/**
 * Film grain: a new pattern of grains every frame, `size` pixels each,
 * strongest in the mid-tones and gentler in the shadows and highlights, as
 * film's is. Mono by default; colour grain varies each channel.
 */
const FILM_GRAIN = shader(`
uniform float amount;
uniform float grain;
uniform float seed;
uniform float colored;
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}
void main() {
    vec4 color = texture(u_inputTexture, v_texCoord);
    vec2 cell = mod(floor(v_texCoord * u_resolution / grain), 4096.0);
    float t = mod(seed, 251.0);
    float n = hash(vec3(cell, t)) - 0.5;
    vec3 noise = colored > 0.5
        ? vec3(n, hash(vec3(cell + 31.0, t)) - 0.5, hash(vec3(cell + 67.0, t)) - 0.5)
        : vec3(n);
    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float weight = 1.0 - 0.7 * pow(abs(luma * 2.0 - 1.0), 2.0);
    fragColor = vec4(clamp(color.rgb + noise * amount * 0.5 * weight, 0.0, 1.0), color.a);
}`);

/**
 * Light leak: two soft glows and a broad streak of warm light drifting along
 * one side of the frame, screened over the picture as light adds to film.
 * The colour is a cosine palette around `hue`.
 */
const LIGHT_LEAK = shader(`
uniform float intensity;
uniform float hue;
uniform float position;
uniform float spread;
uniform float time;
vec3 palette(float h) {
    return 0.5 + 0.5 * cos(6.2831853 * (h + vec3(0.0, -0.3333333, 0.3333333)));
}
void main() {
    vec4 color = texture(u_inputTexture, v_texCoord);
    float aspect = u_resolution.x / u_resolution.y;
    vec2 uv = vec2(v_texCoord.x * aspect, v_texCoord.y);
    float x = position * aspect;
    vec2 one = vec2(x + 0.15 * sin(time * 0.7), 0.75 + 0.15 * cos(time * 0.9));
    vec2 two = vec2(x + 0.3 + 0.2 * sin(time * 0.45 + 1.3), 0.3 + 0.2 * sin(time * 0.6 + 2.1));
    float s = spread * spread;
    float glowOne = exp(-dot(uv - one, uv - one) / (s * 0.5));
    float glowTwo = exp(-dot(uv - two, uv - two) / (s * 0.25));
    float band = (uv.x - (x + 0.1 * sin(time * 0.3))) / (spread * 0.6);
    float streak = exp(-band * band);
    vec3 warm = palette(hue);
    vec3 hot = palette(hue + 0.08);
    vec3 light = clamp((warm * glowOne + hot * glowTwo * 0.8 + warm * streak * 0.35) * intensity, 0.0, 1.0);
    fragColor = vec4(1.0 - (1.0 - color.rgb) * (1.0 - light), color.a);
}`);

/* Passes --------------------------------------------------------------------------------- */

export type UniformValues = Record<string, number | readonly number[]>;

/** What a pass knows about the frame: its size, and its time. */
export interface PassContext {
  width: number;
  height: number;
  /** Seconds into the timeline, for effects that move by themselves. */
  seconds: number;
}

export interface EffectPass {
  /** The fragment shader; the same text is compiled once whatever uses it. */
  source: string;
  uniforms(values: Record<string, number>, context: PassContext): UniformValues;
  /**
   * Keep a copy of what this pass reads, for a later pass of the same effect
   * that reads it as `u_original` (sharpen's blend, edge work's alpha).
   */
  keep?: boolean;
  /** Reads the copy the last `keep` pass made, as `u_original`. */
  original?: boolean;
}

/** Pixels of a 1080-line frame, in this frame's pixels. */
const px = (value: number, context: PassContext): number => (value * context.height) / 1080;

/** A position across the frame, top-left origin (as the inspector shows it), in texture pixels (bottom-left). */
const pointPx = (x: number, y: number, context: PassContext): [number, number] => [x * context.width, (1 - y) * context.height];

const blurPasses = (radius: (values: Record<string, number>) => number, keepFirst = false): EffectPass[] => {
  // At most 16 a side (30 used to be): past that the reads are further apart
  // than a pixel and the bilinear filter blends between them - the same blur,
  // half the reads of a wide one.
  const taps = (r: number): number => Math.min(16, Math.max(1, Math.ceil(r)));
  return [
    {
      source: TRIANGLE_BLUR,
      keep: keepFirst,
      uniforms: (values, context) => {
        const r = px(radius(values), context);
        return { delta: [r / context.width, 0], taps: taps(r) };
      },
    },
    {
      source: TRIANGLE_BLUR,
      uniforms: (values, context) => {
        const r = px(radius(values), context);
        return { delta: [0, r / context.height], taps: taps(r) };
      },
    },
  ];
};

const tiltPass = (perpendicular: boolean): EffectPass => ({
  source: TILT_SHIFT,
  uniforms: (values, context) => {
    // The focus line crosses the frame at `position` (from the top), turned by `angle`.
    const radians = (values.angle * Math.PI) / 180;
    const along: [number, number] = [Math.cos(radians), -Math.sin(radians)];
    const [cx, cy] = pointPx(0.5, values.position, context);
    const reach = context.width;
    const start = [cx - along[0] * reach, cy - along[1] * reach];
    const end = [cx + along[0] * reach, cy + along[1] * reach];
    return {
      blurRadius: px(values.blur, context),
      gradientRadius: px(values.falloff, context),
      start,
      end,
      delta: perpendicular ? [-along[1], along[0]] : along,
    };
  },
});

/** Each effect's passes, by type. */
export const EFFECT_PASSES: Record<string, readonly EffectPass[]> = {
  brightnessContrast: [{ source: BRIGHTNESS_CONTRAST, uniforms: (v) => ({ brightness: v.brightness, contrast: v.contrast }) }],
  hueSaturation: [{ source: HUE_SATURATION, uniforms: (v) => ({ hue: v.hue, saturation: v.saturation }) }],
  vibrance: [{ source: VIBRANCE, uniforms: (v) => ({ amount: v.amount }) }],
  sepia: [{ source: SEPIA, uniforms: (v) => ({ amount: v.amount }) }],
  gaussianBlur: blurPasses((v) => v.radius),
  // Two passes instead of one of 41 reads: 12 along the whole streak, then 8
  // along a twelfth of it, which fill the first's gaps - 22 reads, smoother.
  zoomBlur: [
    {
      source: ZOOM_BLUR,
      uniforms: (v, c) => ({ center: pointPx(v.centerX, v.centerY, c), strength: (v.strength * 12) / 13, taps: 12 }),
    },
    {
      source: ZOOM_BLUR,
      uniforms: (v, c) => ({ center: pointPx(v.centerX, v.centerY, c), strength: v.strength / 13, taps: 8 }),
    },
  ],
  tiltShift: [tiltPass(false), tiltPass(true)],
  unsharpMask: [
    ...blurPasses((v) => v.radius, true),
    { source: UNSHARP_COMBINE, original: true, uniforms: (v) => ({ strength: v.strength }) },
  ],
  // glfx.js runs it twice, for a stronger result.
  denoise: [
    { source: DENOISE, uniforms: (v) => ({ exponent: v.smoothing, axis: [1, 0] }) },
    { source: DENOISE, uniforms: (v) => ({ exponent: v.smoothing, axis: [0, 1] }) },
    { source: DENOISE, uniforms: (v) => ({ exponent: v.smoothing, axis: [1, 0] }) },
    { source: DENOISE, uniforms: (v) => ({ exponent: v.smoothing, axis: [0, 1] }) },
  ],
  swirl: [
    {
      source: SWIRL,
      uniforms: (v, c) => ({ center: pointPx(v.centerX, v.centerY, c), radius: v.radius * c.height, angle: (v.angle * Math.PI) / 180 }),
    },
  ],
  bulgePinch: [
    {
      source: BULGE_PINCH,
      uniforms: (v, c) => ({ center: pointPx(v.centerX, v.centerY, c), radius: v.radius * c.height, strength: v.strength }),
    },
  ],
  chromaticAberration: [
    {
      source: CHROMATIC_ABERRATION,
      uniforms: (v, c) => {
        const radians = (v.angle * Math.PI) / 180;
        return { amount: px(v.amount, c), radial: v.radial, direction: [Math.cos(radians), Math.sin(radians)] };
      },
    },
  ],
  glitch: [
    {
      source: GLITCH,
      uniforms: (v, c) => ({
        amount: v.amount,
        blockSize: Math.max(1, px(v.blockSize, c)),
        shift: px(v.shift, c),
        // A new glitch `speed` times a second; at 0 it holds one.
        seed: v.speed > 0 ? Math.floor(c.seconds * v.speed) % 997 : 0,
      }),
    },
  ],
  ink: [{ source: INK, uniforms: (v) => ({ strength: v.strength ** 5 }) }],
  edgeWork: [
    { source: EDGE_WORK_1, keep: true, uniforms: (v, c) => ({ delta: [px(v.radius, c) / c.width, 0] }) },
    { source: EDGE_WORK_2, original: true, uniforms: (v, c) => ({ delta: [0, px(v.radius, c) / c.height] }) },
  ],
  hexagonalPixelate: [{ source: HEXAGONAL_PIXELATE, uniforms: (v, c) => ({ center: pointPx(0.5, 0.5, c), scale: Math.max(1, px(v.size, c)) }) }],
  dotScreen: [
    {
      source: DOT_SCREEN,
      uniforms: (v, c) => ({ center: pointPx(0.5, 0.5, c), angle: (v.angle * Math.PI) / 180, scale: Math.PI / Math.max(0.5, px(v.size, c)) }),
    },
  ],
  colorHalftone: [
    {
      source: COLOR_HALFTONE,
      uniforms: (v, c) => ({ center: pointPx(0.5, 0.5, c), angle: (v.angle * Math.PI) / 180, scale: Math.PI / Math.max(0.5, px(v.size, c)) }),
    },
  ],
  filmGrain: [
    {
      source: FILM_GRAIN,
      uniforms: (v, c) => ({
        amount: v.amount,
        grain: Math.max(1, px(v.size, c)),
        // A new pattern each frame: the frame's time at 1/1000 s steps is a fine seed.
        seed: Math.round(c.seconds * 1000) % 251,
        colored: v.color,
      }),
    },
  ],
  lightLeak: [
    {
      source: LIGHT_LEAK,
      uniforms: (v, c) => ({ intensity: v.intensity, hue: v.hue / 360, position: v.position, spread: v.spread, time: c.seconds * v.speed * 4 }),
    },
  ],
};
