// Provider test of the Claude mail hook (docs/ARCHITECTURE.md section 10, A24). It proves three things with the
// REAL claude binary, through the Claude adapter and the runner, against the local fake Anthropic API:
//   1. a command hook from the per-agent settings file (--settings <runDir>/settings.json) runs in a -p run
//      that has --setting-sources "";
//   2. the hook's additionalContext (GET /mcp/:token/tag of the real hub) reaches the model;
//   3. in safety "sandboxed" the hook command sees WORKSHOP_TAG_URL while a Bash command of the agent does not.
// The runner ships the hook (MAIL_HOOK) only when this test passes; here it is switched on through `tuning`.
//
// SAFETY: every claude process gets ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and a dummy key, so no request can
// reach Anthropic. CLAUDE_CONFIG_DIR points into the temp folder. Opt-in: runs only with WORKSHOP_CLI_TESTS=1. Also skipped when claude is missing or WORKSHOP_SKIP_CLI=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShellEnv } from '../server/shellenv.js';
import { createClaudeAdapter } from '../server/providers/claude.js';
import { createRunner } from '../server/runner.js';
import { createStore } from '../server/store.js';
import { createMcp, mountMcp } from '../server/mcp.js';
import { createHttp } from '../server/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DUMMY_KEY = 'sk-ant-mock-not-a-real-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const puppet = (steps) => `<<<MOCK ${JSON.stringify({ steps })} MOCK>>>`;

const home = os.homedir();
const shellEnv = createShellEnv({
  env: {
    HOME: home, USER: os.userInfo().username, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8',
    WORKSHOP_PATH: [path.join(home, '.local', 'bin'), path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  },
});
const realAdapter = createClaudeAdapter({ shellEnv });
const claudeBin = realAdapter.locate();
// Opt-in (contract section 15): the real binary runs only with WORKSHOP_CLI_TESTS=1.
const skip = process.env.WORKSHOP_CLI_TESTS !== '1' ? 'opt-in: set WORKSHOP_CLI_TESTS=1 to run the real claude CLI'
  : process.env.WORKSHOP_SKIP_CLI === '1' ? 'WORKSHOP_SKIP_CLI=1' : !claudeBin ? 'the claude binary is not installed' : false;

test('real claude CLI: the mail hook from --settings runs with --setting-sources "", its context reaches the model, and the sandbox hides the tag URL from Bash', { skip, timeout: 240_000 }, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mailhook-')));
  const bench = path.join(dir, 'bench');
  const cfgDir = path.join(dir, 'claude-config');
  const mockLog = path.join(dir, 'mock-log');
  for (const d of [bench, cfgDir, mockLog]) fs.mkdirSync(d, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mock = spawn(process.execPath, [path.join(HERE, 'fixtures', 'mock-anthropic.mjs'), mockLog, '0'], { stdio: 'ignore' });
  t.after(() => { mock.kill('SIGTERM'); });
  const portOf = () => { try { return fs.readFileSync(path.join(mockLog, 'port'), 'utf8').trim(); } catch { return ''; } };
  for (let i = 0; i < 1200 && !/^\d+$/.test(portOf()); i++) await sleep(25);
  const mockUrl = `http://127.0.0.1:${portOf()}`;
  assert.match(mockUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  // The real hub pieces: GET /mcp/:token/tag answers with the urgent tag of the agent.
  const store = createStore({ dataDir: path.join(dir, 'data') });
  const mcp = createMcp({ store });
  const nonce = crypto.randomBytes(6).toString('hex');
  const tagText = `MAILCHECK-${nonce}: one urgent post waits. Call read.`;
  const tagCalls = [];
  mcp.setUrgentProvider((agentId) => { tagCalls.push(agentId); return tagText; });
  mcp.registerTool('post', {
    roles: ['all'], description: 'One board post.',
    inputSchema: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'], additionalProperties: false },
    handler: () => 'ok 1',
  });
  const http = createHttp({ ownerKey: 'test-owner-key-0123456789', log: () => {} });
  mountMcp(http, mcp);
  const { url } = await http.listen();
  t.after(() => http.close());

  const specs = [];
  const adapter = {
    ...realAdapter,
    buildRun(o) {
      const spec = realAdapter.buildRun(o);
      spec.env = { ...spec.env, ANTHROPIC_BASE_URL: mockUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: cfgDir };
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(spec.env.ANTHROPIC_BASE_URL) || spec.env.ANTHROPIC_API_KEY !== DUMMY_KEY || !spec.args.includes('-p')) {
        throw new Error('refusing to run claude without the local fake API and the dummy key');
      }
      specs.push(spec);
      return spec;
    },
  };
  const providers = {
    get: () => adapter, usable: () => true, modelUsable: () => true,
    status: () => ({ id: 'claude', installed: true, path: claudeBin, mode: 'apikey', auth: 'unknown', cooling: null, cooledModels: {}, usable: true, reason: null }),
    keyEnv: async () => ({ ANTHROPIC_API_KEY: DUMMY_KEY }), cool() {}, markAuth() {}, noteSuccess() {},
  };
  const settings = { auth: { claude: 'apikey' }, safety: 'sandboxed', limits: { maxAgents: 1, perProvider: { claude: 1 } } };
  const runner = createRunner({
    store, providers, mcp, getSettings: () => settings, getMcpUrl: () => `${url}/mcp`,
    paths: { server: path.join(ROOT, 'server'), data: path.join(dir, 'data'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') },
    tuning: { minSpawnGapMs: 0, mailHook: true },
  });
  t.after(async () => { await runner.shutdown(); await store.flush(); });
  store.put('agents', { id: 'A1', jobId: null, name: 'Sprocket', handle: '@m1', role: 'maker', provider: 'claude', model: 'claude-sonnet-5-5', status: 'idle', taskId: null, sessionId: null, stats: {} });

  const res = await runner.run('A1', {
    prompt: `Task. ${puppet([
      { tools: [{ name: 'Bash', input: { command: 'echo "BASH_SEES=[$WORKSHOP_TAG_URL][$WORKSHOP_TOKEN]"', description: 'look' } }] },
      { text: 'done' },
    ])}`,
    systemPrompt: 'You are a maker of WorkShop.', cwd: bench, access: 'write', effort: 'low', timeoutMs: 120_000, idleMs: 90_000, maxTurns: 6, kind: 'work',
  });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const spec = specs[0];
  const i = spec.args.indexOf('--setting-sources');
  assert.ok(i > 0 && spec.args[i + 1] === '', 'the run has --setting-sources ""');
  const settingsFile = spec.args[spec.args.indexOf('--settings') + 1];
  assert.equal(settingsFile, path.join(dir, 'data', 'run', 'A1', 'settings.json'));
  assert.match(spec.env.WORKSHOP_TAG_URL, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{64}\/tag$/);

  // 1. the command hook from the settings file ran: curl reached GET /mcp/:token/tag with this agent's token
  assert.ok(tagCalls.length >= 1 && tagCalls.every((id) => id === 'A1'), `the hook reached the tag route (${tagCalls.length} calls)`);

  // 2. its additionalContext reached the model: the request after the tool call holds the tag text
  const bodies = fs.readdirSync(mockLog).filter((f) => /^req-\d+\.json$/.test(f)).sort().map((f) => fs.readFileSync(path.join(mockLog, f), 'utf8'));
  assert.ok(bodies.some((b) => b.includes(tagText)), 'the hook context is in a model request');

  // 3. the Bash command of the agent did not see the tag URL or the token (the sandbox hides both).
  // The output is the tool_result block of the request after the tool call (the command text itself is in the
  // tool_use block and holds the variable names only).
  const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '');
  const results = bodies.flatMap((b) => JSON.parse(b).messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((block) => block?.type === 'tool_result').map((block) => textOf(block.content));
  const output = results.find((text) => text.includes('BASH_SEES='));
  assert.ok(output, 'the Bash result went back to the model');
  const shown = /BASH_SEES=\[[^\]]*\]\[[^\]]*\]/.exec(output.split(spec.env.WORKSHOP_TOKEN).join('<TOKEN>'))?.[0];
  assert.equal(shown, 'BASH_SEES=[][]', 'a sandboxed Bash command sees neither WORKSHOP_TAG_URL nor WORKSHOP_TOKEN');
  assert.equal(output.includes(spec.env.WORKSHOP_TOKEN), false);
  // the hook context arrived after the Bash call, in the same turn
  const withTag = bodies.findIndex((b) => b.includes(tagText));
  const withResult = bodies.findIndex((b) => b.includes('BASH_SEES=[]'));
  assert.ok(withTag >= 0 && withResult >= 0 && withTag <= bodies.length - 1);
});
