#!/usr/bin/env node
// WorkShop MCP stdio shim: the "shop" MCP server that an agent CLI starts as a child process.
// It sends each JSON-RPC message from stdin to the hub with an HTTP POST and prints the hub's answer.
//
//   node mcp-stdio-shim.mjs --url-file <path>        the form the adapters use (contract sections 8 and 10)
//   node mcp-stdio-shim.mjs http://127.0.0.1:<port>/mcp/<token>                      (tests only)
//   WORKSHOP_MCP_URL=http://127.0.0.1:<port>/mcp/<token> node mcp-stdio-shim.mjs     (tests only)
//
// --url-file: the file (mode 0600, outside the bench) holds the hub URL with the token. The shim reads it once
// at start. The file path is the only thing on the command line, and the environment is not read for the URL.
// A missing, empty or unreadable file: a usage note on stderr and exit code 2.
//
// Rules of the MCP stdio transport: one JSON object per line, stdout carries protocol lines only,
// notes go to stderr. This file imports nothing from WorkShop, so it runs with any working directory.
//
// Behavior:
// - Messages go to the hub one at a time, in the order they arrived, as the bytes that came in.
// - Every request gets exactly one answer, and that answer has the id of the request: the hub's answer,
//   or a JSON-RPC error when the hub gave none (also for each request of a batch).
// - Hub not reachable: retry with a short backoff (100 ms, 200 ms, 400 ms ... for WORKSHOP_MCP_RETRY_MS,
//   default 3 s), then answer the request with a JSON-RPC error. The next message tries the hub again.
// - A tools/call is repeated only when the connection was never made. So the hub never runs one call twice.
// - Every message uses a new connection ("Connection: close"). A kept connection can be dead without
//   the shim knowing it (the hub stopped a moment ago). A tools/call that went into such a connection
//   could not be repeated, and the agent would get "the call may or may not be done" for a call that
//   never reached the hub. On a new connection, a hub that is gone always shows as "connection refused".
// - The agent token (the last part of the URL) stays with the shim: the process title replaces the
//   command line that `ps` shows, no note on stderr holds a part of the URL, and a URL with a user
//   name or password is refused (fetch would print it in its error).
// - Exit code 0 when stdin closes (after the answers that are on the way) and on SIGINT, SIGTERM, SIGHUP.

import fs from 'node:fs';

const RETRY_MS = envNumber('WORKSHOP_MCP_RETRY_MS', 3000); // how long one message keeps trying to reach the hub
const TIMEOUT_MS = envNumber('WORKSHOP_MCP_TIMEOUT_MS', 110_000); // wait for one hub answer (the hub limits a tool call to 90 s); 0 = no limit
const DRAIN_MS = 10_000; // after stdin closes: time for answers that are still on the way
const MAX_LINE_BYTES = 8 * 1024 * 1024; // the hub takes 2 MB; a longer line is refused here
const MAX_WAITING = 256; // lines that wait for the hub; above this, stdin pauses
// The hub gave no usable answer. Not -32000 or -32001: the MCP client library reads those as
// "connection closed" and "request timed out" of this shim itself.
const HUB_ERROR = -32603;
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  'x-workshop': '1', // the hub wants this header on every request that is not a GET
  'user-agent': 'workshop-mcp-shim/1',
  connection: 'close', // never keep a connection: see "Behavior" above
};
const NO_ANSWER = 'The WorkShop hub sent no answer.';
// Error codes that prove the request never reached the hub.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT']);
const BAD_PORT = 'BAD_PORT'; // our own code for a port that fetch refuses to call
const TOO_LONG = Symbol('line too long');
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const listOf = (message) => (Array.isArray(message) ? message : [message]);
const isRequest = (m) => isObject(m) && m.method !== undefined && (typeof m.id === 'string' || typeof m.id === 'number');
const isNotification = (m) => isObject(m) && typeof m.method === 'string' && (m.id === undefined || m.id === null);
const isAnswer = (m) => isObject(m) && m.jsonrpc === '2.0' && ('result' in m || isObject(m.error));
const isRpcAnswer = (v) => (Array.isArray(v) ? v.length > 0 && v.every(isAnswer) : isAnswer(v));
const requestIds = (message) => listOf(message).filter(isRequest).map((m) => m.id);
const hasToolCall = (message) => listOf(message).some((m) => isObject(m) && m.method === 'tools/call');
const isClientAnswer = (m) => isObject(m) && m.method === undefined && ('result' in m || 'error' in m);
/** Only notifications and answers of the client: whatever the hub says, nothing may be printed. */
const isSilent = (message) => listOf(message).length > 0 && listOf(message).every((m) => isNotification(m) || isClientAnswer(m));
const rpcError = (id, code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });

let targetProblem = ''; // why there is no target: the usage note says it
const target = readTarget();
const secrets = target ? secretsOf(target) : []; // texts that no note on stderr may hold
if (target) hideCommandLine();
const waiting = []; // complete lines (or TOO_LONG) that wait for the hub
let parts = []; // pieces of the line that is not complete yet
let partBytes = 0;
let skipping = false; // inside a line that is too long
let paused = false;
let pumping = false;
let ended = false;
let hubDown = false;
let lastBadStatus = 0;

if (target && typeof fetch !== 'function') {
  note('this Node.js has no fetch: run the shim with Node 20 or newer');
  process.exitCode = 2;
} else if (target) {
  process.stdout.on('error', () => process.exit(0)); // the CLI closed its end
  process.stderr.on('error', () => {});
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
  process.on('uncaughtException', (err) => {
    note(`stopped: ${err?.message ?? err}`);
    process.exit(1);
  });
  process.stdin.on('data', onData);
  process.stdin.on('end', onEnd);
  process.stdin.on('error', onEnd);
} else {
  note(targetProblem || 'usage: node mcp-stdio-shim.mjs --url-file <path>   (tests: <hub url>, or set WORKSHOP_MCP_URL)');
  process.exitCode = 2;
}

// ---- stdin: bytes -> lines ----------------------------------------------------------------------

function onData(chunk) {
  let start = 0;
  while (start < chunk.length) {
    const end = chunk.indexOf(0x0a, start);
    if (end === -1) {
      keep(chunk.subarray(start));
      break;
    }
    keep(chunk.subarray(start, end));
    endLine();
    start = end + 1;
  }
  if (!paused && waiting.length >= MAX_WAITING) {
    paused = true;
    process.stdin.pause();
  }
  pump();
}

function keep(piece) {
  if (skipping || piece.length === 0) return;
  partBytes += piece.length;
  if (partBytes > MAX_LINE_BYTES) {
    skipping = true;
    parts = [];
    return;
  }
  parts.push(piece);
}

function endLine() {
  if (skipping) waiting.push(TOO_LONG);
  else if (partBytes > 0) waiting.push(Buffer.concat(parts, partBytes).toString('utf8'));
  parts = [];
  partBytes = 0;
  skipping = false;
}

function onEnd() {
  if (ended) return;
  ended = true;
  endLine(); // a last line without a line break still counts
  setTimeout(() => process.exit(0), DRAIN_MS).unref();
  pump();
}

// ---- one message at a time -------------------------------------------------------------------------

async function pump() {
  if (pumping) return;
  pumping = true;
  while (waiting.length > 0) {
    const line = waiting.shift();
    if (paused && waiting.length < MAX_WAITING / 2) {
      paused = false;
      process.stdin.resume();
    }
    try {
      await relay(line);
    } catch (err) {
      note(`internal error: ${err?.message ?? err}`);
    }
  }
  pumping = false;
  if (ended) process.exit(0); // every answer is out: send() waits for stdout
}

async function relay(line) {
  if (line === TOO_LONG) {
    await send(rpcError(null, -32600, 'Invalid Request: the message is too large'));
    return;
  }
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    await send(rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (message === null || typeof message !== 'object') {
    await send(rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const answer = await forward(message, text);
  if (answer !== null) await send(answer);
}

/**
 * Send one message (or batch) to the hub, as the text that came in: the hub parses it itself, and a
 * second serialization here could fail (a message that is nested very deep) and would cost time.
 * Returns the JSON-RPC answer to print, or null. Never throws.
 */
async function forward(message, text) {
  const ids = requestIds(message);
  let reply;
  try {
    reply = await post(text, !hasToolCall(message));
  } catch (err) {
    const code = codeOf(err);
    if (!hubDown) note(`hub not reachable at ${target.origin} (${code || err?.cause?.message || err?.message || 'error'})`);
    hubDown = true;
    return failure(message, ids, describe(err, code));
  }
  if (hubDown) note('hub is back');
  hubDown = false;

  const ok = reply.status >= 200 && reply.status < 300;
  if (!ok && reply.status !== lastBadStatus) note(`hub answered HTTP ${reply.status}`);
  lastBadStatus = ok ? 0 : reply.status;

  const body = reply.text.trim();
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    parsed = undefined;
  }
  if (isRpcAnswer(parsed)) {
    if (ids.length > 0) return byId(message, ids, parsed);
    return isSilent(message) ? null : parsed; // an error for a message that holds no request
  }
  if (ok && ids.length === 0) return null; // 202: the hub took a notification
  const detail = typeof parsed?.error === 'string' ? `: ${parsed.error.slice(0, 200)}` : '';
  return failure(message, ids, ok ? NO_ANSWER : `The WorkShop hub answered HTTP ${reply.status}${detail}`);
}

/**
 * The hub's answer, made complete: every request of the message gets one answer with its own id.
 * The hub can tie an error to no request (id null), or give one error for a whole batch (an unknown
 * token, a batch that is too large). A client matches answers by id, so it would wait for ever.
 */
function byId(message, ids, parsed) {
  if (!Array.isArray(message)) {
    const answers = listOf(parsed);
    const own = answers.find((answer) => answer.id === ids[0]) ?? (answers.length === 1 ? answers[0] : null);
    return own ? { ...own, id: ids[0] } : rpcError(ids[0], HUB_ERROR, NO_ANSWER);
  }
  if (!Array.isArray(parsed)) {
    return ids.map((id) => (isObject(parsed.error) ? { jsonrpc: '2.0', id, error: parsed.error } : rpcError(id, HUB_ERROR, NO_ANSWER)));
  }
  const open = [...parsed];
  const missing = [];
  for (const id of ids) {
    const at = open.findIndex((answer) => answer.id === id);
    if (at >= 0) open.splice(at, 1);
    else missing.push(rpcError(id, HUB_ERROR, NO_ANSWER));
  }
  return missing.length > 0 ? [...parsed, ...missing] : parsed;
}

async function post(body, repeatable) {
  const giveUpAt = Date.now() + RETRY_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: HEADERS,
        body,
        redirect: 'error',
        signal: TIMEOUT_MS > 0 ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      const left = giveUpAt - Date.now();
      const code = codeOf(err);
      const retry = err?.name !== 'TimeoutError' && code !== BAD_PORT && (repeatable || NOT_SENT.has(code));
      if (!retry || left <= 0) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000, left))); // the last try is at the deadline
    }
  }
}

// ---- helpers -----------------------------------------------------------------------------------------

/**
 * The hub URL. With --url-file <path> (or --url-file=<path>) it comes from that file only; the
 * environment is not read. Else from the first argument, else from WORKSHOP_MCP_URL (tests).
 */
function urlText() {
  const args = process.argv.slice(2);
  const at = args.findIndex((a) => a === '--url-file' || a.startsWith('--url-file='));
  if (at < 0) return args[0] || process.env.WORKSHOP_MCP_URL || '';
  const file = args[at].startsWith('--url-file=') ? args[at].slice('--url-file='.length) : args[at + 1];
  const usage = 'usage: node mcp-stdio-shim.mjs --url-file <path>';
  if (!file) {
    targetProblem = `${usage} (no path given)`;
    return '';
  }
  let text;
  try {
    // A real URL is short. A large file is not a URL file: read only its start.
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    targetProblem = `${usage} (the URL file cannot be read: ${err?.code || 'error'})`;
    return '';
  }
  const url = text.trim().split(/\r?\n/)[0].trim();
  if (!url) targetProblem = `${usage} (the URL file is empty)`;
  return url;
}

function readTarget() {
  try {
    const url = new URL(urlText());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null; // fetch refuses such a URL and prints all of it in its error
    return url;
  } catch {
    return null;
  }
}

/** The parts of the hub URL that are secret (the token is the last part of the path), longest first. */
function secretsOf(url) {
  const found = [url.href, `${url.pathname}${url.search}`, url.search.slice(1)];
  for (const part of url.pathname.split('/')) {
    found.push(part);
    try {
      found.push(decodeURIComponent(part));
    } catch { /* not percent-encoded text */ }
  }
  for (const value of url.searchParams.values()) found.push(value);
  return [...new Set(found)].filter((text) => text.length >= 8).sort((a, b) => b.length - a.length);
}

/**
 * `ps` shows the command line of every process to every process of the same user, so also to
 * the other agents. Setting the process title overwrites that memory (the title is all that stays).
 */
function hideCommandLine() {
  try {
    process.title = 'workshop-mcp-shim';
  } catch { /* the shim works without it */ }
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function codeOf(err) {
  if (err?.cause?.message === 'bad port') return BAD_PORT; // fetch refuses some ports (6000, 6665 to 6669, 10080, ...) before it connects
  return err?.cause?.code ?? err?.cause?.errors?.[0]?.code ?? err?.code ?? '';
}

function describe(err, code) {
  if (err?.name === 'TimeoutError') {
    return `The WorkShop hub did not answer in ${Math.round(TIMEOUT_MS / 1000)} s. The call may still be done. Check before you repeat it.`;
  }
  if (NOT_SENT.has(code)) return 'The WorkShop hub is not reachable. The call was not done. Try again in a moment.';
  if (code === BAD_PORT) return 'The WorkShop hub uses a port that this program may not call. The call was not done. Tell the owner.';
  return 'The connection to the WorkShop hub broke. The call may or may not be done. Check before you repeat it.';
}

/** The answer for a message that got no usable answer from the hub: one error per request id. */
function failure(message, ids, text) {
  if (ids.length === 0) return null;
  const errors = ids.map((id) => rpcError(id, HUB_ERROR, text));
  return Array.isArray(message) ? errors : errors[0];
}

/** Print one protocol line. Resolves when stdout took it. */
function send(message) {
  // Raw U+2028 and U+2029 are legal in JSON, but some line readers break lines on them: print them escaped.
  const line = JSON.stringify(message).replace(LINE_SEPARATORS, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, () => resolve());
  });
}

/** Write a note to stderr (the CLI keeps it in a log file). It never holds a part of the hub URL. */
function note(text) {
  try {
    let line = String(text);
    for (const secret of secrets) line = line.split(secret).join('***');
    process.stderr.write(`[shop-mcp] ${line}\n`);
  } catch { /* stderr is gone: stay quiet */ }
}
