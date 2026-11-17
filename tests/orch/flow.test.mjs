// End-to-end flows of the orchestrator with the fake runner: intake to done, ship, sessions and turn classes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeShop, ownerGit } from './harness.mjs';

test('a 3-task plan runs from intake to done with an exact-sha ship', async (t) => {
  const h = await makeShop();
  t.after(() => h.close());
  await h.start();
  let job = h.job();
  assert.equal(job.status, 'delivering', `status ${job.status} ${job.error ?? ''}`);
  assert.equal(h.tasks().length, 3);
  assert.ok(h.tasks().every((x) => x.status === 'merged'), JSON.stringify(h.tasks().map((x) => x.status)));
  assert.ok(job.requirements.every((r) => r.status === 'verified'));
  assert.ok(job.report && job.report.includes('Report'));
  assert.equal(job.auditDone, true);
  const loaded = h.deliveries().filter((d) => d.status === 'loaded');
  assert.equal(loaded.length, 3);
  // sessions are stored on the work items
  for (const task of h.tasks()) assert.ok(task.sessionId, `${task.id} has a work session`);
  // review is cross-lab where possible and runs with read access in a review clone
  const reviews = h.turns('review');
  assert.ok(reviews.length >= 3);
  assert.ok(reviews.every((r) => r.access === 'read' && r.cwd.endsWith('.rev')));
  // main turns run at a desk, never in _int
  for (const r of h.turns().filter((x) => ['plan', 'report'].includes(x.kind))) assert.match(r.cwd, /_desk/);
  const truck = await h.orch.truck('J1');
  assert.equal(truck.deliveries.length, 3);
  assert.equal(truck.headSha, job.intSha);
  assert.equal(truck.reqs.verified, 3);
  // a ship needs the sha
  assert.equal((await h.orch.ship('J1', {})).ok, false);
  const shipped = await h.orch.ship('J1', { sha: truck.headSha });
  assert.equal(shipped.ok, true, JSON.stringify(shipped));
  assert.equal(shipped.left, 0);
  await h.settle();
  job = h.job();
  assert.equal(job.status, 'done');
  const project = h.store.get('projects', job.projectId);
  const files = ownerGit(project.path, h.env, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  for (const i of [1, 2, 3]) assert.ok(files.includes(`mod${i}/index.js`), files.join(','));
  assert.ok(!files.some((f) => f.startsWith('.shop/')));
  assert.ok(h.deliveries().every((d) => d.status === 'shipped'));
  assert.ok(h.agents().every((a) => a.status === 'off'));
});

test('ship up to a crate leaves the later crates loaded', async (t) => {
  const h = await makeShop({ planFor: () => ({ requirements: [{ text: 'A works.' }, { text: 'B works.' }], tasks: [
    { key: 'a', title: 'A', spec: 'Write a.', acceptance: ['a exists.'], zones: ['a/**'], domain: 'backend', size: 'S', reqs: [1] },
    { key: 'b', title: 'B', spec: 'Write b.', acceptance: ['b exists.'], zones: ['b/**'], domain: 'backend', size: 'S', reqs: [2], deps: ['a'] },
  ], check_cmd: 'true' }) });
  t.after(() => h.close());
  await h.start();
  const first = h.deliveries().find((d) => d.taskId === 'T1');
  const r = await h.orch.ship('J1', { sha: first.mergeSha });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.left, 1);
  assert.equal(h.store.get('deliveries', first.id).status, 'shipped');
  assert.equal(h.deliveries().find((d) => d.taskId === 'T2').status, 'loaded');
  assert.equal(h.job().status, 'delivering');
});

test('the integration head is never a turn cwd and hub files never reach the target', async (t) => {
  const h = await makeShop();
  t.after(() => h.close());
  await h.start();
  const job = h.job();
  for (const turn of h.turns()) {
    assert.ok(!turn.cwd.includes(`${path.sep}_int`), `${turn.kind} ran in ${turn.cwd}`);
    assert.ok(!turn.cwd.startsWith(h.dirs.projects), `${turn.kind} ran in the canonical repo`);
  }
  assert.ok(fs.existsSync(job.integrationDir));
});
