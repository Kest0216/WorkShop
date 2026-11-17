// Owner actions (section 12, owner actions; section 12b inbox): job creation, pause, resume, cancel, delete,
// plan approval, the ledger, task stop / retry / cancel, owner posts, presence, the truck view and diffs.
import fs from 'node:fs';
import path from 'node:path';
import { formatPost, parseOptions } from '../shoptalk.js';
import { ACTIVE, ENDED, FROZEN, LIVE, byIdNum, clip, errText, isOpenTask, oneLine, plural } from './context.js';

const KINDS = ['build', 'fix', 'research'];
/** '1 crate waits on the truck of J5.' / '3 crates wait on the truck of J5.' */
const truckWaits = (n, jobId) => `${plural(n, 'crate')} ${n === 1 ? 'waits' : 'wait'} on the truck of ${jobId}.`;
const httpError = (status, message) => Object.assign(new Error(message), { status });
const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function createOwner(ctx) {
  const O = {};
  const need = (job, what = 'job') => {
    if (!job || job.deleted) throw httpError(404, `Unknown ${what}.`);
    return job;
  };

  /** A new requirement on the ledger. source: 'owner' | 'boss'. */
  O.newReq = (jobId, { text, source, servesReq = null }) => {
    const job = ctx.job(jobId);
    const n = Math.max(0, ...job.requirements.map((r) => Number(String(r.id).slice(1)) || 0)) + 1;
    const req = { id: `R${n}`, text: clip(str(text), 1000), source, status: 'open', evidence: null, waivedReason: null };
    if (servesReq) req.servesReq = servesReq;
    ctx.patch('jobs', jobId, { requirements: [...job.requirements, req] });
    return req;
  };

  O.createJob = (input = {}) => {
    const s = ctx.settings();
    const title = str(input.title);
    const brief = str(input.brief);
    if (!title || title.length > 200) throw httpError(400, 'Give a title (at most 200 characters).');
    if (!brief || brief.length > 20000) throw httpError(400, 'Give a brief (at most 20000 characters).');
    const kind = KINDS.includes(input.kind) ? input.kind : input.kind === undefined ? 'build' : null;
    if (!kind) throw httpError(400, 'kind must be build, fix or research.');
    const p = input.project ?? { mode: 'new' };
    if (!['new', 'existing'].includes(p.mode)) throw httpError(400, 'project.mode must be new or existing.');
    if (p.mode === 'existing' && !str(p.path)) throw httpError(400, 'An existing project needs its folder path.');
    let crew = input.crew ?? s.defaultCrew;
    if (typeof crew === 'string') {
      if (!s.crewPresets?.[crew]) throw httpError(400, `Unknown crew preset ${crew}.`);
      crew = s.crewPresets[crew];
    }
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!crew || !int(crew.bosses, 1, 6) || !int(crew.managers, 0, 6) || !int(crew.makers, 1, 8)) throw httpError(400, 'crew needs bosses 1-6, managers 0-6 and makers 1-8.');
    const mock = input.options?.mock === true;
    let budgetUsd = input.budgetUsd ?? null;
    if (budgetUsd !== null && !(typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd >= 0)) throw httpError(400, 'budgetUsd must be a number of dollars.');
    if (budgetUsd === null && !mock) {
      const billed = ['claude', 'gemini'].filter((id) => s.auth?.[id] === 'apikey' && ctx.providers?.usable?.(id));
      if (billed.length) throw httpError(400, `Give budgetUsd: ${billed.join(' and ')} bill per token (API-key mode).`);
    }
    const job = {
      id: ctx.store.nextId('J'), title, brief, kind, projectId: null, newProject: p.mode === 'new',
      project: { mode: p.mode, name: str(p.name) || null, path: str(p.path) || null, agentFilesAck: p.agentFilesAck === true },
      crew: { bosses: crew.bosses, managers: crew.managers, makers: crew.makers },
      options: {
        approvePlan: typeof input.options?.approvePlan === 'boolean' ? input.options.approvePlan : s.approvePlan === true, mock,
        // The pace of the mock lab for this job only (the demo). Other jobs use settings.mockSpeed.
        ...(mock && typeof input.options?.mockSpeed === 'number' && input.options.mockSpeed >= 0 && input.options.mockSpeed <= 20 ? { mockSpeed: input.options.mockSpeed } : {}),
      },
      status: 'queued', prevStatus: null, pauseReason: null, hold: null, requirements: [], assumptions: [], notes: '',
      planDrafts: null, dropped: [], auditDone: false, leadBossId: null, bossIds: [], managerIds: [], integrationBranch: null,
      integrationDir: null, intSha: null, qa: null, cost: { billedUsd: 0, estUsd: 0, inTok: 0, outTok: 0 }, budgetUsd,
      report: null, error: null, waitReason: null, changes: [], mergeLog: [],
    };
    ctx.put('jobs', job);
    ctx.kick();
    return ctx.job(job.id);
  };

  O.pauseJob = (id, { hard = false } = {}) => {
    const job = need(ctx.job(id));
    if (!ACTIVE.has(job.status)) throw httpError(409, `${id} is ${job.status}: only a live job can be paused.`);
    if (hard) for (const a of ctx.agentsOf(id)) if (ctx.busy(a.id)) ctx.runner.interrupt(a.id, 'The owner paused the job.');
    if (job.status === 'paused') return job;
    return ctx.pauseJob(job, 'owner', null, { notice: false });
  };

  O.resumeJob = async (id, { budgetUsd } = {}) => {
    const job = need(ctx.job(id));
    if (job.status !== 'paused') throw httpError(409, `${id} is not paused.`);
    const other = ctx.list('jobs').find((j) => j.id !== id && ACTIVE.has(j.status));
    if (other) throw httpError(409, `${other.id} is active. Pause it or let it finish first.`);
    const billed = Number(job.cost?.billedUsd) || 0;
    const changes = {};
    if (budgetUsd !== undefined && budgetUsd !== null) {
      if (!(typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd >= 0)) throw httpError(400, 'budgetUsd must be a number.');
      changes.budgetUsd = budgetUsd;
    }
    if (job.pauseReason === 'budget' && !((changes.budgetUsd ?? job.budgetUsd ?? Infinity) > billed)) {
      throw httpError(400, `Give a budgetUsd above $${billed.toFixed(2)}, the amount billed so far.`);
    }
    if (job.pauseReason === 'caps') changes.handins = [];
    if (job.pauseReason === 'qa') changes.qaExtra = (job.qaExtra ?? 0) + 1;
    if (job.pauseReason === 'baseline') changes.planning = { ...(job.planning ?? {}), baselineTries: 0, resubmit: null, baselineOk: false };
    if (job.pauseReason === 'stalled') changes.stall = null;
    if (job.pauseReason === 'error' && job.prevStatus === 'planning' && !Object.keys(job.planDrafts ?? {}).length) changes.planning = null;
    if (job.pauseReason === 'tampered' && job.integrationDir) {
      try { changes.intSha = (await ctx.git.headSha(job.integrationDir)) ?? job.intSha; } catch { /* keep */ }
    }
    const status = job.prevStatus && job.prevStatus !== 'paused' ? job.prevStatus : 'running';
    const out = ctx.patch('jobs', id, { ...changes, status, prevStatus: null, pauseReason: null, error: null, hold: null });
    ctx.evt(id, { scope: '#ops', body: `Work order ${id} runs again.` });
    ctx.kick();
    return out;
  };

  const removeDir = async (dir) => {
    if (!dir) return;
    try { await ctx.git.removeBench(dir); } catch (err) { ctx.say('debug', 'orchestrator: folder removal skipped', { dir, error: errText(err) }); }
  };

  O.cancelJob = async (id) => {
    const job = need(ctx.job(id));
    if (ENDED.has(job.status)) throw httpError(409, `${id} is ${job.status} already.`);
    const loaded = ctx.deliveriesOf(id, (d) => d.status === 'loaded').length;
    ctx.patch('jobs', id, { status: 'cancelled', prevStatus: job.status, hold: null, truckKept: loaded > 0, waitReason: null });
    for (const a of ctx.agentsOf(id)) if (ctx.busy(a.id)) ctx.runner.cancel(a.id, 'The owner cancelled the job.');
    // Turns that were still making their folder, and hub steps (hand-in, integrate) in flight, end first: else a
    // review clone or a bench write could land after the folders below are gone.
    await settleJob(id);
    const loadedNow = ctx.deliveriesOf(id, (d) => d.status === 'loaded').length; // an integrate in flight may have loaded one more
    if (loadedNow !== loaded) ctx.patch('jobs', id, { truckKept: loadedNow > 0 });
    const project = ctx.projectOf(job);
    for (const t of ctx.tasksOf(id)) {
      if (t.benchDir && project) {
        try {
          const ref = await ctx.git.saveBench(project, id, t.id, t.benchDir, ctx.agent(t.assigneeId)?.name ?? 'Maker');
          if (ref) ctx.patch('tasks', t.id, { savedRef: ref });
        } catch (err) { ctx.say('warn', 'orchestrator: saveBench failed', { task: t.id, error: errText(err) }); }
        await removeDir(t.benchDir);
      }
      await removeDir(t.reviewDir);
      ctx.patch('tasks', t.id, { benchDir: null, reviewDir: null, ...(isOpenTask(t) ? { status: 'cancelled', hold: null, needsAction: null } : {}) });
    }
    if (ctx.paths?.work) {
      const root = path.join(ctx.paths.work, id);
      let desks = [];
      try { desks = fs.readdirSync(path.join(root, '_desk')).map((n) => path.join(root, '_desk', n)); } catch { desks = []; }
      for (const dir of [...desks, path.join(root, '_head'), path.join(root, '_preview')]) if (fs.existsSync(dir)) await removeDir(dir);
    }
    for (const d of ctx.deliveriesOf(id, (x) => ['checking', 'buddy', 'review', 'approved'].includes(x.status))) ctx.patch('deliveries', d.id, { status: 'rejected' });
    // An empty truck: ws/<job>/int and _int go now (section 12, cancel); the saved task refs stay until Delete.
    if (!loadedNow && project && job.integrationBranch) await O.dropIntegration(ctx.job(id));
    for (const a of ctx.agentsOf(id)) ctx.patch('agents', a.id, { status: 'off', taskId: null, wake: null, gate: null });
    const one = loadedNow === 1;
    const kept = ` ${plural(loadedNow, 'crate')} ${one ? 'stays' : 'stay'} on the truck: ship ${one ? 'it' : 'them'} or discard ${one ? 'it' : 'them'}.`;
    ctx.evt(id, { scope: '#ops', body: `Work order ${id} is cancelled.${loadedNow ? kept : ''}` });
    await ctx.flush();
    ctx.kick();
    return ctx.job(id);
  };

  /** Wait (at most waitMs) for the turns and hub steps of one job that are in flight. */
  async function settleJob(jobId, waitMs = 20000) {
    const pending = () => [
      ...[...ctx.rt.turns.values()].filter((t) => t.jobId === jobId).map((t) => t.promise),
      ...[...ctx.rt.steps.values()].filter((s) => s.jobId === jobId).map((s) => s.promise),
    ].filter(Boolean);
    const end = Date.now() + waitMs;
    for (let list = pending(); list.length && Date.now() < end; list = pending()) {
      let timer = null;
      await Promise.race([Promise.allSettled(list), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(1, end - Date.now())); timer.unref?.(); })]);
      clearTimeout(timer);
      for (const a of ctx.agentsOf(jobId)) if (ctx.runner.busy?.(a.id)) ctx.runner.cancel(a.id, 'The owner cancelled the job.');
    }
  }

  O.discardTruck = async (id) => {
    const job = need(ctx.job(id));
    if (job.status !== 'cancelled') throw httpError(409, 'Discard is for a cancelled job with a loaded truck.');
    for (const d of ctx.deliveriesOf(id, (x) => x.status === 'loaded')) ctx.patch('deliveries', d.id, { status: 'rejected', discarded: true });
    ctx.patch('jobs', id, { truckKept: false });
    await O.dropIntegration(ctx.job(id));
    await ctx.flush();
    return { ok: true };
  };

  /**
   * Ship or Discard of a cancelled job (section 12, cancel): the integration branch and the job's folders go; the
   * saved task refs stay until Delete.
   */
  O.dropIntegration = async (job) => {
    const project = ctx.projectOf(job);
    if (!project || job.status !== 'cancelled') return;
    try {
      await ctx.git.removeJobWork(project, job.id, { force: true, keepRefs: true });
      ctx.patch('jobs', job.id, { truckKept: false, integrationDir: null, intDropped: true });
    } catch (err) {
      ctx.say('warn', 'orchestrator: the integration branch was not removed', { job: job.id, error: errText(err) });
    }
  };

  O.deleteJob = async (id) => {
    const job = need(ctx.job(id));
    if (!ENDED.has(job.status)) throw httpError(409, 'Only a done or cancelled job can be deleted.');
    const project = ctx.projectOf(job);
    if (project) {
      try { await ctx.git.removeJobWork(project, id, { force: true }); } catch (err) { ctx.say('warn', 'orchestrator: removeJobWork failed', { job: id, error: errText(err) }); }
    }
    for (const t of ctx.tasksOf(id)) ctx.store.remove('tasks', t.id);
    for (const d of ctx.deliveriesOf(id)) ctx.store.remove('deliveries', d.id);
    for (const a of ctx.agentsOf(id)) ctx.store.remove('agents', a.id);
    const out = ctx.patch('jobs', id, { deleted: true, planDrafts: null, integrationDir: null, changes: [], qa: null, stall: null, mergeLog: [] });
    await ctx.flush();
    return out;
  };

  O.approvePlan = (jobId) => {
    const job = need(ctx.job(jobId));
    if (job.status !== 'plan_review') throw httpError(409, `${jobId} has no plan that waits for approval.`);
    const out = ctx.patch('jobs', jobId, { status: 'running' });
    ctx.evt(jobId, { scope: '#plan', body: 'The owner approved the plan. Work starts.' });
    ctx.kick();
    return out;
  };

  const ledgerOpen = (job) => ['plan_review', 'running', 'qa', 'delivering', 'paused'].includes(job.status) && job.requirements.length > 0;

  /**
   * Owner words -> a Req (source owner), then the lead boss gets an owner-change turn.
   * reqId ('Add task' on a requirement that no task serves, final wiring spec S7): the new Req records servesReq,
   * and the named one stops asking the owner (its inbox item goes) until QA checks it again.
   */
  function ownerChange(jobId, text, deliveryId = null, reqId = null) {
    const job = need(ctx.job(jobId));
    const serves = reqId ? ctx.reqOf(job, reqId) : null;
    if (reqId && !serves) throw httpError(404, `Unknown requirement ${reqId} in ${jobId}.`);
    if (!ledgerOpen(job)) throw httpError(409, 'Requirements can be added from the plan review on.');
    if (!str(text)) throw httpError(400, 'Say what you want.');
    if (deliveryId && !ctx.delivery(deliveryId)) throw httpError(404, 'Unknown delivery.');
    const req = O.newReq(jobId, { text, source: 'owner', servesReq: serves?.id ?? null });
    if (serves) ctx.patchReq(jobId, serves.id, { ownerNotice: false });
    const now = ctx.job(jobId);
    ctx.patch('jobs', jobId, { changes: [...(now.changes ?? []), { reqId: req.id, text: clip(str(text), 1000), deliveryId, at: ctx.now(), tries: 0, nudged: false, done: false }] });
    ctx.evt(jobId, { scope: '#plan', body: `The owner added ${req.id}${serves ? ` for ${serves.id}` : ''}: ${oneLine(text, 200)}` });
    ctx.qa.onNewWork(jobId);
    ctx.kick();
    return req;
  }
  O.addReq = (jobId, { text } = {}) => ownerChange(jobId, text);
  O.requestChanges = (jobId, { deliveryId, text, reqId } = {}) => ownerChange(jobId, text, deliveryId ?? null, reqId ?? null);

  O.waiveReq = (jobId, reqId, { reason } = {}) => {
    const job = need(ctx.job(jobId));
    const req = ctx.reqOf(job, reqId);
    if (!req) throw httpError(404, 'Unknown requirement.');
    // A done or cancelled job keeps its final ledger (and the report that lists it) as it was.
    if (!ledgerOpen(job)) throw httpError(409, `${jobId} is ${job.status}: its ledger is closed.`);
    if (!str(reason)) throw httpError(400, 'Give a reason for the waiver.');
    const out = ctx.patchReq(jobId, reqId, { status: 'waived', waivedReason: clip(str(reason), 500) });
    const pending = (ctx.job(jobId).changes ?? []).map((c) => (c.reqId === reqId ? { ...c, done: true } : c));
    ctx.patch('jobs', jobId, { changes: pending });
    ctx.evt(jobId, { scope: '#plan', body: `The owner waived ${reqId}: ${oneLine(reason, 200)}` });
    if (ctx.job(jobId).status === 'qa' && ['owner', 'lead', 'over', 'done'].includes(ctx.job(jobId).qa?.step)) ctx.qa.evaluate(jobId);
    ctx.kick();
    return out;
  };

  O.ackAgentFiles = (projectId, ack) => {
    const p = ctx.project(projectId);
    if (!p) throw httpError(404, 'Unknown project.');
    const out = ctx.patch('projects', projectId, { agentFilesAck: ack === true });
    ctx.kick();
    return out;
  };

  const needTask = (id) => {
    const t = ctx.task(id);
    if (!t) throw httpError(404, 'Unknown task.');
    return t;
  };

  O.stopTask = (taskId, { note } = {}) => {
    const t = needTask(taskId);
    if (!isOpenTask(t)) throw httpError(409, `${taskId} is ${t.status}.`);
    if (FROZEN.has(t.status)) throw httpError(409, `${taskId} is in review. Give a verdict, or cancel the task.`);
    if (t.assigneeId && ctx.busy(t.assigneeId)) ctx.runner.cancel(t.assigneeId, 'The owner stopped the task.');
    return ctx.patch('tasks', taskId, { status: 'blocked', why: 'owner', needsAction: null, resumeNote: null, lastError: str(note) ? `Owner: ${clip(str(note), 500)}` : 'Stopped by the owner.' });
  };

  O.retryTask = (taskId, { note, model } = {}) => {
    const r = ctx.edits.retry(needTask(taskId), { note, model }, 'owner');
    if (!r.ok) throw httpError(409, r.error);
    return r.task;
  };

  O.cancelTask = (taskId, { reason, replacedBy } = {}) => {
    const r = ctx.edits.cancel(needTask(taskId), { reason, replacedBy }, 'owner');
    if (!r.ok) throw httpError(409, r.error);
    return ctx.task(taskId);
  };

  O.ownerPost = ({ jobId, kind, to, scope, re, slots, body } = {}) => {
    need(ctx.job(jobId));
    const line = formatPost({ kind: str(kind).toUpperCase(), to, scope, re, slots, body });
    return ctx.board.post({ jobId, human: true, line });
  };

  O.setPresence = (state) => {
    if (state !== 'here' && state !== 'away') throw httpError(400, 'state must be here or away.');
    if (typeof ctx.updateSettings === 'function') {
      try { ctx.updateSettings({ presence: state }); } catch (err) { ctx.say('warn', 'orchestrator: presence save failed', { error: errText(err) }); }
    }
    ctx.rt.presence = state;
    try { ctx.board.tick(ctx.now()); } catch { /* the next tick does it */ }
    ctx.kick();
    return { presence: state };
  };

  const reqCounts = (job) => {
    const out = { open: 0, failed: 0, verified: 0, waived: 0 };
    for (const r of job.requirements) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  };

  O.truck = async (jobId) => {
    const job = need(ctx.job(jobId));
    const project = ctx.projectOf(job);
    const handle = (id) => ctx.agent(id)?.handle ?? null;
    const deliveries = ctx.deliveriesOf(jobId, (d) => d.status === 'loaded').map((d) => ({
      ...d, title: ctx.task(d.taskId)?.title ?? '', maker: handle(d.makerId), reviewer: handle(d.reviewerId),
      sameLab: d.review ? !d.review.crossLab : null, cardChanges: ctx.task(d.taskId)?.cardChanges ?? [],
    }));
    let t = null;
    if (project && job.integrationBranch) {
      try { t = await ctx.git.truck(project, jobId); } catch (err) { ctx.say('debug', 'orchestrator: truck read failed', { job: jobId, error: errText(err) }); }
    }
    const hc = project?.headCheck;
    return {
      headSha: t?.headSha ?? job.intSha ?? null, behind: t?.behind ?? 0, deliveries,
      stat: { files: t?.files.length ?? 0, add: t?.add ?? 0, del: t?.del ?? 0 }, files: t?.files ?? [],
      reqs: reqCounts(job), check: hc && t && hc.sha === t.headSha ? { ok: hc.ok, tail: hc.tail } : null,
      notChecked: !project?.checkCmd, report: job.report ?? null,
    };
  };

  O.diff = async (jobId, { deliveryId, path: only } = {}) => {
    const job = need(ctx.job(jobId));
    const project = ctx.projectOf(job);
    if (!project) return '';
    const opts = only ? { path: only } : {};
    if (deliveryId) {
      const d = ctx.delivery(deliveryId);
      if (!d || d.jobId !== jobId) throw httpError(404, 'Unknown delivery.');
      if (d.mergeSha && !d.empty) return ctx.git.deliveryDiff(project, d.mergeSha, opts);
      const t = ctx.task(d.taskId);
      const dir = t?.reviewDir ?? t?.benchDir;
      if (!dir || !d.baseSha || !d.headSha) return '';
      return ctx.git.diff(dir, { base: d.baseSha, head: d.headSha, ...opts });
    }
    if (!job.integrationBranch) return '';
    return ctx.git.truckDiff(project, jobId, opts);
  };

  /** The attention inbox (section 12b): everything that waits for the owner, newest first. */
  O.inbox = (jobId) => {
    const jobs = jobId ? [ctx.job(jobId)].filter(Boolean) : ctx.list('jobs').filter((j) => !j.deleted && j.status !== 'done');
    const items = [];
    const P = ctx.providers;
    for (const job of jobs.sort(byIdNum)) {
      // A done or cancelled job waits for nothing, except a cancelled job's loaded truck (ship or discard it).
      if (job.status === 'done' || job.status === 'cancelled') {
        const loaded = job.status === 'cancelled' ? ctx.deliveriesOf(job.id, (d) => d.status === 'loaded') : [];
        if (loaded.length) items.push({ kind: 'truck', id: job.id, jobId: job.id, text: truckWaits(loaded.length, job.id), since: Math.max(...loaded.map((d) => d.loadedAt ?? d.updatedAt)) });
        continue;
      }
      let msgs = [];
      // Every open owner question and every pinned one (default taken, not answered yet), however old.
      msgs = [...ctx.openItems(job.id, { kind: 'ASK', to: '@human' }), ...ctx.pinned(job.id)];
      for (const m of msgs) {
        if (m.kind !== 'ASK' || m.to !== '@human') continue;
        if (m.state !== 'open' && !m.defaulted) continue;
        const parsed = parseOptions(m.body);
        items.push({ kind: 'question', id: m.id, jobId: job.id, text: parsed.text || m.body, since: m.ts, options: parsed.options, default: m.slots?.default ?? null, defaulted: m.defaulted === true, msgId: m.id, from: m.from });
      }
      if (job.status === 'plan_review') items.push({ kind: 'plan', id: job.id, jobId: job.id, text: `The plan of ${job.id} waits for your approval.`, since: job.updatedAt });
      const loaded = ctx.deliveriesOf(job.id, (d) => d.status === 'loaded');
      if (loaded.length && (job.status === 'delivering' || job.status === 'cancelled')) {
        items.push({ kind: 'truck', id: job.id, jobId: job.id, text: truckWaits(loaded.length, job.id), since: Math.max(...loaded.map((d) => d.loadedAt ?? d.updatedAt)) });
      }
      if (job.status === 'paused') {
        items.push(job.pauseReason === 'budget'
          ? { kind: 'budget', id: job.id, jobId: job.id, text: `${job.id} reached its budget of $${job.budgetUsd}. Raise it to go on.`, since: job.updatedAt }
          : { kind: 'paused', id: job.id, jobId: job.id, text: `${job.id} is paused (${job.pauseReason}). ${job.error ?? ''}`.trim(), since: job.updatedAt });
      }
      for (const d of ctx.deliveriesOf(job.id, (x) => x.status === 'review' && x.waitHuman)) {
        items.push({ kind: 'review', id: d.id, jobId: job.id, text: `${d.taskId} waits for your verdict: PASS re:${d.doneMsgId} or FIX re:${d.doneMsgId}.`, since: d.updatedAt, msgId: d.doneMsgId });
      }
      for (const r of job.requirements.filter((x) => x.ownerNotice && x.status !== 'waived' && x.status !== 'verified')) {
        items.push({ kind: 'requirement', id: r.id, jobId: job.id, text: `${r.id} has no task: ${oneLine(r.text, 160)}`, since: job.updatedAt, reqId: r.id, options: [{ key: 'waive', text: 'Waive' }, { key: 'task', text: 'Add task' }, { key: 'stop', text: 'Stop job' }] });
      }
      const project = ctx.projectOf(job);
      if (project && (project.agentFiles ?? []).length && project.agentFilesAck === false && LIVE.has(job.status)) {
        items.push({ kind: 'agentfiles', id: project.id, jobId: job.id, text: `The repo holds agent files (${project.agentFiles.slice(0, 5).join(', ')}). Gemini workers will load these: accept, or the Gemini lab stays off.`, since: job.createdAt, projectId: project.id });
      }
      if (LIVE.has(job.status) && typeof P?.status === 'function') {
        const labs = [...new Set(ctx.agentsOf(job.id, (a) => a.status !== 'off' && !a.hidden).map((a) => a.provider))];
        for (const lab of labs) {
          const st = P.status(lab);
          if (st && st.usable === false && st.auth === 'none') items.push({ kind: 'signin', id: lab, jobId: job.id, text: `${st.label ?? lab}: ${st.reason ?? 'sign in again'}`, since: job.updatedAt, provider: lab });
        }
      }
    }
    if (ctx.training && typeof ctx.training.list === 'function') {
      for (const r of ctx.training.list({ status: 'queued_phase1' })) {
        if (jobId && r.jobId !== jobId) continue;
        items.push({
          kind: 'requisition',
          id: r.id,
          jobId: r.jobId ?? null,
          text: `Phase 1 RFT queued (${r.domain}): ${r.candidateBaseModel} + ${r.harnessId}`,
          since: r.createdAt,
          quiet: true,
          requisition: r,
        });
      }
    }
    // id: the thing the item is about (message, job, delivery, requirement, project, requisition or lab id), as the UI reads it;
    // kind + id is unique.
    const seen = new Set();
    const key = (i) => `${i.kind}:${i.id}`;
    return items.filter((i) => (seen.has(key(i)) ? false : seen.add(key(i)))).sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
  };

  return O;
}
