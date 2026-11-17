#!/usr/bin/env node
// mock-anthropic.mjs - zero-dependency "puppet" mock of the Anthropic Messages API.
// Purpose: drive the REAL Claude Code CLI offline (no login, no spend) so its client-side
// behaviour (flags, permissions, MCP, sessions, stream-json) can be observed exactly.
//
// Usage:  node mock-anthropic.mjs <logDir> [port]
//   - listens on 127.0.0.1:<port> (0 = pick a free port); writes the port to <logDir>/port
//   - logs every request to <logDir>/requests.jsonl; saves each /v1/messages body to <logDir>/req-<n>.json
//
// Puppet protocol: the "model" does what the prompt tells it. Put this marker anywhere in a user prompt:
//     <<<MOCK {"steps":[ STEP, STEP, ... ]} MOCK>>>
//   STEP = {"text":"...", "tools":[{"name":"Write","input":{...}}], "delay_ms":0, "chunk_delay_ms":0,
//           "http_error":{"status":529,"type":"overloaded_error","message":"...","times":1,"headers":{}}, "headers":{...extra response headers}}
//   Step N answers the Nth model request after the user message that holds the (latest) marker.
//   No marker, or steps exhausted -> plain text reply ("ok" / "done").
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const logDir = process.argv[2] || "./mock-log";
const wantPort = Number(process.argv[3] || 0);
fs.mkdirSync(logDir, { recursive: true });
const reqLog = path.join(logDir, "requests.jsonl");
let seq = 0; // continue numbering after a restart so saved request files are never overwritten
try { for (const l of fs.readFileSync(reqLog, "utf8").split("\n")) { if (!l) continue; const j = JSON.parse(l); if (j.method && j.n > seq) seq = j.n; } } catch {}
const errorCounts = new Map(); // http_error counters per script step
const cacheSeen = new Set(); // sha256 of cacheable prefixes (prompt-cache emulation)
const est = (s) => Math.ceil(Buffer.byteLength(typeof s === "string" ? s : JSON.stringify(s ?? "")) / 4); // ~chars/4

function redactHeaders(h) {
  const o = {};
  for (const [k, v] of Object.entries(h)) {
    o[k] = /^(x-api-key|authorization|cookie|proxy-authorization)$/i.test(k) ? `<redacted len=${String(v).length} prefix=${String(v).slice(0, 11)}>` : v;
  }
  return o;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}

function findScript(messages) {
  // latest marker wins; step index = number of assistant messages after that user message
  let found = null;
  (messages || []).forEach((m, i) => {
    if (m.role !== "user") return;
    const t = textOf(m.content);
    const a = t.indexOf("<<<MOCK ");      // outermost marker in this message (scripts may nest a sub-agent script inside a prompt string)
    if (a < 0) return;
    const b = t.lastIndexOf(" MOCK>>>");
    if (b < a) return;
    try { found = { script: JSON.parse(t.slice(a + 8, b)), at: i }; } catch (e) { found = { script: { steps: [{ text: "MOCK-SCRIPT-PARSE-ERROR " + e.message }] }, at: i }; }
  });
  if (!found) return null;
  const step = (messages || []).slice(found.at + 1).filter((m) => m.role === "assistant").length;
  return { ...found, step };
}

function usageFor(body) {
  // Prompt-cache emulation: order is tools -> system -> messages; a block with cache_control ends a cacheable prefix.
  const h = crypto.createHash("sha256");
  let cum = 0; const marks = [];
  const feed = (obj) => { const s = JSON.stringify(obj); h.update(s); cum += est(s); if (obj && obj.cache_control) marks.push({ hash: h.copy().digest("hex"), tokens: cum }); };
  h.update(String(body.model));
  for (const t of body.tools || []) feed(t);
  const sys = typeof body.system === "string" ? [{ type: "text", text: body.system }] : body.system || [];
  for (const s of sys) feed(s);
  for (const m of body.messages || []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    for (const b of blocks) feed({ role: m.role, ...b });
  }
  let read = 0;
  for (const mk of marks) if (cacheSeen.has(mk.hash)) read = Math.max(read, mk.tokens);
  const lastMark = marks.length ? marks[marks.length - 1].tokens : 0;
  const creation = Math.max(0, lastMark - read);
  for (const mk of marks) cacheSeen.add(mk.hash);
  return { input_tokens: Math.max(1, cum - lastMark), cache_creation_input_tokens: creation, cache_read_input_tokens: read,
    cache_creation: { ephemeral_5m_input_tokens: creation, ephemeral_1h_input_tokens: 0 }, service_tier: "standard" };
}

function buildContent(body) {
  const f = findScript(body.messages);
  const toolNames = new Set((body.tools || []).map((t) => t.name));
  let step = null, why = "no-marker";
  if (f) {
    step = (f.script.steps || [])[f.step] || null;
    why = step ? `script step ${f.step}` : `script exhausted at step ${f.step}`;
  }
  const content = [];
  if (!step) content.push({ type: "text", text: f ? "done" : "ok" });
  else {
    if (step.text) content.push({ type: "text", text: step.text });
    for (const t of step.tools || []) {
      if (!step.force && !toolNames.has(t.name)) { content.push({ type: "text", text: `[mock: tool ${t.name} is not in this request's tools list]` }); why += ` (tool ${t.name} missing)`; continue; }
      content.push({ type: "tool_use", id: "toolu_mock_" + crypto.randomBytes(6).toString("hex"), name: t.name, input: t.input || {} });
    }
    if (!content.length) content.push({ type: "text", text: "ok" });
  }
  const stop_reason = content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn";
  return { content, stop_reason, why, delay_ms: step?.delay_ms || 0, chunk_delay_ms: step?.chunk_delay_ms || 0, step, key: f ? JSON.stringify(f.script).length + ":" + f.step : "" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleMessages(req, res, body, n) {
  const usage = usageFor(body);
  const { content, stop_reason, why, delay_ms, chunk_delay_ms, step, key } = buildContent(body);
  // step.http_error = {status, type, message, times, headers}: answer with an API error "times" times (default: always) before the normal reply
  if (step?.http_error) {
    const he = step.http_error; const used = errorCounts.get(key) || 0;
    if (he.times === undefined || used < he.times) {
      errorCounts.set(key, used + 1);
      fs.appendFileSync(reqLog, JSON.stringify({ n, decision: why + ` -> http_error ${he.status} (#${used + 1})` }) + "\n");
      res.writeHead(he.status, { "content-type": "application/json", "request-id": "req_mock_" + n, ...(he.headers || {}) });
      return res.end(JSON.stringify({ type: "error", error: { type: he.type || "api_error", message: he.message || "mock error" }, request_id: "req_mock_" + n }));
    }
  }
  const extraHeaders = step?.headers || {};
  const out_tokens = Math.max(1, est(content));
  const id = "msg_mock_" + String(n).padStart(4, "0");
  fs.appendFileSync(reqLog, JSON.stringify({ n, decision: why, stop_reason, reply: content.map((c) => c.type === "text" ? { text: c.text.slice(0, 80) } : { tool_use: c.name }) }) + "\n");
  if (delay_ms) await sleep(delay_ms);
  if (res.destroyed) return;
  const base = { id, type: "message", role: "assistant", model: body.model, stop_sequence: null };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json", "request-id": "req_mock_" + n, ...extraHeaders });
    res.end(JSON.stringify({ ...base, content, stop_reason, usage: { ...usage, output_tokens: out_tokens } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "request-id": "req_mock_" + n, ...extraHeaders });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { ...base, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c.type === "text") {
      send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      const parts = chunk_delay_ms ? c.text.match(/.{1,12}/gs) || [""] : [c.text];
      for (const p of parts) { send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: p } }); if (chunk_delay_ms) await sleep(chunk_delay_ms); if (res.destroyed) return; }
    } else {
      send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } });
    }
    send("content_block_stop", { type: "content_block_stop", index: i });
  }
  send("message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: out_tokens } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const n = ++seq;
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://x");
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
    const entry = { n, t: new Date().toISOString(), method: req.method, path: url.pathname, query: url.search, headers: redactHeaders(req.headers), bodyBytes: raw.length };
    if (body && url.pathname === "/v1/messages") {
      fs.writeFileSync(path.join(logDir, `req-${String(n).padStart(4, "0")}.json`), raw);
      const sys = typeof body.system === "string" ? [{ type: "text", text: body.system }] : body.system || [];
      entry.summary = {
        model: body.model, stream: !!body.stream, max_tokens: body.max_tokens, thinking: body.thinking, output_config: body.output_config,
        tool_choice: body.tool_choice, tools: (body.tools || []).length, toolBytes: JSON.stringify(body.tools || []).length,
        systemBlocks: sys.length, systemBytes: sys.reduce((a, s) => a + (s.text || "").length, 0), messages: (body.messages || []).length,
        messagesBytes: JSON.stringify(body.messages || []).length, otherKeys: Object.keys(body).filter((k) => !["model", "stream", "max_tokens", "thinking", "tools", "system", "messages", "tool_choice", "output_config", "metadata"].includes(k)),
      };
    }
    fs.appendFileSync(reqLog, JSON.stringify(entry) + "\n");
    try {
      if (req.method === "POST" && url.pathname === "/v1/messages" && body) return await handleMessages(req, res, body, n);
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens" && body) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: est(body) })); }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock-anthropic: no such endpoint " + url.pathname } }));
    } catch (e) {
      try { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(e) } })); } catch {}
    }
  });
});
server.listen(wantPort, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(logDir, "port"), String(port));
  console.log("mock-anthropic listening on http://127.0.0.1:" + port + " log=" + logDir);
});
