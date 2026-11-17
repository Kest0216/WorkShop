// Hub tools over MCP (Model Context Protocol): the JSON-RPC 2.0 endpoint that the agent CLIs call.
//
// Each agent gets a random token. Its CLI has one MCP server named "shop" that ends at POST /mcp/<token>,
// through server/mcp-stdio-shim.mjs (stdio) or directly (Streamable HTTP with plain JSON answers).
// Other modules register the tools: board.js (post, read) and orchestrator.js (the workflow tools).
//
// The endpoint keeps no session. The token is the identity, and no call needs an earlier `initialize`.
// So a new CLI process, a resumed session, or a second connection of the same agent works at once.
//
// What the two clients do (measured with Claude Code 2.1.289; Antigravity CLI from its documentation):
//   stdio  initialize (protocolVersion "2025-11-25") -> notifications/initialized -> tools/list -> tools/call
//   HTTP   first a "server/discover" probe that must fail (-32601 is the tested answer), then the same
//          sequence, plus one GET that asks for an event stream (405 is the tested answer).
//   Claude Code hides MCP tools behind its tool search unless a tool carries _meta "anthropic/alwaysLoad".
//   The Antigravity CLI calls tools through one generic call_mcp_tool. Its model may not see the schema,
//   so an argument error names the bad field and shows the expected shape.
//
// Nothing here logs tool arguments or tool results: they can hold text that the board refused to store.
//
// The hub has one thread, and tool arguments are text that a model wrote. So an argument check that
// uses a `pattern` of the schema runs with a time limit (see withinBudget): a text that makes a regular
// expression backtrack for minutes costs a fraction of a second and an error result, not the whole hub.
//
// Wiring (index.js):
//   const mcp = createMcp({ store, redactor, log });         // every live token is in the redactor
//   board.registerTools(mcp);                               // post, read, setTagProvider, setUrgentProvider
//   mountMcp(http, mcp, { log });                           // POST /mcp/:token ; GET /mcp/:token/tag
//   const { url } = await http.listen();                    // an agent's endpoint: `${url}/mcp/${mcp.tokenFor(agent.id)}`

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import vm from 'node:vm';

/** MCP protocol revisions this endpoint speaks, newest first. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const SERVER_NAME = 'shop';
const SERVER_VERSION = '0.1.0';
const INSTRUCTIONS =
  'Hub tools of the WorkShop crew. Follow your role card. A tool error is one line: fix the call and send it again.';

// JSON-RPC error codes.
const E_PARSE = -32700;
const E_REQUEST = -32600;
const E_METHOD = -32601;
const E_PARAMS = -32602;
const E_INTERNAL = -32603;
const E_UNKNOWN_AGENT = -32001;

const CALL_RING = 200; // tool calls remembered per agent
const MAX_TRACKED_AGENTS = 1000; // agents that have a call ring; the least recently active one goes first
const MAX_TOKENS = 2000; // live tokens; over the limit, the token that was not used for the longest time goes
const MAX_TOKEN_CHARS = 256;
const MAX_BATCH = 50; // messages in one JSON-RPC batch
const MAX_PROBLEMS = 4; // argument problems named in one error line
const MAX_DEPTH = 32; // nesting of tool arguments
const MAX_ERROR_CHARS = 700; // one argument error line
const MAX_DESCRIPTION_CHARS = 240; // a longer tool description gets a warning
const CHECK_BUDGET_MS = 250; // time limit for one argument check that uses a `pattern`
const MAX_REGEX_CACHE = 500; // compiled patterns kept
const MAX_TIMER_MS = 2 ** 31 - 1; // a longer setTimeout fires after 1 ms
const LOG_BURST = 20; // log lines with the same message in LOG_WINDOW_MS that a caller can cause; more are counted, not written
const LOG_BURST_DEBUG = 200; // the same for the debug line of every tool call and every initialize
const LOG_WINDOW_MS = 10_000;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,48}$/; // Claude sees mcp__shop__<name>, and that must stay under 64
const KNOWN_ROLES = ['boss', 'manager', 'maker'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TYPE_NAMES = ['object', 'array', 'string', 'boolean', 'number', 'integer', 'null'];
/** The one problem that validateArgs gives when a check ran out of time. */
const SLOW_CHECK = 'the arguments took too long to check (a text is too long or too complex for its pattern)';

// JSON Schema keywords that validateArgs checks, and keywords that only describe.
const CHECKED = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'allOf', 'anyOf', 'oneOf',
]);
const DESCRIBES = new Set(['description', 'title', 'default', 'examples', '$schema', '$id', '$comment', 'format', 'deprecated']);

const TIMED_OUT = Symbol('timed out');
const noop = () => {};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
const isId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const sha256 = (text) => createHash('sha256').update(text).digest();
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
// Control characters (C0, DEL, C1) and the Unicode line separators: text from an agent must not bring them into a log line or an error line.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** One line of printable text: the first line, with control characters removed. */
const oneLine = (text, max) => cut(String(text).split('\n')[0].replace(CONTROL_CHARS, ' ').trim(), max);
/** The message of a thrown value as one short line. Never throws: '' when the value has no text form. */
function errorLine(err) {
  try {
    return oneLine(err instanceof Error ? err.message : err, 200);
  } catch {
    return '';
  }
}
/** The stack of a thrown value, for the log. Never throws. */
function errorStack(err) {
  try {
    return err instanceof Error ? String(err.stack || err.message) : String(err);
  } catch {
    return 'a thrown value that has no text form';
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** JSON text that holds an object -> the object; anything else -> null. */
function jsonObject(text) {
  try {
    const value = JSON.parse(text);
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

// ---- argument validation (a JSON Schema subset) ---------------------------------------------

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function isType(type, v) {
  switch (type) {
    case 'object': return isObj(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'null': return v === null;
    default: return true; // an unknown type name does not block a call
  }
}

const article = (type) => (type === 'null' ? 'null' : /^[aeio]/.test(type) ? `an ${type}` : `a ${type}`);
const same = (a, b) => a === b || (isObj(a) || Array.isArray(a) ? JSON.stringify(a) === JSON.stringify(b) : false);
/** A field name for an error line: as it is when it is a plain name, else quoted, short, and without raw control characters. */
const fieldName = (key) => (key.length <= 40 && /^[A-Za-z_$][\w$]*$/.test(key)
  ? key
  : JSON.stringify(cut(key, 40)).replace(CONTROL_CHARS, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`));
const fieldPath = (path, key) => (path ? `${path}.${fieldName(key)}` : fieldName(key));
const label = (path) => path || 'arguments';

function countChars(text) {
  let n = 0;
  for (const _ of text) n += 1; // code points, as JSON Schema counts
  return n;
}

const regexCache = new Map(); // pattern text -> RegExp | null (not a regular expression); the oldest entry goes at the limit
function regexFor(pattern) {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    re = null;
    for (const flags of ['u', '']) {
      try {
        re = new RegExp(pattern, flags);
        break;
      } catch { /* try without the unicode flag, then give up */ }
    }
    if (regexCache.size >= MAX_REGEX_CACHE) regexCache.delete(regexCache.keys().next().value);
    regexCache.set(pattern, re);
  }
  return re;
}

// ---- a time limit for checks that run a regular expression -------------------------------------------
//
// JavaScript cannot stop a regular expression that backtracks. node:vm can: a script that runs with
// the `timeout` option is stopped by V8, also in the middle of a regular expression. The check runs
// in the main context (the script only calls the function), so nothing is copied.

let sandbox = null; // { context, script }, made at the first use
let limited = false; // inside withinBudget: a nested check is covered by the limit of the outer one

/**
 * Run fn() with a time limit. Returns false when the limit stopped it (fn may then be half done).
 * The limit is wall-clock time. On a machine that is very busy, the hub can get almost no processor
 * time for that long, and a harmless check would look slow. So when the process used less than half
 * of the limit as processor time, fn() runs again (three tries in all). fn must be safe to run again.
 */
function withinBudget(fn, ms) {
  if (limited) {
    fn();
    return true;
  }
  sandbox ??= { context: vm.createContext(Object.create(null)), script: new vm.Script('run()') };
  const timeout = Math.min(Math.max(1, Math.ceil(ms)), MAX_TIMER_MS);
  sandbox.context.run = fn;
  limited = true;
  try {
    for (let attempt = 1; ; attempt += 1) {
      const before = process.cpuUsage();
      try {
        sandbox.script.runInContext(sandbox.context, { timeout });
        return true;
      } catch (err) {
        if (err?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err;
        const spent = process.cpuUsage(before);
        const busyMs = (spent.user + spent.system) / 1000;
        if (attempt >= 3 || busyMs >= timeout / 2) return false; // the check itself used the time
      }
    }
  } finally {
    limited = false;
    sandbox.context.run = undefined;
  }
}

const patternSchemas = new WeakMap(); // frozen schema object -> boolean: a `pattern` is somewhere in it

/** True when a check of this schema can run a regular expression. */
function usesPattern(schema) {
  if (!isObj(schema)) return false;
  if (!Object.isFrozen(schema)) return findPattern(schema, 0); // it can still change: look every time
  let known = patternSchemas.get(schema);
  if (known === undefined) {
    known = findPattern(schema, 0);
    patternSchemas.set(schema, known);
  }
  return known;
}

function findPattern(schema, depth) {
  if (!isObj(schema)) return false;
  if (depth > 64) return true; // too deep to tell (a schema that holds itself?): use the time limit
  if (typeof schema.pattern === 'string') return true;
  const parts = [schema.items, schema.additionalProperties];
  if (isObj(schema.properties)) parts.push(...Object.values(schema.properties));
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(schema[key])) parts.push(...schema[key]);
  return parts.some((part) => findPattern(part, depth + 1));
}

function passes(schema, value) {
  const out = [];
  check(schema, value, '', out);
  return out.length === 0;
}

/** Append to `out` what is wrong with `value`: short clauses that name the field. */
function check(schema, value, path, out) {
  if (out.length >= MAX_PROBLEMS || schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    out.push(`${label(path)} is not allowed`);
    return;
  }
  if (!isObj(schema)) return;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => isType(type, value))) {
      out.push(`${label(path)} must be ${types.map(article).join(' or ')} (got ${kindOf(value)})`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value))) {
    out.push(`${label(path)} must be one of ${cut(schema.enum.map((option) => JSON.stringify(option)).join(', '), 160)}`);
    return;
  }
  if (Object.hasOwn(schema, 'const') && !same(schema.const, value)) {
    out.push(`${label(path)} must be ${cut(JSON.stringify(schema.const) ?? 'null', 80)}`);
    return;
  }

  if (typeof value === 'string') {
    const { minLength, maxLength, pattern } = schema;
    const length = Number.isInteger(maxLength) && value.length > maxLength ? countChars(value) : 0;
    if (length > maxLength) {
      out.push(`${label(path)} is too long (${length} characters, limit ${maxLength})`); // and no pattern test on an oversized text
    } else if (typeof pattern === 'string' && regexFor(pattern)?.test(value) === false) {
      out.push(`${label(path)} does not match the pattern ${cut(pattern, 60)}`);
    }
    if (Number.isInteger(minLength) && minLength > 0 && (value.length < minLength || countChars(value) < minLength)) {
      out.push(value ? `${label(path)} is too short (minimum ${minLength} characters)` : `${label(path)} is empty`);
    }
  } else if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push(`${label(path)} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push(`${label(path)} must be at most ${schema.maximum}`);
  } else if (Array.isArray(value)) {
    const { minItems, maxItems, items } = schema;
    if (Number.isInteger(minItems) && value.length < minItems) {
      out.push(`${label(path)} needs at least ${minItems} item${minItems === 1 ? '' : 's'} (got ${value.length})`);
    }
    if (Number.isInteger(maxItems) && value.length > maxItems) {
      out.push(`${label(path)} has too many items (${value.length}, limit ${maxItems})`);
    }
    if (items !== undefined && !Array.isArray(items)) {
      for (let i = 0; i < value.length && out.length < MAX_PROBLEMS; i++) check(items, value[i], `${path}[${i}]`, out);
    }
  } else if (isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (out.length >= MAX_PROBLEMS) return;
      if (typeof key === 'string' && !Object.hasOwn(value, key)) out.push(`${fieldPath(path, key)} is missing`);
    }
    const extra = schema.additionalProperties;
    for (const key of Object.keys(value)) {
      if (out.length >= MAX_PROBLEMS) return;
      if (Object.hasOwn(props, key)) check(props[key], value[key], fieldPath(path, key), out);
      else if (extra === false) out.push(`${fieldPath(path, key)} is not a known field`);
      else if (isObj(extra)) check(extra, value[key], fieldPath(path, key), out);
    }
  }

  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) check(part, value, path, out);
  if (out.length >= MAX_PROBLEMS) return;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((part) => passes(part, value))) {
    out.push(`${label(path)} does not match an allowed form`);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((part) => passes(part, value)).length !== 1) {
    out.push(`${label(path)} must match exactly one allowed form`);
  }
}

/** A reason to refuse raw arguments whatever the schema says, or null. */
function unsafeArgs(value, depth = 0) {
  if (value === null || typeof value !== 'object') return null;
  if (depth > MAX_DEPTH) return 'arguments are nested too deep';
  for (const key of Object.keys(value)) {
    if (!Array.isArray(value) && UNSAFE_KEYS.has(key)) return `${key} is not allowed as a field name`;
    const reason = unsafeArgs(value[key], depth + 1);
    if (reason) return reason;
  }
  return null;
}

/**
 * Check tool arguments against a JSON Schema subset: type, enum, const, properties, required,
 * additionalProperties, items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum,
 * allOf, anyOf, oneOf. Other keywords are ignored.
 * @param {object} schema
 * @param {*} value
 * @param {number} [budgetMs=250] time limit for a check of a schema that holds a `pattern` (a regular
 *   expression can backtrack for minutes on a hostile text); 0 = no limit. A check that runs out of
 *   time gives one problem: "the arguments took too long to check (...)".
 * @returns {string[]} at most 4 problems, each a short clause that names the field ("line is missing");
 *   empty when the value is valid. A problem never quotes an argument value.
 */
export function validateArgs(schema, value, budgetMs = CHECK_BUDGET_MS) {
  const unsafe = unsafeArgs(value);
  if (unsafe) return [unsafe];
  const out = [];
  const run = () => {
    out.length = 0; // a run that the time limit stopped can start again
    check(schema, value, '', out);
  };
  if (!(budgetMs > 0) || !usesPattern(schema)) run();
  else if (!withinBudget(run, budgetMs)) return [SLOW_CHECK];
  return out.slice(0, MAX_PROBLEMS);
}

/** The expected arguments in one short line: {line: string, scope?: string}. */
function shape(schema, depth = 0) {
  if (!isObj(schema)) return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.map((option) => JSON.stringify(option)).join('|');
  const type = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
  if (type === 'array') {
    const item = shape(schema.items, depth);
    return `${item.includes('|') && !item.startsWith('{') ? `(${item})` : item}[]`;
  }
  if (type === 'object' || isObj(schema.properties)) {
    const props = isObj(schema.properties) ? Object.keys(schema.properties) : [];
    if (props.length === 0) return schema.additionalProperties === false ? '{}' : 'object';
    if (depth >= 2) return '{...}';
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return `{${props.map((key) => `${key}${required.has(key) ? '' : '?'}: ${shape(schema.properties[key], depth + 1)}`).join(', ')}}`;
  }
  return typeof type === 'string' ? type : 'any';
}

/** Schema keywords that validateArgs does not check (so the handler must). */
function uncheckedKeywords(schema, found = new Set()) {
  if (!isObj(schema)) return found;
  for (const [key, sub] of Object.entries(schema)) {
    if (key === 'properties') {
      if (isObj(sub)) for (const child of Object.values(sub)) uncheckedKeywords(child, found);
    } else if (key === 'items' && Array.isArray(sub)) {
      found.add('items (the list form)');
    } else if (key === 'items' || key === 'additionalProperties') {
      uncheckedKeywords(sub, found);
    } else if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
      if (Array.isArray(sub)) for (const child of sub) uncheckedKeywords(child, found);
    } else if (!CHECKED.has(key) && !DESCRIBES.has(key)) {
      found.add(key);
    }
  }
  return found;
}

const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * What is wrong with a schema so that validateArgs would skip a check without a word (a keyword
 * with a value of the wrong kind is ignored), or so that no call could ever pass. null = usable.
 * @param {*} schema  a plain-JSON schema
 * @param {string} where  the place, for the message: "inputSchema.properties.line"
 */
function schemaFault(schema, where) {
  if (typeof schema === 'boolean') return null;
  if (!isObj(schema)) return `${where} must be a schema object`;
  const { type, properties, required, additionalProperties: extra } = schema;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0 || !types.every((name) => TYPE_NAMES.includes(name))) return `${where}.type must be one of ${TYPE_NAMES.join(', ')}`;
  }
  if (properties !== undefined) {
    if (!isObj(properties)) return `${where}.properties must be an object`;
    for (const [key, sub] of Object.entries(properties)) {
      if (UNSAFE_KEYS.has(key)) return `${where}.properties.${key} can never be sent: the hub refuses this field name`;
      const fault = schemaFault(sub, `${where}.properties.${fieldName(key)}`);
      if (fault) return fault;
    }
  }
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((key) => typeof key === 'string')) return `${where}.required must be a list of field names`;
    const lost = extra === false ? required.find((key) => !isObj(properties) || !Object.hasOwn(properties, key)) : undefined;
    if (lost !== undefined) return `${where}.required names ${fieldName(lost)}, which is not in properties: no call could pass`;
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return `${where}.enum must be a list with one value or more`;
  if (schema.pattern !== undefined && (typeof schema.pattern !== 'string' || regexFor(schema.pattern) === null)) {
    return `${where}.pattern must be a regular expression as text`;
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && !isCount(schema[key])) return `${where}.${key} must be a whole number, 0 or more`;
  }
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && !(typeof schema[key] === 'number' && Number.isFinite(schema[key]))) return `${where}.${key} must be a number`;
  }
  if (schema.items !== undefined && !Array.isArray(schema.items)) {
    const fault = schemaFault(schema.items, `${where}.items`);
    if (fault) return fault;
  }
  if (extra !== undefined) {
    const fault = schemaFault(extra, `${where}.additionalProperties`);
    if (fault) return fault;
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const parts = schema[key];
    if (parts === undefined) continue;
    if (!Array.isArray(parts) || parts.length === 0) return `${where}.${key} must be a list of schemas`;
    for (let i = 0; i < parts.length; i++) {
      const fault = schemaFault(parts[i], `${where}.${key}[${i}]`);
      if (fault) return fault;
    }
  }
  return null;
}

// ---- the endpoint -------------------------------------------------------------------------------

/**
 * Create the MCP endpoint.
 * @param {object} deps
 * @param {object} deps.store              the store (section 5); only store.get('agents', id) is needed
 * @param {{ add(value), remove(value) }} [deps.redactor]  server/redact.js: every live token is added at mint
 *   and removed at revoke (also when the agent leaves the store or the token table drops it)
 * @param {Function} [deps.log]            log(level, msg, data?)
 * @param {() => number} [deps.now]        clock, for tests
 * @param {string} [deps.version]          serverInfo.version
 * @param {string} [deps.instructions]     the `instructions` text of the initialize answer (keep it short)
 * @param {number} [deps.callTimeoutMs]    an async tool handler (or tag provider) that takes longer gets an error
 *   result; 0 or Infinity = no limit. The default (90 s) is below the limits of the callers: the shim waits
 *   110 s, the Antigravity CLI 120 s.
 * @param {number} [deps.argCheckMs]       time limit for the argument check of a tool whose schema holds a
 *   `pattern` (default 250 ms; 0 = no limit). See validateArgs.
 * @param {number} [deps.maxResultChars]   longer tool results are cut
 * @param {object|null} [deps.toolMeta]    `_meta` of every listed tool; null = none
 */
export function createMcp({
  store,
  redactor = null,
  log = noop,
  now = Date.now,
  version = SERVER_VERSION,
  instructions = INSTRUCTIONS,
  callTimeoutMs = 90_000,
  argCheckMs = CHECK_BUDGET_MS,
  maxResultChars = 20_000,
  toolMeta = { 'anthropic/alwaysLoad': true },
} = {}) {
  if (!store || typeof store.get !== 'function') throw new TypeError('createMcp needs a store');

  const meta = isObj(toolMeta) ? deepFreeze(JSON.parse(JSON.stringify(toolMeta))) : null;
  // A setTimeout above 2^31-1 ms fires after 1 ms. So a huge limit is the largest timer, and Infinity is no limit.
  const callLimitMs = Number.isFinite(callTimeoutMs) && callTimeoutMs > 0 ? Math.min(callTimeoutMs, MAX_TIMER_MS) : 0;
  const tools = new Map(); // name -> { name, roles: Set|null, description, inputSchema, handler }
  const tokens = new Map(); // agentId -> { token, digest }, least recently used first
  const calls = new Map(); // agentId -> [{ name, ok, ts }], most recently active agent last
  let tagProvider = null;
  let urgentProvider = null;
  let slowChecks = 0; // argument checks that hit their time limit; a batch reads it to know when to make a pause

  /** Log without ever throwing. */
  function say(level, msg, data) {
    try {
      log(level, msg, data);
    } catch { /* a broken logger must not break a tool call */ }
  }

  const logWindows = new Map(); // message -> { start, count, dropped }; the messages are the few fixed texts of this file

  /**
   * Log a line that an agent can cause as often as it likes (a call to a tool it does not have, a
   * handler that fails, or just a call). At most LOG_BURST lines with one message go out per LOG_WINDOW_MS
   * (LOG_BURST_DEBUG for debug lines), so an agent in a loop cannot fill the hub log. The first line of the
   * next window says how many were left out (data.notLogged).
   */
  function sayOften(level, msg, data) {
    const burst = level === 'debug' ? LOG_BURST_DEBUG : LOG_BURST;
    const t = Date.now();
    let window = logWindows.get(msg);
    if (!window || t - window.start >= LOG_WINDOW_MS) {
      const dropped = window ? window.dropped : 0;
      window = { start: t, count: 0, dropped: 0 };
      logWindows.set(msg, window);
      if (dropped > 0) data = { ...data, notLogged: dropped };
    }
    if (window.count >= burst) {
      window.dropped += 1;
      return;
    }
    window.count += 1;
    say(level, msg, data);
  }

  // ---- tokens ----

  /**
   * The token of an agent: 32 random bytes as hex. The same token for the same id while this process
   * lives and until revoke(). Tokens live in memory only: after a restart, ask again.
   */
  function tokenFor(agentId) {
    if (typeof agentId !== 'string' || !agentId) throw new TypeError('mcp.tokenFor needs an agent id');
    const known = tokens.get(agentId);
    if (known) {
      used(agentId); // the runner asks at the start of every turn: this agent is at work
      return known.token;
    }
    const token = randomBytes(32).toString('hex');
    // The redactor must know a token before anybody can see it: a token it refused is never handed out.
    if (redactor && typeof redactor.add === 'function') {
      try {
        redactor.add(token);
      } catch (err) {
        throw new Error(`mcp.tokenFor: the redactor did not take the new token (${errorLine(err) || 'error'})`);
      }
    }
    tokens.set(agentId, { token, digest: sha256(token) });
    if (tokens.size > MAX_TOKENS) dropStaleTokens(agentId);
    return token;
  }

  /** Forget the token of an agent: it is invalid from now on, and the redactor no longer needs it. */
  function forget(agentId) {
    const entry = tokens.get(agentId);
    if (!entry) return;
    tokens.delete(agentId);
    if (redactor && typeof redactor.remove === 'function') {
      try {
        redactor.remove(entry.token);
      } catch (err) {
        say('warn', 'mcp: the redactor could not remove a revoked token', { agent: agentId, error: errorLine(err) });
      }
    }
  }

  /** Mark the token of an agent as just used: it is the last one that the size limit takes. */
  function used(agentId) {
    const entry = tokens.get(agentId);
    if (!entry) return;
    tokens.delete(agentId);
    tokens.set(agentId, entry);
  }

  /**
   * Over the limit: first forget agents that are not in the store, then the tokens that were not used
   * for the longest time (asked for with tokenFor, or sent with a request). Never the newest.
   * So an agent that works keeps its token, however long ago it got it.
   */
  function dropStaleTokens(newestId) {
    for (const id of [...tokens.keys()]) if (id !== newestId && !findAgent(id)) forget(id);
    while (tokens.size > MAX_TOKENS) forget(tokens.keys().next().value);
    say('warn', 'mcp: too many agent tokens, dropped the oldest', { kept: tokens.size });
  }

  /** Make the token of this agent invalid. A later tokenFor() gives a new one. */
  function revoke(agentId) {
    forget(agentId);
  }

  /** Agent id for a token, or null. The time it takes does not depend on how close a wrong token is. */
  function agentIdFor(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
    const digest = sha256(token);
    let found = null;
    for (const [agentId, entry] of tokens) {
      if (timingSafeEqual(digest, entry.digest)) found = agentId; // no early exit
    }
    return found;
  }

  function findAgent(agentId) {
    try {
      return store.get('agents', agentId) ?? null;
    } catch {
      return null;
    }
  }

  /** The live agent item for a token, or null (unknown token, or the agent left the store). */
  function agentFor(token) {
    const agentId = agentIdFor(token);
    return agentId === null ? null : findAgent(agentId);
  }

  // A removed agent needs no token and no call history.
  if (typeof store.subscribe === 'function') {
    store.subscribe((event) => {
      if (event?.type === 'remove' && event.kind === 'agents' && typeof event.id === 'string') {
        forget(event.id);
        calls.delete(event.id);
      }
    });
  }

  // ---- tools ----

  /**
   * Register a hub tool (or replace the one with the same name).
   * @param {string} name                 letters, digits, _ and -; at most 48 characters
   * @param {object} def
   * @param {string[]} def.roles          agent roles that get the tool: 'boss' | 'manager' | 'maker', or ['all']
   * @param {string} def.description      short: it costs tokens in every agent context
   * @param {object} [def.inputSchema]    JSON Schema with type "object"; default: no arguments. A keyword
   *   that the argument check would skip without a word is an error here (a `type` that is no JSON Schema
   *   type, a `pattern` that is no regular expression, an `enum` that is no list, ...): see schemaFault.
   * @param {(agent: object, args: object) => string | {text: string, isError?: boolean} | Promise} def.handler
   *   Gets the live agent item and the validated arguments. A thrown error becomes an error result.
   *   For a refusal ("ERR E_HEAD ...") return { text, isError: true }: the model then sees a failed call and
   *   callsSince() reports ok: false. Answer fast (see callTimeoutMs): start long work and return.
   */
  function registerTool(name, def) {
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
      throw new TypeError(`mcp.registerTool: bad tool name ${JSON.stringify(name)} (use letters, digits, _ or -, at most 48)`);
    }
    if (!isObj(def)) throw new TypeError(`mcp.registerTool(${name}) needs { roles, description, inputSchema, handler }`);
    if (typeof def.handler !== 'function') throw new TypeError(`mcp.registerTool(${name}): handler must be a function`);
    if (typeof def.description !== 'string' || !def.description.trim()) {
      throw new TypeError(`mcp.registerTool(${name}): description must be a short text`);
    }
    const roles = rolesOf(name, def.roles);
    const inputSchema = schemaOf(name, def.inputSchema);
    if (def.description.length > MAX_DESCRIPTION_CHARS) {
      say('warn', 'mcp: a long tool description costs tokens in every agent context', { tool: name, chars: def.description.length });
    }
    if (tools.has(name)) say('warn', 'mcp: tool registered twice, the new one wins', { tool: name });
    tools.set(name, { name, roles, description: def.description.trim(), inputSchema, handler: def.handler });
  }

  function rolesOf(name, roles) {
    const list = typeof roles === 'string' ? [roles] : roles;
    if (!Array.isArray(list) || list.length === 0 || !list.every((role) => typeof role === 'string' && role)) {
      throw new TypeError(`mcp.registerTool(${name}): roles must be a list such as ['boss', 'manager'] or ['all']`);
    }
    if (list.includes('all') || list.includes('*')) return null;
    const unknown = list.filter((role) => !KNOWN_ROLES.includes(role));
    if (unknown.length) say('info', 'mcp: tool registered for a role that is not boss, manager or maker', { tool: name, roles: unknown });
    return new Set(list);
  }

  function schemaOf(name, inputSchema) {
    if (inputSchema === undefined || inputSchema === null) {
      return deepFreeze({ type: 'object', properties: {}, additionalProperties: false });
    }
    let schema;
    try {
      schema = JSON.parse(JSON.stringify(inputSchema)); // a private, plain-JSON copy
    } catch {
      schema = null;
    }
    if (!isObj(schema)) throw new TypeError(`mcp.registerTool(${name}): inputSchema must be a JSON Schema object`);
    schema.type ??= 'object';
    if (schema.type !== 'object') throw new TypeError(`mcp.registerTool(${name}): inputSchema.type must be "object"`);
    const fault = schemaFault(schema, 'inputSchema');
    if (fault) throw new TypeError(`mcp.registerTool(${name}): ${fault}`);
    const unchecked = [...uncheckedKeywords(schema)];
    if (unchecked.length) say('warn', 'mcp: the hub does not check these schema keywords', { tool: name, keywords: unchecked });
    if (schema.anyOf || schema.oneOf || schema.allOf) {
      say('warn', 'mcp: model APIs refuse anyOf, oneOf and allOf at the top of an input schema', { tool: name });
    }
    return deepFreeze(schema);
  }

  const allows = (tool, role) => tool.roles === null || tool.roles.has(role);

  /** The tools of a role, in registration order: [{ name, description, inputSchema }]. */
  function toolsFor(role) {
    const list = [];
    for (const tool of tools.values()) {
      if (allows(tool, role)) list.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    }
    return list;
  }

  /**
   * Set the function that gives the board tag of an agent: fn(agentId) -> '' | '[board: 2 new for you. Call read.]'.
   * A non-empty tag is added as the last line of every tool result. Pass null to remove it.
   */
  function setTagProvider(fn) {
    if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('mcp.setTagProvider needs a function');
    tagProvider = fn ?? null;
  }

  /**
   * Set the function that gives the urgent tag of an agent for the tool hook (GET /mcp/:token/tag):
   * fn(agentId) -> '' | tag (board.urgentTag). Pass null to remove it.
   */
  function setUrgentProvider(fn) {
    if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('mcp.setUrgentProvider needs a function');
    urgentProvider = fn ?? null;
  }

  /**
   * The urgent tag for the agent of a token, for the mail hook.
   * @returns {Promise<string|null>} null: unknown token. '': nothing urgent (also when the provider fails,
   *   gives no text, or takes longer than the call limit).
   */
  async function urgentFor(token) {
    const agentId = agentIdFor(token);
    const agent = agentId === null ? null : findAgent(agentId);
    if (!agent) return null;
    used(agentId);
    if (!urgentProvider) return '';
    try {
      const out = urgentProvider(agent.id, agent);
      const text = isThenable(out) ? await deadline(out) : out;
      return typeof text === 'string' ? text.trim() : '';
    } catch (err) {
      sayOften('warn', 'mcp: urgent tag provider failed', { agent: agent.id, error: err === TIMED_OUT ? 'timed out' : errorLine(err) });
      return '';
    }
  }

  // ---- tools/call ----

  function record(agentId, name, ok, ts) {
    if (!findAgent(agentId)) return; // the agent left the store while its call ran: its history ended there
    const ring = calls.get(agentId) ?? [];
    calls.delete(agentId);
    calls.set(agentId, ring); // most recently active agent last
    ring.push({ name, ok, ts });
    if (ring.length > CALL_RING) ring.splice(0, ring.length - CALL_RING);
    if (calls.size > MAX_TRACKED_AGENTS) calls.delete(calls.keys().next().value);
  }

  /**
   * The tool calls of an agent that started at or after `ts`, oldest first: [{ name, ok, ts }].
   * ok is false for a refused call, bad arguments, a handler error and an error result.
   * The last 200 calls per agent are kept.
   */
  function callsSince(agentId, ts = 0) {
    const since = Number(ts) || 0;
    // The ring is in the order in which the calls ended. A slow call that started first comes first here.
    return (calls.get(agentId) ?? []).filter((call) => call.ts >= since).map((call) => ({ ...call })).sort((a, b) => a.ts - b.ts);
  }

  function clip(text) {
    if (!(maxResultChars > 0) || text.length <= maxResultChars) return text;
    const last = text.charCodeAt(maxResultChars - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? maxResultChars - 1 : maxResultChars; // do not cut a character in two
    return `${text.slice(0, end)}\n[cut: ${text.length - end} more characters]`;
  }

  /** Handler output -> MCP tool result. A model API refuses an empty text block, so empty text gets a filler. */
  function toResult(tool, out) {
    let text;
    let isError = false;
    if (typeof out === 'string') {
      text = out;
    } else if (isObj(out) && typeof out.text === 'string') {
      text = out.text;
      isError = Boolean(out.isError);
    } else if (out === undefined || out === null) {
      text = 'ok';
    } else if (typeof out === 'function' || typeof out === 'symbol') {
      // The text form of a function is its source code. That is no tool result.
      sayOften('warn', 'mcp: a tool handler must return a string or { text, isError }', { tool: tool.name, got: typeof out });
      return textResult(`${tool.name} failed: internal error`, true);
    } else {
      sayOften('warn', 'mcp: a tool handler must return a string or { text, isError }', { tool: tool.name, got: kindOf(out) });
      try {
        text = JSON.stringify(out) ?? String(out);
      } catch {
        text = String(out);
      }
    }
    return textResult(text.trim() ? clip(text) : '(empty)', isError);
  }

  /** toResult for any handler output: a value that cannot be read (a getter that throws) gives an error result. */
  function settled(tool, agent, out) {
    try {
      return toResult(tool, out);
    } catch (err) {
      return crashed(tool, agent, err);
    }
  }

  /** The error result for a handler that threw, rejected or timed out. Never throws, whatever was thrown. */
  function crashed(tool, agent, err) {
    if (err === TIMED_OUT) {
      sayOften('warn', 'mcp: tool handler timed out', { agent: agent.id, tool: tool.name, ms: callLimitMs });
      return textResult(`${tool.name} timed out after ${Math.round(callLimitMs / 1000)} s. The hub can still finish it.`, true);
    }
    sayOften('error', 'mcp: tool handler failed', { agent: agent.id, tool: tool.name, error: errorStack(err) });
    return textResult(`${tool.name} failed: ${errorLine(err) || 'internal error'}`, true);
  }

  /** Reject with TIMED_OUT when the handler takes too long. The late outcome is dropped. */
  function deadline(promise) {
    const pending = Promise.resolve(promise);
    if (callLimitMs === 0) return pending;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(TIMED_OUT), callLimitMs);
      timer.unref?.();
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  function addTag(result, tag) {
    if (typeof tag === 'string' && tag.trim()) result.content[0].text += `\n${tag.trim()}`;
    return result;
  }

  /**
   * Add the board tag. The provider runs after the handler, so the tag counts what the call itself changed.
   * A provider that fails, or an async one that does not answer in time, costs only the tag.
   */
  function tagged(agent, result) {
    if (!tagProvider) return result;
    const failed = (err) => {
      sayOften('warn', 'mcp: tag provider failed', { agent: agent.id, error: err === TIMED_OUT ? 'timed out' : errorLine(err) });
      return result;
    };
    try {
      const tag = tagProvider(agent.id, agent);
      return isThenable(tag) ? deadline(tag).then((text) => addTag(result, text), failed) : addTag(result, tag);
    } catch (err) {
      return failed(err);
    }
  }

  function argumentError(tool, args) {
    const problems = validateArgs(tool.inputSchema, args, argCheckMs);
    if (problems.length === 0) return null;
    if (problems[0] === SLOW_CHECK) {
      slowChecks += 1;
      sayOften('warn', 'mcp: an argument check hit its time limit (a slow pattern in the input schema?)', { tool: tool.name, ms: argCheckMs });
    }
    return cut(`${tool.name}: bad arguments. ${problems.join('; ')}. Expected ${cut(shape(tool.inputSchema), 300)}.`, MAX_ERROR_CHARS);
  }

  /** -> MCP tool result, or { rpc: { code, message } } for a protocol error; a Promise when the handler is async. */
  function callTool(agent, params) {
    const started = now();
    const name = isObj(params) && typeof params.name === 'string' ? params.name : null;
    if (name === null) return { rpc: { code: E_PARAMS, message: 'Invalid params: tools/call needs params.name' } };
    const tool = tools.get(name);
    if (!tool || !allows(tool, agent.role)) {
      const shown = oneLine(name, 64);
      record(agent.id, shown, false, started);
      sayOften('warn', 'mcp: refused a call to a tool that this role does not have', { agent: agent.id, role: agent.role, tool: shown });
      const mine = toolsFor(agent.role).map((t) => t.name).join(', ') || 'none';
      return { rpc: { code: E_PARAMS, message: `Unknown tool: ${shown}. Your tools: ${mine}` } };
    }
    const done = (result) => {
      record(agent.id, tool.name, !result.isError, started);
      sayOften('debug', 'mcp: tool call', { agent: agent.id, tool: tool.name, ok: !result.isError, ms: now() - started });
      return tagged(agent, result);
    };
    let args = params.arguments ?? {};
    if (typeof args === 'string') args = jsonObject(args) ?? args; // a client that sends the arguments as JSON text
    const problem = argumentError(tool, args);
    if (problem) return done(textResult(problem, true));
    // From here on the handler has run. Whatever it throws or gives back, the call gets a tool result
    // and a record: the orchestrator must see every call that may have changed something.
    let out;
    let pending = false;
    try {
      out = tool.handler(agent, args);
      pending = isThenable(out);
    } catch (err) {
      return done(crashed(tool, agent, err));
    }
    if (!pending) return done(settled(tool, agent, out));
    return deadline(out).then(
      (value) => done(settled(tool, agent, value)),
      (err) => done(crashed(tool, agent, err)),
    );
  }

  // ---- JSON-RPC ----

  function initializeResult(agent, params) {
    const asked = isObj(params) ? params.protocolVersion : undefined;
    const client = isObj(params) && isObj(params.clientInfo) ? params.clientInfo : {};
    sayOften('debug', 'mcp: initialize', {
      agent: agent.id,
      client: oneLine(client.name ?? '?', 40),
      clientVersion: oneLine(client.version ?? '?', 40),
      protocolVersion: oneLine(asked ?? '?', 20),
    });
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: String(version) },
      ...(typeof instructions === 'string' && instructions.trim() ? { instructions } : {}),
    };
  }

  function listResult(agent) {
    return {
      tools: toolsFor(agent.role).map((tool) => (meta ? { ...tool, _meta: meta } : tool)),
    };
  }

  /** One message -> response | null; a Promise of the response when a tool handler is async. */
  function handleOne(agentId, msg) {
    if (!isObj(msg)) return rpcError(null, E_REQUEST, 'Invalid Request: a message must be a JSON object');
    const { id, method } = msg;
    if (method === undefined) {
      // An answer to a request of the hub. The hub sends no requests, so there is nothing to do.
      if (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error')) return null;
      return rpcError(isId(id) ? id : null, E_REQUEST, 'Invalid Request: method is missing');
    }
    const wantsAnswer = id !== undefined && id !== null;
    if (wantsAnswer && !isId(id)) return rpcError(null, E_REQUEST, 'Invalid Request: id must be a string or a number');
    if (msg.jsonrpc !== '2.0' || typeof method !== 'string') {
      return wantsAnswer ? rpcError(id, E_REQUEST, 'Invalid Request: jsonrpc must be "2.0" and method must be a string') : null;
    }
    // Notifications (notifications/initialized, notifications/cancelled, ...) need no action and get no answer.
    if (!wantsAnswer) return null;

    const agent = agentId === null ? null : findAgent(agentId);
    if (!agent) return rpcError(id, E_UNKNOWN_AGENT, 'unknown agent');

    switch (method) {
      case 'initialize':
        return rpcResult(id, initializeResult(agent, msg.params));
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, listResult(agent));
      case 'tools/call': {
        const finish = (out) => (out.rpc ? rpcError(id, out.rpc.code, out.rpc.message) : rpcResult(id, out));
        const out = callTool(agent, msg.params);
        return isThenable(out) ? out.then(finish) : finish(out);
      }
      // The hub has no resources and no prompts. Some clients ask anyway.
      case 'resources/list':
        return rpcResult(id, { resources: [] });
      case 'resources/templates/list':
        return rpcResult(id, { resourceTemplates: [] });
      case 'prompts/list':
        return rpcResult(id, { prompts: [] });
      default:
        // A notification that came with an id by mistake still gets an answer, so the client does not wait.
        if (method.startsWith('notifications/')) return rpcResult(id, {});
        return rpcError(id, E_METHOD, `Method not found: ${oneLine(method, 80)}`);
    }
  }

  /**
   * A batch runs in order: a later message sees what an earlier one did. After a message whose
   * argument check hit its time limit (it held the hub for that long), the event loop runs before
   * the next message. So one request cannot hold the hub for the time of 50 slow checks.
   */
  function handleBatch(agentId, list) {
    if (list.length === 0) return rpcError(null, E_REQUEST, 'Invalid Request: the batch is empty');
    if (list.length > MAX_BATCH) return rpcError(null, E_REQUEST, `Invalid Request: a batch holds at most ${MAX_BATCH} messages`);
    const answers = [];
    let next = 0;
    const run = () => {
      while (next < list.length) {
        const slowBefore = slowChecks;
        const answer = handleOne(agentId, list[next++]);
        if (isThenable(answer)) {
          return answer.then((value) => {
            if (value) answers.push(value);
            return run();
          });
        }
        if (answer) answers.push(answer);
        if (slowChecks !== slowBefore && next < list.length) {
          return new Promise((resolve) => {
            setImmediate(resolve);
          }).then(run);
        }
      }
      return answers.length > 0 ? answers : null;
    };
    return run();
  }

  /**
   * Answer one parsed JSON-RPC 2.0 message, or a batch (array) of them.
   * @param {string} token              the agent token from the URL
   * @param {object|object[]} message
   * @returns {object|object[]|null|Promise<object|object[]|null>} the response (an array for a batch), or
   *   null when nothing needs an answer (notifications). The value comes back at once when everything was
   *   synchronous, and as a Promise when a tool handler or the tag provider is async, or when a batch
   *   made a pause for the event loop after a slow argument check. So always `await` it.
   *   It never throws and never rejects. An unknown token gives error -32001 "unknown agent".
   */
  function handle(token, message) {
    const internalError = (err) => {
      sayOften('error', 'mcp: internal error', { error: errorStack(err) });
      return rpcError(isObj(message) && isId(message.id) ? message.id : null, E_INTERNAL, 'Internal error');
    };
    try {
      const agentId = agentIdFor(token);
      if (agentId !== null) used(agentId); // an agent that calls the hub keeps its token when the table is full
      const answer = Array.isArray(message) ? handleBatch(agentId, message) : handleOne(agentId, message);
      return isThenable(answer) ? answer.catch(internalError) : answer;
    } catch (err) {
      return internalError(err);
    }
  }

  return { tokenFor, revoke, agentFor, registerTool, setTagProvider, setUrgentProvider, urgentFor, toolsFor, handle, callsSince };
}

// ---- HTTP wiring ----------------------------------------------------------------------------------

/** The ids of the requests in a message or a batch, in order. */
function requestIds(body) {
  const ids = [];
  for (const msg of Array.isArray(body) ? body : [body]) {
    if (isObj(msg) && msg.method !== undefined && isId(msg.id)) ids.push(msg.id);
  }
  return ids;
}

/** The first request id in a message or a batch, for an error answer; null when there is none. */
const firstId = (body) => requestIds(body)[0] ?? null;

/**
 * One error for a whole message: the error object when the message is one request (or holds none),
 * and one error per request, as a list, when it is a batch. So every request gets an answer with its id.
 */
function errorForAll(body, code, message) {
  const ids = requestIds(body);
  if (!Array.isArray(body) || ids.length === 0 || ids.length > MAX_BATCH) return rpcError(ids[0] ?? null, code, message);
  return ids.map((id) => rpcError(id, code, message));
}

function setHeader(ctx, name, value) {
  try {
    if (ctx.res && !ctx.res.headersSent) ctx.res.setHeader(name, value);
  } catch { /* the answer still goes out */ }
}

/** The agent token of a request: the one in the URL, else a known one in "Authorization: Bearer <token>"; else null. */
function tokenOf(ctx, mcp) {
  const inPath = typeof ctx.params?.token === 'string' ? ctx.params.token : '';
  if (mcp.agentFor(inPath)) return inPath;
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(String(ctx.req?.headers?.authorization ?? ''))?.[1];
  return bearer !== undefined && mcp.agentFor(bearer) ? bearer : null;
}

/**
 * Put the MCP endpoint on the hub's HTTP router (section 14b): POST /mcp/:token.
 *
 * Streamable HTTP as the agent CLIs use it, without sessions and without event streams:
 *   POST with a request (or a batch)   -> 200 application/json, the JSON-RPC answer
 *   POST with only notifications       -> 202, empty body
 *   POST with an unknown token         -> 404 with JSON-RPC error -32001 (not 401: that starts an OAuth search);
 *                                         a batch gets one such error per request, as a list
 *   POST with a body that is no JSON-RPC message -> 400 with a JSON-RPC error
 *   GET (a client asks for an event stream) -> 405, Allow: POST
 * No Mcp-Session-Id is issued, so clients send none and never need DELETE. The Accept and
 * MCP-Protocol-Version request headers are not checked: the answer is always JSON, and the
 * `server/discover` probe of Claude Code carries a protocol version of the future but must get a
 * JSON-RPC "method not found" and not an HTTP error.
 *
 * The token is the last part of the URL. When that part is not a known token, a known token in the header
 * `Authorization: Bearer <token>` is taken. providers/claude.js sends both and writes the URL with
 * ${WORKSHOP_TOKEN}; the header covers a CLI that does not expand a variable inside a URL.
 *
 * The router's guards stay in force, all of them (contract sections 6 and 14c). Host and Origin checks need
 * nothing from a CLI. The rule "X-WorkShop: 1 on every request that is not a GET" does: the stdio shim sends
 * that header, and a CLI that connects over HTTP gets it through the `headers` of its MCP config
 * (providers/claude.js). No route of this module asks the router to drop a guard.
 *
 * @param {object} http   createHttp() router: http.route(method, pattern, handler)
 * @param {object} mcp    createMcp() endpoint
 * @param {{ log?: Function }} [opts]
 */
export function mountMcp(http, mcp, { log = noop } = {}) {
  if (!http || typeof http.route !== 'function') throw new TypeError('mountMcp needs the http router');
  if (!mcp || typeof mcp.handle !== 'function') throw new TypeError('mountMcp needs the mcp endpoint');
  const pattern = '/mcp/:token';
  let lastUnknownLog = 0;
  const say = (level, msg, data) => {
    try {
      log(level, msg, data);
    } catch { /* keep answering */ }
  };

  http.route('POST', pattern, async (ctx) => {
    setHeader(ctx, 'Cache-Control', 'no-store');
    const token = tokenOf(ctx, mcp);
    let body = ctx.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = undefined;
      }
    }
    if (token === null) {
      const t = Date.now();
      if (t - lastUnknownLog >= 10_000) {
        lastUnknownLog = t;
        say('warn', 'mcp: a request came with a token that the hub does not know (an agent from before a restart?)');
      }
      ctx.json(404, errorForAll(body, E_UNKNOWN_AGENT, 'unknown agent'));
      return;
    }
    if (body === undefined || body === null || typeof body !== 'object') {
      ctx.json(400, rpcError(null, E_PARSE, 'Parse error: send one JSON-RPC message or a batch as JSON'));
      return;
    }
    let answer;
    try {
      answer = await mcp.handle(token, body);
    } catch (err) {
      say('error', 'mcp: handle failed', { error: errorStack(err) });
      answer = errorForAll(body, E_INTERNAL, 'Internal error');
    }
    if (answer === null || answer === undefined) {
      ctx.text(202, '');
      return;
    }
    const malformed = !Array.isArray(answer) && answer.id === null && answer.error?.code === E_REQUEST;
    ctx.json(malformed ? 400 : 200, answer);
  });

  http.route('GET', pattern, (ctx) => {
    setHeader(ctx, 'Allow', 'POST');
    ctx.json(405, { error: 'Use POST. This endpoint has no event stream.' });
  });

  // The mail check of the tool hook (section 10): `curl -s -m 2 "$WORKSHOP_TAG_URL"` after each tool call.
  // Known token, something urgent: 200 with the hook JSON. Known token, nothing urgent: 204. Else 404.
  // Every answer but the 200 has an empty body, so the hook adds nothing to the agent's context.
  http.route('GET', `${pattern}/tag`, async (ctx) => {
    setHeader(ctx, 'Cache-Control', 'no-store');
    const token = typeof ctx.params?.token === 'string' ? ctx.params.token : '';
    let text = null;
    if (typeof mcp.urgentFor === 'function') {
      try {
        text = await mcp.urgentFor(token);
      } catch (err) {
        say('error', 'mcp: the urgent tag failed', { error: errorStack(err) });
        text = '';
      }
    }
    if (text === null) {
      emptyAnswer(ctx, 404);
      return;
    }
    if (!text) {
      emptyAnswer(ctx, 204);
      return;
    }
    ctx.json(200, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
  });
}

/** An answer with no body (204, or the 404 of the mail check). */
function emptyAnswer(ctx, status) {
  const res = ctx.res;
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  ctx.text(status, '');
}
