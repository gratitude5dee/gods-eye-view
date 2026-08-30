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

## Providers

| Provider    | Status  | Provenance label |
|-------------|---------|------------------|
| `synthetic` | done    | `SIMULATED`      |
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
