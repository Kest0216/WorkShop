// The workflow hub tools of section 8, registered on mcp with input schemas and one-line descriptions.
// post and read belong to the board (board.registerTools); selftest_ping to the runner.
import { LIVE, oneLine } from './context.js';

const S = { type: 'string' };
const SL = { type: 'string', maxLength: 2000 };
const LIST = (max = 40) => ({ type: 'array', items: { type: 'string', maxLength: 400 }, maxItems: max });
const TASK_FIELDS = {
  title: { type: 'string', maxLength: 200 }, spec: { type: 'string', maxLength: 4000 }, acceptance: LIST(8), zones: LIST(40),
  domain: S, size: { type: 'string', enum: ['S', 'M', 'L'] }, pair: { type: 'boolean' }, stream: { type: 'string', maxLength: 40 },
};

export const TOOL_DEFS = {
  plan_submit: {
    roles: ['boss'],
    description: 'Submit the plan (validated; errors come back as the result).',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['requirements', 'tasks'],
      properties: {
        requirements: { type: 'array', maxItems: 40, items: { type: 'object', required: ['text'], properties: { text: SL } } },
        tasks: {
          type: 'array', maxItems: 80,
          items: {
            type: 'object', required: ['key', 'title', 'spec', 'acceptance', 'zones', 'domain', 'size', 'reqs'],
            properties: { key: { type: 'string', maxLength: 40 }, ...TASK_FIELDS, deps: LIST(40), reqs: { type: 'array', items: { type: 'number' }, maxItems: 40 } },
          },
        },
        setup_cmd: SL, check_cmd: SL, no_check_reason: SL, assumptions: LIST(30), notes: { type: 'string', maxLength: 4000 },
        covers: { type: 'array', items: { type: 'object', required: ['draft', 'n', 'req'], properties: { draft: S, n: { type: 'number' }, req: { type: 'number' } } } },
        dropped: { type: 'array', items: { type: 'object', required: ['draft', 'n', 'why'], properties: { draft: S, n: { type: 'number' }, why: SL } } },
      },
    },
  },
  task_add: {
    roles: ['manager', 'boss'],
    description: 'Add a task (counts against the task limit).',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title', 'spec', 'acceptance', 'zones', 'domain', 'size'],
      properties: { ...TASK_FIELDS, deps: LIST(40), reqs: LIST(30) },
    },
  },
  task_update: {
    roles: ['manager', 'boss'],
    description: 'Change a task that is not merged. Removing or rewording acceptance needs a boss.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: S, ...TASK_FIELDS, deps: LIST(40), reqs: LIST(30), allowLarge: { type: 'boolean' }, note: { type: 'string', maxLength: 1000 } },
    },
  },
  task_retry: {
    roles: ['manager', 'boss'],
    description: 'Restart a failed or blocked task on its bench with a fresh session.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: S, note: { type: 'string', maxLength: 1000 }, model: { type: 'string', enum: ['same', 'up', 'other_lab'] } } },
  },
  task_cancel: {
    roles: ['manager', 'boss'],
    description: 'Cancel a task. Dependents move to replacedBy.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: S, reason: { type: 'string', maxLength: 600 }, replacedBy: LIST(20) } },
  },
  claim: {
    roles: ['maker'],
    description: 'Ask to edit exact paths outside your zones. Answer: ok, or WAIT.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['paths'], properties: { paths: LIST(5) } },
  },
  status: {
    roles: ['manager', 'boss'],
    description: 'Compact table of the tasks and the agents.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  req_add: {
    roles: ['boss', 'manager'],
    description: 'Add a requirement the owner asked for that the ledger misses.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text', 'why'], properties: { text: { type: 'string', maxLength: 600 }, why: { type: 'string', maxLength: 600 } } },
  },
  req_verify: {
    roles: ['boss', 'manager'],
    description: 'QA turn only: one result per open requirement, evidence with a file pointer.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['results'],
      properties: { results: { type: 'array', maxItems: 40, items: { type: 'object', required: ['id', 'ok', 'evidence'], properties: { id: S, ok: { type: 'boolean' }, evidence: SL } } } },
    },
  },
  job_report: {
    roles: ['boss'],
    description: 'Store the final report (Markdown) for the owner.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['md'], properties: { md: { type: 'string', maxLength: 20000 } } },
  },
};

export function createTools(ctx) {
  const X = {};
  const err = (text) => ({ text: `ERR ${text}`, isError: true });
  const liveJob = (agent) => {
    const job = ctx.job(agent.jobId);
    return job && LIVE.has(job.status) ? job : null;
  };
  const ownTask = (agent, id) => {
    const t = ctx.task(String(id ?? ''));
    return t && t.jobId === agent.jobId ? t : null;
  };
  /** The owner-change requirement the agent's running change turn must cite, if any. */
  const changeReq = (agent) => {
    const turn = ctx.rt.turns.get(agent.id);
    return turn?.kind === 'change' && turn.meta?.reqId ? turn.meta.reqId : null;
  };

  const handlers = {
    plan_submit: (agent, args) => ctx.plan.submit(agent, args),
    task_add: async (agent, args) => {
      const job = liveJob(agent);
      if (!job) return err('The work order does not run now.');
      const r = await ctx.edits.add(job, args, agent, { change: changeReq(agent) });
      return r.ok ? `ok ${r.task.id}` : err(r.error);
    },
    task_update: (agent, args) => {
      if (!liveJob(agent)) return err('The work order does not run now.');
      const t = ownTask(agent, args.id);
      if (!t) return err(`${args.id} is not a task of this work order.`);
      if (agent.role === 'manager' && t.managerId && t.managerId !== agent.id) return err(`${t.id} is in the stream of another manager.`);
      const r = ctx.edits.update(t, args, agent);
      return r.ok ? r.text ?? 'ok' : err(r.error);
    },
    task_retry: (agent, args) => {
      if (!liveJob(agent)) return err('The work order does not run now.');
      const t = ownTask(agent, args.id);
      if (!t) return err(`${args.id} is not a task of this work order.`);
      const r = ctx.edits.retry(t, { note: args.note, model: args.model }, agent);
      return r.ok ? 'ok' : err(r.error);
    },
    task_cancel: (agent, args) => {
      if (!liveJob(agent)) return err('The work order does not run now.');
      const t = ownTask(agent, args.id);
      if (!t) return err(`${args.id} is not a task of this work order.`);
      const r = ctx.edits.cancel(t, { reason: args.reason, replacedBy: args.replacedBy }, agent);
      return r.ok ? 'ok' : err(r.error);
    },
    claim: (agent, args) => {
      if (!liveJob(agent)) return err('The work order does not run now.');
      return ctx.edits.claim(agent, args);
    },
    status: (agent) => {
      const job = ctx.job(agent.jobId);
      return job ? ctx.digest.statusTable(job) : err('No work order.');
    },
    req_add: (agent, args) => {
      const job = liveJob(agent);
      if (!job) return err('The work order does not run now.');
      const turn = ctx.rt.turns.get(agent.id);
      if (agent.role !== 'boss' && !(turn && (turn.kind === 'audit' || turn.kind === 'qa'))) return err('req_add is for a boss, or the agent of the running audit or QA turn.');
      const text = String(args.text ?? '').trim();
      if (!text) return err('The text is empty.');
      const req = ctx.owner.newReq(job.id, { text, source: 'boss' });
      if (turn?.kind === 'audit') ctx.patch('jobs', job.id, { auditAdded: [...(ctx.job(job.id).auditAdded ?? []), req.id] });
      ctx.notice('info', `${agent.handle} added ${req.id}: ${oneLine(text, 200)} (why: ${oneLine(args.why, 200)})`, job.id);
      ctx.evt(job.id, { scope: '#plan', body: `${req.id} added by ${agent.handle}: ${oneLine(text, 160)}` });
      ctx.qa.onNewWork(job.id);
      return `ok ${req.id}`;
    },
    req_verify: (agent, args) => ctx.qa.verify(agent, args),
    job_report: (agent, args) => ctx.qa.report(agent, args),
  };

  X.register = (mcp) => {
    for (const [name, def] of Object.entries(TOOL_DEFS)) mcp.registerTool(name, { ...def, handler: handlers[name] });
  };
  X.handlers = handlers;
  return X;
}
