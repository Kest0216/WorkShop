// Buddy check and review (section 12). Both run in the review clone <task>.rev at delivery.headSha with read
// access. A verdict is stored with headSha and takes effect when the reviewer's turn ends. The reviewer is
// sticky (task.reviewerId, task.reviewSessionId); a no-show goes to the next reviewer, at most maxReviewers,
// then the delivery waits for @human.
import { listItems } from '../shoptalk.js';
import { LIVE, oneLine } from './context.js';

export function createReview(ctx) {
  const R = {};

  async function reviewClone(task, d) {
    const job = ctx.job(task.jobId);
    const project = ctx.projectOf(job);
    const files = { '.shop/TASK.md': ctx.digest.cardText(task), '.shop/CHECK.log': d.check ? d.check.tail || '(no output)' : 'No check command: NOT CHECKED.' };
    const { dir } = await ctx.git.makeClone(project, job.id, `${task.id}.rev`, d.headSha, { files, stripAgentFiles: true });
    ctx.patch('tasks', task.id, { reviewDir: dir });
    return dir;
  }

  /** The FIX items of the last review of this task, for a sticky re-review. */
  function previous(task, d) {
    if (!task.lastReviewedSha || task.lastReviewedSha === d.headSha) return undefined;
    const earlier = ctx.deliveriesOf(task.jobId, (x) => x.taskId === task.id && x.id !== d.id && x.review).pop();
    if (!earlier) return undefined;
    const items = earlier.review.verdict === 'changes' ? earlier.review.mustFix : [task.lastError ?? 'The work could not merge after your PASS.'];
    // A squashed hand-in has a new history: the reviewed commit is gone from it, so the reviewer reads the whole diff.
    return { fixItems: items.length ? items : [oneLine(earlier.review.notes, 200)], lastReviewedSha: d.squashed ? null : task.lastReviewedSha };
  }

  /** Clean the bench at the reviewed head before a rework wake that follows a FIX verdict (section 9 step 5). */
  function clean(task) {
    ctx.step(`clean:${task.id}`, task.jobId, async () => {
      const t = ctx.task(task.id);
      if (!t?.cleanFor || !t.benchDir) return;
      if (!(await ctx.git.cleanAt(t.benchDir, t.cleanFor))) {
        await ctx.git.resetBench(t.benchDir, t.cleanFor);
        ctx.evt(t.jobId, { scope: '#ops', body: `The bench of ${t.id} was not clean at ${t.cleanFor.slice(0, 8)}. The hub reset it.` });
      }
      ctx.patch('tasks', t.id, { cleanFor: null });
    });
  }

  R.tick = (job) => {
    if (!LIVE.has(job.status)) return false;
    let started = false;
    for (const t of ctx.tasksOf(job.id, (x) => x.status === 'rework' && x.cleanFor && !ctx.busy(x.assigneeId))) clean(t);
    for (const t of ctx.tasksOf(job.id, (x) => x.status === 'buddy' && !x.hold)) started = buddy(job, t) || started;
    for (const t of ctx.tasksOf(job.id, (x) => x.status === 'review' && !x.hold)) started = review(job, t) || started;
    return started;
  };

  const toReview = (task, d) => {
    ctx.patch('deliveries', d.id, { status: 'review' });
    ctx.patch('tasks', task.id, { status: 'review', buddyDone: true });
  };

  function buddy(job, task) {
    const d = ctx.currentDelivery(task);
    if (!d || d.status !== 'buddy') return false;
    if (d.buddy) { applyBuddy(task.id); return true; }
    let mate = ctx.agent(task.buddyId);
    if (!mate || mate.id === task.assigneeId) {
      mate = ctx.crew.buddyFor(job, task, ctx.agent(task.assigneeId));
      if (!mate) { toReview(task, d); return true; }
      ctx.patch('tasks', task.id, { buddyId: mate.id });
    }
    if (ctx.busy(mate.id) || mate.hold || mate.wake || d.buddyStarted) return false;
    return ctx.turns.aux(mate, {
      kind: 'buddy', taskId: task.id, scope: task.id, auxKey: `bud.${d.id}`, holdOn: 'task',
      prep: () => reviewClone(ctx.task(task.id), d),
      onStart: () => ctx.patch('deliveries', d.id, { buddyStarted: true }),
      prompt: (view) => {
        const t = ctx.task(task.id);
        return ctx.prompts.reviewPrompt(t, ctx.delivery(d.id), ctx.digest.cardText(t), { maker: ctx.agent(t.assigneeId)?.handle ?? 'the maker', buddy: true }, view);
      },
      onEnd: (result, turn) => {
        if (turn.held) { ctx.patch('deliveries', d.id, { buddyStarted: false }); return; }
        if (ctx.agent(mate.id)?.taskId === null) ctx.patch('agents', mate.id, { status: 'off' });
        applyBuddy(task.id);
      },
    });
  }

  /** The buddy verdict takes effect at the end of its turn. No verdict: the step is skipped. */
  function applyBuddy(taskId) {
    const task = ctx.task(taskId);
    const d = ctx.currentDelivery(task);
    if (!task || !d || d.status !== 'buddy' || task.status !== 'buddy') return;
    if (d.buddy?.verdict === 'changes') {
      ctx.patch('deliveries', d.id, { status: 'rejected' });
      R.sendBack(task, `The buddy check asked for changes (message ${d.buddy.msgId}).`, 'buddy', { buddyDone: true });
      return;
    }
    toReview(task, d);
  }

  /**
   * A task goes back to rework after a FIX verdict: attempts rise (failed at maxReworks), the bench is cleaned
   * at the reviewed head, and the maker is woken.
   */
  R.sendBack = (task, reason, cause, extra = {}) => {
    const attempts = (task.attempts ?? 0) + 1;
    const assignee = task.assigneeId ? ctx.agent(task.assigneeId) : null;
    if (assignee?.rosterId) ctx.roster?.recordOutcome?.(assignee.rosterId, { reworked: true });
    const d = ctx.currentDelivery(task);
    if (attempts >= ctx.limits().maxReworks) {
      ctx.patch('tasks', task.id, { attempts, ...extra });
      ctx.tasksApi.stop(ctx.task(task.id), 'failed', null, `${attempts} rounds of changes. Last: ${reason}`);
      return;
    }
    ctx.patch('tasks', task.id, { status: 'rework', attempts, lastError: reason, rejectCause: cause, reworkWake: true, cleanFor: d?.headSha ?? null, ...extra });
    if (task.assigneeId) ctx.wakes.add(task.assigneeId, { line: reason, key: `fix:${d?.id}` });
  };

  function review(job, task) {
    const d = ctx.currentDelivery(task);
    if (!d || d.status !== 'review') return false;
    if (d.review) {
      if (!ctx.busy(d.reviewerId)) R.applyVerdict(task.id);
      return false;
    }
    if (d.waitHuman) return false;
    let rev = ctx.agent(task.reviewerId);
    const L = ctx.limits();
    // The assigned reviewer waits for its lab (a hold, a cooled model): that is not a no-show, so it does not use
    // up a reviewer or send the delivery to the owner. Past holdFallbackMin the review moves on (section 12).
    if (rev && d.reviewerId === rev.id && rev.id !== task.assigneeId && rev.status !== 'off' && !ctx.crew.usable(rev)) {
      const since = rev.hold?.since ?? null;
      if (!(ctx.settings().allowFallback !== false && since !== null && ctx.now() - since > L.holdFallbackMin * 60000)) return false;
      ctx.patch('tasks', task.id, { reviewerId: null, reviewSessionId: null });
      ctx.patch('deliveries', d.id, { reviewerId: null });
      rev = null;
    }
    if (!rev || !ctx.crew.usable(rev) || ((d.reviewers ?? []).includes(rev.id) && d.reviewerId !== rev.id) || rev.id === task.assigneeId) {
      if ((d.reviewers ?? []).length >= L.maxReviewers) return waitHuman(task, d);
      rev = ctx.crew.reviewerFor(job, task, d);
      if (!rev) {
        // Nobody usable now (a lab cools): the delivery waits in the review queue. Nobody left at all (every boss
        // and manager had its turn): it waits for the owner's verdict, as after maxReviewers.
        return ctx.crew.reviewerFor(job, task, d, { anyState: true }) ? false : waitHuman(task, d);
      }
      const sameAsBefore = rev.id === task.reviewerId;
      ctx.patch('tasks', task.id, { reviewerId: rev.id, ...(sameAsBefore ? {} : { reviewSessionId: null }) });
      ctx.patch('deliveries', d.id, { reviewerId: rev.id, reviewers: [...new Set([...(d.reviewers ?? []), rev.id])], reviewNudged: false, reviewNudge: false });
    } else if (d.reviewerId !== rev.id) {
      ctx.patch('deliveries', d.id, { reviewerId: rev.id, reviewers: [...new Set([...(d.reviewers ?? []), rev.id])] });
    }
    if (ctx.busy(rev.id) || rev.hold || rev.wake) return false;
    const now = ctx.task(task.id);
    const dd = ctx.delivery(d.id);
    const nudging = dd.reviewNudge === true;
    const resume = Boolean(now.reviewSessionId) && now.reviewerId === rev.id;
    return ctx.turns.aux(rev, {
      kind: 'review', taskId: task.id, scope: task.id, auxKey: `rev.${task.id}.${rev.id}`, holdOn: 'task', meta: { deliveryId: d.id },
      session: { id: resume ? now.reviewSessionId : null, resume },
      prep: () => reviewClone(ctx.task(task.id), ctx.delivery(d.id)),
      onStart: () => ctx.patch('deliveries', d.id, { reviewNudge: false, reviewStartedAt: ctx.now() }),
      prompt: (view) => {
        const t = ctx.task(task.id);
        const cur = ctx.delivery(d.id);
        if (nudging) return `${view ? `${view}\n\n` : ''}${ctx.prompts.nudge('review', cur.doneMsgId)}`;
        return ctx.prompts.reviewPrompt(t, cur, ctx.digest.cardText(t), { maker: ctx.agent(t.assigneeId)?.handle ?? 'the maker', previous: previous(t, cur) }, view);
      },
      onEnd: (result, turn) => reviewEnded(task.id, d.id, rev.id, result, turn),
    });
  }

  function waitHuman(task, d) {
    if (d.waitHuman) return false;
    ctx.patch('deliveries', d.id, { waitHuman: true });
    ctx.notice('owner', `${task.id} has no reviewer verdict. Post PASS re:${d.doneMsgId} or FIX re:${d.doneMsgId} on the board.`, task.jobId, null, 'inbox');
    return false;
  }

  function reviewEnded(taskId, deliveryId, reviewerId, result, turn) {
    const task = ctx.task(taskId);
    const d = ctx.delivery(deliveryId);
    if (!task || !d) return;
    if (task.reviewerId === reviewerId && result.sessionId) ctx.patch('tasks', taskId, { reviewSessionId: result.sessionId });
    if (d.id !== task.deliveryId || d.status !== 'review') return;
    if (d.review) { R.applyVerdict(taskId); return; }
    if (turn.held || turn.free) return;
    const failed = !result.ok || Boolean(result.killed);
    if (!failed && !d.reviewNudged) {
      ctx.patch('deliveries', d.id, { reviewNudged: true, reviewNudge: true });
      return;
    }
    noShow(task, d);
  }

  /** No verdict after a nudge, or a failed review turn: the next reviewer (section 12, no-show). */
  function noShow(task, d) {
    const L = ctx.limits();
    ctx.patch('tasks', task.id, { reviewerId: null, reviewSessionId: null });
    ctx.patch('deliveries', d.id, { reviewerId: null, reviewNudged: false, reviewNudge: false });
    if ((d.reviewers ?? []).length >= L.maxReviewers) waitHuman(task, ctx.delivery(d.id));
    ctx.kick();
  }

  /** The review time of a DONE ended (board expire): stop a running review turn; its end picks the next reviewer. */
  R.onReviewExpired = (done) => {
    const task = ctx.task(done.scope);
    const d = ctx.currentDelivery(task);
    if (!d || d.doneMsgId !== done.id || d.status !== 'review' || d.review) return;
    if (d.reviewerId && ctx.busy(d.reviewerId)) ctx.runner.cancel(d.reviewerId, 'The review time is over.');
    else if (d.reviewerId) noShow(task, d);
  };

  /** A PASS or FIX re: a DONE. The buddy's is stored in delivery.buddy; the owner's applies at once. */
  R.onVerdict = (msg) => {
    const task = ctx.task(msg.scope);
    const d = ctx.currentDelivery(task);
    if (!task || !d || d.doneMsgId !== msg.re) return;
    const verdict = msg.kind === 'PASS' ? 'pass' : 'changes';
    if (msg.buddy === true) {
      if (d.status === 'buddy' && !d.buddy) ctx.patch('deliveries', d.id, { buddy: { by: msg.from, verdict, notes: msg.body ?? '', msgId: msg.id } });
      return;
    }
    if (msg.role === 'hub') return;
    const human = msg.role === 'human';
    if (!human && msg.fromId !== d.reviewerId) return;
    // The owner may give the verdict while the hub still checks the hand-in: it is stored now and takes effect when
    // the delivery reaches review (the check gate still holds; a refused hand-in drops it with the delivery).
    if (!(['review', 'buddy'].includes(d.status) || (human && d.status === 'checking')) || d.review) return;
    const reviewer = ctx.agent(msg.fromId);
    const maker = ctx.agent(task.assigneeId);
    ctx.patch('deliveries', d.id, {
      review: {
        by: msg.from, verdict, notes: msg.body ?? '', mustFix: verdict === 'changes' ? listItems(msg.body).slice(0, 5) : [], headSha: d.headSha,
        crossLab: Boolean(reviewer && maker && reviewer.provider !== maker.provider), msgId: msg.id,
      },
      ...(human ? { reviewerId: d.reviewerId } : {}),
    });
    if (d.headSha) ctx.patch('tasks', task.id, { lastReviewedSha: d.headSha });
    ctx.flush();
    if (human || !ctx.busy(msg.fromId)) R.applyVerdict(task.id);
  };

  /**
   * recover(): the DONE of the current delivery is closed on the board, but the state of that closure was lost (the
   * hub died right after the post, before the state was saved). The board is written at once, the state only
   * after a short delay. A verdict of the reviewer or the owner takes effect now; a FIX of the hub (a refused
   * hand-in) sends the task back to rework. Without this the delivery waits for a verdict on a DONE that can take
   * none. Returns true when it changed something.
   */
  R.recoverClosed = (task) => {
    const d = ctx.currentDelivery(task);
    if (!d || d.review || !d.doneMsgId || !['checking', 'buddy', 'review'].includes(d.status)) return false;
    let done = null;
    try { done = ctx.board.get?.(d.doneMsgId) ?? null; } catch { done = null; }
    if (!done || done.state === 'open' || !['passed', 'fix'].includes(done.state)) return false;
    let replies = [];
    try { replies = ctx.board.history({ jobId: task.jobId, limit: 500 }); } catch { replies = []; }
    const kind = done.state === 'passed' ? 'PASS' : 'FIX';
    const msg = replies.filter((m) => m.re === done.id && m.kind === kind && m.buddy !== true).pop();
    if (!msg) return false;
    if (msg.role === 'hub') {
      // A refused hand-in: the delivery is rejected and the task goes back to rework (the FIX woke the maker).
      const conflict = /Merge conflict/.test(msg.body ?? '');
      const attempts = (task.attempts ?? 0) + (conflict ? 0 : 1);
      ctx.patch('deliveries', d.id, { status: 'rejected', rejectReason: oneLine(msg.body, 1000) });
      if (attempts >= ctx.limits().maxReworks) {
        ctx.patch('tasks', task.id, { attempts });
        ctx.tasksApi.stop(ctx.task(task.id), 'failed', null, `The hand-in was refused ${attempts} times. Last reason: ${oneLine(msg.body, 400)}`);
      } else {
        ctx.patch('tasks', task.id, { status: 'rework', attempts, lastError: oneLine(msg.body, 1000), reworkWake: true });
      }
      ctx.say('info', 'orchestrator: a refused hand-in of before the restart took effect', { taskId: task.id, msgId: msg.id });
      return true;
    }
    if (!['review', 'buddy'].includes(d.status)) return false;
    // The board accepted this verdict, so its author was the assigned reviewer (or the owner) at that time.
    if (msg.role !== 'human' && d.reviewerId !== msg.fromId) ctx.patch('deliveries', d.id, { reviewerId: msg.fromId });
    if (msg.role !== 'human' && task.reviewerId !== msg.fromId) ctx.patch('tasks', task.id, { reviewerId: msg.fromId });
    ctx.say('info', 'orchestrator: a verdict of before the restart took effect', { taskId: task.id, msgId: msg.id, kind: msg.kind });
    R.onVerdict(msg);
    return true;
  };

  /** The stored verdict takes effect: PASS -> approved / integrating; FIX -> rejected / rework. */
  R.applyVerdict = (taskId) => {
    const task = ctx.task(taskId);
    const d = ctx.currentDelivery(task);
    if (!task || !d?.review || !['review', 'buddy'].includes(d.status)) return;
    if (d.review.verdict === 'pass') {
      ctx.patch('deliveries', d.id, { status: 'approved', approvedAt: ctx.now() });
      ctx.patch('tasks', task.id, { status: 'integrating', integrateErrors: 0 });
    } else {
      ctx.patch('deliveries', d.id, { status: 'rejected' });
      R.sendBack(task, `The review asked for changes (message ${d.review.msgId}).`, 'review');
    }
    ctx.flush();
    ctx.kick();
  };

  return R;
}
