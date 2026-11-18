// Integrate (section 9 step 5, section 12): serial per project, expectHead = the reviewed bench head, or the
// hub's own sync merge after a stale answer (checked again). Success: delivery loaded, job.intSha moves, task
// merged, bench and review clone removed, EVT #merge, fresh blueprints, claims released, dependents ready.
import { LIVE, clip, errText, oneLine } from './context.js';

export function createIntegrate(ctx) {
  const I = {};

  I.tick = (job) => {
    const project = ctx.projectOf(job);
    if (!project || !LIVE.has(job.status) || ctx.rt.steps.has(`integrate:${project.id}`)) return false;
    const queue = ctx.tasksOf(job.id, (t) => t.status === 'integrating' && !t.hold)
      .map((t) => ({ t, d: ctx.currentDelivery(t) })).filter((x) => x.d?.status === 'approved')
      .sort((a, b) => (a.d.approvedAt ?? 0) - (b.d.approvedAt ?? 0));
    if (!queue.length) return false;
    return ctx.step(`integrate:${project.id}`, job.id, () => run(queue[0].t.id));
  };

  /**
   * Tripwire (section 9): job.intSha must equal the integration head. A difference pauses the job, unless the
   * difference is the hub's own move that a restart cut off before it was recorded (job.merging, job.refreshing).
   */
  I.tripwire = async (job) => {
    if (!job.integrationDir) return true;
    let head = null;
    try { head = await ctx.git.headSha(job.integrationDir); } catch { head = null; }
    if (head && job.intSha && head !== job.intSha) {
      if (await ownMove(job, head)) return true;
      ctx.pauseJob(job, 'tampered', `The integration branch moved outside the hub: it is at ${head.slice(0, 10)}, the hub set ${job.intSha.slice(0, 10)}.`);
      return false;
    }
    // The branch is where the hub set it: an intent left by a restart before git moved is void.
    const fresh = ctx.job(job.id);
    if (head && head === fresh?.intSha && (fresh.merging || fresh.refreshing) && !ctx.rt.steps.has(`integrate:${fresh.projectId}`) && !ctx.rt.steps.has(`qa:${fresh.id}`)) {
      ctx.patch('jobs', job.id, { merging: null, refreshing: null });
    }
    return true;
  };

  /**
   * The hub moved the integration branch (a merge, a truck refresh) and stopped before it stored the new head.
   * Ask git again: a repeated integrate gives the same merge (already), a repeated refresh gives the head it made.
   * Only when git names exactly the head that is there now, the move is recorded. Returns true when it was.
   */
  async function ownMove(job, head) {
    const project = ctx.projectOf(job);
    if (!project) return false;
    const m = job.merging;
    if (m && m.from === job.intSha) {
      const task = ctx.task(m.taskId);
      const d = ctx.delivery(m.deliveryId);
      if (!task || !d || task.status !== 'integrating' || task.deliveryId !== d.id || !task.benchDir) return false;
      let r = null;
      try { r = await ctx.git.integrate(project, job.id, task.id, task.benchDir, `${task.id}: ${oneLine(task.title, 60)}`, {}); } catch { r = null; }
      if (!r?.ok || r.mergeSha !== head) return false;
      ctx.say('info', 'orchestrator: recorded a merge the hub made before a restart', { jobId: job.id, taskId: task.id, mergeSha: head });
      await merged(task.id, r);
      return true;
    }
    const f = job.refreshing;
    if (f && f.from === job.intSha) {
      let r = null;
      try { r = await ctx.git.refreshTruck(project, job.id); } catch { r = null; }
      if (!r?.ok || r.sha !== head) return false;
      ctx.say('info', 'orchestrator: recorded a truck refresh the hub made before a restart', { jobId: job.id, sha: head });
      // The same rules as a refresh that was not cut off: a QA round on the old tree starts again on the new head.
      ctx.patch('jobs', job.id, ctx.qa.refreshPatch(ctx.job(job.id), head));
      ctx.notice('owner', `Your branch moved. Look again, then ship. The truck took in the new commits of ${project.targetBranch}.`, job.id, null, 'truck');
      await ctx.flush();
      return true;
    }
    return false;
  }

  /** Back to rework after a conflict or a red check at integrate; the sticky reviewer sees it again later. */
  function back(task, d, reason, { check = false } = {}) {
    ctx.patch('deliveries', d.id, { status: 'rejected', rejectReason: clip(reason, 800) });
    const attempts = (task.attempts ?? 0) + (check ? 1 : 0);
    if (attempts >= ctx.limits().maxReworks) {
      ctx.patch('tasks', task.id, { attempts });
      ctx.tasksApi.stop(ctx.task(task.id), 'failed', null, `Could not merge: ${reason}`);
      return;
    }
    ctx.patch('tasks', task.id, { status: 'rework', attempts, lastError: clip(reason, 800), rejectCause: check ? 'check' : 'conflict', reworkWake: true });
    ctx.evt(task.jobId, { to: task.assigneeId, scope: task.id, body: `${task.id} could not merge. ${oneLine(reason, 240)} Then hand in again with DONE.` });
  }

  async function run(taskId) {
    let task = ctx.task(taskId);
    let d = ctx.currentDelivery(task);
    const job = ctx.job(task?.jobId);
    const project = ctx.projectOf(job);
    if (!task || !d || !job || !project || task.status !== 'integrating' || d.status !== 'approved' || !LIVE.has(job.status)) return;
    if (!(await I.tripwire(job))) return;
    task = ctx.task(taskId);
    if (task?.status !== 'integrating') return; // the tripwire recorded this merge (a restart cut it off)
    const bench = task.benchDir;
    if (!(await ctx.git.cleanAt(bench, d.headSha))) {
      await ctx.git.resetBench(bench, d.headSha);
      ctx.evt(job.id, { scope: '#ops', body: `The bench of ${task.id} was not clean at ${d.headSha.slice(0, 8)}. The hub reset it before the merge.` });
    }
    let expect = d.headSha;
    for (let round = 0; round < 3; round++) {
      // The intent is on disk before git moves: a restart after the merge and before merged() finds it (tripwire).
      ctx.patch('jobs', job.id, { merging: { taskId, deliveryId: d.id, from: ctx.job(job.id).intSha, at: ctx.now() } });
      await ctx.flush();
      const r = await ctx.git.integrate(project, job.id, task.id, bench, `${task.id}: ${oneLine(task.title, 60)}`, { expectHead: expect });
      if (!r.ok) ctx.patch('jobs', job.id, { merging: null });
      if (r.ok) return merged(task.id, r);
      if (r.reason === 'conflict') return back(task, d, `Merge conflict: ${oneLine(r.detail, 300)}. Sync your bench with the integration branch and resolve it.`);
      if (r.reason === 'error') {
        const n = (task.integrateErrors ?? 0) + 1;
        if (n <= 1) { ctx.patch('tasks', task.id, { integrateErrors: n }); return; }
        ctx.tasksApi.stop(task, 'blocked', 'error', `Integrate failed twice: ${oneLine(r.detail, 400)}`);
        ctx.notice('owner', `${task.id} could not be merged (git error): ${oneLine(r.detail, 300)}`, job.id, null, 'blueprint');
        return;
      }
      // stale: the integration branch moved since the sync. Sync again, set up and check that exact merge.
      const s = await ctx.git.syncBench(bench);
      if (!s.ok) return back(task, d, `Merge conflict with the integration branch in: ${s.conflicts.join(', ')}. Resolve the conflict markers in your bench.`);
      if (s.merged && project.setupCmd) {
        const setup = await ctx.git.runSetup(bench, project.setupCmd, {});
        if (!setup.ok) {
          ctx.patch('deliveries', d.id, { status: 'rejected' });
          ctx.tasksApi.stop(ctx.task(taskId), 'blocked', 'env', `Setup failed on the merge with the integration branch: ${oneLine(setup.tail, 400)}`);
          return;
        }
      }
      if (project.checkCmd) {
        const c = await ctx.git.runCheck(bench, project.checkCmd, { timeoutMs: ctx.limits().checkTimeoutMin * 60000 });
        try { await ctx.git.writeHubFiles(bench, { '.shop/CHECK.log': c.tail || '(no output)' }); } catch { /* reason says it */ }
        if (!c.ok) return back(ctx.task(taskId), d, 'The check failed on the merge with the integration branch. See .shop/CHECK.log.', { check: true });
      }
      await ctx.git.resetBench(bench, s.head);
      expect = s.head;
      d = ctx.patch('deliveries', d.id, { syncSha: s.head });
      task = ctx.task(taskId);
    }
    ctx.say('warn', 'orchestrator: integrate stayed stale', { taskId });
  }

  async function merged(taskId, r) {
    const task = ctx.task(taskId);
    const d = ctx.currentDelivery(task);
    const job = ctx.job(task.jobId);
    const project = ctx.projectOf(job);
    const log = [...(job.mergeLog ?? [])];
    if (!r.empty && !log.some((e) => e.sha === r.mergeSha)) log.push({ sha: r.mergeSha, deliveryId: d.id, kind: 'delivery' });
    const assignee = task.assigneeId ? ctx.agent(task.assigneeId) : null;
    const specRosterId = assignee?.rosterId ?? task.rosterId ?? null;
    ctx.patch('jobs', job.id, { intSha: r.mergeSha, mergeLog: log, merging: null });
    ctx.patch('deliveries', d.id, { status: 'loaded', mergeSha: r.mergeSha, loadedAt: ctx.now(), empty: r.empty === true, ...(specRosterId ? { rosterId: specRosterId } : {}) });
    ctx.patch('tasks', taskId, { status: 'merged', progress: 1, hold: null, needsAction: null, why: null });
    await ctx.flush();
    const files = d.files.map((f) => f.path);
    ctx.evt(job.id, { scope: '#merge', body: `${taskId} merged. Files: ${files.slice(0, 8).join(', ') || 'none'}${files.length > 8 ? `, +${files.length - 8} more` : ''}.` });
    for (const dir of [task.benchDir, task.reviewDir]) {
      if (dir) await ctx.git.removeBench(dir).catch((err) => ctx.say('warn', 'orchestrator: bench removal failed', { dir, error: errText(err) }));
    }
    ctx.patch('tasks', taskId, { benchDir: null, reviewDir: null });
    if (specRosterId) ctx.roster?.recordOutcome?.(specRosterId, { merged: true });
    if (task.assigneeId) ctx.crew.unbind(task.assigneeId, taskId);
    ctx.digest.refreshBlueprints(job.id);
    ctx.edits.releaseClaims(job.id);
    if (job.newProject && project?.checkCmd && !project.baseline) await firstBaseline(job.id);
    ctx.kick();
  }

  /** New project: the baseline runs after the first merge; red wakes the lead to add a fix task. */
  async function firstBaseline(jobId) {
    const job = ctx.job(jobId);
    const project = ctx.projectOf(job);
    const hc = await ctx.git.headCheck(project, jobId);
    ctx.patch('projects', project.id, { baseline: { sha: hc.sha, ok: hc.ok, flaky: false, ms: hc.ms, tail: clip(hc.tail, 4000) }, headCheck: { sha: hc.sha, ok: hc.ok, tail: clip(hc.tail, 4000) } });
    if (!hc.ok) ctx.patch('jobs', jobId, { redCheck: { stage: 'first', cmd: project.checkCmd, tail: clip(hc.tail, 4000), at: ctx.now() } });
  }

  return I;
}
