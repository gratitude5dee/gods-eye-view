/**
 * Robot render-time motion: interpolate between telemetry fixes with a small
 * render delay, then coast briefly on the last course before freezing. Pure
 * and Cesium-free — the layer converts the returned lat/lon to Cartesian.
 *
 * The renderer displays `renderDelayMs` behind wall clock (one telemetry
 * interval, ~200 ms at 10 Hz) so it can interpolate between two real fixes
 * instead of extrapolating ahead of the newest one.
 *
 * @module data/robotMotion
 */

import { haversineM } from './robotTransposition.js';

/** Default render delay: two 100 ms frames at the 10 Hz bridge rate. */
export const ROBOT_RENDER_DELAY_MS = 200;

/** Hard coast bound — stale robots freeze rather than drift forever. */
export const ROBOT_COAST_LIMIT_MS = 1500;

const DEG = Math.PI / 180;

/**
 * Pose at `renderMs` from a bounded history of fixes (oldest → newest,
 * each `{t, lat, lon, elevM, headingDeg, speedMps}`).
 *
 * Between two bracketing fixes the pose is a linear blend. Past the newest
 * fix it dead-reckons along the last course, but never farther than
 * `coastLimitMs` — beyond that the pose freezes at the coast bound.
 *
 * @param {Array<object>} fixes - Position history, ascending by `t`.
 * @param {number} renderMs - Wall clock minus render delay.
 * @param {{coastLimitMs?: number}} [options]
 * @returns {{lat:number, lon:number, elevM:number, headingDeg:number,
 *   stale:boolean}|null} Null when there are no fixes.
 */
export function robotPoseAt(fixes, renderMs, { coastLimitMs = ROBOT_COAST_LIMIT_MS } = {}) {
  if (!Array.isArray(fixes) || fixes.length === 0) return null;
  const newest = fixes[fixes.length - 1];
  if (renderMs <= fixes[0].t) {
    const f = fixes[0];
    return { lat: f.lat, lon: f.lon, elevM: f.elevM, headingDeg: f.headingDeg, stale: false };
  }
  if (fixes.length > 1 && renderMs <= newest.t) {
    let i = 1;
    while (i < fixes.length - 1 && fixes[i].t < renderMs) i += 1;
    const a = fixes[i - 1];
    const b = fixes[i];
    const span = b.t - a.t;
    const f = span > 0 ? (renderMs - a.t) / span : 1;
    return {
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      elevM: a.elevM + (b.elevM - a.elevM) * f,
      headingDeg: b.headingDeg,
      stale: false,
    };
  }
  // Coast past the newest fix along its course, bounded.
  const coastMs = Math.min(renderMs - newest.t, coastLimitMs);
  const speed = Number.isFinite(newest.speedMps) ? Math.max(0, newest.speedMps) : 0;
  const distM = speed * (coastMs / 1000);
  const heading = Number.isFinite(newest.headingDeg) ? newest.headingDeg : 0;
  const dLat = (distM * Math.cos(heading * DEG)) / 111320;
  const dLon = (distM * Math.sin(heading * DEG))
    / (111320 * Math.max(0.01, Math.cos(newest.lat * DEG)));
  return {
    lat: newest.lat + dLat,
    lon: newest.lon + dLon,
    elevM: newest.elevM,
    headingDeg: heading,
    stale: renderMs - newest.t > coastLimitMs,
  };
}

/**
 * Append a fix to a bounded history (keeps the newest `limit` fixes).
 * Rejects out-of-order or duplicate timestamps.
 * @param {Array<object>} fixes - Existing history (mutated).
 * @param {object} fix - New fix `{t, lat, lon, ...}`.
 * @param {number} [limit=5] - Maximum retained fixes.
 * @returns {boolean} Whether the fix was accepted.
 */
export function pushFix(fixes, fix, limit = 5) {
  if (!fix || !Number.isFinite(fix.t)) return false;
  const newest = fixes[fixes.length - 1];
  if (newest && fix.t <= newest.t) return false;
  fixes.push(fix);
  while (fixes.length > limit) fixes.shift();
  return true;
}

/**
 * Distance in meters between two fixes (diagnostics/trail thinning).
 * @param {object} a @param {object} b
 * @returns {number}
 */
export function fixDistanceM(a, b) {
  return haversineM(a.lat, a.lon, b.lat, b.lon);
}
