// QA, delivering, the report, done, ship and the truck refresh (section 12, job flow steps 4-6, owner actions).
import fs from 'node:fs';
import path from 'node:path';
import { POINTER_RE } from '../shoptalk.js';
import { clip, errText, isOpenTask, oneLine, plural } from './context.js';

const POINTER_ALL = new RegExp(POINTER_RE.source, 'g');

export function createQa(ctx) {
  const Q = {};
  const headDir = (job) => path.join(ctx.paths.work, job.id, '_head');
  const setQa = (jobId, changes) => {
    const job = ctx.job(jobId);
    return ctx.patch('jobs', jobId, { qa: { ...(job?.qa ?? {}), ...changes } });
  };
  const servedOpen = (job, reqId) => ctx.tasksOf(job.id, (t) => isOpenTask(t) && t.reqs.includes(reqId)).length > 0;
  const qaRunning = (job) => {
    const a = job.qa?.agentId;
    return Boolean(a) && ctx.rt.turns.get(a)?.kind === 'qa';
  };

  /** A new task or a new open requirement in qa or delivering: back to running (during a QA turn: at its end). */
  Q.onNewWork = (jobId) => {
    const job = ctx.job(jobId);
    if (!job) return;
    if (job.status === 'qa' && qaRunning(job)) { setQa(jobId, { newWork: true }); return; }
    if (job.status === 'qa' || job.status === 'delivering') {
      ctx.patch('jobs', jobId, { status: 'running', report: null, qa: { ...(job.qa ?? {}), step: 'over' } });
      ctx.evt(jobId, { scope: '#plan', body: `Work order ${jobId} has new work. It runs again.` });
    } else if (job.status === 'paused' && (job.prevStatus === 'qa' || job.prevStatus === 'delivering')) {
      // Paused in qa or delivering: the resume goes back to running, never to a report or a QA round that
      // does not know the new work.
      ctx.patch('jobs', jobId, { prevStatus: 'running', report: null, qa: { ...(job.qa ?? {}), step: 'over', newWork: false } });
    }
  };

  /** Entry to qa: no open task, at least one merged, no owner change waits. */
  Q.maybeEnter = (job) => {
    if (job.status !== 'running') return false;
    const tasks = ctx.tasksOf(job.id);
    if (!tasks.some((t) => t.status === 'merged') || tasks.some(isOpenTask)) return false;
    if ((job.changes ?? []).some((c) => !c.done)) return false;
    if (job.redCheck || ctx.stepsOf(job.id)) return false;
    const L = ctx.limits();
    const round = (job.qa?.round ?? 0) + 1;
    if (round > L.maxQaRounds + (job.qaExtra ?? 0)) {
      const failed = job.requirements.filter((r) => r.status === 'failed').map((r) => `${r.id}: ${oneLine(r.evidence, 100)}`);
      ctx.pauseJob(job, 'qa', `QA ran ${round - 1} rounds. Failed: ${failed.join('; ') || 'none listed'}.`);
      return true;
    }
    ctx.patch('jobs', job.id, {
      status: 'qa',
      qa: { round, sha: job.intSha, agentId: null, sessionId: job.qa?.sessionId ?? null, sessionAgent: job.qa?.sessionAgent ?? null, step: 'refresh', tries: 0, nudged: false, taskNudged: false, leadWoken: false, newWork: false, verifiedAt: null },
      requirements: job.requirements.map((r) => (r.status === 'waived' ? r : { ...r, status: 'open', evidence: null })),
    });
    ctx.evt(job.id, { scope: '#plan', body: `QA round ${round} of ${job.id} starts.` });
    return true;
  };

  /** The tick for qa and delivering. */
  Q.tick = (job) => {
    if (job.status === 'running') return Q.maybeEnter(job);
    if (job.status === 'qa') return qaTick(job);
    if (job.status === 'delivering') return deliverTick(job);
    return false;
  };

  function qaTick(job) {
    const qa = job.qa ?? {};
    if (qa.step === 'refresh') return ctx.step(`qa:${job.id}`, job.id, () => refreshStep(job.id));
    if (qa.step === 'check') return ctx.step(`qa:${job.id}`, job.id, () => checkStep(job.id));
    if (qa.step === 'turn') return launchQa(job);
    return false;
  }

  async function refreshStep(jobId) {
    const job = ctx.job(jobId);
    const project = ctx.projectOf(job);
    if (!job || job.status !== 'qa' || job.qa?.step !== 'refresh') return;
    // QA checks the head the hub set. A move the hub made before a restart is recorded here; any other pauses.
    if (!(await ctx.integrate.tripwire(job))) return;
    if (ctx.job(jobId)?.status !== 'qa') return;
    const truck = await ctx.git.truck(project, jobId);
    if (truck.behind > 0) {
      const r = await Q.refresh(job, 'qa');
      if (!r.ok) return;
    }
    if (ctx.job(jobId)?.status === 'qa') setQa(jobId, { step: 'check', sha: ctx.job(jobId).intSha });
  }

  async function checkStep(jobId) {
    const job = ctx.job(jobId);
    const project = ctx.projectOf(job);
    if (!job || job.status !== 'qa' || job.qa?.step !== 'check') return;
    if (!project.checkCmd) { setQa(jobId, { step: 'turn', check: null }); return; }
    const hc = await ctx.git.headCheck(project, jobId);
    ctx.patch('projects', project.id, { headCheck: { sha: hc.sha, ok: hc.ok, tail: clip(hc.tail, 4000) } });
    if (ctx.job(jobId)?.status !== 'qa') return;
    if (!hc.ok) {
      setQa(jobId, { step: 'red', check: { ok: false, tail: clip(hc.tail, 4000) } });
      ctx.patch('jobs', jobId, { redCheck: { stage: 'head', cmd: project.checkCmd, tail: clip(hc.tail, 4000), at: ctx.now() } });
      return;
    }
    setQa(jobId, { step: 'turn', check: { ok: true, tail: clip(hc.tail, 4000) }, sha: hc.sha });
  }

  function launchQa(job) {
    const qa = job.qa;
    let agent = ctx.agent(qa.agentId);
    if (!agent || !ctx.crew.usable(agent)) {
      agent = ctx.crew.qaAgent(job);
      if (!agent) return false;
      setQa(job.id, { agentId: agent.id });
    }
    if (ctx.busy(agent.id) || agent.hold || agent.wake) return false;
    const project = ctx.projectOf(job);
    const resume = Boolean(qa.sessionId) && qa.sessionAgent === agent.id && agent.id !== job.leadBossId;
    const nudging = qa.pendingNudge;
    let decisions = [];
    try { decisions = ctx.board.decisions(job.id); } catch { decisions = []; }
    return ctx.turns.aux(agent, {
      kind: 'qa', scope: '#plan', auxKey: `qa.${job.id}.${qa.round}`, holdOn: 'agent',
      session: { id: resume ? qa.sessionId : null, resume },
      prep: async () => {
        const dir = headDir(job);
        if (!fs.existsSync(dir)) {
          await ctx.git.headCheck(project, job.id);
        }
        return dir;
      },
      onStart: () => setQa(job.id, { pendingNudge: null, agentId: agent.id }),
      prompt: (view) => {
        const j = ctx.job(job.id);
        if (nudging) return `${view ? `${view}\n\n` : ''}${ctx.prompts.nudge(nudging.kind, nudging.ids ?? '')}`;
        return ctx.prompts.qaPrompt(j, view, { checkCmd: project.checkCmd, check: j.qa?.check ?? null, decisions });
      },
      onEnd: (result, turn) => qaEnded(job.id, agent.id, result, turn),
    });
  }

  function qaEnded(jobId, agentId, result, turn) {
    const job = ctx.job(jobId);
    if (!job || job.status !== 'qa') return;
    if (result.sessionId) setQa(jobId, { sessionId: result.sessionId, sessionAgent: agentId });
    if (ctx.job(jobId).qa?.stale) {
      // The truck took in the owner's branch during this turn: check the new head, then a new QA turn on it.
      ctx.patch('jobs', jobId, {
        qa: { ...ctx.job(jobId).qa, stale: false, step: 'check', nudged: false, pendingNudge: null, verifiedAt: null },
        requirements: ctx.job(jobId).requirements.map((r) => (r.status === 'waived' ? r : { ...r, status: 'open', evidence: null })),
      });
      return;
    }
    if (turn.held || turn.free) return;
    const qa = ctx.job(jobId).qa;
    if (qa.newWork) {
      ctx.patch('jobs', jobId, { status: 'running', report: null, qa: { ...qa, step: 'over', newWork: false } });
      return;
    }
    const verified = qa.verifiedAt && qa.verifiedAt >= turn.startedAt;
    if (!verified && !qa.verifiedAt) {
      if (!qa.nudged && result.ok && !result.killed) { setQa(jobId, { nudged: true, pendingNudge: { kind: 'qa' } }); return; }
      const next = ctx.bosses(job).find((b) => b.id !== agentId && ctx.crew.usable(b));
      if ((qa.tries ?? 0) < 1 && next) { setQa(jobId, { tries: (qa.tries ?? 0) + 1, agentId: next.id, sessionId: null, nudged: false }); return; }
      ctx.pauseJob(job, 'error', `The QA turn failed: ${result.error?.message ?? 'no req_verify'}`);
      return;
    }
    Q.evaluate(jobId);
  }

  /** After req_verify: delivering, back to running, or the failed-requirement rule. */
  Q.evaluate = (jobId) => {
    const job = ctx.job(jobId);
    if (!job || job.status !== 'qa') return;
    const qa = job.qa ?? {};
    const notOk = job.requirements.filter((r) => r.status !== 'waived' && r.status !== 'verified');
    if (!notOk.length) {
      ctx.patch('jobs', jobId, { status: 'delivering', report: null, reportTries: 0, qa: { ...qa, step: 'done' } });
      ctx.notice('owner', `${jobId}: every requirement is verified or waived. The lead boss writes the report; then the truck waits for you.`, jobId, null, 'truck');
      ctx.evt(jobId, { scope: '#merge', body: `QA passed. ${jobId} is delivering.` });
      return;
    }
    const unserved = notOk.filter((r) => !servedOpen(job, r.id));
    if (!unserved.length) {
      ctx.patch('jobs', jobId, { status: 'running', report: null, qa: { ...qa, step: 'over' } });
      return;
    }
    const ids = unserved.map((r) => r.id).join(', ');
    if (!qa.taskNudged && qa.agentId && ctx.agent(qa.agentId) && !ctx.rt.turns.has(qa.agentId)) {
      setQa(jobId, { taskNudged: true, pendingNudge: { kind: 'qa_task', ids }, step: 'turn' });
      return;
    }
    if (!qa.leadWoken) {
      setQa(jobId, { leadWoken: true, step: 'lead', leadIds: ids });
      return;
    }
    setQa(jobId, { step: 'owner' });
    for (const r of unserved) ctx.patchReq(jobId, r.id, { ownerNotice: true });
    ctx.notice('owner', `${jobId}: ${ids} failed and no task serves them. Waive them, add a task (Request changes), or stop the job.`, jobId, null, 'inbox');
  };

  /** The lead boss is woken once for failed requirements with no serving task. */
  Q.leadTurn = (job) => {
    const lead = ctx.lead(job);
    if (!lead || ctx.busy(lead.id) || lead.hold) return false;
    const ids = job.qa.leadIds;
    return ctx.turns.main(lead, {
      kind: 'change', label: 'qa-lead',
      prompt: (view) => `${view ? `${view}\n\n` : ''}${ctx.prompts.nudge('qa_task', ids)}`,
      onEnd: (result, turn) => {
        const j = ctx.job(job.id);
        if (!j || j.status !== 'qa' || turn.held || turn.free) return;
        Q.evaluate(job.id);
      },
    });
  };

  /** req_verify (the agent of the QA turn only). */
  Q.verify = (agent, args) => {
    const job = ctx.job(agent.jobId);
    if (!job || job.status !== 'qa' || job.qa?.agentId !== agent.id || ctx.rt.turns.get(agent.id)?.kind !== 'qa') {
      return { text: 'ERR req_verify is only for the agent of the running QA turn.', isError: true };
    }
    if (job.intSha !== job.qa.sha || job.qa.stale) return { text: 'ERR The integration branch moved since this QA round started. Stop now.', isError: true };
    const results = Array.isArray(args?.results) ? args.results : [];
    const open = job.requirements.filter((r) => r.status === 'open');
    const byId = new Map(results.map((r) => [String(r?.id ?? ''), r]));
    const missing = open.filter((r) => !byId.has(r.id)).map((r) => r.id);
    if (missing.length) return { text: `ERR Give a result for every open requirement. Missing: ${missing.join(', ')}.`, isError: true };
    const dir = headDir(job);
    for (const r of open) {
      const res = byId.get(r.id);
      const evidence = String(res.evidence ?? '').trim();
      if (!evidence) return { text: `ERR ${r.id}: evidence is empty.`, isError: true };
      const pointers = (evidence.match(POINTER_ALL) ?? []).map((p) => p.replace(/:\d+(?:-\d+)?$/, '').replace(/@[0-9a-f]{7,40}$/, ''));
      const exists = pointers.some((p) => { try { return fs.existsSync(path.join(dir, p)); } catch { return false; } });
      if (res.ok === true && !exists) return { text: `ERR ${r.id}: the evidence needs a pointer to a file that exists at ${job.qa.sha.slice(0, 8)} (path or path:line).`, isError: true };
      if (res.ok !== true && !pointers.length && !/\b(?:T\d+|R\d+|\d{1,9})\b/.test(evidence)) return { text: `ERR ${r.id}: the evidence needs a pointer (path, task id or message id).`, isError: true };
    }
    const requirements = job.requirements.map((r) => {
      const res = byId.get(r.id);
      if (!res || r.status !== 'open') return r;
      return { ...r, status: res.ok === true ? 'verified' : 'failed', evidence: clip(String(res.evidence).trim(), 500) };
    });
    ctx.patch('jobs', job.id, { requirements, qa: { ...job.qa, verifiedAt: ctx.now() } });
    const failed = requirements.filter((r) => r.status === 'failed').map((r) => r.id);
    return failed.length ? `ok. Failed: ${failed.join(', ')}. Add a task for each with task_add now (reqs must list it).` : 'ok. Every requirement is verified. Stop now.';
  };

  function deliverTick(job) {
    if (!job.report) {
      const by = ctx.agent(job.reportBy) ?? ctx.lead(job);
      if (!by || ctx.busy(by.id) || by.hold) return false;
      return ctx.turns.main(by, {
        kind: 'report', label: 'report',
        prompt: (view) => ctx.prompts.reportPrompt(ctx.job(job.id), view, ctx.digest.facts(ctx.job(job.id))),
        onEnd: (result, turn) => {
          const j = ctx.job(job.id);
          if (!j || j.status !== 'delivering' || j.report || turn.held || turn.free) return;
          const tries = (j.reportTries ?? 0) + 1;
          const other = ctx.bosses(j).find((b) => b.id !== by.id && ctx.crew.usable(b));
          if (tries <= 1 && other) ctx.patch('jobs', j.id, { reportTries: tries, reportBy: other.id });
          else if (tries <= 1 && !j.reportNudged) ctx.patch('jobs', j.id, { reportTries: tries, reportNudged: true });
          else ctx.patch('jobs', j.id, { report: ctx.digest.factReport(j), reportTries: tries });
        },
      });
    }
    return Q.maybeDone(job);
  }

  /** Done: delivering, truck empty, no open task, every requirement verified or waived. */
  Q.maybeDone = (job) => {
    const j = ctx.job(job.id);
    if (!j || j.status !== 'delivering' || !j.report) return false;
    if (ctx.deliveriesOf(j.id, (d) => d.status === 'loaded').length) return false;
    if (ctx.openTasks(j.id).length) return false;
    if (j.requirements.some((r) => r.status !== 'verified' && r.status !== 'waived')) return false;
    ctx.patch('jobs', j.id, { status: 'done', hold: null });
    for (const a of ctx.agentsOf(j.id)) ctx.patch('agents', a.id, { status: 'off', taskId: null, wake: null });
    ctx.fx('confetti', { jobId: j.id });
    ctx.notice('owner', `${j.id} is done.`, j.id, null, null); // the note only informs: no panel
    const project = ctx.projectOf(j);
    if (project) {
      ctx.step(`cleanup:${j.id}`, null, async () => {
        try { await ctx.git.removeJobWork(project, j.id); } catch (err) { ctx.say('warn', 'orchestrator: removeJobWork failed', { job: j.id, error: errText(err) }); }
      });
    }
    ctx.kick();
    return true;
  };

  /** report tool (boss). */
  Q.report = (agent, args) => {
    const job = ctx.job(agent.jobId);
    if (!job || job.status !== 'delivering') return { text: 'ERR job_report is for the delivering stage.', isError: true };
    const md = String(args?.md ?? '').trim();
    if (!md) return { text: 'ERR The report is empty.', isError: true };
    // Open owner questions take their default when the truck ships: the report always lists them.
    const questions = ctx.digest.openQuestions(job);
    const extra = questions.length && !/open owner questions/i.test(md)
      ? `\n\n## Open owner questions\n\n${ctx.digest.questionLines(questions).join('\n')}` : '';
    ctx.patch('jobs', job.id, { report: `${clip(md, 20000 - extra.length)}${extra}` });
    ctx.flush();
    ctx.kick();
    return 'ok. The report is stored. Stop now.';
  };

  /**
   * The job patch for a truck refresh to `sha` (also the tripwire's record of a refresh cut off by a restart).
   * In qa, a QA turn in flight (or about to run) looked at the old tree. A running turn is marked stale (req_verify
   * refuses it, its end restarts the round). With no turn running, the round goes back to the head check on the
   * new head, and what the old tree verified is open again.
   */
  Q.refreshPatch = (job, sha) => {
    const mergeLog = [...(job.mergeLog ?? []), { sha, kind: 'refresh' }];
    if (job.status !== 'qa' || !job.qa) return { intSha: sha, refreshing: null, mergeLog };
    const qa = { ...job.qa, sha };
    if (qaRunning(job)) return { intSha: sha, refreshing: null, mergeLog, qa: { ...qa, stale: true } };
    if (qa.step !== 'turn') return { intSha: sha, refreshing: null, mergeLog, qa };
    return {
      intSha: sha, refreshing: null, mergeLog,
      qa: { ...qa, step: 'check', nudged: false, pendingNudge: null, verifiedAt: null },
      requirements: job.requirements.map((r) => (r.status === 'waived' ? r : { ...r, status: 'open', evidence: null })),
    };
  };

  /**
   * Truck refresh (section 12): the target branch moved. Clean and green: job.intSha moves to the refresh merge
   * and the owner gets a notice. Conflict or red check with no open task (qa, delivering): a catch-up task.
   * @returns {{ ok:true, moved, sha, commits } | { ok:false, reason, files? }}
   */
  Q.refresh = async (job, why) => {
    const project = ctx.projectOf(job);
    if (!(await ctx.integrate.tripwire(job))) return { ok: false, reason: 'tampered' };
    let r;
    // The intent is on disk before git moves: a restart after the refresh finds it (integrate.tripwire).
    ctx.patch('jobs', job.id, { refreshing: { from: ctx.job(job.id).intSha, at: ctx.now() } });
    await ctx.flush();
    try { r = await ctx.git.refreshTruck(project, job.id); } catch (err) { ctx.patch('jobs', job.id, { refreshing: null }); return { ok: false, reason: `The truck refresh failed: ${errText(err)}` }; }
    if (!r.ok || !r.commits.length) ctx.patch('jobs', job.id, { refreshing: null });
    if (r.ok) {
      if (!r.commits.length) return { ok: true, moved: false, sha: r.sha, commits: [] };
      ctx.patch('jobs', job.id, Q.refreshPatch(ctx.job(job.id), r.sha));
      await ctx.flush();
      ctx.notice('owner', `Your branch moved. Look again, then ship. New commits on ${project.targetBranch}: ${r.commits.slice(0, 10).map((c) => `${c.sha.slice(0, 8)} ${oneLine(c.subject, 60)}`).join('; ')}`, job.id, null, 'truck');
      ctx.evt(job.id, { scope: '#merge', body: `The truck took in ${r.commits.length} new commits of ${project.targetBranch}.` });
      return { ok: true, moved: true, sha: r.sha, commits: r.commits };
    }
    const what = r.reason === 'conflict' ? `conflicts in ${(r.files ?? []).join(', ')}` : 'a red check';
    const j = ctx.job(job.id);
    if (!ctx.openTasks(job.id).length && ['qa', 'delivering'].includes(j.status)) {
      const res = await ctx.edits.add(j, {
        title: `Catch up with ${project.targetBranch}`,
        spec: `The target branch ${project.targetBranch} moved and merging it into the truck gives ${what}. The bench starts with that merge in place. Resolve it so the check passes.`,
        acceptance: [`The bench holds the merge of ${project.targetBranch} with no conflict markers.`, 'The check command passes.'],
        zones: ['**'], domain: 'fix', size: 'M', reqs: [],
      }, 'hub', { catchUp: true });
      if (j.status === 'qa') ctx.patch('jobs', job.id, { status: 'running', report: null, qa: { ...ctx.job(job.id).qa, step: 'over' } });
      return { ok: false, reason: `The branch ${project.targetBranch} moved and the merge gives ${what}. The hub added ${res.task?.id ?? 'a catch-up task'}.`, files: r.files ?? [] };
    }
    return { ok: false, reason: `The branch ${project.targetBranch} moved and the merge gives ${what}. The truck refreshes again at the next QA round.`, files: r.files ?? [] };
  };

  /** Ship exactly one commit (owner). */
  Q.ship = async (jobId, { sha } = {}) => {
    const job = ctx.job(jobId);
    if (!job) return { ok: false, reason: 'Unknown job.' };
    const loaded = ctx.deliveriesOf(jobId, (d) => d.status === 'loaded');
    const allowed = (['running', 'qa', 'delivering', 'paused'].includes(job.status) || job.status === 'cancelled') && loaded.length > 0;
    if (!allowed) return { ok: false, reason: 'Nothing is loaded on the truck.' };
    if (typeof sha !== 'string' || !sha.trim()) return { ok: false, reason: 'Ship needs the exact commit (sha) the truck panel showed.' };
    const project = ctx.projectOf(job);
    if (job.status !== 'cancelled' && !(await ctx.integrate.tripwire(job))) return { ok: false, reason: 'The integration branch moved outside the hub. The job is paused.' };
    const truck = await ctx.git.truck(project, jobId);
    if (truck.behind > 0) {
      const r = await Q.refresh(ctx.job(jobId), 'ship');
      if (r.ok && r.moved) return { ok: false, reason: 'Your branch moved. Look again, then ship.', moved: true, sha: r.sha };
      if (!r.ok) return { ok: false, reason: r.reason, files: r.files };
    }
    const res = await ctx.git.ship(project, jobId, { sha: sha.trim() });
    if (!res.ok) return res;
    const log = ctx.job(jobId).mergeLog ?? [];
    const idx = log.findIndex((e) => e.sha === res.sha);
    const shippedIds = new Set(idx >= 0 ? log.slice(0, idx + 1).filter((e) => e.deliveryId).map((e) => e.deliveryId) : []);
    // An empty crate made no commit: its mergeSha is the head it was loaded on (a log entry, or the job's base).
    const emptyShips = (d) => d.empty === true && idx >= 0 && log.findIndex((e) => e.sha === d.mergeSha) <= idx;
    for (const d of ctx.deliveriesOf(jobId, (x) => x.status === 'loaded')) {
      if (shippedIds.has(d.id) || d.mergeSha === res.sha || emptyShips(d)) ctx.patch('deliveries', d.id, { status: 'shipped', shippedAt: ctx.now() });
    }
    const left = ctx.deliveriesOf(jobId, (x) => x.status === 'loaded').length;
    if (left === 0 && ctx.job(jobId).status === 'cancelled') await ctx.owner.dropIntegration(ctx.job(jobId));
    await ctx.flush();
    // The commit is on the target branch already (the job's base, or a crate shipped before): nothing left.
    if (res.already) { ctx.kick(); return { ok: true, sha: res.sha, left, already: true }; }
    ctx.fx('ship', { jobId, sha: res.sha });
    ctx.evt(jobId, { scope: '#merge', body: `The truck left: ${project.targetBranch} is at ${res.sha.slice(0, 10)}. ${plural(left, 'crate')} ${left === 1 ? 'stays' : 'stay'} loaded.` });
    ctx.kick();
    return { ok: true, sha: res.sha, left };
  };

  return Q;
}
