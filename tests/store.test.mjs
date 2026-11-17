import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

let dir;
let logs;
let stores;
const log = (level, msg, data) => logs.push({ level, msg, data });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateFile = () => path.join(dir, 'state.json');
const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
const readEvents = (name = 'events.jsonl') =>
  fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** Open a store on the temp dir. Every store is flushed before the dir is removed. */
function open(opts = {}) {
  const store = createStore({ dataDir: dir, log, saveDelayMs: 20, ...opts });
  stores.push(store);
  return store;
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await sleep(5);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-store-'));
  logs = [];
  stores = [];
});

afterEach(async () => {
  for (const store of stores) await store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('store: state and ids', () => {
  test('needs dataDir', () => {
    assert.throws(() => createStore({}), /dataDir/);
  });

  test('starts clean, creates the data dir, writes nothing yet', () => {
    dir = path.join(dir, 'nested', 'data');
    const store = open();
    assert.deepEqual(store.state, {
      v: 1, seq: 0, counters: { P: 0, J: 0, T: 0, A: 0, D: 0 }, projects: {}, jobs: {}, tasks: {}, agents: {}, deliveries: {},
    });
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(logs, []);
    dir = path.dirname(path.dirname(dir));
  });

  test('nextId counts per kind', () => {
    const store = open();
    assert.deepEqual(['P', 'P', 'J', 'T', 'A', 'D', 'T'].map((kind) => store.nextId(kind)), ['P1', 'P2', 'J1', 'T1', 'A1', 'D1', 'T2']);
    assert.equal(store.nextId('tasks'), 'T3'); // a collection name works too
    assert.equal(store.nextId('R'), 'R1'); // other modules may count their own kinds
    assert.equal(store.state.counters.T, 3);
    for (const bad of ['', 'x', 'toString', 'constructor', '__proto__', 'TOOLONG', 5, null, undefined]) {
      assert.throws(() => store.nextId(bad), TypeError, String(bad));
    }
  });
});

describe('store: entities', () => {
  test('put upserts by id, sets the times, get returns the live object', async () => {
    const store = open();
    const task = { id: 'T1', title: 'first' };
    const before = Date.now();
    assert.equal(store.put('tasks', task), task);
    assert.equal(store.get('tasks', 'T1'), task);
    assert.equal(store.state.tasks.T1, task);
    assert.ok(task.updatedAt >= before && task.createdAt === task.updatedAt);
    await sleep(3);
    const replaced = store.put('tasks', { id: 'T1', title: 'second', createdAt: 5 });
    assert.equal(store.get('tasks', 'T1'), replaced);
    assert.equal(replaced.createdAt, 5);
    assert.ok(replaced.updatedAt > task.updatedAt);
    assert.equal(store.list('tasks').length, 1);
  });

  test('put refuses a bad kind or a bad item', () => {
    const store = open();
    assert.throws(() => store.put('widgets', { id: 'W1' }), /unknown kind/);
    assert.throws(() => store.put('seq', { id: 'W1' }), /unknown kind/);
    for (const bad of [null, 'T1', [], {}, { id: 7 }, { id: '' }, { id: '__proto__' }]) {
      assert.throws(() => store.put('tasks', bad), TypeError);
    }
    assert.deepEqual(store.state.tasks, {});
    assert.equal(store.state.seq, 0);
  });

  test('patch merges shallow into the live object and throws for an unknown id', async () => {
    const store = open();
    const task = store.put('tasks', { id: 'T1', title: 'a', cost: { usd: 1 }, status: 'ready' });
    const stamp = task.updatedAt;
    await sleep(3);
    const out = store.patch('tasks', 'T1', { status: 'working', cost: { usd: 2 } });
    assert.equal(out, task);
    assert.deepEqual({ title: task.title, status: task.status, cost: task.cost }, { title: 'a', status: 'working', cost: { usd: 2 } });
    assert.ok(task.updatedAt > stamp);
    assert.equal(store.patch('tasks', 'T1', { id: 'T1' }), task);
    assert.equal(store.patch('tasks', 'T1'), task);
    assert.throws(() => store.patch('tasks', 'T9', { status: 'x' }), (err) => err.status === 404 && /T9/.test(err.message));
    assert.throws(() => store.patch('tasks', 'T1', { id: 'T2' }), /id of an item cannot change/);
    assert.throws(() => store.patch('tasks', 'T1', 'nope'), TypeError);
    store.patch('tasks', 'T1', JSON.parse('{"__proto__":{"polluted":true},"ok":1}'));
    assert.equal(task.polluted, undefined);
    assert.equal(task.ok, 1);
  });

  test('get, list and remove', () => {
    const store = open();
    for (const n of [1, 2, 3]) store.put('agents', { id: `A${n}`, jobId: n === 2 ? 'J2' : 'J1' });
    assert.equal(store.get('agents', 'A9'), null);
    assert.equal(store.get('agents', 'toString'), null);
    assert.throws(() => store.get('nope', 'A1'), /unknown kind/);
    assert.deepEqual(store.list('agents').map((a) => a.id), ['A1', 'A2', 'A3']);
    assert.deepEqual(store.list('agents', (a) => a.jobId === 'J1').map((a) => a.id), ['A1', 'A3']);
    assert.notEqual(store.list('agents'), store.list('agents'));
    assert.equal(store.remove('agents', 'A2'), true);
    assert.equal(store.remove('agents', 'A2'), false);
    assert.equal(store.get('agents', 'A2'), null);
    assert.deepEqual(store.list('agents').map((a) => a.id), ['A1', 'A3']);
    assert.deepEqual(store.list('jobs'), []);
  });
});

describe('store: events', () => {
  test('put emits upsert after the state is updated', () => {
    const store = open();
    const seen = [];
    store.subscribe((event) => {
      seen.push(event);
      assert.equal(store.get(event.kind, event.item.id), event.item); // the state already holds the item
      assert.equal(store.state.seq, event.seq);
    });
    const job = store.put('jobs', { id: 'J1', title: 'build' });
    store.patch('jobs', 'J1', { status: 'running' });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((e) => [e.type, e.kind, e.seq]), [['upsert', 'jobs', 1], ['upsert', 'jobs', 2]]);
    assert.equal(seen[0].item, job);
    assert.equal(typeof seen[0].ts, 'number');
    assert.deepEqual(logs, []);
  });

  test('remove emits remove only for a known id', () => {
    const store = open();
    store.put('tasks', { id: 'T1' });
    const seen = [];
    store.subscribe((event) => seen.push(event));
    store.remove('tasks', 'T1');
    store.remove('tasks', 'T1');
    assert.equal(seen.length, 1);
    assert.deepEqual({ type: seen[0].type, kind: seen[0].kind, id: seen[0].id, seq: seen[0].seq }, { type: 'remove', kind: 'tasks', id: 'T1', seq: 2 });
  });

  test('emit adds seq and ts, protects them, and returns a frozen event', () => {
    const store = open();
    const seen = [];
    const off = store.subscribe((event) => seen.push(event));
    const before = Date.now();
    const first = store.emit('notice', { level: 'info', text: 'hi', jobId: null });
    const second = store.emit('fx', { name: 'ship', payload: { a: 1 }, type: 'fake', seq: 99, ts: 1 });
    const third = store.emit('ping');
    assert.deepEqual(first, { type: 'notice', seq: 1, ts: first.ts, level: 'info', text: 'hi', jobId: null });
    assert.ok(first.ts >= before);
    assert.deepEqual([second.type, second.seq, second.name], ['fx', 2, 'ship']);
    assert.ok(second.ts >= before);
    assert.deepEqual(Object.keys(third), ['type', 'seq', 'ts']);
    assert.ok(Object.isFrozen(first));
    assert.deepEqual(seen, [first, second, third]);
    assert.equal(store.state.seq, 3);
    for (const bad of ['', null, undefined, 5]) assert.throws(() => store.emit(bad, {}), TypeError);
    off();
    off();
    store.emit('ping');
    assert.equal(seen.length, 3);
    assert.throws(() => store.subscribe('nope'), TypeError);
  });

  test('a subscriber that throws does not break the store or other subscribers', async () => {
    const store = open();
    const seen = [];
    store.subscribe(() => {
      throw new Error('sync boom');
    });
    store.subscribe(async () => {
      throw new Error('async boom');
    });
    store.subscribe((event) => seen.push(event.type));
    const item = store.put('tasks', { id: 'T1' });
    store.emit('notice', { text: 'still alive' });
    assert.equal(store.get('tasks', 'T1'), item);
    assert.deepEqual(seen, ['upsert', 'notice']);
    await sleep(5); // lets the rejected promises settle
    const errors = logs.filter((l) => l.level === 'error');
    assert.equal(errors.length, 4);
    assert.ok(errors.every((l) => /subscriber failed/.test(l.msg)));
    assert.match(errors.map((l) => l.data.error).join('\n'), /sync boom[\s\S]*async boom/);
  });

  test('events reach every subscriber in seq order when a subscriber changes the store', () => {
    const store = open();
    const first = [];
    const second = [];
    store.subscribe((event) => {
      first.push(event.seq);
      if (event.type === 'upsert' && event.item.status === 'new') {
        store.patch('tasks', event.item.id, { status: 'seen' });
        store.emit('notice', { text: 'reacted' });
      }
    });
    store.subscribe((event) => second.push(`${event.seq}:${event.type}`));
    store.put('tasks', { id: 'T1', status: 'new' });
    assert.deepEqual(first, [1, 2, 3]);
    assert.deepEqual(second, ['1:upsert', '2:upsert', '3:notice']);
  });

  test('a subscriber may unsubscribe another one during delivery', () => {
    const store = open();
    const seen = [];
    let offSecond = () => {};
    store.subscribe(() => {
      seen.push('first');
      offSecond();
    });
    offSecond = store.subscribe(() => seen.push('second'));
    store.emit('ping');
    store.emit('ping');
    assert.deepEqual(seen, ['first', 'first']);
  });

  test('eventsSince returns the newer events; the ring keeps the last 5000', () => {
    const store = open();
    for (let i = 0; i < 12; i += 1) store.emit('tick', { i }, { persist: false });
    assert.deepEqual(store.eventsSince(9).map((e) => e.seq), [10, 11, 12]);
    assert.equal(store.eventsSince(0).length, 12);
    assert.deepEqual(store.eventsSince(12), []);
    assert.deepEqual(store.eventsSince(500), []);
    assert.deepEqual(store.eventsSince('10').map((e) => e.i), [10, 11]);
    for (const bad of [undefined, null, 'abc', Number.NaN]) {
      assert.deepEqual(store.eventsSince(bad).length, bad === null ? 12 : 0, String(bad));
    }
    for (let i = 12; i < 5200; i += 1) store.emit('tick', { i }, { persist: false });
    const all = store.eventsSince(0);
    assert.equal(all.length, 5000);
    assert.equal(all[0].seq, 201);
    assert.equal(all.at(-1).seq, 5200);
    assert.deepEqual(store.eventsSince(5198).map((e) => e.seq), [5199, 5200]);
    assert.equal(store.stats().buffered, 5000);
  });

  test('a small ring wraps around in order', () => {
    const store = open({ ringSize: 4 });
    for (let i = 1; i <= 11; i += 1) store.emit('tick', {}, { persist: false });
    assert.deepEqual(store.eventsSince(0).map((e) => e.seq), [8, 9, 10, 11]);
    assert.deepEqual(store.eventsSince(9).map((e) => e.seq), [10, 11]);
  });
});

describe('store: persistence', () => {
  test('saves are debounced: many changes, one write', async () => {
    const store = open({ saveDelayMs: 60 });
    for (let i = 1; i <= 100; i += 1) store.put('tasks', { id: store.nextId('T'), n: i });
    assert.equal(fs.existsSync(stateFile()), false); // nothing is written inside the debounce window
    assert.equal(store.stats().saves, 0);
    await until(() => store.stats().saves === 1);
    await sleep(150);
    assert.equal(store.stats().saves, 1);
    const saved = readState();
    assert.equal(Object.keys(saved.tasks).length, 100);
    assert.equal(saved.counters.T, 100);
    assert.equal(saved.seq, 100);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['events.jsonl', 'ids.json', 'state.json']); // no temp file is left
    store.patch('tasks', 'T1', { n: 0 });
    await until(() => store.stats().saves === 2);
    assert.equal(readState().tasks.T1.n, 0);
  });

  test('flush saves now and a new store loads the same state', async () => {
    const store = open({ saveDelayMs: 60000 });
    const project = store.put('projects', { id: store.nextId('P'), name: 'demo', path: '/tmp/demo' });
    const job = store.put('jobs', { id: store.nextId('J'), projectId: project.id, requirements: [{ id: 'R1', text: 'works' }] });
    store.put('tasks', { id: store.nextId('T'), jobId: job.id });
    store.put('tasks', { id: store.nextId('T'), jobId: job.id });
    store.remove('tasks', 'T1');
    await store.flush();
    assert.equal(store.stats().saves, 1);
    assert.equal(store.stats().dirty, false);
    const copy = JSON.parse(JSON.stringify(store.state));

    const again = open();
    assert.deepEqual({ ...again.state, seq: 0 }, { ...copy, seq: 0 });
    assert.deepEqual(again.get('jobs', 'J1'), copy.jobs.J1);
    assert.equal(again.get('tasks', 'T1'), null);
    assert.equal(again.nextId('T'), 'T3');
    assert.equal(again.nextId('P'), 'P2');
    assert.deepEqual(logs, []);
  });

  // Review A17: the orchestrator awaits flush() after an accepted DONE, a verdict, an integrate and a ship.
  test('A17: after await flush() the last patch is in state.json and its event in events.jsonl, also mid-save', async () => {
    const store = open({ saveDelayMs: 60000 });
    store.put('deliveries', { id: 'D1', status: 'checking' });
    const first = store.flush(); // a save is on its way
    store.patch('deliveries', 'D1', { status: 'review' }); // the accepted DONE lands during that save
    store.emit('notice', { level: 'info', text: 'hand-in accepted', jobId: null });
    await first;
    store.patch('deliveries', 'D1', { status: 'approved', mergeSha: 'abc123' }); // the accepted verdict
    const seq = store.state.seq;
    await store.flush();
    assert.deepEqual([readState().deliveries.D1.status, readState().deliveries.D1.mergeSha], ['approved', 'abc123']);
    assert.ok(readState().seq >= seq);
    const events = readEvents();
    assert.equal(events.at(-1).seq, seq);
    assert.deepEqual([events.at(-1).type, events.at(-1).item.status], ['upsert', 'approved']);
    assert.ok(events.some((e) => e.type === 'notice' && e.text === 'hand-in accepted'));
    assert.equal(store.stats().dirty, false);
  });

  test('flush with nothing to save writes nothing and can be called again', async () => {
    const store = open();
    await store.flush();
    await store.flush();
    assert.deepEqual(fs.readdirSync(dir), []);
    store.put('tasks', { id: 'T1' });
    await Promise.all([store.flush(), store.flush()]);
    await store.flush();
    assert.equal(store.stats().saves, 1);
  });

  test('a change made during a save is saved too', async () => {
    const store = open({ saveDelayMs: 60000 });
    store.put('tasks', { id: 'T1' });
    const first = store.flush();
    store.put('tasks', { id: 'T2' });
    await first;
    await store.flush();
    assert.deepEqual(Object.keys(readState().tasks), ['T1', 'T2']);
  });

  test('seq never goes back after a restart, also with events that changed no state', async () => {
    const store = open();
    store.put('tasks', { id: 'T1' });
    await store.flush();
    for (let i = 0; i < 40; i += 1) store.emit('agentlog', { agentId: 'A1', lines: [] }, { persist: false });
    const last = store.state.seq;
    await store.flush(); // a clean shutdown stores the exact seq
    assert.equal(readState().seq, last);

    const again = open();
    assert.ok(again.state.seq > last);
    assert.ok(again.emit('ping').seq > last);
    await until(() => again.stats().saves === 1); // the jump goes to disk without a state change
    assert.ok(readState().seq >= again.state.seq - 1);
  });

  test('the seq on disk follows a long run of transient events', async () => {
    const store = open();
    for (let i = 0; i < 600; i += 1) store.emit('agentlog', { agentId: 'A1', lines: [] }, { persist: false });
    await until(() => store.stats().saves === 1);
    assert.ok(readState().seq >= 500);
  });

  test('corrupt state.json: clean start, state.json.bak kept, warning logged', async () => {
    fs.writeFileSync(stateFile(), '{"v":1,"seq":12,"tasks":{"T1":');
    const store = open();
    assert.deepEqual(store.state.tasks, {});
    assert.equal(store.state.seq, 0);
    assert.equal(fs.readFileSync(`${stateFile()}.bak`, 'utf8'), '{"v":1,"seq":12,"tasks":{"T1":');
    assert.equal(fs.existsSync(stateFile()), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warn');
    assert.match(logs[0].msg, /corrupt/);
    assert.equal(logs[0].data.kept, `${stateFile()}.bak`);
    store.put('tasks', { id: store.nextId('T') });
    await store.flush();
    assert.deepEqual(Object.keys(readState().tasks), ['T1']);
    assert.ok(fs.existsSync(`${stateFile()}.bak`));
  });

  test('a state.json with the wrong shape counts as corrupt', () => {
    const bad = ['[]', 'null', '"text"', '', '{"tasks":[]}', '{"jobs":null}', '{"tasks":{"T1":{"id":"T2"}}}', '{"agents":{"A1":"x"}}'];
    for (const text of bad) {
      fs.writeFileSync(stateFile(), text);
      logs = [];
      const store = open();
      assert.deepEqual(store.list('tasks'), [], text);
      assert.equal(fs.readFileSync(`${stateFile()}.bak`, 'utf8'), text);
      assert.equal(logs.filter((l) => l.level === 'warn').length, 1, text);
    }
  });

  test('a readable state.json is repaired: missing parts, bad counters, unknown keys stay', async () => {
    fs.writeFileSync(stateFile(), JSON.stringify({
      seq: 7, counters: { T: 2, J: 'x', P: -1, R: 4 }, tasks: { T9: { id: 'T9' }, custom: { id: 'custom' } }, extra: { keep: true },
    }));
    const store = open();
    assert.deepEqual(logs, []);
    assert.equal(store.state.v, 1);
    assert.deepEqual(store.state.counters, { P: 0, J: 0, T: 9, A: 0, D: 0, R: 4 });
    assert.deepEqual(store.state.projects, {});
    assert.deepEqual(store.state.extra, { keep: true });
    assert.equal(store.nextId('T'), 'T10');
    assert.equal(store.nextId('R'), 'R5');
    assert.equal(store.get('tasks', 'custom').id, 'custom');
    assert.equal(fs.existsSync(`${stateFile()}.bak`), false);
    await store.flush();
    assert.deepEqual(readState().extra, { keep: true });
  });

  test('events.jsonl holds the persisted events in order, as they were when emitted', async () => {
    const store = open();
    store.emit('notice', { level: 'info', text: 'one', jobId: null });
    store.emit('agentlog', { agentId: 'A1', lines: [{ k: 'text', s: 'chatty' }] }, { persist: false });
    store.put('tasks', { id: 'T1', n: 1 });
    store.patch('tasks', 'T1', { n: 2 });
    store.remove('tasks', 'T1');
    store.emit('board', { msg: { id: 1, body: 'hello' } });
    await store.flush();
    const lines = readEvents();
    assert.deepEqual(lines.map((e) => `${e.seq}:${e.type}`), ['1:notice', '3:upsert', '4:upsert', '5:remove', '6:board']);
    assert.deepEqual(lines.slice(1, 3).map((e) => e.item.n), [1, 2]); // a later patch does not rewrite history
    assert.deepEqual(lines[4].msg, { id: 1, body: 'hello' });
    assert.ok(lines.every((e) => typeof e.ts === 'number'));

    const again = open();
    again.emit('notice', { text: 'after restart' });
    await again.flush();
    assert.deepEqual(readEvents().map((e) => e.type), ['notice', 'upsert', 'upsert', 'remove', 'board', 'notice']); // appended
  });

  test('events.jsonl rotates to events.1.jsonl when it passes the size limit', async () => {
    const store = open({ eventsMaxBytes: 1500 });
    const burst = (n) => {
      for (let i = 0; i < n; i += 1) store.emit('notice', { text: 'x'.repeat(40) });
    };
    burst(30); // about 2.5 kB: passes the limit
    await store.flush();
    assert.deepEqual(readEvents('events.1.jsonl').map((e) => e.seq), Array.from({ length: 30 }, (_, i) => i + 1));
    assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
    burst(5); // stays below the limit
    await store.flush();
    assert.deepEqual(readEvents().map((e) => e.seq), [31, 32, 33, 34, 35]);
    assert.equal(readEvents('events.1.jsonl').length, 30);
    burst(30); // passes it again: the old events.1.jsonl is replaced
    await store.flush();
    assert.deepEqual(readEvents('events.1.jsonl').map((e) => e.seq), Array.from({ length: 35 }, (_, i) => i + 31));
    assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
    assert.deepEqual(logs, []);
  });

  test('an event without a JSON form reaches subscribers but not the file', async () => {
    const store = open();
    const seen = [];
    store.subscribe((event) => seen.push(event.type));
    const loop = {};
    loop.self = loop;
    store.emit('fx', { name: 'loop', payload: loop });
    store.emit('notice', { text: 'fine' });
    await store.flush();
    assert.deepEqual(seen, ['fx', 'notice']);
    assert.deepEqual(readEvents().map((e) => e.type), ['notice']);
    assert.equal(logs.filter((l) => l.level === 'error').length, 1);
  });

  test('a failed save is logged, flush still resolves, and a later save works', async () => {
    const store = open();
    store.put('tasks', { id: 'T1' });
    await store.flush();
    fs.rmSync(dir, { recursive: true, force: true }); // the disk goes away
    store.put('tasks', { id: 'T2' });
    await store.flush(); // must not reject
    assert.equal(store.get('tasks', 'T2').id, 'T2');
    assert.ok(logs.some((l) => l.level === 'error' && /cannot save state\.json/.test(l.msg)));
    assert.ok(logs.some((l) => l.level === 'error' && /cannot write events\.jsonl/.test(l.msg)));
    assert.equal(store.stats().dirty, true);
    fs.mkdirSync(dir, { recursive: true }); // the disk is back
    await store.flush();
    assert.deepEqual(Object.keys(readState().tasks), ['T1', 'T2']);
    assert.equal(store.stats().dirty, false);
  });

  test('two stores on one folder never mix their writes', async () => {
    const a = open({ saveDelayMs: 1 });
    const b = open({ saveDelayMs: 1 });
    const filler = 'x'.repeat(2000);
    for (let round = 0; round < 25; round += 1) {
      for (let i = 0; i < 40; i += 1) {
        a.put('tasks', { id: `T${i}`, from: 'a', filler });
        b.put('tasks', { id: `T${i}`, from: 'b', filler });
      }
      await sleep(2);
      const text = fs.existsSync(stateFile()) ? fs.readFileSync(stateFile(), 'utf8') : '{"tasks":{}}';
      const owners = new Set(Object.values(JSON.parse(text).tasks).map((task) => task.from)); // always whole JSON
      assert.ok(owners.size <= 1, 'one snapshot holds the items of one store only');
    }
    await Promise.all([a.flush(), b.flush()]);
    assert.equal(Object.keys(readState().tasks).length, 40);
    assert.deepEqual(logs.filter((l) => l.level === 'error'), []);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  });

  test('temp files of a crashed save are removed at start, fresh ones stay', () => {
    const stale = path.join(dir, 'state.json.123.abcd.tmp');
    const legacy = path.join(dir, 'state.json.tmp');
    const fresh = path.join(dir, 'state.json.456.ef01.tmp');
    const other = path.join(dir, 'board.jsonl.tmp');
    for (const file of [stale, legacy, fresh, other]) fs.writeFileSync(file, '{');
    const old = new Date(Date.now() - 5 * 60 * 1000);
    for (const file of [stale, legacy, other]) fs.utimesSync(file, old, old);
    open();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['board.jsonl.tmp', 'state.json.456.ef01.tmp']);
    assert.deepEqual(logs, []);
  });

  test('works without a logger and with a logger that throws', async () => {
    fs.writeFileSync(stateFile(), 'not json');
    const quiet = createStore({ dataDir: dir });
    quiet.subscribe(() => {
      throw new Error('boom');
    });
    quiet.put('tasks', { id: 'T1' });
    await quiet.flush();
    fs.writeFileSync(stateFile(), 'not json');
    const noisy = createStore({
      dataDir: dir,
      log: () => {
        throw new Error('logger down');
      },
    });
    noisy.subscribe(() => {
      throw new Error('boom');
    });
    noisy.put('tasks', { id: 'T2' });
    await noisy.flush();
    assert.deepEqual(Object.keys(readState().tasks), ['T2']);
  });
});
