import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bearingDeg,
  haversineM,
  parseRoute,
  pointAlongRoute,
  transpose,
} from './robotTransposition.js';

const khumbu = JSON.parse(readFileSync(new URL('../../config/routes/khumbu-ebc.json', import.meta.url), 'utf8'));

test('parses the Khumbu route with monotonic arc length', () => {
  const route = parseRoute(khumbu);
  assert.equal(route.points.length, 7);
  assert.ok(route.lengthM > 30000 && route.lengthM < 80000, `length ${route.lengthM}`);
  for (let i = 1; i < route.points.length; i += 1) {
    assert.ok(route.points[i].sM > route.points[i - 1].sM);
  }
  assert.equal(route.points[0].elevM, 2860);
  assert.equal(route.points[6].elevM, 5364);
});

test('pointAlongRoute clamps to endpoints and interpolates', () => {
  const route = parseRoute(khumbu);
  const start = pointAlongRoute(route, -50);
  assert.equal(start.lat, 27.6869);
  assert.equal(start.lon, 86.7314);
  const end = pointAlongRoute(route, route.lengthM + 1e6);
  assert.equal(end.done, true);
  assert.ok(Math.abs(end.lat - 28.0026) < 1e-9);
  const mid = pointAlongRoute(route, route.lengthM / 2);
  assert.ok(mid.elevM > 2860 && mid.elevM < 5364);
});

test('standing gait never advances', () => {
  const route = parseRoute(khumbu);
  for (const fsm of ['stand', 'damp', 'sit', 'squat', 'unknown']) {
    const out = transpose({
      gaitState: fsm, cadenceHz: 1.8, strideM: 0.42, dtSec: 10, route, sAlong: 100,
    });
    assert.equal(out.progressM, 0, fsm);
    assert.equal(out.sAlong, 100, fsm);
  }
});

test('walking advances by strikes × stride, preferring detected strikes', () => {
  const route = parseRoute(khumbu);
  const byStrikes = transpose({
    gaitState: 'walk', strideM: 0.5, strikeCount: 4, cadenceHz: 99, dtSec: 99, route, sAlong: 0,
  });
  assert.equal(byStrikes.progressM, 2);
  const byCadence = transpose({
    gaitState: 'walk', strideM: 0.5, cadenceHz: 1.8, dtSec: 2, route, sAlong: 0,
  });
  assert.ok(Math.abs(byCadence.progressM - 1.8) < 1e-9);
});

test('heading follows the route tangent, not robot yaw', () => {
  const route = parseRoute(khumbu);
  const out = transpose({
    gaitState: 'walk', strideM: 0.5, strikeCount: 2, route, sAlong: 10,
  });
  const expected = bearingDeg(
    route.points[0].lat, route.points[0].lon,
    route.points[1].lat, route.points[1].lon,
  );
  assert.ok(Math.abs(out.headingDeg - expected) < 1e-9);
});

test('every transposed output carries the VIRTUAL TRANSPOSITION label', () => {
  const route = parseRoute(khumbu);
  const out = transpose({ gaitState: 'stand', route, sAlong: 0 });
  assert.equal(out.transposed, true);
  assert.equal(out.label, 'VIRTUAL TRANSPOSITION');
});

test('progress clamps at route end', () => {
  const route = parseRoute(khumbu);
  const out = transpose({
    gaitState: 'run', strideM: 1e9, strikeCount: 1, route, sAlong: 0,
  });
  assert.equal(out.sAlong, route.lengthM);
  assert.equal(out.done, true);
});

test('haversine sanity: Lukla to Namche ~13-14 km straight line', () => {
  const d = haversineM(27.6869, 86.7314, 27.8069, 86.7140);
  assert.ok(d > 12000 && d < 15000, `${d}`);
});
