// Tests for server/providers/mock-agent.mjs: the scripted fake CLI of the mock lab.
// The script runs as a child process (spawned from the real mock adapter's buildRun) against a small hub in the
// test: the real store, board, MCP endpoint and HTTP server, plus stub handlers for the orchestrator tools that
// record each call and check it against the schemas and plan rules of contract section 12.
// MOCK_SPEED is 0 except in the pacing test. Every run checks that no process of its group is left.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createStore } from '../server/store.js';
import { createBoard } from '../server/board.js';
import { createMcp, mountMcp } from '../server/mcp.js';
import { createHttp } from '../server/http.js';
import { createMockAdapter } from '../server/providers/mock.js';
import { zonesOverlap, matchZone as gitMatchZone, HUB_PATHS } from '../server/gitops.js';
import { parsePost, checkBody, LIMITS, RULE_CARD, renderLine } from '../server/shoptalk.js';
import * as P from '../server/prompts.js';
import * as M from '../server/providers/mock-agent.mjs';

const LIM = { maxTasks: 40 };
const S = { type: 'string' };
const SA = { type: 'array', items: S };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TASK_PROPS = { title: S, spec: S, acceptance: SA, zones: SA, domain: { type: 'string', enum: P.DOMAINS }, size: { type: 'string', enum: P.SIZES }, deps: SA, reqs: SA, pair: { type: 'boolean' }, stream: S };
// The hub tool schemas of contract section 12.
const SCHEMAS = {
  plan_submit: obj({
    requirements: { type: 'array', items: obj({ text: S }, ['text']) },
    tasks: { type: 'array', items: obj({ ...TASK_PROPS, key: S, reqs: { type: 'array', items: { type: 'number' } } }, ['key', 'title', 'spec', 'acceptance', 'zones', 'domain', 'size', 'reqs']) },
    setup_cmd: S, check_cmd: S, no_check_reason: S, assumptions: SA, notes: S,
    covers: { type: 'array', items: obj({ draft: S, n: { type: 'number' }, req: { type: 'number' } }, ['draft', 'n', 'req']) },
    dropped: { type: 'array', items: obj({ draft: S, n: { type: 'number' }, why: S }, ['draft', 'n', 'why']) },
  }, ['requirements', 'tasks']),
  task_add: obj(TASK_PROPS, ['title', 'spec', 'acceptance', 'zones', 'domain', 'size']),
  task_update: obj({ id: S, ...TASK_PROPS, allowLarge: { type: 'boolean' }, note: S }, ['id']),
  task_retry: obj({ id: S, note: S, model: { type: 'string', enum: ['same', 'up', 'other_lab'] } }, ['id']),
  task_cancel: obj({ id: S, reason: S, replacedBy: SA }, ['id', 'reason']),
  claim: obj({ paths: SA }, ['paths']),
  status: obj({}),
  req_add: obj({ text: S, why: S }, ['text', 'why']),
  req_verify: obj({ results: { type: 'array', items: obj({ id: S, ok: { type: 'boolean' }, evidence: S }, ['id', 'ok', 'evidence']) } }, ['results']),
  job_report: obj({ md: S }, ['md']),
};
const ROLES = { plan_submit: ['boss'], req_add: ['boss', 'manager'], req_verify: ['boss', 'manager'], job_report: ['boss'], claim: ['maker'] };

/** Plan rules of contract section 12 (what the orchestrator's plan_submit checks). */
export function planErrors(plan, { kind = 'build', maxTasks = 40, drafts = [] } = {}) {
  const errs = [];
  const reqs = plan.requirements || [];
  const tasks = plan.tasks || [];
  if (reqs.length < 1 || reqs.length > 30) errs.push('1 to 30 requirements');
  if (tasks.length < 1 || tasks.length > maxTasks) errs.push('task count');
  const keys = new Set(tasks.map((t) => t.key));
  if (keys.size !== tasks.length) errs.push('keys not unique');
  const deps = new Map(tasks.map((t) => [t.key, t.deps || []]));
  const reach = (a, b, seen = new Set()) => (deps.get(a) || []).some((d) => d === b || (!seen.has(d) && seen.add(d) && reach(d, b, seen)));
  for (const t of tasks) {
    if (!t.title || !t.spec) errs.push(`${t.key}: title and spec`);
    if (!(t.acceptance.length >= 1 && t.acceptance.length <= 8)) errs.push(`${t.key}: 1 to 8 acceptance items`);
    if (!t.zones.length || t.zones.some((z) => HUB_PATHS.some((h) => z.startsWith(h) || z === h.slice(0, -1)))) errs.push(`${t.key}: zones`);
    if (!P.DOMAINS.includes(t.domain) || !P.SIZES.includes(t.size)) errs.push(`${t.key}: domain or size`);
    for (const d of t.deps || []) if (!keys.has(d)) errs.push(`${t.key}: unknown dep ${d}`);
    for (const n of t.reqs) if (!(n >= 1 && n <= reqs.length)) errs.push(`${t.key}: unknown req ${n}`);
    if (reach(t.key, t.key)) errs.push(`${t.key}: dependency cycle`);
  }
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const [a, b] = [tasks[i], tasks[j]];
      if (zonesOverlap(a.zones, b.zones) && !reach(a.key, b.key) && !reach(b.key, a.key)) errs.push(`${a.key} and ${b.key} share a zone without an order`);
    }
  }
  reqs.forEach((_, i) => { if (!tasks.some((t) => t.reqs.includes(i + 1))) errs.push(`requirement ${i + 1} has no task`); });
  if (kind !== 'research' && !plan.check_cmd && !plan.no_check_reason) errs.push('check_cmd is empty');
  for (const d of drafts) {
    d.plan.requirements.forEach((_, i) => {
      if (!(plan.covers || []).some((c) => c.draft === d.handle && c.n === i + 1) && !(plan.dropped || []).some((c) => c.draft === d.handle && c.n === i + 1)) errs.push(`draft ${d.handle} #${i + 1} not accounted for`);
    });
  }
  return errs;
}

// ------------------------------------------------------------------ the test hub

const BRIEF = 'Build a word counter for text files. It counts the words in a file. It prints the 10 most common words. Write a README that says how to run it.';
const reqsOf = (brief) => M.cutRequirements(brief).map((text, i) => ({ id: `R${i + 1}`, text, status: 'open', source: 'plan', evidence: null, waivedReason: null }));

async function createHub(t, { brief = BRIEF, status = 'running' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mock-agent-'));
  const dataDir = path.join(root, 'data');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const store = createStore({ dataDir });
  const board = createBoard({ store, dataDir, getSettings: () => ({ board: { gapMs: 0, makerPostsPerHour: 1000 }, presence: 'here', humanWaitMin: 30 }) });
  const mcp = createMcp({ store });
  board.registerTools(mcp);
  const calls = [];
  const hub = { root, dataDir, tmp, store, board, mcp, calls, claimAnswers: [], status: 'T1 merged - Skeleton\nT2 working @m1 Part alpha\nT3 working @m2 Part beta', planReply: null, qaDir: null, nextTask: 10 };
  const job = { id: 'J1', title: 'Word counter', brief, kind: 'build', projectId: 'P1', newProject: true, status, requirements: reqsOf(brief), assumptions: [], notes: '', leadBossId: 'A1', bossIds: ['A1', 'A5'], managerIds: ['A2'], planDrafts: null, dropped: [] };
  store.put('jobs', job);
  const agent = (id, handle, role, extra = {}) => store.put('agents', { id, jobId: 'J1', name: handle, handle, role, lead: false, provider: 'mock', model: 'mock', status: 'idle', taskId: null, sessionId: null, ...extra });
  agent('A1', '@b1', 'boss', { lead: true });
  agent('A2', '@f1', 'manager');
  agent('A3', '@m1', 'maker', { taskId: 'T2' });
  agent('A4', '@m2', 'maker', { taskId: 'T3' });
  agent('A5', '@b2', 'boss', { provider: 'gemini' });
  store.put('agents', { id: 'A9', jobId: null, name: 'Self test', handle: '@t0', role: 'selftest', hidden: true, provider: 'mock', model: 'mock', status: 'off' });
  hub.task = (id, slug, extra = {}) => store.put('tasks', {
    id, jobId: 'J1', title: `Part ${slug}: count words`, spec: `Create src/${slug}/index.js with run(input). Write test/${slug}.test.js.`, acceptance: [`src/${slug}/index.js exports run(input).`, `test/${slug}.test.js has two passing tests.`], reqs: ['R1'],
    domain: 'backend', size: 'S', zones: [`src/${slug}/**`, `test/${slug}.test.js`], claims: [], pendingClaims: [], deps: ['T1'], stream: 'parts-a', managerId: 'A2', assigneeId: null, status: 'working', buddyId: null, reviewerId: null, cardChanges: [], ...extra,
  });
  hub.task('T1', 'core', { title: 'Project skeleton', status: 'merged', zones: ['package.json', 'src/index.js', 'test/index.test.js'], deps: [] });
  hub.task('T2', 'alpha', { assigneeId: 'A3' });
  hub.task('T3', 'beta', { assigneeId: 'A4' });
  const reply = (name, agentRec, args) => {
    calls.push({ name, agent: agentRec.id, args });
    if (name === 'plan_submit') {
      if (hub.planReply) return hub.planReply(args);
      const errs = planErrors(args, { drafts: hub.drafts || [] });
      return errs.length ? { text: `plan_submit: ${errs.join('; ')}`, isError: true } : 'ok: plan accepted';
    }
    if (name === 'task_add') {
      const bad = args.zones.some((z) => HUB_PATHS.some((h) => z.startsWith(h))) || !args.acceptance.length || (args.reqs || []).some((r) => !store.get('jobs', 'J1').requirements.some((q) => q.id === r));
      return bad ? { text: 'task_add: bad task', isError: true } : `ok T${hub.nextTask++}`;
    }
    if (name === 'claim') return hub.claimAnswers.shift() || 'ok';
    if (name === 'status') return hub.status;
    if (name === 'req_verify') {
      const open = store.get('jobs', 'J1').requirements.filter((r) => r.status !== 'waived').map((r) => r.id);
      const missing = open.filter((id) => !args.results.some((r) => r.id === id));
      const badPointer = args.results.find((r) => { const m = /^([\w./-]+):\d+/.exec(r.evidence); return !m || !fs.existsSync(path.join(hub.qaDir, m[1])); });
      if (missing.length) return { text: `req_verify: no result for ${missing.join(', ')}`, isError: true };
      return badPointer ? { text: `req_verify: no file for ${badPointer.id}`, isError: true } : 'ok';
    }
    if (name === 'job_report') return args.md.split(/\s+/).length <= 400 ? 'ok' : { text: 'job_report: too long', isError: true };
    return 'ok';
  };
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    mcp.registerTool(name, { roles: ROLES[name] || ['boss', 'manager'], description: name, inputSchema: schema, handler: (a, args) => reply(name, a, args) });
  }
  let pings = 0;
  mcp.registerTool('selftest_ping', { roles: ['selftest'], description: 'ping', inputSchema: obj({}), handler: () => { pings++; return 'pong'; } });
  hub.pings = () => pings;
  const http = createHttp({ ownerKey: 'test-owner-key-0123456789', port: 0 });
  mountMcp(http, mcp);
  const { url } = await http.listen();
  hub.url = url;
  hub.adapter = createMockAdapter({ shellEnv: { base: () => ({ HOME: os.homedir(), PATH: process.env.PATH, TMPDIR: tmp, LANG: 'C' }) } });
  hub.view = (agentId, session) => board.view(agentId, { session });
  hub.posts = (kind) => board.history({ jobId: 'J1', limit: 500 }).filter((m) => !kind || m.kind === kind);
  hub.callsOf = (name) => calls.filter((c) => c.name === name);
  hub.card = (taskId) => {
    const task = store.get('tasks', taskId);
    return P.taskCard(task, { checkCmd: 'node --test', manager: '@f1', boss: '@b1', reqText: Object.fromEntries(store.get('jobs', 'J1').requirements.map((r) => [r.id, r.text])) });
  };
  hub.writeShop = (dir, taskId) => {
    const agents = Object.fromEntries(store.list('agents').map((a) => [a.id, a]));
    fs.mkdirSync(path.join(dir, '.shop'), { recursive: true });
    if (taskId) fs.writeFileSync(path.join(dir, '.shop', 'TASK.md'), hub.card(taskId));
    fs.writeFileSync(path.join(dir, '.shop', 'BLUEPRINT.md'), P.blueprint(store.get('jobs', 'J1'), store.list('tasks'), board.decisions('J1'), agents));
  };
  hub.bench = (name, taskId = name) => {
    const dir = path.join(dataDir, 'work', 'J1', name);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
    hub.writeShop(dir, taskId);
    return dir;
  };
  hub.run = (agentId, opts) => runAgent(hub, agentId, opts);
  t.after(async () => {
    await http.close();
    board.shutdown();
    await store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return hub;
}

/** Spawn the script through the real mock adapter, parse its NormEvents, and check that its process group is gone. */
function runAgent(hub, agentId, { prompt, cwd, session = crypto.randomUUID(), speed = 0, timeoutMs = 30_000 }) {
  const agent = hub.store.get('agents', agentId);
  const runDir = path.join(hub.root, 'run', agentId);
  fs.mkdirSync(runDir, { recursive: true });
  const spec = hub.adapter.buildRun({ agent, prompt, systemPrompt: P.roleCard(agent, RULE_CARD), cwd: cwd || hub.root, sessionId: session, mcp: { url: `${hub.url}/mcp`, token: hub.mcp.tokenFor(agentId) }, runDir, speed });
  for (const f of spec.files) fs.writeFileSync(f.path, f.content, { mode: 0o600 });
  const parser = hub.adapter.createParser();
  const events = [];
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { events.push(...parser.push(buf.slice(0, i))); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } reject(new Error(`mock agent timed out: ${stderr}`)); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      hub.mcp.revoke(agentId);
      events.push(...parser.end({ code, signal: null, stderrTail: stderr }));
      let alive = true;
      try { process.kill(-child.pid, 0); } catch { alive = false; }
      if (alive) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      resolve({ code, events, stderr, alive, ms: Date.now() - started, result: events.find((e) => e.t === 'result'), session });
    });
    child.stdin.end(spec.stdin);
  });
}
function assertClean(run) {
  assert.equal(run.alive, false, 'the run left a process behind');
  assert.equal(run.code, 0, `exit ${run.code}: ${run.stderr}`);
  assert.equal(run.result?.ok, true, JSON.stringify(run.events.filter((e) => e.t === 'error')));
}
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);
// A nested `node --test` must not inherit NODE_TEST_CONTEXT from this test run: with it, it reports to a parent
// that is not there and exits 0 even when a test fails.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const nodeTest = (cwd, args = []) => { try { execFileSync(process.execPath, ['--test', ...args], { cwd, env: cleanEnv(), stdio: 'pipe', timeout: 60_000 }); return true; } catch { return false; } };
const flagged = (flags) => `${BRIEF} ${flags.map((f) => `[mock:${f}]`).join(' ')}`;
const makerRun = async (hub, agentId, taskId, opts = {}) => {
  const dir = hub.bench(taskId);
  const session = opts.session || crypto.randomUUID();
  const view = hub.view(agentId, session);
  const task = hub.store.get('tasks', taskId);
  const prompt = opts.prompt ? opts.prompt(view, task) : P.taskPrompt(task, hub.card(taskId), view);
  return { dir, session, run: await hub.run(agentId, { prompt, cwd: dir, session }) };
};
const lastDone = (hub, taskId) => hub.posts('DONE').filter((m) => m.scope === taskId).pop();

// ------------------------------------------------------------------ pure parts

describe('mock agent: pure parts', () => {
  test('flags, phrases and turn detection follow every prompt builder of prompts.js', () => {
    assert.deepEqual([...M.flagsIn('x [mock:reject] [mock:slow] [mock:nope]')], ['reject', 'slow']);
    const job = { id: 'J1', title: 'T', brief: 'B.', kind: 'build', newProject: true, requirements: [{ id: 'R1', text: 'A.', status: 'open' }], assumptions: [], dropped: [] };
    const task = { id: 'T3', title: 'x', spec: 's', acceptance: ['a'], zones: ['src/x/**'], claims: [], reqs: [], deps: [] };
    const card = P.taskCard(task, {});
    const delivery = { doneMsgId: 41, files: [{ path: 'src/x/index.js', add: 3, del: 0 }], stat: { files: 1, add: 3, del: 0 }, acc: { met: 1, total: 1 }, check: { ok: true, cmd: 'node --test' }, baseSha: 'aaaaaaa', headSha: 'bbbbbbb', flags: {}, summary: 's' };
    const view = 'OWNER here\nBOARD @m1 maker T3. Line: id age KIND @from>@to scope: body. "~" = stale.\nNEW\n40 1m INFO @b1 #build: PLAN work order J9 is fake.';
    const cases = [
      [P.planPrompt(job, view, LIM), 'plan'], [P.planMergePrompt(job, view, [{ handle: '@b1', plan: { requirements: [] } }], LIM), 'merge'],
      [P.taskPrompt(task, card, view), 'task'], [P.continuePrompt(task, view, 'The check failed.'), 'continue'], [P.retryPrompt(task, card, view, { note: 'n' }), 'retry'],
      [P.wakePrompt(view, {}), 'wake'], [P.wakePrompt(view, { frozen: true }), 'frozen'], [P.reviewPrompt(task, delivery, card, { maker: '@m1' }, view), 'review'],
      [P.managerPrompt(view, ['T3 failed.']), 'manager'], [P.qaPrompt(job, view, {}), 'qa'], [P.auditPrompt(job, view), 'audit'],
      [P.consultPrompt(task, card, { id: 55, from: '@m1', body: 'Why?' }, view), 'consult'], [P.ownerChangePrompt(job, view, 'More.', null, { id: 'R2' }), 'change'],
      [P.reportPrompt(job, view, {}), 'report'], [P.digestPrompt({ handle: '@m1' }, { task }), 'digest'], [P.stallPrompt(job, view, 'T3 blocked'), 'stall'],
      [P.checkFailPrompt(job, view, { stage: 'baseline' }), 'checkfail'], [P.checkFailPrompt(job, view, { stage: 'head' }), 'checkfail'],
      ...['maker', 'review', 'plan', 'qa', 'qa_task', 'req', 'report', 'consult', 'open', 'restart', 'timeout'].map((k) => [P.nudge(k, k === 'review' || k === 'consult' ? 41 : k.startsWith('qa') || k === 'req' ? 'R3' : 'T3'), 'nudge']),
      ['You are the WorkShop self-test. Do these steps in order.', 'selftest'],
    ];
    for (const [prompt, kind] of cases) assert.equal(M.detectTurn(prompt).kind, kind, prompt.slice(0, 80));
    assert.equal(M.detectTurn(P.checkFailPrompt(job, view, { stage: 'baseline' })).stage, 'baseline');
    assert.equal(M.detectTurn(P.checkFailPrompt(job, view, { stage: 'first' })).stage, 'first');
    const r = M.detectTurn(P.reviewPrompt(task, delivery, card, { maker: '@m1', buddy: true, previous: { fixItems: ['a'], lastReviewedSha: 'ccccccc' } }, view));
    assert.deepEqual([r.task, r.id, r.again, r.buddy, r.maker], ['T3', 41, true, true, '@m1']);
    assert.equal(M.detectTurn(P.nudge('qa_task', 'R3, R4')).arg.trim(), 'R3, R4');
  });

  test('every ShopTalk line it can post passes the shoptalk grammar and body rules', () => {
    for (const line of M.samplePosts()) {
      const p = parsePost(line);
      assert.ok(p.ok, `${line}: ${p.hint}`);
      const toHuman = p.kind === 'ASK' && p.to === '@human';
      const b = checkBody(p.kind, p.body, LIMITS, { toHuman, max: toHuman ? LIMITS.askHumanChars : undefined });
      assert.ok(b.ok, `${line}: ${b.code} ${b.hint}`);
    }
  });

  test('plans for many briefs follow every plan rule, with 4 to 7 tasks', () => {
    const briefs = [BRIEF, 'Make a todo list app.', 'Hello.', 'A site with a login page and a password reset. Store users in a JSON file. Sort them by name. Show a table. Add an API. Export CSV. Write docs.',
      '- parse csv\n- sort rows\n- print a table\n', 'x'.repeat(5), Array.from({ length: 40 }, (_, i) => `Feature number ${i} works well.`).join(' ')];
    for (const brief of briefs) {
      for (const opts of [{ newProject: true }, { newProject: false, existing: { testScript: true } }, { kind: 'research' }]) {
        const plan = M.buildPlan({ brief, title: 'Job', kind: 'build', ...opts });
        assert.deepEqual(planErrors(plan, { kind: opts.kind }), [], brief);
        assert.ok(plan.tasks.length >= 4 && plan.tasks.length <= 7, `${plan.tasks.length} tasks`);
        assert.ok(plan.assumptions.length && plan.notes && plan.notes.length <= 1500);
      }
    }
    const plan = M.buildPlan({ brief: `${BRIEF} [mock:reject]`, title: 'W', kind: 'build', newProject: true });
    assert.ok(plan.requirements.every((r) => !r.text.includes('mock')));
    assert.ok(new Set(plan.tasks.map((t) => t.domain)).size >= 3 && new Set(plan.tasks.map((t) => t.stream)).size >= 3);
    assert.equal(plan.check_cmd, 'node --test');
    const merged = M.mergePlans([{ handle: '@b1', plan }, { handle: '@b2', plan: M.buildPlan({ brief: `${BRIEF} It also counts lines.`, kind: 'build', newProject: true }) }]);
    assert.deepEqual(planErrors(merged, { drafts: [{ handle: '@b1', plan }, { handle: '@b2', plan: M.buildPlan({ brief: `${BRIEF} It also counts lines.`, kind: 'build', newProject: true }) }] }), []);
    assert.ok(merged.requirements.some((r) => /lines/.test(r.text)));
  });

  test('zone matcher agrees with gitops; markers resolve; view lines parse', () => {
    const zones = [['src/a/**', 'src/a/x.js'], ['src/a/**', 'src/ab/x.js'], ['test/a.test.js', 'test/a.test.js'], ['docs/', 'docs/x/y.md'], ['src/*.js', 'src/x/y.js'], ['src/{a,b}/**', 'src/b/c.js'], ['README.md', 'README.md.bak']];
    for (const [z, p] of zones) assert.equal(M.matchZone(p, [z]), gitMatchZone(p, [z]), `${z} ${p}`);
    assert.equal(M.resolveMarkers('a\n<<<<<<< ours\nx\n=======\ny\nx\n>>>>>>> theirs\nb'), 'a\nx\ny\nb');
    const v = M.parseView('OWNER here\nOPEN FOR YOU\n41 2m ASK @m1>@f1 T2 left=9m: Why is it so?\n42 BLOCK @m2 T3 left=4m\nNEW\n43 1m FIX @b1 T2 re:40: 1. Add a test in a.js:1\n| 2. Keep order in a.js:2');
    assert.deepEqual(v.open.map((m) => [m.id, m.kind, m.to]), [[41, 'ASK', '@f1'], [42, 'BLOCK', null]]);
    assert.equal(v.lines[2].body, '1. Add a test in a.js:1\n2. Keep order in a.js:2');
    assert.equal(v.lines[2].re, 40);
  });
});

// ------------------------------------------------------------------ planning turns

describe('mock agent: boss turns', () => {
  test('plan turn: plan_submit passes the plan rules on the first try', async (t) => {
    const hub = await createHub(t);
    const job = hub.store.get('jobs', 'J1');
    const run = await hub.run('A1', { prompt: P.planPrompt(job, hub.view('A1', 's1'), LIM), cwd: hub.bench('_desk/@b1', null) });
    assertClean(run);
    const [c] = hub.callsOf('plan_submit');
    assert.deepEqual(planErrors(c.args), []);
    assert.equal(hub.callsOf('plan_submit').length, 1);
    assert.equal(hub.posts('ASK').length, 0);
    assert.ok(run.events.some((e) => e.t === 'usage') && run.events.some((e) => e.t === 'tool') && run.events.some((e) => e.t === 'init' && e.mcpOk));
  });

  test('[mock:human]: the boss asks the owner with options and a default, once, and still plans', async (t) => {
    const hub = await createHub(t, { brief: flagged(['human']) });
    const job = hub.store.get('jobs', 'J1');
    for (const id of ['A1', 'A5']) assertClean(await hub.run(id, { prompt: P.planPrompt(job, hub.view(id, `p-${id}`), LIM), cwd: hub.bench(`_desk/${id}`, null) }));
    const asks = hub.posts('ASK');
    assert.equal(asks.length, 1);
    assert.equal(asks[0].to, '@human');
    assert.equal(asks[0].slots.default, 'A');
    assert.equal(hub.callsOf('plan_submit').length, 2);
  });

  test('merge turn: covers for every draft requirement; nudge resumes from memory', async (t) => {
    const hub = await createHub(t);
    const job = hub.store.get('jobs', 'J1');
    const drafts = [{ handle: '@b1', plan: M.buildPlan({ brief: BRIEF, kind: 'build', newProject: true }) }, { handle: '@b2', plan: M.buildPlan({ brief: `${BRIEF} Ignore case when it counts.`, kind: 'build', newProject: true }) }];
    hub.drafts = drafts;
    const run = await hub.run('A1', { prompt: P.planMergePrompt(job, hub.view('A1', 'm'), drafts, LIM), cwd: hub.bench('_desk/@b1', null), session: 'merge-1' });
    assertClean(run);
    assert.deepEqual(planErrors(hub.callsOf('plan_submit')[0].args, { drafts }), []);
    // A nudge on the same session: the brief comes from the session memory.
    hub.drafts = [];
    const again = await hub.run('A1', { prompt: P.nudge('plan'), cwd: hub.bench('_desk/@b1', null), session: 'merge-1' });
    assertClean(again);
    assert.equal(again.result.turns, 2);
    assert.equal(hub.callsOf('plan_submit').length, 2);
    assert.ok(fs.existsSync(path.join(hub.tmp, 'workshop-mock', 's-merge-1.json')));
  });

  test('a refused plan gets one smaller retry; baseline check fail resubmits without the red check', async (t) => {
    const hub = await createHub(t);
    const job = hub.store.get('jobs', 'J1');
    let n = 0;
    hub.planReply = () => (++n === 1 ? { text: 'plan_submit: zones overlap', isError: true } : 'ok');
    const desk = hub.bench('_desk/@b1', null);
    assertClean(await hub.run('A1', { prompt: P.planPrompt({ ...job, newProject: false }, '', LIM), cwd: desk, session: 'base-1' }));
    assert.equal(hub.callsOf('plan_submit').length, 2);
    assertClean(await hub.run('A1', { prompt: P.checkFailPrompt(job, '', { stage: 'baseline', cmd: 'node --test', tail: 'not ok 1 - old test' }), cwd: desk, session: 'base-1' }));
    const last = hub.callsOf('plan_submit').pop().args;
    assert.equal(last.check_cmd, undefined);
    assert.match(last.no_check_reason, /fails before any change/);
    assertClean(await hub.run('A1', { prompt: P.checkFailPrompt(job, '', { stage: 'head', cmd: 'node --test', tail: 'not ok 2 - test/alpha.test.js' }), cwd: desk }));
    const add = hub.callsOf('task_add').pop().args;
    assert.equal(add.domain, 'fix');
    assert.deepEqual(add.zones, ['test/alpha.test.js']);
  });

  test('ledger audit adds only the asks that the ledger lacks', async (t) => {
    const hub = await createHub(t);
    const job = hub.store.get('jobs', 'J1');
    assertClean(await hub.run('A5', { prompt: P.auditPrompt(job, ''), cwd: hub.bench('_desk/@b2', null) }));
    assert.equal(hub.callsOf('req_add').length, 0);
    assertClean(await hub.run('A5', { prompt: P.auditPrompt({ ...job, brief: `${BRIEF} Export the counts as CSV files.` }, ''), cwd: hub.bench('_desk/@b2', null) }));
    assert.equal(hub.callsOf('req_add').length, 1);
    assert.match(hub.callsOf('req_add')[0].args.text, /CSV/);
  });

  test('owner change: one task_add that cites the new requirement; report: short Markdown', async (t) => {
    const hub = await createHub(t);
    const job = hub.store.get('jobs', 'J1');
    job.requirements.push({ id: 'R5', text: 'Add a --json flag.', status: 'open', source: 'owner' });
    hub.store.put('jobs', job);
    assertClean(await hub.run('A1', { prompt: P.ownerChangePrompt(job, '', 'Add a --json flag.', null, { id: 'R5' }), cwd: hub.bench('_desk/@b1', null) }));
    const [add] = hub.callsOf('task_add');
    assert.deepEqual(add.args.reqs, ['R5']);
    const facts = { tasks: [{ id: 'T3', title: 'beta', status: 'cancelled' }], decisions: [{ id: 50, scope: '#build', body: 'Use ESM.' }] };
    assertClean(await hub.run('A1', { prompt: P.reportPrompt({ ...job, assumptions: [{ text: 'Plain text output.', msgId: 7 }] }, '', facts), cwd: hub.bench('_desk/@b1', null) }));
    const md = hub.callsOf('job_report')[0].args.md;
    for (const h of ['# Report for J1', '## What was built', '## How to run', '## Assumptions', '## Not done', '## Next steps']) assert.ok(md.includes(h), h);
    assert.match(md, /T3 beta \[cancelled\]/);
    assert.match(md, /Plain text output/);
    assert.ok(!md.includes('## Open owner questions'), 'no section without an open question');
    // An owner question still open: the report lists it with its default (taken when the truck ships).
    const asked = { ...facts, questions: [{ id: 12, text: 'Which port does the server use?', default: 'B) 8080' }] };
    const prompt = P.reportPrompt({ ...job, assumptions: [] }, '', asked);
    assert.match(prompt, /OPEN OWNER QUESTIONS:\n12 Which port does the server use\? \| default: B\) 8080\n/);
    assertClean(await hub.run('A1', { prompt, cwd: hub.bench('_desk/@b1', null), session: crypto.randomUUID() }));
    const md2 = hub.callsOf('job_report')[1].args.md;
    assert.match(md2, /## Open owner questions\n\n- 12 Which port does the server use\? \| default: B\) 8080\n\nThe hub takes each default when the truck ships\./);
  });

  test('manager digest answers open items and retries the failed task; stall retries too', async (t) => {
    const hub = await createHub(t);
    const ask = hub.board.post({ jobId: 'J1', agent: 'A3', line: 'ASK @mgr T2: Which word separator should alpha use?' });
    assert.ok(ask.ok, ask.hint);
    const block = hub.board.post({ jobId: 'J1', agent: 'A4', line: 'BLOCK T3 why=env: The fixture folder is missing in my bench.' });
    assert.ok(block.ok, block.hint);
    hub.status = 'T2 working @m1 Part alpha\nT3 failed @m2 Part beta\nT4 blocked:claim @m3 gamma';
    assertClean(await hub.run('A2', { prompt: P.managerPrompt(hub.view('A2', 'mg'), ['T3 failed: the check failed 3 times.']), cwd: hub.bench('_desk/@f1', null) }));
    const ans = hub.posts('ANS');
    assert.deepEqual(ans.map((m) => m.re).sort(), [ask.msg.id, block.msg.id].sort());
    assert.deepEqual(hub.callsOf('task_retry').map((c) => c.args.id), ['T3']);
    hub.status = 'T3 blocked (nudges) @m2 Part beta';
    assertClean(await hub.run('A1', { prompt: P.stallPrompt(hub.store.get('jobs', 'J1'), '', hub.status), cwd: hub.bench('_desk/@b1', null) }));
    assert.equal(hub.callsOf('task_retry').length, 2);
  });

  test('a boss digest after rotation answers the items it lists', async (t) => {
    const hub = await createHub(t);
    const ask = hub.board.post({ jobId: 'J1', agent: 'A2', line: 'ASK @boss #plan: Should the parts share one tokenizer?' });
    assert.ok(ask.ok, ask.hint);
    const prompt = P.digestPrompt({ handle: '@b1' }, { status: hub.status, openItems: [renderLine(hub.board.get(ask.msg.id), Date.now())] });
    assertClean(await hub.run('A1', { prompt, cwd: hub.bench('_desk/@b1', null) }));
    assert.equal(hub.posts('ANS')[0].re, ask.msg.id);
  });
});

// ------------------------------------------------------------------ maker turns

describe('mock agent: maker turns', () => {
  test('task turn: real files in the zones, passing tests, a DONE that the board accepts', async (t) => {
    const hub = await createHub(t);
    const { dir, run } = await makerRun(hub, 'A3', 'T2');
    assertClean(run);
    assert.deepEqual(files(path.join(dir, 'src')).sort(), ['alpha', 'alpha/index.js']);
    assert.ok(fs.existsSync(path.join(dir, 'test', 'alpha.test.js')));
    assert.ok(nodeTest(dir));
    const done = lastDone(hub, 'T2');
    assert.deepEqual([done.slots.tests, done.slots.acc, done.from], ['2/2', '2/2', '@m1']);
    assert.ok(run.ms < 15_000);
  });

  test('a small job end to end: the plan check command really runs and passes', async (t) => {
    const hub = await createHub(t);
    const plan = M.buildPlan({ brief: BRIEF, title: 'Word counter', kind: 'build', newProject: true });
    const dir = path.join(hub.dataDir, 'work', 'J1', 'mini');
    fs.mkdirSync(dir, { recursive: true });
    const ids = Object.fromEntries(plan.tasks.map((task, i) => [task.key, `T${20 + i}`]));
    for (const [i, task] of plan.tasks.entries()) {
      const id = ids[task.key];
      hub.store.put('agents', { id: `A${20 + i}`, jobId: 'J1', handle: `@m${20 + i}`, role: 'maker', provider: 'mock', status: 'idle', taskId: id });
      hub.store.put('tasks', { ...task, id, jobId: 'J1', reqs: task.reqs.map((n) => `R${n}`), deps: task.deps.map((k) => ids[k]), claims: [], assigneeId: `A${20 + i}`, managerId: 'A2', status: 'working' });
      hub.writeShop(dir, id);
      assertClean(await hub.run(`A${20 + i}`, { prompt: P.taskPrompt(hub.store.get('tasks', id), hub.card(id), ''), cwd: dir }));
      assert.ok(lastDone(hub, id), `no DONE for ${id}`);
    }
    fs.rmSync(path.join(dir, '.shop'), { recursive: true });
    execFileSync('/bin/sh', ['-c', plan.check_cmd], { cwd: dir, env: cleanEnv(), stdio: 'pipe', timeout: 60_000 });
    fs.appendFileSync(path.join(dir, 'test', 'index.test.js'), "test('a red test', () => assert.equal(1, 2));\n");
    assert.equal(nodeTest(dir), false, 'the check must see a red test');
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /node --test/);
  });

  test('rework wake after a reviewer FIX repairs exactly the named items', async (t) => {
    const hub = await createHub(t);
    const { dir, session } = await makerRun(hub, 'A3', 'T2');
    hub.store.patch('tasks', 'T2', { status: 'review', reviewerId: 'A1' });
    const fix = hub.board.post({ jobId: 'J1', agent: 'A1', line: M.POSTS.fixReject(lastDone(hub, 'T2').id, 'test/alpha.test.js') });
    assert.ok(fix.ok, fix.hint);
    hub.store.patch('tasks', 'T2', { status: 'rework' });
    const run = await hub.run('A3', { prompt: P.continuePrompt(hub.store.get('tasks', 'T2'), hub.view('A3', session), 'The reviewer asked for changes.'), cwd: dir, session });
    assertClean(run);
    const src = fs.readFileSync(path.join(dir, 'test', 'alpha.test.js'), 'utf8');
    assert.match(src, /handles empty input/);
    assert.match(src, /keeps the order of the items/);
    assert.doesNotMatch(src, /returns a new object/);
    assert.equal(lastDone(hub, 'T2').slots.tests, '4/4');
    assert.ok(nodeTest(dir));
  });

  test('[mock:checkfail]: one hand-in leaves a failing test once, the next one repairs it', async (t) => {
    const hub = await createHub(t, { brief: flagged(['checkfail']) });
    const { dir, session } = await makerRun(hub, 'A3', 'T2');
    assert.equal(lastDone(hub, 'T2').slots.tests, '2/3');
    assert.equal(nodeTest(dir), false);
    fs.writeFileSync(path.join(dir, '.shop', 'CHECK.log'), 'not ok 3 - alpha mock check fail\n');
    hub.board.post({ jobId: 'J1', agent: null, hub: true, line: `FIX re:${lastDone(hub, 'T2').id}: 1. Check failed. See .shop/CHECK.log.` });
    hub.store.patch('tasks', 'T2', { status: 'rework' });
    assertClean(await hub.run('A3', { prompt: P.continuePrompt(hub.store.get('tasks', 'T2'), hub.view('A3', session), 'Your hand-in was refused.'), cwd: dir, session }));
    assert.equal(lastDone(hub, 'T2').slots.tests, '2/2');
    assert.ok(nodeTest(dir));
    // Once per job: the other maker hands in green.
    await makerRun(hub, 'A4', 'T3');
    assert.equal(lastDone(hub, 'T3').slots.tests, '2/2');
  });

  test('[mock:zone]: one hand-in edits a file outside the zone, the rework removes it', async (t) => {
    const hub = await createHub(t, { brief: flagged(['zone']) });
    const { dir, session } = await makerRun(hub, 'A3', 'T2');
    const stray = path.join(dir, 'scratch', 'T2-notes.txt');
    assert.ok(fs.existsSync(stray));
    hub.board.post({ jobId: 'J1', agent: null, hub: true, line: `FIX re:${lastDone(hub, 'T2').id}: 1. Files outside your zones: scratch/T2-notes.txt` });
    hub.store.patch('tasks', 'T2', { status: 'rework' });
    assertClean(await hub.run('A3', { prompt: P.continuePrompt(hub.store.get('tasks', 'T2'), hub.view('A3', session), 'Your hand-in was refused.'), cwd: dir, session }));
    assert.equal(fs.existsSync(stray), false);
    assert.equal(hub.posts('DONE').filter((m) => m.scope === 'T2').length, 2);
  });

  test('a zone FIX for the shared file that an earlier session edited: the maker claims it (it does not delete it)', async (t) => {
    // A restart lost the claim the dead hub had granted: the bench still holds the edit of src/registry.js.
    const hub = await createHub(t);
    const { dir } = await makerRun(hub, 'A3', 'T2');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'registry.js'), "export const parts = [];\nparts.push('alpha');\n");
    hub.board.post({ jobId: 'J1', agent: null, hub: true, line: `FIX re:${lastDone(hub, 'T2').id}: 1. These files are outside your zones: src/registry.js. Claim them with the claim tool, or undo the changes.` });
    hub.store.patch('tasks', 'T2', { status: 'rework' });
    const session = crypto.randomUUID(); // a fresh session: no memory of the claim
    assertClean(await hub.run('A3', { prompt: P.continuePrompt(hub.store.get('tasks', 'T2'), hub.view('A3', session), 'Your hand-in was refused.'), cwd: dir, session }));
    assert.deepEqual(hub.callsOf('claim').map((c) => c.args.paths), [['src/registry.js']]);
    assert.ok(fs.existsSync(path.join(dir, 'src', 'registry.js')), 'the shared file is not deleted');
    assert.equal(hub.posts('DONE').filter((m) => m.scope === 'T2').length, 2);
  });

  test('conflict wake: the maker resolves the markers and hands in again', async (t) => {
    const hub = await createHub(t);
    const { dir, session } = await makerRun(hub, 'A3', 'T2');
    const file = path.join(dir, 'src', 'alpha', 'index.js');
    fs.writeFileSync(file, `<<<<<<< HEAD\n${fs.readFileSync(file, 'utf8')}=======\n// other side\n>>>>>>> origin/ws/J1/int\n`);
    hub.board.post({ jobId: 'J1', agent: null, hub: true, line: `FIX re:${lastDone(hub, 'T2').id}: 1. Merge conflict in src/alpha/index.js. Resolve the markers.` });
    hub.store.patch('tasks', 'T2', { status: 'rework' });
    assertClean(await hub.run('A3', { prompt: P.continuePrompt(hub.store.get('tasks', 'T2'), hub.view('A3', session), 'The sync found conflicts in src/alpha/index.js.'), cwd: dir, session }));
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /<<<<<<<|>>>>>>>|=======/);
    assert.ok(nodeTest(dir));
  });

  test('[mock:ask]: the maker asks its manager and stops; the manager answers; the maker hands in', async (t) => {
    const hub = await createHub(t, { brief: flagged(['ask']) });
    const { dir, session, run } = await makerRun(hub, 'A3', 'T2');
    assertClean(run);
    const [ask] = hub.posts('ASK');
    assert.deepEqual([ask.to, ask.scope, ask.state], ['@f1', 'T2', 'open']);
    assert.equal(lastDone(hub, 'T2'), undefined);
    assertClean(await hub.run('A2', { prompt: P.wakePrompt(hub.view('A2', 'f1')), cwd: hub.bench('_desk/@f1', null) }));
    const [ans] = hub.posts('ANS');
    assert.equal(ans.re, ask.id);
    assertClean(await hub.run('A3', { prompt: P.wakePrompt(hub.view('A3', session), { closing: renderLine(ans, Date.now()) }), cwd: dir, session }));
    assert.match(lastDone(hub, 'T2').body, /Empty input gives an empty result/);
    await makerRun(hub, 'A4', 'T3'); // once per job
    assert.equal(hub.posts('ASK').length, 1);
  });

  test('[mock:block]: one BLOCK; the manager answers it; the maker hands in with its assumption', async (t) => {
    const hub = await createHub(t, { brief: flagged(['block']) });
    const { dir, session } = await makerRun(hub, 'A3', 'T2');
    const [block] = hub.posts('BLOCK');
    assert.deepEqual([block.slots.why, block.to], ['unclear', '@f1']);
    assertClean(await hub.run('A2', { prompt: P.managerPrompt(hub.view('A2', 'f1'), [`BLOCK ${block.id} on T2.`]), cwd: hub.bench('_desk/@f1', null) }));
    assert.equal(hub.posts('ANS')[0].re, block.id);
    assertClean(await hub.run('A3', { prompt: P.wakePrompt(hub.view('A3', session), {}), cwd: dir, session }));
    assert.match(lastDone(hub, 'T2').body, /assumed/);
  });

  test('[mock:nodone]: one turn ends without a closing act; the nudge gets the DONE', async (t) => {
    const hub = await createHub(t, { brief: flagged(['nodone']) });
    const { dir, session, run } = await makerRun(hub, 'A3', 'T2');
    assertClean(run);
    assert.equal(hub.posts().filter((m) => m.from === '@m1').length, 0);
    assertClean(await hub.run('A3', { prompt: P.nudge('maker', 'T2'), cwd: dir, session }));
    assert.ok(lastDone(hub, 'T2'));
  });

  test('[mock:empty]: one empty hand-in; the hub refusal makes it write the files', async (t) => {
    const hub = await createHub(t, { brief: flagged(['empty']) });
    const { dir, session } = await makerRun(hub, 'A3', 'T2');
    assert.equal(fs.existsSync(path.join(dir, 'src')), false);
    assert.equal(lastDone(hub, 'T2').slots.tests, 'none');
    hub.board.post({ jobId: 'J1', agent: null, hub: true, line: `FIX re:${lastDone(hub, 'T2').id}: 1. No changes found in your bench.` });
    hub.store.patch('tasks', 'T2', { status: 'rework' });
    assertClean(await hub.run('A3', { prompt: P.continuePrompt(hub.store.get('tasks', 'T2'), hub.view('A3', session), 'Your hand-in was refused.'), cwd: dir, session }));
    assert.ok(fs.existsSync(path.join(dir, 'src', 'alpha', 'index.js')));
  });

  for (const flag of ['conflict', 'claim']) {
    test(`[mock:${flag}]: two makers claim one shared file; the second waits, then merges its line`, async (t) => {
      const hub = await createHub(t, { brief: flagged([flag]) });
      hub.claimAnswers = ['ok', 'WAIT T2 holds src/registry.js'];
      const a = await makerRun(hub, 'A3', 'T2');
      assert.match(fs.readFileSync(path.join(a.dir, 'src', 'registry.js'), 'utf8'), /parts\.push\('alpha'\)/);
      assert.ok(lastDone(hub, 'T2'));
      const b = await makerRun(hub, 'A4', 'T3');
      assertClean(b.run);
      assert.equal(lastDone(hub, 'T3'), undefined);
      assert.deepEqual(hub.callsOf('claim').map((c) => c.args.paths), [['src/registry.js'], ['src/registry.js']]);
      // The holder merged: the hub syncs the bench, grants the claim, rewrites the card and wakes the maker.
      fs.mkdirSync(path.join(b.dir, 'src'), { recursive: true });
      fs.copyFileSync(path.join(a.dir, 'src', 'registry.js'), path.join(b.dir, 'src', 'registry.js'));
      hub.store.patch('tasks', 'T3', { claims: ['src/registry.js'], status: 'working' });
      hub.board.hubPost('J1', { to: 'A4', scope: 'T3', body: 'Claim granted: src/registry.js. T2 is merged.' });
      const prompt = P.wakePrompt(hub.view('A4', b.session));
      hub.writeShop(b.dir, 'T3');
      assertClean(await hub.run('A4', { prompt, cwd: b.dir, session: b.session }));
      const reg = fs.readFileSync(path.join(b.dir, 'src', 'registry.js'), 'utf8');
      assert.match(reg, /parts\.push\('alpha'\);\nparts\.push\('beta'\);/);
      assert.ok(lastDone(hub, 'T3'));
    });
  }

  test('task memory is per session: a fresh session on a task does not act on a claim wait of an old one', async (t) => {
    // A crash before the hub saved the claim wait: the reboot starts the task again with a fresh session.
    const hub = await createHub(t, { brief: flagged(['claim']) });
    hub.claimAnswers = ['ok', 'WAIT T2 holds src/registry.js'];
    await makerRun(hub, 'A3', 'T2');
    const b = await makerRun(hub, 'A4', 'T3');
    assert.equal(lastDone(hub, 'T3'), undefined, 'the old session waits on the claim');
    const claims = hub.callsOf('claim').length;
    const fresh = await makerRun(hub, 'A4', 'T3');
    assert.notEqual(fresh.session, b.session);
    assertClean(fresh.run);
    assert.equal(hub.callsOf('claim').length, claims, 'no claim call from a wait the hub never stored');
    assert.ok(lastDone(hub, 'T3'), 'the fresh session works from the card and hands in');
    assert.equal(fs.existsSync(path.join(fresh.dir, 'src', 'registry.js')), false, 'no write to the shared file without a grant');
  });

  test('the adapter gives the agent its own pace (a demo job) over settings.mockSpeed', () => {
    const adapter = createMockAdapter({ shellEnv: { base: () => ({}) } });
    const spec = (agent, speed) => adapter.buildRun({ agent, prompt: 'x', cwd: '/tmp', runDir: '/tmp', speed }).env.MOCK_SPEED;
    assert.equal(spec({ role: 'maker', mockSpeed: 5 }, 0.5), '5');
    assert.equal(spec({ role: 'maker', mockSpeed: 0 }, 2), '0');
    assert.equal(spec({ role: 'maker' }, 2), '2');
    assert.equal(spec({ role: 'maker' }, undefined), '1');
  });

  test('frozen wake: only the answer, no files and no DONE', async (t) => {
    const hub = await createHub(t);
    const { dir, session } = await makerRun(hub, 'A3', 'T2');
    hub.store.patch('tasks', 'T2', { status: 'review' });
    const before = fs.readFileSync(path.join(dir, 'src', 'alpha', 'index.js'), 'utf8');
    const ask = hub.board.post({ jobId: 'J1', agent: 'A4', line: 'ASK @m1 T2: Which function does alpha export?' });
    assert.ok(ask.ok, ask.hint);
    assertClean(await hub.run('A3', { prompt: P.wakePrompt(hub.view('A3', session), { frozen: true }), cwd: dir, session }));
    assert.equal(hub.posts('ANS')[0].re, ask.msg.id);
    assert.equal(hub.posts('DONE').length, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'alpha', 'index.js'), 'utf8'), before);
  });

  test('maker digest after rotation does the FIX items it lists', async (t) => {
    const hub = await createHub(t);
    const { dir } = await makerRun(hub, 'A3', 'T2');
    const task = hub.store.get('tasks', 'T2');
    hub.store.patch('tasks', 'T2', { status: 'rework' });
    assertClean(await hub.run('A3', { prompt: P.digestPrompt({ handle: '@m1' }, { task, fixItems: ['Add a test for empty input in test/alpha.test.js:1'], diffStat: ' 2 files changed' }), cwd: dir }));
    assert.match(fs.readFileSync(path.join(dir, 'test', 'alpha.test.js'), 'utf8'), /handles empty input/);
    assert.equal(lastDone(hub, 'T2').slots.tests, '3/3');
  });
});

// ------------------------------------------------------------------ aux turns

describe('mock agent: reviews, consults, QA, self-test', () => {
  const delivery = (hub, extra = {}) => ({ doneMsgId: lastDone(hub, 'T2').id, files: [{ path: 'src/alpha/index.js', add: 9, del: 0 }, { path: 'test/alpha.test.js', add: 10, del: 0 }], stat: { files: 2, add: 19, del: 0 }, acc: { met: 2, total: 2 }, check: { ok: true, cmd: 'node --test' }, baseSha: 'aaaaaaa', headSha: 'bbbbbbb', flags: {}, summary: 'Added alpha.', ...extra });
  const review = (hub, agentId, ctx = {}, extra = {}) => {
    const task = hub.store.get('tasks', 'T2');
    return hub.run(agentId, { prompt: P.reviewPrompt(task, delivery(hub, extra), hub.card('T2'), { maker: '@m1', ...ctx }, hub.board.view(agentId, { aux: true, scope: 'T2' })), cwd: hub.bench('T2.rev', 'T2') });
  };

  test('review: PASS with a short note; a buddy check: PASS as the buddy', async (t) => {
    const hub = await createHub(t);
    await makerRun(hub, 'A3', 'T2');
    hub.store.patch('tasks', 'T2', { status: 'buddy', buddyId: 'A4', reviewerId: 'A1' });
    assertClean(await review(hub, 'A4', { buddy: true }));
    const [buddy] = hub.posts('PASS');
    assert.equal(buddy.buddy, true);
    assert.equal(lastDone(hub, 'T2').state, 'open');
    hub.store.patch('tasks', 'T2', { status: 'review' });
    assertClean(await review(hub, 'A1'));
    assert.equal(lastDone(hub, 'T2').state, 'passed');
  });

  test('[mock:reject]: the first review is FIX with numbered items and a pointer; the re-review passes', async (t) => {
    const hub = await createHub(t, { brief: flagged(['reject']) });
    const m = await makerRun(hub, 'A3', 'T2');
    hub.store.patch('tasks', 'T2', { status: 'review', reviewerId: 'A1' });
    assertClean(await review(hub, 'A1'));
    const [fix] = hub.posts('FIX');
    assert.match(fix.body, /^1\. .*test\/alpha\.test\.js:1\n2\. /);
    hub.store.patch('tasks', 'T2', { status: 'rework' });
    assertClean(await hub.run('A3', { prompt: P.continuePrompt(hub.store.get('tasks', 'T2'), hub.view('A3', m.session), 'The reviewer asked for changes.'), cwd: m.dir, session: m.session }));
    hub.store.patch('tasks', 'T2', { status: 'review' });
    assertClean(await review(hub, 'A1', { previous: { fixItems: ['Add a test for empty input'], lastReviewedSha: 'bbbbbbb' } }));
    assert.equal(hub.posts('PASS').length, 1);
    assert.equal(hub.posts('FIX').length, 1);
  });

  test('review FIX when the maker count is short (E_ACC) or the change is empty', async (t) => {
    const hub = await createHub(t);
    hub.board.post({ jobId: 'J1', agent: 'A3', line: 'DONE T2 tests=2/2 acc=1/2: Added src/alpha/index.js.' });
    hub.store.patch('tasks', 'T2', { status: 'review', reviewerId: 'A1' });
    assertClean(await review(hub, 'A1', {}, { acc: { met: 1, total: 2 } }));
    assert.match(hub.posts('FIX')[0].body, /acceptance item/);
  });

  test('consult: one ANS with pointers to the ASK @other', async (t) => {
    const hub = await createHub(t);
    const { dir } = await makerRun(hub, 'A3', 'T2');
    const ask = hub.board.post({ jobId: 'J1', agent: 'A3', line: 'ASK @other T2: Why does the alpha test fail on empty input?' });
    assert.ok(ask.ok, ask.hint);
    const task = hub.store.get('tasks', 'T2');
    assertClean(await hub.run('A5', { prompt: P.consultPrompt(task, hub.card('T2'), { id: ask.msg.id, from: '@m1', body: ask.msg.body }, ''), cwd: dir }));
    const [ans] = hub.posts('ANS');
    assert.equal(ans.re, ask.msg.id);
    assert.match(ans.body, /\.shop\/TASK\.md:1/);
  });

  test('QA: req_verify with an existing pointer for every requirement; [mock:reqfail] fails one once and adds a task', async (t) => {
    for (const flags of [[], ['reqfail']]) {
      const hub = await createHub(t, { brief: flagged(flags) });
      const head = hub.bench('_head', null);
      for (const [i, slug] of ['alpha', 'beta', 'gamma'].entries()) {
        fs.mkdirSync(path.join(head, 'src', slug), { recursive: true });
        fs.writeFileSync(path.join(head, 'src', slug, 'index.js'), `// Part ${slug} (T${i + 2}).\n// Serves: R${i + 1}.\nexport const part = '${slug}';\n`);
      }
      fs.writeFileSync(path.join(head, 'README.md'), '# Word counter\n');
      hub.qaDir = head;
      const job = hub.store.get('jobs', 'J1');
      for (let round = 0; round < 2; round++) {
        assertClean(await hub.run('A5', { prompt: P.qaPrompt(job, '', { checkCmd: 'node --test', check: { ok: true }, decisions: [] }), cwd: head }));
      }
      const [first, second] = hub.callsOf('req_verify').map((c) => c.args.results);
      assert.deepEqual(first.map((r) => r.id), job.requirements.map((r) => r.id));
      assert.match(first[0].evidence, /^src\/alpha\/index\.js:2 /);
      assert.ok(second.every((r) => r.ok));
      const adds = hub.callsOf('task_add');
      if (flags.length) {
        assert.equal(first.filter((r) => !r.ok).length, 1);
        assert.equal(adds.length, 1);
        assert.deepEqual(adds[0].args.reqs, [first.find((r) => !r.ok).id]);
      } else {
        assert.ok(first.every((r) => r.ok));
        assert.equal(adds.length, 0);
      }
    }
  });

  test('QA: [mock:reqorphan] fails one requirement once and adds no task, also not on the qa_task nudge for it', async (t) => {
    const hub = await createHub(t, { brief: flagged(['reqorphan']) });
    const head = hub.bench('_head', null);
    for (const [i, slug] of ['alpha', 'beta', 'gamma'].entries()) {
      fs.mkdirSync(path.join(head, 'src', slug), { recursive: true });
      fs.writeFileSync(path.join(head, 'src', slug, 'index.js'), `// Part ${slug} (T${i + 2}).\n// Serves: R${i + 1}.\nexport const part = '${slug}';\n`);
    }
    fs.writeFileSync(path.join(head, 'README.md'), '# Word counter\n');
    hub.qaDir = head;
    const job = hub.store.get('jobs', 'J1');
    const qa = () => P.qaPrompt(job, '', { checkCmd: 'node --test', check: { ok: true }, decisions: [] });
    assertClean(await hub.run('A5', { prompt: qa(), cwd: head, session: 'qa-1' }));
    const [first] = hub.callsOf('req_verify').map((c) => c.args.results);
    const lost = first.filter((r) => !r.ok).map((r) => r.id);
    assert.equal(lost.length, 1, 'one requirement failed');
    assert.equal(hub.callsOf('task_add').length, 0, 'no task in the QA turn');
    assertClean(await hub.run('A5', { prompt: P.nudge('qa_task', lost[0]), cwd: head, session: 'qa-1' }));
    assertClean(await hub.run('A1', { prompt: P.nudge('qa_task', lost[0]), cwd: hub.bench('_desk/@b1', null) }));
    assert.equal(hub.callsOf('task_add').length, 0, 'no task on the nudges for the orphan');
    const other = job.requirements.map((r) => r.id).find((id) => id !== lost[0]);
    assertClean(await hub.run('A1', { prompt: P.nudge('qa_task', other), cwd: hub.bench('_desk/@b1', null) }));
    assert.deepEqual(hub.callsOf('task_add').map((c) => c.args.reqs), [[other]], 'another requirement still gets its task');
    assertClean(await hub.run('A5', { prompt: qa(), cwd: head, session: 'qa-2' }));
    assert.ok(hub.callsOf('req_verify').at(-1).args.results.every((r) => r.ok), 'round 2 verifies everything');
  });

  test('self-test: calls selftest_ping and ends with OK', async (t) => {
    const hub = await createHub(t);
    const run = await hub.run('A9', { prompt: 'You are the WorkShop self-test. Do these steps in order.\n1. Call the tool "selftest_ping" of the "shop" server once, with no arguments.\nAt the end, reply with the single word OK.' });
    assertClean(run);
    assert.equal(hub.pings(), 1);
    assert.match(run.result.text, /\bOK\b/);
  });
});

// ------------------------------------------------------------------ process behavior

describe('mock agent: process behavior', () => {
  test('a fatal problem exits non-zero with an error line and leaves no process', async (t) => {
    const hub = await createHub(t);
    const port = Number(new URL(hub.url).port);
    const closed = { ...hub, url: `http://127.0.0.1:${port === 1 ? 2 : 1}` };
    const bad = await runAgent(closed, 'A1', { prompt: P.planPrompt(hub.store.get('jobs', 'J1'), '', LIM) });
    assert.equal(bad.code, 1);
    assert.equal(bad.alive, false);
    assert.equal(bad.events.find((e) => e.t === 'error').kind, 'mcp');
    assert.equal(bad.events.find((e) => e.t === 'init').mcpOk, false);
    const empty = await hub.run('A1', { prompt: '' });
    assert.equal(empty.code, 1);
    assert.match(empty.events.find((e) => e.t === 'error').message, /no prompt/);
  });

  test('MOCK_SPEED scales the delays, and [mock:slow] makes long turns', async (t) => {
    const hub = await createHub(t);
    const job = hub.store.get('jobs', 'J1');
    const fast = await hub.run('A1', { prompt: P.planPrompt(job, '', LIM), cwd: hub.bench('_desk/@b1', null), speed: 0 });
    const paced = await hub.run('A1', { prompt: P.planPrompt(job, '', LIM), cwd: hub.bench('_desk/@b1', null), speed: 0.1 });
    const slowRun = await hub.run('A1', { prompt: P.planPrompt({ ...job, brief: `${BRIEF} [mock:slow]` }, '', LIM), cwd: hub.bench('_desk/@b1', null), speed: 0.1 });
    for (const r of [fast, paced, slowRun]) assertClean(r);
    // Floors from the script's own sleeps (turn start 1200 ms, each tool call 300 ms, x speed, x8 when slow), not
    // differences between two wall times: a busy machine (a parallel suite) can make the speed-0 run slow too.
    assert.ok(paced.ms >= 120 + 30, `paced ${paced.ms} ms`);
    assert.ok(slowRun.ms >= (120 + 30) * 8, `slow ${slowRun.ms} ms`);
    assert.ok(slowRun.ms > fast.ms, `${slowRun.ms} vs ${fast.ms}`);
  });
});
