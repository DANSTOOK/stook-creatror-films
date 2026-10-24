import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Panels in windows of their own use the room they have:
 * `node tests/ui/detached-fill.mjs`
 *
 *   1. Docked, a timeline's picture rows are 70 px and the rest 42 px - the
 *      56 px base, picture tracks taller and the others lower, as CapCut has them.
 *   2. In a window of its own, a few tracks grow to fill it, rather than three
 *      thin rows over an empty half-window - and the clip's pictures grow with
 *      them, over the whole clip when its sound is silence.
 *      The viewer left behind gets a scrubber of its own.
 *   3. The media library in a window of its own puts a place to drop more
 *      files in the room under its clips.
 *
 * Needs a build (npm run build). The windows are never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'detached-fill');
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
  // A picture and a silent sound track, as a camera records with no microphone.
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
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
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const track = s.project.tracks.find((t) => t.type === 'video');
      window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
    });
    await window.waitForFunction(() => Object.keys(window.__scfMediaStore.getState().filmstrips).length > 0, null, { timeout: 60_000 });
    await sleep(500);
    /**
     * Each track header's height, with its track's kind: the rows are as tall
     * as their headers. The kinds come from the editor's window - a panel in a
     * window of its own has no test hooks - and the heights from `page`.
     */
    const rowHeights = async (page) => {
      const kinds = await window.evaluate(() => Object.fromEntries(window.__scfStore.getState().project.tracks.map((track) => [track.id, track.type])));
      return page.evaluate((known) => [...document.querySelectorAll('[data-testid^="track-header-"]')].map((row) => ({
        type: known[row.dataset.testid.replace('track-header-', '')] ?? '?',
        h: Math.round(row.getBoundingClientRect().height),
      })), kinds);
    };
    const docks = { video: 70, other: 42 };
    const dockedHeight = (type) => (type === 'video' ? docks.video : docks.other);
    const list = (rows) => rows.map((row) => `${row.type} ${row.h}`).join(', ');

    console.log('1. docked');
    const docked = await rowHeights(window);
    check('docked, picture rows are 70 px and the rest 42', docked.length >= 3 && docked.every((row) => row.h === dockedHeight(row.type)), list(docked));

    console.log('2. the timeline in a window of its own');
    await window.getByTestId('detach-timeline').click();
    await sleep(1500);
    const timelineWindow = app.windows().find((page) => page !== window);
    const tall = timelineWindow ? await rowHeights(timelineWindow) : [];
    const used = timelineWindow
      ? await timelineWindow.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-testid^="track-header-"]')];
          const last = rows.at(-1).getBoundingClientRect();
          return Math.round((last.bottom / innerHeight) * 100);
        })
      : 0;
    check('a few tracks grow to fill the window: the rows reach most of the way down', tall.length >= 3 && tall.every((row) => row.h > dockedHeight(row.type)) && used >= 75, `${list(tall)} px, rows reach ${used}% down`);
    const picture = timelineWindow
      ? await timelineWindow.evaluate(() => {
          // The clip's lower part: pictures (varied colour) rather than a flat band.
          const canvas = document.querySelector('canvas');
          const context = canvas.getContext('2d');
          const rows = [...document.querySelectorAll('[data-testid^="track-header-"]')];
          const v1 = rows[1].getBoundingClientRect();
          const box = canvas.getBoundingClientRect();
          const scale = canvas.width / box.width;
          const y = Math.round((v1.bottom - box.top - 10) * scale);
          const colours = new Set();
          for (let x = 20; x < Math.min(600, canvas.width); x += 7) {
            const [r, g, b] = context.getImageData(x, y, 1, 1).data;
            colours.add(`${r >> 4},${g >> 4},${b >> 4}`);
          }
          return colours.size;
        })
      : 0;
    check('a clip whose sound is silence shows its pictures down to its bottom edge', picture > 8, `${picture} distinct colours along the bottom`);
    // The viewer left behind gets a way along the edit of its own.
    const scrubber = window.getByTestId('viewer-scrubber');
    const shown = await scrubber.isVisible().catch(() => false);
    if (shown) await scrubber.fill('60');
    const frame = await window.evaluate(() => window.__scfStore.getState().project.currentFrame);
    check('the viewer left in the editor gets a scrubber, and it moves the playhead', shown && frame === 60, `shown ${shown}, frame ${frame}`);
    await timelineWindow?.getByTestId('dock-timeline').click().catch(() => undefined);
    await sleep(800);

    console.log('3. the library in a window of its own');
    await window.getByTestId('detach-media').click();
    await sleep(1500);
    const libraryWindow = app.windows().find((page) => page !== window);
    const drop = libraryWindow
      ? await libraryWindow.evaluate(() => {
          const zone = document.querySelector('[data-testid="media-drop-more"]');
          if (!zone) return null;
          const box = zone.getBoundingClientRect();
          return { height: Math.round(box.height), bottom: Math.round(innerHeight - box.bottom), text: zone.textContent };
        })
      : null;
    check('the room under the clips is a place to drop more, down to the window’s foot', Boolean(drop) && drop.height > 300 && drop.bottom < 30 && /Drop more files/.test(drop.text), JSON.stringify(drop));
    await libraryWindow?.getByTestId('dock-media').click().catch(() => undefined);

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
