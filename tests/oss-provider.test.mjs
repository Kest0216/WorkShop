import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createApp } from '../server/index.js';
import { createOssAdapter, probeEndpoint } from '../server/providers/oss.js';
import { resolveBenchPath } from '../server/providers/oss-agent.mjs';
import { createClaudeAdapter } from '../server/providers/claude.js';
import { createGeminiAdapter } from '../server/providers/gemini.js';
import { createMockAdapter } from '../server/providers/mock.js';
import { createShellEnv } from '../server/shellenv.js';
import { createHarnesses } from '../server/harnesses.js';

function tmpWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-oss-prov-'));
  const cwd = path.join(root, 'bench');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  return { root, cwd, runDir };
}

function runSpec(spec) {
  for (const f of spec.files || []) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content);
  }
  return new Promise((resolve, reject) => {
    const child = execFile(spec.cmd, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
    if (child.stdin) child.stdin.end(spec.stdin || '');
  });
}

test('resolveBenchPath confines writes inside the bench and protects .shop/.git/symlinks', () => {
  const { root, cwd } = tmpWorkspace();
  const outside = path.join(root, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  try {
    assert.equal(resolveBenchPath(cwd, 'src/app.js', { write: true }).rel, 'src/app.js');
    assert.throws(() => resolveBenchPath(cwd, '../secret.txt', { write: true }), /escapes the bench/);
    assert.throws(() => resolveBenchPath(cwd, outside, { write: true }), /relative to the bench/);
    assert.throws(() => resolveBenchPath(cwd, '.shop/HARNESS.md', { write: true }), /hub-owned/);
    assert.throws(() => resolveBenchPath(cwd, '.git/HEAD', { write: true }), /hub-owned/);
    assert.throws(() => resolveBenchPath(cwd, '.agents/hooks.json', { write: true }), /hub-owned/);

    fs.symlinkSync(outside, path.join(cwd, 'escape-link.txt'));
    assert.throws(() => resolveBenchPath(cwd, 'escape-link.txt', { write: false }), /Symlink escapes bench/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Frontier adapters restrict policyNote to apikey and disable loginCommand', () => {
  const fakeEnv = { base: () => ({ PATH: process.env.PATH }) };
  const claude = createClaudeAdapter({ shellEnv: fakeEnv });
  const gemini = createGeminiAdapter({ shellEnv: fakeEnv });
  assert.equal(claude.loginCommand(), null);
  assert.equal(gemini.loginCommand(), null);
  assert.deepEqual(Object.keys(claude.policyNote()), ['apikey']);
  assert.deepEqual(Object.keys(gemini.policyNote()), ['apikey']);
});

test('OSS Stand-in turn writes HARNESS.md in hubFiles, emits $0 NormEvents, and posts to MCP', async () => {
  const { root, cwd, runDir } = tmpWorkspace();
  const rack = createHarnesses({ configDir: path.join(root, 'cfg') });
  const harness = rack.get('fullstack-node');
  const mcpCalls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      mcpCalls.push({ method: body.method, params: body.params });
      let result = {};
      if (body.method === 'tools/list') {
        result = { tools: [{ name: 'post', description: 'Post to ShopTalk', inputSchema: { type: 'object' } }] };
      } else if (body.method === 'tools/call') {
        result = { content: [{ type: 'text', text: '{"ok":true}' }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });

  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const adapter = createOssAdapter({
      shellEnv: { base: () => ({ PATH: process.env.PATH }) },
      getSettings: () => ({ oss: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', standIn: true } }),
    });
    const spec = adapter.buildRun({
      agent: { id: 'A5', handle: '@m1', role: 'maker', name: 'Sprocket' },
      model: 'qwen3-coder-32b',
      prompt: 'Execute task T1 for Recipe App and post DONE T1.',
      systemPrompt: 'Follow harness.',
      cwd,
      runDir,
      mode: 'standin',
      access: 'write',
      harness,
      mcp: { url: `http://127.0.0.1:${port}/mcp`, token: 'tok-standin' },
    });

    assert.match(spec.hubFiles['.shop/HARNESS.md'], /Fullstack Node & API Rig/);
    const { err, stdout } = await runSpec(spec);
    assert.ifError(err);

    const parser = adapter.createParser();
    const events = [];
    for (const line of stdout.split('\n')) events.push(...parser.push(line));
    events.push(...parser.end({ code: 0, signal: null, stderrTail: '' }));

    const resultEv = events.find((e) => e.t === 'result');
    assert.ok(resultEv?.ok);
    assert.equal(resultEv.usd, 0);
    assert.ok(mcpCalls.some((c) => c.method === 'tools/call' && c.params?.name === 'post'));
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OSS OpenAI-compatible HTTP tool loop probes /v1/models and runs write_file + MCP tool calls', async () => {
  const { root, cwd, runDir } = tmpWorkspace();
  const mcpCalls = [];
  let chatTurn = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      if (req.url === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-coder-32b' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        chatTurn += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (chatTurn === 1) {
          res.end(JSON.stringify({
            usage: { prompt_tokens: 100, completion_tokens: 40 },
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'hi oss\n' }) } },
                  { id: 'c2', type: 'function', function: { name: 'shop__post', arguments: JSON.stringify({ line: 'DONE T1 tests=1/1 acc=1/1: Wrote hello.txt.' }) } },
                ],
              },
            }],
          }));
        } else {
          res.end(JSON.stringify({
            usage: { prompt_tokens: 140, completion_tokens: 18 },
            choices: [{ message: { role: 'assistant', content: 'Completed T1 and posted DONE.' } }],
          }));
        }
        return;
      }
      if (req.url.startsWith('/mcp/')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        mcpCalls.push(body);
        const result = body.method === 'tools/list'
          ? { tools: [{ name: 'post', description: 'Post to board', inputSchema: { type: 'object', properties: { line: { type: 'string' } } } }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      res.writeHead(404).end();
    });
  });

  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    const probe = await probeEndpoint({ baseUrl });
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.models, ['qwen3-coder-32b']);

    const adapter = createOssAdapter({
      shellEnv: { base: () => ({ PATH: process.env.PATH }) },
      getSettings: () => ({ oss: { engine: 'vllm', baseUrl, standIn: false } }),
    });
    const spec = adapter.buildRun({
      agent: { id: 'A6', handle: '@m2', role: 'maker', name: 'Rivet' },
      model: 'qwen3-coder-32b',
      prompt: 'Create hello.txt and DONE.',
      cwd,
      runDir,
      mode: 'local',
      access: 'write',
      mcp: { url: `http://127.0.0.1:${port}/mcp`, token: 'tok-local' },
    });

    const { err, stdout } = await runSpec(spec);
    assert.ifError(err);
    assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'hi oss\n');
    assert.ok(mcpCalls.some((c) => c.method === 'tools/call' && c.params?.name === 'post'));

    const parser = adapter.createParser();
    const events = [];
    for (const line of stdout.split('\n')) events.push(...parser.push(line));
    events.push(...parser.end({ code: 0, signal: null, stderrTail: '' }));
    assert.equal(events.find((e) => e.t === 'result')?.ok, true);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Phase 0 full-stack integration: Gemini Boss + OSS Stand-in agent teams + Harness Rack + Employee Book + Phase 1 RFT queue', { timeout: 120_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-phase0-e2e-')));
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  const projectsDir = path.join(root, 'projects');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const agyBin = path.join(binDir, 'agy');
  fs.writeFileSync(agyBin, '#!/bin/sh\necho "gemini-4-carbon-high"\necho "gemini-4-argon-medium"\n', { mode: 0o755 });

  const keysFile = path.join(dataDir, 'keys.json');
  fs.writeFileSync(keysFile, `${JSON.stringify({ gemini: 'AIza-phase0-gemini-key' }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(keysFile, 0o600);

  fs.copyFileSync(path.resolve('config/models.json'), path.join(configDir, 'models.json'));
  fs.copyFileSync(path.resolve('config/harnesses.json'), path.join(configDir, 'harnesses.json'));

  const shippedRoster = JSON.parse(fs.readFileSync(path.resolve('config/roster.json'), 'utf8'));
  const customRoster = {
    ...shippedRoster,
    entries: shippedRoster.entries.map((entry) => ({
      ...entry,
      certification: 'curated',
      specialties: (entry.specialties || []).filter((s) => s !== 'docs'),
    })),
  };
  fs.writeFileSync(path.join(configDir, 'roster.json'), `${JSON.stringify(customRoster, null, 2)}\n`);

  const settingsDoc = {
    mockSpeed: 0,
    safety: 'trusting',
    auth: { claude: null, gemini: 'apikey' },
    authAck: { gemini: { mode: 'apikey', ts: 1 } },
    providers: { gemini: { authOk: true, version: '1.5.1' } },
    oss: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', standIn: true },
  };
  fs.writeFileSync(path.join(configDir, 'settings.json'), `${JSON.stringify(settingsDoc, null, 2)}\n`);

  const shellEnv = createShellEnv({ env: { ...process.env, HOME: root, WORKSHOP_PATH: `${binDir}:/usr/bin:/bin` } });
  const mockAdapter = createMockAdapter({ shellEnv });
  const realOss = createOssAdapter({ shellEnv, getSettings: () => settingsDoc });
  const ossTurns = [];
  const geminiTurns = [];

  const adapters = {
    claude: { ...createClaudeAdapter({ shellEnv }), locate: () => null },
    gemini: {
      ...createGeminiAdapter({ shellEnv }),
      locate: () => agyBin,
      buildRun(o) {
        geminiTurns.push({ role: o.agent?.role, mode: o.mode, model: o.model });
        return mockAdapter.buildRun(o);
      },
      createParser: () => mockAdapter.createParser(),
    },
    oss: {
      ...realOss,
      buildRun(o) {
        const realSpec = realOss.buildRun(o);
        ossTurns.push({
          role: o.agent?.role,
          mode: o.mode,
          harnessId: o.harness?.id ?? null,
          harnessMd: realSpec.hubFiles?.['.shop/HARNESS.md'] ?? null,
        });
        return mockAdapter.buildRun(o);
      },
      createParser: () => mockAdapter.createParser(),
    },
    mock: mockAdapter,
  };

  let app = null;
  t.after(async () => {
    await app?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const stubFetch = async (_url, opts) => {
    const bodyText = String(opts?.body || '');
    if (bodyText.includes('Classify software task complexity')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ size: 'S', sensitive: false, why: 'stub router' }) }] } }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('unavailable', { status: 503 });
  };

  app = await createApp({
    dataDir, configDir, projectsDir, secretsBackend: 'file', adapters, shellEnv, fetchImpl: stubFetch,
    log: () => {}, tickMs: 50, runnerTuning: { minSpawnGapMs: 0 }, orchTuning: { managerDebounceMs: 50, managerMaxDelayMs: 200 },
    pickFolder: async () => null, reveal: async () => {}, power: { hold() {}, release() {} },
  });

  const sessRes = await fetch(`${app.url}/api/session`, {
    method: 'POST',
    headers: { 'x-workshop': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ k: app.ownerKey }),
  });
  assert.equal(sessRes.status, 200);
  const cookie = sessRes.headers.get('set-cookie').split(';')[0];
  const api = async (method, p, body) => {
    const r = await fetch(`${app.url}${p}`, {
      method,
      headers: { cookie, 'x-workshop': '1', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const state = await api('GET', '/api/state');
  assert.equal(state.status, 200);
  const gemProv = state.body.providers.find((p) => p.id === 'gemini');
  const ossProv = state.body.providers.find((p) => p.id === 'oss');
  assert.deepEqual([gemProv.usable, gemProv.mode, ossProv.usable, ossProv.mode], [true, 'apikey', true, 'standin']);

  const brief = 'Build a small Recipe Box CLI in Node. Save recipes to JSON, search by name, verify everything with node:test, and write README documentation.';
  const created = await api('POST', '/api/jobs', {
    title: 'Phase 0 Recipe Box', brief, kind: 'build',
    project: { mode: 'new', name: 'phase0-box' }, crew: 'standard', budgetUsd: 25, options: {},
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const J = created.body.id;

  const waitUntil = async (fn, label, ms = 90_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const val = fn();
      if (val) return val;
      await new Promise((r) => setTimeout(r, 100));
    }
    const j = app.store.get('jobs', J);
    assert.fail(`Timed out waiting for ${label} (status=${j?.status}, pause=${j?.pauseReason}, err=${j?.error})`);
  };

  await waitUntil(() => {
    const j = app.store.get('jobs', J);
    return j?.status === 'delivering' && j?.report ? j : null;
  }, 'delivering with report');

  const agents = app.store.list('agents', (a) => a.jobId === J);
  const bosses = agents.filter((a) => a.role === 'boss');
  const makers = agents.filter((a) => a.role === 'maker');
  const managers = agents.filter((a) => a.role === 'manager');
  assert.ok(bosses.length >= 1 && bosses.every((a) => a.provider === 'gemini'), 'Bosses run on Frontier Gemini');
  assert.ok(makers.length >= 1 && makers.every((a) => a.provider === 'oss'), 'Makers run on Open-Source runtime');
  assert.ok(managers.length >= 1 && managers.every((a) => a.provider === 'oss'), 'Managers run on Open-Source runtime');
  assert.ok(makers.some((a) => a.rosterId && a.harnessId), 'OSS makers carry Employee Book rosterId & harnessId');

  assert.ok(geminiTurns.length >= 1 && geminiTurns.every((x) => x.mode === 'apikey'));
  assert.ok(ossTurns.length >= 1 && ossTurns.every((x) => x.mode === 'standin'));
  assert.ok(ossTurns.some((x) => x.harnessId && typeof x.harnessMd === 'string' && x.harnessMd.includes('# Equipped Harness:')));

  const reqs = app.training.list();
  assert.ok(reqs.some((r) => r.status === 'queued_phase1' && r.domain === 'docs'), `Expected Phase 1 RFT requisition for uncurated docs domain: ${JSON.stringify(reqs)}`);

  const truck = await api('GET', `/api/jobs/${J}/truck`);
  assert.equal(truck.status, 200);
  const ship = await api('POST', `/api/jobs/${J}/ship`, { sha: truck.body.headSha });
  assert.equal(ship.status, 200);
  await waitUntil(() => (app.store.get('jobs', J)?.status === 'done' ? true : null), 'done', 30_000);
  await app.orch.settle?.({ timeoutMs: 30_000 });
});
