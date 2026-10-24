import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The inspector, the way CapCut's is laid out: `node tests/ui/inspector-tabs.mjs`
 *
 *   1. a video has Video, Audio, Speed, Animation, Adjust and Info, in that
 *      order; a still Video, Animation, Adjust, Info; a sound Audio, Speed,
 *      Info; a title Title, Video, Animation, Info - and every tab's name
 *      fits;
 *   2. the Video tab has the transform and what keys and colours the picture
 *      (the effect stack, Add effect); the Animation tab what is on the clip,
 *      its move and its animations;
 *   3. an effect put on from the library brings the Video tab forward, where
 *      its card is; a move brings Animation forward;
 *   4. the Speed tab: the slider to its end makes the clip ten times as fast
 *      and a tenth as long, in one undo step; a duration typed makes the
 *      speed that fits it; a ramp and backwards are set from it;
 *   5. with nothing selected, the project's settings: its shape, its
 *      resolution - 4K makes it 3840×2160 with the picture fitted, not
 *      moved - its frame rate, and the way to the rest;
 *   6. the groups are cards, and no word on the inspector is garbled.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'inspector-tabs');
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
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=12', '-f', 'lavfi', '-i', 'sine=f=440:d=12:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  const still = join(work, 'still.png');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x22d3ee:s=640x360:d=1', '-frames:v', '1', still]);
  const sound = join(work, 'sound.wav');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=4:sample_rate=48000', sound]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video, still, sound]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 3, null, { timeout: 60_000 });
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1920, height: 1080, fps: 30 });
      const tracks = s.project.tracks;
      const v1 = tracks.find((t) => t.type === 'video' && t.order === 0);
      const v2 = tracks.find((t) => t.type === 'video' && t.order === 1);
      const a1 = tracks.find((t) => t.type === 'audio');
      const asset = (kind) => window.__scfStore.getState().assets.find((a) => a.kind === kind);
      const picture = window.__scfStore.getState().addAssetToTimeline(asset('video'), v1.id, 0);
      const photo = window.__scfStore.getState().addAssetToTimeline(asset('image'), v2.id, 400);
      const heard = window.__scfStore.getState().addAssetToTimeline(asset('audio'), a1.id, 400);
      const title = window.__scfStore.getState().addTitle('title', { trackId: null, startFrame: 600 });
      // The photo off the middle and at half size: a new resolution must keep it so.
      window.__scfStore.getState().setTransformAt(photo, 400, { position: { x: 100, y: 50 }, scale: { x: 0.5, y: 0.5 } });
      window.__scfStore.getState().setCurrentFrame(30);
      window.__scfStore.getState().selectClips([]);
      return { picture, photo, heard, title };
    });
    await sleep(800);

    const select = async (id) => {
      await window.evaluate((clipId) => window.__scfStore.getState().selectClips([clipId]), id);
      await sleep(350);
    };
    const tabsNow = () => window.evaluate(() => [...document.querySelectorAll('[data-testid="inspector-panel"] [role="tab"]')].map((tab) => ({ text: tab.textContent, whole: tab.scrollWidth <= tab.clientWidth + 1 })));
    const openTab = () => window.evaluate(() => document.getElementById('inspector-tabpanel')?.dataset.tab ?? null);

    /* 1. the tabs ------------------------------------------------------------- */
    const lists = {};
    for (const [kind, id] of Object.entries(ids)) {
      await select(id);
      lists[kind] = await tabsNow();
    }
    const names = (kind) => lists[kind].map((tab) => tab.text).join('|');
    check('a video: Video, Audio, Speed, Animation, Adjust, Info', names('picture') === 'Video|Audio|Speed|Animation|Adjust|Info', names('picture'));
    check('a still: Video, Animation, Adjust, Info', names('photo') === 'Video|Animation|Adjust|Info', names('photo'));
    check('a sound: Audio, Speed, Info', names('heard') === 'Audio|Speed|Info', names('heard'));
    check('a title: Title, Video, Animation, Info', names('title') === 'Title|Video|Animation|Info', names('title'));
    check('every tab\'s name fits', Object.values(lists).every((list) => list.every((tab) => tab.whole)), JSON.stringify(lists.picture));

    /* 2. what is on which tab ------------------------------------------------- */
    await select(ids.picture);
    await window.getByTestId('inspector-panel').getByRole('tab', { name: 'Video' }).click();
    await sleep(250);
    const videoTab = await window.evaluate(() => ({
      transform: Boolean(document.querySelector('#inspector-tabpanel [data-section="transform"]')),
      addEffect: Boolean(document.querySelector('#inspector-tabpanel [data-testid="inspector-add-effect"]')),
      summary: Boolean(document.querySelector('#inspector-tabpanel [data-testid="clip-fx-summary"]')),
    }));
    check('the Video tab has the transform and Add effect, not the animations', videoTab.transform && videoTab.addEffect && !videoTab.summary, JSON.stringify(videoTab));
    await window.getByTestId('inspector-panel').getByRole('tab', { name: 'Animation' }).click();
    await sleep(250);
    const animationTab = await window.evaluate(() => ({
      summary: Boolean(document.querySelector('#inspector-tabpanel [data-testid="clip-fx-summary"]')),
      motion: Boolean(document.querySelector('#inspector-tabpanel [data-testid="clip-fx-motion"]')),
      addEffect: Boolean(document.querySelector('#inspector-tabpanel [data-testid="inspector-add-effect"]')),
    }));
    check('the Animation tab has what is on the clip and its move, not Add effect', animationTab.summary && animationTab.motion && !animationTab.addEffect, JSON.stringify(animationTab));

    /* 3. the library brings the right tab forward ------------------------------ */
    await window.getByTestId('library-tab-effects').click();
    await sleep(400);
    await window.getByTestId('library-effect-sepia').click();
    await sleep(500);
    const afterEffect = { tab: await openTab(), card: await window.evaluate(() => Boolean(document.querySelector('#inspector-tabpanel [data-section^="fx-"], #inspector-tabpanel [data-testid^="effect-card"], #inspector-tabpanel [data-section*="sepia"]')) || /Sepia/.test(document.getElementById('inspector-tabpanel')?.textContent ?? '')) };
    check('an effect from the library brings the Video tab forward, with its card', afterEffect.tab === 'video' && afterEffect.card, JSON.stringify(afterEffect));
    await window.getByTestId('library-motion-zoomIn').click();
    await sleep(500);
    check('a move from the library brings Animation forward', (await openTab()) === 'fx', String(await openTab()));
    await window.getByTestId('library-tab-media').click();

    /* 4. the Speed tab ---------------------------------------------------------- */
    await window.evaluate(() => window.__scfStore.getState().undo());
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    await select(ids.picture);
    await window.getByTestId('inspector-panel').getByRole('tab', { name: 'Speed' }).click();
    await sleep(300);
    const clipNow = () => window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { duration: clip.durationFrames, speed: clip.speed ?? 1, ramp: clip.speedRamp ?? null, reversed: clip.reversed === true };
    }, ids.picture);
    const steps = () => window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    const before = await clipNow();
    const stepsBefore = await steps();
    const undo = async () => {
      // From outside the fields: the app's undo, not a field's.
      await window.locator('[data-testid="viewer-timecode"]').click();
      await window.keyboard.press('Control+z');
      await sleep(300);
    };
    await window.getByTestId('inspector-speed-slider').focus();
    await window.keyboard.press('End');
    await sleep(400);
    const fast = await clipNow();
    check('the slider at its end: ten times as fast, a tenth as long', Math.abs(fast.speed - 10) < 1e-6 && fast.duration === Math.round(before.duration / 10), `${JSON.stringify(before)} -> ${JSON.stringify(fast)}`);
    await sleep(600);
    await undo();
    const undone = await clipNow();
    check('and one undo puts it back', undone.duration === before.duration && Math.abs(undone.speed - 1) < 1e-6 && (await steps()) === stepsBefore, `${JSON.stringify(undone)}, steps ${await steps()} (was ${stepsBefore})`);
    // A drag: many small moves in a row, one step.
    await window.getByTestId('inspector-speed-slider').focus();
    for (let step = 0; step < 6; step += 1) await window.keyboard.press('ArrowRight');
    await sleep(300);
    const dragged = await clipNow();
    const dragSteps = (await steps()) - stepsBefore;
    await sleep(600);
    await undo();
    const dragUndone = await clipNow();
    check('a drag of the slider is one undo step', dragged.speed > 1 && dragSteps === 1 && dragUndone.duration === before.duration, `${dragSteps} steps, speed ${dragged.speed}, back to ${dragUndone.duration} frames`);
    const durationField = window.getByTestId('inspector-speed-duration');
    await durationField.fill('6:00');
    await durationField.press('Enter');
    await sleep(400);
    const typed = await clipNow();
    check('a duration typed makes the speed that fits it: 6 s of a 12 s clip is twice as fast', Math.abs(typed.speed - 2) < 0.01 && typed.duration === 180, JSON.stringify(typed));
    await window.getByTestId('inspector-ramp-hero').click();
    await sleep(300);
    await window.getByTestId('inspector-speed-reverse').check();
    await sleep(300);
    const shaped = await clipNow();
    check('a ramp and backwards are set from the tab', shaped.ramp === 'hero' && shaped.reversed, JSON.stringify(shaped));

    /* 5. nothing selected: the project ----------------------------------------- */
    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    await sleep(400);
    const projectPanel = await window.evaluate(() => ({
      shown: Boolean(document.querySelector('[data-testid="inspector-project"]')),
      aspect: document.querySelector('[data-testid="inspector-project-aspect"]')?.value,
      size: document.querySelector('[data-testid="inspector-project-size"]')?.value,
      fps: document.querySelector('[data-testid="inspector-project-fps"]')?.value,
    }));
    check('nothing selected: the project\'s settings, 16:9 at 1080p and 30 fps', projectPanel.shown && projectPanel.aspect === '16:9' && projectPanel.size === '1080' && projectPanel.fps === '30', JSON.stringify(projectPanel));
    const placeOf = () => window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const last = (track, fallback) => (track.length ? track[track.length - 1].value : fallback);
      return { scale: last(clip.transform.scale, { x: 1, y: 1 }), position: last(clip.transform.position, { x: 0, y: 0 }) };
    }, ids.photo);
    const photoBefore = await placeOf();
    await window.getByTestId('inspector-project-size').selectOption('2160');
    await sleep(400);
    const at4k = await window.evaluate(() => ({ width: window.__scfStore.getState().project.width, height: window.__scfStore.getState().project.height }));
    const photoAfter = await placeOf();
    check('4K makes the project 3840×2160, the picture fitted as it was', at4k.width === 3840 && at4k.height === 2160 && Math.abs(photoAfter.scale.x - photoBefore.scale.x) < 1e-6 && Math.abs(photoAfter.scale.y - photoBefore.scale.y) < 1e-6 && Math.abs(photoAfter.position.x - photoBefore.position.x * 2) < 1e-6, `${JSON.stringify(at4k)} ${JSON.stringify(photoBefore)} -> ${JSON.stringify(photoAfter)}`);
    await window.getByTestId('inspector-project-fps').selectOption('60');
    await sleep(300);
    check('its frame rate is set from there', (await window.evaluate(() => window.__scfStore.getState().project.fps)) === 60);
    await window.getByTestId('inspector-project-more').click();
    const dialog = window.locator('div.panel', { hasText: 'Project settings' });
    const opened = await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
    check('and More project settings opens the rest', opened);
    if (opened) await dialog.getByRole('button', { name: 'Done' }).click();
    await sleep(300);

    /* 6. cards, and every word whole ------------------------------------------- */
    await select(ids.picture);
    await window.getByTestId('inspector-panel').getByRole('tab', { name: 'Video' }).click();
    await sleep(300);
    const card = await window.evaluate(() => {
      const section = document.querySelector('#inspector-tabpanel section[data-section="transform"]');
      const style = section ? getComputedStyle(section) : null;
      return style ? { radius: parseFloat(style.borderTopLeftRadius), border: style.borderTopWidth } : null;
    });
    check('the groups are cards', card !== null && card.radius >= 6 && card.border !== '0px', JSON.stringify(card));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(400);
    const garbled = await window.evaluate(() => {
      const text = document.querySelector('[data-testid="inspector-panel"]')?.innerText ?? '';
      return (text.match(/\S*(Ã[\u0080-¿]|â€)\S*/g) ?? []).slice(0, 4);
    });
    const spanish = await tabsNow();
    check('in Spanish: Vídeo, Audio, Velocidad, Animación, Ajustar, Info, none cut, nothing garbled', spanish.map((tab) => tab.text).join('|') === 'Vídeo|Audio|Velocidad|Animación|Ajustar|Info' && spanish.every((tab) => tab.whole) && garbled.length === 0, `${spanish.map((tab) => tab.text).join('|')} ${JSON.stringify(garbled)}`);

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
