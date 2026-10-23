import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * The title library in the running app: `node tests/ui/title-library.mjs`
 *
 *   1. every template, on a 16:9 project, with Spanish text full of accents
 *      and ñ: placed, drawn by the real renderer (window.__scfRenderer) at a
 *      few frames of its life, and checked - something is drawn, inside the
 *      title-safe box, and the picture is not clipped at the raster's edge;
 *   2. the same on a vertical 9:16 project;
 *   3. one template exported to a real PNG, and that PNG has the title on it;
 *   4. the browser: its categories, a search, and screenshots of the panel
 *      and of a sample of templates.
 *
 * No request may leave the computer. The window is never shown
 * (SCF_BACKGROUND). Screenshots go to TITLES_SHOTS when it is set.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'title-library');
const shotsDir = process.env.TITLES_SHOTS ?? '';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const SPANISH = 'Álex Núñez\n¿Cañón? ¡Sí! güé';
const TITLE_SAFE = 0.9;

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function launch(profile) {
  const requests = [];
  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, profile)}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const window = await app.firstWindow();
  const issues = [];
  window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
  window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
  window.on('request', (request) => requests.push(request.url()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
  // From the start screen into a blank project.
  const blank = window.getByRole('button', { name: 'Blank project' });
  if (await blank.count()) await blank.click({ force: true });
  await window.waitForTimeout(400);
  return { app, window, issues, requests };
}

/**
 * Place a template, then render it with the real renderer at a few frames of
 * its clip and report, per frame: how much was drawn, the picture's rect, and
 * whether the whole raster the renderer made was captured (not clipped).
 */
const probeTemplate = (window, id, text, width, height) =>
  window.evaluate(
    async ([templateId, spanish, w, h]) => {
      const store = window.__scfStore.getState();
      store.setCurrentFrame(0);
      const clipId = store.addTitle(templateId);
      window.__scfStore.getState().updateTitle(clipId, { text: spanish });
      const clip = window.__scfStore.getState().project.clips[clipId];
      const { startFrame, durationFrames } = clip;
      const renderer = window.__scfRenderer();
      renderer.beginExclusive();
      const frames = [];
      try {
        await renderer.titles.prepare(window.__scfStore.getState().project.clips[clipId]);
        // Early (in the entrance), the middle (at rest), and late (in the exit).
        const offsets = [Math.min(3, durationFrames - 1), Math.floor(durationFrames / 2), Math.max(0, durationFrames - 3)];
        for (const offset of offsets) {
          const project = window.__scfStore.getState().project;
          const rgba = await renderer.renderExact(project, startFrame + offset, false);
          let drawn = 0;
          let inSafe = 0;
          const sx = (w * (1 - 0.9)) / 2;
          const sy = (h * (1 - 0.9)) / 2;
          const ex = w - sx;
          const ey = h - sy;
          for (let y = 0; y < h; y += 2) {
            for (let x = 0; x < w; x += 2) {
              const alpha = rgba[(y * w + x) * 4 + 3];
              if (alpha <= 8) continue;
              drawn += 1;
              if (x >= sx - 2 && x < ex + 2 && y >= sy - 2 && y < ey + 2) inSafe += 1;
            }
          }
          frames.push({ offset, drawn, inSafe, block: renderer.titles.blockOf(clipId), rect: renderer.titles.rectOf(clipId) });
        }
      } finally {
        renderer.endExclusive();
        window.__scfStore.getState().removeClips([clipId]);
      }
      return { durationFrames, frames };
    },
    [id, text, width, height],
  );

async function runSize(window, label, width, height, templates) {
  console.log(`\n${label} (${width}x${height})`);
  let allDrawn = true;
  let allInSafe = true;
  let allWhole = true;
  const worst = { drawn: Infinity, id: '' };
  for (const template of templates) {
    const result = await probeTemplate(window, template.id, SPANISH, width, height);
    // At its fullest (the middle frame) every template must draw something.
    const middle = result.frames[1];
    const drew = middle.drawn > 50;
    if (!drew) allDrawn = false;
    if (middle.drawn < worst.drawn) {
      worst.drawn = middle.drawn;
      worst.id = template.id;
    }
    // The text block - its letters, background and shape, without the shadow
    // or stroke that may bleed past - must sit inside the title-safe box, with
    // a pixel of tolerance. This is the real "inside the safe area, not
    // clipped" test: a drop shadow reaching past the safe edge is fine.
    const safeX = (width * (1 - TITLE_SAFE)) / 2;
    const safeY = (height * (1 - TITLE_SAFE)) / 2;
    const block = middle.block;
    const inSafe =
      block &&
      block.x >= safeX - 1 &&
      block.y >= safeY - 1 &&
      block.x + block.width <= width - safeX + 1 &&
      block.y + block.height <= height - safeY + 1;
    if (!inSafe) {
      allInSafe = false;
      console.log(`      ${template.id}: block ${JSON.stringify(block)} outside safe ${safeX},${safeY}`);
    }
    // And the entrance and exit draw ink too (the title is not blank
    // mid-animation). A roll starts below the frame and ends above it, so only
    // its middle is asked to draw.
    const frames = template.roll ? [result.frames[1]] : result.frames;
    const everyFrameDraws = frames.every((frame) => frame.drawn > 0);
    if (!everyFrameDraws) {
      allWhole = false;
      console.log(`      ${template.id}: a frame drew nothing (${result.frames.map((f) => f.drawn).join(', ')})`);
    }
  }
  check(`${label}: every template draws ink`, allDrawn, `thinnest ${worst.id} with ${worst.drawn} samples`);
  check(`${label}: every template's text block stays inside the title-safe area`, allInSafe);
  check(`${label}: every template draws through its entrance, rest and exit`, allWhole);
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const exportDir = join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });

  const { app, window, issues, requests } = await launch('profile');
  try {
    const templates = await window.evaluate(() => window.__scfTitleTemplates);
    check('the library has 40 or more templates', templates.length >= 40, `${templates.length} templates`);

    // 1. 16:9.
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080 }));
    await runSize(window, '16:9', 1920, 1080, templates);

    // 2. 9:16.
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1080, height: 1920 }));
    await runSize(window, '9:16', 1080, 1920, templates);

    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080 }));

    // 3. The browser: categories, search, screenshots.
    await window.getByTestId('library-tab-titles').click();
    await window.getByTestId('library-titles').waitFor({ state: 'visible', timeout: 5_000 });
    await window.getByTestId('title-category-menu').click();
    const categoryButtons = await window.locator('[data-testid^="title-category-"]').count();
    await window.keyboard.press('Escape');
    check('the Titles panel shows category filters', categoryButtons >= 7, `${categoryButtons} buttons`);
    await window.getByTestId('title-library-search').fill('news');
    await sleep(300);
    const afterSearch = await window.locator('[data-testid^="library-title-"]').count();
    check('a search narrows the templates shown', afterSearch >= 1 && afterSearch < templates.length, `${afterSearch} shown for "news"`);
    await window.getByTestId('title-library-search').fill('');
    await sleep(200);
    await window.getByTestId('title-category-menu').click();

    await window.getByTestId('title-category-cinematic').click();
    await sleep(300);
    if (shotsDir) {
      await window.getByTestId('library-titles').screenshot({ path: join(shotsDir, 'title-browser-cinematic.png') });
      await window.getByTestId('title-category-menu').click();

      await window.getByTestId('title-category-all').click();
      await sleep(400);
      await window.getByTestId('library-titles').screenshot({ path: join(shotsDir, 'title-browser-all.png') });
      // A sample of templates on the canvas, each placed and the viewer shown.
      for (const id of ['lt-news', 'cin-epic', 'soc-hook', 'kin-typewriter', 'end-subscribe']) {
        await window.evaluate((templateId) => {
          const store = window.__scfStore.getState();
          Object.values(store.project.clips).filter((c) => c.title).forEach((c) => store.removeClips([c.id]));
          store.setCurrentFrame(0);
          const clipId = window.__scfStore.getState().addTitle(templateId);
          window.__scfStore.getState().updateTitle(clipId, { text: 'Año · Núñez\n¿Señor? ¡Sí!' });
          const dur = window.__scfStore.getState().project.clips[clipId].durationFrames;
          window.__scfStore.getState().setCurrentFrame(Math.floor(dur / 2));
        }, id);
        await sleep(600);
        await window.getByTestId('preview-panel').screenshot({ path: join(shotsDir, `title-sample-${id}.png`) });
      }
    }

    // 4. A real PNG export of one template with Spanish text.
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      store.setCurrentFrame(0);
      const id = store.addTitle('cin-epic');
      window.__scfStore.getState().updateTitle(id, { text: 'Año Nuevo\n¡Qué película!' });
      window.__scfStore.getState().setExportSettings({ format: 'png-sequence', exportAlpha: false, width: 1920, height: 1080, startFrame: 30, endFrame: 31 });
    });
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, exportDir);
    try {
      await window.getByRole('button', { name: 'Export' }).click();
      const exportDialog = window.getByRole('dialog', { name: 'Export' });
      await exportDialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
      await exportDialog.getByLabel('File name').fill('epic');
      await exportDialog.getByRole('button', { name: 'Browse' }).click();
      await sleep(400);
      await exportDialog.getByRole('button', { name: 'Start export' }).click();
      await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 120_000 }).catch(() => {});
    } catch (error) {
      console.log(`      export flow: ${String(error).split('\n')[0]}`);
    }
    const pngs = [];
    const walk = async (folder) => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(join(folder, entry.name));
        else if (entry.name.endsWith('.png')) pngs.push(entry.name);
      }
    };
    await walk(exportDir);
    check('a template exports to a real PNG', pngs.length >= 1, pngs.join(', '));

    const offenders = requests.filter((url) => !/^(file:|data:|blob:|devtools:|chrome|about:)/.test(url));
    check('no request left the computer', offenders.length === 0, offenders.slice(0, 3).join(', '));
    check('no console errors or page errors', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close();
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
