// Owner REST API (server/api.js) on the real http router, store, settings, file secrets, toolkit and MCP,
// with a fake orchestrator, providers, router, benchlm, git and runner. No CLI runs, no dialog opens.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import httpMod from 'node:http';
import { createHttp } from '../server/http.js';
import { createStore } from '../server/store.js';
import { createSettings } from '../server/config.js';
import { createSecrets } from '../server/secrets.js';
import { createRedactor } from '../server/redact.js';
import { createMcp } from '../server/mcp.js';
import { createToolkit } from '../server/toolkit.js';
import { createDecider } from '../server/decider.js';
import { DEMO_MOCK_SPEED, mountApi } from '../server/api.js';

const OWNER_KEY = 'test-owner-key-0123456789abcdef0123456789abcdef';

function fakeOrch(store) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const orch = {
    calls,
    async createJob(order) {
      calls.push(['createJob', order]);
      const id = store.nextId('J');
      return store.put('jobs', { id, title: order.title, status: 'queued', projectId: null, requirements: [], cost: { billedUsd: 0, estUsd: 0, inTok: 0, outTok: 0 } });
    },
    pauseJob: async (id, o) => { calls.push(['pauseJob', id, o]); store.patch('jobs', id, { status: 'paused', pauseReason: 'owner' }); },
    resumeJob: async (id, o) => { calls.push(['resumeJob', id, o]); store.patch('jobs', id, { status: 'running', pauseReason: null }); },
    cancelJob: async (id) => { calls.push(['cancelJob', id]); store.patch('jobs', id, { status: 'cancelled' }); },
    deleteJob: rec('deleteJob'),
    approvePlan: async (id) => { calls.push(['approvePlan', id]); store.patch('jobs', id, { status: 'running' }); },
    addReq: async (id, { text }) => { calls.push(['addReq', id, text]); return { id: 'R9', text, source: 'owner', status: 'open', evidence: null, waivedReason: null }; },
    waiveReq: async (id, rid, o) => { calls.push(['waiveReq', id, rid, o]); const job = store.get('jobs', id); store.patch('jobs', id, { requirements: job.requirements.map((r) => (r.id === rid ? { ...r, status: 'waived', waivedReason: o.reason } : r)) }); },
    ackAgentFiles: async (pid, ack) => { calls.push(['ackAgentFiles', pid, ack]); store.patch('projects', pid, { agentFilesAck: ack }); },
    ship: async (id, o) => { calls.push(['ship', id, o]); return o.sha.startsWith('dead') ? { ok: false, reason: 'Your branch moved. Look again, then ship.' } : { ok: true, sha: o.sha, left: 0 }; },
    discardTruck: rec('discardTruck'),
    requestChanges: async (id, o) => { calls.push(['requestChanges', id, o]); return { id: 'R10', text: o.text, source: 'owner', status: 'open' }; },
    stopTask: rec('stopTask'),
    retryTask: rec('retryTask'),
    cancelTask: rec('cancelTask'),
    async ownerPost(p) {
      calls.push(['ownerPost', p]);
      if (p.kind === 'ASK' && !p.to) return { ok: false, code: 'E_TO', hint: 'ASK needs one addressee.' };
      return { ok: true, msg: { id: 77, kind: p.kind, from: '@human', body: p.body } };
    },
    truck: async (id) => ({ headSha: 'abc1234', behind: 0, deliveries: [], stat: { files: 0, add: 0, del: 0 }, files: [], reqs: { open: 1, failed: 0, verified: 0, waived: 0 }, check: null, report: null, id }),
    diff: async (id, o) => `diff --git a/x b/x\n# ${id} ${JSON.stringify(o)}\n`,
    inbox: (jobId) => [{ kind: 'plan', id: 'J1', jobId: jobId || 'J1', text: 'The plan waits.', since: 1 }],
    setPresence: rec('setPresence'),
  };
  return orch;
}

function fakeProviders() {
  const calls = [];
  const base = (id, extra = {}) => ({ id, label: id, lab: id === 'claude' ? 'anthropic' : id === 'gemini' ? 'google' : id, installed: true, version: '1.0', path: `/bin/${id}`, auth: 'ok', mode: id === 'oss' ? 'standin' : null, ack: id === 'oss', keySet: false, usable: id === 'mock' || id === 'oss', reason: id === 'mock' || id === 'oss' ? null : 'Choose API key mode.', cooling: null, cooledModels: {}, limit: null, selfTest: null, policyNote: {}, loginCmd: null, installHint: null, models: null, ...extra });
  let apikeyUsable = false;
  return {
    calls,
    setApikeyUsable(v) { apikeyUsable = v; },
    list: () => [base('claude', apikeyUsable ? { usable: true, mode: 'apikey', reason: null } : {}), base('gemini'), base('oss'), base('mock')],
    status: (id) => base(id),
    detect: async (o) => { calls.push(['detect', o]); return [base('claude'), base('gemini'), base('oss'), base('mock')]; },
    refresh: async () => { calls.push(['refresh']); return []; },
    openLogin: async () => { const e = new Error('Consumer subscription logins are disabled in Phase 0. Configure an API key instead.'); e.status = 400; throw e; },
    checkAuth: async (id) => { calls.push(['checkAuth', id]); return base(id, { auth: 'ok' }); },
    selfTest: async (id) => { calls.push(['selfTest', id]); return { ok: true, core: [], advisory: [], steps: [], loaded: ['shop'], logTail: ['line one', 'line two'] }; },
  };
}

function fakeRouter() {
  let reg = { version: 1, dataDate: '2026-11-01', models: [{ id: 'm1', provider: 'mock', tiers: ['maker'] }], categories: {}, domains: {} };
  return {
    registry: () => structuredClone(reg),
    leaders: () => ({ plan: { boss: [] } }),
    save(next) { if (!Array.isArray(next?.models)) { const e = new Error('The registry needs a models list.'); throw e; } reg = structuredClone(next); return structuredClone(reg); },
  };
}

let tmp, store, settings, secrets, redactor, mcp, http, api, orch, providers, base, cookie, picks, reveals, toolkit, runner;

async function req(method, url, { body, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.cookie = cookie;
  if (method !== 'GET') { h['x-workshop'] = '1'; h['content-type'] = 'application/json'; }
  const res = await fetch(base + url, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-api-')));
  const dataDir = path.join(tmp, 'data');
  store = createStore({ dataDir, saveDelayMs: 5 });
  settings = createSettings({ configDir: path.join(tmp, 'config') });
  redactor = createRedactor();
  secrets = createSecrets({ backend: 'file', dataDir, redactor });
  mcp = createMcp({ store, redactor });
  orch = fakeOrch(store);
  providers = fakeProviders();
  picks = [];
  reveals = [];
  runner = { logTail: (id, n) => [{ k: 'text', s: `${id} tail ${n}` }], active: () => [], queued: () => [] };
  const git = {
    adoptProject: async ({ path: p }) => { if (p.includes('not-a-repo')) throw new Error(`Not a git repository: ${p}`); return { path: p, targetBranch: 'main', agentFiles: ['AGENTS.md'] }; },
    makeClone: async (project, jobId, name, sha) => ({ dir: path.join(dataDir, 'work', jobId, name), sha }),
    runCheck: async () => ({ ok: true, code: 0, tail: 'ok\n' }),
  };
  toolkit = createToolkit({ store, dataDir, orch, git, redactor, reveal: async (p) => reveals.push(p) });
  const benchlm = { refresh: async (reg) => { reg.dataDate = '2026-11-15'; return { ok: true, changed: true, updated: ['m1'], dataDate: '2026-11-15', notModified: false, error: null }; } };
  const board = { history: (o) => [{ id: 1, kind: 'INFO', body: 'hello', opts: o }] };
  const decider = createDecider({ secrets });
  http = createHttp({ ownerKey: OWNER_KEY, closeGraceMs: 50 });
  api = mountApi(http, {
    store, board, orch, providers, secrets, settings, router: fakeRouter(), benchlm, git, toolkit, decider, runner, mcp,
    pickFolder: async () => picks.shift() ?? null, reveal: async (p) => reveals.push(p),
  });
  const { port } = await http.listen();
  base = `http://127.0.0.1:${port}`;
  const s = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'x-workshop': '1', 'content-type': 'application/json' }, body: JSON.stringify({ k: OWNER_KEY }) });
  assert.equal(s.status, 200);
  cookie = s.headers.get('set-cookie').split(';')[0];
  store.put('projects', { id: 'P1', name: 'p', path: path.join(tmp, 'proj'), targetBranch: 'main', checkCmd: 'npm test', agentFilesAck: false });
  assert.equal(store.nextId('J'), 'J1');
  store.put('jobs', { id: 'J1', title: 'One', status: 'plan_review', projectId: 'P1', intSha: 'abc1234', requirements: [{ id: 'R1', text: 'x', source: 'plan', status: 'open' }], cost: { billedUsd: 0 } });
  store.put('tasks', { id: 'T1', jobId: 'J1', status: 'working', deps: [] });
  store.put('tasks', { id: 'T2', jobId: 'J1', status: 'planned', deps: ['T1'] });
  store.put('agents', { id: 'A1', jobId: 'J1', handle: '@m1', role: 'maker' });
  store.put('deliveries', { id: 'D1', jobId: 'J1', taskId: 'T1', status: 'loaded' });
});

after(async () => {
  api.close();
  await toolkit.idle();
  await http.close();
  await store.flush();
  await fs.rm(tmp, { recursive: true, force: true });
});

// Every route with a sample call, for the cookie test.
const ROUTES = [
  ['GET', '/api/state'], ['GET', '/api/events'], ['GET', '/api/health'], ['GET', '/api/jobs'], ['POST', '/api/jobs'], ['POST', '/api/demo'],
  ['POST', '/api/jobs/J1/pause'], ['POST', '/api/jobs/J1/resume'], ['POST', '/api/jobs/J1/cancel'], ['DELETE', '/api/jobs/J1'],
  ['POST', '/api/jobs/J1/plan/approve'], ['POST', '/api/jobs/J1/reqs'], ['POST', '/api/jobs/J1/reqs/R1/waive'], ['GET', '/api/jobs/J1/truck'],
  ['POST', '/api/jobs/J1/ship'], ['POST', '/api/jobs/J1/truck/discard'], ['POST', '/api/jobs/J1/changes'], ['GET', '/api/jobs/J1/diff'],
  ['POST', '/api/tasks/T1/stop'], ['POST', '/api/tasks/T1/retry'], ['POST', '/api/tasks/T1/cancel'],
  ['GET', '/api/board'], ['POST', '/api/board'], ['GET', '/api/inbox'], ['PUT', '/api/presence'], ['GET', '/api/agents/A1/log'],
  ['GET', '/api/providers'], ['POST', '/api/providers/detect'], ['PUT', '/api/providers/claude/mode'], ['POST', '/api/providers/claude/login'],
  ['POST', '/api/providers/claude/check'], ['POST', '/api/providers/claude/selftest'],
  ['GET', '/api/keys'], ['PUT', '/api/keys/anthropic'], ['DELETE', '/api/keys/anthropic'], ['GET', '/api/settings'], ['PUT', '/api/settings'],
  ['GET', '/api/models'], ['PUT', '/api/models'], ['POST', '/api/models/refresh'],
  ['GET', '/api/projects/P1/toolkit'], ['PUT', '/api/projects/P1/toolkit'], ['POST', '/api/projects/P1/toolkit/check/run'], ['POST', '/api/projects/P1/agentfiles'],
  ['POST', '/api/pick-folder'], ['POST', '/api/adopt-check'], ['POST', '/api/reveal'],
];

describe('owner gate', () => {
  test('every route answers 401 without the cookie and calls nothing', async () => {
    const before = orch.calls.length + providers.calls.length;
    for (const [method, url] of ROUTES) {
      const r = await req(method, url, { auth: false, body: { title: 'x' } });
      assert.equal(r.status, 401, `${method} ${url}`);
      assert.deepEqual(r.data, { error: 'owner session required' });
    }
    assert.equal(orch.calls.length + providers.calls.length, before);
  });

  test('a wrong owner key opens nothing', async () => {
    const r = await req('POST', '/api/session', { auth: false, body: { k: 'wrong' } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
  });

  test('an agent token opens nothing under /api, but works on /mcp/:token', async () => {
    const token = mcp.tokenFor('A1');
    for (const headers of [{ authorization: `Bearer ${token}` }, { cookie: `workshop_owner=${token}` }, { cookie: `${cookie.split('=')[0]}=${token}` }]) {
      const r = await req('GET', '/api/state', { auth: false, headers });
      assert.equal(r.status, 401);
    }
    assert.equal((await req('GET', `/api/state?token=${token}`, { auth: false })).status, 401);
    const m = await req('POST', `/mcp/${token}`, { auth: false, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal(m.status, 200);
    assert.equal(m.data.id, 1);
    mcp.revoke('A1');
  });

  test('response headers and the X-WorkShop guard', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'");
    const res = await fetch(`${base}/api/demo`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 403);
  });
});

describe('state and events', () => {
  test('GET /api/state has the UI shape', async () => {
    const r = await req('GET', '/api/state');
    assert.equal(r.status, 200);
    for (const k of ['seq', 'state', 'providers', 'settings', 'board', 'models', 'inbox']) assert.ok(k in r.data, k);
    assert.equal(r.data.seq, r.data.state.seq);
    assert.equal(r.data.state.jobs.J1.title, 'One');
    assert.ok(Array.isArray(r.data.providers) && r.data.providers.length === 4);
    assert.equal(r.data.board[0].opts.limit, 200);
    assert.ok(r.data.models.registry && r.data.models.leaders);
    assert.equal(r.data.inbox[0].kind, 'plan');
    assert.equal(r.data.settings.safety, 'sandboxed');
  });

  test('GET /api/events replays from ?since= and streams live events', async () => {
    const since = store.state.seq;
    store.emit('notice', { level: 'info', text: 'before connect', jobId: null });
    const frames = [];
    const port = new URL(base).port;
    const done = new Promise((resolve, reject) => {
      const r = httpMod.get({ host: '127.0.0.1', port, path: `/api/events?since=${since}`, headers: { cookie } }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            if (data) frames.push(JSON.parse(data.slice(6)));
            if (frames.length === 1) store.emit('notice', { level: 'warn', text: 'live', jobId: null }, { persist: false });
            if (frames.length >= 2) { r.destroy(); resolve(); }
          }
        });
      });
      r.on('error', (e) => { if (frames.length < 2) reject(e); });
    });
    await done;
    assert.equal(frames[0].text, 'before connect');
    assert.equal(frames[1].text, 'live');
    assert.ok(!('event' in frames[1]));
  });

  test('health', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.data.ok, true);
    assert.equal(r.data.activeJob, 'J1');
    assert.equal(r.data.decider.enabled, false);
  });
});

describe('jobs', () => {
  test('create: validation, then a thin call', async () => {
    const bad = [
      [{}, /title/], [{ title: 't' }, /brief/], [{ title: 't', brief: 'b', kind: 'x' }, /Kind/],
      [{ title: 't', brief: 'b', kind: 'build' }, /project.mode/],
      [{ title: 't', brief: 'b', kind: 'build', project: { mode: 'existing' } }, /folder/],
      [{ title: 't', brief: 'b', kind: 'build', project: { mode: 'new', name: '../x' } }, /Project name/],
      [{ title: 't', brief: 'b', kind: 'build', project: { mode: 'new' }, crew: 'huge' }, /crew preset/],
      [{ title: 't', brief: 'b', kind: 'build', project: { mode: 'new' }, crew: { bosses: 0, managers: 0, makers: 1 } }, /bosses/],
      [{ title: 't', brief: 'b', kind: 'build', project: { mode: 'new' }, budgetUsd: -1 }, /budgetUsd/],
    ];
    for (const [body, re] of bad) {
      const r = await req('POST', '/api/jobs', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.data.error, re);
    }
    const r = await req('POST', '/api/jobs', { body: { title: ' New ', brief: 'Do it.', kind: 'fix', project: { mode: 'existing', path: '/tmp/x', agentFilesAck: true }, crew: 'solo', options: { approvePlan: true }, budgetUsd: 5 } });
    assert.equal(r.status, 200);
    assert.match(r.data.id, /^J\d+$/);
    const order = orch.calls.filter((c) => c[0] === 'createJob').at(-1)[1];
    assert.deepEqual(order, { title: 'New', brief: 'Do it.', kind: 'fix', project: { mode: 'existing', path: '/tmp/x', agentFilesAck: true }, crew: 'solo', options: { approvePlan: true, mock: false }, budgetUsd: 5 });
  });

  test('create refuses a job without budget when a usable lab is in apikey mode', async () => {
    providers.setApikeyUsable(true);
    const r = await req('POST', '/api/jobs', { body: { title: 't', brief: 'b', kind: 'build', project: { mode: 'new' } } });
    providers.setApikeyUsable(false);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /budget/);
  });

  test('demo starts a mock job with no tokens', async () => {
    const r = await req('POST', '/api/demo');
    assert.equal(r.status, 200);
    const order = orch.calls.filter((c) => c[0] === 'createJob').at(-1)[1];
    assert.equal(order.options.mock, true);
    assert.equal(order.project.mode, 'new');
  });

  test('the demo runs the mock lab at its own slow pace; mockSpeed 0 keeps it fast', async () => {
    const was = settings.get().mockSpeed;
    try {
      settings.update({ mockSpeed: 1 });
      await req('POST', '/api/demo');
      assert.equal(orch.calls.filter((c) => c[0] === 'createJob').at(-1)[1].options.mockSpeed, DEMO_MOCK_SPEED);
      assert.ok(DEMO_MOCK_SPEED > 1, 'slower than the default pace');
      settings.update({ mockSpeed: 0 });
      await req('POST', '/api/demo');
      assert.equal(orch.calls.filter((c) => c[0] === 'createJob').at(-1)[1].options.mockSpeed, 0);
    } finally {
      settings.update({ mockSpeed: was ?? 1 });
    }
  });

  test('pause, resume, approve, reqs, waive, cancel, delete', async () => {
    assert.equal((await req('POST', '/api/jobs/J1/plan/approve')).data.status, 'running');
    assert.equal((await req('POST', '/api/jobs/J1/plan/approve')).status, 409);
    const p = await req('POST', '/api/jobs/J1/pause', { body: { hard: true } });
    assert.equal(p.data.status, 'paused');
    assert.deepEqual(orch.calls.find((c) => c[0] === 'pauseJob').slice(1), ['J1', { hard: true }]);
    assert.equal((await req('POST', '/api/jobs/J1/resume', { body: { budgetUsd: 'x' } })).status, 400);
    assert.equal((await req('POST', '/api/jobs/J1/resume', { body: { budgetUsd: 30 } })).data.status, 'running');
    assert.deepEqual(orch.calls.find((c) => c[0] === 'resumeJob').slice(1), ['J1', { budgetUsd: 30 }]);
    assert.equal((await req('POST', '/api/jobs/J1/reqs', { body: { text: ' ' } })).status, 400);
    assert.equal((await req('POST', '/api/jobs/J1/reqs', { body: { text: 'Add dark mode' } })).data.id, 'R9');
    assert.equal((await req('POST', '/api/jobs/J1/reqs/R7/waive', { body: { reason: 'x' } })).status, 404);
    assert.equal((await req('POST', '/api/jobs/J1/reqs/R1/waive', { body: {} })).status, 400);
    const w = await req('POST', '/api/jobs/J1/reqs/R1/waive', { body: { reason: 'Not needed.' } });
    assert.deepEqual([w.data.id, w.data.status, w.data.waivedReason], ['R1', 'waived', 'Not needed.']);
    assert.equal((await req('DELETE', '/api/jobs/J1')).status, 409, 'a live job cannot be deleted');
    assert.equal((await req('POST', '/api/jobs/J1/truck/discard')).status, 409);
    assert.equal((await req('POST', '/api/jobs/J1/cancel')).data.status, 'cancelled');
    assert.deepEqual((await req('POST', '/api/jobs/J1/truck/discard')).data, { ok: true });
    assert.deepEqual((await req('DELETE', '/api/jobs/J1')).data, { ok: true });
    assert.equal((await req('POST', '/api/jobs/J99/pause')).status, 404);
    assert.equal((await req('POST', '/api/jobs/..%2Fx/pause')).status, 404);
    store.patch('jobs', 'J1', { status: 'running' });
  });

  test('resume after a budget stop needs a budget above the bill', async () => {
    store.put('jobs', { id: store.nextId('J'), title: 'Budget', status: 'paused', pauseReason: 'budget', projectId: 'P1', requirements: [], cost: { billedUsd: 20.04 } });
    const id = store.list('jobs').at(-1).id;
    const low = await req('POST', `/api/jobs/${id}/resume`, { body: { budgetUsd: 20 } });
    assert.equal(low.status, 400);
    assert.match(low.data.error, /above \$20\.04/);
    assert.equal((await req('POST', `/api/jobs/${id}/resume`)).status, 400);
    assert.equal((await req('POST', `/api/jobs/${id}/resume`, { body: { budgetUsd: 25 } })).status, 200);
    assert.equal((await req('POST', '/api/jobs', { body: { title: 't', brief: 'b', kind: 'build', project: { mode: 'new' }, crew: { bosses: 4, managers: 0, makers: 1 } } })).status, 400);
  });

  test('truck, ship, changes, diff', async () => {
    assert.equal((await req('GET', '/api/jobs/J1/truck')).data.headSha, 'abc1234');
    assert.equal((await req('POST', '/api/jobs/J1/ship', { body: {} })).status, 400);
    assert.equal((await req('POST', '/api/jobs/J1/ship', { body: { sha: 'HEAD' } })).status, 400);
    assert.deepEqual((await req('POST', '/api/jobs/J1/ship', { body: { sha: 'ABC1234' } })).data, { ok: true, sha: 'abc1234', left: 0 });
    const moved = await req('POST', '/api/jobs/J1/ship', { body: { sha: 'deadbeef' } });
    assert.equal(moved.status, 200, 'a refused ship is an answer, not an error');
    assert.equal(moved.data.ok, false);
    assert.equal((await req('POST', '/api/jobs/J1/changes', { body: {} })).status, 400);
    assert.equal((await req('POST', '/api/jobs/J1/changes', { body: { text: 'x', deliveryId: 'D9' } })).status, 404);
    const c = await req('POST', '/api/jobs/J1/changes', { body: { text: 'Bigger font.', deliveryId: 'D1' } });
    assert.equal(c.data.ok, true);
    assert.equal(c.data.req.id, 'R10');
    const d = await req('GET', '/api/jobs/J1/diff?delivery=D1&path=src%2Fa.js');
    assert.match(d.headers.get('content-type'), /text\/plain/);
    assert.match(d.data, /"deliveryId":"D1","path":"src\/a.js"/);
    assert.equal((await req('GET', '/api/jobs/J1/diff?delivery=D5')).status, 404);
  });
});

describe('tasks, board, inbox, presence, agents', () => {
  test('task stop, retry, cancel', async () => {
    assert.equal((await req('POST', '/api/tasks/T1/stop', { body: { note: 'wait' } })).data.id, 'T1');
    assert.deepEqual(orch.calls.find((c) => c[0] === 'stopTask').slice(1), ['T1', { note: 'wait' }]);
    assert.equal((await req('POST', '/api/tasks/T1/retry', { body: { model: 'bigger' } })).status, 400);
    await req('POST', '/api/tasks/T1/retry', { body: { model: 'up', note: 'try again' } });
    assert.deepEqual(orch.calls.find((c) => c[0] === 'retryTask').slice(1), ['T1', { note: 'try again', model: 'up' }]);
    assert.equal((await req('POST', '/api/tasks/T1/cancel', { body: {} })).status, 400);
    assert.equal((await req('POST', '/api/tasks/T1/cancel', { body: { reason: 'r', replacedBy: ['T77'] } })).status, 404);
    assert.equal((await req('POST', '/api/tasks/T1/cancel', { body: { reason: 'r', replacedBy: 'T2' } })).status, 400);
    await req('POST', '/api/tasks/T1/cancel', { body: { reason: 'Split.', replacedBy: ['T2'] } });
    assert.deepEqual(orch.calls.find((c) => c[0] === 'cancelTask').slice(1), ['T1', { reason: 'Split.', replacedBy: ['T2'] }]);
    assert.equal((await req('POST', '/api/tasks/T99/stop')).status, 404);
  });

  test('board history and owner posts', async () => {
    const h = await req('GET', '/api/board?job=J1&since=0&limit=2000');
    assert.deepEqual(h.data[0].opts, { jobId: 'J1', since: 0, limit: 2000 });
    assert.equal((await req('GET', '/api/board?job=nope')).status, 400);
    assert.equal((await req('GET', '/api/board?limit=0')).status, 400);
    const ok = await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'ans', re: '12', body: 'A' } });
    assert.deepEqual(ok.data, { ok: true, msg: { id: 77, kind: 'ANS', from: '@human', body: 'A' } });
    assert.deepEqual(orch.calls.filter((c) => c[0] === 'ownerPost').at(-1)[1], { jobId: 'J1', kind: 'ANS', re: 12, body: 'A' });
    const refused = await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'ASK', body: 'Why?' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.data.error, 'E_TO: ASK needs one addressee.');
    assert.equal((await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'SHOUT', body: 'x' } })).status, 400);
    assert.equal((await req('POST', '/api/board', { body: { jobId: 'J9', kind: 'INFO', body: 'x' } })).status, 404);
    assert.equal((await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'INFO', to: 'bob', body: 'x' } })).status, 400);
    assert.equal((await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'INFO', slots: { evil: 1 }, body: 'x' } })).status, 400);
    const slots = await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'PASS', re: 5, slots: { conf: 'high', ttl: null }, body: '' } });
    assert.equal(slots.status, 200);
    assert.deepEqual(orch.calls.filter((c) => c[0] === 'ownerPost').at(-1)[1].slots, { conf: 'high' });
  });

  test('inbox, presence, agent log', async () => {
    assert.equal((await req('GET', '/api/inbox?job=J1')).data[0].jobId, 'J1');
    assert.equal((await req('PUT', '/api/presence', { body: { state: 'gone' } })).status, 400);
    assert.deepEqual((await req('PUT', '/api/presence', { body: { state: 'away' } })).data, { ok: true, presence: 'away' });
    assert.equal(settings.get().presence, 'away');
    await req('PUT', '/api/presence', { body: { state: 'here' } });
    assert.deepEqual((await req('GET', '/api/agents/A1/log?tail=5')).data, [{ k: 'text', s: 'A1 tail 5' }]);
    assert.equal((await req('GET', '/api/agents/A9/log')).status, 404);
    assert.equal((await req('GET', '/api/agents/A1/log?tail=-1')).status, 400);
  });
});

describe('providers, keys, settings, models', () => {
  test('provider routes', async () => {
    assert.equal((await req('GET', '/api/providers')).data.length, 4);
    assert.equal((await req('POST', '/api/providers/detect')).data.length, 4);
    assert.deepEqual(providers.calls.find((c) => c[0] === 'detect')[1], { force: true });
    assert.equal((await req('PUT', '/api/providers/claude/mode', { body: { mode: 'both' } })).status, 400);
    assert.equal((await req('PUT', '/api/providers/claude/mode', { body: { mode: 'subscription' } })).status, 400);
    assert.equal((await req('PUT', '/api/providers/mock/mode', { body: { mode: 'apikey' } })).status, 400);
    assert.equal((await req('PUT', '/api/providers/openai/mode', { body: { mode: 'apikey' } })).status, 404);
    const m = await req('PUT', '/api/providers/gemini/mode', { body: { mode: 'apikey' } });
    assert.equal(m.data.id, 'gemini');
    const s = settings.get();
    assert.equal(s.auth.gemini, 'apikey');
    assert.equal(s.authAck.gemini.mode, 'apikey');
    assert.ok(s.authAck.gemini.ts > 0);
    assert.ok(providers.calls.some((c) => c[0] === 'refresh'));
    assert.equal((await req('POST', '/api/providers/claude/login')).status, 400);
    assert.equal((await req('POST', '/api/providers/claude/check')).data.auth, 'ok');
    const ossCfg = await req('PUT', '/api/providers/oss', { body: { engine: 'ollama', standIn: true } });
    assert.equal(ossCfg.status, 200);
    assert.equal(settings.get().oss.standIn, true);
    const t = await req('POST', '/api/providers/claude/selftest');
    assert.equal(t.data.logTail, 'line one\nline two');
    assert.deepEqual(t.data.loaded, ['shop']);
  });

  test('keys: never a value', async () => {
    const list = await req('GET', '/api/keys');
    assert.deepEqual(list.data.slice(0, 5).map((k) => k.id), ['anthropic', 'gemini', 'openai', 'typesafe', 'oss']);
    assert.equal((await req('PUT', '/api/keys/anthropic', { body: { value: '' } })).status, 400);
    assert.equal((await req('PUT', '/api/keys/bad%20id', { body: { value: 'x' } })).status, 400);
    assert.equal((await req('PUT', '/api/keys/custom', { body: { value: 'sk-1234567890abcdef', envVar: 'lower' } })).status, 400);
    const value = 'tsk-secret-value-abcdef-9876';
    const put = await req('PUT', '/api/keys/typesafe', { body: { value } });
    assert.equal(put.status, 200);
    assert.deepEqual([put.data.id, put.data.set, put.data.hint], ['typesafe', true, '9876']);
    const all = JSON.stringify((await req('GET', '/api/keys')).data) + JSON.stringify(put.data) + JSON.stringify((await req('GET', '/api/state')).data);
    assert.equal(all.includes(value), false, 'no route returns the value');
    assert.equal((await req('GET', '/api/health')).data.decider.enabled, true, 'the decider sees the new key');
    assert.equal((await req('DELETE', '/api/keys/nokey')).status, 404);
    assert.equal((await req('DELETE', '/api/keys/typesafe')).data.ok, true);
    assert.equal((await req('GET', '/api/keys')).data.find((k) => k.id === 'typesafe').set, false);
    assert.equal((await req('GET', '/api/health')).data.decider.enabled, false);
  });

  test('settings', async () => {
    assert.equal((await req('GET', '/api/settings')).data.thrift, 0.3);
    assert.equal((await req('PUT', '/api/settings', { body: {} })).status, 400);
    assert.equal((await req('PUT', '/api/settings', { body: { patch: { thrift: 5 } } })).status, 400);
    assert.equal((await req('PUT', '/api/settings', { body: { patch: { selfTest: { claude: { ok: true } } } } })).status, 400);
    const r = await req('PUT', '/api/settings', { body: { patch: { thrift: 0.5, ui: { sound: true } } } });
    assert.equal(r.data.thrift, 0.5);
    assert.equal(r.data.ui.sound, true);
  });

  test('models get, put and refresh', async () => {
    assert.equal((await req('GET', '/api/models')).data.registry.dataDate, '2026-11-01');
    assert.equal((await req('PUT', '/api/models', { body: { registry: { models: 'x' } } })).status, 400);
    assert.equal((await req('PUT', '/api/models', { body: {} })).status, 400);
    const reg = (await req('GET', '/api/models')).data.registry;
    reg.models[0].enabled = false;
    assert.equal((await req('PUT', '/api/models', { body: { registry: reg } })).data.registry.models[0].enabled, false);
    const r = await req('POST', '/api/models/refresh');
    assert.deepEqual([r.data.ok, r.data.changed, r.data.updated, r.data.dataDate], [true, true, 1, '2026-11-15']);
    assert.equal(r.data.registry.dataDate, '2026-11-15', 'a changed refresh is saved');
  });
});

describe('projects, folder, reveal', () => {
  test('toolkit get, put, run', async () => {
    const g = await req('GET', '/api/projects/P1/toolkit');
    assert.equal(g.data.length, 4);
    assert.equal((await req('GET', '/api/projects/P9/toolkit')).status, 404);
    assert.equal((await req('PUT', '/api/projects/P1/toolkit', { body: { tools: 'x' } })).status, 400);
    assert.equal((await req('PUT', '/api/projects/P1/toolkit', { body: { tools: [{ name: '', kind: 'command' }] } })).status, 400);
    const run = await req('POST', '/api/projects/P1/toolkit/check/run');
    assert.match(run.data.runId, /^run_/);
    await toolkit.idle();
    assert.equal((await req('POST', '/api/projects/P1/toolkit/nope/run')).status, 404);
    assert.deepEqual((await req('POST', '/api/projects/P1/toolkit/folder/run')).data, { ok: true });
    assert.ok(reveals.includes(path.join(tmp, 'proj')));
  });

  test('agent files ack', async () => {
    assert.equal((await req('POST', '/api/projects/P1/agentfiles', { body: { ack: 'yes' } })).status, 400);
    assert.equal((await req('POST', '/api/projects/P1/agentfiles', { body: { ack: true } })).data.agentFilesAck, true);
  });

  test('pick-folder uses the injected dialog and adoptProject (read-only)', async () => {
    assert.deepEqual((await req('POST', '/api/pick-folder')).data, { path: null });
    picks.push('/Users/x/code/app');
    assert.deepEqual((await req('POST', '/api/pick-folder')).data, { path: '/Users/x/code/app', targetBranch: 'main', agentFiles: ['AGENTS.md'] });
    picks.push('/Users/x/not-a-repo');
    const bad = await req('POST', '/api/pick-folder');
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /Not a git repository/);
  });

  test('reveal a project or the truck preview clone', async () => {
    assert.equal((await req('POST', '/api/reveal', { body: { projectId: 'P1' } })).data.path, path.join(tmp, 'proj'));
    assert.equal((await req('POST', '/api/reveal', { body: { projectId: 'P5' } })).status, 404);
    assert.equal((await req('POST', '/api/reveal', { body: { jobId: 'J1', what: 'bench' } })).status, 400);
    const t = await req('POST', '/api/reveal', { body: { jobId: 'J1', what: 'truck' } });
    assert.equal(t.data.path, path.join(tmp, 'data', 'work', 'J1', '_preview'));
    assert.equal(reveals.at(-1), t.data.path);
  });

  test('unknown /api route is a 404 with the cookie', async () => {
    assert.equal((await req('GET', '/api/nothing')).status, 404);
  });
});

// ---- final wiring spec, part S (S1, S2, S3, S6, S7) ----

/** A second hub API on the same fakes, for options the shared one does not have (no reveal, a short heartbeat). */
async function miniHub({ reveal = null, heartbeatMs } = {}) {
  const shown = [];
  const h = createHttp({ ownerKey: OWNER_KEY, closeGraceMs: 50, ...(heartbeatMs ? { heartbeatMs } : {}) });
  const git = {
    adoptProject: async ({ path: p }) => ({ path: p, targetBranch: 'main', agentFiles: [] }),
    makeClone: async (project, jobId, name) => ({ dir: path.join(tmp, 'data', 'work', jobId, name) }),
  };
  const a = mountApi(h, { store, board: { history: () => [] }, orch, providers, secrets, settings, router: fakeRouter(), git, runner, reveal: reveal ? async (p) => shown.push(p) : null });
  const { port } = await h.listen();
  const url = `http://127.0.0.1:${port}`;
  const s = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'x-workshop': '1', 'content-type': 'application/json' }, body: JSON.stringify({ k: OWNER_KEY }) });
  const c = s.headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body) => {
    const r = await fetch(url + p, { method, headers: { cookie: c, 'x-workshop': '1', 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: r.status, data: await r.json() };
  };
  return { url, cookie: c, port, call, shown, close: async () => { a.close(); await h.close(); } };
}

describe('final wiring (part S)', () => {
  test('S1: the SSE heartbeat is a data message with the health seq and no id line; replay by Last-Event-ID still works', async () => {
    const hub = await miniHub({ heartbeatMs: 30 });
    try {
      const frames = [];
      let raw = '';
      const stop = await new Promise((resolve, reject) => {
        const r = httpMod.get({ host: '127.0.0.1', port: hub.port, path: '/api/events', headers: { cookie: hub.cookie } }, (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          resolve(() => r.destroy());
        });
        r.on('error', reject);
      });
      const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };
      await until(() => (raw.match(/"type":"hb"/g) ?? []).length >= 2);
      store.emit('notice', { level: 'info', text: 'after the beat', jobId: null });
      await until(() => raw.includes('after the beat') && raw.split('after the beat')[1].includes('"type":"hb"'));
      stop();
      for (const block of raw.split('\n\n')) if (block.includes('data: ')) frames.push(block);
      const beats = frames.filter((f) => f.includes('"type":"hb"'));
      assert.ok(beats.length >= 3, raw);
      assert.ok(beats.every((f) => !/^id:/m.test(f) && /^data: \{"type":"hb","seq":\d+\}$/m.test(f)), 'a beat has no id line');
      assert.equal(/^:/m.test(raw), false, 'no comment line');
      const health = await hub.call('GET', '/api/health');
      const last = JSON.parse(beats.at(-1).slice(beats.at(-1).indexOf('{')));
      assert.equal(last.seq, health.data.seq, 'the beat carries the seq that health reports');
      const lastId = Number(/^id: (\d+)$/m.exec(frames.find((f) => f.includes('after the beat')))[1]);
      assert.equal(lastId, health.data.seq);
    } finally { await hub.close(); }
  });

  test('S2: POST /api/adopt-check reads the folder (adoptProject) and answers like pick-folder; bad paths are 400', async () => {
    const ok = await req('POST', '/api/adopt-check', { body: { path: '/Users/x/code/app' } });
    assert.deepEqual([ok.status, ok.data], [200, { path: '/Users/x/code/app', targetBranch: 'main', agentFiles: ['AGENTS.md'] }]);
    const notGit = await req('POST', '/api/adopt-check', { body: { path: '/Users/x/not-a-repo' } });
    assert.deepEqual([notGit.status, notGit.data.error], [400, 'Not a git repository: /Users/x/not-a-repo'], 'the git message as it comes');
    for (const bad of [undefined, '', '   ', 7, 'relative/dir', `/${'a'.repeat(4096)}`, '/a\0b']) {
      const r = await req('POST', '/api/adopt-check', { body: { path: bad } });
      assert.equal(r.status, 400, String(bad).slice(0, 20));
      assert.equal(typeof r.data.error, 'string');
    }
    assert.equal((await req('POST', '/api/adopt-check', { auth: false, body: { path: '/a' } })).status, 401);
  });

  test('S3: reveal with open:false makes the preview and answers its absolute path, without Finder, also on a hub with no reveal', async () => {
    const before = reveals.length;
    const t = await req('POST', '/api/reveal', { body: { jobId: 'J1', what: 'truck', open: false } });
    assert.deepEqual(t.data, { ok: true, path: path.join(tmp, 'data', 'work', 'J1', '_preview') });
    assert.ok(path.isAbsolute(t.data.path));
    assert.equal(reveals.length, before, 'Finder was not asked');
    assert.equal((await req('POST', '/api/reveal', { body: { jobId: 'J1', what: 'truck', open: 'no' } })).status, 400);
    await req('POST', '/api/reveal', { body: { jobId: 'J1', what: 'truck', open: true } });
    assert.equal(reveals.length, before + 1, 'open:true reveals as before');
    const hub = await miniHub({ reveal: null });
    try {
      assert.equal((await hub.call('POST', '/api/reveal', { jobId: 'J1', what: 'truck' })).status, 503, 'no reveal: the default still needs Finder');
      const r = await hub.call('POST', '/api/reveal', { jobId: 'J1', what: 'truck', open: false });
      assert.deepEqual([r.status, r.data.ok, r.data.path], [200, true, path.join(tmp, 'data', 'work', 'J1', '_preview')]);
    } finally { await hub.close(); }
  });

  test('S6: an owner post body over 1900 chars is a clear 400; 1900 passes', async () => {
    const long = await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'INFO', body: 'x'.repeat(1901) } });
    assert.deepEqual([long.status, long.data.error], [400, 'The message is too long (1901 chars). Max 1900.']);
    const big = await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'INFO', body: 'y'.repeat(3000) } });
    assert.equal(big.data.error, 'The message is too long (3000 chars). Max 1900.');
    assert.equal((await req('POST', '/api/board', { body: { jobId: 'J1', kind: 'INFO', body: `  ${'z'.repeat(1900)}  ` } })).status, 200, 'the length counts after the trim');
  });

  test('S7: changes with reqId passes it on; an unknown reqId is a 404, a bad one a 400', async () => {
    const c = await req('POST', '/api/jobs/J1/changes', { body: { text: 'Add the missing test.', reqId: 'R1' } });
    assert.equal(c.status, 200);
    assert.equal(c.data.ok, true);
    assert.deepEqual(orch.calls.filter((x) => x[0] === 'requestChanges').at(-1)[2], { text: 'Add the missing test.', reqId: 'R1' });
    assert.equal((await req('POST', '/api/jobs/J1/changes', { body: { text: 'x', reqId: 'R7' } })).status, 404);
    assert.equal((await req('POST', '/api/jobs/J1/changes', { body: { text: 'x', reqId: 'T1' } })).status, 404);
    assert.equal((await req('POST', '/api/jobs/J1/changes', { body: { text: 'x', reqId: 5 } })).status, 400);
    const plain = await req('POST', '/api/jobs/J1/changes', { body: { text: 'Plain change.', reqId: null } });
    assert.equal(plain.status, 200);
    assert.deepEqual(orch.calls.filter((x) => x[0] === 'requestChanges').at(-1)[2], { text: 'Plain change.' });
  });
});
