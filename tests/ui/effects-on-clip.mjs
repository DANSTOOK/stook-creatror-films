import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The Effects panel's tiles on a frame of the user's own clip (block 8a):
 * `node tests/ui/effects-on-clip.mjs`
 *
 *   1. with no clip, the tiles show the sample, and say so;
 *   2. with a clip, they show it - the frame at the playhead, a new one when
 *      the playhead moves, the clip's middle when the playhead is off it - and
 *      say which clip and when;
 *   3. another clip selected, or none and the topmost under the playhead:
 *      the tiles follow the clip an effect would land on;
 *   4. Sample puts the sample back, and is remembered;
 *   5. nothing is taken while the preview plays;
 *   6. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'effects-on-clip');
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
  const make = (name, source) => {
    const file = join(work, name);
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', source, '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
    return file;
  };
  // A picture that changes all along, and another that is nothing like it.
  const files = [make('first.mp4', 'testsrc2=s=640x360:r=30'), make('second.mp4', 'mandelbrot=s=640x360:r=30')];
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
    // The two files in the library, none on the timeline yet.
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    await window.getByTestId('library-tab-effects').click();
    // One tile on screen to judge by: the sepia, still and plain to see.
    await window.getByTestId('library-effects-search').fill('sepia');
    await window.getByTestId('library-effect-sepia').waitFor({ state: 'visible', timeout: 10_000 });

    const caption = () => window.evaluate(() => {
      const element = document.querySelector('[data-testid="effects-preview-caption"]');
      return { text: element?.textContent ?? '', key: element?.dataset.key ?? '' };
    });
    const tile = () => window.evaluate(() => {
      const canvas = document.querySelector('[data-testid="library-effect-sepia"] canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0;
      for (let i = 0; i < data.length; i += 4 * 3) hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) % 1000003;
      return hash;
    });
    /** Waits until the caption's key matches `pattern`, then until the tile has been drawn again (it changes, or holds for 1.2 s). */
    const settled = async (pattern, before) => {
      await window.waitForFunction((source) => new RegExp(source).test(document.querySelector('[data-testid="effects-preview-caption"]')?.dataset.key ?? ''), pattern.source, { timeout: 15_000 }).catch(() => undefined);
      let hash = await tile();
      for (let wait = 0; wait < 30 && hash === before; wait += 1) {
        await sleep(150);
        hash = await tile();
      }
      await sleep(400);
      return { ...(await caption()), hash: await tile() };
    };

    /* 1. no clip: the sample ----------------------------------------------------------------------- */
    await sleep(1500);
    const empty = { ...(await caption()), hash: await tile() };
    check('with no clip, the tiles show the sample, and say so', empty.key === 'sample' && /sample picture/.test(empty.text), JSON.stringify(empty));

    /* 2. a clip: its frame at the playhead ------------------------------------------------------- */
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const tracks = s.project.tracks.filter((t) => t.type === 'video');
      const main = tracks.find((t) => t.order === 0);
      const top = tracks.find((t) => t.id !== main.id);
      const first = s.addAssetToTimeline(s.assets.find((a) => a.name === 'first.mp4'), main.id, 0);
      const second = s.addAssetToTimeline(s.assets.find((a) => a.name === 'second.mp4'), top.id, 0);
      window.__scfStore.getState().selectClips([first]);
      window.__scfStore.getState().setCurrentFrame(60);
      return { first, second };
    });
    const onFirst = await settled(new RegExp(`^${ids.first}@60#`), empty.hash);
    check('with a clip, the tiles show it, at the playhead, and say which and when',
      onFirst.hash !== empty.hash && /first\.mp4/.test(onFirst.text) && /0:02/.test(onFirst.text), `${onFirst.text} | ${onFirst.key}`);

    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(180));
    const later = await settled(new RegExp(`^${ids.first}@180#`), onFirst.hash);
    check('the playhead moved on the clip: a new frame', later.hash !== onFirst.hash && /0:06/.test(later.text), `${later.text}`);

    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(400));
    const off = await settled(new RegExp(`^${ids.first}@120#`), later.hash);
    check('the playhead off the selected clip: the clip\'s middle', off.key.startsWith(`${ids.first}@120#`) && /0:04/.test(off.text), `${off.text} | ${off.key}`);

    /* 3. the clip an effect would land on -------------------------------------------------------- */
    await window.evaluate((second) => window.__scfStore.getState().selectClips([second]), ids.second);
    const other = await settled(new RegExp(`^${ids.second}@`), off.hash);
    check('another clip selected: the tiles show that one', other.hash !== off.hash && /second\.mp4/.test(other.text), other.text);
    await window.evaluate(() => {
      window.__scfStore.getState().selectClips([]);
      window.__scfStore.getState().setCurrentFrame(60);
    });
    const top = await settled(new RegExp(`^${ids.second}@60#`), other.hash);
    check('none selected: the topmost clip under the playhead, as the effect would land', top.key.startsWith(`${ids.second}@60#`), top.key);

    /* 4. the sample, by choice ----------------------------------------------------------------------- */
    await window.getByTestId('effects-preview-sample').click();
    const sample = await settled(/^sample$/, top.hash);
    await window.getByTestId('library-tab-media').click();
    await sleep(300);
    await window.getByTestId('library-tab-effects').click();
    await window.getByTestId('library-effects-search').fill('sepia');
    await sleep(600);
    const remembered = await window.getByTestId('effects-preview-sample').getAttribute('aria-pressed');
    check('Sample puts the sample back, and is remembered', sample.key === 'sample' && sample.hash === empty.hash && remembered === 'true', `${sample.hash} vs ${empty.hash}; ${remembered}`);
    await window.getByTestId('effects-preview-clip').click();
    const back = await settled(new RegExp(`^${ids.second}@60#`), sample.hash);
    check('and Your clip brings the clip back', back.hash === top.hash, `${back.hash} vs ${top.hash}`);

    /* 5. not while playing --------------------------------------------------------------------------- */
    const keyBefore = (await caption()).key;
    await window.evaluate(() => window.__scfStore.getState().setPlaying(true));
    await sleep(1500);
    const whilePlaying = (await caption()).key;
    await window.evaluate(() => window.__scfStore.getState().setPlaying(false));
    const afterPlaying = await settled(new RegExp(`^${ids.second}@(?!60#)`), back.hash);
    check('nothing is taken while the preview plays, and the new frame once it stops', whilePlaying === keyBefore && afterPlaying.key !== keyBefore, `${keyBefore} -> ${whilePlaying} -> ${afterPlaying.key}`);

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
