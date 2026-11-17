// createApp and the entry point (contract sections 3b, 6, 14b) on temp folders with the file secrets backend,
// the mock lab only, a fake orchestrator and a fake power assertion. No CLI runs, no dialog opens.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp, createLogger, parseArgs, acquireLock, READY_PREFIX, DEFAULT_PORT } from '../server/index.js';
import { createRedactor } from '../server/redact.js';

const INDEX = fileURLToPath(new URL('../server/index.js', import.meta.url));

/** A fake orchestrator with the contract section 12 methods. It records what it was given. */
function fakeFactory(rec = {}) {
  rec.ticks = 0; rec.recovered = 0; rec.shutdowns = 0;
  return (deps) => {
    rec.deps = deps;
    return {
      resolver: { presence: () => 'here' },
      recover: async () => { rec.recovered++; },
      tick: async () => { rec.ticks++; },
      shutdown: async () => { rec.shutdowns++; },
      inbox: () => [],
      createJob: async (o) => deps.store.put('jobs', { id: deps.store.nextId('J'), title: o.title, status: 'queued', requirements: [] }),
    };
  };
}

function fakePower() {
  const p = { holds: 0, releases: 0, on: false };
  p.hold = () => { if (!p.on) { p.on = true; p.holds++; } };
  p.release = () => { if (p.on) { p.on = false; p.releases++; } };
  return p;
}

async function tempDirs() {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-index-')));
  return { tmp, dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config'), projectsDir: path.join(tmp, 'projects') };
}

const ENV = (tmp) => ({ HOME: tmp, USER: 'tester', PATH: '/usr/bin:/bin', WORKSHOP_PATH: '/usr/bin:/bin', WORKSHOP_DISABLE_AGY: '1' });

function boot(dirs, extra = {}) {
  return createApp({
    ...dirs, secretsBackend: 'file', labs: ['mock'], env: ENV(dirs.tmp), stderr: null, tickMs: 0,
    createOrchestrator: fakeFactory(extra.rec), power: extra.power ?? fakePower(),
    pickFolder: async () => null, reveal: async () => {}, ...extra.opts,
  });
}

async function session(app) {
  const r = await fetch(`${app.url}/api/session`, { method: 'POST', headers: { 'x-workshop': '1', 'content-type': 'application/json' }, body: JSON.stringify({ k: app.ownerKey }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

async function grepTree(dir, needle) {
  const hits = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { const t = await fs.readFile(p, 'utf8').catch(() => ''); if (t.includes(needle)) hits.push(p); }
    }
  }
  await walk(dir);
  return hits;
}

describe('createApp', () => {
  test('boots, wires every module, serves the API and stops cleanly', async () => {
    const dirs = await tempDirs();
    const rec = {};
    const power = fakePower();
    const app = await boot(dirs, { rec, power });
    try {
      assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(app.ownerKey, /^[0-9a-f]{64}$/);
      for (const k of ['store', 'board', 'mcp', 'runner', 'router', 'git', 'providers', 'decider', 'prompts', 'getSettings', 'paths', 'log']) {
        assert.ok(rec.deps[k], `orchestrator got ${k}`);
      }
      assert.equal(typeof rec.deps.prompts.planPrompt, 'function');
      assert.equal(rec.deps.paths.data, dirs.dataDir);
      assert.equal(rec.recovered, 1, 'recover at boot');
      assert.equal(rec.ticks, 1, 'then the first tick');
      await app.beat();
      assert.equal(rec.ticks, 2, 'the heartbeat ticks');

      const lock = JSON.parse(await fs.readFile(path.join(dirs.dataDir, 'run', 'hub.lock'), 'utf8'));
      assert.deepEqual(lock, { pid: process.pid, port: app.port });

      const cookie = await session(app);
      const st = await fetch(`${app.url}/api/state`, { headers: { cookie } });
      assert.equal(st.status, 200);
      const body = await st.json();
      assert.deepEqual(body.providers.map((p) => [p.id, p.installed]), [['claude', false], ['gemini', false], ['oss', true], ['mock', true]]);
      assert.ok(body.models.registry.models.length > 0, 'the shipped registry loads');
      assert.equal((await fetch(`${app.url}/api/state`)).status, 401);
      const html = await fetch(`${app.url}/`);
      assert.equal(html.status, 200, 'the UI is served without a cookie');

      // The MCP route is mounted and the runner's URL getter points at it.
      app.store.put('agents', { id: 'A1', jobId: 'J1', handle: '@m1', role: 'maker', name: 'Test' });
      const token = app.mcp.tokenFor('A1');
      const m = await fetch(`${app.url}/mcp/${token}`, { method: 'POST', headers: { 'x-workshop': '1', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) });
      assert.equal(m.status, 200);
      app.mcp.revoke('A1');

      // The power assertion follows the live job.
      app.store.put('jobs', { id: 'J1', status: 'running', requirements: [] });
      assert.equal(power.on, true);
      app.store.patch('jobs', 'J1', { status: 'paused' });
      assert.equal(power.on, false);

      // Settings changes reach the UI as events.
      const seen = [];
      const off = app.store.subscribe((e) => seen.push(e.type));
      app.settings.update({ thrift: 0.4 });
      off();
      assert.ok(seen.includes('settings'));
    } finally {
      await app.close();
      await app.close();
    }
    assert.equal(rec.shutdowns, 1);
    await assert.rejects(fs.access(path.join(dirs.dataDir, 'run', 'hub.lock')), 'the lock is released');
    const logFile = path.join(dirs.dataDir, 'logs', 'hub.log');
    assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600);
    assert.match(await fs.readFile(logFile, 'utf8'), /hub ready/);
    assert.deepEqual(await grepTree(dirs.tmp, app.ownerKey), [], 'the owner key is in no file');
    await fs.rm(dirs.tmp, { recursive: true, force: true });
  });

  test('two hubs on one data folder: the second is refused; after close a new one starts', async () => {
    const dirs = await tempDirs();
    const a = await boot(dirs);
    try {
      await assert.rejects(boot(dirs), (e) => e.code === 'E_HUB_LOCKED' && /already runs on this data folder/.test(e.message));
      const r = await fetch(`${a.url}/api/health`);
      assert.equal(r.status, 401, 'the first hub still answers');
    } finally {
      await a.close();
    }
    const b = await boot(dirs);
    await b.close();
    await fs.rm(dirs.tmp, { recursive: true, force: true });
  });

  test('a lock of a dead pid is taken over', async () => {
    const dirs = await tempDirs();
    await fs.mkdir(path.join(dirs.dataDir, 'run'), { recursive: true });
    await fs.writeFile(path.join(dirs.dataDir, 'run', 'hub.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, port: 1 }));
    const app = await boot(dirs);
    assert.equal(JSON.parse(await fs.readFile(path.join(dirs.dataDir, 'run', 'hub.lock'), 'utf8')).pid, process.pid);
    await app.close();
    await fs.rm(dirs.tmp, { recursive: true, force: true });
  });

  test('a restart keeps state; seq jumps; keys survive in the file backend', async () => {
    const dirs = await tempDirs();
    const a = await boot(dirs);
    const cookie = await session(a);
    const res = await fetch(`${a.url}/api/demo`, { method: 'POST', headers: { cookie, 'x-workshop': '1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    const job = await res.json();
    await a.secrets.set('typesafe', 'tsk-kept-value-12345678');
    const seq = a.store.state.seq;
    await a.close();
    const b = await boot(dirs);
    try {
      assert.equal(b.store.get('jobs', job.id).title, 'Demo: Recipe Box web app');
      assert.ok(b.store.state.seq >= seq + 1000);
      assert.equal(b.decider.enabled(), true, 'the decider sees the stored key at boot');
      assert.equal(b.redactor.redact('x tsk-kept-value-12345678'), 'x [redacted]', 'the redactor is primed at boot');
      assert.notEqual(b.ownerKey, a.ownerKey, 'a new owner key per run');
    } finally {
      await b.close();
    }
    await fs.rm(dirs.tmp, { recursive: true, force: true });
  });

  test('a failed boot releases the lock', async () => {
    const dirs = await tempDirs();
    await assert.rejects(boot(dirs, { opts: { createOrchestrator: () => { throw new Error('no orchestrator'); } } }), /no orchestrator/);
    await assert.rejects(fs.access(path.join(dirs.dataDir, 'run', 'hub.lock')));
    const app = await boot(dirs);
    await app.close();
    await fs.rm(dirs.tmp, { recursive: true, force: true });
  });
});

describe('helpers', () => {
  test('the logger redacts and writes 0600', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-log-')));
    const redactor = createRedactor();
    redactor.add('very-secret-value-42');
    const lines = [];
    const log = createLogger({ logsDir: tmp, redactor, stderr: { write: (s) => lines.push(s) } });
    log('info', 'saw very-secret-value-42', { v: 'very-secret-value-42' });
    log('debug', 'hidden');
    await log.close();
    const text = await fs.readFile(path.join(tmp, 'hub.log'), 'utf8');
    assert.equal(text.includes('very-secret-value-42'), false);
    assert.match(text, /INFO saw \[redacted\]/);
    assert.equal(text.includes('hidden'), false);
    assert.equal(lines.length, 1);
    assert.equal((await fs.stat(path.join(tmp, 'hub.log'))).mode & 0o777, 0o600);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test('parseArgs', () => {
    assert.deepEqual(parseArgs(['--port', '4100', '--data=/tmp/d', '--launcher', '--secrets', 'file', '--labs', 'mock']),
      { port: 4100, data: '/tmp/d', config: null, projects: null, launcher: true, secrets: 'file', labs: ['mock'] });
    assert.equal(parseArgs([]).port, null, 'no --port: the entry point prefers DEFAULT_PORT');
    assert.equal(parseArgs(['--port', '0']).port, 0);
    assert.throws(() => parseArgs(['--port', 'x']), /--port/);
    assert.throws(() => parseArgs(['--what']), /unknown option/);
    assert.throws(() => parseArgs(['--labs', 'claude']), /mock/);
  });

  test('acquireLock refuses a second holder in the same process', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-lock-')));
    const l = acquireLock(tmp);
    assert.throws(() => acquireLock(tmp), (e) => e.code === 'E_HUB_LOCKED');
    l.release();
    acquireLock(tmp).release();
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ the entry point as a child process

/** A wrapper that runs main() with a fake orchestrator (the real one is another engineer's file). */
async function writeWrapper(tmp) {
  const file = path.join(tmp, 'hub-wrapper.mjs');
  await fs.writeFile(file, `
import { main } from ${JSON.stringify(pathToFileURL(INDEX).href)};
const fake = (deps) => ({ resolver: {}, recover: async () => {}, tick: async () => {}, shutdown: async () => {}, inbox: () => [] });
main(process.argv.slice(2), process.env, { createOrchestrator: fake, power: { hold() {}, release() {} }, pickFolder: async () => null, reveal: async () => {} });
`);
  return file;
}

function startHub(script, dirs, extraArgs = []) {
  const child = spawn(process.execPath, [script, '--port', '0', '--data', dirs.dataDir, '--config', dirs.configDir, '--projects', dirs.projectsDir, '--secrets', 'file', '--labs', 'mock', ...extraArgs], {
    env: ENV(dirs.tmp), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const onData = () => { const line = out.split('\n').find((l) => l.startsWith(READY_PREFIX)); if (line) { child.stdout.off('data', onData); resolve(line); } };
    child.stdout.on('data', onData);
    exited.then((e) => reject(new Error(`hub exited ${e.code}: ${err}`)));
  });
  ready.catch(() => {});
  return { child, ready, exited, out: () => out, err: () => err };
}

describe('entry point', () => {
  test('ready line, lock, a second hub exits, stdin end stops it, SIGTERM stops it', { timeout: 60000 }, async () => {
    const dirs = await tempDirs();
    const script = await writeWrapper(dirs.tmp);
    const a = startHub(script, dirs);
    try {
      const line = await a.ready;
      const m = /^WORKSHOP_READY (http:\/\/127\.0\.0\.1:(\d+))\/#k=([0-9a-f]{64})$/.exec(line);
      assert.ok(m, line);
      const lock = JSON.parse(await fs.readFile(path.join(dirs.dataDir, 'run', 'hub.lock'), 'utf8'));
      assert.deepEqual(lock, { pid: a.child.pid, port: Number(m[2]) });
      const s = await fetch(`${m[1]}/api/session`, { method: 'POST', headers: { 'x-workshop': '1', 'content-type': 'application/json' }, body: JSON.stringify({ k: m[3] }) });
      assert.equal(s.status, 200);

      const b = startHub(script, dirs);
      const bx = await b.exited;
      assert.equal(bx.code, 1);
      assert.match(b.err(), /already runs on this data folder/);

      a.child.stdin.end(); // the launcher is gone
      const ax = await a.exited;
      assert.equal(ax.code, 0, a.err());
      await assert.rejects(fs.access(path.join(dirs.dataDir, 'run', 'hub.lock')));
      const log = await fs.readFile(path.join(dirs.dataDir, 'logs', 'hub.log'), 'utf8');
      assert.match(log, /launcher gone/);
      assert.equal(log.includes(m[3]), false, 'the owner key is not in the log');
      assert.equal(a.err().includes(m[3]), false, 'nor on stderr');

      const c = startHub(script, dirs);
      await c.ready;
      c.child.kill('SIGTERM');
      assert.equal((await c.exited).code, 0);
    } finally {
      for (const h of [a]) if (h.child.exitCode === null) h.child.kill('SIGKILL');
    }
    await fs.rm(dirs.tmp, { recursive: true, force: true });
  });

  test('node server/index.js with the real orchestrator (when it exists)', { timeout: 60000 }, async (t) => {
    if (!fsSync.existsSync(path.join(path.dirname(INDEX), 'orchestrator.js'))) { t.skip('server/orchestrator.js is not written yet'); return; }
    const dirs = await tempDirs();
    const h = startHub(INDEX, dirs);
    try {
      assert.match(await h.ready, /^WORKSHOP_READY http:\/\/127\.0\.0\.1:\d+\/#k=[0-9a-f]{64}$/);
      h.child.kill('SIGINT');
      assert.equal((await h.exited).code, 0, h.err());
    } finally {
      if (h.child.exitCode === null) h.child.kill('SIGKILL');
    }
    await fs.rm(dirs.tmp, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ the launcher contract (macapp/): lock, port, stop

describe('hub.lock', () => {
  /** N processes call acquireLock on one folder at the same instant. Returns their answers: 'won' or 'locked'. */
  async function race(dir, n) {
    const script = path.join(dir, 'racer.mjs');
    await fs.writeFile(script, `
import { acquireLock } from ${JSON.stringify(pathToFileURL(INDEX).href)};
const go = Number(process.argv[2]);
while (Date.now() < go) { /* everyone starts at once */ }
let out = 'locked';
let lock = null;
try { lock = acquireLock(process.argv[3]); out = 'won'; } catch (err) { if (err.code !== 'E_HUB_LOCKED') out = 'error ' + err.message; }
process.stdout.write(out);
setTimeout(() => { lock?.release(); }, 1500);
`);
    const go = Date.now() + 1500;
    const runs = Array.from({ length: n }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, [script, String(go), path.join(dir, 'run')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('exit', () => resolve(out.trim()));
    }));
    return Promise.all(runs);
  }

  test('many hubs started at once: exactly one wins, also over a stale lock; launcher.lock is never touched', { timeout: 60000 }, async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-lockrace-')));
    const run = path.join(tmp, 'run');
    await fs.mkdir(run, { recursive: true });
    const launcherLock = path.join(run, 'launcher.lock');
    await fs.writeFile(launcherLock, '4242\n', { mode: 0o600 });
    const ino = (await fs.stat(launcherLock)).ino;
    try {
      for (let round = 0; round < 3; round++) {
        if (round > 0) await fs.writeFile(path.join(run, 'hub.lock'), JSON.stringify({ pid: 2 ** 22 + 777, port: 9 })); // a stale lock
        const answers = await race(tmp, 8);
        assert.deepEqual(answers.filter((a) => a === 'won').length, 1, `round ${round}: ${answers.join(', ')}`);
        assert.deepEqual(answers.filter((a) => a !== 'won' && a !== 'locked'), [], 'no error');
        assert.equal(await fs.readFile(launcherLock, 'utf8'), '4242\n');
        assert.equal((await fs.stat(launcherLock)).ino, ino);
      }
      const left = (await fs.readdir(run)).sort();
      assert.deepEqual(left, ['launcher.lock'], 'no temp file and no lock stays');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('a lock whose pid now belongs to another program (not node) is stale; a live node pid is not', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-lockpid-')));
    const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    try {
      await fs.writeFile(path.join(tmp, 'hub.lock'), JSON.stringify({ pid: sleeper.pid, port: 1 }));
      const l = acquireLock(tmp);
      assert.equal(JSON.parse(await fs.readFile(path.join(tmp, 'hub.lock'), 'utf8')).pid, process.pid);
      l.release();
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      try {
        await fs.writeFile(path.join(tmp, 'hub.lock'), JSON.stringify({ pid: other.pid, port: 5 }));
        assert.throws(() => acquireLock(tmp), (e) => e.code === 'E_HUB_LOCKED' && e.other.pid === other.pid && e.other.port === 5);
        assert.equal(JSON.parse(await fs.readFile(path.join(tmp, 'hub.lock'), 'utf8')).pid, other.pid, 'a refused hub leaves the lock alone');
      } finally {
        other.kill('SIGKILL');
      }
    } finally {
      sleeper.kill('SIGKILL');
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('the port and the stop', () => {
  const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

  test('portFallback: a busy port gives way to a free one; without it the boot fails and releases the lock', async () => {
    const dirs = await tempDirs();
    const p = await freePort();
    const a = await boot(dirs, { opts: { port: p, portFallback: true } });
    try {
      assert.equal(a.port, p, 'a free preferred port is taken');
    } finally {
      await a.close();
    }
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(p, '127.0.0.1', resolve));
    try {
      const b = await boot(dirs, { opts: { port: p, portFallback: true } });
      try {
        assert.notEqual(b.port, p);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(dirs.dataDir, 'run', 'hub.lock'), 'utf8')), { pid: process.pid, port: b.port });
        assert.match(b.url, new RegExp(`:${b.port}$`));
      } finally {
        await b.close();
      }
      await assert.rejects(boot(dirs, { opts: { port: p } }), (e) => e.code === 'EADDRINUSE');
      await assert.rejects(fs.access(path.join(dirs.dataDir, 'run', 'hub.lock')), 'the failed boot released the lock');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
      await fs.rm(dirs.tmp, { recursive: true, force: true });
    }
    assert.equal(DEFAULT_PORT, 47117);
  });

  test('pauseLive pauses the live job with a reason and an error, and leaves other jobs alone', async () => {
    const dirs = await tempDirs();
    const paused = [];
    const factory = (deps) => ({
      ...fakeFactory({})(deps),
      pauseJob: (id) => { paused.push(id); return deps.store.patch('jobs', id, { status: 'paused', prevStatus: deps.store.get('jobs', id).status, pauseReason: 'owner' }); },
    });
    const app = await boot(dirs, { opts: { createOrchestrator: factory } });
    try {
      for (const [id, status] of [['J1', 'running'], ['J2', 'queued'], ['J3', 'done'], ['J4', 'paused']]) app.store.put('jobs', { id, status, requirements: [] });
      assert.deepEqual(app.pauseLive('the WorkShop app quit'), ['J1']);
      assert.deepEqual(paused, ['J1']);
      const j = app.store.get('jobs', 'J1');
      assert.deepEqual([j.status, j.prevStatus, j.pauseReason], ['paused', 'running', 'owner']);
      assert.equal(j.error, 'The hub stopped (the WorkShop app quit). Resume the job to go on.');
      assert.deepEqual(['J2', 'J3', 'J4'].map((id) => app.store.get('jobs', id).status), ['queued', 'done', 'paused']);
      assert.deepEqual(app.pauseLive('again'), [], 'nothing live is left');
    } finally {
      await app.close();
      await fs.rm(dirs.tmp, { recursive: true, force: true });
    }
  });

  test('the entry point: stdin end pauses the live job and saves it before the exit', { timeout: 60000 }, async () => {
    const dirs = await tempDirs();
    const file = path.join(dirs.tmp, 'hub-pause.mjs');
    await fs.writeFile(file, `
import { main } from ${JSON.stringify(pathToFileURL(INDEX).href)};
const fake = (deps) => ({ resolver: {}, recover: async () => {}, tick: async () => {}, shutdown: async () => {}, inbox: () => [],
  pauseJob: (id) => deps.store.patch('jobs', id, { status: 'paused', prevStatus: deps.store.get('jobs', id).status, pauseReason: 'owner' }) });
const app = await main(process.argv.slice(2), process.env, { createOrchestrator: fake, power: { hold() {}, release() {} }, pickFolder: async () => null, reveal: async () => {} });
app.store.put('jobs', { id: 'J1', status: 'running', requirements: [] });
`);
    const h = startHub(file, dirs);
    try {
      await h.ready;
      const t0 = Date.now();
      h.child.stdin.end();
      assert.equal((await h.exited).code, 0, h.err());
      assert.ok(Date.now() - t0 < 5000);
      const state = JSON.parse(await fs.readFile(path.join(dirs.dataDir, 'state.json'), 'utf8'));
      assert.equal(state.jobs.J1.status, 'paused');
      assert.match(state.jobs.J1.error, /the WorkShop app quit/);
    } finally {
      if (h.child.exitCode === null) h.child.kill('SIGKILL');
      await fs.rm(dirs.tmp, { recursive: true, force: true });
    }
  });
});

describe('leftovers of a killed hub (runner.reapOrphans)', () => {
  test('an agent that is gone, with a child left in its process group that no scan saw: the child dies at the next boot', { timeout: 30000 }, async () => {
    const { createRunner } = await import('../server/runner.js');
    const { createStore } = await import('../server/store.js');
    const { createMcp } = await import('../server/mcp.js');
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-reap-')));
    const run = path.join(tmp, 'data', 'run');
    // The "agent": a shell that leads its own group, starts a child in that group and exits at once.
    const at = Date.now();
    const agent = spawn('/bin/sh', ['-c', 'sleep 6100.917 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    agent.stdout.on('data', (d) => { out += d; });
    await new Promise((resolve) => agent.on('exit', resolve));
    const child = Number(out.trim());
    const bystander = spawn('/bin/sleep', ['6101.917'], { stdio: 'ignore' }); // in the test's group: must survive
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      assert.ok(child > 1 && alive(child), 'the child of the agent lives on');
      await fs.mkdir(path.join(run, 'A9'), { recursive: true });
      await fs.writeFile(path.join(run, 'A9', 'turn.json'), JSON.stringify({ v: 1, hub: 2 ** 22 + 99, hubAt: at - 60000, agent: 'A9', pid: agent.pid, at, kin: [] }));
      await fs.writeFile(path.join(run, 'launcher.lock'), '1\n');
      const store = createStore({ dataDir: path.join(tmp, 'data') });
      const runner = createRunner({
        store, providers: { get: () => null }, mcp: createMcp({ store }), getSettings: () => ({ limits: {} }), getMcpUrl: () => null,
        paths: { server: path.join(tmp, 'server'), run, logs: path.join(tmp, 'data', 'logs'), config: path.join(tmp, 'config') },
      });
      assert.equal(await runner.reapOrphans(), 1);
      const end = Date.now() + 5000;
      while (alive(child) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(child), false, 'the member of the dead agent group is killed');
      assert.equal(alive(bystander.pid), true, 'a process in another group is not touched');
      assert.equal(fsSync.existsSync(path.join(run, 'A9', 'turn.json')), false, 'the record is gone');
      assert.equal(await fs.readFile(path.join(run, 'launcher.lock'), 'utf8'), '1\n', 'launcher.lock stays');
      await runner.shutdown();
      await store.flush();
    } finally {
      for (const p of [child, bystander.pid]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
