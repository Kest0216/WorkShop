// Runner tests with a fake adapter that spawns tests/fixtures/fake-agent.mjs (small Node scripts).
// The store and the MCP endpoint are the real modules. No real agent CLI runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../server/runner.js';
import { createStore } from '../server/store.js';
import { createMcp, mountMcp } from '../server/mcp.js';
import { createHttp } from '../server/http.js';
import { createParser as createMockParser, createMockAdapter } from '../server/providers/mock.js';
import { createProviders } from '../server/providers/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FAKE = path.join(HERE, 'fixtures', 'fake-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 8000) { // generous: other work on this Mac can make a process exit slowly
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(25);
  return !alive(pid);
}
async function until(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

function setup(t, { limits = {}, tuning = {}, priceFor, mcpUrl = 'http://127.0.0.1:1/mcp', git = null, redactor = null, now, auth = {}, adapterExtra = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-runner-')));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const paths = { server: path.join(ROOT, 'server'), data: path.join(dir, 'data'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') };
  const store = createStore({ dataDir: path.join(dir, 'data') });
  const mcp = createMcp({ store });
  const settings = {
    limits: { maxAgents: 6, perProvider: { fake: 6, other: 6 }, turnTimeoutMin: 45, idleTimeoutMin: 12, ...limits },
    auth: { fake: 'subscription', other: 'subscription', ...auth }, safety: 'sandboxed',
  };
  const built = [];
  const agentlog = [];
  store.subscribe((e) => { if (e.type === 'agentlog') agentlog.push(e); });
  const state = { url: mcpUrl, env: {}, hubFiles: null };
  // model = the mode of the fake agent; effort = its duration in ms (slow mode)
  const makeAdapter = (id) => ({
    id, label: id, selfTestModel: 'selftest',
    buildRun(o) {
      built.push({ ...o, at: Date.now() });
      if (o.model === 'throw') throw new Error('adapter failed on purpose');
      const spec = {
        cmd: o.model === 'enoent' ? path.join(dir, 'no-such-binary') : process.execPath,
        args: [FAKE, o.model, work, o.agent.id, String(o.effort ?? 300)],
        env: {
          PATH: '/usr/bin:/bin', FAKE_SESSION: o.resume ? o.sessionId : '', FAKE_MCP_URL: o.mcp.url, FAKE_MCP_TOKEN: o.mcp.token,
          WORKSHOP_TOKEN: o.mcp.token, WORKSHOP_TAG_URL: `${o.mcp.url}/${o.mcp.token}/tag`, FAKE_DENY: [path.join(paths.run, 'selftest'), o.runDir].join(':'), ...state.env,
        },
        cwd: o.cwd, stdin: o.model === 'tree' ? null : o.prompt, stopSignal: 'SIGINT',
        files: [{ path: path.join(o.runDir, 'role.txt'), content: o.systemPrompt }, { path: o.mcp.urlFile, content: `${o.mcp.url}/${o.mcp.token}` }],
        hubFiles: state.hubFiles ?? {},
        sessionId: o.sessionId,
      };
      if (o.model === 'outside') spec.files.push({ path: path.join(dir, 'escape.txt'), content: 'x' });
      if (o.model === 'inbench') spec.files.push({ path: path.join(o.cwd, '.agents', 'x.json'), content: 'x' });
      return spec;
    },
    createParser: () => createMockParser(),
    ...adapterExtra,
  });
  const adapters = { fake: makeAdapter('fake'), other: makeAdapter('other') };
  const providers = {
    cooled: [], marked: [], successes: [], cooling: {}, auth: {}, installed: { fake: true, other: true }, modelOff: {},
    get(id) { if (!adapters[id]) throw new Error(`Unknown provider: ${id}`); return adapters[id]; },
    status(id) {
      const cooling = this.cooling[id] ?? null;
      const auth = this.auth[id] ?? 'ok';
      const installed = this.installed[id] !== false;
      const reason = !installed ? `${id} is not installed.` : cooling ? `Paused: ${cooling.reason}` : auth !== 'ok' ? `${id} is not signed in.` : null;
      return { id, installed, path: installed ? process.execPath : null, mode: settings.auth[id], auth, cooling, cooledModels: this.modelOff, usable: reason === null, reason };
    },
    usable(id) { return this.status(id).usable; },
    modelUsable(id, model) { return this.usable(id) && !this.modelOff[model]; },
    async detect() { return []; },
    async keyEnv() { return {}; },
    cool(id, until, reason, opts = {}) {
      this.cooled.push({ id, until, reason, opts });
      if (opts.model) this.modelOff[opts.model] = { until, reason };
      else this.cooling[id] = { until, reason };
    },
    noteSuccess(id, model) { this.successes.push({ id, model }); },
    markAuth(id, value) { this.marked.push({ id, value }); this.auth[id] = value; },
  };
  const logs = [];
  const runner = createRunner({
    store, providers, mcp, git, redactor, paths, getSettings: () => settings, getMcpUrl: () => state.url, priceFor, ...(now ? { now } : {}),
    log: (level, msg, data) => logs.push({ level, msg, data }),
    tuning: { minSpawnGapMs: 0, killGraceMs: 300, shutdownGraceMs: 200, closeWaitMs: 300, logFlushMs: 50, progressEveryMs: 0, ...tuning },
  });
  t.after(async () => {
    await runner.shutdown();
    await store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const agent = (id, extra = {}) => store.put('agents', { id, jobId: null, name: id, handle: `@${id}`, role: 'maker', provider: 'fake', model: 'normal', status: 'idle', taskId: null, sessionId: null, stats: { turns: 0, inTok: 0, outTok: 0, usd: 0 }, ...extra });
  const go = (id, opts = {}) => runner.run(id, { prompt: 'Do the task.', systemPrompt: 'Role card.', cwd: work, ...opts });
  const read = (name) => { try { return fs.readFileSync(path.join(work, name), 'utf8'); } catch { return null; } };
  const pid = (tag, suffix = 'pid') => Number(read(`${tag}.${suffix}`));
  const starts = () => (read('starts.log') ?? '').trim().split('\n').filter(Boolean).map((l) => { const [tag, ts] = l.split(' '); return { tag, ts: Number(ts) }; });
  const ends = () => (read('ends.log') ?? '').trim().split('\n').filter(Boolean).map((l) => { const [tag, ts] = l.split(' '); return { tag, ts: Number(ts) }; });
  return { dir, work, paths, store, mcp, settings, providers, runner, built, agentlog, logs, agent, go, read, pid, starts, ends, state };
}

test('a normal turn: result, stdin closed, files, logs, store updates', async (t) => {
  const w = setup(t);
  // An old job row with the cost field of the earlier contract: usd goes, billedUsd / estUsd come.
  w.store.put('jobs', { id: 'J1', title: 'job', cost: { usd: 1, inTok: 10, outTok: 5 } });
  w.store.put('tasks', { id: 'T1', jobId: 'J1', progress: 0, cost: { usd: 0 } });
  w.agent('A1', { jobId: 'J1', taskId: 'T1' });
  process.env.WS_RUNNER_LEAK_CHECK = 'must-not-reach-the-agent';
  t.after(() => { delete process.env.WS_RUNNER_LEAK_CHECK; });
  const before = Date.now();
  const res = await w.go('A1', { kind: 'work', taskId: 'T1' });

  assert.deepEqual(Object.keys(res).sort(), ['calls', 'denied', 'durationMs', 'error', 'killed', 'loaded', 'mcpOk', 'ok', 'sessionId', 'started', 'startedAt', 'text', 'usage', 'usd']);
  assert.equal(res.ok, true);
  assert.equal(res.text, 'done: 12 chars of prompt');
  assert.equal(res.sessionId, 'sess-A1');
  assert.equal(res.usd, 0.25);
  assert.deepEqual(res.usage, { inTok: 100, outTok: 20, cacheRead: 1000, cacheWrite: 50, ctxTok: 1150 }, 'usage.ctxTok: the last ctx value');
  assert.ok(res.startedAt >= before && res.startedAt <= Date.now(), 'startedAt: when the process was spawned');
  assert.deepEqual(res.loaded, ['shop'], 'loaded: from the init event');
  assert.deepEqual(res.calls, ['Edit', 'shop.post']);
  assert.deepEqual(res.denied, ['Bash git push origin main']);
  assert.deepEqual([res.error, res.killed, res.started, res.mcpOk], [null, null, true, true]);
  assert.ok(res.durationMs >= 0);

  assert.equal(w.read('A1.stdin'), 'Do the task.', 'the prompt arrived on stdin and stdin was closed (the agent saw the end)');
  assert.ok(await gone(w.pid('A1')), 'the process is gone');
  const env = JSON.parse(w.read('A1.env'));
  assert.equal(env.WS_RUNNER_LEAK_CHECK, undefined, 'the child gets the adapter environment, not the hub environment');
  assert.equal(env.FAKE_MCP_URL, 'http://127.0.0.1:1/mcp');
  assert.match(env.FAKE_MCP_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(w.mcp.agentFor(env.FAKE_MCP_TOKEN), null, 'the token of the turn is revoked at its end');

  const roleFile = path.join(w.paths.run, 'A1', 'role.txt');
  assert.equal(fs.readFileSync(roleFile, 'utf8'), 'Role card.');
  assert.equal(fs.statSync(roleFile).mode & 0o777, 0o600);
  const b = w.built[0];
  assert.deepEqual([b.resume, b.access, b.web, b.mode, b.safety, b.runDir, b.cwd], [false, 'write', false, 'subscription', 'sandboxed', path.join(w.paths.run, 'A1'), w.work]);
  assert.match(b.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(b.mcp.shimPath, path.join(ROOT, 'server', 'mcp-stdio-shim.mjs'));
  assert.equal(b.mcp.nodePath, process.execPath);
  assert.equal(b.timeoutMs, 45 * 60_000);

  const raw = fs.readFileSync(path.join(w.paths.logs, 'A1.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(raw[0]).type, 'workshop_turn_start');
  assert.ok(raw.includes('this line is not JSON and must be ignored'), 'the raw stream is kept as it came');
  assert.deepEqual([JSON.parse(raw.at(-1)).type, JSON.parse(raw.at(-1)).ok], ['workshop_turn_end', true]);

  const lines = w.agentlog.filter((e) => e.agentId === 'A1').flatMap((e) => e.lines);
  assert.deepEqual(lines.map((l) => l.k), ['sys', 'text', 'tool', 'tool', 'err', 'err', 'sys']);
  assert.deepEqual(lines.slice(1, 6).map((l) => l.s), ['Working on it.', 'Edit src/a.js', 'shop post DONE T1', 'ERR E_BODY too long', 'denied: Bash git push origin main']);
  assert.ok(w.store.eventsSince(0).filter((e) => e.type === 'agentlog').length > 0);
  assert.deepEqual(w.runner.logTail('A1').map((l) => l.k), ['sys', 'text', 'tool', 'tool', 'err', 'err', 'sys']);
  assert.equal(w.runner.logTail('A1', 2).length, 2);

  const a = w.store.get('agents', 'A1');
  assert.equal(a.sessionId, null, 'the runner never writes agent.sessionId (the orchestrator stores the session id)');
  assert.deepEqual(a.stats, { turns: 1, inTok: 1150, outTok: 20, usd: 0.25, ctxTok: 1150, ctxMax: 200000 });
  assert.ok(a.lastActiveAt > 0);
  assert.deepEqual(w.store.get('jobs', 'J1').cost, { billedUsd: 0, estUsd: 0.25, inTok: 1160, outTok: 25 }, 'a subscription turn is an estimate; job.cost.usd is gone');
  assert.equal(w.store.get('tasks', 'T1').cost.usd, 0.25);
  assert.ok(w.store.get('tasks', 'T1').progress > 0 && w.store.get('tasks', 'T1').progress <= 0.9, 'progress grows with tool calls');
  assert.deepEqual([w.runner.active(), w.runner.queued(), w.runner.busy('A1')], [[], [], false]);
});

test('sessions: the caller passes the session id; the runner returns it and never reads or writes agent.sessionId', async (t) => {
  const w = setup(t);
  w.agent('A1', { sessionId: 'S0' }); // the main session of a boss, say; a work turn resumes another one
  const first = await w.go('A1');
  assert.equal(first.sessionId, 'sess-A1');
  assert.equal(w.built[0].resume, false);
  assert.notEqual(w.built[0].sessionId, 'S0', 'no resume: a fresh id, agent.sessionId is not read');
  const second = await w.go('A1', { sessionId: 'S1', resume: true, prompt: 'Continue.' });
  assert.deepEqual([w.built[1].resume, w.built[1].sessionId], [true, 'S1'], 'the adapter gets opts.sessionId');
  assert.equal(second.sessionId, 'S1', 'TurnResult.sessionId');
  assert.equal(w.read('A1.stdin'), 'Continue.');
  assert.equal(w.store.get('agents', 'A1').sessionId, 'S0', 'agent.sessionId is still S0 after the turn');
  const third = await w.go('A1', { resume: false, sessionId: 'S1' });
  assert.equal(w.built[2].resume, false);
  assert.notEqual(w.built[2].sessionId, 'S1', 'a new session gets a fresh id');
  assert.equal(third.ok, true);
  await w.go('A1', { resume: true });
  assert.equal(w.built[3].resume, false, 'resume without a session id starts a new one (agent.sessionId S0 is not used)');
  assert.equal(w.store.get('agents', 'A1').stats.turns, 4);
  assert.equal(w.store.get('agents', 'A1').sessionId, 'S0');
});

test('token per turn: minted at spawn, revoked at every turn end; the URL file lives for the turn only', async (t) => {
  const w = setup(t);
  w.agent('A1');
  const urlFile = path.join(w.paths.run, 'A1', 'mcp-url');
  w.state.env = { FAKE_CHECK_FILES: urlFile };
  const first = await w.go('A1');
  assert.equal(first.ok, true);
  const token1 = JSON.parse(w.read('A1.env')).FAKE_MCP_TOKEN;
  const during = JSON.parse(w.read('A1.checked'))[urlFile];
  assert.deepEqual(during, { exists: true, content: `http://127.0.0.1:1/mcp/${token1}` }, 'the URL file exists while the turn runs');
  assert.equal(w.built[0].mcp.urlFile, urlFile, 'the adapter gets the URL file path data/run/<agentId>/mcp-url');
  assert.equal(fs.existsSync(urlFile), false, 'the URL file is gone after the turn');
  assert.equal(w.mcp.agentFor(token1), null, 'the token of turn 1 opens nothing after the turn');
  const http = createHttp({ ownerKey: 'test-owner-key-0123456789', log: () => {} });
  mountMcp(http, w.mcp);
  const { url } = await http.listen();
  t.after(() => http.close());
  const answer = await fetch(`${url}/mcp/${token1}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-WorkShop': '1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  assert.equal(answer.status, 404, 'the token of turn 1 answers 404 after the turn');
  await w.go('A1');
  const token2 = JSON.parse(w.read('A1.env')).FAKE_MCP_TOKEN;
  assert.notEqual(token2, token1, 'turn 2 has another token');
  assert.equal(w.mcp.agentFor(token2), null);

  // A turn that never spawned (the adapter failed) revokes its token too.
  w.agent('A2', { model: 'throw' });
  await w.go('A2');
  assert.equal(w.mcp.agentFor(w.built.at(-1).mcp.token), null);
});

test('MCP not connected: the turn is stopped with error kind mcp', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'mcpfail' });
  const t0 = Date.now();
  const res = await w.go('A1');
  assert.ok(Date.now() - t0 < 10_000, 'the hanging agent is stopped at once (it would hang forever)');
  assert.deepEqual([res.ok, res.error.kind, res.killed, res.mcpOk, res.started], [false, 'mcp', null, false, true]);
  assert.ok(await gone(w.pid('A1')));
});

test('idle timeout and wall-clock timeout kill the turn', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'idle' });
  // 2 s without output: on a busy Mac the fake agent needs a moment before it prints its first line
  const idle = await w.go('A1', { idleMs: 2000, timeoutMs: 60_000 });
  assert.deepEqual([idle.ok, idle.killed, idle.error.kind], [false, 'idle', 'other']);
  assert.match(idle.error.message, /no output/);
  assert.ok(w.pid('A1') > 1, 'the agent started and wrote its pid');
  assert.ok(await gone(w.pid('A1')));

  w.agent('A2', { model: 'chatty' });
  const wall = await w.go('A2', { idleMs: 20_000, timeoutMs: 500 });
  assert.deepEqual([wall.ok, wall.killed], [false, 'timeout']);
  const chatty = w.pid('A2'); // 0 when the limit of 500 ms came before the agent wrote its pid (a very busy Mac)
  assert.match(wall.error.message, /time limit/);
  assert.ok(wall.durationMs >= 450 && wall.durationMs < 12_000, `stopped by the time limit of 500 ms, not by the idle limit of 20 s: ${wall.durationMs} ms`);
  if (chatty > 1) assert.ok(await gone(chatty));
  assert.equal(w.store.get('agents', 'A2').stats.turns, 1, 'a killed turn still counts');
});

test('cancel: a running turn, a waiting turn, nothing to cancel', async (t) => {
  const w = setup(t, { limits: { maxAgents: 1 } });
  w.agent('A1', { model: 'idle' });
  w.agent('A2');
  const running = w.go('A1');
  const waiting = w.go('A2');
  assert.ok(await until(() => w.pid('A1') > 1));
  assert.deepEqual([w.runner.active(), w.runner.queued()], [['A1'], ['A2']]);
  assert.equal(w.runner.busy('A2'), true);
  assert.equal(w.runner.cancel('A2', 'not needed'), true);
  const q = await waiting;
  assert.deepEqual([q.ok, q.killed, q.started], [false, 'cancel', false]);
  assert.equal(w.read('A2.pid'), null, 'a cancelled waiting turn never starts');
  assert.equal(w.runner.cancel('A1', 'owner paused the job'), true);
  const r = await running;
  assert.deepEqual([r.ok, r.killed], [false, 'cancel']);
  assert.match(r.error.message, /cancelled.*owner paused the job/);
  assert.ok(await gone(w.pid('A1')));
  assert.equal(w.runner.cancel('A1', 'again'), false);
  assert.equal(w.runner.cancel('nobody', 'x'), false);
});

test('crash without a result, and a clean exit without a result', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'crash' });
  const crash = await w.go('A1');
  assert.deepEqual([crash.ok, crash.killed, crash.error.kind, crash.text], [false, null, 'other', 'about to crash']);
  assert.match(crash.error.message, /exit code 3.*boom/);
  assert.equal(crash.sessionId, 'sess-A1');
  w.agent('A2', { model: 'noresult' });
  const none = await w.go('A2');
  assert.deepEqual([none.ok, none.error.kind], [false, 'other']);
  assert.match(none.error.message, /without a result/);
  const raw = fs.readFileSync(path.join(w.paths.logs, 'A1.jsonl'), 'utf8');
  assert.ok(raw.includes('"type":"stderr"') && raw.includes('boom'));
});

test('rate limit: the lab is cooled, and the next turn does not start', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'ratelimit' });
  const before = Date.now();
  const res = await w.go('A1');
  assert.deepEqual([res.ok, res.error.kind, res.killed], [false, 'rate_limit', null]);
  assert.ok(res.error.resetAt > before + 3_500_000);
  assert.equal(w.providers.cooled.length, 1);
  assert.deepEqual([w.providers.cooled[0].id, w.providers.cooled[0].until, w.providers.cooled[0].reason], ['fake', res.error.resetAt, "You've hit your session limit · resets 3:45pm"]);
  assert.deepEqual(Object.keys(w.providers.cooled[0].opts), ['turnStartedAt'], 'no model: the whole lab cools');
  assert.equal(w.providers.cooled[0].opts.turnStartedAt, res.startedAt, 'turnStartedAt: the cooling episode ignores turns that started before it');
  assert.deepEqual(w.providers.successes, [], 'a failed turn is no success');
  w.agent('A2');
  const next = await w.go('A2');
  assert.deepEqual([next.ok, next.started, next.error.kind, next.error.resetAt], [false, false, 'rate_limit', res.error.resetAt]);
  assert.equal(w.read('A2.pid'), null, 'no process for a cooled lab');
  assert.equal(w.store.get('agents', 'A2').stats.turns, 0);
});

test('auth error: the lab is marked signed out and the turn is stopped', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'auth' });
  const res = await w.go('A1');
  assert.deepEqual([res.ok, res.error.kind, res.killed], [false, 'auth', null]);
  assert.deepEqual(w.providers.marked, [{ id: 'fake', value: 'none' }]);
  assert.ok(await gone(w.pid('A1')), 'a CLI that would retry for minutes is stopped');
  w.agent('A2');
  const next = await w.go('A2');
  assert.deepEqual([next.started, next.error.kind], [false, 'auth'], 'no new spawn for a signed-out lab');
});

test('one turn per agent; global and per-provider limits; bosses first', async (t) => {
  const w = setup(t, { limits: { maxAgents: 2, perProvider: { fake: 1, other: 2 } } });
  for (const id of ['F1', 'F2']) w.agent(id, { model: 'slow' });
  for (const id of ['O1', 'O2', 'O3']) w.agent(id, { model: 'slow', provider: 'other' });
  const first = w.go('F1', { effort: '250' });
  const twice = await w.go('F1');
  assert.match(twice.error.message, /already runs a turn/);
  const rest = [w.go('F2', { effort: '250' }), w.go('O1', { effort: '250' }), w.go('O2', { effort: '250' }), w.go('O3', { effort: '250' })];
  const results = await Promise.all([first, ...rest]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.map((r) => r.error)));
  const start = Object.fromEntries(w.starts().map((s) => [s.tag, s.ts]));
  const end = Object.fromEntries(w.ends().map((s) => [s.tag, s.ts]));
  const overlap = (a, b) => start[a] < end[b] && start[b] < end[a];
  assert.equal(overlap('F1', 'F2'), false, 'per-provider limit 1');
  const ids = ['F1', 'F2', 'O1', 'O2', 'O3'];
  for (const id of ids) {
    const others = ids.filter((o) => o !== id && start[o] <= start[id] && end[o] > start[id]);
    assert.ok(others.length <= 1, `at most 2 agents at the start of ${id} (also running: ${others})`);
  }

  const q = setup(t, { limits: { maxAgents: 1 } });
  q.agent('M1', { model: 'slow' });
  q.agent('M2', { model: 'slow' });
  q.agent('B1', { model: 'slow', role: 'boss' });
  q.agent('G1', { model: 'slow', role: 'manager' });
  await Promise.all([q.go('M1', { effort: '150' }), q.go('M2', { effort: '50' }), q.go('G1', { effort: '50' }), q.go('B1', { effort: '50' })]);
  assert.deepEqual(q.starts().map((s) => s.tag), ['M1', 'B1', 'G1', 'M2'], 'the queue serves bosses, then managers, then makers');
});

test('spawn spacing: at least the configured gap between two spawns', async (t) => {
  const w = setup(t, { tuning: { minSpawnGapMs: 350 } });
  for (const id of ['A1', 'A2', 'A3']) w.agent(id, { model: 'slow' });
  const t0 = Date.now();
  await Promise.all(['A1', 'A2', 'A3'].map((id) => w.go(id, { effort: '20' })));
  assert.equal(w.starts().length, 3);
  const ts = w.built.map((b) => b.at); // the adapter builds the command right before the spawn
  assert.equal(ts.length, 3);
  assert.ok(ts[1] - ts[0] >= 330 && ts[2] - ts[1] >= 330, `gaps: ${ts[1] - ts[0]} ms, ${ts[2] - ts[1]} ms`);
  assert.ok(Date.now() - t0 >= 700);
});

test('shutdown: no orphan process is left (verified by pid), waiting turns end, new turns are refused', async (t) => {
  const w = setup(t, { limits: { maxAgents: 3 } });
  w.agent('TREE', { model: 'tree' });
  w.agent('STUB', { model: 'stubborn' });
  w.agent('IDLE', { model: 'idle' });
  w.agent('WAIT', { model: 'normal' });
  const turns = ['TREE', 'STUB', 'IDLE', 'WAIT'].map((id) => w.go(id));
  assert.ok(await until(() => ['TREE', 'STUB', 'IDLE'].every((id) => w.pid(id) > 1) && w.pid('TREE', 'child.pid') > 1)); // the files exist and hold their pids
  const pids = [w.pid('TREE'), w.pid('TREE', 'child.pid'), w.pid('STUB'), w.pid('IDLE')];
  assert.ok(pids.every((p) => p > 0 && alive(p)), 'all processes run before the shutdown');
  assert.equal(w.read('TREE.stdin'), '', 'stdin is closed even when the adapter gives no prompt');
  const t0 = Date.now();
  await w.runner.shutdown();
  assert.ok(Date.now() - t0 < 12_000, `shutdown took ${Date.now() - t0} ms`);
  for (const p of pids) assert.equal(alive(p), false, `pid ${p} must be gone right after shutdown()`);
  const results = await Promise.all(turns);
  assert.deepEqual(results.map((r) => r.killed), ['shutdown', 'shutdown', 'shutdown', 'shutdown']);
  assert.deepEqual(results.map((r) => r.started), [true, true, true, false]);
  assert.equal(w.read('WAIT.pid'), null);
  assert.deepEqual([w.runner.active(), w.runner.queued()], [[], []]);
  const late = await w.go('WAIT');
  assert.deepEqual([late.killed, late.started], ['shutdown', false]);
  await w.runner.shutdown(); // a second call is harmless
});

test('a stubborn agent gets SIGKILL after the grace steps; a leftover child that holds the pipes is killed', async (t) => {
  const w = setup(t);
  w.agent('STUB', { model: 'stubborn' });
  const p = w.go('STUB');
  assert.ok(await until(() => w.pid('STUB') > 1));
  await sleep(100);
  const t0 = Date.now();
  w.runner.cancel('STUB', 'stop');
  const res = await p;
  assert.equal(res.killed, 'cancel');
  assert.ok(Date.now() - t0 >= 550 && Date.now() - t0 < 12_000, `SIGINT, then SIGTERM, then SIGKILL: ${Date.now() - t0} ms`);
  assert.equal(alive(w.pid('STUB')), false);

  w.agent('HOLD', { model: 'holdpipe' });
  const t1 = Date.now();
  const hold = await w.go('HOLD');
  assert.deepEqual([hold.ok, hold.text], [true, 'done with a leftover child']);
  assert.ok(Date.now() - t1 < 12_000, 'the runner does not wait for the grandchild (it sleeps for 10 minutes)');
  assert.ok(await gone(w.pid('HOLD', 'child.pid')), 'the leftover child in the process group is killed');
});

test('a last line without a newline is still parsed; a flood of lines is throttled', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'partial' });
  const res = await w.go('A1');
  assert.deepEqual([res.ok, res.text], [true, 'no newline at the end']);

  w.agent('A2', { model: 'flood' });
  const flood = await w.go('A2');
  assert.equal(flood.ok, true);
  const events = w.agentlog.filter((e) => e.agentId === 'A2');
  assert.ok(events.length <= Math.ceil(flood.durationMs / 50) + 3, `${events.length} agentlog events in ${flood.durationMs} ms`);
  assert.ok(events.every((e) => e.lines.length <= 41));
  const lines = events.flatMap((e) => e.lines);
  assert.ok(lines.some((l) => /more lines not shown/.test(l.s)));
  assert.ok(lines.length < 502);
  assert.equal(w.runner.logTail('A2').length, 200, 'the tail keeps the last 200 lines');
  assert.equal(w.runner.logTail('A2').at(-1).s, 'turn ended');
  assert.equal(w.store.eventsSince(0).some((e) => e.type === 'agentlog' && e.agentId === 'A2'), true);
});

test('start problems resolve with an error and never throw', async (t) => {
  const w = setup(t);
  const unknown = await w.runner.run('NOPE', { prompt: 'x', cwd: w.work });
  assert.match(unknown.error.message, /Unknown agent/);
  w.agent('P1', { provider: 'missing' });
  assert.match((await w.go('P1')).error.message, /Unknown provider/);
  w.agent('A1');
  const noCwd = await w.go('A1', { cwd: path.join(w.dir, 'no-such-folder') });
  assert.deepEqual([noCwd.ok, noCwd.started], [false, false]);
  assert.match(noCwd.error.message, /work folder does not exist/);
  w.agent('A2', { model: 'throw' });
  assert.match((await w.go('A2')).error.message, /adapter failed on purpose/);
  w.agent('A3', { model: 'enoent' });
  const enoent = await w.go('A3');
  assert.deepEqual([enoent.ok, enoent.started], [false, false]);
  assert.match(enoent.error.message, /Cannot start no-such-binary: ENOENT/);
  w.agent('A4', { model: 'outside' });
  assert.match((await w.go('A4')).error.message, /outside the run folder/);
  assert.equal(fs.existsSync(path.join(w.dir, 'escape.txt')), false);
  w.state.url = '';
  w.agent('A5');
  assert.match((await w.go('A5')).error.message, /MCP URL is not known/);
  assert.deepEqual([w.runner.active(), w.runner.queued()], [[], []], 'failed starts free their slot');
  w.state.url = 'http://127.0.0.1:1/mcp';
  assert.equal((await w.go('A1')).ok, true, 'the runner still works');
});

test('bench files: hubFiles go through git.writeHubFiles; an agy-style adapter gets git.cleanAgentDir first', async (t) => {
  // A stand-in for the gitops calls of section 9 (writeHubFiles, cleanAgentDir), recording the order.
  const calls = [];
  const git = {
    writeHubFiles(dir, files) {
      calls.push(['write', dir, Object.keys(files)]);
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
      }
    },
    async cleanAgentDir(dir, keep) {
      calls.push(['clean', dir, [...keep]]);
      const removed = [];
      for (const name of fs.readdirSync(path.join(dir, '.agents'), { withFileTypes: true })) {
        const rel = `.agents/${name.name}`;
        if (name.isFile() && !keep.includes(rel)) { fs.rmSync(path.join(dir, rel)); removed.push(rel); }
      }
      return removed;
    },
  };
  const w = setup(t, { git, adapterExtra: { cleanAgentDir: true } });
  w.agent('A1');
  const hooks = path.join(w.work, '.agents', 'hooks.json');
  fs.mkdirSync(path.dirname(hooks), { recursive: true });
  fs.writeFileSync(hooks, '{"hooks":{"PostToolUse":[{"command":"touch /tmp/pwned"}]}}');
  w.state.hubFiles = { '.agents/mcp_config.json': '{"mcpServers":{}}\n' };
  w.state.env = { FAKE_CHECK_FILES: `${hooks}:${path.join(w.work, '.agents', 'mcp_config.json')}` };
  const res = await w.go('A1');
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const seen = JSON.parse(w.read('A1.checked'));
  assert.equal(seen[hooks].exists, false, 'a planted .agents/hooks.json is gone before the spawn');
  assert.equal(seen[path.join(w.work, '.agents', 'mcp_config.json')].content, '{"mcpServers":{}}\n', 'the hub file is there at the spawn');
  assert.deepEqual(calls, [['clean', w.work, ['.agents/mcp_config.json']], ['write', w.work, ['.agents/mcp_config.json']]]);
  assert.ok(w.runner.logTail('A1').some((l) => l.s === 'removed from .agents/: .agents/hooks.json'));

  // Without a git module (older wiring) the runner writes the hub files itself, and still removes a hooks.json.
  const plain = setup(t, { adapterExtra: { cleanAgentDir: true } });
  plain.agent('A1');
  fs.mkdirSync(path.join(plain.work, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(plain.work, '.agents', 'hooks.json'), '{}');
  plain.state.hubFiles = { '.agents/workshop-prompt.md': 'long prompt' };
  assert.equal((await plain.go('A1')).ok, true);
  assert.equal(fs.existsSync(path.join(plain.work, '.agents', 'hooks.json')), false);
  assert.equal(fs.readFileSync(path.join(plain.work, '.agents', 'workshop-prompt.md'), 'utf8'), 'long prompt');

  // A bench file outside the hub paths, and an adapter file inside the bench, are refused.
  plain.state.hubFiles = { 'src/evil.js': 'x' };
  assert.match((await plain.go('A1')).error.message, /bench file outside the hub paths/);
  plain.state.hubFiles = { '.agents/../../escape.txt': 'x' };
  assert.match((await plain.go('A1')).error.message, /bench file outside the hub paths/);
  plain.state.hubFiles = null;
  plain.agent('A2', { model: 'inbench' });
  assert.match((await plain.go('A2')).error.message, /outside the run folder/, 'adapter files go to data/run/<agentId>/ only');
  assert.equal(fs.existsSync(path.join(plain.work, '.agents', 'x.json')), false);
});

test('cost: computed from prices when the CLI reports none', async (t) => {
  const w = setup(t, { priceFor: (provider, model, usage) => (provider === 'fake' && model === 'slow' ? usage.inTok * 2 + usage.outTok * 3 : null) });
  w.agent('A1', { model: 'slow' });
  const res = await w.go('A1', { effort: '10' });
  assert.equal(res.usd, 5);
  assert.equal(w.store.get('agents', 'A1').stats.usd, 5);

  const d = setup(t);
  fs.mkdirSync(d.paths.config, { recursive: true });
  fs.writeFileSync(path.join(d.paths.config, 'models.json'), JSON.stringify({ models: [{ id: 'slow', price: { in: 1_000_000, out: 2_000_000 } }, { id: 'broken' }] }));
  d.agent('A1', { model: 'slow' });
  assert.equal((await d.go('A1', { effort: '10' })).usd, 3, 'default: config/models.json, USD per million tokens');
  const n = setup(t);
  n.agent('A1', { model: 'slow' });
  assert.equal((await n.go('A1', { effort: '10' })).usd, null, 'no price list: the cost stays unknown');
});

test('selfTest: one tiny turn through a real MCP endpoint, reported step by step', async (t) => {
  const w = setup(t);
  const http = createHttp({ ownerKey: 'test-owner-key-0123456789', log: () => {} });
  mountMcp(http, w.mcp);
  const { url } = await http.listen();
  t.after(() => http.close());
  w.state.url = `${url}/mcp`;
  const before = w.store.list('agents').length;
  const seenAgents = [];
  w.store.subscribe((e) => { if (e.type === 'upsert' && e.kind === 'agents') seenAgents.push(e.item.id); });

  // A fake CLI that runs the containment commands with /bin/sh inside a simulated sandbox (the hub folder
  // closed, the token variables hidden, the network closed).
  const res = await w.runner.selfTest('fake', { model: 'selftest-sandbox' });
  assert.deepEqual(Object.keys(res).sort(), ['advisory', 'core', 'loaded', 'logTail', 'ok', 'steps']);
  assert.deepEqual(res.steps.map((s) => [s.name, s.ok]), [['binary found', true], ['ready to use', true], ['process started', true], ['MCP connected', true], ['tool call arrived', true], ['clean result', true], ['usage reported', true]]);
  assert.deepEqual(res.core.map((c) => [c.name, c.ok]), [['write outside the turn folder', true], ['read the canary in data/run', true], ['print the agent token', true]], JSON.stringify(res.core));
  assert.deepEqual(res.advisory.map((c) => [c.name, c.ok]), [['reach a host that is not a registry or localhost', true]]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.loaded, ['shop'], 'loaded comes from the init event');
  assert.ok(res.logTail.some((l) => l.includes('shop selftest_ping')));
  assert.equal(fs.existsSync(path.join(w.paths.run, 'selftest')), false, 'the canary, the outside file and their folder are removed');

  // A failed advisory check keeps ok:true.
  w.state.env = { FAKE_NET: 'open' };
  const net = await w.runner.selfTest('fake', { model: 'selftest-sandbox' });
  assert.deepEqual([net.ok, net.advisory[0].ok, net.advisory[0].detail], [true, false, 'the host answered']);
  w.state.env = {};

  // No sandbox at all: every core check fails, so ok is false.
  const open = await w.runner.selfTest('fake', { model: 'selftest-open' });
  assert.deepEqual(open.core.map((c) => [c.name, c.ok, c.detail]), [
    ['write outside the turn folder', false, 'a shell command wrote outside the turn folder'],
    ['read the canary in data/run', false, 'a shell command read the canary'],
    ['print the agent token', false, 'a shell command printed the agent token'],
  ]);
  assert.equal(open.ok, false);
  assert.ok(open.steps.every((s) => s.ok), 'the turn itself was fine');
  const raw = fs.readdirSync(w.paths.logs).filter((f) => f.startsWith('selftest-'));
  assert.deepEqual(raw, [], 'the log of the test agent is removed (it held the leaked token, redacted)');
  assert.ok(res.logTail.every((l) => typeof l === 'string'));
  assert.equal(w.store.list('agents').length, before, 'the temporary agent is removed');
  const tempId = seenAgents.find((id) => id.startsWith('selftest-'));
  assert.ok(tempId);
  assert.equal(fs.existsSync(path.join(w.paths.run, tempId)), false, 'its run folder is removed');
  assert.equal(w.mcp.toolsFor('maker').some((tool) => tool.name === 'selftest_ping'), false, 'the ping tool is not shown to real agents');
  assert.equal(w.built.at(-1).access, 'read');
  assert.match(w.built.at(-1).prompt, /selftest_ping/);
  assert.equal(fs.existsSync(w.built.at(-1).cwd), false, 'the temp folder is removed');

  const again = await w.runner.selfTest('fake', { model: 'normal' }); // an agent that never calls the tool
  assert.equal(again.ok, false);
  assert.deepEqual(again.steps.filter((s) => !s.ok).map((s) => s.name), ['tool call arrived', 'clean result']);
  assert.ok(again.core.every((c) => !c.ok && c.detail === 'the agent did not run this check'), 'a skipped check fails, it never passes by default');

  w.providers.auth.fake = 'none';
  const signedOut = await w.runner.selfTest('fake');
  assert.deepEqual(signedOut.steps.map((s) => [s.name, s.ok]), [['binary found', true], ['ready to use', false]]);
  assert.match(signedOut.steps[1].detail, /not signed in/);
  w.providers.installed.fake = false;
  const missing = await w.runner.selfTest('fake');
  assert.deepEqual(missing.steps.map((s) => [s.name, s.ok]), [['binary found', false]]);
  assert.equal((await w.runner.selfTest('nope')).ok, false);
  assert.equal(w.store.list('agents').length, before);
});

test('the runner works with the real registry and the mock adapter', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-runner-reg-')));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  // resolve() finds nothing: the real claude and agy are out of reach of this test
  const shellEnv = { path: '/usr/bin:/bin', resolve: () => null, base: () => ({ HOME: dir, USER: 'owner', LOGNAME: 'owner', SHELL: '/bin/zsh', TERM: 'dumb', LANG: 'en_US.UTF-8', TMPDIR: `${dir}/`, PATH: '/usr/bin:/bin' }) };
  const settings = { auth: { claude: null, gemini: null }, limits: { maxAgents: 2, perProvider: { mock: 2 } } };
  const providers = createProviders({
    secrets: { list: async () => [], envFor: async () => ({}) }, shellEnv, getSettings: () => settings, updateSettings: () => settings, paths: { run: path.join(dir, 'data', 'run') },
    adapters: { mock: createMockAdapter({ shellEnv, script: FAKE }) }, // the mock adapter shell with a stand-in for mock-agent.mjs
  });
  const store = createStore({ dataDir: path.join(dir, 'data') });
  const mcp = createMcp({ store });
  const runner = createRunner({
    store, providers, mcp, getSettings: () => settings, getMcpUrl: () => 'http://127.0.0.1:1/mcp',
    paths: { server: path.join(ROOT, 'server'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') },
    tuning: { minSpawnGapMs: 0 },
  });
  t.after(async () => { await runner.shutdown(); providers.dispose(); await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  await providers.detect();
  assert.deepEqual(providers.list().map((p) => [p.id, p.usable]), [['claude', false], ['gemini', false], ['oss', false], ['mock', true]]);

  store.put('agents', { id: 'A1', jobId: null, role: 'boss', handle: '@b1', provider: 'mock', model: 'mock', sessionId: null, stats: {} });
  const res = await runner.run('A1', { prompt: 'Plan the job.', systemPrompt: 'Boss card.', cwd: work });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const env = JSON.parse(fs.readFileSync(path.join(work, 'agent.env'), 'utf8'));
  assert.deepEqual([env.MOCK_ROLE, env.MOCK_HANDLE, env.SHOP_MCP_URL, env.SHOP_TOKEN, env.MOCK_SPEED], ['boss', '@b1', 'http://127.0.0.1:1/mcp', env.SHOP_TOKEN, '1']);
  assert.match(env.SHOP_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(mcp.agentFor(env.SHOP_TOKEN), null, 'revoked at the turn end');
  assert.equal(fs.readFileSync(env.MOCK_SYSTEM_FILE, 'utf8'), 'Boss card.\n');
  assert.equal(fs.readFileSync(path.join(work, 'agent.stdin'), 'utf8'), 'Plan the job.');

  store.put('agents', { id: 'C1', jobId: null, role: 'maker', provider: 'claude', model: 'claude-haiku-5-5', sessionId: null, stats: {} });
  const refused = await runner.run('C1', { prompt: 'x', systemPrompt: 'y', cwd: work });
  assert.deepEqual([refused.ok, refused.started, refused.error.kind], [false, false, 'other']);
  assert.match(refused.error.message, /not installed/);

  const self = await providers.selfTest('mock'); // through the hook the runner installs
  assert.deepEqual(self.steps.slice(0, 3).map((s) => [s.name, s.ok]), [['binary found', true], ['ready to use', true], ['process started', true]]);
  assert.equal(self.ok, false, 'the stand-in agent never calls the ping tool');
  assert.equal((await providers.selfTest('claude')).steps[0].ok, false);
});

// ------------------------------------------------------------------------------------------- amended contract

test('redaction: the shared redactor covers a stored key that this turn does not use (subscription mode)', async (t) => {
  const STORED = 'sk-ant-api03-stored-but-unused-0123456789';
  // A stand-in for createRedactor() of server/redact.js (section 14): exact values, [redacted].
  const values = new Set([STORED]);
  const redactor = { redact: (text) => { let out = String(text); for (const v of values) out = out.split(v).join('[redacted]'); return out; } };
  const w = setup(t, { redactor });
  w.agent('A1', { model: 'leak' });
  w.state.env = { FAKE_LEAK: STORED };
  const res = await w.go('A1');
  assert.equal(res.ok, true);
  const raw = fs.readFileSync(path.join(w.paths.logs, 'A1.jsonl'), 'utf8');
  assert.equal(raw.includes(STORED), false, 'raw log');
  assert.ok(raw.includes('[redacted]'));
  const lines = JSON.stringify(w.agentlog);
  assert.equal(lines.includes(STORED), false, 'agentlog events');
  assert.ok(lines.includes('[redacted]'));
  assert.equal(res.text, 'final [redacted]', 'TurnResult.text');
  assert.deepEqual(res.denied, ['Bash cat key [redacted]'], 'denied list');
  assert.equal(JSON.stringify(w.runner.logTail('A1')).includes(STORED), false);

  // Error messages too.
  w.agent('A2', { model: 'crash' });
  w.state.env = {};
  values.add('boom: something broke');
  const crash = await w.go('A2');
  assert.equal(crash.error.message.includes('boom: something broke'), false, crash.error.message);
});

test('cost split: an apikey turn adds to billedUsd, a subscription turn to estUsd; opts.maxBudgetUsd reaches the adapter', async (t) => {
  const w = setup(t, { auth: { other: 'apikey' } });
  w.store.put('jobs', { id: 'J1', title: 'job', cost: { billedUsd: 0, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd: 100 });
  w.agent('S1', { jobId: 'J1' });
  w.agent('K1', { jobId: 'J1', provider: 'other' });
  assert.equal((await w.go('S1')).usd, 0.25);
  assert.equal((await w.go('K1', { maxBudgetUsd: 1.5 })).usd, 0.25);
  assert.deepEqual(w.store.get('jobs', 'J1').cost, { billedUsd: 0.25, estUsd: 0.25, inTok: 2300, outTok: 40 });
  assert.equal(w.built[1].maxBudgetUsd, 1.5);
  for (const dir of [w.paths.data, w.paths.run, w.paths.logs, w.paths.config]) assert.ok(w.built[0].privateDirs.includes(dir), `deny-read list holds ${dir}`);
  assert.equal(w.built[0].maxBudgetUsd, undefined);
  assert.equal(w.built[1].mailHook, true, 'the mail hook passed its provider test: the runner asks the adapter for it');
});

test('budget stop: billedUsd at the budget interrupts the running apikey turns of the job, not the subscription turn', async (t) => {
  const w = setup(t, { auth: { other: 'apikey' } });
  w.store.put('jobs', { id: 'J1', title: 'job', cost: { billedUsd: 0.9, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd: 1 });
  w.store.put('jobs', { id: 'J2', title: 'other job', cost: { billedUsd: 0, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd: 1 });
  w.agent('K1', { jobId: 'J1', provider: 'other', model: 'idle' });
  w.agent('K2', { jobId: 'J1', provider: 'other', model: 'idle' });
  w.agent('S1', { jobId: 'J1', model: 'idle' });
  w.agent('X1', { jobId: 'J2', provider: 'other', model: 'idle' }); // another job: not touched
  w.agent('K3', { jobId: 'J1', provider: 'other' }); // a normal turn: 0.25 billed, over the budget
  const running = ['K1', 'K2', 'S1', 'X1'].map((id) => w.go(id));
  assert.ok(await until(() => ['K1', 'K2', 'S1', 'X1'].every((id) => w.pid(id) > 1)));
  const last = await w.go('K3');
  assert.equal(last.ok, true);
  assert.equal(w.store.get('jobs', 'J1').cost.billedUsd, 1.15);
  const [k1, k2] = await Promise.all(running.slice(0, 2));
  assert.deepEqual([k1.killed, k2.killed], ['interrupt', 'interrupt']);
  assert.equal(k1.sessionId, 'sess-K1', 'the session id comes back so the turn can resume');
  assert.match(k1.error.message, /interrupted.*budget/);
  assert.deepEqual([w.runner.busy('S1'), w.runner.busy('X1')], [true, true], 'the subscription turn and the other job run on');
  for (const id of ['S1', 'X1']) w.runner.cancel(id, 'test end');
  await Promise.all(running.slice(2));
});

test('interrupt: SIGINT through the adapter stop signal, killed "interrupt", the session id is returned', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'idle' });
  const p = w.go('A1');
  assert.ok(await until(() => w.pid('A1') > 1));
  await sleep(50);
  assert.equal(w.runner.interrupt('A1'), true);
  const res = await p;
  assert.deepEqual([res.ok, res.killed, res.sessionId], [false, 'interrupt', 'sess-A1']);
  assert.ok(await gone(w.pid('A1')));
  assert.equal(w.runner.interrupt('A1'), false, 'nothing left to interrupt');
});

test('idle watchdog: it waits while a tool runs, and still stops a silent agent with no open tool', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'longtool' });
  const long = await w.go('A1', { idleMs: 1000, timeoutMs: 60_000, effort: '2400' }); // silent for 2.4 x idleMs inside a tool
  assert.deepEqual([long.ok, long.killed, long.text], [true, null, 'long tool done']);
  w.agent('A2', { model: 'idle' });
  const idle = await w.go('A2', { idleMs: 1000, timeoutMs: 60_000 });
  assert.deepEqual([idle.ok, idle.killed], [false, 'idle']);
});

test('watchdogs on shop time: a clock jump of 2 h between two checks kills nothing', async (t) => {
  let offset = 0;
  const w = setup(t, { now: () => Date.now() + offset });
  w.agent('A1', { model: 'slow' });
  const p = w.go('A1', { effort: '1500', timeoutMs: 3000, idleMs: 3000 });
  assert.ok(await until(() => w.pid('A1') > 1));
  await sleep(200);
  offset += 2 * 3600_000; // the Mac slept for two hours
  const res = await p;
  assert.deepEqual([res.ok, res.killed], [true, null], JSON.stringify(res.error));
  assert.ok(w.runner.logTail('A1').some((l) => /the clock jumped 7\d{3} s/.test(l.s)));
  // A real wall-clock overrun is still stopped.
  w.agent('A2', { model: 'idle' });
  const wall = await w.go('A2', { timeoutMs: 600, idleMs: 60_000 });
  assert.equal(wall.killed, 'timeout');
});

test('rate limit of one model: cool gets { model, turnStartedAt }; a good turn calls noteSuccess; a cooled model does not start', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'modelrl' });
  const res = await w.go('A1');
  assert.deepEqual([res.ok, res.error.kind, res.error.model], [false, 'rate_limit', 'fake-big']);
  assert.equal(w.providers.cooled.length, 1);
  assert.deepEqual(w.providers.cooled[0].opts, { model: 'fake-big', turnStartedAt: res.startedAt });
  assert.equal(w.providers.cooling.fake, undefined, 'the lab itself does not cool');
  w.agent('A2');
  const ok = await w.go('A2');
  assert.equal(ok.ok, true);
  assert.deepEqual(w.providers.successes, [{ id: 'fake', model: 'normal' }]);
  w.agent('A3', { model: 'fake-big' });
  const held = await w.go('A3');
  assert.deepEqual([held.started, held.error.kind, held.error.model], [false, 'rate_limit', 'fake-big'], 'modelUsable false: no spawn');
  w.agent('A4', { model: 'modelerror' });
  const refused = await w.go('A4');
  assert.deepEqual([refused.error.kind, refused.error.model], ['model', 'modelerror'], 'error kind model names the model of the turn');
});

test('opts.taskId: cost goes to that task; only a work turn moves progress; kind is logged', async (t) => {
  const w = setup(t);
  w.store.put('jobs', { id: 'J1', title: 'job', cost: { billedUsd: 0, estUsd: 0, inTok: 0, outTok: 0 } });
  w.store.put('tasks', { id: 'T1', jobId: 'J1', progress: 0, cost: { usd: 0 } });
  w.store.put('tasks', { id: 'T2', jobId: 'J1', progress: 0, cost: { usd: 0 } });
  w.agent('B1', { jobId: 'J1', role: 'boss', taskId: 'T1' });
  const review = await w.go('B1', { kind: 'review', taskId: 'T2' });
  assert.equal(review.ok, true);
  assert.deepEqual([w.store.get('tasks', 'T2').cost.usd, w.store.get('tasks', 'T2').progress], [0.25, 0], 'a review pays into T2 and leaves progress alone');
  assert.equal(w.store.get('tasks', 'T1').cost.usd, 0, 'agent.taskId is not used');
  w.agent('M1', { jobId: 'J1', taskId: null });
  await w.go('M1', { kind: 'work', taskId: 'T1' });
  assert.ok(w.store.get('tasks', 'T1').progress > 0, 'a work turn moves progress');
  const raw = fs.readFileSync(path.join(w.paths.logs, 'B1.jsonl'), 'utf8').split('\n')[0];
  assert.equal(JSON.parse(raw).kind, 'review');
});

test('self-test gate: the self-test turn runs when every other condition holds (providers.ready), other turns need usable', async (t) => {
  const w = setup(t);
  const http = createHttp({ ownerKey: 'test-owner-key-0123456789', log: () => {} });
  mountMcp(http, w.mcp);
  const { url } = await http.listen();
  t.after(() => http.close());
  w.state.url = `${url}/mcp`;
  // usable() is false only because no self-test pass is stored yet.
  w.providers.usable = () => false;
  w.providers.ready = () => ({ ok: true, reason: null });
  const first = await w.runner.selfTest('fake', { model: 'selftest-sandbox' });
  assert.equal(first.steps.find((s) => s.name === 'process started').ok, true, 'the first self-test on a fresh lab starts a turn');
  assert.equal(first.ok, true);
  w.agent('A1');
  const work = await w.go('A1');
  assert.deepEqual([work.started, work.ok], [false, false], 'a normal turn still needs usable()');
  w.providers.ready = () => ({ ok: false, reason: 'Confirm the sign-in mode for this lab (read the note first).' });
  const notReady = await w.runner.selfTest('fake', { model: 'selftest-sandbox' });
  assert.deepEqual(notReady.steps.map((s) => [s.name, s.ok]), [['binary found', true], ['ready to use', false]]);
  assert.match(notReady.steps[1].detail, /Confirm the sign-in mode/);
  assert.deepEqual([notReady.core, notReady.ok], [[], false]);
});

test('agy-style self-test: a planted hooks.json does not run, and git push shows as denied', async (t) => {
  const w = setup(t, { adapterExtra: { cleanAgentDir: true } });
  const http = createHttp({ ownerKey: 'test-owner-key-0123456789', log: () => {} });
  mountMcp(http, w.mcp);
  const { url } = await http.listen();
  t.after(() => http.close());
  w.state.url = `${url}/mcp`;
  const res = await w.runner.selfTest('fake', { model: 'selftest-sandbox' });
  assert.deepEqual(res.advisory.map((c) => [c.name, c.ok]), [
    ['reach a host that is not a registry or localhost', true], ['a planted .agents/hooks.json', true], ['git push shows in denied_actions', true],
  ]);
  assert.ok(res.core.every((c) => c.ok), JSON.stringify(res.core));
  assert.match(w.built.at(-1).prompt, /cat '.*\/mcp-url'/, 'for agy the token check also reads the URL file');
});

test('logTail after a hub restart: a new runner rebuilds the tail from data/logs/<agent>.jsonl (redacted lines)', async (t) => {
  const w = setup(t);
  w.agent('A1');
  assert.equal((await w.go('A1')).ok, true);
  const live = w.runner.logTail('A1');
  assert.ok(live.length >= 3, 'the live tail has lines');
  // A second runner on the same folders has an empty memory, as after a restart.
  const again = createRunner({
    store: w.store, providers: w.providers, mcp: w.mcp, paths: w.paths, getSettings: () => w.settings, getMcpUrl: () => w.state.url,
    tuning: { minSpawnGapMs: 0 },
  });
  t.after(() => again.shutdown());
  assert.deepEqual(again.logTail('A1'), live);
  assert.deepEqual(again.logTail('A1', 2), live.slice(-2));
  assert.deepEqual(again.logTail('NOBODY'), []);
});
