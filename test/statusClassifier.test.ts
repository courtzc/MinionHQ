import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/server/statusClassifier.js';

const b = (s: string) => Buffer.from(s, 'utf8');

test('classify: empty/whitespace returns null', () => {
  assert.equal(classify(b(''), 'idle'), null);
  assert.equal(classify(b('   \n  '), 'idle'), null);
});

test('classify: error patterns take priority', () => {
  assert.equal(classify(b('Error: something broke'), 'idle'), 'error');
  assert.equal(classify(b('FAILED: build did not pass'), 'working'), 'error');
  assert.equal(classify(b('Traceback (most recent call last):'), 'idle'), 'error');
});

test('classify: needs-input on y/n prompt', () => {
  assert.equal(classify(b('Continue? [y/n]'), 'working'), 'needs-input');
  assert.equal(classify(b('Proceed (yes/no)'), 'idle'), 'needs-input');
  assert.equal(classify(b('Do you want to apply these changes?'), 'idle'), 'needs-input');
});

test('classify: needs-input on bare prompt arrow', () => {
  assert.equal(classify(b('\n❯\n'), 'idle'), 'needs-input');
});

test('classify: working on spinner / thinking words', () => {
  assert.equal(classify(b('thinking...'), 'idle'), 'working');
  assert.equal(classify(b('⠋ Analyzing...'), 'idle'), 'working');
});

test('classify: idle transition only from working with trailing blanks', () => {
  // From working, with trailing blank lines → idle
  assert.equal(classify(b('something done\n\n'), 'working'), 'idle');
  // From idle, the same chunk would not flip to idle (no transition)
  assert.equal(classify(b('something done\n\n'), 'idle'), null);
});

test('classify: error beats needs-input when both match', () => {
  assert.equal(classify(b('Error: continue? [y/n]'), 'idle'), 'error');
});
