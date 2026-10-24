import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Text to speech, everywhere in the editor: `node tests/ui/tts-plus.mjs`
 *
 *   1. the timeline's Voice button opens the library's Voice tab, beside
 *      Effects and Transitions - not a window over the editor;
 *   2. a line generated as it comes is an audio clip and nothing else - no
 *      captions - starting on its first word: at the playhead on a Voice
 *      track (dialogue bus), kept in the app's folder (not temp), not
 *      clipped, at about -16 LUFS; with "also add captions" ticked, captions
 *      cover what it says;
 *   2b. the Phone call character: Daniela, through a phone line (nothing
 *      left above 4 kHz);
 *   3. pitch +4 raises the voice (its fundamental a quarter higher) and keeps
 *      its pace;
 *   4. a title's menu reads it aloud from where it starts;
 *   5. a captions track's menu narrates each caption at its own time.
 *
 * Needs a build (npm run build). The window is never shown.
 */

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, '.ui-tmp', 'tts-plus');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const loudness = (path) => Number(spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/)?.[1]);
const peak = (path) => Number(spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1]);
/** The voice's pitch: the median fundamental of its voiced 40 ms frames (autocorrelation, 70-400 Hz), and its length. */
const crossings = (path) => {
  const rate = 16000;
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
  const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  const size = 640;
  const pitches = [];
  for (let at = 0; at + size < samples.length; at += size / 2) {
    let energy = 0;
    for (let i = 0; i < size; i += 1) energy += samples[at + i] * samples[at + i];
    if (energy / size < 1500 * 1500) continue;
    let best = 0;
    let bestLag = 0;
    for (let lag = Math.floor(rate / 400); lag <= Math.ceil(rate / 70); lag += 1) {
      let sum = 0;
      for (let i = 0; i + lag < size; i += 1) sum += samples[at + i] * samples[at + i + lag];
      if (sum > best) {
        best = sum;
        bestLag = lag;
      }
    }
    if (bestLag > 0 && best > 0.3 * energy) pitches.push(rate / bestLag);
  }
  pitches.sort((a, b) => a - b);
  return { rate: pitches[Math.floor(pitches.length / 2)] ?? 0, seconds: samples.length / rate };
};

/** Seconds of near silence before the first sound. */
const leadingSilence = (path) => {
  const text = spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', 'silencedetect=noise=-45dB:d=0.01', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const start = text.match(/silence_start: (-?[\d.]+)/);
  const end = text.match(/silence_end: ([\d.]+)/);
  return start && Number(start[1]) <= 0.001 && end ? Number(end[1]) : 0;
};
/** The mean level above `hz`, in dB. */
const band = (path, hz) => Number(spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-af', `highpass=f=${hz},highpass=f=${hz},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);

async function main() {
  if (!existsSync(join(root, 'dist-electron/main/index.js'))) throw new Error('No build: run npm run build first.');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const video = join(work, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x334155:s=640x360:r=30:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
  const profile = join(work, `profile-${process.pid}-${Date.now()}`);

  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, join(root, 'dist-electron/main/index.js')],
    cwd: root,
    // The engine and voices staged in build/, as tests/ui/tts.mjs runs them.
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined,
      SCF_BACKGROUND: '1',
      SCF_NO_CLOSE_PROMPT: '1',
      SCF_TTS_DIR: join(root, 'build', 'piper'),
      SCF_TTS_BUNDLED_DIR: join(root, 'build', 'tts-voices'),
      SCF_TTS_VOICES_DIR: join(work, 'downloaded-voices'),
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
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [video]);
    await window.getByRole('button', { name: 'Import', exact: true }).click();
    await window.waitForFunction(() => window.__scfStore.getState().assets.length === 1, null, { timeout: 60_000 });
    await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.addAssetToTimeline(s.assets[0], s.project.tracks.find((t) => t.type === 'video').id, 0);
      window.__scfStore.getState().setCurrentFrame(30);
    });
    await sleep(500);

    console.log('1. the button');
    await window.getByTestId('timeline-tts').click();
    const tts = window;
    const opened = await tts.getByTestId('tts-text').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    const tab = await window.getByTestId('library-tab-voice').getAttribute('aria-selected').catch(() => null);
    const windows = app.windows().length;
    check('the timeline’s Voice button opens the library’s Voice tab, no window of its own', opened && tab === 'true' && windows === 1, `tab ${tab}, ${windows} windows`);

    console.log('2. a line: an audio clip, and nothing else');
    const line = 'Hola a todos. Hoy vamos a editar un video en pocos minutos, paso a paso. Empecemos.';
    await tts.getByTestId('tts-language').selectOption('es');
    await tts.getByTestId('tts-voice-es-419-dora').click();
    await tts.getByTestId('tts-text').fill(line);
    await tts.getByTestId('tts-pitch').fill('0');
    if (!(await tts.getByTestId('tts-enhance').isChecked())) await tts.getByTestId('tts-enhance').check();
    const captionsOff = !(await tts.getByTestId('tts-captions').isChecked());
    await tts.getByTestId('tts-generate').click();
    const alone = await window.waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).some((c) => window.__scfStore.getState().project.tracks.find((t) => t.id === c.trackId)?.type === 'audio'), null, { timeout: 120_000 }).then(() => true).catch(() => false);
    await sleep(600);
    const first = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips).find((c) => s.project.tracks.find((t) => t.id === c.trackId)?.type === 'audio');
      return { captions: Object.values(s.project.clips).filter((c) => c.caption).length, path: s.assets.find((a) => a.uri === clip?.sourceUri)?.sourcePath ?? '', id: clip?.id };
    });
    const lead = leadingSilence(first.path);
    check('captions are off unless asked: the voice is an audio clip and nothing else', alone && captionsOff && first.captions === 0, JSON.stringify({ captionsOff, captions: first.captions }));
    check('it starts on its first word: no silence left before it', lead < 0.12, `${lead.toFixed(3)} s before the first word`);
    await window.evaluate((id) => window.__scfStore.getState().removeClips([id]), first.id);

    console.log('2b. with captions, asked for');
    await tts.getByTestId('tts-captions').check();
    await tts.getByTestId('tts-text').fill(line);
    await tts.getByTestId('tts-generate').click();
    const made = await window.waitForFunction(() => Object.values(window.__scfStore.getState().project.clips).some((c) => window.__scfStore.getState().project.tracks.find((t) => t.id === c.trackId)?.type === 'audio'), null, { timeout: 120_000 }).then(() => true).catch(() => false);
    await sleep(800);
    const placed = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips).find((c) => s.project.tracks.find((t) => t.id === c.trackId)?.type === 'audio');
      const track = s.project.tracks.find((t) => t.id === clip?.trackId);
      const asset = s.assets.find((a) => a.uri === clip?.sourceUri);
      const captions = Object.values(s.project.clips).filter((c) => c.caption).sort((a, b) => a.startFrame - b.startFrame);
      return {
        start: clip?.startFrame,
        end: clip ? clip.startFrame + clip.durationFrames : 0,
        track: track?.name,
        bus: track?.bus,
        path: asset?.sourcePath,
        captions: captions.map((c) => ({ start: c.startFrame, end: c.startFrame + c.durationFrames, text: c.caption.text })),
      };
    });
    check('it lands at the playhead on a Voice track, on the dialogue bus', made && placed.start === 30 && placed.track === 'Voice' && placed.bus === 'dialogue', JSON.stringify({ start: placed.start, track: placed.track, bus: placed.bus }));
    const kept = placed.path ?? '';
    check('kept in the app’s folder, not in temp', kept.startsWith(join(profile, 'scf', 'voices')), kept);
    const level = { peak: peak(kept), lufs: loudness(kept) };
    check('not clipped, at about -16 LUFS', level.peak < -0.5 && Math.abs(level.lufs + 16) < 1.5, JSON.stringify(level));
    const cues = placed.captions;
    check('with captions covering what it says, from its start to its end', cues.length >= 3 && cues[0].start === 30 && Math.abs(cues[cues.length - 1].end - placed.end) <= 2 && /Hola a todos/.test(cues[0].text),
      JSON.stringify(cues.map((c) => `${c.start}-${c.end} ${c.text}`)));

    console.log('2c. the Phone call character');
    await tts.getByTestId('tts-captions').uncheck();
    await tts.getByTestId('tts-character-call').click();
    const chosen = await tts.evaluate(() => ({
      voice: document.querySelector('[data-testid="tts-voice-es-AR-daniela"]')?.getAttribute('aria-checked'),
      phone: document.querySelector('[data-testid="tts-effect-phone"]')?.getAttribute('aria-pressed'),
    }));
    await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(900));
    await tts.getByTestId('tts-text').fill('Hola, te llamo para contarte una noticia importante.');
    const beforeCall = await window.evaluate(() => window.__scfStore.getState().assets.length);
    await tts.getByTestId('tts-generate').click();
    await window.waitForFunction((count) => window.__scfStore.getState().assets.length > count, beforeCall, { timeout: 120_000 }).catch(() => undefined);
    await sleep(500);
    const callPath = await window.evaluate(() => window.__scfStore.getState().assets.at(-1).sourcePath);
    const callHigh = band(callPath, 4500);
    const naturalHigh = band(kept, 4500);
    check('the Phone call character: Daniela, through a phone line (the top end gone)', chosen.voice === 'true' && chosen.phone === 'true' && callHigh < naturalHigh - 15,
      `above 4.5 kHz: ${naturalHigh.toFixed(1)} dB natural, ${callHigh.toFixed(1)} dB on the phone`);
    await tts.getByTestId('tts-effect-none').click();

    console.log('3. pitch');
    const generateWith = async (value) => {
      await window.evaluate(() => window.__scfStore.getState().setCurrentFrame(400));
      await tts.getByTestId('tts-text').fill('Esta es la misma frase dicha dos veces para comparar el tono.');
      await tts.getByTestId('tts-pitch').fill(String(value));
      const before = await window.evaluate(() => window.__scfStore.getState().assets.length);
      await tts.getByTestId('tts-generate').click();
      await window.waitForFunction((count) => window.__scfStore.getState().assets.length > count, before, { timeout: 120_000 });
      await sleep(500);
      return window.evaluate(() => window.__scfStore.getState().assets.at(-1).sourcePath);
    };
    const normal = crossings(await generateWith(0));
    const higher = crossings(await generateWith(4));
    const ratio = higher.rate / normal.rate;
    // +4 semitones is ×1.26; a generated voice varies a little from one take to the next,
    // in pitch and in length (Piper's durations are sampled: a few per cent).
    check('pitch +4 raises the voice and keeps its pace', ratio > 1.15 && ratio < 1.4 && Math.abs(higher.seconds / normal.seconds - 1) < 0.08,
      `pitch ${normal.rate.toFixed(0)} → ${higher.rate.toFixed(0)} Hz (×${ratio.toFixed(2)}), length ${normal.seconds.toFixed(2)} → ${higher.seconds.toFixed(2)} s`);

    const rightClick = async (clipId) => {
      const canvas = await window.locator('[data-panel="timeline"] canvas').first().boundingBox();
      const spot = await window.evaluate((id) => {
        const s = window.__scfStore.getState();
        const clip = s.project.clips[id];
        const rows = [...document.querySelectorAll('[data-panel="timeline"] .group.relative.flex')];
        const track = s.project.tracks.find((t) => t.id === clip.trackId);
        const box = rows[rows.findIndex((row) => (row.textContent ?? '').includes(track.name))].getBoundingClientRect();
        return { x: (clip.startFrame + 5) * s.ui.pixelsPerFrame - s.ui.scrollLeftPx, y: box.top + box.height / 2 };
      }, clipId);
      await window.mouse.click(canvas.x + spot.x, spot.y, { button: 'right' });
    };

    console.log('4. a title, read aloud');
    const titleId = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.setCurrentFrame(200);
      return null;
    });
    void titleId;
    await window.getByTestId('library-tab-titles').click();
    await window.getByTestId('library-title-title').focus();
    await window.keyboard.press('Enter');
    await sleep(500);
    const title = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      const clip = Object.values(s.project.clips).find((c) => c.title);
      s.updateClip(clip.id, { title: { ...clip.title, text: 'Bienvenidos al canal' } });
      return { id: clip.id, start: clip.startFrame };
    });
    await window.evaluate(() => window.__scfStore.getState().zoomToFit());
    await sleep(300);
    await rightClick(title.id);
    const readItem = window.getByRole('menuitem', { name: /Read aloud/ });
    const offered = await readItem.isVisible().catch(() => false);
    if (offered) await readItem.click();
    const read = await window.waitForFunction((start) => Object.values(window.__scfStore.getState().project.clips).some((c) => c.startFrame === start && window.__scfStore.getState().project.tracks.find((t) => t.id === c.trackId)?.type === 'audio'), title.start, { timeout: 120_000 }).then(() => true).catch(() => false);
    check('a title’s menu reads it aloud, from where it starts', offered && read, `title at ${title.start}`);

    console.log('5. captions, narrated');
    const cueStarts = await window.evaluate(() => {
      const s = window.__scfStore.getState();
      s.addCaptionTrack({ subtitles: [
        { startMs: 14000, endMs: 15500, text: 'Primera frase.' },
        { startMs: 16000, endMs: 17500, text: 'Segunda frase.' },
        { startMs: 18000, endMs: 19500, text: 'Y la tercera.' },
      ] }, { preset: 'classic', language: 'es' });
      return Object.values(window.__scfStore.getState().project.clips).filter((c) => c.caption && c.startFrame >= 400).map((c) => c.startFrame).sort((a, b) => a - b);
    });
    await sleep(400);
    const firstCue = await window.evaluate((start) => Object.values(window.__scfStore.getState().project.clips).find((c) => c.caption && c.startFrame === start).id, cueStarts[0]);
    await rightClick(firstCue);
    const narrateItem = window.getByRole('menuitem', { name: /Narrate these captions/ });
    const narrateOffered = await narrateItem.isVisible().catch(() => false);
    if (narrateOffered) await narrateItem.click();
    const narrated = await window.waitForFunction((starts) => {
      const s = window.__scfStore.getState();
      const audio = Object.values(s.project.clips).filter((c) => s.project.tracks.find((t) => t.id === c.trackId)?.type === 'audio').map((c) => c.startFrame);
      return starts.every((start) => audio.includes(start));
    }, cueStarts, { timeout: 180_000 }).then(() => true).catch(() => false);
    const audioStarts = await window.evaluate(() => { const s = window.__scfStore.getState(); return Object.values(s.project.clips).filter((c) => s.project.tracks.find((t) => t.id === c.trackId)?.type === 'audio').map((c) => c.startFrame).sort((a, b) => a - b); });
    check('a captions track’s menu narrates each caption at its own time', narrateOffered && narrated, JSON.stringify({ cueStarts, narrateOffered, audioStarts }));

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
