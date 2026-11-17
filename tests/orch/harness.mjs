// Test harness for the orchestrator: real store, board, mcp and gitops in a temp dir; a FAKE runner that plays
// each agent turn by calling the registered hub tools through mcp.handle (no processes); fake providers and a
// fake two-lab router; a manual clock. Nothing here touches the real data, projects or config folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStore } from '../../server/store.js';
import { createBoard } from '../../server/board.js';
import { createMcp } from '../../server/mcp.js';
import { createGit } from '../../server/gitops.js';
import { createRedactor } from '../../server/redact.js';
import { createOrchestrator } from '../../server/orchestrator.js';

const ROOT_PREFIX = path.join(os.tmpdir(), 'ws-orch-');

// Every temp root this process made. h.close removes its root; a test that times out or throws before that
// leaves it, so the exit of the test process removes whatever is left.
const ROOTS = new Set();
const removeRoot = (root) => {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  ROOTS.delete(root);
};
process.once('exit', () => { for (const root of [...ROOTS]) removeRoot(root); });

export function gitEnv(home) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...base, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

export function ownerGit(cwd, env, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Owner', '-c', 'user.email=owner@example.com', ...args], { cwd, env, encoding: 'utf8' }).trim();
}

/** Two fake labs: models per role. */
const MODELS = [
  { id: 'claude-boss', provider: 'claude', role: 'boss' }, { id: 'gemini-boss', provider: 'gemini', role: 'boss' },
  { id: 'claude-mgr', provider: 'claude', role: 'manager' }, { id: 'gemini-mgr', provider: 'gemini', role: 'manager' },
  { id: 'claude-maker', provider: 'claude', role: 'maker' }, { id: 'gemini-maker', provider: 'gemini', role: 'maker' },
];

export function createFakeProviders() {
  const cooled = new Set();
  const cooledModels = new Set();
  const listeners = new Set();
  const P = {
    cooled, cooledModels,
    usable: (id) => !cooled.has(id),
    modelUsable: (id, model) => !cooled.has(id) && !(model && cooledModels.has(model)),
    ready: (id) => ({ ok: !cooled.has(id), reason: null }),
    status: (id) => ({ id, label: id, usable: !cooled.has(id), auth: 'ok', reason: cooled.has(id) ? 'cooling' : null, cooling: cooled.has(id) ? { until: null, reason: 'test' } : null }),
    list: () => ['claude', 'gemini', 'mock'].map((id) => P.status(id)),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    cool(id) { cooled.add(id); for (const fn of listeners) fn(); },
    release(id) { cooled.delete(id); for (const fn of listeners) fn(); },
  };
  return P;
}

export function createFakeRouter(providers, { only = null } = {}) {
  return {
    registry: () => ({ models: MODELS }),
    pick(q) {
      let c = MODELS.filter((m) => m.role === q.role && providers.modelUsable(m.provider, m.id) && !(q.exclude ?? []).includes(m.id));
      if (only) c = c.filter((m) => only.includes(m.provider));
      if (q.avoidProvider && c.some((m) => m.provider !== q.avoidProvider)) c = c.filter((m) => m.provider !== q.avoidProvider);
      if (!c.length) return null;
      const load = q.labLoad ?? {};
      c.sort((a, b) => (load[a.provider] ?? 0) - (load[b.provider] ?? 0) || a.provider.localeCompare(b.provider));
      return { provider: c[0].provider, model: c[0].id, label: c[0].id, effort: 'medium', why: 'fake' };
    },
  };
}

/**
 * A runner that plays turns with a script: brain(turn) -> result fields. turn: { agent, opts, kind, call(tool,args),
 * post(line), read(scope), prompt, cwd }. Cancel and interrupt end the turn at once.
 */
export function createFakeRunner({ mcp, store, brain }) {
  const active = new Map();
  let n = 0;
  let rpc = 0;
  const log = [];
  const R = {
    log,
    brain,
    run(agentId, opts = {}) {
      const agent = store.get('agents', agentId);
      if (!agent) return Promise.resolve({ ok: false, error: { kind: 'other', message: 'unknown agent' }, usage: { ctxTok: 0 }, calls: [] });
      if (active.has(agentId)) return Promise.resolve({ ok: false, error: { kind: 'other', message: 'busy' }, usage: { ctxTok: 0 }, calls: [] });
      const token = mcp.tokenFor(agentId);
      const sessionId = opts.resume && opts.sessionId ? opts.sessionId : `S${++n}`;
      const calls = [];
      const call = async (name, args = {}) => {
        const res = await mcp.handle(token, { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } });
        calls.push(name);
        if (res?.error) return `RPCERR ${res.error.message}`;
        return res?.result?.content?.[0]?.text ?? '';
      };
      let stop;
      const stopped = new Promise((resolve) => { stop = resolve; });
      const turn = {
        agentId, agent, opts, kind: opts.kind, prompt: opts.prompt ?? '', cwd: opts.cwd, call, sessionId, stopped: null,
        post: (line) => call('post', { line }), read: (scope) => call('read', scope ? { scope } : {}),
        stop: (killed) => stop({ killed }),
      };
      active.set(agentId, turn);
      log.push({ agentId, handle: agent.handle, role: agent.role, kind: opts.kind, resume: Boolean(opts.resume), sessionId, access: opts.access, cwd: opts.cwd, prompt: opts.prompt });
      const play = (async () => {
        try { return (await R.brain(turn)) ?? {}; } catch (err) { return { ok: false, error: { kind: 'other', message: String(err?.message ?? err) } }; }
      })();
      return Promise.race([play, stopped]).then((out) => {
        active.delete(agentId);
        mcp.revoke(agentId);
        const killed = out.killed ?? null;
        return {
          ok: out.ok ?? (!out.error && !killed), text: out.text ?? '', sessionId: out.sessionId === undefined ? sessionId : out.sessionId, usd: 0,
          usage: { inTok: 10, outTok: 10, cacheRead: 0, cacheWrite: 0, ctxTok: out.ctxTok ?? 1000 }, calls, denied: [],
          error: out.error ?? (killed ? { kind: 'other', message: killed } : null), killed, durationMs: 1, startedAt: Date.now(), started: out.started ?? true,
        };
      });
    },
    cancel(agentId) { const t = active.get(agentId); if (!t) return false; t.stop('cancel'); return true; },
    interrupt(agentId) { const t = active.get(agentId); if (!t) return false; t.stop('interrupt'); return true; },
    busy: (id) => active.has(id),
    active: () => [...active.keys()],
    queued: () => [],
    shutdown: async () => { for (const t of active.values()) t.stop('shutdown'); },
  };
  return R;
}

export function makeClock(start = Date.UTC(2026, 10, 15, 9, 0, 0)) {
  const c = { t: start, now: () => c.t, set(v) { c.t = v; } };
  return c;
}

const write = (dir, rel, text) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** A plan for tests: n tasks in their own zones mod<i>/**; the last one depends on the others when chain is true. */
export function samplePlan({ n = 3, chain = false, check = 'test ! -e BROKEN', reqs = null, extra = {} } = {}) {
  const requirements = reqs ?? Array.from({ length: n }, (_, i) => ({ text: `Module ${i + 1} works.` }));
  const tasks = Array.from({ length: n }, (_, i) => ({
    key: `k${i + 1}`, title: `Module ${i + 1}`, spec: `Write mod${i + 1}/index.js.`, acceptance: [`mod${i + 1}/index.js exists.`, 'The check passes.'],
    zones: [`mod${i + 1}/**`], domain: 'backend', size: 'S', deps: chain && i === n - 1 ? requirements.slice(0, n - 1).map((_, j) => `k${j + 1}`) : [],
    reqs: [Math.min(i + 1, requirements.length)], stream: 'core',
  }));
  for (let r = n + 1; r <= requirements.length; r++) tasks[tasks.length - 1].reqs.push(r);
  return { requirements, tasks, check_cmd: check, assumptions: ['The owner wants plain modules.'], notes: 'Keep it small.', ...extra };
}

/** The first file with an extension under dir (no dot folders), as a relative path. */
export function anyFile(dir, rel = '') {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return null; }
  for (const e of names) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isFile() && /\.[a-z]+$/i.test(e.name)) return r;
    if (e.isDirectory()) { const f = anyFile(dir, r); if (f) return f; }
  }
  return null;
}

const doneId = (prompt) => Number(/Their DONE is message (\d+)/.exec(prompt)?.[1] ?? /re:(\d+)/.exec(prompt)?.[1]);

/**
 * The standard brain: plans with planFor(job), makers write mod<i>/index.js in their zone and post DONE,
 * reviewers and buddies PASS, QA verifies everything, the lead writes a report, answer turns answer open items.
 * hooks[kind](turn, ctx) may take over a turn; return undefined to fall through.
 */
export function standardBrain(h, hooks = {}) {
  return async (turn) => {
    const own = hooks[turn.kind] ?? hooks[turn.agent.role];
    if (own) {
      const out = await own(turn, h);
      if (out !== undefined) return out;
    }
    const { store } = h;
    const agent = store.get('agents', turn.agentId);
    const job = store.get('jobs', agent.jobId);
    switch (turn.kind) {
      case 'plan': {
        const plan = h.planFor(job, turn);
        if (/MERGE THE PLANS/.test(turn.prompt)) {
          const drafts = Object.entries(job.planDrafts ?? {}).filter(([k]) => k !== 'final');
          const covers = [];
          for (const [bossId, draft] of drafts) draft.requirements.forEach((_, i) => covers.push({ draft: store.get('agents', bossId).handle, n: i + 1, req: Math.min(i + 1, plan.requirements.length) }));
          turn.planResult = await turn.call('plan_submit', { ...plan, covers });
        } else turn.planResult = await turn.call('plan_submit', plan);
        return {};
      }
      case 'work': {
        const task = store.get('tasks', agent.taskId);
        if (!task) return {};
        if (turn.opts.access === 'read') return answerOpen(turn, h);
        const zone = task.zones[0].replace(/\/\*\*$/, '').replace(/\*\*$/, 'x');
        write(turn.cwd, `${zone}/index.js`, `export const id = '${task.id}-${Date.now()}';\n`);
        await answerOpen(turn, h);
        turn.doneResult = await turn.post(`DONE ${task.id} tests=1/1 acc=${task.acceptance.length}/${task.acceptance.length}: I wrote ${zone}/index.js for ${task.id}.`);
        return {};
      }
      case 'buddy':
      case 'review':
        turn.verdict = await turn.post(`PASS re:${doneId(turn.prompt)}: The work meets every acceptance item.`);
        return {};
      case 'qa': {
        const open = job.requirements.filter((r) => r.status === 'open');
        const file = anyFile(turn.cwd) ?? 'README.md';
        turn.verifyResult = await turn.call('req_verify', { results: open.map((r) => ({ id: r.id, ok: true, evidence: `It is in ${file}.` })) });
        return {};
      }
      case 'report':
        turn.reportResult = await turn.call('job_report', { md: `# Report for ${job.id}\nEverything is done.` });
        return {};
      case 'consult': {
        const id = /QUESTION \(message (\d+)\)/.exec(turn.prompt)?.[1];
        if (id) turn.ansResult = await turn.post(`ANS re:${id}: Delete the file BROKEN and run the check again.`);
        return {};
      }
      case 'change': {
        const reqId = /requirement (R\d+)/.exec(turn.prompt)?.[1] ?? /Requirement (R\d+) has no task/.exec(turn.prompt)?.[1];
        if (reqId) {
          const k = store.list('tasks', (t) => t.jobId === job.id).length + 1;
          turn.addResult = await turn.call('task_add', { title: `Change ${reqId}`, spec: `Do ${reqId}.`, acceptance: ['It works.'], zones: [`chg${k}/**`], domain: 'backend', size: 'S', reqs: [reqId] });
        }
        return answerOpen(turn, h);
      }
      default:
        return answerOpen(turn, h);
    }
  };
}

/** Answer every open item addressed to the agent (turn gate). */
export async function answerOpen(turn, h) {
  for (const m of h.board.openFor(turn.agentId)) {
    if (m.kind === 'REQ') await turn.post(`OK re:${m.id}`);
    else await turn.post(`ANS re:${m.id}: Use the default value. See mod1/index.js.`);
  }
  return {};
}

/**
 * One shop: temp dirs, real store / board / mcp / git, fake runner, providers and router, a manual clock.
 * opts: settings (merged over safety trusting), brainHooks, planFor(job, turn), tuning, routerOnly
 */
export async function makeShop(opts = {}) {
  const root = opts.root ?? fs.realpathSync(fs.mkdtempSync(ROOT_PREFIX));
  ROOTS.add(root);
  const dirs = {
    data: path.join(root, 'data'), work: path.join(root, 'data', 'work'), run: path.join(root, 'data', 'run'), logs: path.join(root, 'data', 'logs'),
    config: path.join(root, 'config'), projects: path.join(root, 'projects'), home: path.join(root, 'home'), server: path.join(root, 'server'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const env = gitEnv(dirs.home);
  const clock = opts.clock ?? makeClock();
  const settings = { safety: 'trusting', presence: 'here', ...(opts.settings ?? {}) };
  if (opts.limits) settings.limits = opts.limits;
  const getSettings = () => settings;
  const h = { root, dirs, env, clock, settings, errors: [] };
  const log = (level, msg, data) => { if (level === 'error') h.errors.push(`${msg} ${JSON.stringify(data ?? {})}`); };
  h.store = opts.store ?? createStore({ dataDir: dirs.data, saveDelayMs: 5 });
  h.redactor = createRedactor();
  h.resolve = {};
  h.board = createBoard({ store: h.store, dataDir: dirs.data, getSettings, resolve: h.resolve, redactor: h.redactor, now: clock.now });
  h.mcp = createMcp({ store: h.store, redactor: h.redactor });
  h.board.registerTools(h.mcp);
  h.git = createGit({ paths: { projects: dirs.projects, work: dirs.work, run: dirs.run, logs: dirs.logs, config: dirs.config }, env, getSettings, redactor: h.redactor });
  h.providers = opts.providers ?? createFakeProviders();
  h.router = createFakeRouter(h.providers, { only: opts.routerOnly ?? null });
  h.planFor = opts.planFor ?? (() => samplePlan());
  h.runner = createFakeRunner({ mcp: h.mcp, store: h.store, brain: null });
  h.runner.brain = standardBrain(h, opts.brainHooks ?? {});
  h.orch = createOrchestrator({
    store: h.store, board: h.board, mcp: h.mcp, runner: h.runner, router: h.router, git: h.git, providers: h.providers, decider: opts.decider ?? null,
    getSettings, updateSettings: (patch) => Object.assign(settings, patch), paths: { ...dirs, data: dirs.data }, now: clock.now,
    tuning: { tickMs: 0, managerDebounceMs: 0, ...(opts.tuning ?? {}) }, resolverTarget: h.resolve, log,
  });
  /**
   * Wait until no turn, hub step or tick is in flight. It waits for that state, not for a fixed time: the long cap
   * only stops a hub that never settles, and then the test fails here (not later on a half-done state).
   */
  h.settle = async ({ timeoutMs = 240000 } = {}) => {
    if (await h.orch.settle({ timeoutMs })) return true;
    throw new Error(`h.settle: the hub did not settle in ${timeoutMs / 1000} s (turns: ${[...h.orch._ctx.rt.turns.keys()].join(', ') || 'none'}; steps: ${[...h.orch._ctx.rt.steps.keys()].join(', ') || 'none'})`);
  };
  /** Advance shop time in steps under the board's tick gap, ticking the board each step. */
  h.advance = async (ms) => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 30000);
      clock.t += step;
      left -= step;
      h.board.tick(clock.t);
    }
    await h.orch.tick();
    await h.settle();
  };
  /**
   * Wait (real time) until fn() is true, ticking the orchestrator. For turns that the test holds open. The cap is
   * long: a loaded machine runs the job slowly, and the test waits for the state, not for a time.
   */
  h.until = async (fn, ms = 240000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await h.orch.tick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('h.until: timed out');
  };
  h.job = (id = 'J1') => h.store.get('jobs', id);
  h.tasks = (jobId = 'J1') => h.store.list('tasks', (t) => t.jobId === jobId).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  h.agents = (jobId = 'J1') => h.store.list('agents', (a) => a.jobId === jobId);
  h.deliveries = (jobId = 'J1') => h.store.list('deliveries', (d) => d.jobId === jobId);
  h.turns = (kind) => h.runner.log.filter((t) => !kind || t.kind === kind);
  h.msgs = (jobId = 'J1') => h.board.history({ jobId, limit: 500 });
  h.notices = [];
  h.store.subscribe((e) => { if (e.type === 'notice') h.notices.push(e); });
  h.start = async (input = {}) => {
    const job = h.orch.createJob({ title: 'Test job', brief: 'Build three small modules.', kind: 'build', project: { mode: 'new', name: 'demo' }, crew: { bosses: 1, managers: 1, makers: 3 }, ...input });
    await h.orch.recover();
    await h.settle();
    return job;
  };
  /** Simulate a hub crash: nothing more runs or writes in this instance; the dirs stay for the next one. */
  h.crash = async () => {
    h.orch._ctx.rt.stopped = true;
    h.orch._ctx.scheduler.stop();
    // A real crash kills git too. Here the hub steps run to their end, so no two instances touch one folder.
    await Promise.allSettled([...h.orch._ctx.rt.steps.values()].map((s) => s.promise));
    await h.store.flush();
    h.board.shutdown();
    h.git.shutdown();
  };
  h.close = async () => {
    try {
      await h.orch.shutdown();
      await h.runner.shutdown();
      h.git.shutdown();
      h.board.shutdown();
      await h.store.flush();
    } finally {
      removeRoot(root);
    }
    if (h.errors.length && !opts.allowErrors) throw new Error(`orchestrator logged errors:\n${h.errors.join('\n')}`);
  };
  h.write = write;
  return h;
}
