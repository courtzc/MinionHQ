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

import { mkdirSync, readFileSync, existsSync as _exists } from 'node:fs';
import { mirrorWorkingDirState, createWorktree } from '../src/server/worktrees.js';

test('mirrorWorkingDirState: copies gitignored AND untracked files, skips tracked, skips .git', () => {
  const src = makeTempRepo();
  const dst = mkdtempSync(join(tmpdir(), 'mhq-wt-dst-'));
  try {
    writeFileSync(join(src, '.gitignore'), '.env\nscratch/\nnode_modules/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: src });
    execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: src });

    writeFileSync(join(src, '.env'), 'SECRET=abc');
    mkdirSync(join(src, 'scratch'), { recursive: true });
    writeFileSync(join(src, 'scratch', 'notes.md'), 'wip');
    mkdirSync(join(src, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(src, 'node_modules', 'foo', 'index.js'), 'module.exports=1;');
    writeFileSync(join(src, 'untracked.md'), 'in progress');

    writeFileSync(join(dst, 'README.md'), 'tracked-content');

    const res = mirrorWorkingDirState(src, dst);
    assert.ok(res.entries >= 4, `expected >=4 entries, got ${res.entries}`);
    assert.equal(res.failures.length, 0);

    assert.equal(readFileSync(join(dst, '.env'), 'utf8'), 'SECRET=abc');
    assert.equal(readFileSync(join(dst, 'scratch', 'notes.md'), 'utf8'), 'wip');
    assert.equal(readFileSync(join(dst, 'node_modules', 'foo', 'index.js'), 'utf8'), 'module.exports=1;');
    assert.equal(readFileSync(join(dst, 'untracked.md'), 'utf8'), 'in progress');
    assert.equal(readFileSync(join(dst, 'README.md'), 'utf8'), 'tracked-content');
    assert.equal(_exists(join(dst, '.git')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('mirrorWorkingDirState: snapshot is isolated — editing in dst does not touch source', () => {
  const src = makeTempRepo();
  const dst = mkdtempSync(join(tmpdir(), 'mhq-wt-dst-'));
  try {
    writeFileSync(join(src, '.gitignore'), '.env\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: src });
    execFileSync('git', ['commit', '-q', '-m', 'gi'], { cwd: src });
    writeFileSync(join(src, '.env'), 'V=1');

    mirrorWorkingDirState(src, dst);
    writeFileSync(join(dst, '.env'), 'V=2');

    assert.equal(readFileSync(join(src, '.env'), 'utf8'), 'V=1');
    assert.equal(readFileSync(join(dst, '.env'), 'utf8'), 'V=2');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('createWorktree: mirrors gitignored content into new worktree', () => {
  const src = makeTempRepo();
  try {
    writeFileSync(join(src, '.gitignore'), '.env\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: src });
    execFileSync('git', ['commit', '-q', '-m', 'gi'], { cwd: src });
    writeFileSync(join(src, '.env'), 'TOKEN=xyz');

    const wt = createWorktree({ sessionId: 'test1234', repoPath: src, branchName: 'feat/test-mirror' });
    try {
      assert.equal(readFileSync(join(wt.worktreePath, '.env'), 'utf8'), 'TOKEN=xyz');
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wt.worktreePath], { cwd: src });
    }
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});
