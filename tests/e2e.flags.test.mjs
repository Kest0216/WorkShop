// End to end, the paths the mock flags force (contract section 12, mock agent; section 15): a refused review, a red
// check at hand-in, an out-of-zone file, an empty hand-in and a work turn with no closing act. Each job still ends
// shipped and done with every requirement verified.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BRIEF, assertAllVerified, bootShop, finish, git, shipAndFinish, startJob } from './e2e-harness.mjs';

const T = { timeout: 300_000 };

function guard(t, shop) {
  t.after(async () => {
    await shop.close().catch(() => {});
    if (process.env.KEEP_E2E !== '1') fs.rmSync(shop.dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
  });
}

/** Run one flagged job to done; then check(shop, jobId, ctx) asserts the forced path. */
async function flagged(t, flag, check, { settings } = {}) {
  const shop = await bootShop({ settings });
  guard(t, shop);
  const J = (await startJob(shop, { brief: `${BRIEF} [mock:${flag}]` })).id;
  const { truck } = await shipAndFinish(shop, J);
  const job = shop.job(J);
  assertAllVerified(job);
  assert.ok(!job.requirements.some((r) => /\[mock:/.test(r.text)), 'the flag is not a requirement');
  await check(shop, J, { truck, msgs: shop.msgs(J), project: shop.project(J) });
  await finish(shop);
}

/** The DONE a FIX answers, and the task it is for. */
function fixedDone(msgs, fix) {
  const done = msgs.find((m) => m.id === fix.re);
  assert.equal(done?.kind, 'DONE', 'the FIX answers a DONE');
  assert.equal(done.state, 'fix', 'the FIX closed the DONE');
  return done;
}

/** The task of a refused hand-in went to rework, came back with a second DONE, and was merged and shipped. */
function reworkedAndShipped(shop, J, X, done) {
  assert.ok(shop.seen('tasks', (x) => x.id === X && x.status === 'rework').length > 0, `${X} went to rework`);
  const dones = shop.msgs(J).filter((m) => m.kind === 'DONE' && m.scope === X);
  assert.ok(dones.length >= 2 && dones.at(-1).id > done.id, `${X} handed in again`);
  const ds = shop.deliveries(J).filter((d) => d.taskId === X);
  assert.ok(ds.some((d) => d.status === 'rejected'), `${X} has a refused crate`);
  assert.ok(ds.some((d) => d.status === 'shipped'), `${X} has a shipped crate`);
  assert.equal(shop.task(X).status, 'merged');
}

describe('e2e: mock flags force the paths of section 12', () => {
  test('[mock:reject] the first review is FIX; the maker reworks; the sticky reviewer resumes its session and passes', T, async (t) => {
    await flagged(t, 'reject', async (shop, J, { msgs }) => {
      const fix = msgs.find((m) => m.kind === 'FIX' && m.from !== '@hub');
      assert.ok(fix, 'a reviewer posted FIX');
      assert.match(fix.body, /^1\. .+\n?2\. /m, 'numbered items');
      const done = fixedDone(msgs, fix);
      const X = done.scope;
      reworkedAndShipped(shop, J, X, done);
      const rejected = shop.deliveries(J).find((d) => d.taskId === X && d.status === 'rejected');
      assert.equal(rejected.review?.verdict, 'changes');
      assert.ok(shop.task(X).attempts >= 1 || shop.seen('tasks', (x) => x.id === X && x.attempts >= 1).length, 'the FIX raised attempts');
      const reviews = shop.turns.filter((r) => r.kind === 'review' && r.taskId === X);
      assert.ok(reviews.length >= 2, 'reviewed twice');
      assert.equal(reviews[1].agentId, reviews[0].agentId, 'the same reviewer (sticky)');
      assert.equal(reviews[1].resume, true, 'the re-review resumes the review session');
      assert.equal(reviews[1].sessionId, reviews[0].resultSession);
      assert.equal(reviews[1].cwd, reviews[0].cwd, 'in the same review clone');
      assert.match(reviews[1].prompt, new RegExp(`REVIEW ${X} again by`));
      assert.match(reviews[1].prompt, /Check these items\./);
      const rework = shop.turns.find((r) => r.kind === 'work' && r.taskId === X && r.startedAt >= reviews[0].endedAt);
      assert.ok(rework && rework.access === 'write', 'the maker reworked at its bench');
      assert.ok(msgs.some((m) => m.kind === 'PASS' && m.re === shop.msgs(J).filter((x) => x.kind === 'DONE' && x.scope === X).at(-1).id), 'the second DONE passed');
    });
  });

  test('[mock:checkfail] a red check at hand-in: the hub posts FIX with the CHECK.log pointer; the next hand-in passes', T, async (t) => {
    await flagged(t, 'checkfail', async (shop, J, { msgs }) => {
      const fix = msgs.find((m) => m.kind === 'FIX' && m.from === '@hub' && /Check failed\. See \.shop\/CHECK\.log\./.test(m.body));
      assert.ok(fix, 'the hub refused the hand-in for the check');
      const done = fixedDone(msgs, fix);
      const X = done.scope;
      reworkedAndShipped(shop, J, X, done);
      const rejected = shop.deliveries(J).find((d) => d.taskId === X && d.status === 'rejected');
      assert.equal(rejected.check?.ok, false, 'the refused crate holds the red check');
      assert.ok(!shop.turns.some((r) => r.kind === 'review' && r.taskId === X && r.startedAt < fix.ts), 'no review of a red crate');
    });
  });

  test('[mock:zone] a file outside the zones: the hub posts FIX with the path; it never reaches the target branch', T, async (t) => {
    await flagged(t, 'zone', async (shop, J, { msgs, project }) => {
      const fix = msgs.find((m) => m.kind === 'FIX' && m.from === '@hub' && /outside your zones/.test(m.body));
      assert.ok(fix, 'the hub refused the hand-in for the zone');
      const file = /outside your zones: ([^\s,]+?)\.?(\s|$)/.exec(fix.body)?.[1];
      assert.ok(file, fix.body);
      const done = fixedDone(msgs, fix);
      reworkedAndShipped(shop, J, done.scope, done);
      const onMain = git(project.path, 'ls-tree', '-r', '--name-only', 'main').split('\n');
      assert.ok(!onMain.includes(file), `${file} is not on main`);
    });
  });

  test('[mock:empty] an empty hand-in is refused once with "No changes found in your bench."', T, async (t) => {
    await flagged(t, 'empty', async (shop, J, { msgs }) => {
      const fix = msgs.find((m) => m.kind === 'FIX' && m.from === '@hub' && /No changes found in your bench\./.test(m.body));
      assert.ok(fix, 'the hub refused the empty hand-in');
      const done = fixedDone(msgs, fix);
      reworkedAndShipped(shop, J, done.scope, done);
      const shipped = shop.deliveries(J).find((d) => d.taskId === done.scope && d.status === 'shipped');
      assert.equal(shipped.flags?.empty, false, 'the shipped crate is not empty');
    });
  });

  test('[mock:nodone] a work turn ends with no closing act: the hub resumes the session with the nudge', T, async (t) => {
    await flagged(t, 'nodone', async (shop, J) => {
      const nudge = shop.turns.find((r) => r.kind === 'work' && /You ended your turn without a DONE, BLOCK or FAIL post for (T\d+)/.test(r.prompt));
      assert.ok(nudge, 'a nudge turn ran');
      const X = /post for (T\d+)/.exec(nudge.prompt)[1];
      assert.equal(nudge.taskId, X);
      const before = shop.turns.filter((r) => r.kind === 'work' && r.taskId === X && r.startedAt < nudge.startedAt).at(-1);
      assert.ok(before?.ok, 'the turn before it ended without an error');
      assert.equal(nudge.resume, true, 'the nudge resumes the work session');
      assert.equal(nudge.sessionId, before.resultSession);
      assert.ok(shop.msgs(J).some((m) => m.kind === 'DONE' && m.scope === X && m.ts >= nudge.startedAt), 'the nudged maker handed in');
      assert.equal(shop.task(X).status, 'merged');
      assert.ok(!shop.seen('tasks', (x) => x.id === X && x.status === 'blocked').length, 'one nudge was enough: never blocked');
    });
  });
});
