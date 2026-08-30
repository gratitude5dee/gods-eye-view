// src/data/groundRobotModels.test.mjs
//
// The optional G1 glTF for ground robots (`models3d`, default OFF).
//
// Two things are pinned, both behavioural:
//
//  1. The HANDOFF ordering, which is the same gap-proof contract the fleet
//     models keep (trackedModelRegime.test.mjs): a missing, unplaced or
//     still-loading model never hides the billboard, the model matrix is
//     committed BEFORE the readiness test, and the glyph is only released once
//     the model actually draws. A regression here shows up as a robot that
//     vanishes for a frame, or renders one frame at the Earth's centre.
//
//  2. That the flag DEFAULTS OFF and that turning it off again restores the
//     billboard-only path — the whole promise of the feature being additive.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import groundRobotsLayer, {
  _driveRobotModelHandoffForTest as driveHandoff,
  _releaseRobotModelsForTest as releaseModels,
} from './groundRobots.js';
import { advanceGaitPhase, gaitJointAngles, GAIT_POSED_NODES } from './robotGaitPose.js';

/** Minimal stand-in for the parts of Cesium.Model the handoff touches. */
function fakeModel({ ready = true, show = false, nodes = null } = {}) {
  return {
    ready,
    show,
    modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4()),
    getNode(name) { return nodes ? nodes.get(name) || undefined : undefined; },
  };
}

function fakeNode() {
  return {
    originalMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4()),
    matrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4()),
  };
}

const STAND_FRAME = { datum: 'wgs84-ellipsoid', gait: { fsm: 'stand' }, pose: {} };

// ---------------------------------------------------------------------------
// 1. Handoff ordering
// ---------------------------------------------------------------------------

test('models3d defaults OFF, leaving the billboard path in charge', () => {
  assert.equal(groundRobotsLayer.getParams().models3d, false);
});

test('setParams round-trips the flag and nothing else claims it', () => {
  groundRobotsLayer.setParams({ models3d: true });
  assert.equal(groundRobotsLayer.getParams().models3d, true);
  groundRobotsLayer.setParams({ models3d: false });
  assert.equal(groundRobotsLayer.getParams().models3d, false);
  // A setParams call that does not mention the flag must not disturb it.
  groundRobotsLayer.setParams({ models3d: true });
  groundRobotsLayer.setParams({ chaseRangeM: 30 });
  assert.equal(groundRobotsLayer.getParams().models3d, true);
  groundRobotsLayer.setParams({ models3d: false });
});

test('a robot with no model keeps its billboard', () => {
  const billboard = { show: true };
  const { owns } = driveHandoff({ model: null, billboard, frame: STAND_FRAME });
  assert.equal(owns, false);
  assert.equal(billboard.show, true, 'the glyph is the only visual until a model exists');
});

test('without a resolved ground height the model stays hidden', () => {
  // A depth-tested model cannot hide behind disableDepthTestDistance the way
  // the billboard does, so no terrain evidence means nothing safe to place.
  const billboard = { show: false };
  const model = fakeModel({ show: true });
  const { owns } = driveHandoff({
    model, billboard, groundHeightM: null, frame: STAND_FRAME,
  });
  assert.equal(owns, false);
  assert.equal(model.show, false);
  assert.equal(billboard.show, true, 'the billboard is handed back the visual');
});

test('the matrix is committed before the readiness test', () => {
  const billboard = { show: true };
  const model = fakeModel({ ready: false });
  const { owns } = driveHandoff({ model, billboard, frame: STAND_FRAME });
  assert.equal(owns, false);
  assert.equal(model.show, false, 'a half-loaded glTF must not flash');
  assert.equal(billboard.show, true);
  assert.ok(
    !Cesium.Matrix4.equals(model.modelMatrix, Cesium.Matrix4.IDENTITY),
    'a model that flips ready during the next scene update must already be placed',
  );
});

test('a ready, placed model takes the visual and only then hides the glyph', () => {
  const billboard = { show: true };
  const model = fakeModel();
  const { owns } = driveHandoff({ model, billboard, frame: STAND_FRAME });
  assert.equal(owns, true);
  assert.equal(model.show, true);
  assert.equal(billboard.show, false);
  // The matrix must put the robot at its snapped ground height, not at the
  // billboard's lifted anchor and not at the Earth's centre.
  const translation = Cesium.Matrix4.getTranslation(model.modelMatrix, new Cesium.Cartesian3());
  const carto = Cesium.Cartographic.fromCartesian(translation);
  assert.ok(Math.abs(carto.height - 12) < 0.001, 'no belly offset: the GLB origin is the soles');
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - 37.77) < 1e-6);
});

test('releasing models hands every billboard back', () => {
  const records = [
    { id: 'g1-01', model: fakeModel({ show: true }), billboard: { show: false }, modelNodes: new Map() },
    { id: 'g1-02', model: null, billboard: { show: false }, modelNodes: null },
  ];
  releaseModels(records);
  for (const record of records) {
    assert.equal(record.model, null);
    assert.equal(record.billboard.show, true);
  }
});

// ---------------------------------------------------------------------------
// 2. Gait posing
// ---------------------------------------------------------------------------

test('the handoff poses the posed joints off their rest matrices', () => {
  const nodes = new Map(GAIT_POSED_NODES.map((name) => [name, fakeNode()]));
  const model = fakeModel({ nodes });
  const { owns } = driveHandoff({
    model,
    billboard: { show: true },
    frame: { datum: 'wgs84-ellipsoid', pose: {}, gait: { fsm: 'walk', cadenceHz: 1.5, phase: Math.PI / 2 } },
  });
  assert.equal(owns, true);
  const knee = nodes.get('left_knee_link');
  assert.ok(
    !Cesium.Matrix4.equals(knee.matrix, Cesium.Matrix4.IDENTITY),
    'a walking G1 bends its knees',
  );
  // Rotation only — the rest translation of the link must survive posing.
  const translation = Cesium.Matrix4.getTranslation(knee.matrix, new Cesium.Cartesian3());
  assert.ok(Cesium.Cartesian3.equals(translation, Cesium.Cartesian3.ZERO));
});

test('a walk cycle is antisymmetric between the legs', () => {
  const a = gaitJointAngles('walk', 0.7);
  assert.ok(Math.abs(a.left_hip_pitch_link + a.right_hip_pitch_link) < 1e-9,
    'the legs are half a stride apart, so the hips mirror');
  assert.notEqual(a.left_knee_link, a.right_knee_link);
  // The knee only bends one way on the real robot.
  assert.ok(a.left_knee_link >= -0.09 && a.right_knee_link >= -0.09);
});

test('run opens the same cycle up rather than being a different pose', () => {
  const walk = gaitJointAngles('walk', 1.2);
  const run = gaitJointAngles('run', 1.2);
  assert.ok(Math.abs(run.left_hip_pitch_link) > Math.abs(walk.left_hip_pitch_link));
  assert.ok(Math.sign(run.left_hip_pitch_link) === Math.sign(walk.left_hip_pitch_link));
});

test('non-locomoting states are static stances, and unknown falls back to standing', () => {
  for (const fsm of ['stand', 'damp', 'squat', 'sit', 'unknown']) {
    const first = gaitJointAngles(fsm, 0);
    const later = gaitJointAngles(fsm, 3.1);
    assert.deepEqual(first, later, `${fsm} must not animate`);
  }
  assert.deepEqual(gaitJointAngles('unknown', 0), gaitJointAngles('stand', 0));
  assert.ok(gaitJointAngles('squat').left_knee_link > gaitJointAngles('stand').left_knee_link);
});

test('the local stride clock only advances while walking, and stays bounded', () => {
  assert.equal(advanceGaitPhase(0, 1.5, 100, 'stand'), 0);
  const stepped = advanceGaitPhase(0, 1.5, 100, 'walk');
  assert.ok(stepped > 0 && stepped < 2 * Math.PI);
  let phase = 0;
  for (let i = 0; i < 500; i += 1) phase = advanceGaitPhase(phase, 1.5, 100, 'walk');
  assert.ok(phase >= 0 && phase < 2 * Math.PI, 'phase wraps instead of growing without bound');
  // A hostile cadence or a tab that was backgrounded for a minute must not
  // teleport the cycle by thousands of radians.
  assert.ok(advanceGaitPhase(0, 1e9, 1e9, 'walk') < 2 * Math.PI);
});
