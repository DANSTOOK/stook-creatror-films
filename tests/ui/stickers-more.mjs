import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Sixty-six stickers in eight groups, as CapCut's panel has them:
 * `node tests/ui/stickers-more.mjs`
 *
 *   1. the panel opens on all of them, group by group;
 *   2. the row of groups shows one at a time, and All brings the rest back;
 *   3. the search finds a sticker by its name, whatever the case and the
 *      accents, and says so when nothing is called that;
 *   4. a new one goes over the picture like the first eighteen do;
 *   5. the lettered ones are drawn in the interface's language;
 *   6. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'stickers-more');
const logs = join(work, 'logs');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const GROUPS = ['reactions', 'shapes', 'icons', 'social', 'party', 'nature', 'pointers', 'words'];

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
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.getByTestId('library-tab-stickers').click();
    await window.getByTestId('library-stickers').waitFor({ state: 'visible', timeout: 5_000 });
    await sleep(300);

    const panel = () => window.evaluate(() => ({
      groups: [...document.querySelectorAll('[data-testid^="sticker-group-"]')].map((section) => ({
        id: section.dataset.testid.replace('sticker-group-', ''),
        tiles: section.querySelectorAll('[data-testid^="library-sticker-"]').length,
      })),
      tiles: [...document.querySelectorAll('[data-testid^="library-sticker-"]')].map((tile) => tile.dataset.testid.replace('library-sticker-', '')),
      pressed: [...document.querySelectorAll('[data-testid^="sticker-filter-"][aria-pressed="true"]')].map((chip) => chip.dataset.testid.replace('sticker-filter-', '')),
      none: document.querySelector('[data-testid="sticker-no-match"]') !== null,
    }));

    /* 1. all of them -------------------------------------------------------------------------- */
    const opening = await panel();
    check('the panel opens on all of them, group by group', opening.pressed.join() === 'all' && opening.groups.map((group) => group.id).join() === GROUPS.join() && opening.tiles.length === 66 && opening.groups.every((group) => group.tiles >= 5),
      opening.groups.map((group) => `${group.id} ${group.tiles}`).join(', '));

    /* 2. one group at a time --------------------------------------------------------------------- */
    await window.getByTestId('sticker-filter-social').click();
    await sleep(200);
    const social = await panel();
    await window.getByTestId('sticker-filter-all').click();
    await sleep(200);
    const back = await panel();
    check('the row of groups shows one at a time, and All brings the rest back',
      social.groups.length === 1 && social.groups[0].id === 'social' && social.tiles.includes('thumbsUp') && social.pressed.join() === 'social' && back.tiles.length === 66,
      `${social.groups.map((group) => `${group.id} ${group.tiles}`).join()}; back to ${back.tiles.length}`);

    // The row of groups, narrower than its chips in the docked panel: the wheel turns it sideways.
    const row = window.getByTestId('sticker-groups');
    const rowBox = await row.boundingBox();
    const fits = await row.evaluate((element) => element.scrollWidth <= element.clientWidth);
    await window.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
    await window.mouse.wheel(0, 120);
    await sleep(200);
    const turned = await row.evaluate((element) => element.scrollLeft);
    check('the row of groups is one line, and the wheel over it turns it sideways', rowBox.height < 40 && (fits || turned > 0), `height ${Math.round(rowBox.height)}, scrolled ${turned}${fits ? ', fits' : ''}`);

    /* 5 (first half). a lettered sticker, drawn in English -------------------------------------- */
    const picture = (id) => window.evaluate((wanted) => {
      const canvas = document.querySelector(`[data-testid="library-sticker-${wanted}"] canvas`);
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0;
      for (let i = 0; i < data.length; i += 4 * 5) hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3]) % 1000003;
      return hash;
    }, id);
    const saleEnglish = await picture('sale');
    const followEnglish = await picture('followUs');
    const heartEnglish = await picture('heart');

    /* 4. a new one over the picture ------------------------------------------------------------- */
    await window.getByTestId('library-sticker-thumbsUp').click();
    const added = await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 1, null, { timeout: 30_000 }).then(() => true).catch(() => false);
    const placed = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips)[0];
      const asset = clip && s.assets.find((candidate) => candidate.uri === clip.sourceUri);
      return clip ? { name: clip.name, kind: asset?.kind, alpha: asset?.hasAlphaChannel, track: s.project.tracks.find((t) => t.id === clip.trackId)?.type } : null;
    });
    check('a new one goes over the picture like the first eighteen do: a transparent still on a picture track', added && placed?.kind === 'image' && placed.alpha === true && placed.track === 'video',
      JSON.stringify(placed));

    /* 3 and 5. in Spanish: the search, and the words --------------------------------------------- */
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(600);
    const saleSpanish = await picture('sale');
    const followSpanish = await picture('followUs');
    const heartSpanish = await picture('heart');
    check('the lettered ones are drawn in the interface\'s language, the others the same in both',
      saleSpanish !== saleEnglish && followSpanish !== followEnglish && heartSpanish === heartEnglish, `${saleEnglish}/${saleSpanish} ${followEnglish}/${followSpanish} ${heartEnglish}/${heartSpanish}`);
    const search = window.getByTestId('sticker-search');
    await search.fill('CORAZON');
    await sleep(200);
    const heart = await panel();
    await search.fill('fiesta');
    await sleep(200);
    const party = await panel();
    await search.fill('zzzz');
    await sleep(200);
    const nothing = await panel();
    await search.fill('');
    await sleep(200);
    const cleared = await panel();
    check('the search finds by name, whatever the case and the accents',
      heart.tiles.join() === 'heart' && party.tiles.includes('partyFace') && party.tiles.includes('popper') && party.tiles.length === 2,
      `"CORAZON": ${heart.tiles.join()}; "fiesta": ${party.tiles.join()}`);
    check('it says so when nothing is called that, and empty shows them all again', nothing.tiles.length === 0 && nothing.none && cleared.tiles.length === 66 && !cleared.none,
      `${nothing.tiles.length} ${nothing.none}; ${cleared.tiles.length}`);

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
