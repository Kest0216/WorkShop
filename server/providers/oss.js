// Open-Source Runtime adapter (`oss`): drives open-weight Specialists and Team Leads via
// OpenAI-compatible local/cluster endpoints (Ollama, vLLM, SGLang, llama.cpp), custom command harnesses,
// or Phase 0 local stand-in mode. $0 API billing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHarnessCard } from '../harnesses.js';
import { createParser as createNormParser } from './mock.js';

const noop = () => {};
const AGENT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oss-agent.mjs');

export const OSS_POLICY_NOTE = Object.freeze({
  local: {
    lines: [
      'Runs open-weight models on your own local or cluster runtime ($0 API token billing).',
      'Equip each Specialist with a Harness from the Harness Rack (.shop/HARNESS.md).',
      'Phase 0 Stand-in mode lets you verify team routing before downloading weights.',
    ],
    url: 'https://ollama.com',
  },
});

/**
 * Probe an OpenAI-compatible `/v1/models` endpoint. Never throws.
 * @returns {Promise<{ ok: boolean, models: string[]|null, detail: string }>}
 */
export async function probeEndpoint({ baseUrl, apiKey = null, timeoutMs = 2500 } = {}) {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(root)) {
    return { ok: false, models: null, detail: 'Invalid Open-Source endpoint URL.' };
  }
  const target = root.endsWith('/models') ? root : `${root}/models`;
  try {
    const res = await fetch(target, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(Math.max(300, timeoutMs)),
    });
    if (!res.ok) {
      return { ok: false, models: null, detail: `Endpoint returned HTTP ${res.status}.` };
    }
    const json = await res.json();
    const list = Array.isArray(json?.data)
      ? json.data.map((m) => (typeof m === 'string' ? m : m?.id)).filter((id) => typeof id === 'string' && id)
      : Array.isArray(json?.models)
        ? json.models.map((m) => (typeof m === 'string' ? m : m?.name || m?.model)).filter((id) => typeof id === 'string' && id)
        : [];
    return {
      ok: true,
      models: list.length ? [...new Set(list)] : null,
      detail: list.length ? `${list.length} open-weight models ready` : 'Open-source endpoint reachable',
    };
  } catch (err) {
    return {
      ok: false,
      models: null,
      detail: `Endpoint offline (${err?.name === 'TimeoutError' ? 'timeout' : err?.message || 'unreachable'})`,
    };
  }
}

/**
 * @param {{ shellEnv: { base: Function }, getSettings?: () => object, log?: Function, script?: string }} deps
 */
export function createOssAdapter({ shellEnv, getSettings = () => ({}), log = noop, script = AGENT_SCRIPT } = {}) {
  if (!shellEnv) throw new Error('createOssAdapter needs shellEnv');
  void log;

  function buildRun({
    agent, model, effort, prompt, systemPrompt, cwd, sessionId, resume, mcp, access, runDir, mode, keyEnv, maxTurns, timeoutMs, harness,
  } = {}) {
    if (!cwd || !runDir) throw new Error('oss: buildRun needs cwd and runDir');
    const cfg = getSettings() || {};
    const ossCfg = cfg.oss || {};
    const resolvedMode = mode === 'standin' || ossCfg.standIn === true ? 'standin' : 'local';
    const turnFile = path.join(runDir, 'oss-turn.json');
    const payload = {
      runDir,
      cwd,
      agent: { id: agent?.id ?? null, handle: agent?.handle ?? null, role: agent?.role ?? 'maker', name: agent?.name ?? null },
      model: String(model || 'qwen3-coder-32b'),
      effort: effort || 'medium',
      prompt: String(prompt ?? ''),
      systemPrompt: String(systemPrompt ?? ''),
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      resume: resume === true,
      access: access === 'read' ? 'read' : 'write',
      maxTurns: Number.isInteger(maxTurns) ? maxTurns : 32,
      timeoutMs: typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : 30 * 60_000,
      mode: resolvedMode,
      baseUrl: ossCfg.baseUrl || 'http://127.0.0.1:11434/v1',
      engine: ossCfg.engine || 'ollama',
      harness: harness || null,
      mcp: mcp?.url ? { url: String(mcp.url), token: String(mcp.token ?? '') } : null,
    };

    const env = { ...shellEnv.base() };
    if (typeof keyEnv?.OSS_API_KEY === 'string' && keyEnv.OSS_API_KEY) {
      env.OSS_API_KEY = keyEnv.OSS_API_KEY;
    }

    const hubFiles = {};
    if (harness) {
      hubFiles['.shop/HARNESS.md'] = renderHarnessCard(harness);
    }

    return {
      cmd: process.execPath,
      args: [script, turnFile],
      env,
      cwd,
      stdin: '',
      files: [{ path: turnFile, content: `${JSON.stringify(payload, null, 2)}\n`, cleanup: true }],
      hubFiles,
      sessionId: payload.sessionId,
      stopSignal: 'SIGTERM',
    };
  }

  function createParser() {
    const inner = createNormParser();
    return {
      push(line) {
        if (typeof line !== 'string') return [];
        const text = line.trim();
        if (!text || text[0] !== '{') return [];
        let raw;
        try { raw = JSON.parse(text); } catch { return []; }
        if (!raw || typeof raw !== 'object') return [];
        // Normalize `type` -> `t` if emitted by a custom harness runner.
        if (!raw.t && typeof raw.type === 'string') {
          const mapped = {
            ...raw,
            t: raw.type === 'tool_call' ? 'tool' : raw.type === 'assistant' ? 'text' : raw.type,
            ...(raw.type === 'assistant' && raw.text ? { text: raw.text } : {}),
            ...(raw.type === 'result' && typeof raw.result === 'string' && !raw.text ? { text: raw.result } : {}),
          };
          return inner.push(JSON.stringify(mapped));
        }
        return inner.push(text);
      },
      end(info) {
        return inner.end(info);
      },
    };
  }

  return {
    id: 'oss',
    label: 'Open-Source Runtime',
    lab: 'Open Source',
    binary: 'node',
    keyVar: 'OSS_API_KEY',
    selfTestModel: 'qwen3-coder-32b',
    policyNote: () => structuredClone(OSS_POLICY_NOTE),
    locate: () => process.execPath,
    probeEndpoint,
    buildRun,
    createParser,
    classify: () => ({ kind: null, message: '', resetAt: null }),
    loginCommand: () => null,
    installHint: () => ({
      text: 'Run Ollama (`ollama serve`), vLLM, or SGLang locally, or toggle Phase 0 Stand-in mode in Runtimes & Keys.',
      url: 'https://ollama.com',
    }),
  };
}
