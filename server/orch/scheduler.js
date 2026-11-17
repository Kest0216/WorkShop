// The event-driven scheduler (section 12): tick() reads state and starts whatever can start. It is idempotent,
// never runs twice at once (a dirty flag runs it again), and runs on every relevant event and every 3 s.
// Also: queue promotion and intake, holds and fallback, wakes, owner changes, the ledger audit, red checks,
// unserved requirements, the stall rule, and recover().
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVE, ENDED, FROZEN, LIVE, byIdNum, errText, isOpenTask, oneLine } from './context.js';

const MAX_LOOPS = 25;
const SELFTEST_REASON = 'Run the self-test for this CLI version.'; // ProviderStatus.reason (providers/index.js)

export function createScheduler(ctx) {
  const S = {};
  let ticking = false;
  let dirty = false;
  let current = null;
  let kickTimer = null;
  let interval = null;

  S.kick = () => {
    dirty = true;
    if (kickTimer || ctx.rt.stopped) return;
    kickTimer = ctx.timers.setTimeout(() => { kickTimer = null; S.tick(); }, 0);
  };

  S.tick = () => {
    if (ctx.rt.stopped) return Promise.resolve();
    if (ticking) { dirty = true; return current; }
    ticking = true;
    current = (async () => {
      try {
        let n = 0;
        do {
          dirty = false;
          try { pass(); } catch (err) { ctx.say('error', 'orchestrator: tick failed', { error: errText(err) }); }
          await null;
        } while (dirty && !ctx.rt.stopped && ++n < MAX_LOOPS);
      } finally {
        ticking = false;
      }
    })();
    return current;
  };

  S.start = () => {
    if (interval || !(ctx.tuning.tickMs > 0)) return;
    interval = ctx.timers.setInterval(() => { S.tick(); }, ctx.tuning.tickMs);
    interval?.unref?.();
  };
  S.stop = () => {
    if (interval) ctx.timers.clearInterval(interval);
    if (kickTimer) ctx.timers.clearTimeout(kickTimer);
    interval = null;
    kickTimer = null;
  };
  S.busy = () => ticking || dirty || Boolean(kickTimer);

  // ---------------------------------------------------------------- the pass

  function pass() {
    try { ctx.board.tick(ctx.now()); } catch (err) { ctx.say('warn', 'orchestrator: board tick failed', { error: errText(err) }); }
    selfTests();
    promote();
    for (const job of ctx.list('jobs').sort(byIdNum)) {
      if (!LIVE.has(job.status)) continue;
      try {
        releaseHolds(job);
        const fresh = ctx.job(job.id);
        if (fresh && LIVE.has(fresh.status)) jobPass(fresh);
      } catch (err) {
        ctx.say('error', 'orchestrator: job pass failed', { job: job.id, error: errText(err), stack: String(err?.stack ?? '').split('\n').slice(0, 4).join(' | ') });
      }
    }
  }

  function jobPass(job) {
    labHold(job);
    if (job.status === 'planning') { ctx.plan.tick(job); wakeTurns(job); return; }
    // plan_review: an owner requirement (addReq from plan_review on) wakes the lead at once (owner change turn).
    if (job.status === 'plan_review') { audit(job); wakeTurns(job); gateTurns(job); changes(job); return; }
    if (job.status === 'running') {
      ctx.tasksApi.advance(job);
      for (const t of ctx.tasksOf(job.id, isOpenTask)) ctx.tasksApi.drive(t);
      ctx.handin.tick(job);
      ctx.review.tick(job);
      ctx.integrate.tick(job);
      ctx.consult.tick(job);
      ctx.tasksApi.needsWakes(job);
    }
    wakeTurns(job);
    gateTurns(job);
    audit(job);
    changes(job);
    redCheck(job);
    if (job.status === 'running') unserved(job);
    const j = ctx.job(job.id);
    if (j.status === 'running' || j.status === 'qa' || j.status === 'delivering') ctx.qa.tick(j);
    const k = ctx.job(job.id);
    if (k.status === 'qa' && k.qa?.step === 'lead') ctx.qa.leadTurn(k);
    if (k.status === 'running' || k.status === 'qa') stall(ctx.job(job.id));
  }

  /**
   * A job is about to use a lab that has no stored self-test pass for the installed CLI version: the hub runs
   * the self-test once (section 10). Only when every other condition of usable holds (providers.ready).
   */
  function selfTests() {
    const P = ctx.providers;
    if (typeof P?.ready !== 'function' || typeof P?.selfTest !== 'function' || typeof P?.status !== 'function') return;
    if (!ctx.list('jobs').some((j) => (ACTIVE.has(j.status) || j.status === 'queued') && !ctx.isMock(j))) return;
    for (const id of ['claude', 'gemini']) {
      let st = null;
      try { st = P.status(id); } catch { st = null; }
      if (!st || st.usable || st.reason !== SELFTEST_REASON || P.ready(id)?.ok !== true) continue;
      const key = `selftest:${id}:${st.version ?? ''}`;
      if (ctx.rt.noticed.has(key)) continue;
      ctx.rt.noticed.add(key);
      ctx.step(`selftest:${id}`, null, async () => {
        const r = await P.selfTest(id);
        if (!r?.ok) ctx.notice('owner', `The self-test of ${st.label ?? id} failed, so its agents cannot work. See the Keys panel.`, null, null, 'keys');
      });
    }
  }

  // ---------------------------------------------------------------- queue and intake

  function promote() {
    const jobs = ctx.list('jobs');
    const active = jobs.find((j) => ACTIVE.has(j.status));
    const intake = [...ctx.rt.steps.keys()].some((k) => k.startsWith('intake:'));
    const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => (a.createdAt - b.createdAt) || byIdNum(a, b));
    for (const q of queued) {
      const had = q.waitReason ?? null;
      const want = active ? `waits for ${active.id}` : had?.startsWith('waits for') ? null : had;
      if (want !== had) ctx.patch('jobs', q.id, { waitReason: want });
    }
    if (active || intake || !queued.length) return;
    ctx.step(`intake:${queued[0].id}`, null, () => S.intake(queued[0].id));
  }

  /** Intake (section 12, step 1): project, integration branch, crew, then planning. */
  S.intake = async (jobId) => {
    const job = ctx.job(jobId);
    if (!job || job.status !== 'queued') return;
    try {
      let project = ctx.projectOf(job);
      const spec = job.project ?? { mode: 'new', name: job.title };
      if (!project) {
        if (spec.mode === 'existing') {
          const r = await ctx.git.adoptProject({ path: spec.path });
          project = ctx.list('projects').find((p) => p.path === r.path) ?? null;
          const files = r.agentFiles ?? [];
          const ack = spec.agentFilesAck === true || project?.agentFilesAck === true || files.length === 0;
          if (project) project = ctx.patch('projects', project.id, { targetBranch: r.targetBranch, agentFiles: files, agentFilesAck: ack });
          else {
            project = ctx.put('projects', {
              id: ctx.store.nextId('P'), name: spec.name || path.basename(r.path), path: r.path, targetBranch: r.targetBranch, hubCreated: false,
              setupCmd: null, checkCmd: null, noCheckReason: null, agentFiles: files, agentFilesAck: ack, baseline: null, headCheck: null,
            });
          }
        } else {
          const r = await ctx.git.initProject({ name: spec.name || job.title });
          project = ctx.put('projects', {
            id: ctx.store.nextId('P'), name: spec.name || job.title, path: r.path, targetBranch: r.targetBranch, hubCreated: true,
            setupCmd: null, checkCmd: null, noCheckReason: null, agentFiles: [], agentFilesAck: true, baseline: null, headCheck: null,
          });
        }
        ctx.patch('jobs', jobId, { projectId: project.id });
      }
      const started = await ctx.git.startJob(project, jobId);
      const now = ctx.job(jobId);
      if (now?.status === 'cancelled') {
        // Cancelled during intake: the integration branch made just now goes with its worktree.
        try { await ctx.git.removeJobWork(project, jobId, { force: true, keepRefs: true }); } catch (err) { ctx.say('warn', 'orchestrator: removeJobWork after a cancelled intake failed', { jobId, error: errText(err) }); }
        return;
      }
      if (!now || now.status !== 'queued') return;
      const crew = ctx.agentsOf(jobId).length ? null : ctx.crew.createCrew(now);
      const bosses = ctx.agentsOf(jobId, (a) => a.role === 'boss');
      if (!bosses.length) {
        ctx.patch('jobs', jobId, { hold: { reason: 'nolab', lab: null, until: null }, waitReason: 'No usable lab for a boss.' });
        ctx.notice('owner', `${jobId} waits: no lab can run a boss now. Sign in or choose a mode in the Keys panel.`, jobId, `nolab:${jobId}`, 'keys');
        return;
      }
      const lead = crew?.lead ?? bosses.find((b) => b.lead) ?? bosses[0];
      ctx.patch('jobs', jobId, {
        status: 'planning', integrationBranch: started.integrationBranch, integrationDir: started.integrationDir, intSha: started.intSha,
        leadBossId: lead.id, bossIds: bosses.map((b) => b.id), managerIds: ctx.agentsOf(jobId, (a) => a.role === 'manager' && !a.hidden).map((a) => a.id),
        planDrafts: {}, planning: null, waitReason: null, hold: null, mergeLog: [],
      });
      ctx.evt(jobId, { scope: '#plan', body: `Work order ${jobId} starts. ${bosses.map((b) => b.handle).join(', ')} plan it.` });
      await ctx.flush();
    } catch (err) {
      ctx.say('error', 'orchestrator: intake failed', { jobId, error: errText(err) });
      ctx.patch('jobs', jobId, { status: 'paused', prevStatus: 'queued', pauseReason: 'error', error: `Intake failed: ${oneLine(errText(err), 400)}` });
      ctx.notice('owner', `${jobId} could not start: ${oneLine(errText(err), 300)}`, jobId, null, 'blueprint');
    }
  };

  // ---------------------------------------------------------------- holds and fallback

  function releaseHolds(job) {
    const P = ctx.providers;
    const usable = (h) => (typeof P?.modelUsable === 'function' ? P.modelUsable(h.provider, h.model ?? undefined) !== false : true);
    const L = ctx.limits();
    const late = (h) => ctx.settings().allowFallback !== false && ctx.now() - (h.since ?? 0) > L.holdFallbackMin * 60000;
    for (const t of ctx.tasksOf(job.id, (x) => x.hold && isOpenTask(x))) {
      if (usable(t.hold)) { ctx.patch('tasks', t.id, { hold: null }); continue; }
      if (!late(t.hold)) continue;
      if (t.status === 'review' || t.status === 'buddy') {
        if (t.status === 'review') {
          const d = ctx.currentDelivery(t);
          if (d) ctx.patch('deliveries', d.id, { reviewerId: null, reviewers: [...new Set([...(d.reviewers ?? []), t.reviewerId].filter(Boolean))] });
          ctx.patch('tasks', t.id, { hold: null, reviewerId: null, reviewSessionId: null });
        } else {
          const d = ctx.currentDelivery(t);
          if (d) ctx.patch('deliveries', d.id, { status: 'review' });
          ctx.patch('tasks', t.id, { hold: null, status: 'review', buddyDone: true });
        }
        continue;
      }
      const maker = ctx.agent(t.assigneeId);
      const hold = { ...t.hold }; // t is the live record: the reassign below clears its hold
      const other = ctx.crew.hireMaker(job, t, { avoidProvider: hold.provider, requireOther: true });
      if (other && other.id !== maker?.id) {
        ctx.tasksApi.reassign(t, other);
        ctx.evt(job.id, { scope: t.id, body: `${t.id} moves to ${other.handle} of another lab: ${hold.provider} has been on hold for ${L.holdFallbackMin} min.` });
      } else if (maker && ctx.crew.repick(maker)) {
        ctx.patch('tasks', t.id, { hold: null, sessionId: null, sessionCtx: null, retryNote: { note: 'Your model changed. The bench holds your earlier work.', lastError: t.lastError } });
      }
    }
    // A boss or manager whose lab or model stopped being usable while it had no turn (signed out, cooling): it
    // gets a hold too, so the fallback clock runs and its duties move after holdFallbackMin. Without it nobody
    // picks a new model for it, and a delivery whose only reviewer it is waits forever (section 12, fallback).
    for (const a of ctx.agentsOf(job.id, (x) => !x.hold && x.role !== 'maker' && !x.hidden && x.status !== 'off' && !ctx.busy(x.id))) {
      if (usable({ provider: a.provider, model: a.model })) continue;
      let st = null;
      try { st = P?.status?.(a.provider) ?? null; } catch { st = null; }
      const until = st?.cooledModels?.[a.model]?.until ?? st?.cooling?.until ?? null;
      ctx.patch('agents', a.id, { hold: { reason: 'lab', provider: a.provider, model: a.model ?? null, since: ctx.now(), until } });
    }
    for (const a of ctx.agentsOf(job.id, (x) => x.hold)) {
      if (usable(a.hold)) { ctx.patch('agents', a.id, { hold: null }); continue; }
      if (!late(a.hold)) continue;
      if (a.id === job.leadBossId) {
        const next = ctx.bosses(job).find((b) => b.id !== a.id && ctx.crew.usable(b));
        if (next) {
          ctx.patch('agents', a.id, { lead: false });
          ctx.patch('agents', next.id, { lead: true, digestNext: true });
          ctx.patch('jobs', job.id, { leadBossId: next.id });
          if (a.wake) { ctx.patch('agents', next.id, { wake: a.wake }); ctx.patch('agents', a.id, { wake: null }); }
          ctx.evt(job.id, { scope: '#plan', body: `${next.handle} is the lead boss now: ${a.handle} waits for its lab.` });
          continue;
        }
      }
      ctx.crew.repick(a);
    }
  }

  /** With no usable lab the job shows job.hold and raises one owner notice. */
  function labHold(job) {
    const P = ctx.providers;
    if (typeof P?.usable !== 'function') return;
    const labs = [...new Set(ctx.agentsOf(job.id, (a) => a.status !== 'off' && !a.hidden).map((a) => a.provider))];
    if (!labs.length) return;
    const dead = labs.every((p) => P.usable(p) === false);
    if (dead && !job.hold) {
      let until = null;
      for (const p of labs) {
        const c = P.status?.(p)?.cooling?.until ?? null;
        if (c && (!until || c < until)) until = c;
      }
      ctx.patch('jobs', job.id, { hold: { reason: 'lab', lab: labs[0], until } });
      ctx.notice('owner', `${job.id} waits: no lab can run now (${labs.join(', ')}).`, job.id, `hold:${job.id}:${ctx.now()}`, 'keys');
    } else if (!dead && job.hold) ctx.patch('jobs', job.id, { hold: null });
  }

  // ---------------------------------------------------------------- main-turn intents

  /** Agents with mail get a main turn (boss, manager); makers are driven by their task. */
  function wakeTurns(job) {
    const L = ctx.tuning;
    const list = ctx.agentsOf(job.id, (a) => a.wake && a.role !== 'maker' && !a.hidden)
      .sort((a, b) => Number(b.wake.owner) - Number(a.wake.owner) || (a.wake.since - b.wake.since));
    for (const a of list) {
      if (ctx.busy(a.id) || a.hold) continue;
      const w = a.wake;
      if ((w.tries ?? 0) >= 2) {
        ctx.patch('agents', a.id, { wake: null });
        for (const m of safeOpenFor(a.id)) { try { ctx.board.escalate(m.id); } catch { /* closed */ } }
        continue;
      }
      if (a.role === 'manager' && !w.owner) {
        const now = ctx.now();
        if (now - (w.at ?? w.since) < L.managerDebounceMs && now - w.since < L.managerMaxDelayMs) continue;
      }
      const events = w.lines.length ? w.lines : ['New mail for you is on the board above.'];
      ctx.turns.main(a, {
        kind: 'digest', label: 'answers', ownLines: true,
        prompt: (view) => (a.role === 'manager' ? ctx.prompts.managerPrompt(view, events) : ctx.prompts.wakePrompt(view, { closing: w.lines.join('\n') })),
        onEnd: () => {},
      });
    }
  }

  const safeOpenFor = (id) => { try { return ctx.board.openFor(id); } catch { return []; } };

  function gateTurns(job) {
    for (const a of ctx.agentsOf(job.id, (x) => x.gate && !x.wake && x.role !== 'maker')) {
      if (!ctx.busy(a.id) && !a.hold) ctx.turns.gateTurn(a);
    }
  }

  /** Owner change turns (requestChanges, addReq): the lead turns the change into tasks citing the new id. */
  function changes(job) {
    const pending = (job.changes ?? []).find((c) => !c.done);
    if (!pending) return;
    const lead = ctx.lead(job);
    if (!lead || ctx.busy(lead.id) || lead.hold) return;
    const req = ctx.reqOf(job, pending.reqId);
    const delivery = pending.deliveryId ? ctx.delivery(pending.deliveryId) : null;
    const nudging = pending.pendingNudge === true;
    ctx.turns.main(lead, {
      kind: 'change', label: 'change', meta: { reqId: pending.reqId }, resumeOnly: nudging,
      prompt: (view) => (nudging ? `${view ? `${view}\n\n` : ''}${ctx.prompts.nudge('req', pending.reqId)}` : ctx.prompts.ownerChangePrompt(ctx.job(job.id), view, pending.text, delivery, req)),
      onStart: () => setChange(job.id, pending.reqId, { pendingNudge: false }),
      onEnd: (result, turn) => {
        if (turn.held || turn.free) return;
        const j = ctx.job(job.id);
        if (!j) return;
        const served = ctx.tasksOf(j.id, (t) => (isOpenTask(t) || t.status === 'merged') && t.reqs.includes(pending.reqId)).length > 0;
        const c = (j.changes ?? []).find((x) => x.reqId === pending.reqId) ?? pending;
        // Served, or waived by the owner while the turn ran: nothing more to do for this change.
        if (served || ctx.reqOf(j, pending.reqId)?.status === 'waived') { setChange(j.id, pending.reqId, { done: true }); return; }
        if (!result.ok || result.killed) {
          if ((c.tries ?? 0) < 1) { setChange(j.id, pending.reqId, { tries: (c.tries ?? 0) + 1 }); return; }
        } else if (!c.nudged) { setChange(j.id, pending.reqId, { nudged: true, pendingNudge: true }); return; }
        setChange(j.id, pending.reqId, { done: true });
        ctx.patchReq(j.id, pending.reqId, { ownerNotice: true, wokeLead: true });
        ctx.notice('owner', `The lead boss made no task for ${pending.reqId} ("${oneLine(pending.text, 120)}"). It stays open. Add it again, waive it, or stop the job.`, j.id, null, 'inbox');
      },
    });
  }

  function setChange(jobId, reqId, changes) {
    const job = ctx.job(jobId);
    if (!job) return;
    ctx.patch('jobs', jobId, { changes: (job.changes ?? []).map((c) => (c.reqId === reqId ? { ...c, ...changes } : c)) });
  }

  /** The ledger audit: one aux turn of the other lab with the brief and the ledger (section 12). */
  function audit(job) {
    if (job.auditDone || !['plan_review', 'running'].includes(job.status)) return;
    const auditor = ctx.crew.auditor(job);
    if (!auditor) { ctx.patch('jobs', job.id, { auditDone: true }); return; }
    if (ctx.busy(auditor.id) || auditor.hold || auditor.wake) return;
    const project = ctx.projectOf(job);
    ctx.turns.aux(auditor, {
      kind: 'audit', scope: '#plan', auxKey: `aud.${job.id}`, holdOn: 'agent',
      prep: async () => (await ctx.git.makeClone(project, job.id, `_desk/${auditor.handle}`, ctx.job(job.id).intSha, { files: ctx.digest.deskFiles(ctx.job(job.id)) })).dir,
      prompt: (view) => ctx.prompts.auditPrompt(ctx.job(job.id), view),
      onEnd: (result, turn) => {
        if (turn.held || turn.free) return;
        ctx.patch('jobs', job.id, { auditDone: true });
      },
    });
  }

  /** A red head check (QA) or a red first baseline (new project): the lead is woken to add a fix task. */
  function redCheck(job) {
    const red = job.redCheck;
    if (!red || red.woken) return;
    const lead = ctx.lead(job);
    if (!lead || ctx.busy(lead.id) || lead.hold) return;
    ctx.turns.main(lead, {
      kind: 'stall', label: 'red',
      prompt: (view) => ctx.prompts.checkFailPrompt(ctx.job(job.id), view, { stage: red.stage, cmd: red.cmd, tail: red.tail }),
      onStart: () => ctx.patch('jobs', job.id, { redCheck: { ...red, woken: true } }),
      onEnd: (result, turn) => {
        const j = ctx.job(job.id);
        if (!j) return;
        if (turn.held || turn.free) { ctx.patch('jobs', job.id, { redCheck: { ...red, woken: false } }); return; }
        ctx.patch('jobs', job.id, { redCheck: null });
      },
    });
  }

  /** A requirement that no task serves (after the audit, a cancel or the owner): one lead wake, then a notice. */
  function unserved(job) {
    if ((job.changes ?? []).some((c) => !c.done)) return;
    const ids = ctx.edits.unserved(job).filter((id) => !ctx.reqOf(job, id)?.wokeLead);
    const lead = ctx.lead(job);
    if (!ids.length || !lead || ctx.busy(lead.id) || lead.hold) {
      for (const id of ctx.edits.unserved(job)) {
        const r = ctx.reqOf(job, id);
        if (r?.wokeLead && !r.ownerNotice && !ctx.busy(lead?.id)) {
          ctx.patchReq(job.id, id, { ownerNotice: true });
          ctx.notice('owner', `${id} ("${oneLine(r.text, 120)}") has no task. Waive it, add a task (Request changes), or stop the job.`, job.id, null, 'inbox');
        }
      }
      return;
    }
    for (const id of ids) ctx.patchReq(job.id, id, { wokeLead: true });
    ctx.turns.main(lead, {
      kind: 'change', label: 'req', meta: { reqId: ids[0] },
      prompt: (view) => `${view ? `${view}\n\n` : ''}${ids.map((id) => ctx.prompts.nudge('req', id)).join('\n')}`,
      onEnd: () => {},
    });
  }

  // ---------------------------------------------------------------- the stall rule

  function signature(job) {
    const tasks = ctx.tasksOf(job.id).map((t) => `${t.id}:${t.status}:${t.attempts}:${t.retries}:${t.deps.join('+')}:${t.zones.join('+')}`);
    const reqs = job.requirements.map((r) => `${r.id}:${r.status}`);
    return `${job.status}|${tasks.join(',')}|${reqs.join(',')}`;
  }

  /**
   * Stall rule (section 12): running or qa, and no turn, no ready task, no hub step, no hold with a release
   * time, no claim wait on an open task, no board item with a live deadline. Then the lead gets one stall
   * digest; if nothing changes, the job pauses (stalled).
   */
  function stall(job) {
    if (!job || !['running', 'qa'].includes(job.status)) return;
    const agents = ctx.agentsOf(job.id);
    if (agents.some((a) => ctx.busy(a.id))) return;
    if (ctx.stepsOf(job.id)) return;
    const now = ctx.now();
    const open = ctx.openTasks(job.id);
    if (open.some((t) => t.status === 'ready' || (t.status === 'planned' && t.deps.every((d) => ['merged', 'cancelled'].includes(ctx.task(d)?.status ?? 'merged'))))) return;
    if (open.some((t) => ['checking', 'buddy', 'review', 'integrating'].includes(t.status) && !(t.status === 'review' && ctx.currentDelivery(t)?.waitHuman))) return;
    if (open.some((t) => ['working', 'rework'].includes(t.status) && !t.hold)) {
      const waiting = open.filter((t) => ['working', 'rework'].includes(t.status));
      if (waiting.some((t) => t.consult || t.awaitConsult || t.cleanFor || t.resumeNote || t.retryNote)) return;
    }
    // A hold has a release time: its reset time, or the lab fallback that comes after holdFallbackMin.
    const fallbackAt = (hold) => (ctx.settings().allowFallback !== false ? (hold.since ?? 0) + ctx.limits().holdFallbackMin * 60000 : 0);
    if ([...open, ...agents].some((x) => x.hold && ((x.hold.until && x.hold.until > now) || fallbackAt(x.hold) > now))) return;
    // A claim wait is live only while its holder can still merge: a holder that is blocked (a wait cycle, or a
    // claim wait of its own) or failed never frees the path by itself, so the stall rule must see it.
    const moving = (h) => Boolean(h) && !['blocked', 'failed'].includes(h.status);
    if (open.some((t) => t.status === 'blocked' && t.why === 'claim' && (t.pendingClaims ?? []).some((p) => moving(ctx.edits.holderOf(job.id, p, t.id))))) return;
    if (agents.some((a) => (a.wake || a.gate) && !a.hold && !a.hidden && (a.role !== 'maker' || a.taskId))) return;
    if ((job.changes ?? []).some((c) => !c.done) || job.redCheck || !job.auditDone) return;
    if (job.status === 'qa' && ['owner', 'turn', 'refresh', 'check', 'lead'].includes(job.qa?.step)) return;
    // The owner holds the next step: a verdict, or a task the owner stopped (it retries or cancels it).
    if (open.some((t) => ctx.currentDelivery(t)?.waitHuman || (t.status === 'blocked' && t.why === 'owner'))) return;
    let items = [];
    items = ctx.openItems(job.id);
    if (items.some((m) => (m.due && m.due > now) || (m.kind === 'ASK' && m.to === '@human'))) return;
    const sig = signature(job);
    if (job.stall && job.stall.sig === sig) {
      if (job.stall.woken) ctx.pauseJob(job, 'stalled', `Nothing can start in ${job.id}. ${oneLine(ctx.digest.stallStatus(job), 600)}`);
      else stallTurn(job);
      return;
    }
    ctx.patch('jobs', job.id, { stall: { sig, at: now, woken: false } });
    stallTurn(ctx.job(job.id));
  }

  function stallTurn(job) {
    const lead = ctx.lead(job);
    if (!lead || ctx.busy(lead.id)) return;
    if (lead.hold) { ctx.pauseJob(job, 'stalled', 'Nothing can start and the lead boss waits for its lab.'); return; }
    ctx.turns.main(lead, {
      kind: 'stall', label: 'stall',
      prompt: (view) => ctx.prompts.stallPrompt(ctx.job(job.id), view, ctx.digest.stallStatus(ctx.job(job.id))),
      onStart: () => ctx.patch('jobs', job.id, { stall: { ...ctx.job(job.id).stall, woken: true } }),
      onEnd: (result, turn) => {
        if (turn.held || turn.free) ctx.patch('jobs', job.id, { stall: { ...(ctx.job(job.id).stall ?? {}), woken: false } });
      },
    });
  }

  // ---------------------------------------------------------------- recover

  /**
   * recover() (section 12): the board replayed itself at createBoard. Every agent that was mid-turn is idle,
   * stale per-turn files go, an open DONE for a task that is not in checking sets it to checking, verdicts of
   * turns that died take effect, a buddy turn that died is skipped. Then one tick.
   */
  S.recover = async () => {
    // Lab cooling lives in memory only. A hold with a known reset time restores it, so a restart neither releases
    // the hold at once (a turn that fails again) nor lets the router pick the cooled model (section 10, cooling).
    const now = ctx.now();
    for (const x of [...ctx.list('tasks', (t) => t.hold && isOpenTask(t)), ...ctx.list('agents', (a) => a.hold)]) {
      const h = x.hold;
      if (!(Number(h.until) > now) || typeof ctx.providers?.cool !== 'function') continue;
      try { ctx.providers.cool(h.provider, h.until, 'a limit from before the restart', h.model ? { model: h.model } : {}); } catch { /* unknown lab */ }
    }
    for (const a of ctx.list('agents')) {
      if (['working', 'thinking', 'reviewing'].includes(a.status)) ctx.patch('agents', a.id, { status: a.role === 'maker' && !a.taskId ? 'off' : 'idle' });
      if (ctx.paths?.run) {
        try { fs.rmSync(path.join(ctx.paths.run, a.id, 'mcp-url'), { force: true }); } catch { /* not there */ }
      }
    }
    for (const job of ctx.list('jobs')) {
      if (!ACTIVE.has(job.status) || ENDED.has(job.status)) continue;
      let msgs = [];
      msgs = ctx.openItems(job.id, { kind: 'DONE' });
      for (const m of msgs) {
        const t = ctx.task(m.scope);
        if (!t || t.assigneeId !== m.fromId) continue;
        const d = ctx.currentDelivery(t);
        if (d && d.doneMsgId === m.id) {
          if (t.status !== d.status && ['checking', 'buddy', 'review'].includes(d.status) && !FROZEN.has(t.status)) ctx.patch('tasks', t.id, { status: d.status });
          continue;
        }
        if (['working', 'rework', 'blocked'].includes(t.status)) ctx.tasksApi.onDone(m);
      }
      for (const t of ctx.tasksOf(job.id, (x) => x.status === 'buddy')) {
        const d = ctx.currentDelivery(t);
        if (d?.buddyStarted && !d.buddy) {
          ctx.patch('deliveries', d.id, { status: 'review' });
          ctx.patch('tasks', t.id, { status: 'review', buddyDone: true });
        }
      }
      for (const t of ctx.tasksOf(job.id, (x) => x.status === 'review')) {
        const d = ctx.currentDelivery(t);
        if (d?.review) ctx.review.applyVerdict(t.id);
      }
      // A DONE that the board closed (a verdict, a refused hand-in) while the state of that closure was lost.
      for (const t of ctx.tasksOf(job.id, (x) => ['checking', 'buddy', 'review'].includes(x.status))) ctx.review.recoverClosed(t);
      for (const t of ctx.tasksOf(job.id, (x) => x.consult?.started)) ctx.patch('tasks', t.id, { consult: { ...t.consult, started: false } });
      if (job.stall?.woken) ctx.patch('jobs', job.id, { stall: { ...job.stall, woken: false } });
      if (job.redCheck?.woken) ctx.patch('jobs', job.id, { redCheck: { ...job.redCheck, woken: false } });
      if (job.status === 'qa' && job.qa?.step === 'red' && !job.redCheck) ctx.patch('jobs', job.id, { qa: { ...job.qa } });
      // A merge or a truck refresh that the restart cut off: record it (or pause on a real tamper) before any turn
      // runs. A QA turn must not start on the old tree.
      if (job.merging || job.refreshing) await ctx.integrate.tripwire(ctx.job(job.id));
      // A card on disk can be newer than the state (a claim grant that the restart lost): write it again from
      // the state, so the maker's ZONES are the ones the zone check uses.
      for (const t of ctx.tasksOf(job.id, (x) => isOpenTask(x) && x.benchDir && fs.existsSync(x.benchDir))) await ctx.digest.writeCard(t);
    }
    await ctx.flush();
    S.start();
    await S.tick();
  };

  return S;
}
