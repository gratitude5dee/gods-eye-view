/**
 * Gait-integrated virtual transposition — maps a harness-constrained robot's
 * real gait onto a geographic route. The robot never translates in the real
 * world; forward progress here is integrated strictly from detected foot
 * strikes (cadence × stride), never from a translation velocity that does not
 * exist. Pure and Cesium-free.
 *
 * Every output is staged geography and must be labeled VIRTUAL TRANSPOSITION.
 *
 * @module data/robotTransposition
 */

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Gait states that advance route progress. Standing/damped never advance. */
const ADVANCING_GAITS = Object.freeze(['walk', 'run']);

/**
 * Parse a GeoJSON LineString feature into a cumulative-distance route.
 * @param {object} feature - GeoJSON Feature with LineString geometry
 *   (`[lon, lat, elevM]` positions).
 * @returns {{points: Array<{lat:number, lon:number, elevM:number, sM:number}>, lengthM: number}}
 */
export function parseRoute(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error('route requires a LineString with >= 2 positions');
  }
  const points = [];
  let sM = 0;
  for (let i = 0; i < coords.length; i += 1) {
    const [lon, lat, elevM = 0] = coords[i];
    if (i > 0) sM += haversineM(points[i - 1].lat, points[i - 1].lon, lat, lon);
    points.push({ lat, lon, elevM, sM });
  }
  return { points, lengthM: sM };
}

/**
 * Great-circle distance in meters.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number}
 */
export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial bearing from point 1 to point 2, degrees clockwise from north.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} 0..360
 */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG)
    - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/**
 * Position, elevation, and route-tangent heading at arc length `sM`.
 * Clamps to the route endpoints.
 * @param {{points: Array, lengthM: number}} route - From parseRoute.
 * @param {number} sM - Arc length along the route in meters.
 * @returns {{lat:number, lon:number, elevM:number, headingDeg:number, sM:number, done:boolean}}
 */
export function pointAlongRoute(route, sM) {
  const points = route.points;
  const s = Math.max(0, Math.min(route.lengthM, sM));
  let i = 1;
  while (i < points.length - 1 && points[i].sM < s) i += 1;
  const a = points[i - 1];
  const b = points[i];
  const segLen = b.sM - a.sM;
  const f = segLen > 0 ? (s - a.sM) / segLen : 0;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    elevM: a.elevM + (b.elevM - a.elevM) * f,
    headingDeg: bearingDeg(a.lat, a.lon, b.lat, b.lon),
    sM: s,
    done: s >= route.lengthM,
  };
}

/**
 * Advance route progress from real gait evidence.
 *
 * Progress integrates only from foot strikes: `strikes × strideM`. When
 * per-strike events are unavailable, `cadenceHz × dtSec` estimates the strike
 * count for the interval — still gait-derived, never a fictitious velocity.
 *
 * @param {object} input
 * @param {string} input.gaitState - Robot FSM state ('walk'|'stand'|...).
 * @param {number} [input.cadenceHz] - Step frequency (per-foot strikes/sec).
 * @param {number} [input.strideM] - Distance per strike, meters.
 * @param {number} [input.strikeCount] - Detected foot strikes this interval
 *   (preferred over cadence estimation when present).
 * @param {number} [input.dtSec] - Interval length for cadence estimation.
 * @param {{points: Array, lengthM: number}} input.route - From parseRoute.
 * @param {number} input.sAlong - Current arc length along the route, meters.
 * @returns {{lat:number, lon:number, elevM:number, headingDeg:number,
 *   sAlong:number, progressM:number, transposed:true, label:'VIRTUAL TRANSPOSITION'}}
 */
export function transpose({
  gaitState,
  cadenceHz = 0,
  strideM = 0,
  strikeCount = null,
  dtSec = 0,
  route,
  sAlong = 0,
}) {
  let progressM = 0;
  if (ADVANCING_GAITS.includes(gaitState) && strideM > 0) {
    const strikes = Number.isFinite(strikeCount) && strikeCount !== null
      ? Math.max(0, strikeCount)
      : Math.max(0, cadenceHz) * Math.max(0, dtSec);
    progressM = strikes * strideM;
  }
  const next = pointAlongRoute(route, sAlong + progressM);
  return {
    lat: next.lat,
    lon: next.lon,
    elevM: next.elevM,
    headingDeg: next.headingDeg,
    sAlong: next.sM,
    progressM,
    done: next.done,
    transposed: true,
    label: 'VIRTUAL TRANSPOSITION',
  };
}
