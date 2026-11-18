// Adapter buildRun golden tests and registry tests. Every binary here is a fake shell script in a temp folder.
// SAFETY: the registry tests use a shell environment whose resolve() looks ONLY in the temp bin folder, so the
// real agy (inside Gemini.app) can never be found, and so can never be run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShellEnv } from '../server/shellenv.js';
import { createClaudeAdapter, clampEffort, DENY_RULES, SANDBOX_DOMAINS } from '../server/providers/claude.js';
import { createGeminiAdapter, agyMayRun, AGY } from '../server/providers/gemini.js';
import { createMockAdapter } from '../server/providers/mock.js';
import { createProviders, runCommand } from '../server/providers/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-providers-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const BASE = { HOME: '/home/owner', USER: 'owner', LOGNAME: 'owner', SHELL: '/bin/zsh', TERM: 'dumb', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/', PATH: '/usr/bin:/bin' };
const fixedShellEnv = (bins = {}) => ({ path: BASE.PATH, resolve: (name) => bins[name] ?? null, base: () => ({ ...BASE }) });
const SID = '11111111-2222-4333-8444-555555555555';
const MCP = { url: 'http://127.0.0.1:4317/mcp', token: 'tok-A7', shimPath: '/app/server/mcp-stdio-shim.mjs', nodePath: '/usr/local/bin/node' };
const AGENT = { id: 'A7', handle: '@m3', role: 'maker', provider: 'claude' };

// ------------------------------------------------------------------------------------------- Claude buildRun

test('claude buildRun: the exact command for a sandboxed maker on the subscription', () => {
  const adapter = createClaudeAdapter({ shellEnv: fixedShellEnv({ claude: '/fake/bin/claude' }) });
  const spec = adapter.buildRun({
    agent: AGENT, model: 'claude-sonnet-5-5', effort: 'medium', prompt: 'Do T12.', systemPrompt: 'You are a maker.\n', cwd: '/work/J1/T12',
    sessionId: SID, resume: false, mcp: MCP, access: 'write', web: false, runDir: '/data/run/A7', mode: 'subscription', keyEnv: {}, safety: 'sandboxed', maxTurns: 80,
  });
  const settings = {
    disableAllHooks: true,
    attribution: { commit: '', pr: '' },
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true,
      network: { allowLocalBinding: true, allowedDomains: SANDBOX_DOMAINS },
      filesystem: { denyRead: ['.ssh', '.aws', '.gnupg', '.netrc', '.kube', '.docker', '.config/gh', '.config/gcloud', '.claude/.credentials.json', '.gemini', 'Library/Keychains'].map((p) => `/home/owner/${p}`) },
      credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }, { name: 'WORKSHOP_TOKEN', mode: 'deny' }, { name: 'WORKSHOP_TAG_URL', mode: 'deny' }] },
    },
  };
  assert.equal(spec.cmd, '/fake/bin/claude');
  assert.deepEqual(spec.args, [
    '-p',
    '--model', 'claude-sonnet-5-5',
    '--effort', 'medium',
    '--output-format', 'stream-json', '--verbose',
    '--session-id', SID,
    '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '/data/run/A7/mcp.json',
    '--tools', 'Bash,Edit,Read,Write',
    '--allowedTools', 'mcp__shop', 'Bash',
    '--disallowedTools', 'Bash(git push *)', 'Bash(git commit *)', 'Bash(git merge *)', 'Bash(git rebase *)', 'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(sudo *)', 'Bash(* | sh)', 'Bash(* | sh *)', 'Bash(* | bash)', 'Bash(* | bash *)', 'Bash(* | zsh)', 'Bash(* | zsh *)',
    'Bash(security *)', 'Bash(/usr/bin/security *)', // the OS sandbox does not close the Keychain
    '--permission-mode', 'acceptEdits',
    '--disable-slash-commands',
    '--append-system-prompt-file', '/data/run/A7/role.txt',
    '--max-turns', '80',
    '--settings', '/data/run/A7/settings.json', // a file of the run folder, never JSON on the command line
  ]);
  assert.ok(spec.args.every((a) => !a.includes('{')), 'no argument holds JSON');
  assert.deepEqual(JSON.parse(spec.files.find((f) => f.path === '/data/run/A7/settings.json').content), settings);
  assert.deepEqual(spec.hubFiles, {}, 'Claude writes no bench file');
  assert.deepEqual(spec.env, { ...BASE, DISABLE_AUTOUPDATER: '1', ENABLE_TOOL_SEARCH: 'false', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', WORKSHOP_TOKEN: 'tok-A7' });
  assert.equal(spec.cwd, '/work/J1/T12');
  assert.equal(spec.stdin, 'Do T12.');
  assert.equal(spec.sessionId, SID);
  assert.deepEqual(spec.files.map((f) => f.path), ['/data/run/A7/mcp.json', '/data/run/A7/role.txt', '/data/run/A7/settings.json']);
  assert.deepEqual(JSON.parse(spec.files[0].content), {
    mcpServers: { shop: { type: 'http', url: 'http://127.0.0.1:4317/mcp/${WORKSHOP_TOKEN}', headers: { Authorization: 'Bearer ${WORKSHOP_TOKEN}', 'X-WorkShop': '1' }, alwaysLoad: true } },
  });
  assert.ok(!spec.files[0].content.includes('tok-A7'), 'the token is not written to disk');
  assert.equal(spec.files[1].content, 'You are a maker.\n\nSandbox: shell commands can write only inside the current folder. Network access is limited to package registries and localhost.\n');
  assert.ok(!spec.args.includes('--system-prompt-file') && !spec.args.includes('--system-prompt'), "Claude Code's default system prompt stays");
});

test('claude buildRun: a resumed turn repeats every flag and swaps --session-id for --resume', () => {
  const adapter = createClaudeAdapter({ shellEnv: fixedShellEnv({ claude: '/fake/bin/claude' }) });
  const common = { agent: AGENT, model: 'claude-sonnet-5-5', effort: 'low', prompt: 'p', systemPrompt: 's', cwd: '/w', sessionId: SID, mcp: MCP, access: 'write', web: false, runDir: '/r', mode: 'subscription', safety: 'sandboxed', maxTurns: 10 };
  const first = adapter.buildRun({ ...common, resume: false });
  const next = adapter.buildRun({ ...common, resume: true });
  const i = first.args.indexOf('--session-id');
  assert.deepEqual(next.args.slice(i, i + 2), ['--resume', SID]);
  assert.deepEqual([...next.args.slice(0, i), ...next.args.slice(i + 2)], [...first.args.slice(0, i), ...first.args.slice(i + 2)]);
  assert.ok(!next.args.includes('--session-id'));
  // resume without a usable id starts a new session with a fresh UUID
  const fresh = adapter.buildRun({ ...common, sessionId: null, resume: true });
  assert.match(fresh.args[fresh.args.indexOf('--session-id') + 1], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(fresh.sessionId, fresh.args[fresh.args.indexOf('--session-id') + 1]);
  const notUuid = adapter.buildRun({ ...common, sessionId: 'maker-7', resume: false });
  assert.notEqual(notUuid.sessionId, 'maker-7');
});

test('claude buildRun: read access, web, trusting, API key mode', () => {
  const adapter = createClaudeAdapter({ shellEnv: fixedShellEnv({}) });
  const spec = adapter.buildRun({
    agent: AGENT, model: 'opus', effort: 'max', prompt: 'review', systemPrompt: 'Reviewer.', cwd: '/w', sessionId: SID, mcp: MCP, access: 'read', web: true,
    runDir: '/r', mode: 'apikey', keyEnv: { ANTHROPIC_API_KEY: 'sk-ant-test-key', OTHER_SECRET: 'nope' }, safety: 'trusting',
  });
  const arg = (flag) => spec.args[spec.args.indexOf(flag) + 1];
  assert.equal(spec.cmd, 'claude', 'falls back to the bare name when the binary is not found');
  assert.equal(arg('--model'), 'claude-opus-5-5', 'aliases become full ids');
  assert.equal(arg('--effort'), 'max');
  assert.equal(arg('--tools'), 'Bash,Read,WebSearch,WebFetch');
  assert.equal(arg('--permission-mode'), 'dontAsk');
  const a = spec.args.indexOf('--allowedTools');
  assert.deepEqual(spec.args.slice(a + 1, spec.args.indexOf('--disallowedTools')), ['mcp__shop', 'Bash', 'WebSearch', 'WebFetch']);
  const d = spec.args.indexOf('--disallowedTools');
  assert.deepEqual(spec.args.slice(d + 1, spec.args.indexOf('--permission-mode')), DENY_RULES);
  assert.equal(arg('--settings'), '/r/settings.json');
  assert.deepEqual(JSON.parse(spec.files[2].content), { disableAllHooks: true, attribution: { commit: '', pr: '' } }, 'no OS sandbox in trusting mode');
  assert.ok(!spec.args.includes('--max-turns'));
  assert.equal(spec.env.ANTHROPIC_API_KEY, 'sk-ant-test-key');
  assert.equal(spec.env.OTHER_SECRET, undefined);
  assert.equal(spec.files[1].content, 'Reviewer.\n');
  for (const s of [spec.args.join(' '), ...spec.files.map((f) => f.content)]) assert.ok(!s.includes('sk-ant-test-key'), 'the key is only in the environment');
});

test('claude buildRun: no API key and no inherited CLAUDE_CODE_* variable ever leaks in subscription mode', (t) => {
  const dir = tmp(t);
  const hubEnv = {
    HOME: dir, USER: 'owner', WORKSHOP_PATH: '/usr/bin:/bin', TMPDIR: '/tmp/',
    ANTHROPIC_API_KEY: 'sk-ant-hub-secret', ANTHROPIC_AUTH_TOKEN: 'hub-token', ANTHROPIC_BASE_URL: 'http://evil', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CONFIG_DIR: '/elsewhere', GEMINI_API_KEY: 'g-secret', OPENAI_API_KEY: 'o-secret', NODE_OPTIONS: '--inspect',
  };
  const shellEnv = createShellEnv({ env: hubEnv });
  for (const safety of ['sandboxed', 'trusting']) {
    const claude = createClaudeAdapter({ shellEnv }).buildRun({ agent: AGENT, model: 'claude-haiku-5-5', effort: 'low', prompt: 'p', systemPrompt: 's', cwd: dir, mcp: MCP, runDir: dir, mode: 'subscription', keyEnv: { ANTHROPIC_API_KEY: 'sk-should-be-ignored' }, safety });
    assert.deepEqual(Object.keys(claude.env).sort(), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'DISABLE_AUTOUPDATER', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'ENABLE_TOOL_SEARCH', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'WORKSHOP_TOKEN']);
    const all = JSON.stringify(claude);
    for (const secret of ['sk-ant-hub-secret', 'hub-token', 'oauth-secret', 'g-secret', 'o-secret', 'sk-should-be-ignored', 'http://evil']) assert.ok(!all.includes(secret), secret);
    assert.ok(!all.includes('bypassPermissions') && !all.includes('dangerously'), 'never bypassPermissions');
  }
  const gemini = createGeminiAdapter({ shellEnv }).buildRun({ agent: AGENT, model: 'gemini-4-hydrogen', effort: 'low', prompt: 'p', systemPrompt: 's', cwd: dir, mcp: MCP, runDir: dir, mode: 'subscription', keyEnv: { GEMINI_API_KEY: 'g-should-be-ignored' }, bin: path.join(dir, 'agy') });
  assert.deepEqual(Object.keys(gemini.env).sort(), ['AGY_CLI_DISABLE_AUTO_UPDATE', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER']);
  const allG = JSON.stringify(gemini);
  for (const secret of ['sk-ant-hub-secret', 'g-secret', 'g-should-be-ignored', 'oauth-secret']) assert.ok(!allG.includes(secret), secret);
  assert.ok(!allG.includes('dangerously') && !allG.includes('always-proceed'));
  const mock = createMockAdapter({ shellEnv }).buildRun({ agent: AGENT, prompt: 'p', systemPrompt: 's', cwd: dir, mcp: MCP, runDir: dir });
  assert.ok(!JSON.stringify(mock).includes('secret'));
});

test('claude buildRun: effort clamp, sandbox options, required input', () => {
  assert.equal(clampEffort('claude-fable-5-2', 'xhigh'), 'xhigh');
  assert.equal(clampEffort('claude-sonnet-5-5', 'ultra'), 'medium');
  assert.equal(clampEffort('claude-haiku-4-5-20251001', 'high'), null);
  const adapter = createClaudeAdapter({ shellEnv: fixedShellEnv({ claude: '/c' }) });
  const base = { agent: AGENT, model: 'claude-haiku-4-5-20251001', effort: 'high', prompt: 'p', systemPrompt: 's', cwd: '/w', mcp: MCP, runDir: '/r', mode: 'subscription' };
  assert.ok(!adapter.buildRun(base).args.includes('--effort'), 'a model without effort levels gets no --effort');
  const settingsOf = (spec) => JSON.parse(spec.files.find((f) => f.path.endsWith('/settings.json')).content);
  const strict = settingsOf(adapter.buildRun({ ...base, sandbox: { localNetwork: false, domains: [] } }));
  assert.deepEqual(strict.sandbox.network, { allowLocalBinding: false, allowedDomains: [] });
  assert.equal(strict.sandbox.filesystem.allowRead, undefined, 'no hub folders given: no read rules beyond the credential places');
  // The runner names the hub's own data folders. A sandboxed command must not read them (the benches and the
  // token files of other agents are there), but it must read its own bench: the narrower allowRead wins.
  const closed = settingsOf(adapter.buildRun({ ...base, cwd: '/hub/data/work/J1/T12', privateDirs: ['/hub/data', '/hub/data/run', '/hub/data/logs', '/hub/config', 'relative/ignored', 7] })).sandbox.filesystem;
  assert.deepEqual(closed.denyRead.slice(-4), ['/hub/data', '/hub/data/run', '/hub/data/logs', '/hub/config'], 'data/run, data/logs and config/ of WorkShop are on the deny-read list');
  assert.ok(closed.denyRead.includes('/home/owner/.ssh'));
  assert.deepEqual(closed.allowRead, ['/hub/data/work/J1/T12']);
  assert.equal(settingsOf(adapter.buildRun({ ...base, safety: 'trusting', privateDirs: ['/hub/data'] })).sandbox, undefined);
  assert.throws(() => adapter.buildRun({ ...base, mode: null }), /sign-in mode/);
  assert.throws(() => adapter.buildRun({ ...base, mode: 'apikey', keyEnv: {} }), /API key/);
  assert.throws(() => adapter.buildRun({ ...base, model: '' }), /model/);
  assert.throws(() => adapter.buildRun({ ...base, mcp: { url: 'x' } }), /mcp/);
  assert.throws(() => adapter.buildRun({ ...base, cwd: '' }), /cwd/);
  assert.throws(() => createClaudeAdapter({}), /shellEnv/);
});

test('claude adapter: probes, sign-in command, install hint', () => {
  const adapter = createClaudeAdapter({ shellEnv: fixedShellEnv({ claude: '/c' }) });
  assert.deepEqual(adapter.probes.version.args, ['--version']);
  assert.deepEqual(adapter.probes.auth.args, ['auth', 'status', '--json']);
  assert.equal(adapter.probes.version.parse('2.1.289 (Claude Code)\n'), '2.1.289');
  assert.equal(adapter.probes.version.parse('garbage'), null);
  assert.equal(adapter.probes.auth.parse('{"loggedIn": true, "authMethod": "claude.ai"}'), 'ok');
  assert.equal(adapter.probes.auth.parse('{"loggedIn": false, "authMethod": "none"}'), 'none');
  assert.equal(adapter.probes.auth.parse('Not logged in'), 'unknown');
  assert.equal(adapter.probes.auth.parse('{broken'), 'unknown');
  assert.deepEqual(adapter.probes.env(), { ...BASE, DISABLE_AUTOUPDATER: '1' });
  assert.equal(adapter.loginCommand('/c'), null);
  assert.match(adapter.installHint().url, /^https:\/\//);
});

// ------------------------------------------------------------------------------------------- Gemini buildRun

test('gemini buildRun: the exact agy command, bench files and settings (first turn)', (t) => {
  const dir = tmp(t);
  const agy = path.join(dir, 'agy');
  const adapter = createGeminiAdapter({ shellEnv: fixedShellEnv({ agy }) });
  const spec = adapter.buildRun({
    agent: { ...AGENT, provider: 'gemini' }, model: 'gemini-4-hydrogen', effort: 'high', prompt: 'Do T12.', systemPrompt: 'You are a maker.', cwd: '/work/J1/T12',
    sessionId: null, resume: false, mcp: { ...MCP, urlFile: '/data/run/A7/mcp-url' }, access: 'write', web: false, runDir: '/data/run/A7', mode: 'subscription', keyEnv: {}, safety: 'sandboxed', timeoutMs: 30 * 60_000,
  });
  assert.equal(spec.cmd, agy);
  assert.deepEqual(spec.args, [
    '-p', 'You are a maker.\n\n---\n\nDo T12.',
    '--output-format', 'stream-json',
    '--model', 'gemini-4-hydrogen-high', '--effort', 'high',
    '--settings', '/data/run/A7/settings.json',
    '--print-timeout', '31m', // one minute more than the hub's limit: the hub's watchdog decides
    '--log-file', '/data/run/A7/agy.log',
  ]);
  assert.strictEqual(spec.stdin, '', 'no text for stdin');
  assert.strictEqual(spec.stdinKind, 'fifo', 'the runner gives agy a real pipe at end-of-file (never /dev/null, never a socket pair)');
  assert.deepEqual(spec.env, { ...BASE, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
  assert.equal(spec.cwd, '/work/J1/T12');
  // No rules file: agy does not apply .agents/rules/*.md in -p runs (real run). The role card leads the prompt.
  // Files of the run folder only; the bench file is a hub file (written by the runner through git.writeHubFiles).
  assert.deepEqual(spec.files.map((f) => f.path), ['/data/run/A7/mcp-url', '/data/run/A7/settings.json']);
  assert.ok(spec.files.every((f) => f.path.startsWith('/data/run/A7/')), 'files: only paths under runDir');
  assert.deepEqual(Object.keys(spec.hubFiles), ['.agents/mcp_config.json']);
  assert.ok(!spec.args.join(' ').includes('tok-A7'), 'the token is not on the command line of agy');
  assert.deepEqual(spec.files[0], { path: '/data/run/A7/mcp-url', content: 'http://127.0.0.1:4317/mcp/tok-A7' }, 'the URL file holds the URL with the token');
  const bench = spec.hubFiles['.agents/mcp_config.json'];
  assert.deepEqual(JSON.parse(bench), {
    mcpServers: {
      shop: {
        command: '/usr/local/bin/node',
        args: ['/app/server/mcp-stdio-shim.mjs', '--url-file', '/data/run/A7/mcp-url'], // the shim reads the URL file at start
        timeoutSeconds: 120,
        tools: Object.fromEntries(['post', 'read', 'claim', 'status', 'task_add', 'task_update', 'task_retry', 'task_cancel', 'plan_submit', 'req_add', 'req_verify', 'job_report'].map((n) => [n, { eager: true }])),
      },
    },
  });
  assert.ok(!bench.includes('tok-A7') && !bench.includes('127.0.0.1:4317') && !bench.includes('"env"'), 'no URL, no token and no env block in the bench file');
  assert.ok(Object.values(spec.hubFiles).every((content) => !content.includes('tok-A7')));
  assert.equal(spec.files.some((f) => f.path.includes('.git')), false, 'the adapter does not touch .git/info/exclude (gitops owns it)');
  assert.equal(adapter.exclusiveCwd, true, 'one agy turn per folder at a time: the MCP config is per folder');
  assert.equal(adapter.cleanAgentDir, true, 'the runner cleans .agents/ before every agy spawn');
  const settings = JSON.parse(spec.files[1].content);
  assert.deepEqual(settings, {
    agentMode: 'accept-edits', toolPermission: 'proceed-in-sandbox', enableTerminalSandbox: true, allowNonWorkspaceAccess: false,
    permissions: {
      allow: ['mcp(shop/*)'],
      deny: ['command(git push)', 'command(git commit)', 'command(git merge)', 'command(git rebase)', 'command(git reset)', 'command(git checkout)', 'command(sudo)'],
    },
  });
  // Only keys of section 10 (an unknown key ends the run with exit 1); no useG1Credits or any other key.
  const SECTION_10_KEYS = ['agentMode', 'toolPermission', 'enableTerminalSandbox', 'allowNonWorkspaceAccess', 'permissions', 'modelProvider'];
  for (const mode of ['subscription', 'apikey']) {
    for (const safety of ['sandboxed', 'trusting']) {
      for (const access of ['write', 'read']) {
        const keys = Object.keys(adapter.settingsFor({ safety, access, web: true, mode }));
        assert.ok(keys.every((k) => SECTION_10_KEYS.includes(k)), `${mode}/${safety}/${access}: ${keys}`);
        assert.equal(keys.includes('useG1Credits'), false);
      }
    }
  }
  assert.deepEqual(Object.keys(adapter.settingsFor({ safety: 'sandboxed', access: 'write', web: false, mode: 'apikey' })), SECTION_10_KEYS);
  // The settings the real run of agy 1.5.1 used are a subset of these (tests/fixtures/real: settings.json of that run).
  const real = { agentMode: 'accept-edits', toolPermission: 'proceed-in-sandbox', enableTerminalSandbox: true, allowNonWorkspaceAccess: false, permissions: { allow: ['mcp(shop/*)'], deny: ['command(git push)', 'command(sudo)'] } };
  for (const [key, value] of Object.entries(real)) if (key !== 'permissions') assert.deepEqual(settings[key], value, key);
  for (const rule of real.permissions.deny) assert.ok(settings.permissions.deny.includes(rule), rule);
  assert.throws(() => adapter.buildRun({ agent: AGENT, model: 'gemini-4-argon', prompt: 'p', systemPrompt: 's', cwd: '/w', mcp: { ...MCP, urlFile: '/w/.agents/url' }, runDir: '/r', mode: 'subscription' }), /urlFile must be inside the run folder/);
});

test('gemini buildRun: follow-up turn, API key variant, read access, trusting, long prompt', (t) => {
  const dir = tmp(t);
  const agy = path.join(dir, 'agy');
  const adapter = createGeminiAdapter({ shellEnv: fixedShellEnv({ agy }) });
  const base = { agent: AGENT, model: 'gemini-4-carbon', effort: 'xhigh', prompt: 'Next step.', systemPrompt: 'Role card.', cwd: '/w', mcp: MCP, runDir: '/r', mode: 'subscription', safety: 'sandboxed' };

  const follow = adapter.buildRun({ ...base, sessionId: 'conv-123', resume: true });
  assert.deepEqual(follow.args.slice(0, 2), ['-p', 'Next step.'], 'the role card leads only the first prompt of a conversation');
  assert.deepEqual(follow.args.slice(-2), ['--conversation', 'conv-123']);
  assert.deepEqual(follow.args.slice(4, 8), ['--model', 'gemini-4-carbon-high', '--effort', 'high'], 'effort is clamped to the model');
  assert.equal(follow.args[follow.args.indexOf('--print-timeout') + 1], '45m');
  assert.equal(adapter.buildRun({ ...base, sessionId: 'conv-123', resume: false }).args.includes('--conversation'), false);

  const keyed = adapter.buildRun({ ...base, mode: 'apikey', keyEnv: { GEMINI_API_KEY: 'g-test-key', ANTHROPIC_API_KEY: 'no' } });
  assert.equal(keyed.env.GEMINI_API_KEY, 'g-test-key');
  assert.equal(keyed.env.ANTHROPIC_API_KEY, undefined);
  const settingsOf = (spec) => JSON.parse(spec.files.find((f) => f.path.endsWith('/settings.json')).content);
  assert.equal(settingsOf(keyed).modelProvider, 'gemini');
  assert.ok(![keyed.args.join(' '), ...keyed.files.map((f) => f.content ?? ''), ...Object.values(keyed.hubFiles)].some((s) => s.includes('g-test-key')));
  assert.equal(keyed.stdinKind, 'fifo');
  assert.equal(adapter.buildRun({ ...base, timeoutMs: 90_000 }).args[adapter.buildRun({ ...base, timeoutMs: 90_000 }).args.indexOf('--print-timeout') + 1], '3m');
  assert.equal(settingsOf(adapter.buildRun(base)).modelProvider, undefined);
  assert.throws(() => adapter.buildRun({ ...base, mode: 'apikey', keyEnv: {} }), /Gemini key/);

  const reader = settingsOf(adapter.buildRun({ ...base, access: 'read', web: true }));
  assert.deepEqual(reader.permissions.allow, ['mcp(shop/*)', 'read_url(*)']);
  assert.ok(reader.permissions.deny.includes('write_file(*)'));
  const trusting = settingsOf(adapter.buildRun({ ...base, safety: 'trusting' }));
  assert.equal(trusting.enableTerminalSandbox, false);
  assert.deepEqual(trusting.permissions.allow, ['mcp(shop/*)', 'command(*)']);
  assert.notEqual(trusting.toolPermission, 'always-proceed');

  const long = adapter.buildRun({ ...base, prompt: 'x'.repeat(AGY.maxPromptArgBytes + 10) });
  assert.ok(long.args[1].length < 300 && long.args[1].includes('.agents/workshop-prompt.md'));
  assert.ok(long.hubFiles['.agents/workshop-prompt.md'].startsWith('Role card.\n\n---\n\nxxx'), 'a long prompt is the hub file .agents/workshop-prompt.md');
  assert.ok(long.files.every((f) => f.path.startsWith('/r/')));

  // a prompt that starts with a dash must not be read as a flag of agy
  assert.equal(adapter.buildRun({ ...base, sessionId: 'conv-123', resume: true, prompt: '--help me with this' }).args[1], ' --help me with this');
  assert.equal(adapter.buildRun({ ...base, systemPrompt: '- You are a maker.', prompt: 'x' }).args[1], ' - You are a maker.\n\n---\n\nx');
  assert.equal(adapter.buildRun({ ...base, systemPrompt: '', prompt: '' }).args[1], ' ');

  adapter.setKnownModels(['gemini-4-carbon']);
  assert.deepEqual(adapter.buildRun(base).args.slice(4, 8), ['--model', 'gemini-4-carbon', '--effort', 'high'], 'follows the model list of the account');
  adapter.setKnownModels(null);
  assert.throws(() => adapter.buildRun({ ...base, mode: undefined }), /sign-in mode/);
  assert.throws(() => adapter.buildRun({ ...base, mcp: { url: 'u', token: 't' } }), /shimPath/);
});

test('agy guard: tests can run only a fake binary under the temp folder', (t) => {
  const dir = tmp(t);
  assert.equal(agyMayRun(path.join(dir, 'agy')).ok, true);
  assert.equal(agyMayRun('/Applications/Gemini.app/Contents/Helpers/agy').ok, false, 'this very test process must be refused');
  assert.equal(agyMayRun('/Applications/Gemini.app/Contents/Helpers/agy', {}).ok, true, 'outside tests the real binary is allowed');
  assert.equal(agyMayRun(path.join(dir, 'agy'), { WORKSHOP_DISABLE_AGY: '1' }).ok, false);
  const adapter = createGeminiAdapter({ shellEnv: fixedShellEnv({ agy: '/Applications/Gemini.app/Contents/Helpers/agy' }) });
  assert.throws(() => adapter.buildRun({ agent: AGENT, model: 'gemini-4-argon', prompt: 'p', systemPrompt: 's', cwd: '/w', mcp: MCP, runDir: '/r', mode: 'subscription' }), /never run the real agy/);
});

test('gemini adapter: auth check command and its parsing', (t) => {
  const dir = tmp(t);
  const adapter = createGeminiAdapter({ shellEnv: fixedShellEnv({ agy: path.join(dir, 'agy') }) });
  const check = adapter.authCheck;
  assert.equal(check.stdin, 'fifo', 'the owner check gives agy the same stdin as a worker turn');
  assert.deepEqual(check.args('subscription'), ['models']);
  // Contract section 10: --settings takes a file path (never inline JSON). The registry writes the file.
  assert.deepEqual(check.args('apikey', '/r/agy-check/settings.json'), ['--settings', '/r/agy-check/settings.json', 'models']);
  assert.throws(() => check.args('apikey'), /settings file/);
  assert.deepEqual(JSON.parse(check.settingsContent('apikey')), { modelProvider: 'gemini' });
  assert.equal(check.settingsContent('subscription'), null);
  assert.deepEqual(check.env('subscription', { GEMINI_API_KEY: 'k' }), { ...BASE, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
  assert.equal(check.env('apikey', { GEMINI_API_KEY: 'k' }).GEMINI_API_KEY, 'k');
  assert.deepEqual(check.parse({ code: 0, stdout: 'gemini-4-hydrogen-high\ngemini-4-argon-low\n', stderr: '' }), { auth: 'ok', models: ['gemini-4-hydrogen-high', 'gemini-4-argon-low'], detail: '2 models' });
  assert.equal(check.parse({ code: 1, stdout: '', stderr: "Error: authentication required. Run 'agy' to log in, then retry." }).auth, 'none');
  assert.equal(check.parse({ code: 1, stdout: '', stderr: 'network unreachable' }).auth, 'unknown');
  assert.equal(check.parse({ code: null, stdout: '', stderr: '', timedOut: true }).auth, 'unknown');
  assert.equal(check.parseVersion('1.5.8\n'), '1.5.8');
  assert.equal(adapter.loginCommand('/x/agy'), null);
});

test('mock buildRun: node + mock-agent.mjs with the MOCK_* variables', () => {
  const adapter = createMockAdapter({ shellEnv: fixedShellEnv({}) });
  const spec = adapter.buildRun({ agent: { id: 'A1', role: 'boss', handle: '@b1' }, prompt: 'Plan it.', systemPrompt: 'Boss card.', cwd: '/w', sessionId: 's-1', mcp: MCP, runDir: '/data/run/A1', mode: null });
  assert.equal(spec.cmd, process.execPath);
  assert.deepEqual(spec.args, [path.join(ROOT, 'server', 'providers', 'mock-agent.mjs')]);
  assert.deepEqual(spec.env, { ...BASE, SHOP_MCP_URL: 'http://127.0.0.1:4317/mcp', SHOP_TOKEN: 'tok-A7', MOCK_ROLE: 'boss', MOCK_HANDLE: '@b1', MOCK_SESSION: 's-1', MOCK_SYSTEM_FILE: '/data/run/A1/role.txt', MOCK_SPEED: '1' });
  assert.equal(spec.stdin, 'Plan it.');
  assert.deepEqual(spec.files, [{ path: '/data/run/A1/role.txt', content: 'Boss card.\n' }]);
  assert.equal(adapter.locate(), process.execPath);
});

// ------------------------------------------------------------------------------------------- registry

function sh(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** A world of fake binaries. resolve() looks only in <dir>/bin: the real claude and agy are out of reach. */
// ack 'auto': settings.authAck follows settings.auth (the owner read the note for every mode chosen), and safety is
// 'trusting' unless a test sets it, so these older tests keep testing what they test. The ack, self-test and
// cooling rules of the amended contract have their own tests below.
function world(t, { claude = null, agy = null, auth = {}, keys = {}, timeouts, ack = 'auto', safety = 'trusting', now } = {}) {
  const dir = tmp(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (claude) {
    fs.writeFileSync(path.join(dir, 'claude-auth.json'), claude.auth ?? '{"loggedIn": true, "authMethod": "claude.ai"}');
    sh(path.join(bin, 'claude'), `echo "$@" >> "${dir}/claude-calls.log"\nenv > "${dir}/claude-env.txt"\ncase "$1" in\n  --version) echo "${claude.version ?? '2.1.289'} (Claude Code)";;\n  auth) cat "${dir}/claude-auth.json"; exit ${claude.authExit ?? 0};;\n  *) exit 9;;\nesac`);
  }
  if (agy) {
    fs.writeFileSync(path.join(dir, 'agy-models.txt'), agy.models ?? 'gemini-4-hydrogen-high\ngemini-4-hydrogen-low\ngemini-4-argon-medium\n');
    sh(path.join(bin, 'agy'), [
      `echo "$@" >> "${dir}/agy-calls.log"`,
      `echo $$ > "${dir}/agy.pid"`,
      // Node gives a child a socket pair for a 'pipe' stdio. agy must get a real pipe: that is the case that was
      // seen to fail cleanly without a login. /dev/null (a character device) opened a browser sign-in.
      `if [ -c /dev/stdin ] || [ -t 0 ]; then echo chardev >> "${dir}/agy-stdin.log"; elif [ -p /dev/stdin ]; then echo pipe >> "${dir}/agy-stdin.log"; elif [ -S /dev/stdin ]; then echo socket >> "${dir}/agy-stdin.log"; else echo other >> "${dir}/agy-stdin.log"; fi`,
      'cat > /dev/null',
      `echo eof >> "${dir}/agy-stdin.log"`,
      `env > "${dir}/agy-env.txt"`,
      agy.sleep ? `sleep ${agy.sleep}` : '',
      'for a in "$@"; do last="$a"; done',
      `case "$last" in\n  models) ${agy.loggedOut ? `echo "Error: authentication required. Run 'agy' to log in, then retry." >&2; exit 1` : `cat "${dir}/agy-models.txt"`};;\n  --version) echo "1.5.8";;\n  *) exit 2;;\nesac`,
    ].join('\n'));
  }
  sh(path.join(bin, 'fake-open'), `echo "$@" >> "${dir}/open-calls.log"`);
  const shellEnv = {
    path: `${bin}:/usr/bin:/bin`,
    resolve: (name) => { const f = path.join(bin, String(name)); return fs.existsSync(f) ? f : null; },
    base: () => ({ HOME: dir, USER: 'owner', LOGNAME: 'owner', SHELL: '/bin/zsh', TERM: 'dumb', LANG: 'en_US.UTF-8', TMPDIR: `${dir}/`, PATH: `${bin}:/usr/bin:/bin` }),
  };
  let settings = { auth: { claude: null, gemini: null, ...auth }, safety };
  const view = () => {
    if (ack !== 'auto') return settings;
    const auto = Object.fromEntries(Object.entries(settings.auth ?? {}).filter(([, m]) => m).map(([lab, mode]) => [lab, { mode, ts: 1 }]));
    return { ...settings, authAck: { ...auto, ...(settings.authAck ?? {}) } };
  };
  const merge = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v; return out; };
  const secrets = {
    list: async () => [{ id: 'anthropic', envVar: 'ANTHROPIC_API_KEY', set: !!keys.anthropic }, { id: 'gemini', envVar: 'GEMINI_API_KEY', set: !!keys.gemini }],
    envFor: async (id) => (id === 'claude' && keys.anthropic ? { ANTHROPIC_API_KEY: keys.anthropic } : id === 'gemini' && keys.gemini ? { GEMINI_API_KEY: keys.gemini } : {}),
  };
  const logs = [];
  const providers = createProviders({
    secrets, shellEnv, getSettings: view, updateSettings: (patch) => { settings = merge(settings, patch); return settings; }, ...(now ? { now } : {}),
    paths: { run: path.join(dir, 'run') }, log: (level, msg, data) => logs.push({ level, msg, data }), openPath: path.join(bin, 'fake-open'),
    timeouts: { probe: 60_000, open: 60_000, ...timeouts }, // generous: a busy Mac starts even a tiny shell script slowly
  });
  t.after(() => providers.dispose());
  const by = async (id, opts) => (await providers.detect({ force: true, ...opts })).find((p) => p.id === id);
  return { dir, bin, providers, by, logs, keys, settings: () => settings, setSettings: (patch) => { settings = merge(settings, patch); }, read: (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; } } };
}

test('registry: nothing installed', async (t) => {
  const w = world(t);
  const list = await w.providers.detect();
  assert.deepEqual(list.map((p) => p.id), ['claude', 'gemini', 'openai', 'oss', 'mock']);
  const [claude, gemini, openai, oss, mock] = list;
  void openai;
  assert.deepEqual(Object.keys(claude).sort(), ['ack', 'auth', 'cooledModels', 'cooling', 'id', 'installHint', 'installed', 'keySet', 'lab', 'label', 'limit', 'loginCmd', 'mode', 'models', 'path', 'policyNote', 'reason', 'selfTest', 'usable', 'version']);
  assert.deepEqual([claude.ack, claude.cooledModels, claude.selfTest], [false, {}, null]);
  assert.equal(claude.limit, null, 'no plan-limit notice yet');
  assert.deepEqual([claude.installed, claude.usable, claude.version, claude.path, claude.lab], [false, false, null, null, 'anthropic']);
  assert.match(claude.reason, /not installed/);
  assert.ok(claude.installHint.text && claude.installHint.url);
  assert.deepEqual([gemini.installed, gemini.usable, gemini.lab], [false, false, 'google']);
  assert.deepEqual([oss.installed, oss.usable, oss.lab], [true, false, 'Open Source']);
  assert.deepEqual([mock.installed, mock.usable, mock.auth, mock.lab, mock.reason, mock.installHint], [true, true, 'ok', 'mock', null, null]);
  assert.equal(w.providers.usable('claude'), false);
  assert.equal(w.providers.usable('mock'), true);
  assert.equal(w.providers.usable('nope'), false);
  assert.throws(() => w.providers.get('nope'), /Unknown provider/);
  assert.equal(typeof w.providers.get('claude').buildRun, 'function');
});

test('registry: claude installed and API-key-only enforced; subscription is ignored', async (t) => {
  const w = world(t, { claude: {}, keys: { anthropic: 'sk-ant-test' } });
  let claude = await w.by('claude');
  assert.deepEqual([claude.installed, claude.version, claude.path, claude.auth, claude.mode, claude.usable], [true, '2.1.289', path.join(w.bin, 'claude'), 'ok', null, false]);
  assert.match(claude.reason, /Enable API key mode/);
  assert.equal(claude.installHint, null);
  assert.equal(claude.loginCmd, null);
  assert.deepEqual(w.read('claude-calls.log').trim().split('\n').sort(), ['--version', 'auth status --json']);
  const env = w.read('claude-env.txt');
  assert.ok(!/ANTHROPIC|CLAUDE_CODE|CLAUDECODE|GEMINI/.test(env), 'probes run in the clean environment');
  assert.match(env, /DISABLE_AUTOUPDATER=1/);

  w.setSettings({ auth: { claude: 'subscription' } });
  assert.equal(w.providers.usable('claude'), false, 'subscription mode is disabled in Phase 0');
  assert.equal(w.providers.status('claude').mode, null);
  assert.deepEqual(await w.providers.keyEnv('claude'), {}, 'subscription never exposes a saved key');

  w.setSettings({ auth: { claude: 'apikey' } });
  assert.equal(w.providers.usable('claude'), true, 'a settings change shows at once');
  assert.equal(w.providers.status('claude').reason, null);
  w.setSettings({ auth: { claude: 'bogus' } });
  assert.equal(w.providers.usable('claude'), false);
});

test('registry: claude signed out, and API key mode', async (t) => {
  const w = world(t, { claude: { auth: '{"loggedIn": false, "authMethod": "none"}', authExit: 1 } });
  let claude = await w.by('claude');
  assert.deepEqual([claude.auth, claude.usable], ['none', false]);
  assert.match(claude.reason, /Enable API key mode/);
  assert.deepEqual(await w.providers.keyEnv('claude'), {}, 'no key without apikey mode');

  w.setSettings({ auth: { claude: 'apikey' } });
  claude = await w.by('claude');
  assert.deepEqual([claude.keySet, claude.usable], [false, false]);
  assert.match(claude.reason, /No API key/);
  assert.deepEqual(await w.providers.keyEnv('claude'), {});

  w.keys.anthropic = 'sk-ant-test';
  await w.providers.refresh();
  claude = w.providers.status('claude');
  assert.deepEqual([claude.keySet, claude.usable, claude.reason], [true, true, null], 'with a key the sign-in state does not matter');
  assert.deepEqual(await w.providers.keyEnv('claude'), { ANTHROPIC_API_KEY: 'sk-ant-test' });
  assert.ok(!JSON.stringify(w.logs).includes('sk-ant-test'), 'the key is never logged');
  assert.ok(!JSON.stringify(w.providers.list()).includes('sk-ant-test'));

  w.setSettings({ auth: { claude: 'subscription' } });
  assert.deepEqual(await w.providers.keyEnv('claude'), {}, 'a saved key is not handed out when subscription is chosen');
});

test('registry: a broken auth answer is "unknown" and checkAuth re-probes', async (t) => {
  const w = world(t, { claude: { auth: 'garbage' }, auth: { claude: 'apikey' }, keys: { anthropic: 'sk-ant-test' } });
  assert.equal((await w.by('claude')).auth, 'unknown');
  fs.writeFileSync(path.join(w.dir, 'claude-auth.json'), '{"loggedIn": true}');
  const after = await w.providers.checkAuth('claude');
  assert.deepEqual([after.auth, after.usable], ['ok', true]);
});

test('registry: detect is cached unless forced, and concurrent calls share one run', async (t) => {
  const w = world(t, { claude: {} });
  await Promise.all([w.providers.detect(), w.providers.detect(), w.providers.detect()]);
  await w.providers.detect();
  assert.equal(w.read('claude-calls.log').trim().split('\n').length, 2);
  await w.providers.detect({ force: true });
  assert.equal(w.read('claude-calls.log').trim().split('\n').length, 4);
});

test('registry: cooling keeps its end time and reason and clears itself', async (t) => {
  const w = world(t, { claude: {}, auth: { claude: 'apikey' }, keys: { anthropic: 'sk-ant-test' } });
  await w.providers.detect();
  const seen = [];
  const off = w.providers.onChange((list) => seen.push(list.find((p) => p.id === 'claude').usable));
  const until = Date.now() + 1500; // long enough for a busy Mac: the pause must still run when cool() returns
  const cooled = w.providers.cool('claude', until, "You've hit your session limit · resets 3:45pm");
  assert.deepEqual(cooled.cooling, { until, reason: "You've hit your session limit · resets 3:45pm" });
  assert.equal(w.providers.usable('claude'), false);
  assert.match(cooled.reason, /Paused until/);
  await sleep(1900);
  assert.equal(w.providers.usable('claude'), true);
  assert.equal(w.providers.status('claude').cooling, null);
  assert.deepEqual(seen, [false, true], 'listeners hear the pause and its end');

  // The first turn after that pause fails again without a reset time: the step doubles from 5 to 10 minutes.
  const before = Date.now();
  const dflt = w.providers.cool('claude', null, '');
  assert.ok(dflt.cooling.until >= before + 9.9 * 60_000 && dflt.cooling.until <= before + 10.1 * 60_000, 'second episode: 10 minutes');
  assert.equal(dflt.cooling.reason, 'rate limit');
  const far = w.providers.cool('claude', Date.now() + 365 * 24 * 3600_000, 'x');
  assert.ok(far.cooling.until > before + 11 * 60_000, 'a later reset time extends the running episode');
  assert.ok(far.cooling.until <= Date.now() + 7 * 24 * 3600_000 + 1000, 'a pause is capped at 7 days');
  const past = w.providers.cool('claude', Date.now() - 5, 'past');
  assert.equal(past.cooling.until, far.cooling.until, 'an end time in the past never shortens the episode');
  assert.equal(seen.length, 5);
  off();
  w.providers.cool('claude', Date.now() + 50, 'again');
  assert.equal(seen.length, 5, 'unsubscribed listeners hear nothing');
  assert.throws(() => w.providers.cool('nope', 1, 'x'), /Unknown provider/);
  assert.throws(() => w.providers.onChange('x'), TypeError);
});

test('registry: markAuth', async (t) => {
  const w = world(t, { claude: {}, agy: {}, auth: { claude: 'apikey', gemini: 'apikey' }, keys: { anthropic: 'sk-ant-test', gemini: 'g-test-key' } });
  await w.providers.detect();
  assert.equal(w.providers.usable('claude'), true);
  assert.equal(w.providers.markAuth('claude', 'none').usable, false);
  assert.equal(w.providers.markAuth('claude', 'bogus').auth, 'none');
  assert.equal(w.providers.markAuth('claude', 'ok').usable, true);
  assert.equal(w.providers.markAuth('gemini', 'ok').usable, true);
  assert.equal(w.settings().providers.gemini.authOk, true);
  assert.equal(w.providers.markAuth('gemini', 'none').usable, false);
  assert.equal(w.settings().providers.gemini.authOk, false, 'the Google sign-in state is kept in the settings');
  assert.equal((await w.by('gemini')).auth, 'none', 'and detect reads it back');
  assert.equal(w.read('agy-calls.log'), null, 'none of this ran agy');
});

test('registry: gemini detect is a file check only; agy is never executed', async (t) => {
  const w = world(t, { agy: {}, auth: { gemini: 'apikey' }, keys: { gemini: 'g-test-key' }, safety: 'sandboxed' });
  const gemini = await w.by('gemini');
  assert.deepEqual([gemini.installed, gemini.path, gemini.version, gemini.auth, gemini.usable], [true, path.join(w.bin, 'agy'), null, 'unknown', false]);
  assert.match(gemini.reason, /version/i);
  await w.providers.detect({ force: true });
  await w.providers.refresh();
  w.providers.list();
  assert.equal(w.read('agy-calls.log'), null, 'detect, refresh and list must not run agy');
  assert.equal(w.read('agy.pid'), null);
});

test('registry: checkAuth(gemini) runs "agy models" once with a closed stdin pipe and saves the result', async (t) => {
  const w = world(t, { agy: {}, auth: { gemini: 'apikey' }, keys: { gemini: 'g-test-key' } });
  await w.providers.detect();
  assert.ok(w.providers.status('gemini').path.startsWith(w.dir), 'the fake binary, not the real agy');
  const [a, b] = await Promise.all([w.providers.checkAuth('gemini'), w.providers.checkAuth('gemini')]);
  assert.deepEqual([a.auth, a.usable, a.version], ['ok', true, '1.5.8']);
  assert.deepEqual(a.models, ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-low', 'gemini-4-argon-medium']);
  assert.deepEqual(b.models, a.models);
  const settingsFile = path.join(w.dir, 'run', 'agy-check', 'settings.json');
  assert.deepEqual(w.read('agy-calls.log').trim().split('\n'), [`--settings ${settingsFile} models`, '--version'], 'two clicks make one check');
  assert.deepEqual(w.read('agy-stdin.log').trim().split('\n'), ['pipe', 'eof', 'pipe', 'eof'], 'stdin is a real pipe (not /dev/null, not a socket pair) and it is at end-of-file');
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'run')).filter((n) => n.startsWith('stdin-')), [], 'the short-lived FIFO file is removed');
  const env = w.read('agy-env.txt');
  assert.match(env, /AGY_CLI_DISABLE_AUTO_UPDATE=true/);
  assert.match(env, /GEMINI_API_KEY=g-test-key/, 'key passed in apikey mode');
  const saved = w.settings().providers.gemini;
  assert.deepEqual([saved.authOk, saved.version, saved.models.length], [true, '1.5.8', 3]);
  assert.ok(saved.checkedAt > 0);
  // a new registry (app restart) reads the saved state without running agy
  fs.rmSync(path.join(w.dir, 'agy-calls.log'));
  const again = await w.by('gemini');
  assert.deepEqual([again.auth, again.version, again.models.length, again.usable], ['ok', '1.5.8', 3, true]);
  assert.equal(w.read('agy-calls.log'), null);
});

test('registry: checkAuth(gemini) when signed out, in API key mode, and when no mode is chosen', async (t) => {
  const out = world(t, { agy: { loggedOut: true }, auth: { gemini: 'apikey' }, keys: { gemini: 'g-bad-key' }, safety: 'sandboxed' });
  await out.providers.detect();
  const st = await out.providers.checkAuth('gemini');
  assert.deepEqual([st.auth, st.usable], ['none', false]);
  assert.equal(out.settings().providers.gemini.authOk, false);
  const outSettingsFile = path.join(out.dir, 'run', 'agy-check', 'settings.json');
  assert.deepEqual(out.read('agy-calls.log').trim().split('\n'), [`--settings ${outSettingsFile} models`], 'no second call after a failed check');

  const keyed = world(t, { agy: {}, auth: { gemini: 'apikey' }, keys: { gemini: 'g-test-key' } });
  await keyed.providers.detect();
  assert.equal(keyed.providers.usable('gemini'), true, 'API key mode needs no sign-in');
  await keyed.providers.checkAuth('gemini');
  // --settings takes a file path (contract section 10), written 0600 in the run folder: never inline JSON.
  const settingsFile = path.join(keyed.dir, 'run', 'agy-check', 'settings.json');
  assert.equal(keyed.read('agy-calls.log').trim().split('\n')[0], `--settings ${settingsFile} models`);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { modelProvider: 'gemini' });
  assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  assert.match(keyed.read('agy-env.txt'), /GEMINI_API_KEY=g-test-key/);
  assert.ok(!JSON.stringify(keyed.logs).includes('g-test-key'));
  assert.ok(!JSON.stringify(keyed.settings()).includes('g-test-key'));

  const noMode = world(t, { agy: {} });
  await noMode.providers.detect();
  assert.equal((await noMode.providers.checkAuth('gemini')).usable, false);
  const noKey = world(t, { agy: {}, auth: { gemini: 'apikey' } });
  await noKey.providers.checkAuth('gemini');
  const missing = world(t, { auth: { gemini: 'apikey' }, keys: { gemini: 'g-test' } });
  assert.equal((await missing.providers.checkAuth('gemini')).installed, false);
  for (const w of [noMode, noKey, missing]) assert.equal(w.read('agy-calls.log'), null, 'agy must not run when the check cannot succeed');
});

test('registry: a hanging "agy models" is killed after the time limit', async (t) => {
  // 1500 ms: on a busy Mac the fake binary needs a moment before it has written its pid file
  const w = world(t, { agy: { sleep: 30 }, auth: { gemini: 'apikey' }, keys: { gemini: 'g-test-key' }, safety: 'sandboxed', timeouts: { agyModels: 1500 } });
  await w.providers.detect();
  const t0 = Date.now();
  const st = await w.providers.checkAuth('gemini');
  assert.ok(Date.now() - t0 < 8000);
  assert.deepEqual([st.auth, st.usable], ['unknown', false]);
  const pid = Number(w.read('agy.pid'));
  assert.ok(pid > 1, 'the fake binary ran and wrote its pid');
  await sleep(100);
  assert.equal(alive(pid), false, 'the process is gone');
});

test('registry: openLogin refuses consumer subscription login in Phase 0', async (t) => {
  const w = world(t, { claude: {}, agy: {} });
  await w.providers.detect();
  await assert.rejects(() => w.providers.openLogin('claude'), (err) => err.status === 400 && /Consumer subscription sign-in is disabled/.test(err.message));
  await assert.rejects(() => w.providers.openLogin('gemini'), (err) => err.status === 400 && /Consumer subscription sign-in is disabled/.test(err.message));
  await assert.rejects(() => w.providers.openLogin('mock'), (err) => err.status === 400 && /needs no sign-in/.test(err.message));
  await assert.rejects(() => w.providers.openLogin('oss'), (err) => err.status === 400 && /needs no sign-in/.test(err.message));
  await assert.rejects(() => w.providers.openLogin('nope'), /Unknown provider/);
});

test('registry: onChange fires only on a real change; selfTest is delegated; dispose stops events', async (t) => {
  const w = world(t, { claude: {}, auth: { claude: 'apikey' }, keys: { anthropic: 'sk-ant-test' } });
  const seen = [];
  w.providers.onChange((list) => seen.push(list));
  await w.providers.detect();
  await w.providers.detect({ force: true });
  await w.providers.refresh();
  assert.equal(seen.length, 1, 'the same statuses are not sent twice');
  w.providers.onChange(() => { throw new Error('bad listener'); });
  w.providers.markAuth('claude', 'none');
  assert.equal(seen.length, 2, 'a throwing listener does not stop the others');
  assert.ok(w.logs.some((l) => l.level === 'error' && /listener failed/.test(l.msg)));

  await assert.rejects(() => w.providers.selfTest('claude'), /not ready/);
  w.providers.setSelfTest(async (id, opts) => ({ ok: true, steps: [{ name: id, ok: true, detail: opts?.model }], logTail: [] }));
  assert.deepEqual(await w.providers.selfTest('claude', { model: 'm' }), { ok: true, steps: [{ name: 'claude', ok: true, detail: 'm' }], logTail: [] });
  await assert.rejects(() => w.providers.selfTest('nope'), /Unknown provider/);

  w.providers.dispose();
  w.providers.markAuth('claude', 'ok');
  assert.equal(seen.length, 2);
});

test('runCommand: closed stdin, timeout kills the process group, a missing binary does not throw', async (t) => {
  const dir = tmp(t);
  sh(path.join(dir, 'reader'), 'cat > /dev/null\necho done');
  const ok = await runCommand(path.join(dir, 'reader'), [], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 3000 });
  assert.deepEqual([ok.code, ok.stdout.trim(), ok.timedOut, ok.error], [0, 'done', false, null]);
  sh(path.join(dir, 'tree'), `sleep 60 &\necho $! > "${dir}/child.pid"\necho $$ > "${dir}/self.pid"\nwait`);
  const slow = await runCommand(path.join(dir, 'tree'), [], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1500 });
  assert.equal(slow.timedOut, true);
  await sleep(100);
  for (const f of ['child.pid', 'self.pid']) {
    const pid = Number(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(pid > 1, `${f} was written`);
    assert.equal(alive(pid), false, f);
  }
  const missing = await runCommand(path.join(dir, 'nope'), [], { env: {}, timeoutMs: 1000 });
  assert.equal(missing.code, null);
  assert.ok(missing.error);
});
