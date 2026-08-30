/**
 * RobotFrame wire format — the single telemetry shape shared by the bridge
 * (tools/robot-bridge), the server relay (server/robotProxies.js), and the
 * ground-robots layer. Pure and Cesium-free so it runs identically in the
 * browser, the Vite dev server, and Node test runners.
 *
 * Every frame carries explicit provenance (`live-g1`/`phone`/`replay`/
 * `synthetic`) so the UI can always answer "is this real?" per field.
 *
 * @module data/robotFrame
 */

export const ROBOT_FRAME_VERSION = 1;

/** Same grammar as layerState's tracking ids: short, lowercase, URL-safe. */
export const ROBOT_ID_GRAMMAR = /^[0-9a-z~_-]{1,16}$/;

/** Hard batch cap per ingest POST; an over-limit batch is rejected whole. */
export const MAX_FRAMES_PER_BATCH = 200;

/** Ring-buffer depth per robot on the server (~60 s at 10 Hz). */
export const MAX_FRAMES_PER_ROBOT = 600;

/** Maximum distinct robot ids the relay will track. */
export const MAX_ROBOTS = 16;

/** Frames stamped outside this window of server time are malformed. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export const ROBOT_DATUMS = Object.freeze([
  'wgs84-ellipsoid',
  'egm96-orthometric',
  'agl',
  'slam-local',
]);

export const FIX_SOURCES = Object.freeze([
  'gnss', 'rtk', 'slam', 'fused', 'dead-reckoned',
]);

export const GAIT_FSM_STATES = Object.freeze([
  'damp', 'stand', 'walk', 'run', 'squat', 'sit', 'unknown',
]);

export const PROVENANCE_SOURCES = Object.freeze([
  'live-g1', 'phone', 'replay', 'synthetic',
]);

export const PROVENANCE_LABELS = Object.freeze({
  'live-g1': 'LIVE',
  phone: 'PHONE PROXY',
  replay: 'REPLAY',
  synthetic: 'SIMULATED',
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteOrNull(value) {
  return value === null || value === undefined || finite(value);
}

/**
 * Validate one wire frame against the v1 schema.
 * @param {unknown} frame - Candidate frame.
 * @param {{nowMs?: number}} [options] - `nowMs` anchors the clock-skew check.
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function validateRobotFrame(frame, { nowMs = Date.now() } = {}) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    return { ok: false, error: 'frame must be an object' };
  }
  if (frame.v !== ROBOT_FRAME_VERSION) {
    return { ok: false, error: `unsupported frame version: ${frame.v}` };
  }
  if (typeof frame.id !== 'string' || !ROBOT_ID_GRAMMAR.test(frame.id)) {
    return { ok: false, error: 'invalid robot id' };
  }
  if (!finite(frame.t)) return { ok: false, error: 'missing timestamp t' };
  if (Math.abs(frame.t - nowMs) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, error: 'timestamp outside ±24h window' };
  }

  const pose = frame.pose;
  if (!pose || typeof pose !== 'object') return { ok: false, error: 'missing pose' };
  if (!finite(pose.lat) || pose.lat < -90 || pose.lat > 90) {
    return { ok: false, error: 'pose.lat out of range' };
  }
  if (!finite(pose.lon) || pose.lon < -180 || pose.lon > 180) {
    return { ok: false, error: 'pose.lon out of range' };
  }
  if (!finite(pose.altM)) return { ok: false, error: 'pose.altM must be finite' };
  if (!finiteOrNull(pose.headingDeg) || !finiteOrNull(pose.pitchDeg) || !finiteOrNull(pose.rollDeg)) {
    return { ok: false, error: 'pose orientation must be finite or null' };
  }
  if (!ROBOT_DATUMS.includes(frame.datum)) {
    return { ok: false, error: `unknown datum: ${frame.datum}` };
  }

  const fix = frame.fix;
  if (!fix || typeof fix !== 'object' || !FIX_SOURCES.includes(fix.source)) {
    return { ok: false, error: 'invalid fix.source' };
  }
  if (!finiteOrNull(fix.hAccM) || !finiteOrNull(fix.vAccM)) {
    return { ok: false, error: 'fix accuracy must be finite or null' };
  }

  const gait = frame.gait;
  if (gait !== undefined && gait !== null) {
    if (typeof gait !== 'object') return { ok: false, error: 'gait must be an object' };
    if (!GAIT_FSM_STATES.includes(gait.fsm)) {
      return { ok: false, error: `unknown gait.fsm: ${gait.fsm}` };
    }
    if (!finiteOrNull(gait.cadenceHz) || !finiteOrNull(gait.strideM)) {
      return { ok: false, error: 'gait cadence/stride must be finite or null' };
    }
  }

  const vel = frame.vel;
  if (vel !== undefined && vel !== null) {
    if (typeof vel !== 'object' || !finiteOrNull(vel.speedMps) || !finiteOrNull(vel.courseDeg)) {
      return { ok: false, error: 'vel must carry finite speed/course or null' };
    }
  }

  const power = frame.power;
  if (power !== undefined && power !== null) {
    if (typeof power !== 'object') return { ok: false, error: 'power must be an object' };
    if (power.soc !== undefined && power.soc !== null
      && (!finite(power.soc) || power.soc < 0 || power.soc > 100)) {
      return { ok: false, error: 'power.soc out of range' };
    }
  }

  const provenance = frame.provenance;
  if (!provenance || typeof provenance !== 'object'
    || !PROVENANCE_SOURCES.includes(provenance.source)) {
    return { ok: false, error: 'invalid provenance.source' };
  }
  if (provenance.label !== PROVENANCE_LABELS[provenance.source]) {
    return { ok: false, error: 'provenance.label does not match source' };
  }
  if (!finite(provenance.confidence)
    || provenance.confidence < 0 || provenance.confidence > 1) {
    return { ok: false, error: 'provenance.confidence out of range' };
  }

  return { ok: true };
}

/**
 * Validate an ingest batch. Rejects the whole batch on any malformed frame —
 * no prefix salvage, so a partially-corrupt sender cannot poison the relay.
 * @param {unknown} batch - Candidate frame array.
 * @param {{nowMs?: number}} [options]
 * @returns {{ok: true, frames: object[]}|{ok: false, error: string}}
 */
export function validateRobotFrameBatch(batch, options = {}) {
  if (!Array.isArray(batch) || batch.length === 0) {
    return { ok: false, error: 'batch must be a non-empty array' };
  }
  if (batch.length > MAX_FRAMES_PER_BATCH) {
    return { ok: false, error: `batch exceeds ${MAX_FRAMES_PER_BATCH} frames` };
  }
  for (let i = 0; i < batch.length; i += 1) {
    const result = validateRobotFrame(batch[i], options);
    if (!result.ok) return { ok: false, error: `frame[${i}]: ${result.error}` };
  }
  return { ok: true, frames: batch };
}

/**
 * Convert a frame altitude to a WGS84-ellipsoid height for Cesium anchoring.
 * @param {number} altM - Frame altitude in its own datum.
 * @param {string} datum - One of ROBOT_DATUMS.
 * @param {{geoidN?: number|null, groundEllipsoidM?: number|null}} [context]
 *   `geoidN` is the EGM96 undulation at the fix; `groundEllipsoidM` the local
 *   terrain height for `agl`/`slam-local` frames.
 * @returns {number|null} Ellipsoid height, or null when context is missing.
 */
export function toEllipsoidHeightM(altM, datum, { geoidN = null, groundEllipsoidM = null } = {}) {
  if (!finite(altM)) return null;
  switch (datum) {
    case 'wgs84-ellipsoid':
      return altM;
    case 'egm96-orthometric':
      return finite(geoidN) ? altM + geoidN : null;
    case 'agl':
    case 'slam-local':
      return finite(groundEllipsoidM) ? altM + groundEllipsoidM : null;
    default:
      return null;
  }
}

/**
 * The provenance chip text for a frame, including virtual transposition.
 * @param {object} frame - A validated RobotFrame.
 * @returns {string} e.g. "SIMULATED · VIRTUAL TRANSPOSITION".
 */
export function provenanceChip(frame) {
  const base = PROVENANCE_LABELS[frame?.provenance?.source] || 'UNKNOWN';
  return frame?.transposed ? `${base} · VIRTUAL TRANSPOSITION` : base;
}
