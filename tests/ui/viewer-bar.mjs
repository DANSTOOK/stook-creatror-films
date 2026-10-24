import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The viewer's bar, the way CapCut's player has it: `node tests/ui/viewer-bar.mjs`
 *
 *   1. under the picture: the time on the left; in the middle to the start, a
 *      frame back, a big round play - exactly in the middle - a frame on and
 *      to the end; on the right loop, safe areas, the frame's shape, the
 *      playback quality and full screen;
 *   2. play plays and pauses;
 *   3. the shape menu says 16:9 for a 1920×1080 edit, and 9:16 makes it
 *      1080×1920 with the 16:9 video whole in it - black above and below, the
 *      picture in the middle, not squeezed - and one undo puts it all back;
 *   4. a frame of no listed shape shows as itself;
 *   5. Project settings' vertical preset fits the video too, instead of
 *      squeezing it, and so does a width typed into its field.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'viewer-bar');
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
  // Bright colour bars: no black anywhere in the picture itself.
  const video = join(work, 'bars.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'smptehdbars=s=1920x1080:r=30:d=4', '-vf', 'eq=brightness=0.25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
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
    const clipId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1920, height: 1080, fps: 30 });
      const main = s.project.tracks.find((t) => t.type === 'video' && t.order === 0);
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets[0], main.id, 0);
      window.__scfStore.getState().setCurrentFrame(30);
      window.__scfStore.getState().selectClips([]);
      return id;
    });
    await sleep(1200);

    /* 1. the bar's layout ------------------------------------------------------ */
    const layout = await window.evaluate(() => {
      const footer = document.querySelector('[data-testid="viewer-footer"]');
      const box = (element) => element?.getBoundingClientRect();
      const play = box(document.querySelector('[data-testid="viewer-play"]'));
      const bar = box(footer);
      const time = box(document.querySelector('[data-testid="viewer-timecode"]'));
      const right = ['viewer-loop', 'toggle-safe-areas', 'viewer-aspect', 'viewer-quality', 'fullscreen-viewer'].map((id) => {
        const element = document.querySelector(`[data-testid="${id}"]`);
        return { id, inFooter: Boolean(element && footer.contains(element)), left: element ? box(element).left : 0 };
      });
      const header = document.querySelector('[data-testid="preview-panel"] header');
      return {
        playCentre: play ? play.left + play.width / 2 : 0,
        playRound: play ? Math.abs(play.width - play.height) < 1 && play.width >= 34 : false,
        barCentre: bar.left + bar.width / 2,
        barWidth: bar.width,
        timeLeft: time ? time.left - bar.left : -1,
        right,
        rightOfPlay: right.every((entry) => entry.left > (play?.right ?? 0)),
        headerTools: ['viewer-loop', 'toggle-safe-areas'].some((id) => header?.contains(document.querySelector(`[data-testid="${id}"]`))),
        transport: [...footer.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? '').filter((name) => /^(Go to start|Previous frame|Play|Pause|Next frame|Go to end)$/.test(name)),
        buttons: footer.querySelectorAll('button').length,
      };
    });
    check('the play is big and round, in the middle of the bar', layout.playRound && Math.abs(layout.playCentre - layout.barCentre) < layout.barWidth * 0.02, `play at ${Math.round(layout.playCentre)}, bar centre ${Math.round(layout.barCentre)}`);
    check('the time is on the left', layout.timeLeft >= 0 && layout.timeLeft < 30, `${Math.round(layout.timeLeft)} px in`);
    check('loop, safe areas, the shape, the quality and full screen are on the right', layout.right.every((entry) => entry.inFooter) && layout.rightOfPlay, JSON.stringify(layout.right));
    check('every transport button is in the bar - to the start, a frame back, play, a frame on, to the end - and none up in the header',
      layout.transport.join('|') === 'Go to start|Previous frame|Play|Next frame|Go to end' && !layout.headerTools && layout.buttons === 8,
      `${layout.transport.join(' / ')}; ${layout.buttons} buttons in the bar`);

    /* 2. play and pause --------------------------------------------------------- */
    await window.getByTestId('viewer-play').click();
    await sleep(400);
    const playing = await window.evaluate(() => window.__scfStore.getState().ui.isPlaying);
    await window.getByTestId('viewer-play').click();
    await sleep(300);
    const paused = await window.evaluate(() => !window.__scfStore.getState().ui.isPlaying);
    check('play plays and pauses', playing && paused);
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(30));
    await sleep(600);

    /* 3. the shape menu --------------------------------------------------------- */
    const shape = () => window.evaluate(() => ({ menu: document.querySelector('[data-testid="viewer-aspect"]').value, width: window.__scfStore.getState().project.width, height: window.__scfStore.getState().project.height }));
    const before = await shape();
    check('a 1920×1080 edit is 16:9', before.menu === '16:9', JSON.stringify(before));
    const scaleOf = () => window.evaluate((id) => {
      const keys = window.__scfStore.getState().project.clips[id].transform.scale;
      return keys.length ? keys[keys.length - 1].value : { x: 1, y: 1 };
    }, clipId);
    /** Brightness down the middle of the viewer's picture, top to bottom, from what the renderer draws. */
    const column = () => window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      await renderer.renderExact(project, project.currentFrame, false);
      const pixels = await renderer.renderExact(project, project.currentFrame, false);
      const at = (fraction) => {
        const y = Math.min(project.height - 1, Math.floor(project.height * fraction));
        const index = (y * project.width + Math.floor(project.width / 2)) * 4;
        return Math.round((pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3);
      };
      return { top: at(0.05), middle: at(0.5), bottom: at(0.95) };
    });
    await window.getByTestId('viewer-aspect').selectOption('9:16');
    await sleep(800);
    const vertical = await shape();
    const scale = await scaleOf();
    const picture = await column();
    check('9:16 makes the edit 1080×1920', vertical.width === 1080 && vertical.height === 1920 && vertical.menu === '9:16', JSON.stringify(vertical));
    check('the 16:9 video keeps its shape in it: as wide as the frame, its own height', Math.abs(scale.x - 1) < 1e-3 && Math.abs(scale.y - (1080 / 1920) * (1080 / 1920)) < 1e-3, JSON.stringify(scale));
    check('black above and below it, the picture in the middle', picture.top < 12 && picture.bottom < 12 && picture.middle > 40, JSON.stringify(picture));
    await window.locator('[data-testid="viewer-timecode"]').click();
    await window.keyboard.press('Control+z');
    await sleep(600);
    const undone = await shape();
    const scaleBack = await scaleOf();
    check('one undo puts the frame and the video back', undone.width === 1920 && undone.height === 1080 && Math.abs(scaleBack.x - 1) < 1e-6 && Math.abs(scaleBack.y - 1) < 1e-6, `${JSON.stringify(undone)} ${JSON.stringify(scaleBack)}`);

    /* 4. a shape of its own ------------------------------------------------------ */
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1440, height: 1080 }));
    await sleep(300);
    const own = await window.evaluate(() => {
      const select = document.querySelector('[data-testid="viewer-aspect"]');
      return { value: select.value, text: select.selectedOptions[0]?.textContent };
    });
    check('a frame of no listed shape shows as itself', own.value === 'custom' && own.text === '1440×1080', JSON.stringify(own));
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);

    /* 5. Project settings fit the video too ------------------------------------- */
    await window.evaluate(() => window.filmora.appMenuInvoke?.('projectSettings'));
    let settings = window.locator('div.panel', { hasText: 'Project settings' });
    if (!(await settings.isVisible().catch(() => false))) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'projectSettings'));
      settings = window.locator('div.panel', { hasText: 'Project settings' });
    }
    await settings.waitFor({ state: 'visible', timeout: 10_000 });
    await settings.locator('label', { hasText: 'Preset' }).locator('select').selectOption('1080 x 1920 (vertical)');
    await sleep(400);
    const preset = await scaleOf();
    check('Project settings\' vertical preset fits the video instead of squeezing it', Math.abs(preset.y - (1080 / 1920) * (1080 / 1920)) < 1e-3, JSON.stringify(preset));
    await settings.locator('label', { hasText: 'Width' }).locator('input').fill('1920');
    await settings.locator('label', { hasText: 'Height' }).locator('input').fill('1080');
    await settings.getByRole('button', { name: 'Done' }).click();
    await sleep(400);
    const typed = await shape();
    const typedScale = await scaleOf();
    check('a size typed into its fields does too, once the field is left', typed.width === 1920 && typed.height === 1080 && Math.abs(typedScale.y - 1) < 1e-3, `${JSON.stringify(typed)} ${JSON.stringify(typedScale)}`);

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
