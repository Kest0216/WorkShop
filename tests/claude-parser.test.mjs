import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParser, classify, parseResetAt, toolSummary, toolDisplayName } from '../server/providers/claude.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude');
const linesOf = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n');

function run(name, endInfo = { code: 0, signal: null, stderrTail: '' }) {
  const parser = createParser();
  const events = [];
  for (const line of linesOf(name)) events.push(...parser.push(line));
  events.push(...parser.end(endInfo));
  return events;
}
const of = (events, t) => events.filter((e) => e.t === t);

const SHAPES = {
  init: ['sessionId', 'model', 'mcpOk', 'loaded'],
  text: ['text'],
  tool: ['name', 'summary'],
  tool_result: ['ok', 'summary'],
  usage: ['inTok', 'outTok', 'cacheRead', 'cacheWrite', 'usd'],
  denied: ['what'],
  result: ['ok', 'text', 'sessionId', 'usd', 'turns', 'durationMs'],
  error: ['kind', 'message', 'resetAt'],
  // Two event types that are not in the contract list. The runner uses them, other readers ignore them.
  ctx: ['tokens', 'max'], // how full the context window is after the latest model call (agent.stats.ctxTok / ctxMax)
  limit: ['status', 'type', 'utilization', 'resetAt', 'overage'], // a rate_limit_event line of the CLI
};
// usage.cacheWrite1h: the part of cacheWrite that is billed at the one-hour rate. error.model and limit.model:
// the model that the CLI refused (kind 'model') or whose own limit was hit (a per-model limit).
const OPTIONAL = { usage: ['cacheWrite1h'], error: ['model'], limit: ['model'] };
function assertNorm(events) {
  for (const e of events) {
    assert.ok(SHAPES[e.t], `known event type: ${JSON.stringify(e)}`);
    const keys = Object.keys(e).filter((k) => !(OPTIONAL[e.t] ?? []).includes(k));
    assert.deepEqual(keys.sort(), ['t', ...SHAPES[e.t]].sort(), `shape of ${e.t}`);
    if (e.t === 'error') assert.ok(['rate_limit', 'auth', 'mcp', 'model', 'other'].includes(e.kind));
    if (e.t === 'init') assert.ok(Array.isArray(e.loaded) && e.loaded.every((n) => typeof n === 'string'));
    if (e.t === 'tool') assert.ok(e.summary.length <= 120, `short summary: ${e.summary}`);
  }
}

test('every fixture parses into valid NormEvents and never throws', () => {
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 20);
  for (const file of files) {
    const events = run(file);
    assertNorm(events);
    assert.ok(of(events, 'init').length >= 1, `${file}: init`);
    assert.ok(of(events, 'result').length >= 1, `${file}: a result or a synthetic result`);
  }
});

test('basic run: init, text, usage, result', () => {
  const all = run('claude-stream-basic.jsonl');
  assert.deepEqual(all.map((e) => e.t), ['init', 'ctx', 'text', 'usage', 'ctx', 'result']);
  const ctx = of(all, 'ctx');
  assert.ok(ctx[0].tokens > 1000 && ctx[0].max === null, 'the context fill comes with the model call');
  assert.deepEqual(ctx[1], { t: 'ctx', tokens: ctx[0].tokens, max: 200000 }, 'the window size comes with the result');
  const events = all.filter((e) => e.t !== 'ctx');
  const [init, text, usage, result] = events;
  assert.equal(init.mcpOk, true);
  assert.equal(init.model, 'claude-haiku-4-5-20251001');
  assert.match(init.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(text.text, 'ok');
  assert.ok(usage.inTok >= 1 && usage.outTok >= 1 && usage.cacheRead + usage.cacheWrite > 1000);
  assert.equal(typeof usage.usd, 'number');
  assert.deepEqual({ ok: result.ok, text: result.text, turns: result.turns }, { ok: true, text: 'ok', turns: 1 });
  assert.equal(result.sessionId, init.sessionId);
  assert.equal(result.usd, usage.usd);
  assert.ok(result.durationMs > 0);
});

test('not logged in: one auth error, result not ok', () => {
  const events = run('claude-stream-not-logged-in.jsonl', { code: 1, signal: null, stderrTail: '' });
  const errors = of(events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'auth');
  assert.match(errors[0].message, /Not logged in/);
  assert.equal(of(events, 'result')[0].ok, false);
  assert.equal(of(events, 'text').length, 0, 'the error text is not agent text');
});

test('API error 400: error of kind other', () => {
  const events = run('claude-stream-api-error-400.jsonl', { code: 1 });
  const errors = of(events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'other');
  assert.match(errors[0].message, /API Error: 400/);
  assert.equal(of(events, 'result')[0].ok, false);
});

test('a retry that recovers is not an error', () => {
  const events = run('claude-stream-api-retry.jsonl');
  assert.equal(of(events, 'error').length, 0);
  assert.equal(of(events, 'result')[0].ok, true);
});

test('worker run: tool summaries, tool results, denied actions', () => {
  const events = run('claude-stream-worker-recommended.jsonl');
  const tools = of(events, 'tool');
  assert.equal(tools.length, 10);
  assert.deepEqual(tools[0], { t: 'tool', name: 'workshop.board_post', summary: 'workshop board_post' });
  assert.equal(tools[1].summary, 'Write feature.txt');
  assert.equal(tools[2].summary, 'Read notes.txt');
  assert.equal(tools[3].summary, 'Edit notes.txt');
  assert.match(tools[4].summary, /^Write …\/work\/outside\/out2\.txt$/);
  assert.match(tools[5].summary, /^Bash git add -A && git commit/);
  for (const tool of tools) assert.ok(!/feature\\n|gamma|outside\\n/.test(tool.summary), 'no file content in a summary');
  const denied = of(events, 'denied').map((d) => d.what);
  assert.equal(denied.length, 5, 'each denial is reported once (system event and result list overlap)');
  assert.ok(denied.includes('Bash git push origin main'));
  assert.ok(denied.includes('Bash git merge --no-edit main'));
  assert.ok(denied.some((w) => w.startsWith('Write ')));
  const results = of(events, 'tool_result');
  assert.equal(results.length, 10);
  assert.equal(results.filter((r) => !r.ok).length, 5);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.summary === 'denied'));
  const result = of(events, 'result')[0];
  assert.equal(result.ok, true);
  assert.equal(result.turns, 11);
  assert.equal(of(events, 'error').length, 0);
});

test('denied in default mode and in a project hook run', () => {
  assert.equal(of(run('claude-stream-tools-default-denied.jsonl'), 'denied').length, 6);
  assert.equal(of(run('claude-stream-tools-acceptEdits.jsonl'), 'denied').length, 3);
  assert.equal(of(run('claude-stream-tools-bypassPermissions.jsonl'), 'denied').length, 0);
  assert.equal(of(run('claude-stream-project-hooks.jsonl'), 'denied').length, 1);
});

test('MCP over http and stdio: tool call and its result', () => {
  for (const file of ['claude-stream-mcp-http.jsonl', 'claude-stream-mcp-stdio.jsonl']) {
    const events = run(file);
    assert.equal(of(events, 'init')[0].mcpOk, true);
    assert.deepEqual(of(events, 'tool').map((t) => t.name), ['workshop.board_post']);
    assert.deepEqual(of(events, 'tool_result').map((r) => r.ok), [true]);
    assert.match(of(events, 'tool_result')[0].summary, /posted #1/);
  }
});

test('SIGTERM: no result line, end() makes an error and a failed result with the usage so far', () => {
  const events = run('claude-stream-sigterm.jsonl', { code: null, signal: 'SIGTERM', stderrTail: '' });
  assert.equal(of(events, 'error').length, 1);
  assert.equal(of(events, 'error')[0].kind, 'other');
  assert.match(of(events, 'error')[0].message, /SIGTERM/);
  const result = of(events, 'result');
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, false);
  assert.match(result[0].sessionId, /^[0-9a-f-]{36}$/);
});

test('SIGINT: failed result, no error event (the hub stopped it)', () => {
  const events = run('claude-stream-sigint.jsonl', { code: 0, signal: null });
  assert.equal(of(events, 'result').length, 1);
  assert.equal(of(events, 'result')[0].ok, false);
  assert.equal(of(events, 'error').length, 0);
});

test('several results in one process (background agent, stream input)', () => {
  assert.equal(of(run('claude-stream-subagent-background.jsonl'), 'result').length, 2);
  const three = run('claude-stream-input-three-turns.jsonl');
  assert.equal(of(three, 'result').length, 3);
  assert.equal(of(three, 'init').length, 3);
  const interrupt = run('claude-stream-input-interrupt.jsonl');
  assert.deepEqual(of(interrupt, 'result').map((r) => r.ok), [false, true]);
  assert.equal(of(interrupt, 'error').length, 0);
});

test('max turns and max budget endings are errors', () => {
  const parser = createParser();
  const turnsLine = JSON.stringify(JSON.parse(fs.readFileSync(path.join(FIX, 'claude-json-max-turns.json'), 'utf8')));
  const events = parser.push(turnsLine);
  assert.deepEqual(of(events, 'error'), [{ t: 'error', kind: 'other', message: 'Reached maximum number of turns (3)', resetAt: null }]);
  assert.equal(of(events, 'result')[0].ok, false);
  const budget = createParser().push(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, terminal_reason: 'budget_exhausted', errors: ['Reached maximum budget ($0.04)'], session_id: 's', usage: {}, num_turns: 2 }));
  assert.equal(of(budget, 'error')[0].message, 'Reached maximum budget ($0.04)');
});

const init = (extra = {}) => JSON.stringify({ type: 'system', subtype: 'init', cwd: '/w', session_id: 'aaaaaaaa-0000-4000-8000-000000000001', model: 'claude-sonnet-5-5', mcp_servers: [{ name: 'shop', status: 'connected' }], ...extra });
const retry = (attempt, error, status) => JSON.stringify({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: status, error });
const apiError = (text, error) => JSON.stringify({ type: 'assistant', message: { id: 'x', model: '<synthetic>', content: [{ type: 'text', text }] }, error, is_api_error_message: true });
const failed = (text, status = null) => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: status, terminal_reason: 'api_error', result: text, session_id: 'aaaaaaaa-0000-4000-8000-000000000001', usage: {}, num_turns: 1, duration_ms: 5 });

test('MCP server not connected in init: mcpOk false and an mcp error', () => {
  for (const extra of [
    { mcp_servers: [{ name: 'shop', status: 'failed' }] },
    { mcp_servers: [{ name: 'shop', status: 'pending' }] },
    { mcp_servers: [], mcp_server_errors: [{ name: 'shop', type: 'url_missing_type', message: 'x' }] },
  ]) {
    const events = createParser().push(init(extra));
    assert.equal(events[0].mcpOk, false);
    assert.equal(events[1].t, 'error');
    assert.equal(events[1].kind, 'mcp');
    assert.match(events[1].message, /shop/);
  }
});

test('rate limit: a retry storm counts only when it ends in failure', () => {
  const ok = createParser();
  const okEvents = [init(), retry(1, 'rate_limit', 429), retry(2, 'rate_limit', 429), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fine', session_id: 's', usage: {}, num_turns: 1 })].flatMap((l) => ok.push(l));
  assert.equal(of(okEvents, 'error').length, 0);

  const bad = createParser();
  const badEvents = [init(), retry(1, 'rate_limit', 429), retry(10, 'rate_limit', 429), failed('API Error: Repeated 529 Overloaded errors')].flatMap((l) => bad.push(l));
  assert.equal(of(badEvents, 'error').length, 1);
  assert.equal(of(badEvents, 'error')[0].kind, 'rate_limit');

  const died = createParser();
  const diedEvents = [init(), retry(1, 'rate_limit', 429)].flatMap((l) => died.push(l));
  assert.equal(of(diedEvents, 'error').length, 0);
});

test('rate limit: 429 with rejected status, and limit texts with a reset time', () => {
  const p1 = createParser();
  const e1 = [init(), apiError('API Error: Request rejected (429) · this may be a temporary capacity issue', 'rate_limit'), failed('API Error: Request rejected (429)', 429)].flatMap((l) => p1.push(l));
  assert.deepEqual(of(e1, 'error').map((e) => e.kind), ['rate_limit']);

  const now = new Date(2026, 10, 15, 10, 0, 0).getTime();
  const p2 = createParser({ now: () => now });
  const e2 = [init(), apiError("You've hit your session limit · resets 3:45pm", 'rate_limit'), failed("You've hit your session limit · resets 3:45pm")].flatMap((l) => p2.push(l));
  const err = of(e2, 'error');
  assert.equal(err.length, 1);
  assert.equal(err[0].kind, 'rate_limit');
  assert.equal(err[0].resetAt, new Date(2026, 10, 15, 15, 45, 0).getTime());

  const p3 = createParser({ now: () => now });
  const e3 = [init(), failed("You've hit your weekly limit · resets Mon 12:00am")].flatMap((l) => p3.push(l));
  assert.equal(of(e3, 'error')[0].kind, 'rate_limit');
  assert.equal(of(e3, 'error')[0].resetAt, new Date(2026, 10, 16, 0, 0, 0).getTime());

  const p4 = createParser();
  const e4 = [init(), JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }), failed('API Error: 429', 429)].flatMap((l) => p4.push(l));
  assert.equal(of(e4, 'error')[0].kind, 'rate_limit');
  assert.equal(of(e4, 'error')[0].resetAt, 1900000000000);
});

test('a 401 retry storm becomes one auth error after three tries', () => {
  const parser = createParser();
  const events = [init(), retry(1, 'authentication_failed', 401), retry(2, 'authentication_failed', 401), retry(3, 'authentication_failed', 401), retry(4, 'authentication_failed', 401)].flatMap((l) => parser.push(l));
  assert.deepEqual(of(events, 'error').map((e) => e.kind), ['auth']);
  const after = parser.push(failed('Failed to authenticate. API Error: 401'));
  assert.equal(of(after, 'error').length, 0, 'no second error for the same turn');
  assert.equal(of(after, 'result')[0].ok, false);
});

test('malformed lines and unknown types are ignored', () => {
  const parser = createParser();
  for (const line of ['', '   ', 'not json', '{"type":', '[1,2]', 'null', '42', '{"type":"future_thing","x":1}', '{"type":"system","subtype":"new_subtype"}',
    '{"type":"assistant"}', '{"type":"assistant","message":{"content":"text"}}', '{"type":"user","message":{"content":"plain"}}',
    '{"type":"assistant","message":{"content":[null,{"type":"thinking","thinking":"x"},{"type":"tool_use"}]}}', '{"type":"stream_event","event":{}}',
    '{"type":"control_request","request_id":"1","request":{"subtype":"can_use_tool"}}']) {
    const events = parser.push(line);
    assertNorm(events);
  }
  assert.deepEqual(parser.push(undefined), []);
  assert.deepEqual(parser.push(null), []);
  assert.deepEqual(parser.push(Buffer.from('x')), []);
});

test('end() after a death without a result uses stderr', () => {
  const p1 = createParser();
  const e1 = p1.end({ code: 1, signal: null, stderrTail: 'warning: something\nError: Session ID 123 is already in use.\n' });
  assert.deepEqual(e1.map((e) => e.t), ['error', 'result']);
  assert.equal(e1[0].kind, 'other');
  assert.match(e1[0].message, /already in use/);

  const p2 = createParser();
  p2.push(init());
  p2.push(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 9 } } }));
  p2.push(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 99' } }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 9 } } }));
  const e2 = p2.end({ code: 1, signal: null, stderrTail: 'Not logged in · Please run /login' });
  assert.deepEqual(e2.map((e) => e.t), ['usage', 'error', 'result']);
  assert.deepEqual(e2[0], { t: 'usage', inTok: 5, outTok: 7, cacheRead: 100, cacheWrite: 9, usd: null });
  assert.equal(e2[1].kind, 'auth');
  assert.equal(e2[2].sessionId, 'aaaaaaaa-0000-4000-8000-000000000001');

  const p3 = createParser();
  assert.match(p3.end({ code: 137, signal: null, stderrTail: '' })[0].message, /exit code 137/);
  assert.deepEqual(createParser().end().map((e) => e.t), ['error', 'result']);
});

test('classify: limit and sign-in texts', () => {
  const now = new Date(2026, 10, 15, 10, 0, 0).getTime(); // a Sunday, 10:00 local time
  const limit = [
    "You've hit your session limit · resets 3:45pm",
    "You've hit your weekly limit · resets Mon 12:00am",
    "You've hit your Opus limit · resets 3:45pm",
    'You’ve hit your monthly spend limit · raise it in settings',
    'API Error: Request rejected (429) · this may be a temporary capacity issue',
    'API Error: Server is temporarily limiting requests (not your usage limit)',
    'Credit balance is too low',
  ];
  for (const text of limit) assert.equal(classify(text, now).kind, 'rate_limit', text);
  const auth = ['Not logged in · Please run /login', 'Failed to authenticate. API Error: 403 forbidden', 'Invalid API key · Fix external API key', 'OAuth token has expired'];
  for (const text of auth) assert.equal(classify(text, now).kind, 'auth', text);
  for (const text of ['API Error: 400 mock invalid request', 'done', '', null, undefined, 42]) assert.equal(classify(text, now).kind, null);
  assert.equal(classify(limit[0], now).resetAt, new Date(2026, 10, 15, 15, 45).getTime());
  assert.equal(classify(limit[4], now).resetAt, null);
  assert.ok(classify('x'.repeat(5000), now).message.length <= 300);
});

test('parseResetAt: clock times, weekdays, dates, durations', () => {
  const now = new Date(2026, 10, 15, 10, 0, 0).getTime(); // Sunday
  const at = (...a) => new Date(...a).getTime();
  assert.equal(parseResetAt('resets 3:45pm', now), at(2026, 10, 15, 15, 45));
  assert.equal(parseResetAt('resets 9am', now), at(2026, 10, 16, 9, 0), 'a time that passed today means tomorrow');
  assert.equal(parseResetAt('resets 12:00am', now), at(2026, 10, 16, 0, 0));
  assert.equal(parseResetAt('resets 12:30pm', now), at(2026, 10, 15, 12, 30));
  assert.equal(parseResetAt('resets at 15:45', now), at(2026, 10, 15, 15, 45));
  assert.equal(parseResetAt('resets Mon 12:00am', now), at(2026, 10, 16, 0, 0));
  assert.equal(parseResetAt('resets Sun 9am', now), at(2026, 10, 22, 9, 0), 'the same weekday in the past means next week');
  assert.equal(parseResetAt('resets Sun 11pm', now), at(2026, 10, 15, 23, 0));
  assert.equal(parseResetAt('resets Thursday 6:15pm', now), at(2026, 10, 19, 18, 15));
  assert.equal(parseResetAt('resets Nov 20, 9am', now), at(2026, 10, 20, 9, 0));
  assert.equal(parseResetAt('resets Jan 2 at 5pm (America/Chicago)', now), at(2027, 0, 2, 17, 0));
  assert.equal(parseResetAt('Resets in 3h 20m', now), now + 200 * 60_000);
  assert.equal(parseResetAt('retry after 90 seconds', now), now + 90_000);
  assert.equal(parseResetAt('try again in 2 hours and 5 minutes', now), now + 125 * 60_000);
  for (const text of ['no time here', 'resets soon', 'resets 25:00', '', null, undefined]) assert.equal(parseResetAt(text, now), null);
});

test('tool summaries are short, readable, and never hold the full input', () => {
  assert.equal(toolSummary('Edit', { file_path: '/bench/src/a.js', old_string: 'SECRET_OLD', new_string: 'SECRET_NEW' }, '/bench'), 'Edit src/a.js');
  assert.equal(toolSummary('Write', { file_path: '/bench/README.md', content: 'x'.repeat(5000) }, '/bench'), 'Write README.md');
  assert.equal(toolSummary('Read', { file_path: 'docs/a.md' }, '/bench'), 'Read docs/a.md');
  assert.equal(toolSummary('Bash', { command: 'npm test', description: 'run tests' }), 'Bash npm test');
  assert.equal(toolSummary('Bash', { command: 'echo one\necho two' }), 'Bash echo one');
  assert.ok(toolSummary('Bash', { command: 'x'.repeat(1000) }).length <= 85);
  assert.equal(toolSummary('mcp__shop__post', { line: 'DONE T12 tests=41/41: All tests pass. See src/a.js:31.' }), 'shop post DONE T12');
  assert.equal(toolSummary('mcp__shop__post', { line: 'ASK @b1 T12 ttl=10m: Which port?' }), 'shop post ASK @b1 T12');
  assert.equal(toolSummary('mcp__shop__post', { line: 'PASS re:41' }), 'shop post PASS re:41');
  assert.equal(toolSummary('mcp__shop__post', { line: 'INFO #build: The API base path is /v2.' }), 'shop post INFO #build');
  assert.equal(toolSummary('mcp__shop__post', {}), 'shop post');
  assert.equal(toolSummary('mcp__shop__read', { scope: 'T12' }), 'shop read T12');
  assert.equal(toolSummary('mcp__shop__read', {}), 'shop read');
  assert.equal(toolSummary('mcp__shop__plan_submit', { requirements: [1], tasks: [1, 2, 3] }), 'shop plan_submit 3 tasks');
  assert.equal(toolSummary('mcp__shop__req_verify', { results: [1, 2] }), 'shop req_verify 2 results');
  assert.equal(toolSummary('mcp__shop__claim', { paths: ['a', 'b'] }), 'shop claim 2 paths');
  assert.equal(toolSummary('mcp__shop__task_retry', { id: 'T7', note: 'long note '.repeat(50) }), 'shop task_retry T7');
  assert.equal(toolSummary('mcp__shop__job_report', { md: '# big report' }), 'shop job_report');
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com/docs/page?token=abc', prompt: 'p' }), 'WebFetch example.com/docs/page');
  assert.equal(toolSummary('WebSearch', { query: 'node test runner' }), 'WebSearch node test runner');
  assert.equal(toolSummary('Grep', { pattern: 'TODO', path: '.' }), 'Grep TODO');
  assert.equal(toolSummary('Mystery', { a: 1 }), 'Mystery');
  assert.equal(toolSummary('Bash', null), 'Bash');
  assert.equal(toolDisplayName('mcp__shop__post'), 'shop.post');
  assert.equal(toolDisplayName('mcp__work_shop__task_add'), 'work_shop.task_add');
  assert.equal(toolDisplayName('Bash'), 'Bash');
});

// ------------------------------------------------------------------------------------------- the real run
// Streams of one real signed-in run (CLI 2.1.289, subscription, claude-haiku-5-5; paths made neutral).

test('real subscription stream: tools, a rate_limit_event, cache write split, context window', () => {
  const events = run('claude-worker-turn1.real.jsonl');
  assertNorm(events);
  assert.deepEqual(events.map((e) => e.t), ['init', 'ctx', 'tool', 'tool_result', 'tool', 'limit', 'tool_result', 'ctx', 'text', 'usage', 'ctx', 'result']);
  assert.deepEqual(events[0], {
    t: 'init', sessionId: '6ecfd97b-9ff9-4283-a5e1-9c97c374403e', model: 'claude-haiku-5-5', mcpOk: true,
    loaded: ['shop', 'cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-plugin-authoring'], // every MCP server and plugin
  });
  assert.deepEqual(of(events, 'tool'), [{ t: 'tool', name: 'Write', summary: 'Write hello.txt' }, { t: 'tool', name: 'shop.board_post', summary: 'shop board_post' }]);
  // resetsAt comes in epoch seconds. The status 'allowed' is no error.
  assert.deepEqual(of(events, 'limit'), [{ t: 'limit', status: 'allowed', type: 'seven_day', utilization: 0.11, resetAt: 1794988800 * 1000, overage: false }]);
  assert.equal(of(events, 'error').length, 0);
  // The whole cache write of this turn has the one-hour lifetime: it costs twice the input price.
  assert.deepEqual(of(events, 'usage'), [{ t: 'usage', inTok: 4, outTok: 334, cacheRead: 11935, cacheWrite: 12549, usd: 0.10947499999999999, cacheWrite1h: 12549 }]);
  // Context: the latest call read 11935 tokens from the cache, wrote 614 and had 2 fresh input tokens.
  assert.deepEqual(of(events, 'ctx').at(-1), { t: 'ctx', tokens: 2 + 614 + 11935, max: 200000 });
  assert.deepEqual(events.at(-1), { t: 'result', ok: true, text: 'done', sessionId: '6ecfd97b-9ff9-4283-a5e1-9c97c374403e', usd: 0.10947499999999999, turns: 3, durationMs: 2986 });

  const second = run('claude-worker-turn2.real.jsonl');
  assertNorm(second);
  assert.deepEqual(of(second, 'usage'), [{ t: 'usage', inTok: 2, outTok: 7, cacheRead: 12549, cacheWrite: 45, usd: 0.11249279999999999, cacheWrite1h: 45 }]);
  assert.equal(second.at(-1).sessionId, events.at(-1).sessionId, 'the resumed turn keeps the session');
});

test('rate_limit_event: every status is reported; only a refusing status sets the reset time of the error', () => {
  const event = (info) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
  const p = createParser();
  assert.deepEqual(p.push(event({ status: 'allowed_warning', resetsAt: 1900000000, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.92, resetsAt: 1900000000 } }, isUsingOverage: false })),
    [{ t: 'limit', status: 'allowed_warning', type: 'five_hour', utilization: 0.92, resetAt: 1900000000000, overage: false }]);
  // a warning is not a refusal: a later 429 without a reset text gets no reset time from it
  const warned = p.push(failed('API Error: 429', 429));
  assert.deepEqual(of(warned, 'error').map((e) => [e.kind, e.resetAt]), [['rate_limit', null]]);

  const q = createParser();
  // no init yet: the parser does not know the model, so the opus limit cannot name one
  assert.deepEqual(q.push(event({ status: 'rejected', resetsAt: 1900000000, rateLimitType: 'seven_day_opus', isUsingOverage: true })),
    [{ t: 'limit', status: 'rejected', type: 'seven_day_opus', utilization: null, resetAt: 1900000000000, overage: true }]);
  assert.deepEqual(of(q.push(failed('API Error: 429', 429)), 'error').map((e) => [e.kind, e.resetAt]), [['rate_limit', 1900000000000]]);

  for (const bad of [event(null), event('x'), event({}), event({ status: 5, resetsAt: 'soon' }), JSON.stringify({ type: 'rate_limit_event' })]) {
    const out = createParser().push(bad);
    assertNorm(out);
    assert.ok(out.length <= 1);
  }
  assert.deepEqual(createParser().push(event({ resetsAt: 1900000000000 })), [{ t: 'limit', status: null, type: null, utilization: null, resetAt: 1900000000000, overage: false }], 'milliseconds are kept');
});

test('a note of the CLI on stderr is not taken for the reason of a failure', () => {
  const events = createParser().end({ code: null, signal: 'SIGKILL', stderrTail: '[claude-code:unrecognized_model] {"model":"claude-haiku-5-5","query_source":"sdk"}\n' });
  assert.match(events[0].message, /stopped by SIGKILL without a result/);
  const withReason = createParser().end({ code: 1, signal: null, stderrTail: 'Error: No conversation found with session ID: abc\n[claude-code:unrecognized_model] {"model":"x"}\n' });
  assert.match(withReason[0].message, /No conversation found/);
});

test('parseResetAt: across midnight, weekday names, and a reset time that has just passed', () => {
  const at = (...a) => new Date(...a).getTime();
  const lateSaturday = at(2026, 10, 14, 23, 50, 0); // Saturday 23:50
  assert.equal(parseResetAt('resets 12:00am', lateSaturday), at(2026, 10, 15, 0, 0), 'ten minutes later, on the next day');
  assert.equal(parseResetAt('resets 12:30am', lateSaturday), at(2026, 10, 15, 0, 30));
  assert.equal(parseResetAt('resets 1am', lateSaturday), at(2026, 10, 15, 1, 0));
  assert.equal(parseResetAt('resets Sun 12:00am', lateSaturday), at(2026, 10, 15, 0, 0), 'the weekday is tomorrow');
  assert.equal(parseResetAt('resets Mon 12:00am', lateSaturday), at(2026, 10, 16, 0, 0));
  assert.equal(parseResetAt('resets Sat 11:55pm', lateSaturday), at(2026, 10, 14, 23, 55), 'the same weekday, later today');
  assert.equal(parseResetAt('resets Sat 9am', lateSaturday), at(2026, 10, 21, 9, 0), 'the same weekday, long passed: next week');
  assert.equal(parseResetAt('resets Saturday, 11:55pm', lateSaturday), at(2026, 10, 14, 23, 55));
  assert.equal(parseResetAt('resets Fri 6pm', lateSaturday), at(2026, 10, 20, 18, 0));
  // New Year: Thursday 2026-12-31 23:30
  const newYearsEve = at(2026, 11, 31, 23, 30, 0);
  assert.equal(parseResetAt('resets 12:15am', newYearsEve), at(2027, 0, 1, 0, 15));
  assert.equal(parseResetAt('resets Fri 12:00am', newYearsEve), at(2027, 0, 1, 0, 0));
  assert.equal(parseResetAt('resets Jan 1, 9am', newYearsEve), at(2027, 0, 1, 9, 0));

  // A text names the minute. A message that arrives seconds after that minute must not pause the lab for a day,
  // a week or a year.
  const justAfter = at(2026, 10, 15, 15, 45, 20); // Sunday 15:45:20
  assert.equal(parseResetAt('resets 3:45pm', justAfter), justAfter + 60_000);
  assert.equal(parseResetAt('resets Sun 3:45pm', justAfter), justAfter + 60_000);
  assert.equal(parseResetAt('resets Nov 15, 3:45pm', justAfter), justAfter + 60_000);
  assert.equal(parseResetAt('resets 3:30pm', justAfter), at(2026, 10, 16, 15, 30), 'fifteen minutes ago is yesterday`s time: tomorrow');
  // a year or a clock with seconds is not misread as an hour
  assert.equal(parseResetAt('resets Nov 20, 2026', justAfter), null);
  assert.equal(parseResetAt('resets Nov 20, 2026 at 9am', justAfter), null, 'unknown form: no guess (the caller uses its default pause)');
});

// ------------------------------------------------------------------------------------------- amended contract

const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real');
function runReal(name) {
  const parser = createParser();
  const events = [];
  for (const line of fs.readFileSync(path.join(REAL, name), 'utf8').split('\n')) events.push(...parser.push(line));
  events.push(...parser.end({ code: 0, signal: null, stderrTail: '' }));
  return events;
}

test('real streams (tests/fixtures/real): both Claude worker turns parse exactly', () => {
  const first = runReal('claude-worker-turn1.real.jsonl');
  assertNorm(first);
  assert.deepEqual(first.map((e) => e.t), ['init', 'ctx', 'tool', 'tool_result', 'tool', 'limit', 'tool_result', 'ctx', 'text', 'usage', 'ctx', 'result']);
  assert.deepEqual(first[0].loaded, ['shop', 'cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-plugin-authoring']);
  // rate_limit_event: utilization from unifiedWindows, resetsAt in epoch seconds -> ms; 'allowed' cools nothing.
  assert.deepEqual(of(first, 'limit'), [{ t: 'limit', status: 'allowed', type: 'seven_day', utilization: 0.11, resetAt: 1794988800000, overage: false }]);
  assert.deepEqual(of(first, 'error'), []);
  assert.deepEqual(of(first, 'usage'), [{ t: 'usage', inTok: 4, outTok: 334, cacheRead: 11935, cacheWrite: 12549, usd: 0.10947499999999999, cacheWrite1h: 12549 }]);
  assert.equal(first.at(-1).ok, true);
  const second = runReal('claude-worker-turn2.real.jsonl');
  assertNorm(second);
  assert.deepEqual(second.map((e) => e.t), ['init', 'ctx', 'text', 'limit', 'usage', 'ctx', 'result']);
  assert.deepEqual(of(second, 'ctx').at(-1), { t: 'ctx', tokens: 2 + 45 + 12549, max: 200000 });
  assert.deepEqual([second.at(-1).ok, second.at(-1).text, second.at(-1).sessionId], [true, 'hello.txt', first.at(-1).sessionId]);
});

test('A08: init.loaded names every MCP server and plugin of system/init', () => {
  const init = (extra) => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5-5', mcp_servers: [{ name: 'shop', status: 'connected' }], ...extra });
  assert.deepEqual(createParser().push(init({}))[0].loaded, ['shop']);
  const two = createParser().push(init({ mcp_servers: [{ name: 'shop', status: 'connected' }, { name: 'github', status: 'connected' }], plugins: [{ name: 'evil-plugin', path: '/x' }] }));
  assert.deepEqual(two[0].loaded, ['shop', 'github', 'evil-plugin'], 'a second server and a plugin both show');
  assert.deepEqual(createParser().push(init({ mcp_servers: 'x', plugins: [null, 7, { name: '' }] }))[0].loaded, []);
});

test('A11: error kind "model" for a refused model (recorded against the fake API: 404, model_not_found)', () => {
  // Recorded with the real CLI 2.1.289 against tests/fixtures/mock-anthropic.mjs answering 404 not_found_error.
  const events = run('claude-stream-model-not-found.jsonl', { code: 1, signal: null, stderrTail: '[claude-code:unrecognized_model] {"model":"claude-nonexistent-9"}\n' });
  assertNorm(events);
  const errors = of(events, 'error');
  assert.equal(errors.length, 1);
  assert.deepEqual([errors[0].kind, errors[0].model], ['model', 'claude-nonexistent-9']);
  assert.match(errors[0].message, /issue with the selected model/);
  assert.equal(events.at(-1).ok, false);
  // the same from the result line alone (404 with a model text), and an unknown-model text in a failed result
  const p = createParser();
  p.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-fable-5-2', mcp_servers: [] }));
  assert.deepEqual(of(p.push(failed('model: claude-fable-5-2 is not available on your plan', 404)), 'error').map((e) => [e.kind, e.model]), [['model', 'claude-fable-5-2']]);
  assert.equal(classify('There is an issue with the selected model (x). It may not exist').kind, 'model');
  assert.equal(classify('Invalid model: claude-x').kind, 'model');
  assert.equal(classify('the model wrote a file').kind, null, 'plain words about a model are no model error');
});

test('A11: a per-model limit names the model (rate_limit_event type and error result); a lab limit does not', () => {
  // Synthetic stream in the shape of the real rate_limit_event (no real per-model refusal was recorded).
  const events = run('claude-stream-opus-limit.synthetic.jsonl', { code: 1, signal: null, stderrTail: '' });
  assertNorm(events);
  assert.deepEqual(of(events, 'limit'), [{ t: 'limit', status: 'rejected', type: 'seven_day_opus', utilization: 1, resetAt: 1795000000000, overage: false, model: 'claude-opus-5-5' }]);
  assert.deepEqual(of(events, 'error').map((e) => [e.kind, e.model, e.resetAt]), [['rate_limit', 'claude-opus-5-5', 1795000000000]]);
  // A limit of the whole plan (seven_day, five_hour) names no model.
  const p = createParser();
  p.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', mcp_servers: [] }));
  const lab = p.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1795000000, rateLimitType: 'five_hour' } }));
  assert.equal(lab[0].model, undefined);
  assert.equal(of(p.push(failed('API Error: 429', 429)), 'error')[0].model, undefined);
  // A family that is not the running model names nothing.
  const q = createParser();
  q.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5-5', mcp_servers: [] }));
  assert.equal(q.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus' } }))[0].model, undefined);
  const r = createParser();
  r.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5-5', mcp_servers: [] }));
  assert.deepEqual(of(r.push(failed("You've hit your Sonnet limit · resets 3:45pm", 429)), 'error').map((e) => [e.kind, e.model]), [['rate_limit', 'claude-sonnet-5-5']]);
});
