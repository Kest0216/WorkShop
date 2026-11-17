// Job lifecycle: queue and promotion, pause (soft and hard) and resume, cancel with saved refs, delete,
// the budget stop, caps and the circuit breaker, and the stall rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeShop, ownerGit, samplePlan } from './harness.mjs';

const taskOf = (h, turn) => h.store.get('tasks', h.store.get('agents', turn.agentId).taskId);
const done = (task) => `DONE ${task.id} tests=1/1 acc=${task.acceptance.length}/${task.acceptance.length}: I wrote the module for ${task.id}.`;

test('queue: a second job waits (queued, waits for J1) and is promoted when the first one is done', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start();
  const j2 = h.orch.createJob({ title: 'Second', brief: 'Another one.', kind: 'build', project: { mode: 'new', name: 'two' }, crew: 'solo' });
  await h.settle();
  assert.equal(h.job('J2').status, 'queued');
  assert.equal(h.job('J2').waitReason, 'waits for J1');
  assert.equal(h.job('J2').integrationBranch, null, 'intake runs at promotion, not at creation');
  const truck = await h.orch.truck('J1');
  await h.orch.ship('J1', { sha: truck.headSha });
  await h.settle();
  assert.equal(h.job('J1').status, 'done');
  const two = h.job(j2.id);
  assert.equal(two.status, 'delivering', `${two.status} ${two.error}`);
  assert.equal(two.waitReason, null);
});

test('resume is refused while another job is active', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start();
  h.orch.pauseJob('J1');
  h.orch.createJob({ title: 'Second', brief: 'Another one.', kind: 'build', project: { mode: 'new', name: 'two' }, crew: 'solo' });
  await h.settle();
  assert.equal(h.job('J2').status, 'queued', 'a paused job is still active');
  await h.orch.cancelJob('J1');
  await h.settle();
  assert.equal(h.job('J2').status, 'delivering');
  await assert.rejects(() => h.orch.resumeJob('J1'), /not paused/);
});

test('pause stops scheduling, running turns finish; hard pause interrupts; resume returns to prevStatus', async (t) => {
  let release = null;
  let first = true;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (!first) return undefined;
        first = false;
        await new Promise((resolve) => { release = resolve; });
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  h.orch.createJob({ title: 'x', brief: 'y', kind: 'build', project: { mode: 'new', name: 'p' }, crew: { bosses: 1, managers: 0, makers: 1 } });
  await h.orch.recover();
  await h.until(() => Boolean(release));
  h.orch.pauseJob('J1');
  assert.equal(h.job().status, 'paused');
  assert.equal(h.job().prevStatus, 'running');
  assert.equal(h.job().pauseReason, 'owner');
  h.orch.pauseJob('J1', { hard: true });
  assert.equal(h.job().prevStatus, 'running', 'a second pause keeps prevStatus');
  await h.settle();
  assert.equal(h.runner.busy(h.store.get('tasks', 'T1').assigneeId), false, 'the hard pause interrupted the turn');
  assert.equal(h.store.get('tasks', 'T1').status, 'working');
  const before = h.turns('work').length;
  await h.orch.tick();
  await h.settle();
  assert.equal(h.turns('work').length, before, 'nothing starts while paused');
  await h.orch.resumeJob('J1');
  await h.settle();
  const work = h.turns('work');
  assert.equal(work.length, before + 1);
  assert.equal(work.at(-1).resume, true, 'the interrupted session resumes');
  assert.equal(h.job().status, 'delivering');
});

test('cancel: turns stop, every bench is saved to refs/workshop/<job>/<task>, folders go; delete removes the rest', async (t) => {
  let started = 0;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 2 }),
    brainHooks: {
      work: async (turn, hh) => {
        hh.write(turn.cwd, `${taskOf(hh, turn).zones[0].replace('/**', '')}/wip.js`, 'export const wip = 1;\n');
        started++;
        await new Promise(() => {});
      },
    },
  });
  t.after(() => h.close());
  h.orch.createJob({ title: 'x', brief: 'y', kind: 'build', project: { mode: 'new', name: 'p' }, crew: { bosses: 1, managers: 0, makers: 2 } });
  await h.orch.recover();
  await h.until(() => started === 2 && h.tasks().every((x) => x.benchDir));
  const benches = h.tasks().map((x) => x.benchDir);
  await h.orch.cancelJob('J1');
  await h.settle();
  const job = h.job();
  assert.equal(job.status, 'cancelled');
  assert.equal(h.runner.active().length, 0);
  for (const b of benches) assert.equal(fs.existsSync(b), false);
  const project = h.store.get('projects', job.projectId);
  const refs = ownerGit(project.path, h.env, 'for-each-ref', '--format=%(refname)', 'refs/workshop/J1/');
  assert.match(refs, /refs\/workshop\/J1\/T1/);
  assert.ok(h.tasks().every((x) => x.status === 'cancelled' && x.savedRef));
  assert.ok(h.agents().every((a) => a.status === 'off'));
  await h.orch.deleteJob('J1');
  const gone = h.job();
  assert.equal(gone.deleted, true);
  assert.equal(gone.title, 'x');
  assert.equal(h.tasks().length, 0);
  assert.equal(h.agents().length, 0);
  assert.equal(ownerGit(project.path, h.env, 'for-each-ref', 'refs/workshop/J1/'), '');
});

test('cancel with a loaded truck keeps the integration branch; ship loaded crates still works', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start();
  await h.orch.cancelJob('J1');
  const job = h.job();
  assert.equal(job.truckKept, true);
  const project = h.store.get('projects', job.projectId);
  assert.ok(ownerGit(project.path, h.env, 'rev-parse', 'ws/J1/int'));
  const r = await h.orch.ship('J1', { sha: job.intSha });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(ownerGit(project.path, h.env, 'ls-tree', '-r', '--name-only', 'main'), /mod1\/index\.js/);
  // Section 12, cancel: after Ship the integration branch goes too; the saved task refs stay until Delete.
  assert.equal(ownerGit(project.path, h.env, 'for-each-ref', '--format=%(refname)', 'refs/heads/ws/J1/'), '');
  assert.match(ownerGit(project.path, h.env, 'for-each-ref', '--format=%(refname)', 'refs/workshop/J1/'), /refs\/workshop\/J1\/T1/);
  assert.equal(h.job().truckKept, false);
});

test('budget stop: billed cost at the budget pauses the job (budget); resume needs a higher budget', async (t) => {
  let billed = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (billed) return undefined;
        billed = true;
        const job = hh.job();
        hh.store.patch('jobs', job.id, { cost: { ...job.cost, billedUsd: 5 } });
        return { killed: 'interrupt' };
      },
    },
  });
  t.after(() => h.close());
  await h.start({ budgetUsd: 5 });
  assert.equal(h.job().status, 'paused');
  assert.equal(h.job().pauseReason, 'budget');
  assert.ok(h.orch.inbox('J1').some((i) => i.kind === 'budget'));
  await assert.rejects(() => h.orch.resumeJob('J1'), /budgetUsd above/);
  await h.orch.resumeJob('J1', { budgetUsd: 10 });
  await h.settle();
  assert.equal(h.job().status, 'delivering');
});

test('createJob refuses a job without budgetUsd when a usable lab is in apikey mode (not for mock jobs)', async (t) => {
  const h = await makeShop({ settings: { auth: { claude: 'apikey', gemini: null } } });
  t.after(() => h.close());
  assert.throws(() => h.orch.createJob({ title: 'x', brief: 'y', kind: 'build', project: { mode: 'new', name: 'p' } }), /budgetUsd/);
  assert.ok(h.orch.createJob({ title: 'x', brief: 'y', kind: 'build', project: { mode: 'new', name: 'p' }, budgetUsd: 3 }));
  assert.ok(h.orch.createJob({ title: 'm', brief: 'y', kind: 'build', project: { mode: 'new', name: 'p' }, options: { mock: true } }));
});

test('caps: task_add at maxTasksTotal is refused and pauses the job (caps)', async (t) => {
  let answer = null;
  const h = await makeShop({
    limits: { maxTasksTotal: 1 },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      review: async (turn) => {
        if (answer) return undefined;
        answer = await turn.call('task_add', { title: 'More', spec: 'More work.', acceptance: ['Done.'], zones: ['more/**'], domain: 'backend', size: 'S' });
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.match(answer, /limit is 1/);
  assert.equal(h.job().status, 'paused');
  assert.equal(h.job().pauseReason, 'caps');
});

test('circuit breaker: 3 hand-ins in a row from different tasks refused for the same cause pause the job (caps)', async (t) => {
  const h = await makeShop({
    planFor: () => samplePlan({ n: 3, check: 'false' }),
    brainHooks: {
      work: async (turn, hh) => {
        const task = taskOf(hh, turn);
        hh.write(turn.cwd, `${task.zones[0].replace('/**', '')}/index.js`, '1\n');
        await turn.post(done(task));
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 0, makers: 3 } });
  const job = h.job();
  assert.equal(job.status, 'paused');
  assert.equal(job.pauseReason, 'caps');
  assert.match(job.error, /same cause \(check\)/);
});

test('task_retry at maxRetries is refused and trips the breaker; attempts reset and retries rise', async (t) => {
  const answers = [];
  const h = await makeShop({
    limits: { maxRetries: 1 },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        const task = taskOf(hh, turn);
        await turn.post(`FAIL ${task.id} why=unknown: The module cannot be written.`);
        return {};
      },
      manager: async (turn, hh) => {
        const task = hh.store.get('tasks', 'T1');
        if (task?.status === 'failed') answers.push(await turn.call('task_retry', { id: 'T1', note: 'Try a smaller step.' }));
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.match(answers[0], /^ok/, JSON.stringify(answers));
  assert.match(answers[1], /limit is 1/);
  const task = h.store.get('tasks', 'T1');
  assert.equal(task.retries, 1);
  assert.equal(h.job().pauseReason, 'caps');
  const retryTurn = h.turns('work').find((x) => /RETRY of T1/.test(x.prompt));
  assert.ok(retryTurn, 'the retry turn has the retry prompt');
  assert.equal(retryTurn.resume, false, 'a retry starts a fresh session');
  assert.match(retryTurn.prompt, /NOTE FROM YOUR MANAGER: Try a smaller step\./);
});

test('stall rule: nothing can start: the lead gets one stall digest, then the job pauses (stalled)', async (t) => {
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        await turn.post(`FAIL ${taskOf(hh, turn).id} why=unknown: It cannot be done.`);
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const stall = h.turns('stall');
  assert.equal(stall.length, 1);
  assert.match(stall[0].prompt, /STALL in work order J1/);
  assert.match(stall[0].prompt, /T1 is failed/);
  assert.equal(h.job().status, 'paused');
  assert.equal(h.job().pauseReason, 'stalled');
  assert.ok(h.turns('digest').some((x) => x.role === 'manager'), 'the manager was woken for the failed task first');
});

test('createJob validates its input; delete refuses a live job; discard drops the crates of a cancelled job', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  assert.throws(() => h.orch.createJob({ title: '', brief: 'x' }), /title/);
  assert.throws(() => h.orch.createJob({ title: 'x', brief: 'y', kind: 'paint' }), /kind/);
  assert.throws(() => h.orch.createJob({ title: 'x', brief: 'y', project: { mode: 'existing' } }), /folder path/);
  assert.throws(() => h.orch.createJob({ title: 'x', brief: 'y', crew: 'huge' }), /Unknown crew preset/);
  assert.throws(() => h.orch.createJob({ title: 'x', brief: 'y', crew: { bosses: 0, managers: 0, makers: 1 } }), /crew needs/);
  await h.start();
  await assert.rejects(() => h.orch.deleteJob('J1'), /done or cancelled/);
  await h.orch.cancelJob('J1');
  assert.deepEqual(h.orch.inbox('J1').map((i) => i.kind), ['truck'], 'a cancelled job asks only about its loaded truck');
  await h.orch.discardTruck('J1');
  assert.deepEqual(h.orch.inbox('J1'), [], 'an empty truck: nothing waits');
  assert.equal(h.deliveries().filter((d) => d.status === 'loaded').length, 0);
  assert.equal(h.job().truckKept, false);
  const project = h.store.get('projects', h.job().projectId);
  assert.equal(ownerGit(project.path, h.env, 'for-each-ref', '--format=%(refname)', 'refs/heads/ws/J1/'), '', 'after Discard the integration branch goes');
  assert.equal((await h.orch.ship('J1', { sha: h.job().intSha })).ok, false);
});
