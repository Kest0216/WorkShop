// Consults (section 12): a fresh aux turn of a manager-tier model of the other lab in the asker's bench.
// Started by a maker's ASK @other, or by the hub itself on a BLOCK with why=tests|unknown and on the second
// refused hand-in of a task. The consult must end with one ANS re:<ask>. With no usable other lab the hub
// answers NO why=env (a maker's ASK) or skips its own consult.
import { oneLine } from './context.js';

export function createConsult(ctx) {
  const C = {};

  /**
   * Start a consult for a task. opts.purpose: 'ask' (opts.askId: the maker's ASK @other), 'block'
   * (opts.blockId, opts.body, opts.from) or 'refusal' (opts.doneId, opts.reason). Returns false when no
   * other lab is usable (the caller then does what it would do without a consult).
   */
  C.start = (task, opts) => {
    const job = ctx.job(task?.jobId);
    const maker = ctx.agent(task?.assigneeId);
    if (!job || !maker || !task.benchDir) return false;
    const agent = ctx.crew.consultAgent(job, maker.provider, task.domain);
    if (!agent) return false;
    let askId = opts.askId ?? null;
    if (!askId) {
      const q = opts.purpose === 'block'
        ? `${opts.from ?? maker.handle} is blocked on ${task.id}: ${oneLine(opts.body, 300)} What should the maker do?`
        : `The hand-in of ${task.id} was refused twice. Last reason: ${oneLine(opts.reason, 300)} What should the maker change?`;
      const msg = ctx.hubLine(job.id, `ASK @other ${task.id}: ${q}`);
      if (!msg) return false;
      askId = msg.id;
    }
    ctx.patch('tasks', task.id, {
      consult: { askId, purpose: opts.purpose, agentId: agent.id, blockId: opts.blockId ?? null, doneId: opts.doneId ?? null, reason: opts.reason ?? null, started: false, at: ctx.now() },
      ...(opts.purpose === 'refusal' ? { awaitConsult: askId } : {}),
    });
    ctx.kick();
    return true;
  };

  /** resolve.consultBy: only the assigned consult agent answers that ASK @other. */
  C.mayAnswer = (agent, ask) => {
    const task = ctx.task(ask?.scope);
    return Boolean(task?.consult && task.consult.askId === ask.id && task.consult.agentId === agent.id);
  };

  /** A maker's ASK @other: start the consult, or answer NO why=env. */
  C.onAsk = (msg) => {
    const task = ctx.task(msg.scope);
    const ok = task && task.assigneeId === msg.fromId && !task.consult && C.start(task, { purpose: 'ask', askId: msg.id });
    if (!ok) ctx.hubLine(msg.jobId, `NO re:${msg.id} why=env: No model of another lab can answer now. Decide yourself and state the assumption in DONE.`);
  };

  C.tick = (job) => {
    let started = false;
    for (const t of ctx.tasksOf(job.id, (x) => x.consult && !x.consult.started)) {
      let agent = ctx.agent(t.consult.agentId);
      const ask = ctx.board.get(t.consult.askId);
      if (!ask || ask.state !== 'open') { finish(t.id, null); continue; }
      // The consult is the view of the other lab. A hold fallback can give the consult persona a model of the
      // asker's lab (repick), and a reassign can move the task to the consult's lab: then find another agent.
      const maker = ctx.agent(t.assigneeId);
      if (agent && maker && agent.provider === maker.provider && !ctx.busy(agent.id)) {
        const next = ctx.crew.consultAgent(job, maker.provider, t.domain);
        if (!next) { noHelp(t, ask); continue; }
        ctx.patch('tasks', t.id, { consult: { ...t.consult, agentId: next.id } });
        if (agent.hidden) ctx.patch('agents', agent.id, { status: 'off' });
        agent = next;
      }
      if (!agent || ctx.busy(agent.id) || agent.hold) continue;
      const card = ctx.digest.cardText(t);
      started = ctx.turns.aux(agent, {
        kind: 'consult', taskId: t.id, scope: t.id, auxKey: `con.${ask.id}`, holdOn: 'agent',
        prep: async () => {
          const now = ctx.task(t.id);
          if (!now?.benchDir) throw new Error(`${t.id} has no bench`);
          return now.benchDir;
        },
        onStart: () => ctx.patch('tasks', t.id, { consult: { ...ctx.task(t.id).consult, started: true } }),
        prompt: (view) => ctx.prompts.consultPrompt(ctx.task(t.id), card, { id: ask.id, from: ask.from, body: ask.body }, view),
        onEnd: (result, turn) => {
          const now = ctx.task(t.id);
          if (turn.held && now?.consult) {
            ctx.patch('tasks', t.id, { consult: { ...now.consult, started: false } });
            return;
          }
          finish(t.id, result);
        },
      }) || started;
    }
    return started;
  };

  /** No usable other lab is left for a consult: a maker's ASK gets NO why=env; a hub consult ends with no answer. */
  function noHelp(task, ask) {
    if (task.consult.purpose === 'ask') ctx.hubLine(task.jobId, `NO re:${ask.id} why=env: No model of another lab can answer now. Decide yourself and state the assumption in DONE.`);
    finish(task.id);
  }

  /** After the consult turn: close a still-open ASK as expired, then the follow-up of a hub consult. */
  function finish(taskId) {
    const task = ctx.task(taskId);
    const c = task?.consult;
    if (!c) return;
    let ans = null;
    try { ans = ctx.board.history({ jobId: task.jobId, limit: 500 }).find((m) => m.kind === 'ANS' && m.re === c.askId) ?? null; } catch { ans = null; }
    const ask = ctx.board.get(c.askId);
    if (ask && ask.state === 'open') {
      try { ctx.board.close(c.askId, 'expired', { wake: c.purpose === 'ask' }); } catch { /* closed meanwhile */ }
    }
    ctx.patch('tasks', taskId, { consult: null });
    const helper = ctx.agent(c.agentId);
    if (helper?.hidden && !ctx.busy(helper.id)) ctx.patch('agents', helper.id, { status: 'off' });
    if (c.purpose === 'block') {
      const block = ctx.board.get(c.blockId);
      if (ans && block?.state === 'open') ctx.hubLine(task.jobId, `ANS re:${c.blockId}: A consult of the other lab answered in message ${ans.id}. Read it, then continue.`);
      else if (ctx.task(taskId)?.status === 'blocked') ctx.tasksApi.needs(ctx.task(taskId), 'blocked');
    } else if (c.purpose === 'refusal') {
      ctx.patch('tasks', taskId, { awaitConsult: null });
      const now = ctx.task(taskId);
      if (now?.status === 'rework') ctx.handin.postFix(task.jobId, c.doneId, now.lastError ?? c.reason ?? 'The hand-in was refused.', ans?.id ?? null);
    }
    ctx.kick();
  }

  return C;
}
