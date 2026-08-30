// src/data/reconstructionAnchor.test.mjs
// The anchor is what turns an ungeoreferenced reconstruction into something the
// globe can draw, so the axis convention is the whole test: ABot-Recon's frame
// is +x right, +y DOWN, +z forward, and getting the sign of y wrong buries the
// cloud under the terrain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorPoseTrack,
  forwardHeadingDeg,
  normalizeAnchor,
  offsetLatLon,
  revealedPointCount,
  slamToEnu,
} from './reconstructionAnchor.js';

const CLOSE = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${label}: ${actual} !~= ${expected} (±${tolerance})`,
);

test('a due-north anchor maps +z to north, +x to east, +y to down', () => {
  const enu = slamToEnu({ x: 2, y: 3, z: 10 }, 0);
  assert.deepEqual(enu, { eastM: 2, northM: 10, upM: -3 });
});

test('anchor heading rotates the SLAM frame into the compass frame', () => {
  const east = slamToEnu({ x: 0, y: 0, z: 10 }, 90);
  CLOSE(east.eastM, 10, 1e-9, 'eastM');
  CLOSE(east.northM, 0, 1e-9, 'northM');
  const south = slamToEnu({ x: 0, y: 0, z: 10 }, 180);
  CLOSE(south.northM, -10, 1e-9, 'northM');
  // Right of a camera facing east is south.
  const right = slamToEnu({ x: 10, y: 0, z: 0 }, 90);
  CLOSE(right.northM, -10, 1e-9, 'northM');
});

test('a 1 km ENU offset lands where the meridian arithmetic says', () => {
  const anchor = { lat: 27.9819, lon: 86.8285 };
  const north = offsetLatLon(anchor, 0, 1000);
  CLOSE(north.lat - anchor.lat, 0.008993, 1e-6, 'lat');
  assert.equal(north.lon, anchor.lon);
  const east = offsetLatLon(anchor, 1000, 0);
  assert.equal(east.lat, anchor.lat);
  // A degree of longitude shrinks with cos(lat), so 1 km east is a larger
  // angle at 28°N than 1 km north is.
  CLOSE(east.lon - anchor.lon, 0.010184, 1e-6, 'lon');
});

test('forward axes become compass bearings in [0, 360)', () => {
  assert.equal(forwardHeadingDeg({ x: 0, y: 0, z: 1 }, 0), 0);
  CLOSE(forwardHeadingDeg({ x: 1, y: 0, z: 0 }, 0), 90, 1e-9, 'east');
  CLOSE(forwardHeadingDeg({ x: -1, y: 0, z: 0 }, 0), 270, 1e-9, 'west');
  CLOSE(forwardHeadingDeg({ x: 0, y: 0, z: 1 }, 200), 200, 1e-9, 'anchored');
  // A camera pitched steeply down still has a horizontal bearing.
  CLOSE(forwardHeadingDeg({ x: 0, y: 0.9, z: 0.1 }, 45), 45, 1e-9, 'pitched');
});

test('anchoring a track keeps elevations ground-relative for the slam-local datum', () => {
  const waypoints = anchorPoseTrack(
    {
      count: 2,
      centers: Float64Array.from([0, 0, 0, 0, -2, 10]),
      forwards: Float64Array.from([0, 0, 1, 1, 0, 0]),
    },
    { lat: 10, lon: 20, headingDeg: 0, elevM: 1.2 },
  );
  assert.equal(waypoints.length, 2);
  assert.deepEqual(waypoints[0], { lat: 10, lon: 20, elevM: 1.2, headingDeg: 0 });
  // +y is down, so a camera 2 m "up" in SLAM y=-2 sits 2 m above the anchor.
  CLOSE(waypoints[1].elevM, 3.2, 1e-9, 'elevM');
  CLOSE(waypoints[1].lat - 10, 10 / 6_371_008.8 / (Math.PI / 180), 1e-12, 'lat');
  CLOSE(waypoints[1].headingDeg, 90, 1e-9, 'headingDeg');
});

test('an anchor that cannot be placed is rejected instead of defaulted', () => {
  assert.throws(() => normalizeAnchor(null), /must be an object/);
  assert.throws(() => normalizeAnchor({ lat: 91, lon: 0 }), /lat out of range/);
  assert.throws(() => normalizeAnchor({ lat: 0, lon: 181 }), /lon out of range/);
  assert.throws(() => normalizeAnchor({ lat: Number.NaN, lon: 0 }), /lat out of range/);
  // Heading and elevation are genuinely optional.
  assert.deepEqual(normalizeAnchor({ lat: 1, lon: 2 }), {
    lat: 1, lon: 2, headingDeg: 0, elevM: 0,
  });
});

test('the revealed prefix grows monotonically and never overshoots', () => {
  assert.equal(revealedPointCount(1000, 0), 0);
  assert.equal(revealedPointCount(1000, 0.25), 250);
  assert.equal(revealedPointCount(1000, 1), 1000);
  assert.equal(revealedPointCount(1000, 2), 1000);
  assert.equal(revealedPointCount(0, 0.5), 0);
  // A started replay always shows something, however tiny the fraction.
  assert.equal(revealedPointCount(1000, 1e-9), 1);
  assert.equal(revealedPointCount(1000, Number.NaN), 0);
});
