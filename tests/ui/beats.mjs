import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Cut to the beat, in the running app: `node tests/ui/beats.mjs`
 *
 * Eight seconds of a kick drum at 120 beats a minute (a beat each half
 * second) on the audio track, under a ten-second video:
 *   1. the music clip's Audio tab opens "Cut to the beat", which hears
 *      120 BPM and counts a cut a beat; "every bar" counts a quarter of them;
 *   2. "Add markers" puts a beat marker on each, every 15 frames;
 *   3. "Cut the pictures" cuts the video at each beat - a shot a beat - as
 *      one undo step.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'beats');
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
  const video = join(work, 'shots.mp4');
  const music = join(work, 'drums.wav');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*60*mod(t,0.5))*exp(-mod(t,0.5)*30)+0.01*sin(2*PI*220*t)':s=44100:d=8", '-c:a', 'pcm_s16le', music]);

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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video, music]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 640, height: 360, fps: 30 });
      const picture = s.project.tracks.find((t) => t.type === 'video');
      const sound = s.project.tracks.find((t) => t.type === 'audio');
      const v = window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.kind === 'video'), picture.id, 0);
      const m = window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.kind === 'audio'), sound.id, 0);
      window.__scfStore.getState().setUi({ selectedClipIds: [m] });
      return { v, m };
    });
    await sleep(500);

    console.log('1. hearing the beat');
    await window.locator('[role="tab"]').filter({ hasText: /^Audio$/ }).first().click();
    await window.getByTestId('inspector-beats').click();
    await window.getByTestId('beat-dialog').waitFor({ state: 'visible', timeout: 5_000 });
    await window.getByTestId('beat-bpm').waitFor({ state: 'visible', timeout: 30_000 });
    const bpm = (await window.getByTestId('beat-bpm').innerText()).trim();
    const everyBeat = Number(/\d+/.exec(await window.getByTestId('beat-count').innerText())?.[0]);
    await window.getByTestId('beat-every-4').click();
    const everyBar = Number(/\d+/.exec(await window.getByTestId('beat-count').innerText())?.[0]);
    check('it hears 120 BPM and a cut a beat; every bar is a quarter of them', bpm === '120 BPM' && everyBeat >= 15 && everyBeat <= 16 && Math.abs(everyBar - everyBeat / 4) <= 1, `${bpm}, ${everyBeat} beats, ${everyBar} bars`);
    await window.getByTestId('beat-every-1').click();

    console.log('2. markers');
    await window.getByTestId('beat-mark').click();
    await sleep(400);
    const markers = await window.evaluate(() => window.__scfStore.getState().project.markers.map((m) => m.frame));
    const spaced = markers.slice(1).every((frame, i) => Math.abs(frame - markers[i] - 15) <= 1);
    check('a beat marker on each beat, every 15 frames', markers.length === everyBeat && spaced, markers.join(','));

    console.log('3. cutting the pictures');
    await window.getByTestId('inspector-beats').click();
    await window.getByTestId('beat-bpm').waitFor({ state: 'visible', timeout: 30_000 });
    await window.getByTestId('beat-cut').click();
    await sleep(400);
    const shots = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const picture = s.project.tracks.find((t) => t.type === 'video');
      return Object.values(s.project.clips).filter((c) => c.trackId === picture.id).map((c) => [c.startFrame, c.durationFrames]).sort((a, b) => a[0] - b[0]);
    });
    const music15 = shots.filter(([start]) => start < 240).every(([, length], index, all) => index === all.length - 1 || Math.abs(length - 15) <= 1);
    check('the video is cut at each beat over the music: a shot a beat', shots.length >= everyBeat && music15, JSON.stringify(shots.slice(0, 5)) + '…');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const back = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).length);
    check('one undo takes the cuts back', back === 2, `${back} clips`);

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
