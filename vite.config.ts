import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'node:path';

// The main and preload bundles are built by nested Vite configs, which do not
// inherit the root `resolve.alias`, so the map is shared explicitly.
const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer'),
  '@main': resolve(__dirname, 'src/main'),
};

export default defineConfig({
  resolve: { alias },
  // .glsl is imported with the `?raw` suffix; registering it as an asset keeps
  // the shader files out of the JS transform pipeline entirely.
  assetsInclude: ['**/*.glsl'],
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/index.ts',
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: { external: ['electron', 'ffmpeg-static'] },
          },
        },
      },
      preload: {
        input: resolve(__dirname, 'src/main/preload.ts'),
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: { external: ['electron'] },
          },
        },
      },
    }),
    renderer(),
  ],
  build: {
    outDir: 'dist',
    target: 'chrome126',
    emptyOutDir: true,
  },
  server: { port: 5273 },
});
