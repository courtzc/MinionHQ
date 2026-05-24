import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../src/server/ringBuffer.js';

test('RingBuffer: empty snapshot is zero-length', () => {
  const rb = new RingBuffer(16);
  assert.equal(rb.length, 0);
  assert.equal(rb.snapshot().length, 0);
});

test('RingBuffer: append below capacity preserves all bytes in order', () => {
  const rb = new RingBuffer(16);
  rb.append(Buffer.from('hello'));
  rb.append(Buffer.from(' world'));
  assert.equal(rb.length, 11);
  assert.equal(rb.snapshot().toString('utf8'), 'hello world');
});

test('RingBuffer: append at exact capacity', () => {
  const rb = new RingBuffer(5);
  rb.append(Buffer.from('hello'));
  assert.equal(rb.length, 5);
  assert.equal(rb.snapshot().toString('utf8'), 'hello');
});

test('RingBuffer: overflow drops oldest bytes (single big chunk)', () => {
  const rb = new RingBuffer(4);
  rb.append(Buffer.from('abcdefgh'));
  assert.equal(rb.length, 4);
  assert.equal(rb.snapshot().toString('utf8'), 'efgh');
});

test('RingBuffer: overflow across multiple chunks wraps correctly', () => {
  const rb = new RingBuffer(6);
  rb.append(Buffer.from('abcd'));
  rb.append(Buffer.from('efgh'));
  // Capacity 6, total written 8 → newest 6 remain.
  assert.equal(rb.length, 6);
  assert.equal(rb.snapshot().toString('utf8'), 'cdefgh');
});

test('RingBuffer: zero-byte chunk is a no-op', () => {
  const rb = new RingBuffer(4);
  rb.append(Buffer.from('ab'));
  rb.append(Buffer.alloc(0));
  assert.equal(rb.length, 2);
  assert.equal(rb.snapshot().toString('utf8'), 'ab');
});

test('RingBuffer: clear resets length but allows new writes', () => {
  const rb = new RingBuffer(4);
  rb.append(Buffer.from('xyz'));
  rb.clear();
  assert.equal(rb.length, 0);
  rb.append(Buffer.from('ab'));
  assert.equal(rb.snapshot().toString('utf8'), 'ab');
});

test('RingBuffer: rejects non-positive capacity', () => {
  assert.throws(() => new RingBuffer(0));
  assert.throws(() => new RingBuffer(-1));
});
