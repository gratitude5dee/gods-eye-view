/**
 * Run the `/api/*` middlewares on a bare Node server — the serverless
 * dispatcher without Vercel.
 *
 * This is the local rehearsal for `api/gev.js`: same stack, same routing, so a
 * contract regression shows up here before a deploy. Usage:
 *
 *   node scripts/serve-api-local.mjs [port]
 *
 * @module scripts/serve-api-local
 */

import http from 'node:http';
import { dispatchGevApi } from '../server/app.js';

const port = Number.parseInt(process.argv[2] || process.env.PORT || '5199', 10);

http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (!url.startsWith('/api/')) {
    res.statusCode = 404;
    res.end('this server only answers /api/*\n');
    return;
  }
  await dispatchGevApi(req, res, { url });
}).listen(port, '127.0.0.1', () => {
  console.log(`[gev-api] serverless-equivalent stack on http://127.0.0.1:${port}/api/`);
});
