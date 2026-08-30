/**
 * reconstructionCloud lifecycle tests — the parts that need a scene.
 *
 * The pure geometry lives in reconstructionAnchor/plyPointCloud tests; what is
 * checked here is the layer contract the manager relies on (a missing `update`
 * is a failed enable) and that placement rides the RENDERED surface rather than
 * the hidden globe, which is what buries a mountain anchor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import reconstructionCloudLayer from './reconstructionCloud.js';

const ANCHOR = {
  lat: 27.9819, lon: 86.8285, headingDeg: 0, elevM: 0,
};

/** A colored two-vertex PLY plus a trajectory edge, as the exporter writes. */
function plyBytes(points) {
  const header = 'ply\n'
    + 'format binary_little_endian 1.0\n'
    + `element vertex ${points.length}\n`
    + 'property float x\nproperty float y\nproperty float z\n'
    + 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
    + 'end_header\n';
  const head = new TextEncoder().encode(header);
  const body = new Uint8Array(points.length * 15);
  const view = new DataView(body.buffer);
  points.forEach(([x, y, z], i) => {
    const at = i * 15;
    view.setFloat32(at, x, true);
    view.setFloat32(at + 4, y, true);
    view.setFloat32(at + 8, z, true);
    body[at + 12] = 10;
    body[at + 13] = 20;
    body[at + 14] = 30;
  });
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * @param {{sampleHeight?: number|undefined, globeHeight?: number,
 *   globeShown?: boolean}} options
 */
function makeViewer({ sampleHeight, globeHeight = 0, globeShown = true } = {}) {
  const added = [];
  return {
    added,
    scene: {
      sampleHeightSupported: sampleHeight !== null,
      sampleHeightMostDetailed: async (cartographics) => cartographics.map((c) => {
        const out = Cesium.Cartographic.clone(c);
        out.height = sampleHeight;
        return out;
      }),
      globe: { show: globeShown, getHeight: () => globeHeight },
      primitives: {
        add: (p) => { added.push(p); return p; },
        remove: () => true,
      },
      requestRender: () => {},
    },
  };
}

function withFetch(bodies, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = bodies[String(url)];
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}

/** Height of a placed primitive above the ellipsoid. */
function heightOf(point) {
  return Cesium.Cartographic.fromCartesian(point.position).height;
}

test('the layer exposes the update() the manager requires to keep it enabled', () => {
  assert.equal(typeof reconstructionCloudLayer.update, 'function');
  assert.notEqual(reconstructionCloudLayer.update(), false,
    'a false update rejects the enable transaction (manager._doToggle)');
});

test('points are placed on the sampled render surface, not the hidden globe', async () => {
  const viewer = makeViewer({ sampleHeight: 5300, globeHeight: 0, globeShown: false });
  reconstructionCloudLayer.init(viewer);
  reconstructionCloudLayer.setSource({
    anchor: ANCHOR,
    plyUrl: '/t/one.ply',
    posesUrl: '/t/none.npy',
  });
  await withFetch({ '/t/one.ply': plyBytes([[0, 0, 0]]) }, async () => {
    await reconstructionCloudLayer.enable(viewer);
  });
  const stats = reconstructionCloudLayer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.anchorHeightMeasured, true);
  assert.equal(Math.round(stats.anchorHeightM), 5300);
  const collection = viewer.added[0];
  assert.ok(Math.abs(heightOf(collection.get(0)) - 5300) < 1,
    'a Khumbu cloud placed off the hidden globe would sit kilometres underground');
  reconstructionCloudLayer.destroy();
});

test('a visible terrain globe still answers when sampling misses', async () => {
  const viewer = makeViewer({ sampleHeight: undefined, globeHeight: 4200, globeShown: true });
  reconstructionCloudLayer.init(viewer);
  reconstructionCloudLayer.setSource({ anchor: ANCHOR, plyUrl: '/t/one.ply', posesUrl: '/t/none.npy' });
  await withFetch({ '/t/one.ply': plyBytes([[0, 0, 0]]) }, async () => {
    await reconstructionCloudLayer.load();
  });
  const stats = reconstructionCloudLayer.getStats();
  assert.equal(stats.anchorHeightMeasured, true);
  assert.equal(Math.round(stats.anchorHeightM), 4200);
  reconstructionCloudLayer.destroy();
});

test('replacing the source drops the previous placement instead of reporting it', async () => {
  const viewer = makeViewer({ sampleHeight: 5300, globeShown: false });
  reconstructionCloudLayer.init(viewer);
  reconstructionCloudLayer.setSource({ anchor: ANCHOR, plyUrl: '/t/one.ply', posesUrl: '/t/none.npy' });
  await withFetch({ '/t/one.ply': plyBytes([[0, 0, 0]]) }, async () => {
    await reconstructionCloudLayer.load();
  });
  assert.equal(reconstructionCloudLayer.getStats().anchorHeightMeasured, true);
  reconstructionCloudLayer.setSource({ anchor: ANCHOR, plyUrl: '/t/other.ply', posesUrl: '/t/none.npy' });
  const stats = reconstructionCloudLayer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.anchorHeightM, 0);
  assert.equal(stats.anchorHeightMeasured, false,
    'an unloaded source must not inherit the last cloud\'s measured height');
  reconstructionCloudLayer.destroy();
  assert.equal(reconstructionCloudLayer.getStats().anchorHeightMeasured, false);
});

test('a missing reconstruction leaves the layer honest instead of throwing out of enable', async () => {
  const viewer = makeViewer({ sampleHeight: 10 });
  reconstructionCloudLayer.init(viewer);
  reconstructionCloudLayer.setSource({ anchor: ANCHOR, plyUrl: '/t/missing.ply', posesUrl: '/t/none.npy' });
  await withFetch({}, async () => {
    await reconstructionCloudLayer.enable(viewer);
  });
  const stats = reconstructionCloudLayer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.status, 'unavailable');
  assert.match(String(stats.error?.message), /404/);
  reconstructionCloudLayer.destroy();
});

test('one in-flight load serves concurrent enable and load callers', async () => {
  const viewer = makeViewer({ sampleHeight: 12 });
  reconstructionCloudLayer.init(viewer);
  reconstructionCloudLayer.setSource({ anchor: ANCHOR, plyUrl: '/t/one.ply', posesUrl: '/t/none.npy' });
  let fetches = 0;
  const original = globalThis.fetch;
  const bytes = plyBytes([[0, 0, 0], [1, 0, 2]]);
  globalThis.fetch = async (url) => {
    fetches += 1;
    if (String(url) === '/t/one.ply') {
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) };
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  try {
    const [, loaded] = await Promise.all([
      reconstructionCloudLayer.enable(viewer),
      reconstructionCloudLayer.load(),
    ]);
    assert.equal(loaded.count, 2);
    assert.equal(fetches, 2, 'one PLY fetch plus its pose sibling, not two of each');
  } finally {
    globalThis.fetch = original;
    reconstructionCloudLayer.destroy();
  }
});
