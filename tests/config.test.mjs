import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, DEFAULT_SETTINGS, createSettings } from '../server/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let dir;
let configDir;
let file;
let logs;
const log = (level, msg, data) => logs.push({ level, msg, data });
const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-config-'));
  configDir = path.join(dir, 'config');
  file = path.join(configDir, 'settings.json');
  logs = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('paths', () => {
  test('root defaults to the folder that contains server/', () => {
    const p = paths();
    assert.equal(p.root, repoRoot);
    assert.deepEqual(p, {
      root: repoRoot,
      server: path.join(repoRoot, 'server'),
      ui: path.join(repoRoot, 'ui'),
      config: path.join(repoRoot, 'config'),
      data: path.join(repoRoot, 'data'),
      logs: path.join(repoRoot, 'data', 'logs'),
      run: path.join(repoRoot, 'data', 'run'),
      work: path.join(repoRoot, 'data', 'work'),
      projects: path.join(repoRoot, 'projects'),
    });
  });

  test('root moves every folder', () => {
    const p = paths({ root: dir });
    assert.equal(p.root, dir);
    assert.equal(p.server, path.join(dir, 'server'));
    assert.equal(p.ui, path.join(dir, 'ui'));
    assert.equal(p.config, path.join(dir, 'config'));
    assert.equal(p.data, path.join(dir, 'data'));
    assert.equal(p.projects, path.join(dir, 'projects'));
  });

  test('dataDir moves data, logs, run and work only', () => {
    const data = path.join(dir, 'd');
    const p = paths({ dataDir: data });
    assert.equal(p.data, data);
    assert.equal(p.logs, path.join(data, 'logs'));
    assert.equal(p.run, path.join(data, 'run'));
    assert.equal(p.work, path.join(data, 'work'));
    assert.equal(p.root, repoRoot);
    assert.equal(p.ui, path.join(repoRoot, 'ui'));
    assert.equal(p.projects, path.join(repoRoot, 'projects'));
  });

  test('projectsDir and configDir override one folder each', () => {
    const p = paths({ projectsDir: path.join(dir, 'p'), configDir: path.join(dir, 'c') });
    assert.equal(p.projects, path.join(dir, 'p'));
    assert.equal(p.config, path.join(dir, 'c'));
    assert.equal(p.data, path.join(repoRoot, 'data'));
  });

  test('relative folders become absolute', () => {
    const p = paths({ root: 'some/rel', dataDir: 'other/data' });
    assert.ok(path.isAbsolute(p.root));
    assert.ok(path.isAbsolute(p.data));
    assert.equal(p.data, path.resolve('other/data'));
  });
});

describe('DEFAULT_SETTINGS', () => {
  test('holds the contract values', () => {
    assert.deepEqual(DEFAULT_SETTINGS, {
      crewPresets: {
        solo: { bosses: 1, managers: 0, makers: 2 },
        standard: { bosses: 1, managers: 1, makers: 4 },
        full: { bosses: 2, managers: 2, makers: 6 },
      },
      defaultCrew: 'standard',
      limits: {
        maxAgents: 6,
        perProvider: { claude: 2, gemini: 2, oss: 6, mock: 8 },
        maxReworks: 3,
        maxNudges: 2,
        maxRetries: 2,
        maxBlocks: 2,
        maxClaims: 5,
        maxReviewers: 2,
        maxQaRounds: 3,
        maxTasks: 40,
        maxTasksTotal: 60,
        turnTimeoutMin: 45,
        taskTimeoutMin: { S: 20, M: 45, L: 90 },
        idleTimeoutMin: 12,
        checkTimeoutMin: 10,
        holdFallbackMin: 20,
        maxFileMb: 1,
        maxDeliveryMb: 5,
        maxDeliveryFiles: 500,
        turnUsd: 5,
        rotateTok: { boss: 40000, manager: 40000, maker: 90000 },
        rotateGapMin: 5,
        rotateGapTok: 25000,
      },
      review: { reviewer: 'boss', crossLab: true, smallByManager: true },
      pairing: 'M+L',
      approvePlan: false,
      safety: 'sandboxed',
      thrift: 0.3,
      allowFallback: true,
      auth: { claude: null, gemini: null }, // contract 14b: null until the owner chooses
      authAck: { claude: null, gemini: null },
      selfTest: { claude: null, gemini: null },
      oss: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', standIn: false },
      presence: 'here',
      humanWaitMin: 30,
      budgetUsd: 20,
      board: {},
      ui: { sound: false, scanlines: false },
    });
  });

  test('is frozen all the way down', () => {
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS.limits.perProvider));
    assert.throws(() => {
      DEFAULT_SETTINGS.limits.maxAgents = 99;
    }, TypeError);
  });
});

describe('createSettings: load', () => {
  test('needs configDir', () => {
    assert.throws(() => createSettings({}), /configDir/);
  });

  test('missing file gives the defaults and writes nothing', () => {
    const settings = createSettings({ configDir, log });
    assert.deepEqual(settings.get(), DEFAULT_SETTINGS);
    assert.equal(fs.existsSync(configDir), false);
    assert.deepEqual(logs, []);
  });

  test('file values merge deep over the defaults and unknown keys stay', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      thrift: 0.9,
      limits: { maxAgents: 2, perProvider: { claude: 1, codex: 3 } },
      crewPresets: { huge: { bosses: 4, managers: 4, makers: 12 } },
      plugin: { enabled: true, list: [1, 2] },
    }));
    const s = createSettings({ configDir, log }).get();
    assert.equal(s.thrift, 0.9);
    assert.equal(s.limits.maxAgents, 2);
    assert.equal(s.limits.maxReworks, 3);
    assert.deepEqual(s.limits.perProvider, { claude: 1, gemini: 2, oss: 6, mock: 8, codex: 3 });
    assert.deepEqual(s.crewPresets.huge, { bosses: 4, managers: 4, makers: 12 });
    assert.deepEqual(s.crewPresets.solo, DEFAULT_SETTINGS.crewPresets.solo);
    assert.deepEqual(s.plugin, { enabled: true, list: [1, 2] });
    assert.equal(s.defaultCrew, 'standard');
  });

  test('corrupt file: defaults, a .bak copy, and a warning', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, '{ "thrift": 0.9, ');
    const settings = createSettings({ configDir, log });
    assert.deepEqual(settings.get(), DEFAULT_SETTINGS);
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{ "thrift": 0.9, ');
    assert.equal(fs.existsSync(file), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warn');
    assert.match(logs[0].msg, /corrupt/);
    assert.equal(logs[0].data.kept, `${file}.bak`);
    // The next save writes a good file again.
    settings.update({ thrift: 0.5 });
    assert.equal(readFile().thrift, 0.5);
    assert.equal(createSettings({ configDir, log }).get().thrift, 0.5);
  });

  test('a file that is not a JSON object counts as corrupt', () => {
    fs.mkdirSync(configDir, { recursive: true });
    for (const text of ['[1,2,3]', 'null', '"hello"', '']) {
      fs.writeFileSync(file, text);
      logs = [];
      assert.deepEqual(createSettings({ configDir, log }).get(), DEFAULT_SETTINGS, text);
      assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), text);
      assert.equal(logs[0].level, 'warn');
    }
  });

  test('a wrong type in the file is ignored with a warning', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ limits: 5, thrift: 'lots', ui: { sound: 'yes' }, auth: null, defaultCrew: 'solo' }));
    const settings = createSettings({ configDir, log });
    const s = settings.get();
    assert.deepEqual(s.limits, DEFAULT_SETTINGS.limits);
    assert.equal(s.thrift, 0.3);
    assert.equal(s.ui.sound, false);
    assert.deepEqual(s.auth, DEFAULT_SETTINGS.auth);
    assert.equal(s.defaultCrew, 'solo');
    const warned = logs.filter((l) => l.level === 'warn').map((l) => l.msg).join('\n');
    for (const key of ['limits', 'thrift', 'ui.sound', 'auth']) assert.match(warned, new RegExp(`ignored ${key} `));
    assert.equal(fs.existsSync(`${file}.bak`), false);
    // The next save drops the bad values from the file.
    settings.update({ approvePlan: true });
    assert.deepEqual(readFile(), { defaultCrew: 'solo', approvePlan: true });
  });

  test('works with the default no-op logger', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, 'not json');
    assert.deepEqual(createSettings({ configDir }).get(), DEFAULT_SETTINGS);
  });

  test('a logger that throws does not break load, update or listeners', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, 'not json');
    const settings = createSettings({
      configDir,
      log: () => {
        throw new Error('logger down');
      },
    });
    settings.onChange(() => {
      throw new Error('boom');
    });
    assert.equal(settings.update({ thrift: 0.4 }).thrift, 0.4);
    assert.equal(readFile().thrift, 0.4);
  });
});

describe('createSettings: update', () => {
  test('deep merges, returns the new settings and saves them', () => {
    const settings = createSettings({ configDir, log });
    const out = settings.update({ limits: { maxAgents: 3, perProvider: { gemini: 1 } }, approvePlan: true });
    assert.deepEqual(out, settings.get());
    assert.equal(out.limits.maxAgents, 3);
    assert.equal(out.limits.turnTimeoutMin, 45);
    assert.deepEqual(out.limits.perProvider, { claude: 2, gemini: 1, oss: 6, mock: 8 });
    assert.equal(out.approvePlan, true);
    assert.deepEqual(out.crewPresets, DEFAULT_SETTINGS.crewPresets);
    assert.equal(DEFAULT_SETTINGS.limits.maxAgents, 6);
  });

  test('the file holds only what differs from the defaults', () => {
    const settings = createSettings({ configDir, log });
    settings.update({ thrift: 0.8, limits: { maxAgents: 6, perProvider: { codex: 2 } }, extra: {} });
    assert.deepEqual(readFile(), { thrift: 0.8, limits: { perProvider: { codex: 2 } }, extra: {} });
    settings.update({ thrift: 0.3 }); // back to the default
    assert.deepEqual(readFile(), { limits: { perProvider: { codex: 2 } }, extra: {} });
    const again = createSettings({ configDir, log }).get();
    assert.equal(again.thrift, 0.3);
    assert.deepEqual(again.limits.perProvider, { claude: 2, gemini: 2, oss: 6, mock: 8, codex: 2 });
    assert.deepEqual(again.extra, {});
  });

  test('settings survive a reload', () => {
    createSettings({ configDir, log }).update({ safety: 'trusting', auth: { gemini: 'apikey' }, extra: { a: { b: 1 } } });
    const again = createSettings({ configDir, log });
    assert.equal(again.get().safety, 'trusting');
    assert.deepEqual(again.get().auth, { claude: null, gemini: 'apikey' });
    assert.deepEqual(again.get().extra, { a: { b: 1 } });
    again.update({ extra: { a: { c: 2 } } });
    assert.deepEqual(createSettings({ configDir, log }).get().extra, { a: { b: 1, c: 2 } });
  });

  test('null replaces a value, lists replace whole, undefined is skipped', () => {
    const settings = createSettings({ configDir, log });
    assert.equal(settings.update({ budgetUsd: 25 }).budgetUsd, 25);
    assert.equal(settings.update({ budgetUsd: null }).budgetUsd, null);
    assert.deepEqual(settings.update({ tags: ['a', 'b', 'c'] }).tags, ['a', 'b', 'c']);
    assert.deepEqual(settings.update({ tags: ['z'] }).tags, ['z']);
    assert.equal(settings.update({ tags: null }).tags, null);
    assert.equal(settings.update({ thrift: undefined, hook: () => 1 }).thrift, 0.3);
    assert.equal('hook' in settings.get(), false);
  });

  test('get() and update() hand out private copies', () => {
    const settings = createSettings({ configDir, log });
    const before = settings.get();
    const patch = { limits: { perProvider: { claude: 1 } }, custom: { list: [1] } };
    const after = settings.update(patch);
    assert.equal(before.limits.perProvider.claude, 2); // an old copy does not change
    after.limits.maxAgents = 1; // a caller may change its own copy
    after.custom.list.push(9);
    settings.get().crewPresets.solo.makers = 99;
    patch.custom.list.push(2); // the caller's patch object is not kept
    assert.notEqual(settings.get(), settings.get());
    assert.equal(settings.get().limits.maxAgents, 6);
    assert.equal(settings.get().limits.perProvider.claude, 1);
    assert.deepEqual(settings.get().custom.list, [1]);
    assert.equal(settings.get().crewPresets.solo.makers, 2);
    assert.equal(DEFAULT_SETTINGS.crewPresets.solo.makers, 2);
  });

  test('a wrong type is refused with status 400 and nothing changes', () => {
    const settings = createSettings({ configDir, log });
    const bad = [
      [{ limits: 'many' }, /settings\.limits must be an object/],
      [{ limits: { maxAgents: '6' } }, /settings\.limits\.maxAgents must be a number/],
      [{ limits: { perProvider: [1] } }, /settings\.limits\.perProvider must be an object/],
      [{ thrift: Number.NaN }, /settings\.thrift must be a number/],
      [{ approvePlan: 'no' }, /settings\.approvePlan must be a boolean/],
      [{ defaultCrew: null }, /settings\.defaultCrew must be a string/],
      [{ ui: null }, /settings\.ui must be an object/],
    ];
    for (const [patch, pattern] of bad) {
      assert.throws(() => settings.update(patch), (err) => err.status === 400 && pattern.test(err.message), JSON.stringify(patch));
    }
    for (const patch of [null, undefined, 'x', 5, [1]]) {
      assert.throws(() => settings.update(patch), (err) => err.status === 400 && /must be an object/.test(err.message));
    }
    const loop = {};
    loop.self = loop;
    assert.throws(() => settings.update(loop), (err) => err.status === 400 && /plain JSON/.test(err.message));
    assert.deepEqual(settings.get(), DEFAULT_SETTINGS);
    assert.equal(fs.existsSync(file), false);
  });

  test('a patch cannot reach Object.prototype', () => {
    const settings = createSettings({ configDir, log });
    settings.update(JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"ok":1}'));
    assert.equal({}.polluted, undefined);
    assert.equal(settings.get().ok, 1);
    assert.equal(Object.hasOwn(settings.get(), '__proto__'), false);
    assert.equal(Object.hasOwn(settings.get(), 'constructor'), false);
  });

  test('save is atomic: valid JSON after many updates, no temp files left', () => {
    const settings = createSettings({ configDir, log });
    for (let i = 0; i < 50; i += 1) settings.update({ counter: i });
    assert.equal(readFile().counter, 49);
    assert.deepEqual(fs.readdirSync(configDir), ['settings.json']);
  });

  test('a patch that changes nothing does not save or notify', () => {
    const settings = createSettings({ configDir, log });
    let calls = 0;
    settings.onChange(() => {
      calls += 1;
    });
    const same = settings.update({ thrift: 0.3, limits: { maxAgents: 6 } });
    assert.deepEqual(same, DEFAULT_SETTINGS);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(file), false);
  });

  test('a failed save throws and keeps the old settings', () => {
    fs.writeFileSync(path.join(dir, 'blocker'), 'a file, not a folder');
    const settings = createSettings({ configDir: path.join(dir, 'blocker', 'config'), log });
    let calls = 0;
    settings.onChange(() => {
      calls += 1;
    });
    assert.throws(() => settings.update({ thrift: 0.8 }));
    assert.equal(settings.get().thrift, 0.3);
    assert.equal(calls, 0);
  });
});

describe('createSettings: onChange', () => {
  test('listeners get (settings, previous) after the save; unsubscribe works', () => {
    const settings = createSettings({ configDir, log });
    const seen = [];
    const off = settings.onChange((now, before) => seen.push({ now: now.thrift, before: before.thrift, onDisk: readFile().thrift }));
    settings.update({ thrift: 0.6 });
    assert.deepEqual(seen, [{ now: 0.6, before: 0.3, onDisk: 0.6 }]);
    off();
    off(); // twice is fine
    settings.update({ thrift: 0.7 });
    assert.equal(seen.length, 1);
    assert.throws(() => settings.onChange('nope'), TypeError);
  });

  test('a listener that throws does not break update or other listeners', () => {
    const settings = createSettings({ configDir, log });
    let reached = 0;
    settings.onChange(() => {
      throw new Error('boom');
    });
    settings.onChange(() => {
      reached += 1;
    });
    const out = settings.update({ allowFallback: false });
    assert.equal(out.allowFallback, false);
    assert.equal(reached, 1);
    assert.equal(readFile().allowFallback, false);
    const errors = logs.filter((l) => l.level === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].data.error, 'boom');
  });

  test('a listener may update again or unsubscribe during a change; order is kept', () => {
    const settings = createSettings({ configDir, log });
    const order = [];
    const off = settings.onChange((now, before) => {
      order.push(`a:${before.step}>${now.step}`);
      off();
      if (now.step === 1) settings.update({ step: 2 });
    });
    settings.onChange((now, before) => order.push(`b:${before.step}>${now.step}`));
    settings.update({ step: 1 });
    assert.equal(settings.get().step, 2);
    assert.deepEqual(order, ['a:undefined>1', 'b:undefined>1', 'b:1>2']);
  });

  test('a listener removed by an earlier listener is not called', () => {
    const settings = createSettings({ configDir, log });
    const order = [];
    let offSecond = () => {};
    settings.onChange(() => {
      order.push('first');
      offSecond();
    });
    offSecond = settings.onChange(() => order.push('second'));
    settings.update({ step: 1 });
    assert.deepEqual(order, ['first']);
  });
});
