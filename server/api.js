// Owner REST API (contract sections 6, 12b, 12c, 13b). Every route is a thin call into one module.
//
//   mountApi(http, deps) -> { events, close() }
//   deps: { store, board, orch, providers, secrets, settings, router, benchlm, git, toolkit, decider, runner, mcp,
//           pickFolder?, reveal?, log?, now?, version?, startedAt? }
//     settings     createSettings() result: { get, update }
//     pickFolder() -> Promise<string|null>   the native folder dialog (osascript); tests inject a fake
//     reveal(path) -> Promise                Finder; tests inject a fake
//
// http.js owns the guards (Host, Origin, X-WorkShop, the owner cookie on every /api route, the response
// headers) and POST /api/session. Errors here are { error: 'plain message' } with a 4xx status.

import { resolve as pathResolve } from 'node:path';
import { mountMcp } from './mcp.js';
import { KINDS as POST_KINDS } from './shoptalk.js';

const noop = () => {};
const JOB_RE = /^J[1-9][0-9]{0,8}$/;
const TASK_RE = /^T[1-9][0-9]{0,8}$/;
const AGENT_RE = /^A[1-9][0-9]{0,8}$/;
const PROJECT_RE = /^P[1-9][0-9]{0,8}$/;
const REQ_RE = /^R[1-9][0-9]{0,8}$/;
const DELIVERY_RE = /^D[1-9][0-9]{0,8}$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const SHA_RE = /^[0-9a-f]{4,64}$/i;
const JOB_KINDS = ['build', 'fix', 'research'];
const AUTH_LABS = ['claude', 'gemini', 'openai'];
const APIKEY_ONLY_LABS = ['claude', 'gemini'];
const OPENAI_MODES = ['apikey', 'subscription'];
const RETRY_MODELS = ['same', 'up', 'other_lab'];
const HUB_WRITTEN_SETTINGS = ['selfTest', 'authAck', 'providers'];
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const TR_RE = /^TR[1-9][0-9]{0,8}$/;
/** The longest body of an owner board post (POST /api/board). The UI caps its box at the same number. */
export const MAX_BOARD_BODY = 1900;
/** MOCK_SPEED of the demo job: the mock lab waits 5 times its base delays. */
export const DEMO_MOCK_SPEED = 5;

export function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** An optional string field: undefined or null gives null; anything else must be a string of at most max chars. */
function optText(body, key, max, label = key) {
  const v = body[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw httpError(400, `${label} must be text.`);
  const t = v.trim();
  if (t.length > max) throw httpError(400, `${label} is longer than ${max} characters.`);
  return t || null;
}

function needText(body, key, max, message) {
  const t = text(body[key]);
  if (!t) throw httpError(400, message);
  if (t.length > max) throw httpError(400, `${key} is longer than ${max} characters.`);
  return t;
}

function budgetOf(v, label = 'budgetUsd') {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e6) throw httpError(400, `${label} must be a number above 0.`);
  return n;
}

function crewOf(crew, presets) {
  if (crew === undefined || crew === null || crew === '') return undefined;
  if (typeof crew === 'string') {
    if (!presets || !Object.hasOwn(presets, crew)) throw httpError(400, `Unknown crew preset "${crew}". Use ${Object.keys(presets || {}).join(', ')}, or { bosses, managers, makers }.`);
    return crew;
  }
  if (!isObj(crew)) throw httpError(400, 'crew must be a preset name or { bosses, managers, makers }.');
  const out = {};
  // Office spots 0-2 and manager posts 0-2 (contract section 12, Crew); 8 bench spots.
  for (const [k, min, max] of [['bosses', 1, 3], ['managers', 0, 3], ['makers', 1, 8]]) {
    const n = Number(crew[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `crew.${k} must be a whole number from ${min} to ${max}.`);
    out[k] = n;
  }
  return out;
}

export function mountApi(http, deps) {
  const {
    store, board, orch, providers, secrets, settings, router, benchlm, git, toolkit, decider, runner, mcp,
    harnesses = null, roster = null, training = null, rlPort = null,
    pickFolder = null, reveal = null, log = noop, now = Date.now, version = '0.1.0', startedAt = Date.now(),
  } = deps;
  const say = typeof log === 'function' ? log : noop;
  const getSettings = () => (settings && typeof settings.get === 'function' ? settings.get() : {});

  // ---- lookups ----
  const needJob = (id) => {
    const job = typeof id === 'string' && JOB_RE.test(id) ? store.get('jobs', id) : null;
    if (!job) throw httpError(404, `Unknown job ${id}.`);
    return job;
  };
  const needTask = (id) => {
    const task = typeof id === 'string' && TASK_RE.test(id) ? store.get('tasks', id) : null;
    if (!task) throw httpError(404, `Unknown task ${id}.`);
    return task;
  };
  const needProject = (id) => {
    const p = typeof id === 'string' && PROJECT_RE.test(id) ? store.get('projects', id) : null;
    if (!p) throw httpError(404, `Unknown project ${id}.`);
    return p;
  };
  const needProvider = (id) => {
    const list = providers.list();
    const p = list.find((x) => x.id === id);
    if (!p) throw httpError(404, `Unknown lab ${id}.`);
    return p;
  };
  const jobNow = (id) => store.get('jobs', id);

  function inboxOf(jobId) {
    try {
      const list = orch.inbox(jobId || undefined);
      return Array.isArray(list) ? list : [];
    } catch (err) {
      say('warn', 'api: inbox failed', { error: err.message });
      return [];
    }
  }

  function models() {
    let leaders = null;
    try { leaders = router.leaders(); } catch (err) { say('warn', 'api: leaders failed', { error: err.message }); }
    return { registry: router.registry(), leaders };
  }

  async function refreshProviders() {
    try { if (typeof providers.refresh === 'function') await providers.refresh(); } catch (err) { say('warn', 'api: provider refresh failed', { error: err.message }); }
  }
  async function refreshDecider() {
    try { if (decider && typeof decider.refresh === 'function') await decider.refresh(); } catch { /* never fatal */ }
  }

  const route = (method, pattern, handler) => http.route(method, pattern, handler);

  // ---- state and events ----
  route('GET', '/api/state', () => ({
    seq: store.state.seq,
    state: store.state,
    providers: providers.list(),
    settings: getSettings(),
    board: board.history({ limit: 200 }),
    models: models(),
    inbox: inboxOf(null),
    harnesses: harnesses ? harnesses.list() : [],
    roster: roster ? roster.list() : [],
    requisitions: training ? training.list() : [],
    rlPort: rlPort ? rlPort.status() : null,
  }));

  // The heartbeat carries the seq that GET /api/health reports, so a page sees how far the hub is (S1).
  const events = http.sse('/api/events', { replay: (since) => store.eventsSince(since), heartbeat: () => ({ type: 'hb', seq: store.state.seq }) });
  const unsubscribe = store.subscribe((event) => events.send(event));

  route('GET', '/api/health', () => ({
    ok: true,
    version,
    pid: process.pid,
    uptimeMs: Math.max(0, now() - startedAt),
    seq: store.state.seq,
    jobs: store.list('jobs').length,
    activeJob: store.list('jobs', (j) => ['planning', 'plan_review', 'running', 'qa', 'delivering', 'paused'].includes(j.status)).map((j) => j.id)[0] ?? null,
    turns: typeof runner?.active === 'function' ? runner.active().length : 0,
    queued: typeof runner?.queued === 'function' ? runner.queued().length : 0,
    sse: events.count(),
    decider: decider ? { enabled: decider.enabled(), ...decider.stats(), ...(typeof decider.backend === 'function' ? { backend: decider.backend() } : {}) } : null,
  }));

  // ---- jobs ----
  route('GET', '/api/jobs', () => store.list('jobs').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));

  route('POST', '/api/jobs', async ({ body }) => {
    const title = needText(body, 'title', 200, 'The work order needs a title.');
    const brief = needText(body, 'brief', 50000, 'The work order needs a brief.');
    if (!JOB_KINDS.includes(body.kind)) throw httpError(400, 'Kind must be build, fix or research.');
    const p = body.project;
    if (!isObj(p) || !['new', 'existing'].includes(p.mode)) throw httpError(400, 'project.mode must be new or existing.');
    const project = { mode: p.mode };
    if (p.mode === 'new') {
      const name = optText(p, 'name', 80, 'The project name');
      if (name && !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)) throw httpError(400, 'Project name: letters, digits, space, dot, dash and underscore only.');
      if (name) project.name = name;
    } else {
      const path = optText(p, 'path', 4096, 'The project folder');
      if (!path || !path.startsWith('/')) throw httpError(400, 'Pick the folder of the existing project (a full path).');
      project.path = path;
      if (p.agentFilesAck !== undefined) project.agentFilesAck = p.agentFilesAck === true;
    }
    const s = getSettings();
    const crew = crewOf(body.crew, s.crewPresets);
    let options = {};
    if (body.options !== undefined && body.options !== null) {
      if (!isObj(body.options)) throw httpError(400, 'options must be an object.');
      options = { approvePlan: body.options.approvePlan === true, mock: body.options.mock === true };
    }
    const budgetUsd = budgetOf(body.budgetUsd);
    const billed = providers.list().some((x) => x.usable && x.mode === 'apikey');
    if (billed && budgetUsd === null && !options.mock) throw httpError(400, 'A lab bills per token (API key mode). Set a budget for this work order.');
    const order = { title, brief, kind: body.kind, project, crew: crew ?? s.defaultCrew, options };
    if (budgetUsd !== null) order.budgetUsd = budgetUsd;
    return orch.createJob(order);
  });

  route('POST', '/api/demo', async () => {
    const s = getSettings();
    const order = {
      title: 'Demo: Recipe Box web app',
      brief: 'Build a small recipe box web app: a list of recipes, a search box, and a form to add a recipe. Keep the data in one JSON file. Add tests.',
      kind: 'build',
      project: { mode: 'new', name: 'recipe-box-demo' },
      crew: s.crewPresets && s.crewPresets.standard ? 'standard' : s.defaultCrew,
      // The demo runs at its own slow pace, so the owner can watch the shop work (about 2 to 3 minutes).
      // settings.mockSpeed 0 (no pauses, as in the tests) keeps the demo fast too.
      options: { approvePlan: false, mock: true, mockSpeed: s.mockSpeed === 0 ? 0 : DEMO_MOCK_SPEED },
    };
    if (typeof s.budgetUsd === 'number' && s.budgetUsd > 0) order.budgetUsd = s.budgetUsd;
    return orch.createJob(order);
  });

  route('POST', '/api/jobs/:id/pause', async ({ params, body }) => {
    needJob(params.id);
    await orch.pauseJob(params.id, { hard: body.hard === true });
    return jobNow(params.id);
  });
  route('POST', '/api/jobs/:id/resume', async ({ params, body }) => {
    const job = needJob(params.id);
    const budgetUsd = budgetOf(body.budgetUsd);
    const billed = Number(job.cost?.billedUsd) || 0;
    if (job.status === 'paused' && job.pauseReason === 'budget' && !(budgetUsd > billed)) {
      throw httpError(400, `Set a budget above $${billed.toFixed(2)} to go on.`);
    }
    await orch.resumeJob(params.id, budgetUsd === null ? {} : { budgetUsd });
    return jobNow(params.id);
  });
  route('POST', '/api/jobs/:id/cancel', async ({ params }) => {
    needJob(params.id);
    await orch.cancelJob(params.id);
    return jobNow(params.id);
  });
  route('DELETE', '/api/jobs/:id', async ({ params }) => {
    const job = needJob(params.id);
    if (!['done', 'cancelled'].includes(job.status)) throw httpError(409, `${job.id} is ${job.status}. Only a done or cancelled job can be deleted.`);
    await orch.deleteJob(params.id);
    return { ok: true };
  });
  route('POST', '/api/jobs/:id/plan/approve', async ({ params }) => {
    const job = needJob(params.id);
    if (job.status !== 'plan_review') throw httpError(409, 'The plan is not waiting for approval.');
    await orch.approvePlan(params.id);
    return jobNow(params.id);
  });
  route('POST', '/api/jobs/:id/reqs', async ({ params, body }) => {
    const job = needJob(params.id);
    const t = needText(body, 'text', 2000, 'Write the requirement.');
    if (['queued', 'planning'].includes(job.status)) throw httpError(409, 'Add requirements after the plan is in (from plan review on).');
    return orch.addReq(params.id, { text: t });
  });
  route('POST', '/api/jobs/:id/reqs/:rid/waive', async ({ params, body }) => {
    const job = needJob(params.id);
    if (!REQ_RE.test(params.rid) || !(job.requirements || []).some((r) => r.id === params.rid)) throw httpError(404, `Unknown requirement ${params.rid}.`);
    const reason = needText(body, 'reason', 1000, 'Say why you waive it.');
    const out = await orch.waiveReq(params.id, params.rid, { reason });
    if (isObj(out) && out.id === params.rid) return out;
    return (jobNow(params.id)?.requirements || []).find((r) => r.id === params.rid) ?? { ok: true };
  });
  route('GET', '/api/jobs/:id/truck', async ({ params }) => {
    needJob(params.id);
    return orch.truck(params.id);
  });
  route('POST', '/api/jobs/:id/ship', async ({ params, body }) => {
    needJob(params.id);
    const sha = text(body.sha);
    if (!sha) throw httpError(400, 'Send { sha }: the commit the Truck panel showed.');
    if (!SHA_RE.test(sha)) throw httpError(400, 'sha must be a commit id (hex).');
    // { ok:false, reason } stays a 200: the panel reloads and says why (contract section 12, owner actions).
    return orch.ship(params.id, { sha: sha.toLowerCase() });
  });
  route('POST', '/api/jobs/:id/truck/discard', async ({ params }) => {
    const job = needJob(params.id);
    if (job.status !== 'cancelled') throw httpError(409, 'Only a cancelled job can discard its truck.');
    const out = await orch.discardTruck(params.id);
    return isObj(out) ? out : { ok: true };
  });
  route('POST', '/api/jobs/:id/changes', async ({ params, body }) => {
    needJob(params.id);
    const t = needText(body, 'text', 2000, 'Say what should change.');
    const req = { text: t };
    if (body.deliveryId !== undefined && body.deliveryId !== null && body.deliveryId !== '') {
      const d = typeof body.deliveryId === 'string' && DELIVERY_RE.test(body.deliveryId) ? store.get('deliveries', body.deliveryId) : null;
      if (!d || d.jobId !== params.id) throw httpError(404, `Unknown delivery ${body.deliveryId}.`);
      req.deliveryId = d.id;
    }
    // reqId ('Add task' on a requirement that no task serves, final wiring spec S7): a requirement of this job.
    if (body.reqId !== undefined && body.reqId !== null && body.reqId !== '') {
      if (typeof body.reqId !== 'string') throw httpError(400, 'reqId must be a requirement id, for example R2.');
      const known = REQ_RE.test(body.reqId) && (jobNow(params.id).requirements || []).some((r) => r.id === body.reqId);
      if (!known) throw httpError(404, `Unknown requirement ${body.reqId.slice(0, 40)} in ${params.id}.`);
      req.reqId = body.reqId;
    }
    const out = await orch.requestChanges(params.id, req);
    if (isObj(out) && isObj(out.req)) return { ok: true, ...out };
    if (isObj(out) && typeof out.id === 'string' && REQ_RE.test(out.id)) return { ok: true, req: out };
    return isObj(out) ? { ok: true, ...out } : { ok: true };
  });
  route('GET', '/api/jobs/:id/diff', async ({ params, query, text: send }) => {
    needJob(params.id);
    const opts = {};
    if (query.delivery) {
      const d = DELIVERY_RE.test(query.delivery) ? store.get('deliveries', query.delivery) : null;
      if (!d || d.jobId !== params.id) throw httpError(404, `Unknown delivery ${query.delivery}.`);
      opts.deliveryId = d.id;
    }
    if (query.path) {
      if (query.path.length > 4096 || query.path.includes('\0')) throw httpError(400, 'Bad path.');
      opts.path = query.path;
    }
    const out = await orch.diff(params.id, opts);
    send(200, typeof out === 'string' ? out : '', 'text/plain; charset=utf-8');
  });

  // ---- tasks ----
  route('POST', '/api/tasks/:id/stop', async ({ params, body }) => {
    needTask(params.id);
    const note = optText(body, 'note', 1000, 'The note');
    await orch.stopTask(params.id, note ? { note } : {});
    return store.get('tasks', params.id);
  });
  route('POST', '/api/tasks/:id/retry', async ({ params, body }) => {
    needTask(params.id);
    const note = optText(body, 'note', 1000, 'The note');
    const model = body.model === undefined || body.model === null || body.model === '' ? 'same' : body.model;
    if (!RETRY_MODELS.includes(model)) throw httpError(400, 'model must be same, up or other_lab.');
    await orch.retryTask(params.id, { ...(note ? { note } : {}), model });
    return store.get('tasks', params.id);
  });
  route('POST', '/api/tasks/:id/cancel', async ({ params, body }) => {
    const task = needTask(params.id);
    const reason = needText(body, 'reason', 1000, 'Say why you cancel the task.');
    let replacedBy;
    if (body.replacedBy !== undefined && body.replacedBy !== null) {
      if (!Array.isArray(body.replacedBy) || body.replacedBy.some((x) => typeof x !== 'string' || !TASK_RE.test(x))) throw httpError(400, 'replacedBy must be a list of task ids.');
      for (const x of body.replacedBy) {
        const other = store.get('tasks', x);
        if (!other || other.jobId !== task.jobId) throw httpError(404, `Unknown task ${x}.`);
      }
      replacedBy = body.replacedBy;
    }
    await orch.cancelTask(params.id, replacedBy ? { reason, replacedBy } : { reason });
    return store.get('tasks', params.id);
  });

  // ---- board, inbox, presence, agents ----
  route('GET', '/api/board', ({ query }) => {
    const opts = {};
    if (query.job) { if (!JOB_RE.test(query.job)) throw httpError(400, 'job must be a job id.'); opts.jobId = query.job; }
    if (query.since !== undefined && query.since !== '') {
      const n = Number(query.since);
      if (!Number.isFinite(n) || n < 0) throw httpError(400, 'since must be a number.');
      opts.since = n;
    }
    if (query.limit !== undefined && query.limit !== '') {
      const n = Number(query.limit);
      if (!Number.isInteger(n) || n < 1) throw httpError(400, 'limit must be a whole number above 0.');
      opts.limit = n;
    }
    return board.history(opts);
  });
  route('POST', '/api/board', async ({ body }) => {
    const job = needJob(text(body.jobId));
    const kind = text(body.kind).toUpperCase();
    if (!POST_KINDS.includes(kind)) throw httpError(400, `Unknown kind. Use one of: ${POST_KINDS.join(', ')}.`);
    const post = { jobId: job.id, kind };
    const to = optText(body, 'to', 40, 'to');
    if (to) { if (!/^@[A-Za-z0-9_-]{1,30}$/.test(to)) throw httpError(400, 'to must be one handle, for example @b1 or @boss.'); post.to = to; }
    const scope = optText(body, 'scope', 40, 'scope');
    if (scope) post.scope = scope;
    if (body.re !== undefined && body.re !== null && body.re !== '') {
      const re = Number(body.re);
      if (!Number.isInteger(re) || re < 1) throw httpError(400, 're must be a message id.');
      post.re = re;
    }
    if (body.slots !== undefined && body.slots !== null) {
      if (!isObj(body.slots)) throw httpError(400, 'slots must be an object.');
      const slots = {};
      for (const [k, v] of Object.entries(body.slots)) {
        if (!['ttl', 'why', 'tests', 'acc', 'default', 'conf'].includes(k)) throw httpError(400, `Unknown slot ${k}.`);
        if (v === null || v === undefined || v === '') continue;
        if (typeof v !== 'string' && typeof v !== 'number') throw httpError(400, `Slot ${k} must be text.`);
        slots[k] = String(v).slice(0, 40);
      }
      post.slots = slots;
    }
    const b = typeof body.body === 'string' ? body.body : body.body == null ? '' : null;
    if (b === null) throw httpError(400, 'body must be text.');
    // ShopTalk caps the whole owner post line at humanPostChars (2000): 1900 leaves room for the head (S6).
    const trimmed = b.trim();
    if (trimmed.length > MAX_BOARD_BODY) throw httpError(400, `The message is too long (${trimmed.length} chars). Max ${MAX_BOARD_BODY}.`);
    post.body = trimmed;
    const out = await orch.ownerPost(post);
    if (!out || out.ok === false) {
      const code = out?.code || 'E_HEAD';
      const hint = out?.hint || 'The board refused the post.';
      throw httpError(400, `${code}: ${hint}`);
    }
    return { ok: true, msg: out.msg };
  });
  route('GET', '/api/inbox', ({ query }) => {
    if (query.job && !JOB_RE.test(query.job)) throw httpError(400, 'job must be a job id.');
    return inboxOf(query.job || null);
  });
  route('PUT', '/api/presence', async ({ body }) => {
    if (!['here', 'away'].includes(body.state)) throw httpError(400, 'state must be here or away.');
    if (typeof orch.setPresence === 'function') await orch.setPresence(body.state);
    if (getSettings().presence !== body.state) settings.update({ presence: body.state });
    return { ok: true, presence: body.state };
  });
  route('GET', '/api/agents/:id/log', ({ params, query }) => {
    const agent = AGENT_RE.test(params.id) ? store.get('agents', params.id) : null;
    if (!agent) throw httpError(404, `Unknown agent ${params.id}.`);
    let n = 200;
    if (query.tail !== undefined && query.tail !== '') {
      n = Number(query.tail);
      if (!Number.isInteger(n) || n < 1) throw httpError(400, 'tail must be a whole number above 0.');
      n = Math.min(n, 2000);
    }
    return typeof runner?.logTail === 'function' ? runner.logTail(params.id, n) : [];
  });

  // ---- providers ----
  route('GET', '/api/providers', () => providers.list());
  route('POST', '/api/providers/detect', async () => providers.detect({ force: true }));
  route('PUT', '/api/providers/oss', async ({ body }) => {
    if (!isObj(body)) throw httpError(400, 'Send { engine?, baseUrl?, standIn? }.');
    const patch = {};
    if (body.engine !== undefined) patch.engine = body.engine;
    if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
    if (body.standIn !== undefined) patch.standIn = body.standIn;
    settings.update({ oss: patch });
    await providers.checkAuth('oss');
    return providers.status('oss');
  });
  route('PUT', '/api/providers/:id/mode', async ({ params, body }) => {
    needProvider(params.id);
    if (!AUTH_LABS.includes(params.id)) throw httpError(400, 'Only Frontier labs (claude, gemini, openai) take a sign-in mode.');
    if (APIKEY_ONLY_LABS.includes(params.id) && body.mode !== 'apikey') {
      throw httpError(400, 'Anthropic and Google forbid third-party subscription OAuth; Frontier labs claude and gemini use apikey only.');
    }
    if (params.id === 'openai' && !OPENAI_MODES.includes(body.mode)) {
      throw httpError(400, 'OpenAI mode must be "subscription" (Sign in with ChatGPT) or "apikey".');
    }
    settings.update({ auth: { [params.id]: body.mode }, authAck: { [params.id]: { mode: body.mode, ts: now() } } });
    await refreshProviders();
    return providers.status(params.id);
  });
  route('POST', '/api/providers/:id/login', async ({ params }) => {
    needProvider(params.id);
    return providers.openLogin(params.id);
  });
  route('POST', '/api/providers/:id/check', async ({ params }) => {
    needProvider(params.id);
    return providers.checkAuth(params.id);
  });
  route('POST', '/api/providers/:id/selftest', async ({ params }) => {
    needProvider(params.id);
    const r = await providers.selfTest(params.id);
    // The Keys panel shows logTail in one <pre>: send it as text.
    return isObj(r) ? { ...r, logTail: Array.isArray(r.logTail) ? r.logTail.join('\n') : String(r.logTail ?? '') } : r;
  });

  // ---- keys (never a value) ----
  const keyRow = (k) => ({ id: k.id, label: k.label, envVar: k.envVar, set: k.set === true, hint: k.hint ?? null, updatedAt: k.updatedAt ?? null });
  route('GET', '/api/keys', async () => (await secrets.list()).map(keyRow));
  route('PUT', '/api/keys/:id', async ({ params, body }) => {
    if (!KEY_RE.test(params.id)) throw httpError(400, 'Key id: letters, digits, dash and underscore only (at most 40).');
    if (typeof body.value !== 'string' || !body.value.trim()) throw httpError(400, 'The key is empty.');
    const opts = {};
    const label = optText(body, 'label', 80, 'The label');
    if (label) opts.label = label;
    const envVar = optText(body, 'envVar', 64, 'The env var');
    if (envVar) { if (!/^[A-Z_][A-Z0-9_]*$/.test(envVar)) throw httpError(400, 'Env var: capitals, digits and underscore only.'); opts.envVar = envVar; }
    await secrets.set(params.id, body.value.trim(), opts);
    await Promise.all([refreshProviders(), refreshDecider()]);
    const row = (await secrets.list()).find((k) => k.id === params.id);
    return row ? keyRow(row) : { id: params.id, set: true };
  });
  route('DELETE', '/api/keys/:id', async ({ params }) => {
    if (!KEY_RE.test(params.id)) throw httpError(404, `Unknown key ${params.id}.`);
    const known = (await secrets.list()).some((k) => k.id === params.id);
    if (!known) throw httpError(404, `Unknown key ${params.id}.`);
    const removed = await secrets.remove(params.id);
    await Promise.all([refreshProviders(), refreshDecider()]);
    return { ok: true, removed: removed === true };
  });

  // ---- settings and models ----
  route('GET', '/api/settings', () => getSettings());
  route('PUT', '/api/settings', async ({ body }) => {
    if (!isObj(body.patch)) throw httpError(400, 'Send { patch }.');
    const hubOwned = HUB_WRITTEN_SETTINGS.filter((k) => Object.hasOwn(body.patch, k));
    if (hubOwned.length) throw httpError(400, `${hubOwned.join(', ')} is written by the hub. Use the Keys panel (sign-in mode, Test).`);
    const next = settings.update(body.patch);
    await refreshProviders();
    return next;
  });
  route('GET', '/api/models', () => models());
  route('PUT', '/api/models', ({ body }) => {
    if (!isObj(body.registry)) throw httpError(400, 'Send { registry }.');
    try {
      router.save(body.registry);
    } catch (err) {
      if (!err.status) err.status = 400;
      throw err;
    }
    return models();
  });
  route('POST', '/api/models/refresh', async () => {
    if (!benchlm || typeof benchlm.refresh !== 'function') throw httpError(503, 'Benchmark refresh is not available.');
    const reg = router.registry();
    const r = (await benchlm.refresh(reg)) || {};
    if (r.changed) router.save(reg); // refresh() writes into the copy it was given
    const updated = Array.isArray(r.updated) ? r.updated.length : Number(r.updated) || 0;
    return { ok: r.ok !== false, changed: !!r.changed, updated, dataDate: r.dataDate ?? null, notModified: !!r.notModified, error: r.error ?? null, ...models() };
  });

  // ---- projects: toolkit, agent files ----
  route('GET', '/api/projects/:id/toolkit', async ({ params }) => {
    needProject(params.id);
    return toolkit.list(params.id);
  });
  route('PUT', '/api/projects/:id/toolkit', async ({ params, body }) => {
    needProject(params.id);
    if (!Array.isArray(body.tools)) throw httpError(400, 'Send { tools: [...] }.');
    return toolkit.save(params.id, body.tools);
  });
  route('POST', '/api/projects/:id/toolkit/:toolId/run', async ({ params }) => {
    needProject(params.id);
    return toolkit.run(params.id, params.toolId);
  });
  route('POST', '/api/projects/:id/agentfiles', async ({ params, body }) => {
    needProject(params.id);
    if (typeof body.ack !== 'boolean') throw httpError(400, 'Send { ack: true } or { ack: false }.');
    await orch.ackAgentFiles(params.id, body.ack);
    return store.get('projects', params.id);
  });

  // ---- folder dialog and Finder ----
  route('POST', '/api/pick-folder', async () => {
    if (typeof pickFolder !== 'function') throw httpError(503, 'The folder dialog is not available.');
    const chosen = await pickFolder();
    if (!chosen) return { path: null };
    try {
      const repo = await git.adoptProject({ path: String(chosen) });
      return { path: repo.path, targetBranch: repo.targetBranch, agentFiles: repo.agentFiles || [] };
    } catch (err) {
      throw httpError(400, err.message || 'That folder is not a git repository.');
    }
  });
  // The Mac app shows the folder dialog itself and sends only the path (final wiring spec S2). It reads the repo
  // and changes nothing. The answer has the shape of POST /api/pick-folder; a git error is a 400 with its words.
  route('POST', '/api/adopt-check', async ({ body }) => {
    const p = body.path;
    if (typeof p !== 'string' || !p.trim()) throw httpError(400, 'A project folder is required.');
    if (!p.startsWith('/') || p.length > 4096 || p.includes('\0')) throw httpError(400, 'The path must be absolute, at most 4096 characters, with no NUL.');
    try {
      const repo = await git.adoptProject({ path: p });
      return { path: repo.path, targetBranch: repo.targetBranch, agentFiles: repo.agentFiles || [] };
    } catch (err) {
      throw httpError(400, err.message || 'That folder is not a git repository.');
    }
  });
  // open:false (final wiring spec S3): make the _preview copy and answer its path, but do not open Finder. The Mac
  // app opens it. So open:false works also on a hub that has no reveal function.
  route('POST', '/api/reveal', async ({ body }) => {
    if (body.open !== undefined && typeof body.open !== 'boolean') throw httpError(400, 'open must be true or false.');
    const open = body.open !== false;
    if (open && typeof reveal !== 'function') throw httpError(503, 'Finder cannot be opened from this hub.');
    if (body.jobId !== undefined) {
      const job = needJob(body.jobId);
      if (body.what !== 'truck') throw httpError(400, 'what must be "truck".');
      const project = store.get('projects', job.projectId);
      if (!project) throw httpError(409, `${job.id} has no project yet.`);
      let sha = job.intSha || null;
      if (!sha) { try { sha = (await orch.truck(job.id))?.headSha || null; } catch { sha = null; } }
      if (!sha) throw httpError(409, 'The truck is empty.');
      const { dir } = await git.makeClone(project, job.id, '_preview', sha);
      const full = pathResolve(dir);
      if (open) await reveal(full);
      return { ok: true, path: full };
    }
    const project = needProject(body.projectId);
    if (open) await reveal(project.path);
    return { ok: true, path: project.path };
  });

  // ---- Harness Rack, Employee Book & Phase 1 RFT Requisitions ----
  const needRack = () => {
    if (!harnesses) throw httpError(503, 'Harness Rack is not initialized.');
    return harnesses;
  };
  const needRoster = () => {
    if (!roster) throw httpError(503, 'Employee Book is not initialized.');
    return roster;
  };
  const needTraining = () => {
    if (!training) throw httpError(503, 'RFT requisition queue is not initialized.');
    return training;
  };

  route('GET', '/api/harnesses', () => (harnesses ? harnesses.getRegistry() : { version: 1, harnesses: [] }));
  route('PUT', '/api/harnesses', ({ body }) => {
    const rack = needRack();
    const reg = isObj(body?.registry) ? body.registry : body;
    if (!isObj(reg)) throw httpError(400, 'Send { registry }.');
    return rack.save(reg);
  });
  route('POST', '/api/harnesses', ({ body }) => {
    const rack = needRack();
    const item = isObj(body?.harness) ? body.harness : body;
    if (!isObj(item)) throw httpError(400, 'Send a harness object.');
    return rack.upsert(item);
  });
  route('DELETE', '/api/harnesses/:id', ({ params }) => {
    if (!SLUG_RE.test(params.id)) throw httpError(400, 'Invalid harness id.');
    return needRack().remove(params.id);
  });

  route('GET', '/api/roster', () => (roster ? roster.list() : []));
  route('PUT', '/api/roster', ({ body }) => {
    const book = needRoster();
    const reg = isObj(body?.roster) ? body.roster : body;
    if (!isObj(reg)) throw httpError(400, 'Send { roster }.');
    return book.save(reg);
  });
  route('POST', '/api/roster', ({ body }) => {
    const book = needRoster();
    const item = isObj(body?.entry) ? body.entry : body;
    if (!isObj(item)) throw httpError(400, 'Send a roster entry object.');
    return book.upsert(item, { requireExistingOrCertified: true });
  });
  route('DELETE', '/api/roster/:id', ({ params }) => {
    if (!SLUG_RE.test(params.id)) throw httpError(400, 'Invalid roster id.');
    return needRoster().remove(params.id);
  });

  route('GET', '/api/requisitions', () => (training ? training.list() : []));
  route('POST', '/api/requisitions', ({ body }) => needTraining().createRequisition(isObj(body) ? body : {}));
  route('POST', '/api/training/forge', async ({ body }) => {
    const tr = needTraining();
    return tr.forge(isObj(body) ? body : {});
  });
  route('POST', '/api/requisitions/:id/start', async ({ params }) => {
    if (!TR_RE.test(params.id)) throw httpError(400, 'Invalid requisition id.');
    return needTraining().startRun(params.id);
  });
  route('POST', '/api/requisitions/:id/poll', async ({ params }) => {
    if (!TR_RE.test(params.id)) throw httpError(400, 'Invalid requisition id.');
    return needTraining().pollRun(params.id);
  });
  route('POST', '/api/requisitions/:id/cancel', async ({ params }) => {
    if (!TR_RE.test(params.id)) throw httpError(400, 'Invalid requisition id.');
    return needTraining().cancelRun(params.id);
  });
  route('POST', '/api/requisitions/:id/enroll', ({ params, body }) => {
    if (!TR_RE.test(params.id)) throw httpError(400, 'Invalid requisition id.');
    return needTraining().enroll(params.id, isObj(body) ? body : {});
  });
  route('POST', '/api/requisitions/:id/dismiss', ({ params }) => {
    if (!TR_RE.test(params.id)) throw httpError(400, 'Invalid requisition id.');
    return needTraining().dismiss(params.id);
  });

  // ---- Universal RL Compute Port ----
  route('GET', '/api/rl-port', () => (rlPort ? rlPort.status() : { ok: false, mode: 'local', detail: 'RL Compute Port not initialized.' }));
  route('PUT', '/api/rl-port', async ({ body }) => {
    if (!isObj(body)) throw httpError(400, 'Send { mode?, localUrl?, remoteUrl?, providerHint? }.');
    const patch = {};
    if (body.mode !== undefined) patch.mode = body.mode;
    if (body.localUrl !== undefined) patch.localUrl = body.localUrl;
    if (body.remoteUrl !== undefined) patch.remoteUrl = body.remoteUrl;
    if (body.providerHint !== undefined) patch.providerHint = body.providerHint;
    if (Object.keys(patch).length > 0) settings.update({ rlPort: patch });
    if (rlPort) return rlPort.probe();
    return { ok: true, rlPort: settings.get().rlPort };
  });
  route('POST', '/api/rl-port/probe', async () => {
    if (!rlPort) throw httpError(503, 'RL Compute Port is not initialized.');
    return rlPort.probe();
  });

  // ---- agents (MCP) ----
  if (mcp) mountMcp(http, mcp, { log: say });

  return {
    events,
    close() { unsubscribe(); },
  };
}
