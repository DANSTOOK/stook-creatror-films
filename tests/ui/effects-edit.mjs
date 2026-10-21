import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Seeing and changing what is on a clip, in the running app:
 * `node tests/ui/effects-edit.mjs`
 *
 *   1. A zoom put on from the library brings the inspector to the clip's
 *      Effects tab, which names it in its summary and shows its card.
 *   2. "Pick the zone in the viewer" draws the zone over the picture, which
 *      is drawn unzoomed meanwhile; dragging the zone with the mouse aims the
 *      zoom there, and dragging a corner zooms closer - one undo step a drag.
 *      Escape puts the zone away.
 *   3. An In animation chosen on its card, and its length changed there,
 *      are what the clip then does; removing the move takes it off alone.
 *
 * Needs a build (npm run build). The window is never shown. Screenshots go
 * to EFFECTS_EDIT_SHOTS when it is set.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'effects-edit');
const shotsDir = process.env.EFFECTS_EDIT_SHOTS ?? '';
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
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const video = join(work, 'pattern.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  const shot = async (window, name) => {
    if (shotsDir) await window.screenshot({ path: join(shotsDir, name) }).catch(() => undefined);
  };
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await window.evaluate(() => window.__scfStore.getState().setProjectSettings({ width: 1920, height: 1080, fps: 30 }));
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    const clipId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const track = s.project.tracks.find((t) => t.type === 'video');
      const id = s.addAssetToTimeline(s.assets[0], track.id, 0);
      s.selectClips([]);
      s.setCurrentFrame(140);
      return id;
    });
    await sleep(800);
    const fxOf = () => window.evaluate((id) => window.__scfStore.getState().project.clips[id].fx ?? null, clipId);
    const undoDepth = () => window.evaluate(() => window.__scfHistory.getState().undoStack.length);

    console.log('1. a zoom put on from the library');
    await window.getByTestId('library-tab-effects').click();
    await window.getByTestId('library-motion-zoomIn').click();
    await sleep(400);
    const tab = (await window.evaluate(() => document.getElementById('inspector-tabpanel')?.dataset.tab)) === 'fx' ? 1 : 0;
    const summary = (await window.getByTestId('clip-fx-summary').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const preset = await window.getByTestId('clip-fx-motion-preset').inputValue().catch(() => '');
    check('the inspector comes to the Effects tab, naming the zoom in its summary and in its card', tab === 1 && /On this clip \(1\)/.test(summary) && /Zoom in/.test(summary) && preset === 'zoomIn', `${summary} | ${preset}`);
    await shot(window, 'fx-tab.png');

    console.log('2. picking the zone');
    await window.getByTestId('clip-fx-pick-zone').click();
    await sleep(400);
    const zoneShown = await window.getByTestId('zoom-zone-frame').isVisible().catch(() => false);
    const atRest = await window.evaluate(() => {
      // What the viewer is given to draw: the clip at rest while it is aimed.
      const s = window.__scfStore.getState();
      return Object.values(s.project.clips)[0].transform.scale.length > 0;
    });
    check('the zone is drawn over the picture', zoneShown && atRest);
    const frameBox = await window.getByTestId('zoom-zone-frame').boundingBox();
    const viewBox = await window.getByTestId('zoom-zone').boundingBox();
    const depth0 = await undoDepth();
    // Drag the zone to the top-left of the picture.
    await window.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await window.mouse.down();
    for (let i = 1; i <= 8; i += 1) await window.mouse.move(frameBox.x + frameBox.width / 2 - (viewBox.width * 0.4 * i) / 8, frameBox.y + frameBox.height / 2 - (viewBox.height * 0.4 * i) / 8);
    await window.mouse.up();
    await sleep(300);
    const moved = await fxOf();
    const depth1 = await undoDepth();
    check('dragging the zone aims the zoom there - the top left - as one undo step',
      moved?.motion?.focus.x < 0.2 && moved?.motion?.focus.y < 0.2 && depth1 === depth0 + 1, `focus ${JSON.stringify(moved?.motion?.focus)}, undo ${depth0} -> ${depth1}`);
    // Pull the bottom-right corner in: a smaller zone, a closer zoom.
    const corner = await window.getByTestId('zoom-zone-se').boundingBox();
    const amountBefore = moved?.motion?.amount;
    await window.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await window.mouse.down();
    for (let i = 1; i <= 6; i += 1) await window.mouse.move(corner.x + corner.width / 2 - (viewBox.width * 0.15 * i) / 6, corner.y + corner.height / 2 - (viewBox.height * 0.15 * i) / 6);
    await window.mouse.up();
    await sleep(300);
    const closer = await fxOf();
    const zoomText = (await window.getByTestId('zoom-zone-frame').innerText()).trim();
    check('dragging a corner in zooms closer, and the zone says how close', closer?.motion?.amount > amountBefore + 0.5 && /\d+ %/.test(zoomText), `amount ${amountBefore?.toFixed(2)} -> ${closer?.motion?.amount?.toFixed(2)}, "${zoomText}"`);
    await shot(window, 'zone.png');
    const aimed = await window.evaluate((id) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const last = (track) => track[track.length - 1]?.value;
      return { position: last(clip.transform.position), scale: last(clip.transform.scale) };
    }, clipId);
    check('at its closest the picture is moved so the top left fills the frame', aimed.position?.x > 0 && aimed.position?.y > 0 && aimed.scale?.x > 1.5, JSON.stringify(aimed));
    await window.keyboard.press('Escape');
    await sleep(300);
    const stillSelected = await window.evaluate((id) => window.__scfStore.getState().ui.selectedClipIds.includes(id), clipId);
    check('Escape puts the zone away, and the clip stays selected', (await window.getByTestId('zoom-zone').count()) === 0 && stillSelected);

    console.log('3. animations on their cards');
    await window.getByTestId('clip-fx-in-choice').selectOption('popIn');
    await sleep(300);
    const withIn = await fxOf();
    const slider = window.getByTestId('clip-fx-in').locator('input[type="range"]');
    await slider.fill('1.5');
    await sleep(300);
    const longer = await fxOf();
    const opacityAt = (frame) => window.evaluate(([id, f]) => {
      const clip = window.__scfStore.getState().project.clips[id];
      const track = clip.transform.scale;
      const before = track.filter((kf) => kf.frame <= f).pop();
      return before ? before.value.x : null;
    }, [clipId, frame]);
    const scaleAt30 = await opacityAt(30);
    check('an In chosen on its card goes on, and its length changes there', withIn?.in?.id === 'popIn' && longer?.in?.seconds === 1.5 && scaleAt30 !== null && scaleAt30 < 2.4,
      `${JSON.stringify(withIn?.in)} -> ${JSON.stringify(longer?.in)}`);
    await window.getByTestId('clip-fx-motion-remove').click();
    await sleep(300);
    const after = await fxOf();
    const summaryAfter = (await window.getByTestId('clip-fx-summary').innerText()).replace(/\s+/g, ' ');
    check('removing the move takes it off alone; the summary follows', !after?.motion && after?.in?.id === 'popIn' && /\(1\)/.test(summaryAfter) && /Pop in/.test(summaryAfter), summaryAfter);
    await shot(window, 'fx-tab-after.png');

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
