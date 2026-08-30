// src/data/npyPoses.test.mjs
// `camera_poses.npy` is written by NumPy, so the reader is tested against
// byte-exact fixtures in both header versions and both float widths ABot-Recon
// can emit — a wrong header offset silently shifts every pose by a few bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNpy, parsePoseTrack } from './npyPoses.js';

/**
 * Build a `.npy` file the way `numpy.save` does.
 * @param {{shape: number[], values: number[], dtype?: '<f4'|'<f8',
 *   major?: number, fortran?: boolean}} spec
 * @returns {Uint8Array}
 */
function buildNpy({ shape, values, dtype = '<f8', major = 1, fortran = false }) {
  const size = dtype === '<f4' ? 4 : 8;
  const shapeText = shape.length === 1 ? `${shape[0]},` : shape.join(', ');
  let header = `{'descr': '${dtype}', 'fortran_order': ${fortran ? 'True' : 'False'}, `
    + `'shape': (${shapeText}), }`;
  const prefix = major === 1 ? 10 : 12;
  while ((prefix + header.length + 1) % 64 !== 0) header += ' ';
  header += '\n';
  const bytes = new Uint8Array(prefix + header.length + values.length * size);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, major, 0], 0);
  const view = new DataView(bytes.buffer);
  if (major === 1) view.setUint16(8, header.length, true);
  else view.setUint32(8, header.length, true);
  bytes.set(new TextEncoder().encode(header), prefix);
  values.forEach((value, i) => {
    const at = prefix + header.length + i * size;
    if (size === 4) view.setFloat32(at, value, true);
    else view.setFloat64(at, value, true);
  });
  return bytes;
}

test('float64 and float32 arrays read back in C order', () => {
  const values = [1, 2, 3, 4, 5, 6];
  for (const dtype of ['<f8', '<f4']) {
    const { shape, data } = parseNpy(buildNpy({ shape: [2, 3], values, dtype }));
    assert.deepEqual(shape, [2, 3]);
    assert.deepEqual([...data], values);
  }
});

test('version-2 headers (4-byte length) are read at the right offset', () => {
  const { shape, data } = parseNpy(buildNpy({ shape: [2], values: [11, 22], major: 2 }));
  assert.deepEqual(shape, [2]);
  assert.deepEqual([...data], [11, 22]);
});

test('a [N,4,4] pose array yields translation centers and +Z forwards', () => {
  // Camera 0: identity rotation at the origin — forward is +Z.
  // Camera 1: yawed 90° about the SLAM +y (down) axis, translated 3 m.
  const track = parsePoseTrack(buildNpy({
    shape: [2, 4, 4],
    values: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,

      0, 0, 1, 3,
      0, 1, 0, -1,
      -1, 0, 0, 7,
      0, 0, 0, 1,
    ],
  }));
  assert.equal(track.count, 2);
  assert.deepEqual([...track.centers], [0, 0, 0, 3, -1, 7]);
  assert.deepEqual([...track.forwards], [0, 0, 1, 1, 0, 0]);
});

test('a [N,3,4] pose array is accepted with the same column meanings', () => {
  const track = parsePoseTrack(buildNpy({
    shape: [1, 3, 4],
    values: [
      1, 0, 0, 5,
      0, 1, 0, 6,
      0, 0, 1, 7,
    ],
  }));
  assert.deepEqual([...track.centers], [5, 6, 7]);
  assert.deepEqual([...track.forwards], [0, 0, 1]);
});

test('files this reader would misread are refused', () => {
  assert.throws(() => parseNpy(new Uint8Array(4)), /truncated/);
  assert.throws(() => parseNpy(new Uint8Array(32)), /not a \.npy file/);
  assert.throws(
    () => parseNpy(buildNpy({ shape: [2], values: [1, 2], fortran: true })),
    /Fortran-ordered/,
  );
  const truncated = buildNpy({ shape: [4], values: [1, 2, 3, 4] }).subarray(0, -8);
  assert.throws(() => parseNpy(truncated), /body is truncated/);
  assert.throws(
    () => parsePoseTrack(buildNpy({ shape: [2, 3], values: [1, 2, 3, 4, 5, 6] })),
    /expected \[N,4,4\] camera poses, got \[2,3\]/,
  );
});
