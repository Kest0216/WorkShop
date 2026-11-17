// Claude Code CLI adapter: builds the worker command and reads its stream-json output.
// Every flag here was run against the real CLI 2.1.289 with a local fake API (see docs/ARCHITECTURE.md section 10).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const noop = () => {};

// ---------------------------------------------------------------------------------------------
// Tables. Change behavior here, not in the code below.
// ---------------------------------------------------------------------------------------------

/** Aliases of this CLI version point at older models, so the adapter always sends a full id. */
export const MODEL_ALIASES = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-2',
};

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Effort levels per model. First matching prefix wins. An empty list means: send no --effort. */
export const MODEL_EFFORTS = [
  ['claude-haiku-4', []],
  ['claude-3', []],
  ['claude-', EFFORT_ORDER],
];

/**
 * History-changing git, sudo, installers piped into a shell, and the Keychain tool.
 * Deny rules hold in every permission mode. They are best effort: `sh -c "..."` hides a command from them.
 */
export const DENY_RULES = [
  'Bash(git push *)', 'Bash(git commit *)', 'Bash(git merge *)', 'Bash(git rebase *)',
  'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(sudo *)',
  // Both forms are needed: "x | sh" and "x | sh -s -- args" (proved against CLI 2.1.289; "x | shasum" still runs).
  'Bash(* | sh)', 'Bash(* | sh *)', 'Bash(* | bash)', 'Bash(* | bash *)', 'Bash(* | zsh)', 'Bash(* | zsh *)',
  // The OS sandbox does not close the Keychain: `security find-generic-password` reaches it from a sandboxed
  // command (proved against CLI 2.1.289 with an item that does not exist). The hub's API keys live there.
  'Bash(security *)', 'Bash(/usr/bin/security *)',
];

/** Hosts a sandboxed shell command may reach (package registries). Everything else is refused by the sandbox proxy. */
export const SANDBOX_DOMAINS = [
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'static.crates.io', 'index.crates.io',
  'proxy.golang.org', 'sum.golang.org', 'rubygems.org',
];

/** Credential places a sandboxed shell command may not read (relative to the home folder). */
export const SANDBOX_DENY_READ = [
  '.ssh', '.aws', '.gnupg', '.netrc', '.kube', '.docker', '.config/gh', '.config/gcloud',
  '.claude/.credentials.json', '.gemini', 'Library/Keychains',
];

/** Environment variables that sandboxed shell commands do not get. */
export const SANDBOX_HIDDEN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'WORKSHOP_TOKEN', 'WORKSHOP_TAG_URL'];

/** The one command hook of the mail hook (section 10). The CLI expands the variable from its environment. */
export const MAIL_HOOK_COMMAND = 'curl -s -m 2 "$WORKSHOP_TAG_URL"';

/** The 3-line policy note for API key mode, with its source (Keys panel). Consumer subscription login is disabled in Phase 0. */
export const POLICY_NOTE = Object.freeze({
  apikey: {
    lines: [
      'Used strictly for Frontier Orchestration & Final Review Gate turns; billed per token.',
      'Automated use through the commercial API is allowed and scoped by the job budget.',
      'Heavy execution work routes to your $0 Open-Source Specialists.',
    ],
    url: 'https://www.anthropic.com/legal/commercial-terms',
  },
});

const SANDBOX_NOTE = 'Sandbox: shell commands can write only inside the current folder. Network access is limited to package registries and localhost.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// Limit and sign-in texts
// ---------------------------------------------------------------------------------------------

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const JUST_PASSED_MS = 5 * 60_000; // a reset time this far in the past still means "now"
const SOON_MS = 60_000; // then: try again in one minute

function clockHour(hourText, ampm) {
  let hour = Number(hourText);
  if (ampm) {
    const pm = ampm.toLowerCase() === 'pm';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return hour;
}

/**
 * Find the reset time in a limit message: "resets 3:45pm", "resets Mon 12:00am", "resets Nov 20, 9am",
 * "resets in 3h 20m", "retry after 90 seconds". Clock times are local time.
 * @returns {number|null} epoch ms of the next such moment after `now`, or null
 */
export function parseResetAt(text, now = Date.now()) {
  if (typeof text !== 'string' || !text) return null;
  const rel = /(?:resets?|retry|try again|available)\s+(?:again\s+)?(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (rel) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const unit = m[2][0].toLowerCase();
      ms += Number(m[1]) * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000);
    }
    return ms > 0 ? now + Math.round(ms) : null;
  }
  // (?![\d:]) after the clock time: "resets Nov 20, 2026" must not be read as 20 o'clock.
  const m = /resets?\s+(?:at\s+|on\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?![\d:])\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  const [, day, month, dateText, hourText, minuteText, ampm] = m;
  const hour = clockHour(hourText, ampm);
  const minute = minuteText ? Number(minuteText) : 0;
  if (hour > 23 || minute > 59) return null;
  const base = new Date(now);
  // A text names the minute, not the second. A moment that passed a few minutes ago means "now", not the
  // same clock time tomorrow (or next week, or next year): else one late message pauses a lab for a day or more.
  const justPassed = (t) => t <= now && now - t < JUST_PASSED_MS;
  if (month) {
    const at = new Date(base.getFullYear(), MONTHS.indexOf(month.toLowerCase()), Number(dateText), hour, minute, 0, 0);
    if (justPassed(at.getTime())) return now + SOON_MS;
    if (at.getTime() <= now) at.setFullYear(at.getFullYear() + 1);
    return at.getTime();
  }
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  if (day) {
    const ahead = (DAYS.indexOf(day.toLowerCase()) - at.getDay() + 7) % 7;
    at.setDate(at.getDate() + ahead);
    if (justPassed(at.getTime())) return now + SOON_MS;
    if (at.getTime() <= now) at.setDate(at.getDate() + 7);
  } else if (at.getTime() <= now) {
    if (justPassed(at.getTime())) return now + SOON_MS;
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

const LIMIT_RE = [
  /you(?:'|’)?ve hit your .{0,40}?limit/i,
  /\b(?:usage|session|weekly|rate)[ _-]?limit (?:reached|exceeded|hit)/i,
  /rate[ _-]?limit(?:ed| error|_error)/i,
  /request rejected \(429\)/i,
  /temporarily limiting requests/i,
  /credit balance is too low/i,
  /\b429\b.{0,40}(?:too many requests|rate)/i,
  /too many requests/i,
];
const AUTH_RE = [
  /not logged in/i,
  /please run \/login/i,
  /authentication[_ ](?:failed|error)/i,
  /failed to authenticate/i,
  /invalid (?:api key|x-api-key|bearer token)/i,
  /oauth token (?:has )?(?:expired|been revoked)/i,
  /\b401\b.{0,30}unauthori[sz]ed/i,
];

/** The CLI or the API refused the model: unknown id, or not on this plan. */
const MODEL_RE = [
  /issue with the selected model/i,
  /\bmodel\b[^.]{0,80}?(?:not found|does not exist|may not exist|is not available|not supported|not allowed|no access)/i,
  /(?:unknown|invalid|unsupported) model/i,
  /not_found_error[^.]{0,40}model/i,
];
/** Model families that a per-model plan limit can name (rateLimitType "seven_day_opus", "your Opus limit"). */
const FAMILY_RE = /(?:^|[^a-z])(opus|sonnet|haiku|fable)(?:[^a-z]|$)/i;

/**
 * Classify an error text of the CLI. Only for texts that a structured field marked as an error (an API error
 * message, a result with is_error, stderr after a failed exit): never assistant text or tool output.
 * @returns {{ kind: 'rate_limit'|'auth'|'model'|null, message: string, resetAt: number|null }}
 */
export function classify(text, now = Date.now()) {
  const message = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (!message) return { kind: null, message: '', resetAt: null };
  if (LIMIT_RE.some((re) => re.test(message))) return { kind: 'rate_limit', message, resetAt: parseResetAt(message, now) };
  if (AUTH_RE.some((re) => re.test(message))) return { kind: 'auth', message, resetAt: null };
  if (MODEL_RE.some((re) => re.test(message))) return { kind: 'model', message, resetAt: null };
  return { kind: null, message, resetAt: null };
}

/** The model in use when a limit text or type names its family ("seven_day_opus" while Opus runs), else null. */
export function limitedModel(text, model) {
  const family = FAMILY_RE.exec(String(text ?? ''))?.[1]?.toLowerCase();
  return family && typeof model === 'string' && model.toLowerCase().includes(family) ? model : null;
}

// ---------------------------------------------------------------------------------------------
// Short summaries for the log
// ---------------------------------------------------------------------------------------------

const clip = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function shortPath(file, cwd) {
  if (typeof file !== 'string' || !file) return '';
  if (cwd && (file === cwd || file.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`))) return clip(path.relative(cwd, file) || '.', 80);
  if (!path.isAbsolute(file)) return clip(file, 80);
  const parts = file.split('/').filter(Boolean);
  return clip(parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : file, 80);
}

/** "DONE T12 tests=41/41: text" -> "DONE T12". Keeps the kind, the addressee, the scope and the reference only. */
function postHead(line) {
  if (typeof line !== 'string') return '';
  const head = line.split(/:(?:\s|$)/, 1)[0].trim().split(/\s+/);
  const keep = head.filter((token, i) => i === 0 ? /^[A-Z]{2,8}$/.test(token) : /^(?:@[\w-]+|T\d+|#[\w-]+|re:\w+)$/.test(token));
  return keep.join(' ');
}

/** Name the log shows: "shop.post" for mcp__shop__post, the plain name for built-in tools. */
export function toolDisplayName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(name ?? ''));
  return m ? `${m[1]}.${m[2]}` : String(name ?? 'tool');
}

/** A short, human readable line for one tool call. Never the full input. */
export function toolSummary(name, input, cwd = '') {
  const args = input !== null && typeof input === 'object' ? input : {};
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(name ?? ''));
  if (mcp) {
    const [, server, tool] = mcp;
    let hint = '';
    if (tool === 'post') hint = postHead(args.line);
    else if (Array.isArray(args.tasks)) hint = `${args.tasks.length} tasks`;
    else if (Array.isArray(args.results)) hint = `${args.results.length} results`;
    else if (Array.isArray(args.paths)) hint = `${args.paths.length} paths`;
    else {
      const key = ['id', 'scope', 'title', 'name'].find((k) => typeof args[k] === 'string' && args[k]);
      if (key) hint = clip(args[key], 40);
    }
    return hint ? `${server} ${tool} ${hint}` : `${server} ${tool}`;
  }
  switch (name) {
    case 'Bash': return `Bash ${clip(String(args.command ?? '').split('\n')[0], 80)}`.trim();
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit': case 'MultiEdit':
      return `${name} ${shortPath(args.file_path ?? args.notebook_path ?? '', cwd)}`.trim();
    case 'Glob': case 'Grep': return `${name} ${clip(args.pattern ?? '', 40)}`.trim();
    case 'WebSearch': return `WebSearch ${clip(args.query ?? '', 60)}`.trim();
    case 'WebFetch': {
      let where = '';
      try { const u = new URL(String(args.url)); where = clip(u.host + (u.pathname === '/' ? '' : u.pathname), 60); } catch { where = ''; }
      return `WebFetch ${where}`.trim();
    }
    case 'Task': case 'Agent': return `${name} ${clip(args.description ?? '', 40)}`.trim();
    default: return String(name ?? 'tool');
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('\n');
}

function resultSummary(text, ok) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return ok ? 'ok' : 'error';
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : '';
  return clip(lines[0], ok ? 80 : 160) + more;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

/**
 * Stream-json parser. push(line) takes one stdout line. end() must be called when the process is gone.
 * Unknown event types and malformed lines are ignored.
 */
export function createParser({ now = () => Date.now() } = {}) {
  let cwd = '';
  let sessionId = null;
  let model = null;
  let sawResult = false;
  let errorSent = false; // an error event went out for the current turn
  let authStormSent = false;
  let lastRetry = null; // { error, status }
  let rejectedResetAt = null; // from a rate_limit_event line that refused the request
  let rejectedModel = null; // the model that a refusing rate_limit_event named (per-model limit)
  let lastCtx = 0; // context size of the latest model call (input + cache read + cache write)
  const tools = new Map(); // tool_use id -> summary
  const deniedIds = new Set();
  const usageByMessage = new Map(); // message id -> usage (fallback when the process dies without a result)

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usageEvent = (u, usd) => {
    const event = {
      t: 'usage', inTok: num(u?.input_tokens), outTok: num(u?.output_tokens),
      cacheRead: num(u?.cache_read_input_tokens), cacheWrite: num(u?.cache_creation_input_tokens),
      usd: typeof usd === 'number' && Number.isFinite(usd) ? usd : null,
    };
    // The part of the cache writes with a one-hour lifetime. It costs more than the five-minute kind.
    const hour = num(u?.cache_creation?.ephemeral_1h_input_tokens);
    if (hour > 0) event.cacheWrite1h = Math.min(hour, event.cacheWrite);
    return event;
  };
  const contextOf = (u) => num(u?.input_tokens) + num(u?.cache_read_input_tokens) + num(u?.cache_creation_input_tokens);

  function errorFromText(text, hint) {
    const c = classify(text, now());
    let kind = c.kind;
    if (!kind && hint === 'authentication_failed') kind = 'auth';
    if (!kind && (hint === 'rate_limit' || hint === 429)) kind = 'rate_limit';
    // 'model_not_found': the error field of the CLI's synthetic message for a refused model (404, recorded).
    if (!kind && (hint === 'model' || hint === 'model_not_found')) kind = 'model';
    let resetAt = c.resetAt;
    if (kind === 'rate_limit' && resetAt === null && rejectedResetAt !== null) resetAt = rejectedResetAt;
    const event = { t: 'error', kind: kind ?? 'other', message: c.message || 'Claude Code reported an error', resetAt: kind === 'rate_limit' ? resetAt : null };
    if (kind === 'model' && model) event.model = model;
    if (kind === 'rate_limit') {
      const one = rejectedModel ?? limitedModel(c.message, model);
      if (one) event.model = one; // a per-model limit: the runner cools that model only
    }
    return event;
  }

  function onSystem(e) {
    switch (e.subtype) {
      case 'init': {
        if (typeof e.cwd === 'string') cwd = e.cwd;
        if (typeof e.session_id === 'string') sessionId = e.session_id;
        if (typeof e.model === 'string') model = e.model;
        const servers = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
        const skipped = Array.isArray(e.mcp_server_errors) ? e.mcp_server_errors : [];
        const bad = servers.filter((s) => s?.status !== 'connected');
        const mcpOk = bad.length === 0 && skipped.length === 0;
        // Every MCP server and plugin this worker loaded (the self-test warns about anything besides `shop`).
        const loaded = [];
        for (const item of [...servers, ...(Array.isArray(e.plugins) ? e.plugins : [])]) {
          const name = typeof item === 'string' ? item : item?.name;
          if (typeof name === 'string' && name && !loaded.includes(name)) loaded.push(clip(name, 80));
        }
        const out = [{ t: 'init', sessionId, model: typeof e.model === 'string' ? e.model : null, mcpOk, loaded }];
        if (!mcpOk) {
          const what = [...bad.map((s) => `${s?.name ?? '?'}: ${s?.status ?? 'unknown'}`), ...skipped.map((s) => `${s?.name ?? '?'}: ${s?.type ?? 'skipped'}`)];
          out.push({ t: 'error', kind: 'mcp', message: clip(`MCP server not connected (${what.join(', ')})`, 300), resetAt: null });
          errorSent = true;
        }
        return out;
      }
      case 'api_retry': {
        lastRetry = { error: e.error ?? null, status: e.error_status ?? null };
        // A 401 is retried for minutes. Three tries are enough to call it a sign-in problem.
        if ((e.error === 'authentication_failed' || e.error_status === 401) && num(e.attempt) >= 3 && !authStormSent) {
          authStormSent = true;
          errorSent = true;
          return [{ t: 'error', kind: 'auth', message: 'The API refused the credentials (401) three times', resetAt: null }];
        }
        return [];
      }
      case 'permission_denied': {
        const id = e.tool_use_id;
        if (typeof id === 'string') {
          if (deniedIds.has(id)) return [];
          deniedIds.add(id);
        }
        return [{ t: 'denied', what: tools.get(id) ?? toolDisplayName(e.tool_name) }];
      }
      default: return []; // status, hooks, subagent task events, ...
    }
  }

  function onAssistant(e) {
    const msg = e.message;
    if (!msg || typeof msg !== 'object') return [];
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    if (e.error || e.is_api_error_message) {
      if (errorSent) return [];
      errorSent = true;
      return [errorFromText(resultText(blocks), e.error)];
    }
    const out = [];
    if (typeof msg.id === 'string' && msg.usage && typeof msg.usage === 'object') {
      if (usageByMessage.size > 5000) usageByMessage.clear();
      usageByMessage.set(msg.id, msg.usage);
      // The context bar of the UI: how full the context window is after the latest call of the main agent.
      const context = e.parent_tool_use_id ? 0 : contextOf(msg.usage);
      if (context > 0 && context !== lastCtx) {
        lastCtx = context;
        out.push({ t: 'ctx', tokens: context, max: null });
      }
    }
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) out.push({ t: 'text', text: block.text });
      else if (block.type === 'tool_use') {
        const summary = toolSummary(block.name, block.input, cwd);
        if (typeof block.id === 'string') {
          if (tools.size > 2000) tools.clear();
          tools.set(block.id, summary);
        }
        out.push({ t: 'tool', name: toolDisplayName(block.name), summary });
      }
    }
    return out;
  }

  function onUser(e) {
    const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
    const meta = Array.isArray(e.tool_result_meta) ? e.tool_result_meta : [];
    const out = [];
    for (const block of blocks) {
      if (!block || block.type !== 'tool_result') continue;
      const ok = block.is_error !== true;
      const refused = !ok && (deniedIds.has(block.tool_use_id) || meta.some((m) => m?.id === block.tool_use_id && m?.non_execution_kind));
      out.push({ t: 'tool_result', ok, summary: refused ? 'denied' : resultSummary(resultText(block.content), ok) });
    }
    return out;
  }

  function onResult(e) {
    sawResult = true;
    if (typeof e.session_id === 'string') sessionId = e.session_id;
    const usd = typeof e.total_cost_usd === 'number' && Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : null;
    const out = [usageEvent(e.usage, usd)];
    // Context window: its size comes with the result (modelUsage), its fill from the latest model call.
    const iterations = Array.isArray(e.usage?.iterations) ? e.usage.iterations : [];
    const context = lastCtx || (iterations.length ? contextOf(iterations[iterations.length - 1]) : 0);
    const windows = e.modelUsage && typeof e.modelUsage === 'object' ? e.modelUsage : {};
    const own = model && windows[model] ? windows[model] : Object.values(windows)[0];
    const max = num(own?.contextWindow);
    if (context > 0 || max > 0) out.push({ t: 'ctx', tokens: context, max: max > 0 ? max : null });
    for (const d of Array.isArray(e.permission_denials) ? e.permission_denials : []) {
      const id = d?.tool_use_id;
      if (typeof id === 'string') {
        if (deniedIds.has(id)) continue;
        deniedIds.add(id);
      }
      out.push({ t: 'denied', what: tools.get(id) ?? toolSummary(d?.tool_name, d?.tool_input, cwd) });
    }
    const text = typeof e.result === 'string' ? e.result : '';
    const ok = e.is_error !== true;
    const interrupted = e.terminal_reason === 'aborted_streaming' || e.terminal_reason === 'aborted_tools';
    if (!ok && !errorSent && !interrupted) {
      const limitText = Array.isArray(e.errors) && e.errors.length ? e.errors.join('; ') : '';
      if (e.subtype === 'error_max_turns' || e.subtype === 'error_max_budget_usd' || e.subtype === 'error_max_structured_output_retries') {
        out.push({ t: 'error', kind: 'other', message: clip(limitText || e.subtype, 300), resetAt: null });
      } else {
        const hint = e.api_error_status === 429 || lastRetry?.error === 'rate_limit' || lastRetry?.status === 429 ? 'rate_limit'
          : e.api_error_status === 401 || lastRetry?.error === 'authentication_failed' ? 'authentication_failed'
            : e.api_error_status === 404 ? 'model' : null;
        out.push(errorFromText(text || limitText || `Claude Code ended with ${e.subtype ?? 'an error'}`, hint));
      }
    }
    out.push({
      t: 'result', ok, text, sessionId, usd,
      turns: num(e.num_turns), durationMs: num(e.duration_ms),
    });
    // A process can print more than one result. Start the next turn clean.
    errorSent = false;
    authStormSent = false;
    lastRetry = null;
    tools.clear();
    usageByMessage.clear();
    return out;
  }

  function push(line) {
    if (typeof line !== 'string') return [];
    const text = line.trim();
    if (!text || text[0] !== '{') return [];
    let e;
    try { e = JSON.parse(text); } catch { return []; }
    if (e === null || typeof e !== 'object' || Array.isArray(e)) return [];
    try {
      switch (e.type) {
        case 'system': return onSystem(e);
        case 'assistant': return onAssistant(e);
        case 'user': return onUser(e);
        case 'result': return onResult(e);
        case 'rate_limit_event': {
          // Real shape (CLI 2.1.289, subscription): {status:'allowed', resetsAt:<epoch seconds>, rateLimitType:'seven_day',
          // overageStatus, isUsingOverage, unifiedWindows:{seven_day:{utilization:0.11, resetsAt}}}.
          const info = e.rate_limit_info;
          if (!info || typeof info !== 'object') return [];
          const toMs = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : null);
          const status = typeof info.status === 'string' ? info.status : null;
          const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
          const window = type && info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows[type] : null;
          const resetAt = toMs(info.resetsAt) ?? toMs(window?.resetsAt);
          const utilization = typeof info.utilization === 'number' ? info.utilization : typeof window?.utilization === 'number' ? window.utilization : null;
          // 'allowed' and 'allowed_warning' let the request pass. Every other status refused it.
          // A type that names a model family ("seven_day_opus") is a per-model limit: only that model cools.
          const one = type ? limitedModel(type, model) : null;
          if (status !== null && !/^allowed/i.test(status)) {
            if (resetAt !== null) rejectedResetAt = resetAt;
            rejectedModel = one;
          }
          return [{ t: 'limit', status, type, utilization, resetAt, overage: info.isUsingOverage === true, ...(one ? { model: one } : {}) }];
        }
        default: return []; // stream_event, control_request, control_response, future types
      }
    } catch {
      return []; // a surprising shape must never stop the stream
    }
  }

  function end({ code = null, signal = null, stderrTail = '' } = {}) {
    if (sawResult) return [];
    const out = [];
    if (usageByMessage.size > 0) {
      const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      for (const u of usageByMessage.values()) for (const key of Object.keys(total)) total[key] += num(u[key]);
      out.push(usageEvent(total, null));
    }
    if (!errorSent) {
      // Lines like "[claude-code:unrecognized_model] {...}" are notes of the CLI, not the reason of a failure.
      const lines = String(stderrTail ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^\[claude-code:[\w-]+\]/.test(l));
      const line = lines.find((l) => /^error\b/i.test(l)) ?? lines[lines.length - 1] ?? '';
      if (line) out.push(errorFromText(line, null));
      else {
        const how = signal ? `was stopped by ${signal}` : `ended with exit code ${code}`;
        out.push({ t: 'error', kind: 'other', message: `Claude Code ${how} without a result`, resetAt: null });
      }
    }
    out.push({ t: 'result', ok: false, text: '', sessionId, usd: null, turns: 0, durationMs: 0 });
    return out;
  }

  return { push, end };
}

// ---------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------

function fullModelId(model) {
  const id = typeof model === 'string' ? model.trim() : typeof model?.id === 'string' ? model.id.trim() : '';
  if (!id) throw new Error('claude: buildRun needs a model id');
  return MODEL_ALIASES[id.toLowerCase()] ?? id;
}

/** The highest supported level that is not above the wanted one. null = send no --effort. */
export function clampEffort(modelId, effort) {
  const row = MODEL_EFFORTS.find(([prefix]) => modelId.startsWith(prefix));
  const allowed = row ? row[1] : EFFORT_ORDER;
  if (allowed.length === 0) return null;
  const want = EFFORT_ORDER.indexOf(String(effort ?? '').toLowerCase());
  if (want < 0) return allowed.includes('medium') ? 'medium' : allowed[0];
  for (let i = want; i >= 0; i--) if (allowed.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  return allowed[0];
}

/**
 * @param {{ shellEnv: { resolve: Function, base: Function }, log?: Function }} deps
 */
export function createClaudeAdapter({ shellEnv, log = noop } = {}) {
  if (!shellEnv) throw new Error('createClaudeAdapter needs shellEnv');
  void log;

  /** Absolute path of the claude binary, or null. File lookup only. */
  function locate() {
    const home = shellEnv.base().HOME;
    return shellEnv.resolve('claude', home ? [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')] : []);
  }

  function sandboxSettings(home, overrides, cwd, privateDirs) {
    const o = overrides && typeof overrides === 'object' ? overrides : {};
    // Each folder as given and with its links resolved (/var/... is /private/var/... on a Mac): the sandbox
    // works on real paths, and a rule that does not match would lock the agent out of its own bench.
    const bothForms = (dirs) => {
      const out = [];
      for (const dir of dirs) {
        let real = dir;
        try { real = fs.realpathSync(dir); } catch { /* the folder does not exist: keep it as given */ }
        for (const form of [dir, real]) if (!out.includes(form)) out.push(form);
      }
      return out;
    };
    const closed = bothForms((Array.isArray(privateDirs) ? privateDirs : []).filter((d) => typeof d === 'string' && path.isAbsolute(d)));
    return {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      network: {
        allowLocalBinding: o.localNetwork !== false,
        allowedDomains: Array.isArray(o.domains) ? o.domains.filter((d) => typeof d === 'string' && d) : SANDBOX_DOMAINS,
      },
      // A sandboxed command may read the whole computer by default. Closed: the credential places of the owner
      // and the hub's own data (the benches, run folders and logs of the other agents). The narrower allowRead
      // rule wins, so the bench of this agent stays readable (proved against CLI 2.1.289).
      filesystem: {
        denyRead: [...(home ? SANDBOX_DENY_READ.map((rel) => path.join(home, rel)) : []), ...closed],
        ...(closed.length > 0 ? { allowRead: bothForms([cwd]) } : {}),
      },
      credentials: { envVars: SANDBOX_HIDDEN_ENV.map((name) => ({ name, mode: 'deny' })) },
    };
  }

  /**
   * Build one worker turn. See docs/ARCHITECTURE.md section 10.
   * Safety 'sandboxed': the OS sandbox confines every Bash command (writes only in cwd, network allow list),
   * all Bash is allowed inside it. Safety 'trusting': no OS sandbox, all Bash allowed. Both: deny rules, file
   * tools write only inside cwd (acceptEdits). bypassPermissions is never used.
   */
  function buildRun({
    model, effort, prompt, systemPrompt, cwd, sessionId, resume = false, mcp, access = 'write', web = false,
    runDir, mode, keyEnv, safety = 'sandboxed', maxTurns, maxBudgetUsd, mailHook = false, bin, sandbox, privateDirs,
  } = {}) {
    if (!cwd || !runDir) throw new Error('claude: buildRun needs cwd and runDir');
    if (!mcp?.url || !mcp?.token) throw new Error('claude: buildRun needs mcp.url and mcp.token');
    if (mode !== 'subscription' && mode !== 'apikey') throw new Error('claude: the sign-in mode is not chosen');
    const modelId = fullModelId(model);
    const level = clampEffort(modelId, effort);
    const resuming = resume === true && typeof sessionId === 'string' && UUID_RE.test(sessionId);
    const session = resuming ? sessionId : (typeof sessionId === 'string' && UUID_RE.test(sessionId) ? sessionId : crypto.randomUUID());
    const base = shellEnv.base();
    const sandboxed = safety !== 'trusting';
    const mcpFile = path.join(runDir, 'mcp.json');
    const roleFile = path.join(runDir, 'role.txt');
    const settingsFile = path.join(runDir, 'settings.json');
    const hook = mailHook === true;
    const mcpBase = String(mcp.url).replace(/\/+$/, '');

    const tools = access === 'read' ? ['Bash', 'Read'] : ['Bash', 'Edit', 'Read', 'Write'];
    const allowed = ['mcp__shop', 'Bash'];
    if (web) {
      tools.push('WebSearch', 'WebFetch');
      allowed.push('WebSearch', 'WebFetch');
    }
    // The settings file (never inline on the command line). Without the mail hook every hook is off.
    const settings = hook
      ? { attribution: { commit: '', pr: '' }, hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: MAIL_HOOK_COMMAND, timeout: 5 }] }] } }
      : { disableAllHooks: true, attribution: { commit: '', pr: '' } };
    if (sandboxed) settings.sandbox = sandboxSettings(base.HOME, sandbox, cwd, privateDirs);
    const budget = mode === 'apikey' && typeof maxBudgetUsd === 'number' && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0
      ? String(Math.max(0.0001, Math.round(maxBudgetUsd * 10_000) / 10_000)) : null; // never "0"

    const args = [
      '-p',
      '--model', modelId,
      ...(level ? ['--effort', level] : []),
      '--output-format', 'stream-json', '--verbose',
      ...(resuming ? ['--resume', session] : ['--session-id', session]),
      '--setting-sources', '',
      '--strict-mcp-config', '--mcp-config', mcpFile,
      '--tools', tools.join(','),
      '--allowedTools', ...allowed,
      '--disallowedTools', ...DENY_RULES,
      '--permission-mode', access === 'read' ? 'dontAsk' : 'acceptEdits',
      '--disable-slash-commands',
      '--append-system-prompt-file', roleFile,
      ...(Number.isInteger(maxTurns) && maxTurns > 0 ? ['--max-turns', String(maxTurns)] : []),
      ...(budget ? ['--max-budget-usd', budget] : []), // apikey mode only: the CLI stops itself at this cost
      '--settings', settingsFile,
    ];

    const env = {
      ...base,
      DISABLE_AUTOUPDATER: '1',
      ENABLE_TOOL_SEARCH: 'false',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      WORKSHOP_TOKEN: String(mcp.token),
    };
    if (hook) env.WORKSHOP_TAG_URL = `${mcpBase}/${mcp.token}/tag`; // the hook command reads it; the sandbox hides it
    if (mode === 'apikey') {
      const key = keyEnv?.ANTHROPIC_API_KEY;
      if (typeof key !== 'string' || !key) throw new Error('claude: API key mode needs a saved Anthropic key');
      env.ANTHROPIC_API_KEY = key;
    }

    // The token stays out of the file: the CLI expands ${WORKSHOP_TOKEN} from the worker environment.
    const mcpConfig = {
      mcpServers: {
        shop: {
          type: 'http',
          url: `${mcpBase}/\${WORKSHOP_TOKEN}`,
          // X-WorkShop: the hub's HTTP guard wants it on every request that is not a GET.
          headers: { Authorization: 'Bearer ${WORKSHOP_TOKEN}', 'X-WorkShop': '1' },
          alwaysLoad: true,
        },
      },
    };
    const role = `${String(systemPrompt ?? '').trim()}${sandboxed ? `\n\n${SANDBOX_NOTE}` : ''}\n`;

    return {
      cmd: bin || locate() || 'claude',
      args,
      env,
      cwd,
      stdin: String(prompt ?? ''),
      files: [
        { path: mcpFile, content: `${JSON.stringify(mcpConfig, null, 2)}\n` },
        { path: roleFile, content: role },
        { path: settingsFile, content: `${JSON.stringify(settings, null, 2)}\n` },
      ],
      hubFiles: {},
      sessionId: session,
      stopSignal: 'SIGINT',
    };
  }

  return {
    id: 'claude',
    label: 'Claude Code',
    lab: 'anthropic',
    binary: 'claude',
    keyVar: 'ANTHROPIC_API_KEY',
    selfTestModel: 'claude-haiku-5-5',
    policyNote: () => structuredClone(POLICY_NOTE),
    locate,
    buildRun,
    createParser: () => createParser(),
    classify,
    /** Cheap and safe probes for the registry. Both run in the clean environment. */
    probes: {
      version: {
        args: ['--version'],
        parse: (stdout) => /(\d+\.\d+\.\d+(?:[-.\w]*)?)/.exec(String(stdout ?? ''))?.[1] ?? null,
      },
      auth: {
        args: ['auth', 'status', '--json'],
        /** @returns {'ok'|'none'|'unknown'} */
        parse: (stdout) => {
          const text = String(stdout ?? '');
          const a = text.indexOf('{');
          const b = text.lastIndexOf('}');
          if (a < 0 || b < a) return 'unknown';
          try {
            const status = JSON.parse(text.slice(a, b + 1));
            return status.loggedIn === true ? 'ok' : status.loggedIn === false ? 'none' : 'unknown';
          } catch {
            return 'unknown';
          }
        },
      },
      env: () => ({ ...shellEnv.base(), DISABLE_AUTOUPDATER: '1' }),
    },
    /** Consumer subscription login is disabled in Phase 0 (API key only). */
    loginCommand: () => null,
    installHint: () => ({
      text: 'Install Claude Code in Terminal: curl -fsSL https://claude.ai/install.sh | bash',
      url: 'https://code.claude.com/docs/en/setup',
    }),
  };
}
