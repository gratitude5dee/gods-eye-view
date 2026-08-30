// src/data/groundSnap.test.mjs
// Browser-QA round (2026-08-30): locks the fallback-globe validation of pick
// samples — a G1 demo snap accepted a pick ~400 m below the rendered globe
// surface and drew the model (and chase camera) inside the mountain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createGroundSnap } from './groundSnap.js';

const POS = Cesium.Cartesian3.fromDegrees(-106.6, 35.05, 0);

function fakeViewer({ sampled, globeShow, globeH, terrainProvider }) {
  return {
    terrainProvider,
    scene: {
      primitives: { length: 0 },
      sampleHeight: () => sampled,
      globe: { show: globeShow, getHeight: () => globeH },
      terrainProvider,
    },
  };
}

test('fallback globe: a pick far below the rendered surface yields the globe height', () => {
  const snap = createGroundSnap();
  const viewer = fakeViewer({ sampled: 2712, globeShow: true, globeH: 3112 });
  assert.equal(snap.heightFor(viewer, 'g1a', POS), 3112);
});

test('fallback globe: a pick agreeing with the surface is kept as-is', () => {
  const snap = createGroundSnap();
  const viewer = fakeViewer({ sampled: 3110.4, globeShow: true, globeH: 3112 });
  assert.equal(snap.heightFor(viewer, 'g1b', POS), 3110.4);
});

test('fallback globe: a missed pick resolves from the globe instead of backing off forever', () => {
  const snap = createGroundSnap();
  const viewer = fakeViewer({ sampled: undefined, globeShow: true, globeH: 3112 });
  assert.equal(snap.heightFor(viewer, 'g1c', POS), 3112);
});

test('photoreal (globe hidden): the tile-skin pick is not second-guessed by hidden terrain', () => {
  const snap = createGroundSnap();
  const viewer = fakeViewer({ sampled: 2712, globeShow: false, globeH: 3112 });
  assert.equal(snap.heightFor(viewer, 'g1d', POS), 2712);
});

test('photoreal → globe switch: a stationary contact resamples on the new surface', () => {
  const snap = createGroundSnap();
  const photoreal = fakeViewer({ sampled: 2712, globeShow: false, globeH: undefined });
  assert.equal(snap.heightFor(photoreal, 'g1f', POS), 2712);
  const fallback = fakeViewer({ sampled: undefined, globeShow: true, globeH: 3112 });
  assert.equal(snap.heightFor(fallback, 'g1f', POS), 3112);
});

test('globe → photoreal switch: a stationary contact resamples the tile skin', () => {
  const snap = createGroundSnap();
  const fallback = fakeViewer({ sampled: 3112, globeShow: true, globeH: 3112 });
  assert.equal(snap.heightFor(fallback, 'g1g', POS), 3112);
  const photoreal = fakeViewer({ sampled: 2712, globeShow: false, globeH: 3112 });
  assert.equal(snap.heightFor(photoreal, 'g1g', POS), 2712);
});

test('terrain-provider swap under the shown globe forces a resample (mid map-stack switch)', () => {
  const snap = createGroundSnap();
  // globe.show already flipped, but the Re:Earth fetch has not resolved yet:
  // the sample measures the startup terrain.
  const startupTerrain = { name: 'startup' };
  const during = fakeViewer({
    sampled: 2712, globeShow: true, globeH: 2712, terrainProvider: startupTerrain,
  });
  assert.equal(snap.heightFor(during, 'g1h', POS), 2712);
  // The final provider installs without globe.show changing — the cached
  // startup-terrain height must not keep answering.
  const reearthTerrain = { name: 'reearth' };
  const after = fakeViewer({
    sampled: 3112, globeShow: true, globeH: 3112, terrainProvider: reearthTerrain,
  });
  assert.equal(snap.heightFor(after, 'g1h', POS), 3112);
});

test('photoreal cache survives terrain-provider changes (terrain is inert while hidden)', () => {
  const snap = createGroundSnap();
  const before = fakeViewer({
    sampled: 2712, globeShow: false, globeH: 3112, terrainProvider: { name: 'a' },
  });
  assert.equal(snap.heightFor(before, 'g1i', POS), 2712);
  // Same skin, different (inert) terrain provider and a different would-be
  // sample: the cached measurement must keep answering, not resample.
  const after = fakeViewer({
    sampled: 9999, globeShow: false, globeH: 3112, terrainProvider: { name: 'b' },
  });
  assert.equal(snap.heightFor(after, 'g1i', POS), 2712);
});

test('fallback globe: when both the pick and the globe miss, there is still no evidence', () => {
  const snap = createGroundSnap();
  const viewer = fakeViewer({ sampled: undefined, globeShow: true, globeH: undefined });
  assert.equal(snap.heightFor(viewer, 'g1e', POS), null);
});
