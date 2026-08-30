/**
 * Ground Robots layer — live humanoid/quadruped telemetry on the globe.
 *
 * Renders RobotFrames relayed by `/api/robot/*` (see server/robotProxies.js
 * and tools/robot-bridge). Positions interpolate one telemetry interval
 * behind wall clock between real fixes, with bounded coasting past the newest
 * fix (src/data/robotMotion.js) — a stale robot freezes, never drifts.
 *
 * Provenance is first-class: every robot carries its frame's provenance chip
 * (`LIVE`/`PHONE PROXY`/`REPLAY`/`SIMULATED`, plus `VIRTUAL TRANSPOSITION`
 * when the geography is staged) on its overlay card.
 *
 * Camera contract: selection announces `requestWorldFocus` — this layer never
 * moves the camera itself. The chase camera (src/robotChaseCamera.js) is
 * engaged explicitly and torn down via `releaseCameraOwnership()` from
 * ui.js::_releaseFollowCamera().
 *
 * @module data/groundRobots
 */

import * as Cesium from 'cesium';
import { provenanceChip } from './robotFrame.js';
import { ROBOT_RENDER_DELAY_MS, robotPoseAt, pushFix } from './robotMotion.js';
import { createGroundSnap } from './groundSnap.js';
import { advanceGaitPhase, gaitJointAngles, GAIT_POSED_NODES } from './robotGaitPose.js';
import { createTrail } from './trailRenderer.js';
import { screenProjectedRotation } from './iconOrientation.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  unregisterPickOwner,
  resolvePickId,
} from './pickRegistry.js';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
} from './spriteOrder.js';
import { ensureGeoidReady, geoidHeight } from './geoid.js';
import { requestWorldFocus } from '../worldFocus.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { createRobotChaseCamera } from '../robotChaseCamera.js';

const TELEMETRY_URL = '/api/robot/telemetry';
const STREAM_URL = '/api/robot/stream';
const REFRESH_MS = 1000;
const OVERLAY_SOURCE_ID = 'ground-robots';
/**
 * Announcement event for chase-camera entry. The layer never engages the
 * chase itself — ui.js routes this through runImmediateNavigation('robot')
 * so the shared camera authority claims ownership first.
 */
export const ROBOT_CHASE_REQUEST_EVENT = 'gev:robot-chase-request';
const TRAIL_COLOR = '#7ef0a5';
const TRAIL_MAX_POINTS = 400;
/** Minimum movement (m) before the selected trail appends a vertex. */
const TRAIL_MIN_MOVE_M = 0.5;
const FIX_HISTORY = 5;
const ROBOT_LIFT_M = 0.4;

// --- Optional 3D models (`models3d`, default OFF) ------------------------------------
// A robot hands its billboard glyph off to a depth-tested glTF exactly the way a
// fleet aircraft does in flights.js (_ensureModel / _driveFleetModelHandoff /
// _modelDisplayPosition): the model loads hidden, its matrix is written before
// the readiness test, and the billboard keeps the visual until the model is both
// ready and placed — so no frame can hide both.
const ROBOT_MODEL_URL = '/models/unitree-g1.glb';
/** unitree-g1.glb faces −X, like every other bundled model. */
const ROBOT_MODEL_HEADING_OFFSET_DEG = 180;
/** Floor so a distant G1 stays findable without ballooning into a blob. */
const ROBOT_MODEL_MIN_PX = 18;
/** The GLB's origin sits between the soles (scene AABB min Y ≈ 0), so a model
 *  placed at the snapped terrain height already stands on the ground: no belly
 *  lift, and none of the billboard's ROBOT_LIFT_M glyph clearance either. */
const ROBOT_MODEL_BELLY_OFFSET_M = 0;
/** One draw call each, bounded by the relay's own MAX_ROBOTS. */
const ROBOT_MODEL_MAX = 16;
/** Robots with no accepted frame for this long drop from the display. */
const ROBOT_EXPIRE_MS = 5 * 60 * 1000;

const ACCENT = '#7ef0a5';

/** @type {Map<string, string>} accent -> robot glyph SVG data URL */
const iconCache = new Map();

function robotIconUrl(cssColor) {
  let url = iconCache.get(cssColor);
  if (url) return url;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">`
    + `<g fill="none" stroke="${cssColor}" stroke-width="2">`
    + `<rect x="9" y="4" width="12" height="9" rx="2"/>`
    + `<rect x="11" y="15" width="8" height="8" rx="1.5"/>`
    + `<line x1="12" y1="23" x2="12" y2="27"/><line x1="18" y1="23" x2="18" y2="27"/>`
    + `<circle cx="13" cy="8.5" r="0.8" fill="${cssColor}"/><circle cx="17" cy="8.5" r="0.8" fill="${cssColor}"/>`
    + `</g></svg>`;
  url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  iconCache.set(cssColor, url);
  return url;
}

const state = {
  viewer: null,
  enabled: false,
  loading: false,
  error: null,
  lastUpdate: null,
  /** @type {Map<string, object>} robot id -> record */
  robots: new Map(),
  billboardCollection: null,
  /** @type {EventSource|null} */
  eventSource: null,
  streamStatus: 'idle',
  selectedId: null,
  trail: null,
  clickHandler: null,
  preRenderRemover: null,
  chaseCamera: null,
  chaseTargetId: null,
  /** @type {Cesium.Cartesian3[]} Selected-robot trail vertices. */
  trailPoints: [],
  abort: null,
  /** Serverless deploys have no persistent relay — degraded, not an error. */
  relayUnsupported: false,
  geoidReady: false,
  groundSnap: null,
  /** Feature flag: OFF renders exactly the historical billboard-only path. */
  models3d: false,
  /** @type {Cesium.PrimitiveCollection|null} */
  modelCollection: null,
  /** @type {Set<string>} ids with a glTF load in flight */
  modelPending: new Set(),
  /** @type {Map<string, number>} id -> load generation (invalidates stale loads) */
  modelGen: new Map(),
  /** Lifecycle token: destroy() bumps it so in-flight loads drop their model. */
  modelEpoch: 0,
};

function ensureCollections(viewer) {
  if (!viewer || state.billboardCollection) return;
  state.billboardCollection = new Cesium.BillboardCollection({ scene: viewer.scene });
  viewer.scene.primitives.add(state.billboardCollection);
  registerSpriteCollection('ground-robots', state.billboardCollection);
}

function recordFor(id) {
  let record = state.robots.get(id);
  if (!record) {
    record = {
      id,
      fixes: [],
      latestFrame: null,
      billboard: null,
      position: null,
      groundHeightM: null,
      rotationPrev: null,
      lastPose: null,
      /** @type {Cesium.Model|null} Optional glTF (models3d only). */
      model: null,
      /** @type {Map<string, Cesium.ModelNode>|null} Posed-joint node cache. */
      modelNodes: null,
      gaitPhase: 0,
      gaitPhaseMs: null,
    };
    state.robots.set(id, record);
  }
  return record;
}

/** Fold one accepted frame into a record's bounded fix history. */
function acceptFrame(frame) {
  const record = recordFor(frame.id);
  // Frames can arrive out of order; stale or duplicate ones must not touch
  // latestFrame or the fix history (pushFix would also reject them).
  if (record.latestFrame && frame.t <= record.latestFrame.t) return;
  // Fix elevations are only meaningful within one datum: a datum switch
  // (e.g. wgs84 → agl) would interpolate across incompatible units, so the
  // position history restarts from the new frame instead.
  if (record.latestFrame && record.latestFrame.datum !== frame.datum) {
    record.fixes.length = 0;
  }
  record.latestFrame = frame;
  pushFix(record.fixes, {
    t: frame.t,
    lat: frame.pose.lat,
    lon: frame.pose.lon,
    elevM: frame.pose.altM,
    headingDeg: frame.pose.headingDeg ?? 0,
    speedMps: frame.vel?.speedMps ?? 0,
  }, FIX_HISTORY);
  state.lastUpdate = Date.now();
}

/**
 * Ellipsoid height for a record's current pose without a terrain sample.
 * WGS84 renders directly; EGM96 adds geoid undulation. AGL and slam-local
 * altitudes are ground-relative, so they return null (not renderable) until
 * groundSnap supplies a terrain height — treating them as orthometric would
 * place the robot near sea level.
 */
function ellipsoidHeightM(record, pose) {
  const datum = record.latestFrame?.datum;
  if (datum === 'wgs84-ellipsoid') return pose.elevM;
  if (datum === 'agl' || datum === 'slam-local') return null;
  const n = state.geoidReady ? geoidHeight(pose.lat, pose.lon) : 0;
  return pose.elevM + (Number.isFinite(n) ? n : 0);
}

/**
 * Everything `scene.sampleHeight` must not hit when snapping a model: the
 * vertical pick ray at a robot's own lat/lon otherwise lands on that robot's
 * billboard or model instead of the tile skin, and each sample would then walk
 * the robot upward. Both primitives carry the robot id as their pick `id`, so
 * the id list covers them. Only passed while `models3d` is on — the
 * billboard-only path keeps its historical (unexcluded) sampling.
 */
function groundSampleExclusions() {
  return [...state.robots.keys()];
}

function ensureModelCollection(viewer) {
  if (!viewer || state.modelCollection) return;
  state.modelCollection = new Cesium.PrimitiveCollection();
  viewer.scene.primitives.add(state.modelCollection);
}

/**
 * Start (at most one) glTF load for a robot. Mirrors flights.js::_ensureModel:
 * pending loads count against the cap, a lifecycle epoch and per-robot
 * generation reject stale completions, and an admitted model is added hidden so
 * it cannot claim the visual at the identity matrix before the handoff places it.
 * @param {object} record
 */
async function ensureRobotModel(record) {
  if (!state.models3d || record.model || state.modelPending.has(record.id)) return;
  ensureModelCollection(state.viewer);
  if (!state.modelCollection) return;
  const live = state.modelCollection.length;
  if (live + state.modelPending.size >= ROBOT_MODEL_MAX) return;
  const epoch = state.modelEpoch;
  const gen = state.modelGen.get(record.id) || 0;
  state.modelPending.add(record.id);
  let model = null;
  try {
    model = await Cesium.Model.fromGltfAsync({
      url: ROBOT_MODEL_URL,
      asynchronous: false,
      minimumPixelSize: ROBOT_MODEL_MIN_PX,
      scale: 1, // the GLB is vertex-baked to real-world meters
      id: record.id, // so scene.pick returns the robot id, like the billboard
    });
  } catch {
    // Asset/decode failure — the robot simply stays a billboard.
    if (epoch === state.modelEpoch) state.modelPending.delete(record.id);
    cleanupModelGen(record.id);
    return;
  }
  if (epoch !== state.modelEpoch) {
    try { model.destroy(); } catch { /* already gone */ }
    return;
  }
  state.modelPending.delete(record.id);
  const current = state.robots.get(record.id);
  const stale = (state.modelGen.get(record.id) || 0) !== gen
    || !state.models3d || !state.enabled
    || !state.modelCollection || state.modelCollection.isDestroyed()
    || current !== record || current.model
    || state.modelCollection.length >= ROBOT_MODEL_MAX;
  if (stale) {
    try { model.destroy(); } catch { /* already gone */ }
    cleanupModelGen(record.id);
    return;
  }
  model.show = false; // admitted, not yet the visual
  state.modelCollection.add(model);
  record.model = model;
}

/** Drop a robot's generation entry once nothing references it. */
function cleanupModelGen(id) {
  if (!state.modelPending.has(id) && !state.robots.get(id)?.model) state.modelGen.delete(id);
}

/** Release one robot's model, invalidating any load still in flight for it. */
function releaseRobotModel(record) {
  if (record.model || state.modelPending.has(record.id)) {
    state.modelGen.set(record.id, (state.modelGen.get(record.id) || 0) + 1);
  }
  if (record.model) {
    if (state.modelCollection && !state.modelCollection.isDestroyed()) {
      try { state.modelCollection.remove(record.model); } catch { /* gone */ }
    }
    record.model = null;
    record.modelNodes = null;
  }
  cleanupModelGen(record.id);
}

/** Release every model (flag off / disable) and give the billboards back. */
function releaseRobotModels() {
  for (const id of state.modelPending) {
    state.modelGen.set(id, (state.modelGen.get(id) || 0) + 1);
  }
  for (const record of state.robots.values()) {
    releaseRobotModel(record);
    if (record.billboard) record.billboard.show = true;
  }
}

/** @type {Cesium.HeadingPitchRoll} */
const scratchHpr = new Cesium.HeadingPitchRoll();
/** @type {Cesium.Cartographic} */
const scratchModelCarto = new Cesium.Cartographic();
/** @type {Cesium.Cartesian3} */
const scratchModelPos = new Cesium.Cartesian3();
/** @type {Cesium.Matrix4} */
const scratchJointMatrix = new Cesium.Matrix4();
/** @type {Cesium.Matrix3} */
const scratchJointRotation = new Cesium.Matrix3();

/**
 * Where a robot's depth-tested model may stand, or null when there is nowhere
 * safe. Unlike the billboard — which hides behind `disableDepthTestDistance`
 * and rides a fixed lift — a model needs real ground evidence, so it waits for
 * groundSnap's one-shot terrain sample rather than guessing from the frame's own
 * altitude (which for `agl`/`slam-local` is not even an ellipsoid height).
 * @param {object} record
 * @param {{lat: number, lon: number}} pose
 * @returns {Cesium.Cartesian3|null}
 */
function modelDisplayPosition(record, pose) {
  if (!Number.isFinite(record.groundHeightM)) return null;
  const datum = record.latestFrame?.datum;
  const groundRelativeH = (datum === 'agl' || datum === 'slam-local') ? pose.elevM : 0;
  scratchModelCarto.longitude = Cesium.Math.toRadians(pose.lon);
  scratchModelCarto.latitude = Cesium.Math.toRadians(pose.lat);
  scratchModelCarto.height = record.groundHeightM + groundRelativeH + ROBOT_MODEL_BELLY_OFFSET_M;
  return Cesium.Cartesian3.fromRadians(
    scratchModelCarto.longitude, scratchModelCarto.latitude, scratchModelCarto.height,
    Cesium.Ellipsoid.WGS84, scratchModelPos,
  );
}

/**
 * Rotate the G1's posed joints for the current gait state. Each named link node
 * turns about its own local +Y (see robotGaitPose.js) applied on top of the
 * node's rest matrix, so a joint never accumulates rotation across ticks.
 * @param {object} record
 * @param {number} nowMs
 */
function poseRobotJoints(record, nowMs) {
  const model = record.model;
  if (!model?.ready) return;
  if (!record.modelNodes) {
    record.modelNodes = new Map();
    for (const name of GAIT_POSED_NODES) {
      const node = model.getNode(name);
      if (node) record.modelNodes.set(name, node);
    }
  }
  if (record.modelNodes.size === 0) return; // a GLB without the link hierarchy
  const gait = record.latestFrame?.gait;
  const fsm = gait?.fsm || 'stand';
  const dtMs = record.gaitPhaseMs == null ? 0 : nowMs - record.gaitPhaseMs;
  record.gaitPhaseMs = nowMs;
  // The exporter forwards the policy's own stride clock when it has one;
  // otherwise cadence is integrated locally so the walk still animates.
  record.gaitPhase = Number.isFinite(gait?.phase)
    ? gait.phase
    : advanceGaitPhase(record.gaitPhase, gait?.cadenceHz, dtMs, fsm);
  const angles = gaitJointAngles(fsm, record.gaitPhase);
  for (const [name, node] of record.modelNodes) {
    const angle = angles[name];
    if (!Number.isFinite(angle)) continue;
    Cesium.Matrix3.fromRotationY(angle, scratchJointRotation);
    Cesium.Matrix4.fromRotationTranslation(
      scratchJointRotation, Cesium.Cartesian3.ZERO, scratchJointMatrix,
    );
    node.matrix = Cesium.Matrix4.multiply(
      node.originalMatrix, scratchJointMatrix, scratchJointMatrix,
    );
  }
}

/**
 * Hand one robot from its billboard to a placed, ready model — or leave the
 * billboard owning the visual. Same ordering discipline as
 * flights.js::_driveFleetModelHandoff: the matrix is committed BEFORE the
 * readiness test (a model can flip `ready` during the following scene update,
 * and a first rendered frame on a stale matrix is the one-frame jump this
 * prevents), and the billboard is only hidden once the model actually draws.
 * @returns {boolean} Whether the model owns the visual.
 */
function driveRobotModelHandoff(record, pose, nowMs) {
  const bb = record.billboard;
  const model = record.model;
  if (!model) {
    if (bb && !bb.show) bb.show = true;
    return false;
  }
  const displayPos = modelDisplayPosition(record, pose);
  if (!displayPos) {
    model.show = false; // no ground evidence → nothing safe to depth-test against
    if (bb && !bb.show) bb.show = true;
    return false;
  }
  scratchHpr.heading = Cesium.Math.toRadians((pose.headingDeg || 0) + ROBOT_MODEL_HEADING_OFFSET_DEG);
  scratchHpr.pitch = Cesium.Math.toRadians(record.latestFrame?.pose?.pitchDeg || 0);
  scratchHpr.roll = Cesium.Math.toRadians(record.latestFrame?.pose?.rollDeg || 0);
  Cesium.Transforms.headingPitchRollToFixedFrame(
    displayPos, scratchHpr, Cesium.Ellipsoid.WGS84, undefined, model.modelMatrix,
  );
  if (!model.ready) {
    model.show = false; // not loaded yet → keep the glyph, no half-model flash
    if (bb && !bb.show) bb.show = true;
    return false;
  }
  poseRobotJoints(record, nowMs);
  if (!model.show) model.show = true;
  if (bb && bb.show) bb.show = false; // hand off ONLY once the model renders
  return true;
}

/** Per-frame position pass: interpolate every robot, refresh its billboard. */
function renderTick() {
  const viewer = state.viewer;
  if (!viewer || !state.enabled || !state.billboardCollection) return;
  const renderMs = Date.now() - ROBOT_RENDER_DELAY_MS;
  const expiredBefore = Date.now() - ROBOT_EXPIRE_MS;
  for (const record of state.robots.values()) {
    if (record.latestFrame && (record.latestFrame.rx ?? record.latestFrame.t) < expiredBefore) {
      removeRecord(record);
      continue;
    }
    const pose = robotPoseAt(record.fixes, renderMs);
    if (!pose) continue;
    record.lastPose = pose;
    const fallbackH = ellipsoidHeightM(record, pose);
    // Terrain snap (cached, never per-frame sampling inside groundSnap):
    // prefer the rendered mesh height when a validated sample exists.
    const surface = Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, 0);
    const snapped = state.models3d
      ? state.groundSnap?.heightFor(viewer, record.id, surface, groundSampleExclusions)
      : state.groundSnap?.heightFor(viewer, record.id, surface);
    if (!Number.isFinite(snapped) && !Number.isFinite(fallbackH)) continue;
    // AGL and slam-local altitudes are ground-relative offsets, so they ride
    // on top of the snapped terrain height instead of being replaced by it.
    const datum = record.latestFrame?.datum;
    const groundRelativeH = (datum === 'agl' || datum === 'slam-local') ? pose.elevM : 0;
    const finalH = (Number.isFinite(snapped) ? snapped + groundRelativeH : fallbackH) + ROBOT_LIFT_M;
    record.groundHeightM = Number.isFinite(snapped) ? snapped : null;
    record.position = Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, finalH);
    if (!record.billboard) {
      record.billboard = state.billboardCollection.add({
        id: record.id,
        position: record.position,
        image: robotIconUrl(ACCENT),
        width: 30,
        height: 30,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    } else {
      record.billboard.position = record.position;
    }
    const rotation = screenProjectedRotation(
      viewer.scene, record.position, pose.headingDeg, record.rotationPrev,
    );
    if (Number.isFinite(rotation)) {
      record.billboard.rotation = rotation;
      record.rotationPrev = rotation;
    }
    if (state.models3d) {
      void ensureRobotModel(record);
      driveRobotModelHandoff(record, pose, renderMs);
    }
    if (record.id === state.selectedId && state.trail) {
      const points = state.trailPoints;
      const last = points[points.length - 1];
      if (!last || Cesium.Cartesian3.distanceSquared(last, record.position) > TRAIL_MIN_MOVE_M * TRAIL_MIN_MOVE_M) {
        points.push(record.position);
        while (points.length > TRAIL_MAX_POINTS) points.shift();
        state.trail.setPositions(points);
      }
    }
  }
  refreshOverlay();
}

function removeRecord(record) {
  releaseRobotModel(record);
  if (record.billboard && state.billboardCollection) {
    state.billboardCollection.remove(record.billboard);
  }
  if (state.selectedId === record.id) clearSelection();
  if (state.chaseTargetId === record.id) {
    state.chaseTargetId = null;
    state.chaseCamera?.stop();
  }
  state.robots.delete(record.id);
  state.groundSnap?.forget(record.id);
}

function overlayEntryFor(record) {
  const frame = record.latestFrame;
  const pose = record.lastPose;
  if (!frame || !pose || !record.position) return null;
  const chip = provenanceChip(frame);
  const gait = frame.gait?.fsm || 'unknown';
  const soc = frame.power?.soc;
  const details = [
    chip,
    `gait ${gait}${frame.gait?.cadenceHz ? ` · ${frame.gait.cadenceHz.toFixed(1)} Hz` : ''}`,
    `${pose.lat.toFixed(5)}, ${pose.lon.toFixed(5)} · ${Math.round(pose.elevM)} m`,
  ];
  if (Number.isFinite(soc)) details.push(`battery ${soc}%${frame.power?.tempC ? ` · ${Math.round(frame.power.tempC)}°C` : ''}`);
  if (pose.stale) details.push('signal stale — holding last fix');
  return {
    id: record.id,
    position: record.position,
    variant: record.id === state.selectedId ? 'card' : 'label',
    title: record.id.toUpperCase(),
    details,
    accent: ACCENT,
    selected: record.id === state.selectedId,
    interactive: true,
    activate: () => {
      if (record.id === state.selectedId) {
        window.dispatchEvent(new CustomEvent(ROBOT_CHASE_REQUEST_EVENT, {
          detail: { robotId: record.id },
        }));
      } else {
        selectRobot(record);
      }
    },
  };
}

function refreshOverlay() {
  if (!state.enabled) return;
  const entries = [];
  for (const record of state.robots.values()) {
    const entry = overlayEntryFor(record);
    if (entry) entries.push(entry);
  }
  setOverlayEntries(OVERLAY_SOURCE_ID, entries);
}

function selectRobot(record) {
  if (!record) return;
  state.selectedId = record.id;
  destroyTrail();
  if (state.viewer) {
    state.trail = createTrail(state.viewer, { color: TRAIL_COLOR });
    state.trailPoints = [];
  }
  if (record.position) {
    requestWorldFocus({
      kind: 'robot',
      id: record.id,
      position: record.position,
    });
  }
}

function clearSelection() {
  state.selectedId = null;
  destroyTrail();
}

function destroyTrail() {
  if (state.trail) {
    state.trail.destroy();
    state.trail = null;
  }
  state.trailPoints = [];
}

function installInteraction(viewer) {
  if (state.clickHandler || !viewer) return;
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    if (!state.enabled) return;
    if (hitTestWorldOverlay(movement.position.x, movement.position.y)) return;
    const picked = viewer.scene.pick(movement.position);
    const pickedId = resolvePickId(picked);
    if (pickedId && isOwnedByOtherLayer('ground-robots', pickedId)) return;
    if (pickedId && state.robots.has(pickedId)) {
      selectRobot(state.robots.get(pickedId));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  state.clickHandler = handler;
}

function removeInteraction() {
  if (state.clickHandler) {
    state.clickHandler.destroy();
    state.clickHandler = null;
  }
}

function openStream() {
  if (state.eventSource || state.relayUnsupported || typeof EventSource !== 'function') return;
  try {
    const source = new EventSource(STREAM_URL);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        for (const frame of payload?.frames || []) acceptFrame(frame);
        state.streamStatus = 'open';
      } catch { /* malformed event — poll fallback still refreshes */ }
    };
    source.onerror = () => { state.streamStatus = 'error'; };
    source.onopen = () => { state.streamStatus = 'open'; };
    state.eventSource = source;
  } catch {
    state.streamStatus = 'unsupported';
  }
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.streamStatus = 'idle';
}

async function loadSnapshot() {
  if (!state.enabled) return;
  if (state.abort) state.abort.abort();
  const abort = new AbortController();
  state.abort = abort;
  state.loading = true;
  try {
    const res = await fetch(TELEMETRY_URL, { signal: abort.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.status === 'unsupported') {
        // No relay on this host (e.g. serverless): local demo frames still
        // work, so this is a degraded source, not a layer failure.
        state.relayUnsupported = true;
        state.error = null;
        closeStream();
        state.streamStatus = 'unsupported';
      } else {
        state.error = body?.reason || `telemetry ${res.status}`;
      }
      return;
    }
    state.relayUnsupported = false;
    const payload = await res.json();
    for (const frame of payload?.robots || []) {
      const record = state.robots.get(frame.id);
      if (!record || !record.latestFrame || frame.t > record.latestFrame.t) {
        acceptFrame(frame);
      }
    }
    state.error = null;
  } catch (err) {
    if (err?.name !== 'AbortError') state.error = 'relay unreachable';
  } finally {
    state.loading = false;
    if (state.abort === abort) state.abort = null;
  }
}

const groundRobotsLayer = {
  id: 'ground-robots',
  name: 'Ground Robots',
  icon: '🤖',
  source: 'Robot telemetry bridge',
  updateInterval: REFRESH_MS,

  init(viewer) {
    state.viewer = viewer;
    state.groundSnap = createGroundSnap();
    state.chaseCamera = createRobotChaseCamera(viewer);
    ensureCollections(viewer);
    setOverlaySourceVisible(OVERLAY_SOURCE_ID, false);
    restoreSpriteOrder(viewer);
  },

  enable(viewer) {
    state.enabled = true;
    const activeViewer = viewer || state.viewer;
    ensureCollections(activeViewer);
    installInteraction(activeViewer);
    holdContinuousRender('ground-robots'); // per-frame interpolation animator
    if (!state.preRenderRemover) {
      state.preRenderRemover = activeViewer.scene.preRender.addEventListener(renderTick);
    }
    if (!state.geoidReady) {
      ensureGeoidReady()
        .then(() => { state.geoidReady = true; })
        .catch(() => { /* anchors fall back to orthometric height */ });
    }
    registerPickOwner('ground-robots', (pickedId) => state.robots.has(pickedId));
    restoreSpriteOrderOnEnable('ground-robots', activeViewer);
    if (state.billboardCollection) state.billboardCollection.show = true;
    setOverlaySourceVisible(OVERLAY_SOURCE_ID, true);
    openStream();
    return loadSnapshot();
  },

  disable() {
    state.enabled = false;
    this.releaseCameraOwnership();
    releaseContinuousRender('ground-robots');
    closeStream();
    unregisterPickOwner('ground-robots');
    removeInteraction();
    clearSelection();
    if (state.preRenderRemover) {
      state.preRenderRemover();
      state.preRenderRemover = null;
    }
    if (state.billboardCollection) state.billboardCollection.show = false;
    releaseRobotModels();
    clearOverlaySource(OVERLAY_SOURCE_ID);
    setOverlaySourceVisible(OVERLAY_SOURCE_ID, false);
    if (state.abort) {
      state.abort.abort();
      state.abort = null;
    }
    state.loading = false;
  },

  update(viewer) {
    if (!state.enabled || state.relayUnsupported) return Promise.resolve();
    void viewer;
    return loadSnapshot();
  },

  destroy(viewer) {
    this.disable();
    // Bump the lifecycle token first: a glTF load resolving after this point
    // must drop its model instead of adding it to a torn-down collection.
    state.modelEpoch += 1;
    state.modelPending.clear();
    state.modelGen.clear();
    if (state.billboardCollection && viewer) {
      viewer.scene.primitives.remove(state.billboardCollection);
    }
    if (state.modelCollection && viewer) {
      viewer.scene.primitives.remove(state.modelCollection);
    }
    state.modelCollection = null;
    state.billboardCollection = null;
    state.robots.clear();
    state.groundSnap?.clear();
    state.viewer = null;
  },

  /**
   * Inject locally generated frames (in-browser demo mode). Frames follow the
   * same path as relayed telemetry — acceptFrame history + provenance chips —
   * so the demo renders exactly like bridge-fed SIMULATED data.
   * @param {object[]} frames - Canonical RobotFrames.
   * @returns {boolean} Whether the layer was enabled to accept them.
   */
  ingestLocalFrames(frames) {
    if (!state.enabled) return false;
    const rx = Date.now();
    for (const frame of frames || []) {
      if (frame && frame.id && frame.pose) acceptFrame({ ...frame, rx });
    }
    return true;
  },

  /**
   * Engage the chase camera on a robot. Camera motion itself is
   * owned by robotChaseCamera; ui.js tears it down via releaseCameraOwnership.
   * @param {string} [robotId] - Defaults to the selected robot.
   * @param {{firstPerson?: boolean}} [options] - Camera mode, passed through.
   * @returns {boolean} Whether the chase engaged.
   */
  engageChaseCamera(robotId = null, options = {}) {
    const id = robotId || state.selectedId;
    const record = id ? state.robots.get(id) : null;
    if (!record || !state.chaseCamera) return false;
    state.chaseTargetId = record.id;
    state.chaseCamera.start(() => {
      const target = state.robots.get(state.chaseTargetId);
      if (!target || !target.position) return null;
      return {
        position: target.position,
        headingDeg: target.lastPose?.headingDeg,
        groundHeightM: target.groundHeightM,
        // slam-local elevations ARE the recorded camera height, so a
        // first-person camera must undo the glyph lift instead of adding
        // an eye height on top.
        liftM: ROBOT_LIFT_M,
        poseIsCameraHeight: target.latestFrame?.datum === 'slam-local',
      };
    }, options);
    return true;
  },

  /** Release the chase camera (called from ui.js::_releaseFollowCamera). */
  releaseCameraOwnership() {
    state.chaseTargetId = null;
    state.chaseCamera?.stop();
  },

  isChaseCameraActive() {
    return state.chaseCamera?.isActive() === true;
  },

  selectById(robotId) {
    const record = state.robots.get(String(robotId || '').trim());
    if (!record) return false;
    selectRobot(record);
    return true;
  },

  clearSelection() {
    clearSelection();
    return true;
  },

  getSelectedInfo() {
    const record = state.selectedId ? state.robots.get(state.selectedId) : null;
    if (!record || !record.latestFrame) return null;
    const frame = record.latestFrame;
    return {
      id: record.id,
      latitude: record.lastPose?.lat ?? frame.pose.lat,
      longitude: record.lastPose?.lon ?? frame.pose.lon,
      gait: frame.gait?.fsm || 'unknown',
      soc: frame.power?.soc ?? null,
      provenance: provenanceChip(frame),
    };
  },

  getNearby(centerCartesian, rangeM, maxCount = 25) {
    if (!centerCartesian) return [];
    const range = Number.isFinite(rangeM) && rangeM > 0 ? rangeM : Infinity;
    const entries = [];
    for (const record of state.robots.values()) {
      if (!record.position) continue;
      const distanceM = Cesium.Cartesian3.distance(centerCartesian, record.position);
      if (!Number.isFinite(distanceM) || distanceM > range) continue;
      entries.push({ id: record.id, name: record.id, position: record.position, distanceM });
    }
    entries.sort((a, b) => a.distanceM - b.distanceM);
    return entries.slice(0, Math.max(1, Math.floor(maxCount)));
  },

  getDetectableObjects(options = {}) {
    if (!state.enabled || !state.billboardCollection || !state.billboardCollection.show) return [];
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : Infinity;
    const result = [];
    for (const record of state.robots.values()) {
      if (!record.position || !record.latestFrame) continue;
      result.push({
        position: record.position,
        sourceId: record.id,
        id: record.id.toUpperCase(),
        type: 'GROUND',
        skipLabel: record.id === state.selectedId,
        klass: provenanceChip(record.latestFrame).slice(0, 14),
        metric: record.latestFrame.gait?.fsm || undefined,
      });
      if (result.length >= maxCount) break;
    }
    return result;
  },

  setParams(params = {}) {
    if (params.selectedRobotId !== undefined) {
      if (params.selectedRobotId === null) clearSelection();
      else this.selectById(params.selectedRobotId);
    }
    if (Number.isFinite(params.chaseRangeM)) {
      state.chaseCamera?.setRange(params.chaseRangeM);
    }
    if (params.models3d !== undefined) {
      const next = params.models3d === true;
      if (next !== state.models3d) {
        state.models3d = next;
        // Turning the flag off restores the billboard-only path immediately
        // rather than waiting for the next tick to notice.
        if (!next) releaseRobotModels();
      }
    }
  },

  getParams() {
    return {
      selectedRobotId: state.selectedId,
      chaseActive: this.isChaseCameraActive(),
      models3d: state.models3d,
    };
  },

  getStats() {
    return {
      count: state.robots.size,
      lastUpdate: state.lastUpdate,
      loading: state.loading,
      error: state.error,
      relayUnsupported: state.relayUnsupported,
      streamStatus: state.streamStatus,
    };
  },
};

export default groundRobotsLayer;
export { groundRobotsLayer };

// --- Test hooks ----------------------------------------------------------------------
// The billboard→model handoff is the one piece of this layer whose ORDERING is
// load-bearing (see groundRobotModels.test.mjs), and it is unreachable from a
// Node test through the render tick, which needs a live Cesium scene.

/**
 * Run one handoff against caller-supplied billboard/model stand-ins.
 * @param {object} options
 * @returns {{owns: boolean, record: object}}
 */
export function _driveRobotModelHandoffForTest({
  id = 'g1-01',
  model = null,
  billboard = { show: true },
  pose = { lat: 37.77, lon: -122.42, elevM: 12, headingDeg: 90 },
  groundHeightM = 12,
  frame = null,
  nowMs = Date.now(),
} = {}) {
  const record = {
    id,
    model,
    modelNodes: null,
    billboard,
    groundHeightM,
    latestFrame: frame,
    gaitPhase: 0,
    gaitPhaseMs: null,
  };
  const owns = driveRobotModelHandoff(record, pose, nowMs);
  return { owns, record };
}

/** Release-all path (flag off / layer disable), on caller-supplied records. */
export function _releaseRobotModelsForTest(records = []) {
  const previous = state.robots;
  state.robots = new Map(records.map((record) => [record.id, record]));
  try {
    releaseRobotModels();
  } finally {
    state.robots = previous;
  }
}
