import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROBOT_COAST_LIMIT_MS,
  fixDistanceM,
  pushFix,
  robotPoseAt,
} from './robotMotion.js';

function fix(t, lat, lon, extra = {}) {
  return { t, lat, lon, elevM: 3800, headingDeg: 0, speedMps: 1, ...extra };
}

test('interpolates linearly between two fixes', () => {
  const fixes = [fix(1000, 27.0, 86.0), fix(2000, 27.001, 86.001)];
  const pose = robotPoseAt(fixes, 1500);
  assert.ok(Math.abs(pose.lat - 27.0005) < 1e-9);
  assert.ok(Math.abs(pose.lon - 86.0005) < 1e-9);
  assert.equal(pose.stale, false);
});

test('clamps before the oldest fix', () => {
  const fixes = [fix(1000, 27, 86), fix(2000, 28, 87)];
  const pose = robotPoseAt(fixes, 500);
  assert.equal(pose.lat, 27);
  assert.equal(pose.lon, 86);
});

test('coasting is bounded — no drift after the limit', () => {
  const fixes = [fix(1000, 27, 86, { headingDeg: 0, speedMps: 1 })];
  const atLimit = robotPoseAt(fixes, 1000 + ROBOT_COAST_LIMIT_MS);
  const wayPast = robotPoseAt(fixes, 1000 + ROBOT_COAST_LIMIT_MS + 60000);
  assert.equal(wayPast.lat, atLimit.lat);
  assert.equal(wayPast.lon, atLimit.lon);
  assert.equal(wayPast.stale, true);
  assert.equal(atLimit.stale, false);
  // Coast distance at the bound: 1 m/s * 1.5 s = 1.5 m north.
  const coastM = fixDistanceM(fixes[0], wayPast);
  assert.ok(Math.abs(coastM - 1.5) < 0.1, `${coastM}`);
});

test('empty history returns null', () => {
  assert.equal(robotPoseAt([], 1000), null);
  assert.equal(robotPoseAt(null, 1000), null);
});

test('pushFix keeps a bounded, monotonic history', () => {
  const fixes = [];
  for (let t = 1; t <= 8; t += 1) assert.equal(pushFix(fixes, fix(t * 100, 27, 86)), true);
  assert.equal(fixes.length, 5);
  assert.equal(fixes[0].t, 400);
  assert.equal(pushFix(fixes, fix(400, 27, 86)), false);
  assert.equal(pushFix(fixes, { lat: 27 }), false);
  assert.equal(fixes.length, 5);
});
