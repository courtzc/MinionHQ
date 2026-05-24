import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIN_PTY_DATA, BIN_PTY_INPUT, BIN_HEADER_SIZE, uuidToBytes, bytesToUuid } from '../src/shared/binProtocol.js';

test('binProtocol: header constants', () => {
  assert.equal(BIN_HEADER_SIZE, 17);
  assert.notEqual(BIN_PTY_DATA, BIN_PTY_INPUT);
});

test('binProtocol: uuid round-trip', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const out = new Uint8Array(16);
  uuidToBytes(uuid, out, 0);
  assert.equal(bytesToUuid(out, 0), uuid);
});

test('binProtocol: uuid round-trip with offset', () => {
  const uuid = '00112233-4455-6677-8899-aabbccddeeff';
  const out = new Uint8Array(20);
  uuidToBytes(uuid, out, 4);
  assert.equal(bytesToUuid(out, 4), uuid);
  // Verify the first 4 bytes were left untouched.
  for (let i = 0; i < 4; i++) assert.equal(out[i], 0);
});

test('binProtocol: rejects malformed uuids', () => {
  const out = new Uint8Array(16);
  assert.throws(() => uuidToBytes('not-a-uuid', out, 0));
  assert.throws(() => uuidToBytes('550e8400', out, 0));
});

test('binProtocol: lowercase uuid bytes are emitted with zero-padding', () => {
  const uuid = '00000000-0000-0000-0000-000000000001';
  const out = new Uint8Array(16);
  uuidToBytes(uuid, out, 0);
  for (let i = 0; i < 15; i++) assert.equal(out[i], 0);
  assert.equal(out[15], 1);
  assert.equal(bytesToUuid(out, 0), uuid);
});
