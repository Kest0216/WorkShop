// Google lab adapter: the Antigravity CLI `agy` (provider id stays "gemini").
//
// Built from the docs and the help text of agy 1.5.1, then checked against one real signed-in run of agy 1.5.1
// (docs/ARCHITECTURE.md section 14c; streams in tests/fixtures/gemini/). That run proved: the flags below, the
// stream shapes, `<api id>-<effort>` model slugs, `.agents/mcp_config.json` with eager tools, the rule
// `mcp(shop/*)`, and that `.agents/rules/*.md` is NOT applied in -p runs (so no rules file is written).
// Still not proven: API key mode, read access, web access, trusting mode, quota, model and sign-in error
// texts, and --effort next to a slug. The shim gets its URL from a file in the run folder (--url-file), so no
// URL, token or env block is in the bench file. Every agy-specific string lives in the AGY
// table below, so a correction needs an edit in one place only. The parser accepts the documented shapes,
// ignores unknown keys, and never throws.
//
// Safety: this module never runs agy by itself. It only builds a command for the runner or the registry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseResetAt } from './claude.js';

const noop = () => {};

// =============================================================================================
// AGY TABLE: every string that belongs to the agy CLI. Correct these after the first real run.
// =============================================================================================
export const AGY = {
  binary: 'agy',
  /** Folders checked after PATH (file-existence check only). */
  extraDirs: (home) => [home ? path.join(home, '.local', 'bin') : null, '/Applications/Gemini.app/Contents/Helpers'].filter(Boolean),

  flags: {
    prompt: '-p',
    outputFormat: ['--output-format', 'stream-json'],
    model: '--model',
    effort: '--effort',
    settings: '--settings',
    printTimeout: '--print-timeout',
    logFile: '--log-file',
    conversation: '--conversation',
  },
  /** The only agy call the hub makes outside a job (owner pressed "Re-check"). */
  modelsArgs: ['models'],
  versionArgs: ['--version'],

  /** 'slug+effort': --model <id>-<effort> --effort <effort> (contract). 'slug': --model <id>-<effort>. 'base+effort': --model <id> --effort <effort>. */
  modelStyle: 'slug+effort',
  effortOrder: ['low', 'medium', 'high', 'xhigh', 'max'],
  /** Thinking levels per model. First matching prefix wins. */
  efforts: [
    ['gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh']],
    ['gemini-4-carbon', ['low', 'medium', 'high']],
    ['gemini-4-argon', ['low', 'medium', 'high']],
    ['gemini-3.8-flash', ['low', 'medium', 'high']],
    ['gemini-3.5-flash-lite', []],
    ['', ['low', 'medium', 'high']],
  ],

  /**
   * Files inside the bench (the workspace). agy has no flag for an MCP config path or a system prompt.
   * No rules file: agy does not apply `.agents/rules/*.md` in -p runs (real run). The role card leads the prompt.
   */
  benchFiles: {
    mcpConfig: '.agents/mcp_config.json',
    longPrompt: '.agents/workshop-prompt.md',
  },
  /** Files inside the per-agent run folder (data/run/<agentId>/, never inside a bench). */
  runFiles: { settings: 'settings.json', log: 'agy.log' },

  mcpServerName: 'shop',
  mcpTimeoutSeconds: 120,
  /**
   * The stdio shim reads the hub URL (it ends with the agent's token) from this file at start:
   * `<node> <shim> --url-file <data/run/<agentId>/mcp-url>`. No URL, token or env block is in the bench file.
   */
  shimUrlFileFlag: '--url-file',
  /**
   * 'fifo': the runner gives agy a real pipe that is already at end-of-file. That is the case that was seen to
   * fail cleanly without a login. /dev/null starts a browser sign-in. Node's own 'pipe' is a socket pair.
   */
  stdinKind: 'fifo',
  /** Hub tools that are loaded with their full schema up front ("eager"). */
  eagerTools: ['post', 'read', 'claim', 'status', 'task_add', 'task_update', 'task_retry', 'task_cancel', 'plan_submit', 'req_add', 'req_verify', 'job_report'],
  /** Tool names the model sees: eager tools are mcp_<server>_<tool>; lazy calls go through this tool. */
  eagerToolPrefix: (server) => `mcp_${server}_`,
  lazyTool: 'call_mcp_tool',

  settings: {
    sandboxed: {
      agentMode: 'accept-edits',
      toolPermission: 'proceed-in-sandbox',
      enableTerminalSandbox: true,
      allowNonWorkspaceAccess: false,
    },
    trusting: {
      agentMode: 'accept-edits',
      toolPermission: 'request-review',
      enableTerminalSandbox: false,
      allowNonWorkspaceAccess: false,
    },
    allow: (server) => [`mcp(${server}/*)`],
    allowAllCommands: ['command(*)'], // trusting only
    allowWeb: ['read_url(*)'],
    // The real run proved the form command(<prefix>) (git push, sudo). The hub owns git: these are hints.
    deny: [
      'command(git push)', 'command(git commit)', 'command(git merge)', 'command(git rebase)',
      'command(git reset)', 'command(git checkout)', 'command(sudo)',
    ],
    denyWrites: ['write_file(*)', 'write_file(/)'], // read access (reviewers)
    apiKeyProvider: { modelProvider: 'gemini' },
  },

  env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  apiKeyVar: 'GEMINI_API_KEY',
  /** A prompt longer than this goes into a bench file (a command line has a size limit). */
  maxPromptArgBytes: 120_000,
  defaultPrintTimeoutMin: 45,
  /** agy's own time limit is this much longer than the hub's, so the hub's watchdog decides (killed: 'timeout'). */
  printTimeoutMarginMin: 1,
  /** Context window per model family (tokens, input plus output). First matching prefix wins. */
  contextTokens: [['gemini-4-', 1_048_576]],
  selfTestModel: 'gemini-4-hydrogen',
  /** The only settings keys a worker settings file may hold (section 10; the CLI rejects unknown keys). */
  settingsKeys: ['agentMode', 'toolPermission', 'enableTerminalSandbox', 'allowNonWorkspaceAccess', 'permissions', 'modelProvider'],

  stderrErrorPrefix: 'AGY_ERROR:',
  okStatus: 'SUCCESS',
  stoppedStatus: ['CANCELED', 'INTERRUPTED'],
  errors: {
    auth: [/authenticat/i, /\bunauthenticated\b/i, /log ?in required/i, /run 'agy' to log in/i, /invalid api key/i, /api key not valid/i, /GEMINI_API_KEY/],
    rateLimit: [/RESOURCE_EXHAUSTED/i, /\bquota\b/i, /rate.?limit/i, /\b429\b/, /too many requests/i, /usage limit/i],
    unknownModel: [/unknown model/i, /model .{0,60}not (?:found|available|supported|allowed)/i, /invalid model/i, /no such model/i, /not available (?:on|for) your (?:plan|account|tier)/i, /requires? (?:a )?(?:paid|higher|ultra|pro) (?:plan|tier|subscription)/i],
    badSettings: [/settings/i, /unknown key/i, /invalid value/i],
  },
};
// =============================================================================================

/** The 3-line policy note for API key mode, with its source (Keys panel). Consumer subscription login is disabled in Phase 0. */
export const POLICY_NOTE = Object.freeze({
  apikey: {
    lines: [
      'Primary Frontier Orchestration Officer, Decision Router & Final Review Gate; billed per token.',
      'Automated use through the Gemini API is allowed and capped by the job budget.',
      'Heavy field work runs on your $0 Open-Source Specialists.',
    ],
    url: 'https://ai.google.dev/gemini-api/terms',
  },
});

/**
 * Defense in depth: an agy without a login opens Google sign-in pages in the owner's browser.
 * - WORKSHOP_DISABLE_AGY=1 forbids every agy run.
 * - Inside a node:test process only a binary under the temp folder may run (a fake binary made by a test).
 * @returns {{ ok: boolean, why: string|null }}
 */
export function agyMayRun(binPath, env = process.env) {
  if (env?.WORKSHOP_DISABLE_AGY === '1') {
    return { ok: false, why: 'WORKSHOP_DISABLE_AGY=1 forbids every agy run' };
  }
  if (env?.NODE_TEST_CONTEXT) {
    let target = typeof binPath === 'string' && binPath ? path.resolve(binPath) : '';
    if (target) {
      try {
        target = fs.realpathSync(target);
      } catch {
        try {
          target = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
        } catch {
          // keep unresolved path.resolve result
        }
      }
    }
    const roots = new Set();
    const addRoot = (dir) => {
      if (typeof dir !== 'string' || !dir) return;
      roots.add(path.resolve(dir));
      try { roots.add(fs.realpathSync(dir)); } catch { /* ignore */ }
    };
    addRoot(os.tmpdir());
    if (env.TMPDIR) addRoot(env.TMPDIR);
    if (!target || ![...roots].some((r) => target === r || target.startsWith(`${r}${path.sep}`))) {
      return { ok: false, why: 'Inside node:test WorkShop may never run the real agy binary' };
    }
  }
  return { ok: true, why: null };
}

const clip = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const some = (list, text) => list.some((re) => re.test(text));
/** "gemini-4-hydrogen-low" -> "gemini-4-hydrogen": the registry id that the router and the holds use. */
export const baseModel = (slug) => String(slug ?? '').replace(new RegExp(`-(?:${AGY.effortOrder.join('|')})$`), '');

/**
 * Classify an agy error text.
 * @returns {{ kind: 'rate_limit'|'auth'|null, message: string, resetAt: number|null }}
 */
export function classify(text, now = Date.now()) {
  const message = typeof text === 'string' ? clip(text, 300) : '';
  if (!message) return { kind: null, message: '', resetAt: null };
  if (some(AGY.errors.auth, message)) return { kind: 'auth', message, resetAt: null };
  if (some(AGY.errors.rateLimit, message)) return { kind: 'rate_limit', message, resetAt: parseResetAt(message, now) };
  return { kind: null, message, resetAt: null };
}

/** Effort level the model supports: the highest one that is not above the wanted one. null = none. */
export function clampEffort(modelId, effort) {
  const row = AGY.efforts.find(([prefix]) => modelId.startsWith(prefix));
  const allowed = row ? row[1] : [];
  if (allowed.length === 0) return null;
  const want = AGY.effortOrder.indexOf(String(effort ?? '').toLowerCase());
  if (want < 0) return allowed.includes('medium') ? 'medium' : allowed[0];
  for (let i = want; i >= 0; i--) if (allowed.includes(AGY.effortOrder[i])) return AGY.effortOrder[i];
  return allowed[0];
}

/**
 * The --model and --effort arguments. With a model list from `agy models` the adapter picks a form that the
 * list holds. Without one it follows AGY.modelStyle.
 */
export function modelArgs(modelId, effort, knownModels = null, style = AGY.modelStyle) {
  const level = clampEffort(modelId, effort);
  if (!level) return [AGY.flags.model, modelId];
  const slug = `${modelId}-${level}`;
  if (Array.isArray(knownModels) && knownModels.length > 0) {
    if (knownModels.includes(slug)) return style === 'slug+effort' ? [AGY.flags.model, slug, AGY.flags.effort, level] : [AGY.flags.model, slug];
    if (knownModels.includes(modelId)) return [AGY.flags.model, modelId, AGY.flags.effort, level];
  }
  if (style === 'slug') return [AGY.flags.model, slug];
  if (style === 'base+effort') return [AGY.flags.model, modelId, AGY.flags.effort, level];
  return [AGY.flags.model, slug, AGY.flags.effort, level];
}

/** "shop.post" for mcp_shop_post and for call_mcp_tool with ServerName/ToolName. */
function toolName(name, params) {
  const raw = String(name ?? 'tool');
  if (raw === AGY.lazyTool && isObj(params)) {
    const server = params.ServerName ?? params.serverName ?? params.server_name;
    const tool = params.ToolName ?? params.toolName ?? params.tool_name;
    if (typeof server === 'string' && typeof tool === 'string') return `${server}.${tool}`;
  }
  const prefix = AGY.eagerToolPrefix(AGY.mcpServerName);
  if (raw.startsWith(prefix)) return `${AGY.mcpServerName}.${raw.slice(prefix.length)}`;
  return raw;
}

function toolSummary(name, params, cwd) {
  const shown = toolName(name, params);
  const p = isObj(params) ? params : {};
  if (shown.startsWith(`${AGY.mcpServerName}.`)) {
    const args = isObj(p.Arguments) ? p.Arguments : isObj(p.arguments) ? p.arguments : p;
    const tool = shown.slice(AGY.mcpServerName.length + 1);
    let hint = '';
    if (typeof args.line === 'string') {
      const head = args.line.split(/:(?:\s|$)/, 1)[0].trim().split(/\s+/);
      hint = head.filter((token, i) => (i === 0 ? /^[A-Z]{2,8}$/.test(token) : /^(?:@[\w-]+|T\d+|#[\w-]+|re:\w+)$/.test(token))).join(' ');
    } else if (typeof args.id === 'string') hint = clip(args.id, 40);
    else if (typeof args.scope === 'string') hint = clip(args.scope, 40);
    return clip(`${AGY.mcpServerName} ${tool} ${hint}`, 100);
  }
  const command = p.CommandLine ?? p.commandLine ?? p.command;
  if (typeof command === 'string') return `${shown} ${clip(command.split('\n')[0], 80)}`;
  const fileKey = Object.keys(p).find((k) => /file|path|uri/i.test(k) && typeof p[k] === 'string');
  if (fileKey) {
    let file = p[fileKey].replace(/^file:\/\//, '');
    if (cwd && file.startsWith(`${cwd}/`)) file = file.slice(cwd.length + 1);
    else if (path.isAbsolute(file)) file = `…/${file.split('/').filter(Boolean).slice(-3).join('/')}`;
    return `${shown} ${clip(file, 80)}`;
  }
  const query = p.Query ?? p.query ?? p.Url ?? p.url;
  if (typeof query === 'string') return `${shown} ${clip(query, 60)}`;
  return shown;
}

function deniedText(action) {
  if (typeof action === 'string') return clip(action, 120);
  if (!isObj(action)) return 'action';
  const name = action.tool_name ?? action.tool ?? action.name ?? action.action ?? action.type ?? 'action';
  const target = action.command ?? action.CommandLine ?? action.target ?? action.path ?? action.file ?? action.url ?? action.reason;
  const params = isObj(action.parameters) ? action.parameters : null;
  if (params) return clip(toolSummary(name, params, ''), 120);
  return clip(typeof target === 'string' ? `${name} ${target}` : String(name), 120);
}

/**
 * Parser for `agy --output-format stream-json` (lines keyed by "event") and for the single json object.
 * A failed result is held until end(), where the exit code and the AGY_ERROR line on stderr complete it.
 */
export function createParser({ now = () => Date.now() } = {}) {
  let cwd = '';
  let conversationId = null;
  let sawResult = false;
  let okResult = false;
  let pendingFail = null; // { status, text, reason, turns, durationMs, message }
  let textBuffer = '';
  let textStep = null;
  const toolSteps = new Set();
  const stepUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  let sawStepUsage = false;
  let usageSent = false;
  let model = null;

  // Token counts as agy 1.5.1 reports them (real run): input_tokens is the input that was NOT read from the
  // cache, cache_read_tokens comes on top, output_tokens already holds thinking_tokens, and
  // total_tokens = input_tokens + output_tokens. Each model call carries about 24,000 input tokens of base
  // context (60 tools in the init list).
  const usageEvent = (u) => ({ t: 'usage', inTok: num(u?.input_tokens), outTok: num(u?.output_tokens), cacheRead: num(u?.cache_read_tokens), cacheWrite: 0, usd: null });
  const contextMax = () => (model ? AGY.contextTokens.find(([prefix]) => model.startsWith(prefix))?.[1] ?? null : null);
  const flushText = () => {
    const text = textBuffer;
    textBuffer = '';
    textStep = null;
    return text.trim() ? [{ t: 'text', text }] : [];
  };

  function onInit(e) {
    const init = isObj(e.init) ? e.init : {};
    if (typeof e.conversation_id === 'string' && e.conversation_id) conversationId = e.conversation_id;
    if (typeof init.cwd === 'string') cwd = init.cwd;
    if (typeof init.model === 'string') model = init.model;
    // agy 1.5.1 lists no MCP servers in init (real run). If a later version does, a failed one is reported.
    const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
    const bad = servers.filter((s) => isObj(s) && typeof s.status === 'string' && !/^(connected|ready|ok)$/i.test(s.status));
    // loaded: the MCP servers named in init, and the servers behind eager tools (mcp_<server>_<tool>) in the
    // init tools list. The real run listed 60 built-in tools and call_mcp_tool, so this is empty there.
    const loaded = [];
    const add = (name) => { if (typeof name === 'string' && name && !loaded.includes(name)) loaded.push(clip(name, 80)); };
    for (const s of servers) add(isObj(s) ? s.name : s);
    for (const tool of Array.isArray(init.tools) ? init.tools : []) {
      const m = /^mcp_([A-Za-z0-9-]+)_./.exec(typeof tool === 'string' ? tool : '');
      if (m) add(m[1]);
    }
    const out = [{ t: 'init', sessionId: conversationId, model: typeof init.model === 'string' ? init.model : null, mcpOk: bad.length === 0, loaded }];
    if (bad.length > 0) out.push({ t: 'error', kind: 'mcp', message: clip(`MCP server not connected (${bad.map((s) => `${s.name ?? '?'}: ${s.status}`).join(', ')})`, 300), resetAt: null });
    return out;
  }

  function onStep(e) {
    const step = isObj(e.step_update) ? e.step_update : null;
    if (!step) return [];
    if (typeof step.conversation_id === 'string' && step.conversation_id && !conversationId) conversationId = step.conversation_id;
    const out = [];
    const index = step.step_index ?? null;
    const done = step.state === 'DONE';
    if (done && isObj(step.usage)) {
      sawStepUsage = true;
      for (const key of Object.keys(stepUsage)) stepUsage[key] += num(step.usage[key]);
      // One finished model call: its input plus what it read from the cache is the context in use.
      const context = num(step.usage.input_tokens) + num(step.usage.cache_read_tokens);
      if (context > 0) out.push({ t: 'ctx', tokens: context, max: contextMax() });
    }
    if (step.step_type === 'agent_response') {
      if (textStep !== null && textStep !== index) out.push(...flushText());
      if (typeof step.text_delta === 'string') {
        textBuffer += step.text_delta;
        textStep = index;
        if (textBuffer.length > 8000) out.push(...flushText());
      }
      if (done) out.push(...flushText());
      return out;
    }
    if (step.step_type === 'tool' || step.tool_name || isObj(step.tool_info)) {
      out.push(...flushText());
      const info = isObj(step.tool_info) ? step.tool_info : {};
      const name = step.tool_name ?? info.name;
      const key = index ?? `${name}:${toolSteps.size}`;
      if (!toolSteps.has(key) && (done || name)) {
        if (toolSteps.size > 5000) toolSteps.clear();
        toolSteps.add(key);
        out.push({ t: 'tool', name: toolName(name, info.parameters), summary: toolSummary(name, info.parameters, cwd) });
      }
      if (done) {
        const failed = info.error !== undefined && info.error !== null && info.error !== '';
        const detail = failed ? (isObj(info.error) ? info.error.message ?? info.error.type : info.error) : info.output;
        const lines = String(detail ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        out.push({ t: 'tool_result', ok: !failed, summary: lines.length ? clip(lines[0], failed ? 160 : 80) + (lines.length > 1 ? ` (+${lines.length - 1} lines)` : '') : failed ? 'error' : 'ok' });
      }
      return out;
    }
    return out; // user_input, checkpoint, future step types
  }

  function onResult(r) {
    if (!isObj(r)) return [];
    sawResult = true;
    if (typeof r.conversation_id === 'string' && r.conversation_id) conversationId = r.conversation_id;
    const out = [...flushText()];
    // Usage of THIS run: the sum of its finished steps. In the real streams result.usage of a follow-up run
    // (--conversation) also held the tokens of the earlier runs (turn 2: input 50,201 = 47,922 + 2,279), while
    // its steps held only its own. result.usage is used only for a run without step usage.
    if (sawStepUsage) out.push(usageEvent(stepUsage));
    else if (isObj(r.usage)) out.push(usageEvent(r.usage));
    usageSent = true;
    for (const action of Array.isArray(r.denied_actions) ? r.denied_actions : []) out.push({ t: 'denied', what: deniedText(action) });
    const text = typeof r.response === 'string' ? r.response : '';
    const turns = num(r.num_turns);
    const durationMs = Math.round(num(r.duration_seconds) * 1000);
    const status = typeof r.status === 'string' ? r.status.toUpperCase() : '';
    if (status === AGY.okStatus && !r.finished_reason && !r.error) {
      okResult = true;
      pendingFail = null;
      out.push({ t: 'result', ok: true, text, sessionId: conversationId, usd: null, turns, durationMs });
      return out;
    }
    okResult = false;
    const reason = typeof r.finished_reason === 'string' ? r.finished_reason : '';
    const message = typeof r.error === 'string' && r.error ? r.error : isObj(r.error) ? String(r.error.message ?? r.error.type ?? '') : '';
    pendingFail = { status, text, reason, turns, durationMs, message };
    return out;
  }

  function push(line) {
    if (typeof line !== 'string') return [];
    const text = line.trim();
    if (!text || text[0] !== '{') return [];
    let e;
    try { e = JSON.parse(text); } catch { return []; }
    if (!isObj(e)) return [];
    try {
      if (e.event === 'init') return onInit(e);
      if (e.event === 'step_update') return onStep(e);
      if (e.event === 'result') return onResult(e.result);
      if (e.event === undefined && typeof e.status === 'string' && ('response' in e || 'conversation_id' in e)) return onResult(e); // --output-format json
      return [];
    } catch {
      return [];
    }
  }

  function stderrError(stderrTail) {
    const lines = String(stderrTail ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const marked = [...lines].reverse().find((l) => l.includes(AGY.stderrErrorPrefix));
    if (marked) {
      const raw = marked.slice(marked.indexOf(AGY.stderrErrorPrefix) + AGY.stderrErrorPrefix.length).trim();
      let detail = raw;
      try {
        const j = JSON.parse(raw);
        if (isObj(j)) {
          const parts = [j.message, j.error, j.status, j.code, j.http_code ?? j.httpCode, j.grpc_code ?? j.grpcCode, j.reason]
            .map((v) => (isObj(v) ? v.message ?? v.status ?? JSON.stringify(v) : v))
            .filter((v) => v !== undefined && v !== null && v !== '');
          detail = parts.length ? parts.join(' ') : raw;
        }
      } catch { /* keep the raw text */ }
      return clip(detail, 300);
    }
    const errLine = [...lines].reverse().find((l) => /^error\b/i.test(l)) ?? lines[lines.length - 1];
    return errLine ? clip(errLine, 300) : '';
  }

  function end({ code = null, signal = null, stderrTail = '' } = {}) {
    const out = [...flushText()];
    if (sawResult && okResult) return out;
    if (!usageSent && sawStepUsage) out.push(usageEvent(stepUsage));
    const fail = pendingFail ?? { status: '', text: '', reason: '', turns: 0, durationMs: 0, message: '' };
    const fromStderr = stderrError(stderrTail);
    const all = [fail.message, fromStderr].filter(Boolean).join(' | ');
    // A run that the hub stopped (cancel, timeout) reports a failed result without an error of its own.
    const stopped = sawResult && (AGY.stoppedStatus.includes(fail.status) || fail.reason === 'interrupted');
    if (!stopped) {
      const c = classify(all, now());
      let kind = c.kind ?? 'other';
      let message = c.message;
      if (!c.kind) {
        if (fail.reason === 'print_timeout') message = `agy stopped at its print timeout${message ? `: ${message}` : ''}`;
        else if (some(AGY.errors.unknownModel, all)) {
          kind = 'model'; // the CLI refused the model: unknown slug, or not on this plan
          message = `agy cannot use this model: ${message}`;
        }
        else if (code === 1 && some(AGY.errors.badSettings, all)) message = `agy refused its settings: ${message}`;
        else if (code === 2) message = `agy usage error: ${message || 'bad arguments'}`;
        else if (code === 3) message = `agy model or agent error: ${message || 'no detail'}`;
        else if (!message) {
          message = signal ? `agy was stopped by ${signal} without a result`
            : sawResult ? `agy ended with status ${fail.status || 'unknown'}` : `agy ended with exit code ${code} without a result`;
        }
      }
      const event = { t: 'error', kind, message: clip(message, 300), resetAt: kind === 'rate_limit' ? c.resetAt : null };
      if (kind === 'model' && model) event.model = baseModel(model);
      out.push(event);
    }
    out.push({ t: 'result', ok: false, text: fail.text, sessionId: conversationId, usd: null, turns: fail.turns, durationMs: fail.durationMs });
    return out;
  }

  return { push, end };
}

/** Model slugs printed by `agy models`: the first word of each line that looks like a model id. */
export function parseModels(stdout) {
  const found = [];
  for (const line of String(stdout ?? '').split('\n')) {
    for (const word of line.trim().split(/[\s|,]+/)) {
      const slug = word.replace(/^[*\-•>]+/, '').replace(/[,;:]+$/, '');
      if (/^(?:gemini|claude|gpt)-[a-z0-9][a-z0-9.\-]*$/.test(slug) && !found.includes(slug)) found.push(slug);
    }
  }
  return found;
}

/**
 * @param {{ shellEnv: { resolve: Function, base: Function }, log?: Function }} deps
 */
export function createGeminiAdapter({ shellEnv, log = noop } = {}) {
  if (!shellEnv) throw new Error('createGeminiAdapter needs shellEnv');
  void log;
  let knownModels = null;

  /** Absolute path of agy, or null. Checks file existence only. It never runs the binary. */
  function locate() {
    if (process.env.WORKSHOP_DISABLE_AGY === '1') return null;
    const home = shellEnv.base?.()?.HOME || '';
    return shellEnv.resolve(AGY.binary, AGY.extraDirs(home));
  }

  function settingsFor({ safety, access, web, mode }) {
    const trusting = safety === 'trusting';
    const s = AGY.settings;
    const allow = [...s.allow(AGY.mcpServerName), ...(trusting ? s.allowAllCommands : []), ...(web ? s.allowWeb : [])];
    const deny = [...s.deny, ...(access === 'read' ? s.denyWrites : [])];
    const all = { ...(trusting ? s.trusting : s.sandboxed), permissions: { allow, deny }, ...(mode === 'apikey' ? s.apiKeyProvider : {}) };
    // Only keys of section 10: the CLI ends the run with exit 1 on a key it does not know.
    return Object.fromEntries(Object.entries(all).filter(([key]) => AGY.settingsKeys.includes(key)));
  }

  /**
   * Build one worker turn. stdin is '' with stdinKind 'fifo' on purpose: the runner then gives agy a real pipe
   * that is already at end-of-file. With /dev/null on stdin an agy without a login opens a browser sign-in.
   */
  function buildRun({
    model, effort, prompt, systemPrompt, cwd, sessionId, resume = false, mcp, access = 'write', web = false,
    runDir, mode, keyEnv, safety = 'sandboxed', bin, timeoutMs,
  } = {}) {
    if (!cwd || !runDir) throw new Error('gemini: buildRun needs cwd and runDir');
    if (!mcp?.url || !mcp?.token || !mcp?.shimPath) throw new Error('gemini: buildRun needs mcp.url, mcp.token and mcp.shimPath');
    if (mode !== 'subscription' && mode !== 'apikey') throw new Error('gemini: the sign-in mode is not chosen');
    const modelId = typeof model === 'string' ? model.trim() : typeof model?.id === 'string' ? model.id.trim() : '';
    if (!modelId) throw new Error('gemini: buildRun needs a model id');
    const followUp = resume === true && typeof sessionId === 'string' && sessionId.length > 0;
    const role = String(systemPrompt ?? '').trim();
    const task = String(prompt ?? '');
    // agy has no system-prompt flag, and it does not apply rules files in -p runs: the role card leads the
    // first prompt of a conversation. A follow-up turn already has it in the conversation.
    let text = followUp || !role ? task : `${role}\n\n---\n\n${task}`;

    // The URL with the token goes into a file of the run folder (mode 0600, outside the bench). The shim reads
    // it at start. The bench file names only that path: no URL, no token, no env block.
    const wanted = typeof mcp.urlFile === 'string' && mcp.urlFile ? mcp.urlFile : path.join(runDir, 'mcp-url');
    // Resolved first: "<runDir>/../x" names a path outside the run folder although it starts with it.
    const urlFile = path.resolve(wanted);
    if (!path.isAbsolute(wanted) || !urlFile.startsWith(`${path.resolve(runDir)}${path.sep}`)) throw new Error('gemini: mcp.urlFile must be inside the run folder');
    const shopUrl = `${String(mcp.url).replace(/\/+$/, '')}/${mcp.token}`;
    const mcpConfig = {
      mcpServers: {
        [AGY.mcpServerName]: {
          command: mcp.nodePath || process.execPath,
          args: [mcp.shimPath, AGY.shimUrlFileFlag, urlFile],
          timeoutSeconds: AGY.mcpTimeoutSeconds,
          tools: Object.fromEntries((Array.isArray(mcp.tools) && mcp.tools.length ? mcp.tools : AGY.eagerTools).map((tool) => [tool, { eager: true }])),
        },
      },
    };
    const settingsFile = path.join(runDir, AGY.runFiles.settings);
    const files = [
      { path: urlFile, content: shopUrl },
      { path: settingsFile, content: `${JSON.stringify(settingsFor({ safety, access, web, mode }), null, 2)}\n` },
    ];
    // Bench files: the runner writes them with git.writeHubFiles (paths under .agents/, never committed).
    const hubFiles = { [AGY.benchFiles.mcpConfig]: `${JSON.stringify(mcpConfig, null, 2)}\n` };
    if (Buffer.byteLength(text) > AGY.maxPromptArgBytes) {
      hubFiles[AGY.benchFiles.longPrompt] = text;
      text = `Read the file ${AGY.benchFiles.longPrompt} in the current folder now. It holds your full instructions. Follow them.`;
    }

    // `-p` takes the next argument as the prompt. A prompt that starts with "-" would be read as a flag
    // (agy: exit 2). A leading space keeps it a value.
    if (text.startsWith('-')) text = ` ${text}`;
    if (text === '') text = ' '; // `-p ""` is a usage error too: an empty prompt has nothing to do

    const minutes = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 60_000)) + AGY.printTimeoutMarginMin : AGY.defaultPrintTimeoutMin;
    const args = [
      AGY.flags.prompt, text,
      ...AGY.flags.outputFormat,
      ...modelArgs(modelId, effort, knownModels),
      AGY.flags.settings, settingsFile,
      AGY.flags.printTimeout, `${minutes}m`,
      AGY.flags.logFile, path.join(runDir, AGY.runFiles.log),
      ...(followUp ? [AGY.flags.conversation, sessionId] : []),
    ];

    const env = { ...shellEnv.base(), ...AGY.env };
    if (mode === 'apikey') {
      const key = keyEnv?.[AGY.apiKeyVar];
      if (typeof key !== 'string' || !key) throw new Error('gemini: API key mode needs a saved Gemini key');
      env[AGY.apiKeyVar] = key;
    }

    const cmd = bin || locate() || AGY.binary;
    const guard = agyMayRun(cmd);
    if (!guard.ok) throw new Error(`gemini: ${guard.why}`);
    return { cmd, args, env, cwd, stdin: '', stdinKind: AGY.stdinKind, files, hubFiles, sessionId: followUp ? sessionId : null, stopSignal: 'SIGINT' };
  }

  return {
    id: 'gemini',
    label: 'Antigravity CLI',
    lab: 'google',
    /** The MCP config of the agent is in a file of the work folder: the runner runs one agy turn per folder at a time. */
    exclusiveCwd: true,
    /** Before every spawn the runner calls git.cleanAgentDir(cwd, hub file paths): a planted hooks.json never runs. */
    cleanAgentDir: true,
    policyNote: () => structuredClone(POLICY_NOTE),
    binary: AGY.binary,
    keyVar: AGY.apiKeyVar,
    selfTestModel: AGY.selfTestModel,
    locate,
    buildRun,
    settingsFor,
    createParser: () => createParser(),
    classify,
    mayRun: (binPath) => agyMayRun(binPath),
    /** Model slugs of this account (from the owner's last check). The adapter uses them to pick the --model form. */
    setKnownModels(models) { knownModels = Array.isArray(models) && models.length ? [...models] : null; },
    /**
     * The owner-initiated check: `agy models`. The registry runs it with a real pipe on stdin that is at end-of-file.
     * There are no cheap probes: detection of agy is a file-existence check only.
     */
    authCheck: {
      /** The registry gives this check the same stdin as a worker turn: a real pipe at end-of-file. */
      stdin: AGY.stdinKind,
      /**
       * `agy models`. In apikey mode agy needs `modelProvider` from a settings FILE (--settings takes a path, as
       * in a worker turn): the registry writes settingsContent(mode) to settingsFile and passes the path.
       */
      args: (mode, settingsFile) => {
        if (mode !== 'apikey') return [...AGY.modelsArgs];
        if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) throw new Error('gemini: the apikey check needs a settings file path');
        return [AGY.flags.settings, settingsFile, ...AGY.modelsArgs];
      },
      settingsContent: (mode) => (mode === 'apikey' ? `${JSON.stringify(AGY.settings.apiKeyProvider, null, 2)}\n` : null),
      versionArgs: [...AGY.versionArgs],
      env: (mode, keyEnv) => {
        const env = { ...shellEnv.base(), ...AGY.env };
        if (mode === 'apikey' && typeof keyEnv?.[AGY.apiKeyVar] === 'string') env[AGY.apiKeyVar] = keyEnv[AGY.apiKeyVar];
        return env;
      },
      /** @returns {{ auth: 'ok'|'none'|'unknown', models: string[]|null, detail: string }} */
      parse: ({ code, stdout, stderr, timedOut }) => {
        const text = `${stdout ?? ''}\n${stderr ?? ''}`;
        if (timedOut) return { auth: 'unknown', models: null, detail: 'agy models did not answer in time' };
        if (code === 0) {
          const models = parseModels(stdout);
          return { auth: 'ok', models: models.length ? models : null, detail: `${models.length} models` };
        }
        if (some(AGY.errors.auth, text)) return { auth: 'none', models: null, detail: 'agy is not signed in' };
        return { auth: 'unknown', models: null, detail: clip(String(stderr ?? '').trim().split('\n').pop() || `agy models ended with exit code ${code}`, 200) };
      },
      parseVersion: (stdout) => /(\d+\.\d+\.\d+(?:[-.\w]*)?)/.exec(String(stdout ?? ''))?.[1] ?? null,
    },
    /** Consumer subscription login is disabled in Phase 0 (API key only). */
    loginCommand: () => null,
    installHint: () => ({
      text: 'Install the Gemini app for Mac (it bundles agy), or in Terminal: curl -fsSL https://antigravity.google/cli/install.sh | bash',
      url: 'https://antigravity.google/docs/install',
    }),
  };
}
