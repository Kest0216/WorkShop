// Scenario tests, lens "the owner and the ledger" (contract sections 4, 6, 12 owner actions, 12b, and the ledger
// rules): the REAL hub (createApp on temp folders, the mock lab, the file secrets backend) driven over the owner
// HTTP API. Pause, resume, cancel, discard, delete, the queue, ship rules, the truck refresh, requests for changes
// at each job status, requirements added and waived, task stop / retry / cancel, presence, the inbox, budgets.
// The rule under test everywhere: a job reaches done only when every requirement is verified or waived.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../e2e-harness.mjs';
import { makeShop, samplePlan } from '../orch/harness.mjs';
import { billingAdapters, blankingAdapters, boot, finish, guard, sleep, start } from './owner-harness.mjs';
import { detectTurn } from '../../server/providers/mock-agent.mjs';

const T = { timeout: 300_000 };
const BRIEF = 'Build a small notes app: a list of notes and a search box. Keep notes in one JSON file. Add tests.';

/** The ledger rule: every requirement verified (with evidence) or waived (with a reason). */
function assertLedgerClosed(job) {
  assert.ok(job.requirements.length > 0);
  for (const r of job.requirements) {
    assert.ok(['verified', 'waived'].includes(r.status), `${r.id} "${r.text}" is ${r.status}`);
    if (r.status === 'verified') assert.ok(r.evidence, `${r.id} has evidence`);
    else assert.ok(r.waivedReason, `${r.id} has a waiver reason`);
  }
}

async function toDelivering(shop, J, timeoutMs = 200_000) {
  await shop.waitFor(() => { const j = shop.job(J); return j.status === 'delivering' && j.report; }, { timeoutMs, what: `${J} delivering with a report`, jobId: J });
}

async function shipHead(shop, J) {
  const truck = (await shop.api('GET', `/api/jobs/${J}/truck`)).body;
  const r = await shop.api('POST', `/api/jobs/${J}/ship`, { sha: truck.headSha });
  assert.equal(r.status, 200);
  return { truck, ship: r.body };
}

async function toDone(shop, J) {
  await toDelivering(shop, J);
  const { ship } = await shipHead(shop, J);
  assert.equal(ship.ok, true, JSON.stringify(ship));
  await shop.waitFor(() => shop.job(J).status === 'done', { timeoutMs: 30_000, what: `${J} done`, jobId: J });
  assert.equal(await shop.app.orch.settle({ timeoutMs: 30_000 }), true);
}

describe('owner and ledger: shipping', () => {
  test('ship while running: a sha off the first-parent chain is refused, "ship up to here" leaves later crates loaded, the job still ends done with a closed ledger', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF, crew: 'standard' })).id;
    // Two loaded crates while the job still runs.
    await shop.waitFor(() => shop.deliveries(J).filter((d) => d.status === 'loaded').length >= 2 && shop.job(J).status === 'running',
      { what: 'two loaded crates while running', jobId: J, every: 20 });
    // Freeze the moment: a soft pause keeps the truck as it is while we look at it.
    await api('POST', `/api/jobs/${J}/pause`, {});
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    const loaded = shop.deliveries(J).filter((d) => d.status === 'loaded');
    const project = shop.project(J);
    const main0 = git(project.path, 'rev-parse', project.targetBranch);

    // A bench head (the maker's commit, not a merge on the integration branch) is not on the first-parent chain.
    const benchHead = loaded[0].headSha;
    const r1 = await api('POST', `/api/jobs/${J}/ship`, { sha: benchHead });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.ok, false, `a bench head is refused: ${JSON.stringify(r1.body)}`);
    // A sha that names no commit.
    const r2 = await api('POST', `/api/jobs/${J}/ship`, { sha: 'f'.repeat(40) });
    assert.equal(r2.body.ok, false);
    // The target branch's own sha: nothing new on it.
    // The target branch's own sha (the job's base): nothing ships, the truck does not "leave".
    const fxBefore = shop.sse.filter((e) => e.type === 'fx' && e.name === 'ship').length;
    const r3 = await api('POST', `/api/jobs/${J}/ship`, { sha: main0 });
    assert.ok(r3.body.ok === false || r3.body.already === true, `the target sha itself: ${JSON.stringify(r3.body)}`);
    await sleep(300);
    assert.equal(shop.sse.filter((e) => e.type === 'fx' && e.name === 'ship').length, fxBefore, 'no ship animation for a no-op ship');
    assert.ok(!shop.msgs(J).some((m) => m.kind === 'EVT' && /The truck left/.test(m.body)), 'no "truck left" post for a no-op ship');
    // No sha at all: 400.
    assert.equal((await api('POST', `/api/jobs/${J}/ship`, {})).status, 400);
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), main0, 'nothing moved the target branch');
    assert.ok(shop.deliveries(J).filter((d) => d.status === 'loaded').length === loaded.length, 'every crate is still loaded');

    // Ship up to the first crate: later crates stay loaded.
    const first = loaded.sort((a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0))[0];
    const r4 = await api('POST', `/api/jobs/${J}/ship`, { sha: first.mergeSha });
    assert.equal(r4.body.ok, true, JSON.stringify(r4.body));
    assert.equal(r4.body.left, loaded.length - 1);
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), first.mergeSha);
    assert.equal(shop.app.store.get('deliveries', first.id).status, 'shipped');
    for (const d of loaded.filter((x) => x.id !== first.id)) assert.equal(shop.app.store.get('deliveries', d.id).status, 'loaded', `${d.id} stays loaded`);
    // Shipping the same crate again: it is no longer ahead.
    const again = await api('POST', `/api/jobs/${J}/ship`, { sha: first.mergeSha });
    assert.equal(again.status, 200);
    if (again.body.ok) assert.equal(again.body.left, loaded.length - 1, 'a repeated ship changes nothing');
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), first.mergeSha);
    for (const d of loaded.filter((x) => x.id !== first.id)) assert.equal(shop.app.store.get('deliveries', d.id).status, 'loaded');

    // Ship the head while paused (allowed), then resume and finish.
    const head = (await api('GET', `/api/jobs/${J}/truck`)).body;
    const r5 = await api('POST', `/api/jobs/${J}/ship`, { sha: head.headSha });
    assert.deepEqual([r5.body.ok, r5.body.left], [true, 0], JSON.stringify(r5.body));
    assert.equal((await api('POST', `/api/jobs/${J}/resume`, {})).body.status, 'running');
    await toDone(shop, J);
    const job = shop.job(J);
    assertLedgerClosed(job);
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), job.intSha);
    const shipped = shop.deliveries(J).filter((d) => d.status === 'shipped');
    assert.equal(new Set(shipped.map((d) => d.taskId)).size, shipped.length, 'one shipped crate per task');
    assert.equal(shipped.length, shop.tasks(J).filter((x) => x.status === 'merged').length);
    await finish(shop);
  });
});

/** The owner commits on the target branch in the canonical repo (as the owner would, outside the hub). */
function ownerCommit(project, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(project.path, file)), { recursive: true });
  fs.writeFileSync(path.join(project.path, file), content);
  git(project.path, 'add', '--', file);
  git(project.path, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(project.path, 'rev-parse', 'HEAD');
}

describe('owner and ledger: the target branch moves', () => {
  test('the owner commits on main before ship: the ship request refreshes the truck, says "Your branch moved", and the new head ships', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    await toDelivering(shop, J);
    const project = shop.project(J);
    assert.equal(git(project.path, 'symbolic-ref', '--short', 'HEAD'), project.targetBranch, 'the owner checkout is on the target branch');
    const before = (await api('GET', `/api/jobs/${J}/truck`)).body;
    const ownerSha = ownerCommit(project, 'OWNER.md', 'Notes by the owner.\n', 'Owner note');
    const t1 = (await api('GET', `/api/jobs/${J}/truck`)).body;
    assert.equal(t1.behind, 1, 'the truck is one commit behind');
    const r = await api('POST', `/api/jobs/${J}/ship`, { sha: before.headSha });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.moved, true, JSON.stringify(r.body));
    assert.match(r.body.reason, /Your branch moved/);
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), ownerSha, 'the ship request itself is not done');
    const job = shop.job(J);
    assert.equal(job.intSha, r.body.sha, 'intSha moves to the refresh merge');
    assert.equal(job.status, 'delivering', 'the job stays delivering');
    await shop.waitFor(() => shop.notices().some((n) => n.level === 'owner' && /Your branch moved\. Look again, then ship\..*Owner note/.test(n.text)), { what: 'the owner notice that lists the new commits', timeoutMs: 5000 });
    // The old head is still on the chain, but the target cannot fast-forward to it: refused.
    const old = await api('POST', `/api/jobs/${J}/ship`, { sha: before.headSha });
    assert.equal(old.body.ok, false, JSON.stringify(old.body));
    const t2 = (await api('GET', `/api/jobs/${J}/truck`)).body;
    assert.equal(t2.behind, 0);
    assert.equal(t2.headSha, r.body.sha);
    const s = await api('POST', `/api/jobs/${J}/ship`, { sha: t2.headSha });
    assert.deepEqual([s.body.ok, s.body.left], [true, 0], JSON.stringify(s.body));
    await shop.waitFor(() => shop.job(J).status === 'done', { timeoutMs: 30_000, what: 'done', jobId: J });
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    const files = git(project.path, 'ls-tree', '-r', '--name-only', project.targetBranch).split('\n');
    assert.ok(files.includes('OWNER.md') && files.includes('README.md'), 'main holds the owner file and the shipped work');
    assertLedgerClosed(shop.job(J));
    await finish(shop);
  });

  test('the owner commits a conflicting README on main in delivering: ship adds a catch-up task, the job runs again, QA runs again, then it ships', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    await toDelivering(shop, J);
    const project = shop.project(J);
    const round = shop.job(J).qa.round;
    ownerCommit(project, 'README.md', '# Owner readme\n\nWritten by the owner on main.\n', 'Owner readme');
    const head = (await api('GET', `/api/jobs/${J}/truck`)).body;
    const r = await api('POST', `/api/jobs/${J}/ship`, { sha: head.headSha });
    assert.equal(r.body.ok, false, JSON.stringify(r.body));
    assert.ok((r.body.files ?? []).includes('README.md'), `the answer names the files: ${JSON.stringify(r.body)}`);
    const catchUp = shop.tasks(J).find((x) => x.catchUp);
    assert.ok(catchUp, 'the hub added a catch-up task');
    assert.deepEqual([catchUp.domain, catchUp.zones], ['fix', ['**']]);
    assert.equal(shop.job(J).status, 'running', 'the job returns to running');
    assert.equal(shop.job(J).report, null, 'the report is cleared');
    await toDone(shop, J);
    const job = shop.job(J);
    assert.ok(job.qa.round > round, 'QA ran again after the catch-up');
    assert.equal(shop.task(catchUp.id).status, 'merged');
    assertLedgerClosed(job);
    const readme = git(project.path, 'show', `${project.targetBranch}:README.md`);
    assert.doesNotMatch(readme, /^(<<<<<<<|=======|>>>>>>>)/m, 'no conflict markers shipped');
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), job.intSha);
    await finish(shop);
  });
});

describe('owner and ledger: the target branch moves during QA', () => {
  test('the owner commits on main and asks to ship while the QA turn starts: the requirements are verified on the refreshed head that ships, not on the old tree', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    const qaTurns = [];
    let shipAnswer = null;
    shop.hooks.push(async (rec) => {
      if (rec.jobId !== J || rec.kind !== 'qa') return;
      qaTurns.push({ head: git(rec.cwd, 'rev-parse', 'HEAD'), at: Date.now() });
      if (shipAnswer) return;
      shipAnswer = 'pending';
      const project = shop.project(J);
      ownerCommit(project, 'OWNER.md', 'Notes by the owner.\n', 'Owner note');
      const head = (await api('GET', `/api/jobs/${J}/truck`)).body;
      shipAnswer = (await api('POST', `/api/jobs/${J}/ship`, { sha: head.headSha })).body;
    });
    await toDelivering(shop, J);
    assert.equal(shipAnswer?.moved, true, `the ship request refreshed the truck: ${JSON.stringify(shipAnswer)}`);
    const job = shop.job(J);
    assert.equal(job.qa.sha, job.intSha);
    const last = qaTurns[qaTurns.length - 1];
    assert.equal(last.head, job.intSha, `the QA turn that verified looked at the head that ships (${qaTurns.length} QA turns)`);
    const s = await api('POST', `/api/jobs/${J}/ship`, { sha: job.intSha });
    assert.equal(s.body.ok, true, JSON.stringify(s.body));
    await shop.waitFor(() => shop.job(J).status === 'done', { timeoutMs: 30_000, what: 'done', jobId: J });
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    assertLedgerClosed(shop.job(J));
    await finish(shop);
  });
});

describe('owner and ledger: queue, cancel, discard, delete', () => {
  test('a second and a third job queue behind the first; the owner acts on the queued ones; cancel of J1 promotes J2; a cancelled queued job never starts', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J1 = (await start(shop, { brief: BRIEF, name: 'notes' })).id;
    const J2 = (await start(shop, { brief: BRIEF, title: 'Notes again', name: 'notes' })).id;
    const J3 = (await start(shop, { brief: BRIEF, title: 'Third', name: 'third' })).id;
    await shop.waitFor(() => shop.job(J2).waitReason === `waits for ${J1}` && shop.job(J3).waitReason === `waits for ${J1}`, { what: 'the queued jobs say why they wait' });
    assert.equal(shop.job(J2).status, 'queued');
    // Owner actions on a queued job.
    assert.equal((await api('POST', `/api/jobs/${J2}/reqs`, { text: 'Also export CSV.' })).status, 409, 'no ledger before the plan');
    assert.equal((await api('POST', `/api/jobs/${J2}/changes`, { text: 'Also export CSV.' })).status, 409);
    assert.equal((await api('POST', `/api/jobs/${J2}/pause`, {})).status, 409, 'a queued job is not live');
    assert.equal((await api('POST', `/api/jobs/${J2}/resume`, {})).status, 409);
    assert.equal((await api('DELETE', `/api/jobs/${J2}`)).status, 409, 'a queued job is not deleted');
    const tr = await api('GET', `/api/jobs/${J2}/truck`);
    assert.equal(tr.status, 200);
    assert.equal(tr.body.deliveries.length, 0);
    assert.equal((await api('POST', `/api/jobs/${J2}/ship`, { sha: 'a'.repeat(40) })).body.ok, false);
    // Cancel the queued J3: it never starts.
    const c3 = await api('POST', `/api/jobs/${J3}/cancel`, {});
    assert.equal(c3.body.status, 'cancelled');
    assert.equal(shop.job(J3).projectId, null);

    // J1 in planning or later; a pause keeps J2 queued (a paused job is active).
    await shop.waitFor(() => ['running'].includes(shop.job(J1).status) && shop.tasks(J1).some((x) => x.benchDir), { what: 'J1 running with a bench', jobId: J1, every: 20 });
    await api('POST', `/api/jobs/${J1}/pause`, { hard: true });
    await sleep(500);
    assert.equal(shop.job(J2).status, 'queued', 'J2 waits while J1 is paused');
    // Cancel J1 before anything is loaded: no truck stays, so the integration branch and _int go too.
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    const loadedBefore = shop.deliveries(J1).filter((d) => d.status === 'loaded').length;
    const c1 = await api('POST', `/api/jobs/${J1}/cancel`, {});
    assert.equal(c1.body.status, 'cancelled');
    const p1 = shop.project(J1);
    assert.equal(loadedBefore, 0, 'nothing is loaded yet (the first task still works)');
    {
      assert.equal(c1.body.truckKept, false);
      await shop.waitFor(() => git(p1.path, 'for-each-ref', `refs/heads/ws/${J1}/`) === '', { what: `ws/${J1}/int removed after a cancel with an empty truck`, timeoutMs: 10_000 });
      assert.equal(fs.existsSync(path.join(shop.app.paths.work, J1, '_int')), false, 'the _int worktree is gone');
      const inbox = await shop.inbox(J1);
      assert.ok(!inbox.some((i) => i.kind === 'truck'), 'no truck item for an empty truck');
    }
    // J2 is promoted. Its project has the same name: it must not reuse J1's repo.
    await shop.waitFor(() => shop.job(J2).status !== 'queued', { what: 'J2 promoted', jobId: J2 });
    assert.equal(shop.job(J2).waitReason, null);
    await toDone(shop, J2);
    const p2 = shop.project(J2);
    assert.notEqual(p2.path, p1.path, 'a second new project with the same name gets its own folder');
    assertLedgerClosed(shop.job(J2));
    assert.equal(shop.job(J3).status, 'cancelled', 'the cancelled queued job never started');
    assert.equal(shop.turns.filter((x) => x.jobId === J3).length, 0);
    // Delete the cancelled ones.
    assert.equal((await api('DELETE', `/api/jobs/${J3}`)).status, 200);
    assert.equal((await api('DELETE', `/api/jobs/${J1}`)).status, 200);
    assert.equal(git(p1.path, 'for-each-ref', `refs/workshop/${J1}/`), '', 'the saved refs go at delete');
    assert.equal(fs.existsSync(path.join(shop.app.paths.work, J1)), false);
    assert.equal(shop.tasks(J1).length, 0);
    assert.equal(shop.job(J1).title, 'Notes app', 'title stays');
    assert.ok(shop.job(J1).requirements.length > 0, 'the ledger stays');
    await finish(shop);
  });

  test('cancel in delivering keeps the truck; inbox offers it; discard drops crates and the branch; ship is refused; delete keeps the ledger and report', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    await toDelivering(shop, J);
    const report = shop.job(J).report;
    const project = shop.project(J);
    const main0 = git(project.path, 'rev-parse', project.targetBranch);
    const c = await api('POST', `/api/jobs/${J}/cancel`, {});
    assert.deepEqual([c.body.status, c.body.truckKept], ['cancelled', true]);
    assert.equal((await api('POST', `/api/jobs/${J}/cancel`, {})).status, 409, 'cancel twice is refused');
    assert.equal((await api('POST', `/api/jobs/${J}/resume`, {})).status, 409, 'a cancelled job does not resume');
    assert.equal((await api('POST', `/api/jobs/${J}/changes`, { text: 'More.' })).status, 409, 'no changes on a cancelled job');
    assert.equal((await api('POST', `/api/jobs/${J}/reqs`, { text: 'More.' })).status, 409);
    const inbox = await shop.inbox(J);
    assert.ok(inbox.some((i) => i.kind === 'truck'), 'the inbox offers the loaded truck');
    assert.ok(git(project.path, 'rev-parse', `ws/${J}/int`));
    const d = await api('POST', `/api/jobs/${J}/truck/discard`, {});
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(git(project.path, 'for-each-ref', `refs/heads/ws/${J}/`), '', 'discard drops the integration branch');
    assert.ok(shop.deliveries(J).every((x) => x.status !== 'loaded'), 'no crate stays loaded');
    assert.ok(!(await shop.inbox(J)).some((i) => i.kind === 'truck'), 'the truck item is gone');
    const s = await api('POST', `/api/jobs/${J}/ship`, { sha: shop.job(J).intSha });
    assert.equal(s.body.ok, false, 'nothing ships after a discard');
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), main0, 'the target branch never moved');
    assert.equal((await api('POST', `/api/jobs/${J}/truck/discard`, {})).status, 200, 'a second discard is harmless');
    const del = await api('DELETE', `/api/jobs/${J}`);
    assert.equal(del.status, 200);
    const job = shop.job(J);
    assert.equal(job.report, report, 'delete keeps the report');
    assert.ok(job.requirements.length > 0 && job.brief === BRIEF);
    assert.equal(shop.deliveries(J).length, 0);
    assert.equal((await api('GET', `/api/jobs/${J}/truck`)).status, 404, 'a deleted job has no truck');
    const gone = await api('POST', `/api/jobs/${J}/ship`, { sha: 'a'.repeat(40) });
    assert.ok(gone.status === 404 || gone.body.ok === false, 'nothing ships from a deleted job');
    assert.equal((await api('DELETE', `/api/jobs/${J}`)).status, 404, 'delete twice: unknown job');
    await finish(shop);
  });
});

const reqOf = (job, id) => job.requirements.find((r) => r.id === id);

describe('owner and ledger: requirements at every job status', () => {
  test('plan_review: the inbox shows the plan; the owner adds a requirement and waives a plan one; approve; done with the new one verified and the waived one waived', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF, options: { approvePlan: true } })).id;
    assert.equal((await api('POST', `/api/jobs/${J}/reqs`, { text: 'Too early.' })).status, 409, 'no requirement before the plan');
    assert.equal((await api('POST', `/api/jobs/${J}/changes`, { text: 'Too early.' })).status, 409, 'no change before the plan');
    assert.equal((await api('DELETE', `/api/jobs/${J}`)).status, 409, 'a live job is not deleted');
    assert.equal((await api('POST', `/api/jobs/${J}/truck/discard`, {})).status, 409, 'discard is for a cancelled job');
    await shop.waitFor(() => shop.job(J).status === 'plan_review', { what: 'plan_review', jobId: J });
    const inbox = await shop.inbox(J);
    assert.ok(inbox.some((i) => i.kind === 'plan' && i.jobId === J), 'the inbox shows the plan');
    const add = await api('POST', `/api/jobs/${J}/reqs`, { text: 'Each note shows the date it was made.' });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const R = add.body.id;
    assert.deepEqual([add.body.source, add.body.status], ['owner', 'open']);
    // Waive a plan requirement (the last one) with and without a reason.
    const plan = shop.job(J).requirements.filter((r) => r.source === 'plan');
    const W = plan[plan.length - 1].id;
    assert.equal((await api('POST', `/api/jobs/${J}/reqs/${W}/waive`, {})).status, 400, 'a waiver needs a reason');
    assert.equal((await api('POST', `/api/jobs/${J}/reqs/R999/waive`, { reason: 'x' })).status, 404);
    const w = await api('POST', `/api/jobs/${J}/reqs/${W}/waive`, { reason: 'Not needed for the first version.' });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(reqOf(shop.job(J), W).status, 'waived');
    // The lead turns the new requirement into a task while the plan waits.
    await shop.waitFor(() => shop.tasks(J).some((x) => x.reqs.includes(R)), { what: `a task for ${R} in plan_review`, jobId: J });
    assert.equal(shop.job(J).status, 'plan_review', 'the plan still waits for the owner');
    const ap = await api('POST', `/api/jobs/${J}/plan/approve`, {});
    assert.equal(ap.body.status, 'running');
    assert.ok(!(await shop.inbox(J)).some((i) => i.kind === 'plan'), 'the plan item is gone after approval');
    assert.equal((await api('POST', `/api/jobs/${J}/plan/approve`, {})).status, 409, 'approve twice is refused');
    await toDone(shop, J);
    const job = shop.job(J);
    assertLedgerClosed(job);
    assert.equal(reqOf(job, R).status, 'verified');
    assert.equal(reqOf(job, W).status, 'waived', 'a waiver survives every QA round');
    assert.match(job.report, new RegExp(W), 'the report names the waived requirement');
    // After done the ledger is closed.
    assert.equal((await api('POST', `/api/jobs/${J}/reqs`, { text: 'Late.' })).status, 409);
    assert.equal((await api('POST', `/api/jobs/${J}/changes`, { text: 'Late.' })).status, 409);
    const lateWaive = await api('POST', `/api/jobs/${J}/reqs/${R}/waive`, { reason: 'Late.' });
    assert.equal(lateWaive.status, 409, 'a waiver after done would rewrite the final ledger');
    assert.equal(reqOf(shop.job(J), R).status, 'verified');
    await finish(shop);
  });

  test('a requirement added at the start of the QA turn, and another at the start of the report turn: neither is lost', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    const added = {};
    shop.hooks.push(async (rec) => {
      if (rec.jobId !== J) return;
      if (rec.kind === 'qa' && !added.qa) {
        added.qa = 'pending';
        const r = await api('POST', `/api/jobs/${J}/reqs`, { text: 'Search ignores upper and lower case.' });
        added.qa = r.body.id;
      } else if (rec.kind === 'report' && added.qa && !added.report) {
        added.report = 'pending';
        const r = await api('POST', `/api/jobs/${J}/changes`, { text: 'Show the number of notes above the list.' });
        added.report = r.body.req?.id;
      }
    });
    await shop.waitFor(() => added.report && added.report !== 'pending', { what: 'both owner additions', jobId: J });
    assert.match(added.qa, /^R\d+$/);
    assert.match(added.report, /^R\d+$/);
    await toDone(shop, J);
    const job = shop.job(J);
    assertLedgerClosed(job);
    assert.equal(reqOf(job, added.qa).status, 'verified');
    assert.equal(reqOf(job, added.report).status, 'verified');
    for (const id of [added.qa, added.report]) assert.ok(shop.tasks(J).some((x) => x.reqs.includes(id) && x.status === 'merged'), `a merged task serves ${id}`);
    assert.ok(job.qa.round >= 3, `QA ran again for each addition (round ${job.qa.round})`);
    await finish(shop);
  });

  test('delivering: pause, add a requirement while paused, resume: the job runs again (no stale report), and the requirement is verified', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    await toDelivering(shop, J);
    const inbox0 = await shop.inbox(J);
    assert.ok(inbox0.some((i) => i.kind === 'truck'), 'delivering: the inbox shows the truck');
    const p = await api('POST', `/api/jobs/${J}/pause`, {});
    assert.deepEqual([p.body.status, p.body.prevStatus], ['paused', 'delivering']);
    const inbox1 = await shop.inbox(J);
    assert.ok(inbox1.some((i) => i.kind === 'paused'), 'paused: the inbox shows it');
    const add = await api('POST', `/api/jobs/${J}/reqs`, { text: 'Notes can be deleted one by one.' });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const R = add.body.id;
    await sleep(800);
    assert.equal(shop.turns.filter((x) => x.jobId === J && x.kind === 'change').length, 0, 'no change turn while paused');
    const res = await api('POST', `/api/jobs/${J}/resume`, {});
    assert.equal(res.status, 200);
    assert.notEqual(res.body.status, 'delivering', 'a new open requirement sends the job back to running, not to delivering');
    assert.equal(shop.job(J).report, null, 'the old report is cleared');
    // Shipping now ships the loaded crates, but the job cannot be done until the new requirement is verified.
    const { ship } = await shipHead(shop, J);
    assert.equal(ship.ok, true, JSON.stringify(ship));
    await sleep(500);
    assert.notEqual(shop.job(J).status, 'done', 'not done with an open requirement');
    await toDone(shop, J);
    const job = shop.job(J);
    assertLedgerClosed(job);
    assert.equal(reqOf(job, R).status, 'verified');
    await finish(shop);
  });

  test('delivering: request changes on one crate, then ship at once before the lead acts: the new requirement still has to be verified before done', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    await toDelivering(shop, J);
    const crate = shop.deliveries(J).find((d) => d.status === 'loaded');
    assert.equal((await api('POST', `/api/jobs/${J}/changes`, { deliveryId: 'D999', text: 'x' })).status, 404);
    const ch = await api('POST', `/api/jobs/${J}/changes`, { deliveryId: crate.id, text: 'Trim spaces around each note before saving.' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const R = ch.body.req.id;
    assert.equal(shop.job(J).status, 'running');
    assert.equal(shop.job(J).report, null);
    const { ship } = await shipHead(shop, J);
    assert.equal(ship.ok, true, JSON.stringify(ship));
    assert.ok(!(await shop.inbox(J)).some((i) => i.kind === 'truck'), 'the truck is empty');
    await shop.waitFor(() => shop.tasks(J).some((x) => x.reqs.includes(R)), { what: `a task for ${R}`, jobId: J });
    const change = shop.turns.find((x) => x.jobId === J && x.kind === 'change');
    assert.ok(change.prompt.includes(crate.taskId) || change.prompt.includes(crate.id), 'the change turn names the crate');
    await toDone(shop, J);
    const job = shop.job(J);
    assertLedgerClosed(job);
    assert.equal(reqOf(job, R).status, 'verified');
    await finish(shop);
  });
});

describe('owner and ledger: task stop, retry and cancel', () => {
  test('stop a working task (blocked why owner, no stall pause), cancel rules with dependents and replacedBy, the requirement rule, retry with a note; done', T, async (t) => {
    // Turns of about a second, so the stop meets the first work turn in flight.
    const shop = await boot({ settings: { mockSpeed: 0.3 } });
    guard(t, shop);
    const { api, app } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    const inReview = [];
    shop.hooks.push(async (rec) => {
      if (rec.jobId !== J || rec.kind !== 'review' || inReview.length) return;
      const r = await api('POST', `/api/tasks/${rec.taskId}/stop`, { note: 'x' });
      inReview.push({ task: rec.taskId, status: r.status });
    });
    const T1 = await shop.waitFor(() => shop.tasks(J).find((x) => x.status === 'working' && x.assigneeId && app.runner.busy(x.assigneeId)), { what: 'a working task with its turn in flight', jobId: J, every: 10 });
    const deps = shop.tasks(J).filter((x) => x.deps.includes(T1.id));
    assert.ok(deps.length >= 2, 'the first task has dependents');
    const stop = await api('POST', `/api/tasks/${T1.id}/stop`, { note: 'Wait: I want to look first.' });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.deepEqual([stop.body.status, stop.body.why], ['blocked', 'owner']);
    await shop.waitFor(() => !app.runner.busy(T1.assigneeId), { what: 'the stopped turn ends', jobId: J, timeoutMs: 20_000 });
    await sleep(1500);
    const t1 = shop.task(T1.id);
    assert.deepEqual([t1.status, t1.why, t1.needsAction], ['blocked', 'owner', null], 'the stop holds after the turn ended');
    assert.match(t1.lastError, /Wait: I want to look first\./);
    assert.equal(shop.job(J).status, 'running', 'an owner stop is not a stall');
    assert.equal((await api('POST', `/api/tasks/${T1.id}/stop`, {})).status, 200, 'stop of a stopped task is harmless');

    // Cancel rules.
    assert.equal((await api('POST', `/api/tasks/${T1.id}/cancel`, {})).status, 400, 'a cancel needs a reason');
    const c1 = await api('POST', `/api/tasks/${T1.id}/cancel`, { reason: 'Not needed.' });
    assert.equal(c1.status, 409, 'a task with dependents needs replacedBy');
    const c2 = await api('POST', `/api/tasks/${T1.id}/cancel`, { reason: 'Not needed.', replacedBy: [deps[0].id] });
    assert.equal(c2.status, 409, `a dependent cannot replace its own dep: ${JSON.stringify(c2.body)}`);
    assert.equal((await api('POST', `/api/tasks/${T1.id}/cancel`, { reason: 'x', replacedBy: ['T999'] })).status, 404);
    // A part task (planned): its own requirements block the cancel until the owner waives them.
    const docs = shop.tasks(J).find((x) => x.deps.length > 1);
    const alone = (task) => task.reqs.filter((rid) => !shop.tasks(J).some((x) => x.id !== task.id && x.reqs.includes(rid)));
    const part = deps.find((x) => x.id !== docs.id && docs.deps.includes(x.id) && alone(x).length > 0);
    const job0 = shop.job(J);
    assert.ok(part, `a part task alone serves a requirement: ${shop.tasks(J).map((x) => `${x.id}:${x.reqs}`).join(' ')}`);
    const only = alone(part);
    const c3 = await api('POST', `/api/tasks/${part.id}/cancel`, { reason: 'Drop it.', replacedBy: [T1.id] });
    assert.equal(c3.status, 409, 'the requirement rule refuses the cancel');
    assert.match(c3.body.error, new RegExp(only[0]));
    for (const rid of only) assert.equal((await api('POST', `/api/jobs/${J}/reqs/${rid}/waive`, { reason: 'The owner drops this part.' })).status, 200);
    const c4 = await api('POST', `/api/tasks/${part.id}/cancel`, { reason: 'Drop it.' });
    assert.equal(c4.status, 409, 'still: docs depends on it');
    const c5 = await api('POST', `/api/tasks/${part.id}/cancel`, { reason: 'Drop it.', replacedBy: [T1.id] });
    assert.equal(c5.status, 200, JSON.stringify(c5.body));
    assert.equal(c5.body.status, 'cancelled');
    assert.deepEqual(c5.body.replacedBy, [T1.id]);
    const docsNow = shop.task(docs.id);
    assert.ok(!docsNow.deps.includes(part.id) && docsNow.deps.includes(T1.id), `the dependents move to replacedBy: ${docsNow.deps}`);
    assert.equal((await api('POST', `/api/tasks/${part.id}/cancel`, { reason: 'again' })).status, 409, 'cancel twice is refused');
    assert.equal((await api('POST', `/api/tasks/${part.id}/retry`, {})).status, 409, 'a cancelled task is not retried');
    void job0;

    // Retry the stopped task with a note: a fresh session that carries the note.
    assert.equal((await api('POST', `/api/tasks/${T1.id}/retry`, { model: 'bigger' })).status, 400);
    const r = await api('POST', `/api/tasks/${T1.id}/retry`, { note: 'Go on, keep it small.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(['working', 'ready'].includes(r.body.status));
    assert.equal(r.body.why, null);
    assert.equal((await api('POST', `/api/tasks/${T1.id}/retry`, {})).status, 409, 'a working task is not retried');
    await shop.waitFor(() => shop.turns.find((x) => x.taskId === T1.id && x.kind === 'work' && /RETRY of T/.test(x.prompt) && x.prompt.includes('Go on, keep it small.')), { what: 'the retry turn with the note', jobId: J });

    await toDone(shop, J);
    const job = shop.job(J);
    assertLedgerClosed(job);
    for (const rid of only) assert.equal(reqOf(job, rid).status, 'waived');
    assert.equal(shop.task(part.id).status, 'cancelled');
    assert.ok(job.report.includes(part.id), 'the report lists the cancelled task');
    assert.ok(inReview.length === 1 && inReview[0].status === 409, `stop of a task in review is refused: ${JSON.stringify(inReview)}`);
    const merged = shop.tasks(J).find((x) => x.status === 'merged');
    assert.equal((await api('POST', `/api/tasks/${merged.id}/cancel`, { reason: 'late' })).status, 409);
    assert.equal((await api('POST', `/api/tasks/${merged.id}/stop`, {})).status, 409);
    await finish(shop);
  });
});

describe('owner and ledger: presence and the owner questions', () => {
  test('here, then away: the default is taken when the owner leaves; the owner later answers with the default option: confirmed, unpinned, no overturn', T, async (t) => {
    const shop = await boot({ settings: { presence: 'here', humanWaitMin: 30 } });
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: `${BRIEF} [mock:human]` })).id;
    const ask = await shop.waitFor(() => shop.msgs(J).find((m) => m.kind === 'ASK' && m.to === '@human'), { what: 'an ASK @human', jobId: J });
    const q0 = (await shop.inbox(J)).find((i) => i.kind === 'question' && i.msgId === ask.id);
    assert.deepEqual([q0?.defaulted, q0?.default], [false, 'A'], 'the question waits in the inbox');
    assert.equal((await api('PUT', '/api/presence', { state: 'gone' })).status, 400);
    const away = await api('PUT', '/api/presence', { state: 'away' });
    assert.equal(away.status, 200);
    const dflt = await shop.waitFor(() => shop.msgs(J).find((m) => m.kind === 'ANS' && m.re === ask.id && m.from === '@hub'), { what: 'the default taken when the owner leaves', jobId: J, timeoutMs: 10_000 });
    assert.match(dflt.body, /Default taken: the owner is away\./);
    await shop.waitFor(() => shop.job(J).assumptions.some((a) => a.msgId === ask.id), { what: 'the assumption', jobId: J });
    const q1 = (await shop.inbox(J)).find((i) => i.kind === 'question' && i.msgId === ask.id);
    assert.equal(q1?.defaulted, true, 'the question stays pinned with its default');
    await api('PUT', '/api/presence', { state: 'here' });
    // The owner confirms with the default option.
    const turnsBefore = shop.turns.length;
    const post = await api('POST', '/api/board', { jobId: J, kind: 'ANS', re: ask.id, body: 'A. Plain text is fine.' });
    assert.equal(post.body.ok, true, JSON.stringify(post.body));
    await shop.waitFor(() => shop.job(J).assumptions.find((a) => a.msgId === ask.id)?.confirmed === true, { what: 'the assumption confirmed', jobId: J });
    const a = shop.job(J).assumptions.find((x) => x.msgId === ask.id);
    assert.ok(!a.owner, 'not overturned');
    assert.ok(!(await shop.inbox(J)).some((i) => i.kind === 'question' && i.msgId === ask.id), 'unpinned');
    await sleep(500);
    assert.ok(!shop.turns.slice(turnsBefore).some((x) => /overturned the default/.test(x.prompt)), 'no overturn wake');
    // A second owner answer to the same question is refused (it is answered).
    const again = await api('POST', '/api/board', { jobId: J, kind: 'ANS', re: ask.id, body: 'B. Use JSON.' });
    assert.equal(again.body.ok === true, false, `a second answer: ${JSON.stringify(again.body)}`);
    await toDone(shop, J);
    assertLedgerClosed(shop.job(J));
    assert.ok(shop.job(J).assumptions.find((x) => x.msgId === ask.id).confirmed);
    await finish(shop);
  });

  test('here with a long wait: the job reaches delivering with the owner question open; the owner ships without an answer; at done the default is on record, not lost', T, async (t) => {
    const shop = await boot({ settings: { presence: 'here', humanWaitMin: 30 } });
    guard(t, shop);
    const J = (await start(shop, { brief: `${BRIEF} [mock:human]` })).id;
    const ask = await shop.waitFor(() => shop.msgs(J).find((m) => m.kind === 'ASK' && m.to === '@human'), { what: 'an ASK @human', jobId: J });
    await toDelivering(shop, J);
    const inbox = await shop.inbox(J);
    const q = inbox.find((i) => i.kind === 'question' && i.msgId === ask.id);
    assert.equal(q?.defaulted, false, 'the question still waits for the owner');
    assert.ok(inbox.some((i) => i.kind === 'truck'), 'beside the truck');
    assert.ok(!shop.job(J).assumptions.some((x) => x.msgId === ask.id), 'no default before humanWaitMin');
    await toDone(shop, J);
    await shop.waitFor(() => shop.job(J).assumptions.find((x) => x.msgId === ask.id), { what: 'the default on record at done', jobId: J, timeoutMs: 10_000 });
    const a = shop.job(J).assumptions.find((x) => x.msgId === ask.id);
    assert.match(a.text, /Default A/);
    const m = shop.app.board.get(ask.id);
    assert.equal(m.state, 'answered', `the question is answered by its default, not expired (${m.state})`);
    assert.ok(shop.msgs(J).some((x) => x.kind === 'ANS' && x.re === ask.id && x.from === '@hub' && /the work order ended/.test(x.body)));
    assertLedgerClosed(shop.job(J));
    await finish(shop);
  });
});

describe('owner and ledger: budgets in apikey mode', () => {
  test('a billed lab: the job pauses at its budget, starts no billed turn while paused, resume needs a higher budget, then the job ends done', T, async (t) => {
    // The mock lab in apikey mode, each turn billed $0.05 by the CLI (the registry has no price for it).
    const shop = await boot({ settings: { auth: { mock: 'apikey' } }, app: (dirs) => ({ adapters: billingAdapters(dirs, 0.05) }) });
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF, extra: { budgetUsd: 0.3 } })).id;
    await shop.waitFor(() => shop.job(J).status === 'paused', { what: 'the budget stop', jobId: J });
    const job = shop.job(J);
    assert.equal(job.pauseReason, 'budget', `${job.pauseReason}: ${job.error}`);
    assert.ok(job.cost.billedUsd >= 0.3, `billed ${job.cost.billedUsd}`);
    assert.equal(job.cost.estUsd, 0, 'apikey turns are billed, not estimated');
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    const billedAtStop = shop.job(J).cost.billedUsd;
    // At most the turns in flight at the stop end after it; none starts later.
    const turns = shop.turns.length;
    await sleep(1500);
    assert.equal(shop.turns.length, turns, 'no turn starts while paused at the budget');
    assert.equal(shop.job(J).cost.billedUsd, billedAtStop);
    const inbox = await shop.inbox(J);
    const b = inbox.find((i) => i.kind === 'budget');
    assert.ok(b, `the inbox asks for a budget: ${JSON.stringify(inbox)}`);
    assert.ok(!inbox.some((i) => i.kind === 'paused'), 'one item, of kind budget');
    // Resume rules.
    assert.equal((await api('POST', `/api/jobs/${J}/resume`, {})).status, 400, 'resume needs a budget');
    assert.equal((await api('POST', `/api/jobs/${J}/resume`, { budgetUsd: 0.1 })).status, 400, 'a budget below the billed amount is refused');
    assert.equal((await api('POST', `/api/jobs/${J}/resume`, { budgetUsd: billedAtStop })).status, 400, 'a budget equal to the billed amount is refused');
    assert.equal((await api('POST', `/api/jobs/${J}/resume`, { budgetUsd: -1 })).status, 400);
    const r = await api('POST', `/api/jobs/${J}/resume`, { budgetUsd: 1000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.budgetUsd, 1000);
    assert.notEqual(r.body.status, 'paused');
    await toDone(shop, J);
    const end = shop.job(J);
    assertLedgerClosed(end);
    assert.ok(end.cost.billedUsd > billedAtStop);
    await finish(shop);
  });
});

describe('owner and ledger: owner actions at awkward moments', () => {
  test('cancel at once after create (during intake): the job stays cancelled and leaves no integration branch', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    const c = await api('POST', `/api/jobs/${J}/cancel`, {});
    assert.equal(c.body.status, 'cancelled');
    await sleep(1500);
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    assert.equal(shop.job(J).status, 'cancelled', 'intake does not bring it back');
    assert.equal(shop.turns.filter((x) => x.jobId === J).length, 0, 'no agent turn');
    const p = shop.project(J);
    if (p) assert.equal(git(p.path, 'for-each-ref', `refs/heads/ws/${J}/`), '', 'no integration branch is left');
    assert.equal(fs.existsSync(path.join(shop.app.paths.work, J, '_int')), false);
    // A second job starts normally.
    const J2 = (await start(shop, { brief: BRIEF, name: 'other' })).id;
    await toDone(shop, J2);
    assertLedgerClosed(shop.job(J2));
    await finish(shop);
  });

  test('a soft pause at the start of the QA turn and a hard pause at the start of the report turn: each resume goes on, and the ledger closes', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    const seen = { qa: false, report: false };
    shop.hooks.push(async (rec) => {
      if (rec.jobId !== J) return;
      if (rec.kind === 'qa' && !seen.qa) {
        seen.qa = true;
        assert.equal((await api('POST', `/api/jobs/${J}/pause`, {})).body.prevStatus, 'qa');
      } else if (rec.kind === 'report' && !seen.report) {
        seen.report = true;
        // The hard pause interrupts this turn as soon as it runs.
        setTimeout(() => { api('POST', `/api/jobs/${J}/pause`, { hard: true }).catch(() => {}); }, 0);
      }
    });
    await shop.waitFor(() => seen.qa && shop.job(J).status === 'paused' && !shop.app.runner.active().length, { what: 'the soft pause in QA', jobId: J });
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    assert.equal(shop.job(J).status, 'paused');
    assert.ok(shop.job(J).requirements.every((r) => r.status === 'open' || r.status === 'waived'), 'req_verify is refused while paused');
    assert.equal((await api('POST', `/api/jobs/${J}/resume`, {})).body.status, 'qa');
    await shop.waitFor(() => seen.report && shop.job(J).status === 'paused', { what: 'the hard pause at the report', jobId: J });
    await shop.waitFor(() => !shop.app.runner.active().length, { what: 'the report turn stops', jobId: J });
    assert.equal(shop.job(J).prevStatus, 'delivering');
    assert.equal((await api('POST', `/api/jobs/${J}/resume`, {})).body.status, 'delivering');
    await toDone(shop, J);
    assertLedgerClosed(shop.job(J));
    await finish(shop);
  });

  test('cancel at the start of the QA turn: the loaded truck stays and ships; requirements stay as they were; delete', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    let cancelled = null;
    shop.hooks.push(async (rec) => {
      if (rec.jobId !== J || rec.kind !== 'qa' || cancelled) return;
      cancelled = 'pending';
      setTimeout(async () => { cancelled = (await api('POST', `/api/jobs/${J}/cancel`, {})).body; }, 0);
    });
    await shop.waitFor(() => cancelled && cancelled !== 'pending', { what: 'the cancel in QA', jobId: J });
    assert.deepEqual([cancelled.status, cancelled.truckKept], ['cancelled', true]);
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    assert.equal(shop.job(J).status, 'cancelled');
    assert.ok(!shop.job(J).requirements.some((r) => r.status === 'verified'), 'no requirement is verified by a cancelled QA turn');
    const truck = (await api('GET', `/api/jobs/${J}/truck`)).body;
    assert.ok(truck.deliveries.length > 0);
    const s = await api('POST', `/api/jobs/${J}/ship`, { sha: truck.headSha });
    assert.deepEqual([s.body.ok, s.body.left], [true, 0], JSON.stringify(s.body));
    const project = shop.project(J);
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), truck.headSha);
    assert.equal(git(project.path, 'for-each-ref', `refs/heads/ws/${J}/`), '', 'after the ship of a cancelled job the integration branch goes');
    assert.deepEqual((await shop.inbox(J)).filter((i) => i.kind === 'truck'), []);
    assert.equal((await api('DELETE', `/api/jobs/${J}`)).status, 200);
    await finish(shop);
  });

  test('a requirement waived while the lead turns it into a task, and one waived after its task exists: no work for the first, both end waived, done', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    await shop.waitFor(() => shop.job(J).status === 'running', { what: 'running', jobId: J });
    // The owner waives the first one right as the lead's change turn for it starts.
    let a = null;
    let waivedAt = null;
    shop.hooks.push(async (rec) => {
      if (rec.jobId !== J || rec.kind !== 'change' || !a || waivedAt || !rec.prompt.includes(a)) return;
      const w = await api('POST', `/api/jobs/${J}/reqs/${a}/waive`, { reason: 'Changed my mind.' });
      waivedAt = w.status;
    });
    a = (await api('POST', `/api/jobs/${J}/reqs`, { text: 'Notes can be pinned to the top.' })).body.id;
    await shop.waitFor(() => waivedAt, { what: `the waiver of ${a} in the change turn`, jobId: J });
    assert.equal(waivedAt, 200);
    await shop.waitFor(() => (shop.job(J).changes ?? []).every((c) => c.done), { what: 'the change is settled', jobId: J });
    await shop.app.orch.settle({ timeoutMs: 30_000 });
    assert.ok(!shop.tasks(J).some((x) => x.reqs.includes(a)), `no task is made for the waived ${a}`);
    assert.ok(!shop.notices().some((n) => n.text.includes(`no task for ${a}`)), 'no "made no task" notice for a waived requirement');
    const b = (await api('POST', `/api/jobs/${J}/reqs`, { text: 'Notes have a title line.' })).body.id;
    const served = await shop.waitFor(() => shop.tasks(J).find((x) => x.reqs.includes(b)), { what: `a task for ${b}`, jobId: J });
    assert.equal((await api('POST', `/api/jobs/${J}/reqs/${b}/waive`, { reason: 'Not now.' })).status, 200);
    await toDone(shop, J);
    const job = shop.job(J);
    assertLedgerClosed(job);
    assert.equal(reqOf(job, a).status, 'waived');
    assert.equal(reqOf(job, b).status, 'waived');
    assert.ok(!shop.tasks(J).some((x) => x.reqs.includes(a)), `no task was made for the waived ${a}`);
    assert.ok(['merged', 'cancelled'].includes(shop.task(served.id).status));
    await finish(shop);
  });
});

describe('owner and ledger: the inbox when the crew does not act', () => {
  test('no reviewer gives a verdict: each delivery waits for the owner (inbox review item); the owner posts FIX once, then PASS; the job ends done', T, async (t) => {
    const noReview = ({ prompt }) => /(^|\n)REVIEW T\d+/.test(prompt) || /You ended your turn without a verdict/.test(prompt);
    const shop = await boot({ app: (dirs) => ({ adapters: blankingAdapters(dirs, noReview) }) });
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    const verdicts = [];
    await shop.waitFor(async () => {
      const job = shop.job(J);
      if (job.status === 'delivering' && job.report) return true;
      for (const item of (await shop.inbox(J)).filter((i) => i.kind === 'review')) {
        if (verdicts.some((v) => v.msgId === item.msgId)) continue;
        const d = shop.app.store.get('deliveries', item.id);
        assert.ok(d && d.waitHuman && d.status === 'review', `the review item names a delivery that waits for the owner: ${JSON.stringify(item)}`);
        assert.equal(d.doneMsgId, item.msgId);
        const fix = !verdicts.some((v) => v.kind === 'FIX');
        const file = d.files?.[0]?.path ?? 'README.md';
        const r = fix
          ? await api('POST', '/api/board', { jobId: J, kind: 'FIX', re: item.msgId, body: `1. Add a short comment at the top of ${file}:1 that says what the file does.` })
          : await api('POST', '/api/board', { jobId: J, kind: 'PASS', re: item.msgId, body: 'Looks good.' });
        assert.equal(r.body.ok, true, `owner ${fix ? 'FIX' : 'PASS'}: ${JSON.stringify(r.body)}`);
        verdicts.push({ msgId: item.msgId, kind: fix ? 'FIX' : 'PASS', task: d.taskId });
      }
      return false;
    }, { what: 'delivering, with the owner as the reviewer', jobId: J, timeoutMs: 240_000, every: 100 });
    assert.ok(verdicts.some((v) => v.kind === 'FIX'), 'the owner sent one delivery back');
    const fixed = verdicts.find((v) => v.kind === 'FIX').task;
    assert.ok(verdicts.some((v) => v.kind === 'PASS' && v.task === fixed), 'the reworked delivery came back to the owner and passed');
    assert.ok(shop.notices().some((n) => n.level === 'owner' && /verdict|PASS|FIX/.test(n.text)), 'an owner notice asked for the verdict');
    await toDone(shop, J);
    assertLedgerClosed(shop.job(J));
    assert.ok(shop.tasks(J).every((x) => x.status === 'merged'));
    await finish(shop);
  });

  test('the lead makes no task for an owner requirement: owner notice and an inbox requirement item with Waive, Add task, Stop job; the owner waives it; done', T, async (t) => {
    let blankChanges = true;
    // Only the lead's change turn and its "has no task" nudge are blanked, found the way the mock agent finds its
    // turn. A plain text match can also blank another turn whose board view quotes such a line, for example a
    // review that runs inside this window on a slow machine: it then gives no verdict and the job waits.
    const noChange = ({ prompt }) => {
      if (!blankChanges) return false;
      const turn = detectTurn(prompt);
      return turn.kind === 'change' || (turn.kind === 'nudge' && turn.nudge === 'req');
    };
    const shop = await boot({ app: (dirs) => ({ adapters: blankingAdapters(dirs, noChange) }) });
    guard(t, shop);
    const { api } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    await shop.waitFor(() => shop.job(J).status === 'running', { what: 'running', jobId: J });
    const R = (await api('POST', `/api/jobs/${J}/reqs`, { text: 'Notes sync to a server.' })).body.id;
    const item = await shop.waitFor(async () => (await shop.inbox(J)).find((i) => i.kind === 'requirement' && i.reqId === R), { what: `the inbox requirement item for ${R}`, jobId: J });
    assert.deepEqual(item.options.map((o) => o.key), ['waive', 'task', 'stop']);
    assert.ok(shop.notices().some((n) => n.level === 'owner' && n.text.includes(R)), 'an owner notice names it');
    assert.equal(shop.turns.filter((x) => x.jobId === J && x.kind === 'change').length, 2, 'one change turn and one nudge');
    blankChanges = false;
    const w = await api('POST', `/api/jobs/${J}/reqs/${R}/waive`, { reason: 'No server in version one.' });
    assert.equal(w.status, 200);
    assert.ok(!(await shop.inbox(J)).some((i) => i.kind === 'requirement'), 'the item is gone after the waiver');
    await toDone(shop, J);
    const job = shop.job(J);
    assertLedgerClosed(job);
    assert.equal(reqOf(job, R).status, 'waived');
    await finish(shop);
  });
});

describe('owner and ledger: owner verdicts at awkward moments', () => {
  for (const kind of ['PASS', 'FIX']) {
    test(`the owner posts ${kind} on a DONE while the hub still checks the hand-in: the check gate still holds, the verdict is not lost, the job ends done`, T, async (t) => {
      const shop = await boot();
      guard(t, shop);
      const { app } = shop;
      const J = (await start(shop, { brief: BRIEF })).id;
      let done = null;
      let answer = null;
      const off = app.board.on((e) => {
        if (done || e.type !== 'post' || e.msg.kind !== 'DONE' || e.msg.jobId !== J) return;
        done = e.msg;
        queueMicrotask(() => {
          const body = kind === 'PASS' ? 'Fine by me.' : `1. Add one more test case in test/index.test.js:1 for an empty list.`;
          answer = app.orch.ownerPost({ jobId: J, kind, re: done.id, body });
        });
      });
      t.after(() => off?.());
      await shop.waitFor(() => answer, { what: 'the owner verdict on the first DONE', jobId: J });
      const d0 = shop.deliveries(J).find((x) => x.doneMsgId === done.id);
      assert.ok(d0, 'the DONE made a delivery');
      if (answer.ok) {
        // The verdict was taken: the hand-in pipeline (check) must still run before the crate can be merged.
        await shop.waitFor(() => !['checking'].includes(shop.app.store.get('deliveries', d0.id).status), { what: 'the hand-in pipeline ends', jobId: J });
      }
      await toDone(shop, J);
      const job = shop.job(J);
      assertLedgerClosed(job);
      const project = shop.project(J);
      for (const d of shop.deliveries(J).filter((x) => x.status === 'shipped')) {
        if (project.checkCmd) assert.equal(d.check?.ok, true, `${d.id} passed the check before it was merged`);
        assert.ok(d.review, `${d.id} has a verdict`);
      }
      const first = shop.app.store.get('deliveries', d0.id);
      if (answer.ok && kind === 'PASS') assert.equal(first.review?.by, '@human', 'the owner PASS is the verdict of that delivery');
      if (answer.ok && kind === 'FIX') assert.ok(first.status === 'rejected' && shop.deliveries(J).some((x) => x.taskId === d0.taskId && x.id !== d0.id), 'the owner FIX sent the task back');
      await finish(shop);
    });
  }
});

describe('owner and ledger: the owner reviews over the reviewer', () => {
  test('the owner posts PASS while the boss review turn starts: the owner verdict counts, the reviewer is not nudged, the crate loads', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const { app } = shop;
    const J = (await start(shop, { brief: BRIEF })).id;
    let first = null;
    shop.hooks.push(async (rec) => {
      if (rec.jobId !== J || rec.kind !== 'review' || first) return;
      const d = shop.deliveries(J).find((x) => x.taskId === rec.taskId && x.status === 'review');
      first = { task: rec.taskId, delivery: d.id, answer: app.orch.ownerPost({ jobId: J, kind: 'PASS', re: d.doneMsgId, body: 'Good.' }) };
    });
    await shop.waitFor(() => first && ['loaded', 'shipped'].includes(shop.app.store.get('deliveries', first.delivery).status), { what: 'the crate loads after the owner PASS', jobId: J });
    assert.equal(first.answer.ok, true, JSON.stringify(first.answer));
    const d = shop.app.store.get('deliveries', first.delivery);
    assert.equal(d.review.by, '@human');
    assert.ok(!shop.turns.some((x) => x.taskId === first.task && x.kind === 'review' && /You ended your turn without a verdict/.test(x.prompt)), 'no verdict nudge for the reviewer');
    await toDone(shop, J);
    assertLedgerClosed(shop.job(J));
    await finish(shop);
  });
});

describe('owner and ledger: an empty crate on the truck', () => {
  // The mock lab hands in empty only once (the hub refuses it once), so this scenario drives the real orchestrator,
  // board and git with the scripted runner of tests/orch/harness.mjs: T1 always hands in an empty bench.
  test('a crate with no commit of its own (second empty hand-in), merged before the last crate, ships with the head; the truck empties; done', T, async (t) => {
    const done = (task) => `DONE ${task.id} tests=1/1 acc=${task.acceptance.length}/${task.acceptance.length}: Nothing to change for ${task.id}.`;
    const h = await makeShop({
      planFor: () => samplePlan({ n: 2, chain: true }),
      brainHooks: {
        work: async (turn, hh) => {
          const task = hh.store.get('tasks', hh.store.get('agents', turn.agentId).taskId);
          if (task?.id !== 'T1' || turn.opts.access === 'read') return undefined;
          await turn.post(done(task));
          return {};
        },
      },
    });
    t.after(() => h.close());
    await h.start();
    await h.until(() => h.job().status === 'delivering' && h.job().report, 20000);
    const empty = h.deliveries().find((d) => d.taskId === 'T1' && d.status === 'loaded');
    assert.ok(empty?.flags.empty, 'the empty crate of T1 is loaded');
    const truck = await h.orch.truck('J1');
    const ship = await h.orch.ship('J1', { sha: truck.headSha });
    assert.equal(ship.ok, true, JSON.stringify(ship));
    assert.equal(ship.left, 0, `no crate stays loaded after the head ships: ${JSON.stringify(h.deliveries().map((d) => [d.id, d.taskId, d.status, d.mergeSha?.slice(0, 8)]))}`);
    await h.orch.tick();
    await h.settle();
    assert.equal(h.job().status, 'done', 'the truck is empty, so the job is done');
    assertLedgerClosed(h.job());
  });
});
