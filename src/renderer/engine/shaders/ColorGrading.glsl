#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;

uniform float u_exposure;      // -2.0 to 2.0, in stops
uniform float u_contrast;      //  0.0 to 2.0, 1.0 is neutral
uniform float u_saturation;    //  0.0 to 2.0, 1.0 is neutral
uniform float u_temperature;   // -1.0 (cool) to 1.0 (warm)
uniform float u_tint;          // -1.0 (green) to 1.0 (magenta)
uniform float u_pivot;         // level contrast turns about, 0.5 by default

// The primaries wheels as one ASC CDL (see src/renderer/color/grade.ts):
// out = (in * slope + offset) ^ power. Skipped entirely when every wheel is
// neutral, so an untouched grade is bit for bit what it was before them.
uniform bool u_cdlActive;
uniform vec3 u_cdlSlope;
uniform vec3 u_cdlOffset;
uniform vec3 u_cdlPower;

// The curves (src/renderer/color/curves.ts): one R32F texture, a row of
// 1024 samples per curve - master, red, green, blue, then Hue vs Hue, Hue vs
// Sat, Hue vs Luma, Luma vs Sat. Each group is skipped when it is neutral.
uniform highp sampler2D u_curveTexture;
uniform bool u_levelCurvesActive;
uniform bool u_versusCurvesActive;

// A vignette centred on the frame (color/grade.ts, vignetteWeight).
uniform bool u_vignetteActive;
uniform float u_vignetteAmount;
uniform float u_vignetteSize;
uniform float u_vignetteRoundness;
uniform float u_vignetteFeather;
uniform vec2 u_resolution;

// Triangular dither of +-1 level on the way to 8 bits, for graded pixels.
uniform bool u_dither;
uniform int u_frame;

uniform sampler3D u_lutTexture;
uniform bool u_lutEnabled;
uniform float u_lutIntensity;  // 0.0 to 1.0
uniform float u_lutSize;       // Edge length of the LUT cube
uniform vec3 u_lutDomainMin;
uniform vec3 u_lutDomainMax;

const vec3 LUMA_REC709 = vec3(0.2126, 0.7152, 0.0722);

vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Approximate white-balance shift. Positive temperature warms (more red, less
// blue); positive tint pushes toward magenta.
vec3 applyWhiteBalance(vec3 color, float temperature, float tint) {
    vec3 gain = vec3(
        1.0 + 0.30 * temperature + 0.05 * tint,
        1.0 - 0.10 * tint,
        1.0 - 0.30 * temperature + 0.05 * tint
    );
    return color * gain;
}

const float CURVE_SIZE = 1024.0;
const float HUE_FADE_CHROMA = 0.1;

// A curve sample, linear between the stored ones, x clamped to 0..1.
float curveAt(int row, float x) {
    float position = clamp(x, 0.0, 1.0) * (CURVE_SIZE - 1.0);
    int index = min(int(floor(position)), int(CURVE_SIZE) - 2);
    float fraction = position - float(index);
    float a = texelFetch(u_curveTexture, ivec2(index, row), 0).r;
    float b = texelFetch(u_curveTexture, ivec2(index + 1, row), 0).r;
    return mix(a, b, fraction);
}

// A level curve: past either end the picture carries on at the end value
// plus the distance, so values beyond white survive to the LUT.
float levelCurve(int row, float x) {
    return curveAt(row, x) + (x - clamp(x, 0.0, 1.0));
}

// A hue curve wraps around: hue 1 is hue 0.
float hueCurve(int row, float hue) {
    float position = fract(hue) * CURVE_SIZE;
    int index = int(floor(position));
    float fraction = position - float(index);
    float a = texelFetch(u_curveTexture, ivec2(index % int(CURVE_SIZE), row), 0).r;
    float b = texelFetch(u_curveTexture, ivec2((index + 1) % int(CURVE_SIZE), row), 0).r;
    return mix(a, b, fraction);
}

vec3 rgbToHsv(vec3 c) {
    float high = max(c.r, max(c.g, c.b));
    float low = min(c.r, min(c.g, c.b));
    float delta = high - low;
    float hue = 0.0;
    if (delta > 1e-10) {
        if (high == c.r) hue = ((c.g - c.b) / delta) / 6.0;
        else if (high == c.g) hue = ((c.b - c.r) / delta + 2.0) / 6.0;
        else hue = ((c.r - c.g) / delta + 4.0) / 6.0;
    }
    return vec3(fract(hue), high > 1e-10 ? delta / high : 0.0, high);
}

vec3 hsvToRgb(vec3 hsv) {
    vec3 k = mod(vec3(5.0, 3.0, 1.0) + hsv.x * 6.0, 6.0);
    return hsv.z - hsv.z * hsv.y * max(vec3(0.0), min(min(k, 4.0 - k), vec3(1.0)));
}

// pcg3d (Jarzynski & Olano, 2020): a well-mixed hash, the same for a pixel
// and a frame every time, so a render is reproducible.
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}

// Trilinear interpolation is done by the sampler, so this is one fetch. The
// half-texel inset keeps the outermost LUT entries from being clipped.
vec3 applyLUT(vec3 color) {
    vec3 normalized = (color - u_lutDomainMin) / max(u_lutDomainMax - u_lutDomainMin, vec3(1e-5));
    normalized = clamp(normalized, 0.0, 1.0);

    float scale = (u_lutSize - 1.0) / u_lutSize;
    float offset = 1.0 / (2.0 * u_lutSize);
    vec3 uvw = normalized * scale + offset;

    return texture(u_lutTexture, uvw).rgb;
}

void main() {
    vec4 texColor = texture(u_inputTexture, v_texCoord);

    // Grading runs on straight (non-premultiplied) alpha so that transparent
    // sprite edges keep their true color instead of drifting toward black.
    vec3 color = srgbToLinear(clamp(texColor.rgb, 0.0, 1.0));

    color *= exp2(u_exposure);
    color = applyWhiteBalance(color, u_temperature, u_tint);

    color = linearToSrgb(max(color, 0.0));

    // Primaries: lift, gamma, gain, offset. A negative value has no power;
    // it passes through as it is and the final clamp takes care of it.
    if (u_cdlActive) {
        color = color * u_cdlSlope + u_cdlOffset;
        color = mix(color, pow(max(color, vec3(0.0)), u_cdlPower), step(vec3(0.0), color));
    }

    color = (color - u_pivot) * u_contrast + u_pivot;

    float luma = dot(clamp(color, 0.0, 1.0), LUMA_REC709);
    color = mix(vec3(luma), color, u_saturation);

    // Curves: the levels - master on every channel, then each its own.
    if (u_levelCurvesActive) {
        color = vec3(levelCurve(0, color.r), levelCurve(0, color.g), levelCurve(0, color.b));
        color = vec3(levelCurve(1, color.r), levelCurve(2, color.g), levelCurve(3, color.b));
    }

    // Then the versus curves, the hue ones faded out toward grey.
    if (u_versusCurvesActive) {
        color = max(color, vec3(0.0));
        vec3 hsv = rgbToHsv(color);
        float fade = min(1.0, hsv.y * hsv.z / HUE_FADE_CHROMA);
        float shift = hueCurve(4, hsv.x) * fade;
        if (shift != 0.0) color = hsvToRgb(vec3(fract(hsv.x + shift), hsv.y, hsv.z));
        float y = dot(color, LUMA_REC709);
        color = mix(vec3(y), color, 1.0 + hueCurve(5, hsv.x) * fade);
        color += hueCurve(6, hsv.x) * fade;
        y = dot(color, LUMA_REC709);
        color = mix(vec3(y), color, 1.0 + curveAt(7, y));
    }

    // No clamp before the look: a LUT made for values past 1 gets them, and
    // the one clamp is at the very end.
    if (u_lutEnabled) {
        color = mix(color, applyLUT(color), clamp(u_lutIntensity, 0.0, 1.0));
    }

    // The vignette, after the look, as Lumetri places it.
    if (u_vignetteActive) {
        vec2 p = (v_texCoord - 0.5) * 2.0;
        float aspect = u_resolution.x / max(u_resolution.y, 1.0);
        vec2 q = vec2(p.x * (1.0 + (aspect - 1.0) * max(u_vignetteRoundness, 0.0)), p.y);
        float exponent = 2.0 + 6.0 * max(-u_vignetteRoundness, 0.0);
        float distance = pow(pow(abs(q.x), exponent) + pow(abs(q.y), exponent), 1.0 / exponent);
        float start = u_vignetteSize * 1.4;
        float weight = smoothstep(start, start + max(u_vignetteFeather, 0.01) * 1.2, distance) * abs(u_vignetteAmount);
        color = u_vignetteAmount < 0.0 ? color * (1.0 - weight) : mix(color, vec3(1.0), weight);
    }

    color = clamp(color, 0.0, 1.0);

    // Dither: a graded value between two 8-bit levels is nudged by triangular
    // noise of +-1 level, so a smooth gradient does not quantize into bands.
    // A value already on a level (an untouched picture, a neutral grade) is
    // left alone: a picture with nothing between its levels gains nothing
    // from noise.
    if (u_dither) {
        vec3 levels = color * 255.0;
        vec3 between = abs(levels - floor(levels + 0.5));
        if (max(between.r, max(between.g, between.b)) > 0.1) {
            uvec3 hash = pcg3d(uvec3(uvec2(gl_FragCoord.xy), uint(u_frame)));
            float noise = (float(hash.x) + float(hash.y)) / 4294967296.0 - 1.0;
            color = clamp(color + noise / 255.0, 0.0, 1.0);
        }
    }

    fragColor = vec4(color, texColor.a);
}
