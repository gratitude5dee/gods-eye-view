/**
 * Anchoring an ABot-Recon reconstruction onto the globe.
 *
 * A reconstruction has no georeference at all: ABot-Recon's world frame is the
 * first camera's frame, in meters, with `+x` right, `+y` down and `+z` forward
 * (the OpenCV-style camera convention its poses and point maps share). Placing
 * it on Earth is therefore an editorial act — the operator supplies an anchor
 * (lat, lon, heading of the walk's start), and this module rotates the SLAM
 * axes into local ENU so `groundRobots`' existing `slam-local` datum can carry
 * the result: a ground-relative offset on top of a terrain snap.
 *
 * Pure and Cesium-free so it runs identically in the browser and Node tests.
 *
 * @module data/reconstructionAnchor
 */

const DEG = Math.PI / 180;
/** WGS84 mean meridional radius — meters per radian of latitude. */
const EARTH_RADIUS_M = 6_371_008.8;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate an anchor: where the reconstruction's origin sits, and which
 * compass bearing its `+z` (camera forward) axis points along.
 * @param {{lat: number, lon: number, headingDeg?: number, elevM?: number}} anchor
 * @returns {{lat: number, lon: number, headingDeg: number, elevM: number}}
 */
export function normalizeAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') throw new Error('anchor must be an object');
  const { lat, lon } = anchor;
  if (!finite(lat) || lat < -90 || lat > 90) throw new Error('anchor.lat out of range');
  if (!finite(lon) || lon < -180 || lon > 180) throw new Error('anchor.lon out of range');
  const headingDeg = finite(anchor.headingDeg) ? anchor.headingDeg : 0;
  const elevM = finite(anchor.elevM) ? anchor.elevM : 0;
  return { lat, lon, headingDeg, elevM };
}

/**
 * Rotate one SLAM-frame point into the anchor's local ENU frame.
 * @param {{x: number, y: number, z: number}} point - Meters in the SLAM frame.
 * @param {number} headingDeg - Compass bearing of the SLAM `+z` axis.
 * @returns {{eastM: number, northM: number, upM: number}} Meters from the anchor.
 */
export function slamToEnu({ x, y, z }, headingDeg) {
  const heading = (finite(headingDeg) ? headingDeg : 0) * DEG;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  return {
    eastM: z * sin + x * cos,
    northM: z * cos - x * sin,
    upM: -y,
  };
}

/**
 * Offset a geodetic position by a local ENU displacement.
 *
 * Flat-Earth approximation, which costs sub-millimeter accuracy over the
 * hundred-meter span of a G1 clip and keeps the layer's per-point transform to
 * two multiplies.
 *
 * @param {{lat: number, lon: number}} anchor - Origin.
 * @param {number} eastM - Meters east.
 * @param {number} northM - Meters north.
 * @returns {{lat: number, lon: number}} Displaced position.
 */
export function offsetLatLon(anchor, eastM, northM) {
  const lat = anchor.lat + (northM / EARTH_RADIUS_M) / DEG;
  const cosLat = Math.max(1e-6, Math.cos(anchor.lat * DEG));
  const lon = anchor.lon + (eastM / (EARTH_RADIUS_M * cosLat)) / DEG;
  return { lat, lon };
}

/**
 * Compass bearing of a pose's forward axis, in the anchored frame.
 * @param {{x: number, y: number, z: number}} forward - SLAM-frame forward axis.
 * @param {number} headingDeg - Anchor heading.
 * @returns {number} Degrees clockwise from north, in [0, 360).
 */
export function forwardHeadingDeg(forward, headingDeg) {
  const { eastM, northM } = slamToEnu(forward, headingDeg);
  const bearing = Math.atan2(eastM, northM) / DEG;
  return ((bearing % 360) + 360) % 360;
}

/**
 * Convert a pose track (see `npyPoses.parsePoseTrack`) into anchored waypoints.
 * @param {{count: number, centers: Float64Array, forwards: Float64Array}} track
 * @param {{lat: number, lon: number, headingDeg?: number, elevM?: number}} anchor
 * @returns {Array<{lat: number, lon: number, elevM: number, headingDeg: number}>}
 *   `elevM` is ground-relative, as the `slam-local` datum expects.
 */
export function anchorPoseTrack(track, anchor) {
  const origin = normalizeAnchor(anchor);
  const waypoints = [];
  for (let i = 0; i < track.count; i += 1) {
    const at = i * 3;
    const enu = slamToEnu(
      { x: track.centers[at], y: track.centers[at + 1], z: track.centers[at + 2] },
      origin.headingDeg,
    );
    const { lat, lon } = offsetLatLon(origin, enu.eastM, enu.northM);
    waypoints.push({
      lat,
      lon,
      elevM: origin.elevM + enu.upM,
      headingDeg: forwardHeadingDeg(
        { x: track.forwards[at], y: track.forwards[at + 1], z: track.forwards[at + 2] },
        origin.headingDeg,
      ),
    });
  }
  return waypoints;
}

/**
 * How many points of a cloud a replay at `fraction` progress has revealed.
 *
 * The cloud is written in capture order, so revealing a prefix makes it grow
 * as the marker walks. A started replay always shows something, so any
 * fraction above zero reveals at least one point.
 *
 * @param {number} count - Points in the cloud.
 * @param {number} fraction - Replay progress in [0, 1].
 * @returns {number} Points to show.
 */
export function revealedPointCount(count, fraction) {
  if (!(count > 0)) return 0;
  if (!finite(fraction) || fraction <= 0) return 0;
  if (fraction >= 1) return count;
  return Math.max(1, Math.min(count, Math.round(count * fraction)));
}
