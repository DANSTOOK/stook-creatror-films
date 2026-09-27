import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Colour phase 2 in the running app: `npm run test:grade:ui`
 *
 *   - the four wheels: named, dragged, double-clicked back, moved from the
 *     keyboard, typed in as numbers, reset per group - in English and in
 *     Spanish - and what they do to the picture;
 *   - the before/after: the curtain dragged and moved with the keys, the
 *     grade switched off - on the canvas only, never in an export (through
 *     the export dialog, the raw pipe and the canvas the GPU encoder reads)
 *     and never in the scopes;
 *   - copy and paste a grade, from the context menu onto several clips and
 *     with the keys, each one undo step;
 *   - a grade saved, reopened, and a project saved before the wheels.
 *
 * The picture is a flat grey at 64, so graded and ungraded are unmistakable:
 * a gain of +1 doubles it to 128. The window is never shown (SCF_BACKGROUND).
 * Screenshots go to GRADE_SHOTS when it is set.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'grade');
const shotsDir = process.env.GRADE_SHOTS ?? '';

const W = 1280;
const H = 720;
const GREY = 64;
const VIDEO1_ROW_Y = 24 + 58 + 28;
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
  const still = join(workDir, 'grey64.png');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x404040:s=${W}x${H}`, '-frames:v', '1', still]);
  const projectPath = join(workDir, 'graded.scf');
  const oldProjectPath = join(workDir, 'before-wheels.scf');

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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 950));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.evaluate(({ w, h }) => window.__scfStore.getState().setProjectSettings({ width: w, height: h }), { w: W, h: H });

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, still);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 30_000 });

    // Three clips of the grey on Video 1: A at 0, B at 200, C at 400.
    const ids = await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      const asset = store.assets[0];
      const made = [0, 200, 400].map((start) => window.__scfStore.getState().addAssetToTimeline(asset, track.id, start));
      window.__scfStore.getState().selectClips([made[0]]);
      window.__scfStore.getState().setCurrentFrame(10);
      return made;
    });
    const [clipA, clipB, clipC] = ids;
    const grading = (id) => window.evaluate((clip) => window.__scfStore.getState().project.clips[clip].colorGrading, id);
    const undoDepth = () => window.evaluate(() => window.__scfHistory.getState().undoStack.length);

    /** One pixel of the viewer's canvas, at a fraction across and halfway down. */
    const canvasPixel = (fraction) => window.evaluate((at) => {
      const canvas = document.querySelector('[data-testid="preview-panel"] canvas');
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d');
      context.drawImage(canvas, 0, 0);
      return [...context.getImageData(Math.floor(canvas.width * at), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3);
    }, fraction);

    console.log('1. the wheels (English)');
    await window.getByRole('tab', { name: 'Color' }).click();
    const names = await window.locator('[data-testid^="wheel-"][data-testid$="-disc"]').evaluateAll((discs) => discs.map((disc) => disc.getAttribute('aria-label')));
    check('four wheels, Lift, Gamma, Gain, Offset', names.join('|') === 'Lift colour wheel|Gamma colour wheel|Gain colour wheel|Offset colour wheel', names.join(' / '));
    const liftTip = await window.getByTestId('wheel-lift').locator('.field-label').getAttribute('data-tooltip');
    check('the tooltip gives the Spanish name', /Sombras/.test(liftTip ?? ''), liftTip ?? '');

    const lift = window.getByTestId('wheel-lift-disc');
    let depth = await undoDepth();
    const box = await lift.boundingBox();
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 12, { steps: 4 });
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 24, { steps: 4 });
    await window.mouse.up();
    let grade = await grading(clipA);
    const luma = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    check('dragging the Lift puck up pushes the shadows toward red, brightness unchanged',
      grade.lift[0] > 0.05 && grade.lift[0] > grade.lift[2] && Math.abs(luma(grade.lift)) < 1e-9 && grade.enabled,
      `lift ${grade.lift.map((v) => v.toFixed(3)).join(', ')}`);
    check('the whole drag is one undo step', (await undoDepth()) === depth + 1, `${(await undoDepth()) - depth} step(s)`);

    await lift.dblclick();
    grade = await grading(clipA);
    check('double-click puts the puck back', grade.lift.every((v) => Math.abs(v) < 1e-9), grade.lift.join(', '));

    const gain = window.getByTestId('wheel-gain-disc');
    await gain.focus();
    for (let i = 0; i < 5; i += 1) await window.keyboard.press('ArrowRight');
    grade = await grading(clipA);
    check('arrow keys move the puck: right is toward blue', grade.gain[2] > 0 && grade.gain[2] > grade.gain[0], grade.gain.map((v) => v.toFixed(3)).join(', '));
    await window.keyboard.press('Delete');
    grade = await grading(clipA);
    check('Delete puts it back', grade.gain.every((v) => Math.abs(v) < 1e-9));

    const gammaMaster = window.getByTestId('wheel-gamma-master');
    await gammaMaster.focus();
    for (let i = 0; i < 10; i += 1) await window.keyboard.press('ArrowRight');
    grade = await grading(clipA);
    check('the brightness slider moves all three channels, no colour', grade.gamma.every((v) => Math.abs(v - 0.1) < 1e-6), grade.gamma.join(', '));
    await gammaMaster.dblclick();
    grade = await grading(clipA);
    check('double-click on the slider puts it back', grade.gamma.every((v) => Math.abs(v) < 1e-9), grade.gamma.join(', '));

    await window.getByTestId('wheel-mode-numbers').click();
    await window.getByTestId('wheel-offset-r').fill('0.1');
    grade = await grading(clipA);
    check('Numbers: R typed into Offset', Math.abs(grade.offset[0] - 0.1) < 1e-9 && grade.offset[1] === 0, grade.offset.join(', '));
    await window.getByTestId('wheel-offset-y').fill('0.05');
    grade = await grading(clipA);
    check('Numbers: Y moves all three by the same', Math.abs(luma(grade.offset) - 0.05) < 1e-6, grade.offset.map((v) => v.toFixed(4)).join(', '));
    await window.getByTestId('wheel-mode-wheels').click();

    // Per group: the basic reset leaves the wheels alone, and the reverse.
    await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      const clip = store.project.clips[id];
      store.updateClip(id, { colorGrading: { ...clip.colorGrading, exposure: 0.5, gain: [0.2, 0.2, 0.2] } });
    }, clipA);
    await window.locator('section[data-section="grading"]').getByRole('button', { name: /^Reset / }).click();
    grade = await grading(clipA);
    const basicReset = grade.exposure === 0 && grade.gain[0] === 0.2 && Math.abs(grade.offset[0]) > 0;
    await window.locator('section[data-section="primaries"]').getByRole('button', { name: /^Reset / }).click();
    grade = await grading(clipA);
    check('each group resets only itself', basicReset && grade.gain.every((v) => v === 0) && grade.offset.every((v) => v === 0));

    // What the wheels do to the picture: gain +1 doubles the grey.
    await window.evaluate((id) => {
      const store = window.__scfStore.getState();
      const clip = store.project.clips[id];
      store.updateClip(id, { colorGrading: { ...clip.colorGrading, enabled: true, gain: [1, 1, 1] } });
    }, clipA);
    await sleep(400);
    const graded = await canvasPixel(0.5);
    check('Gain +1 doubles the grey on the picture: 64 -> 128', graded.every((v) => Math.abs(v - 2 * GREY) <= 1), graded.join(','));

    console.log('2. before/after');
    await window.getByTestId('viewer-compare').click();
    const handle = window.getByTestId('compare-curtain-handle');
    await handle.waitFor({ state: 'visible', timeout: 5_000 });
    const frameBox = await window.locator('[data-testid="preview-panel"] canvas').first().boundingBox();
    const handleBox = await handle.boundingBox();
    await window.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(frameBox.x + frameBox.width * 0.25, handleBox.y + handleBox.height / 2, { steps: 6 });
    await window.mouse.up();
    let split = await window.evaluate(() => window.__scfStore.getState().ui.compareSplit);
    check('the curtain drags', Math.abs(split - 0.25) < 0.02, split.toFixed(3));
    await handle.focus();
    await window.keyboard.press('ArrowRight');
    const nudged = await window.evaluate(() => window.__scfStore.getState().ui.compareSplit);
    check('and moves with the arrow keys', Math.abs(nudged - split - 0.01) < 1e-6, nudged.toFixed(3));
    await sleep(300);
    const before = await canvasPixel(0.1);
    const after = await canvasPixel(0.6);
    check('left of the curtain ungraded, right of it graded', before.every((v) => Math.abs(v - GREY) <= 1) && after.every((v) => Math.abs(v - 2 * GREY) <= 1),
      `before ${before.join(',')}, after ${after.join(',')}`);
    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      await window.screenshot({ path: join(shotsDir, 'grade-en-curtain.png') });
    }

    // Never in what an export reads: the raw pipe's frame, the canvas the GPU
    // encoder takes, and the scopes' reading.
    const exported = await window.evaluate(async () => {
      const renderer = window.__scfRenderer();
      const project = window.__scfStore.getState().project;
      const raw = await renderer.renderExact(project, 10, false);
      const width = project.width;
      const pick = (bytes, x) => [...bytes.subarray((360 * width + x) * 4, (360 * width + x) * 4 + 3)];
      const rawLeft = pick(raw, Math.floor(width * 0.1));
      await renderer.renderExactToCanvas(project, 10);
      const canvas = renderer.canvas;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext('2d').drawImage(canvas, 0, 0);
      const canvasLeft = [...copy.getContext('2d').getImageData(Math.floor(width * 0.1), 360, 1, 1).data].slice(0, 3);
      return { rawLeft, canvasLeft };
    });
    check('the raw export frame is graded where the curtain shows "before"', exported.rawLeft.every((v) => Math.abs(v - 2 * GREY) <= 1), exported.rawLeft.join(','));
    check('so is the canvas the GPU encoder reads', exported.canvasLeft.every((v) => Math.abs(v - 2 * GREY) <= 1), exported.canvasLeft.join(','));

    await window.getByTestId('viewer-scopes').click();
    await window.evaluate(() => window.__scfStore.getState().stepFrames(1));
    await window.waitForFunction(() => Boolean(window.__scfScopeCapture?.()), null, { timeout: 5_000 }).catch(() => undefined);
    await sleep(400);
    const scopeLeft = await window.evaluate(() => {
      const capture = window.__scfScopeCapture();
      const y = Math.floor(capture.height / 2);
      const i = (y * capture.width + Math.floor(capture.width * 0.1)) * 4;
      return [...capture.rgba.subarray(i, i + 3)];
    });
    check('the scopes read the graded picture under the curtain', scopeLeft.every((v) => Math.abs(v - 2 * GREY) <= 1), scopeLeft.join(','));
    await window.getByTestId('viewer-scopes').click();

    await window.getByTestId('viewer-bypass').click();
    await sleep(300);
    const bypassed = await canvasPixel(0.6);
    const badge = await window.getByTestId('grades-off-badge').isVisible();
    check('Show without grades: the whole picture ungraded, and says so', bypassed.every((v) => Math.abs(v - GREY) <= 1) && badge, bypassed.join(','));

    // A real export through the dialog, bypass and curtain both on.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, workDir);
    await window.getByRole('button', { name: 'Export' }).click();
    const exportDialog = window.getByRole('dialog', { name: 'Export' });
    await exportDialog.getByText('Target bitrate', { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
    await exportDialog.getByLabel('Start frame').fill('0');
    await exportDialog.getByLabel('End frame').fill('20');
    await exportDialog.getByLabel('File name').fill('graded');
    await exportDialog.getByRole('button', { name: 'Browse' }).click();
    await exportDialog.getByText('Will save as', { exact: false }).waitFor({ state: 'visible', timeout: 10_000 });
    await exportDialog.getByRole('button', { name: 'Start export' }).click();
    await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 120_000 });
    const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-i', join(workDir, 'graded.mp4'), '-map', '0:v:0', '-vf', 'select=eq(n\\,10)',
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const filePixel = (x) => [...stdout.subarray((360 * W + x) * 3, (360 * W + x) * 3 + 3)];
    const fileLeft = filePixel(Math.floor(W * 0.1));
    const fileRight = filePixel(Math.floor(W * 0.6));
    check('the exported file is graded all across, curtain and bypass notwithstanding',
      [...fileLeft, ...fileRight].every((v) => Math.abs(v - 2 * GREY) <= 2), `left ${fileLeft.join(',')}, right ${fileRight.join(',')}`);
    await window.keyboard.press('Escape');
    await sleep(300);
    await window.getByTestId('viewer-bypass').click();
    await window.getByTestId('viewer-compare').click();

    console.log('3. copy and paste a grade');
    const surface = window.locator('canvas').last();
    const clipX = (frame) => window.evaluate((f) => {
      const { ui } = window.__scfStore.getState();
      return f * ui.pixelsPerFrame - ui.scrollLeftPx + 20;
    }, frame);
    await surface.click({ button: 'right', position: { x: await clipX(0), y: VIDEO1_ROW_Y } });
    await window.getByRole('menuitem', { name: 'Copy grade' }).click();
    await window.evaluate(({ b, c }) => window.__scfStore.getState().selectClips([b, c]), { b: clipB, c: clipC });
    depth = await undoDepth();
    await surface.click({ button: 'right', position: { x: await clipX(200), y: VIDEO1_ROW_Y } });
    await window.getByRole('menuitem', { name: 'Paste grade onto 2 clips' }).click();
    const [gradeB, gradeC] = [await grading(clipB), await grading(clipC)];
    check('Paste grade from the menu onto two clips', gradeB.gain[0] === 1 && gradeC.gain[0] === 1 && gradeB.enabled && gradeC.enabled);
    check('in one undo step', (await undoDepth()) === depth + 1);
    await window.keyboard.press('Control+z');
    check('one undo takes it off both', (await grading(clipB)).gain[0] === 0 && (await grading(clipC)).gain[0] === 0);

    await window.evaluate((a) => window.__scfStore.getState().selectClips([a]), clipA);
    await window.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await window.evaluate((a) => window.__scfStore.getState().selectClips([a]), clipA);
    await window.keyboard.press('Control+Alt+c');
    await window.evaluate((b) => window.__scfStore.getState().selectClips([b]), clipB);
    await window.keyboard.press('Control+Alt+v');
    check('Ctrl+Alt+C, Ctrl+Alt+V', (await grading(clipB)).gain[0] === 1 && (await grading(clipC)).gain[0] === 0);

    console.log('4. saved, reopened, and a project from before the wheels');
    await window.evaluate((a) => {
      const store = window.__scfStore.getState();
      const clip = store.project.clips[a];
      store.updateClip(a, { colorGrading: { ...clip.colorGrading, lift: [0.1, -0.05, 0.02], gamma: [0.2, 0.2, 0.2], pivot: 0.4 } });
    }, clipA);
    const savedGrade = await grading(clipA);
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, projectPath);
    await appMenu(window, 'File', /^Save$/);
    await window.getByText('Saved to', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, projectPath);
    await appMenu(window, 'File', /^Open project/);
    await window.getByText('Opened', { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 });
    const reopened = await grading(clipA);
    check('the wheels and the pivot survive saving and reopening', JSON.stringify(reopened) === JSON.stringify(savedGrade));

    // The same file, as a build before the wheels would have written it.
    const saved = JSON.parse(await readFile(projectPath, 'utf8'));
    for (const clip of Object.values(saved.project.clips)) {
      delete clip.colorGrading.lift;
      delete clip.colorGrading.gamma;
      delete clip.colorGrading.gain;
      delete clip.colorGrading.offset;
      delete clip.colorGrading.pivot;
    }
    await writeFile(oldProjectPath, JSON.stringify(saved));
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, oldProjectPath);
    await appMenu(window, 'File', /^Open project/);
    // Opened when clip A's gamma - +0.2 in the file just saved - reads neutral.
    await window.waitForFunction((a) => window.__scfStore.getState().project.clips[a]?.colorGrading.gamma?.[0] === 0, clipA, { timeout: 30_000 })
      .catch(() => undefined);
    const old = await grading(clipA);
    check('a project from before the wheels opens with them neutral, the rest as saved',
      [old.lift, old.gamma, old.gain, old.offset].every((wheel) => wheel.every((v) => v === 0)) && old.pivot === 0.5
        && old.exposure === savedGrade.exposure && old.enabled === savedGrade.enabled,
      `wheels ${JSON.stringify([old.lift, old.gamma, old.gain, old.offset])}, pivot ${old.pivot}`);
    await window.evaluate((a) => window.__scfStore.getState().selectClips([a]), clipA);

    console.log('5. the wheels in Spanish');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(400);
    await window.getByRole('tab', { name: 'Color' }).click();
    const namesEs = await window.locator('[data-testid^="wheel-"][data-testid$="-disc"]').evaluateAll((discs) => discs.map((disc) => disc.getAttribute('aria-label')));
    check('Sombras, Medios, Luces, Global', namesEs.join('|') === 'Rueda de color de Sombras|Rueda de color de Medios|Rueda de color de Luces|Rueda de color de Global', namesEs.join(' / '));
    const tipEs = await window.getByTestId('wheel-lift').locator('.field-label').getAttribute('data-tooltip');
    check('with the English name in the tooltip', /Lift/.test(tipEs ?? ''), tipEs ?? '');
    const gainEs = window.getByTestId('wheel-gain-disc');
    const gainBox = await gainEs.boundingBox();
    await window.mouse.move(gainBox.x + gainBox.width / 2, gainBox.y + gainBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(gainBox.x + gainBox.width / 2 + 20, gainBox.y + gainBox.height / 2, { steps: 5 });
    await window.mouse.up();
    grade = await grading(clipA);
    check('dragging Luces to the right pushes the highlights toward blue', grade.gain[2] > grade.gain[0], grade.gain.map((v) => v.toFixed(3)).join(', '));
    await window.getByTestId('wheel-lift-disc').focus();
    await window.keyboard.press('ArrowUp');
    grade = await grading(clipA);
    const liftMoved = grade.lift[0] > 0.01;
    await window.getByTestId('wheel-lift-disc').dblclick();
    grade = await grading(clipA);
    check('the keyboard and double-click work in Spanish too', liftMoved && Math.abs(grade.lift[0] - grade.lift[2]) < 1e-9);
    if (shotsDir) {
      await window.getByTestId('viewer-compare').click();
      await sleep(600);
      await window.screenshot({ path: join(shotsDir, 'grade-es-curtain.png') });
      await window.getByTestId('wheel-mode-numbers').click();
      await sleep(300);
      await window.screenshot({ path: join(shotsDir, 'grade-es-numbers.png') });
      await window.getByTestId('wheel-mode-wheels').click();
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
