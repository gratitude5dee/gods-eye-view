import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNepalViewpointPack } from '../../server/proxies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_FILE = path.join(ROOT, 'config/cctv_sources.nepal.json');

/** Nepal's national bounding box; every viewpoint must fall inside it. */
const NEPAL_BBOX = { south: 26.3, west: 80.0, north: 30.5, east: 88.3 };

test('the Nepal viewpoint pack ships with the repo', () => {
  assert.ok(fs.existsSync(PACK_FILE), 'run scripts/build-cctv-pack-nepal.mjs to regenerate the pack');
  const pack = loadNepalViewpointPack();
  assert.ok(pack.length >= 10, `expected a usable mesh, got ${pack.length} viewpoints`);
});

test('every viewpoint is posed on the ground inside Nepal', () => {
  for (const entry of loadNepalViewpointPack()) {
    assert.ok(
      entry.lat > NEPAL_BBOX.south && entry.lat < NEPAL_BBOX.north
      && entry.lon > NEPAL_BBOX.west && entry.lon < NEPAL_BBOX.east,
      `${entry.id} at ${entry.lat},${entry.lon} is outside Nepal`,
    );
    assert.ok(entry.headingDeg >= 0 && entry.headingDeg < 360, `${entry.id} heading out of range`);
    assert.ok(Number.isFinite(entry.groundElevationM), `${entry.id} has no ground elevation`);
    assert.ok(entry.pitchDeg < 0, `${entry.id} must look down the road, not at the sky`);
  }
});

test('viewpoints carry no feed URL so the frame route falls through to Street View', () => {
  for (const entry of loadNepalViewpointPack()) {
    assert.equal(entry.url, undefined, `${entry.id} must not declare an upstream feed`);
    assert.equal(entry.snapshotUrl, undefined, `${entry.id} must not declare a snapshot feed`);
    assert.equal(entry.feedType, 'image');
    assert.equal(entry.poseSource, 'curated');
  }
});

test('viewpoint ids are unique so the catalog merge cannot silently drop one', () => {
  const ids = loadNepalViewpointPack().map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('both road runs are represented', () => {
  const pack = loadNepalViewpointPack();
  assert.ok(pack.some((entry) => entry.cityId === 'kathmandu'), 'Ring Road run missing');
  assert.ok(pack.some((entry) => entry.cityId === 'rasuwagadhi'), 'flood-corridor run missing');
});

test('CCTV_NEPAL_ENABLED=0 removes the pack without touching the live packs', () => {
  const previous = process.env.CCTV_NEPAL_ENABLED;
  process.env.CCTV_NEPAL_ENABLED = '0';
  try {
    assert.deepEqual(loadNepalViewpointPack(), []);
  } finally {
    if (previous === undefined) delete process.env.CCTV_NEPAL_ENABLED;
    else process.env.CCTV_NEPAL_ENABLED = previous;
  }
});
