// The stub hub and the pure parts of the UI together: what the UI relies on in the answers of a hub.
// The stub does here what the hub on disk does where the contract leaves something open (see the header of server.mjs).
// This file starts tests/ui-stub/server.mjs on a free port (--port 0) and stops it at the end. No browser, no fixed port.
// Run: node --test tests/ui-stub/stub.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sel } from '../../ui/lib/selectors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let child = null, base = '';

before(async () => {
  // --child: the stub stops by itself when this process ends, also when it is killed (its stdin is our pipe)
  child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', '0', '--scenario', 'empty', '--child'], { stdio: ['pipe', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('The stub hub did not start in 10 s.')), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /WORKSHOP_STUB_READY (http:\/\/127\.0\.0\.1:\d+)\//.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`The stub hub ended with code ${code}.`)); });
  });
});
after(() => { if (child) child.kill(); });

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: method === 'GET' ? {} : { 'X-WorkShop': '1', 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, data };
}
const get = async (url) => (await call('GET', url)).data;
const post = (url, body) => call('POST', url, body);
const stub = (cmd) => get('/__stub/' + cmd);
/** GET /api/state as a store that the selectors of the UI read (the shape of ui/lib/store.js, without events). */
async function loadStore() {
  const data = await get('/api/state');
  const rows = Object.fromEntries(['projects', 'jobs', 'tasks', 'agents', 'deliveries'].map((k) => [k, Object.values(data.state[k])]));
  return {
    board: data.board, inbox: data.inbox, providers: data.providers, settings: data.settings, boardSeenId: 0,
    get: (kind, id) => rows[kind].find((x) => x.id === id) || null,
    list: (kind, f) => (f ? rows[kind].filter(f) : rows[kind]),
    msg: (id) => data.board.find((m) => m.id === Number(id)) || null,
  };
}
const ids = (list) => list.map((d) => d.id);
const num = (id) => Number(String(id).slice(1));

test('the truck answer lists the crates by id; the UI numbers them by merge order, and "Ship up to here" ships exactly those', async () => {
  await stub('goto/truck');
  const store = await loadStore();
  const truck = await get('/api/jobs/J1/truck');
  const answer = ids(truck.deliveries);
  assert.deepEqual(answer, answer.slice().sort((a, b) => num(a) - num(b)), 'the hub sorts the deliveries of its truck answer by id (the order of the hand-ins)');
  const crates = sel.loadedDeliveries(store, 'J1'); // what the Truck panel draws: crate 1, crate 2, ...
  assert.equal(crates.length, 11);
  assert.deepEqual(ids(sel.loadOrder(truck.deliveries)), ids(crates), 'the store and the truck answer give the same load order');
  assert.notDeepEqual(ids(crates), answer, 'the script holds a slow review, so the load order differs from the id order (else this test proves nothing)');
  // the first crate number where "crates 1 to n" by id is another set than by merge order
  const n = crates.findIndex((d, i) => ids(crates.slice(0, i + 1)).sort().join() !== answer.slice(0, i + 1).sort().join()) + 1;
  assert.ok(n > 0 && n < crates.length, `a crate number where the two orders name other crates (found ${n})`);
  const upTo = crates.slice(0, n);
  const res = await post('/api/jobs/J1/ship', { sha: crates[n - 1].mergeSha });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.ok, res.data.left], [true, crates.length - n]);
  const now = await loadStore();
  assert.deepEqual(ids(now.list('deliveries', (d) => d.status === 'shipped')).sort(), ids(upTo).sort(), '"Ship up to here" on crate n shipped crates 1 to n of the UI, no other crate');
  assert.deepEqual(ids(sel.loadedDeliveries(now, 'J1')), ids(crates.slice(n)), 'the crates after it stay loaded, in the same order');
  // "Approve & ship all" sends the head of the answer: every crate of that answer ships
  const rest = await get('/api/jobs/J1/truck');
  const all = await post('/api/jobs/J1/ship', { sha: rest.headSha });
  assert.deepEqual([all.data.ok, all.data.left], [true, 0]);
  assert.equal((await loadStore()).get('jobs', 'J1').status, 'done');
});

test('a cancelled job keeps its truck while a newer job runs: ship it, or discard it', async () => {
  await stub('goto/stranded');
  let store = await loadStore();
  assert.deepEqual(store.list('jobs').map((j) => `${j.id}:${j.status}`), ['J1:cancelled', 'J2:running']);
  assert.equal(sel.activeJob(store).id, 'J2');
  assert.deepEqual(sel.trucks(store).map((t) => `${t.job.id}:${t.n}:${t.waits}`), ['J2:2:false', 'J1:3:true']);
  assert.equal(sel.truckJob(store).id, 'J1', 'the Truck button stands for the truck that waits for the owner');
  const item = sel.inboxItems(store).find((it) => it.kind === 'truck');
  assert.deepEqual([item.jobId, item.quiet], ['J1', false], 'the inbox item names the job of the truck');
  const t1 = await get('/api/jobs/J1/truck');
  assert.equal(t1.deliveries.length, 3);
  const shipped = await post('/api/jobs/J1/ship', { sha: t1.headSha });
  assert.deepEqual([shipped.status, shipped.data.ok, shipped.data.left], [200, true, 0]);
  store = await loadStore();
  assert.equal(sel.truckJob(store).id, 'J2', 'nothing waits any more: the button follows the job on the floor');
  assert.equal(sel.inboxItems(store).some((it) => it.kind === 'truck'), false);

  await stub('goto/stranded');
  const gone = await post('/api/jobs/J1/truck/discard');
  assert.deepEqual([gone.status, gone.data], [200, { ok: true }], 'the hub answers { ok:true } only');
  store = await loadStore();
  assert.deepEqual(sel.trucks(store).map((t) => t.job.id), ['J2']);
  const dropped = store.list('deliveries', (d) => d.jobId === 'J1' && d.discarded);
  assert.equal(dropped.length, 3, 'the delivery rows stay, marked discarded');
  assert.ok(dropped.every((d) => d.status === 'rejected'));
  assert.equal(store.get('jobs', 'J1').truckKept, false);
  assert.equal(sel.loadedDeliveries(store, 'J2').length, 2, 'the truck of the job on the floor is not touched');
});

test('a requirement that no task serves is in the inbox when it is open, until the owner settles it', async () => {
  await stub('goto/running');
  await stub('reqopen');
  let store = await loadStore();
  const raw = store.inbox.find((it) => it.kind === 'requirement');
  assert.ok(raw, 'the hub lists it');
  const req = store.get('jobs', 'J1').requirements.find((r) => r.id === raw.id);
  assert.equal(req.status, 'open');
  const item = sel.inboxItems(store).find((it) => it.kind === 'requirement');
  assert.deepEqual([item.id, item.req.status, item.quiet], [raw.id, 'open', false], 'the UI keeps the item of an open requirement, and it rings');
  assert.equal(sel.ownerAttention(store).panels.blueprint, 1);
  const waived = await post(`/api/jobs/J1/reqs/${raw.id}/waive`, { reason: 'Not needed now.' });
  assert.equal(waived.status, 200);
  store = await loadStore();
  assert.equal(sel.inboxItems(store).some((it) => it.kind === 'requirement'), false, 'waived: the item is gone');
});

test('API key mode is enforced for Frontier providers and OSS runtime routes work', async () => {
  await stub('goto/empty');
  await stub('lab/gemini/installed');
  assert.equal((await call('PUT', '/api/providers/gemini/mode', { mode: 'subscription' })).status, 400);
  assert.equal((await post('/api/providers/gemini/login')).status, 400);
  assert.equal((await call('PUT', '/api/providers/gemini/mode', { mode: 'apikey' })).status, 200);
  await call('PUT', '/api/keys/gemini', { value: 'sk-gem-test-9999' });
  const checked = await post('/api/providers/gemini/check');
  assert.deepEqual([checked.status, checked.data.keySet], [200, true]);
  const p = (await loadStore()).providers.find((x) => x.id === 'gemini');
  assert.equal(sel.labStep(p, { safety: 'sandboxed' }), 'test', 'the next step after API key is the self-test');

  const oss = await call('PUT', '/api/providers/oss', { engine: 'ollama', standIn: true });
  assert.equal(oss.status, 200);
  assert.equal(oss.data.usable, true);

  const st = await get('/api/state');
  assert.ok(Array.isArray(st.harnesses) && st.harnesses.length >= 7);
  assert.ok(Array.isArray(st.roster) && st.roster.length >= 7);
  assert.ok(Array.isArray(st.requisitions) && st.requisitions.length >= 1);
  const enrolled = await post(`/api/requisitions/${st.requisitions[0].id}/enroll`, { name: 'Euler' });
  assert.equal(enrolled.status, 200);
  assert.equal(enrolled.data.requisition.status, 'enrolled');
});

test('a job that waits in the queue has no project yet', async () => {
  await stub('goto/running');
  const made = await post('/api/jobs', { title: 'Second order', brief: 'Wait behind the first.', kind: 'build', project: { mode: 'new', name: 'second' }, crew: 'standard', budgetUsd: 5 });
  assert.deepEqual([made.status, made.data.status, made.data.projectId], [200, 'queued', null]);
  const reveal = await post('/api/reveal', { projectId: made.data.projectId });
  assert.equal(reveal.status, 404, 'so there is nothing to reveal: the UI shows no Reveal link for it');
  // the job comes on the floor when the first one is cancelled: now it has its project
  await post('/api/jobs/J1/cancel');
  const store = await loadStore();
  const job = store.get('jobs', made.data.id);
  assert.equal(job.status, 'planning');
  assert.equal(store.get('projects', job.projectId).name, 'second');
});
