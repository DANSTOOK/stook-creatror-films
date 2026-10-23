import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Following an object's size, in the running app: `node tests/ui/tracking-size.mjs`
 *
 * A test-pattern square in the middle of the frame grows from 80 to 155 px
 * over 2.5 seconds - something coming towards the camera - with a sticker
 * over it:
 *   1. followed with "its size too", the sticker grows as the square did
 *      (to within a tenth), and stays where it is;
 *   2. in the export's own picture, the sticker at 2.5 s is that much bigger;
 *   3. followed again without it, the sticker keeps its own size;
 *      Stop following puts everything back.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'tracking-size');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** The square's side at `t` seconds, in pixels of the 1280x720 picture. */
const side = (t) => 2 * Math.trunc((80 + 30 * t) / 2);

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const video = join(work, 'growing.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x606060:s=1280x720:r=30:d=3',
    '-f', 'lavfi', '-i', 'testsrc2=s=240x240:r=30:d=3',
    '-filter_complex', "[1:v]scale=w='trunc((80+30*t)/2)*2':h='trunc((80+30*t)/2)*2':eval=frame[s];[0:v][s]overlay=x='(W-w)/2':y='(H-h)/2':eval=frame[v]",
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

    const own = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return (clip.fx?.base ?? clip.transform).scale.at(-1)?.value.x ?? 1;
    }, stickerId);
    const sizeAt = (frame) =>
      window.evaluate(
        ([id, f]) => {
          const clip = window.__scfStore.getState().project.clips[id];
          const transform = clip.fx?.base ?? clip.transform;
          const at = (keys) => {
            if (keys.length === 0) return null;
            if (f <= keys[0].frame) return keys[0].value;
            for (let i = 1; i < keys.length; i += 1) {
              if (f <= keys[i].frame) {
                const u = (f - keys[i - 1].frame) / (keys[i].frame - keys[i - 1].frame);
                return { x: keys[i - 1].value.x + (keys[i].value.x - keys[i - 1].value.x) * u, y: keys[i - 1].value.y + (keys[i].value.y - keys[i - 1].value.y) * u };
              }
            }
            return keys.at(-1).value;
          };
          return { scale: at(transform.scale)?.x ?? 1, position: at(transform.position) ?? { x: 0, y: 0 } };
        },
        [stickerId, frame],
      );

    const follow = async (withSize) => {
      await window.getByTestId('clip-fx-follow-mark').click();
      const overlay = window.getByTestId('track-box-overlay');
      await overlay.waitFor({ state: 'visible', timeout: 5_000 });
      const box = await overlay.boundingBox();
      const px = (x, y) => ({ x: box.x + (x / 1280) * box.width, y: box.y + (y / 720) * box.height });
      const a = px(640 - 38, 360 - 38);
      const b = px(640 + 38, 360 + 38);
      // The box offered sits over the sticker - here over the square too - so its corners are dragged onto the square's.
      const corner = async (grip, to) => {
        const handle = await window.getByTestId(`track-box-${grip}`).boundingBox();
        await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await window.mouse.down();
        await window.mouse.move(to.x, to.y, { steps: 6 });
        await window.mouse.up();
      };
      await corner('nw', a);
      await corner('se', b);
      const toggle = window.getByTestId('clip-fx-follow-size');
      if ((await toggle.isChecked()) !== withSize) await toggle.click();
      const before = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].transform, stickerId);
      await window.getByTestId('clip-fx-follow-run').click();
      await window.waitForFunction(([id, old]) => window.__scfStore.getState().project.clips[id].transform !== old && Boolean(window.__scfStore.getState().project.clips[id].tracking), [stickerId, before], { timeout: 60_000 }).catch(() => undefined);
      await window.waitForFunction(() => !/Following|Siguiendo/.test(document.querySelector('[data-testid="clip-fx-follow-hint"]')?.textContent ?? ''), null, { timeout: 60_000 }).catch(() => undefined);
    };

    console.log('1. following its size');
    const offered = await window.getByTestId('clip-fx-follow-mark').isVisible();
    await follow(true);
    const start = await sizeAt(0);
    const late = await sizeAt(75);
    const grew = late.scale / start.scale;
    const wanted = side(2.5) / side(0);
    check('the sticker grows as the square did, from its own size', offered && Math.abs(start.scale - own) < 0.01 && Math.abs(grew / wanted - 1) < 0.1, `grew ×${grew.toFixed(2)}, the square ×${wanted.toFixed(2)}`);
    check('and stays where it was, within 5 px of the tracker’s 320 px frames - a box marked by hand is never quite centred: the square grows in place', Math.hypot(late.position.x - start.position.x, late.position.y - start.position.y) < 20, JSON.stringify({ start: start.position, late: late.position }));

    console.log('2. in the export');
    const widths = await window.evaluate(async (id) => {
      const renderer = window.__scfRenderer();
      const whole = window.__scfStore.getState().project;
      const project = { ...whole, clips: { [id]: whole.clips[id] } };
      const measure = async (frame) => {
        const rgba = await renderer.renderExact(project, frame, true);
        let left = Infinity;
        let right = -Infinity;
        for (let y = 0; y < project.height; y += 2) {
          for (let x = 0; x < project.width; x += 1) {
            if (rgba[(y * project.width + x) * 4 + 3] > 128) {
              left = Math.min(left, x);
              right = Math.max(right, x);
            }
          }
        }
        return right - left;
      };
      renderer.beginExclusive();
      try {
        return { early: await measure(20), late: await measure(75) };
      } finally {
        renderer.endExclusive();
      }
    }, stickerId);
    const drawnGrowth = widths.late / widths.early;
    const shouldGrow = side(2.5) / side(20 / 30);
    check('in the export’s own picture the star is that much bigger at 2.5 s', Math.abs(drawnGrowth / shouldGrow - 1) < 0.12, `${widths.early} → ${widths.late} px (×${drawnGrowth.toFixed(2)}, the square ×${shouldGrow.toFixed(2)})`);

    console.log('3. position only, and stopping');
    await follow(false);
    const keptSize = await sizeAt(75);
    check('followed again without its size, it keeps its own size', Math.abs(keptSize.scale - own) < 0.01, `${keptSize.scale.toFixed(3)} against ${own.toFixed(3)}`);
    await window.getByTestId('clip-fx-follow-remove').click();
    await sleep(200);
    const after = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const transform = clip.fx?.base ?? clip.transform;
      return { tracking: clip.tracking, scaleKeys: transform.scale.length, positionKeys: transform.position.length };
    }, stickerId);
    check('Stop following puts its own size and place back', after.tracking === undefined && after.scaleKeys === 1 && after.positionKeys === 0, JSON.stringify(after));

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
