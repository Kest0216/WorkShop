// Final wiring spec, part S, in the orchestrator: the panel on owner notices (S5), singular crate wording (S4),
// 'Add task' with reqId for a requirement that no task serves (S7), and squashed on the truck crates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShop, samplePlan, anyFile } from './harness.mjs';

const owners = (h) => h.notices.filter((n) => n.level === 'owner');

test('S7 + S5: a failed requirement with no task; "Add task" with reqId drops its inbox item, the new one serves it, QA verifies both', async (t) => {
  const h = await makeShop({
    planFor: () => samplePlan({ n: 2 }),
    brainHooks: {
      qa: async (turn, hh) => {
        const job = hh.store.get('jobs', hh.store.get('agents', turn.agentId).jobId);
        if (job.qa.round !== 1) return undefined; // later rounds: the standard brain verifies everything
        const open = job.requirements.filter((r) => r.status === 'open');
        const file = anyFile(turn.cwd);
        if (open.length) await turn.call('req_verify', { results: open.map((r) => ({ id: r.id, ok: r.id !== 'R2', evidence: r.id === 'R2' ? 'Missing in mod2/index.js.' : `See ${file}.` })) });
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.equal(h.job().qa.step, 'owner');
  assert.ok(h.orch.inbox('J1').some((i) => i.kind === 'requirement' && i.reqId === 'R2'));
  const failedNote = owners(h).find((n) => /R2 failed and no task serves them/.test(n.text));
  assert.equal(failedNote.panel, 'inbox');
  assert.equal(owners(h).find((n) => /^Plan for J1/.test(n.text)).panel, 'blueprint');

  const req = h.orch.requestChanges('J1', { text: 'Add a test for module 2.', reqId: 'R2' });
  assert.equal(req.id, 'R3');
  assert.equal(req.servesReq, 'R2');
  assert.equal(h.job().requirements.find((r) => r.id === 'R2').ownerNotice, false);
  assert.ok(!h.orch.inbox('J1').some((i) => i.kind === 'requirement'), 'the item left the inbox at once');
  assert.equal(h.job().status, 'running');
  assert.throws(() => h.orch.requestChanges('J1', { text: 'x', reqId: 'R9' }), (err) => err.status === 404);

  await h.settle();
  const job = h.job();
  assert.equal(job.status, 'delivering', `${job.status} ${job.error}`);
  assert.ok(h.tasks().some((x) => x.reqs.includes('R3')), 'a task serves the new requirement');
  assert.ok(job.requirements.every((r) => r.status === 'verified'));
  assert.equal(owners(h).filter((n) => /R2/.test(n.text) && /no task/.test(n.text)).length, 1, 'R2 asked the owner once only');
  assert.equal(owners(h).find((n) => /every requirement is verified/.test(n.text)).panel, 'truck');

  // The done note names no panel, but the field is there (null).
  const ship = await h.orch.ship('J1', { sha: (await h.orch.truck('J1')).headSha });
  assert.equal(ship.ok, true, JSON.stringify(ship));
  await h.settle();
  assert.equal(h.job().status, 'done');
  const done = owners(h).find((n) => n.text === 'J1 is done.');
  assert.ok(Object.hasOwn(done, 'panel'));
  assert.equal(done.panel, null);
  assert.ok(owners(h).every((n) => Object.hasOwn(n, 'panel') && (n.panel === null || ['blueprint', 'truck', 'inbox', 'keys'].includes(n.panel))));
  assert.ok(h.notices.filter((n) => n.level === 'info').every((n) => !Object.hasOwn(n, 'panel')), 'an info notice keeps its old shape');
});

test('S7: reqId also works for an OPEN requirement the lead made no task for; the old one stays quiet', async (t) => {
  let armed = false;
  let held = false;
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      // The lead makes no task for R2 (the change turn and its nudge).
      change: async (turn) => (/R2/.test(turn.prompt) && !/R3/.test(turn.prompt) ? {} : undefined),
      // The QA round after that waits until the test has added the task (else it could verify R2 at once).
      qa: async () => {
        if (!armed || held) return undefined;
        held = true;
        await gate;
        return {};
      },
    },
  });
  t.after(() => { release(); return h.close(); });
  await h.start();
  assert.equal(h.job().status, 'delivering');
  armed = true;
  const r2 = h.orch.requestChanges('J1', { text: 'Also add a CSV export.' });
  assert.equal(r2.id, 'R2');
  await h.until(() => held);
  const note = owners(h).find((n) => /made no task for R2/.test(n.text));
  assert.equal(note.panel, 'inbox');
  assert.equal(h.job().requirements.find((r) => r.id === 'R2').status, 'open');
  assert.ok(h.orch.inbox('J1').some((i) => i.kind === 'requirement' && i.reqId === 'R2'), 'an open requirement with no task is in the inbox');

  const r3 = h.orch.requestChanges('J1', { text: 'Add the CSV export in mod1.', reqId: 'R2' });
  assert.equal(r3.servesReq, 'R2');
  assert.ok(!h.orch.inbox('J1').some((i) => i.kind === 'requirement'), 'the item left the inbox');
  release();
  await h.settle();
  const job = h.job();
  assert.equal(job.status, 'delivering', `${job.status} ${job.error}`);
  assert.ok(h.tasks().some((x) => x.reqs.includes('R3')));
  assert.ok(!h.tasks().some((x) => x.reqs.includes('R2')), 'no task names R2: R3 serves it');
  assert.equal(owners(h).filter((n) => /R2/.test(n.text) && /no task/.test(n.text)).length, 1, 'no second "no task" notice for R2');
  assert.equal(job.requirements.find((r) => r.id === 'R2').ownerNotice, false);
});

test('S4: one crate is singular in the inbox, the cancel and the ship lines', async (t) => {
  const h = await makeShop({ planFor: () => ({ requirements: [{ text: 'A works.' }, { text: 'B works.' }], tasks: [
    { key: 'a', title: 'A', spec: 'Write a.', acceptance: ['a exists.'], zones: ['a/**'], domain: 'backend', size: 'S', reqs: [1] },
    { key: 'b', title: 'B', spec: 'Write b.', acceptance: ['b exists.'], zones: ['b/**'], domain: 'backend', size: 'S', reqs: [2], deps: ['a'] },
  ], check_cmd: 'true' }) });
  t.after(() => h.close());
  await h.start();
  assert.equal(h.orch.inbox('J1').find((i) => i.kind === 'truck').text, '2 crates wait on the truck of J1.');
  const first = h.deliveries().find((d) => d.taskId === 'T1');
  const r = await h.orch.ship('J1', { sha: first.mergeSha });
  assert.equal(r.left, 1);
  assert.ok(h.msgs().some((m) => m.kind === 'EVT' && /^The truck left: .* 1 crate stays loaded\.$/.test(m.body)), 'ship line, singular');
  assert.equal(h.orch.inbox('J1').find((i) => i.kind === 'truck').text, '1 crate waits on the truck of J1.');
  await h.orch.cancelJob('J1');
  assert.ok(h.msgs().some((m) => m.body === 'Work order J1 is cancelled. 1 crate stays on the truck: ship it or discard it.'), 'cancel line, singular');
  assert.equal(h.orch.inbox('J1').find((i) => i.kind === 'truck').text, '1 crate waits on the truck of J1.');
});

test('truck view: a crate keeps squashed from its delivery (the Truck panel flag)', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 2 }) });
  t.after(() => h.close());
  await h.start();
  const [d1, d2] = h.deliveries().filter((d) => d.status === 'loaded').sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(d1.squashed, false, 'a plain hand-in says squashed: false');
  h.store.patch('deliveries', d2.id, { squashed: true });
  const truck = await h.orch.truck('J1');
  assert.equal(truck.deliveries.find((d) => d.id === d1.id).squashed, false);
  assert.equal(truck.deliveries.find((d) => d.id === d2.id).squashed, true);
});
