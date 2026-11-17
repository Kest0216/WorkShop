// Tests for server/benchlm.js. Run: node --test tests/benchlm.test.mjs
//
// The refresh talks to a local HTTP server on 127.0.0.1 that serves sample manifest.json and
// leaderboard.json files in the exact BenchLM shapes of the research report (section 3.6).
// No request leaves the machine. Two tests pass a fetch stand-in instead, to check the real URLs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { createBenchlm, extractLeaderboard, isoDate, normalizeName, BENCHLM_BASE_URL, USER_AGENT } from '../server/benchlm.js';
import { createRouter, validateRegistry, DOMAINS } from '../server/router.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = path.join(ROOT, 'config', 'models.json');

const GENERATED_AT = '2026-11-15T02:27:37.723Z';
const DATA_V1 = 'sha256:82d6e1174ab10df2c8a12745b6d2220aa27f43ab914cf166d3f9d2f4d534743f';
const DATA_V2 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const NOON = new Date(2026, 10, 20, 12).getTime(); // local time, so that the local date is 2026-11-20 everywhere
const MINUTE = 60 * 1000;
const BOARDS = [
  ['agentic', 'Agentic'], ['coding', 'Coding'], ['reasoning', 'Reasoning'], ['multimodalGrounded', 'Multimodal and Grounded'],
  ['knowledge', 'Knowledge'], ['multilingual', 'Multilingual'], ['instructionFollowing', 'Instruction Following'], ['math', 'Math'],
];
const clone = (value) => JSON.parse(JSON.stringify(value));
const round2 = (n) => Math.round(n * 100) / 100;

// --- sample data: BenchLM rows of 2026-11-13 (report section 5.1) -------------------------------

/** One line per model: [slug, name, creator, evidence, overall, agentic, coding, reasoning, multimodal, knowledge]. */
const ROWS_V1 = [
  ['claude-fable-5-2', 'Claude Fable 5.2', 'Anthropic', 'estimated', 93.65, 90.71, 89.23, 91, 90.43, 98.53],
  ['gemini-4-carbon', 'Gemini 4 Carbon', 'Google', 'supported', 89.15, 84.61, 83.88, 84.83, null, null],
  ['claude-opus-5-5', 'Claude Opus 5.5', 'Anthropic', 'supported', 86.62, 83.85, 82.6, 80.53, 85.09, 89.76],
  ['gpt-6-astra', 'GPT-6 Astra', 'OpenAI', 'supported', 85.65, 73.65, 78.7, 81.13, 79.71, 85.47],
  ['gpt-6-1-sol', 'GPT-6.1 Sol', 'OpenAI', 'supported', 84.6, 65.67, 73.36, 80.43, 78.9, 85.6],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Anthropic', 'supported', 83.05, 72.73, 80.97, 76.98, 78.92, 82.07],
  ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', 'Google', 'estimated', 79.06, null, 75.75, null, null, null],
  ['gpt-6-sol', 'GPT-6 Sol', 'OpenAI', 'supported', 77.41, 60.2, 66.1, 70.3, 71.5, 77.9], // an older model with a near name
  ['claude-opus-5', 'Claude Opus 5', 'Anthropic', 'supported', 76.05, 70.4, 71.2, 69.8, 72.1, 78.3], // another near name
  ['claude-haiku-5-5', 'Claude Haiku 5.5', 'Anthropic', 'supported', 67.64, 60.11, 58.93, 58.95, 61.82, 65.22],
  ['gemini-3-8-flash', 'Gemini 3.8 Flash', 'Google', 'supported', 64.47, 63.55, 55.3, 64.46, 69.87, 68.39],
  ['gemini-3-5-flash-lite', 'Gemini 3.5 Flash-Lite', 'Google', 'supported', 46.95, 34.16, 34.68, 9.09, 51.52, 46.7],
  ['old-math-model', 'Old Math Model', 'Other', 'supported', 40.1, null, null, null, null, null],
].map(([slug, model, creator, evidence, overall, agentic, coding, reasoning, multimodalGrounded, knowledge]) => ({
  slug, model, creator, evidence, overall, boards: { agentic, coding, reasoning, multimodalGrounded, knowledge },
}));
ROWS_V1.find((row) => row.slug === 'old-math-model').boards.math = 55.5; // the math board has no current model

/** The manifest in the shape of report section 3.6. */
function manifestFor({ dataVersion = DATA_V1, generatedAt = GENERATED_AT, sourceLastUpdated = 'November 13, 2026' } = {}) {
  const file = (name, bytes, extra = {}) => ({
    name, canonicalUrl: `https://benchlm.ai/data/${name}`, encodingFormat: 'application/json', bytes,
    sha256: '8cb3bad51de5a04d9fdd840322a1f730baf48561c60e321d215a6dd3affbabc3',
    dataVersion: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    schemaVersion: '1.0', generatedAt, sourceLastUpdated, ...extra,
  });
  return {
    schemaVersion: 'benchlm-export-manifest/v1',
    canonicalUrl: 'https://benchlm.ai/data/manifest.json',
    license: 'CC BY-NC 4.0',
    attribution: 'Data from BenchLM.ai',
    generatedAt,
    dataVersion: 'sha256:ce04dd081da976fc02f333a7be57adb43807761c8d0f09b0c7434ca5a047f81e',
    files: [file('speed.json', 87574), file('leaderboard.json', 1430264, { dataVersion }), file('pricing.json', 857048)],
  };
}

/** leaderboard.json in the shape of report section 3.6, built from rows like ROWS_V1. */
function leaderboardFor(rows, { dataVersion = DATA_V1, generatedAt = GENERATED_AT, sourceLastUpdated = 'November 13, 2026' } = {}) {
  const ranked = rows.filter((row) => typeof row.overall === 'number').sort((a, b) => b.overall - a.overall);
  const overallRank = new Map(ranked.map((row, i) => [row.slug, i + 1]));
  const identity = (row) => ({ slug: row.slug, canonicalModelKey: row.key ?? row.slug, model: row.model, creator: row.creator });
  const items = ranked.map((row, i) => ({
    rank: i + 1, ...identity(row), sourceType: 'Proprietary', reasoningType: 'Reasoning',
    contextWindow: '1M', contextWindowTokens: 1000000,
    displayScore: row.overall, provisionalDisplayScore: Math.round(row.overall - 7), publicRankingMode: 'bench-align-v5',
    evidenceStatus: row.evidence,
    scoreInterval90: { lower: round2(row.overall - 9), upper: Math.min(100, round2(row.overall + 9)), scope: 'source-pattern' },
    orderingMeaning: 'higher-is-better', rankingEligible: true,
    overallRank: i + 1, url: `https://benchlm.ai/models/${row.slug}`, markdownUrl: `https://benchlm.ai/md/models/${row.slug}.md`,
    score: row.overall, rankingMode: 'bench-align-v5', category: null, categoryLabel: null,
    trustedBenchmarkCount: 33, scoreConfidence: 3,
  }));
  const categories = {};
  for (const [board, label] of BOARDS) {
    categories[board] = rows
      .filter((row) => typeof row.boards?.[board] === 'number')
      .sort((a, b) => b.boards[board] - a.boards[board])
      .map((row, i) => ({
        rank: i + 1, ...identity(row), evidenceStatus: 'supported',
        scoreInterval90: {
          lower: round2(row.boards[board] - 8), upper: Math.min(100, round2(row.boards[board] + 8)),
          scope: 'category-prior-propagation-unvalidated',
        },
        overallRank: overallRank.get(row.slug) ?? null,
        score: row.boards[board], // the board score
        displayScore: row.overall, // TRAP: the overall score
        category: board, categoryLabel: label, trustedBenchmarkCount: 61, scoreConfidence: 3,
      }));
  }
  return {
    schemaVersion: '1.0',
    name: 'BenchLM leaderboards',
    generatedAt,
    sourceLastUpdated,
    rankingMode: 'bench-align-v5',
    counts: { overall: items.length, categories: Object.fromEntries(Object.entries(categories).map(([key, list]) => [key, list.length])) },
    items,
    categories,
    dataVersion,
  };
}

/** A registry with real ids and the numbers of the report. Boards and three keys from other sources. */
function sampleRegistry() {
  const board = (label, name) => ({ label, scale: '0-100', tie: 5, source: 'BenchLM', date: '2026-11-13', board: name });
  const categories = {
    overall: board('Overall', 'overall'),
    agentic: board('Agentic', 'agentic'),
    coding: board('Coding', 'coding'),
    reasoning: board('Reasoning', 'reasoning'),
    multimodalGrounded: board('Multimodal and Grounded', 'multimodalGrounded'),
    knowledge: board('Knowledge', 'knowledge'),
    math: { label: 'Math', scale: '0-100', tie: 5, source: 'BenchLM category pages' }, // no "board": the key is a BenchLM board name
    arenaWebDevElo: { label: 'Arena WebDev Elo', scale: 'elo', tie: 20, source: 'Arena', date: '2026-11-11' },
    bugHuntBench: { label: 'Bug Hunt Bench', scale: '0-105', tie: 5, source: 'Bug Hunt Bench via BenchLM', date: '2026-11-13' },
    codingValueIndex: { label: 'Coding value index', scale: 'points per USD', tie: 0.5, source: 'BenchLM', date: '2026-11-13' },
  };
  const domains = Object.fromEntries(DOMAINS.map((name) => [name, { label: name, keys: ['coding', 'overall'] }]));
  const model = (id, provider, label, tiers, power, enabled, estimated, price, scores) => ({
    id, provider, label, tiers, power, price: { in: price[0], out: price[1], note: '' }, efforts: ['low', 'medium', 'high'],
    enabled, estimated, planNote: '',
    scores: Object.fromEntries(Object.keys(categories).map((key, i) => [key, scores[i]])),
  });
  //                                                                                    overall agentic coding reason multim knowl  math  webdev bug   value
  return {
    version: 1,
    dataDate: '2026-11-13',
    fetchedAt: '2026-11-15',
    attribution: { text: 'Data from BenchLM.ai', url: 'https://benchlm.ai', license: 'CC BY-NC 4.0' },
    categories,
    domains,
    models: [
      model('claude-fable-5-2', 'claude', 'Claude Fable 5.2', ['boss'], 5, true, true, [8, 40], [93.65, 90.71, 89.23, 91, 90.43, 98.53, null, 1838, 58, 2.23]),
      model('gemini-4-carbon', 'gemini', 'Gemini 4 Carbon', ['boss'], 5, true, false, [2, 10], [89.15, 84.61, 83.88, 84.83, null, null, null, 1768, 57.3, 8.39]),
      model('claude-opus-5-5', 'claude', 'Claude Opus 5.5', ['manager', 'boss'], 4, true, false, [4, 20], [86.62, 83.85, 82.6, 80.53, 85.09, 89.76, null, 1815, 41.7, 4.13]),
      model('claude-sonnet-5-5', 'claude', 'Claude Sonnet 5.5', ['maker', 'manager'], 3, true, false, [2, 10], [83.05, 72.73, 80.97, 76.98, 78.92, 82.07, null, 1772, 51.3, 8.1]),
      model('gemini-4-hydrogen', 'gemini', 'Gemini 4 Hydrogen', ['maker', 'manager'], 3, true, true, [1.5, 7.5], [79.06, null, 75.75, null, null, null, null, 1704, 32.7, 10.1]),
      model('claude-haiku-5-5', 'claude', 'Claude Haiku 5.5', ['maker'], 2, true, false, [0.1, 0.5], [67.64, 60.11, 58.93, 58.95, 61.82, 65.22, null, 1593, 21.5, 117.86]),
      model('gemini-3.8-flash', 'gemini', 'Gemini 3.8 Flash', ['maker'], 2, false, false, [0.75, 3.75], [64.47, 63.55, 55.3, 64.46, 69.87, 68.39, null, 1583, 18, 14.73]),
      model('gemini-3.5-flash-lite', 'gemini', 'Gemini 3.5 Flash-Lite', ['maker'], 1, false, false, [0.3, 2.5], [46.95, 34.16, 34.68, 9.09, 51.52, 46.7, null, null, null, 13.87]),
      model('gpt-6.1-sol', 'openai', 'GPT-6.1 Sol', ['manager'], 4, false, false, [2, 10], [84.6, 65.67, 73.36, 80.43, 78.9, 85.6, null, 1743, 44.3, 7.34]),
    ],
  };
}

// --- the local stand-in for benchlm.ai ---------------------------------------------------------

const weak = (etag) => (etag ?? '').replace(/^W\//, '');

/**
 * Starts a server that answers /data/manifest.json and /data/leaderboard.json like benchlm.ai:
 * ETag, 304 on If-None-Match, gzip on request (the ETag turns weak then, as on the real site).
 * site.mode: 'ok' | 'hang' | 'hang-leaderboard' | 'stall-leaderboard' | 'status' | 'status-leaderboard' | 'garbage'
 */
async function startSite(t, rows = ROWS_V1) {
  const site = {
    manifest: manifestFor(), leaderboard: leaderboardFor(rows), etag: '"m1"', leaderboardEtag: '"l1"',
    mode: 'ok', status: 503, hits: [], base: null,
    paths: () => site.hits.map((hit) => hit.path),
    use(nextRows, { version, date, etag }) {
      site.manifest = manifestFor({ dataVersion: version, sourceLastUpdated: date });
      site.leaderboard = leaderboardFor(nextRows, { dataVersion: version, sourceLastUpdated: date });
      site.etag = etag;
    },
  };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    site.hits.push({ path: req.url, method: req.method, headers: req.headers });
    const name = req.url === '/data/manifest.json' ? 'manifest' : req.url === '/data/leaderboard.json' ? 'leaderboard' : null;
    if (name === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (site.mode === 'hang' || (site.mode === 'hang-leaderboard' && name === 'leaderboard')) return; // never answers
    if (site.mode === 'status' || (site.mode === 'status-leaderboard' && name === 'leaderboard')) {
      res.writeHead(site.status, { 'Content-Type': 'text/html' });
      res.end('<html>error</html>');
      return;
    }
    const etag = name === 'manifest' ? site.etag : site.leaderboardEtag;
    if (req.headers['if-none-match'] && weak(req.headers['if-none-match']) === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    let body = Buffer.from(site.mode === 'garbage' ? '<html>not json</html>' : JSON.stringify(site[name]));
    const headers = {
      'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'public, max-age=0, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      body = gzipSync(body);
      headers['Content-Encoding'] = 'gzip';
      headers.ETag = `W/${etag}`;
    }
    res.writeHead(200, headers);
    if (site.mode === 'stall-leaderboard' && name === 'leaderboard') {
      res.write(body.subarray(0, 20)); // the body never ends
      return;
    }
    res.end(body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  site.base = `http://127.0.0.1:${server.address().port}/data/`;
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return site;
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workshop-benchlm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A refresher on the local site with a clock that the test moves by hand. */
function makeBenchlm(t, site, options = {}) {
  const clock = { now: NOON };
  const logs = [];
  const cachePath = options.cachePath ?? path.join(tempDir(t), 'cache', 'benchlm.json');
  const benchlm = createBenchlm({
    baseUrl: site.base, cachePath, now: () => clock.now, timeoutMs: 3000,
    log: (level, msg, data) => logs.push({ level, msg, data }), ...options,
  });
  return { benchlm, clock, logs, cachePath };
}

/** Rows with some changes: { slug: { overall?, evidence?, model?, slug?, key?, boards?: { coding: 82.11 } } }. */
function changed(rows, changes) {
  return clone(rows).map((row) => {
    const change = changes[row.slug];
    if (!change) return row;
    const { boards, ...rest } = change;
    return { ...row, ...rest, boards: { ...row.boards, ...boards } };
  });
}

const sortUpdates = (list) => [...list].sort((a, b) => `${a.id} ${a.key}`.localeCompare(`${b.id} ${b.key}`));
const scoresOf = (registry, id) => registry.models.find((model) => model.id === id).scores;

// --- helpers of the module -----------------------------------------------------------------------

test('names: slugs, API ids and display names compare equal after normalizeName', () => {
  assert.equal(normalizeName('Gemini 3.8 Flash'), 'gemini-3-8-flash');
  assert.equal(normalizeName('gemini-3.8-flash'), 'gemini-3-8-flash');
  assert.equal(normalizeName('gemini-3-8-flash'), 'gemini-3-8-flash');
  assert.equal(normalizeName('gpt-6.1-sol'), 'gpt-6-1-sol'); // the slug map of the report
  assert.equal(normalizeName('GPT-6.1 Sol'), 'gpt-6-1-sol');
  assert.equal(normalizeName('Gemini 3.5 Flash-Lite'), 'gemini-3-5-flash-lite');
  assert.equal(normalizeName('  Claude Fable 5.2 '), 'claude-fable-5-2');
  assert.notEqual(normalizeName('Claude Opus 5'), normalizeName('Claude Opus 5.5'));
  assert.notEqual(normalizeName('GPT-6 Sol'), normalizeName('GPT-6.1 Sol'));
  for (const value of [undefined, null, 5, {}, '']) assert.equal(normalizeName(value), '');
});

test('dates: the BenchLM date text becomes an ISO date', () => {
  assert.equal(isoDate('November 13, 2026'), '2026-11-13');
  assert.equal(isoDate('November 3, 2026'), '2026-11-03');
  assert.equal(isoDate('Nov 13, 2026'), '2026-11-13');
  assert.equal(isoDate('2026-11-12'), '2026-11-12');
  assert.equal(isoDate('2026-11-15T02:27:37.723Z'), '2026-11-15');
  for (const value of ['yesterday', 'Smarch 13, 2026', 'November 40, 2026', '', null, 20261113]) assert.equal(isoDate(value), null);
});

test('shape: extractLeaderboard reads the sample file; a category row gives `score`, never `displayScore`', () => {
  const data = extractLeaderboard(leaderboardFor(ROWS_V1));
  assert.equal(data.dataDate, '2026-11-13');
  assert.equal(data.generatedAt, GENERATED_AT);
  assert.equal(data.dataVersion, DATA_V1);
  assert.deepEqual(data.boards, ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge', 'math']);
  assert.equal(data.rows.length, ROWS_V1.length);
  const row = (slug) => data.rows.find((entry) => entry.slug === slug);
  // The sample row of the report: Claude Sonnet 5.5, agentic score 72.73, displayScore 83.05 (overall).
  assert.deepEqual(row('claude-sonnet-5-5'), {
    slug: 'claude-sonnet-5-5', key: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5', est: false,
    s: { overall: 83.05, agentic: 72.73, coding: 80.97, reasoning: 76.98, multimodalGrounded: 78.92, knowledge: 82.07 },
  });
  assert.deepEqual(row('gemini-4-hydrogen').s, { overall: 79.06, coding: 75.75 }); // no row on a board: no key
  assert.equal(row('claude-fable-5-2').est, true);
  assert.deepEqual(row('old-math-model').s, { overall: 40.1, math: 55.5 });
  // A file without the expected parts is refused.
  for (const bad of [null, [], {}, { items: 'none' }, { items: [], categories: {} }, { items: [{ slug: 'x', model: 'X' }] }]) {
    assert.throws(() => extractLeaderboard(bad), (err) => err.kind === 'data');
  }
});

// --- the refresh --------------------------------------------------------------------------------

test('recipe: the first refresh gets manifest.json, then leaderboard.json; equal data changes nothing', async (t) => {
  const site = await startSite(t);
  const { benchlm, cachePath, logs } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  const before = clone(registry);
  const result = await benchlm.refresh(registry);
  assert.deepEqual(result, {
    ok: true, changed: false, updated: [], dataDate: '2026-11-13', notModified: false, error: null,
    flags: [], unmatched: [], throttled: false, checkedAt: NOON, nextAt: NOON + 10 * MINUTE,
  });
  assert.deepEqual(registry, before);
  assert.deepEqual(site.paths(), ['/data/manifest.json', '/data/leaderboard.json']);
  for (const hit of site.hits) {
    assert.equal(hit.method, 'GET');
    assert.equal(hit.headers['user-agent'], 'WorkShop-local/0.1');
    assert.equal(hit.headers['accept-encoding'], 'gzip');
    assert.equal(hit.headers.accept, 'application/json');
    assert.equal(hit.headers['if-none-match'], undefined, 'nothing saved yet');
    for (const name of ['cookie', 'authorization', 'referer', 'from', 'x-forwarded-for']) assert.equal(hit.headers[name], undefined, name);
  }
  // The cache keeps the ETag (weak, as sent with gzip), the data version and the rows.
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(cache.etag, 'W/"m1"');
  assert.equal(cache.dataVersion, DATA_V1);
  assert.equal(cache.dataDate, '2026-11-13');
  assert.equal(cache.fetchedAt, '2026-11-20');
  assert.equal(cache.checkedAt, NOON);
  assert.equal(cache.rows.length, ROWS_V1.length);
  assert.deepEqual(readdirSync(path.dirname(cachePath)), ['benchlm.json'], 'no temp file is left');
  assert.deepEqual(logs.filter((entry) => entry.level !== 'info'), []);
});

test('privacy: the requests carry no personal data', async (t) => {
  const site = await startSite(t);
  const { benchlm } = makeBenchlm(t, site);
  await benchlm.refresh(sampleRegistry());
  const user = os.userInfo().username;
  const personal = [user, os.homedir(), os.hostname()].filter((value) => value && value.length > 2);
  const allowed = new Set(['host', 'connection', 'user-agent', 'accept', 'accept-encoding', 'accept-language', 'sec-fetch-mode', 'if-none-match']);
  assert.equal(site.hits.length, 2);
  for (const hit of site.hits) {
    assert.ok(!hit.path.includes('?'), 'no query string');
    for (const [name, value] of Object.entries(hit.headers)) {
      assert.ok(allowed.has(name), `unexpected header ${name}`);
      for (const secret of personal) assert.ok(!String(value).includes(secret), `${name} must not hold ${secret}`);
    }
  }
  assert.equal(USER_AGENT, 'WorkShop-local/0.1');
});

test('changed data: board scores are updated, everything else stays', async (t) => {
  const site = await startSite(t);
  site.use(changed(ROWS_V1, {
    'claude-sonnet-5-5': { boards: { coding: 82.11 } }, // a number changes
    'gemini-4-hydrogen': { overall: 80.2, boards: { agentic: 70.5 } }, // a missing score appears
    'gemini-3-5-flash-lite': { boards: { knowledge: null } }, // a score is gone
    'claude-fable-5-2': { evidence: 'supported' }, // BenchLM no longer calls it "Estimated"
    'claude-opus-5': { boards: { coding: 99.9 } }, // not our model
  }), { version: DATA_V2, date: 'November 20, 2026', etag: '"m2"' });
  const { benchlm } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  const before = clone(registry);
  const result = await benchlm.refresh(registry);

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.notModified, false);
  assert.equal(result.error, null);
  assert.equal(result.dataDate, '2026-11-20');
  assert.deepEqual(sortUpdates(result.updated), [
    { id: 'claude-sonnet-5-5', key: 'coding', from: 80.97, to: 82.11 },
    { id: 'gemini-3.5-flash-lite', key: 'knowledge', from: 46.7, to: null },
    { id: 'gemini-4-hydrogen', key: 'agentic', from: null, to: 70.5 },
    { id: 'gemini-4-hydrogen', key: 'overall', from: 79.06, to: 80.2 },
  ]);
  assert.deepEqual(result.flags, [{ id: 'claude-fable-5-2', key: 'estimated', from: true, to: false }]);
  assert.deepEqual(result.unmatched, []);

  // The registry itself was changed in place.
  assert.equal(scoresOf(registry, 'claude-sonnet-5-5').coding, 82.11);
  assert.equal(scoresOf(registry, 'gemini-4-hydrogen').agentic, 70.5);
  assert.equal(scoresOf(registry, 'gemini-4-hydrogen').overall, 80.2);
  assert.equal(scoresOf(registry, 'gemini-3.5-flash-lite').knowledge, null);
  assert.equal(registry.models[0].estimated, false);
  assert.equal(registry.dataDate, '2026-11-20');
  assert.equal(registry.fetchedAt, '2026-11-20');
  for (const key of ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge']) {
    assert.equal(registry.categories[key].date, '2026-11-20', key);
  }
  // Keys from other sources keep their numbers and dates. The math board has no row for our models.
  assert.equal(registry.categories.arenaWebDevElo.date, '2026-11-11');
  assert.equal(registry.categories.bugHuntBench.date, '2026-11-13');
  assert.equal(registry.categories.codingValueIndex.date, '2026-11-13');
  for (const [i, model] of registry.models.entries()) {
    for (const key of ['math', 'arenaWebDevElo', 'bugHuntBench', 'codingValueIndex']) {
      assert.equal(model.scores[key], before.models[i].scores[key], `${model.id}.${key}`);
    }
  }
  // Undo the listed changes: the registry is then exactly what it was. So nothing else moved:
  // no model deleted or added, none enabled, no tier, power, price, label or effort changed.
  const undone = clone(registry);
  for (const { id, key, from } of result.updated) scoresOf(undone, id)[key] = from;
  for (const { id, from } of result.flags) undone.models.find((model) => model.id === id).estimated = from;
  undone.dataDate = before.dataDate;
  undone.fetchedAt = before.fetchedAt;
  for (const key of Object.keys(undone.categories)) {
    if (Object.hasOwn(before.categories[key], 'date')) undone.categories[key].date = before.categories[key].date;
  }
  assert.deepEqual(undone, before);
  assert.deepEqual(registry.models.map((m) => [m.id, m.enabled, m.tiers.join('+')]), before.models.map((m) => [m.id, m.enabled, m.tiers.join('+')]));
  // The result is still a valid registry: the router can save it and route with it.
  assert.doesNotThrow(() => validateRegistry(registry));
  const file = path.join(tempDir(t), 'models.json');
  writeFileSync(file, JSON.stringify(before));
  const router = createRouter({ modelsPath: file, providers: { usable: () => true }, getSettings: () => ({ thrift: 0 }) });
  assert.equal(router.save(registry).models[3].scores.coding, 82.11);
  assert.match(router.pick({ role: 'maker', domain: 'backend', size: 'M' }).why, /coding 82\.11 vs 75\.75/);
});

test('trap: a category row holds the category score in `score`; `displayScore` there is the overall score', async (t) => {
  const site = await startSite(t);
  const leaderboard = leaderboardFor(ROWS_V1);
  // The row of the report: categories.agentic, Claude Sonnet 5.5, score 72.73, displayScore 83.05.
  const sonnet = leaderboard.categories.agentic.find((row) => row.model === 'Claude Sonnet 5.5');
  assert.deepEqual([sonnet.score, sonnet.displayScore, sonnet.category], [72.73, 83.05, 'agentic']);
  // In items[] both fields are the overall score, and provisionalDisplayScore is something else.
  const fable = leaderboard.items[0];
  assert.deepEqual([fable.score, fable.displayScore, fable.provisionalDisplayScore, fable.category], [93.65, 93.65, 87, null]);
  // A category row without `score` has no category score, whatever its displayScore says.
  const haiku = leaderboard.categories.knowledge.find((row) => row.model === 'Claude Haiku 5.5');
  delete haiku.score;
  // An overall row without `score` still has the overall score in displayScore.
  delete leaderboard.items.find((row) => row.slug === 'gemini-4-carbon').score;
  site.leaderboard = leaderboard;

  const { benchlm } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, true);
  // A reader that took displayScore would have written 83.05 into every board of Sonnet 5.5.
  assert.deepEqual(result.updated, [{ id: 'claude-haiku-5-5', key: 'knowledge', from: 65.22, to: null }]);
  const s = scoresOf(registry, 'claude-sonnet-5-5');
  assert.deepEqual([s.overall, s.agentic, s.coding, s.reasoning, s.multimodalGrounded, s.knowledge], [83.05, 72.73, 80.97, 76.98, 78.92, 82.07]);
  assert.equal(scoresOf(registry, 'claude-fable-5-2').overall, 93.65);
  assert.equal(scoresOf(registry, 'gemini-4-carbon').overall, 89.15);
  for (const model of registry.models) {
    for (const key of ['agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge']) {
      if (model.scores[key] !== null) assert.notEqual(model.scores[key], model.scores.overall, `${model.id}.${key} is not the overall score`);
    }
  }
});

test('304: the saved ETag goes out as If-None-Match, and 304 Not Modified stops the refresh', async (t) => {
  const site = await startSite(t);
  const { benchlm, clock, cachePath } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  await benchlm.refresh(registry);
  assert.equal(site.hits.length, 2);

  clock.now += 11 * MINUTE;
  const before = clone(registry);
  const result = await benchlm.refresh(registry);
  assert.deepEqual(site.paths().slice(2), ['/data/manifest.json'], 'one small request, no download');
  assert.equal(site.hits[2].headers['if-none-match'], 'W/"m1"');
  assert.deepEqual(result, {
    ok: true, changed: false, updated: [], dataDate: '2026-11-13', notModified: true, error: null,
    flags: [], unmatched: [], throttled: false, checkedAt: NOON + 11 * MINUTE, nextAt: NOON + 21 * MINUTE,
  });
  assert.deepEqual(registry, before);
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).checkedAt, NOON + 11 * MINUTE);
});

test('304: a new manifest with the same data version does not download the leaderboard again', async (t) => {
  const site = await startSite(t);
  const { benchlm, clock } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  await benchlm.refresh(registry);
  // BenchLM rebuilt the export: new build time and ETag, same content hash.
  site.manifest = manifestFor({ generatedAt: '2026-11-16T02:00:00.000Z' });
  site.etag = '"m2"';
  clock.now += 11 * MINUTE;
  const result = await benchlm.refresh(registry);
  assert.deepEqual(site.paths().slice(2), ['/data/manifest.json']);
  assert.equal(site.hits[2].headers['if-none-match'], 'W/"m1"');
  assert.equal(result.ok, true);
  assert.equal(result.notModified, true);
  assert.equal(result.changed, false);
  // The new ETag is the one to send next time.
  clock.now += 11 * MINUTE;
  await benchlm.refresh(registry);
  assert.equal(site.hits[3].headers['if-none-match'], 'W/"m2"');
  assert.deepEqual(site.paths().slice(3), ['/data/manifest.json']);
});

test('304: after "not modified", new data is seen and imported', async (t) => {
  const site = await startSite(t);
  const { benchlm, clock } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  await benchlm.refresh(registry);
  clock.now += 11 * MINUTE;
  assert.equal((await benchlm.refresh(registry)).notModified, true);

  site.use(changed(ROWS_V1, { 'claude-haiku-5-5': { boards: { coding: 61.5 } } }), { version: DATA_V2, date: 'November 21, 2026', etag: '"m2"' });
  clock.now += 11 * MINUTE;
  const result = await benchlm.refresh(registry);
  assert.deepEqual(site.paths().slice(3), ['/data/manifest.json', '/data/leaderboard.json']);
  assert.equal(result.notModified, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.updated, [{ id: 'claude-haiku-5-5', key: 'coding', from: 58.93, to: 61.5 }]);
  assert.equal(result.dataDate, '2026-11-21');
  assert.equal(scoresOf(registry, 'claude-haiku-5-5').coding, 61.5);
});

test('names: registry ids match BenchLM rows by slug, canonical key or name; near names do not match', async (t) => {
  const site = await startSite(t);
  site.use(changed(ROWS_V1, {
    'gemini-3-8-flash': { boards: { coding: 56.6 } }, // id "gemini-3.8-flash", slug "gemini-3-8-flash"
    'gpt-6-1-sol': { boards: { coding: 74.4 } }, // id "gpt-6.1-sol", slug "gpt-6-1-sol"
    'gpt-6-sol': { boards: { coding: 11.1 } }, // GPT-6 Sol is another model
    'claude-opus-5': { boards: { coding: 22.2 } }, // Claude Opus 5 is another model
  }), { version: DATA_V2, date: 'November 20, 2026', etag: '"m2"' });
  const { benchlm } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  // The slug that the registry names for a model goes first. When BenchLM no longer has it, the id is tried.
  registry.models.find((model) => model.id === 'gpt-6.1-sol').benchlmSlug = 'gpt-6-1-sol';
  registry.models.find((model) => model.id === 'gemini-3.8-flash').benchlmSlug = 'a-slug-that-is-gone';
  const result = await benchlm.refresh(registry);
  assert.deepEqual(sortUpdates(result.updated), [
    { id: 'gemini-3.8-flash', key: 'coding', from: 55.3, to: 56.6 },
    { id: 'gpt-6.1-sol', key: 'coding', from: 73.36, to: 74.4 },
  ]);
  assert.equal(scoresOf(registry, 'claude-opus-5-5').coding, 82.6);
  assert.deepEqual(result.unmatched, []);
  // A named slug wins over the id: this registry entry points at another BenchLM model on purpose.
  const pointed = sampleRegistry();
  pointed.models.find((model) => model.id === 'claude-opus-5-5').benchlmSlug = 'claude-opus-5';
  const other = await makeBenchlm(t, site).benchlm.refresh(pointed);
  assert.ok(other.updated.some((entry) => entry.id === 'claude-opus-5-5' && entry.key === 'coding' && entry.to === 22.2));
});

test('names: a model that BenchLM renamed is still found, and the registry id never changes', async (t) => {
  const site = await startSite(t);
  site.use(changed(ROWS_V1, {
    // New slug and key, same display name: found by name.
    'gemini-4-hydrogen': { slug: 'gemini-4-hydrogen-ga', key: 'gemini-4-hydrogen-ga', boards: { coding: 77.7 } },
    // New display name, same slug: found by slug.
    'claude-haiku-5-5': { model: 'Claude Haiku 5.5 (October 2026)', boards: { coding: 60 } },
    // New slug and name, the canonical key stays: found by key.
    'claude-sonnet-5-5': { slug: 'anthropic-sonnet-55', model: 'Sonnet 5.5', key: 'claude-sonnet-5-5', boards: { coding: 81.5 } },
    // Everything is new: not found.
    'gemini-4-carbon': { slug: 'gemini-4-c', key: 'gemini-4-c', model: 'Gemini 4 C', boards: { coding: 88.8 } },
  }), { version: DATA_V2, date: 'November 20, 2026', etag: '"m2"' });
  const { benchlm, clock, logs } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  const idsBefore = registry.models.map((model) => [model.id, model.label]);
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, true);
  assert.deepEqual(sortUpdates(result.updated), [
    { id: 'claude-haiku-5-5', key: 'coding', from: 58.93, to: 60 },
    { id: 'claude-sonnet-5-5', key: 'coding', from: 80.97, to: 81.5 },
    { id: 'gemini-4-hydrogen', key: 'coding', from: 75.75, to: 77.7 },
  ]);
  // The model that was not found keeps every score, and the result says which one it was.
  assert.deepEqual(result.unmatched, ['gemini-4-carbon']);
  assert.deepEqual(scoresOf(registry, 'gemini-4-carbon'), scoresOf(sampleRegistry(), 'gemini-4-carbon'));
  assert.ok(logs.some((entry) => entry.level === 'warn' && /no BenchLM row/.test(entry.msg) && entry.data.ids.includes('gemini-4-carbon')));
  assert.deepEqual(registry.models.map((model) => [model.id, model.label]), idsBefore);
  // The owner can name the new slug in the registry. The cached rows are enough: no new download.
  registry.models.find((model) => model.id === 'gemini-4-carbon').benchlmSlug = 'gemini-4-c';
  clock.now += MINUTE;
  const again = await benchlm.refresh(registry);
  assert.equal(site.hits.length, 2);
  assert.deepEqual(again.updated, [{ id: 'gemini-4-carbon', key: 'coding', from: 83.88, to: 88.8 }]);
  assert.deepEqual(again.unmatched, []);
});

test('names: category rows without a slug (the short row of the report) are matched by name', async (t) => {
  const site = await startSite(t);
  const leaderboard = leaderboardFor(changed(ROWS_V1, { 'claude-opus-5-5': { boards: { reasoning: 81.9 } } }), { dataVersion: DATA_V2 });
  for (const list of Object.values(leaderboard.categories)) {
    for (const row of list) {
      delete row.slug;
      delete row.canonicalModelKey;
    }
  }
  site.manifest = manifestFor({ dataVersion: DATA_V2 });
  site.leaderboard = leaderboard;
  const { benchlm } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  const result = await benchlm.refresh(registry);
  assert.deepEqual(result.updated, [{ id: 'claude-opus-5-5', key: 'reasoning', from: 80.53, to: 81.9 }]);
  assert.deepEqual(result.unmatched, []);
});

test('names: rows of one model are put together, rows of two models with one name are kept apart', () => {
  const item = (slug, model, score) => ({ slug, canonicalModelKey: slug, model, score, displayScore: score, evidenceStatus: 'supported', category: null });
  const data = extractLeaderboard({
    items: [
      { model: 'Claude Sonnet 5.5', score: 83.05, displayScore: 83.05, evidenceStatus: 'supported' }, // no slug in the overall row
      item('twin-a', 'Twin', 70),
      item('twin-b', 'Twin', 60), // another model with the same display name
    ],
    categories: {
      coding: [
        { slug: 'claude-sonnet-5-5', model: 'Claude Sonnet 5.5', score: 80.97, displayScore: 83.05, category: 'coding' }, // the slug comes later
        { slug: 'twin-b', model: 'Twin', score: 55, displayScore: 60, category: 'coding' },
        { model: 'Twin', score: 66, displayScore: 70, category: 'coding' }, // no slug: the first "Twin"
        { canonicalModelKey: 'twin-b', model: 'Renamed Twin', score: 1, displayScore: 60, category: 'coding' }, // twin-b has a score already
      ],
    },
  });
  assert.deepEqual(data.rows, [
    { slug: 'claude-sonnet-5-5', key: null, name: 'claude-sonnet-5-5', est: false, s: { overall: 83.05, coding: 80.97 } },
    { slug: 'twin-a', key: 'twin-a', name: 'twin', est: false, s: { overall: 70, coding: 66 } },
    { slug: 'twin-b', key: 'twin-b', name: 'twin', est: false, s: { overall: 60, coding: 55 } },
  ]);
});

test('null: a missing score is null, never zero; rows that are not numbers are ignored', async (t) => {
  const site = await startSite(t);
  const rows = changed(ROWS_V1, {
    'gemini-4-carbon': { boards: { knowledge: 88.1 } }, // null -> number
    'claude-opus-5-5': { boards: { multimodalGrounded: null } }, // number -> null
    'gemini-3-5-flash-lite': { boards: { reasoning: 0 } }, // a real zero stays a zero
  });
  const leaderboard = leaderboardFor(rows, { dataVersion: DATA_V2 });
  leaderboard.categories.coding.find((row) => row.slug === 'claude-fable-5-2').score = '89.23'; // text, not a number
  leaderboard.categories.agentic.find((row) => row.slug === 'claude-fable-5-2').score = null;
  leaderboard.categories.agentic.push(null, 'junk', { slug: 'claude-haiku-5-5' });
  leaderboard.items.push({ slug: '', model: '' }, 7);
  site.manifest = manifestFor({ dataVersion: DATA_V2 });
  site.leaderboard = leaderboard;
  const { benchlm } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, true);
  assert.deepEqual(sortUpdates(result.updated), [
    { id: 'claude-fable-5-2', key: 'agentic', from: 90.71, to: null },
    { id: 'claude-fable-5-2', key: 'coding', from: 89.23, to: null },
    { id: 'claude-opus-5-5', key: 'multimodalGrounded', from: 85.09, to: null },
    { id: 'gemini-3.5-flash-lite', key: 'reasoning', from: 9.09, to: 0 },
    { id: 'gemini-4-carbon', key: 'knowledge', from: null, to: 88.1 },
  ]);
  assert.strictEqual(scoresOf(registry, 'gemini-3.5-flash-lite').reasoning, 0);
  assert.strictEqual(scoresOf(registry, 'claude-opus-5-5').multimodalGrounded, null);
  // Scores that were null and still have no row stay null.
  assert.deepEqual(
    ['agentic', 'reasoning', 'multimodalGrounded', 'knowledge'].map((key) => scoresOf(registry, 'gemini-4-hydrogen')[key]),
    [null, null, null, null],
  );
});

test('null: a board that is gone, or that has no row for any registry model, leaves the scores alone', async (t) => {
  const site = await startSite(t);
  const leaderboard = leaderboardFor(ROWS_V1, { dataVersion: DATA_V2 });
  delete leaderboard.categories.reasoning; // the board is not in the file
  leaderboard.categories.knowledge = []; // the board is empty
  // The coding rows changed their layout: the reader finds no row of our models there.
  leaderboard.categories.coding = leaderboard.categories.coding.map((row) => ({ rank: row.rank, id: row.slug, value: row.score }));
  site.manifest = manifestFor({ dataVersion: DATA_V2 });
  site.leaderboard = leaderboard;
  const { benchlm } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  const before = clone(registry);
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, true);
  assert.deepEqual(result.updated, []);
  assert.equal(result.changed, false);
  assert.deepEqual(registry, before);
});

test('scope: only keys of BenchLM boards are refreshed; "board" names the board, false switches a key off', async (t) => {
  const site = await startSite(t);
  const rows = changed(ROWS_V1, {
    'claude-sonnet-5-5': { boards: { coding: 82.11, agentic: 73.5, math: 44.4 } },
    'claude-haiku-5-5': { boards: { coding: 61 } },
  });
  site.use(rows, { version: DATA_V2, date: 'November 20, 2026', etag: '"m2"' });
  const { benchlm } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  registry.categories.coding.board = false; // the owner pins this key
  registry.categories.swe = { label: 'Agentic under another name', scale: '0-100', tie: 5, source: 'BenchLM', board: 'agentic' };
  for (const model of registry.models) model.scores.swe = null;
  const webdev = registry.models.map((model) => model.scores.arenaWebDevElo);
  const result = await benchlm.refresh(registry);
  assert.deepEqual(sortUpdates(result.updated), [
    { id: 'claude-fable-5-2', key: 'swe', from: null, to: 90.71 },
    { id: 'claude-haiku-5-5', key: 'swe', from: null, to: 60.11 },
    { id: 'claude-opus-5-5', key: 'swe', from: null, to: 83.85 },
    { id: 'claude-sonnet-5-5', key: 'agentic', from: 72.73, to: 73.5 },
    { id: 'claude-sonnet-5-5', key: 'math', from: null, to: 44.4 }, // "math" has no board field: the key is a BenchLM board name
    { id: 'claude-sonnet-5-5', key: 'swe', from: null, to: 73.5 },
    { id: 'gemini-3.5-flash-lite', key: 'swe', from: null, to: 34.16 },
    { id: 'gemini-3.8-flash', key: 'swe', from: null, to: 63.55 },
    { id: 'gemini-4-carbon', key: 'swe', from: null, to: 84.61 },
    { id: 'gpt-6.1-sol', key: 'swe', from: null, to: 65.67 },
  ]);
  assert.equal(scoresOf(registry, 'claude-sonnet-5-5').coding, 80.97, 'board: false keeps the key');
  assert.equal(scoresOf(registry, 'claude-haiku-5-5').coding, 58.93);
  assert.deepEqual(registry.models.map((model) => model.scores.arenaWebDevElo), webdev);
  // codingValueIndex has the source "BenchLM" but is not a board: it is never touched.
  assert.equal(scoresOf(registry, 'claude-sonnet-5-5').codingValueIndex, 8.1);
});

test('timeout: a server that never answers gives { ok: false } and changes nothing', async (t) => {
  const site = await startSite(t);
  site.mode = 'hang';
  const { benchlm, cachePath, logs } = makeBenchlm(t, site, { timeoutMs: 150 });
  const registry = sampleRegistry();
  const before = clone(registry);
  const started = Date.now();
  const result = await benchlm.refresh(registry);
  const took = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.updated, []);
  assert.equal(result.notModified, false);
  assert.equal(result.dataDate, '2026-11-13');
  assert.match(result.error, /^BenchLM refresh failed: manifest\.json: 127\.0\.0\.1:\d+ did not answer within 150 ms$/);
  assert.ok(took >= 140 && took < 2500, `took ${took} ms`);
  assert.deepEqual(registry, before);
  assert.equal(existsSync(cachePath), false, 'nothing is saved after a failure');
  assert.deepEqual(site.paths(), ['/data/manifest.json']);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /refresh failed/.test(entry.msg)));
});

test('timeout: a leaderboard download that hangs or stalls changes nothing, and the next try gets the data', async (t) => {
  for (const mode of ['hang-leaderboard', 'stall-leaderboard']) {
    const site = await startSite(t);
    site.use(changed(ROWS_V1, { 'claude-sonnet-5-5': { boards: { coding: 82.11 } } }), { version: DATA_V2, date: 'November 20, 2026', etag: '"m2"' });
    site.mode = mode;
    // 600 ms: long enough for the local manifest answer on a busy machine, short enough for a test.
    const { benchlm, clock, cachePath } = makeBenchlm(t, site, { timeoutMs: 600 });
    const registry = sampleRegistry();
    const before = clone(registry);
    const failed = await benchlm.refresh(registry);
    assert.equal(failed.ok, false, mode);
    assert.match(failed.error, /leaderboard\.json: 127\.0\.0\.1:\d+ did not answer within 600 ms/);
    assert.deepEqual(registry, before);
    assert.equal(existsSync(cachePath), false, 'the new ETag is not kept, or the update would be lost');
    assert.deepEqual(site.paths(), ['/data/manifest.json', '/data/leaderboard.json']);
    // Right away: paused, no request. The requests of this round reached the server, so the 10 minute
    // rule holds (at most one refresh per 10 minutes): one minute later there is still no request.
    const paused = await benchlm.refresh(registry);
    assert.equal(paused.ok, false);
    assert.equal(paused.throttled, true);
    assert.match(paused.error, /paused for 600 s after an error/);
    assert.equal(site.hits.length, 2);
    site.mode = 'ok';
    clock.now += MINUTE;
    const early = await benchlm.refresh(registry);
    assert.equal(early.ok, false);
    assert.equal(early.throttled, true);
    assert.equal(site.hits.length, 2, 'no second round one minute after a timeout');
    assert.deepEqual(registry, before);
    // Ten minutes after the failed round the server is asked again, and it works.
    clock.now += 9 * MINUTE;
    const result = await benchlm.refresh(registry);
    assert.equal(result.ok, true, mode);
    assert.equal(site.hits[2].headers['if-none-match'], undefined);
    assert.deepEqual(site.paths().slice(2), ['/data/manifest.json', '/data/leaderboard.json']);
    assert.deepEqual(result.updated, [{ id: 'claude-sonnet-5-5', key: 'coding', from: 80.97, to: 82.11 }]);
  }
});

test('timeout: every request has a deadline, also with a fetch function that ignores the abort signal', async () => {
  const stuck = () => new Promise(() => {}); // never settles
  const benchlm = createBenchlm({ fetchImpl: stuck, timeoutMs: 100, now: () => NOON });
  const registry = sampleRegistry();
  const before = clone(registry);
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, false);
  assert.match(result.error, /manifest\.json: benchlm\.ai did not answer within 100 ms/);
  assert.deepEqual(registry, before);
});

test('network failure: no server at all gives { ok: false, error } and changes nothing', async (t) => {
  // A port that was open a moment ago and is closed now.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const cachePath = path.join(tempDir(t), 'benchlm.json');
  const benchlm = createBenchlm({ baseUrl: `http://127.0.0.1:${port}/data/`, cachePath, now: () => NOON, timeoutMs: 3000 });
  const registry = sampleRegistry();
  const before = clone(registry);
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.updated, []);
  assert.match(result.error, /^BenchLM refresh failed: manifest\.json: cannot reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\)$/);
  assert.deepEqual(registry, before);
  assert.equal(existsSync(cachePath), false);
});

test('network failure: an error answer or a broken file gives { ok: false } and changes nothing', async (t) => {
  const cases = [
    ['status', (site) => { site.status = 503; }, /manifest\.json: 127\.0\.0\.1:\d+ answered HTTP 503/, 1],
    ['status', (site) => { site.status = 404; }, /manifest\.json: 127\.0\.0\.1:\d+ answered HTTP 404/, 1],
    ['status-leaderboard', (site) => { site.status = 500; }, /leaderboard\.json: 127\.0\.0\.1:\d+ answered HTTP 500/, 2],
    ['garbage', () => {}, /manifest\.json: the answer is not valid JSON/, 1],
    ['ok', (site) => { site.manifest = ['not', 'a', 'manifest']; }, /manifest\.json does not have the expected shape/, 1],
    ['ok', (site) => { site.leaderboard = { schemaVersion: '2.0', rows: [] }; }, /leaderboard\.json does not have the expected shape/, 2],
    ['ok', (site) => { site.leaderboard = { items: [], categories: {} }; }, /leaderboard\.json holds no scores/, 2],
  ];
  for (const [mode, setup, pattern, requests] of cases) {
    const site = await startSite(t);
    site.use(changed(ROWS_V1, { 'claude-sonnet-5-5': { boards: { coding: 82.11 } } }), { version: DATA_V2, date: 'November 20, 2026', etag: '"m2"' });
    site.mode = mode;
    setup(site);
    const { benchlm, clock, cachePath } = makeBenchlm(t, site);
    const registry = sampleRegistry();
    const before = clone(registry);
    const result = await benchlm.refresh(registry);
    assert.equal(result.ok, false, String(pattern));
    assert.match(result.error, pattern);
    assert.equal(result.changed, false);
    assert.deepEqual(result.updated, []);
    assert.deepEqual(registry, before, String(pattern));
    assert.equal(existsSync(cachePath), false);
    assert.equal(site.hits.length, requests);
    // The server did answer, so the 10 minute rule holds before the next try.
    clock.now += 9 * MINUTE;
    const paused = await benchlm.refresh(registry);
    assert.equal(paused.ok, false);
    assert.equal(paused.throttled, true);
    assert.equal(site.hits.length, requests, 'no request while paused');
    assert.deepEqual(registry, before);
  }
});

test('rate: at most one refresh per 10 minutes reaches the server', async (t) => {
  const site = await startSite(t);
  const { benchlm, clock } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  assert.equal((await benchlm.refresh(registry)).throttled, false);
  assert.equal(site.hits.length, 2);
  for (const minutes of [0, 1, 5, 9.9]) {
    clock.now = NOON + minutes * MINUTE;
    const result = await benchlm.refresh(registry);
    assert.deepEqual(
      [result.ok, result.throttled, result.notModified, result.changed, result.error, result.nextAt],
      [true, true, true, false, null, NOON + 10 * MINUTE],
      `after ${minutes} minutes`,
    );
    assert.equal(site.hits.length, 2, `no request after ${minutes} minutes`);
  }
  clock.now = NOON + 10 * MINUTE;
  const result = await benchlm.refresh(registry);
  assert.equal(result.throttled, false);
  assert.equal(site.hits.length, 3);
  // A clock that jumped back does not lock the refresh for ever.
  clock.now = NOON - 60 * MINUTE;
  assert.equal((await benchlm.refresh(registry)).throttled, false);
  assert.equal(site.hits.length, 4);
});

test('rate: calls at the same time share one round of requests', async (t) => {
  const site = await startSite(t);
  site.use(changed(ROWS_V1, { 'claude-sonnet-5-5': { boards: { coding: 82.11 } } }), { version: DATA_V2, date: 'November 20, 2026', etag: '"m2"' });
  const { benchlm } = makeBenchlm(t, site);
  const one = sampleRegistry();
  const two = sampleRegistry();
  const three = sampleRegistry();
  const results = await Promise.all([benchlm.refresh(one), benchlm.refresh(two), benchlm.refresh(three)]);
  assert.deepEqual(site.paths(), ['/data/manifest.json', '/data/leaderboard.json']);
  assert.deepEqual(results.map((result) => [result.ok, result.changed, result.throttled]), [[true, true, false], [true, true, true], [true, true, true]]);
  for (const registry of [one, two, three]) assert.equal(scoresOf(registry, 'claude-sonnet-5-5').coding, 82.11);
});

test('cache: a new process sends the saved ETag and keeps the 10 minute rule', async (t) => {
  const site = await startSite(t);
  site.use(changed(ROWS_V1, { 'claude-sonnet-5-5': { boards: { coding: 82.11 } } }), { version: DATA_V2, date: 'November 20, 2026', etag: '"m2"' });
  const first = makeBenchlm(t, site);
  await first.benchlm.refresh(sampleRegistry());
  assert.equal(site.hits.length, 2);

  // "Restart": a new instance on the same cache file, with a registry that never got the update.
  const second = makeBenchlm(t, site, { cachePath: first.cachePath });
  const stale = sampleRegistry();
  second.clock.now = NOON + 2 * MINUTE;
  const soon = await second.benchlm.refresh(stale);
  assert.equal(site.hits.length, 2, 'inside the 10 minutes: no request');
  assert.equal(soon.throttled, true);
  // The rows of the cache still bring the registry up to date.
  assert.equal(soon.changed, true);
  assert.deepEqual(soon.updated, [{ id: 'claude-sonnet-5-5', key: 'coding', from: 80.97, to: 82.11 }]);
  assert.equal(stale.dataDate, '2026-11-20');
  assert.equal(stale.fetchedAt, '2026-11-20', 'the day of the download');

  second.clock.now = NOON + 12 * MINUTE;
  const later = await second.benchlm.refresh(stale);
  assert.deepEqual(site.paths().slice(2), ['/data/manifest.json']);
  assert.equal(site.hits[2].headers['if-none-match'], 'W/"m2"');
  assert.equal(later.notModified, true);
  assert.equal(later.changed, false);
});

test('cache: a broken or foreign cache file is ignored', async (t) => {
  const site = await startSite(t);
  for (const text of ['not json', '{"v":99,"rows":[]}', '[]', JSON.stringify({ v: 1, etag: '"m1"', checkedAt: NOON, boards: ['overall'], rows: [] })]) {
    const cachePath = path.join(tempDir(t), 'benchlm.json');
    writeFileSync(cachePath, text);
    const { benchlm } = makeBenchlm(t, site, { cachePath });
    const before = site.hits.length;
    const result = await benchlm.refresh(sampleRegistry());
    assert.equal(result.ok, true, text);
    assert.equal(site.hits[before].headers['if-none-match'], undefined, 'no ETag from a bad cache');
    assert.deepEqual(site.paths().slice(before), ['/data/manifest.json', '/data/leaderboard.json']);
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).rows.length, ROWS_V1.length, 'replaced by a good cache');
  }
  // Without cachePath the refresh works and keeps its state in memory.
  const memory = createBenchlm({ baseUrl: site.base, now: () => NOON });
  assert.equal((await memory.refresh(sampleRegistry())).ok, true);
  assert.equal((await memory.refresh(sampleRegistry())).throttled, true);
});

test('cache: BenchLM data that is older than the registry is not applied', async (t) => {
  const site = await startSite(t); // data of 2026-11-13
  const { benchlm, logs } = makeBenchlm(t, site);
  const registry = sampleRegistry();
  registry.dataDate = '2026-12-01'; // a newer registry, for example from an app update
  scoresOf(registry, 'claude-sonnet-5-5').coding = 85;
  const before = clone(registry);
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.updated, []);
  assert.equal(result.dataDate, '2026-12-01');
  assert.deepEqual(registry, before);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /older than the registry/.test(entry.msg)));
});

test('input: a value that is not a registry gives { ok: false } without a request', async (t) => {
  const site = await startSite(t);
  const { benchlm } = makeBenchlm(t, site);
  for (const bad of [undefined, null, 'registry', [], {}, { models: [] }, { categories: {} }]) {
    const result = await benchlm.refresh(bad);
    assert.equal(result.ok, false);
    assert.match(result.error, /not a model registry/);
  }
  assert.equal(site.hits.length, 0);
  // Models without scores and strange entries are skipped, not a crash.
  const registry = sampleRegistry();
  registry.models.push(null, { id: 'no-scores', label: 'No Scores' });
  assert.equal((await benchlm.refresh(registry)).ok, true);
  assert.throws(() => createBenchlm({ fetchImpl: 'fetch' }), /needs a fetch function/);
});

test('urls: the default files are https://benchlm.ai/data/manifest.json and /leaderboard.json', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = url.endsWith('/manifest.json') ? manifestFor() : leaderboardFor(ROWS_V1);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag: '"802c92dff095ea6ce39372638f4253a3"' } });
  };
  let now = NOON;
  const benchlm = createBenchlm({ fetchImpl, now: () => now });
  const registry = sampleRegistry();
  const result = await benchlm.refresh(registry);
  assert.equal(result.ok, true);
  assert.equal(BENCHLM_BASE_URL, 'https://benchlm.ai/data/');
  assert.deepEqual(calls.map((call) => call.url), ['https://benchlm.ai/data/manifest.json', 'https://benchlm.ai/data/leaderboard.json']);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.deepEqual(init.headers, { 'User-Agent': 'WorkShop-local/0.1', Accept: 'application/json', 'Accept-Encoding': 'gzip' });
    assert.ok(init.signal instanceof AbortSignal, 'every request can be aborted by its deadline');
  }
  now += 10 * MINUTE;
  await benchlm.refresh(registry);
  assert.equal(calls[2].url, 'https://benchlm.ai/data/manifest.json');
  assert.equal(calls[2].init.headers['If-None-Match'], '"802c92dff095ea6ce39372638f4253a3"');
});

test('urls: a fetch stand-in that does not unpack gzip, or has no body stream, still works', async () => {
  const rows = changed(ROWS_V1, { 'claude-sonnet-5-5': { boards: { coding: 82.11 } } });
  const zipped = async (url) => {
    const body = url.endsWith('/manifest.json') ? manifestFor({ dataVersion: DATA_V2 }) : leaderboardFor(rows, { dataVersion: DATA_V2 });
    return new Response(gzipSync(JSON.stringify(body)), { status: 200 }); // no Content-Encoding header: the bytes stay packed
  };
  const one = sampleRegistry();
  const first = await createBenchlm({ fetchImpl: zipped, now: () => NOON }).refresh(one);
  assert.deepEqual(first.updated, [{ id: 'claude-sonnet-5-5', key: 'coding', from: 80.97, to: 82.11 }]);

  const plain = async (url) => ({
    status: 200,
    headers: new Map([['etag', '"e1"']]),
    text: async () => JSON.stringify(url.endsWith('/manifest.json') ? manifestFor({ dataVersion: DATA_V2 }) : leaderboardFor(rows, { dataVersion: DATA_V2 })),
  });
  const two = sampleRegistry();
  const second = await createBenchlm({ fetchImpl: plain, now: () => NOON }).refresh(two);
  assert.deepEqual(second.updated, [{ id: 'claude-sonnet-5-5', key: 'coding', from: 80.97, to: 82.11 }]);

  // An answer that is too large is refused.
  const small = await createBenchlm({ fetchImpl: plain, now: () => NOON, maxBytes: 500 }).refresh(sampleRegistry());
  assert.equal(small.ok, false);
  assert.match(small.error, /larger than 500 bytes/);
});

test('shipped registry: a leaderboard with the same numbers changes nothing, and the result can be saved', async (t) => {
  const shipped = JSON.parse(readFileSync(SHIPPED, 'utf8'));
  const boardKeys = Object.entries(shipped.categories).filter(([, category]) => category.board).map(([key, category]) => [key, category.board]);
  for (const key of ['overall', 'agentic', 'coding', 'reasoning', 'multimodalGrounded', 'knowledge']) {
    assert.ok(boardKeys.some(([name]) => name === key), `${key} is refreshed from a BenchLM board`);
  }
  // BenchLM rows built from the registry itself. The slug is the id with dots as dashes (report section 3.7).
  const rows = shipped.models.map((model) => ({
    slug: model.id.replaceAll('.', '-'), model: `${model.label} (BenchLM name)`, creator: model.provider, evidence: model.estimated ? 'estimated' : 'supported',
    overall: model.scores.overall,
    boards: Object.fromEntries(boardKeys.filter(([key]) => key !== 'overall').map(([key, name]) => [name, model.scores[key]])),
  }));
  const site = await startSite(t, rows);
  site.leaderboard = leaderboardFor(rows, { sourceLastUpdated: shipped.dataDate });
  const { benchlm, clock } = makeBenchlm(t, site);
  const registry = clone(shipped);
  const same = await benchlm.refresh(registry);
  assert.equal(same.ok, true);
  assert.deepEqual(same.updated, []);
  assert.deepEqual(same.unmatched, []);
  assert.deepEqual(registry.models, shipped.models);
  // Nothing at all changes when the board dates already equal the data date (as in the shipped file).
  const datesAgree = boardKeys.every(([key]) => [undefined, shipped.dataDate].includes(shipped.categories[key].date));
  if (datesAgree) {
    assert.equal(same.changed, false);
    assert.deepEqual(registry, shipped);
  }

  // One number moves at BenchLM: exactly that number moves in the registry.
  const model = shipped.models.find((entry) => typeof entry.scores.coding === 'number');
  const next = clone(rows);
  next.find((row) => row.slug === model.id.replaceAll('.', '-')).boards.coding = round2(model.scores.coding + 1.25);
  site.use(next, { version: DATA_V2, date: 'December 24, 2099', etag: '"m2"' });
  clock.now += 10 * MINUTE;
  const moved = await benchlm.refresh(registry);
  assert.deepEqual(moved.updated, [{ id: model.id, key: 'coding', from: model.scores.coding, to: round2(model.scores.coding + 1.25) }]);
  assert.equal(moved.dataDate, '2099-12-24');
  const file = path.join(tempDir(t), 'models.json');
  writeFileSync(file, JSON.stringify(shipped));
  const router = createRouter({ modelsPath: file, providers: { usable: () => true }, getSettings: () => ({}) });
  const saved = router.save(registry);
  assert.equal(saved.dataDate, '2099-12-24');
  assert.equal(saved.models.find((entry) => entry.id === model.id).scores.coding, round2(model.scores.coding + 1.25));
  assert.equal(saved.models.length, shipped.models.length);
  assert.deepEqual(saved.models.map((entry) => [entry.id, entry.enabled, entry.tiers]), shipped.models.map((entry) => [entry.id, entry.enabled, entry.tiers]));
});
