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
        // The matting worker is a program of its own, run as an Electron
        // utility process (src/main/matting/worker.ts), so it is a second
        // entry: dist-electron/main/matteWorker.js beside index.js.
        entry: { index: 'src/main/index.ts', matteWorker: 'src/main/matting/worker.ts' },
        vite: {
          resolve: { alias },
          build: {
            outDir: 'dist-electron/main',
            // onnxruntime-node is a native addon with its DLLs beside it: it is
            // loaded from node_modules, never bundled (electron-builder.yml).
            rollupOptions: { external: ['electron', 'ffmpeg-static', 'onnxruntime-node'] },
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
