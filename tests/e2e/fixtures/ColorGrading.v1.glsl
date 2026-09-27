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

    color = (color - 0.5) * u_contrast + 0.5;

    float luma = dot(clamp(color, 0.0, 1.0), LUMA_REC709);
    color = mix(vec3(luma), color, u_saturation);

    color = clamp(color, 0.0, 1.0);

    if (u_lutEnabled) {
        color = mix(color, applyLUT(color), clamp(u_lutIntensity, 0.0, 1.0));
    }

    fragColor = vec4(color, texColor.a);
}
