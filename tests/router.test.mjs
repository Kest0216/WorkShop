// Tests for server/router.js and for the shipped registry config/models.json.
// Run: node --test tests/router.test.mjs
//
// Four groups:
//   1. The shipped registry config/models.json: shape, the owner's tiering, notes, sample scores.
//      The checks of its content are skipped (not failed) once the file was changed after shipping,
//      for example by a BenchLM refresh or by the owner.
//   2. Picks on the shipped data, each with the numbers that justify it. They run on a copy of the
//      shipped data inside this file (SNAP_*), so they do not depend on the state of config/models.json.
//   3. Every pick rule on small hand-made registries in temp folders.
//   4. registry(), save(), reload().
// No network, no AI CLI, no writes outside temp folders.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRouter, validateRegistry, DOMAINS, ROLES } from '../server/router.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = path.join(ROOT, 'config', 'models.json');
const SHIPPED_TEXT = readFileSync(SHIPPED, 'utf8');
const shipped = () => JSON.parse(SHIPPED_TEXT);

// The file as shipped on 2026-11-15 (BenchLM data of 2026-11-13). A refresh or an edit changes the hash.
const SHIPPED_SHA256 = '0726ab646d1ea9bd444ee2869f04b91390aafc729fc9d9242fcb26ff09f475aa';
const PRISTINE = createHash('sha256').update(SHIPPED_TEXT).digest('hex') === SHIPPED_SHA256;
const onShippedFile = { skip: PRISTINE ? false : 'config/models.json was changed after shipping; this check belongs to the shipped file' };

const NOV_15 = new Date(2026, 10, 15, 12).getTime(); // local time, before the price change of 2026-12-01
const BOTH = ['claude', 'gemini'];

// ---------------------------------------------------------------------------------------------
// The registry as shipped on 2026-11-15 (BenchLM data of 2026-11-13), in compact form.
// Every number is a copy of config/models.json, which is a copy of the research file benchmarks.json.
// ---------------------------------------------------------------------------------------------

const _ = null; // no score found
const E5 = ['low', 'medium', 'high', 'xhigh', 'max'];
const E4 = ['low', 'medium', 'high', 'xhigh'];
const E3 = ['low', 'medium', 'high'];
const E0 = [];
// key: [scale, tie, source, extra]
const SNAP_CATEGORIES = {
  overall: ['0-100', 5, 'BenchLM', { board: 'overall' }],
  agentic: ['0-100', 5, 'BenchLM', { board: 'agentic' }],
  coding: ['0-100', 5, 'BenchLM', { board: 'coding' }],
  reasoning: ['0-100', 5, 'BenchLM', { board: 'reasoning' }],
  multimodalGrounded: ['0-100', 5, 'BenchLM', { board: 'multimodalGrounded' }],
  knowledge: ['0-100', 5, 'BenchLM', { board: 'knowledge' }],
  aaIntelligenceIndex: ['index', 3, 'Artificial Analysis'],
  arenaAgentNetImprovement: ['percent', 5, 'Arena'],
  cursorBench4: ['0-100', 5, 'Cursor via BenchLM'],
  arenaCodingElo: ['elo', 20, 'Arena'],
  terminalBench41: ['0-100', 5, 'tbench.ai via BenchLM'],
  arenaWebDevElo: ['elo', 20, 'Arena'],
  vibeCodeBench: ['0-100', 5, 'Vals AI via BenchLM'],
  designArenaWebsiteElo: ['elo', 20, 'Design Arena via BenchLM'],
  bugHuntBench: ['0-105', 5, 'Bug Hunt Bench via BenchLM'],
  cweBenchV2: ['0-100', 5, 'CWE-bench via BenchLM'],
  aaAnalystAgent: ['0-100', 5, 'Artificial Analysis via BenchLM'],
  frontierMathT13: ['0-100', 5, 'Epoch AI via BenchLM'],
  frontierMathT4: ['0-100', 5, 'Epoch AI via BenchLM'],
  arenaSearchElo: ['elo', 20, 'Arena'],
  aaLcr: ['0-100', 5, 'Artificial Analysis via BenchLM'],
  arenaCreativeWritingElo: ['elo', 20, 'Arena'],
  arenaTextElo: ['elo', 20, 'Arena'],
  osworld21Offline: ['0-100', 5, 'Lab-reported via BenchLM'],
  chartographyNoTools: ['0-100', 5, 'Lab-reported via BenchLM'],
  aaMmmuPro: ['0-100', 5, 'Artificial Analysis via BenchLM'],
  arenaVisionElo: ['elo', 20, 'Arena'],
  codingValueIndex: ['points per USD', 0.5, 'BenchLM'],
  arenaAgentTimePerTaskMin: ['minutes', 0, 'Arena', { lowerIsBetter: true }],
  arenaAgentCostPerTaskUsd: ['usd', 0, 'Arena', { lowerIsBetter: true }],
  speedTokensPerSecond: ['tokens per second', 0, 'Artificial Analysis via BenchLM'],
};
const SNAP_DOMAINS = {
  plan: ['reasoning', 'agentic', 'aaIntelligenceIndex', 'arenaAgentNetImprovement', 'overall'],
  backend: ['coding', 'cursorBench4', 'arenaCodingElo', 'terminalBench41', 'overall'],
  frontend: ['arenaWebDevElo', 'vibeCodeBench', 'designArenaWebsiteElo', 'overall'],
  fix: ['bugHuntBench', 'coding', 'overall'],
  review: ['coding', 'cweBenchV2', 'reasoning', 'overall'],
  test: ['coding', 'cursorBench4', 'terminalBench41', 'overall'],
  data: ['aaAnalystAgent', 'coding', 'overall'],
  algo: ['frontierMathT13', 'frontierMathT4', 'reasoning', 'overall'],
  research: ['agentic', 'arenaSearchElo', 'overall'],
  synthesis: ['aaLcr', 'knowledge', 'overall'],
  docs: ['arenaCreativeWritingElo', 'arenaTextElo', 'overall'],
  vision: ['osworld21Offline', 'multimodalGrounded', 'chartographyNoTools', 'aaMmmuPro', 'arenaVisionElo', 'overall'],
  chore: ['codingValueIndex', 'arenaAgentTimePerTaskMin', 'arenaAgentCostPerTaskUsd', 'speedTokensPerSecond', 'coding', 'overall'],
};
// [id, provider, label, tiers, power, enabled, estimated, [in, out, next from, next in, next out], efforts, scores in key order]
const SNAP_MODELS = [
  ['claude-fable-5-2', 'claude', 'Claude Fable 5.2', ['boss'], 5, true, true, [8, 40], E5,
    [93.65, 90.71, 89.23, 91, 90.43, 98.53, 65, 30.48, 60, _, _, 1838, 93.8, 1341, 58, 75, _, 95.088, 100, _, 83.3, _, _, 89.3, 73.4, _, _, 2.23, 18.6, 8.56, _]],
  ['gemini-4-carbon', 'gemini', 'Gemini 4 Carbon', ['boss'], 5, true, false, [2, 10, '2026-12-01', 4, 20], E3,
    [89.15, 84.61, 83.88, 84.83, _, _, 60, 16.9, 60.4, 1568, _, 1768, 89.1, 1285, 57.3, _, _, 90.526, 95.122, _, 79.3, 1516, 1526, 81.5, 72.5, _, _, 8.39, 9.7, 1.36, 100]],
  ['claude-opus-5-5', 'claude', 'Claude Opus 5.5', ['manager', 'boss'], 4, true, false, [4, 20], E5,
    [86.62, 83.85, 82.6, 80.53, 85.09, 89.76, 59, 19.51, 57.8, 1547, 65.76, 1815, 90.3, 1323, 41.7, 67.1, 56.3, 91.228, 95, 1213, 84.7, 1517, 1507, 87.2, 64.4, 87.7, 1295, 4.13, 4.5, 2.09, 98]],
  ['gemini-4-argon', 'gemini', 'Gemini 4 Argon', ['manager'], 4, true, false, [2, 10, '2026-12-01', 4, 20], E3,
    [79.03, 74.86, 71.8, 76.52, _, 79.22, 50, 10.72, 52.9, 1553, _, 1681, 91.9, 1313, 40.7, 65, 48.8, 85.965, 78.049, _, 79.7, 1523, 1522, 74.7, 71.6, _, _, 7.18, 7.1, 0.69, 83]],
  ['claude-sonnet-5-5', 'claude', 'Claude Sonnet 5.5', ['maker', 'manager'], 3, true, false, [2, 10], E5,
    [83.05, 72.73, 80.97, 76.98, 78.92, 82.07, 55, 16.07, 55.5, 1517, 63.94, 1772, 92.4, 1313, 51.3, _, 57.5, 88.772, 80.488, _, 82.7, 1464, 1473, 83.9, 61.6, _, 1263, 8.1, 2.6, 0.89, 138]],
  ['gemini-4-hydrogen', 'gemini', 'Gemini 4 Hydrogen', ['maker', 'manager'], 3, true, true, [1.5, 7.5], E4,
    [79.06, _, 75.75, _, _, _, 54, 14.8, 54.3, 1518, _, 1704, 87.8, _, 32.7, 68.1, _, _, _, _, _, 1492, 1490, 77.6, 66.6, _, _, 10.1, 5.4, 1.53, _]],
  ['claude-haiku-5-5', 'claude', 'Claude Haiku 5.5', ['maker'], 2, true, false, [0.1, 0.5], E5,
    [67.64, 60.11, 58.93, 58.95, 61.82, 65.22, 36, 0.42, 48.4, 1489, _, 1593, 90.4, 1256, 21.5, _, 53.8, 75.088, 46.341, _, 82.7, _, 1421, 72.4, 46.4, _, _, 117.86, 1.8, 0.08, 241]],
  ['gemini-3.8-flash', 'gemini', 'Gemini 3.8 Flash', ['maker'], 2, false, false, [0.75, 3.75, '2027-01-01', 1.5, 7.5], E3,
    [64.47, 63.55, 55.3, 64.46, 69.87, 68.39, 31, 2.34, _, 1531, 18.2, 1583, _, 1295, 18, _, 46.3, 68.421, 21.951, _, 81.3, 1488, 1497, _, _, 85.6, 1293, 14.73, 8.7, 0.77, 140]],
  ['gemini-3.6-flash', 'gemini', 'Gemini 3.6 Flash', ['maker'], 2, false, false, [0.75, 3.75, '2027-01-01', 1.5, 7.5], E3,
    [62.23, 52.19, 50.79, 55.5, 66.29, 65.08, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, 1471, _, _, _, _, _, 13.54, _, _, 215]],
  ['gemini-3.5-flash-lite', 'gemini', 'Gemini 3.5 Flash-Lite', ['maker'], 1, false, false, [0.3, 2.5], E0,
    [46.95, 34.16, 34.68, 9.09, 51.52, 46.7, 12, _, _, _, _, _, _, _, _, _, _, 25.965, 0, _, 76, _, _, _, _, 79, _, 13.87, _, _, 461]],
  ['gpt-6-astra', 'openai', 'GPT-6 Astra', ['boss'], 5, false, false, [10, 50], E0,
    [85.65, 73.65, 78.7, 81.13, 79.71, 85.47, 57, 14.56, _, 1548, 60.3, 1764, 89.6, _, 45, 64.2, 51.2, 93.684, 97.6, 1231, 80.7, 1451, 1474, _, _, 86.9, 1283, 1.57, 11.2, 5.38, 73]],
  ['gpt-6.1-sol', 'openai', 'GPT-6.1 Sol', ['manager'], 4, false, false, [2, 10], E0,
    [84.6, 65.67, 73.36, 80.43, 78.9, 85.6, 55, 12.4, _, 1540, 60.91, 1743, 88.9, 1308, 44.3, _, 50, 93.684, 100, 1230, 83, 1449, 1481, _, _, 86, 1293, 7.34, 9.2, 1.01, _]],
  ['gpt-6.1-terra', 'openai', 'GPT-6.1 Terra', ['maker'], 3, false, true, [1, 5], E0,
    [79.64, 74.83, 69.79, 75.48, 77.39, 77.45, 51, 11.96, _, _, _, 1678, _, _, _, _, _, 90.877, 92.683, _, 82.7, _, _, 74.2, _, 84.7, _, 13.96, 9.9, 0.88, _]],
  ['gpt-6-luna', 'openai', 'GPT-6 Luna', ['maker'], 2, false, false, [0.1, 0.5], E0,
    [61.13, 54.54, 52.05, 54.3, 63.59, 62.43, 28, 1.52, _, 1501, 15.2, 1577, _, _, 18.3, _, 43.8, 78.947, 56.098, 1160, 83.3, 1408, 1441, 48.9, _, 79.7, 1235, 104.1, 6.1, 0.08, _]],
];

/** The shipped registry, rebuilt from the compact tables above. */
function snapshotRegistry() {
  const keys = Object.keys(SNAP_CATEGORIES);
  return {
    version: 1,
    dataDate: '2026-11-13',
    fetchedAt: '2026-11-15',
    attribution: { text: 'Data from BenchLM.ai', url: 'https://benchlm.ai', license: 'CC BY-NC 4.0' },
    categories: Object.fromEntries(Object.entries(SNAP_CATEGORIES).map(([key, [scale, tie, source, extra]]) => [key, { label: key, scale, tie, source, ...extra }])),
    domains: Object.fromEntries(Object.entries(SNAP_DOMAINS).map(([name, list]) => [name, { label: name, keys: list }])),
    models: SNAP_MODELS.map(([id, provider, label, tiers, power, enabled, estimated, [priceIn, priceOut, from, nextIn, nextOut], efforts, scores]) => ({
      id, provider, label, tiers, power,
      price: { in: priceIn, out: priceOut, note: '', ...(from ? { next: { from, in: nextIn, out: nextOut } } : {}) },
      efforts: [...efforts], enabled, estimated, planNote: '',
      scores: Object.fromEntries(keys.map((key, i) => [key, scores[i]])),
    })),
  };
}

/** What the router reads from a registry: no labels, no notes, no dates. */
function routingData(registry) {
  return {
    categories: Object.fromEntries(Object.entries(registry.categories).map(([key, c]) => [key, [c.scale, c.tie, c.source, c.board ?? null, c.lowerIsBetter === true]])),
    domains: Object.fromEntries(Object.entries(registry.domains).map(([name, d]) => [name, d.keys])),
    models: registry.models.map((m) => [m.id, m.provider, m.label, m.tiers, m.power, m.enabled, m.estimated, m.price.in, m.price.out, m.price.next ?? null, m.efforts, m.scores]),
  };
}

const SNAP_DIR = mkdtempSync(path.join(os.tmpdir(), 'workshop-router-snapshot-'));
const SNAPSHOT = path.join(SNAP_DIR, 'models.json');
writeFileSync(SNAPSHOT, `${JSON.stringify(snapshotRegistry(), null, 2)}\n`);
after(() => rmSync(SNAP_DIR, { recursive: true, force: true }));

/** A router with fake providers and settings, plus everything it logged. */
function makeRouter({ modelsPath = SNAPSHOT, usable = BOTH, thrift = 0.3, settings, now = NOV_15, ...rest } = {}) {
  const logs = [];
  const router = createRouter({
    modelsPath,
    providers: { usable: (id) => usable.includes(id) },
    getSettings: () => settings ?? { thrift },
    log: (level, msg, data) => logs.push({ level, msg, data }),
    now: () => now,
    ...rest,
  });
  return { router, logs };
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workshop-router-'));
  t.after(() => {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A small valid registry. Every domain compares on "overall" unless `domains` says otherwise. */
function tiny(models, { categories, domains } = {}) {
  const cats = categories ?? { overall: { label: 'Overall', scale: '0-100', tie: 5, source: 'Test' } };
  const doms = {};
  for (const name of DOMAINS) doms[name] = { label: name, keys: ['overall'] };
  Object.assign(doms, domains);
  return {
    version: 1,
    dataDate: '2026-11-13',
    fetchedAt: '2026-11-15',
    attribution: { text: 'Data from BenchLM.ai', url: 'https://benchlm.ai', license: 'CC BY-NC 4.0' },
    categories: cats,
    domains: doms,
    models: models.map((model) => ({
      provider: 'claude', label: model.id.toUpperCase(), tiers: ['maker'], power: 3, price: { in: 1, out: 1, note: '' },
      efforts: ['low', 'medium', 'high'], enabled: true, estimated: false, planNote: '', scores: { overall: 50 }, ...model,
    })),
  };
}

/** Writes a registry to a temp folder and returns a router on it. */
function routerFor(t, registry, options = {}) {
  const file = path.join(tempDir(t), 'models.json');
  writeFileSync(file, JSON.stringify(registry, null, 2));
  return { file, ...makeRouter({ modelsPath: file, usable: ['claude', 'gemini', 'openai', 'a', 'b', 'c'], ...options }) };
}

const ids = (rows) => rows.map((row) => row.id);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} got ${actual}, want ${expected}`);

// ---------------------------------------------------------------------------------------------
// 1. The shipped registry
// ---------------------------------------------------------------------------------------------

test('registry: config/models.json loads and validates', () => {
  const { router, logs } = makeRouter({ modelsPath: SHIPPED });
  const reg = router.registry();
  assert.equal(reg.version, 1);
  assert.match(reg.dataDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(reg.fetchedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(reg.attribution, { text: 'Data from BenchLM.ai', url: 'https://benchlm.ai', license: 'CC BY-NC 4.0' });
  assert.doesNotThrow(() => validateRegistry(shipped()));
  assert.deepEqual(reg, validateRegistry(shipped()));
  assert.deepEqual(logs.filter((entry) => entry.level === 'warn' || entry.level === 'error'), []);
  for (const name of DOMAINS) assert.equal(reg.domains[name].keys.at(-1), 'overall', `${name} ends with overall`);
});

test('registry: the shipped file carries the BenchLM data of 2026-11-13, fetched on 2026-11-15, in under 40 KB', onShippedFile, () => {
  const reg = shipped();
  assert.equal(reg.dataDate, '2026-11-13');
  assert.equal(reg.fetchedAt, '2026-11-15');
  assert.ok(statSync(SHIPPED).size < 40 * 1024, `models.json is ${statSync(SHIPPED).size} bytes`);
  assert.equal(reg.models.length, 14);
  assert.equal(Object.keys(reg.categories).length, 31);
});

test('registry: the copy of the shipped data in this file holds the same routing data as config/models.json', onShippedFile, () => {
  assert.deepEqual(routingData(snapshotRegistry()), routingData(shipped()));
});

test('registry: the copy of the shipped data in this file is a valid registry', () => {
  const copy = snapshotRegistry();
  assert.deepEqual(validateRegistry(copy), copy);
  assert.equal(copy.models.length, 14);
  assert.equal(Object.keys(copy.categories).length, 31);
});

test('registry: the domains are exactly the 13 WorkShop domains and every key list ends with "overall"', onShippedFile, () => {
  const reg = shipped();
  assert.deepEqual(Object.keys(reg.domains).sort(), [...DOMAINS].sort());
  assert.deepEqual([...DOMAINS].sort(), [
    'algo', 'backend', 'chore', 'data', 'docs', 'fix', 'frontend', 'plan', 'research', 'review', 'synthesis', 'test', 'vision',
  ]);
  const used = new Set(['overall']);
  for (const [name, domain] of Object.entries(reg.domains)) {
    assert.ok(domain.label, `${name} has a label`);
    assert.equal(domain.keys.at(-1), 'overall', `${name} ends with overall`);
    assert.equal(new Set(domain.keys).size, domain.keys.length, `${name} repeats no key`);
    for (const key of domain.keys) {
      assert.ok(reg.categories[key], `${name}: ${key} is a category`);
      used.add(key);
    }
  }
  // Only the categories that the domain mapping uses, plus overall.
  assert.deepEqual(Object.keys(reg.categories).filter((key) => !used.has(key)), []);
});

test('registry: the domain mapping follows section 8 of the research report', onShippedFile, () => {
  const keys = Object.fromEntries(Object.entries(shipped().domains).map(([name, domain]) => [name, domain.keys]));
  assert.deepEqual(keys, {
    plan: ['reasoning', 'agentic', 'aaIntelligenceIndex', 'arenaAgentNetImprovement', 'overall'],
    backend: ['coding', 'cursorBench4', 'arenaCodingElo', 'terminalBench41', 'overall'],
    frontend: ['arenaWebDevElo', 'vibeCodeBench', 'designArenaWebsiteElo', 'overall'],
    fix: ['bugHuntBench', 'coding', 'overall'],
    review: ['coding', 'cweBenchV2', 'reasoning', 'overall'],
    test: ['coding', 'cursorBench4', 'terminalBench41', 'overall'],
    data: ['aaAnalystAgent', 'coding', 'overall'],
    algo: ['frontierMathT13', 'frontierMathT4', 'reasoning', 'overall'],
    research: ['agentic', 'arenaSearchElo', 'overall'],
    synthesis: ['aaLcr', 'knowledge', 'overall'],
    docs: ['arenaCreativeWritingElo', 'arenaTextElo', 'overall'],
    vision: ['osworld21Offline', 'multimodalGrounded', 'chartographyNoTools', 'aaMmmuPro', 'arenaVisionElo', 'overall'],
    chore: ['codingValueIndex', 'arenaAgentTimePerTaskMin', 'arenaAgentCostPerTaskUsd', 'speedTokensPerSecond', 'coding', 'overall'],
  });
});

test('registry: categories have a label, scale, tie and source; ties follow the report', onShippedFile, () => {
  const reg = shipped();
  for (const [key, cat] of Object.entries(reg.categories)) {
    assert.ok(cat.label && cat.scale && cat.source, `${key} has label, scale and source`);
    assert.ok(typeof cat.tie === 'number' && cat.tie >= 0, `${key} has a tie value`);
    if (cat.scale === '0-100') assert.equal(cat.tie, 5, `${key}: about 5 points on a 0-100 scale`);
    if (cat.scale === 'elo') assert.equal(cat.tie, 20, `${key}: 20 Elo points`);
  }
  // The six BenchLM boards are the keys that a refresh may update.
  const boards = Object.entries(reg.categories).filter(([, cat]) => cat.board).map(([key]) => key);
  assert.deepEqual(boards, ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge']);
  for (const key of boards) assert.equal(reg.categories[key].source, 'BenchLM');
  assert.equal(reg.categories.arenaAgentTimePerTaskMin.lowerIsBetter, true);
  assert.equal(reg.categories.arenaAgentCostPerTaskUsd.lowerIsBetter, true);
});

test('registry: every model has every category key as a number or null, and nothing else', () => {
  const reg = shipped();
  const keys = Object.keys(reg.categories);
  for (const model of reg.models) {
    assert.deepEqual(Object.keys(model.scores), keys, `${model.id} has the category keys in order`);
    for (const [key, value] of Object.entries(model.scores)) {
      assert.ok(value === null || (typeof value === 'number' && Number.isFinite(value)), `${model.id}.${key}`);
    }
  }
});

test("registry: roles, power and enabled flags are the owner's tiering", onShippedFile, () => {
  const rows = shipped().models.map((m) => [m.id, m.provider, m.tiers.join('+'), m.power, m.enabled]);
  assert.deepEqual(rows, [
    ['claude-fable-5-2', 'claude', 'boss', 5, true],
    ['gemini-4-carbon', 'gemini', 'boss', 5, true],
    ['claude-opus-5-5', 'claude', 'manager+boss', 4, true],
    ['gemini-4-argon', 'gemini', 'manager', 4, true],
    ['claude-sonnet-5-5', 'claude', 'maker+manager', 3, true],
    ['gemini-4-hydrogen', 'gemini', 'maker+manager', 3, true],
    ['claude-haiku-5-5', 'claude', 'maker', 2, true],
    ['gemini-3.8-flash', 'gemini', 'maker', 2, false],
    ['gemini-3.6-flash', 'gemini', 'maker', 2, false],
    ['gemini-3.5-flash-lite', 'gemini', 'maker', 1, false],
    ['gpt-6-astra', 'openai', 'boss', 5, false],
    ['gpt-6.1-sol', 'openai', 'manager', 4, false],
    ['gpt-6.1-terra', 'openai', 'maker', 3, false],
    ['gpt-6-luna', 'openai', 'maker', 2, false],
  ]);
});

test('registry: prices, price notes and plan notes come from the report', onShippedFile, () => {
  const model = Object.fromEntries(shipped().models.map((m) => [m.id, m]));
  const price = (id) => [model[id].price.in, model[id].price.out];
  assert.deepEqual(price('claude-fable-5-2'), [8, 40]);
  assert.deepEqual(price('claude-opus-5-5'), [4, 20]);
  assert.deepEqual(price('claude-sonnet-5-5'), [2, 10]);
  assert.deepEqual(price('claude-haiku-5-5'), [0.1, 0.5]);
  assert.deepEqual(price('gemini-4-carbon'), [2, 10]);
  assert.deepEqual(price('gemini-4-argon'), [2, 10]);
  assert.deepEqual(price('gemini-4-hydrogen'), [1.5, 7.5]);
  // Carbon and Argon double on 2026-12-01.
  for (const id of ['gemini-4-carbon', 'gemini-4-argon']) {
    assert.match(model[id].price.note, /doubles to \$4 \/ \$20 on 2026-12-01/);
    assert.deepEqual(model[id].price.next, { from: '2026-12-01', in: 4, out: 20 });
  }
  // Haiku costs 5x above 100,000 tokens.
  assert.match(model['claude-haiku-5-5'].price.note, /5x .*over 100,000 tokens/);
  // Fable use may draw on usage credits on a subscription.
  assert.match(model['claude-fable-5-2'].price.note, /subscription.*usage credits/);
  // A Gemini subscription needs the Ultra plan for Carbon.
  assert.match(model['gemini-4-carbon'].planNote, /Ultra plan/);
  // OpenAI has no CLI adapter yet.
  for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']) assert.match(model[id].planNote, /no OpenAI CLI adapter/);
  // BenchLM marks these three as "Estimated".
  assert.deepEqual(shipped().models.filter((m) => m.estimated).map((m) => m.id), ['claude-fable-5-2', 'gemini-4-hydrogen', 'gpt-6.1-terra']);
  // Efforts: Claude takes five levels, Carbon and Argon three, Hydrogen four.
  assert.deepEqual(model['claude-sonnet-5-5'].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(model['gemini-4-carbon'].efforts, ['low', 'medium', 'high']);
  assert.deepEqual(model['gemini-4-hydrogen'].efforts, ['low', 'medium', 'high', 'xhigh']);
  // The BenchLM slug of each model (report section 3.7): the API id with dots as dashes.
  assert.equal(model['gemini-3.8-flash'].benchlmSlug, 'gemini-3-8-flash');
  assert.equal(model['gpt-6.1-sol'].benchlmSlug, 'gpt-6-1-sol');
  for (const entry of shipped().models) assert.equal(entry.benchlmSlug, entry.id.replaceAll('.', '-'), entry.id);
});

test('registry: sample scores equal the report tables (section 5), null stays null', onShippedFile, () => {
  const score = Object.fromEntries(shipped().models.map((m) => [m.id, m.scores]));
  // 5.1 BenchLM boards
  assert.deepEqual(
    ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge'].map((k) => score['claude-fable-5-2'][k]),
    [93.65, 90.71, 89.23, 91, 90.43, 98.53],
  );
  assert.deepEqual(
    ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge'].map((k) => score['gemini-4-carbon'][k]),
    [89.15, 84.61, 83.88, 84.83, null, null],
  );
  assert.deepEqual(
    ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge'].map((k) => score['gemini-4-hydrogen'][k]),
    [79.06, null, 75.75, null, null, null],
  );
  assert.deepEqual(
    ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge'].map((k) => score['claude-sonnet-5-5'][k]),
    [83.05, 72.73, 80.97, 76.98, 78.92, 82.07],
  );
  assert.deepEqual(
    ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge'].map((k) => score['gemini-3.5-flash-lite'][k]),
    [46.95, 34.16, 34.68, 9.09, 51.52, 46.7],
  );
  // 5.2 to 5.5 cross-checks
  assert.equal(score['claude-haiku-5-5'].codingValueIndex, 117.86);
  assert.equal(score['claude-fable-5-2'].bugHuntBench, 58);
  assert.equal(score['gemini-4-carbon'].bugHuntBench, 57.3);
  assert.equal(score['gemini-4-argon'].arenaCreativeWritingElo, 1523);
  assert.equal(score['claude-haiku-5-5'].arenaCreativeWritingElo, null);
  assert.equal(score['claude-fable-5-2'].arenaTextElo, null);
  assert.equal(score['claude-opus-5-5'].aaLcr, 84.7);
  assert.equal(score['gemini-3.5-flash-lite'].frontierMathT4, 0); // a real zero, not a missing value
  assert.equal(score['gemini-3.6-flash'].aaIntelligenceIndex, null);
});

test('registry: every number equals benchmarks.json (runs when WORKSHOP_BENCHMARKS_JSON points at the research file)', {
  skip: process.env.WORKSHOP_BENCHMARKS_JSON && existsSync(process.env.WORKSHOP_BENCHMARKS_JSON)
    ? false : 'set WORKSHOP_BENCHMARKS_JSON to the research file benchmarks.json to run this check',
}, () => {
  const source = JSON.parse(readFileSync(process.env.WORKSHOP_BENCHMARKS_JSON, 'utf8'));
  const from = Object.fromEntries(source.models.map((m) => [m.modelId, m]));
  // The copy in this file always. The shipped file too, while it is still the shipped file.
  const registries = PRISTINE ? [snapshotRegistry(), shipped()] : [snapshotRegistry()];
  for (const reg of registries) {
    assert.equal(reg.models.length, source.models.length);
    let count = 0;
    for (const model of reg.models) {
      const src = from[model.id];
      assert.ok(src, `${model.id} is in benchmarks.json`);
      assert.equal(model.label, src.name);
      assert.equal(model.provider, src.provider);
      assert.deepEqual([model.price.in, model.price.out], [src.price.in, src.price.out]);
      assert.deepEqual(model.price.next ?? null, src.priceScheduled ?? null);
      assert.equal(model.estimated, src.evidence === 'estimated');
      for (const [key, value] of Object.entries(model.scores)) {
        assert.ok(Object.hasOwn(src.scores, key), `${key} is a key of benchmarks.json`);
        assert.equal(value, src.scores[key], `${model.id}.${key}`);
        count += 1;
      }
    }
    assert.equal(count, 14 * 31);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Picks on the shipped data
// ---------------------------------------------------------------------------------------------

test('data: backend, size M, both labs, thrift 0 -> Claude Sonnet 5.5 (coding 80.97 vs 75.75: gap 5.22 is over the tie of 5)', () => {
  const { router } = makeRouter({ thrift: 0 });
  const pick = router.pick({ role: 'maker', domain: 'backend', size: 'M' });
  assert.deepEqual(pick, {
    provider: 'claude', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', effort: 'medium',
    why: 'backend: coding 80.97 vs 75.75 (BenchLM), thrift 0',
  });
});

test('data: the same pick at the default thrift 0.3 (utility 1 - 0.3 * 1 = 0.7 against 0)', () => {
  const { router } = makeRouter();
  const pick = router.pick({ role: 'maker', domain: 'backend', size: 'M' });
  assert.equal(pick.model, 'claude-sonnet-5-5');
  assert.equal(pick.why, 'backend: coding 80.97 vs 75.75 (BenchLM), thrift 0.3');
  const table = router.explain({ role: 'maker', domain: 'backend', size: 'M' });
  assert.deepEqual(table.candidates.map((row) => [row.id, row.value, row.q, row.cost, row.c, row.utility]), [
    ['claude-sonnet-5-5', 80.97, 1, 8, 1, 0.7], // cost (2 + 3 * 10) / 4 = 8
    ['gemini-4-hydrogen', 75.75, 0, 6, 0, 0], // cost (1.5 + 3 * 7.5) / 4 = 6
  ]);
});

test('data: chore, size S -> Claude Haiku 5.5 (coding value index 117.86 vs 10.1 and 8.1, and the lowest cost)', () => {
  for (const thrift of [0, 0.3, 1]) {
    const { router } = makeRouter({ thrift });
    const pick = router.pick({ role: 'maker', domain: 'chore', size: 'S' });
    assert.equal(pick.model, 'claude-haiku-5-5', `thrift ${thrift}`);
    assert.equal(pick.effort, 'low');
    assert.match(pick.why, /^chore: codingValueIndex 117\.86 vs 10\.1 \(BenchLM\)/);
  }
});

test('data: docs, size M, thrift 0 -> Gemini 4 Hydrogen (creative writing Elo 1492 vs 1464: gap 28 is over the tie of 20)', () => {
  const { router } = makeRouter({ thrift: 0 });
  const pick = router.pick({ role: 'maker', domain: 'docs', size: 'M' });
  assert.equal(pick.model, 'gemini-4-hydrogen');
  assert.equal(pick.provider, 'gemini');
  assert.equal(pick.why, 'docs: arenaCreativeWritingElo 1492 vs 1464 (Arena), thrift 0');
});

test('data: boss, plan -> Claude Fable 5.2 (reasoning 91 vs 84.83: gap 6.17)', () => {
  for (const thrift of [0, 0.3]) {
    const { router } = makeRouter({ thrift });
    const pick = router.pick({ role: 'boss', domain: 'plan' });
    assert.equal(pick.model, 'claude-fable-5-2', `thrift ${thrift}`);
    assert.equal(pick.effort, 'high');
    assert.match(pick.why, /^plan: reasoning 91 vs 84\.83 \(BenchLM\), thrift/);
  }
});

test('data: boss with claude unusable -> Gemini 4 Carbon, and why says that the best lab is not usable', () => {
  const { router } = makeRouter({ usable: ['gemini'] });
  const pick = router.pick({ role: 'boss', domain: 'plan' });
  assert.equal(pick.model, 'gemini-4-carbon');
  assert.equal(pick.effort, 'high');
  assert.equal(pick.why, 'plan: reasoning 84.83 (BenchLM), only candidate, thrift 0.3; best lab claude is not usable (Claude Fable 5.2: reasoning 91)');
  for (const domain of DOMAINS) assert.equal(router.pick({ role: 'boss', domain }).provider, 'gemini', domain);
});

test('data: reviewer for a claude maker (boss, review, avoidProvider claude) -> a gemini model, and why says so', () => {
  const { router } = makeRouter();
  // Without the rule Claude Fable 5.2 wins: coding 89.23 vs 83.88 (gap 5.35).
  assert.equal(router.pick({ role: 'boss', domain: 'review' }).model, 'claude-fable-5-2');
  const pick = router.pick({ role: 'boss', domain: 'review', avoidProvider: 'claude' });
  assert.equal(pick.provider, 'gemini');
  assert.equal(pick.model, 'gemini-4-carbon');
  assert.equal(pick.why, 'review: coding 83.88 (BenchLM), only candidate, thrift 0.3; best lab claude was avoided (Claude Fable 5.2: coding 89.23)');
  // A buddy for a claude maker is a gemini maker, and the other way round.
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'M', avoidProvider: 'claude' }).model, 'gemini-4-hydrogen');
  assert.equal(router.pick({ role: 'maker', domain: 'docs', size: 'M', avoidProvider: 'gemini' }).model, 'claude-sonnet-5-5');
});

test('data: the crew at the default thrift, with both labs usable', () => {
  const { router } = makeRouter();
  const winner = (role, size) => Object.fromEntries(DOMAINS.map((domain) => [domain, router.pick({ role, domain, size }).model]));
  const F = 'claude-fable-5-2';
  const C = 'gemini-4-carbon';
  const O = 'claude-opus-5-5';
  const A = 'gemini-4-argon';
  const S = 'claude-sonnet-5-5';
  const H = 'gemini-4-hydrogen';
  assert.deepEqual(winner('boss'), {
    plan: F, // reasoning 91 vs 84.83
    backend: F, // coding 89.23 vs 83.88 (gap 5.35)
    frontend: F, // WebDev Elo 1838 vs 1768
    fix: C, // Bug Hunt 58 vs 57.3 is a tie, Carbon costs less (8 vs 32)
    review: F, // coding
    test: F, // coding
    data: F, // no AA-AnalystAgent score for either, so coding
    algo: C, // FrontierMath 95.088 vs 90.526 (gap 4.562) is a tie, Carbon costs less
    research: F, // agentic 90.71 vs 84.61
    synthesis: C, // AA-LCR 83.3 vs 79.3 (gap 4) is a tie, Carbon costs less
    docs: C, // Fable has no Arena writing or text rating, so overall 93.65 vs 89.15 (gap 4.5): a tie
    vision: F, // OSWorld 89.3 vs 81.5
    chore: C, // value index 8.39 vs 2.23
  });
  assert.deepEqual(winner('manager'), {
    plan: A, // reasoning 80.53 vs 76.52 (gap 4.01) is a tie, Argon costs less (8 vs 16)
    backend: O, // coding 82.6 vs 71.8
    frontend: O, // WebDev Elo 1815 vs 1681
    fix: A, // Bug Hunt 41.7 vs 40.7 is a tie
    review: O,
    test: O,
    data: O, // AA-AnalystAgent 56.3 vs 48.8
    algo: O, // FrontierMath 91.228 vs 85.965 (gap 5.263)
    research: O, // agentic 83.85 vs 74.86
    synthesis: O, // AA-LCR 84.7 vs 79.7: a gap of exactly 5 is not under the tie of 5
    docs: A, // writing Elo 1517 vs 1523 is a tie
    vision: O, // OSWorld 87.2 vs 74.7
    chore: A, // value index 7.18 vs 4.13
  });
  assert.deepEqual(winner('maker', 'M'), {
    plan: H, // Hydrogen has no reasoning or agentic score, so AA index 55 vs 54: a tie, Hydrogen costs less (6 vs 8)
    backend: S, // coding 80.97 vs 75.75
    frontend: S, // WebDev Elo 1772 vs 1704
    fix: S, // Bug Hunt 51.3 vs 32.7
    review: S,
    test: S,
    data: S, // Hydrogen has no AA-AnalystAgent score, so coding
    algo: H, // Hydrogen has no FrontierMath or reasoning score, so overall 83.05 vs 79.06 (gap 3.99): a tie
    research: H, // overall, a tie
    synthesis: H, // overall, a tie
    docs: H, // writing Elo 1492 vs 1464
    vision: S, // OSWorld 83.9 vs 77.6 (gap 6.3)
    chore: H, // value index 10.1 vs 8.1
  });
  assert.deepEqual(winner('maker', 'L'), winner('maker', 'M')); // M and L need the same power
});

test('data: thrift 0 picks the best score, thrift 1 the cheapest model that fits', () => {
  const best = makeRouter({ thrift: 0 }).router;
  const cheap = makeRouter({ thrift: 1 }).router;
  // Size S: Sonnet 80.97, Hydrogen 75.75, Haiku 58.93. Costs 8, 6 and 0.4.
  assert.equal(best.pick({ role: 'maker', domain: 'backend', size: 'S' }).model, 'claude-sonnet-5-5');
  const s = cheap.pick({ role: 'maker', domain: 'backend', size: 'S' });
  assert.equal(s.model, 'claude-haiku-5-5');
  assert.equal(s.why, 'backend: coding 58.93 vs 75.75 (BenchLM), the cheapest wins, thrift 1');
  // Size M: Haiku does not fit (power 2), so the cheapest that fits is Hydrogen.
  assert.equal(best.pick({ role: 'maker', domain: 'backend', size: 'M' }).model, 'claude-sonnet-5-5');
  assert.equal(cheap.pick({ role: 'maker', domain: 'backend', size: 'M' }).model, 'gemini-4-hydrogen');
  // Bosses: Fable costs 32, Carbon 8.
  assert.equal(best.pick({ role: 'boss', domain: 'plan' }).model, 'claude-fable-5-2');
  assert.equal(cheap.pick({ role: 'boss', domain: 'plan' }).model, 'gemini-4-carbon');
});

test('data: size sets the minimum power for makers; bump raises it and stops at the strongest candidate', () => {
  const { router } = makeRouter();
  const chore = (extra) => router.pick({ role: 'maker', domain: 'chore', ...extra });
  assert.equal(chore({ size: 'S' }).model, 'claude-haiku-5-5'); // power 2 is enough for S
  assert.equal(chore({ size: 'M' }).model, 'gemini-4-hydrogen'); // needs power 3: value index 10.1 vs 8.1
  assert.equal(chore({ size: 'L' }).model, 'gemini-4-hydrogen');
  assert.equal(chore({ size: 's' }).model, 'claude-haiku-5-5'); // lower case is fine
  assert.equal(chore({ size: 'S', bump: 1 }).model, 'claude-haiku-5-5'); // minimum 2: Haiku still fits
  assert.equal(chore({ size: 'S', bump: 2 }).model, 'gemini-4-hydrogen'); // minimum 3
  assert.equal(chore({ size: 'S', bump: 9 }).model, 'gemini-4-hydrogen'); // capped at 3, the strongest maker
  assert.equal(chore({ size: 'M', bump: 1 }).model, 'gemini-4-hydrogen'); // 4 is capped at 3
  const table = router.explain({ role: 'maker', domain: 'chore', size: 'M' });
  assert.equal(table.minPower, 3);
  assert.deepEqual(table.rejected.find((row) => row.id === 'claude-haiku-5-5'), {
    id: 'claude-haiku-5-5', provider: 'claude', label: 'Claude Haiku 5.5', reason: 'power 2 is under 3',
  });
  assert.equal(router.explain({ role: 'maker', domain: 'chore', size: 'S', bump: 9 }).minPower, 3);
  // Effort follows the size: S low, M medium, L high.
  assert.deepEqual(['S', 'M', 'L'].map((size) => router.pick({ role: 'maker', domain: 'backend', size }).effort), ['low', 'medium', 'high']);
  // A boss has no size rule. A bump cannot go past power 5.
  assert.equal(router.pick({ role: 'boss', domain: 'plan', bump: 3 }).model, 'claude-fable-5-2');
});

test('data: only primary-tier models are candidates while one is available; fallback tiers step in after that', () => {
  const { router } = makeRouter();
  for (const domain of DOMAINS) {
    assert.ok(['claude-fable-5-2', 'gemini-4-carbon'].includes(router.pick({ role: 'boss', domain }).model), `boss ${domain}`);
    assert.ok(['claude-opus-5-5', 'gemini-4-argon'].includes(router.pick({ role: 'manager', domain }).model), `manager ${domain}`);
    assert.ok(['claude-sonnet-5-5', 'gemini-4-hydrogen', 'claude-haiku-5-5'].includes(router.pick({ role: 'maker', domain, size: 'S' }).model));
  }
  // Both primary bosses excluded: Opus 5.5 lists boss as its fallback role.
  const boss = router.pick({ role: 'boss', domain: 'plan', exclude: ['claude-fable-5-2', 'gemini-4-carbon'] });
  assert.equal(boss.model, 'claude-opus-5-5');
  assert.equal(boss.effort, 'high'); // the effort of the role, not of the model's own tier
  assert.match(boss.why, /no primary boss is available so a fallback-tier model is used/);
  assert.equal(router.explain({ role: 'boss', domain: 'plan', exclude: ['claude-fable-5-2', 'gemini-4-carbon'] }).tier, 'fallback');
  // Both primary managers excluded: Sonnet 5.5 and Hydrogen list manager as a fallback role.
  // Hydrogen has no reasoning or agentic score, so AA index 55 vs 54: a tie, Hydrogen costs less.
  const manager = router.pick({ role: 'manager', domain: 'plan', exclude: ['claude-opus-5-5', 'gemini-4-argon'] });
  assert.equal(manager.model, 'gemini-4-hydrogen');
  assert.equal(manager.effort, 'medium');
  // One primary manager left: no fallback tier.
  assert.equal(router.pick({ role: 'manager', domain: 'plan', exclude: ['gemini-4-argon'] }).model, 'claude-opus-5-5');
  assert.equal(router.explain({ role: 'manager', domain: 'plan' }).tier, 'primary');
  // No model lists maker as a fallback role.
  assert.equal(router.pick({ role: 'maker', domain: 'plan', exclude: ['claude-sonnet-5-5', 'gemini-4-hydrogen', 'claude-haiku-5-5'] }), null);
});

test('data: one lab unusable -> the other lab works alone, and why names the missing lab when it was the best', () => {
  const claudeOnly = makeRouter({ usable: ['claude'] }).router;
  const geminiOnly = makeRouter({ usable: ['gemini'] }).router;
  for (const role of ROLES) {
    for (const domain of DOMAINS) {
      assert.equal(claudeOnly.pick({ role, domain, size: 'M' }).provider, 'claude', `${role} ${domain}`);
      assert.equal(geminiOnly.pick({ role, domain, size: 'M' }).provider, 'gemini', `${role} ${domain}`);
    }
  }
  // docs M: Hydrogen is the pick when both labs work (1492 vs 1464).
  const docs = claudeOnly.pick({ role: 'maker', domain: 'docs', size: 'M' });
  assert.equal(docs.model, 'claude-sonnet-5-5');
  assert.match(docs.why, /; best lab gemini is not usable \(Gemini 4 Hydrogen: arenaCreativeWritingElo 1492\)$/);
  // backend M: Sonnet is the pick anyway, so there is nothing to say.
  assert.equal(claudeOnly.pick({ role: 'maker', domain: 'backend', size: 'M' }).why, 'backend: coding 80.97 (BenchLM), only candidate, thrift 0.3');
  assert.equal(claudeOnly.explain({ role: 'maker', domain: 'docs', size: 'M' }).fallback, true);
  assert.equal(claudeOnly.explain({ role: 'maker', domain: 'backend', size: 'M' }).fallback, false);
  // Size S with gemini down: Sonnet 80.97 against Haiku 58.93.
  assert.equal(claudeOnly.pick({ role: 'maker', domain: 'backend', size: 'S' }).model, 'claude-sonnet-5-5');
});

test('data: avoidProvider is dropped when no other lab can take the role', () => {
  const { router } = makeRouter({ usable: ['claude'] });
  const pick = router.pick({ role: 'boss', domain: 'review', avoidProvider: 'claude' });
  assert.equal(pick.model, 'claude-fable-5-2');
  assert.match(pick.why, /; claude could not be avoided because no other lab can take the role now$/);
  // The other direction: avoid gemini while claude is down.
  const other = makeRouter({ usable: ['gemini'] }).router.pick({ role: 'boss', domain: 'review', avoidProvider: 'gemini' });
  assert.equal(other.model, 'gemini-4-carbon');
  assert.match(other.why, /best lab claude is not usable/);
  assert.match(other.why, /gemini could not be avoided/);
});

test('data: nothing usable -> null', () => {
  const { router } = makeRouter({ usable: [] });
  for (const role of ROLES) for (const domain of DOMAINS) assert.equal(router.pick({ role, domain, size: 'S' }), null);
  const table = router.explain({ role: 'maker', domain: 'backend', size: 'S' });
  assert.equal(table.pick, null);
  assert.match(table.reason, /No enabled model in a usable lab/);
  assert.deepEqual(table.candidates, []);
  assert.ok(table.rejected.some((row) => row.id === 'claude-sonnet-5-5' && row.reason === 'lab not usable'));
  // A lab without an enabled model changes nothing: openai models are disabled.
  assert.equal(makeRouter({ usable: ['openai'] }).router.pick({ role: 'boss', domain: 'plan' }), null);
});

test('data: lab fallback off (settings.allowFallback false) -> no pick while the best lab is down', () => {
  const { router } = makeRouter({ usable: ['claude'], settings: { thrift: 0.3, allowFallback: false } });
  // docs M belongs to Hydrogen (1492 vs 1464). Gemini is down and fallback is off: wait.
  assert.equal(router.pick({ role: 'maker', domain: 'docs', size: 'M' }), null);
  assert.match(router.explain({ role: 'maker', domain: 'docs', size: 'M' }).reason, /Gemini 4 Hydrogen \(gemini\).*lab fallback is off/);
  // backend M belongs to Sonnet anyway: no fallback is involved.
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'M' }).model, 'claude-sonnet-5-5');
  // With fallback on (the default) the other lab takes over.
  const on = makeRouter({ usable: ['claude'], settings: { thrift: 0.3, allowFallback: true } }).router;
  assert.equal(on.pick({ role: 'maker', domain: 'docs', size: 'M' }).model, 'claude-sonnet-5-5');
});

test('data: ties in utility -> lab load, then preferProvider, then lower cost', () => {
  // plan M at thrift 0: AA index 55 (Sonnet) vs 54 (Hydrogen) is a tie, so both have utility 1.
  const { router } = makeRouter({ thrift: 0 });
  const plan = (extra) => router.pick({ role: 'maker', domain: 'plan', size: 'M', ...extra });
  assert.equal(plan({}).model, 'gemini-4-hydrogen'); // lower cost: 6 vs 8
  assert.match(plan({}).why, /aaIntelligenceIndex 54 vs 55 \(Artificial Analysis\), a tie \(gap under 3\) so lower cost wins/);
  assert.equal(plan({ preferProvider: 'claude' }).model, 'claude-sonnet-5-5');
  assert.match(plan({ preferProvider: 'claude' }).why, /so the preferred lab wins/);
  assert.equal(plan({ preferProvider: 'gemini' }).model, 'gemini-4-hydrogen');
  assert.equal(plan({ labLoad: { claude: 0, gemini: 2 } }).model, 'claude-sonnet-5-5'); // crew balance
  assert.match(plan({ labLoad: { claude: 0, gemini: 2 } }).why, /so crew balance decides/);
  assert.equal(plan({ labLoad: { claude: 2, gemini: 0 } }).model, 'gemini-4-hydrogen');
  assert.equal(plan({ labLoad: { claude: 2, gemini: 0 }, preferProvider: 'claude' }).model, 'gemini-4-hydrogen'); // load goes first
  assert.equal(plan({ labLoad: { claude: 1, gemini: 1 }, preferProvider: 'claude' }).model, 'claude-sonnet-5-5'); // equal load
  // None of this moves a clear lead: backend M, coding 80.97 vs 75.75.
  const backend = (extra) => router.pick({ role: 'maker', domain: 'backend', size: 'M', ...extra }).model;
  assert.equal(backend({ preferProvider: 'gemini' }), 'claude-sonnet-5-5');
  assert.equal(backend({ labLoad: { claude: 9, gemini: 0 } }), 'claude-sonnet-5-5');
  assert.equal(backend({ labLoad: { claude: 9, gemini: 0 }, preferProvider: 'gemini' }), 'claude-sonnet-5-5');
  // At thrift 0.3 the cost already separates the tied pair (utility 1 vs 0.7), so load does not decide.
  const thrifty = makeRouter({ thrift: 0.3 }).router;
  assert.equal(thrifty.pick({ role: 'maker', domain: 'plan', size: 'M', labLoad: { claude: 0, gemini: 5 } }).model, 'gemini-4-hydrogen');
});

test('data: the comparison key is the first key that every candidate has a number for', () => {
  const { router } = makeRouter();
  const key = (query) => router.explain(query).key;
  assert.equal(key({ role: 'maker', domain: 'docs', size: 'M' }), 'arenaCreativeWritingElo');
  // With Haiku in the pool the first key has a gap, so the second key is used.
  const docs = router.explain({ role: 'maker', domain: 'docs', size: 'S' });
  assert.equal(docs.key, 'arenaTextElo');
  assert.deepEqual(docs.keysTried, [
    { key: 'arenaCreativeWritingElo', missing: ['claude-haiku-5-5'] },
    { key: 'arenaTextElo', missing: [] },
  ]);
  // Sonnet 1473 and Hydrogen 1490 are a tie (gap 17), Haiku 1421 is behind.
  assert.deepEqual(docs.candidates.map((row) => [row.id, row.value, row.q]), [
    ['gemini-4-hydrogen', 1490, 1], ['claude-sonnet-5-5', 1473, 1], ['claude-haiku-5-5', 1421, 0],
  ]);
  assert.equal(key({ role: 'maker', domain: 'data', size: 'M' }), 'coding'); // Hydrogen has no AA-AnalystAgent score
  assert.equal(key({ role: 'manager', domain: 'data' }), 'aaAnalystAgent'); // Opus 56.3, Argon 48.8
  assert.equal(key({ role: 'boss', domain: 'data' }), 'coding'); // neither boss has one
  assert.equal(key({ role: 'maker', domain: 'plan', size: 'M' }), 'aaIntelligenceIndex');
  assert.equal(key({ role: 'boss', domain: 'docs' }), 'overall'); // Fable has no Arena text ratings yet
  assert.equal(key({ role: 'maker', domain: 'algo', size: 'M' }), 'overall');
  assert.equal(key({ role: 'maker', domain: 'no-such-domain', size: 'M' }), 'overall');
  assert.match(router.pick({ role: 'maker', domain: 'no-such-domain', size: 'M' }).why, /^general: overall 79\.06 vs 83\.05 \(BenchLM\), a tie/);
  assert.match(router.pick({ role: 'maker', size: 'M' }).why, /^general: overall/);
});

test('data: quality is min-max over the candidates with tie bands; utility = q - thrift * c', () => {
  const { router } = makeRouter();
  const rows = router.explain({ role: 'maker', domain: 'backend', size: 'S' }).candidates;
  assert.deepEqual(ids(rows), ['claude-sonnet-5-5', 'gemini-4-hydrogen', 'claude-haiku-5-5']);
  const [sonnet, hydrogen, haiku] = rows;
  near(sonnet.q, 1);
  near(hydrogen.q, (75.75 - 58.93) / (80.97 - 58.93)); // 0.763158
  near(haiku.q, 0);
  assert.deepEqual([sonnet.cost, hydrogen.cost, haiku.cost], [8, 6, 0.4]);
  near(hydrogen.c, (6 - 0.4) / (8 - 0.4)); // 0.736842
  near(sonnet.utility, 0.7);
  near(hydrogen.utility, 0.763158 - 0.3 * 0.736842); // 0.542105
  near(haiku.utility, 0);
  // A gap under the tie value counts as equal quality: managers on reasoning, 80.53 vs 76.52 (gap 4.01).
  const managers = router.explain({ role: 'manager', domain: 'plan' }).candidates;
  assert.deepEqual(managers.map((row) => [row.id, row.value, row.q, row.cost, row.utility]), [
    ['gemini-4-argon', 76.52, 1, 8, 1],
    ['claude-opus-5-5', 80.53, 1, 16, 0.7],
  ]);
});

test('data: the price change of 2026-12-01 is used from that day on', () => {
  const november = makeRouter({ now: new Date(2026, 10, 30, 23, 59).getTime() }).router;
  const december = makeRouter({ now: new Date(2026, 11, 1, 0, 1).getTime() }).router;
  const costs = (router) => Object.fromEntries(router.explain({ role: 'manager', domain: 'plan' }).candidates.map((row) => [row.id, row.cost]));
  assert.deepEqual(costs(november), { 'gemini-4-argon': 8, 'claude-opus-5-5': 16 });
  assert.deepEqual(costs(december), { 'gemini-4-argon': 16, 'claude-opus-5-5': 16 }); // (4 + 3 * 20) / 4
  // plan is a tie on reasoning (80.53 vs 76.52). Until the change Argon is cheaper. After it the costs
  // are equal, so the registry order decides and Opus 5.5 comes first.
  assert.equal(november.pick({ role: 'manager', domain: 'plan' }).model, 'gemini-4-argon');
  const pick = december.pick({ role: 'manager', domain: 'plan' });
  assert.equal(pick.model, 'claude-opus-5-5');
  assert.match(pick.why, /a tie \(gap under 5\) so registry order decides/);
});

test('data: disabled models are never picked', () => {
  const { router } = makeRouter({ usable: ['claude', 'gemini', 'openai'] });
  const disabled = new Set(snapshotRegistry().models.filter((m) => !m.enabled).map((m) => m.id));
  assert.equal(disabled.size, 7);
  for (const role of ROLES) {
    for (const domain of DOMAINS) {
      for (const size of ['S', 'M', 'L']) {
        for (const thrift of [0, 1]) {
          const pick = makeRouter({ usable: ['claude', 'gemini', 'openai'], thrift }).router.pick({ role, domain, size });
          assert.ok(pick && !disabled.has(pick.model), `${role} ${domain} ${size}`);
        }
      }
    }
  }
  assert.ok(router.explain({ role: 'boss', domain: 'plan' }).rejected.some((row) => row.id === 'gpt-6-astra' && row.reason === 'disabled'));
});

test('data: leaders() ranks the candidates of every domain and role and ignores usability', () => {
  const { router } = makeRouter({ usable: [] });
  const leaders = router.leaders();
  assert.deepEqual(Object.keys(leaders).sort(), [...DOMAINS].sort());
  for (const domain of DOMAINS) assert.deepEqual(Object.keys(leaders[domain]), ['boss', 'manager', 'maker']);
  const brief = (rows) => rows.map((row) => [row.label, row.provider, row.key, row.value]);
  assert.deepEqual(brief(leaders.backend.boss), [['Claude Fable 5.2', 'claude', 'coding', 89.23], ['Gemini 4 Carbon', 'gemini', 'coding', 83.88]]);
  assert.deepEqual(brief(leaders.backend.manager), [['Claude Opus 5.5', 'claude', 'coding', 82.6], ['Gemini 4 Argon', 'gemini', 'coding', 71.8]]);
  assert.deepEqual(brief(leaders.backend.maker), [
    ['Claude Sonnet 5.5', 'claude', 'coding', 80.97], ['Gemini 4 Hydrogen', 'gemini', 'coding', 75.75], ['Claude Haiku 5.5', 'claude', 'coding', 58.93],
  ]);
  assert.deepEqual(brief(leaders.chore.maker), [
    ['Claude Haiku 5.5', 'claude', 'codingValueIndex', 117.86], ['Gemini 4 Hydrogen', 'gemini', 'codingValueIndex', 10.1],
    ['Claude Sonnet 5.5', 'claude', 'codingValueIndex', 8.1],
  ]);
  // The order is the router's order: on a tie the cheaper model leads (Bug Hunt 57.3 vs 58).
  assert.deepEqual(brief(leaders.fix.boss), [['Gemini 4 Carbon', 'gemini', 'bugHuntBench', 57.3], ['Claude Fable 5.2', 'claude', 'bugHuntBench', 58]]);
  const first = leaders.backend.boss[0];
  assert.deepEqual(Object.keys(first), ['rank', 'id', 'label', 'provider', 'key', 'value', 'score', 'q', 'utility']);
  assert.equal(first.score, first.value); // the contract calls it "score"
  // The first leader is the model that pick() returns when every lab is usable.
  const all = makeRouter().router;
  for (const domain of DOMAINS) {
    for (const role of ROLES) assert.equal(leaders[domain][role][0].id, all.pick({ role, domain }).model, `${domain} ${role}`);
  }
});

test('data: the result is deterministic', () => {
  const queries = [];
  for (const role of ROLES) {
    for (const domain of [...DOMAINS, 'other']) {
      for (const size of ['S', 'M', 'L', undefined]) {
        for (const extra of [{}, { avoidProvider: 'claude' }, { avoidProvider: 'gemini', bump: 1 }, { preferProvider: 'gemini', labLoad: { gemini: 1, claude: 1 } }]) {
          queries.push({ role, domain, size, ...extra });
        }
      }
    }
  }
  for (const thrift of [0, 0.3, 1]) {
    const one = makeRouter({ thrift }).router;
    const two = makeRouter({ thrift }).router;
    const first = queries.map((query) => one.pick(query));
    assert.ok(first.every((pick) => pick !== null));
    assert.deepEqual(queries.map((query) => one.pick(query)), first); // same router, asked again
    assert.deepEqual([...queries].reverse().map((query) => two.pick(query)).reverse(), first); // another router, other order
    assert.deepEqual(one.leaders(), two.leaders());
    assert.deepEqual(one.explain(queries[7]), two.explain(queries[7]));
  }
  // The key order of labLoad does not matter.
  const { router } = makeRouter({ thrift: 0 });
  const a = router.pick({ role: 'maker', domain: 'plan', size: 'M', labLoad: { claude: 1, gemini: 2 } });
  const b = router.pick({ role: 'maker', domain: 'plan', size: 'M', labLoad: { gemini: 2, claude: 1 } });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------------------------
// 3. The pick rules on small registries
// ---------------------------------------------------------------------------------------------

test('rule: candidates are the enabled models whose primary tier is the role, in a usable lab', (t) => {
  const registry = tiny([
    { id: 'a', provider: 'a', tiers: ['maker'], scores: { overall: 60 } },
    { id: 'b', provider: 'b', tiers: ['maker'], scores: { overall: 90 }, enabled: false },
    { id: 'c', provider: 'c', tiers: ['manager', 'maker'], scores: { overall: 95 } },
    { id: 'd', provider: 'd', tiers: ['maker'], scores: { overall: 99 } },
    { id: 'e', provider: 'a', tiers: ['boss'], scores: { overall: 99 } },
  ]);
  const { router } = routerFor(t, registry, { usable: ['a', 'b', 'c'] });
  const table = router.explain({ role: 'maker', domain: 'backend' });
  assert.deepEqual(ids(table.candidates), ['a']);
  assert.deepEqual(table.rejected.map((row) => [row.id, row.reason]), [
    ['b', 'disabled'], ['d', 'lab not usable'], ['c', 'fallback tier is not needed'],
  ]);
  // "d" has the best score (99) but its lab is not usable, and why says so.
  assert.deepEqual(router.pick({ role: 'maker', domain: 'backend' }), {
    provider: 'a', model: 'a', label: 'A', effort: 'medium',
    why: 'backend: overall 60 (Test), only candidate, thrift 0.3; best lab d is not usable (D: overall 99)',
  });
  // With every lab usable "d" wins and there is nothing to add.
  const all = routerFor(t, registry, { usable: ['a', 'b', 'c', 'd'] }).router.pick({ role: 'maker', domain: 'backend' });
  assert.deepEqual([all.model, all.why], ['d', 'backend: overall 99 vs 60 (Test), thrift 0.3']);
  // Without the primary-tier model the fallback tier is used.
  assert.equal(router.pick({ role: 'maker', domain: 'backend', exclude: ['a'] }).model, 'c');
  assert.equal(router.pick({ role: 'maker', domain: 'backend', exclude: new Set(['a']) }).model, 'c');
  assert.equal(router.pick({ role: 'maker', domain: 'backend', exclude: 'a' }).model, 'c');
  assert.equal(router.pick({ role: 'maker', domain: 'backend', exclude: ['a', 'c'] }), null);
  // A role that nobody has.
  assert.equal(routerFor(t, tiny([{ id: 'a' }])).router.pick({ role: 'boss', domain: 'plan' }), null);
});

test('rule: an unknown role or a missing query gives null', (t) => {
  const { router } = routerFor(t, tiny([{ id: 'a' }]));
  for (const query of [undefined, null, {}, { role: 'janitor' }, { role: 5 }, 'maker', []]) {
    assert.equal(router.pick(query), null);
    assert.equal(router.explain(query).pick, null);
  }
  assert.match(router.explain({ role: 'janitor' }).reason, /boss, manager or maker/);
});

test('rule: makers need power 1 for S and power 3 for M and L; a fallback-tier model that fits beats a primary one that does not', (t) => {
  const registry = tiny([
    { id: 'small', power: 2, scores: { overall: 70 } },
    { id: 'tiny', power: 1, scores: { overall: 40 } },
    { id: 'spare', power: 4, tiers: ['manager', 'maker'], scores: { overall: 80 } },
  ]);
  const { router } = routerFor(t, registry, { thrift: 0 });
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'S' }).model, 'small');
  assert.deepEqual(ids(router.explain({ role: 'maker', domain: 'backend', size: 'S' }).candidates), ['small', 'tiny']);
  // M: no primary maker has power 3, so the fallback-tier model with power 4 takes the task.
  for (const size of ['M', 'L']) {
    const pick = router.pick({ role: 'maker', domain: 'backend', size });
    assert.equal(pick.model, 'spare', size);
    assert.match(pick.why, /no primary maker is available so a fallback-tier model is used/);
  }
  // Nothing strong enough at all: no pick.
  const weak = routerFor(t, tiny([{ id: 'small', power: 2 }]));
  assert.equal(weak.router.pick({ role: 'maker', domain: 'backend', size: 'M' }), null);
  assert.equal(weak.router.pick({ role: 'maker', domain: 'backend', size: 'S' }).model, 'small');
  // No size: no minimum.
  assert.equal(weak.router.pick({ role: 'maker', domain: 'backend' }).model, 'small');
  // The size rule is for makers only.
  const boss = routerFor(t, tiny([{ id: 'b1', tiers: ['boss'], power: 1 }]));
  assert.equal(boss.router.pick({ role: 'boss', domain: 'plan', size: 'L' }).model, 'b1');
});

test('rule: bump raises the minimum power by that much and stops at the strongest candidate', (t) => {
  const registry = tiny([
    { id: 'p1', power: 1, scores: { overall: 90 } },
    { id: 'p2', power: 2, scores: { overall: 80 } },
    { id: 'p4', power: 4, scores: { overall: 70 } },
  ]);
  const { router } = routerFor(t, registry, { thrift: 0 });
  const pool = (query) => ids(router.explain({ role: 'maker', domain: 'backend', ...query }).candidates).sort();
  assert.deepEqual(pool({ size: 'S' }), ['p1', 'p2', 'p4']);
  assert.deepEqual(pool({ size: 'S', bump: 1 }), ['p2', 'p4']); // minimum 2
  assert.deepEqual(pool({ size: 'S', bump: 2 }), ['p4']); // minimum 3
  assert.deepEqual(pool({ size: 'S', bump: 3 }), ['p4']); // minimum 4
  assert.deepEqual(pool({ size: 'S', bump: 50 }), ['p4']); // capped at 4
  assert.deepEqual(pool({ size: 'M' }), ['p4']);
  assert.deepEqual(pool({ size: 'M', bump: 5 }), ['p4']);
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'S' }).model, 'p1');
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'S', bump: 1 }).model, 'p2');
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'S', bump: 2 }).model, 'p4');
  // Odd bump values count as 0 or are rounded down.
  for (const bump of [-3, Number.NaN, '2', null, 0.9]) assert.deepEqual(pool({ size: 'S', bump }), ['p1', 'p2', 'p4']);
  assert.deepEqual(pool({ size: 'S', bump: 1.9 }), ['p2', 'p4']);
  assert.ok(router.explain({ role: 'maker', domain: 'backend', size: 'S', bump: 1 }).rejected.some((row) => row.id === 'p1' && /bump/.test(row.reason)));
});

test('rule: avoidProvider removes that lab only when a candidate of another lab remains', (t) => {
  const registry = tiny([
    { id: 'a1', provider: 'a', scores: { overall: 90 } },
    { id: 'a2', provider: 'a', scores: { overall: 80 } },
    { id: 'b1', provider: 'b', scores: { overall: 60 } },
  ]);
  const { router } = routerFor(t, registry, { thrift: 0 });
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'a1');
  const cross = router.pick({ role: 'maker', domain: 'backend', avoidProvider: 'a' });
  assert.equal(cross.model, 'b1');
  assert.match(cross.why, /best lab a was avoided \(A1: overall 90\)/);
  assert.equal(router.pick({ role: 'maker', domain: 'backend', avoidProvider: 'b' }).model, 'a1');
  assert.doesNotMatch(router.pick({ role: 'maker', domain: 'backend', avoidProvider: 'b' }).why, /avoided/); // b was not the best lab
  assert.equal(router.pick({ role: 'maker', domain: 'backend', avoidProvider: 'zzz' }).model, 'a1');
  // No other lab left: the avoided lab stays.
  const stay = router.pick({ role: 'maker', domain: 'backend', avoidProvider: 'a', exclude: ['b1'] });
  assert.equal(stay.model, 'a1');
  assert.match(stay.why, /a could not be avoided/);
});

test('rule: preferProvider and labLoad only break ties; then lower cost, then registry order', (t) => {
  const models = [
    { id: 'x', provider: 'a', scores: { overall: 80 }, price: { in: 2, out: 2 } },
    { id: 'y', provider: 'b', scores: { overall: 78 }, price: { in: 2, out: 2 } }, // gap 2 is under the tie of 5
    { id: 'z', provider: 'c', scores: { overall: 60 }, price: { in: 1, out: 1 } },
  ];
  const { router } = routerFor(t, tiny(models), { thrift: 0 });
  const pick = (extra) => router.pick({ role: 'maker', domain: 'backend', ...extra });
  assert.equal(pick({}).model, 'x'); // same cost: registry order
  assert.match(pick({}).why, /overall 80 vs 78 \(Test\), a tie \(gap under 5\) so registry order decides, thrift 0$/);
  assert.equal(pick({ preferProvider: 'b' }).model, 'y');
  assert.equal(pick({ labLoad: { a: 1 } }).model, 'y'); // b has load 0
  assert.equal(pick({ labLoad: { a: 1, b: 1 } }).model, 'x');
  assert.equal(pick({ labLoad: { a: 1, b: 2 }, preferProvider: 'b' }).model, 'x'); // load before preference
  assert.equal(pick({ preferProvider: 'c' }).model, 'x'); // z is not in the tie: 60 is 20 behind
  assert.equal(pick({ labLoad: { a: 5, b: 5 } }).model, 'x'); // the lightest lab does not win outside the tie
  assert.equal(pick({ labLoad: { a: 'many', b: -1 } }).model, 'y'); // a bad load counts as 0, and -1 is lower
  // The same registry in another order: the first of the tied pair wins.
  const swapped = routerFor(t, tiny([models[1], models[0], models[2]]), { thrift: 0 });
  assert.equal(swapped.router.pick({ role: 'maker', domain: 'backend' }).model, 'y');
  // Lower cost goes before registry order.
  const cheaper = routerFor(t, tiny([models[0], { ...models[1], price: { in: 1, out: 2 } }, models[2]]), { thrift: 0 });
  assert.equal(cheaper.router.pick({ role: 'maker', domain: 'backend' }).model, 'y');
  assert.match(cheaper.router.pick({ role: 'maker', domain: 'backend' }).why, /so lower cost wins/);
});

test('rule: utilities within 0.02 are a tie, a wider gap is not', (t) => {
  const exact = { overall: { label: 'Overall', scale: '0-100', tie: 0, source: 'Test' } }; // tie 0: every gap counts
  const build = (second) => tiny([
    { id: 'x', provider: 'a', scores: { overall: 100 } },
    { id: 'y', provider: 'b', scores: { overall: second } },
    { id: 'z', provider: 'c', scores: { overall: 0 } },
  ], { categories: exact });
  // q = 1, 0.99, 0 and equal costs: utilities 1 and 0.99 are a tie, so lab load decides.
  const close = routerFor(t, build(99), { thrift: 0.3 });
  assert.equal(close.router.pick({ role: 'maker', domain: 'backend' }).model, 'x');
  const balanced = close.router.pick({ role: 'maker', domain: 'backend', labLoad: { a: 1 } });
  assert.equal(balanced.model, 'y');
  assert.match(balanced.why, /overall 99 vs 100 \(Test\), a close call so crew balance decides/);
  const rows = close.router.explain({ role: 'maker', domain: 'backend', labLoad: { a: 1 } }).candidates;
  assert.deepEqual(rows.map((row) => [row.id, row.utility, row.tieGroup]), [['y', 0.99, 1], ['x', 1, 1], ['z', 0, 2]]);
  // q = 1 and 0.98: exactly 0.02 apart is still a tie.
  assert.equal(routerFor(t, build(98), { thrift: 0.3 }).router.pick({ role: 'maker', domain: 'backend', labLoad: { a: 1 } }).model, 'y');
  // q = 1 and 0.97: not a tie, the load does not matter.
  assert.equal(routerFor(t, build(97), { thrift: 0.3 }).router.pick({ role: 'maker', domain: 'backend', labLoad: { a: 1 } }).model, 'x');
});

test('rule: tie bands start at the best value of each band', (t) => {
  // 80, 76 and 75.5 are within 5 of 80. 74 is 6 behind 80 and starts the next band, 70 joins it.
  const registry = tiny([
    { id: 'v70', scores: { overall: 70 } },
    { id: 'v80', scores: { overall: 80 } },
    { id: 'v74', scores: { overall: 74 } },
    { id: 'v76', scores: { overall: 76 } },
    { id: 'v755', scores: { overall: 75.5 } },
  ]);
  const { router } = routerFor(t, registry, { thrift: 0 });
  const rows = router.explain({ role: 'maker', domain: 'backend' }).candidates;
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, [row.band, row.q]])), {
    v80: [1, 1], v76: [1, 1], v755: [1, 1], v74: [2, 0], v70: [2, 0],
  });
  // Equal quality and equal cost inside a band: registry order.
  assert.deepEqual(ids(rows), ['v80', 'v76', 'v755', 'v70', 'v74']);
});

test('rule: a key where lower is better is turned around', (t) => {
  const registry = tiny([
    { id: 'slow', scores: { overall: 50, minutes: 9 } },
    { id: 'fast', scores: { overall: 50, minutes: 2 } },
    { id: 'mid', scores: { overall: 50, minutes: 5.5 } },
  ], {
    categories: {
      overall: { label: 'Overall', scale: '0-100', tie: 5, source: 'Test' },
      minutes: { label: 'Time', scale: 'minutes', tie: 0, source: 'Test', lowerIsBetter: true },
    },
    domains: { chore: { label: 'chore', keys: ['minutes', 'overall'] } },
  });
  const { router } = routerFor(t, registry, { thrift: 0 });
  const table = router.explain({ role: 'maker', domain: 'chore' });
  assert.equal(table.lowerIsBetter, true);
  assert.deepEqual(table.candidates.map((row) => [row.id, row.value, row.q]), [['fast', 2, 1], ['mid', 5.5, 0.5], ['slow', 9, 0]]);
  assert.equal(router.pick({ role: 'maker', domain: 'chore' }).why, 'chore: minutes 2 vs 5.5 (Test), thrift 0');
});

test('rule: a candidate without a number ranks last; with no complete key the key is "overall"', (t) => {
  const registry = tiny([
    { id: 'blank', scores: { overall: null, coding: 99 }, price: { in: 0.1, out: 0.1 } },
    { id: 'low', scores: { overall: 40, coding: null }, price: { in: 5, out: 5 } },
    { id: 'high', scores: { overall: 90, coding: 50 }, price: { in: 9, out: 9 } },
  ], {
    categories: {
      overall: { label: 'Overall', scale: '0-100', tie: 5, source: 'Test' },
      coding: { label: 'Coding', scale: '0-100', tie: 5, source: 'Test' },
    },
    domains: { backend: { label: 'backend', keys: ['coding', 'overall'] } },
  });
  for (const thrift of [0, 0.3, 1]) {
    const { router } = routerFor(t, registry, { thrift });
    const table = router.explain({ role: 'maker', domain: 'backend' });
    assert.equal(table.key, 'overall', 'no key has a number for everyone');
    assert.deepEqual(table.keysTried, [{ key: 'coding', missing: ['low'] }, { key: 'overall', missing: ['blank'] }]);
    assert.equal(ids(table.candidates).at(-1), 'blank', `thrift ${thrift}: the model without a number is last, however cheap`);
    assert.deepEqual(table.candidates.at(-1).missing, true);
    assert.equal(table.candidates.at(-1).value, null);
    assert.equal(table.pick.model, thrift === 1 ? 'low' : 'high');
  }
  // Only models without any number: cost and order still give one answer.
  const none = routerFor(t, tiny([{ id: 'n1', scores: { overall: null } }, { id: 'n2', scores: { overall: null }, price: { in: 0.5, out: 0.5 } }]));
  const pick = none.router.pick({ role: 'maker', domain: 'backend' });
  assert.equal(pick.model, 'n2');
  assert.equal(pick.why, 'backend: overall none vs none (Test), no candidate has a score so cost and order decide, thrift 0.3');
  // A scored model against one without a score.
  const mixed = routerFor(t, tiny([{ id: 'n1', scores: { overall: null } }, { id: 's1', scores: { overall: 10 } }]));
  assert.equal(mixed.router.pick({ role: 'maker', domain: 'backend' }).why, 'backend: overall 10 vs none (Test), thrift 0.3');
});

test('rule: cost is (in + 3 * out) / 4, min-max over the candidates', (t) => {
  const registry = tiny([
    { id: 'x', scores: { overall: 80 }, price: { in: 8, out: 40 } },
    { id: 'y', scores: { overall: 60 }, price: { in: 2, out: 10 } },
    { id: 'z', scores: { overall: 40 }, price: { in: 0.1, out: 0.5 } },
  ]);
  const { router } = routerFor(t, registry, { thrift: 0.5 });
  const rows = Object.fromEntries(router.explain({ role: 'maker', domain: 'backend' }).candidates.map((row) => [row.id, row]));
  assert.deepEqual([rows.x.cost, rows.y.cost, rows.z.cost], [32, 8, 0.4]);
  near(rows.x.c, 1);
  near(rows.y.c, (8 - 0.4) / (32 - 0.4));
  near(rows.z.c, 0);
  near(rows.x.utility, 1 - 0.5 * 1);
  near(rows.y.utility, 0.5 - 0.5 * (7.6 / 31.6));
  near(rows.z.utility, 0);
  // Equal prices: the cost part is 0 for everyone.
  const flat = routerFor(t, tiny([{ id: 'x', scores: { overall: 80 } }, { id: 'y', scores: { overall: 60 } }]), { thrift: 1 });
  assert.deepEqual(flat.router.explain({ role: 'maker', domain: 'backend' }).candidates.map((row) => [row.id, row.c, row.utility]), [['x', 0, 1], ['y', 0, 0]]);
});

test('rule: thrift 0 = best model always, thrift 1 = cheapest that fits, and thrift comes from getSettings()', (t) => {
  const registry = tiny([
    { id: 'best', scores: { overall: 90 }, price: { in: 10, out: 10 } },
    { id: 'mid', scores: { overall: 80 }, price: { in: 6, out: 6 } },
    { id: 'cheap', scores: { overall: 40 }, price: { in: 1, out: 1 } },
    { id: 'cheap2', scores: { overall: 55 }, price: { in: 1, out: 1 } },
  ]);
  const at = (thrift) => routerFor(t, registry, { thrift }).router.pick({ role: 'maker', domain: 'backend' }).model;
  assert.equal(at(0), 'best');
  assert.equal(at(0.3), 'best'); // 1 - 0.3 = 0.7 against mid 0.8 - 0.3 * 0.556 = 0.633
  assert.equal(at(0.6), 'mid'); // 0.4 against 0.467
  assert.equal(at(1), 'cheap2'); // the cheapest. Two models cost the same: the better one of them
  const table = routerFor(t, registry, { thrift: 1 }).router.explain({ role: 'maker', domain: 'backend' });
  assert.deepEqual(ids(table.candidates), ['cheap2', 'cheap', 'mid', 'best']); // by cost first, then by utility
  // The setting is read on every pick.
  let thrift = 0;
  const { router } = routerFor(t, registry, { settings: undefined, getSettings: () => ({ thrift }) });
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'best');
  thrift = 1;
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'cheap2');
  // A missing or broken setting means the default 0.3. Values outside 0..1 are clamped.
  const why = (getSettings) => routerFor(t, registry, { getSettings }).router.pick({ role: 'maker', domain: 'backend' }).why;
  assert.match(why(() => ({})), /thrift 0\.3$/);
  assert.match(why(() => ({ thrift: 'high' })), /thrift 0\.3$/);
  assert.match(why(() => null), /thrift 0\.3$/);
  assert.match(why(() => { throw new Error('settings are gone'); }), /thrift 0\.3$/);
  assert.match(why(undefined), /thrift 0\.3$/);
  assert.match(why(() => ({ thrift: 7 })), /thrift 1$/);
  assert.match(why(() => ({ thrift: -2 })), /thrift 0$/);
});

test('rule: at thrift 1 a pricier model never wins, even when q - c is higher for it', (t) => {
  // The shape of the shipped makers: best 81 / cost 8, mid 76 / cost 6, cheap 59 / cost 0.4.
  // q - c: best 1 - 1 = 0, mid 17/22 - 5.6/7.6 = 0.035885, cheap 0. The plain formula would pick "mid".
  const registry = tiny([
    { id: 'best', scores: { overall: 81 }, price: { in: 8, out: 8 } },
    { id: 'mid', scores: { overall: 76 }, price: { in: 6, out: 6 } },
    { id: 'cheap', scores: { overall: 59 }, price: { in: 0.4, out: 0.4 } },
  ]);
  const { router } = routerFor(t, registry, { thrift: 1 });
  const table = router.explain({ role: 'maker', domain: 'backend' });
  assert.deepEqual(table.candidates.map((row) => [row.id, row.utility]), [['cheap', 0], ['mid', 0.035885], ['best', 0]]);
  assert.equal(table.pick.model, 'cheap');
  assert.match(table.pick.why, /the cheapest wins, thrift 1$/);
  // Just under 1 the formula decides.
  assert.equal(routerFor(t, registry, { thrift: 0.99 }).router.pick({ role: 'maker', domain: 'backend' }).model, 'mid');
});

test('rule: effort is boss high, manager medium, maker S low / M medium / L high, clamped to the model', (t) => {
  const five = ['low', 'medium', 'high', 'xhigh', 'max'];
  const effort = (efforts, query) => {
    const tiers = [query.role];
    return routerFor(t, tiny([{ id: 'm', tiers, efforts }])).router.pick({ domain: 'backend', ...query }).effort;
  };
  assert.equal(effort(five, { role: 'boss' }), 'high');
  assert.equal(effort(five, { role: 'manager' }), 'medium');
  assert.equal(effort(five, { role: 'maker', size: 'S' }), 'low');
  assert.equal(effort(five, { role: 'maker', size: 'M' }), 'medium');
  assert.equal(effort(five, { role: 'maker', size: 'L' }), 'high');
  assert.equal(effort(five, { role: 'maker' }), 'medium'); // no size
  // Clamp: the highest level of the model that is not above the wanted one. Else its lowest level.
  assert.equal(effort(['low', 'medium'], { role: 'boss' }), 'medium');
  assert.equal(effort(['low'], { role: 'boss' }), 'low');
  assert.equal(effort(['low', 'medium', 'high'], { role: 'boss' }), 'high'); // Gemini 4 Carbon
  assert.equal(effort(['high', 'max'], { role: 'maker', size: 'S' }), 'high'); // nothing at or under low
  assert.equal(effort(['xhigh', 'max'], { role: 'manager' }), 'xhigh');
  assert.equal(effort(['low', 'high'], { role: 'manager' }), 'low');
  assert.equal(effort(['max', 'medium'], { role: 'boss' }), 'medium');
  assert.equal(effort(['max', 'low'], { role: 'boss' }), 'low');
  assert.equal(effort(['low', 'xhigh'], { role: 'boss' }), 'low'); // never above the wanted level when a lower one exists
  assert.equal(effort([], { role: 'boss' }), null); // the model takes no effort setting
  assert.equal(effort(['turbo'], { role: 'boss' }), 'turbo'); // an unknown name is the only choice
  assert.equal(effort(['turbo', 'medium'], { role: 'boss' }), 'medium');
});

test('rule: providers.usable must answer true; anything else counts as not usable', (t) => {
  const registry = tiny([{ id: 'a', provider: 'a' }]);
  const file = path.join(tempDir(t), 'models.json');
  writeFileSync(file, JSON.stringify(registry));
  const make = (providers) => {
    const logs = [];
    const router = createRouter({ modelsPath: file, providers, getSettings: () => ({}), log: (level, msg) => logs.push(`${level} ${msg}`) });
    return { router, logs };
  };
  assert.equal(make({ usable: () => true }).router.pick({ role: 'maker' }).model, 'a');
  for (const answer of [false, undefined, null, 1, 'yes', Promise.resolve(true)]) {
    const { router, logs } = make({ usable: () => answer });
    assert.equal(router.pick({ role: 'maker' }), null);
    router.pick({ role: 'maker' });
    if (answer !== false) assert.deepEqual(logs.filter((line) => line.startsWith('warn')), ['warn router: providers.usable must return true or false']);
  }
  const broken = make({ usable: () => { throw new Error('detect failed'); } });
  assert.equal(broken.router.pick({ role: 'maker' }), null);
  assert.ok(broken.logs.some((line) => line === 'warn router: providers.usable failed'));
  assert.equal(make(undefined).router.pick({ role: 'maker' }), null);
  assert.equal(make({}).router.pick({ role: 'maker' }), null);
  // leaders() does not ask the providers.
  assert.equal(make(undefined).router.leaders().backend.maker[0].id, 'a');
  // usable() is asked once per lab and pick.
  let calls = 0;
  const counted = make({ usable: () => { calls += 1; return true; } });
  counted.router.pick({ role: 'maker' });
  assert.equal(calls, 1);
});

test('rule: scheduled prices (price.next) apply from their date on', (t) => {
  const registry = tiny([
    { id: 'x', scores: { overall: 80 }, price: { in: 2, out: 10, next: { from: '2026-12-01', in: 4, out: 20 } } },
    { id: 'y', scores: { overall: 79 }, price: { in: 3, out: 12 } },
  ]);
  const cost = (now) => Object.fromEntries(routerFor(t, registry, { now }).router.explain({ role: 'maker' }).candidates.map((row) => [row.id, row.cost]));
  assert.deepEqual(cost(new Date(2026, 10, 30, 12).getTime()), { x: 8, y: 9.75 });
  assert.deepEqual(cost(new Date(2026, 11, 1, 0, 0, 1).getTime()), { x: 16, y: 9.75 });
  assert.deepEqual(cost(new Date(2027, 5, 1).getTime()), { x: 16, y: 9.75 });
  // The pick follows: a tie on quality, so the cheaper model wins.
  assert.equal(routerFor(t, registry, { now: new Date(2026, 10, 30).getTime() }).router.pick({ role: 'maker' }).model, 'x');
  assert.equal(routerFor(t, registry, { now: new Date(2026, 11, 2).getTime() }).router.pick({ role: 'maker' }).model, 'y');
});

// ---------------------------------------------------------------------------------------------
// 4. registry(), save(), reload()
// ---------------------------------------------------------------------------------------------

test('api: registry() returns a private copy', (t) => {
  const { router } = routerFor(t, tiny([{ id: 'a', scores: { overall: 60 } }, { id: 'b', scores: { overall: 90 } }]));
  const copy = router.registry();
  copy.models[1].enabled = false;
  copy.models.length = 1;
  copy.domains.backend.keys = ['nope'];
  assert.equal(router.registry().models.length, 2);
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'b');
  assert.notEqual(router.registry(), router.registry());
});

test('api: save() validates, writes atomically and routes with the new registry', (t) => {
  const { router, file, logs } = routerFor(t, tiny([{ id: 'a', scores: { overall: 60 } }, { id: 'b', scores: { overall: 90 } }]));
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'b');
  const next = router.registry();
  next.models[1].enabled = false;
  next.ownerNote = 'extra fields stay';
  next.models[0].benchlmSlug = 'model-a';
  const saved = router.save(next);
  assert.equal(saved.models[1].enabled, false);
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'a');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, router.registry());
  assert.equal(onDisk.ownerNote, 'extra fields stay');
  assert.equal(onDisk.models[0].benchlmSlug, 'model-a');
  assert.ok(readFileSync(file, 'utf8').endsWith('}\n'));
  assert.deepEqual(readdirSync(path.dirname(file)), ['models.json'], 'no temp file is left');
  assert.ok(logs.some((entry) => entry.level === 'info' && entry.msg === 'router: registry saved'));
  // The object that was passed in is not kept: later changes to it do nothing.
  next.models[0].enabled = false;
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'a');
  // A new router reads the saved file.
  assert.equal(makeRouter({ modelsPath: file, usable: ['claude'] }).router.pick({ role: 'maker', domain: 'backend' }).model, 'a');
});

test('api: save() of the unchanged shipped registry writes the same bytes', onShippedFile, (t) => {
  const file = path.join(tempDir(t), 'models.json');
  writeFileSync(file, SHIPPED_TEXT);
  const { router } = makeRouter({ modelsPath: file });
  router.save(router.registry());
  assert.equal(readFileSync(file, 'utf8'), SHIPPED_TEXT);
});

test('api: save() twice writes the same bytes: the file has one fixed form', (t) => {
  const file = path.join(tempDir(t), 'models.json');
  writeFileSync(file, JSON.stringify(shipped())); // one line, as an editor or another tool may leave it
  const { router } = makeRouter({ modelsPath: file });
  router.save(router.registry());
  const first = readFileSync(file, 'utf8');
  router.save(router.registry());
  assert.equal(readFileSync(file, 'utf8'), first);
  assert.deepEqual(JSON.parse(first), validateRegistry(shipped()));
  assert.ok(first.split('\n').length > 100, 'saved with line breaks, so that the owner can read it');
});

test('api: save() refuses a registry with a wrong shape and keeps the file and the routing', (t) => {
  const base = tiny([{ id: 'a', scores: { overall: 60 } }, { id: 'b', scores: { overall: 90 } }]);
  const { router, file } = routerFor(t, base);
  const before = readFileSync(file, 'utf8');
  const cases = [
    [(r) => null, /must be a JSON object/],
    [(r) => [], /must be a JSON object/],
    [(r) => { r.version = 2; }, /version must be 1/],
    [(r) => { delete r.dataDate; }, /dataDate/],
    [(r) => { r.attribution = { text: 'x' }; }, /attribution/],
    [(r) => { delete r.categories.overall; }, /"overall"/],
    [(r) => { r.categories.overall.tie = -1; }, /categories\.overall\.tie/],
    [(r) => { r.categories.overall.tie = '5'; }, /categories\.overall\.tie/],
    [(r) => { delete r.categories.overall.label; }, /categories\.overall\.label/],
    [(r) => { delete r.categories.overall.scale; }, /categories\.overall\.scale/],
    [(r) => { delete r.categories.overall.source; }, /categories\.overall\.source/],
    [(r) => { r.categories.overall.lowerIsBetter = 'yes'; }, /lowerIsBetter/],
    [(r) => { r.categories['bad key'] = { ...r.categories.overall }; }, /categories\.bad key/],
    [(r) => { r.categories.constructor = { ...r.categories.overall }; }, /categories\.constructor/],
    [(r) => { delete r.domains.vision; }, /domains must have "vision"/],
    [(r) => { r.domains.plan.keys = ['overall', 'overall']; }, /must not repeat/],
    [(r) => { r.domains.plan.keys = []; }, /domains\.plan\.keys/],
    [(r) => { r.domains.plan.keys = ['speed', 'overall']; }, /"speed" is not a category/],
    [(r) => { r.categories.speed = { ...r.categories.overall }; r.domains.plan.keys = ['overall', 'speed']; }, /must end with "overall"/],
    [(r) => { r.models = []; }, /one model or more/],
    [(r) => { r.models = 'all'; }, /models must be a list/],
    [(r) => { r.models[1].id = 'a'; }, /this id is in the list twice/],
    [(r) => { r.models[0].id = '--dangerously-skip-permissions'; }, /models\[0\].*id/],
    [(r) => { r.models[0].id = 'has space'; }, /models\[0\].*id/],
    [(r) => { r.models[0].id = 'model;reboot'; }, /models\[0\].*id/],
    [(r) => { r.models[0].id = '$(whoami)'; }, /models\[0\].*id/],
    [(r) => { r.models[0].id = 'model"quote'; }, /models\[0\].*id/],
    [(r) => { r.models[0].id = `m${'x'.repeat(80)}`; }, /models\[0\].*id/],
    [(r) => { r.models[0].id = 7; }, /models\[0\]\.id/],
    [(r) => { r.models[0].provider = 'Claude Inc'; }, /provider/],
    [(r) => { r.models[0].label = ''; }, /label/],
    [(r) => { r.models[0].tiers = []; }, /tiers/],
    [(r) => { r.models[0].tiers = ['maker', 'janitor']; }, /tiers/],
    [(r) => { r.models[0].tiers = ['maker', 'maker']; }, /tiers/],
    [(r) => { r.models[0].power = 6; }, /power must be a whole number from 1 to 5/],
    [(r) => { r.models[0].power = 2.5; }, /power/],
    [(r) => { r.models[0].price = { in: 1 }; }, /price/],
    [(r) => { r.models[0].price = { in: -1, out: 1 }; }, /price/],
    [(r) => { r.models[0].price.next = { from: 'soon', in: 1, out: 1 }; }, /price\.next/],
    [(r) => { r.models[0].efforts = 'high'; }, /efforts/],
    [(r) => { r.models[0].efforts = ['high', 'high']; }, /efforts/],
    [(r) => { r.models[0].efforts = ['--model x']; }, /efforts/],
    [(r) => { r.models[0].efforts = ['High']; }, /efforts/],
    [(r) => { r.models[0].enabled = 'yes'; }, /enabled must be true or false/],
    [(r) => { r.models[0].estimated = 1; }, /estimated/],
    [(r) => { r.models[0].planNote = 7; }, /planNote/],
    [(r) => { r.models[0].planNote = 'x'.repeat(501); }, /planNote must be text of at most 500/],
    [(r) => { r.models[0].price.note = 'x'.repeat(501); }, /price\.note must be text of at most 500/],
    [(r) => { r.models[0].scores = null; }, /scores must be an object/],
    [(r) => { r.models[0].scores.overall = '60'; }, /scores\.overall must be a number or null/],
    [(r) => { r.models[0].scores.overall = Number.NaN; }, /scores\.overall must be a number or null/],
    [(r) => { r.models[0].scores.mystery = 5; }, /unknown key "mystery"/],
  ];
  for (const [change, pattern] of cases) {
    const candidate = structuredClone(base);
    const replaced = change(candidate);
    assert.throws(() => router.save(replaced === undefined ? candidate : replaced), (err) => {
      assert.match(err.message, pattern);
      assert.equal(err.status, 400);
      return true;
    }, String(pattern));
  }
  assert.equal(readFileSync(file, 'utf8'), before, 'the file did not change');
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'b');
  assert.deepEqual(readdirSync(path.dirname(file)), ['models.json']);
});

test('api: save() fills what may be left out and keeps null scores', (t) => {
  const { router, file } = routerFor(t, tiny([{ id: 'a' }]));
  const next = router.registry();
  next.categories.coding = { label: 'Coding', scale: '0-100', tie: 5, source: 'Test' };
  delete next.models[0].planNote;
  delete next.models[0].estimated;
  delete next.models[0].price.note;
  next.models[0].scores = { overall: null };
  router.save(next);
  const model = JSON.parse(readFileSync(file, 'utf8')).models[0];
  assert.deepEqual(model.scores, { overall: null, coding: null });
  assert.equal(model.planNote, '');
  assert.equal(model.estimated, false);
  assert.equal(model.price.note, '');
});

test('api: save() accepts the id forms that agent CLIs use, and labs other than the three shipped ones', (t) => {
  const base = tiny([{ id: 'a' }]);
  const { router } = routerFor(t, base);
  for (const id of ['gemini-3.8-flash', 'claude-fable-5-2[1m]', 'models/gemini-4-carbon', 'org:model@v2', 'Mixed_Case-1']) {
    const next = structuredClone(base);
    next.models.push({ ...next.models[0], id, provider: 'mock', efforts: ['low', 'xhigh', 'ultracode'] });
    assert.equal(router.save(next).models.at(-1).id, id);
  }
  assert.equal(router.registry().models.length, 2, 'a save replaces the registry');
});

test('api: save() reports a disk error with status 500 and keeps routing with the old registry', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, (t) => {
  const { router, file } = routerFor(t, tiny([{ id: 'a', scores: { overall: 60 } }, { id: 'b', scores: { overall: 90 } }]));
  const next = router.registry();
  next.models[1].enabled = false;
  chmodSync(path.dirname(file), 0o500);
  assert.throws(() => router.save(next), (err) => err.status === 500 && /Cannot save the model registry/.test(err.message));
  chmodSync(path.dirname(file), 0o700);
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'b');
  assert.deepEqual(readdirSync(path.dirname(file)), ['models.json']);
});

test('api: reload() reads the file again; a broken file keeps the registry in memory', (t) => {
  const base = tiny([{ id: 'a', scores: { overall: 60 } }, { id: 'b', scores: { overall: 90 } }]);
  const { router, file } = routerFor(t, base);
  const edited = structuredClone(base);
  edited.models[1].enabled = false;
  writeFileSync(file, JSON.stringify(edited));
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'b', 'not read yet');
  assert.equal(router.reload().models[1].enabled, false);
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'a');
  writeFileSync(file, '{ "version": 1, ');
  assert.throws(() => router.reload(), (err) => err.status === 500 && /not valid JSON/.test(err.message));
  writeFileSync(file, JSON.stringify({ ...edited, models: [] }));
  assert.throws(() => router.reload(), (err) => err.status === 500 && /is not valid: models must be a list with one model or more/.test(err.message));
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'a', 'the last good registry is still used');
});

test('api: a missing registry file falls back to the shipped registry; without one the router does not start', (t) => {
  const dir = tempDir(t);
  const missing = path.join(dir, 'config', 'models.json');
  const { router, logs } = makeRouter({ modelsPath: missing });
  assert.deepEqual(router.registry(), validateRegistry(shipped()));
  assert.deepEqual(logs.map((entry) => `${entry.level} ${entry.msg}`), ['warn router: no registry file yet, using the shipped registry']);
  assert.equal(existsSync(missing), false, 'reading does not create the file');
  // save() creates the folder and the file.
  router.save(router.registry());
  assert.equal(readFileSync(missing, 'utf8'), `${JSON.stringify(validateRegistry(shipped()), null, 2)}\n`);
  // No shipped copy to fall back on.
  assert.throws(() => makeRouter({ modelsPath: path.join(dir, 'none.json'), defaultsPath: null }), (err) => err.status === 500 && /Cannot read the model registry/.test(err.message));
  assert.throws(() => makeRouter({ modelsPath: path.join(dir, 'none.json'), defaultsPath: path.join(dir, 'also-none.json') }), /or the shipped copy/);
  // A file that exists but is broken is an error, not a reason to fall back.
  const broken = path.join(dir, 'broken.json');
  writeFileSync(broken, 'not json');
  assert.throws(() => makeRouter({ modelsPath: broken }), /not valid JSON/);
  assert.throws(() => createRouter({}), /needs modelsPath/);
});

test('api: router.js and benchlm.js use no console, no child process and only built-in modules', () => {
  for (const name of ['router.js', 'benchlm.js']) {
    const source = readFileSync(path.join(ROOT, 'server', name), 'utf8');
    assert.doesNotMatch(source, /console\./, `${name} must not use console`);
    const imports = [...source.matchAll(/\bfrom '([^']+)'/g)].map((match) => match[1]);
    assert.ok(imports.length > 0);
    for (const spec of imports) assert.match(spec, /^node:/, `${name} imports ${spec}`);
    assert.doesNotMatch(source, /\bimport\(/, `${name} has no dynamic import`);
    assert.doesNotMatch(source, /\brequire\(/, `${name} is ESM`);
    assert.doesNotMatch(source, /child_process/, `${name} never starts a process`);
  }
  // Only the BenchLM refresh talks to the network, and only through the fetch function it is given.
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'server', 'router.js'), 'utf8'), /\bfetch\b|node:https?|node:net/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'server', 'benchlm.js'), 'utf8'), /node:https?|node:net/);
});
