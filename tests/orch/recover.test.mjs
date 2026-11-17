// Restart (recover) at every stage: the first hub instance stops mid-turn (a crash: nothing more runs or writes),
// a second instance on the same data dir runs recover() and the job finishes. tick() derives every start from
// persisted state, so nothing waits on memory of the first instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeShop, samplePlan } from './harness.mjs';

const hang = () => new Promise(() => {});
const taskOf = (h, turn) => h.store.get('tasks', h.store.get('agents', turn.agentId).taskId);

/**
 * Run a job until `hooks` reach the crash point (it sets crashed = true and hangs), crash, restart, finish.
 * Returns the second shop (already settled).
 */
async function restartAt(t, { hooks, plan = () => samplePlan({ n: 2 }), settings = {}, crew = { bosses: 1, managers: 1, makers: 2 }, after = null }) {
  const state = { crashed: false };
  const h1 = await makeShop({ planFor: plan, settings, brainHooks: hooks(state) });
  h1.orch.createJob({ title: 'Restart job', brief: 'Build modules.', kind: 'build', project: { mode: 'new', name: 'r' }, crew });
  await h1.orch.recover();
  // Wait for the crash point itself (a state), however slowly a loaded machine gets there.
  await h1.until(() => state.crashed);
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (after) await after(h1);
  await h1.crash();
  const h2 = await makeShop({ root: h1.root, clock: h1.clock, planFor: plan, settings });
  t.after(() => h2.close());
  await h2.orch.recover();
  await h2.settle();
  return { h1, h2 };
}

const finished = (h) => {
  const job = h.job();
  assert.equal(job.status, 'delivering', `status ${job.status} ${job.pauseReason ?? ''} ${job.error ?? ''}`);
  assert.ok(h.tasks().every((x) => x.status === 'merged'));
  assert.ok(job.requirements.every((r) => r.status === 'verified'));
};

test('restart during a plan draft turn: the draft runs again', async (t) => {
  const { h2 } = await restartAt(t, { hooks: (s) => ({ plan: async () => { s.crashed = true; return hang(); } }) });
  finished(h2);
  assert.equal(h2.turns('plan').length, 1);
});

test('restart after plan_submit, before apply: the stored final plan is applied', async (t) => {
  const { h2 } = await restartAt(t, {
    hooks: (s) => ({ plan: async (turn) => { await turn.call('plan_submit', samplePlan({ n: 2 })); s.crashed = true; return hang(); } }),
  });
  finished(h2);
  assert.equal(h2.turns('plan').length, 0, 'no new plan turn');
});

test('restart during a work turn: the session resumes with the restart note', async (t) => {
  const { h1, h2 } = await restartAt(t, {
    hooks: (s) => ({
      work: async (turn, h) => {
        h.write(turn.cwd, `${taskOf(h, turn).zones[0].replace('/**', '')}/index.js`, '1\n');
        s.crashed = true;
        return hang();
      },
    }),
  });
  finished(h2);
  // The turns of the first instance never ended, so no session id was stored: the work starts fresh on the same bench.
  assert.ok(h1.turns('work').length >= 1);
  assert.ok(h2.turns('work').length >= 2);
});

test('restart after DONE, before the pipeline: the hand-in runs after the restart', async (t) => {
  const { h2 } = await restartAt(t, {
    hooks: (s) => ({
      work: async (turn, h) => {
        const task = taskOf(h, turn);
        h.write(turn.cwd, `${task.zones[0].replace('/**', '')}/index.js`, '1\n');
        await turn.post(`DONE ${task.id} tests=1/1 acc=2/2: I wrote the module.`);
        if (task.id === 'T1') { s.crashed = true; return hang(); }
        return {};
      },
    }),
  });
  finished(h2);
});

test('restart when the DONE is on the board but the task state was lost: recover sets the task to checking', async (t) => {
  const { h2 } = await restartAt(t, {
    crew: { bosses: 1, managers: 0, makers: 1 },
    plan: () => samplePlan({ n: 1 }),
    hooks: (s) => ({
      work: async (turn, h) => {
        const task = taskOf(h, turn);
        h.write(turn.cwd, 'mod1/index.js', '1\n');
        await turn.post(`DONE ${task.id} tests=1/1 acc=2/2: I wrote the module.`);
        s.crashed = true;
        return hang();
      },
    }),
    after: async (h1) => {
      const d = h1.store.list('deliveries')[0];
      h1.store.remove('deliveries', d.id);
      h1.store.patch('tasks', 'T1', { status: 'working', deliveryId: null });
    },
  });
  finished(h2);
});

test('restart during a review turn: the review runs again', async (t) => {
  const { h2 } = await restartAt(t, { hooks: (s) => ({ review: async () => { s.crashed = true; return hang(); } }) });
  finished(h2);
});

test('restart after a PASS, before the reviewer turn ended: the stored verdict takes effect', async (t) => {
  const { h2 } = await restartAt(t, {
    hooks: (s) => ({
      review: async (turn) => {
        const id = /Their DONE is message (\d+)/.exec(turn.prompt)[1];
        await turn.post(`PASS re:${id}: The work meets every acceptance item.`);
        s.crashed = true;
        return hang();
      },
    }),
  });
  finished(h2);
});

test('restart during a buddy turn: the buddy step is skipped', async (t) => {
  const { h2 } = await restartAt(t, {
    settings: { pairing: 'all' },
    plan: () => samplePlan({ n: 1 }),
    hooks: (s) => ({ buddy: async () => { s.crashed = true; return hang(); } }),
  });
  finished(h2);
  assert.equal(h2.turns('buddy').length, 0);
});

test('restart during a rework turn after a FIX: the rework resumes and the work merges', async (t) => {
  let reviews = 0;
  const { h2 } = await restartAt(t, {
    plan: () => samplePlan({ n: 1 }),
    hooks: (s) => ({
      review: async (turn) => {
        reviews++;
        const id = /Their DONE is message (\d+)/.exec(turn.prompt)[1];
        if (reviews === 1) { await turn.post(`FIX re:${id}:\n1. Add a comment in mod1/index.js:1.`); return {}; }
        return undefined;
      },
      work: async (turn, h) => {
        if (h.store.get('tasks', 'T1').status === 'rework') { s.crashed = true; return hang(); }
        return undefined;
      },
    }),
  });
  finished(h2);
});

test('restart during the QA turn: QA runs again', async (t) => {
  const { h2 } = await restartAt(t, { hooks: (s) => ({ qa: async () => { s.crashed = true; return hang(); } }) });
  finished(h2);
});

test('restart during the report turn: the report is written after the restart', async (t) => {
  const { h2 } = await restartAt(t, { hooks: (s) => ({ report: async () => { s.crashed = true; return hang(); } }) });
  finished(h2);
  assert.ok(h2.job().report);
});

test('restart during a manager answer turn: the open item is answered after the restart', async (t) => {
  const { h2 } = await restartAt(t, {
    plan: () => samplePlan({ n: 1 }),
    hooks: (s) => ({
      work: async (turn, h) => {
        const task = taskOf(h, turn);
        if (!s.asked) { s.asked = true; await turn.post(`ASK @mgr ${task.id}: Which export name does mod1 use?`); return {}; }
        return undefined;
      },
      manager: async (turn) => {
        if (turn.kind === 'digest' && !s.crashed) { s.crashed = true; return hang(); }
        return undefined;
      },
    }),
  });
  finished(h2);
  assert.ok(h2.msgs().some((m) => m.kind === 'ANS' && m.from === '@f1'));
});

test('restart: a task card on disk that is newer than the state (a lost claim grant) is written again from the state', async (t) => {
  const state = { crashed: false };
  const plan = () => samplePlan({ n: 1 });
  const h1 = await makeShop({ planFor: plan, brainHooks: { work: async () => { state.crashed = true; return hang(); } } });
  h1.orch.createJob({ title: 'Restart job', brief: 'Build modules.', kind: 'build', project: { mode: 'new', name: 'r' }, crew: { bosses: 1, managers: 1, makers: 1 } });
  await h1.orch.recover();
  await h1.until(() => state.crashed);
  await h1.crash();
  const task = h1.store.get('tasks', 'T1');
  const card = path.join(task.benchDir, '.shop', 'TASK.md');
  fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace(/^ZONES: (.*)$/m, 'ZONES: $1, src/registry.js'));
  const h2 = await makeShop({ root: h1.root, clock: h1.clock, planFor: plan });
  t.after(() => h2.close());
  await h2.orch.recover();
  assert.doesNotMatch(fs.readFileSync(card, 'utf8'), /src\/registry\.js/, 'the card lists only the zones the state holds');
  await h2.settle();
  finished(h2);
});
