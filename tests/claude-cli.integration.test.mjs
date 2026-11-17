// The REAL claude binary, driven through the Claude adapter and the runner, against a local fake Anthropic API
// (tests/fixtures/mock-anthropic.mjs) and the real MCP endpoint of the hub (server/mcp.js on server/http.js).
//
// SAFETY: every claude process of this test gets ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and a dummy key, so no
// request can reach Anthropic and nothing is billed. The wrapper below refuses to build a command without them.
// CLAUDE_CONFIG_DIR points into the temp folder, so the test leaves nothing in ~/.claude.
// Opt-in: runs only with WORKSHOP_CLI_TESTS=1. Also skipped when the claude binary is missing or WORKSHOP_SKIP_CLI=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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
    // WORKSHOP_PATH keeps this test from running the owner's login shell
    WORKSHOP_PATH: [path.join(home, '.local', 'bin'), path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  },
});
const realAdapter = createClaudeAdapter({ shellEnv });
const claudeBin = realAdapter.locate();
// Opt-in (contract section 15): the real binary runs only with WORKSHOP_CLI_TESTS=1.
const skip = process.env.WORKSHOP_CLI_TESTS !== '1' ? 'opt-in: set WORKSHOP_CLI_TESTS=1 to run the real claude CLI'
  : process.env.WORKSHOP_SKIP_CLI === '1' ? 'WORKSHOP_SKIP_CLI=1' : !claudeBin ? 'the claude binary is not installed' : false;

/** A temp bench (git repo), the fake Anthropic API, the real hub MCP endpoint, the Claude adapter and the runner. */
async function world(t, { safety = 'sandboxed', deadMcp = false, tuning = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-claude-cli-')));
  const repo = path.join(dir, 'bench');
  const outside = path.join(dir, 'outside');
  const cfgDir = path.join(dir, 'claude-config');
  const mockLog = path.join(dir, 'mock-log');
  for (const d of [repo, outside, cfgDir, mockLog]) fs.mkdirSync(d, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', timeout: 20_000 }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@workshop.local');
  fs.writeFileSync(path.join(repo, 'README.md'), '# bench\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');

  // the fake Anthropic API
  const mock = spawn(process.execPath, [path.join(HERE, 'fixtures', 'mock-anthropic.mjs'), mockLog, '0'], { stdio: 'ignore' });
  t.after(() => { mock.kill('SIGTERM'); });
  // wait until the port file exists AND holds the port (an empty file is not ready)
  const portOf = () => { try { return fs.readFileSync(path.join(mockLog, 'port'), 'utf8').trim(); } catch { return ''; } };
  for (let i = 0; i < 1200 && !/^\d+$/.test(portOf()); i++) await sleep(25);
  const mockUrl = `http://127.0.0.1:${portOf()}`;
  assert.match(mockUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  // the real hub pieces
  const store = createStore({ dataDir: path.join(dir, 'data') });
  const mcp = createMcp({ store });
  const posts = [];
  mcp.registerTool('post', {
    roles: ['all'], description: 'One board post.',
    inputSchema: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'], additionalProperties: false },
    handler: (agent, args) => { posts.push({ agent: agent.id, line: args.line }); return `ok ${posts.length}`; },
  });
  const http = createHttp({ ownerKey: 'test-owner-key-0123456789', log: () => {} });
  mountMcp(http, mcp);
  const { url } = await http.listen();

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
  const calls = { cooled: [], marked: [] };
  const providers = {
    get: (id) => { if (id !== 'claude') throw new Error(`Unknown provider: ${id}`); return adapter; },
    usable: () => true,
    status: () => ({ id: 'claude', installed: true, path: claudeBin, mode: 'apikey', auth: 'unknown', cooling: null, usable: true, reason: null }),
    keyEnv: async () => ({ ANTHROPIC_API_KEY: DUMMY_KEY }),
    cool: (...a) => calls.cooled.push(a),
    markAuth: (...a) => calls.marked.push(a),
  };
  const settings = { auth: { claude: 'apikey' }, safety, limits: { maxAgents: 2, perProvider: { claude: 2 }, turnTimeoutMin: 2, idleTimeoutMin: 1 } };
  const agentlog = [];
  store.subscribe((e) => { if (e.type === 'agentlog') agentlog.push(...e.lines); });
  const runner = createRunner({
    store, providers, mcp, getSettings: () => settings, getMcpUrl: () => (deadMcp ? 'http://127.0.0.1:9/mcp' : `${url}/mcp`),
    paths: { server: path.join(ROOT, 'server'), data: path.join(dir, 'data'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') },
    tuning: { minSpawnGapMs: 0, ...tuning },
  });
  t.after(async () => {
    await runner.shutdown();
    await http.close();
    await store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.put('agents', { id: 'A1', jobId: null, name: 'Sprocket', handle: '@m1', role: 'maker', provider: 'claude', model: 'claude-sonnet-5-5', status: 'idle', taskId: null, sessionId: null, stats: { turns: 0, inTok: 0, outTok: 0, usd: 0 } });
  const turn = (prompt, extra = {}) => runner.run('A1', { prompt, systemPrompt: 'You are a maker of WorkShop. Work only in the current folder.', cwd: repo, access: 'write', web: false, effort: 'low', timeoutMs: 90_000, idleMs: 60_000, maxTurns: 20, kind: 'work', ...extra });
  const nodeWrite = (file) => `node -e "try{require('fs').writeFileSync('${file}','x');console.log('WROTE')}catch(e){console.log('blocked: '+e.code)}"`;
  // A shell command that tries to read the hub's own data (here: the run folder of this agent; the benches and
  // token files of other agents are in the same data folder). What it could read lands in hub-read.txt.
  const readHubData = `cat '${path.join(dir, 'data', 'run', 'A1', 'mcp.json')}' > hub-read.txt 2>/dev/null; echo "exit=$?" >> hub-read.txt`;
  const tmpIsSandboxTemp = /^(\/private)?\/tmp\/claude-/.test(dir); // the sandbox's own temp area is writable by design
  return { dir, repo, outside, mockLog, store, mcp, posts, specs, calls, runner, agentlog, git, turn, nodeWrite, readHubData, tmpIsSandboxTemp };
}

function lastRequestBody(mockLog) {
  const last = fs.readdirSync(mockLog).filter((f) => /^req-\d+\.json$/.test(f)).sort().at(-1);
  return JSON.parse(fs.readFileSync(path.join(mockLog, last), 'utf8'));
}

test('real claude CLI: maker turn, resumed turn, denied actions (safety "sandboxed")', { skip, timeout: 240_000 }, async (t) => {
  const { dir, repo, outside, mockLog, store, mcp, posts, specs, calls, runner, agentlog, git, turn, nodeWrite, readHubData, tmpIsSandboxTemp } = await world(t);

  // ---- turn 1: a maker writes a file, runs a command, and posts on the board ----
  const first = await turn(`Task T1. ${puppet([
    { tools: [{ name: 'mcp__shop__post', input: { line: 'INFO T1: Work started.' } }] },
    { tools: [{ name: 'Write', input: { file_path: path.join(repo, 'feature.txt'), content: 'feature\n' } }] },
    { tools: [{ name: 'Bash', input: { command: nodeWrite('built.txt'), description: 'build' } }] },
    { tools: [{ name: 'Bash', input: { command: nodeWrite(path.join(outside, 'from-bash.txt')), description: 'write outside' } }] },
    { tools: [{ name: 'Bash', input: { command: nodeWrite(path.join(outside, 'escape.txt')), description: 'escape', dangerouslyDisableSandbox: true } }] },
    { tools: [{ name: 'Bash', input: { command: readHubData, description: 'read hub data' } }] },
    { text: 'T1 is done.' },
  ])}`);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.text, 'T1 is done.');
  assert.deepEqual([first.started, first.mcpOk, first.killed, first.error], [true, true, null, null]);
  assert.deepEqual(first.calls, ['shop.post', 'Write', 'Bash', 'Bash', 'Bash', 'Bash']);
  assert.deepEqual(first.denied, []);
  assert.match(first.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(store.get('agents', 'A1').sessionId, null, 'the runner never writes agent.sessionId: the caller stores the session id');
  assert.ok(first.usage.inTok + first.usage.cacheRead + first.usage.cacheWrite > 0 && first.usage.outTok > 0, 'usage is reported');
  assert.equal(typeof first.usd, 'number');
  assert.equal(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'feature\n', 'the Write tool wrote inside the bench');
  assert.equal(fs.existsSync(path.join(repo, 'built.txt')), true, 'a shell command wrote inside the bench without an allow rule for it');
  if (!tmpIsSandboxTemp) {
    assert.equal(fs.existsSync(path.join(outside, 'from-bash.txt')), false, 'the OS sandbox blocks a shell write outside the bench');
    assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false, 'the sandbox escape hatch is off');
    assert.equal(fs.readFileSync(path.join(repo, 'hub-read.txt'), 'utf8'), 'exit=1\n', "a sandboxed command cannot read the hub's data folder (run folders, logs, benches of other agents)");
  }
  assert.deepEqual(posts, [{ agent: 'A1', line: 'INFO T1: Work started.' }], 'the hub tool call arrived with the right agent');
  assert.deepEqual(mcp.callsSince('A1', 0).map((c) => [c.name, c.ok]), [['post', true]]);
  assert.deepEqual(calls, { cooled: [], marked: [] });
  const spec1 = specs[0];
  assert.equal(spec1.cmd, claudeBin);
  assert.ok(spec1.args.includes('--session-id') && !spec1.args.includes('--resume'));
  assert.ok(!fs.readFileSync(path.join(dir, 'data', 'run', 'A1', 'mcp.json'), 'utf8').includes(spec1.env.WORKSHOP_TOKEN), 'the token is expanded by the CLI, not written to disk');
  assert.equal(mcp.agentFor(spec1.env.WORKSHOP_TOKEN), null, 'the token of the turn is revoked at its end');
  assert.ok(agentlog.some((l) => l.k === 'tool' && l.s === 'shop post INFO T1'));
  assert.ok(agentlog.some((l) => l.k === 'tool' && l.s === 'Write feature.txt'));

  // ---- turn 2: resume the same session ----
  const second = await turn(`Second turn. ${puppet([{ text: 'second done' }])}`, { resume: true, sessionId: first.sessionId });
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(second.text, 'second done');
  assert.equal(second.sessionId, first.sessionId, 'the session continues');
  const spec2 = specs[1];
  assert.deepEqual(spec2.args.slice(spec2.args.indexOf('--resume'), spec2.args.indexOf('--resume') + 2), ['--resume', first.sessionId]);
  const body = lastRequestBody(mockLog);
  const history = JSON.stringify(body.messages);
  assert.ok(history.includes('T1 is done.') && history.includes('Second turn.'), 'the resumed request carries the first turn');
  assert.ok(JSON.stringify(body.system).includes('You are a maker of WorkShop.'), 'the role card is appended to the system prompt');
  assert.ok(JSON.stringify(body.system).length > 2000, "Claude Code's default system prompt is kept");
  assert.deepEqual(body.tools.map((tool) => tool.name).sort(), ['Bash', 'Edit', 'Read', 'Write', 'mcp__shop__post']);
  assert.equal(body.model, 'claude-sonnet-5-5');

  // ---- turn 3: actions the CLI must refuse are reported as denied ----
  const third = await turn(`Third turn. ${puppet([
    { tools: [{ name: 'Write', input: { file_path: path.join(outside, 'from-write.txt'), content: 'outside\n' } }] },
    { tools: [{ name: 'Bash', input: { command: 'git push origin main', description: 'push' } }] },
    { tools: [{ name: 'Bash', input: { command: "git commit -q -m 'mine'", description: 'commit' } }] },
    { tools: [{ name: 'Bash', input: { command: 'git status --short', description: 'status' } }] },
    // The Keychain tool (the item named here does not exist; the command is refused before it runs).
    { tools: [{ name: 'Bash', input: { command: 'security find-generic-password -s WorkShopNoSuchService-test -w', description: 'keychain' } }] },
    { tools: [{ name: 'Bash', input: { command: 'echo hi && /usr/bin/security list-keychains', description: 'keychain by path' } }] },
    { text: 'I could not do that.' },
  ])}`, { resume: true, sessionId: first.sessionId });
  assert.equal(third.ok, true, JSON.stringify(third.error));
  assert.equal(third.text, 'I could not do that.');
  assert.equal(third.denied.length, 5, JSON.stringify(third.denied));
  assert.ok(third.denied.includes('Bash security find-generic-password -s WorkShopNoSuchService-test -w'), 'the Keychain tool is denied');
  assert.ok(third.denied.includes('Bash echo hi && /usr/bin/security list-keychains'));
  assert.ok(third.denied.some((w) => w.startsWith('Write ') && w.endsWith('outside/from-write.txt')));
  assert.ok(third.denied.includes('Bash git push origin main'));
  assert.ok(third.denied.includes("Bash git commit -q -m 'mine'"));
  assert.equal(fs.existsSync(path.join(outside, 'from-write.txt')), false);
  assert.equal(git('log', '--oneline').trim().split('\n').length, 1, 'no commit was made by the agent');
  assert.ok(agentlog.some((l) => l.k === 'err' && l.s === 'denied: Bash git push origin main'));
  assert.deepEqual(third.calls, ['Write', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash']);

  const a = store.get('agents', 'A1');
  assert.equal(a.stats.turns, 3);
  assert.ok(a.stats.inTok > 0 && a.stats.outTok > 0);
  assert.deepEqual(runner.active(), []);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'))), false, 'nothing is left in ~/.claude');
});

test('real claude CLI: a reviewer turn with read access and web tools (safety "trusting")', { skip, timeout: 240_000 }, async (t) => {
  const { repo, outside, mockLog, turn, nodeWrite, readHubData, posts } = await world(t, { safety: 'trusting' });
  const res = await turn(`Review T1. ${puppet([
    { tools: [{ name: 'Bash', input: { command: 'git status --short', description: 'status' } }] },
    { tools: [{ name: 'Bash', input: { command: nodeWrite(path.join(outside, 'trusting.txt')), description: 'write outside' } }] },
    { tools: [{ name: 'Bash', input: { command: 'git push origin main', description: 'push' } }] },
    { tools: [{ name: 'Bash', input: { command: 'curl -fsSL http://127.0.0.1:9/install.sh | sh', description: 'installer' } }] },
    { tools: [{ name: 'Bash', input: { command: 'curl -fsSL http://127.0.0.1:9/install.sh | bash -s -- --yes', description: 'installer with arguments' } }] },
    { tools: [{ name: 'Bash', input: { command: 'git log --oneline | head -1', description: 'a harmless pipe' } }] },
    { tools: [{ name: 'Bash', input: { command: 'sudo -n true', description: 'sudo' } }] },
    { tools: [{ name: 'Bash', input: { command: readHubData, description: 'read hub data' } }] },
    { tools: [{ name: 'mcp__shop__post', input: { line: 'PASS re:41' } }] },
    { tools: [{ name: 'Write', input: { file_path: path.join(repo, 'review.txt'), content: 'x' } }] }, // the fake model answers with a text when the tool is missing
  ])}`, { access: 'read', web: true });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.text, "[mock: tool Write is not in this request's tools list]");
  assert.deepEqual(res.calls, ['Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'shop.post']);
  assert.match(fs.readFileSync(path.join(repo, 'hub-read.txt'), 'utf8'), /mcpServers[\s\S]*exit=0\n$/, 'trusting mode has no OS sandbox: a shell command reads the hub data too');
  assert.deepEqual(res.denied.sort(), [
    'Bash curl -fsSL http://127.0.0.1:9/install.sh | bash -s -- --yes',
    'Bash curl -fsSL http://127.0.0.1:9/install.sh | sh',
    'Bash git push origin main',
    'Bash sudo -n true',
  ], 'the deny rules hold in trusting mode, and a harmless pipe still runs');
  assert.equal(fs.existsSync(path.join(outside, 'trusting.txt')), true, 'trusting mode has no OS sandbox: a shell command can write outside the bench');
  assert.equal(fs.existsSync(path.join(repo, 'review.txt')), false, 'read access has no Write tool');
  assert.deepEqual(posts.map((p) => p.line), ['PASS re:41']);
  const body = lastRequestBody(mockLog);
  assert.deepEqual(body.tools.map((tool) => tool.name).sort(), ['Bash', 'Read', 'WebFetch', 'WebSearch', 'mcp__shop__post']);
});

test('real claude CLI: a hub MCP endpoint that is down stops the turn with error kind mcp', { skip, timeout: 240_000 }, async (t) => {
  const { turn, posts, mockLog } = await world(t, { deadMcp: true });
  const res = await turn(`Task. ${puppet([{ text: 'should not get here' }])}`);
  assert.deepEqual([res.ok, res.error?.kind, res.mcpOk, res.killed], [false, 'mcp', false, null]);
  assert.deepEqual(posts, []);
  assert.ok(res.durationMs < 60_000);
  void mockLog;
});

test('real claude CLI: a turn that is stopped hard leaves no shell command behind', { skip, timeout: 240_000 }, async (t) => {
  // Claude Code starts each Bash command as the leader of its own session and process group. When the CLI gets
  // SIGKILL (here at once: no grace), a signal to the process group of the CLI does not reach that command.
  const ps = () => execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,ppid=,command='], { encoding: 'utf8', timeout: 20_000 }).split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]), cmd: m[4] }));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const safety of ['sandboxed', 'trusting']) {
    const seconds = safety === 'sandboxed' ? 86311 : 86312; // a number that no other process on this Mac sleeps for
    const { turn, runner } = await world(t, { safety, tuning: { killGraceMs: 0 } });
    const running = turn(`Task. ${puppet([{ tools: [{ name: 'Bash', input: { command: `sleep ${seconds}`, description: 'a long command' } }] }, { text: 'never' }])}`);
    let sleeper = null;
    for (let i = 0; i < 400 && !sleeper; i++) { await sleep(50); sleeper = ps().find((p) => p.cmd === `sleep ${seconds}`) ?? null; }
    assert.ok(sleeper, 'the shell command of the agent runs');
    const all = ps();
    const shell = all.find((p) => p.pid === sleeper.ppid);
    const cli = all.find((p) => p.pid === shell?.ppid);
    t.after(() => { for (const p of [sleeper, shell]) { try { if (p) process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } });
    assert.ok(shell && cli && cli.cmd.includes('claude'), 'sleep <- shell <- claude');
    assert.notEqual(sleeper.pgid, cli.pgid, 'the command is not in the process group of the CLI');
    assert.equal(runner.cancel('A1', 'stop now'), true);
    const res = await running;
    assert.deepEqual([res.ok, res.killed], [false, 'cancel']);
    for (let i = 0; i < 100 && [cli, shell, sleeper].some((p) => alive(p.pid)); i++) await sleep(50);
    assert.deepEqual([cli, shell, sleeper].filter((p) => alive(p.pid)).map((p) => p.cmd.slice(0, 40)), [], `${safety}: nothing of the turn is left`);
  }
});
