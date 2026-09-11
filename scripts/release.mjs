#!/usr/bin/env node
/**
 * Cut a release: `npm run release -- 1.2.0 [--push]`
 *
 * 1. Refuses to run on a dirty tree or off `main`.
 * 2. Requires a `## v1.2.0` section in CHANGELOG.md - that section becomes the
 *    release notes, so a release with nothing written about it cannot happen.
 * 3. Runs the typecheck and the unit suite.
 * 4. Bumps package.json and package-lock.json, commits, and creates an
 *    annotated tag carrying the notes.
 * 5. With --push, pushes main and the tag. The tag push is what triggers
 *    .github/workflows/release.yml, which builds the installer and publishes
 *    the GitHub Release.
 *
 * Tools run through `node` on their real entry points, for the same reason
 * the npm scripts do (see the note in package.json).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [version, ...flags] = process.argv.slice(2);
const push = flags.includes('--push');

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const node = (...args) => execFileSync(process.execPath, args, { stdio: 'inherit' });

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? '')) {
  fail('usage: npm run release -- <x.y.z | x.y.z-beta.N> [--push]');
}

const tag = `v${version}`;

if (git('status', '--porcelain') !== '') fail('working tree is not clean - commit or stash first');
if (git('branch', '--show-current') !== 'main') fail('releases are cut from main');
if (git('tag', '--list', tag) !== '') fail(`${tag} already exists`);

// The release notes are the changelog section, verbatim.
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const heading = new RegExp(`^## ${tag.replace(/\./g, '\\.')}\\b.*$`, 'm');
const match = heading.exec(changelog);
if (!match) fail(`CHANGELOG.md has no "## ${tag}" section - write it first`);

const rest = changelog.slice(match.index + match[0].length);
const next = rest.search(/^## /m);
const notes = `${match[0].replace(/^## /, '')}\n${(next === -1 ? rest : rest.slice(0, next)).trim()}`
  .replace(/\n---\s*$/, '');

console.log(`release: checking ${tag}`);
node('./node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json');
node('./node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.node.json');
node('./node_modules/vitest/vitest.mjs', 'run');

for (const file of ['package.json', 'package-lock.json']) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  if (json.packages?.['']) json.packages[''].version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

git('add', 'package.json', 'package-lock.json');
if (git('diff', '--cached', '--name-only') !== '') git('commit', '-m', `Release ${tag}`);
git('tag', '-a', tag, '-m', notes);

console.log(`release: tagged ${tag}`);

if (push) {
  git('push', 'origin', 'main');
  git('push', 'origin', tag);
  console.log('release: pushed - GitHub Actions is building the installer now');
} else {
  console.log(`release: nothing pushed. To publish:\n  git push origin main\n  git push origin ${tag}`);
}
