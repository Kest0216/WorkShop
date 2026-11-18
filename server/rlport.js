// Universal RL Compute Port (`server/rlport.js`):
// Bridges WorkShop's intrinsic Harness + Toolset RL training pipeline to either:
//   1. `local`  — Local machine GPU trainer (`local/rl-port.mjs` personal adapter or HTTP `settings.rlPort.localUrl`)
//   2. `remote` — Remote GPU cluster (DigitalOcean Droplet, Hostinger VPS, RunPod, Lambda, custom HTTPS + Keychain `RL_PORT_TOKEN`)
//   3. `sim`    — Clearly badged `[SIM]` zero-GPU sandbox trainer for Demo / UI workflow testing (never marked production-curated)
//
// Enforces the hard architectural rule: Closed-source frontier models (OpenAI, Anthropic, Google) CANNOT enter the RL pipeline
// because their weights cannot be exported to local or remote GPU clusters.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_RL_PORT } from './config.js';

const CLOSED_PROVIDERS = new Set(['claude', 'gemini', 'openai']);
const CLOSED_PREFIX_RE = /^(gpt-|o1-|o3-|o4-|chatgpt-|claude-|gemini-)/i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function safeLog(log) {
  if (typeof log !== 'function') return () => {};
  return (level, msg, data) => {
    try { log(level, msg, data); } catch { /* logging must never throw */ }
  };
}

/**
 * Verify that `modelId` is an open-weight (`oss`) model eligible for GPU checkpoint fine-tuning.
 * Throws Error{ status: 400 } for any closed-source model.
 */
export function isClosedModel(modelId, registryModels = []) {
  const id = String(modelId || '').trim();
  if (!id) return false;
  const match = Array.isArray(registryModels) ? registryModels.find((m) => m && m.id === id) : null;
  if (match) {
    if (match.weights === 'closed') return true;
    if (match.weights === 'open') return false;
    if (CLOSED_PROVIDERS.has(String(match.provider || '').toLowerCase())) return true;
    if (String(match.provider || '').toLowerCase() === 'oss') return false;
  }
  return CLOSED_PREFIX_RE.test(id);
}

export function assertOpenWeights(modelId, registryModels = []) {
  const id = String(modelId || '').trim();
  if (!id) throw fail('Select an open-weight base model for RL training.');
  if (isClosedModel(id, registryModels)) {
    throw fail(
      `Closed-source model "${id}" cannot be post-trained in the RL pipeline: proprietary weights cannot be exported to local or remote GPU clusters. Choose an open-weight (OSS) model.`,
      400,
    );
  }
  return id;
}

/**
 * Create the Universal RL Compute Port manager.
 * @param {{
 *   localDir?: string,
 *   getSettings?: () => object,
 *   secrets?: object,
 *   router?: object,
 *   fetchImpl?: typeof fetch,
 *   log?: Function,
 *   now?: () => number,
 * }} [deps]
 */
export function createRlPort({
  localDir = null,
  getSettings = () => ({}),
  secrets = null,
  router = null,
  fetchImpl = globalThis.fetch,
  log,
  now = () => Date.now(),
} = {}) {
  const say = safeLog(log);
  const simRuns = new Map();
  let lastStatus = null;

  function readLocalOverlayJson() {
    if (!localDir) return null;
    const file = path.join(localDir, 'rl-port.json');
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      return isObj(parsed) ? parsed : null;
    } catch (err) {
      say('warn', 'rlport: invalid local/rl-port.json ignored', { error: err?.message });
      return null;
    }
  }

  function localAdapterPath() {
    if (!localDir) return null;
    const file = path.join(localDir, 'rl-port.mjs');
    return fs.existsSync(file) ? file : null;
  }

  async function loadLocalAdapter() {
    const file = localAdapterPath();
    if (!file) return null;
    const stat = fs.statSync(file);
    const mod = await import(`${pathToFileURL(file).href}?v=${Math.trunc(stat.mtimeMs)}`);
    return isObj(mod?.default) ? mod.default : mod;
  }

  function getConfig() {
    const s = (typeof getSettings === 'function' ? getSettings() : {}) || {};
    const fromSettings = isObj(s.rlPort) ? s.rlPort : {};
    const overlay = readLocalOverlayJson();
    const adapterFile = localAdapterPath();
    const merged = {
      ...DEFAULT_RL_PORT,
      ...fromSettings,
      ...(overlay || {}),
    };
    const mode = ['local', 'remote', 'sim'].includes(merged.mode) ? merged.mode : 'local';
    return {
      mode,
      localUrl: String(merged.localUrl || DEFAULT_RL_PORT.localUrl).trim(),
      remoteUrl: String(merged.remoteUrl || '').trim(),
      providerHint: String(merged.providerHint || 'local-gpu'),
      personalOverlay: Boolean(overlay || adapterFile),
      hasAdapterScript: Boolean(adapterFile),
    };
  }

  async function readPortToken() {
    if (!secrets || typeof secrets.list !== 'function' || typeof secrets.envFor !== 'function') return { tokenSet: false, token: null };
    try {
      const list = await secrets.list();
      const row = Array.isArray(list)
        ? list.find((k) => (k.id === 'rl-port' || k.envVar === 'RL_PORT_TOKEN') && k.set === true)
        : null;
      if (!row) return { tokenSet: false, token: null };
      // Read custom secret via secrets.get if exposed, or fallback
      if (typeof secrets.get === 'function') {
        const val = await secrets.get(row.id);
        return { tokenSet: Boolean(val), token: val || null };
      }
      return { tokenSet: true, token: null };
    } catch {
      return { tokenSet: false, token: null };
    }
  }

  function registryModels() {
    try { return router?.registry?.()?.models ?? []; } catch { return []; }
  }

  function buildAgentPrompt(overrideMode = null) {
    const cfg = getConfig();
    const mode = overrideMode || cfg.mode;
    const providerLabel = {
      'local-gpu': 'my local GPU (Apple Silicon MLX or local CUDA / PyTorch / Unsloth)',
      droplet: 'my DigitalOcean GPU Droplet',
      hostinger: 'my Hostinger VPS / remote compute node',
      runpod: 'my RunPod GPU pod / serverless worker',
      custom: 'my custom GPU cluster',
    }[cfg.providerHint] || 'my compute environment';

    return [
      `Connect WorkShop's Universal RL Compute Port (${mode === 'remote' ? 'Remote Cluster' : 'Local Machine'} mode for ${providerLabel}).`,
      '1. Read `ports/rl/PORT_CONTRACT.md` to understand the Training Bundle, status polling, and Verification & QA Gate requirements.',
      `2. Copy \`ports/rl/template-${mode === 'remote' ? 'remote' : 'local'}.mjs\` to \`local/rl-port.mjs\` (which is git-ignored so personal IPs/ports stay private).`,
      '3. Implement `probe()`, `startJob(bundle)`, `pollJob(remoteJobId)`, and `cancelJob(remoteJobId)` to run GRPO/RFT rollouts with the equipped `.shop/HARNESS.md` and tool schemas.',
      '4. Do NOT hardcode secrets — read bearer tokens via `RL_PORT_TOKEN` in WorkShop Settings -> API Keys Vault.',
      '5. Verify with `POST /api/rl-port/probe` or the Probe Port button in Settings -> RL Compute Port.',
    ].join('\n');
  }

  async function probe() {
    const cfg = getConfig();
    const { tokenSet, token } = await readPortToken();

    if (cfg.mode === 'sim') {
      lastStatus = {
        ok: true,
        mode: 'sim',
        simulated: true,
        backend: 'standin-sim-rl',
        gpus: ['Simulated Sandbox ([SIM] Demo Only)'],
        capabilities: ['grpo', 'rft', 'qa-gate'],
        endpoint: 'sim://local-sandbox',
        tokenSet,
        personalOverlay: cfg.personalOverlay,
        hasAdapterScript: cfg.hasAdapterScript,
        providerHint: cfg.providerHint,
        detail: '[SIM] Sandbox RL trainer ready. Trained agents carry a [SIM] badge and are excluded from non-demo production staffing.',
        checkedAt: now(),
      };
      return { ...lastStatus };
    }

    // 1. Personal local/rl-port.mjs adapter takes priority when present
    try {
      const adapter = await loadLocalAdapter();
      if (adapter && typeof adapter.probe === 'function') {
        const res = await adapter.probe({ mode: cfg.mode, settings: { rlPort: cfg }, token });
        lastStatus = {
          ok: Boolean(res?.ok),
          mode: cfg.mode,
          simulated: false,
          backend: String(res?.backend || 'local-adapter'),
          gpus: Array.isArray(res?.gpus) ? res.gpus.map(String) : [],
          capabilities: Array.isArray(res?.capabilities) ? res.capabilities.map(String) : ['grpo', 'rft'],
          endpoint: 'local/rl-port.mjs',
          tokenSet,
          personalOverlay: true,
          hasAdapterScript: true,
          providerHint: cfg.providerHint,
          detail: String(res?.detail || (res?.ok ? 'Connected via local/rl-port.mjs' : 'Adapter reported not ready.')),
          checkedAt: now(),
        };
        return { ...lastStatus };
      }
    } catch (err) {
      lastStatus = {
        ok: false,
        mode: cfg.mode,
        simulated: false,
        backend: 'local-adapter-error',
        gpus: [],
        capabilities: [],
        endpoint: 'local/rl-port.mjs',
        tokenSet,
        personalOverlay: true,
        hasAdapterScript: true,
        providerHint: cfg.providerHint,
        detail: `local/rl-port.mjs error: ${err?.message || String(err)}`,
        checkedAt: now(),
      };
      return { ...lastStatus };
    }

    // 2. Standard HTTP Universal RL Port (`localUrl` or `remoteUrl`)
    const rawUrl = cfg.mode === 'remote' ? cfg.remoteUrl : cfg.localUrl;
    if (!rawUrl) {
      lastStatus = {
        ok: false,
        mode: cfg.mode,
        simulated: false,
        backend: 'unconfigured',
        gpus: [],
        capabilities: [],
        endpoint: '',
        tokenSet,
        personalOverlay: cfg.personalOverlay,
        hasAdapterScript: cfg.hasAdapterScript,
        providerHint: cfg.providerHint,
        detail: cfg.mode === 'remote'
          ? 'No Remote Cluster URL configured yet. Enter your Droplet / Hostinger / cluster URL or wire local/rl-port.mjs.'
          : 'No Local RL Port running at ' + cfg.localUrl + '. Wire local/rl-port.mjs or start your local RL server.',
        checkedAt: now(),
      };
      return { ...lastStatus };
    }

    const base = rawUrl.replace(/\/+$/, '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const res = await fetchImpl(`${base}/health`, { method: 'GET', headers, signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      lastStatus = {
        ok: data?.ok !== false,
        mode: cfg.mode,
        simulated: false,
        backend: String(data?.backend || (cfg.mode === 'remote' ? 'remote-http-port' : 'local-http-port')),
        gpus: Array.isArray(data?.gpus) ? data.gpus.map(String) : [],
        capabilities: Array.isArray(data?.capabilities) ? data.capabilities.map(String) : ['grpo', 'rft'],
        endpoint: base,
        tokenSet,
        personalOverlay: cfg.personalOverlay,
        hasAdapterScript: cfg.hasAdapterScript,
        providerHint: cfg.providerHint,
        detail: String(data?.detail || `Connected to ${base}`),
        checkedAt: now(),
      };
    } catch (err) {
      lastStatus = {
        ok: false,
        mode: cfg.mode,
        simulated: false,
        backend: 'unreachable',
        gpus: [],
        capabilities: [],
        endpoint: base,
        tokenSet,
        personalOverlay: cfg.personalOverlay,
        hasAdapterScript: cfg.hasAdapterScript,
        providerHint: cfg.providerHint,
        detail: `Port ${base} unreachable (${err?.name === 'AbortError' ? 'timeout' : (err?.message || 'connection refused')}). Use "Copy Agent Prompt" to have an agent wire your ${cfg.mode === 'remote' ? 'remote cluster' : 'local GPU'}.`,
        checkedAt: now(),
      };
    } finally {
      clearTimeout(timer);
    }
    return { ...lastStatus };
  }

  function status() {
    const cfg = getConfig();
    if (lastStatus && lastStatus.mode === cfg.mode) {
      return { ...lastStatus, config: cfg, agentPrompt: buildAgentPrompt(cfg.mode) };
    }
    return {
      ok: cfg.mode === 'sim',
      mode: cfg.mode,
      simulated: cfg.mode === 'sim',
      backend: cfg.mode === 'sim' ? 'standin-sim-rl' : (cfg.hasAdapterScript ? 'local-adapter' : 'unprobed'),
      gpus: cfg.mode === 'sim' ? ['Simulated Sandbox ([SIM] Demo Only)'] : [],
      capabilities: cfg.mode === 'sim' ? ['grpo', 'rft', 'qa-gate'] : [],
      endpoint: cfg.mode === 'sim' ? 'sim://local-sandbox' : (cfg.hasAdapterScript ? 'local/rl-port.mjs' : (cfg.mode === 'remote' ? cfg.remoteUrl : cfg.localUrl)),
      personalOverlay: cfg.personalOverlay,
      hasAdapterScript: cfg.hasAdapterScript,
      providerHint: cfg.providerHint,
      detail: cfg.mode === 'sim'
        ? '[SIM] Sandbox RL trainer active.'
        : 'Click Probe Port to verify connection to your RL compute endpoint.',
      checkedAt: null,
      config: cfg,
      agentPrompt: buildAgentPrompt(cfg.mode),
    };
  }

  async function startJob(bundle) {
    if (!isObj(bundle)) throw fail('Training bundle must be an object.');
    assertOpenWeights(bundle.baseModel, registryModels());
    const cfg = getConfig();
    const { token } = await readPortToken();

    if (cfg.mode === 'sim') {
      const remoteJobId = `sim-${bundle.requisitionId || 'forge'}-${now()}`;
      simRuns.set(remoteJobId, {
        startedAt: now(),
        polls: 0,
        bundle,
      });
      return {
        remoteJobId,
        mode: 'sim',
        simulated: true,
        status: 'training',
        detail: `[SIM] Intrinsic harness rollout started for ${bundle.baseModel} + ${bundle.harness?.id || 'harness'}`,
      };
    }

    const adapter = await loadLocalAdapter();
    if (adapter && typeof adapter.startJob === 'function') {
      const res = await adapter.startJob(bundle, { mode: cfg.mode, settings: { rlPort: cfg }, token });
      if (!res?.remoteJobId) throw fail('RL adapter startJob() did not return a remoteJobId.', 502);
      return {
        remoteJobId: String(res.remoteJobId),
        mode: cfg.mode,
        simulated: false,
        status: String(res.status || 'training'),
        detail: String(res.detail || `Dispatched to ${cfg.mode} RL adapter.`),
      };
    }

    const rawUrl = cfg.mode === 'remote' ? cfg.remoteUrl : cfg.localUrl;
    if (!rawUrl) {
      throw fail(
        cfg.mode === 'remote'
          ? 'Remote RL Cluster URL is not configured. Open Settings -> RL Compute Port to connect your Droplet/Hostinger/GPU endpoint, or switch to [SIM] for demo testing.'
          : 'Local RL Compute Port is not connected yet. Wire `local/rl-port.mjs`, start a local port server, or switch to [SIM] for demo testing.',
        409,
      );
    }
    const base = rawUrl.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    let res;
    try {
      res = await fetchImpl(`${base}/jobs`, { method: 'POST', headers, body: JSON.stringify(bundle) });
    } catch (err) {
      throw fail(`Could not reach ${cfg.mode} RL port at ${base}: ${err?.message || 'connection refused'}.`, 502);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw fail(`RL port at ${base} refused training job (HTTP ${res.status}): ${text.slice(0, 200)}`, 502);
    }
    const data = await res.json();
    if (!data?.remoteJobId) throw fail('RL port response missing remoteJobId.', 502);
    return {
      remoteJobId: String(data.remoteJobId),
      mode: cfg.mode,
      simulated: false,
      status: String(data.status || 'training'),
      detail: String(data.detail || `Training running on ${base}`),
    };
  }

  async function pollJob(remoteJobId, bundle = {}) {
    const id = String(remoteJobId || '').trim();
    if (!id) throw fail('Missing remoteJobId.');
    if (id.startsWith('sim-') || simRuns.has(id)) {
      const entry = simRuns.get(id) || { startedAt: now() - 2000, polls: 2, bundle };
      entry.polls += 1;
      const elapsed = now() - entry.startedAt;
      if (entry.polls < 2 && elapsed < 1200) {
        return {
          status: 'training',
          simulated: true,
          progress: 0.55,
          step: 55,
          totalSteps: 100,
          meanReward: 0.74,
          detail: '[SIM] Optimizing policy over Harness Rack trajectories (55/100)...',
        };
      }
      simRuns.delete(id);
      const b = entry.bundle || bundle || {};
      const hId = b.harness?.id || b.harnessId || 'harness';
      const model = b.baseModel || 'qwen3-coder-32b';
      // Deterministic benchmark score derived from base model + harness + tools
      const toolBonus = Math.min(4, (Array.isArray(b.tools) ? b.tools.length : 5) * 0.5);
      const evalScore = Math.round((81.0 + toolBonus) * 10) / 10;
      return {
        status: 'completed',
        simulated: true,
        progress: 1,
        step: 100,
        totalSteps: 100,
        meanReward: 0.87,
        checkpointUri: `sim://${model}-${hId}-rft-sim`,
        metrics: {
          evalScore,
          passAt1: 0.82,
          sandboxViolations: 0,
          hubPathTouches: 0,
          toolCompliance: 0.98,
        },
        detail: '[SIM] Simulated RL trajectory optimization complete. Ready for Verification & QA Gate.',
      };
    }

    const cfg = getConfig();
    const { token } = await readPortToken();
    const adapter = await loadLocalAdapter();
    if (adapter && typeof adapter.pollJob === 'function') {
      return adapter.pollJob(id, { bundle, mode: cfg.mode, settings: { rlPort: cfg }, token });
    }
    const base = (cfg.mode === 'remote' ? cfg.remoteUrl : cfg.localUrl).replace(/\/+$/, '');
    if (!base) throw fail('RL port URL is not configured.', 409);
    const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetchImpl(`${base}/jobs/${encodeURIComponent(id)}`, { method: 'GET', headers });
    if (!res.ok) throw fail(`RL port poll failed (HTTP ${res.status}).`, 502);
    return res.json();
  }

  async function cancelJob(remoteJobId) {
    const id = String(remoteJobId || '').trim();
    if (!id) return { ok: true };
    if (simRuns.has(id)) {
      simRuns.delete(id);
      return { ok: true };
    }
    const cfg = getConfig();
    const { token } = await readPortToken();
    try {
      const adapter = await loadLocalAdapter();
      if (adapter && typeof adapter.cancelJob === 'function') {
        await adapter.cancelJob(id, { mode: cfg.mode, settings: { rlPort: cfg }, token });
        return { ok: true };
      }
      const base = (cfg.mode === 'remote' ? cfg.remoteUrl : cfg.localUrl).replace(/\/+$/, '');
      if (base) {
        const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        await fetchImpl(`${base}/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers });
      }
    } catch (err) {
      say('warn', 'rlport: cancelJob failed', { id, error: err?.message });
    }
    return { ok: true };
  }

  return {
    getConfig,
    status,
    probe,
    startJob,
    pollJob,
    cancelJob,
    buildAgentPrompt,
    assertOpenWeights: (modelId) => assertOpenWeights(modelId, registryModels()),
    isClosedModel: (modelId) => isClosedModel(modelId, registryModels()),
  };
}
