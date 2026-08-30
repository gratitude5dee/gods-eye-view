import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CADENCE_BAND_HZ,
  classifyGait,
  createGaitClassifier,
  HYSTERESIS_DWELL,
} from './robotGait.js';

/** Build a 2.5 s / 10 Hz fixture window for one gait signature. */
function fixtureWindow(kind, count = 25) {
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const phase = Math.sin(i * 1.1);
    const left = phase >= 0;
    if (kind === 'walking') {
      frames.push({
        pose: { pitchDeg: 0, rollDeg: 0 },
        vel: { speedMps: 0.9 },
        gait: {
          cadenceHz: 1.8,
          strideM: 0.5,
          contact: [left, !left],
          footForce: left ? [200, 10] : [10, 200],
        },
      });
    } else if (kind === 'carried') {
      frames.push({
        pose: { pitchDeg: 5 * phase, rollDeg: 6 * phase },
        vel: { speedMps: 1.1 },
        gait: { cadenceHz: 0, strideM: 0, contact: [false, false], footForce: [2, 3] },
      });
    } else if (kind === 'stuck') {
      frames.push({
        pose: { pitchDeg: 0, rollDeg: 0 },
        vel: { speedMps: 0.02 },
        gait: { cadenceHz: 1.7, strideM: 0.4, contact: [true, true], footForce: [260, 240] },
      });
    } else if (kind === 'fallen') {
      frames.push({
        pose: { pitchDeg: 78, rollDeg: 10 },
        vel: { speedMps: 0 },
        gait: { cadenceHz: 0, strideM: 0, contact: [false, true], footForce: [40, 5] },
      });
    } else {
      frames.push({
        pose: { pitchDeg: 0, rollDeg: 0 },
        vel: { speedMps: 0 },
        gait: { cadenceHz: 0, strideM: 0, contact: [true, true], footForce: [220, 225] },
      });
    }
  }
  return frames;
}

test('all four signature states classify from fixture windows', () => {
  for (const kind of ['walking', 'carried', 'stuck', 'fallen']) {
    const { state, confidence } = classifyGait(fixtureWindow(kind));
    assert.equal(state, kind, `${kind} fixture must classify as ${kind}`);
    assert.ok(confidence > 0.5, `${kind} confidence ${confidence} must be decisive`);
  }
  assert.equal(classifyGait(fixtureWindow('standing')).state, 'standing');
});

test('a short or empty window degrades to standing with zero confidence', () => {
  assert.deepEqual(classifyGait([]).state, 'standing');
  assert.equal(classifyGait([]).confidence, 0);
  assert.equal(classifyGait(fixtureWindow('walking', 2)).confidence, 0);
});

test('cadence outside the walking band does not read as walking', () => {
  const slow = fixtureWindow('walking').map((f) => ({
    ...f,
    gait: { ...f.gait, cadenceHz: CADENCE_BAND_HZ.min - 0.5 },
  }));
  assert.notEqual(classifyGait(slow).state, 'walking');
});

test('hysteresis: one boundary window cannot flip the state', () => {
  const classifier = createGaitClassifier();
  for (let i = 0; i < 3; i += 1) classifier.update(fixtureWindow('walking'));
  assert.equal(classifier.update(fixtureWindow('walking')).state, 'walking');
  // One anomalous window — the state must hold.
  assert.equal(classifier.update(fixtureWindow('carried')).state, 'walking');
  // Return to walking resets the candidate; still walking.
  assert.equal(classifier.update(fixtureWindow('walking')).state, 'walking');
  // A sustained change (dwell consecutive windows) does switch.
  let result = null;
  for (let i = 0; i < HYSTERESIS_DWELL; i += 1) result = classifier.update(fixtureWindow('carried'));
  assert.equal(result.state, 'carried');
});

test('no chatter across an alternating boundary sequence', () => {
  const classifier = createGaitClassifier();
  for (let i = 0; i < 4; i += 1) classifier.update(fixtureWindow('walking'));
  const states = [];
  for (let i = 0; i < 10; i += 1) {
    const kind = i % 2 === 0 ? 'carried' : 'walking';
    states.push(classifier.update(fixtureWindow(kind)).state);
  }
  // Alternating single windows never accumulate the dwell — state never flips.
  assert.deepEqual([...new Set(states)], ['walking']);
});
