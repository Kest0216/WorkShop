// Harness of the board-and-review scenario tests (tests/scenarios/board-and-review.test.mjs).
// It boots the REAL hub (createApp on temp folders, the mock lab only, the file secrets backend) and adds:
//   - a turn script: a rule can replace one agent turn with a scripted fake turn that calls the real hub tools
//     through mcp.handle with a token minted for that agent (no process). Turns that no rule takes run the real
//     mock agent (server/providers/mock-agent.mjs).
//   - a shop clock (createApp `now`): tests move shop time forward to reach deadlines or to simulate a sleep.
//   - a hook on the orchestrator factory (createApp `createOrchestrator`), for a fault that needs one patch.
// Nothing is written under the WorkShop data/, projects/ or config/ folders. No real AI CLI runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/index.js';
import { createOrchestrator } from '../../server/orchestrator.js';
import { apiClient, followEvents, git, hubEnv, leftovers, ownerSession, tempShop, writeSettings } from '../e2e-harness.mjs';

export { git, leftovers };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A plan with one task per name: disjoint zones src/<n>/** and test/<n>.test.mjs, one requirement each. */
export function partsPlan(names = ['alpha', 'beta'], { check = 'node --test', size = 'S', deps = {}, zones = {}, acceptance = {} } = {}) {
  return {
    requirements: names.map((n) => ({ text: `The ${n} part counts the ${n} items it gets.` })),
    tasks: names.map((n, i) => ({
      key: n, title: `Part ${n}: count the items`, spec: `Create src/${n}/index.mjs with run(input) and test/${n}.test.mjs.`,
      acceptance: acceptance[n] ?? [`src/${n}/index.mjs exports run(input).`, `test/${n}.test.mjs passes with node --test.`],
      zones: zones[n] ?? [`src/${n}/**`, `test/${n}.test.mjs`], domain: 'backend', size, deps: deps[n] ?? [], reqs: [i + 1], stream: 'parts',
    })),
    ...(check ? { check_cmd: check } : { no_check_reason: 'The scenario has no check.' }),
    assumptions: ['Node 20 with ES modules.'], notes: 'Each part lives in src/<part>/index.mjs and exports run(input).',
  };
}

/** The files of one part (what a competent maker writes), with two passing tests. */
export function partFiles(n, { extraTest = '' } = {}) {
  return {
    [`src/${n}/index.mjs`]: `export const part = '${n}';\nexport function run(input) {\n  const items = input === undefined || input === null ? [] : Array.isArray(input) ? input : [input];\n  return { part, count: items.length, items: items.map((x) => String(x).trim()) };\n}\n`,
    [`test/${n}.test.mjs`]: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { run } from '../src/${n}/index.mjs';\ntest('${n} counts the items', () => { assert.equal(run(['a', 'b']).count, 2); });\ntest('${n} wraps one value', () => { assert.deepEqual(run(' x ').items, ['x']); });\n${extraTest}`,
  };
}

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (content === null) { fs.rmSync(file, { force: true, recursive: true }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

export const doneLine = (taskId, { acc = '2/2', tests = '2/2', body = 'Added the part module and its test. Both tests pass.' } = {}) => `DONE ${taskId} tests=${tests} acc=${acc}: ${body}`;

/** A plan turn script: submits `plan` as a draft, or with covers for every draft in a merge turn. */
export function planScript(plan) {
  return async ({ call, o }) => {
    const drafts = [...o.prompt.matchAll(/^DRAFT BY (@\S+):\n(.*)$/gm)].map((m) => ({ handle: m[1], n: JSON.parse(m[2]).requirements.length }));
    const args = drafts.length ? { ...plan, covers: drafts.flatMap((d) => Array.from({ length: d.n }, (_, i) => ({ draft: d.handle, n: i + 1, req: Math.min(i + 1, plan.requirements.length) }))) } : plan;
    const r = await call('plan_submit', args);
    assert.equal(r.isError, false, `plan_submit: ${r.text}`);
  };
}

/** Does this turn record start a plan (draft or merge) turn? */
export const isPlanTurn = (rec) => rec.kind === 'plan' && /^(PLAN work order|MERGE THE PLANS)/m.test(rec.prompt);

/**
 * Boot the real hub. opts: { settings, wrapOrch(orch, ctx), tickMs }.
 * The shop: { app, api, turns, sse, logs, clock, script(), job(), task(), tasks(), deliveries(), msgs(), waitFor(), close() }.
 */
export async function boot(opts = {}) {
  const dirs = tempShop('ws-scen-');
  writeSettings(dirs, opts.settings ?? {});
  const logs = [];
  const log = (level, msg, data) => { logs.push({ level, msg, data, at: Date.now() }); };
  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const factory = async (deps) => {
    const orch = createOrchestrator(deps);
    if (typeof opts.wrapOrch === 'function') opts.wrapOrch(orch, orch._ctx);
    return orch;
  };
  const app = await createApp({
    ...dirs, port: 0, secretsBackend: 'file', labs: ['mock'], env: hubEnv(dirs), log, stderr: null, tickMs: opts.tickMs ?? 150, now,
    runnerTuning: { minSpawnGapMs: 50 }, orchTuning: { managerDebounceMs: 300, managerMaxDelayMs: 1500 },
    power: { hold() {}, release() {} }, pickFolder: async () => null, reveal: async () => {}, createOrchestrator: factory,
  });
  const shop = { app, dirs, logs, clock, now, turns: [], sse: [], rules: [], fakes: new Map(), url: app.url };

  // ---- the turn script
  shop.script = (name, match, run, { times = Infinity } = {}) => {
    const rule = { name, match, run, left: times, hits: 0 };
    shop.rules.push(rule);
    return rule;
  };
  shop.unscript = (name) => { shop.rules = shop.rules.filter((r) => r.name !== name); };
  /** The next matched turns run the scripts in `list`, one each, in order. */
  shop.steps = (name, match, list) => {
    let i = 0;
    return shop.script(name, match, (c) => list[i++](c), { times: list.length });
  };
  /** Matches a work turn of the task whose title starts with "Part <part>:" (and whose prompt matches re). */
  shop.work = (part, re = null) => (r) => r.kind === 'work' && Boolean(shop.task(r.taskId)?.title?.startsWith(`Part ${part}:`)) && (!re || re.test(r.prompt));
  shop.review = (part) => (r) => r.kind === 'review' && Boolean(shop.task(r.taskId)?.title?.startsWith(`Part ${part}:`));
  shop.taskOf = (jobId, part) => shop.tasks(jobId).find((x) => x.title.startsWith(`Part ${part}:`));

  async function fakeTurn(rule, agentId, o, rec) {
    const ac = new AbortController();
    shop.fakes.set(agentId, ac);
    const token = app.mcp.tokenFor(agentId);
    const calls = [];
    const call = async (name, args = {}) => {
      const r = await app.mcp.handle(token, { jsonrpc: '2.0', id: calls.length + 1, method: 'tools/call', params: { name, arguments: args } });
      const text = (r?.result?.content ?? []).map((c) => c.text ?? '').join('\n') || r?.error?.message || '';
      const out = { text: text.replace(/\n?\[board: \d+ new for you\. Call read\.\]\s*$/, '').trim(), isError: r?.result?.isError === true || Boolean(r?.error) };
      calls.push({ name, args, ...out });
      return out;
    };
    const until = async (fn, { timeoutMs = 60_000, what = 'a condition' } = {}) => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        if (ac.signal.aborted) throw Object.assign(new Error('the turn was stopped'), { aborted: true });
        let v;
        try { v = fn(); } catch { v = null; }
        if (v) return v;
        if (Date.now() > end) throw new Error(`fake turn ${rule.name}: timed out waiting for ${what}`);
        await sleep(25);
      }
    };
    const t0 = Date.now();
    const sessionId = o.resume && o.sessionId ? o.sessionId : o.sessionId || randomUUID();
    let extra = {};
    let killed = null;
    try {
      extra = (await rule.run({ call, post: (line) => call('post', { line }), o, rec, agent: app.store.get('agents', agentId), cwd: o.cwd, until, signal: ac.signal, shop })) ?? {};
    } catch (err) {
      if (err.aborted) killed = 'cancel';
      else { rec.scriptError = err; shop.scriptErrors.push(`${rule.name}: ${err.stack ?? err.message}`); }
    } finally {
      app.mcp.revoke(agentId);
      shop.fakes.delete(agentId);
    }
    rec.fakeCalls = calls;
    return {
      ok: killed === null, text: '', sessionId, usd: 0, usage: { inTok: 100, outTok: 20, cacheRead: 0, cacheWrite: 0, ctxTok: 1000 },
      calls: calls.map((c) => c.name), denied: [], error: null, killed, durationMs: Date.now() - t0, startedAt: t0, ...extra,
    };
  }
  shop.scriptErrors = [];

  const run = app.runner.run;
  app.runner.run = async (agentId, o) => {
    const a = app.store.get('agents', agentId);
    const rec = {
      agentId, handle: a?.handle ?? null, role: a?.role ?? null, kind: o.kind, cwd: o.cwd, access: o.access, resume: o.resume === true,
      sessionId: o.sessionId ?? null, taskId: o.taskId ?? null, prompt: String(o.prompt ?? ''), jobId: a?.jobId ?? null, startedAt: Date.now(),
    };
    shop.turns.push(rec);
    const rule = shop.rules.find((r) => r.left > 0 && r.match(rec));
    let res;
    if (rule) {
      rule.left -= 1;
      rule.hits += 1;
      rec.fake = rule.name;
      res = await fakeTurn(rule, agentId, o, rec);
    } else res = await run.call(app.runner, agentId, o);
    Object.assign(rec, { ok: res.ok, killed: res.killed, error: res.error, calls: res.calls, resultSession: res.sessionId, endedAt: Date.now() });
    return res;
  };
  for (const name of ['cancel', 'interrupt']) {
    const orig = app.runner[name];
    app.runner[name] = (agentId, ...rest) => {
      shop.fakes.get(agentId)?.abort();
      return orig.call(app.runner, agentId, ...rest);
    };
  }

  shop.cookie = await ownerSession(app.url, app.ownerKey);
  shop.api = apiClient(app.url, shop.cookie);
  const state = await shop.api('GET', '/api/state');
  assert.equal(state.status, 200);
  shop.stopEvents = await followEvents(app.url, shop.cookie, state.body.seq, (e) => shop.sse.push(e));

  shop.job = (id) => app.store.get('jobs', id);
  shop.task = (id) => app.store.get('tasks', id);
  shop.tasks = (jobId) => app.store.list('tasks', (t) => t.jobId === jobId).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  shop.deliveries = (jobId, taskId) => app.store.list('deliveries', (d) => d.jobId === jobId && (!taskId || d.taskId === taskId)).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  shop.agents = (jobId) => app.store.list('agents', (a) => a.jobId === jobId);
  shop.agent = (id) => app.store.get('agents', id);
  shop.byHandle = (jobId, handle) => shop.agents(jobId).find((a) => a.handle === handle);
  shop.msgs = (jobId) => app.board.history({ jobId, limit: 500 });
  shop.msg = (jobId, id) => shop.msgs(jobId).find((m) => m.id === id);
  shop.project = (jobId) => app.store.get('projects', shop.job(jobId)?.projectId);
  shop.errors = () => logs.filter((l) => l.level === 'error');
  shop.notices = () => shop.sse.filter((e) => e.type === 'notice');
  shop.seen = (kind, fn = () => true) => shop.sse.filter((e) => e.type === 'upsert' && e.kind === kind && fn(e.item)).map((e) => e.item);
  shop.ctx = app.orch._ctx;

  shop.waitFor = async (fn, { timeoutMs = 90_000, what = 'a condition', jobId = null, every = 50 } = {}) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (shop.scriptErrors.length) assert.fail(`a fake turn failed while waiting for ${what}:\n${shop.scriptErrors.join('\n')}`);
      if (Date.now() > end) {
        const ids = jobId ? [jobId] : app.store.list('jobs').map((j) => j.id);
        const table = ids.map((id) => app.orch.status(id)).join('\n');
        const j = jobId ? shop.job(jobId) : null;
        assert.fail(`timed out waiting for ${what}\n${table}\n${j ? `job: ${j.status} ${j.pauseReason ?? ''} ${j.error ?? ''}` : ''}\nerrors: ${JSON.stringify(shop.errors()).slice(0, 1500)}`);
      }
      await sleep(every);
    }
  };

  let closed = false;
  shop.close = async () => {
    if (closed) return;
    closed = true;
    for (const ac of shop.fakes.values()) ac.abort();
    await shop.stopEvents().catch(() => {});
    await app.close();
  };
  return shop;
}

/** Start a job through POST /api/jobs. crew: preset name or counts. */
export async function startJob(shop, { brief = 'Build a small item counter. Each part counts items.', title = 'Counter', crew = 'solo', project = { mode: 'new', name: 'counter' }, options = { mock: true } } = {}) {
  const r = await shop.api('POST', '/api/jobs', { title, brief, kind: 'build', project, crew, options });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
}

/** Wait for delivering with a report, ship the shown headSha, wait for done. */
export async function shipAndFinish(shop, jobId, { timeoutMs = Number(process.env.SCEN_TIMEOUT) || 120_000 } = {}) {
  await shop.waitFor(() => { const j = shop.job(jobId); return j.status === 'delivering' && j.report; }, { timeoutMs, what: `${jobId} delivering with a report`, jobId });
  const truck = await shop.api('GET', `/api/jobs/${jobId}/truck`);
  assert.equal(truck.status, 200);
  const ship = await shop.api('POST', `/api/jobs/${jobId}/ship`, { sha: truck.body.headSha });
  assert.equal(ship.body.ok, true, JSON.stringify(ship.body));
  await shop.waitFor(() => shop.job(jobId).status === 'done', { timeoutMs: 30_000, what: `${jobId} done`, jobId });
  assert.equal(await shop.app.orch.settle({ timeoutMs: 30_000 }), true, 'the hub steps after done ended');
  return { truck: truck.body, ship: ship.body };
}

/** t.after: close the shop, check that no process is left, remove the temp folders. */
export function guard(t, shop, { allowErrors = false } = {}) {
  t.after(async () => {
    await shop.close().catch(() => {});
    const left = await leftovers(shop.dirs.tmp);
    if (process.env.KEEP_E2E !== '1') fs.rmSync(shop.dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
    assert.deepEqual(left, [], 'no process is left');
    if (!allowErrors) assert.deepEqual(shop.errors().map((e) => `${e.msg} ${JSON.stringify(e.data)}`), [], 'the hub logged no error');
  });
}

/** Every file path in any commit reachable from `ref` in the repo (to prove refused content never landed). */
export function pathsInHistory(repo, ref) {
  return new Set(git(repo, 'log', '--format=', '--name-only', ref).split('\n').filter(Boolean));
}
