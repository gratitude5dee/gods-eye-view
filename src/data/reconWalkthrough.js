/**
 * BASE CAMP walkthrough sequencing — pure timing/selection logic for the
 * cinematic replay that moves flight → third-person → first-person while a
 * CCTV-style panel shows the head-camera frames the reconstruction was built
 * from.
 *
 * Honesty contract: the footage is a recording synced to a replayed
 * trajectory. The panel "connects" as part of the show, but it must never be
 * labelled live — the recorded provenance stays visible throughout.
 *
 * Pure and Cesium-free so it runs identically in the browser and Node tests.
 *
 * @module data/reconWalkthrough
 */

/** Poses consumed per second — slow enough for three distinct camera acts. */
export const WALKTHROUGH_POSE_HZ = 2;

/** Replay-progress fractions where each camera act hands over to the next. */
export const WALKTHROUGH_PHASE_BOUNDS = Object.freeze({
  flightEnd: 0.25,
  thirdPersonEnd: 0.6,
});

/** How long past the flight the CCTV panel pretends to negotiate a link. */
const CCTV_CONNECT_SPAN = 0.05;

/**
 * Which camera act owns a given replay progress.
 * @param {number} fraction - Replay progress in [0, 1].
 * @returns {'flight'|'third-person'|'first-person'}
 */
export function walkthroughPhaseAt(fraction) {
  const f = Number.isFinite(fraction) ? fraction : 0;
  if (f < WALKTHROUGH_PHASE_BOUNDS.flightEnd) return 'flight';
  if (f < WALKTHROUGH_PHASE_BOUNDS.thirdPersonEnd) return 'third-person';
  return 'first-person';
}

/**
 * CCTV link state for a given replay progress: dark while the flight frames
 * the site, a brief connect once the camera drops to the robot, then footage.
 * @param {number} fraction - Replay progress in [0, 1].
 * @returns {'standby'|'connecting'|'connected'}
 */
export function cctvStateAt(fraction) {
  const f = Number.isFinite(fraction) ? fraction : 0;
  if (f < WALKTHROUGH_PHASE_BOUNDS.flightEnd) return 'standby';
  if (f < WALKTHROUGH_PHASE_BOUNDS.flightEnd + CCTV_CONNECT_SPAN) return 'connecting';
  return 'connected';
}

/**
 * URL of the recorded head-camera frame matching a pose index. The exporter
 * writes one frame per pose, so the pose index is the frame index.
 * @param {number} index - Replay pose index.
 * @param {{frameCount: number, baseUrl?: string}} options
 * @returns {string|null} Null when nothing is published.
 */
export function cctvFrameUrl(index, { frameCount, baseUrl = '/recon/frames' } = {}) {
  if (!Number.isFinite(frameCount) || frameCount <= 0) return null;
  const clamped = Math.max(0, Math.min(frameCount - 1, Math.floor(index) || 0));
  return `${baseUrl}/${String(clamped).padStart(6, '0')}.jpg`;
}

/**
 * Recording-clock label for a pose index.
 * @param {number} index - Replay pose index.
 * @param {number} frameIntervalS - Capture seconds between exported frames.
 * @returns {string} e.g. `REC T+04.2s`.
 */
export function cctvTimestamp(index, frameIntervalS) {
  const step = Number.isFinite(frameIntervalS) && frameIntervalS > 0 ? frameIntervalS : 0;
  const seconds = Math.max(0, Math.floor(index) || 0) * step;
  return `REC T+${seconds.toFixed(1).padStart(4, '0')}s`;
}
