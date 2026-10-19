import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * What the transitions and effects cost: `node tests/ui/fx-bench.mjs`
 *
 *   1. GPU time per frame of each effect and each shader transition at
 *      1080p: a frame drawn by the real compositor with and without it,
 *      each finished on the GPU (a 1-pixel readback waits for it), the
 *      median of 20 minus the plain frame's. FILMORA_GPU picks the GPU
 *      (high-performance: the RTX; low-power: the Intel UHD).
 *   2. FX_SHOTS=<dir>: screenshots of the Transitions panel and of the
 *      inspector with an effect stack and its "Add effect" menu.
 *   3. FX_KRATOS=1: export throughput of ten seconds of the Kratos 4K file
 *      at 1080p, plain and with four effects, into Documents\VIDEOS
 *      EXPORTADOS (never next to the source).
 *
 * Results go to stdout and to .ui-tmp/fx-bench/<gpu>.json.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const preference = process.env.FILMORA_GPU ?? 'high-performance';
const workDir = join(projectRoot, '.ui-tmp', `fx-bench-${preference}`);
const shotsDir = process.env.FX_SHOTS ?? '';
const KRATOS = 'C:/Users/defaultuser0/Downloads/KRATOS Vs THOR - Double DLSS 5 Epic Combat (RTX 5090 32GB) 4K DLAA.mp4';
const exportDir = join(homedir(), 'Documents', 'VIDEOS EXPORTADOS');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function catalogIds() {
  const transitions = await readFile(join(projectRoot, 'src/renderer/fx/transitions/catalog.ts'), 'utf8');
  const effects = await readFile(join(projectRoot, 'src/renderer/fx/effects/catalog.ts'), 'utf8');
  const shaderIds = transitions.split(/\n\s*def\('/).slice(1).map((chunk) => /^(\w+)'/.exec(chunk)?.[1]).filter(Boolean);
  const effectTypes = [...effects.matchAll(/type: '(\w+)',?\s*category:/g)].map((match) => match[1]);
  return { shaderIds, effectTypes };
}

async function main() {
  const { shaderIds, effectTypes } = await catalogIds();
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const a = join(workDir, 'a.png');
  const b = join(workDir, 'b.png');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', a]);
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=1920x1080', '-frames:v', '1', b]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      FILMORA_GPU: preference,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const result = { preference, gpu: '', effects: {}, transitions: {}, baselineMs: 0 };
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    const gpu = await window.evaluate(() => window.filmora.gpuReport());
    result.gpu = gpu.devices.find((device) => device.active)?.name ?? '?';
    console.log(`GPU: ${result.gpu}`);

    const files = [a, b, ...(process.env.FX_KRATOS ? [KRATOS] : [])];
    await app.evaluate(({ dialog }, list) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, files);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction((count) => window.__scfStore.getState().assets.length === count, files.length, { timeout: 120_000 });
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1920, height: 1080, fps: 30 });
      const track = s.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      const first = window.__scfStore.getState().addAssetToTimeline(s.assets.find((asset) => asset.name === 'a.png'), track.id, 0);
      window.__scfStore.getState().updateClip(first, { durationFrames: 60 });
      const second = window.__scfStore.getState().addAssetToTimeline(s.assets.find((asset) => asset.name === 'b.png'), track.id, 60);
      window.__scfStore.getState().updateClip(second, { durationFrames: 60 });
      const Compositor = window.__scfRenderer().compositor.constructor;
      if (!Compositor.__fxWrapped) {
        const original = Compositor.drawList;
        Compositor.drawList = (...args) =>
          original(...args).map((entry) => (entry.kind === 'transition' && typeof window.__fxProgress === 'number' ? { ...entry, progress: window.__fxProgress } : entry));
        Compositor.__fxWrapped = true;
      }
      return { first, second };
    });

    /** Median GPU-finished frame time at `frame`, in ms (sources resolved once, then the compositor alone). */
    const timeFrame = (frame) =>
      window.evaluate(async (at) => {
        const renderer = window.__scfRenderer();
        const { project } = window.__scfStore.getState();
        renderer.beginExclusive();
        try {
          await renderer.renderExact(project, at, false); // warm: decode, upload, compile
          const compositor = renderer.compositor;
          const gl = compositor.context;
          const pixel = new Uint8Array(4);
          const sources = new Map();
          // The textures renderExact left bound, reused: what is timed is the compositor.
          const resolve = (clip, sourceFrame) => sources.get(clip.id) ?? null;
          const original = compositor.renderFrame.bind(compositor);
          await renderer.renderExact(project, at, false);
          // Capture the resolver's answers by running renderExact through a spy once.
          const spy = (p, f, resolver, present, compare) =>
            original(p, f, (clip, sourceFrame) => {
              const source = resolver(clip, sourceFrame);
              if (source) sources.set(clip.id, source);
              return source;
            }, present, compare);
          compositor.renderFrame = spy;
          await renderer.renderExact(project, at, false);
          compositor.renderFrame = original;
          const times = [];
          for (let i = 0; i < 22; i += 1) {
            const started = performance.now();
            original(project, at, resolve, false);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            times.push(performance.now() - started);
          }
          times.sort((x, y) => x - y);
          return times[Math.floor(times.length / 2)];
        } finally {
          renderer.endExclusive();
        }
      }, frame);

    const setEffects = (effects) => window.evaluate(([clipId, list]) => window.__scfStore.getState().updateClip(clipId, { effects: list }), [ids.first, effects]);

    result.baselineMs = await timeFrame(20);
    console.log(`plain 1080p frame: ${result.baselineMs.toFixed(2)} ms`);
    console.log('effects (added ms per frame at 1080p):');
    for (const type of effectTypes) {
      const params = type === 'brightnessContrast' ? { brightness: 0.2, contrast: 0.3 } : type === 'hueSaturation' ? { hue: 0.3, saturation: 0.4 } : {};
      await setEffects([{ id: 'bench', type, enabled: true, params }]);
      const ms = await timeFrame(20);
      result.effects[type] = Number((ms - result.baselineMs).toFixed(2));
      console.log(`   ${type.padEnd(22)} ${result.effects[type].toFixed(2)}`);
    }
    await setEffects(undefined);

    console.log('shader transitions (ms per frame at 1080p, both sides drawn):');
    await window.evaluate(([from, to]) => window.__scfStore.getState().addTransitions('crossDissolve', [{ fromId: from, toId: to }]), [ids.first, ids.second]);
    const transitionId = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.transitions)[0]);
    await window.evaluate(() => {
      window.__fxProgress = 0.5;
    });
    const dissolveMs = await timeFrame(60);
    console.log(`   ${'crossDissolve (built in)'.padEnd(22)} ${dissolveMs.toFixed(2)}`);
    result.transitions.crossDissolve = Number(dissolveMs.toFixed(2));
    for (const id of shaderIds) {
      await window.evaluate(([tid, shader]) => window.__scfStore.getState().updateTransition(tid, { kind: 'shader', shader, params: undefined }), [transitionId, id]);
      const ms = await timeFrame(60);
      result.transitions[id] = Number(ms.toFixed(2));
      console.log(`   ${id.padEnd(22)} ${ms.toFixed(2)}`);
    }
    await window.evaluate((tid) => {
      window.__fxProgress = undefined;
      window.__scfStore.getState().removeTransition(tid);
    }, transitionId);

    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      // A cut with the cube on it, so the inspector and the timeline have something to show.
      await window.evaluate(([from, to]) => window.__scfStore.getState().addTransitions('cube', [{ fromId: from, toId: to }]), [ids.first, ids.second]);
      await window.getByTestId('library-tab-transitions').click();
      await window.waitForSelector('[data-testid="library-transitions"]');
      await sleep(2500); // the thumbnails compile one a frame
      await window.getByTestId('library-transition-cube').hover();
      await sleep(700);
      await window.screenshot({ path: join(shotsDir, 'transitions-browser.png') });
      await window.getByTestId('library-transitions-filter-motion').click();
      await window.getByTestId('library-transitions-search').fill('flip');
      await sleep(600);
      await window.screenshot({ path: join(shotsDir, 'transitions-browser-search.png') });
      await window.getByTestId('library-transitions-search').fill('');
      await window.getByTestId('library-transitions-filter-all').click();
      const transitionId2 = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.transitions)[0]);
      await window.evaluate((tid) => window.__scfStore.getState().selectTransition(tid), transitionId2);
      await sleep(400);
      await window.screenshot({ path: join(shotsDir, 'transition-inspector.png') });
      await window.evaluate(([clipId]) => {
        window.__scfStore.getState().selectClips([clipId]);
        window.__scfStore.getState().setCurrentFrame(20);
        window.__scfStore.getState().updateClip(clipId, {
          effects: [
            { id: 'e1', type: 'filmGrain', enabled: true, params: { amount: 0.4, size: 1.5, color: 0 } },
            { id: 'e2', type: 'chromaticAberration', enabled: true, params: { amount: 8, radial: 1, angle: 0 } },
            { id: 'e3', type: 'lightLeak', enabled: true, params: { intensity: 0.7, hue: 30, position: 0.2, spread: 0.5, speed: 0.3 }, keyframes: { intensity: [{ id: 'k1', frame: 0, value: 0, easing: 'linear' }, { id: 'k2', frame: 30, value: 0.8, easing: 'linear' }] } },
          ],
        });
      }, [ids.first]);
      await sleep(600);
      await window.screenshot({ path: join(shotsDir, 'effects-inspector.png') });
      await window.getByTestId('inspector-add-effect').click();
      await sleep(300);
      await window.getByRole('menuitem', { name: 'Blur and sharpen' }).hover();
      await sleep(500);
      await window.screenshot({ path: join(shotsDir, 'effects-add-menu.png') });
      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');
      await setEffects(undefined);
    }

    if (process.env.FX_KRATOS) {
      await mkdir(exportDir, { recursive: true });
      const kratos = await window.evaluate(() => {
        const s = window.__scfStore.getState();
        s.removeClips(Object.keys(s.project.clips));
        const track = window.__scfStore.getState().project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
        const asset = window.__scfStore.getState().assets.find((candidate) => candidate.name.startsWith('KRATOS'));
        const id = window.__scfStore.getState().addAssetToTimeline(asset, track.id, 0);
        // Ten seconds from a minute in, where it is all fighting.
        window.__scfStore.getState().updateClip(id, { sourceOffsetFrames: 1800, durationFrames: 300 });
        return id;
      });
      const exportOnce = async (name) => {
        await app.evaluate(({ dialog }, folder) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
        }, exportDir);
        await window.evaluate(() => window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', exportAlpha: false }));
        await window.getByRole('button', { name: 'Export' }).click();
        const dialog = window.getByRole('dialog', { name: 'Export' });
        await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Whole timeline' }).click();
        await dialog.getByLabel('File name').fill(name);
        await dialog.getByRole('button', { name: 'Browse' }).click();
        await sleep(400);
        const started = Date.now();
        await dialog.getByRole('button', { name: 'Start export' }).click();
        await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 600_000 });
        const seconds = (Date.now() - started) / 1000;
        await dialog.getByTitle('Close').click();
        await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
        const file = (await readdir(exportDir)).find((entry) => entry.startsWith(name));
        const size = file ? (await stat(join(exportDir, file))).size : 0;
        return { seconds, fps: 300 / seconds, file, size };
      };
      const stamp = Date.now();
      result.kratosPlain = await exportOnce(`fx-bench-plain-${preference}-${stamp}`);
      console.log(`Kratos 10 s at 1080p, plain: ${result.kratosPlain.seconds.toFixed(1)} s (${result.kratosPlain.fps.toFixed(1)} fps)`);
      await window.evaluate((clipId) => window.__scfStore.getState().updateClip(clipId, {
        effects: [
          { id: 'k1', type: 'filmGrain', enabled: true, params: {} },
          { id: 'k2', type: 'gaussianBlur', enabled: true, params: { radius: 4 } },
          { id: 'k3', type: 'chromaticAberration', enabled: true, params: {} },
          { id: 'k4', type: 'lightLeak', enabled: true, params: {} },
        ],
      }), kratos);
      result.kratosEffects = await exportOnce(`fx-bench-effects-${preference}-${stamp}`);
      console.log(`Kratos 10 s at 1080p, four effects: ${result.kratosEffects.seconds.toFixed(1)} s (${result.kratosEffects.fps.toFixed(1)} fps)`);
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  await writeFile(join(workDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`written ${join(workDir, 'result.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
