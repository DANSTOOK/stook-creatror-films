import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Adjustment layer, in the running app: `node tests/ui/adjustment.mjs`
 *
 * Eight seconds of red under an adjustment layer added at the playhead (1 s):
 *   1. "+ Adjust" puts it on a track of its own over everything, five seconds
 *      long, selected, as one undo step - and the inspector offers its Color tab;
 *   2. its saturation taken to nothing turns the red grey in the export's own
 *      picture while it lasts - and only then: red before it and after it;
 *   3. at 50 % opacity it is half way: a red half as strong;
 *   4. an effect dropped on it (a blur) falls on the picture under it too.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'adjustment');
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
  const video = join(work, 'red.mp4');
  // Red with a sharp white bar down the middle: something for a blur to soften.
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xd02020:s=320x180:r=30:d=8', '-vf', 'drawbox=x=150:y=0:w=20:h=180:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}-${Date.now()}`)}`, join(root, 'dist-electron/main/index.js')],
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
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 320, height: 180, fps: 30 });
      const track = s.project.tracks.find((t) => t.type === 'video');
      window.__scfStore.getState().addAssetToTimeline(s.assets[0], track.id, 0);
      window.__scfStore.getState().setCurrentFrame(30);
    });
    await sleep(400);
    const steps = await window.evaluate(() => window.__scfHistory?.getState?.().undoStack.length ?? null);

    console.log('1. adding it');
    await window.getByTestId('timeline-adjustment').click();
    await sleep(400);
    const added = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips).find((c) => c.adjustment);
      const track = s.project.tracks.find((t) => t.id === clip?.trackId);
      const highest = Math.max(...s.project.tracks.filter((t) => t.type === 'video').map((t) => t.order));
      return { id: clip?.id, start: clip?.startFrame, length: clip?.durationFrames, onTop: track?.order === highest, selected: s.ui.selectedClipIds[0] === clip?.id, track: track?.name };
    });
    const colorTab = await window.locator('[role="tab"]').filter({ hasText: /^Color$/ }).count();
    check('it goes on a track of its own over everything, 5 s from the playhead, selected; its Color tab is there',
      added.id && added.start === 30 && added.length === 150 && added.onTop && added.selected && colorTab > 0, JSON.stringify(added));

    const sample = (frames) =>
      window.evaluate(async (list) => {
        const renderer = window.__scfRenderer();
        const { project } = window.__scfStore.getState();
        renderer.beginExclusive();
        try {
          const out = {};
          for (const frame of list) {
            const rgba = await renderer.renderExact(project, frame, true);
            const at = (x) => [...rgba.slice((90 * project.width + x) * 4, (90 * project.width + x) * 4 + 3)];
            out[frame] = { red: at(60), edge: at(150) };
          }
          return out;
        } finally {
          renderer.endExclusive();
        }
      }, frames);

    console.log('2. grey while it lasts');
    await window.evaluate((id) => {
      const s = window.__scfStore.getState();
      const clip = s.project.clips[id];
      s.updateClip(id, { colorGrading: { ...clip.colorGrading, enabled: true, saturation: 0 } });
    }, added.id);
    const greys = await sample([10, 60, 200]);
    const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
    check('its saturation at nothing turns the red grey in the export while it lasts, and only then',
      chroma(greys[60].red) < 12 && chroma(greys[10].red) > 120 && chroma(greys[200].red) > 120, JSON.stringify({ before: greys[10].red, during: greys[60].red, after: greys[200].red }));

    console.log('3. half way');
    await window.evaluate((id) => {
      const s = window.__scfStore.getState();
      s.updateClip(id, { transform: { ...s.project.clips[id].transform, opacity: [{ id: 'half', frame: 0, value: 0.5, easing: 'linear' }] } });
    }, added.id);
    const half = await sample([60]);
    const ratio = chroma(half[60].red) / chroma(greys[10].red);
    check('at 50 % opacity it is half way: a red about half as strong', ratio > 0.35 && ratio < 0.65, `${half[60].red} (${(ratio * 100).toFixed(0)} % of the red)`);

    console.log('4. an effect on it');
    await window.evaluate((id) => {
      const s = window.__scfStore.getState();
      s.updateClip(id, { transform: { ...s.project.clips[id].transform, opacity: [] }, colorGrading: { ...s.project.clips[id].colorGrading, enabled: false } });
    }, added.id);
    const sharp = await sample([60]);
    // The Gaussian blur, as the Effects panel puts it on.
    await window.evaluate((id) => window.__scfStore.getState().updateClip(id, { effects: [{ id: 'fx-blur', type: 'gaussianBlur', enabled: true, params: { radius: 20 } }] }), added.id);
    const effects = await window.evaluate((id) => (window.__scfStore.getState().project.clips[id].effects ?? []).map((e) => e.type), added.id);
    const soft = await sample([60]);
    // Beside the white bar: sharp, it is red; blurred, the white has spread into it.
    const spread = (px) => px[1];
    check('an effect on it (a blur) falls on the picture under it', effects.includes('gaussianBlur') && spread(soft[60].edge) !== undefined && Math.abs(spread(soft[60].edge) - spread(sharp[60].edge)) > 0 && JSON.stringify(soft[60]) !== JSON.stringify(sharp[60]),
      JSON.stringify({ effects, sharp: sharp[60].edge, soft: soft[60].edge }));

    console.log('5. undo');
    for (let i = 0; i < 6; i += 1) await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const gone = await window.evaluate(() => ({ clips: Object.values(window.__scfStore.getState().project.clips).filter((c) => c.adjustment).length }));
    check('undo takes it away whole', gone.clips === 0, JSON.stringify({ gone, steps }));

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
