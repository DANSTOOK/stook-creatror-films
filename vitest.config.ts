import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// The unit suite covers pure logic only (keyframe math, .cube parsing, timeline
// ops), so it runs in a plain Node environment with no Electron or WebGL stubs.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  assetsInclude: ['**/*.glsl'],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
