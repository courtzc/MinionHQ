import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertDispatcher, alertKindFor, type AlertKind } from '../src/web/alertDispatcher.js';

// ─── Pure decision rules ───────────────────────────────────────────────

test('alertKindFor: spawning → idle does NOT fire (the killer false positive)', () => {
  assert.equal(alertKindFor('spawning', 'idle'), null);
});

test('alertKindFor: working → idle fires agent-finished', () => {
  assert.equal(alertKindFor('working', 'idle'), 'agent-finished');
});

test('alertKindFor: any → needs-input fires needs-input', () => {
  assert.equal(alertKindFor('idle', 'needs-input'), 'needs-input');
  assert.equal(alertKindFor('working', 'needs-input'), 'needs-input');
  assert.equal(alertKindFor('spawning', 'needs-input'), 'needs-input');
});

test('alertKindFor: any → error fires error', () => {
  assert.equal(alertKindFor('idle', 'error'), 'error');
  assert.equal(alertKindFor('working', 'error'), 'error');
});

test('alertKindFor: same-state transitions never fire', () => {
  assert.equal(alertKindFor('idle', 'idle'), null);
  assert.equal(alertKindFor('needs-input', 'needs-input'), null);
  assert.equal(alertKindFor('error', 'error'), null);
});

test('alertKindFor: idle → working does NOT fire (user input, not an event)', () => {
  assert.equal(alertKindFor('idle', 'working'), null);
});

test('alertKindFor: error → idle does NOT re-fire', () => {
  assert.equal(alertKindFor('error', 'idle'), null);
});

// ─── Debouncer behavior with fake timers ───────────────────────────────

interface FakeTimer { id: number; cb: () => void; due: number; cancelled: boolean; }

class FakeClock {
  private now = 0;
  private next = 1;
  private timers: FakeTimer[] = [];
  setTimer = (cb: () => void, ms: number): unknown => {
    const t: FakeTimer = { id: this.next++, cb, due: this.now + ms, cancelled: false };
    this.timers.push(t);
    return t;
  };
  clearTimer = (h: unknown): void => {
    (h as FakeTimer).cancelled = true;
  };
  advance(ms: number): void {
    this.now += ms;
    const due = this.timers.filter((t) => !t.cancelled && t.due <= this.now);
    this.timers = this.timers.filter((t) => t.cancelled || t.due > this.now);
    for (const t of due) t.cb();
  }
}

function setup() {
  const clock = new FakeClock();
  const fired: { id: string; kind: AlertKind }[] = [];
  const d = new AlertDispatcher({
    windowMs: 500,
    fire: (id, kind) => fired.push({ id, kind }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { d, clock, fired };
}

test('dispatcher: single transition fires once after the window', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'working', 'idle');
  clock.advance(499);
  assert.deepEqual(fired, []);
  clock.advance(1);
  assert.deepEqual(fired, [{ id: 's1', kind: 'agent-finished' }]);
});

test('dispatcher: spawning → idle never fires (no chime on spawn)', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'spawning', 'idle');
  clock.advance(5000);
  assert.deepEqual(fired, []);
});

test('dispatcher: working → idle → needs-input within window fires ONLY needs-input', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'working', 'idle');         // would-be agent-finished
  clock.advance(120);
  d.onTransition('s1', 'idle', 'needs-input');     // upgrades to needs-input
  clock.advance(500);
  assert.deepEqual(fired, [{ id: 's1', kind: 'needs-input' }]);
});

test('dispatcher: needs-input then a late working → idle does NOT downgrade', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'idle', 'needs-input');
  clock.advance(50);
  d.onTransition('s1', 'needs-input', 'working');   // null, no effect
  d.onTransition('s1', 'working', 'idle');          // agent-finished (priority 1)
  clock.advance(500);
  // needs-input has higher priority — it must win.
  assert.deepEqual(fired, [{ id: 's1', kind: 'needs-input' }]);
});

test('dispatcher: error always wins inside a window', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'working', 'idle');
  clock.advance(50);
  d.onTransition('s1', 'idle', 'needs-input');
  clock.advance(50);
  d.onTransition('s1', 'needs-input', 'error');
  clock.advance(500);
  assert.deepEqual(fired, [{ id: 's1', kind: 'error' }]);
});

test('dispatcher: each session debounces independently', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'working', 'idle');
  d.onTransition('s2', 'idle', 'needs-input');
  clock.advance(500);
  assert.equal(fired.length, 2);
  assert.ok(fired.find((f) => f.id === 's1' && f.kind === 'agent-finished'));
  assert.ok(fired.find((f) => f.id === 's2' && f.kind === 'needs-input'));
});

test('dispatcher: cancel() prevents pending alert from firing', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'working', 'idle');
  d.cancel('s1');
  clock.advance(500);
  assert.deepEqual(fired, []);
});

test('dispatcher: two events well outside the window fire twice', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'working', 'idle');
  clock.advance(500);
  d.onTransition('s1', 'idle', 'needs-input');
  clock.advance(500);
  assert.deepEqual(fired, [
    { id: 's1', kind: 'agent-finished' },
    { id: 's1', kind: 'needs-input' },
  ]);
});

test('dispatcher: rapid transitions inside the window reset the timer', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'working', 'idle');
  clock.advance(400);
  d.onTransition('s1', 'idle', 'working');   // null, but also doesn't reset
  clock.advance(99);
  assert.deepEqual(fired, []);
  clock.advance(1);
  assert.deepEqual(fired, [{ id: 's1', kind: 'agent-finished' }]);
});

test('dispatcher: a same-state transition is a no-op', () => {
  const { d, clock, fired } = setup();
  d.onTransition('s1', 'idle', 'idle');
  clock.advance(500);
  assert.deepEqual(fired, []);
});
