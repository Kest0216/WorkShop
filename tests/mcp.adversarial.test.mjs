// Adversarial tests for the MCP module (server/mcp.js, server/mcp-stdio-shim.mjs).
// Each test proves one defect that the skeptical review found, or guards a risky path:
// a hub that freezes on a slow pattern, a schema that silently checks nothing, a call that leaves
// no record, a token that dies while its agent works, a request that nobody answers, a token on
// stderr or in `ps`, a tool call that goes to a dead connection.
//
// A check that can freeze the process runs in a child process with a time limit, so a regression
// fails the test and does not hang the test run.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMcp, mountMcp, validateArgs } from '../server/mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(here, '..', 'server', 'mcp-stdio-shim.mjs');
const MCP_URL = pathToFileURL(path.join(here, '..', 'server', 'mcp.js')).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const CSI = String.fromCharCode(0x9b); // a C1 control character: some terminals read it as the start of an escape sequence

// ---- helpers -----------------------------------------------------------------------------------------

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

const MAKER = { id: 'A3', role: 'maker', handle: '@m1' };
const BOSS = { id: 'A1', role: 'boss', handle: '@b1' };
const POST_SCHEMA = { type: 'object', properties: { line: { type: 'string', maxLength: 800 } }, required: ['line'], additionalProperties: false };

function hub(opts = {}) {
  const logs = [];
  const store = fakeStore([{ ...BOSS }, { ...MAKER }]);
  const mcp = createMcp({ store, log: (level, msg, data) => logs.push({ level, msg, data }), ...opts });
  const seen = [];
  mcp.registerTool('post', {
    roles: ['all'], description: 'One ShopTalk post.', inputSchema: POST_SCHEMA,
    handler: (agent, args) => {
      seen.push({ agent: agent.id, args });
      return `ok ${seen.length}`;
    },
  });
  return { mcp, store, logs, seen, token: { boss: mcp.tokenFor('A1'), maker: mcp.tokenFor('A3') } };
}

let lastId = 1000;
const req = (method, params, id = ++lastId) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const notice = (method) => ({ jsonrpc: '2.0', method });
const call = (name, args, id) => req('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) }, id);
const textOf = (response) => response.result.content.map((block) => block.text).join('\n');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

/** The promise, or `late` when it takes longer than `ms`. Leaves no timer behind. */
function within(promise, ms, late) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Run a module script in a child process. Gives what the script printed as JSON; fails when it takes too long. */
function runChild(script, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? `did not finish in ${timeoutMs} ms (the process was frozen)` : `failed: ${err.message}`;
        reject(new Error(`the child process ${why}\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`the child process printed no JSON: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`));
      }
    });
  });
}

/** A minimal router with the interface that mountMcp needs (no guards: these tests are not about them). */
function miniRouter() {
  const routes = [];
  let server = null;
  let port = 0;
  async function onRequest(request, res) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const send = (status, type, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const json = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    const text = (status, value) => send(status, 'text/plain; charset=utf-8', String(value ?? ''));
    const url = new URL(request.url, 'http://hub');
    const parts = url.pathname.split('/');
    const hit = routes.find((route) => route.method === request.method && route.parts.length === parts.length && route.parts.every((want, i) => want.startsWith(':') || want === parts[i]));
    if (!hit) return json(404, { error: 'not found' });
    const params = {};
    hit.parts.forEach((want, i) => {
      if (want.startsWith(':')) params[want.slice(1)] = decodeURIComponent(parts[i]);
    });
    let body = {};
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: 'request body is not valid JSON' });
      }
    }
    try {
      const result = await hit.handler({ req: request, res, params, query: {}, body, json, text });
      if (!res.headersSent) json(200, result === undefined ? { ok: true } : result);
    } catch (err) {
      json(500, { error: err.message });
    }
    return undefined;
  }
  async function listen(fixed = 0) {
    const created = http.createServer((request, res) => {
      onRequest(request, res);
    });
    await new Promise((resolve, reject) => {
      created.once('error', reject);
      created.listen(fixed, '127.0.0.1', resolve);
    });
    server = created;
    port = created.address().port;
    return { port, url: `http://127.0.0.1:${port}` };
  }
  async function close() {
    if (!server) return;
    const old = server;
    server = null;
    old.closeAllConnections();
    await new Promise((resolve) => old.close(resolve));
  }
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
    route(method, pattern, handler) {
      routes.push({ method, parts: pattern.split('/'), handler });
    },
    listen,
    close,
    reopen,
  };
}

/** Mount an endpoint and listen. `restartable` takes a port below the range that the system hands out. */
async function serve(mcp, { restartable = false } = {}) {
  const router = miniRouter();
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

/** The stdio shim as a child process. */
class Shim {
  constructor(url, { env = {}, args } = {}) {
    const base = { ...process.env, WORKSHOP_MCP_RETRY_MS: '300', ...env };
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

  send(message) {
    this.child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  }

  async line(match, ms = 10_000) {
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
      if (Date.now() > end) throw new Error(`no matching line from the shim. stdout: ${JSON.stringify(this.lines).slice(0, 2000)} stderr: ${this.stderr.slice(0, 2000)}`);
      if (this.done) await sleep(20);
      await sleep(5);
    }
  }

  answer(id, ms) {
    return this.line((message) => !Array.isArray(message) && message.id === id, ms);
  }

  end() {
    this.child.stdin.end();
    return this.exited;
  }
}

function startShim(url, options) {
  const shim = new Shim(url, options);
  cleanups.push(async () => {
    if (!shim.done) shim.child.kill('SIGKILL');
    await shim.exited;
  });
  return shim;
}

// ---- 1. a slow pattern must not freeze the hub --------------------------------------------------------------------

describe('argument checks have a time limit', () => {
  // Without a limit, `^([\w.-]+/?)+$` (a pattern an author can write for a path) needs minutes for a text
  // of 31 characters and years for 50. The hub has one thread: the UI, the event stream and every agent stop.
  test('a text that makes a schema pattern backtrack costs a fraction of a second, not the hub', async () => {
    const out = await runChild(`
      import { validateArgs } from ${JSON.stringify(MCP_URL)};
      const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
      const timed = (fn) => { const start = Date.now(); const problems = fn(); return { ms: Date.now() - start, problems }; };
      const out = {};
      // exponential: a pattern with a quantifier inside a quantifier
      out.exponential = timed(() => validateArgs(object({ zone: { type: 'string', pattern: '^([\\\\w.-]+/?)+$' } }), { zone: 'a'.repeat(50) + '!' }));
      // quadratic: a harmless pattern without an anchor, and a long text (the schema has no maxLength)
      out.quadratic = timed(() => validateArgs(object({ path: { type: 'string', pattern: '[a-z]+\\\\.md' } }), { path: 'a'.repeat(1500000) }));
      // a pattern that V8 has compiled to machine code is stopped too
      const hot = object({ words: { type: 'string', pattern: '^(\\\\w+\\\\s?)*$' } });
      let accepted = 0;
      for (let i = 0; i < 400; i++) if (validateArgs(hot, { words: 'word ' + i }).length === 0) accepted += 1;
      out.accepted = accepted;
      out.hot = timed(() => validateArgs(hot, { words: 'a'.repeat(50) + '!' }));
      // inside anyOf and inside a list
      out.nested = timed(() => validateArgs(object({ v: { anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'string', pattern: '^(a+)+$' } }] } }), { v: ['a'.repeat(60) + '!'] }));
      // the normal cases still give the normal answers
      const id = object({ id: { type: 'string', pattern: '^T[0-9]+$' } });
      out.match = validateArgs(id, { id: 'T12' });
      out.noMatch = validateArgs(id, { id: 'task 12' });
      out.afterwards = validateArgs(hot, { words: 'still works' });
      process.stdout.write(JSON.stringify(out));
    `);
    for (const name of ['exponential', 'quadratic', 'hot', 'nested']) {
      assert.ok(out[name].ms < 10_000, `${name} took ${out[name].ms} ms`);
      assert.equal(out[name].problems.length, 1, name);
      assert.match(out[name].problems[0], /too long to check/, name);
      assert.equal(out[name].problems[0].includes('aaaa'), false, 'the value is not quoted');
    }
    assert.equal(out.accepted, 400);
    assert.deepEqual(out.match, []);
    assert.deepEqual(out.noMatch, ['id does not match the pattern ^T[0-9]+$']);
    assert.deepEqual(out.afterwards, []);
  });

  test('through the endpoint: the call fails with one line, the handler does not run, and the log names the tool', async () => {
    const out = await runChild(`
      import { createMcp } from ${JSON.stringify(MCP_URL)};
      const logs = [];
      const mcp = createMcp({ store: { get: () => ({ id: 'A3', role: 'maker' }) }, log: (level, msg, data) => logs.push({ level, msg, data }) });
      let ran = 0;
      mcp.registerTool('claim', {
        roles: ['maker'], description: 'Ask to edit outside the zone.',
        inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string', pattern: '^([\\\\w.-]+/?)+$' }, minItems: 1 } }, required: ['paths'], additionalProperties: false },
        handler: () => { ran += 1; return 'granted'; },
      });
      const token = mcp.tokenFor('A3');
      const ask = (paths, id) => mcp.handle(token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'claim', arguments: { paths } } });
      const start = Date.now();
      const slow = await ask(['SECRET-' + 'a'.repeat(50) + '!'], 1);
      const ms = Date.now() - start;
      const fine = await ask(['src/login/form.js'], 2);
      process.stdout.write(JSON.stringify({ ms, slow, fine, ran, calls: mcp.callsSince('A3', 0), logs }));
    `);
    assert.ok(out.ms < 10_000, `the slow call took ${out.ms} ms`);
    assert.equal(out.slow.result.isError, true);
    const text = out.slow.result.content[0].text;
    assert.match(text, /^claim: bad arguments\. .*too long to check.*Expected \{paths: string\[\]\}\.$/);
    assert.equal(text.includes('\n'), false);
    assert.equal(text.includes('SECRET'), false);
    assert.deepEqual(out.fine.result, { content: [{ type: 'text', text: 'granted' }], isError: false });
    assert.equal(out.ran, 1, 'only the good call reached the handler');
    assert.deepEqual(out.calls.map((entry) => [entry.name, entry.ok]), [['claim', false], ['claim', true]]);
    const warned = out.logs.filter((entry) => entry.level === 'warn' && /time limit/.test(entry.msg));
    assert.equal(warned.length, 1);
    assert.equal(warned[0].data.tool, 'claim');
    assert.equal(JSON.stringify(out.logs).includes('SECRET'), false, 'the argument is not in the log');
  });

  test('a batch of slow checks lets the event loop run between its messages', async () => {
    const out = await runChild(`
      import { createMcp } from ${JSON.stringify(MCP_URL)};
      const mcp = createMcp({ store: { get: () => ({ id: 'A3', role: 'maker' }) }, argCheckMs: 40 });
      mcp.registerTool('claim', {
        roles: ['all'], description: 'Claim.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', pattern: '^(a+)+$' } }, required: ['path'] },
        handler: () => 'granted',
      });
      let ticks = 0;
      const ticker = setInterval(() => { ticks += 1; }, 5);
      const batch = Array.from({ length: 12 }, (unused, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'claim', arguments: { path: 'a'.repeat(60) + '!' } } }));
      const start = Date.now();
      const answers = await mcp.handle(mcp.tokenFor('A3'), batch);
      clearInterval(ticker);
      process.stdout.write(JSON.stringify({ ms: Date.now() - start, ticks, ids: answers.map((a) => a.id), errors: answers.filter((a) => a.result?.isError === true).length }));
    `);
    assert.deepEqual(out.ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'still in order');
    assert.equal(out.errors, 12);
    assert.ok(out.ms < 20_000, `the batch took ${out.ms} ms`);
    assert.ok(out.ticks >= 4, `a timer ran only ${out.ticks} times while the batch took ${out.ms} ms: the event loop was blocked`);
  });

  test('a check that was stopped while the hub got no processor time runs again; a check that used the time does not', async () => {
    // The limit is wall-clock time. On a very busy machine a harmless check can hit it. The hub then
    // looks at the processor time that the process really used.
    const out = await runChild(`
      import { validateArgs } from ${JSON.stringify(MCP_URL)};
      const schema = { type: 'object', properties: { path: { type: 'string', pattern: '^(a+)+$' } }, required: ['path'] };
      const slow = 'a'.repeat(60) + '!';
      // A try is counted where the hub starts it: each try reads the processor time once before it runs. (Counting
      // reads of the argument is not exact: on a busy machine the time limit can stop a try before its first read.)
      const realCpuUsage = process.cpuUsage;
      let tries = 0;
      const withCpu = (usedMs, fn) => {
        tries = 0;
        process.cpuUsage = (before) => {
          if (!before) tries += 1;
          return before ? { user: usedMs * 1000, system: 0 } : { user: 0, system: 0 };
        };
        try { return fn(); } finally { process.cpuUsage = realCpuUsage; }
      };
      const attempt = (texts) => {
        let reads = 0;
        const value = { get path() { reads += 1; return texts[Math.min(reads, texts.length) - 1]; } };
        Object.defineProperty(value, 'path', { enumerable: true, get: Object.getOwnPropertyDescriptor(value, 'path').get });
        const problems = validateArgs(schema, value, 60);
        return { problems, checks: tries };
      };
      const out = {};
      out.starved = withCpu(0, () => attempt(['x', slow]));            // every try is stopped, and the process used no time
      out.busy = withCpu(60, () => attempt(['x', slow]));              // the check used the whole limit itself
      out.recovered = withCpu(0, () => attempt(['x', slow, 'aaa']));   // the second try gets through
      process.stdout.write(JSON.stringify(out));
    `);
    assert.equal(out.starved.checks, 3, 'three tries, then it gives up');
    assert.match(out.starved.problems[0], /too long to check/);
    assert.equal(out.busy.checks, 1, 'a check that used the time is not repeated');
    assert.match(out.busy.problems[0], /too long to check/);
    // Normally the second try reads the good text. A try that the limit stops before its first read leaves the
    // good text for the third one.
    assert.ok(out.recovered.checks >= 2 && out.recovered.checks <= 3, `${out.recovered.checks} tries`);
    assert.deepEqual(out.recovered.problems, [], 'the valid arguments pass on a later try');
  });

  test('a schema without a pattern is checked as before, and the limit can be set per call', () => {
    const schema = object({ line: { type: 'string', maxLength: 5 } });
    assert.deepEqual(validateArgs(schema, { line: 'abcdef' }), ['line is too long (6 characters, limit 5)']);
    assert.deepEqual(validateArgs(schema, { line: 'abc' }), []);
    const withPattern = object({ id: { type: 'string', pattern: '^T[0-9]+$' } });
    assert.deepEqual(validateArgs(withPattern, { id: 'T1' }, 1000), []);
    assert.deepEqual(validateArgs(withPattern, { id: 'x' }, 1000), ['id does not match the pattern ^T[0-9]+$']);
    assert.deepEqual(validateArgs(withPattern, { id: 'T1' }, 0), [], '0 = no limit');
  });
});

// ---- 2. a schema that cannot check anything must not register -----------------------------------------------------------

describe('registerTool refuses a schema that would silently check nothing', () => {
  const good = { roles: ['maker'], description: 'A tool.', handler: () => 'ok' };
  const withSchema = (inputSchema) => ({ ...good, inputSchema });

  test('a broken keyword is an error at registration, with the place in the schema', () => {
    const { mcp } = hub();
    const cases = [
      [object({ id: { type: 'string', pattern: '[' } }), /properties\.id\.pattern/], // not a regular expression: it matched everything
      [object({ id: { type: 'string', pattern: /^T[0-9]+$/ } }), /properties\.id\.pattern/], // a RegExp object is lost in the JSON copy
      [object({ line: { type: 'str' } }), /properties\.line\.type/], // an unknown type name let every value pass
      [object({ n: { type: ['integer', 'float'] } }), /properties\.n\.type/],
      [object({ size: { enum: 'S|M|L' } }), /properties\.size\.enum/],
      [object({ size: { enum: [] } }), /properties\.size\.enum/],
      [{ type: 'object', properties: { line: { type: 'string' } }, required: 'line' }, /required/],
      [{ type: 'object', properties: { lien: { type: 'string' } }, required: ['line'], additionalProperties: false }, /required.*line/], // no call can ever pass
      [object({ line: { type: 'string', maxLength: '800' } }), /properties\.line\.maxLength/],
      [object({ paths: { type: 'array', minItems: -1 } }), /properties\.paths\.minItems/],
      [object({ n: { type: 'integer', minimum: '1' } }), /properties\.n\.minimum/],
      [{ type: 'object', properties: ['line'] }, /properties/],
      [object({ paths: { type: 'array', items: 'string' } }), /properties\.paths\.items/],
      [object({ v: { anyOf: { type: 'string' } } }), /properties\.v\.anyOf/],
      [object({ list: { type: 'array', items: { type: 'object', properties: { deep: { type: 'text' } } } } }), /properties\.list\.items\.properties\.deep\.type/],
      [{ type: 'object', additionalProperties: 'no' }, /additionalProperties/],
    ];
    for (const [schema, where] of cases) {
      assert.throws(() => mcp.registerTool('broken', withSchema(schema)), (err) => err instanceof TypeError && where.test(err.message) && /registerTool\(broken\)/.test(err.message), JSON.stringify(schema));
    }
    assert.equal(mcp.toolsFor('maker').some((tool) => tool.name === 'broken'), false, 'nothing was added');
  });

  test('a field that the hub refuses in every call cannot be declared', () => {
    const { mcp } = hub();
    for (const name of ['constructor', 'prototype']) {
      assert.throws(() => mcp.registerTool('broken', withSchema({ type: 'object', properties: { [name]: { type: 'string' } } })), /can never be sent/);
    }
  });

  test('the list form of items is named in the warning about unchecked keywords', () => {
    const { mcp, logs } = hub();
    mcp.registerTool('pair', withSchema(object({ pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } })));
    const warned = logs.find((entry) => entry.level === 'warn' && entry.data?.tool === 'pair' && Array.isArray(entry.data.keywords));
    assert.ok(warned, 'a warning names the tool');
    assert.ok(warned.data.keywords.some((keyword) => /items/.test(keyword)));
  });

  test('the schemas of the contract tools register without a warning', () => {
    const { mcp, logs } = hub();
    const text = { type: 'string', minLength: 1 };
    const task = {
      type: 'object',
      properties: {
        key: text, title: { type: 'string', minLength: 1, maxLength: 120 }, spec: text,
        acceptance: { type: 'array', items: text, minItems: 1, maxItems: 8 },
        zones: { type: 'array', items: { type: 'string', pattern: '^[^\\s]+$', maxLength: 200 }, minItems: 1 },
        domain: { enum: ['plan', 'backend', 'frontend', 'fix', 'review', 'test', 'data', 'algo', 'research', 'synthesis', 'docs', 'vision', 'chore'] },
        size: { enum: ['S', 'M', 'L'] },
        deps: { type: 'array', items: text }, reqs: { type: 'array', items: { type: 'integer', minimum: 1 } },
        pair: { type: 'boolean' }, stream: { type: 'string' },
      },
      required: ['key', 'title', 'spec', 'acceptance', 'zones', 'domain', 'size', 'reqs'],
      additionalProperties: false,
    };
    mcp.registerTool('plan_submit', {
      roles: ['boss'], description: 'Submit the plan.',
      inputSchema: {
        type: 'object',
        properties: {
          requirements: { type: 'array', items: object({ text }), minItems: 1, maxItems: 30 },
          tasks: { type: 'array', items: task, minItems: 1 },
          setup_cmd: { type: ['string', 'null'] }, check_cmd: { type: 'string' },
          assumptions: { type: 'array', items: { type: 'string' } }, notes: { type: 'string', description: 'Free text.' },
        },
        required: ['requirements', 'tasks'],
        additionalProperties: false,
      },
      handler: () => 'ok',
    });
    mcp.registerTool('req_verify', {
      roles: ['boss'], description: 'Final requirement check.',
      inputSchema: object({ results: { type: 'array', items: object({ id: { type: 'string', pattern: '^R[0-9]+$' }, ok: { type: 'boolean' }, evidence: text }) } }),
      handler: () => 'ok',
    });
    mcp.registerTool('status', { roles: ['manager', 'boss'], description: 'Tasks and agents.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => 'ok' });
    assert.deepEqual(logs.filter((entry) => entry.level !== 'debug'), []);
  });
});

// ---- 3. every tools/call leaves a record and gets a tool result -------------------------------------------------------------

describe('a handler cannot make a call vanish', () => {
  const odd = {
    'throws an object without a text form': () => {
      throw Object.create(null);
    },
    'rejects with an object without a text form': async () => {
      throw Object.create(null);
    },
    'throws an error whose message cannot be read': () => {
      const err = new Error('x');
      Object.defineProperty(err, 'message', { get() { throw new Error('no message'); } });
      throw err;
    },
    'returns an object whose then cannot be read': () => ({ get then() { throw new Error('then'); } }),
    'returns an object whose text cannot be read': () => ({ get text() { throw new Error('text'); } }),
    'returns a proxy that throws on every read': () => new Proxy({}, { get() { throw new Error('proxy'); } }),
    'resolves to an object whose text cannot be read': async () => ({ get text() { throw new Error('text'); } }),
  };

  for (const [what, handler] of Object.entries(odd)) {
    test(`a handler that ${what} gives an error result, and the call is recorded`, async () => {
      const { mcp, token, logs } = hub();
      mcp.registerTool('odd', { roles: ['all'], description: 'Odd.', handler });
      const answer = await mcp.handle(token.maker, call('odd', undefined, 7));
      assert.equal(answer.error, undefined, 'a tool failure is a tool result, not a protocol error');
      assert.equal(answer.id, 7);
      assert.equal(answer.result.isError, true);
      assert.match(textOf(answer), /^odd failed: /);
      assert.equal(textOf(answer).includes('\n'), false);
      assert.deepEqual(mcp.callsSince('A3', 0).map((entry) => [entry.name, entry.ok]), [['odd', false]]);
      assert.equal(logs.some((entry) => entry.msg === 'mcp: internal error'), false);
    });
  }

  test('a handler that returns a function does not send its source code to the model', async () => {
    const { mcp, token, logs } = hub();
    mcp.registerTool('odd', { roles: ['all'], description: 'Odd.', handler: () => function formatStatus() { return 'HUB-SOURCE-CODE'; } });
    const answer = await mcp.handle(token.maker, call('odd'));
    assert.equal(answer.result.isError, true);
    assert.equal(textOf(answer).includes('HUB-SOURCE-CODE'), false);
    assert.equal(textOf(answer).includes('function'), false);
    assert.ok(logs.some((entry) => entry.level === 'warn' && /must return a string/.test(entry.msg)));
    assert.deepEqual(mcp.callsSince('A3', 0).map((entry) => entry.ok), [false]);
  });

  test('handle itself never throws and never rejects, whatever a handler does', async () => {
    const { mcp, token } = hub();
    for (const [what, handler] of Object.entries(odd)) {
      mcp.registerTool('odd', { roles: ['all'], description: 'Odd.', handler });
      let answer;
      await assert.doesNotReject(async () => {
        answer = await mcp.handle(token.maker, [call('odd', undefined, 1), req('ping', undefined, 2)]);
      }, what);
      assert.deepEqual(answer.map((entry) => entry.id), [1, 2], what);
    }
  });
});

// ---- 4. time limits -----------------------------------------------------------------------------------------------------

describe('time limits of a call', () => {
  test('a very large or endless callTimeoutMs does not turn into a timeout of one millisecond', async () => {
    for (const callTimeoutMs of [Infinity, 2 ** 31, 1e12]) {
      const store = fakeStore([{ ...MAKER }]);
      const warnings = [];
      const onWarning = (warning) => warnings.push(warning.name);
      process.on('warning', onWarning);
      const mcp = createMcp({ store, callTimeoutMs });
      mcp.registerTool('slow', { roles: ['all'], description: 'Slow.', handler: async () => {
        await sleep(40);
        return 'made it';
      } });
      const answer = await mcp.handle(mcp.tokenFor('A3'), call('slow'));
      await sleep(5);
      process.off('warning', onWarning);
      assert.equal(textOf(answer), 'made it', `callTimeoutMs ${callTimeoutMs}`);
      assert.equal(answer.result.isError, false);
      assert.deepEqual(warnings.filter((name) => name === 'TimeoutOverflowWarning'), []);
    }
  });

  test('a tag provider that never answers costs the tag, not the call', async () => {
    const { mcp, token, logs } = hub({ callTimeoutMs: 60 });
    mcp.setTagProvider(() => new Promise(() => {}));
    const answer = await within(mcp.handle(token.maker, call('post', { line: 'INFO #build: The port is 8080.' }, 3)), 3000, 'the call never came back');
    assert.notEqual(answer, 'the call never came back');
    assert.deepEqual(answer, { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'ok 1' }], isError: false } });
    assert.ok(logs.some((entry) => entry.level === 'warn' && /tag provider/.test(entry.msg)));
    assert.deepEqual(mcp.callsSince('A3', 0).map((entry) => entry.ok), [true]);
  });
});

// ---- 5. call history ------------------------------------------------------------------------------------------------------

describe('callsSince', () => {
  test('gives the calls oldest first, also when a slow call ends after a fast one', async () => {
    let clock = 100;
    const { mcp, token } = hub({ now: () => clock });
    let release;
    mcp.registerTool('slow', { roles: ['all'], description: 'Slow.', handler: () => new Promise((resolve) => {
      release = () => resolve('slow done');
    }) });
    const slow = mcp.handle(token.maker, call('slow')); // starts at 100
    clock = 200;
    await mcp.handle(token.maker, call('post', { line: 'INFO #build: Fast.' })); // starts at 200, ends first
    clock = 300;
    release();
    await slow;
    assert.deepEqual(mcp.callsSince('A3', 0), [{ name: 'slow', ok: true, ts: 100 }, { name: 'post', ok: true, ts: 200 }]);
    assert.deepEqual(mcp.callsSince('A3', 150).map((entry) => entry.name), ['post']);
  });

  test('a call that ends after its agent left the store leaves no history behind', async () => {
    const { mcp, store, token } = hub();
    let release;
    mcp.registerTool('slow', { roles: ['all'], description: 'Slow.', handler: () => new Promise((resolve) => {
      release = () => resolve('slow done');
    }) });
    const slow = mcp.handle(token.maker, call('slow', undefined, 1));
    store.remove('agents', 'A3'); // the agent goes while its call runs
    release();
    assert.equal(textOf(await slow), 'slow done', 'the caller still gets its answer');
    assert.deepEqual(mcp.callsSince('A3', 0), [], 'no history for an agent that is gone');
    store.put('agents', { ...MAKER }); // a new agent with the same id starts clean
    assert.deepEqual(mcp.callsSince('A3', 0), []);
  });

  test('an unknown tool name is recorded and answered without control characters', async () => {
    const { mcp, token, logs } = hub();
    const answer = await mcp.handle(token.maker, call(`evil${CSI}31m${LINE_SEPARATOR}name\u0007`, {}));
    assert.equal(answer.error.code, -32602);
    const [entry] = mcp.callsSince('A3', 0);
    for (const text of [answer.error.message, entry.name, JSON.stringify(logs)]) {
      assert.equal(text.includes(CSI), false, 'no C1 control character');
      assert.equal(text.includes(LINE_SEPARATOR), false, 'no line separator');
      assert.equal(text.includes('\u0007'), false);
    }
  });

  test('an argument error never carries a raw line separator from a field name', () => {
    const [problem] = validateArgs(object({ line: { type: 'string' } }), { line: 'x', [`a${LINE_SEPARATOR}b${CSI}`]: 1 });
    assert.match(problem, /is not a known field$/);
    assert.equal(problem.includes(LINE_SEPARATOR), false);
    assert.equal(problem.includes(CSI), false);
  });
});

describe('the hub log', () => {
  test('an agent in a loop cannot fill the hub log: the same line goes out 20 times in 10 seconds, the rest is counted', async () => {
    const { mcp, token, logs } = hub();
    mcp.registerTool('boom', { roles: ['all'], description: 'Boom.', handler: () => {
      throw new Error('x');
    } });
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      for (let i = 0; i < 500; i++) {
        mcp.handle(token.maker, call('no_such_tool', {}));
        mcp.handle(token.maker, call('boom'));
      }
      const refused = () => logs.filter((entry) => /refused a call/.test(entry.msg));
      const failed = () => logs.filter((entry) => entry.msg === 'mcp: tool handler failed');
      assert.equal(refused().length, 20);
      assert.equal(failed().length, 20, 'each message has its own count');
      clock += 10_000; // ten seconds later
      mcp.handle(token.maker, call('no_such_tool', {}));
      assert.equal(refused().length, 21);
      assert.deepEqual(refused().at(-1).data, { agent: 'A3', role: 'maker', tool: 'no_such_tool', notLogged: 480 });
      mcp.handle(token.maker, call('no_such_tool', {}));
      assert.equal(refused().at(-1).data.notLogged, undefined, 'the count is said once');
    } finally {
      Date.now = realNow;
    }
    assert.equal(mcp.callsSince('A3', 0).length, 200, 'the calls are still counted (the last 200)');
  });
});

// ---- 6. tokens ----------------------------------------------------------------------------------------------------------------

describe('the token table drops tokens that are not in use', () => {
  function crowded() {
    const agents = [];
    for (let i = 0; i <= 2001; i++) agents.push({ id: `A${i}`, role: 'maker' });
    const mcp = createMcp({ store: fakeStore(agents) });
    mcp.registerTool('read', { roles: ['all'], description: 'Read.', handler: () => 'x' });
    const tokens = [];
    for (let i = 0; i < 2000; i++) tokens.push(mcp.tokenFor(`A${i}`)); // the table is full
    return { mcp, tokens };
  }

  test('an agent that still calls the hub keeps its token when the table is full', async () => {
    const { mcp, tokens } = crowded();
    // A0 got its token first (the lead boss of a long job) and is still at work.
    assert.equal((await mcp.handle(tokens[0], call('read'))).result.isError, false);
    const fresh = mcp.tokenFor('A2000'); // one too many: the token that was not used for the longest time goes
    assert.equal(mcp.agentFor(fresh).id, 'A2000');
    assert.equal(mcp.agentFor(tokens[0])?.id, 'A0', 'the working agent keeps its token');
    assert.equal((await mcp.handle(tokens[0], req('ping', undefined, 1))).error, undefined);
    assert.equal(mcp.agentFor(tokens[1]), null, 'the idle agent A1 lost its token');
    assert.equal(mcp.agentFor(tokens[2]).id, 'A2');
  });

  test('asking for the token again (a new turn) also keeps it', () => {
    const { mcp, tokens } = crowded();
    assert.equal(mcp.tokenFor('A0'), tokens[0]); // the runner asks at the start of every turn
    mcp.tokenFor('A2000');
    mcp.tokenFor('A2001');
    assert.equal(mcp.agentFor(tokens[0])?.id, 'A0');
    assert.equal(mcp.agentFor(tokens[1]), null);
    assert.equal(mcp.agentFor(tokens[2]), null);
    assert.equal(mcp.agentFor(tokens[3]).id, 'A3');
  });
});

// ---- 7. every request gets an answer with its id ------------------------------------------------------------------------------

describe('an unknown token and batches', () => {
  test('mountMcp answers every request of a batch when the token is unknown', async () => {
    const { mcp } = hub();
    const { port } = await serve(mcp);
    const post = (body) => fetch(`http://127.0.0.1:${port}/mcp/${'0'.repeat(64)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const batch = await post([req('initialize', {}, 1), notice('notifications/initialized'), req('tools/list', undefined, 'two'), call('post', { line: 'x' }, 3)]);
    assert.equal(batch.status, 404);
    assert.deepEqual(await batch.json(), [
      { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unknown agent' } },
      { jsonrpc: '2.0', id: 'two', error: { code: -32001, message: 'unknown agent' } },
      { jsonrpc: '2.0', id: 3, error: { code: -32001, message: 'unknown agent' } },
    ]);
    const single = await post(req('ping', undefined, 9));
    assert.equal(single.status, 404);
    assert.deepEqual(await single.json(), { jsonrpc: '2.0', id: 9, error: { code: -32001, message: 'unknown agent' } });
    const quiet = await post([notice('notifications/initialized')]);
    assert.equal(quiet.status, 404);
    assert.deepEqual(await quiet.json(), { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unknown agent' } });
    // More requests than a batch may hold: one error, so a stranger cannot make the hub write a huge answer.
    const flood = await post(Array.from({ length: 51 }, (unused, i) => req('ping', undefined, i)));
    assert.equal(flood.status, 404);
    assert.deepEqual(await flood.json(), { jsonrpc: '2.0', id: 0, error: { code: -32001, message: 'unknown agent' } });
  });

  test('the shim answers every id of a batch when the hub gives one error for all of it', async () => {
    const { mcp, token } = hub();
    const { url } = await serve(mcp);
    const stale = startShim(`${url}/mcp/${'9'.repeat(64)}`);
    stale.send([req('ping', undefined, 1), notice('notifications/initialized'), req('tools/list', undefined, 2), call('post', { line: 'x' }, 3)]);
    const lost = await stale.line((message) => Array.isArray(message));
    assert.deepEqual(lost.map((answer) => [answer.id, answer.error.code, answer.error.message]), [[1, -32001, 'unknown agent'], [2, -32001, 'unknown agent'], [3, -32001, 'unknown agent']]);
    assert.deepEqual(await stale.end(), { code: 0, signal: null });
    assert.equal(stale.lines.length, 1);

    // A batch that the hub refuses as a whole (too many messages): one error object comes back for all of it.
    const shim = startShim(`${url}/mcp/${token.maker}`);
    shim.send(Array.from({ length: 51 }, (unused, i) => req('ping', undefined, `p${i}`)));
    const refused = await shim.line((message) => Array.isArray(message));
    assert.equal(refused.length, 51);
    assert.deepEqual(refused.map((answer) => answer.id), Array.from({ length: 51 }, (unused, i) => `p${i}`));
    for (const answer of refused) {
      assert.equal(answer.error.code, -32600);
      assert.match(answer.error.message, /at most 50 messages/);
    }
    shim.send(req('ping', undefined, 'after'));
    assert.deepEqual((await shim.answer('after')).result, {});
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });

  test('the shim gives a request its own id back, whatever id the hub put on the answer', async () => {
    const replies = [
      '{"jsonrpc":"2.0","id":null,"result":{"n":1}}', // no id
      '{"jsonrpc":"2.0","id":99,"result":{"n":2}}', // another id
      '[{"jsonrpc":"2.0","id":3,"result":{"n":3}}]', // a list for one request
      '[{"jsonrpc":"2.0","id":"x","result":{}},{"jsonrpc":"2.0","id":"y","result":{}}]', // a list without the id
    ];
    const server = http.createServer((request, res) => {
      request.resume();
      request.on('end', () => {
        const body = replies.shift() ?? '{}';
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    const shim = startShim(`http://127.0.0.1:${server.address().port}/mcp/x`);
    for (const id of [1, 2, 3, 4]) shim.send(req('tools/list', undefined, id));
    assert.deepEqual((await shim.answer(1)).result, { n: 1 });
    assert.deepEqual((await shim.answer(2)).result, { n: 2 });
    assert.deepEqual((await shim.answer(3)).result, { n: 3 });
    assert.equal((await shim.answer(4)).error.code, -32603);
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
    assert.deepEqual(shim.lines.map((line) => JSON.parse(line).id), [1, 2, 3, 4], 'one answer per request, each with the id of the request');
  });
});

// ---- 8. the shim and a hub that stops ---------------------------------------------------------------------------------------------

/**
 * A hub on a raw TCP socket, so that a test can make it "die" without the client seeing it at once:
 * freeze() stops listening and from then on reads nothing and answers nothing on the open connections
 * (requests that still arrive there are counted in `lost`); cut() closes those connections; thaw()
 * listens again on the same port.
 */
function rawHub() {
  const sockets = new Set();
  const state = { served: [], lost: [], connections: 0, perConnection: [] };
  let server = null;
  let port = 0;
  let frozen = false;

  function onConnection(socket) {
    const index = state.connections;
    state.connections += 1;
    state.perConnection[index] = 0;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const head = buffer.indexOf('\r\n\r\n');
        if (head < 0) return;
        const headers = buffer.subarray(0, head).toString('latin1');
        const length = Number(/^content-length:\s*(\d+)/im.exec(headers)?.[1] ?? 0);
        if (buffer.length < head + 4 + length) return;
        const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString('utf8'));
        buffer = buffer.subarray(head + 4 + length);
        state.perConnection[index] += 1;
        if (frozen) {
          state.lost.push(message.method); // the hub is dead: nobody will ever answer this
          continue;
        }
        state.served.push(message.method);
        const close = /^connection:\s*close/im.test(headers);
        const answer = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/call' ? { content: [{ type: 'text', text: 'done' }], isError: false } : {} });
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(answer)}\r\n${close ? 'Connection: close\r\n' : ''}\r\n${answer}`);
        if (close) socket.end();
      }
    });
  }

  async function listen(fixed) {
    const created = net.createServer(onConnection);
    await new Promise((resolve, reject) => {
      created.once('error', reject);
      created.listen(fixed, '127.0.0.1', resolve);
    });
    server = created;
    port = created.address().port;
    return port;
  }

  return {
    state,
    async start() {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await listen(20000 + Math.floor(Math.random() * 12000));
        } catch (err) {
          if (err.code !== 'EADDRINUSE' || attempt > 20) throw err;
        }
      }
    },
    freeze() {
      frozen = true;
      const old = server;
      server = null;
      return new Promise((resolve) => {
        old.close(() => resolve()); // resolves when the open connections are gone too
        setTimeout(resolve, 50); // ... which a kept connection prevents: go on
      });
    },
    cut() {
      for (const socket of sockets) socket.destroy();
    },
    async thaw() {
      frozen = false;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await listen(port);
        } catch (err) {
          if (err.code !== 'EADDRINUSE' || attempt > 60) throw err;
          await sleep(50);
        }
      }
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('stdio shim: a hub that stops', () => {
  test('a tools/call is never written to a connection of a hub that is gone', async () => {
    const fake = rawHub();
    const port = await fake.start();
    cleanups.push(() => fake.stop());
    const shim = startShim(`http://127.0.0.1:${port}/mcp/x`, { env: { WORKSHOP_MCP_RETRY_MS: '8000' } });
    shim.send(req('ping', undefined, 1));
    assert.deepEqual((await shim.answer(1)).result, {});
    await sleep(60);

    await fake.freeze(); // the hub dies; a connection that the shim kept would not know yet
    shim.send(call('post', { line: 'DONE T1 tests=3/3: The login form works.' }, 2));
    await sleep(200);
    fake.cut(); // now the death shows on every old connection
    await sleep(100);
    await fake.thaw(); // the hub is back on the same port

    const answer = await shim.answer(2, 15_000);
    assert.deepEqual(fake.state.lost, [], 'the call went to a dead connection, where nobody could answer it');
    assert.deepEqual(answer, { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'done' }], isError: false } });
    assert.deepEqual(fake.state.served, ['ping', 'tools/call'], 'the call ran once');
    assert.ok(fake.state.perConnection.every((count) => count <= 1), `one request per connection: ${fake.state.perConnection}`);
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });

  test('ten hub stops in a row: the next call always waits for the hub and never gets "the connection broke"', async () => {
    const { mcp, token } = hub();
    const { url, router } = await serve(mcp, { restartable: true });
    const shim = startShim(`${url}/mcp/${token.maker}`, { env: { WORKSHOP_MCP_RETRY_MS: '120' } });
    for (let round = 0; round < 10; round++) {
      shim.send(req('ping', undefined, `up-${round}`));
      await shim.answer(`up-${round}`);
      await router.close();
      shim.send(call('post', { line: 'INFO #build: During the stop.' }, `down-${round}`)); // at once: the shim may not know yet
      const lost = await shim.answer(`down-${round}`);
      assert.equal(lost.error.message, 'The WorkShop hub is not reachable. The call was not done. Try again in a moment.', `round ${round}`);
      await router.reopen();
    }
    assert.equal(mcp.callsSince('A3', 0).length, 0, 'no call of a stop ever ran');
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });
});

// ---- 9. the shim keeps the token to itself ---------------------------------------------------------------------------------------

describe('stdio shim: the token', () => {
  const TOKEN = 'f00dfeed'.repeat(8);

  test('a URL with a user name or password is refused, and the token does not reach stderr', async () => {
    for (const url of [`http://user:pass@127.0.0.1:9/mcp/${TOKEN}`, `http://user@127.0.0.1:9/mcp/${TOKEN}`]) {
      const shim = startShim(url);
      shim.send(req('ping', undefined, 1));
      const exit = await within(shim.exited, 5000, 'still running');
      assert.deepEqual(exit, { code: 2, signal: null });
      assert.equal(shim.stderr.includes(TOKEN), false, `stderr: ${shim.stderr}`);
      assert.equal(shim.stderr.includes('pass'), false);
      assert.match(shim.stderr, /usage: node mcp-stdio-shim\.mjs --url-file <path>/); // contract 8, 10: --url-file is the adapter form
      assert.equal(shim.lines.length, 0);
    }
  });

  test('--url-file: a URL with a password in the file is refused too, and nothing of the file reaches stderr', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-shim-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'mcp-url');
    fs.writeFileSync(file, `http://user:pass@127.0.0.1:9/mcp/${TOKEN}\n`, { mode: 0o600 });
    const shim = startShim(null, { args: ['--url-file', file] });
    assert.deepEqual(await within(shim.exited, 5000, 'still running'), { code: 2, signal: null });
    assert.equal(shim.stderr.includes(TOKEN), false, `stderr: ${shim.stderr}`);
    assert.equal(shim.stderr.includes('pass'), false);
    assert.equal(shim.lines.length, 0);
  });

  test('no note on stderr ever holds the token, whatever goes wrong', async () => {
    // A hub that redirects, a port that fetch refuses, a hub that is down, a hub with an error page.
    const redirect = http.createServer((request, res) => {
      request.resume();
      request.on('end', () => {
        res.writeHead(307, { location: `http://127.0.0.1:9/mcp/${TOKEN}` });
        res.end();
      });
    });
    await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => {
      redirect.closeAllConnections();
      redirect.close(resolve);
    }));
    const closed = net.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = closed.address().port; // nothing listens here in a moment
    await new Promise((resolve) => closed.close(resolve));
    const said = {};
    for (const [what, origin] of [['redirect', `http://127.0.0.1:${redirect.address().port}`], ['blocked', 'http://127.0.0.1:6000'], ['down', `http://127.0.0.1:${closedPort}`]]) {
      const shim = startShim(`${origin}/mcp/${TOKEN}?t=${TOKEN}`, { env: { WORKSHOP_MCP_RETRY_MS: '50' } });
      shim.send(call('post', { line: 'x' }, 1));
      shim.send(req('tools/list', undefined, 2));
      const first = await shim.answer(1);
      assert.equal(first.error.code, -32603);
      assert.equal((await shim.answer(2)).error.code, -32603);
      assert.deepEqual(await shim.end(), { code: 0, signal: null });
      assert.match(shim.stderr, /\[shop-mcp\]/, 'the shim said what is wrong');
      assert.equal(shim.stderr.includes(TOKEN), false, `stderr: ${shim.stderr}`);
      assert.equal(shim.lines.join('\n').includes(TOKEN), false);
      said[what] = first.error.message;
    }
    // A port that fetch refuses to call is not "a connection that broke": nothing was sent.
    assert.equal(said.blocked, 'The WorkShop hub uses a port that this program may not call. The call was not done. Tell the owner.');
    assert.equal(said.down, 'The WorkShop hub is not reachable. The call was not done. Try again in a moment.');
  });

  test('`ps` does not show the token of a running shim, as an argument or in the environment', async (t) => {
    // Every process of the same user can run `ps`, so also the other agents.
    const { mcp, token } = hub();
    const { url } = await serve(mcp);
    const target = `${url}/mcp/${token.maker}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-shim-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const urlFile = path.join(dir, 'mcp-url');
    fs.writeFileSync(urlFile, `${target}\n`, { mode: 0o600 });
    const forms = [
      ['argument', startShim(target)],
      ['environment', startShim(null, { args: [], env: { WORKSHOP_MCP_URL: target } })],
      ['url file', startShim(null, { args: ['--url-file', urlFile] })], // how providers/gemini.js starts it (contract 10)
    ];
    for (const [form, shim] of forms) {
      shim.send(req('ping', undefined, 1));
      await shim.answer(1);
      let listed;
      try {
        listed = execFileSync('ps', ['-ww', '-p', String(shim.child.pid), '-o', 'command='], { encoding: 'utf8' });
      } catch {
        return t.skip('ps is not usable here');
      }
      try {
        listed += execFileSync('ps', ['eww', '-p', String(shim.child.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); // with the environment
      } catch { /* this ps cannot show the environment: the check above stands */ }
      assert.equal(listed.includes(token.maker), false, `${form}: ps shows ${listed}`);
      assert.equal(listed.includes('/mcp/'), false, form);
      shim.send(req('ping', undefined, 2)); // the shim still knows where the hub is
      assert.deepEqual((await shim.answer(2)).result, {}, form);
      assert.deepEqual(await shim.end(), { code: 0, signal: null });
    }
    return undefined;
  });
});

// ---- 10. the shim does not blame the hub for its own trouble ----------------------------------------------------------------------

describe('stdio shim: large and odd messages', () => {
  test('arguments that are nested very deep reach the hub and get its answer', async () => {
    const { mcp, token, seen } = hub();
    const { url } = await serve(mcp);
    const shim = startShim(`${url}/mcp/${token.maker}`);
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    shim.send(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"post","arguments":{"line":"x","more":${deep}}}}`);
    shim.send(req('ping', undefined, 6));
    const answer = await shim.answer(5);
    assert.equal(answer.error, undefined, 'the hub answered, the shim did not make up a connection error');
    assert.equal(answer.result.isError, true);
    assert.match(textOf(answer), /^post: bad arguments\. arguments are nested too deep/);
    assert.deepEqual((await shim.answer(6)).result, {});
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
    assert.equal(shim.stderr.includes('not reachable'), false, `the hub was never down: ${shim.stderr}`);
    assert.deepEqual(seen, []);
    assert.deepEqual(mcp.callsSince('A3', 0).map((entry) => [entry.name, entry.ok]), [['post', false]]);
  });

  test('WORKSHOP_MCP_TIMEOUT_MS=0 means no time limit, as for the hub', async () => {
    const { mcp, token } = hub();
    mcp.registerTool('slow', { roles: ['all'], description: 'Slow.', handler: async () => {
      await sleep(150);
      return 'slow but done';
    } });
    const { url } = await serve(mcp);
    const shim = startShim(`${url}/mcp/${token.maker}`, { env: { WORKSHOP_MCP_TIMEOUT_MS: '0' } });
    shim.send(call('slow', undefined, 1));
    const answer = await shim.answer(1);
    assert.equal(answer.error, undefined);
    assert.equal(textOf(answer), 'slow but done');
    assert.deepEqual(await shim.end(), { code: 0, signal: null });
  });
});
