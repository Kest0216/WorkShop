// Provider registry: which agent CLIs exist on this Mac, whether they are signed in, and whether they may be used now.
//
// Safety rules of this module:
// - detect() is cheap and safe. For Claude it runs `claude --version` and `claude auth status --json` in the clean
//   environment. For the Google lab it ONLY checks that the agy file exists. It never runs agy.
// - checkAuth('gemini') is the single place that runs agy outside a job (`agy models`, stdin is a real pipe that
//   is already at end-of-file, 20 s limit). Call it only from an explicit owner action.
// - A sign-in failure that a real turn reported (markAuth 'none') stays until the owner checks again: the cheap
//   probe of detect() does not switch the lab on by itself.
// - No sign-in is ever started here. openLogin() opens Terminal with the sign-in command for the owner to run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openClosedPipe } from '../shellenv.js';
import { createClaudeAdapter } from './claude.js';
import { createGeminiAdapter } from './gemini.js';
import { createMockAdapter } from './mock.js';
import { createOssAdapter, probeEndpoint } from './oss.js';

const noop = () => {};
const DETECT_FRESH_MS = 15_000;
const COOL_STEP_MS = 5 * 60_000; // first pause of an episode when the CLI gives no reset time
const MAX_STEP_MS = 60 * 60_000; // the step doubles up to this
const MAX_COOL_MS = 7 * 24 * 3600_000;
const EFFORT_NAMES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** What the UI shows after "Sign in": a plain checklist. The hub itself never signs in. */
export const LOGIN_STEPS = Object.freeze(['Terminal opens', 'Sign in there', 'Come back and click Re-check']);
const REASON_ACK = 'Confirm the sign-in mode for this lab (read the note first).';
const REASON_SELFTEST = 'Run the self-test for this CLI version.';
const REASON_VERSION = 'The version of this CLI is not known yet. Click Re-check.';

/** True when a model id is on an account list. A slug `<model>-<effort>` counts (agy: gemini-4-hydrogen-low). */
export function onModelList(list, model) {
  if (!Array.isArray(list) || typeof model !== 'string' || !model) return false;
  const prefix = `${model}-`;
  return list.some((slug) => slug === model || (typeof slug === 'string' && slug.startsWith(prefix) && EFFORT_NAMES.has(slug.slice(prefix.length))));
}
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_OUTPUT = 256 * 1024;
const TIMEOUTS = { probe: 10_000, agyModels: 20_000, open: 10_000 };

const clip = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Run a command with an argument list. stdin is closed at once: by default Node's pipe (a socket pair), with
 * stdin 'fifo' a real pipe that is already at end-of-file (for agy, see openClosedPipe). Never /dev/null, never
 * a terminal. The whole process group is killed on timeout. Never rejects.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: object, cwd?: string, timeoutMs?: number, stdin?: 'pipe'|'fifo', fifoDir?: string }} [options]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, error: string|null }>}
 */
export function runCommand(cmd, args, { env, cwd, timeoutMs = TIMEOUTS.probe, stdin = 'pipe', fifoDir } = {}) {
  return new Promise((resolve) => {
    let child;
    const fifo = stdin === 'fifo' ? openClosedPipe(fifoDir) : null; // null: fall back to Node's pipe
    try {
      child = spawn(cmd, args, { env, cwd, stdio: [fifo ?? 'pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: err?.code ?? err?.message ?? 'spawn failed' });
      return;
    } finally {
      if (fifo !== null) {
        try { fs.closeSync(fifo); } catch { /* already closed */ }
      }
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.pid) killGroup(); // sweep helpers the command left behind
      resolve({ stdout, stderr, timedOut, error: null, ...result });
    };
    child.stdin?.on('error', noop);
    child.stdin?.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on('error', (err) => finish({ code: null, signal: null, error: err?.code ?? err?.message ?? 'spawn failed' }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

/**
 * @param {object} deps
 * @param {{ list(): Promise<object[]>, envFor(id: string): Promise<object> }} deps.secrets
 * @param {() => object} deps.getSettings
 * @param {(patch: object) => object} deps.updateSettings
 * @param {{ path: string, resolve: Function, base: Function }} deps.shellEnv
 * @param {{ run?: string, data?: string }} [deps.paths]
 * @param {(level: string, msg: string, data?: object) => void} [deps.log]
 * @param {object} [deps.adapters] replace adapters by id (tests)
 * @param {string} [deps.openPath] the macOS `open` tool (tests inject a fake)
 */
export function createProviders({
  secrets, getSettings, updateSettings, shellEnv, paths = {}, log = noop,
  adapters: adapterOverrides = {}, openPath = '/usr/bin/open', now = () => Date.now(), timeouts = {},
} = {}) {
  if (!shellEnv) throw new Error('createProviders needs shellEnv');
  if (typeof getSettings !== 'function') throw new Error('createProviders needs getSettings');
  const say = (level, msg, data) => {
    try { log(level, msg, data); } catch { /* a broken logger must not break the registry */ }
  };
  const limits = { ...TIMEOUTS, ...timeouts };
  const adapters = {
    claude: adapterOverrides.claude ?? createClaudeAdapter({ shellEnv, log }),
    gemini: adapterOverrides.gemini ?? createGeminiAdapter({ shellEnv, log }),
    oss: adapterOverrides.oss ?? createOssAdapter({ shellEnv, getSettings, log }),
    mock: adapterOverrides.mock ?? createMockAdapter({ shellEnv, log }),
  };
  const ids = Object.keys(adapters);
  const state = Object.fromEntries(ids.map((id) => [id, {
    installed: id === 'mock' || id === 'oss',
    version: id === 'mock' ? '1' : id === 'oss' ? '0.1.0' : null,
    path: id === 'mock' || id === 'oss' ? process.execPath : null,
    auth: id === 'mock' ? 'ok' : 'unknown',
    models: null, keySet: false, coolTimer: null, limit: null,
    detail: null,
    // Cooling episodes. Key '' is the whole lab, any other key one model: { until, reason, setAt, step }.
    // An episode stays here after it ends, so the next failure knows it is "the first turn after a reset".
    episodes: {},
    turnAuthFailed: false, // a real turn could not sign in since the owner's last check (or since the key was saved)
    keyStamp: null, // updatedAt of the saved API key
  }]));
  const listeners = new Set();
  let lastEmitted = '';
  let detecting = null;
  let detectedAt = 0;
  let checking = null; // one agy check at a time
  let selfTestImpl = null;
  let disposed = false;

  const settings = () => {
    try { return getSettings() ?? {}; } catch { return {}; }
  };
  const ossCfg = () => ({ engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', standIn: false, ...(settings().oss ?? {}) });
  const modeOf = (id) => {
    if (id === 'mock') return null;
    if (id === 'oss') return ossCfg().standIn === true ? 'standin' : 'local';
    const mode = settings().auth?.[id];
    return mode === 'apikey' ? 'apikey' : null;
  };
  const saved = (id) => settings().providers?.[id] ?? {};

  /** The active cooling of the lab (key '') or of one model, or null. */
  function activeEpisode(id, key = '') {
    const ep = state[id].episodes[key];
    return ep && ep.until > now() ? ep : null;
  }
  const pausedText = (ep) => `Paused until ${new Date(ep.until).toLocaleTimeString()}: ${ep.reason}`;

  /** The owner's check mark for the mode: settings.authAck[lab].mode must equal the chosen mode. */
  const acked = (id) => {
    if (id === 'oss' || id === 'mock') return true;
    const mode = modeOf(id);
    return mode !== null && settings().authAck?.[id]?.mode === mode;
  };
  const sandboxed = () => settings().safety !== 'trusting';
  /** settings.selfTest[lab] when it is a pass for the installed CLI version. */
  const selfTestPass = (id) => {
    const entry = settings().selfTest?.[id];
    const version = state[id].version;
    return !!entry && entry.ok === true && typeof version === 'string' && entry.version === version;
  };

  /** Why the lab cannot take work now, or null. `{ selfTest:false }` leaves the self-test rule out. */
  function why(id, { selfTest = true } = {}) {
    const s = state[id];
    const lab = activeEpisode(id);
    if (id === 'mock') return lab ? pausedText(lab) : null;
    const label = adapters[id].label;
    if (id === 'oss') {
      const mode = modeOf('oss');
      if (mode === 'standin') return lab ? pausedText(lab) : null;
      if (s.auth !== 'ok') return s.detail || 'Open-Source endpoint is not reachable. Start Ollama/vLLM or enable Phase 0 Stand-in mode.';
      if (lab) return pausedText(lab);
      return null;
    }
    if (!s.installed) return `${label} is not installed.`;
    const mode = modeOf(id);
    if (!mode) return 'Enable API key mode for this Frontier lab.';
    if (!acked(id)) return REASON_ACK;
    if (mode === 'apikey' && !s.keySet) return 'No API key is saved for this lab.';
    if (mode === 'apikey' && s.turnAuthFailed) return `The API refused the key of ${label}. Save a new key, or check again.`;
    if (lab) return pausedText(lab);
    // A pass counts only for the installed version. Without a known version no self-test can make one.
    if (selfTest && sandboxed() && typeof s.version !== 'string') return REASON_VERSION;
    if (selfTest && sandboxed() && !selfTestPass(id)) return REASON_SELFTEST;
    return null;
  }

  function status(id) {
    const s = state[id];
    if (s.limit && s.limit.resetAt !== null && s.limit.resetAt <= now()) s.limit = null; // that window is over
    const adapter = adapters[id];
    const reason = why(id);
    const lab = activeEpisode(id);
    const cooledModels = {};
    for (const [key, ep] of Object.entries(s.episodes)) if (key && ep.until > now()) cooledModels[key] = { until: ep.until, reason: ep.reason };
    const stored = settings().selfTest?.[id];
    return {
      id,
      label: adapter.label,
      lab: adapter.lab,
      installed: s.installed,
      version: s.version,
      path: s.path,
      auth: s.auth,
      mode: modeOf(id),
      ack: id === 'mock' || id === 'oss' ? true : acked(id),
      keySet: s.keySet,
      usable: reason === null,
      reason,
      cooling: lab ? { until: lab.until, reason: lab.reason } : null,
      cooledModels,
      selfTest: stored && typeof stored === 'object' ? { version: stored.version ?? null, ok: stored.ok === true, ts: stored.ts ?? null } : null,
      policyNote: adapter.policyNote?.() ?? null,
      loginCmd: adapter.loginCommand?.(s.path)?.display ?? null,
      installHint: s.installed ? null : adapter.installHint?.() ?? null,
      models: s.models ? [...s.models] : null,
      limit: s.limit ? { ...s.limit } : null,
      ...(id === 'oss' ? { oss: ossCfg(), detail: s.detail } : {}),
    };
  }

  const list = () => ids.map(status);

  function emit() {
    if (disposed) return;
    const statuses = list();
    const text = JSON.stringify(statuses);
    if (text === lastEmitted) return;
    lastEmitted = text;
    for (const fn of [...listeners]) {
      try { fn(statuses); } catch (err) { say('error', 'providers: onChange listener failed', { error: err?.message ?? String(err) }); }
    }
  }

  function get(id) {
    const adapter = adapters[id];
    if (!adapter) throw fail(404, `Unknown provider: ${id}`);
    return adapter;
  }

  async function refreshKeys() {
    let entries = [];
    try { entries = (await secrets?.list?.()) ?? []; } catch (err) { say('warn', 'providers: cannot list keys', { error: err?.message ?? String(err) }); }
    for (const id of ids) {
      const keyVar = adapters[id].keyVar;
      const entry = keyVar ? entries.find((e) => e?.envVar === keyVar && e?.set === true) : null;
      state[id].keySet = !!entry;
      const stamp = entry ? entry.updatedAt ?? null : null;
      // A key that was saved again gets a new try. (In subscription mode only the owner's check does that.)
      if (stamp !== state[id].keyStamp && state[id].keyStamp !== null && modeOf(id) === 'apikey') state[id].turnAuthFailed = false;
      state[id].keyStamp = stamp;
    }
  }

  /** The API key variable of one lab, in API key mode (or optional OSS bearer token). {} otherwise. Never logged. */
  async function keyEnv(id) {
    const adapter = get(id);
    if (!adapter.keyVar) return {};
    if (id !== 'oss' && modeOf(id) !== 'apikey') return {};
    try {
      const env = (await secrets?.envFor?.(id)) ?? {};
      return typeof env[adapter.keyVar] === 'string' && env[adapter.keyVar] ? { [adapter.keyVar]: env[adapter.keyVar] } : {};
    } catch (err) {
      say('warn', 'providers: cannot read the API key', { id, error: err?.message ?? String(err) });
      return {};
    }
  }

  async function detectClaude() {
    const adapter = adapters.claude;
    const s = state.claude;
    const file = adapter.locate();
    if (!file) {
      Object.assign(s, { installed: false, version: null, path: null, auth: 'unknown' });
      return;
    }
    s.installed = true;
    s.path = file;
    const env = adapter.probes.env();
    const cwd = os.tmpdir();
    const [version, auth] = await Promise.all([
      runCommand(file, adapter.probes.version.args, { env, cwd, timeoutMs: limits.probe }),
      runCommand(file, adapter.probes.auth.args, { env, cwd, timeoutMs: limits.probe }),
    ]);
    s.version = version.error || version.timedOut ? null : adapter.probes.version.parse(version.stdout);
    s.auth = auth.error || auth.timedOut ? 'unknown' : adapter.probes.auth.parse(auth.stdout);
    // `auth status` only says that a login is saved. When a real turn was refused (401), the saved login is
    // not good: the cheap probe must not switch the lab on again by itself, or the hub would try, fail and
    // try again. Only the owner's check (checkAuth) lifts this.
    if (s.turnAuthFailed && s.auth === 'ok') s.auth = 'none';
    if (version.timedOut || auth.timedOut) say('warn', 'providers: a claude probe timed out');
  }

  /** File-existence check only. The sign-in state comes from the settings (set by the owner's check). */
  function detectGemini() {
    const adapter = adapters.gemini;
    const s = state.gemini;
    const file = adapter.locate();
    const keep = saved('gemini');
    s.installed = !!file;
    s.path = file;
    s.version = file && typeof keep.version === 'string' ? keep.version : null;
    s.auth = keep.authOk === true ? 'ok' : keep.authOk === false ? 'none' : 'unknown';
    s.models = Array.isArray(keep.models) && keep.models.length ? keep.models.filter((m) => typeof m === 'string') : null;
    adapter.setKnownModels?.(s.models);
  }

  async function detectOss({ activeProbe = false } = {}) {
    const s = state.oss;
    const cfg = ossCfg();
    s.installed = true;
    s.path = process.execPath;
    if (cfg.standIn === true) {
      s.version = 'standin-0';
      s.auth = 'ok';
      s.models = null;
      s.detail = 'Phase 0 Stand-in mode active ($0 local simulation)';
      return;
    }
    s.version = 'local-v1';
    const adapter = adapters.oss;
    if (typeof adapter.probeEndpoint !== 'function') {
      s.auth = 'ok';
      s.models = null;
      s.detail = 'Custom OSS adapter';
      return;
    }
    const keys = await keyEnv('oss');
    const timeoutMs = activeProbe ? Math.min(limits.probe, 5000) : 1500;
    const res = await adapter.probeEndpoint({ baseUrl: cfg.baseUrl, apiKey: keys.OSS_API_KEY || null, timeoutMs });
    s.auth = res.ok ? 'ok' : 'none';
    s.models = res.ok ? res.models : null;
    s.detail = res.detail || null;
  }

  /** Cheap and safe: binary lookup, `claude --version`, optional local OSS probe. Never runs agy. */
  function detect({ force = false } = {}) {
    if (detecting) return detecting;
    if (!force && detectedAt && now() - detectedAt < DETECT_FRESH_MS) return Promise.resolve(list());
    detecting = (async () => {
      try {
        await Promise.all([
          detectClaude(),
          refreshKeys(),
          detectOss({ activeProbe: false }),
        ]);
        detectGemini();
        detectedAt = now();
      } catch (err) {
        say('error', 'providers: detect failed', { error: err?.message ?? String(err) });
      } finally {
        detecting = null;
      }
      emit();
      return list();
    })();
    return detecting;
  }

  function persistGemini(patch) {
    try {
      updateSettings?.({ providers: { gemini: patch } });
    } catch (err) {
      say('warn', 'providers: cannot save the Google lab state', { error: err?.message ?? String(err) });
    }
  }

  async function checkGemini() {
    const adapter = adapters.gemini;
    const s = state.gemini;
    detectGemini();
    await refreshKeys();
    const mode = modeOf('gemini');
    if (!s.installed || !mode) return; // nothing to run: the status says why
    const keys = await keyEnv('gemini');
    if (mode === 'apikey' && Object.keys(keys).length === 0) return;
    const guard = adapter.mayRun?.(s.path);
    if (guard && !guard.ok) {
      say('warn', 'providers: agy check refused', { why: guard.why });
      return;
    }
    const check = adapter.authCheck;
    const cwd = os.tmpdir();
    const stdio = { stdin: check.stdin === 'fifo' ? 'fifo' : 'pipe', fifoDir: paths.run ?? paths.data };
    // apikey mode: the settings go into a file of the run folder (mode 0600), never inline on the command line.
    const content = check.settingsContent?.(mode) ?? null;
    let settingsFile = null;
    if (content !== null) {
      const dir = path.join(paths.run ?? paths.data ?? os.tmpdir(), 'agy-check');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      settingsFile = path.join(dir, 'settings.json');
      try { if (fs.lstatSync(settingsFile).isSymbolicLink()) fs.unlinkSync(settingsFile); } catch { /* none yet */ }
      fs.writeFileSync(settingsFile, content, { mode: 0o600 });
      fs.chmodSync(settingsFile, 0o600);
    }
    const result = await runCommand(s.path, check.args(mode, settingsFile), { env: check.env(mode, keys), cwd, timeoutMs: limits.agyModels, ...stdio });
    const parsed = check.parse(result);
    say('info', 'providers: agy sign-in check', { auth: parsed.auth, detail: parsed.detail });
    s.auth = parsed.auth;
    if (parsed.auth === 'ok') {
      s.turnAuthFailed = false;
      s.models = parsed.models;
      adapter.setKnownModels?.(s.models);
      const version = await runCommand(s.path, check.versionArgs, { env: check.env(mode, keys), cwd, timeoutMs: limits.probe, ...stdio });
      s.version = version.error || version.timedOut || version.code !== 0 ? s.version : check.parseVersion(version.stdout);
    }
    persistGemini({
      authOk: parsed.auth === 'ok' ? true : parsed.auth === 'none' ? false : null,
      models: s.models, version: s.version, checkedAt: now(),
    });
  }

  /** Owner-initiated ("Re-check"). */
  async function checkAuth(id) {
    get(id);
    if (id === 'gemini') {
      if (!checking) checking = checkGemini().catch((err) => say('error', 'providers: the agy check failed', { error: err?.message ?? String(err) })).finally(() => { checking = null; });
      await checking;
    } else if (id === 'claude') {
      if (detecting) await detecting;
      state.claude.turnAuthFailed = false;
      await detect({ force: true });
    } else if (id === 'oss') {
      await refreshKeys();
      await detectOss({ activeProbe: true });
    }
    emit();
    return status(id);
  }

  /**
   * installed, a mode chosen, authAck for that mode, (apikey: key set; subscription: signed in), not cooling,
   * and in safety `sandboxed` a self-test pass for the installed CLI version.
   */
  function usable(id) {
    return adapters[id] ? why(id) === null : false;
  }

  /** Every condition of usable() except the self-test pass: the self-test itself may run. */
  function ready(id) {
    if (!adapters[id]) return { ok: false, reason: `Unknown provider: ${id}` };
    const reason = why(id, { selfTest: false });
    return { ok: reason === null, reason };
  }

  /**
   * usable(id), the model is not cooled, and the model is on ProviderStatus.models when that list is known
   * (agy: a slug <model>-<effort> counts).
   */
  function modelUsable(id, model) {
    if (!usable(id)) return false;
    if (typeof model !== 'string' || !model) return false;
    if (activeEpisode(id, model)) return false;
    const list = state[id].models;
    return Array.isArray(list) && list.length > 0 ? onModelList(list, model) : true;
  }

  /** One timer per lab: it fires when the next pause of the lab or of one of its models ends. */
  function armExpiry(id) {
    const s = state[id];
    if (s.coolTimer) clearTimeout(s.coolTimer);
    s.coolTimer = null;
    const ends = Object.values(s.episodes).map((ep) => ep.until).filter((until) => until > now());
    if (ends.length === 0 || disposed) return;
    const wait = Math.min(...ends) - now();
    s.coolTimer = setTimeout(() => {
      s.coolTimer = null;
      say('info', 'providers: a pause is over', { id });
      emit();
      armExpiry(id);
    }, Math.min(Math.max(wait, 0) + 5, MAX_TIMER_MS));
    s.coolTimer.unref?.();
  }

  /**
   * Pause a lab, or with `model` only that model, until `untilTs`. Cooling is one episode:
   * - a call from a turn that started before the current episode was set is ignored;
   * - while an episode runs, a new limit only extends it to a later reset time;
   * - without a reset time a new episode lasts the step: 5 min, doubled (60 min at most) only when the
   *   first turn after the last episode failed again; noteSuccess() resets the step.
   */
  function cool(id, untilTs, reason, { model, turnStartedAt } = {}) {
    get(id);
    const s = state[id];
    const key = typeof model === 'string' && model ? model : '';
    const t = now();
    const ep = s.episodes[key] ?? null;
    if (ep && Number.isFinite(turnStartedAt) && turnStartedAt < ep.setAt) return status(id); // a turn of the earlier episode
    const resetAt = Number.isFinite(untilTs) && untilTs > t ? Math.min(untilTs, t + MAX_COOL_MS) : null;
    const text = clip(reason || 'rate limit', 200);
    if (ep && ep.until > t) {
      if (resetAt !== null && resetAt > ep.until) ep.until = resetAt;
      ep.reason = text;
    } else {
      const step = ep ? Math.min(ep.step * 2, MAX_STEP_MS) : COOL_STEP_MS;
      s.episodes[key] = resetAt !== null
        ? { until: resetAt, reason: text, setAt: t, step: ep?.step ?? COOL_STEP_MS }
        : { until: t + step, reason: text, setAt: t, step };
    }
    armExpiry(id);
    say('warn', key ? 'providers: model paused' : 'providers: lab paused', { id, model: key || null, until: s.episodes[key].until, reason: text });
    emit();
    return status(id);
  }

  /** A turn of this lab (and model) ended well: the next limit starts a fresh episode with the short step. */
  function noteSuccess(id, model) {
    if (!adapters[id]) return;
    const s = state[id];
    for (const key of ['', typeof model === 'string' ? model : null]) {
      if (key === null) continue;
      const ep = s.episodes[key];
      if (ep && ep.until <= now()) delete s.episodes[key]; // a running pause is never ended by a late success
    }
  }

  /** The runner reports what a real turn showed: 'none' after a sign-in error, 'ok' after a good turn. */
  function markAuth(id, value) {
    get(id);
    if (value !== 'ok' && value !== 'none') return status(id);
    if (id === 'mock') return status(id);
    state[id].turnAuthFailed = value === 'none';
    if (state[id].auth !== value) {
      state[id].auth = value;
      if (id === 'gemini') persistGemini({ authOk: value === 'ok' });
      say(value === 'ok' ? 'info' : 'warn', 'providers: sign-in state changed', { id, auth: value });
    }
    emit();
    return status(id);
  }

  /**
   * The runner reports what the CLI said about the plan limit (Claude: rate_limit_event lines). The UI shows it
   * as the usage chip of the lab. It does not pause the lab: cool() does that.
   * @param {string} id
   * @param {{ status?: string|null, type?: string|null, utilization?: number|null, resetAt?: number|null, overage?: boolean }} info
   */
  function noteLimit(id, info) {
    if (!adapters[id] || info === null || typeof info !== 'object') return;
    const text = (v) => (typeof v === 'string' && v ? clip(v, 40) : null);
    const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const next = { status: text(info.status), type: text(info.type), utilization: number(info.utilization), resetAt: number(info.resetAt), overage: info.overage === true, at: now() };
    const prev = state[id].limit;
    state[id].limit = next;
    const same = prev && ['status', 'type', 'utilization', 'resetAt', 'overage'].every((key) => prev[key] === next[key]);
    if (!same) emit();
  }

  /** Consumer subscription login is disabled in Phase 0; Frontier labs use API keys only. */
  async function openLogin(id) {
    const adapter = get(id);
    if (id === 'mock' || id === 'oss') throw fail(400, `${adapter.label} needs no sign-in.`);
    throw fail(400, 'Consumer subscription sign-in is disabled; configure an API key instead.');
  }

  /** fn(statuses) is called whenever a status changes. Returns an unsubscribe function. */
  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange needs a function');
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  return {
    list,
    get,
    detect,
    checkAuth,
    usable,
    ready,
    modelUsable,
    cool,
    noteSuccess,
    markAuth,
    openLogin,
    onChange,
    keyEnv,
    noteLimit,
    status: (id) => { get(id); return status(id); },
    /** Call after a settings or key change: re-reads the keys and tells the listeners when a status changed. */
    async refresh() {
      await refreshKeys();
      detectGemini();
      if (ossCfg().standIn === true) {
        await detectOss({ activeProbe: false });
      } else if (state.oss.version === 'standin-0') {
        state.oss.version = 'local-v1';
        state.oss.auth = 'unknown';
        state.oss.detail = 'Open-Source endpoint not checked yet.';
      }
      emit();
      return list();
    },
    /** The runner provides the self-test (one tiny real turn). */
    setSelfTest(fn) { selfTestImpl = typeof fn === 'function' ? fn : null; },
    /**
     * One tiny real turn with the containment checks (the runner provides it). It runs only when every other
     * condition of usable() holds. A test that ran stores settings.selfTest[lab] = { version, ok, core,
     * advisory, ts }; `ok` is true only when every core check passed.
     * @returns {Promise<{ ok, core, advisory, steps, loaded, logTail }>}
     */
    async selfTest(id, options) {
      get(id);
      if (!selfTestImpl) throw fail(503, 'The self-test is not ready yet.');
      const result = await selfTestImpl(id, options);
      const core = Array.isArray(result?.core) ? result.core : [];
      if (id !== 'mock' && core.length > 0) {
        const advisory = Array.isArray(result.advisory) ? result.advisory : [];
        const entry = { version: state[id].version ?? null, ok: result.ok === true && core.every((c) => c?.ok === true), core, advisory, ts: now() };
        try {
          updateSettings?.({ selfTest: { [id]: entry } });
        } catch (err) {
          say('warn', 'providers: cannot save the self-test result', { id, error: err?.message ?? String(err) });
        }
        emit();
      }
      return result;
    },
    /** Stop timers and listeners (tests, shutdown). */
    dispose() {
      disposed = true;
      listeners.clear();
      for (const id of ids) {
        if (state[id].coolTimer) clearTimeout(state[id].coolTimer);
        state[id].coolTimer = null;
      }
    },
  };
}
