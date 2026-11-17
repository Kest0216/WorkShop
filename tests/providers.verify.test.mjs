// Verifier tests for the providers group after the contract alignment (docs/ARCHITECTURE.md section 10).
// Each test pins one defect that the alignment left: a self-test that did not run must not store a result,
// the self-test gate is only for the hidden self-test agent, the apikey budget cap reaches the CLI, errors are
// redacted before the token exists, the agy URL file stays in the run folder, the agy check takes a settings
// file (never inline JSON), and an unknown CLI version says so. No real agent CLI runs here.
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
import { createParser as createMockParser } from '../server/providers/mock.js';
import { createProviders } from '../server/providers/index.js';
import { createGeminiAdapter } from '../server/providers/gemini.js';
import { createClaudeAdapter } from '../server/providers/claude.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FAKE = path.join(HERE, 'fixtures', 'fake-agent.mjs');

function tmp(t, prefix = 'ws-verify-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A runner over a fake adapter that spawns tests/fixtures/fake-agent.mjs (model = the fake agent's mode). */
function setup(t, { auth = {}, limits = {}, redactor = null, keyEnv } = {}) {
  const dir = tmp(t, 'ws-verify-runner-');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const paths = { server: path.join(ROOT, 'server'), data: path.join(dir, 'data'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') };
  const store = createStore({ dataDir: paths.data });
  const mcp = createMcp({ store });
  const settings = { limits: { maxAgents: 6, perProvider: { fake: 6 }, ...limits }, auth: { fake: 'subscription', ...auth }, safety: 'sandboxed' };
  const built = [];
  const state = { url: 'http://127.0.0.1:1/mcp' };
  const adapter = {
    id: 'fake', label: 'fake', selfTestModel: 'selftest',
    buildRun(o) {
      built.push(o);
      return {
        cmd: o.model === 'enoent' ? path.join(dir, 'no-such-binary') : process.execPath,
        args: [FAKE, o.model, work, o.agent.id, '300'],
        env: { PATH: '/usr/bin:/bin', FAKE_MCP_URL: o.mcp.url, FAKE_MCP_TOKEN: o.mcp.token, WORKSHOP_TOKEN: o.mcp.token, FAKE_DENY: path.join(paths.run, 'selftest') },
        cwd: o.cwd, stdin: o.prompt, stopSignal: 'SIGINT', files: [], hubFiles: {}, sessionId: o.sessionId,
      };
    },
    createParser: () => createMockParser(),
  };
  const providers = {
    usableNow: true, readyNow: true, cooled: [],
    get(id) { if (id !== 'fake') throw new Error(`Unknown provider: ${id}`); return adapter; },
    status(id) { return { id, installed: true, path: process.execPath, mode: settings.auth[id], auth: 'ok', cooling: null, cooledModels: {}, usable: this.usableNow, reason: this.usableNow ? null : 'Run the self-test for this CLI version.' }; },
    usable() { return this.usableNow; },
    ready() { return { ok: this.readyNow, reason: this.readyNow ? null : 'not ready' }; },
    modelUsable() { return this.usableNow; },
    async detect() { return []; },
    keyEnv: keyEnv ?? (async () => ({})),
    cool(id, until, reason, opts) { this.cooled.push({ id, until, reason, opts }); },
    noteSuccess() {}, markAuth() {},
  };
  const logs = [];
  const runner = createRunner({
    store, providers, mcp, redactor, paths, getSettings: () => settings, getMcpUrl: () => state.url,
    log: (level, msg, data) => logs.push({ level, msg, data }),
    tuning: { minSpawnGapMs: 0, killGraceMs: 300, shutdownGraceMs: 200, closeWaitMs: 300, logFlushMs: 50 },
  });
  t.after(async () => { await runner.shutdown(); await store.flush(); });
  const agent = (id, extra = {}) => store.put('agents', { id, jobId: null, name: id, handle: `@${id}`, role: 'maker', provider: 'fake', model: 'normal', status: 'idle', taskId: null, sessionId: null, stats: {}, ...extra });
  const go = (id, opts = {}) => runner.run(id, { prompt: 'Do the task.', systemPrompt: 'Role card.', cwd: work, ...opts });
  const listen = async () => {
    const http = createHttp({ ownerKey: 'test-owner-key-0123456789', log: () => {} });
    mountMcp(http, mcp);
    const { url } = await http.listen();
    t.after(() => http.close());
    state.url = `${url}/mcp`;
  };
  return { dir, work, paths, store, settings, providers, runner, built, agent, go, listen, logs };
}

// ------------------------------------------------------------------------------------------- self-test

test('a self-test that did not run (no process, or a lab stop before any check) returns no core checks, so nothing is stored', async (t) => {
  const w = setup(t);
  await w.listen();
  const noProcess = await w.runner.selfTest('fake', { model: 'enoent' });
  assert.equal(noProcess.steps.find((s) => s.name === 'process started')?.ok, false);
  assert.deepEqual([noProcess.ok, noProcess.core, noProcess.advisory], [false, [], []], 'a test that never ran has no check results');

  const limited = await w.runner.selfTest('fake', { model: 'ratelimit' });
  assert.equal(limited.ok, false);
  assert.deepEqual([limited.core, limited.advisory], [[], []], 'a rate limit before any check is no containment result');

  // A turn that ran fine but skipped the checks still fails every core check (it never passes by default).
  const skipped = await w.runner.selfTest('fake', { model: 'normal' });
  assert.equal(skipped.core.length, 3);
  assert.ok(skipped.core.every((c) => !c.ok));

  // Through the registry: a stored pass is not overwritten by a test that did not run.
  const dir = tmp(t);
  let settings = { auth: { claude: 'apikey' }, authAck: { claude: { mode: 'apikey', ts: 1 } }, selfTest: { claude: { version: '2.1.289', ok: true, core: [], advisory: [], ts: 1 } }, safety: 'sandboxed' };
  const providers = createProviders({
    secrets: { list: async () => [{ id: 'anthropic', envVar: 'ANTHROPIC_API_KEY', set: true }], envFor: async () => ({ ANTHROPIC_API_KEY: 'sk-ant-verify' }) },
    shellEnv: { path: '/usr/bin:/bin', resolve: () => null, base: () => ({ HOME: dir, PATH: '/usr/bin:/bin' }) },
    getSettings: () => settings, updateSettings: (patch) => { settings = { ...settings, ...patch, selfTest: { ...settings.selfTest, ...patch.selfTest } }; return settings; },
    paths: { run: path.join(dir, 'run') },
  });
  t.after(() => providers.dispose());
  providers.setSelfTest(async () => noProcess);
  await providers.selfTest('claude');
  assert.equal(settings.selfTest.claude.ok, true, 'the earlier pass stays');
});

test('kind "selftest" opens the self-test gate only for the hidden self-test agent', async (t) => {
  const w = setup(t);
  w.providers.usableNow = false; // only the self-test pass is missing
  w.agent('A1');
  const res = await w.go('A1', { kind: 'selftest' });
  assert.deepEqual([res.started, res.ok], [false, false], 'a normal agent cannot skip the self-test rule with kind selftest');
  assert.match(res.error.message, /self-test/);
});

// ------------------------------------------------------------------------------------------- budget

test('apikey turns: --max-budget-usd gets min(opts, limits.turnUsd, the budget that remains); a used-up budget starts nothing', async (t) => {
  const w = setup(t, { auth: { fake: 'apikey' }, limits: { turnUsd: 5 } });
  w.store.put('jobs', { id: 'J1', title: 'job', cost: { billedUsd: 9.25, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd: 10 });
  w.store.put('jobs', { id: 'J2', title: 'rich', cost: { billedUsd: 0, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd: 100 });
  w.store.put('jobs', { id: 'J3', title: 'spent', cost: { billedUsd: 10, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd: 10 });
  w.agent('K1', { jobId: 'J1' });
  w.agent('K2', { jobId: 'J2' });
  w.agent('K3', { jobId: 'J3' });
  w.agent('K4', { jobId: null });
  await w.go('K1');
  assert.equal(w.built.at(-1).maxBudgetUsd, 0.75, 'the budget that remains');
  await w.go('K2');
  assert.equal(w.built.at(-1).maxBudgetUsd, 5, 'limits.turnUsd');
  await w.go('K2', { maxBudgetUsd: 2 });
  assert.equal(w.built.at(-1).maxBudgetUsd, 2, 'the caller may go lower');
  await w.go('K4');
  assert.equal(w.built.at(-1).maxBudgetUsd, 5, 'a turn without a job still has the turn cap');
  const before = w.built.length;
  const spent = await w.go('K3');
  assert.equal(w.built.length, before, 'no spawn for a job whose budget is used up');
  assert.deepEqual([spent.started, spent.killed], [false, 'interrupt']);
  assert.match(spent.error.message, /budget/);
});

test('subscription turns get no budget cap', async (t) => {
  const w = setup(t, { limits: { turnUsd: 5 } });
  w.store.put('jobs', { id: 'J1', title: 'job', cost: { billedUsd: 0, estUsd: 50, inTok: 0, outTok: 0 }, budgetUsd: 10 });
  w.agent('S1', { jobId: 'J1' });
  const res = await w.go('S1', { maxBudgetUsd: 3 });
  assert.equal(res.ok, true, 'estUsd never stops a subscription turn');
  assert.equal(w.built.at(-1).maxBudgetUsd, undefined);
});

test('claude: a tiny budget is never sent as 0', () => {
  const shellEnv = { resolve: () => null, base: () => ({ HOME: '/home/owner', PATH: '/usr/bin:/bin' }) };
  const spec = createClaudeAdapter({ shellEnv }).buildRun({
    model: 'claude-haiku-5-5', prompt: 'p', systemPrompt: 's', cwd: '/w', runDir: '/r', mode: 'apikey', keyEnv: { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxx' },
    mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok-0123456789' }, maxBudgetUsd: 0.00001,
  });
  const value = spec.args[spec.args.indexOf('--max-budget-usd') + 1];
  assert.ok(Number(value) > 0, `--max-budget-usd ${value}`);
});

// ------------------------------------------------------------------------------------------- sessions

test('a resume turn that never started returns the session id it was given (the caller must not lose it)', async (t) => {
  const w = setup(t, { auth: { fake: 'apikey' }, limits: { maxAgents: 1 } });
  w.store.put('jobs', { id: 'J1', title: 'job', cost: { billedUsd: 0, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd: 1 });
  // Refused at start (the lab is not usable now).
  w.providers.usableNow = false;
  w.agent('A1');
  const refused = await w.go('A1', { sessionId: 'S-A1', resume: true });
  assert.deepEqual([refused.started, refused.sessionId], [false, 'S-A1']);
  w.providers.usableNow = true;
  // Waiting in the queue, then ended by cancel, interrupt and the budget stop.
  w.agent('R1', { jobId: 'J1', model: 'idle' });
  w.agent('Q1', { jobId: 'J1' });
  w.agent('Q2', { jobId: 'J1' });
  const running = w.go('R1');
  const q1 = w.go('Q1', { sessionId: 'S-Q1', resume: true });
  const q2 = w.go('Q2', { sessionId: 'S-Q2', resume: true });
  assert.equal(w.runner.interrupt('Q1', 'hard pause'), true);
  assert.equal(w.runner.cancel('Q2', 'owner'), true);
  assert.deepEqual([(await q1).sessionId, (await q1).killed], ['S-Q1', 'interrupt']);
  assert.deepEqual([(await q2).sessionId, (await q2).killed], ['S-Q2', 'cancel']);
  // A fresh turn that never started has no session.
  w.agent('F1', { jobId: 'J1' });
  const fresh = w.go('F1');
  w.runner.cancel('F1');
  assert.equal((await fresh).sessionId, null);
  w.runner.cancel('R1');
  await running;
  // Budget used up: a resume turn that is refused keeps its session too.
  w.store.patch('jobs', 'J1', { cost: { billedUsd: 1, estUsd: 0, inTok: 0, outTok: 0 } });
  w.agent('B1', { jobId: 'J1' });
  const spent = await w.go('B1', { sessionId: 'S-B1', resume: true });
  assert.deepEqual([spent.started, spent.killed, spent.sessionId], [false, 'interrupt', 'S-B1']);
});

// ------------------------------------------------------------------------------------------- file modes

test('the raw agent log is mode 0600 in a 0700 logs folder (section 14), also after a rotation', async (t) => {
  const w = setup(t);
  w.agent('A1');
  assert.equal((await w.go('A1')).ok, true);
  const file = path.join(w.paths.logs, 'A1.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(w.paths.logs).mode & 0o777, 0o700);
  fs.chmodSync(file, 0o644); // a log from an older hub
  assert.equal((await w.go('A1')).ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'an existing log is narrowed too');
});

// ------------------------------------------------------------------------------------------- redaction

test('an error before the token exists is redacted by the shared redactor too', async (t) => {
  const SECRET = 'sk-ant-api03-stored-value-0123456789';
  const redactor = { redact: (text) => String(text).split(SECRET).join('[redacted]') };
  const w = setup(t, { redactor, keyEnv: async () => { throw new Error(`keychain said ${SECRET}`); } });
  w.agent('A1');
  const res = await w.go('A1');
  assert.equal(res.ok, false);
  assert.equal(res.error.message.includes(SECRET), false, res.error.message);
  assert.equal(JSON.stringify(w.logs).includes(SECRET), false, 'the hub log');
});

// ------------------------------------------------------------------------------------------- agy adapter

const AGY_ENV = (dir) => ({ resolve: () => path.join(dir, 'agy'), base: () => ({ HOME: dir, PATH: '/usr/bin:/bin' }) });

test('agy: the URL file must resolve inside the run folder (no .. escape)', (t) => {
  const dir = tmp(t);
  const adapter = createGeminiAdapter({ shellEnv: AGY_ENV(dir) });
  const runDir = path.join(dir, 'run', 'A1');
  const base = { model: 'gemini-4-hydrogen', prompt: 'p', systemPrompt: 's', cwd: path.join(dir, 'w'), runDir, mode: 'subscription' };
  const mcp = { url: 'http://127.0.0.1:1/mcp', token: 'tok-0123456789', shimPath: '/s/shim.mjs' };
  assert.throws(() => adapter.buildRun({ ...base, mcp: { ...mcp, urlFile: path.join(runDir, '..', '..', 'w', 'mcp-url') } }), /inside the run folder/);
  assert.throws(() => adapter.buildRun({ ...base, mcp: { ...mcp, urlFile: `${runDir}/../A2/mcp-url` } }), /inside the run folder/);
  const ok = adapter.buildRun({ ...base, mcp: { ...mcp, urlFile: path.join(runDir, 'mcp-url') } });
  assert.equal(ok.files[0].path, path.join(runDir, 'mcp-url'));
});

test('agy check in apikey mode: --settings names a file in the run folder, never inline JSON', async (t) => {
  const dir = tmp(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // A fake agy under the temp folder (the guard refuses anything else): it records its arguments and the file.
  fs.writeFileSync(path.join(bin, 'agy'), [
    '#!/bin/sh',
    `echo "$@" >> "${dir}/agy-calls.log"`,
    'cat > /dev/null',
    'if [ "$1" = "--settings" ]; then cat "$2" > "' + dir + '/agy-settings.seen" 2>/dev/null; fi',
    'for a in "$@"; do last="$a"; done',
    'case "$last" in models) echo gemini-4-hydrogen-low;; --version) echo 1.5.8;; *) exit 2;; esac',
  ].join('\n'), { mode: 0o755 });
  const settings = { auth: { claude: null, gemini: 'apikey' }, authAck: { gemini: { mode: 'apikey', ts: 1 } }, safety: 'trusting' };
  const providers = createProviders({
    secrets: { list: async () => [{ id: 'gemini', envVar: 'GEMINI_API_KEY', set: true }], envFor: async () => ({ GEMINI_API_KEY: 'AIza-test-key-0123456789' }) },
    shellEnv: { path: `${bin}:/usr/bin:/bin`, resolve: (name) => (fs.existsSync(path.join(bin, name)) ? path.join(bin, name) : null), base: () => ({ HOME: dir, PATH: `${bin}:/usr/bin:/bin` }) },
    getSettings: () => settings, updateSettings: () => settings, paths: { run: path.join(dir, 'run') }, timeouts: { agyModels: 60_000, probe: 60_000 },
  });
  t.after(() => providers.dispose());
  const status = await providers.checkAuth('gemini');
  assert.equal(status.auth, 'ok');
  const calls = fs.readFileSync(path.join(dir, 'agy-calls.log'), 'utf8');
  assert.equal(calls.includes('{'), false, `no argument holds JSON: ${calls}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'agy-settings.seen'), 'utf8')), { modelProvider: 'gemini' });
  assert.equal(calls.includes('AIza-test-key'), false, 'the key is never an argument');
});

// ------------------------------------------------------------------------------------------- registry

test('an unknown CLI version gives its own reason: a self-test pass cannot count without one', async (t) => {
  const dir = tmp(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // --version prints nothing a version parser can read; auth status says signed in.
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "unknown build";;\n  auth) echo \'{"loggedIn": true}\';;\nesac\n', { mode: 0o755 });
  const settings = { auth: { claude: 'apikey' }, authAck: { claude: { mode: 'apikey', ts: 1 } }, selfTest: { claude: { version: null, ok: true, core: [], advisory: [], ts: 1 } }, safety: 'sandboxed' };
  const providers = createProviders({
    secrets: { list: async () => [{ id: 'anthropic', envVar: 'ANTHROPIC_API_KEY', set: true }], envFor: async () => ({ ANTHROPIC_API_KEY: 'sk-ant-verify' }) },
    shellEnv: { path: `${bin}:/usr/bin:/bin`, resolve: (name) => (fs.existsSync(path.join(bin, name)) ? path.join(bin, name) : null), base: () => ({ HOME: dir, PATH: `${bin}:/usr/bin:/bin` }) },
    getSettings: () => settings, updateSettings: () => settings, paths: { run: path.join(dir, 'run') }, timeouts: { probe: 60_000 },
  });
  t.after(() => providers.dispose());
  await providers.detect({ force: true });
  const st = providers.status('claude');
  assert.equal(st.usable, false);
  assert.match(st.reason, /version/i);
  assert.doesNotMatch(st.reason, /^Run the self-test/, 'a new self-test would not help: the version is unknown');
});
