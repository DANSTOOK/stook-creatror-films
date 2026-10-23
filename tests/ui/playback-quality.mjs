import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Playback quality, in the running app: `node tests/ui/playback-quality.mjs`
 *
 * A 4K edit: a red square moved right of centre over a grey 4K video.
 *   1. Paused, the viewer draws every pixel of the frame; playing on Auto it
 *      draws what the viewer shows - fewer pixels, the same picture: the
 *      square in the same place, the same size, in proportion.
 *   2. 1/2 and 1/4 draw those fractions; Full draws the whole frame.
 *   3. An export frame rendered while the viewer plays lighter is still the
 *      whole 4K frame.
 *   4. A fresh install composites on the dedicated GPU.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'playback-quality');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const grey = join(work, 'grey-4k.mp4');
  const red = join(work, 'red.png');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x606060:s=3840x2160:r=30:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', grey]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xe01010:s=640x640', '-frames:v', '1', red]);

  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' };
  delete env.FILMORA_GPU;
  const app = await electron.launch({ args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')], cwd: root, env });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    window.on('console', (message) => { if (message.type() === 'error') issues.push(`console ${message.text()}`); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [grey, red]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 3840, height: 2160, fps: 30 });
      const [lower, upper] = s.project.tracks.filter((t) => t.type === 'video').sort((a, b) => a.order - b.order);
      s.addAssetToTimeline(s.assets.find((a) => a.name.startsWith('grey')), lower.id, 0);
      s.addAssetToTimeline(s.assets.find((a) => a.name.startsWith('red')), upper.id, 0);
      const square = Object.values(window.__scfStore.getState().project.clips).find((c) => c.trackId === upper.id);
      // A quarter of the frame tall, 960 px right of centre.
      window.__scfStore.getState().updateClip(square.id, { durationFrames: 150, transform: { ...square.transform, scale: [{ id: 's', frame: 0, value: { x: 0.25, y: 0.25 }, easing: 'linear' }], position: [{ id: 'p', frame: 0, value: { x: 960, y: 0 }, easing: 'linear' }] } });
      window.__scfStore.getState().setCurrentFrame(10);
    });
    await sleep(1500);

    // The red square in what the viewer last drew: its box as fractions of the frame.
    const look = () => window.evaluate(() => {
      const renderer = window.__scfRenderer();
      const { width, height } = renderer.drawnSize;
      const rgba = renderer.compositor.readPixels(false);
      let minX = width, maxX = -1, minY = height, maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * 4;
          if (rgba[at] > 180 && rgba[at + 1] < 80) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { width, height, box: maxX < 0 ? null : [minX / width, minY / height, (maxX + 1) / width, (maxY + 1) / height].map((v) => +v.toFixed(3)) };
    });
    const playing = async (on) => {
      await window.evaluate((value) => window.__scfStore.getState().setPlaying(value), on);
      await sleep(700);
    };

    console.log('1. paused and playing');
    const paused = await look();
    await playing(true);
    const auto = await look();
    await playing(false);
    const display = await window.evaluate(() => window.__scfRenderer().displaySize);
    const same = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 0.01);
    check('paused, every pixel of the 4K frame', paused.width === 3840 && paused.height === 2160, `${paused.width}x${paused.height}`);
    check('playing on Auto, what the viewer shows: fewer pixels', auto.width < 3840 && Math.abs(auto.width - display.width) <= 4, `${auto.width}x${auto.height}; viewer ${Math.round(display.width)}x${Math.round(display.height)}`);
    check('the same picture: the square in the same place, the same size', same(paused.box, auto.box) && paused.box[0] > 0.6, JSON.stringify({ paused: paused.box, auto: auto.box }));

    console.log('2. the fractions');
    const sizes = {};
    for (const quality of ['half', 'quarter', 'full']) {
      await window.getByTestId('viewer-quality').selectOption(quality);
      await playing(true);
      const seen = await look();
      sizes[quality] = { size: `${seen.width}x${seen.height}`, box: seen.box };
      await playing(false);
    }
    check('1/2, 1/4 and Full draw those', sizes.half.size === '1920x1080' && sizes.quarter.size === '960x540' && sizes.full.size === '3840x2160' && same(sizes.quarter.box, paused.box), JSON.stringify(sizes));

    console.log('3. an export frame');
    await window.getByTestId('viewer-quality').selectOption('quarter');
    await playing(true);
    const exported = await window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(window.__scfStore.getState().project, 20, false);
        return rgba.length;
      } finally {
        renderer.endExclusive();
      }
    });
    await playing(false);
    check('rendered while the viewer plays at 1/4, an export frame is the whole 4K frame', exported === 3840 * 2160 * 4, `${exported} bytes`);
    await window.getByTestId('viewer-quality').selectOption('auto');

    console.log('4. the GPU');
    const gpu = await app.evaluate(({ app: electronApp }) => electronApp.commandLine.hasSwitch('force_high_performance_gpu'));
    check('a fresh install composites on the dedicated GPU', gpu);

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
