// WorkShop map: tile grid, named locations, walkability and pathfinding. Pure logic.
// Coordinates: logical pixels, origin top-left. An actor position is its FEET center.

export const W = 480, H = 272, T = 16, COLS = 30, ROWS = 17;

export const WALL_H = 32;        // back wall band: y 0..31 (two tiles)
export const FLOOR_Y = 32;       // floor starts here (right of the offices)
export const SIDE_WALL = 4;      // thickness of the room's side walls and of the office dividers
export const OFFICE_W = 64;      // each office is 4 tiles wide: 4 px wall + 60 px room
export const OFFICES_W = 196;    // three offices plus the closing wall
export const GLASS_Y = 66;       // glass front: y 66..79
export const OFFICE_BASE = 80;   // shop floor below the offices starts here
export const FRONT_WALL_Y = 208; // front wall band: y 208..225
export const STREET_Y = 226;     // curb + asphalt: y 226..271
export const ZONE = Object.freeze({ x: 320, y: 80, w: 156, h: 128 });   // machine and dock zone
export const DOCK_STRIP_Y = 192; // checker tiles along the dock: y 192..207

export const BENCH_COUNT = 8, OFFICE_COUNT = 3, POST_COUNT = 3;

// ---- named locations -------------------------------------------------------

export const offices = [0, 1, 2].map((i) => {
  const x0 = i * OFFICE_W, ix = x0 + SIDE_WALL;     // ix: left edge of the room interior (60 px wide)
  return {
    i, x0, ix,
    rect: { x: x0, y: 0, w: OFFICE_W, h: OFFICE_BASE },
    boss: { x: ix + 18, y: 53 },                  // seated boss (legs hidden by the desk)
    chair: { x: ix + 10, y: 36 },                 // 16 x 20
    desk: { x: ix + 2, y: 48, w: 34, h: 18 },     // top y 48..57, front y 58..65
    deskItem: { x: ix + 29, y: 57 },              // item under review (bottom center)
    blueprint: { x: ix + 3, y: 49 },
    plant: { x: ix + 42, y: 28 },                 // 14 x 24 floor plant in the back corner
    decor: { x: ix + 41, y: 4 },                  // 16 x 20 wall decor
    plate: { x: ix + 1, y: 4, w: 38, h: 9 },      // name plate on the back wall (room for an 8-letter name; the decor starts at ix + 40)
    door: { x: ix + 24, w: 34 },                  // doorway in the glass front; a service counter with the two trays stands in it
    inbox: { x: ix + 32, y: 77 },                 // tray item position (bottom center) on the doorway counter
    outbox: { x: ix + 50, y: 77 },
    inboxStand: { x: ix + 32, y: 90, face: 'up' },
    outboxStand: { x: ix + 50, y: 90, face: 'up' },
  };
});

// Several deliveries can wait in the same office place. Rank 0 is the front item; ranks 1 and 2 are stacked
// behind it with these offsets; higher ranks are not drawn (the renderer shows a "+N" tag instead).
export const QUEUE_SHOWN = 3;
export const QUEUE_STEP = Object.freeze({ inbox: { x: -4, y: -2 }, desk: { x: -4, y: -2 }, outbox: { x: 3, y: -2 } });
export function queueOffset(kind, rank) {
  const s = QUEUE_STEP[kind] || QUEUE_STEP.inbox;
  return { x: s.x * rank, y: s.y * rank };
}

export const benches = Array.from({ length: BENCH_COUNT }, (_, k) => {
  const col = k % 4, row = k < 4 ? 0 : 1;
  const bx = 1 + 5 * col, by = row ? 11 : 8;
  const x = bx * T, y = by * T;
  return {
    k, bx, by,
    rect: { x, y: y - 9, w: 32, h: 24 },         // top y-9..y+2, front y+3..y+14
    stand: { x: x + 13, y: y - 4, face: 'down' },// maker stands behind the bench (legs hidden by the top)
    tool: { x: x + 7, y: y + 1 },                // bench tooling (bottom center)
    item: { x: x + 23, y: y + 1 },               // doohickey on the bench top (bottom center)
    side: { x: x + 9, y: y + 2 },                // second item slot
    visit: { x: x + 41, y: y - 2, face: 'left' },// manager stops here
    inspect: { x: x + 36, y: y - 2, face: 'left' },// a buddy or a bench reviewer inspects the item from here (magnifier)
    tag: { x: x + 16, y: y + 5 },                // name tag on the bench front
    baseY: y + 14,
  };
});

export const posts = [0, 1, 2].map((p) => {
  const tx = 13 + 3 * p;
  const x = tx * T;
  return {
    p, tx, ty: 4,
    rect: { x, y: 57, w: 16, h: 23 },            // standing desk
    stand: { x: x + 8, y: 60, face: 'down' },
    tag: { x: x + 8, y: 70 },
    baseY: 79,
  };
});

export const board = { rect: { x: 200, y: 3, w: 64, h: 23 }, inner: { x: 203, y: 6, w: 58, h: 17 }, stand: { x: 232, y: 40, face: 'up' } };
export const clock = { cx: 277, cy: 13, r: 7 };
export const sign = { x: 290, y: 2, w: 58, h: 11 };
export const pegboard = { x: 290, y: 15, w: 36, h: 12 };  // the board with the tools only (the rack right of it is the Harness Rack)
export const harnessRack = { x: 329, y: 14, w: 22, h: 14 };
export const statusBoard = { x: 354, y: 2, w: 62, h: 27 };
export const hangingPlant = { x: 420, y: 0 };
export const entrance = { x: 434, y: 3, w: 26, h: 29, stand: { x: 447, y: 40, face: 'down' } };
export const counter = {
  rect: { x: 368, y: 42, w: 48, h: 22 }, bell: { x: 373, y: 44 }, slips: { x: 388, y: 44 },
  stand: { x: 440, y: 56, face: 'left' }, baseY: 63,
};
export const machine = { rect: { x: 336, y: 82, w: 32, h: 30 }, baseY: 111, chuck: { x: 349, y: 87, w: 4, h: 6 }, led: { x: 345, y: 88 }, sparks: { x: 354, y: 89 } };
export const rftBay = machine.rect;
export const shelves = { rect: { x: 400, y: 76, w: 64, h: 36 }, stand: { x: 424, y: 120, face: 'up' }, baseY: 111, max: 6 };
export const press = { rect: { x: 460, y: 114, w: 16, h: 30 }, baseY: 143, led: { x: 471, y: 119 } };
export const dolly = { home: { x: 456, y: 170, face: 'down' } };
export const staging = {
  rect: { x: 400, y: 194, w: 32, h: 13 }, stand: { x: 392, y: 200, face: 'right' }, baseY: 207,
  slot(s) { return { x: 406 + 10 * (s % 3), y: s % 6 < 3 ? 201 : 206 }; },
};
export const dock = {
  door: { x: 320, y: 208, w: 64, h: 18 },
  // the dolly stops here to load bed slot s
  stand(s) { return { x: 328 + 16 * (((s % 3) + 3) % 3), y: 218, face: 'down' }; },
};
export const truck = {
  w: 100, h: 40, parkX: 318, y: 229, enterX: -112, exitX: 500, slots: 6,
  // crate position (bottom center) relative to the truck origin
  slot(s) { const c = s % 3, r = Math.floor((s % 6) / 3); return { x: 12 + 17 * c, y: 18 + 6 * r }; },
  beacon: { x: 76, y: 1 }, exhaust: { x: 62, y: 2 },
};
export const props = {
  barrel: { x: 4, y: 187 },
  broom: { x: 5, y: 150 },
  plant: { x: 462, y: 24 },
  plant2: { x: 4, y: 88 },
  crates: { x: 443, y: 180 },
  drain: { x: 148, y: 152 },
  mat: { x: 434, y: 32, w: 26, h: 7 },
  cooler: { x: 354, y: 31, w: 11, h: 23 },       // water cooler against the back wall, left of the counter
  drum: { x: 370, y: 93, w: 12, h: 17 },         // oil drum next to the lathe
  cart: { x: 369, y: 139, w: 15, h: 19 },        // tool cart in the middle of the machine zone
  reel: { x: 401, y: 161, w: 14, h: 14 },        // cable reel
  dollyBay: { x: 445, y: 160, w: 22, h: 14 },    // floor-painted parking bay around dolly.home
};
export const frontWindows = [24, 104, 184, 264].map((x) => ({ x, y: FRONT_WALL_Y + 4, w: 32, h: 10 }));
// "+N" sign for agents that found no free spot: hangs on the lower panel of the entrance door (center x, top y)
export const overflowTag = { x: 447, y: 20 };

// ---- walkability -----------------------------------------------------------

const grid = new Uint8Array(COLS * ROWS); // 1 = walkable
(function buildGrid() {
  const open = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * COLS + x] = 1; };
  const block = (x0, y0, x1 = x0, y1 = y0) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * COLS + x] = 0; };
  open(12, 2, 28, 4);            // floor right of the offices
  open(0, 5, 28, 5);             // aisle in front of the offices
  open(1, 6, 28, 12);            // shop floor (column 0 and 29 hold the walls and props)
  open(20, 13, 22, 13);          // dock door threshold (the dolly goes there)
  block(23, 2, 25, 3);           // front counter
  for (const p of posts) block(p.tx, p.ty);
  block(21, 6, 22, 6);           // machine
  block(25, 6, 28, 6);           // stock shelves
  for (const b of benches) block(b.bx, b.by, b.bx + 1, b.by);
  block(25, 12, 26, 12);         // staging pallet
  block(28, 12);                 // crate stack
  block(28, 7, 28, 8);           // drill press
  block(22, 2, 22, 3);           // water cooler
  block(23, 6);                  // oil drum
  block(23, 9);                  // tool cart
  block(25, 10);                 // cable reel
})();

export function isWalkable(tx, ty) {
  return tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS && grid[ty * COLS + tx] === 1;
}
export function tileAt(x, y) { return { tx: Math.floor(x / T), ty: Math.floor(y / T) }; }
export function tileCenter(tx, ty) { return { x: tx * T + 8, y: ty * T + 8 }; }
export function pointWalkable(x, y) { return isWalkable(Math.floor(x / T), Math.floor(y / T)); }

// Work places: the two tiles behind each bench belong to its maker. They are walkable, but routes of
// other walkers go around them, so nobody strolls through a maker at work. Value: bench index + 1.
// For the back row, the two tiles behind the maker's head belong to the work place as well: walkers use the
// office aisle, the column aisles and the cross aisle, and do not pass right behind a seated maker's head.
const reserved = new Uint8Array(COLS * ROWS);
for (const b of benches) {
  reserved[(b.by - 1) * COLS + b.bx] = b.k + 1; reserved[(b.by - 1) * COLS + b.bx + 1] = b.k + 1;
  if (b.k < 4) { reserved[(b.by - 2) * COLS + b.bx] = b.k + 1; reserved[(b.by - 2) * COLS + b.bx + 1] = b.k + 1; }
}
// true while (x, y) is on the two tiles right behind bench k (where its maker stands)
export function atWorkPlace(k, x, y) {
  const b = benches[k];
  if (!b) return false;
  const tx = Math.floor(x / T), ty = Math.floor(y / T);
  return ty === b.by - 1 && (tx === b.bx || tx === b.bx + 1);
}
export function reservedAt(tx, ty) { return tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS ? reserved[ty * COLS + tx] : 0; }
// The narrow row between the back-row bench fronts and the heads of the front-row makers (tile row 9). A walker
// there stands right in front of a name tag and right behind a seated maker's head, so three figures merge.
// Routes cross this row in the column aisles but do not walk along it in front of a bench: each such tile costs
// GAP_COST extra steps, so a short detour through the cross aisle is preferred.
export const GAP_COST = 9;
const gap = new Uint8Array(COLS * ROWS);
for (const b of benches) if (b.k < 4) { gap[(b.by + 1) * COLS + b.bx] = 1; gap[(b.by + 1) * COLS + b.bx + 1] = 1; }
export function gapAt(tx, ty) { return tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS ? gap[ty * COLS + tx] === 1 : false; }
// walkability for one trip: reserved tiles are open only when the trip starts or ends at that work place
function tripRule(a, b) {
  const ra = reservedAt(a.tx, a.ty), rb = reservedAt(b.tx, b.ty);
  return (tx, ty) => { if (!isWalkable(tx, ty)) return false; const r = reserved[ty * COLS + tx]; return r === 0 || r === ra || r === rb; };
}

// Feet box (9 x 5) must rest on walkable tiles.
function boxFree(x, y, ok) {
  const f = (px, py) => ok(Math.floor(px / T), Math.floor(py / T));
  return f(x - 4, y - 2) && f(x + 4, y - 2) && f(x - 4, y + 2) && f(x + 4, y + 2);
}

// Straight walk from a to b stays on walkable tiles (sampled every 2 px). ok: optional tile rule.
export function lineFree(a, b, ok = isWalkable) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
  for (let i = 0; i <= n; i++) {
    if (!boxFree(a.x + (dx * i) / n, a.y + (dy * i) / n, ok)) return false;
  }
  return true;
}

// Nearest walkable tile to (tx, ty), by ring search.
export function nearestWalkable(tx, ty) {
  tx = Math.max(0, Math.min(COLS - 1, tx)); ty = Math.max(0, Math.min(ROWS - 1, ty));
  if (isWalkable(tx, ty)) return { tx, ty };
  for (let r = 1; r < COLS; r++) {
    let best = null, bd = 1e9;
    for (let y = ty - r; y <= ty + r; y++) for (let x = tx - r; x <= tx + r; x++) {
      if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) !== r || !isWalkable(x, y)) continue;
      const d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
      if (d < bd) { bd = d; best = { tx: x, ty: y }; }
    }
    if (best) return best;
  }
  return { tx: 14, ty: 5 };
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Breadth-first search on the tile grid (4 neighbors). Returns [{tx,ty}...] including both ends, or null.
// ok: optional tile rule (default: plain walkability). extra(tx, ty): optional extra cost of stepping on a tile
// (then the search is a Dijkstra search).
export function findPath(from, to, ok = isWalkable, extra = null) {
  if (!ok(from.tx, from.ty) || !ok(to.tx, to.ty)) return null;
  if (extra) return cheapestPath(from, to, ok, extra);
  const start = from.ty * COLS + from.tx, goal = to.ty * COLS + to.tx;
  const prev = new Int16Array(COLS * ROWS).fill(-1);
  const queue = new Int16Array(COLS * ROWS);
  let head = 0, tail = 0;
  queue[tail++] = start; prev[start] = start;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goal) break;
    const cx = cur % COLS, cy = (cur - cx) / COLS;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (!ok(nx, ny)) continue;
      const ni = ny * COLS + nx;
      if (prev[ni] !== -1) continue;
      prev[ni] = cur; queue[tail++] = ni;
    }
  }
  return unwind(prev, start, goal);
}
function unwind(prev, start, goal) {
  if (prev[goal] === -1) return null;
  const out = [];
  for (let cur = goal; ; cur = prev[cur]) {
    out.push({ tx: cur % COLS, ty: Math.floor(cur / COLS) });
    if (cur === start) break;
  }
  return out.reverse();
}
// Dijkstra on the tile grid (510 tiles: a linear scan for the next tile is cheap enough and deterministic).
function cheapestPath(from, to, ok, extra) {
  const N = COLS * ROWS, start = from.ty * COLS + from.tx, goal = to.ty * COLS + to.tx;
  const dist = new Float64Array(N).fill(Infinity), done = new Uint8Array(N), prev = new Int16Array(N).fill(-1);
  dist[start] = 0; prev[start] = start;
  for (;;) {
    let cur = -1, best = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; cur = i; }
    if (cur < 0 || cur === goal) break;
    done[cur] = 1;
    const cx = cur % COLS, cy = (cur - cx) / COLS;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (!ok(nx, ny)) continue;
      const ni = ny * COLS + nx, nd = best + 1 + (extra(nx, ny) || 0);
      if (nd < dist[ni]) { dist[ni] = nd; prev[ni] = cur; }
    }
  }
  return unwind(prev, start, goal);
}

// Pixel route from one point to another: tile path, then string-pulled with line-of-sight.
// Always returns at least one point. Never crosses blocked tiles (ends are moved to the nearest walkable tile)
// and goes around the work places of other makers.
// opts.avoid(tx, ty): tiles this trip should stay away from when another way exists (soft rule). It may also be
//   a list of such rules, most important first: when no way keeps all of them, the last ones are dropped first.
// opts.lane { dx, dy }: a small personal offset for the way-points between start and end, so that walkers
//   that share a route do not walk exactly on top of each other. The end point is never moved.
// Every route avoids walking along the gap row in front of the back-row benches (gapAt) when it can.
export function route(from, to, opts) {
  const a = nearestWalkable(Math.floor(from.x / T), Math.floor(from.y / T));
  const b = nearestWalkable(Math.floor(to.x / T), Math.floor(to.y / T));
  const base = tripRule(a, b);
  const av = opts && opts.avoid;
  const rules = (Array.isArray(av) ? av : [av]).filter((f) => typeof f === 'function');
  const extra = (tx, ty) => (gap[ty * COLS + tx] ? GAP_COST : 0);
  let ok = base, tiles = null;
  for (let n = rules.length; n > 0 && !tiles; n--) {
    const use = rules.slice(0, n);
    const strict = (tx, ty) => base(tx, ty) && !use.some((f) => f(tx, ty));
    tiles = findPath(a, b, strict, extra);
    if (tiles) ok = strict;
  }
  if (!tiles) tiles = findPath(a, b, base, extra) || findPath(a, b);
  const start = pointWalkable(from.x, from.y) && boxFree(from.x, from.y, base) ? { x: from.x, y: from.y } : tileCenter(a.tx, a.ty);
  const end = pointWalkable(to.x, to.y) && boxFree(to.x, to.y, base) ? { x: to.x, y: to.y } : tileCenter(b.tx, b.ty);
  if (!tiles) return [end];
  // straight shortcuts may not cut through a gap tile the tile path itself went around
  const onPath = new Set(tiles.map((t) => t.ty * COLS + t.tx));
  const ok0 = ok;
  ok = (tx, ty) => ok0(tx, ty) && (!gap[ty * COLS + tx] || onPath.has(ty * COLS + tx));
  const pts = [start, ...tiles.map((t) => tileCenter(t.tx, t.ty)), end];
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineFree(pts[i], pts[j], ok)) j--;
    out.push(pts[j]);
    i = j;
  }
  if (!out.length) return [end];
  const lane = opts && opts.lane;
  if (lane && out.length > 1 && (lane.dx || lane.dy)) {
    for (const k of [1, 0.5]) {
      const dx = Math.round(lane.dx * k), dy = Math.round(lane.dy * k);
      if (!dx && !dy) continue;
      const moved = out.map((p, n) => (n === out.length - 1 ? p : { x: p.x + dx, y: p.y + dy }));
      let cur = start, free = true;
      for (const p of moved) { if (!lineFree(cur, p, ok)) { free = false; break; } cur = p; }
      if (free) return moved;
    }
  }
  return out;
}

// Every stand point an actor can be sent to (used by tests and debugging).
export function namedStands() {
  const out = {};
  benches.forEach((b) => { out['bench' + b.k] = b.stand; out['visit' + b.k] = b.visit; out['inspect' + b.k] = b.inspect; });
  offices.forEach((o) => { out['inbox' + o.i] = o.inboxStand; out['outbox' + o.i] = o.outboxStand; });
  posts.forEach((p) => { out['post' + p.p] = p.stand; });
  out.board = board.stand; out.entrance = entrance.stand; out.counter = counter.stand;
  out.shelves = shelves.stand; out.dollyHome = dolly.home; out.staging = staging.stand;
  offices.forEach((o) => { out['office' + o.i] = { x: o.inboxStand.x + 9, y: 90, face: 'up' }; });
  for (let s = 0; s < 3; s++) out['dock' + s] = dock.stand(s);
  return out;
}

// Hit testing for pointer events: static targets (agents and the truck are tested by the scene).
export function staticTargetAt(x, y) {
  const inR = (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  if (inR(board.rect)) return { kind: 'board', id: 'board' };
  if (inR(pegboard)) return { kind: 'toolwall', id: 'toolwall' };    // the tool pegboard: the app opens the Toolkit
  if (inR(harnessRack)) return { kind: 'harnesses', id: 'harnesses' }; // the Harness Rack: opens Harnesses & Toolkit
  if (inR(rftBay)) return { kind: 'rftbay', id: 'rftbay' };          // the RFT calibration bay: opens Phase 1 RFT queue
  if (inR(counter.rect)) return { kind: 'counter', id: 'counter' };
  for (const o of offices) if (inR(o.rect)) return { kind: 'office', id: o.i };
  for (const b of benches) if (inR({ x: b.rect.x, y: b.rect.y - 4, w: b.rect.w, h: b.rect.h + 4 })) return { kind: 'bench', id: b.k };
  return { kind: 'none', id: null };
}
