// Adversarial tests for server/router.js, server/benchlm.js and config/models.json.
// Run: node --test tests/router.adversarial.test.mjs
//
// Each test in groups 1 and 2 was written to fail on a real defect, and passes since the fix:
//   1. Router: numbers that break the math, malformed registries, the model list of a lab.
//   2. BenchLM refresh: the 10 minute rule after a failed round, dates that move without data,
//      scores outside 0..100, a half-applied refresh, a bad ETag in the cache, a clock that jumped back.
// Group 3 holds seeded random checks of the pick rules and of the refresh against broken files.
// Group 4 checks the shipped numbers against each other.
// No network: the refresh gets a fetch stand-in. No AI CLI. Files only in temp folders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRouter, validateRegistry, DOMAINS, ROLES } from '../server/router.js';
import { createBenchlm, extractLeaderboard } from '../server/benchlm.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = path.join(ROOT, 'config', 'models.json');
const shipped = () => JSON.parse(readFileSync(SHIPPED, 'utf8'));

/** A hash of everything in a registry that decides a pick or comes from the research file. No notes, no labels of keys. */
function routingFingerprint(registry) {
  const data = {
    categories: Object.entries(registry.categories).map(([key, c]) => [key, c.scale, c.tie, c.source, c.board ?? null, c.lowerIsBetter === true]),
    domains: Object.entries(registry.domains).map(([name, d]) => [name, d.keys]),
    models: registry.models.map((m) => [
      m.id, m.provider, m.label, m.tiers, m.power, m.enabled, m.estimated, m.price.in, m.price.out, m.price.next ?? null, m.efforts,
      m.benchlmSlug ?? null, Object.entries(m.scores),
    ]),
    dataDate: registry.dataDate,
    fetchedAt: registry.fetchedAt,
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
// The routing data as shipped on 2026-11-15 (BenchLM data of 2026-11-13). A BenchLM refresh or an edit
// of the owner changes it. The tests on the shipped numbers are then skipped, not failed.
const SHIPPED_ROUTING_SHA256 = 'a55a5c304c283976ef230103078e3b8a482ac73fac6fd1309282e6e08dc3837b';
const onShippedData = {
  skip: routingFingerprint(shipped()) === SHIPPED_ROUTING_SHA256
    ? false : 'config/models.json holds other routing data than the shipped file (a refresh or an edit)',
};

const NOV_15 = new Date(2026, 10, 15, 12).getTime(); // local time, before the price change of 2026-12-01
const NOON = new Date(2026, 10, 20, 12).getTime();
const MINUTE = 60 * 1000;
const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workshop-adversarial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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

let fileCount = 0;
/** Writes a registry to a temp folder and returns a router on it, plus what it logged. */
function routerFor(t, registry, { usable = ['claude', 'gemini', 'openai'], thrift = 0.3, settings, providers, now = NOV_15 } = {}) {
  const file = path.join(tempDir(t), `models-${fileCount += 1}.json`);
  writeFileSync(file, JSON.stringify(registry));
  const logs = [];
  const router = createRouter({
    modelsPath: file,
    providers: providers ?? { usable: (id) => usable.includes(id) },
    getSettings: () => settings ?? { thrift },
    log: (level, msg, data) => logs.push({ level, msg, data }),
    now: () => now,
  });
  return { router, logs, file };
}

/** Deterministic random numbers (the tests must not depend on Math.random). */
function seeded(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return { next, of: (list) => list[Math.floor(next() * list.length)], chance: (p) => next() < p };
}

/** Replaces one random node of a JSON tree with junk, or deletes it. Returns the path of the node. */
function mutate(root, random, junk) {
  const paths = [];
  (function walk(node, trail) {
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      paths.push([...trail, key]);
      walk(node[key], [...trail, key]);
    }
  }(root, []));
  const trail = random.of(paths);
  let at = root;
  for (const key of trail.slice(0, -1)) at = at[key];
  if (random.chance(0.15)) delete at[trail.at(-1)];
  else at[trail.at(-1)] = random.of(junk);
  return trail.join('.');
}

// --- a stand-in for benchlm.ai: no socket is opened -----------------------------------------------

const manifestFor = (dataVersion) => ({
  schemaVersion: 'benchlm-export-manifest/v1',
  files: [{ name: 'leaderboard.json', dataVersion, sourceLastUpdated: 'November 20, 2026' }],
});

/** leaderboard.json in the shape of report section 3.6. rows: [slug, name, overall, { board: score }, evidence]. */
function leaderboardFor(rows, { date = 'November 20, 2026' } = {}) {
  const items = rows.map(([slug, model, overall, , evidence = 'supported'], i) => ({
    rank: i + 1, slug, canonicalModelKey: slug, model, displayScore: overall, evidenceStatus: evidence,
    overallRank: i + 1, score: overall, category: null, categoryLabel: null,
  }));
  const categories = {};
  for (const [slug, model, overall, boards = {}] of rows) {
    for (const [board, score] of Object.entries(boards)) {
      (categories[board] ??= []).push({ rank: 1, slug, model, score, displayScore: overall, category: board }); // displayScore: the overall score
    }
  }
  return { schemaVersion: '1.0', name: 'BenchLM leaderboards', sourceLastUpdated: date, items, categories };
}

/** A fetch function that serves the two files from memory and records every call. */
function fakeSite(files) {
  const site = {
    files, calls: [], etag: '"m1"',
    /** Set to a function (name, url, init) to answer in another way: return a Response, a promise, or throw. */
    answer: null,
    names: () => site.calls.map((call) => call.name),
  };
  site.fetch = async (url, init) => {
    const name = String(url).endsWith('/manifest.json') ? 'manifest.json' : String(url).endsWith('/leaderboard.json') ? 'leaderboard.json' : 'other';
    site.calls.push({ name, url: String(url), headers: { ...init?.headers } });
    if (site.answer) {
      const custom = await site.answer(name, url, init);
      if (custom !== undefined) return custom;
    }
    const body = name === 'manifest.json' ? site.files.manifest : site.files.leaderboard;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag: site.etag } });
  };
  return site;
}

/** A refresher on the stand-in, with a clock that the test moves by hand. */
function benchlmFor(site, options = {}) {
  const clock = { now: NOON };
  const logs = [];
  const benchlm = createBenchlm({
    fetchImpl: site.fetch, now: () => clock.now, timeoutMs: 2000,
    log: (level, msg, data) => logs.push({ level, msg, data }), ...options,
  });
  return { benchlm, clock, logs };
}

/** Two real models with two BenchLM boards and one key from another source. */
function boardRegistry() {
  return tiny([
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', scores: { overall: 83.05, coding: 80.97, arenaWebDevElo: 1772 } },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', provider: 'gemini', enabled: false, scores: { overall: 79.06, coding: 75.75, arenaWebDevElo: 1704 } },
  ], {
    categories: {
      overall: { label: 'Overall', scale: '0-100', tie: 5, source: 'BenchLM', board: 'overall', date: '2026-11-13' },
      coding: { label: 'Coding', scale: '0-100', tie: 5, source: 'BenchLM', board: 'coding', date: '2026-11-13' },
      arenaWebDevElo: { label: 'Arena WebDev Elo', scale: 'elo', tie: 20, source: 'Arena', date: '2026-11-11' },
    },
  });
}
const GOOD_ROWS = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 84, { coding: 82.11 }],
  ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', 80.2, { coding: 77.5 }],
];

// ---------------------------------------------------------------------------------------------
// 1. Router
// ---------------------------------------------------------------------------------------------

test('router math: numbers that would overflow are refused, the largest allowed numbers give finite q, c and utility', (t) => {
  // Before the fix: scores 1e308 and -1e308 passed the check and gave q = NaN and utility = NaN.
  const refuse = (change, pattern) => {
    const registry = tiny([{ id: 'a', scores: { overall: 60 } }, { id: 'b', scores: { overall: 40 } }]);
    change(registry);
    assert.throws(() => validateRegistry(registry), (err) => err.status === 400 && pattern.test(err.message), String(pattern));
  };
  refuse((r) => { r.models[0].scores.overall = 1e308; }, /models\[0\].*scores\.overall/);
  refuse((r) => { r.models[1].scores.overall = -1e308; }, /models\[1\].*scores\.overall/);
  refuse((r) => { r.models[0].price.in = 1e308; }, /models\[0\].*price/);
  refuse((r) => { r.models[0].price.out = 1e300; }, /models\[0\].*price/);
  refuse((r) => { r.models[0].price.next = { from: '2026-12-01', in: 1, out: 1e300 }; }, /price\.next/);
  refuse((r) => { r.categories.overall.tie = 1e308; }, /categories\.overall\.tie/);

  // The largest numbers that pass: nothing turns into NaN or Infinity.
  const registry = tiny([
    { id: 'top', scores: { overall: 1e9 }, price: { in: 1e9, out: 1e9 } },
    { id: 'low', scores: { overall: -1e9 }, price: { in: 0, out: 0 } },
    { id: 'mid', scores: { overall: 0 }, price: { in: 1, out: 1 } },
  ]);
  for (const thrift of [0, 0.3, 1]) {
    const { router } = routerFor(t, registry, { thrift });
    const table = router.explain({ role: 'maker', domain: 'backend' });
    assert.equal(table.candidates.length, 3);
    for (const row of table.candidates) {
      for (const field of ['q', 'cost', 'c', 'utility']) assert.ok(Number.isFinite(row[field]), `thrift ${thrift}: ${row.id}.${field} = ${row[field]}`);
      assert.ok(row.q >= 0 && row.q <= 1 && row.c >= 0 && row.c <= 1);
    }
    assert.equal(table.pick.model, thrift === 1 ? 'low' : 'top');
    assert.doesNotMatch(JSON.stringify(table), /null,"utility"|NaN|Infinity/);
  }
});

test('router math: equal candidates, one candidate, no scores and zero prices never divide by zero', (t) => {
  const numbersAreFinite = (table) => {
    for (const row of table.candidates) {
      for (const field of ['q', 'cost', 'c', 'utility']) assert.ok(Number.isFinite(row[field]), `${row.id}.${field} = ${row[field]}`);
    }
  };
  // All equal: same score, same price. q is 1 for all, c is 0 for all, registry order decides.
  const same = routerFor(t, tiny([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), { thrift: 0.5 }).router;
  const equal = same.explain({ role: 'maker', domain: 'backend' });
  numbersAreFinite(equal);
  assert.deepEqual(equal.candidates.map((row) => [row.id, row.q, row.c, row.utility]), [['a', 1, 0, 1], ['b', 1, 0, 1], ['c', 1, 0, 1]]);
  assert.equal(equal.pick.model, 'a');
  assert.equal(equal.pick.why, 'backend: overall 50 vs 50 (Test), equal scores so registry order decides, thrift 0.5');
  // One candidate.
  const one = routerFor(t, tiny([{ id: 'solo' }]), { thrift: 1 }).router.explain({ role: 'maker', domain: 'backend' });
  numbersAreFinite(one);
  assert.deepEqual(one.candidates.map((row) => [row.id, row.q, row.c, row.utility]), [['solo', 1, 0, 1]]);
  assert.equal(one.pick.why, 'backend: overall 50 (Test), only candidate, thrift 1');
  // No score anywhere and all prices zero.
  const blank = tiny([
    { id: 'n1', scores: { overall: null }, price: { in: 0, out: 0 } },
    { id: 'n2', scores: { overall: null }, price: { in: 0, out: 0 } },
  ]);
  for (const thrift of [0, 0.3, 1]) {
    const table = routerFor(t, blank, { thrift }).router.explain({ role: 'maker', domain: 'backend' });
    numbersAreFinite(table);
    assert.equal(table.pick.model, 'n1', `thrift ${thrift}`);
  }
  // One score and a tie value of 0, with a key where lower is better and all values equal.
  const flat = tiny([{ id: 'x', scores: { overall: 50, minutes: 3 } }, { id: 'y', scores: { overall: 50, minutes: 3 } }], {
    categories: {
      overall: { label: 'Overall', scale: '0-100', tie: 0, source: 'Test' },
      minutes: { label: 'Time', scale: 'minutes', tie: 0, source: 'Test', lowerIsBetter: true },
    },
    domains: { chore: { label: 'chore', keys: ['minutes', 'overall'] } },
  });
  const chore = routerFor(t, flat, { thrift: 0 }).router.explain({ role: 'maker', domain: 'chore' });
  numbersAreFinite(chore);
  assert.deepEqual(chore.candidates.map((row) => [row.id, row.q]), [['x', 1], ['y', 1]]);
});

test('router shape: a malformed registry gives a plain error (status 400 for save, 500 for a file), never a TypeError', (t) => {
  const base = tiny([{ id: 'a', scores: { overall: 60 } }, { id: 'b', scores: { overall: 90 } }]);
  const { router, file } = routerFor(t, base);
  const before = readFileSync(file, 'utf8');
  const noText = Object.create(null); // String(noText) throws
  const cases = [
    (r) => { r.domains.plan.keys = [{ toString: 1 }, 'overall']; }, // what JSON.parse gives for {"toString":1}
    (r) => { r.domains.plan.keys = [noText, 'overall']; },
    (r) => { r.domains.plan.keys = [['overall'], 'overall']; },
    (r) => { r.domains.plan.keys = [Symbol('key'), 'overall']; },
    (r) => { delete r.models[1]; }, // a hole in the list
    (r) => { r.models.length = 3; },
    (r) => { r.models[0] = undefined; },
    // Holes in the inner lists: JSON turns them into null, so the saved file would not load again.
    (r) => { delete r.models[0].efforts[1]; },
    (r) => { delete r.models[0].tiers[0]; },
    (r) => { r.models[0].tiers = ['manager', 'maker']; delete r.models[0].tiers[0]; },
    (r) => { delete r.domains.plan.keys[0]; },
    (r) => { r.models[0].efforts = [undefined]; },
    (r) => { r.models[0].tiers = [Symbol('maker')]; },
    (r) => { r.models[0].scores = { overall: { valueOf: 1 } }; },
    (r) => { r.models[0].id = { toString: 1 }; },
    (r) => { r.models[0].tiers = [{ toString: 1 }]; },
    (r) => { r.models[0].efforts = [noText]; },
    (r) => { r.categories.overall = noText; },
    (r) => { r.attribution = noText; },
    (r) => { r.domains.plan = noText; },
  ];
  for (const [i, change] of cases.entries()) {
    const candidate = structuredClone(base);
    change(candidate);
    for (const call of [() => validateRegistry(candidate), () => router.save(candidate)]) {
      assert.throws(call, (err) => {
        assert.equal(err.status, 400, `case ${i}: ${err.stack}`);
        assert.ok(typeof err.message === 'string' && err.message.length > 10 && !/Cannot (read|convert)/.test(err.message), `case ${i}: ${err.message}`);
        return true;
      });
    }
  }
  assert.equal(readFileSync(file, 'utf8'), before, 'the file did not change');
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'b');
  // What validateRegistry() returns is itself valid: a second pass changes nothing.
  const once = validateRegistry(shipped());
  assert.deepEqual(validateRegistry(once), once);

  // Seeded random damage to the shipped registry: it is either still valid, or refused with status 400.
  const random = seeded(20261115);
  const junk = [null, 0, -1, 1e308, -1e308, '', 'x', '__proto__', 'constructor', true, false, [], {}, [null], { a: 1 }, ['overall'], { toString: 1 }, 5.5, '5', [[]]];
  const good = shipped();
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 1500; i += 1) {
    const damaged = structuredClone(good);
    const where = [mutate(damaged, random, junk)];
    if (random.chance(0.3)) where.push(mutate(damaged, random, junk));
    let clean = null;
    try {
      clean = validateRegistry(damaged);
      accepted += 1;
    } catch (err) {
      refused += 1;
      assert.equal(err.status, 400, `damage at ${where}: ${err.stack}`);
    }
    if (clean === null || i % 5 !== 0) continue;
    // What is accepted can be written and read back (so a saved file always loads again), and it
    // routes with finite numbers.
    const routed = routerFor(t, clean, { thrift: random.of([0, 0.3, 1]) }).router;
    assert.deepEqual(routed.registry(), clean, `damage at ${where}`);
    for (const role of ROLES) {
      const table = routed.explain({ role, domain: random.of(DOMAINS), size: 'S' });
      for (const row of table.candidates) {
        for (const field of ['q', 'cost', 'c', 'utility']) assert.ok(Number.isFinite(row[field]), `damage at ${where}: ${row.id}.${field} = ${row[field]}`);
      }
    }
    routed.leaders();
  }
  assert.ok(accepted > 100 && refused > 100, `accepted ${accepted}, refused ${refused}`);

  // The same damage in the file itself: the router does not start, with status 500 and a plain message.
  const brokenFile = path.join(tempDir(t), 'models.json');
  const broken = structuredClone(base);
  broken.domains.plan.keys = [{ toString: 1 }, 'overall'];
  writeFileSync(brokenFile, JSON.stringify(broken));
  assert.throws(
    () => createRouter({ modelsPath: brokenFile, providers: { usable: () => true }, getSettings: () => ({}) }),
    (err) => err.status === 500 && /is not valid: domains\.plan\.keys/.test(err.message) && !/Cannot convert/.test(err.message),
  );
});

test('router file: a registry file that an editor saved with a byte order mark and CRLF line ends still loads', (t) => {
  // Before the fix: "is not valid JSON: Unexpected token" and the router did not start.
  const registry = tiny([{ id: 'a', scores: { overall: 60 } }, { id: 'b', scores: { overall: 90 } }]);
  const file = path.join(tempDir(t), 'models.json');
  writeFileSync(file, `﻿${JSON.stringify(registry, null, 2).replaceAll('\n', '\r\n')}\r\n`);
  const make = () => createRouter({ modelsPath: file, providers: { usable: () => true }, getSettings: () => ({ thrift: 0 }), now: () => NOV_15 });
  const router = make();
  assert.equal(router.pick({ role: 'maker', domain: 'backend' }).model, 'b');
  assert.deepEqual(router.reload(), validateRegistry(registry));
  // A save writes the one fixed form again: no mark, plain line ends.
  router.save(router.registry());
  const text = readFileSync(file, 'utf8');
  assert.equal(text, `${JSON.stringify(validateRegistry(registry), null, 2)}\n`);
  assert.equal(make().pick({ role: 'maker', domain: 'backend' }).model, 'b');
});

test('model list: the router offers only the models that the lab lists for this account (contract 14c)', (t) => {
  // Two bosses with a tie on the score (58 vs 57.3). "c" costs less, so "c" is the pick.
  const registry = tiny([
    { id: 'claude-fable-5-2', label: 'Fable', tiers: ['boss'], power: 5, scores: { overall: 58 }, price: { in: 8, out: 40 }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gemini-4-carbon', label: 'Carbon', provider: 'gemini', tiers: ['boss'], power: 5, scores: { overall: 57.3 }, price: { in: 2, out: 10 } },
    { id: 'gemini-4-hydrogen', label: 'Hydrogen', provider: 'gemini', scores: { overall: 80 }, efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'claude-sonnet-5-5', label: 'Sonnet', scores: { overall: 60 } },
    { id: 'gemini-3.5-flash', label: 'Flash', provider: 'gemini', power: 2, scores: { overall: 99 }, efforts: [] },
    { id: 'gemini-3.5-flash-lite', label: 'Flash-Lite', provider: 'gemini', power: 1, scores: { overall: 10 }, efforts: [] },
  ]);
  const statuses = (geminiModels) => [
    { id: 'claude', label: 'Claude Code', usable: true, models: null },
    { id: 'gemini', label: 'Antigravity', usable: true, models: geminiModels },
    { id: 'mock', label: 'Mock', usable: true, models: null },
  ];
  const make = (list, extra = {}) => routerFor(t, registry, { providers: { usable: () => true, list }, ...extra });
  const boss = { role: 'boss', domain: 'fix' };

  // No list known (the owner did not run the check yet): nothing is hidden.
  for (const list of [undefined, () => statuses(null), () => statuses([]), () => null, () => 'junk', () => [null, 7, { id: 'gemini' }], () => { throw new Error('detect failed'); }]) {
    const { router } = make(list);
    assert.equal(router.pick(boss).model, 'gemini-4-carbon', String(list));
  }

  // The list of a Google account without Carbon (a paid Pro plan), as `agy models` prints it.
  const proPlan = [
    'gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high',
    'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium',
    'gemini-3.5-flash-lite', 'claude-opus-5-5-high',
  ];
  const { router } = make(() => statuses(proPlan));
  const pick = router.pick(boss);
  assert.equal(pick.model, 'claude-fable-5-2', 'Carbon is not on the list, so the router must not offer it');
  assert.match(pick.why, /best model Carbon is not on this account \(overall 57\.3\)$/);
  const table = router.explain(boss);
  assert.deepEqual(table.candidates.map((row) => row.id), ['claude-fable-5-2']);
  assert.deepEqual(table.rejected.find((row) => row.id === 'gemini-4-carbon'), {
    id: 'gemini-4-carbon', provider: 'gemini', label: 'Carbon', reason: 'not on this account',
  });
  // Excluding the other boss leaves nobody: no pick, instead of a model that cannot run.
  assert.equal(router.pick({ ...boss, exclude: ['claude-fable-5-2'] }), null);

  // A listed model stays. Its effort is one that the list has: Hydrogen has no "high" slug here.
  const makerL = router.pick({ role: 'maker', domain: 'backend', size: 'L' });
  assert.equal(makerL.model, 'gemini-4-hydrogen');
  assert.equal(makerL.effort, 'medium', 'the highest listed effort that is not above "high"');
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'S', exclude: ['gemini-3.5-flash-lite'] }).effort, 'low');
  // Without a list the same pick has the effort of the registry.
  assert.equal(make(undefined).router.pick({ role: 'maker', domain: 'backend', size: 'L' }).effort, 'high');

  // Names that only look alike do not count: "gemini-3.5-flash-lite" is not "gemini-3.5-flash" plus an effort.
  const small = router.explain({ role: 'maker', domain: 'backend', size: 'S' });
  assert.deepEqual(small.candidates.map((row) => row.id).sort(), ['claude-sonnet-5-5', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen']);
  assert.equal(small.rejected.find((row) => row.id === 'gemini-3.5-flash').reason, 'not on this account');
  // A slug without an effort (the bare id) offers the model with the efforts of the registry.
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'S', exclude: ['gemini-4-hydrogen', 'claude-sonnet-5-5'] }).model, 'gemini-3.5-flash-lite');

  // The list of one lab never hides a model of another lab: "claude-opus-5-5-high" is on the gemini list only.
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'M', avoidProvider: 'gemini' }).model, 'claude-sonnet-5-5');

  // Lab fallback off: the router does not wait for a model that this account cannot run.
  const strict = make(() => statuses(proPlan), { settings: { thrift: 0.3, allowFallback: false } }).router;
  assert.equal(strict.pick(boss).model, 'claude-fable-5-2');

  // leaders() is the view of the registry: it ignores usability and the lists.
  assert.deepEqual(router.leaders().fix.boss.map((row) => row.id), ['gemini-4-carbon', 'claude-fable-5-2']);

  // The list is read once per pick, and only through providers.list().
  let calls = 0;
  const counted = make(() => { calls += 1; return statuses(proPlan); }).router;
  counted.pick(boss);
  assert.equal(calls, 1);
});

test('model list: the shipped registry with the model list of the real account (agy 1.5.1) keeps every Gemini 4 pick', onShippedData, (t) => {
  // The list that `agy models` printed for the owner's account on 2026-11-15.
  const agyModels = [
    'gemini-4-carbon-medium', 'gemini-4-carbon-high', 'gemini-4-carbon-low',
    'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
    'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low',
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
    'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high', 'gpt-oss-120b-medium',
  ];
  const list = () => [{ id: 'claude', models: null }, { id: 'gemini', models: agyModels }];
  const plain = routerFor(t, shipped()).router;
  const listed = routerFor(t, shipped(), { providers: { usable: (id) => id !== 'openai', list } }).router;
  for (const role of ROLES) {
    for (const domain of DOMAINS) {
      for (const size of ['S', 'M', 'L']) {
        const query = { role, domain, size };
        assert.deepEqual(listed.pick(query), plain.pick(query), `${role} ${domain} ${size}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 2. BenchLM refresh
// ---------------------------------------------------------------------------------------------

test('benchlm rate: a failed round that reached the server also counts for the 10 minute rule', async () => {
  // Before the fix: after a timeout the next round went out 60 s later. A button pressed once per
  // minute gave 10 rounds (20 requests) in 10 minutes while the leaderboard download hung.
  const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
  site.answer = (name) => (name === 'leaderboard.json' ? new Promise(() => {}) : undefined); // manifest answers, the leaderboard hangs
  const { benchlm, clock } = benchlmFor(site, { timeoutMs: 40 });
  const registry = boardRegistry();
  const before = clone(registry);
  const first = await benchlm.refresh(registry);
  assert.equal(first.ok, false);
  assert.match(first.error, /leaderboard\.json: benchlm\.ai did not answer within 40 ms/);
  assert.deepEqual(site.names(), ['manifest.json', 'leaderboard.json']);
  for (let minute = 1; minute <= 9; minute += 1) {
    clock.now = NOON + minute * MINUTE + 100;
    const again = await benchlm.refresh(registry);
    assert.equal(again.ok, false, `minute ${minute}`);
    assert.equal(again.throttled, true, `minute ${minute}`);
    assert.match(again.error, /paused for \d+ s after an error/);
    assert.equal(site.calls.length, 2, `no request in minute ${minute}`);
  }
  assert.deepEqual(registry, before);
  // After 10 minutes the next round goes out, and gets the data.
  site.answer = null;
  clock.now = NOON + 10 * MINUTE + 100;
  const later = await benchlm.refresh(registry);
  assert.equal(later.ok, true);
  assert.equal(site.calls.length, 4);
  assert.equal(registry.models[0].scores.coding, 82.11);

  // The same for a manifest that never answers, and for a connection that breaks after the request left.
  const reset = () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); };
  const closed = () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }); };
  for (const answer of [() => new Promise(() => {}), reset, closed]) {
    const down = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
    down.answer = answer;
    const made = benchlmFor(down, { timeoutMs: 40 });
    assert.equal((await made.benchlm.refresh(boardRegistry())).ok, false);
    for (const minutes of [1, 5, 9.9]) {
      made.clock.now = NOON + minutes * MINUTE;
      const paused = await made.benchlm.refresh(boardRegistry());
      assert.equal(paused.throttled, true, `${answer}: after ${minutes} minutes`);
    }
    assert.equal(down.calls.length, 1, String(answer));
    made.clock.now = NOON + 10 * MINUTE + 100;
    await made.benchlm.refresh(boardRegistry());
    assert.equal(down.calls.length, 2);
  }
});

test('benchlm rate: when no connection was made at all, the next try may go out after one minute', async () => {
  // Nothing reached benchlm.ai (no network, DNS failure, connection refused), so the 10 minute rule is not used up.
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
    const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
    site.answer = () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) }); };
    const { benchlm, clock } = benchlmFor(site);
    const registry = boardRegistry();
    const before = clone(registry);
    const first = await benchlm.refresh(registry);
    assert.equal(first.ok, false);
    assert.match(first.error, new RegExp(`manifest\\.json: cannot reach benchlm\\.ai \\(${code}\\)`));
    assert.equal(first.nextAt, NOON + MINUTE);
    clock.now = NOON + 59 * 1000;
    assert.equal((await benchlm.refresh(registry)).throttled, true);
    assert.equal(site.calls.length, 1, 'no request inside the minute');
    assert.deepEqual(registry, before);
    site.answer = null; // the network is back
    clock.now = NOON + MINUTE;
    const result = await benchlm.refresh(registry);
    assert.equal(result.ok, true, code);
    assert.equal(registry.models[0].scores.coding, 82.11);
  }
});

test('benchlm rate: a clock that jumped back after a failure does not lock the refresh for ever', async () => {
  const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
  site.answer = () => new Response('<html>busy</html>', { status: 503 });
  const { benchlm, clock } = benchlmFor(site);
  assert.equal((await benchlm.refresh(boardRegistry())).ok, false);
  assert.equal(site.calls.length, 1);
  site.answer = null;
  clock.now = NOON - 24 * 60 * MINUTE; // the system clock was set back by one day
  const result = await benchlm.refresh(boardRegistry());
  assert.equal(result.ok, true, result.error ?? '');
  assert.equal(site.calls.length, 3);
});

test('benchlm dates: a file that holds none of our models changes nothing, also not the data date', async () => {
  // Before the fix: dataDate and fetchedAt moved to the new date and `changed` was true, although no
  // number of the registry was compared with the new data.
  const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor([['someone-else', 'Someone Else', 50, { coding: 40 }]]) });
  const { benchlm, logs } = benchlmFor(site);
  const registry = boardRegistry();
  const before = clone(registry);
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.unmatched, ['claude-sonnet-5-5', 'gemini-4-hydrogen']);
  assert.equal(result.dataDate, '2026-11-13');
  assert.deepEqual(registry, before);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /no BenchLM row/.test(entry.msg)));

  // One model found: the date moves, and only the boards that have a row of ours get the new date.
  const partial = fakeSite({ manifest: manifestFor('v3'), leaderboard: leaderboardFor([['claude-sonnet-5-5', 'Claude Sonnet 5.5', 84, {}]]) });
  const second = boardRegistry();
  const moved = await benchlmFor(partial).benchlm.refresh(second);
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.updated, [{ id: 'claude-sonnet-5-5', key: 'overall', from: 83.05, to: 84 }]);
  assert.deepEqual(moved.unmatched, ['gemini-4-hydrogen']);
  assert.equal(second.dataDate, '2026-11-20');
  assert.equal(second.categories.overall.date, '2026-11-20');
  assert.equal(second.categories.coding.date, '2026-11-13', 'no coding row of ours in this file');
  assert.equal(second.models[0].scores.coding, 80.97);

  // Every board key is pinned by the owner (board: false): nothing is compared, so the date stays.
  const pinnedSite = fakeSite({ manifest: manifestFor('v4'), leaderboard: leaderboardFor(GOOD_ROWS) });
  const pinned = boardRegistry();
  pinned.categories.overall.board = false;
  pinned.categories.coding.board = false;
  const pinnedBefore = clone(pinned);
  const kept = await benchlmFor(pinnedSite).benchlm.refresh(pinned);
  assert.equal(kept.changed, false);
  assert.deepEqual(pinned, pinnedBefore);
});

test('benchlm range: a board score outside 0 to 100 is never written into the registry', async () => {
  // Before the fix: 8305, -12 and 1e300 went into the registry and passed validateRegistry.
  const rows = [
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 8305, { coding: -12 }],
    ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', 1e300, { coding: 100.01 }],
    ['claude-haiku-5-5', 'Claude Haiku 5.5', 100, { coding: 0 }], // the two ends of the scale are real scores
  ];
  const data = extractLeaderboard(leaderboardFor(rows));
  assert.deepEqual(data.rows.map((row) => [row.slug, row.s]), [
    ['claude-sonnet-5-5', {}], ['gemini-4-hydrogen', {}], ['claude-haiku-5-5', { overall: 100, coding: 0 }],
  ]);

  const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(rows) });
  const { benchlm } = benchlmFor(site);
  const registry = boardRegistry();
  registry.models.push({ ...clone(registry.models[0]), id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', scores: { overall: 67.64, coding: 58.93, arenaWebDevElo: 1593 } });
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, true);
  for (const model of registry.models) {
    for (const key of ['overall', 'coding']) {
      const value = model.scores[key];
      assert.ok(value === null || (value >= 0 && value <= 100), `${model.id}.${key} = ${value}`);
    }
  }
  // A number that is not a score is "no score": null, like a missing row. It is never clamped or kept as zero.
  assert.deepEqual(registry.models.map((model) => [model.id, model.scores.overall, model.scores.coding]), [
    ['claude-sonnet-5-5', null, null], ['gemini-4-hydrogen', null, null], ['claude-haiku-5-5', 100, 0],
  ]);
  assert.doesNotThrow(() => validateRegistry(registry));

  // The same guard for rows that come back from the cache file.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workshop-adversarial-cache-'));
  try {
    const cachePath = path.join(dir, 'benchlm.json');
    writeFileSync(cachePath, JSON.stringify({
      v: 1, etag: '"m1"', dataVersion: 'v9', dataDate: '2026-11-20', fetchedAt: '2026-11-20', checkedAt: NOON - MINUTE, boards: ['overall', 'coding'],
      rows: [{ slug: 'claude-sonnet-5-5', key: null, name: null, est: false, s: { overall: 9999, coding: 81.5 } }],
    }));
    const cached = fakeSite({ manifest: manifestFor('v9'), leaderboard: leaderboardFor(GOOD_ROWS) });
    const fromCache = boardRegistry();
    const result2 = await benchlmFor(cached, { cachePath }).benchlm.refresh(fromCache);
    assert.equal(result2.throttled, true);
    assert.equal(cached.calls.length, 0);
    assert.equal(fromCache.models[0].scores.coding, 81.5);
    assert.notEqual(fromCache.models[0].scores.overall, 9999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchlm all or nothing: a refresh that cannot finish leaves the registry exactly as it was', async () => {
  // Before the fix: the scores of the first models were already changed when the error came, and the
  // result said ok: false.
  const cases = [
    // The same id twice, and the second entry has no scores.
    (registry) => { registry.models.push({ id: 'gemini-4-hydrogen', label: 'A copy', scores: null }); },
    // A part of the registry that cannot be written.
    (registry) => { Object.freeze(registry.models[1].scores); },
    (registry) => { Object.freeze(registry.categories.coding); },
    (registry) => { Object.freeze(registry.models[1]); },
  ];
  for (const [i, damage] of cases.entries()) {
    const site = fakeSite({
      manifest: manifestFor('v2'),
      leaderboard: leaderboardFor([['claude-sonnet-5-5', 'Claude Sonnet 5.5', 84, { coding: 82.11 }], ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', 80.2, { coding: 77.5 }, 'estimated']]),
    });
    const { benchlm } = benchlmFor(site);
    const registry = boardRegistry();
    damage(registry);
    const before = JSON.stringify(registry);
    const result = await benchlm.refresh(registry);
    if (result.ok) {
      // A refresh may also cope with the damage. Then it must have done the whole job.
      assert.equal(registry.models[0].scores.coding, 82.11, `case ${i}`);
      assert.equal(registry.models[1].scores.coding, 77.5, `case ${i}`);
    } else {
      assert.equal(JSON.stringify(registry), before, `case ${i}: ok is false, so nothing may have changed (${result.error})`);
      assert.equal(result.changed, false);
      assert.deepEqual(result.updated, []);
    }
  }
  // The frozen cases cannot be written at all, so they must fail and stay clean.
  const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
  const registry = boardRegistry();
  Object.freeze(registry.models[1].scores);
  const before = JSON.stringify(registry);
  const result = await benchlmFor(site).benchlm.refresh(registry);
  assert.equal(result.ok, false);
  assert.match(result.error, /^BenchLM refresh failed: /);
  assert.equal(JSON.stringify(registry), before);
  assert.equal(registry.models[0].scores.coding, 80.97, 'the first model was not changed either');
});

test('benchlm cache: a bad ETag in the cache file is not sent and does not block the refresh', async (t) => {
  // Before the fix: the header value was not valid, fetch refused it, and every later refresh failed
  // with "cannot reach benchlm.ai" until the owner deleted the cache file.
  const dir = tempDir(t);
  for (const [i, etag] of ['"abc"\r\nX-Injected: 1', 'W/"abc"\n', '"a b"', '"café"', '\u0000', 'x'.repeat(301), 7, ['"abc"']].entries()) {
    const cachePath = path.join(dir, `cache-${i}.json`);
    writeFileSync(cachePath, JSON.stringify({
      v: 1, etag, dataVersion: 'v1', dataDate: '2026-11-13', fetchedAt: '2026-11-15', checkedAt: NOON - 60 * MINUTE, boards: ['overall'],
      rows: [{ slug: 'claude-sonnet-5-5', key: null, name: null, est: false, s: { overall: 83.05 } }],
    }));
    const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
    // The real fetch checks header values. The stand-in does the same check.
    site.answer = (name, url, init) => { new Headers(init.headers); };
    const { benchlm } = benchlmFor(site, { cachePath });
    const registry = boardRegistry();
    const result = await benchlm.refresh(registry);
    assert.equal(result.ok, true, `etag ${JSON.stringify(etag)}: ${result.error}`);
    assert.equal(site.calls[0].headers['If-None-Match'], undefined, `etag ${JSON.stringify(etag)} must not be sent`);
    assert.equal(registry.models[0].scores.coding, 82.11);
  }
  // A normal ETag from the cache still goes out, strong or weak.
  for (const etag of ['"802c92dff095ea6ce39372638f4253a3"', 'W/"6053c380c43d1dbaf6c96d6b3efb699c"']) {
    const cachePath = path.join(dir, `cache-good-${etag.length}.json`);
    writeFileSync(cachePath, JSON.stringify({
      v: 1, etag, dataVersion: 'v1', dataDate: '2026-11-13', fetchedAt: '2026-11-15', checkedAt: NOON - 60 * MINUTE, boards: ['overall'],
      rows: [{ slug: 'claude-sonnet-5-5', key: null, name: null, est: false, s: { overall: 83.05 } }],
    }));
    const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
    site.answer = (name, url, init) => (init.headers['If-None-Match'] === etag ? new Response(null, { status: 304 }) : undefined);
    const result = await benchlmFor(site, { cachePath }).benchlm.refresh(boardRegistry());
    assert.equal(site.calls[0].headers['If-None-Match'], etag);
    assert.equal(result.notModified, true);
    assert.deepEqual(site.names(), ['manifest.json']);
  }
  // An ETag of the server that cannot be sent back is not kept.
  const odd = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
  odd.etag = '"a b c"';
  const cachePath = path.join(dir, 'cache-odd.json');
  assert.equal((await benchlmFor(odd, { cachePath }).benchlm.refresh(boardRegistry())).ok, true);
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).etag, null);
});

test('benchlm timeout: a manifest whose body never ends also runs into the deadline', async () => {
  const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(GOOD_ROWS) });
  site.answer = (name) => {
    if (name !== 'manifest.json') return undefined;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"files":')); } }); // never closed
    return new Response(body, { status: 200, headers: { etag: '"m1"' } });
  };
  const { benchlm } = benchlmFor(site, { timeoutMs: 60 });
  const registry = boardRegistry();
  const before = clone(registry);
  const started = Date.now();
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, false);
  assert.match(result.error, /manifest\.json: benchlm\.ai did not answer within 60 ms/);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(registry, before);
  assert.deepEqual(site.names(), ['manifest.json']);
});

test('benchlm scope: a refresh never deletes, adds or enables a model and never changes tiers, power, prices or efforts', async () => {
  // BenchLM drops one of our models, renames nothing, and lists models that we do not have.
  const rows = [
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 84, { coding: 82.11 }, 'estimated'],
    ['brand-new-model', 'Brand New Model', 99, { coding: 99 }],
  ];
  const site = fakeSite({ manifest: manifestFor('v2'), leaderboard: leaderboardFor(rows) });
  const registry = boardRegistry();
  const fixed = (reg) => reg.models.map((m) => [m.id, m.provider, m.label, m.tiers, m.power, m.price, m.efforts, m.enabled, m.planNote, m.scores.arenaWebDevElo]);
  const before = clone(fixed(registry));
  const result = await benchlmFor(site).benchlm.refresh(registry);
  assert.equal(result.ok, true);
  assert.deepEqual(fixed(registry), before);
  assert.equal(registry.models.length, 2);
  assert.equal(registry.models[1].enabled, false, 'a disabled model stays disabled');
  assert.deepEqual(registry.models[1].scores, { overall: 79.06, coding: 75.75, arenaWebDevElo: 1704 }, 'a model without a BenchLM row keeps its scores');
  assert.deepEqual(result.unmatched, ['gemini-4-hydrogen']);
  assert.deepEqual(result.flags, [{ id: 'claude-sonnet-5-5', key: 'estimated', from: false, to: true }]);
  assert.deepEqual(Object.keys(registry.categories), ['overall', 'coding', 'arenaWebDevElo']);
  assert.deepEqual(Object.keys(registry.domains).sort(), [...DOMAINS].sort());
});

// ---------------------------------------------------------------------------------------------
// 3. Seeded random checks
// ---------------------------------------------------------------------------------------------

test('random picks: every pick follows the candidate rules of the brief, is deterministic, and never ignores avoidProvider', (t) => {
  const random = seeded(4711);
  const LABS = ['claude', 'gemini', 'openai'];
  const KEYS = ['overall', 'k1', 'k2', 'low1'];
  const SIZE_POWER = { S: 1, M: 3, L: 3 };
  const dir = tempDir(t);
  let picks = 0;
  let avoided = 0;
  let nulls = 0;
  for (let round = 0; round < 400; round += 1) {
    const categories = {
      overall: { label: 'Overall', scale: '0-100', tie: random.of([0, 2, 5]), source: 'T' },
      k1: { label: 'K1', scale: '0-100', tie: random.of([0, 5, 50]), source: 'T' },
      k2: { label: 'K2', scale: 'elo', tie: random.of([0, 20]), source: 'T' },
      low1: { label: 'Low', scale: 'minutes', tie: random.of([0, 1]), source: 'T', lowerIsBetter: true },
    };
    const domains = {};
    for (const name of DOMAINS) domains[name] = { label: name, keys: [...KEYS.filter((key) => key !== 'overall' && random.chance(0.5)), 'overall'] };
    const models = [];
    const count = 1 + Math.floor(random.next() * 8);
    for (let i = 0; i < count; i += 1) {
      const tiers = [random.of(ROLES)];
      for (const role of ROLES) if (!tiers.includes(role) && random.chance(0.25)) tiers.push(role);
      const scores = {};
      for (const key of KEYS) scores[key] = random.chance(0.25) ? null : random.of([0, 50, 50, 55, 60, 79.9, 80, 84.9, 85, 100, 1500, 1520]);
      models.push({
        id: `m${i}`, provider: random.of(LABS), label: `M${i}`, tiers, power: 1 + Math.floor(random.next() * 5),
        price: { in: random.of([0, 0.1, 1, 2, 2, 8]), out: random.of([0, 0.5, 5, 10, 10, 40]), note: '' },
        efforts: random.of([[], ['low'], ['low', 'medium', 'high'], ['high', 'max']]), enabled: random.chance(0.85), estimated: false, planNote: '', scores,
      });
    }
    const registry = {
      version: 1, dataDate: '2026-11-13', fetchedAt: '2026-11-15',
      attribution: { text: 'Data from BenchLM.ai', url: 'https://benchlm.ai', license: 'CC BY-NC 4.0' },
      categories, domains, models,
    };
    const file = path.join(dir, `r${round % 20}.json`);
    writeFileSync(file, JSON.stringify(registry));
    const usableLabs = LABS.filter(() => random.chance(0.75));
    const thrift = random.of([0, 0, 0.3, 0.5, 0.99, 1]);
    const allowFallback = random.chance(0.8);
    const make = () => createRouter({
      modelsPath: file, providers: { usable: (id) => usableLabs.includes(id) }, getSettings: () => ({ thrift, allowFallback }), now: () => NOV_15,
    });
    const router = make();
    const twin = make();
    for (let j = 0; j < 8; j += 1) {
      const query = { role: random.of(ROLES), domain: random.of([...DOMAINS, 'zzz', undefined]) };
      if (random.chance(0.7)) query.size = random.of(['S', 'M', 'L']);
      if (random.chance(0.4)) query.avoidProvider = random.of(LABS);
      if (random.chance(0.3)) query.preferProvider = random.of(LABS);
      if (random.chance(0.3)) query.labLoad = { claude: Math.floor(random.next() * 3), gemini: Math.floor(random.next() * 3) };
      if (random.chance(0.2)) query.exclude = models.filter(() => random.chance(0.3)).map((model) => model.id);
      if (random.chance(0.2)) query.bump = Math.floor(random.next() * 4);
      const tag = `round ${round}, query ${JSON.stringify(query)}, thrift ${thrift}, labs ${usableLabs}`;
      const pick = router.pick(query);
      const table = router.explain(query);
      picks += 1;
      assert.deepEqual(router.pick(query), pick, `the same router twice: ${tag}`);
      assert.deepEqual(twin.pick(query), pick, `another router on the same file: ${tag}`);
      assert.deepEqual(table.pick, pick, tag);
      for (const row of table.candidates) {
        for (const field of ['q', 'cost', 'c', 'utility']) assert.ok(Number.isFinite(row[field]), `${field}: ${tag}`);
        assert.ok(row.q >= 0 && row.q <= 1 && row.c >= 0 && row.c <= 1, tag);
      }
      // The candidate rules, written down again in the plainest way.
      const base = query.role === 'maker' && query.size ? SIZE_POWER[query.size] : 1;
      const excluded = new Set(query.exclude ?? []);
      const fits = models.filter((m) => m.enabled && m.tiers.includes(query.role) && usableLabs.includes(m.provider) && !excluded.has(m.id) && m.power >= base);
      const primary = fits.filter((m) => m.tiers[0] === query.role);
      let pool = primary.length > 0 ? primary : fits;
      if (pool.length === 0) {
        assert.equal(pick, null, `no candidate, so no pick: ${tag}`);
        nulls += 1;
        continue;
      }
      let couldAvoid = false;
      if (query.avoidProvider) {
        const others = pool.filter((m) => m.provider !== query.avoidProvider);
        if (others.length > 0) {
          couldAvoid = others.length < pool.length;
          pool = others;
        }
      }
      const minPower = Math.min(base + (query.bump ?? 0), Math.max(...pool.map((m) => m.power)));
      pool = pool.filter((m) => m.power >= minPower);
      assert.deepEqual(table.candidates.map((row) => row.id).sort(), pool.map((m) => m.id).sort(), `candidates: ${tag}`);
      if (pick === null) {
        // Only one reason is left: lab fallback is off and the lab that should get the pick is down.
        assert.equal(allowFallback, false, `null although a candidate exists: ${tag}`);
        assert.equal(table.fallback, true, tag);
        nulls += 1;
        continue;
      }
      const model = models.find((m) => m.id === pick.model);
      assert.ok(pool.includes(model), `the pick is a candidate: ${tag}`);
      assert.equal(table.candidates[0].id, pick.model, tag);
      assert.deepEqual([pick.provider, pick.label], [model.provider, model.label], tag);
      if (model.efforts.length === 0) assert.equal(pick.effort, null, tag);
      else assert.ok(model.efforts.includes(pick.effort), `effort ${pick.effort}: ${tag}`);
      assert.ok(typeof pick.why === 'string' && !/NaN|undefined|Infinity|\n/.test(pick.why), `why: ${pick.why}`);
      if (query.avoidProvider && pool.some((m) => m.provider !== query.avoidProvider)) {
        assert.notEqual(pick.provider, query.avoidProvider, `avoidProvider was ignored: ${tag}`);
        if (couldAvoid) avoided += 1;
      }
      // The comparison key: the first key of the domain that every candidate has a number for.
      const keyList = registry.domains[query.domain]?.keys ?? ['overall'];
      const key = keyList.find((k) => pool.every((m) => typeof m.scores[k] === 'number')) ?? 'overall';
      assert.equal(table.key, key, tag);
      const scored = pool.filter((m) => typeof m.scores[key] === 'number');
      if (scored.length > 0) {
        assert.equal(typeof model.scores[key], 'number', `a model without a number never wins against one with a number: ${tag}`);
        const cost = (m) => (m.price.in + 3 * m.price.out) / 4;
        if (thrift === 1) {
          assert.ok(Math.abs(cost(model) - Math.min(...scored.map(cost))) < 1e-9, `thrift 1 picks the cheapest that fits: ${tag}`);
        }
        if (thrift === 0) {
          // The best model always: the winner is in the best tie band, or within 0.02 of it in quality.
          assert.ok(table.candidates[0].q >= 0.98 - 1e-9, `thrift 0 picked q ${table.candidates[0].q}: ${tag}`);
        }
      }
    }
  }
  assert.ok(picks === 3200 && avoided > 50 && nulls > 100, `picks ${picks}, avoided ${avoided}, null ${nulls}`);
});

test('random BenchLM files: a broken file never crashes the refresh, never half-applies, and only touches board scores', async () => {
  // The registry on disk, whatever its state is (shipped, refreshed, or edited by the owner).
  const good = shipped();
  const boardKeys = Object.entries(good.categories).filter(([key, category]) => category.board === key).map(([key]) => key);
  assert.ok(boardKeys.includes('overall') && boardKeys.includes('coding'), `board keys: ${boardKeys}`);
  const rows = good.models.map((m) => [
    m.benchlmSlug ?? m.id.replaceAll('.', '-'), m.label, m.scores.overall,
    Object.fromEntries(boardKeys.filter((key) => key !== 'overall' && m.scores[key] !== null).map((key) => [key, m.scores[key]])),
    m.estimated ? 'estimated' : 'supported',
  ]);
  const goodBoard = leaderboardFor(rows, { date: good.dataDate }); // the same data date, so the data is not "older"
  // First: the clean file changes nothing at all.
  const cleanRegistry = shipped();
  const clean = await benchlmFor(fakeSite({ manifest: manifestFor('v1'), leaderboard: goodBoard })).benchlm.refresh(cleanRegistry);
  assert.deepEqual([clean.ok, clean.changed, clean.updated, clean.unmatched], [true, false, [], []]);
  assert.deepEqual(cleanRegistry, shipped());

  const random = seeded(8086);
  const junk = [null, 0, -1, 1e308, -1e308, 101, '', 'x', '__proto__', true, false, [], {}, [null], { a: 1 }, 'claude-opus-5-5', 5.5, '5', [[]], { toString: 1 }];
  const fixedPart = (registry) => JSON.stringify(registry.models.map((m) => [
    m.id, m.provider, m.label, m.tiers, m.power, m.price, m.efforts, m.enabled, m.planNote, m.benchlmSlug,
    Object.entries(m.scores).filter(([key]) => !boardKeys.includes(key)),
  ]));
  let failed = 0;
  let changed = 0;
  for (let i = 0; i < 400; i += 1) {
    const board = structuredClone(goodBoard);
    const manifest = manifestFor(`v${i + 2}`);
    const where = [random.chance(0.85) ? `leaderboard.${mutate(board, random, junk)}` : `manifest.${mutate(manifest, random, junk)}`];
    if (random.chance(0.3)) where.push(`leaderboard.${mutate(board, random, junk)}`);
    const registry = shipped();
    const before = JSON.stringify(registry);
    const fixed = fixedPart(registry);
    const result = await benchlmFor(fakeSite({ manifest, leaderboard: board })).benchlm.refresh(registry); // must not reject
    assert.equal(typeof result.ok, 'boolean', `damage at ${where}`);
    if (!result.ok) {
      failed += 1;
      assert.equal(JSON.stringify(registry), before, `ok false, but the registry changed. Damage at ${where}`);
      assert.match(result.error, /^BenchLM refresh failed: /);
      continue;
    }
    if (!result.changed) assert.equal(JSON.stringify(registry), before, `changed false, but the registry changed. Damage at ${where}`);
    else changed += 1;
    assert.equal(fixedPart(registry), fixed, `a field that a refresh must not touch changed. Damage at ${where}`);
    assert.equal(registry.models.length, good.models.length);
    assert.doesNotThrow(() => validateRegistry(registry), `damage at ${where}`);
    for (const model of registry.models) {
      for (const key of boardKeys) {
        const value = model.scores[key];
        assert.ok(value === null || (typeof value === 'number' && value >= 0 && value <= 100), `${model.id}.${key} = ${value}. Damage at ${where}`);
      }
    }
    // Every reported update is true, and nothing else in the board scores moved.
    const old = shipped();
    for (const { id, key, from, to } of result.updated) {
      const index = old.models.findIndex((m) => m.id === id);
      assert.equal(old.models[index].scores[key], from);
      assert.equal(registry.models[index].scores[key], to);
      old.models[index].scores[key] = to;
    }
    assert.deepEqual(registry.models.map((m) => m.scores), old.models.map((m) => m.scores), `an unreported score change. Damage at ${where}`);
  }
  assert.ok(changed > 20, `changed ${changed}, failed ${failed}`);
});

// ---------------------------------------------------------------------------------------------
// 4. The shipped numbers, checked against each other
// ---------------------------------------------------------------------------------------------

test('shipped data: every score is inside the range of its scale', () => {
  // This holds for the file in any state: a refresh or an edit must not bring a number of another scale.
  const registry = shipped();
  const RANGES = {
    '0-100': [0, 100], percent: [0, 100], index: [0, 100], '0-105': [0, 105], elo: [1000, 2000],
    minutes: [0, 1000], usd: [0, 1000], 'tokens per second': [0, 5000], 'points per USD': [0, 1000],
  };
  let count = 0;
  for (const model of registry.models) {
    for (const [key, value] of Object.entries(model.scores)) {
      const range = RANGES[registry.categories[key].scale];
      if (value === null || !range) continue; // a scale that this test does not know
      const [low, high] = range;
      assert.ok(typeof value === 'number' && value >= low && value <= high, `${model.id}.${key} = ${value} is outside ${low}..${high}`);
      count += 1;
    }
    assert.ok((model.provider === 'oss' ? model.price.in === 0 && model.price.out === 0 : model.price.in > 0 && model.price.out >= model.price.in) && model.price.out <= 100, `${model.id} price`);
    if (model.price.next) {
      assert.ok(model.price.next.in >= model.price.in && model.price.next.out >= model.price.out, `${model.id}: the scheduled price is the higher one`);
      assert.match(model.price.next.from, /^20\d\d-\d\d-01$/);
    }
  }
  assert.ok(count > 200, `${count} scores checked`);
});

// The index is not a BenchLM board, so a refresh leaves it alone. The check belongs to the shipped numbers.
test('shipped data: the coding value index equals coding score / output price, so score, price and index agree', onShippedData, () => {
  // Report section 5.5: "Coding value index is BenchLM's coding score divided by the output price per 1M tokens".
  // Three numbers from three places of the research file must fit together. 0.02 covers the rounding of
  // the four coding scores that the source gives with one decimal.
  for (const model of shipped().models) {
    const { coding, codingValueIndex } = model.scores;
    assert.ok(typeof coding === 'number' && typeof codingValueIndex === 'number', model.id);
    const expected = coding / model.price.out;
    assert.ok(Math.abs(expected - codingValueIndex) <= 0.02, `${model.id}: ${coding} / ${model.price.out} = ${expected.toFixed(3)}, index ${codingValueIndex}`);
  }
});

test('shipped data: the picks of the brief hold on config/models.json as it is on disk', onShippedData, (t) => {
  const at = (thrift, usable) => routerFor(t, shipped(), { thrift, usable }).router;
  // backend M, both labs, thrift 0: coding 80.97 vs 75.75, gap 5.22 is over the tie of 5.
  assert.equal(at(0).pick({ role: 'maker', domain: 'backend', size: 'M' }).model, 'claude-sonnet-5-5');
  // chore S: value index 117.86 vs 10.1 and 8.1.
  assert.equal(at(0.3).pick({ role: 'maker', domain: 'chore', size: 'S' }).model, 'claude-haiku-5-5');
  // docs M, thrift 0: creative writing Elo 1492 vs 1464, gap 28 is over the tie of 20.
  assert.equal(at(0).pick({ role: 'maker', domain: 'docs', size: 'M' }).model, 'gemini-4-hydrogen');
  // boss plan: reasoning 91 vs 84.83.
  assert.equal(at(0.3).pick({ role: 'boss', domain: 'plan' }).model, 'claude-fable-5-2');
  // boss with claude unusable.
  assert.equal(at(0.3, ['gemini']).pick({ role: 'boss', domain: 'plan' }).model, 'gemini-4-carbon');
  // reviewer for a claude maker.
  assert.equal(at(0.3).pick({ role: 'boss', domain: 'review', avoidProvider: 'claude' }).provider, 'gemini');
  // Nothing usable.
  assert.equal(at(0.3, []).pick({ role: 'boss', domain: 'plan' }), null);
});
