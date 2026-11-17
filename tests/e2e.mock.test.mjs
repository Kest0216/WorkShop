// End to end (contract section 15): the real hub on temp folders, the owner session, a mock job through the HTTP
// API and the SSE stream, from intake to a shipped truck and status done. The agents are the mock agent
// (server/providers/mock-agent.mjs) calling the real hub tools over MCP. No real AI CLI runs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BRIEF, assertAllVerified, bootShop, finish, git, shipAndFinish, startJob,
} from './e2e-harness.mjs';

const T = { timeout: 300_000 };
const benchOf = (shop, jobId, taskId) => path.join(shop.app.paths.work, jobId, taskId);

/** Close and clean up even when an assertion failed half way. */
function guard(t, shop) {
  t.after(async () => {
    await shop.close().catch(() => {});
    if (process.env.KEEP_E2E !== '1') fs.rmSync(shop.dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
  });
}

describe('e2e: one mock job through the HTTP API', () => {
  test('intake, plan, parallel benches, hand-ins, reviews in review clones, integration, truck, ship, QA, report, done', T, async (t) => {
    const shop = await bootShop();
    guard(t, shop);
    const { api, app } = shop;

    // The state the UI loads first.
    const state = await api('GET', '/api/state');
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.providers.filter((p) => p.usable).map((p) => p.id), ['mock'], 'only the mock lab runs');
    assert.deepEqual(state.body.inbox, []);

    const created = await startJob(shop);
    const J = created.id;
    assert.equal(created.status, 'queued');
    assert.equal(created.options.mock, true);

    // Parallel benches: at one moment two tasks work at the same time, each in its own clone under data/work/<job>/.
    const parallel = await shop.waitFor(() => {
      const working = shop.tasks(J).filter((x) => x.status === 'working' && x.benchDir && fs.existsSync(path.join(x.benchDir, '.git')));
      return working.length >= 2 ? working : null;
    }, { what: 'two tasks working at once', jobId: J });
    const benches = parallel.map((x) => x.benchDir);
    assert.equal(new Set(benches).size, benches.length, 'separate benches');
    for (const x of parallel) assert.equal(x.benchDir, benchOf(shop, J, x.id));
    assert.notEqual(parallel[0].assigneeId, parallel[1].assigneeId, 'one maker per task');

    // Every requirement is verified, the report is written, the truck waits: the owner reads it and ships it.
    await shop.waitFor(() => { const j = shop.job(J); return j.status === 'delivering' && j.report; }, { what: 'delivering', jobId: J });
    const job = shop.job(J);
    assertAllVerified(job);
    const tasks = shop.tasks(J);
    assert.ok(tasks.length >= 3, `${tasks.length} tasks`);
    assert.ok(tasks.every((x) => x.status === 'merged'), 'every task merged');
    for (const x of tasks) {
      assert.equal(fs.existsSync(benchOf(shop, J, x.id)), false, `no bench left for merged ${x.id}`);
      assert.equal(fs.existsSync(`${benchOf(shop, J, x.id)}.rev`), false, `no review clone left for merged ${x.id}`);
    }
    const loaded = shop.deliveries(J).filter((d) => d.status === 'loaded');
    assert.equal(loaded.length, tasks.length, 'one loaded crate per task');
    for (const d of loaded) {
      assert.match(d.mergeSha, /^[0-9a-f]{40}$/);
      assert.equal(d.check?.ok, true, `${d.id} passed the check`);
      assert.equal(d.review?.verdict, 'pass');
      assert.ok(d.doneMsgId, 'the crate came from a DONE');
    }

    const truck = await api('GET', `/api/jobs/${J}/truck`);
    assert.equal(truck.status, 200);
    assert.equal(truck.body.headSha, job.intSha, 'the truck shows the integration head');
    assert.equal(truck.body.behind, 0);
    assert.equal(truck.body.deliveries.length, loaded.length);
    assert.deepEqual(truck.body.reqs, { open: 0, failed: 0, verified: job.requirements.length, waived: 0 });
    assert.ok(truck.body.report.length > 20, 'the report is on the truck');
    assert.ok(truck.body.files.length > 0 && truck.body.stat.add > 0);
    const diff = await api('GET', `/api/jobs/${J}/diff`);
    assert.equal(diff.status, 200);
    assert.match(diff.type, /text\/plain/);
    assert.match(diff.body, /^diff --git /m);
    const inbox = await api('GET', `/api/inbox?job=${J}`);
    assert.ok(inbox.body.some((i) => i.kind === 'truck'), 'the inbox points at the truck');

    const ship = await api('POST', `/api/jobs/${J}/ship`, { sha: truck.body.headSha });
    assert.deepEqual(ship.body, { ok: true, sha: truck.body.headSha, left: 0 });
    await shop.waitFor(() => shop.job(J).status === 'done', { what: 'done', jobId: J });
    assert.equal(await app.orch.settle({ timeoutMs: 30_000 }), true, 'the cleanup step after done ended');
    await shop.waitFor(() => shop.seen('jobs', (j) => j.id === J && j.status === 'done').length > 0, { timeoutMs: 15_000, what: 'done on the SSE stream', jobId: J });

    // The owner's repo: main is the shipped commit, holds every merged file, and its check command passes there.
    const project = shop.project(J);
    assert.equal(git(project.path, 'rev-parse', project.targetBranch), truck.body.headSha);
    assert.equal(git(project.path, 'status', '--porcelain'), '', 'the checkout is clean');
    const onMain = git(project.path, 'ls-tree', '-r', '--name-only', project.targetBranch).split('\n');
    for (const d of loaded) for (const f of d.files) assert.ok(onMain.includes(f.path), `${f.path} of ${d.taskId} is on ${project.targetBranch}`);
    assert.ok(project.checkCmd, 'the plan set a check command');
    const check = await app.git.runCheck(project.path, project.checkCmd, { timeoutMs: 120_000 });
    assert.equal(check.ok, true, check.tail);
    assert.match(check.tail, /# pass [1-9]/);
    assert.equal(fs.existsSync(path.join(app.paths.work, J)), false, 'the work folder of a done job is gone');
    assert.equal(git(project.path, 'for-each-ref', 'refs/heads/ws/'), '', 'the integration branch is gone');

    // What the SSE stream showed, in order: the job statuses, the plan notice, the crates, ship and confetti.
    const statuses = shop.seen('jobs', (j) => j.id === J).map((j) => j.status).filter((s, i, a) => s !== a[i - 1]);
    for (const s of ['queued', 'planning', 'running', 'qa', 'delivering', 'done']) assert.ok(statuses.includes(s), `SSE showed ${s}: ${statuses}`);
    assert.ok(statuses.indexOf('planning') < statuses.indexOf('running') && statuses.indexOf('qa') < statuses.indexOf('delivering'));
    const plan = shop.notices().find((n) => /^Plan for J\d+: \d+ tasks, \d+ requirements/.test(n.text));
    assert.ok(plan, 'the plan notice reached the owner');
    assert.equal(plan.level, 'owner');
    assert.match(plan.text, /R1: /);
    const stages = new Set(shop.seen('deliveries', (d) => d.jobId === J).map((d) => d.status));
    for (const s of ['checking', 'review', 'approved', 'loaded', 'shipped']) assert.ok(stages.has(s), `a crate went through ${s}`);
    const fx = shop.sse.filter((e) => e.type === 'fx').map((e) => e.name);
    assert.ok(fx.includes('ship') && fx.includes('confetti'));
    const board = shop.boardEvents();
    assert.ok(board.some((m) => m.kind === 'EVT' && /T\d+ merged/.test(m.body)), 'the merge EVT is on the board');

    // The turns: planning at a desk, work at the bench (write access), reviews in the review clone (read access),
    // QA in _head, and never a turn in _int or in the owner's repo.
    const mine = shop.turns.filter((x) => x.jobId === J);
    const work = path.join(app.paths.work, J);
    assert.ok(mine.some((x) => x.kind === 'plan' && x.cwd === path.join(work, '_desk', '@b1') && x.access === 'read'), 'the plan turn ran at the lead desk');
    for (const x of mine.filter((y) => y.kind === 'work')) {
      assert.equal(x.cwd, benchOf(shop, J, x.taskId));
      assert.equal(x.access, 'write');
    }
    const reviews = mine.filter((x) => x.kind === 'review');
    assert.ok(reviews.length >= tasks.length, 'one review per task at least');
    for (const x of reviews) {
      assert.equal(x.cwd, `${benchOf(shop, J, x.taskId)}.rev`, 'a review runs in the review clone');
      assert.equal(x.access, 'read');
    }
    const qa = mine.find((x) => x.kind === 'qa');
    assert.ok(qa, 'a QA turn ran');
    assert.equal(qa.cwd, path.join(work, '_head'));
    for (const x of mine) {
      assert.notEqual(x.cwd, path.join(work, '_int'));
      assert.ok(!x.cwd.startsWith(project.path), 'no turn in the owner repo');
      assert.equal(x.ok, true, `${x.kind} turn of ${x.handle} ended ok: ${JSON.stringify(x.error)}`);
    }

    // DELETE keeps the title, the brief, the ledger and the report; the rows of tasks, agents and crates go.
    const del = await api('DELETE', `/api/jobs/${J}`);
    assert.equal(del.status, 200);
    const kept = shop.job(J);
    assert.equal(kept.title, created.title);
    assert.equal(kept.brief, BRIEF);
    assert.ok(kept.report);
    assert.equal(kept.requirements.length, job.requirements.length);
    assert.deepEqual([shop.tasks(J).length, shop.agents(J).length, shop.deliveries(J).length], [0, 0, 0]);

    await finish(shop);
  });

  test('POST /api/demo runs the Recipe Box demo with no tokens, to done', T, async (t) => {
    const shop = await bootShop();
    guard(t, shop);
    const r = await shop.api('POST', '/api/demo', {});
    assert.equal(r.status, 200);
    const J = r.body.id;
    assert.equal(r.body.title, 'Demo: Recipe Box web app');
    assert.equal(r.body.options.mock, true);
    const { truck } = await shipAndFinish(shop, J);
    const job = shop.job(J);
    assertAllVerified(job);
    const project = shop.project(J);
    assert.equal(project.name, 'recipe-box-demo');
    assert.equal(git(project.path, 'rev-parse', 'main'), truck.headSha);
    assert.ok(!job.requirements.some((x) => /\[mock/.test(x.text)), 'no hub marker became a requirement');
    const cost = job.cost;
    assert.equal(cost.billedUsd, 0, 'the demo bills nothing');
    await finish(shop);
  });
});

describe('e2e: owner actions on a running mock job', () => {
  test('request changes mid-job: an owner requirement, a lead change turn, a task that cites it, verified at QA', T, async (t) => {
    const shop = await bootShop();
    guard(t, shop);
    const J = (await startJob(shop)).id;
    await shop.waitFor(() => shop.tasks(J).some((x) => x.status === 'merged'), { what: 'a merged task', jobId: J });
    const r = await shop.api('POST', `/api/jobs/${J}/changes`, { text: 'Add a way to export all notes as CSV.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const req = r.body.req;
    assert.match(req.id, /^R\d+$/);
    assert.deepEqual([req.source, req.status], ['owner', 'open']);
    const served = await shop.waitFor(() => shop.tasks(J).find((x) => x.reqs.includes(req.id)), { what: `a task for ${req.id}`, jobId: J });
    const change = shop.turns.find((x) => x.jobId === J && x.kind === 'change');
    assert.ok(change, 'the lead got an owner-change turn');
    assert.match(change.prompt, /THE OWNER ASKS FOR CHANGES/);
    assert.ok(change.prompt.includes(req.id));
    await shipAndFinish(shop, J);
    const job = shop.job(J);
    assertAllVerified(job);
    assert.equal(job.requirements.find((x) => x.id === req.id).status, 'verified');
    assert.equal(shop.task(served.id).status, 'merged');
    await finish(shop);
  });

  test('pause and resume: a soft pause lets turns end and starts none; a hard pause stops them; resume finishes the job', T, async (t) => {
    // Turns of about a second (MOCK_SPEED 0.3), so the hard pause below surely meets a turn in flight.
    const shop = await bootShop({ settings: { mockSpeed: 0.3 } });
    guard(t, shop);
    const { api, app } = shop;
    const J = (await startJob(shop)).id;
    await shop.waitFor(() => shop.tasks(J).some((x) => x.status === 'working'), { what: 'a working task', jobId: J });

    const p = await api('POST', `/api/jobs/${J}/pause`, {});
    assert.equal(p.status, 200);
    assert.deepEqual([p.body.status, p.body.pauseReason, p.body.prevStatus], ['paused', 'owner', 'running']);
    await shop.waitFor(() => app.runner.active().length === 0 && app.runner.queued().length === 0, { what: 'the running turns end', jobId: J });
    const before = shop.turns.length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(shop.turns.length, before, 'no turn starts while the job is paused');
    assert.equal(shop.job(J).status, 'paused');
    const inbox = await api('GET', `/api/inbox?job=${J}`);
    assert.ok(inbox.body.some((i) => i.kind === 'paused'));
    assert.equal((await api('POST', `/api/jobs/${J}/pause`, {})).body.prevStatus, 'running', 'a second pause keeps prevStatus');

    const r1 = await api('POST', `/api/jobs/${J}/resume`, {});
    assert.deepEqual([r1.status, r1.body.status, r1.body.pauseReason], [200, 'running', null]);

    // A hard pause interrupts the turn in flight; its session resumes later.
    await shop.waitFor(() => app.runner.active().length > 0, { what: 'a turn in flight', jobId: J });
    const hard = await api('POST', `/api/jobs/${J}/pause`, { hard: true });
    assert.equal(hard.body.status, 'paused');
    await shop.waitFor(() => app.runner.active().length === 0, { what: 'the hard pause stops the turns', jobId: J, timeoutMs: 20_000 });
    assert.ok(shop.turns.some((x) => x.jobId === J && x.killed === 'interrupt'), 'a turn was interrupted');
    await api('POST', `/api/jobs/${J}/resume`, {});
    await shipAndFinish(shop, J);
    assertAllVerified(shop.job(J));
    await finish(shop);
  });
});
