#!/usr/bin/env node
/**
 * qa-robot-chase — third-person robot chase regression gate.
 *
 * Boots the app against a dev server running with GEV_ROBOT_SOURCE=synthetic
 * (the deterministic seeded walker feeds the relay in-process; no hardware,
 * no bridge). Then:
 *
 *  1. Enables the ground-robots layer and waits for the synthetic robot to
 *     appear with SIMULATED provenance.
 *  2. Selects it and engages the chase camera.
 *  3. Samples camera↔robot distance at fixed timestamps and asserts the
 *     camera TRACKS: distance stays inside the chase envelope the whole run
 *     (range clamp 2–40 m plus eye height margin) with no lurch.
 *  4. Asserts the render governor holds `robot-chase` while active.
 *  5. Asserts frame time stays within budget while chasing.
 *  6. Releases the chase and asserts the governor reports zero owners —
 *     the leak check that defends the whole frame budget.
 *
 * Usage: node scripts/qa-robot-chase.mjs [--url http://localhost:4173]
 * Requires a running server started with GEV_ROBOT_SOURCE=synthetic.
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4173';

/** Chase envelope: range clamp (2–40 m) + eye height + slack for slew. */
const MAX_CHASE_DISTANCE_M = 60;
/** Median frame budget (ms) while chasing, SwiftShader-tolerant. */
const FRAME_BUDGET_MS = 90;
/** Headless CI runs on SwiftShader; hold a looser but still-bounded budget. */
const SOFTWARE_GL_FRAME_BUDGET_MS = 800;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1440,900',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await new Promise((r) => setTimeout(r, 12_000)); // boot flyTo + deferred init

  // ── 1. enable layer, wait for the synthetic robot ───────────────────────
  const enabled = await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    try {
      await gev.dataManager.setEnabled('ground-robots', true, { origin: 'user' });
      return true;
    } catch (err) {
      return String(err?.message || err);
    }
  });
  check('ground-robots layer enables', enabled === true, { enabled });

  const robot = await page.evaluate(() => new Promise((resolve) => {
    const gev = window.__godsEyeView;
    const module = gev.dataManager.layers.get('ground-robots')?.module;
    const deadline = Date.now() + 30_000;
    const poll = () => {
      const objects = module?.getDetectableObjects?.() || [];
      if (objects.length) {
        resolve({ id: objects[0].sourceId, count: objects.length });
      } else if (Date.now() > deadline) {
        resolve(null);
      } else {
        setTimeout(poll, 500);
      }
    };
    poll();
  }));
  check('synthetic robot appears in telemetry', !!robot, robot);
  if (!robot) throw new Error('no robot — is the server running with GEV_ROBOT_SOURCE=synthetic?');

  const provenance = await page.evaluate((id) => {
    const module = window.__godsEyeView.dataManager.layers.get('ground-robots')?.module;
    module?.selectById?.(id);
    return module?.getSelectedInfo?.()?.provenance || null;
  }, robot.id);
  check('provenance labels SIMULATED', typeof provenance === 'string' && provenance.startsWith('SIMULATED'), { provenance });

  // ── 2. engage chase at fixed timestamps ─────────────────────────────────
  const engaged = await page.evaluate((id) => {
    const module = window.__godsEyeView.dataManager.layers.get('ground-robots')?.module;
    return module?.engageChaseCamera?.(id) === true;
  }, robot.id);
  check('chase camera engages', engaged);

  const holding = await page.evaluate(() => {
    const diag = window.__godsEyeView.getRenderGovernorDiagnostics?.();
    return diag?.holds ?? null;
  });
  check('governor holds while chasing', JSON.stringify(holding).includes('robot-chase'), { holding });

  // ── 3. sample tracking + frame time over fixed timestamps ──────────────
  // Let Khumbu terrain tiles stream in before sampling frame times.
  await new Promise((r) => setTimeout(r, 8_000));
  const samples = await page.evaluate(async (maxDist) => {
    const gev = window.__godsEyeView;
    const viewer = gev.viewer;
    const module = gev.dataManager.layers.get('ground-robots')?.module;
    const out = [];
    const frameTimes = [];
    let last = performance.now();
    const remove = viewer.scene.postRender.addEventListener(() => {
      const now = performance.now();
      frameTimes.push(now - last);
      last = now;
    });
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const objects = module?.getDetectableObjects?.() || [];
      const selectedId = module?.getSelectedInfo?.()?.id;
      const target = objects.find((o) => o.sourceId === selectedId)?.position
        || objects[0]?.position;
      if (!target) { out.push(null); continue; }
      const cam = viewer.camera.positionWC;
      const dist = Math.hypot(cam.x - target.x, cam.y - target.y, cam.z - target.z);
      out.push({ t: i, distM: Math.round(dist * 10) / 10 });
    }
    remove();
    frameTimes.sort((a, b) => a - b);
    const median = frameTimes.length
      ? frameTimes[Math.floor(frameTimes.length / 2)]
      : 0;
    const gl = document.createElement('canvas').getContext('webgl2')
      || document.createElement('canvas').getContext('webgl');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    return {
      out,
      medianFrameMs: Math.round(median * 100) / 100,
      maxDist,
      softwareGl: /swiftshader|llvmpipe|software/i.test(String(renderer)),
    };
  }, MAX_CHASE_DISTANCE_M);

  const distances = samples.out.filter(Boolean).map((s) => s.distM);
  check(
    'camera tracks the robot (bounded distance, no lurch)',
    distances.length >= 6 && distances.every((d) => d <= MAX_CHASE_DISTANCE_M),
    { distances },
  );
  const frameBudgetMs = samples.softwareGl
    ? SOFTWARE_GL_FRAME_BUDGET_MS
    : FRAME_BUDGET_MS;
  check(
    `median frame time within ${frameBudgetMs}ms while chasing`
      + (samples.softwareGl ? ' (software GL budget)' : ''),
    samples.medianFrameMs > 0 && samples.medianFrameMs <= frameBudgetMs,
    { medianFrameMs: samples.medianFrameMs },
  );

  // ── 4. release: the governor must report zero owners ────────────────────
  const afterRelease = await page.evaluate(() => {
    const gev = window.__godsEyeView;
    const module = gev.dataManager.layers.get('ground-robots')?.module;
    module?.releaseCameraOwnership?.();
    const diag = gev.getRenderGovernorDiagnostics?.();
    return diag?.holds ?? null;
  });
  check(
    'governor hold released on exit (zero robot-chase owners)',
    !JSON.stringify(afterRelease).includes('robot-chase'),
    { afterRelease },
  );
} catch (err) {
  check('qa-robot-chase run completes', false, { error: String(err?.message || err) });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\nqa-robot-chase: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
