// The UI against the answers of the real hub (server/api.js, server/orch/owner.js, server/board.js), not the stub.
// Pure parts only: selectors, the view model, the client store with a fake EventSource, and the bridge to the Mac app.
// Run: node --test tests/ui-stub/realhub.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sel } from '../../ui/lib/selectors.js';
import { buildVM, deliveryStage, createShipCounter } from '../../ui/lib/vm.js';
import { createNative } from '../../ui/lib/native.js';

// ------------------------------------------------------------------ a fake store for the selectors

function fakeStore({ jobs = [], tasks = [], agents = [], deliveries = [], projects = [], board = [], inbox = [], providers = [], settings = {} }) {
  const data = { jobs, tasks, agents, deliveries, projects };
  return {
    board, inbox, providers, settings, boardSeenId: 0,
    get: (kind, id) => data[kind].find((x) => x.id === id) || null,
    list: (kind, f) => (f ? data[kind].filter(f) : data[kind]),
    msg: (id) => board.find((m) => m.id === Number(id)) || null,
  };
}
const job = (id, status, extra = {}) => ({ id, title: 'Job ' + id, status, createdAt: Number(id.slice(1)), requirements: [], ...extra });

test('a deleted job (the row stays with deleted:true) is never the job on the floor and waits for nothing', () => {
  const store = fakeStore({ jobs: [job('J1', 'done'), job('J2', 'cancelled', { deleted: true, createdAt: 9 })] });
  assert.equal(sel.activeJob(store).id, 'J1', 'the newest job that is not deleted');
  assert.deepEqual(sel.jobs(store).map((j) => j.id), ['J1']);
  const gone = fakeStore({ jobs: [job('J1', 'done', { deleted: true })] });
  assert.equal(sel.activeJob(gone), null);
  assert.deepEqual(sel.inboxItems(gone), []);
  assert.equal(sel.ownerAttention(gone).any, false);
});

test('inbox items in the shape of the real hub: plain ids plus msgId, reqId, projectId and provider', () => {
  const ask = { id: 23, ts: 5, jobId: 'J1', from: '@b1', fromId: 'A1', kind: 'ASK', to: '@human', body: 'Which output form? A) Plain text B) JSON', slots: { default: 'A' }, state: 'open', defaulted: false };
  const done = { id: 40, ts: 6, jobId: 'J1', kind: 'DONE', from: '@m1', fromId: 'A5', state: 'open', body: 'done' };
  const store = fakeStore({
    jobs: [job('J1', 'running', { requirements: [{ id: 'R2', text: 'Search box', status: 'open', source: 'owner' }] })],
    agents: [{ id: 'A5', jobId: 'J1', role: 'maker', status: 'working', provider: 'claude' }],
    deliveries: [{ id: 'D3', jobId: 'J1', taskId: 'T1', makerId: 'A5', status: 'review', doneMsgId: null }],
    projects: [{ id: 'P1', name: 'repo', agentFiles: ['AGENTS.md'], agentFilesAck: false }],
    providers: [{ id: 'claude', label: 'Claude Code', usable: false, auth: 'none', reason: 'Claude Code is signed out.', installed: true, mode: 'subscription' }],
    board: [done],
    inbox: [
      { kind: 'question', id: 23, jobId: 'J1', text: 'Which output form?', since: 5, options: [{ key: 'A', text: 'Plain text' }, { key: 'B', text: 'JSON' }], default: 'A', defaulted: false, msgId: 23, from: '@b1' },
      { kind: 'review', id: 'D3', jobId: 'J1', text: 'T1 waits for your verdict: PASS re:40 or FIX re:40.', since: 6, msgId: 40 },
      { kind: 'requirement', id: 'R2', jobId: 'J1', text: 'R2 has no task: Search box', since: 7, reqId: 'R2', options: [{ key: 'waive', text: 'Waive' }] },
      { kind: 'agentfiles', id: 'P1', jobId: 'J1', text: 'The repo holds agent files.', since: 8, projectId: 'P1' },
      { kind: 'signin', id: 'claude', jobId: 'J1', text: 'Claude Code: signed out', since: 9, provider: 'claude' },
    ],
  });
  const items = sel.inboxItems(store);
  const by = (kind) => items.find((it) => it.kind === kind);
  const q = by('question');
  assert.equal(q.q.from, '@b1', 'the asker comes from the item when the post is not in this window');
  assert.deepEqual(q.q.options.map((o) => o.key), ['A', 'B']);
  assert.equal(q.q.text, 'Which output form?');
  const r = by('review');
  assert.equal(r.delivery.id, 'D3');
  assert.equal(r.doneId, 40, 'the verdict answers the DONE post that msgId names');
  assert.equal(by('requirement').req.text, 'Search box', 'an OPEN requirement with an owner notice is listed too');
  assert.equal(by('agentfiles').project.id, 'P1');
  const s = by('signin');
  assert.equal(s.lab.id, 'claude');
  assert.equal(s.quiet, false, 'the hub lists a lab only when work of a live job waits for it: it rings');
  assert.equal(sel.ownerAttention(store).count, 5);
});

test('a review item that the owner settled leaves at once; so does a requirement that was waived', () => {
  const store = fakeStore({
    jobs: [job('J1', 'running', { requirements: [{ id: 'R2', text: 'x', status: 'waived' }] })],
    deliveries: [{ id: 'D3', jobId: 'J1', taskId: 'T1', status: 'approved' }],
    inbox: [{ kind: 'review', id: 'D3', jobId: 'J1', msgId: 40, since: 1 }, { kind: 'requirement', id: 'R2', reqId: 'R2', jobId: 'J1', since: 2 }],
  });
  assert.deepEqual(sel.inboxItems(store), []);
});

// ------------------------------------------------------------------ view model

test('a discarded crate, and a rejected crate of a job that is over, leave the floor', () => {
  const store = fakeStore({ jobs: [job('J1', 'cancelled')], deliveries: [] });
  assert.equal(deliveryStage(store, { id: 'D1', jobId: 'J1', status: 'rejected', discarded: true }), null);
  assert.equal(deliveryStage(store, { id: 'D2', jobId: 'J1', status: 'rejected' }), null);
  const live = fakeStore({ jobs: [job('J1', 'running')] });
  assert.equal(deliveryStage(live, { id: 'D2', jobId: 'J1', status: 'rejected' }), 'rejected', 'a live job still shows a rejected crate');
});

test('a docked truck after the last ship holds no crate (contract section 13)', () => {
  const store = fakeStore({ jobs: [job('J1', 'done')], deliveries: [{ id: 'D1', jobId: 'J1', taskId: 'T1', status: 'shipped' }, { id: 'D2', jobId: 'J1', taskId: 'T2', status: 'shipped' }] });
  assert.deepEqual(buildVM(store).truck, { state: 'docked', crates: 0 });
});

test('the ship count comes from the deliveries that turned shipped (fx ship carries only jobId and sha)', () => {
  let t = 1000;
  const c = createShipCounter({ now: () => t });
  c.seen({ status: 'loaded' }, { jobId: 'J1', status: 'shipped' });
  c.seen({ status: 'loaded' }, { jobId: 'J1', status: 'shipped' });
  c.seen({ status: 'approved' }, { jobId: 'J1', status: 'loaded' });
  c.seen(null, { jobId: 'J1', status: 'shipped' }); // a row that arrived shipped (a reload) does not count
  c.seen({ status: 'loaded' }, { jobId: 'J2', status: 'shipped' });
  assert.equal(c.take('J1'), 2);
  assert.equal(c.take('J1'), 0, 'taken once');
  t += 60000;
  assert.equal(c.take('J2'), 0, 'an old ship does not count for a new fx');
});

test('a queued job says why it waits when the hub gives a reason', () => {
  const store = fakeStore({ jobs: [job('J1', 'queued', { waitReason: 'No usable lab for a boss.' })] });
  assert.equal(buildVM(store).shop.statusLine, 'Queued: No usable lab for a boss.');
});

// ------------------------------------------------------------------ the bridge to the Mac app

function fakeBridge(answer = (msg) => ({ ok: true })) {
  const sent = [];
  const win = { webkit: { messageHandlers: { workshop: { postMessage: (msg) => { sent.push(msg); return Promise.resolve(answer(msg)); } } } } };
  return { win, sent };
}

test('native: in a plain browser every call is a no-op', async () => {
  const n = createNative({ win: {} });
  assert.equal(n.available, false);
  assert.equal(await n.notify('Hi'), null);
  assert.equal(await n.badge(3), null);
  assert.equal(await n.quitState(true), null);
  assert.equal(await n.pickFolder(), null, 'null: use POST /api/pick-folder');
  assert.equal(await n.reveal('/Users/x/WorkShop/projects/a'), false, 'false: use POST /api/reveal');
  assert.equal(createNative({ win: null }).available, false);
});

test('native: messages in the shape of the launcher contract', async () => {
  const { win, sent } = fakeBridge((m) => (m.type === 'pickFolder' ? { ok: true, path: '/Users/x/Code/repo' } : m.type === 'notify' ? { ok: true, shown: true } : { ok: true }));
  const n = createNative({ win });
  assert.equal(n.available, true);
  assert.deepEqual(await n.notify('WorkShop: J1', 'Boss Cobalt asks a question.'), { ok: true, shown: true });
  await n.badge(2); await n.badge(2); await n.badge(0);
  await n.quitState(true); await n.quitState(true); await n.quitState(false);
  assert.deepEqual(await n.pickFolder(), { path: '/Users/x/Code/repo' });
  assert.equal(await n.reveal('/Users/x/WorkShop/projects/a'), true);
  assert.equal(await n.reveal('relative/path'), false, 'only an absolute path goes to the app');
  assert.deepEqual(sent, [
    { type: 'notify', title: 'WorkShop: J1', body: 'Boss Cobalt asks a question.' },
    { type: 'badge', count: 2 }, { type: 'badge', count: 0 },
    { type: 'quitState', live: true }, { type: 'quitState', live: false },
    { type: 'pickFolder' },
    { type: 'reveal', path: '/Users/x/WorkShop/projects/a' },
  ], 'the same badge or quit state twice goes out once');
});

test('native: a failing bridge never throws; a cancelled dialog gives path null', async () => {
  const win = { webkit: { messageHandlers: { workshop: { postMessage: () => Promise.reject(new Error('gone')) } } } };
  const n = createNative({ win });
  assert.equal(await n.notify('x'), null);
  assert.equal(await n.badge(1), null);
  assert.equal(await n.pickFolder(), null);
  assert.equal(await n.reveal('/a'), false);
  const cancel = createNative(fakeBridge(() => ({ ok: true, path: null })));
  assert.deepEqual(await cancel.pickFolder(), { path: null });
  const none = createNative(fakeBridge(() => undefined)); // a handler with no reply
  assert.deepEqual(await none.notify('x'), { ok: true });
  const refused = createNative(fakeBridge(() => ({ ok: false, error: 'outside the WorkShop folder' })));
  assert.equal(await refused.reveal('/etc'), false);
  assert.equal(await refused.pickFolder(), null);
});

test('native: long notification text is cut, an empty title sends nothing', async () => {
  const { win, sent } = fakeBridge();
  const n = createNative({ win });
  assert.equal(await n.notify('   '), null);
  await n.notify('T', 'x'.repeat(1000));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.length <= 400 && sent[0].body.endsWith('...'));
});

// ------------------------------------------------------------------ the client store with a fake stream

/** Browser globals for ui/lib/store.js. Returns the fake EventSource class (FakeES.last = the newest stream). */
function browserGlobals() {
  const listeners = {};
  globalThis.location = { search: '', hash: '', pathname: '/' };
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.window = { addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); }, fire(type) { for (const fn of listeners[type] || []) fn(); } };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
  class FakeES {
    constructor(url) { this.url = url; this.closed = false; FakeES.all.push(this); FakeES.last = this; }
    addEventListener() {}
    close() { this.closed = true; }
    send(evt) { this.onmessage({ data: JSON.stringify(evt) }); }
  }
  FakeES.all = [];
  globalThis.EventSource = FakeES;
  return FakeES;
}

function fakeApi(state, extra = {}) {
  const calls = [];
  return {
    calls,
    async get(path, opts = {}) {
      calls.push(path);
      if (path === '/api/state') return structuredClone(state());
      if (path === '/api/inbox') return [];
      if (path === '/api/health' && extra.health) { const h = extra.health(); if (h instanceof Error) { if (opts.throws) throw h; return undefined; } return h; }
      return undefined;
    },
    async post() { return {}; },
    async put() { return {}; },
  };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('store: a board patch event replaces the item and never adds it as a new post', async () => {
  const ES = browserGlobals();
  const { createStore } = await import('../../ui/lib/store.js');
  const ask = { id: 5, kind: 'ASK', to: '@b1', from: '@m1', state: 'open', body: 'Which? ' };
  const api = fakeApi(() => ({ seq: 10, state: { jobs: { J1: job('J1', 'running') } }, board: [ask], providers: [], settings: {}, inbox: [] }));
  const store = createStore({ api, watch: { silentMs: 0, everyMs: 0 } });
  const fresh = [], changed = [];
  store.on('board', (m) => fresh.push(m.id));
  store.on('boardchange', (list) => changed.push(...list.map((m) => m.id)));
  await store.connect();
  assert.equal(ES.last.url, '/api/events?since=10');
  ES.last.send({ type: 'board', seq: 11, msg: { ...ask, state: 'answered' }, changed: [{ ...ask, state: 'answered' }], patch: true });
  assert.equal(store.msg(5).state, 'answered');
  // an item older than what the window holds: a patch of it is not a new post
  ES.last.send({ type: 'board', seq: 12, msg: { id: 2, kind: 'INFO', state: 'expired' }, changed: [{ id: 2, kind: 'INFO', state: 'expired' }], patch: true });
  assert.equal(store.msg(2), null);
  ES.last.send({ type: 'board', seq: 13, msg: { id: 6, kind: 'INFO', from: '@b1', body: 'new' } });
  assert.deepEqual(fresh, [6], 'only the real post fires "board"');
  assert.deepEqual(changed, [5]);
  assert.deepEqual(store.board.map((m) => m.id), [5, 6]);
  store.stop();
});

test('store: a deleted job keeps its row (upsert with deleted:true), and its rows go with remove events', async () => {
  const ES = browserGlobals();
  const { createStore } = await import('../../ui/lib/store.js');
  const api = fakeApi(() => ({ seq: 1, state: { jobs: { J1: job('J1', 'done') }, tasks: { T1: { id: 'T1', jobId: 'J1', status: 'merged' } }, agents: {}, deliveries: { D1: { id: 'D1', jobId: 'J1', status: 'shipped' } }, projects: {} }, board: [], providers: [], settings: {}, inbox: [] }));
  const store = createStore({ api, watch: { silentMs: 0, everyMs: 0 } });
  await store.connect();
  ES.last.send({ type: 'remove', seq: 2, kind: 'tasks', id: 'T1' });
  ES.last.send({ type: 'remove', seq: 3, kind: 'deliveries', id: 'D1' });
  ES.last.send({ type: 'upsert', seq: 4, kind: 'jobs', item: job('J1', 'done', { deleted: true }) });
  assert.equal(store.list('tasks').length, 0);
  assert.equal(store.list('deliveries').length, 0);
  assert.equal(store.get('jobs', 'J1').deleted, true, 'the row stays: the jobs list shows it as deleted');
  assert.equal(sel.activeJob(store), null);
  store.stop();
});

test('store: the watchdog opens a new stream from the last seq when the hub is ahead and the stream stays silent', async () => {
  const ES = browserGlobals();
  const { createStore } = await import('../../ui/lib/store.js');
  let hubSeq = 20;
  const api = fakeApi(() => ({ seq: 20, state: {}, board: [], providers: [], settings: {}, inbox: [] }), { health: () => ({ ok: true, seq: hubSeq }) });
  const store = createStore({ api, watch: { silentMs: 1, everyMs: 15 } });
  await store.connect();
  const first = ES.last;
  await tick(40);
  assert.equal(ES.last, first, 'a quiet hub at the same seq: the stream stays');
  hubSeq = 25; // events went out that this stream never delivered
  await tick(60);
  assert.notEqual(ES.last, first, 'a new stream');
  assert.equal(first.closed, true);
  assert.equal(ES.last.url, '/api/events?since=20');
  assert.equal(api.calls.filter((p) => p === '/api/state').length, 1, 'the state is not loaded again: the hub replays from the seq');
  store.stop();
});

test('store: a stream that delivers keeps the watchdog quiet; a lower hub seq loads the state of the new hub run', async () => {
  const ES = browserGlobals();
  const { createStore } = await import('../../ui/lib/store.js');
  let hubSeq = 20, seq = 20;
  const api = fakeApi(() => ({ seq, state: {}, board: [], providers: [], settings: {}, inbox: [] }), { health: () => ({ ok: true, seq: hubSeq }) });
  const store = createStore({ api, watch: { silentMs: 1, everyMs: 15 } });
  await store.connect();
  const first = ES.last;
  hubSeq = 21;
  first.send({ type: 'fx', seq: 21, name: 'note', payload: {} }); // it arrives: store.seq reaches the hub
  await tick(50);
  assert.equal(ES.last, first);
  hubSeq = 3; seq = 3; // the hub restarted
  await tick(60);
  assert.ok(api.calls.filter((p) => p === '/api/state').length >= 2, 'the state of the new run is loaded');
  assert.equal(store.seq, 3);
  store.stop();
});

test('store: "workshop:resume" from the Mac app loads the state again and opens a new stream', async () => {
  const ES = browserGlobals();
  const { createStore } = await import('../../ui/lib/store.js');
  const api = fakeApi(() => ({ seq: 7, state: {}, board: [], providers: [], settings: {}, inbox: [] }));
  const store = createStore({ api, watch: { silentMs: 0, everyMs: 0 } });
  await store.connect();
  const first = ES.last;
  globalThis.window.fire('workshop:resume');
  await tick(20);
  assert.notEqual(ES.last, first);
  assert.equal(first.closed, true);
  assert.equal(api.calls.filter((p) => p === '/api/state').length, 2);
  store.stop();
});

test('store: with no "#k=" in the address the store starts from the cookie alone', async () => {
  browserGlobals();
  const { createStore } = await import('../../ui/lib/store.js');
  const posts = [];
  const api = fakeApi(() => ({ seq: 1, state: {}, board: [], providers: [], settings: {}, inbox: [] }));
  api.post = async (path) => { posts.push(path); return {}; };
  const store = createStore({ api, watch: { silentMs: 0, everyMs: 0 } });
  await store.connect();
  assert.deepEqual(posts, [], 'no POST /api/session without a key in the address');
  assert.equal(store.conn, 'online');
  store.stop();
});

// Live QA: a locked page asked GET /api/state every 5 s forever (one hub log line each), and a new "#k=" on the same
// address (the Mac app after a hub restart) changed nothing, because WebKit does not load a page again for a new fragment.
test('store: a locked page does not ask on a timer; focus or a new #k= in the address asks again', async () => {
  browserGlobals();
  const { createStore } = await import('../../ui/lib/store.js');
  let locked = true;
  const posts = [];
  const api = fakeApi(() => ({ seq: 4, state: {}, board: [], providers: [], settings: {}, inbox: [] }));
  const get = api.get;
  api.get = async (path, opts) => { if (path === '/api/state' && locked) { api.calls.push(path); const e = new Error('owner session required'); e.status = 401; throw e; } return get(path, opts); };
  api.post = async (path, body) => { posts.push([path, body.k]); return {}; };
  const store = createStore({ api, watch: { silentMs: 0, everyMs: 0 } });
  await store.connect();
  assert.equal(store.conn, 'locked');
  const asked = () => api.calls.filter((p) => p === '/api/state').length;
  await tick(60);
  assert.equal(asked(), 1, 'no timer asks again');
  globalThis.window.fire('focus');
  await tick(10);
  assert.equal(asked(), 2, 'the owner came back to the window: ask once');
  globalThis.window.fire('focus');
  await tick(10);
  assert.equal(asked(), 2, 'at most once every 2 s');
  locked = false;
  globalThis.location.hash = '#k=newkey';
  globalThis.window.fire('hashchange');
  await tick(20);
  assert.deepEqual(posts, [['/api/session', 'newkey']], 'the new key is posted');
  assert.equal(store.conn, 'online');
  store.stop();
});
