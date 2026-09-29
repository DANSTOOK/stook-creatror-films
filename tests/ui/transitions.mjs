import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Transitions, phase 3, in the running app: `npm run test:transitions:ui`
 *
 *   1. pixels: a red-to-blue cross dissolve is the 50/50 mix of its two
 *      sides on the cut frame; a dip to black is black there;
 *   2. with footage beyond the cut, Ctrl+T adds a centred one-second
 *      dissolve with no question, and a real export keeps its length;
 *   3. without it, the question every time: Cancel adds nothing, Freeze
 *      frames moves nothing (one undo step), Overlap makes the export exactly
 *      30 frames shorter (one undo step), and the dialog names the music a
 *      track below that would be left out of step;
 *   4. the timeline: a click picks the box, dragging its edge changes its
 *      length both ways, Delete removes it, a double-click opens it in the
 *      inspector, which says which clip runs out; the menu on a cut adds a
 *      dip to black;
 *   5. one file on both sides, played: both pictures move;
 *   6. playback cadence through a dissolve of two videos against one;
 *   7. the question in Spanish.
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots go to TRANSITIONS_SHOTS.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'transitions');
const shotsDir = process.env.TRANSITIONS_SHOTS ?? '';
const W = 640;
const H = 360;
const FPS = 30;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Frames in a video file, counted by decoding it. */
async function frameCount(file) {
  const { stderr } = await execFileAsync(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 });
  const counts = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  return counts.length ? Number(counts[counts.length - 1][1]) : -1;
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const red = join(workDir, 'red.png');
  const blue = join(workDir, 'blue.png');
  const redBlue = join(workDir, 'red-then-blue.mp4');
  const music = join(workDir, 'music.wav');
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xff0000:s=${W}x${H}`, '-frames:v', '1', red]);
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x0000ff:s=${W}x${H}`, '-frames:v', '1', blue]);
  // 5 s of red, then 5 s of blue: two parts of one file look different.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=${FPS}:d=5`, '-f', 'lavfi', '-i', `color=c=blue:s=${W}x${H}:r=${FPS}:d=5`,
    '-filter_complex', '[0][1]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', redBlue]);
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', music]);
  const exportDir = join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });

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

    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, [red, blue, redBlue, music]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 4, null, { timeout: 60_000 });
    await window.evaluate(([w, h, fps]) => window.__scfStore.getState().setProjectSettings({ width: w, height: h, fps }), [W, H, FPS]);

    const store = (fn, arg) => window.evaluate(fn, arg);
    /** Two clips of the named media back to back on Video 1: [name, offset, length] each. */
    const layOut = (parts) => store((pieces) => {
      const s = window.__scfStore.getState();
      s.removeClips(Object.keys(s.project.clips));
      const track = s.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      let at = 0;
      const ids = [];
      for (const [name, offset, length] of pieces) {
        const asset = window.__scfStore.getState().assets.find((candidate) => candidate.name === name);
        const id = window.__scfStore.getState().addAssetToTimeline(asset, track.id, at);
        window.__scfStore.getState().updateClip(id, { sourceOffsetFrames: offset, durationFrames: length });
        ids.push(id);
        at += length;
      }
      window.__scfStore.getState().selectClips([]);
      return ids;
    }, parts);
    const exact = (frame) => store(async (at) => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, at, false);
        const i = (Math.floor(project.height / 2) * project.width + Math.floor(project.width / 2)) * 4;
        return [...rgba.subarray(i, i + 3)];
      } finally {
        renderer.endExclusive();
      }
    }, frame);
    const transitions = () => store(() => Object.values(window.__scfStore.getState().project.transitions ?? {}));
    const depth = () => store(() => window.__scfHistory.getState().undoStack.length);
    const contentEnd = () => store(() => Math.max(0, ...Object.values(window.__scfStore.getState().project.clips).filter((clip) => clip.trackId === window.__scfStore.getState().project.tracks.find((t) => t.type === 'video' && t.order === 0).id).map((clip) => clip.startFrame + clip.durationFrames)));

    console.log('1. pixels on the cut');
    await layOut([['red.png', 0, 60], ['blue.png', 0, 60]]);
    await store(() => window.__scfStore.getState().setCurrentFrame(58));
    await window.keyboard.press('Control+t');
    await sleep(300);
    const dissolve = (await transitions())[0];
    check('Ctrl+T on stills (which never run out) adds a centred one-second cross dissolve, no question asked',
      dissolve?.kind === 'crossDissolve' && dissolve.durationFrames === 30 && dissolve.alignment === 'center'
        && !(await window.getByTestId('transition-dialog').isVisible().catch(() => false)),
      JSON.stringify(dissolve));
    const redSide = await exact(40);
    const blueSide = await exact(80);
    const cut = await exact(60);
    const expected = redSide.map((value, index) => (value + blueSide[index]) / 2);
    check('on the cut frame the dissolve is the exact 50/50 mix of its two sides (within half a level)',
      cut.every((value, index) => Math.abs(value - expected[index]) <= 0.5),
      `red side ${redSide.join(',')}, blue side ${blueSide.join(',')}, cut ${cut.join(',')}`);
    const quarter = await exact(52);
    check('and a quarter of the way in, a quarter of the way over', Math.abs(quarter[2] - blueSide[2] * (7 / 30)) <= 1.5,
      `${quarter.join(',')} at frame 52 (7 of 30)`);
    await store((id) => window.__scfStore.getState().updateTransition(id, { kind: 'dip', color: '#000000' }), dissolve.id);
    const dip = await exact(60);
    check('a dip to black is black on its centre frame', dip.join(',') === '0,0,0', dip.join(','));
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'transition-on-timeline-en.png') });

    console.log('2. with footage beyond the cut');
    // Red from its middle, blue from its middle: 45 frames of footage each side.
    const exportFrames = async (name) => {
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, exportDir);
      await store(() => window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', exportAlpha: false }));
      await window.getByRole('button', { name: 'Export' }).click();
      const dialog = window.getByRole('dialog', { name: 'Export' });
      await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Whole timeline' }).click();
      await dialog.getByLabel('File name').fill(name);
      await dialog.getByRole('button', { name: 'Browse' }).click();
      await sleep(400);
      await dialog.getByRole('button', { name: 'Start export' }).click();
      await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 180_000 });
      await dialog.getByTitle('Close').click();
      await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
      const files = (await readdir(exportDir)).filter((file) => file.startsWith(name));
      return files.length ? frameCount(join(exportDir, files[0])) : -1;
    };
    await layOut([['red-then-blue.mp4', 45, 90], ['red-then-blue.mp4', 195, 90]]);
    const withoutTransition = await exportFrames('handles-before');
    await store(() => { window.__scfStore.getState().setCurrentFrame(90); window.__scfStore.getState().selectClips([]); });
    let before = await depth();
    await window.keyboard.press('Control+d');
    await sleep(300);
    const withHandles = (await transitions())[0];
    check('Ctrl+D (Premiere\'s key) with footage on both sides: a centred dissolve, no question, one undo step',
      withHandles?.alignment === 'center' && (await depth()) === before + 1 && !(await window.getByTestId('transition-dialog').isVisible().catch(() => false)));
    const withTransition = await exportFrames('handles-after');
    check('and the export is exactly as long as without it', withoutTransition > 0 && withTransition === withoutTransition,
      `${withoutTransition} frames without, ${withTransition} with`);

    console.log('3. without footage beyond the cut: the question');
    // Whole halves: the red ends where the file's red ends... the clips are the whole file, twice.
    const ids = await layOut([['red-then-blue.mp4', 0, 300], ['red-then-blue.mp4', 0, 300]]);
    // Music on the audio track after the cut, not linked to anything: it would be left behind.
    await store(() => {
      const s = window.__scfStore.getState();
      const audio = s.project.tracks.find((candidate) => candidate.type === 'audio');
      const asset = s.assets.find((candidate) => candidate.name === 'music.wav');
      window.__scfStore.getState().addAssetToTimeline(asset, audio.id, 310);
      window.__scfStore.getState().selectClips([]);
    });
    const beforeOverlap = await exportFrames('overlap-before');
    await store(() => window.__scfStore.getState().setCurrentFrame(300));
    await window.keyboard.press('Control+t');
    const ask = window.getByTestId('transition-dialog');
    const asked = await ask.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    const askText = asked ? await ask.innerText() : '';
    check('whole clips have no footage beyond the cut: the editor is asked', asked && /Not enough footage/.test(askText) && /15 frames/.test(askText), askText.slice(0, 120));
    check('the question says the music on another track would be left out of step', /music\.wav/.test(await window.getByTestId('transition-left-behind').innerText().catch(() => '')));
    if (shotsDir) { await sleep(500); await window.screenshot({ path: join(shotsDir, 'transition-ask-en.png') }); }
    before = await depth();
    await window.getByTestId('transition-cancel').click();
    await sleep(200);
    check('Cancel adds nothing and leaves no undo step', (await transitions()).length === 0 && (await depth()) === before);

    await window.keyboard.press('Control+t');
    await ask.waitFor({ state: 'visible', timeout: 5_000 });
    const endBefore = await contentEnd();
    await window.getByTestId('transition-freeze').click();
    await sleep(300);
    const frozen = await transitions();
    check('Freeze frames: the transition is in, nothing moved, one undo step',
      frozen.length === 1 && (await contentEnd()) === endBefore && (await depth()) === before + 1, `${endBefore} -> ${await contentEnd()}`);
    await store(() => window.__scfStore.getState().undo());
    check('undone in one step', (await transitions()).length === 0);

    await window.keyboard.press('Control+t');
    await ask.waitFor({ state: 'visible', timeout: 5_000 });
    before = await depth();
    await window.getByTestId('transition-overlap').click();
    await sleep(300);
    const overlapped = await store((clipIds) => clipIds.map((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      return [clip.startFrame, clip.durationFrames, clip.sourceOffsetFrames];
    }), ids);
    check('Overlap: 15 frames off each clip and the second moved up to meet the first, one undo step',
      JSON.stringify(overlapped) === JSON.stringify([[0, 285, 0], [285, 285, 15]]) && (await depth()) === before + 1, JSON.stringify(overlapped));
    const afterOverlap = await exportFrames('overlap-after');
    check('and the export is exactly 30 frames shorter', beforeOverlap > 0 && afterOverlap === beforeOverlap - 30, `${beforeOverlap} -> ${afterOverlap} frames`);

    console.log('4. on the timeline');
    // Back to the frozen version: its inspector says which clip runs out.
    await store(() => window.__scfStore.getState().undo());
    await store(() => { window.__scfStore.getState().setUi({ pixelsPerFrame: 2, scrollLeftPx: 0 }); window.__scfStore.getState().setCurrentFrame(0); });
    await store(() => window.__scfStore.getState().setCurrentFrame(300));
    await window.keyboard.press('Control+t');
    await ask.waitFor({ state: 'visible', timeout: 5_000 });
    await window.getByTestId('transition-freeze').click();
    await store(() => { window.__scfStore.getState().selectClips([]); window.__scfStore.getState().selectTransition(null); });
    await sleep(400);
    const surface = window.locator('canvas').last();
    const canvas = await surface.boundingBox();
    const rowOfV1 = await store(() => {
      const { tracks } = window.__scfStore.getState().project;
      const visual = tracks.filter((t) => t.type !== 'audio').sort((a, b) => b.order - a.order);
      return visual.findIndex((t) => t.order === 0);
    });
    const boxY = canvas.y + 24 + rowOfV1 * 58 + 56 * 0.6;
    const cutX = canvas.x + 300 * 2;
    await window.mouse.click(cutX, boxY);
    await sleep(200);
    const picked = await store(() => window.__scfStore.getState().ui.selectedTransitionId);
    const panel = window.getByTestId('transition-panel');
    check('a click on the box picks the transition, and the inspector shows it', Boolean(picked) && await panel.isVisible());
    check('the inspector says which clip runs out, and by how much', await window.getByTestId('transition-runs-out-tail').isVisible()
      && /15 frames/.test(await window.getByTestId('transition-runs-out-tail').innerText()));
    // Drag the right edge 10 px (5 frames) out: a centred transition grows 5 each way.
    depth0: {
      const start = await depth();
      await window.mouse.move(cutX + 30, boxY);
      await window.mouse.down();
      await window.mouse.move(cutX + 40, boxY, { steps: 6 });
      await window.mouse.up();
      await sleep(200);
      const dragged = (await transitions())[0];
      check('dragging its edge 5 frames out makes it 10 frames longer - both sides - as one undo step', dragged.durationFrames === 40 && (await depth()) === start + 1,
        `${dragged.durationFrames} frames`);
    }
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'transition-inspector-en.png') });
    await store(() => window.__scfStore.getState().selectTransition(null));
    await sleep(200);
    const hiddenBefore = !(await panel.isVisible().catch(() => false));
    await window.mouse.dblclick(cutX, boxY);
    await sleep(300);
    check('a double-click opens it in the inspector', hiddenBefore && await panel.isVisible());
    await surface.focus().catch(() => undefined);
    await window.mouse.click(cutX, boxY);
    await window.keyboard.press('Delete');
    await sleep(200);
    const afterDelete = await store(() => ({ t: Object.keys(window.__scfStore.getState().project.transitions ?? {}).length, clips: Object.keys(window.__scfStore.getState().project.clips).length }));
    check('Delete removes the transition and keeps the clips', afterDelete.t === 0 && afterDelete.clips === 3, JSON.stringify(afterDelete));
    // The menu on the cut.
    await window.mouse.click(cutX + 3, canvas.y + 24 + rowOfV1 * 58 + 12, { button: 'right' });
    await window.getByRole('menuitem', { name: 'Add transition' }).click();
    await window.getByRole('menuitem', { name: 'Dip to black' }).click();
    await ask.waitFor({ state: 'visible', timeout: 5_000 });
    await window.getByTestId('transition-freeze').click();
    await sleep(200);
    const fromMenu = (await transitions())[0];
    check('the menu on a cut adds a dip to black', fromMenu?.kind === 'dip' && fromMenu.color === '#000000');

    console.log('5. one file on both sides, played');
    await layOut([['red-then-blue.mp4', 0, 45], ['red-then-blue.mp4', 195, 45]]);
    await store(() => { window.__scfStore.getState().setCurrentFrame(45); window.__scfStore.getState().selectClips([]); });
    await window.keyboard.press('Control+t');
    await sleep(200);
    await store(() => {
      const id = Object.keys(window.__scfStore.getState().project.transitions)[0];
      window.__scfStore.getState().updateTransition(id, { durationFrames: 40 });
    });
    const played = await store(async () => {
      const renderer = window.__scfRenderer();
      window.__scfStore.getState().setCurrentFrame(5);
      await new Promise((done) => setTimeout(done, 800));
      const samples = [];
      window.__scfStore.getState().setPlaying(true);
      const began = performance.now();
      while (performance.now() - began < 2500) {
        await new Promise((done) => requestAnimationFrame(done));
        const { project } = window.__scfStore.getState();
        const rgba = renderer.compositor.readPixels(false);
        const i = (Math.floor(project.height / 2) * project.width + Math.floor(project.width / 2)) * 4;
        samples.push([project.currentFrame, rgba[i], rgba[i + 2]]);
      }
      window.__scfStore.getState().setPlaying(false);
      return samples;
    });
    const atCut = played.filter(([frame]) => frame >= 42 && frame <= 48);
    const mixed = atCut.filter(([, r, b]) => r > 80 && b > 80);
    check('played through, both sides show their own picture: red and blue mixed around the cut',
      atCut.length > 0 && mixed.length === atCut.length, atCut.map(([f, r, b]) => `${f}:${r}/${b}`).join(' '));

    console.log('6. playback cadence');
    const cadence = async () => store(async () => {
      const gaps = [];
      let last = 0;
      let sampling = true;
      const tick = (time) => {
        if (last) gaps.push(time - last);
        last = time;
        if (sampling) requestAnimationFrame(tick);
      };
      window.__scfStore.getState().setCurrentFrame(0);
      await new Promise((done) => setTimeout(done, 600));
      requestAnimationFrame(tick);
      window.__scfStore.getState().setPlaying(true);
      await new Promise((done) => setTimeout(done, 3000));
      window.__scfStore.getState().setPlaying(false);
      sampling = false;
      const q = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
      const refresh = q(gaps, 50);
      const dropped = gaps.reduce((sum, gap) => sum + (gap > refresh * 1.5 ? Math.round(gap / refresh) - 1 : 0), 0);
      // At 30 fps a picture is missed only by a gap longer than a video frame.
      const missed = gaps.filter((gap) => gap > 1000 / 30).length;
      return { frames: gaps.length, p95: q(gaps, 95), dropped, missed, worst: Math.max(...gaps) };
    });
    await layOut([['red-then-blue.mp4', 0, 150]]);
    const one = await cadence();
    // Two videos decoding for two seconds: a 60-frame dissolve at 1 s.
    await layOut([['red-then-blue.mp4', 0, 60], ['red-then-blue.mp4', 60, 90]]);
    await store(() => { window.__scfStore.getState().setCurrentFrame(60); window.__scfStore.getState().selectClips([]); });
    await window.keyboard.press('Control+t');
    await ask.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    if (await ask.isVisible()) await window.getByTestId('transition-freeze').click();
    await store(() => {
      const id = Object.keys(window.__scfStore.getState().project.transitions)[0];
      window.__scfStore.getState().updateTransition(id, { durationFrames: 60 });
    });
    const two = await cadence();
    check('playing through a dissolve of two videos keeps the cadence of one video: no video frame missed, p95 within 1 ms',
      two.missed <= one.missed && two.p95 <= one.p95 + 1,
      `one video: ${one.frames} display frames, p95 ${one.p95.toFixed(1)} ms, worst ${one.worst.toFixed(1)} ms, ${one.dropped} display frames late, ${one.missed} video frames missed; through the dissolve: ${two.frames}, p95 ${two.p95.toFixed(1)} ms, worst ${two.worst.toFixed(1)} ms, ${two.dropped} late, ${two.missed} missed`);

    console.log('7. in Spanish');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(300);
    await layOut([['red-then-blue.mp4', 0, 300], ['red-then-blue.mp4', 0, 300]]);
    await store(() => window.__scfStore.getState().setCurrentFrame(300));
    await window.keyboard.press('Control+t');
    await ask.waitFor({ state: 'visible', timeout: 5_000 });
    const es = {
      title: await ask.getByRole('heading').first().innerText().catch(() => ''),
      overlap: await window.getByTestId('transition-overlap').innerText(),
      freeze: await window.getByTestId('transition-freeze').innerText(),
      cancel: await window.getByTestId('transition-cancel').innerText(),
    };
    check('la pregunta en español: Solapar (recortar los clips), Congelar fotogramas, Cancelar',
      /No hay metraje suficiente/.test(es.title) && es.overlap.trim() === 'Solapar (recortar los clips)' && es.freeze.trim() === 'Congelar fotogramas' && es.cancel.trim() === 'Cancelar',
      JSON.stringify(es));
    if (shotsDir) { await sleep(500); await window.screenshot({ path: join(shotsDir, 'transition-ask-es.png') }); }
    await window.getByTestId('transition-overlap').click();
    await sleep(200);
    check('Solapar hace lo mismo en español', (await transitions()).length === 1);
    await store(() => window.__scfStore.getState().selectTransition(Object.keys(window.__scfStore.getState().project.transitions)[0]));
    await sleep(200);
    if (shotsDir) await window.screenshot({ path: join(shotsDir, 'transition-inspector-es.png') });

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
