// Atmosphere terms for the cockpit cloud pass, ported in spirit from
// three-geospatial's `@takram/three-atmosphere` (Bruneton-style precomputed
// scattering). Cesium still owns the sky and terrain: these helpers only shade
// the transparent cloud overlay, so the expensive LUTs are replaced with
// closed-form Rayleigh transmittance along an approximated air mass.

// Rayleigh scattering coefficients at sea level, per metre (Bruneton 2008).
const RAYLEIGH_BETA = Object.freeze([5.8e-6, 13.5e-6, 33.1e-6]);
// Effective Rayleigh scale height; the vertical air column is beta * H.
const RAYLEIGH_SCALE_HEIGHT_M = 8000;

const DEG = Math.PI / 180;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDeg(deg) {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Solar elevation and azimuth for a ground point, using the NOAA low-precision
 * equations (better than a quarter degree, which the cloud pass cannot see).
 * @param {{dateMs: number, latitude: number, longitude: number}} params
 * @returns {{elevationDeg: number, azimuthDeg: number}}
 */
export function solarPositionDeg({ dateMs, latitude, longitude }) {
  if (![dateMs, latitude, longitude].every(Number.isFinite)) {
    return { elevationDeg: 0, azimuthDeg: 0 };
  }
  const julianDays = dateMs / 86_400_000 + 2440587.5;
  const centuries = (julianDays - 2451545) / 36525;
  const meanLongitude = normalizeDeg(280.46646 + centuries * (36000.76983 + 0.0003032 * centuries));
  const meanAnomaly = 357.52911 + centuries * (35999.05029 - 0.0001537 * centuries);
  const equationOfCenter = Math.sin(meanAnomaly * DEG) * (1.914602 - centuries * 0.004817)
    + Math.sin(2 * meanAnomaly * DEG) * (0.019993 - 0.000101 * centuries)
    + Math.sin(3 * meanAnomaly * DEG) * 0.000289;
  const trueLongitude = meanLongitude + equationOfCenter;
  const apparentLongitude = trueLongitude
    - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * centuries) * DEG);
  const obliquity = 23.439291 - 0.0130042 * centuries;
  const declination = Math.asin(Math.sin(obliquity * DEG) * Math.sin(apparentLongitude * DEG));

  const varY = Math.tan(obliquity * DEG / 2) ** 2;
  const equationOfTimeMin = 4 / DEG * (
    varY * Math.sin(2 * meanLongitude * DEG)
    - 2 * 0.016708634 * Math.sin(meanAnomaly * DEG)
    + 4 * 0.016708634 * varY * Math.sin(meanAnomaly * DEG) * Math.cos(2 * meanLongitude * DEG)
    - 0.5 * varY * varY * Math.sin(4 * meanLongitude * DEG)
    - 1.25 * 0.016708634 * 0.016708634 * Math.sin(2 * meanAnomaly * DEG)
  );
  const minutesUtc = (dateMs / 60_000) % 1440;
  const trueSolarMin = minutesUtc + equationOfTimeMin + 4 * longitude;
  const hourAngle = trueSolarMin / 4 - 180;

  const latitudeRad = latitude * DEG;
  const cosZenith = clamp(
    Math.sin(latitudeRad) * Math.sin(declination)
      + Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle * DEG),
    -1,
    1,
  );
  const zenith = Math.acos(cosZenith);
  const elevationDeg = 90 - zenith / DEG;
  // Both components carry the same 1/sin(zenith) normalization, so atan2 reads
  // a true angle rather than a stretched one.
  const sinZenith = Math.max(1e-6, Math.sin(zenith));
  const sinAzimuth = -Math.sin(hourAngle * DEG) * Math.cos(declination) / sinZenith;
  const cosAzimuth = (Math.sin(declination) - Math.sin(latitudeRad) * cosZenith)
    / (Math.max(1e-6, Math.cos(latitudeRad)) * sinZenith);
  const azimuthDeg = normalizeDeg(Math.atan2(sinAzimuth, clamp(cosAzimuth, -1, 1)) / DEG);
  return { elevationDeg, azimuthDeg };
}

/**
 * Sun direction in the cloud pass's view frame: +x right, +y up, +z into the
 * screen along the cockpit heading.
 * @param {number} elevationDeg
 * @param {number} azimuthDeg Degrees clockwise from the view direction.
 * @returns {{x: number, y: number, z: number}}
 */
export function cockpitSunDirection(elevationDeg, azimuthDeg) {
  const elevation = (Number.isFinite(elevationDeg) ? elevationDeg : 0) * DEG;
  const azimuth = (Number.isFinite(azimuthDeg) ? azimuthDeg : 0) * DEG;
  const horizontal = Math.cos(elevation);
  return {
    x: horizontal * Math.sin(azimuth),
    y: Math.sin(elevation),
    z: horizontal * Math.cos(azimuth),
  };
}

/** Relative air mass along the sun ray (Kasten & Young 1989), horizon-safe. */
export function solarAirMass(elevationDeg) {
  const elevation = Number.isFinite(elevationDeg) ? elevationDeg : 0;
  const clamped = Math.max(-2, elevation);
  return 1 / (Math.sin(clamped * DEG) + 0.50572 * (clamped + 6.07995) ** -1.6364);
}

/**
 * Sun and sky radiance reaching the clouds, from Rayleigh transmittance along
 * the solar air mass. Low sun reddens the direct term and the ambient term
 * keeps the Rayleigh blue bias, which is what sells altitude on the overlay.
 * @param {number} elevationDeg
 * @returns {{sun: number[], sky: number[], intensity: number}}
 */
export function cockpitSunIrradiance(elevationDeg) {
  const elevation = Number.isFinite(elevationDeg) ? elevationDeg : 0;
  const airMass = solarAirMass(elevation);
  const opticalDepth = RAYLEIGH_BETA.map((beta) => beta * RAYLEIGH_SCALE_HEIGHT_M * airMass);
  const transmittance = opticalDepth.map((depth) => Math.exp(-depth));
  // Above the horizon the disc is visible; below it only twilight ambience is.
  const intensity = clamp((elevation + 6) / 12, 0.02, 1);
  const sun = transmittance.map((value) => clamp(value * intensity, 0, 1));
  const scattered = opticalDepth.map((depth, index) => (1 - transmittance[index]) * (depth > 0 ? 1 : 0));
  const peak = Math.max(...scattered, 1e-6);
  const sky = scattered.map((value) => clamp(0.18 + 0.62 * (value / peak) * intensity, 0, 1));
  return { intensity, sky, sun };
}

/**
 * Aerial-perspective weights for the cloud overlay: how much sky inscatter is
 * added per unit ray distance, and how fast cloud extinction is muted. Both
 * fall off with altitude because the air column above the camera thins.
 * @param {number} altitudeM
 * @returns {{inscatter: number, extinctionScale: number}}
 */
export function cockpitAerialPerspective(altitudeM) {
  const altitude = Math.max(0, Number(altitudeM) || 0);
  const density = Math.exp(-altitude / RAYLEIGH_SCALE_HEIGHT_M);
  return {
    extinctionScale: clamp(0.55 + 0.45 * density, 0.55, 1),
    inscatter: clamp(0.34 * density, 0.004, 0.34),
  };
}
