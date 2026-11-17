// Tool rules: task_update (manager vs boss), task_cancel (dependents, replacedBy, the requirement rule), task_add
// zones and claims, req_add guards, owner task actions, status, and the tool registry on mcp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFS } from '../../server/orchestrator.js';
import { makeShop, samplePlan } from './harness.mjs';

/** A shop whose job waits in plan_review, so tools can be called on planned tasks without turns running. */
async function reviewShop(t, plan = samplePlan({ n: 3, chain: true }), crew = { bosses: 1, managers: 1, makers: 1 }) {
  const h = await makeShop({ planFor: () => plan });
  t.after(() => h.close());
  await h.start({ options: { approvePlan: true }, crew });
  assert.equal(h.job().status, 'plan_review');
  const call = async (handle, name, args) => {
    const agent = h.agents().find((a) => a.handle === handle);
    const token = h.mcp.tokenFor(agent.id);
    const res = await h.mcp.handle(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    h.mcp.revoke(agent.id);
    return res.result?.content?.[0]?.text ?? res.error?.message;
  };
  return { h, call };
}

test('every hub tool of section 8 is registered with its roles, a one-line description and an input schema', async (t) => {
  const h = await makeShop();
  t.after(() => h.close());
  const names = ['plan_submit', 'task_add', 'task_update', 'task_retry', 'task_cancel', 'claim', 'status', 'req_add', 'req_verify', 'job_report'];
  assert.deepEqual(Object.keys(TOOL_DEFS).sort(), [...names].sort());
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    assert.ok(def.description.length < 110 && !def.description.includes('\n'), name);
    assert.equal(def.inputSchema.type, 'object', name);
  }
  const boss = h.mcp.toolsFor('boss').map((x) => x.name);
  const manager = h.mcp.toolsFor('manager').map((x) => x.name);
  const maker = h.mcp.toolsFor('maker').map((x) => x.name);
  assert.ok(boss.includes('plan_submit') && boss.includes('job_report') && boss.includes('task_add'));
  assert.ok(!manager.includes('plan_submit') && manager.includes('task_retry') && manager.includes('req_verify'));
  assert.deepEqual(maker.filter((n) => names.includes(n)), ['claim']);
});

test('task_update: a manager may add acceptance items and edit zones, deps and note; rewording needs a boss', async (t) => {
  const { h, call } = await reviewShop(t);
  const card = h.store.get('tasks', 'T1').acceptance;
  assert.match(await call('@f1', 'task_update', { id: 'T1', acceptance: [...card, 'It has a test.'] }), /^ok/);
  assert.match(await call('@f1', 'task_update', { id: 'T1', acceptance: ['Something else.'] }), /Only a boss removes or rewords/);
  assert.match(await call('@f1', 'task_update', { id: 'T1', allowLarge: true }), /Only a boss/);
  assert.match(await call('@f1', 'task_update', { id: 'T1', note: 'Keep it short.' }), /^ok/);
  assert.equal(h.store.get('tasks', 'T1').note, 'Keep it short.');
  assert.match(await call('@b1', 'task_update', { id: 'T1', acceptance: ['Something else.'] }), /^ok/);
  const changed = h.store.get('tasks', 'T1');
  assert.equal(changed.cardChanges.length, 1);
  assert.match(changed.cardChanges[0].what, /removed or reworded/);
  assert.ok(h.msgs().some((m) => m.kind === 'EVT' && m.scope === '#plan' && /card changed by @b1/.test(m.body)));
});

test('task_update: zones under hub paths, overlap with unordered open tasks, cycles and unserved requirements are refused', async (t) => {
  const { h, call } = await reviewShop(t);
  assert.match(await call('@b1', 'task_update', { id: 'T1', zones: ['.agents/**'] }), /hub files/);
  assert.match(await call('@b1', 'task_update', { id: 'T1', zones: ['mod2/**'] }), /overlap open tasks T2/);
  assert.match(await call('@b1', 'task_update', { id: 'T1', deps: ['T3'] }), /cycle/);
  assert.match(await call('@b1', 'task_update', { id: 'T1', reqs: [] }), /R1 would have no open or merged task/);
  assert.match(await call('@b1', 'task_update', { id: 'T3', zones: ['mod1/x/**'] }), /^ok/, 'T3 depends on T1: ordered');
});

test('task_cancel: dependents need replacedBy; the requirement rule holds; dependents move to replacedBy', async (t) => {
  const { h, call } = await reviewShop(t);
  assert.match(await call('@b1', 'task_cancel', { id: 'T1', reason: 'Not needed.' }), /has dependents \(T3\)/);
  assert.match(await call('@b1', 'task_cancel', { id: 'T1', reason: 'Not needed.', replacedBy: ['T2'] }), /R1 would have no open or merged task/);
  assert.match(await call('@b1', 'task_add', { title: 'New one', spec: 'Replace T1.', acceptance: ['Works.'], zones: ['new/**'], domain: 'backend', size: 'S', reqs: ['R1'] }), /^ok T4/);
  assert.match(await call('@b1', 'task_cancel', { id: 'T1', reason: 'Split differently.', replacedBy: ['T4'] }), /^ok/);
  assert.equal(h.store.get('tasks', 'T1').status, 'cancelled');
  assert.deepEqual(h.store.get('tasks', 'T3').deps.sort(), ['T2', 'T4']);
});

test('task_add: zones that overlap an open task (claims included) need deps; deps and reqs must exist', async (t) => {
  const { h, call } = await reviewShop(t);
  h.store.patch('tasks', 'T2', { claims: ['shared/x.js'] });
  assert.match(await call('@f1', 'task_add', { title: 'A', spec: 'b', acceptance: ['c'], zones: ['shared/**'], domain: 'backend', size: 'S' }), /overlap open tasks T2/);
  assert.match(await call('@f1', 'task_add', { title: 'A', spec: 'b', acceptance: ['c'], zones: ['shared/**'], domain: 'backend', size: 'S', deps: ['T2'] }), /^ok T4/);
  assert.match(await call('@f1', 'task_add', { title: 'A', spec: 'b', acceptance: ['c'], zones: ['q/**'], domain: 'backend', size: 'S', deps: ['T99'] }), /not a task/);
  assert.match(await call('@f1', 'task_add', { title: 'A', spec: 'b', acceptance: ['c'], zones: ['q/**'], domain: 'backend', size: 'S', reqs: ['R9'] }), /not a requirement/);
  assert.match(await call('@f1', 'task_add', { title: 'A', spec: 'b', acceptance: ['c'], zones: ['.shop/x'], domain: 'backend', size: 'S' }), /hub files/);
  assert.equal(h.store.get('tasks', 'T4').managerId, h.store.get('tasks', 'T2').managerId, 'no stream: the stream of the first dep');
});

test('req_add: a boss may add; a manager only as the agent of an audit or QA turn', async (t) => {
  const { h, call } = await reviewShop(t);
  assert.match(await call('@f1', 'req_add', { text: 'It runs offline.', why: 'The brief says offline.' }), /only for a boss|for a boss, or the agent/);
  assert.match(await call('@b1', 'req_add', { text: 'It runs offline.', why: 'The brief says offline.' }), /^ok R4/);
  const r = h.job().requirements.find((x) => x.id === 'R4');
  assert.equal(r.source, 'boss');
  assert.ok(h.notices.some((n) => n.level === 'info' && /added R4/.test(n.text)));
  assert.match(await call('@f1', 'req_verify', { results: [] }), /only for the agent of the running QA turn/);
});

test('status gives a compact table of tasks and agents', async (t) => {
  const { call } = await reviewShop(t);
  const text = await call('@f1', 'status', {});
  assert.match(text, /T1 planned - Module 1/);
  assert.match(text, /@b1 boss/);
});

test('owner task actions: stop (blocked why owner, no manager wake), retry with a note, cancel with the rules', async (t) => {
  let stopNow = null;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: { work: async (turn, hh) => { if (!stopNow) { stopNow = true; return new Promise(() => {}); } return undefined; } },
  });
  t.after(() => h.close());
  h.orch.createJob({ title: 'x', brief: 'y', kind: 'build', project: { mode: 'new', name: 'p' }, crew: { bosses: 1, managers: 1, makers: 1 } });
  await h.orch.recover();
  await h.until(() => h.runner.active().some((id) => h.store.get('agents', id)?.role === 'maker'));
  const stopped = h.orch.stopTask('T1', { note: 'Wrong approach.' });
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.why, 'owner');
  assert.equal(stopped.needsAction, null);
  await h.settle();
  assert.equal(h.store.get('tasks', 'T1').status, 'blocked', 'the owner retries or cancels a stopped task');
  assert.throws(() => h.orch.cancelTask('T1', { reason: 'x' }), /R1 would have no open or merged task/);
  h.orch.retryTask('T1', { note: 'Use a plain export.' });
  await h.settle();
  assert.ok(h.turns('work').some((x) => /Use a plain export\./.test(x.prompt)));
  assert.equal(h.job().status, 'delivering');
});

test('ownerPost sends any ShopTalk kind as @human; REQ to an agent wakes it', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start({ options: { approvePlan: true } });
  const res = h.orch.ownerPost({ jobId: 'J1', kind: 'REQ', to: '@b1', scope: '#plan', body: 'Report what is slow.' });
  assert.equal(res.ok, true, JSON.stringify(res));
  await h.settle();
  assert.ok(h.msgs().some((m) => m.kind === 'OK' && m.re === res.msg.id), 'the lead answered the REQ');
  const bad = h.orch.ownerPost({ jobId: 'J1', kind: 'PASS', body: 'x' });
  assert.equal(bad.ok, false);
});
