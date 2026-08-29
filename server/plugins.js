/**
 * The ordered `/api/*` plugin list, shared by every host.
 *
 * `vite.config.js` spreads it into its `plugins` array; `server/app.js` walks
 * the same list to build the serverless dispatcher. Keeping one list is what
 * guarantees dev, preview, and production resolve a path identically —
 * several mounts prefix-match (`/api/cctv`, `/api/ais-live`), so order is part
 * of the routing contract, not a formality.
 *
 * @module server/plugins
 */

import {
  openSkyProxy,
  celestrakProxy,
  tomtomProxy,
  firmsProxy,
  rocketLaunchesProxy,
  terrainHeightsProxy,
  adsbdbProxy,
  overpassProxy,
  militaryInstallationsProxy,
  regionalBriefProxy,
  weatherEffectsProxy,
  cctvProxy,
  radioBrowserProxy,
  gbfsProxy,
  adsbLolProxy,
  aisLiveProxy,
  trackBackfillProxies,
  openAiRealtimeProxy,
  googlePlacesContextProxy,
} from './proxies.js';

/** @returns {import('vite').Plugin[]} Fresh plugin instances, in mount order. */
export function gevApiPlugins() {
  return [
    openSkyProxy(),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    adsbdbProxy(),
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    weatherEffectsProxy(),
    cctvProxy(),
    radioBrowserProxy(),
    gbfsProxy(),
    adsbLolProxy(),
    aisLiveProxy(),
    trackBackfillProxies(),
    openAiRealtimeProxy(),
    googlePlacesContextProxy(),
  ];
}
