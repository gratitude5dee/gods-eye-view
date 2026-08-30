/**
 * ABot-Recon live pose normalization and the unitree bridge provider.
 *
 * The pure module turns streamer pose records into canonical LIVE frames; the
 * provider tails `pose_latest.json` from disk. Both are exercised here so the
 * frame path a real Tailscale session will use is the one under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateRobotFrame } from './robotFrame.js';
import { unitreeFrameFromRecord } from './unitreeTelemetry.js';
import { createProvider } from '../../tools/robot-bridge/providers/unitree.mjs';

const ANCHOR = { lat: 27.9819, lon: 86.8285, headingDeg: 0, elevM: 0 };

function record(overrides = {}) {
  return {
    seq: 1,
    t: 1_788_085_000_000,
    pose: { x: 0, y: 0, z: 0, forward: [0, 0, 1] },
    ...overrides,
  };
}

test('a streamer pose becomes a valid LIVE slam-local frame', () => {
  const built = unitreeFrameFromRecord(record(), { id: 'g1-01', anchor: ANCHOR });
  assert.equal(built.ok, true);
  const check = validateRobotFrame(built.frame, { nowMs: 1_788_085_000_500 });
  assert.equal(check.ok, true, check.error);
  assert.equal(built.frame.datum, 'slam-local');
  assert.equal(built.frame.fix.source, 'slam');
  assert.equal(built.frame.provenance.source, 'live-g1');
  assert.equal(built.frame.provenance.label, 'LIVE');
  assert.equal(built.frame.transposed, true,
    'an editorial anchor must keep the VIRTUAL TRANSPOSITION badge');
});

test('SLAM +z walks along the anchor heading; -y is up', () => {
  const built = unitreeFrameFromRecord(
    record({ pose: { x: 0, y: -2, z: 100, forward: [0, 0, 1] } }),
    { id: 'g1-01', anchor: { ...ANCHOR, headingDeg: 90 } },
  );
  assert.equal(built.ok, true);
  // 100 m along heading 90° is due east: longitude grows, latitude holds.
  assert.ok(built.frame.pose.lon > ANCHOR.lon);
  assert.ok(Math.abs(built.frame.pose.lat - ANCHOR.lat) < 1e-6);
  assert.equal(built.frame.pose.altM, 2, 'SLAM +y is down, so -2 rides 2 m up');
  assert.equal(Math.round(built.frame.pose.headingDeg), 90);
});

test('velocity comes from consecutive poses, not from the record', () => {
  const first = unitreeFrameFromRecord(record(), { id: 'g1-01', anchor: ANCHOR });
  assert.equal(first.frame.vel, undefined, 'no previous pose, no vel block');
  const second = unitreeFrameFromRecord(
    record({ seq: 2, t: record().t + 2000, pose: { x: 0, y: 0, z: 1.6, forward: [0, 0, 1] } }),
    { id: 'g1-01', anchor: ANCHOR, previous: { enu: first.enu, t: first.frame.t } },
  );
  assert.equal(second.ok, true);
  assert.ok(Math.abs(second.frame.vel.speedMps - 0.8) < 1e-9);
  assert.equal(Math.round(second.frame.vel.courseDeg), 0);
  assert.equal(second.frame.gait.fsm, 'walk');
});

test('a garbled record is refused, not guessed at', () => {
  assert.equal(unitreeFrameFromRecord(null, { id: 'g1-01', anchor: ANCHOR }).ok, false);
  assert.equal(
    unitreeFrameFromRecord(record({ pose: { x: NaN, y: 0, z: 0 } }),
      { id: 'g1-01', anchor: ANCHOR }).ok,
    false,
  );
  assert.equal(
    unitreeFrameFromRecord(record(), { id: 'g1-01', anchor: { lat: 999, lon: 0 } }).ok,
    false,
  );
});

test('the provider delivers one frame per seq and tolerates an absent file', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-unitree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const anchorPath = path.join(dir, 'anchor.json');
  writeFileSync(anchorPath, JSON.stringify(ANCHOR));

  // A near-zero rate parks the timer; polls are driven by hand below.
  const provider = createProvider({
    id: 'g1-01', watch: dir, anchor: anchorPath, rateHz: 0.0001,
  });
  t.after(() => provider.stop());
  const frames = [];
  await provider.start((frame) => frames.push(frame));

  await provider._poll();
  assert.equal(frames.length, 0, 'no pose file yet — normal startup, not an error');
  assert.equal(provider.getStatus().error, null);

  // The streamer writes atomically: tmp file, then rename over the target.
  const write = (data) => {
    const tmp = path.join(dir, '.pose.tmp');
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path.join(dir, 'pose_latest.json'));
  };
  write(record({ t: Date.now(), batch: 'points/batch_000001.ply' }));
  await provider._poll();
  await provider._poll(); // same seq — must not re-emit
  assert.equal(frames.length, 1);
  assert.equal(frames[0].provenance.label, 'LIVE');

  write(record({ seq: 2, t: Date.now() + 100, pose: { x: 0, y: 0, z: 0.5, forward: [0, 0, 1] } }));
  await provider._poll();
  assert.equal(frames.length, 2);
  assert.ok(frames[1].vel, 'second window derives velocity from the first');

  const status = provider.getStatus();
  assert.equal(status.accepted, 2);
  assert.equal(status.unchanged, 1);
  assert.equal(status.lastSeq, 2);
  assert.equal(status.lastBatch, 'points/batch_000001.ply');
  assert.equal(status.status, 'live');
  await provider.stop();
  assert.equal(provider.getStatus().status, 'down', 'stopped provider reports down');
});

test('the provider refuses a bad anchor at startup, not per frame', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-unitree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const anchorPath = path.join(dir, 'anchor.json');
  writeFileSync(anchorPath, JSON.stringify({ lat: 999, lon: 0 }));
  assert.throws(() => createProvider({ watch: dir, anchor: anchorPath }), /lat/);
});
