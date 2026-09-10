import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';
import { resolve } from 'node:path';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer'),
  '@main': resolve(__dirname, 'src/main'),
};

/**
 * Build for the end-to-end harness.
 *
 * Separate from the app build so the harness page, which talks to `ipcRenderer`
 * directly, can never end up in a shipped bundle.
 */
export default defineConfig({
  root: resolve(__dirname, 'tests/e2e'),
  resolve: { alias },
  assetsInclude: ['**/*.glsl'],
  plugins: [
    electron({
      main: {
        entry: resolve(__dirname, 'tests/e2e/main.ts'),
        vite: {
          resolve: { alias },
          build: {
            outDir: resolve(__dirname, 'dist-e2e/main'),
            rollupOptions: { external: ['electron', 'ffmpeg-static'] },
          },
        },
      },
      preload: {
        input: resolve(__dirname, 'src/main/preload.ts'),
        vite: {
          resolve: { alias },
          build: {
            outDir: resolve(__dirname, 'dist-e2e/preload'),
            rollupOptions: { external: ['electron'] },
          },
        },
      },
    }),
  ],
  build: {
    outDir: resolve(__dirname, 'dist-e2e/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'tests/e2e/index.html'),
      // The harness page runs with nodeIntegration available to it.
      external: ['electron'],
    },
  },
});
