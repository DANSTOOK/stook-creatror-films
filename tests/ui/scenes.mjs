import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Split at scene changes, in the running app: `node tests/ui/scenes.mjs`
 *
 * A clip of three shots - red, a test pattern, blue - two seconds each:
 *   1. the dialog, opened from the inspector's Video tab, finds the two
 *      changes and marks them;
 *   2. Split leaves three clips of two seconds, end to end, each starting in
 *      its own shot, as one undo step;
 *   3. with the sound detached, the picture and the sound are cut alike and
 *      linked piece by piece (opened from the clip's timeline menu).
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'scenes');
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
  const video = join(work, 'takes.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=30:d=2',
    '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=d=6',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1[v]',
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
  ]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const clipId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1280, height: 720, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().selectClips([id]);
      return id;
    });
    await sleep(400);
    const pieces = () => window.evaluate(() =>
      Object.values(window.__scfStore.getState().project.clips)
        .map((c) => ({ track: window.__scfStore.getState().project.tracks.find((t) => t.id === c.trackId)?.type, start: c.startFrame, length: c.durationFrames, offset: c.sourceOffsetFrames, link: c.linkGroup ?? null }))
        .sort((a, b) => (a.track === b.track ? a.start - b.start : a.track < b.track ? -1 : 1)),
    );

    console.log('1. finding the changes of shot');
    await window.locator('[role="tab"]').filter({ hasText: /^Video$/ }).first().click();
    await window.getByTestId('inspector-split-scenes').click();
    await window.getByTestId('scene-dialog').waitFor({ state: 'visible', timeout: 5_000 });
    await window.waitForFunction(() => /^\d+ changes of shot|No changes|could not/.test(document.querySelector('[data-testid="scene-status"]')?.textContent ?? ''), null, { timeout: 30_000 });
    const status = (await window.getByTestId('scene-status').innerText()).trim();
    const marks = await window.getByTestId('scene-preview').locator('span').count();
    check('it finds the two changes of shot and marks them', status === '2 changes of shot: the clip becomes 3 clips.' && marks === 2, `${status} | ${marks} marked`);

    console.log('2. splitting');
    const depth = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    await window.getByTestId('scene-apply').click();
    await sleep(400);
    const split = (await pieces()).filter((p) => p.track === 'video');
    check('three clips of two seconds, end to end, each from its own shot', split.map((p) => `${p.start}+${p.length}@${p.offset}`).join(' ') === '0+60@0 60+60@60 120+60@120', JSON.stringify(split));
    const depthAfter = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(200);
    const undone = await pieces();
    check('as one undo step', depthAfter === depth + 1 && undone.length === 1, `${depth} -> ${depthAfter}; after undo ${undone.length} clip`);

    console.log('3. with the sound detached');
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), clipId);
    await window.evaluate(() => window.filmora.appMenuInvoke('detachAudio'));
    await window.waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).length === 2, null, { timeout: 30_000 });
    await window.evaluate(() => window.__scfStore.getState().setUi({ pixelsPerFrame: 4, scrollLeftPx: 0 }));
    await sleep(200);
    const box = await window.getByTestId('timeline-canvas').boundingBox();
    await window.mouse.click(box.x + 60, box.y + 24 + 58 + 28, { button: 'right' });
    await window.getByRole('menuitem', { name: 'Split at scene changes…' }).click();
    await window.waitForFunction(() => /^\d+ changes of shot/.test(document.querySelector('[data-testid="scene-status"]')?.textContent ?? ''), null, { timeout: 30_000 });
    await window.getByTestId('scene-apply').click();
    await sleep(400);
    const both = await pieces();
    const pics = both.filter((p) => p.track === 'video');
    const sounds = both.filter((p) => p.track === 'audio');
    const paired = pics.length === 3 && sounds.length === 3 && pics.every((p, i) => p.start === sounds[i].start && p.length === sounds[i].length && p.link && p.link === sounds[i].link);
    check('picture and sound are cut alike, each piece linked to its partner', paired, JSON.stringify(both.map((p) => [p.track, p.start, p.length])));

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
