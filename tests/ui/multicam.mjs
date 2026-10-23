import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Multicam, in the running app: `node tests/ui/multicam.mjs`
 *
 * One scene - claps and voices at uneven moments - filmed by two cameras:
 * a red one from the start, and a blue one that started 2.5 s later, further
 * away (quieter, with noise of its own). Both are dropped at 0 on the
 * timeline, so as placed they are 2.5 s out:
 *   1. with both selected, the timeline's menu offers "Make multicam clip";
 *   2. it lines them up by their sound - the blue 75 frames behind - as one
 *      clip in the red one's place, its sound on a clip of its own, the blue
 *      clip off the timeline; one undo step;
 *   3. under the viewer its angles are offered; at 5 s, pressing 2 cuts to the
 *      blue camera from that same moment, the sound running on uncut; clicking
 *      angle 1 at 7 s cuts back; the export's own picture is red, then blue,
 *      then red;
 *   4. its menu offers the angle to show; one undo takes one switch back.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'multicam');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const RATE = 48000;

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Fourteen seconds of a room: claps and short voiced bursts at uneven moments, as 16-bit mono WAV. */
function writeScene(path) {
  const samples = new Float32Array(14 * RATE);
  let state = 5;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let at = 0.3; at < 13.5; at += 0.25 + random() * 0.9) {
    const start = Math.round(at * RATE);
    const length = Math.round((0.04 + random() * 0.25) * RATE);
    const pitch = 120 + random() * 500;
    const level = 0.2 + random() * 0.6;
    for (let i = 0; i < length && start + i < samples.length; i += 1) {
      samples[start + i] += level * Math.exp(-i / (0.35 * length)) * Math.sin((2 * Math.PI * pitch * i) / RATE);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const camera = (scene, out, colour, from, gain) =>
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=30:d=10`,
    '-ss', String(from), '-t', '10', '-i', scene,
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.02:d=10:sample_rate=48000',
    '-filter_complex', `[1:a]volume=${gain},lowpass=f=3000[s];[s][2:a]amix=inputs=2:normalize=0[a]`,
    '-map', '0:v', '-map', '[a]',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
  ]);

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const scene = join(work, 'scene.wav');
  writeScene(scene);
  const near = join(work, 'near-red.mp4');
  const far = join(work, 'far-blue.mp4');
  camera(scene, near, '0xd02020', 0, 1);
  camera(scene, far, '0x2040d0', 2.5, 0.4);

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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [near, far]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    const ids = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 320, height: 180, fps: 30 });
      const [lower, upper] = s.project.tracks.filter((t) => t.type === 'video').sort((a, b) => a.order - b.order);
      window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.name.startsWith('near')), lower.id, 0);
      window.__scfStore.getState().addAssetToTimeline(s.assets.find((a) => a.name.startsWith('far')), upper.id, 0);
      const clips = Object.values(window.__scfStore.getState().project.clips);
      window.__scfStore.getState().setUi({ selectedClipIds: clips.map((c) => c.id) });
      window.__scfStore.getState().setCurrentFrame(0);
      return { red: clips.find((c) => c.trackId === lower.id).id, blue: clips.find((c) => c.trackId === upper.id).id };
    });
    await sleep(500);

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
    const colours = (frames) =>
      window.evaluate(async (list) => {
        const renderer = window.__scfRenderer();
        const { project } = window.__scfStore.getState();
        renderer.beginExclusive();
        try {
          const out = [];
          for (const frame of list) {
            const rgba = await renderer.renderExact(project, frame, true);
            const at = (90 * project.width + 160) * 4;
            out.push(rgba[at] > rgba[at + 2] + 60 ? 'red' : rgba[at + 2] > rgba[at] + 60 ? 'blue' : `${rgba[at]},${rgba[at + 1]},${rgba[at + 2]}`);
          }
          return out;
        } finally {
          renderer.endExclusive();
        }
      }, frames);

    console.log('1. the menu');
    await rightClick(ids.red, 30);
    const make = window.getByRole('menuitem', { name: /Make multicam clip/ });
    const offered = await make.isVisible().catch(() => false);
    check('with both selected, the clip’s menu offers "Make multicam clip"', offered);

    console.log('2. making it');
    const steps = await window.evaluate(() => window.__scfHistory?.getState?.().undoStack.length ?? null);
    if (offered) await make.click();
    const made = await window.waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).some((c) => c.multicam), null, { timeout: 60_000 }).then(() => true).catch(() => false);
    await sleep(500);
    const result = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clips = Object.values(s.project.clips);
      const multicam = clips.find((c) => c.multicam);
      const sound = clips.find((c) => c.audioOnly);
      return {
        id: multicam?.id,
        count: clips.length,
        angles: multicam?.multicam.angles.map((a) => ({ name: a.name, sync: a.syncFrames })),
        silent: multicam?.audioDetached === true,
        sound: sound && { start: sound.startFrame, length: sound.durationFrames, uri: sound.sourceUri === multicam?.sourceUri },
        steps: window.__scfHistory?.getState?.().undoStack.length ?? null,
      };
    });
    const lag = result.angles?.[1]?.sync;
    check('the angles are lined up by their sound: the blue camera 75 frames behind', made && Math.abs(lag + 75) <= 1, JSON.stringify(result.angles));
    check('one clip in the red one’s place, its sound on a clip of its own, the blue clip off the timeline',
      result.id === ids.red && result.count === 2 && result.silent && result.sound?.start === 0 && result.sound?.length === 300 && result.sound?.uri, JSON.stringify(result));
    check('as one undo step', steps === null || result.steps === steps + 1, `${steps} → ${result.steps}`);

    console.log('3. cutting between the cameras');
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(150));
    await sleep(300);
    const bar = await window.getByTestId('multicam-angle').count();
    await window.getByTestId('preview-panel').screenshot({ path: join(work, 'angles.png') });
    check('under the viewer, its two angles are offered', bar === 2, `${bar} angles`);
    await window.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await window.keyboard.press('2');
    await sleep(300);
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(210));
    await sleep(300);
    await window.getByTestId('multicam-angle').first().click();
    await sleep(300);
    const pieces = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).filter((c) => c.multicam).sort((a, b) => a.startFrame - b.startFrame).map((c) => ({ start: c.startFrame, length: c.durationFrames, angle: c.multicam.angle, offset: c.sourceOffsetFrames })));
    check('2 at 5 s cuts to the blue camera from that same moment; angle 1 at 7 s cuts back',
      JSON.stringify(pieces) === JSON.stringify([{ start: 0, length: 150, angle: 0, offset: 0 }, { start: 150, length: 60, angle: 1, offset: 150 + lag }, { start: 210, length: 90, angle: 0, offset: 210 }]),
      JSON.stringify(pieces));
    const sounds = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).filter((c) => c.audioOnly).map((c) => [c.startFrame, c.durationFrames]));
    check('the sound runs on uncut', JSON.stringify(sounds) === '[[0,300]]', JSON.stringify(sounds));
    const seen = await colours([100, 170, 240]);
    check('the export’s picture: red, then blue, then red', JSON.stringify(seen) === '["red","blue","red"]', JSON.stringify(seen));

    console.log('4. its menu, and undo');
    const second = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).find((c) => c.multicam && c.startFrame === 150)?.id);
    await rightClick(second, 170);
    const angleMenu = window.getByRole('menuitem', { name: /^Angle/ });
    const hasAngleMenu = await angleMenu.isVisible().catch(() => false);
    check('its menu offers the angle to show', hasAngleMenu);
    await window.keyboard.press('Escape');
    await window.evaluate(() => window.__scfStore.getState().undo());
    await sleep(300);
    const undone = await window.evaluate(() => Object.values(window.__scfStore.getState().project.clips).filter((c) => c.multicam).length);
    const after = await colours([240]);
    check('one undo takes one switch back', undone === 2 && after[0] === 'blue', `${undone} pieces; ${after}`);

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
