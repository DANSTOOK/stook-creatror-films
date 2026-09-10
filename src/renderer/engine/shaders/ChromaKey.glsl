#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;

uniform vec3 u_keyColor;     // Linear RGB of the screen being removed
uniform float u_similarity;  // 0.0 to 1.0, how far from the key still keys out
uniform float u_smoothness;  // 0.0 to 1.0, width of the soft edge
uniform float u_spill;       // 0.0 to 1.0, how aggressively to remove spill

// Keying in chroma space (Cb/Cr) rather than RGB keeps the matte stable across
// the luminance variation of a real lit screen.
vec2 rgbToCbCr(vec3 c) {
    float y = dot(c, vec3(0.2989, 0.5866, 0.1145));
    return vec2(c.b - y, c.r - y);
}

void main() {
    vec4 texColor = texture(u_inputTexture, v_texCoord);

    vec2 keyChroma = rgbToCbCr(u_keyColor);
    vec2 pixelChroma = rgbToCbCr(texColor.rgb);

    float chromaDistance = distance(pixelChroma, keyChroma);

    float base = max(u_similarity, 0.001) * 0.5;
    float edge = base + max(u_smoothness, 0.001) * 0.5;
    float matte = smoothstep(base, edge, chromaDistance);

    // Spill suppression: pull the keyed hue out of surviving edge pixels by
    // clamping the offending channel toward the average of the other two.
    vec3 color = texColor.rgb;
    if (u_spill > 0.0) {
        float keyLuma = dot(u_keyColor, vec3(0.2989, 0.5866, 0.1145));
        vec3 keyDirection = normalize(max(u_keyColor - keyLuma, vec3(1e-4)));
        float spillAmount = max(dot(color - dot(color, vec3(0.2989, 0.5866, 0.1145)), keyDirection), 0.0);
        color = mix(color, vec3(dot(color, vec3(0.2989, 0.5866, 0.1145))), clamp(spillAmount * u_spill, 0.0, 1.0));
    }

    fragColor = vec4(color, texColor.a * matte);
}
