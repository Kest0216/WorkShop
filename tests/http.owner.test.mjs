// The owner gate of server/http.js against the whole route table of contract section 6 (review item A01).
// Every /api route, GET and SSE included, answers 401 without the owner cookie. POST /api/session is the only
// exception. An agent token opens nothing under /api. The owner key and the session value never reach the log.
// Run: node --test tests/http.owner.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHttp } from '../server/http.js';

const OWNER_KEY = 'b'.repeat(20) + '-owner-key-of-the-gate-tests-' + 'c'.repeat(20);
const AGENT_TOKEN = 'agent-token-of-the-gate-tests-0123456789';

/** Every /api route of contract section 6 (besides POST /api/session and the SSE stream). */
const ROUTES = [
  ['GET', '/api/state'],
  ['POST', '/api/jobs'], ['POST', '/api/jobs/:id/pause'], ['POST', '/api/jobs/:id/resume'], ['POST', '/api/jobs/:id/cancel'],
  ['DELETE', '/api/jobs/:id'], ['POST', '/api/jobs/:id/plan/approve'], ['POST', '/api/jobs/:id/reqs'],
  ['POST', '/api/jobs/:id/reqs/:rid/waive'], ['GET', '/api/jobs/:id/truck'], ['POST', '/api/jobs/:id/ship'],
  ['POST', '/api/jobs/:id/truck/discard'], ['POST', '/api/jobs/:id/changes'], ['GET', '/api/jobs/:id/diff'],
  ['POST', '/api/tasks/:id/stop'], ['POST', '/api/tasks/:id/retry'], ['POST', '/api/tasks/:id/cancel'],
  ['GET', '/api/board'], ['POST', '/api/board'], ['GET', '/api/inbox'], ['PUT', '/api/presence'], ['GET', '/api/agents/:id/log'],
  ['GET', '/api/providers'], ['POST', '/api/providers/detect'], ['PUT', '/api/providers/:id/mode'], ['POST', '/api/providers/:id/login'],
  ['POST', '/api/providers/:id/check'], ['POST', '/api/providers/:id/selftest'],
  ['GET', '/api/keys'], ['PUT', '/api/keys/:id'], ['DELETE', '/api/keys/:id'],
  ['GET', '/api/settings'], ['PUT', '/api/settings'], ['GET', '/api/models'], ['PUT', '/api/models'], ['POST', '/api/models/refresh'],
  ['GET', '/api/projects/:id/toolkit'], ['PUT', '/api/projects/:id/toolkit'], ['POST', '/api/projects/:id/toolkit/:toolId/run'],
  ['POST', '/api/projects/:id/agentfiles'], ['POST', '/api/pick-folder'], ['POST', '/api/reveal'], ['POST', '/api/demo'],
];
const concrete = (pattern) => pattern.replace(/:(\w+)/g, (_, name) => `${name.toUpperCase()}1`);

let tmp;
let logs;
let servers;
const log = (level, msg, data) => logs.push({ level, msg, data });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-gate-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>WorkShop</title>');
  fs.writeFileSync(path.join(tmp, 'app.js'), 'export {};');
  logs = [];
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((app) => app.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A hub with every contract route, the SSE stream and the two agent routes. `hits` records each handler that ran. */
async function hub() {
  const app = createHttp({ uiDir: tmp, log, ownerKey: OWNER_KEY });
  servers.push(app);
  const hits = [];
  for (const [method, pattern] of ROUTES) app.route(method, pattern, () => {
    hits.push(`${method} ${pattern}`);
    return { ok: true };
  });
  app.route('POST', '/mcp/:token', ({ params }) => {
    hits.push('mcp');
    return { agent: params.token };
  });
  app.route('GET', '/mcp/:token/tag', (ctx) => {
    hits.push('tag');
    ctx.text(204, '');
  });
  const feed = app.sse('/api/events', { replay: () => [{ seq: 1, type: 'notice' }] });
  const { port } = await app.listen();
  return { app, port, hits, feed };
}

/** One request; resolves with status, headers and text. An SSE answer is read up to its first chunk. */
function request(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const all = body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: all, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if (String(res.headers['content-type']).startsWith('text/event-stream')) {
          resolve({ status: res.statusCode, headers: res.headers, text });
          req.destroy();
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', () => {});
    });
    req.on('error', reject);
    req.end(body);
  });
}

const send = (port, method, target, headers = {}) => request(port, {
  method, path: target, body: method === 'GET' || method === 'HEAD' ? undefined : '{"jobId":"J1","k":"x"}',
  headers: { 'X-WorkShop': '1', 'Content-Type': 'application/json', ...headers },
});

async function login(port) {
  const res = await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: OWNER_KEY }), headers: { 'X-WorkShop': '1' } });
  assert.equal(res.status, 200);
  return res.headers['set-cookie'][0].split(';')[0];
}

test('every contract /api route, the SSE stream and unknown /api paths answer 401 without the cookie', async () => {
  const { port, hits, feed } = await hub();
  const targets = [...ROUTES.map(([method, pattern]) => [method, concrete(pattern)]), ['GET', '/api/events'], ['GET', '/api/events?since=0'],
    ['HEAD', '/api/state'], ['HEAD', '/api/events'], ['GET', '/api/x'], ['POST', '/api/x'], ['GET', '/api'], ['GET', '/api/'],
    ['GET', '/api/state?k=' + OWNER_KEY], ['GET', '/%61pi/state'], ['GET', '/api/%73tate'], ['GET', '/api/jobs/J1/../../state'],
    ['PATCH', '/api/state'], ['OPTIONS', '/api/state'], ['GET', '/api/session'], ['DELETE', '/api/session']];
  for (const [method, target] of targets) {
    const res = await send(port, method, target);
    assert.equal(res.status, 401, `${method} ${target}`);
    assert.equal(res.headers['set-cookie'], undefined, `${method} ${target}`);
    if (method !== 'HEAD') assert.deepEqual(JSON.parse(res.text), { error: 'owner session required' }, `${method} ${target}`);
  }
  assert.deepEqual(hits, []);
  assert.equal(feed.count(), 0);
});

test('an agent token opens nothing under /api, in any header, cookie or query; it works on /mcp only', async () => {
  const { port, hits, feed } = await hub();
  const carriers = [
    { Authorization: `Bearer ${AGENT_TOKEN}` }, { Authorization: AGENT_TOKEN }, { 'X-Agent-Token': AGENT_TOKEN },
    { Cookie: `workshop_owner_${port}=${AGENT_TOKEN}` }, { Cookie: `workshop_owner=${AGENT_TOKEN}` }, { Cookie: `token=${AGENT_TOKEN}` },
  ];
  for (const [method, pattern] of [...ROUTES, ['GET', '/api/events']]) {
    for (const headers of carriers) {
      assert.equal((await send(port, method, concrete(pattern), headers)).status, 401, `${method} ${pattern} ${JSON.stringify(headers)}`);
    }
    assert.equal((await send(port, method, `${concrete(pattern)}?token=${AGENT_TOKEN}`)).status, 401, `${method} ${pattern} ?token`);
  }
  assert.equal((await send(port, 'GET', `/api/mcp/${AGENT_TOKEN}`)).status, 401);
  assert.deepEqual(hits, []);
  assert.equal(feed.count(), 0);
  // The agent routes need no cookie.
  assert.equal((await send(port, 'POST', `/mcp/${AGENT_TOKEN}`)).status, 200);
  assert.equal((await request(port, { path: `/mcp/${AGENT_TOKEN}/tag` })).status, 204);
  assert.deepEqual(hits, ['mcp', 'tag']);
});

test('static files need no cookie; the cookie opens every route and the stream', async () => {
  const { port, hits } = await hub();
  for (const target of ['/', '/index.html', '/app.js']) assert.equal((await request(port, { path: target })).status, 200, target);
  const cookie = await login(port);
  for (const [method, pattern] of ROUTES) {
    const res = await send(port, method, concrete(pattern), { Cookie: cookie });
    assert.equal(res.status, 200, `${method} ${pattern}`);
  }
  assert.equal(hits.length, ROUTES.length);
  const live = await request(port, { path: '/api/events?since=0', headers: { Cookie: cookie } });
  assert.equal(live.status, 200);
  assert.match(live.text, /"seq":1/); // the replay came through
  assert.equal((await send(port, 'GET', '/api/x', { Cookie: cookie })).status, 404); // unknown /api route: 404 for the owner
});

test('the session cookie: HttpOnly, SameSite=Strict, Path=/, random per hub run, not the key', async () => {
  const a = await hub();
  const b = await hub();
  const res = await request(a.port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: OWNER_KEY }), headers: { 'X-WorkShop': '1' } });
  const [setCookie] = res.headers['set-cookie'];
  assert.match(setCookie, /; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.equal(setCookie.includes(OWNER_KEY), false);
  const cookie = setCookie.split(';')[0];
  const other = await login(b.port);
  assert.notEqual(cookie.split('=')[1], other.split('=')[1]); // two hubs, two random values
  // The cookie of hub A, under the cookie name of hub B, does not open hub B.
  const forged = `${other.split('=')[0]}=${cookie.split('=')[1]}`;
  assert.equal((await send(b.port, 'GET', '/api/state', { Cookie: forged })).status, 401);
  assert.equal((await send(b.port, 'GET', '/api/state', { Cookie: other })).status, 200);
});

test('a wrong key: 401 and no cookie, whatever its shape; the key travels in the body only', async () => {
  const { port } = await hub();
  const bodies = [{}, { k: '' }, { k: OWNER_KEY.slice(0, -1) }, { k: `${OWNER_KEY} ` }, { k: [OWNER_KEY] }, { K: OWNER_KEY }, [OWNER_KEY], { k: null }];
  for (const body of bodies) {
    const res = await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify(body), headers: { 'X-WorkShop': '1' } });
    assert.deepEqual([res.status, res.headers['set-cookie']], [401, undefined], JSON.stringify(body));
  }
  for (const headers of [{ Authorization: `Bearer ${OWNER_KEY}` }, { Cookie: `workshop_owner_${port}=${OWNER_KEY}` }, { 'X-Owner-Key': OWNER_KEY }]) {
    assert.equal((await send(port, 'GET', '/api/state', headers)).status, 401, JSON.stringify(headers));
  }
  assert.equal((await send(port, 'GET', `/api/state?k=${encodeURIComponent(OWNER_KEY)}`)).status, 401);
  // A cross-site page cannot log in: the Origin guard and X-WorkShop come first.
  const cross = await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: OWNER_KEY }), headers: { 'X-WorkShop': '1', Origin: 'http://evil.example' } });
  assert.deepEqual([cross.status, cross.headers['set-cookie']], [403, undefined]);
  const bare = await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: OWNER_KEY }) });
  assert.deepEqual([bare.status, bare.headers['set-cookie']], [403, undefined]);
});

test('neither the owner key nor the session value reaches the log, over a whole session', async () => {
  const { app, port } = await hub();
  app.route('POST', '/api/boom', () => {
    throw new Error('handler failed');
  });
  const cookie = await login(port);
  const value = cookie.split('=')[1];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 1050)); // refusals are logged at most once a second
  await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: `${OWNER_KEY}x` }), headers: { 'X-WorkShop': '1' } });
  await pause();
  await send(port, 'GET', '/api/state', { Cookie: `${cookie}x` });
  await pause();
  await request(port, { method: 'POST', path: '/api/session', body: `{"k":"${OWNER_KEY}"`, headers: { 'X-WorkShop': '1' } }); // bad JSON
  await send(port, 'POST', '/api/boom', { Cookie: cookie });
  await send(port, 'GET', '/api/nope', { Cookie: cookie });
  // Raw bytes: a request line that the server cannot parse, with the key in it.
  await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(`GET /${OWNER_KEY} HTTP/1.1\r\nBad Header\r\n\r\n`));
    socket.on('close', resolve);
    socket.on('error', resolve);
    socket.resume();
  });
  assert.ok(logs.some((l) => /refused/.test(l.msg)), 'refusals were logged');
  assert.ok(logs.some((l) => l.level === 'error' && /POST \/api\/boom failed/.test(l.msg)), 'the failure was logged');
  const text = JSON.stringify(logs);
  assert.equal(text.includes(OWNER_KEY), false, 'the owner key is not in the log');
  assert.equal(text.includes(value), false, 'the session value is not in the log');
});
