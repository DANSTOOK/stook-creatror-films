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
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1', SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });

  let ok = true;
  try {
    const window = await app.firstWindow();
    // The scrub decoder says when it gives up on a file; show it, or a file
    // that scrubs on the slow path reads as nothing more than a low number.
    window.on('console', (message) => {
      if (message.text().includes('[scrub]')) console.log(`   page: ${message.text().slice(0, 240)}`);
    });
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

    // The same pace for every file: the first clip added fits the timeline to
    // the view, so a 600 px drag covered 360 frames of a 95-second clip but
    // ~14,000 of a 19-minute one - 80 frames a move, which no decoder follows.
    // Fixed zoom: 600 px is 360 frames, about 2 frames per move, a brisk hand.
    await window.evaluate(() => window.__scfStore.getState().setUi({ pixelsPerFrame: 600 / 360, scrollLeftPx: 0 }));
    await window.waitForTimeout(500);

    const canvas = window.locator('canvas').last();
    const box = await canvas.boundingBox();

    const results = {};
    const playhead = () => window.evaluate(() => window.__scfStore.getState().project.currentFrame);

    /**
     * One drag, measured: settle at `from`, reset the counters, drag to `to`,
     * and check how far the playhead really went. A drag that never moved it
     * reads as 100% exact - a still playhead always is - so it is marked
     * invalid rather than believed.
     */
    // Where the timeline is scrolled, in the store and on the element - a
    // scroll during a drag shifts which frame a pixel means.
    const scroll = () =>
      window.evaluate(() => {
        const stored = Math.round(window.__scfStore.getState().ui.scrollLeftPx);
        const element = [...document.querySelectorAll('div')].find((d) => d.scrollWidth > d.clientWidth + 50 && d.querySelector('canvas'));
        return `${stored}/${element ? Math.round(element.scrollLeft) : '?'} (visible ${element ? element.clientWidth : '?'} px)`;
      });

    const clipCount = () => window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);

    async function pass(from, to) {
      // Put the playhead at `from` with a short drag that starts 20 px away.
      // Pressing ON the playhead in the ruler grabs its scissors, and a press
      // there that does not move is a click - which cuts the clip. The bench
      // did exactly that between passes, and every cut gave the clip a new id
      // and its scrub decoder a fresh, empty set of kept pictures.
      const clipsBefore = await clipCount();
      await drag(window, box, from - 20 * Math.sign(to - from), from, 10);
      await window.waitForTimeout(600);
      const before = await playhead();
      const scrollBefore = await scroll();
      await window.evaluate(() => { window.__scfViewportStats = { draws: 0, exact: 0 }; });
      await drag(window, box, from, to, 180);
      const stats = await window.evaluate(() => ({ ...window.__scfViewportStats }));
      const after = await playhead();
      const scrollAfter = await scroll();
      const cut = (await clipCount()) !== clipsBefore;
      const travelled = (after - before) * Math.sign(to - from);
      return { ...stats, before, after, scrollBefore, scrollAfter, cut, valid: travelled >= 300 && !cut };
    }

    for (const mode of ['seek only', 'forward decoder']) {
      await window.evaluate((noDecoder) => {
        window.__scfNoScrubDecoder = noDecoder;
        window.__scfViewportStats = { draws: 0, exact: 0 };
        window.__scfScrubStats = { grains: 0 };
      }, mode === 'seek only');

      // 600 px over ~3 s at this zoom: about 2 frames per move, a brisk hand.
      const start = 300;
      // Backwards first, over ground this mode has not decoded: settled at the
      // far end, a forward decoder holds only the GOP before it, so most of
      // the way back depends on filling in behind the playhead.
      const fresh = await pass(start + 600, start);
      const forward = await pass(start, start + 600);
      // Then back over what the forward drag just decoded.
      const backward = await pass(start + 600, start);
      const grains = await window.evaluate(() => window.__scfScrubStats.grains);

      const pct = (s) =>
        `${((100 * s.exact) / Math.max(1, s.draws)).toFixed(0)}% of ${s.draws} draws (frame ${s.before} -> ${s.after})${s.valid ? '' : '  INVALID: the playhead did not travel'}`;
      console.log(mode);
      console.log(`   backward, new ground:     ${pct(fresh)}`);
      console.log(`   forward:                  ${pct(forward)}`);
      console.log(`   backward, covered ground: ${pct(backward)}`);
      console.log(`   audio grains:             ${grains}`);
      results[mode] = { fresh, forward, backward, grains };
    }

    const f = results['forward decoder'];
    const s = results['seek only'];
    const rate = (x) => x.exact / Math.max(1, x.draws);
    const valid = [f, s].every((r) => r.fresh.valid && r.forward.valid && r.backward.valid);
    // A source with no sound gives no grains in either mode; only then is
    // zero not a failure.
    const audioOk = f.grains > 20 || s.grains === 0;
    ok = valid && audioOk && rate(f.forward) > rate(s.forward) && rate(f.backward) > rate(s.backward) && rate(f.fresh) >= rate(s.fresh);
  } finally {
    await app.close().catch(() => undefined);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
