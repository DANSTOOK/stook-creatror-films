#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputTexture;
uniform vec2 u_resolution;

uniform float u_pixelSize;       // Source pixels collapsed into one output pixel
uniform float u_paletteSteps;    // 0.0 disables quantization
uniform float u_alphaThreshold;  // Alpha below this is cut to 0

// Pixelization plus optional palette quantization.
//
// The alpha cut matters for sprite export: an antialiased edge that survives
// into a PNG sequence shows up as a halo once the sprite is composited over a
// different background in the game engine, so partial alpha is snapped to a
// hard 0/1 edge.
void main() {
    float blockSize = max(u_pixelSize, 1.0);

    // Sample the centre of the block so the result is a true nearest-neighbour
    // downscale rather than a shifted one.
    vec2 pixelCoord = v_texCoord * u_resolution;
    vec2 blockCentre = (floor(pixelCoord / blockSize) + 0.5) * blockSize;
    vec2 snappedUv = blockCentre / u_resolution;

    vec4 texColor = texture(u_inputTexture, clamp(snappedUv, vec2(0.0), vec2(1.0)));

    vec3 color = texColor.rgb;
    if (u_paletteSteps >= 2.0) {
        float steps = u_paletteSteps - 1.0;
        color = floor(color * steps + 0.5) / steps;
    }

    float alpha = texColor.a;
    if (u_alphaThreshold > 0.0) {
        alpha = alpha >= u_alphaThreshold ? 1.0 : 0.0;
    }

    fragColor = vec4(color, alpha);
}
