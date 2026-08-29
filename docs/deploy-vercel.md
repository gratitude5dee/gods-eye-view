# Deploying God's Eye View to Vercel

The app is a Vite SPA whose entire backend is Vite server middleware. Everything
live reaches the browser through same-origin `/api/*` routes, so a static-only
host serves a globe and nothing else.

This repo now ships both halves of the answer:

- `server/proxies.js` — the middlewares themselves, host-agnostic.
- `server/plugins.js` — the ordered plugin list Vite mounts (`vite.config.js`).
- `server/app.js` — a Connect-compatible dispatcher that runs the same stack
  outside Vite.
- `api/gev.js` — one Vercel Function that serves every `/api/*` route through
  that dispatcher, with `vercel.json` rewriting `/api/(.*)` to it.

Nothing about the client changed: paths, query strings, and response shapes are
the ones `vite dev` serves.

## 1. Static baseline

`vercel.json` alone is enough for a static deploy:

```json
{ "framework": "vite", "buildCommand": "vite build", "outputDirectory": "dist" }
```

Set these two in **Project Settings → Environment Variables** and redeploy:

| Variable | Why |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | Google Photorealistic 3D Tiles |
| `CESIUM_ION_TOKEN` | Cesium Ion terrain/imagery |

Both are injected into the bundle by the `define` block in `vite.config.js`, so
**they are visible in devtools** — that is by design, not a leak to fix. Restrict
them at the provider: an HTTP-referrer restriction scoped to the deployment
domain for the Google key, and a token scoped to the specific Ion assets.

On the static baseline only the base globe/map works. Aircraft, vessels,
satellites, fires, traffic, CCTV, radio, launches, terrain queries, place
context, and voice all return 404 until the function below is deployed.

## 2. Route inventory

Every `/api/*` path the client calls, its implementing plugin, and how it fares
in a serverless invocation.

| Route | Plugin | Upstream | Serverless |
| --- | --- | --- | --- |
| `/api/opensky` | `openSkyProxy` | OpenSky (OAuth2) | yes — token + response cache go per-instance |
| `/api/opensky-track` | `trackBackfillProxies` | OpenSky `/tracks/all` | yes |
| `/api/adsblol/mil`, `/api/adsblol/trace` | `adsbLolProxy`, `trackBackfillProxies` | adsb.lol | yes |
| `/api/adsbdb/route/*`, `/api/adsbdb/type/*` | `adsbdbProxy` | adsbdb | yes — disk cache is cold-start-only |
| `/api/celestrak/*` | `celestrakProxy` | CelesTrak TLEs | yes — same |
| `/api/launches` | `rocketLaunchesProxy` | Launch Library 2 | yes — same |
| `/api/firms` | `firmsProxy` | NASA FIRMS | yes — same |
| `/api/terrain/heights` | `terrainHeightsProxy` | Cesium terrain tiles | yes — same |
| `/api/overpass`, `/api/route` | `overpassProxy` | Overpass, OSRM | yes — same |
| `/api/military-installations` | `militaryInstallationsProxy` | Overpass | yes — same |
| `/api/regional-brief` | `regionalBriefProxy` | Open-Meteo, USGS, GDACS | yes — memory cache is per-instance |
| `/api/weather-effects` | `weatherEffectsProxy` | Open-Meteo | yes — same |
| `/api/cctv`, `/api/cctv/sources`, `/api/cctv/frame/*`, `/api/cctv/media`, `/api/cctv/health` | `cctvProxy` | TfL, Austin, Caltrans, generic MJPEG/HLS | yes, with caveats (see §4) |
| `/api/radio/stations`, `/api/radio/click/*` | `radioBrowserProxy` | Radio Browser | yes |
| `/api/gbfs/*` | `gbfsProxy` | GBFS feeds | yes |
| `/api/google/nearby-places`, `/api/google/text-search` | `googlePlacesContextProxy` | Google Places | yes |
| `/api/openai/hud-summary`, `/api/realtime/token`, `/api/realtime/debug-log` | `openAiRealtimeProxy` | OpenAI | yes — `debug-log` writes are best-effort only |
| `/api/tomtom/flow/{z}/{x}/{y}.pbf`, `/api/tomtom/status` | `tomtomProxy` | TomTom Traffic | **partly** — the daily budget counter needs shared state (§4) |
| `/api/ais-live`, `/api/ais-live/track` | `aisLiveProxy` | AISStream websocket | **no** — needs a long-running host (§4) |

## 3. Serverless port

`vercel.json` sends everything under `/api/` to one function:

```json
"rewrites": [{ "source": "/api/(.*)", "destination": "/api/gev?gevPath=$1" }]
```

One function rather than ~20 files because the proxies are already written
against Connect's mounting contract — `use('/api/cctv', fn)` prefix-matches and
the handler reads `req.url` with the mount stripped (`/frame/austin-42?w=640`),
and several of them route their own sub-paths from that. `server/app.js`
reproduces exactly that (mount matching at path boundaries, prefix stripping,
and re-presenting a pre-parsed body as a stream for the POST handlers), so the
handlers stay byte-identical between Vite and Vercel. It also keeps one warm
instance's caches alive across requests, and turns a handler throw into the JSON
502 the client already knows how to read instead of a host error page.

`gevPath` exists because not every client path is filesystem-route friendly:
`/api/tomtom/flow/12/34/56.pbf` would otherwise be resolved as a static asset.

Rehearse the exact stack locally, without Vercel:

```bash
node scripts/serve-api-local.mjs 5199
curl -s 'http://127.0.0.1:5199/api/opensky?lamin=30&lomin=-98&lamax=31&lomax=-97'
```

Server-side environment variables (Vercel env vars, **never** `VITE_`-prefixed
and never in the bundle): `OPENAI_API_KEY` and the `OPENAI_*` model/voice knobs,
`OPENSKY_AUTH_MODE` + `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET`,
`FIRMS_MAP_KEY`, `TOMTOM_API_KEY`, `TOMTOM_DAILY_TILE_BUDGET`,
`AISSTREAM_API_KEY` and its `AISSTREAM_*` companions, `LL2_API_TOKEN`, and the
CCTV feed settings. `.env.example` is the full list.

The `GOOGLE_MAPS_API_KEY` is read on both sides (browser 3D Tiles, server-side
Places), so it needs to be set once and restricted by referrer + API.

## 4. What does not fit serverless

A Vercel invocation is per-request and its filesystem is read-only apart from
`/tmp`, which belongs to one instance. Three subsystems are built on the
opposite assumptions.

### AISStream websocket + watchdog — genuinely incompatible

`aisLiveProxy` keeps one authenticated websocket open and accumulates vessel
positions in memory, with a `setInterval` watchdog reconnecting on silence.
Value comes from the minutes of accumulation, and AISStream permits one
connection per key — so a function instance that connects spends the key's only
slot to answer with an empty snapshot, then dies.

The proxy therefore decides by host: `aisStreamSupported()` is false on Vercel
and Lambda, and `/api/ais-live` answers `503` with
`{ rows: [], status: 'unsupported' }` — the snapshot contract the vessel layer
already handles, so the layer degrades instead of breaking. Overrides:

- `AIS_LIVE_RELAY_URL=https://relay.example/api/ais-live` — point at any
  long-running host running this same app (a small Fly/Render/EC2 box, `npm run
  preview`). The function forwards `/api/ais-live` and `/api/ais-live/track`
  including query strings, so the layer is fully live again. This is the
  recommended production shape.
- `GEV_AIS_STREAM=on|off` forces the decision, for hosts this heuristic does not
  recognize (a container platform where the socket *is* viable).

### TomTom disk cache + daily budget counter — needs shared state

`tomtomProxy` caches tiles under `.gev-cache/tomtom/` and enforces a daily tile
budget with a persistent counter (`budget.json`). On Vercel the cache tree moves
to `/tmp` (`gevCachePath()`, override with `GEV_CACHE_DIR`), which means:

- Tiles still hit on a warm instance, so the layer works and pans normally.
- The budget counter is **per instance**, so N concurrent instances can each
  spend up to the configured budget. Set `TOMTOM_DAILY_TILE_BUDGET` to a
  fraction of the real quota, or move the counter to shared storage
  (Vercel KV / Upstash Redis: `INCR gev:tomtom:<yyyy-mm-dd>` with a 48 h TTL,
  read before the fetch) if you want a true cap.

The same per-instance-`/tmp` note applies to every other disk cache in the
table (Overpass, FIRMS, adsbdb, CelesTrak, launches, terrain,
military installations): correctness is unaffected, upstream call volume rises,
so watch third-party rate limits. Those are also the natural first candidates
for a shared KV layer keyed by the same cache keys the proxies already compute.

### In-memory regional-brief / weather / CCTV caches — degraded, not broken

`regionalBriefProxy` and `weatherEffectsProxy` memoize by rounded coordinate in
module state; CCTV keeps camera catalogs and frame buffers in memory. Per
instance, all of that is a cold start away from empty. Consequences are extra
upstream calls and a slower first frame, not wrong data. CCTV MJPEG/HLS frame
grabbing is also the most latency-sensitive route here — keep an eye on the
function's `maxDuration` (30 s in `vercel.json`).

### If you want everything live, unconditionally

Host the app on a long-running Node platform (`npm run build && npm run
preview`, or `vite preview` behind a proxy) on Fly.io, Render, Railway, or a
plain VM. Every proxy then runs as written: one AIS socket, one disk cache, one
budget counter. The Vercel path is best either as the static-plus-stateless
deployment or as the CDN front end with `AIS_LIVE_RELAY_URL` pointing at one
small always-on box.

## 5. Verifying a deployment

```bash
BASE=https://<deployment>.vercel.app
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/"                       # 200, globe
curl -s "$BASE/api/opensky?lamin=30&lomin=-98&lamax=31&lomax=-97" | head -c 200
curl -s "$BASE/api/cctv/sources?latitude=30.27&longitude=-97.74" | head -c 200
curl -s "$BASE/api/tomtom/status"                                       # hasKey:true
curl -s -X POST "$BASE/api/realtime/token" -H 'content-type: application/json' -d '{}' | head -c 200
curl -s "$BASE/api/ais-live" | head -c 120                              # 503 unsupported unless relayed
```

In the browser: the globe and 3D tiles load, aircraft appear over a populated
box, the CCTV tray lists cameras and a thumbnail renders, the traffic layer
draws flow tiles, and the mic issues a Realtime session (a `/api/realtime/token`
`200`).
