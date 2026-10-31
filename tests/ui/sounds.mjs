import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The sound library, in the running app: `node tests/ui/sounds.mjs`
 *
 *   1. The Sounds tab lists the effects and the music; Play makes a sound and
 *      hears it.
 *   2. A click on Whoosh puts it at the playhead on a track of its own -
 *      a real sound, as long as it says, not silence.
 *   3. Upbeat (120 BPM) goes on a Music track on the music bus - and the
 *      editor's own beat finder hears 120 beats a minute in it. The same
 *      sound twice reuses its file. One undo takes a sound off.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'sounds');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const meanVolume = (path) => Number(/mean_volume: (-?[\d.]+)/.exec(spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)?.[1] ?? NaN);

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const app = await electron.launch({
    args: ['--autoplay-policy=no-user-gesture-required', `--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
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
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(30));

    console.log('1. the tab');
    await window.getByTestId('library-tab-sounds').click();
    await window.getByTestId('library-sounds').waitFor({ state: 'visible', timeout: 5_000 });
    const listed = await window.locator('[data-testid^="library-sound-"]:not([data-testid*="-play-"])').count();
    await window.getByTestId('library-sound-play-ding').click();
    const heard = await window.waitForFunction(() => document.querySelector('[data-testid="library-sound-play-ding"]')?.getAttribute('aria-label')?.startsWith('Stop'), null, { timeout: 20_000 }).then(() => true).catch(() => false);
    check('the tab lists the effects and the music; Play makes a sound and plays it', listed === 85 && heard, `${listed} sounds, playing ${heard}`);

    console.log('2. an effect');
    await window.getByTestId('library-sound-whoosh').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 1, null, { timeout: 30_000 });
    const whoosh = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips)[0];
      const asset = s.assets.find((a) => a.uri === clip.sourceUri);
      const track = s.project.tracks.find((t) => t.id === clip.trackId);
      return { start: clip.startFrame, kind: asset.kind, path: asset.sourcePath, seconds: asset.durationSeconds, track: track.name, type: track.type };
    });
    const whooshLevel = meanVolume(whoosh.path);
    check('Whoosh goes at the playhead on a track of its own, a real sound as long as it says',
      whoosh.start === 30 && whoosh.kind === 'audio' && whoosh.type === 'audio' && whoosh.track === 'Sound effects' && Math.abs(whoosh.seconds - 1.2) < 0.05 && whooshLevel > -40,
      `${JSON.stringify({ ...whoosh, path: undefined })}, ${whooshLevel} dB`);

    console.log('3. music');
    await window.getByTestId('library-sound-upbeat').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 2, null, { timeout: 60_000 });
    const song = await window.evaluate(async () => {
      const s = window.__scfStore.getState();
      const asset = s.assets.find((a) => a.sourcePath?.includes('upbeat'));
      const clip = Object.values(s.project.clips).find((c) => c.sourceUri === asset.uri);
      const track = s.project.tracks.find((t) => t.id === clip.trackId);
      const beats = await window.filmora.detectBeats(asset.sourcePath, 0, asset.durationSeconds);
      return { path: asset.sourcePath, seconds: asset.durationSeconds, track: track.name, bus: track.bus, bpm: beats.bpm };
    });
    check('Upbeat goes on a Music track, on the music bus, and the beat finder hears 120 BPM in it',
      song.track === 'Music' && song.bus === 'music' && Math.abs(song.seconds - 24) < 0.1 && Math.abs(song.bpm - 120) < 2 && meanVolume(song.path) > -40,
      JSON.stringify({ ...song, path: undefined }));
    await window.getByTestId('library-sound-whoosh').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 3, null, { timeout: 30_000 });
    const assets = await window.evaluate(() => window.__scfStore.getState().assets.length);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const left = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    check('the same sound twice reuses its file; one undo takes a sound off', assets === 2 && left === 2, `${assets} assets, ${left} clips after undo`);

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
