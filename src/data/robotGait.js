/**
 * Gait state classifier — walking / carried / stuck / fallen / standing.
 *
 * Pure and Cesium-free. `classifyGait(window)` scores a 2–3 s sliding window
 * of RobotFrames on separable physical signatures:
 *
 *   walking — foot contact alternating, cadence in the 1.2–2.4 Hz band,
 *             measured speed consistent with cadence × stride
 *   carried — foot force ≈ 0 on both feet while the body still translates
 *   stuck   — gait engine cadencing (intent) but measured speed ≈ 0 with
 *             foot forces high
 *   fallen  — pitch or roll beyond ~50°, sustained across the window
 *   standing — feet loaded, no cadence, no translation
 *
 * `createGaitClassifier()` wraps it with dwell-based hysteresis so the state
 * does not chatter at boundaries.
 *
 * @module data/robotGait
 */

/** Sustained attitude (deg) beyond which the robot reads fallen. */
export const FALLEN_ATTITUDE_DEG = 50;
/** Both feet under this force (N) means unloaded — carried or airborne. */
export const UNLOADED_FORCE_N = 25;
/** Speed (m/s) under this is "not translating". */
export const STATIONARY_SPEED_MPS = 0.1;
/** Plausible walking cadence band (Hz). */
export const CADENCE_BAND_HZ = Object.freeze({ min: 1.2, max: 2.4 });
/** Consecutive agreeing windows required before hysteresis switches state. */
export const HYSTERESIS_DWELL = 2;

const STATES = Object.freeze(['walking', 'carried', 'stuck', 'fallen', 'standing']);

function fraction(frames, predicate) {
  if (!frames.length) return 0;
  let n = 0;
  for (const frame of frames) if (predicate(frame)) n += 1;
  return n / frames.length;
}

function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** How often the left/right contact pattern flips between adjacent frames. */
function contactAlternation(frames) {
  let flips = 0;
  let pairs = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1].gait?.contact;
    const b = frames[i].gait?.contact;
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    pairs += 1;
    if (a[0] !== b[0] || a[1] !== b[1]) flips += 1;
  }
  return pairs ? flips / pairs : 0;
}

/**
 * Score one window against each state's physical signature.
 * @param {object[]} frames - Chronological RobotFrames spanning ~2–3 s.
 * @returns {{state: string, confidence: number, scores: Object<string, number>}}
 */
export function classifyGait(frames) {
  const window = Array.isArray(frames) ? frames.filter(Boolean) : [];
  if (window.length < 3) return { state: 'standing', confidence: 0, scores: {} };

  const speeds = window.map((f) => Math.abs(f.vel?.speedMps ?? 0));
  const cadences = window.map((f) => f.gait?.cadenceHz ?? 0);
  const meanSpeed = mean(speeds);
  const meanCadence = mean(cadences);

  const fallenFrac = fraction(window, (f) => Math.abs(f.pose?.pitchDeg ?? 0) > FALLEN_ATTITUDE_DEG
    || Math.abs(f.pose?.rollDeg ?? 0) > FALLEN_ATTITUDE_DEG);
  const unloadedFrac = fraction(window, (f) => {
    const force = f.gait?.footForce;
    return Array.isArray(force) && force[0] < UNLOADED_FORCE_N && force[1] < UNLOADED_FORCE_N;
  });
  const loadedFrac = fraction(window, (f) => {
    const force = f.gait?.footForce;
    return Array.isArray(force) && (force[0] >= UNLOADED_FORCE_N || force[1] >= UNLOADED_FORCE_N);
  });
  const alternation = contactAlternation(window);
  const cadenceInBand = meanCadence >= CADENCE_BAND_HZ.min && meanCadence <= CADENCE_BAND_HZ.max;
  const translating = meanSpeed > STATIONARY_SPEED_MPS;

  // Speed consistency: measured speed vs cadence × stride, 1 = perfect match.
  const meanStride = mean(window.map((f) => f.gait?.strideM ?? 0));
  const predicted = meanCadence * meanStride;
  const speedConsistency = predicted > 0
    ? Math.max(0, 1 - Math.abs(meanSpeed - predicted) / Math.max(predicted, 0.2))
    : 0;

  const scores = {
    fallen: fallenFrac,
    carried: unloadedFrac * (translating ? 1 : 0.3),
    walking: (cadenceInBand ? 1 : 0) * Math.min(1, alternation * 3) * (translating ? 1 : 0)
      * (0.5 + 0.5 * speedConsistency),
    stuck: loadedFrac * (meanCadence > 0.5 ? 1 : 0) * (translating ? 0 : 1),
    standing: loadedFrac * (meanCadence <= 0.5 ? 1 : 0) * (translating ? 0 : 1),
  };

  let state = 'standing';
  let confidence = 0;
  for (const candidate of STATES) {
    if (scores[candidate] > confidence) {
      state = candidate;
      confidence = scores[candidate];
    }
  }
  return { state, confidence, scores };
}

/**
 * Stateful classifier with dwell hysteresis: a new state must win on
 * HYSTERESIS_DWELL consecutive windows before it replaces the current one,
 * so boundary windows cannot chatter.
 * @param {{dwell?: number}} [options]
 * @returns {{update: function(object[]): {state: string, confidence: number}, reset: function(): void}}
 */
export function createGaitClassifier({ dwell = HYSTERESIS_DWELL } = {}) {
  let current = 'standing';
  let candidate = null;
  let streak = 0;
  return {
    update(frames) {
      const { state, confidence } = classifyGait(frames);
      if (state === current) {
        candidate = null;
        streak = 0;
      } else if (state === candidate) {
        streak += 1;
        if (streak >= dwell) {
          current = state;
          candidate = null;
          streak = 0;
        }
      } else {
        candidate = state;
        streak = 1;
        if (streak >= dwell) {
          current = state;
          candidate = null;
          streak = 0;
        }
      }
      return { state: current, confidence };
    },
    reset() {
      current = 'standing';
      candidate = null;
      streak = 0;
    },
  };
}
