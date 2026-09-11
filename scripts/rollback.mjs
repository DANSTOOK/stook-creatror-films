#!/usr/bin/env node
/**
 * Roll the code back to a previous release: `npm run rollback -- v1.1.0 [--dry-run]`
 *
 * History is never rewritten. Instead of `reset --hard` and a force push -
 * which would break every other clone and lose the work being backed out - this
 * makes ONE new commit whose tree is exactly the tree of the chosen tag. The
 * rolled-back work is still in history and can be brought back with a revert
 * of that commit.
 *
 * `git restore --source` is used rather than `git revert <tag>..HEAD` because
 * a range revert stops at the first merge commit; restoring the tree handles
 * merges, added files and deleted files alike.
 *
 * After rolling back, cut a new patch release (`npm run release -- x.y.z`) so
 * the installer people download matches the code again. Existing tags and
 * releases are left alone: a published version number is never reused.
 */
import { execFileSync } from 'node:child_process';

const [tag, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');

const fail = (message) => {
  console.error(`rollback: ${message}`);
  process.exit(1);
};

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

if (!tag) {
  const tags = git('tag', '--list', 'v*', '--sort=-v:refname');
  fail(`usage: npm run rollback -- <tag> [--dry-run]\n\nreleases:\n${tags || '  (none)'}`);
}

try {
  git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`);
} catch {
  fail(`${tag} is not a tag or commit in this repository`);
}

if (git('status', '--porcelain') !== '') fail('working tree is not clean - commit or stash first');

const undone = git('log', '--oneline', `${tag}..HEAD`);
if (undone === '') fail(`HEAD is already at ${tag}; nothing to roll back`);

console.log(`rollback: these commits will be undone (they stay in history):\n${undone}\n`);

if (dryRun) {
  console.log('rollback: --dry-run, nothing changed');
  process.exit(0);
}

git('restore', `--source=${tag}`, '--staged', '--worktree', '--', '.');
git('commit', '-m', `Roll back to ${tag}\n\nUndoes:\n${undone}`);

console.log(`rollback: done. Push with "git push origin main", then cut a patch release.`);
