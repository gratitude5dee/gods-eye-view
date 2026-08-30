import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROBOT_CHASE_DEFAULTS, clampChaseRangeM } from './robotChaseCamera.js';

const source = readFileSync(new URL('./robotChaseCamera.js', import.meta.url), 'utf8');

test('chase loop poses the camera from scene.preUpdate, never preRender', () => {
  assert.match(source, /viewer\.scene\.preUpdate\.addEventListener/);
  assert.doesNotMatch(source, /scene\.preRender/);
});

test('render governor holds and releases are symmetric on every path', () => {
  assert.match(source, /holdContinuousRender\('robot-chase'\)/);
  assert.match(source, /releaseContinuousRender\('robot-chase'\)/);
  // start() begins by calling stop(), so re-entry cannot double-hold.
  assert.match(source, /function start\(getTargetFn, options = \{\}\) \{\s*\n\s*stop\(\);/);
});

test('stop restores the camera transform and user inputs', () => {
  assert.match(source, /viewer\.camera\.lookAtTransform\(Cesium\.Matrix4\.IDENTITY\)/);
  assert.match(source, /screenSpaceCameraController\.enableInputs = savedInputs/);
});

test('range clamps to the chase envelope', () => {
  assert.equal(clampChaseRangeM(6), 6);
  assert.equal(clampChaseRangeM(0.5), ROBOT_CHASE_DEFAULTS.minRangeM);
  assert.equal(clampChaseRangeM(500), ROBOT_CHASE_DEFAULTS.maxRangeM);
  assert.equal(clampChaseRangeM(NaN), ROBOT_CHASE_DEFAULTS.rangeM);
  assert.equal(clampChaseRangeM(undefined), ROBOT_CHASE_DEFAULTS.rangeM);
});

test('terrain safety uses the shared cockpit ground-safe height', () => {
  assert.match(source, /cockpitGroundSafeHeight\(/);
});
