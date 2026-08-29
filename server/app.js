/**
 * Host-agnostic dispatcher for the `/api/*` middlewares.
 *
 * The proxies in `server/proxies.js` are written against Connect's mounting
 * contract, because that is what Vite's dev and preview servers give them:
 * `use('/api/cctv', fn)` prefix-matches, and the handler sees `req.url` with
 * the mount point stripped (`/frame/austin-42?x=1`). Several handlers depend on
 * that stripping to route their own sub-paths, so a serverless host has to
 * reproduce it rather than hand over the raw URL.
 *
 * `dispatchGevApi()` does exactly that: it builds the same middleware stack
 * from `gevApiPlugins()`, then walks it with Connect's matching rules.
 *
 * @module server/app
 */

import { Readable } from 'node:stream';
import { gevApiPlugins } from './plugins.js';

/** @typedef {{route:string, fn:Function}} MountedMiddleware */

/**
 * Install every plugin against a stub server and return the resulting stack.
 *
 * The stub has no `httpServer`, so plugins hang no lifecycle listeners; the
 * background-work decision (AIS's websocket and watchdog interval) is the
 * plugins' own, via `aisStreamSupported()`.
 *
 * @param {{plugins?: object[]}} [options]
 * @returns {MountedMiddleware[]} Mounted middlewares in registration order.
 */
export function collectGevApiMiddlewares({ plugins = null } = {}) {
  /** @type {MountedMiddleware[]} */
  const stack = [];
  const middlewares = {
    use(routeOrFn, maybeFn) {
      if (typeof routeOrFn === 'string') stack.push({ route: routeOrFn, fn: maybeFn });
      else stack.push({ route: '/', fn: routeOrFn });
      return middlewares;
    },
  };
  const server = { middlewares, httpServer: null };
  for (const plugin of plugins || gevApiPlugins()) {
    const install = plugin?.configureServer || plugin?.configurePreviewServer;
    if (typeof install === 'function') install.call(plugin, server);
  }
  return stack;
}

/** Lazily built stack — one per warm instance, so the plugin caches persist. */
let _stack = null;

/** @returns {MountedMiddleware[]} The cached serverless middleware stack. */
function serverlessStack() {
  if (!_stack) _stack = collectGevApiMiddlewares();
  return _stack;
}

/**
 * Connect's mount test: a prefix match that may only end at a path boundary,
 * so `/api/cctv` never swallows `/api/cctv-admin`.
 *
 * @param {string} pathname - Request pathname.
 * @param {string} route - Mount point.
 * @returns {boolean}
 */
export function mountMatches(pathname, route) {
  if (route === '' || route === '/') return true;
  if (pathname.toLowerCase().slice(0, route.length) !== route.toLowerCase()) return false;
  const next = pathname[route.length];
  return !next || next === '/' || next === '.';
}

/**
 * Strip a mount point from a URL the way Connect does, keeping the query and
 * guaranteeing a leading slash.
 *
 * @param {string} url - Request URL (path + query).
 * @param {string} route - Mount point.
 * @returns {string}
 */
export function stripMount(url, route) {
  if (route === '' || route === '/') return url;
  const stripped = url.slice(route.length);
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

/**
 * A request object the middlewares can consume on any host.
 *
 * Serverless runtimes read the body before the handler runs, which would leave
 * the stream-reading proxies (`/api/overpass`, `/api/realtime/token`) waiting
 * forever on a consumed stream. Re-presenting the already-read bytes as a
 * fresh Readable keeps those handlers unchanged.
 *
 * @param {import('node:http').IncomingMessage} req - Host request.
 * @param {{url:string, rawBody?:Buffer|null}} options
 * @returns {import('node:stream').Readable & {url:string}}
 */
export function toMiddlewareRequest(req, { url, rawBody = null }) {
  const stream = Readable.from(rawBody && rawBody.length ? [rawBody] : []);
  stream.url = url;
  stream.method = req.method;
  stream.headers = req.headers;
  stream.httpVersion = req.httpVersion || '1.1';
  stream.socket = req.socket;
  stream.connection = req.socket;
  return stream;
}

/**
 * Recover the raw request body on hosts that pre-parse it.
 *
 * @param {import('node:http').IncomingMessage & {body?:unknown}} req - Host request.
 * @returns {Buffer|null} The bytes, or null when the stream is still unread.
 */
export function rawBodyFromParsed(req) {
  const body = req.body;
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  const contentType = String(req.headers?.['content-type'] || '');
  // Re-serialize in the wire format the handler parses. Overpass posts
  // `data=<QL>` as urlencoded, so JSON here would reach it as a malformed query.
  const text = contentType.includes('application/x-www-form-urlencoded')
    ? new URLSearchParams(body).toString()
    : JSON.stringify(body);
  return Buffer.from(text, 'utf8');
}

/**
 * Read an unconsumed request stream into a buffer.
 *
 * @param {import('node:stream').Readable} req - Request stream.
 * @returns {Promise<Buffer>}
 */
async function readStream(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Run the `/api/*` stack for one request.
 *
 * @param {import('node:http').IncomingMessage & {body?:unknown}} req - Host request.
 * @param {import('node:http').ServerResponse} res - Host response.
 * @param {{url?:string, stack?:MountedMiddleware[]}} [options] - `url` overrides
 *   the path to route on (a host may rewrite it); `stack` is for tests.
 * @returns {Promise<void>}
 */
export async function dispatchGevApi(req, res, { url = null, stack = null } = {}) {
  const targetUrl = url || req.url || '/';
  const pathname = new URL(targetUrl, 'http://localhost').pathname;
  const mounted = stack || serverlessStack();

  const parsed = rawBodyFromParsed(req);
  const rawBody = parsed !== null
    ? parsed
    : (req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readStream(req));

  for (const { route, fn } of mounted) {
    if (!mountMatches(pathname, route)) continue;
    const handled = await runMiddleware(fn, toMiddlewareRequest(req, {
      url: stripMount(targetUrl, route),
      rawBody,
    }), res);
    if (handled) return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: 'Not Found', path: pathname }));
}

/**
 * Invoke one middleware and report whether it took ownership of the response.
 *
 * A middleware that calls `next()` (or throws) has not answered; a thrown
 * error before any bytes were written is turned into a 502 so a host-level
 * crash page never replaces a JSON contract the client parses.
 *
 * @param {Function} fn - Middleware.
 * @param {object} req - Middleware request.
 * @param {import('node:http').ServerResponse} res - Response.
 * @returns {Promise<boolean>} True when the middleware handled the request.
 */
async function runMiddleware(fn, req, res) {
  let passed = false;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const onEnd = () => done();
      const done = (error) => {
        if (settled) return;
        settled = true;
        res.removeListener('finish', onEnd);
        res.removeListener('close', onEnd);
        if (error) reject(error);
        else resolve();
      };
      res.once('finish', onEnd);
      res.once('close', onEnd);
      const next = (error) => {
        passed = true;
        done(error instanceof Error ? error : undefined);
      };
      Promise.resolve(fn(req, res, next)).then(() => {
        // A handler that returned without answering and without calling next()
        // is still streaming; 'finish' resolves it.
        if (res.writableEnded) done();
      }, done);
    });
  } catch (error) {
    if (res.headersSent || res.writableEnded) throw error;
    console.error('[gev-api] middleware failed:', error?.stack || error?.message || error);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'Upstream proxy failed' }));
    return true;
  }
  return !passed;
}
