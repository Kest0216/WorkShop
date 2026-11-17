// WorkShop actors: the pure simulation behind the scene (no DOM, no canvas).
// The view model is the truth. Actors chase the state it describes; animations are decoration.
import * as M from './map.js';
import { normalize, diff, officeOf, progressStage, createWarner, mulberry32, familyOf, hashString, inspectorOf, reviewAtBench } from './model.js';
import { clampLines } from './font.js';

export const LIMITS = Object.freeze({ particles: 240, notes: 8, stamps: 8, slips: 5 });   // notes: one per slot of the cork board grid
export const ANON_NOTES = 6;      // a board with unread messages but no known notes (app start, reload) shows up to this many plain notes
export const SPEED = Object.freeze({ maker: 46, manager: 30, carry: 40, dolly: 120 });
export const DOLLY_RUSH = 2.5;    // dolly speed factor while a crate lags behind the view model (stage on_truck, not on the truck yet)
export const DOLLY_LOAD = 3;      // crates the dolly stacks on one trip when several wait at the same place
export const LATE_HOP_MS = 4000;  // a crate that is still not on the truck this long after 'on_truck' hops straight to its slot
export const SLIP_KEEP_MS = 60000; // older work-order slips leave the counter after this time (the newest one stays)
const STEP = 50;                 // ms per simulation step
const BUBBLE_MS = 4200, STAMP_MS = 1100, PAUSE_MS = 2400;
const SHIP_AWAY_MS = 2600;        // fx('ship'): how long the truck stays out of sight
const SHIP_WAIT_MS = 2000;        // shipped crates stay on a parked truck this long, waiting for fx('ship') to drive them off
export const BELL = Object.freeze({ ringMs: 700, everyMs: 1800 });   // owner.attention: the counter bell rings 0.7 s out of every 1.8 s
// a walker lets another walker right ahead of it go first: within YIELD_DIST (east-west) or YIELD_DIST_NS (north-south)
// along its heading and YIELD_SIDE across it
const YIELD_MS = 300, YIELD_DIST = 14, YIELD_DIST_NS = 24, YIELD_SIDE = 9, YIELD_COOL_MS = 250;
const CONFETTI_WAVE = 70, CONFETTI_GAP_MS = 700;
const PATROL_AVOID = (tx, ty) => ty <= 6;   // managers between two benches use the column aisles and the cross aisle
export const CARRY_LIFT = 25;     // a carried item rides this many px above the carrier's feet
const OFFICE_KINDS = { inbox: 1, desk: 1, outbox: 1 };
const STOCK_KINDS = ['lumber', 'metal', 'box'];
const NOTE_COLORS = { ask: 'sky', info: 'paper', done: 'lime', warn: 'pink' };

// Notes hang in a jittered grid of LIMITS.notes slots (4 x 2) inside the cork: x 0..48, y 0..7 relative to
// M.board.inner + 1, so an 8 x 8 note with its 1 px shadow never sticks out over the frame.
export const NOTE_MAX = Object.freeze({ x: M.board.inner.w - 10, y: M.board.inner.h - 10 });
function noteSlot(s, rng) {
  const col = s % 4, row = Math.floor(s / 4) % 2;
  const x = (row ? 6 : 0) + col * 14 + Math.floor(rng() * 3) - 1, y = (row ? 6 : 0) + Math.floor(rng() * 2);
  return { x: Math.max(0, Math.min(NOTE_MAX.x, x)), y: Math.max(0, Math.min(NOTE_MAX.y, y)) };
}

const lerp = (a, b, k) => a + (b - a) * k;
const clamp01 = (k) => (k < 0 ? 0 : k > 1 ? 1 : k);

export function createWorld(opts = {}) {
  const warn = opts.warn || createWarner();
  const rng = mulberry32(opts.seed == null ? 20261115 : opts.seed);
  const w = {
    t: 0, model: null,
    agents: new Map(), items: new Map(), itemSeq: 0,
    makerAt: new Array(M.BENCH_COUNT).fill(null), bossAt: [null, null, null], patrol: new Map(),
    inspect: new Map(),    // agent id -> { itemId, bench }: a buddy or a bench reviewer inspecting at a maker's bench
    dolly: { x: M.dolly.home.x, y: M.dolly.home.y, face: 'down', path: null, goalKey: null, moving: false, walkT: 0, job: null, carry: null, rush: false },
    truck: { state: 'away', phase: 'away', x: M.truck.enterX, x0: 0, t: 0, stock: 0, anon: 0, door: 0, horn: -1e9, puffT: 0, hold: 0, bring: false },
    shelf: { level: 4 }, lathe: { on: false, t: 0 },
    particles: [], stamps: [], notes: [], slips: [], bellT: -1e9, attentionT: -1e9, confetti: null,
    overflow: 0, attention: false, unread: 0, shop: { jobTitle: '', paused: false, statusLine: '' },
  };

  // ---------- helpers ----------
  const truckParked = () => w.truck.phase === 'parked';
  const presentMaker = (id) => { const a = w.agents.get(id); return a && a.data.present && a.data.role === 'maker' ? a : null; };
  function homeOf(ag) {
    const d = ag.data;
    if (d.role === 'boss') return M.offices[d.spot].boss;
    if (d.role === 'manager') return M.posts[d.spot].stand;
    return M.benches[d.spot].stand;
  }
  function samePlace(a, b) {
    if (a.kind !== b.kind) return false;
    if (OFFICE_KINDS[a.kind]) return a.office === b.office;
    if (a.kind === 'bench') return a.makerId === b.makerId;
    return true;
  }
  function targetOf(it) {
    switch (it.stage) {
      // checking: when a buddy check or a review at the bench comes next, the item waits on the maker's bench
      // (decided from the view model alone, so a reload lands in the same place); else it goes to the inbox
      case 'to_office':
        if ((it.buddy || it.atBench) && presentMaker(it.makerId)) return { kind: 'bench', makerId: it.makerId };
        return { kind: 'inbox', office: it.office };
      // a buddy check, and a review by a manager, happen at the maker's bench: the item stays there
      case 'buddy_check': return presentMaker(it.makerId) ? { kind: 'bench', makerId: it.makerId } : { kind: 'limbo' };
      case 'in_review':
        if (!it.atBench) return { kind: 'desk', office: it.office };
        return presentMaker(it.makerId) ? { kind: 'bench', makerId: it.makerId } : { kind: 'limbo' };
      case 'rejected': return presentMaker(it.makerId) ? { kind: 'bench', makerId: it.makerId } : { kind: 'limbo' };
      case 'to_truck':
        if (it.place && it.place.kind === 'truck') return { kind: 'truck' };
        return truckParked() ? { kind: 'truck' } : { kind: 'staging' };
      case 'on_truck':   // the view model says it is on the truck, wherever the truck is
        if (!it.place || it.place.kind === 'truck' || w.truck.phase !== 'in') return { kind: 'truck' };
        return { kind: 'staging' };
      default: return { kind: 'gone' };
    }
  }
  // rank of an item among the items bound for the truck bed / the staging pallet
  function rank(it, kind) {
    let r = 0;
    for (const o of w.items.values()) {
      if (o === it || o.seq >= it.seq) continue;
      if (o.place.kind === kind || (o.target.kind === kind && (o.place.kind === 'dolly' || o.place.kind === 'outbox' || o.place.kind === 'staging'))) r++;
    }
    return r;
  }
  function truckSlot(it) { return w.truck.anon + rank(it, 'truck'); }
  // office places (inbox, desk, outbox) hold a small queue: rank 0 is the front item
  function queueRank(it) {
    const p = it.place;
    let r = 0;
    for (const o of w.items.values()) if (o !== it && !o.ghost && o.seq < it.seq && o.place.kind === p.kind && o.place.office === p.office) r++;
    return r;
  }
  function deskBusy(office, it) {
    for (const o of w.items.values()) if (o !== it && !o.ghost && o.place && o.place.kind === 'desk' && o.place.office === office) return true;
    return false;
  }
  function queueCount(kind, office) {
    let n = 0;
    for (const o of w.items.values()) if (!o.ghost && o.place.kind === kind && o.place.office === office) n++;
    return n;
  }
  function placePos(it) {
    const p = it.place;
    switch (p.kind) {
      case 'bench': {
        const mk = presentMaker(p.makerId);
        if (!mk) return null;
        const b = M.benches[mk.data.spot];
        const main = !mk.data.task || mk.data.task.id === it.taskId;
        return main ? b.item : b.side;
      }
      case 'hand': {          // carried on the head
        const c = w.agents.get(p.agentId);
        if (!c) return null;
        return { x: c.x, y: c.y - CARRY_LIFT };
      }
      case 'inbox': case 'desk': case 'outbox': {
        if (it.q > M.QUEUE_SHOWN - 0.5) return null;          // deep in the queue: counted in the "+N" tag
        const o = M.offices[p.office], base = p.kind === 'inbox' ? o.inbox : p.kind === 'desk' ? o.deskItem : o.outbox;
        const off = M.queueOffset(p.kind, it.q);
        return { x: base.x + off.x, y: base.y + off.y };
      }
      case 'dolly': {         // crates are stacked on the dolly
        const n = w.dolly.job && w.dolly.job.ids ? Math.max(0, w.dolly.job.ids.indexOf(it.id)) : 0;
        return { x: w.dolly.x, y: w.dolly.y - 9 - 9 * n };
      }
      case 'truck': {
        const s = truckSlot(it);
        if (s >= M.truck.slots || w.truck.phase === 'away') return null;
        const o = M.truck.slot(s);
        return { x: w.truck.x + o.x, y: M.truck.y + o.y };
      }
      case 'staging': { const s = rank(it, 'staging'); return s >= 6 ? null : M.staging.slot(s); }
      default: return null;
    }
  }
  function itemPos(it) {
    const p = placePos(it);
    if (!it.slide) return p;
    if (!p) return null;
    const k = clamp01(it.slide.t / it.slide.dur), e = k * k * (3 - 2 * k);
    return { x: lerp(it.slide.x, p.x, e), y: lerp(it.slide.y, p.y, e) - Math.sin(k * Math.PI) * it.slide.hop };
  }
  function moveItem(it, place, dur, hop) {
    const from = itemPos(it);
    it.place = place;
    it.q = OFFICE_KINDS[place.kind] ? queueRank(it) : 0;
    it.slide = from && dur > 0 ? { x: from.x, y: from.y, t: 0, dur, hop: hop || 0 } : null;
  }
  function snapItem(it) {
    it.target = targetOf(it);
    let place = it.target.kind === 'gone' ? { kind: 'limbo' } : it.target;
    if (place.kind === 'desk' && deskBusy(place.office, it)) place = { kind: 'inbox', office: place.office };   // one item under review at a time
    it.place = place;
    it.q = OFFICE_KINDS[place.kind] ? queueRank(it) : 0;
    it.slide = null; it.wait = 0; it.pendingStamp = null;
  }
  const formOf = (it) => (it.place.kind === 'outbox' || it.place.kind === 'dolly' || it.place.kind === 'truck' || it.place.kind === 'staging' ? 'crate' : 'doohickey');

  function spawn(p) { if (w.particles.length < LIMITS.particles) { p.age = 0; w.particles.push(p); } }
  // work particles that fit the tooling family: sparks, sawdust, paper scraps, solder smoke
  function burst(x, y, domain) {
    const fam = familyOf(domain);
    const loud = fam === 'machine' || fam === 'paint';           // sparks and sawdust fly in a real burst
    const n = (loud ? 4 : 2) + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI, s = 18 + rng() * 30;
      const base = { x: x + rng() * 6 - 3, y: y - 6, vx: Math.cos(a) * s, vy: -Math.abs(Math.sin(a) * s) - 10, g: 120, life: 420 + rng() * 260, kind: 'px', size: rng() < 0.35 ? 2 : 1 };
      if (fam === 'machine') spawn({ ...base, color: rng() < 0.5 ? 'yellow' : 'amber', flash: 'white', g: 90, life: 280 + rng() * 200 });
      else if (fam === 'paint') spawn({ ...base, color: rng() < 0.5 ? 'wood6' : 'wood5', flash: 'white' });
      else if (fam === 'study') spawn({ ...base, color: rng() < 0.5 ? 'sky' : 'yellow', flash: 'white', g: -10, vy: -14 - rng() * 10, vx: base.vx * 0.3, life: 600 });
      else if (fam === 'gauge') spawn({ ...base, color: rng() < 0.7 ? 'lime' : 'red', flash: 'white', g: 0, vx: base.vx * 0.4, vy: -18, life: 380 });
      else if (fam === 'solder') spawn({ x: x + rng() * 4 - 2, y: y - 9, vx: rng() * 6 - 3, vy: -14 - rng() * 6, g: -4, life: 900, color: 'steel5', kind: 'smoke' });
      else spawn({ ...base, color: rng() < 0.5 ? 'paper' : 'white', g: 60, life: 700, kind: 'scrap' });
    }
  }
  // pin a note in a grid slot (the first free one when none is given)
  function addNote(p, t0, slot, anon) {
    if (slot == null) { const used = new Set(w.notes.map((n) => n.slot)); slot = 0; while (used.has(slot)) slot++; }
    const kind = NOTE_COLORS[p.kind] ? p.kind : 'info';
    w.notes.push({ ...noteSlot(slot, rng), slot, color: NOTE_COLORS[kind], kind, anon: !!anon,
      from: String(p.from == null ? '' : p.from).slice(0, 16), text: String(p.text == null ? '' : p.text).slice(0, 60), t0 });
  }
  function puff(x, y) { spawn({ x: x + rng() * 2 - 1, y, vx: -5 - rng() * 6, vy: -11 - rng() * 3, g: 0, life: 900, color: 'steel5', kind: 'puff' }); }
  function confettiWave(n) {
    const cols = ['red', 'amber', 'lime', 'sky', 'pink', 'white', 'orange', 'teal'];
    for (let i = 0; i < CONFETTI_WAVE; i++) {
      // wave 0 pops all over the shop, wave 1 rains down from the top
      const y = n === 0 ? 6 + rng() * (M.FRONT_WALL_Y - 12) : -8 + rng() * 44;
      spawn({ x: 8 + rng() * (M.W - 16), y, vx: rng() * 50 - 25, vy: (n === 0 ? -55 : -20) + rng() * 50, g: 55, life: 2400 + rng() * 2400, color: cols[i % cols.length], kind: 'conf' });
    }
  }
  // another walker is moving the same way right in front of this one. "In front" depends on the heading: two
  // figures one behind the other on a north-south line merge into one tall totem unless their feet are a full
  // body height apart, side by side they only need a body width.
  function walkerAhead(o) {
    const p = o.path[0];
    let hx = p.x - o.x, hy = p.y - o.y;
    const hl = Math.hypot(hx, hy);
    if (hl < 0.01) return false;
    hx /= hl; hy /= hl;
    const reach = Math.abs(hy) > Math.abs(hx) ? YIELD_DIST_NS : YIELD_DIST;
    for (const b of w.agents.values()) {
      if (b === o || !b.moving || !b.data.present || !b.path || !b.path.length) continue;
      const vx = b.x - o.x, vy = b.y - o.y, d = Math.hypot(vx, vy);
      if (d > reach) continue;
      const along = vx * hx + vy * hy, side = Math.abs(vx * hy - vy * hx);
      if (side > YIELD_SIDE) continue;
      const q = b.path[0];
      if ((q.x - b.x) * hx + (q.y - b.y) * hy <= 0) continue;            // coming the other way: just pass
      if (d < 1 ? o.id > b.id : along > 0) return true;
    }
    return false;
  }
  // Tiles a new route should keep off: where other agents stand still (their feet tile and the tiles right above
  // and below it), so a walker does not pass straight through or right behind a standing figure.
  function standRule(o, goal) {
    const occ = new Set();
    const g = M.tileAt(goal.x, goal.y), s = M.tileAt(o.x, o.y);
    for (const b of w.agents.values()) {
      if (b === o || b.moving || !b.data.present || b.data.role === 'boss') continue;
      const t = M.tileAt(b.x, b.y);
      for (const dy of [-1, 0, 1]) occ.add((t.ty + dy) * M.COLS + t.tx);
    }
    occ.delete(g.ty * M.COLS + g.tx); occ.delete(s.ty * M.COLS + s.tx);
    return occ.size ? (tx, ty) => occ.has(ty * M.COLS + tx) : null;
  }

  // walk one object along its path; returns true when it stands at the goal
  // Agents carry a personal lane offset and give way to a walker right ahead (the dolly does neither).
  function goTo(o, pt, key, speed, dt, avoid) {
    if (o.goalKey !== key) {
      o.goalKey = key; o.goalFace = pt.face || null;
      // soft rules, most important first: the caller's rule (a patrol keeps out of the office aisle), then the stand points of others
      const rules = [avoid, o.lane ? standRule(o, pt) : null].filter(Boolean);
      o.path = M.route({ x: o.x, y: o.y }, pt, o.lane || rules.length ? { lane: o.lane, avoid: rules } : undefined);
    }
    if (!o.path || !o.path.length) { o.path = null; o.moving = false; if (o.goalFace) o.face = o.goalFace; return true; }
    if (o.lane) {
      if (o.yieldT > 0) { o.yieldT -= dt; o.moving = false; if (o.yieldT <= 0) o.yieldCool = YIELD_COOL_MS; return false; }
      if (o.yieldCool > 0) o.yieldCool -= dt;
      else if (walkerAhead(o)) { o.yieldT = YIELD_MS; o.moving = false; return false; }
    }
    let left = (speed * dt) / 1000;
    while (left > 0 && o.path.length) {
      const p = o.path[0], dx = p.x - o.x, dy = p.y - o.y, dist = Math.hypot(dx, dy);
      if (dist > 0.01) o.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      if (dist <= left) { o.x = p.x; o.y = p.y; o.path.shift(); left -= dist; } else { o.x += (dx / dist) * left; o.y += (dy / dist) * left; left = 0; }
    }
    o.walkT += dt;
    if (o.path.length) { o.moving = true; return false; }
    o.path = null; o.moving = false; if (o.goalFace) o.face = o.goalFace;
    return true;
  }

  // ---------- agents ----------
  function updateAgent(ag, dt) {
    const d = ag.data;
    ag.idleT += dt;
    if (ag.bubble && w.t > ag.bubble.until) ag.bubble = null;
    if (!d.present) return;
    const home = homeOf(ag);
    if (d.role === 'boss') { ag.x = home.x; ag.y = home.y; ag.face = 'down'; ag.moving = false; ag.atHome = true; return; }
    if (ag.errand) {
      const it = w.items.get(ag.errand.itemId), e = ag.errand;
      const inHand = it && it.place.kind === 'hand' && it.place.agentId === ag.id;
      if (!it || it.ghost) ag.errand = null;
      else if (inHand) {
        const back = it.target.kind === 'bench' || it.target.kind === 'limbo' || it.target.kind === 'gone';
        if (back) {
          if (goTo(ag, home, 'home', SPEED.carry, dt)) { moveItem(it, { kind: 'bench', makerId: ag.id }, 140, 2); ag.errand = null; }
        } else if (it.target.kind === 'truck' || it.target.kind === 'staging') {
          // passed at the bench (a manager review): no boss office is involved. The maker carries the crate to the
          // staging pallet by the dock, where the dolly picks it up.
          if (goTo(ag, M.staging.stand, 'staging', SPEED.carry, dt)) { moveItem(it, { kind: 'staging' }, 220, 4); ag.errand = null; }
        } else {
          const o = M.offices[it.office];
          if (goTo(ag, o.inboxStand, 'inbox' + it.office, SPEED.carry, dt)) { moveItem(it, { kind: 'inbox', office: it.office }, 220, 4); ag.errand = null; }
        }
      } else if (e.type === 'deliver') {
        if (it.place.kind !== 'bench' || it.place.makerId !== ag.id || it.target.kind === 'bench') ag.errand = null;
        else if (goTo(ag, home, 'home', SPEED.maker, dt) && !it.slide) moveItem(it, { kind: 'hand', agentId: ag.id }, 140, 2);
      } else {
        if (it.target.kind !== 'bench' || !OFFICE_KINDS[it.place.kind]) ag.errand = null;
        else if (goTo(ag, M.offices[it.place.office].inboxStand, 'inbox' + it.place.office, SPEED.maker, dt) && it.place.kind === 'inbox' && !it.slide && it.wait <= 0) {
          moveItem(it, { kind: 'hand', agentId: ag.id }, 160, 3);
        }
      }
      ag.atHome = false; ag.noting = false; ag.inspecting = false;
      if (ag.errand) return;
    }
    // buddy check or bench review: walk to the maker's bench, inspect the item with a magnifier, then walk back
    const insp = w.inspect.get(ag.id);
    if (insp) {
      const b = M.benches[insp.bench], it = w.items.get(insp.itemId);
      ag.atHome = false; ag.noting = false;
      const there = goTo(ag, b.inspect, 'inspect' + b.k, SPEED[d.role] || SPEED.maker, dt);
      ag.inspecting = there && !!it && it.place.kind === 'bench' && !it.slide;
      return;
    }
    ag.inspecting = false;
    if (d.role === 'manager') {
      const list = w.patrol.get(ag.id);
      if ((d.activity === 'work' || d.activity === 'review') && list && list.length) {
        const b = M.benches[list[ag.patrolI % list.length]];
        ag.atHome = false;
        // between two benches: along the column aisles and the cross aisle, not through the office aisle
        if (goTo(ag, b.visit, 'visit' + b.k, SPEED.manager, dt, ag.y >= 112 ? PATROL_AVOID : null)) {
          ag.noting = true; ag.pauseT += dt;
          if (ag.pauseT > PAUSE_MS) { ag.pauseT = 0; ag.patrolI++; ag.noting = false; }
        } else { ag.noting = false; ag.pauseT = 0; }
        return;
      }
      ag.noting = false;
    }
    ag.atHome = goTo(ag, home, 'home', SPEED[d.role] || SPEED.maker, dt);
    if (ag.atHome && d.role === 'maker' && d.activity === 'work' && d.task) {
      const before = Math.floor((ag.workT + 350) / 700);
      ag.workT += dt;
      if (Math.floor((ag.workT + 350) / 700) > before) { const b = M.benches[d.spot]; burst(b.item.x, b.item.y, d.task.domain); }
    }
  }

  // ---------- items ----------
  function updateItem(it, dt) {
    if (it.ghost) return;
    it.target = targetOf(it);
    if (it.slide) { it.slide.t += dt; if (it.slide.t >= it.slide.dur) it.slide = null; }
    if (OFFICE_KINDS[it.place.kind]) { const d = queueRank(it) - it.q, m = dt / 120; it.q += d > m ? m : d < -m ? -m : d; }   // close ranks smoothly
    it.late = it.stage === 'on_truck' && it.place.kind !== 'truck' ? it.late + dt : 0;
    const p = it.place, t = it.target;
    if (t.kind === 'gone') { w.items.delete(it.id); return; }
    if (p.kind === 'hand') {
      const c = w.agents.get(p.agentId);
      if (!c || !c.data.present || !c.errand || c.errand.itemId !== it.id) snapItem(it);
      return;
    }
    if (p.kind === 'dolly') { const j = w.dolly.job; if (!j || j.type !== 'crate' || !j.ids.includes(it.id)) snapItem(it); return; }
    const stamp = () => {
      if (!it.pendingStamp) return false;
      const pos = placePos(it);
      if (pos) { if (w.stamps.length >= LIMITS.stamps) w.stamps.shift(); w.stamps.push({ x: pos.x, y: pos.y - 6, kind: it.pendingStamp, t0: w.t }); }
      it.pendingStamp = null; it.wait = 900;
      return true;
    };
    // a review at the bench ends with a stamp right there (FAIL: the item stays; PASS: the maker carries it off after the stamp)
    if (samePlace(p, t)) { if (p.kind === 'bench' && !it.slide) { if (stamp()) it.wait = 0; } else it.pendingStamp = null; return; }
    if (t.kind === 'truck' && !truckParked() && !it.slide) { snapItem(it); return; }   // truck is not at the dock: it rides out of sight
    if (it.wait > 0) { it.wait -= dt; return; }
    if (it.slide) return;
    if (p.kind === 'bench' && stamp()) return;
    const viaMaker = (type) => {
      const mk = presentMaker(it.makerId);
      if (!mk) return false;
      if (!mk.errand) mk.errand = { type, itemId: it.id };
      return true;
    };
    if (t.kind === 'bench') {
      if (p.kind === 'desk' || p.kind === 'outbox') { if (!stamp()) moveItem(it, { kind: 'inbox', office: p.office }, 450, 3); }
      else if (p.kind === 'inbox') { if (!stamp() && !viaMaker('fetch')) snapItem(it); }
      else snapItem(it);
    } else if (t.kind === 'inbox' || t.kind === 'desk') {
      if (p.kind === 'bench') { if (!viaMaker('deliver')) snapItem(it); }
      else if (OFFICE_KINDS[p.kind] && p.office === t.office) {
        // only one item is under review: the others wait in the inbox until the desk is free
        if (t.kind === 'desk' && deskBusy(t.office, it)) { if (p.kind !== 'inbox') moveItem(it, { kind: 'inbox', office: t.office }, 450, 3); }
        else moveItem(it, t, 450, 3);
      } else snapItem(it);
    } else if (t.kind === 'truck' || t.kind === 'staging') {
      if (p.kind === 'bench') { if (!viaMaker('deliver')) snapItem(it); }
      else if (p.kind === 'inbox' || p.kind === 'desk') { if (!stamp()) moveItem(it, { kind: 'outbox', office: p.office }, 500, 4); }
      else if (p.kind === 'outbox' || p.kind === 'staging') {
        // waits for the dolly; a crate the view model has had on the truck for a while hops straight to its slot
        if (t.kind === 'truck' && it.late > LATE_HOP_MS && truckParked()) moveItem(it, { kind: 'truck' }, 520, 16);
      }
      else snapItem(it);
    } else snapItem(it);
  }

  // ---------- dolly ----------
  const dollyWants = (it) => !it.ghost && !it.slide && it.wait <= 0 && (it.place.kind === 'outbox' || it.place.kind === 'staging')
    && (it.target.kind === 'truck' || it.target.kind === 'staging') && !samePlace(it.place, it.target);
  function updateDolly(dt) {
    const D = w.dolly;
    // catch-up: the view model already has a crate on the truck that is still on its way
    let rush = false;
    if (truckParked()) for (const it of w.items.values()) if (!it.ghost && it.stage === 'on_truck' && it.place.kind !== 'truck' && it.target.kind === 'truck') { rush = true; break; }
    D.rush = rush;
    const speed = SPEED.dolly * (rush ? DOLLY_RUSH : 1);
    const job = D.job;
    if (job && job.type === 'crate') {
      const held = [];
      for (const id of job.ids) { const it = w.items.get(id); if (it && !it.ghost && it.place.kind === 'dolly') held.push(it); }
      if (held.length) {
        const keep = [];
        for (const it of held) { if ((it.target.kind === 'truck' && truckParked()) || it.target.kind === 'staging') keep.push(it); else snapItem(it); }
        job.ids = keep.map((it) => it.id);
        if (!keep.length) D.job = null;
        else {
          const dest = keep[0].target.kind, s = dest === 'truck' ? truckSlot(keep[0]) : 0;
          if (goTo(D, dest === 'truck' ? M.dock.stand(s) : M.staging.stand, dest === 'truck' ? 'dock' + (s % 3) : 'staging', speed, dt)) {
            let n = 0;
            for (const it of keep) if (it.target.kind === dest) { moveItem(it, { kind: dest }, (dest === 'truck' ? 300 : 260) + 90 * n, dest === 'truck' ? 7 : 5); n++; }
            job.ids = keep.filter((it) => it.place.kind === 'dolly').map((it) => it.id);
            if (!job.ids.length) D.job = null;
          }
        }
      } else {
        const first = w.items.get(job.ids[0]);
        if (!first || !dollyWants(first)) D.job = null;
        else {
          const src = first.place;
          const st = src.kind === 'outbox' ? M.offices[src.office].outboxStand : M.staging.stand;
          if (goTo(D, st, 'src' + src.kind + (src.office || 0), speed, dt)) {
            const load = [first];       // take along what else waits here for the same destination
            for (const it of w.items.values()) {
              if (load.length >= DOLLY_LOAD) break;
              if (it !== first && dollyWants(it) && samePlace(it.place, src) && it.target.kind === first.target.kind) load.push(it);
            }
            job.ids = load.map((it) => it.id);
            load.forEach((it, n) => moveItem(it, { kind: 'dolly' }, 200 + 70 * n, 4));
          }
        }
      }
    } else if (job && job.type === 'stock') {
      if (!D.carry) {
        if (!truckParked() || w.truck.stock <= 0) D.job = null;
        else if (goTo(D, M.dock.stand(3 - w.truck.stock), 'stock' + w.truck.stock, speed, dt)) {
          w.truck.stock--; D.carry = STOCK_KINDS[w.truck.stock % 3];
        }
      } else if (goTo(D, M.shelves.stand, 'shelves', speed, dt)) {
        w.shelf.level = Math.min(M.shelves.max, w.shelf.level + 1); D.carry = null; D.job = null;
      }
    }
    if (!D.job) {
      let best = null;
      for (const it of w.items.values()) if (dollyWants(it) && (!best || it.seq < best.seq)) best = it;
      if (best) D.job = { type: 'crate', ids: [best.id] };
      else if (truckParked() && w.truck.stock > 0 && w.truck.t > 500) D.job = { type: 'stock' };
      else if (D.carry) D.job = { type: 'stock' };
      else goTo(D, M.dolly.home, 'home', speed, dt);
    }
  }

  // ---------- truck ----------
  function removeGhosts() { for (const it of [...w.items.values()]) if (it.ghost) w.items.delete(it.id); }
  // crates on the truck that the scene has no item for: the count of the view model, less the crates it draws as items
  // (on_truck deliveries, and shipped crates that still ride as ghosts), so no crate is drawn twice
  const anonOf = (model) => {
    if (!model) return 0;
    let drawn = model.deliveries.reduce((n, d) => n + (d.stage === 'on_truck' ? 1 : 0), 0);
    for (const it of w.items.values()) if (it.ghost && it.place && it.place.kind === 'truck') drawn++;
    return Math.max(0, model.truck.crates - drawn);
  };
  const truckWanted = () => w.truck.hold <= 0 && (w.truck.state === 'returning' || w.truck.state === 'docked' || w.truck.state === 'ready');
  function truckLeave() {
    const T = w.truck;
    T.phase = 'out'; T.t = 0; T.x0 = T.x; T.horn = w.t; T.puffT = 0;
    w.shelf.level = Math.min(M.shelves.max, w.shelf.level + T.stock); T.stock = 0;
  }
  function truckArrive() {
    const T = w.truck;
    removeGhosts();
    T.phase = 'in'; T.t = 0; T.x = M.truck.enterX;
    if (T.bring) { T.stock = 3; w.shelf.level = Math.min(w.shelf.level, 3); T.bring = false; }
  }
  // The truck chases the state of the view model: park when it should be there, drive off when it should not.
  function updateTruck(dt) {
    const T = w.truck;
    T.t += dt;
    if (T.hold > 0) T.hold = Math.max(0, T.hold - dt);
    const want = truckWanted();
    if (T.phase === 'in') {
      const k = clamp01(T.t / 3200);
      T.x = lerp(M.truck.enterX, M.truck.parkX, 1 - (1 - k) * (1 - k));
      T.puffT += dt;
      if (T.puffT > 240 && k < 0.9) { T.puffT = 0; puff(T.x + M.truck.exhaust.x, M.truck.y + M.truck.exhaust.y); }
      if (k >= 1) { T.phase = 'parked'; T.t = 0; T.x = M.truck.parkX; }
    } else if (T.phase === 'out') {
      const k = clamp01((T.t - 700) / 2800);
      T.x = lerp(T.x0, M.truck.exitX, k * k);
      if (T.t > 250) {            // the engine starts: puffs rise from the stack behind the cab
        T.puffT += dt;
        if (T.puffT > 110) { T.puffT = 0; puff(T.x + M.truck.exhaust.x, M.truck.y + M.truck.exhaust.y); }
      }
      if (k >= 1) { T.phase = 'away'; T.t = 0; T.x = M.truck.enterX; removeGhosts(); T.anon = anonOf(w.model); }
    } else if (T.phase === 'parked') {
      if (!want) truckLeave();
    } else if (want) truckArrive();
    const open = T.phase === 'away' ? 0 : 1;
    T.door += Math.sign(open - T.door) * Math.min(Math.abs(open - T.door), dt / 700);
  }
  function applyTruck(state, initial) {
    const T = w.truck;
    T.state = state;
    if (initial) {
      const present = state === 'returning' || state === 'docked' || state === 'ready';
      T.hold = 0; T.bring = false;
      T.phase = present ? 'parked' : 'away'; T.x = present ? M.truck.parkX : M.truck.enterX;
      T.stock = 0; T.door = present ? 1 : 0; T.t = 1e6;
      return;
    }
    // A truck that returns after a ship comes back empty (see fx('ship')).
  }

  // ---------- sync ----------
  const planning = (a) => a.present && a.activity === 'think' && !!a.task && a.task.domain === 'plan';
  function sync(vm) {
    let next;
    try { next = normalize(vm, w.model, warn); } catch (e) { warn('normalize', 'view model rejected: ' + (e && e.message)); return; }
    const events = diff(w.model, next);
    const initial = !w.model;
    const prevAnon = w.truck.anon;
    w.model = next;
    if (next.owner.attention && !w.attention) w.attentionT = w.t;      // the bell starts ringing right away
    w.shop = next.shop; w.overflow = next.overflow; w.attention = next.owner.attention; w.unread = next.board.unread;
    // unread messages but no notes we know of (app start, reload): plain notes, already hanging
    if (!w.notes.length && w.unread > 0) {
      const kinds = ['info', 'ask', 'done', 'info', 'warn', 'ask'];
      for (let k = 0; k < Math.min(w.unread, ANON_NOTES); k++) addNote({ kind: kinds[k] }, -1e9, null, true);
    }

    // agents
    for (const id of [...w.agents.keys()]) if (!next.agentById.has(id)) w.agents.delete(id);
    w.makerAt.fill(null); w.bossAt.fill(null);
    for (const a of next.agents) {
      let ag = w.agents.get(a.id);
      const fresh = !ag;
      if (!ag) {
        const h = hashString(a.id);
        ag = { id: a.id, data: a, x: 0, y: 0, face: 'down', path: null, goalKey: null, goalFace: null, moving: false, walkT: 0, errand: null,
          atHome: false, noting: false, patrolI: 0, pauseT: 0, workT: rng() * 700, idleT: rng() * 6000, bubble: null, sentTask: null,
          lane: { dx: (h % 7) - 3, dy: ((h >>> 5) % 7) - 3 }, yieldT: 0, yieldCool: 0 };
        w.agents.set(a.id, ag);
      }
      const was = ag.data;
      ag.data = a;
      // a boss that starts to plan has picked up a work order: one old slip leaves the counter (the newest stays)
      if (!initial && !fresh && a.role === 'boss' && planning(a) && !planning(was) && w.slips.length > 1) w.slips.shift();
      if (a.present) {
        if (a.role === 'maker') w.makerAt[a.spot] = ag; else if (a.role === 'boss') w.bossAt[a.spot] = ag;
        const moved = fresh || !was.present || was.role !== a.role || was.spot !== a.spot;
        if (moved) {
          ag.goalKey = null; ag.path = null; ag.errand = null;
          const h = homeOf(ag);
          if (initial || a.role === 'boss') { ag.x = h.x; ag.y = h.y; ag.face = 'down'; }
          else if (fresh || !was.present) { ag.x = M.entrance.stand.x; ag.y = M.entrance.stand.y; ag.face = 'down'; }
        }
      } else { ag.errand = null; ag.path = null; ag.goalKey = null; ag.bubble = null; }
    }
    for (const e of events) {
      if (e.type !== 'bubble') continue;
      const ag = w.agents.get(e.id);
      if (ag && ag.data.present && ag.data.bubble) ag.bubble = { lines: clampLines(ag.data.bubble.text, 108, 2), kind: ag.data.bubble.kind, t0: w.t, until: w.t + BUBBLE_MS };
    }
    // inspections at a maker's bench (buddy check, review by a manager): one per inspector, the oldest delivery first
    w.inspect.clear();
    for (const d of next.deliveries) {
      const a = inspectorOf(next, d);
      if (a && !w.inspect.has(a.id)) w.inspect.set(a.id, { itemId: d.id, bench: next.agentById.get(d.makerId).spot });
    }
    // patrol lists: working makers are shared between the patrolling managers (an inspecting manager does not patrol)
    w.patrol.clear();
    const mgrs = next.agents.filter((a) => a.present && a.role === 'manager' && (a.activity === 'work' || a.activity === 'review') && !w.inspect.has(a.id)).sort((a, b) => a.spot - b.spot);
    const busy = next.agents.filter((a) => a.present && a.role === 'maker' && a.activity === 'work').sort((a, b) => a.spot - b.spot);
    mgrs.forEach((m) => w.patrol.set(m.id, []));
    busy.forEach((mk, j) => { if (mgrs.length) w.patrol.get(mgrs[j % mgrs.length].id).push(mk.spot); });

    // truck (before items, so that shipped crates can ride away with it)
    if (initial) applyTruck(next.truck.state, true);
    else if (w.truck.state !== next.truck.state) applyTruck(next.truck.state, false);
    if (w.truck.phase === 'parked' && !truckWanted()) truckLeave();      // leave now, so that shipped crates ride away with it

    // items
    for (const it of [...w.items.values()]) {
      const d = next.deliveryById.get(it.id);
      if (d && d.stage !== 'shipped') continue;
      // shipped crates ride away with the truck; on a parked truck they wait a moment for fx('ship')
      if (it.place.kind === 'truck' && (w.truck.phase === 'out' || (w.truck.phase === 'parked' && d))) { if (!it.ghost) { it.ghost = true; it.ghostT = w.t; } }
      else w.items.delete(it.id);
    }
    for (const d of next.deliveries) {
      if (d.stage === 'shipped') continue;
      let it = w.items.get(d.id);
      if (it && it.ghost) { w.items.delete(d.id); it = null; }
      const office = officeOf(next, d), atBench = reviewAtBench(next, d), buddy = !!d.buddyId && d.buddyId !== d.makerId;
      if (!it) {
        it = { id: d.id, seq: ++w.itemSeq, taskId: d.taskId, domain: d.domain, makerId: d.makerId, stage: d.stage, office, atBench, buddy,
          place: null, target: null, slide: null, wait: 0, pendingStamp: null, ghost: false, q: 0, late: 0 };
        w.items.set(d.id, it);
        if (!initial && d.stage === 'to_office' && presentMaker(d.makerId)) { it.place = { kind: 'bench', makerId: d.makerId }; it.target = targetOf(it); }
        else snapItem(it);
      } else {
        const from = it.stage;
        it.taskId = d.taskId; it.domain = d.domain; it.makerId = d.makerId; it.stage = d.stage; it.office = office; it.atBench = atBench; it.buddy = buddy;
        const stampHere = OFFICE_KINDS[it.place.kind] || (it.place.kind === 'bench' && from === 'in_review');   // the verdict is stamped where the review happened
        if (from !== d.stage && stampHere) it.pendingStamp = d.stage === 'rejected' ? 'fail' : d.stage === 'to_truck' ? 'pass' : null;
        it.target = targetOf(it);
      }
      const mk = w.agents.get(d.makerId);
      if (mk && mk.data.task && mk.data.task.id === d.taskId) mk.sentTask = d.taskId;
    }
    // anonymous crates, after the items: a shipped crate that rides as a ghost is not counted again
    const anon = anonOf(next);
    w.truck.anon = w.truck.phase === 'out' ? Math.max(prevAnon, anon) : anon;
    if (initial) snap();
  }

  // Put every actor directly into the steady state of the current model (reload, resume after hidden).
  // One-shot decoration that arrived in the meantime is dropped or settled: nothing old is replayed.
  function snap() {
    for (const ag of w.agents.values()) {
      ag.errand = null; ag.path = null; ag.goalKey = null; ag.moving = false; ag.noting = false; ag.pauseT = 0;
      ag.bubble = null; ag.yieldT = 0; ag.yieldCool = 0; ag.inspecting = false;
      if (!ag.data.present) continue;
      const insp = ag.data.role !== 'boss' && w.inspect.get(ag.id);
      const h = insp ? M.benches[insp.bench].inspect : homeOf(ag);       // an inspector stands at the bench it inspects
      ag.x = h.x; ag.y = h.y; ag.face = h.face || 'down'; ag.atHome = !insp; ag.inspecting = !!insp;
      if (insp) ag.goalKey = 'inspect' + insp.bench;
    }
    if (w.model) applyTruck(w.model.truck.state, true);
    w.truck.horn = -1e9; w.truck.puffT = 0;
    removeGhosts();
    w.truck.anon = anonOf(w.model);   // a truck that was driving off when the pause began holds what the view model says now
    for (const it of w.items.values()) if (it.place && it.place.kind === 'desk') it.place = { kind: 'limbo' };   // the desks are handed out again, in order
    for (const it of w.items.values()) snapItem(it);
    const D = w.dolly;
    D.x = M.dolly.home.x; D.y = M.dolly.home.y; D.face = 'down'; D.path = null; D.goalKey = null; D.job = null; D.carry = null; D.moving = false; D.rush = false;
    w.particles.length = 0; w.stamps.length = 0; w.confetti = null;
    for (const n of w.notes) n.t0 = -1e9;                       // notes hang, slips lie: no slide-in
    if (w.slips.length > 1) w.slips.splice(0, w.slips.length - 1);
    for (const sl of w.slips) sl.t0 = -1e9;
    w.bellT = -1e9;
  }

  // ---------- time ----------
  function step(dt) {
    w.t += dt;
    updateTruck(dt);
    for (const it of [...w.items.values()]) updateItem(it, dt);
    for (const ag of w.agents.values()) updateAgent(ag, dt);
    updateDolly(dt);
    // ambient: the lathe turns while a machine-family maker (backend, algo) works at a bench
    let lathe = false;
    for (const mk of w.makerAt) if (mk && mk.atHome && mk.data.activity === 'work' && mk.data.task && familyOf(mk.data.task.domain) === 'machine') { lathe = true; break; }
    w.lathe.on = lathe;
    if (lathe) {
      w.lathe.t += dt;
      if (w.lathe.t > 420) {
        w.lathe.t = 0;
        for (let i = 0; i < 2; i++) spawn({ x: M.machine.sparks.x + rng() * 2, y: M.machine.sparks.y, vx: 10 + rng() * 26, vy: -26 - rng() * 22, g: 110, life: 260 + rng() * 160, color: rng() < 0.5 ? 'yellow' : 'amber', flash: 'white', kind: 'px', size: 1 });
      }
    }
    if (w.confetti && w.t >= w.confetti.at) { w.confetti = null; confettiWave(1); }
    // shipped crates on a parked truck that no fx('ship') drove off: they were unloaded
    if (w.truck.phase === 'parked') for (const it of [...w.items.values()]) if (it.ghost && w.t - (it.ghostT || 0) > SHIP_WAIT_MS) w.items.delete(it.id);
    while (w.slips.length > 1 && w.t - w.slips[0].t0 > SLIP_KEEP_MS) w.slips.shift();
    const ps = w.particles;
    let n = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt; p.age += dt;
      if (p.life <= 0 || p.y > M.H + 4) continue;
      p.vy += (p.g * dt) / 1000; p.x += (p.vx * dt) / 1000; p.y += (p.vy * dt) / 1000;
      ps[n++] = p;
    }
    ps.length = n;
    while (w.stamps.length && w.t - w.stamps[0].t0 > STAMP_MS) w.stamps.shift();
  }
  function advance(ms) {
    let left = Number.isFinite(ms) && ms > 0 ? ms : 0;
    while (left > 0) { const dt = Math.min(STEP, left); step(dt); left -= dt; }
  }

  // ---------- one-shot effects ----------
  function fx(name, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (name === 'newOrder') {
      if (w.slips.length >= LIMITS.slips) w.slips.shift();
      w.slips.push({ t0: w.t, tilt: Math.floor(rng() * 3) - 1 }); w.bellT = w.t;
    } else if (name === 'confetti') {
      confettiWave(0);                      // two waves: a pop across the whole shop, then a rain from the top
      w.confetti = { at: w.t + CONFETTI_GAP_MS };
    } else if (name === 'horn') {
      w.truck.horn = w.t;
    } else if (name === 'ship') {         // the truck leaves, stays away for a moment, returns empty and docks
      // { restock: true } brings stock back for the dolly (the scene demo). The app never asks for it: a truck that comes
      // back loaded after a ship reads as "the crates came back".
      const T = w.truck;
      T.hold = (T.phase === 'parked' || T.phase === 'in' ? 3500 : 0) + SHIP_AWAY_MS;
      T.bring = p.restock === true;
    } else if (name === 'note') {
      // a real note takes the place of a plain one from the start-up fill, else of the oldest note
      const anon = w.notes.findIndex((n) => n.anon);
      let slot;
      if (anon >= 0) slot = w.notes.splice(anon, 1)[0].slot;
      else if (w.notes.length >= LIMITS.notes) slot = w.notes.shift().slot;
      addNote(p, w.t, slot);
    } else warn('fx:' + String(name).slice(0, 20), 'unknown effect "' + String(name).slice(0, 20) + '"');
  }

  // ---------- views for the renderer and tests ----------
  function benchInfo(k) {
    const mk = w.makerAt[k];
    if (!mk || !mk.data.task) return { maker: mk, domain: null, wip: false, stage: 0 };
    const task = mk.data.task;
    let has = mk.sentTask === task.id;
    if (!has) for (const it of w.items.values()) if (it.makerId === mk.id && it.taskId === task.id) { has = true; break; }
    return { maker: mk, domain: task.domain, wip: !has, stage: progressStage(task.progress) };
  }
  function itemView(it) {
    const pos = itemPos(it);
    const mk = presentMaker(it.makerId);
    const live = it.place.kind === 'bench' && mk && mk.data.task && mk.data.task.id === it.taskId;
    return { id: it.id, domain: it.domain, form: formOf(it), place: it.place.kind, office: it.place.office, stage: it.stage,
      growth: live ? progressStage(mk.data.task.progress) : 3, x: pos ? pos.x : null, y: pos ? pos.y : null, hidden: !pos, seq: it.seq,
      // to_office on the bench: the maker runs its own checks (a gauge on the item) until the buddy or the reviewer comes
      checking: it.stage === 'to_office' && it.place.kind === 'bench' && !it.slide, makerId: it.makerId };
  }
  // items per office place: [{ office, kind, count }] for the places that hold something
  function queues() {
    const out = [];
    for (const o of M.offices) for (const kind of ['inbox', 'desk', 'outbox']) { const n = queueCount(kind, o.i); if (n) out.push({ office: o.i, kind, count: n }); }
    return out;
  }
  const reviewing = (office) => { for (const it of w.items.values()) if (it.place.kind === 'desk' && it.place.office === office && !it.slide) return true; return false; };
  function truckView() {
    let riding = 0;
    for (const it of w.items.values()) if (it.place.kind === 'truck') riding++;
    const total = w.truck.anon + riding;
    return { ...w.truck, visible: w.truck.phase !== 'away', anon: Math.min(w.truck.anon, M.truck.slots), total, extra: Math.max(0, total - M.truck.slots),
      beacon: w.truck.phase === 'parked' && w.truck.state === 'ready' };   // owner.attention never lights it: that is the bell's job
  }
  // The counter bell: one ring per new work order; while owner.attention is on it rings again and again.
  // age: ms since the current ring started (the renderer animates the strike, the wobble, the sound arcs and the notes).
  function bellView() {
    let start = w.bellT;
    if (w.attention) {
      const k = Math.max(0, w.t - w.attentionT);
      const s = w.t - (k % BELL.everyMs);
      if (s > start) start = s;
    }
    const age = w.t - start;
    return { ringing: age >= 0 && age < BELL.ringMs, age, attention: w.attention };
  }
  function state() {
    const agents = {}, items = {};
    for (const ag of w.agents.values()) {
      agents[ag.id] = { x: Math.round(ag.x * 10) / 10, y: Math.round(ag.y * 10) / 10, face: ag.face, present: ag.data.present, role: ag.data.role, spot: ag.data.spot,
        activity: ag.data.activity, moving: ag.moving, atHome: ag.atHome, errand: ag.errand ? ag.errand.type : null, bubble: !!ag.bubble,
        inspecting: !!ag.inspecting, inspects: w.inspect.has(ag.id) ? w.inspect.get(ag.id).itemId : null };
    }
    for (const it of w.items.values()) { const v = itemView(it); items[it.id] = { place: v.place, office: v.office, form: v.form, stage: v.stage, x: v.x, y: v.y, hidden: v.hidden, ghost: it.ghost, checking: v.checking }; }
    const T = truckView();
    return { t: w.t, agents, items,
      dolly: { x: Math.round(w.dolly.x), y: Math.round(w.dolly.y), job: w.dolly.job ? w.dolly.job.type : null, carry: w.dolly.carry, rush: w.dolly.rush,
        load: w.dolly.job && w.dolly.job.ids ? w.dolly.job.ids.filter((id) => { const it = w.items.get(id); return !!it && it.place.kind === 'dolly'; }).length : 0 },
      truck: { state: T.state, phase: T.phase, x: Math.round(T.x), visible: T.visible, crates: Math.min(T.total, M.truck.slots), extra: T.extra, stock: T.stock, door: T.door, beacon: T.beacon,
        horn: T.horn > -1e8 && w.t - T.horn < 900 },
      shelf: w.shelf.level, overflow: w.overflow, lathe: w.lathe.on, queues: queues(), bell: bellView(),
      counts: { agents: w.agents.size, items: w.items.size, particles: w.particles.length, notes: w.notes.length, stamps: w.stamps.length, slips: w.slips.length } };
  }

  return { w, sync, advance, snap, fx, state, benchInfo, itemView, reviewing, truckView, bellView, queues, homeOf, warn };
}
