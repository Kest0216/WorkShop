// Scene simulation (actors.js): the view model is the truth, animations are decoration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, LIMITS, LATE_HOP_MS, SLIP_KEEP_MS } from '../../ui/scene/actors.js';
import * as M from '../../ui/scene/map.js';
import { vmAt, applyScript, LOOP_MS } from '../../ui/scene/demo.js';

const quiet = () => {};
function world() { return createWorld({ warn: quiet, seed: 7 }); }

function baseVm(extra = {}) {
  return {
    shop: { jobTitle: 'Job', paused: false, statusLine: 'ok' },
    agents: [
      { id: 'B', name: 'Boss', role: 'boss', provider: 'claude', spot: 1, activity: 'idle' },
      { id: 'G', name: 'Mgr', role: 'manager', provider: 'gemini', spot: 0, activity: 'idle' },
      { id: 'K', name: 'Maker', role: 'maker', provider: 'openai', spot: 2, activity: 'work', task: { id: 'T1', title: 't', domain: 'backend', progress: 0.6 } },
      { id: 'L', name: 'Other', role: 'maker', provider: 'mock', spot: 5, activity: 'idle' },
    ],
    deliveries: [],
    truck: { state: 'docked', crates: 0 },
    board: { unread: 0 },
    owner: { attention: false },
    ...extra,
  };
}
const delivery = (stage, id = 'D1') => ({ id, taskId: 'T1', domain: 'backend', makerId: 'K', reviewerId: 'B', stage });

// feet of every walking actor must be on walkable ground
function assertOnFloor(w, label) {
  const s = w.state();
  for (const [id, a] of Object.entries(s.agents)) {
    if (!a.present || a.role === 'boss') continue;
    assert.ok(M.pointWalkable(a.x, a.y), label + ': agent ' + id + ' stands on a blocked tile at ' + a.x + ',' + a.y);
  }
  assert.ok(M.pointWalkable(s.dolly.x, s.dolly.y), label + ': dolly on a blocked tile at ' + s.dolly.x + ',' + s.dolly.y);
}

test('sync with garbage input never throws', () => {
  const w = world();
  const junk = [undefined, null, 42, 'vm', [], { agents: 5 }, { agents: [null, {}, { id: 'x', role: 'ghost', activity: 'fly', spot: -3, task: 'no', bubble: 9, style: 'red' }] },
    { deliveries: [{ id: 'q', stage: 'in_review', makerId: 'nobody', reviewerId: 'nobody' }, { id: 'q', stage: 'on_truck' }, { id: 'z', stage: '??' }] },
    { truck: { state: 'flying', crates: 'many' }, board: null, owner: 'me', shop: 3 },
    { agents: Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, role: 'maker', activity: 'work', task: { id: 't' + i, domain: 'x' + i, progress: i } })) },
    { agents: [{ id: 'dup', role: 'boss' }, { id: 'dup', role: 'maker' }, { id: 'dup', role: 'manager' }] }];
  for (const vm of junk) {
    assert.doesNotThrow(() => { w.sync(vm); w.advance(500); w.state(); });
  }
  assert.doesNotThrow(() => { w.fx('nope'); w.fx('note', null); w.fx('note', { from: {}, text: 5, kind: [] }); w.fx(null); w.fx('ship'); w.fx('confetti', 'x'); w.advance(300); });
  assert.equal(w.state().overflow, 0);
});

test('more agents than spots: the extra ones are not placed and are counted', () => {
  const w = world();
  w.sync({ agents: Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, role: 'maker', activity: 'idle' })) });
  const s = w.state();
  assert.equal(Object.values(s.agents).filter((a) => a.present).length, 8);
  assert.equal(s.overflow, 4);
});

const STEADY = { to_office: 'inbox', in_review: 'desk', rejected: 'bench', to_truck: 'truck', on_truck: 'truck' };

test('a delivery that appears at any stage with no history lands directly in its steady state', () => {
  for (const [stage, place] of Object.entries(STEADY)) {
    const w = world();
    w.sync(baseVm({ deliveries: [delivery(stage)] }));
    const s = w.state();
    const it = s.items.D1;
    assert.ok(it, stage + ': item exists');
    assert.equal(it.place, place, stage);
    assert.equal(it.hidden, false, stage + ' is visible');
    if (place === 'inbox' || place === 'desk') assert.equal(it.office, 1, 'in the reviewer office');
    assert.equal(it.form, place === 'truck' ? 'crate' : 'doohickey');
    for (const a of Object.values(s.agents)) { assert.equal(a.moving, false); assert.equal(a.errand, null); }
    assert.equal(s.dolly.job, null);
    // nothing changes when time passes: it was the steady state
    w.advance(5000);
    const t = w.state();
    assert.equal(t.items.D1.place, place, stage + ' after 5 s');
    assert.equal(t.items.D1.x, it.x); assert.equal(t.items.D1.y, it.y);
  }
  const w = world();
  w.sync(baseVm({ deliveries: [delivery('shipped')] }));
  assert.equal(Object.keys(w.state().items).length, 0, 'shipped: gone with the truck');
});

test('with the truck away, crates for the truck wait on the staging pallet (no history)', () => {
  const w = world();
  w.sync(baseVm({ truck: { state: 'away', crates: 0 }, deliveries: [delivery('to_truck')] }));
  assert.equal(w.state().items.D1.place, 'staging');
  assert.equal(w.state().truck.visible, false);
});

test('positions of the steady states match the named map locations', () => {
  const w = world();
  w.sync(baseVm({ deliveries: [delivery('to_office', 'a'), delivery('in_review', 'b'), delivery('rejected', 'c')] }));
  const s = w.state();
  assert.deepEqual([s.items.a.x, s.items.a.y], [M.offices[1].inbox.x, M.offices[1].inbox.y]);
  assert.deepEqual([s.items.b.x, s.items.b.y], [M.offices[1].deskItem.x, M.offices[1].deskItem.y]);
  assert.equal(s.agents.K.x, M.benches[2].stand.x); assert.equal(s.agents.K.y, M.benches[2].stand.y);
  assert.equal(s.agents.B.x, M.offices[1].boss.x);
  assert.equal(s.agents.G.x, M.posts[0].stand.x);
});

test('the full delivery flow animates and ends in the steady state of each stage', () => {
  const w = world();
  w.sync(baseVm());
  w.advance(1000);
  const run = (stage, ms) => { w.sync(baseVm({ deliveries: [delivery(stage)] })); for (let t = 0; t < ms; t += 50) { w.advance(50); assertOnFloor(w, stage); } return w.state(); };
  let s = run('to_office', 400);
  assert.ok(['bench', 'hand'].includes(s.items.D1.place), 'the maker picks it up first');
  s = run('to_office', 12000);
  assert.equal(s.items.D1.place, 'inbox'); assert.equal(s.agents.K.atHome, true, 'the maker walked back');
  s = run('in_review', 3000);
  assert.equal(s.items.D1.place, 'desk');
  s = run('rejected', 400);
  assert.equal(s.counts.stamps, 1, 'red stamp');
  s = run('rejected', 20000);
  assert.equal(s.items.D1.place, 'bench'); assert.equal(s.agents.K.atHome, true);
  run('to_office', 12000); run('in_review', 3000);
  s = run('to_truck', 25000);
  assert.equal(s.items.D1.place, 'truck'); assert.equal(s.items.D1.form, 'crate'); assert.equal(s.dolly.job, null);
  assert.equal(s.dolly.x, M.dolly.home.x); assert.equal(s.dolly.y, M.dolly.home.y);
  s = run('on_truck', 1000);
  assert.equal(s.items.D1.place, 'truck'); assert.equal(s.truck.crates, 1);
});

test('rapid stage changes never duplicate an item and never get stuck', () => {
  const stages = ['to_office', 'in_review', 'rejected', 'to_truck', 'on_truck', 'shipped', null];
  let seed = 99;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const w = world();
  w.sync(baseVm());
  for (let round = 0; round < 400; round++) {
    const ds = [];
    for (const id of ['D1', 'D2', 'D3']) { const st = stages[rnd(stages.length)]; if (st) ds.push(delivery(st, id)); }
    w.sync(baseVm({ deliveries: ds, truck: { state: ['docked', 'ready', 'away', 'leaving', 'returning'][rnd(5)], crates: rnd(9) } }));
    w.advance(rnd(4) * 150);
    const s = w.state();
    const live = Object.entries(s.items).filter(([, v]) => !v.ghost).map(([k]) => k).sort();
    assert.deepEqual(live, ds.filter((d) => d.stage !== 'shipped').map((d) => d.id).sort(), 'exactly one item per live delivery');
    assert.ok(s.counts.items <= 6);
    assertOnFloor(w, 'round ' + round);
  }
  // settle on a fixed view model: everything must reach its steady state
  const final = baseVm({ deliveries: [delivery('to_office', 'D1'), delivery('rejected', 'D2'), delivery('on_truck', 'D3')], truck: { state: 'docked', crates: 1 } });
  w.sync(final);
  for (let t = 0; t < 90000; t += 50) { w.advance(50); assertOnFloor(w, 'settle'); }
  const s = w.state();
  assert.equal(s.items.D1.place, 'inbox'); assert.equal(s.items.D2.place, 'bench'); assert.equal(s.items.D3.place, 'truck');
  assert.equal(s.truck.phase, 'parked');
  for (const a of Object.values(s.agents)) { assert.equal(a.moving, false); assert.equal(a.errand, null); }
  assert.equal(s.dolly.job, null);
});

test('one hour of the demo script keeps every list bounded and everybody on the floor', () => {
  const w = world();
  w.sync(vmAt(0));
  let t = 0, max = { particles: 0, notes: 0, stamps: 0, slips: 0, items: 0, agents: 0 };
  while (t < 3600000) {
    applyScript(w, t, t + 100);
    w.advance(100);
    t += 100;
    if (t % 500 === 0) {
      const s = w.state();
      for (const k of Object.keys(max)) max[k] = Math.max(max[k], s.counts[k]);
      assertOnFloor(w, 't=' + t);
    }
  }
  assert.ok(max.particles <= LIMITS.particles, 'particles ' + max.particles);
  assert.ok(max.notes <= LIMITS.notes); assert.ok(max.stamps <= LIMITS.stamps); assert.ok(max.slips <= LIMITS.slips);
  assert.ok(max.items <= 6); assert.equal(max.agents, 10);
  assert.ok(max.particles > 0 && max.notes > 0, 'the script really ran');
});

test('effects are capped however often they fire', () => {
  const w = world();
  const calm = baseVm(); calm.agents[2].activity = 'idle';
  w.sync(calm);
  for (let i = 0; i < 2000; i++) { w.fx('note', { from: 'a', kind: 'info', text: 'n' + i }); w.fx('newOrder'); w.fx('confetti'); w.fx('horn'); }
  const c = w.state().counts;
  assert.ok(c.notes <= LIMITS.notes); assert.ok(c.slips <= LIMITS.slips); assert.ok(c.particles <= LIMITS.particles);
  w.advance(10000);
  assert.equal(w.state().counts.particles, 0, 'particles die out');
});

test('truck: away, returning empty, docked, ready with beacon, leaving with its crates', () => {
  const w = world();
  w.sync(baseVm({ truck: { state: 'away', crates: 0 } }));
  let s = w.state();
  assert.equal(s.truck.visible, false); assert.equal(s.truck.door, 0);
  w.sync(baseVm({ truck: { state: 'returning', crates: 0 } }));
  w.advance(600);
  s = w.state();
  assert.equal(s.truck.phase, 'in'); assert.ok(s.truck.x < M.truck.parkX); assert.equal(s.truck.stock, 0, 'a truck back from a ship is empty');
  assert.equal(s.truck.crates, 0);
  w.advance(30000);
  s = w.state();
  assert.equal(s.truck.phase, 'parked'); assert.equal(s.truck.x, M.truck.parkX); assert.equal(s.truck.stock, 0);
  assert.equal(s.truck.crates, 0); assert.equal(s.dolly.job, null);
  w.sync(baseVm({ truck: { state: 'ready', crates: 3 }, owner: { attention: true } }));
  s = w.state();
  assert.equal(s.truck.beacon, true); assert.equal(s.truck.crates, 3);
  w.sync(baseVm({ truck: { state: 'ready', crates: 9 } }));
  assert.equal(w.state().truck.crates, 6); assert.equal(w.state().truck.extra, 3);
  w.sync(baseVm({ truck: { state: 'leaving', crates: 0 } }));
  w.advance(1500);
  s = w.state();
  assert.equal(s.truck.phase, 'out'); assert.ok(s.truck.x > M.truck.parkX); assert.equal(s.truck.crates, 6, 'the crates ride away with the truck');
  w.advance(5000);
  s = w.state();
  assert.equal(s.truck.visible, false); assert.equal(s.truck.crates, 0);
});

test("fx('ship'): the truck leaves, stays away, returns EMPTY and docks", () => {
  const w = world();
  w.sync(baseVm({ truck: { state: 'docked', crates: 2 } }));
  w.fx('ship');
  w.advance(1000);
  assert.equal(w.state().truck.phase, 'out');
  w.advance(4000);
  assert.equal(w.state().truck.visible, false);
  w.sync(baseVm({ truck: { state: 'docked', crates: 0 } }));   // the hub shipped them
  w.advance(3000);
  assert.equal(w.state().truck.phase, 'in'); assert.equal(w.state().truck.stock, 0); assert.equal(w.state().truck.crates, 0);
  w.advance(30000);
  const s = w.state();
  assert.equal(s.truck.phase, 'parked'); assert.equal(s.truck.stock, 0); assert.equal(s.truck.crates, 0); assert.equal(s.dolly.job, null);
});

test("fx('ship', { restock: true }): the scene demo brings stock back for the dolly", () => {
  const w = world();
  w.sync(baseVm({ truck: { state: 'docked', crates: 0 } }));
  w.fx('ship', { restock: true });
  w.advance(8000);
  assert.equal(w.state().truck.phase, 'in'); assert.equal(w.state().truck.stock, 3);
  w.advance(30000);
  const s = w.state();
  assert.equal(s.truck.phase, 'parked'); assert.equal(s.truck.stock, 0, 'the dolly unloaded the stock'); assert.equal(s.shelf, M.shelves.max);
});

test('snap() puts every actor into the steady state at once (resume after a hidden tab)', () => {
  const w = world();
  w.sync(baseVm());
  w.advance(500);
  w.sync(baseVm({ deliveries: [delivery('to_truck')], truck: { state: 'docked', crates: 0 } }));
  w.advance(700);                       // the maker is on the way
  w.snap();
  const s = w.state();
  assert.equal(s.items.D1.place, 'truck');
  assert.equal(s.agents.K.atHome, true); assert.equal(s.agents.K.moving, false);
  assert.equal(s.dolly.job, null); assert.equal(s.counts.particles, 0);
  w.advance(3000);
  assert.equal(w.state().items.D1.place, 'truck');
});

test('a manager patrols the benches of working makers and returns to the post when idle', () => {
  const w = world();
  const vm = baseVm();
  vm.agents[1].activity = 'work';
  w.sync(vm);
  let visited = false;
  for (let t = 0; t < 20000; t += 50) { w.advance(50); assertOnFloor(w, 'patrol'); const a = w.state().agents.G; if (Math.abs(a.x - M.benches[2].visit.x) < 1 && Math.abs(a.y - M.benches[2].visit.y) < 1) visited = true; }
  assert.ok(visited, 'the manager stopped next to bench 2');
  w.sync(baseVm());
  w.advance(20000);
  const a = w.state().agents.G;
  assert.equal(a.atHome, true); assert.equal(a.x, M.posts[0].stand.x);
});

test('bubbles show when seq changes and hide after about 4 seconds; agents can come and go', () => {
  const w = world();
  w.sync(baseVm());
  const vm = baseVm();
  vm.agents[2].bubble = { text: 'A rather long line of text that must be cut down to two short lines for sure', kind: 'ask', seq: 1 };
  w.sync(vm);
  assert.equal(w.state().agents.K.bubble, true);
  assert.ok(w.w.agents.get('K').bubble.lines.length <= 2);
  assert.ok(w.w.agents.get('K').bubble.lines[1].endsWith('..'));
  w.advance(3000); w.sync(vm);
  assert.equal(w.state().agents.K.bubble, true, 'same seq does not restart or hide it early');
  w.advance(1500);
  assert.equal(w.state().agents.K.bubble, false);
  const gone = baseVm(); gone.agents = gone.agents.filter((a) => a.id !== 'K');
  w.sync(gone);
  assert.equal(w.state().agents.K, undefined);
  w.sync(baseVm());
  const k = w.state().agents.K;
  assert.equal(k.x, M.entrance.stand.x, 'a new agent comes in through the entrance');
  w.advance(20000);
  assert.equal(w.state().agents.K.atHome, true);
});

test('the simulation is deterministic and advance() works in any step size', () => {
  const run = (step) => { const w = createWorld({ warn: quiet, seed: 3 }); w.sync(vmAt(0)); for (let t = 0; t < 30000; t += 1000) { applyScript(w, t, t + 1000); for (let k = 0; k < 1000; k += step) w.advance(step); } return w.state(); };
  assert.deepEqual(run(50), run(50));
  const a = run(50), b = run(1000);
  assert.deepEqual(Object.keys(a.items).sort(), Object.keys(b.items).sort());
  const w = world();
  w.sync(baseVm());
  assert.doesNotThrow(() => { w.advance(-5); w.advance(NaN); w.advance(Infinity); w.advance('x'); });
  assert.equal(LOOP_MS, 92000);
});

// ---------------------------------------------------------------- review round 1

test('snap() drops stale one-shot effects: no old bubble, no old horn, notes and slips are settled', () => {
  const w = world();
  w.sync(baseVm());
  w.advance(1000);
  // the world clock stands still (hidden tab) while sync() and fx() keep arriving
  const vm = baseVm();
  for (const a of vm.agents) a.bubble = { text: 'old news from ' + a.id, kind: 'info', seq: 7 };
  w.sync(vm);
  w.fx('horn'); w.fx('note', { from: 'K', kind: 'info', text: 'n' }); w.fx('newOrder'); w.fx('newOrder'); w.fx('confetti');
  assert.equal(w.state().agents.K.bubble, true); assert.equal(w.state().truck.horn, true);
  w.snap();
  const s = w.state();
  for (const a of Object.values(s.agents)) assert.equal(a.bubble, false, 'no stale bubble');
  assert.equal(s.truck.horn, false, 'no stale horn');
  assert.equal(s.counts.particles, 0);
  assert.equal(s.counts.slips, 1, 'only the newest slip stays');
  assert.ok(w.w.notes.every((n) => w.w.t - n.t0 > 1e6), 'notes do not drop in again');
  assert.ok(w.w.slips.every((sl) => w.w.t - sl.t0 > 1e6), 'slips do not slide in again');
  w.advance(2000);                                    // the second confetti wave was cancelled as well
  assert.equal(w.w.particles.filter((p) => p.kind === 'conf').length, 0);
  w.sync(vm);                                          // the same seq does not bring the bubble back
  assert.equal(w.state().agents.K.bubble, false);
  vm.agents[2].bubble = { text: 'fresh', kind: 'info', seq: 8 };
  w.sync(vm);
  assert.equal(w.state().agents.K.bubble, true, 'a new seq shows again');
});

test('a review backlog is visible: items in one office place are stacked, the rest is counted', () => {
  const makers = ['K', 'L', 'K2', 'K3', 'K4', 'K5'];
  const vm = baseVm();
  vm.agents.push({ id: 'K2', role: 'maker', spot: 0, activity: 'idle' }, { id: 'K3', role: 'maker', spot: 1, activity: 'idle' }, { id: 'K4', role: 'maker', spot: 3, activity: 'idle' }, { id: 'K5', role: 'maker', spot: 4, activity: 'idle' });
  const mk = (stage, n) => makers.slice(0, n).map((m, i) => ({ id: 'D' + i, taskId: 'X' + i, domain: 'docs', makerId: m, reviewerId: 'B', stage }));
  // four items wait in one inbox (no history)
  let w = world();
  w.sync({ ...vm, deliveries: mk('to_office', 4) });
  let s = w.state();
  const shown = Object.values(s.items).filter((it) => !it.hidden);
  assert.equal(shown.length, M.QUEUE_SHOWN);
  assert.equal(new Set(shown.map((it) => it.x + ',' + it.y)).size, M.QUEUE_SHOWN, 'no two items on the same pixel');
  assert.deepEqual([s.items.D0.x, s.items.D0.y], [M.offices[1].inbox.x, M.offices[1].inbox.y], 'the front item sits in the tray');
  assert.deepEqual(s.queues, [{ office: 1, kind: 'inbox', count: 4 }], 'the renderer shows +1');
  // all in review: only one is on the desk, the others wait in the inbox
  w.sync({ ...vm, deliveries: mk('in_review', 4) });
  w.advance(3000);
  s = w.state();
  assert.equal(Object.values(s.items).filter((it) => it.place === 'desk').length, 1);
  assert.equal(Object.values(s.items).filter((it) => it.place === 'inbox').length, 3);
  assert.equal(new Set(Object.values(s.items).map((it) => it.x + ',' + it.y)).size, 4, 'four different positions');
  // the reviewed one passes: the desk is free for the next one, the first one is in the outbox or on its way to the truck
  const next = mk('in_review', 4); next[0].stage = 'to_truck';
  w.sync({ ...vm, deliveries: next });
  w.advance(3000);
  s = w.state();
  assert.notEqual(s.items.D0.place, 'desk');
  assert.equal(s.items.D1.place, 'desk', 'the next one moved up');
  // no history: same picture at once
  w = world();
  w.sync({ ...vm, deliveries: mk('in_review', 6) });
  s = w.state();
  assert.equal(s.items.D0.place, 'desk');
  assert.equal(Object.values(s.items).filter((it) => it.place === 'inbox').length, 5);
  assert.equal(Object.values(s.items).filter((it) => it.hidden).length, 2);
  assert.deepEqual(s.queues.find((q) => q.kind === 'inbox'), { office: 1, kind: 'inbox', count: 5 });
  w.advance(4000);
  assert.equal(Object.values(w.state().items).filter((it) => it.place === 'desk').length, 1, 'steady');
  // every item moves on to the truck in the end
  w.sync({ ...vm, deliveries: mk('to_truck', 6) });
  w.advance(60000);
  s = w.state();
  for (const it of Object.values(s.items)) assert.equal(it.place, 'truck');
  assert.equal(s.truck.crates, 6); assert.equal(s.dolly.job, null);
});

test('the dolly catches up when the view model is ahead: many crates reach the truck within a few seconds', () => {
  const agents = [{ id: 'B1', role: 'boss', spot: 0, activity: 'idle' }, { id: 'B2', role: 'boss', spot: 1, activity: 'idle' }];
  for (let i = 0; i < 8; i++) agents.push({ id: 'K' + i, role: 'maker', spot: i, activity: 'idle' });
  const vm = (stage) => ({ agents, truck: { state: 'docked', crates: 0 },
    deliveries: agents.slice(2).map((a, i) => ({ id: 'D' + i, taskId: 'T' + i, domain: 'backend', makerId: a.id, reviewerId: i % 2 ? 'B1' : 'B2', stage })) });
  const w = world();
  w.sync(vm('in_review')); w.advance(1000);
  w.sync(vm('on_truck'));
  let rushed = false, maxLoad = 0, done = -1;
  for (let t = 50; t <= 12000; t += 50) {
    w.advance(50);
    const s = w.state();
    rushed = rushed || s.dolly.rush; maxLoad = Math.max(maxLoad, s.dolly.load);
    assert.ok(maxLoad <= 3);
    assert.ok(Object.keys(s.items).length === 8, 'no item lost or duplicated');
    if (done < 0 && Object.values(s.items).every((it) => it.place === 'truck')) done = t;
  }
  assert.ok(rushed, 'the dolly hurries');
  assert.ok(done > 0 && done <= LATE_HOP_MS + 3000, 'all 8 crates are on the truck after ' + done + ' ms');
  const s = w.state();
  assert.equal(s.truck.crates, 6); assert.equal(s.truck.extra, 2); assert.equal(s.dolly.job, null); assert.equal(s.dolly.rush, false);
  // the normal case keeps the slow trip: a crate with stage to_truck is never rushed
  const w2 = world();
  w2.sync(baseVm({ deliveries: [delivery('in_review')] })); w2.advance(500);
  w2.sync(baseVm({ deliveries: [delivery('to_truck')] }));
  for (let t = 0; t < 20000; t += 50) { w2.advance(50); assert.equal(w2.state().dolly.rush, false); }
  assert.equal(w2.state().items.D1.place, 'truck');
});

test('walkers keep apart: over two demo loops no two of them share a spot for long, managers stay out of the work places', () => {
  const w = world();
  w.sync(vmAt(0));
  const run = new Map();
  let worst = 0, late = 0;
  for (let t = 0; t < LOOP_MS * 2; t += 50) {
    applyScript(w, t, t + 50); w.advance(50);
    const s = w.state();
    const ids = Object.keys(s.agents).filter((id) => s.agents[id].present && s.agents[id].role !== 'boss' && !s.agents[id].atHome);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = s.agents[ids[i]], b = s.agents[ids[j]], k = ids[i] + ids[j];
      const close = Math.abs(a.x - b.x) < 8 && Math.abs(a.y - b.y) < 8;
      run.set(k, close ? (run.get(k) || 0) + 50 : 0);
      worst = Math.max(worst, run.get(k));
    }
    for (const id of ids) { const a = s.agents[id]; if (a.role === 'manager') assert.equal(M.reservedAt(Math.floor(a.x / 16), Math.floor(a.y / 16)), 0, 'manager ' + id + ' walks through a work place at t=' + t); }
    const vm = vmAt((t + 50) % LOOP_MS);
    for (const d of vm.deliveries) if (d.stage === 'on_truck' && s.items[d.id] && s.items[d.id].place !== 'truck') late += 50;
  }
  assert.ok(worst <= 1000, 'two walkers overlapped for ' + worst + ' ms');
  assert.ok(late <= 3000, 'crates lagged the view model for ' + late + ' ms in total');
});

test('work-order slips leave the counter: the newest stays, older ones go after a while or when a boss starts to plan', () => {
  const w = world();
  w.sync(baseVm());
  for (let i = 0; i < 5; i++) { w.fx('newOrder'); w.advance(1000); }
  assert.equal(w.state().counts.slips, 5);
  const plan = baseVm(); plan.agents[0].activity = 'think'; plan.agents[0].task = { id: 'P', title: 'plan', domain: 'plan', progress: 0 };
  w.sync(plan);
  assert.equal(w.state().counts.slips, 4, 'the boss took one order');
  w.sync(plan);
  assert.equal(w.state().counts.slips, 4, 'only when the planning starts');
  w.advance(SLIP_KEEP_MS);
  assert.equal(w.state().counts.slips, 1, 'the newest slip stays');
  w.advance(SLIP_KEEP_MS * 3);
  assert.equal(w.state().counts.slips, 1);
  w.fx('newOrder');
  assert.equal(w.state().counts.slips, 2, 'a new order stands out next to the last one');
});

test('motion effects: bursts of 4 to 6 sparks, two confetti waves, exhaust puffs, the lathe turns for machine work', () => {
  const w = world();
  w.sync(baseVm());                                   // K works on a backend task
  let peak = 0;
  for (let t = 0; t < 3000; t += 50) { w.advance(50); peak = Math.max(peak, w.state().counts.particles); }
  assert.ok(peak >= 4, 'a work burst has at least 4 particles (peak ' + peak + ')');
  assert.equal(w.state().lathe, true);
  assert.ok(w.w.particles.every((p) => typeof p.age === 'number'));
  const idle = baseVm(); idle.agents[2].activity = 'idle';
  w.sync(idle); w.advance(3000);
  assert.equal(w.state().lathe, false); assert.equal(w.state().counts.particles, 0);
  w.fx('confetti');
  const first = w.state().counts.particles;
  assert.ok(first >= 60);
  assert.ok(w.w.particles.some((p) => p.y > 150) && w.w.particles.some((p) => p.y < 60), 'the first wave covers the whole height');
  w.advance(900);
  assert.ok(w.state().counts.particles > first, 'a second wave follows');
  w.advance(9000);
  assert.equal(w.state().counts.particles, 0);
  w.sync(baseVm({ truck: { state: 'leaving', crates: 0 } }));
  w.sync(idle.truck ? idle : { ...idle, truck: { state: 'leaving', crates: 0 } });
  w.advance(1500);
  assert.ok(w.w.particles.filter((p) => p.kind === 'puff').length >= 3, 'exhaust puffs');
});

// ---------------------------------------------------------------- contract: buddy check, bench review, bell, ship

test('buddy_check: the buddy walks to the maker\'s bench, inspects the item there with a magnifier, then walks back', () => {
  const warned = [];
  const w = createWorld({ warn: (k, m) => warned.push(m), seed: 7 });
  w.sync(baseVm());
  w.advance(500);
  const d = { ...delivery('buddy_check'), buddyId: 'L' };
  w.sync(baseVm({ deliveries: [d] }));
  let s = w.state();
  assert.equal(s.items.D1.place, 'bench', 'the item stays on the maker\'s bench');
  assert.equal(s.agents.L.inspects, 'D1');
  let inspected = false;
  for (let t = 0; t < 10000; t += 50) { w.advance(50); assertOnFloor(w, 'buddy'); if (w.state().agents.L.inspecting) inspected = true; }
  s = w.state();
  assert.ok(inspected);
  assert.equal(s.agents.L.inspecting, true);
  assert.deepEqual([s.agents.L.x, s.agents.L.y], [M.benches[2].inspect.x, M.benches[2].inspect.y]);
  assert.equal(s.agents.L.face, 'left', 'the buddy faces the item');
  assert.equal(s.items.D1.place, 'bench');
  assert.equal(s.agents.K.atHome, true, 'the maker stays at the bench');
  // next in the contract order: the boss review in the office
  w.sync(baseVm({ deliveries: [{ ...d, stage: 'in_review' }] }));
  w.advance(15000);
  s = w.state();
  assert.equal(s.agents.L.atHome, true, 'the buddy walked back to its own bench');
  assert.equal(s.agents.L.inspecting, false);
  assert.equal(s.items.D1.place, 'desk');
  assert.deepEqual(warned, [], 'buddy_check is a known stage');
});

test('contract order to_office -> buddy_check -> in_review: a buddy-checked item waits on the bench and never shuttles', () => {
  for (const reviewerId of ['B', 'G']) {
    const w = world();
    w.sync(baseVm());
    w.advance(500);
    const d = { ...delivery('to_office'), buddyId: 'L', reviewerId };
    const errands = new Set(), places = new Set();
    const run = (ms) => { for (let t = 0; t < ms; t += 50) { w.advance(50); const s = w.state(); if (s.agents.K.errand) errands.add(s.agents.K.errand); places.add(s.items.D1.place); } };
    w.sync(baseVm({ deliveries: [d] }));
    run(3000);
    let s = w.state();
    assert.equal(s.items.D1.place, 'bench', 'checking happens on the bench');
    assert.equal(s.items.D1.checking, true);
    w.sync(baseVm({ deliveries: [{ ...d, stage: 'buddy_check' }] }));
    run(10000);
    assert.ok(!errands.has('fetch') && !errands.has('deliver'), 'the maker never carries the item around (' + [...errands] + ')');
    assert.deepEqual([...places], ['bench'], 'the item stays on the bench');
    assert.equal(w.state().agents.L.inspecting, true);
    // a reload at to_office lands on the bench as well
    const r = world();
    r.sync(baseVm({ deliveries: [d] }));
    assert.equal(r.state().items.D1.place, 'bench');
  }
  // without a buddy and with a boss reviewer, to_office still goes to the inbox
  const w = world();
  w.sync(baseVm({ deliveries: [delivery('to_office')] }));
  assert.equal(w.state().items.D1.place, 'inbox');
});

test('in_review by a manager happens at the maker\'s bench; by a boss at the office desk', () => {
  const w = world();
  w.sync(baseVm());
  w.advance(500);
  const d = { ...delivery('in_review'), reviewerId: 'G' };
  // to_office first (contract order): the item waits on the bench, nothing goes to an office
  w.sync(baseVm({ deliveries: [{ ...d, stage: 'to_office' }] }));
  for (let t = 0; t < 3000; t += 50) { w.advance(50); const s0 = w.state(); assert.equal(s0.items.D1.place, 'bench'); assert.equal(s0.agents.K.errand, null); }
  w.sync(baseVm({ deliveries: [d] }));
  w.advance(12000);
  let s = w.state();
  assert.equal(s.items.D1.place, 'bench', 'not in an office');
  assert.equal(s.agents.G.inspecting, true);
  assert.deepEqual([s.agents.G.x, s.agents.G.y], [M.benches[2].inspect.x, M.benches[2].inspect.y]);
  assert.deepEqual(s.queues, [], 'nothing waits in an office');
  // pass: a PASS stamp at the bench, the maker carries the crate to the staging pallet, the dolly loads it on the truck
  w.sync(baseVm({ deliveries: [{ ...d, stage: 'to_truck' }] }));
  w.advance(100);
  s = w.state();
  assert.equal(s.counts.stamps, 1, 'the verdict is stamped at the bench');
  let staged = false, office = false;
  for (let t = 0; t < 30000; t += 50) { w.advance(50); const p = w.state().items.D1.place; if (p === 'staging') staged = true; if (p === 'outbox' || p === 'inbox' || p === 'desk') office = true; }
  s = w.state();
  assert.ok(staged, 'the passed item went over the staging pallet');
  assert.ok(!office, 'a bench review never takes the item to a boss office');
  assert.equal(s.items.D1.place, 'truck');
  assert.equal(s.agents.G.atHome, true, 'the manager walked back to the post');
  // a boss reviewer: the desk in its office, nobody walks to the bench
  const w2 = world();
  w2.sync(baseVm({ deliveries: [delivery('in_review')] }));
  s = w2.state();
  assert.equal(s.items.D1.place, 'desk'); assert.equal(s.items.D1.office, 1);
  assert.ok(Object.values(s.agents).every((a) => !a.inspects));
  // a manager rejects at the bench: FAIL stamp, the item stays
  const w3 = world();
  w3.sync(baseVm({ deliveries: [d] }));
  w3.sync(baseVm({ deliveries: [{ ...d, stage: 'rejected' }] }));
  w3.advance(200);
  s = w3.state();
  assert.equal(s.items.D1.place, 'bench'); assert.equal(s.counts.stamps, 1);
});

test('beacon follows truck state ready only; owner.attention rings the counter bell instead', () => {
  const w = world();
  w.sync(baseVm({ truck: { state: 'docked', crates: 2 }, owner: { attention: false } }));
  let s = w.state();
  assert.equal(s.truck.crates, 2); assert.equal(s.truck.beacon, false); assert.equal(s.bell.ringing, false);
  w.sync(baseVm({ truck: { state: 'docked', crates: 2 }, owner: { attention: true } }));
  s = w.state();
  assert.equal(s.truck.beacon, false, 'a waiting owner question never lights the beacon');
  assert.equal(s.bell.ringing, true, 'the bell starts ringing at once');
  let on = 0, off = 0;
  for (let t = 0; t < 5400; t += 50) { w.advance(50); if (w.state().bell.ringing) on++; else off++; }
  assert.ok(on > 10 && off > 10, 'it rings again and again (' + on + ' on, ' + off + ' off)');
  w.sync(baseVm({ truck: { state: 'ready', crates: 2 }, owner: { attention: false } }));
  s = w.state();
  assert.equal(s.truck.beacon, true); assert.equal(s.truck.crates, 2);
  w.advance(2000);
  assert.equal(w.state().bell.ringing, false, 'no attention, no ring');
  w.fx('newOrder');
  assert.equal(w.state().bell.ringing, true, 'a new work order rings it once');
});

test("fx('ship') after the crates were marked shipped: they still ride away; without it they are unloaded", () => {
  const w = world();
  w.sync(baseVm({ deliveries: [delivery('on_truck')], truck: { state: 'ready', crates: 1 } }));
  assert.equal(w.state().items.D1.place, 'truck');
  w.sync(baseVm({ deliveries: [delivery('shipped')], truck: { state: 'docked', crates: 0 } }));
  w.fx('ship');
  w.advance(1500);
  let s = w.state();
  assert.equal(s.truck.phase, 'out'); assert.equal(s.truck.crates, 1, 'the shipped crate rides with the truck');
  w.advance(4000);
  assert.equal(w.state().truck.visible, false);
  w.advance(40000);
  s = w.state();
  assert.equal(s.truck.phase, 'parked'); assert.equal(s.truck.crates, 0); assert.equal(s.counts.items, 0);
  const w2 = world();
  w2.sync(baseVm({ deliveries: [delivery('on_truck')], truck: { state: 'ready', crates: 1 } }));
  w2.sync(baseVm({ deliveries: [delivery('shipped')], truck: { state: 'docked', crates: 0 } }));
  w2.advance(3000);
  s = w2.state();
  assert.equal(s.truck.phase, 'parked'); assert.equal(s.truck.crates, 0); assert.equal(s.counts.items, 0);
});

test('the demo loop shows a buddy check, a manager review at a bench, the bell with a docked truck and fx ship', () => {
  const stages = new Set(); let bellDocked = false, ship = false, inspect = { buddy: false, manager: false };
  const w = world();
  w.sync(vmAt(0));
  for (let t = 0; t < LOOP_MS; t += 100) {
    const vm = vmAt(t + 100);
    for (const d of vm.deliveries) stages.add(d.stage + (d.stage === 'in_review' ? ':' + d.reviewerId[0] : ''));
    applyScript({ sync: (v) => w.sync(v), fx: (n, p) => { if (n === 'ship') ship = true; w.fx(n, p); } }, t, t + 100);
    w.advance(100);
    const s = w.state();
    if (vm.owner.attention && vm.truck.state === 'docked' && s.bell.ringing && !s.truck.beacon) bellDocked = true;
    if (s.agents.K5.inspecting) inspect.buddy = true;
    if (s.agents.M2.inspecting) inspect.manager = true;
  }
  for (const st of ['buddy_check', 'in_review:M', 'in_review:B', 'rejected', 'to_truck', 'on_truck', 'shipped']) assert.ok(stages.has(st), st);
  assert.ok(bellDocked, 'the bell rings for an owner question while the truck is docked, without the beacon');
  assert.ok(ship, "fx('ship') fires in the loop");
  assert.deepEqual(inspect, { buddy: true, manager: true });
});

test('board notes: a tidy grid inside the cork, the oldest is replaced; unread mail on a fresh start shows plain notes', () => {
  const w = world();
  w.sync(baseVm());
  const inner = M.board.inner;
  for (let i = 0; i < 30; i++) {
    w.fx('note', { from: 'a', kind: ['ask', 'info', 'done', 'warn'][i % 4], text: 'n' + i });
    const ns = w.w.notes;
    assert.ok(ns.length <= LIMITS.notes);
    for (const n of ns) {
      // drawn at inner + 1 + (x, y): 8 x 8 plus a 1 px shadow stays inside the cork
      assert.ok(n.x >= 0 && n.y >= 0 && inner.x + 1 + n.x + 9 <= inner.x + inner.w && inner.y + 1 + n.y + 9 <= inner.y + inner.h, 'note ' + i + ' sticks out');
    }
    assert.equal(new Set(ns.map((n) => n.slot)).size, ns.length, 'one note per slot, no stacking');
  }
  assert.equal(w.w.notes.at(-1).text, 'n29');
  assert.equal(w.w.notes[0].text, 'n' + (30 - LIMITS.notes), 'the oldest notes were replaced');
  // a fresh start (or a reload) with unread messages: plain notes, already hanging (no drop-in)
  const r = world();
  r.sync(baseVm({ board: { unread: 4 } }));
  assert.equal(r.w.notes.length, 4);
  assert.ok(r.w.notes.every((n) => n.anon && n.t0 < -1e8));
  const big = world();
  big.sync(baseVm({ board: { unread: 120 } }));
  assert.equal(big.w.notes.length, 6, 'at most six plain notes');
  // a real note takes the place of a plain one
  r.fx('note', { from: 'Ada', kind: 'ask', text: 'Ship it?' });
  assert.equal(r.w.notes.length, 4);
  assert.equal(r.w.notes.filter((n) => n.anon).length, 3);
});

test('walkers do not stack into a totem: two makers who arrive together walk one behind the other with a gap', () => {
  const w = world();
  w.sync(baseVm());
  w.advance(500);
  const vm = baseVm();
  vm.agents.push({ id: 'N1', name: 'Cog', role: 'maker', provider: 'mock', spot: 6, activity: 'idle' }, { id: 'N2', name: 'Tack', role: 'maker', provider: 'mock', spot: 7, activity: 'idle' });
  w.sync(vm);
  let close = 0;
  for (let t = 0; t < 12000; t += 50) {
    w.advance(50);
    const s = w.state(), a = s.agents.N1, b = s.agents.N2;
    if ((a.moving || b.moving) && Math.abs(a.x - b.x) < 9 && Math.abs(a.y - b.y) < 18) close += 50;
  }
  const s = w.state();
  assert.ok(s.agents.N1.atHome && s.agents.N2.atHome, 'both reached their benches');
  assert.ok(close <= 400, 'they walked merged for ' + close + ' ms');
});

test('a truck that was driving off when the scene paused is empty once it snaps back to a docked truck with no crates', () => {
  const w = world();
  w.sync(baseVm({ deliveries: [delivery('on_truck')], truck: { state: 'ready', crates: 1 } }));
  w.advance(500);
  // the hub ships: the delivery turns shipped, the app plays leaving with the count of the ship
  w.sync(baseVm({ deliveries: [delivery('shipped')], truck: { state: 'leaving', crates: 1 } }));
  w.advance(400);
  assert.equal(w.state().truck.phase, 'out');
  // the window is hidden now: the app runs its truck timers to the end while the scene stands still
  w.sync(baseVm({ deliveries: [delivery('shipped')], truck: { state: 'away', crates: 1 } }));
  w.sync(baseVm({ deliveries: [delivery('shipped')], truck: { state: 'returning', crates: 0 } }));
  w.sync(baseVm({ deliveries: [delivery('shipped')], truck: { state: 'docked', crates: 0 } }));
  w.snap(); // the window is back after a long time
  const s = w.state();
  assert.equal(s.truck.phase, 'parked');
  assert.equal(s.truck.crates, 0, 'no crate stays on the bed of a docked truck that holds none');
});

test('a shipped crate that rides away as a ghost is not counted a second time', () => {
  const w = world();
  w.sync(baseVm({ deliveries: [delivery('on_truck', 'D1'), delivery('on_truck', 'D2')], truck: { state: 'ready', crates: 2 } }));
  w.advance(1000);
  w.sync(baseVm({ deliveries: [delivery('shipped', 'D1'), delivery('shipped', 'D2')], truck: { state: 'docked', crates: 0 } }));
  w.sync(baseVm({ deliveries: [delivery('shipped', 'D1'), delivery('shipped', 'D2')], truck: { state: 'leaving', crates: 2 } }));
  w.advance(300);
  const T = w.truckView();
  assert.equal(T.phase, 'out');
  assert.equal(T.total, 2, 'two crates leave, not four');
});
