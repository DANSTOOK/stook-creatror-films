import { execFile, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

/**
 * The grading shader on the real GPU: `npm run test:grade`
 *
 * See gradeCheck.ts. With the wheels neutral, every one of the 16.7 million
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

  console.log('\n   every 8-bit colour, phase-1 shader against this one, wheels neutral');
  for (const row of result.identity) {
    const exact = row.name.includes('LUT at 60%') ? row.differentBytes === 0 : row.differentValues === 0;
    check(`${row.name}: identical`, exact,
      `${row.colours.toLocaleString('en-US')} colours, ${row.differentValues} values differ, ${row.differentBytes} 8-bit levels differ, worst ${(row.worst * 255).toFixed(4)}/255`);
  }

  console.log('\n   known colours through moved wheels, against color/grade.ts');
  for (const row of result.reference) {
    check(`${row.name}: within 1/255`, row.worst <= 1 / 255, `${row.colours} colours, worst ${(row.worst * 255).toFixed(3)}/255`);
  }

  console.log('\n   a grading pass at 3840x2160 (with a LUT)');
  for (const row of result.timing) console.log(`   ${row.name}: ${row.msPerPass.toFixed(3)} ms`);
  const [legacy, neutral, wheels] = result.timing.map((row) => row.msPerPass);
  check('the wheels add under a millisecond to a 4K pass', wheels - legacy < 1 && neutral - legacy < 1,
    `${legacy.toFixed(2)} -> ${neutral.toFixed(2)} (neutral) / ${wheels.toFixed(2)} ms (all four)`);

  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
