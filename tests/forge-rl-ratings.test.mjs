// End-to-end unit & contract tests for:
//   1. Closed-source model post-training block (Anthropic, Google, OpenAI blocked from RL Forge & Handbook)
//   2. OpenAI official "Sign in with ChatGPT" (subscription) + API key vs. Anthropic/Google API-key-only
//   3. Universal RL Compute Port (sim + personal git-ignored local/rl-port.mjs adapter + remote cluster config)
//   4. Agent Forge -> RL Pipeline -> Deterministic Verification & QA Gate (passing specialist vs. rejected moron)
//   5. Owner Agent Ratings (+1 ship, -1 deny with reason, 0 neutral discard) & personal local/roster.json isolation
//   6. Consolidated 6-button UI Taskbar & panel exports

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSettings } from '../server/config.js';
import { createHarnesses } from '../server/harnesses.js';
import { createRoster } from '../server/roster.js';
import { createRlPort, isClosedModel, assertOpenWeights } from '../server/rlport.js';
import { createTraining } from '../server/training.js';

function tmpDir(prefix = 'ws-forge-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Closed-source frontier models (Claude, Gemini, OpenAI) are strictly blocked from RL post-training', () => {
  const regModels = [
    { id: 'claude-4.5-sonnet', provider: 'claude' },
    { id: 'gemini-4-carbon-high', provider: 'gemini' },
    { id: 'gpt-6-astra', provider: 'openai' },
    { id: 'qwen3-coder-32b', provider: 'oss' },
  ];
  assert.equal(isClosedModel('claude-4.5-sonnet', regModels), true);
  assert.equal(isClosedModel('gemini-4-carbon-high', regModels), true);
  assert.equal(isClosedModel('gpt-6-astra', regModels), true);
  assert.equal(isClosedModel('o3-pro', regModels), true);
  assert.equal(isClosedModel('qwen3-coder-32b', regModels), false);
  assert.equal(isClosedModel('deepseek-r1-32b', regModels), false);

  for (const closed of ['claude-4.5-sonnet', 'gemini-4-carbon-high', 'gpt-6-astra', 'o3-mini']) {
    assert.throws(() => assertOpenWeights(closed, regModels), /Closed-source model|cannot be post-trained/i);
  }
  assert.equal(assertOpenWeights('qwen3-coder-32b', regModels), 'qwen3-coder-32b');
});

test('OpenAI allows official Sign in with ChatGPT ("subscription") and "apikey", while Anthropic and Google reject subscription mirroring', () => {
  const dir = tmpDir('ws-auth-policy-');
  try {
    const cfgDir = path.join(dir, 'config');
    const s = createSettings({ configDir: cfgDir });

    // OpenAI supports official SIWC subscription portal AND apikey
    s.update({ auth: { openai: 'subscription' } });
    assert.equal(s.get().auth.openai, 'subscription');
    s.update({ auth: { openai: 'apikey' } });
    assert.equal(s.get().auth.openai, 'apikey');

    // Arbitrary "oauth" string is rejected
    assert.throws(() => s.update({ auth: { openai: 'oauth' } }), { status: 400 });

    // Anthropic and Google reject subscription / OAuth mirroring
    assert.throws(() => s.update({ auth: { claude: 'subscription' } }), { status: 400 });
    assert.throws(() => s.update({ auth: { gemini: 'subscription' } }), { status: 400 });
    s.update({ auth: { claude: 'apikey', gemini: 'apikey' } });
    assert.equal(s.get().auth.claude, 'apikey');
    assert.equal(s.get().auth.gemini, 'apikey');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Employee Handbook rejects untrained slop and closed-source brains; writes personal updates to local/roster.json without dirtying config/roster.json', () => {
  const dir = tmpDir('ws-handbook-');
  try {
    const cfgDir = path.join(dir, 'config');
    const localDir = path.join(dir, 'local');
    const roster = createRoster({ configDir: cfgDir, localDir });

    // 1. Closed-source brain rejected
    assert.throws(
      () => roster.upsert({ id: 'spec-bad', name: 'Bad', role: 'maker', baseModel: 'gpt-6-astra', harnessId: 'fullstack-node', certification: 'curated' }),
      /Closed-source|open-weight/i,
    );

    // 2. Untrained new agent rejected when requireExistingOrCertified is true (the API contract)
    assert.throws(
      () => roster.upsert(
        { id: 'spec-slop', name: 'SlopBot', role: 'maker', baseModel: 'qwen3-coder-32b', harnessId: 'fullstack-node', specialties: ['backend'], certification: 'base_untrained' },
        { requireExistingOrCertified: true },
      ),
      /RL|certified|slop|Untrained/i,
    );

    // 3. Certified agent persists to git-ignored local/roster.json while leaving config/roster.json untouched
    const saved = roster.upsert(
      {
        id: 'spec-gauss',
        name: 'Gauss',
        role: 'maker',
        title: 'Numeric & Graph Specialist',
        baseModel: 'deepseek-r1-32b',
        checkpoint: 'oss://deepseek-r1-32b-algo-rl-v1',
        harnessId: 'fullstack-node',
        tools: ['read_file', 'edit_file', 'run_shell', 'shop_mcp'],
        specialties: ['algo'],
        certification: 'curated',
        benchmark: { evalScore: 91.2, passAt1: 0.88, portMode: 'local', verifiedAt: 1700000000000 },
      },
      { requireExistingOrCertified: true },
    );
    assert.equal(saved.id, 'spec-gauss');
    assert.equal(saved.benchmark.evalScore, 91.2);
    assert.deepEqual(saved.tools, ['read_file', 'edit_file', 'run_shell', 'shop_mcp']);
    assert.equal(fs.existsSync(path.join(localDir, 'roster.json')), true, 'saved to git-ignored local/roster.json');
    assert.equal(fs.existsSync(path.join(cfgDir, 'roster.json')), false, 'public config/roster.json was never written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent Forge -> Universal RL Port ([SIM] & custom local/rl-port.mjs) -> Verification & QA Gate enrolls competent agents and blocks morons', async () => {
  const dir = tmpDir('ws-rl-pipeline-');
  try {
    const cfgDir = path.join(dir, 'config');
    const dataDir = path.join(dir, 'data');
    const localDir = path.join(dir, 'local');
    fs.mkdirSync(localDir, { recursive: true });

    let currentPortMode = 'sim';
    const harnesses = createHarnesses({ configDir: cfgDir, localDir });
    const roster = createRoster({ configDir: cfgDir, localDir });
    const rlPort = createRlPort({
      localDir,
      getSettings: () => ({ rlPort: { mode: currentPortMode, localUrl: 'http://127.0.0.1:8788', remoteUrl: '', providerHint: 'local-gpu' } }),
    });
    const training = createTraining({ dataDir, harnesses, roster, rlPort });

    // Closed-source model blocked at Forge entry
    await assert.rejects(
      () => training.forge({ suggestedName: 'Nope', candidateBaseModel: 'claude-4.5-sonnet', harnessId: 'fullstack-node', domain: 'backend' }),
      /Closed-source/i,
    );

    // 1. Forge an open-weight agent in [SIM] mode and poll through RL + QA Gate -> Enrolled as sim_trained!
    const forged = await training.forge({
      suggestedName: 'Noether',
      title: 'Algebraic Backend Specialist',
      candidateBaseModel: 'qwen3-coder-32b',
      harnessId: 'fullstack-node',
      tools: ['read_file', 'write_file', 'edit_file', 'run_shell', 'shop_mcp'],
      specialties: ['backend', 'algo'],
      domain: 'algo',
    });
    assert.equal(forged.status, 'training');

    let latest = forged;
    for (let step = 0; step < 6 && latest.status === 'training'; step++) {
      latest = await training.pollRun(forged.id);
    }
    assert.equal(latest.status, 'enrolled');
    assert.equal(latest.qaReport.passed, true);
    assert.ok(latest.enrolledRosterId);

    const noether = roster.get(latest.enrolledRosterId);
    assert.ok(noether);
    assert.equal(noether.certification, 'sim_trained', '[SIM] runs are badged sim_trained, never silently marked production-curated');
    assert.ok(noether.benchmark.evalScore >= 75);

    // Also verify match() certification filtering: real runs exclude sim_trained, stand-in runs include sim_trained
    const realMatch = roster.match({ domain: 'algo', role: 'maker', certifiedOnly: true, allowSim: false });
    assert.equal(realMatch.certified, false, 'sim_trained excluded when allowSim is false');
    const simMatch = roster.match({ domain: 'algo', role: 'maker', certifiedOnly: true, allowSim: true });
    assert.equal(simMatch.certified, true, 'sim_trained matched in stand-in/sim mode');
    assert.equal(simMatch.entry?.id, noether.id);

    // 2. Wire a personal local/rl-port.mjs adapter: rejects a "piping moron" (evalScore 41, sandbox escape) and enrolls a 92.5 GPU pass!
    currentPortMode = 'local';
    fs.writeFileSync(
      path.join(localDir, 'rl-port.mjs'),
      `export default {
        async probe() { return { ok: true, backend: 'custom-mlx-gpu', gpus: ['Apple M3 Max 64GB'] }; },
        async startJob(bundle) {
          return { remoteJobId: bundle.agentName === 'MoronBot' ? 'moron_1' : 'good_1', mode: 'local', simulated: false };
        },
        async pollJob(id) {
          if (id.includes('moron')) {
            return {
              status: 'completed', step: 100, totalSteps: 100,
              checkpointUri: 'oss://moron-ckpt-v1',
              metrics: { evalScore: 41.0, passAt1: 0.32, sandboxViolations: 2, hubPathTouches: 0, toolCompliance: 0.95 },
            };
          }
          return {
            status: 'completed', step: 100, totalSteps: 100,
            checkpointUri: 'oss://hopper-gpu-ckpt-v1',
            metrics: { evalScore: 92.5, passAt1: 0.91, sandboxViolations: 0, hubPathTouches: 0, toolCompliance: 0.98 },
          };
        }
      };\n`,
      'utf8',
    );

    const probe = await rlPort.probe();
    assert.equal(probe.ok, true);
    assert.equal(probe.backend, 'custom-mlx-gpu');

    const moronReq = await training.forge({
      suggestedName: 'MoronBot',
      candidateBaseModel: 'qwen3-coder-32b',
      harnessId: 'fullstack-node',
      domain: 'backend',
    });
    const moronAfter = await training.pollRun(moronReq.id);
    assert.equal(moronAfter.status, 'rejected_qa', 'piping moron is blocked at Verification & QA');
    assert.equal(moronAfter.qaReport.passed, false);
    assert.equal(moronAfter.enrolledRosterId, null);
    assert.equal(roster.list().some((e) => e.name === 'MoronBot'), false, 'MoronBot never enters the Employee Handbook');

    // Test real GPU pass -> curated certification!
    const hopperReq = await training.forge({
      suggestedName: 'Hopper',
      candidateBaseModel: 'deepseek-r1-32b',
      harnessId: 'fullstack-node',
      domain: 'algo',
    });
    const hopperAfter = await training.pollRun(hopperReq.id);
    assert.equal(hopperAfter.status, 'enrolled');
    const hopper = roster.get(hopperAfter.enrolledRosterId);
    assert.equal(hopper.certification, 'curated', 'real local GPU RL pass earns curated certification');
    assert.equal(hopper.benchmark.evalScore, 92.5);
    const prodMatch = roster.match({ domain: 'algo', role: 'maker', certifiedOnly: true, allowSim: false });
    assert.equal(prodMatch.certified, true);
    assert.equal(prodMatch.entry?.id, hopper.id, 'Hopper staffs real production runs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Owner Agent Ratings: +1 on ship, -1 on deny with reason, 0 on neutral discard, preserving entry.record', () => {
  const dir = tmpDir('ws-ratings-');
  try {
    const cfgDir = path.join(dir, 'config');
    const localDir = path.join(dir, 'local');
    const roster = createRoster({ configDir: cfgDir, localDir });
    const target = roster.list()[0];
    assert.ok(target);

    // +1 Ship
    const r1 = roster.recordRating(target.id, { delta: 1, outcome: 'shipped', jobId: 'J1', taskId: 'T1', deliveryId: 'D1', note: 'Shipped cleanly to main' });
    assert.equal(r1.ratings.score, 1);
    assert.equal(r1.ratings.shipped, 1);
    assert.equal(r1.ratings.denied, 0);
    assert.equal(r1.ratings.discarded, 0);

    // +1 Ship again
    const r2 = roster.recordRating(target.id, { delta: 1, outcome: 'shipped', jobId: 'J1', taskId: 'T2', deliveryId: 'D2', note: 'Shipped crate 2' });
    assert.equal(r2.ratings.score, 2);
    assert.equal(r2.ratings.shipped, 2);

    // -1 Denied with owner reason
    const r3 = roster.recordRating(target.id, { delta: -1, outcome: 'denied', jobId: 'J2', taskId: 'T4', deliveryId: 'D5', note: 'Broke pagination on empty search' });
    assert.equal(r3.ratings.score, 1);
    assert.equal(r3.ratings.denied, 1);
    assert.equal(r3.ratings.history[0].delta, -1);
    assert.equal(r3.ratings.history[0].note, 'Broke pagination on empty search');

    // 0 Neutral Discard (owner mistake / unwanted feature)
    const r4 = roster.recordRating(target.id, { delta: 0, outcome: 'discarded', jobId: 'J3', taskId: 'T1', deliveryId: 'D7', note: 'Discarded without shipping (wrong prompt)' });
    assert.equal(r4.ratings.score, 1, 'neutral discard does not change net score');
    assert.equal(r4.ratings.discarded, 1);
    assert.deepEqual(r4.record, target.record, 'automated task record stays untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Top taskbar PANELS registers the exact 6 consolidated items in order and all UI panel modules load cleanly', async () => {
  globalThis.location = { hash: '', pathname: '/', search: '', href: 'http://127.0.0.1/' };
  globalThis.history = { replaceState() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { hidden: false, addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, append() {}, addEventListener() {} }), createTextNode: (t) => ({ textContent: t }), createDocumentFragment: () => ({ append() {} }) };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  const { PANELS } = await import('../ui/panels/index.js');
  assert.deepEqual(
    PANELS.map((p) => p.id),
    ['workorder', 'board', 'blueprint', 'truck', 'crew', 'settings'],
  );
  for (const p of PANELS) {
    assert.equal(typeof p.render, 'function', `panel ${p.id} has render()`);
  }
});
