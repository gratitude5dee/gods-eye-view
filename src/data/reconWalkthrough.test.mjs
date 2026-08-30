// src/data/reconWalkthrough.test.mjs
// The walkthrough choreographs three camera acts and a CCTV panel over one
// replay clock; these assertions pin the handover order and keep the panel's
// recorded footage from ever being presented before the "connect" beat.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALKTHROUGH_PHASE_BOUNDS,
  WALKTHROUGH_POSE_HZ,
  cctvFrameUrl,
  cctvStateAt,
  cctvTimestamp,
  walkthroughPhaseAt,
} from './reconWalkthrough.js';

test('phases hand over in flight → third-person → first-person order', () => {
  assert.equal(walkthroughPhaseAt(0), 'flight');
  assert.equal(walkthroughPhaseAt(WALKTHROUGH_PHASE_BOUNDS.flightEnd - 0.01), 'flight');
  assert.equal(walkthroughPhaseAt(WALKTHROUGH_PHASE_BOUNDS.flightEnd), 'third-person');
  assert.equal(walkthroughPhaseAt(WALKTHROUGH_PHASE_BOUNDS.thirdPersonEnd - 0.01), 'third-person');
  assert.equal(walkthroughPhaseAt(WALKTHROUGH_PHASE_BOUNDS.thirdPersonEnd), 'first-person');
  assert.equal(walkthroughPhaseAt(1), 'first-person');
});

test('garbage progress defaults to the opening flight', () => {
  assert.equal(walkthroughPhaseAt(NaN), 'flight');
  assert.equal(walkthroughPhaseAt(undefined), 'flight');
  assert.equal(cctvStateAt(NaN), 'standby');
});

test('the CCTV link connects only after the flight, via a connecting beat', () => {
  assert.equal(cctvStateAt(0), 'standby');
  assert.equal(cctvStateAt(WALKTHROUGH_PHASE_BOUNDS.flightEnd - 0.01), 'standby');
  assert.equal(cctvStateAt(WALKTHROUGH_PHASE_BOUNDS.flightEnd), 'connecting');
  assert.equal(cctvStateAt(WALKTHROUGH_PHASE_BOUNDS.flightEnd + 0.06), 'connected');
  assert.equal(cctvStateAt(1), 'connected');
});

test('frame URLs are zero-padded, clamped, and null without published frames', () => {
  assert.equal(cctvFrameUrl(0, { frameCount: 52 }), '/recon/frames/000000.jpg');
  assert.equal(cctvFrameUrl(7, { frameCount: 52 }), '/recon/frames/000007.jpg');
  assert.equal(cctvFrameUrl(99, { frameCount: 52 }), '/recon/frames/000051.jpg');
  assert.equal(cctvFrameUrl(-3, { frameCount: 52 }), '/recon/frames/000000.jpg');
  assert.equal(cctvFrameUrl(2, { frameCount: 52, baseUrl: '/x' }), '/x/000002.jpg');
  assert.equal(cctvFrameUrl(0, { frameCount: 0 }), null);
  assert.equal(cctvFrameUrl(0, {}), null);
});

test('the recording clock advances by the capture interval', () => {
  assert.equal(cctvTimestamp(0, 0.6), 'REC T+00.0s');
  assert.equal(cctvTimestamp(7, 0.6), 'REC T+04.2s');
  assert.equal(cctvTimestamp(51, 0.6), 'REC T+30.6s');
  assert.equal(cctvTimestamp(5, undefined), 'REC T+00.0s');
});

test('walkthrough pace leaves each act several seconds of a 52-pose clip', () => {
  const totalS = 52 / WALKTHROUGH_POSE_HZ;
  const flightS = totalS * WALKTHROUGH_PHASE_BOUNDS.flightEnd;
  const thirdS = totalS * (WALKTHROUGH_PHASE_BOUNDS.thirdPersonEnd - WALKTHROUGH_PHASE_BOUNDS.flightEnd);
  const firstS = totalS * (1 - WALKTHROUGH_PHASE_BOUNDS.thirdPersonEnd);
  for (const spanS of [flightS, thirdS, firstS]) assert.ok(spanS >= 4, `${spanS}s act`);
});
