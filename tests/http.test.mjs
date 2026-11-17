import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHttp } from '../server/http.js';
import { createStore } from '../server/store.js';

let dir;
let uiDir;
let logs;
let servers;
let streams;
const log = (level, msg, data) => logs.push({ level, msg, data });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OWNER_KEY = 'owner-key-of-the-http-tests';
/** port -> 'name=value' of the open owner session. The helpers add it to every request (contract 6: /api needs it). */
const cookies = new Map();
const withSession = (port, headers) => (cookies.has(port) && !Object.keys(headers).some((name) => name.toLowerCase() === 'cookie')
  ? { ...headers, Cookie: cookies.get(port) } : headers);

async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await sleep(5);
  }
}

/** Create a server that the test run closes again. `setup(app)` adds routes before listen(). The owner session is opened. */
async function start(opts = {}, setup = () => {}) {
  const app = createHttp({ uiDir, log, ownerKey: OWNER_KEY, ...opts });
  servers.push(app);
  const extra = setup(app);
  const { port, url } = await app.listen();
  const opened = await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: OWNER_KEY }), headers: { 'X-WorkShop': '1' } });
  assert.equal(opened.status, 200, 'the owner session opens');
  cookies.set(port, opened.headers['set-cookie'][0].split(';')[0]);
  return { app, port, url, extra };
}

/**
 * One raw HTTP request. Only the owner cookie is added: no X-WorkShop header, no Origin. `headers.host`
 * overrides the Host header and `path` goes on the wire as it is (no URL normalising).
 */
function request(port, { method = 'GET', path: target = '/', headers: given = {}, body } = {}) {
  const headers = withSession(port, given);
  return new Promise((resolve, reject) => {
    // Node's client frames a body only for some methods, so the length is set by hand.
    const framed = Object.keys(headers).some((name) => ['content-length', 'transfer-encoding'].includes(name.toLowerCase()));
    const all = body === undefined || framed ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: all, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8'), json: () => JSON.parse(buffer.toString('utf8')) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Send raw bytes on a fresh socket and return everything the server answers until it closes. */
function rawExchange(port, text) {
  return new Promise((resolve, reject) => {
    let answer = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      answer += chunk;
    });
    socket.on('close', () => resolve(answer));
    socket.on('error', reject);
    socket.setTimeout(3000, () => socket.destroy(new Error('raw exchange timed out')));
  });
}

/** A request as the UI sends it: X-WorkShop on every call, JSON body. */
function call(port, method, target, body, headers = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return request(port, { method, path: target, body: payload, headers: { 'X-WorkShop': '1', 'Content-Type': 'application/json', ...headers } });
}

/** Open an SSE stream and collect what arrives. */
function openStream(port, target, given = {}) {
  const headers = withSession(port, given);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, headers, agent: false }, (res) => {
      const stream = {
        res,
        status: res.statusCode,
        headers: res.headers,
        text: '',
        ended: false,
        /** Parsed events: [{ id, data }] */
        events() {
          return stream.text.split('\n\n').filter((block) => block.includes('data: ')).map((block) => {
            const lines = block.split('\n');
            const id = lines.find((line) => line.startsWith('id: '));
            return { id: id ? Number(id.slice(4)) : null, data: JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6)) };
          });
        },
        close() {
          req.destroy();
        },
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.text += chunk;
      });
      res.on('end', () => {
        stream.ended = true;
      });
      res.on('error', () => {
        stream.ended = true;
      });
      streams.push(stream);
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-http-'));
  uiDir = path.join(dir, 'ui');
  fs.mkdirSync(path.join(uiDir, 'panels'), { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>WorkShop</title>');
  fs.writeFileSync(path.join(uiDir, 'app.js'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(uiDir, 'panels', 'board.js'), 'export const board = 1;\n');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'TOP SECRET');
  logs = [];
  servers = [];
  streams = [];
});

afterEach(async () => {
  for (const stream of streams) stream.close();
  await Promise.all(servers.map((app) => app.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('http: router', () => {
  test('listen() on port 0 returns the real port; a returned object is sent as JSON 200', async () => {
    const { port, url } = await start({}, (app) => app.route('GET', '/api/state', () => ({ seq: 3, state: { jobs: {} } })));
    assert.ok(Number.isInteger(port) && port > 0);
    assert.equal(url, `http://127.0.0.1:${port}`);
    const res = await request(port, { path: '/api/state' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { seq: 3, state: { jobs: {} } });
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['access-control-allow-origin'], undefined); // no CORS headers
    const viaLocalhost = await request(port, { path: '/api/state', headers: { host: `LocalHost:${port}` } });
    assert.equal(viaLocalhost.status, 200);
  });

  test(':params and the query reach the handler, decoded', async () => {
    const { port } = await start({}, (app) => {
      app.route('GET', '/api/jobs/:id/diff', ({ params, query }) => ({ params, query }));
      app.route('GET', '/api/agents/:agent/log/:line', ({ params }) => params);
    });
    const res = await request(port, { path: '/api/jobs/J%201/diff?path=src%2Fa%20b.js&delivery=D1&empty=&twice=1&twice=2' });
    assert.deepEqual(res.json(), { params: { id: 'J 1' }, query: { path: 'src/a b.js', delivery: 'D1', empty: '', twice: '2' } });
    assert.deepEqual((await request(port, { path: '/api/agents/A7/log/12/' })).json(), { agent: 'A7', line: '12' }); // one trailing slash is fine
    assert.deepEqual((await request(port, { path: '/api/jobs/a%2Fb/diff' })).json().params, { id: 'a/b' });
    assert.equal((await request(port, { path: '/api/jobs//diff' })).status, 404); // an empty segment is no param
    assert.equal((await request(port, { path: '/api/jobs/%E0%A4%A/diff' })).status, 400); // broken percent code
  });

  test('a handler may return a value, answer through ctx, or be async', async () => {
    const { port } = await start({}, (app) => {
      app.route('POST', '/api/made', (ctx) => ctx.json(201, { id: 'J1' }));
      app.route('GET', '/api/diff', (ctx) => ctx.text(200, '--- a\n+++ b\n', 'text/x-diff; charset=utf-8'));
      app.route('GET', '/api/plain', (ctx) => ctx.text(200, 'héllo'));
      app.route('GET', '/api/string', () => 'just text');
      app.route('GET', '/api/list', async () => {
        await sleep(5);
        return [1, 2];
      });
      app.route('POST', '/api/nothing', () => {});
      app.route('GET', '/api/null', () => null);
      app.route('GET', '/api/short', (ctx) => ctx.json({ short: true }));
      app.route('GET', '/api/both', (ctx) => {
        ctx.json(202, { first: true });
        return { second: true };
      });
      app.route('GET', '/api/raw', ({ res }) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('raw');
      });
    });
    const made = await call(port, 'POST', '/api/made');
    assert.deepEqual([made.status, made.json()], [201, { id: 'J1' }]);
    const diff = await request(port, { path: '/api/diff' });
    assert.deepEqual([diff.status, diff.text, diff.headers['content-type']], [200, '--- a\n+++ b\n', 'text/x-diff; charset=utf-8']);
    const plain = await request(port, { path: '/api/plain' });
    assert.deepEqual([plain.text, plain.headers['content-type'], plain.headers['content-length']], ['héllo', 'text/plain; charset=utf-8', '6']);
    assert.equal((await request(port, { path: '/api/string' })).text, 'just text');
    assert.deepEqual((await request(port, { path: '/api/list' })).json(), [1, 2]);
    assert.deepEqual((await call(port, 'POST', '/api/nothing')).json(), { ok: true });
    assert.equal((await request(port, { path: '/api/null' })).json(), null);
    assert.deepEqual((await request(port, { path: '/api/short' })).json(), { short: true });
    const both = await request(port, { path: '/api/both' });
    assert.deepEqual([both.status, both.json()], [202, { first: true }]);
    assert.equal((await request(port, { path: '/api/raw' })).text, 'raw');
    const head = await request(port, { method: 'HEAD', path: '/api/list' });
    assert.deepEqual([head.status, head.text, head.headers['content-length']], [200, '', '5']);
  });

  test('JSON body: parsed, empty gives {}, bad JSON is 400', async () => {
    const seen = [];
    const { port } = await start({}, (app) => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        app.route(method, '/api/echo', ({ body }) => {
          seen.push(body);
          return { body };
        });
      }
    });
    assert.deepEqual((await call(port, 'POST', '/api/echo', { title: 'héllo', n: [1, 2] })).json(), { body: { title: 'héllo', n: [1, 2] } });
    assert.deepEqual((await call(port, 'PUT', '/api/echo', `${String.fromCharCode(0xfeff)}{"bom":true}`)).json(), { body: { bom: true } });
    assert.deepEqual((await call(port, 'PATCH', '/api/echo', '[1,"two"]')).json(), { body: [1, 'two'] });
    assert.deepEqual((await call(port, 'DELETE', '/api/echo')).json(), { body: {} });
    assert.deepEqual((await call(port, 'POST', '/api/echo', '  \n')).json(), { body: {} });
    assert.deepEqual((await call(port, 'POST', '/api/echo', '{"a":1}', { 'Content-Type': 'text/plain' })).json(), { body: { a: 1 } });
    assert.equal(seen.length, 6);
    for (const bad of ['{"a":', 'hello', "{'a':1}", '{"a":1}}']) {
      const res = await call(port, 'POST', '/api/echo', bad);
      assert.deepEqual([res.status, res.json()], [400, { error: 'request body is not valid JSON' }], bad);
    }
    assert.equal(seen.length, 6); // the handler never saw a bad body
  });

  test('JSON body: the limit is 2 MB, a larger body is 413', async () => {
    let calls = 0;
    const { port } = await start({}, (app) => app.route('POST', '/api/big', ({ body }) => {
      calls += 1;
      return { size: body.text.length };
    }));
    const wrap = (n) => JSON.stringify({ text: 'x'.repeat(n) });
    const fits = await call(port, 'POST', '/api/big', wrap(2 * 1024 * 1024 - 100));
    assert.deepEqual([fits.status, fits.json()], [200, { size: 2 * 1024 * 1024 - 100 }]);
    const over = await call(port, 'POST', '/api/big', wrap(2 * 1024 * 1024));
    assert.equal(over.status, 413);
    assert.match(over.json().error, /larger than 2097152 bytes/);
    const chunked = await call(port, 'POST', '/api/big', wrap(3 * 1024 * 1024), { 'Transfer-Encoding': 'chunked' });
    assert.equal(chunked.status, 413);
    assert.equal(calls, 1);
    // A body far over the limit is refused at once, before it is sent, and the connection is closed.
    const early = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/big', agent: false, headers: { 'X-WorkShop': '1', 'Content-Length': 500 * 1024 * 1024, Cookie: cookies.get(port) } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, connection: res.headers.connection });
        req.destroy();
      });
      req.on('error', reject);
      req.write('{"text":"');
    });
    assert.deepEqual(early, { status: 413, connection: 'close' });
    const small = await start({ bodyLimit: 64 }, (app) => app.route('POST', '/api/small', ({ body }) => body));
    assert.equal((await call(small.port, 'POST', '/api/small', { a: 1 })).status, 200);
    assert.equal((await call(small.port, 'POST', '/api/small', { text: 'x'.repeat(100) })).status, 413);
    assert.equal((await call(small.port, 'POST', '/api/small', { text: 'x'.repeat(1000) })).status, 413);
  });

  test('a thrown error is 500 { error } and logged; an error with .status uses it', async () => {
    const { port } = await start({}, (app) => {
      app.route('GET', '/api/boom', () => {
        throw new Error('kaboom');
      });
      app.route('GET', '/api/async-boom', async () => {
        await sleep(2);
        throw new Error('later kaboom');
      });
      app.route('POST', '/api/jobs/:id/ship', ({ params }) => {
        throw Object.assign(new Error(`no job ${params.id}`), { status: 404 });
      });
      app.route('GET', '/api/conflict', () => {
        throw Object.assign(new Error('truck is empty'), { status: 409 });
      });
      app.route('GET', '/api/odd', () => {
        throw Object.assign(new Error('odd status'), { status: 42 });
      });
      app.route('GET', '/api/string-throw', () => {
        throw 'a string'; // eslint-disable-line no-throw-literal
      });
      app.route('GET', '/api/loop', () => {
        const loop = {};
        loop.self = loop;
        return loop;
      });
      app.route('GET', '/mcp/:token', () => {
        throw new Error('tool failed');
      });
    });
    const boom = await request(port, { path: '/api/boom' });
    assert.deepEqual([boom.status, boom.json()], [500, { error: 'kaboom' }]);
    assert.deepEqual((await request(port, { path: '/api/async-boom' })).json(), { error: 'later kaboom' });
    const gone = await call(port, 'POST', '/api/jobs/J9/ship', {});
    assert.deepEqual([gone.status, gone.json()], [404, { error: 'no job J9' }]);
    assert.equal((await request(port, { path: '/api/conflict' })).status, 409);
    assert.equal((await request(port, { path: '/api/odd' })).status, 500);
    assert.deepEqual((await request(port, { path: '/api/string-throw' })).json(), { error: 'internal error' });
    assert.equal((await request(port, { path: '/api/loop' })).status, 500);
    assert.equal((await request(port, { path: '/mcp/secret-token-123' })).status, 500);
    const errors = logs.filter((l) => l.level === 'error');
    assert.equal(errors.length, 6); // boom, async-boom, odd, string-throw, loop, mcp
    assert.match(errors[0].msg, /GET \/api\/boom failed/);
    assert.match(errors[0].data.error, /kaboom/);
    assert.equal(JSON.stringify(logs).includes('secret-token-123'), false); // a token in the URL never reaches the log
    assert.ok(logs.some((l) => l.level === 'debug' && /POST \/api\/jobs\/:id\/ship -> 404/.test(l.msg)));
  });

  test('unknown /api route is 404 JSON, a wrong method is 405, routes are checked when added', async () => {
    const { port, app } = await start({}, (a) => {
      a.route('GET', '/api/keys', () => []);
      a.route('PUT', '/api/keys/:id', () => ({ ok: true }));
      a.route('delete', '/api/keys/:id', () => ({ ok: true }));
    });
    const missing = await request(port, { path: '/api/nope' });
    assert.deepEqual([missing.status, missing.json(), missing.headers['content-type']], [404, { error: 'not found' }, 'application/json; charset=utf-8']);
    assert.equal((await request(port, { path: '/api' })).status, 404);
    assert.equal((await request(port, { path: '/api/keys/extra/deep' })).status, 404);
    assert.equal((await call(port, 'POST', '/somewhere/else', {})).status, 404);
    const wrong = await call(port, 'POST', '/api/keys/anthropic', {});
    assert.deepEqual([wrong.status, wrong.json(), wrong.headers.allow], [405, { error: 'method not allowed' }, 'PUT, DELETE']);
    assert.equal((await call(port, 'DELETE', '/api/keys/anthropic')).status, 200);
    assert.throws(() => app.route('GET', '/api/keys', () => []), /already defined/);
    assert.throws(() => app.route('GET', 'api/keys', () => []), TypeError);
    assert.throws(() => app.route('GET', '/api/x', 'not a function'), TypeError);
  });

  test('a fixed segment beats a :param, whatever the order', async () => {
    const { port } = await start({}, (app) => {
      app.route('GET', '/api/items/:id', ({ params }) => ({ hit: 'param', id: params.id }));
      app.route('GET', '/api/items/special', () => ({ hit: 'fixed' }));
      app.route('GET', '/api/things/special', () => ({ hit: 'fixed' }));
      app.route('GET', '/api/things/:id', ({ params }) => ({ hit: 'param', id: params.id }));
    });
    assert.deepEqual((await request(port, { path: '/api/items/special' })).json(), { hit: 'fixed' });
    assert.deepEqual((await request(port, { path: '/api/items/other' })).json(), { hit: 'param', id: 'other' });
    assert.deepEqual((await request(port, { path: '/api/things/special' })).json(), { hit: 'fixed' });
    assert.deepEqual((await request(port, { path: '/api/things/T1' })).json(), { hit: 'param', id: 'T1' });
  });
});

describe('http: guards', () => {
  const routes = (app) => {
    const hits = [];
    app.route('GET', '/api/state', () => ({ ok: 'get' }));
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      app.route(method, '/api/act', () => {
        hits.push(method);
        return { ok: method };
      });
    }
    return hits;
  };

  test('Host must be 127.0.0.1:<port> or localhost:<port>', async () => {
    const { port } = await start({}, routes);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      assert.equal((await request(port, { path: '/api/state', headers: { host } })).status, 200, host);
      assert.equal((await request(port, { path: '/', headers: { host } })).status, 200, host);
    }
    const bad = ['evil.example', `evil.example:${port}`, '127.0.0.1', 'localhost', `127.0.0.1:${port + 1}`, `127.0.0.1.evil.example:${port}`,
      `[::1]:${port}`, `0.0.0.0:${port}`, `127.0.0.1:${port}.`];
    for (const host of bad) {
      for (const target of ['/api/state', '/', '/app.js']) {
        const res = await request(port, { path: target, headers: { host } });
        assert.deepEqual([res.status, res.json()], [403, { error: 'forbidden: bad Host header' }], `${host} ${target}`);
        assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      }
    }
    assert.ok(logs.some((l) => l.level === 'warn' && /refused/.test(l.msg) && l.data.host === 'evil.example'));
    // An empty or missing Host header never reaches a handler either.
    const empty = await rawExchange(port, 'GET /api/state HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
    assert.match(empty, /^HTTP\/1\.1 403 /);
    const missing = await rawExchange(port, 'GET /api/state HTTP/1.1\r\nConnection: close\r\n\r\n');
    assert.match(missing, /^HTTP\/1\.1 40[03] /);
    const old = await rawExchange(port, 'GET /api/state HTTP/1.0\r\n\r\n');
    assert.match(old, /^HTTP\/1\.1 40[03] /);
    assert.equal([empty, missing, old].some((answer) => answer.includes('"ok"')), false);
    // The right Host on a raw socket works, so the refusals above are about the header.
    assert.match(await rawExchange(port, `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookies.get(port)}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 200 /);
  });

  test('Origin, when present, must match', async () => {
    const { port, extra: hits } = await start({}, routes);
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `HTTP://LOCALHOST:${port}`]) {
      assert.equal((await request(port, { path: '/api/state', headers: { origin } })).status, 200, origin);
      assert.equal((await call(port, 'POST', '/api/act', {}, { origin })).status, 200, origin);
    }
    const bad = ['http://evil.example', 'null', `https://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`, 'http://127.0.0.1', `http://127.0.0.1:${port}/`,
      `http://localhost.evil.example:${port}`, ''];
    for (const origin of bad) {
      const get = await request(port, { path: '/api/state', headers: { origin } });
      assert.deepEqual([get.status, get.json()], [403, { error: 'forbidden: bad Origin header' }], origin);
      assert.equal((await request(port, { path: '/app.js', headers: { origin } })).status, 403, origin);
      assert.equal((await call(port, 'POST', '/api/act', {}, { origin })).status, 403, origin);
    }
    assert.deepEqual(hits, ['POST', 'POST', 'POST']);
  });

  test('every non-GET needs X-WorkShop: 1', async () => {
    const { port, extra: hits } = await start({}, routes);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const body = method === 'OPTIONS' ? undefined : '{"a":1}';
      const bare = await request(port, { method, path: '/api/act', body });
      assert.deepEqual([bare.status, bare.json()], [403, { error: 'forbidden: header X-WorkShop: 1 is required' }], method);
      assert.equal((await request(port, { method, path: '/api/act', body, headers: { 'X-WorkShop': '0' } })).status, 403, method);
      assert.equal((await request(port, { method, path: '/api/act', body, headers: { 'X-WorkShop': 'true' } })).status, 403, method);
      assert.deepEqual(hits, [], method);
      assert.equal((await request(port, { method, path: '/api/act', body, headers: { 'x-workshop': '1' } })).status, 200, method);
      hits.length = 0;
    }
    assert.equal((await request(port, { method: 'POST', path: '/api/nope' })).status, 403); // the guard runs before routing
    assert.equal((await request(port, { method: 'POST', path: '/index.html' })).status, 403);
    assert.equal((await request(port, { path: '/api/state' })).status, 200); // GET and HEAD need no header
    assert.equal((await request(port, { method: 'HEAD', path: '/api/state' })).status, 200);
    // A cross-site preflight gets no CORS answer.
    const preflight = await request(port, { method: 'OPTIONS', path: '/api/act', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  });

  test('no answer may be shown in a frame of another site', async () => {
    const { port } = await start({}, (app) => {
      app.route('GET', '/api/state', () => ({}));
      app.sse('/api/events');
    });
    const answers = [
      await request(port, { path: '/' }),
      await request(port, { path: '/api/state' }),
      await request(port, { path: '/api/nope' }),
      await request(port, { path: '/api/state', headers: { host: 'evil.example' } }),
      await request(port, { method: 'HEAD', path: '/api/events' }),
    ];
    assert.deepEqual(answers.map((res) => res.status), [200, 200, 404, 403, 200]);
    for (const res of answers) assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  });
});

describe('http: static files', () => {
  const TYPES = {
    'page.html': 'text/html; charset=utf-8',
    'code.js': 'text/javascript; charset=utf-8',
    'module.mjs': 'text/javascript; charset=utf-8',
    'style.css': 'text/css; charset=utf-8',
    'data.json': 'application/json; charset=utf-8',
    'code.js.map': 'application/json; charset=utf-8',
    'notes.txt': 'text/plain; charset=utf-8',
    'art.svg': 'image/svg+xml',
    'sprite.png': 'image/png',
    'favicon.ico': 'image/x-icon',
    'font.woff2': 'font/woff2',
    'SHOUT.PNG': 'image/png',
    'blob.bin': 'application/octet-stream',
    noext: 'application/octet-stream',
  };

  test('/ is index.html; every file type gets its MIME type and Cache-Control: no-store', async () => {
    for (const name of Object.keys(TYPES)) fs.writeFileSync(path.join(uiDir, name), `content of ${name}`);
    const { port } = await start();
    const index = await request(port, { path: '/' });
    assert.deepEqual([index.status, index.text, index.headers['content-type']], [200, '<!doctype html><title>WorkShop</title>', 'text/html; charset=utf-8']);
    assert.equal(index.headers['cache-control'], 'no-store');
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['content-length'], String(index.buffer.length));
    assert.equal(index.headers['access-control-allow-origin'], undefined);
    assert.equal((await request(port, { path: '/index.html' })).text, index.text);
    for (const [name, type] of Object.entries(TYPES)) {
      const res = await request(port, { path: `/${name}` });
      assert.deepEqual([res.status, res.text, res.headers['content-type'], res.headers['cache-control']], [200, `content of ${name}`, type, 'no-store'], name);
    }
    const nested = await request(port, { path: '/panels/board.js?v=12' });
    assert.deepEqual([nested.status, nested.text], [200, 'export const board = 1;\n']);
  });

  test('bytes arrive unchanged: binary, empty, names that need encoding; HEAD sends no body', async () => {
    const binary = Buffer.alloc(300_000);
    for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 31) % 256;
    fs.writeFileSync(path.join(uiDir, 'sprite.png'), binary);
    fs.writeFileSync(path.join(uiDir, 'empty.css'), '');
    fs.writeFileSync(path.join(uiDir, 'my file (1).txt'), 'spaced');
    const { port } = await start();
    const png = await request(port, { path: '/sprite.png' });
    assert.equal(png.headers['content-length'], '300000');
    assert.ok(png.buffer.equals(binary));
    const empty = await request(port, { path: '/empty.css' });
    assert.deepEqual([empty.status, empty.text, empty.headers['content-length'], empty.headers['content-type']], [200, '', '0', 'text/css; charset=utf-8']);
    assert.equal((await request(port, { path: '/my%20file%20(1).txt' })).text, 'spaced');
    const head = await request(port, { method: 'HEAD', path: '/sprite.png' });
    assert.deepEqual([head.status, head.buffer.length, head.headers['content-length'], head.headers['content-type']], [200, 0, '300000', 'image/png']);
  });

  test('missing files, folders, dotfiles and other methods are 404 JSON', async () => {
    fs.writeFileSync(path.join(uiDir, '.env'), 'HIDDEN=1');
    fs.mkdirSync(path.join(uiDir, '.git'));
    fs.writeFileSync(path.join(uiDir, '.git', 'config'), 'HIDDEN=1');
    const { port } = await start();
    for (const target of ['/nope.js', '/panels', '/panels/', '/panels/nope.js', '/index.html/extra', '/.env', '/.git/config', '/panels/.hidden']) {
      const res = await request(port, { path: target });
      assert.deepEqual([res.status, res.json(), res.headers['content-type']], [404, { error: 'not found' }, 'application/json; charset=utf-8'], target);
    }
    assert.equal((await call(port, 'POST', '/app.js', {})).status, 404);
    assert.equal((await call(port, 'DELETE', '/app.js')).status, 404);
    // Without a UI folder only the routes are served.
    const bare = await start({ uiDir: undefined }, (app) => app.route('GET', '/api/ping', () => ({ pong: true })));
    assert.equal((await request(bare.port, { path: '/' })).status, 404);
    assert.equal((await request(bare.port, { path: '/api/ping' })).status, 200);
    const gone = await start({ uiDir: path.join(dir, 'no-such-folder') });
    assert.equal((await request(gone.port, { path: '/' })).status, 404);
  });

  test('path traversal is refused: .., encoded .., backslashes, absolute paths, symlinks', async () => {
    const secret = path.join(dir, 'secret.txt');
    fs.symlinkSync(secret, path.join(uiDir, 'leak.txt'));
    fs.symlinkSync(dir, path.join(uiDir, 'up'));
    fs.symlinkSync(path.join(uiDir, 'app.js'), path.join(uiDir, 'alias.js'));
    const { port } = await start();
    const cases = [
      ['/../secret.txt', 403],
      ['/panels/../../secret.txt', 403],
      ['/panels/../app.js', 403], // every .. is refused, also one that stays inside ui/
      ['/%2e%2e/secret.txt', 403],
      ['/%2E%2E/secret.txt', 403],
      ['/.%2e/secret.txt', 403],
      ['/..%2fsecret.txt', 403],
      ['/%2e%2e%2fsecret.txt', 403],
      ['/panels/..%2f..%2fsecret.txt', 403],
      ['/..%5csecret.txt', 403],
      ['/app.js%00.png', 403],
      ['/%252e%252e/secret.txt', 404], // double encoding is only a strange file name
      ['/..../secret.txt', 404],
      [`/${secret}`, 404], // an absolute path stays under ui/
      [`/${encodeURIComponent(secret)}`, 404],
      ['//etc/passwd', 404],
      ['/%2Fetc%2Fpasswd', 404],
      ['/leak.txt', 403], // a symlink that leaves ui/
      ['/up/secret.txt', 403],
      ['/%', 400], // broken percent code
    ];
    for (const [target, status] of cases) {
      const res = await request(port, { path: target });
      assert.equal(res.status, status, target);
      assert.equal(res.text.includes('TOP SECRET'), false, target);
      assert.equal(typeof res.json().error, 'string', target);
    }
    // The same on a raw socket, where no client can tidy the path first.
    const raw = (target) => rawExchange(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    for (const target of ['/../secret.txt', '/../../../../../../etc/passwd', '/%2e%2e/%2e%2e/secret.txt', '/..\\secret.txt']) {
      const answer = await raw(target);
      assert.match(answer, /^HTTP\/1\.1 40[03] /, target);
      assert.equal(answer.includes('TOP SECRET') || answer.includes('root:'), false, target);
    }
    assert.match(await raw(`http://127.0.0.1:${port}/app.js`), /^HTTP\/1\.1 400 /); // absolute-form target
    assert.match(await raw('/app.js'), /^HTTP\/1\.1 200 /);
    // A symlink that stays inside ui/ is fine.
    assert.equal((await request(port, { path: '/alias.js' })).text, 'export const app = 1;\n');
  });
});

describe('http: server-sent events', () => {
  const note = (seq) => ({ seq, ts: 1000 + seq, type: 'notice', level: 'info', text: `note ${seq}` });
  const beats = (stream) => (stream.text.match(/^data: \{"type":"hb"/gm) ?? []).length;

  test('a stream gets live events with their seq as the SSE id; count() follows the clients', async () => {
    const { port, extra: feed } = await start({}, (app) => app.sse('/api/events'));
    assert.equal(feed.count(), 0);
    feed.send(note(1)); // nobody listens: no error
    const a = await openStream(port, '/api/events');
    assert.equal(a.status, 200);
    assert.match(a.headers['content-type'], /^text\/event-stream/);
    assert.equal(a.headers['cache-control'], 'no-store');
    assert.equal(a.headers['access-control-allow-origin'], undefined);
    const b = await openStream(port, '/api/events', { host: `localhost:${port}`, origin: `http://localhost:${port}` });
    assert.equal(feed.count(), 2);
    const task = { seq: 3, type: 'upsert', kind: 'tasks', item: { id: 'T1', title: 'two\nlines, café' } };
    feed.send(note(2));
    feed.send(task);
    feed.send({ type: 'fx', name: 'ship' }); // no seq: no id line
    await until(() => a.events().length === 3 && b.events().length === 3);
    assert.deepEqual(a.events(), [{ id: 2, data: note(2) }, { id: 3, data: task }, { id: null, data: { type: 'fx', name: 'ship' } }]);
    assert.deepEqual(b.events(), a.events());
    assert.match(a.text, /^retry: \d+\n\n/);
    // An event without a JSON form is skipped and logged. The stream goes on.
    const loop = { seq: 4, type: 'loop' };
    loop.self = loop;
    feed.send(loop);
    feed.send(note(5));
    await until(() => a.events().length === 4);
    assert.equal(a.events().at(-1).id, 5);
    assert.ok(logs.some((l) => l.level === 'error' && /no JSON form/.test(l.msg)));
    // A client that goes away is forgotten.
    a.close();
    await until(() => feed.count() === 1);
    feed.send(note(6));
    await until(() => b.events().at(-1).id === 6);
    b.close();
    await until(() => feed.count() === 0);
    feed.send(note(7)); // still no error
  });

  test('Last-Event-ID (or ?since=) replays the missed events first, then live ones follow', async () => {
    const past = [1, 2, 3, 4, 5].map(note);
    const asked = [];
    const { port, extra: feed } = await start({}, (app) => app.sse('/api/events', {
      replay(since) {
        asked.push(since);
        return past.filter((event) => event.seq > since);
      },
    }));
    const a = await openStream(port, '/api/events', { 'Last-Event-ID': '3' });
    feed.send(note(6));
    await until(() => a.events().length === 3);
    assert.deepEqual(a.events().map((e) => e.id), [4, 5, 6]);
    assert.deepEqual(a.events()[0].data, note(4));
    const b = await openStream(port, '/api/events?since=4');
    const c = await openStream(port, '/api/events?since=1', { 'Last-Event-ID': '5' }); // the header wins
    const d = await openStream(port, '/api/events?since=0');
    const e = await openStream(port, '/api/events'); // no id: no replay
    await until(() => b.events().length === 1 && d.events().length === 5);
    assert.deepEqual(b.events().map((ev) => ev.id), [5]);
    assert.deepEqual(d.events().map((ev) => ev.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(asked, [3, 4, 5, 0]);
    for (const bad of ['abc', '-1', '1.5', '1e3', '0x10']) {
      const viaHeader = await openStream(port, '/api/events', { 'Last-Event-ID': bad });
      const viaQuery = await openStream(port, `/api/events?since=${bad}`);
      assert.deepEqual([viaHeader.status, viaQuery.status], [200, 200], bad);
    }
    assert.deepEqual(asked, [3, 4, 5, 0]); // a bad id asks for no replay
    feed.send(note(7));
    await until(() => e.events().length === 1 && c.events().length === 1 && a.events().length === 4);
    assert.deepEqual(e.events().map((ev) => ev.id), [7]);
    assert.deepEqual(c.events().map((ev) => ev.id), [7]);
    assert.deepEqual(a.events().map((ev) => ev.id), [4, 5, 6, 7]);
  });

  test('a replay that throws is logged and the stream still works; each endpoint has its own clients', async () => {
    const { port, extra } = await start({}, (app) => ({
      broken: app.sse('/api/broken', {
        replay() {
          throw new Error('ring is gone');
        },
      }),
      plain: app.sse('/api/plain'),
      empty: app.sse('/api/empty', { replay: () => null }),
    }));
    const a = await openStream(port, '/api/broken', { 'Last-Event-ID': '1' });
    const b = await openStream(port, '/api/plain', { 'Last-Event-ID': '1' });
    const c = await openStream(port, '/api/empty', { 'Last-Event-ID': '1' });
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
    assert.ok(logs.some((l) => l.level === 'error' && /replay failed/.test(l.msg) && /ring is gone/.test(l.data.error)));
    extra.broken.send(note(2));
    extra.plain.send(note(3));
    extra.empty.send(note(4));
    await until(() => a.events().length === 1 && b.events().length === 1 && c.events().length === 1);
    assert.deepEqual([a.events()[0].id, b.events()[0].id, c.events()[0].id], [2, 3, 4]);
    assert.deepEqual([extra.broken.count(), extra.plain.count(), extra.empty.count()], [1, 1, 1]);
  });

  test('a heartbeat data message (no id line, no comment) goes out at every interval', async () => {
    const { port, extra: feed } = await start({ heartbeatMs: 20 }, (app) => app.sse('/api/events'));
    const a = await openStream(port, '/api/events');
    await until(() => beats(a) >= 3);
    assert.ok(a.events().every((e) => e.id === null && e.data.type === 'hb'), 'a heartbeat has no id line');
    assert.equal(/^:/m.test(a.text), false, 'no comment line: a page never sees a comment');
    feed.send(note(1));
    await until(() => a.events().some((e) => e.id === 1));
    // The heartbeat stops with the last client and starts again with the next one.
    a.close();
    await until(() => feed.count() === 0);
    const b = await openStream(port, '/api/events');
    await until(() => beats(b) >= 2);
    // The default interval is 5 s, so a short wait shows no heartbeat.
    const calm = await start({}, (app) => app.sse('/api/events'));
    const c = await openStream(calm.port, '/api/events');
    await sleep(120);
    assert.equal(beats(c), 0);
    assert.equal(calm.extra.count(), 1);
  });

  test('heartbeat(): one timer for all clients sends its event; a reconnect with Last-Event-ID replays from the last real id', async () => {
    const past = [];
    let seq = 0;
    let made = 0;
    const { port, extra: feed } = await start({ heartbeatMs: 25 }, (app) => app.sse('/api/events', {
      replay: (since) => past.filter((e) => e.seq > since),
      heartbeat: () => { made++; return { type: 'hb', seq }; },
    }));
    const a = await openStream(port, '/api/events');
    const b = await openStream(port, '/api/events');
    const live = (n) => { seq = n; const e = note(n); past.push(e); feed.send(e); };
    live(1);
    live(2);
    await until(() => beats(a) >= 3 && beats(b) >= 3);
    // One timer: each beat runs heartbeat() once and goes to both clients.
    assert.ok(made <= Math.max(beats(a), beats(b)) + 1, `heartbeat() ran ${made} times for ${beats(a)} and ${beats(b)} beats`);
    const hb = a.events().filter((e) => e.data.type === 'hb');
    assert.ok(hb.every((e) => e.id === null), 'no id line on a heartbeat');
    assert.ok(hb.some((e) => e.data.seq === 2), 'the heartbeat carries the current seq');
    // The last id the client saw is still the last real event: a reconnect replays only what came after it.
    const lastId = a.events().filter((e) => e.id !== null).at(-1).id;
    assert.equal(lastId, 2);
    a.close();
    live(3);
    const again = await openStream(port, '/api/events', { 'Last-Event-ID': String(lastId) });
    await until(() => again.events().some((e) => e.id === 3));
    assert.deepEqual(again.events().filter((e) => e.id !== null).map((e) => e.id), [3]);
    // A heartbeat that throws is logged; the stream goes on.
    const broken = await start({ heartbeatMs: 20 }, (app) => app.sse('/api/events', { heartbeat: () => { throw new Error('no seq'); } }));
    const c = await openStream(broken.port, '/api/events');
    await until(() => logs.some((l) => l.level === 'error' && /heartbeat failed/.test(l.msg)));
    broken.extra.send(note(9));
    await until(() => c.events().some((e) => e.id === 9));
  });

  test('a long replay does not count as a slow client', async () => {
    const past = Array.from({ length: 300 }, (_, i) => ({ seq: i + 1, type: 'agentlog', lines: 'x'.repeat(8 * 1024) }));
    const { port, extra: feed } = await start({ sseBufferLimit: 64 * 1024 }, (app) => app.sse('/api/events', {
      replay: (since) => past.filter((event) => event.seq > since),
    }));
    const a = await openStream(port, '/api/events', { 'Last-Event-ID': '0' }); // 2.4 MB of replay, far over the limit
    await until(() => a.text.includes('"seq":300,'));
    assert.equal(a.events().length, 300);
    assert.equal(feed.count(), 1);
    feed.send(note(301));
    await until(() => a.text.includes('"seq":301,'));
    assert.equal(logs.some((l) => /too slow/.test(l.msg)), false);
  });

  test('a client that does not read is dropped when its buffer passes the limit; others go on', async () => {
    const { port, extra: feed } = await start({ sseBufferLimit: 256 * 1024 }, (app) => app.sse('/api/events'));
    // A reader that only counts bytes, so the test holds no large string.
    let got = 0;
    let tail = '';
    const reader = http.request({ host: '127.0.0.1', port, path: '/api/events', agent: false, headers: { Cookie: cookies.get(port) } }, (res) => {
      res.on('data', (chunk) => {
        got += chunk.length;
        tail = (tail + chunk.toString('latin1')).slice(-256);
      });
      res.on('error', () => {});
    });
    reader.on('error', () => {});
    reader.end();
    streams.push({ close: () => reader.destroy() });
    await until(() => feed.count() === 1);
    // A client that asks for the stream and then never reads from its socket.
    const stuck = net.connect(port, '127.0.0.1');
    let stuckClosed = false;
    stuck.on('error', () => {});
    stuck.on('close', () => {
      stuckClosed = true;
    });
    streams.push({ close: () => stuck.destroy() });
    await once(stuck, 'connect');
    stuck.pause();
    stuck.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookies.get(port)}\r\n\r\n`);
    await until(() => feed.count() === 2);
    const blob = 'x'.repeat(64 * 1024);
    let sent = 0;
    while (feed.count() === 2 && sent < 2000) {
      sent += 1;
      feed.send({ seq: sent, type: 'agentlog', blob });
      await new Promise((resolve) => setImmediate(resolve)); // let the good reader read
    }
    assert.equal(feed.count(), 1, `nobody was dropped after ${sent} events`);
    assert.ok(logs.some((l) => l.level === 'warn' && /too slow/.test(l.msg) && l.data.buffered > 256 * 1024));
    stuck.resume(); // only now the stuck client looks at its socket: the server has cut it
    await until(() => stuckClosed);
    feed.send({ seq: sent + 1, type: 'last' });
    await until(() => tail.includes('"type":"last"'));
    assert.ok(got > sent * 64 * 1024);
    assert.equal(feed.count(), 1);
  });

  test('a late live copy of a replayed event is skipped; a stale Last-Event-ID loses nothing', async () => {
    const past = [1, 2, 3, 4, 5].map(note);
    const { port, extra: feed } = await start({}, (app) => app.sse('/api/events', {
      replay: (since) => past.filter((event) => event.seq > since),
    }));
    const resumed = await openStream(port, '/api/events', { 'Last-Event-ID': '3' }); // the replay holds 4 and 5
    const fresh = await openStream(port, '/api/events'); // no replay
    const stale = await openStream(port, '/api/events', { 'Last-Event-ID': '900' }); // an id from before a clean restart
    // A caller that batches its sends may repeat 4 and 5 after the replay.
    for (const seq of [4, 5, 6]) feed.send(note(seq));
    feed.send({ type: 'fx', name: 'ship' }); // no seq: never skipped
    await until(() => resumed.events().length === 4 && fresh.events().length === 4 && stale.events().length === 4);
    assert.deepEqual(resumed.events().map((e) => e.id), [4, 5, 6, null]); // 4 and 5 came once, from the replay
    assert.deepEqual(fresh.events().map((e) => e.id), [4, 5, 6, null]);
    assert.deepEqual(stale.events().map((e) => e.id), [4, 5, 6, null]); // a seq below its old id still arrives
  });

  test('the guards cover the stream; HEAD opens no stream', async () => {
    const { port, extra: feed } = await start({}, (app) => app.sse('/api/events'));
    assert.equal((await request(port, { path: '/api/events', headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await request(port, { path: '/api/events', headers: { origin: 'http://evil.example' } })).status, 403);
    const posted = await call(port, 'POST', '/api/events', {});
    assert.deepEqual([posted.status, posted.headers.allow], [405, 'GET']);
    const head = await request(port, { method: 'HEAD', path: '/api/events' });
    assert.deepEqual([head.status, head.text], [200, '']);
    assert.match(head.headers['content-type'], /^text\/event-stream/);
    assert.equal(feed.count(), 0);
  });
});

describe('http: body edge cases', () => {
  test('a body that is a bare null, number, string or boolean is 400; GET gets {}', async () => {
    let calls = 0;
    const { port } = await start({}, (app) => {
      app.route('POST', '/api/echo', ({ body }) => {
        calls += 1;
        return { body };
      });
      app.route('GET', '/api/echo', ({ body }) => ({ body }));
    });
    for (const bare of ['null', '42', '"text"', 'true']) {
      const res = await call(port, 'POST', '/api/echo', bare);
      assert.deepEqual([res.status, res.json()], [400, { error: 'request body must be a JSON object or list' }], bare);
    }
    assert.equal(calls, 0);
    assert.deepEqual((await request(port, { path: '/api/echo' })).json(), { body: {} });
  });

  test('a request that is cut off in the middle of its body does no harm', async () => {
    let calls = 0;
    const { port } = await start({}, (app) => app.route('POST', '/api/echo', () => {
      calls += 1;
      return {};
    }));
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write(`POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-WorkShop: 1\r\nCookie: ${cookies.get(port)}\r\nContent-Length: 100\r\n\r\n{"a":`);
    await sleep(30);
    socket.destroy();
    await until(() => logs.some((l) => /POST \/api\/echo -> 400/.test(l.msg)));
    assert.equal(calls, 0);
    assert.equal((await call(port, 'POST', '/api/echo', {})).status, 200);
    assert.equal(calls, 1);
    assert.equal(logs.some((l) => l.level === 'error'), false);
  });
});

describe('http: lifecycle', () => {
  test('close() ends the SSE clients and frees the port', async () => {
    const { app, port, extra: feed } = await start({}, (a) => {
      a.route('GET', '/api/ping', () => ({ pong: true }));
      return a.sse('/api/events');
    });
    const one = await openStream(port, '/api/events');
    const two = await openStream(port, '/api/events');
    assert.equal(feed.count(), 2);
    // An idle keep-alive connection must not hold close() back.
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/ping', agent, headers: { Cookie: cookies.get(port) } }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
    const began = Date.now();
    const closed = app.close();
    assert.equal(app.close(), closed); // a second call gives the same promise
    await closed;
    assert.ok(Date.now() - began < 1500, 'close() waited for the grace time');
    await until(() => one.ended && two.ended);
    assert.equal(feed.count(), 0);
    await assert.rejects(request(port, { path: '/api/ping' }), /ECONNREFUSED/);
    agent.destroy();
    feed.send({ seq: 1, type: 'notice' }); // after close: no error
  });

  test('close() cuts a request that never ends, after the grace time', async () => {
    let reached = false;
    const { app, port } = await start({ closeGraceMs: 80 }, (a) => a.route('GET', '/api/hang', () => {
      reached = true;
      return new Promise(() => {});
    }));
    const hung = request(port, { path: '/api/hang' });
    hung.catch(() => {});
    await until(() => reached);
    const began = Date.now();
    await app.close();
    const took = Date.now() - began;
    assert.ok(took >= 60 && took < 1500, `close() took ${took} ms`);
    await assert.rejects(hung);
  });

  test('close() before listen() resolves; listen() works once; a busy port rejects', async () => {
    const idle = createHttp({ uiDir, log, ownerKey: OWNER_KEY });
    await idle.close();
    const quick = createHttp({ uiDir, log, ownerKey: OWNER_KEY });
    const listening = quick.listen();
    await quick.close(); // close() waits for a listen() that is still on its way
    const taken = (await listening).port;
    await assert.rejects(request(taken, { path: '/' }), /ECONNREFUSED/);
    const { app, port } = await start();
    await assert.rejects(app.listen(), /already/);
    const clash = createHttp({ uiDir, log, port, ownerKey: OWNER_KEY });
    await assert.rejects(clash.listen(), (err) => err.code === 'EADDRINUSE');
    await clash.close();
    assert.equal((await request(port, { path: '/' })).status, 200); // the first server still works
  });

  test('listen(at): a busy preferred port rejects, then listen(0) works on the same server (the hub falls back)', async () => {
    const { port } = await start();
    const hub = createHttp({ uiDir, log, port, ownerKey: OWNER_KEY });
    servers.push(hub);
    await assert.rejects(hub.listen(), (err) => err.code === 'EADDRINUSE');
    await assert.rejects(hub.listen(-1), /0 to 65535/);
    const second = await hub.listen(0);
    assert.notEqual(second.port, port);
    assert.equal(second.url, `http://127.0.0.1:${second.port}`);
    // The session cookie and the Host guard follow the real port.
    const opened = await request(second.port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: OWNER_KEY }), headers: { 'X-WorkShop': '1', Cookie: 'x=1' } });
    assert.equal(opened.status, 200);
    const setCookie = opened.headers['set-cookie'][0];
    assert.match(setCookie, new RegExp(`^workshop_owner_${second.port}=`));
    assert.deepEqual(setCookie.split(';').slice(1).map((a) => a.trim()).sort(), ['HttpOnly', 'Path=/', 'SameSite=Strict'], 'not Secure, no expiry: the cookie lives as long as the hub and survives a reload');
    assert.equal((await request(second.port, { path: '/api/x', headers: { Cookie: 'x=1' } })).status, 401, 'no session cookie: 401');
    await assert.rejects(hub.listen(0), /already/);
  });

  test('the launcher calls: GET without a cookie is a fast 401; POST with Cookie and X-WorkShop and no Origin is served', async () => {
    const { port } = await start({}, (app) => app.route('POST', '/api/jobs/:id/pause', ({ params, body }) => ({ id: params.id, hard: body.hard })));
    const t0 = Date.now();
    const probe = await request(port, { path: '/api/state', headers: { Cookie: '' } });
    assert.equal(probe.status, 401);
    assert.ok(Date.now() - t0 < 1000);
    const r = await request(port, { method: 'POST', path: '/api/jobs/J%201/pause', body: '{"hard":true}', headers: { 'X-WorkShop': '1', 'Content-Type': 'application/json', Accept: 'application/json' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { id: 'J 1', hard: true });
  });

  test('a logger that throws, or no logger, does not break a request', async () => {
    const noisy = await start({ log: () => {
      throw new Error('logger is broken');
    } }, (app) => app.route('GET', '/api/boom', () => {
      throw new Error('kaboom');
    }));
    assert.deepEqual((await request(noisy.port, { path: '/api/boom' })).json(), { error: 'kaboom' });
    assert.equal((await request(noisy.port, { path: '/', headers: { host: 'evil.example' } })).status, 403);
    const quiet = await start({ log: undefined }, (app) => app.route('GET', '/api/boom', () => {
      throw new Error('kaboom');
    }));
    assert.equal((await request(quiet.port, { path: '/api/boom' })).status, 500);
  });
});

describe('http + store', () => {
  test('store events reach an SSE client live, and eventsSince() serves the replay', async () => {
    const store = createStore({ dataDir: path.join(dir, 'data'), log });
    const { port, extra: feed } = await start({}, (app) => app.sse('/api/events', { replay: (since) => store.eventsSince(since) }));
    const stop = store.subscribe((event) => feed.send(event));
    store.put('tasks', { id: 'T1', title: 'first' });
    const seen = store.state.seq; // what a page got from GET /api/state
    store.put('tasks', { id: 'T2', title: 'second' });
    store.emit('notice', { level: 'info', text: 'hello', jobId: null });
    const a = await openStream(port, `/api/events?since=${seen}`);
    await until(() => a.events().length === 2);
    store.patch('tasks', 'T1', { title: 'changed' });
    store.emit('agentlog', { agentId: 'A1', lines: [{ k: 'text', s: 'working' }] }, { persist: false });
    await until(() => a.events().length === 4);
    const events = a.events();
    assert.deepEqual(events.map((e) => e.data.type), ['upsert', 'notice', 'upsert', 'agentlog']);
    assert.deepEqual(events.map((e) => e.id), [seen + 1, seen + 2, seen + 3, seen + 4]);
    assert.equal(events[0].data.item.id, 'T2');
    assert.equal(events[2].data.item.title, 'changed');
    // A reconnect with the last id gets nothing twice.
    const b = await openStream(port, '/api/events', { 'Last-Event-ID': String(seen + 4) });
    store.emit('fx', { name: 'ship', payload: {} });
    await until(() => b.events().length === 1);
    assert.deepEqual(b.events().map((e) => e.id), [seen + 5]);
    assert.equal(a.events().length, 5);
    stop();
    await store.flush();
  });
});
