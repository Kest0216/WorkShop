// Harness of the owner-and-ledger scenarios (tests/scenarios/owner-and-ledger.test.mjs): the real hub (createApp) on
// temp folders, the mock lab only, the file secrets backend, the owner session over HTTP and the SSE stream.
// Like tests/e2e-harness.mjs bootShop, plus: extra createApp options (fault injection: adapters), and hooks that run
// right before an agent turn reaches the runner (onTurn), so a scenario can act at an exact moment of the job.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../../server/index.js';
import { createClaudeAdapter } from '../../server/providers/claude.js';
import { createGeminiAdapter } from '../../server/providers/gemini.js';
import { createMockAdapter } from '../../server/providers/mock.js';
import { createShellEnv } from '../../server/shellenv.js';
import { apiClient, followEvents, hubEnv, ownerSession, tempShop, writeSettings, leftovers, sleep } from '../e2e-harness.mjs';

export { sleep };

/**
 * Adapters with the real CLIs switched off and a mock lab whose turns each cost `usdPerTurn` (the CLI's own figure:
 * the registry has no price for the mock model). Only for the budget scenario (settings.auth.mock = 'apikey').
 */
export function billingAdapters(dirs, usdPerTurn) {
  const shellEnv = createShellEnv({ env: hubEnv(dirs) });
  const mock = createMockAdapter({ shellEnv });
  return {
    claude: { ...createClaudeAdapter({ shellEnv }), locate: () => null },
    gemini: { ...createGeminiAdapter({ shellEnv }), locate: () => null },
    mock: {
      ...mock,
      createParser: () => {
        const p = mock.createParser();
        const price = (events) => events.map((e) => (e.t === 'result' ? { ...e, usd: usdPerTurn } : e));
        return { push: (line) => price(p.push(line)), end: (info) => price(p.end(info)) };
      },
    },
  };
}

/**
 * Adapters with the real CLIs switched off and a mock lab that gets a plain wake prompt in place of every prompt
 * for which blank({ prompt, agent }) is true: the agent then does nothing that turn (a no-show, a lead that makes
 * no task). Fault injection for the owner-verdict and the owner-notice scenarios.
 */
export function blankingAdapters(dirs, blank) {
  const shellEnv = createShellEnv({ env: hubEnv(dirs) });
  const mock = createMockAdapter({ shellEnv });
  return {
    claude: { ...createClaudeAdapter({ shellEnv }), locate: () => null },
    gemini: { ...createGeminiAdapter({ shellEnv }), locate: () => null },
    mock: {
      ...mock,
      buildRun: (args) => {
        const spec = mock.buildRun(args);
        return blank({ prompt: String(args.prompt ?? ''), agent: args.agent }) ? { ...spec, stdin: 'Answer the open items addressed to you.\n' } : spec;
      },
    },
  };
}

/**
 * Boot the real hub. opts: { dirs?, settings?, app?: extra createApp options (or a function of dirs) }.
 * shop.hooks: functions (rec) => void|Promise run before each agent turn starts in the runner.
 */
export async function boot(opts = {}) {
  const dirs = opts.dirs ?? tempShop('ws-own-');
  writeSettings(dirs, opts.settings ?? {});
  const logs = [];
  const log = (level, msg, data) => { logs.push({ level, msg, data, at: Date.now() }); };
  const extra = typeof opts.app === 'function' ? opts.app(dirs) : (opts.app ?? {});
  const app = await createApp({
    ...dirs, port: 0, secretsBackend: 'file', labs: ['mock'], env: hubEnv(dirs), log, stderr: null, tickMs: 150,
    runnerTuning: { minSpawnGapMs: 50 },
    orchTuning: { managerDebounceMs: 300, managerMaxDelayMs: 1500 },
    power: { hold() {}, release() {} }, pickFolder: async () => null, reveal: async () => {},
    ...extra,
  });
  const shop = { app, dirs, logs, turns: [], sse: [], hooks: [], url: app.url };
  const run = app.runner.run;
  app.runner.run = async (agentId, o) => {
    const a = app.store.get('agents', agentId);
    const rec = {
      agentId, handle: a?.handle ?? null, role: a?.role ?? null, kind: o.kind, cwd: o.cwd, resume: o.resume === true,
      taskId: o.taskId ?? null, prompt: String(o.prompt ?? ''), jobId: a?.jobId ?? null, startedAt: Date.now(),
    };
    shop.turns.push(rec);
    for (const h of [...shop.hooks]) await h(rec);
    const res = await run.call(app.runner, agentId, o);
    Object.assign(rec, { ok: res.ok, killed: res.killed, error: res.error, calls: res.calls, usd: res.usd, endedAt: Date.now() });
    return res;
  };
  shop.cookie = await ownerSession(app.url, app.ownerKey);
  shop.api = apiClient(app.url, shop.cookie);
  const state = await shop.api('GET', '/api/state');
  shop.stopEvents = await followEvents(app.url, shop.cookie, state.body.seq, (e) => shop.sse.push(e));

  shop.job = (id) => app.store.get('jobs', id);
  shop.tasks = (jobId) => app.store.list('tasks', (t) => t.jobId === jobId).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  shop.task = (id) => app.store.get('tasks', id);
  shop.deliveries = (jobId) => app.store.list('deliveries', (d) => d.jobId === jobId).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  shop.msgs = (jobId) => app.board.history({ jobId, limit: 500 });
  shop.project = (jobId) => app.store.get('projects', shop.job(jobId)?.projectId);
  shop.notices = () => shop.sse.filter((e) => e.type === 'notice');
  shop.errors = () => logs.filter((l) => l.level === 'error');
  shop.inbox = async (jobId) => (await shop.api('GET', `/api/inbox${jobId ? `?job=${jobId}` : ''}`)).body;
  shop.waitFor = async (fn, { timeoutMs = 150_000, what = 'a condition', jobId = null, every = 50 } = {}) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let v;
      try { v = await fn(); } catch { v = null; }
      if (v) return v;
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
    await shop.stopEvents().catch(() => {});
    await app.close();
  };
  return shop;
}

/** Start a mock job over HTTP. */
export async function start(shop, { brief, title = 'Notes app', crew = 'solo', name = 'notes', options = {}, extra = {} } = {}) {
  const r = await shop.api('POST', '/api/jobs', {
    title, brief, kind: 'build', project: { mode: 'new', name }, crew, options: { mock: true, ...options }, ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

/** Close the hub, check that no process is left and no error was logged, remove the folders. */
export async function finish(shop, { allowErrors = false } = {}) {
  await shop.close();
  const left = await leftovers(shop.dirs.tmp);
  if (!allowErrors) assert.deepEqual(shop.errors(), [], 'the hub logged no error');
  assert.deepEqual(left, [], 'no process is left');
  if (process.env.KEEP_E2E !== '1') fs.rmSync(shop.dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
}

/** t.after guard: close the hub and remove the folders even when the test fails. */
export function guard(t, shop) {
  t.after(async () => {
    await shop.close().catch(() => {});
    if (process.env.KEEP_E2E !== '1') fs.rmSync(shop.dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
  });
}
