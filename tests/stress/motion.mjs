import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Is the motion actually smooth?
 *
 *   node tests/stress/motion.mjs            (SKIP_BUILD=1 to reuse dist)
 *
 * Not "does it animate" - the other suites cover that - but whether the frames
 * arrive evenly while it does. A frame sampler runs in the page and records
 * every animation frame; each scenario is judged on the gaps between them,
 * because that is what a person sees as stutter. The hard cases are the ones
 * where the main thread is already busy: opening dialogs while video plays, and
 * swapping the whole screen between the start screen and an hour-long timeline.
 */

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workDir = join(projectRoot, '.stress-tmp', 'motion');
const profileDir = join(workDir, 'profile');
const projectsDir = join(workDir, 'Projects');
const reportFile = join(workDir, 'report.json');

/** A frame later than this, mid-animation, is a stutter a person notices. */
const LONG_FRAME_MS = 50;
/** Anything past this is a freeze, not a stutter. */
const FREEZE_MS = 150;

const report = { checks: [], scenarios: {} };
const checks = report.checks;
const check = (name, passed, detail = '') => {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const step = (label) => console.log(`\n== ${label}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(projectsDir, { recursive: true });

  const source = process.env.BENCH_SOURCE || join(workDir, 'pattern.mp4');
  if (!process.env.BENCH_SOURCE) {
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
    ]);
  }

  if (!process.env.SKIP_BUILD) {
    step('building');
    await run(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot });
  }

  const issues = [];
  const app = await electron.launch({
    args: [`--user-data-dir=${profileDir}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_NO_CLOSE_PROMPT: '1' },
  });
  const window = await app.firstWindow();
  window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
  window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 950));
  await window.waitForSelector('#root > *', { timeout: 30_000 });

  const home = () => window.getByRole('main', { name: 'Start screen' });

  /**
   * Run `action` with the frame sampler recording, and report the gaps.
   *
   * The app runs with vsync off (it makes exports three times faster), so
   * frames are not paced to the display and the gaps are small; what matters
   * here is the long ones, which are the main thread being blocked.
   */
  const sampler = async (name, action, settleMs = 400) => {
    await window.evaluate(() => {
      window.__scfFrames = [];
      if (!window.__scfSampling) {
        window.__scfSampling = true;
        const tick = (time) => {
          window.__scfFrames.push(time);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    });
    await sleep(120);
    await window.evaluate(() => { window.__scfFrames.length = 0; });
    const began = Date.now();
    await action();
    await sleep(settleMs);
    const times = await window.evaluate(() => window.__scfFrames.slice());

    const gaps = [];
    for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
    const result = {
      frames: times.length,
      elapsedMs: Date.now() - began,
      p50: Number(percentile(gaps, 50).toFixed(1)),
      p95: Number(percentile(gaps, 95).toFixed(1)),
      worst: Number((gaps.length ? Math.max(...gaps) : 0).toFixed(1)),
      long: gaps.filter((gap) => gap > LONG_FRAME_MS).length,
      freezes: gaps.filter((gap) => gap > FREEZE_MS).length,
    };
    report.scenarios[name] = result;
    return result;
  };

  const describe = (r) => `p50 ${r.p50} ms, p95 ${r.p95} ms, worst ${r.worst} ms, ${r.long} long / ${r.freezes} freezes over ${r.frames} frames`;

  try {
    /* What the browser gives us -------------------------------------------- */
    step('the platform');
    const platform = await window.evaluate(() => ({
      viewTransitions: typeof document.startViewTransition === 'function',
      linearEasing: CSS.supports('animation-timing-function', 'linear(0, 0.5, 1)'),
      waapi: typeof document.body.animate === 'function',
    }));
    check('the browser has view transitions, linear() springs and the animations API',
      platform.viewTransitions && platform.linearEasing && platform.waapi, JSON.stringify(platform));

    /* A project to move around ---------------------------------------------- */
    step('setting up a project with footage');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, projectsDir);
    await window.getByRole('button', { name: 'Change', exact: true }).click();
    await window.getByLabel('Project name').fill('Motion');
    await window.getByRole('button', { name: 'Create project' }).click();
    await home().waitFor({ state: 'detached', timeout: 15_000 });

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, source);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.locator('li').filter({ hasText: source.split(/[\\/]/).pop() }).first().waitFor({ state: 'visible', timeout: 300_000 });
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const asset = store.assets[store.assets.length - 1];
      const length = Math.max(60, Math.min(asset.durationFrames || 300, 600));
      store.placeAssets([asset], [{ assetId: asset.id, trackId: null, trackType: 'video', startFrame: 0, durationFrames: length }]);
    });
    await window.keyboard.press('Control+s');
    await sleep(1200);

    /* The animations themselves --------------------------------------------- */
    step('what the animations are made of');
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await sleep(60);
    const dialogMotion = await window.locator('.scf-dialog').evaluate((element) => {
      const style = getComputedStyle(element);
      return { easing: style.animationTimingFunction, duration: style.animationDuration, name: style.animationName };
    });
    await window.keyboard.press('Escape');
    await sleep(300);
    check('dialogs ride a real spring, not a fixed curve',
      dialogMotion.easing.startsWith('linear(') && dialogMotion.duration === '0.42s',
      `${dialogMotion.duration} ${dialogMotion.easing.slice(0, 40)}...`);

    const barTransition = await window.evaluate(() => {
      const bar = document.querySelector('.scf-progress-bar');
      return bar ? getComputedStyle(bar).transitionProperty : 'no bar on screen';
    });

    /* Scenarios -------------------------------------------------------------- */
    step('dialogs, 15 times');
    const dialogs = await sampler('dialogs', async () => {
      for (let i = 0; i < 15; i += 1) {
        await window.getByRole('button', { name: i % 2 ? 'Mixer' : 'Settings', exact: true }).click();
        await sleep(220);
        await window.keyboard.press('Escape');
        await sleep(180);
      }
    });
    check('opening and closing dialogs never drops a frame', dialogs.freezes === 0 && dialogs.p95 < 35, describe(dialogs));

    step('context menus, 20 times');
    const menus = await sampler('menus', async () => {
      const target = window.getByText('Video 1', { exact: true }).first();
      for (let i = 0; i < 20; i += 1) {
        await target.click({ button: 'right' });
        await sleep(140);
        await window.keyboard.press('Escape');
        await sleep(90);
      }
    });
    check('menus open smoothly every time', menus.freezes === 0 && menus.p95 < 35, describe(menus));

    step('the media library rearranging, 10 times');
    const library = await sampler('library', async () => {
      for (let i = 0; i < 10; i += 1) {
        await window.getByRole('button', { name: 'Import', exact: true }).hover();
        await window.evaluate(() => {
          const store = window.__scfStore.getState();
          store.setCurrentBin(null);
        });
        await sleep(120);
      }
    });
    check('the media list rearranges without a stutter', library.freezes === 0, describe(library));

    step('start screen and back, 6 times');
    const swaps = await sampler('viewSwap', async () => {
      for (let i = 0; i < 6; i += 1) {
        await window.getByRole('button', { name: 'Home', exact: true }).click();
        await home().waitFor({ state: 'visible', timeout: 10_000 });
        await sleep(350);
        await window.getByRole('button', { name: 'Open Motion', exact: true }).click();
        await home().waitFor({ state: 'detached', timeout: 20_000 });
        await sleep(350);
      }
    }, 600);
    check('swapping between the start screen and the editor stays smooth',
      swaps.freezes <= 6 && swaps.p95 < 40, describe(swaps));

    step('the search filtering cards');
    await window.getByRole('button', { name: 'Home', exact: true }).click();
    await home().waitFor({ state: 'visible', timeout: 10_000 });
    const search = await sampler('search', async () => {
      const box = window.getByLabel('Search projects');
      if ((await box.count()) === 0) return;
      for (const text of ['M', 'Mo', 'Mot', 'Moti', 'Motion', 'Motio', 'Mot', 'M', '']) {
        await box.fill(text);
        await sleep(120);
      }
    });
    check('typing in the search never janks the cards', search.freezes === 0, describe(search));
    await window.getByRole('button', { name: 'Open Motion', exact: true }).click();
    await home().waitFor({ state: 'detached', timeout: 20_000 });

    step('the hard one: animating while the video plays');
    const playing = await sampler('whilePlaying', async () => {
      await window.evaluate(() => window.__scfStore.getState().setPlaying(true));
      await sleep(400);
      for (let i = 0; i < 6; i += 1) {
        await window.getByRole('button', { name: 'Settings', exact: true }).click();
        await sleep(260);
        await window.keyboard.press('Escape');
        await sleep(200);
      }
      await window.evaluate(() => window.__scfStore.getState().setPlaying(false));
    });
    check('dialogs stay smooth even while the preview is playing', playing.freezes === 0 && playing.p95 < 45, describe(playing));

    /* The details that make it smooth ---------------------------------------- */
    step('what is being animated');
    const properties = await window.evaluate(() => {
      // Anything animating a layout property repaints the whole panel each frame.
      const layoutish = /\b(width|height|top|left|right|bottom|margin|padding)\b/;
      const offenders = [];
      for (const element of document.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        const property = style.transitionProperty;
        if (property && property !== 'none' && property !== 'all' && layoutish.test(property)) {
          offenders.push(`${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}: ${property}`);
        }
      }
      return offenders.slice(0, 6);
    });
    check('nothing on screen animates a layout property', properties.length === 0,
      properties.length ? properties.join(' | ') : `progress bar transitions ${barTransition}`);

    step('reduced motion');
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await sleep(60);
    const reduced = await window.locator('.scf-dialog').evaluate((element) => getComputedStyle(element).animationDuration);
    await window.keyboard.press('Escape');
    await sleep(200);
    const reducedSwap = await window.evaluate(() => {
      const sheet = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
      return sheet.some((rule) => String(rule.cssText).includes('view-transition-old(*)'));
    });
    check('reduced motion turns off the animations and the view transition', reduced === '0.001s' && reducedSwap,
      `${reduced}, view-transition rule ${reducedSwap}`);
    await window.emulateMedia({ reducedMotion: 'no-preference' });

    check('no errors in the console or the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } catch (error) {
    check('the run completed', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
    await window.screenshot({ path: join(workDir, 'failure.png') }).catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }

  await writeFile(reportFile, JSON.stringify(report, null, 2));
  const failures = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failures.length}/${checks.length} motion checks passed`);
  for (const [name, result] of Object.entries(report.scenarios)) {
    console.log(`  ${name.padEnd(12)} ${describe(result)}`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
