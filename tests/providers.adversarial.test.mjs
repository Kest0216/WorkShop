// Adversarial tests for the provider and runner layer: process leaks, hostile output, wrong cost, leaked secrets.
// Each test names the defect it guards against. No real agent CLI runs here: the agents are small Node and shell
// scripts in tests/fixtures and in temp folders. agy is always a fake binary under the temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../server/runner.js';
import { createStore } from '../server/store.js';
import { createMcp, mountMcp } from '../server/mcp.js';
import { createHttp } from '../server/http.js';
import { createProviders, runCommand } from '../server/providers/index.js';
import { createParser as createMockParser } from '../server/providers/mock.js';
import { createParser as createClaudeParser, createClaudeAdapter } from '../server/providers/claude.js';
import { createParser as createGeminiParser, createGeminiAdapter } from '../server/providers/gemini.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const AGENT = path.join(HERE, 'fixtures', 'adversarial-agent.mjs');
const FAKE = path.join(HERE, 'fixtures', 'fake-agent.mjs');
const HUB = path.join(HERE, 'fixtures', 'hub-exit.mjs');
const FIX = path.join(HERE, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 8000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(25);
  return !alive(pid);
}
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
/** Cleanup only (the assertions ran before): kill every process that wrote a pid file into this folder. */
function killLeftovers(folder) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch { /* no such folder */ }
  for (const name of names.filter((n) => n.endsWith('.pid'))) {
    const pid = Number(fs.readFileSync(path.join(folder, name), 'utf8'));
    try { if (pid > 1) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/**
 * A runner with fake labs. The model of an agent is the mode of tests/fixtures/adversarial-agent.mjs and the
 * effort is its argument. Labs: 'fake' (NormEvent lines), 'fakeclaude' and 'fakegemini' (the real parsers of the
 * adapters; an agent with `replay` prints that recorded stream), 'selfie' (tests/fixtures/fake-agent.mjs).
 */
function setup(t, { limits = {}, tuning = {}, priceFor, keys = {}, keyDelays = [], extraFiles, hubFiles, parser, mcpUrl = 'http://127.0.0.1:1/mcp' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adv-')));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const paths = { server: path.join(ROOT, 'server'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') };
  const store = createStore({ dataDir: path.join(dir, 'data') });
  const mcp = createMcp({ store });
  const settings = { limits: { maxAgents: 6, turnTimeoutMin: 45, idleTimeoutMin: 12, ...limits }, auth: { fake: 'subscription', fakeclaude: 'subscription', fakegemini: 'subscription', selfie: 'subscription', solo: 'subscription' }, safety: 'sandboxed' };
  const built = [];
  const agentlog = [];
  store.subscribe((e) => { if (e.type === 'agentlog') agentlog.push(e); });
  const state = { url: mcpUrl };
  const noExec = path.join(dir, 'not-executable');
  fs.writeFileSync(noExec, '#!/bin/sh\necho hi\n', { mode: 0o644 });
  const makeAdapter = (id, makeParser) => ({
    id, label: id, selfTestModel: id === 'selfie' ? 'selftest-sandbox' : 'selftest',
    buildRun(o) {
      built.push({ ...o, at: Date.now() });
      const replay = o.agent.replay;
      const script = id === 'selfie' ? FAKE : AGENT;
      return {
        cmd: o.model === 'eacces' ? noExec : process.execPath,
        args: replay ? [AGENT, 'replay', work, o.agent.id, replay] : [script, o.model, work, o.agent.id, String(o.effort ?? '')],
        env: { PATH: '/usr/bin:/bin', FAKE_MCP_URL: o.mcp.url, FAKE_MCP_TOKEN: o.mcp.token, FAKE_SECRET: o.keyEnv?.FAKE_KEY ?? '', FAKE_DENY: [path.join(paths.run, 'selftest'), o.runDir].join(':') },
        cwd: o.cwd, stdin: o.prompt, stopSignal: 'SIGINT',
        files: [{ path: path.join(o.runDir, 'role.txt'), content: o.systemPrompt }, ...(extraFiles?.(o) ?? [])],
        hubFiles: hubFiles?.(o) ?? {},
      };
    },
    createParser: () => (parser ? parser() : makeParser()),
  });
  const adapters = {
    fake: makeAdapter('fake', createMockParser), fakeclaude: makeAdapter('fakeclaude', createClaudeParser),
    fakegemini: makeAdapter('fakegemini', createGeminiParser), selfie: makeAdapter('selfie', createMockParser),
    solo: { ...makeAdapter('solo', createMockParser), exclusiveCwd: true }, // like agy: one turn per folder at a time
  };
  let keyCalls = 0;
  const providers = {
    cooled: [], marked: [], limits: [], cooling: {}, auth: {},
    get(id) { if (!adapters[id]) throw new Error(`Unknown provider: ${id}`); return adapters[id]; },
    status(id) {
      const cooling = this.cooling[id] ?? null;
      const auth = this.auth[id] ?? 'ok';
      const reason = cooling ? `Paused: ${cooling.reason}` : auth !== 'ok' ? `${id} is not signed in.` : null;
      return { id, installed: true, path: process.execPath, mode: 'subscription', auth, cooling, usable: reason === null, reason };
    },
    usable(id) { return this.status(id).usable; },
    async detect() { return []; },
    async keyEnv() { const wait = keyDelays[keyCalls++] ?? 0; if (wait > 0) await sleep(wait); return { ...keys }; },
    cool(id, untilTs, reason) { this.cooled.push({ id, until: untilTs, reason }); this.cooling[id] = { until: untilTs, reason }; },
    markAuth(id, value) { this.marked.push({ id, value }); this.auth[id] = value; },
    noteLimit(id, info) { this.limits.push({ id, status: info.status, type: info.type, utilization: info.utilization, resetAt: info.resetAt }); },
  };
  const logs = [];
  const runner = createRunner({
    store, providers, mcp, paths, getSettings: () => settings, getMcpUrl: () => state.url, priceFor,
    log: (level, msg, data) => logs.push({ level, msg, data }),
    tuning: { minSpawnGapMs: 0, killGraceMs: 250, shutdownGraceMs: 200, closeWaitMs: 300, logFlushMs: 50, progressEveryMs: 0, treeScanMs: 150, toolScanMs: 50, ...tuning },
  });
  t.after(async () => {
    await runner.shutdown();
    await store.flush();
    killLeftovers(work); // a failed leak test must not leave its processes on this Mac
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const agent = (id, extra = {}) => store.put('agents', { id, jobId: null, name: id, handle: `@${id}`, role: 'maker', provider: 'fake', model: 'noread', status: 'idle', taskId: null, sessionId: null, stats: { turns: 0, inTok: 0, outTok: 0, usd: 0 }, ...extra });
  const go = (id, opts = {}) => runner.run(id, { prompt: 'Do the task.', systemPrompt: 'Role card.', cwd: work, ...opts });
  const read = (name) => { try { return fs.readFileSync(path.join(work, name), 'utf8'); } catch { return null; } };
  const pid = (tag, suffix = 'pid') => Number(read(`${tag}.${suffix}`));
  const rawLog = (id) => { try { return fs.readFileSync(path.join(paths.logs, `${id}.jsonl`), 'utf8'); } catch { return ''; } };
  return { dir, work, paths, store, mcp, settings, providers, runner, built, agentlog, logs, agent, go, read, pid, rawLog, state, noExec };
}

// ------------------------------------------------------------------------------------------- process leaks

test('SIGKILL also reaches a child outside the process group of the agent (the shell commands of Claude Code are such children)', async (t) => {
  // Proved with the real CLI 2.1.289: Claude Code starts every Bash command as the leader of its own session and
  // process group. A signal to the group of the CLI does not reach it. An agent that ignores SIGINT and SIGTERM
  // gets SIGKILL, and then its running shell command must die with it.
  const w = setup(t);
  w.agent('A1', { model: 'detached-stubborn' });
  const turn = w.go('A1');
  assert.ok(await until(() => w.pid('A1') > 1 && w.pid('A1', 'child.pid') > 1), 'the agent and its child wrote their pids');
  const [agentPid, childPid] = [w.pid('A1'), w.pid('A1', 'child.pid')];
  assert.ok(agentPid > 1 && childPid > 1 && alive(agentPid) && alive(childPid));
  w.runner.cancel('A1', 'stop it');
  const res = await turn;
  assert.equal(res.killed, 'cancel');
  assert.ok(await gone(agentPid), 'the agent is gone');
  assert.ok(await gone(childPid), 'its child in another process group and session is gone too');
});

test('an agent that dies by itself, or ends well, leaves no detached child behind', async (t) => {
  const w = setup(t);
  w.agent('CRASH', { model: 'detached-crash' });
  const crash = await w.go('CRASH', { effort: '1500' });
  assert.deepEqual([crash.ok, crash.killed, crash.error.kind], [false, null, 'other']);
  assert.match(crash.error.message, /exit code 3/);
  const orphan = w.pid('CRASH', 'child.pid');
  assert.ok(orphan > 1);
  assert.ok(await gone(orphan), 'the child of the crashed agent is killed when the turn ends');

  w.agent('GOOD', { model: 'detached-ok' });
  const good = await w.go('GOOD', { effort: '1500' });
  assert.deepEqual([good.ok, good.text], [true, 'done, with a background process left behind']);
  assert.ok(await gone(w.pid('GOOD', 'child.pid')), 'a background process does not outlive its turn');
  assert.ok(w.logs.some((l) => /left behind/.test(l.msg)), 'the hub log says that it killed leftovers');
});

test('shutdown() kills detached children too', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'detached-stubborn' });
  const turn = w.go('A1');
  assert.ok(await until(() => w.pid('A1') > 1 && w.pid('A1', 'child.pid') > 1), 'the agent and its child wrote their pids');
  const pids = [w.pid('A1'), w.pid('A1', 'child.pid')];
  await w.runner.shutdown();
  for (const p of pids) assert.ok(await gone(p), `pid ${p} must be gone after shutdown()`);
  assert.equal((await turn).killed, 'shutdown');
});

/** Run tests/fixtures/hub-exit.mjs: a hub with one stubborn agent turn that ends in the given way. */
async function hubThatEnds(t, how) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adv-hub-')));
  const hub = spawn(process.execPath, [HUB, how, dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: process.env.TMPDIR ?? '' } });
  let out = '';
  hub.stdout.on('data', (d) => { out += d; });
  hub.stderr.resume();
  const exit = new Promise((resolve) => hub.on('exit', (code, signal) => resolve({ code, signal })));
  const pidOf = (name) => { try { return Number(fs.readFileSync(path.join(dir, 'work', name), 'utf8')); } catch { return 0; } };
  t.after(() => {
    try { process.kill(hub.pid, 'SIGKILL'); } catch { /* gone */ }
    killLeftovers(path.join(dir, 'work'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (how === 'sigterm') {
    assert.ok(await until(() => out.includes('READY'), 30_000), 'the hub started its turn');
    hub.kill('SIGTERM');
  }
  let timer;
  const ended = await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 60_000); })]);
  clearTimeout(timer);
  assert.ok(ended, 'the hub process ended');
  const pids = [pidOf('H1.pid'), pidOf('H1.child.pid')];
  assert.ok(pids.every((p) => p > 1), 'the agent and its detached child ran');
  for (const p of pids) assert.ok(await gone(p), `${how}: pid ${p} must not outlive the hub`);
  return ended;
}

test('a hub that ends without shutdown() (process.exit, an uncaught error) leaves no agent process', async (t) => {
  assert.equal((await hubThatEnds(t, 'exit')).code, 0);
  assert.notEqual((await hubThatEnds(t, 'throw')).code, 0);
});

test('a hub that gets SIGTERM and calls shutdown() leaves no agent process', async (t) => {
  assert.equal((await hubThatEnds(t, 'sigterm')).code, 0);
});

test('a result line followed by a hang: the turn ends with its result, and the process is stopped', async (t) => {
  // A CLI can stay alive after its result (background work, a helper that does not exit). Without a limit the
  // turn would end only at the idle timeout, and a finished turn would be reported as killed.
  const w = setup(t, { tuning: { resultGraceMs: 300 } });
  w.agent('A1', { model: 'result-hang' });
  const t0 = Date.now();
  const res = await w.go('A1', { idleMs: 30_000, timeoutMs: 120_000 });
  assert.deepEqual([res.ok, res.text, res.killed, res.error], [true, 'finished', null, null]);
  assert.ok(Date.now() - t0 < 20_000, `the turn ended ${Date.now() - t0} ms after its start, long before the idle limit of 30 s`);
  assert.ok(await gone(w.pid('A1')), 'the hanging process is gone');
  assert.equal(w.store.get('agents', 'A1').stats.turns, 1);

  // Claude Code answers SIGINT with one more result line ("interrupted"). That line must not turn the finished
  // turn into a failed one, and must not replace its token counts.
  w.agent('A2', { model: 'result-hang-abort' });
  const again = await w.go('A2', { idleMs: 30_000, timeoutMs: 120_000 });
  assert.deepEqual([again.ok, again.text, again.killed, again.error], [true, 'finished', null, null]);
  assert.deepEqual(again.usage, { inTok: 10, outTok: 5, cacheRead: 0, cacheWrite: 0, ctxTok: 0 });
  assert.ok(w.rawLog('A2').split('\n').filter((l) => l.includes('"t":"result"')).length === 2, 'the second result line was printed and ignored');
});

// ------------------------------------------------------------------------------------------- hostile output

test('a line that arrives in pieces, cut inside a multi-byte character, is read as one line', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'split' });
  const res = await w.go('A1');
  assert.deepEqual([res.ok, res.text], [true, 'Grüße, 世界 ✓ done']);
});

test('a line of 2 MB is read; a line over the limit is dropped as a whole', async (t) => {
  const w = setup(t);
  w.agent('BIG', { model: 'bigline' });
  const big = await w.go('BIG', { effort: '2000000' });
  assert.equal(big.ok, true, 'the 2 MB line was read as one line and parsed');
  assert.equal(big.text, 'y'.repeat(100_000), 'the parser of the mock lab keeps the first 100,000 characters of a result');
  assert.ok(w.runner.logTail('BIG').every((l) => l.s.length <= 600), 'the agent log keeps short lines only');

  // The limit is 1000 characters here. The agent prints 1500 characters without a line end, then (as the rest of
  // the same line) something that looks like a tool call. That tail must not be read as a line of its own.
  const s = setup(t, { tuning: { maxLineBytes: 1000 } });
  s.agent('DROP', { model: 'dropline' });
  const drop = await s.go('DROP', { effort: '1500' });
  assert.deepEqual([drop.ok, drop.text], [true, 'the real result']);
  assert.deepEqual(drop.calls, [], 'the tail of a dropped line is not a tool call');
  assert.equal(s.runner.logTail('DROP').filter((l) => /very long output line was dropped/.test(l.s)).length, 1);
});

test('binary noise and cut JSON between good lines do not stop the stream', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'garbage' });
  const res = await w.go('A1');
  assert.deepEqual([res.ok, res.text], [true, 'survived the garbage']);
  assert.ok(!w.logs.some((l) => l.level === 'error'), JSON.stringify(w.logs.filter((l) => l.level === 'error')));
});

test('an agent that prints 200 MB: the log file and the memory of the hub stay bounded', { timeout: 600_000 }, async (t) => {
  const cap = 4 * 1024 * 1024;
  const w = setup(t, { tuning: { rawLogMaxBytes: cap } });
  w.agent('A1', { model: 'flood' });
  const base = process.memoryUsage().rss;
  let peak = base;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const res = await w.go('A1', { effort: '200', timeoutMs: 500_000, idleMs: 120_000 });
  clearInterval(sampler);
  assert.deepEqual([res.ok, res.text], [true, 'flood done'], JSON.stringify(res.error));
  await sleep(200); // the log stream closes
  const size = fs.statSync(path.join(w.paths.logs, 'A1.jsonl')).size;
  assert.ok(size <= cap + 256 * 1024, `the log of one turn is limited: ${size} bytes`);
  assert.ok(w.rawLog('A1').includes('workshop_log_capped'), 'the log says that it was cut');
  assert.ok(w.rawLog('A1').trim().split('\n').at(-1).includes('workshop_turn_end'), 'the end of the turn is still written');
  assert.ok(peak - base < 600 * 1024 * 1024, `memory grew by ${Math.round((peak - base) / 1048576)} MB`);
  assert.equal(w.runner.logTail('A1').length, 200);
  const events = w.agentlog.filter((e) => e.agentId === 'A1');
  assert.ok(events.every((e) => e.lines.length <= 41), 'agent log events stay small');
});

test('a parser that throws does not break the turn or the hub', async (t) => {
  const w = setup(t, { parser: () => ({ push() { throw new Error('parser bug'); }, end() { throw new Error('parser bug at the end'); } }) });
  w.agent('A1', { model: 'noread' });
  const res = await w.go('A1');
  assert.deepEqual([res.ok, res.started, res.error.kind], [false, true, 'other']);
  assert.match(res.error.message, /without a result/);
  assert.ok(w.logs.some((l) => l.level === 'error' && /parser/.test(l.msg)));
});

test('the parsers never throw on cut lines and binary garbage', () => {
  const lines = [];
  for (const file of ['claude/claude-worker-turn1.real.jsonl', 'claude/claude-stream-worker-recommended.jsonl', 'claude/claude-stream-not-logged-in.jsonl', 'gemini/agy-worker-turn1.real.jsonl', 'gemini/agy-worker-turn2.real.jsonl']) {
    lines.push(...fs.readFileSync(path.join(FIX, file), 'utf8').split('\n').filter(Boolean));
  }
  let seed = 12345;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const hostile = [];
  for (const line of lines) {
    hostile.push(line.slice(0, rand(line.length)), line.slice(rand(line.length)), `${line}${line}`, line.replace(/"/g, ''), line.replace(/[{}]/g, (c) => (rand(4) === 0 ? '' : c)));
    const bytes = Buffer.from(line);
    for (let i = 0; i < 8; i++) bytes[rand(bytes.length)] = rand(256);
    hostile.push(bytes.toString('utf8'), bytes.toString('latin1'));
  }
  hostile.push('\u0000\u0001\u0002', '{"type":"result","usage":"x","modelUsage":[1],"permission_denials":{"a":1},"errors":"e"}', '{"type":"assistant","message":{"id":7,"usage":"u","content":[{"type":"tool_use","id":{},"name":[],"input":"x"}]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":{},"resetsAt":"x","unifiedWindows":"y","rateLimitType":"z"}}', '{"type":"system","subtype":"init","mcp_servers":"none","mcp_server_errors":{}}',
    '{"event":"step_update","step_update":{"state":"DONE","step_type":"tool","tool_info":{"parameters":"p","error":{"message":{}}},"usage":[]}}', '{"event":"result","result":{"status":"SUCCESS","usage":{"input_tokens":"many"},"denied_actions":[null,[1],{"parameters":7}]}}',
    '{"event":"init","init":{"mcp_servers":[null,7,{"status":5}],"model":5}}', `{"t":"text","text":${'['.repeat(2000)}`);
  for (const make of [createClaudeParser, createGeminiParser, createMockParser]) {
    const parser = make();
    for (const line of hostile) {
      const events = parser.push(line);
      assert.ok(Array.isArray(events));
      for (const e of events) assert.equal(typeof e.t, 'string');
    }
    for (const info of [undefined, {}, { code: 'x', signal: 5, stderrTail: Buffer.from([0, 255]) }, { code: 1, signal: null, stderrTail: '\u0000'.repeat(9000) }]) {
      const events = make().end(info);
      assert.ok(Array.isArray(events) && events.at(-1).t === 'result' && events.at(-1).ok === false);
    }
    assert.ok(Array.isArray(parser.end({ code: 0 })));
  }
});

// ------------------------------------------------------------------------------------------- start and queue

test('start problems: no permission to execute, a work folder that is a file, a prompt that is never read', async (t) => {
  const w = setup(t);
  w.agent('X1', { model: 'eacces' });
  const denied = await w.go('X1');
  assert.deepEqual([denied.ok, denied.started], [false, false]);
  assert.match(denied.error.message, /Cannot start not-executable: EACCES/);
  w.agent('X2');
  const file = await w.go('X2', { cwd: w.noExec });
  assert.deepEqual([file.ok, file.started], [false, false]);
  assert.match(file.error.message, /work folder is not a folder/);
  const missing = await w.go('X2', { cwd: path.join(w.dir, 'nope') });
  assert.match(missing.error.message, /work folder does not exist/);
  // 3 MB on stdin of an agent that never reads it: no error, no hang
  const big = await w.go('X2', { prompt: 'p'.repeat(3_000_000) });
  assert.deepEqual([big.ok, big.text], [true, 'did not read stdin']);
  assert.deepEqual([w.runner.active(), w.runner.queued()], [[], []]);
});

test('time limits that a timer cannot hold do not end the turn at once', async (t) => {
  // setTimeout fires after 1 ms when its delay is over 2^31-1 ms (about 24.8 days).
  const w = setup(t, { limits: { turnTimeoutMin: 60_000, idleTimeoutMin: 60_000 } });
  w.agent('A1', { model: 'noread' });
  const bySettings = await w.go('A1');
  assert.deepEqual([bySettings.ok, bySettings.killed], [true, null]);
  const byOption = await w.go('A1', { timeoutMs: 2 ** 40, idleMs: 2 ** 40 });
  assert.deepEqual([byOption.ok, byOption.killed], [true, null]);
});

test('two run() calls for one agent: the second is refused and the first is not disturbed', async (t) => {
  const w = setup(t);
  w.agent('A1', { model: 'detached-ok' });
  const first = w.go('A1', { effort: '400' });
  const second = await w.go('A1');
  assert.deepEqual([second.ok, second.started, second.killed], [false, false, null]);
  assert.match(second.error.message, /already runs a turn/);
  assert.equal(w.runner.busy('A1'), true);
  const res = await first;
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(w.built.length, 1, 'only one process was built');
  assert.equal(w.store.get('agents', 'A1').stats.turns, 1);
  assert.equal(w.runner.busy('A1'), false);
});

test('cancel while the turn waits in the queue, and while it is prepared (slow key lookup): no process starts', async (t) => {
  const w = setup(t, { limits: { maxAgents: 1 }, keyDelays: [1500] });
  w.agent('SLOW');
  w.agent('WAIT');
  const slow = w.go('SLOW'); // leaves the queue at once, then waits 1.5 s for its key
  const waiting = w.go('WAIT');
  await sleep(100);
  assert.deepEqual([w.runner.active(), w.runner.queued()], [['SLOW'], ['WAIT']]);
  assert.equal(w.runner.cancel('WAIT', 'not needed'), true);
  assert.equal(w.runner.cancel('SLOW', 'changed my mind'), true);
  const [a, b] = await Promise.all([slow, waiting]);
  assert.deepEqual([a.ok, a.killed, a.started], [false, 'cancel', false]);
  assert.deepEqual([b.ok, b.killed, b.started], [false, 'cancel', false]);
  assert.match(a.error.message, /cancelled/);
  assert.equal(w.built.length, 0, 'no command was built');
  assert.equal(w.read('SLOW.pid'), null);
  assert.deepEqual([w.runner.active(), w.runner.queued()], [[], []]);
  assert.equal((await w.go('WAIT')).ok, true, 'the runner still works');
});

test('spawn spacing counts from the real spawn, also when a key lookup is slow', async (t) => {
  // The first turn waits 500 ms for its key. The gap of 400 ms must lie between the two spawns, not between the
  // moments the turns left the queue.
  const w = setup(t, { tuning: { minSpawnGapMs: 400 }, keyDelays: [500, 0] });
  w.agent('A1');
  w.agent('A2');
  const all = await Promise.all([w.go('A1'), w.go('A2')]);
  assert.ok(all.every((r) => r.ok));
  assert.deepEqual(w.built.map((b) => b.agent.id), ['A1', 'A2'], 'first come, first spawned');
  assert.ok(w.built[1].at - w.built[0].at >= 380, `gap between the spawns: ${w.built[1].at - w.built[0].at} ms`);
});

// ------------------------------------------------------------------------------------------- secrets and files

test('an API key and the MCP token never reach the log file, the agent log events or the turn result', async (t) => {
  const secret = 'sk-test-SECRET-0123456789abcdefXYZ';
  const w = setup(t, { keys: { FAKE_KEY: secret } });
  w.agent('A1', { model: 'leak' });
  const res = await w.go('A1');
  const token = w.built[0].mcp.token;
  assert.equal(w.mcp.agentFor(token), null, 'revoked at the turn end');
  assert.equal(res.ok, false);
  await sleep(200); // the log stream closes
  const places = {
    'turn result': JSON.stringify(res),
    'log file': w.rawLog('A1'),
    'agent log events': JSON.stringify(w.agentlog),
    'log tail': JSON.stringify(w.runner.logTail('A1')),
    'hub log': JSON.stringify(w.logs),
    'pause reason': JSON.stringify(w.providers.cooled),
  };
  for (const [name, text] of Object.entries(places)) {
    assert.ok(!text.includes(secret), `the API key is in the ${name}`);
    assert.ok(!text.includes(token), `the MCP token is in the ${name}`);
  }
  assert.equal(res.text, 'final text with [redacted] and [redacted]');
  assert.equal(res.error.message, 'failed with [redacted]');
  assert.deepEqual(res.denied, ['Bash curl -H "x-api-key: [redacted]" https://example.com']);
  assert.ok(w.rawLog('A1').includes('plain line with [redacted] and [redacted]'), 'the line is kept, without the values');
  assert.ok(w.rawLog('A1').includes('stderr with [redacted] and [redacted]'));
});

test('adapter files are never written through a symbolic link that sits in the work folder', async (t) => {
  // An agent controls its bench. A link `.agents -> <a folder of the owner>` in the bench must not make the hub
  // write there when the next agent (for example a reviewer of the other lab) starts in the same bench. Bench files
  // are hubFiles (git.writeHubFiles in the app; here the runner's own writer, used without a git module).
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adv-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'profile'), 'export A=1\n');
  const w = setup(t, {
    hubFiles: (o) => (o.agent.id === 'RUNLINK' ? {} : { '.agents/mcp_config.json': o.agent.id === 'LINKDIR' ? '{"token":"t"}' : '{"ok":true}' }),
    extraFiles: (o) => (o.agent.id === 'RUNLINK' ? [{ path: path.join(o.runDir, 'sub', 'x.json'), content: 'x' }] : []),
  });
  fs.symlinkSync(outside, path.join(w.work, '.agents'));
  w.agent('LINKDIR');
  const dirRes = await w.go('LINKDIR');
  assert.deepEqual([dirRes.ok, dirRes.started], [false, false]);
  assert.match(dirRes.error.message, /symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), ['profile'], 'nothing was written outside the bench');

  // A link inside the run folder is refused too.
  fs.mkdirSync(path.join(w.paths.run, 'RUNLINK'), { recursive: true });
  fs.symlinkSync(outside, path.join(w.paths.run, 'RUNLINK', 'sub'));
  w.agent('RUNLINK');
  const runRes = await w.go('RUNLINK');
  assert.equal(runRes.started, false);
  assert.match(runRes.error.message, /symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), ['profile']);

  fs.rmSync(path.join(w.work, '.agents'));
  w.agent('PLAIN');
  assert.equal((await w.go('PLAIN')).ok, true, 'a plain folder still works');
  assert.equal(fs.readFileSync(path.join(w.work, '.agents', 'mcp_config.json'), 'utf8'), '{"ok":true}');
  assert.equal(fs.existsSync(path.join(w.work, '.git')), false, 'the runner never touches .git/info/exclude (gitops owns it)');
});

// ------------------------------------------------------------------------------------------- cost and usage

test('cost: token counts and registry prices come first; the CLI number only when no price is known', async (t) => {
  const w = setup(t);
  fs.mkdirSync(w.paths.config, { recursive: true });
  fs.writeFileSync(path.join(w.paths.config, 'models.json'), JSON.stringify({ models: [
    { id: 'claude-haiku-5-5', price: { in: 0.1, out: 0.5 } },
    { id: 'gemini-4-hydrogen', price: { in: 1.5, out: 7.5 } },
    { id: 'gemini-4-argon', price: { in: 2, out: 10, next: { from: '2020-01-01', in: 4, out: 20 } } },
    { id: 'gemini-4-carbon', price: { in: 2, out: 10, next: { from: '2999-01-01', in: 4, out: 20 } } },
    { id: 'gemini-3.8-flash', price: { in: 0.75, out: 3.75 } },
  ] }));
  const claude1 = path.join(FIX, 'claude', 'claude-worker-turn1.real.jsonl');
  const agy1 = path.join(FIX, 'gemini', 'agy-worker-turn1.real.jsonl');
  const agy2 = path.join(FIX, 'gemini', 'agy-worker-turn2.real.jsonl');

  // Claude Code 2.1.289 does not know claude-haiku-5-5: its own number for this real turn is $0.109.
  // Real cost: 4 input + 12549 one-hour cache writes (2x) + 11935 cache reads (0.1x) + 334 output tokens.
  w.agent('C1', { provider: 'fakeclaude', model: 'claude-haiku-5-5', replay: claude1, stats: { turns: 4, inTok: 1, outTok: 1, usd: 1, ctxMax: 123, note: 'kept' } });
  const c1 = await w.go('C1');
  assert.equal(c1.ok, true, JSON.stringify(c1.error));
  assert.deepEqual(c1.usage, { inTok: 4, outTok: 334, cacheRead: 11935, cacheWrite: 12549, ctxTok: 2 + 614 + 11935 });
  assert.ok(near(c1.usd, (4 * 0.1 + 12549 * 0.1 * 2 + 11935 * 0.1 * 0.1 + 334 * 0.5) / 1e6), `usd ${c1.usd}`);
  const stats = w.store.get('agents', 'C1').stats;
  assert.deepEqual([stats.turns, stats.note], [5, 'kept'], 'fields of other modules stay in agent.stats');
  assert.deepEqual([stats.ctxTok, stats.ctxMax], [2 + 614 + 11935, 200000], 'context numbers of the latest model call');
  assert.ok(near(stats.usd, 1 + c1.usd));

  // A model without a price: the CLI's own number is all there is.
  w.agent('C2', { provider: 'fakeclaude', model: 'claude-unknown-9', replay: claude1 });
  assert.equal((await w.go('C2')).usd, 0.10947499999999999);

  // Gemini, follow-up turn of a conversation: 2279 fresh input tokens, 22147 cached (5% of the input price on
  // Gemini 4), 33 output tokens (thinking is inside). The slug gemini-4-hydrogen-low has the price of its model.
  w.agent('G1', { provider: 'fakegemini', model: 'gemini-4-hydrogen-low', replay: agy2 });
  const g1 = await w.go('G1');
  assert.equal(g1.ok, true, JSON.stringify(g1.error));
  assert.deepEqual(g1.usage, { inTok: 2279, outTok: 33, cacheRead: 22147, cacheWrite: 0, ctxTok: 2279 + 22147 });
  assert.ok(near(g1.usd, (2279 * 1.5 + 22147 * 1.5 * 0.05 + 33 * 7.5) / 1e6), `usd ${g1.usd}`);
  assert.equal(g1.sessionId, '25205a15-d680-4584-8116-afe71136cbc8');
  assert.deepEqual([w.store.get('agents', 'G1').stats.ctxTok, w.store.get('agents', 'G1').stats.ctxMax], [2279 + 22147, 1_048_576]);

  // A price that changes on a date: the new price counts from that day on.
  w.agent('G2', { provider: 'fakegemini', model: 'gemini-4-argon-high', replay: agy1 });
  assert.ok(near((await w.go('G2')).usd, (47922 * 4 + 355 * 20) / 1e6));
  w.agent('G3', { provider: 'fakegemini', model: 'gemini-4-carbon', replay: agy1 });
  assert.ok(near((await w.go('G3')).usd, (47922 * 2 + 355 * 10) / 1e6));
  // an older Gemini model: cached input costs 10% of the input price
  w.agent('G4', { provider: 'fakegemini', model: 'gemini-3.8-flash-low', replay: agy2 });
  assert.ok(near((await w.go('G4')).usd, (2279 * 0.75 + 22147 * 0.75 * 0.1 + 33 * 3.75) / 1e6));
  assert.equal(w.providers.cooled.length, 0);
});

test('plan-limit lines of the Claude CLI: "allowed" is reported, a warning does not pause the lab, a refusal does', async (t) => {
  const w = setup(t);
  const stream = (name, lines) => { const file = path.join(w.dir, name); fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`); return file; };
  const init = { type: 'system', subtype: 'init', cwd: w.work, session_id: 'aaaaaaaa-0000-4000-8000-000000000001', model: 'claude-sonnet-5-5', mcp_servers: [{ name: 'shop', status: 'connected' }] };
  const good = { type: 'result', subtype: 'success', is_error: false, result: 'fine', session_id: init.session_id, usage: { input_tokens: 5, output_tokens: 2 }, num_turns: 1 };
  const reset = Math.floor(Date.now() / 1000) + 7200;

  w.agent('REAL', { provider: 'fakeclaude', model: 'claude-haiku-5-5', replay: path.join(FIX, 'claude', 'claude-worker-turn1.real.jsonl') });
  assert.equal((await w.go('REAL')).ok, true);
  assert.deepEqual(w.providers.limits, [{ id: 'fakeclaude', status: 'allowed', type: 'seven_day', utilization: 0.11, resetAt: 1794988800000 }]);
  assert.deepEqual(w.providers.cooled, []);

  w.agent('WARN', { provider: 'fakeclaude', model: 'claude-sonnet-5-5', replay: stream('warn.jsonl', [init, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: reset, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.93, resetsAt: reset } } } }, good]) });
  const warn = await w.go('WARN');
  assert.deepEqual([warn.ok, warn.error], [true, null], 'a warning does not fail a turn that worked');
  assert.deepEqual(w.providers.cooled, [], 'and it does not pause the lab');
  assert.equal(w.providers.limits.at(-1).utilization, 0.93);

  const refused = [init, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day' } },
    { type: 'assistant', message: { id: 'x', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Request rejected (429)' }] }, error: 'rate_limit', is_api_error_message: true },
    { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, terminal_reason: 'api_error', result: 'API Error: Request rejected (429)', session_id: init.session_id, usage: {}, num_turns: 1 }];
  w.agent('STOP', { provider: 'fakeclaude', model: 'claude-sonnet-5-5', replay: stream('refused.jsonl', refused) });
  const stop = await w.go('STOP');
  assert.deepEqual([stop.ok, stop.error.kind, stop.error.resetAt], [false, 'rate_limit', reset * 1000]);
  assert.ok(w.providers.cooled.length >= 1);
  assert.ok(w.providers.cooled.every((c) => c.id === 'fakeclaude' && c.until === reset * 1000), 'the lab is paused until the reset time of the plan');
  assert.match(w.providers.cooled[0].reason, /Plan limit reached \(seven_day\)/);
  w.agent('NEXT', { provider: 'fakeclaude', model: 'claude-sonnet-5-5' });
  const next = await w.go('NEXT');
  assert.deepEqual([next.started, next.error.kind, next.error.resetAt], [false, 'rate_limit', reset * 1000], 'no new process for a paused lab');
});

// ------------------------------------------------------------------------------------------- self-test

test('selfTest cleans up after itself: agent, token, folders, log; also after a failure and after an earlier crash', async (t) => {
  const w = setup(t);
  const http = createHttp({ ownerKey: 'test-owner-key-0123456789', log: () => {} });
  mountMcp(http, w.mcp);
  const { url } = await http.listen();
  t.after(() => http.close());
  w.state.url = `${url}/mcp`;
  w.agent('KEEP', { role: 'maker' });
  // what a self-test leaves in the saved state when the hub dies in the middle of it
  w.store.put('agents', { id: 'selftest-deadbeef', jobId: null, role: 'selftest', hidden: true, provider: 'selfie', model: 'selftest', sessionId: null, stats: {} });
  const temp = [];
  w.store.subscribe((e) => { if (e.type === 'upsert' && e.kind === 'agents' && e.item.id.startsWith('selftest-')) temp.push(e.item.id); });

  const leftovers = () => ({
    agents: w.store.list('agents').map((a) => a.id),
    run: fs.existsSync(w.paths.run) ? fs.readdirSync(w.paths.run) : [],
    logs: fs.existsSync(w.paths.logs) ? fs.readdirSync(w.paths.logs) : [],
    temp: fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('workshop-selftest-')).filter((n) => w.built.some((b) => b.cwd.endsWith(n))),
  });

  const good = await w.runner.selfTest('selfie');
  assert.equal(good.ok, true, JSON.stringify([good.steps, good.core]));
  await sleep(100);
  assert.deepEqual(leftovers(), { agents: ['KEEP'], run: [], logs: [], temp: [] }, 'nothing is left, and the agent of the earlier crash is gone too');
  const first = w.built.at(-1);
  assert.equal(w.mcp.agentFor(first.mcp.token), null, 'the token of the temporary agent is dead');
  assert.deepEqual(w.runner.logTail(temp.at(-1)), []);
  assert.ok(good.logTail.length > 0, 'the report still has the log lines');

  const bad = await w.runner.selfTest('selfie', { model: 'crash' }); // the agent crashes without a result
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.steps.filter((s) => !s.ok).map((s) => s.name), ['tool call arrived', 'clean result', 'usage reported']);
  await sleep(100);
  assert.deepEqual(leftovers(), { agents: ['KEEP'], run: [], logs: [], temp: [] });
  assert.equal(w.mcp.agentFor(w.built.at(-1).mcp.token), null);

  w.providers.cooling.selfie = { until: Date.now() + 60_000, reason: 'limit' }; // refused before any process starts
  const refused = await w.runner.selfTest('selfie');
  assert.deepEqual(refused.steps.map((s) => [s.name, s.ok]), [['binary found', true], ['ready to use', false]]);
  assert.deepEqual(leftovers().agents, ['KEEP']);
  assert.deepEqual([w.runner.active(), w.runner.queued()], [[], []]);
  assert.equal(w.mcp.toolsFor('maker').some((tool) => tool.name === 'selftest_ping'), false);
});

// ------------------------------------------------------------------------------------------- agy safety

function sh(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** A fake agy under the temp folder, the real Google adapter, the real registry and the real runner. */
function agyWorld(t, { loggedOut = false, mode = 'apikey', keys = { gemini: 'g-adv-key-0123456789' } } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adv-agy-')));
  const bin = path.join(dir, 'bin');
  const bench = path.join(dir, 'bench');
  fs.mkdirSync(path.join(bench, '.git', 'info'), { recursive: true });
  const okStream = [
    { event: 'init', conversation_id: 'c-1', init: { model: 'gemini-4-hydrogen-low', cwd: bench, tools: ['run_command'], permission_mode: 'proceed-in-sandbox' } },
    { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'OK', usage: { input_tokens: 100, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 50, total_tokens: 105 } } },
    { event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response: 'OK', duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 50, total_tokens: 105 } } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const authFail = JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, finished_reason: 'error' } });
  fs.writeFileSync(path.join(dir, 'ok.jsonl'), `${okStream}\n`);
  fs.writeFileSync(path.join(dir, 'auth.jsonl'), `${authFail}\n`);
  sh(path.join(bin, 'agy'), [
    `printf '%s\\n' "$*" >> "${dir}/agy-calls.log"`,
    // a real pipe, a socket pair, or a character device (/dev/null, a terminal)?
    `if [ -c /dev/stdin ] || [ -t 0 ]; then echo chardev >> "${dir}/agy-stdin.log"; elif [ -p /dev/stdin ]; then echo pipe >> "${dir}/agy-stdin.log"; elif [ -S /dev/stdin ]; then echo socket >> "${dir}/agy-stdin.log"; else echo other >> "${dir}/agy-stdin.log"; fi`,
    'cat > /dev/null',
    `echo eof >> "${dir}/agy-stdin.log"`,
    `env > "${dir}/agy-env.txt"`,
    // what agy finds in its work folder while it runs
    `cp .agents/mcp_config.json "${dir}/seen-config.json" 2>/dev/null`,
    // the URL file of the shim (outside the bench): its content and mode
    `cp "${dir}/data/run/G1/mcp-url" "${dir}/seen-url.txt" 2>/dev/null; stat -f '%Lp' "${dir}/data/run/G1/mcp-url" > "${dir}/seen-mode.txt" 2>/dev/null`,
    loggedOut
      ? `cat "${dir}/auth.jsonl"; echo "Error: authentication required. Run 'agy' to log in, then retry." >&2; exit 1`
      : `cat "${dir}/ok.jsonl"`,
  ].join('\n'));
  const shellEnv = {
    path: `${bin}:/usr/bin:/bin`,
    resolve: (name) => { const f = path.join(bin, String(name)); return fs.existsSync(f) ? f : null; },
    base: () => ({ HOME: dir, USER: 'owner', LOGNAME: 'owner', SHELL: '/bin/zsh', TERM: 'dumb', LANG: 'en_US.UTF-8', TMPDIR: `${dir}/`, PATH: `${bin}:/usr/bin:/bin` }),
  };
  let settings = {
    auth: { claude: null, gemini: mode }, authAck: { gemini: { mode, ts: 1 } }, selfTest: { gemini: { version: '1.5.1', ok: true, core: [], advisory: [], ts: 1 } },
    providers: { gemini: { authOk: true, models: ['gemini-4-hydrogen-low'], version: '1.5.1' } }, limits: { maxAgents: 2 }, safety: 'sandboxed',
  };
  const merge = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v; return out; };
  const secrets = {
    list: async () => [{ id: 'gemini', envVar: 'GEMINI_API_KEY', set: !!keys.gemini }],
    envFor: async (id) => (id === 'gemini' && keys.gemini ? { GEMINI_API_KEY: keys.gemini } : {}),
  };
  const logs = [];
  const providers = createProviders({ secrets, shellEnv, getSettings: () => settings, updateSettings: (patch) => { settings = merge(settings, patch); return settings; }, paths: { run: path.join(dir, 'data', 'run') }, log: (level, msg, data) => logs.push({ level, msg, data }), timeouts: { probe: 60_000 } });
  const store = createStore({ dataDir: path.join(dir, 'data') });
  const mcp = createMcp({ store });
  const runner = createRunner({
    store, providers, mcp, getSettings: () => settings, getMcpUrl: () => 'http://127.0.0.1:1/mcp', log: (level, msg, data) => logs.push({ level, msg, data }),
    paths: { server: path.join(ROOT, 'server'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') },
    tuning: { minSpawnGapMs: 0, killGraceMs: 250, shutdownGraceMs: 200, closeWaitMs: 300 },
  });
  t.after(async () => { await runner.shutdown(); providers.dispose(); await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.put('agents', { id: 'G1', jobId: null, role: 'maker', handle: '@m1', provider: 'gemini', model: 'gemini-4-hydrogen', sessionId: null, stats: {} });
  const read = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; } };
  const turn = (extra = {}) => runner.run('G1', { prompt: 'Do the task.', systemPrompt: 'You are a maker.', cwd: bench, effort: 'low', ...extra });
  return { dir, bin, bench, providers, runner, store, mcp, logs, read, turn, settings: () => settings };
}

test('agy gets a real pipe at end-of-file on stdin (no socket pair, no /dev/null), and no token on its command line', async (t) => {
  const w = agyWorld(t);
  await w.providers.detect();
  assert.equal(w.providers.usable('gemini'), true, 'the owner checked the sign-in before (saved in the settings)');
  const res = await w.turn();
  assert.deepEqual([res.ok, res.text, res.sessionId], [true, 'OK', 'c-1'], JSON.stringify(res.error));
  assert.deepEqual(res.usage, { inTok: 100, outTok: 5, cacheRead: 50, cacheWrite: 0, ctxTok: 150 });
  assert.deepEqual(w.read('agy-stdin.log').trim().split('\n'), ['pipe', 'eof'], 'a pipe with no writer: the case that fails cleanly without a login');
  const token = /\/mcp\/([0-9a-f]{64})$/.exec(w.read('seen-url.txt'))?.[1];
  assert.ok(token, 'the URL file held the URL with the token while agy ran');
  assert.equal(w.mcp.agentFor(token), null, 'the token is revoked when the turn ends');
  const call = w.read('agy-calls.log');
  assert.ok(!call.includes(token), 'the MCP token is not an argument of agy');
  assert.ok(!call.includes('g-adv-key-0123456789'), 'the API key is not an argument of agy');
  assert.match(call, /^-p You are a maker\.\s+---\s+Do the task\. --output-format stream-json --model gemini-4-hydrogen-low --effort low --settings /);
  const env = w.read('agy-env.txt');
  assert.match(env, /GEMINI_API_KEY=g-adv-key-0123456789/, 'API key travels via environment in apikey mode');
  assert.match(env, /AGY_CLI_DISABLE_AUTO_UPDATE=true/);
  const shop = JSON.parse(w.read('seen-config.json')).mcpServers.shop; // the file as agy saw it during the turn
  const urlFile = path.join(w.dir, 'data', 'run', 'G1', 'mcp-url');
  assert.deepEqual(shop.args, [path.join(ROOT, 'server', 'mcp-stdio-shim.mjs'), '--url-file', urlFile], 'the shim reads the URL from a file outside the bench');
  assert.equal(shop.env, undefined, 'no env block with the URL');
  assert.equal(w.read('seen-url.txt'), `http://127.0.0.1:1/mcp/${token}`);
  assert.equal(w.read('seen-mode.txt').trim(), '600', 'the file with the token is private');
  assert.equal(fs.existsSync(urlFile), false, 'the URL file is removed when the turn ends');
  assert.ok(!fs.readFileSync(path.join(w.bench, '.agents', 'mcp_config.json'), 'utf8').includes(token), 'the bench file holds no token');
  const inBench = [];
  const walkBench = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walkBench(f); else inBench.push(f); } };
  walkBench(w.bench);
  for (const f of inBench) assert.ok(!fs.readFileSync(f, 'utf8').includes(token), `the token is left in ${f}`);
  assert.equal(fs.existsSync(path.join(w.bench, '.agents', 'rules')), false, 'no rules file: agy does not apply it in -p runs');
  assert.equal(fs.existsSync(path.join(w.bench, '.git', 'info', 'exclude')), false, 'the adapter does not touch .git/info/exclude (gitops owns it)');
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'data', 'run', 'G1')).sort(), ['settings.json'], 'the FIFO file is gone');
  for (const text of [fs.readFileSync(path.join(w.dir, 'data', 'logs', 'G1.jsonl'), 'utf8'), JSON.stringify(w.logs)]) assert.ok(!text.includes(token));

  // a follow-up turn of the conversation: no role card again, the same stdin
  const next = await w.turn({ resume: true, sessionId: res.sessionId, prompt: 'Next step.' }); // the caller passes the session id
  assert.equal(next.ok, true);
  assert.match(w.read('agy-calls.log').trim().split('\n').at(-1), /^-p Next step\. .* --conversation c-1$/);
  assert.deepEqual(w.read('agy-stdin.log').trim().split('\n'), ['pipe', 'eof', 'pipe', 'eof']);
});

test('agy sign-in error: the lab is marked signed out, the turn is not retried, and no further agy starts', async (t) => {
  const w = agyWorld(t, { loggedOut: true });
  await w.providers.detect();
  assert.equal(w.providers.usable('gemini'), true);
  const res = await w.turn();
  assert.deepEqual([res.ok, res.error.kind, res.started], [false, 'auth', true]);
  assert.equal(w.providers.usable('gemini'), false);
  assert.equal(w.providers.status('gemini').auth, 'none');
  assert.equal(w.settings().providers.gemini.authOk, false, 'the signed-out state is saved');
  const again = await w.turn();
  assert.deepEqual([again.ok, again.started, again.error.kind], [false, false, 'auth']);
  await w.providers.detect({ force: true });
  await w.providers.refresh();
  assert.equal((w.read('agy-calls.log').match(/--output-format/g) ?? []).length, 1, 'agy ran exactly once: no retry, no probe');
  assert.deepEqual(w.read('agy-stdin.log').trim().split('\n'), ['pipe', 'eof']);
});

test('agy in API key mode: the key is only in the environment of agy, never in a file, an argument or a log', async (t) => {
  const key = 'g-test-KEY-abcdefghijklmnop';
  const w = agyWorld(t, { mode: 'apikey', keys: { gemini: key } });
  await w.providers.detect();
  assert.equal(w.providers.usable('gemini'), true);
  const res = await w.turn();
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.match(w.read('agy-env.txt'), new RegExp(`GEMINI_API_KEY=${key}`));
  assert.ok(!w.read('agy-calls.log').includes(key));
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else if (!f.endsWith('agy-env.txt')) files.push(f); } };
  walk(w.dir);
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(key), `the key is in ${f}`);
  assert.ok(!JSON.stringify(w.logs).includes(key) && !JSON.stringify(w.providers.list()).includes(key) && !JSON.stringify(w.settings()).includes(key));
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'data', 'run', 'G1', 'settings.json'), 'utf8')).modelProvider, 'gemini');
});

test('openClosedPipe and runCommand: a FIFO at end-of-file, and a fallback when none can be made', async (t) => {
  const { openClosedPipe } = await import('../server/shellenv.js');
  assert.equal(typeof openClosedPipe, 'function');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adv-fifo-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fd = openClosedPipe(dir);
  assert.equal(typeof fd, 'number');
  assert.equal(fs.fstatSync(fd).isFIFO(), true);
  assert.equal(fs.readSync(fd, Buffer.alloc(8), 0, 8, null), 0, 'end-of-file at once');
  fs.closeSync(fd);
  assert.deepEqual(fs.readdirSync(dir), [], 'the FIFO file and its folder are removed');
  assert.equal(openClosedPipe(dir, { mkfifo: path.join(dir, 'no-such-mkfifo') }), null);
  assert.equal(openClosedPipe(path.join(dir, 'a-file-not-a-folder', 'x'), { mkfifo: '/usr/bin/false' }), null);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('stdin-')), []);

  const kind = 'if [ -p /dev/stdin ]; then echo pipe; elif [ -S /dev/stdin ]; then echo socket; elif [ -c /dev/stdin ]; then echo chardev; else echo other; fi; cat > /dev/null; echo eof';
  sh(path.join(dir, 'kind'), kind);
  const env = { PATH: '/usr/bin:/bin' };
  const fifo = await runCommand(path.join(dir, 'kind'), [], { env, timeoutMs: 20_000, stdin: 'fifo', fifoDir: dir });
  assert.deepEqual([fifo.code, fifo.stdout.trim().split('\n')], [0, ['pipe', 'eof']]);
  const plain = await runCommand(path.join(dir, 'kind'), [], { env, timeoutMs: 20_000 });
  assert.deepEqual([plain.code, plain.stdout.trim().split('\n')], [0, ['socket', 'eof']], "Node's own pipe is a socket pair: closed at once, never /dev/null");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('stdin-')), []);
});

test('registry: a plan-limit notice shows in the status, fires onChange once per change, and ends with its window', async (t) => {
  let clock = 1_800_000_000_000;
  const shellEnv = { path: '/usr/bin:/bin', resolve: () => null, base: () => ({ HOME: '/nowhere', USER: 'owner', LOGNAME: 'owner', SHELL: '/bin/zsh', TERM: 'dumb', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/', PATH: '/usr/bin:/bin' }) };
  const providers = createProviders({ secrets: { list: async () => [], envFor: async () => ({}) }, shellEnv, getSettings: () => ({ auth: {} }), updateSettings: () => ({}), now: () => clock });
  t.after(() => providers.dispose());
  assert.equal(typeof providers.noteLimit, 'function');
  const seen = [];
  providers.onChange((list) => seen.push(list.find((p) => p.id === 'claude').limit));
  const info = { status: 'allowed_warning', type: 'five_hour', utilization: 0.9, resetAt: clock + 3_600_000, overage: false };
  providers.noteLimit('claude', info);
  providers.noteLimit('claude', { ...info });
  assert.equal(seen.length, 1, 'the same notice twice is one change');
  assert.deepEqual(providers.status('claude').limit, { ...info, at: clock });
  providers.noteLimit('claude', { ...info, utilization: 0.95 });
  assert.equal(seen.length, 2);
  assert.equal(providers.status('claude').usable, false, 'a notice never makes a lab usable');
  assert.equal(providers.status('claude').cooling, null, 'and it never pauses one');
  providers.noteLimit('nope', info); // an unknown lab is ignored
  providers.noteLimit('claude', null);
  providers.noteLimit('claude', { status: { x: 1 }, utilization: 'much', resetAt: 'later' });
  assert.deepEqual(providers.status('claude').limit, { status: null, type: null, utilization: null, resetAt: null, overage: false, at: clock });
  providers.noteLimit('claude', info);
  clock += 3_600_001;
  assert.equal(providers.status('claude').limit, null, 'a notice ends with its window');
});

test('claude buildRun: never bypassPermissions, always --setting-sources "", in every mix of options', () => {
  const shellEnv = { path: '/usr/bin:/bin', resolve: () => '/fake/claude', base: () => ({ HOME: '/home/owner', USER: 'owner', LOGNAME: 'owner', SHELL: '/bin/zsh', TERM: 'dumb', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/', PATH: '/usr/bin:/bin' }) };
  const adapter = createClaudeAdapter({ shellEnv });
  const mcp = { url: 'http://127.0.0.1:4317/mcp', token: 'tok-secret-123456', shimPath: '/s', nodePath: '/n' };
  let count = 0;
  for (const safety of ['sandboxed', 'trusting', undefined, 'bypass', 'bypassPermissions'])
    for (const access of ['write', 'read', undefined])
      for (const web of [true, false])
        for (const resume of [true, false])
          for (const mode of ['subscription', 'apikey']) {
            const spec = adapter.buildRun({ agent: { id: 'A1' }, model: 'claude-sonnet-5-5', effort: 'high', prompt: 'p', systemPrompt: 's', cwd: '/w', sessionId: '11111111-2222-4333-8444-555555555555', resume, mcp, access, web, runDir: '/r', mode, keyEnv: { ANTHROPIC_API_KEY: 'sk-ant-matrix-key-123' }, safety, maxTurns: 5 });
            count += 1;
            const text = JSON.stringify(spec.args);
            assert.ok(!/bypassPermissions|dangerously|--permission-mode","(?:auto|default|manual|plan)"/.test(text), text);
            const i = spec.args.indexOf('--setting-sources');
            assert.ok(i > 0 && spec.args[i + 1] === '', 'no settings of the user or of the project are loaded');
            assert.ok(spec.args.includes('--strict-mcp-config') && spec.args.includes('--disable-slash-commands') && spec.args[0] === '-p');
            assert.ok(['acceptEdits', 'dontAsk'].includes(spec.args[spec.args.indexOf('--permission-mode') + 1]));
            assert.ok(spec.args.includes('Bash(git push *)') && spec.args.includes('Bash(sudo *)') && spec.args.includes('Bash(security *)'));
            assert.equal(spec.args.at(-1), '/r/settings.json', 'the settings are a file of the run folder');
            const settings = JSON.parse(spec.files.find((f) => f.path === '/r/settings.json').content);
            assert.equal(settings.disableAllHooks, true);
            assert.equal(Object.hasOwn(settings, 'sandbox'), safety !== 'trusting', 'only the exact word "trusting" turns the OS sandbox off');
            assert.equal('ANTHROPIC_API_KEY' in spec.env, mode === 'apikey');
            assert.ok(!text.includes('tok-secret-123456') && !text.includes('sk-ant-matrix-key-123'), 'no secret on the command line');
            for (const file of spec.files) assert.ok(!String(file.content).includes('tok-secret-123456') && !String(file.content).includes('sk-ant-matrix-key-123'), 'no secret in a file');
            assert.equal(spec.stdin, 'p');
          }
  assert.equal(count, 5 * 3 * 2 * 2 * 2);
});

test('registry: a cheap probe does not lift a sign-in failure that a real turn reported; the owner\'s check does', async (t) => {
  // `claude auth status` says "logged in" when a login is saved, also when the API refuses that login (401).
  // Without this rule every detect() would switch the lab on again, and the hub would try, fail and try again.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adv-reg-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  sh(path.join(bin, 'claude'), `echo "$@" >> "${dir}/calls.log"\ncase "$1" in\n  --version) echo "2.1.289 (Claude Code)";;\n  auth) echo '{"loggedIn": true, "authMethod": "claude.ai"}';;\n  *) exit 9;;\nesac`);
  const shellEnv = {
    path: `${bin}:/usr/bin:/bin`, resolve: (name) => (fs.existsSync(path.join(bin, String(name))) ? path.join(bin, String(name)) : null),
    base: () => ({ HOME: dir, USER: 'owner', LOGNAME: 'owner', SHELL: '/bin/zsh', TERM: 'dumb', LANG: 'en_US.UTF-8', TMPDIR: `${dir}/`, PATH: `${bin}:/usr/bin:/bin` }),
  };
  // trusting and acknowledged: this test is about the sign-in rule only (API key mode in Phase 0)
  const providers = createProviders({
    secrets: { list: async () => [{ id: 'anthropic', envVar: 'ANTHROPIC_API_KEY', set: true, updatedAt: 1000 }], envFor: async () => ({ ANTHROPIC_API_KEY: 'sk-ant-ok-key' }) },
    shellEnv, getSettings: () => ({ auth: { claude: 'apikey' }, authAck: { claude: { mode: 'apikey' } }, safety: 'trusting' }), updateSettings: () => ({}), paths: { run: path.join(dir, 'run') }, timeouts: { probe: 60_000 },
  });
  t.after(() => providers.dispose());
  await providers.detect();
  assert.equal(providers.usable('claude'), true);
  providers.markAuth('claude', 'none'); // the runner: a turn got "authentication_failed"
  assert.equal(providers.usable('claude'), false);
  await providers.detect({ force: true });
  await providers.detect({ force: true });
  await providers.refresh();
  assert.deepEqual([providers.status('claude').auth, providers.usable('claude')], ['none', false], 'the probe says "logged in", the lab stays off');
  assert.match(providers.status('claude').reason, /refused the key/);
  const after = await providers.checkAuth('claude'); // the owner clicked "Re-check"
  assert.deepEqual([after.auth, after.usable], ['ok', true]);
  providers.markAuth('claude', 'none');
  providers.markAuth('claude', 'ok'); // a good turn
  await providers.detect({ force: true });
  assert.equal(providers.usable('claude'), true);

  // API key mode: a key that the API refused must switch the lab off too (else every new turn fails the same
  // way). A newly saved key, or the owner's check, gets a new try.
  let mode = 'apikey';
  let updatedAt = 1000;
  const keyed = createProviders({
    secrets: { list: async () => [{ id: 'anthropic', envVar: 'ANTHROPIC_API_KEY', set: true, updatedAt }], envFor: async () => ({ ANTHROPIC_API_KEY: 'sk-ant-refused-key' }) },
    shellEnv, getSettings: () => ({ auth: { claude: mode }, authAck: { claude: { mode } }, safety: 'trusting' }), updateSettings: () => ({}), paths: { run: path.join(dir, 'run') }, timeouts: { probe: 60_000 },
  });
  t.after(() => keyed.dispose());
  await keyed.detect();
  assert.equal(keyed.usable('claude'), true);
  keyed.markAuth('claude', 'none'); // the runner: the API answered 401 for this key
  assert.equal(keyed.usable('claude'), false);
  assert.match(keyed.status('claude').reason, /refused the key/);
  await keyed.detect({ force: true });
  await keyed.refresh();
  assert.equal(keyed.usable('claude'), false, 'the same key is not tried again');
  updatedAt = 2000; // the owner saved a key again
  await keyed.refresh();
  assert.equal(keyed.usable('claude'), true);
  keyed.markAuth('claude', 'none');
  assert.equal((await keyed.checkAuth('claude')).usable, true, 'the owner\'s check gives the key a new try');
  assert.ok(!JSON.stringify(keyed.list()).includes('sk-ant-refused-key'));
});

test('a hub that was killed with SIGKILL: the next hub kills its leftover agent processes before it starts a turn', async (t) => {
  // kill -9 gives the hub no chance to clean up. Its agent would work on (same session, same bench) next to the
  // agent that the new hub starts. data/run/<agent>/turn.json tells the new hub what to kill.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adv-kill9-')));
  const work = path.join(dir, 'work');
  const hub = spawn(process.execPath, [HUB, 'hang', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: process.env.TMPDIR ?? '' } });
  let out = '';
  hub.stdout.on('data', (d) => { out += d; });
  hub.stderr.resume();
  const pidOf = (name) => { try { return Number(fs.readFileSync(path.join(work, name), 'utf8')); } catch { return 0; } };
  const bystander = spawn('/bin/sleep', ['300'], { stdio: 'ignore' }); // an unrelated process that must survive
  t.after(() => {
    for (const p of [hub.pid, bystander.pid]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    killLeftovers(work);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(await until(() => out.includes('READY'), 30_000), 'the first hub started its turn');
  const turnFile = path.join(dir, 'data', 'run', 'H1', 'turn.json');
  assert.ok(await until(() => { try { return JSON.parse(fs.readFileSync(turnFile, 'utf8')).kin.length > 0; } catch { return false; } }), 'the turn file names the agent and its detached child');
  const record = JSON.parse(fs.readFileSync(turnFile, 'utf8'));
  const [agentPid, childPid] = [pidOf('H1.pid'), pidOf('H1.child.pid')];
  assert.deepEqual([record.pid, record.kin.map((k) => k[0]), record.hub], [agentPid, [childPid], hub.pid]);
  assert.ok(!fs.readFileSync(turnFile, 'utf8').includes('token'), 'the turn file holds process ids only');

  // records that must NOT lead to a kill: a pid that now belongs to another process (other start time), a
  // descendant entry with another start time, and a record of a hub that still runs
  const fake = (name, rec) => { fs.mkdirSync(path.join(dir, 'data', 'run', name), { recursive: true }); fs.writeFileSync(path.join(dir, 'data', 'run', name, 'turn.json'), JSON.stringify(rec)); };
  fake('REUSED', { v: 1, hub: 999_999, hubAt: 1, agent: 'REUSED', pid: bystander.pid, at: Date.now() - 3_600_000, kin: [[bystander.pid, 'Mon Jan  1 00:00:00 2001']] });
  fake('OTHERHUB', { v: 1, hub: process.pid, hubAt: Date.now() - Math.round(process.uptime() * 1000), agent: 'OTHERHUB', pid: bystander.pid, at: Date.now(), kin: [] });
  fake('BROKEN', 'not a record');
  fs.writeFileSync(path.join(dir, 'data', 'run', 'BROKEN', 'turn.json'), '{broken');

  hub.kill('SIGKILL');
  await new Promise((resolve) => hub.on('exit', resolve));
  await sleep(300);
  assert.ok(alive(agentPid) && alive(childPid), 'kill -9 of the hub leaves its agent and the child of the agent alive');

  // the next hub: same data folder
  const store = createStore({ dataDir: path.join(dir, 'data2') });
  const mcp = createMcp({ store });
  const logs = [];
  const adapter = { id: 'fake', buildRun: (o) => ({ cmd: process.execPath, args: [AGENT, 'noread', work, o.agent.id], env: { PATH: '/usr/bin:/bin' }, cwd: o.cwd, stdin: o.prompt, files: [] }), createParser: () => createMockParser() };
  const providers = { get: () => adapter, usable: () => true, status: () => ({ installed: true, usable: true }), keyEnv: async () => ({}), cool() {}, markAuth() {} };
  const runner = createRunner({
    store, providers, mcp, getSettings: () => ({ limits: { maxAgents: 2 }, auth: { fake: 'subscription' } }), getMcpUrl: () => 'http://127.0.0.1:1/mcp', log: (level, msg, data) => logs.push({ level, msg, data }),
    paths: { server: path.join(ROOT, 'server'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') }, tuning: { minSpawnGapMs: 0 },
  });
  t.after(async () => { await runner.shutdown(); await store.flush(); });
  store.put('agents', { id: 'H1', jobId: null, role: 'maker', provider: 'fake', model: 'noread', sessionId: null, stats: {} });
  const res = await runner.run('H1', { prompt: 'resume the work', systemPrompt: 'role', cwd: work }); // no explicit reapOrphans(): the first turn waits for it
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.ok(await gone(agentPid), 'the agent of the dead hub is gone');
  assert.ok(await gone(childPid), 'and its detached child');
  assert.equal(alive(bystander.pid), true, 'a process that only has the pid of an old record is not touched');
  assert.equal(fs.existsSync(turnFile), false, 'the turn file is gone when the turn of the new hub has ended');
  assert.equal(fs.existsSync(path.join(dir, 'data', 'run', 'OTHERHUB', 'turn.json')), true, 'the record of a hub that still runs is left alone');
  assert.ok(logs.some((l) => /earlier hub/.test(l.msg) && l.data.count === 2));
  assert.equal(await runner.reapOrphans(), 2, 'the look happens once; later calls give its result');
});

test('files that an adapter writes only for one turn are gone when the turn ends (cleanup files, the URL file)', async (t) => {
  // Adapter files live in data/run/<agentId>/ only. A file marked cleanup, and the URL file with the token
  // (mcp.urlFile), are removed at every turn end.
  const w = setup(t, {
    extraFiles: (o) => [
      { path: path.join(o.runDir, 'once.json'), content: `{"token":"${o.mcp.token}"}`, cleanup: true },
      { path: o.mcp.urlFile, content: `${o.mcp.url}/${o.mcp.token}` },
      { path: path.join(o.runDir, 'keep.txt'), content: 'stays' },
    ],
  });
  const tokenFile = path.join(w.paths.run, 'A1', 'once.json');
  w.agent('A1', { model: 'seefile' });
  const res = await w.go('A1', { effort: tokenFile });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(w.read('A1.saw'), 'yes 600', 'the agent had its file (private) while it ran');
  assert.equal(fs.existsSync(tokenFile), false, 'the file is removed with the end of the turn');
  assert.equal(fs.existsSync(path.join(w.paths.run, 'A1', 'mcp-url')), false, 'the URL file too');
  assert.equal(fs.readFileSync(path.join(w.paths.run, 'A1', 'keep.txt'), 'utf8'), 'stays', 'other adapter files stay');
  // also when the turn fails, is cancelled, or cannot start
  for (const [id, model, effort] of [['A2', 'detached-crash', '100'], ['A4', 'eacces', '']]) {
    w.agent(id, { model });
    await w.go(id, { effort });
    assert.equal(fs.existsSync(path.join(w.paths.run, id, 'once.json')), false, id);
    assert.equal(fs.existsSync(path.join(w.paths.run, id, 'mcp-url')), false, id);
  }
  w.agent('A3', { model: 'result-hang' });
  const hanging = w.go('A3');
  const a3 = path.join(w.paths.run, 'A3', 'once.json');
  assert.ok(await until(() => fs.existsSync(a3)));
  w.runner.cancel('A3', 'stop');
  assert.equal((await hanging).killed, 'cancel');
  assert.equal(fs.existsSync(a3), false);
  assert.equal(fs.existsSync(path.join(w.paths.run, 'A3', 'mcp-url')), false);
  // a link in place of the file is not followed when the turn ends
  const victim = path.join(w.dir, 'victim.txt');
  fs.writeFileSync(victim, 'do not delete');
  w.agent('A5', { model: 'noread' });
  const turn = w.go('A5');
  const a5 = path.join(w.paths.run, 'A5', 'once.json');
  const a5url = path.join(w.paths.run, 'A5', 'mcp-url');
  assert.ok(await until(() => fs.existsSync(a5) && fs.existsSync(a5url)));
  fs.rmSync(a5);
  fs.symlinkSync(victim, a5); // what a hostile agent could do during its turn
  fs.rmSync(a5url);
  fs.symlinkSync(victim, a5url);
  await turn;
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not delete');
});

test('an adapter that keeps the identity of the agent in the work folder (agy) runs one turn per folder at a time', async (t) => {
  // Two bosses that plan in the same folder at the same time: agy reads `.agents/mcp_config.json` of the folder,
  // so both would act with the token of the one that started last.
  const w = setup(t);
  const other = path.join(w.dir, 'other-folder');
  fs.mkdirSync(other);
  for (const id of ['S1', 'S2', 'S3']) w.agent(id, { provider: 'solo', model: 'detached-ok' });
  w.agent('F1', { provider: 'fake', model: 'detached-ok' }); // another lab in the same folder does not wait
  const t0 = Date.now();
  const ends = {};
  const run = (id, cwd) => w.go(id, { effort: '700', cwd }).then((res) => { ends[id] = Date.now() - t0; return res; });
  const all = await Promise.all([run('S1', w.work), run('S2', w.work), run('S3', other), run('F1', w.work)]);
  assert.ok(all.every((r) => r.ok), JSON.stringify(all.map((r) => r.error)));
  const builtAt = Object.fromEntries(w.built.map((b) => [b.agent.id, b.at - t0]));
  assert.ok(builtAt.S2 >= ends.S1 - 50, `S2 started (${builtAt.S2} ms) only after S1 had ended (${ends.S1} ms)`);
  assert.ok(builtAt.S3 < ends.S1 && builtAt.F1 < ends.S1, 'another folder and another lab do not wait');
  assert.deepEqual([w.runner.active(), w.runner.queued()], [[], []]);
});
