/**
 * Robot demo mode — one-button, in-browser G1 demo.
 *
 * "G1 DEMO" (top-center actions) enables the ground-robots layer, runs the
 * deterministic synthetic walker locally at 10 Hz (no bridge or relay
 * process needed, so it also works on static/serverless deploys), streams
 * the frames into the layer, engages the third-person chase camera, and
 * shows a live telemetry panel (provenance, gait, pose, IMU, power, comms,
 * route progress). Provenance stays exactly `SIMULATED` — demo data is never
 * presented as live hardware.
 *
 * "DISASTER RECON" replays a recorded ABot-Recon reconstruction instead:
 * `initReconDemo` loads the exported cloud into the recon-cloud layer and walks
 * the marker along `camera_poses.npy`, revealing the cloud as it goes. The
 * geometry is real and the geography is chosen, so it stays
 * `SIMULATED · VIRTUAL TRANSPOSITION`.
 *
 * Camera contract: the chase engages through ROBOT_CHASE_REQUEST_EVENT so
 * ui.js claims camera ownership; stop releases it via the provided callback.
 *
 * @module robotDemo
 */

import routeJson from '../config/routes/khumbu-ebc.json';
import reconAnchor from '../config/recon/g1-anchor.json';
import { parseRoute } from './data/robotTransposition.js';
import { createSyntheticWalker } from './data/robotSyntheticWalker.js';
import { createReconstructionReplay } from './data/reconstructionReplay.js';
import groundRobotsLayer, { ROBOT_CHASE_REQUEST_EVENT } from './data/groundRobots.js';
import reconstructionCloudLayer from './data/reconstructionCloud.js';
import { provenanceChip } from './data/robotFrame.js';

const DEMO_ROBOT_ID = 'g1-01';
const RATE_HZ = 10;
/** Start partway up the route so terrain relief is visible immediately. */
const START_S_ALONG_M = 12_000;
/** Frames accepted before the chase camera engages (position needs 2 fixes). */
const CHASE_AFTER_FRAMES = 12;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function metricRow(panelBody, label) {
  const row = el('div', 'robot-demo-row');
  row.appendChild(el('span', 'robot-demo-key', label));
  const value = el('span', 'robot-demo-value', '—');
  row.appendChild(value);
  panelBody.appendChild(row);
  return value;
}

/**
 * Install the demo button + telemetry panel.
 * @param {{setLayerEnabled: (layerId: string, enabled: boolean) => Promise<unknown>,
 *   releaseChase: () => void}} hooks - ui.js integration points.
 * @returns {{stop: () => void, destroy: () => void, isRunning: () => boolean}}
 */
export function initRobotDemo({ setLayerEnabled, releaseChase }) {
  const actions = document.getElementById('top-center-actions');
  if (!actions) return { stop: () => {}, destroy: () => {}, isRunning: () => false };

  const button = el('button', 'robot-demo-btn');
  button.id = 'robot-demo-btn';
  button.type = 'button';
  button.title = 'Run the synthetic G1 Khumbu demo (SIMULATED telemetry)';
  button.setAttribute('aria-label', 'Start robot demo');
  button.textContent = '▶ G1 DEMO';
  actions.appendChild(button);

  const panel = el('aside', 'robot-demo-panel');
  panel.id = 'robot-demo-panel';
  panel.hidden = true;
  const header = el('div', 'robot-demo-header');
  header.appendChild(el('span', 'robot-demo-title', 'G1 TELEMETRY'));
  const chipEl = el('span', 'robot-demo-chip', 'SIMULATED');
  header.appendChild(chipEl);
  panel.appendChild(header);
  const body = el('div', 'robot-demo-body');
  panel.appendChild(body);
  const fields = {
    robot: metricRow(body, 'ROBOT'),
    gait: metricRow(body, 'GAIT'),
    speed: metricRow(body, 'SPEED'),
    position: metricRow(body, 'POSITION'),
    altitude: metricRow(body, 'ALTITUDE'),
    battery: metricRow(body, 'BATTERY'),
    power: metricRow(body, 'POWER'),
    imu: metricRow(body, 'IMU aZ'),
    comms: metricRow(body, 'COMMS'),
    route: metricRow(body, 'ROUTE'),
    frames: metricRow(body, 'FRAMES'),
  };
  const routeBar = el('div', 'robot-demo-progress');
  const routeFill = el('div', 'robot-demo-progress-fill');
  routeBar.appendChild(routeFill);
  panel.appendChild(routeBar);
  const footer = el('div', 'robot-demo-footer',
    'VIRTUAL TRANSPOSITION — Khumbu / Everest Base Camp route');
  panel.appendChild(footer);
  document.body.appendChild(panel);

  const route = parseRoute(routeJson);
  let timer = null;
  let walker = null;
  let frameCount = 0;
  let chaseRequested = false;
  let disposed = false;
  /** Invalidates a pending start when stop/destroy runs during its await. */
  let startGeneration = 0;

  function renderPanel(frame) {
    chipEl.textContent = provenanceChip(frame);
    fields.robot.textContent = frame.id.toUpperCase();
    const cadence = frame.gait?.cadenceHz ? ` · ${frame.gait.cadenceHz.toFixed(1)} Hz` : '';
    fields.gait.textContent = `${frame.gait?.fsm || 'unknown'}${cadence}`;
    fields.speed.textContent = `${(frame.vel?.speedMps ?? 0).toFixed(2)} m/s`;
    fields.position.textContent = `${frame.pose.lat.toFixed(5)}, ${frame.pose.lon.toFixed(5)}`;
    fields.altitude.textContent = `${Math.round(frame.pose.altM)} m (${frame.datum})`;
    fields.battery.textContent = `${frame.power.soc.toFixed(1)}% · ${Math.round(frame.power.tempC)}°C`;
    fields.power.textContent = `${Math.round(frame.power.wattsInst)} W · ${frame.power.voltV.toFixed(1)} V`;
    fields.imu.textContent = `${frame.imu.az.toFixed(2)} m/s²`;
    fields.comms.textContent = frame.event === 'dropout'
      ? `DROPOUT · ${frame.health.commsRttMs} ms`
      : `${frame.health.commsRttMs} ms · ${frame.health.linkRssiDbm} dBm`;
    fields.comms.classList.toggle('robot-demo-warn', frame.event === 'dropout');
    const { sAlongM, routeLengthM } = walker.progress();
    const pct = routeLengthM > 0 ? (100 * sAlongM) / routeLengthM : 0;
    fields.route.textContent = `${(sAlongM / 1000).toFixed(2)} / ${(routeLengthM / 1000).toFixed(1)} km`;
    routeFill.style.width = `${Math.min(100, pct).toFixed(2)}%`;
    fields.frames.textContent = `${frameCount} @ ${RATE_HZ} Hz`;
  }

  function tick() {
    const frame = walker.nextFrame(Date.now());
    // A comms dropout suppresses delivery, not generation — the walk
    // continues while the link is down, like the real gantry lab.
    if (frame.event !== 'dropout') {
      if (groundRobotsLayer.ingestLocalFrames([frame])) frameCount += 1;
    }
    renderPanel(frame);
    if (!chaseRequested && frameCount >= CHASE_AFTER_FRAMES) {
      chaseRequested = true;
      groundRobotsLayer.selectById(DEMO_ROBOT_ID);
      window.dispatchEvent(new CustomEvent(ROBOT_CHASE_REQUEST_EVENT, {
        detail: { robotId: DEMO_ROBOT_ID },
      }));
    }
  }

  async function start() {
    if (timer || disposed) return;
    const generation = ++startGeneration;
    button.disabled = true;
    let enabled;
    try {
      enabled = await setLayerEnabled('ground-robots', true);
    } catch {
      enabled = false;
    } finally {
      if (!disposed) button.disabled = false;
    }
    // A refused enable (visibility guard, layer error) or a stop/destroy
    // during the await means no demo: leave the idle button state untouched.
    if (enabled === false || disposed || generation !== startGeneration || timer) return;
    walker = createSyntheticWalker({
      route,
      seed: 5,
      id: DEMO_ROBOT_ID,
      rateHz: RATE_HZ,
      startSAlongM: START_S_ALONG_M,
    });
    frameCount = 0;
    chaseRequested = false;
    timer = setInterval(tick, 1000 / RATE_HZ);
    panel.hidden = false;
    button.textContent = '■ STOP DEMO';
    button.classList.add('active');
    button.setAttribute('aria-label', 'Stop robot demo');
  }

  function stop() {
    startGeneration += 1;
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    walker = null;
    panel.hidden = true;
    button.textContent = '▶ G1 DEMO';
    button.classList.remove('active');
    button.setAttribute('aria-label', 'Start robot demo');
    releaseChase();
  }

  button.addEventListener('click', () => {
    if (timer) stop();
    else void start();
  });

  return {
    stop,
    destroy() {
      disposed = true;
      stop();
      button.remove();
      panel.remove();
    },
    isRunning: () => timer !== null,
  };
}

/** Poses consumed per second of replay — a walkable playback rate. */
const RECON_POSE_HZ = 6;
/** Replay frames accepted before the chase camera engages. */
const RECON_CHASE_AFTER_FRAMES = 8;

/**
 * Install the "DISASTER RECON" pill: replay an exported ABot-Recon
 * reconstruction (point cloud + camera trajectory) on the globe.
 *
 * The assets are static files (`public/recon/`), so a deploy without them
 * simply reports that nothing is published instead of failing the button.
 *
 * @param {{setLayerEnabled: (layerId: string, enabled: boolean) => Promise<unknown>,
 *   releaseChase: () => void}} hooks - ui.js integration points.
 * @param {{layer?: object, anchor?: object}} [overrides] - Test seams.
 * @returns {{stop: () => void, destroy: () => void, isRunning: () => boolean}}
 */
export function initReconDemo({ setLayerEnabled, releaseChase }, overrides = {}) {
  const actions = document.getElementById('top-center-actions');
  if (!actions) return { stop: () => {}, destroy: () => {}, isRunning: () => false };
  const layer = overrides.layer || reconstructionCloudLayer;
  const anchor = overrides.anchor || reconAnchor;

  const button = el('button', 'robot-demo-btn');
  button.id = 'recon-demo-btn';
  button.type = 'button';
  button.title = 'Replay a recorded ABot-Recon reconstruction (SIMULATED · VIRTUAL TRANSPOSITION)';
  button.setAttribute('aria-label', 'Start disaster recon replay');
  button.textContent = '▶ DISASTER RECON';
  actions.appendChild(button);

  const panel = el('aside', 'robot-demo-panel');
  panel.id = 'recon-demo-panel';
  panel.hidden = true;
  const header = el('div', 'robot-demo-header');
  header.appendChild(el('span', 'robot-demo-title', 'RECONSTRUCTION'));
  const chipEl = el('span', 'robot-demo-chip', 'SIMULATED · VIRTUAL TRANSPOSITION');
  header.appendChild(chipEl);
  panel.appendChild(header);
  const body = el('div', 'robot-demo-body');
  panel.appendChild(body);
  const fields = {
    status: metricRow(body, 'STATUS'),
    points: metricRow(body, 'POINTS'),
    poses: metricRow(body, 'POSES'),
    position: metricRow(body, 'POSITION'),
    heading: metricRow(body, 'HEADING'),
  };
  const progressBar = el('div', 'robot-demo-progress');
  const progressFill = el('div', 'robot-demo-progress-fill');
  progressBar.appendChild(progressFill);
  panel.appendChild(progressBar);
  panel.appendChild(el('div', 'robot-demo-footer',
    `RECORDED RECONSTRUCTION — replayed at ${anchor.name || 'anchor'}`));
  document.body.appendChild(panel);

  let timer = null;
  let replay = null;
  let frameCount = 0;
  let chaseRequested = false;
  let disposed = false;
  let startGeneration = 0;

  function showIdle() {
    button.textContent = '▶ DISASTER RECON';
    button.classList.remove('active');
    button.setAttribute('aria-label', 'Start disaster recon replay');
  }

  function tick() {
    const frame = replay.nextFrame(Date.now());
    const { index, poseCount, fraction } = replay.progress();
    if (frame) {
      if (groundRobotsLayer.ingestLocalFrames([frame])) frameCount += 1;
      fields.position.textContent = `${frame.pose.lat.toFixed(6)}, ${frame.pose.lon.toFixed(6)}`;
      fields.heading.textContent = `${Math.round(frame.pose.headingDeg)}°`;
      chipEl.textContent = provenanceChip(frame);
    }
    fields.poses.textContent = `${index + 1} / ${poseCount}`;
    fields.points.textContent = `${layer.setRevealFraction(fraction).toLocaleString()} shown`;
    progressFill.style.width = `${(100 * fraction).toFixed(2)}%`;
    if (!chaseRequested && frameCount >= RECON_CHASE_AFTER_FRAMES) {
      chaseRequested = true;
      groundRobotsLayer.selectById(DEMO_ROBOT_ID);
      window.dispatchEvent(new CustomEvent(ROBOT_CHASE_REQUEST_EVENT, {
        detail: { robotId: DEMO_ROBOT_ID },
      }));
    }
    // A finished replay holds its last pose and the full cloud: the walk is
    // over, but the reconstruction it produced is the point of the demo.
    if (replay.isComplete() && !frame) {
      clearInterval(timer);
      timer = null;
      fields.status.textContent = 'REPLAY COMPLETE';
      showIdle();
    }
  }

  async function start() {
    if (timer || disposed) return;
    const generation = ++startGeneration;
    button.disabled = true;
    panel.hidden = false;
    fields.status.textContent = 'LOADING RECONSTRUCTION';
    let waypoints = [];
    try {
      layer.setSource({
        anchor,
        plyUrl: anchor.plyUrl,
        posesUrl: anchor.posesUrl,
      });
      if (await setLayerEnabled('recon-cloud', true) === false) {
        throw new Error('reconstruction layer refused to enable');
      }
      const loaded = await layer.load();
      waypoints = layer.getWaypoints();
      fields.points.textContent = `${loaded.count.toLocaleString()} of ${layer.getStats().totalVertices.toLocaleString()}`;
    } catch (error) {
      fields.status.textContent = 'NO RECONSTRUCTION PUBLISHED';
      fields.points.textContent = String(error?.message || error).slice(0, 80);
      button.disabled = false;
      showIdle();
      // A refused disable is not worth surfacing, but an unhandled rejection is.
      await Promise.resolve(setLayerEnabled('recon-cloud', false)).catch(() => {});
      return;
    } finally {
      if (!disposed) button.disabled = false;
    }
    if (disposed || generation !== startGeneration || timer) return;
    if (!waypoints.length) {
      fields.status.textContent = 'NO CAMERA TRAJECTORY';
      showIdle();
      return;
    }
    // A refused robot layer would replay an invisible walker over the cloud, so
    // the cloud stays (it loaded) but the animation does not start.
    let robotsEnabled;
    try {
      robotsEnabled = await setLayerEnabled('ground-robots', true);
    } catch {
      robotsEnabled = false;
    }
    if (disposed || generation !== startGeneration || timer) return;
    if (robotsEnabled === false) {
      fields.status.textContent = 'ROBOT LAYER UNAVAILABLE';
      showIdle();
      return;
    }
    replay = createReconstructionReplay({
      waypoints,
      id: DEMO_ROBOT_ID,
      poseHz: RECON_POSE_HZ,
    });
    frameCount = 0;
    chaseRequested = false;
    layer.setRevealFraction(0);
    fields.status.textContent = 'REPLAYING';
    timer = setInterval(tick, 1000 / RATE_HZ);
    button.textContent = '■ STOP RECON';
    button.classList.add('active');
    button.setAttribute('aria-label', 'Stop disaster recon replay');
  }

  function stop() {
    startGeneration += 1;
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    replay = null;
    // The cloud stays: it is the recorded artifact, not the animation.
    layer.setRevealFraction(1);
    fields.status.textContent = 'STOPPED';
    showIdle();
    releaseChase();
  }

  button.addEventListener('click', () => {
    if (timer) stop();
    else void start();
  });

  return {
    stop,
    destroy() {
      disposed = true;
      stop();
      button.remove();
      panel.remove();
    },
    isRunning: () => timer !== null,
  };
}
