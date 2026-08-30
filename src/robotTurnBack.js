/**
 * Turn-back advisor — point-of-no-return energy model.
 *
 * Pure and Cesium-free. Estimates the energy to walk home over real terrain
 * (slope-dependent cost, wind and precipitation penalties) and converts the
 * battery's usable remainder into a turn-back radius: the boundary beyond
 * which the robot cannot get home with the reserve intact. The ring contracts
 * monotonically as SOC drains.
 *
 * Every output is labeled `ESTIMATE` until the model is calibrated against a
 * measured run (repo provenance convention).
 *
 * @module robotTurnBack
 */

/** Level-ground locomotion cost (Wh per metre) for a G1-class walker. */
export const BASE_COST_WH_PER_M = 0.06;
/** Extra cost (Wh) per metre of ascent — lifting 35 kg is expensive. */
export const CLIMB_COST_WH_PER_M = 0.16;
/**
 * Extra cost (Wh) per metre of DESCENT. Not a saving: a legged platform
 * descending steeply burns energy on stability, it does not regenerate.
 */
export const DESCENT_COST_WH_PER_M = 0.05;
/** Wind penalty saturates at this factor (headwind on an exposed ridge). */
export const MAX_WIND_FACTOR = 1.6;
/** Precipitation multiplier — wet/snowy ground costs more per step. */
export const PRECIP_FACTOR = 1.25;
/** Provenance label for every advisor output until calibrated. */
export const TURN_BACK_PROVENANCE = 'ESTIMATE';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Weather multiplier ≥ 1 from wind speed and precipitation. */
export function weatherFactor({ windMps = 0, precipitating = false } = {}) {
  const wind = finite(windMps) ? Math.max(0, windMps) : 0;
  const windFactor = Math.min(MAX_WIND_FACTOR, 1 + wind / 25);
  return windFactor * (precipitating ? PRECIP_FACTOR : 1);
}

/**
 * Energy (Wh) to traverse a return path of terrain segments.
 * @param {Array<{distM: number, riseM: number}>} segments - Path home,
 *   robot → base; `riseM` positive uphill along travel direction.
 * @param {{windMps?: number, precipitating?: boolean}} [weather]
 * @returns {number} Estimated energy in Wh (0 for an empty path).
 */
export function returnEnergyWh(segments, weather = {}) {
  if (!Array.isArray(segments)) return 0;
  let wh = 0;
  for (const segment of segments) {
    const distM = finite(segment?.distM) ? Math.max(0, segment.distM) : 0;
    const riseM = finite(segment?.riseM) ? segment.riseM : 0;
    wh += distM * BASE_COST_WH_PER_M;
    wh += Math.max(0, riseM) * CLIMB_COST_WH_PER_M;
    wh += Math.max(0, -riseM) * DESCENT_COST_WH_PER_M;
  }
  return wh * weatherFactor(weather);
}

/**
 * Usable battery remainder (Wh) above the reserve margin.
 * @param {{socPct: number, capacityWh: number, reservePct?: number}} battery
 * @returns {number} Wh available for the walk home; 0 at/below reserve.
 */
export function usableEnergyWh({ socPct, capacityWh, reservePct = 20 } = {}) {
  if (!finite(socPct) || !finite(capacityWh) || capacityWh <= 0) return 0;
  const usablePct = Math.max(0, Math.min(100, socPct) - Math.max(0, reservePct));
  return capacityWh * (usablePct / 100);
}

/**
 * Turn-back ring radius (m): how far from home the robot may roam and still
 * return with the reserve intact, over terrain of a given mean grade.
 * @param {{socPct: number, capacityWh: number, reservePct?: number}} battery
 * @param {{meanGradePct?: number, windMps?: number, precipitating?: boolean}} [conditions]
 *   `meanGradePct` is the average return-path grade magnitude (5 = 5% slope).
 * @returns {{radiusM: number, usableWh: number, costWhPerM: number, provenance: string}}
 */
export function turnBackRadiusM(battery, conditions = {}) {
  const usableWh = usableEnergyWh(battery);
  const gradePct = finite(conditions.meanGradePct) ? Math.abs(conditions.meanGradePct) : 0;
  const risePerM = gradePct / 100;
  // A return path alternates climb and descent around the mean grade; charge
  // the climb rate on the graded fraction (conservative — never optimistic).
  const costWhPerM = (BASE_COST_WH_PER_M + risePerM * CLIMB_COST_WH_PER_M)
    * weatherFactor(conditions);
  const radiusM = costWhPerM > 0 ? usableWh / costWhPerM : 0;
  return {
    radiusM,
    usableWh,
    costWhPerM,
    provenance: TURN_BACK_PROVENANCE,
  };
}
