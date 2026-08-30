/**
 * Binary PLY point-cloud reader — the browser half of the ABot-Recon export.
 *
 * `ABot-Recon/scripts/export_reconstruction_ply.py` writes a
 * `binary_little_endian` file whose `vertex` element carries
 * `float x/y/z` + `uchar red/green/blue`, followed by an `edge` element
 * (camera frustums and the trajectory polyline) this reader skips. Parsing the
 * file in the browser is deliberate: the relay's `/api/robot/ingest` caps a
 * batch at 256 KB (server/robotProxies.js), which a multi-million-point cloud
 * exceeds by three orders of magnitude.
 *
 * Pure and Cesium-free so it runs identically in the browser and Node tests.
 *
 * @module data/plyPointCloud
 */

/** @const {number} Header scan limit — a real header is a few hundred bytes. */
const MAX_HEADER_BYTES = 64 * 1024;

/** Byte width of every scalar type PLY can name. */
const TYPE_SIZES = Object.freeze({
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8,
});

/** Property names this reader consumes, mapped onto its output arrays. */
const WANTED = Object.freeze({
  x: 'x', y: 'y', z: 'z', red: 'red', green: 'green', blue: 'blue',
});

function decodeHeader(bytes) {
  const limit = Math.min(bytes.length, MAX_HEADER_BYTES);
  const text = new TextDecoder('ascii').decode(bytes.subarray(0, limit));
  const marker = text.indexOf('end_header\n');
  if (marker < 0) throw new Error('PLY header is missing end_header');
  return { text: text.slice(0, marker), dataStart: marker + 'end_header\n'.length };
}

/**
 * Parse a PLY header into element layouts.
 * @param {Uint8Array} bytes - Start of the file (header may be a prefix).
 * @returns {{dataStart: number, elements: Array<{name: string, count: number,
 *   stride: number, properties: Array<{name: string, type: string, offset: number}>}>}}
 */
export function parsePlyHeader(bytes) {
  const { text, dataStart } = decodeHeader(bytes);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('not a PLY file');
  const format = lines.find((line) => line.startsWith('format '));
  if (!format) throw new Error('PLY header is missing a format line');
  const encoding = format.split(/\s+/)[1];
  if (encoding !== 'binary_little_endian') {
    throw new Error(`unsupported PLY format: ${encoding}`);
  }

  const elements = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'element') {
      const count = Number.parseInt(parts[2], 10);
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`invalid element count for ${parts[1]}`);
      }
      elements.push({ name: parts[1], count, stride: 0, properties: [] });
    } else if (parts[0] === 'property') {
      const element = elements[elements.length - 1];
      if (!element) throw new Error('PLY property declared before any element');
      if (parts[1] === 'list') {
        // A list property makes the element's stride per-record. This reader
        // needs fixed strides to seek past `edge`, so refuse rather than
        // silently mis-address the vertices behind it.
        throw new Error(`unsupported PLY list property in element ${element.name}`);
      }
      const size = TYPE_SIZES[parts[1]];
      if (!size) throw new Error(`unsupported PLY property type: ${parts[1]}`);
      element.properties.push({ name: parts[2], type: parts[1], offset: element.stride });
      element.stride += size;
    }
  }
  if (!elements.length) throw new Error('PLY header declares no elements');
  return { dataStart, elements };
}

function readScalar(view, byteOffset, type) {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(byteOffset);
    case 'uchar': case 'uint8': return view.getUint8(byteOffset);
    case 'short': case 'int16': return view.getInt16(byteOffset, true);
    case 'ushort': case 'uint16': return view.getUint16(byteOffset, true);
    case 'int': case 'int32': return view.getInt32(byteOffset, true);
    case 'uint': case 'uint32': return view.getUint32(byteOffset, true);
    case 'float': case 'float32': return view.getFloat32(byteOffset, true);
    case 'double': case 'float64': return view.getFloat64(byteOffset, true);
    default: throw new Error(`unsupported PLY property type: ${type}`);
  }
}

/**
 * Keep every `stride`-th index, then cap the result at `maxPoints`.
 * @param {number} count - Vertices in the file.
 * @param {number} stride - Keep 1 of every `stride` vertices (>=1).
 * @param {number} maxPoints - 0 or less means no cap.
 * @returns {number} Effective stride that satisfies both limits.
 */
export function decimationStride(count, stride, maxPoints) {
  const base = Math.max(1, Math.floor(stride) || 1);
  if (!(maxPoints > 0)) return base;
  const kept = Math.ceil(count / base);
  if (kept <= maxPoints) return base;
  return Math.ceil(count / maxPoints);
}

/**
 * Read the `vertex` element of a binary-little-endian PLY.
 *
 * Colors are optional: a file without `red/green/blue` yields a null `colors`
 * array, and the caller picks its own palette.
 *
 * @param {ArrayBuffer|Uint8Array} source - Whole file.
 * @param {{stride?: number, maxPoints?: number}} [options] - Decimation.
 *   `stride` keeps 1 of every N vertices; `maxPoints` caps the total, raising
 *   the stride further when needed.
 * @returns {{count: number, positions: Float32Array, colors: Uint8Array|null,
 *   totalVertices: number, stride: number}} `positions` is xyz-interleaved.
 */
export function parseBinaryPly(source, { stride = 1, maxPoints = 0 } = {}) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const { dataStart, elements } = parsePlyHeader(bytes);
  const vertex = elements.find((element) => element.name === 'vertex');
  if (!vertex) throw new Error('PLY header declares no vertex element');

  const offsets = {};
  const types = {};
  for (const property of vertex.properties) {
    const key = WANTED[property.name];
    if (!key) continue;
    offsets[key] = property.offset;
    types[key] = property.type;
  }
  for (const axis of ['x', 'y', 'z']) {
    if (offsets[axis] === undefined) throw new Error(`PLY vertex is missing ${axis}`);
  }
  const hasColor = ['red', 'green', 'blue'].every((key) => offsets[key] !== undefined);

  const required = dataStart + vertex.count * vertex.stride;
  if (bytes.length < required) {
    throw new Error(`PLY body is truncated: need ${required} bytes, have ${bytes.length}`);
  }

  const step = decimationStride(vertex.count, stride, maxPoints);
  const kept = Math.ceil(vertex.count / step);
  const positions = new Float32Array(kept * 3);
  const colors = hasColor ? new Uint8Array(kept * 3) : null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let written = 0;
  for (let index = 0; index < vertex.count; index += step) {
    const record = dataStart + index * vertex.stride;
    const x = readScalar(view, record + offsets.x, types.x);
    const y = readScalar(view, record + offsets.y, types.y);
    const z = readScalar(view, record + offsets.z, types.z);
    // The exporter drops non-finite points, but a hand-made or partially
    // written file can still carry them, and one NaN poisons a whole
    // PointPrimitiveCollection's bounding volume.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const out = written * 3;
    positions[out] = x;
    positions[out + 1] = y;
    positions[out + 2] = z;
    if (colors) {
      colors[out] = readScalar(view, record + offsets.red, types.red);
      colors[out + 1] = readScalar(view, record + offsets.green, types.green);
      colors[out + 2] = readScalar(view, record + offsets.blue, types.blue);
    }
    written += 1;
  }

  return {
    count: written,
    positions: written === kept ? positions : positions.subarray(0, written * 3),
    colors: colors && (written === kept ? colors : colors.subarray(0, written * 3)),
    totalVertices: vertex.count,
    stride: step,
  };
}
