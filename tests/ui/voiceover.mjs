import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Voice-over, in the running app: `node tests/ui/voiceover.mjs`
 *
 * With Chromium's stand-in microphone (a steady beep) and a clip on the
 * timeline, the playhead at 1 s:
 *   1. the dialog shows the microphone's level moving;
 *   2. Record counts three, records about two seconds while the edit plays
 *      with its own sound off, and Stop puts the recording on a track of its
 *      own called Voice-over, on the dialogue bus, starting where the
 *      playhead was - the sound in it is the beep, not silence;
 *   3. the edit's sound is back on after.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'voiceover');
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
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const app = await electron.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
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
      s.setProjectSettings({ width: 640, height: 360, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().setCurrentFrame(30);
    });

    console.log('1. the microphone');
    await window.getByTestId('timeline-voiceover').click();
    await window.getByTestId('voiceover-dialog').waitFor({ state: 'visible', timeout: 5_000 });
    let loudest = 0;
    for (let i = 0; i < 20; i += 1) {
      loudest = Math.max(loudest, Number(await window.getByTestId('voiceover-meter').getAttribute('data-level')));
      await sleep(100);
    }
    check('the dialog shows the microphone’s level moving', loudest > 0.01, `peak ${loudest.toFixed(3)}`);

    console.log('2. recording');
    await window.getByTestId('voiceover-record').click();
    const counted = await window.getByTestId('voiceover-status').innerText();
    await window.getByTestId('voiceover-stop').waitFor({ state: 'visible', timeout: 6_000 });
    await sleep(400);
    const muted = await window.evaluate(() => ({ playing: window.__scfStore.getState().ui.isPlaying }));
    await sleep(1800);
    await window.getByTestId('voiceover-stop').click();
    const placed = await window.waitForFunction(() => window.__scfStore.getState().assets.some((a) => a.kind === 'audio'), null, { timeout: 30_000 }).then(() => true).catch(() => false);
    await sleep(500);
    const result = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const asset = s.assets.find((a) => a.kind === 'audio');
      const clip = Object.values(s.project.clips).find((c) => c.sourceUri === asset?.uri);
      const track = s.project.tracks.find((t) => t.id === clip?.trackId);
      return { name: asset?.name, path: asset?.sourcePath, seconds: asset?.durationSeconds, start: clip?.startFrame, track: track?.name, bus: track?.bus, type: track?.type, open: Boolean(document.querySelector('[data-testid="voiceover-dialog"]')) };
    });
    check('it counts three, then records while the edit plays', /^3$/.test(counted.trim()) && muted.playing, `"${counted.trim()}", playing ${muted.playing}`);
    check('Stop puts the recording on a track of its own, Voice-over, on the dialogue bus, where the playhead was',
      placed && result.type === 'audio' && result.track === 'Voice-over' && result.bus === 'dialogue' && result.start === 30 && result.seconds > 1.5 && result.seconds < 3.5 && !result.open,
      JSON.stringify(result));
    // volumedetect reports on stderr.
    const report = result.path ? spawnSync(ffmpeg, ['-hide_banner', '-i', result.path, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr : '';
    const measured = Number(/mean_volume: (-?[\d.]+)/.exec(report)?.[1] ?? NaN);
    check('the sound in it is the microphone’s, not silence', measured > -50, `${measured} dB`);

    console.log('3. after');
    const master = await window.evaluate(() => ({ playing: window.__scfStore.getState().ui.isPlaying }));
    check('the edit stops, and its sound is on again', !master.playing, JSON.stringify(master));

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
