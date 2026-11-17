// Planning (section 12, job flow step 2): draft turns, the merge, plan validation, the baseline gate, apply,
// the plan notice. The plan rules are a pure function (validatePlan) so tests can check every rule alone.
import { HUB_PATHS, zonesOverlap as gitZonesOverlap } from '../gitops.js';
import { DOMAINS } from '../prompts.js';
import { SIZE_RANK, clip, copy, errText, isObj, oneLine } from './context.js';

const SIZES = ['S', 'M', 'L'];
const MAX_ERRORS = 12;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** True when a zone or a path is under a hub path (.shop/, .agents/), or is not a plain relative path. */
export function badZone(zone) {
  const z = String(zone ?? '').trim().replace(/^\.\//, '');
  if (!z || z.startsWith('/') || z.split('/').includes('..')) return 'is not a relative path inside the project';
  for (const hub of HUB_PATHS) {
    const base = hub.replace(/\/$/, '');
    if (z === base || z.startsWith(`${base}/`) || z.startsWith(`${base}*`) || z.startsWith(`${base}{`)) return `is under ${hub} (hub files)`;
  }
  return null;
}

/** Task index -> set of task indexes it depends on, directly or not. null when there is a cycle. */
export function closure(deps) {
  const n = deps.length;
  const reach = Array.from({ length: n }, () => null);
  const state = new Array(n).fill(0); // 0 new, 1 on the stack, 2 done
  let cycle = false;
  const visit = (i) => {
    if (state[i] === 2) return reach[i];
    if (state[i] === 1) { cycle = true; return new Set(); }
    state[i] = 1;
    const out = new Set();
    for (const d of deps[i]) {
      out.add(d);
      for (const x of visit(d)) out.add(x);
    }
    state[i] = 2;
    reach[i] = out;
    return out;
  };
  for (let i = 0; i < n; i++) visit(i);
  return cycle ? null : reach;
}

/**
 * The plan rules of section 12. Pure.
 * @param {object} raw the plan_submit arguments
 * @param {{ kind, maxTasks, drafts?:[{handle, plan}], zonesOverlap? }} opts drafts: the merge mode (covers / dropped)
 * @returns {{ ok:true, plan } | { ok:false, errors:string[] }}
 */
export function validatePlan(raw, opts = {}) {
  const errors = [];
  const err = (text) => { if (errors.length < MAX_ERRORS) errors.push(text); };
  const overlap = opts.zonesOverlap ?? gitZonesOverlap;
  const p = isObj(raw) ? raw : {};
  const reqs = Array.isArray(p.requirements) ? p.requirements : [];
  const tasksIn = Array.isArray(p.tasks) ? p.tasks : [];
  const maxTasks = Number(opts.maxTasks) > 0 ? Number(opts.maxTasks) : 40;

  if (reqs.length < 1 || reqs.length > 30) err(`requirements: give 1 to 30 requirements (you gave ${reqs.length}).`);
  const requirements = reqs.map((r, i) => {
    const text = str(isObj(r) ? r.text : r);
    if (!text) err(`requirements[${i + 1}]: text is empty.`);
    return { text };
  });
  if (tasksIn.length < 1 || tasksIn.length > maxTasks) err(`tasks: give 1 to ${maxTasks} tasks (you gave ${tasksIn.length}).`);

  const keys = new Map();
  const tasks = tasksIn.map((t0, i) => {
    const t = isObj(t0) ? t0 : {};
    const key = str(String(t.key ?? ''));
    const at = `task ${key || i + 1}`;
    if (!key) err(`tasks[${i + 1}]: key is empty.`);
    else if (keys.has(key)) err(`${at}: the key is used twice.`);
    else keys.set(key, i);
    const task = {
      key, title: str(t.title), spec: str(t.spec), acceptance: strList(t.acceptance), zones: strList(t.zones),
      domain: str(t.domain), size: str(t.size).toUpperCase(), deps: strList((t.deps ?? []).map(String)),
      reqs: Array.isArray(t.reqs) ? t.reqs.map(Number) : [], pair: t.pair === true, stream: str(t.stream) || null,
    };
    if (!task.title) err(`${at}: title is empty.`);
    if (!task.spec) err(`${at}: spec is empty.`);
    if (task.acceptance.length < 1 || task.acceptance.length > 8) err(`${at}: give 1 to 8 acceptance items.`);
    if (task.zones.length < 1) err(`${at}: give at least one zone.`);
    for (const z of task.zones) {
      const bad = badZone(z);
      if (bad) err(`${at}: zone ${z} ${bad}.`);
    }
    if (!DOMAINS.includes(task.domain)) err(`${at}: domain must be one of ${DOMAINS.join(' ')}.`);
    if (!SIZES.includes(task.size)) err(`${at}: size must be S, M or L.`);
    for (const n of task.reqs) if (!Number.isInteger(n) || n < 1 || n > requirements.length) err(`${at}: reqs has ${n}, which is not a requirement number.`);
    return task;
  });

  const depIdx = tasks.map((t) => t.deps.map((d) => {
    if (!keys.has(d)) { err(`task ${t.key}: dep ${d} is not a task key.`); return -1; }
    if (keys.get(d) === keys.get(t.key)) { err(`task ${t.key}: a task cannot depend on itself.`); return -1; }
    return keys.get(d);
  }).filter((d) => d >= 0));
  const reach = closure(depIdx);
  if (!reach) err('deps: the dependencies form a cycle.');

  requirements.forEach((r, i) => {
    if (!tasks.some((t) => t.reqs.includes(i + 1))) err(`requirement ${i + 1} is served by no task. List it in the reqs of a task.`);
  });

  if (reach) {
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        if (!tasks[i].zones.length || !tasks[j].zones.length) continue;
        let hit = false;
        try { hit = overlap(tasks[i].zones, tasks[j].zones); } catch { hit = true; }
        if (hit && !reach[i].has(j) && !reach[j].has(i)) {
          err(`tasks ${tasks[i].key} and ${tasks[j].key} share zones but can run at the same time. Order them with deps or split the zones.`);
        }
      }
    }
  }

  const checkCmd = str(p.check_cmd);
  const noCheck = str(p.no_check_reason);
  if (!checkCmd && !noCheck && (opts.kind === 'build' || opts.kind === 'fix')) {
    err('check_cmd is empty. Give a check command, or no_check_reason when no check is possible.');
  }

  const plan = {
    requirements, tasks, setup_cmd: str(p.setup_cmd) || null, check_cmd: checkCmd || null, no_check_reason: noCheck || null,
    assumptions: strList(p.assumptions), notes: clip(str(p.notes), 1500), covers: [], dropped: [],
  };

  if (Array.isArray(opts.drafts) && opts.drafts.length) {
    const drafts = new Map(opts.drafts.map((d) => [d.handle, d.plan]));
    const covered = new Set();
    for (const c of Array.isArray(p.covers) ? p.covers : []) {
      const draft = str(c?.draft);
      const n = Number(c?.n);
      const req = Number(c?.req);
      if (!drafts.has(draft)) { err(`covers: ${draft || '(empty)'} is not a draft. Drafts: ${[...drafts.keys()].join(', ')}.`); continue; }
      if (!Number.isInteger(n) || n < 1 || n > drafts.get(draft).requirements.length) { err(`covers: ${draft} has no requirement ${c?.n}.`); continue; }
      if (!Number.isInteger(req) || req < 1 || req > requirements.length) { err(`covers: req ${c?.req} is not a requirement of your plan.`); continue; }
      covered.add(`${draft}#${n}`);
      plan.covers.push({ draft, n, req });
    }
    for (const d of Array.isArray(p.dropped) ? p.dropped : []) {
      const draft = str(d?.draft);
      const n = Number(d?.n);
      if (!drafts.has(draft) || !Number.isInteger(n) || n < 1 || n > drafts.get(draft).requirements.length) { err(`dropped: ${draft} #${d?.n} is not a draft requirement.`); continue; }
      if (!str(d?.why)) { err(`dropped: ${draft} #${n} needs a why.`); continue; }
      covered.add(`${draft}#${n}`);
      plan.dropped.push({ draft, n, why: str(d.why) });
    }
    const missing = [];
    for (const [handle, draft] of drafts) {
      draft.requirements.forEach((_, i) => { if (!covered.has(`${handle}#${i + 1}`)) missing.push(`${handle} #${i + 1}`); });
    }
    if (missing.length) err(`These draft requirements are in neither covers nor dropped: ${missing.slice(0, 20).join(', ')}.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

export function createPlanning(ctx) {
  const P = {};
  const planState = (job) => ({ settled: {}, nudged: {}, merge: null, baselineOk: false, baselineTries: 0, resubmit: null, lastError: null, ...(job.planning ?? {}) });
  const setPlan = (job, changes) => ctx.patch('jobs', job.id, { planning: { ...planState(ctx.job(job.id) ?? job), ...changes } });
  const drafts = (job) => Object.entries(job.planDrafts ?? {}).filter(([k]) => k !== 'final')
    .map(([bossId, plan]) => ({ bossId, handle: ctx.agent(bossId)?.handle ?? bossId, plan }));
  const needsBaseline = (job, final) => !job.newProject && Boolean(final?.check_cmd);

  /** The tick for a job in planning. */
  P.tick = (job) => {
    if (ctx.rt.steps.has(`apply:${job.id}`) || ctx.rt.steps.has(`baseline:${job.id}`)) return;
    const st = planState(job);
    const final = job.planDrafts?.final ?? null;
    const lead = ctx.lead(job);
    if (final) {
      if (needsBaseline(job, final) && !st.baselineOk) ctx.step(`baseline:${job.id}`, job.id, () => baseline(job.id));
      else ctx.step(`apply:${job.id}`, job.id, () => P.apply(job.id));
      return;
    }
    if (st.resubmit) {
      if (lead && !ctx.busy(lead.id) && !lead.hold) launch(job, lead, 'resubmit');
      return;
    }
    const bosses = ctx.bosses(job);
    const open = bosses.filter((b) => !st.settled[b.id]);
    for (const b of open) if (!ctx.busy(b.id) && !b.hold) launch(job, b, 'draft');
    if (open.length) return;
    const list = drafts(job);
    if (!list.length) {
      ctx.pauseJob(job, 'error', `No plan draft was made. ${st.lastError ? `Last error: ${st.lastError}` : ''}`.trim());
      return;
    }
    if (list.length === 1) {
      ctx.patch('jobs', job.id, { planDrafts: { ...job.planDrafts, final: list[0].plan } });
      ctx.kick();
      return;
    }
    const merge = st.merge ?? { by: lead?.id ?? list[0].bossId, tries: 0, nudged: 0 };
    if (!st.merge) setPlan(job, { merge });
    const by = ctx.agent(merge.by);
    if (by && !ctx.busy(by.id) && !by.hold) launch(ctx.job(job.id), by, 'merge');
  };

  function launch(job, agent, mode) {
    const st = planState(job);
    const nudging = mode === 'draft' ? (st.nudged[agent.id] ?? 0) > 0 && st.pendingNudge?.[agent.id]
      : mode === 'merge' ? st.merge?.pendingNudge : st.resubmit?.pendingNudge;
    const limits = ctx.limits();
    ctx.turns.main(agent, {
      kind: 'plan',
      label: mode,
      resumeOnly: Boolean(nudging),
      prompt: (view) => {
        const j = ctx.job(job.id);
        if (nudging) return `${view ? `${view}\n\n` : ''}${ctx.prompts.nudge('plan')}`;
        if (mode === 'merge') return ctx.prompts.planMergePrompt(j, view, drafts(j).map((d) => ({ handle: d.handle, plan: d.plan })), limits);
        if (mode === 'resubmit') return ctx.prompts.checkFailPrompt(j, view, { stage: 'baseline', cmd: st.resubmit.cmd, tail: st.resubmit.tail });
        return ctx.prompts.planPrompt(j, view, limits);
      },
      onStart: () => {
        const j = ctx.job(job.id);
        const s = planState(j);
        if (mode === 'draft' && s.pendingNudge?.[agent.id]) setPlan(j, { pendingNudge: { ...s.pendingNudge, [agent.id]: false } });
        if (mode === 'merge' && s.merge?.pendingNudge) setPlan(j, { merge: { ...s.merge, pendingNudge: false } });
        if (mode === 'resubmit' && s.resubmit?.pendingNudge) setPlan(j, { resubmit: { ...s.resubmit, pendingNudge: false } });
      },
      onEnd: (result, turn) => ended(job.id, agent.id, mode, result, turn),
    });
  }

  /** Turn-failure table rows "Plan draft" and "Plan merge" (section 12). */
  function ended(jobId, agentId, mode, result, turn) {
    const job = ctx.job(jobId);
    if (!job || job.status !== 'planning') return;
    const st = planState(job);
    if (turn.held) return; // rate limit or sign-in: the turn runs again when the lab is back
    const err = result.error?.message ?? (result.killed ? `the turn was stopped (${result.killed})` : null);
    if (mode === 'draft') {
      if (st.settled[agentId]) return;
      const failed = !result.ok || result.killed;
      if (!failed && (st.nudged[agentId] ?? 0) < 1) {
        setPlan(job, { nudged: { ...st.nudged, [agentId]: 1 }, pendingNudge: { ...(st.pendingNudge ?? {}), [agentId]: true } });
        return;
      }
      setPlan(job, { settled: { ...st.settled, [agentId]: 'dropped' }, lastError: err ?? 'no plan_submit' });
      ctx.say('info', 'orchestrator: plan draft dropped', { jobId, agentId, error: err });
      return;
    }
    if (job.planDrafts?.final) return;
    if (mode === 'resubmit') {
      if (!st.resubmit) return;
      if (!st.resubmit.nudged && result.ok && !result.killed) { setPlan(job, { resubmit: { ...st.resubmit, nudged: true, pendingNudge: true } }); return; }
      ctx.pauseJob(job, 'baseline', `The check fails on the project as it is now. ${oneLine(st.resubmit.tail, 600)}`);
      return;
    }
    const merge = st.merge ?? { by: agentId, tries: 0, nudged: 0 };
    if (!merge.nudged && result.ok && !result.killed) { setPlan(job, { merge: { ...merge, nudged: 1, pendingNudge: true } }); return; }
    const next = ctx.bosses(job).find((b) => b.id !== merge.by && !b.hold && ctx.providers.usable?.(b.provider) !== false);
    if (merge.tries < 1 && next) {
      setPlan(job, { merge: { by: next.id, tries: merge.tries + 1, nudged: 0 } });
      return;
    }
    ctx.pauseJob(job, 'error', `The plan merge failed: ${err ?? 'no plan_submit'}`);
  }

  /** plan_submit (boss). Returns the tool result. */
  P.submit = (agent, args) => {
    const job = ctx.job(agent.jobId);
    if (!job || job.status !== 'planning') return { text: 'ERR No plan is open in this work order now.', isError: true };
    const st = planState(job);
    const lead = ctx.lead(job);
    let mode = 'draft';
    if (st.merge && st.merge.by === agent.id) mode = 'merge';
    else if (st.resubmit && lead && lead.id === agent.id) mode = 'resubmit';
    else if (st.merge || job.planDrafts?.final) return { text: `ERR The plans are merged by ${ctx.agent(st.merge?.by)?.handle ?? 'the lead boss'} now.`, isError: true };
    const others = mode === 'merge' ? drafts(job) : [];
    const res = validatePlan(args, { kind: job.kind, maxTasks: ctx.limits().maxTasks, drafts: mode === 'merge' ? others : null });
    if (!res.ok) {
      return { text: `ERR plan_submit refused. Fix these, then call plan_submit again:\n${res.errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`, isError: true };
    }
    const plan = res.plan;
    if (mode === 'draft') {
      ctx.patch('jobs', job.id, { planDrafts: { ...(job.planDrafts ?? {}), [agent.id]: plan } });
      setPlan(ctx.job(job.id), { settled: { ...st.settled, [agent.id]: 'ok' } });
    } else {
      if (mode === 'resubmit' && st.merge) plan.dropped = copy(job.dropped ?? []);
      ctx.patch('jobs', job.id, { planDrafts: { ...(job.planDrafts ?? {}), final: plan }, dropped: plan.dropped });
      setPlan(ctx.job(job.id), { resubmit: null, baselineOk: false });
    }
    ctx.flush();
    ctx.kick();
    return mode === 'draft' ? 'ok. The hub stored your plan draft. Stop now.' : 'ok. The hub checks the plan and applies it. Stop now.';
  };

  /** Baseline gate (existing project): the head check twice before the plan is applied. */
  async function baseline(jobId) {
    const job = ctx.job(jobId);
    const final = job?.planDrafts?.final;
    const project = ctx.projectOf(job);
    if (!final || !project || job.status !== 'planning') return;
    const probe = { ...project, setupCmd: final.setup_cmd, checkCmd: final.check_cmd };
    const a = await ctx.git.headCheck(probe, jobId);
    const b = await ctx.git.headCheck(probe, jobId, { force: true });
    const ms = Math.max(Number(a.ms) || 0, Number(b.ms) || 0);
    const slow = ms > (ctx.limits().checkTimeoutMin * 60000) / 2;
    const flaky = a.ok !== b.ok;
    const ok = a.ok && b.ok && !slow;
    const tail = clip(!a.ok ? a.tail : b.tail, 4000);
    ctx.patch('projects', project.id, { baseline: { sha: a.sha, ok, flaky, ms, tail } });
    const now = ctx.job(jobId);
    if (!now || now.status !== 'planning' || now.planDrafts?.final !== final) return;
    if (ok) { setPlan(now, { baselineOk: true }); return; }
    const why = slow ? `The check took ${Math.round(ms / 1000)} s, more than half of the check time limit.` : flaky ? 'The check passed once and failed once (flaky).' : 'The check fails.';
    const st = planState(now);
    if (st.baselineTries < 1) {
      const { final: _drop, ...rest } = now.planDrafts;
      ctx.patch('jobs', jobId, { planDrafts: rest });
      setPlan(ctx.job(jobId), { baselineTries: 1, resubmit: { cmd: final.check_cmd, tail: `${why}\n${tail}`, nudged: false } });
      return;
    }
    ctx.pauseJob(now, 'baseline', `${why} Command: ${final.check_cmd}. ${oneLine(tail, 600)}`);
  }

  async function decide(task) {
    const d = ctx.decider;
    if (!d || typeof d.enabled !== 'function' || !d.enabled() || typeof d.sizeTask !== 'function') return null;
    try {
      const answer = await Promise.race([
        Promise.resolve(d.sizeTask({ title: task.title, spec: task.spec, acceptance: task.acceptance, zones: task.zones })),
        new Promise((resolve) => { ctx.timers.setTimeout(() => resolve(null), ctx.tuning.deciderTimeoutMs)?.unref?.(); }),
      ]);
      return isObj(answer) ? answer : null;
    } catch (err) {
      ctx.say('warn', 'orchestrator: decider failed', { error: errText(err) });
      return null;
    }
  }

  /** The pairing rule plus the decider. A decider answer can only raise care. */
  P.care = async (task) => {
    const pairing = ctx.settings().pairing;
    let size = task.size;
    let pair = pairing === 'all' || task.pair === true || (pairing === 'M+L' && (size === 'M' || size === 'L'));
    const d = await decide(task);
    if (d && SIZE_RANK[d.size] > SIZE_RANK[size]) {
      size = d.size;
      if (pairing === 'M+L') pair = true;
    }
    if (d && d.sensitive === true) pair = true;
    return { size, pair };
  };

  /** Stream label -> manager id, round-robin over the managers (section 12, streams). */
  P.streamManager = (job, stream, deps, extra = {}) => {
    const managers = ctx.managers(job).sort((a, b) => a.handle.localeCompare(b.handle, 'en', { numeric: true }));
    if (!managers.length) return null;
    const map = { ...(job.streams ?? {}), ...extra };
    if (stream && map[stream]) return map[stream];
    if (!stream && deps.length) {
      const first = ctx.task(deps[0]);
      if (first?.managerId) return first.managerId;
    }
    if (stream) return managers[Object.keys(map).length % managers.length].id;
    const load = (m) => ctx.openTasks(job.id).filter((t) => t.managerId === m.id).length;
    return [...managers].sort((a, b) => load(a) - load(b))[0].id;
  };

  /** Apply the final plan: requirements, tasks, commands, the plan notice, then plan_review or running. */
  P.apply = async (jobId) => {
    const job = ctx.job(jobId);
    const final = job?.planDrafts?.final;
    if (!job || !final || job.status !== 'planning') return;
    const requirements = final.requirements.map((r, i) => ({ id: `R${i + 1}`, text: r.text, source: 'plan', status: 'open', evidence: null, waivedReason: null }));
    const cares = await Promise.all(final.tasks.map((t) => P.care(t)));
    const again = ctx.job(jobId);
    if (!again || again.status !== 'planning' || again.planDrafts?.final !== final) return;
    const ids = new Map(final.tasks.map((t) => [t.key, ctx.store.nextId('T')]));
    const streams = { ...(job.streams ?? {}) };
    const made = [];
    final.tasks.forEach((t, i) => {
      const id = ids.get(t.key);
      const deps = t.deps.map((k) => ids.get(k));
      let managerId = P.streamManager(again, t.stream, [], streams);
      if (!t.stream && deps.length) managerId = made.find((m) => m.id === deps[0])?.managerId ?? managerId;
      if (t.stream && managerId && !streams[t.stream]) streams[t.stream] = managerId;
      const task = ctx.tasksApi.newTask(again, {
        id, title: t.title, spec: t.spec, acceptance: t.acceptance, reqs: t.reqs.map((n) => `R${n}`), domain: t.domain,
        size: cares[i].size, zones: t.zones, deps, pair: cares[i].pair, stream: t.stream, managerId,
      });
      made.push(task);
    });
    for (const task of made) ctx.put('tasks', task);
    const project = ctx.projectOf(again);
    if (project) ctx.patch('projects', project.id, { setupCmd: final.setup_cmd, checkCmd: final.check_cmd, noCheckReason: final.no_check_reason });
    const status = again.options?.approvePlan ? 'plan_review' : 'running';
    const auditor = ctx.crew.auditor(again);
    for (const b of ctx.bosses(again)) ctx.patch('agents', b.id, { sessionId: null, sessionCtx: null, digestNext: b.id === again.leadBossId });
    ctx.patch('jobs', jobId, {
      requirements, notes: final.notes ?? '',
      // defaults the hub took during planning (ASK @human) stay; the plan adds its own assumptions
      assumptions: [...(ctx.job(jobId).assumptions ?? []).filter((a) => a.msgId), ...final.assumptions.map((text) => ({ text, msgId: null }))],
      dropped: final.dropped ?? [], planDrafts: null, status, streams, auditDone: !auditor,
    });
    const lines = [
      `Plan for ${jobId}: ${made.length} tasks, ${requirements.length} requirements.`,
      ...requirements.map((r) => `${r.id}: ${oneLine(r.text, 160)}`),
      final.assumptions.length ? `Assumptions: ${final.assumptions.map((a) => oneLine(a, 120)).join('; ')}` : 'Assumptions: none.',
      (final.dropped ?? []).length ? `Dropped: ${final.dropped.map((d) => `${d.draft} #${d.n} (${oneLine(d.why, 80)})`).join('; ')}` : 'Dropped: none.',
      `Setup: ${final.setup_cmd || 'none'}. Check: ${final.check_cmd || `NOT CHECKED (${final.no_check_reason || 'no check'})`}.`,
    ];
    ctx.notice('owner', lines.join('\n'), jobId, null, 'blueprint');
    ctx.evt(jobId, { scope: '#plan', body: `Plan applied: ${made.length} tasks, ${requirements.length} requirements. Status ${status}.` });
    await ctx.flush();
    ctx.kick();
  };

  return P;
}
