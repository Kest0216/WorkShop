// Phase 1 RFT Training Requisition Queue: tracks specialty gaps encountered during Phase 0 execution,
// packages candidate OSS model + Harness Rack + eval rubric specs, and enrolls completed checkpoints into the Employee Book.
import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS } from './router.js';

export const REQ_STATUSES = Object.freeze(['queued_phase1', 'enrolled', 'dismissed']);
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

const CANDIDATE_MODEL_BY_DOMAIN = Object.freeze({
  algo: 'deepseek-r1-32b',
  data: 'deepseek-r1-32b',
  vision: 'qwen2.5-vl-32b',
  frontend: 'qwen3-coder-32b',
  backend: 'qwen3-coder-32b',
  fix: 'deepseek-r1-32b',
  test: 'devstral-24b',
  review: 'devstral-24b',
  research: 'gemma-3-27b-it',
  synthesis: 'gemma-3-27b-it',
  docs: 'gemma-3-27b-it',
  chore: 'qwen3-coder-32b',
  plan: 'llama-4-scout-17b',
});

const SUGGESTED_NAME_BY_DOMAIN = Object.freeze({
  algo: 'Euler',
  data: 'Pipeline',
  vision: 'Optic',
  research: 'Flux',
  synthesis: 'Synthesis',
  docs: 'Folio',
  backend: 'Sprocket',
  frontend: 'Dovetail',
  fix: 'Rivet',
  test: 'Caliper',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function safeLog(log) {
  if (typeof log !== 'function') return () => {};
  return (level, msg, data) => {
    try { log(level, msg, data); } catch { /* ignore */ }
  };
}

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      if (fd !== null) fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
    } catch { /* keep primary error */ }
    throw err;
  }
}

function slugId(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-_]+$/g, '')
    .slice(0, 36);
}

/**
 * Create the Phase 1 RFT requisition queue backed by `<dataDir>/requisitions.json`.
 * @param {{ dataDir: string, roster?: object, harnesses?: object, log?: Function, now?: () => number }} deps
 */
export function createTraining({ dataDir, roster = null, harnesses = null, log, now = () => Date.now() } = {}) {
  if (!dataDir) throw new Error('createTraining needs dataDir');
  const say = safeLog(log);
  const file = path.join(dataDir, 'requisitions.json');
  const listeners = new Set();

  function loadInitial() {
    if (!fs.existsSync(file)) return { v: 1, nextSeq: 1, items: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error('bad format');
      let maxSeq = Number.isInteger(raw.nextSeq) && raw.nextSeq > 0 ? raw.nextSeq : 1;
      for (const item of raw.items) {
        const m = /^TR(\d+)$/.exec(item?.id || '');
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]) + 1);
      }
      return { v: 1, nextSeq: maxSeq, items: raw.items.filter(isObj) };
    } catch (err) {
      try { fs.renameSync(file, `${file}.bak`); } catch { /* ignore */ }
      say('warn', 'training: corrupt requisitions.json, starting empty', { error: err?.message });
      return { v: 1, nextSeq: 1, items: [] };
    }
  }

  let state = loadInitial();

  function emit() {
    const items = list();
    for (const fn of [...listeners]) {
      try { fn(items); } catch (err) { say('error', 'training: onChange listener failed', { error: err?.message }); }
    }
  }

  function persist() {
    writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    emit();
  }

  function list({ status = null } = {}) {
    const items = state.items.filter((x) => !status || x.status === status);
    return JSON.parse(JSON.stringify(items));
  }

  function get(id) {
    const found = state.items.find((x) => x.id === id);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  function createRequisition(spec = {}) {
    if (!isObj(spec)) throw fail('Requisition must be an object.');
    const domain = typeof spec.domain === 'string' && DOMAINS.includes(spec.domain) ? spec.domain : null;
    if (!domain) throw fail(`Requisition requires a valid domain (${DOMAINS.join(', ')}).`);
    const harness = (spec.harnessId && harnesses?.get?.(spec.harnessId))
      || harnesses?.forDomain?.(domain)
      || null;
    const harnessId = (harness && harness.id) || (typeof spec.harnessId === 'string' && ID_RE.test(spec.harnessId) ? spec.harnessId : 'fullstack-node');
    const candidateBaseModel = typeof spec.candidateBaseModel === 'string' && spec.candidateBaseModel.trim()
      ? spec.candidateBaseModel.trim()
      : (CANDIDATE_MODEL_BY_DOMAIN[domain] || 'qwen3-coder-32b');
    const reason = ['missing_specialty', 'uncertified_specialist', 'manual'].includes(spec.reason)
      ? spec.reason
      : 'missing_specialty';

    // Deduplicate active Phase 1 requisitions for the same (domain, harnessId, candidateBaseModel).
    const existing = state.items.find((item) => (
      item.status === 'queued_phase1'
      && item.domain === domain
      && item.harnessId === harnessId
      && item.candidateBaseModel === candidateBaseModel
    ));
    if (existing) {
      let changed = false;
      if (spec.taskId && Array.isArray(existing.linkedTasks) && !existing.linkedTasks.includes(spec.taskId)) {
        existing.linkedTasks.push(spec.taskId);
        existing.updatedAt = now();
        changed = true;
      }
      if (changed) persist();
      return JSON.parse(JSON.stringify(existing));
    }

    const id = `TR${state.nextSeq++}`;
    const ts = now();
    const rewardSignals = Array.isArray(harness?.rft?.rewardSignals) && harness.rft.rewardSignals.length > 0
      ? [...harness.rft.rewardSignals]
      : ['check_cmd_exit_zero', 'diff_minimality'];
    const evalSuite = harness?.rft?.evalSuite || `suites/${domain}-v0`;

    const req = {
      id,
      status: 'queued_phase1',
      createdAt: ts,
      updatedAt: ts,
      jobId: spec.jobId ?? null,
      taskId: spec.taskId ?? null,
      linkedTasks: spec.taskId ? [spec.taskId] : [],
      domain,
      reason,
      suggestedName: typeof spec.suggestedName === 'string' && spec.suggestedName.trim()
        ? spec.suggestedName.trim().slice(0, 40)
        : (SUGGESTED_NAME_BY_DOMAIN[domain] || `Spec-${domain}`),
      candidateBaseModel,
      harnessId,
      fallbackModel: typeof spec.fallbackModel === 'string' ? spec.fallbackModel : null,
      rftSpec: {
        phase: 1,
        pipeline: 'rft-grpo-v0',
        rewardSignals,
        evalSuite,
        validityGates: ['pass_at_1 >= 0.75', 'zero_sandbox_violations', 'diff_cleanliness'],
      },
      notes: typeof spec.notes === 'string' && spec.notes.trim()
        ? spec.notes.trim().slice(0, 400)
        : `Phase 1 RFT requisition for "${domain}" using ${candidateBaseModel} + harness "${harnessId}".`,
      enrolledRosterId: null,
    };
    state.items.unshift(req);
    persist();
    return JSON.parse(JSON.stringify(req));
  }

  function enroll(id, opts = {}) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) throw fail(`Unknown requisition: ${id}`, 404);
    const req = state.items[idx];
    if (req.status === 'enrolled' && req.enrolledRosterId) {
      return { requisition: get(id), entry: roster?.get?.(req.enrolledRosterId) ?? null };
    }
    const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 40) : req.suggestedName;
    const baseModel = typeof opts.baseModel === 'string' && opts.baseModel.trim() ? opts.baseModel.trim() : req.candidateBaseModel;
    const harnessId = typeof opts.harnessId === 'string' && opts.harnessId.trim() ? opts.harnessId.trim() : req.harnessId;
    const checkpoint = typeof opts.checkpoint === 'string' && opts.checkpoint.trim()
      ? opts.checkpoint.trim()
      : `oss://${baseModel}-${req.domain}-rft-v1`;
    const specialties = Array.isArray(opts.specialties) && opts.specialties.length > 0 ? opts.specialties : [req.domain];

    let entry = null;
    if (roster) {
      const existingMatch = roster.list().find((e) => e.name.toLowerCase() === name.toLowerCase());
      const rosterId = existingMatch ? existingMatch.id : (`spec-${slugId(name)}` || `spec-${id.toLowerCase()}`);
      entry = roster.upsert({
        ...(existingMatch || {}),
        id: rosterId,
        name,
        role: existingMatch?.role || 'maker',
        title: typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : `${req.domain.toUpperCase()} Specialist (RFT)`,
        baseModel,
        checkpoint,
        harnessId,
        specialties: existingMatch ? [...new Set([...existingMatch.specialties, ...specialties])] : specialties,
        certification: 'curated',
        enabled: true,
        style: existingMatch?.style || { seed: 2500 + state.nextSeq, hat: 'goggles', tool: 'wrench' },
      });
    }

    req.status = 'enrolled';
    req.updatedAt = now();
    req.enrolledRosterId = entry?.id ?? null;
    persist();
    return { requisition: get(id), entry };
  }

  function dismiss(id) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) throw fail(`Unknown requisition: ${id}`, 404);
    state.items[idx].status = 'dismissed';
    state.items[idx].updatedAt = now();
    persist();
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
    createRequisition,
    enroll,
    dismiss,
    onChange,
  };
}
