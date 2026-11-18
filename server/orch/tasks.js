// Task flow (section 12): ready, hire, bench, work turns, the closing act, DONE / BLOCK / FAIL from the
// maker, needsAction, and the wakes of a maker. Card edits, retry, cancel and claims are in edits.js.
import { FROZEN, LIVE, isOpenTask, oneLine } from './context.js';

const SLOT_STATES = new Set(['working', 'rework']);

export function createTasks(ctx) {
  const K = {};

  /** A new task record (not stored). */
  K.newTask = (job, f) => ({
    id: f.id ?? ctx.store.nextId('T'), jobId: job.id, title: f.title, spec: f.spec, acceptance: [...f.acceptance], reqs: [...(f.reqs ?? [])],
    domain: f.domain, size: f.size, zones: [...f.zones], claims: [], pendingClaims: [], deps: [...(f.deps ?? [])], pair: f.pair === true,
    allowLarge: false, stream: f.stream ?? null, managerId: f.managerId ?? null, note: null, status: 'planned', why: null,
    assigneeId: null, buddyId: null, reviewerId: null, sessionId: null, sessionCtx: null, reviewSessionId: null,
    benchDir: null, reviewDir: null, baseSha: null, headSha: null, lastReviewedSha: null,
    attempts: 0, retries: 0, blocks: 0, progress: 0, summary: null, lastError: null, hold: null, needsAction: null,
    cardChanges: [], cost: { usd: 0 }, catchUp: f.catchUp === true, nudges: 0, fails: {}, deliveryId: null,
  });

  const lim = () => ctx.limits();
  const depsMerged = (t) => t.deps.every((d) => {
    const dep = ctx.task(d);
    return !dep || dep.status === 'merged' || dep.status === 'cancelled';
  });

  /** Set or clear task.needsAction (failed or blocked; not for a claim wait or an owner stop). */
  K.needs = (task, kind) => {
    if (!kind) return ctx.patch('tasks', task.id, { needsAction: null });
    if (task.why === 'claim' || task.why === 'owner') return task;
    return ctx.patch('tasks', task.id, { needsAction: { kind, since: ctx.now(), seq: ctx.seq() } });
  };

  /** Block or fail a task with a reason; the manager is woken through needsAction. */
  K.stop = (task, status, why, lastError) => {
    const t = ctx.patch('tasks', task.id, { status, why: status === 'blocked' ? why : null, lastError: lastError ?? task.lastError, resumeNote: null });
    if (t) K.needs(t, status);
    return t;
  };

  /** Tasks that hold a maker slot (crew.makers caps them) and benches in use (8 spots). */
  const slotsUsed = (job) => ctx.tasksOf(job.id, (t) => SLOT_STATES.has(t.status) || (t.status === 'ready' && t.assigneeId)).length;
  const benchesUsed = (job) => ctx.tasksOf(job.id, (t) => isOpenTask(t) && (t.benchDir || (t.status === 'ready' && t.assigneeId))).length;

  /** planned -> ready, and ready tasks get a maker and a bench. Returns true when something started. */
  K.advance = (job) => {
    let started = false;
    for (const t of ctx.tasksOf(job.id, (x) => x.status === 'planned')) {
      if (depsMerged(t)) { ctx.patch('tasks', t.id, { status: 'ready' }); started = true; }
    }
    const crewMax = Math.max(1, Number(job.crew?.makers) || 1);
    for (const t of ctx.tasksOf(job.id, (x) => x.status === 'ready')) {
      if (ctx.rt.steps.has(`bench:${t.id}`) || t.hold) continue;
      if (!t.assigneeId) {
        if (slotsUsed(job) >= crewMax || benchesUsed(job) >= 8) break;
        const agent = ctx.crew.hireMaker(job, t, { bump: t.bump ?? 0, avoidProvider: t.wantLab?.avoid, requireOther: Boolean(t.wantLab) });
        if (!agent) continue;
        ctx.patch('tasks', t.id, { assigneeId: agent.id });
      }
      started = ctx.step(`bench:${t.id}`, job.id, () => bench(t.id)) || started;
    }
    return started;
  };

  /** git.createBench with TASK.md, BLUEPRINT.md, and optional HARNESS.md, then status working. A failed setup blocks the task (env). */
  async function bench(taskId) {
    let task = ctx.task(taskId);
    let job = ctx.job(task?.jobId);
    const project = ctx.projectOf(job);
    let agent = ctx.agent(task?.assigneeId);
    if (!task || !job || !project || !agent || task.status !== 'ready' || !LIVE.has(job.status)) return;

    const standInMode = Boolean(ctx.settings()?.oss?.standIn === true);
    let match = null;
    if (!ctx.isMock(job) && agent.provider === 'oss' && ctx.roster) {
      match = ctx.roster.match({ domain: task.domain, role: 'maker', certifiedOnly: !standInMode, allowSim: standInMode });
      if (typeof ctx.decider?.selectSpecialist === 'function') {
        const dec = await ctx.decider.selectSpecialist({ task, roster: ctx.roster, harnesses: ctx.harnesses });
        task = ctx.task(taskId);
        job = ctx.job(task?.jobId);
        agent = ctx.agent(task?.assigneeId);
        if (!task || !job || agent == null || task.status !== 'ready' || !LIVE.has(job.status)) return;
        if (dec && dec.via === 'gemini' && dec.rosterId) {
          const pickedEntry = ctx.roster.get(dec.rosterId);
          if (pickedEntry) {
            const patchAgent = {
              rosterId: pickedEntry.id,
              certification: pickedEntry.certification,
              harnessId: dec.harnessId || pickedEntry.harnessId || agent.harnessId,
            };
            if (pickedEntry.baseModel && ctx.providers?.modelUsable?.('oss', pickedEntry.baseModel) !== false) {
              patchAgent.model = pickedEntry.baseModel;
            }
            agent = ctx.patch('agents', agent.id, patchAgent) ?? agent;
            match = {
              entry: pickedEntry,
              certified: dec.certified,
              exactDomain: pickedEntry.specialties.includes(task.domain),
              needsRft: dec.needsRft,
              reason: dec.reason,
            };
          }
        }
      }
    }

    const harness = ctx.harnesses
      ? ((agent.harnessId && ctx.harnesses.get(agent.harnessId)) || ctx.harnesses.forDomain?.(task.domain, 'maker'))
      : null;
    if (harness && agent.harnessId !== harness.id) {
      agent = ctx.patch('agents', agent.id, { harnessId: harness.id }) ?? agent;
    }

    if (!ctx.isMock(job) && agent.provider === 'oss' && ctx.training && match?.needsRft) {
      const req = ctx.training.createRequisition({
        jobId: job.id,
        taskId: task.id,
        domain: task.domain,
        reason: match.reason,
        harnessId: harness?.id,
        fallbackModel: agent.model,
      });
      if (!standInMode) {
        const msg = `Specialty gap (${task.domain}): no RL-certified specialist in Employee Handbook. Queued ${req.id} — forge & RL-certify in Team -> Agent Forge, then Retry.`;
        ctx.evt(job.id, { scope: '#plan', body: msg });
        ctx.notice('owner', `${task.id}: ${msg}`, job.id, null, 'crew');
        K.stop(ctx.task(taskId), 'blocked', 'owner', msg);
        return;
      }
      ctx.evt(job.id, {
        scope: '#plan',
        body: `Phase 1 RFT requisition ${req.id} queued for ${task.domain} ([SIM] Stand-in running ${agent.name} on ${agent.model} with harness ${harness?.id || 'default'}).`,
      });
    }

    const files = {
      '.shop/TASK.md': ctx.digest.cardText(task),
      '.shop/BLUEPRINT.md': ctx.digest.blueprintText(job),
      ...(harness ? { '.shop/HARNESS.md': ctx.harnesses.renderCard(harness) } : {}),
    };
    const made = await ctx.git.createBench(project, job.id, task.id, { files, authorName: agent.name, mergeTarget: task.catchUp === true });
    const now = ctx.task(taskId);
    if (!now || now.status !== 'ready') return;
    ctx.patch('tasks', taskId, {
      benchDir: made.dir,
      baseSha: made.baseSha,
      status: 'working',
      ...(harness ? { harnessId: harness.id } : {}),
      ...(agent.rosterId ? { rosterId: agent.rosterId } : {}),
    });
    if (made.setup && !made.setup.ok) {
      K.stop(ctx.task(taskId), 'blocked', 'env', `Setup failed (exit ${made.setup.code}): ${oneLine(made.setup.tail, 600)}`);
      ctx.handin.noteRefusal(job.id, taskId, 'setup');
    }
  }

  const ownOpenAsk = (agent) => {
    return ctx.openItems(agent.jobId, { kind: 'ASK', fromId: agent.id }).length > 0;
  };

  /**
   * Start the work-class turn a task needs now, derived from state: a wake (mail), a retry, the first turn,
   * a resume with a note, or a rework turn. Returns true when a turn started.
   */
  K.drive = (task) => {
    const agent = ctx.agent(task.assigneeId);
    if (!agent || ctx.busy(agent.id) || task.hold || agent.hold || task.awaitConsult) return false;
    if (!task.benchDir) return false;
    const wake = agent.wake;
    const card = () => ctx.digest.cardText(ctx.task(task.id) ?? task);
    const P = ctx.prompts;
    if (FROZEN.has(task.status)) {
      if (!wake && !task.gate) return false;
      return ctx.turns.work(agent, task, {
        frozen: true, label: 'wake',
        prompt: (view) => (task.gate ? `${P.FROZEN_LINE}\n${view ? `${view}\n\n` : ''}${P.nudge('open', task.gate.ids.join(', '))}` : P.wakePrompt(view, { frozen: true, closing: (wake?.lines ?? []).join('\n') })),
        onStart: () => { if (task.gate) ctx.patch('tasks', task.id, { gate: null }); },
        onEnd: (r, turn) => K.workEnded(r, turn),
      });
    }
    if (task.status === 'blocked' || task.status === 'failed') {
      if (!wake) return false;
      return ctx.turns.work(agent, task, {
        label: 'wake', prompt: (view) => P.wakePrompt(view, { closing: (wake.lines ?? []).join('\n') }), onEnd: (r, turn) => K.workEnded(r, turn),
      });
    }
    if (task.status !== 'working' && task.status !== 'rework') return false;
    if (task.retryNote) {
      const note = task.retryNote;
      return ctx.turns.work(agent, task, {
        fresh: true, label: 'retry',
        prompt: (view) => P.retryPrompt(ctx.task(task.id), card(), view, { note: note.note, lastError: note.lastError }),
        onStart: () => ctx.patch('tasks', task.id, { retryNote: null }),
        onEnd: (r, turn) => K.workEnded(r, turn),
      });
    }
    if (!task.sessionId && !task.started) {
      return ctx.turns.work(agent, task, {
        fresh: true, label: 'start',
        prompt: (view) => P.taskPrompt(ctx.task(task.id), card(), view),
        onStart: () => ctx.patch('tasks', task.id, { started: true }),
        onEnd: (r, turn) => K.workEnded(r, turn),
      });
    }
    let reason = task.resumeNote ?? null;
    if (task.status === 'rework' && !reason && (wake || task.reworkWake)) reason = 'Your hand-in came back with changes to make: see the FIX above.';
    if (!reason && wake) reason = 'New mail for you is above.';
    // No reason on record and no turn: the turn before ended without a result (restart, interrupt).
    if (!reason && !ownOpenAsk(agent) && !task.pendingClaims?.length) reason = P.nudge('restart');
    if (!reason) return false;
    const lines = wake?.lines ?? [];
    if (lines.length) reason = `${lines.join('\n')}\n${reason}`;
    return ctx.turns.work(agent, task, {
      label: 'continue', resumeOnly: Boolean(task.resumeNote),
      prompt: (view) => P.continuePrompt(ctx.task(task.id), view, reason),
      onStart: () => ctx.patch('tasks', task.id, { resumeNote: null, reworkWake: false }),
      onEnd: (r, turn) => K.workEnded(r, turn),
    });
  };

  /** Work turn end (section 12 closing act and the "Maker (work)" row of the turn-failure table). */
  K.workEnded = (result, turn) => {
    const task = ctx.task(turn.taskId);
    const agent = ctx.agent(turn.agentId);
    if (!task || !agent || task.assigneeId !== agent.id || !isOpenTask(task)) return;
    if (turn.held || turn.free || result.killed === 'cancel') return;
    const L = lim();
    const acted = !['working', 'rework'].includes(task.status) || task.pendingClaims?.length > 0 || ownOpenAsk(agent);
    const fails = { ...(task.fails ?? {}) };
    if ((result.killed === 'timeout' || result.killed === 'idle') && !acted) {
      if ((fails.timeout ?? 0) < 1) {
        ctx.patch('tasks', task.id, { fails: { ...fails, timeout: 1 }, resumeNote: ctx.prompts.nudge('timeout') });
      } else K.stop(task, 'failed', null, 'The work turn ran out of time twice.');
      return;
    }
    if (!result.ok && !result.killed && result.error && !acted) {
      if ((fails.error ?? 0) < 1) {
        ctx.patch('tasks', task.id, { fails: { ...fails, error: 1 }, resumeNote: 'Your last turn ended with an error. Continue the task.' });
      } else K.stop(task, 'blocked', 'error', oneLine(result.error.message, 400));
      return;
    }
    let open = [];
    try { open = ctx.board.openFor(agent.id); } catch { open = []; }
    if (open.length && !task.gated) {
      ctx.patch('tasks', task.id, { gated: true, ...(FROZEN.has(task.status) ? { gate: { ids: open.map((m) => m.id) } } : { resumeNote: ctx.prompts.nudge('open', open.map((m) => m.id).join(', ')) }) });
      return;
    }
    if (turn.meta?.frozen || acted) {
      if (task.gated && !open.length) ctx.patch('tasks', task.id, { gated: false });
      return;
    }
    const nudges = task.nudges ?? 0;
    if (nudges < L.maxNudges) {
      ctx.patch('tasks', task.id, { nudges: nudges + 1, resumeNote: ctx.prompts.nudge('maker', task.id) });
      return;
    }
    K.stop(task, 'blocked', 'nudges', `The maker ended ${nudges + 1} turns without DONE, BLOCK or FAIL.`);
    const mgr = ctx.crew.managerOf(task);
    ctx.evt(task.jobId, { to: mgr?.id, scope: task.id, body: `${task.id} is blocked: its maker ended its turns without DONE, BLOCK or FAIL. Use task_retry or task_cancel.` });
  };

  const acc = (slot) => {
    const m = /^(\d+)\/(\d+)$/.exec(String(slot ?? ''));
    return m ? { met: Number(m[1]), total: Number(m[2]) } : null;
  };

  /** A DONE from the task owner: the delivery (checking) and the freeze. The pipeline runs when the turn has ended. */
  K.onDone = (msg) => {
    const task = ctx.task(msg.scope);
    if (!task || !msg.fromId || msg.fromId !== task.assigneeId) return;
    if (!['working', 'rework', 'blocked'].includes(task.status)) return;
    const prev = ctx.currentDelivery(task);
    if (prev && ['checking', 'buddy', 'review'].includes(prev.status)) ctx.patch('deliveries', prev.id, { status: 'rejected', superseded: true });
    const d = ctx.put('deliveries', {
      id: ctx.store.nextId('D'), jobId: task.jobId, taskId: task.id, makerId: task.assigneeId, reviewerId: null, attempt: (task.attempts ?? 0) + 1,
      status: 'checking', summary: msg.body ?? '', acc: acc(msg.slots?.acc), tests: msg.slots?.tests ?? 'none',
      stat: { files: 0, add: 0, del: 0 }, files: [], check: null, baseSha: null, headSha: null,
      flags: { empty: false, testsDeleted: 0, checkFiles: [], claimed: [], cardChanged: [] },
      doneMsgId: msg.id, buddy: null, review: null, mergeSha: null, reviewers: [],
    });
    ctx.patch('tasks', task.id, {
      status: 'checking', deliveryId: d.id, progress: 1, summary: msg.body ?? '', why: null, needsAction: null, nudges: 0,
      resumeNote: null, gated: false, gate: null, fails: {}, hold: null,
      // A hand-in while a claim waits withdraws that claim: the zone check judges the paths without it. Kept, the
      // claim would be granted later to a task in review, or stay pending on a merged task.
      ...(task.status === 'blocked' && task.why === 'claim' ? { pendingClaims: [] } : {}),
    });
    ctx.flush();
  };

  /** A BLOCK from the task owner. Returns { consult } when the hub answers it with a consult first. */
  K.onBlock = (msg) => {
    const task = ctx.task(msg.scope);
    if (!task || !msg.fromId || msg.fromId !== task.assigneeId || !['working', 'rework'].includes(task.status)) return {};
    const blocks = (task.blocks ?? 0) + 1;
    if (blocks > lim().maxBlocks) {
      ctx.patch('tasks', task.id, { blocks });
      K.stop(ctx.task(task.id), 'failed', null, `More than ${lim().maxBlocks} BLOCK posts: ${oneLine(msg.body, 300)}`);
      return {};
    }
    ctx.patch('tasks', task.id, { status: 'blocked', why: 'ask', blocks, lastError: oneLine(msg.body, 400), resumeNote: null });
    if (['tests', 'unknown'].includes(msg.slots?.why) && ctx.consult.start(ctx.task(task.id), { purpose: 'block', blockId: msg.id, body: msg.body, from: msg.from })) {
      return { consult: true };
    }
    K.needs(ctx.task(task.id), 'blocked');
    return {};
  };

  /** A FAIL from the task owner. */
  K.onFail = (msg) => {
    const task = ctx.task(msg.scope);
    // An approved crate merges: the hub owns the work from the PASS on. (The board refuses such a FAIL; a FAIL
    // that a race lets through still changes nothing.)
    if (!task || !msg.fromId || msg.fromId !== task.assigneeId || !isOpenTask(task) || task.status === 'integrating') return;
    if (FROZEN.has(task.status)) {
      // The freeze lets a maker give up (section 7). The board has closed its DONE, so the hand-in in the pipeline,
      // the buddy check or the review ends here; otherwise the reviewer finds no open DONE and the task hangs.
      const d = ctx.currentDelivery(task);
      if (d && ['checking', 'buddy', 'review'].includes(d.status)) ctx.patch('deliveries', d.id, { status: 'rejected', rejectReason: 'The maker gave up (FAIL).' });
      for (const id of [d?.reviewerId, task.buddyId]) {
        if (id && ctx.rt.turns.get(id)?.taskId === task.id) ctx.runner.cancel(id, `The maker gave up ${task.id}.`);
      }
    }
    K.stop(ctx.task(task.id), 'failed', null, `FAIL why=${msg.slots?.why ?? 'unknown'}: ${oneLine(msg.body, 400)}`);
  };

  /** A closed BLOCK sets the task back to working, only when its assignee is still the asker. */
  K.onBlockClosed = (msg) => {
    const task = ctx.task(msg.scope);
    if (!task || task.status !== 'blocked' || task.why !== 'ask' || task.assigneeId !== msg.fromId) return;
    ctx.patch('tasks', task.id, { status: 'working', why: null, needsAction: null });
  };

  /** Manager wakes for tasks that need action and got no manager turn since (section 12). */
  K.needsWakes = (job) => {
    for (const t of ctx.tasksOf(job.id, (x) => x.needsAction && isOpenTask(x))) {
      const mgr = ctx.crew.managerOf(t);
      if (!mgr || (mgr.turnSeq ?? -1) > (t.needsAction.seq ?? 0)) continue; // a manager turn started since
      ctx.wakes.add(mgr.id, { line: `${t.id} needs action: it is ${t.status}${t.why ? ` (${t.why})` : ''}. ${t.lastError ? oneLine(t.lastError, 200) : ''}`.trim(), key: `needs:${t.id}:${t.needsAction.since}` });
    }
  };

  /** Close every open item of a task as cancelled, with no wake (retry, reassign, cancel). */
  K.closeItems = (task) => {
    let list = [];
    list = ctx.openItems(task.jobId, { scope: task.id }).filter((m) => m.kind !== 'DONE');
    for (const m of list) {
      try { ctx.board.close(m.id, 'cancelled', { wake: false }); } catch { /* closed meanwhile */ }
    }
  };

  /** Give a task a new maker on the same bench with a fresh session (fallback, retry with another model). */
  K.reassign = (task, agent) => {
    const old = task.assigneeId;
    K.closeItems(task);
    if (old && ctx.busy(old)) ctx.runner.cancel(old, 'The task got another maker.');
    const key = ctx.turns.newBoardKey(agent, null, task.id);
    ctx.patch('tasks', task.id, {
      assigneeId: agent.id, sessionId: null, sessionCtx: null, boardSession: key, hold: null, started: Boolean(task.benchDir),
      retryNote: task.benchDir ? { note: 'You take over this task from another maker. The bench holds the earlier work.', lastError: task.lastError } : null,
    });
    if (old && old !== agent.id) ctx.crew.unbind(old, task.id);
    ctx.patch('agents', agent.id, { taskId: task.id });
    return ctx.task(task.id);
  };

  return K;
}
