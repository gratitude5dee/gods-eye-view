// src/data/reconstructionReplay.test.mjs
// The replay is the one place where recorded data is animated as if it were a
// walk, so the provenance assertions below are load-bearing: a recorded clip
// replayed onto chosen geography must never read as live hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconstructionReplay } from './reconstructionReplay.js';
import { provenanceChip } from './robotFrame.js';

/** A straight 5-pose walk north at ~1.1 m per pose. */
const WAYPOINTS = Array.from({ length: 5 }, (_unused, i) => ({
  lat: 27.9819 + i * 0.00001,
  lon: 86.8285,
  elevM: 1.2,
  headingDeg: 0,
}));

test('replayed frames are SIMULATED · VIRTUAL TRANSPOSITION, never live', () => {
  const replay = createReconstructionReplay({ waypoints: WAYPOINTS, poseHz: 10 });
  const frame = replay.nextFrame(0);
  assert.equal(frame.provenance.source, 'synthetic');
  assert.equal(frame.transposed, true);
  assert.equal(provenanceChip(frame), 'SIMULATED · VIRTUAL TRANSPOSITION');
  assert.equal(frame.datum, 'slam-local');
  assert.equal(frame.fix.source, 'slam');
  assert.equal(frame.health.estop, false);
});

test('pose consumption follows wall-clock time at the configured rate', () => {
  const replay = createReconstructionReplay({ waypoints: WAYPOINTS, poseHz: 10 });
  replay.nextFrame(1000);
  assert.equal(replay.progress().index, 0);
  // 250 ms at 10 Hz is 2.5 poses — the marker is on pose 2, not interpolated.
  replay.nextFrame(1250);
  assert.equal(replay.progress().index, 2);
  replay.nextFrame(1400);
  assert.equal(replay.progress().index, 4);
  assert.deepEqual(replay.progress(), { index: 4, poseCount: 5, fraction: 1 });
});

test('ticking faster than the pose rate re-emits the held pose', () => {
  const replay = createReconstructionReplay({ waypoints: WAYPOINTS, poseHz: 2 });
  const first = replay.nextFrame(0);
  const second = replay.nextFrame(100);
  assert.equal(second.pose.lat, first.pose.lat);
  assert.equal(replay.progress().index, 0);
});

test('speed and yaw rate are derived from the anchored track', () => {
  const replay = createReconstructionReplay({
    waypoints: [
      { lat: 0, lon: 0, elevM: 0, headingDeg: 350 },
      { lat: 0, lon: 0.00001, elevM: 0, headingDeg: 10 },
    ],
    poseHz: 1,
  });
  replay.nextFrame(0);
  const moved = replay.nextFrame(1000);
  // ~1.11 m east over 1 s.
  assert.ok(moved.vel.speedMps > 1 && moved.vel.speedMps < 1.2, `speed ${moved.vel.speedMps}`);
  assert.equal(moved.gait.fsm, 'walk');
  // 350° → 10° is +20°, not -340°.
  assert.ok(Math.abs(moved.vel.yawRateDps - 20) < 1e-9, `yaw ${moved.vel.yawRateDps}`);
  assert.equal(moved.vel.courseDeg, 10);
});

test('a stationary marker reports standing rather than a phantom gait', () => {
  const replay = createReconstructionReplay({
    waypoints: [WAYPOINTS[0], { ...WAYPOINTS[0] }],
    poseHz: 1,
  });
  replay.nextFrame(0);
  const held = replay.nextFrame(1000);
  assert.equal(held.vel.speedMps, 0);
  assert.equal(held.gait.fsm, 'stand');
});

test('a finished replay stops emitting and holds the last pose', () => {
  const replay = createReconstructionReplay({ waypoints: WAYPOINTS, poseHz: 10 });
  replay.nextFrame(0);
  assert.equal(replay.isComplete(), false);
  assert.equal(replay.nextFrame(10_000), null);
  assert.equal(replay.isComplete(), true);
  assert.equal(replay.progress().index, 4);
  assert.equal(replay.nextFrame(20_000), null);
});

test('a looping replay wraps instead of completing', () => {
  const replay = createReconstructionReplay({ waypoints: WAYPOINTS, poseHz: 10, loop: true });
  replay.nextFrame(0);
  assert.equal(replay.nextFrame(600).pose.lat, WAYPOINTS[1].lat);
  assert.equal(replay.isComplete(), false);
});

test('an empty trajectory is refused rather than animating nothing', () => {
  assert.throws(() => createReconstructionReplay({ waypoints: [] }), /at least one waypoint/);
  assert.throws(() => createReconstructionReplay(), /at least one waypoint/);
});
