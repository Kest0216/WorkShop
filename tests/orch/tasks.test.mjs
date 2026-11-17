// Task flow: claims queue, refused hand-ins for each cause, FIX then PASS with the sticky reviewer, the buddy
// check, integrate after a stale head and with a conflict, the closing act and nudges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeShop, ownerGit, samplePlan } from './harness.mjs';

const workCount = (h, taskId) => h.runner.log.filter((x) => x.kind === 'work' && h.store.get('agents', x.agentId)?.taskId === taskId).length;
const done = (task) => `DONE ${task.id} tests=1/1 acc=${task.acceptance.length}/${task.acceptance.length}: I wrote the module for ${task.id}.`;
const taskOf = (h, turn) => h.store.get('tasks', h.store.get('agents', turn.agentId).taskId);

/** Commit a change straight on the integration branch as if another task merged it (job.intSha follows). */
function sideMerge(h, rel, text) {
  const job = h.job();
  h.write(job.integrationDir, rel, text);
  ownerGit(job.integrationDir, h.env, 'add', '-A');
  ownerGit(job.integrationDir, h.env, 'commit', '-q', '-m', `side ${rel}`);
  const sha = ownerGit(job.integrationDir, h.env, 'rev-parse', 'HEAD');
  h.store.patch('jobs', job.id, { intSha: sha });
}

test('claims: a path held by an open task waits (blocked why claim), then is granted when the holder merges', async (t) => {
  let waitAnswer = null;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 2 }),
    brainHooks: {
      work: async (turn, hh) => {
        const task = taskOf(hh, turn);
        if (task.id !== 'T1' || turn.opts.access === 'read') return undefined;
        if (!task.claims.length && !task.pendingClaims.length) {
          waitAnswer = await turn.call('claim', { paths: ['mod2/shared.js'] });
          return {};
        }
        hh.write(turn.cwd, 'mod1/index.js', 'export const a = 1;\n');
        hh.write(turn.cwd, 'mod2/shared.js', 'export const shared = 1;\n');
        await turn.post(done(task));
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.match(waitAnswer, /^WAIT T2 holds mod2\/shared\.js/);
  const t1 = h.store.get('tasks', 'T1');
  assert.equal(t1.status, 'merged');
  assert.deepEqual(t1.claims, ['mod2/shared.js']);
  const d1 = h.deliveries().find((d) => d.taskId === 'T1' && d.status === 'loaded');
  assert.deepEqual(d1.flags.claimed, ['mod2/shared.js']);
  assert.ok(h.msgs().some((m) => m.kind === 'EVT' && /claim on mod2\/shared\.js is granted/.test(m.body)));
  assert.equal(h.job().status, 'delivering');
});

test('claims: globs, hub paths and too many paths are refused; own zone paths are ok', async (t) => {
  const answers = [];
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn) => {
        if (answers.length) return undefined;
        answers.push(await turn.call('claim', { paths: ['src/*.js'] }));
        answers.push(await turn.call('claim', { paths: ['.shop/x'] }));
        answers.push(await turn.call('claim', { paths: ['mod1/a.js'] }));
        answers.push(await turn.call('claim', { paths: ['a1', 'a2', 'a3', 'a4', 'a5'] }));
        answers.push(await turn.call('claim', { paths: ['a6'] }));
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.match(answers[0], /glob/);
  assert.match(answers[1], /hub/);
  assert.match(answers[2], /yours already/);
  assert.equal(answers[3], 'ok');
  assert.match(answers[4], /At most 5 claims/);
});

for (const [cause, first, expect] of [
  ['guard (denied path)', (hh, cwd) => hh.write(cwd, 'mod1/.env', 'X=1\n'), /hub deny list/],
  ['zone', (hh, cwd) => hh.write(cwd, 'elsewhere/x.js', '1\n'), /outside your zones/],
  ['check', (hh, cwd) => hh.write(cwd, 'mod1/BROKEN', '1\n'), /Check failed\. See \.shop\/CHECK\.log\./],
]) {
  test(`a refused hand-in (${cause}) posts FIX as @hub, sets rework with attempts++, and the fixed work merges`, async (t) => {
    let turns = 0;
    const h = await makeShop({
      planFor: () => samplePlan({ n: 1, check: 'test ! -e mod1/BROKEN' }),
      brainHooks: {
        work: async (turn, hh) => {
          const task = taskOf(hh, turn);
          turns++;
          hh.write(turn.cwd, 'mod1/index.js', `export const v = ${turns};\n`);
          if (turns === 1) first(hh, turn.cwd);
          else {
            for (const f of ['mod1/.env', 'elsewhere/x.js', 'mod1/BROKEN']) fs.rmSync(path.join(turn.cwd, f), { force: true, recursive: true });
            fs.rmSync(path.join(turn.cwd, 'elsewhere'), { force: true, recursive: true });
          }
          await turn.post(done(task));
          return {};
        },
      },
    });
    t.after(() => h.close());
    await h.start();
    const fix = h.msgs().find((m) => m.kind === 'FIX' && m.from === '@hub');
    assert.ok(fix, 'the hub posted FIX');
    assert.match(fix.body, expect);
    const task = h.store.get('tasks', 'T1');
    assert.equal(task.status, 'merged');
    assert.equal(task.attempts, 1);
    assert.equal(h.deliveries().filter((d) => d.status === 'rejected').length, 1);
    const rework = h.turns('work')[1];
    assert.equal(rework.resume, true, 'the rework turn resumes the work session');
  });
}

test('an empty hand-in is refused once; the second empty one goes to review with the flag empty', async (t) => {
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: { work: async (turn, hh) => { await turn.post(done(taskOf(hh, turn))); return {}; } },
  });
  t.after(() => h.close());
  await h.start();
  const fix = h.msgs().find((m) => m.kind === 'FIX' && m.from === '@hub');
  assert.match(fix.body, /No changes found in your bench/);
  const last = h.deliveries().find((d) => d.status === 'loaded');
  assert.equal(last.flags.empty, true);
  assert.match(h.turns('review').at(-1).prompt, /FLAG empty/);
});

test('a merge conflict found by the hub does not raise attempts; the maker resolves it', async (t) => {
  let turns = 0;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        const task = taskOf(hh, turn);
        turns++;
        if (turns === 1) {
          hh.write(turn.cwd, 'mod1/index.js', 'export const mine = 1;\n');
          sideMerge(hh, 'mod1/index.js', 'export const theirs = 2;\n');
        } else {
          hh.write(turn.cwd, 'mod1/index.js', 'export const mine = 1;\nexport const theirs = 2;\n');
        }
        await turn.post(done(task));
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const fix = h.msgs().find((m) => m.kind === 'FIX' && m.from === '@hub');
  assert.match(fix.body, /Merge conflict with the integration branch in: mod1\/index\.js/);
  const task = h.store.get('tasks', 'T1');
  assert.equal(task.attempts, 0);
  assert.equal(task.status, 'merged');
});

test('FIX then PASS: the sticky reviewer resumes its review session with the earlier FIX items', async (t) => {
  let reviews = 0;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      review: async (turn) => {
        reviews++;
        const id = /Their DONE is message (\d+)/.exec(turn.prompt)[1];
        if (reviews === 1) await turn.post(`FIX re:${id}:\n1. Add a comment at the top of mod1/index.js:1.`);
        else await turn.post(`PASS re:${id}: The FIX item is done.`);
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const rv = h.turns('review');
  assert.equal(rv.length, 2);
  assert.equal(rv[0].agentId, rv[1].agentId, 'the same reviewer');
  assert.equal(rv[1].resume, true, 'the review session is resumed');
  assert.match(rv[1].prompt, /REVIEW T1 again/);
  assert.match(rv[1].prompt, /Add a comment at the top/);
  assert.match(rv[1].prompt, /git diff [0-9a-f]{40} [0-9a-f]{40}/);
  const task = h.store.get('tasks', 'T1');
  assert.equal(task.attempts, 1);
  assert.equal(task.status, 'merged');
  assert.ok(task.lastReviewedSha);
  const ds = h.deliveries().sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  assert.equal(ds[0].review.verdict, 'changes');
  assert.deepEqual(ds[0].review.mustFix, ['1. Add a comment at the top of mod1/index.js:1.']);
  assert.equal(ds[1].review.verdict, 'pass');
  assert.equal(typeof ds[1].review.crossLab, 'boolean');
});

test('buddy check: a maker of the other lab looks first; its FIX sends the task back once, then straight to review', async (t) => {
  let buddies = 0;
  const h = await makeShop({
    settings: { pairing: 'all' },
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      buddy: async (turn) => {
        buddies++;
        const id = /Their DONE is message (\d+)/.exec(turn.prompt)[1];
        await turn.post(`FIX re:${id}:\n1. Name the export in mod1/index.js:1.`);
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.equal(buddies, 1);
  const bt = h.turns('buddy')[0];
  const buddy = h.store.get('agents', bt.agentId);
  const maker = h.store.get('agents', h.store.get('tasks', 'T1').assigneeId) ?? h.agents().find((a) => a.role === 'maker' && a.id !== buddy.id);
  assert.equal(buddy.role, 'maker');
  assert.notEqual(buddy.provider, h.turns('work').map((x) => h.store.get('agents', x.agentId))[0].provider);
  assert.equal(bt.access, 'read');
  assert.match(bt.prompt, /You are the buddy check/);
  const first = h.deliveries().find((d) => d.buddy);
  assert.equal(first.buddy.verdict, 'changes');
  const task = h.store.get('tasks', 'T1');
  assert.equal(task.status, 'merged');
  assert.equal(task.attempts, 1);
  assert.equal(task.buddyDone, true);
  assert.equal(h.turns('review').length, 1);
  void maker;
});

test('integrate after a stale head: the hub syncs, checks that merge and integrates with expectHead', async (t) => {
  let sided = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      review: async (turn, hh) => {
        if (!sided) { sided = true; sideMerge(hh, 'other/side.txt', 'side\n'); }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  const d = h.deliveries().find((x) => x.status === 'loaded');
  assert.ok(d.syncSha, 'the hub made its own sync merge');
  assert.notEqual(d.syncSha, d.headSha);
  assert.equal(h.store.get('tasks', 'T1').status, 'merged');
});

test('integrate with a conflict: the task goes back to rework, then through review again', async (t) => {
  let sided = false;
  let works = 0;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      work: async (turn, hh) => {
        works++;
        const task = taskOf(hh, turn);
        hh.write(turn.cwd, 'mod1/index.js', works === 1 ? 'export const mine = 1;\n' : 'export const merged = 3;\n');
        await turn.post(done(task));
        return {};
      },
      review: async (turn, hh) => {
        if (!sided) { sided = true; sideMerge(hh, 'mod1/index.js', 'export const theirs = 2;\n'); }
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.ok(h.msgs().some((m) => m.kind === 'EVT' && /could not merge/.test(m.body)));
  assert.equal(h.turns('review').length, 2);
  assert.equal(h.store.get('tasks', 'T1').status, 'merged');
});

test('closing act: a work turn without DONE, BLOCK or FAIL is nudged maxNudges times, then blocked (nudges)', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }), brainHooks: { work: async () => ({}) }, tuning: { managerDebounceMs: 0 } });
  t.after(() => h.close());
  await h.start();
  const task = h.store.get('tasks', 'T1');
  assert.equal(workCount(h, 'T1') >= 3, true);
  assert.equal(task.status === 'blocked' || h.job().status === 'paused', true, `${task.status} ${h.job().status}`);
  const works = h.turns('work');
  assert.match(works[1].prompt, /You ended your turn without a DONE, BLOCK or FAIL post for T1/);
  assert.ok(h.msgs().some((m) => m.kind === 'EVT' && /is blocked: its maker ended its turns/.test(m.body)));
});
