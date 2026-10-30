import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Reaching every track when there are more of them than fit:
 * `node tests/ui/timeline-scroll.mjs`
 *
 * Reported: "adding more audio or video tracks, the timeline will not scroll
 * up or down and you cannot interact". So, with a docked timeline and far
 * more tracks than its height holds:
 *
 *   1. the timeline knows it has more rows than room (its scroll height is
 *      past its visible height);
 *   2. the wheel scrolls it - over the track headers AND over the clips,
 *      which is where the hand usually is;
 *   3. scrolled to the bottom, the last track's header is on screen, its row
 *      is drawn where the canvas says it is, and a clip on it can be clicked;
 *   4. the ruler stays put at the top, so the time is always readable;
 *   5. nothing in the page's errors or the app's log.
 *
 * Writes only into its own work folder. Needs a build (npm run build). The window is never shown.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'timeline-scroll');
const logs = join(work, 'logs');
const shots = process.env.SCROLL_SHOTS ?? '';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(Boolean(passed));
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
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
    // A normal editor window: the timeline is docked at the bottom, a few hundred pixels tall.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await window.getByRole('button', { name: 'Blank project' }).click({ force: true, timeout: 30_000 });
    await window.waitForSelector('[data-testid="preview-panel"]', { timeout: 30_000 });
    const store = (fn, arg) => window.evaluate(fn, arg);

    /* Far more tracks than the docked timeline can show ------------------------------------------ */
    await store(() => {
      const s = window.__scfStore.getState();
      for (let index = 0; index < 6; index += 1) s.addTrack('video');
      for (let index = 0; index < 8; index += 1) s.addTrack('audio');
    });
    // The rows are laid out while the timeline draws, so they are read after it has.
    await sleep(800);
    const made = await store(() => {
      const state = window.__scfStore.getState();
      // The bottom-most row as the timeline lays them out, and the lowest picture track (a title needs one).
      const rows = state.project.tracks
        .map((track) => ({ track, row: window.__scfTimelineRow(track.id) }))
        .filter((entry) => entry.row)
        .sort((a, b) => a.row.top - b.row.top);
      const last = rows[rows.length - 1];
      const video = rows.filter((entry) => entry.track.type === 'video').pop();
      return {
        tracks: state.project.tracks.length,
        rows: rows.length,
        lastId: last.track.id,
        lastName: last.track.name,
        lastType: last.track.type,
        videoId: video?.track.id ?? last.track.id,
      };
    });

    /** The timeline's scrolling box, and where it stands. */
    const body = () => window.evaluate(() => {
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      let element = canvas?.parentElement ?? null;
      while (element && !(element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY))) {
        element = element.parentElement;
      }
      // None found: report the nearest box that holds the rows, so the detail says what is there.
      const fallback = document.querySelector('[data-testid="timeline-canvas"]')?.closest('section');
      const box = element ?? fallback;
      return box
        ? { found: element !== null, top: box.scrollTop, height: box.clientHeight, scrollHeight: box.scrollHeight, overflowY: getComputedStyle(box).overflowY }
        : null;
    });
    const scrollTo = (top) => window.evaluate((value) => {
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      let element = canvas?.parentElement ?? null;
      while (element && !(element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY))) {
        element = element.parentElement;
      }
      if (element) element.scrollTop = value;
      return element ? element.scrollTop : null;
    }, top);

    const at = await body();
    check(`${made.tracks} tracks (${made.rows} rows) in a docked timeline: it knows it has more rows than room`,
      at !== null && at.found && at.scrollHeight > at.height + 20, JSON.stringify(at));

    /* The wheel, where the hand is ----------------------------------------------------------------- */
    const canvasBox = await window.getByTestId('timeline-canvas').boundingBox();
    const headerBox = await window.getByTestId(`track-header-${made.lastId}`).boundingBox().catch(() => null);
    await scrollTo(0);
    await window.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    for (let turn = 0; turn < 5; turn += 1) {
      await window.mouse.wheel(0, 120);
      await sleep(60);
    }
    await sleep(250);
    const overClips = await body();
    check('the wheel over the clips scrolls the timeline down', overClips !== null && overClips.top > 10, `scrollTop ${overClips?.top}`);

    await scrollTo(0);
    await sleep(200);
    const headers = await window.evaluate(() => {
      const header = document.querySelector('[data-testid^="track-header-"]');
      const box = header?.getBoundingClientRect();
      if (!box) return null;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const under = document.elementFromPoint(x, y);
      return { x, y, under: under ? `${under.tagName.toLowerCase()}${under.dataset?.testid ? `[${under.dataset.testid}]` : ''}` : 'nothing' };
    });
    if (headers) {
      await window.mouse.move(headers.x, headers.y);
      for (let turn = 0; turn < 5; turn += 1) {
        await window.mouse.wheel(0, 120);
        await sleep(60);
      }
    }
    await sleep(250);
    const overHeaders = await body();
    check('and the wheel over the track headers scrolls it too', overHeaders !== null && overHeaders.top > 10,
      `scrollTop ${overHeaders?.top}; pointed at ${headers ? `${headers.under} (${Math.round(headers.x)}, ${Math.round(headers.y)})` : 'no header'}`);

    /* The last track, reached ------------------------------------------------------------------------ */
    await scrollTo(100000);
    await sleep(400);
    const bottom = await body();
    const lastHeader = await window.getByTestId(`track-header-${made.lastId}`).boundingBox().catch(() => null);
    const bodyBox = await window.evaluate(() => {
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      let element = canvas?.parentElement ?? null;
      while (element && !(element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY))) {
        element = element.parentElement;
      }
      const box = element?.getBoundingClientRect();
      return box ? { top: box.top, bottom: box.bottom } : null;
    });
    if (shots) await window.locator('section:has([data-testid="timeline-canvas"])').screenshot({ path: join(shots, 'timeline-abajo.png') });
    check('scrolled to the bottom, the last track’s header is on screen',
      lastHeader !== null && bodyBox !== null && lastHeader.y >= bodyBox.top - 1 && lastHeader.y + lastHeader.height <= bodyBox.bottom + 1,
      `${made.lastName}: ${lastHeader ? `${Math.round(lastHeader.y)}-${Math.round(lastHeader.y + lastHeader.height)}` : 'nowhere'} in ${bodyBox ? `${Math.round(bodyBox.top)}-${Math.round(bodyBox.bottom)}` : '?'}`);

    // The row the canvas draws for that track must line up with its header: the
    // canvas is in the same scrolling box, so both move together.
    const rowAgainstHeader = await window.evaluate((trackId) => {
      const row = window.__scfTimelineRow(trackId);
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      const header = document.querySelector(`[data-testid="track-header-${trackId}"]`);
      if (!row || !canvas || !header) return null;
      const canvasBox = canvas.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      // Where the canvas draws the row's middle, on screen, against the header's middle.
      return { drawn: canvasBox.top + row.top + row.height / 2, header: headerBox.top + headerBox.height / 2 };
    }, made.lastId);
    check('and the canvas draws its row beside that header, not somewhere else',
      rowAgainstHeader !== null && Math.abs(rowAgainstHeader.drawn - rowAgainstHeader.header) <= 4,
      rowAgainstHeader ? `${Math.round(rowAgainstHeader.drawn)} vs ${Math.round(rowAgainstHeader.header)}` : 'no row');

    /* A clip down there can be clicked ----------------------------------------------------------- */
    // A clip of the app's own making, on the lowest picture track: no file to import.
    const clipId = await store((trackId) => window.__scfStore.getState().addTitle('title', { trackId, startFrame: 0 }) ?? null, made.videoId);
    if (clipId) {
      await sleep(300);
      // Bring its row into view the way a hand would, then click it there.
      const needed = await window.evaluate((id) => {
        const state = window.__scfStore.getState();
        const row = window.__scfTimelineRow(state.project.clips[id].trackId);
        const canvas = document.querySelector('[data-testid="timeline-canvas"]');
        const height = canvas.getBoundingClientRect().height;
        // Its top is where the canvas draws it now: off the top, or past the bottom.
        if (row.top < 24) return row.top - 24;
        if (row.top + row.height > height) return row.top + row.height - height;
        return 0;
      }, clipId);
      if (needed !== 0) {
        await scrollTo((await body()).top + needed);
        await sleep(300);
      }
      const spot = await window.evaluate((id) => {
        const state = window.__scfStore.getState();
        const clip = state.project.clips[id];
        const row = window.__scfTimelineRow(clip.trackId);
        const canvas = document.querySelector('[data-testid="timeline-canvas"]').getBoundingClientRect();
        const x = (clip.startFrame + clip.durationFrames / 2) * state.ui.pixelsPerFrame - state.ui.scrollLeftPx;
        return { x: canvas.x + x, y: canvas.top + row.top + row.height / 2 };
      }, clipId);
      await window.mouse.click(spot.x, spot.y);
      await sleep(250);
      const selected = await store(() => window.__scfStore.getState().ui.selectedClipIds);
      check('a clip on the last track can be clicked down there', selected.includes(clipId), `${selected.length} selected`);
    } else {
      check('a clip on the last track can be clicked down there', false, 'no clip could be made for the check');
    }

    /* A clip selected out of sight is brought into view -------------------------------------------- */
    if (clipId) {
      // Back to the top, where the clip on the last track cannot be seen, and
      // then selected without the timeline being touched - as happens when a
      // clip is picked from the viewer or stepped to with the keyboard.
      await scrollTo(0);
      await store((id) => window.__scfStore.getState().selectClips([]), clipId);
      await sleep(200);
      const before = (await body()).top;
      await store((id) => window.__scfStore.getState().selectClips([id]), clipId);
      await sleep(400);
      const after = (await body()).top;
      const visible = await store((id) => {
        const state = window.__scfStore.getState();
        const clip = state.project.clips[id];
        const row = window.__scfTimelineRow(clip.trackId);
        const canvas = document.querySelector('[data-testid="timeline-canvas"]').getBoundingClientRect();
        // Where the row is drawn in the canvas. On screen means wholly below
        // the ruler - a row scrolled to behind it cannot be clicked.
        const ruler = 24; // RULER_HEIGHT
        return { top: row.top, height: row.height, canvasHeight: canvas.height, onScreen: row.top >= ruler && row.top + row.height <= canvas.height + 1 };
      }, clipId);
      check('a clip selected while out of sight brings its track into view',
        before === 0 && after > 10 && visible.onScreen,
        `scrollTop ${before} -> ${after}; the row is now at ${Math.round(visible.top)} of ${Math.round(visible.canvasHeight)}`);

      // And a clip already in view does not move the timeline at all.
      const held = (await body()).top;
      await store((id) => {
        window.__scfStore.getState().selectClips([]);
        window.__scfStore.getState().selectClips([id]);
      }, clipId);
      await sleep(350);
      check('a clip already in view is left exactly where it is', (await body()).top === held, `scrollTop stayed at ${held}`);
    } else {
      check('a clip selected while out of sight brings its track into view', false, 'no clip could be made for the check');
      check('a clip already in view is left exactly where it is', false, 'no clip could be made for the check');
    }

    /* A track added above is not born behind the ruler --------------------------------------------- */
    // A captions track goes ABOVE the others, so on a timeline already
    // scrolled its row used to be drawn under the ruler: it held its clips and
    // could not be clicked.
    await scrollTo(100000);
    const scrolled = (await body()).top;
    const born = await store(() => {
      const id = window.__scfStore.getState().addCaptionTrack(
        { subtitles: [{ startMs: 0, endMs: 1500, text: 'Una frase.' }] },
        { preset: 'classic', language: 'es' },
      );
      return id;
    });
    await sleep(500);
    const bornRow = await store((trackId) => {
      const row = window.__scfTimelineRow(trackId);
      const canvas = document.querySelector('[data-testid="timeline-canvas"]').getBoundingClientRect();
      const ruler = 24; // RULER_HEIGHT
      return row ? { top: row.top, height: row.height, canvasHeight: canvas.height, clear: row.top >= ruler && row.top + row.height <= canvas.height + 1 } : null;
    }, born);
    check('a track added above, on a scrolled timeline, is brought into view instead of hiding behind the ruler',
      bornRow !== null && bornRow.clear,
      `was at scrollTop ${scrolled}; the new row is drawn at ${bornRow ? Math.round(bornRow.top) : 'nowhere'} of ${bornRow ? Math.round(bornRow.canvasHeight) : '?'}`);

    /* The ruler stays readable ------------------------------------------------------------------------ */
    // Scrolled again: revealing the new track above took the view to the top.
    await scrollTo(100000);
    await sleep(200);
    const ruler = await window.evaluate(() => {
      const canvas = document.querySelector('[data-testid="timeline-canvas"]');
      let element = canvas?.parentElement ?? null;
      while (element && !(element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY))) {
        element = element.parentElement;
      }
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      // The ruler is the canvas's first RULER_HEIGHT pixels: where is that now?
      return { rulerTop: canvasBox.top, bodyTop: box.top, scrollTop: element.scrollTop };
    });
    check('the ruler stays at the top of the timeline while the rows scroll under it',
      ruler !== null && ruler.scrollTop > 10 && Math.abs(ruler.rulerTop - ruler.bodyTop) <= 2, JSON.stringify(ruler));

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
