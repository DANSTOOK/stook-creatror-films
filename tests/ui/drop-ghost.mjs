import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * A clip dragged out of the media panel, as CapCut's: `node tests/ui/drop-ghost.mjs`
 *
 *   1. what follows the pointer is a card of its own - the clip's picture,
 *      length and name, edged in the accent - not a copy of the tile;
 *   2. over the timeline, the clip is drawn where the drop will put it: into
 *      a clip's first half it goes before that clip, on an empty track at the
 *      frame under the pointer; the drop puts it exactly there, and leaving
 *      the timeline takes the drawing away;
 *   3. the empty timeline's hint steps aside while a clip is carried;
 *   4. dropped, it lands with a small bounce - and without one when less
 *      motion is asked for;
 *   5. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'drop-ghost');
const logs = join(work, 'logs');
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
  const make = (name, source) => {
    const file = join(work, name);
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', source, '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
    return file;
  };
  const files = [make('first.mp4', 'testsrc2=s=640x360:r=30'), make('second.mp4', 'mandelbrot=s=640x360:r=30'), make('third.mp4', 'testsrc=s=640x360:r=30')];
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_BACKGROUND: '1', SCF_NO_CLOSE_PROMPT: '1', SCF_LOG_DIR: logs },
  });
  const pid = app.process().pid;
  const issues = [];
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (error) => issues.push(`pageerror ${error.message}`));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 3 && window.__scfStore.getState().assets.every((asset) => asset.thumbnailUri), null, { timeout: 60_000 });
    await sleep(800);

    // Every drag image the page sets, read the instant it is set (it is gone a tick later).
    await window.evaluate(() => {
      window.__dragImages = [];
      const original = DataTransfer.prototype.setDragImage;
      DataTransfer.prototype.setDragImage = function setDragImage(element, x, y) {
        const record = { tag: element.tagName, inPage: element.isConnected, cssWidth: element.style.width, cssHeight: element.style.height, x, y };
        if (element instanceof HTMLCanvasElement) {
          const context = element.getContext('2d');
          const at = (fx, fy) => [...context.getImageData(Math.round(element.width * fx), Math.round(element.height * fy), 1, 1).data];
          record.edge = at(0.004, 0.5);
          record.picture = at(0.5, 0.4);
          record.strip = at(0.9, 0.9);
        }
        window.__dragImages.push(record);
        return original.call(this, element, x, y);
      };
    });

    const ids = await window.evaluate(() => Object.fromEntries(window.__scfStore.getState().assets.map((asset) => [asset.name, asset.id])));
    const rows = await window.evaluate(() => {
      const { tracks } = window.__scfStore.getState().project;
      const v1 = tracks.find((t) => t.type === 'video' && t.order === 0).id;
      return { v1, v2: tracks.find((t) => t.type === 'video' && t.id !== v1)?.id ?? null };
    });

    /** Picks a tile up (dragstart), then holds it over (frame, track) on the timeline - and drops it there if asked. */
    const carry = (name, frame, trackId, { drop = false, end = false } = {}) => window.evaluate(([wanted, f, track, finish, release]) => {
      const tile = [...document.querySelectorAll('[data-testid="media-panel"] li[role="option"]')].find((li) => li.textContent.includes(wanted));
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      const target = canvas.parentElement.parentElement;
      const bounds = target.getBoundingClientRect();
      window.__carry ??= new DataTransfer();
      const dataTransfer = window.__carry;
      if (!window.__carrying) {
        tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
        window.__carrying = true;
      }
      if (track) {
        const row = window.__scfTimelineRow(track);
        const init = { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.left + f * window.__scfStore.getState().ui.pixelsPerFrame, clientY: bounds.top + row.top + row.height / 2 };
        target.dispatchEvent(new DragEvent('dragenter', init));
        target.dispatchEvent(new DragEvent('dragover', init));
        if (finish) target.dispatchEvent(new DragEvent('drop', init));
      }
      if (release) {
        tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
        window.__carrying = false;
        window.__carry = null;
      }
    }, [name, frame, trackId, drop, end]);
    const leave = () => window.evaluate(() => {
      const target = document.querySelector('[data-testid="timeline-canvas"]').parentElement.parentElement;
      target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }));
    });
    /** The timeline canvas's colour at (frame, track), a little below the row's middle (clear of names). */
    const colourAt = (frame, trackId) => window.evaluate(([f, track]) => {
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      const scale = canvas.width / canvas.clientWidth;
      const row = window.__scfTimelineRow(track);
      const x = Math.round((f * window.__scfStore.getState().ui.pixelsPerFrame - window.__scfStore.getState().ui.scrollLeftPx) * scale);
      const y = Math.round((row.top + row.height * 0.72) * scale);
      return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)];
    }, [frame, trackId]);
    // The drawing is the accent at 32% over what is under it: exactly that blend, give or take rounding.
    const accent = await window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().split(/\s+/).map(Number));
    const lit = (plain, drawn) => drawn.every((value, index) => Math.abs(value - (plain[index] * 0.68 + accent[index] * 0.32)) <= 6);
    const same = (a, b) => a.every((value, index) => Math.abs(value - b[index]) <= 6);
    const clipsOn = (trackId) => window.evaluate((track) => Object.values(window.__scfStore.getState().project.clips)
      .filter((clip) => clip.trackId === track).sort((a, b) => a.startFrame - b.startFrame).map((clip) => ({ name: clip.name, start: clip.startFrame, end: clip.startFrame + clip.durationFrames })), trackId);

    /* 3. the empty timeline's hint steps aside ------------------------------------------------- */
    const hintBefore = await window.getByTestId('timeline-empty').isVisible().catch(() => false);
    await carry('second.mp4', 0, null);
    await sleep(200);
    const hintDuring = await window.getByTestId('timeline-empty').isVisible().catch(() => false);
    await carry('second.mp4', 0, null, { end: true });
    await sleep(200);
    const hintAfter = await window.getByTestId('timeline-empty').isVisible().catch(() => false);
    check('the empty timeline\'s hint steps aside while a clip is carried, and comes back', hintBefore && !hintDuring && hintAfter, `${hintBefore} ${hintDuring} ${hintAfter}`);

    /* 1. the card that follows the pointer ---------------------------------------------------------- */
    const image = await window.evaluate(() => window.__dragImages.at(-1) ?? null);
    const leftover = await window.evaluate(() => [...document.querySelectorAll('canvas')].filter((canvas) => canvas.style.left === '-1000px').length);
    check('what follows the pointer is a card of its own, in the page for that instant and gone after',
      image?.tag === 'CANVAS' && image.inPage && image.cssWidth === '144px' && image.cssHeight === '103px' && leftover === 0,
      JSON.stringify({ tag: image?.tag, inPage: image?.inPage, size: `${image?.cssWidth}x${image?.cssHeight}`, leftover }));
    check('with the clip\'s picture, a strip for its name, and the accent\'s edge',
      image && same(image.edge.slice(0, 3), accent) && image.picture.slice(0, 3).some((value) => value > 60) && image.strip[0] < 40,
      JSON.stringify({ edge: image?.edge, picture: image?.picture, strip: image?.strip }));

    /* 2. where it will land ----------------------------------------------------------------- */
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.addAssetToTimeline(s.assets.find((asset) => asset.name === 'first.mp4'), s.project.tracks.find((t) => t.type === 'video' && t.order === 0).id, 0);
      s.selectClips([]);
    });
    await sleep(500);
    const first = (await clipsOn(rows.v1))[0];
    // Into the first clip's first half: it will go before it, and push it along.
    const plainOnClip = await colourAt(first.end - 20, rows.v1);
    await carry('second.mp4', 60, rows.v1);
    await sleep(250);
    const ghostOnClip = await colourAt(first.end - 20, rows.v1);
    await leave();
    await sleep(250);
    const afterLeave = await colourAt(first.end - 20, rows.v1);
    check('held over a clip\'s first half, it is drawn over that clip, where the drop will put it',
      !same(plainOnClip, ghostOnClip) && lit(plainOnClip, ghostOnClip), `${plainOnClip} -> ${ghostOnClip}, accent ${accent}`);
    check('leaving the timeline takes the drawing away', same(afterLeave, plainOnClip), `${afterLeave} vs ${plainOnClip}`);

    // On the empty track above, at the frame under the pointer: drawn there and only there.
    const emptyTrack = rows.v2;
    const plainEmpty = await colourAt(first.end + 90, emptyTrack);
    await carry('second.mp4', first.end + 30, emptyTrack);
    await sleep(250);
    const ghostEmpty = await colourAt(first.end + 90, emptyTrack);
    const beforeGhost = await colourAt(first.end + 10, emptyTrack);
    check('held over an empty track, it is drawn from the frame under the pointer, and not before it',
      lit(plainEmpty, ghostEmpty) && !same(ghostEmpty, plainEmpty) && same(beforeGhost, plainEmpty), `${plainEmpty} -> ${ghostEmpty}; before it ${beforeGhost}`);
    await leave();

    await carry('second.mp4', 60, rows.v1, { drop: true, end: true });
    await sleep(150);
    const landingEarly = await window.evaluate(() => document.querySelector('[data-testid="timeline-canvas"]').dataset.landing);
    const onMain = await clipsOn(rows.v1);
    check('dropped there, it is where it was drawn: before the clip, which moved along',
      onMain.length === 2 && onMain[0].name === 'second.mp4' && onMain[0].start === 0 && onMain[1].name === 'first.mp4' && onMain[1].start === onMain[0].end,
      JSON.stringify(onMain));

    /* 4. the landing ---------------------------------------------------------------------------- */
    await sleep(700);
    const landingLate = await window.evaluate(() => document.querySelector('[data-testid="timeline-canvas"]').dataset.landing);
    check('it lands with a small bounce, over in half a second', landingEarly === 'on' && landingLate === 'off', `${landingEarly} then ${landingLate}`);

    await window.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    const end = (await clipsOn(rows.v1)).at(-1).end;
    await carry('third.mp4', end + 10, rows.v1, { drop: true, end: true });
    const seen = new Set();
    for (let sample = 0; sample < 8; sample += 1) {
      seen.add(await window.evaluate(() => document.querySelector('[data-testid="timeline-canvas"]').dataset.landing));
      await sleep(60);
    }
    await window.evaluate(() => document.documentElement.setAttribute('data-motion', 'full'));
    const third = (await clipsOn(rows.v1)).find((clip) => clip.name === 'third.mp4');
    check('with less motion asked for, it is simply there', third !== undefined && !seen.has('on'), `${[...seen].join(',')}; ${JSON.stringify(third)}`);

    check('no errors on the page', issues.length === 0, issues.slice(0, 3).join(' | '));
  } finally {
    await app.close().catch(() => undefined);
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  const errors = existsSync(logs)
    ? readdirSync(logs).flatMap((name) => readFileSync(join(logs, name), 'utf8').split('\n')).filter((line) => / ERROR /.test(line))
    : [];
  check('nothing in the app\'s log', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300));
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
