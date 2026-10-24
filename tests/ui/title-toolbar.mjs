import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The text's toolbar in the viewer, as CapCut's player has it: `node tests/ui/title-toolbar.mjs`
 *
 *   1. a double-click on a title opens its text for typing, and a toolbar by
 *      it - over the box, inside the picture;
 *   2. bigger, bold (on or off), right-aligned and capitals change the title, and
 *      the text stays open and focused: what is typed next still goes in;
 *   3. a font from its list changes the family and the typing goes on;
 *   4. Done ends the edit and the toolbar goes; so does a click elsewhere;
 *   5. each change is an undo step of its own.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'title-toolbar');
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
  const video = join(work, 'back.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const titleId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1280, height: 720, fps: 30 });
      s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video' && t.order === 0).id, 0);
      const id = window.__scfStore.getState().addTitle('title', { trackId: null, startFrame: 0 });
      window.__scfStore.getState().setCurrentFrame(60);
      window.__scfStore.getState().selectClips([id]);
      return id;
    });
    await sleep(800);
    const styleNow = () => window.evaluate((id) => {
      const title = window.__scfStore.getState().project.clips[id].title;
      return { size: title.style.fontSize, weight: title.style.fontWeight, align: title.style.align, caps: title.style.uppercase === true, family: title.style.fontFamily, text: title.text };
    }, titleId);
    const editingNow = () => window.evaluate(() => ({
      editing: window.__scfStore.getState().ui.editingTitleId,
      focused: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName,
      toolbar: Boolean(document.querySelector('[data-testid="title-toolbar"]')),
    }));
    const depth = () => window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    const openEditor = async () => {
      const box = await window.getByTestId('viewport-title-box').locator('polygon').last().boundingBox();
      await window.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      await window.getByTestId('title-editor').waitFor({ state: 'visible', timeout: 5_000 });
      await sleep(200);
    };

    /* 1. the editor and its toolbar ---------------------------------------------- */
    await openEditor();
    const placed = await window.evaluate(() => {
      const bar = document.querySelector('[data-testid="title-toolbar"]')?.getBoundingClientRect();
      const text = document.querySelector('[data-testid="title-editor"]')?.getBoundingClientRect();
      const picture = document.querySelector('[data-testid="preview-panel"] canvas')?.getBoundingClientRect();
      if (!bar || !text || !picture) return null;
      return {
        clear: bar.bottom <= text.top + 1 || bar.top >= text.bottom - 1,
        inside: bar.left >= picture.left - 1 && bar.right <= picture.right + 1 && bar.top >= picture.top - 1 && bar.bottom <= picture.bottom + 1,
      };
    });
    check('a double-click opens the text and a toolbar by it, clear of the text, inside the picture', placed?.clear && placed?.inside, JSON.stringify(placed));
    await window.keyboard.type('Hola');
    await sleep(200);

    /* 2. its buttons ---------------------------------------------------------------- */
    const before = await styleNow();
    const stepsBefore = await depth();
    await window.getByTestId('title-toolbar-bigger').click();
    await window.getByTestId('title-toolbar-bold').click();
    await window.getByTestId('title-toolbar-align-right').click();
    await window.getByTestId('title-toolbar-caps').click();
    await sleep(300);
    const changed = await styleNow();
    const stillEditing = await editingNow();
    // Bold turns bold on or off: a title that starts bold (the default one does) comes off it.
    const boldFlipped = before.weight >= 600 ? changed.weight < 600 : changed.weight >= 600;
    check('bigger, bold, right-aligned and capitals change the title', changed.size === before.size + 8 && boldFlipped && changed.align === 'right' && changed.caps, `${JSON.stringify(before)} -> ${JSON.stringify(changed)}`);
    check('and the text stays open and focused', stillEditing.editing === titleId && stillEditing.focused === 'title-editor' && stillEditing.toolbar, JSON.stringify(stillEditing));
    await window.keyboard.type(' mundo');
    await sleep(300);
    check('what is typed next still goes in', /Hola mundo/.test((await styleNow()).text), (await styleNow()).text);

    /* 3. a font from its list ------------------------------------------------------- */
    await window.getByTestId('title-toolbar-font').selectOption('Oswald');
    await sleep(400);
    const afterFont = await styleNow();
    const afterFontEditing = await editingNow();
    check('a font from its list changes the family, and the edit goes on', afterFont.family === 'Oswald' && afterFontEditing.editing === titleId && afterFontEditing.toolbar, `${afterFont.family} ${JSON.stringify(afterFontEditing)}`);

    /* 4. Done, and a click elsewhere ----------------------------------------------- */
    await window.getByTestId('title-toolbar-done').click();
    await sleep(300);
    const done = await editingNow();
    check('Done ends the edit and the toolbar goes', done.editing === null && !done.toolbar, JSON.stringify(done));
    const stepsAfter = await depth();
    await openEditor();
    await window.getByTestId('timeline-canvas').click({ position: { x: 600, y: 10 } });
    await sleep(300);
    const away = await editingNow();
    check('a click elsewhere ends it too', away.editing === null && !away.toolbar, JSON.stringify(away));

    /* 5. undo -------------------------------------------------------------------------- */
    // The typing, the size, bold, alignment, capitals and the font: one step each, at least.
    check('each change is an undo step of its own', stepsAfter - stepsBefore >= 5, `${stepsAfter - stepsBefore} steps`);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(200);
    const undone = await styleNow();
    check('and the last one comes back with one undo', undone.family !== 'Oswald' || undone.text !== afterFont.text, JSON.stringify(undone));

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
