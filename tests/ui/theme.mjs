import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Appearance, in the running app: `node tests/ui/theme.mjs`
 *
 *   1. Dark by default, with the blue accent: the panels as they have always
 *      been.
 *   2. Preferences > Light turns the panels white and the text dark - and
 *      the timeline's canvas with them - at a contrast that reads (4.5:1).
 *   3. Preferences > Violet puts the accent on the Export button and the
 *      active controls.
 *   4. Both are remembered after a restart, and a panel in a window of its
 *      own wears them too.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'theme');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Colours of a few things, and the contrast of the panel text, read from the page. */
const look = (page) =>
  page.evaluate(() => {
    const parse = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = ([r, g, b]) => {
      const lin = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const panel = document.querySelector('[data-testid="media-panel"]') ?? document.querySelector('aside');
    const title = panel?.querySelector('h2, header span, header');
    const background = parse(getComputedStyle(panel).backgroundColor);
    const text = parse(getComputedStyle(title).color);
    const exportButton = [...document.querySelectorAll('button')].find((button) => /^(Export|Exportar)$/.test(button.textContent?.trim() ?? ''));
    const canvas = document.querySelector('[data-testid="timeline-canvas"]') ?? document.querySelector('[data-panel="timeline"] canvas');
    let canvasPixel = [0, 0, 0];
    if (canvas) {
      const data = canvas.getContext('2d').getImageData(Math.floor(canvas.width * 0.9), Math.floor(canvas.height * 0.95), 1, 1).data;
      canvasPixel = [data[0], data[1], data[2]];
    }
    return {
      theme: document.documentElement.getAttribute('data-theme') ?? 'dark',
      accent: document.documentElement.getAttribute('data-accent') ?? 'blue',
      background,
      text,
      contrast: contrast(background, text),
      exportFill: parse(getComputedStyle(exportButton).backgroundColor),
      canvasPixel,
    };
  });

async function launch(profile) {
  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const window = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
  await window.getByRole('button', { name: /Blank project|Proyecto en blanco/ }).click({ force: true, timeout: 30_000 });
  await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
  await sleep(800);
  return { app, window };
}

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);
  const issues = [];
  let { app, window } = await launch(profile);
  let pid = app.process().pid;
  try {
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));

    console.log('1. dark, blue');
    const dark = await look(window);
    check('dark by default, the blue accent on Export', dark.theme === 'dark' && dark.accent === 'blue' && dark.background[0] < 40 && dark.exportFill.join(',') === '37,99,235', JSON.stringify(dark));

    console.log('2. light');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('prefs-appearance').waitFor({ state: 'visible', timeout: 5_000 });
    await window.getByTestId('prefs-theme-light').click();
    await sleep(400);
    const light = await look(window);
    check('Light turns the panels white and the text dark, reading at 4.5:1 or better', light.theme === 'light' && light.background[0] > 230 && light.text[0] < 80 && light.contrast >= 4.5, `${light.background} on ${light.text}, ${light.contrast.toFixed(1)}:1`);
    check('the timeline’s canvas turns light with it', light.canvasPixel[0] > 200, `canvas ${light.canvasPixel}`);

    console.log('3. violet');
    await window.getByTestId('prefs-accent-violet').click();
    await sleep(300);
    const violet = await look(window);
    check('Violet puts the accent on Export', violet.accent === 'violet' && violet.exportFill.join(',') === '124,58,237', JSON.stringify(violet.exportFill));
    await window.keyboard.press('Escape');

    console.log('4. remembered, and in a window of its own');
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
    ({ app, window } = await launch(profile));
    pid = app.process().pid;
    const again = await look(window);
    check('both are remembered after a restart', again.theme === 'light' && again.accent === 'violet', `${again.theme}, ${again.accent}`);
    await window.getByTestId('detach-inspector').click();
    await sleep(1500);
    const popout = app.windows().find((page) => page !== window);
    const popLook = popout ? await popout.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), accent: document.documentElement.getAttribute('data-accent'), bg: getComputedStyle(document.body.querySelector('aside, section, div')).backgroundColor })) : null;
    check('a panel in a window of its own wears them too', popLook?.theme === 'light' && popLook?.accent === 'violet', JSON.stringify(popLook));

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
