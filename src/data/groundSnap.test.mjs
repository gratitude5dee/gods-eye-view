// src/data/groundSnap.test.mjs
// Browser-QA round (2026-08-30): locks the fallback-globe validation of pick
// samples — a G1 demo snap accepted a pick ~400 m below the rendered globe
// surface and drew the model (and chase camera) inside the mountain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createGroundSnap } from './groundSnap.js';

const POS = Cesium.Cartesian3.fromDegrees(-106.6, 35.05, 0);

function fakeViewer({ sampled, globeShow, globeH }) {
  return {
    scene: {
      primitives: { length: 0 },
      sampleHeight: () => sampled,
      globe: { show: globeShow, getHeight: () => globeH },
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

test('fallback globe: when both the pick and the globe miss, there is still no evidence', () => {
  const snap = createGroundSnap();
  const viewer = fakeViewer({ sampled: undefined, globeShow: true, globeH: undefined });
  assert.equal(snap.heightFor(viewer, 'g1e', POS), null);
});
