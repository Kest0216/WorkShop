// The turn-failure table (section 12), the freeze, red checks, the audit wake and the lead fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FROZEN_LINE } from '../../server/prompts.js';
import { makeShop, samplePlan } from './harness.mjs';

const taskOf = (h, turn) => h.store.get('tasks', h.store.get('agents', turn.agentId).taskId);

test('maker timeout: one resume with a note, then the task fails', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }), brainHooks: { work: async () => ({ killed: 'timeout' }) } });
  t.after(() => h.close());
  await h.start();
  const works = h.turns('work');
  assert.ok(works.length >= 2);
  assert.match(works[1].prompt, /Your last turn ran out of time and was stopped/);
  const task = h.store.get('tasks', 'T1');
  assert.equal(task.status === 'failed' || h.job().pauseReason === 'stalled', true);
  assert.equal(task.lastError, 'The work turn ran out of time twice.');
  assert.equal(task.attempts, 0, 'a turn failure is not a rework');
});

test('maker error other: one retry, then the task is blocked (error) with lastError', async (t) => {
  const h = await makeShop({ planFor: () => samplePlan({ n: 1 }), brainHooks: { work: async () => ({ error: { kind: 'other', message: 'The CLI crashed.' } }) } });
  t.after(() => h.close());
  await h.start();
  const task = h.store.get('tasks', 'T1');
  assert.equal(task.why, 'error');
  assert.match(task.lastError, /The CLI crashed/);
  assert.ok(task.needsAction);
});

test('freeze: a wake of a maker whose work is in review runs with read access and the frozen line', async (t) => {
  let asked = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      review: async (turn, hh) => {
        if (asked) return undefined;
        asked = true;
        const maker = hh.agents().find((a) => a.role === 'maker');
        await turn.post(`ASK ${maker.handle} T1: Does mod1/index.js export only one name?`);
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  const frozen = h.turns('work').find((x) => x.access === 'read');
  assert.ok(frozen, 'a read-only wake of the maker');
  assert.ok(frozen.prompt.startsWith(FROZEN_LINE));
  assert.equal(h.job().status, 'delivering');
});

test('a frozen maker cannot post DONE, BLOCK or ASK for its task (E_CLOSED)', async (t) => {
  let answer = null;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      review: async (turn, hh) => {
        if (answer) return undefined;
        const maker = hh.agents().find((a) => a.role === 'maker');
        const token = hh.mcp.tokenFor(maker.id);
        const res = await hh.mcp.handle(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post', arguments: { line: 'BLOCK T1 why=unclear: I need the port number for the server.' } } });
        hh.mcp.revoke(maker.id);
        answer = res.result.content[0].text;
        return undefined;
      },
    },
  });
  t.after(() => h.close());
  await h.start();
  assert.match(answer, /E_CLOSED/);
});

test('new project: a red check after the first merge wakes the lead; a red head check before QA wakes it again', async (t) => {
  const red = 'case "$PWD" in *_head*) exit 1;; esac';
  const h = await makeShop({ planFor: () => samplePlan({ n: 1, check: red }) });
  t.after(() => h.close());
  await h.start();
  const lead = h.turns().filter((x) => x.handle === '@b1' && /CHECK FAILED/.test(x.prompt));
  assert.ok(lead.some((x) => /after the first task merged/.test(x.prompt)));
  assert.ok(lead.some((x) => /with all tasks merged/.test(x.prompt)));
  const project = h.store.get('projects', h.job().projectId);
  assert.equal(project.baseline.ok, false);
  assert.equal(h.turns('qa').length, 0, 'no QA turn on a red check');
  assert.equal(h.job().status, 'paused');
  assert.equal(h.job().pauseReason, 'stalled');
});

test('ledger audit: requirements the auditor adds wake the lead to add tasks for them', async (t) => {
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      audit: async (turn) => {
        turn.added = await turn.call('req_add', { text: 'The module has a README.', why: 'The brief says document it.' });
        return {};
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 1, managers: 1, makers: 1 } });
  const job = h.job();
  const r2 = job.requirements.find((r) => r.id === 'R2');
  assert.equal(r2.source, 'boss');
  assert.ok(h.turns('change').some((x) => /Requirement R2 has no task/.test(x.prompt)));
  assert.ok(h.tasks().some((x) => x.reqs.includes('R2')));
  assert.equal(job.status, 'delivering');
  assert.equal(r2.status, 'verified');
});

test('a lead boss on hold past holdFallbackMin hands the lead to a usable boss', async (t) => {
  let limited = false;
  const h = await makeShop({
    planFor: () => samplePlan({ n: 1 }),
    brainHooks: {
      report: async (turn, hh) => {
        if (limited || turn.agent.handle !== '@b1') return undefined;
        limited = true;
        hh.providers.cooledModels.add(turn.agent.model);
        return { error: { kind: 'rate_limit', message: 'limit', model: turn.agent.model, resetAt: null } };
      },
    },
  });
  t.after(() => h.close());
  await h.start({ crew: { bosses: 2, managers: 0, makers: 1 } });
  assert.ok(h.store.get('agents', h.job().leadBossId).hold);
  await h.advance(21 * 60000);
  const job = h.job();
  assert.equal(h.store.get('agents', job.leadBossId).handle, '@b2');
  assert.ok(job.report);
  assert.equal(h.turns('report').at(-1).handle, '@b2');
});
