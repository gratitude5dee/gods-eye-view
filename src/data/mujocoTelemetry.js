/**
 * MuJoCo sim2sim → RobotFrame normalization. Pure and Cesium-free so the
 * bridge provider (tools/robot-bridge/providers/mujoco-g1.mjs) and the unit
 * tests share one implementation.
 *
 * The rollout exporter in mujoco_playground
 * (`experimental/sim2sim/robotframe_exporter.py`) writes JSON Lines. Two shapes
 * are accepted, because a sim harness is exactly the place where someone will
 * wire up a leaner record than the wire format:
 *
 *  - a canonical RobotFrame (`v: 1`), which is re-stamped with the bridge's
 *    robot id and provenance and otherwise passed through; or
 *  - a flat sim record (`lat`/`lon`/`altM`/`fsm`/`phase`/…), which is folded
 *    into a canonical frame here.
 *
 * Either way the caller validates the result with
 * `robotFrame.js::validateRobotFrame` before it reaches the relay — this module
 * builds frames, it does not decide whether they are acceptable.
 *
 * @module data/mujocoTelemetry
 */

import {
  GAIT_FSM_STATES,
  PROVENANCE_LABELS,
  ROBOT_DATUMS,
  ROBOT_FRAME_VERSION,
} from './robotFrame.js';

/** Newline-delimited JSON reader with a bounded tail buffer. */
export function createLineReader({ maxLineBytes = 64 * 1024 } = {}) {
  let tail = '';
  return {
    /**
     * @param {string} chunk - Decoded stream chunk.
     * @returns {{lines: string[], overflow: number}} Complete lines only.
     */
    push(chunk) {
      let overflow = 0;
      tail += chunk;
      const parts = tail.split('\n');
      tail = parts.pop() ?? '';
      // A sender that never emits a newline must not grow the buffer without
      // bound; drop the partial line and resynchronize on the next newline.
      if (tail.length > maxLineBytes) {
        overflow = tail.length;
        tail = '';
      }
      return { lines: parts.map((line) => line.trim()).filter(Boolean), overflow };
    },
  };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteOr(value, fallback) {
  return finite(value) ? value : fallback;
}

function wrapLon(lon) {
  if (!finite(lon)) return lon;
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/**
 * Speed and course from a MuJoCo pelvis-frame linear velocity.
 *
 * `local_linvel_pelvis` is the observation the G1 joystick policy itself sees,
 * so it is the honest source for the wire `vel` block: forward is +x, left is
 * +y, and the course is that vector rotated into the robot's own heading.
 * @param {number[]|null|undefined} linvel - [vx, vy, vz] in m/s, pelvis frame.
 * @param {number} headingDeg - Robot heading, degrees clockwise from north.
 * @returns {{speedMps: number, courseDeg: number}|null}
 */
export function velFromPelvisLinvel(linvel, headingDeg) {
  if (!Array.isArray(linvel) || !finite(linvel[0]) || !finite(linvel[1])) return null;
  const [vx, vy] = linvel;
  const speedMps = Math.hypot(vx, vy);
  // atan2(left, forward) is the drift angle to the LEFT of the heading, and
  // heading grows clockwise, so the drift is subtracted.
  const driftDeg = (Math.atan2(vy, vx) * 180) / Math.PI;
  const courseDeg = ((headingDeg - driftDeg) % 360 + 360) % 360;
  return { speedMps, courseDeg };
}

/**
 * Build a canonical RobotFrame from one exporter record.
 * @param {unknown} record - Parsed JSON Line.
 * @param {{id: string, provenance?: string, confidence?: number, nowMs?: number,
 *   datum?: string, fixSource?: string}} options
 * @returns {{ok: true, frame: object}|{ok: false, error: string}}
 */
export function mujocoFrameFromRecord(record, {
  id,
  provenance = 'live-g1',
  confidence = 0.9,
  nowMs = Date.now(),
  datum = 'wgs84-ellipsoid',
  fixSource = 'fused',
} = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, error: 'record must be an object' };
  }
  if (!PROVENANCE_LABELS[provenance]) {
    return { ok: false, error: `unknown provenance: ${provenance}` };
  }
  if (!ROBOT_DATUMS.includes(datum)) {
    return { ok: false, error: `unknown datum: ${datum}` };
  }
  const stamp = { source: provenance, label: PROVENANCE_LABELS[provenance], confidence };

  // Canonical frame: the exporter already speaks the wire format. Only the
  // identity and provenance are overridden — the bridge, not the sim, decides
  // which robot id it is feeding and how the UI must label it.
  if (record.v === ROBOT_FRAME_VERSION && record.pose && typeof record.pose === 'object') {
    const { sim: _sim, ...rest } = record;
    return {
      ok: true,
      frame: { ...rest, id, provenance: stamp, t: finiteOr(record.t, nowMs) },
    };
  }

  const lat = record.lat ?? record.pose?.lat;
  const lon = record.lon ?? record.pose?.lon;
  if (!finite(lat) || !finite(lon)) return { ok: false, error: 'record needs finite lat/lon' };
  const headingDeg = ((finiteOr(record.headingDeg, 0) % 360) + 360) % 360;
  const fsm = GAIT_FSM_STATES.includes(record.fsm) ? record.fsm : 'unknown';
  const vel = velFromPelvisLinvel(record.linvel, headingDeg)
    ?? (finite(record.speedMps)
      ? { speedMps: record.speedMps, courseDeg: finiteOr(record.courseDeg, headingDeg) }
      : null);
  const frame = {
    v: ROBOT_FRAME_VERSION,
    id,
    t: finiteOr(record.t, nowMs),
    pose: {
      lat,
      lon: wrapLon(lon),
      altM: finiteOr(record.altM, 0),
      headingDeg,
      pitchDeg: finite(record.pitchDeg) ? record.pitchDeg : null,
      rollDeg: finite(record.rollDeg) ? record.rollDeg : null,
    },
    datum,
    fix: {
      source: fixSource,
      hAccM: finite(record.hAccM) ? record.hAccM : null,
      vAccM: finite(record.vAccM) ? record.vAccM : null,
    },
    gait: {
      fsm,
      cadenceHz: finite(record.cadenceHz) ? record.cadenceHz : null,
      strideM: finite(record.strideM) ? record.strideM : null,
      phase: finite(record.phase) ? record.phase : null,
    },
    provenance: stamp,
  };
  if (vel) frame.vel = vel;
  if (finite(record.soc) || finite(record.tempC)) {
    frame.power = {
      soc: finite(record.soc) ? record.soc : null,
      tempC: finite(record.tempC) ? record.tempC : null,
    };
  }
  // Deliberately NOT forwarded: the raw policy observation (joint angles,
  // velocities, gravity). `/api/robot/ingest` caps a body at 256 KB for up to
  // 200 frames, so ~23 joints × 2 arrays per frame would push whole batches
  // over the cap and get them rejected outright. The observation is summarized
  // into `vel`/`gait` above; anything richer belongs in a separate channel.
  return { ok: true, frame };
}
