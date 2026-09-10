import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

/**
 * End-to-end runner.
 *
 * Generates test media, builds the harness, runs it under Electron against the
 * real compositor and the real FFmpeg pipe, then inspects the files that came
 * out. Nothing here trusts the harness's own report: the MP4 is probed with
 * ffmpeg and the PNGs are parsed byte by byte.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.e2e-tmp');

const ffmpeg = require('ffmpeg-static');
const electronBinary = require('electron');

const paths = {
  video: join(workDir, 'source.mp4'),
  sprite: join(workDir, 'sprite.png'),
  mp4: join(workDir, 'out.mp4'),
  png: join(workDir, 'frames'),
};

const run = async (file, args, options = {}) =>
  execFileAsync(file, args, { maxBuffer: 32 * 1024 * 1024, ...options });

async function generateMedia() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(paths.png, { recursive: true });

  // A moving pattern, so a duplicated or frozen frame would be detectable.
  await run(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', paths.video,
  ]);

  // A sprite that is transparent except for a red disc with a soft edge.
  //
  // `geq` writes the alpha plane explicitly. `drawbox` will NOT do here: it
  // paints colour but leaves alpha untouched, producing a file that looks red
  // and is in fact entirely transparent.
  await run(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:size=128x128,format=rgba',
    '-vf', "geq=r='255':g='40':b='40':a='255*clip((48-hypot(X-64,Y-64))/4+0.5,0,1)'",
    '-frames:v', '1', paths.sprite,
  ]);
}

/** Parse the stream description ffmpeg prints for a file. */
async function probe(file) {
  let stderr = '';
  try {
    await run(ffmpeg, ['-hide_banner', '-i', file]);
  } catch (error) {
    // ffmpeg exits non-zero when given no output; the info is on stderr.
    stderr = String(error.stderr ?? '');
  }

  const duration = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  const video = /Video:\s*([a-z0-9]+).*?(\d{2,5})x(\d{2,5}).*?(\d+(?:\.\d+)?) fps/s.exec(stderr);

  return {
    durationSeconds: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : null,
    codec: video?.[1] ?? null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
    fps: video ? Number(video[4]) : null,
    raw: stderr,
  };
}

/**
 * Read a PNG's IHDR chunk directly.
 *
 * Colour type 6 is truecolour WITH alpha - the whole point of the sprite
 * export, and something an ffmpeg summary line would not tell us.
 */
async function readPngHeader(file) {
  const bytes = await readFile(file);
  const signature = bytes.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error(`${file} is not a PNG`);

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
    hasAlpha: bytes[25] === 6 || bytes[25] === 4,
  };
}

function runElectron() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronBinary, [join(projectRoot, 'dist-e2e/main/main.js')], {
      env: {
        ...process.env,
        E2E_VIDEO: paths.video,
        E2E_SPRITE: paths.sprite,
        E2E_MP4: paths.mp4,
        E2E_PNG: paths.png,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('close', () => {
      const match = /__E2E_RESULT__(.*?)__E2E_END__/s.exec(stdout);
      if (!match) {
        reject(new Error(`No result from harness.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolvePromise({ result: JSON.parse(match[1]), stdout, stderr });
    });

    child.on('error', reject);
  });
}

const checks = [];
const check = (name, passed, detail) => {
  checks.push({ name, passed, detail });
};

async function main() {
  console.log('1. generating test media with the bundled ffmpeg');
  await generateMedia();

  console.log('2. building the e2e harness');
  await run(process.execPath, [
    join(projectRoot, 'node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    join(projectRoot, 'vite.e2e.config.ts'),
  ], { cwd: projectRoot });

  console.log('3. running Electron (real compositor, real ffmpeg)');
  const { result, stdout } = await runElectron();

  if (!result.ok) {
    console.error(stdout);
    throw new Error(`Scenario failed: ${result.error}`);
  }

  for (const line of result.steps) console.log(`   - ${line}`);

  console.log('4. verifying the exported files');

  /* The edit itself ------------------------------------------------------ */
  check('trim + split produced two halves', result.edit.leftDuration + result.edit.rightDuration === 60,
    `${result.edit.leftDuration} + ${result.edit.rightDuration}`);
  check('project holds 3 clips after the edit', result.edit.clipsAfterSplit === 3,
    String(result.edit.clipsAfterSplit));

  /* Rendering ------------------------------------------------------------ */
  check('every frame was rendered', result.render.framesRendered === 60,
    String(result.render.framesRendered));
  check('no frame composited blank', result.render.nonBlankFrames === result.render.framesRendered,
    `${result.render.nonBlankFrames}/${result.render.framesRendered}`);
  // A duplicate means the decoder had not caught up, which reads as a lower
  // frame rate in the finished file.
  check('no duplicated frames', result.render.duplicateFrames === 0,
    `${result.render.duplicateFrames} duplicates`);

  /* The MP4 -------------------------------------------------------------- */
  const mp4Stat = await stat(paths.mp4);
  const mp4 = await probe(paths.mp4);

  check('MP4 exists and is not empty', mp4Stat.size > 1000, `${mp4Stat.size} bytes`);
  check('MP4 is H.264', mp4.codec === 'h264', String(mp4.codec));
  check('MP4 is 640x360', mp4.width === 640 && mp4.height === 360, `${mp4.width}x${mp4.height}`);
  check('MP4 is 30 fps', mp4.fps === 30, String(mp4.fps));
  check('MP4 is ~2s (60 frames at 30fps)',
    mp4.durationSeconds !== null && Math.abs(mp4.durationSeconds - 2) < 0.2,
    `${mp4.durationSeconds}s`);

  /* The PNG sequence ----------------------------------------------------- */
  const frames = (await readdir(paths.png)).filter((f) => f.endsWith('.png')).sort();
  check('PNG sequence wrote 10 frames', frames.length === 10, String(frames.length));

  if (frames.length > 0) {
    const header = await readPngHeader(join(paths.png, frames[0]));
    check('PNG is 640x360', header.width === 640 && header.height === 360,
      `${header.width}x${header.height}`);
    check('PNG carries an alpha channel', header.hasAlpha, `colour type ${header.colourType}`);
  }

  check('sprite kept soft alpha edges', result.render.spriteAlphaPixels > 0,
    `${result.render.spriteAlphaPixels} partially transparent pixels`);

  /* Report --------------------------------------------------------------- */
  console.log('');
  let failures = 0;
  for (const entry of checks) {
    if (!entry.passed) failures += 1;
    console.log(`   ${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}  (${entry.detail})`);
  }

  console.log('');
  console.log(`${checks.length - failures}/${checks.length} checks passed`);
  console.log(`artifacts: ${paths.mp4}`);
  console.log(`           ${paths.png}`);

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
