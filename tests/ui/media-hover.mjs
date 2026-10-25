import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * A video in the media panel plays while the pointer rests on it, muted and
 * on a loop, as CapCut's does: `node tests/ui/media-hover.mjs`
 *
 *   1. resting on a video's thumbnail plays it, muted and looping, fading in
 *      over the poster; the proxy when there is one; a bar along the bottom
 *      follows it;
 *   2. it goes when the pointer leaves, and a pointer passing over plays nothing;
 *   3. one at a time; never an image or a sound;
 *   4. not while the preview plays - and it stops when the preview starts -
 *      nor with less motion asked for; dragging the clip away stops it;
 *   5. nothing in the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'media-hover');
const logs = join(work, 'logs');
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
  const make = (name, args) => {
    const file = join(work, name);
    execFileSync(ffmpeg, ['-y', '-v', 'error', ...args, file]);
    return file;
  };
  const files = [
    make('first.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']),
    make('second.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']),
    make('still.png', ['-f', 'lavfi', '-i', 'testsrc=s=640x360:d=1', '-frames:v', '1']),
    make('tone.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=4:sample_rate=48000']),
  ];
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(
      () => {
        const { assets } = window.__scfStore.getState();
        return assets.length === 4 && assets.filter((asset) => asset.kind !== 'audio').every((asset) => asset.thumbnailUri);
      },
      null,
      { timeout: 60_000 },
    );
    await sleep(800);

    const tile = (name) => window.locator('[data-testid="media-panel"] li[role="option"]', { hasText: name });
    /** The pointer on a thumbnail's lower left: clear of the add and remove buttons in its top corner. */
    const restOn = async (name) => {
      const box = await tile(name).locator('span').first().boundingBox();
      await window.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.7);
    };
    const away = async () => {
      const box = await window.getByTestId('preview-panel').boundingBox();
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };
    const playback = () => window.evaluate(() => {
      const videos = [...document.querySelectorAll('[data-testid="tile-playback"]')];
      const video = videos[0];
      if (!video) return { count: 0 };
      return {
        count: videos.length,
        tile: video.closest('li')?.textContent ?? '',
        src: video.currentSrc || video.src,
        muted: video.muted,
        loop: video.loop,
        paused: video.paused,
        time: video.currentTime,
        opacity: Number(getComputedStyle(video).opacity),
        bar: video.parentElement?.querySelector('span > span[style]')?.style.transform ?? '',
      };
    });
    const uriOf = (name) => window.evaluate((wanted) => window.__scfStore.getState().assets.find((asset) => asset.name === wanted)?.uri, name);

    /* 1. resting on a video plays it ------------------------------------------------- */
    await restOn('first.mp4');
    await sleep(1200);
    const first = await playback();
    await sleep(600);
    const later = await playback();
    check('resting on a video\'s thumbnail plays it there, muted and on a loop, from the clip\'s file',
      first.count === 1 && first.tile.includes('first.mp4') && first.muted && first.loop && !first.paused && first.src === (await uriOf('first.mp4')),
      JSON.stringify({ count: first.count, muted: first.muted, loop: first.loop, paused: first.paused, sameFile: first.src === (await uriOf('first.mp4')) }));
    check('its picture moves on, and it has faded in over the poster', later.time > first.time + 0.3 && later.opacity === 1, `${first.time?.toFixed(2)} s then ${later.time?.toFixed(2)} s, opacity ${later.opacity}`);
    check('a bar along the bottom follows how far through the clip it is', /^scaleX\(0\.\d+/.test(later.bar) && Number(later.bar.slice(7, -1)) > 0.05, later.bar);

    /* 2. leaving, and passing over ---------------------------------------------------------- */
    await away();
    await sleep(300);
    check('it goes the moment the pointer leaves', (await playback()).count === 0);
    await restOn('first.mp4');
    await sleep(80);
    await away();
    await sleep(700);
    check('a pointer passing over plays nothing', (await playback()).count === 0);

    /* 3. one at a time; never an image or a sound -------------------------------------- */
    await restOn('first.mp4');
    await sleep(900);
    await restOn('second.mp4');
    await sleep(900);
    const swapped = await playback();
    check('one at a time: the next video takes over', swapped.count === 1 && swapped.tile.includes('second.mp4'), JSON.stringify({ count: swapped.count, tile: swapped.tile.slice(0, 20) }));
    await restOn('still.png');
    await sleep(900);
    const onStill = await playback();
    await restOn('tone.wav');
    await sleep(900);
    const onTone = await playback();
    check('an image and a sound play nothing', onStill.count === 0 && onTone.count === 0, `${onStill.count} ${onTone.count}`);

    /* 1b. the proxy when there is one ------------------------------------------------ */
    // Any lighter file stands in: the second clip's, given to the first as its proxy.
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const [one, two] = ['first.mp4', 'second.mp4'].map((name) => s.assets.find((asset) => asset.name === name));
      s.setAssetProxy(one.id, two.uri);
    });
    await away();
    await restOn('first.mp4');
    await sleep(900);
    const proxied = await playback();
    check('with a proxy, the proxy plays: lighter to decode', proxied.count === 1 && proxied.src === (await uriOf('second.mp4')), proxied.src?.slice(-40));

    /* 4. never in the way ------------------------------------------------------------------------ */
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.addAssetToTimeline(s.assets.find((asset) => asset.name === 'first.mp4'), s.project.tracks.find((t) => t.type === 'video' && t.order === 0).id, 0);
    });
    await window.evaluate(() => window.__scfStore.getState().setPlaying(true));
    await sleep(500);
    const stoppedByPlay = await playback();
    await away();
    await restOn('second.mp4');
    await sleep(900);
    const duringPlay = await playback();
    const wasPlaying = await window.evaluate(() => document.documentElement.hasAttribute('data-playing'));
    await window.evaluate(() => window.__scfStore.getState().setPlaying(false));
    check('the preview starting stops it, and nothing plays while the preview does', wasPlaying && stoppedByPlay.count === 0 && duringPlay.count === 0, `playing ${wasPlaying}, ${stoppedByPlay.count} ${duringPlay.count}`);

    await away();
    await window.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    await restOn('second.mp4');
    await sleep(900);
    const reduced = await playback();
    await window.evaluate(() => document.documentElement.setAttribute('data-motion', 'full'));
    check('with less motion asked for, nothing plays', reduced.count === 0);

    await away();
    await restOn('second.mp4');
    await sleep(900);
    const beforeDrag = await playback();
    const transfer = await window.evaluateHandle(() => new DataTransfer());
    await tile('second.mp4').dispatchEvent('dragstart', { dataTransfer: transfer });
    await sleep(300);
    await tile('second.mp4').dispatchEvent('dragend', { dataTransfer: transfer });
    check('dragging the clip away stops it', beforeDrag.count === 1 && (await playback()).count === 0, `${beforeDrag.count} before`);

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  const errors = existsSync(logs)
    ? readdirSync(logs).flatMap((name) => readFileSync(join(logs, name), 'utf8').split('\n')).filter((line) => / ERROR /.test(line))
    : [];
  check('nothing in the app\'s log', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300));
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
