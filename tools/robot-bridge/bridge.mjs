#!/usr/bin/env node
/**
 * Robot telemetry bridge — provider-agnostic batching POST client.
 *
 * Collects RobotFrames from a provider (synthetic today; replay/phone/live-g1
 * later) and ships them to the GEV relay at `/api/robot/ingest` in bounded
 * batches with retry + exponential backoff. The web app and server never
 * import robot SDKs; only this standalone tool talks to providers.
 *
 * Usage:
 *   GEV_ROBOT_INGEST_TOKEN=secret node tools/robot-bridge/bridge.mjs \
 *     --provider synthetic --ingest http://localhost:5173/api/robot/ingest \
 *     --seed 5 --rate 10
 *
 * A MuJoCo sim2sim rollout piped in on stdin (see providers/mujoco-g1.mjs):
 *   python3 ...play_g1_joystick.py --telemetry stdout | \
 *     GEV_ROBOT_INGEST_TOKEN=secret node tools/robot-bridge/bridge.mjs \
 *       --provider mujoco-g1 --rate 10
 *
 * @module tools/robot-bridge/bridge
 */

import process from 'node:process';
import { MAX_FRAMES_PER_BATCH } from '../../src/data/robotFrame.js';

const FLUSH_INTERVAL_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const MAX_PENDING_FRAMES = 2000;
/** Shutdown drains pending frames for at most this long before exiting. */
const SHUTDOWN_DRAIN_MS = 10_000;
/** Providers this bridge may load; --provider is not a free module path. */
const KNOWN_PROVIDERS = new Set(['synthetic', 'replay', 'phone', 'mujoco-g1', 'unitree']);

function parseArgs(argv) {
  const args = {
    provider: 'synthetic',
    ingest: 'http://localhost:5173/api/robot/ingest',
    seed: 5,
    rate: 10,
    id: 'g1-01',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    args[key.slice(2)] = value;
    i += 1;
  }
  args.seed = Number(args.seed);
  args.rate = Number(args.rate);
  return args;
}

async function loadProvider(name, options) {
  if (!KNOWN_PROVIDERS.has(name)) {
    throw new Error(`unknown provider '${name}' (expected one of: ${[...KNOWN_PROVIDERS].join(', ')})`);
  }
  const module = await import(`./providers/${name}.mjs`);
  return module.createProvider(options);
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.GEV_ROBOT_INGEST_TOKEN;
  if (!token) {
    console.error('GEV_ROBOT_INGEST_TOKEN is required');
    process.exit(1);
  }

  const provider = await loadProvider(args.provider, {
    // Provider-specific flags (e.g. mujoco-g1's --socket/--provenance) ride
    // through unchanged; providers ignore keys they do not know.
    ...args,
    seed: args.seed,
    rateHz: args.rate,
    id: args.id,
  });

  /** @type {object[]} */
  let pending = [];
  let backoffMs = 0;
  let inFlight = false;
  let sent = 0;

  /** Backoff sleep, clamped to whatever drain budget remains at sleep time. */
  async function backoffSleep(ms, deadline) {
    const budget = deadline === undefined ? ms : Math.min(ms, deadline - Date.now());
    if (budget <= 0) return;
    await new Promise((r) => setTimeout(r, budget));
  }

  /**
   * @param {number} [deadline] - Epoch ms after which this flush must not
   *   wait: the POST is aborted at the deadline and backoff sleeps are
   *   skipped. Used by shutdown so draining cannot outlive its budget.
   */
  async function flush(deadline) {
    if (inFlight || pending.length === 0 || backoffMs < 0) return;
    const remainingMs = deadline === undefined ? Infinity : deadline - Date.now();
    if (remainingMs <= 0) return;
    const batch = pending.slice(0, MAX_FRAMES_PER_BATCH);
    inFlight = true;
    try {
      const res = await fetch(args.ingest, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GEV-Robot-Token': token,
        },
        body: JSON.stringify({ frames: batch }),
        signal: Number.isFinite(remainingMs) ? AbortSignal.timeout(remainingMs) : undefined,
      });
      if (res.ok) {
        pending = pending.slice(batch.length);
        sent += batch.length;
        backoffMs = 0;
      } else if (res.status === 400 || res.status === 401) {
        // Malformed batch or bad token — dropping is safer than retry-looping.
        console.error(`ingest rejected (${res.status}): ${await res.text()}`);
        pending = pending.slice(batch.length);
      } else {
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : 1000);
        console.error(`ingest failed (${res.status}); backing off ${backoffMs} ms`);
        await backoffSleep(backoffMs, deadline);
      }
    } catch (err) {
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : 1000);
      console.error(`ingest unreachable (${err?.message}); backing off ${backoffMs} ms`);
      await backoffSleep(backoffMs, deadline);
    } finally {
      inFlight = false;
    }
  }

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  const statusTimer = setInterval(() => {
    const status = provider.getStatus();
    console.log(`[bridge] provider=${status.status} pending=${pending.length} sent=${sent}`);
  }, 10_000);

  await provider.start((frame) => {
    pending.push(frame);
    while (pending.length > MAX_PENDING_FRAMES) pending.shift();
  });
  console.log(`[bridge] ${args.provider} → ${args.ingest} (seed=${args.seed}, ${args.rate} Hz)`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(flushTimer);
    clearInterval(statusTimer);
    await provider.stop();
    // Drain: wait out any in-flight POST, then flush bounded batches until
    // pending is empty or the deadline passes.
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    while ((inFlight || pending.length > 0) && Date.now() < deadline) {
      await flush(deadline);
      if (inFlight || pending.length > 0) await new Promise((r) => setTimeout(r, 50));
    }
    if (pending.length > 0) {
      console.error(`[bridge] shutdown deadline reached; dropping ${pending.length} frames`);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
