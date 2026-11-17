// End to end, the board paths the mock flags force (contract sections 7, 12, 12b; section 15): a maker ASK and a
// BLOCK answered by the floor manager, two makers that claim one file, a failed requirement at QA, and an owner
// question with presence away (default at once, then an overturn) and here (the owner answers).
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

const handleOf = (shop, id) => shop.app.store.get('agents', id)?.handle;

describe('e2e: board paths', () => {
  test('[mock:ask] a maker asks its floor manager and waits; the manager answers in a digest turn; the maker goes on', T, async (t) => {
    const shop = await bootShop();
    guard(t, shop);
    const J = (await startJob(shop, { brief: `${BRIEF} [mock:ask]` })).id;
    await shipAndFinish(shop, J);
    assertAllVerified(shop.job(J));
    const msgs = shop.msgs(J);
    const ask = msgs.find((m) => m.kind === 'ASK' && m.role === 'maker');
    assert.ok(ask, 'a maker posted ASK');
    const mgr = shop.agents(J).find((a) => a.role === 'manager');
    assert.equal(ask.toId, mgr.id, 'the ASK went to the floor manager (@mgr)');
    assert.equal(ask.state, 'answered');
    const ans = msgs.find((m) => m.kind === 'ANS' && m.re === ask.id);
    assert.equal(ans?.fromId, mgr.id, 'the manager answered');
    assert.ok(shop.seen('agents', (a) => a.id === ask.fromId && a.status === 'waiting').length > 0, 'the maker waited on its ASK');
    const digest = shop.turns.find((r) => r.agentId === mgr.id && r.kind === 'digest' && r.prompt.includes(`${ask.id}`));
    assert.ok(digest, 'the manager got a digest turn with the ASK');
    assert.match(digest.prompt, /EVENTS IN YOUR STREAM SINCE YOUR LAST TURN:/);
    const resumed = shop.turns.find((r) => r.agentId === ask.fromId && r.kind === 'work' && r.startedAt > ans.ts);
    assert.ok(resumed, 'the closure woke the maker');
    assert.equal(resumed.resume, true);
    assert.ok(resumed.prompt.includes(`re:${ask.id}`), 'the closing line is on top of the wake');
    assert.equal(shop.task(ask.scope).status, 'merged');
    await finish(shop);
  });

  test('[mock:block] BLOCK sets the task blocked (why ask) until the manager answers; then it works again and merges', T, async (t) => {
    const shop = await bootShop();
    guard(t, shop);
    const J = (await startJob(shop, { brief: `${BRIEF} [mock:block]` })).id;
    await shipAndFinish(shop, J);
    assertAllVerified(shop.job(J));
    const msgs = shop.msgs(J);
    const block = msgs.find((m) => m.kind === 'BLOCK');
    assert.ok(block, 'a maker posted BLOCK');
    const X = block.scope;
    assert.ok(shop.seen('tasks', (x) => x.id === X && x.status === 'blocked' && x.why === 'ask').length > 0, `${X} was blocked (why ask)`);
    const ans = msgs.find((m) => m.kind === 'ANS' && m.re === block.id);
    assert.ok(ans, 'the BLOCK got an answer');
    assert.equal(handleOf(shop, ans.fromId), '@f1');
    assert.equal(block.state, 'answered');
    const after = shop.seen('tasks', (x) => x.id === X).map((x) => x.status);
    assert.ok(after.lastIndexOf('working') > after.indexOf('blocked'), `${X} worked again after the answer: ${after}`);
    assert.equal(shop.task(X).blocks, 1);
    assert.equal(shop.task(X).status, 'merged');
    await finish(shop);
  });

  test('[mock:conflict] two makers claim one file: one is granted, one waits (blocked, why claim) until the holder merges', T, async (t) => {
    const shop = await bootShop();
    guard(t, shop);
    const J = (await startJob(shop, { brief: `${BRIEF} [mock:conflict]` })).id;
    await shipAndFinish(shop, J);
    assertAllVerified(shop.job(J));
    const waited = shop.seen('tasks', (x) => x.jobId === J && x.status === 'blocked' && x.why === 'claim');
    assert.ok(waited.length > 0, 'a task waited for a claim');
    const W = waited[0];
    const shared = W.pendingClaims[0];
    assert.match(shared, /^src\/registry\.m?js$/);
    const grant = shop.msgs(J).find((m) => m.kind === 'EVT' && m.scope === W.id && m.toId === W.assigneeId && /claim on .* is granted/.test(m.body));
    assert.ok(grant, 'the hub told the waiting maker that its claim is granted');
    const merges = shop.msgs(J).filter((m) => m.kind === 'EVT' && /T\d+ merged\. Files: .*src\/registry/.test(m.body));
    assert.equal(merges.length, 2, 'both tasks merged a change to the shared file');
    assert.ok(merges.findIndex((m) => m.body.startsWith(`${W.id} merged`)) === 1, 'the waiting task merged second');
    assert.ok(grant.id > merges[0].id, 'the grant came after the holder merged');
    assert.ok(shop.task(W.id).claims.includes(shared), 'the claim is on the task card');
    const project = shop.project(J);
    const text = git(project.path, 'show', `main:${shared}`);
    assert.ok(text.split('\n').filter((l) => l.trim()).length >= 2, `both parts registered:\n${text}`);
    await finish(shop);
  });

  test('[mock:reqfail] QA fails a requirement and adds a task that serves it; round 2 verifies everything', T, async (t) => {
    const shop = await bootShop();
    guard(t, shop);
    const J = (await startJob(shop, { brief: `${BRIEF} [mock:reqfail]` })).id;
    await shipAndFinish(shop, J);
    const job = shop.job(J);
    assertAllVerified(job);
    assert.equal(job.qa.round, 2, 'two QA rounds');
    const failed = shop.seen('jobs', (j) => j.id === J && j.requirements.some((r) => r.status === 'failed'))[0];
    assert.ok(failed, 'a requirement failed in round 1');
    const F = failed.requirements.find((r) => r.status === 'failed').id;
    const statuses = shop.seen('jobs', (j) => j.id === J).map((j) => j.status).filter((s, i, a) => s !== a[i - 1]);
    assert.deepEqual(statuses.slice(statuses.indexOf('qa')), ['qa', 'running', 'qa', 'delivering', 'done']);
    const qaTurns = shop.turns.filter((r) => r.jobId === J && r.kind === 'qa');
    assert.ok(qaTurns.length >= 2, 'a QA turn per round');
    assert.ok(qaTurns[0].calls.some((c) => /task_add/.test(c)), 'the QA agent added a task in the same turn');
    const fixTask = shop.tasks(J).find((x) => x.reqs.includes(F) && x.createdAt > (qaTurns[0].startedAt - 1000));
    assert.ok(fixTask, `a new task serves ${F}`);
    assert.equal(fixTask.status, 'merged');
    await finish(shop);
  });

  test('[mock:human] presence away: the hub takes the default at once; the owner later overturns it', T, async (t) => {
    const shop = await bootShop({ settings: { presence: 'away' } });
    guard(t, shop);
    const J = (await startJob(shop, { brief: `${BRIEF} [mock:human]` })).id;
    const ask = await shop.waitFor(() => shop.msgs(J).find((m) => m.kind === 'ASK' && m.to === '@human'), { what: 'an ASK @human', jobId: J });
    assert.equal(ask.role, 'boss', 'only a boss asks the owner');
    assert.equal(ask.slots.default, 'A');
    const dflt = await shop.waitFor(() => shop.msgs(J).find((m) => m.kind === 'ANS' && m.re === ask.id), { what: 'the default', jobId: J, timeoutMs: 10_000 });
    assert.equal(dflt.from, '@hub');
    assert.match(dflt.body, /^A\. .*Default taken: the owner is away\./);
    const assumption = await shop.waitFor(() => shop.job(J).assumptions.find((a) => a.msgId === ask.id), { what: 'the assumption', jobId: J });
    assert.match(assumption.text, /Default A/);
    const inbox = await shop.api('GET', `/api/inbox?job=${J}`);
    const q = inbox.body.find((i) => i.kind === 'question' && i.msgId === ask.id);
    assert.ok(q, 'the question stays pinned in the inbox');
    assert.deepEqual([q.defaulted, q.default, q.options.map((o) => o.key)], [true, 'A', ['A', 'B']]);

    // Overturn: the owner answers with another option.
    const post = await shop.api('POST', '/api/board', { jobId: J, kind: 'ANS', re: ask.id, body: 'B. Use JSON objects.' });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    assert.equal(post.body.ok, true);
    const over = await shop.waitFor(() => shop.job(J).assumptions.find((a) => a.msgId === ask.id && a.owner), { what: 'the overturned assumption', jobId: J });
    assert.match(over.text, /Owner: B\. Use JSON objects\./);
    const after = await shop.api('GET', `/api/inbox?job=${J}`);
    assert.ok(!after.body.some((i) => i.kind === 'question' && i.msgId === ask.id), 'the answered question is unpinned');
    const woke = await shop.waitFor(() => shop.turns.find((r) => r.agentId === ask.fromId && r.prompt.includes(`overturned the default of ${ask.id}`)), { what: 'the asker woken by the overturn', jobId: J });
    assert.ok(woke);
    await shipAndFinish(shop, J);
    assertAllVerified(shop.job(J));
    await finish(shop);
  });

  test('[mock:human] presence here: the question waits for the owner; the owner answers; no default is taken', T, async (t) => {
    const shop = await bootShop({ settings: { presence: 'here' } });
    guard(t, shop);
    const J = (await startJob(shop, { brief: `${BRIEF} [mock:human]` })).id;
    const ask = await shop.waitFor(() => shop.msgs(J).find((m) => m.kind === 'ASK' && m.to === '@human'), { what: 'an ASK @human', jobId: J });
    const inbox = await shop.api('GET', '/api/inbox');
    const q = inbox.body.find((i) => i.kind === 'question' && i.msgId === ask.id);
    assert.ok(q, 'the question is in the inbox');
    assert.deepEqual([q.defaulted, q.default], [false, 'A']);
    const state = await shop.api('GET', '/api/state');
    assert.ok(state.body.inbox.some((i) => i.msgId === ask.id), 'GET /api/state carries the inbox');
    assert.equal(shop.msgs(J).find((m) => m.id === ask.id).state, 'open', 'no default while the owner is here');

    const post = await shop.api('POST', '/api/board', { jobId: J, kind: 'ANS', re: ask.id, body: 'B. Use JSON objects.' });
    assert.equal(post.body.ok, true, JSON.stringify(post.body));
    assert.equal(post.body.msg.from, '@human');
    await shop.waitFor(() => shop.msgs(J).find((m) => m.id === ask.id)?.state === 'answered', { what: 'the ASK answered', jobId: J });
    const woke = await shop.waitFor(() => shop.turns.find((r) => r.agentId === ask.fromId && r.prompt.includes('B. Use JSON objects.')), { what: 'the asker woken with the answer', jobId: J });
    assert.ok(woke.startedAt >= post.body.msg.ts - 1000);
    await shipAndFinish(shop, J);
    const job = shop.job(J);
    assertAllVerified(job);
    assert.ok(!job.assumptions.some((a) => a.msgId === ask.id), 'no default was taken');
    assert.ok(!shop.msgs(J).some((m) => m.kind === 'ANS' && m.re === ask.id && m.from === '@hub'));
    await finish(shop);
  });
});
