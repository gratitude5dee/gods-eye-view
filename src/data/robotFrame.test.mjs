import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CLOCK_SKEW_MS,
  MAX_FRAMES_PER_BATCH,
  PROVENANCE_LABELS,
  ROBOT_ID_GRAMMAR,
  provenanceChip,
  toEllipsoidHeightM,
  validateRobotFrame,
  validateRobotFrameBatch,
} from './robotFrame.js';

const NOW = 1756500000000;

function goodFrame(overrides = {}) {
  return {
    v: 1,
    id: 'g1-01',
    t: NOW,
    pose: { lat: 27.8361, lon: 86.7644, altM: 3867, headingDeg: 25, pitchDeg: 0, rollDeg: 0 },
    datum: 'egm96-orthometric',
    fix: { source: 'fused', hAccM: 2.5, vAccM: 4.0, sats: 11 },
    vel: { speedMps: 0.9, courseDeg: 25 },
    gait: { fsm: 'walk', footForce: [180, 20], contact: [true, false], cadenceHz: 1.8, strideM: 0.42 },
    power: { soc: 82, voltV: 51.2, currentA: 4.1, tempC: 38 },
    provenance: { source: 'synthetic', label: 'SIMULATED', confidence: 1.0 },
    ...overrides,
  };
}

test('accepts a canonical synthetic frame', () => {
  assert.deepEqual(validateRobotFrame(goodFrame(), { nowMs: NOW }), { ok: true });
});

test('id grammar rejects uppercase, long, and empty ids', () => {
  for (const id of ['G1-01', 'a'.repeat(17), '', 'has space', 'ünïcode']) {
    assert.equal(ROBOT_ID_GRAMMAR.test(id), false, id);
    assert.equal(validateRobotFrame(goodFrame({ id }), { nowMs: NOW }).ok, false, id);
  }
  assert.equal(ROBOT_ID_GRAMMAR.test('g1_01~x-9'), true);
});

test('timestamps outside ±24h of server time are malformed', () => {
  const early = goodFrame({ t: NOW - MAX_CLOCK_SKEW_MS - 1 });
  const late = goodFrame({ t: NOW + MAX_CLOCK_SKEW_MS + 1 });
  assert.equal(validateRobotFrame(early, { nowMs: NOW }).ok, false);
  assert.equal(validateRobotFrame(late, { nowMs: NOW }).ok, false);
  const edge = goodFrame({ t: NOW + MAX_CLOCK_SKEW_MS });
  assert.equal(validateRobotFrame(edge, { nowMs: NOW }).ok, true);
});

test('rejects out-of-range pose, datum, fix source, gait state', () => {
  const bad = [
    goodFrame({ pose: { ...goodFrame().pose, lat: 91 } }),
    goodFrame({ pose: { ...goodFrame().pose, lon: -181 } }),
    goodFrame({ datum: 'msl' }),
    goodFrame({ fix: { source: 'wifi' } }),
    goodFrame({ gait: { fsm: 'moonwalk' } }),
    goodFrame({ v: 2 }),
    goodFrame({ power: { soc: 101 } }),
  ];
  for (const frame of bad) {
    assert.equal(validateRobotFrame(frame, { nowMs: NOW }).ok, false);
  }
});

test('provenance label must match source and confidence must be 0..1', () => {
  const mislabeled = goodFrame({ provenance: { source: 'synthetic', label: 'LIVE', confidence: 1 } });
  assert.equal(validateRobotFrame(mislabeled, { nowMs: NOW }).ok, false);
  const overconfident = goodFrame({ provenance: { source: 'synthetic', label: 'SIMULATED', confidence: 1.5 } });
  assert.equal(validateRobotFrame(overconfident, { nowMs: NOW }).ok, false);
  assert.equal(PROVENANCE_LABELS['live-g1'], 'LIVE');
});

test('batch validation rejects the whole batch — no prefix salvage', () => {
  const batch = [goodFrame(), goodFrame({ id: 'BAD' }), goodFrame()];
  const result = validateRobotFrameBatch(batch, { nowMs: NOW });
  assert.equal(result.ok, false);
  assert.match(result.error, /frame\[1\]/);
});

test('batch validation enforces size limits', () => {
  assert.equal(validateRobotFrameBatch([], { nowMs: NOW }).ok, false);
  assert.equal(validateRobotFrameBatch(goodFrame(), { nowMs: NOW }).ok, false);
  const over = Array.from({ length: MAX_FRAMES_PER_BATCH + 1 }, () => goodFrame());
  assert.equal(validateRobotFrameBatch(over, { nowMs: NOW }).ok, false);
  const full = Array.from({ length: MAX_FRAMES_PER_BATCH }, () => goodFrame());
  assert.equal(validateRobotFrameBatch(full, { nowMs: NOW }).ok, true);
});

test('datum conversion to ellipsoid height', () => {
  assert.equal(toEllipsoidHeightM(100, 'wgs84-ellipsoid'), 100);
  assert.equal(toEllipsoidHeightM(100, 'egm96-orthometric', { geoidN: -30 }), 70);
  assert.equal(toEllipsoidHeightM(100, 'egm96-orthometric', {}), null);
  assert.equal(toEllipsoidHeightM(1.2, 'agl', { groundEllipsoidM: 3900 }), 3901.2);
  assert.equal(toEllipsoidHeightM(1.2, 'slam-local', {}), null);
  assert.equal(toEllipsoidHeightM(NaN, 'wgs84-ellipsoid'), null);
});

test('provenance chip appends VIRTUAL TRANSPOSITION when staged', () => {
  assert.equal(provenanceChip(goodFrame()), 'SIMULATED');
  assert.equal(provenanceChip({ ...goodFrame(), transposed: true }), 'SIMULATED · VIRTUAL TRANSPOSITION');
});
