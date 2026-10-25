import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Thirteen music tracks, eight of them new (block 7c): reggaeton, trap,
 * house, synthwave, piano, epic, funk and acoustic: `node tests/ui/music-more.mjs`
 *
 *   1. the Music shelf lists the thirteen;
 *   2. every new track is made: a stereo WAV as long as the list says (whole
 *      phrases of four bars), at the library's level, not silent;
 *   3. each is a loop: its end runs into its start without a jump, and its
 *      start already rings with its end, as the second pass of two;
 *   4. no two the same, and a new track goes onto a music track, its whole length;
 *   5. nothing in the page's errors or the app's log.
 *
 * The window is muted. Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'music-more');
const logs = join(work, 'logs');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const NEW = { reggaeton: 95, trap: 140, house: 124, synthwave: 100, piano: 70, epic: 80, funk: 105, acoustic: 115 };

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** A 16-bit PCM WAV: channels, length, peak, loudness, and how its end meets its start. */
function readWav(path) {
  const data = readFileSync(path);
  const channels = data.readUInt16LE(22);
  const rate = data.readUInt32LE(24);
  const frames = data.readUInt32LE(40) / (channels * 2);
  const left = new Float32Array(frames);
  let peak = 0;
  let sum = 0;
  let hash = 0;
  for (let i = 0; i < frames; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = data.readInt16LE(44 + (i * channels + channel) * 2) / 32768;
      if (channel === 0) left[i] = value;
      peak = Math.max(peak, Math.abs(value));
      sum += value * value;
    }
    if (i % 101 === 0) hash = (hash * 31 + Math.round(left[i] * 1000) + 1000) % 1000003;
  }
  // The step from the last sample to the first, against the usual step between neighbours.
  const steps = [];
  for (let i = 1; i < frames; i += 37) steps.push(Math.abs(left[i] - left[i - 1]));
  steps.sort((a, b) => a - b);
  const usual = steps[Math.floor(steps.length * 0.99)];
  const join = Math.abs(left[0] - left[frames - 1]);
  // How loud its first 100 ms are, against the whole: a start that rings with the end.
  let head = 0;
  const headFrames = Math.round(rate * 0.1);
  for (let i = 0; i < headFrames; i += 1) head += left[i] * left[i];
  return { channels, rate, seconds: frames / rate, peak, rms: Math.sqrt(sum / (frames * channels)), hash, join, usual, headRms: Math.sqrt(head / headFrames) };
}

/** "0:27" or "9.5 s" as seconds. */
const listedSeconds = (text) => (text.includes(':') ? Number(text.split(':')[0]) * 60 + Number(text.split(':')[1]) : Number.parseFloat(text));

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
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
    await app.evaluate(({ BrowserWindow }) => {
      const [main] = BrowserWindow.getAllWindows();
      main.setContentSize(1600, 1000);
      main.webContents.setAudioMuted(true);
    });
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.getByTestId('library-tab-sounds').click();
    await window.getByTestId('sound-filter-music').click();
    await sleep(300);

    /* 1. the shelf ------------------------------------------------------------------------------- */
    const shelf = await window.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="sound-group-music"] [data-testid^="library-sound-"]:not([data-testid*="-play-"])')]
      .map((row) => [row.dataset.testid.replace('library-sound-', ''), row.querySelector('.tabular-nums')?.textContent ?? ''])));
    check('the Music shelf lists the thirteen tracks', Object.keys(shelf).length === 13 && Object.keys(NEW).every((id) => id in shelf), Object.keys(shelf).join(','));

    /* 2-3. every new track, made --------------------------------------------------------------- */
    const folder = join(profile, 'scf', 'sounds');
    const fileOf = (id) => join(folder, `${id}-v2.wav`);
    for (const id of Object.keys(NEW)) {
      await window.getByTestId(`library-sound-play-${id}`).click();
      const started = Date.now();
      while (!existsSync(fileOf(id)) && Date.now() - started < 60_000) await sleep(150);
      await sleep(200);
      const label = await window.getByTestId(`library-sound-play-${id}`).getAttribute('aria-label');
      if (label?.startsWith('Stop')) await window.getByTestId(`library-sound-play-${id}`).click();
    }
    const made = Object.keys(NEW).filter((id) => existsSync(fileOf(id))).map((id) => ({ id, ...readWav(fileOf(id)) }));
    const wrong = made.filter((track) => track.channels !== 2 || track.rate !== 44100 || track.peak < 0.6 || track.peak > 0.75 || track.rms < 0.03);
    check('every new track is made: a stereo WAV at 44.1 kHz, at the library\'s level, not silent',
      made.length === 8 && wrong.length === 0, wrong.map((track) => `${track.id} peak ${track.peak.toFixed(2)} rms ${track.rms.toFixed(3)}`).join('; ') || `${made.length} made`);
    const lengths = made.filter((track) => {
      const bar = (60 / NEW[track.id]) * 4;
      const phrases = track.seconds / (bar * 4);
      return Math.abs(phrases - Math.round(phrases)) > 0.001 || Math.abs(track.seconds - listedSeconds(shelf[track.id])) > 0.6;
    });
    check('each as long as the list says, in whole phrases of four bars', lengths.length === 0,
      lengths.map((track) => `${track.id} ${track.seconds.toFixed(2)} s vs "${shelf[track.id]}"`).join('; ') || made.map((track) => `${track.id} ${track.seconds.toFixed(1)}`).join(', '));
    const seams = made.filter((track) => track.join > Math.max(track.usual * 1.5, 0.02) || track.headRms < 0.01);
    check('each is a loop: its end runs into its start without a jump, and its start already rings',
      seams.length === 0, made.map((track) => `${track.id} ${track.join.toFixed(3)}/${track.usual.toFixed(3)} head ${track.headRms.toFixed(3)}`).join('; '));
    check('no two the same', new Set(made.map((track) => track.hash)).size === made.length);

    /* 4. onto the timeline ------------------------------------------------------------------ */
    await window.getByTestId('library-sound-reggaeton').click();
    const added = await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 1, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    const placed = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips)[0];
      const track = clip && s.project.tracks.find((t) => t.id === clip.trackId);
      return clip ? { type: track?.type, bus: track?.bus, seconds: clip.durationFrames / s.project.fps } : null;
    });
    const reggaeton = made.find((track) => track.id === 'reggaeton');
    check('a new track goes onto a music track, its whole length',
      added && placed?.type === 'audio' && placed.bus === 'music' && reggaeton && Math.abs(placed.seconds - reggaeton.seconds) < 0.05, JSON.stringify(placed));

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
