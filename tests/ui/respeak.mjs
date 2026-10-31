import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Saying a voice clip again: `node tests/ui/respeak.mjs`
 *
 *   1. A voice made from the panel lands on the timeline AND remembers the
 *      script it was made from.
 *   2. Its clip's Audio tab shows that script, editable.
 *   3. Changed and said again, the clip is REPLACED - same start frame, same
 *      kind of track, a new file, and the new script kept - rather than a
 *      second voice appearing beside the first.
 *   4. One undo brings the old voice back, words and all.
 *
 * Needs a build and the staged build/ (piper and its voices). The window is
 * never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'respeak');
const ttsDir = join(root, 'build', 'piper');
const voicesDir = join(root, 'build', 'tts-voices');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** The one audio clip, with its script and its file. */
const voiceClip = (window) =>
  window.evaluate(() => {
    const state = window.__scfStore.getState();
    const byUri = new Map(state.assets.map((asset) => [asset.uri, asset]));
    const audio = Object.values(state.project.clips).filter((clip) => byUri.get(clip.sourceUri)?.kind === 'audio');
    if (audio.length === 0) return { count: 0 };
    const clip = audio[audio.length - 1];
    const track = state.project.tracks.find((candidate) => candidate.id === clip.trackId);
    return {
      count: audio.length,
      id: clip.id,
      start: clip.startFrame,
      duration: clip.durationFrames,
      trackType: track?.type,
      script: clip.speech?.text ?? null,
      voice: clip.speech?.voice ?? null,
      file: (byUri.get(clip.sourceUri)?.sourcePath ?? '').split(/[\\/]/).pop(),
    };
  });

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  for (const [path, what] of [[ttsDir, 'piper'], [voicesDir, 'the voices']]) {
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

    console.log('1. a voice, and what it remembers');
    const first = 'Hola, esta es la primera versión de la locución.';
    await window.getByTestId('library-tab-voice').click();
    await window.getByTestId('tts-text').waitFor({ state: 'visible', timeout: 15_000 });
    await window.getByTestId('tts-language').selectOption('es');
    await window.getByTestId('tts-text').fill(first);
    await window.getByTestId('tts-generate').click();
    const arrived = await window
      .waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).length > 0, null, { timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    check('a voice is made and lands on the timeline', arrived);
    if (!arrived) throw new Error('no voice');
    await sleep(500);
    const made = await voiceClip(window);
    check(
      'the clip remembers the script it was made from',
      made.script === first && Boolean(made.voice),
      `${JSON.stringify(made.script)} in ${made.voice}`,
    );

    console.log('2. the script in the inspector');
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), made.id);
    await sleep(400);
    await window.locator('#inspector-tab-audio').click();
    await sleep(300);
    const card = window.getByTestId('clip-fx-speech');
    const shown = await card.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const inBox = await window.getByTestId('clip-fx-speech-text').inputValue().catch(() => '');
    check('the clip’s Audio tab shows that script, editable', shown && inBox === first, `${shown}, ${JSON.stringify(inBox)}`);

    console.log('3. said again, with the text changed');
    const second = 'Hola, esta es la segunda versión, bastante más larga que la primera, para que dure otra cosa.';
    await window.getByTestId('clip-fx-speech-text').fill(second);
    await window.getByTestId('clip-fx-speech-again').click();
    const replaced = await window
      .waitForFunction((was) => {
        const state = window.__scfStore.getState();
        const byUri = new Map(state.assets.map((asset) => [asset.uri, asset]));
        const audio = Object.values(state.project.clips).filter((clip) => byUri.get(clip.sourceUri)?.kind === 'audio');
        return audio.length === 1 && audio[0].id !== was;
      }, made.id, { timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    check('the old clip is replaced, not joined by a second one', replaced);
    if (!replaced) throw new Error('never replaced');
    await sleep(400);
    const again = await voiceClip(window);
    check('at the same frame, on a voice track', again.start === made.start && again.trackType === 'audio', `frame ${again.start} (was ${made.start}), ${again.trackType}`);
    check('from a new file, and longer, as the longer text should be', again.file !== made.file && again.duration > made.duration, `${again.file} ${again.duration}f vs ${made.file} ${made.duration}f`);
    check('and it remembers the NEW script', again.script === second, JSON.stringify(again.script));

    console.log('4. undo');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(600);
    const undone = await voiceClip(window);
    check(
      'one undo brings the old voice back, words and all',
      undone.count === 1 && undone.script === first && undone.file === made.file,
      `${JSON.stringify(undone.script)} ${undone.file}`,
    );

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
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
