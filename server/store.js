// State snapshot, event bus and short ids. See docs/ARCHITECTURE.md section 5.
// Files in the data dir: state.json (the snapshot), events.jsonl (the audit log) and
// ids.json (the id counters, written at every nextId() so that a crash never repeats an id).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const STATE_VERSION = 1;
const KINDS = ['projects', 'jobs', 'tasks', 'agents', 'deliveries'];
const ID_PREFIX = { projects: 'P', jobs: 'J', tasks: 'T', agents: 'A', deliveries: 'D' };
const SEQ_SAVE_EVERY = 500; // save when the seq on disk lags this far behind
const SEQ_RESTART_GAP = 1000; // seq jump on load, so an event id is never used twice (also after a crash)
const MAX_AUDIT_BACKLOG = 16 * 1024 * 1024; // chars of events.jsonl lines that may wait for a slow disk
const MAX_SYNC_DELIVERIES = 10000; // events delivered in one go before the bus yields to the event loop
const MAX_RETRY_MS = 30000;
const STALE_TMP_MS = 60000;
const LOG_EVERY_MS = 10000; // a failure that repeats is logged at most this often
const DIR_MODE = 0o700; // the data dir and its files hold the owner's work: no other user of this Mac may read them
const FILE_MODE = 0o600;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCounter = (key, n) => /^[A-Z]{1,4}$/.test(key) && Number.isSafeInteger(n) && n >= 0;
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/** Wrap the injected logger so that a missing or broken logger never breaks the store. */
function safeLog(log) {
  if (typeof log !== 'function') return () => {};
  return (level, msg, data) => {
    try {
      log(level, msg, data);
    } catch { /* logging must never throw */ }
  };
}

/**
 * A logger for failures that can repeat fast: at most one line per `ms` for each key.
 * `data` may be a function, so that costly details are built only for a line that goes out.
 * Returns true when the line went out.
 */
function createQuietLog(say, ms) {
  const last = new Map();
  return (key, level, msg, data) => {
    const now = Date.now();
    const before = last.get(key);
    if (before !== undefined && now >= before && now - before < ms) return false;
    last.set(key, now);
    say(level, msg, typeof data === 'function' ? data() : data);
    return true;
  };
}

function freshState() {
  return { v: STATE_VERSION, seq: 0, counters: { P: 0, J: 0, T: 0, A: 0, D: 0 }, projects: {}, jobs: {}, tasks: {}, agents: {}, deliveries: {} };
}

/** Check a parsed state.json and repair what is safe to repair. Throws when it is not usable. */
function normalizeState(raw) {
  if (!isObj(raw)) throw new Error('state.json must hold a JSON object');
  const state = { ...freshState(), ...raw, v: STATE_VERSION }; // unknown top-level keys are kept
  if (!Number.isSafeInteger(state.seq) || state.seq < 0) state.seq = 0;
  state.counters = freshState().counters;
  if (isObj(raw.counters)) {
    for (const [key, n] of Object.entries(raw.counters)) {
      if (isCounter(key, n)) state.counters[key] = n;
    }
  }
  for (const kind of KINDS) {
    const prefix = ID_PREFIX[kind];
    if (!isObj(state[kind])) throw new Error(`state.${kind} must be an object keyed by id`);
    for (const [id, item] of Object.entries(state[kind])) {
      if (!isObj(item) || item.id !== id) throw new Error(`state.${kind}.${id} is not a valid item`);
      // A counter never falls behind an id that is in use.
      const match = /^([A-Z]+)(\d+)$/.exec(id);
      if (match && match[1] === prefix && Number(match[2]) > state.counters[prefix]) state.counters[prefix] = Number(match[2]);
    }
  }
  return state;
}

/** Read state.json. A missing file gives a clean state. A corrupt file is kept as state.json.bak. */
function loadState(file, say) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: freshState(), loaded: false };
    text = null;
    say('warn', 'store: cannot read state.json', { file, error: err.message });
  }
  try {
    if (text === null) throw new Error('state.json is not readable');
    const state = normalizeState(JSON.parse(text));
    state.seq += SEQ_RESTART_GAP;
    return { state, loaded: true };
  } catch (err) {
    let kept = null;
    try {
      fs.renameSync(file, `${file}.bak`);
      kept = `${file}.bak`;
    } catch { /* the warning below says that no copy was kept */ }
    say('warn', 'store: state.json is corrupt, starting clean', { file, kept, error: err.message });
    return { state: freshState(), loaded: false };
  }
}

/**
 * Read ids.json: the id counters as they were when the last id left the store.
 * They can be ahead of state.json (a crash before the save, or a corrupt state.json).
 * A missing or unusable file gives {}.
 */
function loadIds(file, say) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') say('warn', 'store: cannot read ids.json', { file, error: err.message });
    return {};
  }
  try {
    const raw = JSON.parse(text);
    if (!isObj(raw)) throw new Error('ids.json must hold a JSON object');
    return Object.fromEntries(Object.entries(raw).filter(([key, n]) => isCounter(key, n)));
  } catch (err) {
    say('warn', 'store: ids.json is corrupt, using the counters of state.json', { file, error: err.message });
    return {};
  }
}

/** Remove temp files that a crashed save left behind. Fresh ones may belong to a save in flight. */
function sweepTempFiles(dir, say) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^(state|ids)\.json\.(.+\.)?tmp$/.test(name)) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.rmSync(file, { force: true });
    }
  } catch (err) {
    say('debug', 'store: cannot clean old temp files', { error: err.message });
  }
}

/** Files of an older run may be readable by other users: make the ones that exist private. */
function makePrivate(files) {
  for (const file of files) {
    try {
      fs.chmodSync(file, FILE_MODE);
    } catch { /* no such file yet */ }
  }
}

/** Write a file so that a crash leaves either the old or the new content. */
async function writeAtomic(file, tmp, text) {
  const handle = await fsp.open(tmp, 'w', FILE_MODE);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

/**
 * JSON.stringify for a value that may hold cycles or BigInts: a reference back to an
 * ancestor is left out and a BigInt becomes a string. Only for the snapshot of a state
 * that a module damaged; the normal path is plain JSON.stringify.
 */
function stringifyLoose(value) {
  const ancestors = [];
  return JSON.stringify(value, function replace(key, child) {
    if (typeof child === 'bigint') return String(child);
    if (child === null || typeof child !== 'object') return child;
    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop(); // back to the holder of `child`
    if (ancestors.includes(child)) return undefined;
    ancestors.push(child);
    return child;
  });
}

/** Fixed-size buffer of the newest events, ordered by seq. */
function createRing(capacity) {
  const slots = new Array(capacity);
  let start = 0;
  let size = 0;
  const at = (i) => slots[(start + i) % capacity];
  return {
    get size() {
      return size;
    },
    push(event) {
      slots[(start + size) % capacity] = event;
      if (size < capacity) size += 1;
      else start = (start + 1) % capacity;
    },
    /** Events with a seq above `seq`, oldest first. */
    since(seq) {
      let lo = 0;
      let hi = size;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (at(mid).seq > seq) hi = mid;
        else lo = mid + 1;
      }
      const out = new Array(size - lo);
      for (let i = lo; i < size; i += 1) out[i - lo] = at(i);
      return out;
    },
  };
}

/**
 * Append-only audit log (events.jsonl). Lines are queued and written in order by one
 * writer at a time, in batches. When the file passes `maxBytes` it becomes events.1.jsonl.
 * A file that cannot be written loses its lines; that is logged through `quiet`, not per line.
 */
function createAuditLog({ dir, maxBytes, say, quiet }) {
  const file = path.join(dir, 'events.jsonl');
  const rotated = path.join(dir, 'events.1.jsonl');
  let queue = [];
  let queuedChars = 0;
  let dropped = 0; // lines refused because the backlog was full
  let lost = 0; // lines of failed writes since the last report of a good write
  let size = -1; // bytes in events.jsonl; -1 = not measured yet
  let writing = null;

  async function fileSize() {
    try {
      return (await fsp.stat(file)).size;
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  async function drain() {
    try {
      while (queue.length > 0) {
        const lines = queue.length;
        const data = queue.join('');
        queue = [];
        queuedChars = 0;
        let written = false;
        try {
          if (size < 0) size = await fileSize();
          await fsp.appendFile(file, data, { mode: FILE_MODE });
          written = true;
          size += Buffer.byteLength(data);
          if (size >= maxBytes) {
            await fsp.rename(file, rotated);
            size = 0;
          }
        } catch (err) {
          size = -1;
          if (!written) lost += lines;
          quiet('audit-write', 'error', written ? 'store: cannot rotate events.jsonl' : 'store: cannot write events.jsonl', { error: err.message, lost });
        }
        if (written && lost > 0 && quiet('audit-back', 'warn', 'store: events.jsonl works again, some events were not logged', { lost })) lost = 0;
        if (dropped > 0 && quiet('audit-drop', 'warn', 'store: events.jsonl could not keep up, events were not logged', { dropped })) dropped = 0;
      }
    } finally {
      writing = null;
    }
  }

  return {
    append(event) {
      let line;
      try {
        line = `${JSON.stringify(event)}\n`;
      } catch (err) {
        say('error', 'store: event has no JSON form, not logged', { type: event.type, seq: event.seq, error: firstLine(err) });
        return;
      }
      if (queuedChars > MAX_AUDIT_BACKLOG) {
        dropped += 1;
        return;
      }
      queue.push(line);
      queuedChars += line.length;
      if (writing === null) writing = drain();
    },
    /** Resolves when every queued line is on disk (or was reported as failed). */
    async flush() {
      while (writing !== null) await writing;
    },
  };
}

/**
 * The hub's state: one object saved atomically to <dataDir>/state.json, an event bus,
 * the audit log <dataDir>/events.jsonl and the id counters <dataDir>/ids.json.
 * @param {object} deps
 * @param {string} deps.dataDir folder for the files of the store (created when missing, mode 0700; files 0600)
 * @param {(level: string, msg: string, data?: object) => void} [deps.log]
 * @param {number} [deps.saveDelayMs=250] debounce of the state.json save
 * @param {number} [deps.ringSize=5000] events kept for eventsSince()
 * @param {number} [deps.eventsMaxBytes=20971520] size at which events.jsonl is rotated
 * @returns store: { state, nextId, put, patch, remove, get, list, emit, subscribe, eventsSince, flush, stats }
 */
export function createStore({ dataDir, log, saveDelayMs = 250, ringSize = 5000, eventsMaxBytes = 20 * 1024 * 1024 } = {}) {
  if (!dataDir) throw new Error('createStore needs dataDir');
  const say = safeLog(log);
  const quiet = createQuietLog(say, LOG_EVERY_MS);
  const stateFile = path.join(dataDir, 'state.json');
  const idsFile = path.join(dataDir, 'ids.json');
  // Own temp files per store: two stores on one folder (a test that reopens) never mix their writes.
  const tag = `${process.pid}.${randomBytes(4).toString('hex')}`;
  const tmpFile = `${stateFile}.${tag}.tmp`;
  const idsTmp = `${idsFile}.${tag}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true, mode: DIR_MODE });
  makePrivate([stateFile, idsFile, path.join(dataDir, 'events.jsonl'), path.join(dataDir, 'events.1.jsonl')]);
  sweepTempFiles(dataDir, say);
  const { state, loaded } = loadState(stateFile, say);
  // Ids that left the store but did not reach state.json (a crash, a corrupt file) stay used.
  let idsAhead = false;
  for (const [prefix, n] of Object.entries(loadIds(idsFile, say))) {
    if (n > (state.counters[prefix] ?? 0)) {
      state.counters[prefix] = n;
      idsAhead = true;
    }
  }
  const ring = createRing(ringSize);
  const audit = createAuditLog({ dir: dataDir, maxBytes: eventsMaxBytes, say, quiet });

  // ---- snapshot: debounced, one write at a time ----
  let dirty = false;
  let timer = null;
  let saving = null;
  let saves = 0;
  let retryMs = 0;
  let savedSeq = loaded ? state.seq - SEQ_RESTART_GAP : 0; // the seq that is on disk

  function arm(ms, background) {
    timer = setTimeout(() => {
      timer = null;
      startSave();
    }, ms);
    if (background) timer.unref(); // a retry must not keep the process alive
  }

  function scheduleSave() {
    dirty = true;
    if (timer === null && saving === null) arm(saveDelayMs, false);
  }

  /** Ids of the items that JSON.stringify cannot write: ['tasks.T1', ...], at most 20. */
  function itemsWithoutJson() {
    const bad = [];
    for (const kind of KINDS) {
      for (const [id, item] of Object.entries(state[kind])) {
        try {
          JSON.stringify(item);
        } catch {
          if (bad.push(`${kind}.${id}`) >= 20) return bad;
        }
      }
    }
    return bad;
  }

  /**
   * The state as JSON text. put() and patch() refuse items without a JSON form, but a module
   * can still damage a live item (a cycle, a BigInt). Then everything else is saved, and the
   * bad parts are left out: one bad item must not stop the saves of a hub that runs for days.
   */
  function snapshot() {
    const source = loadable();
    try {
      return JSON.stringify(source);
    } catch (err) {
      quiet('snapshot', 'error', 'store: the state has no JSON form, it is saved without the bad parts', () => ({ error: firstLine(err), items: itemsWithoutJson() }));
      return stringifyLoose(source);
    }
  }

  /**
   * The state in a form that loadState() accepts. The loader rejects the whole file when
   * one entry is not an object or does not hold its own key as id. A module can cause that
   * (it changes the id of a live item, or writes into a collection). The key is the
   * identity: such an item is saved with its key as id, an entry that is no item is left out.
   */
  function loadable() {
    const bad = [];
    for (const kind of KINDS) {
      for (const [key, item] of Object.entries(state[kind])) {
        if (!isObj(item) || item.id !== key) bad.push([kind, key]);
      }
    }
    if (bad.length === 0) return state;
    quiet('mismatch', 'error', 'store: an item does not match its id, it is saved under its key', { items: bad.slice(0, 20).map(([kind, key]) => `${kind}.${key}`) });
    const copy = { ...state };
    for (const [kind, key] of bad) {
      if (copy[kind] === state[kind]) copy[kind] = { ...state[kind] };
      if (isObj(copy[kind][key])) copy[kind][key] = { ...copy[kind][key], id: key };
      else delete copy[kind][key];
    }
    return copy;
  }

  async function writeState() {
    dirty = false;
    const seq = state.seq;
    try {
      await writeAtomic(stateFile, tmpFile, snapshot());
      savedSeq = seq;
      saves += 1;
      retryMs = 0;
    } catch (err) {
      dirty = true;
      retryMs = Math.min(retryMs * 2 || 1000, MAX_RETRY_MS);
      say('error', 'store: cannot save state.json', { error: err.message, retryMs });
    }
  }

  function startSave() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    saving = writeState().then(() => {
      saving = null;
      if (dirty && timer === null) arm(retryMs || saveDelayMs, retryMs > 0);
    });
    return saving;
  }

  /** Save now. Resolves when state.json and events.jsonl hold everything up to this call. Never rejects. */
  async function flush() {
    for (let round = 0; round < 4 && (saving !== null || dirty || state.seq !== savedSeq); round += 1) {
      await (saving ?? startSave());
    }
    await audit.flush();
  }

  // ---- event bus ----
  const subscribers = new Set();
  let subscriberList = null; // array copy of `subscribers`, rebuilt after a change
  const pending = []; // events that wait for delivery: keeps seq order when a subscriber emits
  let delivering = false;

  function call(fn, event) {
    const failed = (err) => say('error', 'store: a subscriber failed', { type: event.type, seq: event.seq, error: String(err?.stack ?? err) });
    try {
      const result = fn(event);
      if (result && typeof result.then === 'function') result.then(undefined, failed);
    } catch (err) {
      failed(err);
    }
  }

  function deliverPending() {
    if (delivering) return;
    delivering = true;
    try {
      for (let count = 0; pending.length > 0; count += 1) {
        if (count >= MAX_SYNC_DELIVERIES) {
          quiet('storm', 'warn', 'store: event storm, the bus yields to the event loop', { waiting: pending.length });
          setImmediate(deliverPending);
          return;
        }
        const event = pending.shift();
        subscriberList ??= [...subscribers];
        for (const fn of subscriberList) {
          if (subscribers.has(fn)) call(fn, event);
        }
      }
    } finally {
      delivering = false;
    }
  }

  /**
   * Publish an event to subscribers, the ring buffer and (unless persist is false) events.jsonl.
   * @param {string} type
   * @param {object} [payload] fields of the event; `type`, `seq` and `ts` are set by the store
   * @param {{ persist?: boolean }} [options] persist: false keeps the event out of events.jsonl
   * @returns the event: { type, seq, ts, ...payload }
   */
  function emit(type, payload, options) {
    if (typeof type !== 'string' || type === '') throw new TypeError('store.emit needs an event type');
    const persist = options?.persist ?? true;
    const event = { type, seq: 0, ts: 0, ...(isObj(payload) ? payload : null) };
    event.type = type;
    event.seq = state.seq + 1;
    event.ts = Date.now();
    Object.freeze(event);
    state.seq = event.seq;
    ring.push(event);
    if (persist) audit.append(event);
    if (state.seq - savedSeq >= SEQ_SAVE_EVERY) scheduleSave();
    pending.push(event);
    deliverPending();
    return event;
  }

  /** Listen to every event. A subscriber that throws is logged and skipped. Returns unsubscribe. */
  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('store.subscribe needs a function');
    subscribers.add(fn);
    subscriberList = null;
    return () => {
      subscribers.delete(fn);
      subscriberList = null;
    };
  }

  /** Events with a seq above `seq` that are still in the ring buffer, oldest first. */
  function eventsSince(seq) {
    const from = Number(seq);
    return Number.isFinite(from) ? ring.since(from) : [];
  }

  // ---- ids ----
  let idsBroken = false;

  /**
   * Put the counters on disk before an id leaves the store. The caller uses a new id at
   * once for things outside the state (a git branch, a bench folder, a log file), and
   * state.json follows only after the debounce. Without this a crash in between hands
   * the same id out again. A small synchronous write: a few ids per second at most.
   */
  function reserveIds() {
    try {
      fs.writeFileSync(idsTmp, JSON.stringify(state.counters), { mode: FILE_MODE });
      fs.renameSync(idsTmp, idsFile);
      idsBroken = false;
    } catch (err) {
      if (!idsBroken) say('error', 'store: cannot write ids.json, an id may repeat after a crash', { error: err.message });
      idsBroken = true; // one line for a failure that lasts
      try {
        fs.rmSync(idsTmp, { force: true });
      } catch { /* nothing to clean */ }
    }
  }

  /** Next short id for a kind: 'T' (or 'tasks') -> 'T13'. Never repeats, also after a crash. */
  function nextId(kind) {
    const prefix = ID_PREFIX[kind] ?? kind;
    if (typeof prefix !== 'string' || !/^[A-Z]{1,4}$/.test(prefix)) throw new TypeError(`store.nextId: unknown kind "${kind}"`);
    const n = (state.counters[prefix] ?? 0) + 1;
    state.counters[prefix] = n;
    reserveIds();
    scheduleSave();
    return `${prefix}${n}`;
  }

  // ---- entities ----
  function collection(kind) {
    if (!KINDS.includes(kind)) throw new TypeError(`store: unknown kind "${kind}"`);
    return state[kind];
  }

  function get(kind, id) {
    const items = collection(kind);
    return Object.hasOwn(items, id) ? items[id] : null;
  }

  function list(kind, filterFn) {
    const items = Object.values(collection(kind));
    return typeof filterFn === 'function' ? items.filter((item) => filterFn(item)) : items;
  }

  /**
   * Throws when the item cannot be saved and loaded again: no JSON form (a cycle, a BigInt)
   * would block every later save, and a JSON form without the id (an inherited or hidden
   * id, a toJSON method) would make the loader reject the whole file.
   */
  function assertJson(kind, item) {
    if (!Object.prototype.propertyIsEnumerable.call(item, 'id') || typeof item.toJSON === 'function') {
      throw new TypeError(`store.put(${kind}): item "${item.id}" must be plain data with its own id`);
    }
    let text;
    try {
      text = JSON.stringify(item);
    } catch (err) {
      throw new TypeError(`store.put(${kind}): item "${item.id}" has no JSON form (${firstLine(err)})`);
    }
    if (typeof text !== 'string') throw new TypeError(`store.put(${kind}): item "${item.id}" has no JSON form`);
  }

  /**
   * Insert or replace an item by id. Sets updatedAt, and createdAt when the item has none
   * (a replaced item hands its createdAt on). Emits 'upsert'. Throws a TypeError for a bad
   * kind, an item without a string id, or an item that is not plain JSON data (a cycle, a
   * BigInt, a toJSON method, an id that is not its own property); then nothing changes.
   */
  function put(kind, item) {
    const items = collection(kind);
    if (!isObj(item) || typeof item.id !== 'string' || item.id === '' || item.id === '__proto__') {
      throw new TypeError(`store.put(${kind}): the item needs a string id`);
    }
    assertJson(kind, item);
    const now = Date.now();
    const old = Object.hasOwn(items, item.id) ? items[item.id] : null;
    if (item.createdAt == null) item.createdAt = old?.createdAt ?? now;
    item.updatedAt = now;
    items[item.id] = item;
    scheduleSave();
    emit('upsert', { kind, item });
    return item;
  }

  /**
   * Shallow merge `changes` into the stored item, then put it. Throws (status 404) when the
   * id is unknown. When put() refuses the merged item, the item is left as it was.
   */
  function patch(kind, id, changes) {
    const item = get(kind, id);
    if (item === null) throw Object.assign(new Error(`store.patch: no ${kind} item "${id}"`), { status: 404 });
    if (changes != null && !isObj(changes)) throw new TypeError('store.patch: the patch must be an object');
    if (changes && Object.hasOwn(changes, 'id') && changes.id !== id) throw new TypeError('store.patch: the id of an item cannot change');
    const keys = Object.keys(changes ?? {}).filter((key) => key !== '__proto__');
    const before = keys.map((key) => [key, Object.hasOwn(item, key), item[key]]);
    for (const key of keys) item[key] = changes[key];
    try {
      return put(kind, item);
    } catch (err) {
      for (const [key, had, value] of before) {
        if (had) item[key] = value;
        else delete item[key];
      }
      throw err;
    }
  }

  /** Delete an item. Emits 'remove'. Returns false when the id was unknown. */
  function remove(kind, id) {
    const items = collection(kind);
    if (!Object.hasOwn(items, id)) return false;
    delete items[id];
    scheduleSave();
    emit('remove', { kind, id });
    return true;
  }

  /** Counters for tests and health checks. */
  function stats() {
    return { saves, buffered: ring.size, subscribers: subscribers.size, dirty: dirty || state.seq !== savedSeq };
  }

  if (loaded || idsAhead) scheduleSave(); // put the seq jump (or the ids that state.json missed) on disk soon

  return { state, nextId, put, patch, remove, get, list, emit, subscribe, eventsSince, flush, stats };
}
