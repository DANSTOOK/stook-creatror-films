import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Frames, in the running app: `node tests/ui/frames.mjs`
 *
 *   1. The Frames tab shows all sixteen, group by group, each its own picture.
 *   2. A click lays one over the video: on a track of its own, ABOVE the
 *      footage, at the project's own size.
 *   3. In the RENDERED picture the middle is still the footage and the edge is
 *      the frame - which is the whole point, and the one thing a frame can get
 *      catastrophically wrong.
 *   4. A vertical project draws a vertical frame; the groups, the search and
 *      undo work.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'frames');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const FRAME_COUNT = 16;
const GROUPS = ['safe', 'borders', 'vignettes'];

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const panelState = (window) => window.evaluate(() => {
  const tiles = [...document.querySelectorAll('[data-testid^="library-frame-"]')];
  const pictures = tiles.map((tile) => tile.querySelector('canvas')).filter(Boolean).map((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let index = 0; index < data.length; index += 4000) {
      hash = (hash * 31 + data[index] + data[index + 1] * 3 + data[index + 2] * 7) % 1_000_003;
    }
    return { hash, width: canvas.width, height: canvas.height };
  });
  return {
    ids: tiles.map((tile) => tile.getAttribute('data-testid').replace('library-frame-', '')),
    distinct: new Set(pictures.map((picture) => picture.hash)).size,
    shape: pictures[0] ? pictures[0].width / pictures[0].height : 0,
    groups: [...document.querySelectorAll('[data-testid^="frame-group-"]')].map((section) => ({
      id: section.getAttribute('data-testid').replace('frame-group-', ''),
      tiles: section.querySelectorAll('[data-testid^="library-frame-"]').length,
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
    await window.getByTestId('library-tab-frames').click();
    await window.getByTestId('library-frames').waitFor({ state: 'visible', timeout: 5_000 });
    await sleep(400);
    const opening = await panelState(window);
    check(
      'every frame is shown, group by group, each its own picture',
      opening.ids.length === FRAME_COUNT && opening.distinct === FRAME_COUNT,
      `${opening.ids.length} tiles, ${opening.distinct} distinct`,
    );
    check(
      'the groups come in the panel’s order, four or more to each',
      opening.groups.map((group) => group.id).join() === GROUPS.join() && opening.groups.every((group) => group.tiles >= 4),
      JSON.stringify(opening.groups),
    );
    check('the tiles are drawn in the project’s shape', Math.abs(opening.shape - 16 / 9) < 0.02, `${opening.shape.toFixed(3)}`);

    console.log('2. a click lays one over');
    // A background underneath, so there is something for the frame to be over.
    await window.getByTestId('library-tab-backgrounds').click();
    await window.getByTestId('library-background-ocean').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 1, null, { timeout: 20_000 });
    await window.getByTestId('library-tab-frames').click();
    await sleep(300);
    await window.getByTestId('library-frame-white').click();
    await window.waitForFunction(() => Object.keys(window.__scfStore.getState().project.clips).length === 2, null, { timeout: 20_000 });
    await sleep(300);
    const placed = await window.evaluate(() => {
      const { project, assets } = window.__scfStore.getState();
      const clips = Object.values(project.clips);
      const asset = (clip) => assets.find((candidate) => candidate.uri === clip.sourceUri);
      const frameClip = clips.find((clip) => /frame-white-/.test(asset(clip)?.sourcePath ?? ''));
      const under = clips.find((clip) => /bg-ocean-/.test(asset(clip)?.sourcePath ?? ''));
      const rows = project.tracks.filter((track) => track.type !== 'audio').sort((a, b) => a.order - b.order);
      const at = (clip) => rows.findIndex((row) => row.id === clip.trackId);
      const info = asset(frameClip);
      return {
        above: frameClip && under ? at(frameClip) > at(under) : false,
        width: info?.width ?? 0,
        height: info?.height ?? 0,
        path: (info?.sourcePath ?? '').split(/[\\/]/).pop(),
      };
    });
    check('it lands on a track above the footage', placed.above, `path ${placed.path}`);
    check('the frame is made at the project’s own size', placed.width === 1920 && placed.height === 1080, `${placed.width}x${placed.height}`);

    console.log('3. the rendered picture');
    // The middle must still be the footage, and the edge must be the frame.
    const sampled = await window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, 1, true);
        const at = (fx, fy) => {
          const x = Math.round(project.width * fx);
          const y = Math.round(project.height * fy);
          const i = (y * project.width + x) * 4;
          return [rgba[i], rgba[i + 1], rgba[i + 2]];
        };
        return { middle: at(0.5, 0.5), edge: at(0.01, 0.5) };
      } finally {
        renderer.endExclusive();
      }
    });
    const white = (pixel) => pixel.every((channel) => channel > 230);
    check(
      'the middle of the picture is still the footage, not the frame',
      !white(sampled.middle),
      `middle rgb(${sampled.middle.join()})`,
    );
    check('and the edge is the frame', white(sampled.edge), `edge rgb(${sampled.edge.join()})`);


    // Before the project settings change below: that is an undoable step too,
    // and one undo would take back the settings rather than the frame.
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const left = await window.evaluate(() => Object.keys(window.__scfStore.getState().project.clips).length);
    check('one undo takes the frame off', left === 1, );
    await window.evaluate(() => window.__scfStore.getState().redo());
    await sleep(200);
    console.log('4. vertical, the groups, the search');
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1080, height: 1920, fps: 30 }));
    await sleep(500);
    const vertical = await panelState(window);
    check('a vertical project draws vertical tiles', Math.abs(vertical.shape - 1080 / 1920) < 0.02, `${vertical.shape.toFixed(3)}`);

    await window.getByTestId('frame-filter-safe').click();
    await sleep(250);
    const safe = await panelState(window);
    check('a group shows only its own', safe.groups.length === 1 && safe.groups[0].id === 'safe' && safe.ids.includes('safeShorts'), JSON.stringify(safe.groups));
    await window.getByTestId('frame-filter-all').click();
    await window.getByTestId('frame-search').fill('neo');
    await sleep(250);
    const found = await panelState(window);
    check('the search finds one by name', found.ids.length === 1 && found.ids[0] === 'neon', found.ids.join());
    await window.getByTestId('frame-search').fill('zzzz');
    await sleep(250);
    const none = await window.evaluate(() => Boolean(document.querySelector('[data-testid="frame-no-match"]')));
    check('it says so when nothing is called that', none);
    await window.getByTestId('frame-search').fill('');


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
