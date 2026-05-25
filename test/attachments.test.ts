import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_ID_RE,
  sanitizeAttachmentName,
  assertInside,
  buildAttachmentPath,
} from '../src/server/attachments.js';

test('SESSION_ID_RE accepts UUID-shaped ids', () => {
  assert.ok(SESSION_ID_RE.test('00549723-2c09-48b7-ba5e-f41ff76e3d17'));
  assert.ok(SESSION_ID_RE.test('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
  assert.ok(SESSION_ID_RE.test('1234abcd'));
});

test('SESSION_ID_RE rejects path-traversal and short ids', () => {
  assert.ok(!SESSION_ID_RE.test('../etc'));
  assert.ok(!SESSION_ID_RE.test('a/b/c'));
  assert.ok(!SESSION_ID_RE.test('short'));
  assert.ok(!SESSION_ID_RE.test('not-hex-zzzz'));
  assert.ok(!SESSION_ID_RE.test(''));
});

test('sanitizeAttachmentName strips path separators and unsafe chars', () => {
  assert.equal(sanitizeAttachmentName('screenshot.png'), 'screenshot.png');
  // Slashes become underscores; dots survive (they're harmless inside a
  // basename — `..` as a literal filename does not traverse).
  assert.equal(sanitizeAttachmentName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeAttachmentName('foo bar.png'), 'foo_bar.png');
  assert.equal(sanitizeAttachmentName('weird;rm -rf /.png'), 'weird_rm_-rf__.png');
});

test('sanitizeAttachmentName falls back when input is empty after sanitising', () => {
  assert.equal(sanitizeAttachmentName(''), 'attachment.bin');
  // 80-char cap: long names get tail-trimmed
  const long = 'a'.repeat(200) + '.png';
  const out = sanitizeAttachmentName(long);
  assert.ok(out.length <= 80, `expected <= 80 chars, got ${out.length}`);
  assert.ok(out.endsWith('.png'), 'extension should survive the tail-trim');
});

test('assertInside accepts a real child and rejects an escape', () => {
  assertInside('/var/data', '/var/data/foo.txt');
  assertInside('/var/data', '/var/data');
  assert.throws(() => assertInside('/var/data', '/var/other/foo.txt'));
  assert.throws(() => assertInside('/var/data', '/etc/passwd'));
});

test('buildAttachmentPath produces a contained path with a timestamp prefix', () => {
  const { path, name } = buildAttachmentPath('/tmp/mhq', 'pic.png', 1700000000000);
  assert.equal(name, 'pic.png');
  assert.equal(path, '/tmp/mhq/1700000000000-pic.png');
});

test('buildAttachmentPath neutralises a traversal attempt in the name', () => {
  // The sanitiser turns `../` into underscores, so the resulting path stays
  // inside the base directory — but we also keep the assertInside check
  // as a hard invariant for future maintainers.
  const { path } = buildAttachmentPath('/tmp/mhq', '../../etc/passwd', 1700000000000);
  assert.ok(path.startsWith('/tmp/mhq/'), `expected contained path, got ${path}`);
  assert.ok(!path.includes('/etc/'), `path should not contain a literal /etc/ segment, got ${path}`);
});
