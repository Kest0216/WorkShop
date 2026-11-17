// Plan validation (every rule of section 12) and the planning flow: drafts, merge with covers / dropped,
// the baseline gate, apply, the plan notice and the ledger audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../../server/orchestrator.js';
import { makeShop, ownerGit, samplePlan } from './harness.mjs';

const task = (key, extra = {}) => ({ key, title: `T ${key}`, spec: 'Do it.', acceptance: ['It works.'], zones: [`${key}/**`], domain: 'backend', size: 'S', reqs: [1], ...extra });
const plan = (extra = {}) => ({ requirements: [{ text: 'It works.' }], tasks: [task('a')], check_cmd: 'npm test', ...extra });
const errs = (p, opts = { kind: 'build', maxTasks: 40 }) => {
  const r = validatePlan(p, opts);
  return r.ok ? [] : r.errors.join('\n');
};

test('a valid plan passes and is normalized', () => {
  const r = validatePlan(plan({ tasks: [task('a', { deps: [], pair: true, stream: 'web' })] }), { kind: 'build', maxTasks: 40 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan.tasks[0].pair, true);
  assert.equal(r.plan.tasks[0].stream, 'web');
  assert.equal(r.plan.check_cmd, 'npm test');
});

test('requirements: 1 to 30, each with text', () => {
  assert.match(errs(plan({ requirements: [] })), /1 to 30 requirements/);
  assert.match(errs(plan({ requirements: Array.from({ length: 31 }, () => ({ text: 'x' })) })), /1 to 30/);
  assert.match(errs(plan({ requirements: [{ text: ' ' }] })), /text is empty/);
});

test('tasks: 1 to maxTasks, unique keys', () => {
  assert.match(errs(plan({ tasks: [] })), /1 to 40 tasks/);
  assert.match(errs(plan({ tasks: [task('a'), task('b')] }), { kind: 'build', maxTasks: 1 }), /1 to 1 tasks/);
  assert.match(errs(plan({ tasks: [task('a'), task('a', { zones: ['z/**'] })] })), /key is used twice/);
});

test('deps exist and are acyclic', () => {
  assert.match(errs(plan({ tasks: [task('a', { deps: ['nope'] })] })), /dep nope is not a task key/);
  assert.match(errs(plan({ tasks: [task('a', { deps: ['b'] }), task('b', { deps: ['a'] })] })), /cycle/);
  assert.match(errs(plan({ tasks: [task('a', { deps: ['a'] })] })), /cannot depend on itself/);
});

test('every task has title, spec, 1-8 acceptance items, zones, a known domain and size', () => {
  assert.match(errs(plan({ tasks: [task('a', { title: '' })] })), /title is empty/);
  assert.match(errs(plan({ tasks: [task('a', { spec: '' })] })), /spec is empty/);
  assert.match(errs(plan({ tasks: [task('a', { acceptance: [] })] })), /1 to 8 acceptance/);
  assert.match(errs(plan({ tasks: [task('a', { acceptance: Array(9).fill('x') })] })), /1 to 8 acceptance/);
  assert.match(errs(plan({ tasks: [task('a', { zones: [] })] })), /at least one zone/);
  assert.match(errs(plan({ tasks: [task('a', { domain: 'cooking' })] })), /domain must be/);
  assert.match(errs(plan({ tasks: [task('a', { size: 'XL' })] })), /size must be/);
});

test('zones under HUB_PATHS and outside the project are refused', () => {
  for (const z of ['.shop/x', '.shop', '.agents/**', '.agents/hooks.json', '/etc/passwd', '../up/**']) {
    assert.match(errs(plan({ tasks: [task('a', { zones: [z] })] })), /zone/, z);
  }
});

test('every requirement is served by a task, and reqs name real requirements', () => {
  assert.match(errs(plan({ requirements: [{ text: 'a' }, { text: 'b' }] })), /requirement 2 is served by no task/);
  assert.match(errs(plan({ tasks: [task('a', { reqs: [1, 5] })] })), /reqs has 5/);
});

test('overlapping zones must be ordered by a dependency, direct or transitive', () => {
  const p = (tasks) => plan({ tasks });
  assert.match(errs(p([task('a', { zones: ['src/**'] }), task('b', { zones: ['src/b.js'] })])), /share zones/);
  assert.deepEqual(errs(p([task('a', { zones: ['src/**'] }), task('b', { zones: ['src/b.js'], deps: ['a'] })])), []);
  assert.deepEqual(errs(p([task('a', { zones: ['src/**'] }), task('m', { deps: ['a'] }), task('b', { zones: ['src/b.js'], deps: ['m'] })])), []);
});

test('check_cmd is required for build and fix unless no_check_reason; research may skip it', () => {
  assert.match(errs(plan({ check_cmd: '' })), /check_cmd is empty/);
  assert.match(errs(plan({ check_cmd: '' }), { kind: 'fix', maxTasks: 40 }), /check_cmd is empty/);
  assert.deepEqual(errs(plan({ check_cmd: '', no_check_reason: 'Docs only.' })), []);
  assert.deepEqual(errs(plan({ check_cmd: '' }), { kind: 'research', maxTasks: 40 }), []);
});

test('merge mode: every draft requirement is in covers or dropped', () => {
  const drafts = [
    { handle: '@b1', plan: { requirements: [{ text: 'a' }, { text: 'b' }] } },
    { handle: '@b2', plan: { requirements: [{ text: 'a' }] } },
  ];
  const opts = { kind: 'build', maxTasks: 40, drafts };
  assert.match(errs(plan(), opts), /neither covers nor dropped: @b1 #1, @b1 #2, @b2 #1/);
  assert.match(errs(plan({ covers: [{ draft: '@b1', n: 1, req: 1 }, { draft: '@b2', n: 1, req: 1 }] }), opts), /@b1 #2/);
  assert.deepEqual(errs(plan({ covers: [{ draft: '@b1', n: 1, req: 1 }, { draft: '@b2', n: 1, req: 1 }], dropped: [{ draft: '@b1', n: 2, why: 'Out of scope.' }] }), opts), []);
  assert.match(errs(plan({ covers: [{ draft: '@b9', n: 1, req: 1 }] }), opts), /@b9 is not a draft/);
  assert.match(errs(plan({ covers: [{ draft: '@b1', n: 1, req: 7 }] }), opts), /req 7 is not a requirement/);
  assert.match(errs(plan({ dropped: [{ draft: '@b1', n: 1, why: '' }] }), opts), /needs a why/);
});

test('two bosses draft, the lead merges with covers, the plan notice lists the ledger', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 2 }) });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 2, managers: 0, makers: 2 } });
  const plans = h.turns('plan');
  assert.equal(plans.filter((x) => /PLAN work order/.test(x.prompt)).length, 2);
  const merge = plans.find((x) => /MERGE THE PLANS/.test(x.prompt));
  assert.ok(merge, 'the lead got a merge turn');
  assert.equal(merge.handle, '@b1');
  const job = h.job();
  assert.equal(job.planDrafts, null);
  assert.equal(job.requirements.length, 2);
  assert.ok(['running', 'qa', 'delivering'].includes(job.status), job.status);
  const notice = h.notices.find((n) => /Plan for J1/.test(n.text));
  assert.ok(notice && /R1:/.test(notice.text) && /Check: test ! -e BROKEN/.test(notice.text) && /Assumptions:/.test(notice.text));
});

test('a merge without covers is refused as the tool result and fixed in the same turn', async (t) => {
  let refused = null;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      plan: async (turn, hh) => {
        if (!/MERGE THE PLANS/.test(turn.prompt)) return undefined;
        refused = await turn.call('plan_submit', samplePlan({ n: 1 }));
        await turn.call('plan_submit', { ...samplePlan({ n: 1 }), covers: [{ draft: '@b1', n: 1, req: 1 }], dropped: [{ draft: '@b2', n: 1, why: 'Same as @b1 #1.' }] });
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 2, managers: 0, makers: 1 } });
  assert.match(refused, /ERR plan_submit refused/);
  assert.match(refused, /neither covers nor dropped/);
  assert.deepEqual(h.job().dropped, [{ draft: '@b2', n: 1, why: 'Same as @b1 #1.' }]);
});

test('a draft turn with no plan_submit is nudged once, then dropped; no draft at all pauses the job', async (t) => {
  const h = await makeShop({ brainHooks: { plan: async () => ({}) } });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 0, makers: 1 } });
  const plans = h.turns('plan');
  assert.equal(plans.length, 2);
  assert.equal(plans[1].resume, true);
  assert.match(plans[1].prompt, /without calling plan_submit/);
  const job = h.job();
  assert.equal(job.status, 'paused');
  assert.equal(job.pauseReason, 'error');
});

test('approvePlan: the job waits in plan_review until the owner approves', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }) });
  t.after(() => h.close());
  await h.start({ options: { approvePlan: true } });
  assert.equal(h.job().status, 'plan_review');
  assert.ok(h.orch.inbox('J1').some((i) => i.kind === 'plan'));
  assert.ok(h.tasks().every((x) => x.status === 'planned'));
  h.orch.approvePlan('J1');
  await h.settle();
  assert.equal(h.job().status, 'delivering');
});

async function existingRepo(h, files) {
  const dir = `${h.root}/owner-repo`;
  ownerGit(h.root, h.env, 'init', '-q', '--initial-branch=main', dir);
  for (const [rel, text] of Object.entries(files)) h.write(dir, rel, text);
  ownerGit(dir, h.env, 'add', '-A');
  ownerGit(dir, h.env, 'commit', '-q', '-m', 'seed');
  return dir;
}

test('baseline gate: a red check on the existing project resumes the lead once, then pauses (baseline)', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1, check: 'test -e GREEN' }) });
  t.after(() => h.close());
  const dir = await existingRepo(h, { 'README.md': 'hi\n' });
  await h.start({ project: { mode: 'existing', path: dir } });
  const plans = h.turns('plan');
  assert.equal(plans.length, 2);
  assert.match(plans[1].prompt, /CHECK FAILED/);
  assert.match(plans[1].prompt, /before any change/);
  const job = h.job();
  assert.equal(job.status, 'paused');
  assert.equal(job.pauseReason, 'baseline');
  const project = h.store.get('projects', job.projectId);
  assert.equal(project.baseline.ok, false);
  assert.equal(h.tasks().length, 0, 'the plan is not applied');
});

test('baseline gate: a green check twice applies the plan', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1, check: 'test -e README.md' }) });
  t.after(() => h.close());
  const dir = await existingRepo(h, { 'README.md': 'hi\n' });
  await h.start({ project: { mode: 'existing', path: dir } });
  const job = h.job();
  assert.equal(h.store.get('projects', job.projectId).baseline.ok, true);
  assert.equal(job.status, 'delivering');
});

test('pairing rule and decider only raise care', async (t) => {
  const decider = { enabled: () => true, sizeTask: async ({ title }) => (title === 'Module 1' ? { size: 'L', sensitive: false } : title === 'Module 2' ? { size: 'S', sensitive: true } : { size: 'S' }) };
  const h = await makeShop({ decider, settings: { pairing: 'costly' }, planFor: () => samplePlan({ n: 3 }) });
  t.after(() => h.close());
  h.orch.createJob({ title: 'x', brief: 'y', kind: 'build', project: { mode: 'new', name: 'p' }, crew: { bosses: 1, managers: 0, makers: 1 }, options: { approvePlan: true } });
  await h.orch.recover();
  await h.settle();
  const [a, b, c] = h.tasks();
  assert.equal(a.size, 'L');
  assert.equal(b.size, 'S');
  assert.equal(b.pair, true);
  assert.equal(c.pair, false);
});
