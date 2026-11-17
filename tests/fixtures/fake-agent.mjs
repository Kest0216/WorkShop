#!/usr/bin/env node
// A fake agent CLI for the runner tests. Its stdout lines are NormEvent JSON objects (the mock adapter's parser).
// usage: node fake-agent.mjs <mode> <dir> <tag> [ms]
//   It first reads stdin to the end (so a test can prove that the runner closed stdin), then writes
//   <dir>/<tag>.stdin, <dir>/<tag>.pid and a line in <dir>/starts.log, then plays <mode>.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [mode = 'normal', dir = '.', tag = 'agent', msText = '300'] = process.argv.slice(2);
const ms = Number(msText) || 300;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const hang = () => setInterval(() => {}, 1000);
const session = process.env.FAKE_SESSION || `sess-${tag}`;
const init = (mcpOk = true) => out({ t: 'init', sessionId: session, model: 'fake', mcpOk, loaded: ['shop'] });
const result = (ok = true, text = 'done') => out({ t: 'result', ok, text, sessionId: session, usd: null, turns: 2, durationMs: 5 });

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
fs.writeFileSync(path.join(dir, `${tag}.stdin`), input);
fs.writeFileSync(path.join(dir, `${tag}.pid`), String(process.pid));
fs.writeFileSync(path.join(dir, `${tag}.env`), JSON.stringify(process.env));
fs.appendFileSync(path.join(dir, 'starts.log'), `${tag} ${Date.now()}\n`);
// FAKE_CHECK_FILES: paths (":"-separated) whose existence and content the agent records at its start.
if (process.env.FAKE_CHECK_FILES) {
  const seen = {};
  for (const file of process.env.FAKE_CHECK_FILES.split(':').filter(Boolean)) {
    try { seen[file] = { exists: true, content: fs.readFileSync(file, 'utf8') }; } catch { seen[file] = { exists: false, content: null }; }
  }
  fs.writeFileSync(path.join(dir, `${tag}.checked`), JSON.stringify(seen));
}

/** The self-test commands of the prompt ("Run this shell command exactly as written, as one command: ..."). */
function selfTestCommands(text) {
  return text.split('\n').map((line) => /as one command: (.*)$/.exec(line)?.[1]).filter(Boolean);
}

/**
 * Run the self-test commands with /bin/sh, as a CLI's shell tool would.
 * sandbox true simulates an OS sandbox: the hub folder FAKE_DENY is closed (mode 000) while the commands run,
 * the token variables are not in the shell environment, and git push is refused (a denied event).
 * The network never runs in a test: curl becomes `false` (closed) or, with FAKE_NET=open, `true`.
 */
async function runSelfTestCommands(sandbox) {
  const { execFileSync } = await import('node:child_process');
  const deny = (process.env.FAKE_DENY ?? '').split(':').filter((d) => d && fs.existsSync(d)); // folders (":"-separated)
  const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/' };
  if (!sandbox) Object.assign(env, { WORKSHOP_TOKEN: process.env.WORKSHOP_TOKEN ?? '', WORKSHOP_TAG_URL: process.env.WORKSHOP_TAG_URL ?? '' });
  if (sandbox) for (const d of deny) fs.chmodSync(d, 0o000);
  try {
    for (let command of selfTestCommands(input)) {
      command = command.replace(/curl [^&;]*/, process.env.FAKE_NET === 'open' ? 'true' : 'false');
      if (sandbox && command.includes('git push')) {
        out({ t: 'denied', what: 'run_command git push' });
        command = command.replace('git push', 'true');
      }
      out({ t: 'tool', name: 'Bash', summary: `Bash ${command.slice(0, 60)}` });
      let output = '';
      try { output = execFileSync('/bin/sh', ['-c', command], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }); } catch (err) { output = `${err.stdout ?? ''}${err.stderr ?? ''}`; }
      out({ t: 'tool_result', ok: true, summary: output.split('\n')[0] ?? '' });
      process.stdout.write(`${JSON.stringify({ raw: output })}\n`); // the full tool output, as a real CLI stream carries it
    }
  } finally {
    if (sandbox) for (const d of deny) fs.chmodSync(d, 0o700);
  }
}

switch (mode) {
  case 'normal':
    init();
    out({ t: 'text', text: 'Working on it.' });
    out({ t: 'tool', name: 'Edit', summary: 'Edit src/a.js' });
    out({ t: 'tool_result', ok: true, summary: 'ok' });
    out({ t: 'tool', name: 'shop.post', summary: 'shop post DONE T1' });
    out({ t: 'tool_result', ok: false, summary: 'ERR E_BODY too long' });
    out({ t: 'denied', what: 'Bash git push origin main' });
    process.stdout.write('this line is not JSON and must be ignored\n');
    out({ t: 'ctx', tokens: 1150, max: 200000 });
    out({ t: 'usage', inTok: 100, outTok: 20, cacheRead: 1000, cacheWrite: 50, usd: 0.25 });
    result(true, `done: ${input.length} chars of prompt`);
    break;
  case 'longtool':
    // A tool that runs for a long time without any output (a long check run).
    init();
    out({ t: 'tool', name: 'Bash', summary: 'Bash npm test' });
    await sleep(ms);
    out({ t: 'tool_result', ok: true, summary: 'all green' });
    out({ t: 'usage', inTok: 5, outTok: 5, cacheRead: 0, cacheWrite: 0, usd: null });
    result(true, 'long tool done');
    break;
  case 'leak':
    // Prints a value it should never know (a stored key of another lab) in every place a log can see.
    init();
    out({ t: 'text', text: `the value is ${process.env.FAKE_LEAK}` });
    out({ t: 'tool', name: 'Bash', summary: `Bash echo ${process.env.FAKE_LEAK}` });
    out({ t: 'tool_result', ok: false, summary: `error ${process.env.FAKE_LEAK}` });
    out({ t: 'denied', what: `Bash cat key ${process.env.FAKE_LEAK}` });
    process.stderr.write(`stderr ${process.env.FAKE_LEAK}\n`);
    out({ t: 'usage', inTok: 1, outTok: 1, cacheRead: 0, cacheWrite: 0, usd: null });
    result(true, `final ${process.env.FAKE_LEAK}`);
    break;
  case 'modelrl':
    // A per-model weekly limit: only this model must cool.
    init();
    out({ t: 'error', kind: 'rate_limit', message: "You've hit your Opus limit", resetAt: Date.now() + 3_600_000, model: 'fake-big' });
    result(false, '');
    await sleep(20);
    process.exit(1);
    break;
  case 'modelerror':
    init();
    out({ t: 'error', kind: 'model', message: 'There is an issue with the selected model.', resetAt: null });
    result(false, '');
    await sleep(20);
    process.exit(1);
    break;
  case 'selftest-sandbox':
  case 'selftest-open': {
    init();
    const url = `${process.env.FAKE_MCP_URL}/${process.env.FAKE_MCP_TOKEN}`;
    const rpc = async (id, method, params) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-WorkShop': '1' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return res.status === 202 ? null : res.json();
    };
    await rpc(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } });
    out({ t: 'tool', name: 'shop.selftest_ping', summary: 'shop selftest_ping' });
    const call = await rpc(2, 'tools/call', { name: 'selftest_ping', arguments: {} });
    out({ t: 'tool_result', ok: !!call?.result, summary: call?.result?.content?.[0]?.text ?? 'no call' });
    await runSelfTestCommands(mode === 'selftest-sandbox');
    out({ t: 'usage', inTok: 11, outTok: 2, cacheRead: 0, cacheWrite: 0, usd: 0.001 });
    result(true, 'OK');
    break;
  }
  case 'slow':
    init();
    await sleep(ms);
    out({ t: 'usage', inTok: 1, outTok: 1, cacheRead: 0, cacheWrite: 0, usd: null });
    result();
    fs.appendFileSync(path.join(dir, 'ends.log'), `${tag} ${Date.now()}\n`);
    break;
  case 'mcpfail':
    init(false);
    hang();
    break;
  case 'idle':
    init();
    hang();
    break;
  case 'chatty':
    init();
    setInterval(() => out({ t: 'text', text: `tick ${Date.now()}` }), 40);
    break;
  case 'crash':
    init();
    out({ t: 'text', text: 'about to crash' });
    process.stderr.write('boom: something broke\n');
    await sleep(20);
    process.exit(3);
    break;
  case 'noresult':
    init();
    break;
  case 'ratelimit':
    init();
    out({ t: 'error', kind: 'rate_limit', message: "You've hit your session limit · resets 3:45pm", resetAt: Date.now() + 3_600_000 });
    result(false, '');
    await sleep(20);
    process.exit(1);
    break;
  case 'auth':
    init();
    out({ t: 'error', kind: 'auth', message: 'Not logged in · Please run /login', resetAt: null });
    hang(); // like a CLI that retries a 401 for minutes: the runner must stop it
    break;
  case 'tree': {
    const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' }); // same process group as this agent
    fs.writeFileSync(path.join(dir, `${tag}.child.pid`), String(child.pid));
    init();
    hang();
    break;
  }
  case 'stubborn':
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    init();
    hang();
    break;
  case 'holdpipe': {
    // The grandchild inherits stdout and outlives the agent: the pipes stay open after the agent exits.
    const child = spawn('/bin/sleep', ['600'], { stdio: ['ignore', 'inherit', 'inherit'] });
    fs.writeFileSync(path.join(dir, `${tag}.child.pid`), String(child.pid));
    init();
    out({ t: 'usage', inTok: 3, outTok: 4, cacheRead: 0, cacheWrite: 0, usd: null });
    result(true, 'done with a leftover child');
    await sleep(20);
    process.exit(0);
    break;
  }
  case 'partial':
    init();
    process.stdout.write(JSON.stringify({ t: 'result', ok: true, text: 'no newline at the end', sessionId: session, usd: null, turns: 1, durationMs: 1 }));
    break;
  case 'flood':
    init();
    for (let i = 0; i < 500; i++) out({ t: 'text', text: `line ${i}` });
    result();
    break;
  case 'selftest': {
    // Calls the hub tool selftest_ping over HTTP like a real CLI would, then answers OK.
    init();
    const url = `${process.env.FAKE_MCP_URL}/${process.env.FAKE_MCP_TOKEN}`;
    const rpc = async (id, method, params) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-WorkShop': '1' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return res.status === 202 ? null : res.json();
    };
    await rpc(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } });
    const list = await rpc(1, 'tools/list', {});
    const names = (list?.result?.tools ?? []).map((tool) => tool.name);
    out({ t: 'tool', name: 'shop.selftest_ping', summary: 'shop selftest_ping' });
    const call = mode === 'selftest' && names.includes('selftest_ping') ? await rpc(2, 'tools/call', { name: 'selftest_ping', arguments: {} }) : null;
    out({ t: 'tool_result', ok: !!call?.result && call.result.isError !== true, summary: call?.result?.content?.[0]?.text ?? 'no call' });
    out({ t: 'usage', inTok: 11, outTok: 2, cacheRead: 0, cacheWrite: 0, usd: 0.001 });
    result(true, 'OK');
    break;
  }
  default:
    process.stderr.write(`fake-agent: unknown mode ${mode}\n`);
    process.exit(2);
}
