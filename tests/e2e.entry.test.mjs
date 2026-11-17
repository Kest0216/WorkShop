// End to end through the real entry point (contract sections 3b, 4, 6; section 15; the launcher contract in
// macapp/): `node server/index.js` as a child process on temp folders (file secrets, the mock lab only), the ready
// line, the owner session, GET /api/state, a demo job to done over HTTP, and every "the hub must" of the launcher:
// a fast stop on stdin end-of-file with agents mid-turn, the pause call the launcher makes at quit, leftovers of a
// killed hub, the preferred port, the folders of a start with no arguments, and the WORKSHOP_STUB_* hooks.
// No real AI CLI runs (--labs mock).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { INDEX, ROOT, apiClient, hubEnv, leftovers, ownerSession, sleep, tempShop, writeSettings } from './e2e-harness.mjs';
import { DEFAULT_PORT } from '../server/index.js';

const READY_RE = /^WORKSHOP_READY (http:\/\/127\.0\.0\.1:(\d+))\/#k=([0-9a-f]{64})$/;
const LIVE = ['planning', 'plan_review', 'running', 'qa', 'delivering'];

/**
 * Start a hub. opts: { script (default server/index.js), args (default: --port 0 and the temp folders, file
 * secrets, mock lab), env (more variables), cwd, detached (the hub leads its own process group, as under the
 * launcher) }.
 */
function startHub(dirs, opts = {}) {
  const args = opts.args ?? ['--port', '0', '--data', dirs.dataDir, '--config', dirs.configDir, '--projects', dirs.projectsDir, '--secrets', 'file', '--labs', 'mock'];
  const child = spawn(process.execPath, [opts.script ?? INDEX, ...args], {
    env: { ...hubEnv(dirs), ...(opts.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd ?? dirs.tmp, detached: opts.detached === true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  const ready = new Promise((resolve, reject) => {
    const look = () => {
      const line = out.split('\n').find((l) => l.startsWith('WORKSHOP_READY '));
      if (line) { child.stdout.off('data', look); resolve(line); }
    };
    child.stdout.on('data', look);
    exited.then((e) => reject(new Error(`the hub exited (${e.code}, ${e.signal}) before it was ready: ${err.slice(-2000)}`)));
  });
  ready.catch(() => {});
  return { child, ready, exited, out: () => out, err: () => err };
}

async function until(fn, what, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** The hub's session from its ready line: { url, port, key, api }. */
async function connect(hub) {
  const line = await hub.ready;
  const m = READY_RE.exec(line);
  assert.ok(m, line);
  const [, url, port, key] = m;
  return { url, port: Number(port), key, api: apiClient(url, await ownerSession(url, key)) };
}

/** Mock agent processes of this shop (by command line or working folder under its temp folder). */
async function mockAgents(dirs) {
  return (await leftovers(dirs.tmp)).filter((l) => /mock-agent\.mjs/.test(l)).map((l) => Number(l.split(' ')[0]));
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

/** A request exactly as the launcher sends it through URLSession: no Origin header. */
function launcherCall(url, method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, url);
    const headers = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) Object.assign(headers, { 'X-WorkShop': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    const t0 = Date.now();
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, body: json ?? text, ms: Date.now() - t0, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function cleanup(t, dirs, hubs) {
  t.after(() => {
    for (const h of hubs()) if (h && h.child.exitCode === null && h.child.signalCode === null) { try { h.child.kill('SIGKILL'); } catch { /* gone */ } }
    if (process.env.KEEP_E2E !== '1') fs.rmSync(dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
  });
}

/** A copy of the real server/ under <base>, started as the launcher starts it (no arguments) through a wrapper. */
function launcherBase(dirs) {
  const base = path.join(dirs.tmp, 'base');
  fs.mkdirSync(path.join(base, 'config'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'server'), path.join(base, 'server'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'config', 'models.json'), path.join(base, 'config', 'models.json'));
  fs.cpSync(path.join(ROOT, 'config', 'harnesses.json'), path.join(base, 'config', 'harnesses.json'));
  fs.cpSync(path.join(ROOT, 'config', 'roster.json'), path.join(base, 'config', 'roster.json'));
  fs.writeFileSync(path.join(base, 'config', 'settings.json'), `${JSON.stringify({ mockSpeed: 0 })}\n`);
  fs.renameSync(path.join(base, 'server', 'index.js'), path.join(base, 'server', 'hub-main.js'));
  fs.writeFileSync(path.join(base, 'server', 'index.js'), "import { main } from './hub-main.js';\nmain(['--labs', 'mock', '--secrets', 'file', ...process.argv.slice(2)]);\n");
  return base;
}

describe('e2e: the real entry point', () => {
  test('node server/index.js: ready line, session, state, a demo job to done, SIGTERM, then stdin close', { timeout: 300_000 }, async (t) => {
    const dirs = tempShop('ws-e2e-entry-');
    writeSettings(dirs, {});
    let hub = startHub(dirs);
    cleanup(t, dirs, () => [hub]);
    const line = await hub.ready;
    const m = READY_RE.exec(line);
    assert.ok(m, line);
    const [, url, port, key] = m;
    assert.equal(hub.out(), `${line}\n`, 'stdout holds the ready line and nothing else');
    const lock = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'run', 'hub.lock'), 'utf8'));
    assert.deepEqual(lock, { pid: hub.child.pid, port: Number(port) });

    assert.equal((await fetch(`${url}/api/state`)).status, 401, 'no cookie, no state');
    const cookie = await ownerSession(url, key);
    const api = apiClient(url, cookie);
    const st = await api('GET', '/api/state');
    assert.equal(st.status, 200);
    for (const k of ['seq', 'state', 'providers', 'settings', 'board', 'models', 'inbox']) assert.ok(k in st.body, `state has ${k}`);
    assert.deepEqual(st.body.providers.map((p) => [p.id, p.installed, p.usable]), [['claude', false, false], ['gemini', false, false], ['oss', true, false], ['mock', true, true]]);
    assert.equal(st.body.settings.mockSpeed, 0);
    const health = await api('GET', '/api/health');
    assert.deepEqual([health.body.ok, health.body.pid], [true, hub.child.pid]);
    assert.equal((await fetch(`${url}/`)).status, 200, 'the UI is served');

    const demo = await api('POST', '/api/demo', {});
    assert.equal(demo.status, 200, JSON.stringify(demo.body));
    const J = demo.body.id;
    const jobOf = async () => (await api('GET', '/api/state')).body.state.jobs[J];
    await until(async () => { const j = await jobOf(); return j.status === 'delivering' && j.report; }, `${J} delivering`);
    const truck = await api('GET', `/api/jobs/${J}/truck`);
    assert.match(truck.body.headSha, /^[0-9a-f]{40}$/);
    assert.ok(truck.body.deliveries.length >= 3);
    const ship = await api('POST', `/api/jobs/${J}/ship`, { sha: truck.body.headSha });
    assert.deepEqual(ship.body, { ok: true, sha: truck.body.headSha, left: 0 });
    await until(async () => (await jobOf()).status === 'done', `${J} done`, 30_000);
    const job = await jobOf();
    assert.ok(job.requirements.every((r) => r.status === 'verified'));

    // SIGTERM: a clean stop, the lock goes, no process stays.
    hub.child.kill('SIGTERM');
    assert.deepEqual((({ code, signal }) => ({ code, signal }))(await hub.exited), { code: 0, signal: null }, hub.err().slice(-2000));
    assert.equal(fs.existsSync(path.join(dirs.dataDir, 'run', 'hub.lock')), false, 'the lock is released');
    assert.deepEqual(await leftovers(dirs.tmp), []);

    // A second start on the same folders keeps the state; stdin close (the launcher died) stops it.
    hub = startHub(dirs);
    const line2 = await hub.ready;
    const [, url2, , key2] = READY_RE.exec(line2);
    assert.notEqual(key2, key, 'a new owner key per start');
    const api2 = apiClient(url2, await ownerSession(url2, key2));
    const st2 = await api2('GET', '/api/state');
    assert.equal(st2.body.state.jobs[J].status, 'done');
    assert.ok(st2.body.seq >= st.body.seq + 1000, 'seq jumps by 1000 on a restart');
    hub.child.stdin.end();
    assert.deepEqual((({ code, signal }) => ({ code, signal }))(await hub.exited), { code: 0, signal: null }, hub.err().slice(-2000));
    assert.equal(fs.existsSync(path.join(dirs.dataDir, 'run', 'hub.lock')), false);
    assert.deepEqual(await leftovers(dirs.tmp), []);

    // The owner key is in no file and no log line; the hub log has no error line.
    const logText = fs.readFileSync(path.join(dirs.dataDir, 'logs', 'hub.log'), 'utf8');
    for (const k of [key, key2]) {
      assert.ok(!logText.includes(k), 'the owner key is not in hub.log');
      assert.ok(!hub.err().includes(k), 'the owner key is not on stderr');
    }
    assert.deepEqual(logText.split('\n').filter((l) => / ERROR /.test(l)), [], 'no error in hub.log');
  });
});

describe('e2e: what the launcher needs from the hub', () => {
  test('the launcher probes, pauses at quit, then closes stdin: within 8 s, then within 5 s; the job stays paused; launcher.lock is untouched', { timeout: 240_000 }, async (t) => {
    const dirs = tempShop('ws-e2e-launcher-');
    writeSettings(dirs, { mockSpeed: 1 });
    // The launcher's own lock sits next to hub.lock. The hub must never delete, rename or truncate it.
    const runDir = path.join(dirs.dataDir, 'run');
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const launcherLock = path.join(runDir, 'launcher.lock');
    fs.writeFileSync(launcherLock, `${process.pid}\n`, { mode: 0o600 });
    const lockIno = fs.statSync(launcherLock).ino;
    let hub = startHub(dirs, { detached: true });
    cleanup(t, dirs, () => [hub]);
    const s = await connect(hub);

    // The liveness probe: no cookie, any status counts, it must be fast.
    const probe = await launcherCall(s.url, 'GET', '/api/state');
    assert.equal(probe.status, 401);
    assert.ok(probe.ms < 1000, `401 in ${probe.ms} ms`);

    // The session cookie: not Secure, HttpOnly, SameSite=Strict, Path=/, no expiry (it lives as long as the hub).
    const r = await fetch(`${s.url}/api/session`, { method: 'POST', headers: { 'x-workshop': '1', 'content-type': 'application/json' }, body: JSON.stringify({ k: s.key }) });
    const setCookie = r.headers.get('set-cookie');
    const attrs = setCookie.split(';').slice(1).map((a) => a.trim().toLowerCase());
    assert.deepEqual(attrs.sort(), ['httponly', 'path=/', 'samesite=strict']);
    const cookie = setCookie.split(';')[0];

    // A live job with agents mid-turn.
    const demo = await s.api('POST', '/api/demo', {});
    const J = demo.body.id;
    await until(async () => {
      const job = (await s.api('GET', '/api/state')).body.state.jobs[J];
      return job.status === 'running' && (await mockAgents(dirs)).length >= 2;
    }, `${J} running with two agents mid-turn`);

    // The quit question: GET /api/state with the cookie (a reload of the page reuses it, so ask twice).
    for (let i = 0; i < 2; i++) {
      const st = await launcherCall(s.url, 'GET', '/api/state', { cookie });
      assert.equal(st.status, 200);
      assert.ok(LIVE.includes(st.body.state.jobs[J].status), st.body.state.jobs[J].status);
    }
    // Pause and quit: POST pause {hard:true} with Cookie, X-WorkShop, Content-Type and no Origin, turns running.
    const busy = await mockAgents(dirs);
    assert.ok(busy.length >= 1, 'agents are mid-turn when the pause arrives');
    const pause = await launcherCall(s.url, 'POST', `/api/jobs/${encodeURIComponent(J)}/pause`, { cookie, body: '{"hard":true}' });
    assert.equal(pause.status, 200, JSON.stringify(pause.body));
    assert.ok(pause.ms < 8000, `the pause answered in ${pause.ms} ms`);
    assert.equal(pause.body.status, 'paused');
    assert.equal(pause.body.pauseReason, 'owner');

    // Then the launcher closes stdin. The hub must be gone within 5 s, state saved.
    const t0 = Date.now();
    hub.child.stdin.end();
    const ended = await hub.exited;
    assert.deepEqual([ended.code, ended.signal], [0, null], hub.err().slice(-2000));
    assert.ok(ended.at - t0 < 5000, `the hub stopped ${ended.at - t0} ms after stdin closed`);
    assert.deepEqual(await leftovers(dirs.tmp), [], 'no hub, agent or check process is left');
    const saved = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'state.json'), 'utf8'));
    assert.equal(saved.jobs[J].status, 'paused');
    assert.equal(saved.jobs[J].pauseReason, 'owner');
    assert.equal(fs.existsSync(path.join(runDir, 'hub.lock')), false);
    assert.equal(fs.readFileSync(launcherLock, 'utf8'), `${process.pid}\n`, 'launcher.lock keeps its content');
    assert.equal(fs.statSync(launcherLock).ino, lockIno, 'launcher.lock is the same file');

    // The next start runs no turn by itself: the job is still paused, no agent starts.
    hub = startHub(dirs, { detached: true });
    const s2 = await connect(hub);
    await sleep(1500);
    assert.equal((await s2.api('GET', '/api/state')).body.state.jobs[J].status, 'paused');
    assert.deepEqual(await mockAgents(dirs), [], 'no agent runs for a paused job');
    hub.child.stdin.end();
    assert.equal((await hub.exited).code, 0);
    assert.equal(fs.readFileSync(launcherLock, 'utf8'), `${process.pid}\n`);
    assert.equal(fs.statSync(launcherLock).ino, lockIno);
  });

  test('stdin end-of-file with agents mid-turn and no pause first: stopped within 5 s, the job is saved as paused', { timeout: 240_000 }, async (t) => {
    const dirs = tempShop('ws-e2e-eof-');
    writeSettings(dirs, { mockSpeed: 1 });
    const hub = startHub(dirs, { detached: true });
    cleanup(t, dirs, () => [hub]);
    const s = await connect(hub);
    const J = (await s.api('POST', '/api/demo', {})).body.id;
    await until(async () => (await s.api('GET', '/api/state')).body.state.jobs[J].status === 'running' && (await mockAgents(dirs)).length >= 2, `${J} running with two agents mid-turn`);
    const t0 = Date.now();
    hub.child.stdin.end();
    const ended = await hub.exited;
    assert.deepEqual([ended.code, ended.signal], [0, null], hub.err().slice(-2000));
    assert.ok(ended.at - t0 < 5000, `the hub stopped ${ended.at - t0} ms after stdin closed`);
    assert.deepEqual(await leftovers(dirs.tmp), []);
    const job = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'state.json'), 'utf8')).jobs[J];
    assert.equal(job.status, 'paused', 'every hub stop is a pause');
    assert.equal(job.prevStatus, 'running');
    assert.match(job.error, /The hub stopped \(the WorkShop app quit\)/);
    assert.match(fs.readFileSync(path.join(dirs.dataDir, 'logs', 'hub.log'), 'utf8'), /shutdown: paused the live job/);
  });

  test('a hub killed with SIGKILL mid-turn: the next hub on the same data folder kills its agents at boot', { timeout: 240_000 }, async (t) => {
    const dirs = tempShop('ws-e2e-kill9-');
    writeSettings(dirs, { mockSpeed: 1 });
    let hub = startHub(dirs, { detached: true });
    cleanup(t, dirs, () => [hub]);
    const s = await connect(hub);
    const J = (await s.api('POST', '/api/demo', {})).body.id;
    await until(async () => (await s.api('GET', '/api/state')).body.state.jobs[J].status === 'running' && (await mockAgents(dirs)).length >= 2, `${J} running with two agents mid-turn`);
    await sleep(300); // the turn files are written at spawn
    const before = await mockAgents(dirs);
    // The launcher and the hub die at the same instant: nobody sweeps the agent groups.
    process.kill(hub.child.pid, 'SIGKILL');
    await hub.exited;
    await sleep(300);
    const orphans = before.filter(alive);
    assert.ok(orphans.length >= 1, 'kill -9 of the hub leaves its agents alive');

    hub = startHub(dirs, { detached: true });
    const s2 = await connect(hub);
    await until(async () => orphans.every((p) => !alive(p)), 'the agents of the dead hub are gone', 5000);
    // At boot, before the hub is ready (not only when the next turn starts).
    const lines = fs.readFileSync(path.join(dirs.dataDir, 'logs', 'hub.log'), 'utf8').split('\n');
    const reap = lines.findIndex((l) => /killed agent processes of an earlier hub/.test(l));
    const ready2 = lines.findLastIndex((l) => /hub ready/.test(l));
    assert.ok(reap >= 0 && reap < ready2, 'the leftovers died at boot, before the ready line');
    // A crash is no stop: the job goes on (crash recovery). Then a clean stop pauses it and leaves nothing.
    assert.ok(LIVE.includes((await s2.api('GET', '/api/state')).body.state.jobs[J].status));
    hub.child.stdin.end();
    assert.equal((await hub.exited).code, 0, hub.err().slice(-2000));
    assert.deepEqual(await leftovers(dirs.tmp), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'state.json'), 'utf8')).jobs[J].status, 'paused');
  });

  test('the port: no --port prefers DEFAULT_PORT and falls back to a free port when it is busy; --port n forces n', { timeout: 60_000 }, async (t) => {
    const dirs = tempShop('ws-e2e-port-');
    writeSettings(dirs, {});
    const noPort = ['--data', dirs.dataDir, '--config', dirs.configDir, '--projects', dirs.projectsDir, '--secrets', 'file', '--labs', 'mock'];
    const hubs = [];
    cleanup(t, dirs, () => hubs);
    const busy = () => new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(true));
      probe.listen(DEFAULT_PORT, '127.0.0.1', () => probe.close(() => resolve(false)));
    });

    // Hold the preferred port (or find it held by someone else): the hub takes another one.
    const blocker = net.createServer();
    await new Promise((resolve) => { blocker.once('error', resolve); blocker.listen(DEFAULT_PORT, '127.0.0.1', resolve); });
    assert.equal(await busy(), true);
    let h = startHub(dirs, { args: noPort });
    hubs.push(h);
    let s = await connect(h);
    assert.notEqual(s.port, DEFAULT_PORT, 'a busy preferred port gives way to a free one');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'run', 'hub.lock'), 'utf8')).port, s.port, 'the lock carries the real port');
    assert.equal((await s.api('GET', '/api/state')).status, 200);
    h.child.stdin.end();
    await h.exited;

    // --port n with n busy: no fallback, the hub exits with a message.
    h = startHub(dirs, { args: ['--port', String(DEFAULT_PORT), ...noPort] });
    hubs.push(h);
    const failed = await h.exited;
    assert.equal(failed.code, 1);
    assert.match(h.err(), /cannot start: .*EADDRINUSE/);
    await new Promise((resolve) => blocker.close(resolve));

    // The preferred port when it is free (another hub on this Mac may hold it: then it must really be busy).
    h = startHub(dirs, { args: noPort });
    hubs.push(h);
    s = await connect(h);
    if (s.port !== DEFAULT_PORT) assert.equal(await busy(), true, `the hub took ${s.port} while ${DEFAULT_PORT} was free`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'run', 'hub.lock'), 'utf8')).port, s.port);
    h.child.stdin.end();
    assert.equal((await h.exited).code, 0);
  });

  test('a start with no arguments (the launcher layout): data, config and projects under <base>; WORKSHOP_STUB_* is ignored', { timeout: 120_000 }, async (t) => {
    const dirs = tempShop('ws-e2e-noargs-');
    const base = launcherBase(dirs);
    const env = { WORKSHOP_STUB_CRASH_AT_BOOT: '1', WORKSHOP_STUB_NO_READY: '1', WORKSHOP_STUB_STUBBORN: '1', WORKSHOP_STUB_PAUSE_FAIL: '1', WORKSHOP_STUB_LIVE: '1', WORKSHOP_LAUNCHER_PID: String(process.pid) };
    const hub = startHub(dirs, { script: path.join(base, 'server', 'index.js'), args: [], cwd: base, env, detached: true });
    cleanup(t, dirs, () => [hub]);
    const s = await connect(hub);
    assert.equal(hub.out().split('\n').filter(Boolean).length, 1, 'one ready line: hub-main.js did not run main() a second time');
    const lock = JSON.parse(fs.readFileSync(path.join(base, 'data', 'run', 'hub.lock'), 'utf8'));
    assert.deepEqual(lock, { pid: hub.child.pid, port: s.port });
    assert.ok(fs.existsSync(path.join(base, 'data', 'state.json')) || fs.existsSync(path.join(base, 'data', 'logs', 'hub.log')), 'data lives in <base>/data');
    const st = await s.api('GET', '/api/state');
    assert.equal(st.body.settings.mockSpeed, 0, 'the settings come from <base>/config');
    assert.deepEqual(st.body.providers.map((p) => [p.id, p.usable]), [['claude', false], ['gemini', false], ['oss', false], ['mock', true]]);
    const demo = await s.api('POST', '/api/demo', {});
    assert.equal(demo.status, 200);
    await until(async () => fs.existsSync(path.join(base, 'projects', 'recipe-box-demo')), 'the demo project in <base>/projects', 60_000);
    await until(async () => LIVE.includes((await s.api('GET', '/api/state')).body.state.jobs[demo.body.id].status), 'a live job', 60_000);
    const paused = await s.api('POST', `/api/jobs/${demo.body.id}/pause`, { hard: true });
    assert.equal(paused.body.status, 'paused', `WORKSHOP_STUB_PAUSE_FAIL does nothing: ${JSON.stringify(paused.body)}`);
    const t0 = Date.now();
    hub.child.stdin.end();
    const ended = await hub.exited;
    assert.deepEqual([ended.code, ended.signal], [0, null], 'WORKSHOP_STUB_STUBBORN does nothing');
    assert.ok(ended.at - t0 < 5000);
    assert.deepEqual(await leftovers(dirs.tmp), []);
    for (const name of ['data', 'config', 'projects']) assert.ok(fs.existsSync(path.join(base, name)), `<base>/${name}`);
    assert.equal(fs.existsSync(path.join(dirs.tmp, 'data')), false, 'nothing went to the working folder of the test');
  });

  test('no server file reads WORKSHOP_STUB_* (launcher test hooks only)', () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(m?js)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('WORKSHOP_STUB_')) hits.push(p);
      }
    };
    walk(path.join(ROOT, 'server'));
    assert.deepEqual(hits, []);
  });
});
