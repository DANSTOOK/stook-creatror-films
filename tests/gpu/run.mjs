import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

/**
 * Hardware check: `npm run test:gpu`
 *
 * Starts the real app once per GPU preference and, on each, exports a short
 * MP4 through every encoder the app offers. Nothing is stubbed except the
 * native save dialog.
 *
 * What it proves, per run:
 * - the compositor really moved to the requested GPU (dedicated / integrated);
 * - every offered encoder produces a playable H.264 file with every frame;
 * - a hardware encoder really encoded it. libx264 stamps its version string
 *   ("x264 - core") into the stream and no hardware encoder does, so a file
 *   from "NVENC" carrying that stamp means the render silently fell back to
 *   the CPU - which is exactly the kind of lie this project refuses to ship.
 *
 * Needs a machine with the GPUs in question; on a single-GPU machine the
 * preference that has no GPU is reported as skipped, not as passed.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.gpu-tmp');

const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 30;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function probe(file) {
  // ffmpeg exits non-zero with no output file; the stream summary is on stderr.
  const { stderr } = await execFileAsync(
    ffmpeg,
    ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  ).catch((error) => ({ stderr: String(error.stderr ?? '') }));

  const codec = /Video:\s*([a-z0-9]+)/.exec(stderr)?.[1] ?? null;

  // Frames are counted by DECODING every one to an MD5 line. The `frame=`
  // progress line is not printed by this ffmpeg build when stream-copying, so
  // parsing it reported 0 frames for perfectly good files.
  const { stdout: md5 } = await execFileAsync(
    ffmpeg,
    ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  ).catch(() => ({ stdout: '' }));
  const frames = md5.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).length;
  const bytes = await readFile(file);
  return { codec, frames, x264Stamp: bytes.includes(Buffer.from('x264 - core')) };
}

async function exportWith(app, window, encoder, output) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, output);

  return window.evaluate(
    async ({ encoder, width, height, frames }) => {
      const outputPath = await window.filmora.chooseExportPath('mp4-h264');
      const { jobId } = await window.filmora.exportStart({
        format: 'mp4-h264',
        outputPath,
        width,
        height,
        fps: 30,
        startFrame: 0,
        endFrame: frames,
        exportAlpha: false,
        premultiplyAlpha: false,
        pixelArtScaling: false,
        bitrateKbps: 2000,
        hardwareEncoder: encoder,
        pipeMode: 'rawvideo',
      });

      // A moving gradient, so the encoder has real work and every frame differs.
      for (let frame = 0; frame < frames; frame += 1) {
        const rgba = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i += 1) {
          rgba[i * 4] = (i + frame * 8) % 256;
          rgba[i * 4 + 1] = (i >> 8) % 256;
          rgba[i * 4 + 2] = frame * 8;
          rgba[i * 4 + 3] = 255;
        }
        await window.filmora.exportFrame(jobId, rgba.buffer);
      }
      await window.filmora.exportFinish(jobId);
      return outputPath;
    },
    { encoder, width: WIDTH, height: HEIGHT, frames: FRAMES },
  );
}

async function runPreference(preference) {
  console.log(`\n-- FILMORA_GPU=${preference}`);

  const app = await electron.launch({
    // Own profile: runs beside an open copy of the app, never touches its settings.
    args: [`--user-data-dir=${join(workDir, 'profile')}`, join(projectRoot, 'dist-electron/main/index.js')],
    cwd: projectRoot,
    env: {
      ...process.env,
      FILMORA_GPU: preference,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RUN_AS_NODE: undefined, SCF_SKIP_HOME: '1', SCF_NO_CLOSE_PROMPT: '1',
    },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const report = await window.evaluate(() => window.filmora.gpuReport());
    const active = report.devices.find((device) => device.active);
    const wanted = preference === 'high-performance' ? 'dedicated' : 'integrated';

    console.log(`   GPUs: ${report.devices.map((d) => `${d.name} [${d.kind}${d.active ? ', active' : ''}]`).join(' | ')}`);
    console.log(`   encoders that work: ${report.encoders.map((e) => `${e.encoder} on ${e.gpu?.name ?? '?'}`).join(', ') || 'none'}`);

    if (!report.devices.some((device) => device.kind === wanted)) {
      console.log(`   SKIP  no ${wanted} GPU on this machine`);
      return;
    }

    check(`compositor runs on the ${wanted} GPU`, active?.kind === wanted, active?.name ?? 'none active');
    check('the session reports the preference it started with', report.appliedPreference === preference, report.appliedPreference);

    for (const encoder of [...report.encoders.map((e) => e.encoder), 'none']) {
      const output = join(workDir, `${preference}-${encoder}.mp4`);
      await exportWith(app, window, encoder, output);
      const file = await probe(output);

      check(`${encoder}: exported a playable H.264 file`, file.codec === 'h264', String(file.codec));
      check(`${encoder}: every frame arrived`, file.frames === FRAMES, `${file.frames}/${FRAMES}`);
      check(
        encoder === 'none' ? 'none: really encoded on the CPU' : `${encoder}: really encoded on the GPU`,
        encoder === 'none' ? file.x264Stamp : !file.x264Stamp,
        file.x264Stamp ? 'x264 stamp present' : 'no x264 stamp',
      );
    }

    // A picture of the dialog the user will see, for the report.
    await window.getByRole('button', { name: /Export/ }).last().click();
    await window.getByText('This render:').waitFor({ timeout: 30_000 });
    await window.screenshot({ path: join(workDir, `dialog-${preference}.png`) });
  } finally {
    await app.close();
  }
}

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  if (!process.env.SKIP_BUILD) {
    console.log('building the app');
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  for (const preference of ['high-performance', 'low-power']) {
    await runPreference(preference);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} GPU checks passed`);
  console.log(`artifacts: ${workDir}`);
  process.exit(passed === results.length && results.length > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
