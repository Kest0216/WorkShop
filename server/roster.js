// The Employee Book / Rolodex: catalog of persistent Open-Source Specialists & Team Leads,
// mapping named characters to open-weight base models/checkpoints, default harnesses, specialties, and RFT certification.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS } from './router.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_ROSTER_FILE = path.join(MODULE_DIR, '..', 'config', 'roster.json');

export const ROSTER_ROLES = Object.freeze(['maker', 'manager']);
export const CERTIFICATIONS = Object.freeze(['curated', 'base_untrained', 'training_queued']);
export const HATS = Object.freeze(['none', 'cap', 'beanie', 'visor', 'hardhat', 'goggles', 'headset', 'bandana']);
export const GEAR_TOOLS = Object.freeze(['wrench', 'hammer', 'iron', 'brush', 'magnifier', 'clipboard', 'pencil', 'calipers', 'saw']);

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
const MAX_ENTRIES = 120;
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
  const checkpoint = input.checkpoint == null || input.checkpoint === '' ? null : String(input.checkpoint).trim();
  if (checkpoint !== null && checkpoint.length > 160) throw fail(`${where}.checkpoint must be at most 160 characters.`);
  const harnessId = typeof input.harnessId === 'string' ? input.harnessId.trim() : '';
  if (!ID_RE.test(harnessId)) throw fail(`${where}.harnessId must be a valid harness id.`);
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
    throw fail(`${where}.certification must be "curated", "base_untrained", or "training_queued".`);
  }
  const enabled = input.enabled !== false;

  const rawStyle = isObj(input.style) ? input.style : {};
  const seed = Number.isInteger(rawStyle.seed) && rawStyle.seed > 0 ? rawStyle.seed : 2000 + index + 1;
  const hat = typeof rawStyle.hat === 'string' && HATS.includes(rawStyle.hat) ? rawStyle.hat : (role === 'manager' ? 'hardhat' : 'cap');
  const tool = typeof rawStyle.tool === 'string' && GEAR_TOOLS.includes(rawStyle.tool) ? rawStyle.tool : (role === 'manager' ? 'clipboard' : 'wrench');

  const rawRec = isObj(input.record) ? input.record : {};
  const tasksCompleted = Number.isInteger(rawRec.tasksCompleted) && rawRec.tasksCompleted >= 0 ? rawRec.tasksCompleted : 0;
  const reworks = Number.isInteger(rawRec.reworks) && rawRec.reworks >= 0 ? rawRec.reworks : 0;

  return {
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
  };
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
 * Create the Employee Book (`<configDir>/roster.json`).
 * @param {{ configDir: string, harnesses?: object, log?: Function, now?: () => number }} deps
 */
export function createRoster({ configDir, harnesses = null, log, now = () => Date.now() } = {}) {
  if (!configDir) throw new Error('createRoster needs configDir');
  const say = safeLog(log);
  const file = path.join(configDir, 'roster.json');
  const listeners = new Set();

  function loadInitial() {
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

  let data = loadInitial();

  function emit() {
    const snapshot = list();
    for (const fn of [...listeners]) {
      try { fn(snapshot); } catch (err) { say('error', 'roster: onChange listener failed', { error: err?.message }); }
    }
  }

  function persist(next) {
    const clean = validateRoster({
      ...next,
      updatedAt: new Date(now()).toISOString().slice(0, 10),
    });
    if (harnesses) {
      for (const e of clean.entries) {
        if (!harnesses.get(e.harnessId)) throw fail(`Roster entry "${e.id}" references unknown harness "${e.harnessId}".`);
      }
    }
    writeAtomic(file, `${JSON.stringify(clean, null, 2)}\n`);
    data = clean;
    emit();
    return list();
  }

  function list({ role = null, enabledOnly = false } = {}) {
    return copyJson(
      data.entries.filter((e) => (!role || e.role === role) && (!enabledOnly || e.enabled)),
    );
  }

  function get(id) {
    if (typeof id !== 'string' || !id) return null;
    const found = data.entries.find((e) => e.id === id);
    return found ? copyJson(found) : null;
  }

  function save(input) {
    return persist(input);
  }

  function upsert(input) {
    const entry = normalizeEntry(copyJson(input), 0);
    if (harnesses && !harnesses.get(entry.harnessId)) {
      throw fail(`Unknown harness "${entry.harnessId}" for roster entry "${entry.id}".`);
    }
    const entries = [...data.entries];
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    persist({ ...data, entries });
    return get(entry.id);
  }

  function remove(id) {
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw fail(`Unknown roster entry: ${id}`, 404);
    const entries = data.entries.filter((e) => e.id !== id);
    persist({ ...data, entries });
    return { ok: true, id };
  }

  /**
   * Match the best Specialist or Team Lead for `domain`.
   * Ranks enabled entries matching `role` by: exact specialty + curated RFT, then exact specialty + uncertified,
   * otherwise returns best available fallback alongside `needsRft: true, reason: 'missing_specialty'`.
   */
  function match({ domain, role = 'maker', excludeIds = [] } = {}) {
    const wantedRole = role === 'manager' ? 'manager' : 'maker';
    const excluded = new Set(Array.isArray(excludeIds) ? excludeIds : []);
    const allForRole = data.entries.filter((e) => e.enabled && e.role === wantedRole);
    const pool = allForRole.filter((e) => !excluded.has(e.id));
    const candidates = pool.length > 0 ? pool : allForRole;

    const score = (e) => {
      const exact = e.specialties.includes(domain);
      const certified = e.certification === 'curated';
      const netGood = (e.record.tasksCompleted || 0) - (e.record.reworks || 0);
      return (exact ? 1000 : 0) + (certified ? 200 : 0) + netGood;
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
    const certified = best.certification === 'curated';
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

  function recordOutcome(id, { merged = false, reworked = false } = {}) {
    if (!id) return null;
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const entries = copyJson(data.entries);
    if (merged) entries[idx].record.tasksCompleted += 1;
    if (reworked) entries[idx].record.reworks += 1;
    persist({ ...data, entries });
    return get(id);
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
    onChange,
  };
}
