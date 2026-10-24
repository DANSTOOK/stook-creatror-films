import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * A GIF and the sound alone, from the Export dialog: `node tests/ui/export-extras.mjs`
 *
 * A two-second clip of a test pattern with a 440 Hz tone, exported to a
 * folder of the test's own:
 *   1. "Export GIF" at 480 px and 15 fps writes a looping GIF that wide, of
 *      about 30 frames, and nothing else is left in the folder;
 *   2. "Export MP3" writes a two-second MP3 whose sound is the tone - and
 *      renders no picture to do it; "Export WAV" a 16-bit WAV.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'export-extras');
const out = join(work, 'out');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** What ffmpeg says about a file: stream lines and duration. */
const probe = (path) => {
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return String(error.stderr ?? '');
  }
  return '';
};
const frames = (path) => {
  // ffmpeg reports its progress on stderr.
  return spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const video = join(work, 'tone.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);

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
      s.setProjectSettings({ width: 1280, height: 720, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
    });
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, out);
    await window.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = window.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByLabel('Start frame').fill('0');
    await dialog.getByLabel('End frame').fill('60');
    await dialog.getByLabel('File name').fill('clip');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(400);
    // The presets, networks, GIF and the rest are under More settings, folded until opened.
    const more = dialog.getByTestId('export-more');
    if ((await more.getAttribute('aria-expanded')) === 'false') await more.click();

    console.log('1. a GIF');
    await dialog.getByTestId('export-gif-width').selectOption('480');
    await dialog.getByTestId('export-gif-fps').selectOption('15');
    await dialog.getByTestId('export-gif').click();
    const gif = join(out, 'clip.gif');
    const madeGif = await (async () => {
      for (let i = 0; i < 240; i += 1) {
        if (existsSync(gif) && !(await window.evaluate(() => document.body.textContent?.includes('Making the GIF')))) return true;
        await sleep(500);
      }
      return false;
    })();
    await sleep(500);
    const gifInfo = madeGif ? probe(gif) : '';
    // The last progress line has the count; the first says 0.
    const gifFrames = madeGif ? Number([...frames(gif).matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1] ?? 0) : 0;
    const left = readdirSync(out);
    check('a GIF 480 px wide, about 30 frames, looping, and no video left behind',
      madeGif && /Video: gif/.test(gifInfo) && /480x270/.test(gifInfo) && gifFrames >= 27 && gifFrames <= 33 && left.join('|') === 'clip.gif',
      `${madeGif ? `${gifFrames} frames, ${statSync(gif).size} bytes` : 'none'}; folder: ${left.join(', ')}`);
    const shown = await dialog.getByText('clip.gif').first().isVisible().catch(() => false);
    check('the result says the GIF was made, by name', shown);

    console.log('2. the sound alone');
    // Back to the form for the next file.
    await dialog.getByRole('button', { name: /Export another|New export|Back/ }).first().click().catch(() => undefined);
    await sleep(300);
    const mp3 = join(out, 'clip.mp3');
    await window.evaluate(() => {
      window.__framesSent = 0;
      const original = window.filmora.exportFrame;
      window.filmora.exportFrame = (...args) => {
        window.__framesSent += 1;
        return original(...args);
      };
    });
    await dialog.getByTestId('export-audio-mp3').click();
    await dialog.getByTestId('export-audio').click();
    await window.waitForFunction(() => document.body.textContent?.includes('clip.mp3'), null, { timeout: 120_000 }).catch(() => undefined);
    await sleep(500);
    const mp3Info = existsSync(mp3) ? probe(mp3) : '';
    const seconds = Number(/Duration: 00:00:(\d+\.\d+)/.exec(mp3Info)?.[1] ?? 0);
    const tone = existsSync(mp3)
      ? execFileSync(ffmpeg, ['-v', 'error', '-i', mp3, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 })
      : Buffer.alloc(0);
    // Zero crossings a second of a 440 Hz tone: 880.
    let crossings = 0;
    for (let i = 2; i < tone.length / 2; i += 1) {
      const a = tone.readInt16LE((i - 1) * 2);
      const b = tone.readInt16LE(i * 2);
      if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings += 1;
    }
    const hertz = seconds > 0 ? crossings / 2 / seconds : 0;
    const sent = await window.evaluate(() => window.__framesSent);
    check('an MP3 of the two seconds whose sound is the tone, with no picture rendered for it',
      /Audio: mp3/.test(mp3Info) && Math.abs(seconds - 2) < 0.15 && Math.abs(hertz - 440) < 15 && sent === 0,
      `${seconds.toFixed(2)} s, ${hertz.toFixed(0)} Hz, ${sent} frames rendered`);
    await dialog.getByRole('button', { name: /Export another|New export|Back/ }).first().click().catch(() => undefined);
    await sleep(300);
    await dialog.getByTestId('export-audio-wav').click();
    await dialog.getByTestId('export-audio').click();
    const wav = join(out, 'clip.wav');
    await window.waitForFunction(() => document.body.textContent?.includes('clip.wav'), null, { timeout: 120_000 }).catch(() => undefined);
    await sleep(500);
    const wavInfo = existsSync(wav) ? probe(wav) : '';
    check('a 16-bit WAV the same way', /Audio: pcm_s16le/.test(wavInfo), (wavInfo.match(/Audio:[^\n]*/) ?? [''])[0]);

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
