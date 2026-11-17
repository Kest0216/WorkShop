// WorkShop backdrop: everything that never changes, painted once into a 480 x 272 canvas.
// Dynamic wall content (name plates, clock hands, status text, notes, window sky, shutter) is drawn by render.js.

import { PALETTE as P } from './palette.js';
import * as M from './map.js';
import { drawText } from './font.js';
import { Pix } from './pix.js';
import { TOOL_MAPS } from './sprites.js';
import { Props } from './art_props.js';

export const DOOR_PANE = { x: M.entrance.x + 6, y: M.entrance.y + 5, w: 14, h: 9 };
export const SHADOW = 'rgba(21,18,30,0.28)';

// small deterministic hash for texture placement
export function h2(x, y) { let n = (x * 374761393 + y * 668265263) >>> 0; n = (n ^ (n >>> 13)) * 1274126177 >>> 0; return (n ^ (n >>> 16)) >>> 0; }

function frame(ctx, r, fill, hi, lo) {
  ctx.fillStyle = fill; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = hi; ctx.fillRect(r.x, r.y, r.w, 1); ctx.fillRect(r.x, r.y, 1, r.h);
  ctx.fillStyle = lo; ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1); ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
}
// frame with a near-black outline around it
function plaque(ctx, r, fill, hi, lo) {
  ctx.fillStyle = P.ink; ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
  frame(ctx, r, fill, hi, lo);
}

// warm parquet: 8 px plank rows, long planks with staggered joints, two close tones
function parquet(ctx, x, y, w, h) {
  const L = 48;
  ctx.fillStyle = P.floor2; ctx.fillRect(x, y, w, h);
  const y0 = Math.floor(y / 8) * 8;
  for (let ry = y0; ry < y + h; ry += 8) {
    const j = ry / 8;
    const off = (j * 20) % L;
    for (let jx = Math.floor(x / L) * L + off - L; jx < x + w; jx += L) {
      const a = Math.max(x, jx), b = Math.min(x + w, jx + L);
      const t = Math.max(y, ry), u = Math.min(y + h, ry + 8);
      if (b <= a || u <= t) continue;
      if (h2(jx, ry) % 5 < 2) { ctx.fillStyle = P.floor1; ctx.fillRect(a, t, b - a, u - t); }
      if (jx >= x) { ctx.fillStyle = P.floor3; ctx.fillRect(jx, t, 1, u - t); }
    }
    if (ry + 7 >= y && ry + 7 < y + h) { ctx.fillStyle = P.floor3; ctx.fillRect(x, ry + 7, w, 1); }
  }
}

// cool stone tile for the machine area
function stoneTile(ctx, x, y, w, h) {
  ctx.fillStyle = P.tile2; ctx.fillRect(x, y, w, h);
  for (let ty = Math.floor(y / 16) * 16; ty < y + h; ty += 16) for (let tx = Math.floor(x / 16) * 16; tx < x + w; tx += 16) {
    const a = Math.max(x, tx), b = Math.min(x + w, tx + 16), t = Math.max(y, ty), u = Math.min(y + h, ty + 16);
    if (b <= a || u <= t) continue;
    if (((tx + ty) >> 4) % 2) { ctx.fillStyle = P.tile1; ctx.fillRect(a, t, b - a, u - t); }
    ctx.fillStyle = P.tile3;
    if (tx >= x) ctx.fillRect(tx, t, 1, u - t);
    if (ty >= y) ctx.fillRect(a, ty, b - a, 1);
  }
}

function checker(ctx, x, y, w, h, c0, c1) {
  for (let cy = y; cy < y + h; cy += 8) for (let cx = x; cx < x + w; cx += 8) {
    ctx.fillStyle = ((cx + cy) >> 3) % 2 ? c0 : c1;
    ctx.fillRect(cx, cy, Math.min(8, x + w - cx), Math.min(8, y + h - cy));
  }
}

function hazard(ctx, x, y, w, h) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    ctx.fillStyle = ((x + i + y + j) >> 2) % 2 ? P.amber : P.steel1;
    ctx.fillRect(x + i, y + j, 1, 1);
  }
}

function carpet(ctx, x, y, w, h, base, speck, edge) {
  ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = speck;
  for (let cy = y; cy < y + h; cy++) for (let cx = x; cx < x + w; cx++) if (h2(cx, cy) % 47 === 0) ctx.fillRect(cx, cy, 2, 1);
  ctx.fillStyle = edge; ctx.fillRect(x, y, w, 1);
}

// vertical wall seen from above: near-black edges, navy core
function wallV(ctx, x, y, h) {
  ctx.fillStyle = P.ink; ctx.fillRect(x, y, M.SIDE_WALL, h);
  ctx.fillStyle = P.navy2; ctx.fillRect(x + 1, y, 1, h);
  ctx.fillStyle = P.navy1; ctx.fillRect(x + 2, y, 1, h);
}

function shadow(ctx, x, y, w) { ctx.fillStyle = SHADOW; ctx.fillRect(x, y, w, 1); }

export function paintBackdrop(ctx) {
  const FW = M.FRONT_WALL_Y;
  // ---- floors
  parquet(ctx, 0, M.FLOOR_Y, 480, FW - M.FLOOR_Y);
  const z = M.ZONE;
  stoneTile(ctx, z.x, z.y, z.w, M.DOCK_STRIP_Y - z.y);
  checker(ctx, z.x, M.DOCK_STRIP_Y, z.w, FW - M.DOCK_STRIP_Y, P.steel5, P.steel2);
  ctx.fillStyle = P.steel1; ctx.fillRect(z.x, M.DOCK_STRIP_Y, z.w, 1);
  hazard(ctx, z.x, z.y, 3, FW - z.y); hazard(ctx, z.x, z.y, z.w, 3);
  ctx.fillStyle = P.floor3; ctx.fillRect(z.x - 1, z.y - 1, z.w + 1, 1); ctx.fillRect(z.x - 1, z.y, 1, FW - z.y);

  // ---- back wall band: navy, lighter trim line, dark skirting
  ctx.fillStyle = P.navy2; ctx.fillRect(0, 0, 480, M.WALL_H);
  ctx.fillStyle = P.ink; ctx.fillRect(0, 0, 480, 2);
  ctx.fillStyle = P.navy3; ctx.fillRect(0, 25, 480, 2);
  ctx.fillStyle = P.navy1; ctx.fillRect(0, 27, 480, 4);
  ctx.fillStyle = P.ink; ctx.fillRect(0, 31, 480, 1);
  ctx.fillStyle = SHADOW; ctx.fillRect(M.OFFICES_W, 32, 480 - M.OFFICES_W, 2);

  // ---- offices: carpet, decor, name plate frames
  for (const o of M.offices) {
    const teal = o.i === 1;
    carpet(ctx, o.ix, 32, 60, 48, teal ? P.tealc2 : P.carpet2, teal ? P.tealc1 : P.carpet3, teal ? P.tealc1 : P.carpet1);
    ctx.fillStyle = SHADOW; ctx.fillRect(o.ix, 32, 60, 2);
    shadow(ctx, o.door.x, 83, o.door.w);        // contact shadow of the doorway counter
    plaque(ctx, o.plate, P.straw, P.yellow, P.wood4);
    ctx.drawImage(Props.decor(o.i), o.decor.x - 1, o.decor.y - 1);
    shadow(ctx, o.desk.x, o.desk.y + o.desk.h, o.desk.w);
  }
  for (let i = 0; i <= 3; i++) wallV(ctx, i * M.OFFICE_W, 0, M.OFFICE_BASE);
  ctx.fillStyle = P.ink; ctx.fillRect(0, 0, 480, 2);

  // ---- side walls of the room
  wallV(ctx, 0, 0, FW); wallV(ctx, 476, 0, FW);

  // ---- message board (cork)
  const br = M.board.rect, c = M.board.inner;
  plaque(ctx, br, P.wood3, P.wood5, P.wood2);
  ctx.fillStyle = P.wood4; ctx.fillRect(c.x, c.y, c.w, c.h);
  for (let j = 0; j < c.h; j++) for (let i = 0; i < c.w; i++) { const r = h2(c.x + i, c.y + j) % 17; if (r === 0) { ctx.fillStyle = P.wood3; ctx.fillRect(c.x + i, c.y + j, 1, 1); } else if (r === 1) { ctx.fillStyle = P.wood5; ctx.fillRect(c.x + i, c.y + j, 1, 1); } }
  ctx.fillStyle = P.wood2; ctx.fillRect(c.x, c.y, c.w, 1); ctx.fillRect(c.x, c.y, 1, c.h);

  // ---- clock face
  const k = M.clock;
  for (let dy = -k.r - 1; dy <= k.r + 1; dy++) for (let dx = -k.r - 1; dx <= k.r + 1; dx++) {
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= k.r + 1.3) { ctx.fillStyle = d > k.r + 0.3 ? P.ink : d > k.r - 1.2 ? (dx + dy < 0 ? P.brick3 : P.brick2) : P.paper; ctx.fillRect(k.cx + dx, k.cy + dy, 1, 1); }
  }
  ctx.fillStyle = P.steel3;
  for (const [dx, dy] of [[0, -5], [5, 0], [0, 5], [-5, 0]]) ctx.fillRect(k.cx + dx, k.cy + dy, 1, 1);

  // ---- WORKSHOP sign
  plaque(ctx, M.sign, P.wood2, P.wood4, P.wood1);
  drawText(ctx, 'WORKSHOP', M.sign.x + Math.floor(M.sign.w / 2), M.sign.y + 3, P.amber, { align: 'center', shadow: P.wood1 });
  ctx.fillStyle = P.straw; ctx.fillRect(M.sign.x + 2, M.sign.y + 2, 1, 1); ctx.fillRect(M.sign.x + M.sign.w - 3, M.sign.y + 2, 1, 1);

  // ---- pegboard with tools, and a wall shelf with paint cans
  const g = M.pegboard;
  const pg = { x: g.x, y: g.y, w: g.w, h: g.h };      // the same rect is the 'toolwall' click target and hover outline
  plaque(ctx, pg, P.paper2, P.paper, P.plaster);
  ctx.fillStyle = P.plaster;
  for (let py = pg.y + 2; py < pg.y + pg.h - 1; py += 3) for (let px = pg.x + 2; px < pg.x + pg.w - 1; px += 3) ctx.fillRect(px, py, 1, 1);
  ['hammer', 'saw', 'wrench', 'calipers', 'iron'].forEach((name, i) => {
    const rows = TOOL_MAPS[name];
    const p = new Pix(rows[0].length + 2, rows.length + 2);
    p.stamp(1, 1, rows, { s: P.steel3, S: P.steel2, d: P.steel1, k: P.steel1, w: P.wood3, W: P.wood2, y: P.orange, Y: P.amber, o: P.rust3, b: P.blue, r: P.red, l: P.sky, p: P.paper, n: P.white, c: P.wood2 });
    p.outline(P.shadow).paint(ctx, pg.x + 2 + i * 7, pg.y + 1 + (i % 2));
  });
  // ---- Harness Rack (next to the tool pegboard)
  const hr = M.harnessRack;
  plaque(ctx, hr, P.wood3, P.wood5, P.wood2);
  ctx.fillStyle = P.steel1; ctx.fillRect(hr.x + 2, hr.y + 3, hr.w - 4, 2);
  const slotCols = [[P.lime, P.green], [P.blue, P.sky], [P.orange, P.amber]];
  slotCols.forEach(([c0, c1], i) => {
    const cx = hr.x + 3 + i * 6;
    ctx.fillStyle = P.ink; ctx.fillRect(cx - 1, hr.y + 4, 6, 8);
    ctx.fillStyle = c0; ctx.fillRect(cx, hr.y + 5, 4, 6);
    ctx.fillStyle = c1; ctx.fillRect(cx, hr.y + 5, 4, 1);
    ctx.fillStyle = P.paper; ctx.fillRect(cx + 1, hr.y + 7, 2, 2);
  });

  // ---- status sign (text is dynamic): a small chalkboard
  const s = M.statusBoard;
  plaque(ctx, s, P.wood3, P.wood5, P.wood2);
  ctx.fillStyle = P.navy1; ctx.fillRect(s.x + 2, s.y + 2, s.w - 4, s.h - 4);
  ctx.fillStyle = P.shadow; ctx.fillRect(s.x + 2, s.y + 2, s.w - 4, 1);

  // ---- hanging plant
  ctx.drawImage(Props.hanging(), M.hangingPlant.x - 1, M.hangingPlant.y + 1);

  // ---- entrance door
  const e = M.entrance;
  ctx.fillStyle = P.ink; ctx.fillRect(e.x - 1, e.y - 1, e.w + 2, e.h + 1);
  ctx.fillStyle = P.wood2; ctx.fillRect(e.x, e.y, e.w, e.h);
  ctx.fillStyle = P.wood4; ctx.fillRect(e.x + 2, e.y + 2, e.w - 4, e.h - 2);
  ctx.fillStyle = P.wood5; ctx.fillRect(e.x + 2, e.y + 2, e.w - 4, 1); ctx.fillRect(e.x + 2, e.y + 2, 1, e.h - 2);
  ctx.fillStyle = P.wood3; ctx.fillRect(e.x + e.w - 3, e.y + 3, 1, e.h - 3);
  ctx.fillStyle = P.wood2; ctx.fillRect(DOOR_PANE.x - 1, DOOR_PANE.y - 1, DOOR_PANE.w + 2, DOOR_PANE.h + 2);
  frame(ctx, { x: e.x + 6, y: e.y + 17, w: 14, h: 10 }, P.wood4, P.wood3, P.wood5);
  ctx.fillStyle = P.straw; ctx.fillRect(e.x + e.w - 6, e.y + 15, 2, 3); ctx.fillStyle = P.yellow; ctx.fillRect(e.x + e.w - 6, e.y + 15, 1, 1);
  // door mat
  const m = M.props.mat;
  ctx.fillStyle = P.brick1; ctx.fillRect(m.x, m.y, m.w, m.h);
  ctx.fillStyle = P.brick2; ctx.fillRect(m.x + 1, m.y + 1, m.w - 2, m.h - 2);
  ctx.fillStyle = P.brick3; for (let i = 3; i < m.w - 3; i += 4) ctx.fillRect(m.x + i, m.y + 2, 2, m.h - 4);

  // ---- floor drain
  const d = M.props.drain;
  ctx.fillStyle = P.floor3; ctx.fillRect(d.x - 5, d.y - 5, 10, 10);
  ctx.fillStyle = P.steel2; ctx.fillRect(d.x - 4, d.y - 4, 8, 8);
  ctx.fillStyle = P.steel1; for (let i = -3; i < 4; i += 2) ctx.fillRect(d.x + i, d.y - 3, 1, 6);
  ctx.fillStyle = P.steel3; ctx.fillRect(d.x - 4, d.y - 4, 8, 1);

  // ---- dolly parking bay: painted on the floor around the dolly's home spot
  const bay = M.props.dollyBay;
  ctx.fillStyle = P.tile3; ctx.fillRect(bay.x + 1, bay.y + 1, bay.w - 2, bay.h - 2);
  for (let i = 0; i < bay.w; i++) {
    ctx.fillStyle = (i >> 1) % 2 ? P.amber : P.steel1;
    ctx.fillRect(bay.x + i, bay.y, 1, 1); ctx.fillRect(bay.x + i, bay.y + bay.h - 1, 1, 1);
  }
  for (let j = 0; j < bay.h; j++) {
    ctx.fillStyle = (j >> 1) % 2 ? P.amber : P.steel1;
    ctx.fillRect(bay.x, bay.y + j, 1, 1); ctx.fillRect(bay.x + bay.w - 1, bay.y + j, 1, 1);
  }
  // charging contact and a small bolt mark
  ctx.fillStyle = P.steel1; ctx.fillRect(bay.x + bay.w - 5, bay.y + 3, 3, 5);
  ctx.fillStyle = P.lime; ctx.fillRect(bay.x + bay.w - 4, bay.y + 4, 1, 1);
  ctx.fillStyle = P.amber;      // lightning bolt: the dolly charges here
  for (const [dx, dy, n] of [[5, 3, 1], [4, 4, 1], [3, 5, 3], [4, 6, 1], [3, 7, 1]]) ctx.fillRect(bay.x + dx, bay.y + dy, n, 1);

  // ---- contact shadows of the fixed furniture
  for (const b of M.benches) { shadow(ctx, b.rect.x, b.baseY + 1, b.rect.w); }
  for (const p of M.posts) shadow(ctx, p.rect.x, p.baseY + 1, p.rect.w);
  shadow(ctx, M.counter.rect.x, M.counter.baseY + 1, M.counter.rect.w);
  shadow(ctx, M.shelves.rect.x, M.shelves.baseY + 1, M.shelves.rect.w);
  shadow(ctx, M.machine.rect.x, M.machine.baseY + 1, M.machine.rect.w);
  shadow(ctx, M.press.rect.x, M.press.baseY + 1, M.press.rect.w);

  // ---- front wall with window frames and the dock door frame
  ctx.fillStyle = P.navy2; ctx.fillRect(0, FW, 480, 18);
  ctx.fillStyle = P.ink; ctx.fillRect(0, FW, 480, 1); ctx.fillRect(0, FW + 17, 480, 1);
  ctx.fillStyle = P.navy3; ctx.fillRect(0, FW + 1, 480, 2);
  ctx.fillStyle = P.navy1; ctx.fillRect(0, FW + 15, 480, 2);
  for (const w of M.frontWindows) {
    ctx.fillStyle = P.ink; ctx.fillRect(w.x - 3, w.y - 2, w.w + 6, w.h + 5);
    ctx.fillStyle = P.steel3; ctx.fillRect(w.x - 2, w.y - 1, w.w + 4, w.h + 2);
    ctx.fillStyle = P.steel4; ctx.fillRect(w.x - 2, w.y - 1, w.w + 4, 1);
    ctx.fillStyle = P.steel5; ctx.fillRect(w.x - 2, w.y + w.h + 1, w.w + 4, 1);
  }
  const dd = M.dock.door;
  ctx.fillStyle = P.tile1; ctx.fillRect(dd.x, dd.y, dd.w, dd.h);
  for (let x = dd.x; x < dd.x + dd.w; x += 16) { ctx.fillStyle = P.tile3; ctx.fillRect(x, dd.y, 1, dd.h); }
  hazard(ctx, dd.x, dd.y + dd.h - 3, dd.w, 3);
  ctx.fillStyle = P.ink; ctx.fillRect(dd.x - 4, dd.y, 4, dd.h); ctx.fillRect(dd.x + dd.w, dd.y, 4, dd.h);
  ctx.fillStyle = P.steel3; ctx.fillRect(dd.x - 3, dd.y, 2, dd.h); ctx.fillRect(dd.x + dd.w + 1, dd.y, 2, dd.h);
  ctx.fillStyle = P.steel4; ctx.fillRect(dd.x - 3, dd.y, 1, dd.h); ctx.fillRect(dd.x + dd.w + 1, dd.y, 1, dd.h);
  plaque(ctx, { x: 396, y: FW + 4, w: 30, h: 9 }, P.amber, P.yellow, P.orange);
  drawText(ctx, 'DOCK', 411, FW + 6, P.ink, { align: 'center' });

  // ---- street: curb, asphalt, lane marks, loading bay outline
  const SY = M.STREET_Y;
  ctx.fillStyle = P.steel4; ctx.fillRect(0, SY, 480, 1);
  ctx.fillStyle = P.steel3; ctx.fillRect(0, SY + 1, 480, 2);
  ctx.fillStyle = P.steel1; ctx.fillRect(0, SY + 3, 480, 1);
  for (let x = 0; x < 480; x += 16) { ctx.fillStyle = P.steel2; ctx.fillRect(x, SY, 1, 3); }
  ctx.fillStyle = P.asphalt; ctx.fillRect(0, SY + 4, 480, 272 - SY - 4);
  for (let y = SY + 4; y < 272; y++) for (let x = 0; x < 480; x++) { const r = h2(x, y) % 53; if (r === 0) { ctx.fillStyle = P.asphalt2; ctx.fillRect(x, y, 2, 1); } else if (r === 1) { ctx.fillStyle = P.shadow; ctx.fillRect(x, y, 1, 1); } }
  ctx.fillStyle = P.paper2; for (let x = 6; x < 480; x += 28) ctx.fillRect(x, 251, 14, 2);
  ctx.fillStyle = P.amber; ctx.fillRect(312, SY + 4, 112, 1); ctx.fillRect(312, SY + 4, 1, 6); ctx.fillRect(423, SY + 4, 1, 6);
  ctx.fillStyle = P.shadow; ctx.fillRect(0, 270, 480, 2);
}

export { frame, plaque };
