// WorkShop hub entry (contract sections 3, 3b, 6, 12, 14b).
//
//   createApp({ root?, dataDir?, configDir?, projectsDir?, port = 0, portFallback = false, ownerKey?, secretsBackend?,
//               log?, env?, ... })
//     -> { url, port, ownerKey, close(), pauseLive(why), releaseLock(), orch, store, board, mcp, runner, providers,
//          secrets, settings, router, git, toolkit, decider, http, paths, redactor, log }
//
//   node server/index.js [--port n] [--data dir] [--config dir] [--projects dir] [--launcher] [--secrets keychain|file]
//                        [--labs mock]
//     folders  with no flags: <base>/data, <base>/config, <base>/projects (<base> holds server/)
//     port     no --port: DEFAULT_PORT (47117), or a free port when it is busy; --port n forces n; 0 = any free port
//     prints   WORKSHOP_READY http://127.0.0.1:<port>/#k=<ownerKey>   (stdout, one line, once the server listens)
//     lock     <data>/run/hub.lock { pid, port }: a second hub on the same data folder exits with a message
//     stops    on SIGINT, SIGTERM, SIGHUP, and when the launcher dies (stdin is a pipe that closes, or the pid in
//              WORKSHOP_LAUNCHER_PID is gone; --launcher forces the stdin watchdog). A stop pauses the live job,
//              saves the state, stops every agent and exits within STOP_BUDGET_MS.
//
// No top-level side effects unless this file is the entry point.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { paths as makePaths, createSettings } from './config.js';
import { createStore } from './store.js';
import { createHttp } from './http.js';
import { createRedactor } from './redact.js';
import { createSecrets } from './secrets.js';
import { createShellEnv } from './shellenv.js';
import { createProviders, runCommand } from './providers/index.js';
import { createClaudeAdapter } from './providers/claude.js';
import { createGeminiAdapter } from './providers/gemini.js';
import { createOssAdapter } from './providers/oss.js';
import { createMcp } from './mcp.js';
import { createGit } from './gitops.js';
import { createRouter } from './router.js';
import { createHarnesses } from './harnesses.js';
import { createRoster } from './roster.js';
import { createTraining } from './training.js';
import { createBenchlm } from './benchlm.js';
import { createRunner } from './runner.js';
import { createBoard } from './board.js';
import { createDecider } from './decider.js';
import { createToolkit } from './toolkit.js';
import { mountApi } from './api.js';
import * as prompts from './prompts.js';

export const VERSION = '0.1.0';
export const READY_PREFIX = 'WORKSHOP_READY ';
/** The port the entry point prefers: one origin across starts, so the page keeps its localStorage. */
export const DEFAULT_PORT = 47117;
/** From the first stop signal (stdin end-of-file) to the exit. The launcher sends SIGTERM at 5 s. */
export const STOP_BUDGET_MS = 4500;
const LIVE = ['planning', 'plan_review', 'running', 'qa', 'delivering'];
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const noop = () => {};

/** Lock files held by this process (two createApp calls in one process must also refuse each other). */
const HELD_LOCKS = new Set();

// ------------------------------------------------------------------ logger

/**
 * The real logger: one line per call to stderr and to <logs>/hub.log (0600), every line through the shared
 * redactor (stored keys, live agent tokens, the owner key). log(level, msg, data?).
 */
export function createLogger({ logsDir, redactor, stderr = process.stderr, minLevel = 'info' } = {}) {
  const min = LEVELS[minLevel] ?? LEVELS.info;
  let stream = null;
  if (logsDir) {
    try {
      fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      const file = path.join(logsDir, 'hub.log');
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, path.join(logsDir, 'hub.1.log'));
      } catch { /* no file yet */ }
      stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
      stream.on('error', noop);
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    } catch {
      stream = null;
    }
  }
  const scrub = (text) => {
    try { return redactor && typeof redactor.redact === 'function' ? redactor.redact(text) : text; } catch { return text; }
  };
  function log(level, msg, data) {
    try {
      const lv = LEVELS[level] ?? LEVELS.info;
      if (lv < min) return;
      let extra = '';
      if (data !== undefined) {
        try { extra = ` ${JSON.stringify(data)}`; } catch { extra = ' [data]'; }
      }
      const line = scrub(`${new Date().toISOString()} ${String(level).toUpperCase()} ${String(msg)}${extra}`).replace(/[\r\n]+/g, ' ');
      if (stream) stream.write(`${line}\n`);
      if (stderr) stderr.write(`${line}\n`);
    } catch { /* the log must never break the hub */ }
  }
  log.close = () => new Promise((resolve) => {
    if (!stream) return resolve();
    const s = stream;
    stream = null;
    s.end(resolve);
  });
  return log;
}

// ------------------------------------------------------------------ lock

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function parseLock(text) {
  try {
    const v = JSON.parse(text);
    return v && Number.isInteger(v.pid) ? v : null;
  } catch {
    return null;
  }
}

function readLock(file) {
  try {
    return parseLock(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The command line of a pid, or null when ps cannot tell. */
function commandOf(pid) {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    return out.trim();
  } catch (err) {
    return err && err.status === 1 ? '' : null; // status 1: no such process
  }
}

/**
 * Is the holder of a lock a live hub? A live pid that runs no node program is a pid the system gave to another
 * program after a crash: that lock is stale. When ps cannot tell, the lock counts as live.
 */
function holderAlive(pid) {
  if (pid === process.pid) return true;
  if (!pidAlive(pid)) return false;
  const cmd = commandOf(pid);
  return cmd === null || /node/i.test(cmd);
}

function lockedError(other) {
  const err = new Error(`Another WorkShop hub (pid ${other.pid}, port ${other.port || '?'}) already runs on this data folder. This one exits.`);
  err.code = 'E_HUB_LOCKED';
  err.other = { pid: other.pid, port: other.port || 0 };
  return err;
}

/**
 * Takes <run>/hub.lock. Throws Error{code:'E_HUB_LOCKED'} when a live hub holds it.
 * The lock is created with link(2) from a full temp file: it appears whole, and only one hub can create it.
 * A stale lock is first renamed away. The renamed file is checked again: if it is not the stale lock that was
 * judged (a new hub took the lock meanwhile), it goes back and this hub gives up. data/run/launcher.lock and
 * every other file in data/run stay as they are.
 */
export function acquireLock(runDir) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = path.join(runDir, 'hub.lock');
  const tag = `${process.pid}.${randomBytes(4).toString('hex')}`;
  const body = (port) => `${JSON.stringify({ pid: process.pid, port })}\n`;
  const tmp = `${file}.${tag}.tmp`;
  fs.writeFileSync(tmp, body(0), { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.linkSync(tmp, file);
        break; // ours
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      let text = null;
      try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      const other = parseLock(text);
      if (other && (other.pid === process.pid ? HELD_LOCKS.has(file) : holderAlive(other.pid))) throw lockedError(other);
      if (attempt >= 5) throw lockedError(other ?? { pid: 0, port: 0 });
      // Stale (dead pid, a pid of another program, a broken file, or our own pid from an old run).
      const aside = `${file}.${tag}.stale`;
      try { fs.renameSync(file, aside); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      let moved = null;
      try { moved = fs.readFileSync(aside, 'utf8'); } catch { moved = null; }
      if (moved !== text) {
        // Another hub took the lock between the read and the rename: give it back and stop.
        try { fs.linkSync(aside, file); } catch { /* a third hub holds it now */ }
        try { fs.unlinkSync(aside); } catch { /* gone */ }
        throw lockedError(readLock(file) ?? { pid: 0, port: 0 });
      }
      try { fs.unlinkSync(aside); } catch { /* gone */ }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
  HELD_LOCKS.add(file);
  const write = (port) => {
    const t = `${file}.${tag}.tmp`;
    fs.writeFileSync(t, body(port), { mode: 0o600 });
    fs.renameSync(t, file);
  };
  let released = false;
  return {
    file,
    setPort: (port) => { if (!released) write(port); },
    release() {
      if (released) return;
      released = true;
      HELD_LOCKS.delete(file);
      const now = readLock(file);
      if (now && now.pid === process.pid) {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      }
    },
  };
}

// ------------------------------------------------------------------ OS helpers (injectable)

/** The power assertion while a job is live: /usr/bin/caffeinate -i -w <hub pid>. It dies with the hub. */
export function createPowerAssertion({ log = noop, bin = '/usr/bin/caffeinate' } = {}) {
  let child = null;
  return {
    hold() {
      if (child) return;
      try {
        child = spawn(bin, ['-i', '-w', String(process.pid)], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
        child.on('error', (err) => { log('warn', 'power assertion not held', { error: err.message }); child = null; });
        child.on('exit', () => { child = null; });
        child.unref();
        log('info', 'power assertion on');
      } catch (err) {
        child = null;
        log('warn', 'power assertion not held', { error: err.message });
      }
    },
    release() {
      if (!child) return;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      child = null;
      log('info', 'power assertion off');
    },
    held: () => child !== null,
  };
}

/** The native folder dialog through osascript. Resolves to an absolute path, or null when the owner cancels. */
export function osascriptPicker({ env }) {
  return async () => {
    const r = await runCommand('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose the project folder")'], { env: typeof env === 'function' ? env() : env, timeoutMs: 10 * 60 * 1000 });
    if (r.code !== 0) return null;
    const p = String(r.stdout || '').trim().replace(/\/+$/, '');
    return p.startsWith('/') ? p : null;
  };
}

/** Finder at a folder. */
export function finderReveal({ env }) {
  return async (dir) => {
    const r = await runCommand('/usr/bin/open', ['--', String(dir)], { env: typeof env === 'function' ? env() : env, timeoutMs: 15000 });
    if (r.code !== 0) {
      const err = new Error('Finder did not open the folder.');
      err.status = 500;
      throw err;
    }
  };
}

/** Adapters with the real CLIs switched off (tests, demos): only the mock lab is installed. */
function mockOnlyAdapters({ shellEnv, log }) {
  return {
    claude: { ...createClaudeAdapter({ shellEnv, log }), locate: () => null },
    gemini: { ...createGeminiAdapter({ shellEnv, log }), locate: () => null },
    oss: {
      ...createOssAdapter({ shellEnv, getSettings: () => ({ oss: { standIn: false, baseUrl: 'http://127.0.0.1:1' } }), log }),
      probeEndpoint: async () => ({ ok: false, models: null, detail: 'mock-only mode' }),
    },
  };
}

// ------------------------------------------------------------------ the app

/**
 * Wires every module in order, starts the HTTP server and the scheduler heartbeat.
 * Options for tests: createOrchestrator (factory), adapters, labs:['mock'], shellEnv, pickFolder, reveal, power,
 * tickMs, fetchImpl, stderr, now.
 */
export async function createApp(options = {}) {
  const {
    root, dataDir, configDir, projectsDir, port = 0, portFallback = false, secretsBackend = 'keychain', env = process.env,
    tickMs = 3000, labs = null, adapters = null, fetchImpl = globalThis.fetch, stderr = process.stderr,
    now = Date.now, detect = true,
  } = options;
  const ownerKey = typeof options.ownerKey === 'string' && options.ownerKey ? options.ownerKey : randomBytes(32).toString('hex');
  const paths = makePaths({ root, dataDir, configDir, projectsDir });
  const cleanups = []; // run in reverse order on close() or on a failed boot

  // 1. Folders, the redactor (it knows the owner key at once) and the logger.
  for (const dir of [paths.data, paths.logs, paths.run]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(paths.data, 0o700); } catch { /* best effort */ }
  const redactor = createRedactor();
  redactor.add(ownerKey);
  let ownLog = null;
  let log = options.log;
  if (typeof log !== 'function') {
    ownLog = createLogger({ logsDir: paths.logs, redactor, stderr, minLevel: env.WORKSHOP_DEBUG === '1' ? 'debug' : 'info' });
    log = ownLog;
  }
  const say = (level, msg, data) => { try { log(level, msg, data); } catch { /* never */ } };

  // 2. One hub per data folder.
  const lock = acquireLock(paths.run);
  cleanups.push(() => lock.release());

  try {
    // 3. Settings, secrets (the redactor learns every stored value), store.
    const settings = createSettings({ configDir: paths.config, log });
    const getSettings = () => settings.get();
    const updateSettings = (patch) => settings.update(patch);
    const secrets = createSecrets({ backend: secretsBackend, dataDir: paths.data, redactor, log });
    try { await secrets.primeRedactor(); } catch (err) { say('warn', 'secrets: the redactor was not primed', { error: err.message }); }
    const store = createStore({ dataDir: paths.data, log });
    cleanups.push(() => store.flush());

    // 4. Labs: the clean agent environment, the provider registry.
    const shellEnv = options.shellEnv ?? createShellEnv({ env, log });
    // labs:['mock'] keeps the real CLIs off even when a test passes adapters: only the mock adapter can be replaced.
    const mockOnly = Array.isArray(labs) && labs.length === 1 && labs[0] === 'mock';
    const adapterSet = mockOnly ? { ...mockOnlyAdapters({ shellEnv, log }), ...(adapters?.mock ? { mock: adapters.mock } : {}) } : (adapters ?? {});
    const providers = createProviders({ secrets, getSettings, updateSettings, shellEnv, paths, log, adapters: adapterSet });
    cleanups.push(() => providers.dispose?.());

    // 5. MCP, git, router, Harness Rack, Employee Book, Phase 1 RFT queue, benchmarks, decider.
    const mcp = createMcp({ store, redactor, log });
    const git = createGit({ paths, getSettings, redactor, log });
    cleanups.push(() => git.shutdown?.());
    const router = createRouter({ modelsPath: path.join(paths.config, 'models.json'), providers, getSettings, log });
    const harnesses = createHarnesses({ configDir: paths.config, log, now });
    const roster = createRoster({ configDir: paths.config, harnesses, log, now });
    const training = createTraining({ dataDir: paths.data, roster, harnesses, log, now });
    const benchlm = createBenchlm({ fetchImpl, cachePath: path.join(paths.data, 'benchlm-cache.json'), log });
    const decider = createDecider({ secrets, getSettings, fetchImpl, log, redactor });
    await decider.refresh();

    // 6. HTTP (the port and the MCP URL are known after listen), the runner.
    const http = createHttp({ host: '127.0.0.1', port, uiDir: paths.ui, ownerKey, log });
    cleanups.push(() => http.close());
    let mcpUrl = null;
    const runner = createRunner({ store, providers, mcp, git, redactor, paths, getSettings, shellEnv, getMcpUrl: () => mcpUrl, log, now, tuning: options.runnerTuning ?? {} });
    cleanups.push(() => runner.shutdown());

    // 7. Board and orchestrator. The board reads orch.resolver through a late-bound proxy.
    let orch = null;
    const resolve = new Proxy({}, {
      get(_, name) {
        const r = orch && orch.resolver;
        const fn = r && typeof r[name] === 'function' ? r[name] : undefined;
        return fn ? fn.bind(r) : undefined;
      },
      has(_, name) { return !!(orch && orch.resolver && typeof orch.resolver[name] === 'function'); },
    });
    // The board runs on the same clock as the scheduler and the runner (shop time, section 7).
    const board = createBoard({ store, dataDir: paths.data, getSettings, resolve, redactor, now, log });
    board.registerTools(mcp);
    cleanups.push(async () => { await board.flush?.(); board.shutdown?.(); });

    const factory = options.createOrchestrator ?? (await import('./orchestrator.js')).createOrchestrator;
    // The heartbeat below drives the periodic tick, so the orchestrator keeps no interval of its own (tickMs 0).
    orch = await factory({
      store, board, mcp, runner, router, git, providers, decider, prompts, getSettings, updateSettings, secrets, paths, log, now,
      harnesses, roster, training,
      tuning: { tickMs: 0, ...(options.orchTuning ?? {}) },
    });
    if (!orch || typeof orch !== 'object') throw new Error('createOrchestrator returned nothing');
    // Stop: the orchestrator stops scheduling at once; then the turns and the running checks stop, so the hub steps
    // it waits for end soon (all inside the 7 s forced exit of main()). runner and git shut down again later: no-ops.
    cleanups.push(async () => {
      const done = Promise.resolve(orch.shutdown?.({ waitMs: 3000 }));
      await runner.shutdown();
      git.shutdown?.();
      await done;
    });

    // 8. Toolkit and the owner API (with the MCP routes).
    const openEnv = () => shellEnv.base(); // the clean environment, read when a dialog or Finder opens
    const reveal = options.reveal ?? finderReveal({ env: openEnv });
    const pickFolder = options.pickFolder ?? osascriptPicker({ env: openEnv });
    const toolkit = createToolkit({ store, dataDir: paths.data, shellEnv, orch, git, redactor, log, getSettings, reveal });
    const api = mountApi(http, {
      store, board, orch, providers, secrets, settings, router, benchlm, git, toolkit, decider, runner, mcp,
      harnesses, roster, training,
      pickFolder, reveal, log, now, version: VERSION,
    });
    cleanups.push(() => api.close());

    // 9. Settings, lab, Harness Rack, Employee Book, and RFT requisition changes reach the UI.
    const offSettings = settings.onChange((next) => {
      store.emit('settings', { settings: next });
      Promise.resolve(providers.refresh?.()).catch(noop);
    });
    cleanups.push(() => offSettings?.());
    const offProviders = typeof providers.onChange === 'function' ? providers.onChange((list) => store.emit('providers', { providers: list })) : null;
    cleanups.push(() => offProviders?.());
    const offHarnesses = harnesses.onChange((list) => store.emit('harnesses', { harnesses: list }, { persist: false }));
    cleanups.push(() => offHarnesses?.());
    const offRoster = roster.onChange((list) => store.emit('roster', { roster: list }, { persist: false }));
    cleanups.push(() => offRoster?.());
    const offTraining = training.onChange((list) => store.emit('requisitions', { requisitions: list }, { persist: false }));
    cleanups.push(() => offTraining?.());

    // 10. Listen. Now the lock holds the port and the runner knows the MCP URL. With portFallback a busy port
    // gives way to a free one (the entry point prefers DEFAULT_PORT, so the page keeps one origin across starts).
    let listening;
    try {
      listening = await http.listen(port);
    } catch (err) {
      if (!portFallback || port === 0 || (err.code !== 'EADDRINUSE' && err.code !== 'EACCES')) throw err;
      say('info', 'http: the preferred port is busy, the hub takes a free one', { port, error: err.code });
      listening = await http.listen(0);
    }
    mcpUrl = `${listening.url}/mcp`;
    lock.setPort(listening.port);

    // 11. The power assertion follows the live job.
    const power = options.power ?? createPowerAssertion({ log });
    const syncPower = () => {
      const live = store.list('jobs', (j) => LIVE.includes(j.status)).length > 0;
      if (live) power.hold(); else power.release();
    };
    const offPower = store.subscribe((e) => { if (e.type === 'upsert' && e.kind === 'jobs') syncPower(); else if (e.type === 'remove' && e.kind === 'jobs') syncPower(); });
    cleanups.push(() => { offPower(); power.release(); });

    // 12. Leftovers of a hub that was killed, labs, recover, the first tick, then the heartbeat on shop time.
    // The runner records each agent process in data/run/<agent>/turn.json; agents of a dead hub die here, also
    // when no turn starts soon (a paused job).
    try { await runner.reapOrphans?.(); } catch (err) { say('warn', 'runner: the look for leftovers failed', { error: err.message }); }
    if (detect) {
      try { await providers.detect(); } catch (err) { say('warn', 'providers: detect failed', { error: err.message }); }
    }
    await orch.recover?.();
    await orch.tick?.();
    syncPower();

    let lastBeat = now();
    let beating = false;
    const beat = async () => {
      if (beating) return;
      beating = true;
      try {
        const t = now();
        const gap = t - lastBeat;
        lastBeat = t;
        if (gap > 60000) say('info', 'shop time: the hub did not tick (sleep or a stall); deadlines move by the gap', { gapMs: gap });
        try { board.tick(t); } catch (err) { say('warn', 'board tick failed', { error: err.message }); }
        try { await orch.tick?.(); } catch (err) { say('warn', 'orchestrator tick failed', { error: err.message }); }
        syncPower();
      } finally {
        beating = false;
      }
    };
    const timer = tickMs > 0 ? setInterval(() => { beat().catch(noop); }, tickMs) : null;
    timer?.unref?.();
    cleanups.push(() => { if (timer) clearInterval(timer); });

    say('info', 'hub ready', { port: listening.port, pid: process.pid, data: paths.data });

    /**
     * Every hub stop is a pause (sections 3b, 4): the live job is paused with a reason and job.error, so the next
     * start runs no turn by itself. The running turns stop in close(); their sessions resume when the owner
     * resumes the job. Returns the ids it paused. A hub that is killed cannot do this: its job goes on at the next
     * start (crash recovery).
     */
    function pauseLive(why = 'the hub stopped') {
      const ids = [];
      if (typeof orch.pauseJob !== 'function') return ids;
      for (const job of store.list('jobs', (j) => LIVE.includes(j.status))) {
        try {
          orch.pauseJob(job.id);
          if (store.get('jobs', job.id)?.status === 'paused') {
            store.patch('jobs', job.id, { error: `The hub stopped (${why}). Resume the job to go on.` });
            ids.push(job.id);
          }
        } catch (err) {
          say('warn', 'shutdown: a live job was not paused', { job: job.id, error: err.message });
        }
      }
      if (ids.length > 0) say('info', 'shutdown: paused the live job', { jobs: ids });
      return ids;
    }

    let closing = null;
    async function close() {
      if (closing) return closing;
      closing = (async () => {
        say('info', 'hub stops');
        // Reverse order of boot: heartbeat, power, change hooks, API, orchestrator, board, runner (the turns stop
        // before the HTTP server closes), http, git (kills check and tool commands), providers, store flush, lock.
        for (const fn of cleanups.splice(0).reverse()) {
          try { await fn(); } catch (err) { say('warn', 'shutdown step failed', { error: err.message }); }
        }
        await toolkit.idle().catch(noop);
        if (ownLog) await ownLog.close();
      })();
      return closing;
    }

    return {
      url: listening.url, port: listening.port, ownerKey, close, beat, pauseLive, releaseLock: () => lock.release(),
      orch, store, board, mcp, runner, providers, secrets, settings, router, harnesses, roster, training, git, toolkit, decider, http, paths, redactor, log,
    };
  } catch (err) {
    for (const fn of cleanups.splice(0).reverse()) {
      try { await fn(); } catch { /* keep going */ }
    }
    if (ownLog) await ownLog.close();
    throw err;
  }
}

// ------------------------------------------------------------------ entry point

/** null = no --port: the entry point tries DEFAULT_PORT and falls back to a free port when it is busy. */
export function parseArgs(argv) {
  const out = { port: null, data: null, config: null, projects: null, launcher: false, secrets: 'keychain', labs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => (inline !== null ? inline : argv[++i]);
    if (flag === '--port') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port needs a number from 0 to 65535');
      out.port = n;
    } else if (flag === '--data') out.data = value();
    else if (flag === '--config') out.config = value();
    else if (flag === '--projects') out.projects = value();
    else if (flag === '--launcher') out.launcher = true;
    else if (flag === '--secrets') {
      const v = value();
      if (v !== 'keychain' && v !== 'file') throw new Error('--secrets must be keychain or file');
      out.secrets = v;
    } else if (flag === '--labs') {
      const v = value();
      if (v !== 'mock') throw new Error('--labs takes only "mock"');
      out.labs = ['mock'];
    } else throw new Error(`unknown option ${a}`);
  }
  for (const k of ['data', 'config', 'projects']) {
    if (out[k] === undefined || out[k] === '') throw new Error(`--${k} needs a folder`);
    if (out[k]) out[k] = path.resolve(out[k]);
  }
  return out;
}

/**
 * The last step of a stop: SIGTERM to the hub's own process group, so a helper that a module started in it
 * (and did not stop) ends too. Only when the hub leads its group (the launcher starts it so). A hub started by
 * hand in a shell pipeline or by a test runner shares a group with other programs and leaves it alone.
 */
function signalOwnGroup() {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    if (Number(out.trim()) === process.pid) process.kill(-process.pid, 'SIGTERM');
  } catch { /* best effort */ }
}

function stdinIsPipe() {
  try {
    const st = fs.fstatSync(0);
    return st.isFIFO() || st.isSocket();
  } catch {
    return false;
  }
}

/** overrides: extra createApp options (a wrapper script in a test passes a fake orchestrator factory). */
export async function main(argv = process.argv.slice(2), env = process.env, overrides = {}) {
  process.stdout.on('error', noop); // the launcher is gone: the watchdog below handles the exit
  process.stderr.on('error', noop);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`WorkShop hub: ${err.message}\n`);
    process.exit(2);
  }
  let app;
  try {
    app = await createApp({
      dataDir: args.data ?? undefined, configDir: args.config ?? undefined, projectsDir: args.projects ?? undefined,
      port: args.port ?? DEFAULT_PORT, portFallback: args.port === null,
      secretsBackend: args.secrets, labs: args.labs, env, ...overrides,
    });
  } catch (err) {
    process.stderr.write(`WorkShop hub: ${err.code === 'E_HUB_LOCKED' ? err.message : `cannot start: ${err.message}`}\n`);
    process.exit(1);
  }
  let stopping = false;
  // The launcher closes stdin, then sends SIGTERM 5 s later (its stop sequence). The hub must be gone before.
  // Order: pause the live job and save the state at once, then stop the turns and the rest. If that takes too
  // long, the hub exits anyway: the runner's exit hook kills the agent groups, the lock goes.
  const stop = async (reason, code = 0) => {
    if (stopping) return;
    stopping = true;
    app.log('info', 'shutdown', { reason });
    const force = setTimeout(() => {
      app.log('warn', 'shutdown: too slow, the hub exits now');
      try { app.releaseLock(); } catch { /* exit anyway */ }
      signalOwnGroup();
      process.exit(code || 1);
    }, STOP_BUDGET_MS);
    force.unref();
    const why = reason.startsWith('launcher gone') ? 'the WorkShop app quit' : reason === 'crash' ? 'an internal error' : `it got ${reason}`;
    try { app.pauseLive(why); } catch { /* go on */ }
    try { await app.store.flush(); } catch { /* close() flushes again */ }
    try { await app.close(); } catch { /* exit anyway */ }
    signalOwnGroup();
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(sig).catch(noop); });
  process.on('uncaughtException', (err) => { app.log('error', 'uncaught exception', { error: String(err?.stack ?? err) }); stop('crash', 1).catch(noop); });
  process.on('unhandledRejection', (err) => { app.log('error', 'unhandled rejection', { error: String(err?.stack ?? err) }); });

  // Launcher death: stdin is a pipe the launcher never writes; end-of-file means it is gone.
  if (args.launcher || stdinIsPipe()) {
    const gone = (how) => { stop(`launcher gone (stdin ${how})`).catch(noop); };
    process.stdin.on('end', () => gone('end'));
    process.stdin.on('close', () => gone('close'));
    process.stdin.on('error', () => gone('error'));
    process.stdin.resume();
  }
  const launcherPid = Number(env.WORKSHOP_LAUNCHER_PID);
  if (Number.isInteger(launcherPid) && launcherPid > 1) {
    const watch = setInterval(() => { if (!pidAlive(launcherPid)) stop('launcher gone (pid)').catch(noop); }, 2000);
    watch.unref();
  }
  process.stdout.write(`${READY_PREFIX}${app.url}/#k=${app.ownerKey}\n`);
  return app;
}

const isEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
})();
if (isEntry) main().catch((err) => { process.stderr.write(`WorkShop hub: ${err?.message ?? err}\n`); process.exit(1); });

