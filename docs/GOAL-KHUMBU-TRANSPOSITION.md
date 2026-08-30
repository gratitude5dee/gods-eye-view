# GOAL — Khumbu Transposition

The demo: a real Unitree G1, suspended on a gantry in a sandboxed room in
Malaysia, steps in place. In God's Eye View it walks the Khumbu trail toward
Everest Base Camp — over real terrain, in real weather, watched by its own
real camera — and the interface states exactly which parts are real and which
are staged.

Companion to `docs/ROBOT-THIRD-PERSON-SPEC.md`, which owns the layer
architecture. This document owns the transposition and the live-robot
bring-up. **W0 (synthetic end-to-end, this tree) is complete; W1+ (onboard
publisher, live bring-up) has not started and no physical robot has been
moved.**

## The honesty table

A viewer who reads only the chips must come away with a correct
understanding. If they could mistake this for a robot actually in Nepal, the
labelling has failed.

| Element | Status | Shown as |
|---------|--------|----------|
| Gait, IMU, joint state, battery, temps | Real, live from the G1 | `LIVE` |
| Camera feed of the robot | Real, live (go2rtc snapshots) | `LIVE` |
| Khumbu terrain and elevation | Real (Google 3D Tiles) | `LIVE` |
| Weather over the route | Real feed | `LIVE` |
| Robot's geographic position | Staged — Malaysia, rendered in Nepal | `VIRTUAL TRANSPOSITION` |
| Forward progress along the trail | Derived from real cadence, not real translation | `GAIT-INTEGRATED` |
| Camera's geographic position | Staged to match the robot | `VIRTUAL TRANSPOSITION` |

With the synthetic provider (this tree) every telemetry chip reads
`SIMULATED` instead of `LIVE`; the transposition chips are identical.

## Transposition

`src/data/robotTransposition.js` + `config/routes/khumbu-ebc.json`
(Lukla → Namche Bazaar → Tengboche → Dingboche → Lobuche → Gorak Shep → EBC).

Route progress integrates **gait**, never geographic translation: a
gantry-bound robot has no meaningful velocity, so distance-along-route
advances from cadence × stride while the gait FSM is walking, and freezes when
it is not (carried, stuck, fallen, standing). The staged pose carries the
`VIRTUAL TRANSPOSITION` provenance suffix on every surface.

## Architecture delta from the base spec

1. **The bridge runs on the Orin** — `bridge.mjs` + a future `unitree.py`
   provider subscribe to DDS locally and POST batches over the tailnet. No
   control loop or DDS traffic crosses the ocean.
2. **The GEV server must be on the tailnet** — the CCTV proxy fetches
   upstream feeds server-side, so the Node process is what resolves
   `cctv.tail5670b1.ts.net`; the browser only calls same-origin paths.
3. **No Vercel for this demo** — server-side tailnet fetches plus the ring
   buffer need a long-running local process.

## CCTV

`config/cctv_sources.khumbu.json` stages the two real gantry cameras
(`cam_1` front, `cam_2` back, via go2rtc JPEG snapshots — probed and verified)
at Tengboche Ridge, labeled `VIRTUAL TRANSPOSITION`. Run with:

```sh
CCTV_SOURCES_FILE=config/cctv_sources.khumbu.json
```

## Running the synthetic demo (W0, no hardware)

```sh
GEV_ROBOT_SOURCE=synthetic npm run dev          # in-process walker, or:
GEV_ROBOT_INGEST_TOKEN=... node tools/robot-bridge/bridge.mjs  # external bridge
```

Enable the Ground Robots layer, click the robot, engage chase.

## Live bring-up (W1+, not started)

Read Section 8 of `docs/ROBOT-THIRD-PERSON-SPEC.md` first. Hard requirements
carried from the access doc:

- Simulate first; the robot is not a debugging environment.
- Any physical verification run is screen-recorded via the gantry CCTV
  (`https://cctv.tail5670b1.ts.net/`) and the recording retained.
- Controllers trap SIGINT/SIGTERM; shutdown sets all 29 joints to `kp=0`,
  `kd≈8`, zero feed-forward torque.
- Confirm developer mode (green face light) on camera; a human watches the
  robot camera throughout.
- Never: alter networking, reboot, move the gantry, edit systemd/shared
  config, disable safety limits/watchdogs/torque caps, exceed the one-metre
  envelope, jump, or perform wide arm motions.
- End state: robot normal, processes stopped, conda env removed, no leftover
  runtime state.
