// Scenarios: restarts and holds (contract sections 3b, 7, 9, 10, 12). The REAL hub on temp folders, the mock lab
// only. No real AI CLI runs.
//
// Restarts: the first hub is the real entry point in a child process (tests/scenarios/crash-hub.mjs). It kills
// itself with SIGKILL at one exact point of a mock job: no graceful stop, no store flush, its agent processes stay
// alive as orphans. A second hub (createApp in this process) boots on the same folders. The job must finish with
// the same result and no double work: every task merged once, one shipped crate per task, one merge commit per
// task, no DONE lost or left open, every requirement verified, the check green on the shipped branch, and the
// orphans of the dead hub reaped.
//
// Holds: lab trouble injected through a patched mock adapter passed to createApp (adapters option): a turn of the
// chosen kind gets a TurnResult error (rate_limit, auth, model, mcp) from a fake agent process, or hangs (idle,
// timeout). The real runner, providers registry and orchestrator handle it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BRIEF, bootShop, git, shipAndFinish, startJob, tempShop } from '../e2e-harness.mjs';
import { assertOnce, crashRun, existingRepo, faultyMock, finishShop, setSettings, startMockJob, twoLabs, waitReaped } from './harness.mjs';

const T = { timeout: 600_000 };
// Waits are for a state, with long caps: on a machine that runs other suites a job is slow, not stuck.
const LOADED = 330_000;
const settled = async (shop) => assert.equal(await shop.app.orch.settle({ timeoutMs: 120_000 }), true, 'the hub settled');

/** git as the owner in the project repo (temp HOME, no global config). */
function ownerGit(repo, dirs, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dirs.tmp, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}
const keep = process.env.KEEP_E2E === '1';

function cleanup(t, getShop, dirs) {
  t.after(async () => {
    await getShop()?.close().catch(() => {});
    if (!keep) fs.rmSync(dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
  });
}

/**
 * One restart scenario: crash at `crash`, reboot, finish (ship the shown head), check the result.
 * opts: { start, settings (first hub), before(shop) after the reboot, ship:false to let `after` ship }
 */
async function restartScenario(t, crash, opts = {}) {
  const dirs = tempShop('ws-scn-');
  setSettings(dirs, opts.settings ?? {});
  let shop = null;
  cleanup(t, () => shop, dirs);
  const first = await crashRun(dirs, crash, { start: opts.start ?? startMockJob(opts.job) });
  const J = first.jobId;
  const disk = JSON.parse(fs.readFileSync(`${dirs.dataDir}/state.json`, 'utf8'));
  // The second hub runs at full speed.
  setSettings(dirs, { ...(opts.settings ?? {}), mockSpeed: 0 });
  shop = await bootShop({ dirs });
  await waitReaped(dirs.tmp, first.orphans);
  if (opts.afterBoot) await opts.afterBoot(shop, J, { first, disk });
  if (opts.ship !== false) await shipAndFinish(shop, J, { timeoutMs: LOADED });
  else await shop.waitFor(() => shop.job(J).status === 'done', { what: `${J} done`, jobId: J, timeoutMs: LOADED });
  await settled(shop);
  await assertOnce(shop, J);
  if (opts.check) await opts.check(shop, J, { first, disk });
  await finishShop(shop, { keep, allowErrors: opts.allowErrors === true });
  return { first, disk, shop };
}

/** Start a mock job, wait for delivering with a report, and ask for the ship of the shown head (no answer waited). */
async function deliverAndShip(api) {
  const J = await startMockJob()(api);
  for (;;) {
    const j = (await api('GET', '/api/state')).body.state.jobs[J];
    if (j?.status === 'delivering' && j.report) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const truck = await api('GET', `/api/jobs/${J}/truck`);
  api('POST', `/api/jobs/${J}/ship`, { sha: truck.body.headSha }).catch(() => {});
  return J;
}

describe('restarts: SIGKILL of the hub at each stage of a mock job, then a reboot', { concurrency: 3 }, () => {
  test('during a plan draft turn', T, async (t) => {
    // spawned: kill 250 ms after the agent process runs (not after the turn start: on a loaded machine the spawn
    // alone can take longer, and then no plan turn was alive at the kill).
    const { first } = await restartScenario(t, { point: 'turn', kind: 'plan', spawned: 1, afterMs: 250 }, { settings: { mockSpeed: 1 } });
    assert.ok(first.agentsAtKill > 0, 'the plan turn was alive when the hub died');
  });

  test('during intake, right after the integration branch was made (state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'git', fn: 'startJob', when: 'after' });
  });

  test('during the plan merge turn (three bosses)', T, async (t) => {
    const { first } = await restartScenario(t, { point: 'turn', kind: 'plan', promptHas: 'MERGE THE PLANS', afterMs: 250 }, { settings: { mockSpeed: 1 }, job: { crew: 'full' } });
    assert.ok(first.turns.some((x) => /MERGE THE PLANS/.test(x.head)), 'the merge turn started before the crash');
  });

  test('right after plan_submit stored the final plan (before apply, state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'store', kind: 'jobs', match: { 'planDrafts.final': '*' } });
  });

  test('during the baseline gate of an existing project', T, async (t) => {
    let repo = null;
    await restartScenario(t, { point: 'git', fn: 'headCheck', when: 'before', afterMs: 60 }, {
      check: (shop) => assert.equal(shop.project('J1').baseline?.ok, true, 'the baseline ran again and is green'),
      start: async (api, dirs) => {
        repo = existingRepo(dirs);
        return startMockJob({ project: { mode: 'existing', path: repo } })(api);
      },
    });
  });

  test('with two makers mid-turn', T, async (t) => {
    const { first } = await restartScenario(t, { point: 'turn', kind: 'work', count: 2, spawned: 2, afterMs: 300 }, { settings: { mockSpeed: 1 } });
    assert.ok(first.agentsAtKill >= 2, 'two agent processes were alive when the hub died');
  });

  test('with a hand-in pipeline running (mid check)', T, async (t) => {
    await restartScenario(t, { point: 'git', fn: 'runCheck', when: 'before', afterMs: 80 });
  });

  test('right after a DONE was accepted (board written, state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'post', kind: 'DONE' });
  });

  test('after the hub refused a hand-in with FIX (board written, state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'post', kind: 'FIX', from: '@hub' }, {
      job: { brief: `${BRIEF} [mock:checkfail]` },
      check: (shop) => assert.ok(shop.logs.some((l) => /refused hand-in of before the restart/.test(l.msg)), 'the lost refusal took effect at boot'),
    });
  });

  test('during a review turn', T, async (t) => {
    await restartScenario(t, { point: 'turn', kind: 'review', afterMs: 250 }, { settings: { mockSpeed: 1 } });
  });

  test('right after the reviewer posted PASS (board written, state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'post', kind: 'PASS' }, {
      check: (shop) => assert.ok(shop.logs.some((l) => /verdict of before the restart/.test(l.msg)), 'the lost PASS took effect at boot'),
    });
  });

  test('right after a reviewer FIX (board written, state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'post', kind: 'FIX', notFrom: '@hub' }, {
      job: { brief: `${BRIEF} [mock:reject]` },
      check: (shop) => assert.ok(shop.logs.some((l) => /verdict of before the restart/.test(l.msg)), 'the lost FIX took effect at boot'),
    });
  });

  test('right after git.integrate merged (git moved, state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'git', fn: 'integrate', when: 'after' }, {
      check: (shop) => {
        assert.equal(shop.job('J1').pauseReason ?? null, null, 'no false tamper pause');
        assert.ok(shop.logs.some((l) => /recorded a merge the hub made/.test(l.msg)), 'the merge of the dead hub is recorded');
      },
    });
  });

  test('right after a truck refresh moved the integration branch (the owner committed to main; state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'git', fn: 'refreshTruck', when: 'after' }, {
      check: (shop) => {
        const project = shop.project('J1');
        assert.match(git(project.path, 'show', `${project.targetBranch}:OWNER.md`), /owner wrote this/, 'the owner commit is still on the target branch');
        assert.equal(shop.job('J1').pauseReason ?? null, null);
        assert.ok(shop.logs.some((l) => /recorded a truck refresh/.test(l.msg)), 'the refresh of the dead hub is recorded');
      },
      start: async (api, dirs) => {
        const J = await startMockJob()(api);
        // The owner commits to the target branch while the job runs: the truck refreshes at the entry to QA.
        for (;;) {
          const st = (await api('GET', '/api/state')).body.state;
          if (Object.values(st.deliveries).some((d) => d.status === 'loaded')) {
            const repo = st.projects[st.jobs[J].projectId].path;
            fs.writeFileSync(`${repo}/OWNER.md`, 'The owner wrote this while the job ran.\n');
            ownerGit(repo, dirs, 'add', 'OWNER.md');
            ownerGit(repo, dirs, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'Owner note');
            return J;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    });
  });

  test('right after a truck refresh during the QA turn (the owner committed and asked to ship; state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'git', fn: 'refreshTruck', when: 'after' }, {
      settings: { mockSpeed: 2 },
      check: (shop, J, { disk }) => {
        assert.equal(disk.jobs[J].status, 'qa', 'the hub died in qa');
        assert.ok(disk.jobs[J].refreshing, 'the refresh intent was on disk');
        const job = shop.job(J);
        assert.equal(job.pauseReason ?? null, null);
        assert.ok(shop.logs.some((l) => /recorded a truck refresh/.test(l.msg)), 'the refresh of the dead hub is recorded');
        // QA verified the tree that shipped, not the tree from before the refresh.
        assert.equal(job.qa.sha, job.intSha, 'the QA round ran on the shipped head');
        const project = shop.project(J);
        assert.equal(project.headCheck?.sha, job.intSha, 'the head check ran on the shipped head');
        assert.ok(shop.turns.some((x) => x.kind === 'qa'), 'a new QA turn ran after the reboot');
      },
      start: async (api, dirs) => {
        const J = await startMockJob()(api);
        // Wait for a running QA turn, then the owner commits on main and asks to ship: the truck refreshes.
        for (;;) {
          const st = (await api('GET', '/api/state')).body.state;
          const j = st.jobs[J];
          if (j?.status === 'qa' && j.qa?.step === 'turn' && st.agents[j.qa.agentId]?.status === 'reviewing') {
            const repo = st.projects[j.projectId].path;
            fs.writeFileSync(`${repo}/OWNER.md`, 'The owner wrote this during QA.\n');
            ownerGit(repo, dirs, 'add', 'OWNER.md');
            ownerGit(repo, dirs, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'Owner note');
            const truck = await api('GET', `/api/jobs/${J}/truck`);
            api('POST', `/api/jobs/${J}/ship`, { sha: truck.body.headSha }).catch(() => {});
            return J;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    });
  });

  test('during the QA turn', T, async (t) => {
    await restartScenario(t, { point: 'turn', kind: 'qa', afterMs: 250 }, { settings: { mockSpeed: 1 } });
  });

  test('right when the job enters delivering (state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'store', kind: 'jobs', match: { status: 'delivering' } });
  });

  test('in delivering, during the report turn', T, async (t) => {
    await restartScenario(t, { point: 'turn', kind: 'report', afterMs: 250 }, { settings: { mockSpeed: 1 } });
  });

  test('with a loaded truck, right after git.ship moved the target branch (state not saved)', T, async (t) => {
    await restartScenario(t, { point: 'git', fn: 'ship', when: 'after' }, { start: deliverAndShip });
  });

  test('right when the shipped job turns done (state not saved, cleanup not run)', T, async (t) => {
    await restartScenario(t, { point: 'store', kind: 'jobs', match: { status: 'done' } }, {
      start: deliverAndShip, ship: false,
      check: (shop) => assert.equal(fs.existsSync(`${shop.app.paths.work}/J1/_int`), false, 'the work folders are removed after the restart'),
    });
  });

  test('while a task waits on a claim held by another task', T, async (t) => {
    // afterMs 0: the hub dies at once, so the claim wait (and maybe the bench start) is not on disk. The reboot
    // starts the task again with a fresh session; the mock agent keeps its task memory per session, so it works
    // from the card like a real CLI and does not act on a claim the hub never stored.
    await restartScenario(t, { point: 'store', kind: 'tasks', match: { status: 'blocked', why: 'claim' }, afterMs: 0 }, {
      job: { brief: `${BRIEF} [mock:claim]` },
    });
  });
});

// ------------------------------------------------------------------ holds and lab trouble

/**
 * One lab-trouble scenario on the real hub (in this process) with a patched mock adapter.
 * decide: see faultyMock. opts: { settings, job (startJob options), check(shop, J, calls), ship }
 */
async function holdScenario(t, decide, opts = {}) {
  const dirs = tempShop('ws-hold-');
  setSettings(dirs, opts.settings ?? {});
  let shop = null;
  cleanup(t, () => shop, dirs);
  const fm = faultyMock(dirs, decide);
  shop = await bootShop({ dirs, app: { adapters: { mock: fm.adapter }, shellEnv: fm.shellEnv } });
  const J = (await startJob(shop, opts.job ?? {})).id;
  if (opts.during) await opts.during(shop, J, fm.calls);
  await shipAndFinish(shop, J, { timeoutMs: LOADED });
  await settled(shop);
  await assertOnce(shop, J);
  if (opts.check) await opts.check(shop, J, fm.calls);
  await finishShop(shop, { keep, allowErrors: opts.allowErrors === true });
}

const taskHolds = (shop) => shop.seen('tasks', (x) => x.hold?.reason === 'lab');
const agentHolds = (shop) => shop.seen('agents', (x) => x.hold?.reason === 'lab');
const once = (pred) => { let done = false; return (c) => (!done && pred(c) ? ((done = true), true) : false); };

describe('holds: lab trouble on the real hub (patched mock adapter)', { concurrency: 3 }, () => {
  test('a rate limit of the maker model mid-job: the task waits on hold (no attempt, no nudge) and the same maker goes on when the model is back', T, async (t) => {
    const first = once((c) => c.kind === 'task');
    await holdScenario(t, (c) => (first(c) ? { error: 'rate_limit', model: c.agent.model, resetAt: Date.now() + 1500 } : null), {
      check: (shop, J, calls) => {
        const held = taskHolds(shop);
        assert.ok(held.length > 0, 'the task was on hold');
        const h = held[0];
        assert.deepEqual([h.hold.provider, h.hold.model, typeof h.hold.until], ['mock', 'mock-maker', 'number']);
        assert.equal(h.attempts, 0, 'a hold counts no attempt');
        const task = shop.task(h.id);
        assert.equal(task.hold, null);
        assert.equal(task.nudges ?? 0, 0, 'a held task is not nudged');
        assert.ok(shop.sse.some((e) => e.type === 'providers' && e.providers.some((p) => p.id === 'mock' && p.cooledModels?.['mock-maker'])), 'the model cooled');
        // The model alone cooled: the lab stayed usable, so the job shows no lab hold.
        assert.equal(shop.seen('jobs', (j) => j.id === J && j.hold).length, 0);
        // The same maker took the task up again after the hold.
        const after = shop.turns.filter((x) => x.taskId === h.id && x.kind === 'work');
        assert.ok(after.length >= 2);
        assert.equal(new Set(after.map((x) => x.agentId)).size, 1, 'no other maker took the task');
      },
    });
  });

  test('a rate limit of the whole lab: no usable lab, so the job shows job.hold with one owner notice; it is released when the lab is back', T, async (t) => {
    const first = once((c) => c.kind === 'task');
    await holdScenario(t, (c) => (first(c) ? { error: 'rate_limit', resetAt: Date.now() + 1500 } : null), {
      check: (shop, J) => {
        const jh = shop.seen('jobs', (j) => j.id === J && j.hold);
        assert.ok(jh.length > 0, 'job.hold was set');
        assert.equal(jh[0].hold.reason, 'lab');
        assert.equal(jh[0].hold.lab, 'mock');
        assert.equal(typeof jh[0].hold.until, 'number', 'the hold shows the release time');
        assert.equal(shop.notices().filter((n) => /no lab can run now/.test(n.text)).length, 1, 'one owner notice');
        assert.equal(shop.job(J).hold, null, 'the job hold is cleared');
        assert.equal(shop.job(J).pauseReason ?? null, null, 'no stall pause while the hold had a release time');
      },
    });
  });

  test('a sign-in error in a review turn: the review waits on hold and runs again; it is not a no-show', T, async (t) => {
    const first = once((c) => c.kind === 'review');
    await holdScenario(t, (c) => (first(c) ? { error: 'auth' } : null), {
      check: (shop, J) => {
        const held = taskHolds(shop).filter((x) => x.status === 'review');
        assert.ok(held.length > 0, 'the task in review was on hold');
        const d = shop.deliveries(J).find((x) => x.taskId === held[0].id && x.status === 'shipped');
        assert.equal((d.reviewers ?? []).length, 1, 'the same reviewer, no second one');
        assert.notEqual(d.reviewNudged, true, 'no nudge for a held review');
      },
    });
  });

  test('a rate limit in the plan turn of the boss: the agent waits on hold, then plans', T, async (t) => {
    const first = once((c) => c.kind === 'plan');
    await holdScenario(t, (c) => (first(c) ? { error: 'rate_limit', model: c.agent.model, resetAt: Date.now() + 1000 } : null), {
      check: (shop) => {
        const held = agentHolds(shop);
        assert.ok(held.some((a) => a.role === 'boss'), 'the boss was on hold');
        assert.equal(shop.turns.filter((x) => x.kind === 'plan').length, 2, 'the plan turn ran again once');
      },
    });
  });

  test('a rate limit in the QA turn: the QA agent waits on hold, then verifies', T, async (t) => {
    const first = once((c) => c.kind === 'qa');
    await holdScenario(t, (c) => (first(c) ? { error: 'rate_limit', model: c.agent.model, resetAt: Date.now() + 1000 } : null), {
      check: (shop, J) => {
        assert.ok(agentHolds(shop).length > 0, 'the QA agent was on hold');
        assert.equal(shop.job(J).qa.round, 1, 'one QA round: the hold was not a failed round');
      },
    });
  });

  test('a model error in a work turn: one retry, then the work goes on', T, async (t) => {
    const first = once((c) => c.kind === 'task');
    await holdScenario(t, (c) => (first(c) ? { error: 'model' } : null), {
      check: (shop, J, calls) => {
        const failed = shop.turns.find((x) => x.kind === 'work' && x.error?.kind === 'model');
        assert.ok(failed, 'a work turn failed with a model error');
        const next = shop.turns.find((x) => x.taskId === failed.taskId && x.startedAt > failed.startedAt);
        assert.match(next.prompt, /ended with an error/, 'the retry says why');
        assert.equal(taskHolds(shop).length, 0, 'a model error is not a hold');
      },
    });
  });

  test('two model errors in a row on one task: the task is blocked (error), the manager retries it, the job finishes', T, async (t) => {
    let task = null;
    let maker = null;
    let n = 0;
    await holdScenario(t, (c) => {
      if (c.agent?.role !== 'maker' || c.kind === 'review') return null;
      if (!maker) { maker = c.agent.id; task = c.agent.taskId; }
      return c.agent.id === maker && ++n <= 2 ? { error: 'model' } : null;
    }, {
      check: (shop) => {
        assert.ok(shop.seen('tasks', (x) => x.id === task && x.status === 'blocked' && x.why === 'error').length > 0, `${task} was blocked with why error`);
        assert.ok(shop.turns.some((x) => x.taskId === task && /RETRY of/.test(x.prompt)), 'a retry turn ran');
      },
    });
  });

  test('an MCP error once: the turn runs again with no penalty; twice: an owner notice', T, async (t) => {
    let maker = null;
    let n = 0;
    await holdScenario(t, (c) => {
      if (c.agent?.role !== 'maker' || c.kind === 'review') return null;
      maker ??= c.agent.id;
      return c.agent.id === maker && ++n <= 2 ? { error: 'mcp' } : null;
    }, {
      check: (shop) => {
        const mcp = shop.turns.filter((x) => x.error?.kind === 'mcp');
        assert.equal(mcp.length, 2, 'two MCP failures');
        assert.equal(new Set(mcp.map((x) => x.agentId)).size, 1);
        assert.equal(shop.notices().filter((x) => /cannot reach the hub tools/.test(x.text)).length, 1, 'one owner notice after the second');
      },
    });
  });

  test('an idle work turn: the idle watchdog stops it, one resume with a note, then the work goes on', T, async (t) => {
    const first = once((c) => c.kind === 'task');
    await holdScenario(t, (c) => (first(c) ? { hang: 'idle' } : null), {
      settings: { limits: { idleTimeoutMin: 0.03 } },
      check: (shop) => {
        const idle = shop.turns.find((x) => x.killed === 'idle');
        assert.ok(idle, 'a turn was stopped as idle');
        const next = shop.turns.find((x) => x.taskId === idle.taskId && x.startedAt > idle.startedAt);
        assert.match(next.prompt, /ran out of time/, 'the resume carries the timeout note');
      },
    });
  });

  test('a work turn over its time limit: the wall clock stops it, one resume with a note, then the work goes on', T, async (t) => {
    const first = once((c) => c.kind === 'task');
    await holdScenario(t, (c) => (first(c) ? { hang: 'busy' } : null), {
      settings: { limits: { taskTimeoutMin: { S: 0.04, M: 0.04, L: 0.04 } } },
      check: (shop) => {
        const late = shop.turns.find((x) => x.killed === 'timeout');
        assert.ok(late, 'a turn was stopped by its time limit');
        const next = shop.turns.find((x) => x.taskId === late.taskId && x.startedAt > late.startedAt);
        assert.match(next.prompt, /ran out of time/);
      },
    });
  });

  test('every review turn of a task fails and the crew has one boss: the delivery waits for the owner, whose PASS lands it', T, async (t) => {
    let target = null;
    await holdScenario(t, (c) => {
      const m = /^REVIEW (T\d+)/m.exec(c.prompt);
      if (c.kind !== 'review' || !m) return null;
      target ??= m[1];
      return m[1] === target ? { error: 'other', message: 'the reviewer crashed' } : null;
    }, {
      during: async (shop, J) => {
        const d = await shop.waitFor(() => shop.deliveries(J).find((x) => x.waitHuman), { what: 'a delivery that waits for the owner', jobId: J, timeoutMs: 120_000 });
        assert.ok(shop.notices().some((n) => new RegExp(`${d.taskId} has no reviewer verdict`).test(n.text)), 'the owner is told');
        const inbox = await shop.api('GET', `/api/inbox?job=${J}`);
        assert.ok(inbox.body.some((i) => i.kind === 'review' && i.id === d.id), 'the inbox offers the verdict');
        const r = await shop.api('POST', '/api/board', { jobId: J, kind: 'PASS', re: d.doneMsgId, body: 'I checked it myself. It is good.' });
        assert.equal(r.body.ok, true, JSON.stringify(r.body));
      },
      check: (shop, J) => {
        const d = shop.deliveries(J).find((x) => x.waitHuman);
        assert.equal(d.review.by, '@human');
      },
    });
  });
});

describe('holds: no usable lab', () => {
  test('a job that needs real labs while none is usable waits with job.hold and one owner notice; no turn starts', T, async (t) => {
    const dirs = tempShop('ws-hold-');
    setSettings(dirs, {});
    let shop = null;
    cleanup(t, () => shop, dirs);
    shop = await bootShop({ dirs });
    const r = await shop.api('POST', '/api/jobs', { title: 'Real job', brief: BRIEF, kind: 'build', project: { mode: 'new', name: 'real' }, crew: 'standard', options: {}, budgetUsd: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const J = r.body.id;
    await shop.waitFor(() => shop.job(J).hold, { what: 'job.hold', jobId: J, timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const job = shop.job(J);
    assert.equal(job.status, 'queued');
    assert.equal(job.hold.reason, 'nolab');
    assert.match(job.waitReason, /No usable lab/);
    assert.equal(shop.notices().filter((n) => n.text.includes(`${J} waits: no lab can run a boss now`)).length, 1, 'one owner notice, not one per tick');
    assert.equal(shop.turns.length, 0, 'no agent turn ran');
    assert.equal(shop.agents(J).length, 0);
    const c = await shop.api('POST', `/api/jobs/${J}/cancel`, {});
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await finishShop(shop, { keep });
  });
});

// ------------------------------------------------------------------ fallback to the other lab (two fake labs)

/** A job on two labs (claude and agy adapters that run the mock agent; see twoLabs). */
async function twoLabScenario(t, decide, opts = {}) {
  const dirs = tempShop('ws-labs-');
  const labs = twoLabs(dirs, decide);
  setSettings(dirs, { ...labs.settings, ...(opts.settings ?? {}), limits: { holdFallbackMin: 0.02, ...(opts.settings?.limits ?? {}) } });
  let shop = null;
  cleanup(t, () => shop, dirs);
  shop = await bootShop({ dirs, app: labs.app });
  const r = await shop.api('POST', '/api/jobs', { title: 'Two labs', brief: opts.brief ?? BRIEF, kind: 'build', project: { mode: 'new', name: 'two' }, crew: opts.crew ?? 'standard', budgetUsd: 1000, options: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const J = r.body.id;
  try {
    await shipAndFinish(shop, J, { timeoutMs: LOADED });
  } catch (err) {
    err.message += `\n${trail(shop, J)}`;
    throw err;
  }
  await settled(shop);
  await assertOnce(shop, J);
  if (opts.check) await opts.check(shop, J, labs.calls);
  await finishShop(shop, { keep, allowErrors: opts.allowErrors === true });
}

/** What happened, for a failure message: agents with their labs and holds, deliveries, turns. */
function trail(shop, J) {
  const agents = shop.agents(J).map((a) => `${a.handle}:${a.provider}/${a.model}${a.hold ? `/hold:${a.hold.model}` : ''}:${a.status}`);
  const ds = shop.deliveries(J).map((d) => `${d.id}:${d.taskId}:${d.status}:rev=${d.reviewerId}:tried=${(d.reviewers ?? []).join('+')}${d.waitHuman ? ':human' : ''}`);
  const turns = shop.turns.map((x) => `${x.handle}:${x.kind}:${x.taskId ?? ''}:${x.ok}${x.killed ? `:killed=${x.killed}` : ''}${x.error ? `:${x.error.kind}:${String(x.error.message ?? '').slice(0, 80)}` : ''}:calls=${(x.calls ?? []).join('+')}`);
  const tasks = shop.tasks(J).map((x) => `${x.id}:${x.status}:rev=${x.reviewerId}:as=${x.assigneeId}${x.hold ? ':hold' : ''}`);
  const msgs = shop.app.board.history({ jobId: J, limit: 500 }).map((m) => `${m.id}:${m.kind}:${m.from}>${m.to ?? ''}:${m.scope}:re=${m.re ?? ''}:${m.state ?? ''}`);
  const logs = shop.logs.filter((l) => /review|verdict|hold|refused/i.test(`${l.msg} ${JSON.stringify(l.data ?? {})}`)).map((l) => `${l.msg} ${JSON.stringify(l.data ?? {}).slice(0, 160)}`);
  return `agents ${agents.join(' ')}\ntasks ${tasks.join(' ')}\ndeliveries ${ds.join(' ')}\nturns ${turns.join(' ')}\nboard ${msgs.join(' ')}\nlogs ${logs.join(' | ')}`;
}

const LONG = () => Date.now() + 10 * 60_000; // a reset time far beyond the test: only the fallback can help

describe('holds: fallback to the other lab after holdFallbackMin (two fake labs)', { concurrency: 3 }, () => {
  test('the maker model stays rate-limited: past the hold limit a maker of the other lab takes the same bench with a fresh session', T, async (t) => {
    const first = once((c) => c.kind === 'task');
    let held = null;
    await twoLabScenario(t, (c) => {
      if (first(c)) { held = c.agent; return { error: 'rate_limit', model: c.agent.model, resetAt: LONG() }; }
      return null;
    }, {
      check: (shop, J) => {
        const task = shop.tasks(J).find((x) => shop.seen('tasks', (y) => y.id === x.id && y.hold).length > 0);
        assert.ok(task, 'a task was on hold');
        const now = shop.app.store.get('agents', task.assigneeId);
        assert.notEqual(now.provider, held.provider, 'the task moved to the other lab');
        const takeover = shop.turns.find((x) => x.taskId === task.id && x.agentId === now.id && x.kind === 'work');
        assert.equal(takeover.resume, false, 'a fresh session');
        assert.match(takeover.prompt, /take over this task/);
        const benches = new Set(shop.turns.filter((x) => x.taskId === task.id && x.kind === 'work').map((x) => x.cwd));
        assert.equal(benches.size, 1, 'the same bench');
      },
    });
  });

  test('the lead boss is rate-limited while it plans (three bosses): the lead moves to a usable boss and the plan goes on', T, async (t) => {
    const first = once((c) => c.kind === 'plan' && c.agent.handle === '@b1');
    await twoLabScenario(t, (c) => (first(c) ? { error: 'rate_limit', model: c.agent.model, resetAt: LONG() } : null), {
      crew: 'full',
      check: (shop, J) => {
        // The lead duty moves to a usable boss; when every other boss has the same cooled model, the lead gets a
        // new pick (section 12, fallback). Either way the lead after the fallback is usable and the plan went on.
        const job = shop.job(J);
        const b1 = shop.agents(J).find((a) => a.handle === '@b1');
        const first = shop.seen('agents', (a) => a.id === b1.id && a.hold)[0];
        assert.ok(first, '@b1 was on hold');
        const moved = job.leadBossId !== b1.id;
        const repicked = b1.model !== first.hold.model;
        assert.ok(moved || repicked, 'the lead moved or got a new model');
        if (moved) assert.ok(shop.app.board.history({ jobId: J, limit: 500 }).some((m) => /is the lead boss now/.test(m.body)), 'the board says who leads');
        assert.notEqual(shop.app.store.get('agents', job.leadBossId).model, first.hold.model, 'the lead is not on the cooled model');
      },
    });
  });

  test('a review stays rate-limited: past the hold limit another reviewer takes the delivery', T, async (t) => {
    const first = once((c) => c.kind === 'review');
    let rev = null;
    await twoLabScenario(t, (c) => {
      if (first(c)) { rev = c.agent; return { error: 'rate_limit', model: c.agent.model, resetAt: LONG() }; }
      return null;
    }, {
      check: (shop, J) => {
        const d = shop.deliveries(J).find((x) => (x.reviewers ?? []).includes(rev.id) && x.review && x.review.by !== rev.handle);
        assert.ok(d, `a delivery that ${rev.handle} could not review got its verdict from another reviewer`);
      },
    });
  });

  test('one lab signs out mid-job (every turn of it fails with auth): its duties move to the other lab and the job finishes', T, async (t) => {
    let out = null;
    await twoLabScenario(t, (c) => {
      if (!out && c.kind === 'task') out = c.agent.provider;
      return out && c.agent.provider === out ? { error: 'auth', message: 'Not signed in. Run the sign-in.' } : null;
    }, {
      check: (shop, J) => {
        const st = shop.app.providers.status(out);
        assert.equal(st.usable, false, 'the signed-out lab is not usable');
        assert.equal(st.auth, 'none');
        const after = shop.turns.filter((x) => x.ok && x.startedAt > shop.turns.find((y) => y.error?.kind === 'auth').startedAt);
        assert.ok(after.length > 0);
        for (const x of after) assert.notEqual(shop.app.store.get('agents', x.agentId).provider, out, `${x.handle} ${x.kind} ran on the other lab`);
      },
    });
  });

  test('a closed self-test gate: the hub runs the self-test once for the lab without a pass; it fails, so only the other lab works', T, async (t) => {
    await twoLabScenario(t, () => null, {
      settings: { safety: 'sandboxed', selfTest: { claude: { version: '9.9.9', ok: true, core: [], advisory: [], ts: 1 }, gemini: null } },
      check: (shop, J, calls) => {
        assert.equal(calls.filter((c) => c.kind === 'selftest').length, 1, 'one self-test turn');
        assert.equal(shop.notices().filter((n) => /self-test of .* failed/.test(n.text)).length, 1, 'one owner notice');
        assert.equal(shop.app.providers.status('gemini').usable, false);
        assert.ok(shop.agents(J).every((a) => a.provider === 'claude'), 'every agent is on the lab with a pass');
        assert.equal(shop.app.settings.get().selfTest.gemini.ok, false, 'the failed result is stored');
      },
    });
  });
});

describe('restarts and holds together', () => {
  test('a restart while a task is on hold with a reset time: the hold and the cooling survive, no turn runs before the reset', T, async (t) => {
    const dirs = tempShop('ws-hold-');
    setSettings(dirs, {});
    let shop = null;
    cleanup(t, () => shop, dirs);
    const first = once((c) => c.kind === 'task');
    let resetAt = 0;
    const fm = faultyMock(dirs, (c) => (first(c) ? { error: 'rate_limit', model: c.agent.model, resetAt: (resetAt = Date.now() + 5000) } : null));
    shop = await bootShop({ dirs, app: { adapters: { mock: fm.adapter }, shellEnv: fm.shellEnv } });
    const J = (await startJob(shop)).id;
    const held = await shop.waitFor(() => shop.tasks(J).find((x) => x.hold?.until), { what: 'a task on hold', jobId: J, timeoutMs: 60_000 });
    await shop.close();
    shop = await bootShop({ dirs });
    assert.ok(shop.app.providers.status('mock').cooledModels?.[held.hold.model], 'the cooling of the model is back after the restart');
    await shipAndFinish(shop, J, { timeoutMs: LOADED });
    const early = shop.turns.filter((x) => x.taskId === held.id && x.kind === 'work' && x.startedAt < resetAt - 250);
    assert.deepEqual(early.map((x) => x.startedAt - resetAt), [], 'no work turn of the held task before its reset time');
    await settled(shop);
    await assertOnce(shop, J);
    await finishShop(shop, { keep });
  });
});
