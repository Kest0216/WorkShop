// Scenarios: two labs side by side (contract sections 11, 12, 12b). The REAL hub (createApp) on temp folders with
// two labs: the claude and agy adapters with their real names, models and probes, but every turn runs the mock
// agent (twoLabs in harness.mjs). No real AI CLI runs. A turn can be scripted (ruleDecide): it posts ShopTalk lines
// or calls hub tools as the agent, then ends or hands over to the mock agent.
//
// Each scenario ends with the full check: every task merged once, every requirement verified, the truck ships, and
// no process is left.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BRIEF, bootShop, git, shipAndFinish, tempShop } from '../e2e-harness.mjs';
import { assertOnce, crashRun, finishShop, ruleDecide, setSettings, twoLabs, waitReaped } from './harness.mjs';

const T = { timeout: 600_000 };
// Waits are for a state, with long caps: on a machine that runs other suites a job is slow, not stuck.
const LOADED = 330_000;
const keep = process.env.KEEP_E2E === '1';
const settled = async (shop) => assert.equal(await shop.app.orch.settle({ timeoutMs: 120_000 }), true, 'the hub settled');

function cleanup(t, getShop, dirs) {
  t.after(async () => {
    await getShop()?.close().catch(() => {});
    if (!keep) fs.rmSync(dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
  });
}

/** What happened, for a failure message: agents with their labs, tasks, deliveries, turns, board. */
function trail(shop, J) {
  const ag = (id) => shop.app.store.get('agents', id);
  const agents = shop.agents(J).map((a) => `${a.handle}:${a.role}:${a.provider}/${a.model}${a.lead ? ':lead' : ''}${a.hidden ? ':hidden' : ''}${a.hold ? ':hold' : ''}:${a.status}`);
  const tasks = shop.tasks(J).map((x) => `${x.id}:${x.domain}/${x.size}${x.pair ? '/pair' : ''}:${x.status}:as=${ag(x.assigneeId)?.handle}:rev=${ag(x.reviewerId)?.handle}:bud=${ag(x.buddyId)?.handle}${x.hold ? ':hold' : ''}`);
  const ds = shop.deliveries(J).map((d) => `${d.id}:${d.taskId}:${d.status}:rev=${d.review?.by ?? '-'}:cross=${d.review?.crossLab}:buddy=${d.buddy?.verdict ?? '-'}`);
  const turns = shop.turns.map((x) => `${x.handle}/${ag(x.agentId)?.provider}:${x.kind}:${x.taskId ?? ''}:${x.ok}${x.killed ? `:killed=${x.killed}` : ''}${x.error ? `:${x.error.kind}` : ''}`);
  const msgs = shop.app.board.history({ jobId: J, limit: 500 }).map((m) => `${m.id}:${m.kind}:${m.from}>${m.to ?? ''}:${m.scope}:re=${m.re ?? ''}:${m.state ?? ''}`);
  const job = shop.job(J);
  return `job ${job?.status} ${job?.pauseReason ?? ''} lead=${ag(job?.leadBossId)?.handle} qa=${ag(job?.qa?.agentId)?.handle}\nagents ${agents.join(' ')}\ntasks ${tasks.join(' ')}\ndeliveries ${ds.join(' ')}\nturns ${turns.join(' ')}\nboard ${msgs.join(' ')}\nerrors ${JSON.stringify(shop.errors()).slice(0, 1500)}`;
}

/**
 * One job on two labs, from start to ship. opts: { crew, brief, settings, rules (for ruleDecide) or
 * decide() -> a decide function for twoLabs, during(shop, J), check(shop, J, { truck, calls }) }.
 */
async function labsJob(t, opts = {}) {
  const dirs = tempShop('ws-2lab-');
  const labs = twoLabs(dirs, opts.decide ? opts.decide() : ruleDecide(opts.rules ?? []));
  setSettings(dirs, { ...labs.settings, ...(opts.settings ?? {}), limits: { holdFallbackMin: 0.02, ...(opts.settings?.limits ?? {}) } });
  let shop = null;
  cleanup(t, () => shop, dirs);
  shop = await bootShop({ dirs, app: labs.app });
  const r = await shop.api('POST', '/api/jobs', { title: 'Two labs', brief: opts.brief ?? BRIEF, kind: 'build', project: { mode: 'new', name: 'two' }, crew: opts.crew ?? 'standard', budgetUsd: 1000, options: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const J = r.body.id;
  try {
    if (opts.during) await opts.during(shop, J);
    const { truck } = await shipAndFinish(shop, J, { timeoutMs: LOADED });
    await settled(shop);
    await assertOnce(shop, J);
    if (opts.check) await opts.check(shop, J, { truck, calls: labs.calls });
  } catch (err) {
    err.stack = `${err.stack}\n${trail(shop, J)}`;
    throw err;
  }
  await finishShop(shop, { keep, allowErrors: opts.allowErrors === true });
}

const agentOf = (shop, id) => shop.app.store.get('agents', id);
const providerOf = (shop, id) => agentOf(shop, id)?.provider ?? null;
const turnsOf = (shop, fn) => shop.turns.filter(fn);

// ------------------------------------------------------------------ 1. cross-lab review

describe('two labs: cross-lab review', { concurrency: 2 }, () => {
  test('both labs usable: a boss of the other lab reviews each hand-in and stays the sticky reviewer; no crate shows a same-lab review', T, async (t) => {
    await labsJob(t, {
      crew: 'full', brief: `${BRIEF} [mock:reject]`,
      settings: { review: { reviewer: 'boss', crossLab: true, smallByManager: false } },
      check: (shop, J, { truck }) => {
        const ds = shop.deliveries(J).filter((d) => d.review);
        assert.ok(ds.length >= shop.tasks(J).length, 'every task got a review');
        for (const d of ds) {
          const maker = agentOf(shop, d.makerId);
          const rev = shop.agents(J).find((a) => a.handle === d.review.by);
          assert.equal(rev.role, 'boss', `${d.id} is reviewed by a boss`);
          assert.notEqual(rev.provider, maker.provider, `${d.id}: the reviewer ${rev.handle} (${rev.provider}) is of another lab than the maker ${maker.handle} (${maker.provider})`);
          assert.equal(d.review.crossLab, true, `${d.id} stores crossLab true`);
        }
        assert.ok(truck.deliveries.length > 0);
        for (const c of truck.deliveries) assert.equal(c.sameLab, false, `crate ${c.id} shows no same-lab review`);
        // [mock:reject]: one task got a FIX and a second review. It is the same reviewer, in the same session.
        const again = shop.tasks(J).find((x) => ds.filter((d) => d.taskId === x.id).length >= 2);
        assert.ok(again, 'one task was reviewed twice');
        const reviews = ds.filter((d) => d.taskId === again.id);
        assert.equal(new Set(reviews.map((d) => d.review.by)).size, 1, `${again.id}: the same reviewer both times (sticky)`);
        const rt = turnsOf(shop, (x) => x.kind === 'review' && x.taskId === again.id);
        assert.ok(rt.length >= 2);
        assert.equal(rt.at(-1).resume, true, 'the re-review resumes the review session');
        assert.equal(rt.at(-1).sessionId, rt[0].resultSession, 'the re-review resumes the session of the first review');
        assert.match(rt.at(-1).prompt, /REVIEW T\d+ again/);
      },
    });
  });

  test('the other lab is not usable: a boss of the same lab reviews, the delivery stores crossLab false and the crate shows a same-lab review', T, async (t) => {
    await labsJob(t, {
      settings: { auth: { claude: 'apikey', gemini: null } },
      check: (shop, J, { truck }) => {
        assert.equal(shop.app.providers.status('gemini').usable, false);
        assert.ok(shop.agents(J).every((a) => a.provider === 'claude'), 'every agent is on the usable lab');
        const ds = shop.deliveries(J).filter((d) => d.review);
        assert.ok(ds.length > 0);
        for (const d of ds) {
          const rev = shop.agents(J).find((a) => a.handle === d.review.by);
          assert.equal(rev.role, 'boss', `${d.id}: the fallback reviewer is a boss`);
          assert.equal(d.review.crossLab, false, `${d.id} stores crossLab false`);
        }
        for (const c of truck.deliveries) assert.equal(c.sameLab, true, `crate ${c.id} shows the same-lab review`);
      },
    });
  });
});

// ------------------------------------------------------------------ 2. buddy check

describe('two labs: buddy check', () => {
  test('pairing on: a maker of the other lab checks each hand-in before the boss review; FIX sends it back once, a no-show or a failed buddy turn is skipped', T, async (t) => {
    // The first buddy verdict is FIX, the second buddy ends with no verdict, the third fails. Others: the mock (PASS).
    const rules = [
      { kind: 'review', buddy: true, nth: 1, act: [{ post: 'FIX re:{id}:\n1. Add a test for empty input in test/index.test.js:1' }], then: 'end' },
      { kind: 'review', buddy: true, nth: 2, act: [], then: 'end' },
      { kind: 'review', buddy: true, nth: 3, error: 'other', message: 'the buddy crashed' },
    ];
    const got = [];
    await labsJob(t, {
      settings: { pairing: 'all' },
      decide: () => {
        const d = ruleDecide(rules);
        return (c) => {
          const r = d(c);
          if (c.kind === 'review' && c.turn.buddy) got.push({ task: c.turn.task, what: r ? (r.error ? 'error' : r.act.length ? 'fix' : 'silent') : 'mock' });
          return r;
        };
      },
      check: (shop, J) => {
        assert.deepEqual(got.slice(0, 3).map((g) => g.what), ['fix', 'silent', 'error'], `the scripted buddy turns ran (${JSON.stringify(got)})`);
        for (const x of shop.tasks(J)) {
          const buddies = turnsOf(shop, (y) => y.kind === 'buddy' && y.taskId === x.id);
          assert.equal(buddies.length, 1, `${x.id} got one buddy check (once per task)`);
          const b = buddies[0];
          const ds = shop.deliveries(J).filter((d) => d.taskId === x.id);
          const maker = agentOf(shop, ds[0].makerId);
          assert.equal(b.role, 'maker', `${x.id}: the buddy is a maker`);
          assert.notEqual(providerOf(shop, b.agentId), maker.provider, `${x.id}: the buddy ${b.handle} is of the other lab than ${maker.handle}`);
          assert.equal(b.access, 'read', 'the buddy has read access');
          const review = turnsOf(shop, (y) => y.kind === 'review' && y.taskId === x.id)[0];
          assert.ok(review && review.startedAt >= b.startedAt, `${x.id}: the buddy check ran before the review`);
        }
        const fix = got.find((g) => g.what === 'fix');
        const fd = shop.deliveries(J).filter((d) => d.taskId === fix.task);
        assert.equal(fd[0].buddy?.verdict, 'changes', 'the buddy FIX is stored on the delivery');
        assert.equal(fd[0].status, 'rejected', 'the buddy FIX sent the hand-in back');
        assert.equal(fd[0].review, null, 'no boss reviewed the hand-in that the buddy sent back');
        assert.ok(fd.length >= 2, 'the maker handed in again');
        assert.ok(turnsOf(shop, (y) => y.kind === 'work' && y.taskId === fix.task).length >= 2, 'the maker reworked the task');
        assert.ok(fd.at(-1).review, 'the next hand-in went straight to the reviewer');
        for (const what of ['silent', 'error']) {
          const g = got.find((x) => x.what === what);
          const d = shop.deliveries(J).find((x) => x.taskId === g.task && x.status === 'shipped');
          assert.equal(d.buddy, null, `${g.task}: no buddy verdict (${what})`);
          assert.equal(d.review?.verdict, 'pass', `${g.task}: the review went on after the buddy ${what === 'silent' ? 'no-show' : 'failure'}`);
        }
      },
    });
  });
});

// ------------------------------------------------------------------ 3. consult

describe('two labs: consult', () => {
  test('ASK @other: the hub runs a read-only consult of the other lab in the asker\'s bench and the ANS reaches the asker; a BLOCK why=tests gets the hub\'s own consult', T, async (t) => {
    const rules = [
      { kind: 'task', task: 'T2', act: [{ post: 'ASK @other {task}: Should the search ignore the case of the letters?' }], then: 'end' },
      { kind: 'task', task: 'T3', act: [{ post: 'BLOCK {task} why=tests: The test runner cannot find the module of this part.' }], then: 'end' },
      // T4: two hand-ins with a file outside the zones, so the hub refuses them twice.
      ...[1, 2].map((nth) => ({ kind: '*', role: 'maker', task: 'T4', nth, act: [{ write: `scratch/T4-${nth}.txt`, text: 'notes\n' }, { post: `DONE {task} tests=none acc=2/2: Added scratch/T4-${nth}.txt. I checked the files by hand.` }], then: 'end' })),
    ];
    await labsJob(t, {
      rules,
      check: (shop, J) => {
        const msgs = shop.msgs(J);
        const consults = turnsOf(shop, (x) => x.kind === 'consult');
        // The maker's question.
        const ask = msgs.find((m) => m.kind === 'ASK' && m.to === '@other' && m.scope === 'T2' && m.from !== '@hub');
        assert.ok(ask, 'the maker asked @other');
        const askerTurn = turnsOf(shop, (x) => x.kind === 'work' && x.taskId === 'T2')[0];
        const c2 = consults.find((x) => x.taskId === 'T2');
        assert.ok(c2, 'a consult turn ran for T2');
        assert.notEqual(providerOf(shop, c2.agentId), providerOf(shop, askerTurn.agentId), 'the consult runs on the other lab');
        assert.equal(agentOf(shop, c2.agentId).role, 'manager', 'a manager-tier persona answers');
        assert.equal(c2.access, 'read', 'the consult is read-only');
        assert.equal(c2.cwd, askerTurn.cwd, 'the consult runs in the asker\'s bench');
        assert.equal(c2.resume, false, 'a fresh session');
        assert.match(c2.prompt, /CONSULT on T2/);
        const ans = msgs.find((m) => m.kind === 'ANS' && m.re === ask.id);
        assert.ok(ans, 'the consult answered with ANS');
        assert.equal(ans.from, c2.handle, 'the consult agent posted the ANS');
        assert.equal(shop.app.board.get(ask.id).state, 'answered');
        const next = turnsOf(shop, (x) => x.taskId === 'T2' && x.agentId === askerTurn.agentId && x.startedAt > c2.startedAt)[0];
        assert.ok(next, 'the asker was woken after the consult');
        assert.ok(next.prompt.includes(`re:${ask.id}`), 'the ANS reaches the asker');
        // The hub's own consult on a BLOCK why=tests.
        const block = msgs.find((m) => m.kind === 'BLOCK' && m.scope === 'T3');
        const hubAsk = msgs.find((m) => m.kind === 'ASK' && m.to === '@other' && m.scope === 'T3' && m.from === '@hub');
        assert.ok(block && hubAsk, 'the hub asked @other for the blocked task');
        const c3 = consults.find((x) => x.taskId === 'T3');
        const blocked = turnsOf(shop, (x) => x.kind === 'work' && x.taskId === 'T3')[0];
        assert.ok(c3, 'a consult turn ran for T3');
        assert.notEqual(providerOf(shop, c3.agentId), providerOf(shop, blocked.agentId), 'the hub consult runs on the other lab');
        assert.equal(c3.cwd, blocked.cwd);
        const ans3 = msgs.find((m) => m.kind === 'ANS' && m.re === hubAsk.id);
        assert.ok(ans3, 'the hub consult got its ANS');
        const hubAns = msgs.find((m) => m.kind === 'ANS' && m.re === block.id && m.from === '@hub');
        assert.ok(hubAns, 'the hub answered the BLOCK');
        assert.ok(hubAns.body.includes(String(ans3.id)), 'the hub answer points at the consult ANS');
        // The hub's own consult on the second refused hand-in: ASK @other from @hub, then the hub's FIX points at the ANS.
        const dones = msgs.filter((m) => m.kind === 'DONE' && m.scope === 'T4');
        const fixes = msgs.filter((m) => m.kind === 'FIX' && m.from === '@hub' && dones.slice(0, 2).some((d) => d.id === m.re));
        assert.equal(fixes.length, 2, 'the hub refused the first two hand-ins of T4');
        const refAsk = msgs.find((m) => m.kind === 'ASK' && m.to === '@other' && m.scope === 'T4' && m.from === '@hub');
        assert.ok(refAsk, 'the second refusal started a consult');
        assert.ok(refAsk.id < fixes[1].id, 'the consult came before the second FIX');
        const c4 = consults.find((x) => x.taskId === 'T4');
        const maker4 = turnsOf(shop, (x) => x.kind === 'work' && x.taskId === 'T4')[0];
        assert.notEqual(providerOf(shop, c4.agentId), providerOf(shop, maker4.agentId), 'the refusal consult runs on the other lab');
        const ans4 = msgs.find((m) => m.kind === 'ANS' && m.re === refAsk.id);
        assert.ok(ans4, 'the refusal consult answered');
        assert.match(fixes[1].body, new RegExp(`See the consult answer in message ${ans4.id}`), 'the second FIX points at the consult answer');
        const shipped = shop.deliveries(J).find((d) => d.taskId === 'T4' && d.status === 'shipped');
        assert.ok(!shipped.files.some((f) => f.path.startsWith('scratch/')), 'no refused file shipped');
        const project = shop.project(J);
        assert.equal(git(project.path, 'log', '--format=%H', project.targetBranch, '--', 'scratch'), '', 'no commit of the target branch holds a refused file');
      },
    });
  });
});

describe('two labs: consult with lab trouble', () => {
  test('the consult model stays rate-limited: the consult never moves to the asker\'s lab; with no other model of the other lab the asker gets NO why=env', T, async (t) => {
    const ask = ruleDecide([{ kind: 'task', task: 'T2', act: [{ post: 'ASK @other {task}: Should the search ignore the case of the letters?' }], then: 'end' }]);
    let limited = null;
    await labsJob(t, {
      decide: () => (c) => {
        if (c.kind === 'consult' && !limited) {
          limited = { model: c.agent.model, provider: c.agent.provider };
          return { error: 'rate_limit', model: c.agent.model, resetAt: Date.now() + 10 * 60_000 };
        }
        return ask(c);
      },
      check: (shop, J, { calls }) => {
        assert.ok(limited, 'the consult turn hit the rate limit');
        const asker = turnsOf(shop, (x) => x.kind === 'work' && x.taskId === 'T2')[0];
        const askerLab = providerOf(shop, asker.agentId);
        assert.notEqual(limited.provider, askerLab);
        const consults = calls.filter((c) => c.kind === 'consult');
        for (const c of consults) assert.notEqual(c.provider, askerLab, `the consult turn of ${c.handle} runs on the other lab, not on ${askerLab}`);
        const q = shop.msgs(J).find((m) => m.kind === 'ASK' && m.to === '@other' && m.scope === 'T2');
        const no = shop.msgs(J).find((m) => m.kind === 'NO' && m.re === q.id);
        assert.ok(no && no.from === '@hub' && no.slots?.why === 'env', 'the hub answers NO why=env');
        assert.ok(turnsOf(shop, (x) => x.taskId === 'T2' && x.agentId === asker.agentId && x.startedAt > asker.startedAt).some((x) => x.prompt.includes(`re:${q.id}`)), 'the asker hears the NO');
      },
    });
  });
});

// ------------------------------------------------------------------ 4. ledger audit and QA

describe('two labs: ledger audit and QA', () => {
  test('the audit and QA run on a boss of the other lab than the lead; an audit find and a failed requirement each get a new task and QA runs again', T, async (t) => {
    const rules = [
      { kind: 'audit', act: [{ tool: 'req_add', args: { text: 'The notes app shows how many notes there are.', why: 'Build a small notes app: a list of notes.' } }], then: 'end' },
    ];
    await labsJob(t, {
      crew: 'full', brief: `${BRIEF} [mock:reqfail]`, rules,
      check: (shop, J) => {
        const job = shop.job(J);
        const lead = agentOf(shop, job.leadBossId);
        const audit = turnsOf(shop, (x) => x.kind === 'audit');
        assert.equal(audit.length, 1, 'one audit turn');
        assert.equal(audit[0].role, 'boss', 'a boss audits the ledger');
        assert.notEqual(providerOf(shop, audit[0].agentId), lead.provider, 'the auditor is of the other lab than the lead');
        const found = job.requirements.find((r) => /how many notes/.test(r.text));
        assert.ok(found, 'the audit added a requirement');
        assert.deepEqual(job.auditAdded, [found.id]);
        const serving = shop.tasks(J).filter((x) => (x.reqs ?? []).includes(found.id));
        assert.ok(serving.length > 0 && serving.every((x) => x.status === 'merged'), `a merged task serves ${found.id}`);
        const qa = turnsOf(shop, (x) => x.kind === 'qa');
        assert.ok(qa.length >= 2, 'QA ran again after the failed requirement got a task');
        for (const q of qa) {
          assert.equal(q.role, 'boss', 'a boss runs QA');
          assert.notEqual(providerOf(shop, q.agentId), lead.provider, 'QA runs on the other lab than the lead');
        }
        assert.ok(job.qa.round >= 2, `QA round ${job.qa.round}`);
        assert.ok(shop.tasks(J).some((x) => /^Repair R\d+/.test(x.title) && x.status === 'merged'), 'the failed requirement got a merged task');
      },
    });
  });
});

// ------------------------------------------------------------------ 5. routing by the benchmark data

describe('two labs: routing', () => {
  test('the shipped registry, three bosses, three managers, six makers: both labs in every tier, and maker models follow the task kind', T, async (t) => {
    await labsJob(t, {
      crew: 'full',
      check: (shop, J) => {
        const agents = shop.agents(J).filter((a) => !a.hidden);
        const by = (role) => agents.filter((a) => a.role === role);
        for (const role of ['boss', 'manager', 'maker']) {
          const labs = new Set(by(role).map((a) => a.provider));
          assert.deepEqual([...labs].sort(), ['claude', 'gemini'], `${role}s come from both labs (${by(role).map((a) => `${a.handle}:${a.model}`).join(' ')})`);
        }
        // Contract 11: boss tier Fable 5.2 and Gemini 4 Carbon; the lead is the best plan model (reasoning 91 vs 84.83).
        const lead = agentOf(shop, shop.job(J).leadBossId);
        assert.equal(lead.model, 'claude-fable-5-2');
        assert.deepEqual([...new Set(by('boss').map((a) => a.model))].sort(), ['claude-fable-5-2', 'gemini-4-carbon']);
        assert.deepEqual([...new Set(by('manager').map((a) => a.model))].sort(), ['claude-opus-5-5', 'gemini-4-argon']);
        // Makers follow the task kind: the first key of the domain decides (chore: coding value index, Haiku far
        // ahead; data and test: coding, Sonnet 80.97 vs Hydrogen 75.75; algo and docs: a tie, so the cheaper Hydrogen).
        const want = { chore: 'claude-haiku-5-5', data: 'claude-sonnet-5-5', test: 'claude-sonnet-5-5', backend: 'claude-sonnet-5-5', frontend: 'claude-sonnet-5-5', fix: 'claude-sonnet-5-5', algo: 'gemini-4-hydrogen', docs: 'gemini-4-hydrogen' };
        for (const x of shop.tasks(J)) {
          const first = turnsOf(shop, (y) => y.kind === 'work' && y.taskId === x.id)[0];
          const model = agentOf(shop, first.agentId).model;
          if (want[x.domain]) assert.equal(model, want[x.domain], `${x.id} (${x.domain} ${x.size}) runs on ${want[x.domain]}`);
          assert.equal(model, shop.app.router.pick({ role: 'maker', domain: x.domain, size: x.size }).model, `${x.id}: the hire is the router's pick`);
        }
      },
    });
  });
});

// ------------------------------------------------------------------ 6. lab trouble mid-job

describe('two labs: lab trouble mid-job', () => {
  test('a lab-wide rate limit of one lab: its task holds, then moves to the other lab on the same bench with the work kept; new picks avoid the cooling lab, and use it again when it is back', T, async (t) => {
    const seen = []; // every first turn of a maker on a task: time, lab, bench, and the notes in the bench
    let cooled = null; // { at, until, task, cwd }
    await labsJob(t, {
      settings: { mockSpeed: 1 },
      decide: () => (c) => {
        if (c.kind === 'task' || c.kind === 'retry') {
          let notes = null;
          try { notes = fs.readFileSync(path.join(c.cwd, '.shop', 'NOTES.md'), 'utf8'); } catch { notes = null; }
          seen.push({ at: Date.now(), task: c.turn.task, provider: c.agent.provider, handle: c.agent.handle, cwd: c.cwd, notes, prompt: c.prompt });
        }
        if (!cooled && c.kind === 'task' && c.agent.provider === 'gemini' && c.agent.role === 'maker') {
          // Reset 4 s after the error: past holdFallbackMin (1.2 s), and before the last task (docs) is hired.
          cooled = { at: Date.now(), until: Date.now() + 4000, task: c.turn.task, cwd: c.cwd };
          return { act: [{ write: '.shop/NOTES.md', text: 'Work so far: the search module is half done.\n' }], then: 'end', error: 'rate_limit', resetAt: cooled.until };
        }
        return null;
      },
      check: (sh, J) => {
        assert.ok(cooled, 'a maker of the Google lab hit the rate limit');
        const held = sh.seen('tasks', (x) => x.id === cooled.task && x.hold);
        assert.ok(held.length > 0, `${cooled.task} was on hold`);
        assert.equal(held[0].hold.provider, 'gemini');
        assert.ok(sh.sse.some((e) => e.type === 'providers' && e.providers.some((p) => p.id === 'gemini' && p.cooling)), 'the whole lab cooled, not one model');
        assert.equal(sh.task(cooled.task).attempts, 0, 'a hold counts no attempt');
        const takeover = seen.find((s) => s.task === cooled.task && s.at > cooled.at);
        assert.ok(takeover, 'a maker took the task over');
        assert.equal(takeover.provider, 'claude', 'the task moved to the other lab');
        assert.equal(takeover.cwd, cooled.cwd, 'the same bench');
        assert.match(takeover.notes ?? '', /half done/, 'the bench kept the work of the first maker');
        assert.match(takeover.prompt, /take over this task/);
        const during = seen.filter((s) => s.at > cooled.at && s.at < cooled.until - 200);
        for (const s of during) assert.equal(s.provider, 'claude', `${s.task} started on the usable lab while the other cooled`);
        assert.equal(sh.app.providers.usable('gemini'), true, 'the lab is back');
        const after = sh.turns.filter((x) => x.startedAt > cooled.until && providerOf(sh, x.agentId) === 'gemini');
        assert.ok(after.length > 0, 'the lab that is back runs turns again');
        assert.ok(seen.some((s) => s.at > cooled.until && s.provider === 'gemini'), 'a new task went to the lab that is back');
        assert.equal(sh.job(J).hold, null);
      },
    });
  });
});

// ------------------------------------------------------------------ 7. hard kill during aux turns of the other lab

/** One two-lab restart: crash at `crash` in a child hub (twoLabRules), reboot here, finish, full check. */
async function twoLabRestart(t, crash, { runKind = crash.kind, rules = [], settings = {}, check } = {}) {
  const dirs = tempShop('ws-2lab-kill-');
  const base = twoLabs(dirs);
  setSettings(dirs, { ...base.settings, mockSpeed: 1, ...settings, limits: { holdFallbackMin: 0.02, ...(settings.limits ?? {}) } });
  let shop = null;
  cleanup(t, () => shop, dirs);
  const first = await crashRun(dirs, crash, {
    twoLabRules: rules,
    start: async (api) => {
      const r = await api('POST', '/api/jobs', { title: 'Two labs', brief: BRIEF, kind: 'build', project: { mode: 'new', name: 'two' }, crew: 'standard', budgetUsd: 1000, options: {} });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.id;
    },
  });
  const J = first.jobId;
  assert.ok(first.turns.some((x) => x.kind === runKind), `a ${runKind} turn started before the kill`);
  assert.ok(first.agentsAtKill > 0, `the ${runKind} turn was alive when the hub died`);
  setSettings(dirs, { ...base.settings, ...settings, mockSpeed: 0, limits: { holdFallbackMin: 0.02, ...(settings.limits ?? {}) } });
  const labs = twoLabs(dirs);
  shop = await bootShop({ dirs, app: labs.app });
  await waitReaped(dirs.tmp, first.orphans);
  try {
    await shipAndFinish(shop, J, { timeoutMs: LOADED });
    await settled(shop);
    await assertOnce(shop, J);
    // labs.calls holds every turn of the second hub, also those of its first tick inside createApp (before
    // bootShop records turns).
    if (check) await check(shop, J, { first, calls: labs.calls });
  } catch (err) {
    err.stack = `${err.stack}\n${trail(shop, J)}`;
    throw err;
  }
  await finishShop(shop, { keep });
}

describe('two labs: SIGKILL of the hub during a turn of the other lab, then a reboot', { concurrency: 3 }, () => {
  test('during a buddy turn', T, async (t) => {
    await twoLabRestart(t, { point: 'spawn', kind: 'review', buddy: true, afterMs: 400 }, {
      runKind: 'buddy', settings: { pairing: 'all' },
      check: (shop, J, { first }) => {
        // The buddy turn that died is skipped: the hand-in goes on to the review.
        const died = first.turns.find((x) => x.kind === 'buddy');
        const d = shop.deliveries(J).find((x) => x.taskId === died.taskId && x.status === 'shipped');
        assert.equal(d.review?.verdict, 'pass', `${died.taskId} passed its review after the reboot`);
      },
    });
  });

  test('during a consult turn', T, async (t) => {
    await twoLabRestart(t, { point: 'spawn', kind: 'consult', afterMs: 400 }, {
      rules: [{ kind: 'task', task: 'T2', act: [{ post: 'ASK @other {task}: Should the search ignore the case of the letters?' }], then: 'end' }],
      check: (shop, J, { calls }) => {
        const ask = shop.msgs(J).find((m) => m.kind === 'ASK' && m.to === '@other' && m.scope === 'T2');
        assert.ok(ask, 'the question is on the board');
        assert.notEqual(shop.app.board.get(ask.id).state, 'open', 'the question is closed');
        assert.equal(shop.task('T2').consult ?? null, null, 'no consult is left');
        assert.ok(calls.some((c) => c.kind === 'consult'), 'the consult ran again after the reboot');
      },
    });
  });

  test('during the ledger audit turn', T, async (t) => {
    await twoLabRestart(t, { point: 'spawn', kind: 'audit', afterMs: 400 }, {
      check: (shop, J, { calls }) => {
        assert.equal(shop.job(J).auditDone, true, 'the audit is done');
        assert.ok(calls.some((c) => c.kind === 'audit'), 'the audit ran again after the reboot');
      },
    });
  });
});

// ------------------------------------------------------------------ 8. presence away

describe('two labs: presence away', () => {
  test('a boss question to the owner takes its default at once; the assumption is recorded and the other boss sees it', T, async (t) => {
    let ask = null;
    const bossTurns = []; // every boss turn as it spawns: its prompt and the blueprint on its desk
    await labsJob(t, {
      crew: { bosses: 2, managers: 1, makers: 3 }, brief: `${BRIEF} [mock:human]`,
      settings: { presence: 'away' },
      decide: () => (c) => {
        if (c.agent?.role === 'boss') {
          let blueprint = '';
          try { blueprint = fs.readFileSync(path.join(c.cwd, '.shop', 'BLUEPRINT.md'), 'utf8'); } catch { blueprint = ''; }
          bossTurns.push({ id: c.agent.id, kind: c.kind, at: Date.now(), prompt: c.prompt, blueprint });
        }
        return null;
      },
      during: async (shop, J) => {
        ask = await shop.waitFor(() => shop.msgs(J).find((m) => m.kind === 'ASK' && m.to === '@human'), { what: 'a question to the owner', jobId: J, timeoutMs: 60_000 });
        const ans = await shop.waitFor(() => shop.msgs(J).find((m) => m.kind === 'ANS' && m.re === ask.id), { what: 'the default answer', jobId: J, timeoutMs: 10_000 });
        assert.ok(ans.ts - ask.ts < 5000, `the default came at once (${ans.ts - ask.ts} ms)`);
        const inbox = await shop.api('GET', `/api/inbox?job=${J}`);
        const item = inbox.body.find((i) => i.kind === 'question' && i.id === ask.id);
        assert.ok(item?.defaulted, 'the question stays pinned in the inbox with the default taken');
      },
      check: (shop, J) => {
        const job = shop.job(J);
        const ans = shop.msgs(J).find((m) => m.kind === 'ANS' && m.re === ask.id);
        assert.equal(ans.from, '@hub');
        assert.match(ans.body, /Default taken: the owner is away/);
        const a = job.assumptions.find((x) => x.msgId === ask.id);
        assert.ok(a, 'the assumption is recorded');
        assert.match(a.text, /Default A/);
        const bosses = shop.agents(J).filter((x) => x.role === 'boss');
        assert.deepEqual([...new Set(bosses.map((b) => b.provider))].sort(), ['claude', 'gemini'], 'one boss per lab');
        const asker = bosses.find((b) => b.handle === ask.from);
        const other = bosses.find((b) => b.id !== asker.id);
        // The asker is woken with the answer. The other boss (the other lab) is told in its next turn: the board
        // view shows the default (the audit of a non-lead boss), or the blueprint on its desk lists the assumption
        // (the merge turn of the lead: the default reply to another boss is not in the lead's board view).
        const shows = (x) => x.prompt.includes(`re:${ask.id}`) && x.prompt.includes('Default taken');
        assert.ok(shop.turns.some((x) => x.agentId === asker.id && x.startedAt >= ans.ts && shows(x)), `${asker.handle} was woken with the default`);
        // The next turn whose prompt the hub built after the default (shop.turns records the turn start).
        const next = shop.turns.find((x) => x.agentId === other.id && x.startedAt > ans.ts);
        const blueprint = bossTurns.find((x) => x.prompt === next?.prompt)?.blueprint ?? '';
        assert.ok(next && (shows(next) || blueprint.includes(a.text)), `${other.handle} was told of the default in its next turn (${next?.kind}: ${next?.prompt.slice(0, 80)} | ${blueprint.slice(0, 600)})`);
        assert.match(job.report, /Plain text lines/, 'the report lists the assumption');
      },
    });
  });
});
