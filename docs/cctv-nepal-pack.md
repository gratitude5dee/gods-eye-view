# Nepal street-level viewpoint pack

## Why it exists

The CCTV Mesh is the layer that makes a city look surveilled: hundreds of camera
frusta projected into the 3D scene. All three live packs — Austin Open Data,
Caltrans, TfL JamCams — are city APIs, and the nearest one to the Rasuwagadhi
flood corridor is London, 7,285 km away. Nepal has no ingestable public camera
network: Windy's webcam API is key-gated, OSM carries 14 `man_made=surveillance`
nodes in the Kathmandu valley with no feeds behind them, and the aggregator sites
advertising "1,000+ Nepal traffic cameras" serve dead links.

So this pack is **viewpoints, not cameras**. Each entry is a real pose on a real
carriageway, and its frame is Google Street View imagery rather than a live feed.

## How it works

Entries are deliberately feedless — no `url`, no `snapshotUrl`. `/api/cctv/frame/:id`
tries the upstream feed first, finds none, and falls through to its existing
Street View fallback, which renders the pano at the viewpoint's `headingDeg` /
`pitchDeg` / `fovDeg`. Nothing in the client had to change: the pack merges into
`/api/cctv/sources` alongside the live packs (it does not replace them, unlike
`CCTV_SOURCES_FILE`) and projects through the same mesh.

Coverage is two runs, cut from OSM road geometry:

| Run | OSM ref | Spacing | `cityId` |
| --- | --- | --- | --- |
| Kathmandu Ring Road | `NH39` | 350 m | `kathmandu` |
| Pasang Lhamu Highway (Betrawati → Rasuwagadhi) | `NH18`, `29A005` | 1,200 m | `rasuwagadhi` |

## Regenerating

```bash
GOOGLE_MAPS_API_KEY=... node scripts/build-cctv-pack-nepal.mjs
```

The generator samples the road runs, probes every candidate against the Street
View **metadata** endpoint (unbilled), and drops anything that is not `OK`, so
the committed pack never claims a viewpoint whose imagery does not exist. It
snaps each survivor onto the panorama's own coordinates, takes the heading from
the local road tangent, and reads ground elevation from Open-Meteo so the cone
lands on the road instead of under the terrain.

It aborts on `REQUEST_DENIED`: the **Street View Static API** must be enabled on
the GCP project behind `GOOGLE_MAPS_API_KEY`. That is a separate API from Maps
JavaScript and Map Tiles.

## Operating notes

- `CCTV_NEPAL_ENABLED=0` drops the pack without touching the live packs.
- Frames are billed Street View Static requests against `GOOGLE_MAPS_API_KEY`,
  one per camera refresh — cap it with `GEV_RATELIMIT_GOOGLE_PER_MIN`.
- Attribution: `Imagery © Google — Street View Static API`, carried per entry in
  `license` and surfaced in the camera card.
- Without the API enabled the frames degrade to the synthetic placeholder, the
  same as any camera whose upstream is unreachable.
