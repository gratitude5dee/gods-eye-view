import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  collectGevApiMiddlewares,
  dispatchGevApi,
  mountMatches,
  rawBodyFromParsed,
  stripMount,
  toMiddlewareRequest,
} from '../../server/app.js';
import { aisRelayTarget, aisStreamSupported, clientKey, unsupportedAisPayload } from '../../server/proxies.js';

/** Minimal ServerResponse stand-in: records what a middleware wrote. */
function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = '';
  res.headersSent = false;
  res.writableEnded = false;
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.headersSent = true;
  };
  res.end = (chunk) => {
    if (chunk) res.body += chunk;
    res.headersSent = true;
    res.writableEnded = true;
    res.emit('finish');
  };
  return res;
}

/** A request the dispatcher can route without a socket. */
function fakeRequest({ url, method = 'GET', headers = {}, body }) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = headers;
  if (body !== undefined) req.body = body;
  return req;
}

test('mount matching only breaks at a path boundary, so sibling routes stay separate', () => {
  assert.equal(mountMatches('/api/cctv', '/api/cctv'), true);
  assert.equal(mountMatches('/api/cctv/frame/x', '/api/cctv'), true);
  assert.equal(mountMatches('/api/cctv-admin', '/api/cctv'), false);
  assert.equal(mountMatches('/api/anything', '/'), true);
});

test('stripping the mount reproduces what Connect hands the middleware', () => {
  assert.equal(stripMount('/api/cctv/frame/x?w=2', '/api/cctv'), '/frame/x?w=2');
  assert.equal(stripMount('/api/cctv?w=2', '/api/cctv'), '/?w=2');
  assert.equal(stripMount('/api/cctv', '/api/cctv'), '/');
  assert.equal(stripMount('/api/cctv', '/'), '/api/cctv');
});

test('a pre-parsed urlencoded body is re-serialized in the wire format Overpass parses', () => {
  const req = fakeRequest({
    url: '/api/overpass',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: { data: '[out:json];node(1);out;' },
  });
  assert.equal(rawBodyFromParsed(req).toString('utf8'), 'data=%5Bout%3Ajson%5D%3Bnode%281%29%3Bout%3B');
});

test('a pre-parsed JSON body stays JSON, and an unread stream reports no body', () => {
  const json = fakeRequest({
    url: '/api/realtime/token',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { tier: 'standard' },
  });
  assert.equal(rawBodyFromParsed(json).toString('utf8'), '{"tier":"standard"}');
  assert.equal(rawBodyFromParsed(fakeRequest({ url: '/api/opensky' })), null);
});

test('the middleware request re-presents the consumed body as a fresh stream', async () => {
  const req = toMiddlewareRequest(
    fakeRequest({ url: '/api/overpass', method: 'POST', headers: { host: 'x' } }),
    { url: '/', rawBody: Buffer.from('data=abc', 'utf8') },
  );
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'data=abc');
  assert.equal(req.url, '/');
  assert.equal(req.method, 'POST');
});

test('every proxy plugin mounts under /api/, so nothing shadows the static site', () => {
  const stack = collectGevApiMiddlewares();
  assert.ok(stack.length >= 19, `expected the full proxy stack, saw ${stack.length}`);
  for (const { route, fn } of stack) {
    assert.ok(route.startsWith('/api/'), `unexpected mount ${route}`);
    assert.equal(typeof fn, 'function');
  }
});

test('dispatch routes on the rewritten URL and hands the handler the stripped path', async () => {
  const seen = [];
  const stack = [
    { route: '/api/cctv-admin', fn: (req, res) => { seen.push('admin'); res.end('admin'); } },
    { route: '/api/cctv', fn: (req, res) => { seen.push(req.url); res.end('frame'); } },
  ];
  const res = fakeResponse();
  await dispatchGevApi(fakeRequest({ url: '/api/gev?gevPath=cctv/frame/a' }), res, {
    url: '/api/cctv/frame/a?w=640',
    stack,
  });
  assert.deepEqual(seen, ['/frame/a?w=640']);
  assert.equal(res.body, 'frame');
});

test('a middleware that calls next() passes the request to the next mount', async () => {
  const stack = [
    { route: '/api/cctv', fn: (req, res, next) => next() },
    { route: '/api/cctv', fn: (req, res) => res.end('second') },
  ];
  const res = fakeResponse();
  await dispatchGevApi(fakeRequest({ url: '/api/cctv' }), res, { url: '/api/cctv', stack });
  assert.equal(res.body, 'second');
});

test('an unmatched path answers JSON 404, never an HTML host error page', async () => {
  const res = fakeResponse();
  await dispatchGevApi(fakeRequest({ url: '/api/nope' }), res, { url: '/api/nope', stack: [] });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(res.body), { error: 'Not Found', path: '/api/nope' });
});

test('a throwing middleware answers JSON 502 rather than crashing the invocation', async () => {
  const stack = [{ route: '/api/opensky', fn: () => { throw new Error('upstream exploded'); } }];
  const res = fakeResponse();
  await dispatchGevApi(fakeRequest({ url: '/api/opensky' }), res, { url: '/api/opensky', stack });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'Upstream proxy failed' });
});

test('AIS ownership follows the host: serverless declines the socket, GEV_AIS_STREAM overrides', () => {
  const saved = { vercel: process.env.VERCEL, forced: process.env.GEV_AIS_STREAM };
  try {
    delete process.env.VERCEL;
    delete process.env.GEV_AIS_STREAM;
    assert.equal(aisStreamSupported(), true);
    process.env.VERCEL = '1';
    assert.equal(aisStreamSupported(), false);
    process.env.GEV_AIS_STREAM = 'on';
    assert.equal(aisStreamSupported(), true);
    delete process.env.VERCEL;
    process.env.GEV_AIS_STREAM = 'off';
    assert.equal(aisStreamSupported(), false);
  } finally {
    if (saved.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.vercel;
    if (saved.forced === undefined) delete process.env.GEV_AIS_STREAM; else process.env.GEV_AIS_STREAM = saved.forced;
  }
});

test('the unsupported AIS body keeps the snapshot contract the vessel layer reads', () => {
  const payload = unsupportedAisPayload();
  assert.deepEqual(payload.rows, []);
  assert.equal(payload.status, 'unsupported');
  assert.equal(payload.refreshing, false);
  assert.ok(payload.error.includes('AIS_LIVE_RELAY_URL'));
});

test('the AIS relay target keeps the sub-path and query, and is absent without config', () => {
  const saved = process.env.AIS_LIVE_RELAY_URL;
  try {
    delete process.env.AIS_LIVE_RELAY_URL;
    assert.equal(aisRelayTarget('/track?mmsi=123456789'), null);
    process.env.AIS_LIVE_RELAY_URL = 'https://relay.example/api/ais-live/';
    assert.equal(
      aisRelayTarget('/track?mmsi=123456789').toString(),
      'https://relay.example/api/ais-live/track?mmsi=123456789',
    );
    assert.equal(aisRelayTarget('/?maxRows=5').toString(), 'https://relay.example/api/ais-live?maxRows=5');
  } finally {
    if (saved === undefined) delete process.env.AIS_LIVE_RELAY_URL;
    else process.env.AIS_LIVE_RELAY_URL = saved;
  }
});

test('rate-limit buckets follow the platform address on serverless, the socket peer locally', () => {
  const saved = process.env.VERCEL;
  const req = {
    socket: { remoteAddress: '10.0.0.7' },
    headers: { 'x-vercel-forwarded-for': '203.0.113.9, 10.0.0.7', 'x-forwarded-for': '1.2.3.4' },
  };
  try {
    delete process.env.VERCEL;
    assert.equal(clientKey(req), '10.0.0.7');
    process.env.VERCEL = '1';
    assert.equal(clientKey(req), '203.0.113.9');
    assert.equal(clientKey({ socket: { remoteAddress: '10.0.0.7' }, headers: {} }), '10.0.0.7');
  } finally {
    if (saved === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved;
  }
});
