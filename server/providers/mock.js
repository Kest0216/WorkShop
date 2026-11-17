// Mock lab adapter: runs server/providers/mock-agent.mjs, a scripted fake CLI that calls the real hub tools.
// No tokens, no sign-in. Used by the demo and the end-to-end tests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const noop = () => {};
const AGENT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-agent.mjs');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ERROR_KINDS = ['rate_limit', 'auth', 'mcp', 'model', 'other'];
const modelField = (e) => (typeof e.model === 'string' && e.model ? { model: e.model.slice(0, 100) } : {});

/** Copy one NormEvent with exactly the contract fields, or null when the object is not one. */
function normalize(e) {
  switch (e.t) {
    case 'init': return {
      t: 'init', sessionId: typeof e.sessionId === 'string' ? e.sessionId : null, model: typeof e.model === 'string' ? e.model : null, mcpOk: e.mcpOk !== false,
      loaded: Array.isArray(e.loaded) ? e.loaded.filter((n) => typeof n === 'string').slice(0, 50).map((n) => n.slice(0, 80)) : [],
    };
    case 'text': return { t: 'text', text: str(e.text, 20_000) };
    case 'tool': return { t: 'tool', name: str(e.name, 100) || 'tool', summary: str(e.summary, 200) || str(e.name, 100) || 'tool' };
    case 'tool_result': return { t: 'tool_result', ok: e.ok !== false, summary: str(e.summary, 200) };
    case 'usage': return { t: 'usage', inTok: num(e.inTok), outTok: num(e.outTok), cacheRead: num(e.cacheRead), cacheWrite: num(e.cacheWrite), usd: numOrNull(e.usd) };
    case 'ctx': return { t: 'ctx', tokens: num(e.tokens), max: numOrNull(e.max) }; // optional: fill of the context window
    case 'limit': return { t: 'limit', status: typeof e.status === 'string' ? e.status.slice(0, 40) : null, type: typeof e.type === 'string' ? e.type.slice(0, 40) : null, utilization: numOrNull(e.utilization), resetAt: numOrNull(e.resetAt), overage: e.overage === true, ...modelField(e) }; // optional: plan-limit notice
    case 'denied': return { t: 'denied', what: str(e.what, 200) };
    case 'result': return { t: 'result', ok: e.ok === true, text: str(e.text, 100_000), sessionId: typeof e.sessionId === 'string' ? e.sessionId : null, usd: numOrNull(e.usd), turns: num(e.turns), durationMs: num(e.durationMs) };
    case 'error': return { t: 'error', kind: ERROR_KINDS.includes(e.kind) ? e.kind : 'other', message: str(e.message, 300) || 'error', resetAt: numOrNull(e.resetAt), ...modelField(e) };
    default: return null;
  }
}

/** Parser for a stream whose lines are already NormEvent JSON objects. Other lines are ignored. */
export function createParser() {
  let sawResult = false;
  let sessionId = null;
  function push(line) {
    if (typeof line !== 'string') return [];
    const text = line.trim();
    if (!text || text[0] !== '{') return [];
    let e;
    try { e = JSON.parse(text); } catch { return []; }
    if (!isObj(e)) return [];
    const event = normalize(e);
    if (!event) return [];
    if ((event.t === 'init' || event.t === 'result') && event.sessionId) sessionId = event.sessionId;
    if (event.t === 'result') {
      sawResult = true;
      if (!event.sessionId) event.sessionId = sessionId;
    }
    return [event];
  }
  function end({ code = null, signal = null, stderrTail = '' } = {}) {
    if (sawResult) return [];
    const lines = String(stderrTail ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const how = signal ? `was stopped by ${signal}` : `ended with exit code ${code}`;
    const message = `The agent process ${how} without a result${lines.length ? `: ${lines[lines.length - 1].slice(0, 200)}` : ''}`;
    return [
      { t: 'error', kind: 'other', message, resetAt: null },
      { t: 'result', ok: false, text: '', sessionId, usd: null, turns: 0, durationMs: 0 },
    ];
  }
  return { push, end };
}

/**
 * @param {{ shellEnv: { base: Function }, log?: Function, script?: string }} deps  script: another agent script (tests)
 */
export function createMockAdapter({ shellEnv, log = noop, script = AGENT_SCRIPT } = {}) {
  if (!shellEnv) throw new Error('createMockAdapter needs shellEnv');
  void log;

  function buildRun({ agent, prompt, systemPrompt, cwd, sessionId, mcp, runDir, speed } = {}) {
    if (!cwd || !runDir) throw new Error('mock: buildRun needs cwd and runDir');
    const roleFile = path.join(runDir, 'role.txt');
    return {
      cmd: process.execPath,
      args: [script],
      env: {
        ...shellEnv.base(),
        SHOP_MCP_URL: String(mcp?.url ?? ''),
        SHOP_TOKEN: String(mcp?.token ?? ''),
        MOCK_ROLE: String(agent?.role ?? 'maker'),
        MOCK_HANDLE: String(agent?.handle ?? ''),
        MOCK_SESSION: String(sessionId ?? ''),
        MOCK_SYSTEM_FILE: roleFile,
        // The agent's own pace (a demo job) wins over settings.mockSpeed.
        MOCK_SPEED: String(Number.isFinite(agent?.mockSpeed) && agent.mockSpeed >= 0 ? agent.mockSpeed : speed ?? '1'),
      },
      cwd,
      stdin: String(prompt ?? ''),
      files: [{ path: roleFile, content: `${String(systemPrompt ?? '').trim()}\n` }],
      hubFiles: {},
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      stopSignal: 'SIGTERM',
    };
  }

  return {
    id: 'mock',
    label: 'Mock lab',
    lab: 'mock',
    binary: 'node',
    keyVar: null,
    selfTestModel: 'mock',
    policyNote: () => ({
      subscription: { lines: ['The mock lab runs a scripted fake agent.', 'It uses no tokens and no account.', 'It is for the demo and the tests.'], url: null },
      apikey: { lines: ['The mock lab needs no API key.', 'Nothing is billed.', 'It is for the demo and the tests.'], url: null },
    }),
    locate: () => process.execPath,
    buildRun,
    createParser: () => createParser(),
    classify: () => ({ kind: null, message: '', resetAt: null }),
    loginCommand: () => null,
    installHint: () => null,
  };
}
