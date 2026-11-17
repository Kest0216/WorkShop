// Turn launcher (section 12, turn classes): main turns at a desk, work turns at the bench, aux turns in a
// review clone, _head, a desk or the asker's bench. The runner returns the session id; this module stores it on
// the work item, stores sessionCtx, places holds, checks the budget and applies the rotation rule.
import { RULE_CARD } from '../shoptalk.js';
import { LIVE, errText, isObj } from './context.js';

const LAB_ERRORS = new Set(['rate_limit', 'auth']);
const STATUS = { main: 'thinking', work: 'working', aux: 'reviewing' };

export function createTurns(ctx) {
  const T = {};

  T.mailHook = (agent) => (agent.provider === 'claude' ? ctx.mailHook !== false : agent.provider === 'mock');
  T.systemPrompt = (agent) => ctx.prompts.roleCard(agent, RULE_CARD, { mailHook: T.mailHook(agent) });

  /** Rotation rule (section 12): a fresh session in place of a resume. */
  T.rotate = (role, sessionCtx) => {
    if (!isObj(sessionCtx)) return false;
    const L = ctx.limits();
    const tok = Number(sessionCtx.tok) || 0;
    if (tok > (L.rotateTok?.[role] ?? Infinity)) return true;
    if (role === 'maker') return false;
    const gapMin = (ctx.now() - (Number(sessionCtx.at) || 0)) / 60000;
    return gapMin > L.rotateGapMin && tok > L.rotateGapTok;
  };

  /** The board session key of a record. A new key takes over the read cursor of the old one. */
  T.newBoardKey = (agent, oldKey, prefix) => {
    const n = (Number(String(oldKey ?? '').split('.').pop()?.replace(/\D/g, '')) || 0) + 1;
    const key = `${prefix}.s${n}`;
    if (oldKey) {
      try { ctx.board.moveCursor(agent.id, oldKey, key); } catch { /* the board makes a new reader */ }
    }
    return key;
  };
  T.mainKey = (agent) => {
    if (agent.boardSession) return agent.boardSession;
    const key = T.newBoardKey(agent, null, 'main');
    ctx.patch('agents', agent.id, { boardSession: key });
    return key;
  };
  T.workKey = (task, agent) => {
    if (task.boardSession) return task.boardSession;
    const key = T.newBoardKey(agent, null, task.id);
    ctx.patch('tasks', task.id, { boardSession: key });
    return key;
  };

  /** The rest status of an agent after a turn. */
  T.restStatus = (agentId) => {
    const a = ctx.agent(agentId);
    if (!a) return null;
    if (a.role !== 'maker') return a.hidden ? 'off' : 'idle';
    if (!a.taskId) return 'off';
    const task = ctx.task(a.taskId);
    if (task?.status === 'blocked') return 'blocked';
    let waiting = false;
    waiting = ctx.openItems(a.jobId, { kind: 'ASK', fromId: a.id }).length > 0;
    return waiting ? 'waiting' : 'idle';
  };

  const viewFor = (agent, board) => {
    try {
      return ctx.board.view(agent.id, board.aux ? { session: board.session, aux: true, scope: board.scope } : { session: board.session }) || '';
    } catch (err) {
      ctx.say('warn', 'orchestrator: board view failed', { agent: agent.id, error: errText(err) });
      return '';
    }
  };

  /** Place a lab hold on the work item (section 12, holds). */
  function placeHold(turn, agent, result) {
    const e = result.error;
    const hold = { reason: 'lab', provider: agent.provider, model: e.model ?? agent.model ?? null, since: ctx.now(), until: e.resetAt ?? null };
    if (turn.holdOn === 'task' && turn.taskId && ctx.task(turn.taskId)) {
      const t = ctx.task(turn.taskId);
      ctx.patch('tasks', t.id, { hold: t.hold ?? hold });
    } else {
      ctx.patch('agents', agent.id, { hold: agent.hold ?? hold });
    }
    turn.held = true;
  }

  function checkBudget(jobId) {
    const job = ctx.job(jobId);
    if (!job || job.budgetUsd === null || job.budgetUsd === undefined) return;
    if ((Number(job.cost?.billedUsd) || 0) >= job.budgetUsd && LIVE.has(job.status)) {
      ctx.pauseJob(job, 'budget', `The job reached its budget of $${job.budgetUsd}.`);
    }
  }

  /**
   * Launch one turn in the background. spec:
   *   cls 'main'|'work'|'aux', kind (runner kind), taskId?, holdOn 'task'|'agent',
   *   prep: async () => cwd, board: { session, aux?, scope? }, session: { id, resume },
   *   prompt: async (view) => string, access, web, timeoutMs, model?, onStart?, onEnd(result, turn)
   * Returns false when the agent is busy or the hub stops.
   */
  T.launch = (agent, spec) => {
    if (!agent || ctx.busy(agent.id) || ctx.rt.stopped) return false;
    const turn = {
      agentId: agent.id, jobId: agent.jobId, taskId: spec.taskId ?? null, kind: spec.kind, cls: spec.cls, label: spec.label ?? spec.kind,
      holdOn: spec.holdOn ?? (spec.cls === 'main' ? 'agent' : 'task'), board: spec.board, startedAt: ctx.now(), held: false, free: false,
      wake: spec.wake ?? null, meta: spec.meta ?? {},
    };
    ctx.rt.turns.set(agent.id, turn);
    ctx.patch('agents', agent.id, { status: spec.status ?? STATUS[spec.cls] ?? 'thinking', lastActiveAt: ctx.now(), ...(spec.cls === 'main' ? { turnSeq: ctx.seq() + 1 } : {}) });
    let notLive = false;
    turn.promise = (async () => {
      let result;
      try {
        try { spec.onStart?.(turn); } catch (err) { ctx.say('warn', 'orchestrator: onStart failed', { error: errText(err) }); }
        const cwd = await spec.prep();
        // The job may have been cancelled or paused while the folder was made: then the turn does not start.
        const live = ctx.job(agent.jobId);
        if (!live || !LIVE.has(live.status) || ctx.rt.stopped) {
          notLive = true;
          throw new Error(`${agent.jobId} is ${live?.status ?? 'gone'}: the turn did not start`);
        }
        const view = viewFor(ctx.agent(agent.id) ?? agent, spec.board);
        const prompt = await spec.prompt(view);
        const a = ctx.agent(agent.id) ?? agent;
        const L = ctx.limits();
        const taskDomain = spec.taskId ? ctx.task(spec.taskId)?.domain : null;
        const harness = ctx.harnesses && a.role !== 'boss'
          ? ((a.harnessId && ctx.harnesses.get(a.harnessId)) || (taskDomain ? ctx.harnesses.forDomain?.(taskDomain, a.role) : null))
          : null;
        const addon = harness?.protocol?.systemPromptAddon ? `\n\n${harness.protocol.systemPromptAddon}` : '';
        result = await ctx.runner.run(agent.id, {
          sessionId: spec.session?.id ?? null, resume: Boolean(spec.session?.resume && spec.session?.id), prompt,
          systemPrompt: `${T.systemPrompt(a)}${addon}`, cwd, access: spec.access ?? 'read', web: spec.web === true,
          model: a.model ?? undefined, effort: a.effort ?? undefined,
          timeoutMs: spec.timeoutMs ?? L.turnTimeoutMin * 60000, idleMs: L.idleTimeoutMin * 60000,
          kind: spec.kind, taskId: spec.taskId ?? undefined,
          ...(harness ? { harness } : {}),
        });
      } catch (err) {
        ctx.say(notLive ? 'info' : 'warn', 'orchestrator: turn could not start', { agent: agent.id, kind: spec.kind, error: errText(err) });
        result = { ok: false, text: '', sessionId: spec.session?.id ?? null, usd: 0, usage: { ctxTok: 0 }, calls: [], denied: [], error: { kind: 'other', message: errText(err) }, killed: null, durationMs: 0, startedAt: turn.startedAt, started: false };
      }
      result = { usage: { ctxTok: 0 }, calls: [], ...result };
      try {
        const a = ctx.agent(agent.id) ?? agent;
        const kind = result.error?.kind;
        if (LAB_ERRORS.has(kind)) placeHold(turn, a, result);
        else if (kind === 'mcp') {
          const n = (a.mcpFails ?? 0) + 1;
          ctx.patch('agents', a.id, { mcpFails: n });
          if (n <= 1) turn.free = true;
          else ctx.notice('owner', `${a.handle} cannot reach the hub tools (MCP). ${result.error.message}`, a.jobId, `mcp:${a.id}`, 'keys');
        } else if (result.ok && a.mcpFails) ctx.patch('agents', a.id, { mcpFails: 0 });
        if (result.killed === 'interrupt' || result.killed === 'shutdown') turn.free = true;
        if ((ctx.rt.stopped || notLive) && !result.ok) turn.free = true;
        checkBudget(agent.jobId);
        await spec.onEnd(result, turn);
      } catch (err) {
        ctx.say('error', 'orchestrator: turn end handling failed', { agent: agent.id, kind: spec.kind, error: errText(err) });
      } finally {
        ctx.rt.turns.delete(agent.id);
        const rest = T.restStatus(agent.id);
        if (rest && ctx.agent(agent.id)) ctx.patch('agents', agent.id, { status: rest, lastActiveAt: ctx.now() });
        ctx.kick();
      }
    })();
    return true;
  };

  /** Store the main session of a boss or manager after a main turn. */
  function keepMain(agentId, result) {
    const a = ctx.agent(agentId);
    if (!a) return;
    const changes = { lastTurnAt: ctx.now() };
    if (result.sessionId) changes.sessionId = result.sessionId;
    if (result.started !== false) changes.sessionCtx = { tok: Number(result.usage?.ctxTok) || 0, at: ctx.now() };
    ctx.patch('agents', agentId, changes);
  }

  /**
   * Main turn of a boss or manager at its desk. spec: { kind, label, prompt(view) -> text, resumeOnly?, fresh?,
   * lines?:[closing lines on top], onStart?, onEnd(result, turn) }. The agent's pending wake is absorbed: the
   * view holds the mail. A held or failed turn gives the wake back.
   */
  T.main = (agent, spec) => {
    if (!agent || ctx.busy(agent.id)) return false;
    const job = ctx.job(agent.jobId);
    const project = ctx.projectOf(job);
    if (!job || !project) return false;
    const wake = agent.wake ?? null;
    const rotate = !spec.resumeOnly && agent.sessionId && (spec.fresh || T.rotate(agent.role, agent.sessionCtx));
    const resume = Boolean(agent.sessionId) && !rotate && !spec.fresh;
    const digest = !resume && (rotate || agent.digestNext === true);
    let key = T.mainKey(agent);
    if (rotate || (spec.fresh && agent.sessionId)) {
      key = T.newBoardKey(agent, key, 'main');
      ctx.patch('agents', agent.id, { boardSession: key, sessionId: null, sessionCtx: null });
    }
    const lines = [...(spec.ownLines ? [] : wake?.lines ?? []), ...(spec.lines ?? [])];
    return T.launch(agent, {
      cls: 'main', kind: spec.kind, label: spec.label, holdOn: 'agent', wake, meta: spec.meta,
      board: { session: key },
      session: { id: resume ? agent.sessionId : null, resume },
      prep: async () => {
        const j = ctx.job(agent.jobId);
        const { dir } = await ctx.git.makeClone(project, j.id, `_desk/${agent.handle}`, j.intSha, { files: ctx.digest.deskFiles(j) });
        return dir;
      },
      onStart: (turn) => {
        if (wake) ctx.patch('agents', agent.id, { wake: null });
        if (agent.digestNext) ctx.patch('agents', agent.id, { digestNext: false });
        spec.onStart?.(turn);
      },
      prompt: async (view) => {
        const head = lines.length ? `${lines.join('\n')}\n` : '';
        const body = await spec.prompt(view);
        if (!digest) return `${head}${body}`;
        const d = ctx.prompts.digestPrompt(ctx.agent(agent.id) ?? agent, await ctx.digest.digestCtx(agent));
        return `${d}\n\n${head}${body}`;
      },
      access: 'read',
      onEnd: async (result, turn) => {
        keepMain(agent.id, result);
        if ((turn.held || turn.free || !result.ok) && wake) {
          const a = ctx.agent(agent.id);
          if (a && !a.wake) ctx.patch('agents', agent.id, { wake: { ...wake, tries: (wake.tries ?? 0) + (turn.held || turn.free ? 0 : 1) } });
        }
        await spec.onEnd?.(result, turn);
        if (!turn.held && !turn.free) gate(agent.id, turn);
      },
    });
  };

  /**
   * Turn gate (section 7): an agent that ends a main turn with an open item addressed to it is resumed once
   * with that instruction. After that the items move one level up.
   */
  function gate(agentId, turn) {
    const a = ctx.agent(agentId);
    if (!a) return;
    let open = [];
    try { open = ctx.board.openFor(agentId); } catch { open = []; }
    if (!open.length) {
      if (a.gate) ctx.patch('agents', agentId, { gate: null });
      return;
    }
    const ids = open.map((m) => m.id);
    if (!a.gate || turn.label !== 'gate') {
      ctx.patch('agents', agentId, { gate: { ids, at: ctx.now() } });
      return;
    }
    ctx.patch('agents', agentId, { gate: null });
    for (const id of ids) {
      try { ctx.board.escalate(id); } catch { /* the item closed meanwhile */ }
    }
  }

  /** A gate nudge turn for an agent whose last main turn left open items. */
  T.gateTurn = (agent) => T.main(agent, {
    kind: 'digest', label: 'gate', resumeOnly: true,
    prompt: (view) => `${view ? `${view}\n\n` : ''}${ctx.prompts.nudge('open', agent.gate.ids.join(', '))}`,
    onEnd: () => {},
  });

  /**
   * Work turn of a maker at its bench. spec: { prompt(view, info) -> text, frozen?, fresh?, reason?, onEnd }.
   * info: { digest } when the session rotated.
   */
  T.work = (agent, task, spec) => {
    if (!agent || ctx.busy(agent.id)) return false;
    const L = ctx.limits();
    const rotate = Boolean(task.sessionId) && !spec.fresh && !spec.resumeOnly && T.rotate('maker', task.sessionCtx);
    const fresh = spec.fresh || rotate || !task.sessionId;
    let key = T.workKey(task, agent);
    if ((rotate || spec.fresh) && task.sessionId) {
      key = T.newBoardKey(agent, key, task.id);
      ctx.patch('tasks', task.id, { boardSession: key, sessionId: null, sessionCtx: null });
    }
    const frozen = spec.frozen === true;
    return T.launch(agent, {
      cls: 'work', kind: 'work', taskId: task.id, holdOn: 'task', label: spec.label ?? 'work', wake: agent.wake ?? null,
      status: frozen ? 'thinking' : 'working',
      board: { session: key },
      session: { id: fresh ? null : task.sessionId, resume: !fresh },
      prep: async () => {
        const t = ctx.task(task.id);
        if (!t?.benchDir) throw new Error(`${task.id} has no bench`);
        return t.benchDir;
      },
      onStart: (turn) => {
        if (agent.wake) ctx.patch('agents', agent.id, { wake: null });
        turn.meta.frozen = frozen;
        spec.onStart?.(turn);
      },
      prompt: async (view) => {
        const t = ctx.task(task.id) ?? task;
        const body = await spec.prompt(view, { rotated: rotate });
        if (!rotate) return body;
        const d = ctx.prompts.digestPrompt(ctx.agent(agent.id) ?? agent, await ctx.digest.digestCtx(agent, t));
        return `${d}\n\n${body}`;
      },
      access: frozen ? 'read' : 'write',
      web: task.domain === 'research',
      timeoutMs: (L.taskTimeoutMin?.[task.size] ?? L.turnTimeoutMin) * 60000,
      onEnd: async (result, turn) => {
        const t = ctx.task(task.id);
        if (t && t.assigneeId === agent.id) {
          const changes = {};
          if (result.sessionId) changes.sessionId = result.sessionId;
          if (result.started !== false) changes.sessionCtx = { tok: Number(result.usage?.ctxTok) || 0, at: ctx.now() };
          ctx.patch('tasks', t.id, changes);
        }
        if ((turn.held || turn.free) && turn.wake) {
          const a = ctx.agent(agent.id);
          if (a && !a.wake) ctx.patch('agents', a.id, { wake: turn.wake });
        }
        await spec.onEnd(result, turn);
      },
    });
  };

  /**
   * Aux turn (buddy, review, QA, audit, consult): read access, a board view scoped to one scope that never
   * moves the main cursor, no turn gate. spec: { kind, taskId?, scope, auxKey, prep, session:{id,resume}, prompt, onEnd, holdOn }
   */
  T.aux = (agent, spec) => T.launch(agent, {
    cls: 'aux', kind: spec.kind, taskId: spec.taskId, holdOn: spec.holdOn ?? 'task', label: spec.label ?? spec.kind,
    status: 'reviewing', board: { session: spec.auxKey, aux: true, scope: spec.scope },
    session: spec.session ?? { id: null, resume: false }, prep: spec.prep, prompt: spec.prompt, access: 'read', meta: spec.meta,
    onStart: spec.onStart, onEnd: spec.onEnd,
  });

  return T;
}
