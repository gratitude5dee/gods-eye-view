// src/data/mujocoTelemetry.test.mjs
//
// The MuJoCo sim2sim → RobotFrame seam. Every frame the bridge emits has to
// survive `validateRobotFrame` (the relay rejects a whole 200-frame batch on one
// bad frame — see validateRobotFrameBatch), so these tests assert the produced
// frames against the real validator rather than field by field.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLineReader,
  mujocoFrameFromRecord,
  velFromPelvisLinvel,
} from './mujocoTelemetry.js';
import { PassThrough } from 'node:stream';
import { validateRobotFrame } from './robotFrame.js';
import { createProvider, parseSocketTarget } from '../../tools/robot-bridge/providers/mujoco-g1.mjs';

/** A representative control-step record from the sim2sim exporter. */
function simRecord(overrides = {}) {
  return {
    t: Date.now(),
    lat: 27.9881,
    lon: 86.925,
    altM: 5364,
    headingDeg: 42,
    linvel: [0.8, 0.05, -0.01],
    fsm: 'walk',
    cadenceHz: 1.5,
    phase: 1.2,
    soc: 82,
    tempC: 31.5,
    ...overrides,
  };
}

test('a sim record becomes a frame the relay validator accepts', () => {
  const built = mujocoFrameFromRecord(simRecord(), { id: 'g1-01' });
  assert.equal(built.ok, true);
  assert.deepEqual(validateRobotFrame(built.frame), { ok: true });
  assert.equal(built.frame.provenance.source, 'live-g1');
  assert.equal(built.frame.provenance.label, 'LIVE');
  assert.equal(built.frame.gait.phase, 1.2, 'the policy gait clock reaches the renderer');
});

test('a canonical frame keeps its body but never its identity or provenance', () => {
  const inner = mujocoFrameFromRecord(simRecord(), { id: 'sim', provenance: 'synthetic' }).frame;
  const built = mujocoFrameFromRecord(inner, { id: 'g1-07', provenance: 'live-g1' });
  assert.equal(built.ok, true);
  assert.equal(built.frame.id, 'g1-07', 'the bridge owns the robot id, not the sim');
  assert.equal(built.frame.provenance.label, 'LIVE');
  assert.deepEqual(built.frame.pose, inner.pose);
  assert.deepEqual(validateRobotFrame(built.frame), { ok: true });
});

test('a raw observation block is stripped rather than forwarded', () => {
  // 23 joints × angles+velocities per frame would blow the 256 KB ingest body
  // cap at batch size, and the relay rejects the whole batch when it does.
  const built = mujocoFrameFromRecord(simRecord({ sim: { qpos: new Array(64).fill(0.5) } }), { id: 'g1-01' });
  assert.equal('sim' in built.frame, false);
  const passthrough = mujocoFrameFromRecord({ ...built.frame, sim: { qpos: [1, 2] } }, { id: 'g1-01' });
  assert.equal('sim' in passthrough.frame, false);
});

test('provenance is labelled from the source, and an unknown source is refused', () => {
  const sim = mujocoFrameFromRecord(simRecord(), { id: 'g1-01', provenance: 'synthetic' });
  assert.equal(sim.frame.provenance.label, 'SIMULATED', 'a pure rollout can say so');
  assert.deepEqual(validateRobotFrame(sim.frame), { ok: true });
  assert.equal(mujocoFrameFromRecord(simRecord(), { id: 'g1-01', provenance: 'imagined' }).ok, false);
  assert.equal(mujocoFrameFromRecord(simRecord(), { id: 'g1-01', datum: 'mars' }).ok, false);
});

test('records without a usable fix are refused instead of silently placed at null island', () => {
  for (const bad of [null, 'frame', [], {}, simRecord({ lat: null }), simRecord({ lon: 'x' })]) {
    assert.equal(mujocoFrameFromRecord(bad, { id: 'g1-01' }).ok, false);
  }
});

test('optional telemetry is null, not absent or invented', () => {
  const { frame } = mujocoFrameFromRecord(
    { lat: 0, lon: 0 }, { id: 'g1-01', nowMs: 1_700_000_000_000 },
  );
  assert.deepEqual(validateRobotFrame(frame, { nowMs: 1_700_000_000_000 }), { ok: true });
  assert.equal(frame.gait.fsm, 'unknown', 'a record with no FSM is not asserted to be standing');
  assert.equal(frame.gait.phase, null);
  assert.equal(frame.pose.altM, 0);
  assert.equal(frame.vel, undefined, 'no velocity evidence means no vel block');
  assert.equal(frame.power, undefined);
  assert.equal(frame.t, 1_700_000_000_000, 'a record with no clock is stamped on arrival');
});

test('longitude wraps and heading normalizes so the validator ranges hold', () => {
  const { frame } = mujocoFrameFromRecord(
    simRecord({ lon: 186.925, headingDeg: -30 }), { id: 'g1-01' },
  );
  assert.ok(frame.pose.lon < 0 && frame.pose.lon > -180);
  assert.equal(frame.pose.headingDeg, 330);
  assert.deepEqual(validateRobotFrame(frame), { ok: true });
});

test('velocity comes off the pelvis-frame linvel the policy itself observes', () => {
  // Pure forward motion: the course is the heading.
  assert.deepEqual(velFromPelvisLinvel([1, 0, 0], 90), { speedMps: 1, courseDeg: 90 });
  // Drifting to the robot's left turns the course counter-clockwise.
  const left = velFromPelvisLinvel([0, 1, 0], 90);
  assert.equal(Math.round(left.courseDeg), 0);
  assert.equal(velFromPelvisLinvel([0, 0, 0], 10).speedMps, 0);
  assert.equal(velFromPelvisLinvel(null, 10), null);
  assert.equal(velFromPelvisLinvel([Number.NaN, 0], 10), null);
  // Without linvel, an explicit scalar speed still produces a vel block.
  const { frame } = mujocoFrameFromRecord(
    simRecord({ linvel: undefined, speedMps: 1.4 }), { id: 'g1-01' },
  );
  assert.equal(frame.vel.speedMps, 1.4);
  assert.equal(frame.vel.courseDeg, 42, 'course falls back to the heading');
});

test('the line reader emits only complete lines and bounds a newline-less sender', () => {
  const reader = createLineReader({ maxLineBytes: 16 });
  assert.deepEqual(reader.push('{"a":1}\n{"b":').lines, ['{"a":1}']);
  assert.deepEqual(reader.push('2}\n').lines, ['{"b":2}'], 'a split line is rejoined');
  assert.deepEqual(reader.push('\n \n').lines, [], 'blank lines are not records');
  const flood = reader.push('x'.repeat(64));
  assert.ok(flood.overflow > 0);
  const resync = reader.push('tail-of-flood\n{"c":3}\n');
  assert.deepEqual(resync.lines, ['{"c":3}'],
    'the rest of an over-long line is dropped, not read as a record');
  assert.equal(resync.overflow, 'tail-of-flood'.length);
});

test('a complete over-long line is dropped whole and later lines survive', () => {
  const reader = createLineReader({ maxLineBytes: 16 });
  const pushed = reader.push(`{"a":1}\n${'y'.repeat(40)}\n{"b":2}\n`);
  assert.deepEqual(pushed.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(pushed.overflow, 40, 'only the oversized logical line is charged');
});

test('the cap counts UTF-8 bytes, not UTF-16 units', () => {
  const reader = createLineReader({ maxLineBytes: 16 });
  // 8 characters, 24 bytes: under the cap by `length`, over it on the wire.
  const wide = 'あ'.repeat(8);
  const pushed = reader.push(`{"a":1}\n${wide}\n{"b":2}\n`);
  assert.deepEqual(pushed.lines, ['{"a":1}', '{"b":2}'],
    'a multibyte record over the byte cap does not reach ingest');
  assert.equal(pushed.overflow, 24, 'overflow is charged in bytes');
});

test('a split multibyte line is bounded and resynchronizes on the next newline', () => {
  const reader = createLineReader({ maxLineBytes: 16 });
  const flood = reader.push('あ'.repeat(7)); // 21 bytes, no newline yet
  assert.equal(flood.overflow, 21);
  const resync = reader.push('あ\n{"c":3}\n');
  assert.deepEqual(resync.lines, ['{"c":3}']);
  assert.equal(resync.overflow, 3, 'the dropped remainder is charged in bytes too');
});

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

test('--socket accepts host:port, bare port and unix paths', () => {
  assert.deepEqual(parseSocketTarget('8765'), { kind: 'tcp', host: '127.0.0.1', port: 8765 });
  assert.deepEqual(parseSocketTarget('127.0.0.1:8765'), { kind: 'tcp', host: '127.0.0.1', port: 8765 });
  assert.deepEqual(parseSocketTarget('[::1]:8765'), { kind: 'tcp', host: '::1', port: 8765 });
  assert.deepEqual(parseSocketTarget('/tmp/gev-g1.sock'), { kind: 'unix', path: '/tmp/gev-g1.sock' });
  assert.equal(parseSocketTarget('0'), null);
  assert.equal(parseSocketTarget(''), null);
});

test('the provider mirrors the synthetic provider contract', () => {
  const provider = createProvider({ id: 'g1-01' });
  assert.equal(provider.id, 'mujoco-g1');
  for (const method of ['start', 'stop', 'getStatus']) {
    assert.equal(typeof provider[method], 'function');
  }
  const status = provider.getStatus();
  assert.equal(status.status, 'down', 'nothing is attached before start()');
  assert.equal(status.lastFrameAt, null);
  assert.equal(status.source, 'stdin');
});

test('bad provider options fail at construction, not once per frame', () => {
  assert.throws(() => createProvider({ provenance: 'imagined' }), /unknown provenance/);
  assert.throws(() => createProvider({ socket: 'nope:0' }), /unparseable/);
  assert.throws(() => createProvider({ confidence: 'high' }), /confidence/);
});

test('only validated frames are delivered, and rejects are counted not thrown', async () => {
  const delivered = [];
  const sink = createProvider({ id: 'g1-01', rateHz: 0, stdin: new PassThrough() });
  await sink.start((frame) => delivered.push(frame));
  sink._handleLine(JSON.stringify(simRecord()));
  sink._handleLine('not json');
  sink._handleLine(JSON.stringify({ lat: 999, lon: 0 }));
  sink._handleLine(JSON.stringify(simRecord({ t: 0 })));
  const status = sink.getStatus();
  assert.equal(delivered.length, 1);
  assert.deepEqual(validateRobotFrame(delivered[0]), { ok: true });
  assert.equal(status.unparseable, 1);
  assert.equal(status.rejected, 2, 'an out-of-range fix and a 1970 timestamp are both refused');
  assert.ok(status.error, 'the last rejection reason is reportable');
  await sink.stop();
});

test('frames are decimated to the requested rate', async () => {
  const delivered = [];
  const provider = createProvider({ id: 'g1-01', rateHz: 1, stdin: new PassThrough() });
  await provider.start((frame) => delivered.push(frame));
  for (let i = 0; i < 25; i += 1) provider._handleLine(JSON.stringify(simRecord()));
  assert.equal(delivered.length, 1, 'a 50 Hz rollout must not flood the 600-frame relay ring');
  const status = provider.getStatus();
  assert.equal(status.accepted, 25, 'every frame is still validated and accounted for');
  assert.equal(status.decimated, 24);
  await provider.stop();
});

test('a piped rollout is read from stdin, and stop() detaches', async () => {
  const stdin = new PassThrough();
  const delivered = [];
  const provider = createProvider({ id: 'g1-01', rateHz: 0, stdin });
  await provider.start((frame) => delivered.push(frame));
  assert.equal(provider.getStatus().status, 'stale', 'attached, but no frame has arrived yet');
  stdin.write(`${JSON.stringify(simRecord())}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1, 'a piped rollout reaches the bridge');
  await provider.stop();
  stdin.write(`${JSON.stringify(simRecord())}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1, 'nothing is delivered after stop()');
  assert.equal(provider.getStatus().status, 'down');
});

test('a socket rollout can reconnect without restarting the bridge', async () => {
  const net = await import('node:net');
  const path = `/tmp/gev-g1-test-${process.pid}.sock`;
  const delivered = [];
  const provider = createProvider({ id: 'g1-01', rateHz: 0, socket: path });
  await provider.start((frame) => delivered.push(frame));
  assert.equal(provider.getStatus().source, `unix:${path}`);

  const send = async (record) => {
    const client = net.connect(path);
    await new Promise((resolve) => client.once('connect', resolve));
    client.write(`${JSON.stringify(record)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await send(simRecord());
  await send(simRecord({ fsm: 'stand' }));
  assert.equal(delivered.length, 2);
  assert.equal(provider.getStatus().connections, 2);
  assert.equal(provider.getStatus().status, 'live');
  await provider.stop();
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(path), false, 'the socket file is cleaned up on stop');
});
