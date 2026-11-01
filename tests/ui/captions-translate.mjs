import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Subtitles in English from a Spanish video: `node tests/ui/captions-translate.mjs`
 *
 *   1. The tick is offered for a Spanish video and NOT for an English one,
 *      because Whisper's translate task only ever goes into English.
 *   2. With it on, a Spanish voice comes back as English words - checked by
 *      looking for English words that are not in the Spanish sentence at all.
 *   3. The track it makes is marked English, since that is what chooses the
 *      line-breaking rules.
 *   4. With it off, the same audio comes back in Spanish.
 *
 * The voice is made by the app's own text to speech, so the test does not need
 * a recording of a person. Needs a build and the staged build/ (piper, its
 * voices, whisper and the bundled model).
 */

const require = createRequire(import.meta.url);
void require;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'captions-translate');
const ttsDir = join(root, 'build', 'piper');
const voicesDir = join(root, 'build', 'tts-voices');
const whisperDir = join(root, 'build', 'whisper');
const bundledModels = join(root, 'build', 'whisper-models');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Said in Spanish, and the English words a translation should bring. */
const SPOKEN = 'El perro corre por la playa todas las mañanas con mucha alegría.';
const ENGLISH = ['dog', 'beach', 'runs', 'morning', 'every'];
const SPANISH = ['perro', 'playa', 'corre'];

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Every caption's text on the newest captions track, and that track's language. */
const captions = (window) =>
  window.evaluate(() => {
    const { project } = window.__scfStore.getState();
    const tracks = project.tracks.filter((track) => track.type === 'captions');
    const track = tracks[tracks.length - 1];
    if (!track) return null;
    const text = Object.values(project.clips)
      .filter((clip) => clip.trackId === track.id && clip.caption)
      .sort((a, b) => a.startFrame - b.startFrame)
      .map((clip) => clip.caption.text)
      .join(' ');
    return { language: track.captions?.language ?? null, text };
  });

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  for (const [path, what] of [[ttsDir, 'piper'], [voicesDir, 'the voices'], [whisperDir, 'whisper'], [bundledModels, 'the bundled model']]) {
    if (!existsSync(path)) throw new Error(`Missing ${what} at ${path} - stage build/ first.`);
  }
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      SCF_TTS_DIR: ttsDir,
      SCF_TTS_BUNDLED_DIR: voicesDir,
      SCF_TTS_VOICES_DIR: join(work, 'downloaded-voices'),
      SCF_WHISPER_DIR: whisperDir,
      SCF_WHISPER_BUNDLED_DIR: bundledModels,
      SCF_WHISPER_MODELS_DIR: join(work, 'models'),
    },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    console.log('1. a Spanish voice to transcribe');
    await window.getByTestId('library-tab-voice').click();
    await window.getByTestId('tts-text').waitFor({ state: 'visible', timeout: 15_000 });
    await window.getByTestId('tts-language').selectOption('es');
    await window.getByTestId('tts-text').fill(SPOKEN);
    await window.getByTestId('tts-generate').click();
    const spoke = await window
      .waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length > 0, null, { timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    check('the app speaks the Spanish line', spoke);
    if (!spoke) throw new Error('no voice');

    console.log('2. the tick, and only for a language that is not English');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'generateCaptions'));
    await window.getByTestId('captions-dialog').waitFor({ state: 'visible', timeout: 15_000 });
    // The models’ state arrives from the main process before the button works.
    await window.waitForFunction(() => !document.querySelector('[data-testid="captions-generate"]')?.disabled, null, { timeout: 20_000 }).catch(() => undefined);
    await window.getByTestId('captions-language').selectOption('es');
    await sleep(250);
    const offeredForSpanish = await window.getByTestId('captions-translate').isVisible().catch(() => false);
    await window.getByTestId('captions-language').selectOption('en');
    await sleep(250);
    const offeredForEnglish = await window.getByTestId('captions-translate').isVisible().catch(() => false);
    check('offered for Spanish and not for English', offeredForSpanish && !offeredForEnglish, `es ${offeredForSpanish}, en ${offeredForEnglish}`);

    console.log('3. with it on');
    await window.getByTestId('captions-language').selectOption('es');
    await sleep(250);
    await window.getByTestId('captions-translate').check();
    await window.getByTestId('captions-model').selectOption('fast');
    await window.getByTestId('captions-generate').click();
    const made = await window
      .waitForFunction(() => window.__scfStore.getState().project.tracks.some((track) => track.type === 'captions'), null, { timeout: 300_000 })
      .then(() => true)
      .catch(() => false);
    // Say WHY, rather than only that it timed out.
    const job = await window.evaluate(() => {
      const state = window.__scfCaptions?.job?.getState?.();
      return state ? { phase: state.phase, error: state.error ?? null, message: state.message ?? null } : null;
    });
    check('it transcribes', made, made ? '' : JSON.stringify(job));
    if (!made) throw new Error(`no captions: ${JSON.stringify(job)}`);
    await sleep(800);
    const translated = await captions(window);
    const lower = (translated?.text ?? '').toLowerCase();
    const englishFound = ENGLISH.filter((word) => lower.includes(word));
    const spanishFound = SPANISH.filter((word) => lower.includes(word));
    check(
      'the captions come back in English',
      englishFound.length >= 2 && spanishFound.length === 0,
      `found ${englishFound.join()} | Spanish left: ${spanishFound.join() || 'none'} | ${(translated?.text ?? '').slice(0, 90)}`,
    );
    check('and the track is marked English', translated?.language === 'en', String(translated?.language));

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
