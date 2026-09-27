import { execFile, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

/**
 * Colour through the export: `npm run test:colour`
 *
 * A still of known patches goes through the real compositor and out by
 * every path the export dialog can take - the raw RGBA pipe to libx264, the
 * same pipe to a hardware encoder, and WebCodecs. Each file is then decoded
 * the way a BT.709 player decodes it, and every patch has to come back
 * within 2 levels of what went in, with the Rec.709 tags in the file.
 *
 * Why it exists: the raw pipe used to let ffmpeg convert with its default
 * BT.601 matrix and write no tags, so a player showed pure red as 255,23,0.
 * No structural check noticed; only decoding the colour does.
 *
 * Runs on the real GPU (WebCodecs is only offered there) in a window that is
 * never shown.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ffmpeg = require('ffmpeg-static');
const electronBinary = require('electron');

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const workDir = join(projectRoot, '.e2e-tmp', 'colour-export');

const WIDTH = 1280;
const HEIGHT = 720;
const TOLERANCE = 2;

/**
 * Two rows of eight: full-level primaries, greys and a skin tone on top; the
 * 75% bars (what a vectorscope's targets are drawn for) and two more below.
 */
const PATCHES = [
  ['white', [255, 255, 255]], ['grey 75%', [191, 191, 191]], ['grey 50%', [128, 128, 128]], ['black', [0, 0, 0]],
  ['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]], ['skin', [224, 160, 128]],
  ['yellow 75%', [191, 191, 0]], ['cyan 75%', [0, 191, 191]], ['green 75%', [0, 191, 0]], ['magenta 75%', [191, 0, 191]],
  ['red 75%', [191, 0, 0]], ['blue 75%', [0, 0, 191]], ['grey 25%', [64, 64, 64]], ['orange', [230, 120, 30]],
];
const COLUMNS = 8;
const ROWS = 2;
const PATCH_W = WIDTH / COLUMNS;
const PATCH_H = HEIGHT / ROWS;

const run = (file, args, options = {}) => execFileAsync(file, args, { maxBuffer: 256 * 1024 * 1024, ...options });

async function makePatches(path) {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = Math.floor(y / PATCH_H) * COLUMNS + Math.floor(x / PATCH_W);
      const [r, g, b] = PATCHES[index][1];
      const offset = (y * WIDTH + x) * 3;
      rgb[offset] = r;
      rgb[offset + 1] = g;
      rgb[offset + 2] = b;
    }
  }
  const raw = `${path}.rgb`;
  await writeFile(raw, rgb);
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${WIDTH}x${HEIGHT}`,
    '-i', raw, '-frames:v', '1', path]);
}

/** A hardware encoder that really works here, or ''. */
async function workingHardwareEncoder() {
  for (const [name, codec] of [['nvenc', 'h264_nvenc'], ['qsv', 'h264_qsv'], ['amf', 'h264_amf']]) {
    try {
      await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30', '-frames:v', '5',
        '-c:v', codec, '-pix_fmt', 'yuv420p', '-f', 'null', '-']);
      return name;
    } catch {
      // Not on this machine.
    }
  }
  return '';
}

function runElectron(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronBinary, [join(projectRoot, 'dist-e2e/main/main.js')], {
      env: {
        ...process.env,
        ...env,
        E2E_MODE: 'colour',
        E2E_USE_GPU: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        ELECTRON_RUN_AS_NODE: undefined,
        SCF_BACKGROUND: process.env.SCF_BACKGROUND ?? '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', () => {
      const match = /__E2E_RESULT__(.*?)__E2E_END__/s.exec(stdout);
      if (!match) {
        reject(new Error(`No result from harness.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolvePromise(JSON.parse(match[1]));
    });
    child.on('error', reject);
  });
}

/** The stream line ffmpeg prints, e.g. "yuv420p(tv, bt709, progressive)". */
async function streamLine(file) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file]).catch((error) => ({ stderr: String(error.stderr ?? '') }));
  return /Video:.*$/m.exec(stderr)?.[0] ?? '';
}

/**
 * The tags in a stream line: range, and matrix/primaries/transfer. ffmpeg
 * prints one name when all three agree ("tv, bt709") and all three otherwise
 * ("tv, smpte170m/bt709/bt709").
 */
function tagsOf(line) {
  const match = /\((tv|pc)(?:, ([a-z0-9-]+)(?:\/([a-z0-9-]+)\/([a-z0-9-]+))?)?/.exec(line);
  if (!match) return null;
  const matrix = match[2] ?? null;
  return { range: match[1], matrix, primaries: match[3] ?? matrix, transfer: match[4] ?? matrix };
}

/** Frame 5 as its own YUV planes, untouched by any conversion. */
async function decodeYuv(file) {
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'select=eq(n\\,5)', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { encoding: 'buffer' });
  return stdout;
}

const KR_KB = { bt709: [0.2126, 0.0722], bt601: [0.299, 0.114] };
const matrixFamily = (name) => (name === 'bt709' ? 'bt709' : name === 'smpte170m' || name === 'bt470bg' ? 'bt601' : null);

/**
 * Mean of a 48x48 block in the middle of each patch (away from the chroma
 * subsampled edges), turned into RGB with the textbook equations - not with
 * ffmpeg's scaler, whose default tables are themselves up to 3 levels off.
 */
function patchMeans(yuv, matrix, fullRange) {
  const [kr, kb] = KR_KB[matrix];
  const kg = 1 - kr - kb;
  const chromaWidth = WIDTH / 2;
  const uBase = WIDTH * HEIGHT;
  const vBase = uBase + chromaWidth * (HEIGHT / 2);
  return PATCHES.map((_, index) => {
    const cx = (index % COLUMNS) * PATCH_W + PATCH_W / 2;
    const cy = Math.floor(index / COLUMNS) * PATCH_H + PATCH_H / 2;
    let ySum = 0;
    let uSum = 0;
    let vSum = 0;
    let count = 0;
    for (let y = cy - 24; y < cy + 24; y += 1) {
      for (let x = cx - 24; x < cx + 24; x += 1) {
        const chroma = (y >> 1) * chromaWidth + (x >> 1);
        ySum += yuv[y * WIDTH + x];
        uSum += yuv[uBase + chroma];
        vSum += yuv[vBase + chroma];
        count += 1;
      }
    }
    const luma = fullRange ? ySum / count / 255 : (ySum / count - 16) / 219;
    const cb = (uSum / count - 128) / (fullRange ? 255 : 224);
    const cr = (vSum / count - 128) / (fullRange ? 255 : 224);
    const r = luma + 2 * (1 - kr) * cr;
    const b = luma + 2 * (1 - kb) * cb;
    const g = (luma - kr * r - kb * b) / kg;
    return [r, g, b].map((value) => Math.min(255, Math.max(0, value * 255)));
  });
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const patches = join(workDir, 'patches.png');
  const outputs = {
    rawvideo: join(workDir, 'raw-libx264.mp4'),
    hardware: join(workDir, 'raw-hardware.mp4'),
    webcodecs: join(workDir, 'webcodecs.mp4'),
  };

  console.log('1. making the patches');
  await makePatches(patches);
  const hardware = await workingHardwareEncoder();
  console.log(`   hardware encoder on the raw pipe: ${hardware || 'none here'}`);

  if (process.env.COLOUR_SKIP_BUILD !== '1') {
    console.log('2. building the e2e harness');
    await run(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build', '-c', join(projectRoot, 'vite.e2e.config.ts')],
      { cwd: projectRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  }

  console.log('3. exporting through every path');
  const result = await runElectron({
    E2E_PATCHES: patches,
    E2E_OUT_RAW: outputs.rawvideo,
    E2E_OUT_WEBCODECS: outputs.webcodecs,
    E2E_OUT_HARDWARE: outputs.hardware,
    E2E_HW_ENCODER: hardware,
  });
  if (!result.ok) {
    console.log(`   harness failed: ${result.error}`);
    process.exit(1);
  }

  console.log('4. decoding as a BT.709 player does');
  for (const [key, how] of Object.entries(result.paths)) {
    console.log(`\n   ${key}: ${how}`);
    if (how.startsWith('skipped')) continue;
    const file = outputs[key];
    const tags = tagsOf(await streamLine(file));
    const described = tags
      ? `${tags.range}, matrix ${tags.matrix}, primaries ${tags.primaries}, transfer ${tags.transfer}`
      : 'no tags';
    // Every file: Rec.709 primaries and transfer, and a stated range and
    // matrix. The raw pipe converts with BT.709 itself, so there the matrix
    // must say BT.709 too; WebCodecs says whatever the encoder really used.
    check(
      `${key}: tagged Rec.709`,
      Boolean(tags && tags.matrix && tags.primaries === 'bt709' && tags.transfer === 'bt709'
        && (key === 'webcodecs' || (tags.matrix === 'bt709' && tags.range === 'tv'))),
      described,
    );

    const yuv = await decodeYuv(file);
    const tagged = tags && matrixFamily(tags.matrix) ? { matrix: matrixFamily(tags.matrix), fullRange: tags.range === 'pc' } : null;
    if (!tagged) {
      check(`${key}: decodes as tagged`, false, 'no usable tags');
      continue;
    }
    const decodings = [
      ['as tagged, as every player that reads tags', tagged],
      ['forced BT.709, as a player reads untagged HD', { matrix: 'bt709', fullRange: false }],
    ];
    for (const [label, how] of decodings) {
      // A stream tagged with another matrix is decoded right by every player
      // that reads tags; forcing BT.709 on it is not what a player does, so
      // that decoding is only reported.
      const informational = how !== tagged && how.matrix !== tagged.matrix;
      const means = patchMeans(yuv, how.matrix, how.fullRange);
      let worst = 0;
      let worstName = '';
      means.forEach((mean, index) => {
        const expected = PATCHES[index][1];
        const error = Math.max(...mean.map((value, c) => Math.abs(value - expected[c])));
        if (error > worst) {
          worst = error;
          worstName = `${PATCHES[index][0]} ${mean.map((v) => v.toFixed(0)).join(',')} vs ${expected.join(',')}`;
        }
      });
      if (informational) console.log(`   INFO  ${key}: ${label}: worst ${worst.toFixed(2)} (${worstName})`);
      else check(`${key}: every patch within ${TOLERANCE} levels (${label})`, worst <= TOLERANCE, `worst ${worst.toFixed(2)}: ${worstName}`);
    }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
