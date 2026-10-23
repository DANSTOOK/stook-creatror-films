import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Markers, the look, and the library's search, in the running app:
 * `node tests/ui/tidy.mjs`
 *
 *   1. A marker clicked on the ruler shows its own Rename and Delete beside
 *      its flag; Delete (the key) removes it and not the selected clip; the
 *      Delete button does too; undo brings it back.
 *   2. Light, System and Dark in Preferences reach what the page cannot paint:
 *      Windows' caption buttons, native scrollbars and menus (nativeTheme),
 *      remembered for the next start; System follows Windows.
 *   3. Titles, Transitions and Effects open with one row - a search and a
 *      category drop-down - instead of lines of chips; the drop-down lists
 *      each category with how many it holds, and a search updates the counts.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'tidy');
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
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    window.on('console', (message) => { if (message.type() === 'error') issues.push(`console ${message.text()}`); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const clipId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video').id, 0);
      const id = Object.keys(window.__scfStore.getState().project.clips)[0];
      window.__scfStore.getState().selectClips([id]);
      return id;
    });

    console.log('1. markers');
    const addAndClick = async () => {
      await window.evaluate(() => window.__scfStore.getState().addMarker(40));
      await sleep(200);
      const canvas = await window.locator('[data-panel="timeline"] canvas').first().boundingBox();
      const x = await window.evaluate(() => 40 * window.__scfStore.getState().ui.pixelsPerFrame - window.__scfStore.getState().ui.scrollLeftPx);
      await window.mouse.click(canvas.x + x, canvas.y + 5);
      await sleep(250);
    };
    await addAndClick();
    const tools = await window.getByTestId('marker-tools').isVisible().catch(() => false);
    check('a marker clicked on the ruler shows its Rename and Delete beside it', tools && (await window.getByTestId('marker-delete').isVisible()));
    await window.keyboard.press('Delete');
    await sleep(250);
    const afterKey = await window.evaluate((id) => ({ markers: window.__scfStore.getState().project.markers.length, clip: Boolean(window.__scfStore.getState().project.clips[id]) }), clipId);
    check('Delete removes the marker, not the clip that was selected', afterKey.markers === 0 && afterKey.clip, JSON.stringify(afterKey));
    await addAndClick();
    await window.getByTestId('marker-delete').click();
    await sleep(250);
    const afterButton = await window.evaluate(() => window.__scfStore.getState().project.markers.length);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(250);
    const undone = await window.evaluate(() => window.__scfStore.getState().project.markers.length);
    check('its Delete button removes it too; undo brings it back', afterButton === 0 && undone === 1, `${afterButton} then ${undone}`);

    console.log('2. the look');
    const native = () => app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }));
    const choose = async (name) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
      await window.getByRole('radio', { name, exact: true }).first().click();
      await sleep(400);
      const page = await window.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme') ?? 'dark' }));
      await window.getByRole('button', { name: 'Done' }).click();
      await sleep(200);
      return { page: page.theme, ...(await native()) };
    };
    const light = await choose('Light');
    const kept = JSON.parse(readFileSync(join(profile, 'scf', 'appearance.json'), 'utf8'));
    check('Light reaches Windows’ caption buttons and native controls, and is remembered', light.page === 'light' && light.source === 'light' && !light.dark && kept.theme === 'light', JSON.stringify({ light, kept }));
    // Warning, error, "done" and info lines on a white panel: the dark shade of each, readable;
    // on a dark badge of their own, still the light one.
    const contrast = await window.evaluate(() => {
      const panel = document.querySelector('[data-testid="media-panel"]');
      const luminance = (rgb) => {
        const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
        return (x + 0.05) / (y + 0.05);
      };
      const background = getComputedStyle(panel).backgroundColor;
      const out = {};
      for (const name of ['text-amber-300', 'text-red-300', 'text-emerald-300', 'text-sky-300', 'text-amber-200']) {
        const probe = document.createElement('span');
        probe.className = name;
        probe.textContent = 'x';
        panel.appendChild(probe);
        out[name] = +ratio(getComputedStyle(probe).color, background).toFixed(1);
        probe.remove();
      }
      // Inside a dialog: its dimmed backdrop is bg-black too, which must not count as a dark badge.
      const backdrop = document.createElement('div');
      backdrop.className = 'fixed inset-0 bg-black/50';
      const card = document.createElement('div');
      card.className = 'bg-panel-900';
      const line = document.createElement('span');
      line.className = 'text-emerald-300';
      line.textContent = 'x';
      card.appendChild(line);
      backdrop.appendChild(card);
      panel.appendChild(backdrop);
      out.inDialog = +ratio(getComputedStyle(line).color, getComputedStyle(card).backgroundColor).toFixed(1);
      backdrop.remove();
      const badge = document.createElement('span');
      badge.className = 'bg-red-900/90 text-red-200';
      panel.appendChild(badge);
      out.badge = getComputedStyle(badge).color;
      badge.remove();
      return out;
    });
    check('in Light, warning, error, done and info text reads on the panels (4.5:1 or more); on a dark badge it stays light',
      ['text-amber-300', 'text-red-300', 'text-emerald-300', 'text-sky-300', 'text-amber-200', 'inDialog'].every((name) => contrast[name] >= 4.5) && contrast.badge === 'rgb(254, 202, 202)',
      JSON.stringify(contrast));
    const system = await choose('System');
    check('System follows Windows: the page and the native controls agree with it', system.source === 'system' && system.page === (system.dark ? 'dark' : 'light'), JSON.stringify(system));
    const dark = await choose('Dark');
    check('Dark comes back everywhere', dark.page === 'dark' && dark.source === 'dark' && dark.dark, JSON.stringify(dark));

    console.log('3. the search row');
    for (const [tab, prefix, panel] of [['titles', 'title-category', 'library-titles'], ['transitions', 'library-transitions-filter', 'library-transitions'], ['effects', 'library-effects-filter', 'library-effects']]) {
      await window.getByTestId(`library-tab-${tab}`).click();
      await window.getByTestId(panel).waitFor({ state: 'visible', timeout: 5_000 });
      await sleep(300);
      const chips = await window.locator(`[data-testid^="${prefix}-"]`).count();
      const row = await window.getByTestId(`${prefix}-menu`).evaluate((button) => button.parentElement.parentElement.getBoundingClientRect().height);
      await window.getByTestId(`${prefix}-menu`).click();
      const options = await window.locator(`[role="option"][data-testid^="${prefix}-"]`).evaluateAll((list) => list.map((option) => option.textContent));
      await window.keyboard.press('Escape');
      check(`${tab}: one row (a search and a drop-down), its categories listed with their counts`, chips === 1 && row < 48 && options.length >= 5 && options.every((text) => /\d+$/.test(text)),
        `${Math.round(row)} px; ${options.slice(0, 4).join(' | ')}…`);
    }
    await window.getByTestId('library-effects-search').fill('zoom');
    await sleep(300);
    await window.getByTestId('library-effects-filter-menu').click();
    const counted = await window.locator('[role="option"]').evaluateAll((list) => list.map((option) => ({ text: option.textContent, disabled: option.disabled })));
    await window.keyboard.press('Escape');
    const all = Number(counted[0].text.match(/(\d+)$/)?.[1]);
    const shown = await window.locator('[data-testid="library-effects"] li').count();
    check('a search updates the counts, and the categories it leaves empty cannot be picked', all > 0 && all === shown && counted.some((option) => option.disabled), JSON.stringify(counted.map((option) => option.text)));

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
