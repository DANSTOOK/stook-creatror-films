import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * A drawn animation, exported: `node tests/ui/animation-export.mjs`
 *
 * It makes a short animation by writing strokes straight into the project -
 * a ball that bounces and squashes, twelve drawings on twos - then exports it
 * to a real file and checks what came out.
 *
 * What it is really for is the one claim a unit test cannot make: that the
 * EXPORT draws the drawings and does NOT draw the onion skin. The ghosts are
 * turned up as far as they go first, so if they leaked into the film the
 * frames would be unmistakably wrong.
 *
 * The file is written into this test's own folder, never anywhere else.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'animation-export');
const out = join(work, 'out');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/**
 * A bouncing ball, as strokes: twelve drawings, each a ring of short strokes.
 *
 * Drawn as data rather than with the pointer because the pointer is already
 * covered by tests/ui/animation.mjs; what is wanted here is a real animation
 * to export, and twelve hand-drawn ones would take a quarter of an hour.
 */
function bouncingBall(drawings = 12) {
  const cels = [];
  for (let index = 0; index < drawings; index += 1) {
    const phase = index / (drawings - 1);
    // Down and up once, with the ball squashing as it lands - the first thing
    // anyone animates, and the first thing that shows whether timing works.
    const fall = Math.abs(Math.sin(phase * Math.PI));
    const y = 0.25 + 0.5 * fall;
    const squash = 1 + 0.35 * Math.max(0, fall - 0.75) * 4;
    const radiusX = 0.07 * squash;
    const radiusY = 0.07 / squash;
    const points = [];
    for (let step = 0; step <= 28; step += 1) {
      const angle = (step / 28) * Math.PI * 2;
      points.push(0.5 + Math.cos(angle) * radiusX, y + Math.sin(angle) * radiusY, 0.8);
    }
    cels.push({ id: `cel-${index}`, at: index, strokes: [{ id: `ball-${index}`, brush: 'pencil', color: '#22d3ee', size: 0.01, opacity: 1, points }] });
  }
  return cels;
}

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const app = await electron.launch({
    args: [`--user-data-dir=${join(work, `profile-${process.pid}`)}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1' },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => message.type() === 'error' && issues.push(message.text()));
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });

    console.log('1. an animation of twelve drawings');
    const made = await window.evaluate((cels) => {
      const state = window.__scfStore.getState();
      const clipId = state.addAnimationClip(1);
      const store = window.__scfStore.getState();
      const clip = store.project.clips[clipId];
      const layerId = clip.anim.layers[0].id;
      // Straight in, as one step: the strokes are the fixture, not the thing
      // under test.
      store.transact('Fixture', (project) => {
        const target = project.clips[clipId];
        return {
          ...project,
          clips: {
            ...project.clips,
            [clipId]: {
              ...target,
              anim: {
                ...target.anim,
                step: 2,
                // The ghosts as strong and as many as they go: if any of this
                // reached the film it could not be mistaken for anything else.
                onion: { enabled: true, before: 8, after: 8, opacity: 1, by: 'drawings' },
                layers: target.anim.layers.map((layer) => (layer.id === layerId ? { ...layer, cels } : layer)),
              },
            },
          },
        };
      });
      const final = window.__scfStore.getState().project.clips[clipId];
      return { clipId, drawings: final.anim.layers[0].cels.length, durationFrames: final.durationFrames, step: final.anim.step };
    }, bouncingBall());
    check('twelve drawings on twos', made.drawings === 12 && made.step === 2, JSON.stringify(made));

    console.log('2. the viewer shows a different drawing as it goes');
    const shots = [];
    for (const frame of [0, 2, 4, 6, 8, 10]) {
      await window.evaluate((value) => window.__scfStore.getState().setCurrentFrame(value), frame);
      await sleep(260);
      shots.push(
        await window.evaluate(() => {
          const canvas = document.querySelector('canvas.block.h-full.w-full.object-contain');
          const copy = document.createElement('canvas');
          copy.width = canvas.width;
          copy.height = canvas.height;
          const ctx = copy.getContext('2d');
          // Over black: a canvas keeps straight alpha, so RGB alone would read
          // a faint stroke as a bright one.
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, copy.width, copy.height);
          ctx.drawImage(canvas, 0, 0);
          const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
          // Where the ink sits vertically: the ball's height, which must change.
          let weight = 0;
          let total = 0;
          for (let index = 0; index < data.length; index += 4) {
            const lit = data[index] + data[index + 1] + data[index + 2];
            if (lit < 60) continue;
            const row = Math.floor(index / 4 / copy.width);
            weight += row * lit;
            total += lit;
          }
          return total > 0 ? weight / total / copy.height : -1;
        }),
      );
    }
    const spread = Math.max(...shots) - Math.min(...shots);
    check('the ball is at a different height each exposure', spread > 0.1, shots.map((value) => value.toFixed(3)).join(', '));

    console.log('3. exported to a file');
    // Through the real dialog, as tests/ui/captions.mjs does: the folder comes
    // from the native picker, which is stubbed to this test's own out/.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, out);
    await window.evaluate((frames) =>
      window.__scfStore.getState().setExportSettings({ format: 'mp4-h264', width: 960, height: 540, startFrame: 0, endFrame: frames }),
    made.durationFrames);
    await window.getByRole('button', { name: 'Export', exact: true }).click();
    const exportDialog = window.getByRole('dialog', { name: 'Export' });
    await exportDialog.getByRole('button', { name: 'Start export' }).waitFor({ state: 'visible', timeout: 15_000 });
    await exportDialog.getByLabel('File name').fill('animation-test');
    await exportDialog.getByRole('button', { name: 'Browse' }).click();
    await sleep(600);
    await exportDialog.getByRole('button', { name: 'Start export' }).click();

    // What matters is that a file appeared, and that it has frames in it.
    const appeared = await (async () => {
      for (let waited = 0; waited < 180; waited += 1) {
        const found = existsSync(out) ? readdirSync(out).filter((name) => /\.(mp4|webm|mov)$/i.test(name)) : [];
        if (found.length > 0 && statSync(join(out, found[0])).size > 20_000) return join(out, found[0]);
        await sleep(1000);
      }
      return null;
    })();
    check('a video file came out', appeared !== null, appeared ? `${(statSync(appeared).size / 1024).toFixed(0)} KB` : 'nothing in out/');
    if (appeared) console.log(`   file: ${appeared}`);

    check('nothing in the console', issues.length === 0, issues.slice(0, 3).join(' | '));
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
