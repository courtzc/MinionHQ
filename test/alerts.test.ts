import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERTS,
  ALERT_KINDS,
  alertCatalog,
  browserToastTitle,
  defaultSoundOf,
  isAlertKind,
  priorityOf,
  type AlertKind,
} from '../src/shared/alerts.js';

test('alerts: every kind has every required field, no empty strings', () => {
  for (const kind of ALERT_KINDS) {
    const spec = ALERTS[kind];
    assert.ok(spec.displayName.length > 0, `${kind}.displayName empty`);
    assert.ok(spec.description.length > 0, `${kind}.description empty`);
    assert.ok(spec.defaultSound.length > 0, `${kind}.defaultSound empty`);
    assert.ok(spec.toastTitle.length > 0, `${kind}.toastTitle empty`);
    assert.ok(Number.isFinite(spec.priority), `${kind}.priority not finite`);
    assert.ok(
      ['active', 'sub', 'lifecycle', 'aspirational'].includes(spec.tier),
      `${kind}.tier invalid: ${spec.tier}`,
    );
  }
});

test('alerts: ALERT_KINDS matches the keys of ALERTS in order', () => {
  assert.deepEqual(ALERT_KINDS, Object.keys(ALERTS));
});

test('alerts: isAlertKind accepts every registered kind and rejects junk', () => {
  for (const kind of ALERT_KINDS) {
    assert.ok(isAlertKind(kind), `expected ${kind} to be a valid AlertKind`);
  }
  assert.equal(isAlertKind('definitely-not-a-kind'), false);
  assert.equal(isAlertKind(''), false);
  assert.equal(isAlertKind(undefined), false);
  assert.equal(isAlertKind(42), false);
});

test('alerts: priorityOf and defaultSoundOf round-trip through ALERTS', () => {
  for (const kind of ALERT_KINDS) {
    assert.equal(priorityOf(kind), ALERTS[kind].priority);
    assert.equal(defaultSoundOf(kind), ALERTS[kind].defaultSound);
  }
});

test('alerts: priority ordering keeps error above needs-input above agent-finished', () => {
  assert.ok(priorityOf('error') > priorityOf('needs-input'));
  assert.ok(priorityOf('needs-input') > priorityOf('agent-finished'));
  assert.ok(priorityOf('tool-failed') > priorityOf('agent-finished'));
  assert.ok(priorityOf('tool-failed') < priorityOf('needs-input'));
});

test('alerts: browserToastTitle prefixes MinionHQ and appends session label', () => {
  const sample: AlertKind = 'agent-finished';
  assert.equal(browserToastTitle(sample), 'MinionHQ: agent finished');
  assert.equal(
    browserToastTitle(sample, 'feat/data-viz'),
    'MinionHQ: agent finished — feat/data-viz',
  );
  assert.equal(browserToastTitle(sample, null), 'MinionHQ: agent finished');
});

test('alerts: alertCatalog serializes every kind with id + spec fields', () => {
  const cat = alertCatalog();
  assert.equal(cat.length, ALERT_KINDS.length);
  for (let i = 0; i < cat.length; i++) {
    const entry = cat[i];
    assert.equal(entry.id, ALERT_KINDS[i]);
    assert.equal(entry.displayName, ALERTS[entry.id].displayName);
    assert.equal(entry.defaultSound, ALERTS[entry.id].defaultSound);
    assert.equal(entry.priority, ALERTS[entry.id].priority);
    assert.equal(entry.tier, ALERTS[entry.id].tier);
  }
});
