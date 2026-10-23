import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Remove filler words and the animation curve, in the running app:
 * `node tests/ui/curves-fillers.mjs`
 *
 *   1. a talking clip whose captions heard "eh" and "um": its right-click
 *      menu offers Remove filler words (2); they leave the clip, what follows
 *      closing up, and the captions' text; one undo step puts it all back;
 *   2. a clip whose position moves between two keyframes shows the
 *      Animation curve card; a preset puts its curve on the stretch's first
 *      keyframe; dragging a handle shapes it, the drag one undo step.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'curves-fillers');
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
  const video = join(work, 'talk.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=220:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const talk = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 320, height: 180, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      const words = [
        { text: 'Hola', start: 0.2, end: 0.6 },
        { text: 'eh', start: 0.7, end: 1.0 },
        { text: 'a', start: 1.1, end: 1.2 },
        { text: 'todos,', start: 1.2, end: 1.7 },
        { text: 'um', start: 1.8, end: 2.1 },
        { text: 'bienvenidos.', start: 2.2, end: 3.0 },
      ];
      window.__scfStore.getState().addCaptionTrack(
        { cues: [{ start: 0.2, end: 3.0, lines: ['Hola eh a todos, um bienvenidos.'], words }], offsetFrame: 0, sourceTrackId: track.id },
        { preset: 'classic', language: 'es' },
      );
      window.__scfStore.getState().setCurrentFrame(0);
      return id;
    });
    const depth = () => window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    const trackOfTalk = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].trackId, talk);
    const pieces = () => window.evaluate((trackId) => {
      const s = window.__scfStore.getState();
      return Object.values(s.project.clips).filter((c) => c.trackId === trackId && !c.audioOnly).map((c) => [c.startFrame, c.startFrame + c.durationFrames]).sort((a, b) => a[0] - b[0]);
    }, trackOfTalk);
    const captionText = () => window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).filter((c) => c.caption).map((c) => c.caption.text).join(' / '));
    const surface = window.getByTestId('timeline-canvas');
    const clipPoint = async (id) => {
      const box = await surface.boundingBox();
      const spot = await window.evaluate((clipId) => {
        const { project, ui } = window.__scfStore.getState();
        const clip = project.clips[clipId];
        const visual = project.tracks.filter((t) => t.type !== 'audio').sort((a, b) => b.order - a.order);
        const audio = project.tracks.filter((t) => t.type === 'audio').sort((a, b) => a.order - b.order);
        const row = [...visual, ...audio].findIndex((t) => t.id === clip.trackId);
        return { x: (clip.startFrame + clip.durationFrames * 0.8) * ui.pixelsPerFrame - ui.scrollLeftPx, y: 24 + row * 58 + 28 };
      }, id);
      return { x: box.x + spot.x, y: box.y + spot.y };
    };

    console.log('1. Remove filler words');
    const linked = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).find((c) => c.caption)?.caption.link?.clipId ?? null);
    check('the transcribed caption follows the talking clip', linked === talk, String(linked));
    const start = await depth();
    const at = await clipPoint(talk);
    await window.mouse.click(at.x, at.y, { button: 'right' });
    const item = window.getByRole('menuitem', { name: /Remove filler words \(2\)/ });
    const offered = await item.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    check('right-click offers Remove filler words (2)', offered);
    if (offered) await item.click();
    else await window.keyboard.press('Escape');
    await sleep(300);
    const cut = await pieces();
    const text = await captionText();
    check('the fillers leave the clip, what follows closing up', JSON.stringify(cut) === '[[0,20],[20,42],[42,98]]', JSON.stringify(cut));
    check('and the captions\' text', text === 'Hola a todos, bienvenidos.', text);
    check('one undo step', (await depth()) === start + 1, `${start} -> ${await depth()}`);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const back = await pieces();
    check('undo puts the clip and the captions back', JSON.stringify(back) === '[[0,120]]' && /eh a todos, um/.test(await captionText()), JSON.stringify(back));

    console.log('2. Animation curve');
    await window.evaluate((id) => {
      const s = window.__scfStore.getState();
      const clip = s.project.clips[id];
      s.updateClip(id, {
        transform: {
          ...clip.transform,
          position: [
            { id: 'kf-a', frame: 0, value: { x: 0, y: 0 }, easing: 'linear' },
            { id: 'kf-b', frame: 60, value: { x: 100, y: 0 }, easing: 'linear' },
          ],
        },
      });
      window.__scfStore.getState().selectClips([id]);
      window.__scfStore.getState().setCurrentFrame(30);
    }, talk);
    await window.getByRole('tab', { name: /^Video/ }).first().click().catch(() => undefined);
    const card = window.getByTestId('inspector-easing');
    const shown = await card.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    const segment = shown ? await window.getByTestId('inspector-easing-segment').innerText() : '';
    check('a moving clip shows the Animation curve card, on the stretch under the playhead', shown && /0 → 60/.test(segment), segment);
    const firstKey = () => window.evaluate((id) => {
      const key = window.__scfStore.getState().project.clips[id].transform.position.find((k) => k.id === 'kf-a');
      return { easing: key.easing, params: key.bezierParams ?? null };
    }, talk);
    if (shown) await window.getByTestId('inspector-easing-back').click();
    await sleep(200);
    const back1 = await firstKey();
    check('Overshoot puts its curve on the stretch\'s first keyframe', back1.easing === 'bezier' && back1.params?.cp1.y === 1.56,
      JSON.stringify(back1));
    const pressed = shown && (await window.getByTestId('inspector-easing-back').getAttribute('aria-pressed')) === 'true';
    check('and shows it chosen', pressed);
    const before = await depth();
    if (shown) {
      const handle = await window.getByTestId('inspector-easing-cp1').boundingBox();
      const graph = await window.getByTestId('inspector-easing-graph').boundingBox();
      await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await window.mouse.down();
      for (let step = 1; step <= 8; step += 1) {
        await window.mouse.move(handle.x + handle.width / 2 + ((graph.x + graph.width * 0.75 - handle.x) * step) / 8, handle.y + ((graph.y + graph.height * 0.85 - handle.y) * step) / 8);
        await sleep(20);
      }
      await window.mouse.up();
    }
    await sleep(200);
    const dragged = await firstKey();
    const steps = (await depth()) - before;
    check('dragging a handle shapes the curve: the handle goes right and down', dragged.params && dragged.params.cp1.x > 0.5 && dragged.params.cp1.y < 0.5,
      JSON.stringify(dragged.params));
    check('the drag is one undo step', steps === 1, `${steps} steps`);
    if (shown) await window.getByTestId('inspector-easing-linear').click();
    await sleep(200);
    const linear = await firstKey();
    check('Linear takes the curve off again', linear.easing === 'linear' && linear.params === null, JSON.stringify(linear));

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
