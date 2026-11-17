// WorkShop router: picks the model for each agent from the registry in config/models.json.
//
// The pick rule (contract section 11), in this order:
//   1. Candidates: enabled models that list the role, in a usable lab, not excluded, and strong enough
//      for the task size (makers only: S needs power 1, M and L need power 3). Models whose PRIMARY
//      tier is the role go first. Fallback-tier models are used only when no primary-tier model is left.
//   2. avoidProvider removes that lab when a candidate of another lab remains.
//   3. bump raises the minimum power by that much, capped at the strongest candidate.
//   4. Comparison key: the first key of the domain for which every candidate has a number, else "overall".
//      A candidate without a number ranks last.
//   5. quality q = min-max of the key over the candidates. Values closer than the category's "tie" count
//      as equal. cost c = min-max of (price.in + 3 * price.out) / 4. utility = q - thrift * c.
//      At thrift 1 the cheapest candidate wins outright (the setting means "cheapest that fits").
//   6. Utilities within 0.02 are a tie: lower lab load first, then preferProvider, then lower cost,
//      then registry order.
// Also:
//   - Effort: boss high, manager medium, maker S low / M medium / L high, clamped to the model's list.
//   - `why` is one sentence with the numbers. It says so when the best lab was not usable or was avoided.
//   - settings.allowFallback === false: when the lab that should get the pick is not usable, pick()
//     returns null (the hub waits) instead of a model of the other lab.
//   - price.next ({ from, in, out }) replaces the list price from its start date on.
//   - Model list of a lab (contract 14c): when providers.list() reports `models` for a lab (the slugs
//     that `agy models` printed for this account), the router offers only the models on that list, and
//     only the efforts that the list has for them. No list for a lab means no limit.
// Nothing here is random and nothing reads the network, so the same input gives the same pick.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Agent roles. A model's `tiers` list holds these: the primary role first, then fallback roles. */
export const ROLES = Object.freeze(['boss', 'manager', 'maker']);

/** The task domains of the contract (section 4). The registry must map every one of them. */
export const DOMAINS = Object.freeze([
  'plan', 'backend', 'frontend', 'fix', 'review', 'test', 'data', 'algo', 'research', 'synthesis', 'docs', 'vision', 'chore',
]);

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const ROLE_EFFORT = { boss: 'high', manager: 'medium' };
const SIZE_EFFORT = { S: 'low', M: 'medium', L: 'high' };
const SIZE_POWER = { S: 1, M: 3, L: 3 };
const DEFAULT_THRIFT = 0.3;
const UTILITY_TIE = 0.02;
const EPS = 1e-9;
const NOT_ON_ACCOUNT = 'not on this account';

const MAX_MODELS = 200;
const MAX_CATEGORIES = 100;
const MAX_NOTE_CHARS = 500;
// Limits for the numbers of a registry. Inside them the min-max math cannot overflow: with larger
// numbers a difference turns into Infinity and a quality or cost into NaN.
const MAX_SCORE = 1e9; // largest size of a score and of a tie value (real ones are under 2000)
const MAX_PRICE = 1e9; // USD per 1M tokens (real ones are under 100)
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
// A model id and an effort name go on the command line of an agent CLI. So: no spaces, no quotes,
// no shell characters, and never a leading "-" (it would read as an option).
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
const EFFORT_RE = /^[a-z][a-z0-9-]{0,19}$/;
const PROVIDER_RE = /^[a-z][a-z0-9-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const isPrice = (v) => isNum(v) && v >= 0 && v <= MAX_PRICE;
const unique = (list) => new Set(list).size === list.length;
/** A value for an error message. It never calls String() on a value that is not text (that can throw). */
const shown = (v) => (typeof v === 'string' ? `"${v.slice(0, 40)}"` : `a value of type ${v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v}`);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const pad2 = (n) => String(n).padStart(2, '0');

/** An error that the HTTP layer can show as is: a plain message and a status. */
function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

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
 * Checks the shape of a model registry and returns a private, normalized copy.
 * Unknown extra fields are kept. Throws an error with status 400 and a plain message.
 */
export function validateRegistry(input) {
  checkRegistry(input);
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(input));
  } catch {
    throw fail('The model registry must be plain JSON data.');
  }
  // The copy is what the router keeps and what save() writes, so the copy itself must pass. JSON turns
  // a hole in a list, undefined, and a value like a symbol into null: the first check does not see those.
  checkRegistry(copy);
  const catKeys = Object.keys(copy.categories);
  for (const model of copy.models) {
    const scores = {};
    for (const key of catKeys) scores[key] = isNum(model.scores[key]) ? model.scores[key] : null; // one order, every key
    model.scores = scores;
    if (typeof model.price.note !== 'string') model.price.note = '';
    if (typeof model.planNote !== 'string') model.planNote = '';
    if (typeof model.estimated !== 'boolean') model.estimated = false;
  }
  return copy;
}

/** The checks of validateRegistry(). Throws an error with status 400 at the first problem. */
function checkRegistry(input) {
  const need = (ok, message) => {
    if (!ok) throw fail(message);
  };
  need(isRecord(input), 'The model registry must be a JSON object.');
  need(input.version === 1, 'version must be 1.');
  for (const field of ['dataDate', 'fetchedAt']) {
    need(isText(input[field], 40), `${field} must be a short text such as "2026-11-13".`);
  }
  need(
    isRecord(input.attribution) && ['text', 'url', 'license'].every((k) => isText(input.attribution[k], 200)),
    'attribution needs the texts "text", "url" and "license".',
  );

  need(isRecord(input.categories), 'categories must be an object.');
  const catKeys = Object.keys(input.categories);
  need(catKeys.length <= MAX_CATEGORIES, `categories must not hold more than ${MAX_CATEGORIES} keys.`);
  need(Object.hasOwn(input.categories, 'overall'), 'categories must have the key "overall".');
  for (const key of catKeys) {
    const at = `categories.${key}`;
    const cat = input.categories[key];
    need(KEY_RE.test(key) && !UNSAFE_KEYS.has(key), `${at}: a key must be 1 to 40 letters or digits and start with a letter.`);
    need(isRecord(cat), `${at} must be an object.`);
    need(isText(cat.label, 80), `${at}.label must be a short text.`);
    need(isText(cat.scale, 40), `${at}.scale must be a short text such as "0-100" or "elo".`);
    need(isNum(cat.tie) && cat.tie >= 0 && cat.tie <= MAX_SCORE, `${at}.tie must be a number from 0 to ${MAX_SCORE}.`);
    need(isText(cat.source, 120), `${at}.source must be a short text.`);
    need(cat.lowerIsBetter === undefined || typeof cat.lowerIsBetter === 'boolean', `${at}.lowerIsBetter must be true or false.`);
    need(cat.board === undefined || cat.board === false || isText(cat.board, 40), `${at}.board must be a BenchLM board name or false.`);
  }

  need(isRecord(input.domains), 'domains must be an object.');
  for (const name of DOMAINS) need(Object.hasOwn(input.domains, name), `domains must have "${name}".`);
  for (const [name, dom] of Object.entries(input.domains)) {
    const at = `domains.${name}`;
    need(KEY_RE.test(name) && !UNSAFE_KEYS.has(name), `${at}: a domain name must be 1 to 40 letters or digits.`);
    need(isRecord(dom), `${at} must be an object.`);
    need(isText(dom.label, 80), `${at}.label must be a short text.`);
    need(Array.isArray(dom.keys) && dom.keys.length >= 1 && dom.keys.length <= 20, `${at}.keys must be a list of category keys.`);
    for (const key of dom.keys) {
      need(typeof key === 'string' && Object.hasOwn(input.categories, key), `${at}.keys: ${shown(key)} is not a category.`);
    }
    need(unique(dom.keys), `${at}.keys must not repeat a key.`);
    need(dom.keys.at(-1) === 'overall', `${at}.keys must end with "overall".`);
  }

  need(Array.isArray(input.models) && input.models.length >= 1, 'models must be a list with one model or more.');
  need(input.models.length <= MAX_MODELS, `models must not hold more than ${MAX_MODELS} models.`);
  const seen = new Set();
  // A plain loop, not forEach: forEach skips the holes of a list, and a hole is not a model.
  for (let i = 0; i < input.models.length; i += 1) {
    const model = input.models[i];
    const at = `models[${i}]${isRecord(model) && typeof model.id === 'string' ? ` (${model.id.slice(0, 80)})` : ''}`;
    need(isRecord(model), `${at} must be an object.`);
    need(typeof model.id === 'string' && MODEL_ID_RE.test(model.id), `${at}.id must be a model id such as "claude-sonnet-5-5".`);
    need(!seen.has(model.id), `${at}: this id is in the list twice.`);
    seen.add(model.id);
    need(typeof model.provider === 'string' && PROVIDER_RE.test(model.provider), `${at}.provider must be a lab id such as "claude".`);
    need(isText(model.label, 80), `${at}.label must be a short text.`);
    need(
      Array.isArray(model.tiers) && model.tiers.length >= 1 && model.tiers.every((t) => ROLES.includes(t)) && unique(model.tiers),
      `${at}.tiers must list one or more of boss, manager, maker. The primary role comes first.`,
    );
    need(Number.isInteger(model.power) && model.power >= 1 && model.power <= 5, `${at}.power must be a whole number from 1 to 5.`);
    const price = model.price;
    need(
      isRecord(price) && isPrice(price.in) && isPrice(price.out),
      `${at}.price needs the numbers "in" and "out" (USD per 1M tokens, from 0 to ${MAX_PRICE}).`,
    );
    need(
      price.note === undefined || (typeof price.note === 'string' && price.note.length <= MAX_NOTE_CHARS),
      `${at}.price.note must be text of at most ${MAX_NOTE_CHARS} characters.`,
    );
    if (price.next !== undefined) {
      const next = price.next;
      need(
        isRecord(next) && typeof next.from === 'string' && DATE_RE.test(next.from) && isPrice(next.in) && isPrice(next.out),
        `${at}.price.next needs "from" (YYYY-MM-DD) and the numbers "in" and "out" (from 0 to ${MAX_PRICE}).`,
      );
    }
    need(
      Array.isArray(model.efforts) && model.efforts.every((e) => typeof e === 'string' && EFFORT_RE.test(e)) && unique(model.efforts),
      `${at}.efforts must be a list of effort names such as "low" or "high" (it can be empty).`,
    );
    need(typeof model.enabled === 'boolean', `${at}.enabled must be true or false.`);
    need(model.estimated === undefined || typeof model.estimated === 'boolean', `${at}.estimated must be true or false.`);
    need(
      model.planNote === undefined || (typeof model.planNote === 'string' && model.planNote.length <= MAX_NOTE_CHARS),
      `${at}.planNote must be text of at most ${MAX_NOTE_CHARS} characters.`,
    );
    need(
      model.benchlmSlug === undefined || isText(model.benchlmSlug, 120),
      `${at}.benchlmSlug must be the short name of the model on BenchLM, or be left out.`,
    );
    need(isRecord(model.scores), `${at}.scores must be an object.`);
    for (const [key, value] of Object.entries(model.scores)) {
      need(Object.hasOwn(input.categories, key), `${at}.scores has the unknown key "${key.slice(0, 40)}".`);
      need(value === null || isNum(value), `${at}.scores.${key} must be a number or null.`);
      need(value === null || Math.abs(value) <= MAX_SCORE, `${at}.scores.${key} must be between -${MAX_SCORE} and ${MAX_SCORE}.`);
    }
  }
}

/** Writes a small text file so that a crash leaves either the old or the new content. */
function writeAtomic(file, text) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(tmp, 'wx', 0o644);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (fd !== null) closeSync(fd);
      rmSync(tmp, { force: true });
    } catch { /* report the first error, not the cleanup */ }
    throw err;
  }
}

/** Local calendar date as YYYY-MM-DD. */
/** "14:05": the local clock time of an epoch-ms moment, for `cooled until <time>`. */
function localTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The list price in force on `today`: price.next replaces the price from its start date on. */
function priceOn(model, today) {
  const next = model.price.next;
  return next && today >= next.from ? next : model.price;
}

/** One blended cost number: output tokens weigh three times as much as input tokens. */
function costOf(model, today) {
  const price = priceOn(model, today);
  return (price.in + 3 * price.out) / 4;
}

/**
 * The effort a role (and for makers a task size) asks for, clamped to what the model accepts:
 * the highest level of the model that is not above the wanted one, else its lowest level.
 * The provider adapters clamp in the same way. null means: send no effort setting.
 */
function effortFor(role, size, efforts) {
  const want = role === 'maker' ? SIZE_EFFORT[size] ?? 'medium' : ROLE_EFFORT[role] ?? 'medium';
  if (efforts.length === 0) return null;
  if (efforts.includes(want)) return want;
  const known = EFFORT_ORDER.filter((name) => efforts.includes(name)); // low to max
  if (known.length === 0) return efforts[0];
  const target = EFFORT_ORDER.indexOf(want);
  const below = known.filter((name) => EFFORT_ORDER.indexOf(name) < target);
  return below.length > 0 ? below.at(-1) : known[0];
}

/**
 * The efforts of a model that a lab's own model list offers, or null when the list does not hold the model.
 * A list holds slugs: the model id plus "-" plus an effort ("gemini-4-carbon-high"), or the bare model id.
 * Only an effort name counts as the last part, so "gemini-3.5-flash-lite" is not "gemini-3.5-flash".
 */
function listedEfforts(model, slugs) {
  const effortNames = new Set([...EFFORT_ORDER, ...model.efforts]);
  const prefix = `${model.id}-`;
  const listed = new Set();
  let bare = false;
  for (const slug of slugs) {
    if (slug === model.id) bare = true;
    else if (slug.startsWith(prefix) && effortNames.has(slug.slice(prefix.length))) listed.add(slug.slice(prefix.length));
  }
  if (!bare && listed.size === 0) return null;
  const efforts = model.efforts.filter((name) => listed.has(name)); // the order of the registry
  return efforts.length > 0 ? efforts : model.efforts;
}

/** Reads the pick query into one fixed shape. Returns null when the role is not a known role. */
function readQuery(query) {
  const q = isRecord(query) ? query : {};
  if (!ROLES.includes(q.role)) return null;
  const size = typeof q.size === 'string' && Object.hasOwn(SIZE_POWER, q.size.toUpperCase()) ? q.size.toUpperCase() : null;
  const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
  const excludeList = Array.isArray(q.exclude) ? q.exclude
    : q.exclude instanceof Set ? [...q.exclude]
      : typeof q.exclude === 'string' ? [q.exclude] : [];
  return {
    role: q.role,
    domain: text(q.domain),
    size,
    avoid: text(q.avoidProvider),
    prefer: text(q.preferProvider),
    labLoad: isRecord(q.labLoad) ? q.labLoad : {},
    exclude: new Set(excludeList.filter((id) => typeof id === 'string')),
    bump: isNum(q.bump) ? Math.max(0, Math.floor(q.bump)) : 0,
    basePower: q.role === 'maker' && size ? SIZE_POWER[size] : 1,
  };
}

/**
 * One pass of the pick rule.
 * @param reg     the registry
 * @param q       a query from readQuery()
 * @param env     { usable(provider) -> boolean, listed?(model) -> efforts|null, applyAvoid, thrift, today }
 *                listed() answers null for a model that is not on the model list of its lab. Without
 *                listed() no model list is used.
 * @returns { ranked, rejected, tier, key, tried, minPower, avoided }: ranked[0] wins. ranked is empty
 *          when no model can take the role.
 */
function evaluate(reg, q, env) {
  const rejected = [];
  const drop = (model, reason) => rejected.push({ id: model.id, provider: model.provider, label: model.label, reason });

  // 1. Hard filters, then the tier level.
  const fits = [];
  reg.models.forEach((model, index) => {
    if (!model.tiers.includes(q.role)) return;
    if (!model.enabled) drop(model, 'disabled');
    else if (q.exclude.has(model.id)) drop(model, 'excluded');
    else if (!env.usable(model.provider)) drop(model, 'lab not usable');
    else if (env.listed && env.listed(model) === null) drop(model, NOT_ON_ACCOUNT);
    else if (env.skip && env.skip(model) !== null) drop(model, env.skip(model));
    else if (model.power < q.basePower) drop(model, `power ${model.power} is under ${q.basePower}`);
    else fits.push({ model, index });
  });
  const primary = fits.filter((row) => row.model.tiers[0] === q.role);
  let pool = primary.length > 0 ? primary : fits;
  const tier = pool.length === 0 ? null : primary.length > 0 ? 'primary' : 'fallback';
  if (primary.length > 0) {
    for (const row of fits) if (row.model.tiers[0] !== q.role) drop(row.model, 'fallback tier is not needed');
  }
  const none = { ranked: [], rejected, tier, key: null, tried: [], minPower: q.basePower, avoided: false };
  if (pool.length === 0) return none;

  // 2. Cross-lab picks: leave the avoided lab out when another lab can do the job.
  let avoided = false;
  if (q.avoid && env.applyAvoid) {
    const others = pool.filter((row) => row.model.provider !== q.avoid);
    if (others.length > 0 && others.length < pool.length) {
      for (const row of pool) if (row.model.provider === q.avoid) drop(row.model, 'lab avoided');
      pool = others;
      avoided = true;
    }
  }

  // 3. A retry on a stronger model: raise the minimum power, but never above the strongest candidate.
  const strongest = Math.max(...pool.map((row) => row.model.power));
  const minPower = Math.min(q.basePower + q.bump, strongest);
  if (minPower > q.basePower) {
    for (const row of pool) if (row.model.power < minPower) drop(row.model, `power ${row.model.power} is under ${minPower} (bump)`);
    pool = pool.filter((row) => row.model.power >= minPower);
  }

  // 4. The comparison key.
  const keyList = q.domain && Object.hasOwn(reg.domains, q.domain) ? reg.domains[q.domain].keys : ['overall'];
  const tried = [];
  let key = null;
  for (const candidate of keyList) {
    const missing = pool.filter((row) => !isNum(row.model.scores[candidate])).map((row) => row.model.id);
    tried.push({ key: candidate, missing });
    if (missing.length === 0) {
      key = candidate;
      break;
    }
  }
  if (key === null) key = 'overall';
  const cat = reg.categories[key];
  const sign = cat.lowerIsBetter ? -1 : 1;

  // 5. Quality, cost, utility.
  const rows = pool.map(({ model, index }) => {
    const value = isNum(model.scores[key]) ? model.scores[key] : null;
    return {
      model, index, value, missing: value === null, level: null, band: null, q: 0,
      cost: costOf(model, env.today), c: 0, utility: 0, group: null,
    };
  });
  const scored = rows.filter((row) => !row.missing).sort((a, b) => sign * (b.value - a.value) || a.index - b.index);
  let anchor = null;
  let band = 0;
  for (const row of scored) {
    const gap = anchor === null ? null : round6(Math.abs(anchor - row.value));
    if (gap === null || (gap > 0 && gap >= cat.tie)) {
      anchor = row.value; // this value is clearly behind the last anchor: it starts a new band
      band += 1;
    }
    row.level = anchor;
    row.band = band;
  }
  if (scored.length > 0) {
    const levels = scored.map((row) => sign * row.level);
    const hi = Math.max(...levels);
    const lo = Math.min(...levels);
    for (const row of scored) row.q = hi === lo ? 1 : (sign * row.level - lo) / (hi - lo);
  }
  const costs = rows.map((row) => row.cost);
  const costHi = Math.max(...costs);
  const costLo = Math.min(...costs);
  for (const row of rows) {
    row.c = costHi === costLo ? 0 : (row.cost - costLo) / (costHi - costLo);
    row.utility = row.q - env.thrift * row.c;
  }

  // 6. The order. Scored candidates come before candidates without a number.
  const load = (row) => (isNum(q.labLoad[row.model.provider]) ? q.labLoad[row.model.provider] : 0);
  const liked = (row) => (q.prefer !== null && row.model.provider === q.prefer ? 0 : 1);
  const tieBreak = (a, b) => load(a) - load(b) || liked(a) - liked(b) || a.cost - b.cost || a.index - b.index;
  let groupCount = 0;
  const byUtility = (list) => {
    const sorted = [...list].sort((a, b) => b.utility - a.utility || a.index - b.index);
    const out = [];
    let top = null;
    let group = [];
    const flush = () => {
      groupCount += 1;
      for (const row of group.sort(tieBreak)) {
        row.group = groupCount;
        out.push(row);
      }
    };
    for (const row of sorted) {
      if (top !== null && top - row.utility > UTILITY_TIE + EPS) {
        flush();
        group = [];
        top = null;
      }
      if (top === null) top = row.utility;
      group.push(row);
    }
    if (group.length > 0) flush();
    return out;
  };
  const order = (list) => {
    if (env.thrift < 1) return byUtility(list);
    // Thrift 1 means "cheapest that fits": cost decides, utility only orders equally cheap models.
    const byCost = new Map();
    for (const row of list) {
      const at = round6(row.cost);
      if (!byCost.has(at)) byCost.set(at, []);
      byCost.get(at).push(row);
    }
    return [...byCost.keys()].sort((a, b) => a - b).flatMap((at) => byUtility(byCost.get(at)));
  };
  const ranked = [...order(scored), ...order(rows.filter((row) => row.missing))];
  return { ranked, rejected, tier, key, tried, minPower, avoided };
}

/** Why the first candidate is ahead of the second one, as a short clause. Empty for a clear score lead. */
function reasonFor(first, second, cat, q, thrift) {
  if (!second) return 'only candidate';
  if (first.missing) return 'no candidate has a score so cost and order decide';
  if (second.missing) return '';
  if (thrift >= 1 && round6(first.cost) !== round6(second.cost)) return 'the cheapest wins';
  const tied = first.band === second.band;
  const tieText = first.value === second.value ? 'equal scores' : tied ? `a tie (gap under ${cat.tie})` : 'a close call';
  if (first.group !== second.group) {
    if (first.q > second.q) return '';
    return tied ? `${tieText} so lower cost wins` : 'lower cost outweighs the gap';
  }
  const load = (row) => (isNum(q.labLoad[row.model.provider]) ? q.labLoad[row.model.provider] : 0);
  if (load(first) !== load(second)) return `${tieText} so crew balance decides`;
  if (q.prefer !== null && (first.model.provider === q.prefer) !== (second.model.provider === q.prefer)) {
    return `${tieText} so the preferred lab wins`;
  }
  if (first.cost !== second.cost) return `${tieText} so lower cost wins`;
  return `${tieText} so registry order decides`;
}

/**
 * The model router.
 * @param {object} deps
 * @param {string} deps.modelsPath        the registry file (config/models.json)
 * @param {{ usable(providerId: string): boolean, list?(): Array<{ id: string, models: string[]|null }> }} deps.providers
 *        usable() decides if a lab can take work now. list() is optional: the `models` of a lab's status
 *        (the slugs of this account) limit the router to the models on that list.
 * @param {() => object} deps.getSettings  reads `thrift` (0..1) and `allowFallback`
 * @param {(level: string, msg: string, data?: object) => void} [deps.log]
 * @param {() => number} [deps.now]        clock in ms, for scheduled price changes (price.next)
 * @param {string|null} [deps.defaultsPath] the registry the app ships with. It is used when modelsPath
 *                                         does not exist yet. Pass null to switch that off.
 */
export function createRouter({ modelsPath, providers, getSettings, log, now = Date.now, defaultsPath } = {}) {
  if (typeof modelsPath !== 'string' || modelsPath === '') throw new Error('createRouter needs modelsPath');
  const say = safeLog(log);
  const shipped = defaultsPath === undefined ? fileURLToPath(new URL('../config/models.json', import.meta.url)) : defaultsPath;
  let warnedUsable = false;
  let current = load();

  function load() {
    let text;
    let from = modelsPath;
    try {
      text = readFileSync(modelsPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT' || !shipped || shipped === modelsPath) {
        throw fail(`Cannot read the model registry ${modelsPath}: ${err.message}`, 500);
      }
      try {
        text = readFileSync(shipped, 'utf8');
        from = shipped;
      } catch (err2) {
        throw fail(`Cannot read the model registry ${modelsPath} or the shipped copy ${shipped}: ${err2.message}`, 500);
      }
      say('warn', 'router: no registry file yet, using the shipped registry', { modelsPath, shipped });
    }
    let data;
    try {
      // Some editors put a byte order mark in front of the text. JSON.parse does not accept it.
      data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (err) {
      throw fail(`The model registry ${from} is not valid JSON: ${err.message}`, 500);
    }
    try {
      return validateRegistry(data);
    } catch (err) {
      throw fail(`The model registry ${from} is not valid: ${err.message}`, 500);
    }
  }

  /** A private copy of the registry. Change it and pass it to save(). */
  function registry() {
    return structuredClone(current);
  }

  /** Validates the registry, writes it atomically, then routes with it. Returns a copy of what was saved. */
  function save(next) {
    const clean = validateRegistry(next);
    try {
      writeAtomic(modelsPath, `${JSON.stringify(clean, null, 2)}\n`);
    } catch (err) {
      throw fail(`Cannot save the model registry ${modelsPath}: ${err.message}`, 500);
    }
    current = clean;
    say('info', 'router: registry saved', { models: clean.models.length, dataDate: clean.dataDate });
    return registry();
  }

  /** Reads the file again. On an error the registry in memory stays in use and the error is thrown. */
  function reload() {
    current = load();
    return registry();
  }

  function readSettings() {
    let settings = null;
    try {
      settings = typeof getSettings === 'function' ? getSettings() : null;
    } catch (err) {
      say('warn', 'router: getSettings failed, using the default thrift', { error: err?.message ?? String(err) });
    }
    const thrift = isNum(settings?.thrift) ? Math.min(1, Math.max(0, settings.thrift)) : DEFAULT_THRIFT;
    return { thrift, allowFallback: settings?.allowFallback !== false };
  }

  /** Asks the providers module once per lab and pick. Anything but `true` counts as not usable. */
  function usableNow() {
    const memo = new Map();
    return (provider) => {
      if (!memo.has(provider)) {
        let answer = false;
        try {
          answer = providers?.usable?.(provider);
        } catch (err) {
          say('warn', 'router: providers.usable failed', { provider, error: err?.message ?? String(err) });
        }
        if (typeof answer !== 'boolean' && !warnedUsable) {
          warnedUsable = true;
          say('warn', 'router: providers.usable must return true or false', { provider, got: typeof answer });
        }
        memo.set(provider, answer === true);
      }
      return memo.get(provider);
    };
  }

  /**
   * The model lists of the labs, read once per pick from providers.list() (ProviderStatus.models: the
   * slugs of this account, for example from `agy models`). Returns listed(model) -> the efforts that the
   * list has for the model, or null when the lab has a list and the model is not on it.
   * A lab without a list (null, empty, or no providers.list at all) has no limit.
   */
  function listedNow(info) {
    const memo = new Map();
    return (model) => {
      const slugs = info().lists.get(model.provider);
      if (!slugs) return model.efforts;
      if (!memo.has(model.id)) memo.set(model.id, listedEfforts(model, slugs));
      return memo.get(model.id);
    };
  }

  /** providers.list(), read once per pick: the model lists (models) and the cooled models of each lab. */
  function labInfoNow() {
    let info = null;
    return () => {
      if (info) return info;
      info = { lists: new Map(), cooled: new Map() };
      if (typeof providers?.list !== 'function') return info;
      try {
        const statuses = providers.list();
        if (!Array.isArray(statuses)) return info;
        for (const status of statuses) {
          if (!isRecord(status) || typeof status.id !== 'string') continue;
          if (Array.isArray(status.models)) {
            const slugs = status.models.filter((slug) => typeof slug === 'string' && slug !== '');
            if (slugs.length > 0) info.lists.set(status.id, slugs);
          }
          if (isRecord(status.cooledModels)) info.cooled.set(status.id, status.cooledModels);
        }
      } catch (err) {
        say('warn', 'router: providers.list failed, the model lists of the labs are not used', { error: err?.message ?? String(err) });
      }
      return info;
    };
  }

  /**
   * skip(model) -> null when providers.modelUsable(provider, id) is true (or the registry has no modelUsable:
   * an older fake), else the cause: `cooled until <time>`, `not on this account`, or `not usable now`.
   * Asked once per model and pick. The lab itself is checked before (usable).
   */
  function skipNow(info) {
    const memo = new Map();
    return (model) => {
      if (typeof providers?.modelUsable !== 'function') return null;
      if (memo.has(model.id)) return memo.get(model.id);
      let answer = true;
      try {
        answer = providers.modelUsable(model.provider, model.id) === true;
      } catch (err) {
        say('warn', 'router: providers.modelUsable failed', { provider: model.provider, model: model.id, error: err?.message ?? String(err) });
        answer = false;
      }
      let cause = null;
      if (!answer) {
        const cooled = info().cooled.get(model.provider)?.[model.id];
        const until = isRecord(cooled) && isNum(cooled.until) ? cooled.until : null;
        const slugs = info().lists.get(model.provider);
        cause = until !== null && until > now() ? `cooled until ${localTime(until)}`
          : slugs && listedEfforts(model, slugs) === null ? NOT_ON_ACCOUNT : 'not usable now';
      }
      memo.set(model.id, cause);
      return cause;
    };
  }

  /** Runs the pick rule and keeps everything that led to the result. */
  function decide(query) {
    const q = readQuery(query);
    const { thrift, allowFallback } = readSettings();
    const base = { q, thrift, real: null, best: null, fallback: false, pick: null, reason: null };
    if (q === null) return { ...base, reason: 'The role must be boss, manager or maker.' };
    const reg = current;
    const usable = usableNow();
    const info = labInfoNow();
    const listed = listedNow(info);
    const skip = skipNow(info);
    const today = localDate(now());
    let real = evaluate(reg, q, { usable, listed, skip, applyAvoid: true, thrift, today });
    if (real.ranked.length === 0) {
      return { ...base, real, reason: `No enabled model in a usable lab can take the role ${q.role} for this task.` };
    }
    const allUsable = () => true;
    const wanted = evaluate(reg, q, { usable: allUsable, listed, applyAvoid: true, thrift, today }); // every lab and model usable
    const free = evaluate(reg, q, { usable: allUsable, applyAvoid: false, thrift, today }); // no lab avoided, no model list
    let winner = real.ranked[0];
    const wantedTop = wanted.ranked[0];
    const bestTop = free.ranked[0];
    const wantedLab = wantedTop.model.provider;
    // Lab fallback: the pick goes to another lab because the lab, or the model, that should get it is out.
    let fallback = !usable(wantedLab) || (skip(wantedTop.model) !== null && winner.model.provider !== wantedLab);
    const best = {
      id: bestTop.model.id, provider: bestTop.model.provider, label: bestTop.model.label, key: free.key, value: bestTop.value,
    };
    if (fallback && !allowFallback) {
      // allowFallback keeps its meaning per model: a cooled model hands the pick to the next model of the SAME
      // lab (any tier the role allows). Only a lab with no model left that fits means "wait" (null).
      const sameLab = usable(wantedLab)
        ? evaluate(reg, q, { usable: (provider) => provider === wantedLab && usable(provider), listed, skip, applyAvoid: true, thrift, today })
        : null;
      if (!sameLab || sameLab.ranked.length === 0) {
        const cause = usable(wantedLab) ? `that model is ${skip(wantedTop.model)}, no other model of the lab fits,` : 'that lab is not usable';
        const reason = `${wantedTop.model.label} (${wantedLab}) is the pick, but ${cause} and lab fallback is off.`;
        return { ...base, real, best, fallback, reason };
      }
      real = sameLab;
      winner = real.ranked[0];
      fallback = false;
    }

    // The sentence.
    const cat = reg.categories[real.key];
    const second = real.ranked[1];
    const domain = q.domain && Object.hasOwn(reg.domains, q.domain) ? q.domain : 'general';
    let head = `${domain}: ${real.key} ${winner.missing ? 'none' : winner.value}`;
    if (second) head += ` vs ${second.missing ? 'none' : second.value}`;
    head += ` (${cat.source})`;
    const reason = reasonFor(winner, second, cat, q, thrift);
    const notes = [];
    if (real.tier === 'fallback') notes.push(`no primary ${q.role} is available so a fallback-tier model is used`);
    const bestText = `${best.label}: ${best.key} ${best.value ?? 'none'}`;
    const otherLab = best.provider !== winner.model.provider;
    if (otherLab && q.avoid === best.provider) notes.push(`best lab ${best.provider} was avoided (${bestText})`);
    else if (otherLab && !usable(best.provider)) notes.push(`best lab ${best.provider} is not usable (${bestText})`);
    else if (best.id !== winner.model.id && listed(bestTop.model) === null) {
      notes.push(`best model ${best.label} is ${NOT_ON_ACCOUNT} (${best.key} ${best.value ?? 'none'})`);
    } else if (best.id !== winner.model.id && skip(bestTop.model) !== null) {
      // the cause when the best model was skipped: `cooled until <time>` or `not on this account`
      notes.push(`best model ${best.label} is ${skip(bestTop.model)} (${best.key} ${best.value ?? 'none'})`);
    }
    if (q.avoid !== null && winner.model.provider === q.avoid) {
      notes.push(`${q.avoid} could not be avoided because no other lab can take the role now`);
    }
    const why = `${head}${reason ? `, ${reason}` : ''}, thrift ${round6(thrift)}${notes.map((note) => `; ${note}`).join('')}`;
    const pick = {
      provider: winner.model.provider,
      model: winner.model.id,
      label: winner.model.label,
      effort: effortFor(q.role, q.size, listed(winner.model) ?? winner.model.efforts),
      why,
    };
    return { ...base, real, best, fallback, pick };
  }

  /**
   * Picks a model.
   * @param {{ role: 'boss'|'manager'|'maker', domain?: string, size?: 'S'|'M'|'L', avoidProvider?: string,
   *           preferProvider?: string, labLoad?: Record<string, number>, exclude?: string[], bump?: number }} query
   * @returns {{ provider: string, model: string, label: string, effort: string|null, why: string } | null}
   */
  function pick(query) {
    const result = decide(query);
    say('debug', 'router: pick', {
      role: result.q?.role ?? null, domain: result.q?.domain ?? null, size: result.q?.size ?? null,
      model: result.pick?.model ?? null, why: result.pick?.why ?? result.reason,
    });
    return result.pick;
  }

  const publicRow = (row, rank, key) => ({
    rank, id: row.model.id, provider: row.model.provider, label: row.model.label, power: row.model.power,
    key, value: row.value, missing: row.missing, band: row.band, q: round6(row.q),
    cost: round6(row.cost), c: round6(row.c), utility: round6(row.utility), tieGroup: row.group,
  });

  /** The full candidate table behind a pick: scores, costs, utilities, who was left out and why. */
  function explain(query) {
    const result = decide(query);
    const { q, real } = result;
    const cat = real?.key ? current.categories[real.key] : null;
    return {
      query: q === null ? null : {
        role: q.role, domain: q.domain, size: q.size, avoidProvider: q.avoid, preferProvider: q.prefer,
        labLoad: { ...q.labLoad }, exclude: [...q.exclude], bump: q.bump,
      },
      thrift: result.thrift,
      tier: real?.tier ?? null,
      minPower: real?.minPower ?? null,
      key: real?.key ?? null,
      keyLabel: cat?.label ?? null,
      source: cat?.source ?? null,
      scale: cat?.scale ?? null,
      tie: cat?.tie ?? null,
      lowerIsBetter: cat ? cat.lowerIsBetter === true : null,
      keysTried: real?.tried ?? [],
      candidates: (real?.ranked ?? []).map((row, i) => publicRow(row, i + 1, real.key)),
      rejected: real?.rejected ?? [],
      avoided: real?.avoided ?? false, // true when avoidProvider took that lab out
      best: result.best, // the model that wins when every lab is usable, no lab is avoided and no model list is in the way
      fallback: result.fallback, // true when the lab that should get this pick is not usable now
      pick: result.pick,
      reason: result.reason, // why there is no pick
    };
  }

  /**
   * For the Models panel: per domain and role, the candidates in the order the router ranks them when
   * every lab is usable. `value` (also given as `score`) is the model's number on `key`.
   */
  function leaders() {
    const reg = current;
    const { thrift } = readSettings();
    const today = localDate(now());
    const out = {};
    for (const domain of Object.keys(reg.domains)) {
      out[domain] = {};
      for (const role of ROLES) {
        const q = readQuery({ role, domain });
        const { ranked, key } = evaluate(reg, q, { usable: () => true, applyAvoid: false, thrift, today });
        out[domain][role] = ranked.map((row, i) => ({
          rank: i + 1, id: row.model.id, label: row.model.label, provider: row.model.provider,
          key, value: row.value, score: row.value, q: round6(row.q), utility: round6(row.utility),
        }));
      }
    }
    return out;
  }

  return { registry, save, reload, pick, leaders, explain };
}
