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
  colour: join(workDir, 'colour'),
};

/** Frame used for the colour-fidelity comparison. */
const COLOUR_FRAME = Number(process.env.E2E_COLOUR_FRAME ?? 45);

const run = async (file, args, options = {}) =>
  execFileAsync(file, args, { maxBuffer: 32 * 1024 * 1024, ...options });

/** Point the run at a real file instead of a generated one. */
const sourceOverride = process.env.E2E_SOURCE_VIDEO ?? '';

async function generateMedia() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(paths.png, { recursive: true });

  if (sourceOverride) {
    paths.video = sourceOverride;
    console.log(`   using real source: ${sourceOverride}`);
  } else {
    // A moving pattern, so a duplicated or frozen frame would be detectable.
    await run(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', paths.video,
    ]);
  }

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

/**
 * Decode the whole file and report anything ffmpeg complains about.
 *
 * A file can have a perfectly good header and still be full of broken frames,
 * which a header probe would never notice.
 */
async function decodeIntegrity(file) {
  try {
    const { stderr } = await run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
    return String(stderr ?? '').trim();
  } catch (error) {
    return String(error.stderr ?? error.message ?? '').trim();
  }
}

/**
 * Decode the exported file to small raw frames and count consecutive
 * duplicates. This checks the finished artifact rather than what the renderer
 * believed it produced.
 */
async function duplicateFramesIn(file) {
  const width = 48;
  const height = 48;
  const frameBytes = width * height * 3;

  const { stdout } = await execFileAsync(
    ffmpeg,
    ['-v', 'error', '-i', file, '-vf', `scale=${width}:${height}`, '-f', 'rawvideo',
     '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
  );

  const total = Math.floor(stdout.length / frameBytes);
  let duplicates = 0;

  for (let i = 1; i < total; i += 1) {
    const a = stdout.subarray((i - 1) * frameBytes, i * frameBytes);
    const b = stdout.subarray(i * frameBytes, (i + 1) * frameBytes);
    if (a.equals(b)) duplicates += 1;
  }

  return { frames: total, duplicates };
}

/**
 * Decode the audio track and report its peak level.
 *
 * A file can carry a perfectly well-formed AAC stream that is pure silence,
 * which every structural check would happily pass.
 */
async function audioPeak(file) {
  try {
    const { stdout } = await execFileAsync(
      ffmpeg,
      ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'],
      { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
    );

    if (stdout.length < 4) return { samples: 0, peak: 0 };

    let peak = 0;
    for (let offset = 0; offset + 4 <= stdout.length; offset += 4) {
      const magnitude = Math.abs(stdout.readFloatLE(offset));
      if (magnitude > peak) peak = magnitude;
    }
    return { samples: stdout.length / 4, peak };
  } catch {
    return { samples: 0, peak: 0 };
  }
}

/**
 * Correlate the exported audio against the stretch of source it was cut from.
 *
 * "Has an audio stream" and "has the RIGHT audio, at the right offset" are very
 * different claims. A mix that is a second out of step, or that starts from the
 * top of the file instead of the trim point, passes every structural check.
 */
async function audioAlignment(sourceFile, exportFile, startSeconds, durationSeconds) {
  const rate = 8000;
  const pull = async (args) => {
    const { stdout } = await execFileAsync(
      ffmpeg,
      [...args, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'],
      { maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' },
    );
    return stdout;
  };

  const source = await pull([
    '-v', 'error', '-ss', String(startSeconds), '-t', String(durationSeconds), '-i', sourceFile,
  ]);
  const exported = await pull(['-v', 'error', '-i', exportFile]);

  const count = Math.min(source.length, exported.length) / 4;
  if (count < rate) return { correlation: 0, samples: count };

  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < count; i += 1) {
    meanA += source.readFloatLE(i * 4);
    meanB += exported.readFloatLE(i * 4);
  }
  meanA /= count;
  meanB /= count;

  let numerator = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < count; i += 1) {
    const a = source.readFloatLE(i * 4) - meanA;
    const b = exported.readFloatLE(i * 4) - meanB;
    numerator += a * b;
    varA += a * a;
    varB += b * b;
  }

  const denominator = Math.sqrt(varA * varB);
  return { correlation: denominator > 0 ? numerator / denominator : 0, samples: count };
}

/** Decode any image or video frame to a flat RGB byte buffer. */
async function toRgb(file, extraArgs = []) {
  const { stdout } = await execFileAsync(
    ffmpeg,
    ['-v', 'error', ...extraArgs, '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
  );
  return stdout;
}

/**
 * Compare the compositor's untouched render of a frame against ffmpeg's own
 * decode of the same frame.
 *
 * This is the check no structural test can stand in for: a picture can be the
 * right size, the right duration and perfectly decodable while every pixel sits
 * a few levels off, because the colour primaries or the TV/full range were
 * mishandled on the way through the GPU.
 */
async function colourDifference(referenceFile, renderedFile) {
  const [reference, rendered] = await Promise.all([toRgb(referenceFile), toRgb(renderedFile)]);

  const count = Math.min(reference.length, rendered.length);
  if (count === 0) return null;

  let absoluteTotal = 0;
  let worst = 0;
  const signed = [0, 0, 0];

  for (let i = 0; i < count; i += 1) {
    const delta = rendered[i] - reference[i];
    const magnitude = Math.abs(delta);
    absoluteTotal += magnitude;
    if (magnitude > worst) worst = magnitude;
    signed[i % 3] += delta;
  }

  const perChannel = count / 3;
  return {
    meanAbsolute: absoluteTotal / count,
    worst,
    // A systematic shift shows up here even when the mean absolute error is
    // small: it means every pixel leans the same way.
    meanSigned: signed.map((sum) => sum / perChannel),
    bytesCompared: count,
  };
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
  const audio = /Audio:\s*([a-z0-9]+).*?(\d+) Hz,\s*([a-z0-9.]+)/.exec(stderr);

  return {
    durationSeconds: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : null,
    codec: video?.[1] ?? null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
    fps: video ? Number(video[4]) : null,
    audioCodec: audio?.[1] ?? null,
    audioSampleRate: audio ? Number(audio[2]) : null,
    audioLayout: audio?.[3] ?? null,
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
        E2E_COLOUR_DIR: paths.colour,
        E2E_COLOUR_FRAME: String(COLOUR_FRAME),
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      // Inherit stdio for stderr so Electron's own warnings are visible.
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

  /* Anything the app complained about ------------------------------------ */
  const issues = result.consoleIssues ?? [];
  if (issues.length > 0) {
    console.log('');
    console.log('   renderer console output:');
    for (const issue of issues) console.log(`     ${issue}`);
  }

  console.log('');
  console.log('4. verifying the exported files');

  const expected = {
    frames: result.edit.totalFrames,
    width: result.project.width,
    height: result.project.height,
    fps: result.project.fps,
  };

  /* The edit itself ------------------------------------------------------ */
  check('trim + split covers the whole range',
    result.edit.leftDuration + result.edit.rightDuration === expected.frames,
    `${result.edit.leftDuration} + ${result.edit.rightDuration} = ${expected.frames}`);
  check('renderer logged no errors or warnings', issues.length === 0,
    issues.length === 0 ? 'clean' : `${issues.length} issue(s)`);

  /* Rendering ------------------------------------------------------------ */
  check('every frame was rendered', result.render.framesRendered === expected.frames,
    String(result.render.framesRendered));
  check('no frame composited blank', result.render.nonBlankFrames === result.render.framesRendered,
    `${result.render.nonBlankFrames}/${result.render.framesRendered}`);

  /* The MP4 -------------------------------------------------------------- */
  const mp4Stat = await stat(paths.mp4);
  const mp4 = await probe(paths.mp4);

  check('MP4 exists and is not empty', mp4Stat.size > 1000, `${mp4Stat.size} bytes`);
  check('MP4 is H.264', mp4.codec === 'h264', String(mp4.codec));
  check('MP4 matches the project resolution',
    mp4.width === expected.width && mp4.height === expected.height,
    `${mp4.width}x${mp4.height} vs ${expected.width}x${expected.height}`);
  check('MP4 matches the project frame rate',
    mp4.fps !== null && Math.abs(mp4.fps - expected.fps) < 0.5,
    `${mp4.fps} vs ${expected.fps}`);

  // Tight on purpose: a file that runs a few percent slow is exactly the kind
  // of defect a loose tolerance hides.
  const expectedSeconds = expected.frames / expected.fps;
  const drift = mp4.durationSeconds === null
    ? Infinity
    : Math.abs(mp4.durationSeconds - expectedSeconds) / expectedSeconds;
  check('MP4 duration matches the exported range (within 1%)', drift < 0.01,
    `${mp4.durationSeconds}s vs ${expectedSeconds.toFixed(2)}s (${(drift * 100).toFixed(1)}% off)`);

  /* Audio ---------------------------------------------------------------- */
  check('MP4 carries an audio stream', mp4.audioCodec !== null, String(mp4.audioCodec));
  check('audio is AAC at 48 kHz',
    mp4.audioCodec === 'aac' && mp4.audioSampleRate === 48000,
    `${mp4.audioCodec} @ ${mp4.audioSampleRate} Hz`);

  const sound = await audioPeak(paths.mp4);
  // A well-formed but silent track passes every structural check, so the level
  // itself has to be measured.
  check('audio is not silent', sound.peak > 0.001, `peak ${sound.peak.toFixed(4)}`);

  const audioSeconds = mp4.audioSampleRate ? sound.samples / 2 / mp4.audioSampleRate : 0;
  check('audio length matches the video',
    Math.abs(audioSeconds - expectedSeconds) / expectedSeconds < 0.05,
    `${audioSeconds.toFixed(2)}s vs ${expectedSeconds.toFixed(2)}s`);

  // Only meaningful against a real source whose audio we can line up against.
  if (sourceOverride && mp4.audioCodec) {
    const startSeconds = Number(process.env.E2E_START ?? 0) / expected.fps;
    const { correlation } = await audioAlignment(
      sourceOverride, paths.mp4, startSeconds, expectedSeconds,
    );
    check('audio is the trimmed range, in sync', correlation > 0.8,
      `correlation ${correlation.toFixed(4)} against source at +${startSeconds.toFixed(2)}s`);
  }

  /* The finished file, decoded ------------------------------------------- */
  const integrity = await decodeIntegrity(paths.mp4);
  check('MP4 decodes cleanly end to end', integrity === '',
    integrity === '' ? 'no decoder errors' : integrity.split('\n')[0]);

  const decoded = await duplicateFramesIn(paths.mp4);
  check('MP4 holds every exported frame', decoded.frames === expected.frames,
    `${decoded.frames} decoded vs ${expected.frames} exported`);
  // A duplicate means the decoder had not caught up, which reads as a lower
  // frame rate in the finished file.
  check('no duplicated frames in the output', decoded.duplicates === 0,
    `${decoded.duplicates} of ${decoded.frames}`);

  /* Colour fidelity ------------------------------------------------------- */
  const colourFrames = (await readdir(paths.colour).catch(() => []))
    .filter((f) => f.endsWith('.png'))
    .sort();

  if (colourFrames.length > 0) {
    const referencePng = join(workDir, 'reference.png');
    await run(ffmpeg, [
      '-y', '-v', 'error', '-i', paths.video,
      '-vf', `select=eq(n\\,${COLOUR_FRAME})`, '-vsync', '0', '-frames:v', '1', referencePng,
    ]);

    // Control: the SAME frame decoded by ffmpeg through a different path. On
    // lossy footage this is not zero, and comparing the compositor against an
    // absolute threshold rather than against this noise floor would be
    // measuring the source's own decode variance.
    const controlPng = join(workDir, 'reference-control.png');
    await run(ffmpeg, [
      '-y', '-v', 'error', '-ss', String(COLOUR_FRAME / expected.fps),
      '-i', paths.video, '-frames:v', '1', controlPng,
    ]);

    const control = await colourDifference(referencePng, controlPng);
    const diff = await colourDifference(referencePng, join(paths.colour, colourFrames[0]));

    if (diff && control) {
      console.log(
        `   colour: mean |delta| ${diff.meanAbsolute.toFixed(2)}/255 ` +
        `(ffmpeg-vs-itself control: ${control.meanAbsolute.toFixed(2)}), ` +
        `signed R${diff.meanSigned[0].toFixed(2)} ` +
        `G${diff.meanSigned[1].toFixed(2)} B${diff.meanSigned[2].toFixed(2)}`,
      );

      const budget = Math.max(8, control.meanAbsolute * 2.5);
      check('render matches ffmpeg decode (colour)', diff.meanAbsolute < budget,
        `${diff.meanAbsolute.toFixed(2)} vs budget ${budget.toFixed(2)}`);

      // The load-bearing one. A consistent lean in one direction is the
      // signature of a range, primaries or gamma mismatch, and it averages out
      // of the absolute error - so it has to be checked separately.
      const bias = Math.max(...diff.meanSigned.map(Math.abs));
      check('no systematic colour shift', bias < 2, `worst channel bias ${bias.toFixed(2)}`);
    }
  }

  /* The PNG sequence ----------------------------------------------------- */
  const frames = (await readdir(paths.png).catch(() => []))
    .filter((f) => f.endsWith('.png'))
    .sort();

  if (frames.length > 0) {
    const header = await readPngHeader(join(paths.png, frames[0]));
    check('PNG matches the project resolution',
      header.width === expected.width && header.height === expected.height,
      `${header.width}x${header.height}`);
    check('PNG carries an alpha channel', header.hasAlpha, `colour type ${header.colourType}`);
    check('sprite kept soft alpha edges', result.render.spriteAlphaPixels > 0,
      `${result.render.spriteAlphaPixels} partially transparent pixels`);
  }

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
