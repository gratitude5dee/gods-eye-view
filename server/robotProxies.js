/**
 * Robot telemetry relay — `/api/robot/*`.
 *
 * A small in-memory ring-buffer relay between the robot bridge
 * (tools/robot-bridge) and the ground-robots layer:
 *
 *   POST /api/robot/ingest     bridge → server (token-gated, batched frames)
 *   GET  /api/robot/telemetry  polling snapshot (latest frame per robot)
 *   GET  /api/robot/stream     SSE push of accepted frames
 *
 * `POST /api/robot/command` (P4 outbound control) and `GET /api/robot/map`
 * (P2 SLAM occupancy) are reserved: command returns 501 unless
 * GEV_ROBOT_COMMANDS is explicitly enabled (it never is in this build).
 *
 * State lives in the plugin closure, so the relay requires a persistent
 * server process. On serverless runtimes (no cross-request state) every
 * endpoint answers 503 `{ status: 'unsupported' }` unless GEV_ROBOT_RELAY_URL
 * names an external relay to advertise instead.
 *
 * Env (all read lazily, per request — .env loads after module import):
 *   GEV_ROBOT_INGEST_TOKEN       required shared secret for ingest
 *   GEV_RATELIMIT_ROBOT_PER_MIN  opt-in ingest rate limit
 *   GEV_ROBOT_RELAY_URL          external relay advertised on serverless
 *   GEV_ROBOT_SOURCE=synthetic   dev convenience: feed the deterministic
 *                                synthetic walker in-process (no bridge)
 *
 * @module server/robotProxies
 */

import {
  MAX_FRAMES_PER_ROBOT,
  MAX_ROBOTS,
  validateRobotFrameBatch,
} from '../src/data/robotFrame.js';
import { clientKey, isServerlessRuntime } from './proxies.js';

const INGEST_BODY_CAP_BYTES = 256 * 1024;
const SSE_RETRY_MS = 3000;

/** Read a request body with a hard byte cap (mirrors server/proxies.js). */
async function readBodyCapped(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Opt-in fixed-window per-client rate limiter; null = unlimited. */
function makeRobotRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null;
  const windows = new Map();
  return (key) => {
    const now = Date.now();
    const slot = Math.floor(now / 60_000);
    const entry = windows.get(key);
    if (!entry || entry.slot !== slot) {
      windows.set(key, { slot, count: 1 });
      if (windows.size > 4096) windows.clear();
      return true;
    }
    entry.count += 1;
    return entry.count <= Math.floor(max);
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function unsupportedPayload() {
  const relayUrl = process.env.GEV_ROBOT_RELAY_URL || null;
  return {
    status: 'unsupported',
    reason: 'robot relay requires a persistent server process',
    relayUrl,
  };
}

/**
 * Vite plugin exposing the robot telemetry relay in dev and preview servers,
 * and (via server/app.js) the serverless dispatcher, where it degrades to the
 * 503 `unsupported` contract.
 * @returns {import('vite').Plugin}
 */
export function robotTelemetryProxy() {
  /** @type {Map<string, object[]>} robotId -> frame ring buffer (oldest first) */
  const rings = new Map();
  /** @type {Set<import('http').ServerResponse>} */
  const sseClients = new Set();
  /** undefined = not built; null = unlimited; fn = limiter */
  let rateLimiter;

  function acceptFrames(frames) {
    for (const frame of frames) {
      let ring = rings.get(frame.id);
      if (!ring) {
        if (rings.size >= MAX_ROBOTS) return { ok: false, error: 'robot cap reached' };
        ring = [];
        rings.set(frame.id, ring);
      }
      ring.push(frame);
      while (ring.length > MAX_FRAMES_PER_ROBOT) ring.shift();
    }
    if (sseClients.size) {
      const data = `data: ${JSON.stringify({ frames })}\n\n`;
      for (const client of sseClients) {
        try { client.write(data); } catch { sseClients.delete(client); }
      }
    }
    return { ok: true };
  }

  function handleIngest(req, res) {
    const token = process.env.GEV_ROBOT_INGEST_TOKEN;
    if (!token) {
      sendJson(res, 503, { error: 'GEV_ROBOT_INGEST_TOKEN not configured' });
      return;
    }
    const presented = req.headers['x-gev-robot-token'];
    if (presented !== token) {
      sendJson(res, 401, { error: 'invalid ingest token' });
      return;
    }
    if (rateLimiter === undefined) {
      rateLimiter = makeRobotRateLimiter(process.env.GEV_RATELIMIT_ROBOT_PER_MIN);
    }
    if (rateLimiter && !rateLimiter(clientKey(req))) {
      sendJson(res, 429, { error: 'rate limited' });
      return;
    }
    readBodyCapped(req, INGEST_BODY_CAP_BYTES)
      .then((body) => {
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { error: 'body is not valid JSON' });
          return;
        }
        const batch = Array.isArray(parsed) ? parsed : parsed?.frames;
        const validated = validateRobotFrameBatch(batch);
        if (!validated.ok) {
          sendJson(res, 400, { error: validated.error });
          return;
        }
        const rxMs = Date.now();
        const stamped = validated.frames.map((frame) => ({ ...frame, rx: rxMs }));
        const accepted = acceptFrames(stamped);
        if (!accepted.ok) {
          sendJson(res, 409, { error: accepted.error });
          return;
        }
        sendJson(res, 200, { accepted: stamped.length });
      })
      .catch((err) => {
        if (err?.code === 'BODY_TOO_LARGE') sendJson(res, 413, { error: 'body too large' });
        else sendJson(res, 500, { error: 'ingest failed' });
      });
  }

  function handleTelemetry(res) {
    const robots = [];
    for (const [id, ring] of rings) {
      const latest = ring[ring.length - 1];
      if (latest) robots.push(latest);
      void id;
    }
    sendJson(res, 200, { status: 'ok', serverTime: Date.now(), robots });
  }

  function handleStream(req, res) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  function middleware(req, res, next) {
    const url = String(req.url || '');
    const pathname = url.split('?')[0];
    if (isServerlessRuntime()) {
      sendJson(res, 503, unsupportedPayload());
      return;
    }
    if (pathname === '/ingest' && req.method === 'POST') {
      handleIngest(req, res);
      return;
    }
    if (pathname === '/telemetry' && req.method === 'GET') {
      handleTelemetry(res);
      return;
    }
    if (pathname === '/stream' && req.method === 'GET') {
      handleStream(req, res);
      return;
    }
    if (pathname === '/command') {
      // P4 outbound control is intentionally not implemented. Never enabled
      // silently; requires an explicit future build with human confirmation.
      sendJson(res, 501, { error: 'robot commands are disabled in this build' });
      return;
    }
    if (pathname === '/map') {
      sendJson(res, 501, { error: 'SLAM map relay not implemented (P2)' });
      return;
    }
    next();
  }

  /** @type {{stop: Function}|null} in-process synthetic feed (dev only) */
  let syntheticProvider = null;

  async function startSyntheticFeed() {
    if (syntheticProvider || isServerlessRuntime()) return;
    const { createProvider } = await import('../tools/robot-bridge/providers/synthetic.mjs');
    syntheticProvider = createProvider({});
    await syntheticProvider.start((frame) => {
      acceptFrames([{ ...frame, rx: Date.now() }]);
    });
  }

  const install = (server) => {
    server.middlewares.use('/api/robot', middleware);
    if (process.env.GEV_ROBOT_SOURCE === 'synthetic') {
      startSyntheticFeed().catch((err) => {
        console.error('[robot] synthetic feed failed to start:', err?.message);
      });
      server.httpServer?.on?.('close', () => {
        syntheticProvider?.stop();
        syntheticProvider = null;
      });
    }
  };

  return {
    name: 'gev-robot-telemetry-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
