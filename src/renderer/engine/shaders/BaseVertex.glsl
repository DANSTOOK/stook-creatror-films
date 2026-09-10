#version 300 es
precision highp float;

// Shared vertex stage for every pass in the compositor.
//
// Geometry is always the same unit quad (0.0 to 1.0). `u_transform` maps that
// quad into clip space, which is how both a full-screen effect pass (identity
// quad -> full viewport) and a positioned/scaled/rotated clip layer are drawn
// with one vertex program.

in vec2 a_position;   // Unit quad corner, 0.0 to 1.0
in vec2 a_texCoord;   // Matching UV, 0.0 to 1.0

uniform mat3 u_transform;
uniform bool u_flipY; // HTMLVideoElement / ImageBitmap sources arrive top-down

out vec2 v_texCoord;

void main() {
    vec3 clipPos = u_transform * vec3(a_position, 1.0);
    gl_Position = vec4(clipPos.xy, 0.0, 1.0);
    v_texCoord = u_flipY ? vec2(a_texCoord.x, 1.0 - a_texCoord.y) : a_texCoord;
}
