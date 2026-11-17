// The scene view model must follow docs/ARCHITECTURE.md section 13. This checks ui/lib/vm.js and the selectors it uses
// with a fake store. No server, no DOM. Run: node --test tests/ui-stub/vm.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVM, deliveryStage, bubbleKind, createTruck } from '../../ui/lib/vm.js';
import { sel, parseOptions } from '../../ui/lib/selectors.js';

function fakeStore({ jobs = [], tasks = [], agents = [], deliveries = [], projects = [], board = [], inbox = [], providers = [], settings = {}, seen = 0 }) {
  const data = { jobs, tasks, agents, deliveries, projects };
  return {
    board, inbox, providers, settings, boardSeenId: seen,
    get: (kind, id) => data[kind].find((x) => x.id === id) || null,
    list: (kind, f) => (f ? data[kind].filter(f) : data[kind]),
    msg: (id) => board.find((m) => m.id === Number(id)) || null,
  };
}
const job = { id: 'J1', title: 'Recipe Box', status: 'running', createdAt: 1, requirements: [], leadBossId: 'A1' };
const agent = (id, role, status, taskId = null, extra = {}) => ({ id, jobId: 'J1', name: 'N' + id, handle: '@x' + id, role, provider: 'claude', model: 'opus', style: { seed: 7 }, spot: 0, status, taskId, bubble: null, ...extra });
const task = (id, progress = 0.5, domain = 'backend', extra = {}) => ({ id, jobId: 'J1', title: 'Task ' + id, domain, progress, status: 'working', ...extra });
const deliv = (id, taskId, status, extra = {}) => ({ id, jobId: 'J1', taskId, makerId: 'A5', reviewerId: null, attempt: 1, status, ...extra });
const msg = (id, kind, from, to, extra = {}) => ({ id, ts: id, jobId: 'J1', from, fromId: from.startsWith('@b') ? 'A1' : null, role: 'boss', kind, to, toId: null, toAlias: null, scope: '#plan', re: null, thread: id, slots: {}, body: '', state: null, due: null, seenAt: null, esc: 0, defaulted: false, stale: false, ...extra });
const base = { jobs: [job], tasks: [task('T1')] };

test('agent.status maps to activity', () => {
  const statuses = { working: 'work', thinking: 'think', waiting: 'wait', reviewing: 'review', blocked: 'blocked', idle: 'idle', off: 'off' };
  for (const [status, activity] of Object.entries(statuses)) {
    const vm = buildVM(fakeStore({ jobs: [job], agents: [agent('A1', 'boss', status)] }));
    assert.equal(vm.agents[0].activity, activity, status);
  }
});

test('task progress, bubble and shop line', () => {
  const vm = buildVM(fakeStore({ jobs: [job], tasks: [task('T1', 0.4, 'algo')], agents: [agent('A5', 'maker', 'working', 'T1', { bubble: { text: 'hi', kind: 'ask', seq: 3 } })] }));
  assert.deepEqual(vm.agents[0].task, { id: 'T1', title: 'Task T1', domain: 'algo', progress: 0.4 });
  assert.deepEqual(vm.agents[0].bubble, { text: 'hi', kind: 'ask', seq: 3 });
  assert.deepEqual(vm.agents[0].style, { seed: 7 });
  assert.equal(vm.shop.jobTitle, 'Recipe Box');
  assert.equal(vm.shop.paused, false);
  // board kind -> bubble kind (section 12): ASK, BLOCK -> ask; DONE, PASS -> done; FIX, FAIL, NO -> warn; else info
  for (const [kind, want] of Object.entries({ ASK: 'ask', BLOCK: 'ask', DONE: 'done', PASS: 'done', FIX: 'warn', FAIL: 'warn', NO: 'warn', ANS: 'info', INFO: 'info', DECIDE: 'info', EVT: 'info', done: 'done', '???': 'info' })) assert.equal(bubbleKind(kind), want, kind);
  assert.deepEqual(buildVM(fakeStore({})).shop, { jobTitle: '', paused: false, statusLine: 'No work order yet' });
});

test('a paused job shows the pause reason; a queued job shows what it waits for', () => {
  const paused = buildVM(fakeStore({ jobs: [{ ...job, status: 'paused', pauseReason: 'budget' }] })).shop;
  assert.equal(paused.paused, true);
  assert.match(paused.statusLine, /budget/);
  const queued = { ...job, id: 'J2', status: 'queued', createdAt: 2 };
  const store = fakeStore({ jobs: [job, queued] });
  assert.equal(sel.activeJob(store).id, 'J1', 'the live job is the active one');
  assert.equal(sel.waitsFor(store, queued).id, 'J1');
});

test('delivery status maps to stage', () => {
  const stage = (d, agents = []) => deliveryStage(fakeStore({ ...base, agents, deliveries: [d] }), d);
  assert.equal(stage(deliv('D1', 'T1', 'checking')), 'to_office');
  assert.equal(stage(deliv('D1', 'T1', 'buddy')), 'buddy_check');
  assert.equal(stage(deliv('D1', 'T1', 'review', { reviewerId: 'A1' }), [agent('A1', 'boss', 'idle')]), 'to_office', 'review not started');
  assert.equal(stage(deliv('D1', 'T1', 'review', { reviewerId: 'A1' }), [agent('A1', 'boss', 'reviewing', 'T9')]), 'to_office', 'reviewer busy with another task');
  assert.equal(stage(deliv('D1', 'T1', 'review', { reviewerId: 'A1' }), [agent('A1', 'boss', 'reviewing', 'T1')]), 'in_review');
  assert.equal(stage(deliv('D1', 'T1', 'review', { reviewerId: 'A3' }), [agent('A3', 'manager', 'reviewing', 'T1')]), 'in_review', 'a manager reviews at its own spot');
  assert.equal(stage(deliv('D1', 'T1', 'rejected'), [agent('A5', 'maker', 'waiting', 'T1')]), 'rejected');
  assert.equal(stage(deliv('D1', 'T1', 'rejected'), [agent('A5', 'maker', 'working', 'T1')]), null, 'rejected hides when the maker works again');
  assert.equal(stage(deliv('D1', 'T1', 'approved')), 'to_truck');
  assert.equal(stage(deliv('D1', 'T1', 'loaded')), 'on_truck');
  assert.equal(stage(deliv('D1', 'T1', 'shipped')), 'shipped');
});

test('newest attempt per task; buddy id; truck docked with crates, ready only when delivering', () => {
  const store = fakeStore({ ...base, tasks: [task('T1'), task('T2', 1, 'docs'), task('T3', 1, 'algo', { buddyId: 'A6' })], agents: [agent('A5', 'maker', 'waiting', 'T1')],
    deliveries: [deliv('D1', 'T1', 'rejected'), deliv('D2', 'T1', 'loaded', { attempt: 2 }), deliv('D3', 'T2', 'loaded'), deliv('D4', 'T3', 'buddy')] });
  const vm = buildVM(store);
  assert.deepEqual(vm.deliveries.map((d) => `${d.id}:${d.stage}:${d.domain}:${d.buddyId}`), ['D2:on_truck:backend:null', 'D3:on_truck:docs:null', 'D4:buddy_check:algo:A6']);
  assert.deepEqual(vm.truck, { state: 'docked', crates: 2 }, 'loaded deliveries, job not in delivering: docked with crates (no beacon)');
  const delivering = fakeStore({ jobs: [{ ...job, status: 'delivering' }], tasks: [task('T2', 1, 'docs')], deliveries: [deliv('D3', 'T2', 'loaded')] });
  assert.deepEqual(buildVM(delivering).truck, { state: 'ready', crates: 1 }, 'job in delivering: ready (beacon)');
  assert.deepEqual(buildVM(store, { truckPhase: 'leaving', shipCrates: 2 }).truck, { state: 'leaving', crates: 2 });
  assert.deepEqual(buildVM(store, { truckPhase: 'returning', shipCrates: 2 }).truck, { state: 'returning', crates: 0 });
  assert.deepEqual(buildVM(fakeStore({ jobs: [job] })).truck, { state: 'docked', crates: 0 });
});

test('board unread and owner attention', () => {
  const q = 'Do we store photos as links, or as uploaded files? A) Links only. Simple. B) Uploaded files. Needs a folder.';
  const board = [
    msg(1, 'ASK', '@b1', '@human', { body: q, state: 'open', slots: { default: 'A' } }),
    msg(2, 'INFO', '@human', '@b1', { body: 'x' }),
    msg(3, 'EVT', '@hub', null, { body: 'y' }),
  ];
  const store = fakeStore({ jobs: [job], board, seen: 0 });
  assert.equal(buildVM(store).board.unread, 2, 'own posts do not count');
  assert.equal(sel.unreadForOwner(store), 1);
  const qs = sel.ownerQuestions(store, 'J1');
  assert.equal(qs.length, 1);
  assert.equal(qs[0].text, 'Do we store photos as links, or as uploaded files?');
  assert.deepEqual(qs[0].options, [{ key: 'A', text: 'Links only. Simple.' }, { key: 'B', text: 'Uploaded files. Needs a folder.' }]);
  assert.equal(qs[0].default, 'A');
  const att = sel.ownerAttention(store);
  assert.equal(att.any, true);
  assert.equal(att.panels.board, 1, 'an open question pulses the Board');
  assert.strictEqual(buildVM(store, { attention: att.any }).owner.attention, true);
  board.push(msg(4, 'ANS', '@human', null, { re: 1, body: 'A) Links only.' }));
  assert.equal(sel.ownerQuestions(store, 'J1').length, 0, 'answered by the owner');
  assert.equal(sel.ownerAttention(fakeStore({ jobs: [{ ...job, status: 'done' }], board: board.slice(0, 3) })).any, false, 'a finished job asks nothing');
});

test('a default the hub took stays pinned until the owner answers or keeps it', () => {
  const taken = msg(7, 'ASK', '@b1', '@human', { body: 'Which one? A) One. B) Two.', state: 'answered', defaulted: true, slots: { default: 'B' } });
  const hubAns = msg(8, 'ANS', '@hub', null, { re: 7, body: 'B) Two. (default taken)' });
  const store = fakeStore({ jobs: [job], board: [taken, hubAns] });
  const qs = sel.ownerQuestions(store, 'J1');
  assert.equal(qs.length, 1);
  assert.equal(qs[0].defaulted, true);
  assert.equal(sel.ownerAttention(store).panels.board, 0, 'a default that was taken does not make the Board pulse');
  assert.equal(sel.ownerAttention(store).any, false, 'and it does not ring');
  assert.equal(sel.ownerAttention(store).count, 1, 'but it stays in the Inbox');
  // "Keep the default" is the owner's ANS with the default option: it unpins the question, like any other answer of the owner (section 12b)
  assert.equal(sel.ownerQuestions(fakeStore({ jobs: [job], board: [taken, hubAns, msg(9, 'ANS', '@human', null, { re: 7, body: 'B) Two.' })] }), 'J1').length, 0, 'kept by the owner');
  assert.equal(sel.ownerQuestions(fakeStore({ jobs: [job], board: [taken, hubAns, msg(9, 'ANS', '@human', null, { re: 7, body: 'A) One.' })] }), 'J1').length, 0, 'overturned by the owner');
  // a question that is older than the loaded board posts still shows, from the inbox
  const old = fakeStore({ jobs: [job], inbox: [{ kind: 'question', id: 3, jobId: 'J1', text: 'Keep it? A) Yes. B) No.', since: 5, options: [{ key: 'A', text: 'Yes.' }, { key: 'B', text: 'No.' }], default: 'A', defaulted: false }] });
  assert.deepEqual(sel.ownerQuestions(old, 'J1').map((x) => [x.id, x.text, x.options.length]), [[3, 'Keep it?', 2]]);
});

test('question options: 2 to 4, in order; prose that holds "A) " is not an option list', () => {
  assert.deepEqual(parseOptions('Pick? A) One B) Two C) Three D) Four').options.map((o) => o.key + o.text), ['AOne', 'BTwo', 'CThree', 'DFour']);
  assert.deepEqual(parseOptions('See section B) below.').options, []);
  assert.deepEqual(parseOptions('Plain question?'), { text: 'Plain question?', options: [] });
});

test('hub pause needs the owner; lab state is only "usable"', () => {
  const hub = fakeStore({ jobs: [{ ...job, status: 'paused', pauseReason: 'caps', error: 'limit' }] });
  assert.equal(sel.ownerAttention(hub).hubPaused, true);
  assert.equal(sel.ownerAttention(hub).panels.blueprint, 1);
  assert.equal(sel.ownerAttention(fakeStore({ jobs: [{ ...job, status: 'paused', pauseReason: 'owner' }] })).any, false);
  assert.equal(sel.labNeedsSetup({ installed: true, auth: 'ok', usable: false, reason: 'Run the self-test once.' }), true);
  assert.equal(sel.labUsable({ installed: true, auth: 'ok', usable: true }), true);
  const money = (n) => '$' + n.toFixed(2);
  assert.equal(sel.cost({ cost: { billedUsd: 0, estUsd: 1.25 } }, money).text, '~$1.25 est.');
  assert.equal(sel.cost({ cost: { billedUsd: 2, estUsd: 1.25 } }, money).text, '$2.00 + ~$1.25 est.');
  assert.equal(sel.cost({ cost: { billedUsd: 0, estUsd: 0 } }, money).text, '$0.00');
});

test('the inbox lists every kind that waits for the owner, newest first, and drops what the state has settled', () => {
  const lab = (id, extra = {}) => ({ id, label: id, installed: true, mode: 'subscription', ack: true, auth: 'ok', usable: true, reason: null, cooling: null, selfTest: { version: '1', ok: true }, version: '1', ...extra });
  const done = msg(20, 'DONE', '@m1', null, { state: 'open' });
  const j = { ...job, requirements: [{ id: 'R1', text: 'One', status: 'verified' }, { id: 'R4', text: 'Import', status: 'failed', evidence: 'loses amounts' }], projectId: 'P1' };
  const inbox = [
    { kind: 'question', id: 5, jobId: 'J1', text: 'Keep it? A) Yes. B) No.', since: 50, default: 'A' },
    { kind: 'review', id: 'D3', jobId: 'J1', text: 'T2 waits for your verdict', since: 40 },
    { kind: 'review', id: 'D9', jobId: 'J1', text: 'T9 waits', since: 41 },          // loaded since: a verdict is in
    { kind: 'requirement', id: 'R4', jobId: 'J1', text: 'R4 failed', since: 30 },
    { kind: 'requirement', id: 'R1', jobId: 'J1', text: 'R1 failed', since: 31 },    // verified since
    { kind: 'agentfiles', id: 'P1', jobId: 'J1', text: 'agent files', since: 20 },
    { kind: 'signin', id: 'gemini', jobId: null, text: 'not installed', since: 10 },
    { kind: 'signin', id: 'claude', jobId: null, text: 'old news', since: 11 },      // usable now
    { kind: 'plan', id: 'J1', jobId: 'J1', text: 'plan', since: 12 },                // the job is running: settled
    { kind: 'surprise', id: 'x', jobId: 'J1', text: 'a kind of the future', since: 5 },
  ];
  const store = fakeStore({ jobs: [j], board: [done], inbox, projects: [{ id: 'P1', name: 'repo', agentFiles: ['AGENTS.md'], agentFilesAck: false }],
    deliveries: [deliv('D3', 'T2', 'review', { doneMsgId: 20 }), deliv('D9', 'T9', 'loaded')],
    providers: [lab('claude'), lab('gemini', { installed: false, usable: false, reason: 'not installed' })] });
  const items = sel.inboxItems(store);
  assert.deepEqual(items.map((it) => `${it.kind}:${it.id}${it.quiet ? ' quiet' : ''}`), ['question:5', 'review:D3', 'requirement:R4', 'agentfiles:P1', 'signin:gemini quiet', 'surprise:x']);
  const review = items.find((it) => it.kind === 'review');
  assert.equal(review.doneId, 20, 'PASS or FIX goes to the DONE post of the hand-in');
  assert.equal(review.delivery.id, 'D3');
  assert.deepEqual(sel.reviewTarget(store, { id: 20 }).delivery.id, 'D3', 'a review item may also carry the id of the DONE post');
  const att = sel.ownerAttention(store);
  assert.equal(att.count, 6, 'the Inbox button counts every item');
  assert.equal(att.loud.length, 5, 'a lab that no work waits for does not ring');
  assert.equal(att.any, true);
  assert.equal(att.panels.blueprint, 1, 'a failed requirement that no task serves also marks the Blueprint');
  // work waits for the lab: the item rings
  const held = fakeStore({ jobs: [{ ...j, hold: { lab: 'gemini', reason: 'x' } }], inbox: [inbox[6]], providers: [lab('gemini', { installed: false, usable: false })] });
  assert.equal(sel.inboxItems(held)[0].quiet, false);
});

test('what the state shows is in the inbox at once: plan, truck, a paused job, a cancelled job with crates', () => {
  const plan = sel.inboxItems(fakeStore({ jobs: [{ ...job, status: 'plan_review' }] }));
  assert.deepEqual(plan.map((it) => it.kind), ['plan']);
  const truck = fakeStore({ jobs: [{ ...job, status: 'delivering' }], deliveries: [deliv('D1', 'T1', 'loaded'), deliv('D2', 'T2', 'loaded')] });
  assert.match(sel.inboxItems(truck)[0].text, /2 crates/);
  assert.equal(sel.ownerAttention(truck).truckWaiting, true);
  const left = fakeStore({ jobs: [{ ...job, status: 'cancelled' }], deliveries: [deliv('D1', 'T1', 'loaded')] });
  assert.equal(sel.ownerAttention(left).cancelledLoad, true, 'reviewed crates of a cancelled job wait for ship or discard');
  assert.equal(sel.ownerAttention(left).panels.truck, 1);
  assert.equal(sel.ownerAttention(left).any, true);
  const mine = sel.inboxItems(fakeStore({ jobs: [{ ...job, status: 'paused', pauseReason: 'owner' }] }));
  assert.deepEqual(mine.map((it) => [it.kind, it.quiet]), [['paused', true]], 'a job the owner paused is listed but does not ring');
  const budget = sel.inboxItems(fakeStore({ jobs: [{ ...job, status: 'paused', pauseReason: 'budget', error: 'The bill reached the budget.' }] }));
  assert.deepEqual(budget.map((it) => [it.kind, it.quiet, it.text]), [['budget', false, 'The bill reached the budget.']]);
});

test('crates are in the order they were loaded, never in the order of a list', () => {
  // The hub sorts the lists it sends by delivery id: the order of the hand-ins. A hand-in that waits long in review is merged
  // after a later one. "Ship up to here" ships every crate merged up to one commit, so the crate numbers must follow the merges.
  const list = [deliv('D2', 'T2', 'loaded', { loadedAt: 300, updatedAt: 300 }), deliv('D3', 'T3', 'loaded', { loadedAt: 100, updatedAt: 100 }),
    deliv('D10', 'T9', 'loaded', { loadedAt: 200, updatedAt: 950 }), deliv('D4', 'T4', 'review'), deliv('D5', 'T5', 'shipped', { loadedAt: 50 })];
  assert.deepEqual(sel.loadedDeliveries(fakeStore({ jobs: [job], deliveries: list }), 'J1').map((d) => d.id), ['D3', 'D10', 'D2'], 'by loadedAt, whatever the id and updatedAt say');
  assert.deepEqual(sel.loadedDeliveries(fakeStore({ jobs: [job], deliveries: list.slice().reverse() }), 'J1').map((d) => d.id), ['D3', 'D10', 'D2'], 'the order of the list does not count');
  // a hub that sends no loadedAt: updatedAt stands in (a loaded delivery does not change until it ships), then the id
  const plain = [deliv('D7', 'T7', 'loaded', { updatedAt: 20 }), deliv('D6', 'T6', 'loaded', { updatedAt: 30 }), deliv('D12', 'T2', 'loaded', { updatedAt: 20 }), deliv('D9', 'T9', 'loaded')];
  assert.deepEqual(sel.loadedDeliveries(fakeStore({ jobs: [job], deliveries: plain }), 'J1').map((d) => d.id), ['D9', 'D7', 'D12', 'D6']);
  assert.deepEqual(sel.loadOrder([list[0], null, list[1], list[2]]).map((d) => d.id), ['D3', 'D10', 'D2'], 'loadOrder sorts a copy of any list');
  assert.equal(list[0].id, 'D2', 'and leaves the list as it was');
});

test('every job has its own truck: the crates of a cancelled job stay in reach while a newer job runs', () => {
  const j1 = { ...job, id: 'J1', status: 'cancelled', createdAt: 1 };
  const j2 = { ...job, id: 'J2', status: 'running', createdAt: 2 };
  const d = (id, jobId, status = 'loaded') => ({ ...deliv(id, 'T' + id.slice(1), status), jobId });
  const store = fakeStore({ jobs: [j1, j2], deliveries: [d('D1', 'J1'), d('D2', 'J1'), d('D3', 'J1'), d('D4', 'J2'), d('D5', 'J2', 'review')] });
  assert.equal(sel.activeJob(store).id, 'J2', 'the newer job is on the floor');
  assert.deepEqual(sel.trucks(store).map((t) => `${t.job.id}:${t.n}:${t.waits}`), ['J2:1:false', 'J1:3:true'], 'the floor first; the truck of J1 waits, the truck of J2 is only docked');
  assert.equal(sel.truckJob(store).id, 'J1', 'the Truck button stands for the truck that waits');
  const att = sel.ownerAttention(store);
  assert.deepEqual([att.truckJob.id, att.truckLoad, att.truckWaiting, att.cancelledLoad, att.panels.truck], ['J1', 3, true, true, 1]);
  const item = sel.inboxItems(store).find((it) => it.kind === 'truck');
  assert.equal(item.jobId, 'J1', 'the inbox item names the cancelled job, so its button can open that truck');
  assert.match(item.text, /J1 is cancelled. 3 reviewed crates are still on the truck/);
  // the hub's own inbox item for that truck is kept too (one item, not two)
  const fromHub = fakeStore({ jobs: [j1, j2], deliveries: [d('D1', 'J1')], inbox: [{ kind: 'truck', id: 'J1', jobId: 'J1', text: '1 crates wait on the truck of J1.', since: 9 }] });
  assert.deepEqual(sel.inboxItems(fromHub).map((it) => `${it.kind}:${it.jobId}`), ['truck:J1']);
  // the job on the floor is ready to ship too: its truck comes first, the other one stays in the list
  const both = fakeStore({ jobs: [j1, { ...j2, status: 'delivering' }], deliveries: [d('D1', 'J1'), d('D4', 'J2')] });
  assert.equal(sel.truckJob(both).id, 'J2');
  assert.deepEqual(sel.inboxItems(both).filter((it) => it.kind === 'truck').map((it) => it.jobId).sort(), ['J1', 'J2']);
  // the crates were shipped or discarded: the button follows the floor again
  const after = fakeStore({ jobs: [j1, j2], deliveries: [d('D1', 'J1', 'shipped'), d('D4', 'J2')] });
  assert.equal(sel.truckJob(after).id, 'J2');
  assert.deepEqual([sel.ownerAttention(after).truckLoad, sel.ownerAttention(after).truckWaiting], [1, false]);
  assert.equal(sel.truckJob(fakeStore({})), null);
});

test('a requirement that no task serves waits in the inbox when it is failed and when it is open', () => {
  const reqs = [{ id: 'R4', text: 'Import', status: 'failed', evidence: 'loses amounts' }, { id: 'R9', text: 'Cooking time', status: 'open' },
    { id: 'R2', text: 'Search', status: 'verified' }, { id: 'R3', text: 'Edit', status: 'waived' }];
  const inbox = ['R4', 'R9', 'R2', 'R3', 'R77'].map((id, i) => ({ kind: 'requirement', id, jobId: 'J1', text: `${id} has no task`, since: 10 - i }));
  const store = fakeStore({ jobs: [{ ...job, requirements: reqs }], inbox });
  const items = sel.inboxItems(store);
  assert.deepEqual(items.map((it) => `${it.id}:${it.req.status}:${it.quiet}`), ['R4:failed:false', 'R9:open:false'], 'verified, waived and unknown requirements are dropped');
  const att = sel.ownerAttention(store);
  assert.deepEqual([att.count, att.any, att.panels.inbox, att.panels.blueprint], [2, true, 2, 2], 'both ring, and both mark the Blueprint');
  assert.deepEqual(sel.inboxItems(fakeStore({ jobs: [{ ...job, status: 'cancelled', requirements: reqs }], inbox })), [], 'a job that is over asks for nothing');
});

test('the next step of a lab; a lab that only cools down needs no setup', () => {
  const base = { id: 'claude', installed: true, mode: 'subscription', ack: true, auth: 'ok', keySet: false, usable: false, version: '2', selfTest: { version: '2', ok: true }, cooling: null };
  const now = 1000;
  assert.equal(sel.labStep({ ...base, installed: false }, {}, now), 'install');
  assert.equal(sel.labStep({ ...base, mode: null }, {}, now), 'mode');
  assert.equal(sel.labStep({ ...base, mode: 'apikey' }, {}, now), 'key');
  assert.equal(sel.labStep({ ...base, auth: 'none' }, {}, now), 'signin');
  assert.equal(sel.labStep({ ...base, selfTest: null }, { safety: 'sandboxed' }, now), 'test');
  assert.equal(sel.labStep({ ...base, selfTest: null, cooling: { until: 2000 } }, { safety: 'trusting' }, now), 'cooling');
  assert.equal(sel.labStep({ ...base, cooling: { until: 2000, reason: 'limit' } }, {}, now), 'cooling');
  assert.equal(sel.labStep({ ...base, usable: true }, {}, now), 'ready');
  const store = fakeStore({ providers: [{ ...base, cooling: { until: Date.now() + 60000 } }, { ...base, id: 'gemini', installed: false }, { ...base, id: 'mock', installed: false }] });
  assert.deepEqual(sel.labsToSetUp(store).map((p) => p.id), ['gemini'], 'the cooling lab and the mock lab are not listed');
});

test('fx ship plays leaving, away, returning, then back', async () => {
  const seen = [];
  const truck = createTruck({ onChange: () => seen.push(truck.phase), timings: { leaving: 20, away: 20, returning: 20 } });
  truck.ship(3);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(seen, ['leaving', 'away', 'returning', null]);
});
