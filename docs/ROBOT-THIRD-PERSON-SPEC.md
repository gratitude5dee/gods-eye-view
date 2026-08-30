# Robot Third-Person Layer — Spec and Implementation State

Third-person visualization of a Unitree G1 humanoid on the God's Eye View
globe. P0 (this tree) is entirely read-only: telemetry in, pixels out. The
worst failure mode is a wrong picture.

Companion: `docs/GOAL-KHUMBU-TRANSPOSITION.md` owns the live-robot bring-up
and the Khumbu virtual transposition. This document owns the layer
architecture.

## Phases

| Phase | Scope | Moves the robot? |
|-------|-------|------------------|
| **P0** (this tree) | RobotFrame schema, relay (ingest/telemetry/SSE), synthetic provider + bridge, ground-robots layer, chase camera, gait-integrated transposition, Khumbu CCTV catalog | No |
| P1 | Replay + phone providers | No |
| P2 | Live Unitree DDS bridge, SLAM map endpoint | No |
| P3 | Intelligence: gait classifier (shipped early, `src/data/robotGait.js`), turn-back advisor (shipped early, `src/robotTurnBack.js`), comms shadow | No |
| P4 | Outbound commands — read §Safety before writing any of it | **Yes — gated** |

## Wire format — RobotFrame v1

`src/data/robotFrame.js` (pure, Cesium-free). One frame per telemetry tick:

- `v: 1`, `id` (`/^[0-9a-z~_-]{1,16}$/`), `t` (sender ms), `rx` (server-stamped)
- `pose {lat, lon, altM, headingDeg, pitchDeg, rollDeg}` + `datum`
  (`wgs84-ellipsoid | egm96-orthometric | agl | slam-local`)
- `fix {source, hAccM, vAccM, sats}`, `vel {speedMps, courseDeg, vzMps, yawRateDps}`
- `imu {ax..gz, qw..qz}`, `gait {fsm, footForce[2], contact[2], cadenceHz, strideM}`
- `power {soc, voltV, currentA, wattsInst, tempC}`,
  `health {estop, commsRttMs, linkRssiDbm, motorErrors}`
- `provenance {source: live-g1|phone|replay|synthetic, label, confidence}`

Limits: ±24 h clock clamp, ≤200 frames/POST, ≤600 frames/robot ring,
≤16 robots, whole-batch rejection (no malformed-prefix salvage).

## Server relay

`server/robotProxies.js` — dev/preview middleware plus the serverless
dispatcher, where it degrades to 503 `{status:'unsupported'}` (SSE and ring
buffers need a persistent process; set `GEV_ROBOT_RELAY_URL` to advertise an
external relay instead).

- `POST /api/robot/ingest` — requires `GEV_ROBOT_INGEST_TOKEN`
  (`x-gev-robot-token` header); 256 KiB body cap; opt-in
  `GEV_RATELIMIT_ROBOT_PER_MIN`.
- `GET /api/robot/telemetry` — latest frames snapshot.
- `GET /api/robot/stream` — SSE fan-out of accepted batches.
- `POST /api/robot/command` — **501, disabled by default** (P4).
- `GET /api/robot/map` — reserved (P2).
- `GEV_ROBOT_SOURCE=synthetic` — dev convenience: the deterministic synthetic
  walker feeds the relay in-process, no bridge needed.

## Providers and bridge

`tools/robot-bridge/` is standalone; browser/server bundles never import DDS,
the Unitree SDK, or Python. `providers/synthetic.mjs` is a seeded,
deterministic Khumbu walker (0.6–1.4 m/s, cadence 1.6–2.0 Hz, alternating
contacts, sinusoidal foot forces, IMU bob, monotonic battery drain with uphill
cost, scripted slip/dropout/carried events). Provenance is exactly
`{source:'synthetic', label:'SIMULATED', confidence:1.0}`.

## Ground-robots layer

`src/data/groundRobots.js`. Disabled at boot (cold-start budget). Five wiring
sites that must agree: `src/main.js` registration, `src/data/layerState.js`
(`{id:'ground-robots', token:'k', disposition:'enabled-only'}`), the
`initDetection` array in `src/ui.js`, `SPRITE_LAYER_ORDER`, and the
`docs/CURRENT-STATE.md` data-layers row.

- Bounded 5-fix histories; dead-reckoned interpolation ~1 telemetry interval
  behind wall clock (`src/data/robotMotion.js`); bounded coast, no drift.
- Shared `BillboardCollection` registered as `ground-robots`; stand-in SVG
  glyph (no G1 mesh shipped — licensing).
- Selection announces `requestWorldFocus({kind:'robot'})`; the layer contains
  **no** `camera.flyTo` / `trackedEntity` / `lookAt`.
- Detection type `GROUND`, tier `ground`, semantic priority 40.
- Ground height via cached ground-snap only — never `sampleHeight` per frame.
- Provenance chips on every surface, `· VIRTUAL TRANSPOSITION` suffix when the
  pose is staged (see the GOAL doc).

## Chase camera

`src/robotChaseCamera.js`. Single-writer camera rule holds: entry routes
through `runImmediateNavigation('robot', ...)` (the layer dispatches
`gev:robot-chase-request`; ui.js owns the claim), teardown through
`ui.js::_releaseFollowCamera()` → `groundRobotsLayer.releaseCameraOwnership()`.

- `scene.preUpdate` (never `preRender`), bounded correction, 60°/s yaw slew.
- Range clamp 2–40 m, default 6 m, pitch −15°, eye height ~2.5 m,
  terrain-safe anchor.
- Holds `holdContinuousRender('robot-chase')` on start and releases it
  symmetrically on stop; camera inputs disabled while active and restored
  after; `lookAtTransform` cleared on stop. A leaked hold is the whole frame
  budget — `scripts/qa-robot-chase.mjs` asserts zero holders after exit.

## Intelligence (shipped early from P3, both pure)

- `src/data/robotGait.js` — `classifyGait(window)` →
  walking/carried/stuck/fallen/standing over a 2–3 s window;
  `createGaitClassifier()` adds dwell hysteresis so states cannot chatter.
- `src/robotTurnBack.js` — energy-to-home over terrain segments with slope,
  wind, and precipitation costs vs battery SOC and reserve; emits a shrinking
  turn-back radius. Labeled `ESTIMATE` until calibrated against a measured run.

## Safety (P4 — read before writing command code)

- Default off: no `GEV_ROBOT_COMMANDS` env means `/api/robot/command` is 501
  and the client renders no control affordance.
- The physical e-stop is the e-stop; software stop is best-effort only.
- No LLM in the actuation path — realtime tools may only return proposals a
  human confirms with a deliberate gesture.
- Allowlist staged (non-locomotion first), command TTL ≤2 s, robot-side
  watchdog (absence of a command is a stop), authenticated, every command
  logged with operator identity.
- Physical verification runs must be screen-recorded with the gantry CCTV
  (`config/cctv_sources.khumbu.json` sources) and the evidence retained.

## Testing

Unit (`*.test.mjs` under `src/` auto-discovers): `robotFrame`, `robotGait`,
`robotMotion`, `robotTransposition`, `robotRelay`, `robotSyntheticProvider`,
`robotChaseCamera` (source-pinning, `cameraHandoff.test.mjs` style),
`robotTurnBack`. Integration: `scripts/qa-robot-chase.mjs` (Puppeteer; needs a
server with `GEV_ROBOT_SOURCE=synthetic`). Gates before every PR: `npm test`,
`node scripts/qa-perf.mjs`, `node scripts/qa-firstrun.mjs`,
`node scripts/track-regression.mjs` (Node 24 for allocation budgets).
