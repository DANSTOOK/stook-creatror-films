import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Titles, phase 1, in the running app: `npm run test:titles:ui`
 *
 *   1. a fresh profile: the very first exact render of a title waits for
 *      Inter and draws it in Inter, never in a fallback face;
 *   2. adding titles from the Edit menu and the keyboard, and where they go;
 *   3. the Title tab: typing (one undo step), the clip's name following it;
 *   4. pixels: known colours land exactly, a line of text matches a plain
 *      Canvas2D reference over the same picture, the viewer and the exact
 *      render (the export's frame) are identical, and a real PNG export is
 *      identical to them;
 *   5. a 4K project draws 4K edges, not a 1080p picture blown up;
 *   6. a font this computer lacks: noted in the inspector and the export
 *      dialog, and drawn in Inter;
 *   7. saved and reopened unchanged; the font licences dialog;
 *   8. the same in Spanish;
 *   and no request leaves the computer - the fonts load from the app's files.
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots go to TITLES_SHOTS.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'titles');
const shotsDir = process.env.TITLES_SHOTS ?? '';

const W = 1920;
const H = 1080;
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

/** WCAG contrast of two `rgb(...)` strings, the second under the first's alpha. */
function contrast(foreground, background) {
  const parse = (value) => value.match(/[\d.]+/g).map(Number);
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const [a, b] = [lum(parse(foreground)), lum(parse(background))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

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
      SCF_SKIP_HOME: '1',
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
  return { app, window, issues, requests };
}

/** An exact render (the export's frame) of the frame at the playhead, as base64 RGBA. */
const exactFrame = (window, premultiply = false) =>
  window.evaluate(async (premultiplied) => {
    const renderer = window.__scfRenderer();
    const project = window.__scfStore.getState().project;
    renderer.beginExclusive();
    try {
      const rgba = await renderer.renderExact(project, project.currentFrame, premultiplied);
      let binary = '';
      for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
      return btoa(binary);
    } finally {
      renderer.endExclusive();
    }
  }, premultiply).then((b64) => Buffer.from(b64, 'base64'));

/** What the viewer drew for the same frame, read back from the compositor. */
const viewerFrame = (window) =>
  window.evaluate(async () => {
    const renderer = window.__scfRenderer();
    const { project } = window.__scfStore.getState();
    // Let the viewer settle (fonts, textures), then draw once more and read it.
    for (let i = 0; i < 4; i += 1) await new Promise((done) => requestAnimationFrame(done));
    renderer.drawViewport(project, false, false);
    const rgba = renderer.compositor.readPixels(false);
    let binary = '';
    for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
    return btoa(binary);
  }).then((b64) => Buffer.from(b64, 'base64'));

const differences = (a, b, stride = 4, channels = 3) => {
  let worst = 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += stride) {
    for (let c = 0; c < channels; c += 1) {
      const d = Math.abs(a[i + c] - b[i + c]);
      worst = Math.max(worst, d);
      total += d;
      count += 1;
    }
  }
  return { worst, mean: total / count };
};

const titleIds = (window) =>
  window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.title).map((clip) => clip.id));

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const still = join(workDir, 'grey96.png');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}`, '-frames:v', '1', still]);
  const projectPath = join(workDir, 'titles.scf');
  const exportDir = join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });

  const { app, window, issues, requests } = await launch('profile');
  try {
    console.log('1. a fresh profile: the first exact render already uses Inter');
    const first = await window.evaluate(async () => {
      const store = window.__scfStore.getState();
      store.setProjectSettings({ width: 1920, height: 1080 });
      // Nothing on the page has asked for Inter yet.
      const loadedBefore = document.fonts.check('700 16px "Inter"', 'Title');
      const id = window.__scfStore.getState().addTitle('title');
      const renderer = window.__scfRenderer();
      renderer.beginExclusive();
      try {
        const project = window.__scfStore.getState().project;
        // The same task that made the title: no viewer frame has run yet.
        const rgba = await renderer.renderExact(project, project.currentFrame, false);
        let alpha = 0;
        for (let i = 3; i < rgba.length; i += 4) alpha += rgba[i];
        let binary = '';
        for (let i = 0; i < rgba.length; i += 0x8000) binary += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
        return { id, loadedBefore, loadedAfter: document.fonts.check('700 16px "Inter"', 'Title'), alpha, b64: btoa(binary) };
      } finally {
        renderer.endExclusive();
      }
    });
    await sleep(800);
    const settled = await exactFrame(window);
    const firstFrame = Buffer.from(first.b64, 'base64');
    check('Inter was not loaded before the title asked for it', first.loadedBefore === false && first.loadedAfter === true);
    check('the first exact render drew the title (not an empty frame)', first.alpha > 0, `alpha sum ${first.alpha}`);
    check('and drew it exactly as a render once everything settled - in Inter, not a fallback', firstFrame.equals(settled),
      `max difference ${differences(firstFrame, settled, 4, 4).worst}`);
    await window.evaluate((id) => window.__scfStore.getState().removeClips([id]), first.id);

    console.log('2. adding titles');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, still);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 30_000 });
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const track = store.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      const id = store.addAssetToTimeline(store.assets[0], track.id, 0);
      window.__scfStore.getState().updateClip(id, { durationFrames: 600 });
      window.__scfStore.getState().setCurrentFrame(30);
      window.__scfStore.getState().selectClips([]);

    });
    await appMenu(window, 'Edit', /^Add title/);
    let ids = await titleIds(window);
    const added = await window.evaluate((id) => {
      const s = window.__scfStore.getState();
      const clip = s.project.clips[id];
      const track = s.project.tracks.find((candidate) => candidate.id === clip.trackId);
      return { start: clip.startFrame, length: clip.durationFrames, order: track.order, selected: s.ui.selectedClipIds, text: clip.title.text };
    }, ids[0]);
    check('Edit > Add title puts a 5 s title at the playhead, on the track above the picture, selected',
      ids.length === 1 && added.start === 30 && added.length === 150 && added.order === 1 && added.selected[0] === ids[0] && added.text === 'Title',
      JSON.stringify(added));
    const titleTab = window.getByRole('tab', { name: 'Title' });
    check('the inspector opens on the Title tab: Title, Video, Info',
      (await titleTab.getAttribute('aria-selected')) === 'true'
        && (await window.getByRole('tab').allInnerTexts()).join('|') === 'Title|Video|Info',
      (await window.getByRole('tab').allInnerTexts()).join(' / '));
    const sections = await window.locator('#inspector-tabpanel section h3').allInnerTexts();
    check('its groups: Text, Font, Paragraph, Outline, Shadow, Background, Position',
      sections.join('|') === 'Text|Font|Paragraph|Outline|Shadow|Background|Position', sections.join(' / '));

    await window.keyboard.press('Control+Alt+Shift+T');
    await sleep(300);
    ids = await titleIds(window);
    const lower = await window.evaluate((list) => list.map((id) => window.__scfStore.getState().project.clips[id]).find((clip) => clip.title.preset === 'lowerThird'), ids);
    check('Ctrl+Alt+Shift+T adds a lower third, on a new track on top', Boolean(lower) && ids.length === 2
      && (await window.evaluate((trackId) => window.__scfStore.getState().project.tracks.find((t) => t.id === trackId).order, lower.trackId)) === 2);
    await appMenu(window, 'Edit', /^Add end credits/);
    ids = await titleIds(window);
    check('Edit > Add end credits adds the credits template', ids.length === 3);
    await window.evaluate((list) => window.__scfStore.getState().removeClips(list), ids);

    console.log('3. the Title tab');
    await window.keyboard.press('Control+Alt+T');
    await sleep(300);
    const [titleId] = await titleIds(window);
    const depth = await window.evaluate(() => window.__scfHistory.getState().undoStack.length);
    const text = window.getByTestId('title-text');
    await text.click();
    await text.press('Control+A');
    await text.pressSequentially('Hello world');
    const typed = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return { name: clip.name, text: clip.title.text, depth: window.__scfHistory.getState().undoStack.length };
    }, titleId);
    check('typing changes the text and the clip is named after it', typed.text === 'Hello world' && typed.name === 'Hello world', JSON.stringify(typed));
    check('a typing run is one undo step', typed.depth === depth + 1, `${depth} -> ${typed.depth}`);
    await window.getByTestId('title-align-left').click();
    await window.getByTestId('title-anchor-bottomLeft').click();
    await window.getByTestId('title-font').selectOption('Oswald');
    await window.getByTestId('title-weight').selectOption('600');
    const styled = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].title.style, titleId);
    check('alignment, place, family and weight are set from the tab',
      styled.align === 'left' && styled.anchor === 'bottomLeft' && styled.fontFamily === 'Oswald' && styled.fontWeight === 600, JSON.stringify(styled).slice(0, 160));
    const weightOptions = await window.getByTestId('title-weight').locator('option').allInnerTexts();
    check('Oswald offers only the weights its file has (Extra light to Bold)',
      weightOptions.join('|') === 'Extra light|Light|Regular|Medium|Semibold|Bold', weightOptions.join(' / '));
    const pressed = await window.getByTestId('title-anchor-bottomLeft').getAttribute('aria-pressed');
    check('the chosen place reads as pressed to a screen reader', pressed === 'true');
    if (shotsDir) {
      await sleep(500);
      await window.screenshot({ path: join(shotsDir, 'titles-tab-en.png') });
    }

    console.log('4. pixels');
    // Only the grey picture and one title, whose look is set outright.
    const setTitle = (text, style) => window.evaluate(([id, t, s]) => {
      const store = window.__scfStore.getState();
      store.updateTitle(id, { text: t, style: s });
      store.setCurrentFrame(60);
    }, [titleId, text, style]);
    const noEffects = { stroke: { enabled: false, color: '#000000', width: 0 }, shadow: { enabled: false, color: '#000000', opacity: 0, distance: 0, angle: 90, blur: 0 } };
    await setTitle('I', {
      ...noEffects,
      fontFamily: 'Inter', fontWeight: 900, fontSize: 400, color: '#ff0000', align: 'center', anchor: 'center', letterSpacing: 0, lineHeight: 1.15,
      box: { enabled: true, color: '#00ff00', opacity: 1, padding: 60, radius: 0 },
    });
    await sleep(500);
    let exact = await exactFrame(window);
    const at = (buffer, x, y) => [...buffer.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
    const rect = await window.evaluate((id) => window.__scfRenderer().titles.rectOf(id), titleId);
    let redRun = 0;
    let longestRed = 0;
    for (let y = 0; y < H; y += 1) {
      const [r, g, b] = at(exact, W / 2, y);
      if (r === 255 && g === 0 && b === 0) longestRed = Math.max(longestRed, (redRun += 1));
      else redRun = 0;
    }
    check('the text colour lands exactly: a long run of pure red down the middle of a heavy "I"', longestRed >= 200, `${longestRed} px of 255,0,0`);
    let green = 0;
    for (let x = 0; x < W; x += 1) if (at(exact, x, H / 2).join(',') === '0,255,0,255') green += 1;
    check('the background box colour lands exactly on both sides of it (60 px of padding each side)', green >= 110, `${green} px of 0,255,0 on the middle row`);
    // The picture under the title, as the compositor gives it (the still decodes to 95, not 96).
    const background = at(exact, 40, 40);
    let touched = 0;
    for (let y = 0; y < H; y += 7) {
      for (let x = 0; x < W; x += 7) {
        const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        if (!inside && at(exact, x, y).join(',') !== background.join(',')) touched += 1;
      }
    }
    check('outside the title picture the frame is untouched', touched === 0, `${touched} pixels differ; picture ${JSON.stringify(rect)}`);

    // One line of plain text against a Canvas2D reference drawn over the same grey.
    await setTitle('Reference Ag 123', {
      ...noEffects,
      fontFamily: 'Inter', fontWeight: 700, fontSize: 96, color: '#ffffff', align: 'center', anchor: 'center', letterSpacing: 0, lineHeight: 1.15,
      box: { enabled: false, color: '#000000', opacity: 1, padding: 0, radius: 0 },
    });
    await sleep(500);
    exact = await exactFrame(window);
    const reference = Buffer.from(await window.evaluate(async ([w, h, grey]) => {
      await document.fonts.load('700 96px "Inter"', 'Reference Ag 123');
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d');
      context.fillStyle = `rgb(${grey[0]}, ${grey[1]}, ${grey[2]})`;
      context.fillRect(0, 0, w, h);
      context.font = '700 96px "Inter", sans-serif';
      context.fontKerning = 'normal';
      const measured = context.measureText('Reference Ag 123');
      const metrics = context.measureText('Hg');
      const advance = 96 * 1.15;
      // The layout's rule, written out again: centred on the frame, the glyphs
      // in the middle of the line's height.
      const top = (h - advance) / 2;
      const baseline = top + (advance - (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) / 2 + metrics.fontBoundingBoxAscent;
      context.fillStyle = '#ffffff';
      context.fillText('Reference Ag 123', (w - measured.width) / 2, baseline);
      const data = context.getImageData(0, 0, w, h).data;
      let binary = '';
      for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return btoa(binary);
    }, [W, H, at(exact, 40, 40)]), 'base64');
    const againstReference = differences(exact, reference);
    check('a line of text matches a plain Canvas2D reference over the same picture (within 3 of 255, mean under 0.05)',
      againstReference.worst <= 3 && againstReference.mean < 0.05, `worst ${againstReference.worst}, mean ${againstReference.mean.toFixed(4)}`);

    const viewer = await viewerFrame(window);
    const viewerVsExact = differences(viewer, exact, 4, 4);
    check('the viewer and the exact render (the export\'s frame) are identical', viewerVsExact.worst === 0, `worst ${viewerVsExact.worst}`);

    // A real export: one PNG frame through the export dialog.
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      store.setExportSettings({ format: 'png-sequence', exportAlpha: false, width: 1920, height: 1080, startFrame: 60, endFrame: 61 });
    });
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, exportDir);
    await window.getByRole('button', { name: 'Export' }).click();
    const exportDialog = window.getByRole('dialog', { name: 'Export' });
    await exportDialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
    await exportDialog.getByLabel('Start frame').fill('60');
    await exportDialog.getByLabel('End frame').fill('61');
    await exportDialog.getByLabel('File name').fill('title-frame');
    await exportDialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(500);
    await exportDialog.getByRole('button', { name: 'Start export' }).click();
    const finished = await window.getByText('Export finished', { exact: false })
      .waitFor({ state: 'visible', timeout: 120_000 }).then(() => true).catch(() => false);
    const pngs = [];
    const walk = async (folder) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(folder, entry.name));
        else if (entry.name.endsWith('.png')) pngs.push(join(folder, entry.name));
      }
    };
    await walk(exportDir);
    let exportedVsExact = null;
    if (finished && pngs.length > 0) {
      const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-i', pngs.sort()[0], '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      exportedVsExact = differences(stdout, exact);
    }
    check('a PNG exported through the dialog is identical to the viewer', exportedVsExact?.worst === 0,
      exportedVsExact ? `worst ${exportedVsExact.worst} (${pngs.length} file)` : `finished ${finished}, ${pngs.length} files`);
    await exportDialog.getByTitle('Close').click();
    await exportDialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);

    console.log('5. a 4K project');
    const edgeWidth = (buffer, width, height) => {
      // Across the left edge of the stem of a heavy "I", on the middle row:
      // how many pixels are neither the grey around it nor the white of it.
      const y = Math.round(height / 2);
      let partial = 0;
      for (let x = 0; x < width; x += 1) {
        const v = buffer[(y * width + x) * 4];
        if (v > GREY + 16 && v < 255 - 16) partial += 1;
        if (v >= 255 - 16) break;
      }
      return partial;
    };
    await setTitle('I', {
      ...noEffects,
      fontFamily: 'Inter', fontWeight: 900, fontSize: 300, color: '#ffffff', align: 'center', anchor: 'center',
      box: { enabled: false, color: '#000000', opacity: 1, padding: 0, radius: 0 },
    });
    await sleep(400);
    const hdFrame = await exactFrame(window);
    const hdEdge = edgeWidth(hdFrame, W, H);
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 3840, height: 2160 }));
    // The still fills the frame at any project size: the grey is behind the 4K title too.
    await sleep(600);
    const uhdFrame = await exactFrame(window);
    const uhdEdge = edgeWidth(uhdFrame, 3840, 2160);
    // What a 1080p picture blown up to 4K would give: every pixel of the HD
    // edge doubled, and a bilinear ramp between.
    check('at 4K the edge of a letter is as sharp as at 1080p (at most 2 pixels of ramp), not twice as soft',
      uhdEdge <= 2 && uhdEdge <= hdEdge + 1, `1080p ${hdEdge} px, 4K ${uhdEdge} px; blown up it would be about ${hdEdge * 2} px`);
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080 }));
    await sleep(300);

    console.log('6. a font this computer does not have');
    await setTitle('Missing font', { fontFamily: 'No Such Font SCF', fontWeight: 700, fontSize: 96, anchor: 'center' });
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), titleId);
    await sleep(500);
    const note = window.getByTestId('title-font-missing');
    const noteShown = await note.isVisible().catch(() => false);
    const noteText = noteShown ? await note.innerText() : '';
    check('the Font group says the font is missing and Inter is used', noteShown && /No Such Font SCF/.test(noteText) && /Inter/.test(noteText), noteText);
    const noteColours = await note.evaluate((element) => {
      const style = getComputedStyle(element);
      // The note's tint over the panel it sits on.
      const panel = getComputedStyle(element.closest('aside')).backgroundColor;
      return { color: style.color, background: style.backgroundColor, panel };
    });
    const tint = noteColours.background.match(/[\d.]+/g).map(Number);
    const panel = noteColours.panel.match(/[\d.]+/g).map(Number);
    const under = [0, 1, 2].map((i) => tint[i] * (tint[3] ?? 1) + panel[i] * (1 - (tint[3] ?? 1)));
    const noteContrast = contrast(noteColours.color, `rgb(${under.join(',')})`);
    check('the note is readable (4.5:1)', noteContrast >= 4.5, noteContrast.toFixed(2));
    const missingFrame = await exactFrame(window);
    await setTitle('Missing font', { fontFamily: 'Inter' });
    await sleep(300);
    const interFrame = await exactFrame(window);
    check('the missing font is drawn exactly as Inter', missingFrame.equals(interFrame), `worst ${differences(missingFrame, interFrame).worst}`);
    await setTitle('Missing font', { fontFamily: 'No Such Font SCF' });
    await window.getByRole('button', { name: 'Export' }).click();
    const warning = window.getByTestId('export-fonts-missing');
    const warned = await warning.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    check('the export dialog says so before the render', warned && /No Such Font SCF/.test(await warning.innerText()));
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'titles-export-warning-en.png') });
    await window.getByRole('dialog', { name: 'Export' }).getByTitle('Close').click();
    await sleep(300);
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'titles-missing-font-en.png') });
    await setTitle('Saved title', { fontFamily: 'Source Serif 4', fontWeight: 600, fontSize: 120, shadow: { enabled: true, color: '#000000', opacity: 0.6, distance: 6, angle: 90, blur: 10 } });

    console.log('7. saved, reopened; the licences');
    const beforeSave = await exactFrame(window);
    const titleBefore = await window.evaluate((id) => window.__scfStore.getState().project.clips[id].title, titleId);
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, projectPath);
    await appMenu(window, 'File', /^Save$/);
    await window.getByText('Saved to', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
    const saved = JSON.parse(await readFile(projectPath, 'utf8'));
    check('the title is saved with the project', JSON.stringify(saved.project.clips[titleId]?.title) === JSON.stringify(titleBefore));
    // Opened over itself, unchanged since the save: the project is replaced by what the file says.
    await window.evaluate(() => { window.__beforeOpen = window.__scfStore.getState().project; });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, projectPath);
    await appMenu(window, 'File', /^Open project/);
    await window.waitForFunction((id) => {
      const { project } = window.__scfStore.getState();
      return project !== window.__beforeOpen && Boolean(project.clips[id]?.title);
    }, titleId, { timeout: 30_000 }).catch(() => undefined);
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(60));
    // The still behind it loads again after an open; wait until it is drawn.
    let afterOpen = await exactFrame(window);
    for (let tries = 0; tries < 40 && !afterOpen.equals(beforeSave); tries += 1) {
      await sleep(250);
      afterOpen = await exactFrame(window);
    }
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'titles-reopened-en.png') });
    const reopenedTitle = await window.evaluate((id) => window.__scfStore.getState().project.clips[id]?.title, titleId);
    check('reopened, the title is the same and draws the same', JSON.stringify(reopenedTitle) === JSON.stringify(titleBefore) && afterOpen.equals(beforeSave),
      `worst ${differences(afterOpen, beforeSave).worst}`);

    await appMenu(window, 'Help', /^Font licenses/);
    const licences = window.getByTestId('font-licenses-dialog');
    await licences.waitFor({ state: 'visible', timeout: 5_000 });
    const licenceTexts = await licences.locator('pre').allInnerTexts();
    const licenceNames = await licences.locator('h3').allInnerTexts();
    check('Help > Font licenses shows the OFL text of Inter, Source Serif 4 and Oswald',
      licenceNames.join('|') === 'Inter|Source Serif 4|Oswald' && licenceTexts.every((text) => /SIL OPEN FONT LICENSE/i.test(text)),
      licenceNames.join(' / '));
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'titles-licenses-en.png') });
    await window.keyboard.press('Escape');
    await sleep(300);

    console.log('8. in Spanish');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(400);
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(300));
    await appMenu(window, 'Edición', /^Añadir título/);
    const spanishId = (await titleIds(window)).find((id) => id !== titleId);
    const spanish = await window.evaluate((id) => window.__scfStore.getState().project.clips[id]?.title?.text, spanishId);
    check('Edición > Añadir título writes the template text in Spanish', spanish === 'Título', String(spanish));
    const tabsEs = await window.getByRole('tab').allInnerTexts();
    const sectionsEs = await window.locator('#inspector-tabpanel section h3').allInnerTexts();
    check('the tab and its groups in Spanish', tabsEs[0] === 'Título' && sectionsEs.join('|') === 'Texto|Fuente|Párrafo|Contorno|Sombra|Fondo|Posición',
      `${tabsEs.join(' / ')} - ${sectionsEs.join(' / ')}`);
    await window.keyboard.press('Control+Alt+Shift+T');
    await sleep(300);
    const lowerEs = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).find((clip) => clip.title?.preset === 'lowerThird')?.title.text);
    check('Ctrl+Alt+Shift+T in Spanish: Nombre / Cargo', lowerEs === 'Nombre\nCargo', JSON.stringify(lowerEs));
    if (shotsDir) {
      await sleep(500);
      await window.screenshot({ path: join(shotsDir, 'titles-tab-es.png') });
      await window.locator('section[data-section="titlePosition"]').scrollIntoViewIfNeeded();
      await sleep(300);
      await window.screenshot({ path: join(shotsDir, 'titles-position-es.png') });
    }

    console.log('9. nothing left the computer');
    const remote = requests.filter((url) => /^(https?|wss?|ftp):/i.test(url));
    const fonts = requests.filter((url) => /\.(woff2|ttf|otf)(\?|$)/i.test(url));
    check('no request went to the network', remote.length === 0, remote.slice(0, 3).join(' | '));
    check('the fonts were read from the app\'s own files', fonts.length > 0 && fonts.every((url) => url.startsWith('file:')), fonts.map((url) => url.split('/').pop()).join(', '));

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
