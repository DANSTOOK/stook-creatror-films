import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Freeze frame, in the running app: `node tests/ui/freeze.mjs`
 *
 * A clip of a second each of red, green and blue, with its sound, and the
 * playhead half-way through the green:
 *   1. "Freeze frame" in the inspector's Video tab holds the green for two
 *      seconds: the clip and its sound are cut at the playhead, the still sits
 *      between, and what follows starts two seconds later;
 *   2. the export's own picture: green all through the hold, the clip carrying
 *      on from where it stopped after it, then blue;
 *   3. the clip's timeline menu offers it under the playhead; one undo takes
 *      it all back.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'freeze');
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
  const video = join(work, 'rgb.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=0x00c000:s=640x360:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=d=3',
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
      s.setProjectSettings({ width: 640, height: 360, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      // The sound beside it, linked, as a detach leaves it.
      window.__scfStore.getState().selectClips([id]);
      window.__scfStore.getState().detachAudio([id]);
      // The picture alone selected (a click selects its linked sound too, and the inspector shows both).
      window.__scfStore.getState().setUi({ selectedClipIds: [id] });
      window.__scfStore.getState().setCurrentFrame(45);
      return id;
    });
    await sleep(800);
    const pieces = () =>
      window.evaluate(() => {
        const s = window.__scfStore.getState();
        return Object.values(s.project.clips)
          .map((c) => ({ id: c.id, kind: s.project.tracks.find((t) => t.id === c.trackId)?.type, still: !s.assets.find((a) => a.uri === c.sourceUri)?.kind?.startsWith('video') && s.assets.find((a) => a.uri === c.sourceUri)?.kind === 'image', start: c.startFrame, length: c.durationFrames, offset: c.sourceOffsetFrames }))
          .sort((a, b) => (a.kind === b.kind ? a.start - b.start : a.kind < b.kind ? -1 : 1));
      });
    const before = await pieces();

    console.log('1. freezing');
    await window.locator('[role="tab"]').filter({ hasText: /^Video$/ }).first().click();
    await window.getByTestId('inspector-freeze').click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.some((a) => a.kind === 'image'), null, { timeout: 30_000 });
    await sleep(500);
    const after = await pieces();
    const videos = after.filter((p) => p.kind === 'video');
    const audios = after.filter((p) => p.kind === 'audio');
    const still = videos.find((p) => p.still);
    const left = videos.find((p) => !p.still && p.start === 0);
    const right = videos.find((p) => !p.still && p.start > 0);
    check('the clip is cut at the playhead and the still held there for two seconds, what follows moved along',
      Boolean(still && left && right) && still.start === 45 && still.length === 60 && left.length === 45 && right.start === 105 && right.offset === 45,
      JSON.stringify(videos));
    const soundRight = audios.find((p) => p.start > 0);
    check('its sound is cut and moved with it, so it stays in sync', before.some((p) => p.kind === 'audio') && audios.length === 2 && soundRight?.start === 105 && soundRight?.offset === 45, JSON.stringify(audios));

    console.log('2. in the export');
    const colours = await window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const at = async (frame) => {
          const rgba = await renderer.renderExact(project, frame, true);
          const i = (180 * project.width + 320) * 4;
          const [r, g, b] = rgba.slice(i, i + 3);
          return r > 150 && g < 90 ? 'red' : g > 150 && r < 90 ? 'green' : b > 150 && r < 90 ? 'blue' : `${r},${g},${b}`;
        };
        return { held: [await at(46), await at(75), await at(104)], after: await at(110), later: await at(140) };
      } finally {
        renderer.endExclusive();
      }
    });
    check('green all through the hold, the clip carrying on after it, then blue', colours.held.every((c) => c === 'green') && colours.after === 'green' && colours.later === 'blue', JSON.stringify(colours));

    console.log('3. the menu, and undo');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const undone = await pieces();
    const assetsLeft = await window.evaluate(() => window.__scfStore.getState().assets.length);
    // The still stays in the library, as imported media does after an undo; the timeline is as it was.
    check('one undo takes the cut, the hold and the move back; the still stays in the library', JSON.stringify(undone) === JSON.stringify(before) && assetsLeft === 2, `${undone.length} clips, ${assetsLeft} asset(s)`);
    const canvas = await window.locator('[data-panel="timeline"] canvas').first().boundingBox();
    const rowY = await window.evaluate((id) => {
      const s = window.__scfStore.getState();
      const rows = [...document.querySelectorAll('[data-panel="timeline"] .group.relative.flex')];
      const names = rows.map((row) => row.textContent ?? '');
      const track = s.project.tracks.find((t) => t.id === s.project.clips[id].trackId);
      const index = names.findIndex((name) => name.includes(track.name));
      const box = rows[index].getBoundingClientRect();
      return box.top + box.height / 2;
    }, clipId);
    const x = await window.evaluate(() => 45 * window.__scfStore.getState().ui.pixelsPerFrame - window.__scfStore.getState().ui.scrollLeftPx);
    await window.mouse.click(canvas.x + x + 4, rowY, { button: 'right' });
    const offered = await window.getByRole('menuitem', { name: /Freeze frame/ }).isVisible().catch(() => false);
    check('the clip’s menu on the timeline offers it with the playhead over the clip', offered);
    await window.keyboard.press('Escape');

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
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
