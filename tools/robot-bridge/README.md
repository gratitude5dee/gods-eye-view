# Robot telemetry bridge

Standalone Node tool that feeds RobotFrames (see `src/data/robotFrame.js`) to
the GEV relay at `POST /api/robot/ingest`. The web app and its server never
import robot SDKs — providers live only here.

## Run the synthetic Khumbu walker

```sh
# In one shell (with GEV_ROBOT_INGEST_TOKEN set in .env):
npm run dev

# In another:
GEV_ROBOT_INGEST_TOKEN=<same token> node tools/robot-bridge/bridge.mjs \
  --provider synthetic --ingest http://localhost:5173/api/robot/ingest \
  --seed 5 --rate 10
```

Then enable the **Ground Robots** layer in the app. The synthetic walker is
deterministic by `--seed`: same seed, same walk — including scripted slip,
comms-dropout, and carried segments.

## Run a MuJoCo sim2sim G1 rollout

The `mujoco-g1` provider reads a JSON Lines stream from a
`mujoco_playground` sim2sim rollout (`experimental/sim2sim/play_g1_joystick.py
--telemetry`, whose exporter is documented in that repo) and forwards validated
canonical frames. Piped on stdout:

```sh
python3 mujoco_playground/experimental/sim2sim/play_g1_joystick.py \
  --telemetry stdout --telemetry_robot_id g1-01 \
  | GEV_ROBOT_INGEST_TOKEN=<token> node tools/robot-bridge/bridge.mjs \
      --provider mujoco-g1 --rate 10
```

Or over a local socket, so the rollout can be restarted without restarting the
bridge (the provider listens, the sim connects):

```sh
GEV_ROBOT_INGEST_TOKEN=<token> node tools/robot-bridge/bridge.mjs \
  --provider mujoco-g1 --socket /tmp/gev-g1.sock --rate 10
# then, in any shell, as often as you like:
python3 …/play_g1_joystick.py --telemetry /tmp/gev-g1.sock
```

Both transports are inbound-only: nothing is ever written back to the sim.
Frames are decimated to `--rate` Hz because the joystick controller steps at
50 Hz while the relay keeps only 600 frames per robot. `--provenance` defaults
to `live-g1` (this is the sim2sim *deploy* seam — the same ONNX policy that runs
on hardware); pass `--provenance synthetic` to label a pure rollout `SIMULATED`
instead. To see the G1 as a posed 3D model rather than the SVG glyph, turn on the
ground-robots `models3d` param (default off).

## Providers

| Provider    | Status  | Provenance label |
|-------------|---------|------------------|
| `synthetic` | done    | `SIMULATED`      |
| `mujoco-g1` | done    | `LIVE` (or `SIMULATED` via `--provenance synthetic`) |
| `replay`    | planned (P1) | `REPLAY`    |
| `phone`     | planned (P1) | `PHONE PROXY` |
| `unitree` (live G1 via DDS) | planned (P2) | `LIVE` |

A provider exports `createProvider(options)` returning:

```js
{
  id: 'synthetic',
  async start(onFrame) {},
  async stop() {},
  getStatus() { return { status: 'live'|'stale'|'down', lastFrameAt, error }; }
}
```

## Live G1 safety (P2+, not implemented here)

The future `unitree` provider is read-only (DDS subscribe only). Any process
that ever registers a controller must trap SIGINT/SIGTERM and damp all joints
(`kp=0`, `kd≈8`, zero feed-forward torque) before exit, and a human must watch
the robot camera during motion. Outbound commands stay behind
`GEV_ROBOT_COMMANDS` (off by default; the endpoint answers 501).
