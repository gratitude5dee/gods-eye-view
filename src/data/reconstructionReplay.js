/**
 * Reconstruction replay — walks a robot marker along an anchored ABot-Recon
 * camera trajectory and reports how much of the cloud that walk has revealed.
 *
 * Honesty contract: these frames are a recording replayed onto chosen
 * geography, so they carry `SIMULATED · VIRTUAL TRANSPOSITION` — the recorded
 * pose is real, the place is not, and neither is live.
 *
 * Pure and Cesium-free so it runs identically in the browser and Node tests.
 *
 * @module data/reconstructionReplay
 */

/** Camera poses arrive at capture rate; replay at a walkable playback rate. */
const DEFAULT_POSE_HZ = 10;

function bearingDelta(fromDeg, toDeg) {
  return ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
}

/**
 * @param {object} options
 * @param {Array<{lat: number, lon: number, elevM: number, headingDeg: number}>} options.waypoints
 *   Anchored pose track (see `reconstructionAnchor.anchorPoseTrack`).
 * @param {string} [options.id] - Robot id for the emitted frames.
 * @param {number} [options.poseHz] - Poses consumed per second of replay.
 * @param {boolean} [options.loop] - Restart at the end instead of holding.
 * @returns {{nextFrame: (nowMs: number) => object|null,
 *   progress: () => {index: number, poseCount: number, fraction: number},
 *   isComplete: () => boolean}}
 */
export function createReconstructionReplay({
  waypoints,
  id = 'g1-01',
  poseHz = DEFAULT_POSE_HZ,
  loop = false,
} = {}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    throw new Error('reconstruction replay needs at least one waypoint');
  }
  const rate = poseHz > 0 ? poseHz : DEFAULT_POSE_HZ;
  let index = 0;
  let startedAtMs = null;
  let previous = null;
  let previousAtMs = null;

  function frameAt(step, nowMs) {
    const pose = waypoints[step];
    const previousPose = previous || pose;
    const dtS = previousAtMs === null ? 1 / rate : Math.max(1e-3, (nowMs - previousAtMs) / 1000);
    const eastM = (pose.lon - previousPose.lon) * 111_320 * Math.cos(pose.lat * (Math.PI / 180));
    const northM = (pose.lat - previousPose.lat) * 110_540;
    const speedMps = Math.hypot(eastM, northM) / dtS;
    const yawRateDps = bearingDelta(previousPose.headingDeg, pose.headingDeg) / dtS;
    previous = pose;
    previousAtMs = nowMs;
    return {
      v: 1,
      id,
      t: nowMs,
      pose: {
        lat: pose.lat,
        lon: pose.lon,
        altM: pose.elevM,
        headingDeg: pose.headingDeg,
        pitchDeg: 0,
        rollDeg: 0,
      },
      // The reconstruction's altitudes are offsets in its own SLAM frame, so
      // they ride on top of the terrain snap — exactly what this datum means.
      datum: 'slam-local',
      fix: { source: 'slam', hAccM: null, vAccM: null },
      vel: { speedMps, courseDeg: pose.headingDeg, vzMps: 0, yawRateDps },
      gait: { fsm: speedMps > 0.05 ? 'walk' : 'stand', cadenceHz: null, strideM: null },
      health: { estop: false, commsRttMs: 0, linkRssiDbm: null, motorErrors: [] },
      transposed: true,
      provenance: { source: 'synthetic', label: 'SIMULATED', confidence: 1.0 },
    };
  }

  return {
    nextFrame(nowMs) {
      if (startedAtMs === null) startedAtMs = nowMs;
      const elapsedPoses = Math.floor(((nowMs - startedAtMs) / 1000) * rate);
      const wanted = loop ? elapsedPoses % waypoints.length : elapsedPoses;
      if (!loop && wanted >= waypoints.length) {
        index = waypoints.length - 1;
        return null;
      }
      index = Math.max(0, Math.min(waypoints.length - 1, wanted));
      return frameAt(index, nowMs);
    },
    progress() {
      return {
        index,
        poseCount: waypoints.length,
        fraction: waypoints.length > 1 ? (index + 1) / waypoints.length : 1,
      };
    },
    isComplete() {
      return !loop && index >= waypoints.length - 1;
    },
  };
}
