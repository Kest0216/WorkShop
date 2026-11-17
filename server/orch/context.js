// Shared context of the orchestrator parts (docs/ARCHITECTURE.md section 12).
// One object `ctx` holds the injected modules, the runtime maps (turns and hub steps in flight) and small helpers.
// Every part (plan, crew, turns, tasks, ...) attaches its functions to ctx and calls the others through it.
// Nothing here starts work: the scheduler does.
import { DEFAULT_SETTINGS } from '../config.js';

export const LIVE = new Set(['planning', 'plan_review', 'running', 'qa', 'delivering']);
export const ACTIVE = new Set([...LIVE, 'paused']);
export const ENDED = new Set(['done', 'cancelled']);
/** Task states in which the maker's work is in review: the bench is frozen (section 12, freeze). */
export const FROZEN = new Set(['checking', 'buddy', 'review', 'integrating']);
export const SIZE_RANK = { S: 1, M: 2, L: 3 };
export const PAUSE_REASONS = ['owner', 'budget', 'caps', 'qa', 'baseline', 'stalled', 'tampered', 'error'];

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isOpenTask = (t) => Boolean(t) && t.status !== 'merged' && t.status !== 'cancelled';
export const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...` : s;
};
export const oneLine = (text, max = 200) => clip(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
export const errText = (err) => (err instanceof Error ? err.message : String(err));
/** '1 crate', '2 crates', '0 crates'. `many` is the plural form when it is not word + 's'. */
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
/** The top-bar panels an owner notice can name (final wiring spec S5). null: no panel helps. */
export const NOTICE_PANELS = Object.freeze(['blueprint', 'truck', 'inbox', 'keys']);
export const idNum = (id) => Number(String(id ?? '').replace(/^\D+/, '')) || 0;
export const byIdNum = (a, b) => idNum(a.id) - idNum(b.id);
/** Deep copy of plain JSON data: store items are live objects, never change them in place. */
export const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Settings with every limit present (tests and old settings files may hold only a part). */
function mergedLimits(s) {
  const out = { ...DEFAULT_SETTINGS.limits, ...(isObj(s.limits) ? s.limits : {}) };
  for (const key of ['perProvider', 'taskTimeoutMin', 'rotateTok']) {
    out[key] = { ...DEFAULT_SETTINGS.limits[key], ...(isObj(s.limits?.[key]) ? s.limits[key] : {}) };
  }
  return out;
}

export const TUNING = Object.freeze({
  tickMs: 3000, // the scheduler also runs this often (section 12)
  managerDebounceMs: 20000, // manager events are batched into one digest turn
  managerMaxDelayMs: 60000, // a stream of events never delays a manager longer than this
  deciderTimeoutMs: 2500,
  stepFailMax: 3, // a hub step that throws this often in a row pauses the job (pauseReason error)
});

/**
 * @param {object} deps the createOrchestrator dependencies, plus now, timers, tuning
 */
export function createContext(deps) {
  const { store, board, log } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const tuning = { ...TUNING, ...(isObj(deps.tuning) ? deps.tuning : {}) };

  const ctx = {
    ...deps,
    now,
    timers,
    tuning,
    rt: {
      turns: new Map(), // agentId -> the turn in flight { kind, cls, jobId, taskId, board, startedAt, ... }
      steps: new Map(), // step key -> { jobId, at }
      stepFails: new Map(), // step key -> failures in a row
      noticed: new Set(), // one-off notice keys of this process
      presence: null, // owner presence when the hub has no settings writer
      stopped: false,
    },
  };

  ctx.say = (level, msg, data) => {
    try { if (typeof log === 'function') log(level, msg, data); } catch { /* logging never breaks the hub */ }
  };

  ctx.settings = () => {
    let s = {};
    try { s = deps.getSettings?.() ?? {}; } catch { s = {}; }
    if (!isObj(s)) s = {};
    return { ...DEFAULT_SETTINGS, ...s, limits: mergedLimits(s), review: { ...DEFAULT_SETTINGS.review, ...(isObj(s.review) ? s.review : {}) } };
  };
  ctx.limits = () => ctx.settings().limits;
  ctx.presence = () => ctx.rt.presence ?? (ctx.settings().presence === 'away' ? 'away' : 'here');

  // ---- store access
  ctx.get = (kind, id) => (typeof id === 'string' && id ? store.get(kind, id) : null);
  ctx.list = (kind, fn) => store.list(kind, fn);
  ctx.job = (id) => ctx.get('jobs', id);
  ctx.task = (id) => ctx.get('tasks', id);
  ctx.agent = (id) => ctx.get('agents', id);
  ctx.delivery = (id) => ctx.get('deliveries', id);
  ctx.project = (id) => ctx.get('projects', id);
  ctx.projectOf = (job) => (job ? ctx.project(job.projectId) : null);
  ctx.put = (kind, item) => store.put(kind, item);
  /** store.patch that never throws for a gone item. Returns the item or null. */
  ctx.patch = (kind, id, changes) => {
    if (!ctx.get(kind, id)) return null;
    try {
      return store.patch(kind, id, changes);
    } catch (err) {
      ctx.say('error', 'orchestrator: store patch failed', { kind, id, error: errText(err) });
      return null;
    }
  };
  ctx.tasksOf = (jobId, fn) => store.list('tasks', (t) => t.jobId === jobId && (!fn || fn(t))).sort(byIdNum);
  ctx.agentsOf = (jobId, fn) => store.list('agents', (a) => a.jobId === jobId && (!fn || fn(a))).sort(byIdNum);
  ctx.deliveriesOf = (jobId, fn) => store.list('deliveries', (d) => d.jobId === jobId && (!fn || fn(d))).sort(byIdNum);
  ctx.openTasks = (jobId) => ctx.tasksOf(jobId, isOpenTask);
  ctx.lead = (job) => {
    if (!job) return null;
    const lead = ctx.agent(job.leadBossId);
    if (lead) return lead;
    return ctx.agentsOf(job.id, (a) => a.role === 'boss' && !a.hidden)[0] ?? null;
  };
  ctx.bosses = (job) => ctx.agentsOf(job.id, (a) => a.role === 'boss' && !a.hidden && a.status !== 'off');
  ctx.managers = (job) => ctx.agentsOf(job.id, (a) => a.role === 'manager' && !a.hidden && a.status !== 'off');
  ctx.currentDelivery = (task) => (task ? ctx.delivery(task.deliveryId) : null);
  ctx.reqOf = (job, reqId) => (job?.requirements ?? []).find((r) => r.id === reqId) ?? null;
  ctx.isMock = (job) => job?.options?.mock === true;
  /** A monotonic sequence (the store's event seq): orders "set" against "turn started" when the clock stands still. */
  ctx.seq = () => Number(store.state?.seq) || 0;

  /** Patch one requirement of a job (requirements live inside the job record). */
  ctx.patchReq = (jobId, reqId, changes) => {
    const job = ctx.job(jobId);
    if (!job) return null;
    let found = null;
    const requirements = job.requirements.map((r) => {
      if (r.id !== reqId) return r;
      found = { ...r, ...changes };
      return found;
    });
    if (found) ctx.patch('jobs', jobId, { requirements });
    return found;
  };

  // ---- events
  // panel: the top-bar panel the notice is about (NOTICE_PANELS), or null. Every owner notice carries the field
  // (null too), so the UI never has to guess from the words. An info notice carries it only when one is named.
  ctx.notice = (level, text, jobId = null, key = null, panel = null) => {
    if (key) {
      if (ctx.rt.noticed.has(key)) return;
      ctx.rt.noticed.add(key);
    }
    const named = NOTICE_PANELS.includes(panel) ? panel : null;
    const evt = { level, text: clip(text, 2000), jobId };
    if (level === 'owner' || named) evt.panel = named;
    try { store.emit('notice', evt); } catch (err) { ctx.say('warn', 'orchestrator: notice failed', { error: errText(err) }); }
  };
  ctx.fx = (name, payload = {}) => {
    try { store.emit('fx', { name, payload }, { persist: false }); } catch { /* the scene can miss an effect */ }
  };
  /** Hub notice on the board (EVT). Never throws. */
  ctx.evt = (jobId, opts) => {
    try { return board.hubPost(jobId, opts); } catch (err) {
      ctx.say('warn', 'orchestrator: hub post failed', { jobId, error: errText(err) });
      return null;
    }
  };
  /** A ShopTalk line from @hub (FIX, ANS, NO, ASK @other). Returns the message or null. */
  ctx.hubLine = (jobId, line) => {
    try {
      const res = board.post({ jobId, hub: true, line });
      if (res.ok) return res.msg;
      ctx.say('warn', 'orchestrator: hub line refused', { jobId, code: res.code, hint: res.hint });
    } catch (err) {
      ctx.say('warn', 'orchestrator: hub line failed', { jobId, error: errText(err) });
    }
    return null;
  };
  /**
   * Open board items of a job (every one, however old: board.openItems). filter { scope?, kind?, fromId?, toId?, to? }.
   * Falls back to the last 500 messages for a board without openItems. Never throws.
   */
  ctx.openItems = (jobId, filter = {}) => {
    try {
      if (typeof board.openItems === 'function') return board.openItems(jobId, filter);
      return board.history({ jobId, limit: 500 }).filter((m) => m.state === 'open'
        && Object.entries(filter).every(([k, v]) => v === undefined || m[k] === v));
    } catch {
      return [];
    }
  };
  /** Owner questions whose default was taken and that the owner has not answered yet (they stay pinned). */
  ctx.pinned = (jobId) => {
    try {
      if (typeof board.pinned === 'function') return board.pinned(jobId);
      return board.history({ jobId, limit: 500 }).filter((m) => m.kind === 'ASK' && m.to === '@human' && m.defaulted === true);
    } catch {
      return [];
    }
  };
  ctx.flush = async () => {
    try { await store.flush(); } catch { /* flush never rejects, but be safe */ }
  };

  // ---- scheduling
  ctx.kick = () => { ctx.scheduler?.kick(); };
  ctx.busy = (agentId) => ctx.rt.turns.has(agentId) || (typeof deps.runner?.busy === 'function' && deps.runner.busy(agentId) === true);

  /**
   * Run one hub step (git work and the like) in the background, at most once per key at a time.
   * Its outcome is persisted by fn itself; a thrown error is counted, and too many in a row pause the job.
   */
  ctx.step = (key, jobId, fn) => {
    if (ctx.rt.steps.has(key) || ctx.rt.stopped) return false;
    const entry = { jobId, at: now() };
    ctx.rt.steps.set(key, entry);
    entry.promise = (async () => {
      try {
        await fn();
        ctx.rt.stepFails.delete(key);
      } catch (err) {
        const n = (ctx.rt.stepFails.get(key) ?? 0) + 1;
        ctx.rt.stepFails.set(key, n);
        ctx.say('error', 'orchestrator: hub step failed', { key, jobId, error: errText(err), n });
        if (n >= tuning.stepFailMax && jobId) {
          ctx.rt.stepFails.delete(key);
          const job = ctx.job(jobId);
          if (job && LIVE.has(job.status)) ctx.pauseJob(job, 'error', `The hub step ${key} failed ${n} times: ${oneLine(errText(err), 300)}`);
        }
      } finally {
        ctx.rt.steps.delete(key);
        ctx.kick();
      }
    })();
    return true;
  };
  ctx.stepsOf = (jobId) => [...ctx.rt.steps.values()].filter((s) => s.jobId === jobId).length;

  /**
   * Hub stop: every stop is `paused` with a reason and job.error (section 4). A pause never overwrites
   * prevStatus when the job is already paused.
   */
  ctx.pauseJob = (job, reason, error = null, { notice = true } = {}) => {
    const fresh = ctx.job(job.id);
    if (!fresh || ENDED.has(fresh.status) || fresh.status === 'queued') return fresh;
    const changes = { pauseReason: reason, error: error ?? fresh.error ?? null };
    if (fresh.status !== 'paused') {
      changes.prevStatus = fresh.status;
      changes.status = 'paused';
    }
    const out = ctx.patch('jobs', job.id, changes);
    if (notice) ctx.notice('owner', `${job.id} paused (${reason})${error ? `: ${error}` : '.'}`, job.id, null, 'blueprint');
    ctx.evt(job.id, { scope: '#ops', body: `Work order ${job.id} is paused (${reason}).` });
    return out;
  };

  return ctx;
}
