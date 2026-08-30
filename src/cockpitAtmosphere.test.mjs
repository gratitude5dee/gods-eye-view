import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cockpitAerialPerspective,
  cockpitSunDirection,
  cockpitSunIrradiance,
  solarAirMass,
  solarPositionDeg,
} from './cockpitAtmosphere.js';

test('solar position tracks the sun through a day at a known site', () => {
  // Austin, TX. Local solar noon in June sits near 18:30 UTC, high in the south.
  const noon = solarPositionDeg({
    dateMs: Date.UTC(2025, 5, 21, 18, 30),
    latitude: 30.2672,
    longitude: -97.7431,
  });
  assert.ok(noon.elevationDeg > 78 && noon.elevationDeg <= 90, `elevation ${noon.elevationDeg}`);

  const midnight = solarPositionDeg({
    dateMs: Date.UTC(2025, 5, 21, 6, 30),
    latitude: 30.2672,
    longitude: -97.7431,
  });
  assert.ok(midnight.elevationDeg < -20, `elevation ${midnight.elevationDeg}`);

  const morning = solarPositionDeg({
    dateMs: Date.UTC(2025, 5, 21, 13, 0),
    latitude: 30.2672,
    longitude: -97.7431,
  });
  assert.ok(morning.azimuthDeg > 60 && morning.azimuthDeg < 120, `azimuth ${morning.azimuthDeg}`);
  assert.ok(morning.elevationDeg > 0 && morning.elevationDeg < noon.elevationDeg);
});

test('azimuth and elevation agree on one declination across the day', () => {
  // Inverting the spherical-trig relation sin(dec) = sin(lat)sin(elev)
  // + cos(lat)cos(elev)cos(azimuth) must recover the solstice declination at
  // every hour. A stretched azimuth (mismatched sin/cos normalization) breaks
  // this away from sunrise and sunset.
  const DEG = Math.PI / 180;
  const latitude = 30.2672;
  for (const hourUtc of [13, 15, 18, 21, 23]) {
    const { elevationDeg, azimuthDeg } = solarPositionDeg({
      dateMs: Date.UTC(2025, 5, 21, hourUtc, 0),
      latitude,
      longitude: -97.7431,
    });
    const declination = Math.asin(
      Math.sin(latitude * DEG) * Math.sin(elevationDeg * DEG)
        + Math.cos(latitude * DEG) * Math.cos(elevationDeg * DEG) * Math.cos(azimuthDeg * DEG),
    ) / DEG;
    assert.ok(Math.abs(declination - 23.44) < 0.5,
      `${hourUtc}:00 UTC implies declination ${declination.toFixed(2)}`);
  }
});

test('solar position degrades to a flat sun on unusable inputs', () => {
  assert.deepEqual(
    solarPositionDeg({ dateMs: Number.NaN, latitude: 0, longitude: 0 }),
    { azimuthDeg: 0, elevationDeg: 0 },
  );
});

test('sun direction maps elevation to up and azimuth to the view plane', () => {
  const overhead = cockpitSunDirection(90, 0);
  assert.ok(Math.abs(overhead.y - 1) < 1e-9);
  const ahead = cockpitSunDirection(0, 0);
  assert.ok(Math.abs(ahead.z - 1) < 1e-9);
  const right = cockpitSunDirection(0, 90);
  assert.ok(Math.abs(right.x - 1) < 1e-9);
  const behind = cockpitSunDirection(0, 180);
  assert.ok(behind.z < -0.99);
  const invalid = cockpitSunDirection(Number.NaN, undefined);
  assert.deepEqual(invalid, { x: 0, y: 0, z: 1 });
});

test('air mass grows toward the horizon and stays finite below it', () => {
  assert.ok(Math.abs(solarAirMass(90) - 1) < 0.01);
  assert.ok(solarAirMass(10) > 5 && solarAirMass(10) < 6);
  assert.ok(Number.isFinite(solarAirMass(-30)) && solarAirMass(-30) > solarAirMass(0));
});

test('low sun reddens the direct term while the sky keeps its blue bias', () => {
  const high = cockpitSunIrradiance(80);
  const low = cockpitSunIrradiance(2);
  assert.ok(high.sun[0] > high.sun[2], 'red survives more than blue at any air mass');
  assert.ok(low.sun[0] / Math.max(low.sun[2], 1e-6) > high.sun[0] / high.sun[2]);
  assert.ok(low.intensity < high.intensity);
  assert.ok(high.sky[2] > high.sky[0], 'ambient sky stays blue-weighted');
  for (const channel of [...high.sun, ...high.sky, ...low.sun, ...low.sky]) {
    assert.ok(channel >= 0 && channel <= 1, `channel ${channel} out of range`);
  }
});

test('night keeps a small non-zero ambience instead of a black overlay', () => {
  const night = cockpitSunIrradiance(-25);
  assert.ok(night.intensity > 0 && night.intensity <= 0.05);
  assert.ok(night.sky.every((channel) => channel > 0));
});

test('aerial perspective thins with altitude and never fully disappears', () => {
  const ground = cockpitAerialPerspective(0);
  const cruise = cockpitAerialPerspective(11_000);
  assert.ok(ground.inscatter > cruise.inscatter);
  assert.ok(ground.extinctionScale > cruise.extinctionScale);
  assert.ok(cruise.inscatter > 0);
  assert.ok(cruise.extinctionScale >= 0.55);
  assert.deepEqual(cockpitAerialPerspective(Number.NaN), ground);
});
