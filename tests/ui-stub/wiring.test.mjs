// The final wiring round (scratchpad api/final-wiring-spec.md): part U of the UI, and the stub hub held equal to part S.
//   - lib/layout.js fitDrawer: the drawer gives up a little width when that buys the floor a whole scale step (U1)
//   - panels/models.js breakable: a score column head never breaks inside a word (U2)
//   - lib/store.js: the 'hb' heartbeat keeps the watchdog quiet and never moves store.seq (U8)
//   - the stub: hb data message with no id, adopt-check, reveal open:false, changes reqId, notice panel, board 1900 (U9)
// Run: node --test tests/ui-stub/wiring.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitDrawer, floorScale, DRAWER_MIN, DRAWER_WIDE_MIN } from '../../ui/lib/layout.js';
import { breakable } from '../../ui/panels/models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- U1: floor and drawer sizes

/** The normal drawer widths of style.css: --drawer and --drawer-wide. */
const cssDrawer = (vw) => Math.max(Math.min(600, 0.46 * vw), Math.min(760, 0.34 * vw));
const cssWide = (vw) => Math.max(cssDrawer(vw), Math.min(860, 0.66 * vw));
const STAGE = (vh) => vh - 44 - 26; // the top bar and the ticker

test('fitDrawer: at the Mac app window (1280 x 762, Retina) a normal panel leaves the floor at 1.5 (720 px)', () => {
  const fit = fitDrawer({ width: 1280, height: STAGE(762), base: cssDrawer(1280), dpr: 2 });
  assert.equal(fit.scale, 1.5);
  assert.equal(fit.narrowed, true);
  assert.ok(fit.drawer >= DRAWER_MIN && fit.drawer <= 560, `drawer ${fit.drawer}`);
  assert.ok(1280 - fit.drawer >= 720, 'the whole floor fits left of the drawer');
  assert.equal(floorScale(1280 - fit.drawer, STAGE(762), 2), 1.5, 'the scene picks the same scale in the room that is left');
});

test('fitDrawer: per window size, normal and wide drawer (Retina)', () => {
  const rows = [];
  for (const [w, hgt] of [[1000, 640], [1280, 762], [1440, 900], [2000, 1200]]) {
    for (const wide of [false, true]) {
      const base = wide ? cssWide(w) : cssDrawer(w);
      const fit = fitDrawer({ width: w, height: STAGE(hgt), base, wide, dpr: 2 });
      const min = Math.min(base, wide ? DRAWER_WIDE_MIN : DRAWER_MIN);
      assert.ok(fit.drawer >= min - 0.001 && fit.drawer <= base + 0.001, `${w} ${wide}: ${fit.drawer} within ${min}..${base}`);
      assert.ok(fit.scale >= floorScale(w - base, STAGE(hgt), 2), 'never a smaller floor than with the normal drawer');
      assert.ok(480 * fit.scale <= w - fit.drawer, 'the floor fits');
      rows.push(`${w}x${hgt} ${wide ? 'wide' : 'normal'} ${Math.round(fit.drawer)} ${fit.scale}`);
    }
  }
  assert.deepEqual(rows, [
    '1000x640 normal 460 1', '1000x640 wide 660 0.5',
    '1280x762 normal 536 1.5', '1280x762 wide 776 1',
    '1440x900 normal 600 1.5', '1440x900 wide 696 1.5',
    '2000x1200 normal 536 3', '2000x1200 wide 776 2.5',
  ]);
});

test('fitDrawer: a screen with ratio 1 steps in whole CSS pixels; a small window keeps its drawer', () => {
  assert.deepEqual(fitDrawer({ width: 1280, height: 692, base: 589, dpr: 1 }), { drawer: 589, scale: 1, narrowed: false }, '2x would need a drawer under 480 px');
  const small = fitDrawer({ width: 900, height: 600, base: 414, dpr: 2 });
  assert.equal(small.drawer, 414, 'a drawer that is already under 480 px is never made narrower');
  assert.equal(fitDrawer({ width: 0, height: 0, base: 0 }).narrowed, false, 'no window: nothing to do');
});

// ---- U2: Models column heads

test('breakable: a score head breaks only between syllables, and a word under 10 letters stays whole', () => {
  const show = (s) => breakable(s).replace(/­/g, '·');
  for (const w of ['Reasoning', 'Knowledge', 'Overall', 'Agentic', 'Coding', 'Grounded']) assert.equal(breakable(w), w);
  assert.equal(show('Multimodal and Grounded'), 'Multi·modal and Grounded');
  assert.equal(show('Arena Agent net improvement'), 'Arena Agent net improve·ment');
  assert.equal(show('AA Intelligence Index v5.0.1'), 'AA Intel·ligence Index v5.0.1');
  assert.equal(show('AA-AnalystAgent'), 'AA-Analyst·Agent', 'a capital inside the word is a break; none crosses it');
  assert.equal(show('FrontierMath v2, Tiers 1-3'), 'Fron·tier·Math v2, Tiers 1-3');
  assert.equal(show('Chartography (no tools)'), 'Char·tog·raphy (no tools)');
  for (const l of ['Terminal-Bench 4.1', 'CursorBench 4.0', 'Arena WebDev Elo', 'OSWorld 2.1 Offline']) assert.equal(breakable(l).replace(/­/g, ''), l, 'only soft hyphens are added');
});

// ---- U8: heartbeat in the store

function browserGlobals() {
  globalThis.location = { hash: '', pathname: '/', search: '', href: 'http://127.0.0.1/' };
  globalThis.history = { replaceState() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
  class FakeES {
    constructor(url) { this.url = url; this.closed = false; FakeES.last = this; }
    addEventListener() {}
    close() { this.closed = true; }
    send(evt) { this.onmessage({ data: JSON.stringify(evt) }); }
  }
  globalThis.EventSource = FakeES;
  return FakeES;
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('store: the hub heartbeat keeps the watchdog quiet and never moves store.seq; 12 s of silence is the default', async () => {
  const ES = browserGlobals();
  const { createStore, WATCH } = await import('../../ui/lib/store.js');
  assert.equal(WATCH.silentMs, 12000);
  const calls = [];
  const api = {
    async get(p) { calls.push(p); if (p === '/api/state') return { seq: 20, state: {}, board: [], providers: [], settings: {}, inbox: [] }; if (p === '/api/inbox') return []; if (p === '/api/health') return { ok: true, seq: 20 }; return undefined; },
    async post() { return {}; }, async put() { return {}; },
  };
  const store = createStore({ api, watch: { silentMs: 40, everyMs: 10 } });
  await store.connect();
  const first = ES.last;
  for (let i = 0; i < 12; i++) { first.send({ type: 'hb', seq: 99 }); await tick(8); }
  assert.equal(calls.filter((p) => p === '/api/health').length, 0, 'beats arrive: the watchdog does not ask');
  assert.equal(store.seq, 20, 'an hb is not an event: its seq does not move the store');
  await tick(90);
  assert.ok(calls.filter((p) => p === '/api/health').length >= 1, 'the beats stopped: the watchdog asks GET /api/health');
  assert.equal(ES.last, first, 'the hub is at the same seq: the stream stays');
  store.stop();
});

// ---- U9: the stub hub equals part S

let child = null, base = '';
before(async () => {
  child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', '0', '--scenario', 'empty', '--child', '--hb-ms', '150'], { stdio: ['pipe', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('The stub hub did not start in 10 s.')), 10000);
    child.stdout.on('data', (d) => { out += d; const m = /WORKSHOP_STUB_READY (http:\/\/127\.0\.0\.1:\d+)\//.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`The stub hub ended with code ${code}.`)); });
  });
});
after(() => { if (child) child.kill(); });

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: method === 'GET' ? {} : { 'X-WorkShop': '1', 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, data };
}
const get = async (url) => (await call('GET', url)).data;
const post = (url, body) => call('POST', url, body);
const stub = (cmd) => get('/__stub/' + cmd);

/** Read the event stream until fn(frames) says done (or 3 s pass). Frames are the raw SSE blocks. */
async function readStream(done) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  const frames = [];
  try {
    const res = await fetch(base + '/api/events?since=' + (await get('/api/health')).seq, { signal: ctl.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) { frames.push(buf.slice(0, at)); buf = buf.slice(at + 2); }
      if (await done(frames)) break;
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); ctl.abort(); }
  return frames;
}

test('stub S1: the heartbeat is a data message with the health seq and no id line', async () => {
  await stub('goto/empty');
  const frames = await readStream((f) => f.some((x) => x.includes('"hb"')));
  const beat = frames.find((x) => x.includes('"hb"'));
  assert.ok(beat, 'a beat came within 3 s');
  assert.doesNotMatch(beat, /^id:/m, 'no id: Last-Event-ID does not move');
  assert.doesNotMatch(beat, /^:/m, 'not a comment');
  const evt = JSON.parse(beat.replace(/^data: /, ''));
  assert.equal(evt.type, 'hb');
  assert.equal(evt.seq, (await get('/api/health')).seq);
});

test('stub S2: adopt-check checks a folder by path and changes nothing', async () => {
  const ok = await post('/api/adopt-check', { path: '/Users/owner/Code/recipe-box/' });
  assert.deepEqual([ok.status, ok.data], [200, { path: '/Users/owner/Code/recipe-box', targetBranch: 'main', agentFiles: ['AGENTS.md'] }], 'the shape of POST /api/pick-folder');
  const bad = await post('/api/adopt-check', { path: '/Users/owner/Code/not-git' });
  assert.deepEqual([bad.status, /Not a git repository/.test(bad.data.error)], [400, true]);
  for (const p of ['relative/path', '/a\0b', '/' + 'x'.repeat(4096), 42]) assert.equal((await post('/api/adopt-check', { path: p })).status, 400, `refused: ${String(p).slice(0, 20)}`);
});

test('stub S3, S5, S6, S7: reveal open:false, notice panel, board 1900, Add task with reqId', async () => {
  await stub('goto/running');
  const rv = await post('/api/reveal', { jobId: 'J1', what: 'truck', open: false });
  assert.deepEqual([rv.status, rv.data.ok, typeof rv.data.path], [200, true, 'string']);
  assert.deepEqual((await stub('info')).revealed.at(-1), { jobId: 'J1', open: false }, 'the hub made the copy and did not open Finder');

  const frames = readStream((f) => f.some((x) => x.includes('Stub truck note')));
  await tick(100);
  await stub('notice?level=owner&text=Stub%20truck%20note&panel=truck');
  const note = (await frames).find((x) => x.includes('Stub truck note'));
  assert.equal(JSON.parse(note.replace(/^id: \d+\n/, '').replace(/^data: /, '')).panel, 'truck');

  const long = await post('/api/board', { jobId: 'J1', kind: 'INFO', body: 'x'.repeat(1901) });
  assert.deepEqual([long.status, long.data.error], [400, 'The message is too long (1901 chars). Max 1900.']);
  assert.equal((await post('/api/board', { jobId: 'J1', kind: 'INFO', body: 'y'.repeat(1900) })).status, 200);

  await stub('goto/inbox'); // one of everything that waits, a failed requirement that no task serves among them
  const item = (await get('/api/state')).inbox.find((it) => it.kind === 'requirement');
  assert.ok(item, 'the failed requirement waits in the inbox');
  assert.equal((await post(`/api/jobs/${item.jobId}/changes`, { text: 'Fix it.', reqId: 'R99' })).status, 404, 'unknown reqId');
  const res = await post(`/api/jobs/${item.jobId}/changes`, { text: 'Make it pass.', reqId: item.reqId || item.id });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.ok, res.data.req.servesReq], [true, item.reqId || item.id]);
  assert.equal((await get('/api/state')).inbox.some((it) => it.kind === 'requirement' && it.id === item.id), false, 'the item left the inbox');
});
