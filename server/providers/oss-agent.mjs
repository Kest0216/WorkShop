#!/usr/bin/env node
// Open-Source Specialist & Team Lead runner:
// Spawned per turn by server/providers/oss.js. Reads turn parameters from <runDir>/oss-turn.json
// and emits NormEvent JSON lines to stdout. Supports:
//   1. Phase 0 Stand-in mode (standin): local dry-run exercising Harness + MCP ShopTalk without GPU weights
//   2. Custom Harness Command mode (harness.runner.kind === 'command')
//   3. OpenAI-compatible Chat Completions tool loop (Ollama / vLLM / SGLang / llama.cpp)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const emit = (ev) => { process.stdout.write(`${JSON.stringify(ev)}\n`); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

let aborted = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { aborted = true; });
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Strict bench confinement: resolve `rel` inside `cwd` without symlink or parent escapes. */
export function resolveBenchPath(cwd, rel, { write = false } = {}) {
  const root = fs.realpathSync(path.resolve(cwd));
  const raw = String(rel ?? '').trim();
  if (!raw) throw new Error('Path must be non-empty.');
  if (raw.includes('\0')) throw new Error('Path holds NUL byte.');
  if (path.isAbsolute(raw)) throw new Error('Only paths relative to the bench are allowed.');
  const candidate = path.resolve(root, raw);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes the bench: ${raw}`);
  }
  const relNorm = path.relative(root, candidate).split(path.sep).join('/');
  if (write && (relNorm === '.shop' || relNorm.startsWith('.shop/') || relNorm === '.agents' || relNorm.startsWith('.agents/') || relNorm === '.git' || relNorm.startsWith('.git/'))) {
    throw new Error(`Refusing to modify hub-owned path: ${relNorm}`);
  }
  // Check existing ancestors for symlinks.
  let probe = root;
  const parts = relNorm ? relNorm.split('/') : [];
  for (const part of parts) {
    probe = path.join(probe, part);
    try {
      const st = fs.lstatSync(probe);
      if (st.isSymbolicLink()) {
        const real = fs.realpathSync(probe);
        if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
          throw new Error(`Symlink escapes bench: ${raw}`);
        }
      }
    } catch (err) {
      if (err?.code === 'ENOENT') break;
      throw err;
    }
  }
  return { abs: candidate, rel: relNorm || '.' };
}

function mcpRpc(mcp, method, params) {
  if (!mcp?.url || !mcp?.token) return Promise.resolve(null);
  const full = `${String(mcp.url).replace(/\/+$/, '')}/${mcp.token}`;
  const url = new URL(full);
  const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-WorkShop': '1',
        Authorization: `Bearer ${mcp.token}`,
        Connection: 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) reject(new Error(parsed.error.message || 'MCP error'));
          else resolve(parsed.result ?? null);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('MCP timeout')); });
    req.end(body);
  });
}

function runShellCommand(cmd, cwd, timeoutMs = 60_000) {
  const denied = /\b(sudo|git\s+(push|commit|merge|rebase|reset|checkout))\b/i;
  if (denied.test(cmd)) {
    return Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'Refused: restricted history-mutating or privileged command.' });
  }
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', cmd], { cwd, timeout: timeoutMs, maxBuffer: 512 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, code: typeof err.code === 'number' ? err.code : 1, stdout: String(stdout ?? '').slice(0, 8000), stderr: String(stderr ?? err.message ?? '').slice(0, 4000) });
      } else {
        resolve({ ok: true, code: 0, stdout: String(stdout ?? '').slice(0, 8000), stderr: String(stderr ?? '').slice(0, 4000) });
      }
    });
  });
}

async function execLocalTool(name, args, { cwd, canWrite, allowedTools, mcpTools, mcp }) {
  if (name.startsWith('shop__')) {
    if (!allowedTools.has('shop_mcp')) return { ok: false, output: 'Harness disables shop_mcp tool access.' };
    const toolName = name.slice('shop__'.length);
    if (!mcpTools.has(toolName)) return { ok: false, output: `Unknown shop tool: ${toolName}` };
    const res = await mcpRpc(mcp, 'tools/call', { name: toolName, arguments: isObj(args) ? args : {} });
    const txt = res?.content?.[0]?.text ?? JSON.stringify(res ?? {});
    return { ok: true, output: String(txt) };
  }
  if (!allowedTools.has(name)) return { ok: false, output: `Harness "${name}" is not enabled on this rig.` };

  if (name === 'read_file') {
    const { abs } = resolveBenchPath(cwd, args?.path, { write: false });
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    const start = Number.isInteger(args?.startLine) && args.startLine >= 1 ? args.startLine - 1 : 0;
    const end = Number.isInteger(args?.endLine) && args.endLine >= start + 1 ? args.endLine : Math.min(lines.length, start + 300);
    return { ok: true, output: lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n').slice(0, 16_000) };
  }
  if (name === 'list_dir') {
    const { abs } = resolveBenchPath(cwd, args?.path || '.', { write: false });
    const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200).map((d) => `${d.isDirectory() ? 'dir ' : 'file'} ${d.name}`);
    return { ok: true, output: entries.join('\n') || '(empty)' };
  }
  if (name === 'search_text') {
    const query = String(args?.query ?? '').trim();
    if (!query) throw new Error('query is required.');
    const { abs } = resolveBenchPath(cwd, args?.path || '.', { write: false });
    const hits = [];
    const walk = (dir) => {
      if (hits.length >= 40) return;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name === '.git' || d.name === 'node_modules') continue;
        const next = path.join(dir, d.name);
        if (d.isDirectory()) walk(next);
        else if (d.isFile()) {
          try {
            const text = fs.readFileSync(next, 'utf8');
            const lines = text.split('\n');
            lines.forEach((line, idx) => {
              if (hits.length < 40 && line.includes(query)) {
                hits.push(`${path.relative(cwd, next)}:${idx + 1}: ${line.trim().slice(0, 140)}`);
              }
            });
          } catch { /* ignore binary/unreadable */ }
        }
      }
    };
    walk(abs);
    return { ok: true, output: hits.join('\n') || 'No matches.' };
  }
  if (name === 'write_file') {
    if (!canWrite) return { ok: false, output: 'Harness or turn access is read-only.' };
    const { abs, rel } = resolveBenchPath(cwd, args?.path, { write: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(args?.content ?? ''), 'utf8');
    return { ok: true, output: `Wrote ${rel}` };
  }
  if (name === 'edit_file') {
    if (!canWrite) return { ok: false, output: 'Harness or turn access is read-only.' };
    const { abs, rel } = resolveBenchPath(cwd, args?.path, { write: true });
    const text = fs.readFileSync(abs, 'utf8');
    const target = String(args?.target ?? '');
    if (!target || !text.includes(target)) throw new Error(`Target snippet not found in ${rel}`);
    const next = text.replace(target, String(args?.replacement ?? ''));
    fs.writeFileSync(abs, next, 'utf8');
    return { ok: true, output: `Edited ${rel}` };
  }
  if (name === 'run_shell') {
    if (!canWrite) return { ok: false, output: 'run_shell is disabled in read-only mode.' };
    const res = await runShellCommand(String(args?.command ?? ''), cwd);
    return { ok: res.ok, output: JSON.stringify({ code: res.code, stdout: res.stdout, stderr: res.stderr }) };
  }
  return { ok: false, output: `Unknown tool: ${name}` };
}

function buildToolSchemas(allowedTools, canWrite, mcpToolList) {
  const defs = [];
  const addFn = (name, description, properties, required = []) => {
    defs.push({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  };
  if (allowedTools.has('read_file')) {
    addFn('read_file', 'Read lines of a file inside the bench.', { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, ['path']);
  }
  if (allowedTools.has('list_dir')) {
    addFn('list_dir', 'List files and directories inside the bench.', { path: { type: 'string' } }, []);
  }
  if (allowedTools.has('search_text')) {
    addFn('search_text', 'Search for text across files in the bench.', { query: { type: 'string' }, path: { type: 'string' } }, ['query']);
  }
  if (canWrite && allowedTools.has('write_file')) {
    addFn('write_file', 'Create or overwrite a file inside your bench zones.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']);
  }
  if (canWrite && allowedTools.has('edit_file')) {
    addFn('edit_file', 'Replace an exact target snippet in a bench file.', { path: { type: 'string' }, target: { type: 'string' }, replacement: { type: 'string' } }, ['path', 'target', 'replacement']);
  }
  if (canWrite && allowedTools.has('run_shell')) {
    addFn('run_shell', 'Run a short test or inspection command inside the bench.', { command: { type: 'string' } }, ['command']);
  }
  if (allowedTools.has('shop_mcp')) {
    for (const t of mcpToolList) {
      defs.push({
        type: 'function',
        function: {
          name: `shop__${t.name}`,
          description: t.description || `WorkShop MCP tool ${t.name}`,
          parameters: isObj(t.inputSchema) ? t.inputSchema : { type: 'object', properties: {} },
        },
      });
    }
  }
  return defs;
}

async function runStandIn(turn) {
  const t0 = Date.now();
  const sid = turn.sessionId || randomUUID();
  const mcpOk = Boolean(turn.mcp?.url && turn.mcp?.token);
  let loaded = [];
  if (mcpOk) {
    try {
      const list = await mcpRpc(turn.mcp, 'tools/list', {});
      loaded = Array.isArray(list?.tools) && list.tools.length ? ['shop'] : [];
    } catch { /* ignore probe error in offline standin */ }
  }
  emit({ t: 'init', sessionId: sid, model: turn.model || 'oss-standin', mcpOk, loaded });

  const prompt = String(turn.prompt || '');
  const harnessId = turn.harness?.id || 'default';
  const harnessPath = path.join(turn.cwd, '.shop', 'HARNESS.md');
  const harnessNote = fs.existsSync(harnessPath) ? `equipped ${harnessId}` : `rig ${harnessId}`;

  let summary = `OSS Stand-in (${harnessNote}) checked bench.`;
  if (prompt.includes('You are the WorkShop self-test.')) {
    summary = 'WorkShop OSS stand-in self-test passed.';
  } else if (mcpOk) {
    emit({ t: 'tool', name: 'shop__read', summary: 'read #plan' });
    await mcpRpc(turn.mcp, 'tools/call', { name: 'read', arguments: { scope: '#plan', limit: 20 } }).catch(() => null);
    emit({ t: 'tool_result', ok: true, summary: 'read ok' });

    const doneMatch = /DONE (T\d+)/.exec(prompt);
    const reviewMatch = /REVIEW (T\d+)[^]*?re:(\d+)/.exec(prompt);
    if (doneMatch) {
      const tid = doneMatch[1];
      const msg = `DONE ${tid} tests=1/1 acc=1/1: Phase 0 OSS stand-in (${harnessId}) verified task flow.`;
      emit({ t: 'tool', name: 'shop__post', summary: `DONE ${tid}` });
      await mcpRpc(turn.mcp, 'tools/call', { name: 'post', arguments: { line: msg } }).catch(() => null);
      emit({ t: 'tool_result', ok: true, summary: 'posted' });
      summary = msg;
    } else if (reviewMatch) {
      const msg = `PASS re:${reviewMatch[2]}: Phase 0 OSS stand-in verified.`;
      emit({ t: 'tool', name: 'shop__post', summary: `PASS re:${reviewMatch[2]}` });
      await mcpRpc(turn.mcp, 'tools/call', { name: 'post', arguments: { line: msg } }).catch(() => null);
      emit({ t: 'tool_result', ok: true, summary: 'posted' });
      summary = msg;
    } else if (/EVENTS IN YOUR STREAM/.test(prompt)) {
      const msg = `INFO #plan: Team Lead (${harnessId}) monitoring specialist stream (Phase 0 stand-in).`;
      emit({ t: 'tool', name: 'shop__post', summary: 'INFO #plan' });
      await mcpRpc(turn.mcp, 'tools/call', { name: 'post', arguments: { line: msg } }).catch(() => null);
      emit({ t: 'tool_result', ok: true, summary: 'posted' });
      summary = msg;
    }
  }

  emit({ t: 'text', text: summary });
  emit({ t: 'usage', inTok: 120, outTok: 48, cacheRead: 0, cacheWrite: 0, usd: 0 });
  emit({ t: 'ctx', tokens: 168, max: 32768 });
  emit({ t: 'result', ok: true, text: summary, sessionId: sid, usd: 0, turns: 1, durationMs: Date.now() - t0 });
}

async function runCustomCommand(turn) {
  const t0 = Date.now();
  const sid = turn.sessionId || randomUUID();
  emit({ t: 'init', sessionId: sid, model: turn.model, mcpOk: true, loaded: ['shop'] });
  const command = String(turn.harness?.runner?.command || '');
  if (!command) {
    emit({ t: 'error', kind: 'other', message: 'Harness command runner has empty command.', resetAt: null });
    emit({ t: 'result', ok: false, text: '', sessionId: sid, usd: 0, turns: 1, durationMs: Date.now() - t0 });
    return;
  }
  const env = {
    ...process.env,
    WORKSHOP_HARNESS_ID: String(turn.harness?.id || ''),
    WORKSHOP_MODEL: String(turn.model || ''),
    WORKSHOP_MCP_URL: turn.mcp?.url ? `${turn.mcp.url}/${turn.mcp.token}` : '',
  };
  await new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', command], { cwd: turn.cwd, env, timeout: turn.timeoutMs || 300_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout ?? '').trim();
      const errTxt = String(stderr ?? '').trim();
      if (out) emit({ t: 'text', text: out.slice(0, 20_000) });
      if (err) {
        emit({ t: 'error', kind: 'other', message: clip(errTxt || err.message, 280), resetAt: null });
        emit({ t: 'result', ok: false, text: out, sessionId: sid, usd: 0, turns: 1, durationMs: Date.now() - t0 });
      } else {
        emit({ t: 'usage', inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, usd: 0 });
        emit({ t: 'result', ok: true, text: out || 'ok', sessionId: sid, usd: 0, turns: 1, durationMs: Date.now() - t0 });
      }
      resolve();
    });
    if (child.stdin) {
      child.stdin.end(String(turn.prompt ?? ''));
    }
  });
}

async function runOpenAiLoop(turn) {
  const t0 = Date.now();
  const sid = turn.sessionId || randomUUID();
  const baseUrl = String(turn.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
  const apiKey = process.env.OSS_API_KEY || '';

  let mcpToolList = [];
  let mcpOk = false;
  if (turn.mcp?.url && turn.mcp?.token) {
    try {
      const res = await mcpRpc(turn.mcp, 'tools/list', {});
      mcpToolList = Array.isArray(res?.tools) ? res.tools : [];
      mcpOk = true;
    } catch { /* MCP unavailable */ }
  }
  emit({ t: 'init', sessionId: sid, model: turn.model, mcpOk, loaded: mcpOk ? ['shop'] : [] });

  const allowedTools = new Set(Array.isArray(turn.harness?.tools) && turn.harness.tools.length
    ? turn.harness.tools
    : ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_text', 'run_shell', 'shop_mcp']);
  const canWrite = turn.access === 'write' && turn.harness?.sandbox?.writeScope !== 'read_only';
  const mcpToolSet = new Set(mcpToolList.map((t) => t.name));
  const toolSchemas = buildToolSchemas(allowedTools, canWrite, mcpToolList);

  const histFile = path.join(turn.runDir, `oss-session-${sid.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  let messages = [];
  if (turn.resume && fs.existsSync(histFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(histFile, 'utf8'));
      if (Array.isArray(saved)) messages = saved;
    } catch { messages = []; }
  }
  if (messages.length === 0) {
    messages.push({ role: 'system', content: String(turn.systemPrompt || 'You are an Open-Source Specialist.') });
  }
  messages.push({ role: 'user', content: String(turn.prompt || '') });

  const maxSteps = Math.min(Number(turn.maxTurns) || 32, Number(turn.harness?.runner?.maxSteps) || 32);
  const temperature = typeof turn.harness?.runner?.temperature === 'number' ? turn.harness.runner.temperature : 0.1;

  let totalIn = 0;
  let totalOut = 0;
  let finalText = '';
  let step = 0;

  while (step < maxSteps && !aborted) {
    step += 1;
    const payload = {
      model: turn.model,
      messages,
      temperature,
      ...(toolSchemas.length > 0 ? { tools: toolSchemas, tool_choice: 'auto' } : {}),
    };
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.min(turn.timeoutMs || 120_000, 300_000)),
    });
    const rawText = await res.text();
    if (!res.ok) {
      const kind = res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? 'rate_limit'
          : res.status === 404 ? 'model' : 'other';
      emit({ t: 'error', kind, message: `OSS endpoint HTTP ${res.status}: ${clip(rawText, 180)}`, resetAt: null, model: turn.model });
      emit({ t: 'result', ok: false, text: finalText, sessionId: sid, usd: 0, turns: step, durationMs: Date.now() - t0 });
      return;
    }
    const data = JSON.parse(rawText);
    const usage = data?.usage || {};
    const stepIn = Number(usage.prompt_tokens) || 0;
    const stepOut = Number(usage.completion_tokens) || 0;
    totalIn += stepIn;
    totalOut += stepOut;
    if (stepIn || stepOut) {
      emit({ t: 'usage', inTok: stepIn, outTok: stepOut, cacheRead: 0, cacheWrite: 0, usd: 0 });
      emit({ t: 'ctx', tokens: stepIn + stepOut, max: null });
    }
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error('OSS endpoint returned empty choices.');
    if (typeof msg.content === 'string' && msg.content.trim()) {
      finalText = msg.content.trim();
      emit({ t: 'text', text: finalText });
    }
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (calls.length === 0) break;

    for (const call of calls) {
      const fnName = call?.function?.name || '';
      let parsedArgs = {};
      try {
        parsedArgs = typeof call?.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call?.function?.arguments || {});
      } catch { parsedArgs = {}; }
      emit({ t: 'tool', name: fnName, summary: clip(JSON.stringify(parsedArgs), 120) });
      let out;
      try {
        out = await execLocalTool(fnName, parsedArgs, { cwd: turn.cwd, canWrite, allowedTools, mcpTools: mcpToolSet, mcp: turn.mcp });
      } catch (err) {
        out = { ok: false, output: `Error: ${err?.message ?? String(err)}` };
      }
      emit({ t: 'tool_result', ok: out.ok !== false, summary: clip(out.output, 160) });
      messages.push({ role: 'tool', tool_call_id: call.id || randomUUID(), content: String(out.output ?? '') });
    }
  }

  writeAtomic(histFile, JSON.stringify(messages.slice(-60)));
  emit({ t: 'result', ok: !aborted, text: finalText, sessionId: sid, usd: 0, turns: step, durationMs: Date.now() - t0 });
}

async function main() {
  const turnFile = process.argv[2];
  if (!turnFile) throw new Error('Usage: oss-agent.mjs <oss-turn.json>');
  const turn = JSON.parse(fs.readFileSync(turnFile, 'utf8'));
  if (turn.mode === 'standin') {
    await runStandIn(turn);
  } else if (turn.harness?.runner?.kind === 'command') {
    await runCustomCommand(turn);
  } else {
    await runOpenAiLoop(turn);
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isEntry) {
  main().catch((err) => {
    emit({ t: 'error', kind: 'other', message: clip(err?.message ?? String(err), 240), resetAt: null });
    emit({ t: 'result', ok: false, text: '', sessionId: null, usd: 0, turns: 0, durationMs: 0 });
    process.exitCode = 1;
  });
}
