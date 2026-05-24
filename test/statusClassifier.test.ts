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

test('classify: needs-input on Copilot CLI Ink-style prompts', () => {
  // Leading "? " glyph as Ink renders confirmation widgets.
  assert.equal(classify(b('? Run this command?'), 'working'), 'needs-input');
  // Arrow-key chooser items.
  assert.equal(classify(b('❯ Yes\n  No'), 'working'), 'needs-input');
  assert.equal(classify(b('› No\n  Yes'), 'working'), 'needs-input');
  assert.equal(classify(b('> Yes\n  No'), 'working'), 'needs-input');
  // Hint copy under interactive lists.
  assert.equal(classify(b('Select an option (use arrow keys)'), 'working'), 'needs-input');
});

test('classify: needs-input on bare question-ending chunk', () => {
  // Last-resort: the chunk ends with a question — the agent stopped writing
  // having just asked something. Distinct from mid-stream "?" chatter.
  assert.equal(classify(b('Would you like me to do X?\n'), 'working'), 'needs-input');
  assert.equal(classify(b('Should I rename it?'), 'working'), 'needs-input');
});

test('classify: idle on bare prompt arrow (agent finished a turn)', () => {
  // A bare ">"/"❯" prompt means the agent is ready for the next message —
  // that's "idle" / agent-finished, not "needs-input". (See classifier
  // IDLE_PROMPT_PATTERNS.)
  assert.equal(classify(b('\n❯\n'), 'working'), 'idle');
  assert.equal(classify(b('\n>\n'), 'idle'), 'idle');
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
