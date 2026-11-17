// QA rounds and the requirement ledger, owner changes, waivers, presence with owner defaults and overturns,
// the attention inbox and the truck view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShop, samplePlan, anyFile } from './harness.mjs';

const qaVerify = (results) => async (turn, h) => {
  const job = h.store.get('jobs', h.store.get('agents', turn.agentId).jobId);
  const file = anyFile(turn.cwd);
  const open = job.requirements.filter((r) => r.status === 'open');
  return results(turn, open, file, job);
};

test('QA: a failed requirement with a task_add in the same turn sends the job back to running; round 2 verifies it', async (t) => {
  let rounds = 0;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 2 }),
    brainHooks: {
      qa: qaVerify(async (turn, open, file) => {
        rounds++;
        if (rounds === 1) {
          await turn.call('req_verify', { results: open.map((r) => ({ id: r.id, ok: r.id !== 'R2', evidence: r.id === 'R2' ? 'R2 is missing a test in mod2/index.js.' : `See ${file}.` })) });
          turn.add = await turn.call('task_add', { title: 'Fix R2', spec: 'Add the test for module 2.', acceptance: ['The test exists.'], zones: ['fix2/**'], domain: 'test', size: 'S', reqs: ['R2'] });
          return {};
        }
        return undefined;
      }),
    },
  });
  t.after(() => h.close());
  await h.start();
  const job = h.job();
  assert.equal(job.status, 'delivering', `${job.status} ${job.error}`);
  assert.equal(job.qa.round, 2);
  assert.equal(h.tasks().length, 3);
  assert.deepEqual(h.tasks()[2].reqs, ['R2']);
  assert.ok(job.requirements.every((r) => r.status === 'verified'));
  const qa = h.turns('qa');
  assert.equal(qa[0].access, 'read');
  assert.match(qa[0].cwd, /_head$/);
  assert.match(qa[0].prompt, /FINAL CHECK/);
  assert.match(qa[0].prompt, /BRIEF FROM THE OWNER/);
});

test('req_verify guards: only the QA agent, a result for every open requirement, evidence pointing at a real file', async (t) => {
  const answers = [];
  const h = await makeShop({
    planFor: () => samplePlan({ n: 2 }),
    brainHooks: {
      qa: qaVerify(async (turn, open, file) => {
        if (answers.length) return undefined;
        answers.push(await turn.call('req_verify', { results: [{ id: 'R1', ok: true, evidence: `See ${file}.` }] }));
        answers.push(await turn.call('req_verify', { results: open.map((r) => ({ id: r.id, ok: true, evidence: 'See nothere/x.js:3.' })) }));
        answers.push(await turn.call('req_verify', { results: open.map((r) => ({ id: r.id, ok: true, evidence: `See ${file}:1.` })) }));
        return {};
      }),
      boss: async (turn) => {
        if (turn.kind !== 'review' && turn.kind !== 'report' && turn.kind !== 'plan') {
          answers.push(await turn.call('req_verify', { results: [] }));
        }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.match(answers[0], /Missing: R2/);
  assert.match(answers[1], /needs a pointer to a file that exists/);
  assert.match(answers[2], /^ok\. Every requirement is verified/);
  assert.equal(h.job().status, 'delivering');
});

test('QA: a failed requirement with no task gets one nudge, then one lead wake, then an owner notice; a waiver ends it', async (t) => {
  const h = await makeShop({
    planFor: () => samplePlan({ n: 2 }),
    brainHooks: {
      qa: qaVerify(async (turn, open, file) => {
        if (open.length) await turn.call('req_verify', { results: open.map((r) => ({ id: r.id, ok: r.id !== 'R2', evidence: r.id === 'R2' ? 'Missing in mod2/index.js.' : `See ${file}.` })) });
        return {};
      }),
    },
  });
  t.after(() => h.close());
  await h.start();
  let job = h.job();
  assert.equal(job.status, 'qa');
  assert.equal(job.qa.step, 'owner');
  const qa = h.turns('qa');
  assert.equal(qa.length, 2);
  assert.match(qa[1].prompt, /These requirements failed and no task serves them: R2/);
  assert.ok(h.turns('change').some((x) => /failed and no task serves them: R2/.test(x.prompt)), 'the lead was woken once');
  assert.ok(h.orch.inbox('J1').some((i) => i.kind === 'requirement' && i.reqId === 'R2'));
  assert.ok(h.notices.some((n) => /R2 failed and no task serves them/.test(n.text)));
  h.orch.waiveReq('J1', 'R2', { reason: 'Not needed now.' });
  await h.settle();
  job = h.job();
  assert.equal(job.status, 'delivering');
  assert.equal(job.requirements.find((r) => r.id === 'R2').waivedReason, 'Not needed now.');
});

test('QA rounds are capped: after maxQaRounds the job pauses (qa)', async (t) => {
  let n = 0;
  const h = await makeShop({
    limits: { maxQaRounds: 2 },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      qa: qaVerify(async (turn, open) => {
        n++;
        await turn.call('req_verify', { results: open.map((r) => ({ id: r.id, ok: false, evidence: 'Not done in mod1/index.js.' })) });
        await turn.call('task_add', { title: `Again ${n}`, spec: 'Try again.', acceptance: ['Works.'], zones: [`again${n}/**`], domain: 'fix', size: 'S', reqs: ['R1'] });
        return {};
      }),
    },
  });
  t.after(() => h.close());
  await h.start();
  const job = h.job();
  assert.equal(job.status, 'paused');
  assert.equal(job.pauseReason, 'qa');
  assert.equal(job.qa.round, 2);
});

test('owner request for changes becomes a requirement (source owner), the lead adds a task citing it, QA verifies it', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start();
  assert.equal(h.job().status, 'delivering');
  const req = h.orch.requestChanges('J1', { text: 'Also add a CSV export.' });
  assert.equal(req.source, 'owner');
  assert.equal(h.job().status, 'running');
  assert.equal(h.job().report, null);
  await h.settle();
  const job = h.job();
  const change = h.turns('change')[0];
  assert.match(change.prompt, /THE OWNER ASKS FOR CHANGES/);
  assert.match(change.prompt, new RegExp(`requirement ${req.id}`));
  const added = h.tasks().find((x) => x.reqs.includes(req.id));
  assert.ok(added, 'a task serves the new requirement');
  assert.equal(job.status, 'delivering');
  assert.equal(job.requirements.find((r) => r.id === req.id).status, 'verified');
});

test('owner change: a task_add that does not cite the new requirement is refused', async (t) => {
  let answer = null;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      change: async (turn) => {
        if (answer) return undefined;
        answer = await turn.call('task_add', { title: 'x', spec: 'y', acceptance: ['z'], zones: ['x/**'], domain: 'backend', size: 'S', reqs: [] });
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  h.orch.addReq('J1', { text: 'Add a help page.' });
  await h.settle();
  assert.match(answer, /list R2 in reqs/);
});

test('presence away: the hub takes the default of an ASK @human at once; a later owner answer overturns it', async (t) => {
  let asked = null;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      plan: async (turn) => {
        if (!asked) asked = await turn.post('ASK @human #plan default=A: Which color does the button use? A) Red B) Blue');
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  h.orch.setPresence('away');
  await h.start();
  assert.match(asked, /The owner is away\. The hub took default A/);
  let job = h.job();
  const a = job.assumptions.find((x) => x.msgId);
  assert.ok(a, 'the default is an assumption');
  assert.match(a.text, /Red/);
  const q = h.orch.inbox('J1').find((i) => i.kind === 'question');
  assert.equal(q.defaulted, true);
  assert.deepEqual(q.options.map((o) => o.key), ['A', 'B']);
  const leadTurns = h.turns().filter((x) => x.handle === '@b1').length;
  const res = h.orch.ownerPost({ jobId: 'J1', kind: 'ANS', re: a.msgId, body: 'B) Blue' });
  assert.equal(res.ok, true, JSON.stringify(res));
  await h.settle();
  job = h.job();
  const b = job.assumptions.find((x) => x.msgId === a.msgId);
  assert.equal(b.owner, true);
  assert.match(b.text, /Blue/);
  assert.ok(h.turns().filter((x) => x.handle === '@b1').length > leadTurns, 'the lead boss was woken');
  assert.ok(!h.orch.inbox('J1').some((i) => i.kind === 'question'), 'the question is unpinned');
});

test('presence here: the default is taken after humanWaitMin of shop time; the same option only confirms it', async (t) => {
  let asked = false;
  const h = await makeShop({
    settings: { humanWaitMin: 30 },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      plan: async (turn) => {
        if (!asked) { asked = true; await turn.post('ASK @human #plan default=B: Which port does the server use? A) 3000 B) 8080'); }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.ok(!h.job().assumptions.some((x) => x.msgId), 'no default yet');
  const q = h.orch.inbox('J1').find((i) => i.kind === 'question');
  assert.equal(q.defaulted, false);
  await h.advance(31 * 60000);
  let job = h.job();
  const a = job.assumptions.find((x) => x.msgId);
  assert.match(a.text, /8080/);
  h.orch.ownerPost({ jobId: 'J1', kind: 'ANS', re: a.msgId, body: 'B' });
  await h.settle();
  job = h.job();
  assert.equal(job.assumptions.find((x) => x.msgId === a.msgId).confirmed, true);
});

test('presence here: an owner question still open in delivering is in the report with its default; ship takes it; a done job has no inbox item', async (t) => {
  let asked = false;
  const h = await makeShop({
    settings: { humanWaitMin: 600 },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      plan: async (turn) => {
        if (!asked) { asked = true; await turn.post('ASK @human #plan default=B: Which port does the server use? A) 3000 B) 8080'); }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  let job = h.job();
  assert.equal(job.status, 'delivering');
  assert.ok(!job.assumptions.some((x) => x.msgId), 'no default yet: the owner is here and the wait is long');
  // The report turn got the open question with its default, and the stored report lists it.
  const prompt = h.turns('report')[0].prompt;
  assert.match(prompt, /OPEN OWNER QUESTIONS:\n\d+ Which port does the server use\? \| default: B\) 8080/);
  assert.match(prompt, /the hub takes the default when the truck ships/);
  assert.match(job.report, /## Open owner questions\n\n- Question \d+: Which port does the server use\? Default: B\) 8080\. The hub takes it when the truck ships\./);
  assert.ok(h.orch.inbox('J1').some((i) => i.kind === 'question'));
  const ship = await h.orch.ship('J1', { sha: (await h.orch.truck('J1')).headSha });
  assert.equal(ship.ok, true, JSON.stringify(ship));
  await h.settle();
  job = h.job();
  assert.equal(job.status, 'done');
  assert.match(job.assumptions.find((x) => x.msgId)?.text ?? '', /8080/, 'the default is recorded at job end');
  assert.deepEqual(h.orch.inbox('J1'), [], 'a done job has no inbox item, not even the pinned question');
  assert.ok(!h.orch.inbox().some((i) => i.jobId === 'J1'));
});

test('the report keeps the boss\'s own list of open owner questions (no second list)', async (t) => {
  const h = await makeShop({
    settings: { humanWaitMin: 600 },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      plan: async (turn) => {
        if (!h.msgs().some((m) => m.kind === 'ASK')) await turn.post('ASK @human #plan default=A: Which color does the button use? A) Red B) Blue');
        return undefined;
      },
      report: async (turn) => {
        await turn.call('job_report', { md: '# Report\n\n## Open owner questions\n\n- The button color: default A (Red), taken when the truck ships.' });
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const report = h.job().report;
  assert.equal(report.match(/Open owner questions/g).length, 1);
});

test('inbox and truck view: plan, truck, paused, budget items; requirement counts beside the report', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start();
  const inbox = h.orch.inbox();
  assert.ok(inbox.some((i) => i.kind === 'truck' && i.jobId === 'J1'));
  const truck = await h.orch.truck('J1');
  assert.deepEqual(truck.reqs, { open: 0, failed: 0, verified: 1, waived: 0 });
  assert.equal(truck.check.ok, true);
  assert.ok(truck.files.some((f) => f.path === 'mod1/index.js'));
  const diff = await h.orch.diff('J1', {});
  assert.match(diff, /mod1\/index\.js/);
  const one = await h.orch.diff('J1', { deliveryId: truck.deliveries[0].id });
  assert.match(one, /\+export const id/);
  h.orch.pauseJob('J1');
  assert.ok(h.orch.inbox('J1').some((i) => i.kind === 'paused'));
});
