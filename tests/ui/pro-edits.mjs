import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Premiere's ripple keys, Enhance voice and the user's own templates, in the
 * running app: `node tests/ui/pro-edits.mjs`
 *
 *   1. with the magnet off, Shift+Delete still closes the gap a clip leaves;
 *      Q trims the clip under the playhead to it at its start and W at its
 *      end, what follows closing up; each one undo step;
 *   2. Enhance voice turns a quiet, uneven voice into one at about -16 LUFS,
 *      its peaks held under -1 dB;
 *   3. File > Save as template keeps the project; the start screen lists it
 *      under My templates; opening it is a new, untitled project with the
 *      same clips.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'pro-edits');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const loudness = (path) => Number(spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/)?.[1]);
const peak = (path) => Number(spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1]);

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  // A quiet voice, uneven: a buzzy tone rising and falling, now loud, now soft, with pauses.
  const voice = join(work, 'voice.wav');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.05*(0.3+0.7*abs(sin(1.3*t)))*sin(2*PI*(160+40*sin(3*t))*t)*gt(sin(2.1*t),-0.6)':s=48000:d=8", voice]);
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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video, voice]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 320, height: 180, fps: 30 });
      s.setUi({ rippleEnabled: false });
      const track = s.project.tracks.find((t) => t.type === 'video');
      const asset = s.assets.find((a) => a.name.startsWith('clip'));
      return ['a', 'b', 'c'].map((_, i) => window.__scfStore.getState().addAssetToTimeline(asset, track.id, i * 90));
    });
    // What is on the video track, in order: a trimmed clip comes back as a new piece.
    const spans = () => window.evaluate(() => {
      const s = window.__scfStore.getState();
      const track = s.project.tracks.find((t) => t.type === 'video');
      return Object.values(s.project.clips).filter((c) => c.trackId === track.id).map((c) => [c.startFrame, c.startFrame + c.durationFrames]).sort((a, b) => a[0] - b[0]);
    });
    await window.locator('body').click({ position: { x: 800, y: 500 } }).catch(() => undefined);

    console.log('1. ripple keys');
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), ids[1]);
    await window.locator('[data-panel="timeline"] canvas').first().focus().catch(() => undefined);
    await window.keyboard.press('Shift+Delete');
    await sleep(300);
    const afterDelete = await spans();
    check('with the magnet off, Shift+Delete still closes the gap', JSON.stringify(afterDelete) === '[[0,90],[90,180]]', JSON.stringify(afterDelete));
    await window.evaluate(() => { window.__scfStore.getState().selectClips([]); window.__scfStore.getState().setCurrentFrame(30); });
    await window.keyboard.press('q');
    await sleep(300);
    const afterQ = await spans();
    const playheadQ = await window.evaluate(() => window.__scfStore.getState().project.currentFrame);
    check('Q trims the clip under the playhead to it at its start, what follows closing up', JSON.stringify(afterQ) === '[[0,60],[60,150]]' && playheadQ === 0, JSON.stringify({ afterQ, playheadQ }));
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(20));
    await window.keyboard.press('w');
    await sleep(300);
    const afterW = await spans();
    check('W trims it to the playhead at its end, what follows closing up', JSON.stringify(afterW) === '[[0,20],[20,110]]', JSON.stringify(afterW));
    for (let i = 0; i < 3; i += 1) await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const undone = await spans();
    check('each is one undo step: three undos, and it is as it was', JSON.stringify(undone) === '[[0,90],[90,180],[180,270]]', JSON.stringify(undone));

    console.log('2. Enhance voice');
    const voiceClip = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const asset = s.assets.find((a) => a.name.startsWith('voice'));
      const id = s.addAssetToTimeline(asset, s.project.tracks.find((t) => t.type === 'audio').id, 0);
      window.__scfStore.getState().selectClips([id]);
      return id;
    });
    void voiceClip;
    await window.getByRole('tab', { name: 'Audio' }).click();
    await window.getByTestId('inspector-voice-enhance').check();
    await window.getByTestId('inspector-voice-enhance').waitFor({ state: 'visible' });
    const enhanced = await window.waitForFunction(() => window.__scfStore.getState().assets.find((a) => a.name.startsWith('voice'))?.voiceEnhance === true, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    const cleanFolder = join(profile, 'scf', 'clean');
    const made = existsSync(cleanFolder) ? readdirSync(cleanFolder).filter((name) => name.endsWith('.m4a')).map((name) => join(cleanFolder, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : [];
    const before = { lufs: loudness(voice), peak: peak(voice) };
    const after = made[0] ? { lufs: loudness(made[0]), peak: peak(made[0]) } : null;
    check('Enhance voice: a quiet, uneven voice at about -16 LUFS, peaks under -1 dB', enhanced && after && Math.abs(after.lufs + 16) < 1.5 && after.peak < -1, JSON.stringify({ before, after }));

    console.log('3. templates');
    const clipsBefore = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'saveTemplate'));
    await window.getByTestId('template-name').fill('Mi intro');
    await window.getByTestId('template-save').click();
    await sleep(600);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'home'));
    await window.getByRole('button', { name: 'Blank project' }).waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
      // Leaving an unsaved project asks first; it may be let go.
      await window.getByRole('button', { name: /Don.t save|No guardar|Discard/ }).click().catch(() => undefined);
    });
    const listed = await window.getByTestId('home-templates').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const names = listed ? await window.getByTestId('home-templates').innerText() : '';
    check('the start screen lists it under My templates', listed && /Mi intro/.test(names), names.replace(/\n/g, ' | '));
    if (listed) await window.locator('[data-testid^="home-template-"]').first().click();
    const opened = await window.waitForFunction((count) => Object.keys(window.__scfStore?.getState().project.clips ?? {}).length === count && Boolean(document.querySelector('[data-testid="preview-panel"]')), clipsBefore, { timeout: 30_000 }).then(() => true).catch(() => false);
    const session = await window.evaluate(() => document.title);
    check('opening it is a new, untitled project with the same clips', opened && /Untitled|Sin título|STOOK/.test(session), `${clipsBefore} clips; ${session}`);

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
