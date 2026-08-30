/**
 * Deterministic synthetic G1 provider — a seeded virtual walker on the Khumbu
 * route. Emits canonical RobotFrames at a fixed rate with plausible gait,
 * IMU bob, foot forces, and monotonic battery drain, plus scripted slip /
 * comms-dropout / carried segments so downstream consumers can be exercised
 * without hardware. Provenance is always `synthetic` / `SIMULATED`.
 *
 * Deterministic by (seed, tick): the same seed replays the same walk.
 *
 * @module tools/robot-bridge/providers/synthetic
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseRoute,
  transpose,
} from '../../../src/data/robotTransposition.js';

const DEFAULT_ROUTE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../config/routes/khumbu-ebc.json',
);

/** Mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scripted event windows (tick-based at 10 Hz). Deterministic and periodic:
 * a slip every ~90 s, a comms dropout every ~150 s, a carried segment every
 * ~240 s.
 */
function scriptedEvent(tick) {
  if (tick % 900 >= 880 && tick % 900 < 890) return 'slip';
  if (tick % 1500 >= 1450 && tick % 1500 < 1490) return 'dropout';
  if (tick % 2400 >= 2300 && tick % 2400 < 2380) return 'carried';
  return null;
}

/**
 * Create the deterministic synthetic provider.
 * @param {{seed?: number, id?: string, rateHz?: number, routePath?: string,
 *   startSAlongM?: number}} [options]
 */
export function createProvider({
  seed = 5,
  id = 'g1-01',
  rateHz = 10,
  routePath = DEFAULT_ROUTE_PATH,
  startSAlongM = 0,
} = {}) {
  const route = parseRoute(JSON.parse(readFileSync(routePath, 'utf8')));
  const rand = mulberry32(seed);
  const dtSec = 1 / rateHz;

  let timer = null;
  let tick = 0;
  let sAlong = startSAlongM;
  let speedMps = 0;
  let socPct = 100;
  let lastFrameAt = null;
  let error = null;

  function nextFrame(nowMs) {
    const event = scriptedEvent(tick);
    const walking = event !== 'carried';

    // Speed target wanders 0.6–1.4 m/s with a bounded accel of 0.5 m/s².
    const target = 0.6 + 0.8 * (0.5 + 0.5 * Math.sin(tick * 0.003 + rand() * 0.02));
    const maxStep = 0.5 * dtSec;
    speedMps += Math.max(-maxStep, Math.min(maxStep, target - speedMps));
    if (!walking) speedMps = 0;

    const cadenceHz = walking ? 1.6 + 0.4 * (speedMps - 0.6) / 0.8 : 0;
    const strideM = cadenceHz > 0 ? speedMps / cadenceHz : 0;

    const staged = transpose({
      gaitState: walking ? 'walk' : 'stand',
      cadenceHz,
      strideM,
      dtSec,
      route,
      sAlong,
    });
    sAlong = staged.sAlong;

    // Uphill costs more: base drain plus grade-scaled drain, monotonic.
    const gradeCost = Math.max(0, (staged.elevM - 2860) / 2504);
    socPct = Math.max(0, socPct - (0.0004 + 0.0006 * gradeCost) * dtSec * 60);

    const phase = 2 * Math.PI * cadenceHz * tick * dtSec;
    const leftContact = walking ? Math.sin(phase) >= 0 : true;
    const forceBase = walking ? 190 : 230;
    const slipJitter = event === 'slip' ? 120 * (rand() - 0.5) : 0;

    tick += 1;
    return {
      v: 1,
      id,
      t: nowMs,
      pose: {
        lat: staged.lat,
        lon: staged.lon,
        altM: staged.elevM,
        headingDeg: staged.headingDeg,
        pitchDeg: event === 'slip' ? 6 * (rand() - 0.5) : 0,
        rollDeg: event === 'slip' ? 8 * (rand() - 0.5) : 0,
      },
      datum: 'egm96-orthometric',
      fix: { source: 'fused', hAccM: 1.5, vAccM: 2.5, sats: 12 },
      vel: {
        speedMps,
        courseDeg: staged.headingDeg,
        vzMps: 0,
        yawRateDps: 0,
      },
      imu: {
        ax: 0,
        ay: 0,
        az: 9.81 + (walking ? 0.6 * Math.sin(2 * phase) : 0) + (event === 'slip' ? 3 * (rand() - 0.5) : 0),
        gx: 0, gy: 0, gz: 0,
        qw: 1, qx: 0, qy: 0, qz: 0,
      },
      gait: {
        fsm: walking ? 'walk' : 'stand',
        footForce: [
          leftContact ? forceBase + 40 * Math.sin(phase) + slipJitter : 15,
          leftContact ? 15 : forceBase - 40 * Math.sin(phase) + slipJitter,
        ],
        contact: [leftContact, !leftContact || !walking],
        cadenceHz,
        strideM,
      },
      power: {
        soc: Math.round(socPct * 10) / 10,
        voltV: 48 + 6 * (socPct / 100),
        currentA: walking ? 4 + 2 * gradeCost : 1.2,
        wattsInst: walking ? 220 + 120 * gradeCost : 60,
        tempC: 34 + 8 * (1 - socPct / 100),
      },
      health: {
        estop: false,
        commsRttMs: event === 'dropout' ? 2500 : 40 + Math.round(20 * rand()),
        linkRssiDbm: event === 'dropout' ? -92 : -58,
        motorErrors: [],
      },
      event,
      transposed: true,
      provenance: { source: 'synthetic', label: 'SIMULATED', confidence: 1.0 },
    };
  }

  return {
    id: 'synthetic',

    async start(onFrame) {
      if (timer) return;
      timer = setInterval(() => {
        const frame = nextFrame(Date.now());
        lastFrameAt = frame.t;
        // A comms dropout suppresses delivery, not generation — the walk
        // continues while the link is down, like the real gantry lab.
        if (frame.event !== 'dropout') onFrame(frame);
      }, 1000 / rateHz);
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    getStatus() {
      const ageMs = lastFrameAt ? Date.now() - lastFrameAt : Infinity;
      return {
        status: !timer ? 'down' : (ageMs > 3000 ? 'stale' : 'live'),
        lastFrameAt,
        error,
      };
    },

    /** Test seam: generate one frame deterministically without the timer. */
    _nextFrame: nextFrame,
  };
}
