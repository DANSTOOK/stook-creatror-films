import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * The Voice tab's characters as cards with a face each, as CapCut's:
 * `node tests/ui/voice-cards.mjs`
 *
 *   1. every character is a card with an illustrated face of its own and its
 *      name, which is what a screen reader says for it;
 *   2. pointed at, a card says what it sets: the voice, the pace, the style;
 *   3. picked, it is marked - a tick on its face - and its voice, pace, pitch
 *      and style are set; a slider moved by hand unmarks it;
 *   4. the face lifts a little under the pointer, and not when less motion is
 *      asked for;
 *   5. the cards fit the panel, and the keyboard reaches and picks them;
 *   6. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'voice-cards');
const logs = join(work, 'logs');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const CHARACTERS = ['narrator', 'host', 'youtuber', 'news', 'storyteller', 'grandpa', 'child', 'monster', 'robot', 'call', 'whisper', 'announcer'];

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    // The engine and voices staged in build/, as tests/ui/tts.mjs runs them.
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      SCF_LOG_DIR: logs,
      SCF_TTS_DIR: join(root, 'build', 'piper'),
      SCF_TTS_BUNDLED_DIR: join(root, 'build', 'tts-voices'),
      SCF_TTS_VOICES_DIR: join(work, 'downloaded-voices'),
    },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.getByTestId('library-tab-voice').click();
    await window.getByTestId('tts-characters').waitFor({ state: 'visible', timeout: 15_000 });
    // The voices are listed once the engine has answered.
    await window.waitForSelector('[data-testid^="tts-voice-"][role="radio"]', { timeout: 15_000 }).catch(() => undefined);
    await sleep(300);

    const cards = () => window.evaluate(() => [...document.querySelectorAll('[data-testid="tts-characters"] > button')].map((card) => ({
      id: card.dataset.testid.replace('tts-character-', ''),
      face: card.querySelector('svg[data-avatar]')?.dataset.avatar ?? null,
      // The drawing, without the clip's own id.
      drawing: card.querySelector('svg[data-avatar] g')?.innerHTML ?? '',
      name: card.textContent.trim(),
      ariaLabel: card.getAttribute('aria-label'),
      pressed: card.getAttribute('aria-pressed'),
      ticked: card.querySelector('.lucide-check') !== null,
    })));

    /* 1. a card and a face each ----------------------------------------------------------------- */
    const all = await cards();
    const faces = all.map((card) => card.face);
    check('every character is a card with its own face', all.length === CHARACTERS.length && CHARACTERS.every((id, index) => all[index].id === id && faces[index] === id),
      faces.join(','));
    check('no two faces are drawn the same', new Set(all.map((card) => card.drawing)).size === CHARACTERS.length && all.every((card) => card.drawing.length > 300),
      `${new Set(all.map((card) => card.drawing)).size} different drawings`);
    const named = await window.getByRole('button', { name: 'Documentary narrator', exact: true }).count();
    check('each says its name, and that is its name for a screen reader too', all.every((card) => card.name.length > 2 && card.ariaLabel === null) && named === 1,
      all.map((card) => card.name).join(' | '));

    /* 2. what a card sets ------------------------------------------------------------------------ */
    await window.getByTestId('tts-character-robot').hover();
    const tooltip = await window.locator('[role="tooltip"]').filter({ hasText: 'Robot' }).first().innerText({ timeout: 3_000 }).catch(() => '');
    check('pointed at, a card says what it sets: the voice, the pace, the style', /×/.test(tooltip) && /Robot/.test(tooltip) && tooltip.split('·').length >= 3, tooltip.replace(/\s+/g, ' '));

    /* 4. the face lifts --------------------------------------------------------------------------- */
    await sleep(400);
    const lifted = await window.evaluate(() => getComputedStyle(document.querySelector('[data-testid="tts-character-robot"] .scf-voice-avatar')).transform);
    await window.mouse.move(5, 500);
    await window.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    await window.getByTestId('tts-character-robot').hover();
    await sleep(400);
    const still = await window.evaluate(() => getComputedStyle(document.querySelector('[data-testid="tts-character-robot"] .scf-voice-avatar')).transform);
    await window.evaluate(() => document.documentElement.setAttribute('data-motion', 'full'));
    await window.mouse.move(5, 500);
    check('the face lifts a little under the pointer, and stays put with less motion asked for', /^matrix\(1\.0[5-9]/.test(lifted) && still === 'none', `${lifted} / ${still}`);

    /* 3. picking -------------------------------------------------------------------------------------- */
    const state = () => window.evaluate(() => ({
      speed: Number(document.querySelector('[data-testid="tts-speed"]').value),
      pitch: Number(document.querySelector('[data-testid="tts-pitch"]').value),
      effect: [...document.querySelectorAll('[data-testid^="tts-effect-"]')].find((chip) => chip.getAttribute('aria-pressed') === 'true')?.dataset.testid ?? null,
      voice: document.querySelector('[data-testid^="tts-voice-"][aria-checked="true"]')?.dataset.testid ?? null,
    }));
    await window.getByTestId('tts-character-robot').click();
    await sleep(200);
    const robot = await state();
    const afterRobot = await cards();
    const marked = afterRobot.filter((card) => card.pressed === 'true');
    check('picked, it is the one card marked, with a tick on its face', marked.length === 1 && marked[0].id === 'robot' && marked[0].ticked && afterRobot.filter((card) => card.ticked).length === 1,
      marked.map((card) => card.id).join(','));
    check('and its pace, pitch and style are set', robot.speed === 1 && robot.pitch === 0 && robot.effect === 'tts-effect-robot', JSON.stringify(robot));
    await window.getByTestId('tts-character-child').click();
    await sleep(200);
    const child = await state();
    check('another card sets its own: the child, high and plain', child.pitch === 6 && child.speed === 1.05 && child.effect === 'tts-effect-none' && (await cards()).find((card) => card.id === 'child').pressed === 'true',
      JSON.stringify(child));
    await window.getByTestId('tts-speed').fill('1.3');
    await sleep(200);
    check('a slider moved by hand unmarks it', (await cards()).every((card) => card.pressed === 'false' && !card.ticked));

    /* 5. fitting, and the keyboard ---------------------------------------------------------------- */
    const fit = await window.evaluate(() => {
      const grid = document.querySelector('[data-testid="tts-characters"]');
      const box = grid.getBoundingClientRect();
      const inside = [...grid.children].every((card) => {
        const own = card.getBoundingClientRect();
        return own.left >= box.left - 0.5 && own.right <= box.right + 0.5 && own.width >= 70;
      });
      return { inside, scroll: grid.scrollWidth <= grid.clientWidth + 1, columns: new Set([...grid.children].map((card) => Math.round(card.getBoundingClientRect().left))).size };
    });
    check('the cards fit the panel, in rows of several', fit.inside && fit.scroll && fit.columns >= 2, JSON.stringify(fit));
    await window.getByTestId('tts-character-narrator').focus();
    await window.keyboard.press('Tab');
    const focused = await window.evaluate(() => document.activeElement?.dataset.testid ?? null);
    await window.keyboard.press('Enter');
    await sleep(200);
    check('the keyboard goes from card to card, and Enter picks', focused === 'tts-character-host' && (await cards()).find((card) => card.id === 'host').pressed === 'true', focused ?? 'nothing focused');

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
