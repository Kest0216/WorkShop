// Helpers of the restart and hold scenarios (tests/scenarios/restart-and-holds.test.mjs).
//  - crashRun: the real entry point as a child process (tests/scenarios/crash-hub.mjs) that kills itself with
//    SIGKILL at one exact point. No graceful stop: the store is not flushed, the turns are not stopped.
//  - reboot: the real hub (createApp) in this process on the same folders, through tests/e2e-harness.mjs.
//  - assertOnce: the job finished with the same result and no double work.
// Only the mock lab runs. Nothing is written under the WorkShop data/, projects/ or config/ folders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRIEF, apiClient, git, hubEnv, leftovers, ownerSession, sleep } from '../e2e-harness.mjs';
import { createMockAdapter } from '../../server/providers/mock.js';
import { createClaudeAdapter } from '../../server/providers/claude.js';
import { createGeminiAdapter } from '../../server/providers/gemini.js';
import { createOssAdapter } from '../../server/providers/oss.js';
import { detectTurn } from '../../server/providers/mock-agent.mjs';
import { createShellEnv } from '../../server/shellenv.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRASH_HUB = path.join(HERE, 'crash-hub.mjs');
const READY_RE = /^WORKSHOP_READY (http:\/\/127\.0\.0\.1:\d+)\/#k=([0-9a-f]{64})$/m;

/** config/settings.json of the temp shop (whole file). */
export function setSettings(dirs, settings) {
  fs.mkdirSync(dirs.configDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), `${JSON.stringify({ mockSpeed: 0, ...settings }, null, 2)}\n`);
}

/**
 * Start the crash hub with the trigger `crash`, run `start(api)` (it starts the job; returns its id), and wait
 * until the hub killed itself. Returns { jobId, turns (of the first hub), orphans (agent processes it left),
 * agentsAtKill (agent processes that ran at the kill) }.
 */
export async function crashRun(dirs, crash, { start, timeoutMs = 300_000, twoLabRules = null } = {}) {
  const turnsFile = path.join(dirs.tmp, 'turns-hub1.jsonl');
  const hubArgs = ['--port', '0', '--data', dirs.dataDir, '--config', dirs.configDir, '--projects', dirs.projectsDir, '--secrets', 'file', '--labs', 'mock'];
  // twoLabRules (a list for ruleDecide): the two-lab crash hub (TWO_LAB_CRASH_HUB below) in place of crash-hub.mjs.
  const argv = twoLabRules ? ['--input-type=module', '-e', TWO_LAB_CRASH_HUB] : [CRASH_HUB, ...hubArgs];
  const child = spawn(process.execPath, argv, {
    env: { ...hubEnv(dirs), WS_CRASH: JSON.stringify(crash), WS_TURNS: turnsFile, ...(twoLabRules ? { WS_ARGS: JSON.stringify(hubArgs), WS_DIRS: JSON.stringify(dirs), WS_RULES: JSON.stringify(twoLabRules) } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'], cwd: dirs.tmp,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    const t0 = Date.now();
    let m = null;
    while (!(m = READY_RE.exec(out))) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`the crash hub ended before it was ready: ${err.slice(-1500)}`);
      if (Date.now() - t0 > 60_000) assert.fail('the crash hub was not ready in 60 s');
      await sleep(25);
    }
    const [, url, key] = m;
    const api = apiClient(url, await ownerSession(url, key));
    const jobId = await start(api, dirs);
    const timer = new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), timeoutMs); t.unref(); });
    const end = await Promise.race([exited, timer]);
    if (end === 'timeout') {
      let status = '';
      try { status = JSON.stringify((await api('GET', '/api/state')).body.state.jobs[jobId]?.status); } catch { /* gone */ }
      assert.fail(`the crash trigger ${JSON.stringify(crash)} never fired (job ${status})`);
    }
    assert.equal(end.signal, 'SIGKILL', `the crash hub died by its own SIGKILL (code ${end.code}): ${err.slice(-1500)}`);
    const turns = readLines(turnsFile);
    const orphans = (await leftovers(dirs.tmp)).filter((l) => l.includes(dirs.tmp));
    let crashed = {};
    try { crashed = JSON.parse(fs.readFileSync(`${turnsFile}.crash`, 'utf8')); } catch { /* no record */ }
    return { jobId, turns, orphans, agentsAtKill: Number(crashed.agents) || 0, stderr: err };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}

export function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

/** The job the crash hub started, through the owner API. */
export const startMockJob = ({ brief = BRIEF, crew = 'standard', project = { mode: 'new', name: 'notes' }, extra = {} } = {}) => async (api) => {
  const r = await api('POST', '/api/jobs', { title: 'Notes app', brief, kind: 'build', project, crew, options: { mock: true }, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
};

/** A small existing repo with a passing node:test check (for the baseline gate). */
export function existingRepo(dirs, name = 'legacy') {
  const dir = path.join(dirs.tmp, 'repos', name);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# legacy\n');
  fs.writeFileSync(path.join(dir, 'test', 'base.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('base', () => assert.equal(1 + 1, 2));\n");
  const env = { PATH: '/usr/bin:/bin', HOME: dirs.tmp, GIT_CONFIG_NOSYSTEM: '1' };
  const g = (...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'start');
  return dir;
}

/**
 * The finished job holds the same result as an uninterrupted run, with no double work:
 * every task merged once, one shipped crate per task and no other live crate, one merge commit per task on the
 * target branch, every DONE on the board closed and the last one of each task passed, every requirement
 * verified with evidence, and the check passes on the shipped branch.
 */
export async function assertOnce(shop, jobId) {
  const job = shop.job(jobId);
  assert.equal(job.status, 'done', `job ${job.status} ${job.pauseReason ?? ''} ${job.error ?? ''}`);
  assert.ok(job.report, 'the job has a report');
  for (const r of job.requirements) assert.equal(r.status, 'verified', `${r.id}: ${r.status}`);
  const tasks = shop.tasks(jobId);
  assert.ok(tasks.length >= 2, 'the plan made tasks');
  assert.deepEqual(tasks.filter((t) => t.status !== 'merged').map((t) => `${t.id}:${t.status}`), [], 'every task merged');
  const ds = shop.deliveries(jobId);
  for (const t of tasks) {
    const shipped = ds.filter((d) => d.taskId === t.id && d.status === 'shipped');
    assert.equal(shipped.length, 1, `${t.id} has one shipped crate (${ds.filter((d) => d.taskId === t.id).map((d) => `${d.id}:${d.status}`).join(',')})`);
  }
  assert.deepEqual(ds.filter((d) => !['shipped', 'rejected'].includes(d.status)).map((d) => `${d.id}:${d.status}`), [], 'no crate is left in a live state');
  const project = shop.project(jobId);
  const subjects = git(project.path, 'log', '--first-parent', '--merges', '--format=%s', project.targetBranch).split('\n').filter(Boolean);
  for (const t of tasks) {
    const n = subjects.filter((s) => s.startsWith(`${t.id}:`)).length;
    assert.equal(n, 1, `one merge of ${t.id} on ${project.targetBranch} (subjects: ${subjects.join(' | ')})`);
  }
  assert.equal(git(project.path, 'rev-parse', project.targetBranch), job.intSha, 'the target branch is at the shipped head');
  const msgs = shop.app.board.history({ jobId, limit: 500 });
  const open = msgs.filter((m) => m.kind === 'DONE' && m.state === 'open');
  assert.deepEqual(open.map((m) => m.id), [], 'no DONE is left open');
  for (const t of tasks) {
    const d = ds.find((x) => x.taskId === t.id && x.status === 'shipped');
    const done = msgs.find((m) => m.id === d.doneMsgId);
    assert.ok(done, `the DONE of ${t.id} is on the board`);
    assert.equal(done.state, 'passed', `the DONE ${done.id} of ${t.id} is passed`);
  }
  const check = await shop.app.git.runCheck(project.path, project.checkCmd, { timeoutMs: 120_000 });
  assert.equal(check.ok, true, check.tail);
}

/** Wait until the agent processes of the dead hub are gone (the new runner reaps them). */
export async function waitReaped(tmp, before, { timeoutMs = 15_000 } = {}) {
  const pids = new Set(before.map((l) => Number(l.split(' ')[0])));
  const end = Date.now() + timeoutMs;
  for (;;) {
    const now = (await leftovers(tmp)).map((l) => Number(l.split(' ')[0]));
    const still = now.filter((p) => pids.has(p));
    if (!still.length) return;
    if (Date.now() > end) assert.fail(`processes of the dead hub are still alive: ${still.join(', ')}`);
    await sleep(200);
  }
}

/**
 * Close the shop and check that it left no process. Scenarios run side by side in one test process, so only the
 * processes of this shop count: a cwd or a command line under its temp folder.
 */
export async function finishShop(shop, { keep = false, allowErrors = false } = {}) {
  await shop.close();
  const mine = (await leftovers(shop.dirs.tmp)).filter((l) => l.includes(shop.dirs.tmp));
  if (!allowErrors) assert.deepEqual(shop.errors().map((e) => `${e.msg} ${JSON.stringify(e.data ?? {}).slice(0, 300)}`), [], 'the hub logged no error');
  assert.deepEqual(mine, [], 'no process is left');
  if (!keep) fs.rmSync(shop.dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
}

// ------------------------------------------------------------------ lab trouble: a patched mock adapter

/**
 * The mock adapter with a fault hook, for createApp({ adapters: { mock } }) (index.js keeps claude and agy off
 * under labs:['mock']). decide({ kind, agent, prompt, n }) runs for every turn the runner starts: kind is the
 * turn the mock agent would see (detectTurn of mock-agent.mjs: task, continue, review, qa, plan, ...), n counts
 * the turns of that kind. It returns null (the real mock agent runs) or a fault:
 *   { error:'rate_limit'|'auth'|'model'|'mcp'|'other', resetAt?, model? }  a fake CLI prints that error and ends
 *   { hang:'idle' }   a fake CLI that starts and then prints nothing (the idle watchdog)
 *   { hang:'busy' }   a fake CLI that prints text until it is stopped (the wall-clock timeout)
 * Every turn is recorded in `calls` ({ kind, handle, role, fault }).
 */
export function faultyMock(dirs, decide, { shellEnv: given = null } = {}) {
  const shellEnv = given ?? createShellEnv({ env: hubEnv(dirs) });
  const base = createMockAdapter({ shellEnv });
  const calls = [];
  const counts = {};
  const adapter = {
    ...base,
    buildRun(input) {
      const spec = base.buildRun(input);
      const kind = detectTurn(String(input.prompt ?? '')).kind;
      counts[kind] = (counts[kind] ?? 0) + 1;
      const turn = detectTurn(String(input.prompt ?? ''));
      let fault = null;
      try { fault = decide({ kind, turn, agent: input.agent, cwd: input.cwd, prompt: String(input.prompt ?? ''), n: counts[kind] }) ?? null; } catch { fault = null; }
      calls.push({ kind, handle: input.agent?.handle ?? null, role: input.agent?.role ?? null, provider: input.agent?.provider ?? null, fault: fault ? (fault.error ?? (fault.act ? 'act' : `hang:${fault.hang}`)) : null, at: Date.now() });
      if (!fault) return spec;
      const sid = spec.sessionId ?? input.sessionId ?? 'fault-session';
      // A scripted turn reads the prompt only when it hands over to the real mock agent.
      if (fault.act) return { ...spec, args: ['-e', actScript(fault, sid)], stdin: fault.then === 'mock' ? spec.stdin : '' };
      return { ...spec, args: ['-e', faultScript(fault, sid)], stdin: '' };
    },
  };
  return { adapter, shellEnv, calls };
}

function faultScript(f, sid) {
  const line = (o) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(o)}\n`)});`;
  const init = line({ t: 'init', sessionId: sid, model: 'mock', mcpOk: f.error !== 'mcp', loaded: ['shop'] });
  if (f.hang === 'idle') return `${init} setInterval(() => {}, 1000);`;
  if (f.hang === 'busy') return `${init} setInterval(() => { ${line({ t: 'text', text: 'working' })} }, 100);`;
  const err = { t: 'error', kind: f.error, message: f.message ?? `mock ${f.error}`, resetAt: f.resetAt ?? null, ...(f.model ? { model: f.model } : {}) };
  const result = { t: 'result', ok: false, text: '', sessionId: sid, usd: 0, turns: 1, durationMs: 1 };
  return `${init} ${line(err)} ${line(result)} process.exitCode = 1;`;
}

const MOCK_AGENT_URL = new URL('../../server/providers/mock-agent.mjs', import.meta.url).href;

/**
 * A scripted turn: { act:[{ post:'<ShopTalk line>' } | { tool, args } | { write:'<path in the cwd>', text }],
 * then:'end'|'mock', error? }. The fake CLI calls the real hub tools over MCP as the agent (the same JSON-RPC calls
 * as the mock agent) and writes files, then ends with a success result ('end'), with the error `error` (a fault as
 * in faultyMock, with resetAt and model), or hands the turn to the real mock agent ('mock').
 */
function actScript(f, sid) {
  const acts = (f.act ?? []).map((a) => (a.post ? { tool: 'post', args: { line: a.post } } : a.write ? { write: a.write, text: a.text ?? '' } : { tool: a.tool, args: a.args ?? {} }));
  const fail = f.error ? { t: 'error', kind: f.error, message: f.message ?? `mock ${f.error}`, resetAt: f.resetAt ?? null, ...(f.model ? { model: f.model } : {}) } : null;
  return `
const http = require('node:http');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const url = new URL(String(process.env.SHOP_MCP_URL || '').replace(/\\/+$/, '') + '/' + process.env.SHOP_TOKEN);
let seq = 0;
const rpc = (method, params, notify) => new Promise((resolve, reject) => {
  const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++seq, method, params });
  const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', agent: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-WorkShop': '1', Authorization: 'Bearer ' + process.env.SHOP_TOKEN, Connection: 'close' } }, (res) => {
    const chunks = []; res.on('data', (d) => chunks.push(d));
    res.on('end', () => { if (notify || res.statusCode === 202) return resolve(null); try { const m = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(m.result ?? null); } catch (e) { reject(e); } });
  });
  req.on('error', reject); req.end(body);
});
(async () => {
  const sid = process.env.MOCK_SESSION || ${JSON.stringify(sid)};
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scripted-turn', version: '1' } });
  await rpc('notifications/initialized', {}, true);
  if (${JSON.stringify(f.then !== 'mock')}) out({ t: 'init', sessionId: sid, model: 'mock', mcpOk: true, loaded: ['shop'] });
  for (const a of ${JSON.stringify(acts)}) {
    if (a.write) {
      const fs = require('node:fs'); const p = require('node:path').join(process.cwd(), a.write);
      fs.mkdirSync(require('node:path').dirname(p), { recursive: true }); fs.writeFileSync(p, a.text);
      out({ t: 'tool', name: 'Write', summary: a.write }); out({ t: 'tool_result', ok: true, summary: 'written' });
      continue;
    }
    out({ t: 'tool', name: 'mcp__shop__' + a.tool, summary: JSON.stringify(a.args).slice(0, 150) });
    const r = await rpc('tools/call', { name: a.tool, arguments: a.args });
    const text = ((r && r.content) || []).map((p) => p.text || '').join(' ');
    out({ t: 'tool_result', ok: !(r && r.isError), summary: text.slice(0, 150) });
  }
  if (${JSON.stringify(f.then === 'mock')}) { const m = await import(${JSON.stringify(MOCK_AGENT_URL)}); await m.main(); return; }
  out({ t: 'usage', inTok: 100, outTok: 20, cacheRead: 0, cacheWrite: 0, usd: 0 });
  const fail = ${JSON.stringify(fail)};
  if (fail) { out(fail); out({ t: 'result', ok: false, text: '', sessionId: sid, usd: 0, turns: 1, durationMs: 1 }); process.exitCode = 1; return; }
  out({ t: 'result', ok: true, text: 'scripted turn', sessionId: sid, usd: 0, turns: 1, durationMs: 1 });
})().catch((e) => { out({ t: 'error', kind: 'other', message: String(e.message).slice(0, 200), resetAt: null }); out({ t: 'result', ok: false, text: '', sessionId: null, usd: 0, turns: 0, durationMs: 0 }); process.exitCode = 1; });
`;
}

/**
 * decide() from plain data, so a child process can get it through an environment variable. Each rule:
 *   { kind, buddy?:boolean, role?, provider?, task?:'T2', nth?:1, act?, then?, error?, resetInMs?, hang?, ... }
 * A rule matches a turn of that kind (detectTurn; '*' is any kind) with the given fields; nth counts the matches
 * of that rule.
 * In act lines, {task} is the task of the turn and {id} the message the turn is about (a DONE, an ASK).
 */
export function ruleDecide(rules) {
  const seen = rules.map(() => 0);
  return (c) => {
    const task = c.turn?.task ?? c.agent?.taskId ?? null;
    const fits = (r) => (r.kind === '*' || r.kind === c.kind) && (r.buddy === undefined || Boolean(c.turn?.buddy) === r.buddy)
      && (!r.role || c.agent?.role === r.role) && (!r.provider || c.agent?.provider === r.provider) && (!r.task || task === r.task);
    // Every rule counts every turn it fits, so nth is the nth such turn, whatever the other rules did.
    const hits = rules.map((r, i) => (fits(r) ? ++seen[i] : 0));
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!hits[i] || hits[i] !== (r.nth ?? 1)) continue;
      const { kind, buddy, role, provider, task: _t, nth, ...out } = r;
      const fill = (s) => String(s).replace(/\{task\}/g, task ?? '').replace(/\{id\}/g, String(c.turn?.id ?? ''));
      if (out.act) out.act = out.act.map((a) => (a.post ? { post: fill(a.post) } : a));
      // resetInMs: a reset time relative to the turn start (a rule is plain data, written before the run).
      if (typeof out.resetInMs === 'number') { out.resetAt = Date.now() + out.resetInMs; delete out.resetInMs; }
      return out;
    }
    return null;
  };
}

// ------------------------------------------------------------------ two labs, both played by the mock agent

/**
 * Two labs for the cross-lab paths (fallback to the other lab): the claude and agy adapters with their real
 * names, models and probes, but buildRun and the parser of the mock adapter, so every turn runs the mock agent.
 * The binaries they "locate" are tiny fake scripts in the temp folder: detect() runs `<fake> --version` and
 * `<fake> auth status --json` on them. No real AI CLI ever runs. Returns { app (createApp options), settings, calls }.
 */
export function twoLabs(dirs, decide = () => null) {
  const shellEnv = createShellEnv({ env: hubEnv(dirs) });
  const bin = path.join(dirs.tmp, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 });
  const keysFile = path.join(dirs.dataDir, 'keys.json');
  fs.writeFileSync(keysFile, `${JSON.stringify({ anthropic: 'sk-ant-twolabs-0000000000', gemini: 'AIza-twolabs-000000000000' }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(keysFile, 0o600);
  const claudeBin = path.join(bin, 'claude');
  const agyBin = path.join(bin, 'agy');
  fs.writeFileSync(claudeBin, '#!/bin/sh\ncase "$1" in\n  --version) echo "9.9.9 (fake for tests)" ;;\n  auth) echo \'{"loggedIn": true}\' ;;\n  *) echo "fake claude: a test never runs a turn here" >&2; exit 1 ;;\nesac\n', { mode: 0o755 });
  fs.writeFileSync(agyBin, '#!/bin/sh\necho "fake agy: a test never runs it" >&2\nexit 1\n', { mode: 0o755 });
  const fm = faultyMock(dirs, decide, { shellEnv });
  const run = { buildRun: fm.adapter.buildRun, createParser: fm.adapter.createParser };
  const claude = { ...createClaudeAdapter({ shellEnv }), ...run, locate: () => claudeBin };
  const gemini = { ...createGeminiAdapter({ shellEnv }), ...run, locate: () => agyBin };
  const oss = {
    ...createOssAdapter({ shellEnv, getSettings: () => ({ oss: { standIn: false, baseUrl: 'http://127.0.0.1:1/v1' } }) }),
    probeEndpoint: async () => ({ ok: false, models: null, detail: 'off in twoLabs' }),
  };
  const ack = { mode: 'apikey', ts: 1 };
  return {
    app: { labs: null, adapters: { claude, gemini, oss, mock: fm.adapter }, shellEnv },
    settings: {
      auth: { claude: 'apikey', gemini: 'apikey' },
      authAck: { claude: ack, gemini: ack },
      oss: { engine: 'ollama', baseUrl: 'http://127.0.0.1:1/v1', standIn: false },
      safety: 'trusting',
      providers: { gemini: { authOk: true, version: '1.5.1' } },
    },
    calls: fm.calls,
  };
}

/**
 * The crash hub of crash-hub.mjs with two labs (twoLabs with the rules of WS_RULES), for crashRun's twoLabRules.
 * The real entry point (main) with --labs mock --secrets file; the createApp options then give it the two fake
 * labs, as bootShop does for twoLabs. One trigger: { point:'spawn', kind, buddy?, nth?, afterMs? } kills the hub
 * afterMs after the agent process of the nth turn of that kind (detectTurn: consult, audit, review with buddy:true,
 * ...) is built, right before its spawn. A turn start is not a spawn: the runner can queue a turn.
 */
const TWO_LAB_CRASH_HUB = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { main } from ${JSON.stringify(new URL('../../server/index.js', import.meta.url).href)};
import { twoLabs, ruleDecide } from ${JSON.stringify(import.meta.url)};
const spec = JSON.parse(process.env.WS_CRASH || '{}');
const turnsFile = process.env.WS_TURNS;
const rules = ruleDecide(JSON.parse(process.env.WS_RULES || '[]'));
let n = 0;
const labs = twoLabs(JSON.parse(process.env.WS_DIRS), (c) => {
  if (spec.point === 'spawn' && c.kind === spec.kind && (spec.buddy === undefined || Boolean(c.turn.buddy) === spec.buddy) && ++n === (spec.nth ?? 1)) fire();
  return rules(c);
});
const agentProcs = () => { try { return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\\n').map((l) => /^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$/.exec(l)).filter((m) => m && Number(m[2]) === process.pid && /mock-agent/.test(m[3])).length; } catch { return 0; } };
let fired = false;
const kill = () => { try { fs.writeFileSync(turnsFile + '.crash', JSON.stringify({ at: Date.now(), spec, agents: agentProcs() })); } catch {} process.kill(process.pid, 'SIGKILL'); };
const fire = () => { if (fired) return; fired = true; if ((spec.afterMs ?? 0) > 0) setTimeout(kill, spec.afterMs); else kill(); };
const app = await main(JSON.parse(process.env.WS_ARGS), process.env, {
  tickMs: 150, runnerTuning: { minSpawnGapMs: 50 }, orchTuning: { managerDebounceMs: 300, managerMaxDelayMs: 1500 },
  power: { hold() {}, release() {} }, pickFolder: async () => null, reveal: async () => {}, ...labs.app,
});
const run = app.runner.run;
app.runner.run = async (agentId, o) => {
  const a = app.store.get('agents', agentId);
  try { fs.appendFileSync(turnsFile, JSON.stringify({ hub: 1, agentId, handle: a && a.handle, provider: a && a.provider, kind: o.kind, taskId: o.taskId ?? null, head: String(o.prompt ?? '').slice(0, 300), at: Date.now() }) + '\\n'); } catch {}
  return run.call(app.runner, agentId, o);
};
`;
