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
  geoidReady: false,
  groundSnap: null,
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
    const snapped = state.groundSnap?.heightFor(viewer, record.id, surface);
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
  if (state.eventSource || typeof EventSource !== 'function') return;
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
      state.error = body?.reason || `telemetry ${res.status}`;
      return;
    }
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
    clearOverlaySource(OVERLAY_SOURCE_ID);
    setOverlaySourceVisible(OVERLAY_SOURCE_ID, false);
    if (state.abort) {
      state.abort.abort();
      state.abort = null;
    }
    state.loading = false;
  },

  update(viewer) {
    if (!state.enabled) return Promise.resolve();
    void viewer;
    return loadSnapshot();
  },

  destroy(viewer) {
    this.disable();
    if (state.billboardCollection && viewer) {
      viewer.scene.primitives.remove(state.billboardCollection);
    }
    state.billboardCollection = null;
    state.robots.clear();
    state.groundSnap?.clear();
    state.viewer = null;
  },

  /**
   * Engage the third-person chase camera on a robot. Camera motion itself is
   * owned by robotChaseCamera; ui.js tears it down via releaseCameraOwnership.
   * @param {string} [robotId] - Defaults to the selected robot.
   * @returns {boolean} Whether the chase engaged.
   */
  engageChaseCamera(robotId = null) {
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
      };
    });
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
  },

  getParams() {
    return {
      selectedRobotId: state.selectedId,
      chaseActive: this.isChaseCameraActive(),
    };
  },

  getStats() {
    return {
      count: state.robots.size,
      lastUpdate: state.lastUpdate,
      loading: state.loading,
      error: state.error,
      streamStatus: state.streamStatus,
    };
  },
};

export default groundRobotsLayer;
export { groundRobotsLayer };
