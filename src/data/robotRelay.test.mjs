import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { robotTelemetryProxy } from '../../server/robotProxies.js';
import { MAX_ROBOTS } from './robotFrame.js';

const TOKEN = 'test-ingest-token';

/** Minimal ServerResponse stand-in: records what the middleware wrote. */
function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.write = (chunk) => { res.body += chunk; return true; };
  res.end = (chunk) => {
    if (chunk) res.body += chunk;
    res.writableEnded = true;
    res.emit('finish');
  };
  return res;
}

/** Build the mounted middleware exactly as Vite would. */
function mountRelay() {
  let middleware = null;
  const server = {
    middlewares: {
      use(route, fn) {
        assert.equal(route, '/api/robot');
        middleware = fn;
      },
    },
  };
  robotTelemetryProxy().configureServer(server);
  assert.ok(middleware, 'plugin must mount a middleware');
  return middleware;
}

/** Run one request through the middleware, resolving when the response ends. */
function run(middleware, { url, method = 'GET', headers = {}, body }) {
  const req = body === undefined
    ? Object.assign(new EventEmitter(), { url, method, headers })
    : Object.assign(Readable.from([Buffer.from(body, 'utf8')]), { url, method, headers });
  const res = fakeResponse();
  return new Promise((resolve, reject) => {
    res.on('finish', () => resolve(res));
    try {
      middleware(req, res, () => resolve(Object.assign(res, { fellThrough: true })));
    } catch (err) { reject(err); }
    // SSE never ends; give the caller the live response after a tick.
    if (url.startsWith('/stream')) setImmediate(() => resolve(res));
  });
}

function goodFrame(overrides = {}) {
  return {
    v: 1,
    id: 'g1-01',
    t: Date.now(),
    pose: { lat: 27.8361, lon: 86.7644, altM: 3867, headingDeg: 25, pitchDeg: 0, rollDeg: 0 },
    datum: 'egm96-orthometric',
    fix: { source: 'fused', hAccM: 2.5, vAccM: 4.0, sats: 11 },
    vel: { speedMps: 0.9, courseDeg: 25 },
    gait: { fsm: 'walk', footForce: [180, 20], contact: [true, false], cadenceHz: 1.8, strideM: 0.42 },
    power: { soc: 82, voltV: 51.2, currentA: 4.1, tempC: 38 },
    provenance: { source: 'synthetic', label: 'SIMULATED', confidence: 1.0 },
    ...overrides,
  };
}

function withToken(fn) {
  const prev = process.env.GEV_ROBOT_INGEST_TOKEN;
  process.env.GEV_ROBOT_INGEST_TOKEN = TOKEN;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.GEV_ROBOT_INGEST_TOKEN;
    else process.env.GEV_ROBOT_INGEST_TOKEN = prev;
  });
}

test('ingest requires the shared token — unset config 503s, wrong token 401s', () => withToken(async () => {
  const relay = mountRelay();
  const noToken = await run(relay, {
    url: '/ingest', method: 'POST', headers: {}, body: JSON.stringify([goodFrame()]),
  });
  assert.equal(noToken.statusCode, 401);

  delete process.env.GEV_ROBOT_INGEST_TOKEN;
  const unconfigured = await run(relay, {
    url: '/ingest', method: 'POST', headers: { 'x-gev-robot-token': TOKEN }, body: '[]',
  });
  assert.equal(unconfigured.statusCode, 503);
  process.env.GEV_ROBOT_INGEST_TOKEN = TOKEN;
}));

test('a valid batch is accepted, rx-stamped, and served by /telemetry', () => withToken(async () => {
  const relay = mountRelay();
  const before = Date.now();
  const posted = await run(relay, {
    url: '/ingest',
    method: 'POST',
    headers: { 'x-gev-robot-token': TOKEN },
    body: JSON.stringify([goodFrame()]),
  });
  assert.equal(posted.statusCode, 200);
  assert.deepEqual(JSON.parse(posted.body), { accepted: 1 });

  const snapshot = await run(relay, { url: '/telemetry' });
  assert.equal(snapshot.statusCode, 200);
  const { robots } = JSON.parse(snapshot.body);
  assert.equal(robots.length, 1);
  assert.equal(robots[0].id, 'g1-01');
  assert.ok(robots[0].rx >= before, 'server must stamp rx');
}));

test('a malformed frame rejects the WHOLE batch — no prefix salvage', () => withToken(async () => {
  const relay = mountRelay();
  const posted = await run(relay, {
    url: '/ingest',
    method: 'POST',
    headers: { 'x-gev-robot-token': TOKEN },
    body: JSON.stringify([goodFrame(), goodFrame({ pose: { ...goodFrame().pose, lat: 91 } })]),
  });
  assert.equal(posted.statusCode, 400);
  const snapshot = await run(relay, { url: '/telemetry' });
  assert.deepEqual(JSON.parse(snapshot.body).robots, []);
}));

test('the robot cap holds — robot #17 is refused', () => withToken(async () => {
  const relay = mountRelay();
  const frames = [];
  for (let i = 0; i < MAX_ROBOTS; i += 1) frames.push(goodFrame({ id: `g1-${String(i).padStart(2, '0')}` }));
  const filled = await run(relay, {
    url: '/ingest', method: 'POST', headers: { 'x-gev-robot-token': TOKEN }, body: JSON.stringify(frames),
  });
  assert.equal(filled.statusCode, 200);
  const overflow = await run(relay, {
    url: '/ingest',
    method: 'POST',
    headers: { 'x-gev-robot-token': TOKEN },
    body: JSON.stringify([goodFrame({ id: 'one-too-many' })]),
  });
  assert.equal(overflow.statusCode, 409);
}));

test('accepted frames fan out to connected SSE clients', () => withToken(async () => {
  const relay = mountRelay();
  const stream = await run(relay, { url: '/stream' });
  assert.equal(stream.headers['content-type'], 'text/event-stream');
  await run(relay, {
    url: '/ingest', method: 'POST', headers: { 'x-gev-robot-token': TOKEN }, body: JSON.stringify([goodFrame()]),
  });
  assert.ok(stream.body.includes('"g1-01"'), 'SSE client must receive the accepted frame');
}));

test('reserved endpoints answer 501 — commands stay disabled in this build', async () => {
  const relay = mountRelay();
  const command = await run(relay, { url: '/command', method: 'POST', headers: {}, body: '{}' });
  assert.equal(command.statusCode, 501);
  const map = await run(relay, { url: '/map' });
  assert.equal(map.statusCode, 501);
});
