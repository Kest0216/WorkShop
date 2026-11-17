// Scene map: walk grid, named locations, pathfinding. Run with: node --test tests/scene/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../ui/scene/map.js';

const stands = M.namedStands();
const names = Object.keys(stands);

test('the grid is 30 x 17 tiles of 16 px', () => {
  assert.equal(M.W, 480); assert.equal(M.H, 272); assert.equal(M.T, 16);
  assert.equal(M.COLS * M.T, M.W); assert.equal(M.ROWS * M.T, M.H);
  assert.equal(M.benches.length, 8); assert.equal(M.offices.length, 3); assert.equal(M.posts.length, 3);
});

test('every named stand is on a walkable tile and inside the room', () => {
  assert.ok(names.length >= 30);
  for (const n of names) {
    const p = stands[n];
    assert.ok(M.pointWalkable(p.x, p.y), n + ' is not walkable');
    assert.ok(p.x >= M.SIDE_WALL && p.x < M.W - M.SIDE_WALL, n + ' is inside a side wall');
    assert.ok(p.y >= M.FLOOR_Y + 6, n + ' is too close to the back wall');
  }
});

test('walls, offices, furniture and the street are blocked', () => {
  for (let tx = 0; tx < M.COLS; tx++) { assert.equal(M.isWalkable(tx, 0), false); assert.equal(M.isWalkable(tx, 1), false); assert.equal(M.isWalkable(tx, 15), false); }
  for (let ty = 2; ty <= 4; ty++) for (let tx = 0; tx < 12; tx++) assert.equal(M.isWalkable(tx, ty), false, 'office tile ' + tx + ',' + ty);
  for (const b of M.benches) { assert.equal(M.isWalkable(b.bx, b.by), false); assert.equal(M.isWalkable(b.bx + 1, b.by), false); }
  for (const p of M.posts) assert.equal(M.isWalkable(p.tx, p.ty), false);
  assert.equal(M.isWalkable(-1, 5), false); assert.equal(M.isWalkable(30, 5), false); assert.equal(M.isWalkable(5, 17), false);
});

test('findPath connects all named locations and never steps on a blocked tile', () => {
  for (const a of names) for (const b of names) {
    const from = M.tileAt(stands[a].x, stands[a].y), to = M.tileAt(stands[b].x, stands[b].y);
    const path = M.findPath(from, to);
    assert.ok(path, 'no path ' + a + ' -> ' + b);
    assert.deepEqual(path[0], from); assert.deepEqual(path[path.length - 1], to);
    for (let i = 0; i < path.length; i++) {
      assert.ok(M.isWalkable(path[i].tx, path[i].ty), 'blocked tile on ' + a + ' -> ' + b);
      if (i) assert.equal(Math.abs(path[i].tx - path[i - 1].tx) + Math.abs(path[i].ty - path[i - 1].ty), 1, 'path must move one tile at a time');
    }
  }
});

test('route() walks only over walkable ground between all named locations', () => {
  for (const a of names) for (const b of names) {
    const pts = M.route(stands[a], stands[b]);
    assert.ok(pts.length >= 1);
    let cur = stands[a];
    for (const p of pts) {
      assert.ok(M.lineFree(cur, p), 'segment crosses a blocked tile on ' + a + ' -> ' + b);
      cur = p;
    }
    assert.equal(cur.x, stands[b].x); assert.equal(cur.y, stands[b].y);
  }
});

test('route() from or to a blocked point is moved to walkable ground and does not throw', () => {
  const weird = [{ x: -50, y: -50 }, { x: 9999, y: 9999 }, { x: 20, y: 20 }, { x: 240, y: 240 }, { x: NaN, y: 3 }];
  for (const p of weird) {
    const pts = M.route(p, stands.bench0);
    assert.ok(Array.isArray(pts) && pts.length >= 1);
    const back = M.route(stands.bench0, p);
    assert.ok(Array.isArray(back) && back.length >= 1);
    for (const q of back) if (Number.isFinite(q.x)) assert.ok(M.pointWalkable(q.x, q.y));
  }
});

test('findPath returns null for blocked ends', () => {
  assert.equal(M.findPath({ tx: 0, ty: 0 }, { tx: 14, ty: 5 }), null);
  assert.equal(M.findPath({ tx: 14, ty: 5 }, { tx: 2, ty: 3 }), null);
});

test('static hit testing finds the board, the counter, offices and benches', () => {
  assert.deepEqual(M.staticTargetAt(M.board.rect.x + 5, M.board.rect.y + 5), { kind: 'board', id: 'board' });
  assert.deepEqual(M.staticTargetAt(M.counter.rect.x + 5, M.counter.rect.y + 5), { kind: 'counter', id: 'counter' });
  assert.deepEqual(M.staticTargetAt(M.offices[1].rect.x + 30, 40), { kind: 'office', id: 1 });
  assert.deepEqual(M.staticTargetAt(M.benches[6].rect.x + 3, M.benches[6].rect.y + 3), { kind: 'bench', id: 6 });
  assert.deepEqual(M.staticTargetAt(300, 100), { kind: 'none', id: null });
});

test('truck bed slots and dock stands are distinct', () => {
  const seen = new Set();
  for (let s = 0; s < M.truck.slots; s++) { const o = M.truck.slot(s); seen.add(o.x + ',' + o.y); assert.ok(o.x > 0 && o.x < M.truck.w); }
  assert.equal(seen.size, M.truck.slots);
  for (let s = 0; s < 6; s++) { const d = M.dock.stand(s); assert.ok(M.pointWalkable(d.x, d.y)); }
});

test('routes go around the work places of other makers', () => {
  // from the manager stop at bench 0 to the stop at bench 1: the straight line would cross maker 1
  const pts = M.route(stands.visit0, stands.visit1);
  let cur = stands.visit0;
  for (const p of pts) {
    const n = Math.ceil(Math.hypot(p.x - cur.x, p.y - cur.y));
    for (let i = 0; i <= n; i++) {
      const x = cur.x + ((p.x - cur.x) * i) / Math.max(1, n), y = cur.y + ((p.y - cur.y) * i) / Math.max(1, n);
      const t = M.tileAt(x, y);
      assert.equal(M.reservedAt(t.tx, t.ty), 0, 'walks through a work place at ' + Math.round(x) + ',' + Math.round(y));
    }
    cur = p;
  }
  // a maker can still reach and leave its own bench
  for (const b of M.benches) {
    const out = M.route(b.stand, stands.inbox1), back = M.route(stands.inbox1, b.stand);
    assert.deepEqual(out[out.length - 1], { x: stands.inbox1.x, y: stands.inbox1.y });
    assert.deepEqual(back[back.length - 1], { x: b.stand.x, y: b.stand.y });
    assert.equal(M.reservedAt(b.bx, b.by - 1), b.k + 1);
  }
});

test('route() options: a lane offset moves the way-points but never the goal, and stays on walkable ground', () => {
  for (const a of names) for (const b of ['inbox0', 'bench5', 'post1', 'visit6', 'entrance']) {
    for (const lane of [{ dx: 3, dy: 3 }, { dx: -3, dy: 2 }, { dx: 0, dy: -3 }]) {
      const pts = M.route(stands[a], stands[b], { lane });
      let cur = stands[a];
      for (const p of pts) { assert.ok(M.lineFree(cur, p), 'lane segment crosses a blocked tile on ' + a + ' -> ' + b); cur = p; }
      assert.equal(cur.x, stands[b].x); assert.equal(cur.y, stands[b].y);
    }
  }
  const plain = M.route(stands.bench4, stands.inbox0), shifted = M.route(stands.bench4, stands.inbox0, { lane: { dx: 3, dy: -3 } });
  assert.notDeepEqual(plain, shifted, 'two walkers on the same trip do not use the same way-points');
});

test('routes keep out of the row behind the seated makers; a patrol uses the cross aisle', () => {
  for (const b of M.benches.slice(0, 4)) { assert.equal(M.reservedAt(b.bx, b.by - 2), b.k + 1); assert.equal(M.reservedAt(b.bx + 1, b.by - 2), b.k + 1); }
  const walk = (pts, from, fn) => { let cur = from; for (const p of pts) { const n = Math.ceil(Math.hypot(p.x - cur.x, p.y - cur.y)); for (let i = 0; i <= n; i++) fn(cur.x + ((p.x - cur.x) * i) / Math.max(1, n), cur.y + ((p.y - cur.y) * i) / Math.max(1, n)); cur = p; } };
  // office aisle to the far side: never behind a maker's head
  walk(M.route(stands.inbox0, stands.shelves), stands.inbox0, (x, y) => assert.equal(M.reservedAt(Math.floor(x / 16), Math.floor(y / 16)), 0));
  // patrol between two benches of the back row: down the column aisle, along the cross aisle, up again
  const avoid = (tx, ty) => ty <= 6;
  let low = 0;
  walk(M.route(stands.visit0, stands.visit2, { avoid }), stands.visit0, (x, y) => { assert.ok(y >= 112, 'the patrol left the bench area at y=' + y); low = Math.max(low, y); });
  assert.ok(low >= 144, 'it used the cross aisle');
  // the soft rule gives way when there is no other path
  const pts = M.route(stands.post0, stands.visit0, { avoid });
  assert.deepEqual(pts[pts.length - 1], { x: stands.visit0.x, y: stands.visit0.y });
});

test('the trays stand on the doorway counter of each office, not behind the glass', () => {
  for (const o of M.offices) {
    assert.ok(o.inbox.x >= o.door.x && o.outbox.x <= o.door.x + o.door.w, 'trays are in the doorway');
    assert.equal(o.inboxStand.x, o.inbox.x); assert.equal(o.outboxStand.x, o.outbox.x);
    const q = [0, 1, 2].map((r) => M.queueOffset('inbox', r)).map((p) => p.x + ',' + p.y);
    assert.equal(new Set(q).size, 3);
  }
});

test('click targets: the tool pegboard on the back wall is kind toolwall; each bench has an inspection stand', () => {
  const g = M.pegboard;
  assert.deepEqual(M.staticTargetAt(g.x + 1, g.y + 1), { kind: 'toolwall', id: 'toolwall' });
  assert.deepEqual(M.staticTargetAt(g.x + g.w - 1, g.y + g.h - 1), { kind: 'toolwall', id: 'toolwall' });
  assert.notEqual(M.staticTargetAt(g.x - 1, g.y + 1).kind, 'toolwall');
  assert.deepEqual(M.staticTargetAt(M.harnessRack.x + 2, M.harnessRack.y + 2), { kind: 'harnesses', id: 'harnesses' });
  assert.deepEqual(M.staticTargetAt(M.rftBay.x + 4, M.rftBay.y + 4), { kind: 'rftbay', id: 'rftbay' });
  for (const b of M.benches) {
    assert.ok(M.pointWalkable(b.inspect.x, b.inspect.y));
    assert.equal(b.inspect.face, 'left');
    assert.ok(!M.atWorkPlace(b.k, b.inspect.x, b.inspect.y), 'the inspector does not stand on the maker\'s own tiles');
    assert.ok(b.inspect.x > b.item.x && b.inspect.x - b.item.x <= 16, 'close to the item on the bench');
  }
});

test('routes do not walk along the gap row in front of the back-row benches when a detour exists', () => {
  const gapTiles = [];
  for (const b of M.benches.slice(0, 4)) { assert.ok(M.gapAt(b.bx, b.by + 1)); assert.ok(M.gapAt(b.bx + 1, b.by + 1)); gapTiles.push(b.bx); }
  assert.ok(!M.gapAt(M.benches[0].bx + 3, M.benches[0].by + 1), 'the column aisles stay free');
  const walk = (pts, from, fn) => { let cur = from; for (const p of pts) { const n = Math.ceil(Math.hypot(p.x - cur.x, p.y - cur.y)); for (let i = 0; i <= n; i++) fn(cur.x + ((p.x - cur.x) * i) / Math.max(1, n), cur.y + ((p.y - cur.y) * i) / Math.max(1, n)); cur = p; } };
  const pairs = [['visit0', 'visit2'], ['visit0', 'visit3'], ['inspect1', 'visit3'], ['bench4', 'inspect2'], ['post0', 'inspect6'], ['visit5', 'visit2']];
  for (const [a, b] of pairs) {
    walk(M.route(stands[a], stands[b], { avoid: (tx, ty) => ty <= 6 }), stands[a], (x, y) => assert.ok(!M.gapAt(Math.floor(x / 16), Math.floor(y / 16)), a + ' -> ' + b + ' walks along the gap at ' + x + ',' + y));
  }
});
