import test from 'node:test';
import assert from 'node:assert/strict';
import {
  returnEnergyWh,
  turnBackRadiusM,
  TURN_BACK_PROVENANCE,
  usableEnergyWh,
  weatherFactor,
} from './robotTurnBack.js';

const BATTERY = { socPct: 80, capacityWh: 500, reservePct: 20 };

test('energy is monotonic in distance, ascent, and weather severity', () => {
  const flat1 = returnEnergyWh([{ distM: 1000, riseM: 0 }]);
  const flat2 = returnEnergyWh([{ distM: 2000, riseM: 0 }]);
  assert.ok(flat2 > flat1, 'more distance costs more');

  const climb = returnEnergyWh([{ distM: 1000, riseM: 100 }]);
  assert.ok(climb > flat1, 'ascent costs more than flat');

  const descent = returnEnergyWh([{ distM: 1000, riseM: -100 }]);
  assert.ok(descent > flat1, 'steep descent is a cost, never a regenerative saving');
  assert.ok(climb > descent, 'climbing costs more than descending');

  const windy = returnEnergyWh([{ distM: 1000, riseM: 0 }], { windMps: 15 });
  const wet = returnEnergyWh([{ distM: 1000, riseM: 0 }], { precipitating: true });
  assert.ok(windy > flat1 && wet > flat1, 'weather only raises cost');
});

test('wind penalty saturates instead of growing without bound', () => {
  assert.equal(weatherFactor({ windMps: 500 }), weatherFactor({ windMps: 1000 }));
  assert.ok(weatherFactor({ windMps: 500 }) < 2);
});

test('usable energy respects the reserve margin and clamps at zero', () => {
  assert.equal(usableEnergyWh({ socPct: 80, capacityWh: 500, reservePct: 20 }), 300);
  assert.equal(usableEnergyWh({ socPct: 20, capacityWh: 500, reservePct: 20 }), 0);
  assert.equal(usableEnergyWh({ socPct: 10, capacityWh: 500, reservePct: 20 }), 0);
  assert.equal(usableEnergyWh({}), 0);
});

test('the ring shrinks monotonically as SOC drops', () => {
  let prev = Infinity;
  for (let soc = 100; soc >= 0; soc -= 5) {
    const { radiusM } = turnBackRadiusM({ ...BATTERY, socPct: soc });
    assert.ok(radiusM <= prev, `radius must never grow as soc drops (soc=${soc})`);
    prev = radiusM;
  }
  assert.equal(turnBackRadiusM({ ...BATTERY, socPct: BATTERY.reservePct }).radiusM, 0);
});

test('worse terrain and weather shrink the ring', () => {
  const calm = turnBackRadiusM(BATTERY).radiusM;
  const steep = turnBackRadiusM(BATTERY, { meanGradePct: 15 }).radiusM;
  const storm = turnBackRadiusM(BATTERY, { windMps: 20, precipitating: true }).radiusM;
  assert.ok(steep < calm, 'grade shrinks the ring');
  assert.ok(storm < calm, 'weather shrinks the ring');
});

test('every advisor output is labeled ESTIMATE until calibrated', () => {
  assert.equal(turnBackRadiusM(BATTERY).provenance, TURN_BACK_PROVENANCE);
  assert.equal(TURN_BACK_PROVENANCE, 'ESTIMATE');
});
