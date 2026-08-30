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
 * Camera contract: the chase engages through ROBOT_CHASE_REQUEST_EVENT so
 * ui.js claims camera ownership; stop releases it via the provided callback.
 *
 * @module robotDemo
 */

import routeJson from '../config/routes/khumbu-ebc.json';
import { parseRoute } from './data/robotTransposition.js';
import { createSyntheticWalker } from './data/robotSyntheticWalker.js';
import groundRobotsLayer, { ROBOT_CHASE_REQUEST_EVENT } from './data/groundRobots.js';
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
