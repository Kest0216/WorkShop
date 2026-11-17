// The job state machine and the workflow MCP tools (docs/ARCHITECTURE.md section 12).
// createOrchestrator wires the parts under server/orch/ around one shared context:
//   context   injected modules, runtime maps (turns and hub steps in flight), helpers
//   scheduler tick(), queue and intake, holds and fallback, wakes, owner changes, audit, stall rule, recover()
//   plan      plan validation, drafts, merge, baseline gate, apply, plan notice
//   crew      personas, model picks, hiring, reviewer / buddy / QA / auditor / consult choice
//   turns     main, work and aux turns: sessions, rotation, holds, budget, turn gate
//   tasks     ready, bench, work turns, closing act, DONE / BLOCK / FAIL, needsAction
//   edits     task_add, task_update, task_retry, task_cancel, claims
//   handin    the hand-in pipeline and the circuit breaker
//   review    buddy check, review, verdicts, no-show
//   integrate serial integrate, tripwire, merged effects
//   qa        QA rounds, req_verify, delivering, report, done, ship, truck refresh
//   consult   ASK @other and the hub's own consults
//   events    board events -> state and wakes
//   owner     owner actions, truck view, diffs, inbox
//   tools     the hub tools of section 8 on mcp
//   resolver  the board callbacks (orch.resolver)
// No top-level side effects. Nothing starts until recover() (or tick()).
import * as defaultPrompts from './prompts.js';
import { createContext } from './orch/context.js';
import { createConsult } from './orch/consult.js';
import { createCrew } from './orch/crew.js';
import { createDigest } from './orch/digest.js';
import { createEdits } from './orch/edits.js';
import { createEvents, createWakes } from './orch/events.js';
import { createHandin } from './orch/handin.js';
import { createIntegrate } from './orch/integrate.js';
import { createOwner } from './orch/owner.js';
import { createPlanning, validatePlan } from './orch/plan.js';
import { createQa } from './orch/qa.js';
import { createResolver } from './orch/resolver.js';
import { createReview } from './orch/review.js';
import { createScheduler } from './orch/scheduler.js';
import { createTasks } from './orch/tasks.js';
import { createTools, TOOL_DEFS } from './orch/tools.js';
import { createTurns } from './orch/turns.js';

export { validatePlan, TOOL_DEFS };

/**
 * @param {object} deps
 *   store, board, mcp, runner, router, git, providers, decider?, prompts?, getSettings, paths, log?   (section 12)
 *   updateSettings?  settings writer (presence); without it presence lives in memory
 *   now?, timers?    clock and timer functions { setTimeout, clearTimeout, setInterval, clearInterval } (tests)
 *   tuning?          { tickMs, managerDebounceMs, managerMaxDelayMs, deciderTimeoutMs, stepFailMax } (tests)
 *   mailHook?        false when the Claude CLI has no mail hook (the maker card then says "call read")
 *   resolverTarget?  an object to fill with the board callbacks (the object given to createBoard as resolve)
 */
export function createOrchestrator(deps = {}) {
  for (const name of ['store', 'board', 'mcp', 'runner', 'git', 'paths']) {
    if (!deps[name]) throw new TypeError(`createOrchestrator needs ${name}`);
  }
  const ctx = createContext({ ...deps, prompts: deps.prompts ?? defaultPrompts });
  ctx.crew = createCrew(ctx);
  ctx.digest = createDigest(ctx);
  ctx.turns = createTurns(ctx);
  ctx.plan = createPlanning(ctx);
  ctx.tasksApi = createTasks(ctx);
  ctx.edits = createEdits(ctx);
  ctx.handin = createHandin(ctx);
  ctx.consult = createConsult(ctx);
  ctx.review = createReview(ctx);
  ctx.integrate = createIntegrate(ctx);
  ctx.qa = createQa(ctx);
  ctx.wakes = createWakes(ctx);
  ctx.events = createEvents(ctx);
  ctx.owner = createOwner(ctx);
  ctx.scheduler = createScheduler(ctx);
  const resolver = createResolver(ctx);
  if (deps.resolverTarget && typeof deps.resolverTarget === 'object') Object.assign(deps.resolverTarget, resolver);
  createTools(ctx).register(deps.mcp);

  const offBoard = deps.board.on((e) => ctx.events.handle(e));
  const offProviders = typeof deps.providers?.onChange === 'function' ? deps.providers.onChange(() => ctx.kick()) : null;

  const O = ctx.owner;

  /** Wait until no turn, no hub step and no tick is in flight (tests, shutdown). Resolves true when idle. */
  async function settle({ timeoutMs = 20000 } = {}) {
    const end = Date.now() + timeoutMs;
    const breath = () => new Promise((resolve) => setImmediate(resolve));
    while (Date.now() < end) {
      if (ctx.scheduler.busy()) { await ctx.scheduler.tick(); await breath(); continue; }
      const steps = [...ctx.rt.steps.values()].map((s) => s.promise).filter(Boolean);
      if (steps.length) { await Promise.race(steps); await breath(); continue; }
      if (ctx.rt.turns.size) { await new Promise((resolve) => setTimeout(resolve, 2)); continue; }
      await breath();
      await breath();
      if (!ctx.scheduler.busy() && !ctx.rt.steps.size && !ctx.rt.turns.size) return true;
    }
    return false;
  }

  /**
   * Stop scheduling at once; then wait (at most waitMs) for the hub steps in flight and flush the store.
   * index.js: const done = orch.shutdown(); await runner.shutdown(); git.shutdown(); await done.
   */
  async function shutdown({ waitMs = 10000 } = {}) {
    ctx.rt.stopped = true;
    ctx.scheduler.stop();
    try { offBoard?.(); } catch { /* gone */ }
    try { offProviders?.(); } catch { /* gone */ }
    const steps = [...ctx.rt.steps.values()].map((s) => s.promise).filter(Boolean);
    let timer = null;
    await Promise.race([Promise.allSettled(steps), new Promise((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); })]);
    clearTimeout(timer);
    await ctx.flush();
  }

  return {
    createJob: (input) => O.createJob(input),
    pauseJob: (id, opts) => O.pauseJob(id, opts),
    resumeJob: (id, opts) => O.resumeJob(id, opts),
    cancelJob: (id) => O.cancelJob(id),
    deleteJob: (id) => O.deleteJob(id),
    approvePlan: (jobId) => O.approvePlan(jobId),
    addReq: (jobId, input) => O.addReq(jobId, input),
    waiveReq: (jobId, reqId, input) => O.waiveReq(jobId, reqId, input),
    ackAgentFiles: (projectId, ack) => O.ackAgentFiles(projectId, ack),
    ship: (jobId, input) => ctx.qa.ship(jobId, input),
    discardTruck: (jobId) => O.discardTruck(jobId),
    requestChanges: (jobId, input) => O.requestChanges(jobId, input),
    stopTask: (taskId, input) => O.stopTask(taskId, input),
    retryTask: (taskId, input) => O.retryTask(taskId, input),
    cancelTask: (taskId, input) => O.cancelTask(taskId, input),
    ownerPost: (input) => O.ownerPost(input),
    truck: (jobId) => O.truck(jobId),
    diff: (jobId, opts) => O.diff(jobId, opts),
    inbox: (jobId) => O.inbox(jobId),
    setPresence: (state) => O.setPresence(state),
    presence: () => ctx.presence(),
    recover: () => ctx.scheduler.recover(),
    tick: () => ctx.scheduler.tick(),
    shutdown,
    settle,
    resolver,
    status: (jobId) => {
      const job = ctx.job(jobId);
      return job ? ctx.digest.statusTable(job) : '';
    },
    /** Internals for tests and the integration engineer. Not a stable API. */
    _ctx: ctx,
  };
}
