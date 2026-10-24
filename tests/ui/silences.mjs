import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Remove silences, in the running app: `node tests/ui/silences.mjs`
 *
 * A clip of tone with two silences in it - 1 s and 1.5 s, the tone at
 * 0-1 s, 2-3 s and 4.5-5.5 s - opened in the dialog from the inspector's
 * Audio tab:
 *   1. it finds the two silences, says how much comes out, and marks them;
 *   2. Remove leaves three pieces end to end, each the tone with the margin
 *      kept, as one undo step;
 *   3. with the sound detached onto its own track, the picture and the sound
 *      are cut alike, stay linked piece by piece and in sync.
 *
 * Needs a build (npm run build). The window is never shown. Screenshots go to
 * SILENCES_SHOTS when it is set.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'silences');
const shotsDir = process.env.SILENCES_SHOTS ?? '';
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
  const video = join(work, 'talk.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=5.5',
    '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)*(between(t,0,1)+between(t,2,3)+between(t,4.5,5.5))':s=48000:d=5.5",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
  ]);

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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1280, height: 720, fps: 30 }));
    const place = () => window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.removeClips(Object.keys(s.project.clips));
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().selectClips([id]);
      return id;
    });
    const pieces = () => window.evaluate(() =>
      Object.values(window.__scfStore.getState().project.clips)
        .map((c) => ({ id: c.id, track: window.__scfStore.getState().project.tracks.find((t) => t.id === c.trackId)?.type, start: c.startFrame, length: c.durationFrames, offset: c.sourceOffsetFrames, link: c.linkGroup ?? null }))
        .sort((a, b) => (a.track === b.track ? a.start - b.start : a.track < b.track ? -1 : 1)),
    );
    const openDialog = async () => {
      await window.locator('[role="tab"]').filter({ hasText: /^Audio$/ }).first().click();
      await window.getByTestId('inspector-remove-silences').click();
      await window.getByTestId('silence-dialog').waitFor({ state: 'visible', timeout: 5_000 });
      await window.waitForFunction(() => /found|No silences|could not/.test(document.querySelector('[data-testid="silence-status"]')?.textContent ?? ''), null, { timeout: 30_000 });
    };

    console.log('1. finding them');
    await place();
    await sleep(500);
    await openDialog();
    const status = (await window.getByTestId('silence-status').innerText()).trim();
    const marks = await window.getByTestId('silence-preview').locator('span').count();
    check('it finds the two silences, and says how much comes out', /^2 silences found: [\d.]+ s of 5\.5 s will come out\.$/.test(status) && marks === 2, `${status} | ${marks} marked`);
    await shot(window, 'dialog.png');

    console.log('2. taking them out');
    const depth = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    await window.getByTestId('silence-apply').click();
    await sleep(500);
    const after = await pieces();
    const video1 = after.filter((p) => p.track === 'video');
    const lengths = video1.map((p) => p.length);
    const endToEnd = video1.every((p, i) => i === 0 || p.start === video1[i - 1].start + video1[i - 1].length);
    // The tone with 0.12 s (4 frames) kept either side of each silence: 1 s + 4, 4 + 1 s + 4, 4 + 1 s.
    check('Remove leaves three pieces, end to end, each the tone with the margin kept', video1.length === 3 && endToEnd && lengths.join() === '34,38,34', `lengths ${lengths.join(', ')}; offsets ${video1.map((p) => p.offset).join(', ')}`);
    const depthAfter = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(200);
    const undone = await pieces();
    check('as one undo step', depthAfter === depth + 1 && undone.length === 1 && undone[0].length === 165, `${depth} -> ${depthAfter}; after undo ${undone.length} clip of ${undone[0]?.length}`);

    console.log('3. with the sound detached');
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.selectClips(Object.keys(s.project.clips));
    });
    await window.evaluate(() => window.filmora.appMenuInvoke('detachAudio'));
    await window.waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).length === 2, null, { timeout: 30_000 });
    const picture = (await pieces()).find((p) => p.track === 'video');
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), picture.id);
    await sleep(300);
    // A picture whose sound went to its own track: its Audio tab says where the
    // sound went, so open it the other way - the clip's menu on the timeline.
    const box = await window.getByTestId('timeline-canvas').boundingBox();
    await window.evaluate(() => window.__scfStore.getState().setUi({ pixelsPerFrame: 4, scrollLeftPx: 0 }));
    await sleep(200);
    // Right-click the picture on Video 1, the second picture row from the top.
    await window.mouse.click(box.x + 60, box.y + (await window.evaluate(() => {
      // Video 1's row as the timeline laid it out: picture rows are taller than the rest.
      const track = window.__scfStore.getState().project.tracks.find((t) => t.type === 'video' && t.order === 0);
      const lane = window.__scfTimelineRow(track.id);
      return lane.top + lane.height / 2;
    })), { button: 'right' });
    await window.getByRole('menuitem', { name: 'Remove silences…' }).click();
    await window.getByTestId('silence-dialog').waitFor({ state: 'visible', timeout: 5_000 });
    await window.waitForFunction(() => /found/.test(document.querySelector('[data-testid="silence-status"]')?.textContent ?? ''), null, { timeout: 30_000 });
    await window.getByTestId('silence-apply').click();
    await sleep(500);
    const both = await pieces();
    const pics = both.filter((p) => p.track === 'video');
    const sounds = both.filter((p) => p.track === 'audio');
    const inSync = pics.length === 3 && sounds.length === 3 && pics.every((p, i) => p.start === sounds[i].start && p.length === sounds[i].length && p.offset === sounds[i].offset && p.link && p.link === sounds[i].link);
    check('picture and sound are cut alike, piece by piece linked and in sync', inSync, JSON.stringify(both.map((p) => [p.track, p.start, p.length, p.link ? p.link.slice(-4) : null])));
    await shot(window, 'after.png');

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
