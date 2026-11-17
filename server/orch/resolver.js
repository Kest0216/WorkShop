// The callbacks board.js needs (section 7: orch.resolver). Pure reads of state and of the turns in flight.
import { FROZEN, isOpenTask } from './context.js';

const HANDLE = /^@[bfm][1-9][0-9]{0,2}$/;

export function createResolver(ctx) {
  const live = (a) => a && a.status !== 'off' && !a.hidden;
  const num = (a) => Number(String(a.handle).slice(2)) || 0;

  return {
    /** A handle or an alias -> one agent of the job. @other: null (the hub picks the consult agent). */
    agent(token, from, jobId) {
      const agents = ctx.agentsOf(jobId);
      if (HANDLE.test(token)) return agents.find((a) => a.handle === token) ?? null;
      const job = ctx.job(jobId);
      const lead = ctx.lead(job);
      if (token === '@boss') return lead;
      if (token === '@mgr') {
        if (!from) return agents.filter((a) => a.role === 'manager' && live(a)).sort((a, b) => num(a) - num(b))[0] ?? lead;
        if (from.role === 'maker') {
          const task = ctx.task(from.taskId);
          const mgr = ctx.agent(task?.managerId);
          return live(mgr) && mgr.id !== from.id ? mgr : lead;
        }
        return lead && lead.id !== from.id ? lead : null;
      }
      return null;
    },
    taskOf: (agent) => (agent?.role === 'maker' ? agent.taskId ?? null : ctx.rt.turns.get(agent?.id)?.taskId ?? null),
    ownerOf: (taskId) => ctx.task(taskId)?.assigneeId ?? null,
    /** 'buddy', 'reviewer' or false: what the hub assigned this agent to do with that DONE now. */
    mayReview(agent, done) {
      const task = ctx.task(done?.scope);
      const d = ctx.currentDelivery(task);
      if (!task || !d || d.doneMsgId !== done.id) return false;
      if (d.status === 'buddy' && task.buddyId === agent.id && !d.buddy) return 'buddy';
      if (d.status === 'review' && d.reviewerId === agent.id && !d.review) return 'reviewer';
      return false;
    },
    supervisorOf(agent) {
      const job = ctx.job(agent?.jobId);
      const lead = ctx.lead(job);
      if (!agent || !lead) return null;
      if (agent.role === 'boss') return lead.id !== agent.id ? lead : null;
      if (agent.role === 'manager') return lead;
      const mgr = ctx.agent(ctx.task(agent.taskId)?.managerId);
      return live(mgr) ? mgr : lead;
    },
    inStream: (agent, taskId) => ctx.task(taskId)?.managerId === agent?.id,
    frozen(agent, taskId) {
      const t = ctx.task(taskId);
      return Boolean(t && t.assigneeId === agent?.id && FROZEN.has(t.status));
    },
    merging(agent, taskId) {
      const t = ctx.task(taskId);
      return Boolean(t && t.assigneeId === agent?.id && t.status === 'integrating');
    },
    accTotal: (taskId) => {
      const t = ctx.task(taskId);
      return t && Array.isArray(t.acceptance) ? t.acceptance.length : null;
    },
    /** The board session of the agent's current turn; between turns its main or work session. */
    sessionOf(agent) {
      const turn = ctx.rt.turns.get(agent?.id);
      if (turn?.board) return { session: turn.board.session ?? '', aux: turn.board.aux === true, scope: turn.board.scope ?? null };
      if (agent?.role === 'maker') {
        const t = ctx.task(agent.taskId);
        return t && isOpenTask(t) ? t.boardSession ?? '' : '';
      }
      return agent?.boardSession ?? '';
    },
    onHold(agentId) {
      const a = ctx.agent(agentId);
      if (!a) return false;
      if (a.hold) return true;
      const t = a.role === 'maker' ? ctx.task(a.taskId) : null;
      return Boolean(t?.hold);
    },
    presence: () => ctx.presence(),
    consultBy: (agent, ask) => ctx.consult.mayAnswer(agent, ask),
  };
}
