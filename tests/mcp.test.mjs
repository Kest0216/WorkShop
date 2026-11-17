// Tests of the hub's MCP endpoint (server/mcp.js) and of the stdio shim (server/mcp-stdio-shim.mjs).
//
// The client request sequences in this file were recorded from the real Claude Code CLI 2.1.289 by the
// research probe (claude-probe/mcp/board-stdio.log.rpc.jsonl and board-http-d1-*.http.jsonl). They are
// copied here so that the tests do not need those files. One test replays the files themselves when
// they are still on this machine.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcp, mountMcp, validateArgs, PROTOCOL_VERSIONS } from '../server/mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(here, '..', 'server', 'mcp-stdio-shim.mjs');
const PROBE_DIR = process.env.WORKSHOP_PROBE_DIR ?? path.join(os.tmpdir(), 'claude-probe');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const EMOJI = String.fromCodePoint(0x1f600); // one character, two UTF-16 units, four UTF-8 bytes

// ---- recorded client behavior ----------------------------------------------------------------------

const CLAUDE_INIT_PARAMS = {
  protocolVersion: '2025-11-25',
  capabilities: { roots: { listChanged: true }, elicitation: { form: {}, url: {} } },
  clientInfo: {
    name: 'claude-code', title: 'Claude Code', version: '2.1.289',
    description: "Anthropic's agentic coding tool", websiteUrl: 'https://claude.com/claude-code',
  },
};

/** What Claude Code sends to a stdio MCP server, in order (the tool call is the one of the probe's board tool). */
const CLAUDE_STDIO = [
  { jsonrpc: '2.0', id: 0, method: 'initialize', params: CLAUDE_INIT_PARAMS },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: {
      name: 'board_post',
      arguments: { to: 'boss', kind: 'status', body: 'hello from maker-7' },
      _meta: { 'claudecode/toolUseId': 'toolu_mock_8da41ae13d17', progressToken: 2 },
    },
  },
];

const CLAUDE_HTTP_HEADERS = {
  accept: 'application/json, text/event-stream',
  'accept-encoding': 'identity',
  'content-type': 'application/json',
  'user-agent': 'claude-code/2.1.289 (sdk-cli)',
};

/**
 * What Claude Code sends to an HTTP MCP server, in order, and the status that the probe's reference server
 * gave. The recording kept only method and id of the discover probe, so its params are a guess.
 */
const CLAUDE_HTTP = [
  {
    method: 'POST', status: 200,
    headers: { ...CLAUDE_HTTP_HEADERS, 'mcp-method': 'server/discover', 'mcp-protocol-version': '2026-07-28' },
    rpc: { jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: { clientInfo: CLAUDE_INIT_PARAMS.clientInfo } },
  },
  { method: 'POST', status: 200, headers: CLAUDE_HTTP_HEADERS, rpc: CLAUDE_STDIO[0] },
  { method: 'POST', status: 202, headers: { ...CLAUDE_HTTP_HEADERS, 'mcp-protocol-version': '2025-11-25' }, rpc: CLAUDE_STDIO[1] },
  { method: 'GET', status: 405, headers: { accept: 'text/event-stream', 'accept-encoding': 'identity', 'user-agent': CLAUDE_HTTP_HEADERS['user-agent'], 'mcp-protocol-version': '2025-11-25' } },
  { method: 'POST', status: 200, headers: { ...CLAUDE_HTTP_HEADERS, 'mcp-protocol-version': '2025-11-25' }, rpc: CLAUDE_STDIO[2] },
  { method: 'POST', status: 200, headers: { ...CLAUDE_HTTP_HEADERS, 'mcp-protocol-version': '2025-11-25' }, rpc: CLAUDE_STDIO[3] },
];

// ---- helpers ---------------------------------------------------------------------------------------

const BOSS = { id: 'A1', role: 'boss', handle: '@b1', name: 'Gasket' };
const MANAGER = { id: 'A2', role: 'manager', handle: '@f1', name: 'Ratchet' };
const MAKER = { id: 'A3', role: 'maker', handle: '@m1', name: 'Sprocket' };

/** A store with the interface of contract section 5, as far as mcp.js uses it. */
function fakeStore(list = []) {
  const agents = new Map(list.map((agent) => [agent.id, agent]));
  const subscribers = new Set();
  return {
    get: (kind, id) => (kind === 'agents' ? agents.get(id) ?? null : null),
    put(kind, item) {
      if (kind === 'agents') agents.set(item.id, item);
      return item;
    },
    remove(kind, id) {
      if (kind !== 'agents' || !agents.delete(id)) return false;
      for (const fn of subscribers) fn({ type: 'remove', kind, id });
      return true;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

const POST_SCHEMA = { type: 'object', properties: { line: { type: 'string', maxLength: 800 } }, required: ['line'], additionalProperties: false };
const TASK_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 80 },
    spec: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' }, minItems: 1 },
    zones: { type: 'array', items: { type: 'string' }, minItems: 1 },
    domain: { enum: ['backend', 'frontend', 'test', 'docs'] },
    size: { enum: ['S', 'M', 'L'] },
    deps: { type: 'array', items: { type: 'string', pattern: '^T[0-9]+$' } },
    pair: { type: 'boolean' },
  },
  required: ['title', 'spec', 'acceptance', 'zones', 'domain', 'size'],
  additionalProperties: false,
};

/** A hub with one boss, one manager, one maker and a small tool set shaped like contract section 8. */
function hub(opts = {}) {
  const logs = [];
  const store = fakeStore([{ ...BOSS }, { ...MANAGER }, { ...MAKER }]);
  const mcp = createMcp({ store, log: (level, msg, data) => logs.push({ level, msg, data }), ...opts });
  const seen = []; // every handler run: { tool, agent, args }
  const state = { view: '', unread: 0 };
  const run = (tool, reply) => (agent, args) => {
    seen.push({ tool, agent: agent.id, args });
    return typeof reply === 'function' ? reply(agent, args) : reply;
  };
  mcp.registerTool('post', { roles: ['all'], description: 'One ShopTalk post.', inputSchema: POST_SCHEMA, handler: run('post', () => `ok ${seen.length}`) });
  mcp.registerTool('read', {
    roles: ['boss', 'manager', 'maker'], description: 'My board view.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' } }, additionalProperties: false },
    handler: run('read', () => {
      state.unread = 0;
      return state.view;
    }),
  });
  mcp.registerTool('claim', {
    roles: ['maker'], description: 'Ask to edit outside the zone.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['paths'], additionalProperties: false },
    handler: run('claim', 'granted'),
  });
  mcp.registerTool('status', { roles: ['manager', 'boss'], description: 'Tasks and agents.', handler: run('status', 'T1 working @m1') });
  mcp.registerTool('task_add', { roles: ['manager', 'boss'], description: 'New task.', inputSchema: TASK_SCHEMA, handler: run('task_add', 'T7 added') });
  mcp.registerTool('plan_submit', {
    roles: ['boss'], description: 'Submit the plan.',
    inputSchema: { type: 'object', properties: { tasks: { type: 'array', items: TASK_SCHEMA, maxItems: 40 }, notes: { type: 'string' } }, required: ['tasks'], additionalProperties: false },
    handler: run('plan_submit', async () => {
      await sleep(5);
      return { text: 'plan accepted' };
    }),
  });
  return { mcp, store, logs, seen, state, token: { boss: mcp.tokenFor(BOSS.id), manager: mcp.tokenFor(MANAGER.id), maker: mcp.tokenFor(MAKER.id) } };
}

let lastId = 100;
const req = (method, params, id = ++lastId) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const notice = (method, params) => ({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
const call = (name, args, id) => req('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) }, id);
const textOf = (response) => response.result.content.map((block) => block.text).join('\n');
const names = (response) => response.result.tools.map((tool) => tool.name);
const goodTask = () => ({ title: 'Add login', spec: 'Add a login form.', acceptance: ['The form logs in.'], zones: ['src/login/**'], domain: 'frontend', size: 'S' });

/** One raw HTTP request with exactly the given headers (no X-WorkShop, no Origin unless given). */
function httpRequest(port, { method = 'POST', path: target, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const all = payload === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(payload) };
    const request = http.request({ host: '127.0.0.1', port, method, path: target, headers: all, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const JSON_POST = { 'content-type': 'application/json', 'x-workshop': '1' };

/**
 * A small HTTP router with the interface and the request guards of contract sections 6 and 14b, so most
 * tests here do not depend on server/http.js. `honorNoHeaderCheck` adds the hook that mountMcp asks for:
 * a route registered with { noHeaderCheck: true } needs no X-WorkShop header.
 */
function contractHttp({ honorNoHeaderCheck = false } = {}) {
  const routes = [];
  const requests = []; // { method, url, headers } of every request
  let server = null;
  let port = 0;

  function find(method, pathname) {
    const parts = pathname.split('/');
    for (const route of routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params = {};
      const fits = route.parts.every((want, i) => {
        if (!want.startsWith(':')) return want === parts[i];
        params[want.slice(1)] = decodeURIComponent(parts[i]);
        return parts[i] !== '';
      });
      if (fits) return { route, params };
    }
    return null;
  }

  async function onRequest(req, res) {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const send = (status, type, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const json = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    const text = (status, value, type) => send(status, type ?? 'text/plain; charset=utf-8', String(value ?? ''));
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const host = String(req.headers.host ?? '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(403, { error: 'forbidden: bad Host header' });
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) return json(403, { error: 'forbidden: bad Origin header' });
      const url = new URL(req.url, 'http://hub');
      const safe = req.method === 'GET' || req.method === 'HEAD';
      const hit = find(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
      const exempt = honorNoHeaderCheck && hit?.route.options?.noHeaderCheck === true;
      if (!safe && !exempt && req.headers['x-workshop'] !== '1') return json(403, { error: 'forbidden: header X-WorkShop: 1 is required' });
      if (!hit) return json(404, { error: 'not found' });
      let body = {};
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!safe && raw.trim() !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          return json(400, { error: 'request body is not valid JSON' });
        }
      }
      const result = await hit.route.handler({ req, res, params: hit.params, query: Object.fromEntries(url.searchParams), body, json, text });
      if (!res.headersSent) json(200, result === undefined ? { ok: true } : result);
    } catch (err) {
      json(err.status ?? 500, { error: err.message });
    }
    return undefined;
  }

  async function listen(fixed = 0) {
    const created = http.createServer((req, res) => {
      onRequest(req, res);
    });
    await new Promise((resolve, reject) => {
      created.once('error', reject);
      created.listen(fixed, '127.0.0.1', resolve);
    });
    server = created;
    port = created.address().port;
    return { port, url: `http://127.0.0.1:${port}` };
  }

  /** Stop like a hub that died: every connection is cut. */
  async function close() {
    if (!server) return;
    const old = server;
    server = null;
    old.closeAllConnections();
    await new Promise((resolve) => old.close(resolve));
  }

  /** Come back on the same port. */
  async function reopen() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await listen(port);
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || attempt > 60) throw err;
        await sleep(50);
      }
    }
  }

  return {
    requests,
    route(method, pattern, handler, options) {
      routes.push({ method, parts: pattern.split('/'), handler, options });
    },
    listen,
    close,
    reopen,
  };
}

/** The stdio shim as a child process, driven like an agent CLI drives it. */
class Shim {
  constructor(url, { env = {}, args } = {}) {
    const base = { ...process.env, WORKSHOP_MCP_RETRY_MS: '300', ...env };
    for (const [key, value] of Object.entries(base)) if (value === undefined) delete base[key];
    if (!('WORKSHOP_MCP_URL' in env)) delete base.WORKSHOP_MCP_URL;
    this.child = spawn(process.execPath, [SHIM, ...(args ?? [url])], { env: base, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.stderr = '';
    this.buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (text) => {
      this.buffer += text;
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        this.lines.push(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => {
      this.stderr += text;
    });
    this.child.stdin.on('error', () => {});
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code, signal) => resolve({ code, signal }));
    });
    this.exited.then(() => {
      this.done = true;
    });
  }

  /** Write one message (an object, or raw text that gets a line break). */
  send(message) {
    this.child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  }

  /** The parsed stdout line that passes `match`; fails after `ms`. */
  async line(match, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      for (const text of this.lines) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          continue;
        }
        if (match(parsed)) return parsed;
      }
      if (Date.now() > end) throw new Error(`no matching line from the shim. stdout: ${JSON.stringify(this.lines)} stderr: ${this.stderr}`);
      if (this.done) await sleep(20); // one more look at what came before the exit
      await sleep(5);
    }
  }

  answer(id, ms) {
    return this.line((message) => !Array.isArray(message) && message.id === id, ms);
  }

  /** Close stdin and wait for the exit. */
  end() {
    this.child.stdin.end();
    return this.exited;
  }
}

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Mount an endpoint on a contract router and listen. `restartable` picks a port below the range that the
 * system hands out for port 0, so no other test can take the port while this hub is down on purpose.
 */
async function serve(mcp, { restartable = false, ...options } = {}) {
  const router = contractHttp(options);
  mountMcp(router, mcp);
  let address;
  for (let attempt = 0; address === undefined; attempt += 1) {
    try {
      address = await router.listen(restartable ? 20000 + Math.floor(Math.random() * 12000) : 0);
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt > 20) throw err;
    }
  }
  cleanups.push(() => router.close());
  return { router, ...address };
}

function startShim(url, options) {
  const shim = new Shim(url, options);
  cleanups.push(async () => {
    if (!shim.done) shim.child.kill('SIGKILL');
    await shim.exited;
  });
  return shim;
}

/** The probe's board tool, so that a recorded tools/call is valid here. */
function addReferenceTool(mcp) {
  let posts = 0;
  mcp.registerTool('board_post', {
    roles: ['all'],
    description: 'Post a message to the WorkShop message board.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, kind: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'kind', 'body'],
      additionalProperties: false,
    },
    handler: (agent, args) => `posted #${++posts} to ${args.to}`,
  });
}

// ---- tokens ------------------------------------------------------------------------------------------

describe('tokens', () => {
  test('a token is 32 random bytes as hex and stays the same for an agent', () => {
    const { mcp } = hub();
    const token = mcp.tokenFor('A3');
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(mcp.tokenFor('A3'), token);
    assert.notEqual(mcp.tokenFor('A1'), token);
    assert.equal(new Set(['A1', 'A2', 'A3'].map((id) => mcp.tokenFor(id))).size, 3);
  });

  test('agentFor gives the live agent of the store, or null', () => {
    const { mcp, store, token } = hub();
    assert.equal(mcp.agentFor(token.maker), store.get('agents', 'A3'));
    assert.equal(mcp.agentFor(token.boss).role, 'boss');
    for (const bad of ['', 'nope', token.maker.slice(0, 63), `${token.maker}0`, token.maker.toUpperCase(), 'x'.repeat(100_000), null, undefined, 42, {}, [token.maker]]) {
      assert.equal(mcp.agentFor(bad), null);
    }
  });

  test('a token is valid only while the agent is in the store', () => {
    const { mcp, store } = hub();
    const token = mcp.tokenFor('A9');
    assert.equal(mcp.agentFor(token), null);
    store.put('agents', { id: 'A9', role: 'maker' });
    assert.equal(mcp.agentFor(token).id, 'A9');
  });

  test('revoke makes the token invalid and the next token is new', async () => {
    const { mcp, token } = hub();
    mcp.revoke('A3');
    assert.equal(mcp.agentFor(token.maker), null);
    assert.equal((await mcp.handle(token.maker, req('ping', undefined, 1))).error.code, -32001);
    const fresh = mcp.tokenFor('A3');
    assert.notEqual(fresh, token.maker);
    assert.equal(mcp.agentFor(fresh).id, 'A3');
    assert.equal(mcp.agentFor(token.maker), null);
    mcp.revoke('never-seen'); // no error
  });

  test('an agent that leaves the store loses its token', () => {
    const { mcp, store, token } = hub();
    store.remove('agents', 'A3');
    store.put('agents', { ...MAKER });
    assert.equal(mcp.agentFor(token.maker), null, 'the old token must not come back with a new agent of the same id');
    assert.equal(mcp.agentFor(mcp.tokenFor('A3')).id, 'A3');
  });

  test('tokens die with the process: a new endpoint does not know them', () => {
    const first = hub();
    const second = hub();
    assert.equal(second.mcp.agentFor(first.token.maker), null);
    assert.notEqual(second.token.maker, first.token.maker);
  });

  test('tokenFor needs an id, and a store without subscribe is enough', () => {
    const { mcp } = hub();
    assert.throws(() => mcp.tokenFor(''), TypeError);
    assert.throws(() => mcp.tokenFor(7), TypeError);
    assert.throws(() => createMcp({}), TypeError);
    assert.throws(() => createMcp(), TypeError);
    const plain = createMcp({ store: { get: () => ({ id: 'A1', role: 'boss' }) } });
    assert.equal(plain.agentFor(plain.tokenFor('A1')).role, 'boss');
    const broken = createMcp({ store: { get: () => { throw new Error('store is down'); } } });
    assert.equal(broken.agentFor(broken.tokenFor('A1')), null);
  });

  test('the token table is bounded: agents that are not in the store go first, then the oldest', () => {
    const agents = [];
    for (let i = 0; i <= 2000; i++) if (i !== 5) agents.push({ id: `A${i}`, role: 'maker' });
    const store = fakeStore(agents);
    const logs = [];
    const mcp = createMcp({ store, log: (level, msg) => logs.push({ level, msg }) });
    const tokens = [];
    for (let i = 0; i < 2000; i++) tokens.push(mcp.tokenFor(`A${i}`)); // full
    assert.equal(logs.length, 0);
    tokens.push(mcp.tokenFor('A2000')); // one too many: A5 is not in the store, so its token goes
    assert.equal(mcp.agentFor(tokens[0]).id, 'A0');
    assert.equal(mcp.agentFor(tokens[2000]).id, 'A2000');
    const early = mcp.tokenFor('A5'); // one too many again: every other agent is alive, so the oldest token goes
    assert.notEqual(early, tokens[5]);
    assert.equal(mcp.agentFor(tokens[0]), null);
    assert.equal(mcp.agentFor(tokens[1]).id, 'A1');
    store.put('agents', { id: 'A5', role: 'maker' });
    assert.equal(mcp.agentFor(early).id, 'A5', 'a token for an agent that is not stored yet is never the one that goes');
    assert.equal(mcp.agentFor(tokens[5]), null);
    assert.ok(logs.every((entry) => entry.level === 'warn' && /too many agent tokens/.test(entry.msg)));
  });
});

// ---- registration and role filtering -------------------------------------------------------------------

describe('tools and roles', () => {
  test('tools/list gives each role its tools, in registration order', async () => {
    const { mcp, token } = hub();
    assert.deepEqual(names(await mcp.handle(token.maker, req('tools/list'))), ['post', 'read', 'claim']);
    assert.deepEqual(names(await mcp.handle(token.manager, req('tools/list'))), ['post', 'read', 'status', 'task_add']);
    assert.deepEqual(names(await mcp.handle(token.boss, req('tools/list'))), ['post', 'read', 'status', 'task_add', 'plan_submit']);
  });

  test('a listed tool has a short description, a JSON Schema and the always-load mark for Claude Code', async () => {
    const { mcp, token } = hub();
    const { tools } = (await mcp.handle(token.boss, req('tools/list'))).result;
    for (const tool of tools) {
      assert.deepEqual(Object.keys(tool).sort(), ['_meta', 'description', 'inputSchema', 'name']);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 0 && tool.description.length < 80);
      assert.deepEqual(tool._meta, { 'anthropic/alwaysLoad': true });
    }
    assert.deepEqual(tools.find((tool) => tool.name === 'post').inputSchema, POST_SCHEMA);
    assert.deepEqual(tools.find((tool) => tool.name === 'status').inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    assert.equal(JSON.stringify(tools).includes('handler'), false);
    const bare = createMcp({ store: fakeStore([{ ...MAKER }]), toolMeta: null });
    bare.registerTool('post', { roles: ['all'], description: 'One post.', handler: () => 'ok' });
    assert.equal('_meta' in (await bare.handle(bare.tokenFor('A3'), req('tools/list'))).result.tools[0], false);
  });

  test('toolsFor(role) shows the same tools without a token', () => {
    const { mcp } = hub();
    assert.deepEqual(mcp.toolsFor('maker').map((tool) => tool.name), ['post', 'read', 'claim']);
    assert.deepEqual(mcp.toolsFor('boss').map((tool) => tool.name), ['post', 'read', 'status', 'task_add', 'plan_submit']);
    assert.deepEqual(mcp.toolsFor('visitor').map((tool) => tool.name), ['post']); // only the tools for all roles
    assert.deepEqual(Object.keys(mcp.toolsFor('maker')[0]), ['name', 'description', 'inputSchema']);
    assert.throws(() => {
      mcp.toolsFor('maker')[0].inputSchema.properties.line.maxLength = 5;
    }, TypeError, 'a schema cannot be changed from outside');
  });

  test('a call to a tool of another role is refused and the handler does not run', async () => {
    const { mcp, token, seen, logs } = hub();
    const refused = await mcp.handle(token.maker, call('plan_submit', { tasks: [] }, 7));
    assert.deepEqual(refused, { jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'Unknown tool: plan_submit. Your tools: post, read, claim' } });
    assert.equal((await mcp.handle(token.manager, call('claim', { paths: ['a'] }))).error.code, -32602);
    assert.equal((await mcp.handle(token.boss, call('no_such_tool', {}))).error.code, -32602);
    assert.deepEqual(seen, []);
    assert.ok(logs.some((entry) => entry.level === 'warn' && entry.data?.tool === 'plan_submit' && entry.data.agent === 'A3'));
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['docs/a.md'] }))), 'granted');
    assert.equal(textOf(await mcp.handle(token.boss, call('plan_submit', { tasks: [goodTask()] }))), 'plan accepted');
  });

  test('the role is read from the store at every call', async () => {
    const { mcp, store, token } = hub();
    assert.equal((await mcp.handle(token.maker, call('status'))).error.code, -32602);
    store.get('agents', 'A3').role = 'manager';
    assert.equal(textOf(await mcp.handle(token.maker, call('status'))), 'T1 working @m1');
    store.put('agents', { ...MAKER, role: 'boss' }); // a new item with the same id
    assert.ok(names(await mcp.handle(token.maker, req('tools/list'))).includes('plan_submit'));
  });

  test('registerTool refuses a definition that cannot work', () => {
    const { mcp } = hub();
    const good = { roles: ['maker'], description: 'A tool.', handler: () => 'ok' };
    for (const name of ['', 'has space', 'x'.repeat(49), 'dot.name', 5, undefined]) {
      assert.throws(() => mcp.registerTool(name, good), TypeError, `name ${name}`);
    }
    assert.throws(() => mcp.registerTool('t', undefined), TypeError);
    assert.throws(() => mcp.registerTool('t', { ...good, handler: 'nope' }), /handler must be a function/);
    assert.throws(() => mcp.registerTool('t', { ...good, description: ' ' }), /description/);
    assert.throws(() => mcp.registerTool('t', { ...good, roles: undefined }), /roles/);
    assert.throws(() => mcp.registerTool('t', { ...good, roles: [] }), /roles/);
    assert.throws(() => mcp.registerTool('t', { ...good, roles: ['maker', 7] }), /roles/);
    assert.throws(() => mcp.registerTool('t', { ...good, inputSchema: 'string' }), /inputSchema/);
    assert.throws(() => mcp.registerTool('t', { ...good, inputSchema: { type: 'array' } }), /type must be "object"/);
    assert.deepEqual(mcp.toolsFor('maker').map((tool) => tool.name), ['post', 'read', 'claim'], 'nothing was added');
  });

  test('roles can be a list, "all" or "*", and a schema without a type is an object schema', () => {
    const { mcp } = hub();
    mcp.registerTool('a', { roles: 'all', description: 'A.', handler: () => 'a' });
    mcp.registerTool('b', { roles: ['*'], description: 'B.', handler: () => 'b' });
    mcp.registerTool('c', { roles: ['maker', 'all'], description: 'C.', inputSchema: { properties: { n: { type: 'integer' } } }, handler: () => 'c' });
    for (const role of ['boss', 'manager', 'maker']) {
      assert.deepEqual(mcp.toolsFor(role).map((tool) => tool.name).filter((name) => name.length === 1), ['a', 'b', 'c']);
    }
    assert.equal(mcp.toolsFor('maker').find((tool) => tool.name === 'c').inputSchema.type, 'object');
  });

  test('a second registration of a name replaces the tool and keeps its place', async () => {
    const { mcp, token, logs } = hub();
    mcp.registerTool('read', { roles: ['maker'], description: 'A new read.', handler: () => 'the new one' });
    assert.deepEqual(mcp.toolsFor('maker').map((tool) => tool.name), ['post', 'read', 'claim']);
    assert.equal(textOf(await mcp.handle(token.maker, call('read'))), 'the new one');
    assert.equal((await mcp.handle(token.boss, call('read'))).error.code, -32602);
    assert.ok(logs.some((entry) => entry.level === 'warn' && /registered twice/.test(entry.msg)));
  });

  test('registration warns about things that will not work as the author expects', () => {
    const { mcp, logs } = hub();
    mcp.registerTool('odd', {
      roles: ['maker', 'reviewer'], description: 'Odd.',
      inputSchema: { type: 'object', properties: { a: { type: 'string', format: 'uri', description: 'x' }, b: { not: { type: 'null' } }, c: { type: 'array', uniqueItems: true } }, oneOf: [{ required: ['a'] }, { required: ['b'] }] },
      handler: () => 'ok',
    });
    const warned = logs.filter((entry) => entry.level === 'warn');
    assert.deepEqual(logs.find((entry) => entry.level === 'info' && entry.data?.roles)?.data, { tool: 'odd', roles: ['reviewer'] });
    assert.deepEqual(warned.find((entry) => entry.data?.keywords)?.data.keywords.sort(), ['not', 'uniqueItems']);
    assert.ok(warned.some((entry) => /top of an input schema/.test(entry.msg)));
    assert.equal(warned.some((entry) => /long tool description/.test(entry.msg)), false);
    mcp.registerTool('wordy', { roles: ['maker'], description: 'Too many words. '.repeat(20), handler: () => 'ok' });
    assert.equal(logs.filter((entry) => entry.level === 'warn' && /long tool description/.test(entry.msg)).length, 1);
  });

  test('a schema is copied at registration: a later change outside does nothing', async () => {
    const { mcp, token } = hub();
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false };
    mcp.registerTool('count', { roles: ['all'], description: 'Count.', inputSchema: schema, handler: (agent, args) => `n=${args.n}` });
    schema.properties.n.type = 'string';
    schema.required.length = 0;
    assert.equal(textOf(await mcp.handle(token.maker, call('count', { n: 3 }))), 'n=3');
    assert.equal((await mcp.handle(token.maker, call('count', {}))).result.isError, true);
  });
});

// ---- handshakes -------------------------------------------------------------------------------------------

describe('handshake', () => {
  test('as Claude Code does it over stdio: initialize, initialized, tools/list, tools/call', async () => {
    const { mcp, token } = hub();
    addReferenceTool(mcp);
    const answers = [];
    for (const message of CLAUDE_STDIO) answers.push(await mcp.handle(token.maker, message));

    const [init, initialized, list, called] = answers;
    assert.deepEqual(Object.keys(init).sort(), ['id', 'jsonrpc', 'result']);
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 0);
    assert.deepEqual(Object.keys(init.result).sort(), ['capabilities', 'instructions', 'protocolVersion', 'serverInfo']);
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(init.result.serverInfo, { name: 'shop', version: '0.1.0' });
    assert.ok(init.result.instructions.length > 10 && init.result.instructions.length < 200 && !init.result.instructions.includes('\n'));

    assert.equal(initialized, null);

    assert.equal(list.id, 1);
    assert.deepEqual(names(list), ['post', 'read', 'claim', 'board_post']);
    assert.deepEqual(list.result.tools[3].inputSchema, {
      type: 'object',
      properties: { to: { type: 'string' }, kind: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'kind', 'body'],
      additionalProperties: false,
    });

    // The same answer as the probe's reference server gave to this call.
    assert.deepEqual(called, { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'posted #1 to boss' }], isError: false } });
  });

  test('the protocol version of the client is used when the hub speaks it, else the newest', async () => {
    const { mcp, token } = hub();
    assert.deepEqual([...PROTOCOL_VERSIONS], ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    for (const version of PROTOCOL_VERSIONS) {
      const answer = await mcp.handle(token.maker, req('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '0' } }));
      assert.equal(answer.result.protocolVersion, version);
    }
    for (const params of [{ protocolVersion: '2026-07-28' }, { protocolVersion: '1.0' }, { protocolVersion: 5 }, {}, undefined, null, 'x']) {
      assert.equal((await mcp.handle(token.maker, req('initialize', params))).result.protocolVersion, '2025-11-25');
    }
  });

  test('version and instructions can be set', async () => {
    const mcp = createMcp({ store: fakeStore([{ ...MAKER }]), version: '9.9.9', instructions: 'Short.' });
    const { result } = await mcp.handle(mcp.tokenFor('A3'), req('initialize', CLAUDE_INIT_PARAMS));
    assert.deepEqual(result.serverInfo, { name: 'shop', version: '9.9.9' });
    assert.equal(result.instructions, 'Short.');
    const silent = createMcp({ store: fakeStore([{ ...MAKER }]), instructions: '' });
    assert.equal('instructions' in (await silent.handle(silent.tokenFor('A3'), req('initialize', CLAUDE_INIT_PARAMS))).result, false);
  });

  test('as the Antigravity CLI does it: an older protocol, list probes, one generic call tool', async () => {
    // agy is a generic MCP client (docs: stdio or streamable HTTP; tools are called through call_mcp_tool
    // with ServerName, ToolName, Arguments; calls carry root_conversation_id metadata).
    const { mcp, token, seen } = hub();
    const init = await mcp.handle(token.maker, req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'antigravity-cli', version: '1.5.1' } }, 'init-1'));
    assert.equal(init.id, 'init-1');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(await mcp.handle(token.maker, notice('notifications/initialized')), null);
    assert.deepEqual((await mcp.handle(token.maker, req('ping'))).result, {});
    assert.deepEqual(names(await mcp.handle(token.maker, req('tools/list', { cursor: undefined }))), ['post', 'read', 'claim']);
    // A client may ask for these even though the hub has none.
    assert.deepEqual((await mcp.handle(token.maker, req('resources/list', {}))).result, { resources: [] });
    assert.deepEqual((await mcp.handle(token.maker, req('resources/templates/list'))).result, { resourceTemplates: [] });
    assert.deepEqual((await mcp.handle(token.maker, req('prompts/list'))).result, { prompts: [] });

    const posted = await mcp.handle(token.maker, req('tools/call', { name: 'post', arguments: { line: 'INFO #build: The API port is 8080.' }, _meta: { root_conversation_id: 'c-123' } }));
    assert.equal(posted.result.isError, false);
    assert.deepEqual(seen.at(-1), { tool: 'post', agent: 'A3', args: { line: 'INFO #build: The API port is 8080.' } });
    // Arguments as JSON text, and no arguments at all for a tool that needs none.
    assert.equal((await mcp.handle(token.maker, req('tools/call', { name: 'post', arguments: '{"line":"INFO #build: Text form."}' }))).result.isError, false);
    assert.deepEqual(seen.at(-1).args, { line: 'INFO #build: Text form.' });
    assert.equal((await mcp.handle(token.maker, req('tools/call', { name: 'read' }))).result.isError, false);
    assert.equal((await mcp.handle(token.maker, req('tools/call', { name: 'read', arguments: null }))).result.isError, false);
    assert.deepEqual(seen.at(-1).args, {});
  });

  test('the endpoint keeps no session: tools work without initialize, and initialize can repeat', async () => {
    const { mcp, token } = hub();
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), 'granted');
    for (let i = 0; i < 3; i++) assert.equal((await mcp.handle(token.maker, req('initialize', CLAUDE_INIT_PARAMS))).result.serverInfo.name, 'shop');
  });
});

// ---- JSON-RPC ---------------------------------------------------------------------------------------------

describe('JSON-RPC', () => {
  test('an unknown token gives error -32001 "unknown agent"', async () => {
    const { mcp } = hub();
    const stale = 'f'.repeat(64);
    assert.deepEqual(await mcp.handle(stale, req('initialize', CLAUDE_INIT_PARAMS, 0)), { jsonrpc: '2.0', id: 0, error: { code: -32001, message: 'unknown agent' } });
    assert.deepEqual(await mcp.handle(stale, call('post', { line: 'x' }, 'abc')), { jsonrpc: '2.0', id: 'abc', error: { code: -32001, message: 'unknown agent' } });
    assert.equal(await mcp.handle(stale, notice('notifications/initialized')), null);
    assert.deepEqual(await mcp.handle(undefined, [req('ping', undefined, 1), notice('notifications/initialized'), req('tools/list', undefined, 2)]), [
      { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unknown agent' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'unknown agent' } },
    ]);
  });

  test('an unknown method gives -32601, the answer Claude Code needs for its discover probe', async () => {
    const { mcp, token } = hub();
    assert.deepEqual(await mcp.handle(token.maker, CLAUDE_HTTP[0].rpc), {
      jsonrpc: '2.0', id: 'server-discover-probe-1', error: { code: -32601, message: 'Method not found: server/discover' },
    });
    assert.equal((await mcp.handle(token.maker, req('logging/setLevel', { level: 'info' }))).error.code, -32601);
    assert.equal((await mcp.handle(token.maker, req('tools/call/extra'))).error.code, -32601);
    const long = await mcp.handle(token.maker, req(`x${'y'.repeat(500)}\nz`));
    assert.ok(long.error.message.length < 110 && !long.error.message.includes('\n'));
  });

  test('notifications get no answer and run nothing', async () => {
    const { mcp, token, seen } = hub();
    for (const message of [
      notice('notifications/initialized'),
      notice('notifications/cancelled', { requestId: 2, reason: 'user' }),
      notice('notifications/roots/list_changed'),
      notice('no/such/method'),
      notice('tools/call', { name: 'post', arguments: { line: 'x' } }), // a call without an id is not run
      { jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'post', arguments: { line: 'x' } } },
    ]) {
      assert.equal(await mcp.handle(token.maker, message), null);
    }
    assert.deepEqual(seen, []);
    // A notification that came with an id still gets an answer, so the client does not wait.
    assert.deepEqual(await mcp.handle(token.maker, req('notifications/initialized', undefined, 4)), { jsonrpc: '2.0', id: 4, result: {} });
  });

  test('answers of the client to hub requests are dropped', async () => {
    const { mcp, token } = hub();
    assert.equal(await mcp.handle(token.maker, { jsonrpc: '2.0', id: 1, result: { roots: [] } }), null);
    assert.equal(await mcp.handle(token.maker, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } }), null);
  });

  test('a message that is not a request gives -32600', async () => {
    const { mcp, token } = hub();
    for (const bad of ['text', 42, null, undefined, true]) {
      assert.deepEqual(await mcp.handle(token.maker, bad), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: a message must be a JSON object' } });
    }
    assert.equal((await mcp.handle(token.maker, {})).error.code, -32600);
    assert.deepEqual(await mcp.handle(token.maker, { jsonrpc: '2.0', id: 3 }), { jsonrpc: '2.0', id: 3, error: { code: -32600, message: 'Invalid Request: method is missing' } });
    assert.deepEqual((await mcp.handle(token.maker, { id: 4, method: 'ping' })), { jsonrpc: '2.0', id: 4, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0" and method must be a string' } });
    assert.equal((await mcp.handle(token.maker, { jsonrpc: '1.0', id: 4, method: 'ping' })).error.code, -32600);
    assert.equal((await mcp.handle(token.maker, { jsonrpc: '2.0', id: 4, method: 5 })).error.code, -32600);
    for (const id of [{}, [1], true, Number.NaN]) {
      assert.deepEqual(await mcp.handle(token.maker, { jsonrpc: '2.0', id, method: 'ping' }), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: id must be a string or a number' } });
    }
    assert.equal(await mcp.handle(token.maker, { jsonrpc: '1.0', method: 'ping' }), null); // a broken notification: nobody waits for an answer
  });

  test('ids come back as they were sent', async () => {
    const { mcp, token } = hub();
    for (const id of [0, 1, -5, 2.5, 'a', '', 'server-discover-probe-1', 9007199254740991]) {
      assert.equal((await mcp.handle(token.maker, req('ping', undefined, id))).id, id);
    }
  });

  test('tools/call without a tool name is a protocol error', async () => {
    const { mcp, token } = hub();
    for (const params of [undefined, null, {}, { name: 5 }, 'post', ['post']]) {
      const answer = await mcp.handle(token.maker, req('tools/call', params, 9));
      assert.deepEqual(answer, { jsonrpc: '2.0', id: 9, error: { code: -32602, message: 'Invalid params: tools/call needs params.name' } });
    }
  });

  test('handle gives the answer at once when nothing was async, and a promise otherwise', async () => {
    const { mcp, token } = hub();
    const sync = mcp.handle(token.maker, call('post', { line: 'INFO #build: Now.' }, 1));
    assert.equal(typeof sync.then, 'undefined');
    assert.equal(sync.result.isError, false);
    assert.equal(typeof mcp.handle(token.maker, req('tools/list')).then, 'undefined');
    assert.ok(Array.isArray(mcp.handle(token.maker, [req('ping'), call('read')])));
    assert.equal(mcp.handle(token.maker, notice('notifications/initialized')), null);

    const pending = mcp.handle(token.boss, call('plan_submit', { tasks: [goodTask()] }, 2));
    assert.equal(typeof pending.then, 'function');
    assert.deepEqual(await pending, { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'plan accepted' }], isError: false } });
    assert.equal(typeof mcp.handle(token.boss, [req('ping'), call('plan_submit', { tasks: [] })]).then, 'function');
  });

  test('handle never throws and never rejects', async () => {
    const { mcp, token, logs } = hub();
    const weird = [undefined, null, 0, '', [], [[]], [null], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post', arguments: [] } }];
    for (const message of weird) {
      for (const who of [token.maker, undefined, null, 5, {}]) await mcp.handle(who, message);
    }
    // Even a broken store or logger only costs the one answer.
    const broken = createMcp({ store: { get: () => { throw new Error('down'); } }, log: () => { throw new Error('log down'); } });
    assert.equal((await broken.handle(broken.tokenFor('A1'), req('ping', undefined, 1))).error.code, -32001);
    assert.equal(logs.some((entry) => entry.msg === 'mcp: internal error'), false);
  });
});

// ---- batches ------------------------------------------------------------------------------------------------

describe('batches', () => {
  test('a batch gives the answers of its requests, in order', async () => {
    const { mcp, token } = hub();
    const answers = await mcp.handle(token.boss, [
      req('ping', undefined, 'a'),
      notice('notifications/initialized'),
      call('status', undefined, 'b'),
      req('nope', undefined, 'c'),
      { jsonrpc: '2.0', id: 9, result: {} },
      call('plan_submit', { tasks: [goodTask()] }, 'd'),
      call('post', { line: 5 }, 'e'),
      'garbage',
    ]);
    assert.deepEqual(answers.map((answer) => answer.id), ['a', 'b', 'c', 'd', 'e', null]);
    assert.deepEqual(answers[0].result, {});
    assert.equal(textOf(answers[1]), 'T1 working @m1');
    assert.equal(answers[2].error.code, -32601);
    assert.equal(textOf(answers[3]), 'plan accepted');
    assert.equal(answers[4].result.isError, true);
    assert.equal(answers[5].error.code, -32600);
  });

  test('a batch of notifications gives null; an empty or huge batch gives -32600', async () => {
    const { mcp, token } = hub();
    assert.equal(await mcp.handle(token.maker, [notice('notifications/initialized'), notice('notifications/cancelled', { requestId: 1 })]), null);
    assert.deepEqual(await mcp.handle(token.maker, []), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the batch is empty' } });
    const many = Array.from({ length: 51 }, () => req('ping'));
    assert.equal((await mcp.handle(token.maker, many)).error.code, -32600);
    assert.equal((await mcp.handle(token.maker, many.slice(0, 50))).length, 50);
  });

  test('the messages of a batch run one after the other', async () => {
    const { mcp, token } = hub();
    const order = [];
    mcp.registerTool('slow', {
      roles: ['all'], description: 'Slow.',
      inputSchema: { type: 'object', properties: { tag: { type: 'string' }, ms: { type: 'integer' } }, required: ['tag', 'ms'] },
      handler: async (agent, { tag, ms }) => {
        order.push(`start ${tag}`);
        await sleep(ms);
        order.push(`end ${tag}`);
        return tag;
      },
    });
    const answers = await mcp.handle(token.maker, [call('slow', { tag: 'a', ms: 30 }, 1), call('slow', { tag: 'b', ms: 1 }, 2), call('post', { line: 'c' }, 3)]);
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
    assert.deepEqual(answers.map((answer) => answer.id), [1, 2, 3]);
  });
});

// ---- argument validation --------------------------------------------------------------------------------

describe('argument validation', () => {
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

  test('validateArgs names the bad field', () => {
    const cases = [
      [object({ line: { type: 'string' } }), {}, ['line is missing']],
      [object({ line: { type: 'string' } }), { line: 5 }, ['line must be a string (got integer)']],
      [object({ line: { type: 'string' } }), { line: null }, ['line must be a string (got null)']],
      [object({ paths: { type: 'array' } }), { paths: 'src/a.js' }, ['paths must be an array (got string)']],
      [object({ paths: { type: 'array', items: { type: 'string' } } }), { paths: ['a', 2, 'c', {}] }, ['paths[1] must be a string (got integer)', 'paths[3] must be a string (got object)']],
      [object({ size: { enum: ['S', 'M', 'L'] } }), { size: 'XL' }, ['size must be one of "S", "M", "L"']],
      [object({ model: { type: 'string', enum: ['same', 'up', 'other_lab'] } }), { model: 'best' }, ['model must be one of "same", "up", "other_lab"']],
      [object({ line: { type: 'string', maxLength: 800 } }), { line: 'x'.repeat(801) }, ['line is too long (801 characters, limit 800)']],
      [object({ title: { type: 'string', minLength: 1 } }), { title: '' }, ['title is empty']],
      [object({ title: { type: 'string', minLength: 3 } }), { title: 'ab' }, ['title is too short (minimum 3 characters)']],
      [object({ line: { type: 'string' } }), { line: 'x', extra: 1 }, ['extra is not a known field']],
      [object({ ok: { type: 'boolean' } }), { ok: 'yes' }, ['ok must be a boolean (got string)']],
      [object({ n: { type: 'integer' } }), { n: 1.5 }, ['n must be an integer (got number)']],
      [object({ n: { type: 'number' } }), { n: '1' }, ['n must be a number (got string)']],
      [object({ n: { type: 'integer', minimum: 1, maximum: 5 } }), { n: 0 }, ['n must be at least 1']],
      [object({ n: { type: 'integer', minimum: 1, maximum: 5 } }), { n: 6 }, ['n must be at most 5']],
      [object({ note: { type: ['string', 'null'] } }), { note: 5 }, ['note must be a string or null (got integer)']],
      [object({ zones: { type: 'array', minItems: 1 } }), { zones: [] }, ['zones needs at least 1 item (got 0)']],
      [object({ paths: { type: 'array', maxItems: 2 } }), { paths: [1, 2, 3] }, ['paths has too many items (3, limit 2)']],
      [object({ id: { type: 'string', pattern: '^T[0-9]+$' } }), { id: 'task 12' }, ['id does not match the pattern ^T[0-9]+$']],
      [object({ kind: { const: 'fix' } }), { kind: 'build' }, ['kind must be "fix"']],
      [object({ v: { anyOf: [{ type: 'string' }, { type: 'integer' }] } }), { v: true }, ['v does not match an allowed form']],
      [object({ v: { oneOf: [{ type: 'integer' }, { type: 'number' }] } }), { v: 3 }, ['v must match exactly one allowed form']],
      [object({ v: { allOf: [{ type: 'string' }, { maxLength: 2 }] } }), { v: 'abc' }, ['v is too long (3 characters, limit 2)']],
      [{ type: 'object', properties: {}, additionalProperties: { type: 'string' } }, { any: 5 }, ['any must be a string (got integer)']],
      [object({ results: { type: 'array', items: object({ id: { type: 'string' }, ok: { type: 'boolean' } }) } }), { results: [{ id: 'R1', ok: true }, { id: 'R2' }, { id: 3, ok: false }] }, ['results[1].ok is missing', 'results[2].id must be a string (got integer)']],
      [object({ a: object({ b: object({ c: { type: 'string' } }) }) }), { a: { b: { c: 1, d: 2 } } }, ['a.b.c must be a string (got integer)', 'a.b.d is not a known field']],
      [object({ line: { type: 'string' } }), 'INFO: text', ['arguments must be an object (got string)']],
      [object({ line: { type: 'string' } }), null, ['arguments must be an object (got null)']],
      [object({ line: { type: 'string' } }), [{ line: 'x' }], ['arguments must be an object (got array)']],
    ];
    for (const [schema, value, expected] of cases) assert.deepEqual(validateArgs(schema, value), expected, JSON.stringify(value));
  });

  test('validateArgs accepts what the schema allows', () => {
    const cases = [
      [object({ line: { type: 'string', maxLength: 800 } }), { line: 'x'.repeat(800) }],
      [object({ line: { type: 'string', maxLength: 800 } }), { line: EMOJI.repeat(800) }], // 800 characters, 1600 UTF-16 units
      [object({ title: { type: 'string', minLength: 2 } }), { title: EMOJI.repeat(2) }],
      [object({ a: { type: 'string' }, b: { type: 'string' } }, ['a']), { a: 'x' }],
      [object({ n: { type: 'integer' }, x: { type: 'number' } }), { n: 3, x: 3 }],
      [object({ n: { type: 'number' } }), { n: 2.5 }],
      [object({ note: { type: ['string', 'null'] } }), { note: null }],
      [object({ v: { anyOf: [{ type: 'string' }, { type: 'integer' }] } }), { v: 7 }],
      [object({ v: { oneOf: [{ type: 'string' }, { type: 'integer' }] } }), { v: 'x' }],
      [object({ kind: { const: 'fix' }, mode: { enum: [1, 'two', null, true] } }), { kind: 'fix', mode: null }],
      [object({ anything: {} }), { anything: [1, { a: null }] }],
      [object({ flag: true }), { flag: 'whatever' }],
      [{ type: 'object' }, { free: 'form', n: 1 }],
      [{ type: 'object', properties: { a: { type: 'string', futureKeyword: 3, format: 'uri' } } }, { a: 'x', b: 2 }],
      [TASK_SCHEMA, { ...goodTask(), deps: ['T1', 'T22'], pair: true }],
      [{}, 'anything goes without a schema'],
      [undefined, { a: 1 }],
    ];
    for (const [schema, value] of cases) assert.deepEqual(validateArgs(schema, value), [], JSON.stringify(schema));
  });

  test('length limits count characters, not UTF-16 units', () => {
    const schema = object({ line: { type: 'string', maxLength: 3 } });
    assert.deepEqual(validateArgs(schema, { line: EMOJI.repeat(3) }), []);
    assert.deepEqual(validateArgs(schema, { line: EMOJI.repeat(4) }), ['line is too long (4 characters, limit 3)']);
  });

  test('at most four problems are named, and a value is never quoted', () => {
    const many = validateArgs(TASK_SCHEMA, { secret: 'sk-live-0123456789', title: 7, size: 'sk-live-0123456789', domain: 'sk-live-0123456789', pair: 'sk-live-0123456789' });
    assert.equal(many.length, 4);
    assert.equal(many.join(' ').includes('sk-live'), false);
    assert.equal(validateArgs(object({ line: { type: 'string', maxLength: 3, pattern: '^a$' } }), { line: 'sk-live-0123456789' }).join(' ').includes('sk-live'), false);
  });

  test('field names that could change an object prototype are refused, at any depth', () => {
    const open = { type: 'object' };
    assert.deepEqual(validateArgs(open, JSON.parse('{"__proto__": {"admin": true}}')), ['__proto__ is not allowed as a field name']);
    assert.deepEqual(validateArgs(open, JSON.parse('{"a": [{"b": {"constructor": 1}}]}')), ['constructor is not allowed as a field name']);
    assert.deepEqual(validateArgs(open, { list: [{ prototype: {} }] }), ['prototype is not allowed as a field name']);
    let deep = {};
    for (let i = 0; i < 40; i++) deep = { deep };
    assert.deepEqual(validateArgs(open, deep), ['arguments are nested too deep']);
    let fine = {};
    for (let i = 0; i < 20; i++) fine = { fine };
    assert.deepEqual(validateArgs(open, fine), []);
  });

  test('a call with bad arguments gets a normal result with isError, one line, and the handler does not run', async () => {
    const { mcp, token, seen } = hub();
    const answer = await mcp.handle(token.maker, call('post', { lin: 'INFO #build: A typo in the field name.' }, 5));
    assert.deepEqual(answer, {
      jsonrpc: '2.0', id: 5,
      result: { content: [{ type: 'text', text: 'post: bad arguments. line is missing; lin is not a known field. Expected {line: string}.' }], isError: true },
    });
    assert.deepEqual(seen, []);

    const cases = [
      ['post', { line: 'x'.repeat(900) }, 'post: bad arguments. line is too long (900 characters, limit 800). Expected {line: string}.'],
      ['post', 'INFO #build: just text', 'post: bad arguments. arguments must be an object (got string). Expected {line: string}.'],
      ['post', '[1,2]', 'post: bad arguments. arguments must be an object (got string). Expected {line: string}.'],
      ['post', [], 'post: bad arguments. arguments must be an object (got array). Expected {line: string}.'],
      ['read', { scope: 12 }, 'read: bad arguments. scope must be a string (got integer). Expected {scope?: string}.'],
      ['claim', { paths: 'src/a.js' }, 'claim: bad arguments. paths must be an array (got string). Expected {paths: string[]}.'],
      ['claim', { paths: [] }, 'claim: bad arguments. paths needs at least 1 item (got 0). Expected {paths: string[]}.'],
    ];
    for (const [name, args, expected] of cases) {
      const { result } = await mcp.handle(token.maker, call(name, args));
      assert.equal(result.isError, true);
      assert.equal(textOf({ result }), expected);
    }
    const status = await mcp.handle(token.boss, call('status', { verbose: true }));
    assert.equal(textOf(status), 'status: bad arguments. verbose is not a known field. Expected {}.');
    assert.deepEqual(seen, []);
  });

  test('the error line of a large schema stays one short line', async () => {
    const { mcp, token } = hub();
    const text = textOf(await mcp.handle(token.boss, call('plan_submit', { tasks: [{ ...goodTask(), size: 'XL', deps: ['12'] }, { title: '' }], note: 'x' })));
    assert.equal(text.includes('\n'), false);
    assert.ok(text.length <= 700, `${text.length} characters`);
    assert.equal(text, 'plan_submit: bad arguments. tasks[0].size must be one of "S", "M", "L"; tasks[0].deps[0] does not match the pattern ^T[0-9]+$; '
      + 'tasks[1].spec is missing; tasks[1].acceptance is missing. Expected {tasks: {title: string, spec: string, acceptance: string[], zones: string[], '
      + 'domain: "backend"|"frontend"|"test"|"docs", size: "S"|"M"|"L", deps?: string[], pair?: boolean}[], notes?: string}.');
    const huge = {};
    for (let i = 0; i < 200; i++) huge[`field_number_${i}`] = { type: 'string' };
    mcp.registerTool('wide', { roles: ['all'], description: 'Wide.', inputSchema: { type: 'object', properties: huge, required: ['field_number_0'], additionalProperties: false }, handler: () => 'ok' });
    const wide = textOf(await mcp.handle(token.maker, call('wide', {})));
    assert.ok(wide.length <= 700);
    assert.match(wide, /^wide: bad arguments\. field_number_0 is missing\. Expected \{field_number_0: string, field_number_1\?: string/);
  });
});

// ---- handler results and errors ----------------------------------------------------------------------------

describe('tool results', () => {
  function withTool(handler, opts) {
    const h = hub(opts);
    h.mcp.registerTool('probe', { roles: ['all'], description: 'Probe.', handler });
    return { ...h, run: () => h.mcp.handle(h.token.maker, call('probe', undefined, 1)) };
  }

  test('a string or { text, isError } becomes MCP content', async () => {
    assert.deepEqual(await withTool(() => 'ok 41').run(), { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok 41' }], isError: false } });
    assert.deepEqual((await withTool(() => ({ text: 'ERR E_HEAD no kind' })).run()).result, { content: [{ type: 'text', text: 'ERR E_HEAD no kind' }], isError: false });
    assert.deepEqual((await withTool(() => ({ text: 'ERR E_HEAD no kind', isError: true })).run()).result, { content: [{ type: 'text', text: 'ERR E_HEAD no kind' }], isError: true });
    assert.deepEqual((await withTool(async () => 'later').run()).result, { content: [{ type: 'text', text: 'later' }], isError: false });
    assert.deepEqual((await withTool(() => Promise.resolve({ text: 'no', isError: 1 })).run()).result, { content: [{ type: 'text', text: 'no' }], isError: true });
  });

  test('other return values still give a usable result', async () => {
    assert.equal(textOf(await withTool(() => undefined).run()), 'ok');
    assert.equal(textOf(await withTool(() => null).run()), 'ok');
    assert.equal(textOf(await withTool(() => '').run()), '(empty)'); // a model API refuses an empty text block
    assert.equal(textOf(await withTool(() => ({ text: ' \n ' })).run()), '(empty)');
    assert.equal(textOf(await withTool(() => 42).run()), '42');
    const odd = withTool(() => ({ ok: true, msg: { id: 7 } }));
    assert.equal(textOf(await odd.run()), '{"ok":true,"msg":{"id":7}}');
    assert.ok(odd.logs.some((entry) => entry.level === 'warn' && /must return a string/.test(entry.msg)));
    const loop = {};
    loop.self = loop;
    assert.equal((await withTool(() => loop).run()).result.isError, false);
  });

  test('a long result is cut', async () => {
    const { run } = withTool(() => 'x'.repeat(50) + EMOJI.repeat(100), { maxResultChars: 51 });
    assert.equal(textOf(await run()), `${'x'.repeat(50)}\n[cut: 200 more characters]`); // not in the middle of the emoji
    assert.equal(textOf(await withTool(() => 'y'.repeat(20_000)).run()).length, 20_000);
    assert.match(textOf(await withTool(() => 'y'.repeat(20_001)).run()), /\n\[cut: 1 more characters\]$/);
  });

  test('a handler that throws gives isError with a short message and no stack trace', async () => {
    const boom = withTool(() => {
      throw new Error('task T99 does not exist\nsecond line');
    });
    const answer = await boom.run();
    assert.deepEqual(answer, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'probe failed: task T99 does not exist' }], isError: true } });
    const logged = boom.logs.find((entry) => entry.level === 'error');
    assert.equal(logged.data.tool, 'probe');
    assert.match(logged.data.error, /task T99 does not exist[\s\S]*\n\s+at /, 'the stack goes to the log');

    const typeError = await withTool(() => undefined.zones).run();
    assert.equal(typeError.result.isError, true);
    assert.match(textOf(typeError), /^probe failed: /);
    assert.equal(/\n|\bat .*:\d+|mcp\.js|file:\/\//.test(textOf(typeError)), false);

    assert.equal(textOf(await withTool(async () => {
      throw new Error('late failure');
    }).run()), 'probe failed: late failure');
    assert.equal(textOf(await withTool(() => Promise.reject(new Error(`long ${'m'.repeat(500)}`))).run()).length, 'probe failed: '.length + 200);
    assert.equal(textOf(await withTool(() => {
      throw 'a plain string'; // eslint-disable-line no-throw-literal
    }).run()), 'probe failed: a plain string');
    assert.equal(textOf(await withTool(() => Promise.reject()).run()), 'probe failed: undefined');
    assert.equal(textOf(await withTool(() => {
      throw new Error('');
    }).run()), 'probe failed: internal error');
  });

  test('an async handler that never answers gets a timeout result', async () => {
    // The timeout timer does not keep the process alive (a hub that shuts down must not wait for it),
    // so this test holds the event loop open itself.
    const hold = setInterval(() => {}, 1000);
    cleanups.push(() => clearInterval(hold));
    const stuck = withTool(() => new Promise(() => {}), { callTimeoutMs: 40 });
    const started = Date.now();
    const answer = await stuck.run();
    assert.ok(Date.now() - started < 2000);
    assert.equal(answer.result.isError, true);
    assert.match(textOf(answer), /^probe timed out after 0 s\./);
    assert.deepEqual(stuck.mcp.callsSince('A3').map((entry) => entry.ok), [false]);
    assert.ok(stuck.logs.some((entry) => entry.level === 'warn' && /timed out/.test(entry.msg)));

    // A slow handler that makes it in time is not touched, and a late failure after the timeout is dropped.
    assert.equal(textOf(await withTool(async () => {
      await sleep(30);
      return 'made it';
    }, { callTimeoutMs: 2000 }).run()), 'made it');
    const late = withTool(() => new Promise((resolve, reject) => setTimeout(() => reject(new Error('too late')), 60)), { callTimeoutMs: 20 });
    assert.match(textOf(await late.run()), /timed out/);
    await sleep(80); // an unhandled rejection here would fail the test run
    assert.equal(textOf(await withTool(() => sleep(30).then(() => 'no limit'), { callTimeoutMs: 0 }).run()), 'no limit');
  });

  test('the handler gets the live agent and the arguments as they were sent', async () => {
    const { mcp, store, token } = hub();
    let got;
    mcp.registerTool('probe', { roles: ['all'], description: 'Probe.', inputSchema: { type: 'object' }, handler: (...all) => {
      got = all;
      return 'ok';
    } });
    await mcp.handle(token.manager, req('tools/call', { name: 'probe', arguments: { a: [1, { b: null }], text: `two${LINE_SEPARATOR}lines` }, _meta: { progressToken: 2 } }));
    assert.equal(got.length, 2);
    assert.equal(got[0], store.get('agents', 'A2'));
    assert.deepEqual(got[1], { a: [1, { b: null }], text: `two${LINE_SEPARATOR}lines` });
  });
});

// ---- callsSince ------------------------------------------------------------------------------------------------

describe('callsSince', () => {
  test('every tools/call is recorded with name, ok and start time', async () => {
    let clock = 1000;
    const { mcp, token } = hub({ now: () => clock });
    mcp.registerTool('boom', { roles: ['all'], description: 'Boom.', handler: () => {
      throw new Error('x');
    } });
    mcp.registerTool('refuse', { roles: ['all'], description: 'Refuse.', handler: () => ({ text: 'ERR E_HEAD', isError: true }) });

    await mcp.handle(token.maker, call('post', { line: 'INFO #build: one.' }));
    clock = 2000;
    await mcp.handle(token.maker, call('post', {})); // bad arguments
    clock = 3000;
    await mcp.handle(token.maker, call('plan_submit', { tasks: [] })); // not a maker tool
    clock = 4000;
    await mcp.handle(token.maker, call('boom'));
    clock = 5000;
    await mcp.handle(token.maker, call('refuse'));
    clock = 6000;
    await mcp.handle(token.maker, [call('read'), req('tools/list'), req('ping'), notice('notifications/initialized')]);
    await mcp.handle(token.boss, call('plan_submit', { tasks: [goodTask()] }));

    assert.deepEqual(mcp.callsSince('A3', 0), [
      { name: 'post', ok: true, ts: 1000 },
      { name: 'post', ok: false, ts: 2000 },
      { name: 'plan_submit', ok: false, ts: 3000 },
      { name: 'boom', ok: false, ts: 4000 },
      { name: 'refuse', ok: false, ts: 5000 },
      { name: 'read', ok: true, ts: 6000 },
    ]);
    assert.deepEqual(mcp.callsSince('A3', 4000).map((entry) => entry.name), ['boom', 'refuse', 'read']); // at or after
    assert.deepEqual(mcp.callsSince('A3', 4001).map((entry) => entry.name), ['refuse', 'read']);
    assert.deepEqual(mcp.callsSince('A3', 6001), []);
    assert.deepEqual(mcp.callsSince('A3'), mcp.callsSince('A3', 0));
    assert.deepEqual(mcp.callsSince('A1', 0), [{ name: 'plan_submit', ok: true, ts: 6000 }]);
    assert.deepEqual(mcp.callsSince('A2', 0), []);
    assert.deepEqual(mcp.callsSince('nobody', 0), []);
  });

  test('the time of a call is its start, and the list is a copy', async () => {
    let clock = 10;
    const { mcp, token } = hub({ now: () => clock });
    mcp.registerTool('slow', { roles: ['all'], description: 'Slow.', handler: async () => {
      clock = 500;
      await sleep(5);
      return 'done';
    } });
    await mcp.handle(token.maker, call('slow'));
    assert.deepEqual(mcp.callsSince('A3', 0), [{ name: 'slow', ok: true, ts: 10 }]);
    mcp.callsSince('A3', 0)[0].ok = false;
    mcp.callsSince('A3', 0).length = 0;
    assert.deepEqual(mcp.callsSince('A3', 0), [{ name: 'slow', ok: true, ts: 10 }]);
  });

  test('the ring keeps the last 200 calls of an agent', async () => {
    let clock = 0;
    const { mcp, token } = hub({ now: () => clock });
    for (clock = 1; clock <= 250; clock++) await mcp.handle(token.maker, call('read'));
    const kept = mcp.callsSince('A3', 0);
    assert.equal(kept.length, 200);
    assert.equal(kept[0].ts, 51);
    assert.equal(kept.at(-1).ts, 250);
  });

  test('the history survives revoke, ends when the agent leaves the store, and covers 1000 agents at most', async () => {
    const { mcp, store, token } = hub();
    await mcp.handle(token.maker, call('read'));
    mcp.revoke('A3');
    assert.equal(mcp.callsSince('A3', 0).length, 1);
    store.remove('agents', 'A3');
    assert.deepEqual(mcp.callsSince('A3', 0), []);

    const agents = Array.from({ length: 1001 }, (unused, i) => ({ id: `M${i}`, role: 'maker' }));
    const big = createMcp({ store: fakeStore(agents) });
    big.registerTool('read', { roles: ['all'], description: 'Read.', handler: () => 'x' });
    for (const agent of agents.slice(0, 1000)) await big.handle(big.tokenFor(agent.id), call('read'));
    await big.handle(big.tokenFor('M0'), call('read')); // M0 is active again, so M1 is now the least recent
    await big.handle(big.tokenFor('M1000'), call('read'));
    assert.equal(big.callsSince('M0', 0).length, 2);
    assert.deepEqual(big.callsSince('M1', 0), []);
    assert.equal(big.callsSince('M2', 0).length, 1);
    assert.equal(big.callsSince('M1000', 0).length, 1);
  });

  test('a strange tool name is recorded short and on one line', async () => {
    const { mcp, token } = hub();
    await mcp.handle(token.maker, call(`bad\nname${'!'.repeat(300)}`));
    const [entry] = mcp.callsSince('A3', 0);
    assert.equal(entry.ok, false);
    assert.ok(entry.name.length <= 64 && !entry.name.includes('\n'));
  });
});

// ---- the board tag ------------------------------------------------------------------------------------------------

describe('board tag', () => {
  const TAG = '[board: 2 new for you. Call read.]';

  test('without a provider nothing is added', async () => {
    const { mcp, token } = hub();
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), 'granted');
  });

  test('the tag is the last line of every tool result, also of an error result', async () => {
    const { mcp, token } = hub();
    const asked = [];
    mcp.setTagProvider((agentId) => {
      asked.push(agentId);
      return TAG;
    });
    mcp.registerTool('boom', { roles: ['all'], description: 'Boom.', handler: () => {
      throw new Error('x');
    } });
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), `granted\n${TAG}`);
    assert.equal(textOf(await mcp.handle(token.boss, call('plan_submit', { tasks: [goodTask()] }))), `plan accepted\n${TAG}`);
    assert.equal(textOf(await mcp.handle(token.maker, call('post', {}))), `post: bad arguments. line is missing. Expected {line: string}.\n${TAG}`);
    assert.equal(textOf(await mcp.handle(token.maker, call('boom'))), `boom failed: x\n${TAG}`);
    assert.equal(textOf(await mcp.handle(token.maker, call('read'))), `(empty)\n${TAG}`);
    assert.deepEqual(asked, ['A3', 'A1', 'A3', 'A3', 'A3']);
    // Protocol answers carry no tag.
    assert.equal(JSON.stringify(await mcp.handle(token.maker, [req('tools/list'), req('ping'), call('plan_submit', {}), req('initialize', {})])).includes('board:'), false);
    assert.equal(asked.length, 5);
  });

  test('the tag is asked for after the handler ran', async () => {
    const { mcp, token, state } = hub();
    state.unread = 3;
    state.view = '41 2m ASK @b1>@m1 T12: Which port?';
    mcp.setTagProvider(() => (state.unread > 0 ? `[board: ${state.unread} new for you. Call read.]` : ''));
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), 'granted\n[board: 3 new for you. Call read.]');
    assert.equal(textOf(await mcp.handle(token.maker, call('read'))), '41 2m ASK @b1>@m1 T12: Which port?'); // read cleared the mail
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), 'granted');
  });

  test('an empty tag adds nothing, and a provider can be async or removed', async () => {
    const { mcp, token } = hub();
    for (const empty of ['', '  ', null, undefined, 0, {}]) {
      mcp.setTagProvider(() => empty);
      assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), 'granted');
    }
    mcp.setTagProvider(async () => `  ${TAG}\n`);
    const pending = mcp.handle(token.maker, call('claim', { paths: ['a'] }));
    assert.equal(typeof pending.then, 'function');
    assert.equal(textOf(await pending), `granted\n${TAG}`);
    mcp.setTagProvider(null);
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), 'granted');
    assert.throws(() => mcp.setTagProvider('tag'), TypeError);
  });

  test('a provider that fails costs only the tag', async () => {
    const { mcp, token, logs } = hub();
    mcp.setTagProvider(() => {
      throw new Error('board is down');
    });
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), 'granted');
    mcp.setTagProvider(() => Promise.reject(new Error('board is down')));
    assert.equal(textOf(await mcp.handle(token.maker, call('claim', { paths: ['a'] }))), 'granted');
    assert.equal(logs.filter((entry) => entry.level === 'warn' && /tag provider failed/.test(entry.msg)).length, 2);
  });
});

// ---- the mail hook: GET /mcp/:token/tag (contract sections 6 and 10, A24) ------------------------------------------

describe('mail check for the tool hook', () => {
  const URGENT = '[board: 1 new for you. Call read.]';
  const get = (port, target) => httpRequest(port, { method: 'GET', path: target });

  test('known token with urgent mail: 200 and the PostToolUse hook JSON; nothing urgent: 204; unknown token: 404', async () => {
    const { mcp, token } = hub();
    const asked = [];
    let urgent = { A3: URGENT };
    mcp.setUrgentProvider((agentId) => {
      asked.push(agentId);
      return urgent[agentId] ?? '';
    });
    const { port } = await serve(mcp); // the plain contract guard: a GET needs no X-WorkShop header (curl sends none)

    const mail = await get(port, `/mcp/${token.maker}/tag`);
    assert.equal(mail.status, 200);
    assert.match(mail.headers['content-type'], /^application\/json/);
    assert.deepEqual(mail.json(), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: URGENT } });

    urgent = {};
    const quiet = await get(port, `/mcp/${token.maker}/tag`);
    assert.equal(quiet.status, 204);
    assert.equal(quiet.text, '');

    for (const target of [`/mcp/${'0'.repeat(64)}/tag`, '/mcp/nope/tag']) {
      const unknown = await get(port, target);
      assert.equal(unknown.status, 404, target);
      assert.equal(unknown.text, '', 'an empty body: the hook adds nothing to the context');
    }
    assert.deepEqual(asked, ['A3', 'A3'], 'the provider runs only for a known token');
  });

  test('a provider that throws, rejects or gives no text counts as nothing urgent; no provider is the same', async () => {
    const { mcp, token, logs } = hub();
    const { port } = await serve(mcp);
    assert.equal((await get(port, `/mcp/${token.maker}/tag`)).status, 204, 'no provider');
    for (const provider of [() => {
      throw new Error('board is down');
    }, () => Promise.reject(new Error('x')), () => null, () => 42, () => '   ', async () => URGENT]) {
      mcp.setUrgentProvider(provider);
      const answer = await get(port, `/mcp/${token.maker}/tag`);
      assert.equal(answer.status, provider.constructor.name === 'AsyncFunction' ? 200 : 204);
    }
    assert.equal(logs.filter((entry) => /urgent tag provider failed/.test(entry.msg)).length, 2);
    assert.equal(JSON.stringify(logs).includes(token.maker), false, 'no token in the log');
    mcp.setUrgentProvider(null);
    assert.equal((await get(port, `/mcp/${token.maker}/tag`)).status, 204);
    assert.throws(() => mcp.setUrgentProvider('tag'), TypeError);
  });

  test('after revoke the old token answers 404 on POST /mcp/<token> and on GET /mcp/<token>/tag; the next token is new', async () => {
    const { mcp, token } = hub();
    mcp.setUrgentProvider(() => URGENT);
    const { port } = await serve(mcp);
    const old = token.maker;
    assert.equal((await get(port, `/mcp/${old}/tag`)).status, 200);
    mcp.revoke('A3');
    assert.equal((await httpRequest(port, { path: `/mcp/${old}`, headers: JSON_POST, body: req('ping') })).status, 404);
    assert.equal((await get(port, `/mcp/${old}/tag`)).status, 404);
    const fresh = mcp.tokenFor('A3');
    assert.notEqual(fresh, old);
    assert.equal((await get(port, `/mcp/${fresh}/tag`)).status, 200);
    assert.equal((await get(port, `/mcp/${old}/tag`)).status, 404);
  });

  test('urgentFor gives null for an unknown token and for an agent that left the store', async () => {
    const { mcp, token, store } = hub();
    mcp.setUrgentProvider(() => URGENT);
    assert.equal(await mcp.urgentFor(token.maker), URGENT);
    assert.equal(await mcp.urgentFor('x'), null);
    assert.equal(await mcp.urgentFor(undefined), null);
    store.remove('agents', 'A3');
    assert.equal(await mcp.urgentFor(token.maker), null);
  });
});

// ---- the redactor knows every live token (contract sections 8 and 14, A32) -------------------------------------------

describe('tokens and the redactor', () => {
  function fakeRedactor() {
    const calls = [];
    return { calls, add: (value) => calls.push(['add', value]), remove: (value) => calls.push(['remove', value]) };
  }

  test('tokenFor adds a new token, revoke removes it; a second tokenFor without a revoke adds nothing', () => {
    const redactor = fakeRedactor();
    const mcp = createMcp({ store: fakeStore([{ ...MAKER }, { ...BOSS }]), redactor });
    const t1 = mcp.tokenFor('A3');
    assert.deepEqual(redactor.calls, [['add', t1]]);
    assert.equal(mcp.tokenFor('A3'), t1);
    assert.deepEqual(redactor.calls, [['add', t1]], 'the same token is not added twice');
    mcp.revoke('A3');
    assert.deepEqual(redactor.calls, [['add', t1], ['remove', t1]]);
    mcp.revoke('A3');
    assert.equal(redactor.calls.length, 2, 'a second revoke removes nothing');
    const t2 = mcp.tokenFor('A3');
    assert.notEqual(t2, t1);
    assert.deepEqual(redactor.calls.at(-1), ['add', t2]);
  });

  test('an agent that leaves the store and a token that the table drops leave the redactor too', () => {
    const redactor = fakeRedactor();
    const store = fakeStore([{ ...MAKER }, { ...BOSS }]);
    const mcp = createMcp({ store, redactor });
    const maker = mcp.tokenFor('A3');
    const boss = mcp.tokenFor('A1');
    store.remove('agents', 'A3');
    assert.deepEqual(redactor.calls.at(-1), ['remove', maker]);
    // 2000 is the table size: tokens of agents that are not in the store go first.
    for (let i = 0; i < 2000; i += 1) mcp.tokenFor(`G${i}`);
    const removed = redactor.calls.filter(([op]) => op === 'remove').map(([, value]) => value);
    const added = redactor.calls.filter(([op]) => op === 'add').map(([, value]) => value);
    // Over the limit the table dropped every token of an agent that is not in the store, but the newest.
    assert.equal(added.length - removed.length, 2, 'the redactor holds exactly the live tokens: the boss and the newest');
    for (const value of removed) assert.ok(added.includes(value));
    assert.equal(removed.includes(boss), false, 'the agent in the store keeps its token');
  });

  test('a redactor that refuses a token: no token is handed out; one that fails on remove costs a warning', () => {
    const logs = [];
    const mcp = createMcp({ store: fakeStore([{ ...MAKER }]), redactor: { add() {
      throw new Error('full');
    }, remove() {} }, log: (level, msg) => logs.push({ level, msg }) });
    assert.throws(() => mcp.tokenFor('A3'), /redactor/);
    const calls = [];
    const shaky = createMcp({ store: fakeStore([{ ...MAKER }]), redactor: { add: (v) => calls.push(v), remove() {
      throw new Error('gone');
    } }, log: (level, msg) => logs.push({ level, msg }) });
    const token = shaky.tokenFor('A3');
    shaky.revoke('A3');
    assert.equal(shaky.agentFor(token), null, 'the token is invalid all the same');
    assert.ok(logs.some((entry) => entry.level === 'warn' && /redactor/.test(entry.msg)));
    assert.equal(JSON.stringify(logs).includes(token), false);
  });
});

// ---- logging ------------------------------------------------------------------------------------------------------

test('tool arguments and tool results never reach the log', async () => {
  const { mcp, token, logs } = hub();
  mcp.registerTool('echo', { roles: ['all'], description: 'Echo.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 20 } } }, handler: (agent, args) => `RESULT-SECRET ${args.text}` });
  await mcp.handle(token.maker, call('echo', { text: 'ARG-SECRET' }));
  await mcp.handle(token.maker, call('echo', { text: 'ARG-SECRET-THAT-IS-TOO-LONG-FOR-THE-SCHEMA' }));
  await mcp.handle(token.maker, call('post', { line: 5, password: 'ARG-SECRET' }));
  await mcp.handle(token.maker, req('initialize', { ...CLAUDE_INIT_PARAMS, clientInfo: { name: 'claude-code', version: '2.1.289' } }));
  const all = JSON.stringify(logs);
  assert.equal(all.includes('SECRET'), false);
  assert.ok(logs.some((entry) => entry.level === 'debug' && entry.data?.tool === 'echo' && entry.data.ok === true && typeof entry.data.ms === 'number'));
  assert.ok(logs.some((entry) => entry.msg === 'mcp: initialize' && entry.data.client === 'claude-code' && entry.data.clientVersion === '2.1.289'));
});

test('the module rules hold: built-in modules only, no console, and the shim imports nothing of WorkShop', () => {
  const read = (file) => fs.readFileSync(path.join(here, '..', 'server', file), 'utf8');
  const imports = (source) => [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
  const mcpSource = read('mcp.js');
  const shimSource = read('mcp-stdio-shim.mjs');
  assert.deepEqual(imports(mcpSource), ['node:crypto', 'node:vm']); // node:vm gives the argument check its time limit
  // The shim must run from any folder, alone. node:fs reads the --url-file (contract sections 8 and 10).
  assert.deepEqual(imports(shimSource), ['node:fs'], 'the shim imports only built-in modules');
  for (const source of [mcpSource, shimSource]) {
    assert.equal(/\bconsole\.|\brequire\(|\bimport\(/.test(source), false);
  }
});

// ---- HTTP wiring -----------------------------------------------------------------------------------------------------

describe('mountMcp', () => {
  test('a request gets 200 with JSON, a notification 202 with an empty body, a GET 405', async () => {
    const { mcp, token } = hub();
    const { port } = await serve(mcp);
    const target = `/mcp/${token.maker}`;

    const listed = await httpRequest(port, { path: target, headers: JSON_POST, body: req('tools/list', undefined, 1) });
    assert.equal(listed.status, 200);
    assert.match(listed.headers['content-type'], /^application\/json/);
    assert.equal(listed.headers['cache-control'], 'no-store');
    assert.equal(listed.headers['mcp-session-id'], undefined, 'the endpoint has no sessions');
    assert.deepEqual(names(listed.json()), ['post', 'read', 'claim']);

    const accepted = await httpRequest(port, { path: target, headers: JSON_POST, body: notice('notifications/initialized') });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.text, '');

    const stream = await httpRequest(port, { method: 'GET', path: target, headers: { accept: 'text/event-stream' } });
    assert.equal(stream.status, 405);
    assert.equal(stream.headers.allow, 'POST');

    const called = await httpRequest(port, { path: target, headers: JSON_POST, body: call('claim', { paths: ['docs/a.md'] }, 2) });
    assert.equal(called.status, 200);
    assert.deepEqual(called.json(), { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'granted' }], isError: false } });

    const failed = await httpRequest(port, { path: target, headers: JSON_POST, body: req('nope', undefined, 3) });
    assert.equal(failed.status, 200, 'a JSON-RPC error is still an HTTP success');
    assert.equal(failed.json().error.code, -32601);

    // Request headers that the endpoint does not need are not checked: the answer is JSON in any case.
    const odd = await httpRequest(port, {
      path: target,
      headers: { ...JSON_POST, accept: 'text/event-stream', 'mcp-protocol-version': '2099-01-01', 'mcp-session-id': 'made-up' },
      body: req('ping', undefined, 4),
    });
    assert.equal(odd.status, 200);
    assert.match(odd.headers['content-type'], /^application\/json/);
    assert.deepEqual(odd.json(), { jsonrpc: '2.0', id: 4, result: {} });
  });

  test('batches: answers come as a list, a batch of notifications gets 202', async () => {
    const { mcp, token } = hub();
    const { port } = await serve(mcp);
    const target = `/mcp/${token.boss}`;
    const batch = await httpRequest(port, { path: target, headers: JSON_POST, body: [req('ping', undefined, 1), notice('notifications/initialized'), call('plan_submit', { tasks: [goodTask()] }, 2)] });
    assert.equal(batch.status, 200);
    assert.deepEqual(batch.json().map((answer) => answer.id), [1, 2]);
    const quiet = await httpRequest(port, { path: target, headers: JSON_POST, body: [notice('notifications/initialized')] });
    assert.equal(quiet.status, 202);
    assert.equal(quiet.text, '');
  });

  test('an unknown token gets 404 with JSON-RPC error -32001, never 401', async () => {
    const { mcp, token } = hub();
    const logs = [];
    const router = contractHttp();
    mountMcp(router, mcp, { log: (level, msg) => logs.push({ level, msg }) });
    const { port } = await router.listen();
    cleanups.push(() => router.close());

    const stale = await httpRequest(port, { path: `/mcp/${'0'.repeat(64)}`, headers: JSON_POST, body: req('initialize', CLAUDE_INIT_PARAMS, 0) });
    assert.equal(stale.status, 404);
    assert.deepEqual(stale.json(), { jsonrpc: '2.0', id: 0, error: { code: -32001, message: 'unknown agent' } });
    assert.equal(stale.headers['www-authenticate'], undefined);
    const quiet = await httpRequest(port, { path: '/mcp/nope', headers: JSON_POST, body: notice('notifications/initialized') });
    assert.equal(quiet.status, 404);
    assert.deepEqual(quiet.json(), { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unknown agent' } });
    mcp.revoke('A3');
    assert.equal((await httpRequest(port, { path: `/mcp/${token.maker}`, headers: JSON_POST, body: req('ping') })).status, 404);
    assert.equal(logs.filter((entry) => entry.level === 'warn').length, 1, 'one log line, however often it happens');
    assert.equal(JSON.stringify(logs).includes(token.maker), false);
  });

  test('a known token in the Authorization header counts when the URL part is not a token', async () => {
    const { mcp, token } = hub();
    const { port } = await serve(mcp);
    // providers/claude.js writes the URL as .../mcp/${WORKSHOP_TOKEN} and sends the token as a bearer header too.
    const unexpanded = `/mcp/${encodeURIComponent('${WORKSHOP_TOKEN}')}`;
    const viaHeader = await httpRequest(port, { path: unexpanded, headers: { ...JSON_POST, authorization: `Bearer ${token.boss}` }, body: req('tools/list', undefined, 1) });
    assert.equal(viaHeader.status, 200);
    assert.ok(names(viaHeader.json()).includes('plan_submit'), 'the agent of the header');
    for (const authorization of [`Bearer ${'0'.repeat(64)}`, `Basic ${token.boss}`, token.boss, 'Bearer', '']) {
      assert.equal((await httpRequest(port, { path: unexpanded, headers: { ...JSON_POST, authorization }, body: req('ping') })).status, 404, authorization);
    }
    // A token in the URL wins, whatever the header says.
    const both = await httpRequest(port, { path: `/mcp/${token.maker}`, headers: { ...JSON_POST, authorization: `Bearer ${token.boss}` }, body: req('tools/list', undefined, 2) });
    assert.deepEqual(names(both.json()), ['post', 'read', 'claim']);
    const wrongHeader = await httpRequest(port, { path: `/mcp/${token.maker}`, headers: { ...JSON_POST, authorization: 'Bearer nope' }, body: req('ping', undefined, 3) });
    assert.equal(wrongHeader.status, 200);
  });

  test('a body that is no JSON-RPC message gets 400', async () => {
    const { mcp, token } = hub();
    const { port } = await serve(mcp);
    const target = `/mcp/${token.maker}`;
    const empty = await httpRequest(port, { path: target, headers: JSON_POST, body: '' });
    assert.equal(empty.status, 400);
    assert.equal(empty.json().error.code, -32600);
    const emptyBatch = await httpRequest(port, { path: target, headers: JSON_POST, body: [] });
    assert.equal(emptyBatch.status, 400);
    assert.equal(emptyBatch.json().error.code, -32600);
    // A router that hands over other body types.
    const answers = [];
    let handler;
    mountMcp({ route: (method, pattern, fn) => {
      if (method === 'POST') handler = fn;
    } }, mcp);
    const ctx = (body) => ({ params: { token: token.maker }, body, json: (status, value) => answers.push({ status, value }), text: (status, value) => answers.push({ status, value }) });
    for (const body of [undefined, null, 42, 'not json']) await handler(ctx(body));
    assert.deepEqual(answers.map((answer) => [answer.status, answer.value.error.code]), [[400, -32700], [400, -32700], [400, -32700], [400, -32700]]);
    await handler(ctx(JSON.stringify(req('ping', undefined, 8))));
    assert.deepEqual(answers.at(-1), { status: 200, value: { jsonrpc: '2.0', id: 8, result: {} } });
  });

  test('mountMcp checks what it gets', () => {
    const { mcp } = hub();
    assert.throws(() => mountMcp(null, mcp), TypeError);
    assert.throws(() => mountMcp({}, mcp), TypeError);
    assert.throws(() => mountMcp(contractHttp(), {}), TypeError);
    const calls = [];
    mountMcp({ route: (...all) => calls.push(all) }, mcp);
    assert.deepEqual(calls.map(([method, pattern]) => `${method} ${pattern}`), ['POST /mcp/:token', 'GET /mcp/:token', 'GET /mcp/:token/tag']);
    // Contract sections 6 and 14c: every non-GET needs X-WorkShop: 1. No route asks the router to drop that guard.
    for (const call of calls) assert.equal(call[3]?.noHeaderCheck, undefined, `${call[0]} ${call[1]}`);
  });

  test('the full Claude Code HTTP sequence gets the statuses that the reference server gave', async () => {
    const { mcp, token } = hub();
    addReferenceTool(mcp);
    // The recorded requests carry no X-WorkShop header. The MCP config of the CLI adds it (contract section 10),
    // and that passes on the plain contract guard and on a router that knows a route option to drop it.
    for (const [label, options, extra] of [['config header', {}, { 'x-workshop': '1' }], ['config header, lax router', { honorNoHeaderCheck: true }, { 'x-workshop': '1' }]]) {
      const { port } = await serve(mcp, options);
      const bodies = [];
      for (const step of CLAUDE_HTTP) {
        const answer = await httpRequest(port, { method: step.method, path: `/mcp/${token.maker}`, headers: { ...step.headers, ...extra }, body: step.rpc });
        assert.equal(answer.status, step.status, `${label}: ${step.method} ${step.rpc?.method ?? ''}`);
        bodies.push(answer.text ? answer.json() : null);
      }
      assert.equal(bodies[0].error.code, -32601); // the discover probe must fail like this
      assert.equal(bodies[1].result.protocolVersion, '2025-11-25');
      assert.equal(bodies[2], null);
      assert.ok(names(bodies[4]).includes('board_post'));
      assert.equal(bodies[5].result.isError, false);
      assert.match(textOf(bodies[5]), /^posted #\d to boss$/);
    }
  });

  test('the guards of the router stay in force', async () => {
    const { mcp, token } = hub();
    const strict = await serve(mcp);
    const target = `/mcp/${token.maker}`;
    const noHeader = await httpRequest(strict.port, { path: target, headers: { 'content-type': 'application/json' }, body: req('ping') });
    assert.equal(noHeader.status, 403, 'the contract guard wants X-WorkShop: 1 on a POST');
    // A router that knows a route option to drop the header rule: mountMcp does not ask for it.
    const lax = await serve(mcp, { honorNoHeaderCheck: true });
    assert.equal((await httpRequest(lax.port, { path: target, headers: { 'content-type': 'application/json' }, body: req('ping') })).status, 403);
    const withHeader = { 'content-type': 'application/json', 'x-workshop': '1' };
    assert.equal((await httpRequest(lax.port, { path: target, headers: withHeader, body: req('ping') })).status, 200);
    assert.equal((await httpRequest(lax.port, { path: target, headers: { ...withHeader, host: 'evil.example' }, body: req('ping') })).status, 403);
    assert.equal((await httpRequest(lax.port, { path: target, headers: { ...withHeader, origin: 'http://evil.example' }, body: req('ping') })).status, 403);
  });
});

// ---- the stdio shim ------------------------------------------------------------------------------------------------

describe('stdio shim', () => {
  test('carries the handshake of Claude Code to the hub and back', async () => {
    const { mcp, token } = hub();
    addReferenceTool(mcp);
    const { url, router } = await serve(mcp); // the plain contract guard: the shim must send X-WorkShop itself
    const shim = startShim(`${url}/mcp/${token.maker}`);
    for (const message of CLAUDE_STDIO) shim.send(message);

    const init = await shim.answer(0);
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.deepEqual(init.result.serverInfo, { name: 'shop', version: '0.1.0' });
    assert.deepEqual(names(await shim.answer(1)), ['post', 'read', 'claim', 'board_post']);
    assert.deepEqual(await shim.answer(2), { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'posted #1 to boss' }], isError: false } });

    assert.deepEqual(await shim.end(), { code: 0, signal: null });
    assert.equal(shim.lines.length, 3, 'three requests, three lines; the notification gets none');
    assert.deepEqual(shim.lines.map((line) => JSON.parse(line).id), [0, 1, 2]);
    assert.equal(shim.buffer, '');
    assert.equal(shim.stderr.includes('[shop-mcp]'), false, 'no notes when all is well');
    assert.equal(router.requests.length, 4);
    for (const seen of router.requests) {
      assert.equal(seen.method, 'POST');
      assert.equal(seen.headers['x-workshop'], '1');
      assert.equal(seen.headers['content-type'], 'application/json');
      assert.equal(seen.headers.origin, undefined);
    }
    assert.deepEqual(mcp.callsSince('A3', 0).map((entry) => [entry.name, entry.ok]), [['board_post', true]]);
  });

  test('tool errors, unknown methods and batches come back by id', async () => {
    const { mcp, token } = hub();
    const { url } = await serve(mcp);
    const shim = startShim(`${url}/mcp/${token.maker}`);
    shim.send(call('post', {}, 'bad-args'));
    shim.send(req('nope', undefined, 'nope'));
    shim.send(call('plan_submit', { tasks: [] }, 'role'));
    shim.send([req('ping', undefined, 'p1'), notice('notifications/initialized'), call('claim', { paths: ['a'] }, 'c1')]);
    shim.send([notice('notifications/initialized')]);
    shim.send(call('claim', { paths: ['b'] }, 'last'));

    assert.equal((await shim.answer('bad-args')).result.isError, true);
    assert.equal((await shim.answer('nope')).error.code, -32601);
    assert.equal((await shim.answer('role')).error.code, -32602);
    const batch = await shim.line((message) => Array.isArray(message));
    assert.deepEqual(batch.map((answer) => answer.id), ['p1', 'c1']);
    await shim.answer('last');
    assert.equal(shim.lines.length, 5);
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });

  test('stdout carries protocol lines only, whatever comes in', async () => {
    const { mcp, token } = hub();
    mcp.registerTool('echo', { roles: ['all'], description: 'Echo.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, handler: (agent, args) => args.text });
    const { url } = await serve(mcp);
    const shim = startShim(`${url}/mcp/${token.maker}`);
    shim.send('{not json');
    shim.send('');
    shim.send('   ');
    shim.send('42');
    shim.send('"text"');
    shim.send('null');
    shim.send('{}');
    shim.send('[]');
    shim.send({ jsonrpc: '2.0', id: 5, result: {} }); // an answer of the client: nothing comes back
    shim.send(`${JSON.stringify(req('ping', undefined, 'crlf'))}\r`); // a CRLF line end
    const text = `caf${String.fromCharCode(0xe9)} ${EMOJI} two${LINE_SEPARATOR}lines`;
    shim.send(call('echo', { text }, 'unicode'));

    const echoed = await shim.answer('unicode');
    assert.equal(textOf(echoed), text);
    await shim.answer('crlf');
    assert.deepEqual(await shim.end(), { code: 0, signal: null });

    const parsed = shim.lines.map((line) => JSON.parse(line)); // every line is JSON
    assert.deepEqual(parsed.map((message) => [message.id, message.error?.code ?? 'ok']), [
      [null, -32700], [null, -32600], [null, -32600], [null, -32600], [null, -32600], [null, -32600], ['crlf', 'ok'], ['unicode', 'ok'],
    ]);
    for (const message of parsed) assert.equal(message.jsonrpc, '2.0');
    const raw = shim.lines.at(-1);
    assert.equal(raw.includes(LINE_SEPARATOR), false, 'U+2028 is printed escaped, so no line reader breaks the line');
    assert.ok(raw.includes('\\u2028'));
  });

  test('a message split over several chunks, and a last line without a line break, still arrive whole', async () => {
    const { mcp, token } = hub();
    mcp.registerTool('echo', { roles: ['all'], description: 'Echo.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, handler: (agent, args) => args.text });
    const { url } = await serve(mcp);
    const shim = startShim(`${url}/mcp/${token.maker}`);
    const text = `${EMOJI}${EMOJI} done`;
    const bytes = Buffer.from(`${JSON.stringify(call('echo', { text }, 1))}\n${JSON.stringify(call('echo', { text: 'second' }, 2))}\n${JSON.stringify(req('ping', undefined, 3))}`);
    const cut = bytes.indexOf(0xf0) + 2; // in the middle of the first emoji
    shim.child.stdin.write(bytes.subarray(0, cut));
    await sleep(40);
    shim.child.stdin.write(bytes.subarray(cut, cut + 3));
    await sleep(40);
    shim.child.stdin.write(bytes.subarray(cut + 3));
    assert.equal(textOf(await shim.answer(1)), text);
    assert.equal(textOf(await shim.answer(2)), 'second');
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
    assert.deepEqual(shim.lines.map((line) => JSON.parse(line).id), [1, 2, 3], 'the ping had no line break, but stdin closed after it');
  });

  test('a line that is too large is refused and the next one works', async () => {
    const { mcp, token } = hub();
    const { url } = await serve(mcp);
    const shim = startShim(`${url}/mcp/${token.maker}`);
    shim.child.stdin.write(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"post","arguments":{"line":"${'x'.repeat(8 * 1024 * 1024)}"}}}\n`);
    shim.send(req('ping', undefined, 2));
    assert.deepEqual(await shim.line((message) => message.id === null), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the message is too large' } });
    assert.deepEqual((await shim.answer(2)).result, {});
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });

  test('hub down: the request gets a JSON-RPC error, and the shim recovers when the hub is back', async () => {
    const { mcp, token } = hub();
    const { url, router } = await serve(mcp, { restartable: true });
    const shim = startShim(`${url}/mcp/${token.maker}`);
    shim.send(CLAUDE_STDIO[0]);
    shim.send(call('claim', { paths: ['a'] }, 1));
    assert.equal(textOf(await shim.answer(1)), 'granted');

    await router.close(); // the hub dies
    const started = Date.now();
    shim.send(call('claim', { paths: ['b'] }, 2));
    shim.send(req('tools/list', undefined, 3));
    const lost = await shim.answer(2);
    assert.deepEqual(lost, { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'The WorkShop hub is not reachable. The call was not done. Try again in a moment.' } });
    assert.ok(Date.now() - started >= 250, 'it kept trying for the retry time first');
    assert.equal((await shim.answer(3)).error.code, -32603);
    const notes = () => shim.stderr.split('\n').filter((line) => line.startsWith('[shop-mcp]'));
    assert.equal(notes().length, 1, 'one note for the whole outage');
    assert.match(notes()[0], /^\[shop-mcp\] hub not reachable at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)$/);
    assert.equal(shim.done, undefined, 'the shim is still running');
    assert.equal(mcp.callsSince('A3', 0).length, 1, 'the lost call never ran');

    await router.reopen(); // the hub is back on the same port
    shim.send(call('claim', { paths: ['c'] }, 4));
    assert.equal(textOf(await shim.answer(4)), 'granted');
    assert.deepEqual(notes().slice(1), ['[shop-mcp] hub is back']);
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
    for (const line of shim.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    assert.equal(shim.stderr.includes(token.maker), false);
  });

  test('a hub that comes back within the retry time costs no error', async () => {
    const { mcp, token } = hub();
    const { url, router } = await serve(mcp, { restartable: true });
    const shim = startShim(`${url}/mcp/${token.maker}`, { env: { WORKSHOP_MCP_RETRY_MS: '5000' } });
    shim.send(req('ping', undefined, 1));
    await shim.answer(1);
    await router.close();
    shim.send(call('claim', { paths: ['a'] }, 2));
    await sleep(350);
    assert.equal(shim.lines.length, 1, 'still trying');
    await router.reopen();
    assert.equal(textOf(await shim.answer(2)), 'granted');
    assert.deepEqual(mcp.callsSince('A3', 0).map((entry) => entry.ok), [true]);
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });

  test('a tools/call is never sent twice; a harmless request is repeated', async () => {
    const counts = {};
    const server = http.createServer((request, res) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        counts[message.method] = (counts[message.method] ?? 0) + 1;
        if (counts[message.method] === 1) {
          request.socket.destroy(); // the hub read the request, then the connection broke
          return;
        }
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: 'done' }], isError: false } });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    const shim = startShim(`http://127.0.0.1:${server.address().port}/mcp/x`, { env: { WORKSHOP_MCP_RETRY_MS: '3000' } });

    shim.send(req('tools/list', undefined, 1));
    assert.deepEqual((await shim.answer(1)).result, { tools: [] });
    assert.equal(counts['tools/list'], 2, 'repeated after the broken connection');

    shim.send(call('post', { line: 'DONE T1 tests=3/3: The login form works.' }, 2));
    assert.deepEqual(await shim.answer(2), { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'The connection to the WorkShop hub broke. The call may or may not be done. Check before you repeat it.' } });
    await sleep(300);
    assert.equal(counts['tools/call'], 1, 'not repeated: the hub may have run it');

    shim.send(call('post', { line: 'x' }, 3));
    assert.equal(textOf(await shim.answer(3)), 'done');
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });

  test('a hub that does not answer in time gives an error, without a second try', async () => {
    let hits = 0;
    const server = http.createServer(() => {
      hits += 1; // never answers
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    // One second, not less: on a very busy machine a shorter limit can end before the request has left the shim.
    const shim = startShim(`http://127.0.0.1:${server.address().port}/mcp/x`, { env: { WORKSHOP_MCP_TIMEOUT_MS: '1000', WORKSHOP_MCP_RETRY_MS: '3000' } });
    shim.send(req('tools/list', undefined, 1));
    const answer = await shim.answer(1);
    assert.equal(answer.error.code, -32603);
    assert.match(answer.error.message, /^The WorkShop hub did not answer in \d+ s\. The call may still be done\./);
    for (let waited = 0; hits === 0 && waited < 5000; waited += 20) await sleep(20); // this process may see the request late
    await sleep(300); // a second try would come after the first pause of 100 ms
    assert.equal(hits, 1);
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });

  test('an unknown token and a hub error page come back as JSON-RPC errors with the right id', async () => {
    const { mcp } = hub();
    const { url } = await serve(mcp);
    const stale = startShim(`${url}/mcp/${'9'.repeat(64)}`);
    stale.send(CLAUDE_STDIO[0]);
    stale.send(CLAUDE_STDIO[1]);
    stale.send(call('post', { line: 'x' }, 7));
    assert.deepEqual(await stale.answer(0), { jsonrpc: '2.0', id: 0, error: { code: -32001, message: 'unknown agent' } });
    assert.deepEqual(await stale.answer(7), { jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'unknown agent' } });
    assert.deepEqual(await stale.end(), { code: 0, signal: null });
    assert.equal(stale.lines.length, 2);
    assert.deepEqual(stale.stderr.split('\n').filter((line) => line.startsWith('[shop-mcp]')), ['[shop-mcp] hub answered HTTP 404'], 'one note, not one per request');

    const server = http.createServer((request, res) => {
      request.resume();
      request.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"the disk is full"}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    const shim = startShim(`http://127.0.0.1:${server.address().port}/mcp/x`);
    shim.send(req('tools/list', undefined, 'a'));
    shim.send(notice('notifications/initialized'));
    shim.send([req('ping', undefined, 'b'), req('ping', undefined, 'c')]);
    assert.deepEqual(await shim.answer('a'), { jsonrpc: '2.0', id: 'a', error: { code: -32603, message: 'The WorkShop hub answered HTTP 500: the disk is full' } });
    assert.deepEqual((await shim.line((message) => Array.isArray(message))).map((answer) => [answer.id, answer.error.code]), [['b', -32603], ['c', -32603]]);
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
    assert.equal(shim.lines.length, 2);
  });

  test('stdin closes while a call is on the way: the answer still comes, then exit 0', async () => {
    const { mcp, token } = hub();
    mcp.registerTool('slow', { roles: ['all'], description: 'Slow.', handler: async () => {
      await sleep(250);
      return 'slow but done';
    } });
    const { url } = await serve(mcp);
    const shim = startShim(`${url}/mcp/${token.maker}`);
    shim.send(call('slow', undefined, 1));
    shim.send(req('ping', undefined, 2));
    const exit = await shim.end();
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.deepEqual(shim.lines.map((line) => JSON.parse(line).id), [1, 2], 'in the order they were sent');
    assert.equal(textOf(JSON.parse(shim.lines[0])), 'slow but done');
  });

  test('SIGINT, SIGTERM and SIGHUP end the shim with code 0', async () => {
    const { mcp, token } = hub();
    const { url } = await serve(mcp);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) { // Claude Code sends SIGINT when it exits
      const shim = startShim(`${url}/mcp/${token.maker}`);
      shim.send(req('ping', undefined, 1));
      await shim.answer(1);
      shim.child.kill(signal);
      assert.deepEqual(await shim.exited, { code: 0, signal: null }, signal);
    }
  });

  test('the hub URL can come from WORKSHOP_MCP_URL; without a URL the shim says so on stderr and exits 2', async () => {
    const { mcp, token } = hub();
    const { url } = await serve(mcp);
    const fromEnv = startShim(null, { args: [], env: { WORKSHOP_MCP_URL: `${url}/mcp/${token.maker}` } });
    fromEnv.send(req('ping', undefined, 1));
    assert.deepEqual((await fromEnv.answer(1)).result, {});
    assert.deepEqual(await fromEnv.end(), { code: 0, signal: null });

    for (const args of [[], ['not a url'], ['ftp://127.0.0.1/mcp/x']]) {
      const lost = startShim(null, { args });
      assert.deepEqual(await lost.exited, { code: 2, signal: null });
      assert.equal(lost.lines.length, 0);
      assert.equal(lost.buffer, '');
      assert.match(lost.stderr, /usage: node mcp-stdio-shim\.mjs --url-file <path>/);
    }
  });

  // Contract sections 8 and 10 (A18): providers/gemini.js starts `node <shim> --url-file <data/run/<agent>/mcp-url>`.
  test('--url-file: the URL comes from the file, ps shows no token, and the environment is not read', async (t) => {
    const { mcp, token } = hub();
    const { url, router } = await serve(mcp); // the plain contract guard: the shim sends X-WorkShop: 1
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-urlfile-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'mcp-url');
    fs.writeFileSync(file, `${url}/mcp/${token.maker}\n`, { mode: 0o600 });

    // A wrong URL in the environment: the file wins, the environment is never read.
    const wrong = await serve(createMcp({ store: fakeStore([{ ...MAKER }]) }));
    for (const args of [['--url-file', file], [`--url-file=${file}`]]) {
      const shim = startShim(null, { args, env: { WORKSHOP_MCP_URL: `${wrong.url}/mcp/${'0'.repeat(64)}` } });
      shim.send(req('initialize', CLAUDE_INIT_PARAMS, 0));
      const init = await shim.answer(0);
      assert.equal(init.result.serverInfo.name, 'shop', `${args[0]}: the hub of the file answered`);
      let listed = '';
      try {
        listed = execFileSync('ps', ['-ww', '-p', String(shim.child.pid), '-o', 'args='], { encoding: 'utf8' });
      } catch { /* no ps here: the request check above stands */ }
      assert.equal(listed.includes(token.maker), false, `ps shows ${listed}`);
      assert.deepEqual(await shim.end(), { code: 0, signal: null });
    }
    assert.equal(wrong.router.requests.length, 0, 'nothing went to the hub of the environment');
    const seen = router.requests.filter((r) => r.method === 'POST');
    assert.ok(seen.length >= 2);
    for (const r of seen) assert.equal(r.headers['x-workshop'], '1');
  });

  test('--url-file: a missing, empty or unreadable file, or no path, gives a usage note and exit 2', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-urlfile-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const empty = path.join(dir, 'empty');
    fs.writeFileSync(empty, '  \n', { mode: 0o600 });
    const cases = [['--url-file', path.join(dir, 'missing')], ['--url-file', empty], ['--url-file', dir], ['--url-file']];
    for (const args of cases) {
      const shim = startShim(null, { args, env: { WORKSHOP_MCP_URL: 'http://127.0.0.1:9/mcp/x' } });
      assert.deepEqual(await shim.exited, { code: 2, signal: null }, args.join(' '));
      assert.equal(shim.lines.length, 0);
      assert.match(shim.stderr, /usage: node mcp-stdio-shim\.mjs --url-file <path>/);
    }
  });
});

// ---- with the real modules of the hub, when they are there -------------------------------------------------------------

describe('with the real hub modules', () => {
  async function load(file) {
    try {
      return await import(new URL(`../server/${file}`, import.meta.url).href);
    } catch {
      return null;
    }
  }

  test('store.js: an agent that is removed loses its token', async (t) => {
    const mod = await load('store.js');
    if (!mod?.createStore) return t.skip('server/store.js is not there yet');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-mcp-'));
    const store = mod.createStore({ dataDir });
    try {
      const mcp = createMcp({ store });
      mcp.registerTool('post', { roles: ['all'], description: 'One post.', inputSchema: POST_SCHEMA, handler: (agent) => `ok from ${agent.handle}` });
      const id = store.nextId('A');
      store.put('agents', { id, jobId: 'J1', role: 'maker', handle: '@m1' });
      const token = mcp.tokenFor(id);
      assert.equal(mcp.agentFor(token), store.get('agents', id));
      assert.equal(textOf(await mcp.handle(token, call('post', { line: 'INFO #build: Real store.' }))), 'ok from @m1');
      store.patch('agents', id, { role: 'boss', handle: '@b9' });
      assert.equal(textOf(await mcp.handle(token, call('post', { line: 'INFO #build: Patched.' }))), 'ok from @b9');
      assert.equal(mcp.callsSince(id, 0).length, 2);
      store.remove('agents', id);
      assert.equal(mcp.agentFor(token), null);
      assert.deepEqual(mcp.callsSince(id, 0), []);
      assert.equal((await mcp.handle(token, req('ping', undefined, 1))).error.code, -32001);
    } finally {
      await store.flush();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    return undefined;
  });

  test('http.js: the Claude Code HTTP sequence and the shim work on the real router', async (t) => {
    const mod = await load('http.js');
    if (!mod?.createHttp) return t.skip('server/http.js is not there yet');
    const { mcp, token } = hub();
    addReferenceTool(mcp);
    const app = mod.createHttp({ closeGraceMs: 50, ownerKey: 'test-owner-key-not-a-secret' }); // contract 14b: ownerKey is required
    mountMcp(app, mcp);
    const { port, url } = await app.listen();
    cleanups.push(() => app.close());
    const target = `/mcp/${token.maker}`;

    // Today the router wants X-WorkShop: 1 on every POST. The MCP config of a CLI can add it ("headers").
    for (const step of CLAUDE_HTTP) {
      const answer = await httpRequest(port, { method: step.method, path: target, headers: { ...step.headers, 'x-workshop': '1' }, body: step.rpc });
      assert.equal(answer.status, step.status, `${step.method} ${step.rpc?.method ?? ''}`);
      if (step.status === 200) assert.match(answer.headers['content-type'], /^application\/json/);
      if (step.status === 202) assert.equal(answer.text, '');
      if (step.status === 405) assert.match(answer.headers.allow, /POST/);
    }
    const stale = await httpRequest(port, { path: `/mcp/${'0'.repeat(64)}`, headers: JSON_POST, body: req('ping', undefined, 1) });
    assert.equal(stale.status, 404);
    assert.equal(stale.json().error.code, -32001);

    // The mail check of the tool hook on the real router: curl sends a plain GET.
    let urgent = '[board: 1 new for you. Call read.]';
    mcp.setUrgentProvider(() => urgent);
    const mail = await httpRequest(port, { method: 'GET', path: `${target}/tag` });
    assert.equal(mail.status, 200);
    assert.equal(mail.json().hookSpecificOutput.additionalContext, urgent);
    urgent = '';
    const quiet = await httpRequest(port, { method: 'GET', path: `${target}/tag` });
    assert.deepEqual([quiet.status, quiet.text], [204, '']);
    const gone = await httpRequest(port, { method: 'GET', path: `/mcp/${'0'.repeat(64)}/tag` });
    assert.deepEqual([gone.status, gone.text], [404, '']);
    // Contract section 6: every answer carries the response headers, also the ones without a body.
    for (const answer of [mail, quiet, gone]) {
      assert.equal(answer.headers['x-content-type-options'], 'nosniff', `${answer.status}`);
      assert.equal(answer.headers['content-security-policy'], "frame-ancestors 'none'", `${answer.status}`);
      assert.equal(answer.headers['cache-control'], 'no-store', `${answer.status}`);
    }
    // Contract sections 6 and 14c: the real router refuses a POST without X-WorkShop: 1, also on /mcp.
    const noHeader = await httpRequest(port, { path: target, headers: { 'content-type': 'application/json' }, body: req('ping', undefined, 2) });
    assert.equal(noHeader.status, 403, 'a CLI that connects over HTTP needs "headers": {"X-WorkShop": "1"} in its MCP config');

    const shim = startShim(`${url}/mcp/${token.maker}`);
    for (const message of CLAUDE_STDIO) shim.send(message);
    assert.equal((await shim.answer(0)).result.serverInfo.name, 'shop');
    assert.ok(names(await shim.answer(1)).includes('board_post'));
    assert.equal((await shim.answer(2)).result.isError, false);
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
    assert.equal(shim.stderr.includes('[shop-mcp]'), false);
    return undefined;
  });
});

// ---- replay of the probe's own recordings, when they are still on this machine -------------------------------------------

describe('recordings of the real Claude Code CLI', () => {
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(PROBE_DIR, 'mcp', file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return null;
    }
  };

  test('stdio recording, through the shim', async (t) => {
    const recorded = read('board-stdio.log.rpc.jsonl')?.filter((entry) => entry.dir === 'in' && typeof entry.method === 'string');
    if (!recorded || !recorded.some((entry) => entry.method === 'tools/call') || recorded[0].method !== 'initialize') {
      return t.skip('no complete stdio recording in the probe folder');
    }
    const { mcp, token } = hub();
    addReferenceTool(mcp);
    const { url } = await serve(mcp);
    const shim = startShim(`${url}/mcp/${token.maker}`);
    const requests = [];
    for (const entry of recorded) {
      const message = { jsonrpc: '2.0', method: entry.method };
      if (entry.id !== null && entry.id !== undefined) message.id = entry.id;
      if (entry.params !== null && entry.params !== undefined) message.params = entry.params;
      if (message.id !== undefined) requests.push(message);
      shim.send(message);
    }
    for (const request of requests) {
      const answer = await shim.answer(request.id);
      assert.equal(answer.error, undefined, `${request.method} must work`);
      if (request.method === 'initialize') assert.equal(answer.result.protocolVersion, request.params.protocolVersion);
      if (request.method === 'tools/list') assert.ok(names(answer).includes('board_post'));
      if (request.method === 'tools/call') assert.equal(answer.result.isError, false);
    }
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
    assert.equal(shim.lines.length, requests.length);
    t.diagnostic(`replayed ${recorded.length} recorded stdio messages`);
    return undefined;
  });

  test('HTTP recording, with the recorded headers', async (t) => {
    const recorded = read('board-http-d1-http-stateless-headers.log.http.jsonl');
    if (!recorded || !recorded.some((entry) => entry.rpc?.[0]?.method === 'tools/call')) return t.skip('no complete HTTP recording in the probe folder');
    const { mcp, token } = hub();
    addReferenceTool(mcp);
    const { port } = await serve(mcp); // the recording has no X-WorkShop header: the MCP config adds it (section 10)
    for (const entry of recorded) {
      const headers = { ...entry.headers, 'x-workshop': '1' };
      for (const name of ['host', 'connection', 'content-length', 'authorization', 'x-agent-id']) delete headers[name];
      let body;
      const summary = entry.rpc?.[0];
      if (entry.method === 'POST' && summary) {
        body = { jsonrpc: '2.0', method: summary.method };
        if (summary.id !== null && summary.id !== undefined) body.id = summary.id;
        if (summary.method === 'initialize') body.params = { protocolVersion: summary.protocolVersion, capabilities: summary.capabilities, clientInfo: summary.clientInfo };
        if (summary.method === 'tools/call') body.params = { name: summary.tool, arguments: { to: 'boss', kind: 'status', body: 'hello over http' } };
      }
      const answer = await httpRequest(port, { method: entry.method, path: `/mcp/${token.maker}`, headers, body });
      assert.equal(answer.status, entry.status, `${entry.method} ${summary?.method ?? ''}`);
    }
    t.diagnostic(`replayed ${recorded.length} recorded HTTP requests`);
    return undefined;
  });
});
