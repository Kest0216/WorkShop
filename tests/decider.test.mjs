// Decider (contract section 11b) against a loopback fake of TypeSafe's System One API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDecider, coverPick, noulBand, decisionUrl, errorMessage, DEFAULT_MODEL, QUESTIONS } from '../server/decider.js';

const KEY = 'tsk-test-key-for-the-fake-only-1234';

function fakeSecrets(initial = null) {
  let value = initial;
  return {
    set(v) { value = v; },
    async get(id) { return id === 'typesafe' ? value : null; },
    async list() { return [{ id: 'anthropic', set: false }, { id: 'typesafe', set: value != null, hint: value ? value.slice(-4) : null }]; },
  };
}

/** The documented shapes; the numbers are set per test through `plan`. */
function startFake() {
  const seen = [];
  const plan = { status: 200, size: { small: 0.8, medium: 0.15, large: 0.05 }, noul: 0.1, delayMs: 0, raw: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: raw });
      const send = (status, body) => {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_fake' });
        res.end(text);
      };
      const go = () => {
        if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { detail: { error_type: 'authentication_error', message: 'Cannot authenticate.' } });
        if (plan.raw !== null) return send(200, plan.raw);
        if (plan.status !== 200) return send(plan.status, { detail: `forced ${plan.status} for ${KEY}` });
        const body = JSON.parse(raw);
        return send(200, {
          model: body.model,
          answers: {
            size: { type: 'choice', choice: 'small', confidence: 0.6, probabilities: plan.size },
            sensitive: { type: 'noul', noul: plan.noul },
          },
          usage: { input_tokens: 1000, output_tokens: 10 },
        });
      };
      if (plan.delayMs) setTimeout(go, plan.delayMs); else go();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, seen, plan, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
    });
  });
}

const TASK = { title: 'Add login form', spec: 'Build the form.', acceptance: ['Form posts', 'Errors show'], zones: ['src/login/**'] };

describe('decider', () => {
  let fake;
  before(async () => { fake = await startFake(); });
  after(async () => { await fake.close(); });

  test('off without the typesafe key: no call, no throw', async () => {
    const before = fake.seen.length;
    const d = createDecider({ secrets: fakeSecrets(null), baseUrl: fake.baseUrl });
    assert.equal(await d.refresh(), false);
    assert.equal(d.enabled(), false);
    const r = await d.sizeTask(TASK);
    assert.deepEqual({ size: r.size, sensitive: r.sensitive, usd: r.usd }, { size: null, sensitive: null, usd: 0 });
    assert.match(r.why, /no TypeSafe key/);
    assert.equal(fake.seen.length, before);
    assert.deepEqual(d.stats(), { calls: 0, usd: 0, failures: 0 });
  });

  test('a small, not sensitive answer', async () => {
    Object.assign(fake.plan, { status: 200, size: { small: 0.8, medium: 0.15, large: 0.05 }, noul: 0.1, raw: null });
    const d = createDecider({ secrets: fakeSecrets(KEY), baseUrl: fake.baseUrl });
    await d.refresh();
    assert.equal(d.enabled(), true);
    const r = await d.sizeTask(TASK);
    assert.equal(r.size, 'S');
    assert.equal(r.sensitive, false);
    assert.ok(r.usd > 0 && r.usd < 0.001);
    const last = JSON.parse(fake.seen.at(-1).body);
    assert.equal(last.model, DEFAULT_MODEL);
    assert.deepEqual(Object.keys(last.questions), Object.keys(QUESTIONS));
    assert.equal(last.state.task.title, 'Add login form');
    assert.equal(fake.seen.at(-1).url, '/v1/systemone');
    assert.deepEqual(d.stats().calls, 1);
  });

  test('a split answer rounds the size up; sensitive is true', async () => {
    Object.assign(fake.plan, { size: { small: 0.4, medium: 0.25, large: 0.35 }, noul: 0.9 });
    const d = createDecider({ secrets: fakeSecrets(KEY), baseUrl: fake.baseUrl });
    const r = await d.sizeTask(TASK);
    assert.equal(r.size, 'L');
    assert.equal(r.sensitive, true);
    assert.match(r.why, /credentials/);
  });

  test('an unsettled sensitivity is null', async () => {
    Object.assign(fake.plan, { size: { small: 0.1, medium: 0.8, large: 0.1 }, noul: 0.5 });
    const r = await createDecider({ secrets: fakeSecrets(KEY), baseUrl: fake.baseUrl }).sizeTask(TASK);
    assert.equal(r.size, 'M');
    assert.equal(r.sensitive, null);
  });

  test('errors give no opinion, count a failure and never log the key', async () => {
    const lines = [];
    const log = (level, msg, data) => lines.push(JSON.stringify([level, msg, data]));
    for (const status of [401, 429, 500, 529, 422]) {
      fake.plan.status = status;
      const secrets = fakeSecrets(status === 401 ? `${KEY}-wrong` : KEY);
      const d = createDecider({ secrets, baseUrl: fake.baseUrl, log });
      const r = await d.sizeTask(TASK);
      assert.equal(r.size, null, `status ${status}`);
      assert.equal(r.sensitive, null);
      assert.equal(d.stats().failures, 1);
      assert.equal(r.why.includes(KEY), false);
    }
    fake.plan.status = 200;
    fake.plan.raw = 'not json';
    const d = createDecider({ secrets: fakeSecrets(KEY), baseUrl: fake.baseUrl, log });
    assert.equal((await d.sizeTask(TASK)).size, null);
    fake.plan.raw = null;
    assert.ok(lines.length >= 6);
    assert.equal(lines.some((l) => l.includes(KEY)), false, 'no log line holds the key');
  });

  test('timeout: one attempt, no retry, no throw', async () => {
    fake.plan.delayMs = 400;
    const before = fake.seen.length;
    const d = createDecider({ secrets: fakeSecrets(KEY), baseUrl: fake.baseUrl, timeoutMs: 50 });
    const t0 = Date.now();
    const r = await d.sizeTask(TASK);
    assert.ok(Date.now() - t0 < 350);
    assert.equal(r.size, null);
    assert.match(r.why, /timeout/);
    fake.plan.delayMs = 0;
    await new Promise((res) => setTimeout(res, 420)); // let the fake answer the aborted request
    assert.equal(fake.seen.length - before, 1);
  });

  test('a network error, a throwing secrets store and a bad fetch never throw', async () => {
    const d1 = createDecider({ secrets: fakeSecrets(KEY), baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
    assert.equal((await d1.sizeTask(TASK)).size, null);
    const d2 = createDecider({ secrets: { get: async () => { throw new Error('locked'); }, list: async () => { throw new Error('locked'); } } });
    assert.equal(await d2.refresh(), false);
    assert.equal((await d2.sizeTask(TASK)).size, null);
    const d3 = createDecider({ secrets: fakeSecrets(KEY), baseUrl: fake.baseUrl, fetchImpl: () => { throw new Error('boom'); } });
    assert.equal((await d3.sizeTask(TASK)).size, null);
    const d4 = createDecider({ secrets: fakeSecrets(KEY), baseUrl: 'http://example.com' });
    assert.equal((await d4.sizeTask(null)).size, null, 'http to a non-loopback host is refused');
  });

  test('secrets in the task text are not sent', async () => {
    fake.plan.size = { small: 1, medium: 0, large: 0 };
    const redactor = { redact: (t) => String(t).split('my-db-password-123').join('[redacted]') };
    const d = createDecider({ secrets: fakeSecrets(KEY), baseUrl: fake.baseUrl, redactor });
    await d.sizeTask({ ...TASK, spec: `Use my-db-password-123 and ${KEY}` });
    const body = fake.seen.at(-1).body;
    assert.equal(body.includes('my-db-password-123'), false);
  });

  test('settings can switch it off', async () => {
    const d = createDecider({ secrets: fakeSecrets(KEY), baseUrl: fake.baseUrl, getSettings: () => ({ decider: { enabled: false } }) });
    assert.equal(await d.refresh(), false);
    assert.equal(d.enabled(), false);
    assert.equal((await d.sizeTask(TASK)).size, null);
  });
});

describe('decider helpers', () => {
  test('coverPick and noulBand', () => {
    assert.equal(coverPick({ small: 0.7, medium: 0.2, large: 0.1 }, ['small', 'medium', 'large']), 'small');
    assert.equal(coverPick({ small: 0.5, medium: 0.3, large: 0.2 }, ['small', 'medium', 'large']), 'medium');
    assert.equal(coverPick({ small: 'x' }, ['small']), null);
    assert.equal(coverPick(null, ['small']), null);
    assert.equal(noulBand(0.9), 'yes');
    assert.equal(noulBand(0.1), 'no');
    assert.equal(noulBand(0.5), 'unsettled');
    assert.equal(noulBand(NaN), 'unsettled');
  });
  test('decisionUrl and errorMessage', () => {
    assert.equal(decisionUrl('https://api.typesafe.ai').href, 'https://api.typesafe.ai/v1/systemone');
    assert.throws(() => decisionUrl('http://api.typesafe.ai'), /https/);
    assert.throws(() => decisionUrl('https://u:p@api.typesafe.ai'));
    assert.equal(errorMessage('{"detail":{"error_type":"authentication_error","message":"bad"}}'), 'authentication_error: bad');
    assert.equal(errorMessage('{"detail":[{"loc":["body","model"],"msg":"Field required"}]}'), 'body.model: Field required');
    assert.equal(errorMessage('nope'), null);
  });

  test('selectSpecialist uses deterministic fallback when unkeyed and flags missing specialty for Phase 1 RFT', async () => {
    const fakeRoster = {
      match({ domain }) {
        if (domain === 'backend') {
          return { entry: { id: 'spec-sprocket', name: 'Sprocket', baseModel: 'qwen3-coder-32b', harnessId: 'fullstack-node', certification: 'curated', specialties: ['backend'] }, certified: true, exactDomain: true, needsRft: false, reason: null };
        }
        return { entry: { id: 'spec-sprocket', name: 'Sprocket', baseModel: 'qwen3-coder-32b', harnessId: 'fullstack-node', certification: 'curated', specialties: ['backend'] }, certified: false, exactDomain: false, needsRft: true, reason: 'missing_specialty' };
      },
      list() { return []; },
    };
    const fakeHarnesses = {
      forDomain(domain) { return { id: domain === 'algo' ? 'data-algo-lab' : 'fullstack-node' }; },
      list() { return [{ id: 'fullstack-node' }, { id: 'data-algo-lab' }]; },
    };
    const d = createDecider({ secrets: fakeSecrets(null) });
    const okPick = await d.selectSpecialist({ task: { id: 'T1', title: 'API route', domain: 'backend' }, roster: fakeRoster, harnesses: fakeHarnesses });
    assert.equal(okPick.rosterId, 'spec-sprocket');
    assert.equal(okPick.needsRft, false);
    assert.equal(okPick.harnessId, 'fullstack-node');

    const gapPick = await d.selectSpecialist({ task: { id: 'T2', title: 'Graph DP solver', domain: 'algo' }, roster: fakeRoster, harnesses: fakeHarnesses });
    assert.equal(gapPick.needsRft, true);
    assert.equal(gapPick.harnessId, 'data-algo-lab');
    assert.equal(gapPick.reason, 'missing_specialty');
  });
});
