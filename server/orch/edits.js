// Task edits shared by the hub tools and the owner (section 12): task_add, task_update, task_retry,
// task_cancel, and claims. Every function returns { ok:true, ... } or { ok:false, error }.
import { HUB_PATHS, matchZone, zonesOverlap } from '../gitops.js';
import { DOMAINS } from '../prompts.js';
import { badZone } from './plan.js';
import { FROZEN, LIVE, isOpenTask, oneLine } from './context.js';

const SIZES = ['S', 'M', 'L'];
const GLOB = /[*?[\]{}]/;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const fail = (error) => ({ ok: false, error });

export function createEdits(ctx) {
  const E = {};
  const L = () => ctx.limits();

  /** Every task a task depends on, directly or not (task ids). */
  E.depsClosure = (deps, override = {}) => {
    const out = new Set();
    const stack = [...deps];
    while (stack.length) {
      const id = stack.pop();
      if (out.has(id)) continue;
      out.add(id);
      const t = ctx.task(id);
      for (const d of override[id] ?? t?.deps ?? []) stack.push(d);
    }
    return out;
  };

  /** Open tasks whose zones or live claims overlap `zones` and that are not ordered with the task by deps. */
  E.zoneConflicts = (jobId, zones, deps, selfId = null, override = {}) => {
    const before = E.depsClosure(deps, override);
    const out = [];
    for (const t of ctx.openTasks(jobId)) {
      if (t.id === selfId) continue;
      let hit = false;
      try { hit = zonesOverlap(zones, [...t.zones, ...(t.claims ?? [])]); } catch { hit = true; }
      if (!hit || before.has(t.id)) continue;
      if (selfId && E.depsClosure(override[t.id] ?? t.deps, override).has(selfId)) continue;
      out.push(t.id);
    }
    return out;
  };

  const zoneErrors = (zones) => {
    if (!zones.length) return 'Give at least one zone.';
    for (const z of zones) {
      const bad = badZone(z);
      if (bad) return `Zone ${z} ${bad}.`;
    }
    return null;
  };

  /** Requirements that would be left with no open or merged task. */
  // A requirement that the owner gave a follow-up for ('Add task', servesReq) is covered while that follow-up is
  // not waived: the follow-up asks the owner if it gets no task, so the named one stays quiet (final wiring spec S7).
  E.unserved = (job, without = [], extra = []) => job.requirements.filter((r) => r.status !== 'waived').filter((r) => {
    if (job.requirements.some((s) => s.servesReq === r.id && s.id !== r.id && s.status !== 'waived')) return false;
    const served = ctx.tasksOf(job.id, (t) => !without.includes(t.id) && (isOpenTask(t) || t.status === 'merged') && t.reqs.includes(r.id)).length;
    return served === 0 && !extra.some((t) => t.reqs.includes(r.id));
  }).map((r) => r.id);

  /** Circuit breaker for limits: the job pauses with pauseReason caps. */
  const breaker = (job, why) => ctx.pauseJob(job, 'caps', why);

  /** task_add (manager, boss) and the hub's own tasks (catch-up). by: agent record or 'owner' or 'hub'. */
  E.add = async (job, args, by, { catchUp = false, change = null } = {}) => {
    if (!job || !['running', 'qa', 'delivering', 'plan_review'].includes(job.status)) return fail('Tasks can be added only while the work order runs.');
    const total = ctx.tasksOf(job.id).length;
    if (total >= L().maxTasksTotal && by !== 'hub') {
      if (by !== 'owner') breaker(job, `task_add hit the limit of ${L().maxTasksTotal} tasks.`);
      return fail(`The work order has ${total} tasks: the limit is ${L().maxTasksTotal}.`);
    }
    const f = {
      title: str(args.title), spec: str(args.spec), acceptance: strList(args.acceptance), zones: strList(args.zones), domain: str(args.domain),
      size: str(args.size).toUpperCase(), deps: strList(args.deps), reqs: strList(args.reqs), pair: args.pair === true, stream: str(args.stream) || null, catchUp,
    };
    if (!f.title || !f.spec) return fail('Give a title and a spec.');
    if (f.acceptance.length < 1 || f.acceptance.length > 8) return fail('Give 1 to 8 acceptance items.');
    const zerr = zoneErrors(f.zones);
    if (zerr) return fail(zerr);
    if (!DOMAINS.includes(f.domain)) return fail(`domain must be one of ${DOMAINS.join(' ')}.`);
    if (!SIZES.includes(f.size)) return fail('size must be S, M or L.');
    for (const d of f.deps) {
      const t = ctx.task(d);
      if (!t || t.jobId !== job.id || t.status === 'cancelled') return fail(`dep ${d} is not a task of this work order.`);
    }
    for (const r of f.reqs) if (!ctx.reqOf(job, r)) return fail(`${r} is not a requirement. Requirements: ${job.requirements.map((x) => x.id).join(', ')}.`);
    const waived = f.reqs.filter((r) => ctx.reqOf(job, r)?.status === 'waived');
    if (waived.length) return fail(`The owner waived ${waived.join(', ')}. Add no work for it.`);
    if (change && !f.reqs.includes(change)) return fail(`This task is for the owner's change: list ${change} in reqs.`);
    if (!catchUp) {
      const clash = E.zoneConflicts(job.id, f.zones, f.deps);
      if (clash.length) return fail(`The zones overlap open tasks ${clash.join(', ')} (zones and claims). Add them to deps or change the zones.`);
    }
    const care = await ctx.plan.care(f);
    const again = ctx.job(job.id);
    if (!again || !LIVE.has(again.status)) return fail('The work order is not running now.');
    const managerId = ctx.plan.streamManager(again, f.stream, f.deps);
    if (f.stream && managerId && !(again.streams ?? {})[f.stream]) ctx.patch('jobs', job.id, { streams: { ...(again.streams ?? {}), [f.stream]: managerId } });
    const task = ctx.put('tasks', ctx.tasksApi.newTask(again, { ...f, size: care.size, pair: care.pair, managerId }));
    const who = typeof by === 'object' ? by.handle : by === 'owner' ? '@human' : '@hub';
    ctx.evt(job.id, { scope: '#plan', body: `${task.id} added by ${who}: ${oneLine(task.title, 120)}.` });
    ctx.qa.onNewWork(job.id);
    ctx.kick();
    return { ok: true, task };
  };

  const isBoss = (by) => by === 'owner' || by === 'hub' || by?.role === 'boss';
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  /** task_update (manager, boss). */
  E.update = (task, args, by) => {
    const job = ctx.job(task?.jobId);
    if (!task || !isOpenTask(task)) return fail('Only a task that is not merged or cancelled can be changed.');
    const started = !['planned', 'ready'].includes(task.status);
    const changes = {};
    const notes = [];
    const card = [];
    const has = (k) => Object.hasOwn(args, k) && args[k] !== undefined && args[k] !== null;
    const bossOnly = (what) => (isBoss(by) ? null : `Only a boss changes ${what}. Ask @boss.`);
    if (has('title') && str(args.title) !== task.title) {
      const e = bossOnly('the title');
      if (e) return fail(e);
      changes.title = str(args.title);
      card.push('title changed');
    }
    if (has('spec') && str(args.spec) !== task.spec) {
      if (started) { const e = bossOnly('the spec of a started task'); if (e) return fail(e); card.push('spec changed'); }
      changes.spec = str(args.spec);
    }
    if (has('acceptance')) {
      const next = strList(args.acceptance);
      if (next.length < 1 || next.length > 8) return fail('Give 1 to 8 acceptance items.');
      const removed = task.acceptance.filter((a) => !next.includes(a));
      if (removed.length) {
        if (!isBoss(by)) return fail('Only a boss removes or rewords an acceptance item. A manager may only add items. Ask @boss.');
        card.push(`acceptance items removed or reworded: ${removed.map((a) => oneLine(a, 60)).join('; ')}`);
      }
      if (!sameSet(next, task.acceptance)) changes.acceptance = next;
    }
    if (has('domain') && str(args.domain) !== task.domain) {
      const e = bossOnly('the domain');
      if (e) return fail(e);
      if (!DOMAINS.includes(str(args.domain))) return fail(`domain must be one of ${DOMAINS.join(' ')}.`);
      changes.domain = str(args.domain);
    }
    if (has('size') && str(args.size).toUpperCase() !== task.size) {
      const e = bossOnly('the size');
      if (e) return fail(e);
      if (!SIZES.includes(str(args.size).toUpperCase())) return fail('size must be S, M or L.');
      changes.size = str(args.size).toUpperCase();
    }
    for (const k of ['pair', 'allowLarge']) {
      if (has(k) && Boolean(args[k]) !== Boolean(task[k])) {
        const e = bossOnly(k);
        if (e) return fail(e);
        changes[k] = args[k] === true;
      }
    }
    if (has('note')) { changes.note = str(args.note) || null; notes.push('note'); }
    let deps = task.deps;
    if (has('deps')) {
      deps = strList(args.deps);
      for (const d of deps) {
        const t = ctx.task(d);
        if (!t || t.jobId !== task.jobId || t.status === 'cancelled' || d === task.id) return fail(`dep ${d} is not another task of this work order.`);
      }
      if (E.depsClosure(deps, { [task.id]: deps }).has(task.id)) return fail('These deps make a cycle.');
      changes.deps = deps;
    }
    let zones = task.zones;
    if (has('zones')) {
      zones = strList(args.zones);
      const zerr = zoneErrors(zones);
      if (zerr) return fail(zerr);
      changes.zones = zones;
    }
    if (has('zones') || has('deps')) {
      const clash = E.zoneConflicts(task.jobId, [...zones, ...(task.claims ?? [])], deps, task.id, { [task.id]: deps });
      if (clash.length) return fail(`The zones overlap open tasks ${clash.join(', ')} (zones and claims). Order them with deps or change the zones.`);
    }
    if (has('reqs')) {
      const reqs = strList(args.reqs);
      for (const r of reqs) if (!ctx.reqOf(job, r)) return fail(`${r} is not a requirement.`);
      const left = E.unserved(job, [task.id], [{ reqs }]);
      if (left.length) return fail(`${left.join(', ')} would have no open or merged task. Add a task for it first, or the owner waives it.`);
      changes.reqs = reqs;
    }
    if (!Object.keys(changes).length) return { ok: true, task, text: 'ok (nothing changed)' };
    const who = typeof by === 'object' ? by.handle : '@human';
    if (card.length) {
      changes.cardChanges = [...(task.cardChanges ?? []), ...card.map((what) => ({ by: who, what, ts: ctx.now() }))];
      ctx.evt(task.jobId, { scope: '#plan', body: `${task.id} card changed by ${who}: ${card.join('; ')}.` });
    }
    changes.needsAction = null;
    const t = ctx.patch('tasks', task.id, changes);
    if (t.benchDir) {
      ctx.digest.writeCard(t);
      if (t.assigneeId) ctx.evt(task.jobId, { to: t.assigneeId, scope: task.id, body: `The card of ${task.id} changed. Read .shop/TASK.md again.` });
    }
    if (has('zones')) E.releaseClaims(task.jobId);
    ctx.digest.refreshBlueprints(task.jobId);
    ctx.kick();
    return { ok: true, task: t, text: 'ok' };
  };

  /** task_retry: same bench, fresh session, attempts reset. by: agent, or 'owner' (no retry limit). */
  E.retry = (task, { note, model } = {}, by) => {
    const job = ctx.job(task?.jobId);
    if (!task || !job) return fail('Unknown task.');
    if (!['failed', 'blocked'].includes(task.status)) return fail(`${task.id} is ${task.status}. Only a failed or blocked task can be retried.`);
    if (by !== 'owner' && (task.retries ?? 0) >= L().maxRetries) {
      breaker(job, `task_retry of ${task.id} hit the limit of ${L().maxRetries} retries.`);
      return fail(`${task.id} was retried ${task.retries} times: the limit is ${L().maxRetries}.`);
    }
    ctx.tasksApi.closeItems(task);
    const old = ctx.agent(task.assigneeId);
    if (old && ctx.busy(old.id)) ctx.runner.cancel(old.id, 'The task is retried.');
    let t = ctx.patch('tasks', task.id, {
      attempts: 0, retries: (task.retries ?? 0) + 1, status: task.benchDir ? 'working' : 'ready', why: null, needsAction: null, blocks: 0,
      nudges: 0, fails: {}, hold: null, gated: false, gate: null, resumeNote: null, pendingClaims: [], awaitConsult: null,
      retryNote: { note: str(note) || null, lastError: task.lastError ?? null }, bump: (task.bump ?? 0) + (model === 'up' ? 1 : 0),
    });
    if (model === 'up' || model === 'other_lab') {
      const avoid = model === 'other_lab' ? old?.provider : undefined;
      const fresh = ctx.crew.hireMaker(job, t, { bump: t.bump ?? 0, avoidProvider: avoid, requireOther: model === 'other_lab', exclude: model === 'up' && old ? [old.model] : [] });
      if (fresh && fresh.id !== old?.id) t = ctx.tasksApi.reassign(t, fresh);
      else if (!fresh && model === 'other_lab') ctx.patch('tasks', task.id, { wantLab: null });
    }
    if (t.assigneeId && t.benchDir) {
      const a = ctx.agent(t.assigneeId);
      ctx.patch('tasks', task.id, { sessionId: null, sessionCtx: null, boardSession: ctx.turns.newBoardKey(a, t.boardSession, task.id), started: true });
    }
    const who = typeof by === 'object' ? by.handle : '@human';
    ctx.evt(task.jobId, { scope: '#plan', body: `${task.id} is retried by ${who}.` });
    ctx.kick();
    return { ok: true, task: ctx.task(task.id) };
  };

  /** task_cancel: dependents move to replacedBy; the requirement rule holds. */
  E.cancel = (task, { reason, replacedBy } = {}, by) => {
    const job = ctx.job(task?.jobId);
    if (!task || !job || !isOpenTask(task)) return fail('Only a task that is not merged or cancelled can be cancelled.');
    if (!str(reason)) return fail('Give a reason.');
    const repl = strList(replacedBy);
    const dependents = ctx.openTasks(job.id).filter((t) => t.deps.includes(task.id));
    if (dependents.length && !repl.length) return fail(`${task.id} has dependents (${dependents.map((t) => t.id).join(', ')}). Give replacedBy.`);
    for (const r of repl) {
      const t = ctx.task(r);
      if (!t || t.jobId !== job.id || r === task.id || t.status === 'cancelled') return fail(`replacedBy: ${r} is not another task of this work order.`);
    }
    const left = E.unserved(job, [task.id]);
    if (left.length) return fail(`${left.join(', ')} would have no open or merged task. Add a task for it first, or the owner waives it.`);
    const override = {};
    for (const d of dependents) override[d.id] = [...new Set([...d.deps.filter((x) => x !== task.id), ...repl])];
    for (const d of dependents) {
      if (E.depsClosure(override[d.id], override).has(d.id)) return fail(`replacedBy makes a cycle with ${d.id}.`);
      const clash = E.zoneConflicts(job.id, [...d.zones, ...(d.claims ?? [])], override[d.id], d.id, { ...override, [task.id]: [] })
        .filter((id) => id !== task.id);
      if (clash.length) return fail(`After the cancel, ${d.id} and ${clash.join(', ')} share zones with no order. Give other replacedBy tasks.`);
    }
    for (const d of dependents) ctx.patch('tasks', d.id, { deps: override[d.id] });
    ctx.tasksApi.closeItems(task);
    if (task.assigneeId && ctx.busy(task.assigneeId)) ctx.runner.cancel(task.assigneeId, 'The task is cancelled.');
    const dl = ctx.currentDelivery(task);
    if (dl && ['checking', 'buddy', 'review', 'approved'].includes(dl.status)) ctx.patch('deliveries', dl.id, { status: 'rejected' });
    ctx.patch('tasks', task.id, { status: 'cancelled', why: null, needsAction: null, hold: null, note: str(reason), cancelReason: str(reason), replacedBy: repl });
    if (task.assigneeId) ctx.crew.unbind(task.assigneeId, task.id);
    const project = ctx.projectOf(job);
    if (task.benchDir && project) {
      ctx.step(`drop:${task.id}`, job.id, async () => {
        const maker = ctx.agent(task.assigneeId);
        try { await ctx.git.saveBench(project, job.id, task.id, task.benchDir, maker?.name ?? 'Maker'); } catch (err) { ctx.say('warn', 'orchestrator: saveBench failed', { task: task.id, error: String(err?.message ?? err) }); }
        await ctx.git.removeBench(task.benchDir).catch(() => {});
        if (task.reviewDir) await ctx.git.removeBench(task.reviewDir).catch(() => {});
        ctx.patch('tasks', task.id, { benchDir: null, reviewDir: null });
      });
    }
    const who = typeof by === 'object' ? by.handle : '@human';
    ctx.evt(job.id, { scope: '#plan', body: `${task.id} cancelled by ${who}: ${oneLine(reason, 160)}.${repl.length ? ` Replaced by ${repl.join(', ')}.` : ''}` });
    E.releaseClaims(job.id);
    ctx.digest.refreshBlueprints(job.id);
    ctx.kick();
    return { ok: true };
  };

  /** The open task (not `selfId`) that owns a path through its zones or its claims. */
  E.holderOf = (jobId, rel, selfId) => ctx.openTasks(jobId).find((t) => t.id !== selfId && (matchZone(rel, t.zones) || (t.claims ?? []).includes(rel))) ?? null;

  /** claim (maker): exact paths outside the zone. Granted, or queued with WAIT. */
  E.claim = (agent, args) => {
    const task = ctx.task(agent.taskId);
    if (!task || task.assigneeId !== agent.id || !isOpenTask(task)) return { text: 'ERR You have no open task.', isError: true };
    if (FROZEN.has(task.status)) return { text: `ERR Your work on ${task.id} is in review. Claim nothing now.`, isError: true };
    const paths = strList(args?.paths).map((p) => p.replace(/^\.\//, ''));
    if (!paths.length) return { text: 'ERR Give paths: exact file paths, no globs.', isError: true };
    for (const p of paths) {
      if (GLOB.test(p)) return { text: `ERR ${p} is a glob. Claim exact paths only.`, isError: true };
      const bad = badZone(p);
      if (bad) return { text: `ERR ${p} ${bad}. Hub paths (${HUB_PATHS.join(', ')}) are never claimed.`, isError: true };
    }
    const fresh = paths.filter((p) => !matchZone(p, task.zones) && !(task.claims ?? []).includes(p) && !(task.pendingClaims ?? []).includes(p));
    if (!fresh.length) return 'ok (these paths are yours already)';
    if ((task.claims ?? []).length + (task.pendingClaims ?? []).length + fresh.length > L().maxClaims) {
      return { text: `ERR At most ${L().maxClaims} claims per task.`, isError: true };
    }
    const granted = [];
    const queued = [];
    for (const p of fresh) {
      const holder = E.holderOf(task.jobId, p, task.id);
      if (holder) queued.push({ p, holder });
      else granted.push(p);
    }
    const changes = { claims: [...(task.claims ?? []), ...granted] };
    if (queued.length) {
      changes.pendingClaims = [...(task.pendingClaims ?? []), ...queued.map((q) => q.p)];
      changes.status = 'blocked';
      changes.why = 'claim';
      changes.resumeNote = null;
    }
    const t = ctx.patch('tasks', task.id, changes);
    if (granted.length) ctx.digest.writeCard(t);
    if (!queued.length) return 'ok';
    // A wait cycle (the holder waits on a path of this task) goes to the manager.
    for (const q of queued) {
      const h = ctx.task(q.holder.id);
      if (h?.status === 'blocked' && h.why === 'claim' && (h.pendingClaims ?? []).some((p) => E.holderOf(task.jobId, p, h.id)?.id === task.id)) {
        ctx.patch('tasks', task.id, { needsAction: { kind: 'blocked', since: ctx.now(), seq: ctx.seq() } });
        const mgr = ctx.crew.managerOf(task);
        ctx.evt(task.jobId, { to: mgr?.id, scope: task.id, body: `${task.id} and ${h.id} wait on each other's paths. Change the zones with task_update.` });
      }
    }
    return `WAIT ${queued.map((q) => `${q.holder.id} holds ${q.p}`).join('; ')}. Stop now: the hub wakes you when the path is free.${granted.length ? ` Granted: ${granted.join(', ')}.` : ''}`;
  };

  /** A holder merged or cancelled: grant the claims nobody holds any more (sync, TASK.md, EVT wake). */
  E.releaseClaims = (jobId) => {
    for (const t of ctx.tasksOf(jobId, (x) => x.status === 'blocked' && x.why === 'claim' && (x.pendingClaims ?? []).length)) {
      if (t.pendingClaims.some((p) => E.holderOf(jobId, p, t.id))) continue;
      ctx.step(`claim:${t.id}`, jobId, async () => {
        const now = ctx.task(t.id);
        if (!now || now.status !== 'blocked' || now.why !== 'claim') return;
        if (now.benchDir) {
          try { await ctx.git.syncBench(now.benchDir); } catch (err) { ctx.say('warn', 'orchestrator: sync for a claim failed', { task: t.id, error: String(err?.message ?? err) }); }
        }
        const granted = now.pendingClaims;
        const done = ctx.patch('tasks', t.id, { claims: [...new Set([...(now.claims ?? []), ...granted])], pendingClaims: [], status: 'working', why: null, needsAction: null, resumeNote: `Your claim is granted: ${granted.join(', ')}. The bench has the latest merged files.` });
        await ctx.digest.writeCard(done);
        ctx.evt(jobId, { to: done.assigneeId, scope: t.id, body: `Your claim on ${granted.join(', ')} is granted. Continue ${t.id}.` });
      });
    }
  };

  return E;
}
