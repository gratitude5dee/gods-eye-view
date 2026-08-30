/**
 * MuJoCo sim2sim G1 provider — reads a JSON Lines RobotFrame stream produced by
 * a `play_g1_joystick.py` rollout (see mujoco_playground
 * `experimental/sim2sim/robotframe_exporter.py`) and hands validated canonical
 * frames to the bridge.
 *
 * Two local transports, both inbound-only — this provider never sends anything
 * back to the sim, and the bridge has no outbound control path at all:
 *
 *   stdin   (default) pipe the rollout straight in:
 *             python3 -m ...play_g1_joystick --telemetry stdout \
 *               | GEV_ROBOT_INGEST_TOKEN=… node tools/robot-bridge/bridge.mjs \
 *                   --provider mujoco-g1
 *   socket  the provider LISTENS and the sim connects, so the rollout can be
 *           restarted without restarting the bridge:
 *             node tools/robot-bridge/bridge.mjs --provider mujoco-g1 \
 *               --socket /tmp/gev-g1.sock            # or --socket 127.0.0.1:8765
 *
 * Frames are validated with `validateRobotFrame` before delivery and decimated
 * to `--rate` Hz, because the joystick controller steps at 50 Hz while the relay
 * ring only keeps 600 frames per robot.
 *
 * Provenance defaults to `live-g1` (this is the sim2sim *deploy* seam: the same
 * ONNX policy that runs on hardware). Pass `--provenance synthetic` to label a
 * pure sim rollout as SIMULATED in the UI instead.
 *
 * @module tools/robot-bridge/providers/mujoco-g1
 */

import net from 'node:net';
import fs from 'node:fs';
import process from 'node:process';
import { validateRobotFrame, PROVENANCE_LABELS } from '../../../src/data/robotFrame.js';
import { createLineReader, mujocoFrameFromRecord } from '../../../src/data/mujocoTelemetry.js';

/** Parse `--socket` into a net listen target. `host:port` or a unix path. */
export function parseSocketTarget(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null;
  const value = spec.trim();
  const match = /^(?:(\[[^\]]+\]|[^:]+):)?(\d{1,5})$/.exec(value);
  if (match) {
    const port = Number(match[2]);
    if (port < 1 || port > 65535) return null;
    const rawHost = match[1] ?? '127.0.0.1';
    const host = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
    return { kind: 'tcp', host, port };
  }
  return { kind: 'unix', path: value };
}

/**
 * @param {{id?: string, rateHz?: number, socket?: string, provenance?: string,
 *   confidence?: number, datum?: string, fixSource?: string,
 *   stdin?: import('node:stream').Readable}} [options]
 */
export function createProvider({
  id = 'g1-01',
  rateHz = 10,
  socket = null,
  provenance = 'live-g1',
  confidence = 0.9,
  datum = 'wgs84-ellipsoid',
  fixSource = 'fused',
  stdin = process.stdin,
} = {}) {
  if (!PROVENANCE_LABELS[provenance]) {
    throw new Error(`unknown provenance '${provenance}'`);
  }
  const target = socket ? parseSocketTarget(socket) : null;
  if (socket && !target) throw new Error(`unparseable --socket '${socket}'`);
  // CLI flags arrive as strings; a string confidence would fail validation on
  // every single frame, which is a miserable way to learn about a typo.
  const conf = Number(confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
    throw new Error(`--confidence must be within [0, 1]; received '${confidence}'`);
  }
  const rate = Number(rateHz);
  const minIntervalMs = Number.isFinite(rate) && rate > 0 ? 1000 / rate : 0;

  let onFrame = null;
  let server = null;
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  let attachedStdin = null;
  let lastFrameAt = null;
  let lastDeliveredAt = 0;
  let error = null;
  const counts = { accepted: 0, rejected: 0, decimated: 0, unparseable: 0, connections: 0 };

  /** Normalize, validate and (rate permitting) deliver one JSON Line. */
  function handleLine(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      counts.unparseable += 1;
      return;
    }
    const built = mujocoFrameFromRecord(record, {
      id, provenance, confidence: conf, datum, fixSource,
    });
    if (!built.ok) {
      counts.rejected += 1;
      error = built.error;
      return;
    }
    const check = validateRobotFrame(built.frame);
    if (!check.ok) {
      counts.rejected += 1;
      error = check.error;
      return;
    }
    counts.accepted += 1;
    lastFrameAt = built.frame.t;
    // Decimate AFTER validating, so a sim emitting garbage is visible in
    // getStatus() even when most of its frames would be dropped anyway.
    const now = Date.now();
    if (minIntervalMs && now - lastDeliveredAt < minIntervalMs) {
      counts.decimated += 1;
      return;
    }
    lastDeliveredAt = now;
    error = null;
    onFrame?.(built.frame);
  }

  /** Wire a readable stream of JSON Lines into the frame path. */
  function attach(stream) {
    const reader = createLineReader();
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const { lines, overflow } = reader.push(chunk);
      if (overflow) {
        counts.unparseable += 1;
        error = `dropped ${overflow} bytes without a newline`;
      }
      for (const line of lines) handleLine(line);
    });
    stream.on('error', (err) => { error = err?.message || String(err); });
  }

  return {
    id: 'mujoco-g1',

    async start(callback) {
      onFrame = callback;
      if (!target) {
        if (attachedStdin) return;
        attachedStdin = stdin;
        attach(stdin);
        stdin.resume?.();
        return;
      }
      if (server) return;
      // A stale unix socket from a killed bridge would make listen() fail with
      // EADDRINUSE forever; only remove it when nothing is listening.
      if (target.kind === 'unix' && fs.existsSync(target.path)) {
        await new Promise((resolve) => {
          const probe = net.connect(target.path);
          probe.once('connect', () => { probe.destroy(); resolve(); });
          probe.once('error', () => {
            try { fs.unlinkSync(target.path); } catch { /* already gone */ }
            resolve();
          });
        });
      }
      server = net.createServer((connection) => {
        counts.connections += 1;
        sockets.add(connection);
        connection.on('close', () => sockets.delete(connection));
        attach(connection);
      });
      server.on('error', (err) => { error = err?.message || String(err); });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        const listening = () => resolve();
        if (target.kind === 'unix') server.listen(target.path, listening);
        else server.listen(target.port, target.host, listening);
      });
    },

    async stop() {
      onFrame = null;
      for (const connection of sockets) connection.destroy();
      sockets.clear();
      if (attachedStdin) {
        attachedStdin.removeAllListeners('data');
        attachedStdin.pause?.();
        attachedStdin = null;
      }
      if (server) {
        await new Promise((resolve) => server.close(() => resolve()));
        if (target?.kind === 'unix') {
          try { fs.unlinkSync(target.path); } catch { /* already gone */ }
        }
        server = null;
      }
    },

    getStatus() {
      const ageMs = lastFrameAt ? Date.now() - lastFrameAt : Infinity;
      const attached = Boolean(server || attachedStdin);
      return {
        status: !attached ? 'down' : (ageMs > 3000 ? 'stale' : 'live'),
        lastFrameAt,
        error,
        source: target ? `${target.kind}:${target.path ?? `${target.host}:${target.port}`}` : 'stdin',
        ...counts,
      };
    },

    /** Test seam: push one JSON Line through the full frame path. */
    _handleLine: handleLine,
  };
}
