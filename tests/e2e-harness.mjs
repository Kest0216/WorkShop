// Shared harness of the end-to-end tests (tests/e2e.*.test.mjs, contract section 15): the real hub (createApp) on
// temp folders with the file secrets backend and the mock lab only, the owner session over HTTP, the SSE stream,
// a record of every agent turn, and the leftover-process check. No real AI CLI runs: --labs mock switches the
// claude and agy adapters off, and the mock agent (server/providers/mock-agent.mjs) is the only agent process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX = path.join(ROOT, 'server', 'index.js');
export const BRIEF = 'Build a small notes app: a list of notes and a search box. Keep notes in one JSON file. Add tests.';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Temp folders for one shop. Nothing goes under the WorkShop data/, projects/ or config/ folders. */
export function tempShop(prefix = 'ws-e2e-') {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const dirs = { tmp, dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'config'), projectsDir: path.join(tmp, 'projects') };
  fs.mkdirSync(dirs.configDir, { recursive: true });
  return dirs;
}

/** config/settings.json of the temp shop: the mock agent runs at full speed (MOCK_SPEED 0) unless told otherwise. */
export function writeSettings(dirs, settings = {}) {
  fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), `${JSON.stringify({ mockSpeed: 0, ...settings }, null, 2)}\n`);
}

/** The environment of the hub: a temp HOME and TMPDIR (the mock agent keeps its memory there), no login shell. */
export function hubEnv(dirs) {
  return {
    HOME: dirs.tmp, USER: 'tester', LOGNAME: 'tester', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: `${dirs.tmp}/`,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, WORKSHOP_PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    WORKSHOP_DISABLE_AGY: '1',
  };
}

/** git in a project folder (the test reads the owner's repo). */
export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

/** One SSE client on /api/events: every event goes to onEvent. Returns stop(). */
export async function followEvents(url, cookie, since, onEvent) {
  const ac = new AbortController();
  const res = await fetch(`${url}/api/events?since=${since}`, { headers: { cookie }, signal: ac.signal });
  assert.equal(res.status, 200, 'the SSE stream opens with the owner cookie');
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (data) { try { onEvent(JSON.parse(data)); } catch { /* a heartbeat or a broken frame */ } }
        }
      }
    } catch { /* aborted, or the hub closed the stream */ }
  })();
  return async () => { ac.abort(); await done; };
}

/** Open the owner session: POST /api/session { k } gives the cookie. */
export async function ownerSession(url, ownerKey) {
  const r = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'x-workshop': '1', 'content-type': 'application/json' }, body: JSON.stringify({ k: ownerKey }) });
  assert.equal(r.status, 200, 'the owner key opens a session');
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^workshop_owner_\d+=/);
  return cookie;
}

/** An API client with the owner cookie. */
export function apiClient(url, cookie) {
  return async (method, p, body) => {
    const r = await fetch(`${url}${p}`, {
      method, headers: { cookie, 'x-workshop': '1', 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, body: json ?? text, type: r.headers.get('content-type') ?? '' };
  };
}

/**
 * Boot the real hub on temp folders. opts: { dirs?, settings?, tickMs?, keepDirs?, app? (more createApp options) }.
 * The shop records every agent turn (shop.turns), every SSE event (shop.sse) and every hub log line (shop.logs).
 */
export async function bootShop(opts = {}) {
  const dirs = opts.dirs ?? tempShop();
  if (!opts.dirs || opts.settings) writeSettings(dirs, opts.settings ?? {});
  const logs = opts.logs ?? [];
  const log = (level, msg, data) => { logs.push({ level, msg, data, at: Date.now() }); };
  const app = await createApp({
    ...dirs, port: 0, secretsBackend: 'file', labs: ['mock'], env: hubEnv(dirs), log, stderr: null, tickMs: opts.tickMs ?? 150,
    runnerTuning: { minSpawnGapMs: 50 },
    orchTuning: { managerDebounceMs: 300, managerMaxDelayMs: 1500 },
    power: { hold() {}, release() {} }, pickFolder: async () => null, reveal: async () => {},
    ...(opts.app ?? {}), // more createApp options (a scenario passes a patched mock adapter); labs stays ['mock']
    labs: opts.app && 'labs' in opts.app ? opts.app.labs : ['mock'],
  });
  const shop = { app, dirs, logs, turns: opts.turns ?? [], sse: opts.sse ?? [], url: app.url };

  // Every agent turn, with its cwd, access, session and prompt (the runner object is the one the orchestrator holds).
  const run = app.runner.run;
  app.runner.run = async (agentId, o) => {
    const a = app.store.get('agents', agentId);
    const rec = {
      agentId, handle: a?.handle ?? null, role: a?.role ?? null, kind: o.kind, cwd: o.cwd, access: o.access, resume: o.resume === true,
      sessionId: o.sessionId ?? null, taskId: o.taskId ?? null, prompt: String(o.prompt ?? ''), jobId: a?.jobId ?? null, startedAt: Date.now(),
    };
    shop.turns.push(rec);
    const res = await run.call(app.runner, agentId, o);
    Object.assign(rec, { ok: res.ok, killed: res.killed, error: res.error, calls: res.calls, resultSession: res.sessionId, endedAt: Date.now() });
    return res;
  };

  shop.cookie = await ownerSession(app.url, app.ownerKey);
  shop.api = apiClient(app.url, shop.cookie);
  const state = await shop.api('GET', '/api/state');
  assert.equal(state.status, 200);
  shop.stopEvents = await followEvents(app.url, shop.cookie, state.body.seq, (e) => shop.sse.push(e));

  shop.job = (id) => app.store.get('jobs', id);
  shop.tasks = (jobId) => app.store.list('tasks', (t) => t.jobId === jobId).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  shop.task = (id) => app.store.get('tasks', id);
  shop.deliveries = (jobId) => app.store.list('deliveries', (d) => d.jobId === jobId).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  shop.agents = (jobId) => app.store.list('agents', (a) => a.jobId === jobId);
  shop.msgs = (jobId) => app.board.history({ jobId, limit: 500 });
  shop.project = (jobId) => app.store.get('projects', shop.job(jobId)?.projectId);
  shop.errors = () => logs.filter((l) => l.level === 'error');
  /** Upserts of one kind seen on the SSE stream. */
  shop.seen = (kind, fn = () => true) => shop.sse.filter((e) => e.type === 'upsert' && e.kind === kind && fn(e.item)).map((e) => e.item);
  shop.notices = () => shop.sse.filter((e) => e.type === 'notice');
  shop.boardEvents = () => shop.sse.filter((e) => e.type === 'board').map((e) => e.msg);

  /** Poll until fn() gives a truthy value. Fails the test with `what` and the job status table on timeout. */
  shop.waitFor = async (fn, { timeoutMs = 150_000, what = 'a condition', jobId = null, every = 100 } = {}) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let v;
      try { v = fn(); } catch { v = null; }
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

/** Start a mock job through POST /api/jobs. */
export async function startJob(shop, { brief = BRIEF, title = 'Notes app', crew = 'standard', extra = {} } = {}) {
  const r = await shop.api('POST', '/api/jobs', { title, brief, kind: 'build', project: { mode: 'new', name: 'notes' }, crew, options: { mock: true }, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.id, /^J\d+$/);
  return r.body;
}

/**
 * Wait for delivering with a report, read the truck (GET), ship the shown headSha (POST), wait for done.
 * Returns { truck, ship }.
 */
export async function shipAndFinish(shop, jobId, { timeoutMs = 180_000 } = {}) {
  await shop.waitFor(() => { const j = shop.job(jobId); return j.status === 'delivering' && j.report; }, { timeoutMs, what: `${jobId} delivering with a report`, jobId });
  const truck = await shop.api('GET', `/api/jobs/${jobId}/truck`);
  assert.equal(truck.status, 200);
  assert.match(truck.body.headSha, /^[0-9a-f]{40}$/);
  const ship = await shop.api('POST', `/api/jobs/${jobId}/ship`, { sha: truck.body.headSha });
  assert.equal(ship.status, 200);
  assert.equal(ship.body.ok, true, JSON.stringify(ship.body));
  await shop.waitFor(() => shop.job(jobId).status === 'done', { timeoutMs: 30_000, what: `${jobId} done`, jobId });
  // The hub cleans up after done (git.removeJobWork in a hub step): let it end before the test reads the repo.
  assert.equal(await shop.app.orch.settle({ timeoutMs: 30_000 }), true, 'the hub steps after done ended');
  // The SSE stream lags the store a little on a busy machine: tests read the stream, so wait for it.
  await shop.waitFor(() => shop.seen('jobs', (j) => j.id === jobId && j.status === 'done').length > 0, { timeoutMs: 15_000, what: 'done on the SSE stream', jobId });
  return { truck: truck.body, ship: ship.body };
}

/** Every requirement verified, and each with evidence. */
export function assertAllVerified(job) {
  assert.ok(job.requirements.length > 0, 'the job has requirements');
  for (const r of job.requirements) {
    assert.equal(r.status, 'verified', `${r.id} ${r.text}: ${r.status}`);
    assert.ok(typeof r.evidence === 'string' && r.evidence.length > 0, `${r.id} has evidence`);
  }
}

/**
 * Processes this test left: descendants of this process, and any process whose working folder is under tmp
 * (a detached agent or check whose parent died). ps and lsof themselves are not counted.
 */
export async function leftovers(tmp) {
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }, (err, stdout) => resolve(stdout ?? ''));
  });
  const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
  const rows = ps.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const kids = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (!kids.has(r.pid) && kids.has(r.ppid)) { kids.add(r.pid); grew = true; }
  }
  kids.delete(process.pid);
  const out = rows.filter((r) => kids.has(r.pid) && !/^\/bin\/ps |^ps |lsof/.test(r.cmd)).map((r) => `${r.pid} ${r.cmd}`);
  const lsof = await run('/usr/sbin/lsof', ['-d', 'cwd', '-Fpn']);
  let pid = null;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && (line.slice(1) === tmp || line.slice(1).startsWith(`${tmp}/`)) && pid !== process.pid) {
      const row = rows.find((r) => r.pid === pid);
      if (!row || !/lsof|^\/bin\/ps /.test(row.cmd)) out.push(`${pid} cwd ${line.slice(1)} ${row?.cmd ?? ''}`);
    }
  }
  return [...new Set(out)];
}

/** Close the shop, check that no process is left, remove the temp folders. */
export async function finish(shop, { keep = false, allowErrors = false } = {}) {
  await shop.close();
  const left = await leftovers(shop.dirs.tmp);
  if (!allowErrors) assert.deepEqual(shop.errors(), [], 'the hub logged no error');
  assert.deepEqual(left, [], 'no process is left');
  if (!keep) fs.rmSync(shop.dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
}

export { sleep };
