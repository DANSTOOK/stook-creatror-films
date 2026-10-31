import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * "The camera follows the face", in the running app: `node tests/ui/auto-frame.mjs`
 *
 *   1. The card is on a video clip's Effects tab, with its three tightnesses.
 *   2. Following pushes the clip in by exactly the tightness asked for and
 *      keyframes its position, never past the edge of the picture.
 *   3. In the RENDERED picture the person is brought towards the middle and
 *      never left out of frame - the camera runs out of picture before it can
 *      centre a subject near an edge, which is the right behaviour.
 *   4. Stopping puts the clip's own position back, and it is one undo step.
 *
 * The fixture moves the person left to right AND up, so the vertical half is
 * checked too: the follow pans and deliberately does not tilt (edit/autoFrame).
 *
 * Needs a build, the Fast model in MATTE_MODELS_DIR (default
 * .bench-tmp/matte-run/models) and the video (default: the DIVISAS clip in
 * Downloads, read, never written). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'auto-frame');
const modelsDir = process.env.MATTE_MODELS_DIR ?? join(root, '.bench-tmp', 'matte-run', 'models');
const source = process.env.REFRAME_VIDEO ?? join(homedir(), 'Downloads', 'DIVISAS DIGITALES-PART.mp4');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TIGHTNESS = 1.35;

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  if (!existsSync(join(modelsDir, 'modnet.onnx'))) throw new Error(`No Fast model in ${modelsDir}`);
  if (!existsSync(source)) throw new Error(`No video with a person: ${source}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // The presenter alone, small in a wide frame: low on the left for 3 s, then
  // higher on the right. A camera that follows has to pan.
  //
  // A 2 s stretch is cut out and LOOPED to 6 s, because the presenter leaves
  // the cropped window partway through the source: taking 6 s straight gave a
  // fixture with nobody in it after 2.5 s, the matte rightly found nobody, and
  // only 14 of 31 samples tracked anything. Looped, it is 31 of 31. Two steps,
  // because -stream_loop with -ss on one input gives a 2 s file however long
  // the output is asked to be.
  const video = join(work, 'moving.mp4');
  const piece = join(work, 'piece.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error', '-ss', '2', '-t', '2', '-i', source,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', piece,
  ]);
  execFileSync(ffmpeg, [
    '-y', '-v', 'error', '-stream_loop', '2', '-i', piece, '-t', '6',
    '-filter_complex',
    "color=c=black:s=1920x1080:r=30:d=6[bg];[0:v]crop=iw*0.3:ih:iw*0.68:0,scale=-2:620,setsar=1[p];[bg][p]overlay=x='if(lt(t,3),200,1920-200-w)':y='if(lt(t,3),400,120)':shortest=1",
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
  ]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_MATTE_MODELS_DIR: modelsDir },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    // The card says what it found; this is the only way to see it from outside.
    let found = null;
    window.on('console', (message) => {
      const match = /\[autoframe\] (\d+)\/(\d+) samples/.exec(message.text());
      if (match) found = { found: Number(match[1]), of: Number(match[2]) };
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps: 30 }));

    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, video);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 120_000 });
    const clipId = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video');
      const id = store.addAssetToTimeline(store.assets[0], track.id, 0);
      window.__scfStore.getState().selectClips([id]);
      window.__scfStore.getState().setCurrentFrame(0);
      return id;
    });
    await sleep(500);

    // The Effects tab, where the card lives: selecting a clip in code does not
    // open it the way adding a sticker does.
    // The tab buttons carry an id, not a test id.
    await window.locator('#inspector-tab-fx').click();
    await sleep(300);

    console.log('1. the card');
    const card = window.getByTestId('clip-fx-auto-frame');
    const shown = await card.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const choices = await Promise.all(['gentle', 'standard', 'close'].map((id) => window.getByTestId(`clip-fx-auto-frame-${id}`).isVisible().catch(() => false)));
    check('a video clip’s Effects tab offers to follow the face, with its three tightnesses', shown && choices.every(Boolean), `card ${shown}, choices ${choices.join()}`);

    console.log('2. following');
    await window.getByTestId('clip-fx-auto-frame-standard').click();
    await window.getByTestId('clip-fx-auto-frame-run').click();
    const followed = await window
      .waitForFunction((id) => Boolean(window.__scfStore.getState().project.clips[id]?.tracking), clipId, { timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    check('it analyses the file and writes a follow', followed);
    // Every sample, not most of them. The first version of this fixture took 6 s
    // straight from the source, and the presenter leaves the cropped window
    // partway through it: the matte rightly found nobody and only 14 of 31
    // samples tracked anything, which looked like the tracker failing and was
    // the fixture. Looped, the subject is there throughout.
    check(
      'the tracker finds the subject in every sample, not just some',
      found !== null && found.found === found.of && found.of >= 25,
      found ? `${found.found}/${found.of}` : 'the card said nothing',
    );
    if (!followed) throw new Error('the follow never arrived');

    const after = await window.evaluate((id) => {
      const { project } = window.__scfStore.getState();
      const clip = project.clips[id];
      const transform = clip.fx?.base ?? clip.transform;
      return {
        scale: transform.scale.map((key) => [key.frame, Number(key.value.x.toFixed(4))]),
        position: transform.position.map((key) => [key.frame, Math.round(key.value.x), Math.round(key.value.y)]),
        width: project.width,
        height: project.height,
      };
    }, clipId);
    check('the clip is pushed in by exactly the tightness asked for', after.scale.length >= 1 && Math.abs(after.scale[0][1] - TIGHTNESS) < 0.001, JSON.stringify(after.scale));

    const overhangX = (after.width * TIGHTNESS - after.width) / 2;
    const overhangY = (after.height * TIGHTNESS - after.height) / 2;
    const early = after.position.filter(([frame]) => frame < 75);
    const late = after.position.filter(([frame]) => frame > 150);
    check(
      'the camera pans to the person: right of centre first, left after',
      early.length > 0 && late.length > 0 && Math.min(...early.map(([, x]) => x)) > 40 && Math.max(...late.map(([, x]) => x)) < -40,
      `early x ${early.map(([, x]) => x).join()} | late x ${late.map(([, x]) => x).join()}`,
    );
    check(
      'it pans and does not tilt: no vertical keyframes at all',
      after.position.every(([, , y]) => y === 0),
      `y ${after.position.map(([, , y]) => y).join()}`,
    );
    check(
      'in a handful of keyframes, never past the edge of the picture',
      after.position.length >= 2 &&
        after.position.length <= 30 &&
        after.position.every(([, x, y]) => Math.abs(x) <= overhangX + 1 && Math.abs(y) <= overhangY + 1),
      `${after.position.length} keyframes, overhang ${Math.round(overhangX)}x${Math.round(overhangY)}`,
    );

    console.log('3. the rendered picture');
    // Where the person is in the frame that would be exported: the lit mass
    // across, and the topmost lit row, which is the top of their head.
    const placeAt = (frame) => window.evaluate(async (at) => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, at, true);
        let sum = 0;
        let weight = 0;
        let top = null;
        for (let y = 0; y < project.height; y += 4) {
          let rowLit = 0;
          for (let x = 0; x < project.width; x += 4) {
            const i = (y * project.width + x) * 4;
            if (rgba[i] + rgba[i + 1] + rgba[i + 2] <= 60) continue;
            rowLit += 1;
            sum += x;
            weight += 1;
          }
          // A handful of lit samples is noise; a real row of the person is wider.
          if (top === null && rowLit > 3) top = y / project.height;
        }
        return weight > 0 ? { middle: sum / weight / project.width, top } : null;
      } finally {
        renderer.endExclusive();
      }
    }, frame);
    const before = await placeAt(45);
    const settled = await placeAt(175);
    check(
      'in the rendered picture the person moves towards the middle, not out of frame',
      before && settled && before.middle > 0.15 && before.middle < 0.85 && settled.middle > 0.15 && settled.middle < 0.85 && settled.middle > before.middle,
      `middle ${before?.middle?.toFixed(2)} then ${settled?.middle?.toFixed(2)}`,
    );
    await window.screenshot({ path: join(work, 'following.png') });

    console.log('4. stopping');
    const kept = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return (clip.tracking?.before ?? []).length;
    }, clipId);
    await window.getByTestId('clip-fx-auto-frame-remove').click();
    await sleep(400);
    const stopped = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const transform = clip.fx?.base ?? clip.transform;
      return { tracking: clip.tracking !== undefined, keys: transform.position.length, scale: Number((transform.scale[0]?.value.x ?? 1).toFixed(4)) };
    }, clipId);
    check('stopping puts the clip back as it was', !stopped.tracking && stopped.keys === kept, `${stopped.keys} keyframes (was ${kept}), scale ${stopped.scale}`);

    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(400);
    const undone = await window.evaluate((id) => Boolean(window.__scfStore.getState().project.clips[id]?.tracking), clipId);
    check('one undo brings the follow back', undone);

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
