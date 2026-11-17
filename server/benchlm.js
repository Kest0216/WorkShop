// WorkShop BenchLM refresh: reads the free static JSON files of benchlm.ai and updates the BenchLM
// board scores in the model registry (config/models.json).
//
// The recipe (research report, section 3.7):
//   1. GET https://benchlm.ai/data/manifest.json with If-None-Match: <saved ETag>.
//   2. 304: nothing changed, stop. 200: keep the new ETag and compare the data version of
//      leaderboard.json with the saved one.
//   3. Only when the data version changed: GET https://benchlm.ai/data/leaderboard.json (gzip).
//   4. items[] holds the overall rows. categories.<board>[] holds the board rows.
//      TRAP: in a board row the board score is `score`. `displayScore` is the OVERALL score.
//   5. Rows are matched to registry models by slug, then by canonical key, then by name.
//
// What a refresh may change: scores of the keys that come from a BenchLM board (a category with
// "board"), the `estimated` flag (the evidence label of the overall row), dataDate, fetchedAt and the
// date of those categories. It never touches other keys, tiers, power, prices, `enabled`, or the list of
// models. A missing score is null, never zero. A number outside 0 to 100 is not a board score: it is
// treated like a missing one. The dates move only when a score of the registry was compared with the
// new data. The registry is changed completely or not at all.
//
// The 10 minute rule: after a round of requests that reached benchlm.ai, or may have reached it (an
// answer of any kind, a timeout, a download that broke off), the next round waits 10 minutes. Only when
// no connection was made at all (no network, no DNS answer, connection refused) the next try may go
// out after one minute.
//
// Data from BenchLM.ai (https://benchlm.ai), CC BY-NC 4.0.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** The folder that holds manifest.json and leaderboard.json. */
export const BENCHLM_BASE_URL = 'https://benchlm.ai/data/';
/** Sent with every request. It names the app and nothing about the owner or the machine. */
export const USER_AGENT = 'WorkShop-local/0.1';

const MIN_INTERVAL_MS = 10 * 60 * 1000; // at most one refresh per 10 minutes
const RETRY_AFTER_FAIL_MS = 60 * 1000; // after a try that made no connection at all
// Error codes of fetch that mean: no connection to the server was made, so no request reached it.
const NO_CONTACT = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT',
]);
const TIMEOUT_MS = 30 * 1000; // per request, headers and body together
const MAX_BYTES = 16 * 1024 * 1024; // leaderboard.json is about 1.4 MB
const MAX_ROWS = 5000;
const CACHE_VERSION = 1;
// BenchLM's own board names. "overall" is the items[] list, the others are keys of `categories`.
const BOARD_NAMES = new Set([
  'overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge', 'multilingual', 'instructionFollowing', 'math',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** A BenchLM board score is a number from 0 to 100 (report section 3.2). Any other number is not a score. */
const isScore = (v) => isNum(v) && v >= 0 && v <= 100;
const textOrNull = (v, max = 200) => (typeof v === 'string' && v !== '' && v.length <= max ? v : null);
/** An ETag that can go back in If-None-Match: visible ASCII without spaces, at most 300 characters. Else null. */
const cleanEtag = (v) => (typeof v === 'string' && /^[\x21-\x7e]{1,300}$/.test(v) ? v : null);
const pad2 = (n) => String(n).padStart(2, '0');

/** Wraps the injected logger so that a missing or broken logger never breaks a caller. */
function safeLog(log) {
  if (typeof log !== 'function') return () => {};
  return (level, msg, data) => {
    try {
      log(level, msg, data);
    } catch { /* logging must never throw */ }
  };
}

/**
 * An error with a kind: 'network' | 'timeout' (no answer came), 'http' | 'data' (the server answered).
 * A 'network' error from fetch also has `code` (for example ECONNREFUSED): see NO_CONTACT.
 */
function problem(kind, message) {
  return Object.assign(new Error(message), { kind });
}

/**
 * One spelling for slugs, API ids and display names, so that they can be compared:
 * "Gemini 3.8 Flash", "gemini-3.8-flash" and "gemini-3-8-flash" all give "gemini-3-8-flash".
 */
export function normalizeName(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

/** "November 13, 2026" or "2026-11-13T02:27:37Z" -> "2026-11-13". Anything else -> null. */
export function isoDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (!named) return null;
  const month = MONTHS.findIndex((name) => name === named[1].toLowerCase() || name.slice(0, 3) === named[1].toLowerCase());
  const day = Number(named[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  return `${named[3]}-${pad2(month + 1)}-${pad2(day)}`;
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Reads leaderboard.json into compact rows: one per model, with its score on every board.
 * @returns {{ rows: Array<{ slug, key, name, est, s }>, boards: string[], dataDate: string|null,
 *            generatedAt: string|null, dataVersion: string|null }}
 */
export function extractLeaderboard(leaderboard) {
  if (!isRecord(leaderboard) || !Array.isArray(leaderboard.items)) {
    throw problem('data', 'leaderboard.json does not have the expected shape (no "items" list)');
  }
  const rows = [];
  const bySlug = new Map();
  const byKey = new Map();
  const byName = new Map();
  const rowFor = (raw) => {
    const slug = normalizeName(raw.slug);
    const key = normalizeName(raw.canonicalModelKey);
    const name = normalizeName(raw.model);
    if (!slug && !key && !name) return null;
    // A slug names one model and no other. A row without a slug is matched by its canonical key, then
    // by its name. Two rows with different slugs are never merged, even when their names are equal.
    let row = slug ? bySlug.get(slug) : undefined;
    if (!row) {
      const loose = (key ? byKey.get(key) : undefined) ?? (name ? byName.get(name) : undefined);
      if (loose && (!slug || loose.slug === null)) {
        row = loose;
        if (slug) row.slug = slug;
      }
    }
    if (!row) {
      if (rows.length >= MAX_ROWS) return null;
      row = { slug: slug || null, key: key || null, name: name || null, est: null, s: {} };
      rows.push(row);
    }
    if (slug && !bySlug.has(slug)) bySlug.set(slug, row);
    if (key && !byKey.has(key)) byKey.set(key, row);
    if (name && !byName.has(name)) byName.set(name, row);
    return row;
  };

  const boards = [];
  let seen = false;
  for (const raw of leaderboard.items) {
    if (!isRecord(raw)) continue;
    // In items[] `score` equals `displayScore`: both are the overall score.
    const score = isScore(raw.score) ? raw.score : isScore(raw.displayScore) ? raw.displayScore : null;
    const row = rowFor(raw);
    if (!row) continue;
    if (score !== null && !Object.hasOwn(row.s, 'overall')) {
      row.s.overall = score;
      seen = true;
    }
    if (row.est === null && (raw.evidenceStatus === 'estimated' || raw.evidenceStatus === 'supported')) {
      row.est = raw.evidenceStatus === 'estimated';
    }
  }
  if (seen) boards.push('overall');

  const categories = isRecord(leaderboard.categories) ? leaderboard.categories : {};
  for (const [board, list] of Object.entries(categories)) {
    if (board === 'overall' || UNSAFE_KEYS.has(board) || !Array.isArray(list)) continue;
    seen = false;
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      if (typeof raw.category === 'string' && raw.category !== board) continue; // a row of another board
      // TRAP: the board score is `score`. `displayScore` is the overall score and must not be used here.
      if (!isScore(raw.score)) continue;
      const row = rowFor(raw);
      if (!row || Object.hasOwn(row.s, board)) continue;
      row.s[board] = raw.score;
      seen = true;
    }
    if (seen) boards.push(board);
  }
  if (boards.length === 0) throw problem('data', 'leaderboard.json holds no scores');
  return {
    rows,
    boards,
    dataDate: isoDate(leaderboard.sourceLastUpdated),
    generatedAt: textOrNull(leaderboard.generatedAt, 60),
    dataVersion: textOrNull(leaderboard.dataVersion),
  };
}

/** Lookup tables over compact rows. The first row wins when two rows share a name. */
function indexRows(rows) {
  const index = { bySlug: new Map(), byKey: new Map(), byName: new Map() };
  for (const row of rows) {
    if (row.slug && !index.bySlug.has(row.slug)) index.bySlug.set(row.slug, row);
    if (row.key && !index.byKey.has(row.key)) index.byKey.set(row.key, row);
    if (row.name && !index.byName.has(row.name)) index.byName.set(row.name, row);
  }
  return index;
}

/**
 * The BenchLM row of a registry model, or null.
 * It tries the optional `benchlmSlug` of the model, then its id, then its label. Each one is compared
 * with the row slug, then the canonical model key, then the display name. Only exact matches count
 * (after normalizeName), so "Claude Opus 5" never matches "Claude Opus 5.5".
 */
function findRow(index, model) {
  const wanted = [];
  for (const raw of [model.benchlmSlug, model.id, model.label]) {
    const name = normalizeName(raw);
    if (name && !wanted.includes(name)) wanted.push(name);
  }
  for (const name of wanted) {
    const row = index.bySlug.get(name) ?? index.byKey.get(name) ?? index.byName.get(name);
    if (row) return row;
  }
  return null;
}

/** The BenchLM board a registry category comes from, or null for keys from other sources. */
function boardOf(key, category) {
  if (!isRecord(category) || category.board === false) return null;
  if (typeof category.board === 'string' && category.board !== '') return category.board;
  const source = typeof category.source === 'string' ? category.source.trim() : '';
  return BOARD_NAMES.has(key) && /^benchlm\b/i.test(source) ? key : null;
}

/** Works out what a set of BenchLM rows changes in a registry. It changes nothing itself. */
function planChanges(registry, data, index) {
  const boardKeys = [];
  for (const [key, category] of Object.entries(registry.categories)) {
    const board = boardOf(key, category);
    if (board !== null) boardKeys.push([key, board]);
  }
  const matches = registry.models
    .filter((model) => isRecord(model) && isRecord(model.scores))
    .map((model) => ({ model, row: findRow(index, model) }));
  // A board counts only when it has a row for one registry model or more. If BenchLM changes the
  // layout of the file, the scores of that board stay as they are instead of turning into null.
  const live = new Set(data.boards.filter((board) => matches.some(({ row }) => row !== null && isScore(row.s[board]))));
  const updated = [];
  const flags = [];
  const unmatched = [];
  const writes = []; // [object, field, new value]: the same changes, with the object to change
  for (const { model, row } of matches) {
    if (row === null) {
      unmatched.push(model.id);
      continue;
    }
    for (const [key, board] of boardKeys) {
      if (!live.has(board)) continue;
      const from = isNum(model.scores[key]) ? model.scores[key] : null;
      const to = isScore(row.s[board]) ? row.s[board] : null; // no row on this board: no score, so null
      if (from !== to) {
        updated.push({ id: model.id, key, from, to });
        writes.push([model.scores, key, to]);
      }
    }
    if (typeof row.est === 'boolean' && typeof model.estimated === 'boolean' && row.est !== model.estimated) {
      flags.push({ id: model.id, key: 'estimated', from: model.estimated, to: row.est });
      writes.push([model, 'estimated', row.est]);
    }
  }
  // True when one score key or more of the registry was compared with a board of this data.
  const compared = boardKeys.some(([, board]) => live.has(board));
  return { updated, flags, unmatched, boardKeys, live, writes, compared };
}

/**
 * Makes every write, or none: when one write fails, the writes before it are taken back.
 * @param writes [object, field, value][]
 */
function writeAll(writes) {
  const done = [];
  try {
    for (const [target, field, value] of writes) {
      done.push([target, field, Object.hasOwn(target, field), target[field]]);
      target[field] = value;
    }
  } catch (err) {
    for (const [target, field, had, old] of done.reverse()) {
      try {
        if (had) target[field] = old;
        else delete target[field];
      } catch { /* this write did not happen, so there is nothing to take back */ }
    }
    throw problem('data', `the registry cannot be changed (${String(err?.message ?? err).slice(0, 120)})`);
  }
}

/** Writes a small text file so that a crash leaves either the old or the new content. */
async function writeAtomic(file, text) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, text, { flag: 'wx', mode: 0o644 });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Reads a response body with a size limit. Works with fetch responses and with simple fakes. */
async function readBytes(res, maxBytes) {
  const tooBig = () => problem('data', `the answer is larger than ${maxBytes} bytes`);
  const reader = typeof res.body?.getReader === 'function' ? res.body.getReader() : null;
  if (reader) {
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  const bytes = typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()) : Buffer.from(String(await res.text()));
  if (bytes.length > maxBytes) throw tooBig();
  return bytes;
}

/** Bytes -> JSON text. fetch unpacks gzip by itself. A fetch stand-in may not, so gzip is unpacked here too. */
function decodeBody(bytes, maxBytes) {
  let plain = bytes;
  if (plain.length > 2 && plain[0] === 0x1f && plain[1] === 0x8b) {
    try {
      plain = gunzipSync(plain, { maxOutputLength: maxBytes });
    } catch {
      throw problem('data', 'the gzip answer could not be unpacked');
    }
  }
  const text = plain.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function networkText(err) {
  const cause = err?.cause;
  return String(cause?.code ?? cause?.message ?? err?.message ?? err).slice(0, 200);
}

/** Keeps only well-formed rows of a cache file. */
function readCache(parsed) {
  if (!isRecord(parsed) || parsed.v !== CACHE_VERSION || !Array.isArray(parsed.rows) || !Array.isArray(parsed.boards)) return null;
  if (!isNum(parsed.checkedAt)) return null;
  const rows = [];
  for (const raw of parsed.rows.slice(0, MAX_ROWS)) {
    if (!isRecord(raw) || !isRecord(raw.s)) continue;
    const s = {};
    for (const [board, value] of Object.entries(raw.s)) if (!UNSAFE_KEYS.has(board) && isScore(value)) s[board] = value;
    rows.push({
      slug: textOrNull(raw.slug), key: textOrNull(raw.key), name: textOrNull(raw.name),
      est: typeof raw.est === 'boolean' ? raw.est : null, s,
    });
  }
  const boards = parsed.boards.filter((board) => typeof board === 'string' && !UNSAFE_KEYS.has(board));
  if (rows.length === 0 || boards.length === 0) return null;
  return {
    v: CACHE_VERSION,
    etag: cleanEtag(parsed.etag), // a bad value here would make every later request fail
    dataVersion: textOrNull(parsed.dataVersion),
    dataDate: isoDate(parsed.dataDate),
    generatedAt: textOrNull(parsed.generatedAt, 60),
    fetchedAt: isoDate(parsed.fetchedAt),
    checkedAt: parsed.checkedAt,
    boards,
    rows,
  };
}

/**
 * BenchLM refresh.
 * @param {object} deps
 * @param {typeof fetch} [deps.fetchImpl]  the fetch function to use (tests pass a wrapper)
 * @param {string} [deps.cachePath]        JSON file for the ETag, the data version and the last rows
 *                                         (for example data/benchlm-cache.json). Without it nothing is kept on disk.
 * @param {(level: string, msg: string, data?: object) => void} [deps.log]
 * @param {() => number} [deps.now]        clock in ms
 * @param {string} [deps.baseUrl]          folder URL of the JSON files (tests point it at a local server)
 * @param {number} [deps.timeoutMs]        limit for one request, headers and body together
 * @param {number} [deps.minIntervalMs]    shortest time between two rounds of requests that reached the server,
 *                                         or may have reached it (also after a timeout or an error answer)
 * @param {number} [deps.retryAfterFailMs] wait after a try that made no connection at all (no network, connection refused)
 * @param {number} [deps.maxBytes]         largest accepted answer
 */
export function createBenchlm({
  fetchImpl = globalThis.fetch,
  cachePath,
  log,
  now = Date.now,
  baseUrl = BENCHLM_BASE_URL,
  timeoutMs = TIMEOUT_MS,
  minIntervalMs = MIN_INTERVAL_MS,
  retryAfterFailMs = RETRY_AFTER_FAIL_MS,
  maxBytes = MAX_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createBenchlm needs a fetch function');
  const say = safeLog(log);
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const host = new URL(base).host;

  let cache = null; // the last BenchLM extract: { etag, dataVersion, dataDate, fetchedAt, checkedAt, boards, rows }
  let cacheIndex = null;
  let cacheRead = false;
  let blockedUntil = 0; // after a failed try
  let lastError = null;
  let queue = Promise.resolve();

  async function loadCache() {
    if (cacheRead) return;
    cacheRead = true;
    if (!cachePath) return;
    try {
      cache = readCache(JSON.parse(await readFile(cachePath, 'utf8')));
      if (cache === null) say('warn', 'benchlm: the cache file has an unknown shape, starting without it', { cachePath });
    } catch (err) {
      if (err.code !== 'ENOENT') say('warn', 'benchlm: cannot read the cache file, starting without it', { cachePath, error: err.message });
    }
  }

  async function saveCache() {
    cacheIndex = null;
    if (!cachePath) return;
    try {
      await writeAtomic(cachePath, `${JSON.stringify(cache)}\n`);
    } catch (err) {
      say('warn', 'benchlm: cannot write the cache file', { cachePath, error: err.message });
    }
  }

  /** One GET with a deadline. Returns { status: 304 } or { status: 200, etag, json }. Throws a problem(). */
  async function get(name, etag) {
    const url = new URL(name, base).href;
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Encoding': 'gzip' };
    if (etag) headers['If-None-Match'] = etag;
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const late = problem('timeout', `${name}: ${host} did not answer within ${timeoutMs} ms`);
        controller.abort(late);
        reject(late);
      }, timeoutMs);
    });
    const work = (async () => {
      let res;
      try {
        res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
      } catch (err) {
        const failure = problem('network', `${name}: cannot reach ${host} (${networkText(err)})`);
        failure.code = String(err?.cause?.code ?? err?.code ?? ''); // tells "no connection" from "the connection broke"
        throw failure;
      }
      const status = res?.status;
      if (status === 304 && etag) {
        await res.body?.cancel?.().catch(() => {});
        return { status: 304 };
      }
      if (status !== 200) {
        await res?.body?.cancel?.().catch(() => {});
        throw problem('http', `${name}: ${host} answered HTTP ${status}`);
      }
      let bytes;
      try {
        bytes = await readBytes(res, maxBytes);
      } catch (err) {
        throw err.kind ? problem(err.kind, `${name}: ${err.message}`) : problem('network', `${name}: the download broke off (${networkText(err)})`);
      }
      let json;
      try {
        json = JSON.parse(decodeBody(bytes, maxBytes));
      } catch (err) {
        throw problem('data', `${name}: ${err.kind ? err.message : 'the answer is not valid JSON'}`);
      }
      return { status: 200, etag: cleanEtag(res.headers?.get?.('etag')), json };
    })();
    work.catch(() => {}); // when the deadline wins, the late error of `work` is not an unhandled rejection
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Applies the cached BenchLM rows to the registry (in place) and builds the result. */
  function applyRows(registry, extra) {
    cacheIndex ??= indexRows(cache.rows);
    const plan = planChanges(registry, cache, cacheIndex);
    const nextAt = cache.checkedAt + minIntervalMs;
    const result = {
      ok: true, changed: false, updated: [], dataDate: textOrNull(registry.dataDate, 40) ?? cache.dataDate, notModified: false,
      error: null, flags: [], unmatched: plan.unmatched, throttled: false, checkedAt: cache.checkedAt, nextAt, ...extra,
    };
    const have = isoDate(registry.dataDate);
    if (have !== null && cache.dataDate !== null && cache.dataDate < have) {
      say('warn', 'benchlm: the BenchLM data is older than the registry, nothing applied', { benchlm: cache.dataDate, registry: have });
      return result;
    }
    // Everything is checked. The list of writes is made first, then all of them are done, or none.
    const writes = [...plan.writes];
    // The dates say how fresh the numbers are. They move only when a score key of the registry was
    // compared with this data. A file that holds none of our models proves nothing about our numbers.
    if (plan.compared && cache.dataDate !== null) {
      if (registry.dataDate !== cache.dataDate) writes.push([registry, 'dataDate', cache.dataDate]);
      for (const [key, board] of plan.boardKeys) {
        const category = registry.categories[key];
        if (plan.live.has(board) && typeof category.date === 'string' && category.date !== cache.dataDate) {
          writes.push([category, 'date', cache.dataDate]);
        }
      }
    }
    const changed = writes.length > 0;
    if (changed && cache.fetchedAt !== null && registry.fetchedAt !== cache.fetchedAt) writes.push([registry, 'fetchedAt', cache.fetchedAt]);
    writeAll(writes); // throws when the registry cannot be written, and then nothing was changed
    if (plan.unmatched.length > 0) say('warn', 'benchlm: no BenchLM row for some models, their scores stay', { ids: plan.unmatched });
    say('info', 'benchlm: refresh done', {
      changed, updated: plan.updated.length, dataDate: cache.dataDate, notModified: result.notModified, throttled: result.throttled,
    });
    return { ...result, changed, updated: plan.updated, flags: plan.flags, dataDate: textOrNull(registry.dataDate, 40) ?? cache.dataDate };
  }

  async function run(registry) {
    const dataDate = isRecord(registry) ? textOrNull(registry.dataDate, 40) : null;
    const failed = (error, extra) => ({ ok: false, changed: false, updated: [], dataDate, notModified: false, error, ...extra });
    if (!isRecord(registry) || !Array.isArray(registry.models) || !isRecord(registry.categories)) {
      return failed('The registry to refresh is not a model registry.');
    }
    await loadCache();
    // The BenchLM answer is in the cache by now. A registry that cannot be written is the caller's
    // problem: it is reported, and it does not count as a failed round of requests.
    const apply = (extra) => {
      try {
        return applyRows(registry, extra);
      } catch (err) {
        const message = err?.kind ? err.message : `unexpected error (${String(err?.message ?? err).slice(0, 200)})`;
        say('warn', 'benchlm: the registry was not changed', { error: message });
        return failed(`BenchLM refresh failed: ${message}`, { nextAt: cache.checkedAt + minIntervalMs });
      }
    };
    const start = now();
    // A pause that is longer than any pause this module sets means that the clock was set back.
    const longestPause = Math.max(minIntervalMs, retryAfterFailMs);
    if (start < blockedUntil && blockedUntil - start <= longestPause) {
      const wait = Math.ceil((blockedUntil - start) / 1000);
      return failed(`BenchLM refresh is paused for ${wait} s after an error (${lastError}).`, { throttled: true, nextAt: blockedUntil });
    }
    // At most one refresh per 10 minutes. Inside that time the last answer of BenchLM is still used.
    if (cache !== null && start >= cache.checkedAt && start - cache.checkedAt < minIntervalMs) {
      return apply({ notModified: true, throttled: true });
    }
    try {
      const manifest = await get('manifest.json', cache !== null ? cache.etag : null);
      if (manifest.status === 304) {
        cache.checkedAt = now();
        await saveCache();
        return apply({ notModified: true });
      }
      if (!isRecord(manifest.json)) throw problem('data', 'manifest.json does not have the expected shape');
      const files = Array.isArray(manifest.json.files) ? manifest.json.files : [];
      const entry = files.find((file) => isRecord(file) && file.name === 'leaderboard.json') ?? null;
      // dataVersion is a hash of the content. It stays the same when only the build time changes.
      const version = textOrNull(entry?.dataVersion) ?? textOrNull(manifest.json.dataVersion);
      if (cache !== null && version !== null && cache.dataVersion === version) {
        cache.etag = manifest.etag;
        cache.checkedAt = now();
        await saveCache();
        return apply({ notModified: true });
      }
      // New data. The new ETag is kept only after the import worked, so a failed download is tried again.
      const leaderboard = await get('leaderboard.json', null);
      const data = extractLeaderboard(leaderboard.json);
      const stamp = now();
      cache = {
        v: CACHE_VERSION,
        etag: manifest.etag,
        dataVersion: version ?? data.dataVersion,
        dataDate: data.dataDate ?? isoDate(entry?.sourceLastUpdated) ?? isoDate(data.generatedAt),
        generatedAt: data.generatedAt,
        fetchedAt: localDate(stamp),
        checkedAt: stamp,
        boards: data.boards,
        rows: data.rows,
      };
      await saveCache();
      return apply({ notModified: false });
    } catch (err) {
      const message = err?.kind ? err.message : `unexpected error (${String(err?.message ?? err).slice(0, 200)})`;
      // "At most one refresh per 10 minutes" counts every round that reached the server or may have
      // reached it: an answer of any kind, a timeout, a download that broke off. Only when no connection
      // was made at all (no network, no DNS answer, connection refused) the next try may come sooner.
      const noContact = err?.kind === 'network' && NO_CONTACT.has(err.code);
      blockedUntil = now() + (noContact ? Math.min(retryAfterFailMs, minIntervalMs) : minIntervalMs);
      lastError = message;
      say('warn', 'benchlm: refresh failed, nothing changed', { error: message });
      return failed(`BenchLM refresh failed: ${message}`, { nextAt: blockedUntil });
    }
  }

  /**
   * Refreshes the BenchLM board scores of `registry` IN PLACE. Save the registry afterwards when
   * `changed` is true (router.save). On any failure the registry is not touched.
   * @returns {Promise<{ ok: boolean, changed: boolean, updated: Array<{ id: string, key: string, from: number|null, to: number|null }>,
   *   dataDate: string|null, notModified: boolean, error: string|null }>}
   *   plus: flags (changes of `estimated`), unmatched (model ids without a BenchLM row),
   *   throttled (true when no request was sent because of the 10 minute rule), checkedAt and nextAt (ms).
   */
  function refresh(registry) {
    const result = queue.then(() => run(registry));
    queue = result.catch(() => {}); // one refresh at a time
    return result.catch((err) => ({
      ok: false, changed: false, updated: [], dataDate: null, notModified: false,
      error: `BenchLM refresh failed: ${String(err?.message ?? err).slice(0, 200)}`,
    }));
  }

  return { refresh };
}
