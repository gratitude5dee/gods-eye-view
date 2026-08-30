/**
 * Deterministic synthetic G1 provider — a seeded virtual walker on the Khumbu
 * route. Wraps the shared frame generator
 * (src/data/robotSyntheticWalker.js) with route loading from disk and a
 * timer-driven delivery loop. Provenance is always `synthetic` / `SIMULATED`.
 *
 * Deterministic by (seed, tick): the same seed replays the same walk.
 *
 * @module tools/robot-bridge/providers/synthetic
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseRoute } from '../../../src/data/robotTransposition.js';
import { createSyntheticWalker } from '../../../src/data/robotSyntheticWalker.js';

const DEFAULT_ROUTE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../config/routes/khumbu-ebc.json',
);

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
  const walker = createSyntheticWalker({ route, seed, id, rateHz, startSAlongM });

  let timer = null;
  let lastFrameAt = null;
  let error = null;

  return {
    id: 'synthetic',

    async start(onFrame) {
      if (timer) return;
      timer = setInterval(() => {
        const frame = walker.nextFrame(Date.now());
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
    _nextFrame: walker.nextFrame,
  };
}
