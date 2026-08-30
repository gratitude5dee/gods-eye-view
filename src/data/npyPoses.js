/**
 * NumPy `.npy` reader for ABot-Recon camera trajectories.
 *
 * `demo.py` writes `camera_poses.npy` as an `[N,4,4]` array of camera-to-world
 * matrices. This module reads that file and reduces it to what the globe needs:
 * per-frame camera centers and forward axes.
 *
 * Pure and Cesium-free so it runs identically in the browser and Node tests.
 *
 * @module data/npyPoses
 */

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

/** Little-endian dtypes an ABot-Recon pose array can carry. */
const DTYPES = Object.freeze({
  '<f4': { size: 4, read: (view, at) => view.getFloat32(at, true) },
  '<f8': { size: 8, read: (view, at) => view.getFloat64(at, true) },
  '|f4': { size: 4, read: (view, at) => view.getFloat32(at, true) },
  '=f4': { size: 4, read: (view, at) => view.getFloat32(at, true) },
  '=f8': { size: 8, read: (view, at) => view.getFloat64(at, true) },
});

function parseShape(header) {
  const match = /'shape'\s*:\s*\(([^)]*)\)/.exec(header);
  if (!match) throw new Error('.npy header is missing shape');
  return match[1].split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const value = Number.parseInt(part, 10);
      if (!Number.isFinite(value) || value < 0) throw new Error(`invalid .npy shape entry: ${part}`);
      return value;
    });
}

/**
 * Read a C-ordered, little-endian float `.npy` array.
 * @param {ArrayBuffer|Uint8Array} source - Whole file.
 * @returns {{shape: number[], data: Float64Array}} Flattened C-order values.
 */
export function parseNpy(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.length < 10) throw new Error('.npy file is truncated');
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) throw new Error('not a .npy file');
  }
  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = major === 1
    ? view.getUint16(8, true)
    : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder('ascii').decode(
    bytes.subarray(headerStart, headerStart + headerLength),
  );

  if (/'fortran_order'\s*:\s*True/.test(header)) {
    throw new Error('Fortran-ordered .npy is unsupported');
  }
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header);
  if (!descr) throw new Error('.npy header is missing descr');
  const dtype = DTYPES[descr[1]];
  if (!dtype) throw new Error(`unsupported .npy dtype: ${descr[1]}`);

  const shape = parseShape(header);
  const count = shape.reduce((product, dimension) => product * dimension, 1);
  const bodyStart = headerStart + headerLength;
  if (bytes.length < bodyStart + count * dtype.size) throw new Error('.npy body is truncated');

  const data = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    data[i] = dtype.read(view, bodyStart + i * dtype.size);
  }
  return { shape, data };
}

/**
 * Reduce `camera_poses.npy` to camera centers and forward axes.
 *
 * Accepts `[N,4,4]` and `[N,3,4]` camera-to-world matrices: the center is the
 * translation column, the forward axis the third rotation column (+Z in the
 * OpenCV-style camera frame ABot-Recon uses, matching the `poses[i,:3,2]`
 * heading that `export_reconstruction_ply.py` draws in its BEV).
 *
 * @param {ArrayBuffer|Uint8Array} source - `camera_poses.npy` bytes.
 * @returns {{count: number, centers: Float64Array, forwards: Float64Array}}
 *   Both arrays are xyz-interleaved, `count * 3` long.
 */
export function parsePoseTrack(source) {
  const { shape, data } = parseNpy(source);
  if (shape.length !== 3 || shape[2] !== 4 || (shape[1] !== 4 && shape[1] !== 3)) {
    throw new Error(`expected [N,4,4] camera poses, got [${shape.join(',')}]`);
  }
  const count = shape[0];
  const rows = shape[1];
  const centers = new Float64Array(count * 3);
  const forwards = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const base = i * rows * 4;
    for (let axis = 0; axis < 3; axis += 1) {
      centers[i * 3 + axis] = data[base + axis * 4 + 3];
      forwards[i * 3 + axis] = data[base + axis * 4 + 2];
    }
  }
  return { count, centers, forwards };
}
