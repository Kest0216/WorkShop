// The Harness Rack: modular domain/platform harnesses equipped by Open-Source Specialists and Team Leads.
// Stores curated and owner-edited harness specs in config/harnesses.json and renders .shop/HARNESS.md inside benches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS } from './router.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_HARNESSES_FILE = path.join(MODULE_DIR, '..', 'config', 'harnesses.json');

export const HARNESS_TOOLS = Object.freeze([
  'read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'run_shell', 'shop_mcp',
]);
export const HARNESS_RUNNERS = Object.freeze(['openai_loop', 'command']);
export const RFT_STATUSES = Object.freeze(['phase0_scaffold', 'phase1_ready', 'calibrated']);
export const SANDBOX_SCOPES = Object.freeze(['bench', 'read_only']);

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const MAX_HARNESSES = 80;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max = 200) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
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

function strList(raw, { field, maxItems = 24, maxLen = 120, allowEmpty = true } = {}) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw fail(`${field} must be a list of strings.`);
  if (raw.length > maxItems) throw fail(`${field} must hold at most ${maxItems} items.`);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') throw fail(`${field} must contain strings only.`);
    const t = item.trim();
    if (!t || t.length > maxLen) throw fail(`${field} entries must have 1 to ${maxLen} characters.`);
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  if (!allowEmpty && out.length === 0) throw fail(`${field} must have at least one item.`);
  return out;
}

/** Validate and normalize a single harness definition. Throws Error{status:400} on invalid fields. */
export function normalizeHarness(input, index = 0) {
  const where = `Harness ${index + 1}`;
  if (!isObj(input)) throw fail(`${where} must be an object.`);
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!ID_RE.test(id)) {
    throw fail(`${where}.id must be 2 to 40 lowercase letters, digits, underscores, or dashes.`);
  }
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!isText(label, 80)) throw fail(`${where}.label must be 1 to 80 characters.`);
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!isText(summary, 300)) throw fail(`${where}.summary must be 1 to 300 characters.`);
  const roleHint = input.roleHint == null || input.roleHint === '' ? 'maker' : String(input.roleHint);
  if (roleHint !== 'maker' && roleHint !== 'manager') {
    throw fail(`${where}.roleHint must be "maker" or "manager".`);
  }
  const domains = strList(input.domains, { field: `${where}.domains`, maxItems: DOMAINS.length, maxLen: 40, allowEmpty: false });
  for (const d of domains) {
    if (!DOMAINS.includes(d)) throw fail(`${where}.domains: unknown domain "${d}".`);
  }
  const platforms = strList(input.platforms, { field: `${where}.platforms`, maxItems: 16, maxLen: 40 });
  const tools = input.tools === undefined
    ? ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'run_shell', 'shop_mcp']
    : strList(input.tools, { field: `${where}.tools`, maxItems: HARNESS_TOOLS.length, maxLen: 32, allowEmpty: false });
  for (const t of tools) {
    if (!HARNESS_TOOLS.includes(t)) throw fail(`${where}.tools: unsupported tool "${t}".`);
  }

  const rawRunner = input.runner === undefined ? { kind: 'openai_loop' } : input.runner;
  if (!isObj(rawRunner)) throw fail(`${where}.runner must be an object.`);
  const runnerKind = rawRunner.kind || 'openai_loop';
  if (!HARNESS_RUNNERS.includes(runnerKind)) {
    throw fail(`${where}.runner.kind must be "openai_loop" or "command".`);
  }
  const runner = { kind: runnerKind };
  if (runnerKind === 'command') {
    const command = typeof rawRunner.command === 'string' ? rawRunner.command.trim() : '';
    if (!command || command.length > 2000 || command.includes('\0')) {
      throw fail(`${where}.runner.command must be a non-empty command under 2000 chars without NUL bytes.`);
    }
    runner.command = command;
  } else {
    const maxSteps = rawRunner.maxSteps === undefined ? 32 : Number(rawRunner.maxSteps);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 128) {
      throw fail(`${where}.runner.maxSteps must be an integer from 1 to 128.`);
    }
    const temperature = rawRunner.temperature === undefined ? 0.1 : Number(rawRunner.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw fail(`${where}.runner.temperature must be a number from 0 to 2.`);
    }
    runner.maxSteps = maxSteps;
    runner.temperature = Math.round(temperature * 100) / 100;
  }

  const rawSandbox = input.sandbox === undefined ? {} : input.sandbox;
  if (!isObj(rawSandbox)) throw fail(`${where}.sandbox must be an object.`);
  const writeScope = rawSandbox.writeScope || (roleHint === 'manager' ? 'read_only' : 'bench');
  if (!SANDBOX_SCOPES.includes(writeScope)) throw fail(`${where}.sandbox.writeScope must be "bench" or "read_only".`);
  const sandbox = { writeScope, allowNet: rawSandbox.allowNet === true };

  const rawProto = input.protocol === undefined ? {} : input.protocol;
  if (!isObj(rawProto)) throw fail(`${where}.protocol must be an object.`);
  const workflow = strList(rawProto.workflow, { field: `${where}.protocol.workflow`, maxItems: 12, maxLen: 240 });
  const addon = typeof rawProto.systemPromptAddon === 'string' ? rawProto.systemPromptAddon.trim() : '';
  if (addon.length > 2000) throw fail(`${where}.protocol.systemPromptAddon must be at most 2000 characters.`);
  const protocol = { workflow, systemPromptAddon: addon };

  const rawRft = input.rft === undefined ? {} : input.rft;
  if (!isObj(rawRft)) throw fail(`${where}.rft must be an object.`);
  const rftStatus = rawRft.status || 'phase0_scaffold';
  if (!RFT_STATUSES.includes(rftStatus)) {
    throw fail(`${where}.rft.status must be "phase0_scaffold", "phase1_ready", or "calibrated".`);
  }
  const rewardSignals = strList(rawRft.rewardSignals, { field: `${where}.rft.rewardSignals`, maxItems: 16, maxLen: 80 });
  const evalSuite = typeof rawRft.evalSuite === 'string' ? rawRft.evalSuite.trim().slice(0, 120) : '';
  const notes = typeof rawRft.notes === 'string' ? rawRft.notes.trim().slice(0, 400) : '';
  const rft = { status: rftStatus, rewardSignals, evalSuite, notes };

  return { id, label, summary, roleHint, domains, platforms, runner, tools, sandbox, protocol, rft };
}

/** Validate a full harness registry object { version: 1, updatedAt?, harnesses: [...] }. */
export function validateHarnessRegistry(input) {
  if (!isObj(input)) throw fail('The harness registry must be a JSON object.');
  if (input.version !== 1) throw fail('harness registry version must be 1.');
  if (!Array.isArray(input.harnesses) || input.harnesses.length === 0) {
    throw fail('harnesses must be a list with at least one harness.');
  }
  if (input.harnesses.length > MAX_HARNESSES) {
    throw fail(`harnesses must not hold more than ${MAX_HARNESSES} entries.`);
  }
  const seen = new Set();
  const normalized = [];
  for (let i = 0; i < input.harnesses.length; i += 1) {
    const h = normalizeHarness(input.harnesses[i], i);
    if (seen.has(h.id)) throw fail(`Duplicate harness id: "${h.id}".`);
    seen.add(h.id);
    normalized.push(h);
  }
  const updatedAt = typeof input.updatedAt === 'string' && input.updatedAt.trim()
    ? input.updatedAt.trim().slice(0, 40)
    : new Date().toISOString().slice(0, 10);
  return { version: 1, updatedAt, harnesses: normalized };
}

/** Render a concise .shop/HARNESS.md specification card written inside a Specialist bench. */
export function renderHarnessCard(harness) {
  if (!harness) return '';
  const h = normalizeHarness(harness);
  const lines = [
    `# Equipped Harness: ${h.label} (\`${h.id}\`)`,
    '',
    h.summary,
    '',
    `- **Role**: ${h.roleHint === 'manager' ? 'Team Lead' : 'Specialist'}`,
    `- **Domains**: ${h.domains.join(', ')}`,
    `- **Platforms**: ${h.platforms.length ? h.platforms.join(', ') : 'general'}`,
    `- **Runner**: \`${h.runner.kind}\`${h.runner.kind === 'openai_loop' ? ` (maxSteps=${h.runner.maxSteps}, temp=${h.runner.temperature})` : ''}`,
    `- **Sandbox**: writeScope=\`${h.sandbox.writeScope}\`, allowNet=${h.sandbox.allowNet}`,
    `- **Allowed Tools**: ${h.tools.join(', ')}`,
  ];
  if (h.protocol.workflow.length > 0) {
    lines.push('', '## Field Workflow');
    h.protocol.workflow.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
  }
  if (h.rft.rewardSignals.length > 0 || h.rft.evalSuite) {
    lines.push('', '## Verification & Phase 1 RFT Rubric');
    lines.push(`- **RFT Status**: \`${h.rft.status}\``);
    if (h.rft.evalSuite) lines.push(`- **Eval Suite**: \`${h.rft.evalSuite}\``);
    if (h.rft.rewardSignals.length > 0) lines.push(`- **Reward Signals**: ${h.rft.rewardSignals.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

const FALLBACK_REGISTRY = Object.freeze({
  version: 1,
  updatedAt: '2026-11-16',
  harnesses: [
    {
      id: 'fullstack-node',
      label: 'Fullstack Node & API Rig',
      summary: 'Balanced implementation harness for Node ESM services and surgical bench diffs.',
      roleHint: 'maker',
      domains: ['backend', 'chore', 'frontend', 'fix', 'test', 'data', 'algo', 'research', 'synthesis', 'docs', 'vision', 'plan', 'review'],
      platforms: ['node', 'git'],
      runner: { kind: 'openai_loop', maxSteps: 32, temperature: 0.1 },
      tools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'run_shell', 'shop_mcp'],
      sandbox: { writeScope: 'bench', allowNet: false },
      protocol: { workflow: ['Inspect codebase first.', 'Keep changes minimal and verified.'], systemPromptAddon: '' },
      rft: { status: 'phase0_scaffold', rewardSignals: ['check_cmd_exit_zero'], evalSuite: '', notes: '' },
    },
  ],
});

function loadShippedDefaults() {
  try {
    return validateHarnessRegistry(JSON.parse(fs.readFileSync(SHIPPED_HARNESSES_FILE, 'utf8')));
  } catch {
    return validateHarnessRegistry(FALLBACK_REGISTRY);
  }
}

/**
 * Create the Harness Rack registry backed by `<configDir>/harnesses.json`.
 * @param {{ configDir: string, log?: Function, now?: () => number }} deps
 */
export function createHarnesses({ configDir, log, now = () => Date.now() } = {}) {
  if (!configDir) throw new Error('createHarnesses needs configDir');
  const say = safeLog(log);
  const file = path.join(configDir, 'harnesses.json');
  const listeners = new Set();

  function loadInitial() {
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        return validateHarnessRegistry(raw);
      } catch (err) {
        try { fs.renameSync(file, `${file}.bak`); } catch { /* ignore backup error */ }
        say('warn', 'harnesses: invalid harnesses.json, falling back to shipped defaults', { error: err?.message });
      }
    }
    return loadShippedDefaults();
  }

  let registry = loadInitial();

  function emit() {
    const snapshot = list();
    for (const fn of [...listeners]) {
      try { fn(snapshot); } catch (err) { say('error', 'harnesses: onChange listener failed', { error: err?.message }); }
    }
  }

  function list() {
    return copyJson(registry.harnesses);
  }

  function getRegistry() {
    return copyJson(registry);
  }

  function get(id) {
    if (typeof id !== 'string' || !id) return null;
    const found = registry.harnesses.find((h) => h.id === id);
    return found ? copyJson(found) : null;
  }

  function forDomain(domain, role = 'maker') {
    const desiredRole = role === 'manager' ? 'manager' : 'maker';
    const byRole = registry.harnesses.filter((h) => h.roleHint === desiredRole);
    const exact = byRole.find((h) => h.domains.includes(domain))
      || registry.harnesses.find((h) => h.domains.includes(domain))
      || byRole[0]
      || registry.harnesses[0];
    return exact ? copyJson(exact) : null;
  }

  function persist(nextReg) {
    const clean = validateHarnessRegistry({
      ...nextReg,
      updatedAt: new Date(now()).toISOString().slice(0, 10),
    });
    writeAtomic(file, `${JSON.stringify(clean, null, 2)}\n`);
    registry = clean;
    emit();
    return list();
  }

  function save(input) {
    return persist(input);
  }

  function upsert(input) {
    const item = normalizeHarness(copyJson(input), 0);
    const idx = registry.harnesses.findIndex((h) => h.id === item.id);
    const harnesses = [...registry.harnesses];
    if (idx >= 0) harnesses[idx] = item;
    else harnesses.push(item);
    persist({ ...registry, harnesses });
    return get(item.id);
  }

  function remove(id) {
    const idx = registry.harnesses.findIndex((h) => h.id === id);
    if (idx < 0) throw fail(`Unknown harness: ${id}`, 404);
    if (registry.harnesses.length <= 1) throw fail('At least one harness must remain on the rack.');
    const harnesses = registry.harnesses.filter((h) => h.id !== id);
    persist({ ...registry, harnesses });
    return { ok: true, id };
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange needs a function');
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  return {
    list,
    get,
    getRegistry,
    forDomain,
    save,
    upsert,
    remove,
    renderCard: renderHarnessCard,
    onChange,
  };
}
