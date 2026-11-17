// Tests for the review items of server/secrets.js: the known key "typesafe" (A35), the redactor link and
// primeRedactor() (A32), and a private data folder (A32). File backend only, in temp folders.
// Run: node --test tests/secrets.redactor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSecrets } from '../server/secrets.js';
import { createRedactor } from '../server/redact.js';

const V1 = 'dummy-redactor-value-111111';
const V2 = 'dummy-redactor-value-222222';
const V3 = 'dummy-redactor-value-333333';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workshop-secrets-red-'));
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A redactor that records its calls. */
function fakeRedactor() {
  const calls = [];
  return { calls, add: (value) => calls.push(['add', value]), remove: (value) => calls.push(['remove', value]) };
}

function make(dataDir, options = {}) {
  const logs = [];
  const secrets = createSecrets({ backend: 'file', dataDir, log: (level, msg, data) => logs.push({ level, msg, data }), ...options });
  return { secrets, logs };
}

test('A35: typesafe is a known key with TYPESAFE_API_KEY; no provider gets it', async (t) => {
  const { secrets } = make(await tempDir(t));
  const listed = await secrets.list();
  assert.deepEqual(listed.map((key) => key.id), ['anthropic', 'gemini', 'openai', 'typesafe', 'oss']);
  assert.deepEqual(listed[3], { id: 'typesafe', label: 'TypeSafe (Jev)', envVar: 'TYPESAFE_API_KEY', set: false, hint: null, updatedAt: null });
  await secrets.set('typesafe', V1);
  assert.equal(await secrets.get('typesafe'), V1);
  for (const provider of ['typesafe', 'claude', 'gemini', 'openai', 'jev', 'decider']) {
    assert.deepEqual(await secrets.envFor(provider), {}, provider);
  }
  // Its env var is fixed, and no custom key can take it.
  await assert.rejects(secrets.set('typesafe', V1, { envVar: 'TS_KEY' }), /"typesafe" always uses TYPESAFE_API_KEY/);
  await assert.rejects(secrets.set('my-tool', V2, { envVar: 'TYPESAFE_API_KEY' }), /already used by the key "typesafe"/);
  // A removed known key stays listed.
  assert.equal(await secrets.remove('typesafe'), true);
  assert.deepEqual((await secrets.list())[3].set, false);
});

test('A32: set, set again, remove: add(v1), remove(v1), add(v2), remove(v2)', async (t) => {
  const redactor = fakeRedactor();
  const { secrets, logs } = make(await tempDir(t), { redactor });
  await secrets.set('anthropic', V1);
  assert.deepEqual(redactor.calls, [['add', V1]]);
  await secrets.set('anthropic', V2);
  assert.deepEqual(redactor.calls, [['add', V1], ['remove', V1], ['add', V2]]);
  await secrets.remove('anthropic');
  assert.deepEqual(redactor.calls, [['add', V1], ['remove', V1], ['add', V2], ['remove', V2]]);
  // The same value again changes nothing in the redactor; removing a key that is not set calls nothing.
  await secrets.set('gemini', V3);
  await secrets.set('gemini', V3);
  assert.equal(await secrets.remove('openai'), false);
  assert.deepEqual(redactor.calls.slice(4), [['add', V3]]);
  assert.equal(JSON.stringify(logs).includes('dummy-redactor-value'), false);
});

test('A32: a value that two keys hold stays redacted until neither holds it', async (t) => {
  const redactor = createRedactor();
  const { secrets } = make(await tempDir(t), { redactor });
  await secrets.set('anthropic', V1);
  await secrets.set('my-tool', V1, { envVar: 'MY_TOOL_KEY' });
  await secrets.remove('anthropic');
  assert.equal(redactor.hit(`x ${V1}`), true);
  await secrets.set('my-tool', V2);
  assert.equal(redactor.hit(V1), false);
  assert.equal(redactor.redact(`a ${V2} b`), 'a [redacted] b');
});

test('A32: primeRedactor() loads every stored value at boot and never logs one', async (t) => {
  const dataDir = await tempDir(t);
  const first = make(dataDir).secrets;
  await first.set('anthropic', V1);
  await first.set('my-tool', V2, { envVar: 'MY_TOOL_KEY' });

  const redactor = createRedactor();
  const { secrets, logs } = make(dataDir, { redactor });
  assert.equal(redactor.hit(V1) || redactor.hit(V2), false); // nothing before the call
  assert.equal(await secrets.primeRedactor(), 2);
  assert.equal(redactor.hit(V1), true);
  assert.equal(redactor.hit(V2), true);
  assert.equal(redactor.redact(`${V1} and ${V2}`), '[redacted] and [redacted]');
  assert.equal(JSON.stringify(logs).includes('dummy-redactor-value'), false);
  // A later remove takes the value out again.
  await secrets.remove('my-tool');
  assert.equal(redactor.hit(V2), false);
  // Without a redactor it does nothing.
  assert.equal(await make(dataDir).secrets.primeRedactor(), 0);
});

test('A32: a value that get() or envFor() hands out is in the redactor, also without primeRedactor()', async (t) => {
  const dataDir = await tempDir(t);
  await make(dataDir).secrets.set('anthropic', V1);
  await make(dataDir).secrets.set('typesafe', V3);
  const redactor = createRedactor();
  const { secrets } = make(dataDir, { redactor });
  // The first load reads no value while the list matches the key store.
  await secrets.list();
  assert.equal(redactor.hit(V1), false);
  assert.deepEqual(await secrets.envFor('claude'), { ANTHROPIC_API_KEY: V1 });
  assert.equal(redactor.hit(V1), true);
  assert.equal(await secrets.get('typesafe'), V3);
  assert.equal(redactor.hit(V3), true);
});

test('A32: a broken redactor does not break key handling; a redactor without add/remove is refused', async (t) => {
  const dataDir = await tempDir(t);
  const broken = { add() { throw new Error('add broke'); }, remove() { throw new Error('remove broke'); } };
  const { secrets, logs } = make(dataDir, { redactor: broken });
  assert.equal((await secrets.set('anthropic', V1)).set, true);
  assert.equal(await secrets.remove('anthropic'), true);
  assert.ok(logs.some((l) => l.level === 'warn' && /redactor\.add failed/.test(l.msg)));
  assert.equal(JSON.stringify(logs).includes('dummy-redactor-value'), false);
  for (const redactor of [{}, { add() {} }, { remove() {} }, 'redactor', 5]) {
    assert.throws(() => createSecrets({ backend: 'file', dataDir, redactor }), /redactor must have add\(\) and remove\(\)/);
  }
});

test('A32: a data folder that secrets.js creates has mode 0700; its files 0600', async (t) => {
  const root = await tempDir(t);
  const dataDir = path.join(root, 'missing', 'data');
  const { secrets } = make(dataDir);
  await secrets.set('anthropic', V1);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, 'missing'))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dataDir, 'keys.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(dataDir, 'keys-meta.json'))).mode & 0o777, 0o600);
});
