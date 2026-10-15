#version 300 es
precision highp float;

/*
 * One layer over the scene, with a blend mode.
 *
 * The same formulas as engine/blending.ts, which is the reference the GPU
 * check compares this against: W3C Compositing and Blending Level 1. Both
 * textures arrive premultiplied, as everything in the compositor is, so the
 * colour is divided out, blended straight, and multiplied back.
 *
 * Mode numbers come from BLEND_MODE_INDEX.
 */

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_backdrop;
uniform sampler2D u_source;
uniform float u_opacity;
uniform int u_mode;

vec3 multiplyBlend(vec3 cb, vec3 cs) {
    return cb * cs;
}

vec3 screenBlend(vec3 cb, vec3 cs) {
    return cb + cs - cb * cs;
}

vec3 hardLightBlend(vec3 cb, vec3 cs) {
    return mix(screenBlend(cb, 2.0 * cs - 1.0), multiplyBlend(cb, 2.0 * cs), step(cs, vec3(0.5)));
}

vec3 softLightD(vec3 cb) {
    vec3 low = ((16.0 * cb - 12.0) * cb + 4.0) * cb;
    return mix(sqrt(cb), low, step(cb, vec3(0.25)));
}

vec3 colorDodge(vec3 cb, vec3 cs) {
    vec3 result;
    for (int channel = 0; channel < 3; channel++) {
        float b = cb[channel];
        float s = cs[channel];
        result[channel] = b == 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)));
    }
    return result;
}

vec3 colorBurn(vec3 cb, vec3 cs) {
    vec3 result;
    for (int channel = 0; channel < 3; channel++) {
        float b = cb[channel];
        float s = cs[channel];
        result[channel] = b >= 1.0 ? 1.0 : (s == 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s));
    }
    return result;
}

vec3 blend(int mode, vec3 cb, vec3 cs) {
    if (mode == 1) return multiplyBlend(cb, cs);
    if (mode == 2) return screenBlend(cb, cs);
    if (mode == 3) return hardLightBlend(cs, cb);           // overlay
    if (mode == 4) return min(cb, cs);                      // darken
    if (mode == 5) return max(cb, cs);                      // lighten
    if (mode == 6) return colorDodge(cb, cs);
    if (mode == 7) return colorBurn(cb, cs);
    if (mode == 8) return hardLightBlend(cb, cs);
    if (mode == 9) {
        vec3 dark = cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
        vec3 light = cb + (2.0 * cs - 1.0) * (softLightD(cb) - cb);
        return mix(light, dark, step(cs, vec3(0.5)));
    }
    if (mode == 10) return abs(cb - cs);                    // difference
    if (mode == 11) return cb + cs - 2.0 * cb * cs;         // exclusion
    return cs;                                              // normal
}

/** Straight colour from a premultiplied sample; black where there is nothing. */
vec3 straight(vec4 premultiplied) {
    return premultiplied.a > 0.0 ? premultiplied.rgb / premultiplied.a : vec3(0.0);
}

void main() {
    vec4 backdrop = texture(u_backdrop, v_texCoord);
    vec4 sourceTexel = texture(u_source, v_texCoord);

    float as = clamp(sourceTexel.a * u_opacity, 0.0, 1.0);
    float ab = clamp(backdrop.a, 0.0, 1.0);

    vec3 cb = clamp(straight(backdrop), 0.0, 1.0);
    vec3 cs = clamp(straight(sourceTexel), 0.0, 1.0);

    // Where the backdrop is transparent the blend fades back to the source.
    vec3 blended = (1.0 - ab) * cs + ab * blend(u_mode, cb, cs);

    // Source-over, written premultiplied: co = as x Cs + ab x Cb x (1 - as).
    vec3 premultiplied = as * blended + ab * cb * (1.0 - as);
    float ao = as + ab * (1.0 - as);

    fragColor = vec4(premultiplied, ao);
}
