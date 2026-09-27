import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The video scopes, in the running app: `npm run test:scopes`
 *
 * Known pictures go through the real compositor, and what the scopes read
 * back from the GPU is compared with what went in:
 *
 *   - 50% grey is one line at 50% on the waveform;
 *   - pure red is at 100% in the red parade and at 0% in green and blue;
 *   - a ramp gives a flat histogram;
 *   - the six 75% bars land in their six vectorscope targets.
 *
 * Then what they cost: nothing while the picture stands still, nothing while
 * they are closed, nothing during an export, and 4K playback with them open
 * against the same playback with them closed.
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots of it, in English
 * and in Spanish, go to SCOPES_SHOTS when that is set.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'scopes');
const shotsDir = process.env.SCOPES_SHOTS ?? '';

const W = 1024;
const H = 576;
const BARS = [[191, 0, 0], [191, 0, 191], [0, 0, 191], [0, 191, 191], [0, 191, 0], [191, 191, 0]];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = (file, args) => execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024 });

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function still(path, colourAt) {
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = colourAt(x, y);
      const offset = (y * W + x) * 3;
      rgb[offset] = r;
      rgb[offset + 1] = g;
      rgb[offset + 2] = b;
    }
  }
  await writeFile(`${path}.rgb`, rgb);
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${W}x${H}`,
    '-i', `${path}.rgb`, '-frames:v', '1', path]);
}

const paths = {
  grey: join(workDir, 'grey50.png'),
  red: join(workDir, 'red.png'),
  ramp: join(workDir, 'ramp.png'),
  bars: join(workDir, 'bars75.png'),
  uhd: join(workDir, 'uhd.mp4'),
};

async function prepare() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await still(paths.grey, () => [128, 128, 128]);
  await still(paths.red, () => [255, 0, 0]);
  // Four pixels a level: the scopes sample every other column of 1024, so
  // each of the 256 levels is sampled exactly twice.
  await still(paths.ramp, (x) => [x >> 2, x >> 2, x >> 2]);
  // Six 75% bars of 128 pixels, then black.
  await still(paths.bars, (x) => (x < 768 ? BARS[x >> 7] : [0, 0, 0]));
  // Ten seconds of moving 4K, for the playback cadence.
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', paths.uhd]);
}

async function main() {
  console.log('1. making the pictures');
  await prepare();

  console.log('2. starting the app (off screen)');
  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 950));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    await window.evaluate(({ w, h }) => window.__scfStore.getState().setProjectSettings({ width: w, height: h }), { w: W, h: H });

    // Import through the real dialog.
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [paths.grey, paths.red, paths.ramp, paths.bars]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 4, null, { timeout: 30_000 });

    // Each still on Video 1, 200 frames apart.
    const starts = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0)
        ?? store.project.tracks.find((candidate) => candidate.type === 'video');
      const order = ['grey50.png', 'red.png', 'ramp.png', 'bars75.png'];
      const result = {};
      order.forEach((name, index) => {
        const asset = window.__scfStore.getState().assets.find((candidate) => candidate.name === name);
        window.__scfStore.getState().addAssetToTimeline(asset, track.id, index * 200);
        result[name] = index * 200;
      });
      return result;
    });

    console.log('3. the scopes against known pictures');
    // Have the worker echo what it draws, to compare with the picture.
    await window.evaluate(() => { window.__scfScopeDebug = true; });
    await window.getByTestId('viewer-scopes').click();
    await window.getByTestId('scopes-panel').waitFor({ state: 'visible', timeout: 5_000 });
    check('the scopes button opens the scopes beside the picture', true);
    const layout = await window.evaluate(() => {
      const scopes = document.querySelector('[data-testid="scopes-panel"]').getBoundingClientRect();
      const canvas = document.querySelector('[data-testid="preview-panel"] canvas');
      const picture = canvas.getBoundingClientRect();
      return { scopesRight: scopes.right, pictureLeft: picture.left, firstCanvasIsPicture: !canvas.closest('[data-testid="scopes-panel"]') };
    });
    check('they sit to the left of the picture, whose canvas stays the first', layout.scopesRight <= layout.pictureLeft + 1 && layout.firstCanvasIsPicture,
      `scopes end at ${layout.scopesRight.toFixed(0)}, picture starts at ${layout.pictureLeft.toFixed(0)}`);

    await window.getByTestId('scopes-two').click();
    const choose = (slot, kind) => window.getByTestId(`scope-kind-${slot}`).selectOption(kind);

    /**
     * Put the playhead on `frame`, wait for a reading whose sample in column
     * `column` is `rgb` everywhere down that column, then for the worker to
     * have drawn it.
     */
    const readAt = async (frame, column, rgb) => {
      await window.evaluate((at) => window.__scfStore.getState().setCurrentFrame(at), frame);
      const read = await window.waitForFunction(({ x, want }) => {
        const capture = window.__scfScopeCapture?.();
        if (!capture) return false;
        for (let y = 0; y < capture.height; y += 1) {
          const i = (y * capture.width + x) * 4;
          if (capture.rgba[i] !== want[0] || capture.rgba[i + 1] !== want[1] || capture.rgba[i + 2] !== want[2]) return false;
        }
        return true;
      }, { x: column, want: rgb }, { timeout: 10_000, polling: 50 }).then(() => true, () => false);
      const drawn = await window.evaluate(() => window.__scfScopeStats.drawn);
      await window.waitForFunction((n) => window.__scfScopeStats.drawn > n, drawn, { timeout: 5_000 }).catch(() => undefined);
      await sleep(100);
      return read;
    };

    // 50% grey.
    await choose(0, 'waveform');
    await choose(1, 'vectorscope');
    const greyRead = await readAt(starts['grey50.png'] + 5, 0, [128, 128, 128])
      && await window.evaluate(() => window.__scfScopeCapture().rgba.every((value, i) => (i % 4 === 3 ? true : value === 128)));
    const grey = await window.evaluate(() => {
      const data = window.__scfScopeData;
      const levels = new Set();
      for (let level = 0; level < 256; level += 1) {
        for (let x = 0; x < data.width; x += 1) if (data.waveform[level * data.width + x] > 0) levels.add(level);
      }
      const centre = 128 * 256 + 128;
      return { width: data.width, height: data.height, levels: [...levels], centre: data.vectorscope[centre], pixels: data.width * data.height };
    });
    check('50% grey reads back from the GPU as 128,128,128 in every sample', greyRead, `${grey.width}x${grey.height} samples`);
    check('50% grey is one line at 50% on the waveform', grey.levels.length === 1 && grey.levels[0] === 128, `levels ${grey.levels.join(',')}`);
    check('and one dot at the centre of the vectorscope', grey.centre === grey.pixels, `${grey.centre} of ${grey.pixels}`);

    // Pure red in the parade.
    await choose(0, 'parade');
    const redRead = await readAt(starts['red.png'] + 5, 0, [255, 0, 0]);
    const red = await window.evaluate(() => {
      const data = window.__scfScopeData;
      const levelsOf = (bins) => {
        const levels = new Set();
        for (let level = 0; level < 256; level += 1) for (let x = 0; x < data.width; x += 1) if (bins[level * data.width + x] > 0) levels.add(level);
        return [...levels];
      };
      return data.parade.map(levelsOf);
    });
    check('pure red is at 100% in the red parade and 0% in green and blue', redRead
      && red[0].join() === '255' && red[1].join() === '0' && red[2].join() === '0', `R ${red[0]}, G ${red[1]}, B ${red[2]}`);

    // A ramp gives a flat histogram.
    await choose(1, 'histogram');
    const rampRead = await readAt(starts['ramp.png'] + 5, 511, [255, 255, 255]);
    const ramp = await window.evaluate(() => {
      const { histogram } = window.__scfScopeData;
      const counts = [...histogram.y];
      return { min: Math.min(...counts), max: Math.max(...counts), r: Math.min(...histogram.r) === Math.max(...histogram.r) };
    });
    check('a ramp gives a flat histogram', rampRead && ramp.min === ramp.max && ramp.min > 0 && ramp.r, `every level ${ramp.min}..${ramp.max} pixels`);

    // The 75% bars on their targets.
    await choose(1, 'vectorscope');
    const barsRead = await readAt(starts['bars75.png'] + 5, 0, [191, 0, 0]);
    const bars = await window.evaluate((targets) => {
      const data = window.__scfScopeData;
      const cellOf = ([r, g, b]) => {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const cb = (b - y) / 255 / 1.8556;
        const cr = (r - y) / 255 / 1.5748;
        // Independent of the app's own arithmetic: Cb right, Cr up, +-0.5 to the edges.
        const cell = (v) => Math.min(255, Math.max(0, Math.round(v * 255)));
        return cell(0.5 - cr) * 256 + cell(cb + 0.5);
      };
      const lit = [...data.vectorscope].map((count, index) => [index, count]).filter(([, count]) => count > 0);
      return { lit: lit.length, onTargets: targets.map((rgb) => data.vectorscope[cellOf(rgb)]), perBar: (data.width / 8) * data.height };
    }, BARS);
    check('the six 75% bars land in their six targets (and black in the centre)', barsRead && bars.lit === 7
      && bars.onTargets.every((count) => count === bars.perBar), `${bars.lit} cells lit, per target ${bars.onTargets.join('/')} of ${bars.perBar}`);

    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      await choose(0, 'waveform');
      await window.evaluate((at) => window.__scfStore.getState().setCurrentFrame(at), starts['bars75.png'] + 5);
      await sleep(600);
      await window.screenshot({ path: join(shotsDir, 'scopes-en-bars.png') });
    }

    console.log('4. what they cost');
    const stats = () => window.evaluate(() => ({ ...window.__scfScopeStats }));
    await sleep(400);
    let before = await stats();
    await sleep(1500);
    let after = await stats();
    check('paused and unchanged: no readings at all', after.captures === before.captures, `${after.captures - before.captures} in 1.5 s`);
    before = after;
    await window.evaluate(() => window.__scfStore.getState().stepFrames(1));
    await sleep(400);
    after = await stats();
    check('paused, one change: a new reading', after.captures > before.captures && after.published > before.published,
      `${after.captures - before.captures} reading(s)`);

    // During an export: nothing.
    before = await stats();
    await window.evaluate(() => window.__scfRenderer().beginExclusive());
    await window.evaluate(() => window.__scfStore.getState().stepFrames(1));
    await sleep(600);
    after = await stats();
    await window.evaluate(() => window.__scfRenderer().endExclusive());
    check('during an export: no readings', after.captures === before.captures && after.skippedExport > before.skippedExport,
      `${after.captures - before.captures} readings, ${after.skippedExport - before.skippedExport} ticks held back`);

    // 4K playback, scopes closed and open.
    console.log('5. 4K playback, scopes closed and open');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, paths.uhd);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 5, null, { timeout: 60_000 });
    const uhdStart = 1000;
    await window.evaluate((start) => {
      const store = window.__scfStore.getState();
      store.setProjectSettings({ width: 3840, height: 2160 });
      const track = store.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0)
        ?? store.project.tracks.find((candidate) => candidate.type === 'video');
      const asset = window.__scfStore.getState().assets.find((candidate) => candidate.name === 'uhd.mp4');
      window.__scfStore.getState().addAssetToTimeline(asset, track.id, start);
    }, uhdStart);
    await window.evaluate(() => {
      window.__scfGaps = [];
      let last = 0;
      const tick = (time) => {
        if (last) window.__scfGaps.push(time - last);
        last = time;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const play = async (label) => {
      await window.evaluate((start) => window.__scfStore.getState().setCurrentFrame(start + 15), uhdStart);
      await sleep(1500);
      const startStats = await stats();
      const result = await window.evaluate(async () => {
        const renderer = window.__scfRenderer();
        window.__scfGaps.length = 0;
        const uploads = renderer.textures.generation;
        const frameStart = window.__scfStore.getState().project.currentFrame;
        const began = performance.now();
        window.__scfStore.getState().setPlaying(true);
        await new Promise((done) => setTimeout(done, 6000));
        window.__scfStore.getState().setPlaying(false);
        const seconds = (performance.now() - began) / 1000;
        const gaps = window.__scfGaps.slice().sort((a, b) => a - b);
        const pct = (p) => gaps[Math.min(gaps.length - 1, Math.floor((gaps.length * p) / 100))];
        return {
          pictures: (renderer.textures.generation - uploads) / seconds,
          advanced: (window.__scfStore.getState().project.currentFrame - frameStart) / seconds,
          p50: pct(50),
          p95: pct(95),
          worst: gaps[gaps.length - 1],
          composite: renderer.compositor.stats.lastFrameMs,
        };
      });
      const endStats = await stats();
      const readings = endStats.captures - startStats.captures;
      console.log(`   ${label}: ${result.pictures.toFixed(1)} new pictures/s, playhead ${result.advanced.toFixed(1)} fr/s, `
        + `frame gaps p50 ${result.p50.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, worst ${result.worst.toFixed(1)} ms; `
        + `scope readings ${(readings / 6).toFixed(1)}/s, skipped late ${endStats.skippedLate - startStats.skippedLate}, `
        + `main thread per reading: capture ${(readings ? (endStats.captureMs - startStats.captureMs) / readings : 0).toFixed(2)} ms + hand-over `
        + `${(readings ? (endStats.postMs - startStats.postMs) / readings : 0).toFixed(2)} ms; worker `
        + `${(endStats.drawn - startStats.drawn ? (endStats.drawMs - startStats.drawMs) / (endStats.drawn - startStats.drawn) : 0).toFixed(2)} ms each`);
      return {
        ...result,
        readingsPerSecond: readings / 6,
        mainMsPerReading: readings ? (endStats.captureMs - startStats.captureMs + endStats.postMs - startStats.postMs) / readings : 0,
      };
    };

    await choose(0, 'waveform');
    await choose(1, 'vectorscope');
    const open = await play('scopes open  ');
    if (shotsDir) {
      await window.evaluate((start) => window.__scfStore.getState().setCurrentFrame(start + 45), uhdStart);
      await choose(0, 'parade');
      await choose(1, 'histogram');
      await sleep(800);
      await window.screenshot({ path: join(shotsDir, 'scopes-en-4k.png') });
    }
    await window.getByTestId('viewer-scopes').click();
    await window.getByTestId('scopes-panel').waitFor({ state: 'detached', timeout: 5_000 });
    const closedBefore = await stats();
    const closed = await play('scopes closed');
    const closedAfter = await stats();
    check('closed: no readings, and the GPU copy is given back', closedAfter.captures === closedBefore.captures
      && (await window.evaluate(() => window.__scfScopeCapture() === null)), `${closedAfter.captures - closedBefore.captures} readings`);
    check('main-thread cost per reading under 1 ms (the measuring runs in a worker)', open.mainMsPerReading < 1,
      `${open.mainMsPerReading.toFixed(2)} ms`);
    check('open during 4K playback: 10-15 readings a second', open.readingsPerSecond >= 9 && open.readingsPerSecond <= 15,
      `${open.readingsPerSecond.toFixed(1)}/s`);
    check('4K playback keeps its pace with the scopes open', open.pictures >= closed.pictures * 0.95 && open.p95 <= closed.p95 + 4,
      `${open.pictures.toFixed(1)} vs ${closed.pictures.toFixed(1)} pictures/s, p95 ${open.p95.toFixed(1)} vs ${closed.p95.toFixed(1)} ms`);

    if (shotsDir) {
      // The same in Spanish.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
      await window.getByTestId('language-select').selectOption('es');
      await window.keyboard.press('Escape');
      await sleep(400);
      await window.getByTestId('viewer-scopes').click();
      await sleep(900);
      await window.screenshot({ path: join(shotsDir, 'scopes-es-4k.png') });
      await window.evaluate((at) => window.__scfStore.getState().setCurrentFrame(at), starts['bars75.png'] + 5);
      await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1024, height: 576 }));
      await choose(0, 'waveform');
      await choose(1, 'vectorscope');
      await sleep(900);
      await window.screenshot({ path: join(shotsDir, 'scopes-es-bars.png') });
      await window.getByTestId('viewer-scopes').hover();
      await sleep(900);
      await window.screenshot({ path: join(shotsDir, 'scopes-es-tooltip.png') });
    }

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
