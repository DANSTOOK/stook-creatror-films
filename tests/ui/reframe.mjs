import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Auto reframe, in the running app: `node tests/ui/reframe.mjs`
 *
 * A 1920x1080 project whose clip has a person on the left for three seconds
 * and on the right after (made from REFRAME_VIDEO: the presenter on the right of a
 * clip, cut out and moved across), reframed to vertical with Follow the person:
 *   1. the dialog opens from Project settings and offers 1080x1920;
 *   2. the project becomes 1080x1920 and the clip covers it unstretched;
 *   3. the frame follows the person: left first, right after, in a handful
 *      of keyframes, never past the picture's edge;
 *   4. one undo puts the project and the clip back.
 *
 * Needs a build, the Fast model in MATTE_MODELS_DIR (default
 * .bench-tmp/matte-run/models) and the video (default: the DIVISAS clip in
 * Downloads). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'reframe');
const modelsDir = process.env.MATTE_MODELS_DIR ?? join(root, '.bench-tmp', 'matte-run', 'models');
const source = process.env.REFRAME_VIDEO ?? join(homedir(), 'Downloads', 'DIVISAS DIGITALES-PART.mp4');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
  // The presenter alone - the right third of the source - on the left for 3 s, then on the right, on black.
  const video = join(work, 'moving.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error', '-ss', '2', '-t', '6', '-i', source,
    '-filter_complex', "color=c=black:s=1920x1080:r=30:d=6[bg];[0:v]crop=iw*0.3:ih:iw*0.68:0,scale=-2:900,setsar=1[p];[bg][p]overlay=x='if(lt(t,3),120,1920-120-w)':y=90:shortest=1",
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const clipId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1920, height: 1080, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      return window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
    });

    console.log('1. the dialog');
    await window.evaluate(() => window.filmora.appMenuInvoke('projectSettings'));
    await window.getByTestId('settings-reframe').click();
    await window.getByTestId('reframe-dialog').waitFor({ state: 'visible', timeout: 5_000 });
    await window.waitForFunction(() => !document.querySelector('[data-testid="reframe-apply"]')?.disabled, null, { timeout: 15_000 });
    const label = (await window.getByTestId('reframe-apply').innerText()).trim();
    check('it opens from Project settings and offers 1080x1920', label === 'Reframe to 1080x1920', label);

    console.log('2. reframing');
    const depth = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    await window.getByTestId('reframe-apply').click();
    const done = await window.waitForFunction(() => window.__scfStore.getState().project.width === 1080, null, { timeout: 240_000 }).then(() => true).catch(() => false);
    const after = await window.evaluate((id) => {
      const { project } = window.__scfStore.getState();
      const clip = project.clips[id];
      return { width: project.width, height: project.height, scale: clip.transform.scale.map((k) => k.value), position: clip.transform.position.map((k) => [k.frame, Math.round(k.value.x)]) };
    }, clipId);
    check('the project becomes 1080x1920 and the clip covers it, unstretched', done && after.height === 1920 && after.scale.length === 1 && Math.abs(after.scale[0].x - 256 / 81) < 0.01 && after.scale[0].y === 1, JSON.stringify(after.scale));

    console.log('3. following the person');
    const drawn = 1080 * (256 / 81);
    const overhang = (drawn - 1080) / 2;
    const xs = after.position.map(([, x]) => x);
    const early = after.position.filter(([frame]) => frame < 75).map(([, x]) => x);
    const late = after.position.filter(([frame]) => frame > 150).map(([, x]) => x);
    check('the frame is on the person: left first, right after',
      early.length > 0 && late.length > 0 && Math.min(...early) > 300 && Math.max(...late) < -300, JSON.stringify(after.position));
    check('in a handful of keyframes, never past the edge of the picture', after.position.length >= 2 && after.position.length <= 20 && xs.every((x) => Math.abs(x) <= overhang + 1), `${after.position.length} keyframes, overhang ${Math.round(overhang)}`);

    // In the picture itself: the presenter's middle near the middle of the vertical frame, before the jump and after it settles.
    const middleAt = (frame) => window.evaluate(async (at) => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, at, true);
        let sum = 0;
        let weight = 0;
        for (let y = 0; y < project.height; y += 4) {
          for (let x = 0; x < project.width; x += 4) {
            const i = (y * project.width + x) * 4;
            const lit = rgba[i] + rgba[i + 1] + rgba[i + 2] > 60 ? 1 : 0;
            sum += lit * x;
            weight += lit;
          }
        }
        return weight > 0 ? sum / weight / project.width : null;
      } finally {
        renderer.endExclusive();
      }
    }, frame);
    const before = await middleAt(45);
    const settled = await middleAt(175);
    check('in the exported picture the presenter is in the middle of the vertical frame, before and after they move',
      before !== null && settled !== null && Math.abs(before - 0.5) < 0.15 && Math.abs(settled - 0.5) < 0.15, `middle at ${before?.toFixed(2)} then ${settled?.toFixed(2)}`);

    console.log('4. undo');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(200);
    const undone = await window.evaluate((id) => {
      const { project } = window.__scfStore.getState();
      return { width: project.width, height: project.height, keys: project.clips[id].transform.position.length };
    }, clipId);
    const depthAfter = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    check('one undo puts the project and the clip back', undone.width === 1920 && undone.height === 1080 && undone.keys === 0 && depthAfter === depth, JSON.stringify(undone));

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
