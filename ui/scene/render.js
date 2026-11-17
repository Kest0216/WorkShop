// WorkShop renderer: draws one frame of the world (actors.js createWorld) into a 480 x 272 context.
// Needs a DOM (canvas); never mutates the world.

import { PALETTE as P, providerColor, roleColor } from './palette.js';
import * as M from './map.js';
import { drawText, truncateText, wrapText, measureText } from './font.js';
import { lookFor, characterAtlas, drawCharacter } from './sprites.js';
import { Items } from './art_items.js';
import { Props } from './art_props.js';
import { paintBackdrop, DOOR_PANE, SHADOW } from './backdrop.js';
import { skyAt, drawSky, drawClockHands, drawBubble, bubbleRect, placeBubble, drawTooltip, drawTag, drawNameTag, nameTagRect, fitName, panel } from './hud.js';

const DIR = { down: 'S', up: 'N', left: 'W', right: 'E' };
const WALK_MS = 140;                 // one walk frame
const STOCK_ROWS = ['boxes', 'metal', 'lumber'];
const STOCK_NAME = { lumber: 'lumber', metal: 'metal', box: 'boxes', boxes: 'boxes' };

// Pointer hit box of an agent (logical px).
export function agentBox(ag) {
  if (ag.data.role === 'boss') return { x: ag.x - 7, y: ag.y - 26, w: 14, h: 19 };
  return { x: ag.x - 7, y: ag.y - 26, w: 14, h: 27 };
}

// Tooltip rows of an agent: persona name and handle (@m3), role and lab, model, harness, task or activity. Pure.
export function agentTooltipRows(d) {
  const rows = [{ text: d.name + (d.handle ? '  ' + d.handle : ''), color: P.white }, { text: d.role + ' - ' + d.provider, color: providerColor(d.provider) }];
  if (d.model) rows.push({ text: d.model, color: P.steel4 });
  if (d.harnessId) rows.push({ text: 'harness: ' + d.harnessId + (d.certification && d.certification !== 'curated' ? ' (' + d.certification + ')' : ''), color: P.lime });
  if (d.task) rows.push({ text: (d.task.id ? d.task.id + ' ' : '') + d.task.title, color: P.paper });
  else rows.push({ text: d.activity, color: P.steel4 });
  return rows;
}

function idleFrame(dir, ag) {
  if (dir === 'N') return 'N_idle';
  if (ag.idleT % 3400 < 140) return dir + '_blink';
  if (dir === 'S' && ag.data.activity === 'idle') {
    const l = ag.idleT % 9000;
    if (l > 5000 && l < 5700) return 'S_lookL';
    if (l >= 5700 && l < 6400) return 'S_lookR';
  }
  return dir + '_idle';
}

function agentFrame(ag, t, carrying, reviewing, tapping) {
  const d = ag.data, dir = DIR[ag.face] || 'S';
  if (d.role === 'boss') {
    if (reviewing) return 'S_review' + (Math.floor(t / 450) % 2);
    if (d.activity === 'think') return 'S_think';
    return idleFrame('S', ag);
  }
  if (ag.moving) return dir + (carrying ? '_carry' : '_walk') + (Math.floor(ag.walkT / WALK_MS) % 4);
  if (carrying) return dir + '_carry';
  if (ag.inspecting) return (dir === 'W' || dir === 'E' ? dir : 'S') + '_review' + (Math.floor(t / 450) % 2);
  if (ag.noting) return (dir === 'W' || dir === 'E' ? dir : 'S') + '_note' + (Math.floor(t / 320) % 2);
  if (tapping && ag.atHome) return t % 900 < 200 ? 'S_work0' : 'S_work1';      // checking its item: a light tap now and then
  if (ag.atHome && d.role === 'maker' && d.activity === 'work' && d.task) return 'S_work' + (ag.workT % 700 < 350 ? 0 : 1);
  if (d.activity === 'think' && dir === 'S') return 'S_think';
  return idleFrame(dir, ag);
}

// How dark it is in the shop: 0 by day, 1 at night, ramps at dusk (18:30-20:30) and dawn (5:00-7:00). Pure.
export function nightLevel(hours) {
  const h = ((hours % 24) + 24) % 24;
  if (h >= 7 && h < 18.5) return 0;
  if (h >= 18.5 && h < 20.5) return Math.round(((h - 18.5) / 2) * 8) / 8;
  if (h >= 5 && h < 7) return Math.round((1 - (h - 5) / 2) * 8) / 8;
  return 1;
}

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// Furniture a floor name tag may lie on: the tag is drawn right after it, so the name stays readable
// (a character in front of that furniture still covers the tag).
const SOLIDS = [
  ...M.benches.map((b) => ({ ...b.rect, baseY: b.baseY })), ...M.posts.map((p) => ({ ...p.rect, baseY: p.baseY })),
  { ...M.counter.rect, baseY: M.counter.baseY }, { ...M.shelves.rect, baseY: M.shelves.baseY }, { ...M.machine.rect, baseY: M.machine.baseY },
  { ...M.press.rect, baseY: M.press.baseY }, { ...M.staging.rect, baseY: M.staging.baseY },
  ...['cooler', 'drum', 'cart', 'reel'].map((n) => ({ ...M.props[n], baseY: M.props[n].y + M.props[n].h - 1 })),
  { x: M.props.crates.x, y: M.props.crates.y, w: 32, h: 26, baseY: M.props.crates.y + 26 },
  ...M.offices.map((o) => ({ x: o.ix, y: M.GLASS_Y, w: 60, h: 17, baseY: M.OFFICE_BASE })),
];
// head of an agent (hair and face), logical px
const headBox = (ag) => ({ x: Math.round(ag.x) - 8, y: Math.round(ag.y) - 27, w: 16, h: 16 });
// the whole figure (bubble placement keeps off it)
const bodyBox = (ag) => ({ x: Math.round(ag.x) - 7, y: Math.round(ag.y) - 26, w: 15, h: 27 });
// wall things the owner clicks: a speech bubble keeps off them when it can
const WALL_TARGETS = [M.board.rect, { x: M.clock.cx - M.clock.r - 1, y: M.clock.cy - M.clock.r - 1, w: 2 * M.clock.r + 3, h: 2 * M.clock.r + 3 }, M.pegboard, M.harnessRack, M.statusBoard];

export function createRenderer() {
  let backdrop = null;
  const lookCache = new WeakMap();   // normalized agent -> atlas
  const bubbleKeep = new Map();      // agent id -> { t0, dx, dy }: where its bubble was placed in the last frame

  function atlasOf(ag) {
    let e = lookCache.get(ag.data);
    if (!e) { e = characterAtlas(lookFor(ag.data)); lookCache.set(ag.data, e); }
    return e;
  }

  function footShadow(ctx, x, y) {
    ctx.fillStyle = SHADOW;
    ctx.fillRect(Math.round(x) - 7, Math.round(y) - 1, 14, 1);
    ctx.fillRect(Math.round(x) - 6, Math.round(y), 12, 1);
  }
  function baseShadow(ctx, x, y, w) { ctx.fillStyle = SHADOW; ctx.fillRect(x, y, w, 1); }

  function drawWall(ctx, world, env) {
    const w = world.w;
    // name plates
    for (const o of M.offices) {
      const boss = w.bossAt[o.i];
      const pl = o.plate;
      if (boss) {
        ctx.fillStyle = providerColor(boss.data.provider); ctx.fillRect(pl.x + 1, pl.y + 1, 3, pl.h - 2);
        drawText(ctx, fitName(boss.data.name, pl.w - 5), pl.x + 4 + Math.floor((pl.w - 5) / 2), pl.y + 2, P.wood1, { align: 'center' });
      } else { ctx.fillStyle = P.wood4; ctx.fillRect(pl.x + 8, pl.y + 4, pl.w - 16, 1); }
    }
    // clock
    drawClockHands(ctx, M.clock.cx, M.clock.cy, env.date);
    // status sign: job title, then the status line on up to two lines
    const s = M.statusBoard, sw = s.w - 8;
    const lines = [];
    if (w.shop.jobTitle) lines.push({ text: truncateText(w.shop.jobTitle, sw), color: P.yellow });
    if (w.shop.paused) { if (Math.floor(env.t / 500) % 2 === 0) lines.push({ text: 'PAUSED', color: P.red }); }
    else {
      const wrapped = wrapText(w.shop.statusLine || (w.shop.jobTitle ? '' : 'No job'), sw);
      wrapped.slice(0, 2).forEach((l, i) => lines.push({ text: i === 1 && wrapped.length > 2 ? truncateText(l + ' ' + wrapped[2], sw) : l, color: P.paper }));
    }
    lines.forEach((l, i) => drawText(ctx, l.text, s.x + 4, s.y + 4 + i * 7, l.color));
    // board notes
    const c = M.board.inner;
    for (const n of w.notes) {
      const age = w.t - n.t0;
      const drop = age < 180 ? Math.round((1 - age / 180) * 5) : 0;
      const x = c.x + 1 + n.x, y = c.y + 1 + n.y - drop;
      ctx.fillStyle = P.wood2; ctx.fillRect(x + 1, y + 1, 8, 8);
      ctx.fillStyle = P[n.color] || P.paper; ctx.fillRect(x, y, 8, 8);
      ctx.fillStyle = P.steel3; ctx.fillRect(x + 1, y + 3, 5, 1); ctx.fillRect(x + 1, y + 5, 4, 1);
      ctx.fillStyle = P.red; ctx.fillRect(x + 3, y, 2, 2); ctx.fillStyle = P.pink; ctx.fillRect(x + 3, y, 1, 1);
    }
    if (w.unread > 0) {
      const r = M.board.rect, txt = w.unread > 99 ? '99+' : String(w.unread);
      const bw = Math.max(9, measureText(txt) + 4), bx = r.x + r.w - bw + 3, by = r.y - 1 - (Math.floor(env.t / 400) % 2);
      panel(ctx, bx - 1, by - 1, bw + 2, 11, P.ink, P.ink);
      panel(ctx, bx, by, bw, 9, P.red, P.red);
      drawText(ctx, txt, bx + Math.floor(bw / 2), by + 2, P.white, { align: 'center' });
    }
    // sky in the entrance pane and the front windows
    const sky = skyAt(env.date.getHours() + env.date.getMinutes() / 60);
    drawSky(ctx, DOOR_PANE, sky, 5, env.t);
    ctx.fillStyle = P.wood2; ctx.fillRect(DOOR_PANE.x + 6, DOOR_PANE.y, 1, DOOR_PANE.h); ctx.fillRect(DOOR_PANE.x, DOOR_PANE.y + 4, DOOR_PANE.w, 1);
    M.frontWindows.forEach((r, i) => {
      drawSky(ctx, r, sky, i, env.t);
      ctx.fillStyle = P.steel2; ctx.fillRect(r.x + (r.w >> 1) - 1, r.y, 2, r.h);
      ctx.fillStyle = P.steel4; ctx.fillRect(r.x + (r.w >> 1) - 1, r.y, 1, r.h);
    });
    // dock shutter
    const T = w.truck, d = M.dock.door;
    const hgt = Math.round((1 - Math.max(0, Math.min(1, T.door))) * d.h);
    if (hgt > 0) ctx.drawImage(Props.shutter(), 0, d.h - hgt, d.w, hgt, d.x, d.y, d.w, hgt);
    ctx.fillStyle = P.ink; ctx.fillRect(d.x - 4, d.y - 1, d.w + 8, 3); ctx.fillStyle = P.steel3; ctx.fillRect(d.x - 3, d.y, d.w + 6, 1);
    // agents that found no free spot wait outside: a small sign on the entrance door, person icon and "+N"
    if (w.overflow > 0) {
      const txt = '+' + w.overflow, tw = measureText(txt) + 11, x = M.overflowTag.x - Math.ceil(tw / 2), y = M.overflowTag.y;
      panel(ctx, x, y, tw, 11, P.ink, P.ink);
      ctx.fillStyle = P.shadow; ctx.fillRect(x + 1, y + 1, tw - 2, 9);
      ctx.drawImage(Items.icon('person'), x + 1, y + 1);
      drawText(ctx, txt, x + 9, y + 3, P.yellow);
    }
  }

  // After dusk the floor and the walls dim to a navy tone (one translucent layer over the backdrop), and warm lamp light
  // pools under the occupied benches, the counter and a lamp over the door. Furniture, characters and text are drawn
  // later at full brightness, as if lit by the lamps.
  function drawNight(ctx, world, k, env) {
    if (k <= 0) return;
    const w = world.w;
    ctx.fillStyle = 'rgba(16,22,64,' + (0.36 * k).toFixed(3) + ')';
    ctx.fillRect(0, 0, M.W, M.H);
    ctx.fillStyle = 'rgba(10,12,34,' + (0.25 * k).toFixed(3) + ')';     // the street outside is darker still
    ctx.fillRect(0, M.STREET_Y, M.W, M.H - M.STREET_Y);
    const pool = (cx, cy, rw, rh) => {        // a stepped oval of warm light
      for (const [f, a] of [[1, 0.08], [0.72, 0.09], [0.45, 0.1]]) {
        const hw = Math.round(rw * f), hh = Math.max(1, Math.round(rh * f));
        ctx.fillStyle = 'rgba(242,182,58,' + (a * k).toFixed(3) + ')';
        ctx.fillRect(cx - hw, cy - hh + 1, hw * 2, hh * 2 - 2); ctx.fillRect(cx - hw + 2, cy - hh, hw * 2 - 4, hh * 2);
      }
    };
    for (const b of M.benches) if (w.makerAt[b.k]) pool(b.rect.x + 16, b.baseY + 2, 24, 8);
    const c = M.counter.rect;
    pool(c.x + c.w / 2, M.counter.baseY + 2, 30, 7);
    pool(M.entrance.stand.x, M.entrance.stand.y - 6, 16, 6);
    // the door lamp: a small brass sconce over the door with a lit bulb
    const lx = M.entrance.x + 13, ly = M.entrance.y - 2;
    ctx.fillStyle = P.ink; ctx.fillRect(lx - 2, ly, 5, 3);
    ctx.fillStyle = P.yellow; ctx.fillRect(lx - 1, ly + 1, 3, 1);
    ctx.fillStyle = P.white; ctx.fillRect(lx, ly + 1, 1, 1);
    ctx.fillStyle = 'rgba(249,224,122,' + (0.22 * k).toFixed(3) + ')'; ctx.fillRect(lx - 6, ly + 3, 13, 3); ctx.fillRect(lx - 4, ly + 6, 9, 2);
  }

  function drawCounter(ctx, world, env) {
    const w = world.w;
    ctx.drawImage(Props.counter(), M.counter.rect.x - 1, M.counter.rect.y - 1);
    drawBell(ctx, world);
    w.slips.forEach((sl, i) => {
      const k = Math.min(1, (w.t - sl.t0) / 450), e = 1 - (1 - k) * (1 - k);
      const x = M.counter.slips.x + i * 5 + Math.round((1 - e) * 34), y = M.counter.slips.y + sl.tilt - 3 + (i % 2);
      ctx.drawImage(Items.icon('slip'), x, y);
    });
  }

  // The counter bell. A ring: the plunger is struck (flash), the dome wobbles, sound arcs travel out on both
  // sides, and a music note floats up. owner.attention repeats the ring (actors.js BELL).
  // The bell sprite is 13 x 11 (11 x 9 plus outline); its base plate stands on the counter top at y = BELL_FOOT.
  const BELL_FOOT = 47;
  const BELL_CLEAR = M.statusBoard.y + M.statusBoard.h + 4;     // nothing of the ring rises above this line (the chalkboard and its shadow)
  function drawBell(ctx, world) {
    const bv = world.bellView(), a = bv.age, b = M.counter.bell;
    const img0 = Items.icon('bell'), bx = b.x + 4 - (img0.width >> 1), by = BELL_FOOT - img0.height + 1;
    const cx = b.x + 4, knob = by + 1, cy = by + 5;   // plunger top and dome center
    let icon = 'bell';
    if (bv.ringing) icon = a < 90 ? 'bellHit' : a > 580 ? 'bell' : Math.floor((a - 90) / 70) % 2 ? 'bellR' : 'bellL';
    ctx.drawImage(Items.icon(icon), bx, by);
    if (bv.ringing) {
      if (a < 140) {                                // strike: a small star over the plunger
        ctx.fillStyle = a < 70 ? P.white : P.yellow;
        ctx.fillRect(cx, knob - 4, 1, 3); ctx.fillRect(cx - 1, knob - 3, 3, 1);
        if (a < 70) { ctx.fillRect(cx - 3, knob - 5, 1, 1); ctx.fillRect(cx + 3, knob - 5, 1, 1); }
      }
      if (a < 300) {                                // "ding!" pops up in two frames (amber, bitmap font) and is gone again
        const up = a < 120 ? 0 : 1;
        drawText(ctx, 'ding!', cx + 5, BELL_CLEAR + 1 - up, up ? P.amber : P.yellow, { shadow: P.ink });
      }
      for (let i = 0; i < 2; i++) {                 // two waves of sound arcs, each moving out in four steps
        const s = Math.floor((a - 60 - i * 220) / 100);
        if (s < 0 || s > 3) continue;
        const d = 8 + s * 2;
        ctx.fillStyle = s === 0 ? P.white : s < 3 ? P.yellow : P.amber;
        for (const sg of [-1, 1]) {
          const x = cx + sg * d;
          ctx.fillRect(x, cy - 1, 1, 3); ctx.fillRect(x - sg, cy - 2, 1, 1); ctx.fillRect(x - sg, cy + 2, 1, 1);
        }
      }
    }
    if (a >= 300 && a < 1400) {                     // then a note floats up to the right of the bell; it fades before the status board
      const k = (a - 300) / 1100, nx = cx + 9 + Math.round(k * 4) + Math.round(Math.sin(a / 140));
      const ny = Math.max(BELL_CLEAR, by + 1 - Math.round(k * 8));
      if (!(k > 0.7 && Math.floor(a / 60) % 2)) ctx.drawImage(Items.icon('note'), nx, ny);
    }
  }

  function drawTruck(ctx, world, env) {
    const T = world.truckView();
    if (!T.visible) return;
    const x = Math.round(T.x), y = M.truck.y;
    const moving = T.phase === 'in' || (T.phase === 'out' && T.t > 700);
    const rumble = T.phase === 'out' && T.t <= 700 ? Math.floor(env.t / 60) % 2 : 0;
    ctx.fillStyle = SHADOW; ctx.fillRect(x + 4, y + 38, 92, 2);
    ctx.drawImage(Props.truck(moving ? Math.floor(Math.abs(T.x) / 5) % 2 : 0), x, y + rumble);
    for (let s = 0; s < Math.min(T.anon, M.truck.slots); s++) { const o = M.truck.slot(s); Items.draw(ctx, Items.crate('none'), x + o.x, y + o.y + rumble); }
    for (let k = 0; k < T.stock; k++) { const o = M.truck.slot(Math.min(5, T.anon + k)); Items.draw(ctx, Items.stock(STOCK_ROWS[k % 3]), x + o.x, y + o.y); }
    const on = T.beacon && Math.floor(env.t / 300) % 2 === 0;
    const bx = x + M.truck.beacon.x, by = y + M.truck.beacon.y + rumble;
    ctx.fillStyle = P.ink; ctx.fillRect(bx - 3, by - 1, 7, 6);
    ctx.fillStyle = on ? P.yellow : T.beacon ? P.orange : P.rust2; ctx.fillRect(bx - 2, by, 5, 4);
    ctx.fillStyle = on ? P.white : P.amber; ctx.fillRect(bx - 1, by + 1, 2, 1);
    if (on) { ctx.fillStyle = P.amber; ctx.fillRect(bx - 5, by + 1, 1, 2); ctx.fillRect(bx + 5, by + 1, 1, 2); ctx.fillRect(bx, by - 3, 1, 1); ctx.fillRect(bx - 4, by - 2, 1, 1); ctx.fillRect(bx + 4, by - 2, 1, 1); }
    if (T.extra > 0) drawTag(ctx, '+' + T.extra, x + 29, y - 6, P.yellow, 'center');
    if (world.w.t - T.horn < 900 && T.horn > -1e8) drawBubble(ctx, Math.min(x + 84, 440), y + 6, ['HONK!'], 'warn', world.w.t - T.horn);
  }

  function draw(ctx, world, envIn) {
    const env = envIn || {};
    if (!env.date) env.date = new Date();
    const w = world.w;
    env.t = w.t;
    const hover = env.hover && env.hover.kind !== 'none' ? env.hover : null;
    if (!backdrop) { backdrop = document.createElement('canvas'); backdrop.width = M.W; backdrop.height = M.H; paintBackdrop(backdrop.getContext('2d')); }
    ctx.drawImage(backdrop, 0, 0);
    drawNight(ctx, world, nightLevel(env.date.getHours() + env.date.getMinutes() / 60), env);
    drawWall(ctx, world, env);

    const list = [];
    const add = (key, fn) => list.push({ key, fn });
    const views = [];
    const inHand = new Set();
    const tapping = new Set();          // makers checking their item on the bench (to_office before a buddy check or a bench review)
    for (const it of w.items.values()) {
      const v = world.itemView(it); v.it = it; views.push(v);
      if (it.place.kind === 'hand') inHand.add(it.place.agentId);
      if (v.checking && !v.hidden) tapping.add(v.makerId);
    }
    const isHover = (ag) => !!hover && hover.kind === 'agent' && hover.id === ag.id;

    // offices
    for (const o of M.offices) {
      const boss = w.bossAt[o.i];
      add(o.boss.y - 0.5, () => ctx.drawImage(Props.chair(), o.chair.x - 1, o.chair.y - 1));
      add(o.plant.y + 24, () => { baseShadow(ctx, o.plant.x + 3, o.plant.y + 19, 8); ctx.drawImage(Props.plant(), o.plant.x - 1, o.plant.y - 1); });
      if (boss) {
        const rev = world.reviewing(o.i);
        add(o.boss.y, () => drawCharacter(ctx, atlasOf(boss), agentFrame(boss, w.t, false, rev), boss.x, boss.y, isHover(boss)));
        if (boss.data.activity === 'think' && boss.data.task && boss.data.task.domain === 'plan') add(o.desk.y + o.desk.h + 0.2, () => ctx.drawImage(Items.blueprint(), o.blueprint.x, o.blueprint.y - 1));
      }
      add(o.desk.y + o.desk.h, () => ctx.drawImage(Props.desk(), o.desk.x - 1, o.desk.y - 1));
      add(M.OFFICE_BASE - 1, () => ctx.drawImage(Props.glass(), o.ix, M.GLASS_Y));
    }
    // a backlog in an office place: the first items are stacked, the rest is a "+N" tag
    for (const q of world.queues()) {
      if (q.count <= M.QUEUE_SHOWN) continue;
      const o = M.offices[q.office], base = q.kind === 'inbox' ? o.inbox : q.kind === 'desk' ? o.deskItem : o.outbox;
      const off = M.queueOffset(q.kind, M.QUEUE_SHOWN - 1);
      add(M.OFFICE_BASE + 0.4, () => drawTag(ctx, '+' + (q.count - M.QUEUE_SHOWN), base.x + off.x + (q.kind === 'outbox' ? -2 : -12), base.y + off.y - 23, P.yellow, 'left'));
    }
    // benches
    for (const b of M.benches) {
      const info = world.benchInfo(b.k);
      add(b.baseY, () => {
        ctx.drawImage(Props.bench(), b.rect.x - 1, b.rect.y - 1);
        if (info.domain) Items.draw(ctx, Items.tooling(info.domain), b.tool.x, b.tool.y);
        if (info.wip) Items.draw(ctx, Items.doohickey(info.domain, info.stage), b.item.x, b.item.y);
      });
    }
    for (const p of M.posts) add(p.baseY, () => ctx.drawImage(Props.post(), p.rect.x - 1, p.rect.y - 1));
    add(M.counter.baseY, () => drawCounter(ctx, world, env));
    add(M.shelves.baseY, () => {
      const r = M.shelves.rect;
      ctx.drawImage(Props.shelves(), r.x - 1, r.y - 1);
      for (let i = 0; i < Math.min(6, w.shelf.level); i++) {
        const row = i >> 1, bay = i % 2, sx = r.x + 10 + bay * 31, sy = r.y + [32, 21, 10][row];
        const img = Items.stock(STOCK_ROWS[row]);
        Items.draw(ctx, img, sx, sy); Items.draw(ctx, img, sx + 13, sy);
      }
    });
    add(M.machine.baseY, () => {
      ctx.drawImage(Props.machine(), M.machine.rect.x - 1, M.machine.rect.y - 1);
      // ambient: status light; the chuck and the work piece turn while a machine-family maker works
      const c = M.machine.chuck, led = M.machine.led;
      if (w.lathe.on) {
        const f = Math.floor(w.t / 90) % 3;
        ctx.fillStyle = P.steel3; ctx.fillRect(c.x, c.y + 1 + f * 2, c.w, 1);
        ctx.fillStyle = P.white; ctx.fillRect(c.x, c.y + ((f * 2 + 3) % 6), c.w - 1, 1);
        ctx.fillStyle = P.wood3; ctx.fillRect(c.x + 5 + ((f * 3) % 8), c.y + 2, 1, 2);
        ctx.fillStyle = Math.floor(w.t / 260) % 2 ? P.lime : P.green; ctx.fillRect(led.x, led.y, 1, 1);
      } else if (Math.floor(w.t / 900) % 2) { ctx.fillStyle = P.leaf2; ctx.fillRect(led.x, led.y, 1, 1); }
    });
    add(M.press.baseY, () => {
      ctx.drawImage(Props.press(), M.press.rect.x - 1, M.press.rect.y - 1);
      if (Math.floor(w.t / 1300) % 2) { ctx.fillStyle = P.lime; ctx.fillRect(M.press.led.x, M.press.led.y, 1, 1); }
    });
    add(M.staging.baseY, () => { baseShadow(ctx, M.staging.rect.x, M.staging.baseY + 1, 32); ctx.drawImage(Props.pallet(), M.staging.rect.x - 1, M.staging.rect.y - 1); });
    const pr = M.props;
    add(pr.barrel.y + 16, () => { baseShadow(ctx, pr.barrel.x + 1, pr.barrel.y + 17, 12); ctx.drawImage(Props.barrel(), pr.barrel.x - 1, pr.barrel.y - 1); });
    add(pr.broom.y + 22, () => ctx.drawImage(Props.broom(), pr.broom.x - 1, pr.broom.y - 1));
    add(pr.crates.y + 26, () => { baseShadow(ctx, pr.crates.x, pr.crates.y + 27, 32); ctx.drawImage(Props.crateStack(), pr.crates.x - 1, pr.crates.y - 1); });
    add(pr.plant.y + 18, () => { baseShadow(ctx, pr.plant.x + 3, pr.plant.y + 19, 8); ctx.drawImage(Props.plant(), pr.plant.x - 1, pr.plant.y - 1); });
    add(pr.plant2.y + 18, () => { baseShadow(ctx, pr.plant2.x + 3, pr.plant2.y + 19, 8); ctx.drawImage(Props.plant(), pr.plant2.x - 1, pr.plant2.y - 1); });
    for (const name of ['cooler', 'drum', 'cart', 'reel']) {
      const r = pr[name];
      add(r.y + r.h - 1, () => { baseShadow(ctx, r.x, r.y + r.h, r.w); ctx.drawImage(Props[name](), r.x - 1, r.y - 1); });
    }

    // agents (bosses are drawn with their office)
    const fixedTags = [], walkerTags = [], heads = [];
    for (const ag of w.agents.values()) {
      const d = ag.data;
      if (!d.present) continue;
      heads.push({ ag, ...headBox(ag) });
      if (d.role === 'boss') continue;
      add(ag.y, () => {
        if (!ag.atHome || d.role !== 'maker') footShadow(ctx, ag.x, ag.y);
        drawCharacter(ctx, atlasOf(ag), agentFrame(ag, w.t, inHand.has(ag.id), false, tapping.has(ag.id)), ag.x, ag.y, isHover(ag));
      });
      // name tag: on the bench front while the maker is at its work place, on the post for a manager at home,
      // else on the floor under the walker
      // Fixed tags belong to their furniture in the depth order: a walker nearer than the bench or the post covers them.
      if (d.role === 'maker' && (ag.atHome || M.atWorkPlace(d.spot, ag.x, ag.y))) { const b = M.benches[d.spot]; fixedTags.push({ ag, r: nameTagRect(d.name, b.tag.x, b.tag.y, 40), key: b.baseY + 0.3 }); }
      else if (d.role === 'manager' && ag.atHome) { const p = M.posts[d.spot]; fixedTags.push({ ag, r: nameTagRect(d.name, p.tag.x, p.tag.y, 34), key: p.baseY + 0.3 }); }
      else {
        const r = nameTagRect(d.name, ag.x, ag.y + 1, 40);
        const m = !ag.moving && /^(visit|inspect)(\d)$/.exec(ag.goalKey || '');
        if (m && (ag.noting || ag.inspecting)) r.x = Math.max(r.x, M.benches[+m[2]].rect.x + 35);     // next to a bench: keep clear of its front
        walkerTags.push({ ag, r });
      }
    }
    for (const tg of fixedTags) add(tg.key, () => drawNameTag(ctx, tg.ag.data.name, 0, 0, providerColor(tg.ag.data.provider), 40, isHover(tg.ag), tg.r));
    // walker tags are part of the depth-sorted picture: a nearer character covers them. Tags that touch are
    // moved apart; a tag that would lie on the head of a standing agent in front of it is left out.
    walkerTags.sort((a, b) => a.ag.y - b.ag.y || a.ag.x - b.ag.x);
    const shownTags = [];
    for (const tg of walkerTags) {
      for (let pass = 0; pass < 3; pass++) {
        const hit = shownTags.find((q) => overlap({ x: tg.r.x - 1, y: tg.r.y - 1, w: tg.r.w + 2, h: tg.r.h + 2 }, q.r));
        if (!hit) break;
        tg.r.y = hit.r.y + 8;
      }
      // a tag right next to the face of a nearer, standing agent reads as that agent's name: slide it sideways a
      // little; a tag that still lies on such a face is left out
      const near = heads.filter((hb) => hb.ag !== tg.ag && !hb.ag.moving && hb.ag.y > tg.ag.y);
      const touches = (r, m) => near.some((hb) => overlap({ x: r.x - m, y: r.y, w: r.w + 2 * m, h: r.h - 2 }, { x: hb.x + 1, y: hb.y, w: hb.w - 2, h: hb.h }));
      if (touches(tg.r, 3)) for (const dx of [-4, 4, -8, 8]) { const r2 = { ...tg.r, x: tg.r.x + dx }; if (!touches(r2, 3)) { tg.r = r2; break; } }
      tg.hidden = touches(tg.r, 0);
      if (tg.hidden) continue;
      shownTags.push(tg);
      let key = tg.ag.y;
      for (const f of SOLIDS) if (f.baseY > key && overlap(tg.r, f)) key = f.baseY;
      add(key + 0.4, () => drawNameTag(ctx, tg.ag.data.name, 0, 0, providerColor(tg.ag.data.provider), 40, isHover(tg.ag), tg.r));
    }
    // dolly
    const D = w.dolly;
    add(D.y, () => {
      const f = D.moving ? Math.floor(D.walkT / 110) % 2 : Math.floor(w.t / 900) % 2;
      const img = D.face === 'left' ? Props.dollyW(f) : Props.dolly(DIR[D.face] === 'N' ? 'N' : DIR[D.face] === 'E' ? 'E' : 'S', f);
      ctx.fillStyle = SHADOW; ctx.fillRect(Math.round(D.x) - 7, Math.round(D.y), 14, 1);
      ctx.drawImage(img, Math.round(D.x) - 9, Math.round(D.y) - 15);
      if (D.carry) Items.draw(ctx, Items.stock(STOCK_NAME[D.carry] || 'boxes'), D.x, D.y - 10);
    });
    // truck
    add(268, () => drawTruck(ctx, world, env));
    // delivery items
    for (const v of views) {
      if (v.hidden || v.x === null) continue;
      const pk = v.place;
      let key, bob = 0;
      if (pk === 'desk') key = M.offices[0].desk.y + M.offices[0].desk.h + 0.5;
      else if (pk === 'inbox' || pk === 'outbox') key = M.OFFICE_BASE - 0.5;
      else if (pk === 'bench') { const mk = w.agents.get(v.it.place.makerId); key = mk && mk.data.spot !== null ? M.benches[mk.data.spot].baseY + 0.5 : v.y; }
      else if (pk === 'hand') { const c = w.agents.get(v.it.place.agentId); key = c ? c.y + 0.5 : v.y; if (c && c.moving && Math.floor(c.walkT / WALK_MS) % 2 === 0) bob = 1; }
      else if (pk === 'dolly') key = D.y + 0.5;
      else if (pk === 'truck') key = 268.5;
      else if (pk === 'staging') key = M.staging.baseY + 0.5;
      else key = v.y;
      add(key + v.y * 0.001, () => {
        const img = v.form === 'crate' ? Items.crate(v.domain) : Items.doohickey(v.domain, v.growth);
        Items.draw(ctx, img, v.x, v.y + bob);
        if (v.checking) Items.draw(ctx, Items.icon(Math.floor(w.t / 450) % 2 ? 'dial1' : 'dial0'), Math.round(v.x) + 1, Math.round(v.y) - 12);
        if (v.stage === 'rejected' && (pk === 'inbox' || pk === 'hand' || pk === 'bench')) ctx.drawImage(Items.icon('redtag'), Math.round(v.x) + 1, Math.round(v.y) + bob - 15);
      });
    }
    list.sort((a, b) => a.key - b.key);
    for (let i = 0; i < list.length; i++) list[i].fn();

    // particles
    for (const p of w.particles) {
      const x = Math.round(p.x), y = Math.round(p.y);
      ctx.fillStyle = (p.flash && p.age < 90 ? P[p.flash] : P[p.color]) || P.white;
      if (p.kind === 'puff') {            // exhaust: a 3 x 3 puff that thins out to 2 x 2
        if (p.life > 450) { ctx.fillRect(x - 1, y - 1, 3, 3); ctx.fillStyle = P.white; ctx.fillRect(x - 1, y - 1, 2, 1); ctx.fillStyle = P.steel4; ctx.fillRect(x + 1, y + 1, 1, 1); }
        else if (p.life > 150 || (x + y) % 2 === 0) { ctx.fillRect(x, y, 2, 2); if (p.life > 300) { ctx.fillStyle = P.white; ctx.fillRect(x, y, 1, 1); } }
      } else if (p.kind === 'smoke') { if (p.life > 300 || (x + y) % 2 === 0) ctx.fillRect(x, y, p.life > 450 ? 2 : 1, p.life > 450 ? 2 : 1); }
      else if (p.kind === 'scrap') ctx.fillRect(x, y, 2, 1);
      else if (p.kind === 'conf') { const f = Math.floor(p.life / 130) % 3; ctx.fillRect(x, y, f === 0 ? 3 : 2, f === 0 ? 1 : f === 1 ? 2 : 3); }
      else { const sz = p.size === 2 && p.life > 160 ? 2 : 1; ctx.fillRect(x, y, sz, sz); }
    }
    // stamps
    for (const s of w.stamps) {
      const age = w.t - s.t0, drop = age < 140 ? Math.round((1 - age / 140) * 9) : 0;
      if (age > 900 && Math.floor(age / 60) % 2) continue;
      Items.draw(ctx, Items.icon(s.kind === 'pass' ? 'pass' : 'fail'), s.x, s.y - drop);
    }

    // status icons, bubbles
    const bubbles = [];
    const shown = new Set();             // makers whose bench an inspector visits: they show their work, no hourglass
    for (const [id, insp] of w.inspect) { const a = w.agents.get(id); const mk = w.makerAt[insp.bench]; if (a && a.inspecting && mk) shown.add(mk.id); }
    for (const ag of w.agents.values()) {
      const d = ag.data;
      if (!d.present) continue;
      const top = Math.round(ag.y) - 27;
      // status icon next to the head (upper right), so it does not cover what is behind the agent
      const bob = Math.floor(w.t / 350) % 2;
      const cx = Math.round(ag.x), iy = Math.round(ag.y) - 24;
      if (d.activity === 'blocked') ctx.drawImage(Items.icon('bang'), cx + 8, iy - bob);
      else if (d.activity === 'wait' && !inHand.has(ag.id) && !ag.moving && !shown.has(ag.id) && !tapping.has(ag.id)) ctx.drawImage(Items.icon('hourglass'), cx + 8, iy - bob);
      else if (d.activity === 'think' && !ag.bubble) {
        ctx.drawImage(Items.icon('dots'), cx + 5, iy - 4);
        const k = Math.floor(w.t / 300) % 4;
        ctx.fillStyle = P.steel2; for (let i = 0; i < Math.min(3, k + 1); i++) ctx.fillRect(cx + 9 + i * 3, iy - 1, 1, 1);
      }
      if (ag.bubble) bubbles.push({ ag, top });
    }
    // speech bubbles. Soft obstacles: the whole figure of every other agent (a walker costs more than a seated one),
    // name tags, name plates, and the wall things the owner clicks (board, clock, tool wall, status board). A bubble
    // first tries a shift left or right (its tail stays on the speaker), then moves up; bubbles never cover each other.
    if (bubbles.length) {
      const soft = [];
      for (const hb of heads) {
        const ag = hb.ag, seated = ag.data.role === 'boss' || (ag.atHome && !ag.moving);
        soft.push({ ...bodyBox(ag), cost: seated ? 3 : 4, ag });
      }
      for (const tg of fixedTags) soft.push({ ...tg.r, cost: 2 });
      for (const tg of shownTags) soft.push({ ...tg.r, cost: 2 });
      for (const o of M.offices) if (w.bossAt[o.i]) soft.push({ ...o.plate, cost: 1.5 });
      for (const r of WALL_TARGETS) soft.push({ ...r, cost: 1.5 });
      soft.push({ x: M.counter.bell.x - 3, y: 33, w: 15, h: 15, cost: world.bellView().ringing ? 6 : 1 });   // the counter bell, above all while it rings
      for (const b of M.benches) { const mk = w.makerAt[b.k]; if (mk && mk.data.task) soft.push({ x: b.rect.x + 1, y: b.rect.y - 3, w: b.rect.w - 2, h: 14, cost: 1.5 }); }   // work on a bench
      const placed = [];
      bubbles.sort((a, b) => a.ag.y - b.ag.y || a.ag.x - b.ag.x);
      for (const b of bubbles) {
        const bb = b.ag.bubble, boss = b.ag.data.role === 'boss';
        const post = b.ag.data.role === 'manager' && b.ag.atHome;       // right under the wall band
        const r0 = bubbleRect(b.ag.x, b.top + 2, bb.lines);
        const kept = bubbleKeep.get(b.ag.id);
        const mine = soft.map((o) => (o.ag === b.ag ? { ...o, cost: 500 } : o));    // never on the speaker
        // a boss speaks from under the wall trim line when the bubble fits between the trim and the head
        const baseY = boss && r0.h <= 13 ? Math.max(r0.y, 14) : r0.y;
        const r = placeBubble(r0, b.ag.x, placed, mine, { baseY, headY: b.top, maxUp: boss || post ? 12 : 24, sideFirst: post, keep: kept && kept.t0 === bb.t0 ? kept : null });
        for (let pass = 0; pass < 4 && r.cost >= 100 && !r.side; pass++) {      // crowded: stack upwards, as a last resort
          const hit = placed.find((q) => r.x < q.x + q.w + 2 && q.x < r.x + r.w + 2 && r.y < q.y + q.h + 4 && q.y < r.y + r.h + 4);
          if (!hit || hit.y - r.h - 5 < 1) break;
          r.y = hit.y - r.h - 5;
        }
        bubbleKeep.set(b.ag.id, { t0: bb.t0, dx: r.dx, dy: r.dy, side: r.side });
        placed.push(r);
        drawBubble(ctx, b.ag.x, b.top + 2, bb.lines, bb.kind, w.t - bb.t0, r);
      }
    }
    if (bubbleKeep.size > bubbles.length) for (const id of [...bubbleKeep.keys()]) { const ag = w.agents.get(id); if (!ag || !ag.bubble) bubbleKeep.delete(id); }

    // hover highlight and tooltip
    if (hover) drawHover(ctx, world, hover);
    if (env.scanlines) { ctx.fillStyle = 'rgba(0,0,0,0.14)'; for (let y = 1; y < M.H; y += 2) ctx.fillRect(0, y, M.W, 1); }
  }

  function outline(ctx, r) {
    ctx.fillStyle = P.white;
    ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, 1); ctx.fillRect(r.x - 1, r.y + r.h, r.w + 2, 1);
    ctx.fillRect(r.x - 1, r.y, 1, r.h); ctx.fillRect(r.x + r.w, r.y, 1, r.h);
  }

  function drawHover(ctx, world, hover) {
    const w = world.w;
    if (hover.kind === 'agent') {
      const ag = w.agents.get(hover.id);
      if (!ag || !ag.data.present) return;
      const d = ag.data, box = agentBox(ag);
      drawTooltip(ctx, box.x + 7, box.y, agentTooltipRows(d), d.task ? d.task.progress : NaN, roleColor(d.role));
      return;
    }
    let r = null, rows = [];
    if (hover.kind === 'toolwall') { const g = M.pegboard; r = { x: g.x, y: g.y, w: g.w, h: g.h }; rows = [{ text: 'Tool wall', color: P.white }, { text: 'Toolkit', color: P.steel4 }]; }
    else if (hover.kind === 'harnesses') { const hr = M.harnessRack; r = { x: hr.x, y: hr.y, w: hr.w, h: hr.h }; rows = [{ text: 'Harness rack', color: P.white }, { text: 'Phase 0 toolkits', color: P.lime }]; }
    else if (hover.kind === 'rftbay') { r = M.rftBay; rows = [{ text: 'RFT calibration bay', color: P.white }, { text: 'Phase 1 queue & book', color: P.amber }]; }
    else if (hover.kind === 'board') { r = M.board.rect; rows = [{ text: 'Message board', color: P.white }, { text: w.unread + ' unread', color: w.unread ? P.pink : P.steel4 }]; }
    else if (hover.kind === 'counter') { r = M.counter.rect; rows = [{ text: 'Front counter', color: P.white }, { text: w.attention ? 'Waiting for you' : 'Work orders', color: w.attention ? P.amber : P.steel4 }]; }
    else if (hover.kind === 'office') { const o = M.offices[hover.id]; if (!o) return; r = { x: o.ix, y: 2, w: 60, h: 78 }; const b = w.bossAt[o.i]; rows = [{ text: b ? b.data.name + "'s office" : 'Empty office', color: P.white }]; }
    else if (hover.kind === 'bench') { const b = M.benches[hover.id]; if (!b) return; r = b.rect; const info = world.benchInfo(b.k); rows = [{ text: 'Bench ' + (b.k + 1), color: P.white }, { text: info.maker ? info.maker.data.name + (info.domain ? ' - ' + info.domain : '') : 'free', color: P.steel4 }]; }
    else if (hover.kind === 'truck') { const T = world.truckView(); if (!T.visible) return; r = { x: Math.round(T.x), y: M.truck.y, w: M.truck.w, h: M.truck.h }; rows = [{ text: 'Merge truck', color: P.white }, { text: T.state + ' - ' + T.total + ' crates', color: T.beacon ? P.amber : P.steel4 }]; }
    if (!r) return;
    outline(ctx, r);
    drawTooltip(ctx, r.x + r.w / 2, r.y + 2, rows, NaN, P.steel4);
  }

  return { draw, reset() { backdrop = null; } };
}
