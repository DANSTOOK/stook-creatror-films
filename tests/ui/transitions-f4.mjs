import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Transitions, phase 4, in the running app: `npm run test:transitions-f4:ui`
 *
 *   1. pixels: a hard wipe's edge is where its progress says, in all four
 *      directions; a soft one is a band centred on it; a slide moves only B,
 *      a push moves A out ahead of it - measured by a green stripe on A;
 *   2. the sound: across a one-second dissolve of a 440 Hz clip into a
 *      1000 Hz one, each side is at -3 dB on the cut (equal power) - in
 *      playback, on the engine's gains and the master meter, and in an
 *      exported file decoded with ffmpeg; switched off, the sound cuts;
 *   3. the Titles and Transitions tabs: thumbnails drawn, still until
 *      pointed at, then moving; still under reduced motion;
 *   4. dragging from the panel: a transition onto a cut (the cuts are marked
 *      while dragging), another onto the same cut replaces it, a title onto
 *      an empty track at the drop frame; Enter adds at the playhead, and
 *      says so when there is nowhere to put a transition;
 *   5. Preferences: the default length is what Ctrl+T gives;
 *   6. playback cadence with the Transitions tab open and a thumbnail
 *      pointed at, against the Media tab: the thumbnails cost no frames;
 *   7. the panel in Spanish, with a drag.
 *
 * The window is never shown (SCF_BACKGROUND). Screenshots go to TRANSITIONS_SHOTS.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'transitions-f4');
const shotsDir = process.env.TRANSITIONS_SHOTS ?? '';
const W = 640;
const H = 360;
const FPS = 30;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const dB = (ratio) => 20 * Math.log10(ratio);

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Level of `frequency` in `samples` (mono, `rate` Hz) from `from` for `count` samples: Goertzel. */
function tone(samples, rate, frequency, from, count) {
  const k = (2 * Math.PI * frequency) / rate;
  const coefficient = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < count; i += 1) {
    // A Hann window, so the neighbouring tone does not leak in.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1));
    const s = samples[from + i] * w + coefficient * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2);
}

/** A file's sound, mono float at 48 kHz, decoded with ffmpeg. */
async function decodeAudio(file) {
  const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const stripe = join(workDir, 'red-stripe.png');
  const blue = join(workDir, 'blue.png');
  const toneA = join(workDir, 'tone-a.mp4');
  const toneB = join(workDir, 'tone-b.mp4');
  const long = join(workDir, 'long.mp4');
  // Red with a green stripe at x 300..339: where A has moved to is where its stripe is.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xff0000:s=${W}x${H},drawbox=x=300:y=0:w=40:h=${H}:color=0x00ff00:t=fill`, '-frames:v', '1', stripe]);
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x0000ff:s=${W}x${H}`, '-frames:v', '1', blue]);
  for (const [file, colour, frequency] of [[toneA, 'red', 440], [toneB, 'blue', 1000]]) {
    await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=${W}x${H}:r=${FPS}:d=6`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '192k', '-shortest', file]);
  }
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=12`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', long]);
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
    }, [stripe, blue, toneA, toneB, long]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 5, null, { timeout: 60_000 });
    await window.evaluate(([w, h, fps]) => window.__scfStore.getState().setProjectSettings({ width: w, height: h, fps }), [W, H, FPS]);

    const store = (fn, arg) => window.evaluate(fn, arg);
    /** Clips of the named media back to back on Video 1: [name, offset, length] each. */
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
      window.__scfStore.getState().selectTransition(null);
      // The playhead out of the way of what is measured on the timeline.
      window.__scfStore.getState().setCurrentFrame(0);
      return ids;
    }, parts);
    const transitions = () => store(() => Object.values(window.__scfStore.getState().project.transitions ?? {}));
    const setTransition = (patch) => store((p) => {
      const s = window.__scfStore.getState();
      s.updateTransition(Object.keys(s.project.transitions)[0], p);
    }, patch);
    const ask = window.getByTestId('transition-dialog');
    const addAtCut = async (frame) => {
      await store((at) => { window.__scfStore.getState().setCurrentFrame(at); window.__scfStore.getState().selectClips([]); }, frame);
      await store(() => window.__scfStore.getState().addTransitions());
      await sleep(200);
      if (await ask.isVisible().catch(() => false)) await window.getByTestId('transition-freeze').click();
    };

    /** One frame, rendered exactly: the middle row, and one column. */
    const frameAt = (frame, column = W / 2) => store(async ([at, x]) => {
      const renderer = window.__scfRenderer();
      const { project } = window.__scfStore.getState();
      renderer.beginExclusive();
      try {
        const rgba = await renderer.renderExact(project, at, false);
        const row = [];
        const y = Math.floor(project.height / 2);
        for (let i = 0; i < project.width; i += 1) row.push([...rgba.subarray((y * project.width + i) * 4, (y * project.width + i) * 4 + 3)]);
        const col = [];
        for (let j = 0; j < project.height; j += 1) col.push([...rgba.subarray((j * project.width + x) * 4, (j * project.width + x) * 4 + 3)]);
        return { row, col };
      } finally {
        renderer.endExclusive();
      }
    }, [frame, column]);
    const isB = ([r, , b]) => b > 128 && r < 128;
    const isStripe = ([r, g, b]) => g > 128 && r < 100 && b < 100;
    const indices = (pixels, test) => pixels.map((pixel, index) => (test(pixel) ? index : -1)).filter((index) => index >= 0);
    // A 30-frame transition centred on the cut at 60 runs over frames 45..74.
    const progressAt = (frame) => (frame - 45) / 30;

    console.log('1. pixels: wipe, slide, push');
    await layOut([['red-stripe.png', 0, 60], ['blue.png', 0, 60]]);
    await addAtCut(60);
    await setTransition({ kind: 'wipe', direction: 'right', softness: 0 });
    {
      const results = [];
      for (const [direction, frame] of [['right', 52], ['right', 67], ['left', 52], ['up', 52], ['down', 67]]) {
        await setTransition({ direction });
        const { row, col } = await frameAt(frame, 100);
        const p = progressAt(frame);
        let measured;
        let expected;
        if (direction === 'right') { measured = Math.max(...indices(row, isB)) + 1; expected = p * W; }
        if (direction === 'left') { measured = Math.min(...indices(row, isB)); expected = W - p * W; }
        // Rows count down from the top: 'up' comes in from the bottom.
        if (direction === 'up') { measured = Math.min(...indices(col, isB)); expected = H - p * H; }
        if (direction === 'down') { measured = Math.max(...indices(col, isB)) + 1; expected = p * H; }
        results.push({ direction, frame, measured, expected: Number(expected.toFixed(1)), ok: Math.abs(measured - expected) <= 2 });
      }
      check('a hard wipe\'s edge is where its progress puts it, in all four directions (within 2 px)', results.every((r) => r.ok),
        results.map((r) => `${r.direction}@${r.frame}: ${r.measured} px, expected ${r.expected}`).join('; '));
      await setTransition({ direction: 'right', softness: 1 });
      const { row } = await frameAt(60);
      // B's share, read from its blue (A, red and green, has none): 10..90%.
      const band = indices(row, ([, , b]) => b > 25 && b < 230);
      const centre = band.length ? (band[0] + band[band.length - 1] + 1) / 2 : -1;
      check('a soft wipe is a band of mixed pixels centred on the edge (softness 100% = a fifth of the frame, 10..90% of it mixed)',
        band.length >= 60 && band.length <= 100 && Math.abs(centre - W / 2) <= 3, `${band.length} px mixed, centred at ${centre}`);
      if (shotsDir) {
        await store(() => window.__scfStore.getState().setCurrentFrame(60));
        await sleep(400);
        await window.getByTestId('preview-panel').screenshot({ path: join(shotsDir, 'wipe-soft-preview.png') });
      }
    }
    {
      await setTransition({ kind: 'slide', direction: 'left' });
      const slide = (await frameAt(52)).row;
      const bFrom = Math.min(...indices(slide, isB));
      const slideStripe = Math.min(...indices(slide, isStripe));
      await setTransition({ kind: 'push', direction: 'left' });
      const push = (await frameAt(52)).row;
      const pushB = Math.min(...indices(push, isB));
      const pushStripe = Math.min(...indices(push, isStripe));
      const p = progressAt(52);
      check('a slide brings B in from the right over A, which stays put: B from x = W(1-p), the stripe still at 300',
        Math.abs(bFrom - W * (1 - p)) <= 2 && slideStripe === 300, `B from ${bFrom} (expected ${(W * (1 - p)).toFixed(1)}), stripe at ${slideStripe}`);
      check('a push moves A out ahead of B: the stripe at 300 - pW',
        Math.abs(pushB - W * (1 - p)) <= 2 && Math.abs(pushStripe - (300 - W * p)) <= 2, `B from ${pushB}, stripe at ${pushStripe} (expected ${(300 - W * p).toFixed(1)})`);
      await setTransition({ kind: 'slide', direction: 'up' });
      const up = (await frameAt(52, 100)).col;
      const upFrom = Math.min(...indices(up, isB));
      check('a slide upward brings B up from the bottom', Math.abs(upFrom - H * (1 - p)) <= 2, `B from row ${upFrom} (expected ${(H * (1 - p)).toFixed(1)})`);
    }

    console.log('2. the sound across the cut');
    // 440 Hz then 1000 Hz, each from 1.5 s into its file: 45 frames of handle each side.
    const [clipA, clipB] = await layOut([['tone-a.mp4', 45, 90], ['tone-b.mp4', 45, 90]]);
    await addAtCut(90);
    const made = (await transitions())[0];
    check('Ctrl+T gives a centred one-second dissolve with its sound crossfaded by default', made?.durationFrames === 30 && made.audioCrossfade === true,
      JSON.stringify({ length: made?.durationFrames, audio: made?.audioCrossfade }));
    {
      // Playback: the engine's gains on the cut, and the master's level alone and across.
      const played = await store(async ([a, b]) => {
        const engineOf = () => window.__scfAudioEngine();
        const s = window.__scfStore.getState();
        s.setCurrentFrame(45);
        await new Promise((done) => setTimeout(done, 500));
        s.setPlaying(true);
        const at = (seconds) => new Promise((done) => {
          const poll = () => {
            const engine = engineOf();
            if (engine && engine.isPlaying && engine.positionSeconds >= seconds) done(engine);
            else setTimeout(poll, 2);
          };
          poll();
        });
        const rms = (engine) => engine.meterLevels().master.rms[0];
        const alone = rms(await at(2.0));
        const engine = await at(3.0);
        const sample = { position: engine.positionSeconds, gainA: engine.strips.get(a)?.gain.gain.value, gainB: engine.strips.get(b)?.gain.gain.value, across: rms(engine) };
        window.__scfStore.getState().setPlaying(false);
        return { alone, ...sample };
      }, [clipA, clipB]);
      check('in playback each side is at -3 dB on the cut (equal power: 0.707 each)',
        Math.abs(dB(played.gainA) + 3.01) < 0.5 && Math.abs(dB(played.gainB) + 3.01) < 0.5,
        `at ${played.position.toFixed(3)} s: A ${dB(played.gainA).toFixed(2)} dB, B ${dB(played.gainB).toFixed(2)} dB`);
      check('and the master level across the cut is the level of one clip alone (the power stays constant)',
        Math.abs(dB(played.across / played.alone)) < 1, `alone ${played.alone.toFixed(4)}, across ${played.across.toFixed(4)} RMS (${dB(played.across / played.alone).toFixed(2)} dB)`);
    }
    {
      // The export: decoded, and each tone measured on the cut against itself alone.
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, exportDir);
      await store(() => window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', exportAlpha: false }));
      await window.getByRole('button', { name: 'Export' }).click();
      const dialog = window.getByRole('dialog', { name: 'Export' });
      await dialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Whole timeline' }).click();
      await dialog.getByLabel('File name').fill('crossfade');
      await dialog.getByRole('button', { name: 'Browse' }).click();
      await sleep(400);
      await dialog.getByRole('button', { name: 'Start export' }).click();
      await window.getByText('Export finished', { exact: false }).waitFor({ state: 'visible', timeout: 180_000 });
      await dialog.getByTitle('Close').click();
      await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
      const file = (await readdir(exportDir)).find((name) => name.startsWith('crossfade'));
      const samples = await decodeAudio(join(exportDir, file));
      const rate = 48000;
      const span = 2400;
      const level = (frequency, seconds) => tone(samples, rate, frequency, Math.round(seconds * rate - span / 2), span);
      const a = dB(level(440, 3.0) / level(440, 1.0));
      const b = dB(level(1000, 3.0) / level(1000, 5.0));
      const aBefore = dB(level(440, 2.45) / level(440, 1.0));
      const aAfter = level(440, 3.55) / level(440, 1.0);
      check('in the exported file each tone is at -3 dB on the cut', Math.abs(a + 3.01) < 0.5 && Math.abs(b + 3.01) < 0.5,
        `440 Hz ${a.toFixed(2)} dB, 1000 Hz ${b.toFixed(2)} dB, against each alone`);
      check('and the crossfade spans the transition: A full just before it, gone just after', Math.abs(aBefore) < 0.5 && aAfter < 0.03,
        `440 Hz at 2.45 s ${aBefore.toFixed(2)} dB, at 3.55 s ${(aAfter * 100).toFixed(1)}%`);
    }
    {
      await setTransition({ audioCrossfade: false });
      const off = await store(async () => {
        const s = window.__scfStore.getState();
        const mix = await window.__scfMix.renderTimelineAudio(s.project, s.assets, 0, 180, { sampleRate: 48000, channels: 1 });
        const view = new DataView(mix.wav);
        let at = 12;
        let bits = 16;
        let data = -1;
        let size = 0;
        while (at < view.byteLength - 8) {
          const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
          const length = view.getUint32(at + 4, true);
          if (id === 'fmt ') bits = view.getUint16(at + 22, true);
          if (id === 'data') { data = at + 8; size = length; break; }
          at += 8 + length;
        }
        const count = size / (bits / 8);
        const read = (i) => (bits === 32 ? view.getFloat32(data + i * 4, true) : view.getInt16(data + i * 2, true) / 32768);
        const samples = new Float32Array(count);
        for (let i = 0; i < count; i += 1) samples[i] = read(i);
        const goertzel = (frequency, seconds) => {
          const n = 2400;
          const from = Math.round(seconds * 48000 - n / 2);
          const c = 2 * Math.cos((2 * Math.PI * frequency) / 48000);
          let s1 = 0;
          let s2 = 0;
          for (let i = 0; i < n; i += 1) {
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
            const v = samples[from + i] * w + c * s1 - s2;
            s2 = s1;
            s1 = v;
          }
          return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2);
        };
        return { aBefore: goertzel(440, 2.8) / goertzel(440, 1.0), bAfter: goertzel(1000, 3.2) / goertzel(1000, 5.0), aAfter: goertzel(440, 3.2) / goertzel(440, 1.0) };
      });
      check('switched off in the Inspector, the sound cuts at the cut: A full before it, gone after, B full after',
        Math.abs(dB(off.aBefore)) < 0.5 && Math.abs(dB(off.bAfter)) < 0.5 && off.aAfter < 0.03, JSON.stringify(Object.fromEntries(Object.entries(off).map(([k, v]) => [k, Number(v.toFixed(3))]))));
      await store(() => window.__scfStore.getState().selectTransition(Object.keys(window.__scfStore.getState().project.transitions)[0]));
      await sleep(300);
      if (shotsDir) await window.getByTestId('inspector-panel').screenshot({ path: join(shotsDir, 'inspector-audio-off-en.png') }).catch(() => undefined);
      await setTransition({ audioCrossfade: true, kind: 'wipe', direction: 'right', softness: 0.5 });
      await sleep(300);
      if (shotsDir) await window.getByTestId('inspector-panel').screenshot({ path: join(shotsDir, 'inspector-wipe-en.png') }).catch(() => undefined);
    }

    console.log('3. the Titles and Transitions tabs');
    const media = window.getByTestId('media-panel');
    await window.getByTestId('library-tab-transitions').click();
    await window.getByTestId('library-transition-wipe').waitFor({ state: 'visible', timeout: 5_000 });
    await sleep(300);
    const thumb = (testId) => store((id) => {
      const canvas = document.querySelector(`[data-testid="${id}"] canvas`);
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        hash = (hash * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) % 1000000007;
        if (data[i + 3] > 0) lit += 1;
      }
      return { hash, lit, total: data.length / 4 };
    }, testId);
    const still1 = await thumb('library-transition-push');
    await sleep(400);
    const still2 = await thumb('library-transition-push');
    check('every transition thumbnail is drawn, and still when not pointed at', still1.lit === still1.total && still1.hash === still2.hash,
      `${still1.lit}/${still1.total} pixels drawn`);
    await window.getByTestId('library-transition-push').hover();
    const seen = new Set();
    for (let i = 0; i < 8; i += 1) { seen.add((await thumb('library-transition-push')).hash); await sleep(120); }
    check('pointed at, it plays: the picture changes', seen.size >= 3, `${seen.size} different pictures in 1 s`);
    if (shotsDir) await media.screenshot({ path: join(shotsDir, 'panel-transitions-en.png') });
    await window.mouse.move(800, 20);
    await sleep(200);
    const settled = await thumb('library-transition-push');
    check('and back to the same still picture when the pointer leaves', settled.hash === still1.hash);
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(200);
    await window.getByTestId('library-transition-push').hover();
    const reduced = new Set();
    for (let i = 0; i < 5; i += 1) { reduced.add((await thumb('library-transition-push')).hash); await sleep(120); }
    check('with reduced motion it stays still, even pointed at', reduced.size === 1);
    await window.emulateMedia({ reducedMotion: 'no-preference' });
    await window.mouse.move(800, 20);
    await window.getByTestId('library-tab-titles').click();
    await window.getByTestId('library-title-credits').waitFor({ state: 'visible', timeout: 5_000 });
    await sleep(500);
    const titleThumb = await thumb('library-title-lowerThird');
    check('the title thumbnails are drawn by the title renderer', titleThumb.lit === titleThumb.total);
    await window.getByTestId('library-title-lowerThird').hover();
    const titleSeen = new Set();
    for (let i = 0; i < 10; i += 1) { titleSeen.add((await thumb('library-title-lowerThird')).hash); await sleep(90); }
    check('a title thumbnail plays its template\'s entrance when pointed at', titleSeen.size >= 3, `${titleSeen.size} different pictures`);
    if (shotsDir) await media.screenshot({ path: join(shotsDir, 'panel-titles-en.png') });
    await window.mouse.move(800, 20);
    check('the tabs are a tab list: Media, Titles, Transitions, one selected',
      (await window.getByRole('tab').allInnerTexts()).filter((text) => ['Media', 'Titles', 'Transitions'].includes(text.trim())).length === 3
      && (await window.getByTestId('library-tab-titles').getAttribute('aria-selected')) === 'true');

    console.log('4. dragging from the panel');
    await layOut([['long.mp4', 0, 90], ['long.mp4', 90, 90], ['long.mp4', 180, 90]]);
    await store(() => window.__scfStore.getState().setUi({ pixelsPerFrame: 2, scrollLeftPx: 0 }));
    await sleep(300);
    const rowsNow = () => store(() => {
      const { tracks } = window.__scfStore.getState().project;
      const visual = tracks.filter((t) => t.type !== 'audio').sort((a, b) => b.order - a.order);
      return { v1: visual.findIndex((t) => t.order === 0), v2: visual.findIndex((t) => t.order === 1), v2Id: visual.find((t) => t.order === 1)?.id };
    });
    // Rows move when a title opens a track on top: read again before each part.
    let rows = await rowsNow();
    /** A drag from a panel item to (frame, row) on the timeline; `drop` false stops over it. */
    const dragFromPanel = (testId, frame, row, drop = true) => store(([id, f, r, finish]) => {
      const item = document.querySelector(`[data-testid="${id}"]`);
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      const target = canvas.parentElement.parentElement;
      const bounds = target.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      const init = { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + f * window.__scfStore.getState().ui.pixelsPerFrame, clientY: bounds.top + 24 + r * 58 + 28 };
      target.dispatchEvent(new DragEvent('dragenter', init));
      target.dispatchEvent(new DragEvent('dragover', init));
      if (finish) {
        target.dispatchEvent(new DragEvent('drop', init));
        item.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      }
    }, [testId, frame, row, drop]);
    const endDrag = (testId) => store((id) => {
      const target = document.querySelector('[data-testid="timeline-canvas"]').parentElement.parentElement;
      target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }));
      document.querySelector(`[data-testid="${id}"]`).dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    }, testId);
    /** Light blue drop marks in the Video 1 row of the timeline canvas at these frames. */
    const marksAt = (frames, row) => store(([fs, r]) => {
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      const context = canvas.getContext('2d');
      const scale = canvas.width / canvas.clientWidth;
      const ppf = window.__scfStore.getState().ui.pixelsPerFrame;
      return fs.map((f) => {
        const [red, green, blueValue] = context.getImageData(Math.round(f * ppf * scale), Math.round((24 + r * 58 + 14) * scale), 1, 1).data;
        return red > 130 && red < 170 && green > 180 && blueValue > 230;
      });
    }, [frames, row]);

    await window.getByTestId('library-tab-transitions').click();
    await sleep(200);
    // Picked up and held over the middle of the second clip, nearer its start.
    await dragFromPanel('library-transition-wipe', 120, rows.v1, false);
    await sleep(250);
    const marks = await marksAt([90, 180], rows.v1);
    check('while a transition is dragged, both cuts are marked on the timeline', marks.every(Boolean), JSON.stringify(marks));
    if (shotsDir) await window.getByTestId('timeline-canvas').screenshot({ path: join(shotsDir, 'drag-transition-targets-en.png') });
    await endDrag('library-transition-wipe');
    await sleep(150);
    check('and nothing is added by a drag that is let go elsewhere', (await transitions()).length === 0);
    await dragFromPanel('library-transition-wipe', 120, rows.v1);
    await sleep(300);
    let now = await transitions();
    const cutOne = await store(() => Object.values(window.__scfStore.getState().project.clips).sort((a, b) => a.startFrame - b.startFrame).map((c) => c.id));
    check('dropped on the second clip near its start, a wipe goes on the cut at 90',
      now.length === 1 && now[0].kind === 'wipe' && now[0].fromClipId === cutOne[0] && now[0].toClipId === cutOne[1], JSON.stringify(now.map((t) => [t.kind, t.durationFrames])));
    const depthBefore = await store(() => window.__scfHistory.getState().undoStack.length);
    await dragFromPanel('library-transition-push', 80, rows.v1);
    await sleep(300);
    now = await transitions();
    check('a push dropped on the same cut replaces the wipe, as one undo step',
      now.length === 1 && now[0].kind === 'push' && (await store(() => window.__scfHistory.getState().undoStack.length)) === depthBefore + 1, now.map((t) => t.kind).join());
    await dragFromPanel('library-transition-dipToBlack', 250, rows.v1);
    await sleep(300);
    now = await transitions();
    check('dropped on the third clip, a dip to black goes on the cut at 180', now.length === 2 && now.some((t) => t.kind === 'dip' && t.fromClipId === cutOne[1]));
    await window.getByTestId('library-tab-titles').click();
    await sleep(200);
    await dragFromPanel('library-title-lowerThird', 60, rows.v2, false);
    await sleep(250);
    if (shotsDir) await window.getByTestId('timeline-canvas').screenshot({ path: join(shotsDir, 'drag-title-target-en.png') });
    await endDrag('library-title-lowerThird');
    await dragFromPanel('library-title-lowerThird', 60, rows.v2);
    await sleep(300);
    const dropped = await store(() => Object.values(window.__scfStore.getState().project.clips).filter((c) => c.title));
    check('a title dropped on the empty Video 2 lands there, at the drop frame, as a lower third',
      dropped.length === 1 && dropped[0].trackId === rows.v2Id && dropped[0].startFrame === 60 && dropped[0].title.preset === 'lowerThird',
      JSON.stringify(dropped.map((c) => [c.startFrame, c.title.preset, c.trackId === rows.v2Id])));
    // Enter on a focused title: at the playhead.
    await store(() => { window.__scfStore.getState().setCurrentFrame(200); window.__scfStore.getState().selectClips([]); });
    await window.getByTestId('library-title-title').focus();
    await window.keyboard.press('Enter');
    await sleep(300);
    const entered = await store(() => Object.values(window.__scfStore.getState().project.clips).filter((c) => c.title && c.title.preset === 'title'));
    check('Enter on a focused title adds it at the playhead', entered.length === 1 && entered[0].startFrame === 200);
    // Enter on a transition with nowhere to put it says so.
    await window.getByTestId('library-tab-transitions').click();
    await store(() => { window.__scfStore.getState().setCurrentFrame(20); window.__scfStore.getState().selectClips([]); window.__scfStore.getState().selectTransition(null); });
    await window.getByTestId('library-transition-slide').focus();
    const count = (await transitions()).length;
    await window.keyboard.press('Enter');
    await sleep(300);
    const said = await window.getByText('Nothing to put it on', { exact: false }).first().isVisible().catch(() => false);
    check('Enter on a transition with no cut near the playhead adds nothing, and says why', (await transitions()).length === count && said);
    await store(async () => {
      const s = window.__scfStore.getState();
      for (const id of Object.keys(s.project.transitions)) s.removeTransition(id);
      s.setCurrentFrame(92);
    });
    await window.getByTestId('library-transition-slide').focus();
    await window.keyboard.press('Enter');
    await sleep(300);
    now = await transitions();
    check('Enter on a focused transition puts it on the cut at the playhead', now.length === 1 && now[0].kind === 'slide');

    console.log('5. the default length in Preferences');
    const openPrefs = async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'preferences'));
      await window.getByTestId('prefs-transition-length').waitFor({ state: 'visible', timeout: 5_000 });
    };
    const ctrlT = async () => {
      await store(() => {
        const s = window.__scfStore.getState();
        for (const id of Object.keys(s.project.transitions)) s.removeTransition(id);
        s.setCurrentFrame(90);
        s.selectClips([]);
      });
      await window.getByTestId('timeline-canvas').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
      await store(() => window.__scfStore.getState().setCurrentFrame(90));
      await window.keyboard.press('Control+t');
      await sleep(250);
      if (await ask.isVisible().catch(() => false)) await window.getByTestId('transition-freeze').click();
      return (await transitions())[0]?.durationFrames;
    };
    await openPrefs();
    if (shotsDir) { await sleep(400); await window.getByTestId('preferences-dialog').screenshot({ path: join(shotsDir, 'preferences-length-en.png') }); }
    await window.getByTestId('prefs-transition-length').selectOption('0.5');
    await window.keyboard.press('Escape');
    await sleep(300);
    const half = await ctrlT();
    await openPrefs();
    await window.getByTestId('prefs-transition-length').selectOption('custom');
    await window.getByTestId('prefs-transition-custom').fill('2.5');
    await window.getByTestId('prefs-transition-custom').blur();
    if (shotsDir) { await sleep(200); await window.getByTestId('preferences-dialog').screenshot({ path: join(shotsDir, 'preferences-custom-en.png') }); }
    await window.keyboard.press('Escape');
    await sleep(300);
    const custom = await ctrlT();
    const kept = await store(() => window.localStorage.getItem('scf.transitionSeconds'));
    check('Ctrl+T gives the length chosen in Preferences: 0.5 s is 15 frames, a custom 2.5 s is 75, and it is remembered',
      half === 15 && custom === 75 && kept === '2.5', `0.5 s -> ${half} frames, 2.5 s -> ${custom} frames, stored ${kept}`);
    await openPrefs();
    await window.getByTestId('prefs-transition-length').selectOption('1');
    await window.keyboard.press('Escape');
    await sleep(300);

    console.log('6. playback cadence with the panel open');
    const cadence = async () => store(async () => {
      const gaps = [];
      let last = 0;
      let sampling = true;
      const canvas = document.querySelector('[data-testid="library-transition-crossDissolve"] canvas');
      const snap = () => (canvas ? canvas.toDataURL().length + canvas.toDataURL().slice(-64) : '');
      const tick = (time) => {
        if (last) gaps.push(time - last);
        last = time;
        if (sampling) requestAnimationFrame(tick);
      };
      window.__scfStore.getState().setCurrentFrame(0);
      await new Promise((done) => setTimeout(done, 600));
      requestAnimationFrame(tick);
      window.__scfStore.getState().setPlaying(true);
      await new Promise((done) => setTimeout(done, 400));
      const first = snap();
      await new Promise((done) => setTimeout(done, 2600));
      const second = snap();
      window.__scfStore.getState().setPlaying(false);
      sampling = false;
      const q = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
      const missed = gaps.filter((gap) => gap > 1000 / 30).length;
      return { frames: gaps.length, p95: q(gaps, 95), missed, worst: Math.max(...gaps), still: first === second };
    });
    await layOut([['long.mp4', 0, 150]]);
    await window.getByTestId('library-tab-media').click();
    await sleep(300);
    const base = await cadence();
    await window.getByTestId('library-tab-transitions').click();
    await sleep(300);
    await window.getByTestId('library-transition-crossDissolve').hover();
    await sleep(300);
    const open = await cadence();
    check('playing with the Transitions tab open and a thumbnail pointed at keeps the Media tab\'s cadence: no video frame missed, p95 within 1 ms',
      open.missed <= base.missed && open.p95 <= base.p95 + 1,
      `Media tab: ${base.frames} display frames, p95 ${base.p95.toFixed(1)} ms, worst ${base.worst.toFixed(1)} ms, ${base.missed} missed; Transitions tab, pointed at: ${open.frames}, p95 ${open.p95.toFixed(1)} ms, worst ${open.worst.toFixed(1)} ms, ${open.missed} missed`);
    check('and the pointed-at thumbnail stays still while the preview plays', open.still === true);
    await window.mouse.move(800, 20);

    console.log('7. in Spanish');
    await openPrefs();
    await window.getByTestId('language-select').selectOption('es');
    await window.keyboard.press('Escape');
    await sleep(300);
    const tabs = (await window.getByRole('tab').allInnerTexts()).map((text) => text.trim());
    check('las pestañas en español: Medios, Títulos, Transiciones', ['Medios', 'Títulos', 'Transiciones'].every((label) => tabs.includes(label)), tabs.join(', '));
    const names = await store(() => [...document.querySelectorAll('[data-testid^="library-transition-"]')].map((el) => el.innerText.trim()));
    check('y las transiciones con su nombre en español', names.includes('Barrido') && names.includes('Deslizar') && names.includes('Empujar') && names.includes('Fundido a negro'), names.join(', '));
    await layOut([['long.mp4', 0, 90], ['long.mp4', 90, 90]]);
    rows = await rowsNow();
    await dragFromPanel('library-transition-slide', 100, rows.v1, false);
    await sleep(250);
    if (shotsDir) {
      await window.getByTestId('timeline-canvas').screenshot({ path: join(shotsDir, 'drag-transition-targets-es.png') });
      await media.screenshot({ path: join(shotsDir, 'panel-transitions-es.png') });
    }
    await endDrag('library-transition-slide');
    await dragFromPanel('library-transition-slide', 100, rows.v1);
    await sleep(300);
    now = await transitions();
    check('arrastrar «Deslizar» a un corte lo pone en el corte', now.length === 1 && now[0].kind === 'slide');
    await window.getByTestId('library-tab-titles').click();
    await sleep(200);
    await dragFromPanel('library-title-credits', 30, rows.v2);
    await sleep(300);
    const credits = await store(() => Object.values(window.__scfStore.getState().project.clips).filter((c) => c.title));
    check('arrastrar «Créditos finales» a Vídeo 2 lo pone allí', credits.length === 1 && credits[0].title.preset === 'credits' && credits[0].startFrame === 30);
    if (shotsDir) await media.screenshot({ path: join(shotsDir, 'panel-titles-es.png') });
    await store(() => window.__scfStore.getState().selectTransition(Object.keys(window.__scfStore.getState().project.transitions)[0]));
    await sleep(300);
    if (shotsDir) await window.getByTestId('inspector-panel').screenshot({ path: join(shotsDir, 'inspector-slide-es.png') }).catch(() => undefined);
    await openPrefs();
    if (shotsDir) { await sleep(400); await window.getByTestId('preferences-dialog').screenshot({ path: join(shotsDir, 'preferences-length-es.png') }); }
    await window.keyboard.press('Escape');
    if (shotsDir) { await sleep(300); await window.screenshot({ path: join(shotsDir, 'editor-es.png') }); }

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
