import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * How editing feels on a heavy project: `node tests/perf/editing.mjs`
 *
 * A project of the size people really make - 40 clips of 1080p and 4K on the
 * main track, a dozen with effects, ten transitions, a dozen titles, six
 * animated stickers on tracks of their own, a picture in picture, a music
 * bed and sixty captions - and then the things an editor does all day,
 * with the real mouse and keyboard: scrolling and zooming the timeline,
 * scrubbing, dragging and trimming clips, a rubber band, moving and sizing a
 * sticker in the viewer, a slider in the inspector, the library's rail and
 * its animated tiles, playing, a storm of undos and redos, typing into a
 * title, a burst of notices.
 *
 * Each is measured as motion.mjs measures it - every animation frame and the
 * browser's Long Animation Frames - and the long frames say what held them
 * up (their scripts: who called, from where), which is what is needed to
 * make them faster. The JS heap is read at the start and the end.
 *
 * PERF_GPU picks the GPU (high-performance by default); PERF_ONLY="zoom|scrub"
 * runs only the scenarios whose names match it; PERF_PROXIES=1 builds the
 * footage's proxies first (Media > Proxies), as an editor of 4K would. Results go to
 * .stress-tmp/perf-editing/report.json; nothing is exported, nowhere is
 * written outside the work folder.
 */

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(projectRoot, '.stress-tmp', 'perf-editing');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const report = { gpu: '', refreshMs: 16.7, heap: {}, scenarios: {}, flagged: [] };

async function media() {
  await mkdir(work, { recursive: true });
  const files = {
    hd: join(work, 'talk-1080.mp4'),
    uhd: join(work, 'city-4k.mp4'),
    music: join(work, 'music.wav'),
    logo: join(work, 'logo.png'),
  };
  const make = (args) => run(ffmpeg, ['-y', '-v', 'error', ...args], { maxBuffer: 1 << 24 });
  await make(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=60', '-f', 'lavfi', '-i', 'sine=f=220:d=60:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', files.hd]);
  await make(['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', files.uhd]);
  await make(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*110*t)*abs(sin(2*PI*t/2))+0.2*sin(2*PI*330*t)':s=48000:d=130", files.music]);
  await make(['-f', 'lavfi', '-i', 'color=c=0x22d3ee:s=640x360:d=1', '-frames:v', '1', files.logo]);
  return files;
}

async function main() {
  await rm(work, { recursive: true, force: true });
  const files = await media();
  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_NO_CLOSE_PROMPT: '1',
      FILMORA_GPU: process.env.PERF_GPU ?? 'high-performance',
      SCF_TTS_DIR: join(projectRoot, 'build', 'piper'),
      SCF_TTS_BUNDLED_DIR: join(projectRoot, 'build', 'tts-voices'),
    },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    const gpu = await window.evaluate(() => window.filmora.gpuReport?.().catch(() => null));
    report.gpu = gpu?.devices?.find((device) => device.active)?.name ?? '?';
    console.log(`GPU: ${report.gpu}`);

    /* The heavy project ----------------------------------------------------- */
    await app.evaluate(({ dialog }, list) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list }); }, [files.hd, files.uhd, files.music, files.logo]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 4, null, { timeout: 120_000 });
    if (process.env.PERF_PROXIES === '1') {
      await window.getByTestId('proxy-indicator').click();
      await window.getByTestId('build-proxies').click();
      await window.waitForFunction(() => window.__scfStore.getState().assets.filter((a) => a.kind === 'video').every((a) => a.proxyUri), null, { timeout: 300_000 });
      await window.keyboard.press('Escape');
      console.log('proxies built');
    }
    const built = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: 1920, height: 1080, fps: 30 });
      const asset = (name) => window.__scfStore.getState().assets.find((a) => a.name.startsWith(name));
      const main = window.__scfStore.getState().project.tracks.find((t) => t.type === 'video' && t.order === 0);
      const ids = [];
      for (let index = 0; index < 40; index += 1) {
        const source = index % 3 === 2 ? asset('city-4k') : asset('talk-1080');
        const id = window.__scfStore.getState().addAssetToTimeline(source, main.id, index * 90);
        window.__scfStore.getState().updateClip(id, { sourceOffsetFrames: (index * 37) % 300, durationFrames: 90 });
        ids.push(id);
      }
      const looks = ['gaussianBlur', 'vignette', 'filmGrain', 'glow', 'chromaticAberration', 'brightnessContrast'];
      ids.slice(0, 12).forEach((id, index) => window.__scfStore.getState().updateClip(id, { effects: [{ id: `fx-${index}`, type: looks[index % looks.length], enabled: true, params: {} }] }));
      const pairs = [];
      for (let index = 1; index < 40; index += 4) pairs.push({ fromId: ids[index - 1], toId: ids[index] });
      window.__scfStore.getState().addTransitions('crossDissolve', pairs.slice(0, 10));
      const firstTitle = window.__scfStore.getState().addTitle('title', { trackId: null, startFrame: 30 });
      const titleTrack = window.__scfStore.getState().project.clips[firstTitle].trackId;
      for (let index = 1; index < 12; index += 1) window.__scfStore.getState().addTitle(index % 2 ? 'lowerThird' : 'title', { trackId: titleTrack, startFrame: 30 + index * 300 });
      const audio = window.__scfStore.getState().project.tracks.find((t) => t.type === 'audio');
      window.__scfStore.getState().addAssetToTimeline(asset('music'), audio.id, 0);
      const before = new Set(window.__scfStore.getState().project.tracks.map((t) => t.id));
      window.__scfStore.getState().addTrack('video');
      const pip = window.__scfStore.getState().project.tracks.find((t) => !before.has(t.id));
      const logo = window.__scfStore.getState().addAssetToTimeline(asset('logo'), pip.id, 0);
      window.__scfStore.getState().updateClip(logo, { durationFrames: 1200 });
      window.__scfStore.getState().setTransformAt(logo, 0, { scale: { x: 0.25, y: 0.25 }, position: { x: 600, y: -320 } });
      window.__scfStore.getState().addCaptionTrack({ subtitles: Array.from({ length: 60 }, (_, index) => ({ startMs: index * 2000, endMs: index * 2000 + 1800, text: `Subtítulo número ${index + 1}, con algo de texto para leer.` })) }, { preset: 'classic', language: 'es' });
      return { ids, titleTrack };
    });
    // Six animated stickers, through the library, at six places.
    await window.getByTestId('library-tab-stickers').click();
    const stickerTiles = window.locator('[data-testid^="library-sticker-"]');
    for (let index = 0; index < 6; index += 1) {
      await window.evaluate((frame) => window.__scfStore.getState().setCurrentFrame(frame), 60 + index * 500);
      await stickerTiles.nth(index).click();
      await sleep(250);
    }
    const counts = await window.evaluate(() => ({ clips: Object.keys(window.__scfStore.getState().project.clips).length, tracks: window.__scfStore.getState().project.tracks.length }));
    console.log(`project: ${counts.clips} clips on ${counts.tracks} tracks`);
    report.project = counts;
    await window.evaluate(() => { window.__scfStore.getState().setCurrentFrame(150); window.__scfStore.getState().selectClips([]); });
    await sleep(2500);

    /* The sampler ----------------------------------------------------------- */
    await window.evaluate(() => {
      window.__perfFrames = [];
      window.__perfLoaf = [];
      const tick = (time) => {
        window.__perfFrames.push(time);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perfLoaf.push({
            start: entry.startTime,
            duration: entry.duration,
            blocking: entry.blockingDuration,
            // Where in the frame the time went: before rendering began, and rendering.
            render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0,
            waited: entry.renderStart ? entry.renderStart - entry.startTime : entry.duration,
            scripts: (entry.scripts ?? []).map((script) => ({
              duration: script.duration,
              invoker: script.invoker,
              fn: script.sourceFunctionName,
              at: `${(script.sourceURL ?? '').split('/').pop()}:${script.sourceCharPosition ?? ''}`,
            })),
          });
        }
      }).observe({ type: 'long-animation-frame', buffered: false });
    });
    const heap = () => window.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576));
    report.heap.start = await heap();
    {
      await window.evaluate(() => { window.__perfFrames.length = 0; });
      await sleep(1000);
      const times = await window.evaluate(() => window.__perfFrames.slice());
      const gaps = times.slice(1).map((time, index) => time - times[index]);
      report.refreshMs = Number(percentile(gaps, 50).toFixed(2));
      console.log(`refresh ${report.refreshMs} ms`);
    }

    const only = process.env.PERF_ONLY;
    const scenario = async (name, action, settleMs = 300) => {
      if (only && !new RegExp(only).test(name)) return null;
      await sleep(150);
      await window.evaluate(() => {
        window.__perfFrames.length = 0;
        window.__perfLoaf.length = 0;
      });
      const began = Date.now();
      await action();
      await sleep(settleMs);
      const { times, loaf } = await window.evaluate(() => ({ times: window.__perfFrames.slice(), loaf: window.__perfLoaf.slice() }));
      const gaps = times.slice(1).map((time, index) => time - times[index]);
      const refresh = report.refreshMs || 16.7;
      const dropped = gaps.reduce((sum, gap) => sum + (gap > refresh * 1.5 ? Math.round(gap / refresh) - 1 : 0), 0);
      // What held the long frames up: the scripts, summed by function.
      const blame = new Map();
      for (const entry of loaf) {
        for (const script of entry.scripts) {
          const key = `${script.fn || '(anonymous)'} <- ${script.invoker || '?'} @ ${script.at}`;
          blame.set(key, (blame.get(key) ?? 0) + script.duration);
        }
      }
      const result = {
        ms: Date.now() - began,
        frames: times.length,
        p50: Number(percentile(gaps, 50).toFixed(1)),
        p95: Number(percentile(gaps, 95).toFixed(1)),
        p99: Number(percentile(gaps, 99).toFixed(1)),
        worst: Number((gaps.length ? Math.max(...gaps) : 0).toFixed(1)),
        droppedPct: Number(((dropped / Math.max(1, gaps.length + dropped)) * 100).toFixed(1)),
        loaf: loaf.length,
        loafWorst: Number((loaf.length ? Math.max(...loaf.map((entry) => entry.duration)) : 0).toFixed(1)),
        blocking: Number(loaf.reduce((sum, entry) => sum + (entry.blocking || 0), 0).toFixed(1)),
        blame: [...blame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, ms]) => `${ms.toFixed(0)} ms ${key}`),
      };
      report.scenarios[name] = result;
      const bad = result.p95 > refresh * 2.2 || result.worst > 120 || result.blocking > 250;
      if (bad) report.flagged.push(name);
      console.log(`${bad ? 'SLOW' : 'ok  '} ${name.padEnd(22)} p50 ${result.p50} p95 ${result.p95} p99 ${result.p99} worst ${result.worst} ms, dropped ${result.droppedPct}%, ${result.loaf} long frames (worst ${result.loafWorst}, blocking ${result.blocking} ms)`);
      for (const line of result.blame) console.log(`        ${line}`);
      if (only) for (const entry of loaf) console.log(`        long frame ${entry.duration.toFixed(0)} ms: ${entry.waited.toFixed(0)} before rendering, ${entry.render.toFixed(0)} rendering, ${entry.scripts.length} scripts`);
      return result;
    };

    const canvas = await window.getByTestId('timeline-canvas').boundingBox();
    const scroller = window.locator('[data-panel="timeline"] .overflow-x-auto').first();
    const clipCentre = async (id) => window.evaluate((clipId) => {
      const { project, ui } = window.__scfStore.getState();
      const clip = project.clips[clipId];
      // The clip's row as the timeline laid it out: picture rows are taller than the rest.
      // (A build from before that has rows of 56 px, 2 apart, under a 24 px ruler.)
      const rows = [...project.tracks.filter((t) => t.type !== 'audio').sort((a, b) => b.order - a.order), ...project.tracks.filter((t) => t.type === 'audio').sort((a, b) => a.order - b.order)];
      const lane = window.__scfTimelineRow?.(clip.trackId) ?? { top: 24 + rows.findIndex((t) => t.id === clip.trackId) * 58, height: 56 };
      return { x: (clip.startFrame + clip.durationFrames / 2) * ui.pixelsPerFrame - ui.scrollLeftPx, y: lane.top + lane.height / 2, end: (clip.startFrame + clip.durationFrames) * ui.pixelsPerFrame - ui.scrollLeftPx };
    }, id);
    void scroller;
    // The view the timeline opened with: put back before a scenario that depends on what is on screen.
    const openingView = await window.evaluate(() => ({ pixelsPerFrame: window.__scfStore.getState().ui.pixelsPerFrame, scrollLeftPx: 0 }));
    const viewAt = async (view) => {
      await window.evaluate((ui) => window.__scfStore.getState().setUi(ui), view);
      await sleep(400);
    };

    /* 1-3. the timeline: scroll, zoom, scrub -------------------------------- */
    await window.mouse.move(canvas.x + canvas.width / 2, canvas.y + 120);
    await scenario('timeline scroll', async () => {
      for (let index = 0; index < 40; index += 1) {
        await window.mouse.wheel(index < 20 ? 160 : -160, 0);
        await sleep(16);
      }
    });
    await scenario('timeline zoom', async () => {
      await window.keyboard.down('Control');
      for (let index = 0; index < 24; index += 1) {
        await window.mouse.wheel(0, index < 12 ? -120 : 120);
        await sleep(24);
      }
      await window.keyboard.up('Control');
    }, 600);
    await scenario('scrub the playhead', async () => {
      await window.mouse.move(canvas.x + 120, canvas.y + 14);
      await window.mouse.down();
      for (let step = 0; step <= 60; step += 1) {
        await window.mouse.move(canvas.x + 120 + (step / 60) * (canvas.width - 240), canvas.y + 14);
        await sleep(16);
      }
      await window.mouse.up();
    });

    /* 4-6. clips: drag, trim, rubber band ---------------------------------- */
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(10));
    await sleep(300);
    const target = built.ids[2];
    const centre = await clipCentre(target);
    await scenario('drag a clip', async () => {
      await window.mouse.move(canvas.x + centre.x, canvas.y + centre.y);
      await window.mouse.down();
      for (let step = 1; step <= 40; step += 1) {
        await window.mouse.move(canvas.x + centre.x + step * 5, canvas.y + centre.y);
        await sleep(16);
      }
      for (let step = 40; step >= 0; step -= 1) {
        await window.mouse.move(canvas.x + centre.x + step * 5, canvas.y + centre.y);
        await sleep(16);
      }
      await window.mouse.up();
    });
    const edge = await clipCentre(built.ids[4]);
    await scenario('trim a clip end', async () => {
      await window.mouse.move(canvas.x + edge.end - 2, canvas.y + edge.y);
      await window.mouse.down();
      for (let step = 1; step <= 30; step += 1) {
        await window.mouse.move(canvas.x + edge.end - 2 - step * 3, canvas.y + edge.y);
        await sleep(16);
      }
      await window.mouse.up();
    });
    await window.keyboard.press('Control+z');
    /**
     * A band from the bottom right of the rows in view to near the top left:
     * the canvas is as tall as all the rows, most of them scrolled out of
     * sight, so it is placed by the part of the timeline on screen. How many
     * clips it chose goes in the report - the same band over more clips is
     * more work, and a run that chose more is not comparable.
     */
    const band = async (name) => {
      const view = await window.evaluate(() => {
        const body = document.querySelector('[data-testid="timeline-canvas"]').closest('.overflow-y-auto');
        const box = body.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      });
      // Above the horizontal scrollbar, which takes the last few pixels.
      const from = { x: Math.min(canvas.x + canvas.width, view.right) - 30, y: view.bottom - 24 };
      const to = { x: canvas.x + 40, y: view.top + 30 };
      // Started anywhere but on the canvas, the drag is not a band at all, and what is measured means nothing.
      const startsOn = await window.evaluate(([x, y]) => {
        const element = document.elementFromPoint(x, y);
        return element?.dataset.testid || element?.tagName || 'nothing';
      }, [from.x, from.y]);
      if (startsOn !== 'timeline-canvas') issues.push(`the rubber band started on ${startsOn}, not on the timeline`);
      await window.mouse.move(from.x, from.y);
      await window.mouse.down();
      for (let step = 1; step <= 30; step += 1) {
        await window.mouse.move(from.x + ((to.x - from.x) * step) / 30, from.y + ((to.y - from.y) * step) / 30);
        await sleep(16);
      }
      await window.mouse.up();
      return window.evaluate(() => window.__scfStore.getState().ui.selectedClipIds.length);
    };
    // The same view every run: the zoom before has its own easing to finish.
    await viewAt(openingView);
    let chosen = 0;
    await scenario('rubber band select', async () => {
      chosen = await band('rubber band select');
    });
    if (report.scenarios['rubber band select']) {
      report.scenarios['rubber band select'].chosen = chosen;
      console.log(`        the band chose ${chosen} clips`);
    }
    // The whole edit in view, and a band over all of it: a selection of many clips at once.
    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    await window.evaluate(() => window.__scfStore.getState().zoomToFit());
    await sleep(800);
    await scenario('rubber band over the whole edit', async () => {
      chosen = await band('rubber band over the whole edit');
    });
    if (report.scenarios['rubber band over the whole edit']) {
      report.scenarios['rubber band over the whole edit'].chosen = chosen;
      console.log(`        the band chose ${chosen} clips`);
    }
    await window.evaluate(() => window.__scfStore.getState().selectClips([]));
    await viewAt(openingView);

    /* 7-8. the viewer: a sticker moved and sized ---------------------------- */
    const sticker = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips).filter((c) => c.fx?.loop).sort((a, b) => a.startFrame - b.startFrame)[0];
      s.setCurrentFrame(clip.startFrame + 30);
      s.selectClips([clip.id]);
      return clip.id;
    });
    await sleep(600);
    const box = async () => {
      const tl = await window.getByTestId('viewport-handle-topLeft').boundingBox();
      const br = await window.getByTestId('viewport-handle-bottomRight').boundingBox();
      return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y, br };
    };
    const grip = await box();
    await scenario('move a sticker in the viewer', async () => {
      await window.mouse.move(grip.x + grip.w / 2, grip.y + grip.h / 2);
      await window.mouse.down();
      for (let step = 1; step <= 40; step += 1) {
        await window.mouse.move(grip.x + grip.w / 2 + Math.sin(step / 6) * 80, grip.y + grip.h / 2 + step * 2);
        await sleep(16);
      }
      await window.mouse.up();
    });
    const grip2 = await box();
    await scenario('size a sticker in the viewer', async () => {
      await window.mouse.move(grip2.br.x + 4, grip2.br.y + 4);
      await window.mouse.down();
      for (let step = 1; step <= 40; step += 1) {
        await window.mouse.move(grip2.br.x + 4 + step * 2, grip2.br.y + 4 + step * 1.5);
        await sleep(16);
      }
      await window.mouse.up();
    });
    void sticker;

    /* 9. the inspector: a slider --------------------------------------------- */
    await window.evaluate((id) => window.__scfStore.getState().selectClips([id]), built.ids[0]);
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(20));
    // The grade's tab: Adjust, as CapCut names it (Color in builds before v1.85).
    const gradeTab = window.getByTestId('inspector-panel').getByRole('tab', { name: /^(Adjust|Color)$/ });
    await gradeTab.click().catch(() => undefined);
    await sleep(500);
    const slider = window.locator('[data-panel="inspector"] input[type="range"]:visible').first();
    const sliderBox = await slider.boundingBox().catch(() => null);
    // A scenario that cannot run says so: skipped in silence, it read as a pass.
    if (!sliderBox && (!only || new RegExp(only).test('drag an inspector slider'))) issues.push('no inspector slider on screen to drag');
    if (sliderBox) {
      await scenario('drag an inspector slider', async () => {
        await window.mouse.move(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2);
        await window.mouse.down();
        for (let step = 1; step <= 40; step += 1) {
          await window.mouse.move(sliderBox.x + sliderBox.width / 2 + Math.sin(step / 5) * sliderBox.width * 0.4, sliderBox.y + sliderBox.height / 2);
          await sleep(16);
        }
        await window.mouse.up();
      });
    }

    /* 10-11. the library's rail, and the effects' tiles ---------------------- */
    await scenario('switch the library rail', async () => {
      for (const id of ['media', 'titles', 'transitions', 'effects', 'stickers', 'sounds', 'voice', 'captions', 'media']) {
        await window.getByTestId(`library-tab-${id}`).click();
        await sleep(220);
      }
    }, 500);
    await window.getByTestId('library-tab-effects').click();
    await sleep(800);
    await scenario('browse the effects tiles', async () => {
      const tiles = window.locator('[data-testid="library-effects"] button, [data-testid^="library-effect-"]');
      const count = Math.min(14, await tiles.count());
      for (let index = 0; index < count; index += 1) {
        await tiles.nth(index).hover({ force: true }).catch(() => undefined);
        await sleep(180);
      }
      await window.mouse.wheel(0, 400);
      await sleep(300);
      await window.mouse.wheel(0, -400);
    }, 500);

    /* 12. play the busy project ----------------------------------------------- */
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(240));
    await window.locator('[data-testid="viewer-timecode"]').click();
    await sleep(500);
    await scenario('play 6 s', async () => {
      await window.keyboard.press('Space');
      await sleep(6000);
      await window.keyboard.press('Space');
    }, 500);

    /* 13. a storm of undos and redos ----------------------------------------- */
    await window.locator('[data-testid="viewer-timecode"]').click();
    await scenario('25 undos and 25 redos', async () => {
      for (let index = 0; index < 25; index += 1) await window.keyboard.press('Control+z');
      for (let index = 0; index < 25; index += 1) await window.keyboard.press('Control+y');
    }, 600);

    /* 14. typing into a title -------------------------------------------------- */
    await window.evaluate((trackId) => {
      const s = window.__scfStore.getState();
      const title = Object.values(s.project.clips).find((c) => c.title && c.trackId === trackId);
      s.setCurrentFrame(title.startFrame + 20);
      s.selectClips([title.id]);
      s.setUi({ editingTitleId: title.id });
    }, built.titleTrack);
    await sleep(600);
    await scenario('type into a title', async () => {
      await window.keyboard.type(' Bienvenidos al canal de video', { delay: 35 });
    }, 500);
    await window.keyboard.press('Escape');

    /* 15. a burst of notices ---------------------------------------------------- */
    await scenario('a burst of notices', async () => {
      for (let index = 0; index < 6; index += 1) {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:menu-command', 'copyDiagnostics'));
        await sleep(120);
      }
    }, 900);

    report.heap.end = await heap();
    console.log(`\nJS heap: ${report.heap.start} MB at the start, ${report.heap.end} MB at the end`);
    console.log(report.flagged.length ? `slow: ${report.flagged.join(', ')}` : 'nothing slow');
    if (issues.length) console.log(`issues: ${issues.slice(0, 5).join(' | ')}`);
    report.issues = issues;
  } finally {
    await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2)).catch(() => undefined);
    await app.close().catch(() => undefined);
    try {
      await run('taskkill', ['/pid', String(pid), '/T', '/F']);
    } catch {
      // Already gone.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
