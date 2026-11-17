// Scene view-model normalizer, differ and look derivation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, diff, createWarner, lookFromSeed, lookKey, progressStage, familyOf, officeOf, DOMAINS, FAMILIES, HAIR_STYLES, HEADGEAR, TOOLS, CAPACITY } from '../../ui/scene/model.js';

function collect() { const out = []; const warn = createWarner((m) => out.push(m)); return { warn, out }; }

test('garbage input never throws and yields an empty shop', () => {
  const junk = [undefined, null, 0, 'x', [], () => {}, { agents: 'no' }, { agents: [null, 1, 'a', [], {}] }, { deliveries: {} }, { truck: 7, board: 'b', owner: [] },
    { agents: [{ id: null }, { id: '  ' }, { id: undefined }] }, { shop: { jobTitle: { toString() { throw new Error('boom'); } } } }];
  for (const vm of junk) {
    const { warn } = collect();
    const m = normalize(vm, null, warn);
    assert.equal(m.agents.filter((a) => a.present).length, 0);
    assert.equal(m.deliveries.length, 0);
    assert.equal(m.truck.state, 'away');
  }
});

test('unknown role, provider, activity and domain fall back and warn once per kind', () => {
  const { warn, out } = collect();
  const vm = { agents: [
    { id: 'a', role: 'wizard', provider: 'acme', activity: 'dancing', task: { domain: 'cooking', progress: 7 } },
    { id: 'b', role: 'wizard', provider: 'acme', activity: 'dancing', task: { domain: 'cooking', progress: -3 } },
  ] };
  const m = normalize(vm, null, warn);
  normalize(vm, m, warn);
  assert.equal(m.agents[0].role, 'maker'); assert.equal(m.agents[0].provider, 'mock'); assert.equal(m.agents[0].activity, 'idle');
  assert.equal(m.agents[0].task.domain, 'backend');
  assert.equal(m.agents[0].task.progress, 1); assert.equal(m.agents[1].task.progress, 0);
  assert.equal(out.length, 4, 'one warning per kind: ' + out.join(' | '));
});

test('all 13 task domains are known and map to a tooling family', () => {
  assert.equal(DOMAINS.length, 13);
  for (const d of DOMAINS) assert.ok(FAMILIES.includes(familyOf(d)), d);
  assert.equal(familyOf('backend'), familyOf('algo')); assert.equal(familyOf('frontend'), familyOf('vision'));
  assert.equal(familyOf('research'), familyOf('synthesis')); assert.equal(familyOf('test'), familyOf('review'));
  assert.equal(familyOf('fix'), familyOf('chore')); assert.equal(familyOf('plan'), 'plan');
  assert.equal(familyOf('nonsense'), 'machine');
});

test('spots: explicit first, taken or missing gets the first free one, no spot left counts as overflow', () => {
  const agents = [];
  for (let i = 0; i < 11; i++) agents.push({ id: 'm' + i, role: 'maker', spot: i === 0 ? 3 : i === 1 ? 3 : undefined });
  agents.push({ id: 'b0', role: 'boss', spot: 2 }, { id: 'b1', role: 'boss', spot: 99 }, { id: 'off', role: 'maker', activity: 'off' });
  const m = normalize({ agents }, null, () => {});
  const spots = m.agents.filter((a) => a.role === 'maker' && a.present).map((a) => a.spot);
  assert.equal(spots.length, CAPACITY.maker);
  assert.equal(new Set(spots).size, CAPACITY.maker, 'no two makers share a bench');
  assert.equal(m.agentById.get('m0').spot, 3);
  assert.equal(m.agentById.get('m1').spot, 0);
  assert.equal(m.overflow, 3);
  assert.equal(m.agentById.get('b0').spot, 2); assert.equal(m.agentById.get('b1').spot, 0);
  assert.equal(m.agentById.get('off').present, false);
});

test('an agent keeps its bench between syncs when no spot is given', () => {
  const a = normalize({ agents: [{ id: 'x', role: 'maker', spot: 5 }, { id: 'y', role: 'maker' }] }, null, () => {});
  const b = normalize({ agents: [{ id: 'y', role: 'maker' }, { id: 'x', role: 'maker' }] }, a, () => {});
  assert.equal(b.agentById.get('x').spot, 5); assert.equal(b.agentById.get('y').spot, 0);
});

test('duplicate ids keep the first entry, deliveries with unknown stages are dropped', () => {
  const { warn, out } = collect();
  const m = normalize({
    agents: [{ id: 'a', name: 'First' }, { id: 'a', name: 'Second' }],
    deliveries: [{ id: 'd', stage: 'in_review', makerId: 'a' }, { id: 'd', stage: 'shipped' }, { id: 'e', stage: 'teleported' }, { stage: 'to_office' }, 5],
  }, null, warn);
  assert.equal(m.agents.length, 1); assert.equal(m.agents[0].name, 'First');
  assert.equal(m.deliveries.length, 1); assert.equal(m.deliveries[0].stage, 'in_review');
  assert.ok(out.length >= 4);
});

test('long strings are cut and huge lists are capped', () => {
  const agents = Array.from({ length: 500 }, (_, i) => ({ id: 'a' + i, name: 'N'.repeat(500) }));
  const deliveries = Array.from({ length: 500 }, (_, i) => ({ id: 'd' + i, stage: 'on_truck' }));
  const m = normalize({ agents, deliveries, truck: { state: 'docked', crates: 1e12 }, board: { unread: -5 } }, null, () => {});
  assert.ok(m.agents.length <= 48); assert.ok(m.deliveries.length <= 64);
  assert.ok(m.agents[0].name.length <= 16);
  assert.equal(m.truck.crates, 999); assert.equal(m.board.unread, 0);
});

test('the look derived from a seed is stable', () => {
  const golden = lookFromSeed(12345, 'maker');
  for (let i = 0; i < 5; i++) assert.deepEqual(lookFromSeed(12345, 'maker'), golden);
  assert.deepEqual(golden, { role: 'maker', skin: golden.skin, hairStyle: golden.hairStyle, hairColor: golden.hairColor, shirt: golden.shirt, apron: golden.apron, pants: golden.pants, gear: golden.gear, hat: golden.hat, tool: golden.tool, glasses: false, outfit: 'apron' });
  assert.ok(HAIR_STYLES.includes(golden.hairStyle)); assert.ok(HEADGEAR.includes(golden.hat)); assert.ok(TOOLS.includes(golden.tool));
  // the role is part of the derivation, and string seeds work too
  assert.notDeepEqual(lookFromSeed(12345, 'boss'), golden);
  assert.deepEqual(lookFromSeed('abc', 'maker'), lookFromSeed('abc', 'maker'));
  assert.equal(lookFromSeed(1, 'manager').hat, 'hardhat'); assert.equal(lookFromSeed(1, 'manager').tool, 'clipboard');
  assert.equal(lookFromSeed(1, 'boss').hat, 'none'); assert.equal(lookFromSeed(1, 'nobody').role, 'maker');
});

test('golden look values: a change here changes the face of every agent', () => {
  assert.equal(lookKey(lookFromSeed(12345, 'maker'), 'claude'), 'maker|2|bob|5|5|1|0|5|goggles|iron|0|apron|claude');
  assert.equal(lookKey(lookFromSeed(1101, 'boss'), 'claude'), 'boss|0|long|5|3|1|3|2|none|magnifier|1|vest|claude');
});

test('different seeds give visibly different people', () => {
  const keys = new Set();
  for (let s = 1; s <= 200; s++) keys.add(lookKey(lookFromSeed(s * 7919, 'maker'), 'mock'));
  assert.ok(keys.size > 190, 'only ' + keys.size + ' distinct looks in 200 seeds');
});

test('overrides for hat and tool apply to makers only', () => {
  assert.equal(lookFromSeed(5, 'maker', { hat: 'beanie', tool: 'saw' }).hat, 'beanie');
  assert.equal(lookFromSeed(5, 'maker', { hat: 'beanie', tool: 'saw' }).tool, 'saw');
  assert.equal(lookFromSeed(5, 'maker', { hat: 'crown' }).hat, lookFromSeed(5, 'maker').hat);
  assert.equal(lookFromSeed(5, 'boss', { hat: 'beanie' }).hat, 'none');
});

test('progress maps to four growth stages', () => {
  assert.deepEqual([0, 0.2, 0.25, 0.5, 0.74, 0.75, 1, 5, -1, NaN, 'x'].map(progressStage), [0, 0, 1, 2, 2, 3, 3, 3, 0, 0, 0]);
});

test('diff reports bubbles, activity and delivery stage changes', () => {
  const a = normalize({ agents: [{ id: 'k', role: 'maker', activity: 'work' }], deliveries: [{ id: 'd', stage: 'to_office', makerId: 'k' }], truck: { state: 'docked' } }, null, () => {});
  const b = normalize({ agents: [{ id: 'k', role: 'maker', activity: 'wait', bubble: { text: 'hi', seq: 2 } }], deliveries: [{ id: 'd', stage: 'in_review', makerId: 'k' }], truck: { state: 'ready' } }, a, () => {});
  const ev = diff(a, b);
  const types = ev.map((e) => e.type).sort();
  assert.deepEqual(types, ['activity', 'bubble', 'deliveryStage', 'truck']);
  assert.equal(diff(null, a).initial, true);
  assert.equal(diff(b, b).length, 0);
});

test('officeOf picks the reviewer office, else the first boss, else office 0', () => {
  const m = normalize({ agents: [{ id: 'b1', role: 'boss', spot: 2 }, { id: 'b2', role: 'boss', spot: 1 }], deliveries: [{ id: 'd1', stage: 'in_review', reviewerId: 'b2' }, { id: 'd2', stage: 'in_review', reviewerId: 'ghost' }] }, null, () => {});
  assert.equal(officeOf(m, m.deliveries[0]), 1); assert.equal(officeOf(m, m.deliveries[1]), 2);
  const empty = normalize({ deliveries: [{ id: 'd', stage: 'in_review' }] }, null, () => {});
  assert.equal(officeOf(empty, empty.deliveries[0]), 0);
});

test('buddy_check is a stage; normalize keeps buddyId; inspectorOf picks the buddy or a bench reviewer', async () => {
  const { STAGES, inspectorOf, reviewAtBench } = await import('../../ui/scene/model.js');
  assert.deepEqual(STAGES, ['to_office', 'buddy_check', 'in_review', 'rejected', 'to_truck', 'on_truck', 'shipped']);
  const { warn, out } = collect();
  const agents = [
    { id: 'B', role: 'boss', activity: 'idle' }, { id: 'G', role: 'manager', activity: 'review' },
    { id: 'K', role: 'maker', activity: 'wait' }, { id: 'L', role: 'maker', activity: 'review' }, { id: 'Z', role: 'maker', activity: 'off' },
  ];
  const m = normalize({ agents, deliveries: [
    { id: 'd1', makerId: 'K', buddyId: 'L', reviewerId: 'B', stage: 'buddy_check' },
    { id: 'd2', makerId: 'K', reviewerId: 'G', stage: 'in_review' },
    { id: 'd3', makerId: 'K', reviewerId: 'B', stage: 'in_review' },
    { id: 'd4', makerId: 'K', buddyId: 'Z', stage: 'buddy_check' },
    { id: 'd5', makerId: 'K', buddyId: 'K', stage: 'buddy_check' },
    { id: 'd6', makerId: 'K', stage: 'buddy_check' },
  ] }, null, warn);
  assert.deepEqual(out, [], 'no unknown-stage warning');
  const d = (id) => m.deliveryById.get(id);
  assert.equal(d('d1').buddyId, 'L'); assert.equal(d('d2').buddyId, '');
  assert.equal(inspectorOf(m, d('d1')).id, 'L');
  assert.equal(inspectorOf(m, d('d2')).id, 'G', 'a manager reviews at the bench');
  assert.equal(reviewAtBench(m, d('d2')), true); assert.equal(reviewAtBench(m, d('d3')), false);
  assert.equal(inspectorOf(m, d('d3')), null, 'a boss reviews in its office');
  assert.equal(inspectorOf(m, d('d4')), null, 'an absent buddy does not walk');
  assert.equal(inspectorOf(m, d('d5')), null, 'a maker is not its own buddy');
  assert.equal(inspectorOf(m, d('d6')), null, 'no buddy given');
});
