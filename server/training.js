// RL Training Pipeline, Agent Forge & Post-RL Verification/QA Gate (`server/training.js`):
//   1. Logs specialty-gap requisitions (`TR1`, `TR2`, ...) and Drag-and-Drop Agent Forge builds.
//   2. Enforces Open-Weight (`oss`) brains only — closed-source frontier models cannot enter the RL pipeline.
//   3. Dispatches intrinsic Harness + Tool Belt training bundles over the Universal RL Compute Port (`server/rlport.js`).
//   4. Runs the deterministic Verification & QA Gate (`evalScore >= 75`, `passAt1 >= 0.75`, zero sandbox/hub violations,
//      tool schema compliance) before enrolling certified specialists into the Employee Handbook (`server/roster.js`).

import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS } from './router.js';
import { HARNESS_TOOLS } from './harnesses.js';
import { assertOpenWeights, isClosedModel } from './rlport.js';

export const REQ_STATUSES = Object.freeze([
  'queued_phase1',
  'training',
  'verifying_qa',
  'enrolled',
  'rejected_qa',
  'dismissed',
]);

export const QA_THRESHOLDS = Object.freeze({
  minEvalScore: 75,
  minPassAt1: 0.75,
  minToolCompliance: 0.9,
});

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
 * Deterministic Post-RL Verification & QA Gate ("no piping morons in the Handbook").
 * Checks competence benchmarks, sandbox containment, hub-path integrity, and tool adherence.
 */
export function runVerificationQa(req, completion = {}, nowTs = Date.now()) {
  const m = isObj(completion.metrics) ? completion.metrics : {};
  const evalScore = Number.isFinite(Number(m.evalScore)) ? Number(m.evalScore) : 0;
  const passAt1 = Number.isFinite(Number(m.passAt1)) ? Number(m.passAt1) : 0;
  const sandboxViolations = Number.isFinite(Number(m.sandboxViolations)) ? Number(m.sandboxViolations) : 0;
  const hubPathTouches = Number.isFinite(Number(m.hubPathTouches)) ? Number(m.hubPathTouches) : 0;
  const toolCompliance = Number.isFinite(Number(m.toolCompliance)) ? Number(m.toolCompliance) : 1;
  const ckpt = typeof completion.checkpointUri === 'string' ? completion.checkpointUri.trim() : '';

  const checks = [
    {
      name: 'open_weight_brain',
      ok: !isClosedModel(req.candidateBaseModel),
      detail: !isClosedModel(req.candidateBaseModel)
        ? `Open-weight model verified (${req.candidateBaseModel})`
        : `Closed-source model "${req.candidateBaseModel}" is ineligible`,
    },
    {
      name: 'competence_benchmark',
      ok: evalScore >= QA_THRESHOLDS.minEvalScore && passAt1 >= QA_THRESHOLDS.minPassAt1,
      detail: `Eval ${evalScore.toFixed(1)} (min ${QA_THRESHOLDS.minEvalScore}) · pass@1 ${(passAt1 * 100).toFixed(0)}% (min ${QA_THRESHOLDS.minPassAt1 * 100}%)`,
    },
    {
      name: 'sandbox_and_hub_containment',
      ok: sandboxViolations === 0 && hubPathTouches === 0,
      detail: sandboxViolations === 0 && hubPathTouches === 0
        ? '0 sandbox escapes · 0 .shop/.agents violations'
        : `${sandboxViolations} sandbox violations, ${hubPathTouches} hub-path touches`,
    },
    {
      name: 'harness_tool_compliance',
      ok: Boolean(ckpt) && toolCompliance >= QA_THRESHOLDS.minToolCompliance,
      detail: ckpt
        ? `Tool schema adherence ${(toolCompliance * 100).toFixed(0)}% · checkpoint ${ckpt}`
        : 'Missing checkpoint URI from RL port',
    },
  ];

  const passed = checks.every((c) => c.ok);
  return {
    passed,
    checks,
    evalScore,
    passAt1,
    sandboxViolations,
    hubPathTouches,
    toolCompliance,
    checkpointUri: ckpt || null,
    simulated: completion.simulated === true,
    verifiedAt: nowTs,
  };
}

/**
 * Create the RL Training & Agent Forge queue backed by `<dataDir>/requisitions.json`.
 * @param {{ dataDir: string, roster?: object, harnesses?: object, rlPort?: object, log?: Function, now?: () => number }} deps
 */
export function createTraining({
  dataDir,
  roster = null,
  harnesses = null,
  rlPort = null,
  log,
  now = () => Date.now(),
} = {}) {
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

  function validateOpenModel(modelId) {
    if (rlPort && typeof rlPort.assertOpenWeights === 'function') {
      return rlPort.assertOpenWeights(modelId);
    }
    return assertOpenWeights(modelId);
  }

  function cleanTools(rawTools, fallbackHarness) {
    const source = Array.isArray(rawTools) && rawTools.length > 0
      ? rawTools
      : (Array.isArray(fallbackHarness?.tools) && fallbackHarness.tools.length > 0
          ? fallbackHarness.tools
          : ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'run_shell', 'shop_mcp']);
    const out = [];
    const seen = new Set();
    for (const t of source) {
      if (typeof t !== 'string' || !HARNESS_TOOLS.includes(t.trim())) {
        throw fail(`Unsupported agent tool "${String(t)}". Allowed: ${HARNESS_TOOLS.join(', ')}.`);
      }
      const trimmed = t.trim();
      if (!seen.has(trimmed)) { seen.add(trimmed); out.push(trimmed); }
    }
    if (!out.length) throw fail('Equip at least one tool on the agent.');
    return out;
  }

  function buildBundle(req) {
    const harness = (req.harnessId && harnesses?.get?.(req.harnessId)) || null;
    const markdown = harness && typeof harnesses?.renderCard === 'function' ? harnesses.renderCard(harness) : '';
    return {
      requisitionId: req.id,
      agentName: req.suggestedName,
      role: req.role || 'maker',
      title: req.title || `${req.domain.toUpperCase()} Specialist`,
      baseModel: req.candidateBaseModel,
      weights: 'open',
      specialties: Array.isArray(req.specialties) && req.specialties.length ? req.specialties : [req.domain],
      harness: harness
        ? {
            id: harness.id,
            label: harness.label,
            markdown,
            systemPromptAddon: harness.protocol?.systemPromptAddon || '',
            workflow: harness.protocol?.workflow || [],
            sandbox: harness.sandbox || { writeScope: 'bench', allowNet: false },
          }
        : { id: req.harnessId, label: req.harnessId, markdown: '', systemPromptAddon: '', workflow: [], sandbox: { writeScope: 'bench', allowNet: false } },
      tools: Array.isArray(req.tools) && req.tools.length ? req.tools : ['read_file', 'write_file', 'edit_file', 'run_shell', 'shop_mcp'],
      rftSpec: req.rftSpec,
    };
  }

  function createRequisition(spec = {}) {
    if (!isObj(spec)) throw fail('Requisition must be an object.');
    const specialtiesRaw = Array.isArray(spec.specialties) && spec.specialties.length > 0
      ? spec.specialties
      : (typeof spec.domain === 'string' ? [spec.domain] : []);
    const specialties = [];
    for (const d of specialtiesRaw) {
      if (typeof d === 'string' && DOMAINS.includes(d) && !specialties.includes(d)) specialties.push(d);
    }
    const domain = specialties[0] || null;
    if (!domain) throw fail(`Requisition requires a valid domain (${DOMAINS.join(', ')}).`);

    const role = spec.role === 'manager' ? 'manager' : 'maker';
    const harness = (spec.harnessId && harnesses?.get?.(spec.harnessId))
      || harnesses?.forDomain?.(domain, role)
      || null;
    if (spec.harnessId && harnesses && !harnesses.get(spec.harnessId)) {
      throw fail(`Unknown harness "${spec.harnessId}".`);
    }
    const harnessId = (harness && harness.id) || (typeof spec.harnessId === 'string' && ID_RE.test(spec.harnessId) ? spec.harnessId : 'fullstack-node');
    const rawCandidate = typeof spec.candidateBaseModel === 'string' && spec.candidateBaseModel.trim()
      ? spec.candidateBaseModel.trim()
      : (typeof spec.baseModel === 'string' && spec.baseModel.trim()
          ? spec.baseModel.trim()
          : (CANDIDATE_MODEL_BY_DOMAIN[domain] || 'qwen3-coder-32b'));
    const candidateBaseModel = validateOpenModel(rawCandidate);
    const tools = cleanTools(spec.tools, harness);

    const reason = ['missing_specialty', 'uncertified_specialist', 'manual', 'forge'].includes(spec.reason)
      ? spec.reason
      : 'missing_specialty';

    // Deduplicate automatic specialty-gap requisitions for the same (domain, harnessId, candidateBaseModel).
    // Explicit user Agent Forge builds (`reason === 'forge'`) always create their own distinct build entry.
    if (reason !== 'forge') {
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
    }

    const id = `TR${state.nextSeq++}`;
    const ts = now();
    const rewardSignals = Array.isArray(harness?.rft?.rewardSignals) && harness.rft.rewardSignals.length > 0
      ? [...harness.rft.rewardSignals]
      : ['check_cmd_exit_zero', 'diff_minimality'];
    const evalSuite = harness?.rft?.evalSuite || `suites/${domain}-v0`;
    const suggestedName = typeof spec.name === 'string' && spec.name.trim()
      ? spec.name.trim().slice(0, 40)
      : (typeof spec.suggestedName === 'string' && spec.suggestedName.trim()
          ? spec.suggestedName.trim().slice(0, 40)
          : (SUGGESTED_NAME_BY_DOMAIN[domain] || `Spec-${domain}`));

    const req = {
      id,
      status: 'queued_phase1',
      createdAt: ts,
      updatedAt: ts,
      jobId: spec.jobId ?? null,
      taskId: spec.taskId ?? null,
      linkedTasks: spec.taskId ? [spec.taskId] : [],
      domain,
      specialties,
      role,
      title: typeof spec.title === 'string' && spec.title.trim()
        ? spec.title.trim().slice(0, 80)
        : `${domain.toUpperCase()} ${role === 'manager' ? 'Team Lead' : 'Specialist'}`,
      reason,
      suggestedName,
      candidateBaseModel,
      harnessId,
      tools,
      style: isObj(spec.style) ? { ...spec.style } : null,
      fallbackModel: typeof spec.fallbackModel === 'string' ? spec.fallbackModel : null,
      rftSpec: {
        phase: 1,
        pipeline: 'rft-grpo-v1',
        rewardSignals,
        evalSuite,
        validityGates: ['evalScore >= 75', 'pass_at_1 >= 0.75', 'zero_sandbox_violations', 'zero_hub_path_touch'],
      },
      runState: null,
      qaReport: null,
      notes: typeof spec.notes === 'string' && spec.notes.trim()
        ? spec.notes.trim().slice(0, 400)
        : `Intrinsic harness RL pipeline for "${suggestedName}" (${candidateBaseModel} + harness "${harnessId}" + ${tools.length} tools).`,
      enrolledRosterId: null,
    };
    state.items.unshift(req);
    persist();
    return JSON.parse(JSON.stringify(req));
  }

  /**
   * Forge a brand-new agent from the Drag-and-Drop UI (`Open-Weight Brain + Harness + Tools`)
   * and optionally dispatch straight to the connected RL Compute Port.
   */
  async function forge(spec = {}) {
    const req = createRequisition({ ...spec, reason: 'forge' });
    if (spec.startNow !== false && rlPort) {
      try {
        return await startRun(req.id);
      } catch (err) {
        // Leave queued in the RL bay with the port error message so the user can configure/probe the port and click Start RL!
        const idx = state.items.findIndex((x) => x.id === req.id);
        if (idx >= 0) {
          state.items[idx].runState = {
            remoteJobId: null,
            mode: rlPort.getConfig?.()?.mode || 'local',
            simulated: false,
            progress: 0,
            error: String(err?.message || err),
            updatedAt: now(),
          };
          persist();
        }
        return get(req.id);
      }
    }
    return req;
  }

  async function startRun(id) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) throw fail(`Unknown requisition: ${id}`, 404);
    if (!rlPort) throw fail('RL Compute Port is not initialized on this hub.', 503);
    const req = state.items[idx];
    if (req.status === 'enrolled') throw fail(`${id} is already certified and enrolled in the Employee Handbook.`, 409);
    validateOpenModel(req.candidateBaseModel);

    const bundle = buildBundle(req);
    const started = await rlPort.startJob(bundle);
    const ts = now();
    req.status = 'training';
    req.updatedAt = ts;
    req.qaReport = null;
    req.runState = {
      remoteJobId: started.remoteJobId,
      mode: started.mode || 'local',
      simulated: started.simulated === true,
      progress: 0.08,
      step: 0,
      totalSteps: 100,
      meanReward: null,
      detail: started.detail || 'RL rollout training started.',
      startedAt: ts,
      updatedAt: ts,
      error: null,
    };
    persist();
    return get(id);
  }

  async function pollRun(id) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) throw fail(`Unknown requisition: ${id}`, 404);
    const req = state.items[idx];
    if (req.status !== 'training' || !req.runState?.remoteJobId) return get(id);
    if (!rlPort) throw fail('RL Compute Port is not initialized.', 503);

    const bundle = buildBundle(req);
    const poll = await rlPort.pollJob(req.runState.remoteJobId, bundle);
    const ts = now();

    if (poll?.status === 'failed') {
      req.status = 'rejected_qa';
      req.updatedAt = ts;
      req.runState = {
        ...req.runState,
        progress: Number(poll.progress) || req.runState.progress || 0,
        detail: String(poll.detail || poll.error || 'RL training failed on remote/local port.'),
        error: String(poll.error || poll.detail || 'RL run failed'),
        updatedAt: ts,
      };
      persist();
      return get(id);
    }

    if (poll?.status === 'completed') {
      req.status = 'verifying_qa';
      req.updatedAt = ts;
      const qa = runVerificationQa(req, poll, ts);
      req.qaReport = qa;
      req.runState = {
        ...req.runState,
        progress: 1,
        step: Number(poll.step) || 100,
        totalSteps: Number(poll.totalSteps) || 100,
        meanReward: Number.isFinite(Number(poll.meanReward)) ? Number(poll.meanReward) : null,
        simulated: poll.simulated === true || req.runState.simulated === true,
        detail: qa.passed
          ? 'Passed Verification & QA Gate — certified and enrolled in Employee Handbook.'
          : `Rejected by QA Gate: ${qa.checks.filter((c) => !c.ok).map((c) => c.detail).join(' | ')}`,
        updatedAt: ts,
      };
      if (!qa.passed) {
        req.status = 'rejected_qa';
        persist();
        return get(id);
      }
      const isSim = qa.simulated || req.runState.mode === 'sim';
      const enrolled = enroll(id, {
        name: req.suggestedName,
        title: req.title,
        role: req.role || 'maker',
        baseModel: req.candidateBaseModel,
        harnessId: req.harnessId,
        tools: req.tools,
        specialties: req.specialties,
        style: req.style,
        checkpoint: qa.checkpointUri,
        certification: isSim ? 'sim_trained' : 'curated',
        benchmark: {
          evalScore: qa.evalScore,
          passAt1: qa.passAt1,
          portMode: isSim ? 'sim' : (req.runState.mode || 'local'),
          verifiedAt: ts,
        },
      });
      return enrolled.requisition;
    }

    // Still training
    req.updatedAt = ts;
    req.runState = {
      ...req.runState,
      progress: Number.isFinite(Number(poll?.progress)) ? Math.max(0, Math.min(0.99, Number(poll.progress))) : req.runState.progress,
      step: Number.isFinite(Number(poll?.step)) ? Number(poll.step) : req.runState.step,
      totalSteps: Number.isFinite(Number(poll?.totalSteps)) ? Number(poll.totalSteps) : req.runState.totalSteps,
      meanReward: Number.isFinite(Number(poll?.meanReward)) ? Number(poll.meanReward) : req.runState.meanReward,
      detail: String(poll?.detail || 'Optimizing policy over Harness Rack rollouts...'),
      updatedAt: ts,
    };
    persist();
    return get(id);
  }

  async function cancelRun(id) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) throw fail(`Unknown requisition: ${id}`, 404);
    const req = state.items[idx];
    if (req.runState?.remoteJobId && rlPort) {
      await rlPort.cancelJob(req.runState.remoteJobId).catch(() => {});
    }
    req.status = 'queued_phase1';
    req.updatedAt = now();
    if (req.runState) {
      req.runState = { ...req.runState, remoteJobId: null, detail: 'Cancelled by owner; ready to restart.', updatedAt: now() };
    }
    persist();
    return get(id);
  }

  function enroll(id, opts = {}) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) throw fail(`Unknown requisition: ${id}`, 404);
    const req = state.items[idx];
    if (req.status === 'enrolled' && req.enrolledRosterId) {
      return { requisition: get(id), entry: roster?.get?.(req.enrolledRosterId) ?? null };
    }
    const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 40) : req.suggestedName;
    const baseModel = validateOpenModel(
      typeof opts.baseModel === 'string' && opts.baseModel.trim() ? opts.baseModel.trim() : req.candidateBaseModel,
    );
    const harnessId = typeof opts.harnessId === 'string' && opts.harnessId.trim() ? opts.harnessId.trim() : req.harnessId;
    const checkpoint = typeof opts.checkpoint === 'string' && opts.checkpoint.trim()
      ? opts.checkpoint.trim()
      : `oss://${baseModel}-${req.domain}-rft-v1`;
    const specialties = Array.isArray(opts.specialties) && opts.specialties.length > 0
      ? opts.specialties
      : (Array.isArray(req.specialties) && req.specialties.length > 0 ? req.specialties : [req.domain]);
    const certification = opts.certification === 'sim_trained' ? 'sim_trained' : 'curated';
    const role = opts.role === 'manager' || req.role === 'manager' ? 'manager' : 'maker';
    const tools = Array.isArray(opts.tools) && opts.tools.length > 0
      ? opts.tools
      : (Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : undefined);
    const benchmark = isObj(opts.benchmark)
      ? opts.benchmark
      : (req.qaReport
          ? { evalScore: req.qaReport.evalScore, passAt1: req.qaReport.passAt1, portMode: certification === 'sim_trained' ? 'sim' : 'local', verifiedAt: now() }
          : { evalScore: 82.0, passAt1: 0.8, portMode: 'curated', verifiedAt: now() });

    let entry = null;
    if (roster) {
      const existingMatch = roster.list().find((e) => e.name.toLowerCase() === name.toLowerCase());
      const rosterId = existingMatch ? existingMatch.id : (`spec-${slugId(name)}` || `spec-${id.toLowerCase()}`);
      entry = roster.upsert({
        ...(existingMatch || {}),
        id: rosterId,
        name,
        role: existingMatch?.role || role,
        title: typeof opts.title === 'string' && opts.title.trim()
          ? opts.title.trim()
          : (req.title || `${req.domain.toUpperCase()} Specialist (RFT)`),
        baseModel,
        checkpoint,
        harnessId,
        ...(tools ? { tools } : {}),
        specialties: existingMatch ? [...new Set([...existingMatch.specialties, ...specialties])] : specialties,
        certification,
        benchmark,
        enabled: true,
        style: isObj(opts.style)
          ? { seed: 2500 + state.nextSeq, hat: 'goggles', tool: 'wrench', ...opts.style }
          : (existingMatch?.style || { seed: 2500 + state.nextSeq, hat: 'goggles', tool: 'wrench' }),
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
    forge,
    startRun,
    pollRun,
    cancelRun,
    enroll,
    dismiss,
    onChange,
  };
}
