import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Forty-six sound effects in six groups, as CapCut's are:
 * `node tests/ui/sounds-more.mjs`
 *
 *   1. the panel lists every effect in its group, then the music;
 *   2. the row of groups shows one at a time, and the search finds a sound by
 *      its name, whatever the case and the accents;
 *   3. every new effect is made: a stereo WAV as long as the list says,
 *      at the library's level (-3 dBFS), not silent, and no two the same;
 *   4. a new effect goes onto the timeline like the first ones;
 *   5. nothing in the page's errors or the app's log.
 *
 * The window is muted: thirty-two effects in a row are not played out loud.
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'sounds-more');
const logs = join(work, 'logs');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const GROUPS = ['transitions', 'interface', 'cartoon', 'drums', 'everyday', 'nature'];
const NEW = ['swipe', 'reverseCymbal', 'impact', 'subDrop', 'notification', 'bubble', 'coin', 'countdown', 'alarm', 'boing', 'slideWhistle', 'powerUp', 'gameOver', 'jump', 'magic', 'sadTrombone',
  'drumroll', 'cymbal', 'rimshot', 'scratch', 'fanfare', 'applause', 'glitch', 'cashRegister', 'knock', 'tick', 'phoneRing', 'siren', 'thunder', 'wind', 'rain', 'waterDrop'];

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** A 16-bit PCM WAV's channels, length, peak and loudness. */
function readWav(path) {
  const data = readFileSync(path);
  const channels = data.readUInt16LE(22);
  const rate = data.readUInt32LE(24);
  const bytes = data.readUInt32LE(40);
  const frames = bytes / (channels * 2);
  let peak = 0;
  let sum = 0;
  let hash = 0;
  for (let i = 0; i < frames * channels; i += 1) {
    const value = data.readInt16LE(44 + i * 2) / 32768;
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
    if (i % 97 === 0) hash = (hash * 31 + Math.round(value * 1000) + 1000) % 1000003;
  }
  return { channels, rate, seconds: frames / rate, peak, rms: Math.sqrt(sum / (frames * channels)), hash };
}

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
    await window.getByTestId('library-sounds').waitFor({ state: 'visible', timeout: 5_000 });
    await sleep(300);

    const panel = () => window.evaluate(() => ({
      groups: [...document.querySelectorAll('[data-testid^="sound-group-"]')].map((section) => ({
        id: section.dataset.testid.replace('sound-group-', ''),
        rows: section.querySelectorAll('[data-testid^="library-sound-"]:not([data-testid*="-play-"])').length,
      })),
      rows: [...document.querySelectorAll('[data-testid^="library-sound-"]:not([data-testid*="-play-"])')].map((row) => row.dataset.testid.replace('library-sound-', '')),
      none: document.querySelector('[data-testid="sound-no-match"]') !== null,
    }));

    /* 1. the list ------------------------------------------------------------------------------ */
    const opening = await panel();
    const effects = opening.groups.filter((group) => group.id !== 'music').reduce((total, group) => total + group.rows, 0);
    check('the panel lists every effect in its group, then the music',
      opening.groups.map((group) => group.id).join() === [...GROUPS, 'music'].join() && effects === 46 && opening.groups.every((group) => group.rows >= 4),
      opening.groups.map((group) => `${group.id} ${group.rows}`).join(', '));

    /* 2. the row and the search ------------------------------------------------------------- */
    await window.getByTestId('sound-filter-nature').click();
    await sleep(200);
    const nature = await panel();
    await window.getByTestId('sound-filter-all').click();
    await sleep(200);
    check('the row of groups shows one at a time', nature.groups.length === 1 && nature.groups[0].id === 'nature' && nature.rows.join() === 'thunder,wind,rain,waterDrop', nature.rows.join());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(500);
    const search = window.getByTestId('sound-search');
    await search.fill('TROMBON');
    await sleep(200);
    const trombone = await panel();
    await search.fill('xyzzy');
    await sleep(200);
    const nothing = await panel();
    await search.fill('');
    await sleep(200);
    check('the search finds a sound by its name, whatever the case and the accents, and says when nothing is called that',
      trombone.rows.join() === 'sadTrombone' && nothing.rows.length === 0 && nothing.none && (await panel()).rows.length === opening.rows.length,
      `"TROMBON": ${trombone.rows.join()}; nothing: ${nothing.none}`);

    /* 3. every new effect, made --------------------------------------------------------------- */
    const folder = join(profile, 'scf', 'sounds');
    const fileOf = (id) => join(folder, `${id.toLowerCase()}-v2.wav`);
    const failures = [];
    for (const id of NEW) {
      await window.getByTestId(`library-sound-play-${id}`).click();
      const started = Date.now();
      while (!existsSync(fileOf(id)) && Date.now() - started < 20_000) await sleep(100);
      // Stopped again: the next one is made with nothing playing.
      await sleep(150);
      const label = await window.getByTestId(`library-sound-play-${id}`).getAttribute('aria-label');
      if (label?.startsWith('Detener')) await window.getByTestId(`library-sound-play-${id}`).click();
      if (!existsSync(fileOf(id))) failures.push(`${id}: no file`);
    }
    const expected = await window.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="library-sound-"]:not([data-testid*="-play-"])')]
      .map((row) => [row.dataset.testid.replace('library-sound-', ''), row.querySelector('.tabular-nums')?.textContent ?? ''])));
    const made = NEW.filter((id) => existsSync(fileOf(id))).map((id) => ({ id, ...readWav(fileOf(id)) }));
    const wrong = made.filter((sound) => sound.channels !== 2 || sound.rate !== 44100 || sound.peak < 0.6 || sound.peak > 0.75 || sound.rms < 0.01);
    check('every new effect is made: a stereo WAV at 44.1 kHz, at the library\'s level, not silent',
      failures.length === 0 && made.length === NEW.length && wrong.length === 0,
      [...failures, ...wrong.map((sound) => `${sound.id} ${sound.channels}ch peak ${sound.peak.toFixed(2)} rms ${sound.rms.toFixed(3)}`)].slice(0, 6).join('; ') || `${made.length} made`);
    const lengths = made.filter((sound) => {
      const listed = Number.parseFloat((expected[sound.id] ?? '').replace(',', '.'));
      return !(Math.abs(sound.seconds - listed) <= 0.06);
    });
    check('each as long as the list says', lengths.length === 0, lengths.map((sound) => `${sound.id} ${sound.seconds.toFixed(2)} s vs "${expected[sound.id]}"`).slice(0, 5).join('; ') || 'all');
    check('and no two the same', new Set(made.map((sound) => sound.hash)).size === made.length, `${new Set(made.map((sound) => sound.hash)).size} different of ${made.length}`);

    /* 4. onto the timeline ------------------------------------------------------------------ */
    await window.getByTestId('library-sound-applause').click();
    const added = await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 1, null, { timeout: 30_000 }).then(() => true).catch(() => false);
    const placed = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips)[0];
      const track = clip && s.project.tracks.find((t) => t.id === clip.trackId);
      return clip ? { type: track?.type, name: track?.name, bus: track?.bus, length: clip.durationFrames, fps: s.project.fps } : null;
    });
    check('a new effect goes onto the timeline like the first ones: on an effects track, its whole length',
      added && placed?.type === 'audio' && placed.name === 'Efectos de sonido' && Math.abs(placed.length - Math.round(3.2 * placed.fps)) <= 1, JSON.stringify(placed));

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
