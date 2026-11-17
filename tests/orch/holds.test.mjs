// Holds and fallback, reviewer no-show and review time, consults, BLOCK, the job hold, mock jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeProviders, makeShop, samplePlan } from './harness.mjs';

const taskOf = (h, turn) => h.store.get('tasks', h.store.get('agents', turn.agentId).taskId);
const hang = () => new Promise(() => {});

test('a lab limit puts the task on hold; past holdFallbackMin a maker of the other lab takes the bench', async (t) => {
  let limited = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (!limited && turn.agent.provider === 'claude') {
          limited = true;
          hh.providers.cooledModels.add('claude-maker');
          return { error: { kind: 'rate_limit', message: 'limit', model: 'claude-maker', resetAt: null } };
        }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  let task = h.store.get('tasks', 'T1');
  assert.ok(task.hold, 'the task is on hold');
  assert.equal(task.hold.model, 'claude-maker');
  assert.equal(task.attempts, 0);
  assert.equal(h.job().status, 'running');
  const old = task.assigneeId;
  await h.advance(21 * 60000);
  task = h.store.get('tasks', 'T1');
  assert.notEqual(task.assigneeId, old);
  assert.equal(h.store.get('agents', task.assigneeId).provider, 'gemini');
  assert.equal(h.store.get('agents', old).status, 'off');
  const takeover = h.turns('work').find((x) => x.agentId === task.assigneeId);
  assert.equal(takeover.resume, false);
  assert.match(takeover.prompt, /take over this task/);
  assert.equal(h.job().status, 'delivering');
});

test('a hold is released when the model is usable again: the same maker resumes its session', async (t) => {
  let limited = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (!limited) {
          limited = true;
          hh.providers.cooledModels.add(turn.agent.model);
          return { error: { kind: 'rate_limit', message: 'limit', model: turn.agent.model, resetAt: hh.clock.now() + 60000 } };
        }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  const task = h.store.get('tasks', 'T1');
  assert.ok(task.hold?.until, 'a hold with a release time');
  assert.equal(h.job().status, 'running', 'no stall while a hold has a release time');
  h.providers.cooledModels.clear();
  await h.orch.tick();
  await h.settle();
  const works = h.turns('work');
  assert.equal(works.at(-1).agentId, works[0].agentId);
  assert.equal(h.job().status, 'delivering');
});

test('a main turn hold (QA) sits on the agent and runs again when its lab is back', async (t) => {
  let limited = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      qa: async (turn, hh) => {
        if (limited) return undefined;
        limited = true;
        hh.providers.cool(turn.agent.provider);
        return { error: { kind: 'auth', message: 'signed out', resetAt: null } };
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const [first, second] = h.turns('qa');
  assert.ok(h.store.get('agents', first.agentId).hold, 'the QA agent is on hold');
  const lead = h.job().leadBossId;
  assert.equal(second.agentId, lead, 'QA moves to the lead (fresh session) while the other lab waits');
  assert.equal(second.resume, false);
  assert.equal(h.job().status, 'delivering');
  h.providers.release(h.store.get('agents', first.agentId).provider);
  await h.orch.tick();
  await h.settle();
  assert.equal(h.store.get('agents', first.agentId).hold, null, 'the hold is released when the lab is back');
});

test('no usable lab: the job shows job.hold and raises one owner notice', async (t) => {
  let once = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (once) return undefined;
        once = true;
        hh.providers.cool('claude');
        hh.providers.cool('gemini');
        return { error: { kind: 'rate_limit', message: 'x', resetAt: null } };
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const job = h.job();
  assert.ok(job.hold, 'job.hold is set');
  assert.equal(job.hold.reason, 'lab');
  assert.equal(h.notices.filter((n) => /no lab can run now/.test(n.text)).length, 1);
  h.providers.release('claude');
  h.providers.release('gemini');
  await h.settle();
  assert.equal(h.job().hold, null);
  assert.equal(h.job().status, 'delivering');
});

test('reviewer no-show: a nudge, the next reviewer, then the delivery waits for @human; the owner verdict applies', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }), brainHooks: { review: async () => ({}) } });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  const reviews = h.turns('review');
  assert.equal(reviews.length, 4, reviews.map((x) => x.handle).join(','));
  assert.equal(reviews[1].resume, true);
  assert.match(reviews[1].prompt, /without a verdict/);
  assert.notEqual(reviews[0].agentId, reviews[2].agentId, 'the second reviewer is another agent');
  const d = h.deliveries().find((x) => x.status === 'review');
  assert.equal(d.waitHuman, true);
  assert.equal(d.reviewers.length, 2);
  const item = h.orch.inbox('J1').find((i) => i.kind === 'review');
  assert.ok(item);
  const res = h.orch.ownerPost({ jobId: 'J1', kind: 'PASS', re: d.doneMsgId, body: 'Looks right.' });
  assert.equal(res.ok, true, JSON.stringify(res));
  await h.settle();
  assert.equal(h.store.get('deliveries', d.id).review.by, '@human');
  assert.equal(h.job().status, 'delivering');
});

test('the review time of a DONE ends on shop time: the running review stops and the next reviewer takes it', async (t) => {
  let first = true;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: { review: async () => { if (first) { first = false; return hang(); } return undefined; } },
  });
  t.after(() => h.close());
  h.orch.createJob({ title: 'x', brief: 'y', kind: 'build', project: { mode: 'new', name: 'p' }, crew: { bosses: 1, managers: 1, makers: 1 } });
  await h.orch.recover();
  await h.until(() => h.turns('review').length === 1);
  await h.advance(21 * 60000);
  await h.settle();
  const reviews = h.turns('review');
  assert.equal(reviews.length, 2);
  assert.notEqual(reviews[0].agentId, reviews[1].agentId);
  assert.equal(h.job().status, 'delivering');
});

test('ASK @other from a maker starts a consult of the other lab in its bench; the ANS wakes the asker', async (t) => {
  let asked = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (!asked) { asked = true; await turn.post(`ASK @other ${taskOf(hh, turn).id}: How do I export two names from mod1/index.js?`); return {}; }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  const c = h.turns('consult')[0];
  assert.ok(c, 'a consult turn ran');
  const maker = h.store.get('agents', h.turns('work')[0].agentId);
  assert.notEqual(h.store.get('agents', c.agentId).provider, maker.provider);
  assert.equal(c.access, 'read');
  assert.equal(c.cwd, h.turns('work')[0].cwd);
  assert.match(c.prompt, /CONSULT on T1/);
  const ans = h.msgs().find((m) => m.kind === 'ANS' && m.fromId === c.agentId);
  assert.ok(ans);
  assert.ok(h.turns('work').length >= 2, 'the answer woke the maker');
  assert.equal(h.job().status, 'delivering');
});

test('ASK @other with no other lab: the hub answers NO why=env and the maker gets the no-help line', async (t) => {
  let asked = false;
  const h = await makeShop({
    routerOnly: ['claude'],
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (!asked) { asked = true; await turn.post(`ASK @other ${taskOf(hh, turn).id}: How do I export two names from mod1/index.js?`); return {}; }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 0, makers: 1 } });
  const no = h.msgs().find((m) => m.kind === 'NO' && m.from === '@hub');
  assert.ok(no);
  assert.equal(no.slots.why, 'env');
  assert.ok(h.turns('work').some((x) => /No help is available/.test(x.prompt)));
});

test('BLOCK with why=tests: the hub consults the other lab first, answers the BLOCK, and the task works again', async (t) => {
  let blocked = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (!blocked) { blocked = true; await turn.post(`BLOCK ${taskOf(hh, turn).id} why=tests: The check fails for a reason I do not see.`); return {}; }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  assert.equal(h.turns('consult').length, 1);
  assert.ok(h.msgs().some((m) => m.kind === 'ANS' && m.from === '@hub' && /consult/.test(m.body)));
  assert.equal(h.store.get('tasks', 'T1').blocks, 1);
  assert.equal(h.job().status, 'delivering');
});

test('BLOCK to the manager: the task is blocked (ask) until the ANS; more than maxBlocks fails the task', async (t) => {
  let n = 0;
  const h = await makeShop({
    limits: { maxBlocks: 1 },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        n++;
        if (n <= 2) { await turn.post(`BLOCK ${taskOf(hh, turn).id} why=unclear: I do not know the export name for mod1.`); return {}; }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  const task = h.store.get('tasks', 'T1');
  assert.equal(task.blocks, 2);
  assert.equal(task.status === 'failed' || h.job().status === 'paused', true);
  assert.ok(h.msgs().some((m) => m.kind === 'ANS' && m.from === '@f1'), 'the manager answered the first BLOCK');
});

test('a mock job uses the mock lab for every agent and bypasses the router', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 2 }) });
  t.after(() => h.close());
  h.router.pick = () => { throw new Error('the router must not be used'); };
  await h.start({ options: { mock: true }, crew: 'standard' });
  assert.equal(h.job().status, 'delivering');
  const models = new Set(h.agents().map((a) => a.model));
  assert.ok(h.agents().every((a) => a.provider === 'mock'));
  assert.ok([...models].every((m) => ['mock-boss', 'mock-manager', 'mock-maker'].includes(m)));
});

test('a lab with no self-test pass for its CLI version: the hub runs the self-test once (when ready), then uses the lab', async (t) => {
  const providers = createFakeProviders();
  let ran = 0;
  providers.cooled.add('gemini');
  const base = providers.status;
  providers.status = (id) => (id === 'gemini' && providers.cooled.has('gemini') ? { ...base(id), reason: 'Run the self-test for this CLI version.', version: '1.5.1' } : base(id));
  providers.ready = () => ({ ok: true, reason: null });
  providers.selfTest = async (id) => { ran++; providers.release(id); return { ok: true }; };
  const h = await makeShop({ providers, planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start();
  await h.orch.tick();
  await h.settle();
  assert.equal(ran, 1);
  assert.equal(h.job().status, 'delivering');
});
