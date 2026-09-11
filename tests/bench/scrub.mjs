import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

/**
 * Scrubbing benchmark: `BENCH_SOURCE=<video> electron tests/bench/scrub.mjs`
 *
 * Drags the playhead across the ruler of the real app, the way a hand does -
 * a pointer move every 16 ms - forwards and then backwards, once with the
 * forward decoder and once seeking the video element only (the old way).
 * Reports how often the preview showed EXACTLY the frame under the playhead,
 * and how many audio grains played.
 */

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.bench-tmp');
const source = process.env.BENCH_SOURCE;
if (!source) throw new Error('set BENCH_SOURCE to a video file');

async function drag(window, box, fromX, toX, steps) {
  const y = box.y + 8; // Inside the ruler.
  await window.mouse.move(box.x + fromX, y);
  await window.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await window.mouse.move(box.x + fromX + ((toX - fromX) * i) / steps, y);
    await window.waitForTimeout(16);
  }
  await window.mouse.up();
}

async function main() {
  if (!process.env.SKIP_BUILD) {
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot });
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile-scrub')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined },
  });

  let ok = true;
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ dialog }, video) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] });
    }, source);
    await window.getByRole('button', { name: 'Import' }).click();
    const name = source.split(/[\\/]/).pop();
    await window.getByText(name, { exact: false }).first().waitFor({ timeout: 120_000 });
    const row = window.locator('li').filter({ hasText: name }).first();
    await row.hover();
    await row.getByTitle(/Add at the playhead/).click();
    await window.waitForTimeout(4000); // Audio decode.

    const canvas = window.locator('canvas').last();
    const box = await canvas.boundingBox();

    const results = {};
    for (const mode of ['seek only', 'forward decoder']) {
      await window.evaluate((noDecoder) => {
        window.__scfNoScrubDecoder = noDecoder;
        window.__scfViewportStats = { draws: 0, exact: 0 };
        window.__scfScrubStats = { grains: 0 };
      }, mode === 'seek only');

      // Start somewhere in the middle, let it settle, then drag. Width 600 px
      // over ~3 s: about 2 frames per move at this zoom, a brisk hand.
      const start = 300;
      await drag(window, box, start, start + 1, 1);
      await window.waitForTimeout(600);
      await window.evaluate(() => { window.__scfViewportStats = { draws: 0, exact: 0 }; });
      await drag(window, box, start, start + 600, 180);
      const forward = await window.evaluate(() => ({ ...window.__scfViewportStats }));

      await window.evaluate(() => { window.__scfViewportStats = { draws: 0, exact: 0 }; });
      await drag(window, box, start + 600, start, 180);
      const backward = await window.evaluate(() => ({ ...window.__scfViewportStats }));
      const grains = await window.evaluate(() => window.__scfScrubStats.grains);

      const pct = (s) => `${((100 * s.exact) / Math.max(1, s.draws)).toFixed(0)}% of ${s.draws} draws`;
      console.log(`${mode.padEnd(16)} forward: exact frame ${pct(forward)}; backward: ${pct(backward)}; audio grains ${grains}`);
      results[mode] = { forward, backward, grains };
    }

    const f = results['forward decoder'];
    const s = results['seek only'];
    const rate = (x) => x.exact / Math.max(1, x.draws);
    ok = rate(f.forward) > rate(s.forward) && rate(f.backward) >= rate(s.backward) * 0.8 && f.grains > 20;
  } finally {
    await app.close().catch(() => undefined);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
