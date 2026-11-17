// Tests of the skeptical verification pass over the core group (config.js, http.js, redact.js, secrets.js).
// Each test proves one defect found after the alignment with the amended contract, or guards a path the
// earlier tests left open.
// Run: node --test tests/core.verify.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSettings } from '../server/config.js';
import { createHttp } from '../server/http.js';
import { createRedactor } from '../server/redact.js';
import { createSecrets } from '../server/secrets.js';

const OWNER_KEY = 'verify-owner-key-0123456789abcdef0123456789abcdef';

let tmp;
let logs;
let servers;
const log = (level, msg, data) => logs.push({ level, msg, data });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-verify-'));
  logs = [];
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((app) => app.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const all = body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: all, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Raw bytes on a socket; resolves with the whole answer as text. */
function raw(port, bytes) {
  return new Promise((resolve) => {
    let text = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.end(bytes));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('close', () => resolve(text));
    socket.on('error', () => resolve(text));
  });
}

async function hub(setup = () => {}) {
  const app = createHttp({ log, ownerKey: OWNER_KEY, closeGraceMs: 50 });
  servers.push(app);
  setup(app);
  const { port } = await app.listen();
  const res = await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: OWNER_KEY }), headers: { 'X-WorkShop': '1' } });
  assert.equal(res.status, 200);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  return { app, port, cookie, session: cookie.split('=')[1] };
}

// ---- config: selfTest.<lab> in the shape the contract and the providers module use ----

test('selfTest.<lab> takes the record of contract section 10: core and advisory are lists, version may be unknown', () => {
  const settings = createSettings({ configDir: path.join(tmp, 'config'), log });
  // providers.selfTest() stores exactly this: { version: state.version ?? null, ok, core:[...], advisory:[...], ts }.
  const core = [{ name: 'Write a file outside the turn folder', ok: true, detail: 'Denied.' }];
  const advisory = [{ name: 'Reach a host that is not a registry or localhost', ok: false, detail: 'Reached.' }];
  const entry = { version: '2.4.1', ok: true, core, advisory, ts: 1794700800000 };
  assert.deepEqual(settings.update({ selfTest: { claude: entry } }).selfTest.claude, entry);
  const unknownVersion = { version: null, ok: false, core: [], advisory: [], ts: 5 };
  assert.deepEqual(settings.update({ selfTest: { gemini: unknownVersion } }).selfTest.gemini, unknownVersion);
  // The record survives a restart.
  assert.deepEqual(createSettings({ configDir: path.join(tmp, 'config'), log }).get().selfTest, { claude: entry, gemini: unknownVersion });
  // Lists of something other than records stay refused.
  for (const bad of [{ core: ['ok'] }, { advisory: [null] }, { core: 'all' }, { version: 2 }]) {
    assert.throws(() => settings.update({ selfTest: { claude: { ...entry, ...bad } } }), (err) => err.status === 400, JSON.stringify(bad));
  }
});

// ---- http: the owner key and the session value never reach the log, whoever writes the message ----

test('a handler error that quotes the owner key or the session value is logged without them', async () => {
  let session = null;
  const { port, cookie, session: value } = await hub((app) => {
    app.route('POST', '/api/echo', ({ body }) => {
      throw new Error(`cannot use ${body.v}`); // a careless handler: its message echoes the body
    });
    app.route('POST', '/api/echo4', ({ body }) => {
      throw Object.assign(new Error(`bad value ${body.v}`), { status: 400 });
    });
  });
  session = value;
  for (const route of ['/api/echo', '/api/echo4']) {
    for (const v of [OWNER_KEY, session, `x${OWNER_KEY}y`]) {
      await request(port, { method: 'POST', path: route, body: JSON.stringify({ v }), headers: { 'X-WorkShop': '1', Cookie: cookie } });
    }
  }
  assert.ok(logs.some((l) => /POST \/api\/echo failed/.test(l.msg)), 'the 500 was logged');
  const text = JSON.stringify(logs);
  assert.equal(text.includes(OWNER_KEY), false, 'the owner key is not in the log');
  assert.equal(text.includes(session), false, 'the session value is not in the log');
});

test('a request in absolute form or with a bad target never reaches an /api handler without the cookie', async () => {
  const hits = [];
  const { port } = await hub((app) => {
    app.route('GET', '/api/state', () => {
      hits.push('state');
      return { secret: true };
    });
  });
  const host = `127.0.0.1:${port}`;
  for (const target of [`http://${host}/api/state`, `//api/state`, `/api//state`, `/api/state#x`, '*']) {
    const text = await raw(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    assert.doesNotMatch(text, /^HTTP\/1\.1 200/, target);
    assert.doesNotMatch(text, /"secret"/, target);
  }
  assert.deepEqual(hits, []);
});

test('createHttp binds the loopback interface only: another host is refused before anything listens', async () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '', 'example.com']) {
    assert.throws(() => createHttp({ host, ownerKey: OWNER_KEY }), TypeError, host);
  }
  // The default and an explicit 127.0.0.1 work.
  const app = createHttp({ host: '127.0.0.1', ownerKey: OWNER_KEY, closeGraceMs: 50 });
  servers.push(app);
  const { url } = await app.listen();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

// ---- redactor: overlapping values ----

test('redact: two held values that overlap in a text leave no part of either', () => {
  const r = createRedactor();
  const a = 'AAAAAAAA-1234';
  const b = '1234-BBBBBBBB';
  r.add(a);
  r.add(b);
  const out = r.redact(`x AAAAAAAA-1234-BBBBBBBB y`);
  assert.equal(out.includes('BBBB'), false, out);
  assert.equal(out.includes('AAAA'), false, out);
  assert.equal(out, 'x [redacted] y');
  // Same length, the second starts inside the first.
  const r2 = createRedactor();
  r2.add('abcdefgh12');
  r2.add('gh12345678');
  assert.equal(r2.redact('abcdefgh12345678!'), '[redacted]!');
  // Values next to each other stay two marks; plain text between them stays.
  assert.equal(r.redact(`${a} ${b}`), '[redacted] [redacted]');
  assert.equal(r.redact(`${a}${a}`), '[redacted][redacted]');
});

// ---- secrets with a fake Keychain tool: the paths the file backend cannot reach ----

/**
 * A fake /usr/bin/security. Its behaviour comes from <dir>/mode: 'hang-save' (a save never answers),
 * 'refuse-read' (find -w exits 51), else a working store in <dir>/items.json.
 */
function fakeSecurity(dir) {
  const bin = path.join(dir, 'security');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const mode = fs.existsSync(path.join(dir, 'mode')) ? fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim() : '';
const itemsFile = path.join(dir, 'items.json');
const items = fs.existsSync(itemsFile) ? JSON.parse(fs.readFileSync(itemsFile, 'utf8')) : {};
const args = process.argv.slice(2);
const account = args[args.indexOf('-a') + 1];
if (args[0] === '-i') {
  let input = ''; process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    if (mode === 'hang-save') { setTimeout(() => {}, 60000); return; }
    const m = / -a (\\S+) .* -X ([0-9a-f]+)/.exec(input);
    items[m[1]] = Buffer.from(m[2], 'hex').toString(); fs.writeFileSync(itemsFile, JSON.stringify(items)); process.exit(0);
  });
} else if (args[0] === 'find-generic-password') {
  if (!(account in items)) process.exit(44);
  if (args.includes('-w')) { if (mode === 'refuse-read') process.exit(51); process.stdout.write(items[account] + '\\n'); }
  process.exit(0);
} else if (args[0] === 'delete-generic-password') {
  if (!(account in items)) process.exit(44); delete items[account]; fs.writeFileSync(itemsFile, JSON.stringify(items)); process.exit(0);
} else process.exit(1);
`, { mode: 0o700 });
  return bin;
}

test('secrets: a save that timed out (the value may be stored) still reaches the redactor', async () => {
  const tool = path.join(tmp, 'tool');
  fs.mkdirSync(tool);
  const securityPath = fakeSecurity(tool);
  fs.writeFileSync(path.join(tool, 'mode'), 'hang-save');
  const redactor = createRedactor();
  const secrets = createSecrets({ backend: 'keychain', service: 'WorkShop-fake', dataDir: path.join(tmp, 'data'), log, redactor, securityPath, timeoutMs: 400 });
  const value = 'sk-verify-maybe-stored-0123456789';
  await assert.rejects(secrets.set('anthropic', value), (err) => err.status === 503);
  assert.equal(redactor.hit(`x ${value}`), true);
  assert.equal(JSON.stringify(logs).includes(value), false);
});

test('secrets: primeRedactor() stops with a warning that names ids only when the Keychain refuses reads', async () => {
  const tool = path.join(tmp, 'tool');
  fs.mkdirSync(tool);
  const securityPath = fakeSecurity(tool);
  const values = { anthropic: 'sk-verify-prime-aaaaaaaaaaaa', gemini: 'sk-verify-prime-bbbbbbbbbbbb' };
  fs.writeFileSync(path.join(tool, 'items.json'), JSON.stringify(values));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'keys-meta.json'), JSON.stringify({
    anthropic: { label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', hint: 'aaaa', updatedAt: 1 },
    gemini: { label: 'Google Gemini', envVar: 'GEMINI_API_KEY', hint: 'bbbb', updatedAt: 1 },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(tool, 'mode'), 'refuse-read');
  const redactor = createRedactor();
  const secrets = createSecrets({ backend: 'keychain', service: 'WorkShop-fake', dataDir, log, redactor, securityPath, timeoutMs: 5000 });
  assert.equal(await secrets.primeRedactor(), 0);
  const warned = logs.filter((l) => l.level === 'warn' && /could not load the stored keys into the redactor/.test(l.msg));
  assert.equal(warned.length, 1, 'one warning, not one per key');
  assert.equal(warned[0].data.id, 'anthropic');
  // Reads work again: the next prime loads both.
  fs.rmSync(path.join(tool, 'mode'));
  assert.equal(await secrets.primeRedactor(), 2);
  assert.equal(redactor.hit(values.anthropic) && redactor.hit(values.gemini), true);
  const text = JSON.stringify(logs);
  for (const value of Object.values(values)) assert.equal(text.includes(value), false);
});

// ---- secrets: a broken redactor never puts the value into the log ----

test('secrets: a redactor that throws with the value in its message is logged without the value', async () => {
  const value = 'sk-verify-value-0123456789';
  const redactor = {
    add(v) { throw new Error(`cannot add ${v}`); },
    remove(v) { throw new Error(`cannot remove ${v}`); },
  };
  const secrets = createSecrets({ backend: 'file', dataDir: path.join(tmp, 'data'), log, redactor });
  await secrets.set('anthropic', value);
  await secrets.get('anthropic');
  await secrets.remove('anthropic');
  assert.ok(logs.some((l) => /redactor\.add failed/.test(l.msg)));
  assert.equal(JSON.stringify(logs).includes(value), false);
});
