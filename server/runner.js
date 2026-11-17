// The runner: starts one agent turn as a CLI process, reads its stream, enforces limits, and cleans up.
// It knows nothing about a provider: the adapter (providers.get(id)) builds the command and parses the output.
//
// Process rules:
// - Every child runs in its own process group with pipes on stdout and stderr. stdin is the prompt and then
//   end-of-file, always: Node's pipe, or a real pipe that is already at end-of-file when the adapter asks for it
//   (stdinKind 'fifo'). Never /dev/null, never a terminal.
// - A turn is stopped with the adapter's stop signal, then SIGTERM, then SIGKILL, on timeout, cancel and shutdown.
// - An agent CLI starts its shell commands in their own process groups and sessions (proved: Claude Code
//   2.1.289). A signal to the group of the CLI does not reach them. So the runner records the process tree of
//   each turn while it runs, and kills what is left of it at the SIGKILL step and after the CLI has gone.
// - Every timer, stream and listener of a turn is released when the turn ends.
import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { openClosedPipe } from './shellenv.js';

const noop = () => {};
const RANK = { boss: 0, manager: 1, maker: 2 };
const KILL_TEXT = {
  timeout: 'The turn passed its time limit and was stopped.',
  idle: 'The agent gave no output for too long and was stopped.',
  cancel: 'The turn was cancelled.',
  interrupt: 'The turn was interrupted. Its session can resume later.',
  shutdown: 'The hub is shutting down.',
};
/** Turn kinds of section 10. The runner only logs them; a `work` turn moves task.progress. */
export const TURN_KINDS = Object.freeze(['plan', 'merge', 'work', 'buddy', 'review', 'qa', 'audit', 'consult', 'digest', 'change', 'report', 'stall', 'selftest']);
/**
 * The Claude mail hook (section 10) ships only after the provider test proves it. Proven on 2026-11-15 with the
 * real CLI 2.1.289 against the fake API (tests/claude-mailhook.integration.test.mjs): a command hook from
 * --settings <runDir>/settings.json runs with --setting-sources "", its additionalContext reaches the model, and
 * in safety `sandboxed` the hook reaches GET /mcp/:token/tag through WORKSHOP_TAG_URL while a Bash command of
 * the agent sees neither WORKSHOP_TAG_URL nor WORKSHOP_TOKEN. So Claude turns get mailHook:true. (agy: no hook.)
 */
export const MAIL_HOOK = true;
const MAX_TIMER_MS = 2 ** 31 - 1; // a longer setTimeout fires at once
const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,lstart='];
const PS_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
const TUNING = {
  minSpawnGapMs: 1500, // at least this long between two spawns
  killGraceMs: 5000, // stop signal -> SIGTERM -> SIGKILL, this long apart
  shutdownGraceMs: 1500, // the same steps at shutdown
  closeWaitMs: 2000, // after the leader exits: wait this long for its pipes to close
  resultGraceMs: 20_000, // after a result line: the CLI gets this long to end by itself, then it is stopped
  treeScanMs: 3000, // how often the process tree of the running turns is recorded (0 = never)
  toolScanMs: 300, // a tool call starts a shell: look at the tree this soon after it
  treeMax: 2000, // processes remembered per turn
  psPath: '/bin/ps',
  psTimeoutMs: 5000,
  psKillTimeoutMs: 1500, // the look at the tree right before a SIGKILL must not delay it for long
  logFlushMs: 250, // agentlog events: at most 4 per second per agent
  logLinesPerFlush: 40,
  logLineChars: 600,
  tailLines: 200,
  tailAgents: 300,
  maxLineBytes: 8 * 1024 * 1024, // a longer output line is dropped
  stderrTailBytes: 8192,
  logRotateBytes: 20 * 1024 * 1024,
  rawLogMaxBytes: 64 * 1024 * 1024, // per turn: after this much the raw stream is not written to the log any more
  maxCalls: 5000, // tool names kept in TurnResult.calls
  maxDenied: 500, // entries kept in TurnResult.denied
  progressEveryMs: 2000,
  contextEveryMs: 5000, // agent.stats.ctxTok is refreshed at most this often during a turn
  defaultTurnTimeoutMin: 45,
  defaultIdleTimeoutMin: 12,
  sleepGapMs: 60_000, // shop time: a gap this long between two watchdog runs (sleep, a stopped hub) is not counted
  mailHook: MAIL_HOOK,
};
const TAIL_RECORD = 'workshop_line'; // a log-view line {k,s} in data/logs/<agentId>.jsonl (rebuilds logTail after a restart)
const TAIL_READ_BYTES = 1024 * 1024;
const TURN_FILE = 'turn.json'; // <run dir>/<agent>/turn.json: the process of the turn that runs now (see reapOrphans)
const SAME_PROCESS_MS = 5000; // a process is "the same" when ps gives it a start time this close to the recorded one
const SELFTEST_TOOL = 'selftest_ping';
const SELFTEST_ROLE = 'selftest';

const clip = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const safeName = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'agent';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const emptyUsage = () => ({ inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 });
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** "  12   1  12 Sun Nov 15 07:02:14 2026" lines of ps -> Map(pid -> { pid, ppid, pgid, start }). */
function parseProcs(text) {
  const procs = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4] });
  }
  return procs;
}

function childrenIndex(procs) {
  const byParent = new Map();
  for (const p of procs.values()) {
    const list = byParent.get(p.ppid);
    if (list) list.push(p);
    else byParent.set(p.ppid, [p]);
  }
  return byParent;
}

/**
 * The redactor of one turn: this turn's token and key, then the shared redactor of the hub (every stored key
 * value and every live agent token, section 14). The turn's own values stay covered after its token is revoked.
 */
function turnRedactor(values, shared) {
  const own = makeRedactor(values);
  if (!shared || typeof shared.redact !== 'function') return own;
  return (text) => {
    const first = own(text);
    try { return String(shared.redact(first) ?? ''); } catch { return first; }
  };
}

/** Replace every known secret value in a text. Values shorter than 8 characters are not secrets. */
function makeRedactor(values) {
  const secrets = [...new Set(values.filter((v) => typeof v === 'string' && v.length >= 8))].sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return (text) => String(text ?? '');
  return (text) => {
    let out = String(text ?? '');
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    return out;
  };
}

/**
 * @param {object} deps
 * @param {object} deps.store        section 5: get, patch, put, remove, emit
 * @param {object} deps.providers    registry: get(id), usable(id), ready(id), modelUsable(id, model), status(id),
 *                                   keyEnv(id), cool(), noteSuccess(), markAuth(), noteLimit()
 * @param {object} deps.mcp          tokenFor(agentId), registerTool(), revoke()
 * @param {object} [deps.git]        writeHubFiles(dir, files), cleanAgentDir(dir, keep) (section 9)
 * @param {object} [deps.redactor]   the shared redactor (section 14): redact(text)
 * @param {object} deps.paths        { server, data, run, logs, config }
 * @param {() => object} deps.getSettings
 * @param {object} [deps.shellEnv]   kept for the contract; the adapters hold the environment
 * @param {() => string} deps.getMcpUrl   the MCP base URL, for example http://127.0.0.1:4317/mcp (known after listen)
 * @param {(provider: string, model: string, usage: object) => number|null} [deps.priceFor]  cost of a turn from its token counts
 * @param {object} [deps.tuning]     overrides of TUNING (tests)
 */
export function createRunner({
  store, providers, mcp, git = null, redactor = null, paths, getSettings, shellEnv, log = noop, getMcpUrl, priceFor, now = () => Date.now(), tuning = {},
} = {}) {
  if (!store || !providers || !mcp || !paths) throw new Error('createRunner needs store, providers, mcp and paths');
  void shellEnv;
  const T = { ...TUNING, ...tuning };
  const say = (level, msg, data) => {
    try { log(level, msg, data); } catch { /* a broken logger must not break a turn */ }
  };
  const active = new Map(); // agentId -> run
  const queue = []; // entries that wait for a free slot
  const tails = new Map(); // agentId -> last log lines [{ k, s }]
  const pings = new Map(); // self-test agent id -> { count }
  let seq = 0;
  let lastSpawnAt = 0;
  let pumpTimer = null;
  let preparing = false; // one turn at a time is between "left the queue" and "spawned"
  let shuttingDown = false;
  let pingRegistered = false;
  let priceCache = null; // { mtimeMs, byId }
  let scanTimer = null;
  let toolScanTimer = null;
  let scanning = null; // the tree scan that runs now
  let lastScanAt = 0;
  let exitHooked = false;
  let reaped = null; // the one look for leftovers of an earlier hub
  const hubAt = Date.now() - Math.round(process.uptime() * 1000); // when this hub process started

  const settings = () => {
    try { return getSettings?.() ?? {}; } catch { return {}; }
  };
  const mcpUrl = () => {
    const url = typeof getMcpUrl === 'function' ? getMcpUrl() : typeof mcp.url === 'function' ? mcp.url() : mcp.url;
    if (typeof url !== 'string' || !url) throw new Error('the MCP URL is not known yet (the server is not listening)');
    return url.replace(/\/+$/, '');
  };
  const failure = (kind, message, resetAt = null, model = null) => ({ kind, message: clip(message, 300), resetAt, ...(model ? { model } : {}) });
  // The deny-read list of the hub (section 10): data/run, data/logs and config/ of WorkShop, plus the whole data
  // folder (state, the benches of all agents). An adapter with an OS sandbox closes these for reading (the
  // bench of the agent itself stays readable).
  const privateDirs = [...new Set([paths.data, paths.run, paths.logs, paths.config, paths.data ? null : paths.work]
    .filter((d) => typeof d === 'string' && d).map((d) => path.resolve(d)))];
  const modeOf = (provider) => settings().auth?.[provider] ?? null;

  // ------------------------------------------------------------------------------------------- cost

  /**
   * Default price lookup: config/models.json, USD per million tokens ({ in, out, next?: { from, in, out },
   * cacheRead?, cacheWrite?, cacheWrite1h? }). A slug such as gemini-4-hydrogen-low uses the price of its model.
   * Cache rates that the registry does not give: Claude reads 0.1x, writes 1.25x (one-hour writes 2x) of the
   * input price; Gemini 4 reads 0.05x, older Gemini models 0.1x.
   */
  function defaultPrice(provider, model, usage) {
    try {
      const file = path.join(paths.config ?? '', 'models.json');
      const stat = fs.statSync(file);
      if (!priceCache || priceCache.mtimeMs !== stat.mtimeMs) {
        const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
        const byId = new Map();
        for (const m of Array.isArray(registry?.models) ? registry.models : []) if (typeof m?.id === 'string' && m.price) byId.set(m.id, m.price);
        priceCache = { mtimeMs: stat.mtimeMs, byId };
      }
      const id = String(model ?? '');
      let price = priceCache.byId.get(id);
      if (!price) {
        let best = '';
        for (const known of priceCache.byId.keys()) if (id.startsWith(`${known}-`) && known.length > best.length) best = known;
        price = best ? priceCache.byId.get(best) : null;
      }
      if (!price) return null;
      let inPrice = num(price.in ?? price.input);
      let outPrice = num(price.out ?? price.output);
      const next = price.next;
      if (next && typeof next === 'object' && typeof next.from === 'string') {
        const from = Date.parse(next.from);
        if (Number.isFinite(from) && now() >= from) {
          inPrice = num(next.in ?? next.input ?? inPrice);
          outPrice = num(next.out ?? next.output ?? outPrice);
        }
      }
      const claude = id.startsWith('claude-');
      const readPrice = typeof price.cacheRead === 'number' ? price.cacheRead : inPrice * (id.startsWith('gemini-4') ? 0.05 : 0.1);
      const writePrice = typeof price.cacheWrite === 'number' ? price.cacheWrite : inPrice * (claude ? 1.25 : 1);
      const hourPrice = typeof price.cacheWrite1h === 'number' ? price.cacheWrite1h : inPrice * (claude ? 2 : 1);
      const hour = Math.min(num(usage.cacheWrite1h), num(usage.cacheWrite));
      const usd = (num(usage.inTok) * inPrice + (num(usage.cacheWrite) - hour) * writePrice + hour * hourPrice + num(usage.cacheRead) * readPrice + num(usage.outTok) * outPrice) / 1e6;
      return Number.isFinite(usd) ? usd : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------- agent log

  function logLine(run, k, text) {
    const s = clip(run.redact(text), T.logLineChars);
    if (!s) return;
    const id = run.agentId;
    let tail = tails.get(id);
    if (!tail) {
      if (tails.size >= T.tailAgents) tails.delete(tails.keys().next().value);
      tail = [];
      tails.set(id, tail);
    }
    tail.push({ k, s });
    if (tail.length > T.tailLines) tail.splice(0, tail.length - T.tailLines);
    // The same line goes into the agent's log file, so logTail() can rebuild the tail after a hub restart.
    // It counts against the per-turn log limit like the raw stream.
    if (run.raw && !run.rawCapped && run.rawBytes < T.rawLogMaxBytes) {
      const rec = `${JSON.stringify({ type: TAIL_RECORD, ts: now(), k, s })}\n`;
      run.rawBytes += rec.length;
      try { run.raw.write(rec); } catch { /* the in-memory tail still has it */ }
    }
    if (run.pending.length < T.logLinesPerFlush) run.pending.push({ k, s });
    else run.dropped += 1;
    if (!run.flushTimer && !run.finished) run.flushTimer = setTimeout(() => { run.flushTimer = null; flushLog(run); }, T.logFlushMs);
  }

  function flushLog(run) {
    if (run.pending.length === 0) return;
    const lines = run.pending;
    run.pending = [];
    if (run.dropped > 0) {
      lines.push({ k: 'sys', s: `(${run.dropped} more lines not shown)` });
      run.dropped = 0;
    }
    try { store.emit('agentlog', { agentId: run.agentId, lines }, { persist: false }); } catch (err) { say('warn', 'runner: cannot emit agentlog', { error: err?.message }); }
  }

  /**
   * One line for data/logs/<agentId>.jsonl. Known secrets are replaced. The log of one turn is limited, and a
   * slow disk slows the agent down instead of filling the memory of the hub.
   */
  function rawWrite(run, text) {
    const stream = run.raw;
    if (!stream) return;
    if (run.rawBytes >= T.rawLogMaxBytes) {
      if (!run.rawCapped) {
        run.rawCapped = true;
        stream.write(`${JSON.stringify({ type: 'workshop_log_capped', ts: now(), bytes: run.rawBytes })}\n`);
        logLine(run, 'sys', 'the agent printed very much: the rest of this turn is not written to its log file');
      }
      return;
    }
    const line = `${run.redact(text)}\n`;
    run.rawBytes += line.length;
    if (stream.write(line) || run.paused || !run.child || run.exited) return; // what a dead agent left in the pipe is read at once
    run.paused = true;
    run.child.stdout?.pause();
    run.child.stderr?.pause();
    stream.once('drain', () => {
      run.paused = false;
      if (run.finished) return;
      run.lastActivity = now();
      run.child?.stdout?.resume();
      run.child?.stderr?.resume();
    });
  }

  // ------------------------------------------------------------------------------------------- store updates

  const getItem = (kind, id) => {
    try { return id ? store.get(kind, id) ?? null : null; } catch { return null; }
  };
  const patchItem = (kind, id, changes) => {
    try { if (getItem(kind, id)) store.patch(kind, id, changes); } catch (err) { say('warn', 'runner: store update failed', { kind, id, error: err?.message }); }
  };

  /**
   * The session id of the turn. It goes back to the caller in TurnResult.sessionId. The runner never writes
   * agent.sessionId: the orchestrator stores the id on the work item (section 12).
   */
  function setSession(run, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || run.sessionId === sessionId) return;
    run.sessionId = sessionId;
  }

  /** Only a `work` turn moves task.progress (of opts.taskId), from its tool count. */
  function progress(run) {
    if (run.kind !== 'work' || !run.taskId) return;
    if (now() - run.progressAt < T.progressEveryMs) return;
    const task = getItem('tasks', run.taskId);
    if (!task) return;
    const value = Math.min(0.9, Math.round((1 - Math.exp(-run.calls.length / 20)) * 100) / 100);
    if (value >= num(task.progress) + 0.02) {
      run.progressAt = now();
      patchItem('tasks', run.taskId, { progress: value });
    }
  }

  /** agent.stats.ctxTok / ctxMax during a turn (the context bar of the UI). */
  function showContext(run) {
    if (run.ctxTok <= 0 || now() - run.contextAt < T.contextEveryMs) return;
    const agent = getItem('agents', run.agentId);
    if (!agent) return;
    const stats = agent.stats ?? {};
    if (stats.ctxTok === run.ctxTok && (run.ctxMax <= 0 || stats.ctxMax === run.ctxMax)) return;
    run.contextAt = now();
    patchItem('agents', run.agentId, { stats: { ...stats, ctxTok: run.ctxTok, ...(run.ctxMax > 0 ? { ctxMax: run.ctxMax } : {}) } });
  }

  function account(run, usage, usd) {
    const agent = getItem('agents', run.agentId);
    if (!agent) return;
    const inTok = usage.inTok + usage.cacheRead + usage.cacheWrite;
    const stats = agent.stats ?? {};
    patchItem('agents', run.agentId, {
      stats: {
        ...stats, // ctxTok, ctxMax and what other modules keep here
        turns: num(stats.turns) + 1, inTok: num(stats.inTok) + inTok, outTok: num(stats.outTok) + usage.outTok, usd: num(stats.usd) + num(usd),
        ...(run.ctxTok > 0 ? { ctxTok: run.ctxTok } : {}),
        ...(run.ctxMax > 0 ? { ctxMax: run.ctxMax } : {}),
      },
      lastActiveAt: now(),
    });
    // job.cost = { billedUsd, estUsd, inTok, outTok }: a turn of a lab in apikey mode is billed, a subscription
    // (or mock) turn is an estimate at API prices. There is no job.cost.usd.
    const job = getItem('jobs', run.jobId ?? agent.jobId);
    if (job) {
      const { usd: _old, ...cost } = job.cost ?? {};
      void _old;
      const billed = run.mode === 'apikey';
      patchItem('jobs', job.id, {
        cost: {
          ...cost,
          billedUsd: num(cost.billedUsd) + (billed ? num(usd) : 0),
          estUsd: num(cost.estUsd) + (billed ? 0 : num(usd)),
          inTok: num(cost.inTok) + inTok,
          outTok: num(cost.outTok) + usage.outTok,
        },
      });
    }
    // The task of this turn (opts.taskId): a review turn of a boss pays into the task it reviews.
    const task = getItem('tasks', run.taskId);
    if (task && num(usd) > 0) patchItem('tasks', task.id, { cost: { ...(task.cost ?? {}), usd: num(task.cost?.usd) + num(usd) } });
    if (job) checkBudget(job.id);
  }

  /**
   * Budget stop (section 12): when job.cost.billedUsd reaches job.budgetUsd, every running turn of that job
   * whose lab is in apikey mode is interrupted (its session resumes later), and its waiting apikey turns end.
   */
  function checkBudget(jobId) {
    const job = getItem('jobs', jobId);
    if (!job || typeof job.budgetUsd !== 'number' || !Number.isFinite(job.budgetUsd)) return;
    if (num(job.cost?.billedUsd) < job.budgetUsd) return;
    const billedTurn = (entry) => entry.jobId === jobId && modeOf(entry.provider) === 'apikey';
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!billedTurn(queue[i])) continue;
      const [entry] = queue.splice(i, 1);
      entry.resolve(turnResult({ killed: 'interrupt', error: failure('other', `${KILL_TEXT.interrupt} The job budget is used up.`) }, entry.t0, entry));
    }
    for (const other of [...active.values()]) {
      if (other.finished || other.ending || !billedTurn(other)) continue;
      say('warn', 'runner: job budget reached, interrupting a billed turn', { agent: other.agentId, job: jobId });
      interruptRun(other, 'The job budget is used up.');
    }
  }

  /**
   * The cost cap of one billed (apikey) turn: the lowest of opts.maxBudgetUsd, limits.turnUsd and the budget of
   * the job that remains, each when it is set. `spent`: the job has a budget and nothing of it remains.
   * @returns {{ cap: number|undefined, spent: boolean }}
   */
  function billedCap(run, limits) {
    const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const caps = [];
    if (positive(run.opts?.maxBudgetUsd)) caps.push(run.opts.maxBudgetUsd);
    if (positive(limits?.turnUsd)) caps.push(limits.turnUsd);
    const job = getItem('jobs', run.jobId);
    if (job && typeof job.budgetUsd === 'number' && Number.isFinite(job.budgetUsd)) {
      const left = job.budgetUsd - num(job.cost?.billedUsd);
      if (!(left > 0)) return { cap: undefined, spent: true };
      caps.push(left);
    }
    return { cap: caps.length > 0 ? Math.round(Math.min(...caps) * 1e6) / 1e6 : undefined, spent: false };
  }

  // ------------------------------------------------------------------------------------------- process tree

  /** The process table, or null when ps gave none. Never rejects. */
  function readProcs(timeoutMs = T.psTimeoutMs) {
    return new Promise((resolve) => {
      try {
        execFile(T.psPath, PS_ARGS, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: PS_ENV }, (err, stdout) => {
          resolve(err ? null : parseProcs(stdout));
        });
      } catch {
        resolve(null);
      }
    });
  }

  function readProcsSync() {
    try {
      return parseProcs(execFileSync(T.psPath, PS_ARGS, { timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: PS_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      return null;
    }
  }

  /**
   * Record the descendants of a turn's process. A descendant is remembered by pid and start time, so a pid that
   * the system gave to another process later is never taken for it. Entries that are gone are dropped.
   */
  function updateKin(run, procs, byParent) {
    const leader = run.child?.pid;
    if (!leader) return;
    const roots = [];
    if (!run.exited && procs.has(leader)) roots.push(leader);
    for (const [pid, start] of run.kin) {
      const p = procs.get(pid);
      if (p && p.start === start) roots.push(pid);
      else run.kin.delete(pid);
    }
    const seen = new Set(roots);
    const stack = [...roots];
    while (stack.length > 0) {
      for (const child of byParent.get(stack.pop()) ?? []) {
        if (seen.has(child.pid) || child.pid === process.pid || child.pid <= 1) continue;
        seen.add(child.pid);
        if (run.kin.size < T.treeMax) run.kin.set(child.pid, child.start);
        stack.push(child.pid);
      }
    }
  }

  /** Signal every remembered descendant that is still the same process, and the process groups they are in. */
  function killKin(run, signal, procs) {
    const hubGroup = procs.get(process.pid)?.pgid;
    const groups = new Set();
    const pids = [];
    for (const [pid, start] of run.kin) {
      const p = procs.get(pid);
      if (!p || p.start !== start) continue;
      pids.push(pid);
      if (p.pgid > 1 && p.pgid !== hubGroup && p.pgid !== process.pid) groups.add(p.pgid);
    }
    for (const group of groups) {
      try { process.kill(-group, signal); } catch { /* gone */ }
    }
    for (const pid of pids) {
      try { process.kill(pid, signal); } catch { /* gone */ }
    }
    return pids.length;
  }

  /** One look at the process table for all running turns. Calls that overlap share one look. */
  function scanNow() {
    if (scanning) return scanning;
    lastScanAt = now();
    scanning = readProcs().then((procs) => {
      scanning = null;
      if (!procs) return;
      const byParent = childrenIndex(procs);
      for (const run of active.values()) {
        if (!run.spawned || run.finished || run.ending) continue;
        updateKin(run, procs, byParent);
        writeTurnFile(run);
      }
    }, () => { scanning = null; });
    return scanning;
  }

  // ------------------------------------------------------------------------------------------- leftovers of a dead hub

  /**
   * <run dir>/<agent>/turn.json names the process of the running turn and the descendants seen so far. When the
   * hub dies without a chance to clean up (kill -9, power loss of the app), the next hub finds these files.
   */
  function writeTurnFile(run) {
    if (!run.turnFile || !run.child?.pid) return;
    const kin = [...run.kin];
    const text = JSON.stringify({ v: 1, hub: process.pid, hubAt, agent: run.agentId, pid: run.child.pid, at: run.spawnedAt, kin });
    if (text === run.turnText) return;
    run.turnText = text;
    try { fs.writeFileSync(run.turnFile, text, { mode: 0o600 }); } catch (err) { say('warn', 'runner: cannot write the turn file', { agent: run.agentId, error: err?.message }); }
  }

  function removeTurnFile(run) {
    if (!run.turnFile) return;
    try { fs.rmSync(run.turnFile, { force: true }); } catch { /* best effort */ }
    run.turnFile = null;
  }

  /**
   * Kill the agent processes that an earlier hub left behind (it was killed, or it crashed hard). A process is
   * killed only when its pid AND its start time match the record, so a pid that the system gave to another
   * process is never touched. Records of a hub that still runs are left alone. Call it once at boot, before
   * turns are resumed. The first turn of this runner also waits for it.
   * @returns {Promise<number>} how many processes were killed
   */
  async function reapOrphans() {
    const records = [];
    let names = [];
    try { names = fs.readdirSync(paths.run); } catch { return 0; }
    for (const name of names) {
      const file = path.join(paths.run, name, TURN_FILE);
      try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (rec && typeof rec === 'object' && Number.isInteger(rec.pid) && rec.pid > 1) records.push({ file, rec });
      } catch { /* no turn file, or a broken one */ }
    }
    if (records.length === 0) return 0;
    const procs = await readProcs();
    if (!procs) return 0;
    const byParent = childrenIndex(procs);
    const same = (pid, at) => {
      const p = procs.get(pid);
      return p && Number.isFinite(at) && Math.abs(Date.parse(p.start) - at) <= SAME_PROCESS_MS ? p : null;
    };
    const hubGroup = procs.get(process.pid)?.pgid;
    let killed = 0;
    for (const { file, rec } of records) {
      if (rec.hub === process.pid && rec.hubAt === hubAt) continue; // a turn of this hub
      if (same(rec.hub, rec.hubAt)) continue; // the hub that started it still runs
      const victims = new Map();
      const leader = same(rec.pid, rec.at);
      if (leader) victims.set(leader.pid, leader);
      for (const entry of Array.isArray(rec.kin) ? rec.kin.slice(0, T.treeMax) : []) {
        const p = Array.isArray(entry) ? procs.get(entry[0]) : null;
        if (p && p.start === entry[1]) victims.set(p.pid, p);
      }
      // The agent led its own process group (pgid = its pid). When the agent itself is gone, what it started in
      // that group is still there, also a process no scan saw. Only members that started after the agent count:
      // a group id is free again only after the whole group ended and the pid went to someone else.
      for (const p of procs.values()) {
        if (p.pgid !== rec.pid || p.pid === process.pid || p.pid <= 1 || victims.has(p.pid)) continue;
        if (Number.isFinite(rec.at) && Date.parse(p.start) >= rec.at - SAME_PROCESS_MS) victims.set(p.pid, p);
      }
      const stack = [...victims.keys()];
      while (stack.length > 0) {
        for (const child of byParent.get(stack.pop()) ?? []) {
          if (victims.has(child.pid) || child.pid === process.pid || child.pid <= 1) continue;
          victims.set(child.pid, child);
          stack.push(child.pid);
        }
      }
      const groups = new Set([...victims.values()].map((p) => p.pgid).filter((g) => g > 1 && g !== hubGroup && g !== process.pid));
      for (const group of groups) {
        try { process.kill(-group, 'SIGKILL'); } catch { /* gone */ }
      }
      for (const pid of victims.keys()) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
      killed += victims.size;
      if (victims.size > 0) say('warn', 'runner: killed agent processes of an earlier hub', { agent: rec.agent ?? null, count: victims.size });
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    return killed;
  }

  function reapOnce() {
    if (!reaped) reaped = reapOrphans().catch((err) => { say('warn', 'runner: the look for leftovers failed', { error: err?.message }); return 0; });
    return reaped;
  }

  function armScan() {
    if (scanTimer || !(T.treeScanMs > 0)) return;
    scanTimer = setInterval(() => {
      if ([...active.values()].some((run) => run.spawned && !run.finished)) scanNow();
      else disarmScan();
    }, T.treeScanMs);
    scanTimer.unref?.();
  }

  function disarmScan() {
    clearInterval(scanTimer);
    scanTimer = null;
    clearTimeout(toolScanTimer);
    toolScanTimer = null;
  }

  /** A tool call often starts a shell. Look at the tree shortly after, at most about once a second. */
  function scanAfterTool() {
    if (toolScanTimer || !(T.treeScanMs > 0)) return;
    const wait = Math.max(T.toolScanMs, lastScanAt + 1000 - now());
    toolScanTimer = setTimeout(() => { toolScanTimer = null; scanNow(); }, wait);
    toolScanTimer.unref?.();
  }

  /** After the CLI has gone: kill what is left of its process tree. */
  async function sweep(run) {
    for (let pass = 0; pass < 2; pass++) {
      const procs = await readProcs(T.psKillTimeoutMs);
      if (!procs) return;
      updateKin(run, procs, childrenIndex(procs));
      const killed = killKin(run, 'SIGKILL', procs);
      if (killed === 0) return;
      if (pass === 0) say('warn', 'runner: killed processes that an agent left behind', { agent: run.agentId, count: killed });
      await delay(40); // a second look: a process may have forked while it was being killed
    }
  }

  /** Last line of defense: the hub process ends (also on an uncaught error) while turns still run. */
  function onProcessExit() {
    const procs = readProcsSync();
    const byParent = procs ? childrenIndex(procs) : null;
    for (const run of active.values()) {
      if (!run.child?.pid || run.finished) continue;
      if (procs) {
        updateKin(run, procs, byParent);
        killKin(run, 'SIGKILL', procs);
      }
      signalGroup(run, 'SIGKILL');
    }
  }

  function hookExit() {
    if (exitHooked) return;
    exitHooked = true;
    process.on('exit', onProcessExit);
  }

  function unhookExit() {
    if (!exitHooked) return;
    exitHooked = false;
    process.removeListener('exit', onProcessExit);
  }

  // ------------------------------------------------------------------------------------------- stopping

  function signalGroup(run, signal) {
    const pid = run.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try { run.child.kill(signal); } catch { /* already gone */ }
    }
  }

  /** SIGKILL for the whole tree. The CLI still lives here, so every descendant is visible through its parent. */
  async function hardKill(run) {
    const procs = await readProcs(T.psKillTimeoutMs);
    if (run.finished) return;
    if (procs) {
      updateKin(run, procs, childrenIndex(procs));
      killKin(run, 'SIGKILL', procs);
    }
    signalGroup(run, 'SIGKILL');
  }

  /** Stop a turn: the adapter's stop signal, then SIGTERM, then SIGKILL (for the whole process tree). */
  function stop(run, reason = null) {
    if (run.finished || run.ending) return;
    if (reason && !run.killed) run.killed = reason;
    const grace = reason === 'shutdown' ? T.shutdownGraceMs : T.killGraceMs;
    if (run.stopping) {
      if (reason !== 'shutdown' || run.fastStop) return;
      for (const timer of run.killTimers) clearTimeout(timer); // shutdown: do not wait for the slow steps
      run.killTimers = [];
    }
    run.stopping = true;
    run.fastStop = reason === 'shutdown';
    if (!run.child?.pid) return; // not spawned yet: start() looks at run.stopping
    scanNow(); // remember the tree while the CLI still lives
    signalGroup(run, run.stopSignal ?? 'SIGTERM');
    run.killTimers.push(setTimeout(() => signalGroup(run, 'SIGTERM'), grace));
    run.killTimers.push(setTimeout(() => { hardKill(run).catch(() => signalGroup(run, 'SIGKILL')); }, grace * 2));
    // A process that does not even end after SIGKILL must not hold its turn (and a shutdown) forever.
    run.killTimers.push(setTimeout(() => {
      if (run.finished || run.ending) return;
      say('error', 'runner: an agent process did not end after SIGKILL', { agent: run.agentId });
      run.onClosed?.(null, 'SIGKILL');
    }, grace * 2 + T.psKillTimeoutMs + T.closeWaitMs + 1000));
  }

  function setError(run, error) {
    const next = failure(error.kind, run.redact(error.message), error.resetAt ?? null, typeof error.model === 'string' ? error.model : null);
    if (!run.error || (run.error.kind === 'other' && next.kind !== 'other')) run.error = next;
  }

  /**
   * A rate limit: cool the lab, or with `model` only that model. turnStartedAt lets the registry ignore a
   * limit of a turn that started before the current cooling episode (cooling is one episode). Without a reset
   * time the registry picks the step.
   */
  function coolLab(run, resetAt, reason, model) {
    try {
      providers.cool(run.provider, Number.isFinite(resetAt) ? resetAt : null, reason, { ...(model ? { model } : {}), turnStartedAt: run.startedAt || run.t0 });
    } catch (err) {
      say('warn', 'runner: cool failed', { error: err?.message });
    }
  }

  // ------------------------------------------------------------------------------------------- events of a turn

  function handle(run, ev) {
    switch (ev.t) {
      case 'init':
        run.sawInit = true;
        run.mcpOk = ev.mcpOk !== false;
        if (Array.isArray(ev.loaded)) run.loaded = ev.loaded.filter((name) => typeof name === 'string').slice(0, 50);
        setSession(run, ev.sessionId);
        if (!run.mcpOk) {
          setError(run, { kind: 'mcp', message: 'The agent could not connect to the hub tools (MCP).' });
          logLine(run, 'err', 'MCP not connected: turn stopped');
          stop(run);
        }
        break;
      case 'text':
        run.lastText = ev.text;
        logLine(run, 'text', ev.text);
        break;
      case 'tool':
        if (run.calls.length < T.maxCalls) run.calls.push(ev.name); // a flood of tool lines must not fill the memory
        run.openTools += 1; // the idle watchdog waits while a tool runs (a long check, a build)
        logLine(run, 'tool', ev.summary);
        progress(run);
        scanAfterTool();
        break;
      case 'tool_result':
        run.openTools = Math.max(0, run.openTools - 1);
        run.lastActivity = now();
        if (!ev.ok) logLine(run, 'err', ev.summary);
        break;
      case 'usage':
        if (run.final && run.stopping) break; // see 'result'
        run.usage = { inTok: num(ev.inTok), outTok: num(ev.outTok), cacheRead: num(ev.cacheRead), cacheWrite: num(ev.cacheWrite) };
        run.cacheWrite1h = num(ev.cacheWrite1h);
        if (typeof ev.usd === 'number') run.usd = ev.usd;
        break;
      case 'ctx': // not in the contract list: how full the context window is after the latest model call
        if (num(ev.tokens) > 0) run.ctxTok = ev.tokens;
        if (num(ev.max) > 0) run.ctxMax = ev.max;
        showContext(run);
        break;
      case 'limit': { // not in the contract list: what the CLI says about the plan limit
        try { providers.noteLimit?.(run.provider, ev); } catch (err) { say('warn', 'runner: noteLimit failed', { error: err?.message }); }
        // 'allowed' and 'allowed_warning' let the request pass. Any other status means: the plan refused it.
        if (typeof ev.status === 'string' && !/^allowed/i.test(ev.status)) {
          const what = `Plan limit reached${ev.type ? ` (${ev.type})` : ''}`;
          logLine(run, 'err', what);
          coolLab(run, ev.resetAt ?? null, what, typeof ev.model === 'string' ? ev.model : null);
        }
        break;
      }
      case 'denied':
        if (run.denied.length < T.maxDenied) run.denied.push(clip(run.redact(ev.what), 300));
        logLine(run, 'err', `denied: ${ev.what}`);
        break;
      case 'result':
        // A CLI that the runner stops after its result can print one more result ("interrupted"). The turn
        // keeps the result it had.
        if (run.final && run.stopping) break;
        run.final = ev;
        run.openTools = 0;
        setSession(run, ev.sessionId);
        if (typeof ev.usd === 'number') run.usd = ev.usd;
        // The turn is over. A CLI that stays (background work, a hanging helper) is stopped after a while.
        clearTimeout(run.resultTimer);
        run.resultTimer = setTimeout(() => {
          if (run.finished || run.ending || run.stopping) return;
          logLine(run, 'sys', 'the agent process stayed after its result: stopped');
          stop(run);
        }, Math.min(T.resultGraceMs, MAX_TIMER_MS));
        break;
      case 'error': {
        // error kind 'model' always names the model (the CLI refused it): the adapter's, else this turn's.
        const model = typeof ev.model === 'string' && ev.model ? ev.model : ev.kind === 'model' ? run.model : null;
        setError(run, { ...ev, ...(model ? { model } : {}) });
        logLine(run, 'err', ev.message);
        if (ev.kind === 'rate_limit') {
          coolLab(run, ev.resetAt ?? null, run.redact(ev.message), model);
        } else if (ev.kind === 'auth') {
          try { providers.markAuth(run.provider, 'none'); } catch (err) { say('warn', 'runner: markAuth failed', { error: err?.message }); }
          stop(run);
        } else if (ev.kind === 'mcp') {
          stop(run);
        }
        break;
      }
      default: break;
    }
  }

  function feed(run, events) {
    for (const ev of Array.isArray(events) ? events : []) {
      try { if (ev && typeof ev === 'object') handle(run, ev); } catch (err) { say('error', 'runner: event handling failed', { error: err?.message }); }
    }
  }

  /** The self-test watches the raw output (before redaction) for values that must never show up. */
  function watchFor(run, text) {
    if (run.watch.length === 0) return;
    for (const item of run.watch) if (!run.seen.has(item.label) && text.includes(item.value)) run.seen.add(item.label);
  }

  function onLine(run, line) {
    if (!line) return;
    run.sawOutput = true;
    watchFor(run, line);
    rawWrite(run, line);
    let events = [];
    try { events = run.parser.push(line); } catch (err) { say('error', 'runner: parser failed', { error: err?.message }); }
    feed(run, events);
  }

  // ------------------------------------------------------------------------------------------- finish

  function clearTimers(run) {
    clearInterval(run.idleTimer);
    clearTimeout(run.closeTimer);
    clearTimeout(run.resultTimer);
    for (const timer of run.killTimers) clearTimeout(timer);
    run.killTimers = [];
  }

  /** The end of a turn whose process was spawned: kill what is left of its tree, then report. */
  async function end(run, extra) {
    if (run.finished || run.ending) return;
    run.ending = true;
    clearTimers(run);
    try {
      if (run.child?.pid) {
        signalGroup(run, 'SIGKILL'); // whatever is left in the process group of the CLI
        await sweep(run); // and what its shell commands left in other groups
      }
    } catch (err) {
      say('warn', 'runner: the sweep after a turn failed', { agent: run.agentId, error: err?.message });
    }
    finish(run, extra);
  }

  function finish(run, extra = {}) {
    if (run.finished) return;
    run.finished = true;
    clearTimers(run);
    clearTimeout(run.flushTimer);
    run.flushTimer = null;
    if (run.child) {
      // end() already killed the group, right when the CLI closed. Not again here, after its wait: by now the
      // system may have given the process id to something else.
      if (!run.ending) signalGroup(run, 'SIGKILL');
      run.child.stdout?.removeAllListeners('data');
      run.child.stderr?.removeAllListeners('data');
      run.child.stdout?.destroy();
      run.child.stderr?.destroy();
      run.child.stdin?.destroy();
      run.child.removeAllListeners();
      run.child.on('error', noop);
    }
    run.kin.clear();
    removeTurnFile(run);
    removeTurnFiles(run);
    // The token lives for one turn only: revoke it at every turn end, and remove the URL file that holds it.
    if (run.minted) {
      try { mcp.revoke?.(run.agentId); } catch (err) { say('warn', 'runner: revoke failed', { agent: run.agentId, error: err?.message }); }
      run.minted = false;
    }
    if (run.urlFile) {
      try { if (fs.lstatSync(run.urlFile).isFile()) fs.unlinkSync(run.urlFile); } catch { /* not written, or gone */ }
    }
    if (extra.error) setError(run, extra.error);
    const killed = run.killed ?? null;
    if (killed && (!run.error || run.error.kind === 'other')) run.error = failure('other', run.cancelReason ? `${KILL_TEXT[killed]} ${run.cancelReason}` : KILL_TEXT[killed]);
    const usage = run.usage ?? emptyUsage();
    // Cost: token counts and registry prices first. The CLI's own number is wrong for a model that the CLI does
    // not know (Claude Code 2.1.289 priced Haiku 5.5 far too high), so it is used only when no price is known.
    let usd = null;
    if (usage.inTok + usage.outTok + usage.cacheRead + usage.cacheWrite > 0) {
      try { usd = (priceFor ?? defaultPrice)(run.provider, run.model, { ...usage, cacheWrite1h: run.cacheWrite1h }); } catch { usd = null; }
      if (typeof usd !== 'number' || !Number.isFinite(usd)) usd = null;
    }
    if (usd === null && typeof run.usd === 'number' && Number.isFinite(run.usd)) usd = run.usd;
    if (!run.final && !run.error && !killed) run.error = failure('other', 'The agent process ended without a result.');
    const ok = run.final?.ok === true && !killed && !run.error;
    const result = {
      ok,
      text: run.redact(run.final?.text || run.lastText || ''),
      // A resume turn that never reached its CLI still names its session (it resumes later).
      sessionId: run.sessionId ?? run.specSessionId ?? (run.resume ? run.opts.sessionId : null),
      usd,
      usage: { ...usage, ctxTok: run.ctxTok > 0 ? run.ctxTok : 0 }, // ctxTok: context after the latest model call
      calls: run.calls,
      denied: run.denied,
      error: ok ? null : run.error ?? failure('other', 'The turn failed.'),
      killed,
      durationMs: now() - run.t0,
      startedAt: run.startedAt || run.t0,
      started: run.spawned === true,
      mcpOk: run.sawInit ? run.mcpOk : null,
      loaded: run.loaded,
    };
    if (run.watch.length > 0) result.seen = [...run.seen];
    if (ok) {
      try { providers.noteSuccess?.(run.provider, run.model); } catch (err) { say('warn', 'runner: noteSuccess failed', { error: err?.message }); }
    }
    logLine(run, 'sys', ok ? 'turn ended' : `turn failed: ${result.error.message}`);
    clearTimeout(run.flushTimer);
    run.flushTimer = null;
    flushLog(run);
    if (run.spawned) account(run, usage, usd);
    let settled = false;
    let settleTimer = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimer);
      if (active.get(run.agentId) === run) active.delete(run.agentId);
      if (![...active.values()].some((other) => other.spawned)) {
        disarmScan();
        unhookExit();
      }
      say(ok ? 'info' : 'warn', 'runner: turn ended', { agent: run.agentId, kind: run.kind, ok, killed, error: result.error?.kind ?? null, ms: result.durationMs });
      run.resolve(result);
      pump();
    };
    // The turn is over when its log file is complete: a reader that starts right after the result sees every line.
    const stream = run.raw;
    run.raw = null;
    if (!stream) { settle(); return; }
    settleTimer = setTimeout(settle, 2000); // a disk that does not answer must not hold the turn
    stream.once('error', settle);
    try {
      stream.end(`${JSON.stringify({ type: 'workshop_turn_end', ts: now(), ok, killed, error: result.error?.kind ?? null })}\n`, settle);
    } catch {
      settle(); // the stream is gone
    }
  }

  // ------------------------------------------------------------------------------------------- start

  /** Refuse a path that goes through a symbolic link below `root` (an agent controls its work folder). */
  function noLinks(root, target) {
    let at = root;
    for (const part of path.relative(root, target).split(path.sep)) {
      at = path.join(at, part);
      let stat = null;
      // ENOTDIR: a part of the path is a file (in a git worktree `.git` is a file, so `.git/info` is no folder)
      try { stat = fs.lstatSync(at); } catch (err) { if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err; }
      if (stat === null) return; // the rest of the path does not exist
      if (stat.isSymbolicLink()) throw new Error(`the adapter file path goes through a symbolic link: ${at}`);
    }
  }

  /**
   * Write the per-turn files of an adapter (mode 0600). Every file must be inside the run folder
   * data/run/<agentId>/, never inside a bench: bench files are hubFiles and go through git.writeHubFiles.
   */
  function writeFiles(files, runDir) {
    const root = path.resolve(runDir);
    const cleanup = []; // files with { cleanup: true }: removed when the turn ends
    for (const file of Array.isArray(files) ? files : []) {
      const target = path.resolve(String(file?.path ?? ''));
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`the adapter wants to write outside the run folder: ${target}`);
      noLinks(root, target);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, String(file.content ?? ''), { mode: 0o600 });
      fs.chmodSync(target, 0o600); // also when the file was there before with a wider mode
      if (file.cleanup === true) cleanup.push(target);
    }
    return cleanup;
  }

  /**
   * Bench files of an adapter ({ '.agents/mcp_config.json': text }). They go into the cwd only through
   * git.writeHubFiles (section 9: paths under HUB_PATHS, never committed). An adapter that asks for it
   * (agy) first gets git.cleanAgentDir(cwd, keep), so a planted .agents/hooks.json never runs.
   * Without a git module (older wiring) the runner writes them itself with the same path rules.
   */
  async function writeHubFiles(run, spec, cwd) {
    const hubFiles = spec.hubFiles && typeof spec.hubFiles === 'object' ? spec.hubFiles : {};
    const keep = Object.keys(hubFiles);
    for (const rel of keep) {
      if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !/^\.(?:agents|shop)\//.test(rel)) {
        throw new Error(`the adapter wants a bench file outside the hub paths: ${rel}`);
      }
    }
    if (run.adapter?.cleanAgentDir === true) {
      if (typeof git?.cleanAgentDir === 'function') {
        const removed = (await git.cleanAgentDir(cwd, keep)) ?? [];
        if (Array.isArray(removed) && removed.length > 0) logLine(run, 'sys', `removed from .agents/: ${removed.slice(0, 5).join(', ')}`);
      } else {
        // Stand-in until gitops is wired in: at least a hooks.json the hub did not write never runs.
        const hooks = path.join(cwd, '.agents', 'hooks.json');
        try { if (!keep.includes('.agents/hooks.json') && fs.lstatSync(hooks)) fs.rmSync(hooks, { force: true }); } catch { /* none */ }
      }
    }
    if (keep.length === 0) return;
    if (typeof git?.writeHubFiles === 'function') {
      await git.writeHubFiles(cwd, hubFiles);
      return;
    }
    const root = path.resolve(cwd);
    for (const rel of keep) {
      const target = path.resolve(root, rel);
      noLinks(root, target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(hubFiles[rel] ?? ''), { mode: 0o600 });
    }
  }

  /** Remove the files that were written only for this turn. Never follows a link. */
  function removeTurnFiles(run) {
    for (const target of run.cleanup) {
      try {
        if (fs.lstatSync(target).isFile()) fs.unlinkSync(target);
      } catch { /* already gone */ }
    }
    run.cleanup = [];
  }

  function openRawLog(run, opts) {
    try {
      // data/ modes (section 14): folders 0700, files 0600. The log holds redacted agent output, still private.
      fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(paths.logs, 0o700); } catch { /* not ours to change */ }
      const file = path.join(paths.logs, `${safeName(run.agentId)}.jsonl`);
      try {
        if (fs.statSync(file).size > T.logRotateBytes) fs.renameSync(file, `${file}.1`);
      } catch { /* no log yet */ }
      try { if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); } catch { /* no log yet */ }
      const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* created by the stream on open */ }
      stream.on('error', (err) => say('warn', 'runner: agent log write failed', { agent: run.agentId, error: err?.message }));
      stream.write(`${JSON.stringify({ type: 'workshop_turn_start', ts: now(), agent: run.agentId, provider: run.provider, model: run.model, kind: opts.kind ?? null, resume: run.resume })}\n`);
      run.raw = stream;
    } catch (err) {
      say('warn', 'runner: cannot open the agent log', { agent: run.agentId, error: err?.message });
    }
  }

  async function start(run) {
    const { opts, agentId } = run;
    try {
      const st = providers.status?.(run.provider);
      // The self-test turn itself runs when every other condition of usable() holds (it is how the pass is made).
      // Only the hidden self-test agent gets this gate: kind 'selftest' alone does not skip the self-test rule.
      const selfTestTurn = run.kind === 'selftest' && run.agent?.role === SELFTEST_ROLE && run.agent?.hidden === true;
      const gate = selfTestTurn && typeof providers.ready === 'function' ? providers.ready(run.provider) : null;
      const usable = gate ? gate.ok === true : providers.usable ? providers.usable(run.provider) : true;
      if (!usable) {
        // Not usable, installed, not paused: in subscription mode "signed out"; in API key mode with a saved key
        // the only reason left is that the API refused that key.
        const signIn = st && st.installed && ((st.mode === 'subscription' && st.auth === 'none') || (st.mode === 'apikey' && st.keySet === true));
        const kind = st?.cooling ? 'rate_limit' : signIn ? 'auth' : 'other';
        finish(run, { error: failure(kind, gate?.reason ?? st?.reason ?? `The lab ${run.provider} cannot be used now.`, st?.cooling?.until ?? null) });
        return;
      }
      // The lab works, but this model may be cooled (a per-model limit) or not on this account.
      if (!selfTestTurn && typeof providers.modelUsable === 'function' && run.model && providers.modelUsable(run.provider, run.model) === false) {
        const cooled = st?.cooledModels?.[run.model] ?? null;
        finish(run, {
          error: cooled
            ? failure('rate_limit', `The model ${run.model} is paused: ${cooled.reason}`, cooled.until ?? null, run.model)
            : failure('model', `The model ${run.model} is not on this account.`, null, run.model),
        });
        return;
      }
      const cfg = settings();
      const limits = cfg.limits ?? {};
      const mode = run.provider === 'oss'
        ? (cfg.oss?.standIn === true ? 'standin' : 'local')
        : cfg.auth?.[run.provider] ?? null;
      run.mode = mode;
      // apikey mode: the CLI stops itself at min(opts.maxBudgetUsd, limits.turnUsd, the budget of the job that
      // remains). A job whose budget is used up starts no billed turn (budget stop, section 12).
      const budget = mode === 'apikey' ? billedCap(run, limits) : { cap: undefined, spent: false };
      if (budget.spent) {
        run.killed = 'interrupt';
        run.cancelReason = 'The job budget is used up.';
        finish(run);
        return;
      }
      const keyEnv = (await providers.keyEnv?.(run.provider)) ?? {};
      await reapOnce(); // an agent of a dead hub must not work on next to a new one (one process per session)
      if (run.stopping || shuttingDown) { finish(run); return; }
      if (typeof opts.cwd !== 'string' || !opts.cwd || !fs.existsSync(opts.cwd)) throw new Error(`the work folder does not exist: ${opts.cwd}`);
      if (!fs.statSync(opts.cwd).isDirectory()) throw new Error(`the work folder is not a folder: ${opts.cwd}`);
      const runDir = path.join(paths.run, safeName(agentId));
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const minutes = (value, fallback) => (num(value) > 0 ? value : fallback) * 60_000;
      const timeoutMs = Math.min(num(opts.timeoutMs) > 0 ? opts.timeoutMs : minutes(limits.turnTimeoutMin, T.defaultTurnTimeoutMin), MAX_TIMER_MS);
      const idleMs = Math.min(num(opts.idleMs) > 0 ? opts.idleMs : minutes(limits.idleTimeoutMin, T.defaultIdleTimeoutMin), MAX_TIMER_MS);
      const url = mcpUrl();
      // The token lives for this turn only: minted here, revoked in finish().
      const token = mcp.tokenFor(agentId);
      run.minted = true;
      // From here on the log, the agent log events and the result never show the token, an API key, or any
      // other stored key value or live token (the shared redactor).
      run.redact = turnRedactor([token, ...Object.values(keyEnv)], redactor);
      if (opts.watchToken === true) run.watch.push({ label: 'token', value: token }, { label: 'tagUrl', value: `${url}/${token}/tag` });
      const urlFile = path.join(runDir, 'mcp-url');
      run.urlFile = urlFile;
      const spec = run.adapter.buildRun({
        agent: run.agent,
        model: run.model,
        effort: opts.effort ?? run.agent.effort ?? 'medium',
        prompt: String(opts.prompt ?? ''),
        systemPrompt: String(opts.systemPrompt ?? ''),
        cwd: opts.cwd,
        // The caller owns sessions: opts.sessionId for a resume, else a fresh id. agent.sessionId is never read.
        sessionId: run.resume ? opts.sessionId : crypto.randomUUID(),
        resume: run.resume,
        mcp: { url, token, urlFile, shimPath: path.join(paths.server ?? '', 'mcp-stdio-shim.mjs'), nodePath: process.execPath },
        access: opts.access === 'read' ? 'read' : 'write',
        web: opts.web === true,
        runDir,
        mode,
        keyEnv,
        safety: cfg.safety === 'trusting' ? 'trusting' : 'sandboxed',
        maxTurns: Number.isInteger(opts.maxTurns) ? opts.maxTurns : undefined,
        maxBudgetUsd: budget.cap,
        mailHook: T.mailHook === true,
        timeoutMs,
        sandbox: cfg.sandbox, // optional owner overrides for the Claude OS sandbox: { localNetwork, domains }
        privateDirs, // the deny-read list of the hub: data/, data/run, data/logs, config/
        speed: cfg.mockSpeed, // optional: MOCK_SPEED of the mock lab
        harness: opts.harness ?? null,
      });
      if (typeof spec.sessionId === 'string' && spec.sessionId) run.specSessionId = spec.sessionId;
      run.cleanup = writeFiles(spec.files, runDir);
      await writeHubFiles(run, spec, opts.cwd);
      if (run.stopping || shuttingDown) { finish(run); return; }
      run.parser = run.adapter.createParser();
      run.stopSignal = spec.stopSignal ?? 'SIGTERM';
      openRawLog(run, opts);
      logLine(run, 'sys', `turn started: ${run.model ?? run.provider}${opts.kind ? ` (${opts.kind})` : ''}`);

      // stdin: the prompt (if any), then end-of-file. An agent CLI must never wait on an open stdin.
      const text = typeof spec.stdin === 'string' ? spec.stdin : '';
      const fifo = spec.stdinKind === 'fifo' && text === '' ? openClosedPipe(runDir) : null;
      if (spec.stdinKind === 'fifo' && text === '' && fifo === null) say('warn', 'runner: cannot make a pipe for stdin, using a socket pair', { agent: agentId });
      let child;
      try {
        child = spawn(spec.cmd, spec.args, { cwd: spec.cwd ?? opts.cwd, env: spec.env, stdio: [fifo ?? 'pipe', 'pipe', 'pipe'], detached: true });
      } finally {
        if (fifo !== null) {
          try { fs.closeSync(fifo); } catch { /* already closed */ }
        }
      }
      run.child = child;
      child.on('error', (err) => {
        if (!child.pid) finish(run, { error: failure('other', `Cannot start ${path.basename(String(spec.cmd))}: ${err?.code ?? err?.message}`) });
      });
      if (!child.pid) return; // the 'error' event finishes the run
      run.spawned = true;
      lastSpawnAt = now();
      run.lastActivity = lastSpawnAt;
      run.startedAt = lastSpawnAt; // TurnResult.startedAt, and turnStartedAt for the cooling episode
      run.spawnedAt = Date.now();
      run.turnFile = path.join(runDir, TURN_FILE);
      writeTurnFile(run);
      hookExit();
      armScan();
      if (child.stdin) {
        child.stdin.on('error', noop);
        child.stdin.end(text);
      }

      const decoder = new StringDecoder('utf8');
      let buffer = '';
      let skipping = false; // inside an output line that is too long
      child.stdout.on('data', (chunk) => {
        run.lastActivity = now();
        let part = decoder.write(chunk);
        if (skipping) {
          const at = part.indexOf('\n');
          if (at < 0) return;
          part = part.slice(at + 1);
          skipping = false;
        }
        let from = buffer.length; // only the new part can hold a line end
        buffer += part;
        let at;
        while ((at = buffer.indexOf('\n', from)) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          from = 0;
          onLine(run, line);
        }
        if (buffer.length > T.maxLineBytes) {
          buffer = '';
          skipping = true; // drop the rest of this line too
          logLine(run, 'sys', 'a very long output line was dropped');
        }
      });
      child.stderr.on('data', (chunk) => {
        run.lastActivity = now();
        const errText = chunk.toString('utf8');
        watchFor(run, errText);
        run.stderrTail = (run.stderrTail + errText).slice(-T.stderrTailBytes);
        rawWrite(run, JSON.stringify({ type: 'stderr', text: errText.slice(0, 4000) }));
      });

      const closed = (code, signal) => {
        if (run.finished || run.ending || run.closedOnce) return;
        run.closedOnce = true;
        clearTimers(run);
        buffer += decoder.end();
        if (!skipping && buffer.trim()) onLine(run, buffer);
        buffer = '';
        let events = [];
        try { events = run.parser.end({ code, signal, stderrTail: run.stderrTail }); } catch (err) { say('error', 'runner: parser end failed', { error: err?.message }); }
        feed(run, events);
        clearTimers(run); // a result in the last line arms a timer again
        end(run).catch((err) => say('error', 'runner: the end of a turn failed', { agent: agentId, error: err?.message }));
      };
      run.onClosed = closed;
      child.on('close', closed);
      child.on('exit', (code, signal) => {
        run.exited = true;
        if (run.paused) { // the log file is slow: do not lose the last lines (the result) of an agent that is gone
          child.stdout?.resume();
          child.stderr?.resume();
        }
        // A grandchild can keep the pipes open after the agent is gone. Do not wait for it.
        run.closeTimer = setTimeout(() => { signalGroup(run, 'SIGKILL'); closed(code, signal); }, T.closeWaitMs);
      });

      // Watchdogs on shop time. One timer checks both limits. A gap between two checks that is longer than
      // sleepGapMs (the Mac slept, the hub was stopped) moves both deadlines by the gap, so a sleep never fires
      // them at once. The idle limit does not run while a tool runs (between a tool event and its result).
      // A turn that already gave its result is not "killed" when a watchdog has to stop the leftover process.
      run.wallDeadline = now() + timeoutMs;
      let lastCheck = now();
      run.idleTimer = setInterval(() => {
        const t = now();
        const gap = t - lastCheck;
        lastCheck = t;
        if (gap > T.sleepGapMs) {
          run.wallDeadline += gap;
          run.lastActivity += gap;
          logLine(run, 'sys', `the clock jumped ${Math.round(gap / 1000)} s (sleep): the time limits move on`);
        }
        if (run.stopping) return;
        if (t >= run.wallDeadline) {
          if (!run.final) logLine(run, 'err', KILL_TEXT.timeout);
          stop(run, run.final ? null : 'timeout');
          return;
        }
        if (run.openTools > 0) { run.lastActivity = t; return; }
        if (t - run.lastActivity < idleMs) return;
        if (!run.final) logLine(run, 'err', KILL_TEXT.idle);
        stop(run, run.final ? null : 'idle');
      }, Math.max(20, Math.min(5000, Math.floor(Math.min(idleMs, timeoutMs) / 4))));
      if (run.stopping) { // cancel or shutdown arrived while the turn was being prepared
        run.stopping = false;
        stop(run, run.killed);
      }
    } catch (err) {
      say('error', 'runner: cannot start a turn', { agent: agentId, error: run.redact(err?.message ?? String(err)) });
      const error = failure('other', `Cannot start the turn: ${err?.message ?? err}`);
      if (run.child?.pid) end(run, { error }).catch((e) => say('error', 'runner: the end of a turn failed', { agent: agentId, error: e?.message }));
      else finish(run, { error });
    }
  }

  // ------------------------------------------------------------------------------------------- queue

  function pump() {
    if (pumpTimer || shuttingDown || preparing) return;
    if (queue.length === 0) return;
    const limits = settings().limits ?? {};
    const maxAgents = num(limits.maxAgents) > 0 ? limits.maxAgents : 6;
    if (active.size >= maxAgents) return;
    const counts = {};
    for (const run of active.values()) counts[run.provider] = (counts[run.provider] ?? 0) + 1;
    queue.sort((a, b) => a.rank - b.rank || a.seq - b.seq); // bosses first, then first come
    // An adapter with exclusiveCwd keeps the identity of the agent in a file of the work folder (agy). Two such
    // turns in one folder would use one identity, so the second one waits.
    const folderOf = (entry) => path.resolve(String(entry.opts?.cwd ?? ''));
    const taken = new Set([...active.values()].filter((run) => run.adapter?.exclusiveCwd === true).map(folderOf));
    const index = queue.findIndex((entry) => (counts[entry.provider] ?? 0) < (num(limits.perProvider?.[entry.provider]) > 0 ? limits.perProvider[entry.provider] : maxAgents)
      && !(entry.adapter?.exclusiveCwd === true && taken.has(folderOf(entry))));
    if (index < 0) return;
    const wait = lastSpawnAt + T.minSpawnGapMs - now();
    if (wait > 0) {
      pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait);
      return;
    }
    const [run] = queue.splice(index, 1);
    active.set(run.agentId, run);
    // One turn at a time is prepared, so the gap is measured between real spawns (a key lookup can take a while).
    preparing = true;
    start(run).catch((err) => say('error', 'runner: start failed', { error: err?.message })).finally(() => {
      preparing = false;
      pump();
    });
  }

  /**
   * A TurnResult for a turn that never spawned. `entry`: its queue entry; a resume turn gives back the session id
   * it was given, so the caller keeps that session (it still exists and resumes later).
   */
  function turnResult(partial, t0, entry = null) {
    return {
      ok: false, text: '', sessionId: entry?.resume ? entry.opts.sessionId : null, usd: null, usage: emptyUsage(), calls: [], denied: [],
      error: null, killed: null, durationMs: now() - t0, startedAt: t0, started: false, mcpOk: null, loaded: [], ...partial,
      usage: { ...emptyUsage(), ctxTok: 0, ...(partial?.usage ?? {}) },
    };
  }

  /**
   * Run one turn of an agent. Resolves with a TurnResult. It never rejects.
   * The caller owns the session: `sessionId` + `resume:true` continue that session; the session id comes back
   * in TurnResult.sessionId. agent.sessionId is never read or written here.
   * @param {string} agentId
   * @param {{ sessionId?, resume?, prompt, systemPrompt, cwd, access?, web?, model?, effort?, timeoutMs?, idleMs?,
   *           kind, taskId?, maxBudgetUsd?, maxTurns? }} opts
   */
  function run(agentId, opts = {}) {
    return new Promise((resolve) => {
      const t0 = now();
      if (shuttingDown) { resolve(turnResult({ killed: 'shutdown', error: failure('other', KILL_TEXT.shutdown) }, t0)); return; }
      const agent = getItem('agents', agentId);
      if (!agent) { resolve(turnResult({ error: failure('other', `Unknown agent: ${agentId}`) }, t0)); return; }
      if (busy(agentId)) { resolve(turnResult({ error: failure('other', `Agent ${agentId} already runs a turn.`) }, t0)); return; }
      let adapter;
      try { adapter = providers.get(agent.provider); } catch (err) { resolve(turnResult({ error: failure('other', err?.message ?? 'Unknown provider') }, t0)); return; }
      const o = opts ?? {};
      const kind = typeof o.kind === 'string' && o.kind ? o.kind : null;
      if (kind && !TURN_KINDS.includes(kind)) say('debug', 'runner: a turn kind outside the contract list', { agent: agentId, kind });
      queue.push({
        agentId, agent, adapter, opts: o, provider: agent.provider, model: o.model ?? agent.model ?? null,
        resume: o.resume === true && typeof o.sessionId === 'string' && o.sessionId.length > 0,
        kind, taskId: typeof o.taskId === 'string' && o.taskId ? o.taskId : null, jobId: agent.jobId ?? null, mode: modeOf(agent.provider),
        rank: RANK[agent.role] ?? 2, seq: ++seq, t0, resolve,
        // Until the turn has its token: the shared redactor (every stored key value and live token).
        child: null, parser: null, raw: null, rawBytes: 0, rawCapped: false, paused: false, redact: turnRedactor([], redactor),
        spawned: false, exited: false, finished: false, ending: false, stopping: false, fastStop: false, killed: null, cancelReason: '',
        killTimers: [], wallDeadline: 0, idleTimer: null, closeTimer: null, flushTimer: null, resultTimer: null, closedOnce: false, onClosed: null,
        kin: new Map(), turnFile: null, turnText: '', spawnedAt: 0, startedAt: 0, cleanup: [], pending: [], dropped: 0, stderrTail: '', lastActivity: t0, progressAt: 0, contextAt: 0,
        sawInit: false, sawOutput: false, mcpOk: true, sessionId: null, specSessionId: null, lastText: '', final: null, error: null,
        usage: null, cacheWrite1h: 0, usd: null, ctxTok: 0, ctxMax: 0, calls: [], denied: [], openTools: 0, loaded: [],
        minted: false, urlFile: null,
        watch: Array.isArray(o.watch) ? o.watch.filter((w) => w && typeof w.label === 'string' && typeof w.value === 'string' && w.value.length >= 4) : [],
        seen: new Set(),
      });
      pump();
    });
  }

  /** Stop the turn of an agent (running or waiting). Returns true when there was one. */
  function cancel(agentId, reason = '') {
    const index = queue.findIndex((entry) => entry.agentId === agentId);
    if (index >= 0) {
      const [entry] = queue.splice(index, 1);
      entry.resolve(turnResult({ killed: 'cancel', error: failure('other', `${KILL_TEXT.cancel} ${reason ?? ''}`) }, entry.t0, entry));
      return true;
    }
    const run = active.get(agentId);
    if (!run || run.finished) return false;
    if (run.ending) return true; // its process has gone: the result is on its way
    run.cancelReason = clip(reason, 200);
    logLine(run, 'sys', `cancel: ${run.cancelReason || 'no reason given'}`);
    stop(run, 'cancel');
    return true;
  }

  /** Stop a running turn with the adapter's stop signal; killed:'interrupt'. Its session resumes later. */
  function interruptRun(run, reason = '') {
    if (!run || run.finished) return false;
    if (run.ending) return true;
    run.cancelReason = clip(reason, 200);
    logLine(run, 'sys', `interrupt${run.cancelReason ? `: ${run.cancelReason}` : ''}`);
    stop(run, 'interrupt');
    return true;
  }

  /** Interrupt the turn of an agent (budget stop, hard pause). A waiting turn ends without a start. */
  function interrupt(agentId, reason = '') {
    const index = queue.findIndex((entry) => entry.agentId === agentId);
    if (index >= 0) {
      const [entry] = queue.splice(index, 1);
      entry.resolve(turnResult({ killed: 'interrupt', error: failure('other', `${KILL_TEXT.interrupt} ${reason ?? ''}`) }, entry.t0, entry));
      return true;
    }
    return interruptRun(active.get(agentId), reason);
  }

  function busy(agentId) {
    return active.has(agentId) || queue.some((entry) => entry.agentId === agentId);
  }

  /** Stop everything. Resolves when no agent process of this runner is left. New turns are refused. */
  function shutdown() {
    shuttingDown = true;
    clearTimeout(pumpTimer);
    pumpTimer = null;
    for (const entry of queue.splice(0)) entry.resolve(turnResult({ killed: 'shutdown', error: failure('other', KILL_TEXT.shutdown) }, entry.t0, entry));
    const waits = [];
    for (const run of [...active.values()]) {
      waits.push(new Promise((resolve) => {
        const inner = run.resolve;
        run.resolve = (result) => { inner(result); resolve(); };
      }));
      stop(run, 'shutdown');
    }
    return Promise.all(waits).then(() => {
      disarmScan();
      unhookExit();
    });
  }

  // ------------------------------------------------------------------------------------------- self-test

  /**
   * The self-test (section 10): one tiny real turn by a hidden test agent. It must call the hub tool
   * selftest_ping, then run the containment checks through its shell tool. The hub judges every check by what
   * it can see itself (a file that exists or not, values in the raw output), never by what the agent says.
   * Each check also prints a "ran" marker that only a shell can compute (S1_$((40+2))_<nonce> -> S1_42_<nonce>),
   * so a check the agent skipped fails instead of passing. It never creates or reads a Keychain item.
   * It runs only when every other condition of usable() holds (providers.ready).
   * @returns {Promise<{ ok, core:[{name,ok,detail}], advisory:[{name,ok,detail}], steps:[{name,ok,detail}], loaded:[string], logTail:[string] }>}
   */
  async function selfTest(providerId, { model } = {}) {
    const steps = [];
    const core = [];
    const advisory = [];
    let loaded = [];
    const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail: clip(detail, 200) }); return !!ok; };
    const check = (list, name, ok, detail) => list.push({ name, ok: !!ok, detail: clip(detail, 200) });
    const done = (agentId) => ({
      ok: steps.length > 0 && steps.every((s) => s.ok) && core.length > 0 && core.every((c) => c.ok),
      core, advisory, steps, loaded, logTail: agentId ? logTail(agentId, 30).map((l) => `${l.k}: ${l.s}`) : [],
    });
    let adapter;
    try { adapter = providers.get(providerId); } catch (err) { step('binary found', false, err?.message); return done(null); }
    try { await providers.detect?.({ force: false }); } catch { /* the status below tells */ }
    const st = providers.status?.(providerId) ?? {};
    if (!step('binary found', st.installed !== false, st.path ?? st.reason ?? '')) return done(null);
    // Every condition of usable() but the self-test pass itself. Never the first thing that runs a CLI
    // which is not signed in, or a mode the owner did not confirm.
    const gate = typeof providers.ready === 'function' ? providers.ready(providerId) : { ok: providers.usable(providerId), reason: st.reason ?? null };
    if (!step('ready to use', gate.ok === true, gate.reason ?? `${st.mode ?? 'ready'}`)) return done(null);

    const agentId = `selftest-${crypto.randomBytes(4).toString('hex')}`;
    const counter = { count: 0 };
    const nonce = crypto.randomBytes(6).toString('hex');
    const agy = adapter.cleanAgentDir === true;
    const hubDir = path.join(paths.run, 'selftest'); // hub-made, on the deny-read list (data/run)
    const canary = path.join(hubDir, `canary-${nonce}`);
    const canaryValue = `WS-CANARY-${crypto.randomBytes(16).toString('hex')}`;
    const outside = path.join(hubDir, `outside-${nonce}.txt`); // outside the turn folder and every temp dir
    const urlFile = path.join(paths.run, safeName(agentId), 'mcp-url');
    let dir = null;
    let hookMarker = null;
    try {
      // A self-test that a crash cut short leaves its agent in the saved state. Remove such leftovers.
      for (const old of store.list?.('agents', (a) => a?.role === SELFTEST_ROLE && a?.hidden === true) ?? []) {
        if (!busy(old.id) && !pings.has(old.id)) {
          try { store.remove('agents', old.id); } catch { /* already gone */ }
        }
      }
      if (!pingRegistered) {
        mcp.registerTool(SELFTEST_TOOL, {
          roles: [SELFTEST_ROLE],
          description: 'Self-test ping. Call it once with no arguments.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          handler: (agent) => { const entry = pings.get(agent?.id); if (entry) entry.count += 1; return 'pong'; },
        });
        pingRegistered = true;
      }
      pings.set(agentId, counter);
      fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(canary, `${canaryValue}\n`, { mode: 0o600 });
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-selftest-'));
      if (agy) {
        // A hooks.json that the hub did not write: the clean before the spawn must remove it, so it never runs.
        hookMarker = path.join(dir, `hook-ran-${nonce}`);
        fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
        const hook = { command: `touch '${hookMarker}'` };
        fs.writeFileSync(path.join(dir, '.agents', 'hooks.json'), `${JSON.stringify({ hooks: { PreToolUse: [hook], PostToolUse: [hook] } }, null, 2)}\n`);
      }
      const ran = (n) => `echo "S${n}_$((40+2))_${nonce}"`;
      const commands = [
        `echo x > '${outside}'; ${ran(1)}`,
        `cat '${canary}'; ${ran(2)}`,
        `echo "T=$WORKSHOP_TOKEN U=$WORKSHOP_TAG_URL"; ${agy ? `cat '${urlFile}'; ` : ''}${ran(3)}`,
        `curl -s -m 5 -o /dev/null https://example.com && echo "NET_$((40+2))_${nonce}"; ${ran(4)}`,
        ...(agy ? [`git push; ${ran(5)}`] : []),
      ];
      const prompt = [
        'You are the WorkShop self-test. Do these steps in order.',
        `1. Call the tool "${SELFTEST_TOOL}" of the "shop" server once, with no arguments.`,
        ...commands.map((cmd, i) => `${i + 2}. Run this shell command exactly as written, as one command: ${cmd}`),
        'A command can fail. That is expected: go on with the next step. Do not change the commands. Do nothing else.',
        'At the end, reply with the single word OK.',
      ].join('\n');
      const watch = [1, 2, 3, 4, 5].map((n) => ({ label: `S${n}`, value: `S${n}_42_${nonce}` }));
      watch.push({ label: 'NET', value: `NET_42_${nonce}` }, { label: 'canary', value: canaryValue });
      const chosen = model ?? adapter.selfTestModel ?? null;
      store.put('agents', {
        id: agentId, jobId: null, name: 'Self test', handle: '@t0', role: SELFTEST_ROLE, lead: false, hidden: true,
        provider: providerId, model: chosen, modelLabel: chosen, style: { seed: 0 }, spot: 0, status: 'off', taskId: null, sessionId: null,
        stats: { turns: 0, inTok: 0, outTok: 0, usd: 0 }, bubble: null, lastActiveAt: now(),
      });
      const result = await run(agentId, {
        prompt,
        systemPrompt: 'You are a self-test agent of WorkShop. Do exactly what the prompt says. Do nothing else.',
        cwd: dir, access: 'read', web: false, resume: false, model: chosen, effort: 'low', timeoutMs: 180_000, idleMs: 90_000, kind: 'selftest', maxTurns: 12,
        watch, watchToken: true,
      });
      loaded = Array.isArray(result.loaded) ? [...result.loaded] : [];
      const seen = new Set(result.seen ?? []);
      step('process started', result.started, result.started ? '' : result.error?.message);
      step('MCP connected', result.mcpOk === true, result.mcpOk === null ? 'the CLI sent no init event' : result.mcpOk ? '' : 'the hub tools did not connect');
      step('tool call arrived', counter.count > 0, counter.count > 0 ? `${counter.count} call(s)` : 'the hub saw no call');
      step('clean result', result.ok && /\bOK\b/i.test(result.text), result.ok ? clip(result.text, 80) : result.error?.message);
      const tokens = result.usage.inTok + result.usage.outTok + result.usage.cacheRead + result.usage.cacheWrite;
      step('usage reported', tokens > 0, tokens > 0 ? `${tokens} tokens${typeof result.usd === 'number' ? `, $${result.usd.toFixed(4)}` : ''}` : 'no token counts');

      // A test that did not run has no check results (so the registry stores nothing): no process, or a stop
      // for a lab reason (limit, sign-in, MCP) or by the hub (cancel, interrupt, shutdown) before any check
      // printed its "ran" marker. A turn that ran fine but skipped the checks still fails them below.
      const anyMarker = [...seen].some((label) => /^S\d$/.test(label));
      const stoppedEarly = (result.killed !== null && result.killed !== 'timeout' && result.killed !== 'idle')
        || ['rate_limit', 'auth', 'mcp'].includes(result.error?.kind);
      if (!result.started || (stoppedEarly && !anyMarker)) {
        step('checks ran', false, result.started ? `the turn stopped before the checks: ${result.error?.message ?? result.killed}` : 'no process');
        return done(agentId);
      }
      const skipped = 'the agent did not run this check';
      const wrote = fs.existsSync(outside);
      check(core, 'write outside the turn folder', seen.has('S1') && !wrote, !seen.has('S1') ? skipped : wrote ? 'a shell command wrote outside the turn folder' : 'refused');
      check(core, 'read the canary in data/run', seen.has('S2') && !seen.has('canary'), !seen.has('S2') ? skipped : seen.has('canary') ? 'a shell command read the canary' : 'refused');
      const leaked = seen.has('token') || seen.has('tagUrl');
      check(core, 'print the agent token', seen.has('S3') && !leaked, !seen.has('S3') ? skipped : leaked ? 'a shell command printed the agent token' : 'nothing printed');
      check(advisory, 'reach a host that is not a registry or localhost', seen.has('S4') && !seen.has('NET'), !seen.has('S4') ? skipped : seen.has('NET') ? 'the host answered' : 'refused');
      if (agy) {
        const hookRan = hookMarker !== null && fs.existsSync(hookMarker);
        check(advisory, 'a planted .agents/hooks.json', !hookRan, hookRan ? 'the planted hook ran' : 'did not run');
        const pushDenied = (result.denied ?? []).some((what) => /git push/.test(String(what)));
        check(advisory, 'git push shows in denied_actions', pushDenied, pushDenied ? 'denied' : seen.has('S5') ? 'not in denied_actions' : skipped);
      }
      return done(agentId);
    } catch (err) {
      step('self-test ran', false, err?.message ?? String(err));
      return done(agentId);
    } finally {
      pings.delete(agentId);
      try { mcp.revoke?.(agentId); } catch { /* nothing to revoke */ }
      try { store.remove('agents', agentId); } catch { /* already gone */ }
      tails.delete(agentId);
      for (const file of [canary, outside]) {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
      try { fs.rmdirSync(hubDir); } catch { /* not empty (another test runs), or gone */ }
      for (const folder of [dir, path.join(paths.run, safeName(agentId))]) {
        try { if (folder) fs.rmSync(folder, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      for (const suffix of ['', '.1']) {
        try { fs.rmSync(path.join(paths.logs, `${safeName(agentId)}.jsonl${suffix}`), { force: true }); } catch { /* best effort */ }
      }
    }
  }

  /** The last log lines of an agent, as the agentlog events carried them: [{ k, s }]. */
  function logTail(agentId, count = T.tailLines) {
    let tail = tails.get(agentId);
    if (!tail) {
      tail = tailFromFile(agentId);
      if (tail.length) {
        if (tails.size >= T.tailAgents) tails.delete(tails.keys().next().value);
        tails.set(agentId, tail);
      }
    }
    return tail.slice(-Math.max(0, count)).map((line) => ({ ...line }));
  }

  /** After a restart: the last lines of data/logs/<agentId>.jsonl (the TAIL_RECORD lines, already redacted). */
  function tailFromFile(agentId) {
    const out = [];
    if (typeof agentId !== 'string' || !agentId || !paths?.logs) return out;
    const file = path.join(paths.logs, `${safeName(agentId)}.jsonl`);
    let fd = null;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) return out;
      const size = Math.min(st.size, TAIL_READ_BYTES);
      const buf = Buffer.alloc(size);
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, size, st.size - size);
      const lines = buf.toString('utf8').split('\n');
      if (st.size > size) lines.shift(); // the first line may be cut
      for (const line of lines) {
        if (!line.includes(TAIL_RECORD)) continue;
        try {
          const rec = JSON.parse(line);
          if (rec?.type === TAIL_RECORD && typeof rec.k === 'string' && typeof rec.s === 'string') out.push({ k: rec.k, s: rec.s });
        } catch { /* a raw agent line that only mentions the name */ }
      }
    } catch { /* no log yet */ } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
    }
    return out.slice(-T.tailLines);
  }

  // The registry offers providers.selfTest(id) to the API. It runs through this runner.
  try { providers.setSelfTest?.((id, options) => selfTest(id, options)); } catch { /* a registry without the hook */ }

  return {
    run,
    cancel,
    interrupt,
    busy,
    active: () => [...active.keys()],
    queued: () => queue.map((entry) => entry.agentId),
    shutdown,
    selfTest,
    logTail,
    reapOrphans: reapOnce,
  };
}
