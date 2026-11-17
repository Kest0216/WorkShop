// Renderer (render.js) depth order and overlays, checked with a recording fake canvas: every call on the main
// context is logged in order, so a test can tell what is painted over what.
import test from 'node:test';
import assert from 'node:assert/strict';

const log = [];
function ctx2d(record) {
  const store = { fillStyle: '#000' };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => { if (record) log.push({ op: k, args, fill: t.fillStyle }); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function canvas(record) { const c = ctx2d(record); return { width: 0, height: 0, style: {}, getContext: () => c }; }
globalThis.document = { createElement: () => canvas(false) };

const M = await import('../../ui/scene/map.js');
const { createWorld } = await import('../../ui/scene/actors.js');
const { createRenderer, nightLevel } = await import('../../ui/scene/render.js');
const { nameTagRect, placeBubble, bubbleRect } = await import('../../ui/scene/hud.js');
const { CHAR_AX, CHAR_AY } = await import('../../ui/scene/sprites.js');
test.after(() => { delete globalThis.document; });

const vm = () => ({
  shop: {}, deliveries: [], truck: { state: 'docked', crates: 0 }, board: { unread: 0 }, owner: { attention: false },
  agents: [
    { id: 'G', name: 'Pip', role: 'manager', provider: 'claude', spot: 0, activity: 'idle' },
    { id: 'K', name: 'Flux', role: 'maker', provider: 'openai', spot: 2, activity: 'work', task: { id: 'T', title: 't', domain: 'research', progress: 0.5 } },
  ],
});

// index in the log of the walker sprite, and of the plate of the bench name tag
function drawOrder(walkerAt) {
  const w = createWorld({ warn: () => {}, seed: 3 });
  w.sync(vm());
  const g = w.w.agents.get('G');
  Object.assign(g, walkerAt, { atHome: false, moving: true, path: [{ x: walkerAt.x + 20, y: walkerAt.y }], goalKey: 'x' });
  const r = createRenderer();
  const main = canvas(true).getContext();
  log.length = 0;
  r.draw(main, w, { date: new Date(2026, 0, 5, 14, 30) });
  const b = M.benches[2], tag = nameTagRect('Flux', b.tag.x, b.tag.y, 40);
  const tagI = log.findIndex((c) => c.op === 'fillRect' && c.args[0] === tag.x && c.args[1] === tag.y && c.args[2] === tag.w && c.args[3] === 7);
  const sx = Math.round(walkerAt.x) - CHAR_AX, sy = Math.round(walkerAt.y) - CHAR_AY;
  const walkerI = log.findIndex((c) => c.op === 'drawImage' && c.args.length === 9 && c.args[5] === sx && c.args[6] === sy);
  return { tagI, walkerI, tag };
}

test('a walker in front of a bench covers the bench name tag; behind the bench the tag stays on top', () => {
  const b = M.benches[2];
  const front = drawOrder({ x: b.tag.x + 10, y: b.baseY + 6 });
  assert.ok(front.tagI >= 0 && front.walkerI >= 0, 'both were drawn');
  // the walker's head (y - 27 .. y - 11) lies over the tag plate
  assert.ok(b.baseY + 6 - 27 < front.tag.y + 7 && b.baseY + 6 - 11 > front.tag.y);
  assert.ok(front.walkerI > front.tagI, 'the nearer walker is painted over the tag under its head');
  const behind = drawOrder({ x: b.tag.x + 10, y: b.baseY - 20 });
  assert.ok(behind.tagI > behind.walkerI, 'a walker behind the bench is covered by the bench and its tag');
});

test('night: the shop dims only after dusk, in a few steps', () => {
  assert.equal(nightLevel(14.5), 0);
  assert.equal(nightLevel(21.5), 1);
  assert.equal(nightLevel(3), 1);
  const dusk = nightLevel(19.5);
  assert.ok(dusk > 0 && dusk < 1);
  assert.equal(dusk * 8, Math.round(dusk * 8), 'quantized, no smooth fade per frame');
  // the renderer paints a translucent navy layer at night and none by day
  const w = createWorld({ warn: () => {}, seed: 3 });
  w.sync(vm());
  const r = createRenderer(), main = canvas(true).getContext();
  const navy = () => log.filter((c) => c.op === 'fillRect' && /^rgba\(16,22,64/.test(c.fill)).length;
  log.length = 0; r.draw(main, w, { date: new Date(2026, 0, 5, 14, 30) }); assert.equal(navy(), 0);
  log.length = 0; r.draw(main, w, { date: new Date(2026, 0, 5, 21, 30) }); assert.equal(navy(), 1);
});

test('a manager at its post speaks from beside its head, not up over the wall', () => {
  const p = M.posts[1].stand, top = p.y - 27;
  const lines = ['Job done. Shelves are full.'];
  const r0 = bubbleRect(p.x, top + 2, lines);
  const wall = [M.board.rect, M.pegboard, M.statusBoard].map((r) => ({ ...r, cost: 1.5 }));
  const r = placeBubble(r0, p.x, [], wall, { headY: top, maxUp: 12, sideFirst: true });
  assert.ok(r.side, 'placed beside the head');
  assert.ok(r.y >= M.WALL_H - 4, 'below the wall band');
  const plain = placeBubble(r0, p.x, [], [], { headY: top });
  assert.equal(plain.side, null, 'others still prefer the place above the head');
});

test('a name plate shows the persona name without its role word when the full name does not fit', async () => {
  const { fitName } = await import('../../ui/scene/hud.js');
  const { measureText } = await import('../../ui/scene/font.js');
  assert.equal(fitName('Flux', 40), 'Flux');
  assert.equal(fitName('Boss Tungsten', 33), 'Tungsten');
  assert.equal(fitName('Boss Ironwood', 33), 'Ironwood');
  assert.equal(fitName('Foreman Ash', 34), 'Ash');
  assert.equal(fitName('Foreman Juniper', 34), 'Juniper');
  const long = fitName('Boss Ironwood 12', 33);
  assert.ok(measureText(long) <= 33 && long.endsWith('..'));
  // every boss persona fits the office plate (map.js: plate width less the lab bar and the frame)
  const plate = M.offices[0].plate;
  for (const n of ['Boss Ironwood', 'Boss Tungsten', 'Boss Maple', 'Boss Cobalt', 'Boss Walnut', 'Boss Nickel']) assert.ok(!fitName(n, plate.w - 5).endsWith('..'), n);
});
