import { execFile, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

/**
 * The grading shader on the real GPU: `npm run test:grade`
 *
 * See gradeCheck.ts. With the curves neutral and no vignette, every one of the 16.7 million
 * 8-bit colours has to come out of the new shader exactly as it came out of
 * the one it replaced; with them moved, known colours have to match the
 * reference arithmetic (color/grade.ts) within 1/255; and a 4K grading pass
 * is timed before and after. Runs in a window that is never shown.
 */

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const electronBinary = require('electron');
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');

const checks = [];
const check = (name, passed, detail = '') => {
  checks.push(passed);
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

function runHarness() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronBinary, [join(projectRoot, 'dist-e2e/main/main.js')], {
      env: {
        ...process.env,
        E2E_MODE: 'grade',
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

async function main() {
  if (process.env.GRADE_SKIP_BUILD !== '1') {
    console.log('1. building the e2e harness');
    await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build', '-c', join(projectRoot, 'vite.e2e.config.ts')],
      { cwd: projectRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 16 * 1024 * 1024 });
  }
  console.log('2. running the shaders on the GPU');
  const result = await runHarness();
  if (!result.ok) {
    console.log(`   harness failed: ${result.error}`);
    process.exit(1);
  }

  console.log('\n   every 8-bit colour, phase-2 shader against this one, curves neutral, no vignette');
  for (const row of result.identity) {
    check(`${row.name}: identical`, row.differentValues === 0,
      `${row.colours.toLocaleString('en-US')} colours, ${row.differentValues} values differ, ${row.differentBytes} 8-bit levels differ, worst ${(row.worst * 255).toFixed(4)}/255`);
  }

  console.log('\n   known colours through curves, wheels and vignettes, against the reference');
  for (const row of result.reference) {
    check(`${row.name}: within 1/255`, row.worst <= 1 / 255, `${row.colours} values, worst ${(row.worst * 255).toFixed(3)}/255`);
  }

  const green = result.redToGreen ?? [];
  check('Hue vs Hue: pure red turned a third of a turn is green', green.length === 3 && green[0] <= 3 && green[1] >= 252 && green[2] <= 3,
    `255,0,0 -> ${green.join(',')}`);

  console.log('\n   a grading pass at 3840x2160 (with a LUT)');
  for (const row of result.timing) console.log(`   ${row.name}: ${row.msPerPass.toFixed(3)} ms`);
  const [previous, neutral, levels, all] = result.timing.map((row) => row.msPerPass);
  check('neutral curves cost nothing, and everything on adds under a millisecond', neutral - previous < 0.2 && all - previous < 1,
    `${previous.toFixed(2)} -> ${neutral.toFixed(2)} (neutral) / ${levels.toFixed(2)} (levels, vignette, dither) / ${all.toFixed(2)} ms (all curves)`);

  console.log('\n   dither on a smooth 4K gradient, read back as the export reads it');
  const d = result.dither;
  console.log(`   without: longest run ${d.withoutDither.longestRun} px, ${d.withoutDither.steps} changes, banding ${d.withoutDither.bandError.toFixed(3)} levels`);
  console.log(`   with:    longest run ${d.withDither.longestRun} px, ${d.withDither.steps} changes, banding ${d.withDither.bandError.toFixed(3)} levels`);
  check('dither breaks up the bands (longest flat run at least 4x shorter)', d.withDither.longestRun * 4 <= d.withoutDither.longestRun,
    `${d.withoutDither.longestRun} -> ${d.withDither.longestRun} px`);
  check('and averages closer to the true gradient (banding error at least halved)', d.withDither.bandError * 2 <= d.withoutDither.bandError,
    `${d.withoutDither.bandError.toFixed(3)} -> ${d.withDither.bandError.toFixed(3)} levels`);
  check('the same frame dithers the same every time', d.reproducible);
  check('the next frame gets a different pattern', d.changesPerFrame);
  check('an ungraded picture is left exactly as it was', d.untouchedPixelsChanged === 0, `${d.untouchedPixelsChanged} pixels changed`);

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
