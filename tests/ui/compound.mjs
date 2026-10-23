import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Compound clips, in the running app: `node tests/ui/compound.mjs`
 *
 * Four seconds of red with a 440 Hz tone, and a green square over it from 1 s
 * to 3 s, on the track above:
 *   1. with both selected, the timeline's menu offers "Make compound clip";
 *   2. it renders them into one clip, over their span, on the lower track -
 *      the other clips gone, kept inside it - as one undo step; the file is a
 *      WebM with transparency and the tone;
 *   3. the export's own picture of it is what the two clips drew: red, and the
 *      green square while it lasted;
 *   4. moved by a second, its menu offers "Break apart compound clip": the two
 *      come back as they were, a second later; undo puts the compound back.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'compound');
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
  const red = join(work, 'red.mp4');
  const green = join(work, 'green.png');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xd02020:s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red]);
  // Tagged Rec.709, as the app's own exports are: untagged, the viewer and the export decode it differently.
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x20c040:s=80x80', '-frames:v', '1', green]);

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
    window.on('console', (message) => { if (message.type() === 'error') issues.push(`console ${message.text()}`); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [red, green]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 320, height: 180, fps: 30 });
      const [lower, upper] = s.project.tracks.filter((t) => t.type === 'video').sort((a, b) => a.order - b.order);
      const video = s.assets.find((a) => a.name.startsWith('red'));
      const still = s.assets.find((a) => a.name.startsWith('green'));
      window.__scfStore.getState().addAssetToTimeline(video, lower.id, 0);
      window.__scfStore.getState().addAssetToTimeline(still, upper.id, 30);
      const clips = Object.values(window.__scfStore.getState().project.clips);
      const square = clips.find((c) => c.trackId === upper.id);
      window.__scfStore.getState().updateClip(square.id, { durationFrames: 60 });
      const picture = clips.find((c) => c.trackId === lower.id);
      window.__scfStore.getState().setUi({ selectedClipIds: clips.map((c) => c.id) });
      window.__scfStore.getState().setCurrentFrame(0);
      return { picture: picture.id, square: square.id, all: clips.map((c) => c.id), lower: lower.id };
    });
    await sleep(500);
    const before = await window.evaluate(() => JSON.stringify(Object.values(window.__scfStore.getState().project.clips).map((c) => ({ id: c.id, start: c.startFrame, length: c.durationFrames, track: c.trackId })).sort((a, b) => a.id.localeCompare(b.id))));

    const sample = (frames) =>
      window.evaluate(async (list) => {
        const renderer = window.__scfRenderer();
        const { project } = window.__scfStore.getState();
        renderer.beginExclusive();
        try {
          const out = {};
          for (const frame of list) {
            const rgba = await renderer.renderExact(project, frame, true);
            const at = (x, y) => [...rgba.slice((y * project.width + x) * 4, (y * project.width + x) * 4 + 3)];
            out[frame] = { middle: at(160, 90), corner: at(20, 20) };
          }
          return out;
        } finally {
          renderer.endExclusive();
        }
      }, frames);
    const original = await sample([10, 60, 100]);

    const rightClick = async (clipId, frame) => {
      const canvas = await window.locator('[data-panel="timeline"] canvas').first().boundingBox();
      const rowY = await window.evaluate((id) => {
        const s = window.__scfStore.getState();
        const rows = [...document.querySelectorAll('[data-panel="timeline"] .group.relative.flex')];
        const track = s.project.tracks.find((t) => t.id === s.project.clips[id].trackId);
        const index = rows.findIndex((row) => (row.textContent ?? '').includes(track.name));
        const box = rows[index].getBoundingClientRect();
        return box.top + box.height / 2;
      }, clipId);
      const x = await window.evaluate((at) => at * window.__scfStore.getState().ui.pixelsPerFrame - window.__scfStore.getState().ui.scrollLeftPx, frame);
      await window.mouse.click(canvas.x + x + 4, rowY, { button: 'right' });
    };

    console.log('1. the menu');
    await rightClick(ids.picture, 10);
    const make = window.getByRole('menuitem', { name: /Make compound clip/ });
    const offered = await make.isVisible().catch(() => false);
    check('with both selected, the clip’s menu offers "Make compound clip"', offered);

    console.log('2. making it');
    const steps = await window.evaluate(() => window.__scfHistory?.getState?.().undoStack.length ?? null);
    await make.click();
    const made = await window.waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).some((c) => c.compound), null, { timeout: 120_000 }).then(() => true).catch(() => false);
    await sleep(800);
    const result = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clips = Object.values(s.project.clips);
      const compound = clips.find((c) => c.compound);
      const asset = s.assets.find((a) => a.uri === compound?.sourceUri);
      return {
        count: clips.length,
        start: compound?.startFrame,
        length: compound?.durationFrames,
        track: compound?.trackId,
        inside: compound?.compound.clips.map((c) => c.id).sort(),
        path: asset?.sourcePath,
        selected: s.ui.selectedClipIds[0] === compound?.id,
        id: compound?.id,
        steps: window.__scfHistory?.getState?.().undoStack.length ?? null,
      };
    });
    check('it becomes one clip over their span on the lower track, keeping them, selected',
      made && result.count === 1 && result.start === 0 && result.length === 120 && result.track === ids.lower && JSON.stringify(result.inside) === JSON.stringify([...ids.all].sort()) && result.selected,
      JSON.stringify({ ...result, path: undefined }));
    check('as one undo step', steps === null || result.steps === steps + 1, `${steps} → ${result.steps}`);
    const info = result.path ? spawnSync(ffmpeg, ['-hide_banner', '-c:v', 'libvpx-vp9', '-i', result.path], { encoding: 'utf8' }).stderr : '';
    check('the file is a WebM with transparency and the sound', /Video: vp9/.test(info) && /alpha_mode\s*:\s*1/i.test(info) && /Audio: opus|Audio: vorbis/.test(info),
      (info.match(/Stream[^\n]*|alpha_mode[^\n]*/g) ?? []).join(' | '));
    const volume = result.path ? spawnSync(ffmpeg, ['-hide_banner', '-i', result.path, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1] : null;
    check('with the tone in it', volume !== null && Number(volume) > -40, `mean ${volume} dB`);

    console.log('3. the picture');
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(1));
    await sleep(500);
    const compoundLook = await sample([10, 60, 100]);
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 14);
    const same = [10, 60, 100].every((f) => near(compoundLook[f].middle, original[f].middle) && near(compoundLook[f].corner, original[f].corner));
    check('it draws what the two clips drew: red, and the green square while it lasted', same && compoundLook[60].middle[1] > 150 && compoundLook[10].middle[0] > 150,
      JSON.stringify({ original, compound: compoundLook }));

    console.log('4. breaking it apart');
    await window.evaluate((id) => window.__scfStore.getState().updateClip(id, { startFrame: 30 }), result.id);
    await sleep(300);
    await rightClick(result.id, 50);
    const apart = window.getByRole('menuitem', { name: /Break apart compound clip/ });
    const offeredApart = await apart.isVisible().catch(() => false);
    if (offeredApart) await apart.click();
    await sleep(400);
    const after = await window.evaluate(() => JSON.stringify(Object.values(window.__scfStore.getState().project.clips).map((c) => ({ id: c.id, start: c.startFrame, length: c.durationFrames, track: c.trackId })).sort((a, b) => a.id.localeCompare(b.id))));
    const expected = JSON.stringify(JSON.parse(before).map((c) => ({ ...c, start: c.start + 30 })));
    check('moved a second later, "Break apart" brings the two back as they were, a second later', offeredApart && after === expected, after);
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const back = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).filter((c) => c.compound).length);
    check('undo puts the compound clip back', back === 1, `${back}`);

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
