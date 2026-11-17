// Paths, default settings, and the owner settings file (config/settings.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Wrap the injected logger so that a missing or broken logger never breaks a caller. */
function safeLog(log) {
  if (typeof log !== 'function') return () => {};
  return (level, msg, data) => {
    try {
      log(level, msg, data);
    } catch { /* logging must never throw */ }
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Built-in settings. Frozen: change settings through createSettings().update(). */
export const DEFAULT_SETTINGS = deepFreeze({
  crewPresets: {
    solo: { bosses: 1, managers: 0, makers: 2 },
    standard: { bosses: 1, managers: 1, makers: 4 },
    full: { bosses: 2, managers: 2, makers: 6 },
  },
  defaultCrew: 'standard',
  limits: {
    maxAgents: 6,
    perProvider: { claude: 2, gemini: 2, oss: 6, mock: 8 },
    maxReworks: 3,
    maxNudges: 2,
    maxRetries: 2,
    maxBlocks: 2,
    maxClaims: 5,
    maxReviewers: 2,
    maxQaRounds: 3,
    maxTasks: 40,
    maxTasksTotal: 60,
    turnTimeoutMin: 45,
    taskTimeoutMin: { S: 20, M: 45, L: 90 },
    idleTimeoutMin: 12,
    checkTimeoutMin: 10,
    holdFallbackMin: 20,
    maxFileMb: 1,
    maxDeliveryMb: 5,
    maxDeliveryFiles: 500,
    turnUsd: 5,
    rotateTok: { boss: 40000, manager: 40000, maker: 90000 },
    rotateGapMin: 5,
    rotateGapTok: 25000,
  },
  review: { reviewer: 'boss', crossLab: true, smallByManager: true },
  pairing: 'M+L', // 'costly' | 'M+L' | 'all'
  approvePlan: false,
  safety: 'sandboxed', // or 'trusting'
  thrift: 0.3, // 0 = best model always, 1 = cheapest that fits
  allowFallback: true, // route to the other lab when one is cooling or missing
  auth: { claude: null, gemini: null }, // null = the owner has not chosen yet (lab unusable); 'apikey' only for Frontier labs
  authAck: { claude: null, gemini: null }, // { mode: 'apikey', ts }: the owner saw the policy note for API key mode
  selfTest: { claude: null, gemini: null }, // { version, ok, core, advisory, ts }
  oss: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', standIn: false },
  presence: 'here', // or 'away'
  humanWaitMin: 30,
  budgetUsd: 20, // default budget of a new job; applies to billedUsd
  board: {}, // overrides of the ShopTalk LIMITS
  ui: { sound: false, scanlines: false },
});

/**
 * Resolve the app folders.
 * @param {{ root?: string, dataDir?: string, projectsDir?: string, configDir?: string }} [opts]
 *   root defaults to the folder that contains server/. The *Dir options override one folder each.
 * @returns {{ root, server, ui, config, data, logs, run, work, projects }} absolute paths
 */
export function paths({ root, dataDir, projectsDir, configDir } = {}) {
  const base = path.resolve(root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const data = path.resolve(dataDir ?? path.join(base, 'data'));
  return {
    root: base,
    server: path.join(base, 'server'),
    ui: path.join(base, 'ui'),
    config: path.resolve(configDir ?? path.join(base, 'config')),
    data,
    logs: path.join(data, 'logs'),
    run: path.join(data, 'run'),
    work: path.join(data, 'work'),
    projects: path.resolve(projectsDir ?? path.join(base, 'projects')),
  };
}

/** Plain JSON copy without unsafe keys. Returns undefined when the value has no JSON form. */
function cloneJson(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return undefined;
  return JSON.parse(text, (key, child) => (UNSAFE_KEYS.has(key) ? undefined : child));
}

/** Fast deep copy of settings data (plain JSON that cloneJson has cleaned before). */
function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (!isObj(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) out[key] = copy(value[key]);
  return out;
}

function typeName(value) {
  return isObj(value) ? 'an object' : Array.isArray(value) ? 'a list' : `a ${typeof value}`;
}

/** True when `value` may replace a default of the same kind (number stays number, and so on). */
function fits(wanted, value) {
  if (Array.isArray(wanted)) return Array.isArray(value);
  if (typeof wanted === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === typeof wanted && value !== null && !Array.isArray(value);
}

const isAmount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRecord = (test) => (v) => v === null || (isObj(v) && test(v));
/** authAck.<lab>: the owner saw the policy note for API key mode (contract 14b, review A12). */
const isAck = isRecord((v) => v.mode === 'apikey' && isAmount(v.ts));
/** A list of check results as providers.selfTest() returns them: [{ name, ok, detail }] (contract section 10). */
const isChecks = (v) => v === undefined || (Array.isArray(v) && v.every(isObj));
/**
 * selfTest.<lab>: the last self-test of that lab (contract 14b, review A08), as providers.selfTest() stores it:
 * { version, ok, core:[check], advisory:[check], ts }. `version` is null when the CLI did not report one
 * (such a record is never a pass: usable() compares it with the installed version).
 */
const isSelfTest = isRecord((v) => (typeof v.version === 'string' || v.version === null) && typeof v.ok === 'boolean'
  && isAmount(v.ts) && isChecks(v.core) && isChecks(v.advisory));

/**
 * Value rules that the type of a default cannot express: a fixed set of words, a range, or
 * "null or a number". A key with a rule is checked by the rule alone. Rows: [path, test, wanted form].
 */
const oneOf = (...values) => (v) => values.includes(v);
const VALUE_RULES = [
  [/^auth\.[^.]+$/, oneOf(null, 'apikey'), "null or 'apikey'"],
  [/^authAck\.[^.]+$/, isAck, "null or { mode: 'apikey', ts: number }"],
  [/^selfTest\.[^.]+$/, isSelfTest, 'null or { version: string|null, ok: boolean, core?: [check], advisory?: [check], ts: number }'],
  [/^oss\.engine$/, oneOf('ollama', 'vllm', 'sglang', 'llamacpp', 'custom'), "'ollama', 'vllm', 'sglang', 'llamacpp' or 'custom'"],
  [/^oss\.baseUrl$/, (v) => typeof v === 'string' && /^https?:\/\/[^\s]+$/.test(v) && v.length <= 300, 'an http:// or https:// URL'],
  [/^oss\.standIn$/, (v) => typeof v === 'boolean', 'true or false'],
  [/^budgetUsd$/, (v) => v === null || isAmount(v), 'null or a number from 0 up'],
  [/^safety$/, oneOf('sandboxed', 'trusting'), "'sandboxed' or 'trusting'"],
  [/^thrift$/, (v) => isAmount(v) && v <= 1, 'a number from 0 to 1'],
  [/^pairing$/, oneOf('costly', 'M+L', 'all'), "'costly', 'M+L' or 'all'"],
  [/^presence$/, oneOf('here', 'away'), "'here' or 'away'"],
];

/**
 * Deep merge `patch` over `base` and return a new object.
 * - A key whose default is an object merges key by key (the value must be an object).
 * - A key with a value rule must pass the rule. A key with another default must keep its type.
 * - A key whose default is null holds one value (authAck.<lab>, selfTest.<lab>): a new value
 *   replaces the old one as a whole.
 * - A key without a default passes through: objects merge key by key, everything else replaces.
 * A bad value is reported through `bad` and skipped.
 */
function merge(base, patch, shape, where, bad) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key) || value === undefined) continue;
    const at = where ? `${where}.${key}` : key;
    const known = isObj(shape) && Object.hasOwn(shape, key);
    const wanted = known ? shape[key] : undefined;
    const rule = VALUE_RULES.find(([pattern]) => pattern.test(at));
    if (rule) {
      if (rule[1](value)) out[key] = value;
      else bad(at, rule[2]);
    } else if (isObj(wanted)) {
      if (isObj(value)) out[key] = merge(isObj(out[key]) ? out[key] : {}, value, wanted, at, bad);
      else bad(at, 'an object');
    } else if (known && wanted !== null && !fits(wanted, value)) {
      bad(at, typeName(wanted));
    } else if (!known && isObj(value) && isObj(out[key])) {
      out[key] = merge(out[key], value, undefined, at, bad);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The part of `value` that differs from `base`. Objects are compared key by key. */
function diff(value, base) {
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const known = isObj(base) && Object.hasOwn(base, key) ? base[key] : undefined;
    if (isObj(child) && isObj(known)) {
      const inner = diff(child, known);
      if (Object.keys(inner).length > 0) out[key] = inner;
    } else if (!sameJson(child, known)) {
      out[key] = child;
    }
  }
  return out;
}

/** True when defaultCrew names a preset that exists. Job creation reads crewPresets[defaultCrew]. */
function hasDefaultCrew(settings) {
  return Object.hasOwn(settings.crewPresets, settings.defaultCrew) && isObj(settings.crewPresets[settings.defaultCrew]);
}

/** Write a small text file so that a crash leaves either the old or the new content. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      if (fd !== null) fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
    } catch { /* report the first error, not the cleanup */ }
    throw err;
  }
}

/**
 * Owner settings: DEFAULT_SETTINGS deep-merged with config/settings.json.
 * The file holds only what differs from the defaults, so a later change of a default
 * still reaches the owner. Unknown keys are kept. A corrupt file is moved to
 * settings.json.bak and the defaults are used.
 * @param {{ configDir: string, log?: (level: string, msg: string, data?: object) => void }} deps
 * @returns {{ get(): object, update(patch: object): object, onChange(fn: Function): () => void }}
 *   get() and update() return a private copy of the settings. update() deep merges the
 *   patch, saves atomically, then calls each onChange listener with (settings, previous).
 *   It throws an error with status 400 for a bad patch: a wrong type for a known key, or a
 *   value outside the contract (auth.<lab>: null | 'apikey'; authAck.<lab>: null |
 *   { mode: 'apikey', ts }; selfTest.<lab>: null | { version: string|null, ok, core?: [check], advisory?: [check], ts }; oss: { engine, baseUrl, standIn }; budgetUsd: null
 *   or a number >= 0; safety: 'sandboxed' | 'trusting'; thrift: 0..1; pairing: 'costly' |
 *   'M+L' | 'all'; presence: 'here' | 'away'; defaultCrew: the name of a crew preset). The
 *   same values in the file are ignored with a warning. onChange returns an unsubscribe function.
 */
export function createSettings({ configDir, log } = {}) {
  if (!configDir) throw new Error('createSettings needs configDir');
  const say = safeLog(log);
  const file = path.join(configDir, 'settings.json');
  const listeners = new Set();
  const pending = []; // changes that wait for their listener calls
  let notifying = false;
  let current = load();

  function load() {
    let saved = {};
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') say('warn', `settings: cannot read ${file}, using defaults`, { error: err.message });
    }
    if (text !== null) {
      try {
        saved = cloneJson(JSON.parse(text.replace(/^\uFEFF/, ''))); // some editors add a byte order mark
        if (!isObj(saved)) throw new Error('settings file must hold a JSON object');
      } catch (err) {
        saved = {};
        let kept = null;
        try {
          fs.renameSync(file, `${file}.bak`);
          kept = `${file}.bak`;
        } catch { /* the warning below says that no copy was kept */ }
        say('warn', 'settings: file is corrupt, using defaults', { file, kept, error: err.message });
      }
    }
    const skip = (at, wanted) => say('warn', `settings: ignored ${at} from the file (must be ${wanted})`);
    const loaded = merge(DEFAULT_SETTINGS, saved, DEFAULT_SETTINGS, '', skip);
    if (!hasDefaultCrew(loaded)) {
      skip('defaultCrew', 'the name of a crew preset');
      loaded.defaultCrew = DEFAULT_SETTINGS.defaultCrew;
    }
    // Contract 14b, "Auth choice on record": there is no migration rule. A file with an auth mode
    // and no authAck loads with authAck null for that lab, and load() never writes the file.
    return loaded;
  }

  /** The text of settings.json: only what differs from the defaults. */
  function fileText(settings) {
    return `${JSON.stringify(diff(settings, DEFAULT_SETTINGS), null, 2)}\n`;
  }

  function get() {
    return copy(current); // callers may change their copy, never ours
  }

  function update(patch) {
    const reject = (message) => {
      throw Object.assign(new Error(message), { status: 400 });
    };
    let clean;
    try {
      clean = cloneJson(patch); // private copy: the caller's object is not kept
    } catch {
      reject('settings patch must be plain JSON');
    }
    if (!isObj(clean)) reject('settings patch must be an object');
    const next = merge(current, clean, DEFAULT_SETTINGS, '', (at, wanted) => reject(`settings.${at} must be ${wanted}`));
    if (!hasDefaultCrew(next)) reject('settings.defaultCrew must name a crew preset');
    if (sameJson(next, current)) return get();
    writeAtomic(file, fileText(next)); // throws on a disk error: memory and file stay in step
    const previous = current;
    current = next;
    notify(next, previous);
    return get();
  }

  /** Call the listeners in change order, also when a listener calls update() itself. */
  function notify(now, previous) {
    pending.push([now, previous]);
    if (notifying) return;
    notifying = true;
    try {
      while (pending.length > 0) {
        const [settings, before] = pending.shift();
        for (const fn of [...listeners]) {
          if (!listeners.has(fn)) continue; // unsubscribed by an earlier listener
          try {
            fn(copy(settings), copy(before));
          } catch (err) {
            say('error', 'settings: onChange listener failed', { error: err?.message ?? String(err) });
          }
        }
      }
    } finally {
      notifying = false;
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange needs a function');
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  return { get, update, onChange };
}
