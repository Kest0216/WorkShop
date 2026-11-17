#!/usr/bin/env node
// A tiny hub for tests/providers.adversarial.test.mjs: it starts one agent turn (a stubborn agent with a child
// in another process group) and then ends in the way the test asks for.
// usage: node hub-exit.mjs <exit|throw|sigterm|hang> <dir>     (hang: wait for the test to kill this hub with SIGKILL)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../../server/runner.js';
import { createStore } from '../../server/store.js';
import { createMcp } from '../../server/mcp.js';
import { createParser } from '../../server/providers/mock.js';

const [how = 'exit', dir = '.'] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, 'adversarial-agent.mjs');
const work = path.join(dir, 'work');
fs.mkdirSync(work, { recursive: true });

const store = createStore({ dataDir: path.join(dir, 'data') });
const mcp = createMcp({ store });
const adapter = {
  id: 'fake',
  buildRun: (o) => ({ cmd: process.execPath, args: [AGENT, 'detached-stubborn', work, o.agent.id], env: { PATH: '/usr/bin:/bin' }, cwd: o.cwd, stdin: o.prompt, stopSignal: 'SIGINT', files: [] }),
  createParser: () => createParser(),
};
const providers = { get: () => adapter, usable: () => true, status: () => ({ installed: true, usable: true }), keyEnv: async () => ({}), cool() {}, markAuth() {} };
const settings = { limits: { maxAgents: 2 }, auth: { fake: 'subscription' } };
const runner = createRunner({
  store, providers, mcp, getSettings: () => settings, getMcpUrl: () => 'http://127.0.0.1:1/mcp',
  paths: { server: path.join(HERE, '..', '..', 'server'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs'), config: path.join(dir, 'config') },
  tuning: { minSpawnGapMs: 0, killGraceMs: 300, shutdownGraceMs: 200, closeWaitMs: 300, treeScanMs: 200 },
});
store.put('agents', { id: 'H1', jobId: null, role: 'maker', provider: 'fake', model: 'x', sessionId: null, stats: {} });
runner.run('H1', { prompt: 'work', systemPrompt: 'role', cwd: work });

const pidIn = (name) => { try { return Number(fs.readFileSync(path.join(work, name), 'utf8')); } catch { return 0; } };
const ready = () => pidIn('H1.pid') > 1 && pidIn('H1.child.pid') > 1; // the files exist AND hold their pids
const wait = setInterval(() => {
  if (!ready()) return;
  clearInterval(wait);
  if (how === 'exit') process.exit(0); // no shutdown() call at all
  if (how === 'throw') setTimeout(() => { throw new Error('the hub crashed on purpose'); }, 0);
  if (how === 'sigterm') {
    process.on('SIGTERM', async () => {
      await runner.shutdown();
      await store.flush();
      process.exit(0);
    });
    process.stdout.write('READY\n');
  }
  if (how === 'hang') process.stdout.write('READY\n');
}, 25);
