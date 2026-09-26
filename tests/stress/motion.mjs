import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Is the motion actually smooth, and does it stay out of the way?
 *
 *   node tests/stress/motion.mjs            (SKIP_BUILD=1 to reuse dist)
 *
 * Not "does it animate" - the other suites cover that - but whether the frames
 * arrive evenly while it does. A frame sampler runs in the page and records
 * every animation frame; each scenario is judged on the gaps between them,
 * because that is what a person sees as stutter:
 *
 * - DROPPED frames against the display's real refresh (measured at the start:
 *   a gap longer than 1.5 refreshes is a frame that was not drawn);
 * - LONG ANIMATION FRAMES from the browser's own Long Animation Frames API,
 *   which says when the main thread held a frame up for more than 50 ms;
 * - freezes (a gap over 150 ms).
 *
 * The hard cases are the ones where the main thread is already busy: opening
 * dialogs while video plays, zooming the timeline during playback, swapping the
 * whole screen, and a render. It also checks the motion system's promises:
 * what the curves are made of, that a dialog reopened mid-exit turns round
 * instead of stacking, that nothing decorative runs (and nothing is blurred)
 * while the video plays or a render runs, and what reduced motion does.
 *
 * Runs off-screen (SCF_BACKGROUND=1, the default here): the window paints at
 * the display's rate without appearing or taking the focus.
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

const report = { checks: [], scenarios: {}, refreshMs: null };
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

/** Project settings: File > Project settings, from the title bar's menu button. */
async function openSettingsIn(window) {
  await window.getByTestId('app-menu-button').click();
  await window.getByRole('menuitem', { name: 'File', exact: true }).click();
  await window.getByRole('menuitem', { name: /^Project settings/ }).click();
}

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
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const window = await app.firstWindow();
  window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
  window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 950));
  await window.waitForSelector('#root > *', { timeout: 30_000 });

  const home = () => window.getByRole('main', { name: 'Start screen' });

  // Every frame, and every long animation frame, from here on.
  await window.evaluate(() => {
    window.__scfFrames = [];
    window.__scfLoaf = [];
    const tick = (time) => {
      window.__scfFrames.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__scfLoaf.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration });
      }).observe({ type: 'long-animation-frame', buffered: false });
      window.__scfLoafSupported = true;
    } catch {
      window.__scfLoafSupported = false;
    }
  });

  /** The display's refresh interval, from a second of idle frames. */
  const measureRefresh = async () => {
    await window.evaluate(() => { window.__scfFrames.length = 0; });
    await sleep(1000);
    const times = await window.evaluate(() => window.__scfFrames.slice());
    const gaps = [];
    for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
    return Number(percentile(gaps, 50).toFixed(2));
  };

  /** Run `action` with the frames recorded, and judge the gaps. */
  const sampler = async (name, action, settleMs = 400) => {
    await sleep(120);
    await window.evaluate(() => {
      window.__scfFrames.length = 0;
      window.__scfLoaf.length = 0;
    });
    const began = Date.now();
    await action();
    await sleep(settleMs);
    const { times, loaf } = await window.evaluate(() => ({ times: window.__scfFrames.slice(), loaf: window.__scfLoaf.slice() }));

    const gaps = [];
    for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
    const refresh = report.refreshMs ?? 16.7;
    // Frames that should have been drawn in the gaps and were not.
    const dropped = gaps.reduce((sum, gap) => sum + (gap > refresh * 1.5 ? Math.round(gap / refresh) - 1 : 0), 0);
    const expected = gaps.length + dropped;
    const result = {
      frames: times.length,
      elapsedMs: Date.now() - began,
      p50: Number(percentile(gaps, 50).toFixed(1)),
      p95: Number(percentile(gaps, 95).toFixed(1)),
      p99: Number(percentile(gaps, 99).toFixed(1)),
      worst: Number((gaps.length ? Math.max(...gaps) : 0).toFixed(1)),
      dropped,
      droppedPct: Number(((dropped / Math.max(1, expected)) * 100).toFixed(2)),
      long: gaps.filter((gap) => gap > LONG_FRAME_MS).length,
      freezes: gaps.filter((gap) => gap > FREEZE_MS).length,
      loaf: loaf.length,
      loafWorst: Number((loaf.length ? Math.max(...loaf.map((entry) => entry.duration)) : 0).toFixed(1)),
      loafBlocking: Number(loaf.reduce((sum, entry) => sum + (entry.blocking || 0), 0).toFixed(1)),
    };
    report.scenarios[name] = result;
    return result;
  };

  const describe = (r) =>
    `p50 ${r.p50} ms, p95 ${r.p95} ms, p99 ${r.p99} ms, worst ${r.worst} ms, dropped ${r.dropped} (${r.droppedPct}%), ` +
    `${r.loaf} long animation frames (worst ${r.loafWorst} ms), ${r.freezes} freezes over ${r.frames} frames`;

  /** Custom properties as the page resolved them (the tokens). */
  const token = (name) => window.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);
  /** '440ms' or '.44s' -> '0.44s', the form getComputedStyle reports durations in. */
  const asSeconds = (value) => `${Number((Number.parseFloat(value) / (value.endsWith('ms') ? 1000 : 1)).toFixed(3))}s`;

  /** What runs now that nobody asked for: endless animations other than a spinner. */
  const decorativeRunning = () => window.evaluate(() => document.getAnimations()
    .filter((animation) => animation.playState === 'running')
    .filter((animation) => {
      const name = animation.animationName ?? '';
      const endless = animation.effect?.getComputedTiming?.().iterations === Infinity;
      return (endless && !/spin|ping/.test(name)) || /scf-drift|scf-pulse-dot/.test(name);
    })
    .map((animation) => `${animation.animationName ?? 'script'} on ${animation.effect?.target?.className?.toString().split(' ')[0] ?? '?'}`));

  try {
    /* What the browser gives us -------------------------------------------- */
    step('the platform');
    const platform = await window.evaluate(() => ({
      viewTransitions: typeof document.startViewTransition === 'function',
      linearEasing: CSS.supports('animation-timing-function', 'linear(0, 0.5, 1)'),
      waapi: typeof document.body.animate === 'function',
      startingStyle: typeof window.CSSStartingStyleRule === 'function',
      longAnimationFrames: window.__scfLoafSupported,
    }));
    check('the browser has view transitions, linear() springs, @starting-style, WAAPI and the Long Animation Frames API',
      platform.viewTransitions && platform.linearEasing && platform.waapi && platform.startingStyle && platform.longAnimationFrames,
      JSON.stringify(platform));
    report.refreshMs = await measureRefresh();
    check('the window paints at the display rate while off-screen', report.refreshMs > 0 && report.refreshMs < 20,
      `${report.refreshMs} ms a frame (${Math.round(1000 / report.refreshMs)} Hz)`);

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
    const tokens = {
      dialogMove: asSeconds(await token('--settle-emphasis-bounce')),
      fade: asSeconds(await token('--settle-standard')),
      menuMove: asSeconds(await token('--settle-standard-bounce')),
      menuFade: asSeconds(await token('--settle-quick')),
      exit: asSeconds(await token('--dur-exit')),
      bouncy: await token('--spring-emphasis-bounce'),
    };
    const overshoot = Math.max(...tokens.bouncy.replace(/^linear\(|\)$/g, '').split(',').map((point) => Number.parseFloat(point)));
    await openSettingsIn(window);
    await sleep(60);
    const dialogMotion = await window.locator('.scf-dialog').evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, easing: style.transitionTimingFunction, duration: style.transitionDuration };
    });
    const closeStarted = Date.now();
    await window.keyboard.press('Escape');
    await window.locator('.scf-dialog').waitFor({ state: 'detached', timeout: 2_000 });
    const closeMs = Date.now() - closeStarted;
    check('dialogs ride a spring with the bounce: a transition on transform and opacity, the fade flat',
      dialogMotion.property === 'opacity, transform'
        && dialogMotion.easing.split('linear(').length === 3
        && dialogMotion.duration === `${tokens.fade}, ${tokens.dialogMove}`
        && overshoot > 1.01 && overshoot < 1.05,
      `${dialogMotion.property} over ${dialogMotion.duration}; the move overshoots ${((overshoot - 1) * 100).toFixed(1)}%`);
    check('a dialog is gone soon after Escape: the exit is short and never waited on',
      closeMs < 400, `${closeMs} ms to leave the page, exit ${tokens.exit}`);

    await window.getByText('Video 1', { exact: true }).first().click({ button: 'right' });
    await sleep(40);
    const menuMotion = await window.getByRole('menu').evaluate((element) => {
      const style = getComputedStyle(element);
      return { duration: style.transitionDuration, origin: style.transformOrigin, blur: style.backdropFilter };
    });
    await window.keyboard.press('Escape');
    const menuGone = await window.getByRole('menu').count();
    const menuGhosts = await window.evaluate(() => (window.__scfMotion?.ghostCount() ?? 0));
    await sleep(300);
    const ghostsAfter = await window.evaluate(() => (window.__scfMotion?.ghostCount() ?? 0));
    check('menus grow out of the click on a spring, and leave the page at once while their ghost fades',
      menuMotion.duration === `${tokens.menuFade}, ${tokens.menuMove}` && menuGone === 0 && menuGhosts >= 1 && ghostsAfter === 0,
      `${menuMotion.duration} from ${menuMotion.origin}; menus left ${menuGone}, ghosts ${menuGhosts} then ${ghostsAfter}`);

    /* Scenarios -------------------------------------------------------------- */
    step('dialogs, 15 times');
    const dialogs = await sampler('dialogs', async () => {
      for (let i = 0; i < 15; i += 1) {
        if (i % 2) await window.getByRole('button', { name: 'Mixer', exact: true }).click();
        else await openSettingsIn(window);
        await sleep(220);
        await window.keyboard.press('Escape');
        await sleep(180);
      }
    });
    check('opening and closing dialogs never drops a frame', dialogs.freezes === 0 && dialogs.p95 < 35 && dialogs.loafWorst < 100, describe(dialogs));

    step('interrupted: a dialog reopened mid-exit, 20 times');
    const interrupted = await sampler('interrupted', async () => {
      await openSettingsIn(window);
      for (let i = 0; i < 20; i += 1) {
        await window.keyboard.press('Escape');
        await sleep(20 + (i % 4) * 15);
        await openSettingsIn(window);
      }
      await sleep(200);
    });
    const afterStorm = await window.evaluate(() => ({
      dialogs: document.querySelectorAll('.scf-dialog').length,
      overlays: document.querySelectorAll('.scf-overlay').length,
      closing: document.querySelectorAll('.scf-dialog[data-closing="true"]').length,
      opacity: Number(getComputedStyle(document.querySelector('.scf-dialog')).opacity),
    }));
    await window.keyboard.press('Escape');
    await window.locator('.scf-dialog').waitFor({ state: 'detached', timeout: 2_000 });
    check('a dialog reopened while it was leaving turns round: one dialog, fully shown, nothing stacked',
      afterStorm.dialogs === 1 && afterStorm.overlays === 1 && afterStorm.closing === 0 && afterStorm.opacity === 1,
      `${JSON.stringify(afterStorm)}; ${describe(interrupted)}`);

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
    check('menus open smoothly every time', menus.freezes === 0 && menus.p95 < 35 && menus.loafWorst < 100, describe(menus));

    step('tooltips along the title bar');
    const tips = await sampler('tooltips', async () => {
      for (const id of ['toggle-media', 'toggle-timeline', 'toggle-inspector', 'notifications-button']) {
        await window.getByTestId(id).hover();
        await sleep(id === 'toggle-media' ? 650 : 120);
      }
      await window.mouse.move(800, 400);
    });
    check('tooltips come and go without a stutter', tips.freezes === 0 && tips.p95 < 35, describe(tips));

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
    const quietWhilePlaying = {};
    const playing = await sampler('whilePlaying', async () => {
      await window.evaluate(() => window.__scfStore.getState().setPlaying(true));
      await sleep(400);
      for (let i = 0; i < 6; i += 1) {
        await openSettingsIn(window);
        await sleep(260);
        if (i === 0) {
          quietWhilePlaying.flag = await window.evaluate(() => document.documentElement.hasAttribute('data-playing'));
          quietWhilePlaying.blur = await window.locator('.scf-overlay').evaluate((element) => getComputedStyle(element).backdropFilter);
          quietWhilePlaying.decorative = await decorativeRunning();
        }
        await window.keyboard.press('Escape');
        await sleep(200);
      }
      await window.evaluate(() => window.__scfStore.getState().setPlaying(false));
    });
    check('dialogs stay smooth even while the preview is playing', playing.freezes === 0 && playing.p95 < 45, describe(playing));
    check('while it plays, nothing is blurred and nothing decorative runs',
      quietWhilePlaying.flag && quietWhilePlaying.blur === 'none' && quietWhilePlaying.decorative.length === 0,
      `data-playing ${quietWhilePlaying.flag}, backdrop ${quietWhilePlaying.blur}, decorative [${quietWhilePlaying.decorative.join(', ')}]`);
    await openSettingsIn(window);
    await sleep(80);
    const pausedBlur = await window.locator('.scf-overlay').evaluate((element) => getComputedStyle(element).backdropFilter);
    await window.keyboard.press('Escape');
    await window.locator('.scf-dialog').waitFor({ state: 'detached', timeout: 2_000 });
    check('paused, the blur behind a dialog is back', pausedBlur.startsWith('blur('), pausedBlur);

    /* The timeline zoom: animated, retargeted per wheel event, cheap -------- */
    // Ctrl+wheel over the timeline canvas, from the page (Playwright's mouse,
    // not the system's): each event moves the target, the canvas eases to it.
    const canvasBox = await window.locator('canvas').last().boundingBox();
    const zoomBurst = async (events, delta) => {
      await window.mouse.move(canvasBox.x + canvasBox.width * 0.4, canvasBox.y + 60);
      await window.keyboard.down('Control');
      for (let i = 0; i < events; i += 1) {
        await window.mouse.wheel(0, delta);
        await sleep(16);
      }
      await window.keyboard.up('Control');
    };
    const zoomState = () => window.evaluate(() => ({
      ppf: window.__scfStore.getState().ui.pixelsPerFrame,
      drawn: window.__scfMotion?.zoomStats?.frames ?? 0,
    }));

    step('timeline zoom with the wheel and a pinch, paused');
    const zoomBefore = await zoomState();
    let afterNotch = null;
    const zoomPaused = await sampler('zoomPaused', async () => {
      await window.mouse.move(canvasBox.x + canvasBox.width * 0.4, canvasBox.y + 60);
      await window.keyboard.down('Control');
      await window.mouse.wheel(0, -100);
      afterNotch = await zoomState();
      await window.keyboard.up('Control');
      await sleep(250);
      // A pinch: forty small events, which the old code took as forty notches.
      await zoomBurst(40, 2.5);
      await sleep(250);
      await zoomBurst(10, 100);
    });
    const zoomAfter = await zoomState();
    const notchRatio = afterNotch.ppf / zoomBefore.ppf;
    check('a wheel notch zooms by 1.25 at once in the store, and the canvas draws the way there',
      Math.abs(notchRatio - 1.25) < 0.01 && zoomAfter.drawn - zoomBefore.drawn >= 10,
      `x${notchRatio.toFixed(3)} straight away; ${zoomAfter.drawn - zoomBefore.drawn} in-between frames drawn`);
    check('zooming the timeline stays smooth', zoomPaused.freezes === 0 && zoomPaused.p95 < 35 && zoomPaused.loafWorst < 100, describe(zoomPaused));

    step('timeline zoom and page-turning while the video plays');
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      store.setCurrentFrame(0);
      store.setUi({ pixelsPerFrame: 60, scrollLeftPx: 0 });
    });
    const scrolls = [];
    const zoomPlaying = await sampler('zoomPlaying', async () => {
      await window.evaluate(() => window.__scfStore.getState().setPlaying(true));
      for (let i = 0; i < 24; i += 1) {
        scrolls.push(await window.evaluate(() => Math.round(window.__scfStore.getState().ui.scrollLeftPx)));
        await sleep(100);
      }
      await zoomBurst(8, -60);
      await sleep(200);
      await zoomBurst(8, 60);
      await sleep(300);
      await window.evaluate(() => window.__scfStore.getState().setPlaying(false));
    });
    const pages = new Set(scrolls).size;
    check('playing past the edge turns the page instead of scrolling continuously',
      pages >= 2 && pages <= 6, `${pages} different scroll positions in 24 readings over 2.4 s: ${[...new Set(scrolls)].join(', ')}`);
    check('zooming while the video plays stays smooth', zoomPlaying.freezes === 0 && zoomPlaying.p95 < 45 && zoomPlaying.loafWorst < 100, describe(zoomPlaying));
    await window.getByRole('button', { name: 'Fit', exact: true }).click().catch(() => undefined);
    await sleep(300);

    /* The progress bar, while it really exists -------------------------------- */
    // It only exists during a render, so the sweep below never saw the one
    // element the change was about: it used to animate its width, laying the
    // dialog out again on every update, dozens of times a second.
    step('rendering, with the progress bar on screen');
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, workDir);
    await window.getByRole('button', { name: 'Export', exact: true }).click();
    const exportDialog = window.getByRole('dialog', { name: 'Export' });
    await exportDialog.getByText('This render:').waitFor({ timeout: 60_000 });
    await exportDialog.getByLabel('File name').fill('motion-export');
    await exportDialog.getByRole('button', { name: 'Browse' }).click();
    await exportDialog.getByText('Will ', { exact: false }).first().waitFor({ timeout: 10_000 });
    await exportDialog.getByLabel('End frame').fill('150');

    let bar = null;
    const whileExporting = {};
    const rendering = await sampler('rendering', async () => {
      await exportDialog.getByRole('button', { name: 'Start export' }).click();
      // Read while it is really moving. A fixed 1.2 s wait missed it once a
      // 150-frame render took under a second (900 ms here): look every 100 ms
      // from 300 ms in, and keep the last reading taken before it finished.
      await sleep(300);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const reading = await window.evaluate(() => {
          const element = document.querySelector('.scf-progress-bar');
          if (!element) return null;
          const style = getComputedStyle(element);
          const overlay = document.querySelector('.scf-overlay');
          return {
            transition: style.transitionProperty,
            transform: style.transform,
            width: style.width,
            exporting: document.documentElement.hasAttribute('data-exporting'),
            blur: overlay ? getComputedStyle(overlay).backdropFilter : 'no overlay',
          };
        });
        if (!reading) break;
        bar = reading;
        if (attempt === 0) whileExporting.decorative = await decorativeRunning();
        await sleep(100);
      }
      await exportDialog.getByText('Export finished', { exact: false }).waitFor({ timeout: 300_000 }).catch(() => undefined);
    }, 300);
    check('the progress bar was on screen to be judged, and it scales rather than resizes',
      bar !== null && bar.transition === 'transform' && bar.transform.startsWith('matrix'),
      bar ? `transition ${bar.transition}, transform ${bar.transform}, width ${bar.width}` : 'no progress bar found');
    check('the picture stays smooth while a render is running', rendering.freezes === 0 && rendering.p95 < 45, describe(rendering));
    check('while it renders, nothing is blurred and nothing decorative runs',
      bar !== null && bar.exporting && bar.blur === 'none' && (whileExporting.decorative ?? []).length === 0,
      bar ? `data-exporting ${bar.exporting}, backdrop ${bar.blur}, decorative [${(whileExporting.decorative ?? []).join(', ')}]` : 'no reading');
    const exportingAfter = await window.evaluate(() => document.documentElement.hasAttribute('data-exporting'));
    check('and the render lets go of it when it ends', !exportingAfter);

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
      properties.length ? properties.join(' | ') : `swept with the progress bar on screen (${bar?.transition ?? 'bar gone'})`);

    await exportDialog.getByTitle('Close').click().catch(() => undefined);
    await exportDialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);

    step('reduced motion');
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(50);
    const reducedFlag = await window.evaluate(() => document.documentElement.getAttribute('data-motion'));
    await openSettingsIn(window);
    await sleep(40);
    const reduced = await window.locator('.scf-dialog').evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, duration: style.transitionDuration, transform: style.transform };
    });
    const reducedStarted = Date.now();
    await window.keyboard.press('Escape');
    await window.locator('.scf-dialog').waitFor({ state: 'detached', timeout: 2_000 });
    const reducedClose = Date.now() - reducedStarted;
    await window.getByText('Video 1', { exact: true }).first().click({ button: 'right' });
    await sleep(30);
    const reducedMenu = await window.getByRole('menu').evaluate((element) => getComputedStyle(element).transform);
    await window.keyboard.press('Escape');
    const reducedSwap = await window.evaluate(() => {
      const sheet = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
      return sheet.some((rule) => String(rule.cssText).includes('view-transition-old(*)'));
    });
    check('reduced motion: 100 ms fades, nothing moves or grows, no view transition',
      reducedFlag === 'reduced'
        && !reduced.property.includes('transform') && reduced.duration.split(', ').every((value) => value === '0.1s')
        && reduced.transform === 'none' && reducedMenu === 'none' && reducedSwap && reducedClose < 400,
      `data-motion ${reducedFlag}; dialog ${reduced.property} over ${reduced.duration}, transform ${reduced.transform}; menu transform ${reducedMenu}; closed in ${reducedClose} ms`);
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
  console.log(`\n${checks.length - failures.length}/${checks.length} motion checks passed (refresh ${report.refreshMs} ms)`);
  for (const [name, result] of Object.entries(report.scenarios)) {
    console.log(`  ${name.padEnd(13)} ${describe(result)}`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
