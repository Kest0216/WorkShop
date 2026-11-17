// The first tests use the documented shapes (docs and agy 1.5.1 help). The tests at the end use the streams of
// one real signed-in run of agy 1.5.1 (tests/fixtures/gemini/*.real.jsonl; paths made neutral).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParser, classify, parseModels, clampEffort, modelArgs, AGY } from '../server/providers/gemini.js';
import { createParser as createMockParser } from '../server/providers/mock.js';

const CID = '3f0c6c1e-1111-4222-8333-444455556666';
const J = JSON.stringify;
const initLine = J({ event: 'init', conversation_id: CID, init: { cwd: '/bench', tools: ['run_command', 'write_to_file'], permission_mode: 'request-review' } });
const textStep = (i, delta, state = 'ACTIVE') => J({ event: 'step_update', step_update: { conversation_id: CID, step_index: i, state, step_type: 'agent_response', text_delta: delta } });
const toolStep = (i, name, parameters, extra = {}) => J({ event: 'step_update', step_update: { conversation_id: CID, step_index: i, state: 'DONE', step_type: 'tool', tool_name: name, duration_seconds: 0.07, tool_info: { name, parameters, output: 'hi\r\n', ...extra } } });
const resultLine = (r = {}) => J({ event: 'result', result: { conversation_id: CID, status: 'SUCCESS', response: 'All done.', duration_seconds: 6.88, num_turns: 1, usage: { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 }, ...r } });

function feed(lines, endInfo = { code: 0, signal: null, stderrTail: '' }) {
  const parser = createParser();
  const events = [];
  for (const line of lines) events.push(...parser.push(line));
  events.push(...parser.end(endInfo));
  return events;
}
const of = (events, t) => events.filter((e) => e.t === t);

test('documented stream: init, steps, result', () => {
  const events = feed([
    initLine,
    J({ event: 'step_update', step_update: { conversation_id: CID, step_index: 0, state: 'DONE', step_type: 'user_input' } }),
    textStep(3, 'I will '), textStep(3, 'run the command.'),
    J({ event: 'step_update', step_update: { conversation_id: CID, step_index: 3, state: 'DONE', step_type: 'agent_response', duration_seconds: 6.28, usage: { input_tokens: 10302, output_tokens: 582, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 10884 } } }),
    toolStep(4, 'run_command', { CommandLine: 'echo hi' }),
    J({ event: 'step_update', step_update: { conversation_id: CID, step_index: 5, state: 'DONE', step_type: 'checkpoint' } }),
    resultLine(),
  ]);
  assert.deepEqual(events.map((e) => e.t), ['init', 'ctx', 'text', 'tool', 'tool_result', 'usage', 'result']);
  assert.deepEqual(events[0], { t: 'init', sessionId: CID, model: null, mcpOk: true, loaded: [] });
  assert.deepEqual(events[1], { t: 'ctx', tokens: 10302 + 8113, max: null }, 'context in use: fresh input plus cached input of the latest call');
  assert.equal(events[2].text, 'I will run the command.');
  assert.deepEqual(events[3], { t: 'tool', name: 'run_command', summary: 'run_command echo hi' });
  assert.deepEqual(events[4], { t: 'tool_result', ok: true, summary: 'hi' });
  // Usage is the sum of the finished steps of THIS run. input_tokens does not hold the cached input, and
  // output_tokens already holds thinking_tokens (total_tokens = input_tokens + output_tokens in every sample).
  assert.deepEqual(events[5], { t: 'usage', inTok: 10302, outTok: 582, cacheRead: 8113, cacheWrite: 0, usd: null });
  assert.deepEqual(events[6], { t: 'result', ok: true, text: 'All done.', sessionId: CID, usd: null, turns: 1, durationMs: 6880 });
  // without step usage the usage of the result line is all there is
  const bare = feed([initLine, resultLine()]);
  assert.deepEqual(of(bare, 'usage'), [{ t: 'usage', inTok: 10418, outTok: 589, cacheRead: 8113, cacheWrite: 0, usd: null }]);
});

test('MCP tools: eager name and the lazy call_mcp_tool both show as shop.<tool>', () => {
  const events = feed([
    initLine,
    toolStep(1, 'mcp_shop_post', { line: 'DONE T12 tests=41/41: All tests pass.' }),
    toolStep(2, 'call_mcp_tool', { ServerName: 'shop', ToolName: 'read', Arguments: { scope: 'T12' } }),
    toolStep(3, 'write_to_file', { TargetFile: '/bench/src/a.js', CodeContent: 'SECRET CONTENT' }),
    toolStep(4, 'run_command', { CommandLine: 'npm test' }, { output: undefined, error: { type: 'exit', message: 'exit status 1\nmore' } }),
    resultLine(),
  ]);
  const tools = of(events, 'tool');
  assert.deepEqual(tools.map((t) => t.name), ['shop.post', 'shop.read', 'write_to_file', 'run_command']);
  assert.deepEqual(tools.map((t) => t.summary), ['shop post DONE T12', 'shop read T12', 'write_to_file src/a.js', 'run_command npm test']);
  assert.ok(!JSON.stringify(tools).includes('SECRET'));
  const results = of(events, 'tool_result');
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
  assert.equal(results[3].summary, 'exit status 1 (+1 lines)');
});

test('an ACTIVE tool step and its DONE step make one tool event', () => {
  const active = J({ event: 'step_update', step_update: { conversation_id: CID, step_index: 7, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } });
  const events = feed([initLine, active, toolStep(7, 'run_command', { CommandLine: 'ls' }), resultLine()]);
  assert.equal(of(events, 'tool').length, 1);
  assert.equal(of(events, 'tool_result').length, 1);
});

test('denied_actions become denied events (strings and objects); exit 0 does not hide them', () => {
  const events = feed([initLine, resultLine({ denied_actions: ['command(git push origin main)', { tool_name: 'run_command', parameters: { CommandLine: 'sudo rm -rf /' } }, { action: 'write_file', target: '/etc/hosts' }, 42] })]);
  assert.deepEqual(of(events, 'denied').map((d) => d.what), ['command(git push origin main)', 'run_command sudo rm -rf /', 'write_file /etc/hosts', 'action']);
  assert.equal(of(events, 'result')[0].ok, true);
});

test('exit 1, authentication: auth error and a failed result (the documented error object)', () => {
  const line = J({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, finished_reason: 'error' } });
  const events = feed([line], { code: 1, signal: null, stderrTail: "Error: authentication required. Run 'agy' to log in, then retry." });
  assert.deepEqual(events.map((e) => e.t), ['usage', 'error', 'result']);
  assert.equal(of(events, 'error')[0].kind, 'auth');
  assert.equal(of(events, 'result')[0].ok, false);
  // the same object without the stream wrapper (--output-format json)
  const plain = feed([J(JSON.parse(line).result)], { code: 1, signal: null, stderrTail: '' });
  assert.equal(of(plain, 'error')[0].kind, 'auth');
});

test('exit 1: unknown model (error kind model) and bad settings are told apart by the text', () => {
  // Synthetic texts: no real model refusal of agy was recorded. The contract: error kind 'model' with the model.
  const model = feed([], { code: 1, signal: null, stderrTail: 'Error: unknown model "gemini-9-neon-high"' });
  assert.equal(model[0].kind, 'model');
  assert.match(model[0].message, /cannot use this model/);
  assert.equal(model[0].model, undefined, 'no init line: the runner fills in the model of the turn');
  const named = feed([J({ event: 'init', conversation_id: CID, init: { model: 'gemini-4-carbon-high', cwd: '/b', tools: [] } })], { code: 3, signal: null, stderrTail: 'AGY_ERROR: {"message":"model gemini-4-carbon-high is not available on your plan","code":403}\n' });
  assert.deepEqual(of(named, 'error').map((e) => [e.kind, e.model]), [['model', 'gemini-4-carbon']], 'a plan gate names the registry id (the slug without its effort)');
  const settings = feed([], { code: 1, signal: null, stderrTail: 'Error: invalid settings: unknown key "agentMod"' });
  assert.equal(settings[0].kind, 'other');
  assert.match(settings[0].message, /refused its settings/);
  const noKey = feed([], { code: 1, signal: null, stderrTail: 'Error: GEMINI_API_KEY is not set' });
  assert.equal(noKey[0].kind, 'auth');
});

test('exit 2: usage error', () => {
  const events = feed([], { code: 2, signal: null, stderrTail: 'flag needs an argument: -p' });
  assert.deepEqual(events.map((e) => e.t), ['error', 'result']);
  assert.match(events[0].message, /usage error: flag needs an argument/);
});

test('exit 3 with an AGY_ERROR line: quota is a rate limit, other errors are other', () => {
  const failed = resultLine({ status: 'ERROR', response: 'partial', error: 'model error', finished_reason: 'error' });
  const quota = feed([initLine, failed], { code: 3, signal: null, stderrTail: 'some notice\nAGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"message":"Quota exceeded. Resets in 2h 30m"}\n' });
  const err = of(quota, 'error');
  assert.equal(err.length, 1);
  assert.equal(err[0].kind, 'rate_limit');
  assert.ok(err[0].resetAt > Date.now() + 2 * 3600_000 && err[0].resetAt < Date.now() + 3 * 3600_000);
  assert.deepEqual(of(quota, 'result').map((r) => [r.ok, r.text, r.sessionId]), [[false, 'partial', CID]]);

  const internal = feed([initLine, failed], { code: 3, signal: null, stderrTail: 'AGY_ERROR: {"status":"INTERNAL","code":500,"retryable":true,"error_id":"abc"}' });
  assert.equal(of(internal, 'error')[0].kind, 'other');
  assert.match(of(internal, 'error')[0].message, /INTERNAL/);

  const notJson = feed([], { code: 3, signal: null, stderrTail: 'AGY_ERROR: not json at all' });
  assert.match(notJson[0].message, /not json at all/);
});

test('status and finished_reason: timeout is an error, an interrupted run is only a failed result', () => {
  const timeout = feed([initLine, resultLine({ status: 'SUCCESS', finished_reason: 'print_timeout' })], { code: 3, signal: null, stderrTail: '' });
  assert.match(of(timeout, 'error')[0].message, /print timeout/);
  assert.equal(of(timeout, 'result')[0].ok, false);

  for (const r of [{ status: 'CANCELED' }, { status: 'INTERRUPTED' }, { status: 'SUCCESS', finished_reason: 'interrupted' }]) {
    const events = feed([initLine, resultLine(r)], { code: 0, signal: 'SIGINT', stderrTail: '' });
    assert.equal(of(events, 'error').length, 0);
    assert.equal(of(events, 'result')[0].ok, false);
  }
  for (const status of ['INVALID', 'WAITING', 'RUNNING', 'ERROR', 'weird']) {
    const events = feed([initLine, resultLine({ status })]);
    assert.equal(of(events, 'result')[0].ok, false, status);
    assert.equal(of(events, 'error').length, 1, status);
  }
});

test('no result line: error and failed result, with usage from finished steps', () => {
  const events = feed([
    initLine,
    J({ event: 'step_update', step_update: { conversation_id: CID, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'half', usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 40 } } }),
  ], { code: null, signal: 'SIGTERM', stderrTail: '' });
  assert.deepEqual(events.map((e) => e.t), ['init', 'ctx', 'text', 'usage', 'error', 'result']);
  assert.deepEqual(events[3], { t: 'usage', inTok: 100, outTok: 20, cacheRead: 40, cacheWrite: 0, usd: null });
  assert.match(events[4].message, /SIGTERM/);
  assert.equal(events[5].sessionId, CID);
  assert.deepEqual(feed([], { code: 0, signal: null, stderrTail: '' }).map((e) => e.t), ['error', 'result']);
});

test('unknown keys, unknown events and malformed lines never crash', () => {
  const parser = createParser();
  const lines = ['', 'Authentication required. Please visit the URL to log in:', '{bad json', '[]', 'null', '7',
    J({ event: 'future', future: { x: 1 } }), J({ event: 'init' }), J({ event: 'init', init: 'text' }), J({ event: 'step_update' }),
    J({ event: 'step_update', step_update: { step_type: 'tool' } }), J({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_info: 'x' } }),
    J({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 5, subagent_info: { subagents: [{}] }, new_key: [1] } }),
    J({ event: 'result' }), J({ event: 'result', result: 'x' }), J({ event: 'result', result: { status: 5, denied_actions: 'no', usage: 'no', error: { message: 'm' } } }),
    J({ type: 'init', session_id: 'gemini-cli-shape' })];
  for (const line of lines) assert.ok(Array.isArray(parser.push(line)));
  assert.deepEqual(parser.push(undefined), []);
  assert.ok(Array.isArray(parser.end({})));
  assert.ok(Array.isArray(createParser().end()));
  const extra = feed([J({ event: 'init', conversation_id: CID, extra: 1, init: { cwd: '/b', model: 'gemini-4-argon-high', agent: 'maker', mcp_servers: [{ name: 'shop', status: 'failed' }] } })]);
  assert.equal(extra[0].model, 'gemini-4-argon-high');
  assert.equal(extra[0].mcpOk, false);
  assert.equal(extra[1].kind, 'mcp');
});

test('classify, parseModels, effort and model arguments', () => {
  assert.equal(classify('authentication failed or timed out').kind, 'auth');
  assert.equal(classify('429 RESOURCE_EXHAUSTED').kind, 'rate_limit');
  assert.equal(classify('You have reached your quota. Try again in 45 minutes').kind, 'rate_limit');
  assert.ok(classify('quota exceeded, retry after 60 seconds', 1000).resetAt === 61_000);
  assert.equal(classify('something else').kind, null);
  assert.equal(classify(null).kind, null);

  assert.deepEqual(parseModels('Available models:\n  gemini-4-hydrogen-low\n* gemini-4-hydrogen-high (default)\n  gemini-4-argon-medium   Gemini 4 Argon\n  claude-sonnet-5-5-high\nOrchestrator (Carbon)\n'),
    ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-high', 'gemini-4-argon-medium', 'claude-sonnet-5-5-high']);
  assert.deepEqual(parseModels(''), []);
  assert.deepEqual(parseModels(null), []);

  assert.equal(clampEffort('gemini-4-hydrogen', 'xhigh'), 'xhigh');
  assert.equal(clampEffort('gemini-4-hydrogen', 'max'), 'xhigh');
  assert.equal(clampEffort('gemini-4-carbon', 'xhigh'), 'high');
  assert.equal(clampEffort('gemini-4-argon', 'low'), 'low');
  assert.equal(clampEffort('gemini-4-argon', undefined), 'medium');
  assert.equal(clampEffort('gemini-3.5-flash-lite', 'high'), null);

  assert.equal(AGY.modelStyle, 'slug+effort');
  assert.deepEqual(modelArgs('gemini-4-hydrogen', 'high'), ['--model', 'gemini-4-hydrogen-high', '--effort', 'high']);
  assert.deepEqual(modelArgs('gemini-4-carbon', 'max'), ['--model', 'gemini-4-carbon-high', '--effort', 'high']);
  assert.deepEqual(modelArgs('gemini-3.5-flash-lite', 'high'), ['--model', 'gemini-3.5-flash-lite']);
  assert.deepEqual(modelArgs('gemini-4-argon', 'low', null, 'slug'), ['--model', 'gemini-4-argon-low']);
  assert.deepEqual(modelArgs('gemini-4-argon', 'low', null, 'base+effort'), ['--model', 'gemini-4-argon', '--effort', 'low']);
  assert.deepEqual(modelArgs('gemini-4-argon', 'low', ['gemini-4-argon']), ['--model', 'gemini-4-argon', '--effort', 'low'], 'the account lists only the base name');
  assert.deepEqual(modelArgs('gemini-4-argon', 'low', ['gemini-4-argon-low']), ['--model', 'gemini-4-argon-low', '--effort', 'low']);
});

test('mock parser: NormEvent lines pass through, other lines are ignored, a missing result is an error', () => {
  const p = createMockParser();
  assert.deepEqual(p.push(J({ t: 'init', sessionId: 's1', model: 'mock', mcpOk: true })), [{ t: 'init', sessionId: 's1', model: 'mock', mcpOk: true, loaded: [] }]);
  assert.deepEqual(createMockParser().push(J({ t: 'init', sessionId: 's', loaded: ['shop', 7] }))[0].loaded, ['shop']);
  assert.deepEqual(createMockParser().push(J({ t: 'error', kind: 'model', message: 'm', model: 'x-1' })), [{ t: 'error', kind: 'model', message: 'm', resetAt: null, model: 'x-1' }]);
  assert.deepEqual(p.push(J({ t: 'tool', name: 'shop.post', summary: 'shop post DONE T1', extra: 'dropped' })), [{ t: 'tool', name: 'shop.post', summary: 'shop post DONE T1' }]);
  assert.deepEqual(p.push(J({ t: 'usage', inTok: 5, outTok: '7', usd: 'x' })), [{ t: 'usage', inTok: 5, outTok: 0, cacheRead: 0, cacheWrite: 0, usd: null }]);
  assert.deepEqual(p.push(J({ t: 'error', kind: 'weird', message: 'm' })), [{ t: 'error', kind: 'other', message: 'm', resetAt: null }]);
  for (const line of ['', 'plain log line', '{"t":"unknown"}', '{"no":"t"}', '[1]', '{bad']) assert.deepEqual(p.push(line), []);
  assert.deepEqual(p.push(J({ t: 'result', ok: true, text: 'done', turns: 2, durationMs: 9 })), [{ t: 'result', ok: true, text: 'done', sessionId: 's1', usd: null, turns: 2, durationMs: 9 }]);
  assert.deepEqual(p.end({ code: 0 }), []);
  const dead = createMockParser();
  dead.push(J({ t: 'init', sessionId: 's2' }));
  const events = dead.end({ code: 3, signal: null, stderrTail: 'boom\n' });
  assert.deepEqual(events.map((e) => e.t), ['error', 'result']);
  assert.match(events[0].message, /exit code 3.*boom/);
  assert.equal(events[1].sessionId, 's2');
});

// ------------------------------------------------------------------------------------------- the real run

const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gemini');
const real = (name) => feed(fs.readFileSync(path.join(REAL, name), 'utf8').split('\n'));

test('real agy 1.5.1 stream, first turn: file write, hub tool, text, usage of this run', () => {
  const events = real('agy-worker-turn1.real.jsonl');
  assert.deepEqual(events.map((e) => e.t), ['init', 'ctx', 'tool', 'tool_result', 'tool', 'tool_result', 'ctx', 'text', 'usage', 'result']);
  assert.deepEqual(events[0], { t: 'init', sessionId: '25205a15-d680-4584-8116-afe71136cbc8', model: 'gemini-4-hydrogen-low', mcpOk: true, loaded: [] });
  assert.deepEqual(of(events, 'tool'), [
    { t: 'tool', name: 'write_file', summary: 'write_file hello.txt' },
    { t: 'tool', name: 'shop.board_post', summary: 'shop board_post' }, // the eager tool name mcp_shop_<tool>
  ]);
  assert.deepEqual(of(events, 'tool_result'), [{ t: 'tool_result', ok: true, summary: 'ok' }, { t: 'tool_result', ok: true, summary: 'posted #1 to boss' }]);
  assert.deepEqual(of(events, 'text'), [{ t: 'text', text: 'done\n' }]);
  assert.deepEqual(of(events, 'ctx'), [{ t: 'ctx', tokens: 23726, max: 1_048_576 }, { t: 'ctx', tokens: 24196, max: 1_048_576 }]);
  assert.deepEqual(of(events, 'usage'), [{ t: 'usage', inTok: 47922, outTok: 355, cacheRead: 0, cacheWrite: 0, usd: null }]);
  assert.deepEqual(events.at(-1), { t: 'result', ok: true, text: 'done\n', sessionId: '25205a15-d680-4584-8116-afe71136cbc8', usd: null, turns: 1, durationMs: 19069 });
});

test('real agy 1.5.1 stream, follow-up turn: the usage is of this run, not the total of the conversation', () => {
  const events = real('agy-worker-turn2.real.jsonl');
  assert.deepEqual(events.map((e) => e.t), ['init', 'ctx', 'text', 'usage', 'result']);
  // The result line says input_tokens 50201 and output_tokens 388: that is turn 1 plus turn 2. This run made one
  // model call: 2279 fresh input tokens, 22147 from the cache, 33 output tokens.
  assert.deepEqual(of(events, 'usage'), [{ t: 'usage', inTok: 2279, outTok: 33, cacheRead: 22147, cacheWrite: 0, usd: null }]);
  assert.deepEqual(of(events, 'ctx'), [{ t: 'ctx', tokens: 2279 + 22147, max: 1_048_576 }]);
  const result = events.at(-1);
  assert.deepEqual([result.ok, result.text, result.sessionId], [true, 'hello.txt\n', '25205a15-d680-4584-8116-afe71136cbc8']);
  assert.equal(result.turns, 2, 'num_turns counts the whole conversation');
});

test('real agy 1.5.1 stream: a sandboxed shell command and unknown step types', () => {
  const events = real('agy-worker-turn3.real.jsonl');
  assert.deepEqual(of(events, 'tool'), [{ t: 'tool', name: 'run_command', summary: 'run_command ls -a .' }]);
  assert.deepEqual(of(events, 'tool_result'), [{ t: 'tool_result', ok: true, summary: 'Command exited with code 0. (+2 lines)' }]);
  assert.equal(of(events, 'error').length, 0);
  assert.equal(events.at(-1).ok, true);
  assert.deepEqual(of(events, 'usage'), [{ t: 'usage', inTok: 23703 + 23866, outTok: 94 + 14, cacheRead: 0, cacheWrite: 0, usd: null }]);
});

test('real `agy models` output: slugs are <api id>-<effort>, one per line with a label', () => {
  const models = parseModels(fs.readFileSync(path.join(REAL, 'agy-models.real.txt'), 'utf8'));
  assert.equal(models.length, 20);
  for (const slug of ['gemini-4-carbon-high', 'gemini-4-argon-low', 'gemini-4-hydrogen-xhigh', 'gemini-3.8-flash-medium', 'claude-opus-5-5-high', 'gpt-oss-120b-medium']) assert.ok(models.includes(slug), slug);
  assert.ok(models.every((slug) => /^[a-z0-9.-]+$/.test(slug)), 'no label text');
  assert.deepEqual(modelArgs('gemini-4-hydrogen', 'low', models), ['--model', 'gemini-4-hydrogen-low', '--effort', 'low']);
  assert.deepEqual(modelArgs('gemini-4-carbon', 'xhigh', models), ['--model', 'gemini-4-carbon-high', '--effort', 'high']);
});

// ------------------------------------------------------------------------------------------- amended contract

const REAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real');
const realRun = (name) => feed(fs.readFileSync(path.join(REAL_DIR, name), 'utf8').split('\n'));

test('real streams (tests/fixtures/real): every agy worker turn parses exactly', () => {
  const lines = fs.readFileSync(path.join(REAL_DIR, 'agy-worker-turn1.real.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // The init tools list: 60 built-in tools and call_mcp_tool, no mcp_<server>_<tool> entry, no mcp_servers.
  assert.equal(lines[0].init.tools.length, 60);
  assert.ok(lines[0].init.tools.includes('call_mcp_tool'));
  // step_type "unknown" (and "system_message" in turn 2) are ignored.
  assert.ok(lines.some((l) => l.step_update?.step_type === 'unknown'));

  const one = realRun('agy-worker-turn1.real.jsonl');
  assert.deepEqual(one.map((e) => e.t), ['init', 'ctx', 'tool', 'tool_result', 'tool', 'tool_result', 'ctx', 'text', 'usage', 'result']);
  assert.deepEqual(one[0].loaded, [], 'no server is named in init: loaded is empty');
  assert.deepEqual(of(one, 'tool').map((e) => [e.name, e.summary]), [['write_file', 'write_file hello.txt'], ['shop.board_post', 'shop board_post']], 'mcp_shop_<tool> shows as shop.<tool>');
  // about 24,000 input tokens per model call
  assert.deepEqual(of(one, 'ctx').map((e) => e.tokens), [23726, 24196]);
  assert.ok(of(one, 'ctx').every((e) => e.tokens > 23_000 && e.tokens < 25_000));
  assert.deepEqual(of(one, 'usage'), [{ t: 'usage', inTok: 47922, outTok: 355, cacheRead: 0, cacheWrite: 0, usd: null }]);

  const two = realRun('agy-worker-turn2.real.jsonl');
  assert.deepEqual(two.map((e) => e.t), ['init', 'ctx', 'text', 'usage', 'result']);
  assert.deepEqual(of(two, 'usage'), [{ t: 'usage', inTok: 2279, outTok: 33, cacheRead: 22147, cacheWrite: 0, usd: null }], 'per-run usage: the steps of this run');
  assert.deepEqual(of(two, 'ctx'), [{ t: 'ctx', tokens: 24426, max: 1_048_576 }]);
  assert.equal(two.at(-1).sessionId, one.at(-1).sessionId);

  const three = realRun('agy-worker-turn3.real.jsonl');
  assert.deepEqual(three.map((e) => e.t), ['init', 'ctx', 'tool', 'tool_result', 'ctx', 'text', 'usage', 'result']);
  assert.deepEqual(of(three, 'usage'), [{ t: 'usage', inTok: 47569, outTok: 108, cacheRead: 0, cacheWrite: 0, usd: null }]);
  assert.equal(three.at(-1).sessionId, '29a4c581-99f8-4278-960a-bb6f4677319d');
  assert.equal(of([...one, ...two, ...three], 'error').length, 0);
});

test('A08: init.loaded lists the MCP servers of init and the servers behind eager tools', () => {
  const init = (extra) => feed([J({ event: 'init', conversation_id: CID, init: { model: 'gemini-4-hydrogen-low', cwd: '/b', ...extra } })])[0];
  assert.deepEqual(init({ tools: ['run_command', 'mcp_shop_post', 'mcp_shop_read', 'mcp_github_issue', 'call_mcp_tool'] }).loaded, ['shop', 'github']);
  assert.deepEqual(init({ mcp_servers: [{ name: 'shop', status: 'connected' }, { name: 'drive', status: 'connected' }], tools: [] }).loaded, ['shop', 'drive']);
  assert.deepEqual(init({ tools: 'x' }).loaded, []);
});

test('A23: eager tools hold req_add', () => {
  assert.ok(AGY.eagerTools.includes('req_add'));
  assert.deepEqual([...AGY.eagerTools].sort(), ['claim', 'job_report', 'plan_submit', 'post', 'read', 'req_add', 'req_verify', 'status', 'task_add', 'task_cancel', 'task_retry', 'task_update']);
});
