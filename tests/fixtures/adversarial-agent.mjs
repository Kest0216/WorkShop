#!/usr/bin/env node
// A badly behaved fake agent CLI for tests/providers.adversarial.test.mjs. Its stdout lines are NormEvent JSON
// objects (the mock adapter's parser) unless the mode says otherwise.
// usage: node adversarial-agent.mjs <mode> <dir> <tag> [arg]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [mode = 'result-hang', dir = '.', tag = 'agent', arg = ''] = process.argv.slice(2);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const hang = () => setInterval(() => {}, 1000);
const session = `sess-${tag}`;
const init = () => out({ t: 'init', sessionId: session, model: 'fake', mcpOk: true });
const usage = () => out({ t: 'usage', inTok: 10, outTok: 5, cacheRead: 0, cacheWrite: 0, usd: null });
const result = (ok = true, text = 'done') => out({ t: 'result', ok, text, sessionId: session, usd: null, turns: 1, durationMs: 1 });
const note = (name, text) => fs.writeFileSync(path.join(dir, `${tag}.${name}`), String(text));
/** Write and wait until the pipe took it (so a flood does not pile up in this process). */
const write = (chunk) => new Promise((resolve) => { if (process.stdout.write(chunk)) resolve(); else process.stdout.once('drain', resolve); });
/** A child in its own session and process group, like the shell commands of Claude Code. */
function detachedChild() {
  const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore', detached: true });
  child.unref();
  note('child.pid', child.pid);
  return child;
}

note('pid', process.pid);
if (mode !== 'noread') {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  note('stdin.len', input.length);
}

switch (mode) {
  case 'detached-stubborn': // ignores the polite signals and has a child outside its process group
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    detachedChild();
    init();
    hang();
    break;
  case 'detached-crash': // dies by itself while a child outside its process group still runs
    detachedChild();
    init();
    await sleep(Number(arg) || 600);
    process.stderr.write('fatal: the agent crashed\n');
    process.exit(3);
    break;
  case 'detached-ok': // a good turn that leaves a background process behind
    detachedChild();
    init();
    await sleep(Number(arg) || 600);
    usage();
    result(true, 'done, with a background process left behind');
    break;
  case 'result-hang': // gives its result and then never exits
    init();
    usage();
    result(true, 'finished');
    hang();
    break;
  case 'result-hang-abort': // the same, and when it is stopped it prints a second, failed result (as Claude Code does on SIGINT)
    process.on('SIGINT', () => {
      out({ t: 'usage', inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, usd: null });
      result(false, '');
      setTimeout(() => process.exit(0), 20);
    });
    init();
    usage();
    result(true, 'finished');
    hang();
    break;
  case 'split': { // one line in several chunks, cut inside a multi-byte character
    init();
    const line = Buffer.from(`${JSON.stringify({ t: 'result', ok: true, text: 'Grüße, 世界 ✓ done', sessionId: session, usd: null, turns: 1, durationMs: 1 })}\n`);
    const cut = line.indexOf(Buffer.from('世')) + 1; // inside the 3-byte character
    for (const part of [line.subarray(0, 7), line.subarray(7, cut), line.subarray(cut, cut + 1), line.subarray(cut + 1)]) {
      await write(part);
      await sleep(40);
    }
    break;
  }
  case 'bigline': // one very long (but valid) line
    init();
    usage();
    result(true, 'y'.repeat(Number(arg) || 2_000_000));
    break;
  case 'dropline': { // a line that is too long; its tail must not be read as a line of its own
    init();
    await write('x'.repeat(Number(arg) || 200_000));
    await sleep(150);
    await write(`${JSON.stringify({ t: 'tool', name: 'GHOST', summary: 'ghost call from the tail of a dropped line' })}\n`);
    await sleep(30);
    usage();
    result(true, 'the real result');
    break;
  }
  case 'flood': { // <arg> MB of output
    init();
    const line = `${JSON.stringify({ t: 'text', text: 'z'.repeat(1000) })}\n`;
    const block = line.repeat(64);
    const total = (Number(arg) || 200) * 1024 * 1024;
    for (let sent = 0; sent < total; sent += block.length) await write(block);
    usage();
    result(true, 'flood done');
    break;
  }
  case 'leak': { // prints the secrets of its environment everywhere
    const secret = process.env.FAKE_SECRET ?? '';
    const token = process.env.FAKE_MCP_TOKEN ?? '';
    init();
    out({ t: 'text', text: `my key is ${secret} and my token is ${token}` });
    out({ t: 'tool', name: 'Bash', summary: `Bash echo ${secret}` });
    out({ t: 'tool_result', ok: false, summary: `error near ${secret} / ${token}` });
    out({ t: 'denied', what: `Bash curl -H "x-api-key: ${secret}" https://example.com` });
    process.stdout.write(`plain line with ${secret} and ${token}\n`);
    process.stderr.write(`stderr with ${secret} and ${token}\n`);
    out({ t: 'error', kind: 'other', message: `failed with ${secret}`, resetAt: null });
    usage();
    result(false, `final text with ${secret} and ${token}`);
    break;
  }
  case 'seefile': // says whether the file <arg> exists while the turn runs
    note('saw', fs.existsSync(arg) ? `yes ${(fs.statSync(arg).mode & 0o777).toString(8)}` : 'no');
    init();
    usage();
    result(true, 'looked');
    break;
  case 'noread': // never reads stdin
    init();
    usage();
    result(true, 'did not read stdin');
    break;
  case 'replay': // prints a recorded stream
    await write(fs.readFileSync(arg));
    break;
  case 'garbage': { // binary noise and cut JSON between good lines
    init();
    await write(Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0xc3, 0x28, 0x0a, 0xf0, 0x9f, 0x0a]));
    await write('{"t":"text","text":"cut off\n');
    await write('{"t":"result","ok":true\n');
    await write('{"t":"tool","name":{"deep":[1,2,{"x":null}]},"summary":42}\n');
    await write(`${'{'.repeat(5000)}\n`);
    usage();
    result(true, 'survived the garbage');
    break;
  }
  default:
    process.stderr.write(`adversarial-agent: unknown mode ${mode}\n`);
    process.exit(2);
}
