/**
 * Reconstruction Cloud layer — an ABot-Recon point cloud on the globe.
 *
 * Loads the `reconstruction.ply` written by
 * `ABot-Recon/scripts/export_reconstruction_ply.py` plus its
 * `camera_poses.npy`, rotates both into the anchor's local ENU frame
 * (`reconstructionAnchor.js`), and renders the points as a
 * `Cesium.PointPrimitiveCollection` — the same one-collection-many-primitives
 * shape `traffic.js` uses for its road dots.
 *
 * The cloud is fetched straight from the asset URL rather than pushed through
 * the robot relay: `/api/robot/ingest` caps a batch at 256 KB
 * (server/robotProxies.js), which a decimated cloud still exceeds.
 *
 * Provenance: a reconstruction is recorded, and its geography is chosen by an
 * operator, so anything it drives is `SIMULATED · VIRTUAL TRANSPOSITION` —
 * never presented as live hardware.
 *
 * @module data/reconstructionCloud
 */

import * as Cesium from 'cesium';
import { parseBinaryPly } from './plyPointCloud.js';
import { parsePoseTrack } from './npyPoses.js';
import {
  anchorPoseTrack,
  normalizeAnchor,
  revealedPointCount,
  slamToEnu,
} from './reconstructionAnchor.js';

const DEFAULT_PLY_URL = '/recon/reconstruction.ply';
const DEFAULT_POSES_URL = '/recon/camera_poses.npy';
/**
 * @const {number} Primitive budget. One PointPrimitive per point costs CPU on
 * every collection update, so a multi-million-point export is decimated on
 * load; `--point-stride` in the exporter thins it further at the source.
 */
const MAX_POINTS = 220_000;
/** @const {number} Pixels — small enough that a dense cloud reads as surface. */
const POINT_PIXEL_SIZE = 3;
/** @const {number} Meters of ground clearance, so points do not z-fight terrain. */
const CLOUD_LIFT_M = 0.05;
/** @const {number} Surface-height samples before the anchor gives up on tiles. */
const ANCHOR_HEIGHT_ATTEMPTS = 8;
/** @const {number} Milliseconds between those samples, for tiles to stream in. */
const ANCHOR_HEIGHT_RETRY_MS = 400;

const state = {
  viewer: null,
  enabled: false,
  loading: false,
  error: null,
  /** @type {Cesium.PointPrimitiveCollection|null} */
  collection: null,
  /** @type {Array<Cesium.PointPrimitive>} in capture order */
  points: [],
  /** @type {Array<{lat: number, lon: number, elevM: number, headingDeg: number}>} */
  waypoints: [],
  anchor: null,
  plyUrl: DEFAULT_PLY_URL,
  posesUrl: DEFAULT_POSES_URL,
  loadedFrom: null,
  totalVertices: 0,
  revealed: 0,
  /** Bumps on every destroy/source change so a slow fetch drops its result. */
  epoch: 0,
  /** @type {Promise<{count: number, poses: number}>|null} In-flight load. */
  inflight: null,
  /** Surface height the cloud was placed on, and whether it was measured. */
  anchorHeightM: 0,
  anchorHeightMeasured: false,
};

function ensureCollection(viewer) {
  if (!viewer) return null;
  if (!state.collection || state.collection.isDestroyed?.()) {
    state.collection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    state.collection.show = state.enabled;
    state.points = [];
    state.revealed = 0;
  }
  return state.collection;
}

function clearPoints() {
  if (state.collection && !state.collection.isDestroyed?.()) state.collection.removeAll();
  state.points = [];
  state.revealed = 0;
  state.anchorHeightM = 0;
  state.anchorHeightMeasured = false;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Surface height under the anchor. The default stack is Google photoreal 3D
 * Tiles with `globe.show === false`, so `globe.getHeight` describes a surface
 * nobody can see — at a mountain anchor it answers the ellipsoid and the cloud
 * ends up kilometres underground. `sampleHeightMostDetailed` picks the RENDERED
 * surface and streams the tiles it needs, which is also what the replayed robot
 * rides on (groundSnap.js). The terrain-globe stacks keep `getHeight` as the
 * fallback.
 * @returns {Promise<number|null>} Null while nothing sampleable has resolved.
 */
async function sampleAnchorHeightM(viewer, anchor) {
  const scene = viewer?.scene;
  if (!scene) return null;
  if (scene.sampleHeightSupported && typeof scene.sampleHeightMostDetailed === 'function') {
    try {
      const sampled = await scene.sampleHeightMostDetailed(
        [Cesium.Cartographic.fromDegrees(anchor.lon, anchor.lat)],
      );
      const height = sampled?.[0]?.height;
      if (Number.isFinite(height)) return height;
    } catch {
      // Sampling is best-effort; fall through to the globe.
    }
  }
  if (scene.globe?.show === false) return null;
  const globeH = scene.globe?.getHeight(Cesium.Cartographic.fromDegrees(anchor.lon, anchor.lat));
  return Number.isFinite(globeH) ? globeH : null;
}

/**
 * Resolve the anchor's surface height before any point is placed: a bounded
 * retry, because tiles at an anchor the camera has never visited stream in
 * asynchronously and the first sample usually misses.
 * @returns {Promise<{heightM: number, measured: boolean}>}
 */
async function resolveAnchorHeightM(viewer, anchor, epoch) {
  for (let attempt = 0; attempt < ANCHOR_HEIGHT_ATTEMPTS; attempt += 1) {
    if (epoch !== state.epoch) return { heightM: 0, measured: false };
    const heightM = await sampleAnchorHeightM(viewer, anchor);
    if (heightM !== null) return { heightM, measured: true };
    if (attempt < ANCHOR_HEIGHT_ATTEMPTS - 1) await delay(ANCHOR_HEIGHT_RETRY_MS);
  }
  // Nothing sampleable (keyless globe, no tiles): the ellipsoid is the only
  // surface there is, and getStats() reports the placement as unmeasured.
  return { heightM: 0, measured: false };
}

/**
 * Build the ENU→ECEF frame for an anchor, ground-snapped like a `slam-local`
 * robot pose (see groundRobots.js).
 * @param {{lat: number, lon: number, elevM: number}} anchor
 * @param {number} groundM - Resolved surface height at the anchor.
 * @returns {Cesium.Matrix4}
 */
function anchorFrame(anchor, groundM) {
  const origin = Cesium.Cartesian3.fromDegrees(
    anchor.lon,
    anchor.lat,
    groundM + anchor.elevM + CLOUD_LIFT_M,
  );
  return Cesium.Transforms.eastNorthUpToFixedFrame(origin);
}

function addPoints(viewer, cloud, anchor, groundM) {
  const collection = ensureCollection(viewer);
  if (!collection) return;
  const frame = anchorFrame(anchor, groundM);
  const enuScratch = new Cesium.Cartesian3();
  for (let i = 0; i < cloud.count; i += 1) {
    const at = i * 3;
    const enu = slamToEnu(
      { x: cloud.positions[at], y: cloud.positions[at + 1], z: cloud.positions[at + 2] },
      anchor.headingDeg,
    );
    Cesium.Cartesian3.fromElements(enu.eastM, enu.northM, enu.upM, enuScratch);
    const position = Cesium.Matrix4.multiplyByPoint(frame, enuScratch, new Cesium.Cartesian3());
    const color = cloud.colors
      ? Cesium.Color.fromBytes(cloud.colors[at], cloud.colors[at + 1], cloud.colors[at + 2], 255)
      : Cesium.Color.fromCssColorString('#7ef0a5');
    state.points.push(collection.add({
      position,
      color,
      pixelSize: POINT_PIXEL_SIZE,
      show: false,
    }));
  }
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetch, parse and place the configured reconstruction.
 * @returns {Promise<{count: number, poses: number}>} Loaded sizes.
 */
async function loadReconstruction() {
  const viewer = state.viewer;
  if (!viewer) throw new Error('reconstruction layer is not initialized');
  const epoch = state.epoch;
  const anchor = state.anchor ? normalizeAnchor(state.anchor) : null;
  if (!anchor) throw new Error('reconstruction has no anchor; call setSource({anchor})');

  state.loading = true;
  state.error = null;
  try {
    const [plyBytes, poseBytes] = await Promise.all([
      fetchBytes(state.plyUrl),
      fetchBytes(state.posesUrl).catch(() => null),
    ]);
    if (epoch !== state.epoch) return { count: 0, poses: 0 };
    const cloud = parseBinaryPly(plyBytes, { maxPoints: MAX_POINTS });
    // Placement waits on the surface: a cloud written against the wrong height
    // is buried or floating, and re-placing 220k primitives afterwards is worse
    // than waiting for the tiles.
    const ground = await resolveAnchorHeightM(viewer, anchor, epoch);
    if (epoch !== state.epoch) return { count: 0, poses: 0 };
    clearPoints();
    addPoints(viewer, cloud, anchor, ground.heightM);
    state.anchorHeightM = ground.heightM;
    state.anchorHeightMeasured = ground.measured;
    state.totalVertices = cloud.totalVertices;
    state.waypoints = poseBytes ? anchorPoseTrack(parsePoseTrack(poseBytes), anchor) : [];
    state.loadedFrom = state.plyUrl;
    setRevealFraction(1);
    return { count: state.points.length, poses: state.waypoints.length };
  } catch (error) {
    if (epoch === state.epoch) {
      state.error = error instanceof Error ? error : new Error(String(error));
    }
    throw error;
  } finally {
    if (epoch === state.epoch) state.loading = false;
  }
}

/**
 * Load once per configured source: `enable()` and the demo button both want the
 * cloud, and a second fetch of a hundred-megabyte PLY is pure waste.
 * @returns {Promise<{count: number, poses: number}>}
 */
function loadOnce() {
  if (state.inflight) return state.inflight;
  const pending = loadReconstruction();
  state.inflight = pending;
  const clear = () => {
    if (state.inflight === pending) state.inflight = null;
  };
  pending.then(clear, clear);
  return pending;
}

/**
 * Show the prefix of the cloud a replay has reached, so it grows as the robot
 * walks. Points are stored in capture order, which is the order the exporter
 * flattens per-frame point maps in.
 * @param {number} fraction - Replay progress in [0, 1].
 * @returns {number} Points now visible.
 */
export function setRevealFraction(fraction) {
  const target = revealedPointCount(state.points.length, fraction);
  if (target === state.revealed) return target;
  const from = Math.min(state.revealed, target);
  const to = Math.max(state.revealed, target);
  for (let i = from; i < to; i += 1) state.points[i].show = i < target;
  state.revealed = target;
  state.viewer?.scene?.requestRender?.();
  return target;
}

const reconstructionCloudLayer = {
  id: 'recon-cloud',
  name: 'Reconstruction Cloud',
  icon: '🧿',
  source: 'ABot-Recon reconstruction (recorded)',

  init(viewer) {
    state.viewer = viewer;
    ensureCollection(viewer);
    if (state.collection) state.collection.show = false;
  },

  enable(viewer) {
    state.enabled = true;
    const activeViewer = viewer || state.viewer;
    state.viewer = activeViewer;
    ensureCollection(activeViewer);
    if (state.collection) state.collection.show = true;
    if (state.points.length || !state.anchor) return Promise.resolve();
    // A missing asset is the ordinary case (nothing published yet), so the
    // rejection is swallowed here and surfaced through getStats().
    return loadOnce().catch(() => {});
  },

  // A static asset has nothing to poll, but the manager treats a missing
  // `update` as a failed lifecycle and disables the layer again.
  update() {
    return true;
  },

  disable() {
    state.enabled = false;
    if (state.collection) state.collection.show = false;
    state.loading = false;
  },

  destroy() {
    state.epoch += 1;
    state.inflight = null;
    clearPoints();
    if (state.collection && !state.collection.isDestroyed?.()) {
      state.viewer?.scene?.primitives?.remove(state.collection);
    }
    state.collection = null;
    state.waypoints = [];
    state.loadedFrom = null;
    state.totalVertices = 0;
    state.error = null;
    state.enabled = false;
  },

  /**
   * Point the layer at an exported reconstruction and its anchor.
   * @param {{plyUrl?: string, posesUrl?: string,
   *   anchor: {lat: number, lon: number, headingDeg?: number, elevM?: number}}} options
   */
  setSource({ plyUrl, posesUrl, anchor }) {
    state.epoch += 1;
    state.anchor = normalizeAnchor(anchor);
    if (plyUrl) state.plyUrl = plyUrl;
    if (posesUrl) state.posesUrl = posesUrl;
    clearPoints();
    state.waypoints = [];
    state.loadedFrom = null;
    state.error = null;
    state.inflight = null;
  },

  /** Load now (the demo awaits this before it starts animating). */
  load() {
    return loadOnce();
  },

  /**
   * Surface height at an anchor: the height the cloud was placed on when it
   * was measured, otherwise a fresh sample of the rendered surface.
   * @param {{lat: number, lon: number}} [anchor]
   * @returns {Promise<number>}
   */
  async resolveAnchorSurfaceHeightM(anchor = state.anchor) {
    if (state.anchorHeightMeasured) return state.anchorHeightM;
    if (!state.viewer || !anchor) return 0;
    const ground = await resolveAnchorHeightM(state.viewer, anchor, state.epoch);
    return ground.heightM;
  },

  /** @returns {Array<{lat: number, lon: number, elevM: number, headingDeg: number}>} */
  getWaypoints() {
    return state.waypoints;
  },

  setRevealFraction,

  getStats() {
    return {
      count: state.points.length,
      loading: state.loading,
      error: state.error,
      status: state.error ? 'unavailable' : (state.points.length ? 'nominal' : 'idle'),
      source: 'ABot-Recon reconstruction (recorded)',
      coverage: state.loadedFrom || 'no reconstruction published',
      totalVertices: state.totalVertices,
      revealed: state.revealed,
      poses: state.waypoints.length,
      anchorHeightM: state.anchorHeightM,
      anchorHeightMeasured: state.anchorHeightMeasured,
    };
  },
};

export default reconstructionCloudLayer;
export { reconstructionCloudLayer, MAX_POINTS };
