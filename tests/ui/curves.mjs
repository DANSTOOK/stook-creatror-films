import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Colour phase 3 in the running app: `npm run test:curves:ui`
 *
 *   - the curve editor: a point added by clicking and dragged in the same
 *     gesture (one undo step), removed by double-click, added, moved and
 *     removed from the keyboard - without the keys reaching the editor's
 *     shortcuts - and the ends of a level curve kept at the ends;
 *   - a reset per curve and per group; the hue curves' first point bringing
 *     its two flat neighbours;
 *   - the vignette on the picture;
 *   - copy/paste and the before/after curtain carrying the new parts;
 *   - a project from before the curves opening neutral;
 *   - the same in Spanish.
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots go to CURVES_SHOTS.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'curves');
const shotsDir = process.env.CURVES_SHOTS ?? '';

const W = 1280;
const H = 720;
const GREY = 96;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function appMenu(window, menu, item) {
  await window.getByTestId('app-menu-button').click();
  await window.getByRole('menuitem', { name: menu, exact: true }).click();
  await window.getByRole('menuitem', { name: item }).click();
  await window.waitForTimeout(250);
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const still = join(workDir, 'grey96.png');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}`, '-frames:v', '1', still]);
  const projectPath = join(workDir, 'curves.scf');
  const oldProjectPath = join(workDir, 'before-curves.scf');

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.evaluate(({ w, h }) => window.__scfStore.getState().setProjectSettings({ width: w, height: h }), { w: W, h: H });

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, still);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 30_000 });
    const [clipA, clipB] = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      const made = [0, 200].map((start) => window.__scfStore.getState().addAssetToTimeline(store.assets[0], track.id, start));
      window.__scfStore.getState().selectClips([made[0]]);
      window.__scfStore.getState().setCurrentFrame(10);
      return made;
    });
    const grading = (id) => window.evaluate((clip) => window.__scfStore.getState().project.clips[clip]?.colorGrading ?? null, id);
    const undoDepth = () => window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    const playhead = () => window.evaluate(() => window.__scfStore.getState().project.currentFrame);
    const canvasPixel = (fx, fy = 0.5) => window.evaluate(([x, y]) => {
      const canvas = document.querySelector('[data-testid="preview-panel"] canvas');
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d');
      context.drawImage(canvas, 0, 0);
      return [...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data].slice(0, 3);
    }, [fx, fy]);

    console.log('1. the curve editor (English)');
    await window.getByRole('tab', { name: 'Color' }).click();
    const master = window.getByTestId('curve-master');
    await master.scrollIntoViewIfNeeded();
    const picks = await window.locator('[data-testid^="curve-pick-"]').evaluateAll((items) => items.map((item) => item.textContent.trim()));
    check('Curves: Master, Red, Green, Blue, and the hue curves', picks.slice(0, 4).join('|') === 'Master|Red|Green|Blue'
      && /Hue vs Hue/.test(picks[4] ?? ''), picks.join(' / '));

    let depth = await undoDepth();
    const box = await master.boundingBox();
    // Down at the middle, a little above the diagonal, then up: one gesture.
    await window.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 4 });
    await window.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.2, { steps: 4 });
    await window.mouse.up();
    let curves = (await grading(clipA)).curves;
    const middle = curves.master[1];
    check('click adds a point and the same gesture drags it', curves.master.length === 3 && Math.abs(middle.x - 0.5) < 0.02 && Math.abs(middle.y - 0.8) < 0.03,
      JSON.stringify(curves.master.map((p) => [p.x.toFixed(2), p.y.toFixed(2)])));
    check('as one undo step', (await undoDepth()) === depth + 1, `${(await undoDepth()) - depth} step(s)`);
    await sleep(400);
    const lifted = await canvasPixel(0.5);
    check('the picture follows: a 96 grey lifted by the curve', lifted.every((v) => v > GREY + 20), lifted.join(','));

    await window.getByTestId('curve-master-point-1').dblclick();
    curves = (await grading(clipA)).curves;
    check('double-click removes the point', curves.master.length === 2);

    // The ends stay at the ends.
    const end = await window.getByTestId('curve-master-point-0').boundingBox();
    await window.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
    await window.mouse.down();
    await window.mouse.move(end.x + 60, end.y - 30, { steps: 4 });
    await window.mouse.up();
    curves = (await grading(clipA)).curves;
    check('the end of a level curve moves only up and down', curves.master[0].x === 0 && curves.master[0].y > 0.05, JSON.stringify(curves.master[0]));
    await window.getByTestId('curve-reset-level').click();

    // The keyboard: Enter adds, arrows move, Delete removes - and none of it
    // reaches the editor's own shortcuts.
    const frameBefore = await playhead();
    await master.focus();
    await window.keyboard.press('Enter');
    curves = (await grading(clipA)).curves;
    const addedByKey = curves.master.length === 3;
    const focusedIsPoint = await window.evaluate(() => document.activeElement?.dataset?.testid ?? '');
    for (let i = 0; i < 5; i += 1) await window.keyboard.press('ArrowUp');
    await window.keyboard.press('ArrowLeft');
    curves = (await grading(clipA)).curves;
    const moved = curves.master[1];
    check('Enter adds a point and focuses it; arrows move it', addedByKey && focusedIsPoint === 'curve-master-point-1'
      && Math.abs(moved.y - (0.5 + 0.05)) < 0.002 && Math.abs(moved.x - 0.49) < 0.002, `${focusedIsPoint} at ${moved.x.toFixed(3)}, ${moved.y.toFixed(3)}`);
    await window.keyboard.press('Delete');
    curves = (await grading(clipA)).curves;
    check('Delete removes the focused point', curves.master.length === 2);
    check('and none of those keys reached the shortcuts: clip still there, playhead where it was',
      (await grading(clipA)) !== null && (await playhead()) === frameBefore, `frame ${await playhead()}`);

    // A reset per curve.
    await window.getByTestId('curve-pick-red').click();
    const red = window.getByTestId('curve-red');
    const redBox = await red.boundingBox();
    await window.mouse.click(redBox.x + redBox.width * 0.3, redBox.y + redBox.height * 0.4);
    await window.getByTestId('curve-pick-master').click();
    await master.focus();
    await window.keyboard.press('Enter');
    await window.getByTestId('curve-pick-red').click();
    await window.getByTestId('curve-reset-level').click();
    curves = (await grading(clipA)).curves;
    check('reset one curve: red back to the diagonal, master kept', curves.red.length === 2 && curves.red.every((p) => p.x === p.y) && curves.master.length === 3);
    await window.locator('section[data-section="curves"]').getByRole('button', { name: /^Reset Curves/ }).click();
    curves = (await grading(clipA)).curves;
    check('reset the group: every level curve back', ['master', 'red', 'green', 'blue'].every((id) => curves[id].length === 2 && curves[id].every((p) => p.x === p.y)));

    console.log('2. hue curves');
    await window.getByTestId('curve-pick-versus').selectOption('hueVsSat');
    const hueSat = window.getByTestId('curve-hueVsSat');
    await hueSat.scrollIntoViewIfNeeded();
    const hueBox = await hueSat.boundingBox();
    await window.mouse.click(hueBox.x + hueBox.width * (2 / 3), hueBox.y + hueBox.height * 0.8);
    curves = (await grading(clipA)).curves;
    const blue = curves.hueVsSat.find((point) => Math.abs(point.x - 2 / 3) < 0.02);
    check('the first point on a hue curve brings two flat neighbours', curves.hueVsSat.length === 3
      && curves.hueVsSat.filter((point) => point.y === 0).length === 2 && blue && blue.y < -0.4,
      JSON.stringify(curves.hueVsSat.map((p) => [p.x.toFixed(2), p.y.toFixed(2)])));
    await window.locator('section[data-section="versusCurves"]').getByRole('button', { name: /^Reset Hue curves/ }).click();
    curves = (await grading(clipA)).curves;
    check('reset the hue curves', ['hueVsHue', 'hueVsSat', 'hueVsLuma', 'lumaVsSat'].every((id) => curves[id].length === 0));

    console.log('3. vignette');
    const amount = window.locator('section[data-section="vignette"] input[type="range"]').first();
    await amount.scrollIntoViewIfNeeded();
    await amount.focus();
    for (let i = 0; i < 60; i += 1) await window.keyboard.press('ArrowLeft');
    let grade = await grading(clipA);
    await sleep(400);
    const centre = await canvasPixel(0.5, 0.5);
    const corner = await canvasPixel(0.01, 0.02);
    check('the vignette darkens the corners and leaves the centre', grade.vignette.amount < -0.55 && corner[0] < centre[0] - 20,
      `amount ${grade.vignette.amount.toFixed(2)}, centre ${centre[0]}, corner ${corner[0]}`);
    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      await window.evaluate((id) => {
        const store = window.__scfStore.getState();
        const clip = store.project.clips[id];
        store.updateClip(id, { colorGrading: { ...clip.colorGrading, curves: { ...clip.colorGrading.curves, master: [{ x: 0, y: 0 }, { x: 0.3, y: 0.22 }, { x: 0.7, y: 0.82 }, { x: 1, y: 1 }], hueVsHue: [{ x: 0.9, y: 0 }, { x: 0.05, y: 0.12 }, { x: 0.2, y: 0 }].sort((a, b) => a.x - b.x) } } });
      }, clipA);
      await window.locator('section[data-section="curves"]').scrollIntoViewIfNeeded();
      await sleep(500);
      await window.screenshot({ path: join(shotsDir, 'curves-en.png') });
    }

    console.log('4. copy, paste, before/after');
    await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      const clip = store.project.clips[id];
      store.updateClip(id, { colorGrading: { ...clip.colorGrading, curves: { ...clip.colorGrading.curves, master: [{ x: 0, y: 0 }, { x: 0.4, y: 0.7 }, { x: 1, y: 1 }] } } });
    }, clipA);
    await window.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await window.evaluate((a) => window.__scfStore.getState().selectClips([a]), clipA);
    await window.keyboard.press('Control+Alt+c');
    await window.evaluate((b) => window.__scfStore.getState().selectClips([b]), clipB);
    await window.keyboard.press('Control+Alt+v');
    const [gradeA, gradeB] = [await grading(clipA), await grading(clipB)];
    check('paste grade carries the curves and the vignette', JSON.stringify(gradeA.curves) === JSON.stringify(gradeB.curves)
      && JSON.stringify(gradeA.vignette) === JSON.stringify(gradeB.vignette));
    await window.evaluate((a) => {
      window.__scfStore.getState().selectClips([a]);
      window.__scfStore.getState().setUi({ compareSplit: 0.5 });
    }, clipA);
    await sleep(400);
    const beforeSide = await canvasPixel(0.3);
    const afterSide = await canvasPixel(0.7);
    check('before/after: curves and vignette off on the left, on on the right', beforeSide.every((v) => Math.abs(v - GREY) <= 1) && afterSide[0] > GREY + 20,
      `left ${beforeSide.join(',')}, right ${afterSide.join(',')}`);
    await window.evaluate(() => window.__scfStore.getState().setUi({ compareSplit: null }));

    console.log('5. saved, and a project from before the curves');
    grade = await grading(clipA);
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, projectPath);
    await appMenu(window, 'File', /^Save$/);
    await window.getByText('Saved to', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
    const saved = JSON.parse(await readFile(projectPath, 'utf8'));
    const savedGrade = saved.project.clips[clipA].colorGrading;
    check('the curves and the vignette are saved', JSON.stringify(savedGrade.curves) === JSON.stringify(grade.curves)
      && JSON.stringify(savedGrade.vignette) === JSON.stringify(grade.vignette));
    for (const clip of Object.values(saved.project.clips)) {
      delete clip.colorGrading.curves;
      delete clip.colorGrading.vignette;
    }
    await writeFile(oldProjectPath, JSON.stringify(saved));
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, oldProjectPath);
    await appMenu(window, 'File', /^Open project/);
    await window.waitForFunction((a) => window.__scfStore.getState().project.clips[a]?.colorGrading.vignette?.amount === 0, clipA, { timeout: 30_000 })
      .catch(() => undefined);
    const old = await grading(clipA);
    check('a project from before the curves opens with them neutral and no vignette',
      old.curves.master.length === 2 && old.curves.hueVsSat.length === 0 && old.vignette.amount === 0 && old.exposure === grade.exposure);
    await window.evaluate((a) => window.__scfStore.getState().selectClips([a]), clipA);

    console.log('6. in Spanish');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(400);
    await window.getByRole('tab', { name: 'Color' }).click();
    const titles = await window.locator('section[data-section="curves"] h3, section[data-section="versusCurves"] h3, section[data-section="vignette"] h3')
      .allInnerTexts();
    const picksEs = await window.locator('[data-testid^="curve-pick-"]').evaluateAll((items) => items.slice(0, 4).map((item) => item.textContent.trim()));
    check('Curvas, Curvas de tono, Viñeta; Maestra, Rojo, Verde, Azul', titles.join('|') === 'Curvas|Curvas de tono|Viñeta' && picksEs.join('|') === 'Maestra|Rojo|Verde|Azul',
      `${titles.join(' / ')} - ${picksEs.join(' / ')}`);
    await window.getByTestId('curve-pick-master').click();
    const masterEs = window.getByTestId('curve-master');
    await masterEs.scrollIntoViewIfNeeded();
    const esBox = await masterEs.boundingBox();
    await window.mouse.click(esBox.x + esBox.width * 0.25, esBox.y + esBox.height * 0.9);
    curves = (await grading(clipA)).curves;
    const added = curves.master.find((point) => Math.abs(point.x - 0.25) < 0.02);
    await window.getByTestId(`curve-master-point-${curves.master.indexOf(added)}`).focus();
    await window.keyboard.press('Delete');
    const afterDelete = (await grading(clipA)).curves.master.length;
    check('the editor works in Spanish: click adds, Supr removes', Boolean(added) && afterDelete === curves.master.length - 1);
    if (shotsDir) {
      await window.evaluate((id) => {
        const store = window.__scfStore.getState();
        const clip = store.project.clips[id];
        store.updateClip(id, { colorGrading: { ...clip.colorGrading, enabled: true, curves: { ...clip.colorGrading.curves, master: [{ x: 0, y: 0 }, { x: 0.3, y: 0.22 }, { x: 0.7, y: 0.82 }, { x: 1, y: 1 }] }, vignette: { amount: -0.6, size: 0.35, roundness: 0, feather: 0.6 } } });
      }, clipA);
      await window.getByTestId('curve-pick-versus').selectOption('hueVsLuma');
      await window.locator('section[data-section="curves"]').scrollIntoViewIfNeeded();
      await sleep(500);
      await window.screenshot({ path: join(shotsDir, 'curves-es.png') });
      await window.locator('section[data-section="vignette"]').scrollIntoViewIfNeeded();
      await sleep(400);
      await window.screenshot({ path: join(shotsDir, 'vignette-es.png') });
    }

    check('no errors in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
  }

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
