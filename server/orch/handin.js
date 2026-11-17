// Hand-in pipeline (section 12): commitAll, guard, zone check, syncBench (+ setup), runCheck, resetBench,
// then buddy or review. Any failure: delivery rejected, task rework, the hub posts FIX re:<done> as @hub.
// Also the circuit breaker for refused hand-ins.
import { matchZone } from '../gitops.js';
import { LIVE, clip, errText, oneLine } from './context.js';

const CAUSES = new Set(['check', 'zone', 'guard', 'setup']);

export function createHandin(ctx) {
  const H = {};

  /** Pipeline steps for tasks in checking whose maker's turn has ended. */
  H.tick = (job) => {
    let started = false;
    for (const t of ctx.tasksOf(job.id, (x) => x.status === 'checking')) {
      const d = ctx.currentDelivery(t);
      if (!d || d.status !== 'checking' || ctx.busy(t.assigneeId)) continue;
      started = ctx.step(`handin:${t.id}`, job.id, () => pipeline(t.id)) || started;
    }
    return started;
  };

  /** 3 hand-ins in a row from different tasks refused for the same cause: the job pauses (caps). */
  H.noteRefusal = (jobId, taskId, cause) => {
    if (!CAUSES.has(cause)) return;
    const job = ctx.job(jobId);
    if (!job) return;
    const log = [...(job.handins ?? []), { taskId, cause }].slice(-3);
    ctx.patch('jobs', jobId, { handins: log });
    if (log.length === 3 && log.every((e) => e.cause === cause) && new Set(log.map((e) => e.taskId)).size === 3) {
      ctx.patch('jobs', jobId, { handins: [] });
      ctx.pauseJob(job, 'caps', `Three hand-ins from different tasks in a row were refused for the same cause (${cause}).`);
    }
  };
  const noteSuccess = (jobId) => { if ((ctx.job(jobId)?.handins ?? []).length) ctx.patch('jobs', jobId, { handins: [] }); };

  /** The hub's FIX for a refused hand-in. It closes the DONE as fix and wakes the maker. */
  H.postFix = (jobId, doneId, reason, ansId = null) => {
    const text = `${clip(oneLine(reason, 500), 500)}${ansId ? ` 2. See the consult answer in message ${ansId}.` : ''}`;
    const msg = ctx.hubLine(jobId, `FIX re:${doneId}: 1. ${text}`);
    if (msg) return msg;
    try { ctx.board.close(doneId, 'fix', { wake: true }); } catch { /* closed meanwhile */ }
    const done = ctx.board.get?.(doneId);
    return ctx.evt(jobId, { to: done?.fromId ?? undefined, scope: done?.scope ?? '#ops', body: `Your hand-in ${doneId} was refused: ${oneLine(reason, 300)}` });
  };

  /** A refused hand-in (pipeline). conflict: a merge conflict found by the hub does not raise attempts. */
  function refuse(taskId, reason, cause, { conflict = false } = {}) {
    const task = ctx.task(taskId);
    const d = ctx.currentDelivery(task);
    if (!task || !d) return;
    ctx.patch('deliveries', d.id, { status: 'rejected', rejectReason: clip(reason, 1000) });
    const attempts = (task.attempts ?? 0) + (conflict ? 0 : 1);
    const refusals = (task.refusals ?? 0) + 1;
    const L = ctx.limits();
    H.noteRefusal(task.jobId, taskId, cause);
    if (attempts >= L.maxReworks) {
      ctx.patch('tasks', taskId, { attempts, refusals });
      try { ctx.board.close(d.doneMsgId, 'fix', { wake: false }); } catch { /* closed */ }
      ctx.tasksApi.stop(ctx.task(taskId), 'failed', null, `The hand-in was refused ${attempts} times. Last reason: ${reason}`);
      return;
    }
    ctx.patch('tasks', taskId, { status: 'rework', attempts, refusals, lastError: clip(reason, 1000), rejectCause: cause, reworkWake: true });
    if (refusals === 2) {
      const mgr = ctx.crew.managerOf(task);
      if (mgr) ctx.wakes.add(mgr.id, { line: `${taskId}: the hand-in was refused twice. Last reason: ${oneLine(reason, 200)}`, key: `refused2:${taskId}:${d.id}` });
      if (ctx.consult.start(ctx.task(taskId), { purpose: 'refusal', doneId: d.doneMsgId, reason })) return;
    }
    H.postFix(task.jobId, d.doneMsgId, reason);
  }

  async function pipeline(taskId) {
    const task = ctx.task(taskId);
    const d = ctx.currentDelivery(task);
    const job = ctx.job(task?.jobId);
    const project = ctx.projectOf(job);
    const agent = ctx.agent(task?.assigneeId);
    if (!task || !d || !job || !project || !agent || task.status !== 'checking' || d.status !== 'checking' || !LIVE.has(job.status)) return;
    const bench = task.benchDir;
    const still = () => {
      const t = ctx.task(taskId);
      return t && t.status === 'checking' && t.deliveryId === d.id;
    };
    // 1. commit
    try {
      await ctx.git.commitAll(bench, `${task.id}: ${oneLine(task.title, 60)}`, agent.name);
    } catch (err) {
      return refuse(taskId, errText(err), 'guard');
    }
    // 2. guard
    let flags;
    const g = await ctx.git.guard(bench, undefined, { allowLarge: task.allowLarge === true });
    if (!still()) return;
    if (!g.ok) {
      if (g.why === 'empty' && task.emptyOnce) flags = { testsDeleted: 0, checkFiles: [], ...(g.flags ?? {}), empty: true };
      else {
        if (g.why === 'empty') ctx.patch('tasks', taskId, { emptyOnce: true });
        return refuse(taskId, g.detail || 'No changes found in your bench.', 'guard');
      }
    } else flags = g.flags;
    // 3. zone check: changed files must match zones + claims
    const changed = await ctx.git.changedFiles(bench);
    const claims = task.claims ?? [];
    const outside = changed.filter((p) => !matchZone(p, task.zones) && !claims.includes(p));
    if (outside.length) {
      // The refused files are in a bench commit now: the next accepted hand-in is squashed (gitops guard).
      if (typeof ctx.git.taintBench === 'function') {
        try { await ctx.git.taintBench(bench); } catch (err) { ctx.say('warn', 'orchestrator: could not mark the bench tainted', { taskId, error: errText(err) }); }
      }
      if (!still()) return;
      return refuse(taskId, `These files are outside your zones: ${outside.slice(0, 20).join(', ')}${outside.length > 20 ? ', ...' : ''}. Claim them with the claim tool, or undo the changes.`, 'zone');
    }
    const claimed = changed.filter((p) => !matchZone(p, task.zones) && claims.includes(p));
    // 4. sync with the integration head (again when it moved meanwhile)
    let base = ctx.job(job.id).intSha;
    let sync = null;
    for (let i = 0; i < 3; i++) {
      sync = await ctx.git.syncBench(bench);
      const now = ctx.job(job.id).intSha;
      if (!sync.ok || now === base) break;
      base = now;
    }
    if (!still()) return;
    if (!sync.ok) {
      return refuse(taskId, `Merge conflict with the integration branch in: ${sync.conflicts.join(', ')}. Resolve the conflict markers in your bench, then hand in again.`, 'conflict', { conflict: true });
    }
    if (sync.merged && project.setupCmd) {
      const s = await ctx.git.runSetup(bench, project.setupCmd, {});
      if (!s.ok) {
        ctx.patch('deliveries', d.id, { status: 'rejected', rejectReason: 'setup failed' });
        ctx.tasksApi.stop(ctx.task(taskId), 'blocked', 'env', `Setup failed after the sync (exit ${s.code}): ${oneLine(s.tail, 600)}`);
        H.noteRefusal(job.id, taskId, 'setup');
        return;
      }
    }
    // 5. check
    let check = null;
    if (project.checkCmd) {
      const c = await ctx.git.runCheck(bench, project.checkCmd, { timeoutMs: ctx.limits().checkTimeoutMin * 60000 });
      check = { cmd: project.checkCmd, ok: c.ok, tail: c.tail };
      try { await ctx.git.writeHubFiles(bench, { '.shop/CHECK.log': c.tail || '(no output)' }); } catch { /* the reason still says it */ }
      if (!still()) return;
      if (!c.ok) {
        ctx.patch('deliveries', d.id, { check });
        return refuse(taskId, 'Check failed. See .shop/CHECK.log.', 'check');
      }
    }
    // 6. the bench is clean at the checked head
    await ctx.git.resetBench(bench, sync.head);
    // 7. the delivery goes to buddy or review
    const stat = await ctx.git.diffStat(bench);
    if (!still()) return;
    const t = ctx.task(taskId);
    const cardChanged = (t.cardChanges ?? []).map((c) => `${c.by}: ${c.what}`);
    // An owner verdict given while the hub checked (review.onVerdict) takes effect in review, with no buddy step.
    const owner = ctx.delivery(d.id)?.review ?? null;
    const next = t.pair && !t.buddyDone && !owner ? 'buddy' : 'review';
    ctx.patch('deliveries', d.id, {
      status: next, baseSha: base, headSha: sync.head, stat: { files: stat.files.length, add: stat.add, del: stat.del }, files: stat.files,
      check, flags: { empty: Boolean(flags.empty), testsDeleted: flags.testsDeleted ?? 0, checkFiles: flags.checkFiles ?? [], claimed, cardChanged },
      squashed: g.ok === true && g.squashed === true,
      ...(owner ? { review: { ...owner, headSha: sync.head } } : {}),
    });
    ctx.patch('tasks', taskId, { status: next, baseSha: base, headSha: sync.head, refusals: 0, rejectCause: null, ...(owner ? { lastReviewedSha: sync.head } : {}) });
    noteSuccess(job.id);
    await ctx.flush();
  }

  return H;
}
