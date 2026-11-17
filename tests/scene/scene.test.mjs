// Scene public API (scene.js) driven with a fake canvas: the renderer runs for real, the pixels go nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- minimal fake DOM (installed before the scene is created; removed again at the end)
let calls = 0;
function fakeCtx() {
  const store = {};
  return new Proxy(store, {
    get(t, k) { if (k in t) return t[k]; return () => { calls++; }; },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function fakeCanvas() {
  const listeners = {};
  const ctx = fakeCtx();
  return {
    width: 0, height: 0, style: {}, parentElement: { clientWidth: 1440, clientHeight: 816, style: {} }, listeners,
    getContext() { return ctx; },
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 816 }; },
    toDataURL() { return 'data:image/png;base64,AAAA'; },
  };
}
let now = 0;
const frames = [];
const docListeners = {};
globalThis.document = { hidden: false, createElement: () => fakeCanvas(), addEventListener(t, fn) { docListeners[t] = fn; }, removeEventListener(t) { delete docListeners[t]; } };
globalThis.window = {
  performance: { now: () => now },
  requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
  cancelAnimationFrame() { frames.length = 0; },
  addEventListener() {}, removeEventListener() {},
};
function pump(ms) { now += ms; const f = frames.splice(0); for (const fn of f) fn(now); }

const { createScene, avatarDataURL } = await import('../../ui/scene/scene.js');
const { vmAt, applyScript, LOOP_MS } = await import('../../ui/scene/demo.js');
const M = await import('../../ui/scene/map.js');

const errors = [];
const origError = console.error, origWarn = console.warn;
const warnings = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };

test('createScene needs a canvas and sets the backing store to exactly 480 x 272 with an integer scale', () => {
  assert.throws(() => createScene(null));
  const cv = fakeCanvas();
  const scene = createScene(cv, {});
  assert.equal(cv.width, 480); assert.equal(cv.height, 272);
  assert.equal(cv.style.imageRendering, 'pixelated');
  assert.equal(scene.resize(), 3);
  assert.equal(cv.style.width, '1440px'); assert.equal(cv.style.height, '816px');
  cv.parentElement.clientWidth = 1000; cv.parentElement.clientHeight = 700;
  assert.equal(scene.resize(), 2);
  assert.equal(cv.style.marginLeft, '20px'); assert.equal(cv.style.marginTop, '78px');
  assert.ok(cv.parentElement.style.backgroundColor, 'the letterbox gets the dark wall color');
  scene.destroy();
});

test('the whole demo loop renders without a single error or warning', () => {
  const cv = fakeCanvas();
  const events = [];
  const scene = createScene(cv, { onEvent: (e) => events.push(e), clock: () => new Date(2026, 0, 5, 21, 30) });
  scene.sync(vmAt(0));
  const before = calls;
  for (let t = 0; t < LOOP_MS + 5000; t += 100) { applyScript(scene, t, t + 100); scene.debug.advance(100); }
  assert.ok(calls - before > 100000, 'the renderer drew a lot');
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  const s = scene.debug.state();
  assert.equal(s.scale, 3); assert.equal(s.counts.agents, 10);
  scene.setOptions({ scanlines: true }); scene.debug.render(); scene.setOptions({ scanlines: false });

  // pointer events: hover and click report the target under the pointer
  const k1 = s.agents.K1;
  const at = scene.debug.targetAt(k1.x, k1.y - 12);
  assert.deepEqual(at, { kind: 'agent', id: 'K1' });
  assert.equal(scene.debug.targetAt(M.board.rect.x + 4, M.board.rect.y + 4).kind, 'board');
  assert.equal(scene.debug.targetAt(M.counter.rect.x + 4, M.counter.rect.y + 4).kind, 'counter');
  assert.equal(scene.debug.targetAt(M.truck.parkX + 50, M.truck.y + 20).kind, 'truck');
  assert.equal(scene.debug.targetAt(M.offices[2].ix + 50, 40).kind, 'office');
  assert.equal(scene.debug.targetAt(M.benches[3].rect.x + 4, M.benches[3].rect.y + 20).kind, 'bench');
  assert.equal(scene.debug.targetAt(300, 100).kind, 'none');
  cv.listeners.pointermove({ clientX: k1.x * 3, clientY: (k1.y - 12) * 3 });
  assert.deepEqual(events.at(-1), { type: 'hover', target: { kind: 'agent', id: 'K1' } });
  assert.equal(cv.style.cursor, 'pointer');
  scene.debug.render();                                   // draws the hover outline and the tooltip
  cv.listeners.click({ clientX: (M.board.rect.x + 4) * 3, clientY: (M.board.rect.y + 4) * 3 });
  assert.deepEqual(events.at(-1), { type: 'click', target: { kind: 'board', id: 'board' } });
  cv.listeners.click({ clientX: (M.pegboard.x + 6) * 3, clientY: (M.pegboard.y + 4) * 3 });
  assert.deepEqual(events.at(-1), { type: 'click', target: { kind: 'toolwall', id: 'toolwall' } });
  for (const kind of ['counter', 'office', 'bench', 'truck', 'toolwall', 'harnesses', 'rftbay']) {
    const p = { counter: [M.counter.rect.x + 4, M.counter.rect.y + 4], office: [M.offices[0].ix + 50, 40], bench: [M.benches[3].rect.x + 4, M.benches[3].rect.y + 20], truck: [M.truck.parkX + 50, M.truck.y + 20], toolwall: [M.pegboard.x + 30, M.pegboard.y + 6], harnesses: [M.harnessRack.x + 4, M.harnessRack.y + 4], rftbay: [M.rftBay.x + 6, M.rftBay.y + 6] }[kind];
    cv.listeners.pointermove({ clientX: p[0] * 3, clientY: p[1] * 3 });
    assert.equal(events.at(-1).target.kind, kind);
    scene.debug.render();
  }
  cv.listeners.pointerleave({});
  assert.deepEqual(events.at(-1), { type: 'hover', target: { kind: 'none', id: null } });
  assert.equal(cv.style.cursor, 'default');
  assert.deepEqual(errors, []);
  scene.destroy();
  assert.equal(Object.keys(cv.listeners).length, 0, 'destroy removes the listeners');
});

test('sync, fx and setOptions never throw on odd input; onEvent errors are contained', () => {
  const cv = fakeCanvas();
  const scene = createScene(cv, { onEvent() { throw new Error('handler bug'); }, clock: () => 'not a date' });
  for (const vm of [undefined, null, 7, 'x', [], { agents: [{ id: 1, role: 'x', activity: 'y', spot: 'z', task: { domain: 'q', progress: 'p' }, bubble: { text: 'hi', kind: 'zz', seq: {} } }] }, { deliveries: [{ id: 'd', stage: 'in_review' }], truck: { state: 'ready', crates: -4 } }]) {
    assert.doesNotThrow(() => { scene.sync(vm); scene.debug.advance(200); });
  }
  assert.doesNotThrow(() => { scene.fx(); scene.fx('unknown', 5); scene.fx('note'); scene.fx('ship'); scene.fx('horn'); scene.fx('newOrder'); scene.fx('confetti'); scene.setOptions(); scene.setOptions(5); scene.setOptions({ paused: true, scanlines: 1 }); scene.setOptions({ paused: false }); scene.debug.advance('x'); scene.debug.advance(-1); scene.resize(); });
  assert.doesNotThrow(() => cv.listeners.click({ clientX: 10, clientY: 10 }));
  assert.equal(errors.length, 0);
  assert.ok(warnings.length > 0, 'odd input is reported with console.warn');
  const n = warnings.length;
  scene.sync({ agents: [{ id: 1, role: 'x', activity: 'y' }] }); scene.sync({ agents: [{ id: 1, role: 'x', activity: 'y' }] });
  assert.equal(warnings.length, n, 'each kind of problem warns only once');
  warnings.length = 0;
  scene.destroy();
});

test('reload: a fresh scene at any time of the script is already in its steady state', () => {
  for (const t of [0, 13000, 18000, 20500, 30000, 36000, 47000, 57000, 60000, 68000, 80000, 91000]) {
    const scene = createScene(fakeCanvas(), {});
    scene.sync(vmAt(t));
    const a = scene.debug.state();
    for (const ag of Object.values(a.agents)) if (ag.role !== 'manager') { assert.equal(ag.moving, false); assert.equal(ag.errand, null); }
    const vm = vmAt(t);
    for (const d of vm.deliveries) {
      if (d.stage === 'shipped') { assert.equal(a.items[d.id], undefined); continue; }
      const want = { to_office: 'inbox', buddy_check: 'bench', in_review: d.reviewerId.startsWith('M') ? 'bench' : 'desk', rejected: 'bench', to_truck: 'truck', on_truck: 'truck' }[d.stage];
      assert.equal(a.items[d.id].place, want, 't=' + t + ' ' + d.id);
      // an inspector (buddy, bench reviewer) already stands at the maker's bench
      const who = d.stage === 'buddy_check' ? d.buddyId : d.stage === 'in_review' && d.reviewerId.startsWith('M') ? d.reviewerId : null;
      if (who) { const mk = a.agents[d.makerId], ins = a.agents[who]; assert.equal(ins.inspecting, true); assert.deepEqual([ins.x, ins.y], [M.benches[mk.spot].inspect.x, M.benches[mk.spot].inspect.y]); }
    }
    scene.destroy();
  }
});

test('the loop pauses while the page is hidden and snaps to the target state on resume', () => {
  frames.length = 0;
  const cv = fakeCanvas();
  const scene = createScene(cv, {});
  scene.sync(vmAt(11000));
  pump(16); pump(16);
  assert.equal(frames.length, 1, 'one animation frame is pending');
  // hide the page: the loop stops
  document.hidden = true; docListeners.visibilitychange();
  assert.equal(frames.length, 0);
  // hours later the view model has moved on; nothing is replayed
  scene.sync(vmAt(13000)); scene.sync(vmAt(47000));
  now += 3 * 3600 * 1000;
  document.hidden = false; docListeners.visibilitychange();
  pump(16);
  const s = scene.debug.state();
  assert.ok(s.t < 30000, 'no catch-up of hours of animation (t=' + s.t + ')');
  for (const a of Object.values(s.agents)) if (a.role === 'maker') { assert.equal(a.moving, false); assert.equal(a.atHome, true); }
  assert.equal(s.items.D5.place, 'truck'); assert.equal(s.items.D1.place, 'truck');
  assert.equal(s.dolly.job, null);
  // a stalled frame (sleep) is clamped as well
  pump(16); now += 600000; pump(16);
  assert.ok(scene.debug.state().t < 30000);
  scene.destroy();
  assert.deepEqual(errors, []);
});

test('a paused scene does not change, whatever the frame gap; it snaps only after the pause ends', () => {
  frames.length = 0;
  const scene = createScene(fakeCanvas(), {});
  scene.sync(vmAt(0));
  for (let t = 0; t < 20000; t += 50) { applyScript(scene, t, t + 50); scene.debug.advance(50); }
  pump(16);
  scene.setOptions({ paused: true });
  const before = scene.debug.state();
  assert.ok(Object.values(before.agents).some((a) => a.moving) || Object.values(before.items).some((it) => it.place === 'hand'), 'something is in motion at 20 s');
  pump(16); pump(5000); pump(16); pump(60000); pump(16);          // slow frames under load
  assert.deepEqual(scene.debug.state(), before, 'frozen');
  // hide and show while paused: still frozen
  document.hidden = true; docListeners.visibilitychange(); now += 100000; document.hidden = false; docListeners.visibilitychange();
  pump(16); pump(16);
  assert.deepEqual(scene.debug.state(), before, 'frozen after a hidden phase');
  // the pause ends after a long time: no replay, the actors snap to the steady state
  scene.setOptions({ paused: false });
  pump(16);
  const after = scene.debug.state();
  assert.ok(after.t - before.t < 200);
  for (const a of Object.values(after.agents)) if (a.role === 'maker') assert.equal(a.moving, false);
  scene.destroy();
});

test('slow frames run the world in real time; one-shot effects that arrive while the page is hidden are not replayed', () => {
  frames.length = 0;
  const scene = createScene(fakeCanvas(), {});
  scene.sync(vmAt(8000));
  pump(16);
  const t0 = scene.debug.state().t;
  for (let i = 0; i < 5; i++) pump(1000);                           // throttled requestAnimationFrame: 1 frame per second
  assert.ok(Math.abs(scene.debug.state().t - t0 - 5000) < 1, 'five 1 s frames advance the world by 5 s (no slow motion)');
  // hidden: bubbles and a horn arrive, the world clock stands still
  document.hidden = true; docListeners.visibilitychange();
  const vm = vmAt(8000);
  for (const a of vm.agents) a.bubble = { text: 'said while hidden', kind: 'info', seq: 999 };
  scene.sync(vm); scene.fx('horn'); scene.fx('confetti');
  assert.equal(scene.debug.state().truck.horn, true);
  now += 8000;
  document.hidden = false; docListeners.visibilitychange();
  pump(16);
  const s = scene.debug.state();
  for (const a of Object.values(s.agents)) assert.equal(a.bubble, false, 'no stale bubble after the snap');
  assert.equal(s.truck.horn, false); assert.equal(s.counts.particles, 0);
  // a short blink (under the snap limit) is simply simulated
  const t1 = scene.debug.state().t;
  document.hidden = true; docListeners.visibilitychange(); now += 400; document.hidden = false; docListeners.visibilitychange();
  pump(16);
  assert.ok(scene.debug.state().t - t1 >= 400 && scene.debug.state().t - t1 < 500);
  scene.destroy();
  assert.deepEqual(errors, []);
});

test('a container smaller than 480 x 272 keeps scale 1 (never a fractional scale)', () => {
  const cv = fakeCanvas();
  cv.parentElement.clientWidth = 300; cv.parentElement.clientHeight = 200;
  const scene = createScene(cv, {});
  assert.equal(scene.resize(), 1);
  assert.equal(cv.style.width, '480px'); assert.equal(cv.style.height, '272px');
  assert.equal(cv.style.marginLeft, '-90px'); assert.equal(cv.style.marginTop, '-36px');
  scene.setOptions({ scale: 2.7 });
  assert.equal(scene.debug.state().scale, 2, 'a forced scale is an integer as well');
  scene.setOptions({ scale: 0 });
  assert.equal(scene.debug.state().scale, 1);
  scene.destroy();
});

test('on a Retina screen a small container goes down to one device pixel per scene pixel (CSS scale 0.5), never below', () => {
  const cv = fakeCanvas();
  const had = globalThis.window.devicePixelRatio;
  globalThis.window.devicePixelRatio = 2;
  cv.parentElement.clientWidth = 340; cv.parentElement.clientHeight = 560; // the room left of a wide drawer in a 1000 px window
  const scene = createScene(cv, {});
  assert.equal(scene.resize(), 0.5);
  assert.equal(cv.style.width, '240px'); assert.equal(cv.style.height, '136px');
  cv.parentElement.clientWidth = 100; cv.parentElement.clientHeight = 50;
  assert.equal(scene.resize(), 0.5, 'never below one device pixel');
  cv.parentElement.clientWidth = 540; cv.parentElement.clientHeight = 560;
  assert.equal(scene.resize(), 1);
  scene.destroy();
  globalThis.window.devicePixelRatio = had;
});

test('the crowded stress scene renders without errors (queues, +N tags, many bubbles)', async () => {
  const { stressVm } = await import('../../ui/scene/demo.js');
  const scene = createScene(fakeCanvas(), {});
  scene.sync(stressVm(0)); scene.debug.advance(400); scene.sync(stressVm(1));
  for (let t = 0; t < 12000; t += 100) scene.debug.advance(100);
  const s = scene.debug.state();
  assert.equal(s.overflow, 4);
  assert.ok(s.queues.some((q) => q.kind === 'inbox' && q.count === 4), 'inbox backlog');
  assert.equal(Object.values(s.items).filter((it) => it.place === 'desk' && it.office === 1).length, 1, 'one item under review');
  assert.deepEqual(errors, []);
  scene.destroy();
  warnings.length = 0;
});

test('avatarDataURL returns a PNG data URL for any agent and caches it', () => {
  const a = avatarDataURL({ id: 'A7', role: 'maker', provider: 'claude', style: { seed: 12345 } }, 3);
  assert.match(a, /^data:image\/png/);
  assert.equal(avatarDataURL({ id: 'zz', role: 'maker', provider: 'claude', style: { seed: 12345 } }, 3), a);
  for (const junk of [null, undefined, {}, { role: 'x' }, 'str']) assert.equal(typeof avatarDataURL(junk, 'big'), 'string');
});

test.after(() => { console.error = origError; console.warn = origWarn; delete globalThis.document; delete globalThis.window; });

test('agent tooltips show the persona name and the handle when given', async () => {
  const { agentTooltipRows } = await import('../../ui/scene/render.js');
  const rows = agentTooltipRows({ name: 'Flux', handle: '@m3', role: 'maker', provider: 'openai', model: 'gpt-mini', activity: 'work', task: { id: 'T3', title: 'Compare auth libs', progress: 0.4 } });
  assert.equal(rows[0].text, 'Flux  @m3');
  assert.equal(rows[1].text, 'maker - openai');
  assert.equal(rows.at(-1).text, 'T3 Compare auth libs');
  assert.equal(agentTooltipRows({ name: 'Dot', handle: '', role: 'maker', provider: 'mock', activity: 'idle', task: null })[0].text, 'Dot');
});
