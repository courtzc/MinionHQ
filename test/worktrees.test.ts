import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitRepo, repoToplevel, listBranches, currentBranch, expandHome } from '../src/server/worktrees.js';

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mhq-wt-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'hello');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('isGitRepo: true for a real repo, false for a plain dir', () => {
  const dir = makeTempRepo();
  try {
    assert.equal(isGitRepo(dir), true);
    const plain = mkdtempSync(join(tmpdir(), 'mhq-plain-'));
    try { assert.equal(isGitRepo(plain), false); } finally { rmSync(plain, { recursive: true, force: true }); }
    assert.equal(isGitRepo('/does/not/exist'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoToplevel: returns resolved top-level', () => {
  const dir = makeTempRepo();
  try {
    const top = repoToplevel(dir);
    // On macOS /tmp may resolve to /private/tmp; just check the basenames line up.
    assert.ok(top.endsWith(dir.split('/').pop()!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listBranches / currentBranch: report main', () => {
  const dir = makeTempRepo();
  try {
    assert.deepEqual(listBranches(dir), ['main']);
    assert.equal(currentBranch(dir), 'main');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandHome: leading ~/ expansion', () => {
  const exp = expandHome('~/x/y');
  assert.ok(exp.endsWith('/x/y'));
  assert.ok(!exp.startsWith('~'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome('rel/path'), 'rel/path');
});
