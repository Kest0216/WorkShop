// WorkShop secrets: the API keys of the agent CLIs.
//
// Values live in the macOS Keychain (backend 'keychain') or in a private JSON file (backend 'file').
// Only metadata (label, env var name, last 4 characters) is kept in <dataDir>/keys-meta.json.
// A value never appears in a process argument list, in a log line or in an error message.
//
// The list (keys-meta.json) and the key store are two places, so every step can fail between them. The rules:
// - A value is never stored under an id that the list does not show: a new custom key gets its row first.
// - After a save or a remove that failed, the row says what the key store holds, as far as anyone can tell.
// - A check of the key store that failed is repeated by a later list(). A read that contradicts a row makes
//   the next list() look again. So the list also follows changes made outside the hub.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

/** Keys that are always listed, set or not. Their env var is fixed. */
const KNOWN = new Map([
  ['anthropic', { label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' }],
  ['gemini', { label: 'Google Gemini', envVar: 'GEMINI_API_KEY' }],
  ['openai', { label: 'OpenAI', envVar: 'OPENAI_API_KEY' }],
  ['typesafe', { label: 'TypeSafe (Jev)', envVar: 'TYPESAFE_API_KEY' }], // the Jev decider (section 11b); no agent CLI
  ['oss', { label: 'Open-Source Runtime Bearer Token (optional)', envVar: 'OSS_API_KEY' }],
]);

/** The key each provider uses. `typesafe` is not here: no agent CLI gets it. */
const PROVIDER_KEY = new Map([['claude', 'anthropic'], ['gemini', 'gemini'], ['openai', 'openai'], ['oss', 'oss']]);

const MAX_VALUE_CHARS = 4096;
const MAX_LABEL_CHARS = 60;
const MAX_CUSTOM_KEYS = 50;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // a Node timer turns a longer delay into 1 ms
// A check of the key store that failed is repeated by list(): first after 10 times the time the failed check
// took, then after twice the last pause.
const RECHECK_MIN_MS = 500;
const RECHECK_MAX_MS = 5 * 60_000;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Names that the system, the dynamic loader, Node or WorkShop itself read. A key must never replace them.
const RESERVED_ENV_RE = new RegExp('^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TERM|LANG|LC_ALL|IFS'
  + '|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|(DYLD|WORKSHOP)_.*)$');
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
// Line breaks, control characters, invisible format characters and broken surrogate pairs.
const CONTROL_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const TEMP_RE = /^keys(?:-meta)?\.json\.(\d+)\.[0-9a-f]{8}\.tmp$/; // group 1: the pid of the writer
const QUOTES = { '"': '"', "'": "'", '`': '`', '\u201c': '\u201d', '\u2018': '\u2019' };

// Keychain facts, measured on macOS 26.4:
// - `security -i` reads commands from stdin in 4096-byte chunks. A longer line is cut in two: the tool then
//   stores a damaged value and prints the rest of the line on stderr. So a command line stays below that
//   size, and stderr of a save is never used.
// - `find-generic-password -w` prints hex instead of text when the password holds any byte outside printable
//   ASCII, and the two cannot be told apart. So only printable ASCII is stored: other values (and plain
//   values that start with the marker) are stored as marker + base64url.
const MAX_LINE_BYTES = 4000;
const KEYCHAIN_NOT_FOUND = 44;
const KEYCHAIN_EXIT = {
  36: 'it is locked or needs you to answer a prompt',
  51: 'it refused access',
  128: 'the request was cancelled',
};
const ARMOR = 'workshop-b64:';
const armor = (value) =>
  /^[\x20-\x7e]+$/.test(value) && !value.startsWith(ARMOR) ? value : ARMOR + Buffer.from(value).toString('base64url');
const unarmor = (stored) =>
  stored.startsWith(ARMOR) ? Buffer.from(stored.slice(ARMOR.length), 'base64url').toString() : stored;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOrNull = (v, maxChars) => (typeof v === 'string' && v && v.length <= maxChars ? v : null);
const validEnvVar = (name) => typeof name === 'string' && ENV_RE.test(name) && !RESERVED_ENV_RE.test(name);
const hintOf = (value) => (value.length < 12 ? 'set' : Array.from(value).slice(-4).join(''));

/** An error the HTTP layer can show as is: a plain message and a status. It never holds a secret value. */
function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Gives a function that runs async tasks one at a time, in call order. A task that fails does not stop the next. */
function serialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

function checkId(id) {
  if (typeof id === 'string' && ID_RE.test(id)) return id;
  throw fail('A key id must be 1 to 40 lowercase letters, digits or dashes, and start with a letter or digit.');
}

/** Trims whitespace and quotes pasted by accident, then validates. Errors never echo the value. */
function cleanValue(raw) {
  if (typeof raw !== 'string') throw fail('The key must be text.');
  let value = raw.trim();
  for (let layer = 0; layer < 3 && value.length >= 2 && QUOTES[value[0]] === value.at(-1); layer++) {
    value = value.slice(1, -1).trim();
  }
  if (!value) throw fail('The key is empty.');
  if (value.length > MAX_VALUE_CHARS) throw fail(`The key is too long (max ${MAX_VALUE_CHARS} characters).`);
  if (CONTROL_RE.test(value)) {
    throw fail('The key contains a line break or another control or invisible character. Paste it as one line.');
  }
  return value;
}

function cleanLabel(label, fallback) {
  if (label === undefined || label === null) return fallback;
  if (typeof label !== 'string') throw fail('The label must be text.');
  const text = label.trim();
  if (text.length > MAX_LABEL_CHARS || CONTROL_RE.test(text)) {
    throw fail(`The label must be one line of at most ${MAX_LABEL_CHARS} characters.`);
  }
  return text || fallback;
}

/**
 * Reads a JSON object file. A missing file gives {}. A corrupt file is kept as <file>.bak and gives {}.
 * A folder in its place is refused. With `privateOnly`, a file that group or others can access is refused.
 */
async function readJsonObject(file, { say, privateOnly = false }) {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let text;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw fail(`${file} is not a file. Move it away, then try again.`, 500);
    if (privateOnly && stats.mode & 0o077) {
      const octal = (stats.mode & 0o777).toString(8).padStart(3, '0');
      throw fail(`${file} is open to other users (mode ${octal}). Run: chmod 600 "${file}"`, 500);
    }
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  try {
    const data = JSON.parse(text);
    if (isRecord(data)) return data;
  } catch { /* corrupt: handled below */ }
  const kept = await rename(file, `${file}.bak`).then(() => true, () => false);
  say('warn', `secrets: ${basename(file)} was corrupt; started clean`, { copy: kept ? `${basename(file)}.bak` : null });
  return {};
}

/** Writes a file atomically (temp file in the same folder, then rename) with mode 0600. */
async function writePrivate(file, text) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 }); // a folder made here is private (section 14)
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Key store in <dataDir>/keys.json. For tests, or when the owner prefers a file to the Keychain. */
function fileStore({ file, say }) {
  // One file operation at a time. A read moves a corrupt keys.json to .bak; if that could cross a save, it
  // would move away the file that the save just wrote.
  const serial = serialQueue();
  const read = async () => {
    const data = await readJsonObject(file, { say, privateOnly: true });
    return new Map(Object.entries(data).filter(([id, value]) => ID_RE.test(id) && typeof value === 'string' && value));
  };
  const write = (keys) => writePrivate(file, `${JSON.stringify(Object.fromEntries(keys), null, 2)}\n`);
  return {
    detail: `File ${file} (plain text, mode 0600: only your macOS user can read it)`,
    has: (id) => serial(async () => (await read()).has(id)),
    get: (id) => serial(async () => (await read()).get(id) ?? null),
    set: (id, value) => serial(async () => {
      const keys = await read();
      keys.set(id, value);
      await write(keys);
    }),
    remove: (id) => serial(async () => {
      const keys = await read();
      const had = keys.delete(id);
      if (had) await write(keys);
      return had;
    }),
  };
}

/** Key store in the macOS Keychain: one generic-password item per key, service = app, account = key id. */
function keychainStore({ service, securityPath, timeoutMs, say }) {
  /**
   * Runs the security tool. Resolves to { code, stdout, note } and never rejects.
   * code: 0, an exit code, 'TIMEOUT', or a spawn error code such as 'ENOENT'.
   */
  const run = (args, input = '') => new Promise((done) => {
    let child;
    try {
      child = execFile(
        securityPath, args,
        { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => done({
          code: !err ? 0 : err.killed && err.code == null ? 'TIMEOUT' : err.code ?? 'KILLED',
          stdout: String(stdout ?? ''),
          // stderr is safe to log only when no value was sent: a failed save can echo its input there.
          note: input ? '' : String(stderr ?? '').split('\n')[0].slice(0, 200),
        }),
      );
    } catch (err) {
      done({ code: err.code ?? 'SPAWN', stdout: '', note: '' });
      return;
    }
    child.stdin?.on('error', () => {}); // the tool may exit without reading its input
    child.stdin?.end(input);
  });

  /** The error for a call that failed. `reason` is the part of the message that says why. */
  const problem = (action, { code, note }) => {
    say('warn', 'secrets: Keychain command failed', { action, code, note });
    const reason = code === 'TIMEOUT'
      ? `it did not answer within ${timeoutMs / 1000} s (it may be locked or waiting for you to answer a prompt)`
      : typeof code !== 'number'
        ? `${securityPath} could not be run (${code})`
        : KEYCHAIN_EXIT[code] ?? `the security tool failed with exit code ${code}`;
    return Object.assign(fail(`The macOS Keychain is not available: ${reason}.`, 503), { reason });
  };

  /** For a call that writes: it was killed before it answered, so nobody knows what the Keychain holds now. */
  const unknownIfKilled = ({ code }) => (code === 'TIMEOUT' || code === 'KILLED' ? { left: 'unknown' } : null);

  /** True when the item exists. Reads attributes only, never the value. */
  async function has(id) {
    const result = await run(['find-generic-password', '-a', id, '-s', service]);
    if (result.code === 0 || result.code === KEYCHAIN_NOT_FOUND) return result.code === 0;
    throw problem('find', result);
  }

  async function get(id) {
    const result = await run(['find-generic-password', '-a', id, '-s', service, '-w']);
    if (result.code === KEYCHAIN_NOT_FOUND) return null;
    if (result.code !== 0) throw problem('read', result);
    return unarmor(result.stdout.replace(/\n$/, '')) || null;
  }

  async function remove(id) {
    const result = await run(['delete-generic-password', '-a', id, '-s', service]);
    if (result.code === 0 || result.code === KEYCHAIN_NOT_FOUND) return result.code === 0;
    throw Object.assign(problem('delete', result), unknownIfKilled(result));
  }

  /**
   * Saves a value and reads it back. An error says in `left` what the Keychain holds now, so that the list
   * can follow: 'value' (one that could not be checked), 'none' or 'unknown'. Without `left`, nothing changed.
   */
  async function set(id, value) {
    // The command goes to `security -i` on stdin, so the value is never in an argument list.
    // -U updates an item that exists. The value travels as hex (-X), so nothing needs quoting.
    // A value too long for that travels as quoted text (-w), which takes half the room.
    const stored = armor(value);
    const command = (valueOption) =>
      `add-generic-password -U -a ${id} -s ${service} -l "${service} ${id}" ${valueOption}\n`;
    let line = command(`-X ${Buffer.from(stored).toString('hex')}`);
    if (line.length > MAX_LINE_BYTES) line = command(`-w "${stored.replace(/[\\"]/g, '\\$&')}"`);
    if (line.length > MAX_LINE_BYTES) {
      throw fail('The key is too long for the macOS Keychain. It holds about 3800 characters '
        + '(fewer with quotes, backslashes or non-ASCII text).');
    }
    const result = await run(['-i'], line);
    if (result.code !== 0) throw Object.assign(problem('save', result), unknownIfKilled(result));

    // Read back: catches a cut or changed value before anyone relies on it.
    const readBack = await get(id).catch((err) => err);
    if (readBack === value) return;
    if (readBack instanceof Error) {
      const message = `The key was stored in the macOS Keychain, but it could not be read back: ${readBack.reason}.`;
      throw Object.assign(fail(message, 503), { left: 'value' });
    }
    const gone = await remove(id).then(() => true, () => false);
    const message = gone
      ? 'The macOS Keychain did not store the key correctly. Nothing was saved, and the key is not set now.'
      : 'The macOS Keychain did not store the key correctly, and the damaged value could not be removed. '
        + 'Remove the key, then save it again.';
    throw Object.assign(fail(message, 503), { left: gone ? 'none' : 'value' });
  }

  const detail = `macOS Keychain: one "${service}" password item per key (account = key id)`;
  return { detail, has, get, set, remove };
}

/**
 * One row of `list()`. It never holds the value.
 * @typedef {object} KeyEntry
 * @property {string} id
 * @property {string} label
 * @property {string} envVar name of the env var that carries the value
 * @property {boolean} set true while the key store holds a value (as the last check or read of the store showed)
 * @property {string|null} hint last 4 characters of the value, "set" for a value that is shorter than 12
 *   characters or could not be read, null when not set
 * @property {number|null} updatedAt time of the last save (epoch ms), null when not set
 */

/**
 * Creates the secrets module. Every method but `backendInfo` returns a Promise.
 * Errors carry `status` for the HTTP layer: 400 bad input, 503 Keychain not available, 500 a data file that
 * cannot be used. A message never holds a value.
 *
 * @param {object} options
 * @param {'keychain'|'file'} options.backend where values are stored (required, so a test cannot reach the
 *   real Keychain by leaving it out)
 * @param {string} options.dataDir folder for keys-meta.json (and keys.json with the file backend)
 * @param {string} [options.service='WorkShop'] Keychain service name
 * @param {(level: string, msg: string, data?: object) => void} [options.log] logger; never receives a value
 * @param {string} [options.securityPath='/usr/bin/security'] the Keychain tool (tests inject a fake)
 * @param {number} [options.timeoutMs=10000] time limit of every Keychain call
 * @param {{ add(value: string): void, remove(value: string): void }} [options.redactor] exact-value redactor
 *   (server/redact.js). It gets every value this module stores or reads, and loses a value when no key holds
 *   it any more. primeRedactor() loads every stored value at boot.
 * @returns {{
 *   list(): Promise<KeyEntry[]>,
 *   set(id: string, value: string, options?: {label?: string, envVar?: string}): Promise<KeyEntry>,
 *   get(id: string): Promise<string|null>,
 *   remove(id: string): Promise<boolean>,
 *   envFor(providerId: string): Promise<Record<string, string>>,
 *   backendInfo(): {backend: 'keychain'|'file', detail: string},
 *   primeRedactor(): Promise<number>,
 * }}
 */
export function createSecrets({
  backend, dataDir, service = 'WorkShop', log, redactor,
  securityPath = '/usr/bin/security', timeoutMs = 10_000,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('createSecrets: dataDir is required');
  if (backend !== 'keychain' && backend !== 'file') {
    throw new Error("createSecrets: backend must be 'keychain' or 'file'");
  }
  if (redactor != null && (typeof redactor.add !== 'function' || typeof redactor.remove !== 'function')) {
    throw new Error('createSecrets: redactor must have add() and remove()');
  }
  if (backend === 'keychain' && !(typeof service === 'string' && SERVICE_RE.test(service))) {
    throw new Error('createSecrets: service must be 1 to 32 letters, digits, dots, dashes or underscores');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('createSecrets: timeoutMs must be a positive whole number of milliseconds '
      + `(at most ${MAX_TIMEOUT_MS})`);
  }

  const say = (level, msg, data) => {
    try { log?.(level, msg, data); } catch { /* a broken logger must not break key handling */ }
  };
  const dir = resolve(dataDir);
  const metaFile = join(dir, 'keys-meta.json');
  const store = backend === 'file'
    ? fileStore({ file: join(dir, 'keys.json'), say })
    : keychainStore({ service, securityPath, timeoutMs, say });

  /**
   * id -> { label, envVar, hint, updatedAt }. `hint` is null while the key store holds no value for the id.
   * Known ids need no entry. A custom key exists as long as it has one.
   */
  const meta = new Map();
  /** Runs writers one at a time, so the key store and the metadata stay in step. */
  const exclusive = serialQueue();
  let loading = null;
  let loaded = false;
  /** While the last check of the key store failed: the time (performance.now()) from which list() may try again. */
  let recheckAt = null;
  let recheckPause = 0;
  /** Ids whose row a read contradicted: the key store changed behind the hub's back. list() settles them. */
  const doubted = new Set();

  // ---- redactor (section 14) ----
  /** id -> the value this module gave the redactor for that id. Memory only, like the redactor. */
  const held = new Map();
  /** Call the redactor. A broken redactor must not break key handling; the warning never holds the value. */
  const tell = (method, value) => {
    if (!redactor) return;
    try {
      redactor[method](value);
    } catch (err) {
      // The redactor's own message may quote what it got: the value is cut out before the warning goes out.
      const text = String(err?.message ?? err);
      const reason = (typeof value === 'string' && value ? text.split(value).join('[redacted]') : text).slice(0, 200);
      say('warn', `secrets: redactor.${method} failed`, { reason });
    }
  };
  /**
   * The key store holds `value` for `id` now (null: nothing). The redactor loses the old value of the id
   * (only when no other key holds it) and gets the new one, in one synchronous step.
   */
  const track = (id, value) => {
    const old = held.get(id);
    if (old === value || (old === undefined && value === null)) return;
    if (value === null) held.delete(id);
    else held.set(id, value);
    if (old !== undefined && ![...held.values()].includes(old)) tell('remove', old);
    if (value !== null) tell('add', value);
  };

  const saveMeta =() => writePrivate(metaFile, `${JSON.stringify(Object.fromEntries(meta), null, 2)}\n`);
  const warnMeta = (err) => say('warn', 'secrets: could not save keys-meta.json', { reason: err.message });
  /** The error for a keys-meta.json that cannot be written. `outcome` says what happened to the key itself. */
  const metaProblem = (err, outcome) => {
    warnMeta(err);
    return fail(`${outcome} keys-meta.json could not be written (${err.code ?? 'unknown error'}).`, 500);
  };
  const customIds = () => [...meta.keys()].filter((id) => !KNOWN.has(id)).sort();
  const listedIds = () => [...KNOWN.keys(), ...customIds()];
  const entryOf = (id) => {
    const { label, envVar, hint = null, updatedAt = null } = meta.get(id) ?? KNOWN.get(id);
    return { id, label, envVar, set: hint !== null, hint, updatedAt };
  };

  /** First load: remove temp files a crash left behind, read the metadata, then match it with the key store. */
  async function load() {
    meta.clear();
    // A temp file of this process is a save that runs right now (a second instance on this folder), not a crash.
    const stale = (await readdir(dir).catch(() => [])).filter((name) => {
      const pid = TEMP_RE.exec(name)?.[1];
      return pid !== undefined && Number(pid) !== process.pid;
    });
    await Promise.all(stale.map((name) => rm(join(dir, name), { force: true }).catch(() => {})));

    const taken = new Set([...KNOWN.values()].map((known) => known.envVar));
    for (const [id, raw] of Object.entries(await readJsonObject(metaFile, { say }))) {
      const known = KNOWN.get(id);
      const envVar = known ? known.envVar : raw?.envVar;
      if (!ID_RE.test(id) || !isRecord(raw) || !validEnvVar(envVar) || (!known && taken.has(envVar))) {
        say('warn', 'secrets: dropped a broken entry of keys-meta.json');
        continue;
      }
      taken.add(envVar);
      const hint = textOrNull(raw.hint, 8);
      meta.set(id, {
        label: textOrNull(raw.label, MAX_LABEL_CHARS) ?? known?.label ?? id,
        envVar,
        hint,
        updatedAt: hint && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
      });
    }
    await reconcile();
    loaded = true;
  }

  /**
   * Makes "set" match the key store. Best effort: when the store cannot be checked, the saved metadata stays
   * and list() tries again later. A value is read only to build a hint that is missing, and only until the
   * first read that fails (each could wait for a prompt). A key whose value is gone keeps its label and
   * env var (as "not set"), so a custom key survives a switch of backend.
   */
  async function reconcile() {
    const started = performance.now();
    let changed = false;
    let readable = true;
    try {
      for (const id of listedIds()) {
        const entry = meta.get(id);
        const present = await store.has(id);
        if (present === Boolean(entry?.hint)) continue;
        if (present) {
          const value = readable ? await store.get(id).catch(() => { readable = false; }) : undefined;
          if (value === null) continue; // an item without a value is as good as no item
          if (value !== undefined) track(id, value);
          const hint = value === undefined ? 'set' : hintOf(value);
          meta.set(id, { ...(entry ?? KNOWN.get(id)), hint, updatedAt: Date.now() });
        } else {
          meta.set(id, { ...entry, hint: null, updatedAt: null });
        }
        changed = true;
      }
      recheckAt = null;
      recheckPause = 0;
    } catch (err) {
      if (recheckAt === null) {
        say('warn', 'secrets: could not check the key store; using the saved metadata', { reason: err.message });
      }
      // No hurry with the next try: a check that waited for a timeout must not hold up every list.
      const took = performance.now() - started;
      recheckPause = Math.min(Math.max(2 * recheckPause, 10 * took, RECHECK_MIN_MS), RECHECK_MAX_MS);
      recheckAt = performance.now() + recheckPause;
    }
    if (changed) await saveMeta().catch(warnMeta);
  }

  const ready = () => (loading ??= load().catch((err) => {
    loading = null; // try again on the next call
    throw err;
  }));

  const recheckDue = () => recheckAt !== null && performance.now() >= recheckAt;

  /**
   * Runs in the write queue. Repeats a check of the key store that failed, and settles the rows that a read
   * contradicted. It never rejects.
   */
  async function refresh() {
    if (recheckDue()) await reconcile();
    let changed = false;
    for (const id of [...doubted]) {
      doubted.delete(id);
      const entry = meta.get(id);
      if (!entry && !KNOWN.has(id)) continue; // removed in the meantime
      let value;
      try {
        value = await store.get(id);
      } catch {
        doubted.clear(); // the store does not answer: do not wait once per row
        break;
      }
      if (value !== null) track(id, value);
      if ((value !== null) === Boolean(entry?.hint)) continue;
      meta.set(id, value === null
        ? { ...entry, hint: null, updatedAt: null }
        : { ...(entry ?? KNOWN.get(id)), hint: hintOf(value), updatedAt: Date.now() });
      changed = true;
    }
    if (changed) await saveMeta().catch(warnMeta);
  }

  /**
   * Lists the known keys and the custom keys. Metadata only: never a value. It calls the key store only on
   * the first load, after a check that failed, and after a read that did not match the list.
   */
  async function list() {
    await ready();
    if (doubted.size || recheckDue()) await exclusive(refresh);
    return listedIds().map(entryOf);
  }

  /**
   * The env var a key uses after `set`. A known key has a fixed one. A custom key keeps its own unless asked.
   * A new custom key without one gets the usual name for its id: "my-tool" gives MY_TOOL_API_KEY.
   */
  function chooseEnvVar(id, wanted) {
    const known = KNOWN.get(id);
    let name = wanted;
    if (wanted == null || wanted === '') { // not given (a form may send its empty field)
      const own = known?.envVar ?? meta.get(id)?.envVar;
      if (own) return own;
      name = `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      if (!validEnvVar(name)) throw fail('A custom key needs an environment variable name, for example MY_API_KEY.');
    } else if (known) {
      if (wanted !== known.envVar) throw fail(`The key "${id}" always uses ${known.envVar}.`);
      return known.envVar;
    } else if (!validEnvVar(wanted)) {
      throw fail('The environment variable must look like MY_API_KEY (capital letters, digits, underscores) '
        + 'and must not be a system variable.');
    }
    const clash = listedIds().find((other) => other !== id && entryOf(other).envVar === name);
    if (clash) throw fail(`That environment variable is already used by the key "${clash}".`);
    return name;
  }

  /**
   * Stores a key and resolves to its list entry. `label` and `envVar` are optional (see chooseEnvVar).
   * Rejects with a plain message: status 400 for bad input, 503 when the Keychain is not available, 500 when
   * keys-meta.json cannot be written. After a rejection the list still says what the key store holds.
   */
  const set = (id, value, options) => exclusive(async () => {
    checkId(id);
    const secret = cleanValue(value);
    await ready();
    const old = meta.get(id);
    const envVar = chooseEnvVar(id, options?.envVar);
    const fresh = !old && !KNOWN.has(id);
    if (fresh && customIds().length >= MAX_CUSTOM_KEYS) {
      throw fail(`There are too many custom keys (max ${MAX_CUSTOM_KEYS}). Remove one first.`);
    }
    const label = cleanLabel(options?.label, old?.label ?? KNOWN.get(id)?.label ?? id);

    // A new custom key gets its row on disk before its value is stored. The id is the only way to find the
    // value again, so a crash or a failed write must never leave a value that no list shows.
    if (fresh) {
      meta.set(id, { label, envVar, hint: null, updatedAt: null });
      await saveMeta().catch((err) => {
        meta.delete(id);
        throw metaProblem(err, 'Nothing was saved:');
      });
    }
    try {
      await store.set(id, secret);
    } catch (err) {
      // Make the row say what the key store holds now. `err.left` is 'value' (a value that could not be
      // checked), 'none', 'unknown', or not given (nothing changed).
      // The redactor errs on the safe side: a value that may be stored is redacted, the old one stays.
      if (err.left === 'value' || err.left === 'unknown') tell('add', secret);
      let changed = true;
      if (err.left === 'value') {
        meta.set(id, { ...(meta.get(id) ?? KNOWN.get(id)), hint: 'set', updatedAt: Date.now() });
      } else if (err.left === 'unknown') {
        doubted.add(id); // the row stays (also a new one), and the next list() looks at the store again
        changed = false;
      } else if (fresh) {
        meta.delete(id);
      } else if (err.left === 'none' && old?.hint) {
        meta.set(id, { ...old, hint: null, updatedAt: null });
      } else {
        changed = false;
      }
      if (changed) await saveMeta().catch(warnMeta);
      throw err;
    }
    meta.set(id, { label, envVar, hint: hintOf(secret), updatedAt: Date.now() });
    doubted.delete(id);
    track(id, secret);
    say('info', 'secrets: key saved', { id });
    // If this write fails, the list in memory is right, and the next start rebuilds "set" from the key store.
    await saveMeta().catch((err) => { throw metaProblem(err, 'The key is stored, but'); });
    return entryOf(id);
  });

  /** Reads a value from the key store. When the list says otherwise, the next list() settles that row. */
  async function read(id) {
    const value = await store.get(id);
    const entry = meta.get(id);
    if (loaded && (entry || KNOWN.has(id)) && (value !== null) !== Boolean(entry?.hint)) doubted.add(id);
    if (value !== null) track(id, value); // a value that reaches a caller is always redacted
    return value;
  }

  /** Reads a key value. Resolves to null when the key is not set (or the id is not valid). */
  async function get(id) {
    return typeof id === 'string' && ID_RE.test(id) ? read(id) : null;
  }

  /** Deletes a key and its metadata. Resolves to true when there was something to delete. Known ids stay listed. */
  const remove = (id) => exclusive(async () => {
    checkId(id);
    await ready();
    const stored = await store.remove(id).catch((err) => {
      if (err.left === 'unknown') doubted.add(id); // the next list() looks at the store again
      throw err;
    });
    const entry = meta.get(id);
    doubted.delete(id);
    track(id, null);
    if (entry) {
      meta.delete(id);
      await saveMeta().catch((err) => {
        meta.set(id, { ...entry, hint: null, updatedAt: null }); // the row that the next start would show
        throw metaProblem(err, 'The key was removed, but');
      });
    }
    if (stored || entry) say('info', 'secrets: key removed', { id });
    return stored || Boolean(entry);
  });

  /** Env vars for one provider's CLI, for example { ANTHROPIC_API_KEY: value }. {} when the key is not set. */
  async function envFor(providerId) {
    const id = PROVIDER_KEY.get(providerId);
    const value = id ? await read(id) : null;
    return value === null ? {} : { [KNOWN.get(id).envVar]: value };
  }

  /** Tells the UI where the keys are stored. */
  const backendInfo = () => ({ backend, detail: store.detail });

  /**
   * Boot step (section 14): gives the redactor every value the key store holds, so index.js needs no loop
   * over get(). Runs in the write queue. Resolves to the number of keys whose value was loaded. When the key
   * store stops answering it warns (ids only, never a value) and resolves with what it loaded so far; a key
   * that is read later still reaches the redactor then. Without a redactor it does nothing.
   */
  const primeRedactor = () => exclusive(async () => {
    if (!redactor) return 0;
    await ready();
    let loadedValues = 0;
    for (const id of listedIds()) {
      if (!meta.get(id)?.hint) continue; // not set, as far as the list knows
      let value;
      try {
        value = await store.get(id);
      } catch (err) {
        say('warn', 'secrets: could not load the stored keys into the redactor', { id, reason: err.message });
        break; // the store does not answer: do not wait once per key
      }
      if (value === null) {
        doubted.add(id); // the row says set, the store says no: the next list() settles it
        continue;
      }
      track(id, value);
      loadedValues += 1;
    }
    return loadedValues;
  });

  return { list, set, get, remove, envFor, backendInfo, primeRedactor };
}
