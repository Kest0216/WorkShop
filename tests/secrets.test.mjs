// Tests for server/secrets.js. Run: node --test tests/secrets.test.mjs
//
// - File backend: everything, in temp folders.
// - Keychain backend logic: against a fake `security` tool (a small script in a temp folder).
// - Keychain backend for real: ONE self-test on service "WorkShop-selftest" with dummy values.
//   It is skipped when WORKSHOP_SKIP_KEYCHAIN is set or when this is not macOS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createSecrets } from '../server/secrets.js';

const DUMMY = 'dummy-not-a-real-key-123456';
const DUMMY2 = 'dummy-not-a-real-key-654321';
const KNOWN_UNSET = [
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', set: false, hint: null, updatedAt: null },
  { id: 'gemini', label: 'Google Gemini', envVar: 'GEMINI_API_KEY', set: false, hint: null, updatedAt: null },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', set: false, hint: null, updatedAt: null },
  { id: 'typesafe', label: 'TypeSafe (Jev)', envVar: 'TYPESAFE_API_KEY', set: false, hint: null, updatedAt: null }, // contract 14 (A35)
  { id: 'oss', label: 'Open-Source Runtime Bearer Token (optional)', envVar: 'OSS_API_KEY', set: false, hint: null, updatedAt: null },
];

const char = (...codes) => String.fromCodePoint(...codes);
const hex = (text) => Buffer.from(text).toString('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const modeOf = async (file) => (await stat(file)).mode & 0o777;
const brief = (entries) => entries.map((key) => [key.id, key.set, key.hint]);
const core = (key) => [key.id, key.label, key.envVar, key.set, key.hint];
/** What brief(list) should be: the known keys with the given hints (not set when left out), then custom rows. */
const rows = (hints = {}, ...custom) => [
  ...['anthropic', 'gemini', 'openai', 'typesafe', 'oss'].map((id) => [id, id in hints, hints[id] ?? null]),
  ...custom,
];

/** A temp folder that is removed when the test ends. */
async function tempDir(t, prefix = 'workshop-secrets-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A secrets module on a temp folder, with a logger that records every call. */
function make(dataDir, options = {}) {
  const logs = [];
  const secrets = createSecrets({
    backend: 'file', dataDir, log: (level, msg, data) => logs.push({ level, msg, data }), ...options,
  });
  return { secrets, logs, keysFile: path.join(dataDir, 'keys.json'), metaFile: path.join(dataDir, 'keys-meta.json') };
}

/** Asserts a rejection with a plain message and a status, which never echoes a secret. */
async function refused(promise, pattern, { status = 400, secrets = [DUMMY, DUMMY2] } = {}) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, pattern);
    assert.equal(err.status, status);
    for (const secret of secrets) {
      assert.ok(!err.message.includes(secret), 'the error must not echo the value');
      assert.ok(!err.message.includes(hex(secret)), 'the error must not echo the value as hex');
    }
    return true;
  });
}

function assertNoSecretIn(text, secrets = [DUMMY, DUMMY2]) {
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), 'a value leaked');
    assert.ok(!text.includes(hex(secret)), 'a value leaked as hex');
    assert.ok(!text.includes(Buffer.from(secret).toString('base64')), 'a value leaked as base64');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Module rules
// ---------------------------------------------------------------------------------------------------------

test('module: exports one factory and never calls console', async () => {
  const mod = await import('../server/secrets.js');
  assert.deepEqual(Object.keys(mod), ['createSecrets']);
  const source = await readFile(fileURLToPath(new URL('../server/secrets.js', import.meta.url)), 'utf8');
  assert.ok(!source.includes('console.'));
});

test('createSecrets: refuses bad options and has no side effects', async (t) => {
  const dataDir = await tempDir(t);
  assert.throws(() => createSecrets(), /dataDir is required/);
  assert.throws(() => createSecrets({ backend: 'file' }), /dataDir is required/);
  assert.throws(() => createSecrets({ backend: 'memory', dataDir }), /backend must be 'keychain' or 'file'/);
  // the backend has no default: leaving it out must never reach the real Keychain
  assert.throws(() => createSecrets({ dataDir }), /backend must be 'keychain' or 'file'/);
  for (const service of ['Work Shop', '-lead', '', 'a"b', 'x'.repeat(33), 42]) {
    assert.throws(() => createSecrets({ backend: 'keychain', dataDir, service }), /service must be/);
  }
  for (const timeoutMs of [0, -1, 1.5, '10', null, Infinity]) {
    assert.throws(() => createSecrets({ backend: 'keychain', dataDir, timeoutMs }), /timeoutMs must be/);
  }
  createSecrets({ backend: 'file', dataDir });
  createSecrets({ backend: 'keychain', dataDir, service: 'WorkShop-selftest', timeoutMs: 5000 });
  assert.deepEqual(await readdir(dataDir), []);
});

test('backendInfo: says where keys are stored', async (t) => {
  const dataDir = await tempDir(t);
  const file = createSecrets({ backend: 'file', dataDir }).backendInfo();
  assert.equal(file.backend, 'file');
  assert.ok(file.detail.includes(path.join(dataDir, 'keys.json')));
  const keychain = createSecrets({ backend: 'keychain', dataDir }).backendInfo();
  assert.equal(keychain.backend, 'keychain');
  assert.match(keychain.detail, /macOS Keychain/);
  assert.match(keychain.detail, /"WorkShop"/); // the default service name
  assert.match(createSecrets({ backend: 'keychain', dataDir, service: 'Other.app_1' }).backendInfo().detail, /"Other\.app_1"/);
});

// ---------------------------------------------------------------------------------------------------------
// File backend
// ---------------------------------------------------------------------------------------------------------

test('file: the three known keys are always listed, and listing writes nothing', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets } = make(dataDir);
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.equal(await secrets.get('anthropic'), null);
  assert.deepEqual(await secrets.envFor('claude'), {});
  assert.deepEqual(await readdir(dataDir), []);

  // a data folder that does not exist yet is fine, and is created on the first save
  const { secrets: late, keysFile } = make(path.join(dataDir, 'not', 'yet'));
  assert.deepEqual(await late.list(), KNOWN_UNSET);
  await late.set('gemini', DUMMY);
  assert.deepEqual(await readJson(keysFile), { gemini: DUMMY });
});

test('file: set keeps the value in keys.json (0600) and only metadata in keys-meta.json', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, logs, keysFile, metaFile } = make(dataDir);
  const before = Date.now();
  const entry = await secrets.set('anthropic', DUMMY);
  const after = Date.now();

  assert.deepEqual({ ...entry, updatedAt: null }, { ...KNOWN_UNSET[0], set: true, hint: '3456' });
  assert.ok(Number.isInteger(entry.updatedAt) && entry.updatedAt >= before && entry.updatedAt <= after);
  assert.equal(await secrets.get('anthropic'), DUMMY);
  assert.deepEqual(await secrets.list(), [entry, KNOWN_UNSET[1], KNOWN_UNSET[2], KNOWN_UNSET[3], KNOWN_UNSET[4]]);

  assert.equal(await modeOf(keysFile), 0o600);
  assert.equal(await modeOf(metaFile), 0o600);
  assert.deepEqual(await readJson(keysFile), { anthropic: DUMMY });
  const metaText = await readFile(metaFile, 'utf8');
  assertNoSecretIn(metaText);
  assert.deepEqual(JSON.parse(metaText), {
    anthropic: { label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', hint: '3456', updatedAt: entry.updatedAt },
  });
  assertNoSecretIn(JSON.stringify(logs));

  // an update replaces the value and moves updatedAt forward
  const updated = await secrets.set('anthropic', DUMMY2);
  assert.equal(updated.hint, '4321');
  assert.ok(updated.updatedAt >= entry.updatedAt);
  assert.equal(await secrets.get('anthropic'), DUMMY2);
  assert.deepEqual(await readJson(keysFile), { anthropic: DUMMY2 });
});

test('file: the hint is the last 4 characters, or "set" for values shorter than 12', async (t) => {
  const { secrets } = make(await tempDir(t));
  assert.equal((await secrets.set('openai', 'abcdefghijk')).hint, 'set'); // 11 characters
  assert.equal((await secrets.set('openai', 'abcdefghijkl')).hint, 'ijkl'); // 12 characters
  assert.equal((await secrets.set('openai', 'x')).hint, 'set');
  assert.equal((await secrets.set('openai', `dummy-key-with-${char(0x1f511, 0x1f511)}`)).hint, `h-${char(0x1f511, 0x1f511)}`);
});

test('file: whitespace and quotes pasted around a value are removed', async (t) => {
  const { secrets } = make(await tempDir(t));
  const pasted = [
    `  ${DUMMY}  `,
    `${DUMMY}\n`,
    `\r\n\t ${DUMMY} \r\n`,
    `"${DUMMY}"`,
    `'${DUMMY}'`,
    `\`${DUMMY}\``,
    char(0x201c) + DUMMY + char(0x201d), // curly double quotes
    char(0x2018) + DUMMY + char(0x2019), // curly single quotes
    ` "  ${DUMMY} " \n`,
    `"'${DUMMY}'"`,
    char(0xfeff) + DUMMY + char(0xa0), // byte order mark, no-break space
  ];
  for (const raw of pasted) {
    await secrets.set('anthropic', DUMMY2);
    assert.equal((await secrets.set('anthropic', raw)).hint, '3456');
    assert.equal(await secrets.get('anthropic'), DUMMY, JSON.stringify(raw));
  }
  // quotes inside a value, or on one side only, belong to the value
  for (const kept of ['dummy-"quoted"-inside-0001', '"dummy-one-sided-quote-0002', "dummy-it's-fine-0003'", 'dummy with spaces 0004']) {
    await secrets.set('anthropic', kept);
    assert.equal(await secrets.get('anthropic'), kept);
  }
});

test('file: bad values are refused, and the error never echoes the value', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, logs } = make(dataDir);
  const part = 'dummy-secret-part';
  const bad = [
    ['', /key is empty/],
    ['   \n\t ', /key is empty/],
    ['""', /key is empty/],
    ["' '", /key is empty/],
    [`${part}\n${part}`, /line break/],
    [`${part}\r\n${part}`, /line break/],
    [`${part}\t${part}`, /control/],
    [part + char(0) + part, /control/],
    [`${part}${char(0x1b)}[0m${part}`, /control/],
    [part + char(0x7f) + part, /control/],
    [part + char(0x85) + part, /control/],
    [part + char(0x2028) + part, /line break/],
    [part + char(0x2029) + part, /line break/],
    [part + char(0x200b) + part, /invisible/],
    [part + String.fromCharCode(0xd800), /control/], // half of a surrogate pair
    [part + 'x'.repeat(4097), /too long \(max 4096 characters\)/],
    [12345678, /must be text/],
    [null, /must be text/],
    [undefined, /must be text/],
    [{ value: DUMMY }, /must be text/],
    [[DUMMY], /must be text/],
  ];
  for (const [value, pattern] of bad) {
    await refused(secrets.set('anthropic', value), pattern, { secrets: [part, DUMMY] });
  }
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.deepEqual(await readdir(dataDir), []);
  assertNoSecretIn(JSON.stringify(logs), [part]);

  // the limit is 4096 characters after clean-up
  const longest = 'k'.repeat(4096);
  await secrets.set('anthropic', ` "${longest}"\n`);
  assert.equal(await secrets.get('anthropic'), longest);
  await refused(secrets.set('anthropic', `${longest}k`), /too long/, { secrets: [longest] });
  assert.equal(await secrets.get('anthropic'), longest);
});

test('file: key ids are lowercase letters, digits and dashes', async (t) => {
  const { secrets } = make(await tempDir(t));
  const badIds = ['Anthropic', 'my_key', 'my key', '', '-lead', 'a'.repeat(41), 'a.b', '../keys', 'a/b',
    char(0x43a, 0x43b, 0x44e, 0x447), DUMMY.toUpperCase(), null, undefined, 42, {}, ['a']];
  for (const id of badIds) {
    await refused(secrets.set(id, DUMMY, { envVar: 'SOME_KEY' }), /key id must be/, { secrets: [DUMMY, DUMMY.toUpperCase()] });
    await refused(secrets.remove(id), /key id must be/, { secrets: [DUMMY, DUMMY.toUpperCase()] });
    assert.equal(await secrets.get(id), null);
  }
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);

  const goodIds = ['a', '9lives', 'my-key-2', 'trailing-', 'a'.repeat(40), 'constructor', 'tostring'];
  for (const [index, id] of goodIds.entries()) {
    await secrets.set(id, `${DUMMY}-${index}`, { envVar: `GOOD_KEY_${index}` });
    assert.equal(await secrets.get(id), `${DUMMY}-${index}`);
  }
  assert.deepEqual((await secrets.list()).slice(5).map((key) => key.id), [...goodIds].sort());
});

test('file: custom keys need a valid, unused env var; labels and env vars can change', async (t) => {
  const { secrets } = make(await tempDir(t));
  // An env var that is left out (or sent empty by a form) gets the usual name for the id. The UI saves a row
  // with { value } only. ("typesafe" is a known key now, A35: it has its own test.)
  const usual = [['jev-tool', undefined, 'JEV_TOOL_API_KEY'], ['my-2nd-tool', { envVar: '', label: '' }, 'MY_2ND_TOOL_API_KEY']];
  for (const [id, options, envVar] of usual) {
    assert.deepEqual(core(await secrets.set(id, DUMMY, options)), [id, id, envVar, true, '3456']);
    await refused(secrets.set('other', DUMMY, { envVar }), /already used by the key/);
    assert.equal(await secrets.remove(id), true);
  }
  for (const id of ['9-lives', 'workshop-key', 'dyld-key']) { // ids that give no valid name need one
    await refused(secrets.set(id, DUMMY), /custom key needs an environment variable/);
  }
  for (const envVar of ['my_key', 'My_Key', '1KEY', '_KEY', 'MY-KEY', 'MY KEY', ' ', 'K'.repeat(65), 42, {}, DUMMY]) {
    await refused(secrets.set('my-tool', DUMMY, { envVar }), /environment variable must look like MY_API_KEY/);
  }
  const system = ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'LC_ALL', 'WORKSHOP_SKIP_KEYCHAIN'];
  for (const envVar of system) {
    await refused(secrets.set('my-tool', DUMMY, { envVar }), /must not be a system variable/);
  }
  for (const [index, envVar] of ['HOMEBREW_GITHUB_API_TOKEN', 'LD_SDK_KEY', 'PATHFINDER_KEY', 'K', 'K'.repeat(64), 'A1_B2'].entries()) {
    assert.equal((await secrets.set(`ok-${index}`, DUMMY, { envVar })).envVar, envVar); // only exact system names are refused
    assert.equal(await secrets.remove(`ok-${index}`), true);
  }
  await refused(secrets.set('my-tool', DUMMY, { envVar: 'ANTHROPIC_API_KEY' }), /already used by the key "anthropic"/);
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.equal(await secrets.get('my-tool'), null);

  const entry = await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' });
  assert.deepEqual(core(entry), ['my-tool', 'my-tool', 'MY_TOOL_KEY', true, '3456']);
  await refused(secrets.set('other', DUMMY, { envVar: 'MY_TOOL_KEY' }), /already used by the key "my-tool"/);

  // an update keeps what it does not change
  assert.deepEqual(brief([await secrets.set('my-tool', DUMMY2)]), [['my-tool', true, '4321']]);
  assert.equal((await secrets.set('my-tool', DUMMY2, { label: '  My tool  ' })).label, 'My tool');
  const moved = await secrets.set('my-tool', DUMMY2, { envVar: 'MY_TOOL_TOKEN', label: '' });
  assert.deepEqual([moved.label, moved.envVar], ['My tool', 'MY_TOOL_TOKEN']);
  assert.equal((await secrets.set('my-tool', DUMMY2, { envVar: 'MY_TOOL_TOKEN', label: null })).envVar, 'MY_TOOL_TOKEN');
  assert.equal((await secrets.set('freed', DUMMY, { envVar: 'MY_TOOL_KEY' })).envVar, 'MY_TOOL_KEY'); // free again

  // labels: one line, at most 60 characters
  await refused(secrets.set('my-tool', DUMMY, { label: 'x'.repeat(61) }), /label must be one line of at most 60/);
  await refused(secrets.set('my-tool', DUMMY, { label: 'two\nlines' }), /label must be one line/);
  await refused(secrets.set('my-tool', DUMMY, { label: 42 }), /label must be text/);
  assert.equal(await secrets.get('my-tool'), DUMMY2); // a refused update changes nothing

  // known keys: the env var is fixed, the label is free
  await refused(secrets.set('openai', DUMMY, { envVar: 'OPENAI_KEY' }), /"openai" always uses OPENAI_API_KEY/);
  assert.equal((await secrets.set('openai', DUMMY, { envVar: 'OPENAI_API_KEY', label: 'OpenAI (work)' })).label, 'OpenAI (work)');

  // known keys first, then custom keys by id
  await secrets.set('alpha', DUMMY, { envVar: 'ALPHA_KEY', label: 'Alpha' });
  assert.deepEqual((await secrets.list()).map((key) => [key.id, key.label, key.envVar, key.set]), [
    ['anthropic', 'Anthropic', 'ANTHROPIC_API_KEY', false],
    ['gemini', 'Google Gemini', 'GEMINI_API_KEY', false],
    ['openai', 'OpenAI (work)', 'OPENAI_API_KEY', true],
    ['typesafe', 'TypeSafe (Jev)', 'TYPESAFE_API_KEY', false],
    ['oss', 'Open-Source Runtime Bearer Token (optional)', 'OSS_API_KEY', false],
    ['alpha', 'Alpha', 'ALPHA_KEY', true],
    ['freed', 'freed', 'MY_TOOL_KEY', true],
    ['my-tool', 'My tool', 'MY_TOOL_TOKEN', true],
  ]);
});

test('file: at most 50 custom keys', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, keysFile, metaFile } = make(dataDir);
  const ids = Array.from({ length: 50 }, (_, i) => `key-${String(i).padStart(2, '0')}`);
  await writeFile(keysFile, JSON.stringify(Object.fromEntries(ids.map((id) => [id, DUMMY]))), { mode: 0o600 });
  const metaOf = (id, i) => [id, { label: id, envVar: `KEY_${i}`, hint: '3456', updatedAt: 1 }];
  await writeFile(metaFile, JSON.stringify(Object.fromEntries(ids.map(metaOf))));
  assert.equal((await secrets.list()).length, 55);
  await refused(secrets.set('one-more', DUMMY, { envVar: 'ONE_MORE' }), /too many custom keys \(max 50\)/);
  await secrets.set('key-07', DUMMY2); // an update is fine
  await secrets.set('gemini', DUMMY); // known keys do not count
  assert.equal(await secrets.remove('key-49'), true);
  await secrets.set('one-more', DUMMY, { envVar: 'ONE_MORE' });
  assert.equal((await secrets.list()).length, 55);
});

test('file: envFor maps a provider to its key', async (t) => {
  const { secrets } = make(await tempDir(t));
  for (const provider of ['claude', 'gemini', 'openai']) assert.deepEqual(await secrets.envFor(provider), {});
  await secrets.set('anthropic', 'dummy-anthropic-key-0001');
  await secrets.set('gemini', 'dummy-gemini-key-0002');
  await secrets.set('openai', 'dummy-openai-key-0003');
  await secrets.set('claude', 'dummy-custom-key-0004', { envVar: 'CLAUDE_CUSTOM' }); // must not shadow the provider
  await secrets.set('mock', 'dummy-custom-key-0005', { envVar: 'MOCK_KEY' });

  assert.deepEqual(await secrets.envFor('claude'), { ANTHROPIC_API_KEY: 'dummy-anthropic-key-0001' });
  assert.deepEqual(await secrets.envFor('gemini'), { GEMINI_API_KEY: 'dummy-gemini-key-0002' });
  assert.deepEqual(await secrets.envFor('openai'), { OPENAI_API_KEY: 'dummy-openai-key-0003' });
  for (const other of ['mock', 'anthropic', 'Claude', 'constructor', '__proto__', 'toString', '', null, undefined, 42]) {
    assert.deepEqual(await secrets.envFor(other), {}, String(other));
  }
  await secrets.remove('anthropic');
  assert.deepEqual(await secrets.envFor('claude'), {});
  assert.deepEqual(await secrets.envFor('gemini'), { GEMINI_API_KEY: 'dummy-gemini-key-0002' });
});

test('file: remove deletes the value; a known key stays listed, a custom key goes away', async (t) => {
  const { secrets, keysFile, metaFile } = make(await tempDir(t));
  assert.equal(await secrets.remove('anthropic'), false); // nothing to delete
  assert.equal(await secrets.remove('never-set'), false);
  await secrets.set('anthropic', DUMMY, { label: 'Anthropic (work)' });
  await secrets.set('my-tool', DUMMY2, { envVar: 'MY_TOOL_KEY' });

  assert.equal(await secrets.remove('anthropic'), true);
  assert.equal(await secrets.get('anthropic'), null);
  assert.deepEqual((await secrets.list()).slice(0, 5), KNOWN_UNSET); // the changed label is gone too
  assert.deepEqual(brief(await secrets.list()), rows({}, ['my-tool', true, '4321']));
  assert.deepEqual(await readJson(keysFile), { 'my-tool': DUMMY2 });
  assertNoSecretIn(await readFile(keysFile, 'utf8'), [DUMMY]);

  assert.equal(await secrets.remove('my-tool'), true);
  assert.equal(await secrets.remove('my-tool'), false);
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.deepEqual(await readJson(keysFile), {});
  assert.deepEqual(await readJson(metaFile), {});
  assert.equal((await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' })).set, true); // the id and env var are free again
});

test('file: a keys.json that group or others can read is refused', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, keysFile } = make(dataDir);
  await secrets.set('anthropic', DUMMY);

  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o620]) {
    await chmod(keysFile, mode);
    await refused(secrets.get('anthropic'), /keys\.json is open to other users \(mode \d{3}\)\. Run: chmod 600/, { status: 500 });
    await refused(secrets.envFor('claude'), /chmod 600/, { status: 500 });
    await refused(secrets.set('gemini', DUMMY2), /chmod 600/, { status: 500 });
    await refused(secrets.set('anthropic', DUMMY2), /chmod 600/, { status: 500 });
    await refused(secrets.remove('anthropic'), /chmod 600/, { status: 500 });
    assert.equal(await modeOf(keysFile), mode); // not "repaired" behind the owner's back
    assert.deepEqual(await readJson(keysFile), { anthropic: DUMMY });
  }
  assert.deepEqual(brief(await secrets.list()), rows({ anthropic: '3456' }));

  // a new instance still lists the metadata, says why it could not check, and refuses to read
  const fresh = make(dataDir);
  assert.deepEqual(brief(await fresh.secrets.list()), rows({ anthropic: '3456' }));
  assert.ok(fresh.logs.some((entry) => entry.level === 'warn' && /could not check the key store/.test(entry.msg)));
  await refused(fresh.secrets.get('anthropic'), /chmod 600/, { status: 500 });

  for (const mode of [0o600, 0o400]) {
    await chmod(keysFile, mode);
    assert.equal(await secrets.get('anthropic'), DUMMY);
  }
  await secrets.set('gemini', DUMMY2);
  assert.equal(await modeOf(keysFile), 0o600);
});

test('file: writes are atomic and run one at a time', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, keysFile, metaFile } = make(dataDir);
  const ids = Array.from({ length: 25 }, (_, i) => `key-${String(i).padStart(2, '0')}`);

  // read both files in a loop while 25 saves run: a reader must never see a half-written file
  let reading = true;
  const torn = [];
  const reader = (async () => {
    while (reading) {
      for (const file of [keysFile, metaFile]) {
        const text = await readFile(file, 'utf8').catch(() => null);
        if (text === null) continue;
        try { JSON.parse(text); } catch { torn.push(path.basename(file)); }
      }
      await nextTick();
    }
  })();
  const results = await Promise.allSettled([ // allSettled: nothing may still run when the test ends
    secrets.list(),
    ...ids.map((id, i) => secrets.set(id, `dummy-value-${i}-0123456789`, { envVar: `KEY_${i}` })),
    secrets.set('anthropic', DUMMY),
    secrets.set('anthropic', DUMMY2), // the later call wins
  ]);
  reading = false;
  await reader;

  assert.deepEqual(results.filter((result) => result.status === 'rejected').map((result) => result.reason.message), []);
  assert.equal(results.length, 28);
  assert.deepEqual(torn, []);
  const keys = await readJson(keysFile);
  assert.deepEqual(Object.keys(keys).sort(), ['anthropic', ...ids]);
  assert.equal(keys.anthropic, DUMMY2);
  assert.equal(keys['key-07'], 'dummy-value-7-0123456789');
  assert.deepEqual(Object.keys(await readJson(metaFile)).sort(), ['anthropic', ...ids]);
  assert.equal((await secrets.list()).find((key) => key.id === 'anthropic').hint, '4321');
  assert.deepEqual((await readdir(dataDir)).sort(), ['keys-meta.json', 'keys.json']); // no temp file is left
});

test('file: a failed write keeps the old files and leaves no temp file', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, keysFile } = make(dataDir);
  await secrets.set('anthropic', DUMMY);
  await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' });

  await chmod(dataDir, 0o500); // nothing can be created in the folder
  await assert.rejects(secrets.set('anthropic', DUMMY2), (err) => !err.message.includes(DUMMY2));
  await assert.rejects(secrets.set('gemini', DUMMY2), (err) => !err.message.includes(DUMMY2));
  await assert.rejects(secrets.remove('my-tool'));
  await chmod(dataDir, 0o700);

  assert.deepEqual(await readJson(keysFile), { anthropic: DUMMY, 'my-tool': DUMMY });
  assert.equal(await secrets.get('anthropic'), DUMMY);
  assert.deepEqual(brief(await secrets.list()), rows({ anthropic: '3456' }, ['my-tool', true, '3456']));
  assert.deepEqual((await readdir(dataDir)).sort(), ['keys-meta.json', 'keys.json']);
  await secrets.set('anthropic', DUMMY2); // and it works again afterwards
  assert.equal(await secrets.get('anthropic'), DUMMY2);
});

test('file: temp files left by a crash are removed on first load', async (t) => {
  const dataDir = await tempDir(t);
  for (const name of ['keys.json.123.deadbeef.tmp', 'keys-meta.json.99.0badcafe.tmp', 'notes.tmp', 'keys.json.tmp']) {
    await writeFile(path.join(dataDir, name), DUMMY);
  }
  const { secrets } = make(dataDir);
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.deepEqual((await readdir(dataDir)).sort(), ['keys.json.tmp', 'notes.tmp']); // only its own temp files
});

test('file: a corrupt keys-meta.json is kept as .bak; known keys are rebuilt from the key store', async (t) => {
  const dataDir = await tempDir(t);
  const first = make(dataDir);
  await first.secrets.set('anthropic', DUMMY);
  await first.secrets.set('my-tool', DUMMY2, { envVar: 'MY_TOOL_KEY' });
  await writeFile(first.metaFile, '{ "anthropic": { "label": "Anthr');

  const { secrets, logs, metaFile } = make(dataDir);
  assert.deepEqual(brief(await secrets.list()), rows({ anthropic: '3456' }));
  assert.equal(await readFile(`${metaFile}.bak`, 'utf8'), '{ "anthropic": { "label": "Anthr');
  assert.deepEqual(Object.keys(await readJson(metaFile)), ['anthropic']);
  const warning = logs.find((entry) => entry.level === 'warn' && /keys-meta\.json was corrupt/.test(entry.msg));
  assert.deepEqual(warning.data, { copy: 'keys-meta.json.bak' });
  // the custom key lost its metadata, so it is not listed; its value is still there and can be removed
  assert.equal(await secrets.get('my-tool'), DUMMY2);
  assert.equal(await secrets.remove('my-tool'), true);
  assert.equal(await secrets.get('my-tool'), null);

  // other shapes that are not a JSON object count as corrupt too
  for (const text of ['', '[1, 2, 3]', 'null', '"text"', '42']) {
    await writeFile(metaFile, text);
    assert.deepEqual(brief(await make(dataDir).secrets.list()), rows({ anthropic: '3456' }));
    assert.equal(await readFile(`${metaFile}.bak`, 'utf8'), text);
  }
});

test('file: a corrupt keys.json is kept as .bak (still 0600) and the module starts clean', async (t) => {
  const dataDir = await tempDir(t);
  const first = make(dataDir);
  await first.secrets.set('anthropic', DUMMY);
  const corrupt = `{"anthropic": "${DUMMY.slice(0, 9)}`;
  await writeFile(first.keysFile, corrupt);

  const { secrets, logs, keysFile } = make(dataDir);
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.equal(await secrets.get('anthropic'), null);
  assert.equal(await readFile(`${keysFile}.bak`, 'utf8'), corrupt);
  assert.equal(await modeOf(`${keysFile}.bak`), 0o600);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /keys\.json was corrupt/.test(entry.msg)));
  assertNoSecretIn(JSON.stringify(logs), [DUMMY, DUMMY.slice(0, 9)]);

  await secrets.set('anthropic', DUMMY2);
  assert.deepEqual(await readJson(keysFile), { anthropic: DUMMY2 });
  assert.equal(await modeOf(keysFile), 0o600);

  // when no copy can be made (read-only folder), the module still starts clean and says so
  await writeFile(keysFile, 'not json');
  await chmod(dataDir, 0o500);
  const stuck = make(dataDir);
  assert.equal(await stuck.secrets.get('anthropic'), null);
  assert.deepEqual(stuck.logs.find((entry) => /keys\.json was corrupt/.test(entry.msg)).data, { copy: null });
  await chmod(dataDir, 0o700);
  assert.equal(await readFile(`${keysFile}.bak`, 'utf8'), corrupt); // the older copy is untouched
});

test('file: broken entries in the data files are dropped, good ones are kept', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, logs, keysFile, metaFile } = make(dataDir);
  await writeFile(keysFile, JSON.stringify({
    anthropic: DUMMY, 'custom-ok': DUMMY2, 'no-meta': DUMMY, 'Bad Id': DUMMY, 'not-text': 42, empty: '',
  }), { mode: 0o600 });
  await writeFile(metaFile, JSON.stringify({
    anthropic: 'oops',
    gemini: { label: 'G', envVar: 'WRONG_NAME', hint: 'gggg', updatedAt: 7 },
    'Bad Id': { label: 'Bad', envVar: 'BAD_ID', hint: 'xxxx', updatedAt: 1 },
    'custom-ok': { label: 'Custom', envVar: 'CUSTOM_OK', hint: '4321', updatedAt: 5 },
    'custom-bad-env': { label: 'X', envVar: 'lower', hint: 'xxxx', updatedAt: 1 },
    'custom-dup-env': { label: 'X', envVar: 'CUSTOM_OK', hint: 'xxxx', updatedAt: 1 },
    'custom-known-env': { label: 'X', envVar: 'OPENAI_API_KEY', hint: 'xxxx', updatedAt: 1 },
    'custom-odd': { label: 42, envVar: 'CUSTOM_ODD', hint: null, updatedAt: 'yesterday' },
    'not-text': null,
  }));

  const listed = await secrets.list();
  assert.deepEqual(brief(listed), [
    ['anthropic', true, '3456'], // rebuilt from the key store
    ['gemini', false, null], // the env var of a known key cannot be changed in the file
    ['openai', false, null],
    ['typesafe', false, null],
    ['oss', false, null],
    ['custom-odd', false, null], // usable entry, odd fields replaced
    ['custom-ok', true, '4321'],
  ]);
  assert.deepEqual(listed[1], { ...KNOWN_UNSET[1], label: 'G' });
  assert.deepEqual(listed[5], { id: 'custom-odd', label: 'custom-odd', envVar: 'CUSTOM_ODD', set: false, hint: null, updatedAt: null });
  assert.deepEqual(listed[6], { id: 'custom-ok', label: 'Custom', envVar: 'CUSTOM_OK', set: true, hint: '4321', updatedAt: 5 });
  assert.equal(logs.filter((entry) => entry.level === 'warn' && /dropped a broken entry/.test(entry.msg)).length, 6);
  assert.equal(await secrets.get('custom-ok'), DUMMY2);
  assert.equal(await secrets.get('not-text'), null);
  assert.equal(await secrets.get('empty'), null);
  assert.deepEqual(Object.keys(await readJson(metaFile)).sort(), ['anthropic', 'custom-odd', 'custom-ok', 'gemini']);
});

test('file: the first load makes "set" match the key store; later lists read no values', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, keysFile, metaFile } = make(dataDir);
  await writeFile(keysFile, JSON.stringify({ gemini: 'dummy-gemini-key-98765', openai: 'short' }), { mode: 0o600 });
  await writeFile(metaFile, JSON.stringify({
    anthropic: { label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', hint: 'zzzz', updatedAt: 1 },
    'old-key': { label: 'Old', envVar: 'OLD_KEY', hint: 'yyyy', updatedAt: 2 },
  }));

  const before = Date.now();
  const listed = await secrets.list();
  const expected = rows({ gemini: '8765', openai: 'set' }, ['old-key', false, null]);
  assert.deepEqual(brief(listed), expected);
  assert.ok(listed[1].updatedAt >= before);
  // a custom key whose value is gone stays listed as "not set", with its label and env var
  assert.deepEqual(listed[5], { id: 'old-key', label: 'Old', envVar: 'OLD_KEY', set: false, hint: null, updatedAt: null });
  const meta = await readJson(metaFile);
  assert.deepEqual(Object.keys(meta).sort(), ['anthropic', 'gemini', 'old-key', 'openai']);
  assert.deepEqual([meta.anthropic.hint, meta.gemini.hint, meta.openai.hint, meta['old-key'].hint], [null, '8765', 'set', null]);
  assertNoSecretIn(await readFile(metaFile, 'utf8'), ['dummy-gemini-key-98765']);

  await chmod(keysFile, 0o000); // listing again must not need the values
  assert.deepEqual(brief(await secrets.list()), expected);
  await chmod(keysFile, 0o600);

  // the remembered env var is still taken, and a new value needs no env var
  await refused(secrets.set('other', DUMMY, { envVar: 'OLD_KEY' }), /already used by the key "old-key"/);
  assert.deepEqual(core(await secrets.set('old-key', DUMMY)), ['old-key', 'Old', 'OLD_KEY', true, '3456']);
  // removing a key that is listed but not set drops its metadata
  assert.equal(await secrets.remove('old-key'), true);
  await writeFile(metaFile, JSON.stringify({ gone: { label: 'Gone', envVar: 'GONE_KEY', hint: 'abcd', updatedAt: 3 } }));
  const fresh = make(dataDir).secrets;
  assert.deepEqual(brief(await fresh.list()).at(-1), ['gone', false, null]);
  assert.equal(await fresh.remove('gone'), true);
  assert.equal(await fresh.remove('gone'), false);
  assert.deepEqual((await fresh.list()).map((key) => key.id), ['anthropic', 'gemini', 'openai', 'typesafe', 'oss']);
});

test('file: a new instance sees what an earlier one saved', async (t) => {
  const dataDir = await tempDir(t);
  const first = make(dataDir).secrets;
  const saved = [await first.set('anthropic', DUMMY), await first.set('my-tool', DUMMY2, { envVar: 'MY_TOOL_KEY', label: 'My tool' })];

  const second = make(dataDir).secrets;
  assert.deepEqual(await second.list(), [saved[0], KNOWN_UNSET[1], KNOWN_UNSET[2], KNOWN_UNSET[3], KNOWN_UNSET[4], saved[1]]);
  assert.equal(await second.get('my-tool'), DUMMY2);
  assert.deepEqual(await second.envFor('claude'), { ANTHROPIC_API_KEY: DUMMY });
  assert.equal(await second.remove('anthropic'), true);
  assert.equal(await make(dataDir).secrets.get('anthropic'), null);
});

test('file: values with non-ASCII text survive', async (t) => {
  const { secrets } = make(await tempDir(t));
  const value = `dummy-p${char(0xe4)}ssw${char(0xf6)}rd ${char(0x2713)} ${char(0x1f511)} 123456`;
  assert.equal((await secrets.set('my-tool', value, { envVar: 'MY_TOOL_KEY' })).hint, '3456');
  assert.equal(await secrets.get('my-tool'), value);
});

test('logger: gets plain levels, never a value, and may even throw', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, logs } = make(dataDir);
  await secrets.set('anthropic', DUMMY);
  await secrets.set('my-tool', DUMMY2, { envVar: 'MY_TOOL_KEY' });
  await secrets.set('anthropic', `${DUMMY}\n${DUMMY}`).catch(() => {});
  await secrets.remove('my-tool');
  assert.ok(logs.length >= 3);
  for (const entry of logs) assert.ok(['debug', 'info', 'warn', 'error'].includes(entry.level));
  assertNoSecretIn(JSON.stringify(logs));

  const noisy = createSecrets({ backend: 'file', dataDir, log: () => { throw new Error('the logger broke'); } });
  await noisy.set('gemini', DUMMY);
  assert.equal(await noisy.get('gemini'), DUMMY);
  assert.equal(await noisy.remove('gemini'), true);
  const silent = createSecrets({ backend: 'file', dataDir }); // the logger is optional
  assert.equal((await silent.set('gemini', DUMMY)).set, true);
});

// ---------------------------------------------------------------------------------------------------------
// Keychain backend against a fake `security` tool
// ---------------------------------------------------------------------------------------------------------

/**
 * Source of the fake tool. It runs as its own script, so it must not use anything from this file.
 * State lives next to the script: items.json (the "keychain"), calls.log (every call), mode.json (faults).
 */
function fakeSecurityTool(fs, path, dir) {
  const load = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
  };
  const mode = load('mode.json', {}); // { hang, exit, on, truncate }
  const items = load('items.json', {}); // "service/account" -> hex of the stored bytes
  const argv = process.argv.slice(2);
  const input = argv[0] === '-i' ? fs.readFileSync(0, 'utf8') : '';
  fs.appendFileSync(path.join(dir, 'calls.log'), `${JSON.stringify({ argv, input })}\n`);
  const saveItems = () => fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify(items));
  const option = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

  /** Splits a line like the real tool: blanks separate, quotes group, a backslash keeps the next character. */
  function split(line) {
    const words = [];
    let word = null;
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\') word = (word ?? '') + (line[++i] ?? '');
      else if (quote) {
        if (ch === quote) {
          words.push(word);
          word = quote = null;
        } else word += ch;
      } else if (/\s/.test(ch)) {
        if (word !== null) words.push(word);
        word = null;
      } else if (word === null && (ch === '"' || ch === "'")) {
        quote = ch;
        word = '';
      } else word = (word ?? '') + ch;
    }
    if (word !== null) words.push(word);
    return words;
  }

  function command([name, ...args]) {
    const action = name.split('-')[0]; // add | find | delete
    if (mode.exit && (!mode.on || mode.on === action)) {
      process.stderr.write(`security: unknown command "${args.join(' ')}"\n`); // the real tool can echo its input like this
      return mode.exit;
    }
    const key = `${option(args, '-s')}/${option(args, '-a')}`;
    if (action === 'add') {
      if (key in items && !args.includes('-U')) return 45;
      const hex = args.includes('-X') ? option(args, '-X') : Buffer.from(option(args, '-w')).toString('hex');
      items[key] = mode.truncate ? hex.slice(0, -2) : hex;
      saveItems();
      return 0;
    }
    if (!(key in items)) {
      process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');
      return 44;
    }
    if (action === 'delete') {
      delete items[key];
      saveItems();
    } else if (args.includes('-w')) {
      // like the real tool: text when every byte is printable ASCII, hex otherwise
      const bytes = Buffer.from(items[key], 'hex');
      const printable = bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
      process.stdout.write(`${printable ? bytes.toString('latin1') : items[key]}\n`);
    } else {
      process.stdout.write('keychain: "fake"\nclass: "genp"\n');
    }
    return 0;
  }

  if (mode.hang) {
    setTimeout(() => {}, 30_000); // long enough to need the kill, short enough to never stay behind
    return;
  }
  let code = 0;
  if (argv[0] === '-i') {
    for (const line of input.split('\n').filter(Boolean)) {
      if (Buffer.byteLength(line) + 1 > 4096) { // the real tool cuts such a line in two and stores a damaged value
        code = 1;
        break;
      }
      code = command(split(line));
    }
  } else {
    code = command(argv);
  }
  process.exitCode = code;
}

// The fake is started through its "#!" line, which cannot hold a path with spaces.
const FAKE_TOOL = process.platform !== 'win32' && !/\s/.test(process.execPath);
const skipFake = FAKE_TOOL ? false : 'needs a POSIX system and a Node path without spaces';
const SERVICE = 'WorkShop-test';

async function fakeKeychain(t) {
  const dir = await tempDir(t, 'workshop-fake-security-');
  const bin = path.join(dir, 'security.mjs');
  await writeFile(bin, [
    `#!${process.execPath}`,
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    `(${fakeSecurityTool})(fs, path, path.dirname(fileURLToPath(import.meta.url)));`,
    '',
  ].join('\n'));
  await chmod(bin, 0o755);
  return {
    bin,
    async calls() {
      const text = await readFile(path.join(dir, 'calls.log'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    items: () => readJson(path.join(dir, 'items.json')).catch(() => ({})),
    seed: (items) => writeFile(path.join(dir, 'items.json'), JSON.stringify(items)),
    mode: (mode) => writeFile(path.join(dir, 'mode.json'), JSON.stringify(mode)),
  };
}

async function makeKeychain(t, fake, options = {}) {
  const dataDir = await tempDir(t);
  return { dataDir, ...make(dataDir, { backend: 'keychain', service: SERVICE, securityPath: fake.bin, timeoutMs: 5000, ...options }) };
}

test('keychain (fake tool): set, get, update, list, envFor, remove; a value is never an argument', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const { secrets, logs, dataDir, metaFile } = await makeKeychain(t, fake);

  assert.equal(await secrets.get('anthropic'), null);
  assert.deepEqual(brief([await secrets.set('anthropic', DUMMY)]), [['anthropic', true, '3456']]);
  assert.equal(await secrets.get('anthropic'), DUMMY);
  assert.deepEqual(await secrets.envFor('claude'), { ANTHROPIC_API_KEY: DUMMY });
  await secrets.set('anthropic', ` "${DUMMY2}"\n`); // an update, with paste noise
  assert.equal(await secrets.get('anthropic'), DUMMY2);
  await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' });
  assert.deepEqual(brief(await secrets.list()), rows({ anthropic: '4321' }, ['my-tool', true, '3456']));
  assert.deepEqual(await fake.items(), { [`${SERVICE}/anthropic`]: hex(DUMMY2), [`${SERVICE}/my-tool`]: hex(DUMMY) });

  // the value goes to `security -i` on stdin, as hex, with -U; argv never holds it
  const calls = await fake.calls();
  for (const { argv } of calls) assertNoSecretIn(argv.join(' '));
  const saves = calls.filter((call) => call.argv[0] === '-i');
  assert.equal(saves.length, 3);
  assert.deepEqual(saves[0].argv, ['-i']);
  assert.equal(saves[0].input, `add-generic-password -U -a anthropic -s ${SERVICE} -l "${SERVICE} anthropic" -X ${hex(DUMMY)}\n`);
  assert.deepEqual(calls.find((call) => call.argv.includes('-w')).argv, ['find-generic-password', '-a', 'anthropic', '-s', SERVICE, '-w']);

  // an id that cannot exist is answered without a call to the tool
  for (const id of ['Bad Id', '-w', 'a b', '', 42, null, undefined]) assert.equal(await secrets.get(id), null);
  assert.equal((await fake.calls()).length, calls.length);

  // no file holds a value, no log line either
  assert.deepEqual(await readdir(dataDir), ['keys-meta.json']);
  assertNoSecretIn(await readFile(metaFile, 'utf8'));
  assertNoSecretIn(JSON.stringify(logs));

  assert.equal(await secrets.remove('anthropic'), true);
  assert.equal(await secrets.remove('anthropic'), false);
  assert.equal(await secrets.get('anthropic'), null);
  assert.deepEqual(await secrets.envFor('claude'), {});
  assert.equal(await secrets.remove('my-tool'), true);
  assert.deepEqual(await fake.items(), {});
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
});

test('keychain (fake tool): odd values survive although the tool prints non-ASCII passwords as hex', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const { secrets } = await makeKeychain(t, fake);
  const values = [
    `dummy-${char(0xe9)}-${char(0x2713)}-${char(0x1f511)}-key-123456`, // accent, check mark, emoji
    'c3a9c3a9c3a9', // looks like the hex the tool prints
    'workshop-b64:dummy-looks-like-the-marker',
    'dummy with spaces "double" \'single\' back\\slash $HOME `tick` ; | & * ? # ~ %',
    '-w -X --dummy-looks-like-options',
  ];
  for (const value of values) {
    await secrets.set('anthropic', value);
    assert.equal(await secrets.get('anthropic'), value);
    assert.deepEqual(await secrets.envFor('claude'), { ANTHROPIC_API_KEY: value });
    const stored = Buffer.from((await fake.items())[`${SERVICE}/anthropic`], 'hex');
    assert.ok(stored.every((byte) => byte >= 0x20 && byte <= 0x7e), 'only printable ASCII is stored');
  }
  // a plain value is stored as it is
  assert.equal(Buffer.from((await fake.items())[`${SERVICE}/anthropic`], 'hex').toString(), values.at(-1));
});

test('keychain (fake tool): a long value travels as quoted text; a value too long for that is refused', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const { secrets } = await makeKeychain(t, fake);
  const saves = async () => (await fake.calls()).filter((call) => call.argv[0] === '-i');
  const head = `add-generic-password -U -a anthropic -s ${SERVICE} -l "${SERVICE} anthropic" `;

  // a normal key travels as hex
  await secrets.set('anthropic', DUMMY);
  assert.equal((await saves()).at(-1).input, `${head}-X ${hex(DUMMY)}\n`);

  // too long for hex: quoted text, with quotes and backslashes escaped
  const long = `dummy "double" 'single' back\\slash \\" $HOME ${'x'.repeat(2400)} end`;
  await secrets.set('anthropic', long);
  assert.equal(await secrets.get('anthropic'), long);
  const escaped = `dummy \\"double\\" 'single' back\\\\slash \\\\\\" $HOME ${'x'.repeat(2400)} end`;
  assert.equal((await saves()).at(-1).input, `${head}-w "${escaped}"\n`);
  const accents = `dummy-${char(0xe9).repeat(1000)}`; // non-ASCII: stored as base64, which fits as quoted text
  await secrets.set('anthropic', accents);
  assert.equal(await secrets.get('anthropic'), accents);

  // the longest value that fits, and values that do not
  const longest = 'k'.repeat(4000 - `${head}-w ""\n`.length);
  await secrets.set('anthropic', longest);
  assert.equal(await secrets.get('anthropic'), longest);
  const count = (await saves()).length;
  for (const tooLong of [`${longest}k`, 'k'.repeat(4096), `${'"'.repeat(2000)}k`, `dummy-${char(0xe9).repeat(3000)}`]) {
    await refused(secrets.set('anthropic', tooLong), /too long for the macOS Keychain/, { secrets: [tooLong.slice(0, 40)] });
  }
  assert.equal((await saves()).length, count); // a refused value never reaches the tool
  assert.equal(await secrets.get('anthropic'), longest); // and the old value stays

  // "about 3800 characters" holds for the longest id; every command fits one 4096-byte read of the tool
  const id = 'a'.repeat(40);
  await secrets.set(id, 'k'.repeat(3800), { envVar: 'LONGEST_KEY' });
  assert.equal(await secrets.get(id), 'k'.repeat(3800));
  for (const { argv, input } of await fake.calls()) {
    assert.ok(Buffer.byteLength(input) <= 4000);
    assert.ok(argv.join(' ').length < 200, 'no value in an argument list');
  }
});

test('keychain (fake tool): a missing tool gives a clear error, and nothing falls back to a file', { skip: skipFake }, async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, logs } = make(dataDir, { backend: 'keychain', service: SERVICE, securityPath: path.join(dataDir, 'no-such-tool') });
  await refused(secrets.set('anthropic', DUMMY), /macOS Keychain is not available: .*could not be run \(ENOENT\)/, { status: 503 });
  await refused(secrets.get('anthropic'), /macOS Keychain is not available/, { status: 503 });
  await refused(secrets.envFor('claude'), /macOS Keychain is not available/, { status: 503 });
  await refused(secrets.remove('anthropic'), /macOS Keychain is not available/, { status: 503 });
  assert.deepEqual(await secrets.list(), KNOWN_UNSET); // metadata still works
  assert.deepEqual(await readdir(dataDir), []); // no keys.json, no metadata for a key that was not stored
  assert.ok(logs.some((entry) => entry.level === 'warn'));
  assertNoSecretIn(JSON.stringify(logs));
});

test('keychain (fake tool): a call that hangs is killed after the timeout', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const { secrets, logs, dataDir } = await makeKeychain(t, fake, { timeoutMs: 300 });
  await fake.mode({ hang: true });
  const started = Date.now();
  await refused(secrets.set('anthropic', DUMMY), /did not answer within 0\.3 s \(it may be locked or waiting/, { status: 503 });
  await refused(secrets.get('anthropic'), /did not answer within 0\.3 s/, { status: 503 });
  assert.ok(Date.now() - started < 5000, 'three timeouts of 0.3 s each');
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assertNoSecretIn(JSON.stringify(logs));

  await fake.mode({});
  // Works again once the Keychain answers. The limit is a long one here: the fake tool is a Node script,
  // which can need more than 0.3 s to start on a busy machine. (That one instance works again after a
  // timeout is tested in secrets.adversarial.test.mjs.)
  const patient = make(dataDir, { backend: 'keychain', service: SERVICE, securityPath: fake.bin, timeoutMs: 20_000 }).secrets;
  await patient.set('anthropic', DUMMY);
  assert.equal(await patient.get('anthropic'), DUMMY);
});

test('keychain (fake tool): a locked Keychain gives a clear error and stderr is never passed on', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const { secrets, logs, dataDir } = await makeKeychain(t, fake);
  await secrets.list();

  await fake.mode({ exit: 36, on: 'add' }); // the fake echoes its input on stderr, like the real tool can
  await refused(secrets.set('anthropic', DUMMY), /not available: it is locked or needs you to answer a prompt/, { status: 503 });
  await fake.mode({ exit: 2, on: 'add' });
  await refused(secrets.set('anthropic', DUMMY), /the security tool failed with exit code 2/, { status: 503 });
  await fake.mode({ exit: 51, on: 'find' });
  await refused(secrets.get('anthropic'), /not available: it refused access/, { status: 503 });
  await fake.mode({ exit: 128, on: 'delete' });
  await refused(secrets.remove('anthropic'), /the request was cancelled/, { status: 503 });

  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.deepEqual(await readdir(dataDir), []);
  assert.ok(logs.filter((entry) => entry.level === 'warn').length >= 4);
  assertNoSecretIn(JSON.stringify(logs));
});

test('keychain (fake tool): a value that reads back wrong is removed and reported', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const { secrets, logs } = await makeKeychain(t, fake);
  await fake.mode({ truncate: true });
  await refused(secrets.set('anthropic', DUMMY), /did not store the key correctly\. Nothing was saved/, { status: 503 });
  assert.deepEqual(await fake.items(), {});
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assertNoSecretIn(JSON.stringify(logs));
});

test('keychain (fake tool): the first load matches "set" with the Keychain; later lists do not call it', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const { secrets, metaFile } = await makeKeychain(t, fake);
  await fake.seed({ [`${SERVICE}/gemini`]: hex('dummy-gemini-key-98765'), 'Other-service/openai': hex(DUMMY) });
  await writeFile(metaFile, JSON.stringify({
    anthropic: { label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', hint: 'zzzz', updatedAt: 1 },
    'old-key': { label: 'Old', envVar: 'OLD_KEY', hint: 'yyyy', updatedAt: 2 },
  }));

  assert.deepEqual(brief(await secrets.list()), rows({ gemini: '8765' }, ['old-key', false, null]));
  const meta = await readJson(metaFile);
  assert.deepEqual([meta.anthropic.hint, meta.gemini.hint, meta['old-key'].hint, meta.openai], [null, '8765', null, undefined]);
  const calls = await fake.calls();
  // 5 checks that read attributes only, and 1 value read to build the hint that was missing
  assert.deepEqual(calls.map((call) => call.argv.join(' ')).sort(), [
    `find-generic-password -a anthropic -s ${SERVICE}`,
    `find-generic-password -a gemini -s ${SERVICE}`,
    `find-generic-password -a gemini -s ${SERVICE} -w`,
    `find-generic-password -a old-key -s ${SERVICE}`,
    `find-generic-password -a openai -s ${SERVICE}`,
    `find-generic-password -a oss -s ${SERVICE}`,
    `find-generic-password -a typesafe -s ${SERVICE}`,
  ]);

  await secrets.list();
  await secrets.list();
  assert.equal((await fake.calls()).length, calls.length);
});

test('keychain (fake tool): a switch of backend keeps the label and env var of every key', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const dataDir = await tempDir(t);
  const keychainOptions = { backend: 'keychain', service: SERVICE, securityPath: fake.bin, timeoutMs: 5000 };

  const file = make(dataDir).secrets;
  await file.set('anthropic', DUMMY2, { label: 'Anthropic (work)' });
  await file.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY', label: 'My tool' });

  // same data folder, Keychain backend: the Keychain holds nothing yet
  const keychain = make(dataDir, keychainOptions).secrets;
  assert.deepEqual(await keychain.list(), [
    { ...KNOWN_UNSET[0], label: 'Anthropic (work)' },
    KNOWN_UNSET[1],
    KNOWN_UNSET[2],
    KNOWN_UNSET[3],
    KNOWN_UNSET[4],
    { id: 'my-tool', label: 'My tool', envVar: 'MY_TOOL_KEY', set: false, hint: null, updatedAt: null },
  ]);
  assert.equal(await keychain.get('my-tool'), null);
  assert.deepEqual(await keychain.envFor('claude'), {});
  await keychain.set('my-tool', 'dummy-keychain-value-777777'); // the env var is remembered
  assert.deepEqual(brief(await keychain.list()).at(-1), ['my-tool', true, '7777']);

  // back to the file: its values were never touched
  const back = make(dataDir).secrets;
  assert.deepEqual((await back.list()).map((key) => [key.id, key.label, key.envVar, key.set, key.hint]), [
    ['anthropic', 'Anthropic (work)', 'ANTHROPIC_API_KEY', true, '4321'],
    ['gemini', 'Google Gemini', 'GEMINI_API_KEY', false, null],
    ['openai', 'OpenAI', 'OPENAI_API_KEY', false, null],
    ['typesafe', 'TypeSafe (Jev)', 'TYPESAFE_API_KEY', false, null],
    ['oss', 'Open-Source Runtime Bearer Token (optional)', 'OSS_API_KEY', false, null],
    ['my-tool', 'My tool', 'MY_TOOL_KEY', true, '7777'], // the hint is not rebuilt while "set" still matches
  ]);
  assert.equal(await back.get('my-tool'), DUMMY);
  assert.deepEqual(await fake.items(), { [`${SERVICE}/my-tool`]: hex('dummy-keychain-value-777777') });
});

test('keychain (fake tool): when the Keychain cannot be checked, the saved metadata is used', { skip: skipFake }, async (t) => {
  const fake = await fakeKeychain(t);
  const { secrets, logs, metaFile } = await makeKeychain(t, fake);
  const saved = {
    anthropic: { label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', hint: 'abcd', updatedAt: 1 },
    'my-tool': { label: 'My tool', envVar: 'MY_TOOL_KEY', hint: 'wxyz', updatedAt: 2 },
  };
  await writeFile(metaFile, JSON.stringify(saved));
  await fake.mode({ exit: 36 });

  assert.deepEqual(brief(await secrets.list()), rows({ anthropic: 'abcd' }, ['my-tool', true, 'wxyz']));
  assert.deepEqual(await readJson(metaFile), saved);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /could not check the key store/.test(entry.msg)));
  assert.equal((await fake.calls()).length, 1); // it stops at the first failure
});

// ---------------------------------------------------------------------------------------------------------
// Keychain backend for real (one guarded self-test)
// ---------------------------------------------------------------------------------------------------------

const LIVE = process.platform === 'darwin' && process.env.WORKSHOP_SKIP_KEYCHAIN === undefined;
const skipLive = LIVE ? false : 'needs macOS, and WORKSHOP_SKIP_KEYCHAIN must not be set';

const liveOptions = { skip: skipLive, timeout: 120_000 };

test('keychain (live): self-test on the real macOS Keychain, service "WorkShop-selftest"', liveOptions, async (t) => {
  const service = 'WorkShop-selftest';
  const id = `selftest-${process.pid}`; // one account per test process, so two runs at once do not collide
  const marks = 'dummy-not-a-real-key "double" \'single\' back\\slash $HOME `tick` ; | & # 123456';
  const long = `${marks} \\" ${'x'.repeat(2500)} end`;
  const odd = `dummy-not-a-real-key ${char(0xe9)} ${char(0x2713)} "quoted" 123456`;
  const values = [DUMMY, DUMMY2, marks, long, odd];

  /** Runs /usr/bin/security. Every call names the self-test service, so no other Keychain item is touched. */
  const security = (args) => new Promise((done) => {
    execFile('/usr/bin/security', [...args, '-s', service], { timeout: 5000, killSignal: 'SIGKILL' },
      (err, stdout) => done({ code: err ? err.code ?? 'TIMEOUT' : 0, stdout }));
  });
  const alive = (pid) => {
    try { return process.kill(pid, 0); } catch (err) { return err.code === 'EPERM'; }
  };
  /** The account of a self-test item nobody is using, or null. It reads attributes only. */
  const leftover = async () => {
    const { code, stdout } = await security(['find-generic-password']);
    if (code === 44) return null;
    const account = /"acct"<blob>="([^"]*)"/.exec(stdout)?.[1] ?? `(find-generic-password gave ${code})`;
    const pid = Number(/^selftest-(\d+)$/.exec(account)?.[1]);
    return pid && pid !== process.pid && alive(pid) ? null : account; // another test process is using its own item
  };
  /** Deletes items that a crashed earlier run left behind. It stops when an item cannot be deleted. */
  const sweep = async () => {
    for (let n = 0, last = null; n < 10; n++) {
      const account = await leftover();
      if (!account || account === last) return;
      await security(['delete-generic-password', '-a', account]);
      last = account;
    }
  };

  // 5 s per call: a hang or a password prompt fails the test fast instead of blocking it
  const options = { backend: 'keychain', service, timeoutMs: 5000 };
  const { secrets, logs, metaFile } = make(await tempDir(t), options);
  await sweep(); // a run that crashed earlier may have left its item
  try {
    assert.equal(await secrets.get(id), null);
    assert.deepEqual(await secrets.list(), KNOWN_UNSET);

    const entry = await secrets.set(id, DUMMY, { envVar: 'SELFTEST_KEY', label: 'Self-test' });
    assert.deepEqual(core(entry), [id, 'Self-test', 'SELFTEST_KEY', true, '3456']);
    assert.equal(await secrets.get(id), DUMMY);

    await secrets.set(id, DUMMY2); // update
    assert.equal(await secrets.get(id), DUMMY2);
    assert.deepEqual(brief(await secrets.list()), rows({}, [id, true, '4321']));

    await secrets.set(id, marks); // update with quotes, a backslash and shell characters
    assert.equal(await secrets.get(id), marks);
    await secrets.set(id, long); // update with a value too long for hex: it travels as quoted text
    assert.equal(await secrets.get(id), long);
    await secrets.set(id, odd); // update with text the tool would print as hex
    assert.equal(await secrets.get(id), odd);

    // a second instance, whose metadata says "not set", finds the item on its first load
    const second = make(await tempDir(t), options);
    await writeFile(second.metaFile, JSON.stringify({ [id]: { label: 'Self-test', envVar: 'SELFTEST_KEY', hint: null, updatedAt: null } }));
    assert.deepEqual(brief(await second.secrets.list()).at(-1), [id, true, '3456']);

    assert.equal(await secrets.remove(id), true);
    assert.equal(await secrets.get(id), null);
    assert.equal(await secrets.remove(id), false);
    assert.deepEqual(await secrets.list(), KNOWN_UNSET);
    assertNoSecretIn(await readFile(metaFile, 'utf8'), values);
    assertNoSecretIn(JSON.stringify(logs), values);
  } finally {
    await security(['delete-generic-password', '-a', id]);
  }
  assert.equal((await security(['find-generic-password', '-a', id])).code, 44, 'the self-test item must be gone');
  assert.equal(await leftover(), null, 'no self-test item may stay in the Keychain');
});
