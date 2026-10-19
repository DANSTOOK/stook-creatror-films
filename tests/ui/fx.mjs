import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * The transitions and effects library on the GPU: `npm run test:fx:ui`
 *
 * For every shader transition in fx/transitions/catalog.ts, drawn by the
 * real compositor through renderExact between two different pictures:
 *   - it compiles (no shader error on the console) and draws something;
 *   - at progress 0 it is the outgoing picture and at progress 1 the
 *     incoming one (mean difference under 3 levels of 255);
 *   - at its still point it is neither black nor either picture unchanged.
 * For every effect in fx/effects/catalog.ts, at its defaults on one clip:
 *   - it compiles, draws, is not black, and differs from the clip without
 *     it; switched off it is exactly the clip without it.
 * The lists are read from the catalogs and their length checked, so the run
 * cannot pass by finding nothing to test.
 *
 * Progress 1 is never on the timeline (the window's last frame is just short
 * of it), so the harness pins a transition's progress by wrapping the
 * compositor's drawList - in the page only, never in the app.
 *
 * FX_SHOTS=<dir> also writes a contact sheet of every transition half-way
 * and every effect, as PNGs, to look at.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.ui-tmp', 'fx');
const shotsDir = process.env.FX_SHOTS ?? '';
const W = 640;
const H = 360;

const checks = [];
const failures = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  if (!passed) failures.push(name);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function catalogIds() {
  const transitions = await readFile(join(projectRoot, 'src/renderer/fx/transitions/catalog.ts'), 'utf8');
  const effects = await readFile(join(projectRoot, 'src/renderer/fx/effects/catalog.ts'), 'utf8');
  // One def(...) per transition; its still point, when it has one, is inside it.
  const chunks = transitions.split(/\n\s*def\('/).slice(1);
  const shaderIds = chunks.map((chunk) => /^(\w+)', '[^']+', '(\w+)'/.exec(chunk)).filter(Boolean).map((match) => ({ id: match[1], category: match[2] }));
  const stills = Object.fromEntries(chunks.map((chunk) => [/^(\w+)'/.exec(chunk)?.[1], Number(/still: ([\d.]+)/.exec(chunk)?.[1] ?? NaN)]).filter(([, value]) => Number.isFinite(value)));
  const effectTypes = [...effects.matchAll(/type: '(\w+)',?\s*category:/g)].map((match) => match[1]);
  return { shaderIds, stills, effectTypes };
}

async function main() {
  const { shaderIds, stills, effectTypes } = await catalogIds();
  console.log(`catalogs: ${shaderIds.length} shader transitions, ${effectTypes.length} effects`);
  check('the transition catalog lists at least 40 shader transitions', shaderIds.length >= 40, String(shaderIds.length));
  check('the effect catalog lists at least 15 effects', effectTypes.length >= 15, String(effectTypes.length));

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const a = join(workDir, 'a.png');
  const b = join(workDir, 'b.png');
  // Two pictures with detail everywhere, so a warp or a blur shows, and
  // different enough that "is it still A?" has an answer.
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}`, '-frames:v', '1', a]);
  await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `mandelbrot=s=${W}x${H}`, '-frames:v', '1', b]);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      FILMORA_GPU: process.env.FILMORA_GPU ?? 'high-performance',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      SCF_SKIP_HOME: '1',
      SCF_NO_CLOSE_PROMPT: '1',
    },
  });
  const consoleErrors = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
    window.on('pageerror', (error) => consoleErrors.push(`pageerror ${error.message}`));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    const gpu = await window.evaluate(() => window.filmora.gpuReport());
    console.log(`   GPU: ${gpu.devices.find((device) => device.active)?.name ?? '?'}`);

    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, [a, b]);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 2, null, { timeout: 60_000 });
    const ids = await window.evaluate(([w, h]) => {
      const s = window.__scfStore.getState();
      s.setProjectSettings({ width: w, height: h, fps: 30 });
      const track = s.project.tracks.find((candidate) => candidate.type === 'video' && candidate.order === 0);
      const assetA = s.assets.find((asset) => asset.name === 'a.png');
      const assetB = s.assets.find((asset) => asset.name === 'b.png');
      const first = window.__scfStore.getState().addAssetToTimeline(assetA, track.id, 0);
      window.__scfStore.getState().updateClip(first, { durationFrames: 60 });
      const second = window.__scfStore.getState().addAssetToTimeline(assetB, track.id, 60);
      window.__scfStore.getState().updateClip(second, { durationFrames: 60 });
      window.__scfStore.getState().addTransitions('crossDissolve', [{ fromId: first, toId: second }]);
      const transition = Object.values(window.__scfStore.getState().project.transitions ?? {})[0];
      // Pin a transition's progress from the harness: wrap drawList, in this page only.
      const Compositor = window.__scfRenderer().compositor.constructor;
      if (!Compositor.__fxWrapped) {
        const original = Compositor.drawList;
        Compositor.drawList = (...args) =>
          original(...args).map((entry) => (entry.kind === 'transition' && typeof window.__fxProgress === 'number' ? { ...entry, progress: window.__fxProgress } : entry));
        Compositor.__fxWrapped = true;
      }
      return { first, second, transition: transition?.id };
    }, [W, H]);
    check('two clips and a transition on the cut to work with', Boolean(ids.first && ids.second && ids.transition));

    /** Render `frame` and keep its pixels in the page under `name`; returns its mean luma. */
    const render = (frame, name, progress = null) =>
      window.evaluate(
        async ([at, key, pinned]) => {
          window.__fxProgress = pinned ?? undefined;
          const renderer = window.__scfRenderer();
          const { project } = window.__scfStore.getState();
          renderer.beginExclusive();
          try {
            const rgba = await renderer.renderExact(project, at, false);
            window.__fxPixels ??= {};
            window.__fxPixels[key] = rgba;
            let sum = 0;
            for (let i = 0; i < rgba.length; i += 4) sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
            return sum / (rgba.length / 4);
          } finally {
            renderer.endExclusive();
            window.__fxProgress = undefined;
          }
        },
        [frame, name, progress],
      );
    /** Mean absolute difference, in levels of 255 over RGB, between two kept renders. */
    const diff = (one, two) =>
      window.evaluate(
        ([x, y]) => {
          const p = window.__fxPixels[x];
          const q = window.__fxPixels[y];
          let sum = 0;
          for (let i = 0; i < p.length; i += 4) sum += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
          return sum / ((p.length / 4) * 3);
        },
        [one, two],
      );
    const savePng = async (key, file) => {
      if (!shotsDir) return;
      const base64 = await window.evaluate(([name, w, h]) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext('2d');
        context.putImageData(new ImageData(new Uint8ClampedArray(window.__fxPixels[name]), w, h), 0, 0);
        return canvas.toDataURL('image/png').split(',')[1];
      }, [key, W, H]);
      await writeFile(join(shotsDir, file), Buffer.from(base64, 'base64'));
    };

    console.log('1. the two pictures');
    const lumaA = await render(20, 'A');
    const lumaB = await render(100, 'B');
    const ab = await diff('A', 'B');
    check('A and B are different pictures, neither black', lumaA > 20 && lumaB > 5 && ab > 20, `luma ${lumaA.toFixed(1)} / ${lumaB.toFixed(1)}, differ by ${ab.toFixed(1)}`);

    console.log(`2. ${shaderIds.length} shader transitions`);
    const transitionReport = [];
    for (const { id, category } of shaderIds) {
      const errorsBefore = consoleErrors.length;
      await window.evaluate(([transitionId, shader]) => window.__scfStore.getState().updateTransition(transitionId, { kind: 'shader', shader, params: undefined }), [ids.transition, id]);
      const kind = await window.evaluate((transitionId) => window.__scfStore.getState().project.transitions[transitionId].kind, ids.transition);
      await render(60, 't0', 0);
      await render(60, 't1', 1);
      const still = stills[id] ?? 0.5;
      const lumaMid = await render(60, 'tm', still);
      const atStart = await diff('t0', 'A');
      const atEnd = await diff('t1', 'B');
      const midFromA = await diff('tm', 'A');
      const midFromB = await diff('tm', 'B');
      const compiled = consoleErrors.length === errorsBefore;
      const ok = kind === 'shader' && compiled && atStart < 3 && atEnd < 3 && lumaMid > 3 && midFromA > 2 && midFromB > 2;
      transitionReport.push({ id, category, atStart, atEnd, midFromA, midFromB, lumaMid, compiled });
      check(
        `${id}: compiles, starts on A, ends on B, and is between them at ${still}`,
        ok,
        `${compiled ? '' : 'COMPILE ERROR '}p0 vs A ${atStart.toFixed(2)}, p1 vs B ${atEnd.toFixed(2)}, mid vs A ${midFromA.toFixed(1)} vs B ${midFromB.toFixed(1)}, luma ${lumaMid.toFixed(1)}`,
      );
      await savePng('tm', `transition-${id}.png`);
      if (!compiled) console.log(consoleErrors.slice(errorsBefore).join('\n').slice(0, 1500));
    }

    console.log(`3. ${effectTypes.length} effects`);
    await window.evaluate((transitionId) => window.__scfStore.getState().removeTransition(transitionId), ids.transition);
    await render(20, 'plain');
    // Adjustments start neutral, as Premiere's and Resolve's do: at their
    // defaults they must change nothing, and are tried with these instead.
    const NEUTRAL = { brightnessContrast: { brightness: 0.2, contrast: 0.3 }, hueSaturation: { hue: 0.3, saturation: 0.4 } };
    for (const type of Object.keys(NEUTRAL)) {
      await window.evaluate(([clipId, effectType]) => window.__scfStore.getState().updateClip(clipId, { effects: [{ id: 'fx-test', type: effectType, enabled: true, params: {} }] }), [ids.first, type]);
      await render(20, 'neutral');
      const neutral = await diff('neutral', 'plain');
      check(`${type} at its defaults changes nothing`, neutral < 0.01, neutral.toFixed(3));
    }
    for (const type of effectTypes) {
      const errorsBefore = consoleErrors.length;
      // At its defaults: a setting that is not stored draws at its default.
      await window.evaluate(([clipId, effectType, params]) => window.__scfStore.getState().updateClip(clipId, { effects: [{ id: 'fx-test', type: effectType, enabled: true, params }] }), [ids.first, type, NEUTRAL[type] ?? {}]);
      const luma = await render(20, 'fx');
      const changed = await diff('fx', 'plain');
      await window.evaluate((clipId) => {
        const clip = window.__scfStore.getState().project.clips[clipId];
        window.__scfStore.getState().updateClip(clipId, { effects: clip.effects.map((effect) => ({ ...effect, enabled: false })) });
      }, ids.first);
      await render(20, 'off');
      const off = await diff('off', 'plain');
      const compiled = consoleErrors.length === errorsBefore;
      check(`${type}: compiles, draws, changes the picture, and does nothing when off`, compiled && luma > 3 && changed > 1 && off === 0,
        `${compiled ? '' : 'COMPILE ERROR '}luma ${luma.toFixed(1)}, differs by ${changed.toFixed(2)}, off differs by ${off.toFixed(3)}`);
      if (shotsDir) {
        await window.evaluate(([clipId]) => {
          const clip = window.__scfStore.getState().project.clips[clipId];
          window.__scfStore.getState().updateClip(clipId, { effects: clip.effects.map((effect) => ({ ...effect, enabled: true })) });
        }, [ids.first]);
        await render(20, 'fx');
        await savePng('fx', `effect-${type}.png`);
      }
      if (!compiled) console.log(consoleErrors.slice(errorsBefore).join('\n').slice(0, 1500));
    }
    await writeFile(join(workDir, 'report.json'), JSON.stringify({ transitionReport }, null, 2));
  } finally {
    await app.close().catch(() => undefined);
  }
  const unrelated = consoleErrors.filter((text) => !/transition|effect/i.test(text));
  if (unrelated.length) console.log(`   (console errors: ${unrelated.slice(0, 5).join(' | ')})`);
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  if (failures.length) console.log(`failed: ${failures.join(', ')}`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
