// Scenario tests: board, review and git edge cases through the whole stack (contract sections 7, 9, 12).
// Each test boots the real hub (createApp, temp folders, the mock lab) and forces one path with scripted turns
// (tests/scenarios/board-review-harness.mjs). Turns that no script takes run the real mock agent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boot, doneLine, git, guard, isPlanTurn, partFiles, partsPlan, pathsInHistory, planScript, shipAndFinish, sleep, startJob, writeFiles } from './board-review-harness.mjs';

const T = { timeout: 240_000 };

describe('scenarios: review', () => {
  test('smoke: a scripted plan, real mock makers and reviewers, shipped and done', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan()));
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.deepEqual(shop.tasks(J).map((x) => x.status), ['merged', 'merged']);
    assert.ok(shop.job(J).requirements.every((r) => r.status === 'verified'));
  });

  test('a reviewer that never answers: nudge, the second reviewer, its nudge, then the owner gives PASS', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    shop.script('silent review', (r) => r.kind === 'review', async () => {});
    const J = await startJob(shop, { crew: { bosses: 2, managers: 0, makers: 2 } });
    const d = await shop.waitFor(() => shop.deliveries(J).find((x) => x.waitHuman), { what: 'the delivery waits for the owner', jobId: J });
    const reviews = shop.turns.filter((r) => r.kind === 'review');
    assert.equal(reviews.length, 4, `two reviewers, each with one nudge: ${reviews.map((r) => r.handle).join(' ')}`);
    assert.deepEqual(reviews.map((r) => r.handle), [reviews[0].handle, reviews[0].handle, reviews[2].handle, reviews[2].handle]);
    assert.notEqual(reviews[0].agentId, reviews[2].agentId, 'the second reviewer is another boss');
    for (const i of [1, 3]) {
      assert.match(reviews[i].prompt, new RegExp(`You ended your turn without a verdict\\. Post PASS re:${d.doneMsgId}`));
      assert.equal(reviews[i].resume, true, 'the nudge resumes the review session');
    }
    assert.equal(d.reviewers.length, 2, 'at most limits.maxReviewers');
    // The notice comes on the SSE stream, which lags the store a little on a busy machine: wait for it.
    await shop.waitFor(() => shop.notices().some((n) => n.level === 'owner' && n.text.includes(`PASS re:${d.doneMsgId}`)), { what: 'an owner notice that asks for the verdict', jobId: J, timeoutMs: 15_000 });
    const inbox = await shop.api('GET', `/api/inbox?job=${J}`);
    assert.ok(inbox.body.some((i) => i.kind === 'review'), `the inbox holds a review item: ${JSON.stringify(inbox.body)}`);
    assert.equal(shop.task(d.taskId).status, 'review');
    // The stall rule must not pause a job that waits for the owner's verdict.
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(shop.job(J).status, 'running');
    const pass = await shop.api('POST', '/api/board', { jobId: J, kind: 'PASS', re: d.doneMsgId, body: 'The change meets the acceptance items.' });
    assert.equal(pass.body.ok, true, JSON.stringify(pass.body));
    await shop.waitFor(() => shop.task(d.taskId).status === 'merged', { what: 'merged after the owner PASS', jobId: J });
    assert.equal(shop.turns.filter((r) => r.kind === 'review').length, 4, 'no third reviewer');
    assert.equal(shop.deliveries(J).find((x) => x.id === d.id).review.by, '@human');
    await shipAndFinish(shop, J);
  });

  test('a buddy FIX sends the task back once; the next hand-in goes straight to the boss, who passes it', T, async (t) => {
    const shop = await boot({
      // The mock lab is one lab: this patch lets a second mock maker stand in for the maker of the other lab.
      wrapOrch: (orch, ctx) => {
        ctx.crew.buddyFor = (job, task, maker) => ctx.agentsOf(job.id, (a) => a.role === 'maker' && a.id !== maker.id && a.buddyOnly)[0]
          ?? ctx.crew.newAgent(job, 'maker', { provider: 'mock', model: 'mock-maker', label: 'Mock maker', effort: 'low' }, { buddyOnly: true });
      },
    });
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'], { size: 'M' })));
    shop.script('buddy fix', (r) => r.kind === 'buddy', async ({ post, o }) => {
      const id = /Their DONE is message (\d+)\./.exec(o.prompt)[1];
      const r = await post(`FIX re:${id}:\n1. Add a test for empty input in test/alpha.test.mjs:1`);
      assert.match(r.text, /^ok \d+/, r.text);
    });
    const J = await startJob(shop);
    const X = await shop.waitFor(() => shop.tasks(J).find((x) => x.pair)?.id, { what: 'a pair task', jobId: J });
    await shipAndFinish(shop, J);
    const buddies = shop.turns.filter((r) => r.kind === 'buddy');
    assert.equal(buddies.length, 1, 'one buddy check per task');
    assert.equal(buddies[0].access, 'read');
    assert.match(buddies[0].cwd, /\.rev$/, 'the buddy works in the review clone');
    const [d1, d2] = shop.deliveries(J, X);
    assert.equal(d1.buddy?.verdict, 'changes');
    assert.equal(d1.review, null, 'the buddy FIX is not the review verdict');
    assert.equal(d2.buddy, null);
    assert.equal(d2.review?.verdict, 'pass');
    assert.equal(shop.agent(d2.reviewerId).role, 'boss');
    assert.ok(shop.seen('tasks', (x) => x.id === X && x.status === 'rework' && x.attempts === 1).length, 'the buddy FIX raised attempts');
    const dones = shop.msgs(J).filter((m) => m.kind === 'DONE' && m.scope === X);
    assert.equal(dones.length, 2);
    assert.ok(dones.every((m) => m.state !== 'open'), `no DONE stays open: ${dones.map((m) => m.state)}`);
  });

  test('FIX three times: the task fails at limits.maxReworks; the lead retries it; then it passes', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    const fixes = [];
    shop.script('fix review', (r) => r.kind === 'review', async ({ post, o }) => {
      const id = /Their DONE is message (\d+)\./.exec(o.prompt)[1];
      const r = await post(`FIX re:${id}:\n1. Add a test for empty input in test/alpha.test.mjs:1`);
      fixes.push(r.text);
    }, { times: 3 });
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.equal(fixes.length, 3);
    for (const f of fixes) assert.match(f, /^ok \d+/, `the same FIX text is never refused as a duplicate: ${f}`);
    const failed = shop.seen('tasks', (x) => x.status === 'failed');
    assert.ok(failed.length, 'the task failed');
    assert.equal(failed[0].attempts, 3);
    const X = failed[0].id;
    assert.equal(shop.task(X).retries, 1, 'the lead retried it');
    assert.equal(shop.task(X).status, 'merged');
    const lastFix = shop.turns.filter((r) => r.kind === 'review').at(2);
    assert.ok(!shop.turns.some((r) => r.kind === 'work' && r.taskId === X && r.startedAt > lastFix.endedAt && !/RETRY of/.test(r.prompt) && r.startedAt < shop.turns.find((x) => /RETRY of/.test(x.prompt))?.startedAt), 'no rework turn after the third FIX');
  });

  test('QA evidence that points at a file name with two dots (test/alpha.test.mjs:1) is accepted', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    let answer = null;
    shop.steps('qa', (r) => r.kind === 'qa', [async ({ call }) => {
      answer = (await call('req_verify', { results: [{ id: 'R1', ok: true, evidence: 'test/alpha.test.mjs:1 proves R1, and the check passes.' }] })).text;
    }]);
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    // Before the fix POINTER_RE cut the name at the first dot (test/alpha.test), req_verify refused every such
    // pointer, and after the QA retry the job paused (error).
    assert.match(answer, /^ok/, answer);
    assert.equal(shop.job(J).requirements[0].evidence, 'test/alpha.test.mjs:1 proves R1, and the check passes.');
  });

  test('acc= lower than the card: PASS is refused with E_ACC, the reviewer posts FIX, the next hand-in passes', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    shop.script('short acc', (r) => r.kind === 'work' && /Start now\. Hand in with/.test(r.prompt), async ({ post, cwd, o }) => {
      writeFiles(cwd, partFiles('alpha'));
      // The card has 2 items. The maker counts 1 of 1: met < card count.
      const r = await post(doneLine(o.taskId, { acc: '1/1' }));
      assert.match(r.text, /^ok \d+/, r.text);
    }, { times: 1 });
    let passAnswer = null;
    let reviewPrompt = null;
    shop.script('pass first', (r) => r.kind === 'review', async ({ post, o }) => {
      reviewPrompt = o.prompt;
      const id = /Their DONE is message (\d+)\./.exec(o.prompt)[1];
      passAnswer = (await post(`PASS re:${id}: The change meets the acceptance items.`)).text;
      const r = await post(`FIX re:${id}:\n1. Meet acceptance item 2 of the card, see .shop/TASK.md:3`);
      assert.match(r.text, /^ok \d+/, r.text);
    }, { times: 1 });
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.match(passAnswer, /^ERR E_ACC/, passAnswer);
    assert.match(reviewPrompt, /The task card has 2 items\. Not all are met, so PASS is refused: post FIX\./);
    const [d1, d2] = shop.deliveries(J);
    assert.deepEqual(d1.acc, { met: 1, total: 1 });
    assert.equal(d1.review.verdict, 'changes');
    assert.equal(d2.review.verdict, 'pass');
  });
});

const id = (text) => Number((/^ok (\d+)/.exec(text) ?? [])[1]) || null;
const doneIdOf = (prompt) => Number(/Their DONE is message (\d+)\./.exec(prompt)[1]);

describe('scenarios: the hand-in pipeline', () => {
  test('a maker posts DONE then BLOCK in one turn: the freeze refuses BLOCK and ASK (E_CLOSED); a second DONE is idempotent', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    const said = {};
    shop.script('done then block', shop.work('alpha', /Start now/), async ({ post, cwd, o }) => {
      writeFiles(cwd, partFiles('alpha'));
      said.done = (await post(doneLine(o.taskId))).text;
      said.again = (await post(doneLine(o.taskId))).text;
      said.block = (await post(`BLOCK ${o.taskId} why=unclear: I need the output format. The task card does not name it.`)).text;
      said.ask = (await post(`ASK @mgr ${o.taskId}: Should run return an empty list for no input?`)).text;
    }, { times: 1 });
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.match(said.done, /^ok \d+/);
    assert.equal(id(said.again), id(said.done), `the second DONE answers with the first id: ${said.again}`);
    assert.match(said.block, /^ERR E_CLOSED/, said.block);
    assert.match(said.ask, /^ERR E_CLOSED/, said.ask);
    const X = shop.taskOf(J, 'alpha').id;
    assert.ok(!shop.seen('tasks', (x) => x.id === X && ['blocked', 'failed'].includes(x.status)).length, 'the task was never blocked or failed');
    assert.equal(shop.task(X).blocks, 0);
    assert.equal(shop.msgs(J).filter((m) => m.kind === 'DONE').length, 1, 'one DONE stored');
  });

  test('a maker posts DONE then FAIL in one turn: the hand-in ends, the task fails, the lead retries it, it merges', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    let fail = null;
    shop.script('done then fail', shop.work('alpha', /Start now/), async ({ post, cwd, o }) => {
      writeFiles(cwd, partFiles('alpha'));
      await post(doneLine(o.taskId));
      fail = (await post(`FAIL ${o.taskId} why=unclear: I cannot finish the task.`)).text;
    }, { times: 1 });
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    // The FAIL closed the DONE on the board. Before the fix the hub kept the task in review: the reviewer's PASS
    // was refused (E_CLOSED), nobody else could review, and the job hung in running for ever.
    assert.match(fail, /^ok \d+/, fail);
    const X = shop.taskOf(J, 'alpha').id;
    const [d1] = shop.deliveries(J, X);
    assert.equal(d1.status, 'rejected');
    assert.equal(d1.review, null, 'nobody reviewed the given-up hand-in');
    assert.ok(shop.seen('tasks', (x) => x.id === X && x.status === 'failed').length, 'the FAIL failed the task');
    assert.equal(shop.task(X).retries, 1, 'the lead retried it');
  });

  test('guard: node_modules, then a stored key value, are refused; refused content never reaches any branch', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const key = 'sk-ant-api03-scenario-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const k = await shop.api('PUT', '/api/keys/anthropic', { value: key });
    assert.equal(k.status, 200, JSON.stringify(k.body));
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    const answers = [];
    shop.steps('alpha', shop.work('alpha'), [
      async ({ post, cwd, o }) => {
        writeFiles(cwd, { ...partFiles('alpha'), 'node_modules/left-pad/index.js': 'module.exports = 1;\n' });
        answers.push((await post(doneLine(o.taskId))).text);
      },
      async ({ post, cwd, o }) => {
        writeFiles(cwd, { 'node_modules/left-pad/index.js': null, 'src/alpha/config.mjs': `export const token = '${key}';\n` });
        answers.push((await post(doneLine(o.taskId, { body: 'Removed node_modules. Added the config module.' }))).text);
      },
      async ({ post, cwd, o }) => {
        writeFiles(cwd, { 'src/alpha/config.mjs': null });
        answers.push((await post(doneLine(o.taskId, { body: 'Removed the config module. The part has no secrets now.' }))).text);
      },
    ]);
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.equal(answers.length, 3, 'three hand-ins');
    const fixes = shop.msgs(J).filter((m) => m.kind === 'FIX' && m.from === '@hub');
    assert.equal(fixes.length, 2, fixes.map((m) => m.body).join(' | '));
    assert.match(fixes[0].body, /node_modules/);
    assert.ok(!fixes[1].body.includes(key), 'the FIX does not quote the key');
    const X = shop.taskOf(J, 'alpha').id;
    assert.ok(shop.seen('tasks', (x) => x.id === X && x.attempts === 2).length, 'each guard refusal raised attempts');
    const repo = shop.project(J).path;
    const seen = pathsInHistory(repo, 'main');
    assert.ok(![...seen].some((p) => p.startsWith('node_modules/')), `no node_modules in the history of main: ${[...seen]}`);
    assert.ok(!seen.has('src/alpha/config.mjs'), 'the secret file is in no commit of main');
    const all = git(repo, 'log', '--all', '-p');
    assert.ok(!all.includes(key), 'the key value is in no commit of any ref of the canonical repo');
    const crate = shop.deliveries(J, X).at(-1);
    assert.equal(crate.status, 'shipped');
    assert.deepEqual(crate.files.map((f) => f.path).sort(), ['src/alpha/index.mjs', 'test/alpha.test.mjs']);
  });

  test('guard: a file over limits.maxFileMb is refused; after its removal the crate is clean', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    shop.steps('alpha', shop.work('alpha'), [
      async ({ post, cwd, o }) => {
        writeFiles(cwd, { ...partFiles('alpha'), 'src/alpha/data.txt': 'x'.repeat(1_600_000) });
        await post(doneLine(o.taskId));
      },
      async ({ post, cwd, o }) => {
        writeFiles(cwd, { 'src/alpha/data.txt': null });
        await post(doneLine(o.taskId, { body: 'Removed the large data file.' }));
      },
    ]);
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    const fix = shop.msgs(J).find((m) => m.kind === 'FIX' && m.from === '@hub');
    assert.match(fix.body, /data\.txt/, fix.body);
    assert.ok(!pathsInHistory(shop.project(J).path, 'main').has('src/alpha/data.txt'));
  });

  test('an empty hand-in twice: refused once, then reviewed with FLAG empty; the reviewer sends it back', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    const answers = [];
    const empty = async ({ post, o }) => { answers.push((await post(doneLine(o.taskId, { tests: 'none', body: 'I changed no files.' }))).text); };
    shop.steps('alpha', shop.work('alpha'), [empty, empty]);
    const J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.match(answers[0], /^ok \d+/);
    assert.match(answers[1], /^ok \d+/, `the same DONE text after a refusal is not a duplicate: ${answers[1]}`);
    assert.notEqual(id(answers[1]), id(answers[0]));
    const X = shop.taskOf(J, 'alpha').id;
    const [d1, d2, d3] = shop.deliveries(J, X);
    assert.equal(d1.status, 'rejected');
    assert.match(shop.msgs(J).find((m) => m.kind === 'FIX' && m.re === d1.doneMsgId).body, /No changes found in your bench\./);
    assert.equal(d2.flags.empty, true, 'the second empty hand-in went to review flagged');
    const review = shop.turns.find((r) => r.kind === 'review' && r.taskId === X);
    assert.match(review.prompt, /^FLAG empty: the maker changed no files\./m);
    assert.equal(d2.review.verdict, 'changes');
    assert.equal(d3.status, 'shipped');
    assert.equal(d3.flags.empty, false);
  });

  test('the circuit breaker: three tasks in a row refused for the same cause (zone) pause the job; resume finishes it', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha', 'beta', 'gamma'])));
    let J = null;
    const paused = () => shop.seen('jobs', (j) => j.id === J && j.pauseReason === 'caps').length > 0;
    const written = new Set();
    for (const n of ['alpha', 'beta', 'gamma']) {
      shop.steps(n, shop.work(n), [
        async ({ post, cwd, o, until }) => {
          writeFiles(cwd, { ...partFiles(n), [`scratch/${n}.txt`]: 'notes\n' });
          written.add(n);
          await until(() => written.size === 3, { what: 'all three makers wrote' });
          await post(doneLine(o.taskId));
        },
        async ({ post, cwd, o, until }) => {
          await until(paused, { what: 'the caps pause' });
          writeFiles(cwd, { [`scratch/${n}.txt`]: null });
          await post(doneLine(o.taskId, { body: 'Removed the scratch file outside my zones.' }));
        },
      ]);
    }
    J = await startJob(shop, { crew: { bosses: 1, managers: 0, makers: 3 } });
    await shop.waitFor(() => shop.job(J).status === 'paused', { what: 'the job pauses', jobId: J });
    assert.equal(shop.job(J).pauseReason, 'caps');
    assert.match(shop.job(J).error, /same cause \(zone\)/);
    await shop.waitFor(() => shop.notices().some((n) => n.level === 'owner' && /paused \(caps\)/.test(n.text)), { what: 'the owner notice', jobId: J });
    const r = await shop.api('POST', `/api/jobs/${J}/resume`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await shipAndFinish(shop, J);
    // The zone-refused file is not in the shipped tree, and not in the history of main either: a zone refusal
    // marks the bench tainted, so the next accepted hand-in is squashed into one commit on the fork point.
    const repo = shop.project(J).path;
    const tree = git(repo, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    for (const n of ['alpha', 'beta', 'gamma']) assert.ok(!tree.includes(`scratch/${n}.txt`), `scratch/${n}.txt is not shipped`);
    const touched = git(repo, 'log', '--format=', '--name-only', 'main').split('\n').filter(Boolean);
    for (const n of ['alpha', 'beta', 'gamma']) assert.ok(!touched.includes(`scratch/${n}.txt`), `scratch/${n}.txt is in no commit of main`);
    // The squash keeps the hub's commit subject (task id and title), and the review got the whole change.
    for (const task of shop.tasks(J)) {
      const d = shop.deliveries(J).find((x) => x.taskId === task.id && x.status === 'shipped');
      if (!d?.squashed) continue;
      const subject = git(repo, 'log', '-1', '--format=%s', d.headSha);
      assert.ok(subject.startsWith(`${task.id}: `), `the squashed commit of ${task.id} keeps its subject (${subject})`);
      assert.ok(d.files.some((f) => f.path.startsWith('src/')), `the review of ${task.id} saw the files`);
      assert.ok(!d.files.some((f) => f.path.startsWith('scratch/')), `the review of ${task.id} saw no refused file`);
    }
    assert.ok(shop.deliveries(J).some((d) => d.squashed), 'a hand-in after a zone refusal was squashed');
  });
});

const SHARED = 'src/shared.mjs';
const lonely = (other) => `import fs from 'node:fs';\ntest('only one part exists', () => { assert.equal(fs.existsSync(new URL('../src/${other}/index.mjs', import.meta.url)), false); });\n`;
const nodeTest = (cwd) => {
  try { execFileSync(process.execPath, ['--test'], { cwd, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: cwd } }); return true; } catch { return false; }
};

describe('scenarios: git', () => {
  test('claim on a held path: WAIT, granted after the holder merges; the dirty waiting bench conflicts at sync; resolved; both land', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha', 'beta'])));
    let J = null;
    const said = {};
    shop.steps('alpha', shop.work('alpha'), [async ({ call, post, cwd, o }) => {
      said.alphaClaim = (await call('claim', { paths: [SHARED] })).text;
      writeFiles(cwd, { ...partFiles('alpha'), [SHARED]: "export const parts = ['alpha'];\n" });
      await post(doneLine(o.taskId));
    }]);
    shop.steps('beta', shop.work('beta'), [
      async ({ call, cwd, until }) => {
        await until(() => shop.taskOf(J, 'alpha')?.claims.includes(SHARED), { what: 'the alpha claim' });
        writeFiles(cwd, { ...partFiles('beta'), [SHARED]: "export const parts = ['beta'];\n" }); // written before the claim: a dirty bench
        said.betaClaim = (await call('claim', { paths: [SHARED] })).text;
      },
      async ({ post, o }) => { said.grantPrompt = o.prompt; await post(doneLine(o.taskId)); },
      // the third turn (the conflict FIX) is the real mock maker: it resolves the markers and hands in
    ]);
    J = await startJob(shop);
    await shipAndFinish(shop, J);
    const A = shop.taskOf(J, 'alpha');
    const B = shop.taskOf(J, 'beta');
    assert.equal(said.alphaClaim, 'ok', said.alphaClaim);
    assert.match(said.betaClaim, new RegExp(`^WAIT ${A.id} holds ${SHARED}`), said.betaClaim);
    assert.ok(shop.seen('tasks', (x) => x.id === B.id && x.status === 'blocked' && x.why === 'claim').length, 'beta waited (blocked, why claim)');
    const merged = shop.msgs(J).find((m) => m.kind === 'EVT' && m.body.startsWith(`${A.id} merged`));
    const grant = shop.msgs(J).find((m) => m.kind === 'EVT' && m.toId === B.assigneeId && /claim on .* is granted/.test(m.body));
    assert.ok(grant && grant.id > merged.id, 'granted after the holder merged');
    const fix = shop.msgs(J).find((m) => m.kind === 'FIX' && m.from === '@hub' && m.scope === B.id);
    assert.match(fix?.body ?? '', /Merge conflict with the integration branch in: src\/shared\.mjs/, fix?.body);
    assert.ok(shop.seen('tasks', (x) => x.id === B.id && x.status === 'rework' && x.attempts === 0).length, 'a conflict found by the hub raises no attempt');
    const text = git(shop.project(J).path, 'show', `main:${SHARED}`);
    assert.match(text, /alpha/);
    assert.match(text, /beta/);
    assert.doesNotMatch(text, /^(<<<<<<<|=======|>>>>>>>)/m, 'no conflict markers shipped');
    assert.ok(shop.deliveries(J, B.id).at(-1).flags.claimed.includes(SHARED), 'the crate flags the claimed path');
  });

  test('a check that fails only after the sync with a merged task: refused at hand-in with the CHECK.log pointer', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha', 'beta'])));
    let J = null;
    let alone = null;
    shop.steps('beta', shop.work('beta'), [
      async ({ post, cwd, o, until }) => {
        writeFiles(cwd, partFiles('beta', { extraTest: lonely('alpha') }));
        alone = nodeTest(cwd);
        await until(() => shop.taskOf(J, 'alpha')?.status === 'merged', { what: 'alpha merged' });
        await post(doneLine(o.taskId, { tests: '3/3' }));
      },
      async ({ post, cwd, o }) => {
        writeFiles(cwd, partFiles('beta'));
        await post(doneLine(o.taskId, { body: 'Removed the test that broke with the alpha part.' }));
      },
    ]);
    J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.equal(alone, true, 'the check passes in the bench before the sync');
    const B = shop.taskOf(J, 'beta');
    const [d1] = shop.deliveries(J, B.id);
    assert.equal(d1.check?.ok, false, 'the check failed after the sync');
    assert.match(d1.check.tail, /only one part exists/);
    const fix = shop.msgs(J).find((m) => m.kind === 'FIX' && m.re === d1.doneMsgId);
    assert.match(fix.body, /Check failed\. See \.shop\/CHECK\.log\./);
    assert.ok(shop.seen('tasks', (x) => x.id === B.id && x.attempts === 1).length);
  });

  test('a check that fails at integrate after another task merged: stale, synced again, red, back to rework, re-reviewed', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha', 'beta'])));
    let J = null;
    shop.steps('alpha review', shop.review('alpha'), [async ({ post, o, until }) => {
      await until(() => ['review', 'integrating'].includes(shop.taskOf(J, 'beta')?.status), { what: 'beta in review' });
      await post(`PASS re:${doneIdOf(o.prompt)}: The change meets the acceptance items.`);
    }]);
    shop.steps('beta', shop.work('beta'), [
      async ({ post, cwd, o }) => { writeFiles(cwd, partFiles('beta', { extraTest: lonely('alpha') })); await post(doneLine(o.taskId, { tests: '3/3' })); },
      async ({ post, cwd, o }) => { writeFiles(cwd, partFiles('beta')); await post(doneLine(o.taskId, { body: 'Removed the test that broke with the alpha part.' })); },
    ]);
    shop.steps('beta review', shop.review('beta'), [async ({ post, o, until }) => {
      await until(() => shop.taskOf(J, 'alpha')?.status === 'merged', { what: 'alpha merged' });
      await post(`PASS re:${doneIdOf(o.prompt)}: The change meets the acceptance items.`);
    }]);
    J = await startJob(shop, { crew: { bosses: 2, managers: 0, makers: 2 } }); // two reviewers: one review per agent at a time
    await shipAndFinish(shop, J);
    const B = shop.taskOf(J, 'beta');
    const [d1, d2] = shop.deliveries(J, B.id);
    assert.equal(d1.review?.verdict, 'pass', 'the first crate was approved');
    assert.equal(d1.status, 'rejected');
    assert.match(d1.rejectReason ?? '', /check failed on the merge with the integration branch/i);
    assert.ok(shop.seen('tasks', (x) => x.id === B.id && x.status === 'rework' && x.attempts === 1).length, 'a red check at integrate raises attempts');
    assert.ok(shop.msgs(J).some((m) => m.kind === 'EVT' && m.toId === B.assigneeId && /could not merge/.test(m.body)), 'the maker is told');
    const reviews = shop.turns.filter((r) => r.kind === 'review' && r.taskId === B.id);
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].agentId, reviews[0].agentId, 'the sticky reviewer');
    assert.match(reviews[1].prompt, new RegExp(`REVIEW ${B.id} again by`));
    assert.ok(reviews[1].prompt.includes(`git diff ${d1.headSha} ${d2.headSha}`), 'the re-review sees the diff since the last reviewed head');
    assert.equal(d2.status, 'shipped');
  });

  test('tripwire: a commit on the integration branch outside the hub pauses the job (tampered) at integrate and at ship', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    const tamper = (J, msg) => git(shop.job(J).integrationDir, '-c', 'user.name=Intruder', '-c', 'user.email=x@example.com', 'commit', '-q', '--allow-empty', '-m', msg);
    let J = null;
    shop.steps('tamper then pass', shop.review('alpha'), [async ({ post, o }) => {
      tamper(J, 'not from the hub');
      await post(`PASS re:${doneIdOf(o.prompt)}: The change meets the acceptance items.`);
    }]);
    J = await startJob(shop);
    await shop.waitFor(() => shop.job(J).status === 'paused', { what: 'the tripwire pause', jobId: J });
    assert.equal(shop.job(J).pauseReason, 'tampered');
    const A = shop.taskOf(J, 'alpha');
    assert.equal(A.status, 'integrating', 'nothing was merged');
    assert.equal(shop.deliveries(J, A.id)[0].status, 'approved');
    await shop.waitFor(() => shop.notices().some((n) => n.level === 'owner' && /tampered/.test(n.text)), { what: 'the owner notice', jobId: J });
    // The owner looked and resumes: the hub takes the branch as it is now.
    assert.equal((await shop.api('POST', `/api/jobs/${J}/resume`, {})).status, 200);
    await shop.waitFor(() => { const j = shop.job(J); return j.status === 'delivering' && j.report; }, { what: 'delivering', jobId: J });
    tamper(J, 'again not from the hub');
    const truck = await shop.api('GET', `/api/jobs/${J}/truck`);
    const ship = await shop.api('POST', `/api/jobs/${J}/ship`, { sha: truck.body.headSha });
    assert.notEqual(ship.body.ok, true, `ship refused: ${JSON.stringify(ship.body)}`);
    await shop.waitFor(() => shop.job(J).pauseReason === 'tampered', { what: 'the ship tripwire', jobId: J });
    assert.equal(git(shop.project(J).path, 'rev-list', '--count', 'main'), '1', 'the target branch did not move');
  });

  test('a red baseline on an adopted repo: the lead resubmits once with the tail; red again: paused (baseline)', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const repo = path.join(shop.dirs.tmp, 'adopted');
    writeFiles(repo, {
      'package.json': '{ "name": "adopted", "type": "module", "scripts": { "test": "node --test" } }\n',
      'test/old.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the old red test', () => { assert.equal(1, 2); });\n",
    });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=Owner', '-c', 'user.email=o@example.com', 'commit', '-q', '-m', 'start');
    const plan = partsPlan(['alpha']);
    shop.script('plan', isPlanTurn, planScript(plan));
    let resubmit = null;
    shop.script('resubmit', (r) => r.kind === 'plan' && /^CHECK FAILED for work order/m.test(r.prompt), async (c) => { resubmit = c.o.prompt; await planScript(plan)(c); });
    const J = await startJob(shop, { project: { mode: 'existing', path: repo, agentFilesAck: true } });
    await shop.waitFor(() => shop.job(J).status === 'paused', { what: 'the baseline pause', jobId: J });
    const job = shop.job(J);
    assert.equal(job.pauseReason, 'baseline');
    assert.match(job.error, /the old red test|fails/i);
    assert.ok(resubmit, 'the lead was resumed once to submit again');
    assert.match(resubmit, /Your plan is not applied yet/);
    assert.match(resubmit, /the old red test/, 'the resubmit prompt carries the tail');
    assert.equal(shop.tasks(J).length, 0, 'the plan was never applied');
    assert.equal(shop.project(J).baseline?.ok, false);
    const inbox = await shop.api('GET', `/api/inbox?job=${J}`);
    assert.ok(inbox.body.some((i) => i.kind === 'paused'), JSON.stringify(inbox.body));
    assert.equal(git(repo, 'rev-list', '--count', 'main'), '1', 'the owner repo is untouched');
  });
});

/** Move shop time forward in steps under the 60 s sleep gap, so deadlines run (not shifted). */
async function runClock(shop, untilFn, { stepMs = 45_000, maxSteps = 200 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (untilFn()) return true;
    shop.clock.offset += stepMs;
    await sleep(160);
  }
  return untilFn();
}
const lastTo = (shop, J, agentId, kind) => shop.msgs(J).filter((m) => m.kind === kind && m.toId === agentId).at(-1);

describe('scenarios: board', () => {
  test('thread limits never refuse the posts the state machine needs: the 6th post (ANS) passes, the 7th (ASK) locks the thread', T, async (t) => {
    const shop = await boot({ settings: { board: { gapMs: 0 } } });
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    let J = null;
    const said = [];
    // Distinct questions: a near-duplicate ASK is refused (E_DUP), and that is right.
    const questions = { 2: 'Must run keep empty strings in the items list?', 3: 'Does count include values that are null?', 4: 'Should the part name be upper case in the output?' };
    const followUp = (n) => async ({ post, o, agent }) => {
      const ans = lastTo(shop, J, agent.id, 'ANS');
      said.push((await post(`ASK @mgr re:${ans.id} ${o.taskId}: ${questions[n]}`)).text);
    };
    shop.steps('alpha', shop.work('alpha'), [
      async ({ post, o }) => { said.push((await post(`ASK @mgr ${o.taskId}: Should run return an empty list for no input?`)).text); },
      followUp(2), followUp(3),
      async (c) => {
        await followUp(4)(c);
        writeFiles(c.cwd, partFiles('alpha'));
        said.push((await c.post(doneLine(c.o.taskId))).text);
      },
    ]);
    J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.equal(said.length, 5, said.join(' | '));
    for (const s of said.slice(0, 3)) assert.match(s, /^ok \d+/, s);
    assert.match(said[3], /^ERR E_LOOP/, `the 7th post of the thread is refused: ${said[3]}`);
    assert.match(said[4], /^ok \d+/, `DONE is never refused by the loop limit: ${said[4]}`);
    const ask1 = shop.msgs(J).find((m) => m.kind === 'ASK' && m.role === 'maker');
    const thread = shop.msgs(J).filter((m) => m.thread === ask1.thread && ['ASK', 'ANS'].includes(m.kind));
    assert.deepEqual(thread.map((m) => m.kind), ['ASK', 'ANS', 'ASK', 'ANS', 'ASK', 'ANS'], 'the boss answered the 3rd ASK as the 6th post');
    assert.ok(thread.filter((m) => m.kind === 'ANS').every((m) => m.role === 'boss'), 'identical ANS bodies are never refused as duplicates');
    assert.ok(thread.every((m) => m.state !== 'open'), 'nothing is left open in the thread');
    assert.ok(shop.msgs(J).some((m) => m.kind === 'EVT' && m.re === ask1.id && /loop limit/.test(m.body)), 'the hub tells the supervisor that the thread is locked');
  });

  test('a frozen maker woken by a peer question answers with read access and "Your work is in review. Answer only."', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha', 'beta'])));
    let J = null;
    let bench = null;
    let dirty = null;
    const frozenEnded = () => shop.turns.find((r) => r.kind === 'work' && r.taskId === shop.taskOf(J, 'alpha')?.id && r.access === 'read' && r.endedAt);
    shop.steps('alpha', shop.work('alpha', /Start now/), [async ({ post, cwd, o }) => { bench = cwd; writeFiles(cwd, partFiles('alpha')); await post(doneLine(o.taskId)); }]);
    shop.steps('alpha review', shop.review('alpha'), [async ({ post, o, until }) => {
      await until(frozenEnded, { what: 'the frozen wake of the alpha maker' });
      dirty = git(bench, 'status', '--porcelain', '--untracked-files=no');
      await post(`PASS re:${doneIdOf(o.prompt)}: The change meets the acceptance items.`);
    }]);
    let ask = null;
    shop.steps('beta', shop.work('beta', /Start now/), [async ({ post, until }) => {
      const A = await until(() => { const x = shop.taskOf(J, 'alpha'); return x?.status === 'review' && x; }, { what: 'alpha in review' });
      ask = (await post(`ASK ${shop.agent(A.assigneeId).handle} #build: Does your run function return the count of the items?`)).text;
    }]);
    J = await startJob(shop);
    await shipAndFinish(shop, J);
    assert.match(ask, /^ok \d+/, ask);
    const wake = frozenEnded();
    assert.equal(wake.access, 'read', 'the frozen bench is read-only');
    assert.match(wake.prompt, /^Your work is in review\. Answer only\./);
    const askId = Number(/^ok (\d+)/.exec(ask)[1]);
    const ans = shop.msgs(J).find((m) => m.kind === 'ANS' && m.re === askId);
    assert.equal(ans?.fromId, shop.taskOf(J, 'alpha').assigneeId, 'the frozen maker answered');
    assert.equal(dirty, '', 'the bench under review stayed clean');
    assert.equal(shop.deliveries(J, shop.taskOf(J, 'alpha').id).length, 1, 'one crate: the wake made no new hand-in');
  });

  test('a claim wait cycle goes to the manager (the lead boss); it changes a zone; both claims are granted in turn', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    const plan = partsPlan(['alpha', 'beta'], { zones: { alpha: ['src/alpha/**', 'test/alpha.test.mjs'], beta: ['src/beta/**', 'test/beta.test.mjs'] } });
    shop.script('plan', isPlanTurn, planScript(plan));
    let J = null;
    const said = {};
    shop.steps('alpha', shop.work('alpha', /Start now/), [async ({ call, cwd }) => {
      writeFiles(cwd, { ...partFiles('alpha'), 'src/beta/hook.mjs': "export const hook = 'alpha';\n" });
      said.a = (await call('claim', { paths: ['src/beta/hook.mjs'] })).text;
    }]);
    shop.steps('beta', shop.work('beta'), [async ({ call, cwd, until }) => {
      await until(() => shop.taskOf(J, 'alpha')?.why === 'claim', { what: 'alpha waits' });
      writeFiles(cwd, { ...partFiles('beta'), 'src/alpha/hook.mjs': "export const hook = 'beta';\n" });
      said.b = (await call('claim', { paths: ['src/alpha/hook.mjs'] })).text;
    }, async ({ o }) => {
      // The card change wakes the waiting maker (an addressed EVT). It obeys "Stop now": its claim still waits.
      said.wake = o.prompt;
    }]);
    shop.steps('lead resolves', (r) => r.role === 'boss' && r.kind === 'digest' && /wait on each other/.test(r.prompt), [async ({ call }) => {
      said.update = (await call('task_update', { id: shop.taskOf(J, 'beta').id, zones: ['src/beta/index.mjs', 'test/beta.test.mjs'] })).text;
    }]);
    J = await startJob(shop);
    await shipAndFinish(shop, J);
    const A = shop.taskOf(J, 'alpha');
    const B = shop.taskOf(J, 'beta');
    assert.match(said.a, new RegExp(`^WAIT ${B.id} holds src/beta/hook\\.mjs`));
    assert.match(said.b, new RegExp(`^WAIT ${A.id} holds src/alpha/hook\\.mjs`));
    assert.ok(shop.msgs(J).some((m) => m.kind === 'EVT' && /wait on each other/.test(m.body)), 'the cycle EVT');
    assert.match(said.update, /^ok/, said.update);
    const repo = shop.project(J).path;
    assert.equal(git(repo, 'show', 'main:src/beta/hook.mjs'), "export const hook = 'alpha';");
    assert.equal(git(repo, 'show', 'main:src/alpha/hook.mjs'), "export const hook = 'beta';");
    assert.match(said.wake ?? '', /The card of T\d+ changed/);
    assert.deepEqual(shop.task(B.id).pendingClaims, [], 'no claim is left pending on a merged task');
  });

  test('a maker whose claim waits hands in anyway: the claim is withdrawn, the zone check names the path, it claims again', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha', 'beta'])));
    let J = null;
    const said = {};
    shop.steps('beta', shop.work('beta'), [
      async ({ call, post, cwd, o }) => {
        writeFiles(cwd, { ...partFiles('beta'), 'src/alpha/hook.mjs': "export const hook = 'beta';\n" });
        said.wait = (await call('claim', { paths: ['src/alpha/hook.mjs'] })).text;
        said.done = (await post(doneLine(o.taskId))).text; // it does not stop
      },
      async ({ call, post, o, until }) => {
        await until(() => shop.taskOf(J, 'alpha')?.status === 'merged', { what: 'alpha merged' });
        said.again = (await call('claim', { paths: ['src/alpha/hook.mjs'] })).text;
        said.done2 = (await post(doneLine(o.taskId, { body: 'The claim is granted now. Same files.' }))).text;
      },
    ]);
    J = await startJob(shop);
    await shipAndFinish(shop, J);
    const A = shop.taskOf(J, 'alpha');
    const B = shop.taskOf(J, 'beta');
    assert.match(said.wait, new RegExp(`^WAIT ${A.id} holds`));
    assert.match(said.done, /^ok \d+/);
    const fix = shop.msgs(J).find((m) => m.kind === 'FIX' && m.from === '@hub' && m.scope === B.id);
    assert.match(fix.body, /outside your zones: src\/alpha\/hook\.mjs/);
    assert.equal(said.again, 'ok', said.again);
    assert.deepEqual(shop.task(B.id).pendingClaims, []);
    assert.ok(shop.task(B.id).claims.includes('src/alpha/hook.mjs'));
    assert.equal(git(shop.project(J).path, 'show', 'main:src/alpha/hook.mjs'), "export const hook = 'beta';");
  });

  test('a claim wait cycle that nobody resolves: the stall rule wakes the lead once, then pauses the job (stalled)', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha', 'beta'])));
    let J = null;
    shop.steps('alpha', shop.work('alpha', /Start now/), [async ({ call, cwd }) => { writeFiles(cwd, partFiles('alpha')); await call('claim', { paths: ['src/beta/hook.mjs'] }); }]);
    shop.steps('beta', shop.work('beta', /Start now/), [async ({ call, cwd, until }) => {
      await until(() => shop.taskOf(J, 'alpha')?.why === 'claim', { what: 'alpha waits' });
      writeFiles(cwd, partFiles('beta'));
      await call('claim', { paths: ['src/alpha/hook.mjs'] });
    }]);
    shop.script('idle lead', (r) => r.role === 'boss' && ['digest', 'stall'].includes(r.kind), async () => {});
    J = await startJob(shop);
    await shop.waitFor(() => shop.job(J).status === 'paused', { what: 'the stalled pause', jobId: J, timeoutMs: 30_000 });
    assert.equal(shop.job(J).pauseReason, 'stalled');
    assert.ok(shop.turns.some((r) => r.kind === 'stall' && /^STALL in work order/m.test(r.prompt)), 'the lead got one stall digest');
  });

  test('escalation on shop time: maker -> manager (10 min) -> lead boss (15 min) -> expired; never to @human; the asker goes on', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    let J = null;
    let askId = null;
    shop.steps('alpha', shop.work('alpha', /Start now/), [async ({ post, o }) => { askId = id((await post(`ASK @mgr ${o.taskId}: Should run return an empty list for no input?`)).text); }]);
    shop.steps('silent manager', (r) => r.role === 'manager' && r.prompt.includes(`${askId}`), [async () => {
      await runClock(shop, () => shop.msg(J, askId)?.esc >= 1);
    }]);
    shop.steps('silent lead', (r) => r.role === 'boss' && r.kind === 'digest' && r.prompt.includes(`${askId}`), [async () => {
      await runClock(shop, () => shop.msg(J, askId)?.state === 'expired');
    }]);
    J = await startJob(shop, { crew: { bosses: 1, managers: 1, makers: 1 } });
    await shipAndFinish(shop, J);
    const ask = shop.msg(J, askId);
    const f1 = shop.agents(J).find((a) => a.role === 'manager');
    const b1 = shop.agents(J).find((a) => a.role === 'boss');
    assert.equal(ask.state, 'expired');
    assert.ok(ask.via.includes(f1.handle), `it went through the manager: ${ask.via}`);
    assert.equal(ask.toId, b1.id, 'the lead boss held it last');
    assert.ok(!shop.msgs(J).some((m) => m.to === '@human' && m.re === askId), 'an item from below never goes to @human');
    // An expired ASK wakes the asker with the closing line (the no-help line is for a NO or an expired BLOCK).
    const wake = shop.turns.find((r) => r.kind === 'work' && r.taskId === ask.scope && r.resume && new RegExp(`ASK ${askId} .*closed as expired`).test(r.prompt));
    assert.ok(wake, 'the closure woke the asker with the closing line on top');
    assert.ok(shop.msgs(J).some((m) => m.kind === 'DONE' && m.scope === ask.scope), 'the asker handed in');
  });

  test('a sleep (a shop-time jump of 3 h) while a manager holds a question: no deadline fires; the manager answers', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    let J = null;
    let askId = null;
    let before = null;
    let after = null;
    shop.steps('alpha', shop.work('alpha', /Start now/), [async ({ post, o }) => { askId = id((await post(`ASK @mgr ${o.taskId}: Should run return an empty list for no input?`)).text); }]);
    shop.steps('sleepy manager', (r) => r.role === 'manager' && r.prompt.includes(`${askId}`), [async ({ post }) => {
      before = { ...shop.msg(J, askId) };
      shop.clock.offset += 3 * 3600_000; // the Mac slept
      await sleep(900); // several heartbeats
      after = { ...shop.msg(J, askId) };
      await post(`ANS re:${askId}: Yes. An empty input gives an empty list.`);
    }]);
    J = await startJob(shop, { crew: { bosses: 1, managers: 1, makers: 1 } });
    await shipAndFinish(shop, J);
    assert.equal(after.state, 'open', 'the question is still open after the sleep');
    assert.equal(after.esc, 0, 'no escalation');
    assert.ok(after.due - before.due >= 3 * 3600_000 - 5000, `the deadline moved by the gap: ${after.due - before.due}`);
    assert.equal(shop.msg(J, askId).state, 'answered');
    assert.ok(!shop.msgs(J).some((m) => m.kind === 'EVT' && m.re === askId && /expired|moved/.test(m.body)));
  });

  test('the stall rule: a failed task and a lead that does nothing: one stall digest, then paused (stalled); retry and resume finish it', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    shop.steps('alpha', shop.work('alpha', /Start now/), [async ({ post, o }) => { await post(`FAIL ${o.taskId} why=unclear: The card does not say what run returns.`); }]);
    shop.script('idle lead', (r) => r.role === 'boss' && ['digest', 'stall'].includes(r.kind), async () => {});
    const J = await startJob(shop);
    await shop.waitFor(() => shop.job(J).status === 'paused', { what: 'the stalled pause', jobId: J, timeoutMs: 30_000 });
    assert.equal(shop.job(J).pauseReason, 'stalled');
    assert.equal(shop.turns.filter((r) => r.kind === 'stall').length, 1, 'one stall digest');
    assert.ok(shop.notices().some((n) => n.level === 'owner' && /stalled/.test(n.text)) || (await shop.waitFor(() => shop.notices().some((n) => n.level === 'owner' && /stalled/.test(n.text)), { what: 'the notice' })));
    const X = shop.taskOf(J, 'alpha').id;
    const retry = await shop.api('POST', `/api/tasks/${X}/retry`, { note: 'run returns { part, count, items }.' });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal((await shop.api('POST', `/api/jobs/${J}/resume`, {})).status, 200);
    await shipAndFinish(shop, J);
    assert.equal(shop.task(X).status, 'merged');
  });
});

describe('scenarios: deadlines and injected git faults', () => {
  test('the review time of a DONE runs out while the reviewer works: the hub stops that turn; the next reviewer passes', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    let stopped = false;
    shop.steps('slow reviewer', (r) => r.kind === 'review', [async ({ signal }) => {
      await runClock(shop, () => signal.aborted, { maxSteps: 120 });
      stopped = signal.aborted;
      if (signal.aborted) throw Object.assign(new Error('stopped'), { aborted: true });
    }]);
    const J = await startJob(shop, { crew: { bosses: 2, managers: 0, makers: 1 } });
    await shipAndFinish(shop, J);
    assert.equal(stopped, true, 'the hub stopped the review turn when its time ran out');
    const reviews = shop.turns.filter((r) => r.kind === 'review');
    assert.equal(reviews[0].killed, 'cancel');
    assert.notEqual(reviews[1].agentId, reviews[0].agentId, 'the next reviewer');
    const d = shop.deliveries(J)[0];
    assert.equal(d.reviewers.length, 2);
    assert.equal(d.review.verdict, 'pass');
  });

  test('a BLOCK at the lead (no manager) runs out of time: it expires, the maker wakes with the no-help line and finishes', T, async (t) => {
    const shop = await boot();
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha'])));
    let blockId = null;
    let J = null;
    shop.steps('alpha', shop.work('alpha', /Start now/), [async ({ post, o }) => { blockId = id((await post(`BLOCK ${o.taskId} why=unclear: I need the output format of run. The task card does not name it.`)).text); }]);
    // The lead never answers. Each of its turns lets shop time run until the BLOCK closes, or moves and waits to
    // be seen again (a moved item gets its new deadline when its addressee first sees it).
    shop.script('silent lead', (r) => r.role === 'boss' && r.kind === 'digest' && r.prompt.includes(`${blockId}`), async () => {
      await runClock(shop, () => { const m = shop.msg(J, blockId); return m?.state !== 'open' || m.due === null; });
    });
    J = await startJob(shop);
    await shipAndFinish(shop, J);
    const block = shop.msg(J, blockId);
    assert.equal(block.state, 'expired');
    assert.equal(block.esc, 1, 'one more deadline at the lead (it held the item from the start), then expired');
    assert.ok(shop.msgs(J).some((m) => m.kind === 'EVT' && m.re === blockId && /Nobody is above/.test(m.body)));
    assert.ok(!shop.msgs(J).some((m) => m.to === '@human' && m.re === blockId), 'an item from below never goes to @human');
    const wake = shop.turns.find((r) => r.kind === 'work' && r.taskId === block.scope && /No help is available\. Finish and state your assumption in DONE, or post FAIL\./.test(r.prompt));
    assert.ok(wake, 'the expired BLOCK woke the maker with the no-help line');
    const done = shop.msgs(J).find((m) => m.kind === 'DONE' && m.scope === block.scope);
    assert.match(done.body, /I assumed/, 'the maker states its assumption in DONE');
  });

  test('injected faults at integrate: a conflict sends the task back with no attempt; git errors twice block it (owner notice)', T, async (t) => {
    let conflicts = 1;
    let errors = 0;
    let errorTask = null;
    const shop = await boot({
      wrapOrch: (orch, ctx) => {
        const integrate = ctx.git.integrate;
        ctx.git.integrate = async (project, jobId, taskId, ...rest) => {
          const title = ctx.task(taskId)?.title ?? '';
          if (title.startsWith('Part alpha:') && conflicts > 0) { conflicts -= 1; return { ok: false, reason: 'conflict', detail: 'CONFLICT (content): src/alpha/index.mjs' }; }
          if (title.startsWith('Part beta:') && errors < 2) { errors += 1; errorTask = taskId; return { ok: false, reason: 'error', detail: 'fatal: injected git error' }; }
          return integrate.call(ctx.git, project, jobId, taskId, ...rest);
        };
      },
    });
    guard(t, shop);
    shop.script('plan', isPlanTurn, planScript(partsPlan(['alpha', 'beta'])));
    const J = await startJob(shop);
    const B = await shop.waitFor(() => { const x = shop.taskOf(J, 'beta'); return x?.status === 'blocked' && x; }, { what: 'beta blocked after two git errors', jobId: J });
    assert.equal(B.why, 'error');
    assert.match(B.lastError, /injected git error/);
    await shop.waitFor(() => shop.notices().some((n) => n.level === 'owner' && /could not be merged/.test(n.text)), { what: 'the owner notice', jobId: J });
    const A = await shop.waitFor(() => { const x = shop.taskOf(J, 'alpha'); return x?.status === 'merged' && x; }, { what: 'the queue goes on: alpha merges', jobId: J });
    assert.ok(shop.seen('tasks', (x) => x.id === A.id && x.status === 'rework' && x.attempts === 0).length, 'a conflict at integrate raises no attempt');
    assert.equal(shop.deliveries(J, A.id).length, 2, 'alpha handed in again after the conflict');
    const r = await shop.api('POST', `/api/tasks/${errorTask}/retry`, { note: 'The git error is gone.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await shipAndFinish(shop, J);
    assert.equal(errors, 2);
  });
});
