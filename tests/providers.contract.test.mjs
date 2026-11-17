// Registry and adapter rules of the amended contract (docs/ARCHITECTURE.md section 10): the ack of the auth
// mode, the self-test gate, model cooling as one episode, modelUsable, policy notes, the sign-in steps, and the
// Claude settings file with the mail hook shape. Fake binaries only: no real claude or agy runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviders, onModelList, LOGIN_STEPS } from '../server/providers/index.js';
import { createClaudeAdapter, SANDBOX_HIDDEN_ENV, MAIL_HOOK_COMMAND } from '../server/providers/claude.js';
import { MAIL_HOOK } from '../server/runner.js';

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-prov-contract-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sh = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
const merge = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v; return out; };

/** A registry over a fake claude (version 2.1.289, signed in) and an optional fake agy file. */
function world(t, { settings: initial = {}, agy = false, keys = { anthropic: 'sk-ant-test', gemini: 'g-test' }, clock } = {}) {
  const dir = tmp(t);
  const bin = path.join(dir, 'bin');
  sh(path.join(bin, 'claude'), 'case "$1" in\n  --version) echo "2.1.289 (Claude Code)";;\n  auth) echo \'{"loggedIn": true}\';;\n  *) exit 9;;\nesac');
  if (agy) sh(path.join(bin, 'agy'), 'echo "agy must not run in these tests" >&2; exit 99');
  const shellEnv = {
    path: `${bin}:/usr/bin:/bin`,
    resolve: (name) => { const f = path.join(bin, String(name)); return fs.existsSync(f) ? f : null; },
    base: () => ({ HOME: dir, USER: 'owner', LOGNAME: 'owner', SHELL: '/bin/zsh', TERM: 'dumb', LANG: 'en_US.UTF-8', TMPDIR: `${dir}/`, PATH: `${bin}:/usr/bin:/bin` }),
  };
  let settings = merge({ auth: { claude: null, gemini: null }, authAck: { claude: null, gemini: null }, selfTest: { claude: null, gemini: null }, safety: 'sandboxed' }, initial);
  const patches = [];
  const secrets = {
    list: async () => [
      { id: 'anthropic', envVar: 'ANTHROPIC_API_KEY', set: !!keys.anthropic },
      { id: 'gemini', envVar: 'GEMINI_API_KEY', set: !!keys.gemini },
    ],
    envFor: async (id) => (id === 'claude' && keys.anthropic ? { ANTHROPIC_API_KEY: keys.anthropic } : id === 'gemini' && keys.gemini ? { GEMINI_API_KEY: keys.gemini } : {}),
  };
  const providers = createProviders({
    secrets, shellEnv,
    getSettings: () => settings, updateSettings: (patch) => { patches.push(patch); settings = merge(settings, patch); return settings; },
    paths: { run: path.join(dir, 'run') }, timeouts: { probe: 60_000 }, ...(clock ? { now: () => clock.t } : {}),
  });
  t.after(() => providers.dispose());
  return { dir, providers, patches, settings: () => settings, set: (patch) => { settings = merge(settings, patch); } };
}

const API = { auth: { claude: 'apikey' } };
const ACK = { authAck: { claude: { mode: 'apikey', ts: 1 } } };
const PASS = { selfTest: { claude: { version: '2.1.289', ok: true, core: [], advisory: [], ts: 2 } } };

test('A12: usable needs authAck for the chosen mode', async (t) => {
  const w = world(t, { settings: { ...API, safety: 'trusting' } });
  await w.providers.detect();
  let st = w.providers.status('claude');
  assert.deepEqual([st.usable, st.ack, st.reason], [false, false, 'Confirm the sign-in mode for this lab (read the note first).']);
  w.set({ authAck: { claude: { mode: 'subscription', ts: 1 } } });
  assert.equal(w.providers.usable('claude'), false, 'an ack of the other mode does not count');
  w.set(ACK);
  st = w.providers.status('claude');
  assert.deepEqual([st.usable, st.ack, st.reason], [true, true, null]);
  assert.equal(w.providers.status('mock').ack, true, 'the mock lab needs no ack');
  assert.equal(w.providers.status('oss').ack, true, 'the oss lab needs no ack');
});

test('A12: policyNote: 3 lines and a source link per Frontier lab (apikey only) and OSS modes; openLogin disabled', async (t) => {
  const w = world(t);
  await w.providers.detect();
  for (const id of ['claude', 'gemini']) {
    const note = w.providers.status(id).policyNote;
    assert.equal(note.subscription, undefined, `${id} disables subscription policy note`);
    assert.equal(note.apikey.lines.length, 3, `${id} apikey`);
    assert.ok(note.apikey.lines.every((line) => typeof line === 'string' && line.length > 10));
    assert.match(note.apikey.url, /^https:\/\//);
    assert.match(note.apikey.lines.join(' '), /per token/i);
    assert.match(note.apikey.lines.join(' '), /allowed/i);
  }
  const ossNote = w.providers.status('oss').policyNote;
  assert.equal(ossNote.local.lines.length, 3, 'oss local');
  assert.ok(ossNote.local.lines.every((line) => typeof line === 'string' && line.length > 10));
  assert.deepEqual(LOGIN_STEPS, ['Terminal opens', 'Sign in there', 'Come back and click Re-check']);
});

test('A08: in safety sandboxed, usable needs a self-test pass for the installed CLI version', async (t) => {
  const w = world(t, { settings: { ...API, ...ACK, selfTest: { claude: { version: '2.1.288', ok: true, ts: 5 } } } });
  await w.providers.detect();
  let st = w.providers.status('claude');
  assert.deepEqual([st.version, st.usable, st.reason], ['2.1.289', false, 'Run the self-test for this CLI version.'], 'a pass for an older version does not count');
  assert.deepEqual(st.selfTest, { version: '2.1.288', ok: true, ts: 5 });
  w.set({ selfTest: { claude: { version: '2.1.289', ok: false, ts: 6 } } });
  assert.equal(w.providers.usable('claude'), false, 'a failed test does not count');
  w.set(PASS);
  assert.equal(w.providers.usable('claude'), true);
  w.set({ safety: 'trusting', selfTest: { claude: { version: '0.0.1', ok: false } } });
  assert.equal(w.providers.usable('claude'), true, 'trusting: no self-test needed');
  w.set({ safety: 'sandboxed' });
  assert.equal(w.providers.usable('mock'), true, 'the mock lab needs no self-test');
});

test('A08: selfTest runs when every other condition holds, and stores { version, ok, core, advisory, ts }', async (t) => {
  const clock = { t: 1_000_000 };
  const w = world(t, { settings: { ...API, ...ACK }, clock });
  await w.providers.detect();
  assert.equal(w.providers.usable('claude'), false);
  assert.deepEqual(w.providers.ready('claude'), { ok: true, reason: null }, 'ready: everything but the self-test');
  const core = [{ name: 'write outside the turn folder', ok: true, detail: 'refused' }];
  const advisory = [{ name: 'reach a host that is not a registry or localhost', ok: false, detail: 'the host answered' }];
  let calls = 0;
  w.providers.setSelfTest(async () => { calls += 1; return { ok: true, core, advisory, steps: [], loaded: ['shop'], logTail: [] }; });
  const res = await w.providers.selfTest('claude');
  assert.equal(calls, 1);
  assert.deepEqual(res.loaded, ['shop']);
  assert.deepEqual(w.settings().selfTest.claude, { version: '2.1.289', ok: true, core, advisory, ts: 1_000_000 });
  assert.equal(w.providers.usable('claude'), true, 'the stored pass makes the lab usable');

  w.providers.setSelfTest(async () => ({ ok: true, core: [{ name: 'print the agent token', ok: false, detail: 'printed' }], advisory: [], steps: [], loaded: [], logTail: [] }));
  await w.providers.selfTest('claude');
  assert.equal(w.settings().selfTest.claude.ok, false, 'ok only when every core check passed');
  assert.equal(w.providers.usable('claude'), false);

  const patchesBefore = w.patches.length;
  w.providers.setSelfTest(async () => ({ ok: false, core: [], advisory: [], steps: [{ name: 'ready to use', ok: false, detail: 'x' }], loaded: [], logTail: [] }));
  await w.providers.selfTest('claude');
  await w.providers.selfTest('mock');
  assert.equal(w.patches.length, patchesBefore, 'a test that did not run, and the mock lab, store nothing');

  w.set({ authAck: { claude: null } });
  assert.deepEqual(w.providers.ready('claude'), { ok: false, reason: 'Confirm the sign-in mode for this lab (read the note first).' });
});

test('A11: a limit that names a model cools that model only; modelUsable', async (t) => {
  const clock = { t: Date.now() };
  const w = world(t, { settings: { ...API, ...ACK, ...PASS }, clock });
  await w.providers.detect();
  const until = clock.t + 3600_000;
  const st = w.providers.cool('claude', until, 'weekly', { model: 'claude-fable-5-2', turnStartedAt: clock.t - 10 });
  assert.equal(st.usable, true, 'the lab stays usable');
  assert.equal(st.cooling, null);
  assert.deepEqual(st.cooledModels, { 'claude-fable-5-2': { until, reason: 'weekly' } });
  assert.equal(w.providers.usable('claude'), true);
  assert.equal(w.providers.modelUsable('claude', 'claude-fable-5-2'), false);
  assert.equal(w.providers.modelUsable('claude', 'claude-opus-5-5'), true);
  clock.t = until + 1;
  assert.equal(w.providers.modelUsable('claude', 'claude-fable-5-2'), true, 'usable again after the reset time');
  assert.deepEqual(w.providers.status('claude').cooledModels, {});
  assert.equal(w.providers.modelUsable('nope', 'x'), false);
  w.providers.cool('claude', clock.t + 60_000, 'lab limit');
  assert.equal(w.providers.modelUsable('claude', 'claude-opus-5-5'), false, 'a cooled lab cools every model');
});

test('A11: modelUsable follows the account list of the lab (agy slugs <model>-<effort>)', async (t) => {
  const w = world(t, { agy: true, settings: { auth: { gemini: 'apikey' }, authAck: { gemini: { mode: 'apikey', ts: 1 } }, safety: 'trusting', providers: { gemini: { authOk: true, version: '1.5.1', models: ['gemini-4-hydrogen-low'] } } } });
  await w.providers.detect();
  assert.equal(w.providers.usable('gemini'), true);
  assert.equal(w.providers.modelUsable('gemini', 'gemini-4-hydrogen'), true);
  assert.equal(w.providers.modelUsable('gemini', 'gemini-4-carbon'), false, 'not on this account');
  w.set({ providers: { gemini: { models: null } } });
  await w.providers.refresh();
  assert.equal(w.providers.modelUsable('gemini', 'gemini-4-hydrogen'), true);
  assert.equal(w.providers.modelUsable('gemini', 'gemini-4-carbon'), true, 'no list: no limit');
  assert.equal(onModelList(['gemini-3.5-flash-lite'], 'gemini-3.5-flash'), false, 'a longer name is not an effort');
  assert.equal(onModelList(['gemini-4-argon'], 'gemini-4-argon'), true);
});

test('A11: cooling is one episode: 5 min step, doubled only when the first turn after a reset fails', async (t) => {
  const clock = { t: 10_000_000 };
  const w = world(t, { settings: { ...API, ...ACK, ...PASS }, clock });
  await w.providers.detect();
  const MIN = 60_000;
  const t0 = clock.t;
  // Four turns that all started before the first limit came in: one episode.
  for (let i = 0; i < 4; i++) w.providers.cool('claude', null, `limit ${i}`, { turnStartedAt: t0 - 1000 });
  let st = w.providers.status('claude');
  assert.equal(st.cooling.until, t0 + 5 * MIN, 'one episode of 5 min');
  assert.equal(st.cooling.reason, 'limit 0', 'the late results were ignored');
  // After the reset the first turn fails again: 10 min.
  clock.t = t0 + 5 * MIN + 1;
  assert.equal(w.providers.usable('claude'), true);
  w.providers.cool('claude', null, 'again', { turnStartedAt: clock.t });
  assert.equal(w.providers.status('claude').cooling.until, clock.t + 10 * MIN);
  // A late success while the pause runs does not end it.
  w.providers.noteSuccess('claude');
  assert.equal(w.providers.usable('claude'), false);
  // After the reset: a success resets the step; the next failure is 5 min again.
  clock.t += 10 * MIN + 1;
  w.providers.noteSuccess('claude', 'claude-haiku-5-5');
  w.providers.cool('claude', null, 'fresh', { turnStartedAt: clock.t });
  assert.equal(w.providers.status('claude').cooling.until, clock.t + 5 * MIN);
  // The step doubles to 60 min at most.
  const steps = [];
  for (let i = 0; i < 6; i++) {
    clock.t = w.providers.status('claude').cooling.until + 1;
    const startedAt = clock.t;
    w.providers.cool('claude', null, 'x', { turnStartedAt: startedAt });
    steps.push((w.providers.status('claude').cooling.until - clock.t) / MIN);
  }
  assert.deepEqual(steps, [10, 20, 40, 60, 60, 60]);
  // A reset time from the CLI wins over the step, and a call without turnStartedAt is never ignored.
  clock.t = w.providers.status('claude').cooling.until + 1;
  w.providers.cool('claude', clock.t + 3 * MIN, 'resets soon');
  assert.equal(w.providers.status('claude').cooling.until, clock.t + 3 * MIN);
  // A model has its own episode.
  w.providers.cool('claude', null, 'opus weekly', { model: 'claude-opus-5-5', turnStartedAt: clock.t });
  assert.equal(w.providers.status('claude').cooledModels['claude-opus-5-5'].until, clock.t + 5 * MIN);
});

test('A24: the Claude settings file and the mail hook shape (on since its provider test passed)', (t) => {
  const dir = tmp(t);
  const shellEnv = { path: '/usr/bin:/bin', resolve: () => '/c', base: () => ({ HOME: dir, PATH: '/usr/bin:/bin' }) };
  const adapter = createClaudeAdapter({ shellEnv });
  const base = { agent: { id: 'A1' }, model: 'claude-sonnet-5-5', effort: 'low', prompt: 'p', systemPrompt: 's', cwd: path.join(dir, 'bench'), runDir: path.join(dir, 'run', 'A1'), mode: 'subscription', mcp: { url: 'http://127.0.0.1:4317/mcp', token: 'tok-secret-123' } };
  const settingsOf = (spec) => JSON.parse(spec.files.find((f) => f.path === path.join(dir, 'run', 'A1', 'settings.json')).content);

  const off = adapter.buildRun(base);
  assert.equal(off.args[off.args.indexOf('--settings') + 1], path.join(dir, 'run', 'A1', 'settings.json'));
  assert.ok(off.args.every((a) => !a.includes('{')), 'no argument holds JSON');
  const offSettings = settingsOf(off);
  assert.equal(offSettings.disableAllHooks, true);
  assert.equal(offSettings.hooks, undefined);
  assert.equal(off.env.WORKSHOP_TAG_URL, undefined, 'no tag URL without the hook');

  const on = adapter.buildRun({ ...base, mailHook: true });
  const onSettings = settingsOf(on);
  assert.equal(onSettings.disableAllHooks, undefined, 'the hook needs hooks on');
  assert.deepEqual(onSettings.hooks, { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'curl -s -m 2 "$WORKSHOP_TAG_URL"', timeout: 5 }] }] });
  assert.equal(MAIL_HOOK_COMMAND, 'curl -s -m 2 "$WORKSHOP_TAG_URL"');
  assert.equal(on.env.WORKSHOP_TAG_URL, 'http://127.0.0.1:4317/mcp/tok-secret-123/tag');
  assert.ok(!JSON.stringify(on.files).includes('tok-secret-123'), 'the token is not in any file');
  assert.ok(!on.args.join(' ').includes('tok-secret-123'), 'nor on the command line');
  assert.ok(SANDBOX_HIDDEN_ENV.includes('WORKSHOP_TAG_URL'));
  assert.ok(onSettings.sandbox.credentials.envVars.some((v) => v.name === 'WORKSHOP_TAG_URL' && v.mode === 'deny'), 'the sandbox hides the tag URL from shell commands');
  assert.equal(MAIL_HOOK, true, 'the provider test passed (tests/claude-mailhook.integration.test.mjs): the runner passes mailHook:true');
});

test('A06: --max-budget-usd only in apikey mode with a budget above 0', () => {
  const shellEnv = { path: '/usr/bin:/bin', resolve: () => '/c', base: () => ({ HOME: '/h', PATH: '/usr/bin:/bin' }) };
  const adapter = createClaudeAdapter({ shellEnv });
  const base = { agent: { id: 'A1' }, model: 'claude-sonnet-5-5', effort: 'low', prompt: 'p', systemPrompt: 's', cwd: '/w', runDir: '/r', mcp: { url: 'http://x/mcp', token: 't' } };
  const budget = (spec) => (spec.args.includes('--max-budget-usd') ? spec.args[spec.args.indexOf('--max-budget-usd') + 1] : null);
  assert.equal(budget(adapter.buildRun({ ...base, mode: 'apikey', keyEnv: { ANTHROPIC_API_KEY: 'k' }, maxBudgetUsd: 2.5 })), '2.5');
  assert.equal(budget(adapter.buildRun({ ...base, mode: 'apikey', keyEnv: { ANTHROPIC_API_KEY: 'k' }, maxBudgetUsd: 0.123456 })), '0.1235');
  assert.equal(budget(adapter.buildRun({ ...base, mode: 'apikey', keyEnv: { ANTHROPIC_API_KEY: 'k' }, maxBudgetUsd: 0 })), null);
  assert.equal(budget(adapter.buildRun({ ...base, mode: 'apikey', keyEnv: { ANTHROPIC_API_KEY: 'k' } })), null);
  assert.equal(budget(adapter.buildRun({ ...base, mode: 'subscription', maxBudgetUsd: 2.5 })), null, 'never in subscription mode');
});
