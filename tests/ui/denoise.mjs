import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Reduce noise, in the running app: `node tests/ui/denoise.mjs`
 *
 * A clip whose sound is a tone for its first second over a steady hiss that
 * runs all through it - a voice in a noisy room, in miniature:
 *   1. the Audio tab's "Strong" makes a cleaned sound and plays it in place
 *      of the original: the hiss alone is at least 15 dB quieter, the tone
 *      within 3 dB of what it was;
 *   2. "Off" puts the original sound back.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'denoise');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** RMS level in dBFS of `path` between `from` and `to` seconds. */
const level = (path, from, to) => {
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', path, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  let sum = 0;
  const n = pcm.length / 2;
  for (let i = 0; i < n; i += 1) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return 10 * Math.log10(sum / Math.max(1, n) + 1e-12);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const video = join(work, 'noisy.mp4');
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=4',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,1),0.4*sin(2*PI*440*t),0)':s=48000:d=4",
    '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.06:d=4:r=48000',
    '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', video,
  ]);
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
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().setUi({ selectedClipIds: [id] });
    });
    await sleep(500);
    const originalUri = await window.evaluate(() => window.__scfStore.getState().assets[0].audioUri);

    console.log('1. strong');
    await window.locator('[role="tab"]').filter({ hasText: /^Audio$/ }).first().click();
    await window.getByTestId('inspector-denoise-strong').click();
    await window.waitForFunction(() => window.__scfStore.getState().assets[0].denoise === 'strong', null, { timeout: 60_000 });
    const cleanedUri = await window.evaluate(() => window.__scfStore.getState().assets[0].audioUri);
    const folder = join(profile, 'scf', 'clean');
    const cleaned = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.m4a') && !name.includes('building')) : [];
    const cleanedPath = cleaned.length > 0 ? join(folder, cleaned[0]) : '';
    const before = { hiss: level(video, 1.5, 3.5), tone: level(video, 0.2, 0.8) };
    const after = cleanedPath ? { hiss: level(cleanedPath, 1.5, 3.5), tone: level(cleanedPath, 0.2, 0.8) } : { hiss: 0, tone: -99 };
    check('Strong plays a cleaned sound in place of the original', Boolean(cleanedPath) && cleanedUri !== originalUri, cleaned.join(', '));
    check('the hiss alone is at least 15 dB quieter, the tone within 3 dB',
      before.hiss - after.hiss >= 15 && Math.abs(before.tone - after.tone) <= 3,
      `hiss ${before.hiss.toFixed(1)} → ${after.hiss.toFixed(1)} dB, tone ${before.tone.toFixed(1)} → ${after.tone.toFixed(1)} dB`);

    console.log('2. off');
    await window.getByTestId('inspector-denoise-off').click();
    await window.waitForFunction(() => window.__scfStore.getState().assets[0].denoise === undefined, null, { timeout: 30_000 });
    const back = await window.evaluate(() => window.__scfStore.getState().assets[0].audioUri);
    check('Off puts the original sound back', back === originalUri, `${back === originalUri ? 'the original' : back}`);

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
