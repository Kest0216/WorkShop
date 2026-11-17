// Adversarial tests for server/secrets.js. Run: node --test tests/secrets.adversarial.test.mjs
//
// Each test states a rule that the first version of the module broke. A comment "was:" says what it did.
// The real Keychain is never touched: the keychain backend runs against a fake `security` tool with
// switchable faults (a small script in a temp folder). All values are dummies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTick, setTimeout as sleep } from 'node:timers/promises';

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

const hex = (text) => Buffer.from(text).toString('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const brief = (entries) => entries.map((key) => [key.id, key.set, key.hint]);
/** What brief(list) should be: the known keys with the given hints (not set when left out), then custom rows. */
const rows = (hints = {}, ...custom) => [
  ...['anthropic', 'gemini', 'openai', 'typesafe', 'oss'].map((id) => [id, id in hints, hints[id] ?? null]),
  ...custom,
];

/** A temp folder that is removed when the test ends. */
async function tempDir(t, prefix = 'workshop-secrets-adv-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A secrets module on a folder, with a logger that records every call. */
function make(dataDir, options = {}) {
  const logs = [];
  const secrets = createSecrets({
    backend: 'file', dataDir, log: (level, msg, data) => logs.push({ level, msg, data }), ...options,
  });
  return { secrets, logs, keysFile: path.join(dataDir, 'keys.json'), metaFile: path.join(dataDir, 'keys-meta.json') };
}

/** Asserts a rejection with a plain message and a status, which never echoes a value. */
async function refused(promise, pattern, { status = 400 } = {}) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, pattern);
    assert.equal(err.status, status);
    for (const secret of [DUMMY, DUMMY2]) {
      assert.ok(!err.message.includes(secret), 'the error must not echo the value');
      assert.ok(!err.message.includes(hex(secret)), 'the error must not echo the value as hex');
    }
    return true;
  });
}

/** Awaits a call that must be refused, and gives its error. The error must not echo a value. */
async function rejection(promise) {
  const err = await promise.then(() => null, (reason) => reason);
  assert.ok(err instanceof Error, 'the call must be refused');
  for (const secret of [DUMMY, DUMMY2]) {
    assert.ok(!err.message.includes(secret) && !err.message.includes(hex(secret)), 'the error must not echo the value');
  }
  return err;
}

function assertNoSecretIn(text) {
  for (const secret of [DUMMY, DUMMY2]) {
    assert.ok(!text.includes(secret), 'a value leaked');
    assert.ok(!text.includes(hex(secret)), 'a value leaked as hex');
  }
}

/** Calls `probe` until it gives a value that is not null. Fails after `limitMs`. */
async function until(probe, limitMs = 60_000) {
  const end = Date.now() + limitMs;
  for (;;) {
    const result = await probe();
    if (result !== null) return result;
    assert.ok(Date.now() < end, `nothing happened within ${limitMs} ms`);
    await sleep(50);
  }
}

const isAlive = (pid) => {
  try { return process.kill(pid, 0); } catch (err) { return err.code === 'EPERM'; }
};

/** True when no process runs the given script (or when this system has no pgrep to tell). */
const noProcessRuns = (script) => new Promise((done) => {
  execFile('/usr/bin/pgrep', ['-f', script], { timeout: 5000 }, (err, stdout) => done(String(stdout).trim() === ''));
});

// ---------------------------------------------------------------------------------------------------------
// A fake `security` tool with switchable faults
// ---------------------------------------------------------------------------------------------------------

/**
 * Source of the fake tool. It runs as its own script, so it must not use anything from this file.
 * State lives next to the script: items.json (the "keychain": "service/account" -> hex of the stored bytes),
 * calls.log (one line per call: action, account, pid), mode.json (the faults).
 * Actions: add (through `security -i`), has (find without -w), read (find with -w), delete.
 * Faults: hang: [action]   the call never answers
 *         stall: [action]   the call does its work, and then never answers
 *         exit: {action: code}   the call fails with this exit code and echoes its input on stderr
 *         slow: {action: ms}   the call takes this long
 *         damage: true   add reports success but stores a cut value
 *         watch: file   add notes in calls.log whether this JSON file lists the account at that moment
 */
function fakeSecurityTool(fs, path, dir) {
  const load = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  const mode = load(path.join(dir, 'mode.json'), {});
  const items = load(path.join(dir, 'items.json'), {});
  const argv = process.argv.slice(2);
  const input = argv[0] === '-i' ? fs.readFileSync(0, 'utf8') : '';

  /** Splits a line like the real tool: blanks separate, quotes group, a backslash keeps the next character. */
  function split(line) {
    const words = [];
    let word = null;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\') word = (word ?? '') + (line[++i] ?? '');
      else if (quoted) {
        if (ch === '"') {
          words.push(word);
          word = null;
          quoted = false;
        } else word += ch;
      } else if (/\s/.test(ch)) {
        if (word !== null) words.push(word);
        word = null;
      } else if (word === null && ch === '"') {
        quoted = true;
        word = '';
      } else word = (word ?? '') + ch;
    }
    if (word !== null) words.push(word);
    return words;
  }

  const [name = '', ...args] = argv[0] === '-i' ? split(input.split('\n')[0]) : argv;
  const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const account = option('-a');
  const key = `${option('-s')}/${account}`;
  const action = name.startsWith('add') ? 'add' : name.startsWith('delete') ? 'delete' : args.includes('-w') ? 'read' : 'has';
  const call = { action, account, pid: process.pid };
  if (action === 'add' && mode.watch) call.listed = account in load(mode.watch, {});
  fs.appendFileSync(path.join(dir, 'calls.log'), `${JSON.stringify(call)}\n`);

  if (mode.hang?.includes(action)) {
    setTimeout(() => {}, 20_000); // long enough to need the kill, short enough to never stay behind
    return;
  }
  if (mode.slow?.[action]) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, mode.slow[action]);
  if (mode.exit?.[action]) {
    process.stderr.write(`security: ${name} failed: ${input || args.join(' ')}\n`); // the real tool can echo its input
    process.exitCode = mode.exit[action];
    return;
  }
  const saveItems = () => { // atomic, because a read may run at the same time
    fs.writeFileSync(path.join(dir, `items.${process.pid}.tmp`), JSON.stringify(items));
    fs.renameSync(path.join(dir, `items.${process.pid}.tmp`), path.join(dir, 'items.json'));
    if (mode.stall?.includes(action)) setTimeout(() => {}, 20_000);
  };
  if (action === 'add') {
    const stored = args.includes('-X') ? option('-X') : Buffer.from(option('-w')).toString('hex');
    items[key] = mode.damage ? stored.slice(0, -2) : stored;
    saveItems();
    return;
  }
  if (!(key in items)) {
    process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');
    process.exitCode = 44;
    return;
  }
  if (action === 'delete') {
    delete items[key];
    saveItems();
  } else if (action === 'read') {
    // like the real tool: text when every byte is printable ASCII, hex otherwise
    const bytes = Buffer.from(items[key], 'hex');
    const printable = bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
    process.stdout.write(`${printable ? bytes.toString('latin1') : items[key]}\n`);
  } else {
    process.stdout.write('keychain: "fake"\nclass: "genp"\n');
  }
}

// The fake is started through its "#!" line, which cannot hold a path with spaces.
const FAKE_TOOL = process.platform !== 'win32' && !/\s/.test(process.execPath);
const fake = { skip: FAKE_TOOL ? false : 'needs a POSIX system and a Node path without spaces' };
const SERVICE = 'WorkShop-test';
const item = (id) => `${SERVICE}/${id}`;

async function fakeKeychain(t) {
  const dir = await tempDir(t, 'workshop-fake-security-adv-');
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
  const write = async (name, data) => { // atomic, because the tool may read at the same time
    await writeFile(path.join(dir, `${name}.next`), JSON.stringify(data));
    await rename(path.join(dir, `${name}.next`), path.join(dir, name));
  };
  return {
    bin,
    async calls(action) {
      const text = await readFile(path.join(dir, 'calls.log'), 'utf8').catch(() => '');
      const calls = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      return action ? calls.filter((call) => call.action === action) : calls;
    },
    items: () => readJson(path.join(dir, 'items.json')).catch(() => ({})),
    seed: (items) => write('items.json', items),
    mode: (mode) => write('mode.json', mode),
  };
}

/**
 * A keychain-backed module on the fake tool. `again()` is a new instance on the same folder: a hub restart.
 * The time limit is long: the fake tool is a Node script, which starts slowly on a busy machine.
 */
async function makeKeychain(t, tool, options = {}) {
  const dataDir = await tempDir(t);
  const all = { backend: 'keychain', service: SERVICE, securityPath: tool.bin, timeoutMs: 20_000, ...options };
  return { dataDir, again: (more = {}) => make(dataDir, { ...all, ...more }), ...make(dataDir, all) };
}

// ---------------------------------------------------------------------------------------------------------
// Failed saves must leave the list in step with the key store
// ---------------------------------------------------------------------------------------------------------

test('keychain: after a save that read back wrong, the list says what the Keychain holds', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, logs, metaFile, again } = await makeKeychain(t, tool);
  await secrets.set('anthropic', DUMMY);
  await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY', label: 'My tool' });

  await tool.mode({ damage: true }); // the tool reports success, but stores a cut value
  const errors = [await rejection(secrets.set('anthropic', DUMMY2)), await rejection(secrets.set('my-tool', DUMMY2))];
  assert.deepEqual(await tool.items(), {}); // the damaged values were removed, and the old values went with them

  // was: both keys stayed listed as set, with the hint of a value that is gone
  const listed = await secrets.list();
  assert.deepEqual(brief(listed), rows({}, ['my-tool', false, null]));
  assert.deepEqual(listed[5], { id: 'my-tool', label: 'My tool', envVar: 'MY_TOOL_KEY', set: false, hint: null, updatedAt: null });
  assert.equal(await secrets.get('anthropic'), null);
  assert.deepEqual(await secrets.envFor('claude'), {});
  const meta = await readJson(metaFile);
  assert.deepEqual([meta.anthropic.hint, meta['my-tool'].hint], [null, null]);
  assert.deepEqual(await again().secrets.list(), listed);
  assertNoSecretIn(JSON.stringify(logs));
  for (const err of errors) {
    assert.equal(err.status, 503);
    // was: "Nothing was saved." and no word that the old value is gone too
    assert.match(err.message, /did not store the key correctly\. Nothing was saved, and the key is not set now/);
  }

  await tool.mode({});
  assert.deepEqual(brief([await secrets.set('my-tool', DUMMY2)]), [['my-tool', true, '4321']]); // and it works again
});

test('keychain: a damaged value that cannot be removed is listed, so the owner can remove it', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, again } = await makeKeychain(t, tool);
  await secrets.list();

  await tool.mode({ damage: true, exit: { delete: 51 } });
  const errors = [
    await rejection(secrets.set('anthropic', DUMMY)),
    await rejection(secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' })),
  ];
  assert.deepEqual(Object.keys(await tool.items()).sort(), [item('anthropic'), item('my-tool')]); // damaged values

  // was: "not set" for the known key and no row at all for the custom key, while get() gave the damaged values
  const listed = await secrets.list();
  assert.deepEqual(brief(listed), rows({ anthropic: 'set' }, ['my-tool', true, 'set']));
  assert.deepEqual(brief(await again().secrets.list()), brief(listed));
  for (const err of errors) {
    assert.equal(err.status, 503);
    assert.match(err.message, /did not store the key correctly.*could not be removed/); // was: "Nothing was saved."
  }

  await tool.mode({});
  assert.equal(await secrets.remove('anthropic'), true);
  assert.equal(await secrets.remove('my-tool'), true);
  assert.deepEqual(await tool.items(), {});
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
});

test('keychain: a value that was stored but cannot be read back is listed, not hidden', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, logs, again } = await makeKeychain(t, tool);
  await secrets.list();

  await tool.mode({ exit: { read: 36 } }); // saving works; reading waits for a prompt that nobody answers
  const errors = [
    await rejection(secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY', label: 'My tool' })),
    await rejection(secrets.set('anthropic', DUMMY)),
  ];
  assert.deepEqual(await tool.items(), { [item('anthropic')]: hex(DUMMY), [item('my-tool')]: hex(DUMMY) });

  // was: the known key "not set" and no row for the custom key: its value sat in the Keychain where no list
  // showed it, and the owner could not remove it
  const listed = await secrets.list();
  assert.deepEqual(brief(listed), rows({ anthropic: 'set' }, ['my-tool', true, 'set']));
  assert.deepEqual([listed[5].label, listed[5].envVar], ['My tool', 'MY_TOOL_KEY']);
  assert.ok(Number.isInteger(listed[5].updatedAt));
  assertNoSecretIn(JSON.stringify(logs));
  for (const err of errors) {
    assert.equal(err.status, 503);
    // was: "The macOS Keychain is not available", as if nothing had been stored
    assert.match(err.message, /key was stored .*could not be read back: it is locked or needs you to answer a prompt/);
  }

  await tool.mode({});
  assert.deepEqual(brief(await again().secrets.list()), brief(listed));
  assert.equal(await secrets.get('my-tool'), DUMMY);
  assert.equal(await secrets.remove('my-tool'), true);
  assert.equal(await secrets.remove('anthropic'), true);
  assert.deepEqual(await tool.items(), {});
});

test('keychain: a custom key is listed on disk before its value reaches the Keychain', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, dataDir, metaFile, again } = await makeKeychain(t, tool);
  await tool.mode({ watch: metaFile });
  await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' });
  await secrets.set('my-tool', DUMMY2);
  // was: listed false for the first save. The id of a custom key is the only way to find its value again, so a
  // crash between the two writes left a value in the Keychain that no list would ever show.
  assert.deepEqual((await tool.calls('add')).map((call) => [call.account, call.listed]), [['my-tool', true], ['my-tool', true]]);
  assert.deepEqual(brief(await secrets.list()), rows({}, ['my-tool', true, '4321']));

  // a save that the Keychain refuses leaves no row behind, now or after a restart
  await tool.mode({ exit: { add: 36 } });
  await refused(secrets.set('other-tool', DUMMY, { envVar: 'OTHER_TOOL_KEY' }), /locked/, { status: 503 });
  await refused(secrets.set('other-tool', 'k'.repeat(4096), { envVar: 'OTHER_TOOL_KEY' }), /too long for the macOS Keychain/);
  assert.deepEqual(brief(await secrets.list()), rows({}, ['my-tool', true, '4321']));
  assert.deepEqual(Object.keys(await readJson(metaFile)), ['my-tool']);
  assert.deepEqual(brief(await again().secrets.list()), rows({}, ['my-tool', true, '4321']));
  assert.deepEqual(await readdir(dataDir), ['keys-meta.json']); // and no temp file
});

test('keychain: when keys-meta.json cannot be written, no value is stored that no list shows', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, logs, dataDir, again } = await makeKeychain(t, tool);
  await secrets.set('old-tool', DUMMY, { envVar: 'OLD_TOOL_KEY' });

  await chmod(dataDir, 0o500); // nothing can be created in the folder
  // a new custom key: nothing may reach the Keychain
  const refusedNew = await rejection(secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' }));
  // was: the value was stored. The list showed it until the hub stopped, and never again.
  assert.deepEqual(await tool.items(), { [item('old-tool')]: hex(DUMMY) });
  assert.deepEqual(brief(await secrets.list()), rows({}, ['old-tool', true, '3456']));

  // keys that are on the list already: the value is stored, the list says so, and so does the error
  const refusedOld = [await rejection(secrets.set('anthropic', DUMMY)), await rejection(secrets.set('old-tool', DUMMY2))];
  assert.equal(await secrets.get('anthropic'), DUMMY);
  assert.equal(await secrets.get('old-tool'), DUMMY2);
  assert.deepEqual(brief(await secrets.list()), rows({ anthropic: '3456' }, ['old-tool', true, '4321']));
  await chmod(dataDir, 0o700);

  // a restart finds every value: nothing is hidden (the hint of old-tool is the one that reached the disk)
  assert.deepEqual(brief(await again().secrets.list()), rows({ anthropic: '3456' }, ['old-tool', true, '3456']));
  assert.deepEqual(await readdir(dataDir), ['keys-meta.json']);
  assertNoSecretIn(JSON.stringify(logs));

  // was: a bare "EACCES: permission denied, open ..." without a status, and no word on what happened to the key
  assert.equal(refusedNew.status, 500);
  assert.match(refusedNew.message, /Nothing was saved: keys-meta\.json could not be written \(EACCES\)/);
  for (const err of refusedOld) {
    assert.equal(err.status, 500);
    assert.match(err.message, /key is stored, but keys-meta\.json could not be written \(EACCES\)/);
  }
});

test('keychain: a remove that cannot write keys-meta.json shows the same list now and after a restart', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, dataDir, again } = await makeKeychain(t, tool);
  await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY', label: 'My tool' });
  await secrets.set('gemini', DUMMY, { label: 'Gemini (work)' });

  await chmod(dataDir, 0o500);
  const errors = [await rejection(secrets.remove('my-tool')), await rejection(secrets.remove('gemini'))];
  const live = await secrets.list();
  await chmod(dataDir, 0o700);
  assert.deepEqual(await tool.items(), {}); // the values are gone

  // was: the custom row vanished from the list, and came back as "not set" after a restart
  assert.deepEqual(live[1], { ...KNOWN_UNSET[1], label: 'Gemini (work)' });
  assert.deepEqual(live[5], { id: 'my-tool', label: 'My tool', envVar: 'MY_TOOL_KEY', set: false, hint: null, updatedAt: null });
  assert.deepEqual(await again().secrets.list(), live);
  for (const err of errors) {
    assert.equal(err.status, 500);
    assert.match(err.message, /key was removed, but keys-meta\.json could not be written \(EACCES\)/); // was: a bare EACCES
  }

  assert.equal(await secrets.remove('my-tool'), true); // a second try finishes the job
  assert.equal(await secrets.remove('gemini'), true);
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.deepEqual(await again().secrets.list(), KNOWN_UNSET);
});

test('keychain: random saves, removes and faults never hide a value, and the list ends up right', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, logs, dataDir, metaFile, again } = await makeKeychain(t, tool);
  let seed = 7; // a fixed seed: the same calls and faults in every run
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const ids = ['anthropic', 'gemini', 'openai', 'tool-a', 'tool-b', 'tool-c'];
  const options = (id) => (id.startsWith('tool-') ? { envVar: `${id.toUpperCase().replace('-', '_')}_KEY` } : undefined);
  const faults = [
    {}, {}, { exit: { add: 36 } }, { exit: { read: 51 } }, { exit: { has: 2 } }, { exit: { delete: 51 } },
    { damage: true }, { damage: true, exit: { delete: 51 } },
  ];
  for (let step = 0; step < 16; step++) {
    await tool.mode(pick(faults));
    const calls = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => {
      const id = pick(ids);
      const action = pick(['set', 'set', 'remove', 'get', 'list']);
      if (action === 'set') return secrets.set(id, `dummy-value-${step}-${i}-0123456789`, options(id));
      if (action === 'remove') return secrets.remove(id);
      return action === 'get' ? secrets.get(id) : secrets.list();
    });
    for (const result of await Promise.allSettled(calls)) {
      if (result.status === 'rejected') assert.equal(result.reason.status, 503, result.reason.message);
    }
  }

  // The faults end. The hub reads every key once (as it does when it starts agents), then the list must say
  // what the Keychain holds: no row is wrong, and no value sits there without a row.
  await tool.mode({});
  for (const entry of await secrets.list()) await secrets.get(entry.id);
  const listed = await secrets.list();
  const held = await tool.items();
  const wrong = listed.filter((entry) => entry.set !== Boolean(held[item(entry.id)])).map((entry) => entry.id);
  const hidden = Object.keys(held).filter((key) => !listed.some((entry) => item(entry.id) === key));
  assert.deepEqual({ wrong, hidden }, { wrong: [], hidden: [] });
  assert.ok(listed.some((entry) => entry.set) && Object.keys(held).length > 0, 'the run must leave some keys');

  const core = (entries) => entries.map((entry) => [entry.id, entry.label, entry.envVar, entry.set, entry.hint]);
  assert.deepEqual(core(await again().secrets.list()), core(listed)); // a restart shows the same
  assert.deepEqual(await readdir(dataDir), ['keys-meta.json']);
  const written = JSON.stringify(logs) + await readFile(metaFile, 'utf8');
  assert.ok(!written.includes('dummy-value-') && !written.includes(hex('dummy-value-')), 'a value leaked');
});

// ---------------------------------------------------------------------------------------------------------
// The list must follow the key store while the hub runs (it runs for days)
// ---------------------------------------------------------------------------------------------------------

test('keychain: a check that failed while the hub started is repeated by a later list', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, logs } = await makeKeychain(t, tool);
  await tool.seed({ [item('anthropic')]: hex(DUMMY) });
  await tool.mode({ exit: { has: 36 } }); // the Keychain cannot be checked yet
  assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.equal(logs.filter((entry) => /could not check the key store/.test(entry.msg)).length, 1);

  // a failed check is not repeated at once by every list
  for (let i = 0; i < 5; i++) assert.deepEqual(await secrets.list(), KNOWN_UNSET);
  assert.equal((await tool.calls()).length, 1);

  await tool.mode({}); // the Keychain answers again
  // was: "not set" until the next restart, so the lab stayed unusable although its key was there
  const listed = await until(async () => {
    const entries = await secrets.list();
    return entries[0].set ? entries : null;
  });
  assert.deepEqual(brief(listed), rows({ anthropic: '3456' }));

  const calls = (await tool.calls()).length;
  await secrets.list();
  await secrets.list();
  assert.equal((await tool.calls()).length, calls); // once the check worked, lists do not call the tool
});

test('file: a check that failed because keys.json was open to others is repeated after chmod 600', async (t) => {
  const dataDir = await tempDir(t);
  const first = make(dataDir);
  await first.secrets.set('gemini', DUMMY);
  await rm(first.metaFile);
  await chmod(first.keysFile, 0o644);

  const { secrets, keysFile } = make(dataDir);
  assert.deepEqual(await secrets.list(), KNOWN_UNSET); // the saved metadata (none)
  await chmod(keysFile, 0o600); // the owner does what the error message says
  // was: gemini "not set" until the next restart
  const listed = await until(async () => {
    const entries = await secrets.list();
    return entries[1].set ? entries : null;
  });
  assert.deepEqual(brief(listed), rows({ gemini: '3456' }));
});

test('file: the list follows keys.json when a read shows that it changed', async (t) => {
  const dataDir = await tempDir(t);
  const { secrets, keysFile, metaFile } = make(dataDir);
  await secrets.set('anthropic', DUMMY);
  await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' });

  // the owner edits keys.json by hand while the hub runs
  await writeFile(keysFile, JSON.stringify({ gemini: 'dummy-gemini-key-98765' }), { mode: 0o600 });
  assert.deepEqual(await secrets.envFor('claude'), {});
  assert.equal(await secrets.get('my-tool'), null);
  assert.deepEqual(await secrets.envFor('gemini'), { GEMINI_API_KEY: 'dummy-gemini-key-98765' });

  // was: anthropic and my-tool stayed "set" and gemini "not set" until the next restart
  const listed = await secrets.list();
  assert.deepEqual(brief(listed), rows({ gemini: '8765' }, ['my-tool', false, null]));
  assert.equal(listed[5].envVar, 'MY_TOOL_KEY'); // the custom key keeps its row
  const meta = await readJson(metaFile);
  assert.deepEqual([meta.anthropic.hint, meta.gemini.hint, meta['my-tool'].hint], [null, '8765', null]);
  assertNoSecretIn(JSON.stringify(meta));

  // a list that cannot write keys-meta.json still answers, with the right rows
  await writeFile(keysFile, JSON.stringify({ 'my-tool': DUMMY2 }), { mode: 0o600 });
  await chmod(dataDir, 0o500);
  assert.equal(await secrets.get('my-tool'), DUMMY2);
  assert.deepEqual(await secrets.envFor('gemini'), {});
  assert.deepEqual(brief(await secrets.list()), rows({}, ['my-tool', true, '4321']));
  await chmod(dataDir, 0o700);
  assert.deepEqual(brief(await make(dataDir).secrets.list()), rows({}, ['my-tool', true, '4321'])); // a restart agrees
});

test('keychain: the list follows the Keychain when a read shows that it changed', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets } = await makeKeychain(t, tool);
  await secrets.set('anthropic', DUMMY);
  await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' });

  // the owner deletes one item and adds another in Keychain Access while the hub runs
  await tool.seed({ [item('my-tool')]: hex(DUMMY), [item('openai')]: hex(DUMMY2) });
  assert.deepEqual(await secrets.envFor('claude'), {});
  assert.deepEqual(await secrets.envFor('openai'), { OPENAI_API_KEY: DUMMY2 });
  // was: anthropic stayed "set" (so the lab looked usable) and openai "not set" until the next restart
  assert.deepEqual(brief(await secrets.list()), rows({ openai: '4321' }, ['my-tool', true, '3456']));

  const calls = (await tool.calls()).length;
  await secrets.list();
  assert.equal(await secrets.get('my-tool'), DUMMY);
  await secrets.list();
  assert.equal((await tool.calls()).length, calls + 1); // a read that agrees with the list costs nothing more
});

test('keychain: an item without a value is not listed as set', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, logs } = await makeKeychain(t, tool);
  await tool.seed({ [item('anthropic')]: '', [item('gemini')]: hex(DUMMY) }); // anthropic: made by hand, empty password
  // was: anthropic set: true with hint "set", although get() and envFor() give nothing
  assert.deepEqual(brief(await secrets.list()), rows({ gemini: '3456' }));
  assert.deepEqual(logs.filter((entry) => entry.level !== 'info'), []); // an empty item is no reason to warn
  assert.equal(await secrets.get('anthropic'), null);
  assert.deepEqual(await secrets.envFor('claude'), {});
  assert.equal(await secrets.remove('anthropic'), true); // the empty item can still be removed
  assert.deepEqual(await tool.items(), { [item('gemini')]: hex(DUMMY) });
});

// ---------------------------------------------------------------------------------------------------------
// Slow and hung Keychain calls
// ---------------------------------------------------------------------------------------------------------

test('keychain: the first list stops reading values at the first one that cannot be read', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets, metaFile } = await makeKeychain(t, tool);
  const ids = ['anthropic', 'gemini', 'openai', 'extra-1', 'extra-2'];
  await tool.seed(Object.fromEntries(ids.map((id) => [item(id), hex(DUMMY)])));
  await writeFile(metaFile, JSON.stringify({
    'extra-1': { label: 'One', envVar: 'EXTRA_1', hint: null, updatedAt: null },
    'extra-2': { label: 'Two', envVar: 'EXTRA_2', hint: null, updatedAt: null },
  }));
  await tool.mode({ exit: { read: 36 } }); // every value read needs a prompt

  const listed = ids.map((id) => [id, true, 'set']);
  listed.splice(3, 0, ['typesafe', false, null], ['oss', false, null]); // the remaining known keys, not in the Keychain
  assert.deepEqual(brief(await secrets.list()), listed);
  // was: one read per key. A read that waits for a prompt takes the whole timeout: with 53 keys and the
  // default of 10 s, the first list took 9 minutes and raised 53 prompts.
  assert.equal((await tool.calls('read')).length, 1);
  assert.equal((await tool.calls('has')).length, 7);
});

test('keychain: a hung call is killed and leaves no process behind', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets: patient, again } = await makeKeychain(t, tool);
  await patient.set('gemini', DUMMY);

  // a second instance with a short limit, so that the test is fast; its first load hangs too
  const { secrets, logs } = again({ timeoutMs: 500 });
  const timedOut = (action) => logs.filter((entry) => entry.data?.code === 'TIMEOUT' && entry.data.action === action).length;
  await tool.mode({ hang: ['add', 'has', 'read', 'delete'] });
  const results = await Promise.allSettled([
    secrets.get('gemini'), secrets.envFor('gemini'), secrets.remove('gemini'),
    secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' }),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.status, 503);
    assert.match(result.reason.message, /did not answer within 0\.5 s/);
  }
  assert.deepEqual(['find', 'read', 'delete', 'save'].map(timedOut), [1, 2, 1, 1]);
  const pids = (await tool.calls()).map((call) => call.pid);
  await until(async () => (pids.some(isAlive) || !await noProcessRuns(tool.bin) ? null : true), 10_000);
  assert.deepEqual(await tool.items(), { [item('gemini')]: hex(DUMMY) }); // nothing changed in the Keychain

  // A call that was killed may or may not have done its work. So the new custom key keeps its row, and the
  // next list looks at the Keychain again. It gives up at the first read that hangs: one wait, not one per row.
  assert.deepEqual(brief(await secrets.list()), rows({ gemini: '3456' }, ['my-tool', false, null]));
  assert.equal(timedOut('read'), 3);

  await tool.mode({});
  const later = again().secrets; // with a long limit again: the row can be removed, and nothing else changed
  assert.equal(await later.remove('my-tool'), true);
  assert.deepEqual(brief(await later.list()), rows({ gemini: '3456' }));
});

test('keychain: a call that did its work and was then killed is found by the next list', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets: patient, again } = await makeKeychain(t, tool);
  await patient.set('gemini', DUMMY);
  // The limit must be short (the test waits for it three times), but long enough for the fake tool to do
  // its work. So it follows the time that one call of the tool takes on this machine right now.
  const started = performance.now();
  await patient.get('probe');
  const limit = Math.min(Math.max(1000, Math.ceil(10 * (performance.now() - started))), 15_000);
  const { secrets } = again({ timeoutMs: limit });
  await secrets.list();

  await tool.mode({ stall: ['add', 'delete'] }); // the tool does its work, but never answers
  const errors = [
    await rejection(secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' })),
    await rejection(secrets.set('openai', DUMMY2)),
    await rejection(secrets.remove('gemini')),
  ];
  for (const err of errors) assert.ok(err.message.includes(`did not answer within ${limit / 1000} s`), err.message);
  assert.deepEqual(await tool.items(), { [item('my-tool')]: hex(DUMMY), [item('openai')]: hex(DUMMY2) });

  await tool.mode({});
  // was: my-tool had no row (a value that no list showed), openai "not set" and gemini "set", until a restart
  const listed = await secrets.list();
  assert.deepEqual(brief(listed), rows({ openai: '4321' }, ['my-tool', true, '3456']));
  assert.deepEqual(brief(await again().secrets.list()), brief(listed));
  assert.equal(await secrets.remove('my-tool'), true); // the same instance works again
  assert.deepEqual(Object.keys(await tool.items()), [item('openai')]);
});

test('keychain: a save that takes long does not hold up the reads that start agents', fake, async (t) => {
  const tool = await fakeKeychain(t);
  const { secrets } = await makeKeychain(t, tool);
  await secrets.set('gemini', DUMMY);

  await tool.mode({ slow: { add: 2000 } }); // the owner looks at a prompt
  const order = [];
  const saving = secrets.set('anthropic', DUMMY2).then(() => order.push('save'));
  await sleep(100);
  const reading = Promise.all([secrets.envFor('gemini'), secrets.get('gemini'), secrets.get('openai')]).then((values) => {
    order.push('reads');
    return values;
  });
  assert.deepEqual(await reading, [{ GEMINI_API_KEY: DUMMY }, DUMMY, null]);
  await saving;
  assert.deepEqual(order, ['reads', 'save']);
  assert.deepEqual(brief(await secrets.list()), rows({ anthropic: '4321', gemini: '3456' }));
});

test('createSecrets: a timeout that no timer can hold is refused', async (t) => {
  const dataDir = await tempDir(t);
  // was: accepted. Node turns such a delay into 1 ms, so every Keychain call was killed at once.
  for (const timeoutMs of [2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createSecrets({ backend: 'keychain', dataDir, timeoutMs }), /timeoutMs must be/);
  }
  createSecrets({ backend: 'keychain', dataDir, timeoutMs: 2 ** 31 - 1 });
});

// ---------------------------------------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------------------------------------

test('file: a read that runs while a key is saved never moves the new keys.json away', async (t) => {
  // keys.json is corrupt (cut off) and large, so that reading it takes a while. A read that started while the
  // save was reading the same corrupt file finishes after the save, and then moves "the corrupt file" to .bak.
  const root = await tempDir(t);
  const junk = `{"junk":"${'x'.repeat(48 * 1024 * 1024)}`;
  let count = 0;
  const trial = async (delayMs) => {
    const dataDir = path.join(root, `trial-${count++}`);
    await mkdir(dataDir);
    try {
      const { secrets, keysFile } = make(dataDir);
      await writeFile(keysFile, junk, { mode: 0o600 });
      const started = performance.now();
      const saving = secrets.set('anthropic', DUMMY).then(() => performance.now() - started);
      let reading = null;
      if (delayMs !== null) {
        while (performance.now() - started < delayMs) await nextTick();
        reading = secrets.get('gemini');
      }
      const [took] = await Promise.all([saving, reading]);
      return { took, value: await secrets.get('anthropic'), files: (await readdir(dataDir)).sort() };
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  };

  const { took, value } = await trial(null);
  assert.equal(value, DUMMY);
  for (const part of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    const result = await trial(Math.min(took, 2000) * part);
    // was: null. The saved key sat in keys.json.bak, and the list said "set".
    assert.equal(result.value, DUMMY, `the saved key is gone (the read started at ${part * 100} % of the save)`);
    assert.deepEqual(result.files, ['keys-meta.json', 'keys.json', 'keys.json.bak']);
  }
});

test('file: the first load of a second instance leaves a running save alone', async (t) => {
  const dataDir = await tempDir(t);
  const first = make(dataDir).secrets;
  await first.list();
  for (let round = 0; round < 5; round++) {
    let running = true;
    const saving = first.set('anthropic', `${DUMMY}-${round}`).then(() => null, (err) => err).finally(() => { running = false; });
    const others = [];
    while (running && others.length < 500) {
      others.push(make(dataDir).secrets.list()); // its first load removes "temp files left by a crash"
      await nextTick();
    }
    await Promise.all(others);
    // was: ENOENT on rename. The other instance had deleted the temp file of the save.
    assert.equal(await saving, null);
    assert.equal(await first.get('anthropic'), `${DUMMY}-${round}`);
  }
  assert.deepEqual((await readdir(dataDir)).sort(), ['keys-meta.json', 'keys.json']);
});

// ---------------------------------------------------------------------------------------------------------
// Data files
// ---------------------------------------------------------------------------------------------------------

test('file: a folder in the place of a data file gives a plain error, and no advice that cannot work', async (t) => {
  const root = await tempDir(t);
  const keysIsFolder = make(path.join(root, 'one'));
  await mkdir(keysIsFolder.keysFile, { recursive: true });
  // was: "keys.json is open to other users (mode 755). Run: chmod 600 ..."
  for (const call of [(s) => s.get('anthropic'), (s) => s.set('anthropic', DUMMY), (s) => s.envFor('claude')]) {
    await refused(call(keysIsFolder.secrets), /keys\.json is not a file/, { status: 500 });
  }
  assert.deepEqual(await keysIsFolder.secrets.list(), KNOWN_UNSET);

  const metaIsFolder = make(path.join(root, 'two'));
  await mkdir(metaIsFolder.metaFile, { recursive: true });
  // was: "EISDIR: illegal operation on a directory, read", without a status
  for (const call of [(s) => s.list(), (s) => s.set('anthropic', DUMMY), (s) => s.remove('anthropic')]) {
    await refused(call(metaIsFolder.secrets), /keys-meta\.json is not a file/, { status: 500 });
  }
  assert.equal(await metaIsFolder.secrets.get('anthropic'), null); // reading values needs no metadata
  assert.deepEqual(await readdir(path.join(root, 'two')), ['keys-meta.json']); // nothing was written next to it
});

// ---------------------------------------------------------------------------------------------------------
// Argument shapes
// ---------------------------------------------------------------------------------------------------------

test('set: an env var that is left out or sent empty is not an error', async (t) => {
  const { secrets } = make(await tempDir(t));
  // The UI sends the empty fields of its form: PUT /api/keys/:id { value, label: '', envVar: '' }.
  const entry = await secrets.set('anthropic', DUMMY, { label: '', envVar: '' }); // was: refused ("always uses ANTHROPIC_API_KEY")
  assert.deepEqual([entry.label, entry.envVar, entry.hint], ['Anthropic', 'ANTHROPIC_API_KEY', '3456']);
  await secrets.set('my-tool', DUMMY, { envVar: 'MY_TOOL_KEY' });
  assert.equal((await secrets.set('my-tool', DUMMY2, { label: '', envVar: '' })).envVar, 'MY_TOOL_KEY'); // was: refused

  // The contract makes envVar optional, and the UI saves a row with { value } only. A new custom key gets the
  // usual name for its id. "typesafe" is a known key since the review (A35), with its fixed TYPESAFE_API_KEY.
  assert.equal((await secrets.set('typesafe', DUMMY)).envVar, 'TYPESAFE_API_KEY'); // was: refused
  assert.equal((await secrets.set('new-tool', DUMMY, { envVar: '' })).envVar, 'NEW_TOOL_API_KEY'); // was: refused

  // a usual name that another key has, or that is no valid name, is refused with a plain message
  await secrets.set('first', DUMMY, { envVar: 'SECOND_API_KEY' });
  await refused(secrets.set('second', DUMMY), /already used by the key "first"/);
  await refused(secrets.set('9-lives', DUMMY), /custom key needs an environment variable/);
  await refused(secrets.set('my-tool', DUMMY, { envVar: ' ' }), /environment variable must look like MY_API_KEY/);
  await refused(secrets.set('anthropic', DUMMY, { envVar: 'OTHER_KEY' }), /"anthropic" always uses ANTHROPIC_API_KEY/);
  assert.deepEqual(brief(await secrets.list()), rows({ anthropic: '3456', typesafe: '3456' },
    ['first', true, '3456'], ['my-tool', true, '4321'], ['new-tool', true, '3456']));
});
