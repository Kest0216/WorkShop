// Crew (section 12): personas, model picks, hiring makers, and the choice of buddy, reviewer, QA agent,
// ledger auditor and consult agent. Mock jobs bypass the router: every agent uses the mock lab.
import { handleFor, pickName, styleSeed } from '../names.js';
import { byIdNum, isOpenTask, idNum } from './context.js';

const MOCK_EFFORT = { boss: 'high', manager: 'medium' };
const MAKER_EFFORT = { S: 'low', M: 'medium', L: 'high' };
const ROLE_SPOTS = { boss: 3, manager: 3, maker: 8 };

export function createCrew(ctx) {
  const C = {};
  const live = (a) => a.status !== 'off' && !a.hidden;

  /** Agents per provider on the job, for the router's tie rule. */
  C.labLoad = (job) => {
    const load = {};
    for (const a of ctx.agentsOf(job.id, live)) load[a.provider] = (load[a.provider] ?? 0) + 1;
    return load;
  };

  /** Model ids of labs that are off for this job (agent files not accepted: the Gemini lab is off). */
  C.excluded = (job) => {
    const off = new Set(job.labsOff ?? []);
    const project = ctx.projectOf(job);
    if (project && (project.agentFiles ?? []).length && project.agentFilesAck === false) off.add('gemini');
    if (!off.size) return [];
    let models = [];
    try { models = ctx.router.registry()?.models ?? []; } catch { models = []; }
    return models.filter((m) => off.has(m.provider)).map((m) => m.id);
  };

  /** A usable agent: its lab works and it is not on hold. */
  C.usable = (agent) => Boolean(agent) && !agent.hold && agent.status !== 'off'
    && (typeof ctx.providers?.modelUsable !== 'function' || ctx.providers.modelUsable(agent.provider, agent.model) !== false);

  /** A model pick for a role. Mock jobs: the mock lab, no router. null when no model fits. */
  C.pick = (job, role, query = {}) => {
    if (ctx.isMock(job)) {
      const effort = role === 'maker' ? MAKER_EFFORT[query.size] ?? 'medium' : MOCK_EFFORT[role];
      return { provider: 'mock', model: `mock-${role}`, label: `Mock ${role}`, effort, why: 'Mock job: the mock lab.' };
    }
    const exclude = [...C.excluded(job), ...(query.exclude ?? [])];
    try {
      if ((role === 'maker' || role === 'manager') && query.avoidProvider !== 'oss' && ctx.providers?.usable?.('oss')) {
        const models = ctx.router.registry?.()?.models ?? [];
        if (models.some((m) => m.provider === 'oss')) {
          const nonOss = models.filter((m) => m.provider !== 'oss').map((m) => m.id);
          const ossPick = ctx.router.pick({ domain: 'plan', ...query, role, labLoad: query.labLoad ?? C.labLoad(job), exclude: [...exclude, ...nonOss] });
          if (ossPick) return ossPick;
        }
      }
      return ctx.router.pick({ domain: 'plan', ...query, role, labLoad: query.labLoad ?? C.labLoad(job), exclude }) ?? null;
    } catch (err) {
      ctx.say('warn', 'orchestrator: router pick failed', { role, error: String(err?.message ?? err) });
      return null;
    }
  };

  function freeSpot(job, role) {
    const used = new Set(ctx.agentsOf(job.id, (a) => a.role === role && live(a)).map((a) => a.spot));
    for (let i = 0; i < 1000; i++) if (!used.has(i)) return i;
    return ROLE_SPOTS[role] ?? 0;
  }

  /** A new persona with the pick's model. */
  C.newAgent = (job, role, pick, extra = {}) => {
    const all = ctx.agentsOf(job.id);
    const usedNames = new Set(all.map((a) => a.name));
    let name = typeof extra.name === 'string' && extra.name ? extra.name : pickName(role, [...usedNames], idNum(job.id) * 7);
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${name} ${suffix}`)) suffix += 1;
      name = `${name} ${suffix}`;
    }
    const n = all.filter((a) => a.role === role).length + 1;
    const style = extra.style && typeof extra.style === 'object' ? extra.style : { seed: styleSeed(name, pick.provider) };
    const agent = {
      id: ctx.store.nextId('A'), jobId: job.id, name, handle: handleFor(role, n), role, lead: false,
      provider: pick.provider, model: pick.model, modelLabel: pick.label ?? pick.model, effort: pick.effort ?? 'medium',
      style, spot: freeSpot(job, role), status: 'idle', taskId: null,
      sessionId: null, sessionCtx: null, hold: null, stats: { turns: 0, inTok: 0, outTok: 0, usd: 0, ctxTok: 0, ctxMax: 0 },
      bubble: null, lastActiveAt: ctx.now(), wake: null, boardSession: null,
      // A job with its own mock pace (the demo): the mock adapter reads it from the agent (MOCK_SPEED).
      ...(pick.provider === 'mock' && typeof job.options?.mockSpeed === 'number' ? { mockSpeed: job.options.mockSpeed } : {}),
      ...extra,
      name,
      style,
    };
    return ctx.put('agents', agent);
  };

  /**
   * The lab to avoid for the next persona of a role, so the labs alternate in that role when both are usable:
   * the lab with the most personas of the role so far, when no other lab has as many. The labLoad tie rule alone
   * does not alternate: one lab's model can lead the other by more than the tie gap (Fable 5.2 vs Carbon on plan).
   */
  const alternate = (list) => {
    const count = {};
    for (const a of list) count[a.provider] = (count[a.provider] ?? 0) + 1;
    const top = Object.entries(count).sort((x, y) => y[1] - x[1]);
    return top.length === 1 || (top.length > 1 && top[0][1] > top[1][1]) ? top[0][0] : undefined;
  };

  /** Bosses and managers from the crew preset. Returns { lead, bosses, managers } or null when no boss model fits. */
  C.createCrew = (job) => {
    const crew = job.crew ?? { bosses: 1, managers: 1, makers: 2 };
    const first = C.pick(job, 'boss', { domain: 'plan' });
    if (!first) return null;
    const lead = C.newAgent(job, 'boss', first, { lead: true });
    const bosses = [lead];
    for (let i = 1; i < Math.max(1, crew.bosses); i++) {
      // allowFallback off: an avoided lab can make the pick wait (null); then the lab balance gives way.
      const p = C.pick(job, 'boss', { domain: 'plan', avoidProvider: alternate(bosses) }) ?? C.pick(job, 'boss', { domain: 'plan' });
      if (p) bosses.push(C.newAgent(job, 'boss', p));
    }
    const managers = [];
    for (let i = 0; i < Math.max(0, crew.managers); i++) {
      const p = C.pick(job, 'manager', { domain: 'plan', avoidProvider: alternate(managers) }) ?? C.pick(job, 'manager', { domain: 'plan' });
      if (!p) continue;
      let extra = {};
      if (ctx.harnesses) {
        const h = ctx.harnesses.forDomain?.('plan', 'manager');
        if (h) extra.harnessId = h.id;
      }
      if (p.provider === 'oss' && ctx.roster && !ctx.isMock(job)) {
        const usedIds = managers.map((m) => m.rosterId).filter(Boolean);
        const match = ctx.roster.match({ domain: 'plan', role: 'manager', excludeIds: usedIds });
        if (match?.entry) {
          const e = match.entry;
          const regModel = (ctx.router?.registry?.()?.models ?? []).find((m) => m.id === e.baseModel && m.enabled !== false);
          const usableModel = regModel && ctx.providers?.modelUsable?.('oss', e.baseModel) !== false;
          extra = {
            name: e.name,
            style: e.style,
            rosterId: e.id,
            harnessId: e.harnessId || extra.harnessId || null,
            certification: e.certification,
          };
          if (usableModel) {
            p.model = e.baseModel;
            p.label = regModel.label ?? e.baseModel;
          }
        }
      }
      managers.push(C.newAgent(job, 'manager', p, extra));
    }
    return { lead, bosses, managers };
  };

  /**
   * Hire a maker (Specialist) for a task: router pick + Employee Book match + Harness Rack rig.
   */
  C.hireMaker = (job, task, { avoidProvider, bump = 0, exclude = [], requireOther = false } = {}) => {
    const pick = C.pick(job, 'maker', { domain: task.domain, size: task.size, avoidProvider, bump, exclude });
    if (!pick) return null;
    if (requireOther && avoidProvider && pick.provider === avoidProvider) return null;

    const domainHarness = ctx.harnesses?.forDomain?.(task.domain, 'maker') ?? null;
    let rosterMeta = {
      harnessId: domainHarness?.id ?? null,
      rosterId: null,
      certification: null,
    };
    let chosenPick = { ...pick };
    if (pick.provider === 'oss' && ctx.roster && !ctx.isMock(job)) {
      const busyRosterIds = ctx.agentsOf(job.id, (a) => a.role === 'maker' && a.taskId && a.rosterId).map((a) => a.rosterId);
      const match = ctx.roster.match({ domain: task.domain, role: 'maker', excludeIds: busyRosterIds });
      if (match?.entry) {
        const e = match.entry;
        const minPower = task.size === 'S' ? 1 : 3;
        const regModel = (ctx.router?.registry?.()?.models ?? []).find((m) => m.id === e.baseModel && m.enabled !== false && m.power >= minPower);
        const notExcluded = !(exclude || []).includes(e.baseModel);
        const usableModel = regModel && notExcluded && ctx.providers?.modelUsable?.('oss', e.baseModel) !== false;
        if (usableModel) {
          chosenPick = { ...chosenPick, model: e.baseModel, label: regModel.label ?? e.baseModel };
        }
        rosterMeta = {
          harnessId: (match.exactDomain ? e.harnessId : domainHarness?.id) || e.harnessId || domainHarness?.id || null,
          rosterId: e.id,
          certification: e.certification,
          matchedName: e.name,
          matchedStyle: e.style,
        };
      }
    }

    const makers = ctx.agentsOf(job.id, (a) => a.role === 'maker' && !a.hidden && !a.taskId && !ctx.busy(a.id)
      && a.model === chosenPick.model && a.provider === chosenPick.provider
      && (!rosterMeta.rosterId || !a.rosterId || a.rosterId === rosterMeta.rosterId));
    const free = makers.find((a) => a.status !== 'off');
    const off = makers.find((a) => a.status === 'off');
    const effort = MAKER_EFFORT[task.size] ?? chosenPick.effort ?? 'medium';
    let agent = free ?? off;
    if (agent) {
      agent = ctx.patch('agents', agent.id, {
        taskId: task.id,
        status: 'idle',
        effort,
        spot: agent.status === 'off' ? freeSpot(job, 'maker') : agent.spot,
        hold: null,
        ...(rosterMeta.harnessId ? { harnessId: rosterMeta.harnessId } : {}),
        ...(rosterMeta.rosterId ? { rosterId: rosterMeta.rosterId, certification: rosterMeta.certification } : {}),
      });
    } else {
      agent = C.newAgent(job, 'maker', { ...chosenPick, effort }, {
        taskId: task.id,
        ...(rosterMeta.harnessId ? { harnessId: rosterMeta.harnessId } : {}),
        ...(rosterMeta.rosterId ? {
          rosterId: rosterMeta.rosterId,
          certification: rosterMeta.certification,
          name: rosterMeta.matchedName,
          style: rosterMeta.matchedStyle,
        } : {}),
      });
    }
    return agent;
  };

  /** Unbind a maker from its task: it leaves the floor (off) and can be hired again later. */
  C.unbind = (agentId, taskId) => {
    const a = ctx.agent(agentId);
    if (!a || a.taskId !== taskId) return;
    ctx.patch('agents', a.id, { taskId: null, status: ctx.busy(a.id) ? a.status : 'off', wake: null });
  };

  /** Buddy: a maker of the other lab whose own task is not in working or rework, else a new hire. */
  C.buddyFor = (job, task, maker) => {
    if (!maker) return null;
    const own = (a) => (a.taskId ? ctx.task(a.taskId) : null);
    const candidates = ctx.agentsOf(job.id, (a) => a.role === 'maker' && !a.hidden && a.id !== maker.id && a.provider !== maker.provider
      && !ctx.busy(a.id) && C.usable({ ...a, status: 'idle' }) && !['working', 'rework'].includes(own(a)?.status));
    if (candidates.length) {
      const pickOne = candidates.sort(byIdNum)[0];
      if (pickOne.status === 'off') ctx.patch('agents', pickOne.id, { status: 'idle' });
      return ctx.agent(pickOne.id);
    }
    const pick = C.pick(job, 'maker', { domain: task.domain, size: task.size, avoidProvider: maker.provider });
    if (!pick || pick.provider === maker.provider) return null;
    return C.newAgent(job, 'maker', pick);
  };

  const reviewLoad = (agent) => ctx.tasksOf(agent.jobId, (t) => t.reviewerId === agent.id && ['review', 'buddy'].includes(t.status)).length
    + (ctx.busy(agent.id) ? 1 : 0);
  const leastBusy = (list) => [...list].sort((a, b) => reviewLoad(a) - reviewLoad(b) || byIdNum(a, b))[0] ?? null;

  /**
   * Reviewer choice (section 12, review). With review.crossLab: an S task that is not pair goes to the
   * other-lab manager first (review.smallByManager); else a usable boss of the other lab; else a manager of the
   * other lab; else the least busy usable boss. Without crossLab: the least busy usable boss.
   */
  C.reviewerFor = (job, task, delivery, { anyState = false } = {}) => {
    const s = ctx.settings().review;
    const maker = ctx.agent(task.assigneeId);
    const tried = new Set(delivery?.reviewers ?? []);
    // anyState: also agents that are on hold or whose lab cools now (is there anyone left at all?)
    const ok = (a) => a.id !== maker?.id && !tried.has(a.id) && (anyState || C.usable(a));
    const bosses = ctx.bosses(job).filter(ok);
    const managers = ctx.managers(job).filter(ok);
    if (s.crossLab !== false && maker) {
      const other = (a) => a.provider !== maker.provider;
      if (task.size === 'S' && !task.pair && s.smallByManager !== false) {
        const m = leastBusy(managers.filter(other));
        if (m) return m;
      }
      const b = leastBusy(bosses.filter(other));
      if (b) return b;
      const m = leastBusy(managers.filter(other));
      if (m) return m;
    }
    return leastBusy(bosses);
  };

  /** QA: a boss of another lab than the lead, else a manager of another lab, else the lead (fresh session). */
  C.qaAgent = (job) => {
    const lead = ctx.lead(job);
    if (!lead) return null;
    const other = (a) => a.provider !== lead.provider && C.usable(a);
    return ctx.bosses(job).find((a) => a.id !== lead.id && other(a)) ?? ctx.managers(job).find(other)
      ?? (C.usable(lead) ? lead : ctx.bosses(job).find((a) => C.usable(a)) ?? null);
  };

  /** Ledger audit: an agent of the other lab (boss, else manager). None: the audit is skipped. */
  C.auditor = (job) => {
    const lead = ctx.lead(job);
    if (!lead) return null;
    const other = (a) => a.provider !== lead.provider && C.usable(a);
    return ctx.bosses(job).find((a) => a.id !== lead.id && other(a)) ?? ctx.managers(job).find(other) ?? null;
  };

  /**
   * Consult: a manager-tier model of the other lab than `provider`. A manager persona of that lab if one is
   * free, else a hidden one-shot persona from a router pick. null: no usable other lab.
   */
  C.consultAgent = (job, provider, domain) => {
    const m = ctx.managers(job).find((a) => a.provider !== provider && C.usable(a) && !ctx.busy(a.id) && !a.wake);
    if (m) return m;
    const pick = C.pick(job, 'manager', { domain: domain ?? 'plan', avoidProvider: provider });
    if (!pick || pick.provider === provider) return null;
    const spare = ctx.agentsOf(job.id, (a) => a.hidden && a.role === 'manager' && a.model === pick.model && !ctx.busy(a.id));
    if (spare.length) return ctx.patch('agents', spare[0].id, { status: 'idle' });
    return C.newAgent(job, 'manager', pick, { hidden: true, status: 'idle' });
  };

  /** A new model for a persona whose model is cooled or not on the plan (fallback). */
  C.repick = (agent, query = {}) => {
    const job = ctx.job(agent.jobId);
    if (!job) return null;
    const pick = C.pick(job, agent.role, { domain: 'plan', ...query, exclude: [agent.model, ...(query.exclude ?? [])] });
    if (!pick || (pick.provider === agent.provider && pick.model === agent.model)) return null;
    return ctx.patch('agents', agent.id, {
      provider: pick.provider, model: pick.model, modelLabel: pick.label ?? pick.model, effort: pick.effort ?? agent.effort,
      sessionId: null, sessionCtx: null, hold: null, digestNext: agent.role !== 'maker',
    });
  };

  /** The manager of a task's stream, else the lead boss. */
  C.managerOf = (task) => {
    const job = ctx.job(task.jobId);
    const m = ctx.agent(task.managerId);
    return m && m.status !== 'off' ? m : ctx.lead(job);
  };

  C.openTasksOf = (agent) => ctx.tasksOf(agent.jobId, (t) => isOpenTask(t) && t.managerId === agent.id);
  return C;
}
