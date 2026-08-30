#!/usr/bin/env node
/**
 * Regenerate config/cctv_sources.nepal.json.
 *
 * Nepal has no public traffic-camera network to ingest, so this pack is
 * street-level *viewpoints* rather than cameras: every entry is deliberately
 * feedless, which makes the CCTV frame route fall through to its Google Street
 * View fallback and render real ground-level imagery for the pose.
 *
 * Because the frame only exists where Street View does, the generator refuses
 * to emit a viewpoint it has not confirmed: each candidate is probed against
 * the Street View metadata endpoint (free, no imagery quota) and dropped when
 * the answer is anything but OK. Poses come from OSM road geometry, so a
 * viewpoint sits on the carriageway looking along it.
 *
 * Usage: GOOGLE_MAPS_API_KEY=... node scripts/build-cctv-pack-nepal.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'config/cctv_sources.nepal.json');
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const KEY = process.env.GOOGLE_MAPS_API_KEY;

/** Road runs the pack is cut from: an OSM ref filter plus the spacing to thin to. */
const ROUTES = [
  {
    id: 'ring',
    label: 'Kathmandu Ring Road',
    city: 'Kathmandu',
    cityId: 'kathmandu',
    bbox: [27.63, 85.25, 27.77, 85.41],
    refs: '^NH39$',
    // Ring Road is the dense-urban half of the pack: tight spacing so the
    // camera cones read as a mesh rather than scattered pins.
    spacingM: 350,
    groundElevationM: 1300,
  },
  {
    id: 'corridor',
    label: 'Pasang Lhamu Highway',
    city: 'Rasuwa',
    cityId: 'rasuwagadhi',
    bbox: [27.85, 85.05, 28.32, 85.45],
    refs: '^(NH18|29A005)$',
    // The flood corridor is ~100 km of single highway; wide spacing keeps the
    // downstream run legible instead of stacking cones in the gorge.
    spacingM: 1200,
    groundElevationM: 1000,
  },
];

const R = 6371000;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
function distM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing from `a` to `b`, in degrees clockwise from north. */
function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD)
    - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

async function overpass(query) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const resp = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass answers 406/429 to unidentified clients under load.
          'User-Agent': 'gods-eye-view-cctv-pack-builder/1.0',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(180000),
      });
      if (resp.ok) return resp.json();
      lastError = new Error(`Overpass HTTP ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => { setTimeout(resolve, 20000); });
  }
  throw lastError || new Error('Overpass unavailable');
}

/** Emit a point every `spacing` metres along a way, carrying the local tangent. */
function sampleWay(geometry, spacing) {
  const out = [];
  let carry = 0;
  for (let i = 1; i < geometry.length; i += 1) {
    const a = geometry[i - 1];
    const b = geometry[i];
    const segment = distM(a, b);
    if (segment < 1) continue;
    const heading = bearing(a, b);
    let travelled = spacing - carry;
    while (travelled <= segment) {
      const f = travelled / segment;
      out.push({
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        heading,
      });
      travelled += spacing;
    }
    carry = (carry + segment) % spacing;
  }
  return out;
}

/** Drop points that fall within `minSep` of one already kept. */
function thin(points, minSep) {
  const kept = [];
  for (const point of points) {
    if (kept.every((k) => distM(k, point) >= minSep)) kept.push(point);
  }
  return kept;
}

/**
 * Ask Street View whether a panorama exists near a pose. The metadata endpoint
 * is not billed, so probing every candidate costs nothing but latency.
 */
async function streetViewPano(point) {
  const url = new URL('https://maps.googleapis.com/maps/api/streetview/metadata');
  url.searchParams.set('location', `${point.lat},${point.lon}`);
  url.searchParams.set('radius', '120');
  url.searchParams.set('source', 'outdoor');
  url.searchParams.set('key', KEY);
  let payload = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    payload = await resp.json();
    // A freshly-enabled API flaps between denied and OK while the enablement
    // propagates across Google's frontends, so denial only counts when it
    // holds across retries.
    if (payload.status !== 'REQUEST_DENIED') break;
    await new Promise((resolve) => { setTimeout(resolve, 10000); });
  }
  if (payload.status === 'REQUEST_DENIED') {
    throw new Error(`Street View Static API rejected the key: ${payload.error_message || 'REQUEST_DENIED'}`);
  }
  if (payload.status !== 'OK' || !payload.location) return null;
  return {
    lat: payload.location.lat,
    lon: payload.location.lng,
    date: payload.date || null,
    panoId: payload.pano_id || null,
  };
}

/** Nearest named settlement, used to label a viewpoint. */
async function placeNames(bbox) {
  const [s, w, n, e] = bbox;
  const data = await overpass(`
[out:json][timeout:120];
node["place"~"^(city|town|village|suburb|neighbourhood)$"]["name"](${s},${w},${n},${e});
out;`);
  return (data.elements || [])
    .filter((el) => el.tags?.name && Number.isFinite(el.lat) && Number.isFinite(el.lon))
    .map((el) => ({ name: el.tags.name, lat: el.lat, lon: el.lon }));
}

function nearestPlace(point, places) {
  let best = null;
  for (const place of places) {
    const d = distM(point, place);
    if (!best || d < best.d) best = { place, d };
  }
  return best && best.d < 4000 ? best.place.name : null;
}

/** Ground height in metres, so the projected cone lands on the road not under it. */
async function elevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 90) {
    const batch = points.slice(i, i + 90);
    const url = new URL('https://api.open-meteo.com/v1/elevation');
    url.searchParams.set('latitude', batch.map((p) => p.lat.toFixed(5)).join(','));
    url.searchParams.set('longitude', batch.map((p) => p.lon.toFixed(5)).join(','));
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const payload = await resp.json();
    const values = Array.isArray(payload.elevation) ? payload.elevation : [];
    batch.forEach((_, idx) => out.push(values[idx]));
  }
  return out;
}

async function main() {
  if (!KEY) {
    console.error('GOOGLE_MAPS_API_KEY is required (Street View Static API must be enabled).');
    process.exit(1);
  }

  const sources = [];
  for (const route of ROUTES) {
    const [s, w, n, e] = route.bbox;
    const data = await overpass(`
[out:json][timeout:180];
way["highway"]["ref"~"${route.refs}"](${s},${w},${n},${e});
out geom;`);
    const ways = (data.elements || []).filter((el) => Array.isArray(el.geometry) && el.geometry.length > 1);
    const sampled = ways.flatMap((way) => sampleWay(way.geometry, Math.round(route.spacingM / 4)));
    const candidates = thin(sampled, route.spacingM);
    console.log(`[${route.id}] ${ways.length} ways -> ${candidates.length} candidate viewpoints`);

    const places = await placeNames(route.bbox);
    const covered = [];
    for (const candidate of candidates) {
      const pano = await streetViewPano(candidate);
      if (!pano) continue;
      // Snap onto the panorama itself; the metadata radius means the sampled
      // road point can be up to 120 m from where imagery actually exists.
      covered.push({ ...candidate, lat: pano.lat, lon: pano.lon, date: pano.date });
    }
    console.log(`[${route.id}] ${covered.length}/${candidates.length} have Street View coverage`);

    const heights = await elevations(covered);
    covered.forEach((point, index) => {
      const place = nearestPlace(point, places);
      const label = place ? `${route.label} @ ${place}` : `${route.label} km-post ${index + 1}`;
      const height = heights[index];
      sources.push({
        id: `nepal-${route.id}-${String(index + 1).padStart(3, '0')}`,
        name: label,
        city: place || route.city,
        cityId: route.cityId,
        provider: 'Street-level viewpoint (Google Street View)',
        sourceKind: 'streetview-viewpoint',
        poseSource: 'curated',
        feedType: 'image',
        lat: Number(point.lat.toFixed(6)),
        lon: Number(point.lon.toFixed(6)),
        headingDeg: Math.round(point.heading),
        headingConfidence: 'high',
        pitchDeg: -6,
        fovDeg: 75,
        rangeM: 180,
        mountHeightM: 6,
        groundElevationM: Number.isFinite(height) ? Math.round(height) : route.groundElevationM,
        license: 'Imagery © Google — Street View Static API',
        imageryDate: point.date || null,
      });
    });
  }

  fs.writeFileSync(OUTPUT, `${JSON.stringify(sources, null, 2)}\n`);
  console.log(`Wrote ${sources.length} viewpoints to ${path.relative(ROOT, OUTPUT)}`);
}

await main();
