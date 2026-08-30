/**
 * Gait posing for the Unitree G1 glTF — pure math, no Cesium.
 *
 * `public/models/unitree-g1.glb` keeps the MuJoCo body hierarchy and link
 * names, so a joint is posed by rotating one named glTF node. Every joint used
 * here is a PITCH joint, and the exporter leaves link frames in MuJoCo
 * orientation (only the root node converts axes), so all of them rotate about
 * their own local +Y — one axis for the whole solver.
 *
 * The angles are a readable walk cycle, not a physics replay: the wire frame
 * carries a gait FSM state, a cadence and (optionally) the policy's stride
 * phase, never the 23 joint angles. Sign conventions follow the MJCF, where a
 * positive knee angle bends the leg backwards.
 *
 * @module data/robotGaitPose
 */

/** Joint limits from the Menagerie `unitree_g1` MJCF (radians). */
const LIMITS = Object.freeze({
  hip: [-2.53, 2.88],
  knee: [-0.09, 2.88],
  ankle: [-0.87, 0.52],
  shoulder: [-3.09, 2.67],
  elbow: [-1.05, 2.09],
});

/** Static stances, in the same joint vocabulary as the walk cycle. */
const STANCES = Object.freeze({
  stand: { hip: 0, knee: 0.06, ankle: -0.03, shoulder: 0.1, elbow: 0.25 },
  // `damp` is motors-limp: the G1 sags onto its knees rather than holding a pose.
  damp: { hip: -0.35, knee: 0.9, ankle: -0.3, shoulder: 0.35, elbow: 0.5 },
  squat: { hip: -0.9, knee: 1.6, ankle: -0.6, shoulder: 0.2, elbow: 0.8 },
  sit: { hip: -1.5, knee: 2.0, ankle: -0.35, shoulder: 0.15, elbow: 0.9 },
});

/** Per-state stride amplitudes. `run` is the same cycle, opened up. */
const STRIDE = Object.freeze({
  walk: { hip: 0.42, knee: 0.62, ankle: 0.18, shoulder: 0.28, elbow: 0.18, lean: 0.04 },
  run: { hip: 0.66, knee: 1.05, ankle: 0.3, shoulder: 0.5, elbow: 0.42, lean: 0.13 },
});

function clamp(value, [lo, hi]) {
  return value < lo ? lo : (value > hi ? hi : value);
}

/**
 * Integrate the local stride clock for one render tick.
 *
 * Used when a sender omits `gait.phase`: cadence alone still animates, and the
 * phase stays bounded so a long-lived robot cannot accumulate a float that has
 * lost its fractional precision.
 * @param {number} phase - Previous phase in radians.
 * @param {number|null|undefined} cadenceHz - Stride frequency.
 * @param {number} dtMs - Elapsed time since the previous tick.
 * @param {string} [fsm] - Gait state; only walk/run advance.
 * @returns {number} Next phase in [0, 2π).
 */
export function advanceGaitPhase(phase, cadenceHz, dtMs, fsm = 'walk') {
  const base = Number.isFinite(phase) ? phase : 0;
  if (fsm !== 'walk' && fsm !== 'run') return base;
  const hz = Number.isFinite(cadenceHz) && cadenceHz > 0 ? Math.min(cadenceHz, 4) : 1.5;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 0;
  const next = base + 2 * Math.PI * hz * (dt / 1000);
  return next % (2 * Math.PI);
}

/**
 * Joint angles (radians) for one gait state and stride phase.
 *
 * The left leg leads at `phase`, the right at `phase + π`; arms counter-swing
 * against the opposite leg, which is what makes a walk read as a walk. Values
 * are clamped to the MJCF joint limits so no pose can bend the model into a
 * shape the real robot cannot hold.
 * @param {string} fsm - One of GAIT_FSM_STATES.
 * @param {number} phase - Stride phase in radians.
 * @returns {Record<string, number>} glTF node name -> rotation about local +Y.
 */
export function gaitJointAngles(fsm, phase) {
  const stride = STRIDE[fsm];
  if (!stride) {
    const stance = STANCES[fsm] || STANCES.stand;
    return {
      left_hip_pitch_link: clamp(stance.hip, LIMITS.hip),
      right_hip_pitch_link: clamp(stance.hip, LIMITS.hip),
      left_knee_link: clamp(stance.knee, LIMITS.knee),
      right_knee_link: clamp(stance.knee, LIMITS.knee),
      left_ankle_pitch_link: clamp(stance.ankle, LIMITS.ankle),
      right_ankle_pitch_link: clamp(stance.ankle, LIMITS.ankle),
      left_shoulder_pitch_link: clamp(stance.shoulder, LIMITS.shoulder),
      right_shoulder_pitch_link: clamp(stance.shoulder, LIMITS.shoulder),
      left_elbow_link: clamp(stance.elbow, LIMITS.elbow),
      right_elbow_link: clamp(stance.elbow, LIMITS.elbow),
      torso_link: 0,
    };
  }
  const p = Number.isFinite(phase) ? phase : 0;
  const legs = [['left', p], ['right', p + Math.PI]];
  const out = { torso_link: stride.lean };
  for (const [side, sidePhase] of legs) {
    const swing = Math.sin(sidePhase);
    // The knee only ever bends one way, so the cycle is rectified rather than
    // sinusoidal: the leg tucks through swing and stays near-straight in stance.
    const flex = Math.max(0, -Math.cos(sidePhase));
    out[`${side}_hip_pitch_link`] = clamp(stride.hip * swing, LIMITS.hip);
    out[`${side}_knee_link`] = clamp(0.06 + stride.knee * flex, LIMITS.knee);
    out[`${side}_ankle_pitch_link`] = clamp(-stride.ankle * swing, LIMITS.ankle);
    const arm = side === 'left' ? -swing : swing;
    out[`${side}_shoulder_pitch_link`] = clamp(stride.shoulder * arm, LIMITS.shoulder);
    out[`${side}_elbow_link`] = clamp(0.25 + stride.elbow * Math.abs(arm), LIMITS.elbow);
  }
  return out;
}

/** Node names the solver touches — the model-node lookup is built from this. */
export const GAIT_POSED_NODES = Object.freeze(Object.keys(gaitJointAngles('walk', 0)));
