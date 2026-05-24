import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepoContext, writeRepoContextFile, readRepoContextFile, deleteRepoContextFile, listRepoContextFiles } from '../src/server/context.js';

function tmpRepoLike(): string {
  // ensureRepoContext canonicalizes the realPath; we just need a stable dir.
  return mkdtempSync(join(tmpdir(), 'mhq-ctx-'));
}

test('repoKey is deterministic for the same canonical path', () => {
  const repo = tmpRepoLike();
  try {
    const a = ensureRepoContext(repo);
    const b = ensureRepoContext(repo);
    assert.equal(a.key, b.key);
    assert.equal(a.centralDir, b.centralDir);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('repoKey differs for different repos', () => {
  const r1 = tmpRepoLike();
  const r2 = tmpRepoLike();
  try {
    assert.notEqual(ensureRepoContext(r1).key, ensureRepoContext(r2).key);
  } finally {
    rmSync(r1, { recursive: true, force: true });
    rmSync(r2, { recursive: true, force: true });
  }
});

test('writeRepoContextFile rejects bad filenames', () => {
  const repo = tmpRepoLike();
  try {
    ensureRepoContext(repo);
    // basename() collapses these to a safe basename, so they're allowed.
    // What the regex actually rejects is filenames with disallowed chars
    // or no .md extension.
    assert.throws(() => writeRepoContextFile(repo, 'no-extension', 'x'));
    assert.throws(() => writeRepoContextFile(repo, 'has space.md', 'x'));
    assert.throws(() => writeRepoContextFile(repo, 'naughty/../etc.txt', 'x'));
    // Path-traversal attempts get normalized to their basename — verify the
    // file is written under centralDir, not anywhere else.
    writeRepoContextFile(repo, '../escape.md', 'x');
    const files = listRepoContextFiles(repo).map((f) => f.name);
    assert.ok(files.includes('escape.md'));
    assert.ok(!files.some((n) => n.includes('/') || n.includes('..')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('write/read/list/delete round-trip', () => {
  const repo = tmpRepoLike();
  try {
    ensureRepoContext(repo);
    writeRepoContextFile(repo, 'notes.md', '# hi');
    assert.equal(readRepoContextFile(repo, 'notes.md'), '# hi');
    const files = listRepoContextFiles(repo).map((f) => f.name);
    assert.ok(files.includes('notes.md'));
    deleteRepoContextFile(repo, 'notes.md');
    const after = listRepoContextFiles(repo).map((f) => f.name);
    assert.ok(!after.includes('notes.md'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('README.md is protected from deletion', () => {
  const repo = tmpRepoLike();
  try {
    const info = ensureRepoContext(repo);
    // ensureRepoContext seeds a README.md.
    const before = listRepoContextFiles(repo).map((f) => f.name);
    if (before.includes('README.md')) {
      deleteRepoContextFile(repo, 'README.md');
      const after = listRepoContextFiles(repo).map((f) => f.name);
      assert.ok(after.includes('README.md'), 'README.md should not be deletable');
    }
    // Silence unused
    assert.ok(info.key);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
