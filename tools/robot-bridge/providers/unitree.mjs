/**
 * Unitree G1 live provider — tails the pose file written by the off-board
 * ABot-Recon rolling-window streamer and hands validated LIVE RobotFrames to
 * the bridge.
 *
 * ABot-Recon's `infer()` runs one full causal pass per call — it is not an
 * incremental generator — so "live" means: a Python process (ABot-Recon
 * `scripts/stream_reconstruction.py`) reconstructs rolling clip windows and
 * atomically rewrites `pose_latest.json` plus chunked point batches in a watch
 * directory. This provider polls that file (rename-atomic writes make a poll
 * race-free) and emits one frame per new `seq`. Point batches are NOT shipped
 * through the bridge — `/api/robot/ingest` caps a body at 256 KB — they are
 * loaded directly by the reconstruction layer; only their arrival is counted
 * in `getStatus()`.
 *
 * Read-only by construction: nothing here can reach the robot at all — the
 * only input is a directory of files, and no controller is ever registered.
 *
 * Usage:
 *   GEV_ROBOT_INGEST_TOKEN=secret node tools/robot-bridge/bridge.mjs \
 *     --provider unitree --watch outputs/g1-live \
 *     --anchor config/recon/g1-anchor.json \
 *     --ingest http://<gev-host>:5173/api/robot/ingest
 *
 * @module tools/robot-bridge/providers/unitree
 */

import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { validateRobotFrame } from '../../../src/data/robotFrame.js';
import { normalizeAnchor } from '../../../src/data/reconstructionAnchor.js';
import { unitreeFrameFromRecord } from '../../../src/data/unitreeTelemetry.js';

const POSE_FILENAME = 'pose_latest.json';

/**
 * @param {{id?: string, rateHz?: number, watch?: string, anchor?: string,
 *   confidence?: number}} [options] - `anchor` is a path to the same anchor
 *   JSON the DISASTER RECON demo uses (lat/lon/headingDeg/elevM).
 */
export function createProvider({
  id = 'g1-01',
  rateHz = 10,
  watch = 'outputs/g1-live',
  anchor = 'config/recon/g1-anchor.json',
  confidence = 0.9,
} = {}) {
  // Fail at startup, not per-frame: a bad anchor file means every frame would
  // be rejected, which is a miserable way to learn about a typo.
  const anchorSpec = normalizeAnchor(JSON.parse(readFileSync(anchor, 'utf8')));
  const conf = Number(confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
    throw new Error(`--confidence must be within [0, 1]; received '${confidence}'`);
  }
  const rate = Number(rateHz);
  const intervalMs = Number.isFinite(rate) && rate > 0 ? 1000 / rate : 100;
  const posePath = path.join(watch, POSE_FILENAME);

  let onFrame = null;
  let timer = null;
  let inFlight = null;
  let lastSeq = null;
  let lastFrameAt = null;
  let previous = null;
  let lastBatch = null;
  let error = null;
  const counts = { accepted: 0, rejected: 0, unchanged: 0, unreadable: 0 };

  /** One poll: read the pose file and deliver if the streamer moved on.
   * A slow read must not stack polls behind it, so concurrent callers join
   * the poll already in flight. */
  function poll() {
    if (inFlight) return inFlight;
    inFlight = pollOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function pollOnce() {
    let record;
    try {
      record = JSON.parse(await fs.readFile(posePath, 'utf8'));
    } catch (err) {
      // Absent until the streamer's first window completes; unreadable is
      // normal startup, not an error worth latching.
      counts.unreadable += 1;
      error = err?.code === 'ENOENT' ? null : (err?.message || String(err));
      return;
    }
    if (record?.seq != null && record.seq === lastSeq) {
      counts.unchanged += 1;
      return;
    }
    const built = unitreeFrameFromRecord(record, {
      id, anchor: anchorSpec, confidence: conf, previous,
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
    lastSeq = record.seq ?? null;
    lastFrameAt = built.frame.t;
    lastBatch = typeof record.batch === 'string' ? record.batch : lastBatch;
    previous = { enu: built.enu, t: built.frame.t };
    error = null;
    onFrame?.(built.frame);
  }

  return {
    id: 'unitree',

    async start(callback) {
      onFrame = callback;
      if (timer) return;
      timer = setInterval(poll, intervalMs);
      void poll(); // first frame should not wait a full interval
    },

    async stop() {
      onFrame = null;
      if (timer) clearInterval(timer);
      timer = null;
    },

    getStatus() {
      const ageMs = lastFrameAt ? Date.now() - lastFrameAt : Infinity;
      return {
        status: !timer ? 'down' : (ageMs > 15_000 ? 'stale' : 'live'),
        lastFrameAt,
        error,
        source: posePath,
        lastSeq,
        lastBatch,
        ...counts,
      };
    },

    /** Test seam: run one poll without the timer. */
    _poll: poll,
  };
}
