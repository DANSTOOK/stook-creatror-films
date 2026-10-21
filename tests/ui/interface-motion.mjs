import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * How the editor answers, in the running app: `node tests/ui/interface-motion.mjs`
 *
 *   1. An empty edit says how to start - in the viewer, with an Import
 *      button that imports, and over the timeline's tracks - and both go
 *      once there is a clip.
 *   2. The viewer's clock reads "position / length", each with its hint.
 *   3. Every visible button answers a press: a transform in its transition.
 *   4. The zoom buttons ease: the scale passes through values between, and
 *      the playhead stays where it is on screen all the way.
 *   5. In a half-screen window the library and the inspector open as drawers
 *      over the picture - which keeps its size - and go with Escape or a
 *      click outside.
 *
 * Needs a build (npm run build). The window is never shown. Screenshots go
 * to INTERFACE_SHOTS when it is set.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'interface-motion');
const shotsDir = process.env.INTERFACE_SHOTS ?? '';
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
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  const shot = async (window, name) => {
    if (shotsDir) await window.screenshot({ path: join(shotsDir, name) }).catch(() => undefined);
  };
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    const size = (w, h) => app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [w, h]);
    await size(1600, 1000);
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await sleep(600);

    console.log('1. an empty edit');
    const emptyViewer = await window.getByTestId('viewer-empty').isVisible().catch(() => false);
    const emptyTimeline = await window.getByTestId('timeline-empty').isVisible().catch(() => false);
    const viewerText = emptyViewer ? (await window.getByTestId('viewer-empty').innerText()).replace(/\s+/g, ' ') : '';
    check('the viewer and the timeline say how to start', emptyViewer && emptyTimeline && /Add media/.test(viewerText), viewerText);
    await shot(window, 'empty.png');
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    // Watch the bar along the top while the import runs.
    await window.evaluate(() => {
      const bar = document.querySelector('[data-testid="activity-bar"]');
      window.__busySeen = [bar?.dataset.busy];
      new MutationObserver(() => window.__busySeen.push(bar.dataset.busy)).observe(bar, { attributes: true, attributeFilter: ['data-busy'] });
    });
    await window.getByTestId('viewer-empty-import').click();
    const imported = await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    check('its Import button imports', imported);
    await sleep(1500);
    const busySeen = await window.evaluate(() => window.__busySeen);
    check('the bar along the top shows while the import runs, and goes after', busySeen[0] === 'false' && busySeen.includes('true') && busySeen.at(-1) === 'false', busySeen.join(' -> '));
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = s.addAssetToTimeline(s.assets[0], track.id, 0);
      s.selectClips([id]);
      s.setCurrentFrame(150);
    });
    await sleep(500);
    const goneViewer = await window.getByTestId('viewer-empty').count();
    const goneTimeline = await window.getByTestId('timeline-empty').count();
    check('both go once there is a clip', goneViewer === 0 && goneTimeline === 0);

    console.log('2. the clock');
    const clock = await window.evaluate(() => {
      const now = document.querySelector('[data-testid="viewer-timecode"]');
      const length = document.querySelector('[data-testid="viewer-length"]');
      return { now: now?.textContent, nowHint: now?.getAttribute('title') ?? now?.closest('[title]')?.getAttribute('title'), length: length?.textContent, between: now?.nextElementSibling?.textContent?.trim() };
    });
    check('it reads "position / length", each with its hint', clock.between === '/' && /05:00$/.test(clock.now ?? '') && /20:00$/.test(clock.length ?? '') && Boolean(clock.nowHint), JSON.stringify(clock));

    console.log('3. presses');
    const still = await window.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((b) => b.getBoundingClientRect().width > 0)
        .filter((b) => {
          const property = getComputedStyle(b).transitionProperty;
          return !(property.includes('transform') || property === 'all');
        })
        .map((b) => b.getAttribute('aria-label') || b.getAttribute('data-testid') || b.textContent.trim().slice(0, 16)),
    );
    check('every visible button answers a press', still.length === 0, still.join(' | '));

    console.log('4. zoom');
    await window.evaluate(() => window.__scfStore.getState().setUi({ pixelsPerFrame: 2, scrollLeftPx: 0 }));
    await sleep(300);
    const zoom = await window.evaluate(async () => {
      const store = window.__scfStore;
      const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Zoom in' || b.textContent.trim() === 'Zoom in' || /Zoom in/.test(b.getAttribute('data-tip') ?? ''));
      const playheadX = () => {
        const { ui, project } = store.getState();
        return project.currentFrame * ui.pixelsPerFrame - ui.scrollLeftPx;
      };
      const start = { ppf: store.getState().ui.pixelsPerFrame, x: playheadX() };
      const samples = [];
      (button ?? document.querySelector('[aria-label="Zoom in"]'))?.click();
      const begun = performance.now();
      while (performance.now() - begun < 400) {
        await new Promise((r) => requestAnimationFrame(r));
        samples.push({ ppf: store.getState().ui.pixelsPerFrame, x: playheadX() });
      }
      return { found: Boolean(button), start, samples };
    });
    const end = zoom.samples.at(-1);
    const between = zoom.samples.filter((s) => s.ppf > zoom.start.ppf + 1e-6 && s.ppf < end.ppf - 1e-6).length;
    const drift = Math.max(...zoom.samples.map((s) => Math.abs(s.x - zoom.start.x)));
    check('Zoom in eases: it passes through values between, and ends 1.4x closer', zoom.found && between >= 3 && Math.abs(end.ppf / zoom.start.ppf - 1.4) < 0.01,
      `${between} frames between ${zoom.start.ppf} and ${end.ppf.toFixed(2)}`);
    check('the playhead stays where it is on screen all the way', drift <= 1, `moved at most ${drift.toFixed(2)} px`);

    console.log('5. a half-screen window');
    await size(960, 1000);
    await sleep(800);
    const viewerWidth = () => window.evaluate(() => Math.round(document.querySelector('[data-testid="preview-panel"]').getBoundingClientRect().width));
    const wide = await viewerWidth();
    const folded = await window.evaluate(() => !document.querySelector('[data-panel="media"][data-state="open"]'));
    await window.keyboard.press('Control+1');
    await sleep(500);
    const drawer = await window.evaluate(() => {
      const panel = document.querySelector('[data-panel="media"][data-drawer="true"]');
      const r = panel?.getBoundingClientRect();
      return { shown: Boolean(panel), left: r ? Math.round(r.left) : null, width: r ? Math.round(r.width) : null, scrim: Boolean(document.querySelector('[data-testid="drawer-scrim"]')) };
    });
    const withDrawer = await viewerWidth();
    check('the library opens as a drawer over the picture, which keeps its size', folded && drawer.shown && drawer.scrim && Math.abs(withDrawer - wide) <= 1,
      `viewer ${wide} -> ${withDrawer}px, drawer ${drawer.width}px at ${drawer.left}`);
    await shot(window, 'drawer-960.png');
    await window.keyboard.press('Escape');
    await sleep(400);
    const afterEscape = await window.evaluate(() => Boolean(document.querySelector('[data-panel][data-drawer="true"]')));
    await window.keyboard.press('Control+4');
    await sleep(400);
    const inspectorDrawer = await window.evaluate(() => Boolean(document.querySelector('[data-panel="inspector"][data-drawer="true"]')));
    await window.getByTestId('drawer-scrim').click({ position: { x: 20, y: 20 } });
    await sleep(400);
    const afterScrim = await window.evaluate(() => Boolean(document.querySelector('[data-panel][data-drawer="true"]')));
    check('Escape puts it away; the inspector opens the same way, and a click outside puts it away', !afterEscape && inspectorDrawer && !afterScrim,
      `after Escape ${afterEscape}, inspector ${inspectorDrawer}, after click ${afterScrim}`);
    await size(1600, 1000);
    await sleep(500);
    const docked = await window.evaluate(() => Boolean(document.querySelector('[data-panel="media"][data-state="open"]')) && !document.querySelector('[data-drawer="true"]'));
    check('wide again, the panels are docked as before', docked);

    console.log('6. tabs, cuts and the playhead');
    await window.getByTestId('library-tab-titles').click();
    const tabAnimates = await window.evaluate(() => {
      const panel = document.getElementById('library-tabpanel');
      return panel.classList.contains('scf-tab-enter') && panel.getAnimations().length > 0;
    });
    await window.getByTestId('library-tab-media').click();
    check('the content of a new tab comes in with a fade', tabAnimates);
    await window.getByTestId('library-tab-effects').hover();
    await sleep(200);
    const labelShown = await window.evaluate(() => document.querySelector('[data-testid="library-tab-effects"] .library-tab-label').getBoundingClientRect().width > 20);
    check('a library tab pointed at says its name', labelShown);
    await window.mouse.move(800, 20);

    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setUi({ pixelsPerFrame: 2, scrollLeftPx: 0 });
      s.razorAtFrame(120);
    });
    await sleep(60);
    const flashing = await window.getByTestId('cut-flash').count();
    await sleep(700);
    const flashGone = await window.getByTestId('cut-flash').count();
    check('a razor cut flashes on its track, and the flash goes', flashing === 1 && flashGone === 0, `${flashing} then ${flashGone}`);

    const ruler = await window.getByTestId('timeline-canvas').boundingBox();
    await window.mouse.move(ruler.x + 300, ruler.y + 10);
    await window.mouse.down();
    await window.mouse.move(ruler.x + 360, ruler.y + 10, { steps: 4 });
    const chip = await window.getByTestId('scrub-time').innerText().catch(() => '');
    const chipFrame = await window.evaluate(() => window.__scfStore.getState().project.currentFrame);
    await window.mouse.up();
    await sleep(150);
    const chipGone = await window.getByTestId('scrub-time').count();
    check('dragging the playhead shows where it is above it, and the chip goes on letting go', /^\d\d:\d\d:\d\d:\d\d$/.test(chip.trim()) && chipFrame === 180 && chipGone === 0, `"${chip.trim()}" at frame ${chipFrame}, ${chipGone} left after letting go`);

    // A sound coming in: a skeleton where its waveform will be, while it is read.
    const tone = join(work, 'tone.wav');
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=600', '-ar', '48000', '-ac', '2', tone]);
    await window.getByTestId('library-tab-media').click();
    await window.evaluate(() => {
      window.__skeletonSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="asset-skeleton"]')) window.__skeletonSeen = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [tone]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    // Its waveform is read when it is first played or put on the timeline.
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const audio = s.project.tracks.find((t) => t.type === 'audio');
      s.addAssetToTimeline(s.assets.find((a) => a.kind === 'audio'), audio.id, 0);
    });
    const settled = await window.waitForFunction(() => !document.querySelector('[data-testid="asset-skeleton"]') && document.querySelector('svg rect[fill="#a7f3d0"]'), null, { timeout: 60_000 }).then(() => true).catch(() => false);
    const skeletonSeen = await window.evaluate(() => window.__skeletonSeen);
    check('a sound being read shows a skeleton where its waveform goes, then the waveform', skeletonSeen && settled, `skeleton seen ${skeletonSeen}, waveform drawn ${settled}`);

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
