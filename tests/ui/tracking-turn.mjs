import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Following an object's turn, in the running app: `node tests/ui/tracking-turn.mjs`
 *
 * A test-pattern square in the middle of the frame turns clockwise at
 * 0.4 rad/s (23° a second), with a sticker over it:
 *   1. followed with "its turn too", the sticker turns as the square did -
 *      clockwise, to within a few degrees - keeping its size and its place;
 *   2. the turn is in what is drawn: the composed transform the export
 *      renders turns the same way, the sticker's pulse still on;
 *   3. followed again without it, the sticker keeps its own rotation;
 *      Stop following puts everything back.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'tracking-turn');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** The square's turn at `t` seconds, degrees clockwise. */
const turn = (t) => (0.4 * t * 180) / Math.PI;

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const video = join(work, 'turning.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x606060:s=1280x720:r=30:d=3',
    '-f', 'lavfi', '-i', 'testsrc2=s=120x120:r=30:d=3',
    // ffmpeg's rotate turns clockwise for a positive angle; the corners it opens are the background's grey.
    '-filter_complex', "[1:v]rotate=a='0.4*t':ow=180:oh=180:c=0x606060[s];[0:v][s]overlay=x='(W-w)/2':y='(H-h)/2'[v]",
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', video,
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
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1280, height: 720, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
    });
    await window.getByTestId('library-tab-stickers').click();
    await window.getByTestId('library-sticker-star').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 2, null, { timeout: 30_000 });
    const stickerId = await window.evaluate(() => window.__scfStore.getState().ui.selectedClipIds[0]);
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(0));
    await window.getByTestId('clip-fx-follow').waitFor({ state: 'visible', timeout: 10_000 });

    /** The sticker at `frame`: its own transform (fx.base) or the composed one the export draws. */
    const poseAt = (frame, composed = false) =>
      window.evaluate(
        ([id, f, whole]) => {
          const clip = window.__scfStore.getState().project.clips[id];
          const transform = whole ? clip.transform : clip.fx?.base ?? clip.transform;
          const at = (keys, rest) => {
            if (keys.length === 0) return rest;
            if (f <= keys[0].frame) return keys[0].value;
            for (let i = 1; i < keys.length; i += 1) {
              if (f <= keys[i].frame) {
                const u = (f - keys[i - 1].frame) / (keys[i].frame - keys[i - 1].frame);
                const a = keys[i - 1].value;
                const b = keys[i].value;
                return typeof a === 'number' ? a + (b - a) * u : { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
              }
            }
            return keys.at(-1).value;
          };
          return { rotation: at(transform.rotation, 0), scale: at(transform.scale, { x: 1, y: 1 }).x, position: at(transform.position, { x: 0, y: 0 }) };
        },
        [stickerId, frame, composed],
      );

    const follow = async (withTurn) => {
      await window.getByTestId('clip-fx-follow-mark').click();
      const overlay = window.getByTestId('track-box-overlay');
      await overlay.waitFor({ state: 'visible', timeout: 5_000 });
      const box = await overlay.boundingBox();
      const px = (x, y) => ({ x: box.x + (x / 1280) * box.width, y: box.y + (y / 720) * box.height });
      // The box offered sits over the sticker - here over the square - so its corners go onto the square's.
      const corner = async (grip, to) => {
        const handle = await window.getByTestId(`track-box-${grip}`).boundingBox();
        await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await window.mouse.down();
        await window.mouse.move(to.x, to.y, { steps: 6 });
        await window.mouse.up();
      };
      await corner('nw', px(640 - 58, 360 - 58));
      await corner('se', px(640 + 58, 360 + 58));
      const toggle = window.getByTestId('clip-fx-follow-turn');
      if ((await toggle.isChecked()) !== withTurn) await toggle.click();
      const before = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].transform, stickerId);
      await window.getByTestId('clip-fx-follow-run').click();
      await window.waitForFunction(([id, old]) => window.__scfStore.getState().project.clips[id].transform !== old && Boolean(window.__scfStore.getState().project.clips[id].tracking), [stickerId, before], { timeout: 60_000 }).catch(() => undefined);
      await window.waitForFunction(() => !/Following|Siguiendo/.test(document.querySelector('[data-testid="clip-fx-follow-hint"]')?.textContent ?? ''), null, { timeout: 60_000 }).catch(() => undefined);
    };

    console.log('1. following its turn');
    const own = await poseAt(0);
    await follow(true);
    const start = await poseAt(0);
    const late = await poseAt(75);
    const turned = late.rotation - start.rotation;
    check('the sticker turns as the square did: clockwise, to within 6°', Math.abs(turned - turn(2.5)) < 6, `turned ${turned.toFixed(1)}°, the square ${turn(2.5).toFixed(1)}°`);
    check('and keeps its size and its place (within 5 px of the tracker’s 320 px frames)', Math.abs(late.scale / start.scale - 1) < 0.1 && Math.hypot(late.position.x - start.position.x, late.position.y - start.position.y) < 20,
      JSON.stringify({ scale: [start.scale.toFixed(3), late.scale.toFixed(3)], position: [start.position, late.position] }));

    console.log('2. in what is drawn');
    const drawn = await poseAt(75, true);
    const pulse = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].fx?.loop?.id, stickerId);
    check('the transform the export draws turns the same way, its pulse still on', Math.abs(drawn.rotation - late.rotation) < 1 && Boolean(pulse), `${drawn.rotation.toFixed(1)}° drawn, ${late.rotation.toFixed(1)}° followed, loop ${pulse}`);

    console.log('3. without it, and stopping');
    await follow(false);
    const kept = await poseAt(75);
    check('followed again without its turn, it keeps its own rotation', Math.abs(kept.rotation - own.rotation) < 0.01, `${kept.rotation.toFixed(2)}° against ${own.rotation.toFixed(2)}°`);
    await window.getByTestId('clip-fx-follow-remove').click();
    await sleep(200);
    const after = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const transform = clip.fx?.base ?? clip.transform;
      return { tracking: clip.tracking, rotationKeys: transform.rotation.length, positionKeys: transform.position.length, scaleKeys: transform.scale.length };
    }, stickerId);
    check('Stop following puts its own turn, size and place back', after.tracking === undefined && after.rotationKeys === 0 && after.positionKeys === 0 && after.scaleKeys === 1, JSON.stringify(after));

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
