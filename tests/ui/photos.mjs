import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Real photographs as backgrounds: `node tests/ui/photos.mjs`
 *
 * This one TOUCHES THE NETWORK, on purpose: the thing worth testing is that
 * Openverse answers without an API key and that a photo picked out of the
 * results becomes an ordinary clip. Mocking that would test the mock.
 *
 * It is therefore not part of the offline suite. Openverse allows 200
 * anonymous searches a day per address, so this makes exactly one.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'photos');
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

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    console.log('1. the search is folded away under the drawn backgrounds');
    await window.getByTestId('library-tab-backgrounds').click();
    await window.getByTestId('photos-more').waitFor({ state: 'attached', timeout: 15_000 });
    const foldedAtFirst = await window.evaluate(() => !document.querySelector('[data-testid="photos-more"]')?.open);
    check('folded at first, so the drawn ones are met first', foldedAtFirst);
    await window.evaluate(() => {
      const more = document.querySelector('[data-testid="photos-more"]');
      if (more) more.open = true;
    });
    await window.getByTestId('photo-query').waitFor({ state: 'visible', timeout: 10_000 });

    console.log('2. Openverse answers with no API key');
    await window.getByTestId('photo-query').fill('mountain lake');
    await window.getByTestId('photo-search').click();
    const answered = await window
      .waitForFunction(() => document.querySelectorAll('[data-testid="photo-results"] li').length > 0 || document.querySelector('[data-testid="photo-problem"]'), null, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    const problem = await window.getByTestId('photo-problem').textContent().catch(() => null);
    const found = await window.evaluate(() => document.querySelectorAll('[data-testid="photo-results"] li').length);
    check('it comes back with photographs', answered && found > 0, problem ? `problem: ${problem}` : `${found} results`);
    if (found === 0) throw new Error(problem ?? 'no results');

    console.log('3. every result says who took it and under what');
    const credits = await window.evaluate(() =>
      [...document.querySelectorAll('[data-testid="photo-results"] li button')].slice(0, 6).map((button) => button.getAttribute('title')),
    );
    check(
      'the creator and the licence are on every one',
      credits.every((title) => /\((CC0|PDM|BY|BY-SA)\)/i.test(title ?? '')),
      credits.slice(0, 2).join(' | '),
    );
    const licences = credits.map((title) => (title ?? '').match(/\((CC0|PDM|BY|BY-SA)\)/i)?.[1]?.toUpperCase());
    check('and no licence that forbids commercial use or changes', licences.every((one) => ['CC0', 'PDM', 'BY', 'BY-SA'].includes(one ?? '')), licences.join());

    console.log('4. one of them becomes an ordinary clip');
    const before = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    await window.evaluate(() => document.querySelector('[data-testid="photo-results"] li button')?.click());
    const landed = await window
      .waitForFunction((count) => Object.keys(window.__scfStore.getState().project.clips).length > count, before, { timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    check('it lands on the timeline', landed);
    if (landed) {
      const clip = await window.evaluate(() => {
        const state = window.__scfStore.getState();
        const added = Object.values(state.project.clips).sort((a, b) => b.startFrame - a.startFrame)[0];
        const newest = Object.values(state.project.clips)[Object.values(state.project.clips).length - 1];
        const target = newest ?? added;
        const asset = state.assets.find((entry) => entry.uri === target.sourceUri);
        return { name: target.name, hasAsset: Boolean(asset), tracks: state.project.tracks.length };
      });
      // The credit rides on the clip, so the project carries it rather than the user remembering.
      check('the credit is written into the clip name', /\((CC0|PDM|BY|BY-SA),/i.test(clip.name), clip.name.slice(0, 70));
      check('and it is a real asset, like any imported still', clip.hasAsset, JSON.stringify(clip));
    }

    check('nothing in the console', issues.length === 0, issues.slice(0, 2).join(' | '));
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
