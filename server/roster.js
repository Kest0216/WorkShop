// The Employee Handbook / Book: catalog of persistent Open-Source Specialists & Team Leads,
// mapping named characters to open-weight base models + RL checkpoints, equipped harnesses & tool belts,
// post-RL Verification & QA benchmark scores, and live +1 / -1 / 0 Owner Ship Ratings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS } from './router.js';
import { HARNESS_TOOLS } from './harnesses.js';
import { isClosedModel } from './rlport.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_ROSTER_FILE = path.join(MODULE_DIR, '..', 'config', 'roster.json');

export const ROSTER_ROLES = Object.freeze(['maker', 'manager']);
export const CERTIFICATIONS = Object.freeze(['curated', 'sim_trained', 'base_untrained', 'training_queued']);
export const HATS = Object.freeze(['none', 'cap', 'beanie', 'visor', 'hardhat', 'goggles', 'headset', 'bandana']);
export const GEAR_TOOLS = Object.freeze(['wrench', 'hammer', 'iron', 'brush', 'magnifier', 'clipboard', 'pencil', 'calipers', 'saw']);

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
const MAX_ENTRIES = 120;
const MAX_RATING_HISTORY = 25;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function safeLog(log) {
  if (typeof log !== 'function') return () => {};
  return (level, msg, data) => {
    try { log(level, msg, data); } catch { /* logging must never throw */ }
  };
}

function copyJson(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return undefined;
  return JSON.parse(text, (key, child) => (UNSAFE_KEYS.has(key) ? undefined : child));
}

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
    } catch { /* keep the primary error */ }
    throw err;
  }
}

function normalizeRatings(rawRatings) {
  const r = isObj(rawRatings) ? rawRatings : {};
  const shipped = Number.isInteger(r.shipped) && r.shipped >= 0 ? r.shipped : 0;
  const denied = Number.isInteger(r.denied) && r.denied >= 0 ? r.denied : 0;
  const discarded = Number.isInteger(r.discarded) && r.discarded >= 0 ? r.discarded : 0;
  const rawHistory = Array.isArray(r.history) ? r.history : [];
  const history = [];
  for (const item of rawHistory.slice(0, MAX_RATING_HISTORY)) {
    if (!isObj(item)) continue;
    const outcome = ['shipped', 'denied', 'discarded'].includes(item.outcome) ? item.outcome : 'shipped';
    const delta = outcome === 'shipped' ? 1 : outcome === 'denied' ? -1 : 0;
    history.push({
      ts: Number.isFinite(Number(item.ts)) ? Number(item.ts) : 0,
      delta,
      outcome,
      jobId: typeof item.jobId === 'string' && item.jobId ? item.jobId.slice(0, 24) : null,
      taskId: typeof item.taskId === 'string' && item.taskId ? item.taskId.slice(0, 24) : null,
      deliveryId: typeof item.deliveryId === 'string' && item.deliveryId ? item.deliveryId.slice(0, 24) : null,
      note: typeof item.note === 'string' ? item.note.trim().slice(0, 240) : '',
    });
  }
  return {
    score: shipped - denied,
    shipped,
    denied,
    discarded,
    history,
  };
}

function normalizeBenchmark(rawBench) {
  if (!isObj(rawBench)) return null;
  const evalScore = Number(rawBench.evalScore);
  const passAt1 = Number(rawBench.passAt1);
  if (!Number.isFinite(evalScore) && !Number.isFinite(passAt1)) return null;
  const portMode = ['local', 'remote', 'sim', 'curated'].includes(rawBench.portMode) ? rawBench.portMode : 'local';
  return {
    evalScore: Number.isFinite(evalScore) ? Math.round(evalScore * 100) / 100 : null,
    passAt1: Number.isFinite(passAt1) ? Math.round(passAt1 * 1000) / 1000 : null,
    portMode,
    verifiedAt: Number.isFinite(Number(rawBench.verifiedAt)) ? Number(rawBench.verifiedAt) : null,
  };
}

export function normalizeEntry(input, index = 0) {
  const where = `Roster entry ${index + 1}`;
  if (!isObj(input)) throw fail(`${where} must be an object.`);
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!ID_RE.test(id)) throw fail(`${where}.id must be 2 to 40 lowercase letters, digits, underscores, or dashes.`);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 40) throw fail(`${where}.name must have 1 to 40 characters.`);
  const role = input.role == null || input.role === '' ? 'maker' : String(input.role);
  if (!ROSTER_ROLES.includes(role)) throw fail(`${where}.role must be "maker" or "manager".`);
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().slice(0, 80)
    : (role === 'manager' ? 'Team Lead' : 'Specialist');
  const baseModel = typeof input.baseModel === 'string' ? input.baseModel.trim() : '';
  if (!MODEL_RE.test(baseModel)) throw fail(`${where}.baseModel must be a valid model id.`);
  if (isClosedModel(baseModel)) {
    throw fail(`${where}.baseModel ("${baseModel}") is a closed-source model and cannot be trained or enrolled in the Employee Handbook.`);
  }
  const checkpoint = input.checkpoint == null || input.checkpoint === '' ? null : String(input.checkpoint).trim();
  if (checkpoint !== null && checkpoint.length > 160) throw fail(`${where}.checkpoint must be at most 160 characters.`);
  const harnessId = typeof input.harnessId === 'string' ? input.harnessId.trim() : '';
  if (!ID_RE.test(harnessId)) throw fail(`${where}.harnessId must be a valid harness id.`);

  let tools = null;
  if (Array.isArray(input.tools) && input.tools.length > 0) {
    const cleanTools = [];
    const seenTool = new Set();
    for (const t of input.tools) {
      if (typeof t !== 'string' || !HARNESS_TOOLS.includes(t.trim())) {
        throw fail(`${where}.tools: unsupported tool "${String(t)}".`);
      }
      const trimmed = t.trim();
      if (!seenTool.has(trimmed)) { seenTool.add(trimmed); cleanTools.push(trimmed); }
    }
    tools = cleanTools;
  }

  if (!Array.isArray(input.specialties) || input.specialties.length === 0) {
    throw fail(`${where}.specialties must list at least one domain.`);
  }
  const specialties = [];
  const seenDom = new Set();
  for (const d of input.specialties) {
    if (typeof d !== 'string' || !DOMAINS.includes(d)) throw fail(`${where}.specialties: unknown domain "${String(d)}".`);
    if (!seenDom.has(d)) { seenDom.add(d); specialties.push(d); }
  }
  const certification = input.certification == null || input.certification === '' ? 'base_untrained' : String(input.certification);
  if (!CERTIFICATIONS.includes(certification)) {
    throw fail(`${where}.certification must be "curated", "sim_trained", "base_untrained", or "training_queued".`);
  }
  const enabled = input.enabled !== false;

  const rawStyle = isObj(input.style) ? input.style : {};
  const seed = Number.isInteger(rawStyle.seed) && rawStyle.seed > 0 ? rawStyle.seed : 2000 + index + 1;
  const hat = typeof rawStyle.hat === 'string' && HATS.includes(rawStyle.hat) ? rawStyle.hat : (role === 'manager' ? 'hardhat' : 'cap');
  const tool = typeof rawStyle.tool === 'string' && GEAR_TOOLS.includes(rawStyle.tool) ? rawStyle.tool : (role === 'manager' ? 'clipboard' : 'wrench');

  const rawRec = isObj(input.record) ? input.record : {};
  const tasksCompleted = Number.isInteger(rawRec.tasksCompleted) && rawRec.tasksCompleted >= 0 ? rawRec.tasksCompleted : 0;
  const reworks = Number.isInteger(rawRec.reworks) && rawRec.reworks >= 0 ? rawRec.reworks : 0;

  const ratings = normalizeRatings(input.ratings);
  const benchmark = normalizeBenchmark(input.benchmark);

  const out = {
    id,
    name,
    role,
    title,
    baseModel,
    checkpoint,
    harnessId,
    specialties,
    certification,
    enabled,
    style: { seed, hat, tool },
    record: { tasksCompleted, reworks },
    ratings,
    benchmark,
  };
  if (tools) out.tools = tools;
  return out;
}

export function validateRoster(input) {
  if (!isObj(input)) throw fail('The roster must be a JSON object.');
  if (input.version !== 1) throw fail('roster version must be 1.');
  if (!Array.isArray(input.entries)) throw fail('entries must be a list.');
  if (input.entries.length > MAX_ENTRIES) throw fail(`entries must not hold more than ${MAX_ENTRIES} records.`);
  const seen = new Set();
  const entries = [];
  for (let i = 0; i < input.entries.length; i += 1) {
    const e = normalizeEntry(input.entries[i], i);
    if (seen.has(e.id)) throw fail(`Duplicate roster id: "${e.id}".`);
    seen.add(e.id);
    entries.push(e);
  }
  const updatedAt = typeof input.updatedAt === 'string' && input.updatedAt.trim()
    ? input.updatedAt.trim().slice(0, 40)
    : new Date().toISOString().slice(0, 10);
  return { version: 1, updatedAt, entries };
}

const FALLBACK_ROSTER = Object.freeze({
  version: 1,
  updatedAt: '2026-11-16',
  entries: [],
});

function loadShippedRoster() {
  try {
    return validateRoster(JSON.parse(fs.readFileSync(SHIPPED_ROSTER_FILE, 'utf8')));
  } catch {
    return validateRoster(FALLBACK_ROSTER);
  }
}

/**
 * Create the Employee Handbook (`<configDir>/roster.json`), with optional git-ignored personal overlay
 * at `<localDir>/roster.json` so personal forged specialists and ratings never pollute public GitHub commits.
 * @param {{ configDir: string, localDir?: string|null, harnesses?: object, log?: Function, now?: () => number }} deps
 */
export function createRoster({ configDir, localDir = null, harnesses = null, log, now = () => Date.now() } = {}) {
  if (!configDir) throw new Error('createRoster needs configDir');
  const say = safeLog(log);
  const file = path.join(configDir, 'roster.json');
  const localFile = localDir ? path.join(localDir, 'roster.json') : null;
  const listeners = new Set();

  function loadBase() {
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        return validateRoster(raw);
      } catch (err) {
        try { fs.renameSync(file, `${file}.bak`); } catch { /* ignore */ }
        say('warn', 'roster: invalid roster.json, falling back to shipped defaults', { error: err?.message });
      }
    }
    return loadShippedRoster();
  }

  function loadLocalOverlay() {
    if (!localFile || !fs.existsSync(localFile)) return { entries: [], retiredIds: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(localFile, 'utf8').replace(/^\uFEFF/, ''));
      const listRaw = Array.isArray(raw?.entries) ? raw.entries : Array.isArray(raw) ? raw : [];
      const retiredIds = Array.isArray(raw?.retiredIds) ? raw.retiredIds.filter((x) => typeof x === 'string') : [];
      return {
        entries: listRaw.map((e, i) => normalizeEntry(e, i)),
        retiredIds,
      };
    } catch (err) {
      say('warn', 'roster: invalid local/roster.json ignored', { error: err?.message });
      return { entries: [], retiredIds: [] };
    }
  }

  let baseData = loadBase();
  let localState = loadLocalOverlay();

  function mergedData() {
    if (!localState.entries.length && !localState.retiredIds.length) return baseData;
    const retired = new Set(localState.retiredIds);
    const byId = new Map();
    for (const e of baseData.entries) {
      if (!retired.has(e.id)) byId.set(e.id, e);
    }
    for (const e of localState.entries) {
      if (!retired.has(e.id)) byId.set(e.id, e);
    }
    return {
      version: 1,
      updatedAt: baseData.updatedAt,
      entries: [...byId.values()],
    };
  }

  let data = mergedData();

  function emit() {
    const snapshot = list();
    for (const fn of [...listeners]) {
      try { fn(snapshot); } catch (err) { say('error', 'roster: onChange listener failed', { error: err?.message }); }
    }
  }

  function checkHarnesses(entries) {
    if (!harnesses) return;
    for (const e of entries) {
      if (!harnesses.get(e.harnessId)) throw fail(`Roster entry "${e.id}" references unknown harness "${e.harnessId}".`);
    }
  }

  function persistLocal() {
    if (!localFile) return;
    checkHarnesses(localState.entries);
    const doc = {
      version: 1,
      updatedAt: new Date(now()).toISOString().slice(0, 10),
      entries: localState.entries,
      ...(localState.retiredIds.length ? { retiredIds: localState.retiredIds } : {}),
    };
    writeAtomic(localFile, `${JSON.stringify(doc, null, 2)}\n`);
    data = mergedData();
    emit();
  }

  function persistBase(next) {
    const clean = validateRoster({
      ...next,
      updatedAt: new Date(now()).toISOString().slice(0, 10),
    });
    checkHarnesses(clean.entries);
    writeAtomic(file, `${JSON.stringify(clean, null, 2)}\n`);
    baseData = clean;
    data = mergedData();
    emit();
    return list();
  }

  function list({ role = null, enabledOnly = false, certifiedOnly = false, allowSim = true } = {}) {
    return copyJson(
      data.entries.filter((e) => {
        if (role && e.role !== role) return false;
        if (enabledOnly && !e.enabled) return false;
        if (certifiedOnly) {
          if (e.certification === 'curated') return true;
          if (allowSim && e.certification === 'sim_trained') return true;
          return false;
        }
        return true;
      }),
    );
  }

  function get(id) {
    if (typeof id !== 'string' || !id) return null;
    const found = data.entries.find((e) => e.id === id);
    return found ? copyJson(found) : null;
  }

  function save(input) {
    if (localFile && input?.publicRepo !== true) {
      const clean = validateRoster({
        ...input,
        updatedAt: new Date(now()).toISOString().slice(0, 10),
      });
      checkHarnesses(clean.entries);
      localState.entries = clean.entries;
      const keptIds = new Set(clean.entries.map((e) => e.id));
      localState.retiredIds = baseData.entries.filter((e) => !keptIds.has(e.id)).map((e) => e.id);
      persistLocal();
      return list();
    }
    return persistBase(input);
  }

  function upsert(input, { requireExistingOrCertified = false } = {}) {
    const publicRepo = input?.publicRepo === true;
    const existing = typeof input?.id === 'string' ? data.entries.find((e) => e.id === input.id.trim()) : null;
    const mergedInput = existing
      ? {
          ...existing,
          ...copyJson(input),
          record: input.record !== undefined ? input.record : existing.record,
          ratings: input.ratings !== undefined ? input.ratings : existing.ratings,
          benchmark: input.benchmark !== undefined ? input.benchmark : existing.benchmark,
        }
      : copyJson(input);
    const entry = normalizeEntry(mergedInput, 0);
    if (requireExistingOrCertified && !existing && entry.certification !== 'curated' && entry.certification !== 'sim_trained') {
      throw fail('Untrained agents cannot be added directly to the Employee Handbook. Build the agent in the Agent Forge and run it through the RL + QA pipeline first.');
    }
    if (harnesses && !harnesses.get(entry.harnessId)) {
      throw fail(`Unknown harness "${entry.harnessId}" for roster entry "${entry.id}".`);
    }
    if (localFile && !publicRepo) {
      localState.retiredIds = localState.retiredIds.filter((x) => x !== entry.id);
      const idx = localState.entries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) localState.entries[idx] = entry;
      else localState.entries.push(entry);
      persistLocal();
      return get(entry.id);
    }
    const entries = [...baseData.entries];
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    persistBase({ ...baseData, entries });
    return get(entry.id);
  }

  function remove(id) {
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw fail(`Unknown roster entry: ${id}`, 404);
    if (localFile) {
      localState.entries = localState.entries.filter((e) => e.id !== id);
      if (baseData.entries.some((e) => e.id === id) && !localState.retiredIds.includes(id)) {
        localState.retiredIds.push(id);
      }
      persistLocal();
      return { ok: true, id };
    }
    const entries = baseData.entries.filter((e) => e.id !== id);
    persistBase({ ...baseData, entries });
    return { ok: true, id };
  }

  /**
   * Match the best Specialist or Team Lead for `domain`.
   * Ranks enabled entries matching `role` by:
   *   exact specialty + RL-certified, then owner ship rating (`+1 / -1`) + verified RL benchmark + task track record.
   * When `certifiedOnly: true` (real non-demo runs), uncertified entries are never returned as certified matches.
   */
  function match({ domain, role = 'maker', excludeIds = [], certifiedOnly = false, allowSim = false } = {}) {
    const wantedRole = role === 'manager' ? 'manager' : 'maker';
    const excluded = new Set(Array.isArray(excludeIds) ? excludeIds : []);
    const isCert = (e) => e.certification === 'curated' || (allowSim && e.certification === 'sim_trained');
    const allForRole = data.entries.filter((e) => e.enabled && e.role === wantedRole && (!certifiedOnly || isCert(e)));
    const pool = allForRole.filter((e) => !excluded.has(e.id));
    const candidates = pool.length > 0 ? pool : allForRole;

    const score = (e) => {
      const exact = e.specialties.includes(domain);
      const certified = isCert(e);
      const netGood = (e.record?.tasksCompleted || 0) - (e.record?.reworks || 0);
      const ownerRating = (e.ratings?.score || 0) * 8;
      const benchBonus = e.benchmark?.evalScore ? (e.benchmark.evalScore - 70) * 0.5 : 0;
      return (exact ? 1000 : 0) + (certified ? 200 : 0) + ownerRating + benchBonus + netGood;
    };

    const sorted = [...candidates].sort((a, b) => score(b) - score(a));
    const best = sorted[0] ? copyJson(sorted[0]) : null;
    if (!best) {
      return {
        entry: null,
        certified: false,
        exactDomain: false,
        needsRft: true,
        reason: 'missing_specialty',
      };
    }
    const exactDomain = best.specialties.includes(domain);
    const certified = isCert(best);
    if (exactDomain && certified) {
      return { entry: best, certified: true, exactDomain: true, needsRft: false, reason: null };
    }
    return {
      entry: best,
      certified: false,
      exactDomain,
      needsRft: true,
      reason: exactDomain ? 'uncertified_specialist' : 'missing_specialty',
    };
  }

  function mutateEntry(id, mutator) {
    if (!id) return null;
    const found = data.entries.find((e) => e.id === id);
    if (!found) return null;
    const draft = copyJson(found);
    mutator(draft);
    return upsert(draft);
  }

  function recordOutcome(id, { merged = false, reworked = false } = {}) {
    return mutateEntry(id, (entry) => {
      if (merged) entry.record.tasksCompleted += 1;
      if (reworked) entry.record.reworks += 1;
    });
  }

  /**
   * Record owner verdict at work completion:
   *   - Ship (`delta: +1`, `outcome: 'shipped'`) -> +1 to specialist rating
   *   - Deny / Request Changes (`delta: -1`, `outcome: 'denied'`) -> -1 to specialist rating
   *   - Discard (`delta: 0`, `outcome: 'discarded'`) -> neutral (0 score change)
   */
  function recordRating(id, { delta = 0, outcome = null, jobId = null, taskId = null, deliveryId = null, note = '' } = {}) {
    const resolvedOutcome = outcome || (delta > 0 ? 'shipped' : delta < 0 ? 'denied' : 'discarded');
    if (!['shipped', 'denied', 'discarded'].includes(resolvedOutcome)) {
      throw fail('Rating outcome must be "shipped", "denied", or "discarded".');
    }
    const resolvedDelta = resolvedOutcome === 'shipped' ? 1 : resolvedOutcome === 'denied' ? -1 : 0;
    return mutateEntry(id, (entry) => {
      const r = normalizeRatings(entry.ratings);
      // Prevent double-counting the exact same delivery verdict
      if (deliveryId && r.history.some((h) => h.deliveryId === deliveryId && h.outcome === resolvedOutcome)) {
        entry.ratings = r;
        return;
      }
      if (resolvedOutcome === 'shipped') r.shipped += 1;
      else if (resolvedOutcome === 'denied') r.denied += 1;
      else r.discarded += 1;
      r.score = r.shipped - r.denied;
      r.history.unshift({
        ts: now(),
        delta: resolvedDelta,
        outcome: resolvedOutcome,
        jobId: jobId ? String(jobId).slice(0, 24) : null,
        taskId: taskId ? String(taskId).slice(0, 24) : null,
        deliveryId: deliveryId ? String(deliveryId).slice(0, 24) : null,
        note: String(note || '').trim().slice(0, 240),
      });
      if (r.history.length > MAX_RATING_HISTORY) r.history.length = MAX_RATING_HISTORY;
      entry.ratings = r;
    });
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange needs a function');
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  return {
    list,
    get,
    save,
    upsert,
    remove,
    match,
    recordOutcome,
    recordRating,
    onChange,
  };
}
