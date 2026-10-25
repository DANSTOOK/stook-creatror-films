import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Detach audio, always in sight: `node tests/ui/detach-visible.mjs`
 *
 * A stock or screen video has no sound in it, and the right-click menu used
 * to leave Detach audio out for one - which read as the option having been
 * taken away. Now:
 *
 *   1. right-click a video with no sound: Detach audio is there, dimmed, with
 *      "This video has no sound" under it, readable;
 *   2. right-click a video with sound: Detach audio, and it detaches;
 *   3. the timeline toolbar's button: off with nothing selected, on for a
 *      video clip; pressed on the silent one it says why, on one with sound it
 *      detaches;
 *   4. Ctrl+Alt+S does the same as the button;
 *   5. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'detach-visible');
const logs = join(work, 'logs');
const shots = process.env.DETACH_SHOTS ?? '';
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
  // A video with a tone in it, and one with none at all - as a stock clip is.
  const sound = join(work, 'with-sound.mp4');
  const silent = join(work, 'no-sound.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sound]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', silent]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [sound, silent]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    const flags = await window.evaluate(() => window.__scfStore.getState().assets.map((asset) => `${asset.name}: ${asset.hasAudio}`).join(', '));

    const store = (fn, arg) => window.evaluate(fn, arg);
    /** Two clips of each file on the main track, side by side; their ids by name. */
    const ids = await store(() => {
      const s = window.__scfStore.getState();
      const main = s.project.tracks.find((track) => track.type === 'video' && track.order === 0);
      const of = (name) => s.assets.find((asset) => asset.name === name);
      const placed = {
        silent: s.addAssetToTimeline(of('no-sound.mp4'), main.id, 0),
        sound: s.addAssetToTimeline(of('with-sound.mp4'), main.id, 200),
        silentToo: s.addAssetToTimeline(of('no-sound.mp4'), main.id, 400),
        soundToo: s.addAssetToTimeline(of('with-sound.mp4'), main.id, 600),
      };
      window.__scfStore.getState().setUi({ pixelsPerFrame: 1, scrollLeftPx: 0 });
      window.__scfStore.getState().selectClips([]);
      return placed;
    });
    await sleep(400);
    const surface = window.getByTestId('timeline-canvas');
    const clipPoint = async (id) => {
      const box = await surface.boundingBox();
      const spot = await store((clipId) => {
        const { project, ui } = window.__scfStore.getState();
        const clip = project.clips[clipId];
        const lane = window.__scfTimelineRow(clip.trackId);
        return { x: (clip.startFrame + clip.durationFrames / 2) * ui.pixelsPerFrame - ui.scrollLeftPx, y: lane.top + lane.height / 2 };
      }, id);
      return { x: box.x + spot.x, y: box.y + spot.y };
    };
    /** The open menu's Detach audio item: there, enabled, its note and the note's contrast against the menu. */
    const detachItem = () => window.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => /Detach audio/.test(element.textContent ?? ''));
      if (!item) return null;
      const note = item.querySelector('[data-menu-note]');
      const lum = (color) => {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      let contrast = 0;
      if (note) {
        // The menu panel's own colour is what the note is read against.
        const panel = item.closest('[role="menu"]');
        const fg = lum(getComputedStyle(note).color);
        const bg = lum(getComputedStyle(panel).backgroundColor);
        contrast = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      }
      return { disabled: item.disabled, note: note?.textContent ?? '', contrast: Number(contrast.toFixed(2)), opacity: getComputedStyle(note ?? item).opacity };
    });
    const closeMenu = async () => {
      await window.keyboard.press('Escape');
      await sleep(250);
    };
    const notices = () => window.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"]')].map((element) => element.textContent ?? '').join(' | '));
    const soundClips = () => store(() => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.audioOnly).length);

    /* 1. a video with no sound: there, dimmed, and why ------------------------------------------ */
    let at = await clipPoint(ids.silent);
    await window.mouse.click(at.x, at.y, { button: 'right' });
    await sleep(300);
    const onSilent = await detachItem();
    if (shots) await window.screenshot({ path: join(shots, 'separar-audio-sin-sonido.png') });
    check('a video with no sound: Detach audio is in its menu, dimmed, saying "This video has no sound"',
      onSilent !== null && onSilent.disabled && /no sound/.test(onSilent.note), `${JSON.stringify(onSilent)}; ${flags}`);
    check('and the reason reads at full contrast (4.5:1 or more), not dimmed with the item', onSilent !== null && onSilent.contrast >= 4.5 && onSilent.opacity === '1', JSON.stringify(onSilent));
    await closeMenu();

    /* 2. a video with sound: detaches ----------------------------------------------------------- */
    at = await clipPoint(ids.sound);
    await window.mouse.click(at.x, at.y, { button: 'right' });
    await sleep(300);
    const onSound = await detachItem();
    check('a video with sound: Detach audio, enabled, nothing under it', onSound !== null && !onSound.disabled && onSound.note === '', JSON.stringify(onSound));
    await window.getByRole('menuitem', { name: /Detach audio/ }).click();
    await window.waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).some((clip) => clip.audioOnly), null, { timeout: 30_000 }).catch(() => undefined);
    const afterMenu = await store((id) => {
      const { project } = window.__scfStore.getState();
      const soundClip = Object.values(project.clips).find((clip) => clip.audioOnly);
      return { detached: project.clips[id].audioDetached === true, track: project.tracks.find((track) => track.id === soundClip?.trackId)?.type ?? '' };
    }, ids.sound);
    check('and choosing it puts the sound on an audio track, the picture quiet', afterMenu.detached && afterMenu.track === 'audio', JSON.stringify(afterMenu));

    /* 3. the toolbar's button --------------------------------------------------------------------- */
    await store(() => window.__scfStore.getState().selectClips([]));
    await sleep(200);
    const button = window.getByTestId('timeline-detach-audio');
    const offWithNothing = await button.isDisabled();
    await store((id) => window.__scfStore.getState().selectClips([id]), ids.silentToo);
    await sleep(200);
    const onForVideo = !(await button.isDisabled());
    const label = await button.getAttribute('aria-label');
    if (shots) await window.locator('.timeline-toolbar').screenshot({ path: join(shots, 'separar-audio-boton.png') });
    check('the toolbar has Detach audio beside split and delete: off with nothing selected, on for a video clip', offWithNothing && onForVideo && /Detach audio/.test(label ?? ''), `${offWithNothing} / ${onForVideo} / ${label}`);
    const before = await soundClips();
    await button.click();
    await sleep(600);
    const silentSays = await notices();
    check('pressed on the video with no sound, it says so, and nothing is added', /no sound in it/.test(silentSays) && (await soundClips()) === before, silentSays.slice(0, 160));
    await store((id) => window.__scfStore.getState().selectClips([id]), ids.soundToo);
    await sleep(200);
    await button.click();
    await window.waitForFunction((count) => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.audioOnly).length > count, before, { timeout: 30_000 }).catch(() => undefined);
    const afterButton = await store((id) => window.__scfStore.getState().project.clips[id].audioDetached === true, ids.soundToo);
    check('pressed on a video with sound, it detaches it', afterButton && (await soundClips()) === before + 1, `${await soundClips()} sound clips`);

    /* 4. the key ------------------------------------------------------------------------------------ */
    // Undone with Ctrl+Z (the focus off any field first), then the key does it again.
    await window.locator('[data-testid="viewer-timecode"]').click();
    await window.keyboard.press('Control+z');
    await sleep(400);
    const undone = await store((id) => window.__scfStore.getState().project.clips[id].audioDetached !== true, ids.soundToo);
    await store((id) => window.__scfStore.getState().selectClips([id]), ids.soundToo);
    await window.keyboard.press('Control+Alt+s');
    await window.waitForFunction((id) => window.__scfStore.getState().project.clips[id].audioDetached === true, ids.soundToo, { timeout: 30_000 }).catch(() => undefined);
    const byKey = await store((id) => window.__scfStore.getState().project.clips[id].audioDetached === true, ids.soundToo);
    check('Ctrl+Alt+S, after an undo, detaches it again', undone && byKey, `undone ${undone}, by key ${byKey}`);

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  const errors = existsSync(logs)
    ? readdirSync(logs).flatMap((name) => readFileSync(join(logs, name), 'utf8').split('\n')).filter((line) => / ERROR /.test(line))
    : [];
  check('nothing in the app\'s log', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300));
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
