import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../../tools/robot-bridge/providers/synthetic.mjs';
import { validateRobotFrame } from './robotFrame.js';

const NOW = 1756500000000;

function frames(provider, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(provider._nextFrame(NOW + i * 100));
  return out;
}

test('every synthetic frame is a valid RobotFrame with exact SIMULATED provenance', () => {
  for (const frame of frames(createProvider({ seed: 5 }), 300)) {
    assert.deepEqual(validateRobotFrame(frame, { nowMs: frame.t }), { ok: true });
    assert.deepEqual(frame.provenance, { source: 'synthetic', label: 'SIMULATED', confidence: 1.0 });
  }
});

test('deterministic by seed — same seed replays the same walk, another diverges', () => {
  const a = frames(createProvider({ seed: 42 }), 200);
  const b = frames(createProvider({ seed: 42 }), 200);
  const c = frames(createProvider({ seed: 43 }), 200);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((f) => f.health.commsRttMs), c.map((f) => f.health.commsRttMs));
});

test('the walker advances along the route without teleporting', () => {
  const run = frames(createProvider({ seed: 5 }), 600);
  let prev = run[0];
  for (const frame of run.slice(1)) {
    const dLat = Math.abs(frame.pose.lat - prev.pose.lat) * 111_320;
    const dLon = Math.abs(frame.pose.lon - prev.pose.lon) * 111_320;
    assert.ok(dLat < 1 && dLon < 1, 'no per-tick jump beyond walking distance');
    prev = frame;
  }
  const first = run[0];
  const last = run[run.length - 1];
  const movedM = Math.hypot(
    (last.pose.lat - first.pose.lat) * 111_320,
    (last.pose.lon - first.pose.lon) * 111_320,
  );
  assert.ok(movedM > 10, `a minute of walking must cover ground, moved ${movedM} m`);
});

test('a carried segment stops forward progress and reads stand', () => {
  const provider = createProvider({ seed: 5 });
  const run = frames(provider, 2400);
  const carried = run.filter((f) => f.event === 'carried');
  assert.ok(carried.length > 0, 'the scripted carried window must occur');
  for (let i = 1; i < carried.length; i += 1) {
    assert.equal(carried[i].gait.fsm, 'stand');
    assert.equal(carried[i].gait.cadenceHz, 0);
    assert.equal(carried[i].pose.lat, carried[i - 1].pose.lat);
    assert.equal(carried[i].pose.lon, carried[i - 1].pose.lon);
  }
});

test('battery drain is monotonic and never negative', () => {
  const run = frames(createProvider({ seed: 5 }), 1200);
  let prevSoc = 100;
  for (const frame of run) {
    assert.ok(frame.power.soc <= prevSoc + 1e-9, 'soc must never rise');
    assert.ok(frame.power.soc >= 0);
    prevSoc = frame.power.soc;
  }
});

test('walking gait alternates contacts with plausible cadence and forces', () => {
  const walking = frames(createProvider({ seed: 5 }), 400).filter((f) => f.gait.fsm === 'walk');
  assert.ok(walking.length > 100);
  for (const frame of walking) {
    assert.ok(frame.gait.cadenceHz >= 1.2 && frame.gait.cadenceHz <= 2.2, `cadence ${frame.gait.cadenceHz}`);
    assert.ok(frame.gait.footForce[0] >= 0 && frame.gait.footForce[1] >= 0);
    assert.ok(frame.gait.contact[0] || frame.gait.contact[1], 'at least one foot down');
  }
});
