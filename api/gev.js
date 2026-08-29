/**
 * Vercel entrypoint for every `/api/*` route.
 *
 * `vercel.json` rewrites `/api/(.*)` here with the original path carried in
 * `gevPath`, because the client's paths are not all filesystem-route friendly
 * (`/api/tomtom/flow/12/34/56.pbf` reads as a static asset). The original URL
 * is rebuilt from that parameter and handed to the shared dispatcher, so the
 * handlers see exactly the URL they see under `vite dev`.
 *
 * @module api/gev
 */

import { dispatchGevApi } from '../server/app.js';

/**
 * @param {import('node:http').IncomingMessage & {body?:unknown}} req - Request.
 * @param {import('node:http').ServerResponse} res - Response.
 * @returns {Promise<void>}
 */
export default async function handler(req, res) {
  const incoming = new URL(req.url || '/', 'http://localhost');
  const routed = incoming.searchParams.get('gevPath');
  if (routed !== null) {
    incoming.searchParams.delete('gevPath');
    incoming.pathname = `/api/${routed.replace(/^\/+/, '')}`;
  }
  const url = `${incoming.pathname}${incoming.search}`;
  await dispatchGevApi(req, res, { url });
}
