// Tripwire, truck refresh and catch-up, rotation, the turn gate, the second-refusal consult, agent files,
// the manager debounce and the report fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeShop, ownerGit, samplePlan } from './harness.mjs';
import * as P from '../../server/prompts.js';

const taskOf = (h, turn) => h.store.get('tasks', h.store.get('agents', turn.agentId).taskId);

test('tripwire: the integration branch moved outside the hub pauses the job (tampered); resume accepts the head', async (t) => {
  let tampered = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      review: async (turn, hh) => {
        if (tampered) return undefined;
        tampered = true;
        const job = hh.job();
        hh.write(job.integrationDir, 'evil.txt', 'x\n');
        ownerGit(job.integrationDir, hh.env, 'add', '-A');
        ownerGit(job.integrationDir, hh.env, 'commit', '-q', '-m', 'outside');
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.equal(h.job().status, 'paused');
  assert.equal(h.job().pauseReason, 'tampered');
  assert.equal(h.store.get('tasks', 'T1').status, 'integrating');
  await h.orch.resumeJob('J1');
  await h.settle();
  assert.equal(h.job().status, 'delivering');
});

test('truck refresh at ship: the target moved, the refresh is clean and green, the owner must look again', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start();
  const project = h.store.get('projects', h.job().projectId);
  h.write(project.path, 'owner.txt', 'mine\n');
  ownerGit(project.path, h.env, 'add', '-A');
  ownerGit(project.path, h.env, 'commit', '-q', '-m', 'owner work');
  const before = (await h.orch.truck('J1')).headSha;
  const r = await h.orch.ship('J1', { sha: before });
  assert.equal(r.ok, false);
  assert.equal(r.moved, true);
  assert.match(r.reason, /Your branch moved\. Look again, then ship\./);
  assert.ok(h.notices.some((n) => /Your branch moved/.test(n.text) && /owner work/.test(n.text)));
  const truck = await h.orch.truck('J1');
  assert.notEqual(truck.headSha, before);
  assert.equal(truck.behind, 0);
  assert.equal(h.job().intSha, truck.headSha);
  const again = await h.orch.ship('J1', { sha: truck.headSha });
  assert.equal(again.ok, true, JSON.stringify(again));
  await h.settle();
  assert.equal(h.job().status, 'done');
});

test('truck refresh with a conflict and no open task: a catch-up task (fix, zones **) starts with the merge in place', async (t) => {
  let catchUpBench = null;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        const task = taskOf(hh, turn);
        if (!task.catchUp) return undefined;
        catchUpBench = turn.cwd;
        hh.write(turn.cwd, 'mod1/index.js', 'export const both = 1;\n');
        await turn.post(`DONE ${task.id} tests=1/1 acc=2/2: I merged the owner change into mod1/index.js.`);
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const project = h.store.get('projects', h.job().projectId);
  h.write(project.path, 'mod1/index.js', 'export const owner = 1;\n');
  ownerGit(project.path, h.env, 'add', '-A');
  ownerGit(project.path, h.env, 'commit', '-q', '-m', 'owner edit');
  const r = await h.orch.ship('J1', { sha: (await h.orch.truck('J1')).headSha });
  assert.equal(r.ok, false);
  assert.match(r.reason, /conflicts in mod1\/index\.js/);
  assert.equal(h.job().status, 'running');
  await h.settle();
  const catchUp = h.tasks().find((x) => x.catchUp);
  assert.ok(catchUp);
  assert.equal(catchUp.domain, 'fix');
  assert.deepEqual(catchUp.zones, ['**']);
  assert.ok(catchUpBench, 'the catch-up maker worked');
  assert.equal(catchUp.status, 'merged');
  assert.equal(h.job().status, 'delivering');
  const ok = await h.orch.ship('J1', { sha: (await h.orch.truck('J1')).headSha });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('rotation: a work session over rotateTok gets a fresh session with a hub digest', async (t) => {
  let reviews = 0;
  const h = await makeShop({
    limits: { rotateTok: { boss: 40000, manager: 40000, maker: 5000 } },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async () => undefined,
      review: async (turn) => {
        reviews++;
        const id = /Their DONE is message (\d+)/.exec(turn.prompt)[1];
        if (reviews === 1) { await turn.post(`FIX re:${id}:\n1. Add a comment in mod1/index.js:1.`); return { ctxTok: 1000 }; }
        return undefined;
      },
    },
  });
  h.runner.brain = ((inner) => async (turn) => ({ ...(await inner(turn)), ...(turn.kind === 'work' ? { ctxTok: 9000 } : {}) }))(h.runner.brain);
  t.after(() => h.close());
  await h.start();
  const works = h.turns('work');
  assert.equal(works.length, 2);
  assert.equal(works[1].resume, false, 'a fresh session');
  assert.match(works[1].prompt, /SESSION DIGEST for @m\d/);
  assert.match(works[1].prompt, /FIX ITEMS TO DO/);
  assert.match(works[1].prompt, /git diff --stat/);
  assert.equal(h.job().status, 'delivering');
});

test('turn gate: a manager that ends its turn with an open item is resumed once; then the item moves up', async (t) => {
  let asked = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (!asked) { asked = true; await turn.post(`ASK @mgr ${taskOf(hh, turn).id}: Which export name does mod1 use?`); return {}; }
        return undefined;
      },
      manager: async (turn) => (['digest', 'audit'].includes(turn.kind) ? {} : undefined),
    },
  });
  t.after(() => h.close());
  await h.start();
  const mgr = h.turns().filter((x) => x.role === 'manager' && x.kind === 'digest');
  assert.ok(mgr.length >= 2);
  assert.ok(mgr.some((x) => x.resume && /You have open items addressed to you/.test(x.prompt)), 'the gate nudge');
  const ask = h.msgs().find((m) => m.kind === 'ASK' && m.fromId);
  const ans = h.msgs().find((m) => m.kind === 'ANS' && m.re === ask.id);
  assert.equal(ans.from, '@b1', 'the lead boss answered after the escalation');
  assert.equal(h.job().status, 'delivering');
});

test('second refused hand-in: the hub consults the other lab, then posts its FIX with a pointer to the answer', async (t) => {
  let n = 0;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1, check: 'test ! -e mod1/BROKEN' }),
    brainHooks: {
      work: async (turn, hh) => {
        const task = taskOf(hh, turn);
        n++;
        hh.write(turn.cwd, 'mod1/index.js', `export const v = ${n};\n`);
        if (n <= 2) hh.write(turn.cwd, 'mod1/BROKEN', 'x\n');
        else fs.rmSync(`${turn.cwd}/mod1/BROKEN`, { force: true });
        await turn.post(`DONE ${task.id} tests=1/1 acc=2/2: I wrote mod1/index.js.`);
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  const ask = h.msgs().find((m) => m.kind === 'ASK' && m.from === '@hub' && m.toAlias === '@other');
  assert.ok(ask, 'the hub asked @other');
  assert.equal(h.turns('consult').length, 1);
  const fixes = h.msgs().filter((m) => m.kind === 'FIX' && m.from === '@hub');
  assert.equal(fixes.length, 2);
  assert.match(fixes[1].body, /See the consult answer in message \d+/);
  assert.equal(h.store.get('tasks', 'T1').status, 'merged');
});

test('agent files of an adopted repo without ack: the Gemini lab is off for the job; the inbox asks the owner', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1, check: 'true' }) });
  t.after(() => h.close());
  const dir = `${h.root}/adopted`;
  ownerGit(h.root, h.env, 'init', '-q', '--initial-branch=main', dir);
  h.write(dir, 'CLAUDE.md', 'Rules.\n');
  h.write(dir, 'README.md', 'hi\n');
  ownerGit(dir, h.env, 'add', '-A');
  ownerGit(dir, h.env, 'commit', '-q', '-m', 'seed');
  h.orch.createJob({ title: 'x', brief: 'y', kind: 'build', project: { mode: 'existing', path: dir }, crew: { bosses: 1, managers: 1, makers: 2 }, options: { approvePlan: true } });
  await h.orch.recover();
  await h.settle();
  const project = h.store.get('projects', h.job().projectId);
  assert.deepEqual(project.agentFiles, ['CLAUDE.md']);
  assert.equal(project.agentFilesAck, false);
  assert.ok(h.agents().every((a) => a.provider === 'claude'), h.agents().map((a) => a.provider).join(','));
  assert.ok(h.orch.inbox('J1').some((i) => i.kind === 'agentfiles'));
  h.orch.ackAgentFiles(project.id, true);
  assert.ok(!h.orch.inbox('J1').some((i) => i.kind === 'agentfiles'));
});

test('manager events are batched with the debounce; the debounce only delays', async (t) => {
  let asked = false;
  const h = await makeShop({
    tuning: { managerDebounceMs: 20000, managerMaxDelayMs: 60000 },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        if (!asked) { asked = true; await turn.post(`ASK @mgr ${taskOf(hh, turn).id}: Which export name does mod1 use?`); return {}; }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const mgrTurns = () => h.turns('digest').filter((x) => x.role === 'manager').length;
  assert.equal(mgrTurns(), 0, 'the manager waits for the debounce');
  assert.ok(h.store.list('agents').find((a) => a.role === 'manager').wake);
  await h.advance(21000);
  assert.ok(mgrTurns() >= 1);
  assert.equal(h.job().status, 'delivering');
});

test('report: one retry by another boss, then the hub stores its own fact sheet as job.report', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }), brainHooks: { report: async () => ({ error: { kind: 'other', message: 'boom' } }) } });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 2, managers: 0, makers: 1 } });
  const reports = h.turns('report');
  assert.equal(reports.length, 2);
  assert.notEqual(reports[0].agentId, reports[1].agentId);
  assert.match(h.job().report, /The bosses wrote no report/);
});

test('a mock job with its own pace (the demo): options.mockSpeed is kept and each mock agent carries it', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  assert.equal(h.orch.createJob({ title: 'x', brief: 'y', options: { mockSpeed: 5 } }).options.mockSpeed, undefined, 'only a mock job has a pace');
  assert.equal(h.orch.createJob({ title: 'x', brief: 'y', options: { mock: true, mockSpeed: 99 } }).options.mockSpeed, undefined, 'out of range');
  await h.orch.cancelJob('J1');
  await h.orch.cancelJob('J2');
  const job = h.orch.createJob({ title: 'Demo', brief: 'Build modules.', kind: 'build', project: { mode: 'new', name: 'd' }, options: { mock: true, mockSpeed: 5 } });
  assert.equal(job.options.mockSpeed, 5);
  await h.orch.recover();
  await h.until(() => h.agents(job.id).length > 0);
  for (const a of h.agents(job.id)) assert.equal(a.mockSpeed, 5, `${a.handle} has the pace of its job`);
});

test('review prompt after a squashed hand-in: the reviewer reads the whole change (the old reviewed commit is gone)', () => {
  const task = { id: 'T1', acceptance: ['It works.'] };
  const delivery = { doneMsgId: 7, files: [{ path: 'a.js', add: 1, del: 0 }], stat: { files: 1, add: 1, del: 0 }, summary: 'Done.', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40), flags: {} };
  const normal = P.reviewPrompt(task, delivery, 'CARD', { maker: '@m1', previous: { fixItems: ['Fix a.js:1.'], lastReviewedSha: 'a'.repeat(40) } }, '');
  assert.match(normal, new RegExp(`git diff ${'a'.repeat(40)} ${'c'.repeat(40)} \\.`));
  const squashed = P.reviewPrompt(task, delivery, 'CARD', { maker: '@m1', previous: { fixItems: ['Fix a.js:1.'], lastReviewedSha: null } }, '');
  assert.match(squashed, new RegExp(`squashed the bench history.*git diff ${'b'.repeat(40)} ${'c'.repeat(40)} \\.`));
  assert.match(squashed, /Fix a\.js:1\./);
});
