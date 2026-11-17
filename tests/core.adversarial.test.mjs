// Adversarial tests for the core module (config.js, store.js, http.js).
// Each test proves one defect that the skeptical review found, or guards a risky path
// (crash in the middle of a save, re-entrant subscribers, error answers on a kept connection).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, createSettings } from '../server/config.js';
import { createStore } from '../server/store.js';
import { createHttp } from '../server/http.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeUrl = pathToFileURL(path.join(repoRoot, 'server', 'store.js')).href;
const httpUrl = pathToFileURL(path.join(repoRoot, 'server', 'http.js')).href;

let tmp; // temp root of one test
let dir; // data dir
let configDir;
let file; // settings.json
let logs;
let stores;
let servers;
const log = (level, msg, data) => logs.push({ level, msg, data });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateFile = () => path.join(dir, 'state.json');
const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
const readEvents = () => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const readSettings = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = () => logs.filter((l) => l.level === 'error');
const OWNER_KEY = 'owner-key-of-the-adversarial-tests';
/** port -> 'name=value' of an owner session that start() opened. request() adds it when the caller sends no cookie. */
const cookies = new Map();

/** Open a store on the temp data dir. Every store is flushed before the dir is removed. */
function open(opts = {}) {
  const store = createStore({ dataDir: dir, log, saveDelayMs: 20, ...opts });
  stores.push(store);
  return store;
}

/** Create a server that the test run closes again. `setup(app)` adds routes before listen(). The owner session is opened. */
async function start(opts = {}, setup = () => {}) {
  const app = createHttp({ log, ownerKey: OWNER_KEY, ...opts });
  servers.push(app);
  const extra = setup(app);
  const { port } = await app.listen();
  cookies.set(port, await login(port));
  return { app, port, extra };
}

/** Post the owner key as the UI does. Returns the cookie as 'name=value'. */
async function login(port, key = OWNER_KEY) {
  const res = await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: key }), headers: { 'X-WorkShop': '1' } });
  assert.equal(res.status, 200, 'the owner session opens');
  return res.headers['set-cookie'][0].split(';')[0];
}

/** One HTTP request. Only the cookie of a session that start() opened is added: no X-WorkShop header, no Origin. */
function request(port, { method = 'GET', path: target = '/', headers: given = {}, body } = {}) {
  const sendsCookie = Object.keys(given).some((name) => name.toLowerCase() === 'cookie');
  const headers = cookies.has(port) && !sendsCookie ? { ...given, Cookie: cookies.get(port) } : given;
  return new Promise((resolve, reject) => {
    const all = body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) };
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

/** A request as the UI sends it: X-WorkShop on every call, JSON body. */
function call(port, method, target, body) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return request(port, { method, path: target, body: payload, headers: { 'X-WorkShop': '1', 'Content-Type': 'application/json' } });
}

/** Send raw bytes on one socket and return everything the server answers until it closes the socket. */
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
    socket.setTimeout(15000, () => socket.destroy(new Error('raw exchange timed out')));
  });
}

/** Write a script into the temp root and run it with Node. Resolves with how it ended; never rejects. */
function runNode(name, source, args = [], timeout = 20000) {
  const script = path.join(tmp, name);
  fs.writeFileSync(script, source);
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? null : 0, signal: err?.signal ?? null, timedOut: err?.killed === true, stdout, stderr });
    });
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-core-adv-'));
  dir = path.join(tmp, 'data');
  configDir = path.join(tmp, 'config');
  file = path.join(configDir, 'settings.json');
  fs.mkdirSync(dir);
  logs = [];
  stores = [];
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((app) => app.close()));
  for (const store of stores) await store.flush();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('config: contract values and bad values', () => {
  test('contract 14b: no lab has an auth mode until the owner chooses one', () => {
    assert.deepEqual(DEFAULT_SETTINGS.auth, { claude: null, gemini: null });
    const settings = createSettings({ configDir, log });
    assert.deepEqual(settings.get().auth, { claude: null, gemini: null });
    assert.deepEqual(settings.update({ auth: { claude: 'apikey' } }).auth, { claude: 'apikey', gemini: null });
    assert.deepEqual(readSettings(), { auth: { claude: 'apikey' } }); // only the difference: no migration marker (contract 14b)
    assert.deepEqual(createSettings({ configDir, log }).get().auth, { claude: 'apikey', gemini: null });
    assert.equal(settings.update({ auth: { claude: null } }).auth.claude, null); // the owner may take the choice back
    assert.deepEqual(readSettings(), {});
  });

  test('update() refuses an auth mode, a budget, a safety mode or a thrift outside the contract', () => {
    const settings = createSettings({ configDir, log });
    const bad = [
      [{ auth: { claude: 'banana' } }, /settings\.auth\.claude must be/],
      [{ auth: { claude: 'subscription' } }, /settings\.auth\.claude must be/],
      [{ auth: { gemini: 'Subscription' } }, /settings\.auth\.gemini must be/],
      [{ auth: { claude: 1 } }, /settings\.auth\.claude must be/],
      [{ auth: { claude: true } }, /settings\.auth\.claude must be/],
      [{ auth: { claude: { mode: 'apikey' } } }, /settings\.auth\.claude must be/],
      [{ auth: { openai: 'oauth' } }, /settings\.auth\.openai must be/],
      [{ budgetUsd: 'abc' }, /settings\.budgetUsd must be/],
      [{ budgetUsd: '50' }, /settings\.budgetUsd must be/],
      [{ budgetUsd: -5 }, /settings\.budgetUsd must be/],
      [{ budgetUsd: [50] }, /settings\.budgetUsd must be/],
      [{ budgetUsd: { usd: 50 } }, /settings\.budgetUsd must be/],
      [{ safety: 'yolo' }, /settings\.safety must be/],
      [{ safety: 'Trusting' }, /settings\.safety must be/],
      [{ thrift: 7 }, /settings\.thrift must be/],
      [{ thrift: -0.1 }, /settings\.thrift must be/],
      [{ pairing: 'none' }, /settings\.pairing must be/],
      [{ pairing: 'm+l' }, /settings\.pairing must be/],
      [{ presence: 'gone' }, /settings\.presence must be/],
      [{ presence: true }, /settings\.presence must be/],
      [{ limits: { taskTimeoutMin: 30 } }, /settings\.limits\.taskTimeoutMin must be an object/],
      [{ limits: { taskTimeoutMin: { S: '20' } } }, /settings\.limits\.taskTimeoutMin\.S must be a number/],
      [{ board: 5 }, /settings\.board must be an object/],
      [{ approvePlan: true, thrift: 2 }, /settings\.thrift must be/], // one bad key refuses the whole patch
    ];
    for (const [patch, pattern] of bad) {
      assert.throws(() => settings.update(patch), (err) => err.status === 400 && pattern.test(err.message), JSON.stringify(patch));
    }
    assert.deepEqual(settings.get(), DEFAULT_SETTINGS);
    assert.equal(fs.existsSync(file), false);
    // Every value that the contract names is accepted (Phase 0: Frontier apikey only).
    const good = settings.update({ auth: { claude: 'apikey', gemini: 'apikey' }, budgetUsd: 12.5, safety: 'trusting', thrift: 1 });
    assert.deepEqual([good.auth, good.budgetUsd, good.safety, good.thrift], [{ claude: 'apikey', gemini: 'apikey' }, 12.5, 'trusting', 1]);
    const back = settings.update({ auth: { claude: null }, budgetUsd: 0, safety: 'sandboxed', thrift: 0 });
    assert.deepEqual([back.auth.claude, back.budgetUsd, back.safety, back.thrift], [null, 0, 'sandboxed', 0]);
    assert.equal(settings.update({ budgetUsd: null }).budgetUsd, null); // no default budget
    const v1 = settings.update({ pairing: 'all', presence: 'away', board: { postChars: 900 }, limits: { taskTimeoutMin: { L: 120 } } });
    assert.deepEqual([v1.pairing, v1.presence, v1.board, v1.limits.taskTimeoutMin], ['all', 'away', { postChars: 900 }, { S: 20, M: 45, L: 120 }]);
  });

  test('settings.json: a value outside the contract is ignored with a warning, the rest is used', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      auth: { claude: 'banana', gemini: 'apikey' }, authAck: {}, budgetUsd: 'lots', safety: 'yolo', thrift: 3, pairing: 'some', presence: 'out', approvePlan: true,
    }));
    const s = createSettings({ configDir, log }).get();
    assert.deepEqual(s.auth, { claude: null, gemini: 'apikey' });
    assert.deepEqual([s.budgetUsd, s.safety, s.thrift, s.pairing, s.presence, s.approvePlan], [20, 'sandboxed', 0.3, 'M+L', 'here', true]);
    const warned = logs.filter((l) => l.level === 'warn').map((l) => l.msg).join('\n');
    for (const key of ['auth\\.claude', 'budgetUsd', 'safety', 'thrift', 'pairing', 'presence']) assert.match(warned, new RegExp(`ignored ${key} `));
    assert.equal(fs.existsSync(`${file}.bak`), false); // the file is valid JSON: it is not moved away
  });

  test('a settings.json that an editor saved with a byte order mark still loads', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ thrift: 0.9, safety: 'trusting' })}\n`);
    const s = createSettings({ configDir, log }).get();
    assert.deepEqual([s.thrift, s.safety], [0.9, 'trusting']);
    assert.equal(fs.existsSync(`${file}.bak`), false);
    assert.deepEqual(logs, []);
  });

  test('defaultCrew always names a crew preset', () => {
    const settings = createSettings({ configDir, log });
    for (const name of ['nope', '', 'toString', '__proto__']) {
      assert.throws(() => settings.update({ defaultCrew: name }), (err) => err.status === 400 && /settings\.defaultCrew must name a crew preset/.test(err.message), name);
    }
    assert.equal(fs.existsSync(file), false);
    // A new preset and the switch to it may come in one patch.
    const out = settings.update({ crewPresets: { huge: { bosses: 2, managers: 2, makers: 8 } }, defaultCrew: 'huge' });
    assert.deepEqual(out.crewPresets[out.defaultCrew], { bosses: 2, managers: 2, makers: 8 });
    // The preset in use cannot be emptied. After a switch it can.
    assert.throws(() => settings.update({ crewPresets: { huge: null } }), (err) => err.status === 400);
    assert.equal(settings.get().defaultCrew, 'huge');
    assert.equal(settings.update({ defaultCrew: 'solo', crewPresets: { huge: null } }).crewPresets.huge, null);
    // A file that names a preset that does not exist: the default is used, with a warning.
    fs.writeFileSync(file, JSON.stringify({ defaultCrew: 'ghost', thrift: 0.5 }));
    logs = [];
    const s = createSettings({ configDir, log }).get();
    assert.deepEqual([s.defaultCrew, s.thrift], ['standard', 0.5]);
    assert.match(logs.map((l) => `${l.level}: ${l.msg}`).join('\n'), /warn: settings: ignored defaultCrew /);
  });

  test('authAck.<lab> and selfTest.<lab> hold one record: a new record replaces the old one', () => {
    const settings = createSettings({ configDir, log });
    // core and advisory are lists of { name, ok, detail } (contract section 10, providers.selfTest).
    const check = (name, ok) => ({ name, ok, detail: '' });
    settings.update({ selfTest: { claude: { version: '2.1.289', ok: true, core: [check('mcp', true), check('sandbox', true)], advisory: [check('hook', false)], ts: 1 } } });
    const out = settings.update({ selfTest: { claude: { version: '2.2.0', ok: false, core: [check('mcp', false)], ts: 2 } } });
    assert.deepEqual(out.selfTest, { claude: { version: '2.2.0', ok: false, core: [check('mcp', false)], ts: 2 }, gemini: null }); // no stale sandbox check, no stale advisory
    settings.update({ auth: { gemini: 'apikey' }, authAck: { gemini: { mode: 'apikey', ts: 5, seen: 'note v1' } } });
    assert.deepEqual(settings.update({ authAck: { gemini: { mode: 'apikey', ts: 6 } } }).authAck.gemini, { mode: 'apikey', ts: 6 });
    assert.deepEqual(createSettings({ configDir, log }).get().authAck, { claude: null, gemini: { mode: 'apikey', ts: 6 } });
    assert.equal(settings.update({ authAck: { gemini: null }, selfTest: { claude: null } }).authAck.gemini, null);
    assert.deepEqual(createSettings({ configDir, log }).get().selfTest, { claude: null, gemini: null });
    // A key without a default still merges deep (the providers module keeps its own notes that way).
    settings.update({ providers: { gemini: { models: ['a'], authOk: true } } });
    assert.deepEqual(settings.update({ providers: { gemini: { authOk: false } } }).providers, { gemini: { models: ['a'], authOk: false } });
  });

  // Contract 14b "Auth choice on record": "There is no migration rule". The alignment note asked for a one-time
  // migration (item 17); the contract wins, so the migration that was here is gone.
  test('no migration: a file with an auth mode and no authAck loads with authAck null and is never written', () => {
    fs.mkdirSync(configDir, { recursive: true });
    for (const saved of [{ auth: { claude: 'apikey', gemini: 'apikey' } }, { auth: { gemini: 'apikey' }, thrift: 0.5 }]) {
      const text = `${JSON.stringify(saved, null, 2)}\n`;
      fs.writeFileSync(file, text);
      logs = [];
      const s = createSettings({ configDir, log }).get();
      assert.deepEqual(s.authAck, { claude: null, gemini: null }, text);
      assert.deepEqual(s.auth, { ...DEFAULT_SETTINGS.auth, ...saved.auth });
      assert.equal(fs.readFileSync(file, 'utf8'), text); // load() never writes
      assert.deepEqual(logs, []);
    }
    // A file that has its acks keeps them as they are (Phase 0: apikey only).
    const ack = { mode: 'apikey', ts: 1794700800000 };
    fs.writeFileSync(file, JSON.stringify({ auth: { claude: 'apikey' }, authAck: { claude: ack } }));
    assert.deepEqual(createSettings({ configDir, log }).get().authAck, { claude: ack, gemini: null });
    // A fresh install: no file, no ack, nothing written.
    fs.rmSync(file);
    assert.deepEqual(createSettings({ configDir, log }).get().authAck, { claude: null, gemini: null });
    assert.equal(fs.existsSync(file), false);
  });

  test('authAck.<lab> is null or { mode, ts }; selfTest.<lab> is null or { version, ok, ts } (A12, A08)', () => {
    const settings = createSettings({ configDir, log });
    const bad = [
      { authAck: { claude: 'subscription' } }, { authAck: { claude: true } }, { authAck: { claude: [] } }, { authAck: { claude: {} } },
      { authAck: { claude: { mode: 'oauth', ts: 1 } } }, { authAck: { claude: { mode: 'apikey' } } }, { authAck: { claude: { mode: 'apikey', ts: '1' } } },
      { authAck: { gemini: { mode: 'apikey', ts: -1 } } }, { authAck: { openai: { ts: 1 } } }, { authAck: 'yes' },
      { selfTest: { claude: true } }, { selfTest: { claude: {} } }, { selfTest: { claude: { version: '1', ok: 'yes', ts: 1 } } },
      { selfTest: { claude: { version: 2, ok: true, ts: 1 } } }, { selfTest: { claude: { version: '1', ok: true } } },
      { selfTest: { gemini: { version: '1', ok: true, ts: 1, core: 'all' } } }, { selfTest: { gemini: { version: '1', ok: true, ts: 1, core: { mcp: true } } } },
      { selfTest: { gemini: { version: '1', ok: true, ts: 1, advisory: ['x'] } } },
    ];
    for (const patch of bad) {
      assert.throws(() => settings.update(patch), (err) => err.status === 400 && /settings\.(authAck|selfTest)/.test(err.message), JSON.stringify(patch));
    }
    assert.equal(fs.existsSync(file), false);
    const ack = { mode: 'apikey', ts: 1794700800000 };
    const run = { version: '2.1.0', ok: true, core: [{ name: 'mcp', ok: true, detail: '' }], advisory: [{ name: 'hook', ok: false, detail: '' }], ts: 5 };
    const out = settings.update({ authAck: { claude: ack }, selfTest: { gemini: run } });
    assert.deepEqual([out.authAck, out.selfTest], [{ claude: ack, gemini: null }, { claude: null, gemini: run }]);
    // A bad value in the file is ignored with a warning; the good one stays.
    fs.writeFileSync(file, JSON.stringify({ authAck: { claude: { mode: 'x', ts: 1 }, gemini: ack }, selfTest: { claude: { ok: true } } }));
    logs = [];
    const s = createSettings({ configDir, log }).get();
    assert.deepEqual([s.authAck, s.selfTest], [{ claude: null, gemini: ack }, { claude: null, gemini: null }]);
    assert.match(logs.map((l) => l.msg).join('\n'), /ignored authAck\.claude [\s\S]*ignored selfTest\.claude /);
  });
});

describe('store: items without a JSON form', () => {
  test('put() and patch() refuse such an item; the state and the file stay whole', async () => {
    const store = open({ saveDelayMs: 60000 });
    const task = store.put('tasks', { id: 'T1', n: 1 });
    const stamp = task.updatedAt;
    const seen = [];
    store.subscribe((event) => seen.push(event.type));
    const loop = { id: 'T2' };
    loop.self = loop;
    assert.throws(() => store.put('tasks', loop), TypeError);
    assert.throws(() => store.put('tasks', { id: 'T3', big: 10n }), TypeError);
    assert.equal(store.get('tasks', 'T2'), null);
    assert.equal(store.get('tasks', 'T3'), null);
    // A refused patch leaves nothing on the live item.
    assert.throws(() => store.patch('tasks', 'T1', { n: 2, extra: 'x', me: task }), TypeError); // the item would hold itself
    assert.deepEqual({ n: task.n, extra: 'extra' in task, me: 'me' in task, updatedAt: task.updatedAt }, { n: 1, extra: false, me: false, updatedAt: stamp });
    assert.deepEqual(seen, []); // no event for a refused change
    assert.equal(store.state.seq, 1);
    // The store still saves. Before the fix the bad item stayed in the state and every later save failed.
    store.put('tasks', { id: 'T4' });
    await store.flush();
    assert.deepEqual(Object.keys(readState().tasks), ['T1', 'T4']);
    assert.equal(store.stats().dirty, false);
    assert.deepEqual(errors(), []);
  });

  test('a live item that a module made circular behind the back of the store does not stop the saves', async () => {
    const store = open({ saveDelayMs: 60000 });
    const task = store.put('tasks', { id: 'T1', title: 'ok' });
    const agent = store.put('agents', { id: 'A1', name: 'Sprocket' });
    task.owner = agent; // a module links two live items without put(): the state has no JSON form any more
    agent.task = task;
    store.put('tasks', { id: 'T2', title: 'later work' });
    await store.flush();
    assert.equal(store.stats().dirty, false);
    const saved = readState();
    assert.deepEqual(Object.keys(saved.tasks), ['T1', 'T2']);
    assert.deepEqual([saved.tasks.T1.title, saved.tasks.T1.owner.id, saved.agents.A1.name, saved.agents.A1.task.id], ['ok', 'A1', 'Sprocket', 'T1']);
    const report = errors().find((l) => /no JSON form/.test(l.msg));
    assert.ok(report, 'the bad items are reported');
    assert.deepEqual(report.data.items, ['tasks.T1', 'agents.A1']);
    // The API refuses to touch the bad item again, so the module that made it hears about it.
    assert.throws(() => store.patch('tasks', 'T1', { status: 'working' }), TypeError);
    assert.equal('status' in task, false);
    // A restart loads the saved state.
    logs = [];
    const again = open();
    assert.equal(again.get('tasks', 'T2').title, 'later work');
    assert.deepEqual(logs, []);
  });
});

describe('store: a state.json that the loader would reject is never written', () => {
  test('put() refuses an item whose JSON form does not hold its id', () => {
    const store = open();
    class Task {
      constructor(title) {
        this.title = title;
      }

      get id() { // not in the JSON form: the saved item would have no id
        return 'T1';
      }
    }
    assert.throws(() => store.put('tasks', new Task('getter id')), TypeError);
    assert.throws(() => store.put('tasks', { id: 'T2', toJSON: () => ({ id: 'T99' }) }), TypeError);
    assert.throws(() => store.put('tasks', Object.defineProperty({ title: 'hidden id' }, 'id', { value: 'T3', enumerable: false })), TypeError);
    assert.deepEqual(store.list('tasks'), []);
    assert.equal(store.state.seq, 0);
    class Plain {
      constructor(id) {
        this.id = id;
      }
    }
    assert.equal(store.put('tasks', new Plain('T4')).id, 'T4'); // an own id is enough
  });

  test('a module that changes the id of a live item cannot make the next restart lose the whole state', async () => {
    const store = open({ saveDelayMs: 60000 });
    store.put('jobs', { id: 'J1', title: 'three days of work' });
    const task = store.put('tasks', { id: 'T5', title: 'first' });
    Object.assign(task, { id: 'T9', title: 'changed by a careless handler' }); // for example Object.assign(item, body)
    store.state.agents.A7 = 'not an item'; // and a direct write into a collection
    await store.flush();
    const report = errors().find((l) => /does not match its id/.test(l.msg));
    assert.deepEqual(report?.data.items, ['tasks.T5', 'agents.A7']);
    logs = [];
    const again = open(); // before the fix: "state.json is corrupt, starting clean", and J1 was gone
    assert.deepEqual(logs, []);
    assert.equal(again.get('jobs', 'J1').title, 'three days of work');
    assert.deepEqual(again.get('tasks', 'T5'), { ...again.get('tasks', 'T5'), id: 'T5', title: 'changed by a careless handler' }); // the key is the identity
    assert.equal(again.get('agents', 'A7'), null);
    assert.equal(fs.existsSync(`${stateFile()}.bak`), false);
  });
});

describe('store: ids across a crash', () => {
  test('an id is never handed out twice, also when the hub dies before the save', async () => {
    const first = open({ saveDelayMs: 60000 });
    first.put('jobs', { id: first.nextId('J') });
    await first.flush();
    // These ids are used at once for a git branch, a bench folder and a log file. Then the hub dies.
    assert.deepEqual([first.nextId('J'), first.nextId('T'), first.nextId('R')], ['J2', 'T1', 'R1']);
    const second = open({ saveDelayMs: 60000 }); // the restart: state.json knows J1 only
    assert.deepEqual([second.nextId('J'), second.nextId('T'), second.nextId('R'), second.nextId('A')], ['J3', 'T2', 'R2', 'A1']);
    assert.deepEqual(logs, []);
  });

  test('a hub that is killed right after nextId() does not reuse the id', async () => {
    const out = path.join(tmp, 'handed-out.txt');
    const result = await runNode('crash.mjs', `
      import fs from 'node:fs';
      import { createStore } from ${JSON.stringify(storeUrl)};
      const [dataDir, outFile] = process.argv.slice(2);
      const store = createStore({ dataDir });
      store.put('tasks', { id: store.nextId('T'), title: 'saved' });
      await store.flush();
      const ids = [store.nextId('T'), store.nextId('J'), store.nextId('A')];
      store.put('tasks', { id: ids[0], title: 'lost with the crash' });
      fs.writeFileSync(outFile, ids.join(' '));
      process.kill(process.pid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 10000));
    `, [dir, out]);
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), 'T2 J1 A1');
    const store = open();
    assert.equal(store.get('tasks', 'T1').title, 'saved');
    assert.equal(store.get('tasks', 'T2'), null); // the last 250 ms are lost: that is the contract
    assert.deepEqual([store.nextId('T'), store.nextId('J'), store.nextId('A')], ['T3', 'J2', 'A2']); // but T2, J1 and A1 never come back
  });

  test('a clean start after a corrupt state.json does not reuse the ids of the lost state', async () => {
    const first = open();
    for (let i = 0; i < 3; i += 1) first.put('jobs', { id: first.nextId('J') });
    first.put('agents', { id: first.nextId('A') });
    first.put('agents', { id: first.nextId('A') });
    await first.flush();
    fs.writeFileSync(stateFile(), '{"v":1,"jobs":{"J1":'); // the file is damaged
    const second = open();
    assert.deepEqual(second.list('jobs'), []);
    assert.ok(fs.existsSync(`${stateFile()}.bak`));
    assert.deepEqual(logs.map((l) => `${l.level}: ${/corrupt/.test(l.msg)}`), ['warn: true']);
    // board.jsonl, logs/ and work/ still hold J1..J3 and A1..A2 of the lost state.
    assert.deepEqual([second.nextId('J'), second.nextId('A'), second.nextId('T')], ['J4', 'A3', 'T1']);
  });

  test('a damaged ids.json is ignored with a warning; bad entries in it are skipped', async () => {
    const first = open();
    first.put('tasks', { id: first.nextId('T') });
    await first.flush();
    fs.writeFileSync(path.join(dir, 'ids.json'), '{"T": 7, "J": 3'); // cut off
    const second = open();
    assert.equal(logs.filter((l) => l.level === 'warn' && /ids\.json/.test(l.msg)).length, 1);
    assert.equal(second.nextId('T'), 'T2');
    await second.flush();
    fs.writeFileSync(path.join(dir, 'ids.json'), JSON.stringify({ T: 7, J: 'x', 'bad key': 3, A: -1, R: 2.5, D: 4, __proto__: 9 }));
    logs = [];
    const third = open();
    assert.deepEqual([third.nextId('T'), third.nextId('D'), third.nextId('J'), third.nextId('A'), third.nextId('R')], ['T8', 'D5', 'J1', 'A1', 'R1']);
    assert.deepEqual(logs, []);
  });

  test('an ids.json that cannot be read or written is reported, not once per id; ids still count', async () => {
    fs.mkdirSync(path.join(dir, 'ids.json')); // a folder is in the way
    const store = open();
    const ids = Array.from({ length: 50 }, () => store.nextId('T'));
    assert.deepEqual([ids[0], ids.at(-1)], ['T1', 'T50']);
    const lines = logs.filter((l) => /ids\.json/.test(l.msg));
    assert.ok(lines.length >= 1 && lines.length <= 2, `${lines.length} log lines for one broken file`);
    await store.flush();
    assert.equal(readState().counters.T, 50);
  });
});

describe('store: logging under failure', () => {
  test('an events.jsonl that cannot be written does not flood the log', async () => {
    fs.mkdirSync(path.join(dir, 'events.jsonl')); // a folder is in the way: every append fails
    const store = open();
    for (let i = 0; i < 300; i += 1) {
      store.emit('notice', { level: 'info', text: `note ${i}`, jobId: null });
      if (i % 10 === 9) await sleep(1);
    }
    store.put('tasks', { id: 'T1' });
    await store.flush();
    const lines = logs.filter((l) => /events\.jsonl/.test(l.msg));
    assert.ok(lines.length >= 1, 'the failure is reported');
    assert.ok(lines.length <= 2, `${lines.length} log lines for one broken file`);
    assert.equal(lines[0].level, 'error');
    assert.deepEqual(Object.keys(readState().tasks), ['T1']); // the state is saved all the same
    // When the file works again the store says how much the audit log lost.
    fs.rmdirSync(path.join(dir, 'events.jsonl'));
    store.emit('notice', { level: 'info', text: 'back', jobId: null });
    await store.flush();
    assert.deepEqual(readEvents().map((event) => event.text), ['back']);
    assert.equal(logs.find((l) => /works again/.test(l.msg))?.data.lost, 301);
  });

  test('an event storm does not block the event loop or flood the log', async () => {
    const store = open({ saveDelayMs: 60000 });
    let storm = true;
    let delivered = 0;
    store.subscribe(() => {
      delivered += 1;
      if (storm) store.emit('echo', {}, { persist: false }); // a subscriber that answers every event with an event
    });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    store.emit('echo', {}, { persist: false });
    await sleep(200);
    storm = false;
    clearInterval(timer);
    await sleep(10);
    // The storm never ends by itself, so a bus that did not yield would have hung this test in sleep().
    assert.ok(delivered >= 20000, `${delivered} events`);
    assert.ok(ticks >= 1, `timers ran ${ticks} times during the storm`);
    const warned = logs.filter((l) => /storm/.test(l.msg));
    assert.ok(warned.length >= 1 && warned.length <= 2, `${warned.length} storm warnings`);
    assert.equal(store.stats().buffered, 5000); // the ring stays bounded
    assert.equal(store.eventsSince(store.state.seq - 3).length, 3);
  });
});

describe('store: small contract points', () => {
  test('put() keeps createdAt when an item is replaced by a new object', async () => {
    const store = open();
    const first = store.put('agents', { id: 'A1', name: 'old' });
    await sleep(3);
    const second = store.put('agents', { id: 'A1', name: 'new' });
    assert.notEqual(second, first);
    assert.equal(second.createdAt, first.createdAt);
    assert.ok(second.updatedAt > first.createdAt);
    assert.equal(store.put('agents', { id: 'A1', createdAt: 5 }).createdAt, 5); // an explicit value wins
  });

  test('emit() takes null options and a payload that is not an object', async () => {
    const store = open();
    assert.equal(store.emit('ping', { a: 1 }, null).seq, 1);
    assert.deepEqual(Object.keys(store.emit('ping', null, undefined)), ['type', 'seq', 'ts']);
    assert.deepEqual(Object.keys(store.emit('ping', 'text', {})), ['type', 'seq', 'ts']);
    store.emit('quiet', {}, { persist: false });
    await store.flush();
    assert.deepEqual(readEvents().map((event) => event.seq), [1, 2, 3]);
  });
});

describe('store: files are private (design review A32)', () => {
  const mode = (target) => fs.statSync(target).mode & 0o777;

  test('a new data dir has mode 0700 and every file of the store 0600', async () => {
    dir = path.join(tmp, 'fresh', 'data');
    const store = open({ eventsMaxBytes: 400 });
    store.put('tasks', { id: store.nextId('T'), title: 'private work' });
    for (let i = 0; i < 12; i += 1) store.emit('notice', { level: 'info', text: 'x'.repeat(40), jobId: null }); // passes the limit: rotates
    await store.flush();
    store.emit('notice', { level: 'info', text: 'after the rotation', jobId: null });
    await store.flush();
    assert.equal(mode(dir), 0o700);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['events.1.jsonl', 'events.jsonl', 'ids.json', 'state.json']);
    for (const name of files) assert.equal(mode(path.join(dir, name)) & 0o077, 0, `${name} can be read by other users`);
  });

  test('files that an older run left readable for all become private', async () => {
    for (const [name, text] of [['state.json', '{"tasks":{"T1":{"id":"T1"}}}'], ['events.jsonl', '{"type":"old","seq":1,"ts":1}\n'], ['ids.json', '{"T":1}']]) {
      fs.writeFileSync(path.join(dir, name), text, { mode: 0o644 });
      fs.chmodSync(path.join(dir, name), 0o644);
    }
    const store = open();
    assert.equal(store.get('tasks', 'T1').id, 'T1');
    store.emit('notice', { level: 'info', text: 'new line', jobId: null });
    await store.flush();
    for (const name of ['state.json', 'events.jsonl', 'ids.json']) assert.equal(mode(path.join(dir, name)), 0o600, name);
    assert.deepEqual(readEvents().map((event) => event.type), ['old', 'notice']); // the old lines are kept
  });
});

describe('store: crash and re-entrancy', () => {
  test('SIGKILL in the middle of the saves: state.json is always one whole snapshot', async () => {
    // A hub that saves all the time: 100 tasks per round, a new round every few ms.
    const script = path.join(tmp, 'writer.mjs');
    fs.writeFileSync(script, `
      import { createStore } from ${JSON.stringify(storeUrl)};
      const [dataDir, run] = process.argv.slice(2);
      const store = createStore({ dataDir, saveDelayMs: 0, eventsMaxBytes: 512 * 1024 });
      const filler = 'x'.repeat(2000);
      for (let round = 1; ; round += 1) {
        for (let i = 0; i < 100; i += 1) store.put('tasks', { id: 'T' + i, run: Number(run), round, filler });
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
    `);
    for (const run of [1, 2, 3]) {
      const ended = new Promise((resolve) => {
        const child = execFile(process.execPath, [script, dir, String(run)], { timeout: 30000, killSignal: 'SIGKILL' }, (err) => resolve(err?.signal ?? null));
        (async () => {
          // Wait until this run has saved at least once, then kill it at some point between two saves or in one.
          const end = Date.now() + 25000;
          while (Date.now() < end) {
            const saved = fs.existsSync(stateFile()) ? readState() : null; // throws on a half-written file
            if (saved?.tasks.T0?.run === run) break;
            await sleep(5);
          }
          await sleep(10 + run * 17);
          child.kill('SIGKILL');
        })().catch(() => child.kill('SIGKILL'));
      });
      assert.equal(await ended, 'SIGKILL');
      const saved = readState();
      const tasks = Object.values(saved.tasks);
      assert.equal(tasks.length, 100);
      assert.deepEqual([...new Set(tasks.map((task) => task.run))], [run], 'the snapshot is from this run');
      assert.equal(new Set(tasks.map((task) => task.round)).size, 1, 'one snapshot holds the tasks of one round');
    }
    const store = open(); // the restart after the last crash
    assert.equal(store.list('tasks').length, 100);
    assert.deepEqual(logs, []); // not corrupt, no .bak
    assert.equal(fs.existsSync(`${stateFile()}.bak`), false);
  });

  test('a subscriber may remove the item it hears about; every subscriber sees the same order', () => {
    const store = open();
    const first = [];
    const second = [];
    const late = [];
    store.subscribe((event) => {
      first.push(`${event.seq}:${event.type}`);
      if (event.type === 'upsert' && event.item.temp) {
        store.remove(event.kind, event.item.id);
        store.subscribe((later) => late.push(`${later.seq}:${later.type}`)); // joins during a delivery
      }
    });
    store.subscribe((event) => second.push(`${event.seq}:${event.type}`));
    store.put('agents', { id: 'A1', temp: true });
    assert.deepEqual(first, ['1:upsert', '2:remove']);
    assert.deepEqual(second, first);
    assert.deepEqual(late, ['2:remove']); // a new subscriber starts with the next event
    assert.equal(store.get('agents', 'A1'), null);
    assert.deepEqual(store.eventsSince(0).map((event) => event.type), ['upsert', 'remove']);
  });
});

describe('http: adversarial', () => {
  test('a JSON body cannot carry __proto__ or constructor.prototype to a handler', async () => {
    let seen = null;
    const { port } = await start({}, (app) => app.route('POST', '/api/merge', ({ body }) => {
      seen = body;
      const merged = Object.assign({}, body); // what a careless handler does with a body
      return { polluted: merged.polluted ?? null, keys: Object.keys(body) };
    }));
    const bodies = [
      '{"__proto__":{"polluted":"yes"},"title":"x"}',
      '{"\\u005f_proto__":{"polluted":"yes"},"title":"x"}', // the same key, written with an escape
      '{"title":"x","constructor":{"prototype":{"polluted":"yes"}}}',
    ];
    for (const text of bodies) {
      const res = await call(port, 'POST', '/api/merge', text);
      assert.deepEqual([res.status, res.json()], [200, { polluted: null, keys: ['title'] }], text);
    }
    const deep = await call(port, 'POST', '/api/merge', '{"a":{"b":[{"__proto__":{"polluted":"yes"},"keep":1}]},"constructor":"a plain word"}');
    assert.deepEqual(deep.json().keys, ['a', 'constructor']); // a harmless key with that name stays
    assert.deepEqual(seen.a.b[0], { keep: 1 });
    assert.equal(Object.hasOwn(seen.a.b[0], '__proto__'), false);
    assert.equal({}.polluted, undefined);
  });

  test('a refused request with huge headers gives a short log line', async () => {
    const { port } = await start({}, (app) => app.route('GET', '/api/state', () => ({})));
    const res = await request(port, { path: '/api/state', headers: { host: `evil.example.${'a'.repeat(6000)}`, origin: `http://${'b'.repeat(6000)}` } });
    assert.equal(res.status, 403);
    const line = logs.find((l) => l.level === 'warn' && /refused/.test(l.msg));
    assert.ok(line, 'the refusal is logged');
    assert.ok(JSON.stringify(line).length < 1000, `${JSON.stringify(line).length} chars in one log line`);
    assert.match(line.data.host, /^evil\.example\./);
  });

  test('an error message that quotes a large body value does not land in the log in full', async () => {
    const { port } = await start({}, (app) => app.route('POST', '/api/crew', ({ body }) => {
      throw Object.assign(new Error(`Unknown crew preset "${body.crew}".`), { status: body.status });
    }));
    for (const status of [400, 403, 500]) {
      const res = await call(port, 'POST', '/api/crew', { crew: 'x'.repeat(100000), status });
      assert.equal(res.status, status);
      assert.ok(res.json().error.length > 100000); // the caller still gets the whole message
    }
    assert.deepEqual(logs.map((l) => l.level).sort(), ['debug', 'error', 'warn']);
    for (const line of logs) assert.ok(JSON.stringify(line).length < 6000, `${JSON.stringify(line).length} chars in one ${line.level} line`);
  });

  test('a very deep JSON body does not overflow the stack of the body parser', async () => {
    let depth = 0;
    const { port } = await start({}, (app) => {
      app.route('POST', '/api/deep', ({ body }) => {
        for (let node = body.d; Array.isArray(node); node = node[0]) depth += 1;
        return { ok: true };
      });
      app.route('POST', '/api/echo', ({ body }) => body);
    });
    const deep = `{"constructor":"x","d":${'['.repeat(200000)}${']'.repeat(200000)}}`; // the word starts the key check
    const res = await call(port, 'POST', '/api/deep', deep);
    assert.deepEqual([res.status, res.json(), depth], [200, { ok: true }, 200000]);
    // A handler that sends the deep value back gets a clean 500, and the server lives on.
    assert.equal((await call(port, 'POST', '/api/echo', deep)).status, 500);
    assert.deepEqual((await call(port, 'POST', '/api/echo', { still: 'alive' })).json(), { still: 'alive' });
  });

  test('a handler that fails after it answered does not cut its own answer', async () => {
    const big = 'x'.repeat(8 * 1024 * 1024);
    const { port } = await start({}, (app) => {
      app.route('GET', '/api/big', (ctx) => {
        ctx.text(200, big);
        throw new Error('failed after the answer');
      });
      app.route('GET', '/api/half', ({ res }) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('half');
        throw new Error('failed in the middle');
      });
    });
    const res = await request(port, { path: '/api/big' });
    assert.deepEqual([res.status, res.buffer.length], [200, big.length]);
    assert.ok(errors().some((l) => /failed after the answer/.test(l.data.error)));
    // An answer that is not finished is cut, so the client does not wait for the rest.
    await assert.rejects(request(port, { path: '/api/half' }));
    assert.ok(errors().some((l) => /failed in the middle/.test(l.data.error)));
  });

  test('every answer forbids framing with a CSP header (contract section 6)', async () => {
    const uiDir = path.join(tmp, 'ui');
    fs.mkdirSync(uiDir);
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>WorkShop</title>');
    const { port } = await start({ uiDir }, (app) => {
      app.route('GET', '/api/state', () => ({}));
      app.route('GET', '/api/boom', () => {
        throw new Error('kaboom');
      });
      app.sse('/api/events');
    });
    const answers = [
      await request(port, { path: '/' }),
      await request(port, { path: '/api/state' }),
      await request(port, { path: '/api/boom' }),
      await request(port, { path: '/api/nope' }),
      await request(port, { path: '/api/state', headers: { host: 'evil.example' } }),
      await request(port, { method: 'POST', path: '/api/state' }),
      await request(port, { method: 'HEAD', path: '/api/events' }),
    ];
    assert.deepEqual(answers.map((res) => res.status), [200, 200, 500, 404, 403, 403, 200]);
    for (const res of answers) {
      assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'");
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
  });

  test('listen() after close() is refused: a closed server never comes back and never leaks', async () => {
    const result = await runNode('relisten.mjs', `
      import { createHttp } from ${JSON.stringify(httpUrl)};
      const app = createHttp({ ownerKey: 'relisten-test-key' });
      await app.close();
      const outcome = await app.listen().then(() => 'LISTENING', (err) => 'REFUSED ' + err.message);
      process.stdout.write(outcome);
      await app.close();
    `, [], 15000);
    // Before the fix the server listened, close() could not stop it, and the process never ended.
    assert.match(result.stdout, /^REFUSED .*closed/);
    assert.deepEqual([result.timedOut, result.code], [false, 0], result.stderr);
  });

  test('a kept connection stays usable after every kind of error answer', async () => {
    let calls = 0;
    const { port } = await start({ bodyLimit: 1024 }, (app) => {
      app.route('GET', '/api/state', () => ({ ok: true }));
      app.route('POST', '/api/echo', ({ body }) => {
        calls += 1;
        return body;
      });
    });
    const host = `Host: 127.0.0.1:${port}\r\nCookie: ${cookies.get(port)}\r\n`;
    const post = (target, extra, body) => `POST ${target} HTTP/1.1\r\n${host}${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const answer = await rawExchange(port, [
      post('/api/echo', '', '{"a":1}'), // 403: no X-WorkShop
      post('/api/echo', 'X-WorkShop: 1\r\n', '{"a":'), // 400: bad JSON
      post('/api/echo', 'X-WorkShop: 1\r\n', JSON.stringify({ text: 'x'.repeat(2000) })), // 413: over the limit, body read and dropped
      post('/api/nope', 'X-WorkShop: 1\r\n', '{"a":1}'), // 404
      post('/api/state', 'X-WorkShop: 1\r\n', '{"a":1}'), // 405
      `GET /api/state HTTP/1.1\r\n${host}Content-Length: 5\r\n\r\nhello`, // a GET with a body that nobody reads
      post('/api/echo', 'X-WorkShop: 1\r\n', '{"a":2}'), // 200
      `GET /api/state HTTP/1.1\r\n${host}Connection: close\r\n\r\n`,
    ].join(''));
    assert.deepEqual(answer.match(/HTTP\/1\.1 \d+/g), ['403', '400', '413', '404', '405', '200', '200', '200'].map((status) => `HTTP/1.1 ${status}`));
    assert.equal(calls, 1);
    assert.match(answer, /\{"a":2\}/);
    assert.deepEqual(errors(), []);
  });
});

describe('http: owner session (contract section 6)', () => {
  /** A server with one route of each kind. No session is opened, so request() adds no cookie. */
  async function boot(opts = {}) {
    const app = createHttp({ log, ownerKey: OWNER_KEY, ...opts });
    servers.push(app);
    const hits = [];
    app.route('GET', '/api/state', () => {
      hits.push('state');
      return { ok: true };
    });
    app.route('POST', '/api/jobs', ({ body }) => {
      hits.push('jobs');
      return body;
    });
    app.route('GET', '/api/hello', () => ({ hello: true }), { open: true });
    app.route('POST', '/mcp/:token', ({ params }) => ({ agent: params.token }));
    app.route('GET', '/mcp/:token/tag', (ctx) => ctx.text(204, ''));
    const feed = app.sse('/api/events');
    const { port } = await app.listen();
    return { app, port, hits, feed };
  }

  /** Open the SSE stream, report the status and the first bytes, then hang up. */
  function stream(port, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers, agent: false }, (res) => {
        res.once('data', (chunk) => {
          resolve({ status: res.statusCode, type: res.headers['content-type'], first: chunk.toString('utf8') });
          req.destroy();
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('every /api route answers 401 without the owner cookie: GET, HEAD, POST, SSE, unknown paths', async () => {
    const { port, hits, feed } = await boot();
    const cases = [['GET', '/api/state'], ['HEAD', '/api/state'], ['POST', '/api/jobs'], ['GET', '/api/events'], ['GET', '/api/nope'],
      ['DELETE', '/api/state'], ['PUT', '/api/nope'], ['GET', '/api'], ['GET', '/%61pi/state'], ['GET', '/api/state/']];
    for (const [method, target] of cases) {
      const body = method === 'GET' || method === 'HEAD' ? undefined : '{"title":"x"}';
      const res = await request(port, { method, path: target, body, headers: { 'X-WorkShop': '1' } });
      assert.equal(res.status, 401, `${method} ${target}`);
      if (method !== 'HEAD') assert.deepEqual(res.json(), { error: 'owner session required' }, `${method} ${target}`);
      assert.equal(res.headers['set-cookie'], undefined);
    }
    assert.deepEqual(hits, []); // no handler ran
    assert.equal(feed.count(), 0); // no stream opened
    assert.ok(logs.some((l) => l.level === 'warn' && /GET \/api\/state refused/.test(l.msg)));
  });

  test('POST /api/session: the owner key gives the cookie; a wrong key gives 401 and no cookie', async () => {
    const { port } = await boot();
    const post = (body, headers = { 'X-WorkShop': '1' }) => request(port, { method: 'POST', path: '/api/session', body: JSON.stringify(body), headers });
    const wrong = [{}, { k: '' }, { k: 'nope' }, { k: `${OWNER_KEY}x` }, { k: OWNER_KEY.slice(1) }, { k: OWNER_KEY.toUpperCase() }, { k: 5 }, { k: null },
      { k: [OWNER_KEY] }, { k: { k: OWNER_KEY } }, { key: OWNER_KEY }, [OWNER_KEY]];
    for (const body of wrong) {
      const res = await post(body);
      assert.deepEqual([res.status, res.json(), res.headers['set-cookie']], [401, { error: 'wrong owner key' }, undefined], JSON.stringify(body));
    }
    assert.equal((await post({ k: OWNER_KEY }, {})).status, 403); // like every non-GET it needs X-WorkShop: 1
    const ok = await post({ k: OWNER_KEY });
    assert.deepEqual([ok.status, ok.json(), ok.headers['set-cookie'].length], [200, { ok: true }, 1]);
    const [setCookie] = ok.headers['set-cookie'];
    assert.match(setCookie, new RegExp(`^workshop_owner_${port}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`));
    assert.equal(setCookie.includes(OWNER_KEY), false); // the cookie holds a token of this run, not the key
    assert.equal((await post({ k: OWNER_KEY })).headers['set-cookie'][0], setCookie); // a second window gets the same session
    // Neither the key nor the cookie value reaches the log. A wrong key does.
    const text = JSON.stringify(logs);
    assert.equal(text.includes(OWNER_KEY) || text.includes(setCookie.split(/[=;]/)[1]), false);
    assert.ok(logs.some((l) => l.level === 'warn' && /POST \/api\/session refused/.test(l.msg) && l.data.error === 'wrong owner key'));
  });

  test('with the cookie the owner API works; a cookie of another hub or a made-up one does not', async () => {
    const { port, hits } = await boot();
    const cookie = await login(port);
    const owner = { 'X-WorkShop': '1', Cookie: cookie };
    assert.deepEqual((await request(port, { path: '/api/state', headers: owner })).json(), { ok: true });
    assert.deepEqual((await request(port, { method: 'POST', path: '/api/jobs', body: '{"a":1}', headers: owner })).json(), { a: 1 });
    assert.equal((await request(port, { method: 'HEAD', path: '/api/state', headers: owner })).status, 200);
    assert.equal((await request(port, { path: '/api/nope', headers: owner })).status, 404); // unknown /api route: 404 only for the owner
    assert.equal((await request(port, { method: 'DELETE', path: '/api/state', headers: owner })).status, 405);
    const live = await stream(port, { Cookie: cookie });
    assert.deepEqual([live.status, live.first.startsWith('retry: ')], [200, true]);
    assert.match(live.type, /^text\/event-stream/);
    // Other cookies in the header do not matter. A second cookie with our name and a bad value
    // (any local server can set one: cookies are per host, not per port) does not lock the owner out.
    const [name, value] = cookie.split('=');
    assert.equal((await request(port, { path: '/api/state', headers: { Cookie: `theme=dark; ${cookie}; other=1` } })).status, 200);
    assert.equal((await request(port, { path: '/api/state', headers: { Cookie: `${name}=made-up; ${cookie}` } })).status, 200);
    assert.deepEqual(hits, ['state', 'jobs', 'state', 'state', 'state']);
    const other = await boot(); // a second hub on this Mac with the same owner key
    const otherCookie = await login(other.port);
    const bad = [`${name}=`, `${name}=${value}x`, `${name}=${value.slice(1)}`, `${name}=${value.toLowerCase()}x`, `workshop_owner=${value}`, otherCookie,
      `${name}=${otherCookie.split('=')[1]}`, `${name}=${OWNER_KEY}`, `x${name}=${value}`];
    for (const header of bad) {
      assert.equal((await request(port, { path: '/api/state', headers: { Cookie: header } })).status, 401, header);
      assert.equal((await stream(port, { Cookie: header })).status, 401, header);
    }
    assert.equal(hits.length, 5);
  });

  test('an agent token opens nothing under /api; agent routes, open routes and static files need no cookie', async () => {
    const uiDir = path.join(tmp, 'ui');
    fs.mkdirSync(uiDir);
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>WorkShop</title>');
    const { port, hits } = await boot({ uiDir });
    const token = 'agent-token-0123456789';
    assert.deepEqual((await request(port, { method: 'POST', path: `/mcp/${token}`, body: '{}', headers: { 'X-WorkShop': '1' } })).json(), { agent: token });
    assert.equal((await request(port, { path: `/mcp/${token}/tag` })).status, 204);
    assert.equal((await request(port, { path: '/' })).status, 200);
    assert.deepEqual((await request(port, { path: '/api/hello' })).json(), { hello: true }); // registered with open: true
    const tries = [{ Authorization: `Bearer ${token}` }, { Cookie: `workshop_owner_${port}=${token}` }, { Cookie: `token=${token}` }, { 'X-Agent-Token': token }];
    for (const headers of tries) {
      assert.equal((await request(port, { path: '/api/state', headers })).status, 401, JSON.stringify(headers));
      assert.equal((await request(port, { method: 'POST', path: '/api/jobs', body: '{}', headers: { 'X-WorkShop': '1', ...headers } })).status, 401, JSON.stringify(headers));
    }
    assert.equal((await request(port, { path: `/api/state?token=${token}&k=${token}` })).status, 401);
    assert.equal((await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: token }), headers: { 'X-WorkShop': '1' } })).status, 401);
    assert.deepEqual(hits, []);
  });

  test('the owner check comes after the request guards and before the body is read', async () => {
    const { port, hits } = await boot();
    const cookie = await login(port);
    // A good cookie does not help a request that the guards refuse.
    assert.equal((await request(port, { path: '/api/state', headers: { Cookie: cookie, host: 'evil.example' } })).status, 403);
    assert.equal((await request(port, { path: '/api/state', headers: { Cookie: cookie, origin: 'http://evil.example' } })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: '/api/jobs', body: '{}', headers: { Cookie: cookie } })).status, 403);
    // Without the cookie a large upload is refused at once: the body is never read.
    const early = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/jobs', agent: false, headers: { 'X-WorkShop': '1', 'Content-Length': 500 * 1024 * 1024 } }, (res) => {
        res.resume();
        resolve(res.statusCode);
        req.destroy();
      });
      req.on('error', reject);
      req.write('{"brief":"');
    });
    assert.equal(early, 401);
    assert.deepEqual(hits, []);
  });

  // Contract 14b (review A01): ownerKey is required. Before, a hub without one started and only warned.
  test('createHttp refuses to start without an ownerKey; POST /api/session belongs to http.js', async () => {
    for (const ownerKey of [undefined, '', null, 12345, ['k'], { k: 'k' }]) {
      assert.throws(() => createHttp({ log, ownerKey }), (err) => err instanceof TypeError && /needs ownerKey/.test(err.message), String(ownerKey));
    }
    assert.throws(() => createHttp(), /needs ownerKey/);
    assert.throws(() => createHttp({}), /needs ownerKey/);
    const { app, port } = await boot();
    for (const k of [undefined, '', 'undefined', 'null', '12345', 12345, null]) {
      const res = await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k }), headers: { 'X-WorkShop': '1' } });
      assert.deepEqual([res.status, res.headers['set-cookie']], [401, undefined], String(k));
    }
    assert.throws(() => app.route('POST', '/api/session', () => ({})), /already defined/);
  });

  test('the session value lives in memory only: a new hub on the same port and key does not take the old cookie', async () => {
    const first = await boot();
    const cookie = await login(first.port);
    assert.equal((await request(first.port, { path: '/api/state', headers: { Cookie: cookie } })).status, 200);
    await first.app.close();
    // Same port, same owner key, same cookie name: only the random session value differs.
    const second = await boot({ port: first.port });
    assert.equal(second.port, first.port);
    assert.equal((await request(second.port, { path: '/api/state', headers: { Cookie: cookie } })).status, 401);
    assert.equal((await stream(second.port, { Cookie: cookie })).status, 401);
    const fresh = await login(second.port);
    assert.notEqual(fresh, cookie);
    assert.equal((await request(second.port, { path: '/api/state', headers: { Cookie: fresh } })).status, 200);
    assert.deepEqual(fs.readdirSync(tmp).filter((name) => !['data', 'config'].includes(name)), []); // nothing written to disk
  });

  test('the owner key and the session value never reach the log, not even through a failing handler', async () => {
    const { app, port } = await boot();
    const cookie = await login(port);
    const value = cookie.split('=')[1];
    // Requests that log: refusals (401, 403), a 404, a 500 with a stack, and a body that quotes the key.
    await request(port, { method: 'POST', path: '/api/session', body: JSON.stringify({ k: `${OWNER_KEY}-wrong` }), headers: { 'X-WorkShop': '1' } });
    await new Promise((resolve) => setTimeout(resolve, 1100)); // the refusal log is limited to one line per second
    await request(port, { path: '/api/state', headers: { Cookie: `${cookie}x` } });
    await request(port, { path: '/api/nope', headers: { Cookie: cookie } });
    await request(port, { method: 'POST', path: '/api/jobs', body: `{"k":"${OWNER_KEY}"`, headers: { 'X-WorkShop': '1', Cookie: cookie } });
    app.route('GET', '/api/boom', () => {
      throw new Error('kaboom');
    });
    await request(port, { path: '/api/boom', headers: { Cookie: cookie } });
    assert.ok(logs.length >= 4, 'the requests above were logged');
    const text = JSON.stringify(logs);
    assert.equal(text.includes(value), false, 'the session value is not in the log');
    assert.equal(text.includes(OWNER_KEY), false, 'the owner key is not in the log');
    assert.equal(Object.keys(app).includes('ownerKey'), false); // the http object does not hand the key out
  });
});

describe('repo files of the core module', () => {
  test('package.json and .gitignore fit the contract', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.scripts, { start: 'node server/index.js', test: 'node --test tests/' });
    assert.equal(pkg.dependencies, undefined); // zero dependencies
    assert.equal(pkg.devDependencies, undefined);
    const ignored = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
    // Runtime state, project repos and the leftovers of a settings save do not belong in git.
    for (const entry of ['data/', 'projects/', 'node_modules/', 'config/settings.json', 'config/settings.json.bak']) assert.ok(ignored.includes(entry), entry);
    // config/ itself is not ignored so shipped registries (models.json, harnesses.json, roster.json) stay tracked.
    assert.equal(ignored.includes('config/'), false);
  });
});
