import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Stress test for the project system, the start screen, the menus and the motion.
 *
 *   node tests/stress/projects.mjs              (BENCH_SOURCE=<video> for real footage, SKIP_BUILD=1 to reuse dist)
 *
 * Driven through the interface the way an editor uses it all day - dozens of
 * projects created, saved and reopened, the start screen visited again and
 * again, every "save changes?" answer given many times - and checked against
 * the files on disk, not against what the screen says.
 */

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workDir = join(projectRoot, '.stress-tmp', 'projects');
const profileDir = join(workDir, 'profile');
const projectsDir = join(workDir, 'Projects');
const recentFile = join(profileDir, 'scf', 'recent-projects.json');
const thumbnailsDir = join(profileDir, 'scf', 'thumbnails');
const reportFile = join(workDir, 'report.json');

const report = { checks: [], timings: {}, memory: {} };
const checks = report.checks;

function check(name, passed, detail = '') {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const step = (label) => console.log(`\n== ${label}`);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(predicate, timeout = 10_000, interval = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(interval);
  }
}

const readRecent = async () => {
  try {
    return JSON.parse(await readFile(recentFile, 'utf8'));
  } catch {
    return null;
  }
};
const readProject = async (file) => JSON.parse(await readFile(file, 'utf8'));
const trackCountIn = (document) => Object.keys(document.project?.tracks ?? {}).length;
const leftovers = () => readdirSync(projectsDir).filter((name) => /\.saving-/.test(name));

async function prepareSource() {
  if (process.env.BENCH_SOURCE) return process.env.BENCH_SOURCE;
  const file = join(workDir, 'pattern.mp4');
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
  return file;
}

async function averageLuma(file) {
  try {
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
    const match = /YAVG=([\d.]+)/.exec(stderr);
    return match ? Number(match[1]) : -1;
  } catch (error) {
    const match = /YAVG=([\d.]+)/.exec(String(error.stderr ?? ''));
    return match ? Number(match[1]) : -1;
  }
}

async function main() {
  const started = Date.now();
  await rm(workDir, { recursive: true, force: true });
  await mkdir(projectsDir, { recursive: true });
  const source = await prepareSource();
  const sourceName = source.split(/[\\/]/).pop();

  if (!process.env.SKIP_BUILD) {
    step('building');
    await run(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: projectRoot });
  }

  // A damaged list from some earlier crash: the start screen must shrug it off.
  await mkdir(dirname(recentFile), { recursive: true });
  await writeFile(recentFile, '[{"path": "C:\\\\half-written', 'utf8');

  const issues = [];
  const launch = async () => {
    const application = await electron.launch({
      args: ['--js-flags=--expose-gc', `--user-data-dir=${profileDir}`, join(projectRoot, 'dist-electron/main/index.js')],
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: undefined, SCF_SKIP_HOME: undefined, SCF_NO_CLOSE_PROMPT: undefined },
    });
    const page = await application.firstWindow();
    page.on('console', (message) => {
      if (message.type() === 'error') issues.push(`[error] ${message.text()}`);
    });
    page.on('pageerror', (error) => issues.push(`[pageerror] ${error.message}`));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 950));
    await page.waitForSelector('#root > *', { timeout: 30_000 });
    return { application, page };
  };

  let { application: app, page: window } = await launch();

  const home = () => window.getByRole('main', { name: 'Start screen' });
  const onHome = async () => (await home().count()) > 0;
  const projectName = () => window.getByTestId('project-name').innerText();
  const tracks = () => window.evaluate(() => Object.keys(window.__scfStore.getState().project.tracks).length);
  const dirtyShown = () => window.getByTestId('unsaved-indicator').isVisible().catch(() => false);
  const title = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle());
  const pickFolder = (folder) => app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
  const countSaveDialogs = () => app.evaluate(({ dialog }) => {
    globalThis.__saveDialogs = 0;
    dialog.showSaveDialog = async () => {
      globalThis.__saveDialogs += 1;
      return { canceled: true };
    };
  });
  const saveDialogs = () => app.evaluate(() => globalThis.__saveDialogs ?? 0);

  const goHome = async () => {
    await window.getByRole('button', { name: 'Home', exact: true }).click();
    await home().waitFor({ state: 'visible', timeout: 10_000 });
  };
  const openCard = async (name) => {
    await window.getByRole('button', { name: `Open ${name}`, exact: true }).click();
    await home().waitFor({ state: 'detached', timeout: 60_000 });
  };
  const createViaHome = async (name) => {
    await pickFolder(projectsDir);
    await window.getByRole('button', { name: 'Change', exact: true }).click();
    await window.waitForFunction(
      (folder) => document.querySelector('main[aria-label="Start screen"] input[readonly]')?.value === folder,
      projectsDir,
      { timeout: 5_000 },
    );
    await window.getByLabel('Project name').fill(name);
    await window.getByRole('button', { name: 'Create project' }).click();
    await home().waitFor({ state: 'detached', timeout: 10_000 });
    return projectName();
  };
  const save = async () => {
    await window.keyboard.press('Control+s');
    return waitFor(async () => !(await dirtyShown()), 15_000);
  };

  try {
    /* 1. First launch ------------------------------------------------------------------ */
    step('first launch, with a damaged recent-projects file');
    check('the app opens on the start screen', await onHome());
    check('the start screen keeps the plain app title', (await title()) === 'STOOK CREATOR FILMS', await title());
    check('a damaged recent list is shrugged off, not trusted',
      await window.getByText('No recent projects yet').isVisible() && issues.length === 0, issues.join(' | '));

    await countSaveDialogs();

    /* 2. A project with real footage ---------------------------------------------------- */
    step('a project with footage: create, import, place, save with Ctrl+S');
    let t = Date.now();
    const footageName = await createViaHome('Footage project');
    check('Create project names the project and writes its file where asked',
      footageName === 'Footage project' && existsSync(join(projectsDir, 'Footage project.scf')));
    check('the window is titled after the project', (await title()) === 'Footage project - STOOK CREATOR FILMS', await title());

    await pickFolder(source);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, source);
    await window.getByRole('button', { name: 'Import' }).click();
    await window.locator('li').filter({ hasText: sourceName }).first().waitFor({ state: 'visible', timeout: 300_000 });
    await window.evaluate(() => {
      const store = window.__scfStore.getState();
      const asset = store.assets[store.assets.length - 1];
      const length = Math.max(30, Math.min(asset.durationFrames || 300, 900));
      store.placeAssets([asset], [{ assetId: asset.id, trackId: null, trackType: 'video', startFrame: 0, durationFrames: length }]);
      store.setCurrentFrame(Math.floor(length / 3));
    });
    await sleep(1500);
    check('importing and placing footage marks the project unsaved', await dirtyShown());
    const saved = await save();
    const footageDoc = await readProject(join(projectsDir, 'Footage project.scf'));
    check('Ctrl+S saves an existing project straight to its file, no dialog',
      saved && (await saveDialogs()) === 0 && Object.keys(footageDoc.project.clips).length >= 1,
      `${Object.keys(footageDoc.project.clips).length} clip(s) in the file, ${await saveDialogs()} dialogs`);

    const thumbnail = await waitFor(() => {
      const files = existsSync(thumbnailsDir) ? readdirSync(thumbnailsDir) : [];
      return files.length ? join(thumbnailsDir, files[0]) : null;
    }, 30_000);
    const thumbnailBytes = thumbnail ? (await stat(thumbnail)).size : 0;
    const luma = thumbnail ? await averageLuma(thumbnail) : -1;
    check('saving takes a real thumbnail of the edit (not black, not empty)', thumbnailBytes > 2000 && luma > 12,
      `${thumbnailBytes} bytes, average luma ${luma}`);
    report.timings.footageProject = Date.now() - t;

    await goHome();
    const footageCardImage = await window.waitForFunction(() => [...document.querySelectorAll('main[aria-label="Start screen"] li img')]
      .some((image) => image.src.startsWith('media') && image.complete && image.naturalWidth > 0), null, { timeout: 15_000 })
      .then(() => true, () => false);
    check('the start screen shows the project with its thumbnail, "just now"',
      footageCardImage && await window.getByRole('button', { name: 'Open Footage project', exact: true }).isVisible()
      && await window.getByText('just now').first().isVisible());

    /* 3. Twenty-five projects ----------------------------------------------------------- */
    step('25 projects: create, edit, save, back home');
    const cycle = [];
    for (let i = 1; i <= 25; i += 1) {
      const begin = Date.now();
      await createViaHome(`Stress ${pad(i)}`);
      for (let k = 0; k < (i % 3) + 1; k += 1) await window.evaluate(() => window.__scfStore.getState().addTrack('video'));
      await save();
      await goHome();
      cycle.push(Date.now() - begin);
    }
    report.timings.projectCycleMedianMs = median(cycle);
    const recent25 = await readRecent();
    const cards = await window.locator('main[aria-label="Start screen"] ul > li').count();
    check('the recent list keeps the newest 20, newest first',
      recent25?.length === 20 && recent25[0].name === 'Stress 25' && recent25[19].name === 'Stress 06' && cards === 20,
      `${recent25?.length} in the file, ${cards} cards, first ${recent25?.[0]?.name}, last ${recent25?.[19]?.name}`);
    const thumbnailsLeft = existsSync(thumbnailsDir) ? readdirSync(thumbnailsDir).length : 0;
    check('a project that falls off the list takes its thumbnail with it', thumbnailsLeft === 0, `${thumbnailsLeft} thumbnails left`);
    check('all 26 project files are on disk, none half-saved',
      readdirSync(projectsDir).filter((name) => name.endsWith('.scf')).length === 26 && leftovers().length === 0);
    check('a create-edit-save-home cycle stays quick', median(cycle) < 4000, `median ${median(cycle)} ms, worst ${Math.max(...cycle)} ms`);

    /* 4. Names ---------------------------------------------------------------------------- */
    step('names: duplicates and characters Windows refuses');
    const originalBytes = await readFile(join(projectsDir, 'Stress 01.scf'), 'utf8');
    const duplicate = await createViaHome('Stress 01');
    check('a name already used never overwrites that project',
      duplicate === 'Stress 01 (2)' && (await readFile(join(projectsDir, 'Stress 01.scf'), 'utf8')) === originalBytes, duplicate);
    await goHome();
    const cleaned = await createViaHome('Boda: Ana/Luis?');
    check('characters Windows refuses are taken out of the file name',
      cleaned === 'Boda Ana Luis' && existsSync(join(projectsDir, 'Boda Ana Luis.scf')), cleaned);
    await goHome();

    /* 5. The bridge refuses what the list does not hold --------------------------------- */
    step('refusals');
    const refusals = await window.evaluate(async () => {
      const refused = async (call) => call().then(() => false, () => true);
      return {
        openRecent: await refused(() => window.filmora.projectsOpenRecent('C:\\Windows\\win.ini')),
        save: await refused(() => window.filmora.projectsSave('C:\\Windows\\Temp\\scf-must-not-exist.scf', '{}')),
        create: await refused(() => window.filmora.projectsCreate('C:\\Windows\\Temp', 'scf-must-not-exist', '{}')),
      };
    });
    check('the page cannot read, overwrite or create files outside what the user chose',
      refusals.openRecent && refusals.save && refusals.create
      && !existsSync('C:\\Windows\\Temp\\scf-must-not-exist.scf') && !existsSync('C:\\Windows\\Temp\\scf-must-not-exist.scf'),
      JSON.stringify(refusals));

    /* 6. Every answer to "save changes?", many times ------------------------------------ */
    step('unsaved changes: Cancel / Don\'t save / Save, 21 times');
    await openCard('Stress 25');
    const answers = { cancel: 0, discard: 0, save: 0 };
    const wrong = [];
    let undoCleans = null;
    for (let i = 0; i < 21; i += 1) {
      const file = join(projectsDir, 'Stress 25.scf');
      const before = await tracks();
      await window.evaluate(() => window.__scfStore.getState().addTrack('audio'));
      await window.getByRole('button', { name: 'Home', exact: true }).click();
      const prompt = window.getByRole('alertdialog');
      await prompt.waitFor({ state: 'visible', timeout: 5_000 });
      const choice = ['cancel', 'discard', 'save'][i % 3];
      answers[choice] += 1;
      if (choice === 'cancel') {
        await prompt.getByRole('button', { name: 'Cancel' }).click();
        await prompt.waitFor({ state: 'detached', timeout: 5_000 });
        const ok = !(await onHome()) && (await tracks()) === before + 1 && (await dirtyShown());
        if (!ok) wrong.push(`${i} cancel`);
        await window.keyboard.press('Control+z');
        const clean = await waitFor(async () => !(await dirtyShown()), 3_000);
        if (undoCleans === null) undoCleans = clean && (await tracks()) === before;
      } else if (choice === 'discard') {
        await prompt.getByRole('button', { name: "Don't save" }).click();
        await home().waitFor({ state: 'visible', timeout: 5_000 });
        const onDisk = trackCountIn(await readProject(file));
        await openCard('Stress 25');
        if (onDisk !== before || (await tracks()) !== before) wrong.push(`${i} discard: disk ${onDisk}, open ${await tracks()}, expected ${before}`);
      } else {
        await prompt.getByRole('button', { name: 'Save', exact: true }).click();
        await home().waitFor({ state: 'visible', timeout: 10_000 });
        const onDisk = trackCountIn(await readProject(file));
        await openCard('Stress 25');
        if (onDisk !== before + 1 || (await tracks()) !== before + 1) wrong.push(`${i} save: disk ${onDisk}, open ${await tracks()}, expected ${before + 1}`);
      }
    }
    check('every answer does exactly what it says, 21 times over', wrong.length === 0, wrong.join('; ') || JSON.stringify(answers));
    check('undoing back to the saved state counts as saved again', undoCleans === true);

    /* 7. Save spam ------------------------------------------------------------------------ */
    step('40 edits, each followed by Ctrl+S without waiting');
    for (let i = 0; i < 40; i += 1) {
      await window.evaluate(() => window.__scfStore.getState().addTrack(Math.random() < 0.5 ? 'video' : 'audio'));
      await window.keyboard.press('Control+s');
    }
    const expectedTracks = await tracks();
    const settled = await waitFor(async () => {
      try {
        return trackCountIn(await readProject(join(projectsDir, 'Stress 25.scf'))) === expectedTracks && !(await dirtyShown());
      } catch {
        return false;
      }
    }, 20_000);
    check('overlapping saves land in order: the file ends up with the last edit, whole, no temp files left',
      settled && leftovers().length === 0,
      `${expectedTracks} tracks expected; leftovers ${leftovers().join(', ') || 'none'}`);
    check('Ctrl+S never also toggled snapping (the plain S shortcut)',
      await window.evaluate(() => window.__scfStore.getState().ui.snappingEnabled) === true);

    /* 8. Dialogs, opened and closed fast -------------------------------------------------- */
    step('60 dialog opens and closes, some mid-animation');
    t = Date.now();
    for (let i = 0; i < 60; i += 1) {
      const which = i % 2 === 0 ? 'Settings' : 'Mixer';
      await window.getByRole('button', { name: which, exact: true }).click();
      if (i % 3 !== 0) await sleep(i % 3 === 1 ? 40 : 280);
      await window.keyboard.press('Escape');
    }
    const dialogsGone = await waitFor(async () => (await window.locator('.scf-dialog, .scf-overlay').count()) === 0, 3_000);
    check('no dialog or dimmed overlay is left behind', dialogsGone, `${await window.locator('.scf-dialog, .scf-overlay').count()} left`);
    const importClickable = await window.getByRole('button', { name: 'Import' }).click({ trial: true, timeout: 2_000 }).then(() => true, () => false);
    check('the editor takes clicks again straight after', importClickable);
    report.timings.dialogChurnMs = Date.now() - t;

    for (let i = 0; i < 10; i += 1) {
      await window.getByRole('button', { name: 'Export', exact: true }).click();
      await window.getByRole('dialog', { name: 'Export' }).waitFor({ state: 'visible' });
      await window.getByRole('dialog', { name: 'Export' }).getByTitle('Close').click();
    }
    check('the export dialog opens and closes ten times cleanly',
      await waitFor(async () => (await window.getByRole('dialog', { name: 'Export' }).count()) === 0, 3_000));

    const normalMotion = await window.evaluate(async () => {
      const buttons = [...document.querySelectorAll('button')];
      buttons.find((button) => button.textContent?.trim() === 'Settings')?.click();
      await new Promise((done) => setTimeout(done, 50));
      const dialog = document.querySelector('.scf-dialog');
      return dialog ? getComputedStyle(dialog).animationDuration : 'none';
    });
    await window.keyboard.press('Escape');
    check('dialogs arrive on a spring', normalMotion === '0.42s', normalMotion);
    await waitFor(async () => (await window.locator('.scf-dialog').count()) === 0, 3_000);

    /* 9. Context menus ---------------------------------------------------------------------- */
    step('100 context menus, near every edge');
    const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const headerLabel = window.getByText('Video 1', { exact: true }).first();
    const canvas = window.locator('canvas').last();
    const canvasBox = await canvas.boundingBox();
    let opened = 0;
    let offscreen = 0;
    const clippedBoxes = [];
    const openTimes = [];
    let menuMotion = null;
    for (let i = 0; i < 100; i += 1) {
      const begin = Date.now();
      if (i % 2 === 0) {
        await headerLabel.click({ button: 'right' });
      } else {
        // Across the timeline, including its bottom-right corner, where the menu must flip.
        const fx = ((i * 37) % 100) / 100;
        const fy = ((i * 53) % 100) / 100;
        await canvas.click({
          button: 'right',
          position: { x: Math.max(4, Math.min(canvasBox.width - 4, fx * canvasBox.width)), y: Math.max(30, Math.min(canvasBox.height - 4, fy * canvasBox.height)) },
        });
      }
      const menu = window.getByRole('menu');
      const shown = await menu.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false);
      if (shown) {
        opened += 1;
        openTimes.push(Date.now() - begin);
        await sleep(160);
        const box = await menu.boundingBox();
        if (!box || box.x < 0 || box.y < 0 || box.x + box.width > size.width + 1 || box.y + box.height > size.height + 1) {
          offscreen += 1;
          if (box) clippedBoxes.push(`${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
        if (menuMotion === null) menuMotion = await menu.evaluate((element) => getComputedStyle(element).animationDuration);
      }
      if (i % 3 === 0) await window.keyboard.press('Escape');
      else await window.getByTestId('project-name').click();
      await menu.waitFor({ state: 'detached', timeout: 2_000 }).catch(() => undefined);
    }
    const menusLeft = await window.getByRole('menu').count();
    check('right-click opens a menu every time', opened >= 95, `${opened}/100, median ${median(openTimes)} ms to show`);
    check('every menu stays fully inside the window', offscreen === 0, `${offscreen} clipped in ${size.width}x${size.height}${clippedBoxes.length ? `: ${clippedBoxes.slice(0, 4).join('; ')}` : ''}`);
    check('Escape or a click elsewhere always closes it', menusLeft === 0, `${menusLeft} left open`);
    check('menus grow out of the click in about a seventh of a second', menuMotion === '0.14s', String(menuMotion));
    check('menus changed nothing they were not asked to', !(await dirtyShown()));

    /* 10. Home and back, with memory --------------------------------------------------------- */
    step('40 trips to the start screen and back into the project');
    const heap = () => window.evaluate(async () => {
      for (let i = 0; i < 3; i += 1) {
        window.gc?.();
        await new Promise((done) => setTimeout(done, 50));
      }
      return { bytes: performance.memory?.usedJSHeapSize ?? 0, nodes: document.getElementsByTagName('*').length, gc: typeof window.gc === 'function' };
    });
    await goHome();
    await openCard('Stress 25');
    await sleep(500);
    const heapBefore = await heap();
    const trips = [];
    for (let i = 0; i < 40; i += 1) {
      const begin = Date.now();
      await goHome();
      await openCard(i % 2 === 0 ? 'Stress 25' : 'Stress 23');
      trips.push(Date.now() - begin);
    }
    await openCard('Stress 25').catch(async () => {
      await goHome();
      await openCard('Stress 25');
    });
    await sleep(800);
    const heapAfter = await heap();
    const growthMb = (heapAfter.bytes - heapBefore.bytes) / 1024 / 1024;
    report.memory.homeTrips = { before: heapBefore, after: heapAfter, growthMb };
    check('forty round trips leave the JS heap where it was', heapBefore.gc && growthMb < 25,
      `${growthMb.toFixed(1)} MB growth (${(heapBefore.bytes / 1048576).toFixed(0)} -> ${(heapAfter.bytes / 1048576).toFixed(0)} MB)`);
    check('and the page no bigger', heapAfter.nodes - heapBefore.nodes < 200, `${heapBefore.nodes} -> ${heapAfter.nodes} elements`);
    check('a round trip home and into a project stays quick', median(trips) < 2500, `median ${median(trips)} ms, worst ${Math.max(...trips)} ms`);

    /* 11. A project that moved ------------------------------------------------------------ */
    step('a listed project deleted from disk');
    await goHome();
    await unlink(join(projectsDir, 'Stress 24.scf'));
    await openCard('Stress 25');
    await goHome();
    const missingCard = window.getByRole('button', { name: 'Open Stress 24', exact: true });
    check('a project whose file is gone is marked and cannot be opened',
      await missingCard.isDisabled() && await window.getByText('File not found').isVisible());
    const beforeRemove = (await readRecent()).length;
    await window.getByRole('button', { name: 'Remove Stress 24 from recent projects' }).click();
    const removed = await waitFor(async () => (await missingCard.count()) === 0 && (await readRecent()).length === beforeRemove - 1, 5_000);
    check('Remove takes it off the list, and only off the list', removed && existsSync(join(projectsDir, 'Stress 25.scf')));

    const expectedMatches = (await readRecent()).filter((entry) => entry.name.toLowerCase().includes('stress 1')).length;
    await window.getByLabel('Search projects').fill('stress 1');
    const matches = await window.locator('main[aria-label="Start screen"] ul > li').count();
    check('search narrows the list to matching projects', matches === expectedMatches && matches > 0, `${matches} shown, ${expectedMatches} expected`);
    await window.getByLabel('Search projects').fill('');

    /* 12. Reduced motion --------------------------------------------------------------------- */
    step('reduced motion');
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await openCard('Stress 25');
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    const reducedDuration = await window.locator('.scf-dialog').evaluate((element) => getComputedStyle(element).animationDuration);
    const closeStarted = Date.now();
    await window.keyboard.press('Escape');
    await waitFor(async () => (await window.locator('.scf-dialog').count()) === 0, 2_000, 5);
    const reducedClose = Date.now() - closeStarted;
    check('with reduced motion asked for, nothing animates and dialogs close at once',
      reducedDuration === '0.001s' && reducedClose < 150, `${reducedDuration}, closed in ${reducedClose} ms`);
    await window.emulateMedia({ reducedMotion: 'no-preference' });

    /* 13. Closing the window ---------------------------------------------------------------- */
    step('closing the window with unsaved changes');
    await window.evaluate(() => window.__scfStore.getState().addTrack('video'));
    const expectedOnClose = await tracks();
    const cancelled = await app.evaluate(async ({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 2 });
      BrowserWindow.getAllWindows()[0].close();
      await new Promise((done) => setTimeout(done, 700));
      return BrowserWindow.getAllWindows().length;
    });
    check('Cancel on the close question keeps the window and the work', cancelled === 1 && (await tracks()) === expectedOnClose);
    const closed = app.waitForEvent('close', { timeout: 30_000 }).then(() => true, () => false);
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
      BrowserWindow.getAllWindows()[0].close();
    });
    const didClose = await closed;
    const onDiskAfterClose = trackCountIn(await readProject(join(projectsDir, 'Stress 25.scf')));
    check('Save on the close question saves, then closes', didClose && onDiskAfterClose === expectedOnClose,
      `closed ${didClose}, ${onDiskAfterClose}/${expectedOnClose} tracks on disk`);

    /* 14. The next session ------------------------------------------------------------------ */
    step('a new session');
    ({ application: app, page: window } = await launch());
    await home().waitFor({ state: 'visible', timeout: 30_000 });
    const nextList = await readRecent();
    const nextCards = await window.locator('main[aria-label="Start screen"] ul > li').count();
    const firstCard = await window.locator('main[aria-label="Start screen"] ul > li').first().innerText();
    check('the next session opens on the same list, last-saved first',
      nextCards === nextList.length && nextList[0].name === 'Stress 25' && firstCard.includes('Stress 25'),
      `${nextCards} cards, first ${nextList[0]?.name}`);
    await openCard('Stress 25');
    check('and the project reopens exactly as it was closed', (await tracks()) === expectedOnClose && !(await dirtyShown()));
  } catch (error) {
    check('the run completed', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
    const where = String(error?.stack ?? '').split('\n').find((line) => line.includes('projects.mjs')) ?? '';
    const statusText = await window.getByRole('status').first().innerText().catch(() => '');
    const headerStatus = await window.locator('header span[title]').last().innerText().catch(() => '');
    console.log('  at', where.trim(), '| home status:', statusText, '| header:', headerStatus);
    await window.screenshot({ path: join(workDir, 'failure.png') }).catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }

  check('no errors in the console or the page, in either session', issues.length === 0, issues.slice(0, 5).join(' | '));

  report.timings.total = Date.now() - started;
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  const failures = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failures.length}/${checks.length} project stress checks passed in ${Math.round(report.timings.total / 1000)} s`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
