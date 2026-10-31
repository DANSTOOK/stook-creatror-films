import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Backgrounds, in the running app: `node tests/ui/backgrounds.mjs`
 *
 *   1. The Backgrounds tab shows all twenty-four, group by group, each its own
 *      picture and none of them blank.
 *   2. A click puts one behind the footage: on a track of its own, at the
 *      BOTTOM, filling the frame - and the picture is made at the project's
 *      own size, not a fixed one.
 *   3. A vertical project draws vertical tiles and a vertical picture.
 *   4. The groups filter, the search finds by name, and one undo takes it off.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'backgrounds');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** How many the catalog has (renderer/backgrounds/catalog). */
const BACKGROUND_COUNT = 24;
const GROUPS = ['gradients', 'scenes', 'patterns', 'textures'];

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** What the panel is showing: the tiles, their pictures and the groups. */
const panelState = (window) => window.evaluate(() => {
  const tiles = [...document.querySelectorAll('[data-testid^="library-background-"]')];
  const canvases = tiles.map((tile) => tile.querySelector('canvas')).filter(Boolean);
  const pictures = canvases.map((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    let lit = 0;
    for (let index = 0; index < data.length; index += 4000) {
      hash = (hash * 31 + data[index] + data[index + 1] * 3 + data[index + 2] * 7) % 1_000_003;
      if (data[index + 3] > 0) lit += 1;
    }
    return { hash, lit, width: canvas.width, height: canvas.height };
  });
  return {
    ids: tiles.map((tile) => tile.getAttribute('data-testid').replace('library-background-', '')),
    distinct: new Set(pictures.map((picture) => picture.hash)).size,
    blank: pictures.filter((picture) => picture.lit === 0).length,
    shape: pictures[0] ? pictures[0].width / pictures[0].height : 0,
    groups: [...document.querySelectorAll('[data-testid^="background-group-"]')].map((section) => ({
      id: section.getAttribute('data-testid').replace('background-group-', ''),
      tiles: section.querySelectorAll('[data-testid^="library-background-"]').length,
    })),
  };
});

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps: 30 }));

    console.log('1. the tab');
    await window.getByTestId('library-tab-backgrounds').click();
    await window.getByTestId('library-backgrounds').waitFor({ state: 'visible', timeout: 5_000 });
    await sleep(400);
    const opening = await panelState(window);
    check(
      'every background is shown, group by group, each its own picture',
      opening.ids.length === BACKGROUND_COUNT && opening.distinct === BACKGROUND_COUNT && opening.blank === 0,
      `${opening.ids.length} tiles, ${opening.distinct} distinct, ${opening.blank} blank`,
    );
    check(
      'the groups come in the panel’s order, five or more to each',
      opening.groups.map((group) => group.id).join() === GROUPS.join() && opening.groups.every((group) => group.tiles >= 5),
      JSON.stringify(opening.groups),
    );
    check('the tiles are drawn in the project’s shape', Math.abs(opening.shape - 16 / 9) < 0.02, `${opening.shape.toFixed(3)}`);

    console.log('2. a click puts one behind');
    await window.getByTestId('library-background-mountains').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 1, null, { timeout: 20_000 });
    await sleep(300);
    const placed = await window.evaluate(() => {
      const { project, assets } = window.__scfStore.getState();
      const clip = Object.values(project.clips)[0];
      // The picture rows, bottom first: a background has to be under everything.
      const rows = project.tracks.filter((track) => track.type !== 'audio').sort((a, b) => a.order - b.order);
      // A clip names its source by uri, not by an asset id.
      const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
      return {
        clips: Object.keys(project.clips).length,
        lowest: rows[0]?.id === clip.trackId,
        tracks: rows.length,
        width: asset?.width ?? 0,
        height: asset?.height ?? 0,
        path: asset?.sourcePath ?? '',
        name: clip.name ?? '',
      };
    });
    check('it lands on a track of its own, at the bottom', placed.clips === 1 && placed.lowest, `${placed.tracks} picture tracks, lowest: ${placed.lowest}`);
    check(
      'the picture is made at the project’s own size',
      placed.width === 1920 && placed.height === 1080 && /bg-mountains-1920x1080\.png$/.test(placed.path),
      `${placed.width}x${placed.height} ${placed.path.split(/[\\/]/).pop()}`,
    );
    check('the clip carries the background’s name', placed.name.length > 0, placed.name);

    console.log('3. a vertical project');
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1080, height: 1920, fps: 30 }));
    await sleep(500);
    const vertical = await panelState(window);
    check('a vertical project draws vertical tiles', Math.abs(vertical.shape - 1080 / 1920) < 0.02, `${vertical.shape.toFixed(3)}`);
    await window.getByTestId('library-background-ocean').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 2, null, { timeout: 20_000 });
    // By its file name rather than by which clip is which: the name carries the
    // size, so it is the asset this click made and no other.
    const tall = await window.evaluate(() => {
      const asset = window.__scfStore.getState().assets.find((candidate) => /bg-ocean-/.test(candidate.sourcePath ?? ''));
      return { width: asset?.width ?? 0, height: asset?.height ?? 0, path: asset?.sourcePath ?? '' };
    });
    check(
      'and a vertical picture',
      tall.width === 1080 && tall.height === 1920 && /bg-ocean-1080x1920\.png$/.test(tall.path),
      `${tall.width}x${tall.height} ${tall.path.split(/[\\/]/).pop()}`,
    );

    console.log('4. the groups, the search and undo');
    await window.getByTestId('background-filter-scenes').click();
    await sleep(250);
    const scenes = await panelState(window);
    check('a group shows only its own', scenes.groups.length === 1 && scenes.groups[0].id === 'scenes' && scenes.ids.includes('mountains'), JSON.stringify(scenes.groups));
    await window.getByTestId('background-filter-all').click();
    await window.getByTestId('background-search').fill('oce');
    await sleep(250);
    const found = await panelState(window);
    check('the search finds one by name', found.ids.length === 1 && found.ids[0] === 'ocean', found.ids.join());
    await window.getByTestId('background-search').fill('zzzz');
    await sleep(250);
    const none = await window.evaluate(() => Boolean(document.querySelector('[data-testid="background-no-match"]')));
    check('it says so when nothing is called that', none);
    await window.getByTestId('background-search').fill('');

    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const left = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    check('one undo takes the last background off', left === 1, `${left} clip(s) left`);

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
