/**
 * ABot-Recon live pose → RobotFrame normalization. Pure and Cesium-free so the
 * bridge provider (tools/robot-bridge/providers/unitree.mjs) and the unit
 * tests share one implementation.
 *
 * The off-board streamer (ABot-Recon `scripts/stream_reconstruction.py`) runs
 * inference on rolling clip windows and, after each window, atomically rewrites
 * one small JSON file with the latest camera pose in the reconstruction's own
 * SLAM frame:
 *
 *   {
 *     "seq": 12,                     // monotonically increasing window counter
 *     "t": 1788085000000,            // wall-clock ms when the window finished
 *     "pose": {"x": …, "y": …, "z": …, "forward": [fx, fy, fz]},
 *     "batch": "points/batch_000012.ply"   // optional sibling chunk
 *   }
 *
 * A reconstruction has no georeference, so the operator supplies the same
 * editorial anchor the DISASTER RECON replay uses and the pose is rotated into
 * the `slam-local` datum (ground-relative offset on top of a terrain snap).
 * The result is honest LIVE provenance with `transposed: true` — the motion is
 * real, the geolocation is an editorial choice.
 *
 * @module data/unitreeTelemetry
 */

import { ROBOT_FRAME_VERSION, PROVENANCE_LABELS } from './robotFrame.js';
import {
  normalizeAnchor,
  slamToEnu,
  offsetLatLon,
  forwardHeadingDeg,
} from './reconstructionAnchor.js';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Build a canonical RobotFrame from one streamer pose record.
 *
 * @param {unknown} record - Parsed `pose_latest.json` contents.
 * @param {{id: string, anchor: {lat: number, lon: number, headingDeg?: number,
 *   elevM?: number}, confidence?: number, nowMs?: number,
 *   previous?: {enu: {eastM: number, northM: number}, t: number}|null}} options
 *   `previous` is the last delivered pose (provider-held), used to derive the
 *   `vel` block; omit it and the frame carries no velocity.
 * @returns {{ok: true, frame: object, enu: {eastM: number, northM: number,
 *   upM: number}}|{ok: false, error: string}}
 */
export function unitreeFrameFromRecord(record, {
  id,
  anchor,
  confidence = 0.9,
  nowMs = Date.now(),
  previous = null,
} = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, error: 'record must be an object' };
  }
  const pose = record.pose;
  if (!pose || typeof pose !== 'object'
    || !finite(pose.x) || !finite(pose.y) || !finite(pose.z)) {
    return { ok: false, error: 'record.pose needs finite x/y/z' };
  }
  let origin;
  try {
    origin = normalizeAnchor(anchor);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  const enu = slamToEnu(pose, origin.headingDeg);
  const { lat, lon } = offsetLatLon(origin, enu.eastM, enu.northM);
  const forward = Array.isArray(pose.forward)
    && pose.forward.length === 3 && pose.forward.every(finite)
    ? { x: pose.forward[0], y: pose.forward[1], z: pose.forward[2] }
    : { x: 0, y: 0, z: 1 };
  const headingDeg = forwardHeadingDeg(forward, origin.headingDeg);
  const t = finite(record.t) ? record.t : nowMs;

  const frame = {
    v: ROBOT_FRAME_VERSION,
    id,
    t,
    pose: {
      lat,
      lon,
      // Ground-relative, as the slam-local datum expects: the renderer snaps
      // the terrain and rides this offset on top of it.
      altM: origin.elevM + enu.upM,
      headingDeg,
      pitchDeg: null,
      rollDeg: null,
    },
    datum: 'slam-local',
    fix: { source: 'slam', hAccM: null, vAccM: null },
    gait: { fsm: 'unknown', cadenceHz: null, strideM: null },
    // The pose is live; the lat/lon is not a measurement. Anchoring is an
    // editorial act, and the UI must keep saying so.
    transposed: true,
    provenance: {
      source: 'live-g1',
      label: PROVENANCE_LABELS['live-g1'],
      confidence,
    },
  };

  if (previous && finite(previous.t) && previous.t < t && previous.enu) {
    const dtS = (t - previous.t) / 1000;
    const dE = enu.eastM - previous.enu.eastM;
    const dN = enu.northM - previous.enu.northM;
    const speedMps = Math.hypot(dE, dN) / dtS;
    const courseDeg = speedMps > 1e-6
      ? ((Math.atan2(dE, dN) * 180 / Math.PI) % 360 + 360) % 360
      : headingDeg;
    frame.vel = { speedMps, courseDeg };
    frame.gait.fsm = speedMps > 0.05 ? 'walk' : 'stand';
  }

  return { ok: true, frame, enu };
}
