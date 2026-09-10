#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;
uniform vec2 u_resolution;

uniform int u_maskType;          // 0: Off, 1: Rectangle, 2: Ellipse
uniform vec2 u_maskCenter;
uniform vec2 u_maskSize;
uniform float u_maskRotation;
uniform float u_cornerRadius;
uniform float u_feather;
uniform bool u_invertMask;

vec2 rotate2D(vec2 pt, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c) * pt;
}

float sdRoundedBox(in vec2 p, in vec2 b, in float r) {
    vec2 q = abs(p) - b + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float sdEllipse(in vec2 p, in vec2 r) {
    vec2 k0 = p / r;
    vec2 k1 = p / (r * r);
    float l = length(k0);
    return l > 0.0001 ? (l - 1.0) * l / length(k1) : -min(r.x, r.y);
}

void main() {
    vec4 texColor = texture(u_inputTexture, v_texCoord);

    if (u_maskType == 0) {
        fragColor = texColor;
        return;
    }

    vec2 pixelPos = (v_texCoord - u_maskCenter) * u_resolution;
    pixelPos = rotate2D(pixelPos, u_maskRotation);
    vec2 halfSizePixels = (u_maskSize * u_resolution) * 0.5;

    float dist = 0.0;
    if (u_maskType == 1) {
        float maxRadius = min(halfSizePixels.x, halfSizePixels.y);
        float radiusPixels = clamp(u_cornerRadius * u_resolution.y, 0.0, maxRadius);
        dist = sdRoundedBox(pixelPos, halfSizePixels, radiusPixels);
    } else if (u_maskType == 2) {
        dist = sdEllipse(pixelPos, halfSizePixels);
    }

    float halfFeather = max(u_feather * 0.5, 0.001);
    float maskAlpha = 1.0 - smoothstep(-halfFeather, halfFeather, dist);

    if (u_invertMask) {
        maskAlpha = 1.0 - maskAlpha;
    }

    fragColor = vec4(texColor.rgb, texColor.a * maskAlpha);
}
